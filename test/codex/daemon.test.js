// 常駐（src/codex/daemon.js）のテスト。待受のホストとポート、入口の検査（403・401・振り分け）、制御トークンの
// ファイル（権限・作り直し・所有を確かめた削除）、拒否したときの不変、秘密の持ち出し、読み直し（検証・世代・
// 直列化・ポートの変更・適用の途中の例外で止まる）、状態の JSON のスキーマ、User-Agent の出どころ、プールの
// 観測方式、出来事の記録と reconcile() の回数、射影の例外、reconcile() へ models を渡さないこと、停止の後。
//
// 絶対条件:
//   - 実の待受・実の設定・実のホーム・実の Codex CLI・実の上流へ届かない。env・要求関数・起動関数は
//     隔離の補助（helpers/isolation.js）のもの。常駐は必ずポート0で待ち受け、起動の関数の戻り値の port
//     （server.address().port の値）を allowRequest に登録してから、requestLocal に隔離の request だけを
//     渡して接続する。実の待受の番号は数で書かず、REAL_SERVICE_PORTS と DEFAULT_DAEMON_PORT と比べる。
//   - 上流は fetchImpl に渡す偽物、資格情報は readCredentials に渡す合成の値だけ（資格情報のファイルを
//     置かない）。取得の周期は偽の時計と偽のスケジューラで回す。
//   - User-Agent の期待値は、許した2つの定数を import して組み立てる（値を直書きしない）。版は数を
//     連結して作る。値を比べるところは assert.ok と説明文だけで判定する（失敗しても値を表示しない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { chmod, lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { CODEX_UA_COMMENT, CODEX_UA_PRODUCT } from '../../src/codex/client-version.js';
import { DEFAULT_DAEMON_PORT, loadCodexConfig, validateCodexConfig } from '../../src/codex/config.js';
import {
  CONTROL_TOKEN_HEADER, ControlTokenError, readControlToken,
} from '../../src/codex/control-token.js';
import {
  CODEX_DAEMON_START_STAGE, CodexDaemonStartError, codexAccountEntries, startCodexDaemon,
} from '../../src/codex/daemon.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { codexRotatorConfigDir, codexRotatorConfigPath, controlTokenPath } from '../../src/codex/paths.js';
import { isValidCodexStatus } from '../../src/shared/codex-status-schema.js';
import { isLoopbackHostname, localServiceUrl, requestLocal } from '../../src/shared/local-http.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const MIN = 60_000;
const FIVE_HOURS_S = 18_000;
const WEEK_S = 604_800;
// clock.advance は同期で、読取の続き（マイクロタスク・子の出来事）を流さない。
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };
// 合図を待つときの期限（実時間）。これを過ぎたら、その待ちを失敗として報告する。
const SIGNAL_DEADLINE_MS = 5_000;
// promise が期限までに決着しなければ、what を添えて失敗にする。期限のタイマーは決着したら外す。
function withDeadline(promise, ms, what) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `timed out waiting for ${what}` })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
// 合成の目印。トークンの形（ヘッダに載せてよい文字・32文字以上）を満たす。
const TOKEN_MARKER = 'ZZTOKENMARKER'.repeat(3);
const HEADER_MARKER = 'zz-daemon-header-marker-7c1e';
// 設定で与える User-Agent と originator の上書き（合成の値）。
const CONFIG_USER_AGENT = 'zz-fake-daemon-agent (zz-fake-daemon-comment)';
const CONFIG_ORIGINATOR = 'zz-fake-daemon-originator';
// 版は数を連結して作る。偽の版の出力の1語目は zz-fake- で始まる製品名（組み立てには使われない語）。
const VERSION = [0, 0, 7].join('.');
const expectedUserAgent = value => `${CODEX_UA_PRODUCT}/${value} (${CODEX_UA_COMMENT})`;
// 版の読取の目印（標準出力の2行目・標準エラー・起動エラーのメッセージ）。
const MARKERS = Object.freeze({ stdout: 'ZZ-STDOUT-MARKER', stderr: 'ZZ-STDERR-MARKER', spawnError: 'ZZ-SPAWNERR-MARKER' });

// --- 補助 ---------------------------------------------------------------------------------------

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 値を表示しない包含の確かめ。
function absent(text, value, message) {
  assert.ok(!String(text).includes(value), message);
}

// 例外の中身（メッセージ・文字列化・inspect）。
const errorTexts = error => [error.message, String(error), inspect(error, { depth: 5, showHidden: true })];

/**
 * テストの設定。daemon.port の既定は0。実の待受の番号を渡されたら例外にする。
 * accounts は { label, policy? } の並び。口座のフォルダは隔離の一時フォルダの中。
 */
function configFor(isolation, { accounts = [{ label: 'zz-a' }], override = true, ...rest } = {}) {
  const accountsDir = join(isolation.root, 'zz-accounts');
  const config = {
    enabled: true,
    acknowledgedMultiAccountRisk: true,
    accountsDir,
    daemon: { port: 0 },
    ...(override ? { usageUserAgent: CONFIG_USER_AGENT, usageOriginator: CONFIG_ORIGINATOR } : {}),
    accounts: accounts.map(({ label, policy = POLICY }) =>
      ({ label, codexHome: join(accountsDir, label), usagePolicy: { ...policy } })),
    ...rest,
  };
  const port = config.daemon?.port;
  if (REAL_SERVICE_PORTS.includes(port)) throw new Error('a test config must not use a real service port');
  return config;
}

async function writeConfigFile(env, config, mode = 0o600) {
  const dir = codexRotatorConfigDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = codexRotatorConfigPath(env);
  await writeFile(path, typeof config === 'string' ? config : JSON.stringify(config), { mode });
  await chmod(path, mode);
  return path;
}

// 上流の窓と応答。
const upstreamWindow = (used, seconds, resetIn = 3_600) => nowSec => ({ used_percent: used, limit_window_seconds: seconds,
  reset_after_seconds: resetIn, reset_at: nowSec + resetIn });
