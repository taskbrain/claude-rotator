// codex-rotator の常駐。ループバックだけで待ち受ける HTTP の常駐で、入口は4つ:
//   GET  /internal/status  状態の JSON（src/codex/snapshot.js の射影。スキーマは src/shared/codex-status-schema.js）
//   GET  /internal/health  固定のキーだけの小さな JSON（プールと取得処理を待たない）
//   POST /internal/reload  設定の読み直し（候補の全体を検証してから適用する）
//   POST /internal/select  口座を1つ選ぶ（判定はどれも 200。形は selectVerdict の直前）
//
// 設定の世代と sha256:
//   - 設定は、起動のときも読み直しのときも loadCodexConfigSnapshot の1回の読込みで読み、解析の結果と、
//     同じ読込みから求めた sha256 を一緒に受け取る（別の読込みで求めた値を混ぜない）。
//   - 覚える sha256 は、適用している世代のもの。世代を入れ替えるのと同じ同期の処理で入れ替え、世代と
//     値が食い違う時点を作らない。読み直しの検証が失敗したときは、世代も値も旧いまま。
//   - select の応答（どの判定でも）と、reload の 200・422 の応答に、その値を configSha256 として入れる。
//   - 設定を読み直すのは reload のときだけ（ファイルの変化を見て自動では読み直さない）。
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
import { CONFIG_SHA256_PATTERN, isCodexRotatorActivated, loadCodexConfigSnapshot } from './config.js';
import { CONTROL_TOKEN_HEADER, controlTokenMatches, createControlTokenFile } from './control-token.js';
import { createCodexEventLog } from './events.js';
import { createCodexPool, projectCodexStatus } from './snapshot.js';
import { createUsagePoller } from './usage-poller.js';
import { CODEX_PROVIDER, CODEX_USER_AGENT_SOURCES, codexIsoTime, isCodexLabel } from '../shared/codex-status-schema.js';
import { LOCAL_SERVICE_HOST, isLoopbackHostname, isTrustedLocalHttpRequest } from '../shared/local-http.js';

export const CODEX_DAEMON_PATHS = Object.freeze({
  status: '/internal/status',
  health: '/internal/health',
  reload: '/internal/reload',
  select: '/internal/select',
});

/** select の判定の語（応答の outcome）。 */
export const CODEX_SELECT_OUTCOME = Object.freeze({
  selected: 'selected',
  refused: 'refused',
  unknownLabel: 'unknown-label',
  none: 'none',
});

/** 明示した口座を選ばなかった理由の語（応答の refusal）。 */
export const CODEX_SELECT_REFUSAL = Object.freeze({
  accountStopped: 'account-stopped',
  usageUnknown: 'usage-unknown',
  noCreds: 'no-creds',
});

// select の要求の本文の上限（バイト）。本文は {} か {"label":"<ラベル>"} だけなので小さい。
const SELECT_BODY_MAX_BYTES = 1024;

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
  badRequest: 'bad-request',
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
  selected: 'codex_daemon_selected',
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
  for (const name of ['generateToken', 'loadConfigSnapshot', 'createServer', 'readCredentials', 'credentialEpoch',
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

// 設定を1回読む。ファイルが無ければ { config: null, sha256: null }。読込みの関数の戻り値に、64桁の小文字の
// 16進の sha256 が無ければ TypeError（値を含めない）。
async function readConfigSnapshot(loadConfigSnapshot, env) {
  const snapshot = await loadConfigSnapshot({ env });
  if (snapshot === null) return { config: null, sha256: null };
  const sha256 = snapshot?.sha256;
  if (typeof sha256 !== 'string' || !CONFIG_SHA256_PATTERN.test(sha256)) {
    throw new TypeError('the config snapshot needs a sha256');
  }
  return { config: snapshot.config, sha256 };
}

// 要求の本文を上限まで読む。上限を越えたら null（それ以上は溜めない）。読む途中で壊れたら reject。
function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (action, value) => {
      if (settled) return;
      settled = true;
      action(value);
    };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settle(resolve, null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(resolve, Buffer.concat(chunks)));
    req.on('error', () => settle(reject, new Error('the request body could not be read')));
    req.on('close', () => settle(reject, new Error('the request closed before its body ended')));
  });
}

