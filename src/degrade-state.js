// 縮退写像の純関数群（設計書 §11.1 R3-1）。
// HTTP も fs も触らない。時刻は必ず呼び出し側から注入する（決定的にテストできる形にする）。
// 出典: 設計書 §4.2 / §6.5 / §8.6 / §8.7 / §9.3、契約 v1.3 §C3・§C10。

// 設計書 §6.6 規律1: この形に合致しない値はログへ落とさない（メールアドレス混入の遮断）。
const ACCOUNT_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const INVALID_ACCOUNT_LABEL = '<invalid>';
// 契約 §C3.2 の値域。Number()/Date.parse() の緩さ（16進・指数表記・存在しない日付の繰り上げ）に頼らない。
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;
const DECIMAL_CONTRACT_PATTERN = /^\d{1,9}$/;
const DECIMAL_STATUS_PATTERN = /^\d{3}$/;
// 「0〜100 の10進数（小数第1位まで）」。小数2桁以上・指数表記・符号付きは受理しない。
const USED_PERCENT_PATTERN = /^\d{1,3}(?:\.\d)?$/;

// 契約 §C3.4 の列挙。これ以外の値は原文を保持せず 'unknown' へ正規化する（識別子の混入を遮断する）。
const DEGRADE_REASONS = new Set([
  'codex_pool_exhausted', 'codex_account_exhausted', 'codex_attempt_limit',
  'codex_needs_login', 'codex_pool_mixed', 'codex_no_account_for_model',
  'codex_upstream_overloaded', 'codex_upstream_error', 'codex_upstream_unreachable',
  'codex_upstream_timeout', 'bridge_internal_error', 'request_invalid', 'request_too_large',
  // 契約 v1.5 で追加。rotator の扱いは codex_needs_login と完全に同じにする
  // （403 を素通しし、(pool) は失効として学習する）。
  'codex_credentials_unavailable',
]);
const UNKNOWN_DEGRADE_REASON = 'unknown';

const POOL_STATES = new Set([
  'ok', 'degraded', 'exhausted', 'needs-login', 'mixed', 'no-account-for-model',
  // 契約 v1.5。needs-login と同じ扱い（利用不可として学習するが 403 書換の根拠にはしない）。
  'credentials-unavailable',
]);
const DEGRADE_SCOPES = new Set(['pool', 'model', 'account']);
const UNUSABLE_POOL_STATES = new Set(['exhausted', 'needs-login', 'mixed', 'credentials-unavailable']);
const AVAILABLE_POOL_STATES = new Set(['ok', 'degraded']);
// 403 への書換を許すのは「いま返そうとしている応答」がこの2状態のときだけ（設計書 §8.7 条件①）。
const MAPPABLE_POOL_STATES = new Set(['exhausted', 'mixed']);

// 契約 §C3.4「既定の scope」。導けない reason は model 扱い（= (pool) を汚さない安全側）。
const REASON_DEFAULT_SCOPE = new Map([
  ['codex_pool_exhausted', 'pool'],
  ['codex_account_exhausted', 'account'],
  ['codex_attempt_limit', 'pool'],
  ['codex_needs_login', 'pool'],
  ['codex_credentials_unavailable', 'pool'],
  ['codex_pool_mixed', 'pool'],
  ['codex_no_account_for_model', 'model'],
  ['codex_upstream_overloaded', 'pool'],
  ['codex_upstream_error', 'pool'],
  ['codex_upstream_unreachable', 'pool'],
  ['codex_upstream_timeout', 'pool'],
  ['request_invalid', 'model'],
  ['request_too_large', 'model'],
]);

/** 契約 §C10.3 T7 の既定（bridge 側の枯渇キャッシュ既定 60,000ms と揃える）。 */
export const DEFAULT_GPT_POOL_UNUSABLE_TTL_MS = 60000;

function headerValue(headers, name) {
  const value = headers?.[name];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === 'string' && single.length > 0 ? single.trim() : null;
}

