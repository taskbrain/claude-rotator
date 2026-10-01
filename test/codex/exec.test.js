// `codex-rotator exec`（src/codex/exec.js）のテスト。常駐を使わない経路と、常駐へ問い合わせて口座を
// 選ぶ経路（設定の sha256 の照合と config stale を含む）。
//
// 絶対条件: 実のホーム・実の設定ファイル・実の口座のフォルダ・~/.codex には触れない。env は隔離の
// 補助の一時フォルダのもので、設定・口座のフォルダ・偽の資格情報・偽の ~/.codex・制御トークンの
// ファイルはすべてその中に作る。本物の codex は起動しない（子の起動は隔離の補助の spawn を通し、登録した
// 偽物だけを返す）。使用量の読取は偽の fetch だけを使う。シグナルの受け口と、自分へシグナルを当て直す
// 処理は偽物を渡し、テストの実行器のプロセスには受け口を付けない。偽の資格情報と制御トークンの中身は
// 合成の値である。常駐は、テストの中でポート0で待ち受けた偽の常駐か本物の常駐だけで、実際の番号を
// allowRequest に登録し、要求関数は隔離の補助の request を渡す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_CONFIG_TOML, FIRST_LAYER_ARGS, NO_DAEMON_ARG } from '../../src/codex/account-config.js';
import { composeClientIdentity } from '../../src/codex/client-version.js';
import { DEFAULT_DAEMON_PORT, loadCodexConfigSnapshot, removeCodexAccount } from '../../src/codex/config.js';
import { CONTROL_TOKEN_HEADER, readControlToken } from '../../src/codex/control-token.js';
import {
  CODEX_DAEMON_PATHS, CODEX_SELECT_OUTCOME, CODEX_SELECT_REFUSAL, startCodexDaemon,
} from '../../src/codex/daemon.js';
import {
  EXEC_DAEMON_TIMEOUT_MS, EXEC_LINE, EXEC_USAGE, FORWARDED_SIGNALS, createOneShotUsageReader, formatConfigStaleGuidance,
  formatLastResortWarning, formatVerdictLine, parseExecArgs, runExec, verdictWordOf,
} from '../../src/codex/exec.js';
import { main } from '../../src/codex/cli.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { codexRotatorConfigDir, codexRotatorConfigPath, controlTokenPath } from '../../src/codex/paths.js';
import { CODEX_STATE_OF_WORD } from '../../src/shared/codex-status-schema.js';
import { requestLocal } from '../../src/shared/local-http.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from './helpers/isolation.js';

// 固定の時計（2026-01-02T03:04:05.678Z）。
const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
// パスに含める合成の目印（標準エラーに出てはならない）。
const PATH_MARKER = 'ZZ-PATH-MARKER';
// 偽の資格情報と上流の応答に入れる合成の値（標準エラーに出てはならない）。
const TOKEN_MARKER = 'ZZTOKENMARKER'.repeat(3);
const FAKE_EMAIL = 'zz-fake-user@example.invalid';
const FAKE_REFRESH_TOKEN = `rt_zz_fake_${'9'.repeat(32)}`;
const FAKE_USER_ID = 'zz-user-id-marker';
const FAKE_VERSION = [9, 8, 7].join('.');
// 偽の ~/.codex に置く目印。
const HOME_CODEX_MARKER = 'ZZ-HOME-CODEX-MARKER';
// 偽の常駐の制御トークン（ヘッダに載せてよい文字だけの40文字。どの出力にも出てはならない）。
const CONTROL_TOKEN = 'ZZCONTROLTOKENMARKER'.repeat(2);
// 偽の常駐が応答に入れる、口座のフォルダの目印（起動する子に渡ってはならない）。
const DAEMON_HOME_MARKER = 'ZZ-DAEMON-HOME-MARKER';
// 接続してはならない番号（Claude 側の待受・常駐の既定・登録していない番号の例）。
const UNREGISTERED_SERVICE_PORT = 18765;
const FORBIDDEN_PORTS = Object.freeze([...REAL_SERVICE_PORTS, UNREGISTERED_SERVICE_PORT]);

const policy = (overrides = {}) => ({ stopUsedPercent: 90, resumeUsedPercent: 50, ...overrides });

const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = claims => `${base64url({ alg: 'none' })}.${base64url(claims)}.${'Z'.repeat(24)}`;
const accountIdOf = label => `zz-account-id-${label}-marker`;

function authJson(label, { expired = false } = {}) {
  const expSeconds = Math.floor((expired ? FIXED_NOW_MS - 3600000 : FIXED_NOW_MS + 3600000) / 1000);
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: fakeJwt({ email: FAKE_EMAIL, 'https://api.openai.com/auth': { chatgpt_account_id: accountIdOf(label) } }),
      access_token: fakeJwt({ exp: expSeconds, zz: TOKEN_MARKER }),
      refresh_token: FAKE_REFRESH_TOKEN,
      account_id: accountIdOf(label),
    },
  });
}

function secretValues(labels) {
  return [PATH_MARKER, TOKEN_MARKER, FAKE_EMAIL, FAKE_REFRESH_TOKEN, FAKE_USER_ID, HOME_CODEX_MARKER, FAKE_VERSION,
    CONTROL_TOKEN, DAEMON_HOME_MARKER, ...labels.map(accountIdOf)];
}

function captureStream() {
  const chunks = [];
  return { chunks, write(chunk) { chunks.push(String(chunk)); return true; }, text() { return chunks.join(''); } };
}

// --- 偽の子プロセス ---------------------------------------------------------------------------

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.pid = 4242;
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

// 標準出力を出して、指定の終わり方で閉じる子。
function finishingChild({ stdout = '', code = 0, signal = null } = {}) {
  const child = fakeChild();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code, signal);
  });
  return child;
}

const GOOD_FEATURES = 'apps                 stable   false\nplugins              stable   false\nshell_tool           stable   true\n';

function kindOf(args) {
  if (args.length === 1 && args[0] === '--version') return 'version';
  if (args.slice(-2).join(' ') === 'features list') return 'features';
  if (args.slice(-3).join(' ') === 'mcp list --json') return 'mcp';
  return 'launch';
}

// --- 偽の使用量の読取 -------------------------------------------------------------------------

function usageBody({ primary = 10, secondary = 10, allowed = true } = {}) {
  return {
    email: FAKE_EMAIL,
    user_id: FAKE_USER_ID,
    rate_limit: {
      allowed,
      primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_after_seconds: 600 },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604800, reset_after_seconds: 6000 },
    },
  };
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 口座のラベルごとに応答を返す偽の fetch。呼出しは calls に残る（ヘッダの値は残さない）。
function fakeFetch(respondFor) {
  const calls = [];
  const impl = async (url, init) => {
    const accountId = init.headers['ChatGPT-Account-ID'];
    const label = accountId.replace(/^zz-account-id-/, '').replace(/-marker$/, '');
    calls.push({ url: String(url), label, method: init.method });
    return respondFor(label, init);
  };
  return { impl, calls };
}

// --- 偽の常駐 -----------------------------------------------------------------------------------

/**
 * ポート0で待ち受ける偽の常駐。受けた要求（方法・パス・ヘッダ・本文）を requests に残し、answer(request)
 * の戻り値 { status?, body } で答える（body が文字列でなければ JSON にする）。answer が null を返したら
 * 答えない（期限切れを確かめる）。{ cutOff: true } を返したら、200 の本文の途中で接続を切る。{ stall: true } を
 * 返したら、200 のヘッダと本文の一部を書いて、接続を開いたまま止まる。実際の番号が接続してはならない番号に
 * 当たったら、閉じて待ち受け直す。
 */
async function startFakeDaemon(t, isolation, answer) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const requests = [];
    const server = createHttpServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const request = { method: req.method, url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString('utf8') };
        requests.push(request);
        const reply = answer(request);
        if (reply === null) return;
        if (reply.cutOff) {
          // 本文の途中で接続を切る（宣言した大きさより短いところで、書き出した後に切る）。
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096', connection: 'close' });
          res.write('{"outcome":', () => res.socket?.destroy());
          return;
        }
        if (reply.stall) {
          // 200 のヘッダと本文の一部を書き、閉じずに止まる（後始末は待受けを閉じるときの closeAllConnections）。
          res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096', connection: 'close' });
          res.write('{"outcome":');
          return;
        }
        const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', connection: 'close' });
        res.end(text);
      });
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const close = () => new Promise(resolveClose => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    });
    const { port } = server.address();
    if (FORBIDDEN_PORTS.includes(port)) {
      await close();
      continue;
    }
    t.after(close);
    isolation.allowRequest(port);
    return { port, requests };
  }
  throw new Error('the system kept assigning a port that must not be used');
}

// --- 準備 -------------------------------------------------------------------------------------

/**
 * 隔離の一時フォルダに、設定・口座のフォルダ・偽の資格情報・rollout・偽の ~/.codex・偽の codex を作る。
 * @param {{
 *   accounts?: Array<{ label: string, usagePolicy?: object, creds?: 'ok'|'expired'|'missing' }>,
 *   enabled?: boolean, acknowledged?: boolean, config?: boolean, codexInstalled?: boolean,
 *   version?: 'ok'|'fail', features?: string, mcp?: string, usageReadTimeoutMs?: number,
 *   launch?: (child: object) => void,
 *   daemon?: (context: { request: object, sha256: string }) => { status?: number, body: unknown }|null,
 *   daemonPort?: number, controlToken?: boolean, extraConfig?: object,
 * }} [options] daemon を渡すと偽の常駐を起動し、設定の daemon.port をその番号にする（daemonPort を渡すと、
 *   その値を daemon.port に書く）。controlToken が真（daemon を渡したときの既定）なら、制御トークンの
 *   ファイルを 0600 で置く。daemon に渡す sha256 は、今の設定ファイルを読込みの関数で読んだ値。
 */