const fiveHour = (used, resetIn) => upstreamWindow(used, FIVE_HOURS_S, resetIn);
const weekly = (used, resetIn = 86_400) => upstreamWindow(used, WEEK_S, resetIn);
function usageResponse(clock, { allowed = true, primary, secondary } = {}) {
  const nowSec = Math.floor(clock.now() / 1000);
  return new Response(JSON.stringify({ rate_limit: { allowed,
    ...(primary ? { primary_window: primary(nowSec) } : {}),
    ...(secondary ? { secondary_window: secondary(nowSec) } : {}) } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
}
const lowUsage = clock => usageResponse(clock, { primary: fiveHour(10), secondary: weekly(10) });

/** 偽の子プロセス（標準エラー → error か標準出力 → close の順に出来事を起こす）。 */
function fakeChild({ stdout = [`zz-fake-codex-cli ${VERSION}\n`], stderr = [], error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => { setImmediate(() => child.emit('close', null, signal)); return true; };
  setImmediate(() => {
    for (const text of stderr) child.stderr.emit('data', Buffer.from(text));
    if (error) {
      child.emit('error', error);
      return;
    }
    for (const text of stdout) child.stdout.emit('data', Buffer.from(text));
    child.emit('close', 0, null);
  });
  return child;
}

/**
 * 隔離・偽の時計・設定・ロガーを用意して常駐を起動する。
 * @param {object} options
 *   config: configFor に渡す値（false なら設定ファイルを書かない）
 *   respond({ clock, account }): 上流の応答。既定は低い使用率。
 *   codex: 偽の codex を置いて PATH に入れる。behave() が偽の子を返す。
 *   start: false なら起動しない（起動の失敗を確かめるテスト）。
 *   wrapLogger(logger): 本物のロガーを包んだものを常駐へ渡す（registerSecret を失敗させるテスト）。
 *   ほかは startCodexDaemon へそのまま渡す（generateToken・loadConfig・createServer・listenHost・now など）。
 */
async function fixture(t, { config = {}, respond = ({ clock }) => lowUsage(clock), codex = null, start = true,
  readCredentials, wrapLogger, ...daemonOptions } = {}) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  let env = isolation.env;
  let codexPath = null;
  if (codex) {
    const binDir = join(isolation.root, 'zz-bin');
    await mkdir(binDir, { recursive: true, mode: 0o700 });
    codexPath = join(binDir, 'codex');
    await writeFile(codexPath, '#!/bin/sh\n# zz-fake codex for tests (never executed)\n');
    await chmod(codexPath, 0o755);
    env = { ...isolation.env, PATH: binDir };
    isolation.registerSpawn(codexPath, (...args) => codex.behave(...args));
  }
  const settings = config === false ? null : configFor(isolation, config);
  if (settings) await writeConfigFile(env, settings);
  const lines = [];
  // ログの行を待つ受け手（waitForLine）。行が来るたびに条件を確かめる。
  const lineWaiters = new Set();
  const baseLogger = createCodexLogger({ level: 'debug', write: line => {
    lines.push(line);
    for (const waiter of [...lineWaiters]) waiter(line);
  } });
  const logger = wrapLogger ? wrapLogger(baseLogger) : baseLogger;
  const credentialReads = [];
  const fetchCalls = [];
  const createServerCalls = [];
  const servers = [];
  const options = {
    env, spawn: isolation.spawn, now: clock.now, scheduler, logger,
    credentialEpoch: () => 1,
    readCredentials: readCredentials ?? (async authPath => {
      credentialReads.push(basename(dirname(authPath)));
      return { accessToken: 'zz-fake-access', accountId: basename(dirname(authPath)) };
    }),
    fetchImpl: async (url, init) => {
      const account = init.headers['ChatGPT-Account-ID'];
      fetchCalls.push({ at: clock.now(), account });
      return respond({ clock, account });
    },
    ...daemonOptions,
  };
  const baseCreateServer = options.createServer ?? createHttpServer;
  options.createServer = (...args) => {
    createServerCalls.push(args.length);
    const server = baseCreateServer(...args);
    servers.push(server);
    return server;
  };
  const f = {
    isolation, clock, scheduler, env, settings, lines, logger, options, codexPath,
    credentialReads, fetchCalls, createServerCalls, servers, daemon: null,
    tokenPath: controlTokenPath(env),
    // 割り当てられた番号が実サービスの番号に当たったら、止めて起動し直す（隔離はその番号へ接続させない）。
    async start(extra = {}) {
      for (let attempt = 0; ; attempt++) {
        f.daemon = await startCodexDaemon({ ...options, ...extra });
        if (!REAL_SERVICE_PORTS.includes(f.daemon.port)) break;
        await f.daemon.stop();
        if (attempt >= 5) throw new Error('the system kept assigning a real service port');
      }
      isolation.allowRequest(f.daemon.port);
      return f.daemon;
    },
    async stop() { await f.daemon?.stop(); },
    token: () => readControlToken({ env }),
    call(path, { method = 'GET', headers = {}, token, body } = {}) {
      return requestLocal({ request: isolation.request, port: f.daemon.port, path, method, body,
        headers: { ...(token === undefined ? {} : { [CONTROL_TOKEN_HEADER]: token }), ...headers } });
    },
    async status() {
      const response = await f.call('/internal/status');
      assert.equal(response.status, 200);
      return JSON.parse(response.body);
    },
    async reload(token) {
      const response = await f.call('/internal/reload', { method: 'POST', token: token ?? await f.token() });
      return { status: response.status, body: JSON.parse(response.body) };
    },
    async tick(ms) {
      clock.advance(ms);
      await flush();
    },
    // ログの全行（ロガーの write へ渡された文字列）。
    logText: () => lines.join('\n'),
    // 条件に合うログの行が来るまで待つ（既に来ていればすぐ終える）。期限を過ぎたら失敗にする。
    waitForLine(matches, what, ms = SIGNAL_DEADLINE_MS) {
      if (lines.some(line => matches(JSON.parse(line)))) return Promise.resolve();
      let waiter;
      const signal = new Promise(resolve => {
        waiter = line => {
          if (!matches(JSON.parse(line))) return;
          lineWaiters.delete(waiter);
          resolve();
        };
        lineWaiters.add(waiter);
      });
      return withDeadline(signal, ms, what).finally(() => lineWaiters.delete(waiter));
    },
  };
  t.after(() => f.stop());
  if (start) await f.start();
  return f;
}

const accountOf = (json, label) => json.accounts.find(account => account.label === label);

// 起動の失敗を確かめる。
async function assertStartFails(f, stage, extra = {}) {
  let caught;
  await assert.rejects(() => f.start(extra), error => {
    caught = error;
    return true;
  });
  assert.ok(caught instanceof CodexDaemonStartError, 'a start error');
  assert.equal(caught.stage, stage);
  assert.ok(Number.isInteger(caught.exitCode) && caught.exitCode !== 0, 'a non-zero exit code');
  return caught;
}

// --- 待受のホストとポート ------------------------------------------------------------------------------

test('daemon: a listen host other than loopback is refused before the server is created', async t => {
  const f = await fixture(t, { start: false });
  for (const listenHost of ['0.0.0.0', '::', 'localhost', 'zz-not-loopback.example', '', '127.0.0.1 ', null]) {
    const error = await assertStartFails(f, CODEX_DAEMON_START_STAGE.listenHost, { listenHost });
    assert.equal(error.name, 'CodexDaemonStartError');
  }
  assert.equal(f.createServerCalls.length, 0, 'the server is never created');
  assert.equal(await exists(f.tokenPath), false, 'no token file');
  assert.equal(f.credentialReads.length, 0);
});

test('daemon: a normal start listens on loopback at the port the system assigned', async t => {
  const f = await fixture(t);
  const address = f.servers.at(-1).address();
  assert.ok(isLoopbackHostname(address.address), 'the listening address is loopback');
  assert.equal(address.port, f.daemon.port, 'the returned port is server.address().port');
  assert.ok(Number.isInteger(f.daemon.port) && f.daemon.port > 0);
  assert.equal(REAL_SERVICE_PORTS.includes(f.daemon.port), false, 'not a real service port');
  assert.equal(f.daemon.port === DEFAULT_DAEMON_PORT, false);
  const loaded = await loadCodexConfig({ env: f.env });
  assert.equal(loaded.daemon.port, 0, 'the test config listens on port 0');
  assert.equal((await f.call('/internal/health')).status, 200);
  await f.stop();
  await f.start({ listenHost: '::1' });
  assert.equal(f.servers.at(-1).address().address, '::1', 'the IPv6 loopback listens on loopback');
});

test('daemon: the default port is the config default, and a port of 0 or none never makes a URL', () => {
  assert.ok(Number.isInteger(DEFAULT_DAEMON_PORT) && DEFAULT_DAEMON_PORT > 0);
  assert.ok(REAL_SERVICE_PORTS.includes(DEFAULT_DAEMON_PORT), 'the default daemon port is guarded by the isolation');
  assert.throws(() => localServiceUrl(0, '/internal/status'), RangeError);
  assert.throws(() => localServiceUrl(undefined, '/internal/status'), RangeError);
});

// --- 入口の検査 ----------------------------------------------------------------------

test('daemon: a bad Host, a foreign Origin or a cross-site fetch is 403 even with the right token', async t => {
  const f = await fixture(t);
  const token = await f.token();
  const cases = [
    { host: 'zz-not-loopback.example' },
    { origin: 'http://zz-not-loopback.example' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of cases) {
    for (const [path, method] of [['/internal/reload', 'POST'], ['/internal/status', 'GET']]) {
      const response = await f.call(path, { method, headers, token });
      assert.equal(response.status, 403, `${method} ${path} ${Object.keys(headers)[0]}`);
      assert.deepEqual(JSON.parse(response.body), { error: 'forbidden' });
    }
  }
  assert.equal(f.daemon.inspect().configGeneration, 1, 'no reload happened');
});

test('daemon: with loopback headers, POST /internal/reload without, with a wrong, or with several tokens is 401; the right one passes', async t => {
  const f = await fixture(t);
  const token = await f.token();
  const port = f.daemon.port;
  // (a) Host・Origin・sec-fetch-site がループバックとして正しくても、トークンが無ければ 401。
  const local = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' };
  const wrongSameLength = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
  const cases = [
    ['no header', {}],
    ['a wrong value of the same length', { [CONTROL_TOKEN_HEADER]: wrongSameLength }],
    ['a wrong value of another length', { [CONTROL_TOKEN_HEADER]: `${token}0` }],
    ['a short value', { [CONTROL_TOKEN_HEADER]: token.slice(0, 8) }],
    ['several values', { [CONTROL_TOKEN_HEADER]: [token, token] }],
    ['several values, the right one first', { [CONTROL_TOKEN_HEADER]: [token, wrongSameLength] }],
  ];
  for (const [what, headers] of cases) {
    const response = await f.call('/internal/reload', { method: 'POST', headers: { ...local, ...headers } });
    assert.equal(response.status, 401, what);
    assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' }, what);
  }
  assert.equal(f.daemon.inspect().configGeneration, 1);
  const ok = await f.call('/internal/reload', { method: 'POST', headers: local, token });
  assert.equal(ok.status, 200);
  assert.equal(f.daemon.inspect().configGeneration, 2);
});

test('daemon: a POST to an unknown path is 401 without the token and 404 with it; wrong methods are 405', async t => {
  const f = await fixture(t);
  const token = await f.token();
  for (const path of ['/internal/zz-unknown', '/', '/internal/status', '/internal/health', '/internal/reload']) {
    const response = await f.call(path, { method: 'POST' });
    assert.equal(response.status, 401, `POST ${path} without the token`);
    assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
  }
  assert.equal((await f.call('/internal/zz-unknown', { method: 'POST', token })).status, 404);
  assert.equal((await f.call('/', { method: 'POST', token })).status, 404);
  assert.equal((await f.call('/internal/zz-unknown')).status, 404, 'an unknown GET is 404 (GET is not checked)');
  const post405 = await f.call('/internal/status', { method: 'POST', token });
  assert.equal(post405.status, 405);
  assert.equal(post405.headers.allow, 'GET');
  const get405 = await f.call('/internal/reload');
  assert.equal(get405.status, 405);
  assert.equal(get405.headers.allow, 'POST');
  assert.deepEqual(JSON.parse(get405.body), { error: 'method-not-allowed' });
  assert.equal(f.daemon.inspect().configGeneration, 1, 'none of these reloaded');
});

test('daemon: 401 and 403 show neither the token nor the request headers; rejections carry the fixed headers', async t => {
  const f = await fixture(t, { generateToken: () => TOKEN_MARKER });
  const token = await f.token();
  assert.equal(token, TOKEN_MARKER);
  const wrong = 'ZZWRONGTOKENMARKER'.repeat(2);
  const responses = [
    await f.call('/internal/reload', { method: 'POST', headers: { 'x-zz-marker': HEADER_MARKER }, token: wrong }),
    await f.call('/internal/zz-unknown', { method: 'POST', headers: { 'x-zz-marker': HEADER_MARKER }, token: wrong,
      body: HEADER_MARKER }),
    await f.call('/internal/reload', { method: 'POST', headers: { 'x-zz-marker': HEADER_MARKER, host: 'zz-bad.example' },
      token }),
    await f.call('/internal/status', { headers: { 'x-zz-marker': HEADER_MARKER, origin: 'http://zz-bad.example' }, token }),
  ];
  assert.deepEqual(responses.map(response => response.status), [401, 401, 403, 403]);
  for (const response of responses) {
    const text = `${response.body}\n${JSON.stringify(response.headers)}`;
    for (const value of [TOKEN_MARKER, wrong, HEADER_MARKER]) absent(text, value, 'the response carries no request value');
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(Object.keys(response.headers).filter(name => name.toLowerCase().startsWith('access-control-')), []);
  }
  assert.ok(f.lines.length > 0, 'the rejections were logged');
  for (const value of [TOKEN_MARKER, wrong, HEADER_MARKER]) absent(f.logText(), value, 'the log carries no request value');
});

// --- トークンのファイル --------------------------------------------------------------

test('daemon: the token file is 0600 in a 0700 folder inside the isolation folder, and it is gone after stop', async t => {
  const f = await fixture(t);
  const stats = await lstat(f.tokenPath);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(f.tokenPath))).mode & 0o777, 0o700);
  assert.ok(f.tokenPath.startsWith(`${f.isolation.root}/`));
  await f.stop();
  assert.equal(await exists(f.tokenPath), false, 'removed on stop');
  await f.stop();
});

test('daemon: every start writes a new token, with the default generator and with a replaced one', async t => {
  const f = await fixture(t, { start: false });
  const seen = [];
  for (let i = 0; i < 2; i++) {
    await f.start();
    seen.push(await f.token());
    await f.stop();
  }
  let n = 0;
  const generateToken = () => `${TOKEN_MARKER}${++n}`;
  for (let i = 0; i < 2; i++) {
    await f.start({ generateToken });
    seen.push(await f.token());
    await f.stop();
  }
  assert.equal(new Set(seen).size, 4, 'four different tokens');
  assert.match(seen[0], /^[0-9a-f]{64}$/);
  assert.equal(seen[2], `${TOKEN_MARKER}1`);
  assert.equal(seen[3], `${TOKEN_MARKER}2`);
});

test('daemon: a token folder that is a symbolic link or 0755 stops the start before it listens', async t => {
  const f = await fixture(t, { start: false });
  const validated = validateCodexConfig(f.settings, { env: f.env });
  const loadConfig = async () => validated;
  const folder = dirname(f.tokenPath);

  await chmod(folder, 0o755);
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.tokenFolder, { loadConfig });
  assert.equal(f.createServerCalls.length, 0);
  assert.equal(await exists(f.tokenPath), false);

  await rm(folder, { recursive: true, force: true });
  const target = join(f.isolation.root, 'zz-link-target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, folder);
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.tokenFolder, { loadConfig });
  assert.equal(f.createServerCalls.length, 0);
  assert.equal(await exists(join(target, basename(f.tokenPath))), false, 'nothing was written through the link');
  assert.equal(f.credentialReads.length, 0);

  // 本物の設定の読込では、設定のフォルダがトークンの親フォルダと同じなので、先に設定の読込が止める。
  await rm(folder, { force: true });
  await writeConfigFile(f.env, f.settings);
  await chmod(folder, 0o755);
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.config);
  assert.equal(f.createServerCalls.length, 0);
  assert.equal(await exists(f.tokenPath), false);
});

