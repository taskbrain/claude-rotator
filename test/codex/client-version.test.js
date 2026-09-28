// User-Agent と originator の実行時の組立（src/codex/client-version.js）と、取得処理
// （src/codex/usage-poller.js）の既定のつなぎのテスト。
//
// 実物の codex は起動しない。子プロセスの起動は、テストの隔離（helpers/isolation.js）の deps.spawn に
// 偽の子を登録して差し替える（登録していない名前・パスの起動は隔離が拒否する）。置く実行ファイルは
// 起動されない合成の台本で、stat とパスの決め方のためだけにある。上流は fetchImpl に渡す偽物だけ。
//
// 期待値の User-Agent と originator は、許した2つの定数を import して組み立て、値を直書きしない。
// 版は数を連結して作る（版だけの文字列リテラルを書かない）。値が画面に出ないように、User-Agent と
// originator を比べるところは assert.ok と説明文だけで判定する（失敗しても値を表示しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, rename, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';
import {
  CLIENT_IDENTITY_LOG_EVENT, CLIENT_IDENTITY_REASON, CODEX_UA_COMMENT, CODEX_UA_PRODUCT,
  CODEX_VERSION_MAX_STDOUT_BYTES, CODEX_VERSION_READ_TIMEOUT_MS, USER_AGENT_SOURCE, composeClientIdentity,
  createClientIdentityResolver, parseCodexVersion, readCodexVersion,
} from '../../src/codex/client-version.js';
import { USAGE_USER_AGENT_MAX_LENGTH, isValidUsageOriginator, isValidUsageUserAgent } from '../../src/codex/config.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { shimDir } from '../../src/codex/paths.js';
import { CODEX_PATH_POINTS_TO_SHIM, CODEX_SHIM_MARKER } from '../../src/codex/real-codex.js';
import { createUsagePoller } from '../../src/codex/usage-poller.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };
const MISSING = CLIENT_IDENTITY_REASON.cliMissing;
const UNREADABLE = CLIENT_IDENTITY_REASON.versionUnreadable;
// 版は数を連結して作る。
const version = (...parts) => parts.join('.');
const VERSION = version(0, 0, 7);
const OTHER_VERSION = version(0, 0, 8);
// 偽の版の出力。1語目は zz-fake- で始まる製品名（組み立てには使われないはずの語）。
const FAKE_PRODUCT_WORD = 'zz-fake-codex-cli';
const versionLine = (value = VERSION) => `${FAKE_PRODUCT_WORD} ${value}\n`;
const expectedUserAgent = value => `${CODEX_UA_PRODUCT}/${value} (${CODEX_UA_COMMENT})`;
// 合成の目印（標準出力の2行目・標準エラー・起動エラーのメッセージ）。
const MARKERS = Object.freeze({ stdout: 'ZZ-STDOUT-MARKER', stderr: 'ZZ-STDERR-MARKER', spawnError: 'ZZ-SPAWNERR-MARKER' });
// 設定で与える上書き（合成の値）。
const CONFIG_USER_AGENT = 'zz-fake-config-agent (zz-fake-config-comment)';
const CONFIG_ORIGINATOR = 'zz-fake-config-originator';
const REAL_BODY = '#!/bin/sh\n# zz-fake codex for tests (never executed)\n';
const SPAWN_OPTIONS = Object.freeze({ shell: false, stdio: ['ignore', 'pipe', 'ignore'] });

// 値を表示しない比較（失敗したときに説明文だけが出る）。
function same(actual, expected, message) {
  assert.ok(actual === expected, message);
}

/**
 * 偽の子プロセス。次の順に出来事を起こす: 標準エラーの data → （error なら error で終わり）→ 標準出力の
 * data → close(code, signal)。hang なら close を起こさない。kill は記録し、止まった子として close を起こす。
 */
