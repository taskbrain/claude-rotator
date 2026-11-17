import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { claudeKeychainServiceName } from '../src/claude-keychain.js';
import { CLAUDE_PROVIDER_OVERRIDE_ENV_VARS } from '../src/claude-provider-env.js';
import { runCli } from '../src/cli.js';
import {
  buildFallbackAPlan, buildResidentPlan, decide, DEFAULT_FALLBACK_A_PROMPT, defaultRunner, loadRefreshSupervisorConfig,
  refreshLockPath, REASON_CODES,
  mdatFromDumps, normalizeRefreshSupervisor, notificationText, parseKeychainMdat, planEnvironment,
  parsePsStart, probeExpiryEvents, probeOtherUsers, probeResident, refreshStatePath, runRefreshSupervisor,
} from '../src/credential-swap-refresh-supervisor.js';

const HOUR = 3_600_000;
const MDAT = Date.UTC(2033, 4, 18, 3, 33, 20);
const SECRET = 'sk-ant-DUMMY-not-a-real-secret';
const CLAUDE = '/opt/test-claude/bin/claude';
const LSTART = 'Wed May 18 03:00:00 2033';
const FORBIDDEN = ['-w', '-g', '-d', 'find-generic-password', '-E', 'eww'];

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'refresh-supervisor-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { id: 'send-test', configDir: join(root, 'account-config'), acct: 'test-keychain-account',
    keychainPath: join(root, 'keychains', 'test.keychain-db'),
    keychainAllowlist: [join(root, 'keychains', 'test.keychain-db'), join(root, 'keychains', 'other.keychain-db')],
    workDir: join(root, 'work'), swapStateDir: join(root, 'swap-state') };
  account.service = claudeKeychainServiceName(account.configDir);
  await mkdir(account.workDir, { recursive: true });
  await mkdir(join(account.swapStateDir, 'events'), { recursive: true });
  const raw = { refreshSupervisor: { stateDir: join(root, 'supervisor-state'), claudeBin: CLAUDE,
    accounts: [account] } };
  return { root, account, raw, config: normalizeRefreshSupervisor(raw) };
}

function block(account, { file = account.keychainPath, acct = account.acct, service = account.service,
  mdat = '20330518033320Z\\000', extra = '' } = {}) {
  return `keychain: "${file}"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct}"\n`
    + `    "svce"<blob>="${service}"\n    "cdat"<timedate>=0x3230 "20330101000000Z\\000"\n`
    + `    "mdat"<timedate>=0x32303333303531383033333332305A00  "${mdat}"\n${extra}`;
}

function fakeExecute(account, overrides = {}) {
  const calls = [];
  let dumps = 0;
  const execute = async (command, args, options) => {
    calls.push([command, ...args]);
    assert.equal(options.encoding, 'utf8');
    assert.ok(options.timeout > 0);
    if (command === '/usr/bin/security') {
      assert.equal(args.length, 2);
      assert.equal(args[0], 'dump-keychain');
      if (args[1] !== account.keychainPath) return { stdout: '' };
      dumps++;
      return { stdout: overrides.dump ? overrides.dump(dumps) : block(account) };
    }
    if (command === '/bin/ps') {
      assert.deepEqual(args.slice(0, 1).concat(args.slice(2)), ['-p', '-o', 'lstart=,command=']);
      if (overrides.ps) return overrides.ps(args[1]);
      throw Object.assign(new Error('no process'), { code: 1, stdout: '' });
    }
    if (command === '/usr/sbin/lsof') {
      assert.deepEqual(args, ['-nP', '-t', '+D', account.configDir]);
      if (overrides.lsof) return overrides.lsof();
      throw Object.assign(new Error('none'), { code: 1, stdout: '' });
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { execute, calls };
}

function assertNoForbiddenCommands(calls) {
  for (const call of calls) {
    for (const token of FORBIDDEN) assert.equal(call.includes(token), false, call.join(' '));
    assert.equal(call.join(' ').includes('ps -E'), false);
  }
}

const observation = (overrides = {}) => ({
  mdat: { status: 'ok', mdatMs: MDAT, identity: null },
  expiry: { latestExpiredMs: null, unreadable: 0 },
  resident: 'alive', otherUsers: 'none', ...overrides,
});

test('config normalizes defaults and rejects invalid or overlapping settings', async t => {
  const { root, account, raw, config } = await sandbox(t);
  assert.equal(config.expectedIntervalMs, 8 * HOUR);
  assert.equal(config.staleAfterMs, 9 * HOUR);
  assert.equal(config.notifyDedupeMs, 6 * HOUR);
  assert.deepEqual(config.fallbackA, { enabled: false, minIntervalMs: 6 * HOUR, maxPerDay: 2,
    timeoutMs: 120_000, prompt: DEFAULT_FALLBACK_A_PROMPT });
  const base = raw.refreshSupervisor;
  const invalid = [
    null, {}, { refreshSupervisor: [] },
    { ...base, stateDir: 'relative' }, { ...base, claudeBin: 'claude' }, { ...base, accounts: [] },
    { ...base, staleAfterMs: HOUR }, { ...base, notifyDedupeMs: -1 },
    { ...base, fallbackA: { enabled: 'yes' } }, { ...base, fallbackA: { maxPerDay: 0 } },
    { ...base, fallbackA: { prompt: 'two\nlines' } }, { ...base, fallbackA: { prompt: '/login' } },
    { ...base, fallbackA: { prompt: '--help' } }, { ...base, fallbackA: { prompt: '' } },
    { ...base, accounts: [{ ...account, workDir: 'work' }] },
    { ...base, accounts: [{ ...account, swapStateDir: 'swap' }] },
    { ...base, accounts: [{ ...account, service: 'Claude Code-credentials' }] },
    { ...base, accounts: [{ ...account, keychainAllowlist: [] }] },
    { ...base, accounts: [account, account] },
    { ...base, accounts: [{ ...account, id: '__proto__' }] },
    { ...base, accounts: [{ ...account, id: 'constructor' }] },
    { ...base, accounts: [{ ...account, id: 'prototype' }] },
    // Overlaps: state with the sender's config, Keychain folder or swap state; work folder with config.
    { ...base, stateDir: join(account.configDir, 'state') },
    { ...base, stateDir: join(root, 'keychains') },
    { ...base, stateDir: account.swapStateDir },
    { ...base, accounts: [{ ...account, workDir: account.configDir }] },
    { ...base, accounts: [{ ...account, workDir: base.stateDir }] },
  ];
  for (const value of invalid) {
    assert.throws(() => normalizeRefreshSupervisor(value === null ? null : (value.refreshSupervisor !== undefined
      || !Object.keys(value).length ? value : { refreshSupervisor: value })), /^Error: invalid_refresh_config$/);
  }
  const path = join(root, 'supervisor.json');
  await writeFile(path, '{not json');
  await assert.rejects(loadRefreshSupervisorConfig(path), /^Error: invalid_refresh_config$/);
  await writeFile(path, JSON.stringify(raw));
  assert.equal((await loadRefreshSupervisorConfig(path)).accounts[0].id, 'send-test');
});

test('mdat parsing accepts exactly one matching attribute-only item in the expected file', async t => {
  const { root, account } = await sandbox(t);
  const fixture = (await readFile(new URL('../fixtures/credential-swap-dump-mdat.txt', import.meta.url), 'utf8'))
    .replaceAll('@KEYCHAIN@', account.keychainPath).replaceAll('@ACCOUNT@', account.acct)
    .replaceAll('@SERVICE@', account.service);
  const real = mdatFromDumps(account, [{ file: account.keychainPath, stdout: fixture }]);
  assert.equal(real.status, 'ok');
  assert.equal(real.mdatMs, MDAT);
  const other = account.keychainAllowlist[1];
  const cases = [
    [[], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account) }], 'ok'],
    [[{ file: account.keychainPath, stdout: block(account) + block(account) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account) }, { file: other, stdout: block(account, { file: other }) }], 'unknown'],
    [[{ file: other, stdout: block(account, { file: other }) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account, { extra: 'data:\n"secret"\n' }) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account, { mdat: '20330518033320Z\\9' }) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account, { mdat: '20331318033320Z' }) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account, { acct: 'unrelated' }) }], 'unknown'],
    [[{ file: account.keychainPath, stdout: block(account, { file: join(root, 'elsewhere') }) }], 'unknown'],
  ];
  for (const [dumps, expected] of cases) assert.equal(mdatFromDumps(account, dumps).status, expected);
  assert.equal(parseKeychainMdat('20330518033320Z\x00'), MDAT);
  assert.equal(parseKeychainMdat('2033-05-18'), null);
});

