// `codex-rotator status`（`--json`・`--json --section`・引数なし）の本体と、常駐が無いときの直接読取。
//
// 流れ:
//   1. 引数を読む。形が違えば使い方の1行で 2。
//   2. 設定を1回読む。読めなければ `config unreadable` で 1。ファイルが無い・2つのゲート（enabled と
//      acknowledgedMultiAccountRisk）が真でないときは、資格情報を読まず、読取も送らずに、無効の状態
//      （enabled:false・accounts:[]・source:"direct"・next.reason:"disabled"）を出す。
//   3. 常駐へ GET /internal/status を1回送る（STATUS_DAEMON_TIMEOUT_MS まで）。200 で、スキーマ検査を通り、
//      source が daemon の値なら、それをそのまま使う（このときは Codex CLI を起こさない）。
//   4. 常駐が使える値を返さなかったら、版の読取（使用量の読取の User-Agent を組み立てるため）を始める。
//      設定に User-Agent の上書きの組があるとき・Codex CLI が見つからないときは読まない。
//   5. 常駐が無ければ、口座ごとに使用量をその場で1回読み（exec と同じ1回読みの部品 createOneShotUsageReader。
//      同時に CODEX_DIRECT_READ_CONCURRENCY 口座まで）、結果をプールへ当てて、状態の射影（snapshot.js）で
//      JSON にする。source は direct で、停止（ラッチ）の状態は分からない（latchKnown:false）。
//   6. 出す前にスキーマ検査を通す。`--json` は JSON を1行、引数なしは共有の描画関数（src/shared/codex-view.js）
//      で描いた行を、標準出力へ出す。
// `--json --section` は `--json` と同じ形で、違いは全体の期限 CODEX_SECTION_DEADLINE_MS を守ることだけ。
// 期限までに読み終わらなかった口座は、読取を待たずに unread（reason read-deadline。blockWhenUnknown が真の
// 口座は reserved）として入れる。1回の読取の期限は、読取を送る時点の残りの時間を超えない。
//
// 直接読取の1回の結果の当て方（常駐の取得処理と認証の規則の、1回だけの読取への読み替え）:
//   - 資格情報が読めない → no creds。access token の期限切れ → needs login（access-token-expired）。
//   - 使用量の GET の 401 → needs login（upstream-unauthorized）。403 → 同じ読取で別の口座の GET が成功して
//     いれば needs login（upstream-forbidden）、口座が1つだけ・裏付けが無ければ使用量が分からない口座。
//   - 観測が読めた → 使用量の GET の観測としてプールへ当てる（不完全な観測も停止の判定には使う）。
//   - そのほか（User-Agent が作れない・期限切れ・上流の誤り）→ 使用量が分からない口座。理由の語は
//     reason の codex-cli-missing・codex-version-unreadable・read-deadline のどれかか usage-unknown。
//
// 標準出力には JSON（または画面）だけを出す。標準エラーには決まった語だけを出し、値・パス・ラベルを出さない。
// 資格情報は読むだけで、更新も書込みもしない。
import { request as httpRequest } from 'node:http';
import { readCodexVersion } from './client-version.js';
import { isCodexRotatorActivated, loadCodexConfigSnapshot } from './config.js';
import { CODEX_DAEMON_PATHS, codexAccountEntries } from './daemon.js';
import { createOneShotUsageReader } from './exec.js';
import { findRealCodex } from './real-codex.js';
import { createCodexPool, projectCodexStatus } from './snapshot.js';
import { readCodexUsage } from './usage.js';
import {
  CODEX_DIRECT_READ_CONCURRENCY, CODEX_SECTION_DEADLINE_MS, codexStatusProblem,
} from '../shared/codex-status-schema.js';
import { renderCodexSection } from '../shared/codex-view.js';
import { requestLocal } from '../shared/local-http.js';

export const STATUS_USAGE = 'usage: codex-rotator status [--json [--section]]';
export const STATUS_USAGE_EXIT_CODE = 2;
export const STATUS_FAILED_EXIT_CODE = 1;

