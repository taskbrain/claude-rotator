// 応答本文から usage を読むだけの純関数群と、`config.observability` の正規化。
//
// 設計上の一線: **本文を書き換えない。** ここが受け取るのは `Buffer.concat` 済みの
// 写しであり、クライアントへ流すバイト列とは別物である。解凍も解析用の写しに対して
// だけ行う（計画書 Architecture・リスク R-6）。
//
// `src/config.js` は触らない。`createDefaultConfig()` へキーを足すと既存 config.json との
// 浅いマージ事故を起こすため、`session-affinity.js` / `openai-bridge.js` と同じく
// 自前モジュールで正規化して `Object.freeze` した値を返す（計画書「設定」節）。

import zlib from 'node:zlib';
import { promisify } from 'node:util';

const MIB = 1024 * 1024;

export const DEFAULT_OBSERVABILITY = Object.freeze({
  requestLog: Object.freeze({
    // U-3（母艦の即決）: 既定 on。観測は「すべての対策の効果測定の前提」であり、
    // 既定 off だと本番で誰も有効化しないまま次の設計判断へ進むことになる。
    enabled: true,
    // 要求本文の `metadata.user_id` へのフォールバック。既定 off（PII とコストの両面。
    // リスク R-7）。ヘッダ付与率を測ってから U-5 で決める。
    sessionFromBody: false,
    maxBodyBytes: 16 * MIB,
  }),
  upstream: Object.freeze({
    // Task 1 Step 0 の実測: Claude Code 2.1.275 は `gzip, deflate, br, zstd` を送る。
    // zstd は Node 22.15 以降にしか解凍 API が無いので、持たない版で動かしたときだけ
    // 上流向けの一覧から落とす。
    //
    // **本番の rotator は Node 22.22.2 で動いており zstdDecompress を持つため、
    // この書き換えは発動せず要求ヘッダは現行とバイト同一のままになる。** 実質的には
    // 古い Node へ載せ替えたときの安全網である。false にすれば完全な素通しに戻る。
    dropUndecodableAcceptEncoding: true,
  }),
  // U-4（母艦の即決）: 32 MiB。2世代で 64 MiB ＝ 約 4.1 日となり現行（約 2.4 日）より広い。
  logMaxBytes: 32 * MIB,
});

const OBSERVABILITY_RANGES = Object.freeze({
  maxBodyBytes: { min: 1 * MIB, max: 64 * MIB },
  logMaxBytes: { min: 1 * MIB, max: 256 * MIB },
});

/**
 * `config.observability` を正規化する。
 * セクションが無い・型が違う・キーが欠けている、のいずれでも既定へ倒れるので、
 * 戻り値のキーが `undefined` になることはない。
 *
 * **毎回この関数を通し直すこと。** 起動時の1回きりの正規化を使い回すと、
 * `POST /internal/reload` で入ってきた値にクランプが効かない。
 *
 * @param {unknown} raw `config.observability`。
 * @returns {Readonly<typeof DEFAULT_OBSERVABILITY>} 凍結した設定。
 */
