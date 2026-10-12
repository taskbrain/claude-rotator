// codex-rotator の常駐。ループバックだけで待ち受ける HTTP の常駐で、入口は3つ:
//   GET  /internal/status  状態の JSON（src/codex/snapshot.js の射影。スキーマは src/shared/codex-status-schema.js）
//   GET  /internal/health  固定のキーだけの小さな JSON（プールと取得処理を待たない）
//   POST /internal/reload  設定の読み直し（候補の全体を検証してから適用する）
//
// 守り:
//   - 待受のホストはループバックだけ。起動の関数の引数で確かめ、待受の後にも実際の待受のアドレスを確かめる。
//   - 検査の順序は「Host・Origin・sec-fetch-site（403）→ 制御トークン（401）→ 振り分け」。
//   - 操作の入口は制御トークンだけで守る。ループバックの検査は常駐の守りに数えない。操作へ進む要求は、
//     ループバック検査の結果に関わらず、必ずトークンを照合する。403 の要求はどの操作にも進まない。
//     GET 以外の要求は、パスを問わず（知らないパスでも）照合する。照合の前に本文を読まない。
//   - 拒否・失敗の応答の本文は固定の短い JSON で、要求のヘッダ・トークン・本文・例外のメッセージを
//     含めない。拒否したときは状態を1つも変えない。
//   - 依存（env・spawn・fetchImpl・now・scheduler・logger）は必ず引数で受け、既定値へ落ちない。
//     このファイルは子プロセスの部品を import しない（spawn は引数で受けて版の読取へ渡す）。
//   - 終了コードへの変換とプロセスの終了は、常駐を起動するコマンドの側が行う。ここではプロセスを
//     終わらせない。常駐が止まったこと（自分で止まった場合を含む）は、戻り値の stopped で知らせる。
//   - 読み直しの適用の途中で例外が出たら（検証を先に済ませているので、プログラムの誤り）、500 を返し終えて
//     から常駐を止める（途中まで適用した状態のまま動き続けない）。
import { createServer as createHttpServer } from 'node:http';
import { finished } from 'node:stream';
import { createClientIdentityResolver } from './client-version.js';
import { isCodexRotatorActivated, loadCodexConfig } from './config.js';
import { CONTROL_TOKEN_HEADER, controlTokenMatches, createControlTokenFile } from './control-token.js';
import { createCodexEventLog } from './events.js';
import { createCodexPool, projectCodexStatus } from './snapshot.js';
import { createUsagePoller } from './usage-poller.js';
import { CODEX_PROVIDER, CODEX_USER_AGENT_SOURCES, codexIsoTime } from '../shared/codex-status-schema.js';
import { LOCAL_SERVICE_HOST, isLoopbackHostname, isTrustedLocalHttpRequest } from '../shared/local-http.js';

export const CODEX_DAEMON_PATHS = Object.freeze({
  status: '/internal/status',
  health: '/internal/health',
  reload: '/internal/reload',
});

// 待受に使ってよいホスト（ループバックだけ）。
const LISTEN_HOSTS = new Set([LOCAL_SERVICE_HOST, '::1']);

/** 起動の失敗の段階の語。 */
export const CODEX_DAEMON_START_STAGE = Object.freeze({
  listenHost: 'listen-host',
  config: 'config',
  notActivated: 'not-activated',
  tokenFolder: 'token-folder',
  tokenWrite: 'token-write',
  assemble: 'assemble',
  listen: 'listen',
});

/** 常駐が止まった理由の語（戻り値の stopped が知らせる）。 */
export const CODEX_DAEMON_STOP_REASON = Object.freeze({
  stopped: 'stopped',
  applyFailed: 'apply-failed',
});

/** 起動の失敗の終了コード（0以外）。プロセスの終了コードへの変換は常駐を起動するコマンドが行う。 */
export const CODEX_DAEMON_START_EXIT_CODE = 1;

