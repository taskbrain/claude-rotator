import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { MacOSStore, MemoryStore } from './adapters.js';
import { fail, json, loadConfig, object, safeError } from './safety.js';

export const STAGES = Object.freeze(['import-read', 'import-vault', 'import-commit',
  'backup-outgoing', 'compare-lane', 'write-lane', 'verify-lane', 'write-metadata',
  'watch-lane', 'quarantine', 'review-ledger', 'commit-ledger', 'finish']);

function expiry(raw, now, margin) {
  const parsed = json(raw);
  const data = parsed?.claudeAiOauth ?? parsed;
  if (!object(data) || typeof data.accessToken !== 'string' || !data.accessToken
    || typeof data.refreshToken !== 'string' || !data.refreshToken
    || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now + margin) fail('EXPIRY_UNSAFE');
}

function oauth(raw) {
  const data = json(raw);
  if (!object(data) || !object(data.oauthAccount)) fail('OPERATION_FAILED');
  return data;
}

function vault(raw) {
  const data = json(raw);
  if (!object(data) || typeof data.credential !== 'string' || !object(data.oauthAccount)) fail('OPERATION_FAILED');
  return data;
}

async function attributes(store, service) {
  const result = await store.attributes(service);
  if (!object(result) || typeof result.exists !== 'boolean'
    || (result.exists ? typeof result.updatedAt !== 'string' || !/^[0-9TZ:.+-]{1,32}$/.test(result.updatedAt) : result.updatedAt !== null)) fail('OPERATION_FAILED');
  return { exists: result.exists, updatedAt: result.updatedAt };
}

async function stableRead(store, service, allowChange = false) {
  const before = await attributes(store, service);
  if (!before.exists) {
    if (allowChange) return { value: null, updatedAt: null, changed: true };
    fail('MISSING_ITEM');
  }
  let value;
  try { value = await store.read(service); } catch (error) {
    if (allowChange && safeError(error).code === 'MISSING_ITEM') return { value: null, updatedAt: null, changed: true };
    throw error;
  }
  const after = await attributes(store, service);
  if (typeof value !== 'string' || value.length > 1024 * 1024) fail('OPERATION_FAILED');
  const changed = before.updatedAt !== after.updatedAt || !after.exists;
  if (changed && !allowChange) fail('LANE_CONFLICT');
  return { value, updatedAt: after.updatedAt, changed };
}

function emptyLedger(config) {
  return { version: 1, laneService: config.lane.service, laneAccount: config.initialAccount,
    updatedAt: null, reviewRequired: false, accounts: {}, quarantines: [] };
}

async function readLedger(config) {
  const raw = await config.files.readText(config.ledgerPath, { optional: true, privateFile: true });
  if (raw === null) return null;
  const data = json(raw);
  if (!object(data) || data.version !== 1 || data.laneService !== config.lane.service
    || !Object.hasOwn(config.accounts, data.laneAccount) || typeof data.reviewRequired !== 'boolean'
    || typeof data.updatedAt !== 'string' || !/^[0-9TZ:.+-]{1,32}$/.test(data.updatedAt)
    || !object(data.accounts) || !Array.isArray(data.quarantines)) fail('HUMAN_REVIEW');
  const result = { version: 1, laneService: data.laneService, laneAccount: data.laneAccount,
    updatedAt: data.updatedAt, reviewRequired: data.reviewRequired, accounts: {}, quarantines: [] };
  for (const [label, entry] of Object.entries(data.accounts)) {
    const account = config.accounts[label];
    if (!Object.hasOwn(config.accounts, label) || !account || !object(entry) || !['lane', `vault:${account.vaultService}`].includes(entry.owner)
      || !Number.isSafeInteger(entry.generation) || entry.generation < 1 || entry.sourceConsumed !== true
      || entry.sourceOwner !== 'source-consumed' || typeof entry.needsReview !== 'boolean'
      || entry.sourceService !== account.sourceService || entry.vaultService !== account.vaultService) fail('HUMAN_REVIEW');
    result.accounts[label] = { owner: entry.owner, generation: entry.generation,
      sourceConsumed: true, sourceOwner: 'source-consumed', needsReview: entry.needsReview,
      sourceService: account.sourceService, vaultService: account.vaultService };
  }
  if (result.accounts[result.laneAccount]?.owner !== 'lane'
    || Object.values(result.accounts).filter(entry => entry.owner === 'lane').length !== 1) fail('HUMAN_REVIEW');
  for (const entry of data.quarantines) {
    if (!object(entry) || !/^caseG-T1-vault-quarantine-\d{16}$/.test(entry.service)
      || !Number.isSafeInteger(entry.at)) fail('HUMAN_REVIEW');
    result.quarantines.push({ service: entry.service, at: entry.at });
  }
  return result;
}

