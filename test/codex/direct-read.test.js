// 常駐が無いときの直接読取（src/codex/direct-read.js）のテスト。時間の約束（全体の期限・常駐への問い合わせの
// 期限・版の読取は常駐が使える値を返さなかった後にだけ始めること）と、1回の読取の結果を口座の状態へ当てる規則を
// 確かめる。
//
// 隔離: env と要求関数は隔離の補助（helpers/isolation.js）のものを使う。設定は合成の値をそのまま渡し、
// ファイルを読まない。資格情報の読取・使用量の読取・本物の codex を探す処理は偽物に替え、版の読取は偽の
// spawn だけを通す（本物の codex は起動しない）。時計とスケジューラは偽物で、偽の時計を進めて確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { CODEX_VERSION_READ_TIMEOUT_MS } from '../../src/codex/client-version.js';
import { CODEX_CONFIG_DEFAULTS, DEFAULT_DAEMON_PORT } from '../../src/codex/config.js';
import { STATUS_DAEMON_TIMEOUT_MS, readCodexStatus, runStatus } from '../../src/codex/direct-read.js';
import { createCodexPool, projectCodexStatus } from '../../src/codex/snapshot.js';
import {
  CODEX_CHILD_TIMEOUT_MS, CODEX_DIRECT_READ_CONCURRENCY, CODEX_SECTION_DEADLINE_MS, codexStatusProblem,
} from '../../src/shared/codex-status-schema.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from './helpers/isolation.js';

const START = Date.UTC(2027, 0, 15, 8, 0, 0);
// 偽の codex の場所（起動されない。探す処理と spawn は偽物）。
const CODEX_PATH = '/zz-fake-bin/codex';
const FAKE_VERSION = [9, 8, 7].join('.');
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };

// 検証済みの設定と同じ形の合成の設定。
function configOf(labels, overrides = {}) {
  return {
    enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: '/zz-accounts', daemon: { port: DEFAULT_DAEMON_PORT },
    usagePollIntervalMs: 60000, usageReadTimeoutMs: CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs,
    rotationObservationTtlMs: 125000, rotationUsageCapNoResetProbeMs: 3600000,
    codexPath: CODEX_PATH, usageUserAgent: null, usageOriginator: null,
    accounts: labels.map(label => ({ label, codexHome: `/zz-accounts/${label}`, usagePolicy: { ...POLICY } })),
    ...overrides,
  };
}
const overrideIdentity = { usageUserAgent: 'zz-fake-ua', usageOriginator: 'zz-fake-originator' };
const labelOfPath = path => path.split('/').at(-2);

// 偽の資格情報の読取。label ごとに 'ok'・'expired'・'unreadable' を返す。
function credentialsReader(kinds = {}) {
  const calls = [];
  const read = async path => {
    const label = labelOfPath(path);
    calls.push(label);
    const kind = kinds[label] ?? 'ok';
    if (kind === 'expired') throw new Error('send credentials expired');
    if (kind === 'unreadable') throw new Error('zz-fake-unreadable');
    return { accountId: `zz-account-id-${label}`, accessToken: 'zz-fake-access-token' };
  };
  return { read, calls };
}

function windowOf(used, seconds, at, resetIn) {
  return { usedPercent: used, windowResetAt: at + resetIn * 1000, resetAfterSeconds: resetIn, limitWindowSeconds: seconds,
    complete: true, incompleteReason: null };
}

// 使用量の読取の結果（usage.js の readCodexUsage の戻り値の形）。
function usageResult({ primary = 10, secondary = 20, allowed = true, at = START, complete = true } = {}) {
  return { classification: 'success', status: 200, receivedAt: at, failure: null, errorCode: null, retryAfter: null,
    observation: { ordinaryUsageAllowed: allowed, rateLimitReachedType: null, complete,
      primary: windowOf(primary, 18000, at, 3600), secondary: windowOf(secondary, 604800, at, 86400) } };
}
const httpError = status => ({ classification: 'http-error', failure: status === 401 ? 'unauthorized' : 'forbidden',
  status, receivedAt: START, errorCode: null, retryAfter: null });