function fakeChild({ stdout = [versionLine()], stderr = [], code = 0, signal = null, error = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = sig => {
    child.kills.push(sig);
    setImmediate(() => child.emit('close', null, sig));
    return true;
  };
  setImmediate(() => {
    for (const text of stderr) child.stderr.emit('data', Buffer.from(text));
    if (error) {
      child.emit('error', error);
      return;
    }
    for (const text of stdout) child.stdout.emit('data', Buffer.from(text));
    if (!hang) child.emit('close', code, signal);
  });
  return child;
}

async function placeExecutable(dir, { body = REAL_BODY, name = 'codex' } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

// 隔離・偽の時計・PATH に置いた偽の codex・起動の差し替え・秘密の登録の記録。
async function base(t) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const binDir = join(isolation.root, 'zz-bin');
  const codex = await placeExecutable(binDir);
  const env = { ...isolation.env, PATH: binDir };
  const children = [];
  let behave = () => fakeChild();
  const register = (path, handler) => isolation.registerSpawn(path, (args, options) => {
    const child = handler(args, options);
    children.push(child);
    return child;
  });
  register(codex, (...args) => behave(...args));
  const secrets = [];
  return {
    isolation, clock, scheduler, binDir, codex, env, children, secrets, register,
    registerSecret: value => { secrets.push(value); },
    setBehavior: next => { behave = next; },
    spawnsOf: path => isolation.spawnCalls.filter(call => call.command === path).length,
    async tick(ms = 0) { clock.advance(ms); await flush(); },
  };
}

// 部品を直接呼ぶ形。戻り値・例外・ログをすべて集める。
async function resolverFixture(t, { config = null, env } = {}) {
  const b = await base(t);
  const logs = [];
  const results = [];
  const errors = [];
  const resolver = createClientIdentityResolver({ env: env ?? b.env, config, registerSecret: b.registerSecret,
    spawn: b.isolation.spawn, now: b.clock.now, scheduler: b.scheduler,
    log: (level, event, fields) => logs.push({ level, event, fields }) });
  return { ...b, resolver, logs, results, errors,
    async resolve() {
      try {
        const pendingResult = resolver.resolveClientIdentity();
        await flush();
        const result = await pendingResult;
        results.push(result);
        return result;
      } catch (error) {
        errors.push(error);
        throw error;
      }
    } };
}

/** 使用量の応答の形（両窓・allowed・reset_at・limit_window_seconds）。 */
function usageResponse(clock) {
  const resetAt = Math.floor(clock.now() / 1000) + 3600;
  const window = (usedPercent, limitWindowSeconds) => ({ used_percent: usedPercent, reset_at: resetAt,
    reset_after_seconds: 3600, limit_window_seconds: limitWindowSeconds });
  return new Response(JSON.stringify({ rate_limit: { allowed: true, primary_window: window(10, 18000),
    secondary_window: window(5, 604800) } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// 取得処理を、既定のつなぎ（resolveClientIdentity を渡さない）で作る形。ログは本物のロガーを通す。
async function pollerFixture(t, { accounts = 1, config = {} } = {}) {
  const b = await base(t);
  const entries = Array.from({ length: accounts }, (_, i) =>
    ({ key: `home:${i}`, home: join(b.isolation.root, 'accounts', `zz-home-${i}`), label: `zz-${i}`, models: null }));
  const settings = { usageObservationMode: 'http', usagePollIntervalMs: 60000, usageReadTimeoutMs: 5000,
    rotationObservationTtlMs: 150000, codexPath: null, usageUserAgent: null, usageOriginator: null,
    accounts: entries.map(entry => ({ label: entry.label, usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 } })),
    ...config };
  const pool = createCodexAccountPool(entries, settings);
  for (const entry of entries) pool.credentials(entry.key, true, b.clock.now());
  const records = [];
  const logger = createCodexLogger({ level: 'debug', write: line => records.push(line) });
  const logs = [];
  const fetchCalls = [];
  const poller = createUsagePoller({ pool, env: b.env, spawn: b.isolation.spawn,
    registerSecret: value => { b.secrets.push(value); logger.registerSecret(value); },
    now: b.clock.now, scheduler: b.scheduler, credentialEpoch: () => 1,
    log: (level, event, fields) => { logs.push({ level, event, fields }); logger[level](event, fields); },
    readCredentials: async authPath => ({ accessToken: 'e30.e30.sig', accountId: basename(dirname(authPath)) }),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, headers: init.headers });
      return usageResponse(b.clock);
    } });
  return { ...b, entries, settings, pool, poller, records, logs, fetchCalls,
    identityLogs: () => logs.filter(line => line.event === CLIENT_IDENTITY_LOG_EVENT),
    view: key => pool.inspect(b.clock.now()).find(account => account.key === key),
    async start(next = settings) { poller.configure(entries, next); await flush(); } };
}

// --- 組立と版の取り出し ---

test('client version: the User-Agent is the product constant, the version read and the comment constant', () => {
  const identity = composeClientIdentity(VERSION);
  assert.ok(identity !== null, 'a plain version composes');
  same(identity.userAgent, expectedUserAgent(VERSION), 'the User-Agent follows <product>/<version> (<comment>)');
  same(identity.originator, CODEX_UA_PRODUCT, 'the originator is the product constant');
  assert.equal(CODEX_UA_COMMENT, 'codex-rotator');
  assert.ok(isValidUsageUserAgent(identity.userAgent) && isValidUsageOriginator(identity.originator),
    'both values pass the same checks as the configured values');
  assert.deepEqual(Object.keys(identity).sort(), ['originator', 'userAgent']);
  for (const bad of [undefined, null, '', 'zz', version(1, 2), `${VERSION} `, `v${VERSION}`, `${VERSION}-`,
    `${VERSION}-a+b`, `${VERSION}\n`]) {
    assert.equal(composeClientIdentity(bad), null, `not a version: ${JSON.stringify(bad)}`);
  }
});

test('client version: a composed value that fails the configured-value checks is refused', () => {
  const baseLength = expectedUserAgent(VERSION).length;
  const withSuffix = length => `${VERSION}-${'a'.repeat(length)}`;
  // 256文字ちょうどは通り、257文字は通らない（設定の usageUserAgent と同じ上限）。
  const fits = composeClientIdentity(withSuffix(USAGE_USER_AGENT_MAX_LENGTH - baseLength - 1));
  assert.ok(fits !== null, 'a User-Agent of exactly the maximum length passes');
  assert.equal(fits.userAgent.length, USAGE_USER_AGENT_MAX_LENGTH);
  assert.equal(composeClientIdentity(withSuffix(USAGE_USER_AGENT_MAX_LENGTH - baseLength)), null);
});

test('client version: the version is the first a.b.c on the first line, with a suffix only of the -[0-9A-Za-z.]+ form', () => {
  const cases = [
    [`${FAKE_PRODUCT_WORD} ${VERSION}`, VERSION],
    [`${FAKE_PRODUCT_WORD} ${VERSION}\n${MARKERS.stdout} ${OTHER_VERSION}`, VERSION],
    [`${FAKE_PRODUCT_WORD} ${VERSION}-alpha.1 (zz-fake build)`, `${VERSION}-alpha.1`],
    [`${FAKE_PRODUCT_WORD} ${VERSION}-rc.2\r\n`, `${VERSION}-rc.2`],
    [`${FAKE_PRODUCT_WORD} ${VERSION}-beta+build`, VERSION],
    [`${FAKE_PRODUCT_WORD} ${VERSION}-`, VERSION],
    [`${FAKE_PRODUCT_WORD} ${VERSION}_rc`, VERSION],
    [`${FAKE_PRODUCT_WORD} ${VERSION}-ü`, VERSION],
    [`${FAKE_PRODUCT_WORD} v${VERSION}, then ${OTHER_VERSION}`, VERSION],
    [`${FAKE_PRODUCT_WORD} unknown\n${VERSION}`, null],
    [`${FAKE_PRODUCT_WORD} ${version(1, 2)}`, null],
    ['', null],
  ];
  for (const [text, expected] of cases) assert.equal(parseCodexVersion(text), expected, JSON.stringify(text));
  assert.equal(parseCodexVersion(undefined), null);
});

// --- 版の読取（起動の形・期限・上限） ---

test('client version: the version is read by spawning the absolute path with --version, shell false and stderr ignored', async t => {
  const f = await resolverFixture(t);
  const result = await f.resolve();
  same(result.userAgent, expectedUserAgent(VERSION), 'the User-Agent is built from the version read');
  assert.equal(result.source, USER_AGENT_SOURCE.codexVersion);
  assert.equal(f.isolation.spawnCalls.length, 1);
  const [call] = f.isolation.spawnCalls;
  assert.equal(call.command, f.codex);
  assert.ok(isAbsolute(call.command));
  assert.deepEqual(call.args, ['--version']);
  assert.deepEqual(call.options, SPAWN_OPTIONS);
  assert.equal(f.isolation.spawnCalls.filter(entry => entry.command === 'codex').length, 0, 'never the bare name');
  assert.deepEqual(f.isolation.refusedSpawns, []);
  assert.deepEqual(f.isolation.refusedChildProcesses, []);
});

test('client version: codexPath is spawned ahead of PATH, a broken or shim codexPath spawns nothing', async t => {
  const f = await resolverFixture(t);
  const configured = await placeExecutable(join(f.isolation.root, 'zz-configured'));
  f.register(configured, () => fakeChild({ stdout: [versionLine(OTHER_VERSION)] }));
  f.resolver.reload({ codexPath: configured });
  same((await f.resolve()).userAgent, expectedUserAgent(OTHER_VERSION), 'the configured executable was read');
  assert.deepEqual(f.isolation.spawnCalls.map(call => call.command), [configured]);
  const link = join(f.isolation.root, 'zz-alias', 'codex');
  await mkdir(dirname(link), { recursive: true });
  const shim = await placeExecutable(shimDir(f.env), { body: `#!/bin/sh\n${CODEX_SHIM_MARKER} v1\n` });
  await symlink(shim, link);
  for (const [name, codexPath, detail] of [
    ['missing', join(f.isolation.root, 'absent', 'codex'), null],
    ['a link to the shim', link, CODEX_PATH_POINTS_TO_SHIM],
  ]) {
    f.resolver.reload({ codexPath });
    const result = await f.resolve();
    assert.deepEqual(result, { userAgent: null, originator: null, source: null, reason: MISSING }, name);
    assert.deepEqual(f.logs.at(-1), { level: 'warn', event: CLIENT_IDENTITY_LOG_EVENT,
      fields: detail === null ? { reason: MISSING } : { reason: MISSING, message: detail } }, name);
  }
  assert.equal(f.isolation.spawnCalls.length, 1, 'no spawn for a broken codexPath, and no fall back to PATH');
  assert.equal(f.spawnsOf(f.codex), 0);
});

test('client version: the read stops the child at the 1000ms deadline and not before', async t => {
  const f = await resolverFixture(t);
  f.setBehavior(() => fakeChild({ hang: true }));
  let settled = null;
  f.resolver.resolveClientIdentity().then(result => { settled = result; });
  await f.tick(CODEX_VERSION_READ_TIMEOUT_MS - 1);
  assert.equal(settled, null, 'still waiting one millisecond before the deadline');
  assert.deepEqual(f.children[0].kills, []);
  await f.tick(1);
  assert.deepEqual(settled, { userAgent: null, originator: null, source: null, reason: UNREADABLE });
  assert.deepEqual(f.children[0].kills, ['SIGKILL'], 'the child is stopped at the deadline');
  assert.equal(CODEX_VERSION_READ_TIMEOUT_MS, 1000);
});

test('client version: standard output is read up to 4 KiB and one byte more is unreadable', async t => {
  const f = await resolverFixture(t);
  const padded = total => [versionLine(), 'x'.repeat(total - versionLine().length)];
  assert.equal(CODEX_VERSION_MAX_STDOUT_BYTES, 4096);
  const read = stdout => readCodexVersion(f.codex, { spawn: () => {
    const child = fakeChild({ stdout });
    f.children.push(child);
    return child;
  }, scheduler: f.scheduler });
  assert.equal(await read(padded(CODEX_VERSION_MAX_STDOUT_BYTES)), VERSION, 'exactly 4 KiB is read');
  assert.equal(await read(padded(CODEX_VERSION_MAX_STDOUT_BYTES + 1)), null, 'one byte more is unreadable');
  assert.deepEqual(f.children[1].kills, ['SIGKILL'], 'the child is stopped once the limit is passed');
});

// --- 読めないときの7通り（取得処理の既定のつなぎを通す） ---

// [名前, 理由, 用意, 起動の回数, 期限を待って初めて決まるか]
const UNREADABLE_CASES = [
  ['no executable on PATH', MISSING, async f => { f.env.PATH = join(f.isolation.root, 'zz-empty'); }, 0, false],
  ['a spawn that throws', UNREADABLE, f => f.setBehavior(() => { throw new Error(`${MARKERS.spawnError} sync`); }), 1, false],
  ['a spawn that emits error', UNREADABLE, f => f.setBehavior(() =>
    fakeChild({ error: Object.assign(new Error(`${MARKERS.spawnError} async`), { code: 'ENOENT' }) })), 1, false],
  ['a non-zero exit', UNREADABLE, f => f.setBehavior(() => fakeChild({ code: 1 })), 1, false],
  ['a signal', UNREADABLE, f => f.setBehavior(() => fakeChild({ code: null, signal: 'SIGTERM' })), 1, false],
  ['the deadline', UNREADABLE, f => f.setBehavior(() => fakeChild({ hang: true })), 1, true],
  ['too much output', UNREADABLE, f => f.setBehavior(() =>
    fakeChild({ stdout: [versionLine(), 'x'.repeat(CODEX_VERSION_MAX_STDOUT_BYTES)] })), 1, false],
  ['no version on the first line', UNREADABLE, f => f.setBehavior(() =>
    fakeChild({ stdout: [`${FAKE_PRODUCT_WORD} unknown\n${versionLine()}`] })), 1, false],
];

for (const [name, reason, arrange, spawns, atDeadline] of UNREADABLE_CASES) {
  test(`client version: ${name} sends no usage read, and the account is unread with ${reason}`, async t => {
    const f = await pollerFixture(t);
    await arrange(f);
    await f.start();
    await f.tick(1);
    // 期限切れのほかは、期限を待たずに決まる。
    assert.equal(f.poller.accountHealth('home:0').observationErrorCode, atDeadline ? null : reason,
      atDeadline ? 'still waiting for the deadline' : 'decided before the deadline');
    await f.tick(CODEX_VERSION_READ_TIMEOUT_MS);
    assert.equal(f.fetchCalls.length, 0, 'no usage read is sent without a client identity');
    assert.equal(f.isolation.fetchCalls.length, 0, 'the global fetch is never touched');
    assert.equal(f.spawnsOf(f.codex), spawns);
    const health = f.poller.accountHealth('home:0');
    assert.equal(health.observationErrorCode, reason);
    assert.equal(health.observationGate, 'failed');
    assert.equal(health.lastObservationSuccessAt, null);
    // 画面の状態語 unread（口座の状態を表示用に写すときに付ける語）の元: 使用量が分からず選ばれない、理由は上の語。
    assert.equal(f.view('home:0').selectionBlockReason, 'usage-unknown');
    assert.equal(f.view('home:0').surveyed, false);
    assert.equal(f.pool.snapshot()[0].state, 'ready', 'no read was sent, so nothing counts against the login');
    assert.deepEqual(f.identityLogs().map(line => ({ level: line.level, fields: line.fields })),
      [{ level: 'warn', fields: { reason } }]);
  });
}

// --- 設定の上書き ---

test('client version: a configured User-Agent and originator are sent as they are and nothing is spawned', async t => {
  const f = await pollerFixture(t, { accounts: 2,
    config: { usageUserAgent: CONFIG_USER_AGENT, usageOriginator: CONFIG_ORIGINATOR } });
  await f.start();
  await f.tick(1);
  await f.tick(60_000);
  assert.equal(f.isolation.spawnCalls.length, 0, 'the version is not read');
  assert.equal(f.fetchCalls.length, 4);
  for (const call of f.fetchCalls) {
    same(call.headers['User-Agent'], CONFIG_USER_AGENT, 'the configured User-Agent is the header');
    same(call.headers.originator, CONFIG_ORIGINATOR, 'the configured originator is the header');
  }
  assert.ok(f.secrets.includes(CONFIG_USER_AGENT) && f.secrets.includes(CONFIG_ORIGINATOR),
    'both configured values are registered as secrets');
  assert.deepEqual(f.identityLogs().map(line => line.fields), [{ user_agent_source: USER_AGENT_SOURCE.config }]);
  const text = [...f.records, JSON.stringify(f.logs)].join('\n');
  assert.ok(!text.includes(CONFIG_USER_AGENT) && !text.includes(CONFIG_ORIGINATOR), 'neither value is logged');
});

test('client version: a configured value alone or a value that fails the checks sends nothing and spawns nothing', async t => {
  const f = await resolverFixture(t);
  for (const config of [{ usageUserAgent: CONFIG_USER_AGENT }, { usageOriginator: CONFIG_ORIGINATOR },
    { usageUserAgent: ` ${CONFIG_USER_AGENT}`, usageOriginator: CONFIG_ORIGINATOR }]) {
    f.resolver.reload(config);
    assert.deepEqual(await f.resolve(), { userAgent: null, originator: null, source: null, reason: UNREADABLE });
  }
  assert.equal(f.isolation.spawnCalls.length, 0);
});

// --- キャッシュ ---

test('client version: the second cycle with the same stat spawns nothing, a new mtime spawns exactly once more', async t => {
  const f = await pollerFixture(t, { accounts: 2 });
  await f.start();
  await f.tick(1);
  assert.equal(f.spawnsOf(f.codex), 1, 'two accounts in one cycle share one read');
  assert.equal(f.fetchCalls.length, 2);
  await f.tick(60_000);
  assert.equal(f.fetchCalls.length, 4);
  assert.equal(f.spawnsOf(f.codex), 1, 'the same executable is not read again');
  const { mtime } = await stat(f.codex);
  await utimes(f.codex, mtime, new Date(mtime.getTime() + 5000));
  f.setBehavior(() => fakeChild({ stdout: [versionLine(OTHER_VERSION)] }));
  await f.tick(60_000);
  assert.equal(f.spawnsOf(f.codex), 2, 'a changed modification time is read exactly once more');
  for (const call of f.fetchCalls.slice(4)) {
    same(call.headers['User-Agent'], expectedUserAgent(OTHER_VERSION), 'the new version is used at once');
  }
  await f.tick(60_000);
  assert.equal(f.spawnsOf(f.codex), 2);
  assert.equal(f.fetchCalls.length, 8);
});

test('client version: a new size or a new real path is read again, the same ones are not', async t => {
  const f = await resolverFixture(t);
  const link = join(f.isolation.root, 'zz-link-bin', 'codex');
  await mkdir(dirname(link), { recursive: true });
  const first = await placeExecutable(join(f.isolation.root, 'zz-real-a'));
  const second = await placeExecutable(join(f.isolation.root, 'zz-real-b'));
  // 更新時刻をミリ秒の端数の無い値にそろえておく（後で同じ値へ戻せるように）。
  const pinned = new Date(START);
  await utimes(first, pinned, pinned);
  await symlink(first, link);
  f.register(link, () => fakeChild());
  f.resolver.reload({ codexPath: link });
  await f.resolve();
  await f.resolve();
  assert.equal(f.spawnsOf(link), 1);
  // 大きさだけ変える（更新時刻は同じ値へ戻す）。
  const before = await stat(first);
  await writeFile(first, `${REAL_BODY}# zz-fake longer\n`);
  await utimes(first, pinned, pinned);
  const after = await stat(first);
  assert.equal(after.mtimeMs, before.mtimeMs, 'only the size differs');
  assert.notEqual(after.size, before.size);
  await f.resolve();
  assert.equal(f.spawnsOf(link), 2, 'a new size is read again');
  // 実パスだけ変える（同じ名前のリンクを、別のファイルへ向け直す）。
  const moved = `${link}.next`;
  await symlink(second, moved);
  await rename(moved, link);
  await f.resolve();
  assert.equal(f.spawnsOf(link), 3, 'a new real path is read again');
  await f.resolve();
  assert.equal(f.spawnsOf(link), 3);
});

test('client version: a chosen executable overwritten with the shim marker is judged again and never spawned', async t => {
  // 一度読めた後に、選んだファイルの中身が目印付き（shim のコピー）に置き換わった。起動する前に
  // 絶対パスの決め方（shim の除外）をやり直すので、そのファイルは起動せず、PATH の次の本物を読む。
  const f = await resolverFixture(t);
  const second = await placeExecutable(join(f.isolation.root, 'zz-bin-second'));
  f.register(second, () => fakeChild({ stdout: [versionLine(OTHER_VERSION)] }));
  f.env.PATH = [f.binDir, dirname(second)].join(':');
  same((await f.resolve()).userAgent, expectedUserAgent(VERSION), 'the first codex on PATH was read');
  assert.equal(f.spawnsOf(f.codex), 1);
  await writeFile(f.codex, `#!/bin/sh\n${CODEX_SHIM_MARKER} v1\n# zz-fake shim for tests (never executed)\n`);
  const result = await f.resolve();
  assert.equal(f.spawnsOf(f.codex), 1, 'the file that now carries the marker is not spawned');
  assert.equal(f.spawnsOf(second), 1, 'the next real codex on PATH is read instead');
  same(result.userAgent, expectedUserAgent(OTHER_VERSION), 'the value comes from the next real codex');
});

test('client version: a codexPath link turned to the shim spawns nothing and reports codexPath points to shim', async t => {
  const f = await resolverFixture(t);
  const target = await placeExecutable(join(f.isolation.root, 'zz-real'));
  const shim = await placeExecutable(shimDir(f.env), { body: `#!/bin/sh\n${CODEX_SHIM_MARKER} v1\n` });
  const link = join(f.isolation.root, 'zz-link', 'codex');
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link);
  f.register(link, () => fakeChild());
  f.resolver.reload({ codexPath: link });
  assert.equal((await f.resolve()).source, USER_AGENT_SOURCE.codexVersion);
  assert.equal(f.spawnsOf(link), 1);
  const spawnsBefore = f.isolation.spawnCalls.length;
  // 同じ名前のリンクを、shim へ向け直す。
  const moved = `${link}.next`;
  await symlink(shim, moved);
  await rename(moved, link);
  const result = await f.resolve();
  assert.equal(f.isolation.spawnCalls.length, spawnsBefore, 'nothing is spawned once the link names the shim');
  assert.equal(result.reason, MISSING);
  assert.ok(result.userAgent === null && result.originator === null && result.source === null, 'no value is returned');
  assert.deepEqual(f.logs.at(-1), { level: 'warn', event: CLIENT_IDENTITY_LOG_EVENT,
    fields: { reason: MISSING, message: CODEX_PATH_POINTS_TO_SHIM } });
});