function enumValue(value, allowed) {
  return value !== null && allowed.has(value) ? value : null;
}

/**
 * x-ombr-account を検証する（設計書 §6.6 規律1）。
 * @returns {string|null} 合致すればその値、合致しなければ '<invalid>'、ヘッダが無ければ null。
 */
export function sanitizeAccountLabel(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return ACCOUNT_LABEL_PATTERN.test(value) ? value : INVALID_ACCOUNT_LABEL;
}

/**
 * RFC3339（UTC）として厳密に検証する（契約 §C3.2）。
 * Date.parse() は存在しない日付を繰り上げて受理する（'2028-02-30T00:00:00Z' → 3/1）ため、
 * 年月日が実在することを成分の突合で確かめる。不正なら null（＝resetAt 無しの unusable として TTL で解ける）。
 */
function validResetAt(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  return real ? value : null;
}

function usedPercent(value) {
  if (value === null || !USED_PERCENT_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 100 ? parsed : null;
}

function upstreamStatusValue(value) {
  if (value === null) return null;
  if (value === 'none') return 'none';
  if (!DECIMAL_STATUS_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 100 && parsed <= 599 ? parsed : null;
}

/** 契約の版。正の整数の10進表記だけを受理する（'0x10' や '1e3' を弾く）。 */
function contractValue(value) {
  if (value === null || !DECIMAL_CONTRACT_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

/**
 * 契約 §C3.4 の列挙値だけを受理する。列挙外は 'unknown' へ正規化し、原文は保持しない。
 * bridge 側の不具合でメールアドレス等が混入しても、状態にもログにも残らないようにするため。
 */
function degradeReasonValue(value) {
  if (value === null) return null;
  return DEGRADE_REASONS.has(value) ? value : UNKNOWN_DEGRADE_REASON;
}

/**
 * bridge の応答ヘッダ x-ombr-* を解析する。値域外・未知の値はすべて「不明」（null）へ倒す。
 * rawScope（ヘッダの値そのもの）と effectiveScope（reason から導いた既定を含む）を分けて返す
 * 理由は設計書 §6.5: 学習には effectiveScope、403 書換には rawScope しか使わない。
 */
export function parseBridgeContract(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const present = Object.keys(source).some(key => key.toLowerCase().startsWith('x-ombr-'));
  const reason = degradeReasonValue(headerValue(source, 'x-ombr-degrade-reason'));
  const rawScope = enumValue(headerValue(source, 'x-ombr-degrade-scope'), DEGRADE_SCOPES);
  return {
    present,
    contract: contractValue(headerValue(source, 'x-ombr-contract')),
    reason,
    rawScope,
    effectiveScope: rawScope || REASON_DEFAULT_SCOPE.get(reason) || 'model',
    poolState: enumValue(headerValue(source, 'x-ombr-pool-state'), POOL_STATES),
    upstreamStatus: upstreamStatusValue(headerValue(source, 'x-ombr-upstream-status')),
    upstreamSent: enumValue(headerValue(source, 'x-ombr-upstream-sent'), new Set(['yes', 'no'])),
    cached: enumValue(headerValue(source, 'x-ombr-cached'), new Set(['yes', 'no'])),
    accountLabel: sanitizeAccountLabel(headerValue(source, 'x-ombr-account')),
    resetAt: validResetAt(headerValue(source, 'x-ombr-reset-at')),
    primaryUsedPercent: usedPercent(headerValue(source, 'x-ombr-primary-used-percent')),
    secondaryUsedPercent: usedPercent(headerValue(source, 'x-ombr-secondary-used-percent')),
  };
}

function unknownEntry() {
  return { state: 'unknown', reason: null, resetAt: null, learnedAt: null };
}

function entryView(entry) {
  return { state: entry.state, reason: entry.reason, resetAt: entry.resetAt, learnedAt: entry.learnedAt };
}

/**
 * GPT プールの可否を保持する（契約 §C10.2・§C10.3）。メモリのみ・プロセス再起動で消えてよい。
 * @param {{ now?: () => number, unusableTtlMs?: number }} options 時刻は注入する（副作用を持たない）。
 */
export function createGptPoolState({ now = () => Date.now(), unusableTtlMs = DEFAULT_GPT_POOL_UNUSABLE_TTL_MS } = {}) {
  const pool = unknownEntry();
  const models = new Map();

  const modelKey = model => (typeof model === 'string' && model.length > 0 ? model : null);

  // 学習（observe）だけがモデル鍵を作る。read() から作ると、bridge へ投げたモデル名の
  // 分だけ Map が単調に増え、snapshot() にも一度も観測していないモデルが並ぶ。
  const modelEntry = model => {
    const key = modelKey(model);
    if (key === null) return null;
    if (!models.has(key)) models.set(key, unknownEntry());
    return models.get(key);
  };

  // 参照専用（鍵を作らない）。未観測なら null を返し、呼び出し側が unknown を組み立てる。
  const lookupModelEntry = model => {
    const key = modelKey(model);
    return key === null ? null : models.get(key) || null;
  };

  // T6（resetAt 到来）と T7（resetAt を持たない unusable が TTL 経過）だけが時間による解除。
  const expire = entry => {
    if (!entry || entry.state !== 'unusable') return entry;
    const nowMs = now();
    const expired = entry.resetAt
      ? Date.parse(entry.resetAt) <= nowMs
      : entry.learnedAt !== null && nowMs - entry.learnedAt >= unusableTtlMs;
    if (expired) Object.assign(entry, unknownEntry());
    return entry;
  };

  const set = (entry, state, reason, resetAt) => {
    if (!entry) return;
    entry.state = state;
    entry.reason = reason;
    entry.resetAt = resetAt;
    entry.learnedAt = now();
  };

  const result = transition => ({ transition, pool: entryView(pool), model: null });

  return {
    /**
     * 1つの応答から学習する（契約 §C10.3 T1〜T10）。
     * @param {ReturnType<typeof parseBridgeContract>|null} parsed 解析済みヘッダ。
     * @param {number|null} statusCode bridge が返した HTTP ステータス（不達なら null）。
     * @param {string|null} model 要求されたモデル名（(pool, model) 鍵。不明なら model 側は学習しない）。
     */
    observe(parsed, statusCode, model = null) {
      // 時間による解除（T6・T7）は観測の内容によらず反映する。学習はここから先だけで行う。
      expire(pool);
      // 契約 §C3.7-1: x-ombr-contract の無い応答は「契約前の bridge」であり、
      // ステータスと本文だけで判断する現行挙動と同一にする（学習しない・モデル鍵も作らない）。
      if (!parsed || parsed.contract === null) return result(null);
      const forModel = modelEntry(model);
      expire(forModel);
      // T8（不達）・T9（pool-state を持たない応答。HTTP 200 を含む）はどちらの鍵も変えない。
      if (!parsed.poolState) return result(null);
      // 学習の入力になるのは HTTP 200（T2）と 4xx/5xx のエラー応答（T3〜T5・T10）だけ。
      // 200 以外の 2xx・3xx・不達（null）・整数でない値からは何も学ばない（契約 §C10.3）。
      const status = Number.isInteger(statusCode) ? statusCode : null;
      if (status !== 200 && (status === null || status < 400 || status > 599)) return result(null);

      if (status === 200) {
        // T2: available へ動かせるのは成功応答だけ。
        if (!AVAILABLE_POOL_STATES.has(parsed.poolState)) return result(null);
        set(pool, 'available', null, null);
        set(forModel, 'available', null, null);
        return result('T2');
      }
      // T5: codex_attempt_limit は状態を変えず、既存の unusable を延命もしない。
      if (parsed.poolState === 'degraded') return result('T5');
      // T10: 1口座だけの事情はプールの可否を意味しない。
      if (parsed.effectiveScope === 'account') return result('T10');
      // T3: プール全体に及ぶ事象。reason と resetAt を保持する。
      if (parsed.effectiveScope === 'pool' && UNUSABLE_POOL_STATES.has(parsed.poolState)) {
        set(pool, 'unusable', parsed.reason, parsed.resetAt);
        return result('T3');
      }
      // T4: そのモデルに限った事象。(pool) には一切触れない。
      if (parsed.effectiveScope === 'model' && parsed.poolState === 'no-account-for-model') {
        set(forModel, 'unusable', parsed.reason, parsed.resetAt);
        return result('T4');
      }
      return result(null);
    },

    /** 期限切れを反映した現在値を返す。未観測のモデルは unknown を返すだけで、鍵は作らない。 */
    read(model = null) {
      expire(pool);
      const forModel = expire(lookupModelEntry(model));
      return { pool: entryView(pool), model: entryView(forModel || unknownEntry()) };
    },

    /** 表示・ログ用の全体像（内部参照は返さない）。 */
    snapshot() {
      expire(pool);
      const all = {};
      for (const [model, entry] of models) all[model] = entryView(expire(entry));
      return { pool: entryView(pool), models: all };
    },
  };
}

/**
 * Claude 側の台帳で「利用可能な口座が1つも無い」かを判定する（設計書 §4.2）。
 * 判定根拠は isAvailable() であって getRoutingAvailability().state ではない。
 * 口座0件（インストール直後）は false を返し、写像そのものを起こさない。
 */
export function claudeAllUnusable(accountManager, modelFamily = null) {
  const accounts = accountManager?.accounts || [];
  if (typeof accountManager?.isAvailable !== 'function' || accounts.length === 0) return false;
  return !accounts.some(account => accountManager.isAvailable(account, modelFamily));
}

function earliestResetAt(values) {
  const valid = (values || []).filter(value => validResetAt(typeof value === 'string' ? value : null));
  if (valid.length === 0) return null;
  return valid.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest));
}

/**
 * Claude 側の台帳から「最も早い回復見込み時刻」を取り出す（設計書 §8.7 の本文生成）。
 * **全枯渇かどうかの判定には使わない**——判定は claudeAllUnusable（isAvailable）が正本であり
 * （§4.2）、ここで getRoutingAvailability を使うのは表示用の availableAt を読むためだけである。
 * 取得できなければ null を返し、本文は GPT 側の reset-at だけで組み立てられる。
 * @returns {string|null} RFC3339（UTC）。
 */
export function claudeEarliestResetAt(accountManager, modelFamily = null) {
  if (typeof accountManager?.getRoutingAvailability !== 'function') return null;
  const entries = accountManager.getRoutingAvailability(modelFamily) || [];
  return earliestResetAt(entries.map(entry => entry?.availableAt));
}

/**
 * 403 / 529 の応答本文を作る（設計書 §8.7）。両プールが使えないときは最も早い回復見込みを添える。
 * @returns {string} JSON 文字列。
 */
export function buildDegradeBody(status, { resetAts = [] } = {}) {
  const permission = status === 403;
  const earliest = earliestResetAt(resetAts);
  const head = permission
    ? 'All Claude accounts and the Codex pool are unavailable.'
    : 'All Claude accounts are exhausted.';
  return JSON.stringify({
    type: 'error',
    error: {
      type: permission ? 'permission_error' : 'overloaded_error',
      message: earliest ? `${head} Earliest recovery: ${earliest}.` : head,
    },
  });
}

function bodyErrorType(body) {
  try {
    const parsed = JSON.parse(Buffer.from(body || '').toString('utf8'));
    const type = parsed?.error?.type;
    return typeof type === 'string' ? type : undefined;
  } catch {
    return undefined;
  }
}

function withoutBodyHeaders(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'content-encoding' || lower === 'content-type') continue;
    next[key] = value;
  }
  return next;
}