// 偽の使用量の読取。respond(label, call) の戻り値（結果か Promise）を返す。呼出しは calls に残す。
function usageReader(respond) {
  const calls = [];
  const read = options => {
    const call = { label: options.credentials.accountId.replace(/^zz-account-id-/, ''), timeoutMs: options.timeoutMs };
    calls.push(call);
    return respond(call.label, call);
  };
  return { read, calls };
}

// 偽の時計で ms の後に結果を返す読取（null なら返さない）。
const after = (scheduler, ms, result) => new Promise(resolve => {
  if (ms !== null) scheduler.setTimeout(() => resolve(result), ms);
});

// 偽の codex の `--version` の子。afterMs の後に版を出して閉じる（null なら何も出さない）。
function versionSpawn(scheduler, { afterMs }) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    calls.push({ command, args, options, child });
    if (afterMs !== null) {
      scheduler.setTimeout(() => {
        child.stdout.emit('data', Buffer.from(`codex-cli ${FAKE_VERSION}\n`));
        child.emit('close', 0, null);
      }, afterMs);
    }
    return child;
  };
  return { spawn, calls };
}

// 受け付けて何も返さない要求関数（常駐が応えない）。
function stallingRequest() {
  const calls = [];
  const request = url => {
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => { req.destroyed = true; return req; };
    calls.push(String(url));
    return req;
  };
  return { request, calls };
}

function captureStream(clock) {
  const chunks = [];
  return { chunks, writtenAt: null, write(chunk) { chunks.push(String(chunk)); this.writtenAt = clock?.now() ?? null; return true; },
    text() { return chunks.join(''); } };
}

// 偽の時計の上で `codex-rotator status --json --section` を始める（終わりは返り値の done を待つ）。
// build(scheduler) が差し替えの部品 { config, request, spawn, readUsage, readCredentials } を返す。
async function startSection(t, build) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const { config, request, spawn, readUsage, readCredentials } = build(scheduler);
  const stdout = captureStream(clock);
  const stderr = captureStream(clock);
  const done = runStatus(['--json', '--section'], { stdout, stderr, env: isolation.env }, {
    now: clock.now, scheduler, request: request ?? isolation.request,
    loadConfigSnapshot: async () => ({ config, sha256: 'f'.repeat(64) }), findCodex: () => ({ path: CODEX_PATH }),
    spawn: spawn ?? isolation.spawn, readCredentials: readCredentials ?? credentialsReader().read, readUsage,
  });
  return { isolation, clock, scheduler, stdout, stderr, done };
}

const parsed = stream => {
  const json = JSON.parse(stream.text());
  assert.equal(codexStatusProblem(json), null, 'the output passes the schema check');
  return json;
};
const byLabel = json => Object.fromEntries(json.accounts.map(account => [account.label, account]));

// --- 時間の約束 -----------------------------------------------------------------------------------

test('time budget: the constants keep the child inside its deadline and the parent waits longer than the child', () => {
  assert.equal(STATUS_DAEMON_TIMEOUT_MS, 1000);
  assert.ok(CODEX_CHILD_TIMEOUT_MS >= CODEX_SECTION_DEADLINE_MS + 1500);
  assert.ok(CODEX_SECTION_DEADLINE_MS >= STATUS_DAEMON_TIMEOUT_MS + CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs);
  assert.ok(CODEX_SECTION_DEADLINE_MS
    >= Math.max(STATUS_DAEMON_TIMEOUT_MS, CODEX_VERSION_READ_TIMEOUT_MS) + CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs);
  assert.equal(CODEX_DIRECT_READ_CONCURRENCY, 4);
});

test('time budget: a daemon that accepts and never answers is given up at 1000 ms, then the accounts are read directly', async t => {
  const stall = stallingRequest();
  const credentials = credentialsReader();
  const usage = usageReader(() => usageResult());
  const run = await startSection(t, () => ({ config: configOf(['zz-a'], overrideIdentity), request: stall.request,
    readCredentials: credentials.read, readUsage: usage.read }));
  await flush();
  assert.equal(stall.calls.length, 1, 'the daemon is asked once');
  run.clock.advance(STATUS_DAEMON_TIMEOUT_MS - 1);
  await flush();
  assert.equal(credentials.calls.length, 0, 'nothing is read directly before the daemon query runs out');
  run.clock.advance(1);
  await flush();
  assert.equal(await run.done, 0);
  const json = parsed(run.stdout);
  assert.equal(json.source, 'direct');
  assert.equal(json.latchKnown, false);
  assert.equal(json.accounts[0].stateWord, 'ready');
  assert.equal(run.stdout.writtenAt, START + STATUS_DAEMON_TIMEOUT_MS);
});