const START_MESSAGE = Object.freeze({
  [CODEX_DAEMON_START_STAGE.listenHost]: 'the codex-rotator daemon listens on a loopback address only',
  [CODEX_DAEMON_START_STAGE.config]: 'the codex-rotator config cannot be loaded',
  [CODEX_DAEMON_START_STAGE.notActivated]: 'codex-rotator is not activated (enabled and acknowledgedMultiAccountRisk)',
  [CODEX_DAEMON_START_STAGE.tokenFolder]: 'the control token folder is not private',
  [CODEX_DAEMON_START_STAGE.tokenWrite]: 'the control token cannot be created',
  [CODEX_DAEMON_START_STAGE.assemble]: 'the codex-rotator daemon cannot be assembled',
  [CODEX_DAEMON_START_STAGE.listen]: 'the codex-rotator daemon cannot listen',
});

/**
 * 起動の失敗。メッセージは段階ごとの固定の文言だけ（パス・トークン・設定の値・下の層の例外を持ち込まない）。
 * exitCode は0以外の整数、stage は CODEX_DAEMON_START_STAGE のどれか。
 */
export class CodexDaemonStartError extends Error {
  constructor(stage) {
    super(START_MESSAGE[stage]);
    this.name = 'CodexDaemonStartError';
    this.stage = stage;
    this.exitCode = CODEX_DAEMON_START_EXIT_CODE;
  }
}

// 応答の本文の語（固定）。
const ERROR_WORD = Object.freeze({
  forbidden: 'forbidden',
  unauthorized: 'unauthorized',
  notFound: 'not-found',
  methodNotAllowed: 'method-not-allowed',
  reloadInProgress: 'reload-in-progress',
  reloadFailed: 'reload-failed',
  notActivated: 'not-activated',
  restartRequired: 'restart-required',
  stopping: 'stopping',
  internal: 'internal-error',
});

// 常駐が自分で出すログの出来事の名前。
const LOG_EVENT = Object.freeze({
  started: 'codex_daemon_started',
  stopped: 'codex_daemon_stopped',
  rejected: 'codex_daemon_request_rejected',
  statusFailed: 'codex_daemon_status_failed',
  reloaded: 'codex_daemon_reloaded',
  reloadFailed: 'codex_daemon_reload_failed',
  requestFailed: 'codex_daemon_request_failed',
});