/** 止まったときに標準エラーへ出す決まった行。 */
export const STATUS_LINE = Object.freeze({
  configUnreadable: 'config unreadable',
  failed: 'status unavailable',
});

/** 常駐への問い合わせの期限（要求を出してから応答を読み終えるまで）。 */
export const STATUS_DAEMON_TIMEOUT_MS = 1000;
// 常駐の状態の応答の大きさの上限（親が子の出力に置く上限と同じ）。
const STATUS_MAX_BYTES = 256 * 1024;

const USAGE_WINDOWS = Object.freeze(['primary', 'secondary']);
// 1回読みの判定の語のうち、この部品が別に扱う語（exec.js の判定の語と usage.js の失敗の分類）。
const WORD = Object.freeze({
  ok: 'ok',
  credentialsUnavailable: 'credentials-unavailable',
  accessTokenExpired: 'access-token-expired',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
});
const IDENTITY_WORDS = new Set(['codex-cli-missing', 'codex-version-unreadable']);
const READ_DEADLINE = 'read-deadline';

function parseStatusArgs(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.length === 0) return 'text';
  if (argv.length === 1 && argv[0] === '--json') return 'json';
  if (argv.length === 2 && argv[0] === '--json' && argv[1] === '--section') return 'section';
  return null;
}

/**
 * 有効化されていないときの状態（資格情報を読まず、読取も送らない）。
 * @param {number} nowMs
 */
export function disabledCodexStatus(nowMs) {
  return projectCodexStatus({ enabled: false, pool: createCodexPool([], {}), source: 'direct', nowMs });
}