test('decide covers every policy branch', () => {
  const policy = normalizeRefreshSupervisor({ refreshSupervisor: { stateDir: '/test/state', claudeBin: CLAUDE,
    accounts: [{ id: 'a', configDir: '/test/config', acct: 'x', service: claudeKeychainServiceName('/test/config'),
      keychainPath: '/test/k/a.keychain-db', keychainAllowlist: ['/test/k/a.keychain-db'], workDir: '/test/work' }] } });
  const enabled = { ...policy, fallbackA: { ...policy.fallbackA, enabled: true } };
  const fresh = MDAT + HOUR;
  const stale = MDAT + 10 * HOUR;
  const check = (obs, state, pol, now, action, reason) =>
    assert.deepEqual(decide(observation(obs), state, pol, now), { action, reason });
  check({}, {}, policy, fresh, 'none', 'fresh');
  check({ resident: 'absent' }, {}, policy, fresh, 'start_resident', 'resident_missing');
  check({ resident: 'absent', otherUsers: 'present' }, {}, policy, fresh, 'notify_unknown', 'other_users_present');
  check({ resident: 'absent', otherUsers: 'unknown' }, {}, policy, fresh, 'notify_unknown', 'other_users_unknown');
  check({ resident: 'unknown' }, {}, policy, fresh, 'notify_unknown', 'resident_unknown');
  check({ mdat: { status: 'unknown' } }, {}, enabled, stale, 'notify_unknown', 'mdat_unknown');
  check({}, {}, policy, stale, 'notify_login', 'fallback_a_disabled');
  check({ expiry: { latestExpiredMs: MDAT + 1, unreadable: 0 }, resident: 'absent' }, {}, policy, fresh,
    'notify_login', 'fallback_a_disabled');
  // A live resident refreshes near expiry by itself: an expiry record alone is not a failure until aged.
  check({ expiry: { latestExpiredMs: MDAT + 1, unreadable: 0 } }, {}, enabled, fresh, 'none', 'resident_refresh_pending');
  check({ expiry: { latestExpiredMs: MDAT + 1, unreadable: 0 } }, {}, enabled, stale, 'fallback_a', 'credential_expired');
  // Unknown inputs never lead to an automatic action, on either side of staleness.
  check({ resident: 'unknown' }, {}, enabled, stale, 'notify_unknown', 'resident_unknown');
  check({ resident: 'unverified' }, {}, enabled, fresh, 'notify_unknown', 'resident_unverified');
  check({ resident: 'unverified' }, {}, enabled, stale, 'notify_unknown', 'resident_unverified');
  check({ resident: 'absent', expiry: { latestExpiredMs: null, unreadable: 1 } }, {}, enabled, fresh,
    'notify_unknown', 'expiry_events_unreadable');
  check({ expiry: { latestExpiredMs: null, unreadable: 2 } }, {}, enabled, stale,
    'notify_unknown', 'expiry_events_unreadable');
  check({ resident: 'absent' }, { invalid: true }, enabled, fresh, 'notify_unknown', 'refresh_state_invalid');
  check({ expiry: { latestExpiredMs: MDAT - 1, unreadable: 0 } }, {}, policy, fresh, 'none', 'fresh');
  check({}, {}, enabled, stale, 'fallback_a', 'mdat_stale');
  check({ expiry: { latestExpiredMs: MDAT + 1, unreadable: 0 }, resident: 'absent' }, {}, enabled, fresh,
    'fallback_a', 'credential_expired');
  check({ otherUsers: 'present' }, {}, enabled, stale, 'notify_stale', 'other_users_present');
  check({ otherUsers: 'unknown' }, {}, enabled, stale, 'notify_stale', 'other_users_unknown');
  const older = { fallbackA: { attempts: [stale - HOUR], lastAttemptMdat: MDAT - HOUR } };
  check({}, older, enabled, stale, 'notify_stale', 'fallback_a_interval');
  const limit = { fallbackA: { attempts: [stale - 20 * HOUR, stale - 7 * HOUR], lastAttemptMdat: MDAT - HOUR } };
  check({}, limit, enabled, stale, 'notify_login', 'fallback_a_daily_limit');
  const noProgress = { fallbackA: { attempts: [stale - 7 * HOUR], lastAttemptMdat: MDAT } };
  check({}, noProgress, enabled, stale, 'notify_login', 'fallback_a_no_progress');
  const progressed = { fallbackA: { attempts: [MDAT - HOUR], lastAttemptMdat: MDAT - 9 * HOUR } };
  check({}, progressed, enabled, fresh, 'none', 'fresh');
  const expired = { fallbackA: { attempts: [stale - 30 * HOUR], lastAttemptMdat: MDAT - HOUR } };
  check({}, expired, enabled, stale, 'fallback_a', 'mdat_stale');
});