async function fixture(t, {
  accounts = [{ label: 'alpha' }], enabled = true, acknowledged = true, config = true, codexInstalled = true,
  version = 'ok', features = GOOD_FEATURES, mcp = '[]\n', usageReadTimeoutMs, launch,
  daemon, daemonPort, controlToken = daemon !== undefined, extraConfig = {},
} = {}) {
  const isolation = await setupCodexIsolation(t);
  const { env, home, root } = isolation;
  // 設定ファイルの今の sha256（daemon の応答を作るときに読む）。
  const state = { sha256: null };
  const fake = daemon === undefined ? null
    : await startFakeDaemon(t, isolation, request => daemon({ request, sha256: state.sha256 }));
  const accountsDir = join(home, 'zz-accounts');
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  await chmod(accountsDir, 0o700);

  const homes = {};
  for (const account of accounts) {
    const codexHome = join(accountsDir, `${PATH_MARKER}-${account.label}`);
    homes[account.label] = codexHome;
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(codexHome, 'config.toml'), ACCOUNT_CONFIG_TOML, { mode: 0o600 });
    const creds = account.creds ?? 'ok';
    if (creds !== 'missing') {
      await writeFile(join(codexHome, 'auth.json'), authJson(account.label, { expired: creds === 'expired' }), { mode: 0o600 });
    }
    const day = join(codexHome, 'sessions', '2026', '01', '02');
    await mkdir(day, { recursive: true, mode: 0o700 });
    await writeFile(join(day, `rollout-2026-01-02T03-04-05-${account.label}.jsonl`), '{"zz":"rollout"}\n', { mode: 0o600 });
  }

  // 偽の ~/.codex（目印の入った偽物。開かれてはならない）。
  const homeCodex = join(home, '.codex');
  await mkdir(homeCodex, { recursive: true, mode: 0o700 });
  await writeFile(join(homeCodex, 'config.toml'), `# ${HOME_CODEX_MARKER}\n`, { mode: 0o600 });
  await writeFile(join(homeCodex, 'AGENTS.md'), `${HOME_CODEX_MARKER}\n`, { mode: 0o600 });

  // 偽の codex（実行できるファイルを置くだけで、実行はしない）。
  const codexPath = join(root, 'zz-bin', 'codex');
  if (codexInstalled) {
    await mkdir(join(root, 'zz-bin'), { recursive: true, mode: 0o700 });
    await writeFile(codexPath, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  }

  const folder = codexRotatorConfigDir(env);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  let raw = null;
  // 設定ファイルを書き、読込みの関数で読んだ sha256 を覚える。
  const writeConfig = async nextRaw => {
    raw = nextRaw;
    await writeFile(codexRotatorConfigPath(env), JSON.stringify(raw), { mode: 0o600 });
    state.sha256 = (await loadCodexConfigSnapshot({ env })).sha256;
  };
  if (config) {
    const port = fake?.port ?? daemonPort;
    await writeConfig({
      enabled,
      acknowledgedMultiAccountRisk: acknowledged,
      accountsDir,
      ...(codexInstalled ? { codexPath } : {}),
      ...(usageReadTimeoutMs ? { usageReadTimeoutMs } : {}),
      ...(port === undefined ? {} : { daemon: { port } }),
      ...extraConfig,
      accounts: accounts.map(account => ({ label: account.label, codexHome: homes[account.label],
        usagePolicy: account.usagePolicy ?? policy() })),
    });
  }
  if (controlToken) await writeFile(controlTokenPath(env), JSON.stringify({ token: CONTROL_TOKEN }), { mode: 0o600 });

  const launches = [];
  const spawnCalls = [];
  isolation.registerSpawn(codexPath, (args, options) => {
    const kind = kindOf(args);
    spawnCalls.push({ kind, args, options });
    if (kind === 'version') return finishingChild(version === 'ok' ? { stdout: `codex-cli ${FAKE_VERSION}\n` } : { code: 1 });
    if (kind === 'features') return finishingChild({ stdout: features });
    if (kind === 'mcp') return finishingChild({ stdout: mcp });
    const child = fakeChild();
    launches.push({ args, options, child });
    if (launch) launch(child);
    else setImmediate(() => child.emit('close', 0, null));
    return child;
  });

  const signals = new EventEmitter();
  const raised = [];
  const deps = {
    spawn: isolation.spawn,
    // 常駐への要求は隔離の補助の要求関数だけを通す（登録した番号のほかは開く手前で拒否される）。
    request: isolation.request,
    now: () => FIXED_NOW_MS,
    processCwd: () => root,
    signals: { on: (signal, handler) => signals.on(signal, handler), off: (signal, handler) => signals.off(signal, handler) },
    raiseSignal: signal => raised.push(signal),
  };

  const run = async (argv, extraDeps = {}) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runExec(argv, { stdout, stderr, env }, { ...deps, ...extraDeps });
    return { code, stdout, stderr, lines: stderr.text().split('\n').filter(Boolean) };
  };

  return {
    isolation, env, home, root, codexPath, homes, launches, spawnCalls, signals, raised, run, writeConfig,
    daemonPort: fake?.port ?? null,
    daemonRequests: fake?.requests ?? [],
    raw: () => raw,
    sha256: () => state.sha256,
  };
}

const launchCount = f => f.launches.length;

function assertNoLeaks(result, labels) {
  const text = result.stderr.text();
  for (const secret of secretValues(labels)) assert.ok(!text.includes(secret), 'standard error carries no secret, path or header value');
  assert.equal(result.stdout.chunks.length, 0, 'exec itself writes nothing to standard output');
}

// --- 引数の読取 ---------------------------------------------------------------------------------

test('reads --account and the words after the separator', () => {
  assert.deepEqual(parseExecArgs(['--account', 'alpha', '--', '--version']), { ok: true, account: 'alpha', codexArgs: ['--version'] });
  assert.deepEqual(parseExecArgs(['--', 'exec', '--json', '-']), { ok: true, account: null, codexArgs: ['exec', '--json', '-'] });
  assert.deepEqual(parseExecArgs([]), { ok: true, account: null, codexArgs: [] });
  for (const argv of [['--version'], ['--account'], ['--account', 'Bad Label', '--'], ['--account', 'a', '--account', 'b', '--'],
    ['--account=alpha', '--'], ['zz', '--']]) {
    assert.equal(parseExecArgs(argv).ok, false);
  }
});

test('prints the usage line and exits 2 for a malformed exec argument list, without reading anything', async t => {
  const f = await fixture(t);
  const result = await f.run(['--account']);
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, [EXEC_USAGE]);
  assert.equal(f.spawnCalls.length, 0);
});

// --- 判定の語の7通り ----------------------------------------------------------------------------

const VERDICT_CASES = [
  { name: '200', respond: () => jsonResponse(usageBody()), word: 'ok' },
  { name: '401', respond: () => jsonResponse({ detail: FAKE_EMAIL }, 401), word: 'unauthorized' },
  { name: '403', respond: () => jsonResponse({}, 403), word: 'forbidden' },
  { name: '400', respond: () => jsonResponse({}, 400), word: 'client-error 400' },
  { name: '422', respond: () => jsonResponse({}, 422), word: 'client-error 422' },
];

for (const { name, respond, word } of VERDICT_CASES) {
  test(`prints the verdict word "${word}" for an upstream ${name} response`, async t => {
    const f = await fixture(t, { accounts: [{ label: 'alpha' }] });
    const fetch = fakeFetch(respond);
    const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
    assert.equal(fetch.calls.length, 1);
    assert.ok(result.lines.includes(formatVerdictLine('alpha', word)), `verdict line for ${name}`);
    assertNoLeaks(result, ['alpha']);
  });
}

test('prints the verdict word "timeout" when the usage read runs past its deadline', async t => {
  const f = await fixture(t, { usageReadTimeoutMs: 1000 });
  // 読取の期限のタイマーは unref されているので、中断されるまでイベントループを保つタイマーを持つ。
  const fetch = fakeFetch((_label, init) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 10000);
    init.signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(init.signal.reason);
    }, { once: true });
  }));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.ok(result.lines.includes(formatVerdictLine('alpha', 'timeout')));
  assertNoLeaks(result, ['alpha']);
});

test('prints the verdict word "access-token-expired" and sends no usage read for an expired access token', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha', creds: 'expired' }] });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(fetch.calls.length, 0);
  assert.ok(result.lines.includes(formatVerdictLine('alpha', 'access-token-expired')));
  assertNoLeaks(result, ['alpha']);
});

test('maps usage read results to verdict words without the upstream text', () => {
  assert.equal(verdictWordOf({ classification: 'http-error', failure: 'client-error', status: 418 }), 'client-error 418');
  assert.equal(verdictWordOf({ classification: 'network-error', failure: 'network', errorCode: 'ECONNREFUSED' }), 'network');
  assert.equal(verdictWordOf({ classification: 'success', observation: { complete: false, ordinaryUsageAllowed: null } }),
    'allowed-unusable');
  assert.equal(verdictWordOf(null), 'internal-error');
});

// --- 有効化のゲート -----------------------------------------------------------------------------

