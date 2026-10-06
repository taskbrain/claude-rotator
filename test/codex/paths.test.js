// codex-rotator の置き場所（src/codex/paths.js）と、テスト隔離の補助（helpers/isolation.js）のテスト。
//
// 絶対条件: 実のホーム・~/.config/codex-rotator・~/.config/claude-rotator・常駐のポートへは
// 触れない。env はすべて isolation の補助が作った一時フォルダのものを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { execFile as esmExecFile, spawn as esmSpawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CodexPathsError,
  DEFAULT_ACCOUNTS_DIR,
  codexRotatorConfigDir,
  codexRotatorConfigPath,
  codexRotatorDataDir,
  codexRotatorStateDir,
  controlTokenPath,
  defaultCodexHome,
  expandHomePath,
  homeDir,
  shimDir,
  xdgConfigHome,
  xdgDataHome,
  xdgStateHome,
} from '../../src/codex/paths.js';
import { DEFAULT_DAEMON_PORT } from '../../src/codex/config.js';
import { DEFAULT_PORT as CLAUDE_DEFAULT_PORT } from '../../src/config.js';
import { SERVICE_COMMAND_LOG_ENV } from '../../fixtures/service-command-guard.js';
import {
  CONNECTION_REFUSAL,
  ISOLATION_REFUSED,
  REAL_SERVICE_PORTS,
  connectionVerdict,
  setupCodexIsolation,
} from './helpers/isolation.js';

// 読込の時点で保存した fetch（隔離の fetch の罠を素通りする形）。関所で止まることを確かめる。
const savedFetch = globalThis.fetch;

const LOCATION_FUNCTIONS = Object.freeze([
  homeDir, xdgConfigHome, xdgDataHome, xdgStateHome, codexRotatorConfigDir, codexRotatorConfigPath,
  controlTokenPath, codexRotatorDataDir, shimDir, codexRotatorStateDir, defaultCodexHome,
]);

const locationsOf = env => LOCATION_FUNCTIONS.map(location => location(env));

test('paths: every location is built from the HOME and XDG values of the env it is given', async t => {
  const { env } = await setupCodexIsolation(t);
  assert.equal(codexRotatorConfigPath(env), join(env.XDG_CONFIG_HOME, 'codex-rotator', 'config.json'));
  assert.equal(controlTokenPath(env), join(env.XDG_CONFIG_HOME, 'codex-rotator', 'control-token.json'));
  assert.equal(shimDir(env), join(env.XDG_DATA_HOME, 'codex-rotator', 'bin'));
  assert.equal(codexRotatorStateDir(env), join(env.XDG_STATE_HOME, 'codex-rotator'));
  assert.equal(defaultCodexHome(env), join(env.HOME, '.codex'));
  assert.equal(expandHomePath(DEFAULT_ACCOUNTS_DIR, env), join(env.HOME, '.codex-accounts'));
});

