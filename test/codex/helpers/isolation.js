// Codex 側のテストの隔離。test/codex の下のテストは、必ずこの補助を通して env と
// 差し替えの部品を受け取る（実のホーム・設定・常駐・Codex CLI へ届かないようにするため）。
//
// setupCodexIsolation(t) が行うこと（後片付けですべて元に戻す）:
//   1. 一時フォルダに HOME と XDG（CONFIG・DATA・STATE）を作る。CODEX_HOME と
//      CLAUDE_ROTATOR_CONFIG は、一時フォルダの中の存在しないパスへ向ける
//      （CLAUDE_ROTATOR_CONFIG は Claude 側の設定の読込で HOME・XDG より優先されるため）。
//      PATH は空の一時フォルダだけにする（PATH の探索で実物の codex を見つけないため）。
//      返す env は、これらだけを持つ新しいオブジェクトで、継承した値を1つも持たない。
//   2. process.env も同じ値へ固定し、CLAUDE_ROTATOR_* と CODEX_ROTATOR_* で始まる継承値を消す
//      （テスト隔離の仕掛けが使う自分のログの変数だけは残す）。後片付けでは、その間に足された
//      ものも含めてこの2つの接頭辞のキーを一度すべて消し、元の値を戻す。
//   3. ソケットの関所: net.Socket.prototype.connect を差し替え、127.0.0.1 の登録した番号
//      （allowRequest）以外への接続を、ソケットを開く手前で拒否する。http.request の直接呼出し・
//      別の agent・読込時に保存された fetch・https・tls・net のどれもここを通る。Claude 側の待受と
//      常駐の既定の番号は、登録されていても常に拒否する。拒否は ECONNREFUSED の error として
//      非同期に届く（常駐が無いときと同じ経路を通らせるため）。許した接続は connectImpl（既定は
//      本物の connect）へ渡す。判定は純粋関数 connectionVerdict で行う。
//   4. グローバル fetch を、呼ばれたら失敗する罠に差し替える（呼出しは fetchCalls に残る）。
//   5. child_process の起動関数をすべて、呼ばれたら拒否するものへ差し替え、
//      module.syncBuiltinESMExports() で ESM の名前付き import にも反映する。
//   6. deps.spawn の既定値として、registerSpawn で登録した偽物以外の起動を拒否する関数を渡す。
//   7. deps.request（http.request 相当。常駐との通信の部品へ注入するもの）の既定値として、
//      agent・lookup・createConnection・socketPath の指定と、登録していない接続先を拒否する
//      関数を渡す。通した要求も、3 の関所を通る。
//
// 1つのテストの中だけで使う（t.after で後片付けする）。process.env・グローバル fetch・
// ソケット・child_process はプロセスで1つなので、同時に2つの隔離を有効にすると例外にする。
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_COMMAND_LOG_ENV } from '../../../fixtures/service-command-guard.js';
import { DEFAULT_DAEMON_PORT } from '../../../src/codex/config.js';
import { DEFAULT_PORT as CLAUDE_DEFAULT_PORT } from '../../../src/config.js';