test('client version: after a failed read it reads again once in the next cycle, never sooner', async t => {
  const f = await pollerFixture(t, { accounts: 2 });
  f.setBehavior(() => fakeChild({ code: 1 }));
  await f.start();
  await f.tick(1);
  assert.equal(f.spawnsOf(f.codex), 1, 'two accounts share the failed read');
  assert.equal(f.fetchCalls.length, 0);
  f.setBehavior(() => fakeChild());
  await f.tick(59_999);
  assert.equal(f.spawnsOf(f.codex), 1);
  await f.tick(1);
  assert.equal(f.spawnsOf(f.codex), 2, 'the next cycle reads again exactly once');
  assert.equal(f.fetchCalls.length, 2, 'both accounts are read with the recovered identity');
  assert.deepEqual(f.identityLogs().map(line => line.fields),
    [{ reason: UNREADABLE }, { user_agent_source: USER_AGENT_SOURCE.codexVersion }]);
});

test('client version: a failure holds until one poll interval after the attempt began', async t => {
  const f = await resolverFixture(t, { config: { usagePollIntervalMs: 90_000 } });
  f.setBehavior(() => fakeChild({ code: 1 }));
  assert.equal((await f.resolve()).reason, UNREADABLE);
  f.setBehavior(() => fakeChild());
  for (const step of [30_000, 59_999]) {
    await f.tick(step);
    assert.equal((await f.resolve()).reason, UNREADABLE, 'the failure is held inside the interval');
  }
  assert.equal(f.spawnsOf(f.codex), 1);
  await f.tick(1);
  assert.equal((await f.resolve()).source, USER_AGENT_SOURCE.codexVersion, 'read again at the interval');
  assert.equal(f.spawnsOf(f.codex), 2);
});