test('resident plan has no arguments, removes overrides and refuses a non-empty work folder', async t => {
  const { account, config } = await sandbox(t);
  const providers = Object.fromEntries(CLAUDE_PROVIDER_OVERRIDE_ENV_VARS.map(name => [name, '1']));
  const env = { PATH: '/usr/bin', ...providers, ANTHROPIC_API_KEY: SECRET, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_AUTH_TOKEN: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET, HTTPS_PROXY: 'http://proxy', https_proxy: 'x',
    CLAUDE_CONFIG_DIR: '/wrong' };
  const plan = await buildResidentPlan(account, config, { env });
  assert.equal(plan.file, CLAUDE);
  assert.deepEqual(plan.args, []);
  assert.equal(plan.cwd, account.workDir);
  assert.deepEqual(plan.envSet, { CLAUDE_CONFIG_DIR: account.configDir });
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    ...CLAUDE_PROVIDER_OVERRIDE_ENV_VARS])
    assert.ok(plan.envUnset.includes(name), name);
  assert.equal(JSON.stringify(plan).includes(SECRET), false);
  const finalEnv = planEnvironment(plan, { ...env, ANTHROPIC_LATE: SECRET });
  // Removed even when a plan's own list was built from an environment without them.
  assert.deepEqual(planEnvironment({ ...plan, envUnset: [] }, env),
    { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: account.configDir });
  assert.deepEqual(finalEnv, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: account.configDir });
  await writeFile(join(account.workDir, 'file'), '');
  await assert.rejects(buildResidentPlan(account, config, { env }), /^Error: work_dir_not_empty$/);
  await assert.rejects(buildResidentPlan({ ...account, workDir: join(account.workDir, 'missing') }, config, { env }),
    /^Error: work_dir_unavailable$/);
});

test('fallback A plan uses fixed official options without a shell or permission bypass', async t => {
  const { account, config } = await sandbox(t);
  const plan = await buildFallbackAPlan(account, config, { env: {} });
  assert.equal(plan.file, CLAUDE);
  assert.deepEqual(plan.args, ['-p', DEFAULT_FALLBACK_A_PROMPT, '--tools', '', '--strict-mcp-config',
    '--permission-prompts', 'none']);
  assert.equal(plan.timeoutMs, 120_000);
  assert.equal('shell' in plan, false);
  assert.equal(plan.args.some(arg => /dangerously|bypass|allow-dangerously/i.test(arg)), false);
  assert.ok(!['/bin/sh', '/bin/bash', '/bin/zsh'].includes(plan.file));
});

test('swap events contribute only expired reasons for this account and count unreadable files', async t => {
  const { account } = await sandbox(t);
  const events = join(account.swapStateDir, 'events');
  const write = async (name, value, time) => {
    await writeFile(join(events, name), typeof value === 'string' ? value : JSON.stringify(value));
    await utimes(join(events, name), time / 1000, time / 1000);
  };
  await write('a.json', { reason: 'credential_expired', statusCode: 503, sentAccountId: null,
    displayAccountId: SECRET }, MDAT + 2000);
  await write('b.json', { reason: 'credential_expired', statusCode: 503, sentAccountId: 'another' }, MDAT + 9000);
  await write('c.json', { reason: 'completed', statusCode: 200, sentAccountId: account.id }, MDAT + 9000);
  await write('d.json', '{broken', MDAT);
  const result = await probeExpiryEvents(account);
  assert.deepEqual(result, { latestExpiredMs: MDAT + 2000, unreadable: 1 });
  assert.deepEqual(await probeExpiryEvents({ ...account, swapStateDir: join(account.swapStateDir, 'none') }),
    { latestExpiredMs: null, unreadable: 0 });
});

test('resident and other-user probes compare identity and treat failures as unknown', async t => {
  const { account, config } = await sandbox(t);
  const state = { resident: { pid: 4242, startedAt: LSTART } };
  const alive = fakeExecute(account, { ps: () => ({ stdout: `${LSTART}     ${CLAUDE}\n` }) });
  assert.deepEqual(await probeResident(account, state, config, alive.execute), { status: 'alive', pid: 4242, clearUnverified: false });
  const reused = fakeExecute(account, { ps: () => ({ stdout: `Thu May 19 03:00:00 2033 ${CLAUDE}\n` }) });
  assert.equal((await probeResident(account, state, config, reused.execute)).status, 'absent');
  const other = fakeExecute(account, { ps: () => ({ stdout: `${LSTART} /bin/other\n` }) });
  assert.equal((await probeResident(account, state, config, other.execute)).status, 'absent');
  const failing = fakeExecute(account, { ps: () => { throw Object.assign(new Error('x'), { code: 2 }); } });
  assert.equal((await probeResident(account, state, config, failing.execute)).status, 'unknown');
  const gone = fakeExecute(account);
  assert.equal((await probeResident(account, state, config, gone.execute)).status, 'absent');

  const lsof = output => fakeExecute(account, { lsof: output }).execute;
  assert.equal(await probeOtherUsers(account, null, lsof(() => ({ stdout: '' }))), 'none');
  assert.equal(await probeOtherUsers(account, 4242, lsof(() => ({ stdout: '4242\n' }))), 'none');
  assert.equal(await probeOtherUsers(account, 4242, lsof(() => ({ stdout: '4242\n5151\n' }))), 'present');
  assert.equal(await probeOtherUsers(account, null, lsof(() => ({ stdout: 'p5151\n' }))), 'unknown');
  assert.equal(await probeOtherUsers(account, null, lsof(() => {
    throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: 'lsof: WARNING: can\'t stat()' });
  })), 'unknown');
  assert.equal(await probeOtherUsers(account, null, lsof(() => ({ stdout: 'garbage\n' }))), 'unknown');
  assert.equal(await probeOtherUsers(account, null, lsof(() => {
    throw Object.assign(new Error('t'), { killed: true, signal: 'SIGTERM', code: null });
  })), 'unknown');
  assert.equal(await probeOtherUsers(account, null, fakeExecute(account).execute), 'none');
  assertNoForbiddenCommands([...alive.calls, ...reused.calls, ...failing.calls]);
});

function sideEffects() {
  const record = { launcher: [], runner: [], notify: [] };
  return {
    record,
    launcher: async (plan, env) => { record.launcher.push({ plan, env }); return { pid: 4242 }; },
    runner: async (plan, env) => { record.runner.push({ plan, env }); return { code: 0, stdoutBytes: 3, stderrBytes: 0 }; },
    notify: async message => { record.notify.push(message); return { result: 'exited-0' }; },
  };
}

const SECRET_ENV = { PATH: '/usr/bin', ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET,
  HTTPS_PROXY: `http://user:${SECRET}@proxy` };