/**
 * Claude 全枯渇の写像（設計書 §8.6・§8.7、契約 §C10.4）。7系統の終端経路すべてがこの関数を通る。
 *
 * ctx は「枯渇」を2つの粒度で受け取る:
 *   - claudeAllUnusable       … **要求モデル系列**で全口座が使えないか（529 への写像の可否）
 *   - commonFamilyAllUnusable … **共通枠**（系列を問わない）で全口座が使えないか（403 への昇格の可否。
 *                               未指定は false 扱い＝403 へ昇格しない）
 * 両者が分かれているのは、Fable 週次サブキャップだけが全口座で切れている状態を
 * 「Claude がもう使えない」と誤認しないためである（§4.2）。その状態では Opus へ
 * 退避できるので 529 に留め、403（恒久拒否）へは昇格させない。
 *
 * @param {{statusCode:number, headers:object, body:Buffer}|null} candidate これから返そうとしている応答。
 * @param {{enabled?:boolean, claudeAllUnusable?:boolean, commonFamilyAllUnusable?:boolean,
 *          gptPoolState?:string, mapPath?:string, bothUnusableStatus?:number, headersSent?:boolean,
 *          gptResetAt?:string|null, claudeResetAt?:string|null}} ctx
 * @returns {object|null} 写像しない場合も degradeLog（痕跡）を添えて返す。enabled が偽なら入力をそのまま返す。
 */
