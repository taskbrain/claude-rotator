// usage-events.jsonl: 上流へ送った要求1回ごとに、使用量イベントを1行追記する。
//
// 読み手は同じホストで動く別の集計プロセスで、`eventId` で重複を除いてから
// アカウント別のコストを出す。行の形（キー名・`usage` の5項目）は集計側の取込処理が
// 検査するので、ここを変えるときは集計側も合わせて変えること。
//
// 設計上の一線:
// - **許可リスト方式。** 要求・応答の本文、ヘッダ、資格情報は一切書かない。
// - **転送は止めない（fail-open）、失敗は必ずログに残す（fail-loud）。** 追記の失敗は
//   ログへ1行書いて握りつぶし、転送・口座の切り替えへは波及させない。
// - ローテーションはしない（固定名 `usage-events.jsonl`）。肥大化は `sizeWarnBytes` を
//   超えたときにログで知らせるだけにとどめる。

import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appConfigDir, expandHome } from './paths.js';

export const USAGE_EVENTS_FILENAME = 'usage-events.jsonl';
export const USAGE_EVENTS_DIR_ENV = 'CLAUDE_ROTATOR_USAGE_EVENTS_DIR';
export const DEFAULT_SIZE_WARN_BYTES = 500 * 1024 * 1024;
export const DEFAULT_SIZE_CHECK_EVERY = 1000;
export const DEFAULT_WARN_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_PENDING = 10000;

/**
 * 出力先ディレクトリ。既定は `<appConfigDir>/usage-events`（通常は
 * `~/.config/claude-rotator/usage-events`）で、`CLAUDE_ROTATOR_USAGE_EVENTS_DIR` で上書きできる。
 */
export function usageEventsDir(env = process.env, home = homedir()) {
  const override = env[USAGE_EVENTS_DIR_ENV];
  if (override) return expandHome(override, home);
  return join(appConfigDir(env, home), 'usage-events');
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * `parseUsageObservation()` の結果を、イベントの `usage` へ写す。
 *
 * - 2xx 以外、または解析できなかった応答は `null`（集計側はコスト計算の対象外として扱う）。
 * - キャッシュ作成の 5m/1h 内訳は、内訳が報告されていれば（または作成量が 0 なら）そのまま
 *   使う。集約値だけが正で内訳が無いときは、5m/1h の割り振りを推測せず両方 `null`
 *   （算出不能）にする。集計側はこれを「キャッシュ内訳が不完全」として数える。
 *
 * @param {object|null} observation `parseUsageObservation()` の戻り値。
 * @param {number|null} statusCode 上流の HTTP ステータス。
 * @returns {object|null}
 */
export function usageFromObservation(observation, statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) return null;
  if (!observation || observation.parse !== 'ok') return null;
  const breakdownReported = observation.cacheCreation5mTokens + observation.cacheCreation1hTokens > 0;
  const resolvable = breakdownReported || observation.cacheCreationTokens === 0;
  return {
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    cacheCreation5m: resolvable ? observation.cacheCreation5mTokens : null,
    cacheCreation1h: resolvable ? observation.cacheCreation1hTokens : null,
    cacheRead: observation.cacheReadTokens,
  };
}

/**
 * 1行ぶんのイベントを組み立てる。**ここに挙げたキー以外は決して書かない**（許可リスト）。
 * `eventId` は `requestId/attempt`。`requestId` が取れない失敗（接続エラー等）は UUIDv4。
 */
export function buildUsageEvent({
  ts,
  requestId = null,
  attempt,
  accountId,
  messageId = null,
  model = null,
  outcome,
  statusCode = null,
  errorType = null,
  usage = null,
}) {
  const normalizedRequestId = stringOrNull(requestId);
  return {
    ts,
    eventId: normalizedRequestId ? `${normalizedRequestId}/${attempt}` : randomUUID(),
    requestId: normalizedRequestId,
    messageId: stringOrNull(messageId),
    accountId,
    model: stringOrNull(model),
    attempt,
    outcome,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    errorType: stringOrNull(errorType),
    usage: usage
      ? {
        inputTokens: nonNegativeIntegerOrNull(usage.inputTokens),
        outputTokens: nonNegativeIntegerOrNull(usage.outputTokens),
        cacheCreation5m: nonNegativeIntegerOrNull(usage.cacheCreation5m),
        cacheCreation1h: nonNegativeIntegerOrNull(usage.cacheCreation1h),
        cacheRead: nonNegativeIntegerOrNull(usage.cacheRead),
      }
      : null,
  };
}

/**
 * usage-events.jsonl への追記係。
 *
 * - **呼び出し側を待たせない。** `append()` はイベントを直列キューへ積んで即座に戻る
 *   （戻り値の Promise はそのイベントの処理が終わると解決し、決して reject しない）。
 *   転送のホットパスはこれを await しないこと。順序は積んだ順に保たれる。
 *   `append()` にはイベントそのものか、イベントへ解決する Promise を渡せる。Promise が
 *   reject しても、その場で握って（未処理の rejection にせず）ログ1行にとどめる。
 * - `flush()` は、その時点までに積んだイベントがすべて処理されると解決する（試験用）。
 *   プロセス終了時の積み残しは捨ててよい（転送へは影響しない）。
 * - **権限を確保できないときは書かない。** ディレクトリ 0700・ファイル 0600 に直せない
 *   （chmod 失敗、または stat で所有者が自分でない／グループ・他者に権限が残る）ときは
 *   そのイベントを捨ててログ1行（`warnIntervalMs` に1回へ抑制）とし、次のイベントで
 *   また確保を試みる。確保済みの印は確保に成功してから立てる。
 */