test('dry-run observes and decides without launching, running, notifying or writing state', async t => {
  const { account, config } = await sandbox(t);
  const fake = fakeExecute(account);
  const effects = sideEffects();
  const writes = [];
  const report = await runRefreshSupervisor({ config, now: () => MDAT + HOUR, execute: fake.execute,
    env: SECRET_ENV, ...effects, writeState: async (...args) => { writes.push(args); } });
  assert.equal(report.mode, 'dry-run');
  assert.deepEqual(report.accounts.map(({ action, reason }) => ({ action, reason })),
    [{ action: 'start_resident', reason: 'resident_missing' }]);
  assert.deepEqual(effects.record, { launcher: [], runner: [], notify: [] });
  assert.equal(writes.length, 0);
  await assert.rejects(stat(refreshStatePath(config)), { code: 'ENOENT' });
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.equal(JSON.stringify(report).includes(account.configDir), false);
  assertNoForbiddenCommands(fake.calls);
});

test('apply starts the resident, records identity in a 0600 state file and keeps secrets out', async t => {
  const { account, config } = await sandbox(t);
  const fake = fakeExecute(account, { ps: () => ({ stdout: `${LSTART} ${CLAUDE}\n` }) });
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects });
  assert.equal(report.accounts[0].result, 'started');
  assert.equal(effects.record.launcher.length, 1);
  const { plan, env } = effects.record.launcher[0];
  assert.deepEqual(plan.args, []);
  assert.deepEqual(env, { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: account.configDir });
  const info = await stat(refreshStatePath(config));
  assert.equal(info.mode & 0o777, 0o600);
  const saved = await readFile(refreshStatePath(config), 'utf8');
  assert.equal(saved.includes(SECRET), false);
  const parsed = JSON.parse(saved);
  assert.deepEqual(parsed.accounts[account.id].resident, { pid: 4242, startedAt: LSTART });
  assert.equal(parsed.accounts[account.id].lastMdat, MDAT);
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assertNoForbiddenCommands(fake.calls);

  // The next pass sees the recorded resident alive and does nothing.
  const next = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 2 * HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects });
  assert.deepEqual([next.accounts[0].action, next.accounts[0].reason], ['none', 'fresh']);
  assert.equal(effects.record.launcher.length, 1);
});

test('apply refuses to start in a non-empty work folder and notifies instead', async t => {
  const { account, config } = await sandbox(t);
  await writeFile(join(account.workDir, 'leftover'), '');
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects });
  assert.equal(report.accounts[0].result, 'work_dir_not_empty');
  assert.equal(effects.record.launcher.length, 0);
  assert.equal(effects.record.notify.length, 1);
});

test('fallback A runs once, confirms progress and notifies login when mdat does not advance', async t => {
  const { raw, account } = await sandbox(t);
  const config = normalizeRefreshSupervisor({ refreshSupervisor: { ...raw.refreshSupervisor,
    fallbackA: { enabled: true } } });
  const stale = MDAT + 10 * HOUR;
  // Progress: the second dump shows a newer modification time.
  const advancing = fakeExecute(account, { dump: count => count === 1 ? block(account)
    : block(account, { mdat: '20330518133320Z\\000' }) });
  const effects = sideEffects();
  const ok = await runRefreshSupervisor({ config, apply: true, now: () => stale, execute: advancing.execute,
    env: SECRET_ENV, ...effects });
  assert.equal(ok.accounts[0].action, 'fallback_a');
  assert.equal(ok.accounts[0].result, 'refreshed');
  assert.deepEqual(ok.accounts[0].run, { code: 0, timedOut: false, stdoutBytes: 3, stderrBytes: 0 });
  assert.equal(effects.record.runner.length, 1);
  assert.equal(effects.record.notify.length, 0);
  const { env } = effects.record.runner[0];
  assert.equal(JSON.stringify(env).includes(SECRET), false);
  assertNoForbiddenCommands(advancing.calls);

  // No progress on a later stale pass: one run, then a login notice, no retry.
  await rm(refreshStatePath(config));
  const flat = fakeExecute(account);
  const second = sideEffects();
  const failed = await runRefreshSupervisor({ config, apply: true, now: () => stale, execute: flat.execute,
    env: SECRET_ENV, ...second });
  assert.equal(failed.accounts[0].result, 'no_progress');
  assert.equal(second.record.runner.length, 1);
  assert.equal(second.record.notify.length, 1);
  assert.match(second.record.notify[0].body, /send-test/);
  const again = await runRefreshSupervisor({ config, apply: true, now: () => stale + HOUR, execute: flat.execute,
    env: SECRET_ENV, ...second });
  assert.deepEqual([again.accounts[0].action, again.accounts[0].reason], ['notify_login', 'fallback_a_no_progress']);
  assert.equal(again.accounts[0].notice, 'deduped');
  assert.equal(second.record.runner.length, 1);
  assert.equal(second.record.notify.length, 1);
  const saved = await readFile(refreshStatePath(config), 'utf8');
  assert.equal(saved.includes(SECRET), false);
  assert.equal(JSON.parse(saved).accounts[account.id].fallbackA.attempts.length, 1);
});

test('notifications name only the account and are deduplicated per action', async t => {
  const { account, config } = await sandbox(t);
  for (const action of ['notify_login', 'notify_stale', 'notify_unknown']) {
    const { body } = notificationText(account.id, action, 'mdat_unknown');
    assert.match(body, /send-test/);
    assert.equal(body.includes('/Users') || body.includes(tmpdir()) || body.includes('@'), false);
  }
  const effects = sideEffects();
  const unknown = fakeExecute(account, { dump: () => '' });
  for (const offset of [0, HOUR, 7 * HOUR]) {
    await runRefreshSupervisor({ config, apply: true, now: () => MDAT + offset, execute: unknown.execute,
      env: SECRET_ENV, ...effects });
  }
  assert.equal(effects.record.notify.length, 2);
  assert.equal(effects.record.launcher.length + effects.record.runner.length, 0);
});

test('CLI runs one dry-run pass by default and keeps errors to reason codes', async t => {
  const { raw, root } = await sandbox(t);
  const path = join(root, 'supervisor.json');
  await writeFile(path, JSON.stringify(raw));
  const output = [];
  const calls = [];
  const deps = { write: value => output.push(value), error: value => output.push(value),
    runRefreshSupervisor: async options => { calls.push(options.apply); return { mode: 'dry-run', accounts: [] }; } };
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path], deps), 0);
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path, '--apply'], deps), 0);
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(JSON.parse(output[0]), { mode: 'dry-run', accounts: [] });
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path, '--loop'], deps), 1);
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor'], deps), 1);
  output.length = 0;
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path], {
    ...deps, runRefreshSupervisor: async () => { throw new Error(SECRET); } }), 1);
  assert.deepEqual(output, ['refresh_supervisor_failed\n']);
  output.length = 0;
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', join(root, 'missing.json')], deps), 1);
  assert.deepEqual(output, ['invalid_refresh_config\n']);
});