test('time budget: after a silent daemon, a read that returns 1 ms before the deadline is in the JSON written in time', async t => {
  const stall = stallingRequest();
  let usage;
  const run = await startSection(t, scheduler => {
    usage = usageReader(() => after(scheduler, CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS - 1,
      usageResult({ at: START + CODEX_SECTION_DEADLINE_MS - 1 })));
    return { config: configOf(['zz-a'], overrideIdentity), request: stall.request, readUsage: usage.read };
  });
  await flush();
  run.clock.advance(STATUS_DAEMON_TIMEOUT_MS);
  await flush();
  assert.equal(usage.calls.length, 1);
  assert.equal(usage.calls[0].timeoutMs, CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS,
    'one read never waits past what is left of the deadline');
  run.clock.advance(CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS - 1);
  await flush();
  assert.equal(await run.done, 0);
  assert.equal(run.stdout.writtenAt, START + CODEX_SECTION_DEADLINE_MS - 1, 'the JSON is written before the deadline');
  const account = parsed(run.stdout).accounts[0];
  assert.equal(account.stateWord, 'ready');
  assert.equal(account.reason, null);
});

test('time budget: eight slow accounts are cut at the deadline as unread (read-deadline), four reads at a time', async t => {
  const labels = ['zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-f', 'zz-g', 'zz-h'];
  const config = configOf(labels, overrideIdentity);
  config.accounts[7].usagePolicy.blockWhenUnknown = true;
  const usage = usageReader(() => new Promise(() => {}));
  const run = await startSection(t, () => ({ config, readUsage: usage.read }));
  await flush();
  assert.equal(usage.calls.length, CODEX_DIRECT_READ_CONCURRENCY, 'at most four reads are in flight');
  assert.ok(usage.calls.every(call => call.timeoutMs === CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs));
  run.clock.advance(CODEX_SECTION_DEADLINE_MS - 1);
  await flush();
  assert.equal(run.stdout.chunks.length, 0, 'nothing is written before the deadline');
  run.clock.advance(1);
  await flush();
  assert.equal(await run.done, 0);
  assert.equal(run.stdout.writtenAt, START + CODEX_SECTION_DEADLINE_MS);
  const json = parsed(run.stdout);
  assert.equal(json.accounts.length, 8);
  for (const account of json.accounts.slice(0, 7)) {
    assert.deepEqual([account.stateWord, account.reason], ['unread', 'read-deadline'], account.label);
  }
  assert.deepEqual([json.accounts[7].stateWord, json.accounts[7].reason], ['reserved', 'read-deadline']);
  assert.equal(usage.calls.length, CODEX_DIRECT_READ_CONCURRENCY, 'no read is started after the deadline');
});

test('time budget: after a daemon that accepts and never answers, the version read starts once at 1000 ms, through the injected spawn only, and the JSON is in time', async t => {
  const stall = stallingRequest();
  let version;
  const usage = usageReader(() => usageResult());
  const run = await startSection(t, scheduler => {
    version = versionSpawn(scheduler, { afterMs: CODEX_VERSION_READ_TIMEOUT_MS - 1 });
    return { config: configOf(['zz-a']), request: stall.request, spawn: version.spawn, readUsage: usage.read };
  });
  await flush();
  assert.equal(stall.calls.length, 1, 'the daemon is being asked');
  run.clock.advance(STATUS_DAEMON_TIMEOUT_MS - 1);
  await flush();
  assert.equal(version.calls.length, 0, 'no version read while the daemon may still answer');
  run.clock.advance(1);
  await flush();
  assert.equal(version.calls.length, 1, 'the version read starts once the daemon query has run out');
  assert.deepEqual(version.calls[0].args, ['--version']);
  assert.equal(version.calls[0].command, CODEX_PATH);
  assert.equal(version.calls[0].options.shell, false);
  run.clock.advance(CODEX_VERSION_READ_TIMEOUT_MS - 1);
  await flush();
  assert.equal(usage.calls.length, 1);
  assert.equal(usage.calls[0].timeoutMs,
    CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS - (CODEX_VERSION_READ_TIMEOUT_MS - 1),
    'the usage read is given only what is left of the deadline');
  assert.equal(await run.done, 0);
  assert.ok(run.stdout.writtenAt <= START + CODEX_SECTION_DEADLINE_MS, 'the JSON is written within the deadline');
  const json = parsed(run.stdout);
  assert.equal(json.accounts[0].stateWord, 'ready');
  assert.equal(json.observation.userAgentSource, 'codex-version');
  assert.equal(version.calls.length, 1, 'the version is read once');
  assert.deepEqual(run.isolation.refusedChildProcesses, [], 'no real child process was asked for');
  assert.deepEqual(run.isolation.refusedSpawns, []);
});