export function createUsageEventWriter({
  dir = usageEventsDir(),
  logger = null,
  sizeWarnBytes = DEFAULT_SIZE_WARN_BYTES,
  sizeCheckEvery = DEFAULT_SIZE_CHECK_EVERY,
  warnIntervalMs = DEFAULT_WARN_INTERVAL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  now = Date.now,
  // 試験用の注入口（chmod の失敗・書込の停滞を再現する）。本番は node:fs/promises のまま。
  fsOps = {},
} = {}) {
  const fs = { appendFile, chmod, mkdir, stat, ...fsOps };
  const path = join(dir, USAGE_EVENTS_FILENAME);
  let dirEnsured = false;
  let fileEnsured = false;
  let appended = 0;
  let pending = 0;
  let tail = Promise.resolve();
  const throttled = new Map();

  // ロガー自身が投げても append() の外へ漏らさない（計測は fail-open）。
  function log(line) {
    try {
      logger?.(`${new Date().toISOString()} ${line}`);
    } catch {
      // 計測の失敗で転送を壊さない。
    }
  }

  // 同じ種類の警告は warnIntervalMs に1回だけ出す。抑えた件数は次の1行に載せる。
  function logThrottled(key, line) {
    const entry = throttled.get(key) || { lastAt: null, suppressed: 0 };
    const at = now();
    if (entry.lastAt !== null && at - entry.lastAt < warnIntervalMs) {
      entry.suppressed += 1;
      throttled.set(key, entry);
      return;
    }
    log(entry.suppressed > 0 ? `${line} suppressed=${entry.suppressed}` : line);
    throttled.set(key, { lastAt: at, suppressed: 0 });
  }

  // chmod で mode に直し、stat で本当にそうなったかを確かめる。問題なければ null。
  async function secure(target, mode, kind) {
    try {
      await fs.chmod(target, mode);
    } catch (error) {
      return `reason=chmod errorType=${errorType(error)}`;
    }
    let info;
    try {
      info = await fs.stat(target);
    } catch (error) {
      return `reason=stat errorType=${errorType(error)}`;
    }
    if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) return 'reason=type';
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && info.uid !== uid) return 'reason=owner';
    if ((info.mode & 0o077) !== 0) return 'reason=mode';
    return null;
  }

  // mkdir の mode は作成時にしか効かないので、既存のゆるい権限は chmod で 0700 に直す。
  async function ensureDir() {
    if (dirEnsured) return true;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const problem = await secure(dir, 0o700, 'dir');
    if (problem) {
      logThrottled('dir', `usage-events-chmod result=failed target=dir ${problem} action=skip-event`);
      return false;
    }
    dirEnsured = true;
    return true;
  }

  // appendFile の mode も作成時にしか効かないので、書く前に（無ければ空で作って）0600 に直す。
  async function ensureFile() {
    if (fileEnsured) return true;
    await fs.appendFile(path, '', { mode: 0o600 });
    const problem = await secure(path, 0o600, 'file');
    if (problem) {
      logThrottled('file', `usage-events-chmod result=failed target=file ${problem} action=skip-event`);
      return false;
    }
    fileEnsured = true;
    return true;
  }

  async function warnIfOversized() {
    try {
      const info = await fs.stat(path);
      if (info.size > sizeWarnBytes) {
        log(`usage-events-size result=over-limit bytes=${info.size} limitBytes=${sizeWarnBytes}`);
      }
    } catch (error) {
      log(`usage-events-size result=failed errorType=${errorType(error)}`);
    }
  }

  async function writeOne(settled) {
    if (settled.error !== undefined) {
      log(`usage-events-append result=failed errorType=${errorType(settled.error)}`);
      return;
    }
    if (!settled.event) return;
    try {
      if (!(await ensureDir())) return;
      if (!(await ensureFile())) return;
      await fs.appendFile(path, `${JSON.stringify(settled.event)}\n`, { mode: 0o600 });
    } catch (error) {
      dirEnsured = false;
      fileEnsured = false;
      log(`usage-events-append result=failed errorType=${errorType(error)}`);
      return;
    }
    appended += 1;
    if (appended % sizeCheckEvery === 0) await warnIfOversized();
  }

  function append(eventOrPromise) {
    // reject をその場で握る。キューの順番待ちの間に reject しても未処理扱いにならない。
    const settled = Promise.resolve(eventOrPromise).then(event => ({ event }), error => ({ error }));
    if (pending >= maxPending) {
      logThrottled('queue', `usage-events-append result=dropped reason=queue-full maxPending=${maxPending}`);
      return Promise.resolve();
    }
    pending += 1;
    const run = tail
      .then(() => settled)
      .then(writeOne)
      .catch(error => log(`usage-events-append result=failed errorType=${errorType(error)}`))
      .finally(() => {
        pending -= 1;
      });
    tail = run;
    return run;
  }

  function flush() {
    return tail;
  }

  return { append, flush, path };
}

function errorType(error) {
  return error?.code || error?.name || 'unknown';
}