async function enabledConfig(raw) {
  return normalizeRefreshSupervisor({ refreshSupervisor: { ...raw.refreshSupervisor, fallbackA: { enabled: true } } });
}

async function writeState(config, accounts) {
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(refreshStatePath(config), JSON.stringify({ version: 1, accounts }));
}

test('an unknown resident probe keeps the record and takes no automatic action', async t => {
  const { account, config } = await sandbox(t);
  await writeState(config, { [account.id]: { resident: { pid: 4242, startedAt: LSTART } } });
  const fake = fakeExecute(account, { ps: () => { throw Object.assign(new Error('x'), { code: 2 }); } });
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 10 * HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects });
  assert.deepEqual([report.accounts[0].action, report.accounts[0].reason], ['notify_unknown', 'resident_unknown']);
  assert.equal(effects.record.launcher.length + effects.record.runner.length, 0);
  const saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8'));
  assert.deepEqual(saved.accounts[account.id].resident, { pid: 4242, startedAt: LSTART });
});

test('an unverified launch is recorded, blocks relaunch, and clears only when ps proves it gone', async t => {
  const { account, config } = await sandbox(t);
  let psAnswer = () => ({ stdout: `${LSTART} /bin/unexpected\n` });
  const fake = fakeExecute(account, { ps: () => psAnswer() });
  const effects = sideEffects();
  const first = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects });
  assert.equal(first.accounts[0].result, 'resident_unverified');
  let saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8'));
  assert.deepEqual(saved.accounts[account.id].residentUnverified,
    { pid: 4242, startedAt: LSTART, pendingSince: MDAT + HOUR });
  assert.equal(saved.accounts[account.id].resident, null);

  const second = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 2 * HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects });
  assert.deepEqual([second.accounts[0].action, second.accounts[0].reason], ['notify_unknown', 'resident_unverified']);
  assert.equal(effects.record.launcher.length, 1);

  psAnswer = () => { throw Object.assign(new Error('x'), { code: 1, stdout: '' }); };
  const third = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 3 * HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects, launcher: async () => ({ pid: 5151 }) });
  assert.equal(third.accounts[0].action, 'start_resident');
  saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8'));
  // The new launch is again unverified (ps reports absent), and the old record is gone.
  assert.deepEqual(saved.accounts[account.id].residentUnverified,
    { pid: 5151, startedAt: null, pendingSince: MDAT + 3 * HOUR });
});

test('apply is exclusive: concurrent passes run A once and a leftover lock stops all action', async t => {
  const { raw, account } = await sandbox(t);
  const config = await enabledConfig(raw);
  let release;
  const gate = new Promise(done => { release = done; });
  const effects = sideEffects();
  const runner = async (plan, env) => { effects.record.runner.push({ plan, env }); await gate; return { code: 0 }; };
  const pass = () => runRefreshSupervisor({ config, apply: true, now: () => MDAT + 10 * HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects, runner });
  const first = pass();
  await new Promise(done => setTimeout(done, 50));
  await assert.rejects(pass(), /^Error: refresh_supervisor_locked$/);
  release();
  await first;
  assert.equal(effects.record.runner.length, 1);
  await assert.rejects(stat(refreshLockPath(config)), { code: 'ENOENT' });

  await writeFile(refreshLockPath(config), '{"pid":1,"startedAt":1}\n', { mode: 0o600 });
  const blocked = sideEffects();
  await assert.rejects(runRefreshSupervisor({ config, apply: true, now: () => MDAT + 40 * HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...blocked }), /^Error: refresh_supervisor_locked$/);
  assert.deepEqual(blocked.record, { launcher: [], runner: [], notify: [] });
  assert.equal(await readFile(refreshLockPath(config), 'utf8'), '{"pid":1,"startedAt":1}\n');
  // Dry-run takes no lock.
  const dry = await runRefreshSupervisor({ config, now: () => MDAT + 40 * HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...blocked });
  assert.equal(dry.mode, 'dry-run');
});

test('the lock is 0600, holds only pid and start time, and is removed after a failure before any launch', async t => {
  const { account, config } = await sandbox(t);
  let seen;
  const launcher = async () => {
    const info = await stat(refreshLockPath(config));
    seen = { mode: info.mode & 0o777, body: JSON.parse(await readFile(refreshLockPath(config), 'utf8')) };
    throw new Error('boom');
  };
  await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR, execute: fakeExecute(account).execute,
    env: SECRET_ENV, ...sideEffects(), launcher });
  assert.equal(seen.mode, 0o600);
  assert.deepEqual(Object.keys(seen.body).sort(), ['pid', 'startedAt']);
  await assert.rejects(stat(refreshLockPath(config)), { code: 'ENOENT' });
  // The failed launch left a pending record; start again from an empty state so
  // the next pass reaches the pre-launch write, which now fails.
  await rm(refreshStatePath(config));
  const effects = sideEffects();
  await assert.rejects(runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects,
    writeState: async () => { throw new Error('disk'); } }), /^Error: refresh_state_write_failed$/);
  assert.equal(effects.record.launcher.length, 0);
  await assert.rejects(stat(refreshLockPath(config)), { code: 'ENOENT' });
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => { child.signals.push(signal); return true; };
  return child;
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    timers: { setTimeout: (callback, ms) => { const entry = { callback, ms, cleared: false }; scheduled.push(entry); return entry; },
      clearTimeout: entry => { if (entry) entry.cleared = true; } },
    fire: () => { const entry = scheduled.find(item => !item.cleared && !item.fired); entry.fired = true; entry.callback(); return entry.ms; },
  };
}