// 常駐へ状態を1回だけ問い合わせる。使える値でなければ null。期限は scheduler で測る（要求そのものにも同じ
// 期限を渡す）。例外を投げない。
async function askDaemonForStatus({ port, request, scheduler }) {
  let timer;
  const expired = new Promise(resolve => { timer = scheduler.setTimeout(() => resolve(null), STATUS_DAEMON_TIMEOUT_MS); });
  const asked = (async () => {
    try {
      const response = await requestLocal({ request, port, path: CODEX_DAEMON_PATHS.status,
        timeoutMs: STATUS_DAEMON_TIMEOUT_MS, maxResponseBytes: STATUS_MAX_BYTES });
      if (response.status !== 200) return null;
      const value = JSON.parse(response.body);
      return codexStatusProblem(value) === null && value.source === 'daemon' ? value : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([asked, expired]);
  } finally {
    scheduler.clearTimeout(timer);
  }
}

// 口座を設定の並び順に、同時に CODEX_DIRECT_READ_CONCURRENCY 口座まで読む。全体の期限（deadlineAt。null なら
// 期限なし）が来たら待つのをやめ、それまでに読み終わらなかった口座（読み始めていないものを含む）は null。
async function readAccounts(accounts, readOne, { deadlineAt, now, scheduler }) {
  const readings = accounts.map(() => null);
  let next = 0;
  let expired = false;
  const worker = async () => {
    while (!expired && next < accounts.length) {
      const index = next++;
      const reading = await readOne(accounts[index]);
      if (!expired) readings[index] = reading;
    }
  };
  const workers = Promise.all(Array.from({ length: Math.min(CODEX_DIRECT_READ_CONCURRENCY, accounts.length) }, worker));
  if (deadlineAt === null) {
    await workers;
    return readings;
  }
  let timer;
  const deadline = new Promise(resolve => {
    timer = scheduler.setTimeout(() => {
      expired = true;
      resolve();
    }, Math.max(0, deadlineAt - now()));
  });
  try {
    await Promise.race([workers, deadline]);
  } finally {
    expired = true;
    scheduler.clearTimeout(timer);
  }
  return readings;
}

// 読取器の観測（窓のオブジェクト）を、プールが受け取る平らな `<窓>_*` のキーにする（取得処理と同じ写し方）。
function toPoolObservation(observation) {
  const payload = {};
  for (const name of USAGE_WINDOWS) {
    const window = observation[name];
    if (!window) continue;
    if (Number.isFinite(window.usedPercent)) payload[`${name}_used_percent`] = window.usedPercent;
    if (Number.isFinite(window.windowResetAt)) payload[`${name}_reset_at`] = window.windowResetAt;
    if (Number.isFinite(window.limitWindowSeconds)) payload[`${name}_window_minutes`] = window.limitWindowSeconds / 60;
  }
  return payload;
}

// 1回の読取の結果を口座ごとにプールへ当て、射影が読む口座ごとの取得の記録（取得処理の accountHealth と
// 同じ形）を返す。readings の null は期限までに読めなかった口座。
function applyReadings(pool, entries, readings, at) {
  const health = new Map();
  const record = (key, errorCode, allowed = null) => health.set(key, {
    lastObservationAttemptAt: at, lastObservationSuccessAt: errorCode === null ? at : null, nextObservationAt: null,
    observationErrorCode: errorCode, observationDegraded: false, observationGate: errorCode === null ? 'passed' : 'failed',
    ordinaryUsageAllowed: allowed, rateLimitReachedType: null,
  });
  // 403 の裏付け: 口座が2つ以上で、同じ読取で別の口座の GET が成功している（観測が読めた）。
  const corroborated = index => readings.length >= 2 && readings.some((reading, other) => other !== index && reading?.observation);
  entries.forEach(({ key }, index) => {
    const reading = readings[index];
    if (reading === null) {
      record(key, READ_DEADLINE);
      return;
    }
    const { word, observation } = reading;
    if (word === WORD.credentialsUnavailable) {
      pool.credentials(key, false, at);
      record(key, word);
      return;
    }
    if (word === WORD.accessTokenExpired) {
      pool.usageAuthRejected(key, at, { reason: 'access-token-expired' });
      record(key, word);
      return;
    }
    pool.credentials(key, true, at);
    if (word === WORD.unauthorized || (word === WORD.forbidden && corroborated(index))) {
      pool.usageAuthRejected(key, at, { reason: word === WORD.unauthorized ? 'upstream-unauthorized' : 'upstream-forbidden' });
      record(key, word);
      return;
    }
    if (observation) {
      pool.usageConfirmed(key, at);
      pool.observe(key, toPoolObservation(observation), at, { source: 'usage-get', complete: observation.complete === true,
        ordinaryUsageAllowed: observation.ordinaryUsageAllowed, stopEpoch: 0 });
      record(key, word === WORD.ok ? null : word,
        typeof observation.ordinaryUsageAllowed === 'boolean' ? observation.ordinaryUsageAllowed : null);
      return;
    }
    record(key, word);
  });
  return health;
}

// User-Agent の出どころ（値そのものは出さない）。作れなかった・使用量の読取を1つも送らなかったときは null。
function userAgentSourceOf(readings, config) {
  if (readings.some(reading => IDENTITY_WORDS.has(reading?.word))) return null;
  if (!readings.some(reading => reading?.sent === true)) return null;
  return config.usageUserAgent != null || config.usageOriginator != null ? 'config' : 'codex-version';
}

const NOT_READ = Object.freeze({ lastObservationAttemptAt: null, lastObservationSuccessAt: null, nextObservationAt: null,
  observationErrorCode: null, observationDegraded: false, observationGate: 'not-required', ordinaryUsageAllowed: null,
  rateLimitReachedType: null });

/**
 * 有効化された設定の状態を読む（常駐が答えればその値、無ければ直接読取）。
 * @param {{ config: object, env: object, deadlineAt?: number|null, deps?: object }} options deadlineAt は全体の
 *   期限の時刻（ミリ秒。null なら期限なし）。deps は runStatus の差し替えの部品。
 */
export async function readCodexStatus({ config, env, deadlineAt = null, deps = {} }) {
  const {
    now = Date.now, scheduler = globalThis, request = httpRequest, findCodex = findRealCodex,
    platform = process.platform, readVersion = readCodexVersion, readUsage = readCodexUsage,
    spawn, readCredentials, fetchImpl,
  } = deps;
  const codexPath = findCodex({ codexPath: config.codexPath, env, platform }).path ?? null;
  const overridden = config.usageUserAgent != null || config.usageOriginator != null;

  const fromDaemon = await askDaemonForStatus({ port: config.daemon?.port, request, scheduler });
  if (fromDaemon !== null) return fromDaemon;

  // 版の読取は、常駐が使える値を返さなかった後にだけ始める（常駐が答えたら Codex CLI を起こさない）。
  // 全体の期限は、1回の読取の期限を残りの時間で切ることで守る。
  const version = codexPath === null || overridden ? null
    : Promise.resolve().then(() => readVersion(codexPath, { spawn, scheduler })).catch(() => null);
  const { pool: entries } = codexAccountEntries(config);
  const pool = createCodexPool(entries, config);
  const readAccount = createOneShotUsageReader({ config, codexPath, spawn, readVersion: () => version,
    readCredentials, fetchImpl, now,
    // 1回の読取の期限は、送る時点の全体の期限までの残りを超えない。
    readUsage: options => readUsage(deadlineAt === null ? options
      : { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs, deadlineAt - now())) }) });
  const readings = await readAccounts(config.accounts, readAccount, { deadlineAt, now, scheduler });
  const at = now();
  const health = applyReadings(pool, entries, readings, at);
  const poller = { accountHealth: key => health.get(key) ?? NOT_READ, observation: () => ({ gate: null }) };
  return projectCodexStatus({ enabled: true, pool, poller, userAgentSource: userAgentSourceOf(readings, config),
    events: [], daemon: { reachable: false, startedAt: null }, source: 'direct', nowMs: at });
}