test('daemon: a config that is missing or not activated creates no token and does not listen', async t => {
  const f = await fixture(t, { config: false, start: false });
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.notActivated);
  for (const change of [{ enabled: false }, { acknowledgedMultiAccountRisk: false }]) {
    await writeConfigFile(f.env, { ...configFor(f.isolation), ...change });
    await assertStartFails(f, CODEX_DAEMON_START_STAGE.notActivated);
  }
  await writeConfigFile(f.env, '{ not json');
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.config);
  assert.equal(f.createServerCalls.length, 0);
  assert.equal(await exists(f.tokenPath), false);
});

test('daemon: required dependencies are never replaced by defaults', async t => {
  const f = await fixture(t, { start: false });
  for (const name of ['env', 'spawn', 'fetchImpl', 'now', 'scheduler', 'logger']) {
    await assert.rejects(() => startCodexDaemon({ ...f.options, [name]: undefined }), TypeError, name);
  }
  await assert.rejects(() => startCodexDaemon({ ...f.options, logger: { info() {} } }), TypeError);
  await assert.rejects(() => startCodexDaemon(), TypeError);
  assert.equal(f.createServerCalls.length, 0);
  assert.equal(await exists(f.tokenPath), false);
});

// --- 拒否したときの不変 ------------------------------------------------------------------------