test('the default runner escalates SIGTERM to SIGKILL and resolves unfinished if close never comes', async () => {
  const plan = { file: CLAUDE, args: ['-p', 'x'], cwd: '/test/work', timeoutMs: 120_000 };
  const child = fakeChild();
  const clock = fakeTimers();
  const spawned = [];
  const running = defaultRunner(plan, { PATH: '/usr/bin' }, { timers: clock.timers,
    spawn: (file, args, options) => { spawned.push({ file, args, options }); return child; } });
  assert.equal(spawned[0].options.shell, false);
  assert.deepEqual(spawned[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  child.stdout.emit('data', Buffer.from('hello'));
  assert.equal(clock.fire(), 120_000);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(clock.fire(), 5_000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(clock.fire(), 5_000);
  const result = await running;
  assert.equal(result.unfinished, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdoutBytes, 5);

  const quick = fakeChild();
  const quickClock = fakeTimers();
  const done = defaultRunner(plan, {}, { timers: quickClock.timers, spawn: () => quick });
  quick.emit('close', 0, null);
  assert.deepEqual(await done, { code: 0, signal: null, error: false, unfinished: false,
    timedOut: false, stdoutBytes: 0, stderrBytes: 0 });
  assert.ok(quickClock.scheduled.every(entry => entry.cleared));
});

test('an unfinished A run is reported with its reason code and a login notice', async t => {
  const { raw, account } = await sandbox(t);
  const config = await enabledConfig(raw);
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 10 * HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects,
    runner: async () => ({ code: null, timedOut: true, unfinished: true }) });
  assert.equal(report.accounts[0].result, 'fallback_a_unfinished');
  assert.equal(effects.record.notify.length, 1);
});

test('notice dedupe is keyed by action and reason and records only delivered notices', async t => {
  const { account, config } = await sandbox(t);
  const sent = [];
  let answer = 'failed-exec';
  const notify = async message => { sent.push(message); return { result: answer }; };
  const unknown = fakeExecute(account, { dump: () => '' });
  const pass = (offset, execute = unknown.execute) => runRefreshSupervisor({ config, apply: true,
    now: () => MDAT + offset, execute, env: SECRET_ENV, ...sideEffects(), notify });
  await pass(0);
  await pass(HOUR);
  assert.equal(sent.length, 2, 'a failed delivery is retried on the next pass');
  answer = 'exited-0';
  await pass(2 * HOUR);
  await pass(3 * HOUR);
  assert.equal(sent.length, 3);
  const saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8'));
  assert.deepEqual(Object.keys(saved.accounts[account.id].notified), ['notify_unknown:mdat_unknown']);
  // Same action, different reason: delivered separately.
  const otherUsers = fakeExecute(account, { lsof: () => ({ stdout: '5151\n' }) });
  await pass(4 * HOUR, otherUsers.execute);
  assert.equal(sent.length, 4);
});

test('malformed account state stops automatic action and is left unchanged', async t => {
  const { raw, account } = await sandbox(t);
  const config = await enabledConfig(raw);
  const bad = [
    { fallbackA: { attempts: 'x', lastAttemptMdat: null } },
    { fallbackA: { attempts: [-1], lastAttemptMdat: MDAT } },
    { fallbackA: { attempts: [MDAT], lastAttemptMdat: null } },
    { fallbackA: { attempts: [], lastAttemptMdat: MDAT } },
    { resident: { pid: 'x', startedAt: LSTART } },
    { notified: { 'notify_unknown:mdat_unknown': 'soon' } },
    { lastReason: 'unregistered_reason' },
    { unexpected: true },
    [],
  ];
  for (const entry of bad) {
    await writeState(config, { [account.id]: entry });
    const before = await readFile(refreshStatePath(config), 'utf8');
    const effects = sideEffects();
    const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + 10 * HOUR,
      execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects });
    assert.deepEqual([report.accounts[0].action, report.accounts[0].reason],
      ['notify_unknown', 'refresh_state_invalid'], JSON.stringify(entry));
    assert.equal(effects.record.launcher.length + effects.record.runner.length, 0);
    assert.equal(effects.record.notify.length, 1);
    assert.equal(await readFile(refreshStatePath(config), 'utf8'), before);
  }
});

test('stored ids that reach an object prototype are kept as plain keys', async t => {
  const { account, config } = await sandbox(t);
  await mkdir(config.stateDir, { recursive: true });
  await writeFile(refreshStatePath(config), `{"version":1,"accounts":{"__proto__":{"polluted":true}}}`);
  await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR, execute: fakeExecute(account).execute,
    env: SECRET_ENV, ...sideEffects(), launcher: async () => { throw new Error('x'); } });
  assert.equal({}.polluted, undefined);
  const saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8'));
  assert.ok(Object.hasOwn(saved.accounts, '__proto__'));
  assert.ok(Object.hasOwn(saved.accounts, account.id));
});

test('only registered reason codes leave the supervisor and the CLI', async t => {
  const { account, config, raw, root } = await sandbox(t);
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...effects,
    launcher: async () => { throw new Error('looks_like_a_code'); } });
  assert.equal(report.accounts[0].result, 'resident_launch_failed');
  assert.ok(!REASON_CODES.includes('looks_like_a_code'));
  const path = join(root, 'supervisor.json');
  await writeFile(path, JSON.stringify(raw));
  const output = [];
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path], {
    write: value => output.push(value), error: value => output.push(value),
    runRefreshSupervisor: async () => { throw new Error('looks_like_a_code'); } }), 1);
  assert.deepEqual(output, ['refresh_supervisor_failed\n']);
  output.length = 0;
  assert.equal(await runCli(['credential-swap', 'refresh-supervisor', '--config', path, '--apply'], {
    write: value => output.push(value), error: value => output.push(value),
    runRefreshSupervisor: async () => { throw new Error('refresh_supervisor_locked'); } }), 1);
  assert.deepEqual(output, ['refresh_supervisor_locked\n']);
});

test('a ps failure with a diagnostic is unknown, never absence, for both kinds of record', async t => {
  const { account, config } = await sandbox(t);
  const failing = fakeExecute(account, { ps: () => {
    throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: 'ps: not permitted' });
  } });
  for (const record of [{ resident: { pid: 4242, startedAt: LSTART } },
    { residentUnverified: { pid: 4242, startedAt: null, pendingSince: MDAT } }]) {
    await writeState(config, { [account.id]: record });
    const effects = sideEffects();
    const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
      execute: failing.execute, env: SECRET_ENV, ...effects });
    assert.notEqual(report.accounts[0].action, 'start_resident');
    assert.equal(report.accounts[0].action, 'notify_unknown');
    assert.equal(effects.record.launcher.length, 0);
    const saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8')).accounts[account.id];
    for (const [key, value] of Object.entries(record)) assert.deepEqual(saved[key], value);
    assert.equal(JSON.stringify(report).includes('not permitted'), false);
    assert.equal(JSON.stringify(saved).includes('not permitted'), false);
  }
  const killed = fakeExecute(account, { ps: () => {
    throw Object.assign(new Error('x'), { code: 1, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' });
  } });
  await writeState(config, { [account.id]: { resident: { pid: 4242, startedAt: LSTART } } });
  const report = await runRefreshSupervisor({ config, now: () => MDAT + HOUR, execute: killed.execute,
    env: SECRET_ENV, ...sideEffects() });
  assert.equal(report.accounts[0].observation.resident, 'unknown');
});