export function mapClaudeExhaustion(candidate, ctx = {}) {
  if (!candidate || ctx.enabled !== true) return candidate;
  const gptPoolState = ctx.gptPoolState || 'unknown';
  const degradeLog = {
    gptPoolState,
    claudePoolState: ctx.claudeAllUnusable === true ? 'all-exhausted' : 'available',
    mapPath: ctx.mapPath || undefined,
  };
  const from = Number(candidate.statusCode);
  // 写像するのは「台帳が全枯渇」かつ「429」かつ「まだヘッダを送出していない」ときだけ。
  if (ctx.claudeAllUnusable !== true || from !== 429 || ctx.headersSent === true) {
    return { ...candidate, degradeLog };
  }

  // 403 へ昇格してよいのは「GPT プールが使えない」かつ「**共通枠まで**全口座が
  // 使えない」ときだけ。commonFamilyAllUnusable を渡さない呼び出しには系列を区別
  // する情報が無く、判断がつかないときは 529（＝まだ退避できる側）へ倒す既存規律に
  // 従うので、未指定は false（＝403 へ昇格しない）として扱う。本番の呼び出し元は
  // 常に明示的に渡す（src/proxy-server.js）。
  const commonUnusable = ctx.commonFamilyAllUnusable === true;
  const bothUnusable = gptPoolState === 'unusable' && commonUnusable;
  const status = bothUnusable && ctx.bothUnusableStatus !== 529 ? 403 : 529;
  const resetAts = bothUnusable ? [ctx.gptResetAt, ctx.claudeResetAt] : [];
  const body = Buffer.from(buildDegradeBody(status, { resetAts }));
  const headers = withoutBodyHeaders(candidate.headers);
  headers['content-type'] = 'application/json';
  headers['content-length'] = String(body.length);
  return {
    ...candidate,
    statusCode: status,
    headers,
    body,
    degradeLog: {
      ...degradeLog,
      // R4-5: 403 で止めた行から「いつ回復するか」を本文を開かずに読めるようにする
      // （設計書 §9.3 の resetAt）。両プール利用可能な 529 では回復時刻を持たない。
      resetAt: earliestResetAt(resetAts) || undefined,
      mappedFrom: from,
      mappedFromType: bodyErrorType(candidate.body),
      mappedTo: status,
      mapReason: bothUnusable ? 'both_pools_unusable' : 'all_claude_accounts_exhausted',
    },
  };
}

