// Codex の利用枠（レート制限）を、生成を伴わずに読む取得器。
// 使用量の読取は、Codex CLI が使用量を読むのと同じ固定 URL（`GET {base}/wham/usage`）へ送る。
// 必須ヘッダと応答 JSON の形も Codex CLI の実装に合わせる（応答の検証と正規化は normalizeUsagePayload）。
// 取得の方式・安全境界・失敗の扱いは、このあとのコメントに書く。
//
// 責務は2つだけ: 固定 URL への GET を1回と、その応答の検証・正規化。
// **行わないこと**: リトライ／口座選択／プール状態の変更／資格情報の更新・書込／
// 子プロセスの起動／クレジット・追加枠の利用。スケジュールと観測の適用は呼び出す側
// （定期取得は usage-poller.js）の責務であり、ここは「観測できた事実」だけを返す。
//
// 安全境界: 固定 URL・GET のみ／リダイレクトを追従しない（認証情報を
// 別ホストへ流さない）／本文は上限付きで読み、JSON 以外（Cloudflare チャレンジの
// HTML 等）は本文を記録せず種別だけ返す／`x-openai-codex-luna-reserve` を送らない
// （受動的な使用量読取は opt-in しない）／利用者由来のヘッダを転送しない
// （任意の送信ヘッダを引数で受け取る口を持たない＝構造で担保する。引数で受けるのは
// 固定集合のうち User-Agent と originator の値だけ）。
//
// 絶対条件: chatgpt.com への実接続は本番経路だけ。テストは fetchImpl 注入の偽 fetch
// のみを使い、実ネットワークへは出ない。

// 接続前失敗の判定と chunk の正規化は、ほかのモジュールと共用にせず、この取得器が使う
// 3 定義だけをここに置いて依存を 0 にする（Codex 側には生成を送る経路が無いため）。
// ここに残すのは TCP 接続が確立する前にしか起こり得ないコード（DNS 解決失敗・接続拒否）だけ。
const PRE_CONNECT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/** `fetch()` の reject（`cause.code` または `code`）から接続前失敗のコードを取り出す。該当しなければ `undefined`。 */
function preConnectErrorCode(error) {
  const code = error?.cause?.code || error?.code;
  return typeof code === 'string' && PRE_CONNECT_CODES.has(code) ? code : undefined;
}

/** 本文の 1 chunk（`Buffer`|`Uint8Array`|`string`）を `Buffer` へ揃える。 */
function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk);
}

/** Codex CLI の `rate_limit_status_url()` の ChatGptApi 経路（既定 base_url = https://chatgpt.com/backend-api/）。 */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

// User-Agent と originator ヘッダの値はここに持たない（製品名と版の固定値をこのファイルに
// 書かない）。呼び出し側が実行時に組み立てて readCodexUsage() へ必ず渡す。

/** 本文の読取上限。超過は本文を捨てて種別だけ返す。 */
export const MAX_USAGE_BODY_BYTES = 64 * 1024;
/** 読取 HTTP の全体期限の既定（本文読取を含む）。 */
export const DEFAULT_USAGE_READ_TIMEOUT_MS = 5000;
// `reset_at`（絶対秒）と `reset_after_seconds`（相対秒）の突合に許す差。
// 秒精度の切り捨て・端末とサーバの時計差・往復遅延を吸収する幅であり、
// 「時間単位でずれている」級の矛盾だけを不完全として弾くための値。
export const RESET_SKEW_TOLERANCE_MS = 120000;

// RFC3339 で表現できる上限（account-pool.js と同じ規約）。
const MAX_TIMESTAMP_MS = 253402300799999;
// ログ・表示へ流れる唯一の上流文字列。語彙を限定して混入を防ぐ。
const REACHED_TYPE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const JSON_CONTENT_TYPE = /\bapplication\/json\b|\+json\b/i;

const WINDOW_FIELDS = [['primary', 'primary_window'], ['secondary', 'secondary_window']];

/** 数値のみを採る。文字列・真偽・NaN・範囲外は観測として採らない（0 へ補完しない）。 */
function readUsedPercent(raw) {
  if (raw === undefined || raw === null) return { value: null, issue: 'missing' };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { value: null, issue: 'invalid' };
  if (raw < 0 || raw > 100) return { value: null, issue: 'out-of-range' };
  // 整数（GET）でも小数でもそのまま返す。丸め・補正をここで加えない。
  return { value: raw, issue: null };
}

/**
 * 秒を表す i32 フィールドを三分類で読む。
 * - **欠測**（キー無し・`null`）= `{ value: null, invalid: false }`。上流が返さなかっただけで
 *   矛盾ではないので、窓を不完全にはしない（欠測を補完も否定もしない）。
 * - **読めた値** = `{ value, invalid: false }`。
 * - **存在するが不正**（型違い・非整数・負値・`positive` 指定で 0）= `{ value: null, invalid: true }`。
 *   値を落とすだけでは矛盾が消えず、その応答が「完全観測」として復帰の判定に使われてしまう。
 */