test('time budget: a version read that returns 1 ms before its own deadline leaves the JSON in time', async t => {
  let version;
  let usage;
  const run = await startSection(t, scheduler => {
    version = versionSpawn(scheduler, { afterMs: CODEX_VERSION_READ_TIMEOUT_MS - 1 });
    usage = usageReader(() => after(scheduler, CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs - 1, usageResult()));
    return { config: configOf(['zz-a']), spawn: version.spawn, readUsage: usage.read };
  });
  await flush();
  run.clock.advance(CODEX_VERSION_READ_TIMEOUT_MS - 1);
  await flush();
  assert.equal(usage.calls.length, 1, 'the usage read is sent once the version is known');
  run.clock.advance(CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs - 1);
  await flush();
  assert.equal(await run.done, 0);
  assert.ok(run.stdout.writtenAt < START + CODEX_SECTION_DEADLINE_MS);
  const json = parsed(run.stdout);
  assert.equal(json.accounts[0].stateWord, 'ready');
  assert.equal(json.observation.userAgentSource, 'codex-version');
  assert.equal(version.calls.length, 1);
});

test('time budget: a version read that runs out leaves every account unread (reserved when it blocks) without a usage read', async t => {
  let version;
  const config = configOf(['zz-a', 'zz-b']);
  config.accounts[1].usagePolicy.blockWhenUnknown = true;
  const usage = usageReader(() => usageResult());
  const run = await startSection(t, scheduler => {
    version = versionSpawn(scheduler, { afterMs: null });
    return { config, spawn: version.spawn, readUsage: usage.read };
  });
  await flush();
  run.clock.advance(CODEX_VERSION_READ_TIMEOUT_MS);
  await flush();
  assert.equal(await run.done, 0);
  assert.ok(run.stdout.writtenAt < START + CODEX_SECTION_DEADLINE_MS);
  const json = parsed(run.stdout);
  assert.deepEqual(json.accounts.map(account => [account.stateWord, account.reason]),
    [['unread', 'codex-version-unreadable'], ['reserved', 'codex-version-unreadable']]);
  assert.equal(json.observation.userAgentSource, null);
  assert.equal(usage.calls.length, 0, 'no usage read is sent without a User-Agent');
  assert.equal(version.calls[0].child.kills.length, 1, 'the stalled version read is stopped');
});

// --- 1回の読取の当て方 ------------------------------------------------------------------------------

// 偽の時計を使わずに、すぐ返る偽物で直接読取を1回行う。
async function readOnce(t, { labels, config, kinds, respond, findCodex = () => ({ path: CODEX_PATH }), spawn }) {
  const isolation = await setupCodexIsolation(t);
  const credentials = credentialsReader(kinds);
  const usage = usageReader(respond ?? (() => usageResult()));
  const json = await readCodexStatus({ config: config ?? configOf(labels, overrideIdentity), env: isolation.env,
    deps: { now: () => START, request: isolation.request, findCodex, spawn: spawn ?? isolation.spawn,
      readCredentials: credentials.read, readUsage: usage.read } });
  assert.equal(codexStatusProblem(json), null);
  return { json, usage, credentials, isolation };
}