test('daemon: 401 and 403 change neither the generations, the events, the stop records nor the next account', async t => {
  let high = true;
  const f = await fixture(t, { config: { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] },
    respond: ({ clock, account }) => (account === 'zz-a' && high
      ? usageResponse(clock, { primary: fiveHour(80), secondary: weekly(10) })
      : lowUsage(clock)) });
  await f.tick(1);
  const token = await f.token();
  const before = f.daemon.inspect();
  const stopped = before.accounts.find(entry => entry.label === 'zz-a');
  assert.ok(Object.keys(stopped.windowCaps ?? {}).length > 0, 'zz-a is stopped');
  const statusBefore = await f.status();
  assert.equal(accountOf(statusBefore, 'zz-a').stateWord, 'held');
  assert.deepEqual(statusBefore.next, { label: 'zz-b', reason: 'selectable' });
  high = false;

  const port = f.daemon.port;
  const rejected = [
    await f.call('/internal/reload', { method: 'POST' }),
    await f.call('/internal/reload', { method: 'POST', token: `${token}0` }),
    await f.call('/internal/reload', { method: 'POST', token, headers: { host: 'zz-bad.example' } }),
    await f.call('/internal/reload', { method: 'POST', token, headers: { origin: `http://127.0.0.1:${port + 1}` } }),
    await f.call('/internal/reload', { method: 'POST', token, headers: { 'sec-fetch-site': 'cross-site' } }),
    await f.call('/internal/status', { headers: { 'sec-fetch-site': 'cross-site' } }),
  ];
  assert.deepEqual(rejected.map(response => response.status), [401, 401, 403, 403, 403, 403]);
  const after = f.daemon.inspect();
  assert.equal(after.configGeneration, before.configGeneration);
  assert.equal(after.poolGeneration, before.poolGeneration);
  assert.equal(after.eventsTotal, before.eventsTotal);
  assert.equal(after.reconcileCalls, before.reconcileCalls);
  const latchOf = snapshot => snapshot.accounts.map(({ label, state, windowCaps, upstreamBlocked, resumePending, stopEpoch }) =>
    ({ label, state, windowCaps, upstreamBlocked, resumePending, stopEpoch }));
  assert.deepEqual(latchOf(after), latchOf(before));
  const statusAfter = await f.status();
  assert.deepEqual(statusAfter.next, statusBefore.next);
  assert.deepEqual(statusAfter.accounts.map(account => account.latch), statusBefore.accounts.map(account => account.latch));
  assert.deepEqual(statusAfter.events, statusBefore.events);
});

// --- 秘密の持ち出し --------------------------------------------------------------------------

test('daemon: a replaced token never reaches the log, the status JSON, errors or child arguments', async t => {
  const codex = { behave: () => fakeChild() };
  const f = await fixture(t, { config: { override: false }, codex, generateToken: () => TOKEN_MARKER });
  assert.equal(await f.token(), TOKEN_MARKER);
  await f.tick(1);
  assert.ok(f.isolation.spawnCalls.length >= 1, 'the version was read');
  assert.ok(f.fetchCalls.length >= 1, 'a usage read was sent');
  const statusText = (await f.call('/internal/status')).body;
  assert.equal(isValidCodexStatus(JSON.parse(statusText)), true);
  // reload の失敗（壊れた候補）と成功、拒否。
  await writeConfigFile(f.env, '{ not json');
  const failed = await f.reload();
  assert.equal(failed.status, 422);
  // 待受のポートを変えた候補（起動し直しが要る）。
  await writeConfigFile(f.env, { ...f.settings, daemon: { port: 1 } });
  const restart = await f.reload();
  assert.deepEqual(restart.body, { error: 'restart-required' });
  await writeConfigFile(f.env, f.settings);
  assert.equal((await f.reload()).status, 200);
  await f.call('/internal/reload', { method: 'POST', token: `${TOKEN_MARKER}0` });
  // CLI 側の読取の失敗（0644 にしたファイル）。
  await chmod(f.tokenPath, 0o644);
  let readError;
  await assert.rejects(() => readControlToken({ env: f.env }), error => { readError = error; return true; });
  assert.ok(readError instanceof ControlTokenError);
  await chmod(f.tokenPath, 0o600);
  await f.stop();

  // 起動の失敗: 形の違う値を返す生成関数、待受の失敗。
  const invalid = await assertStartFails(f, CODEX_DAEMON_START_STAGE.tokenWrite, { generateToken: () => `${TOKEN_MARKER}!` });
  const failingServer = () => {
    const server = new EventEmitter();
    server.listen = () => { setImmediate(() => server.emit('error', new Error(TOKEN_MARKER))); return server; };
    server.close = callback => { callback?.(); return server; };
    server.address = () => null;
    return server;
  };
  const listenError = await assertStartFails(f, CODEX_DAEMON_START_STAGE.listen,
    { generateToken: () => TOKEN_MARKER, createServer: failingServer });

  // 読込を待つ間に停止した読み直し（何も適用せず、stopping の語をログに出す）。
  const loader = gatedLoader();
  await f.start({ generateToken: () => TOKEN_MARKER, loadConfig: loader.loadConfig });
  loader.hold();
  const called = loader.nextCall();
  const interrupted = f.call('/internal/reload', { method: 'POST', token: TOKEN_MARKER }).catch(error => error);
  await called;
  await f.stop();
  loader.open();
  await f.waitForLine(record => record.reason === 'stopping', 'the stopping line');
  const interruptedResult = await withDeadline(interrupted, SIGNAL_DEADLINE_MS, 'the interrupted reload');

  // 適用の途中の例外で自分で止まる（検証を通った候補で、口座の key が重なる形）。
  await f.start({ generateToken: () => TOKEN_MARKER, loadConfig: loader.loadConfig });
  const loadedForDuplicate = await loadCodexConfig({ env: f.env });
  loader.replacement = { ...loadedForDuplicate,
    accounts: [loadedForDuplicate.accounts[0], { ...loadedForDuplicate.accounts[0], label: 'zz-b' }] };
  const applyFailed = await f.reload();
  assert.equal(applyFailed.status, 500);
  assert.equal(await withDeadline(f.daemon.stopped, SIGNAL_DEADLINE_MS, 'the stopped reason'), 'apply-failed');
  for (const word of ['restart-required', 'apply-failed', 'stopped', 'stopping']) {
    assert.ok(f.logText().includes(word), `the log has the ${word} line that is searched too`);
  }

  const texts = [f.logText(), statusText, JSON.stringify(failed.body), JSON.stringify(restart.body),
    JSON.stringify(applyFailed.body),
    ...[readError, invalid, listenError, interruptedResult].flatMap(value => (value instanceof Error
      ? errorTexts(value) : [JSON.stringify(value)])),
    JSON.stringify(f.isolation.spawnCalls.map(call => [call.command, call.args]))];
  for (const text of texts) absent(text, TOKEN_MARKER, 'the token marker appears nowhere');
  assert.equal(await exists(f.tokenPath), false);
});