function readSeconds(raw, { positive = false } = {}) {
  if (raw === undefined || raw === null) return { value: null, invalid: false };
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return { value: null, invalid: true };
  if (raw < 0 || (positive && raw === 0)) return { value: null, invalid: true };
  return { value: raw, invalid: false };
}

function readWindowResetAt(raw) {
  const seconds = readSeconds(raw);
  if (seconds.value === null) return seconds;
  const resetAt = seconds.value * 1000;
  if (!Number.isSafeInteger(resetAt) || resetAt > MAX_TIMESTAMP_MS) return { value: null, invalid: true };
  return { value: resetAt, invalid: false };
}

/**
 * 1つの窓を正規化する。`null`・欠測（キー無し）は「窓の不在」として `null` を返し、
 * 値が壊れている窓は「存在するが使えない」として不完全な窓を返す（不在と
 * 欠測を同一視しない）。
 */
function normalizeWindow(raw, receivedAt) {
  if (raw === undefined || raw === null) return null;
  // 窓が object でなければ形が変わっている。「不在」ではなく「存在するが使えない窓」。
  const source = typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const used = source ? readUsedPercent(source.used_percent) : { value: null, issue: 'invalid' };
  const reset = source ? readWindowResetAt(source.reset_at) : { value: null, invalid: true };
  const resetAfter = source ? readSeconds(source.reset_after_seconds) : { value: null, invalid: true };
  const windowLength = source ? readSeconds(source.limit_window_seconds, { positive: true }) : { value: null, invalid: true };
  let incompleteReason = null;
  if (used.value === null) incompleteReason = 'used-percent-unusable';
  // **存在するのに読めないリセット情報を持つ応答を完全観測にしない**。値を null へ
  // 落として通すと、矛盾した応答が復帰の判定の根拠になり停止ラッチを解除できてしまう。
  // 使用率は停止判定に使えるので残す（停止判定には `used_percent` を使う）。
  else if (reset.invalid || resetAfter.invalid) incompleteReason = 'reset-unusable';
  else if (windowLength.invalid) incompleteReason = 'window-length-unusable';
  else if (reset.value !== null && reset.value <= receivedAt) incompleteReason = 'reset-in-past';
  else if (reset.value !== null && resetAfter.value !== null &&
    Math.abs(reset.value - (receivedAt + resetAfter.value * 1000)) > RESET_SKEW_TOLERANCE_MS) {
    // 窓長から reset 時刻を導出せず、両者が食い違う観測は復帰判定に使わせない。
    incompleteReason = 'reset-mismatch';
  }
  return { usedPercent: used.value, usedPercentIssue: used.issue, windowResetAt: reset.value,
    resetAfterSeconds: resetAfter.value, limitWindowSeconds: windowLength.value,
    complete: incompleteReason === null, incompleteReason };
}

/** 応答 JSON を観測へ写像する。形が違えば `null`（＝取得方式の障害）。 */
function normalizeUsagePayload(parsed, receivedAt) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rateLimit = parsed.rate_limit;
  if (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) return null;
  const observation = {
    ordinaryUsageAllowed: typeof rateLimit.allowed === 'boolean' ? rateLimit.allowed : null,
    rateLimitReachedType: typeof parsed.rate_limit_reached_type === 'string' &&
      REACHED_TYPE_PATTERN.test(parsed.rate_limit_reached_type) ? parsed.rate_limit_reached_type : null,
    primary: null, secondary: null, complete: false,
    // 選択判定には使わない。存在の有無だけを debug へ出す。
    // 件数・残高を写さないことで「クレジット消費・追加枠利用へ進む」経路を構造的に断つ。
    debug: {
      creditsPresent: parsed.credits !== undefined && parsed.credits !== null,
      resetCreditsPresent: parsed.rate_limit_reset_credits !== undefined && parsed.rate_limit_reset_credits !== null,
      additionalRateLimitsPresent: Array.isArray(parsed.additional_rate_limits) && parsed.additional_rate_limits.length > 0,
    },
  };
  for (const [name, field] of WINDOW_FIELDS) observation[name] = normalizeWindow(rateLimit[field], receivedAt);
  const windows = WINDOW_FIELDS.map(([name]) => observation[name]).filter(Boolean);
  // 「完全観測」= `allowed` が取れ、存在する窓がすべて矛盾なく読めたもの（復帰の判定に使える観測）。
  observation.complete = typeof observation.ordinaryUsageAllowed === 'boolean' &&
    windows.length > 0 && windows.every(window => window.complete);
  return observation;
}

function classifyStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server-error';
  return 'client-error';
}

function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* 分類済みの結果を壊さない */ }
}