test('direct read: each kind of single read lands on the state word and reason the status table names', async t => {
  const kinds = { 'zz-expired': 'expired', 'zz-nocreds': 'unreadable' };
  const respond = label => ({
    'zz-ok': usageResult(),
    'zz-unauth': httpError(401),
    'zz-held': usageResult({ primary: 80 }),
    'zz-blocked': usageResult({ allowed: false }),
    'zz-partial': usageResult({ complete: false }),
  })[label] ?? usageResult();
  const { json, usage } = await readOnce(t, {
    labels: ['zz-ok', 'zz-expired', 'zz-nocreds', 'zz-unauth', 'zz-held', 'zz-blocked', 'zz-partial'], kinds, respond });
  const accounts = byLabel(json);
  const row = label => [accounts[label].stateWord, accounts[label].reason];
  assert.deepEqual(row('zz-ok'), ['ready', null]);
  assert.deepEqual(row('zz-expired'), ['needs login', 'access-token-expired']);
  assert.deepEqual(row('zz-nocreds'), ['no creds', 'credentials-unavailable']);
  assert.deepEqual(row('zz-unauth'), ['needs login', 'upstream-unauthorized']);
  assert.deepEqual(row('zz-held'), ['held', 'usage-capped']);
  assert.deepEqual(row('zz-blocked'), ['blocked', 'upstream-blocked']);
  assert.deepEqual(row('zz-partial'), ['unread', 'usage-unknown']);
  assert.equal(accounts['zz-partial'].windows.fiveHour.usedPercent, 10, 'an incomplete reading still shows its windows');
  assert.equal(accounts['zz-held'].headroomPercent, 0, 'without the daemon a window over the stop line counts as 0');
  assert.equal(accounts['zz-ok'].headroomPercent, null, 'without the daemon the headroom is unknown');
  assert.deepEqual(usage.calls.map(call => call.label).sort(),
    ['zz-blocked', 'zz-held', 'zz-ok', 'zz-partial', 'zz-unauth'], 'no read is sent for unreadable or expired credentials');
  assert.equal(json.source, 'direct');
  assert.equal(json.latchKnown, false);
  assert.deepEqual(json.daemon, { reachable: false, startedAt: null });
  assert.equal(json.observation.startupCheck, null, 'there is no daemon start-up check to report');
  assert.equal(json.observation.userAgentSource, 'config');
  assert.deepEqual(json.accounts.map(account => account.nextObservationAt), json.accounts.map(() => null));
  assert.deepEqual(json.events, []);
});

test('direct read: a 403 means needs login only when another account was read in the same pass', async t => {
  const alone = await readOnce(t, { labels: ['zz-a'], respond: () => httpError(403) });
  assert.deepEqual([alone.json.accounts[0].stateWord, alone.json.accounts[0].reason], ['unread', 'usage-unknown']);
  await alone.isolation.cleanup();
  const withOther = await readOnce(t, { labels: ['zz-a', 'zz-b'], respond: label => (label === 'zz-a' ? httpError(403) : usageResult()) });
  assert.deepEqual([withOther.json.accounts[0].stateWord, withOther.json.accounts[0].reason], ['needs login', 'upstream-forbidden']);
  await withOther.isolation.cleanup();
  const bothRefused = await readOnce(t, { labels: ['zz-a', 'zz-b'], respond: () => httpError(403) });
  assert.deepEqual(bothRefused.json.accounts.map(account => account.stateWord), ['unread', 'unread']);
});

test('direct read: without a codex CLI every account is unread (codex-cli-missing) and nothing is spawned', async t => {
  const config = configOf(['zz-a', 'zz-b'], { codexPath: null });
  config.accounts[1].usagePolicy.blockWhenUnknown = true;
  const spawned = [];
  const { json, usage } = await readOnce(t, { config, findCodex: () => ({ path: null }),
    spawn: (...args) => { spawned.push(args); throw new Error('zz-no-spawn'); } });
  assert.deepEqual(json.accounts.map(account => [account.stateWord, account.reason]),
    [['unread', 'codex-cli-missing'], ['reserved', 'codex-cli-missing']]);
  assert.equal(json.observation.userAgentSource, null);
  assert.equal(usage.calls.length, 0);
  assert.equal(spawned.length, 0);
});

test('direct read: the User-Agent source is null when no usage read was sent at all', async t => {
  const { json } = await readOnce(t, { labels: ['zz-a'], kinds: { 'zz-a': 'unreadable' } });
  assert.equal(json.observation.userAgentSource, null);
});