const INHERITED_PREFIXES = Object.freeze(['CLAUDE_ROTATOR_', 'CODEX_ROTATOR_']);
const FIXED_KEYS = Object.freeze(['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'CLAUDE_ROTATOR_CONFIG']);
const CHILD_PROCESS_FUNCTIONS = Object.freeze(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']);
const ALLOWED_HOST = '127.0.0.1';
// 登録されていても接続させない番号（Claude 側の待受と、codex-rotator の常駐の既定）。
export const REAL_SERVICE_PORTS = Object.freeze([CLAUDE_DEFAULT_PORT, DEFAULT_DAEMON_PORT]);
// 拒否したことを示す印（エラーの code は ECONNREFUSED・EISOLATION のまま、見分けに使う）。
export const ISOLATION_REFUSED = 'refusedByTestIsolation';
// connectionVerdict が返す拒否の理由。許すときは null。
export const CONNECTION_REFUSAL = Object.freeze({
  unsupportedOption: 'unsupported-option',
  unixSocket: 'unix-socket',
  realServicePort: 'real-service-port',
  host: 'host-not-allowed',
  port: 'port-not-registered',
});

let active = 0;

function isolationError(message, code) {
  const error = new Error(`refused by test isolation: ${message}`);
  error.code = code;
  error[ISOLATION_REFUSED] = true;
  return error;
}

/**
 * 接続先を許すかどうかの判定（純粋関数。ソケットにもネットワークにも触れない）。
 * @param {{ host?: string|null, port?: number|null, path?: unknown, unsupported?: boolean }} target
 * @param {Set<number>} allowedPorts allowRequest で登録した番号
 * @returns {string|null} 拒否の理由（CONNECTION_REFUSAL のどれか）。許すなら null
 */
export function connectionVerdict({ host, port, path, unsupported } = {}, allowedPorts = new Set()) {
  if (unsupported) return CONNECTION_REFUSAL.unsupportedOption;
  if (typeof path === 'string' && path !== '') return CONNECTION_REFUSAL.unixSocket;
  if (REAL_SERVICE_PORTS.includes(port)) return CONNECTION_REFUSAL.realServicePort;
  if (host !== ALLOWED_HOST) return CONNECTION_REFUSAL.host;
  if (!Number.isInteger(port) || !allowedPorts.has(port)) return CONNECTION_REFUSAL.port;
  return null;
}

function toPort(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

// Socket.prototype.connect の引数から接続先を読む。net.connect などが渡す正規化済みの配列
// （[options, callback]）、options、(path)、(port[, host]) の各形を受ける。
function socketTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    return { host: first.host ?? 'localhost', port: toPort(first.port), path: first.path,
      unsupported: typeof first.lookup === 'function' };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { host: null, port: null, path: first, unsupported: false };
  const host = !Array.isArray(args[0]) && typeof args[1] === 'string' ? args[1] : 'localhost';
  return { host, port: toPort(first), path: undefined, unsupported: false };
}

// http.request(url[, options][, callback]) と http.request(options[, callback]) の両方から
// 接続先を読む。agent・lookup・createConnection・socketPath の指定は、関所の外で接続を
// 組み立てられるので拒否側に倒す。
function requestTarget(args) {
  const [first, second] = args;
  let url = null;
  let options = {};
  if (typeof first === 'string' || first instanceof URL) {
    url = new URL(first);
    if (second && typeof second === 'object') options = second;
  } else if (first && typeof first === 'object') {
    options = first;
  }
  const unsupported = ['agent', 'lookup', 'createConnection', 'socketPath'].some(key => options[key] !== undefined);
  const host = options.hostname ?? options.host ?? url?.hostname ?? null;
  const port = toPort(options.port ?? (url && url.port !== '' ? url.port : null));
  return { host, port, path: undefined, unsupported };
}

// 接続を試みずに error を返す、http.ClientRequest の代わり。
class RefusedRequest extends EventEmitter {
  constructor(error) {
    super();
    this.destroyed = false;
    setImmediate(() => {
      if (!this.destroyed) this.emit('error', error);
      this.destroyed = true;
      this.emit('close');
    });
  }

  write() { return false; }
  end() { return this; }
  setTimeout() { return this; }
  setHeader() {}
  getHeader() { return undefined; }
  removeHeader() {}
  setNoDelay() {}
  setSocketKeepAlive() {}
  flushHeaders() {}
  abort() { this.destroy(); }
  destroy() { this.destroyed = true; return this; }
}

function isInheritedKey(key) {
  return INHERITED_PREFIXES.some(prefix => key.startsWith(prefix));
}

function patchProcessEnv(fixed) {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (!isInheritedKey(key)) continue;
    saved.set(key, process.env[key]);
    if (key !== SERVICE_COMMAND_LOG_ENV) delete process.env[key];
  }
  for (const key of FIXED_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    process.env[key] = fixed[key];
  }
  return () => {
    for (const key of Object.keys(process.env)) if (isInheritedKey(key)) delete process.env[key];
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function installSocketGate(state, connectImpl) {
  const original = net.Socket.prototype.connect;
  const realConnect = connectImpl ?? original;
  net.Socket.prototype.connect = function isolatedConnect(...args) {
    const target = socketTarget(args);
    const refusal = connectionVerdict(target, state.allowedPorts);
    if (refusal) {
      state.refusedConnections.push({ host: target.host, port: target.port, reason: refusal });
      const error = isolationError(`socket connection (${refusal})`, 'ECONNREFUSED');
      // 本物の connect と同じく「接続中」にして、先に書かれた要求を溜めさせ、拒否の error を先に届ける。
      this.connecting = true;
      setImmediate(() => this.destroy(error));
      return this;
    }
    state.connections.push({ host: target.host, port: target.port });
    return realConnect.apply(this, args);
  };
  return () => { net.Socket.prototype.connect = original; };
}

function installChildProcessGate(state) {
  const originals = new Map();
  for (const name of CHILD_PROCESS_FUNCTIONS) {
    if (typeof childProcess[name] !== 'function') continue;
    originals.set(name, childProcess[name]);
    childProcess[name] = function isolatedChildProcess(command) {
      state.refusedChildProcesses.push({ name, command: String(command) });
      throw isolationError(`child_process.${name} in codex tests`, 'EISOLATION');
    };
  }
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
  };
}

/**
 * @param {import('node:test').TestContext} [t] 渡すと t.after で後片付けする。
 * @param {{ connectImpl?: Function }} [options] connectImpl は、関所が許した接続を実際に行う関数
 *   （既定は本物の net.Socket.prototype.connect）。自己テストではソケットを開かない偽物を渡す。
 */
export async function setupCodexIsolation(t, { connectImpl } = {}) {
  if (active > 0) throw new Error('another codex isolation is still active in this process');
  active++;
  const cleanups = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; // 手で呼んだ後に t.after からもう一度呼ばれても、1回だけ戻す。
    cleaned = true;
    for (const undo of cleanups.splice(0).reverse()) {
      try {
        await undo();
      } catch {
        // 後片付けの失敗でテスト結果を塗り替えない。
      }
    }
    active--;
  };
  t?.after(cleanup);

  try {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-rotator-isolation-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, 'home');
    const xdgConfigHome = join(root, 'xdg', 'config');
    const xdgDataHome = join(root, 'xdg', 'data');
    const xdgStateHome = join(root, 'xdg', 'state');
    const emptyBin = join(root, 'empty-bin');
    for (const dir of [home, xdgConfigHome, xdgDataHome, xdgStateHome, emptyBin]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      CODEX_HOME: join(root, 'absent', 'codex-home'),
      CLAUDE_ROTATOR_CONFIG: join(root, 'absent', 'claude-rotator', 'config.json'),
      PATH: emptyBin,
    };
    cleanups.push(patchProcessEnv(env));

    const state = {
      allowedPorts: new Set(),
      connections: [],
      refusedConnections: [],
      refusedChildProcesses: [],
    };
    cleanups.push(installSocketGate(state, connectImpl));
    cleanups.push(installChildProcessGate(state));

    const fetchCalls = [];
    const fetchTrap = async input => {
      fetchCalls.push(String(input?.url ?? input));
      throw isolationError('global fetch is not allowed in codex tests', 'EISOLATION');
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchTrap;
    cleanups.push(() => { globalThis.fetch = originalFetch; });

    const spawnHandlers = new Map();
    const spawnCalls = [];
    const refusedSpawns = [];
    const spawn = (command, args = [], options = {}) => {
      const call = { command, args: Array.isArray(args) ? [...args] : args, options };
      spawnCalls.push(call);
      const handler = spawnHandlers.get(command);
      if (!handler) {
        refusedSpawns.push(call);
        throw isolationError('spawn of a command that the test did not register', 'EISOLATION');
      }
      return handler(call.args, options);
    };

    const refusedRequests = [];
    const request = (...args) => {
      const target = requestTarget(args);
      const refusal = connectionVerdict(target, state.allowedPorts);
      if (refusal) {
        refusedRequests.push({ host: target.host, port: target.port, reason: refusal });
        return new RefusedRequest(isolationError(`request (${refusal})`, 'ECONNREFUSED'));
      }
      return http.request(...args);
    };

    return {
      root,
      env,
      home,
      cleanup,
      fetch: fetchTrap,
      spawn,
      request,
      deps: { spawn, request, fetchImpl: fetchTrap },
      fetchCalls,
      spawnCalls,
      refusedSpawns,
      refusedRequests,
      /** 関所が許して connectImpl へ渡した接続。 */
      connections: state.connections,
      /** 関所がソケットを開く手前で拒否した接続。 */
      refusedConnections: state.refusedConnections,
      /** 差し替えた child_process の起動関数への呼出し（すべて拒否）。 */
      refusedChildProcesses: state.refusedChildProcesses,
      /** command（絶対パス）の起動を、handler(args, options) の戻り値で置き換える（deps.spawn だけ）。 */
      registerSpawn(command, handler) {
        spawnHandlers.set(command, handler);
      },
      /** ポート0で待ち受けた偽の常駐の、実際に割り当てられた番号への接続を許す。 */
      allowRequest(port) {
        if (!Number.isInteger(port) || port <= 0) throw new Error('allowRequest needs the actual listening port');
        state.allowedPorts.add(port);
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