for (const [name, options] of [
  ['enabled is false', { enabled: false }],
  ['the multi-account risk is not acknowledged', { acknowledged: false }],
  ['there is no config file', { config: false }],
]) {
  for (const argv of [['--', '--version'], ['--account', 'alpha', '--', '--version']]) {
    test(`refuses with "disabled" when ${name} (${argv[0] === '--account' ? 'with' : 'without'} --account)`, async t => {
      const f = await fixture(t, options);
      const fetch = fakeFetch(() => jsonResponse(usageBody()));
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assert.notEqual(result.code, 0);
      assert.deepEqual(result.lines, [EXEC_LINE.disabled]);
      assert.equal(fetch.calls.length, 0);
      assert.equal(f.spawnCalls.length, 0);
    });
  }
}

// --- 起動の型の照合 -----------------------------------------------------------------------------

for (const argv of [['--', 'resume', '--last'], ['--', 'exec', 'zz prompt'], ['--', 'login'], ['--', '-C', '/zz']]) {
  test(`rejects the form ${JSON.stringify(argv.slice(1))} before any usage read or launch`, async t => {
    const f = await fixture(t);
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.notEqual(result.code, 0);
    assert.deepEqual(result.lines, ['argument rejected (form)']);
    assert.equal(fetch.calls.length, 0);
    assert.equal(f.spawnCalls.length, 0);
  });
}

test('refuses an unregistered --account label without reading or launching', async t => {
  const f = await fixture(t);
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'zz-unknown', '--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.lines, [EXEC_LINE.accountNotRegistered]);
  assert.equal(fetch.calls.length, 0);
  assert.equal(f.spawnCalls.length, 0);
});

for (const argv of [['--', '--version'], ['--account', 'alpha', '--', '--version']]) {
  test(`refuses with "config unreadable" when the config file is readable by others (${argv[0] === '--account' ? 'with' : 'without'} --account)`, async t => {
    const f = await fixture(t);
    await chmod(codexRotatorConfigPath(f.env), 0o644);
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, [EXEC_LINE.configUnreadable]);
    assert.equal(fetch.calls.length, 0);
    assert.equal(f.spawnCalls.length, 0);
    assertNoLeaks(result, ['alpha']);
  });
}

// --- 明示した口座の規則（常駐なし。停止中・使用量が分からない・資格情報が読めない・Codex CLI が無い） --------

test('explicit account, blockWhenUnknown true, version unreadable: no read sent, no launch, usage unknown', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha', usagePolicy: policy({ blockWhenUnknown: true }) }], version: 'fail' });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(launchCount(f), 0);
  assert.ok(result.lines.includes(EXEC_LINE.usageUnknownBlocked));
  assert.ok(result.lines.includes(formatVerdictLine('alpha', 'codex-version-unreadable')));
  assertNoLeaks(result, ['alpha']);
});

test('explicit account, blockWhenUnknown false, version unreadable: no read sent, one launch and one warning line', async t => {
  const f = await fixture(t, { version: 'fail' });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(launchCount(f), 1);
  assert.equal(result.lines.filter(line => line.startsWith('warning:')).length, 1);
  assert.ok(!result.lines.some(line => line.includes('--relogin')), 'no relogin advice when the token is not expired');
  assertNoLeaks(result, ['alpha']);
});

test('explicit account whose weekly window is at the stop threshold: no launch, account stopped', async t => {
  const f = await fixture(t);
  const fetch = fakeFetch(() => jsonResponse(usageBody({ primary: 5, secondary: 90 })));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(launchCount(f), 0);
  assert.ok(result.lines.includes(EXEC_LINE.accountStopped));
  assertNoLeaks(result, ['alpha']);
});

test('explicit account, blockWhenUnknown true, expired access token: no launch, usage unknown with relogin advice', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha', creds: 'expired', usagePolicy: policy({ blockWhenUnknown: true }) }] });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(launchCount(f), 0);
  assert.ok(result.lines.includes(EXEC_LINE.usageUnknownBlocked));
  assert.ok(result.lines.includes(formatVerdictLine('alpha', 'access-token-expired')));
  assert.ok(result.lines.includes('run codex-rotator login --label alpha --relogin'));
  assertNoLeaks(result, ['alpha']);
});

test('explicit account, blockWhenUnknown false, expired access token: launches with a warning that carries relogin advice', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha', creds: 'expired' }] });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.equal(launchCount(f), 1);
  const warnings = result.lines.filter(line => line.startsWith('warning:'));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('codex-rotator login --label alpha --relogin'));
});

for (const accountFlag of [true, false]) {
  test(`codex CLI missing (${accountFlag ? 'with' : 'without'} --account): no read sent, no launch, codex-cli-missing`, async t => {
    const f = await fixture(t, { codexInstalled: false });
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const argv = accountFlag ? ['--account', 'alpha', '--', '--version'] : ['--', '--version'];
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.notEqual(result.code, 0);
    assert.equal(fetch.calls.length, 0);
    assert.equal(f.spawnCalls.length, 0);
    assert.ok(result.stderr.text().includes('codex-cli-missing'));
    if (!accountFlag) assert.ok(result.lines.includes(EXEC_LINE.noAccountAvailable));
    assertNoLeaks(result, ['alpha']);
  });
}

for (const blockWhenUnknown of [false, true]) {
  test(`explicit account without readable credentials (blockWhenUnknown ${blockWhenUnknown}): no launch, no creds and remove advice`, async t => {
    const f = await fixture(t, { accounts: [{ label: 'alpha', creds: 'missing', usagePolicy: policy({ blockWhenUnknown }) }] });
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
    assert.notEqual(result.code, 0);
    assert.equal(fetch.calls.length, 0);
    assert.equal(launchCount(f), 0);
    assert.ok(result.lines.includes(EXEC_LINE.noCreds));
    assert.ok(result.lines.includes('run codex-rotator remove --label alpha, then log in again with codex-rotator login'));
    assertNoLeaks(result, ['alpha']);
  });
}

// --- 自動の選択（常駐なし） -----------------------------------------------------------------------

test('without --account and with an unreadable version, sends no read, launches nothing and says why', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], version: 'fail' });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(fetch.calls.length, 0);
  assert.equal(launchCount(f), 0);
  assert.equal(f.spawnCalls.filter(call => call.kind === 'version').length, 1, 'the version is read once per run');
  assert.deepEqual(result.lines, [
    formatVerdictLine('alpha', 'codex-version-unreadable'),
    formatVerdictLine('beta', 'codex-version-unreadable'),
    EXEC_LINE.noAccountAvailable,
  ]);
});

test('without --account, picks the first account in config order whose every window is at or under the resume threshold', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }] });
  const fetch = fakeFetch(label => jsonResponse(label === 'alpha' ? usageBody({ primary: 51 }) : usageBody({ primary: 50, secondary: 50 })));
  const result = await f.run(['--', 'exec', '--json', '-'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.deepEqual(fetch.calls.map(call => call.label), ['alpha', 'beta'], 'stops reading once an account is chosen');
  assert.equal(launchCount(f), 1);
  assert.equal(f.launches[0].options.env.CODEX_HOME, f.homes.beta);
  assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok'), formatVerdictLine('beta', 'ok')]);
});

test('without --account, does not pick an account whose usage is unknown or that the upstream declares unusable', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha', creds: 'expired' }, { label: 'beta' }, { label: 'gamma', creds: 'missing' }] });
  const fetch = fakeFetch(() => jsonResponse(usageBody({ allowed: false })));
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(launchCount(f), 0);
  assert.deepEqual(result.lines, [
    formatVerdictLine('alpha', 'access-token-expired'),
    'run codex-rotator login --label alpha --relogin',
    formatVerdictLine('beta', 'ok'),
    formatVerdictLine('gamma', 'credentials-unavailable'),
    'run codex-rotator remove --label gamma, then log in again with codex-rotator login',
    EXEC_LINE.noAccountAvailable,
  ]);
  assertNoLeaks(result, ['alpha', 'beta', 'gamma']);
});

// --- 起動の引数・点検 ---------------------------------------------------------------------------

test('launches the real codex path with the first layer at the head and CODEX_HOME set to the chosen account folder', async t => {
  const f = await fixture(t);
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const userArgs = ['exec', '-s', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '--json', '-'];
  const result = await f.run(['--account', 'alpha', '--', ...userArgs], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.equal(launchCount(f), 1);
  const [launched] = f.launches;
  assert.deepEqual(launched.args, [...FIRST_LAYER_ARGS, ...userArgs]);
  assert.equal(launched.options.env.CODEX_HOME, f.homes.alpha);
  assert.equal(launched.options.shell, false);
  assert.equal(launched.options.stdio, 'inherit');
  assert.equal(launched.options.cwd, f.root);
  const checks = f.spawnCalls.filter(call => call.kind === 'features' || call.kind === 'mcp');
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.deepEqual(check.args.slice(0, FIRST_LAYER_ARGS.length), [...FIRST_LAYER_ARGS]);
    assert.equal(check.options.env.CODEX_HOME, f.homes.alpha);
    assert.equal(check.options.cwd, launched.options.cwd);
  }
  assert.equal(f.spawnCalls.at(-1).kind, 'launch', 'the guard check runs before the launch');
  assertNoLeaks(result, ['alpha']);
});

test('adds --no-daemon right after the first layer only for the interactive form', async t => {
  const f = await fixture(t);
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.deepEqual(f.launches[0].args, [...FIRST_LAYER_ARGS, NO_DAEMON_ARG]);
});