/** 上限付きで本文を読む。超過したら読み切らずに打ち切り、本文を保持しない。 */
async function readBoundedText(response, maxBytes) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? { overflow: true } : { text };
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = toBuffer(value);
      size += chunk.length;
      if (size > maxBytes) return { overflow: true };
      chunks.push(chunk);
    }
  } finally {
    try { Promise.resolve(reader.cancel?.()).catch(() => {}); } catch { /* 同上 */ }
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * 登録口座1つの使用量を GET 1回で読む。呼び出し側へ返すのは分類済みの事実だけで、
 * 上流の生本文・`account_id`・`user_id`・資格情報は一切含めない。
 *
 * `userAgent` と `originator` は必須。呼び出し側が実行時に組み立てた値を渡す。無い・空・
 * 文字列でないときは既定値を補わず、送信せずに TypeError で拒否する。
 *
 * @param {{
 *   credentials: { accessToken: string, accountId?: string },
 *   userAgent: string, originator: string,
 *   fetchImpl?: typeof fetch, now?: () => number, signal?: AbortSignal,
 *   timeoutMs?: number, maxBodyBytes?: number,
 * }} options
 * @returns {Promise<{
 *   classification: 'success'|'http-error'|'invalid-response'|'network-error'|'aborted',
 *   failure: string|null, status: number|null, retryAfter: string|null, errorCode: string|null,
 *   startedAt: number, receivedAt: number, durationMs: number, observation: object|null,
 * }>}
 */
export async function readCodexUsage({
  credentials, userAgent, originator, fetchImpl = fetch, now = Date.now, signal,
  timeoutMs = DEFAULT_USAGE_READ_TIMEOUT_MS, maxBodyBytes = MAX_USAGE_BODY_BYTES,
} = {}) {
  const accessToken = credentials?.accessToken;
  if (typeof accessToken !== 'string' || !accessToken.trim()) throw new TypeError('usage read credentials required');
  // ChatGPT-Account-ID は必須ヘッダ。`readCodexSendSnapshot()` は口座 ID を必ず返す
  // 契約（credentials.js の identity 検査）なので、欠けた入力は正規のスナップショット
  // ではない。口座を指定しない照会を送らず、送信前に拒否する。
  const accountId = credentials.accountId;
  if (typeof accountId !== 'string' || !accountId.trim()) throw new TypeError('usage read account id required');
  // 既定値へ落とさない。値そのものはメッセージに載せない。
  if (typeof userAgent !== 'string' || !userAgent.trim()) throw new TypeError('usage read user agent required');
  if (typeof originator !== 'string' || !originator.trim()) throw new TypeError('usage read originator required');
  const startedAt = now();
  // 観測に使った受領時刻と、結果に載せる受領時刻を同一にする（取得開始時刻・
  // 完了時刻を観測へ結び付ける）。呼び出し側はこの receivedAt を観測時刻として使う。
  const settle = ({ receivedAt = now(), ...fields }) => ({
    classification: 'network-error', failure: null, status: null, retryAfter: null, errorCode: null,
    observation: null, ...fields, startedAt, receivedAt, durationMs: receivedAt - startedAt,
  });

  const controller = new AbortController();
  const timeoutError = Object.assign(new Error('USAGE_READ_TIMEOUT'), { code: 'USAGE_READ_TIMEOUT' });
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer?.unref?.();

  try {
    if (signal?.aborted) return settle({ classification: 'aborted' });
    // 送信ヘッダは固定集合。任意のヘッダを受け取る口を持たず、呼び出し側から受けるのは
    // User-Agent と originator の値だけ。
    const response = await fetchImpl(CODEX_USAGE_URL, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': userAgent,
        originator,
        'ChatGPT-Account-ID': accountId,
      },
    });
    const status = Number(response?.status);
    if (!Number.isFinite(status)) { cancelBody(response); return settle({ classification: 'invalid-response', failure: 'malformed-shape' }); }
    if (status >= 300 && status < 400) {
      // 追従すれば Authorization が別ホストへ出る。本文も読まない。
      cancelBody(response);
      return settle({ classification: 'invalid-response', failure: 'redirect', status });
    }
    if (status < 200 || status >= 300) {
      cancelBody(response);
      return settle({ classification: 'http-error', failure: classifyStatus(status), status,
        // Retry-After は読取側の再読取にのみ使う値。生成枠の枯渇と同一視しない。
        retryAfter: status === 429 ? (response.headers?.get?.('retry-after') ?? null) : null });
    }
    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      // Cloudflare チャレンジ等。本文は読まず・記録せず、種別だけを返す。
      cancelBody(response);
      return settle({ classification: 'invalid-response', failure: 'non-json', status });
    }
    const body = await readBoundedText(response, maxBodyBytes);
    if (body.overflow) return settle({ classification: 'invalid-response', failure: 'body-too-large', status });
    let parsed;
    try { parsed = JSON.parse(body.text); } catch { return settle({ classification: 'invalid-response', failure: 'non-json', status }); }
    const receivedAt = now();
    const observation = normalizeUsagePayload(parsed, receivedAt);
    if (!observation) return settle({ classification: 'invalid-response', failure: 'malformed-shape', status });
    return settle({ classification: 'success', status, observation, receivedAt });
  } catch (error) {
    if (signal?.aborted) return settle({ classification: 'aborted' });
    if (error === timeoutError || controller.signal.reason === timeoutError || error?.code === 'USAGE_READ_TIMEOUT') {
      return settle({ classification: 'network-error', failure: 'timeout' });
    }
    // 任意のエラーメッセージは残さない。許可済みの接続前コードだけを添える。
    return settle({ classification: 'network-error', failure: 'network', errorCode: preConnectErrorCode(error) ?? null });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
