// 知らせを外へ送るだけの部品（Mac の通知と、Slack 互換の受け口への POST）。
//
// 何を送るか・いつ送るかは決めない。それは見張りの部品が決める。ここは渡された字を送り、
// 結果を短い分類の字で返すだけである。
//
// - 実物を持たない。`execFile`（Promise を返す形。`util.promisify(child_process.execFile)`）と
//   `fetchImpl` は必ず外から受け取り、関数でなければ作るときに throw する。試験で差し替え漏れが
//   あっても、実物の osascript や受け口へは届かない。
// - ログは書かない。どの関数も reject しない。
// - 受け口の URL は秘密として扱う。URL は送るたびにファイルから読み直し（長くメモリに残さない）、
//   返す値・誤り・子のプロセスの argv のどこにも、URL とファイルのパスを入れない。fetch や
//   ファイルの読みの誤りは中身を見ずに分類の字へ落とし、誤りの物そのものは外へ出さない。
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const OSASCRIPT_PATH = '/usr/bin/osascript';
const MAC_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 5_000;
/** 最初の1回を含めた送る回数の上限（429・5xx・通信の失敗・時間切れ）。 */
const WEBHOOK_MAX_ATTEMPTS = 3;
/** 429 以外の送り直しの間（1回目の失敗の後・2回目の失敗の後）。 */
const WEBHOOK_RETRY_DELAYS_MS = [30_000, 120_000];
const RETRY_AFTER_DEFAULT_SECONDS = 30;
const RETRY_AFTER_MAX_SECONDS = 300;
const WEBHOOK_TEXT_MAX_CHARS = 3_000;
const RESPONSE_BODY_MAX_BYTES = 1_024;
const URL_FILE_MAX_BYTES = 4_096;
/** 応答の本文に出る既知の語。ほかは other にまとめる。 */
const KNOWN_REASONS = new Set([
  'invalid_payload',
  'user_not_found',
  'action_prohibited',
  'channel_not_found',
  'channel_is_archived',
  'no_service',
  'posting_to_general_channel_denied',
  'rollup_error',
]);
/** 5xx でも送り直さない語（受け口の設定の問題で、送り直しても変わらない）。rollup_error は一時的なので除く。 */
const PERMANENT_REASONS = new Set([...KNOWN_REASONS].filter(reason => reason !== 'rollup_error'));

/**
 * 送り手を作る。
 * @param {object} options
 * @param {Function} options.execFile `(file, args, options) => Promise`。osascript を起こす。
 * @param {Function} options.fetchImpl fetch と同じ形の関数。
 * @param {string} [options.platform] darwin のときだけ Mac の通知を起こす。
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers] 待ちのタイマー。
 * @param {Function} [options.fstat] 開いたファイルの stat を返す関数（試験で持ち主の食い違いを作るため）。
 */
export function createAlertSender({
  execFile,
  fetchImpl,
  platform = process.platform,
  timers = { setTimeout, clearTimeout },
  fstat = handle => handle.stat(),
} = {}) {
  if (typeof execFile !== 'function') throw new TypeError('alert sender requires execFile');
  if (typeof fetchImpl !== 'function') throw new TypeError('alert sender requires fetchImpl');

  const pendingWaits = new Set();
  let stopped = false;

  // 送り直しの待ち。stop() で止めたときは、待たずに false で戻る。
  function wait(ms) {
    if (stopped) return Promise.resolve(false);
    return new Promise(resolve => {
      const entry = { resolve, timer: null };
      entry.timer = timers.setTimeout(() => {
        pendingWaits.delete(entry);
        resolve(true);
      }, ms);
      entry.timer?.unref?.();
      pendingWaits.add(entry);
    });
  }

  async function notifyMac({ title, body } = {}) {
    if (platform !== 'darwin') return { result: 'skipped-platform' };
    const argv = [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
      '-e', 'end run',
      String(body ?? ''),
      String(title ?? ''),
    ];
    let timer = null;
    const timedOut = new Promise(resolve => {
      timer = timers.setTimeout(() => resolve({ result: 'timeout' }), MAC_TIMEOUT_MS);
      timer?.unref?.();
    });
    const run = (async () => {
      try {
        await execFile(OSASCRIPT_PATH, argv, { timeout: MAC_TIMEOUT_MS });
        return { result: 'exited-0' };
      } catch (error) {
        // execFile の timeout で殺されたときは killed が立つ。
        if (error?.killed === true || error?.code === 'ETIMEDOUT') return { result: 'timeout' };
        return { result: 'failed-exec' };
      }
    })();
    try {
      return await Promise.race([run, timedOut]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function checkWebhookFile(urlFile) {
    const read = await readWebhookUrl(urlFile, fstat);
    return read.problem ? { usable: false, problem: read.problem } : { usable: true, problem: null };
  }

  async function postWebhook({ urlFile, text } = {}) {
    const payload = JSON.stringify({ text: limitText(text) });
    let failure = null;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
      const read = await readWebhookUrl(urlFile, fstat);
      if (read.problem) return { result: `unusable-${read.problem}`, reason: null };
      const outcome = await postOnce(fetchImpl, read.url, payload);
      if (outcome.done) return outcome.value;
      failure = outcome;
      if (attempt === WEBHOOK_MAX_ATTEMPTS) break;
      const delayMs = failure.kind === '429' ? failure.retryAfterMs : WEBHOOK_RETRY_DELAYS_MS[attempt - 1];
      if (!(await wait(delayMs))) break;
    }
    return { result: `gave-up-${failure.kind}`, reason: null };
  }

  function stop() {
    stopped = true;
    for (const entry of pendingWaits) {
      timers.clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pendingWaits.clear();
  }

  return { notifyMac, postWebhook, checkWebhookFile, stop };
}

// 1回だけ送る。終わり（ok・rejected）なら { done: true, value }、送り直す候補なら
// { done: false, kind: '429'|'5xx'|'network'|'timeout', retryAfterMs } を返す。
async function postOnce(fetchImpl, url, payload) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { done: false, kind: 'timeout' };
    // redirect: 'error' のとき、fetch は cause の message が 'unexpected redirect' の TypeError で断る。
    if (error?.cause?.message === 'unexpected redirect') return { done: true, value: { result: 'rejected-redirect', reason: null } };
    return { done: false, kind: 'network' };
  }

  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    await discardBody(response);
    return { done: false, kind: 'network' };
  }
  if (status >= 200 && status <= 299) {
    await discardBody(response);
    return { done: true, value: { result: 'ok', reason: null } };
  }
  if (status >= 300 && status <= 399) {
    await discardBody(response);
    return { done: true, value: { result: 'rejected-redirect', reason: null } };
  }
  if (status === 429) {
    const retryAfterMs = retryAfterSeconds(response.headers) * 1000;
    await discardBody(response);
    return { done: false, kind: '429', retryAfterMs };
  }
  const reason = await responseReason(response);
  if (status >= 500 && !PERMANENT_REASONS.has(reason)) return { done: false, kind: '5xx' };
  // 429 を除く 4xx と、送り直しても変わらない語の 5xx。1xx もここで断る。
  return { done: true, value: { result: `rejected-${status}`, reason } };
}