test('does not launch and says guard unverified when the guard check sees apps enabled', async t => {
  const f = await fixture(t, { features: 'apps stable true\nplugins stable false\n' });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.notEqual(result.code, 0);
  assert.equal(launchCount(f), 0);
  assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok'), 'guard unverified (feature-enabled)'],
    'the verdict line is printed before the guard check');
});

// --- シグナルと終了コード -----------------------------------------------------------------------

test('passes the child exit code through', async t => {
  const f = await fixture(t, { launch: child => setImmediate(() => child.emit('close', 3, null)) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 3);
  assert.deepEqual(f.raised, []);
});

test('forwards signals to the child while it runs, then re-raises the signal that ended it on itself', async t => {
  let fixtureRef;
  const f = await fixture(t, {
    launch: child => setImmediate(() => {
      for (const signal of FORWARDED_SIGNALS) fixtureRef.signals.emit(signal);
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
    }),
  });
  fixtureRef = f;
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.deepEqual(f.launches[0].child.kills, [...FORWARDED_SIGNALS]);
  assert.deepEqual(f.raised, ['SIGTERM']);
  assert.equal(result.code, 128 + 15);
  for (const signal of FORWARDED_SIGNALS) assert.equal(f.signals.listenerCount(signal), 0, 'handlers are removed after the child ends');
});

test('has no signal handlers before the launch', async t => {
  const f = await fixture(t, { version: 'fail', accounts: [{ label: 'alpha', usagePolicy: policy({ blockWhenUnknown: true }) }] });
  const onCalls = [];
  const result = await f.run(['--account', 'alpha', '--', '--version'], {
    fetchImpl: fakeFetch(() => jsonResponse(usageBody())).impl,
    signals: { on: signal => onCalls.push(signal), off: () => {} },
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(onCalls, []);
});

for (const [what, launch] of [
  ['the child reports an error before it has a pid', child => {
    child.pid = undefined;
    setImmediate(() => child.emit('error', Object.assign(new Error('zz-launch-error'), { code: 'ENOENT' })));
  }],
  ['spawn throws', () => { throw new Error('zz-launch-error'); }],
]) {
  test(`says launch failed and exits 1 when ${what}, and leaves no signal handler`, async t => {
    const f = await fixture(t, { launch });
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok'), EXEC_LINE.launchFailed]);
    assert.equal(launchCount(f), 1, 'the launch was tried once');
    for (const signal of FORWARDED_SIGNALS) assert.equal(f.signals.listenerCount(signal), 0);
    assert.deepEqual(f.raised, []);
    assert.ok(!result.stderr.text().includes('zz-launch-error'), 'the error text is not printed');
    assertNoLeaks(result, ['alpha']);
  });
}

// --- ファイルに触れないこと -----------------------------------------------------------------------

// 口座の下のファイルの一覧（パス・種類・inode・リンク数・大きさ・更新時刻）。
async function treeListing(dir) {
  const rows = [];
  const walk = async current => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = await lstat(path);
      const kind = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other';
      rows.push([path, kind, info.ino, info.nlink, info.size, info.mtimeMs].join('|'));
      if (kind === 'dir') await walk(path);
    }
  };
  await walk(dir);
  return rows;
}

test('leaves credential mtimes and every rollout file unchanged, and opens nothing under the fake ~/.codex', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }] });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const accountsDir = join(f.home, 'zz-accounts');
  const before = await treeListing(accountsDir);
  const authMtimes = async () => Promise.all(['alpha', 'beta'].map(async label => (await stat(join(f.homes[label], 'auth.json'))).mtimeMs));
  const mtimesBefore = await authMtimes();

  // 開く呼出しを記録する（fs と fs/promises の開く関数と読む関数。ESM の名前付き import にも反映する）。
  const opened = [];
  const record = path => opened.push(String(path?.path ?? path));
  const wrap = (holder, name) => {
    const original = holder[name];
    holder[name] = function recordingOpen(path, ...rest) {
      record(path);
      return original.call(this, path, ...rest);
    };
    return () => { holder[name] = original; };
  };
  const undo = [
    wrap(fs, 'openSync'), wrap(fs, 'open'), wrap(fs, 'readFileSync'), wrap(fs, 'readFile'),
    wrap(fs.promises, 'open'), wrap(fs.promises, 'readFile'),
  ];
  syncBuiltinESMExports();
  const codes = [];
  try {
    // 明示の口座（beta）と自動の選択（最初の alpha）で、両口座の資格情報を1回ずつ読む。
    codes.push((await f.run(['--account', 'beta', '--', 'exec', '--json', '-'], { fetchImpl: fetch.impl })).code);
    codes.push((await f.run(['--', 'exec', '--json', '-'], { fetchImpl: fetch.impl })).code);
  } finally {
    for (const restore of undo) restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(codes, [0, 0]);
  // 陽性対照: 記録が、設定ファイルと両口座の資格情報の読取を捕まえている。
  assert.ok(opened.includes(codexRotatorConfigPath(f.env)), 'the recorder saw the config file read');
  for (const label of ['alpha', 'beta']) {
    assert.ok(opened.includes(join(f.homes[label], 'auth.json')), `the recorder saw the credential read of ${label}`);
  }
  const homeCodex = join(f.home, '.codex');
  assert.deepEqual(opened.filter(path => path.startsWith(homeCodex)), [], 'nothing under the fake ~/.codex is opened');
  assert.deepEqual(opened.filter(path => path.includes(`${join('sessions', '')}`)), [], 'no rollout file is opened');
  assert.deepEqual(await authMtimes(), mtimesBefore, 'credential file mtimes are unchanged');
  assert.deepEqual(await treeListing(accountsDir), before, 'no file under the account folders was added, removed or changed');
});

// --- 常駐の既定のポートへ届かないこと --------------------------------------------------------------

test('the default path opens no socket and uses no global fetch', async t => {
  const f = await fixture(t);
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.equal(f.isolation.connections.length, 0);
  assert.equal(f.isolation.refusedConnections.length, 0);
  assert.equal(f.isolation.fetchCalls.length, 0);
  assert.equal(f.isolation.refusedChildProcesses.length, 0, 'no child_process function was called directly');
  assert.equal(f.isolation.refusedSpawns.length, 0);
});

// --- 常駐があるとき -------------------------------------------------------------------------------

// 常駐の select の 200 の応答（8つのキー）。
const selectAnswer = (sha256, overrides = {}) => ({ outcome: CODEX_SELECT_OUTCOME.selected, label: 'alpha', lastResort: false,
  usageKnown: true, refusal: null, stateWord: 'ready', reason: null, configSha256: sha256, ...overrides });
const STALE_LINES = Object.freeze([EXEC_LINE.configStale, formatConfigStaleGuidance()]);
const RELOGIN_ALPHA = 'run codex-rotator login --label alpha --relogin';
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };

// 許した接続が、テストが起動した常駐の番号だけであること（接続してはならない番号へは0件）。
function assertOnlyDaemonConnections(f, ports) {
  for (const connection of f.isolation.connections) {
    assert.ok(ports.includes(connection.port), 'every connection went to a daemon the test started');
  }
  for (const port of FORBIDDEN_PORTS) {
    assert.equal(f.isolation.connections.filter(connection => connection.port === port).length, 0,
      'no connection to a port that must not be used');
  }
}

// config stale で止まったこと: 0以外・決まった2行だけ・codex の起動0回・守りの点検と版の読取の起動も0回・
// 標準エラーにラベル・sha256・秘密が無い。spawnsBefore は、この実行の前の起動の記録の件数。
function assertStale(f, result, labels, { spawnsBefore = 0 } = {}) {
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.lines, STALE_LINES);
  assert.equal(f.spawnCalls.length, spawnsBefore, 'no launch, no guard check and no version read');
  const text = result.stderr.text();
  for (const label of labels) assert.ok(!text.includes(label), 'config stale names no label');
  assert.ok(!/[0-9a-fA-F]{63}/.test(text), 'config stale prints no sha256');
  assertNoLeaks(result, labels);
}

// 子（点検と起動）の引数と環境変数に、値が1つも渡っていないこと。
function assertNotPassedToChildren(f, values) {
  for (const call of f.spawnCalls) {
    const text = `${JSON.stringify(call.args)}\n${JSON.stringify(call.options.env ?? {})}`;
    for (const value of values) assert.ok(!text.includes(value), 'the value is not passed to a child');
  }
}

for (const accountFlag of [false, true]) {
  test(`with a daemon (${accountFlag ? 'with' : 'without'} --account): one select with the control token in a header only, one config read, and the account folder of its own config is launched`, async t => {
    const f = await fixture(t, {
      accounts: [{ label: 'alpha' }, { label: 'beta' }],
      // 応答に別のフォルダの目印を入れても、起動するフォルダは自分の設定のもの。
      daemon: ({ sha256 }) => ({ body: { ...selectAnswer(sha256, { label: 'beta' }), codexHome: `/zz/${DAEMON_HOME_MARKER}` } }),
    });
    let configReads = 0;
    const loadConfigSnapshot = async options => {
      configReads += 1;
      return loadCodexConfigSnapshot(options);
    };
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const argv = [...(accountFlag ? ['--account', 'beta'] : []), '--', 'exec', '--json', '-'];
    const result = await f.run(argv, { fetchImpl: fetch.impl, loadConfigSnapshot });
    assert.equal(result.code, 0);
    assert.equal(configReads, 1, 'the config is read once per launch');
    assert.deepEqual(result.lines, [], 'no verdict line when the daemon chose');
    assert.equal(fetch.calls.length, 0, 'no one-shot usage read');
    assert.equal(f.spawnCalls.filter(call => call.kind === 'version').length, 0);
    assert.equal(launchCount(f), 1);
    assert.equal(f.launches[0].options.env.CODEX_HOME, f.homes.beta);
    assert.equal(f.daemonRequests.length, 1);
    const [request] = f.daemonRequests;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, CODEX_DAEMON_PATHS.select);
    assert.equal(request.headers.host, `127.0.0.1:${f.daemonPort}`);
    assert.ok(request.headers[CONTROL_TOKEN_HEADER] === CONTROL_TOKEN, 'the token is sent in its header');
    assert.equal(request.body, accountFlag ? JSON.stringify({ label: 'beta' }) : '{}');
    assert.ok(!request.url.includes(CONTROL_TOKEN) && !request.body.includes(CONTROL_TOKEN), 'the token is only in the header');
    assertNotPassedToChildren(f, [CONTROL_TOKEN, DAEMON_HOME_MARKER]);
    assertNoLeaks(result, ['alpha', 'beta']);
    assert.equal(f.isolation.fetchCalls.length, 0, 'no global fetch');
    assertOnlyDaemonConnections(f, [f.daemonPort]);
  });
}