test('client version: a reload starts over from finding the executable', async t => {
  const f = await pollerFixture(t);
  await f.start();
  await f.tick(1);
  assert.equal(f.spawnsOf(f.codex), 1);
  await f.start();
  await f.tick(30_000);
  assert.equal(f.spawnsOf(f.codex), 2, 'the same executable is read again after a reload');
  const configured = await placeExecutable(join(f.isolation.root, 'zz-configured'));
  f.register(configured, () => fakeChild({ stdout: [versionLine(OTHER_VERSION)] }));
  await f.start({ ...f.settings, codexPath: configured });
  await f.tick(30_000);
  assert.equal(f.spawnsOf(configured), 1, 'the reload found the newly configured executable');
  same(f.fetchCalls.at(-1).headers['User-Agent'], expectedUserAgent(OTHER_VERSION), 'its version is used');
  assert.equal(f.spawnsOf(f.codex), 2);
});

// --- 偽の製品名・値と目印が外へ出ないこと ---

test('client version: a zz-fake product in the output is never used, the constants build both headers', async t => {
  const f = await pollerFixture(t);
  await f.start();
  await f.tick(1);
  assert.equal(f.fetchCalls.length, 1);
  const { headers } = f.fetchCalls[0];
  same(headers['User-Agent'], expectedUserAgent(VERSION), 'the header is <product constant>/<version read> (<comment constant>)');
  assert.ok(!headers['User-Agent'].includes('zz-fake-'), 'the first word of the output is not used');
  same(headers.originator, CODEX_UA_PRODUCT, 'the originator header is the product constant');
  assert.ok(f.secrets.includes(headers['User-Agent']) && f.secrets.includes(headers.originator),
    'both values are registered as secrets before they are used');
  assert.deepEqual(f.identityLogs().map(line => ({ level: line.level, fields: line.fields })),
    [{ level: 'info', fields: { user_agent_source: USER_AGENT_SOURCE.codexVersion } }]);
  const text = [...f.records, JSON.stringify(f.logs)].join('\n');
  assert.ok(!text.includes(headers['User-Agent']), 'the User-Agent is not logged');
  assert.ok(!text.includes(headers.originator), 'the originator is not logged');
});