// --- 常駐の答え ---------------------------------------------------------------------------------

// ポート0で待ち受け、GET /internal/status に reply() の { status, body } で答える偽の常駐。
async function fakeDaemon(t, isolation, reply) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const requests = [];
    const server = createHttpServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      const { status = 200, body } = reply();
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const close = () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    const { port } = server.address();
    if (REAL_SERVICE_PORTS.includes(port) || port === 18765) {
      await close();
      continue;
    }
    t.after(close);
    isolation.allowRequest(port);
    return { port, requests };
  }
  throw new Error('the system kept assigning a port that must not be used');
}

function daemonStatus() {
  const pool = createCodexPool([{ key: 'zz-key-a', label: 'zz-a' }], { accounts: [{ label: 'zz-a', usagePolicy: POLICY }] });
  return projectCodexStatus({ enabled: true, pool, daemon: { reachable: true, startedAt: START - 60000 }, source: 'daemon',
    nowMs: START });
}

test('daemon: an answer that passes the schema is used as it is; anything else falls back to the direct read', async t => {
  const cases = [
    { name: 'valid', reply: () => ({ body: daemonStatus() }), source: 'daemon' },
    { name: 'schema', reply: () => ({ body: { ...daemonStatus(), zzExtra: 1 } }), source: 'direct' },
    { name: 'not json', reply: () => ({ body: '{"schemaVersion":' }), source: 'direct' },
    { name: 'http 500', reply: () => ({ status: 500, body: { error: 'internal-error' } }), source: 'direct' },
    { name: 'direct source', reply: () => ({ body: { ...daemonStatus(), source: 'direct', latchKnown: false } }), source: 'direct' },
  ];
  for (const { name, reply, source } of cases) {
    const isolation = await setupCodexIsolation(t);
    const daemon = await fakeDaemon(t, isolation, reply);
    const usage = usageReader(() => usageResult());
    const json = await readCodexStatus({ config: configOf(['zz-a'], { ...overrideIdentity, daemon: { port: daemon.port } }),
      env: isolation.env, deps: { now: () => START, request: isolation.request, findCodex: () => ({ path: CODEX_PATH }),
        spawn: isolation.spawn, readCredentials: credentialsReader().read, readUsage: usage.read } });
    assert.equal(json.source, source, name);
    assert.deepEqual(daemon.requests, [{ method: 'GET', url: '/internal/status' }], name);
    if (source === 'daemon') {
      assert.deepEqual(json, daemonStatus(), `${name}: the daemon's JSON is passed on unchanged`);
      assert.equal(usage.calls.length, 0, `${name}: nothing is read directly`);
    } else {
      assert.equal(usage.calls.length, 1, name);
    }
    await isolation.cleanup();
  }
});

test('daemon: a usable answer from the daemon starts no version read at all; an unusable one starts exactly one', async t => {
  const cases = [
    { name: 'valid', reply: () => ({ body: daemonStatus() }), source: 'daemon', versionReads: 0 },
    { name: 'http 500', reply: () => ({ status: 500, body: { error: 'internal-error' } }), source: 'direct', versionReads: 1 },
  ];
  for (const { name, reply, source, versionReads } of cases) {
    const isolation = await setupCodexIsolation(t);
    const daemon = await fakeDaemon(t, isolation, reply);
    const versionCalls = [];
    const readVersion = async path => { versionCalls.push(path); return FAKE_VERSION; };
    // User-Agent の上書きの組を書かない設定（常駐が答えなければ版を読む設定）。
    const json = await readCodexStatus({ config: configOf(['zz-a'], { daemon: { port: daemon.port } }), env: isolation.env,
      deps: { now: () => START, request: isolation.request, findCodex: () => ({ path: CODEX_PATH }), spawn: isolation.spawn,
        readVersion, readCredentials: credentialsReader().read, readUsage: usageReader(() => usageResult()).read } });
    assert.equal(json.source, source, name);
    assert.deepEqual(versionCalls, Array(versionReads).fill(CODEX_PATH), name);
    assert.deepEqual(isolation.spawnCalls, [], `${name}: nothing is spawned`);
    await isolation.cleanup();
  }
});
