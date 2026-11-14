import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, symlink, realpath, rm } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { resolve, normalize, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { claudeKeychainServiceName } from '../../../src/claude-keychain.js';

const api = await import('../helper.js');
const adapters = await import('../adapters.js');
const cli = await import('../cli.js');
const safety = await import('../safety.js');

test('prototype exposes the guarded operation interface', () => {
  assert.equal(typeof api.runOperation, 'function');
});

async function setup(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'lane-trial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const lane = join(root, 'lane');
  const state = join(root, 'state');
  const alpha = join(root, 'alpha');
  const beta = join(root, 'beta');
  for (const dir of [home, lane, state, alpha, beta]) await mkdir(dir, { mode: 0o700 });
  const now = 2_000_000_000_000;
  // Credentials are constructed in memory; only display metadata goes to disk.
  const marker = ['sk-ant-oat01', 'SENTINEL', randomUUID()].join('-');
  const credential = (label, expiresAt = now + 7_200_000) => JSON.stringify({
    claudeAiOauth: { accessToken: `${marker}-${label}`, refreshToken: `${marker}-refresh-${label}`, expiresAt },
  });
  const values = { alpha: credential('alpha'), beta: credential('beta') };
  const metadata = label => ({ oauthAccount: { displayName: label }, keep: { nested: true } });
  for (const [dir, label] of [[lane, 'alpha'], [alpha, 'alpha'], [beta, 'beta']]) {
    await writeFile(join(dir, '.claude.json'), JSON.stringify(metadata(label)), { mode: 0o600 });
  }
  const config = {
    lane: { dir: lane, service: claudeKeychainServiceName(lane) },
    accounts: Object.fromEntries([['alpha', alpha], ['beta', beta]].map(([label, dir]) => [label, {
      sourceDir: dir, sourceService: claudeKeychainServiceName(dir), vaultService: `caseG-T1-vault-${label}`,
    }])),
    initialAccount: 'alpha', acct: 'trial-user', trialDir: state,
    ledgerPath: join(state, 'ledger.json'), logPath: join(state, 'events.jsonl'),
  };
  const configPath = join(root, 'trial.json');
  const env = { CASEG_PROTO_ENABLE: '1', HOME: home, USER: 'trial-user' };
  const store = new adapters.MemoryStore();
  store.seed(config.lane.service, values.alpha);
  store.seed(config.accounts.alpha.sourceService, values.alpha);
  store.seed(config.accounts.beta.sourceService, values.beta);
  let clock = now;
  const save = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  const run = (command, label, extra = {}) => api.runOperation({
    configPath, env, command, label, apply: true, storeFactory: () => store,
    now: () => clock, sleep: async ms => { clock += ms; }, testTiming: { watchMs: 20, pollMs: 5 }, ...extra,
  });
  const prepare = async () => { await run('import', 'alpha'); await run('import', 'beta'); };
  const ledger = async () => JSON.parse(await readFile(config.ledgerPath, 'utf8'));
  const laneValue = () => store.entries.get(config.lane.service).value;
  const latest = new Map(Object.entries(values));
  const latestRetained = label => [...store.entries].some(([service, item]) => {
    if (service === config.lane.service || service.startsWith('caseG-T1-vault-quarantine-')) return item.value === latest.get(label);
    if (!Object.values(config.accounts).some(account => account.vaultService === service)) return false;
    try { return JSON.parse(item.value).credential === latest.get(label); } catch { return false; }
  });
  const assertLatestPreserved = (labels = ['alpha', 'beta']) => {
    for (const label of labels) assert.equal(latestRetained(label), true, `latest value retained for ${label}`);
  };
  const disk = async () => {
    const result = [];
    for (const dir of [state, lane]) {
      for (const file of await readdir(dir)) result.push(await readFile(join(dir, file), 'utf8'));
    }
    return result.join('\n');
  };
  return { root, home, lane, state, config, configPath, env, store, values, marker, credential,
    run, save, prepare, ledger, laneValue, disk, now, metadata, latest, latestRetained, assertLatestPreserved };
}

for (const [field, below, boundary] of [['marginMs', 1_799_999, 1_800_000], ['watchMs', 59_999, 60_000], ['pollMs', 999, 1000]]) {
  test(`CLI refuses ${field} below the fixed safety minimum before storage access`, async t => {
    const s = await setup(t); const output = [];
    s.config[field] = below; await s.save();
    const result = await cli.main(['import', '--account', 'alpha', '--config', s.configPath], {
      env: s.env, stdout: value => output.push(value), stderr: value => output.push(value),
    });
    assert.equal(result, 1);
    assert.equal(output.some(line => JSON.parse(line).code === 'INVALID_CONFIG'), true);
    assert.equal(s.store.calls.length, 0);
    assert.deepEqual(await readdir(s.state), []);
    s.config[field] = boundary; await s.save();
    assert.equal((await s.run('import', 'alpha', { apply: false })).dryRun, true);
  });
}

test('short timing injection cannot be selected with CLI flags or the real-store library path', async t => {
  const s = await setup(t);
  assert.equal(await cli.main(['status', '--test-timing', '1', '--config', s.configPath], {
    env: s.env, stdout: () => {}, stderr: () => {},
  }), 1);
  await assert.rejects(s.run('status', undefined, { storeFactory: undefined }), { code: 'INVALID_CONFIG' });
});

test('disabled operation and missing explicit config refuse without storage access or writes', async t => {
  const s = await setup(t);
  for (const extra of [{ env: { ...s.env, CASEG_PROTO_ENABLE: '' } }, { configPath: undefined }]) {
    const result = await cli.main(['import', '--account', 'alpha', '--apply', '--config', s.configPath], {
      ...extra, env: extra.env || s.env, run: options => s.run(options.command, options.label, { ...options, ...extra }),
      stdout: () => {}, stderr: () => {},
    });
    assert.equal(result, 1);
  }
  assert.equal(s.store.calls.length, 0);
  assert.deepEqual(await readdir(s.state), []);
});

test('dry run returns only a value-free plan and never creates state or reads credentials', async t => {
  const s = await setup(t);
  const result = await s.run('import', 'alpha', { apply: false });
  assert.equal(result.dryRun, true);
  assert.equal(JSON.stringify(result).includes(s.marker), false);
  assert.deepEqual(await readdir(s.state), []);
  assert.equal(s.store.calls.some(call => call.operation !== 'attributes'), false);
});

const invalidCases = {
  'production service': s => { s.config.lane.service = 'Claude Code-credentials'; },
  'wrong hashed service': s => { s.config.accounts.beta.sourceService = 'Claude Code-credentials-00000000'; },
  'wrong vault service': s => { s.config.accounts.beta.vaultService = 'Claude Code-credentials'; },
  'duplicate source': s => { s.config.accounts.beta = { ...s.config.accounts.alpha, vaultService: 'caseG-T1-vault-beta' }; },
  'missing USER': s => { delete s.env.USER; },
  'mismatched USER': s => { s.env.USER = 'different-user'; },
  'protected config subtree': async s => {
    const dir = join(s.home, '.claude'); await mkdir(dir);
    s.config.lane = { dir, service: claudeKeychainServiceName(dir) };
  },
  'protected state subtree': s => { s.config.trialDir = join(s.home, '.config', 'claude-rotator'); },
  'home metadata alias': async s => { await symlink(join(s.home, '.claude.json'), join(s.lane, 'alias')); s.config.ledgerPath = join(s.lane, 'alias'); },
  'symlink directory': async s => {
    const alias = join(s.root, 'alias'); await symlink(s.lane, alias);
    s.config.lane = { dir: alias, service: claudeKeychainServiceName(alias) };
  },
  'symlink lane metadata': async s => {
    await rm(join(s.lane, '.claude.json')); await symlink(join(s.home, '.claude.json'), join(s.lane, '.claude.json'));
  },
  'home as lane': s => { s.config.lane = { dir: s.home, service: claudeKeychainServiceName(s.home) }; },
  'relative directory': s => { s.config.lane.dir = 'relative'; },
  'state file collision': s => { s.config.logPath = s.config.ledgerPath; },
  'unsafe account label': s => { s.config.accounts['quarantine-1'] = s.config.accounts.beta; },
  'invalid margin': s => { s.config.marginMs = 0; },
  'invalid observation interval': s => { s.config.pollMs = 0; },
};
for (const [name, change] of Object.entries(invalidCases)) {
  test(`validation refuses ${name} before storage access or writes`, async t => {
    const s = await setup(t);
    await change(s); await s.save();
    await assert.rejects(s.run('import', 'alpha'));
    assert.equal(s.store.calls.length, 0);
    assert.deepEqual(await readdir(s.state), []);
  });
}

test('five round trips preserve credentials, logical ownership, generations, and unrelated metadata', async t => {
  const s = await setup(t); await s.prepare();
  for (let i = 0; i < 5; i++) {
    for (const label of ['beta', 'alpha']) {
      const result = await s.run('switch', label);
      assert.equal(result.status, 'switched');
      assert.equal(s.laneValue() === s.values[label], true);
      const ledger = await s.ledger();
      assert.equal(ledger.laneAccount, label);
      for (const account of ['alpha', 'beta']) {
        assert.equal(ledger.accounts[account].owner, account === label ? 'lane' : `vault:${s.config.accounts[account].vaultService}`);
        assert.equal(ledger.accounts[account].sourceConsumed, true);
      }
      const metadata = JSON.parse(await readFile(join(s.lane, '.claude.json'), 'utf8'));
      assert.deepEqual(metadata, s.metadata(label));
      s.assertLatestPreserved();
    }
  }
  assert.equal((await s.ledger()).accounts.alpha.generation, 11);
  assert.equal((await s.ledger()).accounts.beta.generation, 11);
  for (const file of await readdir(s.state)) assert.equal((await lstat(join(s.state, file))).mode & 0o777, 0o600);
  assert.equal((await s.disk()).includes(s.marker), false);
});

test('consumed sources are never read again, including by status and repeated import', async t => {
  const s = await setup(t); await s.prepare(); s.store.calls.length = 0;
  await assert.rejects(s.run('import', 'beta'));
  await s.run('status'); await s.run('switch', 'beta');
  assert.equal(s.store.calls.some(call => call.operation === 'read' && Object.values(s.config.accounts).some(a => a.sourceService === call.service)), false);
});

test('status exposes only ledger and existence/update metadata', async t => {
  const s = await setup(t); await s.prepare(); s.store.calls.length = 0;
  const result = await s.run('status');
  assert.equal(result.status, 'status');
  assert.equal(s.store.calls.every(call => call.operation === 'attributes'), true);
  assert.equal(JSON.stringify(result).includes('displayName'), false);
});

test('lane change during outgoing backup aborts before lane overwrite', async t => {
  const s = await setup(t); await s.prepare();
  const changed = s.credential('external');
  s.store.before = (operation, service) => {
    if (operation === 'write' && service === s.config.accounts.alpha.vaultService) {
      s.latest.set('alpha', changed); s.store.seed(s.config.lane.service, changed);
    }
  };
  await assert.rejects(s.run('switch', 'beta'), { code: 'LANE_CONFLICT' });
  assert.equal(s.laneValue() === changed, true);
  assert.equal((await s.ledger()).laneAccount, 'alpha');
  await assert.rejects(s.run('status'), { code: 'HUMAN_REVIEW' });
  s.assertLatestPreserved();
});

for (const oldSnapshot of [false, true]) {
  test(`watch quarantines ${oldSnapshot ? 'old snapshot' : 'outgoing refreshed generation'} without rollback`, async t => {
    const s = await setup(t); await s.prepare();
    const changed = oldSnapshot ? s.values.alpha : s.credential('alpha-next');
    let triggered = false;
    await assert.rejects(s.run('switch', 'beta', { sleep: async () => {
      if (!triggered) { triggered = true; s.latest.set('alpha', changed); s.store.seed(s.config.lane.service, changed); }
    } }), { code: 'R8_SUSPECTED' });
    assert.equal(s.laneValue() === changed, true);
    const quarantine = [...s.store.entries].filter(([key]) => key.startsWith('caseG-T1-vault-quarantine-'));
    assert.equal(quarantine.length, 1);
    assert.equal(quarantine[0][1].value === changed, true);
    const ledger = await s.ledger();
    assert.equal(ledger.reviewRequired, true);
    assert.equal(ledger.accounts.alpha.needsReview, true);
    assert.equal(ledger.accounts.beta.needsReview, true);
    await assert.rejects(s.run('switch', 'alpha'), { code: 'HUMAN_REVIEW' });
    assert.equal((await s.disk()).includes(s.marker), false);
    s.assertLatestPreserved();
  });
}

test('post-watch unexpected attribute change refuses the next switch', async t => {
  const s = await setup(t); await s.prepare(); await s.run('switch', 'beta');
  const changed = s.credential('delayed');
  s.latest.set('beta', changed); s.store.seed(s.config.lane.service, changed);
  await assert.rejects(s.run('switch', 'alpha'), { code: 'R8_SUSPECTED' });
  assert.equal((await s.ledger()).reviewRequired, true);
  s.assertLatestPreserved();
});

for (const expiresAt of [null, 2_000_000_000_000 + 1000]) {
  for (const target of ['lane', 'incoming']) {
    test(`refuses ${target} with ${expiresAt === null ? 'missing' : 'near'} expiry before any write`, async t => {
      const s = await setup(t); await s.prepare();
      const raw = s.credential('expiry', expiresAt);
      if (target === 'lane') {
        s.store.entries.get(s.config.lane.service).value = raw;
        s.store.entries.get(s.config.accounts.alpha.vaultService).value = JSON.stringify({ credential: raw, oauthAccount: { displayName: 'alpha' } });
      }
      else s.store.entries.get(s.config.accounts.beta.vaultService).value = JSON.stringify({ credential: raw, oauthAccount: { displayName: 'beta' } });
      s.store.calls.length = 0;
      await assert.rejects(s.run('switch', 'beta'), { code: 'EXPIRY_UNSAFE' });
      assert.equal(s.store.calls.some(call => call.operation === 'write'), false);
    });
  }
}

test('active and stale locks both require manual clearance', async t => {
  const s = await setup(t); await s.prepare();
  for (const pid of [process.pid, 99999999]) {
    await writeFile(join(s.lane, '.caseg-t1.lock'), JSON.stringify({ pid, startedAt: 1 }));
    await assert.rejects(s.run('switch', 'beta'), { code: 'LOCKED' });
    await rm(join(s.lane, '.caseg-t1.lock'));
    s.assertLatestPreserved();
  }
});

test('metadata mutation while saving credentials is preserved and stops the switch', async t => {
  const s = await setup(t); await s.prepare();
  const changed = JSON.stringify({ oauthAccount: { displayName: 'changed' }, keep: { nested: false } });
  s.store.before = async (operation, service) => {
    if (operation === 'write' && service === s.config.lane.service) await writeFile(join(s.lane, '.claude.json'), changed);
  };
  await assert.rejects(s.run('switch', 'beta'), { code: 'METADATA_CONFLICT' });
  assert.equal(await readFile(join(s.lane, '.claude.json'), 'utf8'), changed);
  await assert.rejects(s.run('switch', 'alpha'), { code: 'HUMAN_REVIEW' });
  s.assertLatestPreserved();
});

test('real adapter throws in the test context before any invocation', () => {
  assert.throws(() => new adapters.MacOSStore({}), { code: 'TEST_CONTEXT' });
});

test('CLI catches arbitrary adapter errors without exposing credentials in either stream', async t => {
  const s = await setup(t); await s.prepare();
  const output = [];
  s.store.before = () => { throw new Error(s.marker); };
  const code = await cli.main(['switch', '--to', 'beta', '--apply', '--config', s.configPath], {
    env: s.env, run: options => s.run(options.command, options.label, options),
    stdout: value => output.push(value), stderr: value => output.push(value),
  });
  assert.equal(code, 1);
  assert.equal(output.join('').includes(s.marker), false);
  assert.equal((await s.disk()).includes(s.marker), false);
  s.assertLatestPreserved();
});

test('initial account may consume the existing lane as its source', async t => {
  const s = await setup(t);
  s.config.accounts.alpha.sourceDir = s.lane;
  s.config.accounts.alpha.sourceService = s.config.lane.service;
  await s.save(); await s.prepare();
  await s.run('switch', 'beta'); await s.run('switch', 'alpha');
  assert.equal(s.laneValue() === s.values.alpha, true);
});

test('attribute change during the final confirmation still quarantines the observed value', async t => {
  const s = await setup(t); await s.prepare();
  const changed = s.credential('racing-generation');
  let armed = false;
  s.store.before = (operation, service) => {
    if (armed && operation === 'read' && service === s.config.lane.service) {
      armed = false; s.latest.set('alpha', changed); s.store.seed(service, changed);
    }
  };
  await assert.rejects(s.run('switch', 'beta', { sleep: async () => { armed = true; } }), { code: 'R8_SUSPECTED' });
  assert.equal([...s.store.entries].some(([key, item]) => key.startsWith('caseG-T1-vault-quarantine-') && item.value === changed), true);
  assert.equal(s.laneValue() === changed, true);
  s.assertLatestPreserved();
});

test('interactive write request keeps both plaintext and encoded credentials out of argv', async t => {
  const s = await setup(t);
  const request = adapters.writeRequest(s.config.lane.service, s.config.acct, s.values.alpha);
  assert.deepEqual(request.args, ['-i']);
  assert.equal(JSON.stringify(request.args).includes(s.marker), false);
  assert.equal(JSON.stringify(request.args).includes(Buffer.from(s.values.alpha).toString('hex')), false);
  assert.equal(request.input.includes(Buffer.from(s.values.alpha).toString('hex')), true);
  assert.throws(() => adapters.writeRequest('Claude Code-credentials', s.config.acct, s.values.alpha));
});

test('metadata attribute parser uses only the modification timestamp', () => {
  const timestamp = '20330518033320Z';
  const metadata = `attributes:\n    "mdat"<timedate>=0x${Buffer.from(timestamp + '\0').toString('hex')}  "${timestamp}\\000"\n`;
  assert.deepEqual(adapters.parseAttributes(metadata), { exists: true, updatedAt: timestamp });
  assert.throws(() => adapters.parseAttributes('unparseable'));
});

for (const stage of api.STAGES) {
  test(`unfinished ${stage} journal refuses every operation on restart`, async t => {
    const s = await setup(t); await s.prepare();
    const entry = { complete: false, stage, laneService: s.config.lane.service };
    await writeFile(join(s.state, 'journal.json'), JSON.stringify(entry), { mode: 0o600 });
    s.store.calls.length = 0;
    for (const [command, label] of [['status'], ['import', 'alpha'], ['switch', 'beta']]) {
      await assert.rejects(s.run(command, label), { code: 'HUMAN_REVIEW' });
    }
    assert.equal(s.store.calls.length, 0);
    assert.equal(s.laneValue() === s.values.alpha, true);
    s.assertLatestPreserved();
  });
}

for (const stage of ['backup-outgoing', 'compare-lane', 'write-lane', 'verify-lane', 'watch-lane', 'commit-ledger']) {
  test(`injected storage failure at ${stage} leaves a blocking journal and no secret diagnostics`, async t => {
    const s = await setup(t); await s.prepare();
    let stopped = false;
    s.store.before = async () => {
      const record = JSON.parse(await readFile(join(s.state, 'journal.json'), 'utf8'));
      if (!stopped && !record.complete && record.stage === stage) { stopped = true; throw new Error(s.marker); }
    };
    try { await s.run('switch', 'beta'); assert.fail('injected failure did not stop'); }
    catch (error) { assert.equal(error.message.includes(s.marker), false); }
    assert.equal(stopped, true);
    s.store.before = null;
    for (const command of ['status', 'import', 'switch']) {
      await assert.rejects(s.run(command, 'alpha'), { code: 'HUMAN_REVIEW' });
    }
    assert.equal((await s.disk()).includes(s.marker), false);
    s.assertLatestPreserved();
  });
}

test('CLI success output, persisted state, and sanitized JSON parse errors contain no credentials or display data', async t => {
  const s = await setup(t); await s.prepare();
  const output = [];
  const streams = { stdout: value => output.push(value), stderr: value => output.push(value) };
  for (const args of [['status'], ['switch', '--to', 'beta', '--apply']]) {
    assert.equal(await cli.main([...args, '--config', s.configPath], {
      ...streams, env: s.env, run: options => s.run(options.command, options.label, options),
    }), 0);
  }
  s.store.entries.get(s.config.accounts.alpha.vaultService).value = `{${s.marker}`;
  await assert.rejects(s.run('switch', 'alpha'), error => !error.message.includes(s.marker));
  const exposed = output.join('\n') + await s.disk();
  assert.equal(exposed.includes(s.marker), false);
  assert.equal(output.join('').includes('displayName'), false);
  assert.equal(output.join('').includes('oauthAccount'), false);
});

test('initial import refuses display mutation after the initial lane comparison', async t => {
  const s = await setup(t);
  s.store.before = async (operation, service) => {
    if (operation === 'write' && service === s.config.accounts.alpha.vaultService) {
      await writeFile(join(s.lane, '.claude.json'), JSON.stringify(s.metadata('unexpected')));
    }
  };
  await assert.rejects(s.run('import', 'alpha'), { code: 'METADATA_CONFLICT' });
  await assert.rejects(s.run('status'), { code: 'HUMAN_REVIEW' });
  // Only the initial account has entered helper ownership at this point.
  s.assertLatestPreserved(['alpha']);
});

test('changing HOME does not permit the OS home or its protected trees', async t => {
  const s = await setup(t);
  const realHome = userInfo().homedir;
  let protectedCalls = 0;
  const fs = Object.fromEntries(['lstat', 'realpath', 'open', 'rename', 'unlink'].map(method => [method, async (...args) => {
    const candidate = resolve(String(args[0]));
    const suffix = relative(realHome, candidate);
    if (suffix === '' || (!suffix.startsWith('../') && suffix !== '..')) {
      protectedCalls++;
      throw new Error('filesystem fake refused a protected home path');
    }
    return filesystem[method](...args);
  }]));
  for (const dir of [realHome, join(realHome, '.claude'), join(realHome, '.config', 'claude-rotator')]) {
    s.config.lane = { dir, service: claudeKeychainServiceName(dir) }; await s.save();
    await assert.rejects(s.run('import', 'alpha', { fs }), { code: 'UNSAFE_PATH' });
  }
  assert.equal(protectedCalls, 0);
  assert.equal(s.store.calls.length, 0);
  assert.deepEqual(await readdir(s.state), []);
});

test('lexically protected paths make zero filesystem calls after normalization', async t => {
  const s = await setup(t);
  let calls = 0;
  const fs = Object.fromEntries(['lstat', 'realpath', 'open', 'rename', 'unlink'].map(method => [method, async () => {
    calls++;
    throw new Error('filesystem fake must never be reached');
  }]));
  const files = safety.createFileAccess(s.env, { fs });
  for (const home of [userInfo().homedir, s.home]) {
    const protectedPaths = [join(home, '.claude'), join(home, '.claude', 'settings.json'),
      join(home, '.claude.json'), join(home, '.config', 'claude-rotator', 'state.json'),
      `${home}/unused/../.claude/settings.json`];
    for (const path of protectedPaths) {
      assert.throws(() => files.check(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.directory(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.fileInfo(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.readText(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.atomicWrite(path, '{}'), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.open(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(files.unlink(path), { code: 'UNSAFE_PATH' });
      await assert.rejects(s.run('status', undefined, { configPath: path, fs }), { code: 'UNSAFE_PATH' });
      assert.equal(calls, 0);
    }
  }
});

test('canonical recheck refuses a lexically safe path resolving to protected metadata', async t => {
  const s = await setup(t);
  const path = join(s.root, 'safe-name');
  let opens = 0;
  const fs = {
    lstat: async candidate => candidate === path
      ? { isFile: () => true, isSymbolicLink: () => false, uid: process.getuid(), nlink: 1, mode: 0o600 }
      : { isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid() },
    realpath: async candidate => candidate === path ? join(userInfo().homedir, '.claude.json') : normalize(candidate),
    open: async () => { opens++; throw new Error('must not open canonical target'); },
  };
  const files = safety.createFileAccess(s.env, { fs });
  await assert.rejects(files.readText(path), { code: 'UNSAFE_PATH' });
  assert.equal(opens, 0);
});

test('status refuses a journal begun during attribute collection without writing', async t => {
  const s = await setup(t); await s.prepare();
  let injected = false;
  s.store.before = async operation => {
    if (!injected && operation === 'attributes') {
      injected = true;
      await writeFile(join(s.state, 'journal.json'), JSON.stringify({ complete: false }), { mode: 0o600 });
    }
  };
  await assert.rejects(s.run('status'), { code: 'HUMAN_REVIEW' });
  s.assertLatestPreserved();
});

test('status refuses an overlapping completed switch instead of mixing generations', async t => {
  const s = await setup(t); await s.prepare();
  let injected = false;
  s.store.before = async operation => {
    if (!injected && operation === 'attributes') { injected = true; await s.run('switch', 'beta'); }
  };
  await assert.rejects(s.run('status'), { code: 'LANE_CONFLICT' });
  s.assertLatestPreserved();
});

test('outgoing display drift is rejected before overwriting its correct vault snapshot', async t => {
  const s = await setup(t); await s.prepare();
  const previous = s.store.entries.get(s.config.accounts.alpha.vaultService).value;
  await writeFile(join(s.lane, '.claude.json'), JSON.stringify(s.metadata('unexpected')));
  await assert.rejects(s.run('switch', 'beta'), { code: 'METADATA_CONFLICT' });
  assert.equal(s.store.entries.get(s.config.accounts.alpha.vaultService).value === previous, true);
  s.assertLatestPreserved();
});

test('remaining limit: an update after the adapter final comparison can be lost before its own write', async t => {
  const s = await setup(t); await s.prepare();
  const latest = s.credential('alpha-in-final-gap');
  let injected = false;
  s.store.beforeCommit = service => {
    if (!injected && service === s.config.lane.service) {
      injected = true; s.latest.set('alpha', latest); s.store.seed(service, latest);
    }
  };
  assert.equal((await s.run('switch', 'beta')).status, 'switched');
  assert.equal(injected, true);
  // Deliberate loss case: the common preservation requirement excludes this boundary.
  assert.equal(s.latestRetained('alpha'), false);
  s.assertLatestPreserved(['beta']);
});

test('an update visible to the adapter immediately before writing is quarantined without overwrite', async t => {
  const s = await setup(t); await s.prepare();
  const latest = s.credential('alpha-before-write');
  s.store.before = (operation, service) => {
    if (operation === 'write' && service === s.config.lane.service) {
      s.latest.set('alpha', latest); s.store.seed(service, latest);
    }
  };
  await assert.rejects(s.run('switch', 'beta'), { code: 'R8_SUSPECTED' });
  assert.equal(s.laneValue() === latest, true);
  s.assertLatestPreserved();
});

test('an extra attribute update between the write receipt and confirmation is R8 even with the expected value', async t => {
  const s = await setup(t); await s.prepare();
  const write = s.store.write.bind(s.store);
  s.store.write = async (service, value, options) => {
    const receipt = await write(service, value, options);
    if (service === s.config.lane.service) s.store.seed(service, value);
    return receipt;
  };
  await assert.rejects(s.run('switch', 'beta'), { code: 'R8_SUSPECTED' });
  s.assertLatestPreserved();
});

for (const remove of [false, true]) {
  test(`quarantine preserves the detection value when the lane is ${remove ? 'deleted' : 'updated again'} before quarantine`, async t => {
    const s = await setup(t); await s.prepare();
    const detected = s.credential('alpha-detected');
    const later = s.credential('alpha-later');
    let triggered = false; let intervened = false;
    const fs = { ...filesystem, rename: async (from, to) => {
      if (to === join(s.state, 'journal.json')) {
        const entry = JSON.parse(await readFile(from, 'utf8'));
        if (entry.stage === 'quarantine' && !intervened) {
          intervened = true;
          if (remove) s.store.entries.delete(s.config.lane.service);
          else { s.latest.set('alpha', later); s.store.seed(s.config.lane.service, later); }
        }
      }
      return filesystem.rename(from, to);
    } };
    await assert.rejects(s.run('switch', 'beta', { fs, sleep: async () => {
      if (!triggered) {
        triggered = true; s.latest.set('alpha', detected); s.store.seed(s.config.lane.service, detected);
      }
    } }), { code: 'R8_SUSPECTED' });
    assert.equal(intervened, true);
    const isolated = [...s.store.entries].filter(([service]) => service.startsWith('caseG-T1-vault-quarantine-'));
    assert.equal(isolated.some(([, item]) => item.value === detected), true);
    assert.equal(isolated.length, remove ? 1 : 2);
    if (!remove) assert.equal(isolated.some(([, item]) => item.value === later), true);
    else assert.equal(s.store.entries.has(s.config.lane.service), false);
    await assert.rejects(s.run('switch', 'alpha'), { code: 'HUMAN_REVIEW' });
    assert.equal((await s.disk()).includes(s.marker), false);
    s.assertLatestPreserved();
  });
}

test('same-second write-back is caught at switch start by comparing the current lane owner vault', async t => {
  const s = await setup(t); await s.prepare(); await s.run('switch', 'beta');
  s.store.fixedUpdatedAt = s.store.entries.get(s.config.lane.service).updatedAt;
  const latest = s.credential('beta-same-second');
  s.latest.set('beta', latest); s.store.seed(s.config.lane.service, latest);
  await assert.rejects(s.run('switch', 'alpha'), { code: 'R8_SUSPECTED' });
  assert.equal((await s.ledger()).reviewRequired, true);
  assert.equal([...s.store.entries].some(([service, item]) => service.startsWith('caseG-T1-vault-quarantine-') && item.value === latest), true);
  s.assertLatestPreserved();
});

test('watch polls attributes only and the final confirmation still reads the value', async t => {
  const s = await setup(t); await s.prepare();
  const pollCalls = []; const finalCalls = [];
  s.store.before = async (operation, service) => {
    const entry = JSON.parse(await readFile(join(s.state, 'journal.json'), 'utf8'));
    if (service === s.config.lane.service && entry.stage === 'watch-lane') pollCalls.push(operation);
    if (service === s.config.lane.service && entry.stage === 'commit-ledger') finalCalls.push(operation);
  };
  await s.run('switch', 'beta');
  assert.equal(pollCalls.length, 4);
  assert.equal(pollCalls.every(operation => operation === 'attributes'), true);
  assert.equal(finalCalls.filter(operation => operation === 'read').length, 1);
  s.assertLatestPreserved();
});

test('same-second mutation hidden from watch attributes is caught by the final value comparison', async t => {
  const s = await setup(t); await s.prepare();
  s.store.fixedUpdatedAt = s.store.entries.get(s.config.lane.service).updatedAt;
  const latest = s.credential('alpha-same-second-watch');
  let changed = false;
  await assert.rejects(s.run('switch', 'beta', { sleep: async () => {
    if (!changed) { changed = true; s.latest.set('alpha', latest); s.store.seed(s.config.lane.service, latest); }
  } }), { code: 'R8_SUSPECTED' });
  s.assertLatestPreserved();
});

test('status reports timestamp mismatch as a boolean without reading credentials', async t => {
  const s = await setup(t); await s.prepare();
  assert.equal((await s.run('status')).laneTimestampMismatch, false);
  s.store.seed(s.config.lane.service, s.values.alpha); s.store.calls.length = 0;
  const result = await s.run('status');
  assert.equal(result.laneTimestampMismatch, true);
  assert.equal(s.store.calls.every(call => call.operation === 'attributes'), true);
  s.assertLatestPreserved();
});