export function normalizeObservability(raw) {
  const source = plainObject(raw);
  const requestLog = plainObject(source.requestLog);
  const upstream = plainObject(source.upstream);
  return Object.freeze({
    requestLog: Object.freeze({
      enabled: boolOr(requestLog.enabled, DEFAULT_OBSERVABILITY.requestLog.enabled),
      sessionFromBody: boolOr(requestLog.sessionFromBody, DEFAULT_OBSERVABILITY.requestLog.sessionFromBody),
      maxBodyBytes: clampOr(
        requestLog.maxBodyBytes,
        OBSERVABILITY_RANGES.maxBodyBytes,
        DEFAULT_OBSERVABILITY.requestLog.maxBodyBytes,
      ),
    }),
    upstream: Object.freeze({
      dropUndecodableAcceptEncoding: boolOr(
        upstream.dropUndecodableAcceptEncoding,
        DEFAULT_OBSERVABILITY.upstream.dropUndecodableAcceptEncoding,
      ),
    }),
    logMaxBytes: clampOr(source.logMaxBytes, OBSERVABILITY_RANGES.logMaxBytes, DEFAULT_OBSERVABILITY.logMaxBytes),
  });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function clampOr(value, { min, max }, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

// ---------------------------------------------------------------------------
// 解凍
// ---------------------------------------------------------------------------

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotliDecompress = promisify(zlib.brotliDecompress);
// Node 22.15 未満には zstd の API が無い。feature-detect して、無ければ
// `unsupported-encoding` として観測可能に落とす（黙って 0 件にしない）。
const zstdDecompress = typeof zlib.zstdDecompress === 'function'
  ? promisify(zlib.zstdDecompress)
  : null;

/**
 * 「大きすぎて読めなかった」を表すエラーコード。
 *
 * - `ERR_BUFFER_TOO_LARGE`: zlib の `maxOutputLength` 超過（RangeError）。gzip / deflate /
 *   br / zstd のいずれも同じコードで投げる。
 * - `ERR_STRING_TOO_LONG`: `Buffer#toString()` の上限（`buffer.constants.MAX_STRING_LENGTH`
 *   ＝ 536,870,888）超過。
 *
 * どちらも本文が壊れているわけではないので `unparsable` ではなく `too-large` として数える
 * （README の「`too-large`＝`maxBodyBytes` 超」と同じ意味）。
 */
const SIZE_ERROR_CODES = new Set(['ERR_BUFFER_TOO_LARGE', 'ERR_STRING_TOO_LONG']);

function isSizeError(error) {
  return SIZE_ERROR_CODES.has(error?.code);
}

// 各デコーダは第2引数に zlib のオプション（`maxOutputLength`）を受け取る。
// **渡し忘れると上限が buffer.kMaxLength（約 4 GiB）になり、解凍爆弾が素通りする。**
const DECODERS = new Map([
  ['gzip', gunzip],
  ['x-gzip', gunzip],
  // Content-Encoding: deflate には zlib 形式と raw 形式の両方が実在するので、
  // zlib 形式で失敗したら raw で読み直す。
  ['deflate', async (buffer, options) => {
    try {
      return await inflate(buffer, options);
    } catch (error) {
      // 上限超過は raw で読み直しても同じ結果にしかならない。ここで握ると理由が
      // `unparsable` に化けるので、そのまま上げて `too-large` として数えさせる。
      if (isSizeError(error)) throw error;
      return inflateRaw(buffer, options);
    }
  }],
  ['br', brotliDecompress],
  ['zstd', zstdDecompress],
]);

/** 解けると分かっている符号化の一覧（`upstreamAcceptEncoding` の判定に使う）。 */
const KNOWN_ENCODINGS = new Set([...DECODERS.keys(), 'identity']);

function normalizeEncoding(raw) {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase();
  if (token === '' || token === 'identity') return null;
  return token;
}

/**
 * 上流へ送る `accept-encoding` から、この実行環境が解けない符号化を落とす。
 *
 * Global Constraints「要求ヘッダを変えない」に対する**唯一の例外**である
 * （計画書 Task 1 Step 0 の帰結2）。落とすのは「知っているが解けない」トークンだけで、
 * 未知のトークンは残す。落とすものが無ければ受け取った文字列をそのまま返すので、
 * zstd を解ける環境では要求ヘッダは現行とバイト同一のままになる。
 *
 * @param {unknown} raw クライアントの `accept-encoding` ヘッダ値。
 * @returns {unknown} 書き換えた値。書き換え不要なら受け取った値そのもの。
 */
export function upstreamAcceptEncoding(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return raw;
  const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
  const kept = parts.filter(part => {
    const token = part.split(';')[0].trim().toLowerCase();
    if (!KNOWN_ENCODINGS.has(token)) return true; // 知らないものは触らない。
    return DECODERS.get(token) !== null; // identity は Map に無いので undefined ＝ 残す。
  });
  if (kept.length === parts.length) return raw;
  // 全部落ちると上流が何も返せなくなるので、明示的に identity を要求する。
  return kept.length === 0 ? 'identity' : kept.join(', ');
}

// ---------------------------------------------------------------------------
// 応答本文の解析
// ---------------------------------------------------------------------------

/**
 * 1応答ぶんの観測。数えられなかったときは `parse` に理由が入り、トークンは 0 になる。
 *
 * @typedef {object} UsageObservation
 * @property {'ok'|'unsupported-encoding'|'too-large'|'unparsable'|'no-usage'} parse
 * @property {string|null} encoding 正規化した content-encoding（無圧縮なら null）。
 * @property {string|null} model 応答の model id。
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheCreationTokens
 * @property {number} cacheCreation1hTokens
 * @property {number} cacheCreation5mTokens
 */

function emptyObservation(parse, encoding = null) {
  return {
    parse,
    encoding,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
    cacheCreation5mTokens: 0,
  };
}

/**
 * 応答本文（の写し）から usage を読む。**本文は書き換えない。**
 *
 * **この関数は例外を投げない。** 解凍・文字列化・解析のどこで失敗しても
 * `parse` に理由の入った観測を返す。呼び出し側（`src/proxy-server.js`）は
 * `await parseUsageObservation(...)` を try で囲んでおらず、ストリーム応答では
 * 既に `res.headersSent` が真なので、例外が漏れると転送中の応答が破壊される。
 *
 * @param {Buffer} body `Buffer.concat` 済みの応答本文。
 * @param {{contentEncoding?: unknown, maxBytes?: number}} options `maxBytes` は
 *   圧縮後の長さと**解凍後の長さの両方**に効く上限。
 * @returns {Promise<UsageObservation>}
 */
export async function parseUsageObservation(body, { contentEncoding = null, maxBytes = DEFAULT_OBSERVABILITY.requestLog.maxBodyBytes } = {}) {
  const encoding = normalizeEncoding(contentEncoding);
  if (!Buffer.isBuffer(body) || body.length === 0) return emptyObservation('no-usage', encoding);
  // 上限は二段で効かせる。①受け取ったバイト数（圧縮後）をここで弾く。
  // ②解凍後のバイト数は各デコーダへ渡す `maxOutputLength` で同じ値に抑える。
  // ②が無いと zlib の既定上限が buffer.kMaxLength（約 4 GiB）になり、
  // 小さな圧縮本文でメモリを食い尽くせてしまう（解凍爆弾）。
  if (body.length > maxBytes) return emptyObservation('too-large', encoding);

  let decoder = null;
  if (encoding !== null) {
    decoder = DECODERS.get(encoding);
    // 知らない符号化、または知っているが解けない符号化（Node に API が無い zstd）。
    if (decoder == null) return emptyObservation('unsupported-encoding', encoding);
  }

  // 解凍だけでなく `toString` と `readUsage` も同じ try の中に入れる。`toString` は
  // 解凍後が MAX_STRING_LENGTH を超えると投げるため、外に出すと上の欠陥が再発する。
  try {
    const raw = decoder === null ? body : await decoder(body, { maxOutputLength: maxBytes });
    return readUsage(raw.toString('utf8'), encoding);
  } catch (error) {
    return emptyObservation(isSizeError(error) ? 'too-large' : 'unparsable', encoding);
  }
}

function readUsage(text, encoding) {
  // ①非ストリーム: 本文全体が1つの JSON。
  const json = parseJson(text);
  if (json) {
    if (!json.usage || typeof json.usage !== 'object') return emptyObservation('no-usage', encoding);
    const observation = emptyObservation('ok', encoding);
    observation.model = readModel(json.model);
    applyUsage(observation, json.usage);
    return observation;
  }

  // ②SSE: `data: ` 行を拾って message_start / message_delta から読む。
  const observation = emptyObservation('ok', encoding);
  let sawData = false;
  let sawUsage = false;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const dataLine = event.split(/\r?\n/).find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    sawData = true;
    const data = parseJson(dataLine.slice(6));
    if (!data) continue;
    if (data.type === 'message_start' && data.message?.usage) {
      sawUsage = true;
      observation.model = readModel(data.message.model) ?? observation.model;
      applyUsage(observation, data.message.usage);
    } else if (data.type === 'message_delta' && data.usage) {
      sawUsage = true;
      applyUsage(observation, data.usage);
    }
  }
  if (sawUsage) return observation;
  return emptyObservation(sawData ? 'no-usage' : 'unparsable', encoding);
}

/**
 * usage を観測へ写す。
 *
 * どのキーも**大きい方**を採る。SSE では `message_start` と `message_delta` の両方に
 * 同じキーが載ることがあり（`message_start.usage.output_tokens` は途中経過、
 * `message_delta.usage.cache_*` は後から載る）、素直に代入すると後から来た小さい値で
 * 上書きしてしまう。非ストリームは1つの usage に全部載っているので、同じ規則で読める。
 */
function applyUsage(observation, usage) {
  observation.inputTokens = Math.max(observation.inputTokens, count(usage.input_tokens));
  observation.outputTokens = Math.max(observation.outputTokens, count(usage.output_tokens));
  observation.cacheReadTokens = Math.max(observation.cacheReadTokens, count(usage.cache_read_input_tokens));
  observation.cacheCreationTokens = Math.max(observation.cacheCreationTokens, count(usage.cache_creation_input_tokens));
  const breakdown = usage.cache_creation;
  if (breakdown && typeof breakdown === 'object') {
    observation.cacheCreation1hTokens = Math.max(
      observation.cacheCreation1hTokens,
      count(breakdown.ephemeral_1h_input_tokens),
    );
    observation.cacheCreation5mTokens = Math.max(
      observation.cacheCreation5mTokens,
      count(breakdown.ephemeral_5m_input_tokens),
    );
  }
}

// 負数・文字列・null は 0。上流が想定外の値を返しても集計を汚さない。
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function readModel(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ログ行への追記
// ---------------------------------------------------------------------------

/**
 * `proxy` 行の末尾へ足すフィールド（計画書 (b) の順序と語彙）。
 *
 * `observationLog` が `null` なら空文字列を返すので、観測が無効な構成では
 * 行が現行とバイト単位で同一になる（`degradeLogFields` と同じ規律）。
 *
 * `quota` の reset は**エポック秒**で渡すこと（`parseRateLimitHeaders` はミリ秒を返すので、
 * 呼び出し側で 1000 で割る）。
 *
 * @param {object|null} observationLog
 * @param {{sid?: string|null}|null} affinityLog sticky R-S7 の追記情報。
 *   **`sid` を持っているときだけ** こちらは `sid=` を譲る。`affinityLog` の有無で
 *   判定すると、鍵なし要求（`affinityLog` はあるが `sid` が無い）で `sid=-` が消え、
 *   セッション付与率が測れなくなる。
 * @returns {string} 先頭に空白を持つ追記文字列。
 */
export function observationLogFields(observationLog, affinityLog = null) {
  if (!observationLog) return '';
  const quota = observationLog.quota || {};
  const fields = [`model=${logToken(observationLog.model)}`];
  if (!affinityLog?.sid) fields.push(`sid=${observationLog.sid || '-'}`);
  fields.push(
    `in=${observationLog.inputTokens ?? 0}`,
    `out=${observationLog.outputTokens ?? 0}`,
    `cr=${observationLog.cacheReadTokens ?? 0}`,
    `cc=${observationLog.cacheCreationTokens ?? 0}`,
    `c1h=${observationLog.cacheCreation1hTokens ?? 0}`,
    `c5m=${observationLog.cacheCreation5mTokens ?? 0}`,
    `u5h=${numberOrDash(quota.unified5h)}`,
    `u5hReset=${numberOrDash(quota.unified5hReset)}`,
    `u7d=${numberOrDash(quota.unified7d)}`,
    `u7dReset=${numberOrDash(quota.unified7dReset)}`,
    `enc=${logToken(observationLog.encoding)}`,
  );
  if (observationLog.parse && observationLog.parse !== 'ok') {
    fields.push(`usageParse=${observationLog.parse}`);
  }
  return ` ${fields.join(' ')}`;
}

/**
 * 上流由来の文字列をログ行の1トークンとして安全に書ける形へ直す。
 *
 * `content-encoding` は `gzip, br` のように複数値になることがあり、`model` も上流が
 * 何を名乗るか保証が無い。空白が混ざると `key=value` を空白で区切って読む既存の
 * 解析（`awk` / `grep -o` の運用手順）が崩れるので、`[A-Za-z0-9._-]` 以外は `_` に置換する。
 */
function logToken(value) {
  if (typeof value !== 'string' || value === '') return '-';
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function numberOrDash(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}