const LOGGER_METHODS = Object.freeze(['debug', 'info', 'warn', 'error', 'registerSecret']);

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`);
}

// 必須の依存を確かめる（既定値へ落とさない）。メッセージはキーの名前だけ。
function checkOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options are required');
  const { env, spawn, fetchImpl, now, scheduler, logger } = options;
  if (env === null || typeof env !== 'object') throw new TypeError('env is required');
  requireFunction(spawn, 'spawn');
  requireFunction(fetchImpl, 'fetchImpl');
  requireFunction(now, 'now');
  if (scheduler === null || typeof scheduler !== 'object'
    || typeof scheduler.setTimeout !== 'function' || typeof scheduler.clearTimeout !== 'function') {
    throw new TypeError('scheduler is required');
  }
  if (logger === null || typeof logger !== 'object' || LOGGER_METHODS.some(name => typeof logger[name] !== 'function')) {
    throw new TypeError('logger is required');
  }
  for (const name of ['generateToken', 'loadConfig', 'createServer', 'readCredentials', 'credentialEpoch',
    'writeTokenFile']) {
    if (options[name] !== undefined) requireFunction(options[name], name);
  }
}

/**
 * 設定の口座から、プールの reconcile() へ渡す組（key・label）と、取得処理の configure() へ渡す組
 * （key・label・home）を作る。key は codexHome（設定の読込が実パスで検証した値）。models は渡さない。
 * 形が違えば TypeError（値を含めない）。
 * @param {{ accounts: Array<{ label: string, codexHome: string }> }} config 検証済みの設定
 */
export function codexAccountEntries(config) {
  const accounts = config?.accounts;
  if (!Array.isArray(accounts)) throw new TypeError('config.accounts must be an array');
  const pool = [];
  const poller = [];
  for (const account of accounts) {
    const { label, codexHome } = account ?? {};
    if (typeof label !== 'string' || typeof codexHome !== 'string' || codexHome.length === 0) {
      throw new TypeError('every account needs a label and a codexHome');
    }
    pool.push({ key: codexHome, label });
    poller.push({ key: codexHome, label, home: codexHome });
  }
  return { pool, poller };
}

// 応答。どの応答にも Content-Type・Cache-Control: no-store・Connection: close を付ける（接続を残さない）。
// CORS のヘッダは付けない。要求の値を応答のヘッダへ返さない。
function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    connection: 'close',
    ...extraHeaders,
  });
  res.end(text);
}

const sendError = (res, status, word, extraHeaders) => sendJson(res, status, { error: word }, extraHeaders);

// 応答の接続がまだ使えるか（閉じた・壊れた・送り終えた応答には何も送らない）。
const responseOpen = res => !res.destroyed && !res.writableEnded && !res.writableFinished && res.socket?.destroyed !== true;

// 失敗の応答を送り、相手へ渡し終えるまで待つ。接続が既に閉じていれば送らずにすぐ終える。送った後は
// 終わり方（送り終え・切断・失敗）を問わず、応答の流れが終わったところで終える。例外を投げない。
function sendErrorAndWait(res, status, word) {
  return new Promise(resolve => {
    if (!responseOpen(res)) {
      resolve();
      return;
    }
    try {
      finished(res, () => setImmediate(resolve));
      sendError(res, status, word);
    } catch {
      resolve();
    }
  });
}

// 待受を閉じる。開いている接続も壊して、待たずに閉じ終える。失敗しても例外を投げない。
function closeServer(server, sockets) {
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // 壊せなくても、閉じ終えるのを待たない。
      }
    }
    sockets.clear();
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error('listen failed'));
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

// 実際の待受がループバックの番号付きのアドレスか。
function listeningOnLoopback(server) {
  const address = server.address();
  if (address === null || typeof address !== 'object') return null;
  if (!isLoopbackHostname(address.address)) return null;
  return Number.isInteger(address.port) && address.port > 0 ? address.port : null;
}

/**
 * 常駐を起動する。
 *
 * 起動の順序: 引数の検査（待受のホストがループバックでなければ拒否）→ 設定の読込 → 有効化の二重ゲート →
 * トークンの親フォルダの検査 → トークンの作成と書込 → トークンをロガーの秘密として登録 → プール・取得処理・
 * 版の読取・出来事の記録の組立 → 待受 → 待受のアドレスがループバックであることの確認。
 * 失敗したら、開いた待受を閉じ → 取得処理を止め → 書いたトークンのファイルを（自分の値のときだけ）消して
 * から、CodexDaemonStartError で reject する。
 * 戻り値の stopped は、常駐が止まったときに理由の語（CODEX_DAEMON_STOP_REASON）で解決する。
 *
 * @param {{
 *   env: object, spawn: Function, fetchImpl: Function, now: () => number,
 *   scheduler: { setTimeout: Function, clearTimeout: Function },
 *   logger: { debug: Function, info: Function, warn: Function, error: Function, registerSecret: Function },
 *   generateToken?: () => string, loadConfig?: (options: { env: object }) => Promise<object|null>,
 *   listenHost?: string, createServer?: Function, readCredentials?: Function, credentialEpoch?: Function,
 *   writeTokenFile?: Function,
 * }} options writeTokenFile はトークンのファイルの書込の関数（既定は json-file.js の writeJsonFileDurable）。
 *   テストで失敗の経路を試すためだけのもの。常駐を起動するコマンドは渡さない。
 * @returns {Promise<{ port: number, stop: () => Promise<void>, stopped: Promise<string>, inspect: () => object }>}
 */
export async function startCodexDaemon(options) {
  checkOptions(options);
  const {
    env, spawn, fetchImpl, now, scheduler, logger, generateToken,
    loadConfig = loadCodexConfig, listenHost = LOCAL_SERVICE_HOST, createServer = createHttpServer,
    readCredentials, credentialEpoch, writeTokenFile,
  } = options;

  if (typeof listenHost !== 'string' || !LISTEN_HOSTS.has(listenHost)) {
    throw new CodexDaemonStartError(CODEX_DAEMON_START_STAGE.listenHost);
  }

  let config;
  let entries;
  try {
    config = await loadConfig({ env });
    // 有効化されていない設定（ファイルが無い null を含む）は、try の後の判定で止める。
    if (isCodexRotatorActivated(config)) entries = codexAccountEntries(config);
  } catch {
    throw new CodexDaemonStartError(CODEX_DAEMON_START_STAGE.config);
  }
  if (!isCodexRotatorActivated(config)) throw new CodexDaemonStartError(CODEX_DAEMON_START_STAGE.notActivated);
  // 待受に渡した設定のポート（実際に割り当てられた番号ではない）。読み直しで変えられない。
  const listenPort = config.daemon.port;

  // ここから先は、失敗したら作ったものを片付けてから reject する。
  let tokenFile = null;
  let poller = null;
  let server = null;
  const sockets = new Set();
  const fail = async stage => {
    if (server !== null) await closeServer(server, sockets);
    try {
      poller?.shutdown();
    } catch {
      // 片付けの失敗で reject の中身を変えない。
    }
    await tokenFile?.remove();
    return new CodexDaemonStartError(stage);
  };

  try {
    tokenFile = createControlTokenFile({ env, ...(generateToken === undefined ? {} : { generateToken }),
      ...(writeTokenFile === undefined ? {} : { writeJson: writeTokenFile }) });
    await tokenFile.assertFolder();
  } catch {
    throw await fail(CODEX_DAEMON_START_STAGE.tokenFolder);
  }
  let token;
  try {
    token = tokenFile.generate();
    // 値そのもので伏せる秘密として、書く前に登録する（書込の失敗の後も値がログへ出ないように）。
    logger.registerSecret(token);
    await tokenFile.write(token);
  } catch {
    throw await fail(CODEX_DAEMON_START_STAGE.tokenWrite);
  }

  let startedAt;
  let events;
  // 取得処理・認証の規則・版の読取のログを、ロガーと出来事の記録の両方へ渡す。どちらかが投げても、
  // もう一方と常駐を止めない。
  const log = (level, event, fields) => {
    try {
      if (typeof logger[level] === 'function' && level !== 'registerSecret') logger[level](event, fields);
    } catch {
      // ロガーの失敗で出来事の記録と常駐を止めない。
    }
    try {
      events.recordLog(level, event, fields);
    } catch {
      // 出来事の記録の失敗でロガーと常駐を止めない。
    }
  };
  // 常駐が自分で出すログ（出来事の記録へは渡さない）。
  const note = (level, event, fields) => {
    try {
      logger[level](event, fields);
    } catch {
      // ログの失敗で常駐を止めない。
    }
  };

  let configGeneration = 1;
  let reconcileCalls = 0;
  let userAgentSource = null;
  let pool;
  let resolver;
  let reloading = false;
  let shutdown = null;
  // 停止を始めたら、その処理の Promise（読み直しは、読込から戻った直後にこれを確かめる）。
  let stopping = null;
  try {
    startedAt = now();
    events = createCodexEventLog({ now });
    pool = createCodexPool([], config);
    pool.reconcile(entries.pool, now());
    reconcileCalls++;
    resolver = createClientIdentityResolver({ env, config, registerSecret: logger.registerSecret, spawn, now,
      scheduler, log });
    // 取得処理は戻り値の source を捨てるので、ここで覚えてから渡す。読み直しの前に始まった読取の結果で
    // 覚え直さない（呼んだときと終わったときの設定の世代が同じときだけ）。
    const resolveClientIdentity = async () => {
      const generationAtCall = configGeneration;
      const identity = await resolver.resolveClientIdentity();
      if (generationAtCall === configGeneration) {
        const source = identity?.source ?? null;
        userAgentSource = CODEX_USER_AGENT_SOURCES.includes(source) ? source : null;
      }
      return identity;
    };
    poller = createUsagePoller({ pool, resolveClientIdentity, now, scheduler, fetchImpl, log,
      readCredentials, credentialEpoch });
    poller.configure(entries.poller, config);
  } catch {
    // 組立は検証済みの設定から作るので、ここへ来るのはプログラムの誤り（時計の例外を含む）。待ち受けずに止める。
    throw await fail(CODEX_DAEMON_START_STAGE.assemble);
  }

  const status = res => {
    let body;
    try {
      body = projectCodexStatus({ enabled: true, pool, poller, userAgentSource, events: events.list(),
        daemon: { reachable: true, startedAt }, source: 'daemon', nowMs: now() });
    } catch {
      note('error', LOG_EVENT.statusFailed, { reason: 'projection-failed', status: 500 });
      sendError(res, 500, ERROR_WORD.internal);
      return;
    }
    sendJson(res, 200, body);
  };

  const health = res => sendJson(res, 200, { ok: true, provider: CODEX_PROVIDER, startedAt: codexIsoTime(startedAt) });

  // 読み直し。候補を全部検証してから適用する。検証で失敗したら何も変えない。
  const reload = async res => {
    if (reloading) {
      sendError(res, 409, ERROR_WORD.reloadInProgress);
      return;
    }
    reloading = true;
    try {
      let candidate;
      let next;
      try {
        candidate = await loadConfig({ env });
        if (isCodexRotatorActivated(candidate)) next = codexAccountEntries(candidate);
      } catch {
        note('warn', LOG_EVENT.reloadFailed, { reason: ERROR_WORD.reloadFailed, status: 422 });
        sendError(res, 422, ERROR_WORD.reloadFailed);
        return;
      }
      if (stopping !== null) {
        // 読込を待つ間に停止が始まった（または済んだ）。何も適用しない。接続が生きていれば固定の本文で答える。
        note('warn', LOG_EVENT.reloadFailed, { reason: ERROR_WORD.stopping, status: 503 });
        if (responseOpen(res)) {
          try {
            sendError(res, 503, ERROR_WORD.stopping);
          } catch {
            // 答えられなくても、何も変えずに終える。
          }
        }
        return;
      }
      if (!isCodexRotatorActivated(candidate)) {
        // 常駐は旧い世代のまま動き続ける（止め方は常駐を起動・停止する運用のコマンドで決める）。
        note('warn', LOG_EVENT.reloadFailed, { reason: ERROR_WORD.notActivated, status: 422 });
        sendError(res, 422, ERROR_WORD.notActivated);
        return;
      }
      if (candidate.daemon?.port !== listenPort) {
        // 待受のポートは読み直しでは変えられない（常駐を起動し直す）。本文にポートの値を入れない。
        note('warn', LOG_EVENT.reloadFailed, { reason: ERROR_WORD.restartRequired, status: 422 });
        sendError(res, 422, ERROR_WORD.restartRequired);
        return;
      }
      try {
        const at = now();
        reconcileCalls++;
        pool.reconcile(next.pool, at);
        pool.configure(candidate, at);
        resolver.reload(candidate);
        poller.configure(next.poller, candidate);
      } catch {
        // 検証を先に済ませているので、ここはプログラムの誤り。途中まで適用した状態を元へ戻す仕組みは
        // 作らない。世代は進めない。接続が既に閉じていれば待たずに、送った場合は応答の流れが終わった
        // （送り終え・切断・失敗のどれか）ところで、常駐を止める。
        note('error', LOG_EVENT.reloadFailed, { reason: CODEX_DAEMON_STOP_REASON.applyFailed, status: 500 });
        try {
          await sendErrorAndWait(res, 500, ERROR_WORD.internal);
        } finally {
          void shutdown(CODEX_DAEMON_STOP_REASON.applyFailed);
        }
        return;
      }
      config = candidate;
      configGeneration++;
      events.record('reloaded');
      note('info', LOG_EVENT.reloaded, { config_generation: configGeneration });
      sendJson(res, 200, { reloaded: true, configGeneration });
    } finally {
      reloading = false;
    }
  };

  const reject = (req, res, status, word) => {
    note('warn', LOG_EVENT.rejected, { status, method: req.method === 'GET' || req.method === 'POST' ? req.method : 'other' });
    sendError(res, status, word);
  };

  const handle = async (req, res) => {
    // 1. Host・Origin・sec-fetch-site。この検査は守りに数えない。操作へ進む要求は、ループバック検査の結果に
    //    関わらず、必ず 2 でトークンを照合する。403 の要求はどの操作にも進まない。
    if (!isTrustedLocalHttpRequest(req)) {
      reject(req, res, 403, ERROR_WORD.forbidden);
      return;
    }
    // 2. GET 以外のすべての要求は、パスを問わずトークンを照合する。本文は読まない。
    if (req.method !== 'GET' && !controlTokenMatches(token, req.headers[CONTROL_TOKEN_HEADER])) {
      reject(req, res, 401, ERROR_WORD.unauthorized);
      return;
    }
    // 3. 振り分け（問い合わせ文字列を持つパスは知らないパスとして扱う）。
    switch (req.url) {
      case CODEX_DAEMON_PATHS.status:
        if (req.method === 'GET') status(res);
        else sendError(res, 405, ERROR_WORD.methodNotAllowed, { allow: 'GET' });
        return;
      case CODEX_DAEMON_PATHS.health:
        if (req.method === 'GET') health(res);
        else sendError(res, 405, ERROR_WORD.methodNotAllowed, { allow: 'GET' });
        return;
      case CODEX_DAEMON_PATHS.reload:
        if (req.method === 'POST') await reload(res);
        else sendError(res, 405, ERROR_WORD.methodNotAllowed, { allow: 'POST' });
        return;
      default:
        sendError(res, 404, ERROR_WORD.notFound);
    }
  };

  const onRequest = (req, res) => {
    handle(req, res).catch(() => {
      note('error', LOG_EVENT.requestFailed, { reason: ERROR_WORD.internal, status: 500 });
      try {
        if (!res.headersSent) sendError(res, 500, ERROR_WORD.internal);
        else res.destroy();
      } catch {
        // 応答できなくても常駐を止めない。
      }
    });
  };

  let port;
  try {
    server = createServer(onRequest);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await listen(server, config.daemon.port, listenHost);
    port = listeningOnLoopback(server);
    if (port === null) throw new Error('not loopback');
  } catch {
    throw await fail(CODEX_DAEMON_START_STAGE.listen);
  }
  // 待受の後の error は記録だけする（受け手が無いとプロセスが落ちる）。中身は出さない。
  server.on('error', () => note('error', LOG_EVENT.requestFailed, { reason: 'server-error' }));
  note('info', LOG_EVENT.started, { port });

  let resolveStopped;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  // 止める。最初の理由だけが stopped に届く。2回呼んでも安全。
  shutdown = reason => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      await closeServer(server, sockets);
      try {
        poller.shutdown();
      } catch {
        // 止められなくても、トークンのファイルは消す。
      }
      await tokenFile.remove();
      note('info', LOG_EVENT.stopped, { reason });
      resolveStopped(reason);
    })();
    return stopping;
  };
  const stop = () => shutdown(CODEX_DAEMON_STOP_REASON.stopped);

  // テスト用の読むだけの窓。トークン・資格情報・User-Agent と originator の値は入れない。
  // HTTP・/internal/status・ログのどれにも出さない。
  const inspect = () => ({
    configGeneration,
    poolGeneration: pool.generation(),
    eventsTotal: events.total(),
    accounts: structuredClone(pool.snapshot()),
    reconcileCalls,
  });

  return { port, stop, stopped, inspect };
}