/**
 * gpt-* 経路で bridge の 529 を 403 へ書き換えるかを決める（設計書 §8.7 の4条件）。
 * 4条件は ①現在の応答が 529 かつ pool-state が exhausted/mixed ②Claude 全枯渇
 * ③学習した (pool) が unusable ④rawScope === 'pool'（明示）。1つでも欠ければ 529 のまま素通しする。
 */
export function decideBridgeResponse(parsed, ctx = {}) {
  if (ctx.enabled !== true) return { rewrite: false, reason: 'disabled' };
  if (ctx.bothUnusableStatus !== undefined && ctx.bothUnusableStatus !== 403) {
    return { rewrite: false, reason: 'both-unusable-status-is-not-403' };
  }
  // 契約 §C3.7-1・§C10 の後方互換原則: x-ombr-contract を持たない（または値が不正な）
  // 応答は「契約前の bridge」であり、現行とまったく同じ意味に扱う＝一切書き換えない。
  // これが無いと、過去に学習した (pool)=unusable が TTL 内に残っているあいだ、
  // 契約ヘッダを持たない 529 まで 403 へ書き換えてしまう（再検証 FAIL ①）。
  if (!parsed || parsed.contract === null) return { rewrite: false, reason: 'no-contract-header' };
  if (Number(ctx.upstreamStatus) !== 529) return { rewrite: false, reason: 'status-not-529' };
  if (!MAPPABLE_POOL_STATES.has(parsed?.poolState)) {
    return { rewrite: false, reason: 'pool-state-not-exhausted-or-mixed' };
  }
  if (parsed?.rawScope !== 'pool') return { rewrite: false, reason: 'scope-not-explicit-pool' };
  if (ctx.claudeAllUnusable !== true) return { rewrite: false, reason: 'claude-not-exhausted' };
  if (ctx.gptPoolState !== 'unusable') return { rewrite: false, reason: 'gpt-pool-not-unusable' };
  return {
    rewrite: true,
    status: 403,
    body: buildDegradeBody(403, { resetAts: [ctx.gptResetAt, parsed.resetAt, ctx.claudeResetAt] }),
    meta: {
      gptPoolState: 'unusable',
      claudePoolState: 'all-exhausted',
      mappedFrom: 529,
      mappedFromType: 'overloaded_error',
      mappedTo: 403,
      mapReason: 'both_pools_unusable',
    },
  };
}