async function pending(config) {
  const raw = await config.files.readText(config.journalPath, { optional: true, privateFile: true });
  if (raw !== null) {
    const entry = json(raw);
    if (!object(entry) || entry.complete !== true || entry.laneService !== config.lane.service) fail('HUMAN_REVIEW');
  }
}

async function lock(config, now) {
  const { fileInfo, open, readText, unlink } = config.files;
  await fileInfo(config.lockPath, { optional: true });
  let handle;
  try {
    handle = await open(config.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') fail('LOCKED');
    throw error;
  }
  const content = JSON.stringify({ pid: process.pid, startedAt: now(), nonce: randomUUID() });
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  // Stale locks are never stolen. An operator must inspect both lock and journal.
  return async () => {
    if (await readText(config.lockPath) !== content) fail('HUMAN_REVIEW');
    await unlink(config.lockPath);
  };
}

export async function runOperation({ configPath, env = process.env, command, label, apply = false,
  storeFactory, now = Date.now, sleep = setTimeout, fs, testTiming } = {}) {
  try {
    if (testTiming !== undefined && typeof storeFactory !== 'function') fail('INVALID_CONFIG');
    const config = await loadConfig(configPath, env, { fs });
    const timing = { marginMs: config.marginMs, watchMs: config.watchMs, pollMs: config.pollMs, ...testTiming };
    if (![timing.marginMs, timing.watchMs, timing.pollMs].every(value => Number.isSafeInteger(value) && value > 0)
      || timing.pollMs > timing.watchMs || timing.watchMs >= timing.marginMs) fail('INVALID_CONFIG');
    const { readText, fileInfo, atomicWrite } = config.files;
    if (!['status', 'import', 'switch'].includes(command)
      || (command !== 'status' && !Object.hasOwn(config.accounts, label))) fail('INVALID_COMMAND');
    await pending(config);
    let ledger = await readLedger(config);
    if (ledger?.reviewRequired || Object.values(ledger?.accounts || {}).some(entry => entry.needsReview)) fail('HUMAN_REVIEW');
    if (command !== 'status' && !apply) {
      return { status: 'planned', dryRun: true, command, label, steps: command === 'import'
        ? ['read-source-once', 'save-vault', 'consume-source']
        : ['backup', 'compare', 'replace-lane', 'replace-display', 'observe', 'commit'] };
    }
    const store = storeFactory ? storeFactory(config) : new MacOSStore(config);
    if (testTiming !== undefined && !(store instanceof MemoryStore)) fail('INVALID_CONFIG');
    if (command === 'status') {
      if (await fileInfo(config.lockPath, { optional: true })) fail('LOCKED');
      const items = [];
      for (const service of [config.lane.service, ...Object.values(config.accounts).flatMap(account => [account.sourceService, account.vaultService]),
        ...(ledger?.quarantines || []).map(entry => entry.service)]) {
        items.push({ service, ...await attributes(store, service) });
      }
      await pending(config);
      if (await fileInfo(config.lockPath, { optional: true })) fail('LOCKED');
      if (!isDeepStrictEqual(ledger, await readLedger(config))) fail('LANE_CONFLICT');
      const laneTimestampMismatch = ledger !== null && (!items[0].exists || items[0].updatedAt !== ledger.updatedAt);
      return { status: 'status', ledger, items, laneTimestampMismatch };
    }
    const release = await lock(config, now);
    try {
      await pending(config);
      ledger = await readLedger(config);
      if (ledger?.reviewRequired) fail('HUMAN_REVIEW');
      const operationId = randomUUID();
      const journal = async (stage, complete = false) => {
        await atomicWrite(config.journalPath, JSON.stringify({ operationId, command, label,
          laneService: config.lane.service, stage, complete, at: now() }));
      };
      const log = async event => {
        const previous = await readText(config.logPath, { optional: true, privateFile: true }) || '';
        await atomicWrite(config.logPath, previous + JSON.stringify({ event, at: now(), label }) + '\n');
      };
      const saveLedger = () => atomicWrite(config.ledgerPath, JSON.stringify(ledger));
      const finish = async () => { await journal('finish'); await log('completed'); await journal('finish', true); };
      const quarantine = async (errorCode, labels, detected) => {
        if (detected === undefined) detected = await stableRead(store, config.lane.service, true);
        await journal('quarantine');
        const preserved = new Set();
        const preserve = async snapshot => {
          if (snapshot.value === null || preserved.has(snapshot.value)) return;
          if (typeof snapshot.value !== 'string' || snapshot.value.length > 1024 * 1024) fail('OPERATION_FAILED');
          let service;
          for (let suffix = 0; suffix < 1000; suffix++) {
            service = `caseG-T1-vault-quarantine-${String(now()).padStart(13, '0')}${String(suffix).padStart(3, '0')}`;
            if (!(await attributes(store, service)).exists) break;
            if (suffix === 999) fail('VAULT_OCCUPIED');
          }
          await store.write(service, snapshot.value);
          if (await store.read(service) !== snapshot.value) fail('VERIFY_FAILED');
          ledger.quarantines.push({ service, at: now() });
          preserved.add(snapshot.value);
        };
        await preserve(detected);
        await preserve(await stableRead(store, config.lane.service, true));
        ledger.reviewRequired = true;
        for (const account of labels) if (ledger.accounts[account]) ledger.accounts[account].needsReview = true;
        await journal('review-ledger'); await saveLedger(); await log('review-required');
        fail(errorCode);
      };
      const checkExpectedLane = async () => {
        const current = await attributes(store, config.lane.service);
        if (!current.exists || current.updatedAt !== ledger.updatedAt) {
          await quarantine('LANE_CHANGED', Object.keys(ledger.accounts));
        }
      };
      const account = config.accounts[label];
      if (command === 'import') {
        if (ledger?.accounts[label]?.sourceConsumed) fail('SOURCE_CONSUMED');
        if (!ledger && label !== config.initialAccount) fail('INITIAL_IMPORT_REQUIRED');
        if (ledger) await checkExpectedLane();
        if ((await attributes(store, account.vaultService)).exists) fail('VAULT_OCCUPIED');
        await journal('import-read');
        const source = await stableRead(store, account.sourceService);
        const sourceMetadata = oauth(await readText(join(account.sourceDir, '.claude.json')));
        expiry(source.value, now(), timing.marginMs);
        let initialLane;
        let initialMetadataRaw;
        if (!ledger) {
          initialLane = await stableRead(store, config.lane.service);
          initialMetadataRaw = await readText(join(config.lane.dir, '.claude.json'));
          const laneMetadata = oauth(initialMetadataRaw);
          if (initialLane.value !== source.value || !isDeepStrictEqual(laneMetadata.oauthAccount, sourceMetadata.oauthAccount)) fail('INITIAL_MISMATCH');
          ledger = emptyLedger(config); ledger.updatedAt = initialLane.updatedAt;
        }
        await journal('import-vault');
        const payload = JSON.stringify({ credential: source.value, oauthAccount: sourceMetadata.oauthAccount });
        await store.write(account.vaultService, payload);
        if (await store.read(account.vaultService) !== payload) fail('VERIFY_FAILED');
        const sourceAfter = await stableRead(store, account.sourceService);
        if (sourceAfter.value !== source.value || sourceAfter.updatedAt !== source.updatedAt
          || !isDeepStrictEqual(oauth(await readText(join(account.sourceDir, '.claude.json'))).oauthAccount, sourceMetadata.oauthAccount)) fail('LANE_CONFLICT');
        if (initialLane) {
          const laneAfter = await stableRead(store, config.lane.service);
          if (laneAfter.value !== initialLane.value || laneAfter.updatedAt !== initialLane.updatedAt) fail('LANE_CONFLICT');
          if (await readText(join(config.lane.dir, '.claude.json')) !== initialMetadataRaw) fail('METADATA_CONFLICT');
        } else await checkExpectedLane();
        ledger.accounts[label] = { owner: label === ledger.laneAccount ? 'lane' : `vault:${account.vaultService}`,
          generation: 1, sourceConsumed: true, sourceOwner: 'source-consumed', needsReview: false,
          sourceService: account.sourceService, vaultService: account.vaultService };
        await journal('import-commit'); await saveLedger(); await finish();
        return { status: 'imported', label, sourceConsumed: true };
      }
      if (!ledger || !ledger.accounts[label] || ledger.accounts[label].owner !== `vault:${account.vaultService}`) fail('INITIAL_IMPORT_REQUIRED');
      const outgoingLabel = ledger.laneAccount;
      const outgoing = config.accounts[outgoingLabel];
      const lane = await stableRead(store, config.lane.service, true);
      const outgoingSnapshot = vault((await stableRead(store, outgoing.vaultService)).value);
      if (lane.changed || lane.value !== outgoingSnapshot.credential) await quarantine('R8_SUSPECTED', Object.keys(ledger.accounts), lane);
      if (lane.updatedAt !== ledger.updatedAt) await quarantine('LANE_CHANGED', [outgoingLabel], lane);
      const incoming = await stableRead(store, account.vaultService);
      const saved = vault(incoming.value);
      const metadataPath = join(config.lane.dir, '.claude.json');
      const metadataRaw = await readText(metadataPath);
      const metadata = oauth(metadataRaw);
      if (!isDeepStrictEqual(metadata.oauthAccount, outgoingSnapshot.oauthAccount)) fail('METADATA_CONFLICT');
      expiry(lane.value, now(), timing.marginMs); expiry(saved.credential, now(), timing.marginMs);
      await journal('backup-outgoing');
      const backup = JSON.stringify({ credential: lane.value, oauthAccount: metadata.oauthAccount });
      await store.write(outgoing.vaultService, backup);
      if (await store.read(outgoing.vaultService) !== backup) fail('VERIFY_FAILED');
      await journal('compare-lane');
      const compared = await stableRead(store, config.lane.service);
      if (compared.value !== lane.value || compared.updatedAt !== lane.updatedAt) fail('LANE_CONFLICT');
      if (await readText(metadataPath) !== metadataRaw) fail('METADATA_CONFLICT');
      const incomingAfter = await stableRead(store, account.vaultService);
      if (incomingAfter.value !== incoming.value || incomingAfter.updatedAt !== incoming.updatedAt) fail('LANE_CONFLICT');
      expiry(lane.value, now(), timing.marginMs); expiry(saved.credential, now(), timing.marginMs);
      await journal('write-lane');
      // This is a best-effort comparison. The external writer does not share our lock.
      const finalCompare = await stableRead(store, config.lane.service);
      if (finalCompare.value !== lane.value || finalCompare.updatedAt !== lane.updatedAt) fail('LANE_CONFLICT');
      const receipt = await store.write(config.lane.service, saved.credential, { expectedUpdatedAt: finalCompare.updatedAt });
      await journal('verify-lane');
      const written = await stableRead(store, config.lane.service, true);
      if (!object(receipt) || typeof receipt.written !== 'boolean') fail('OPERATION_FAILED');
      if (!receipt.written || receipt.beforeUpdatedAt !== finalCompare.updatedAt || receipt.updatedAt !== written.updatedAt
        || written.changed || written.value !== saved.credential) await quarantine('R8_SUSPECTED', [outgoingLabel, label], written);
      await log('display-transition-started');
      await journal('write-metadata');
      metadata.oauthAccount = saved.oauthAccount;
      const replacement = JSON.stringify(metadata, null, 2) + '\n';
      await atomicWrite(metadataPath, replacement, { expected: metadataRaw });
      if (await readText(metadataPath) !== replacement) fail('METADATA_CONFLICT');
      await log('display-transition-finished');
      await journal('watch-lane');
      // Poll a fixed number of intervals: injected clocks cannot accidentally disable observation.
      for (let remaining = timing.watchMs; remaining > 0;) {
        const interval = Math.min(remaining, timing.pollMs);
        await sleep(interval); remaining -= interval;
        const observed = await attributes(store, config.lane.service);
        if (!observed.exists || observed.updatedAt !== written.updatedAt) {
          const detected = await stableRead(store, config.lane.service, true);
          await quarantine('R8_SUSPECTED', [outgoingLabel, label], detected);
        }
      }
      await journal('commit-ledger');
      const final = await stableRead(store, config.lane.service, true);
      if (final.changed || final.value !== saved.credential || final.updatedAt !== written.updatedAt) await quarantine('R8_SUSPECTED', [outgoingLabel, label], final);
      if (await readText(metadataPath) !== replacement) fail('METADATA_CONFLICT');
      ledger.accounts[outgoingLabel].owner = `vault:${outgoing.vaultService}`;
      ledger.accounts[outgoingLabel].generation++;
      ledger.accounts[label].owner = 'lane'; ledger.accounts[label].generation++;
      ledger.laneAccount = label; ledger.updatedAt = final.updatedAt;
      await saveLedger(); await finish();
      return { status: 'switched', label, verified: true, observed: true };
    } finally { await release(); }
  } catch (error) { throw safeError(error); }
}
