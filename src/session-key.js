// セッション鍵の抽出・正規化・指紋化。
//
// 出所: sticky（`feat/session-affinity` の `src/session-affinity.js:52-160`）から
// **純関数だけ**を意味を変えずに切り出したもの。sticky が後から同じ実装を持ち込むと
// 同じ行に桁数の違う `sid=` が2つ並ぶので、実装は1箇所に置く（計画書リスク R-4）。
// `test/session-key.test.js` は sticky の `test/session-affinity.test.js` と
// 同じ入力・同じ期待値にしてある。将来の統合で差が出ないようにするためである。
//
// **生のセッション id をログ・状態ファイル・エラーへ出さない。** 外へ出てよいのは
// `sidHash()` が返す sha256 の先頭 12 桁だけとする。

import { createHash } from 'node:crypto';

export const SESSION_ID_HEADER = 'x-claude-code-session-id';
export const MAX_SESSION_KEY_LENGTH = 128;

// 制御文字・改行・空白・カンマ結合された重複ヘッダを鍵にしない。
const SESSION_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * セッション鍵を正規化する。
 * 受理しない値は `null` を返すだけで、要求を拒否も記録もしない。
 *
 * @param {unknown} raw ヘッダまたは本文から取り出した値。
 * @returns {string|null} 正規化された鍵。使えなければ `null`。
 */
export function normalizeSessionKey(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SESSION_KEY_LENGTH) return null;
  return SESSION_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * ログに使う 48bit の指紋。
 * 正規化してから数えるので、前後に空白の付いた同じセッションは同じ値になる。
 *
 * @param {unknown} key セッション鍵（正規化前でよい）。
 * @returns {string|null} 16進12桁。鍵として使えない値なら `null`。
 */
export function sidHash(key) {
  const normalized = normalizeSessionKey(key);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * 要求からセッション鍵を取り出す。
 * ①ヘッダ `x-claude-code-session-id` ②本文 `metadata.user_id`（JSON 文字列）の `session_id`
 * ③どちらも使えなければ `null`。
 *
 * `x-claude-code-agent-id` は鍵に混ぜない——混ぜるとサブエージェントだけ別口座へ飛び、
 * 親子ともキャッシュを失う。
 *
 * @param {{headers?:object, rawHeaders?:string[]}|null} req 受信要求。
 * @param {Buffer|string|object|null} body 本文。`null` を渡せば本文を読まない
 *   （`observability.requestLog.sessionFromBody` が false のときの既定経路。
 *   要求本文は数百 KB〜数 MB あり、`JSON.parse` の追加1回が要求ごとの実コストになる）。
 * @returns {string|null} 正規化済みのセッション鍵。
 */
export function sessionKeyFrom(req, body) {
  const fromHeader = normalizeSessionKey(sessionHeaderValue(req));
  if (fromHeader) return fromHeader;
  return normalizeSessionKey(sessionIdFromBody(body));
}

// 同名ヘッダが複数あれば鍵にしない。Node の http はそれをカンマで結合するので、
// 結合後の値も上の文字集合で弾かれる（二重の防御）。
function sessionHeaderValue(req) {
  const raw = req?.rawHeaders;
  if (Array.isArray(raw)) {
    let found = null;
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index];
      if (typeof name !== 'string' || name.toLowerCase() !== SESSION_ID_HEADER) continue;
      if (found !== null) return null;
      found = raw[index + 1];
    }
    if (found !== null) return found;
  }
  const value = req?.headers?.[SESSION_ID_HEADER];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === 'string' ? value : null;
}

function sessionIdFromBody(body) {
  const userId = parseBody(body)?.metadata?.user_id;
  // `user_id` は JSON を文字列にしたもの。構造体で来た場合も読む。
  const parsed = typeof userId === 'string' ? parseJson(userId) : userId;
  const sessionId = parsed && typeof parsed === 'object' ? parsed.session_id : null;
  return typeof sessionId === 'string' ? sessionId : null;
}

function parseBody(body) {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body)) return parseJson(body.toString('utf8'));
  if (typeof body === 'string') return parseJson(body);
  return typeof body === 'object' ? body : null;
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
