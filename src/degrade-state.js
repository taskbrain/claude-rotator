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
  // 契約 v1.6.3 で追加。非 SSE 集約が総時間上限に達したときの 529（scope=model・pool-state 無し）。
  // 列挙に載せるのは理由名をログへ残すためだけで、挙動は変えない（pool-state が無いので
  // §C10.3 の学習には入らず、§8.7 条件①も満たさないため 403 への書換も起きない）。
  'codex_aggregation_timeout',
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
 *
 * recoveryWaitEnabled は層1（T2b・T6b・キャッシュ非学習）の適用範囲を決める
 * （統合設計 v2.1 §2.1 案A）。**既定は false で、そのとき学習・失効は現行と1分岐も変わらない。**
 * 層1 は 403 書換の条件③（gptPoolState !== 'unusable'）を通じて応答バイトを変えうるので、
 * 「フラグ off ＝現行とバイト互換」を保つには層1 も同じフラグの配下に置くしかない。
 *
 * @param {{ now?: () => number, unusableTtlMs?: number, recoveryWaitEnabled?: boolean }} options
 *   時刻は注入する（副作用を持たない）。
 */
export function createGptPoolState({
  now = () => Date.now(),
  unusableTtlMs = DEFAULT_GPT_POOL_UNUSABLE_TTL_MS,
  recoveryWaitEnabled = false,
} = {}) {
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
  //
  // T6b（recoveryWaitEnabled のときだけ・統合設計 v2.1 §2）: resetAt を持つ unusable にも
  // 「学習から unusableTtlMs」の期限を重ね、min(resetAt, learnedAt + unusableTtlMs) で解く。
  // 現行は TTL が三項演算子の else 側（resetAt を持たない側）にしか効かないため、bridge が
  // 返す週次の resetAt（5 日先）を学習すると自力では戻れない。2026-09-14〜15 の本番ログでは
  // unusable から自力で戻った行が 0 件で、解けたのは再起動と reload の直後だけだった。
  // **新しい設定キーは作らない**（既存 gptPoolUnusableTtlMs を使う）。
  // resetAt の原値は診断値として残し、改ざんしない（待機期限と枠の回復予測は別物）。
  const ttlDeadlineOf = entry => (
    typeof entry.learnedAt === 'number' ? entry.learnedAt + unusableTtlMs : null
  );
  const expire = entry => {
    if (!entry || entry.state !== 'unusable') return entry;
    const nowMs = now();
    const ttlAt = ttlDeadlineOf(entry);
    let expired;
    if (entry.resetAt) {
      const resetAtMs = Date.parse(entry.resetAt);
      // 解析できない resetAt（NaN）を Math.min へ渡すと結果も NaN になり、比較が常に
      // 偽＝T6b の上限が効かず永久固着する。その場合は TTL だけを期限として使う。
      const deadline = Number.isFinite(resetAtMs) ? Math.min(resetAtMs, ttlAt) : ttlAt;
      expired = recoveryWaitEnabled && ttlAt !== null
        ? deadline <= nowMs
        : resetAtMs <= nowMs;
    } else {
      expired = ttlAt !== null && ttlAt <= nowMs;
    }
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
      if (!parsed.poolState) {
        // T2b（契約 v1.6.10 条文案 送付版 §A A-7・recoveryWaitEnabled のときだけ）。
        // 6条件をすべて満たす応答だけが「古い否定判定の反証」になる:
        //   (1) bridge からの生の HTTP 200      … statusCode === 200
        //   (2) x-ombr-upstream-status: 200     … 上流まで通った証拠
        //   (3) x-ombr-upstream-sent: yes       … ローカル成功・キャッシュ命中を除く
        //   (4) x-ombr-cached が yes でない     … 過去の判定を今の応答と誤認しない
        //   (5) 契約ヘッダ（x-ombr-contract）がある … この行に来た時点で確定済み
        //   (6) x-ombr-pool-state が無い        … この分岐に入っていることが条件そのもの
        // 解除先は unknown であり **available へは格上げしない**（1要求が通ったことは
        // プール全体の可用性を意味しない）。unusable 以外の鍵には何もしない。
        if (
          recoveryWaitEnabled
          && statusCode === 200
          && parsed.upstreamStatus === 200
          && parsed.upstreamSent === 'yes'
          && parsed.cached !== 'yes'
        ) {
          const cleared = [pool, forModel].filter(entry => entry?.state === 'unusable');
          for (const entry of cleared) Object.assign(entry, unknownEntry());
          if (cleared.length > 0) return result('T2b');
        }
        return result(null);
      }
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
      // 層1（recoveryWaitEnabled のときだけ・統合設計 v2.1 §2 / 03 §3.3）: キャッシュ由来の
      // 否定応答は、新規の unusable 学習にも既存 unusable の learnedAt 更新にも使わない。
      // bridge の枯渇キャッシュは公開 resetAt に上限を外しているため、古いキャッシュが
      // rotator の unusable を TTL ごとに再生産しうる。学習を新鮮な証拠に限れば、TTL が
      // 「最後の新鮮な否定から 60 秒」を真に保証する。
      // **いまの要求をどう扱うか（層2 の 429 待機）にはキャッシュ由来の拒否を使ってよい。**
      if (recoveryWaitEnabled && parsed.cached === 'yes') return result(null);
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

/** 待機指示に使う Retry-After（固定 30・10 進整数秒）。ノブもジッターも作らない（03 §4.3）。 */
export const RECOVERY_WAIT_RETRY_AFTER_SECONDS = 30;

/** Claude 側の空きの三値（統合設計 v2.1 §3.5）。 */
export const CLAUDE_QUOTA_STATES = Object.freeze(['available', 'none', 'indeterminate']);

/**
 * Claude 側の台帳の空きを**三値**で返す（統合設計 v2.1 §3.5）。
 *
 * claudeAllUnusable() は「判定関数が無い」「口座0件」「判定中の例外」をすべて false
 * （＝空きあり）へ丸めるため、実際には死んでいる Claude へ退避して最終段の無音バックオフ
 * （M-6）に落ちる経路が残る。待機（429）の可否を決めるには「空きが無い」と「判定できない」
 * を区別する必要があるので、判定不能を indeterminate として保持し、**available へは丸めない**。
 *
 * **既存の claudeAllUnusable() は 1 文字も変えない**（フラグ off の経路を動かさないため）。
 *
 * @param {{accounts?: Array, isAvailable?: Function}} accountManager 口座台帳。
 * @param {string|null} modelFamily 系列。共通枠で問うときは null（契約の条件2 と同じ引数）。
 * @returns {'available'|'none'|'indeterminate'}
 */
export function claudeQuotaState(accountManager, modelFamily = null) {
  if (typeof accountManager?.isAvailable !== 'function') return 'indeterminate';
  const accounts = accountManager?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return 'indeterminate';
  try {
    return accounts.some(account => accountManager.isAvailable(account, modelFamily))
      ? 'available'
      : 'none';
  } catch {
    // 台帳の判定で投げられた例外を「空きあり」へ倒さない（倒すと死んだ Claude へ退避する）。
    return 'indeterminate';
  }
}

/** 待機（429）へ倒してよい三値か。判定不能は待機側（統合設計 v2.1 §3.5 の表）。 */
export function quotaWaits(quotaState) {
  return quotaState === 'none' || quotaState === 'indeterminate';
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
  // 旧実装は `const permission = status === 403` という**二値**で error.type と本文を同時に
  // 切り替えていた。そこへ 429 を渡すと overloaded_error ＋「All Claude accounts are
  // exhausted.」が黙って付き、Claude Code の 529 系 3 連続 fallback 判定へ流れうる
  // （統合設計 v2.1 §3.3）。ステータスと本文の型を矛盾させないため 3 状態で分岐する。
  const numeric = Number(status);
  // 403（明示停止）と 429（待機指示）はどちらも「Claude も Codex も使えない」局面なので
  // 同じ文にする。529 は Claude 側だけが枯れている（GPT へ退避できる）局面である。
  const bothPools = numeric === 403 || numeric === 429;
  const earliest = earliestResetAt(resetAts);
  const head = bothPools
    ? 'All Claude accounts and the Codex pool are unavailable.'
    : 'All Claude accounts are exhausted.';
  const errorType = numeric === 403
    ? 'permission_error'
    : numeric === 429 ? 'rate_limit_error' : 'overloaded_error';
  // 429 は「自動で再試行される」ことを利用者へ伝える（画面にエラーは出るが停止はしない）。
  const retrying = numeric === 429 ? ' Retrying automatically.' : '';
  const body = `${head}${retrying}`;
  return JSON.stringify({
    type: 'error',
    error: {
      type: errorType,
      message: earliest ? `${body} Earliest recovery: ${earliest}.` : body,
    },
  });
}

// 一時障害（bridge の不達・上流タイムアウト）で返す本文（03 §4.3）。
// 「exhausted」と書かない・reset を出さない——恒久的な枯渇ではないため。
const TRANSIENT_WAIT_MESSAGE =
  'The Codex bridge is temporarily unreachable and no Claude account is available. Retrying automatically.';
const TRANSIENT_FALLBACK_MESSAGE =
  'The Codex bridge is temporarily unreachable. Retrying automatically.';

/**
 * 一時障害で返す本文を作る（03 §4.3）。429（待機）と 529（退避）で文と型を分ける。
 * @param {number} status 429 または 529。
 * @returns {string} JSON 文字列。
 */
export function buildTransientDegradeBody(status) {
  const waiting = Number(status) === 429;
  return JSON.stringify({
    type: 'error',
    error: {
      type: waiting ? 'rate_limit_error' : 'overloaded_error',
      message: waiting ? TRANSIENT_WAIT_MESSAGE : TRANSIENT_FALLBACK_MESSAGE,
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

// 合成した待機応答に残してはならないヘッダ（03 §4.3・統合設計 v2.1 §3.3）。
// 再試行監視が有効な Claude Code は 429／529 の待機時間に anthropic-ratelimit-unified-reset
// を**最優先**し、Retry-After もバックオフも参照しない。5 日先の reset が残ると最大 6 時間
// 無音で眠るため、除去は整形ではなく必須要件である。大小文字を問わずすべて落とす。
export function withoutRateLimitHeaders(headers) {
  const next = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === 'retry-after' || lower.startsWith('anthropic-ratelimit-')) continue;
    next[key] = value;
  }
  return next;
}

/**
 * 待機（429）のヘッダを作る。元の Retry-After と anthropic-ratelimit-* をすべて落としてから、
 * 10 進整数秒の Retry-After を1つだけ付ける（03 §4.3）。
 * @param {object} headers 元のヘッダ。
 * @param {number} seconds 秒（既定 30）。
 */
export function applyRecoveryWaitHeaders(headers, seconds = RECOVERY_WAIT_RETRY_AFTER_SECONDS) {
  const next = withoutRateLimitHeaders(headers);
  next['Retry-After'] = String(Math.trunc(seconds));
  return next;
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
 * recoveryWaitEnabled が真のときだけ、両プール全滅の帰結を 403（明示停止）から
 * **429 rate_limit_error ＋ Retry-After: 30**（待機）へ変える（統合設計 v2.1 §3.2 の 1〜3 行目）。
 * このとき Claude 側の空きは三値（commonFamilyQuotaState）で受け取り、**判定不能は待機側**
 * へ倒す。**bothUnusableStatus の値域（403／529）と既定 403 は変えない**——429 は設定値では
 * なくこの経路がコードで返す（フラグ有効時は本経路が bothUnusableStatus より優先する）。
 *
 * @param {{statusCode:number, headers:object, body:Buffer}|null} candidate これから返そうとしている応答。
 * @param {{enabled?:boolean, claudeAllUnusable?:boolean, commonFamilyAllUnusable?:boolean,
 *          commonFamilyQuotaState?:string, recoveryWaitEnabled?:boolean,
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
  const gptUnusable = gptPoolState === 'unusable';
  const bothUnusable = gptUnusable && commonUnusable;
  // 層2（recoveryWaitEnabled のときだけ）: 共通枠が none／indeterminate で GPT も unusable
  // なら、403（即停止）ではなく 429 で待たせる。GPT が unknown／available のうちは 529 の
  // ままにして fallbackModel（gpt-6-astra → opus）の探索を残す——判定不能を理由に、
  // まだ送れる先がある要求まで待たせない。
  const commonQuota = ctx.recoveryWaitEnabled === true
    ? (CLAUDE_QUOTA_STATES.includes(ctx.commonFamilyQuotaState)
      ? ctx.commonFamilyQuotaState
      : (commonUnusable ? 'none' : 'available'))
    : (commonUnusable ? 'none' : 'available');
  const waits = ctx.recoveryWaitEnabled === true && gptUnusable && quotaWaits(commonQuota);
  // recoveryWait が有効な構成では 403（明示停止）を答えにしない。待機にならなかった
  // 場合（Claude 側に空きがある・GPT がまだ unusable でない）は 529 で退避させる。
  const stops = bothUnusable && ctx.bothUnusableStatus !== 529 && ctx.recoveryWaitEnabled !== true;
  const status = waits ? 429 : (stops ? 403 : 529);
  const resetAts = waits || bothUnusable ? [ctx.gptResetAt, ctx.claudeResetAt] : [];
  const body = Buffer.from(buildDegradeBody(status, { resetAts }));
  // 429 では元の Retry-After と anthropic-ratelimit-* を落として Retry-After: 30 を1つだけ付ける。
  const headers = waits
    ? applyRecoveryWaitHeaders(withoutBodyHeaders(candidate.headers))
    : withoutBodyHeaders(candidate.headers);
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
      retryAfter: waits ? RECOVERY_WAIT_RETRY_AFTER_SECONDS : undefined,
      mapReason: waits || bothUnusable ? 'both_pools_unusable' : 'all_claude_accounts_exhausted',
    },
  };
}

// 母艦裁定 D-72（坂根氏の判断③）: Codex 側の「認証失効」だけは 403 を 529 へ写像する。
// 「ログインが切れた場合は自動でローテーションして claude-rotator status には認証が
// 切れているというメッセージだけ出す。止まるのが困るので止まらないように」。
// 403 のままだと Claude Code はその場で停止する（M-5）。529 にすれば fallbackModel
// （Opus 等）へ自動退避するので作業が止まらない。契約 §C3.4 が理由を2つに分けている
// のは「ログインし直せ」と「資格情報そのものを読めない」を取り違えさせないためなので、
// 本文の文言だけは分ける（判定・ステータス・写像の記録はまったく同じ）。
const AUTH_EXPIRED_REASONS = new Map([
  ['codex_needs_login', 'The Codex pool is signed out; run codex login to restore it.'],
  ['codex_credentials_unavailable', 'The Codex pool credentials cannot be read; check the Codex credential storage.'],
]);

/**
 * 認証失効で返す 529 の本文を作る（設計書 §8.8 / D-72）。
 * @param {string} reason 契約 §C3.4 の理由名（AUTH_EXPIRED_REASONS の鍵）。
 * @returns {string} JSON 文字列。
 */
export function buildAuthDegradeBody(reason) {
  return JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message: AUTH_EXPIRED_REASONS.get(reason) },
  });
}

/**
 * gpt-* 経路で bridge の 403 を 529 へ書き換えるかを決める（母艦裁定 D-72）。
 * 条件は3つだけで、すべて成り立つときに限る:
 *   ①契約ヘッダ付きの応答であること（契約前 bridge・bridge 不達の 403 は素通し）
 *   ②いま返そうとしている応答が 403 であること
 *   ③理由が codex_needs_login または codex_credentials_unavailable であること
 * **scope は問わない**——pool でも model でも「止めない」という方針は変わらないため
 * （scope が効くのは (pool) を学習してよいかどうか＝§C10.3 T3 の側であり、そちらは変えない）。
 * codex_no_account_for_model の 403 は対象外である（設定の問題は退避しても解けない）。
 */
export function decideAuthDegradeRewrite(parsed, ctx = {}) {
  if (ctx.enabled !== true) return { rewrite: false, reason: 'disabled' };
  if (!parsed || parsed.contract === null) return { rewrite: false, reason: 'no-contract-header' };
  if (Number(ctx.upstreamStatus) !== 403) return { rewrite: false, reason: 'status-not-403' };
  if (!AUTH_EXPIRED_REASONS.has(parsed.reason)) return { rewrite: false, reason: 'reason-not-auth-expired' };
  return {
    rewrite: true,
    status: 529,
    body: buildAuthDegradeBody(parsed.reason),
    meta: {
      mappedFrom: 403,
      mappedFromType: 'permission_error',
      mappedTo: 529,
      mapReason: 'codex_auth_expired',
    },
  };
}

// 一時障害（上流へ届かなかった・上流が期限内に答えなかった）の理由。どちらも恒久拒否ではない。
const TRANSIENT_DEGRADE_REASONS = new Set(['codex_upstream_timeout', 'codex_upstream_unreachable']);

/**
 * gpt-* 経路で「待機（429）」へ倒すかを決める（統合設計 v2.1 §3.2・§4.1 案A）。
 *
 * **待機の条件から scope と pool-state を外してある。** bridge が使用率由来の 529 に
 * pool-state を付けない方針を採ると、pool-state を条件にした判定はその 529 を素通しし、
 * 死んだ Claude へ退避して最終段の無音バックオフへ落ちる。決め手は「bridge がいま拒否を
 * 返したこと」と「Claude 共通枠の三値」だけにする（学習側＝§C10.3 T3 は 1 文字も変えない）。
 *
 * **認証失効（codex_needs_login／codex_credentials_unavailable）は待機させない**
 * （母艦 L2 `C-20260915-3F-24` 案A）。R7 の 403→529 を維持する——人が codex login する
 * まで自力回復しないモデルを 429 で叩き続けるより、529 で別モデルへ退避させるほうがよい。
 * decideAuthDegradeRewrite() はこの関数の**後**に走るので、順序に頼らず上流の実ステータスと
 * reason で判定する（そうしないと同じ応答が §3.2 の表の 2 行に同時に当たる）。
 *
 * @param {ReturnType<typeof parseBridgeContract>|null} parsed 解析済みヘッダ。
 * @param {{enabled?:boolean, upstreamStatus?:number, claudeQuotaState?:string,
 *          gptPoolState?:string, gptResetAt?:string|null, claudeResetAt?:string|null}} ctx
 */
export function decideRecoveryWaitResponse(parsed, ctx = {}) {
  if (ctx.enabled !== true) return { rewrite: false, reason: 'disabled' };
  // 契約 §C3.7-1: 契約ヘッダの無い応答は「契約前の bridge」であり一切書き換えない。
  if (!parsed || parsed.contract === null) return { rewrite: false, reason: 'no-contract-header' };
  // 認証失効はステータスに依存せず除外する。bridge が 529 に codex_needs_login を
  // 付けてきた場合も、人が codex login するまで回復しないので待たせない（素通し）。
  if (AUTH_EXPIRED_REASONS.has(parsed.reason)) {
    return { rewrite: false, reason: 'auth-expired-stays-529' };
  }
  const status = Number(ctx.upstreamStatus);
  const waits = quotaWaits(ctx.claudeQuotaState);
  const shared = {
    gptPoolState: ctx.gptPoolState,
    claudePoolState: ctx.claudeQuotaState === 'none' ? 'all-exhausted' : ctx.claudeQuotaState,
  };
  if (status === 529) {
    if (!waits) return { rewrite: false, reason: 'claude-has-room' };
    // D-150: 本文と同じ配列からログ用の effectiveResetAt を導く（上の
    // decideBridgeResponse と同じ理由・同じ作り方）。resetAt= は生値のまま残す。
    const resetAts = [ctx.gptResetAt, parsed.resetAt, ctx.claudeResetAt];
    return {
      rewrite: true,
      status: 429,
      retryAfterSeconds: RECOVERY_WAIT_RETRY_AFTER_SECONDS,
      stripRateLimitHeaders: true,
      body: buildDegradeBody(429, { resetAts }),
      meta: {
        ...shared,
        effectiveResetAt: earliestResetAt(resetAts),
        mappedFrom: 529,
        mappedFromType: 'overloaded_error',
        mappedTo: 429,
        retryAfter: RECOVERY_WAIT_RETRY_AFTER_SECONDS,
        mapReason: 'both_pools_unusable',
      },
    };
  }
  if (status === 403 && TRANSIENT_DEGRADE_REASONS.has(parsed.reason)) {
    // Claude 側に空きがあるなら 529 にして退避させる（3 回で fallbackModel へ移る）。
    // 空きが無い／判定できないなら、要求した GPT 側で待つ。
    // この枝の本文（buildTransientDegradeBody）は回復見込み時刻を**持たない**ので、
    // effectiveResetAt も出さない（D-150 の別名は「本文へ実際に載った値」を指す）。
    const mapped = waits ? 429 : 529;
    return {
      rewrite: true,
      status: mapped,
      retryAfterSeconds: waits ? RECOVERY_WAIT_RETRY_AFTER_SECONDS : null,
      stripRateLimitHeaders: true,
      body: buildTransientDegradeBody(mapped),
      meta: {
        ...shared,
        mappedFrom: 403,
        mappedFromType: 'permission_error',
        mappedTo: mapped,
        retryAfter: waits ? RECOVERY_WAIT_RETRY_AFTER_SECONDS : undefined,
        mapReason: 'codex_upstream_transient',
      },
    };
  }
  // codex_no_account_for_model・request_invalid・413・一般 500 などは現行どおり素通しする
  // （設定の問題や要求そのものの誤りは、待っても退避しても解けない）。
  return { rewrite: false, reason: 'status-not-mappable' };
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
  // 母艦裁定 D-150: ログの resetAt= は契約ヘッダ x-ombr-reset-at の**生値**（Codex 側の
  // 週次）であり、本文へ載る値（GPT 週次・契約ヘッダ・Claude 5h の3候補の最小）とは
  // 別物である。同じ名前で意味が違うため復旧見込みを取り違える読み方を招いた。
  // そこで本文と**同じ配列**から effectiveResetAt を導いてログへ並べて出す。
  // 既存の resetAt= は残す（上書きしない）。判定・ステータス・本文は1バイトも変えない。
  // ctx.claudeResetAt は呼び出し側（openai-bridge.js）が1回だけ評価した値であり、
  // ここでは配列を1つ作って本文とログの両方に使うので、二重評価も食い違いも起きない。
  const resetAts = [ctx.gptResetAt, parsed.resetAt, ctx.claudeResetAt];
  return {
    rewrite: true,
    status: 403,
    body: buildDegradeBody(403, { resetAts }),
    meta: {
      gptPoolState: 'unusable',
      claudePoolState: 'all-exhausted',
      // 3候補がすべて無効なら null。buildBridgeLogMeta が null を出さないので、
      // その場合のログ行は現行とバイト単位で同一になる。
      effectiveResetAt: earliestResetAt(resetAts),
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
  // effectiveResetAt は resetAt（契約ヘッダの生値）の直後に置く。2つが隣同士で読めることが
  // D-150 の目的（生値と本文へ実際に載った値の取り違え防止）。下の extra ループに入れると、
  // 間に primaryUsedPercent／secondaryUsedPercent／cached が挟まって隣接しない。
  // 写像しない行では extra が空なので、この行は何も足さずログはバイト単位で現行と同一。
  put('effectiveResetAt', extra?.effectiveResetAt);
  put('primaryUsedPercent', parsed?.primaryUsedPercent);
  put('secondaryUsedPercent', parsed?.secondaryUsedPercent);
  // cached は recoveryWait 有効時だけ呼び出し側が渡す（ヘッダが無いときは 'none'）。
  // 既存の bridgeCached はヘッダがあるときしか出ないため、「ヘッダが無かった」と
  // 「写像機能が無効だった」を本番ログで区別できず、T2b の第3条件を監査できない。
  put('cached', extra?.cached);
  for (const key of [
    'gptPoolState', 'gptModelState', 'claudePoolState',
    'mappedFrom', 'mappedFromType', 'mappedTo', 'retryAfter', 'mapReason', 'mapPath',
  ]) put(key, extra?.[key]);
  return meta;
}

/** buildBridgeLogMeta() の結果をログ行の末尾へ足す形（先頭に空白1つ）にする。空なら空文字列。 */
export function formatLogMeta(meta) {
  const entries = Object.entries(meta || {});
  return entries.length === 0 ? '' : ` ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
}