test('client version: the returned fields other than the two headers never carry the values', async t => {
  const f = await resolverFixture(t, { config: { usageUserAgent: CONFIG_USER_AGENT, usageOriginator: CONFIG_ORIGINATOR } });
  const configured = await f.resolve();
  f.resolver.reload(null);
  const composed = await f.resolve();
  for (const [name, result, values] of [['config', configured, [CONFIG_USER_AGENT, CONFIG_ORIGINATOR]],
    ['codex-version', composed, [expectedUserAgent(VERSION), CODEX_UA_PRODUCT]]]) {
    const { userAgent, originator, ...rest } = result;
    same(userAgent, values[0], `${name}: the User-Agent header value`);
    same(originator, values[1], `${name}: the originator header value`);
    const text = JSON.stringify(rest);
    assert.ok(values.every(value => !text.includes(value)), `${name}: no other field carries a value`);
    assert.deepEqual(Object.keys(rest), ['source']);
  }
  const logged = JSON.stringify(f.logs);
  assert.ok([CONFIG_USER_AGENT, CONFIG_ORIGINATOR, expectedUserAgent(VERSION), CODEX_UA_PRODUCT]
    .every(value => !logged.includes(value)), 'the log lines carry no value');
  for (const line of f.logs) {
    assert.ok(Object.keys(line.fields).every(key => ['user_agent_source', 'reason', 'message'].includes(key)));
  }
});