// 常駐の有無と --account の有無の4通りで、起動と2つの点検の引数の先頭が第1層であること。
for (const withDaemon of [false, true]) {
  for (const accountFlag of [false, true]) {
    test(`the first layer heads the launch and both guard checks (${withDaemon ? 'with' : 'without'} a daemon, ${accountFlag ? 'with' : 'without'} --account)`, async t => {
      const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }],
        ...(withDaemon ? { daemon: ({ sha256 }) => ({ body: selectAnswer(sha256, { label: 'beta' }) }) } : {}) });
      // 常駐なしの自動の選択でも beta を選ぶように、alpha は復帰しきい値を超えている。
      const fetch = fakeFetch(label => jsonResponse(label === 'alpha' ? usageBody({ primary: 60 }) : usageBody()));
      const userArgs = ['exec', '-s', 'read-only', '--json', '-'];
      const argv = [...(accountFlag ? ['--account', 'beta'] : []), '--', ...userArgs];
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assert.equal(result.code, 0);
      assert.equal(f.daemonRequests.length, withDaemon ? 1 : 0, 'the daemon was asked only when there is one');
      assert.equal(launchCount(f), 1);
      const launched = f.launches.at(-1);
      assert.deepEqual(launched.args.slice(0, FIRST_LAYER_ARGS.length), [...FIRST_LAYER_ARGS], 'the launch starts with the first layer');
      assert.deepEqual(launched.args, [...FIRST_LAYER_ARGS, ...userArgs]);
      assert.equal(launched.options.env.CODEX_HOME, f.homes.beta);
      const checks = f.spawnCalls.filter(call => call.kind === 'features' || call.kind === 'mcp');
      assert.deepEqual(checks.map(call => call.kind).sort(), ['features', 'mcp']);
      for (const check of checks) {
        assert.deepEqual(check.args.slice(0, FIRST_LAYER_ARGS.length), [...FIRST_LAYER_ARGS], `the ${check.kind} check starts with the first layer`);
        assert.equal(check.options.env.CODEX_HOME, f.homes.beta);
      }
      assertNoLeaks(result, ['alpha', 'beta']);
    });
  }
}

// 常駐ありでも、起動の形の照合で拒否したら常駐へ select を送らない（常駐に選んだ記録を残さない）。
for (const accountFlag of [false, true]) {
  test(`with a daemon, a rejected form sends no select (${accountFlag ? 'with' : 'without'} --account)`, async t => {
    const f = await fixture(t, { daemon: ({ sha256 }) => ({ body: selectAnswer(sha256) }) });
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const argv = [...(accountFlag ? ['--account', 'alpha'] : []), '--', 'resume', '--last'];
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ['argument rejected (form)']);
    assert.equal(f.daemonRequests.length, 0, 'the daemon records no selection');
    assert.equal(f.isolation.connections.length, 0, 'no connection to the daemon');
    assert.equal(fetch.calls.length, 0);
    assert.equal(f.spawnCalls.length, 0);
  });
}

// 応答の sha256 と自分の設定に照らして止まる場合（--account の有無の両方で確かめる）。
const STALE_CASES = [
  ['a different sha256', sha256 => ({ configSha256: `${sha256.slice(0, -1)}${sha256.endsWith('0') ? '1' : '0'}` })],
  ['no sha256', () => ({ configSha256: undefined })],
  ['a sha256 of 63 digits', sha256 => ({ configSha256: sha256.slice(0, 63) })],
  ['a sha256 in upper case', sha256 => ({ configSha256: sha256.toUpperCase() })],
  ['a sha256 that is not hexadecimal', sha256 => ({ configSha256: `g${sha256.slice(1)}` })],
  ['a label that is not in its own config', () => ({ label: 'zz-ghost' })],
];

for (const [what, change] of STALE_CASES) {
  for (const accountFlag of [false, true]) {
    test(`with a daemon answering ${what} (${accountFlag ? 'with' : 'without'} --account): no launch, no guard check, config stale`, async t => {
      const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }],
        daemon: ({ sha256 }) => ({ body: selectAnswer(sha256, change(sha256)) }) });
      const fetch = fakeFetch(() => jsonResponse(usageBody()));
      const argv = [...(accountFlag ? ['--account', 'alpha'] : []), '--', 'exec', '--json', '-'];
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assertStale(f, result, ['alpha', 'beta', 'zz-ghost']);
      assert.equal(fetch.calls.length, 0);
      assert.equal(f.daemonRequests.length, 1);
      assertOnlyDaemonConnections(f, [f.daemonPort]);
    });
  }
}

// 同じ変え方を「断る」（--account あり）と「選べる口座が無い」（--account なし）の応答にも当てる。判定の語
// （account stopped・no account available）より先に config stale になる。「選べる口座が無い」の応答は
// ラベルを持たないので、ラベルの変え方は当てない。
const NOT_CHOSEN_ANSWERS = [
  ['a refusal', ['--account', 'alpha', '--', 'exec', '--json', '-'], { outcome: CODEX_SELECT_OUTCOME.refused,
    refusal: CODEX_SELECT_REFUSAL.accountStopped, stateWord: 'capped', usageKnown: null }],
  ['no account', ['--', 'exec', '--json', '-'], { outcome: CODEX_SELECT_OUTCOME.none, label: null, stateWord: null,
    usageKnown: null }],
];
for (const [kind, argv, verdict] of NOT_CHOSEN_ANSWERS) {
  for (const [what, change] of STALE_CASES) {
    if (verdict.label === null && what.includes('label')) continue;
    test(`with a daemon answering ${kind} with ${what}: config stale comes before the rule word`, async t => {
      const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }],
        daemon: ({ sha256 }) => ({ body: selectAnswer(sha256, { ...verdict, ...change(sha256) }) }) });
      const fetch = fakeFetch(() => jsonResponse(usageBody()));
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assertStale(f, result, ['alpha', 'beta', 'zz-ghost']);
      assert.equal(fetch.calls.length, 0);
      assert.equal(f.daemonRequests.length, 1);
    });
  }
}

test('with a daemon answering another registered label for --account: no launch, no guard check, config stale', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }],
    daemon: ({ sha256 }) => ({ body: selectAnswer(sha256, { label: 'beta' }) }) });
  const result = await f.run(['--account', 'alpha', '--', 'exec', '--json', '-'], { fetchImpl: fakeFetch(() => jsonResponse(usageBody())).impl });
  assertStale(f, result, ['alpha', 'beta']);
});

test('with a daemon, answers that do not fit the request or cannot be read are config stale too', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => current(sha256) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  const auto = ['--', 'exec', '--json', '-'];
  const cases = [
    ['an unknown label for a label of its own config', explicit,
      sha256 => ({ body: selectAnswer(sha256, { outcome: CODEX_SELECT_OUTCOME.unknownLabel, label: null, stateWord: null }) })],
    ['a refusal of another label', explicit, sha256 => ({ body: selectAnswer(sha256,
      { outcome: CODEX_SELECT_OUTCOME.refused, label: 'beta', refusal: CODEX_SELECT_REFUSAL.accountStopped }) })],
    ['a refusal without --account', auto, sha256 => ({ body: selectAnswer(sha256,
      { outcome: CODEX_SELECT_OUTCOME.refused, refusal: CODEX_SELECT_REFUSAL.accountStopped }) })],
    ['a refusal word it does not know', explicit, sha256 => ({ body: selectAnswer(sha256,
      { outcome: CODEX_SELECT_OUTCOME.refused, refusal: 'zz-unknown-refusal' }) })],
    ['no account for --account', explicit, sha256 => ({ body: selectAnswer(sha256, { outcome: CODEX_SELECT_OUTCOME.none, label: null }) })],
    ['an outcome it does not know', auto, sha256 => ({ body: selectAnswer(sha256, { outcome: 'zz-unknown-outcome' }) })],
    ['a body that is not JSON', auto, () => ({ body: 'zz not json' })],
    ['a JSON array', auto, () => ({ body: '[]' })],
  ];
  for (const [what, argv, answer] of cases) {
    current = answer;
    const spawnsBefore = f.spawnCalls.length;
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
    assert.equal(launchCount(f), 0, what);
  }
  assert.equal(f.daemonRequests.length, cases.length);
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, refusals of the explicit account and no account at all launch nothing and print the rule words', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  const refusal = (refusalWord, stateWord) => sha256 => selectAnswer(sha256,
    { outcome: CODEX_SELECT_OUTCOME.refused, refusal: refusalWord, stateWord, usageKnown: null });
  const cases = [
    ['stopped', explicit, refusal(CODEX_SELECT_REFUSAL.accountStopped, 'capped'), [EXEC_LINE.accountStopped]],
    ['usage unknown, reserved', explicit, refusal(CODEX_SELECT_REFUSAL.usageUnknown, 'reserved'), [EXEC_LINE.usageUnknownBlocked]],
    ['usage unknown, needs login', explicit, refusal(CODEX_SELECT_REFUSAL.usageUnknown, 'needs login'),
      [EXEC_LINE.usageUnknownBlocked, RELOGIN_ALPHA]],
    ['no creds', explicit, refusal(CODEX_SELECT_REFUSAL.noCreds, 'no creds'),
      [EXEC_LINE.noCreds, 'run codex-rotator remove --label alpha, then log in again with codex-rotator login']],
    ['no account', ['--', 'exec', '--json', '-'],
      sha256 => selectAnswer(sha256, { outcome: CODEX_SELECT_OUTCOME.none, label: null, stateWord: null, usageKnown: null }),
      [EXEC_LINE.noAccountAvailable]],
  ];
  for (const [what, argv, answer, lines] of cases) {
    current = answer;
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.notEqual(result.code, 0, what);
    assert.deepEqual(result.lines, lines, what);
    assertNoLeaks(result, ['alpha', 'beta']);
  }
  assert.equal(f.spawnCalls.length, 0, 'no launch, no guard check, no version read');
  assert.equal(fetch.calls.length, 0);
  assert.equal(f.daemonRequests.length, cases.length);
});