// --- 読み直しとスキーマ ----------------------------------------------------------------------

test('daemon: a failed reload, including one that changes the listen port, keeps the generation, the pool, the accounts and the User-Agent source', async t => {
  const f = await fixture(t, { config: { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] } });
  await f.tick(1);
  const snapshot = async () => {
    const inspected = f.daemon.inspect();
    const json = await f.status();
    return { configGeneration: inspected.configGeneration, poolGeneration: inspected.poolGeneration,
      reconcileCalls: inspected.reconcileCalls, eventsTotal: inspected.eventsTotal,
      labels: json.accounts.map(account => account.label), userAgentSource: json.observation.userAgentSource };
  };
  const before = await snapshot();
  assert.equal(before.userAgentSource, 'config');
  const good = configFor(f.isolation, { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] });
  // 待受のポートを変える候補（口座の並びも入れ替え、適用されていないことを見分けられるようにする）。
  const swapped = [good.accounts[1], good.accounts[0]];
  const { daemon: _daemon, ...withoutDaemon } = good;
  const broken = [
    ['another listen port', configFor(f.isolation, { daemon: { port: 1 } , accounts: [{ label: 'zz-b' }, { label: 'zz-a' }] }),
      0o600, 'restart-required'],
    ['the default listen port', { ...withoutDaemon, accounts: swapped }, 0o600, 'restart-required'],
    ['not JSON', '{ not json', 0o600, 'reload-failed'],
    ['an unknown key', { ...good, zzUnknown: true }, 0o600, 'reload-failed'],
    ['a 0644 file', { ...good, accounts: [good.accounts[1]] }, 0o644, 'reload-failed'],
    ['not activated', { ...good, enabled: false, accounts: [good.accounts[1]] }, 0o600, 'not-activated'],
    ['no risk acknowledgement', { ...good, acknowledgedMultiAccountRisk: false }, 0o600, 'not-activated'],
  ];
  for (const [what, config, mode, word] of broken) {
    await writeConfigFile(f.env, config, mode);
    const response = await f.reload();
    assert.equal(response.status, 422, what);
    assert.deepEqual(response.body, { error: word }, what);
    assert.deepEqual(await snapshot(), before, `${what}: nothing changed`);
  }
  await writeConfigFile(f.env, { ...good, accounts: [good.accounts[1], good.accounts[0]] });
  const ok = await f.reload();
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { reloaded: true, configGeneration: before.configGeneration + 1 });
  const after = await snapshot();
  assert.equal(after.configGeneration, before.configGeneration + 1);
  assert.equal(after.poolGeneration, before.poolGeneration + 1);
  assert.equal(after.reconcileCalls, before.reconcileCalls + 1);
  assert.equal(after.eventsTotal, before.eventsTotal + 1);
  assert.deepEqual(after.labels, ['zz-b', 'zz-a'], 'the new order is applied');
  const json = await f.status();
  assert.deepEqual(json.events.filter(event => event.type === 'reloaded'), [{ at: json.events.at(-1).at, type: 'reloaded', label: null }]);
});

test('daemon: /internal/status passes the schema right after the start, after a reload and with a stopped account', async t => {
  const f = await fixture(t, { respond: ({ clock }) => usageResponse(clock, { primary: fiveHour(80), secondary: weekly(10) }) });
  const first = await f.status();
  assert.equal(isValidCodexStatus(first), true);
  assert.equal(first.source, 'daemon');
  assert.equal(first.daemon.reachable, true);
  assert.equal(accountOf(first, 'zz-a').stateWord, 'starting');
  assert.equal((await f.reload()).status, 200);
  assert.equal(isValidCodexStatus(await f.status()), true);
  await f.tick(MIN);
  const stopped = await f.status();
  assert.equal(accountOf(stopped, 'zz-a').stateWord, 'held');
  assert.equal(accountOf(stopped, 'zz-a').latch.stopped, true);
  assert.equal(isValidCodexStatus(stopped), true);
  assert.equal(stopped.source, 'daemon');
  assert.ok(stopped.events.some(event => event.type === 'stopped' && event.label === 'zz-a'));
});

// --- User-Agent の出どころ -------------------------------------------------------------------------------

test('daemon: the composed User-Agent, the originator, config values and the version markers stay out of the status JSON', async t => {
  const codex = { behave: () => fakeChild({ stdout: [`zz-fake-codex-cli ${VERSION}\n`, `${MARKERS.stdout}\n`],
    stderr: [MARKERS.stderr] }) };
  const f = await fixture(t, { config: { override: false }, codex });
  await f.tick(1);
  assert.equal(f.fetchCalls.length, 1, 'the composed identity was usable');
  const fromVersion = await f.call('/internal/status');
  const fromVersionJson = JSON.parse(fromVersion.body);
  assert.equal(fromVersionJson.observation.userAgentSource, 'codex-version');
  assert.equal(isValidCodexStatus(fromVersionJson), true);

  // 設定の上書きを足して reload すると、次の読取から config になる。
  await writeConfigFile(f.env, configFor(f.isolation));
  assert.equal((await f.reload()).status, 200);
  await f.tick(MIN);
  const fromConfig = await f.call('/internal/status');
  assert.equal(JSON.parse(fromConfig.body).observation.userAgentSource, 'config');

  // 起動エラーの目印（版が読めない）。
  codex.behave = () => fakeChild({ error: new Error(MARKERS.spawnError) });
  await writeConfigFile(f.env, configFor(f.isolation, { override: false }));
  assert.equal((await f.reload()).status, 200);
  await f.tick(MIN);
  const unreadable = await f.call('/internal/status');
  assert.equal(JSON.parse(unreadable.body).observation.userAgentSource, null, 'the version could not be read');
  assert.equal(f.fetchCalls.length, 2, 'no read is sent while the version cannot be read');

  for (const response of [fromVersion, fromConfig, unreadable]) {
    for (const value of [expectedUserAgent(VERSION), CODEX_UA_PRODUCT, CONFIG_USER_AGENT, CONFIG_ORIGINATOR,
      MARKERS.stdout, MARKERS.stderr, MARKERS.spawnError]) {
      absent(response.body, value, 'no User-Agent, originator or marker in the status JSON');
    }
  }
});

test('daemon: the User-Agent source is null when the version cannot be read', async t => {
  const f = await fixture(t, { config: { override: false } });
  await f.tick(1);
  const json = await f.status();
  assert.equal(json.observation.userAgentSource, null);
  assert.equal(accountOf(json, 'zz-a').reason, 'codex-cli-missing');
  assert.equal(f.fetchCalls.length, 0, 'nothing is sent without a User-Agent');
});

test('daemon: the version is cached between reads and read again after each reload', async t => {
  const codex = { behave: () => fakeChild() };
  const f = await fixture(t, { config: { override: false }, codex });
  const spawns = () => f.isolation.spawnCalls.filter(call => call.command === f.codexPath).length;
  await f.tick(1);
  assert.equal(spawns(), 1);
  await f.tick(MIN);
  assert.equal(spawns(), 1, 'the cached version is used while the executable is unchanged');
  for (let i = 0; i < 2; i++) {
    assert.equal((await f.reload()).status, 200);
    await f.tick(MIN);
    assert.equal(spawns(), 2 + i, 'the reload made the resolver start over');
  }
  assert.equal((await f.status()).observation.userAgentSource, 'codex-version');
});