test('paths: reads only HOME, XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_STATE_HOME from the env', async t => {
  const isolation = await setupCodexIsolation(t);
  const reads = new Set();
  const target = {
    ...isolation.env,
    CODEX_ROTATOR_CONFIG: join(isolation.root, 'elsewhere', 'config.json'),
    CODEX_ROTATOR_HOME: join(isolation.root, 'elsewhere'),
  };
  const env = new Proxy(target, {
    get(object, key) { reads.add(String(key)); return object[key]; },
    has(object, key) { reads.add(String(key)); return key in object; },
    ownKeys(object) { reads.add('(every key)'); return Reflect.ownKeys(object); },
  });
  locationsOf(env);
  expandHomePath('~', env);
  expandHomePath('~/x', env);
  assert.deepEqual([...reads].sort(), ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
});

test('paths: no environment variable of its own moves a location (CODEX_HOME and the rotator configs included)', async t => {
  const isolation = await setupCodexIsolation(t);
  const elsewhere = join(isolation.root, 'elsewhere');
  const overridden = {
    ...isolation.env,
    CODEX_HOME: join(elsewhere, 'codex-home'),
    CODEX_ROTATOR_CONFIG: join(elsewhere, 'config.json'),
    CODEX_ROTATOR_CONFIG_DIR: elsewhere,
    CLAUDE_ROTATOR_CONFIG: join(elsewhere, 'claude.json'),
  };
  assert.deepEqual(locationsOf(overridden), locationsOf(isolation.env));
  for (const location of locationsOf(overridden)) assert.ok(!location.startsWith(elsewhere), location);
});

test('paths: a relative XDG value is ignored and the location falls back under HOME', async t => {
  const { env } = await setupCodexIsolation(t);
  const relative = { HOME: env.HOME, XDG_CONFIG_HOME: 'cfg', XDG_DATA_HOME: './data', XDG_STATE_HOME: '' };
  assert.equal(codexRotatorConfigPath(relative), join(env.HOME, '.config', 'codex-rotator', 'config.json'));
  assert.equal(shimDir(relative), join(env.HOME, '.local', 'share', 'codex-rotator', 'bin'));
  assert.equal(codexRotatorStateDir(relative), join(env.HOME, '.local', 'state', 'codex-rotator'));
});

test('paths: a missing or relative HOME is refused instead of being guessed', () => {
  for (const env of [undefined, {}, { HOME: '' }, { HOME: 'home/user' }, { HOME: 42 }]) {
    for (const location of LOCATION_FUNCTIONS) assert.throws(() => location(env), CodexPathsError);
  }
});

test('paths: expandHomePath expands only a leading ~ or ~/', async t => {
  const { env } = await setupCodexIsolation(t);
  assert.equal(expandHomePath('~', env), env.HOME);
  assert.equal(expandHomePath('~/a/b', env), join(env.HOME, 'a', 'b'));
  for (const value of ['~other/a', '/abs/path', 'relative/path', 'a/~/b']) assert.equal(expandHomePath(value, env), value);
});

// ---------------------------------------------------------------------------
// テスト隔離の補助そのもののテスト（陽性対照）。補助が壊れていても他のテストは緑のままに
// なりうるので、ここで補助が実際に遮っていることを毎回確かめる。
// 実際の接続は、自分でポート0で開いた偽の待受へ向けたものだけ。Claude 側の待受と常駐の既定の
// 番号が拒否されることは、判定の純粋関数 connectionVerdict だけで確かめる（その番号へは接続しない）。
// 関所が許した接続は、ソケットを開かない偽の connect（fakeConnect）へ渡す。
// ---------------------------------------------------------------------------

test('isolation: fixes HOME, XDG, CODEX_HOME and CLAUDE_ROTATOR_CONFIG to the temporary folder and restores them', async t => {
  const probes = { CODEX_ROTATOR_ZZ_PROBE: 'inherited-codex', CLAUDE_ROTATOR_ZZ_PROBE: 'inherited-claude' };
  Object.assign(process.env, probes);
  t.after(() => { for (const key of Object.keys(probes)) delete process.env[key]; });
  const before = { ...process.env };

  const isolation = await setupCodexIsolation(t);
  const { env, root } = isolation;
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_ROTATOR_CONFIG', 'CODEX_HOME', 'HOME', 'PATH',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  for (const [key, value] of Object.entries(env)) assert.ok(value.startsWith(`${root}/`), `${key} must stay in the temporary folder`);
  for (const key of ['CODEX_HOME', 'CLAUDE_ROTATOR_CONFIG']) {
    await assert.rejects(stat(env[key]), { code: 'ENOENT' }, `${key} must point at a path that does not exist`);
  }
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_ROTATOR_CONFIG']) {
    assert.equal(process.env[key], env[key], `process.env.${key} must be fixed as well`);
  }
  for (const key of Object.keys(probes)) assert.equal(key in process.env, false, `${key} must be removed`);
  // テスト隔離の仕掛け自身のログの変数は消さない（仕掛けが記録を残す先なので）。
  assert.equal(process.env[SERVICE_COMMAND_LOG_ENV], before[SERVICE_COMMAND_LOG_ENV]);
  // PATH は実行器と仕掛けが使うので、process.env の側は変えない。
  assert.equal(process.env.PATH, before.PATH);

  // 隔離の間に足された・書き換えられた接頭辞のキーも、後片付けで元に戻る。
  process.env.CODEX_ROTATOR_ZZ_ADDED = 'added-during-isolation';
  process.env.CLAUDE_ROTATOR_ZZ_PROBE = 'rewritten-during-isolation';
  await isolation.cleanup();
  assert.deepEqual({ ...process.env }, before);
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('isolation: the global fetch is a trap while the isolation is active and comes back afterwards', async t => {
  const original = globalThis.fetch;
  const isolation = await setupCodexIsolation(t);
  assert.notEqual(globalThis.fetch, original);
  await assert.rejects(globalThis.fetch('https://example.invalid/zz-probe'),
    error => error.code === 'EISOLATION' && error[ISOLATION_REFUSED] === true);
  await assert.rejects(isolation.deps.fetchImpl('https://example.invalid/zz-probe-2'), { code: 'EISOLATION' });
  assert.deepEqual(isolation.fetchCalls, ['https://example.invalid/zz-probe', 'https://example.invalid/zz-probe-2']);
  await isolation.cleanup();
  assert.equal(globalThis.fetch, original);
});

test('isolation: deps.spawn refuses and records a command the test did not register, and runs a registered fake', async t => {
  const isolation = await setupCodexIsolation(t);
  const unregistered = join(isolation.root, 'zz-bin', 'codex');
  assert.throws(() => isolation.deps.spawn(unregistered, ['--version'], { shell: false }),
    error => error.code === 'EISOLATION' && error[ISOLATION_REFUSED] === true);
  assert.throws(() => isolation.spawn('codex', ['--version']), { code: 'EISOLATION' });
  assert.deepEqual(isolation.refusedSpawns.map(call => [call.command, call.args]),
    [[unregistered, ['--version']], ['codex', ['--version']]]);

  const fakeChild = { fake: true };
  const received = [];
  isolation.registerSpawn(unregistered, (args, options) => { received.push([args, options]); return fakeChild; });
  assert.equal(isolation.spawn(unregistered, ['--version'], { shell: false }), fakeChild);
  assert.deepEqual(received, [[['--version'], { shell: false }]]);
  assert.equal(isolation.spawnCalls.length, 3);
  assert.equal(isolation.refusedSpawns.length, 2);
});

test('isolation: every child_process launcher is refused, through the ESM named imports too, and restored afterwards', async t => {
  const before = { spawn: childProcess.spawn, execFile: childProcess.execFile, execSync: childProcess.execSync };
  const isolation = await setupCodexIsolation(t);
  // 起動を試す前に、差し替えが ESM の名前付き import にまで届いていることを確かめる
  // （届いていなければ、ここで止まって何も起動しない）。
  assert.notEqual(esmSpawn, before.spawn);
  assert.notEqual(esmExecFile, before.execFile);
  assert.notEqual(childProcess.execSync, before.execSync);
  // 存在しないパス（関所が効いていなくても何も起動しない）。
  const absent = join(isolation.root, 'zz-absent-bin', 'codex');
  const refused = error => error.code === 'EISOLATION' && error[ISOLATION_REFUSED] === true;
  assert.throws(() => esmSpawn(absent, ['--version']), refused);
  assert.throws(() => esmExecFile(absent, ['--version'], () => {}), refused);
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    assert.throws(() => childProcess[name](absent), refused, name);
  }
  assert.equal(isolation.refusedChildProcesses.length, 9);
  await isolation.cleanup();
  assert.equal(esmSpawn, before.spawn);
  assert.equal(esmExecFile, before.execFile);
  assert.equal(childProcess.execSync, before.execSync);
});

// ---- 接続の関所 ----

function fakeConnect(calls) {
  return function fakeConnectImpl(...args) {
    calls.push(args);
    this.connecting = true;
    setImmediate(() => this.destroy(Object.assign(new Error('fake connect: no socket was opened'), { code: 'EFAKECONNECT' })));
    return this;
  };
}

async function fakeListener(t) {
  let accepted = 0;
  const server = net.createServer(socket => { accepted++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { port: server.address().port, accepted: () => accepted };
}

function httpOutcome(request, ...args) {
  return new Promise(resolve => {
    const req = request(...args, response => { response.resume(); resolve({ status: response.statusCode }); });
    req.on('error', error => resolve({ error }));
    req.end();
  });
}

function socketOutcome(socket) {
  return new Promise(resolve => {
    socket.on('error', error => resolve({ error }));
    socket.on('connect', () => { socket.destroy(); resolve({ connected: true }); });
    socket.on('secureConnect', () => { socket.destroy(); resolve({ connected: true }); });
  });
}

const refusedByGate = outcome => outcome.error?.code === 'ECONNREFUSED' && outcome.error[ISOLATION_REFUSED] === true;

test('isolation: a direct http.request, another agent and a saved fetch are refused before a socket opens', async t => {
  const connectCalls = [];
  const isolation = await setupCodexIsolation(t, { connectImpl: fakeConnect(connectCalls) });
  const listener = await fakeListener(t);
  const { port } = listener;

  const direct = await httpOutcome(http.request, { host: '127.0.0.1', port, path: '/' });
  assert.ok(refusedByGate(direct), `direct http.request: ${direct.error?.code}`);
  const viaAgent = await httpOutcome(http.request, { host: '127.0.0.1', port, path: '/', agent: new http.Agent({ keepAlive: false }) });
  assert.ok(refusedByGate(viaAgent), `http.request with its own agent: ${viaAgent.error?.code}`);
  const fetched = await savedFetch(`http://127.0.0.1:${port}/`).then(() => ({}), error => ({ error }));
  assert.ok(fetched.error?.cause?.[ISOLATION_REFUSED] === true || fetched.error?.[ISOLATION_REFUSED] === true,
    `saved fetch: ${fetched.error?.cause?.code ?? fetched.error?.code}`);
  // https・tls・net も同じ関所を通る。
  assert.ok(refusedByGate(await httpOutcome(https.request, { host: '127.0.0.1', port, path: '/' })), 'https.request');
  assert.ok(refusedByGate(await socketOutcome(tls.connect({ host: '127.0.0.1', port }))), 'tls.connect');
  assert.ok(refusedByGate(await socketOutcome(net.connect(port, '127.0.0.1'))), 'net.connect');
  assert.ok(refusedByGate(await socketOutcome(net.connect({ path: join(isolation.root, 'zz.sock') }))), 'unix socket');

  assert.equal(listener.accepted(), 0, 'no connection may reach the fake listener');
  assert.equal(connectCalls.length, 0, 'nothing may reach the connect function');
  assert.equal(isolation.connections.length, 0);
  assert.ok(isolation.refusedConnections.length >= 7);
  for (const entry of isolation.refusedConnections) assert.ok(entry.reason, JSON.stringify(entry));
});

test('isolation: a registered fake-listener port reaches only the injected connect function', async t => {
  const connectCalls = [];
  const isolation = await setupCodexIsolation(t, { connectImpl: fakeConnect(connectCalls) });
  const listener = await fakeListener(t);
  isolation.allowRequest(listener.port);

  const direct = await httpOutcome(http.request, { host: '127.0.0.1', port: listener.port, path: '/' });
  assert.equal(direct.error?.code, 'EFAKECONNECT');
  const viaDeps = await httpOutcome(isolation.deps.request, `http://127.0.0.1:${listener.port}/`);
  assert.equal(viaDeps.error?.code, 'EFAKECONNECT');
  // 番号が同じでも、127.0.0.1 以外の名前は関所で拒否する。
  assert.ok(refusedByGate(await httpOutcome(http.request, { host: 'localhost', port: listener.port, path: '/' })));

  assert.equal(connectCalls.length, 2);
  assert.deepEqual(isolation.connections, [{ host: '127.0.0.1', port: listener.port }, { host: '127.0.0.1', port: listener.port }]);
  assert.equal(listener.accepted(), 0, 'the fake connect opens no socket');
});

test('isolation: deps.request refuses agent, lookup, createConnection and socketPath even for a registered port', async t => {
  const connectCalls = [];
  const isolation = await setupCodexIsolation(t, { connectImpl: fakeConnect(connectCalls) });
  const listener = await fakeListener(t);
  isolation.allowRequest(listener.port);
  const base = { host: '127.0.0.1', port: listener.port, path: '/' };
  for (const extra of [{ agent: new http.Agent() }, { agent: false }, { lookup: () => {} },
    { createConnection: () => {} }, { socketPath: join(isolation.root, 'zz.sock') }]) {
    const outcome = await httpOutcome(isolation.deps.request, { ...base, ...extra });
    assert.ok(refusedByGate(outcome), Object.keys(extra)[0]);
  }
  const unregistered = await httpOutcome(isolation.request, { ...base, port: listener.port + 1 });
  assert.ok(refusedByGate(unregistered));
  assert.deepEqual(isolation.refusedRequests.map(entry => entry.reason), [
    ...Array(5).fill(CONNECTION_REFUSAL.unsupportedOption), CONNECTION_REFUSAL.port]);
  assert.equal(connectCalls.length, 0);
  assert.equal(listener.accepted(), 0);
  assert.throws(() => isolation.allowRequest(0), /actual listening port/);
});

test('isolation: connectionVerdict always refuses the Claude listener and the daemon default, even when registered', () => {
  const allowed = new Set([...REAL_SERVICE_PORTS, 40000]);
  assert.deepEqual([...REAL_SERVICE_PORTS].sort(), [CLAUDE_DEFAULT_PORT, DEFAULT_DAEMON_PORT].sort());
  for (const port of REAL_SERVICE_PORTS) {
    assert.equal(connectionVerdict({ host: '127.0.0.1', port }, allowed), CONNECTION_REFUSAL.realServicePort);
    assert.equal(connectionVerdict({ host: 'localhost', port }, allowed), CONNECTION_REFUSAL.realServicePort);
  }
  assert.equal(connectionVerdict({ host: '127.0.0.1', port: 40000 }, allowed), null);
  assert.equal(connectionVerdict({ host: 'localhost', port: 40000 }, allowed), CONNECTION_REFUSAL.host);
  assert.equal(connectionVerdict({ host: '::1', port: 40000 }, allowed), CONNECTION_REFUSAL.host);
  assert.equal(connectionVerdict({ host: '127.0.0.1', port: 40001 }, allowed), CONNECTION_REFUSAL.port);
  assert.equal(connectionVerdict({ host: '127.0.0.1', port: null }, allowed), CONNECTION_REFUSAL.port);
  assert.equal(connectionVerdict({ path: '/zz/sock' }, allowed), CONNECTION_REFUSAL.unixSocket);
  assert.equal(connectionVerdict({ host: '127.0.0.1', port: 40000, unsupported: true }, allowed), CONNECTION_REFUSAL.unsupportedOption);
  assert.equal(connectionVerdict({ host: '127.0.0.1', port: 40000 }), CONNECTION_REFUSAL.port);
});

test('isolation: the socket gate is removed afterwards', async t => {
  const original = net.Socket.prototype.connect;
  const isolation = await setupCodexIsolation(t);
  assert.notEqual(net.Socket.prototype.connect, original);
  await isolation.cleanup();
  assert.equal(net.Socket.prototype.connect, original);
});

test('isolation: a second isolation cannot be active at the same time in one process', async t => {
  const first = await setupCodexIsolation(t);
  await assert.rejects(setupCodexIsolation(), /still active/);
  await first.cleanup();
  const second = await setupCodexIsolation();
  await second.cleanup();
});