test('with a daemon, an account chosen with unknown usage launches once with one warning line', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  const unknown = (stateWord, extra = {}) => sha256 => selectAnswer(sha256, { usageKnown: false, stateWord, ...extra });
  const cases = [
    ['explicit, unread', explicit, unknown('unread'), line => line.startsWith('warning: usage unknown for alpha') && !line.includes('--relogin')],
    ['explicit, needs login', explicit, unknown('needs login'), line => line.startsWith('warning:') && line.includes(RELOGIN_ALPHA.slice(4))],
    ['last resort', ['--', 'exec', '--json', '-'], unknown('unread', { lastResort: true }),
      line => line === formatLastResortWarning('alpha')],
  ];
  for (const [what, argv, answer, expected] of cases) {
    current = answer;
    const launchesBefore = launchCount(f);
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.equal(result.code, 0, what);
    assert.equal(launchCount(f), launchesBefore + 1, what);
    assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.alpha);
    assert.equal(result.lines.length, 1, what);
    assert.ok(expected(result.lines[0]), what);
  }
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, a selection whose shape is unknown is config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  const auto = ['--', 'exec', '--json', '-'];
  const cases = [
    ['usageKnown is a string', { usageKnown: 'true' }],
    ['usageKnown is null', { usageKnown: null }],
    ['usageKnown is missing', { usageKnown: undefined }],
    ['lastResort is a number', { lastResort: 0 }],
    ['lastResort is null', { lastResort: null }],
    ['stateWord is not a state word', { stateWord: 'zz-unknown-state' }],
    ['stateWord is null', { stateWord: null }],
    ['stateWord is an inherited name', { stateWord: 'toString' }],
  ];
  for (const [what, change] of cases) {
    for (const argv of [explicit, auto]) {
      current = sha256 => selectAnswer(sha256, change);
      const spawnsBefore = f.spawnCalls.length;
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
      assert.equal(launchCount(f), 0, what);
    }
  }
  assert.equal(f.daemonRequests.length, cases.length * 2);
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, an explicit account chosen with unknown usage whose own policy blocks unknown usage is config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha', usagePolicy: policy({ blockWhenUnknown: true }) }, { label: 'beta' }],
    daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  for (const stateWord of ['unread', 'needs login']) {
    current = sha256 => selectAnswer(sha256, { usageKnown: false, stateWord });
    const spawnsBefore = f.spawnCalls.length;
    const result = await f.run(explicit, { fetchImpl: fetch.impl });
    assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
    assert.ok(!result.stderr.text().includes('blockWhenUnknown is false'), 'no warning that contradicts its own config');
  }
  assert.equal(launchCount(f), 0);
  // 対照: 使用量が分かっている選択なら、方針が真でも起動する。
  current = sha256 => selectAnswer(sha256, { usageKnown: true });
  const known = await f.run(explicit, { fetchImpl: fetch.impl });
  assert.equal(known.code, 0);
  assert.deepEqual(known.lines, []);
  assert.equal(launchCount(f), 1);
  assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.alpha);
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, a refusal adds the relogin advice only for the state word needs login, and a selection with no creds or a last resort with needs login stops as config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const explicit = ['--account', 'alpha', '--', 'exec', '--json', '-'];
  const auto = ['--', 'exec', '--json', '-'];
  const cases = [
    ['refused as usage unknown, no creds', explicit, sha256 => selectAnswer(sha256, { outcome: CODEX_SELECT_OUTCOME.refused,
      refusal: CODEX_SELECT_REFUSAL.usageUnknown, stateWord: 'no creds', usageKnown: null }), 1, [EXEC_LINE.usageUnknownBlocked]],
    ['refused as usage unknown, needs login', explicit, sha256 => selectAnswer(sha256, { outcome: CODEX_SELECT_OUTCOME.refused,
      refusal: CODEX_SELECT_REFUSAL.usageUnknown, stateWord: 'needs login', usageKnown: null }), 1,
    [EXEC_LINE.usageUnknownBlocked, RELOGIN_ALPHA]],
    // 常駐はこの3つの組を「選んだ」と答えない（no creds は断る。最後の手段は使える状態の口座だけ）。
    // 起動せず config stale で止まる。
    ['explicit with unknown usage, no creds', explicit, sha256 => selectAnswer(sha256, { usageKnown: false, stateWord: 'no creds' }),
      null, STALE_LINES],
    ['last resort, no creds', auto, sha256 => selectAnswer(sha256, { usageKnown: false, lastResort: true, stateWord: 'no creds' }),
      null, STALE_LINES],
    ['last resort, needs login', auto, sha256 => selectAnswer(sha256, { usageKnown: false, lastResort: true, stateWord: 'needs login' }),
      null, STALE_LINES],
  ];
  for (const [what, argv, answer, code, lines] of cases) {
    current = answer;
    const spawnsBefore = f.spawnCalls.length;
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    if (code === null) assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
    else assert.equal(result.code, code, what);
    assert.deepEqual(result.lines, lines, what);
    assertNoLeaks(result, ['alpha', 'beta']);
  }
  assert.equal(launchCount(f), 0, 'none of these launches codex');
  assert.equal(fetch.calls.length, 0);
});

// exec は、常駐が「選んだ」と答えうる組だけを受け取る（常駐が返しうる組でない答えでは、起動せずに止まる）。
// 停止の類は、4つの状態の exhausted に写る状態語。
const EXPLICIT_ALPHA = Object.freeze(['--account', 'alpha', '--', 'exec', '--json', '-']);
const AUTO = Object.freeze(['--', 'exec', '--json', '-']);
const STOPPED_STATE_WORDS = Object.freeze(Object.keys(CODEX_STATE_OF_WORD).filter(word => CODEX_STATE_OF_WORD[word] === 'exhausted'));

test('with a daemon, a selection the daemon never answers for the request is config stale; the ones it answers launch', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const never = [
    ['without --account, unknown usage that is not the last resort', AUTO, { usageKnown: false, lastResort: false, stateWord: 'unread' }],
    ['without --account, known usage marked as the last resort', AUTO, { usageKnown: true, lastResort: true, stateWord: 'ready' }],
    ['with --account, the last resort with unknown usage', EXPLICIT_ALPHA, { usageKnown: false, lastResort: true, stateWord: 'unread' }],
    ['with --account, the last resort with known usage', EXPLICIT_ALPHA, { usageKnown: true, lastResort: true, stateWord: 'ready' }],
    ['without --account, known usage of an account that is not ready', AUTO, { usageKnown: true, stateWord: 'unread' }],
    ['with --account, known usage of an account that is not ready', EXPLICIT_ALPHA, { usageKnown: true, stateWord: 'needs login' }],
    ['with --account, unknown usage of a ready account', EXPLICIT_ALPHA, { usageKnown: false, stateWord: 'ready' }],
    ['with --account, unknown usage of a reserved account', EXPLICIT_ALPHA, { usageKnown: false, stateWord: 'reserved' }],
    ['the last resort that needs login', AUTO, { usageKnown: false, lastResort: true, stateWord: 'needs login' }],
    ['the last resort without models', AUTO, { usageKnown: false, lastResort: true, stateWord: 'no models' }],
    ['the last resort that is reserved', AUTO, { usageKnown: false, lastResort: true, stateWord: 'reserved' }],
  ];
  for (const [what, argv, change] of never) {
    current = sha256 => selectAnswer(sha256, change);
    const spawnsBefore = f.spawnCalls.length;
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
  }
  assert.equal(launchCount(f), 0);
  // 対照: 常駐が答えうる組は、どれも1回だけ起動する。
  const answered = [
    [AUTO, { usageKnown: true, lastResort: false, stateWord: 'ready' }],
    [AUTO, { usageKnown: false, lastResort: true, stateWord: 'unread' }],
    [AUTO, { usageKnown: false, lastResort: true, stateWord: 'starting' }],
    [EXPLICIT_ALPHA, { usageKnown: true, lastResort: false, stateWord: 'ready' }],
    ...['needs login', 'no models', 'unread', 'starting'].map(stateWord => [EXPLICIT_ALPHA, { usageKnown: false, lastResort: false, stateWord }]),
  ];
  for (const [argv, change] of answered) {
    current = sha256 => selectAnswer(sha256, change);
    const launchesBefore = launchCount(f);
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.equal(result.code, 0, JSON.stringify(change));
    assert.equal(launchCount(f), launchesBefore + 1, JSON.stringify(change));
    assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.alpha);
  }
  assert.equal(f.daemonRequests.length, never.length + answered.length);
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, a last-resort selection of an account whose own policy blocks unknown usage is config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha', usagePolicy: policy({ blockWhenUnknown: true }) }, { label: 'beta' }],
    daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  for (const stateWord of ['unread', 'starting']) {
    current = sha256 => selectAnswer(sha256, { usageKnown: false, lastResort: true, stateWord });
    const spawnsBefore = f.spawnCalls.length;
    const result = await f.run(AUTO, { fetchImpl: fetch.impl });
    assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
    assert.ok(!result.stderr.text().includes('last resort'), 'no last-resort warning for an account its own config withholds');
  }
  assert.equal(launchCount(f), 0);
  // 対照: 自分の設定で blockWhenUnknown が偽の口座（beta）なら、同じ最後の手段の応答で起動する。
  current = sha256 => selectAnswer(sha256, { label: 'beta', usageKnown: false, lastResort: true, stateWord: 'unread' });
  const fallback = await f.run(AUTO, { fetchImpl: fetch.impl });
  assert.equal(fallback.code, 0);
  assert.deepEqual(fallback.lines, [formatLastResortWarning('beta')]);
  assert.equal(launchCount(f), 1);
  assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.beta);
  assert.equal(fetch.calls.length, 0);
});