test('a launch is recorded before the launcher runs, and a pid-less record blocks relaunch', async t => {
  const { account, config } = await sandbox(t);
  const fake = fakeExecute(account, { ps: () => ({ stdout: `${LSTART} ${CLAUDE}\n` }) });
  let recordedBeforeLaunch;
  const effects = sideEffects();
  const launcher = async (plan, env) => {
    recordedBeforeLaunch = JSON.parse(await readFile(refreshStatePath(config), 'utf8'))
      .accounts[account.id].residentUnverified;
    return effects.launcher(plan, env);
  };
  const started = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR,
    execute: fake.execute, env: SECRET_ENV, ...effects, launcher });
  assert.equal(started.accounts[0].result, 'started');
  assert.deepEqual(recordedBeforeLaunch, { pid: null, startedAt: null, pendingSince: MDAT + HOUR });
  const saved = JSON.parse(await readFile(refreshStatePath(config), 'utf8')).accounts[account.id];
  assert.equal(saved.residentUnverified, null);
  assert.deepEqual(saved.resident, { pid: 4242, startedAt: LSTART });

  await writeState(config, { [account.id]: { residentUnverified: { pid: null, startedAt: null, pendingSince: MDAT } } });
  const blocked = sideEffects();
  for (const offset of [HOUR, 2 * HOUR]) {
    const report = await runRefreshSupervisor({ config, apply: true, now: () => MDAT + offset,
      execute: fakeExecute(account).execute, env: SECRET_ENV, ...blocked });
    assert.deepEqual([report.accounts[0].action, report.accounts[0].reason], ['notify_unknown', 'resident_unverified']);
  }
  assert.equal(blocked.record.launcher.length, 0);
  const kept = JSON.parse(await readFile(refreshStatePath(config), 'utf8')).accounts[account.id];
  assert.deepEqual(kept.residentUnverified, { pid: null, startedAt: null, pendingSince: MDAT });
});

test('a state write failing after a launch or an A run keeps the lock and stops later passes', async t => {
  const { raw, account, config } = await sandbox(t);
  const fake = fakeExecute(account, { ps: () => ({ stdout: `${LSTART} ${CLAUDE}\n` }) });
  let writes = 0;
  const failAfterFirst = async (...args) => {
    writes++;
    if (writes > 1) throw new Error('disk');
    const { writeJsonFileDurable } = await import('../src/json-file.js');
    return writeJsonFileDurable(...args);
  };
  const effects = sideEffects();
  await assert.rejects(runRefreshSupervisor({ config, apply: true, now: () => MDAT + HOUR, execute: fake.execute,
    env: SECRET_ENV, ...effects, writeState: failAfterFirst }), /^Error: refresh_state_write_failed$/);
  assert.equal(effects.record.launcher.length, 1);
  await stat(refreshLockPath(config));
  await assert.rejects(runRefreshSupervisor({ config, apply: true, now: () => MDAT + 2 * HOUR, execute: fake.execute,
    env: SECRET_ENV, ...effects }), /^Error: refresh_supervisor_locked$/);
  assert.equal(effects.record.launcher.length, 1);

  const enabled = await enabledConfig(raw);
  await rm(refreshLockPath(config));
  await rm(refreshStatePath(config));
  writes = 0;
  const ranA = sideEffects();
  await assert.rejects(runRefreshSupervisor({ config: enabled, apply: true, now: () => MDAT + 10 * HOUR,
    execute: fakeExecute(account).execute, env: SECRET_ENV, ...ranA, writeState: failAfterFirst }),
  /^Error: refresh_state_write_failed$/);
  assert.equal(ranA.record.runner.length, 1);
  await stat(refreshLockPath(config));
});

// Local time of LSTART; a session name created one second after the process started.
const LSTART_MS = new Date(2033, 4, 18, 3, 0, 0).getTime();

function sessionsIO(account, answer, { createdMs = LSTART_MS + 1000, lstat } = {}) {
  const io = { readdirCalls: [], readFileCalls: [], lstatCalls: [] };
  io.lstat = async path => {
    io.lstatCalls.push(path);
    if (lstat) return lstat(path);
    return { birthtimeMs: createdMs, mtimeMs: createdMs + 5000 };
  };
  io.readdir = async path => {
    io.readdirCalls.push(path);
    assert.equal(path, join(account.configDir, 'sessions'));
    if (answer instanceof Error) throw answer;
    return answer;
  };
  // Present only to prove the probe never opens a session file or key.
  io.readFile = async path => { io.readFileCalls.push(path); throw new Error('must not be read'); };
  return io;
}

const SESSION_NAMES = ['74132.json', '74132.0123abcd.key'];

async function sessionPass(t, { names = SESSION_NAMES, ps, offset = HOUR, enabled = false, lsof,
  claudeBin, created } = {}) {
  const { raw, account } = await sandbox(t);
  const base = claudeBin ? { refreshSupervisor: { ...raw.refreshSupervisor, claudeBin } } : raw;
  const config = enabled ? await enabledConfig(base) : normalizeRefreshSupervisor(base);
  const fake = fakeExecute(account, { ps, lsof });
  const io = sessionsIO(account, names, created);
  const effects = sideEffects();
  const report = await runRefreshSupervisor({ config, now: () => MDAT + offset, execute: fake.execute,
    sessionsIO: io, env: SECRET_ENV, ...effects });
  return { report, entry: report.accounts[0], io, fake, effects, account };
}

test('a live official client found by its session name is left to refresh by itself', async t => {
  const { report, entry, io, fake } = await sessionPass(t, { ps: pid => {
    assert.equal(pid, '74132');
    return { stdout: `${LSTART} claude\n` };
  } });
  assert.deepEqual([entry.action, entry.reason], ['none', 'external_client_present']);
  assert.equal(entry.observation.externalClient, true);
  assert.equal(entry.observation.otherUsers, 'present');
  assert.equal(io.readFileCalls.length, 0);
  assert.equal(io.readdirCalls.length, 1);
  // The key file name is never passed to any command.
  assert.equal(fake.calls.some(call => call.some(arg => /0123abcd|sessions/.test(String(arg)))), false);
  const text = JSON.stringify(report);
  for (const leaked of ['74132', '.json', '.key', 'claude', LSTART]) assert.equal(text.includes(leaked), false, leaked);
});