// select の要求の本文。JSON のオブジェクトで、持ってよいキーは label だけ（口座のラベルの形）。label が
// 無ければ自動の選択。形が違えば null。
function parseSelectRequest(body) {
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some(key => key !== 'label')) return null;
  if (!Object.hasOwn(value, 'label')) return { label: null };
  return isCodexLabel(value.label) ? { label: value.label } : null;
}

// select の判定の本体（configSha256 を除く）。キーはどの判定でも同じ8つ（configSha256 を足して）。
//   outcome     selected・refused・unknown-label・none
//   label       選んだ口座か、選ばなかった明示の口座のラベル。unknown-label と none では null
//   lastResort  最後の手段で選んだか（selected のときだけ真になりうる）
//   usageKnown  選んだ口座の使用量が分かっているか。selected のときだけ真偽、ほかは null
//   refusal     refused のときの理由の語（CODEX_SELECT_REFUSAL）。ほかは null
//   stateWord   その口座の状態語（status と同じ12語）。口座が無ければ null
//   reason      その口座の reason の語（status と同じ）。無ければ null
// 自動の選択（label が null）は、状態の JSON の next と同じ規則（選べる口座、無ければ最後の手段）で選ぶ。
// 明示した口座は、停止中（4つの状態の exhausted）と no creds を選ばない。選べる口座はそのまま選び、
// 使用量が分からない口座は、blockWhenUnknown が真なら選ばず、偽なら使用量が分からないまま選ぶ。
function selectVerdict(status, label) {
  const verdict = (outcome, account = null, extra = {}) => ({
    outcome, label: account?.label ?? null, lastResort: false, usageKnown: null, refusal: null,
    stateWord: account?.stateWord ?? null, reason: account?.reason ?? null, ...extra,
  });
  const accountOf = wanted => status.accounts.find(account => account.label === wanted);
  const selected = (account, lastResort) => verdict(CODEX_SELECT_OUTCOME.selected, account,
    { lastResort, usageKnown: account.selectable === true });
  const refused = (account, refusal) => verdict(CODEX_SELECT_OUTCOME.refused, account, { refusal });
  if (label === null) {
    const chosen = status.next.label === null ? undefined : accountOf(status.next.label);
    if (chosen === undefined) return verdict(CODEX_SELECT_OUTCOME.none);
    return selected(chosen, status.next.reason === 'last-resort');
  }
  const account = accountOf(label);
  if (account === undefined) return verdict(CODEX_SELECT_OUTCOME.unknownLabel);
  if (account.state === 'exhausted') return refused(account, CODEX_SELECT_REFUSAL.accountStopped);
  if (account.stateWord === 'no creds') return refused(account, CODEX_SELECT_REFUSAL.noCreds);
  if (account.selectable === true) return selected(account, false);
  if (account.policy.blockWhenUnknown === true) return refused(account, CODEX_SELECT_REFUSAL.usageUnknown);
  return selected(account, false);
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
 *   generateToken?: () => string,
 *   loadConfigSnapshot?: (options: { env: object }) => Promise<{ config: object, sha256: string }|null>,
 *   listenHost?: string, createServer?: Function, readCredentials?: Function, credentialEpoch?: Function,
 *   writeTokenFile?: Function,
 * }} options writeTokenFile はトークンのファイルの書込の関数（既定は json-file.js の writeJsonFileDurable）。
 *   テストで失敗の経路を試すためだけのもの。常駐を起動するコマンドは渡さない。loadConfigSnapshot は設定の
 *   読込み（既定は config.js の loadCodexConfigSnapshot）で、起動と読み直しの両方がこれだけで設定を読む。
 * @returns {Promise<{ port: number, stop: () => Promise<void>, stopped: Promise<string>, inspect: () => object }>}
 */