test('with a daemon, a selection of a stopped account or of one without readable credentials is config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => ({ body: current(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  // 選び方の4通り（自動の選べる口座・自動の最後の手段・明示の口座の使用量が分かる／分からない）すべてで。
  const ways = [
    [AUTO, { usageKnown: true, lastResort: false }],
    [AUTO, { usageKnown: false, lastResort: true }],
    [EXPLICIT_ALPHA, { usageKnown: true, lastResort: false }],
    [EXPLICIT_ALPHA, { usageKnown: false, lastResort: false }],
  ];
  assert.deepEqual([...STOPPED_STATE_WORDS].sort(), ['blocked', 'capped', 'exhausted', 'held', 'stopped']);
  let runs = 0;
  for (const stateWord of [...STOPPED_STATE_WORDS, 'no creds']) {
    for (const [argv, way] of ways) {
      current = sha256 => selectAnswer(sha256, { ...way, stateWord });
      const spawnsBefore = f.spawnCalls.length;
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
      runs += 1;
    }
  }
  assert.equal(launchCount(f), 0, 'no stopped account and no account without credentials is launched');
  assert.equal(f.daemonRequests.length, runs);
  assert.equal(fetch.calls.length, 0);
});

for (const accountFlag of [false, true]) {
  test(`with a daemon but no codex CLI (${accountFlag ? 'with' : 'without'} --account): the daemon is not asked, no launch, codex-cli-missing`, async t => {
    const f = await fixture(t, { codexInstalled: false, daemon: ({ sha256 }) => ({ body: selectAnswer(sha256) }) });
    const fetch = fakeFetch(() => jsonResponse(usageBody()));
    const argv = accountFlag ? ['--account', 'alpha', '--', '--version'] : ['--', '--version'];
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    assert.notEqual(result.code, 0);
    assert.equal(f.daemonRequests.length, 0, 'the daemon records no selection');
    assert.equal(f.spawnCalls.length, 0);
    assert.equal(fetch.calls.length, 0);
    assert.ok(result.stderr.text().includes('codex-cli-missing'));
  });
}