test('session clients match the claude command name, claudeBin or its version folder only', async t => {
  for (const command of [CLAUDE, `${CLAUDE} --resume`, '/opt/test-claude/bin/2.1.326']) {
    const { entry } = await sessionPass(t, { ps: () => ({ stdout: `${LSTART} ${command}\n` }) });
    assert.equal(entry.reason, 'external_client_present', command);
  }
  // A live process under a session name that cannot be identified is unknown, never absence.
  for (const command of ['/usr/bin/vim', '/opt/other/claude', 'claude-imposter']) {
    const { entry, effects } = await sessionPass(t, { ps: () => ({ stdout: `${LSTART} ${command}\n` }) });
    assert.deepEqual([entry.action, entry.reason], ['notify_unknown', 'other_users_unknown'], command);
    assert.equal(entry.observation.externalClient, false);
    assert.equal(effects.record.launcher.length, 0);
  }
  // A claudeBin path with spaces, followed by arguments.
  const spaced = '/opt/test claude/bin/claude';
  const { entry } = await sessionPass(t, { claudeBin: spaced,
    ps: () => ({ stdout: `${LSTART} ${spaced} --resume x\n` }) });
  assert.equal(entry.reason, 'external_client_present');
});

test('stale session names, unknown processes and unreadable session folders are handled', async t => {
  // ps says gone: the name is stale and nobody else is there.
  let result = await sessionPass(t);
  assert.deepEqual([result.entry.action, result.entry.reason], ['start_resident', 'resident_missing']);
  assert.equal(result.entry.observation.externalClient, false);
  // ps cannot tell: the whole answer is unknown.
  result = await sessionPass(t, { ps: () => { throw Object.assign(new Error('x'), { code: 2 }); } });
  assert.deepEqual([result.entry.action, result.entry.reason], ['notify_unknown', 'other_users_unknown']);
  assert.equal(result.entry.observation.otherUsers, 'unknown');
  // A session folder that exists but cannot be read is unknown; a missing one is no detection.
  result = await sessionPass(t, { names: Object.assign(new Error('denied'), { code: 'EACCES' }) });
  assert.equal(result.entry.observation.otherUsers, 'unknown');
  assert.equal(result.entry.action, 'notify_unknown');
  result = await sessionPass(t, { names: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
  assert.deepEqual([result.entry.action, result.entry.reason], ['start_resident', 'resident_missing']);
  // Only <pid>.json names are considered; others are never checked with ps.
  result = await sessionPass(t, { names: ['notes.json', '74132.0123abcd.key', 'x74132.json'],
    ps: () => { throw new Error('ps must not run'); } });
  assert.equal(result.entry.action, 'start_resident');
  // lsof alone (no session name) still notifies as before.
  result = await sessionPass(t, { names: [], lsof: () => ({ stdout: '5151\n' }) });
  assert.deepEqual([result.entry.action, result.entry.reason], ['notify_unknown', 'other_users_present']);
});

test('after staleness an external client still blocks A and gives a stale notice', async t => {
  const { entry, effects } = await sessionPass(t, { enabled: true, offset: 10 * HOUR,
    ps: () => ({ stdout: `${LSTART} claude\n` }) });
  assert.deepEqual([entry.action, entry.reason], ['notify_stale', 'other_users_present']);
  assert.equal(effects.record.runner.length, 0);
});

test('a session name older than the process start is a reused pid and is ignored', async t => {
  // Process started 121 s after the name was created: another process reused the pid.
  let result = await sessionPass(t, { created: { createdMs: LSTART_MS - 121_000 },
    ps: () => ({ stdout: `${LSTART} claude\n` }) });
  assert.deepEqual([result.entry.action, result.entry.reason], ['start_resident', 'resident_missing']);
  assert.equal(result.entry.observation.externalClient, false);
  // The same holds for a non-matching command: a reused pid is ignored before identification.
  result = await sessionPass(t, { created: { createdMs: LSTART_MS - 121_000 },
    ps: () => ({ stdout: `${LSTART} /usr/bin/vim\n` }) });
  assert.equal(result.entry.action, 'start_resident');
  // Within the slack it still counts; birthtime missing falls back to mtime.
  result = await sessionPass(t, { created: { createdMs: LSTART_MS - 119_000 },
    ps: () => ({ stdout: `${LSTART} claude\n` }) });
  assert.equal(result.entry.reason, 'external_client_present');
  result = await sessionPass(t, { created: { lstat: () => ({ birthtimeMs: 0, mtimeMs: LSTART_MS }) },
    ps: () => ({ stdout: `${LSTART} claude\n` }) });
  assert.equal(result.entry.reason, 'external_client_present');
  // An unparseable start time or unreadable metadata is unknown.
  result = await sessionPass(t, { ps: () => ({ stdout: 'Xyz Foo 99 99:99:99 2033 claude\n' }) });
  assert.equal(result.entry.observation.otherUsers, 'unknown');
  result = await sessionPass(t, { created: { lstat: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } },
    ps: () => ({ stdout: `${LSTART} claude\n` }) });
  assert.equal(result.entry.observation.otherUsers, 'unknown');
  assert.equal(parsePsStart(LSTART), LSTART_MS);
  assert.equal(parsePsStart('Wed Feb 30 03:00:00 2033'), null);
});

test('out-of-range session pids are ignored without ps, and too many names are unknown', async t => {
  const names = ['0.json', '1.json', '2147483648.json', '9999999999.json'];
  let result = await sessionPass(t, { names, ps: () => { throw new Error('ps must not run'); } });
  assert.deepEqual([result.entry.action, result.entry.reason], ['start_resident', 'resident_missing']);
  assert.equal(result.io.lstatCalls.length, 0);
  const many = Array.from({ length: 65 }, (_, index) => `${1000 + index}.json`);
  result = await sessionPass(t, { names: many, ps: () => { throw new Error('ps must not run'); } });
  assert.deepEqual([result.entry.action, result.entry.reason], ['notify_unknown', 'other_users_unknown']);
  result = await sessionPass(t, { names: many.slice(0, 64), ps: () => { throw Object.assign(new Error('x'),
    { code: 1, stdout: '' }); } });
  assert.equal(result.entry.action, 'start_resident');
});

test('an lsof pid outside the confirmed session clients still notifies', async t => {
  let result = await sessionPass(t, { ps: () => ({ stdout: `${LSTART} claude\n` }),
    lsof: () => ({ stdout: '74132\n5151\n' }) });
  assert.deepEqual([result.entry.action, result.entry.reason], ['notify_unknown', 'other_users_present']);
  assert.equal(result.entry.observation.externalClient, true);
  result = await sessionPass(t, { ps: () => ({ stdout: `${LSTART} claude\n` }),
    lsof: () => ({ stdout: '74132\n' }) });
  assert.deepEqual([result.entry.action, result.entry.reason], ['none', 'external_client_present']);
  for (const leaked of ['74132', '5151', '.json', '.key', 'claude']) {
    assert.equal(JSON.stringify(result.report).includes(leaked), false, leaked);
  }
  assert.equal(result.io.readFileCalls.length, 0);
});