export async function startCodexDaemon(options) {
  checkOptions(options);
  const {
    env, spawn, fetchImpl, now, scheduler, logger, generateToken,
    loadConfigSnapshot = loadCodexConfigSnapshot, listenHost = LOCAL_SERVICE_HOST, createServer = createHttpServer,
    readCredentials, credentialEpoch, writeTokenFile,
  } = options;

  if (typeof listenHost !== 'string' || !LISTEN_HOSTS.has(listenHost)) {
    throw new CodexDaemonStartError(CODEX_DAEMON_START_STAGE.listenHost);
  }

  let config;
  // 適用している世代の設定の sha256（config と同じ1回の読込みのもの。config と一緒にだけ入れ替える）。
  let configSha256;
  let entries;
  try {
    ({ config, sha256: configSha256 } = await readConfigSnapshot(loadConfigSnapshot, env));
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

  const project = eventList => projectCodexStatus({ enabled: true, pool, poller, userAgentSource, events: eventList,
    daemon: { reachable: true, startedAt }, source: 'daemon', nowMs: now() });

  const status = res => {
    let body;
    try {
      body = project(events.list());
    } catch {
      note('error', LOG_EVENT.statusFailed, { reason: 'projection-failed', status: 500 });
      sendError(res, 500, ERROR_WORD.internal);
      return;
    }
    sendJson(res, 200, body);
  };

  const health = res => sendJson(res, 200, { ok: true, provider: CODEX_PROVIDER, startedAt: codexIsoTime(startedAt) });

  // 読み直しの検証の失敗（422）。本文は語と、適用している（旧い）世代の sha256。
  const sendRejectedReload = (res, word) => {
    note('warn', LOG_EVENT.reloadFailed, { reason: word, status: 422 });
    sendJson(res, 422, { error: word, configSha256 });
  };

  // 読み直し。候補を全部検証してから適用する。検証で失敗したら何も変えない。
  const reload = async res => {
    if (reloading) {
      sendError(res, 409, ERROR_WORD.reloadInProgress);
      return;
    }
    reloading = true;
    try {
      let candidate;
      let candidateSha256;
      let next;
      try {
        ({ config: candidate, sha256: candidateSha256 } = await readConfigSnapshot(loadConfigSnapshot, env));
        if (isCodexRotatorActivated(candidate)) next = codexAccountEntries(candidate);
      } catch {
        sendRejectedReload(res, ERROR_WORD.reloadFailed);
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
        sendRejectedReload(res, ERROR_WORD.notActivated);
        return;
      }
      if (candidate.daemon?.port !== listenPort) {
        // 待受のポートは読み直しでは変えられない（常駐を起動し直す）。本文にポートの値を入れない。
        sendRejectedReload(res, ERROR_WORD.restartRequired);
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
      // 世代・設定・sha256 は、この同期の処理の中で一緒に入れ替える。
      config = candidate;
      configSha256 = candidateSha256;
      configGeneration++;
      events.record('reloaded');
      note('info', LOG_EVENT.reloaded, { config_generation: configGeneration });
      sendJson(res, 200, { reloaded: true, configGeneration, configSha256 });
    } finally {
      reloading = false;
    }
  };

  // 口座を1つ選ぶ。本文を読み終えた後の判定と記録は同期の処理で行うので、判定に使う世代・プールと応答の
  // sha256 は同じ世代のもの。選んだときだけ出来事 selected とログの1行を記録する。選ばなかった判定
  // （refused・unknown-label・none）と拒否（400・401・403・503）は、記録も出来事も次に選ぶ口座も変えない。
  const select = async (req, res) => {
    const body = await readRequestBody(req, SELECT_BODY_MAX_BYTES);
    const request = body === null ? null : parseSelectRequest(body);
    if (request === null) {
      reject(req, res, 400, ERROR_WORD.badRequest);
      return;
    }
    if (stopping !== null) {
      if (responseOpen(res)) sendError(res, 503, ERROR_WORD.stopping);
      return;
    }
    // 射影が投げたら（プログラムの誤り）、何も記録せずに onRequest の受け手が 500 を返す。
    const verdict = selectVerdict(project([]), request.label);
    if (verdict.outcome === CODEX_SELECT_OUTCOME.selected) {
      events.record('selected', verdict.label);
      // 選び方の語: 自動で選べる口座・自動で最後の手段・明示した口座。
      const how = request.label !== null ? 'explicit' : verdict.lastResort ? 'last-resort' : 'selectable';
      note('info', LOG_EVENT.selected, { account_label: verdict.label, account_switch_reason: how,
        config_generation: configGeneration });
    }
    sendJson(res, 200, { ...verdict, configSha256 });
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
      case CODEX_DAEMON_PATHS.select:
        if (req.method === 'POST') await select(req, res);
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