/**
 * `codex-rotator status` の入口（cli.js の取り決めの runStatus(argv, io)）。
 * @param {string[]} argv status の後ろの引数
 * @param {{ stdout?: object, stderr?: object, env?: object }} [io]
 * @param {{
 *   now?: () => number, scheduler?: { setTimeout: Function, clearTimeout: Function }, request?: Function,
 *   loadConfigSnapshot?: Function, findCodex?: Function, platform?: string, spawn?: Function, readVersion?: Function,
 *   readCredentials?: Function, readUsage?: Function, fetchImpl?: typeof fetch,
 * }} [deps] 差し替えの部品（テストのため）。省いたものは本物を使う。
 * @returns {Promise<number>} 終了コード
 */
export async function runStatus(argv = [], io = {}, deps = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const say = line => stderr.write(`${line}\n`);
  const form = parseStatusArgs(argv);
  if (form === null) {
    say(STATUS_USAGE);
    return STATUS_USAGE_EXIT_CODE;
  }
  const now = deps.now ?? Date.now;
  const deadlineAt = form === 'section' ? now() + CODEX_SECTION_DEADLINE_MS : null;
  let snapshot;
  try {
    snapshot = await (deps.loadConfigSnapshot ?? loadCodexConfigSnapshot)({ env });
  } catch {
    say(STATUS_LINE.configUnreadable);
    return STATUS_FAILED_EXIT_CODE;
  }
  const config = snapshot?.config ?? null;
  let status;
  try {
    status = isCodexRotatorActivated(config)
      ? await readCodexStatus({ config, env, deadlineAt, deps: { ...deps, now } })
      : disabledCodexStatus(now());
  } catch {
    say(STATUS_LINE.failed);
    return STATUS_FAILED_EXIT_CODE;
  }
  if (codexStatusProblem(status) !== null) {
    say(STATUS_LINE.failed);
    return STATUS_FAILED_EXIT_CODE;
  }
  stdout.write(form === 'text' ? renderCodexSection(status, { now: now() }).join('\n') : `${JSON.stringify(status)}\n`);
  return 0;
}