// ログ行は空白区切りの key=value なので、値に空白・改行を残さない（契約 §C3.1）。
function logToken(value) {
  return String(value).replace(/\s+/g, '_').slice(0, 64);
}

/**
 * ログへ追記するフィールドを作る（設計書 §9.3）。値があるキーだけを、表の順序で載せる。
 * 何も無ければ空オブジェクトを返し、ログ行は現行とバイト単位で同一になる。
 */
export function buildBridgeLogMeta(parsed, extra = {}) {
  const meta = {};
  const put = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    meta[key] = logToken(value);
  };
  put('bridgeContract', parsed?.contract);
  put('degradeReason', parsed?.reason);
  put('poolState', parsed?.poolState);
  put('degradeScope', parsed?.rawScope);
  put('upstreamStatus', parsed?.upstreamStatus);
  put('upstreamSent', parsed?.upstreamSent);
  put('bridgeCached', parsed?.cached);
  put('accountLabel', parsed?.accountLabel);
  put('resetAt', parsed?.resetAt);
  put('primaryUsedPercent', parsed?.primaryUsedPercent);
  put('secondaryUsedPercent', parsed?.secondaryUsedPercent);
  for (const key of [
    'gptPoolState', 'gptModelState', 'claudePoolState',
    'mappedFrom', 'mappedFromType', 'mappedTo', 'mapReason', 'mapPath',
  ]) put(key, extra?.[key]);
  return meta;
}

/** buildBridgeLogMeta() の結果をログ行の末尾へ足す形（先頭に空白1つ）にする。空なら空文字列。 */
export function formatLogMeta(meta) {
  const entries = Object.entries(meta || {});
  return entries.length === 0 ? '' : ` ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}