function retryAfterSeconds(headers) {
  let raw;
  try {
    raw = headers?.get?.('retry-after');
  } catch {
    raw = null;
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return RETRY_AFTER_DEFAULT_SECONDS;
  return Math.min(Number(text), RETRY_AFTER_MAX_SECONDS);
}

// 応答の本文を 1 KiB まで読み、既知の語ならその語、ほかは other を返す。
async function responseReason(response) {
  let text = '';
  try {
    const reader = response?.body?.getReader?.();
    if (reader) {
      const chunks = [];
      let total = 0;
      while (total < RESPONSE_BODY_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      if (total >= RESPONSE_BODY_MAX_BYTES) await reader.cancel().catch(() => {});
      text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).subarray(0, RESPONSE_BODY_MAX_BYTES).toString('utf8');
    }
  } catch {
    return 'other';
  }
  const word = text.trim();
  return KNOWN_REASONS.has(word) ? word : 'other';
}

async function discardBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // 読まずに捨てるだけなので、失敗しても結果は変わらない。
  }
}

function limitText(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  const chars = Array.from(value);
  return chars.length > WEBHOOK_TEXT_MAX_CHARS ? chars.slice(0, WEBHOOK_TEXT_MAX_CHARS).join('') : value;
}

// URL のファイルを確かめて読む。{ url } か { problem: 分類 } を返し、reject しない。
// 分類：missing・not-absolute・type・mode・owner・size・format・scheme・read。
async function readWebhookUrl(urlFile, fstat) {
  if (typeof urlFile !== 'string' || !isAbsolute(urlFile)) return { problem: 'not-absolute' };
  let handle;
  try {
    try {
      handle = await open(urlFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { problem: 'missing' };
      // O_NOFOLLOW で symlink を開くと ELOOP になる。
      if (error?.code === 'ELOOP') return { problem: 'type' };
      return { problem: 'read' };
    }
    let info;
    try {
      info = await fstat(handle);
    } catch {
      return { problem: 'read' };
    }
    if (!info?.isFile?.()) return { problem: 'type' };
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && info.uid !== uid) return { problem: 'owner' };
    if ((info.mode & 0o077) !== 0) return { problem: 'mode' };
    if (!(info.size <= URL_FILE_MAX_BYTES)) return { problem: 'size' };
    // stat の後に伸びたファイルも断れるよう、上限より1バイト多く読む。
    const buffer = Buffer.alloc(URL_FILE_MAX_BYTES + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
    } catch {
      return { problem: 'read' };
    }
    if (length > URL_FILE_MAX_BYTES) return { problem: 'size' };
    return parseWebhookUrl(buffer.subarray(0, length).toString('utf8'));
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseWebhookUrl(content) {
  const line = content.trim();
  if (!line || /\s/.test(line)) return { problem: 'format' };
  let url;
  try {
    url = new URL(line);
  } catch {
    // 誤りの物は input に字を持つので、外へ出さずに分類だけを返す。
    return { problem: 'format' };
  }
  if (url.protocol !== 'https:') return { problem: 'scheme' };
  if (url.username || url.password || !url.hostname) return { problem: 'format' };
  return { url: url.href };
}