// --- プールの観測方式 ----------------------------------------------------------------------------

test('daemon: an account whose version cannot be read stays unread and is never selected, also after a reload', async t => {
  const f = await fixture(t, { config: { override: false } });
  const check = async () => {
    const json = await f.status();
    const account = accountOf(json, 'zz-a');
    assert.equal(account.stateWord, 'unread');
    assert.equal(account.reason, 'codex-cli-missing');
    assert.equal(account.selectable, false);
    // select() は使用量の分からない口座を選ばない（受動の方式で作ったプールなら selectable になる）。
    assert.equal(json.next.reason === 'selectable', false, 'select() does not choose an account of unknown usage');
    assert.deepEqual(json.next, { label: 'zz-a', reason: 'last-resort' });
    assert.equal(json.pool.state, 'unknown');
    assert.equal(isValidCodexStatus(json), true);
  };
  await f.tick(1);
  await check();
  assert.equal((await f.reload()).status, 200);
  await f.tick(MIN);
  await check();
});

// --- 出来事の記録と reconcile() の回数 ----------------------------------------------------------------------

test('daemon: a window stop dropped from the upstream is recorded once as window-cap-dropped', async t => {
  let shape = 'both';
  const f = await fixture(t, { respond: ({ clock }) => usageResponse(clock, shape === 'both'
    ? { primary: fiveHour(10), secondary: weekly(80, 600) }
    : { primary: fiveHour(10) }) });
  await f.tick(1);
  assert.equal(accountOf(await f.status(), 'zz-a').stateWord, 'held');
  shape = 'primary-only';
  for (let i = 0; i < 9; i++) await f.tick(MIN);
  assert.equal((await f.status()).events.filter(event => event.type === 'window-cap-dropped').length, 0);
  await f.tick(MIN);
  const json = await f.status();
  assert.deepEqual(json.events.filter(event => event.type === 'window-cap-dropped').map(({ type, label }) => ({ type, label })),
    [{ type: 'window-cap-dropped', label: 'zz-a' }]);
  assert.equal(isValidCodexStatus(json), true);
});

test('daemon: two clean reads release a stop across poll cycles, and the daemon never calls reconcile() for them', async t => {
  let high = true;
  const f = await fixture(t, { respond: ({ clock }) => (high
    ? usageResponse(clock, { primary: fiveHour(80), secondary: weekly(10) })
    : lowUsage(clock)) });
  assert.equal(f.daemon.inspect().reconcileCalls, 1, 'once at the start');
  await f.tick(1);
  assert.equal(accountOf(await f.status(), 'zz-a').stateWord, 'held');
  high = false;
  await f.tick(MIN);
  const oneVote = await f.status();
  assert.equal(accountOf(oneVote, 'zz-a').latch.cleanReadsDone, 1);
  assert.equal(f.daemon.inspect().reconcileCalls, 1);
  await f.tick(MIN);
  const released = await f.status();
  assert.equal(accountOf(released, 'zz-a').stateWord, 'ready');
  assert.equal(accountOf(released, 'zz-a').latch, null);
  assert.deepEqual(released.events.map(event => event.type), ['stopped', 'released']);
  assert.equal(f.daemon.inspect().reconcileCalls, 1, 'still only the start');
});

// --- 射影の例外・models・/internal/health ------------------------------------------------

test('daemon: a projection that throws gives 500 with a fixed body', async t => {
  let broken = false;
  const clockHolder = {};
  const f = await fixture(t, { now: () => (broken ? Number.NaN : clockHolder.now()), start: false });
  clockHolder.now = f.clock.now;
  await f.start();
  broken = true;
  const response = await f.call('/internal/status');
  broken = false;
  assert.equal(response.status, 500);
  assert.equal(response.body, '{"error":"internal-error"}');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(f.lines.some(line => JSON.parse(line).event === 'codex_daemon_status_failed'));
  assert.equal((await f.call('/internal/status')).status, 200, 'the daemon keeps running');
});

test('daemon: the account entries carry no models, and the pool never has a models list', async t => {
  const f = await fixture(t, { config: { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] } });
  const loaded = await loadCodexConfig({ env: f.env });
  const entries = codexAccountEntries(loaded);
  assert.deepEqual(entries.pool.map(entry => Object.keys(entry).sort()), [['key', 'label'], ['key', 'label']]);
  assert.deepEqual(entries.poller.map(entry => Object.keys(entry).sort()), [['home', 'key', 'label'], ['home', 'key', 'label']]);
  assert.deepEqual(entries.poller.map(entry => entry.home), loaded.accounts.map(account => account.codexHome));
  assert.deepEqual(entries.pool.map(entry => entry.key), loaded.accounts.map(account => account.codexHome),
    'the key is the validated codexHome');
  assert.deepEqual(f.daemon.inspect().accounts.map(entry => entry.models), [null, null]);
  assert.equal((await f.reload()).status, 200);
  assert.deepEqual(f.daemon.inspect().accounts.map(entry => entry.models), [null, null]);
  const json = await f.status();
  for (const account of loaded.accounts) absent(JSON.stringify(json), account.codexHome, 'no account folder in the JSON');
  for (const account of loaded.accounts) absent(f.logText(), account.codexHome, 'no account folder in the log');
  assert.throws(() => codexAccountEntries({}), TypeError);
  assert.throws(() => codexAccountEntries({ accounts: [{ label: 'zz-a' }] }), TypeError);
});

test('daemon: /internal/health answers fixed keys only, whatever the pool holds', async t => {
  let high = true;
  const f = await fixture(t, { respond: ({ clock }) => (high
    ? usageResponse(clock, { primary: fiveHour(80), secondary: weekly(10) })
    : lowUsage(clock)) });
  const keysOf = async () => {
    const response = await f.call('/internal/health');
    assert.equal(response.status, 200);
    return Object.keys(JSON.parse(response.body)).sort();
  };
  const first = await keysOf();
  assert.deepEqual(first, ['ok', 'provider', 'startedAt']);
  await f.tick(1);
  assert.deepEqual(await keysOf(), first, 'a stopped account adds nothing');
  high = false;
  assert.equal((await f.reload()).status, 200);
  await f.tick(MIN);
  assert.deepEqual(await keysOf(), first);
  const body = JSON.parse((await f.call('/internal/health')).body);
  assert.equal(body.ok, true);
});

// --- reload の直列化 -------------------------------------------------------------------------------

test('daemon: a reload while another is running is 409, and the in-progress mark is cleared afterwards', async t => {
  const loader = gatedLoader();
  const f = await fixture(t, { loadConfig: loader.loadConfig });
  const token = await f.token();
  loader.hold();
  const called = loader.nextCall();
  // 拒否の受け手は、要求を始めるのと同時に付ける（処理されない拒否を残さない）。
  const first = f.call('/internal/reload', { method: 'POST', token }).catch(error => error);
  // 1つ目の読み直しが読込に入ったことを合図で確かめてから、2つ目を送る。
  await called;
  const second = await f.call('/internal/reload', { method: 'POST', token });
  assert.equal(second.status, 409);
  assert.deepEqual(JSON.parse(second.body), { error: 'reload-in-progress' });
  loader.open();
  assert.equal((await withDeadline(first, SIGNAL_DEADLINE_MS, 'the first reload')).status, 200);
  assert.equal(f.daemon.inspect().configGeneration, 2, 'only the first reload advanced the generation');
  const next = await f.call('/internal/reload', { method: 'POST', token });
  assert.equal(next.status, 200, 'the in-progress mark was cleared');
  assert.equal(f.daemon.inspect().configGeneration, 3);
});