test('with a daemon that answers 401, 403, 500 or 503, exec reads once on its own as when there is no daemon', async t => {
  let status = 401;
  const f = await fixture(t, { daemon: () => ({ status, body: { error: 'zz' } }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  for (const [index, answerStatus] of [401, 403, 500, 503].entries()) {
    status = answerStatus;
    const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
    assert.equal(result.code, 0, `${answerStatus}`);
    assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok')], `${answerStatus}: the one-shot verdict line`);
    assert.equal(f.daemonRequests.length, index + 1);
    assert.equal(fetch.calls.length, index + 1);
    assert.equal(launchCount(f), index + 1);
    assertNoLeaks(result, ['alpha']);
  }
  assertOnlyDaemonConnections(f, [f.daemonPort]);
});

test('with a daemon but no usable control token file, exec does not ask it and reads once on its own', async t => {
  const f = await fixture(t, { controlToken: false, daemon: ({ sha256 }) => ({ body: selectAnswer(sha256) }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const run = () => f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  const missing = await run();
  assert.equal(missing.code, 0);
  assert.deepEqual(missing.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.equal(f.daemonRequests.length, 0, 'no token file: no request');
  // 権限の広いファイルは読まない（fsguard の検査）。
  await writeFile(controlTokenPath(f.env), JSON.stringify({ token: CONTROL_TOKEN }), { mode: 0o644 });
  await chmod(controlTokenPath(f.env), 0o644);
  const open = await run();
  assert.deepEqual(open.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.equal(f.daemonRequests.length, 0, 'a token file readable by others: no request');
  // 対照: 0600 にすると常駐へ問い合わせる。
  await chmod(controlTokenPath(f.env), 0o600);
  const asked = await run();
  assert.deepEqual(asked.lines, []);
  assert.equal(f.daemonRequests.length, 1);
  assert.equal(launchCount(f), 3);
});

test('with a daemon that never answers, exec gives up after its deadline and reads once on its own', async t => {
  const f = await fixture(t, { daemon: () => null });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const started = Date.now();
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= EXEC_DAEMON_TIMEOUT_MS - 50, 'waited for the deadline');
  // 上限: 期限を渡し忘れて要求の関数の既定（2000ms）に落ちれば、ここで落ちる。
  assert.ok(elapsed < 2000, 'gave up well before the default deadline of the request function');
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.equal(f.daemonRequests.length, 1);
  assert.equal(launchCount(f), 1);
});

test('with a daemon whose 200 answer cannot be read to the end (over the size limit, or cut off), exec stops with config stale', async t => {
  let current = null;
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: ({ sha256 }) => current(sha256) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  // 16 KiB を超える 200 の本文（中身は正しい選択の応答に、大きな余りのキーを足したもの）。
  const oversized = sha256 => ({ body: JSON.stringify({ ...selectAnswer(sha256), zz: 'z'.repeat(17 * 1024) }) });
  const cases = [
    ['an oversized 200 answer', oversized],
    ['a 200 answer cut off in the middle', () => ({ cutOff: true })],
  ];
  for (const [what, answer] of cases) {
    for (const argv of [['--account', 'alpha', '--', 'exec', '--json', '-'], ['--', 'exec', '--json', '-']]) {
      current = answer;
      const spawnsBefore = f.spawnCalls.length;
      const result = await f.run(argv, { fetchImpl: fetch.impl });
      assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
      assert.equal(launchCount(f), 0, what);
    }
  }
  assert.equal(fetch.calls.length, 0, 'no one-shot read after a 200 answer');
  assert.equal(f.daemonRequests.length, cases.length * 2);
  // 対照: 200 でない応答は、大きくても、これまでどおり常駐が無いものとして1回読みで選ぶ。
  current = sha256 => ({ ...oversized(sha256), status: 500 });
  const notOk = await f.run(['--account', 'alpha', '--', 'exec', '--json', '-'], { fetchImpl: fetch.impl });
  assert.equal(notOk.code, 0);
  assert.deepEqual(notOk.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(launchCount(f), 1);
  assertOnlyDaemonConnections(f, [f.daemonPort]);
});

test('with a daemon that sends the 200 headers and then stops in the middle of the body, exec stops with config stale at its deadline', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemon: () => ({ stall: true }) });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  for (const argv of [EXPLICIT_ALPHA, AUTO]) {
    const spawnsBefore = f.spawnCalls.length;
    const started = Date.now();
    const result = await f.run(argv, { fetchImpl: fetch.impl });
    const elapsed = Date.now() - started;
    // 下限: 期限まで待ってから止まった（接続が切れた経路ではなく、期限切れの経路を通った）。
    assert.ok(elapsed >= EXEC_DAEMON_TIMEOUT_MS - 50, 'waited for the deadline');
    // 上限: 期限を渡し忘れて要求の関数の既定（2000ms）に落ちれば、ここで落ちる。
    assert.ok(elapsed < 2000, 'gave up well before the default deadline of the request function');
    assertStale(f, result, ['alpha', 'beta'], { spawnsBefore });
  }
  assert.equal(fetch.calls.length, 0, 'no one-shot read after the 200 headers');
  assert.equal(launchCount(f), 0);
  assert.equal(f.daemonRequests.length, 2);
  assertOnlyDaemonConnections(f, [f.daemonPort]);
});

test('a daemon port of 0 in the config is not replaced by the default: no request, and exec reads once on its own', async t => {
  const f = await fixture(t, { daemonPort: 0, controlToken: true });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.equal(f.isolation.refusedRequests.length, 0);
  assert.equal(f.isolation.refusedConnections.length, 0);
  assert.equal(f.isolation.connections.length, 0);
});

test('with the default daemon port and a control token file, the request is refused by the isolation and exec reads once on its own', async t => {
  const f = await fixture(t, { controlToken: true });
  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const result = await f.run(['--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, [formatVerdictLine('alpha', 'ok')]);
  assert.deepEqual(f.isolation.refusedRequests.map(({ host, port, reason }) => ({ host, port, reason })),
    [{ host: '127.0.0.1', port: DEFAULT_DAEMON_PORT, reason: 'real-service-port' }]);
  assert.equal(f.isolation.connections.length, 0, 'no real connection was made');
  assert.equal(f.isolation.fetchCalls.length, 0);
});

test('with a real daemon on port 0: exec launches what it chose; after a label is removed from the config, exec launches nothing until the daemon reloads', async t => {
  const f = await fixture(t, { accounts: [{ label: 'alpha' }, { label: 'beta' }], daemonPort: 0,
    extraConfig: { usageUserAgent: 'zz-fake-exec-agent (zz-fake-exec-comment)', usageOriginator: 'zz-fake-exec-originator' } });
  const clock = createFakeClock({ startMs: FIXED_NOW_MS });
  const scheduler = createFakeScheduler(clock);
  const logger = createCodexLogger({ level: 'debug', write: () => {} });
  // 常駐は、設定ファイルの中身と sha256 のまま、待受の番号だけを0にした設定で動かす（ポート0で待ち受ける）。
  const loadConfigSnapshot = async options => {
    const snapshot = await loadCodexConfigSnapshot(options);
    return snapshot && { config: { ...snapshot.config, daemon: { ...snapshot.config.daemon, port: 0 } }, sha256: snapshot.sha256 };
  };
  let daemon;
  for (let attempt = 0; ; attempt++) {
    daemon = await startCodexDaemon({ env: f.env, spawn: f.isolation.spawn, now: clock.now, scheduler, logger,
      credentialEpoch: () => 1, loadConfigSnapshot,
      readCredentials: async authPath => ({ accessToken: 'zz-fake-access', accountId: basename(dirname(authPath)) }),
      fetchImpl: async () => jsonResponse(usageBody()) });
    if (!FORBIDDEN_PORTS.includes(daemon.port)) break;
    await daemon.stop();
    if (attempt >= 5) throw new Error('the system kept assigning a port that must not be used');
  }
  t.after(() => daemon.stop());
  f.isolation.allowRequest(daemon.port);
  const token = await readControlToken({ env: f.env });
  const reload = async () => {
    const response = await requestLocal({ request: f.isolation.request, port: daemon.port, path: CODEX_DAEMON_PATHS.reload,
      method: 'POST', headers: { [CONTROL_TOKEN_HEADER]: token } });
    assert.equal(response.status, 200);
    return JSON.parse(response.body).configSha256;
  };
  // exec が読む設定の daemon.port を常駐の番号にして、常駐に読み直させる。
  await f.writeConfig({ ...f.raw(), daemon: { port: daemon.port } });
  assert.equal(await reload(), f.sha256());
  clock.advance(1);
  await flush();

  const fetch = fakeFetch(() => jsonResponse(usageBody()));
  const auto = ['--', 'exec', '--json', '-'];
  const first = await f.run(auto, { fetchImpl: fetch.impl });
  assert.equal(first.code, 0);
  assert.deepEqual(first.lines, []);
  assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.alpha);

  // 設定からラベルを外す（常駐はまだ読み直していないので、前の世代で alpha を選びうる）。
  const removed = await removeCodexAccount({ env: f.env, label: 'alpha' });
  assert.equal(removed.removed, true);
  const eventsBefore = daemon.inspect().eventsTotal;
  for (const argv of [auto, ['--account', 'beta', '--', 'exec', '--json', '-']]) {
    const spawnsBefore = f.spawnCalls.length;
    assertStale(f, await f.run(argv, { fetchImpl: fetch.impl }), ['alpha', 'beta'], { spawnsBefore });
  }
  // 常駐は選んだ記録を先に残すので、起動しなかった2回も記録に残る（受け入れている振る舞い）。
  assert.equal(daemon.inspect().eventsTotal, eventsBefore + 2);
  const unregistered = await f.run(['--account', 'alpha', '--', 'exec', '--json', '-'], { fetchImpl: fetch.impl });
  assert.notEqual(unregistered.code, 0);
  assert.deepEqual(unregistered.lines, [EXEC_LINE.accountNotRegistered]);
  assert.equal(launchCount(f), 1, 'nothing was launched after the label was removed');

  // 読み直した後は、新しい世代で選び、自分の設定のフォルダで起動する。
  assert.equal(await reload(), removed.sha256);
  const after = await f.run(auto, { fetchImpl: fetch.impl });
  assert.equal(after.code, 0);
  assert.equal(f.launches.at(-1).options.env.CODEX_HOME, f.homes.beta);
  assert.equal(fetch.calls.length, 0, 'exec never read usage on its own while the daemon answered');
  assertNotPassedToChildren(f, [token]);
  for (const result of [first, unregistered, after]) assert.ok(!result.stderr.text().includes(token));
  assertOnlyDaemonConnections(f, [daemon.port]);
});

// --- 1回読みの部品と入口 ------------------------------------------------------------------------

test('the one-shot reader reads the version once for several accounts', async () => {
  let versionReads = 0;
  const readAccount = createOneShotUsageReader({
    config: { usageReadTimeoutMs: 1000 },
    codexPath: '/zz/codex',
    readVersion: async () => { versionReads += 1; return FAKE_VERSION; },
    readCredentials: async () => ({ accountId: 'zz', accessToken: 'zz' }),
    readUsage: async () => ({ classification: 'http-error', failure: 'forbidden', status: 403 }),
  });
  const words = [];
  for (const label of ['alpha', 'beta']) words.push((await readAccount({ label, codexHome: '/zz/home' })).word);
  assert.deepEqual(words, ['forbidden', 'forbidden']);
  assert.equal(versionReads, 1);
});

// 1回読みが上流へ送った User-Agent と originator を記録する偽の fetch（値は比べるだけで表示しない）。
function identityRecordingFetch() {
  const sent = [];
  const impl = async (_url, init) => {
    sent.push({ userAgent: init.headers['User-Agent'], originator: init.headers.originator });
    return jsonResponse(usageBody());
  };
  return { impl, sent };
}

test('the one-shot read sends the User-Agent and originator composed from the version that codex reports', async t => {
  const f = await fixture(t);
  const fetch = identityRecordingFetch();
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  const expected = composeClientIdentity(FAKE_VERSION);
  assert.ok(expected !== null, 'the fake version composes an identity');
  assert.equal(fetch.sent.length, 1);
  assert.ok(fetch.sent[0].userAgent === expected.userAgent, 'the User-Agent is the one composed from the version');
  assert.ok(fetch.sent[0].originator === expected.originator, 'the originator is the one composed from the version');
  assert.equal(f.spawnCalls.filter(call => call.kind === 'version').length, 1);
});

test('the one-shot read sends the configured User-Agent and originator when the config sets them, without reading the version', async t => {
  const userAgent = 'zz-fake-exec-agent (zz-fake-exec-comment)';
  const originator = 'zz-fake-exec-originator';
  const f = await fixture(t, { extraConfig: { usageUserAgent: userAgent, usageOriginator: originator } });
  const fetch = identityRecordingFetch();
  const result = await f.run(['--account', 'alpha', '--', '--version'], { fetchImpl: fetch.impl });
  assert.equal(result.code, 0);
  assert.equal(fetch.sent.length, 1);
  assert.ok(fetch.sent[0].userAgent === userAgent, 'the User-Agent is the configured one');
  assert.ok(fetch.sent[0].originator === originator, 'the originator is the configured one');
  assert.equal(f.spawnCalls.filter(call => call.kind === 'version').length, 0, 'the version is not read');
});

// exec.js と、そこから相対の import で辿れる src の下のモジュールに、標準出力へ書く記述が無いこと（exec の
// 標準出力は子のもの。呼出し側は子の標準出力を JSONL として読む）。実行器の標準出力は差し替えない。
const IMPORT_SPECIFIER = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

test('exec and every module it reaches by relative imports contain no console call and no process.stdout', async () => {
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url));
  const queue = [fileURLToPath(new URL('../../src/codex/exec.js', import.meta.url))];
  const seen = new Set();
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(path.startsWith(srcRoot), 'every module reached is under src');
    const text = await readFile(path, 'utf8');
    const name = relative(srcRoot, path);
    assert.ok(!text.includes('console.'), `${name} has no console call`);
    assert.ok(!text.includes('process.stdout'), `${name} does not touch process.stdout`);
    for (const [, specifier] of text.matchAll(IMPORT_SPECIFIER)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${name} imports only node: and relative modules`);
      queue.push(resolve(dirname(path), specifier));
    }
  }
  // 陽性対照: 辿った先に、起動の点検・設定の読込み・資格情報の読取・要求の関数・src の直下のモジュールが
  // 入っている（exec が直接読むものと、設定の読込みが読むものだけ。ほかのモジュールを読むかどうかに左右されない）。
  for (const name of ['codex/exec.js', 'codex/account-config.js', 'codex/config.js', 'codex/credentials.js',
    'shared/local-http.js', 'json-file.js']) {
    assert.ok(seen.has(join(srcRoot, name)), `${name} was reached`);
  }
});

test('the CLI entry routes exec to runExec', async t => {
  const isolation = await setupCodexIsolation(t);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(['exec', '--', '--version'], { stdout, stderr, env: isolation.env });
  assert.notEqual(code, 0);
  assert.equal(stderr.text(), `${EXEC_LINE.disabled}\n`);
  assert.equal(stdout.chunks.length, 0);
});