test('client version: the stdout, stderr and spawn-error markers reach no result, exception, log or stderr line', async t => {
  const written = [];
  const originalWrite = process.stderr.write;
  const restore = () => { process.stderr.write = originalWrite; };
  t.after(restore);
  process.stderr.write = function captureStderr(chunk) {
    written.push(String(chunk));
    return true;
  };
  const f = await pollerFixture(t);
  const direct = [];
  const thrown = [];
  const resolver = createClientIdentityResolver({ env: f.env, registerSecret: () => {}, spawn: f.isolation.spawn,
    now: f.clock.now, scheduler: f.scheduler, log: (level, event, fields) => f.logs.push({ level, event, fields }) });
  const behaviors = [
    () => fakeChild({ stdout: [`${versionLine()}${MARKERS.stdout} ${OTHER_VERSION}\n`], stderr: [MARKERS.stderr] }),
    () => fakeChild({ stdout: [`${MARKERS.stdout}\n`], stderr: [MARKERS.stderr] }),
    () => fakeChild({ stdout: [versionLine(), MARKERS.stdout], stderr: [MARKERS.stderr], code: 3 }),
    () => fakeChild({ stdout: [MARKERS.stdout], stderr: [MARKERS.stderr], error: new Error(MARKERS.spawnError) }),
    () => { throw Object.assign(new Error(MARKERS.spawnError), { stderr: MARKERS.stderr, stdout: MARKERS.stdout }); },
  ];
  for (const behave of behaviors) {
    f.setBehavior(behave);
    resolver.reload(null);
    try {
      const pendingResult = resolver.resolveClientIdentity();
      await flush();
      direct.push(await pendingResult);
    } catch (error) {
      thrown.push(error);
    }
    try {
      direct.push(await readCodexVersion(f.codex, { spawn: f.isolation.spawn, scheduler: f.scheduler }));
    } catch (error) {
      thrown.push(error);
    }
  }
  // 取得処理の既定のつなぎでも、同じ出力を通す（本物のロガーへ書く）。
  f.setBehavior(behaviors[0]);
  await f.start();
  await f.tick(1);
  f.setBehavior(behaviors[3]);
  await f.start();
  await f.tick(30_000);
  restore();
  assert.equal(thrown.length, 0, 'nothing throws');
  same(direct[0].userAgent, expectedUserAgent(VERSION), 'the first line alone makes the value');
  assert.equal(f.fetchCalls.length, 1);
  const surfaces = { results: JSON.stringify(direct), exceptions: thrown.map(String).join('\n'),
    logs: [...f.records, JSON.stringify(f.logs)].join('\n'), stderr: written.join('') };
  for (const [surface, text] of Object.entries(surfaces)) {
    for (const marker of Object.values(MARKERS)) assert.ok(!text.includes(marker), `${marker} is not in the ${surface}`);
  }
  assert.ok(f.logs.length > 0 && f.records.length > 0, 'the log surfaces were exercised');
});

// --- 既定のつなぎと秘密の登録 ---

test('client version: the default reader needs registerSecret, and the poller uses it when no resolver is given', async t => {
  const isolation = await setupCodexIsolation(t);
  assert.throws(() => createClientIdentityResolver({ env: isolation.env }), /registerSecret/);
  const pool = createCodexAccountPool([], {});
  assert.throws(() => createUsagePoller({ pool, env: isolation.env, spawn: isolation.spawn }), /registerSecret/);
  assert.throws(() => createUsagePoller({ pool }), /resolveClientIdentity/);
  assert.doesNotThrow(() => createUsagePoller({ pool, env: isolation.env, spawn: isolation.spawn, registerSecret: () => {} }));
  assert.equal(isolation.spawnCalls.length, 0, 'creating the poller reads nothing');
});