// 適用の途中の例外で自分で止まった後の確かめ: 止まった理由・接続の拒否・トークンのファイル・世代。
async function assertStoppedByApplyFailure(f, port, generation) {
  assert.equal(await withDeadline(f.daemon.stopped, SIGNAL_DEADLINE_MS, 'the stopped reason'), 'apply-failed');
  await assert.rejects(() => requestLocal({ request: f.isolation.request, port, path: '/internal/health' }),
    error => error.code === 'ECONNREFUSED');
  assert.equal(await exists(f.tokenPath), false, 'the token file was removed');
  assert.equal(f.daemon.inspect().configGeneration, generation, 'the generation did not advance');
}

test('daemon: a reload that passes the checks but fails before anything is applied answers 500 and stops the daemon', async t => {
  let replacement = null;
  const loadConfig = async options => replacement ?? loadCodexConfig(options);
  const f = await fixture(t, { loadConfig });
  const port = f.daemon.port;
  // 検証を通った候補で、口座の key が重なる形（reconcile() が最初に投げる）。
  const loaded = await loadCodexConfig({ env: f.env });
  replacement = { ...loaded, accounts: [loaded.accounts[0], { ...loaded.accounts[0], label: 'zz-b' }] };
  const broken = await f.call('/internal/reload', { method: 'POST', token: await f.token() });
  assert.equal(broken.status, 500);
  assert.equal(broken.body, '{"error":"internal-error"}', 'the 500 reached the client before the daemon stopped');
  await assertStoppedByApplyFailure(f, port, 1);
});

test('daemon: a reload that fails after its first change was applied answers 500 and stops the daemon', async t => {
  // registerSecret を、起動の後の呼出しから失敗させる（起動時の登録には影響させない。回数で切り替える）。
  let calls = 0;
  let failFrom = Infinity;
  const wrapLogger = logger => ({ ...logger, registerSecret: value => {
    calls++;
    if (calls >= failFrom) throw new Error(`zz-register-failed ${value}`);
    logger.registerSecret(value);
  } });
  const f = await fixture(t, { wrapLogger });
  const port = f.daemon.port;
  const token = await f.token();
  const before = f.daemon.inspect();
  failFrom = calls + 1;
  // 同じ設定の読み直し: reconcile() とプールの configure() は済み、版の読取の reload() で上書きの値を
  // 秘密として登録するところで投げる。
  const broken = await f.call('/internal/reload', { method: 'POST', token });
  assert.equal(broken.status, 500);
  assert.equal(broken.body, '{"error":"internal-error"}');
  assert.equal(f.daemon.inspect().poolGeneration, before.poolGeneration + 1, 'the first changes were applied');
  assert.equal(f.daemon.inspect().reconcileCalls, before.reconcileCalls + 1);
  await assertStoppedByApplyFailure(f, port, before.configGeneration);
  for (const line of f.lines) {
    const record = JSON.parse(line);
    assert.equal(Object.hasOwn(record, 'message'), false, 'the log has no free text');
  }
  absent(f.logText(), 'zz-register-failed', 'the exception message is not logged');
});

test('daemon: stop() reports the stopped reason', async t => {
  const f = await fixture(t);
  await f.stop();
  assert.equal(await f.daemon.stopped, 'stopped');
  await f.stop();
  assert.equal(await f.daemon.stopped, 'stopped');
});

// --- 起動の失敗の後片付けと、停止の後 ---------------------------------------------------------------

test('daemon: a failure after listening closes the server, stops the reads and removes the token file', async t => {
  const f = await fixture(t, { start: false });
  let created = null;
  const notLoopback = handler => {
    created = createHttpServer(handler);
    const realAddress = created.address.bind(created);
    created.address = () => ({ ...realAddress(), address: '0.0.0.0' });
    return created;
  };
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.listen, { createServer: notLoopback });
  assert.equal(created.listening, false, 'the server was closed');
  assert.equal(await exists(f.tokenPath), false, 'the token file was removed');
  await f.tick(10 * MIN);
  assert.equal(f.credentialReads.length, 0, 'the reads were stopped (no timer left)');
  assert.equal(f.fetchCalls.length, 0);
});

test('daemon: after stop the port refuses connections and no timer keeps reading', async t => {
  const f = await fixture(t);
  await f.tick(1);
  const reads = f.fetchCalls.length;
  assert.equal(reads, 1);
  const port = f.daemon.port;
  await f.stop();
  await assert.rejects(() => requestLocal({ request: f.isolation.request, port, path: '/internal/health' }),
    error => error.code === 'ECONNREFUSED');
  await f.tick(10 * MIN);
  assert.equal(f.fetchCalls.length, reads, 'no read after stop');
  assert.equal(f.servers[0].listening, false);
});

test('daemon: stop removes the remembered token file even if env is changed after the start', async t => {
  const isolation = await setupCodexIsolation(t);
  const env = { ...isolation.env };
  const clock = createFakeClock({ startMs: START });
  await writeConfigFile(env, configFor(isolation));
  const tokenPath = controlTokenPath(env);
  const daemon = await startCodexDaemon({ env, spawn: isolation.spawn, now: clock.now,
    scheduler: createFakeScheduler(clock), logger: createCodexLogger({ write: () => {} }),
    fetchImpl: async () => { throw new Error('zz-no-upstream'); } });
  t.after(() => daemon.stop());
  const otherConfigHome = join(isolation.root, 'zz-other-config');
  env.XDG_CONFIG_HOME = otherConfigHome;
  const otherPath = controlTokenPath(env);
  await mkdir(dirname(otherPath), { recursive: true, mode: 0o700 });
  await writeFile(otherPath, JSON.stringify({ token: TOKEN_MARKER }), { mode: 0o600 });
  assert.equal(await exists(tokenPath), true);
  await daemon.stop();
  assert.equal(await exists(tokenPath), false, 'the remembered file is removed');
  assert.equal(await exists(otherPath), true, 'the file the changed env points at is untouched');
});

// --- 起動時の時計の例外・読み直しの前に始まった版読取 ------------------------------------------------

test('daemon: a clock that throws while the daemon is assembled gives a staged error and leaves no token file', async t => {
  const f = await fixture(t, { start: false });
  await assertStartFails(f, CODEX_DAEMON_START_STAGE.assemble, { now: () => { throw new Error(TOKEN_MARKER); } });
  assert.equal(await exists(f.tokenPath), false);
  assert.equal(f.createServerCalls.length, 0, 'the server is never created');
  absent(f.logText(), TOKEN_MARKER, 'the clock error is not logged');
});

test('daemon: a version read that began before a reload does not set the User-Agent source after it', async t => {
  const children = [];
  // 版の出力を、テストが finish() を呼ぶまで出さない偽の子。
  const heldChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = signal => { setImmediate(() => child.emit('close', null, signal)); return true; };
    child.finish = () => {
      child.stdout.emit('data', Buffer.from(`zz-fake-codex-cli ${VERSION}\n`));
      child.emit('close', 0, null);
    };
    children.push(child);
    return child;
  };
  const f = await fixture(t, { config: { override: false }, codex: { behave: heldChild } });
  await f.tick(1);
  assert.equal(children.length, 1, 'the version read has begun');
  await writeConfigFile(f.env, configFor(f.isolation));
  assert.equal((await f.reload()).status, 200);
  children[0].finish();
  await flush();
  assert.equal((await f.status()).observation.userAgentSource, null, 'the stale result is not remembered');
  await f.tick(MIN);
  assert.equal((await f.status()).observation.userAgentSource, 'config', 'the next read sets it');
});

// --- トークンのファイルの所有を確かめた削除 ---------------------------------------------------------

const OTHER_TOKEN_MARKER = 'ZZOTHERTOKENMARKER'.repeat(2);

test('daemon: a token file replaced with another value survives stop() and the cleanup of a failed start', async t => {
  const f = await fixture(t, { generateToken: () => TOKEN_MARKER });
  await writeFile(f.tokenPath, JSON.stringify({ token: OTHER_TOKEN_MARKER }), { mode: 0o600 });
  await f.stop();
  assert.equal(await f.daemon.stopped, 'stopped');
  assert.equal(await readControlToken({ env: f.env }), OTHER_TOKEN_MARKER, 'stop() left the other value alone');

  // 待受の直前に別の値へ置き換わり、待受が失敗した起動。
  const replacingServer = () => {
    const server = new EventEmitter();
    server.listen = () => {
      writeFile(f.tokenPath, JSON.stringify({ token: OTHER_TOKEN_MARKER }), { mode: 0o600 })
        .then(() => server.emit('error', new Error('zz-listen-failed')));
      return server;
    };
    server.close = callback => { callback?.(); return server; };
    server.address = () => null;
    return server;
  };
  const error = await assertStartFails(f, CODEX_DAEMON_START_STAGE.listen, { createServer: replacingServer });
  assert.equal(await readControlToken({ env: f.env }), OTHER_TOKEN_MARKER, 'the cleanup left the other value alone');
  for (const text of [f.logText(), ...errorTexts(error)]) {
    absent(text, OTHER_TOKEN_MARKER, 'the replaced value appears nowhere');
    absent(text, f.tokenPath, 'the token path appears nowhere');
  }
});

test('daemon: a token write that fails after the rename is removed by the cleanup of the failed start', async t => {
  const f = await fixture(t, { start: false });
  // 名前の置き換えまでは済み、その後の同期が失敗する書込。
  const writeTokenFile = async (target, value, mode) => {
    await writeFile(target, JSON.stringify(value), { mode });
    await chmod(target, mode);
    throw new Error(`zz-sync-failed ${TOKEN_MARKER} ${target}`);
  };
  const error = await assertStartFails(f, CODEX_DAEMON_START_STAGE.tokenWrite,
    { generateToken: () => TOKEN_MARKER, writeTokenFile });
  assert.equal(await exists(f.tokenPath), false, 'the own value was removed');
  assert.equal(f.createServerCalls.length, 0);
  for (const text of [f.logText(), ...errorTexts(error)]) {
    absent(text, TOKEN_MARKER, 'the token appears nowhere');
    absent(text, f.tokenPath, 'the token path appears nowhere');
  }
});

// --- 読み直しの途中の切断と停止 ------------------------------------------------------------------

// 読込を待たせられる設定の読込。replacement を入れると、その値を返す。
// nextCall() は、次に読込が呼ばれたときに解決する合図を返す（要求を出す前に取る）。
function gatedLoader() {
  const state = { loads: 0, gate: null, release: null, replacement: null, onCall: null };
  state.loadConfig = async options => {
    state.loads++;
    const onCall = state.onCall;
    state.onCall = null;
    onCall?.();
    if (state.gate) await state.gate;
    return state.replacement ?? loadCodexConfig(options);
  };
  state.nextCall = () => withDeadline(new Promise(resolve => { state.onCall = resolve; }), SIGNAL_DEADLINE_MS,
    'the config read of the reload');
  state.hold = () => { state.gate = new Promise(resolve => { state.release = resolve; }); };
  state.open = () => { state.gate = null; state.release?.(); };
  return state;
}

// 常駐の側で開いている接続が無くなるまで待つ（実時間で短く待ちながら）。
async function untilNoConnections(server) {
  for (let i = 0; i < 200; i++) {
    const count = await new Promise(resolve => server.getConnections((error, n) => resolve(error ? -1 : n)));
    if (count === 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('the connection was not closed on the daemon side');
}

test('daemon: a reload whose client disconnected before a failed apply still stops the daemon', { timeout: 10_000 }, async t => {
  const loader = gatedLoader();
  const f = await fixture(t, { loadConfig: loader.loadConfig });
  const port = f.daemon.port;
  const token = await f.token();
  const loaded = await loadCodexConfig({ env: f.env });
  loader.hold();
  // 隔離の要求関数をそのまま使い、作った要求だけを控える（切断させるため。振る舞いは変えない）。
  const requests = [];
  const request = (...args) => {
    const req = f.isolation.request(...args);
    requests.push(req);
    return req;
  };
  const called = loader.nextCall();
  // 拒否の受け手は、要求を始めるのと同時に付ける（処理されない拒否を残さない）。
  const outcome = requestLocal({ request, port, path: '/internal/reload', method: 'POST',
    headers: { [CONTROL_TOKEN_HEADER]: token }, timeoutMs: SIGNAL_DEADLINE_MS })
    .then(() => null, error => error);
  // 常駐が読込に入ったことを合図で確かめてから、相手の側で要求を壊して切断する。
  await called;
  assert.equal(requests.length, 1);
  requests[0].destroy();
  const cut = await withDeadline(outcome, SIGNAL_DEADLINE_MS, 'the client side of the cut request');
  assert.ok(cut instanceof Error, 'the client saw the request fail');
  assert.equal(cut.name, 'LocalHttpError');
  await untilNoConnections(f.servers.at(-1));
  // 検証を通った候補で、適用の途中（reconcile()）で投げる形。
  loader.replacement = { ...loaded, accounts: [loaded.accounts[0], { ...loaded.accounts[0], label: 'zz-b' }] };
  loader.open();
  await assertStoppedByApplyFailure(f, port, 1);
});

test('daemon: a reload whose config read returns after stop() applies nothing', { timeout: 10_000 }, async t => {
  const loader = gatedLoader();
  const f = await fixture(t, { loadConfig: loader.loadConfig, config: { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] } });
  const token = await f.token();
  const loaded = await loadCodexConfig({ env: f.env });
  const before = f.daemon.inspect();
  loader.hold();
  const called = loader.nextCall();
  const pending = f.call('/internal/reload', { method: 'POST', token }).catch(error => error);
  await called;
  await f.stop();
  assert.equal(await f.daemon.stopped, 'stopped');
  // 読込は、口座の並びを入れ替えた正しい候補を返す（適用されたら見分けられる）。
  loader.replacement = { ...loaded, accounts: [loaded.accounts[1], loaded.accounts[0]] };
  loader.open();
  // 読み直しが「停止中なので何もしない」と決めた合図（stopping の行）を待つ。
  await f.waitForLine(record => record.reason === 'stopping', 'the stopping line');
  await withDeadline(pending, SIGNAL_DEADLINE_MS, 'the interrupted reload');
  const after = f.daemon.inspect();
  assert.equal(after.configGeneration, before.configGeneration, 'the generation did not change');
  assert.equal(after.poolGeneration, before.poolGeneration, 'the pool generation did not change');
  assert.equal(after.reconcileCalls, before.reconcileCalls);
  assert.deepEqual(after.accounts.map(entry => entry.label), ['zz-a', 'zz-b']);
  const events = f.lines.map(line => JSON.parse(line).event);
  const stoppedAt = events.indexOf('codex_daemon_stopped');
  assert.ok(stoppedAt >= 0);
  assert.equal(events.slice(stoppedAt).includes('codex_daemon_reloaded'), false, 'no reload after the stop');
  assert.ok(f.lines.some(line => JSON.parse(line).reason === 'stopping'));
});
