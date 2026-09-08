import http from 'node:http';

import {
  buildBridgeLogMeta, decideBridgeResponse, formatLogMeta, parseBridgeContract,
} from './degrade-state.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
]);

// 追試4b（docs/research/11b_spike4b-nonretryable-status.md）で確定: bridge不達は403
// permission_errorで統一する。502/504はClaude Codeが最大301回・指数バックオフで
// 再試行し続け明示エラーにならないため使わない。
const BRIDGE_UNREACHABLE_STATUS = 403;

export const DEFAULT_OPENAI_BRIDGE = {
  enabled: false,
  url: 'http://127.0.0.1:18765',
  modelPattern: '^gpt-|^o[0-9]|^openai/',
  // 仕様書 4.2.1 節（v3）: 接続確立前（connectRetriesでのリトライ対象）と確立後の
  // アイドル（無応答）は別障害なので分ける。いずれも最終的なHTTPステータスは
  // 403 permission_error で統一する（追試4b・2026-09-07確定。旧稿は502/504）。
  connectTimeoutMs: 5000,
  idleTimeoutMs: 30000,
  connectRetries: 0,
};

// 設計書 §7.3-1（R3-2）: degradeMapping の既定は DEFAULT_OPENAI_BRIDGE にも
// createDefaultConfig() にも足さず、内部定数として持つ。理由は2つある。
// 理由A（浅いマージの罠）: resolveOpenAiBridgeSettings() の
//   raw = { ...DEFAULT_OPENAI_BRIDGE, ...config.openaiBridge } は浅いマージなので、
//   既定側にセクションを置くと、利用者が {"degradeMapping":{"enabled":true}} とだけ
//   書いた瞬間に残りの既定値（gptPoolUnusableTtlMs 等）がすべて undefined になる。
// 理由B（OSS 生成物の不変）: createDefaultConfig() は新規インストール時の config.json を
//   そのまま書き出す。キーを足さなければ、この機能を使わない利用者の生成ファイルは
//   1バイトも変わらない（src/config.js は本タスクで1行も変えない）。
export const DISABLED_DEGRADE_MAPPING = Object.freeze({
  enabled: false,
  bothUnusableStatus: 403,
  gptPoolUnusableTtlMs: 60000,
  codexStatusUrl: null,
  codexStatusTimeoutMs: 1500,
  // 正規化の過程で捨てた設定の理由。値そのものは載せない（設定由来の文字列を
  // ログへ流さない）。起動時と reload 時に logDegradeMappingConfigNotice() が
  // 1件1行で出す（設計書 §7.2「非ループバックは警告つきで null と同じ扱い」）。
  notices: Object.freeze([]),
});

// bothUnusableStatus は「明示停止（403）」か「退避を試み続ける（529）」の二択のみ。
// 不正値は安全側（403＝明示停止）へ倒す（設計書 §7.2）。
const BOTH_UNUSABLE_STATUSES = new Set([403, 529]);

// openaiBridge.enabled が偽のまま degradeMapping.enabled を真にする構成は禁止しない
// （Fable 週次サブキャップだけの枯渇は bridge 無しでも fallbackModel で救済できる）が、
// fallbackModel の最終要素まで同じ枯渇プールに当たる構成では無言待ちになるため、
// 気づけるように1行だけ通知する（設計書 §7.3-4・§14.2）。
const DEGRADE_MAPPING_WITHOUT_BRIDGE_NOTICE =
  'degradeMapping enabled without openaiBridge; 529 mapping applies to Claude-internal fallback only';

// codexStatusUrl を捨てたときの理由（設計書 §7.2）。openaiBridge.url の fail-safe と
// 同じ言い回しに揃える（'openaiBridge.url must be loopback; branch disabled'）。
// 設定値そのものは載せない: この行は運用ログへ出るため、利用者が書いた URL を
// そのまま転記しない。
const CODEX_STATUS_URL_NOT_LOOPBACK_NOTICE =
  'degradeMapping.codexStatusUrl must be loopback; codex status section disabled';
const CODEX_STATUS_URL_INVALID_NOTICE =
  'degradeMapping.codexStatusUrl is not a usable url; codex status section disabled';
// http.request() は http: 以外のスキームを扱えず、同期 throw する。
// 取得時に落とすのではなく設定解決の時点で捨て、理由を notice で残す。
const CODEX_STATUS_URL_SCHEME_NOTICE =
  'degradeMapping.codexStatusUrl must use http: scheme; codex status section disabled';

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// new URL().hostname は IPv6 リテラルを角括弧つき（'[::1]'）で返すため、
// LOOPBACK_HOSTS（素の '::1'）と突き合わせる前に角括弧を外す。
// WHATWG URL は '[0:0:0:0:0:0:0:1]' を '[::1]' へ正規化するので、展開形も同じ経路で
// 許可される。IPv4 射影（'::ffff:127.0.0.1' → '[::ffff:7f00:1]'）と未指定アドレス
// （'[::]'）は許可リストに無いので拒否側へ倒れる（安全側）。
function unbracketHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// codexStatusUrl は openaiBridge.url と同じくループバックに限る（設計書 §7.2）。
// 非ループバック・解析不能・型違いはいずれも null（＝Codex 節を出さない）へ倒したうえで、
// 「なぜ捨てたか」を notice として返す（黙って捨てない）。
// 未指定（null / undefined）は既定そのものなので notice を出さない。
function normalizeCodexStatusUrl(value) {
  if (value === null || value === undefined) return { value: null, notice: null };
  if (typeof value !== 'string' || value === '') {
    return { value: null, notice: CODEX_STATUS_URL_INVALID_NOTICE };
  }
  let hostname;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return { value: null, notice: CODEX_STATUS_URL_INVALID_NOTICE };
  }
  if (!LOOPBACK_HOSTS.has(unbracketHostname(hostname))) {
    return { value: null, notice: CODEX_STATUS_URL_NOT_LOOPBACK_NOTICE };
  }
  // ループバック判定の後に置く: 非ループバックの https を「まずループバックでない」と
  // 説明する既存の規律を変えないため。ここまで来た値は解析済みなので再解析は投げない。
  if (new URL(value).protocol !== 'http:') {
    return { value: null, notice: CODEX_STATUS_URL_SCHEME_NOTICE };
  }
  return { value, notice: null };
}

// セクションが無い／キーが無い／型が違う、のいずれでも「無効」に倒れる（設計書 §7.3-3）。
// 判定式は settings.degradeMapping.enabled === true の1つだけにするため、
// enabled は真偽値の true だけを受け付ける（'true' や 1 は無効）。
export function normalizeDegradeMapping(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DISABLED_DEGRADE_MAPPING;
  const codexStatusUrl = normalizeCodexStatusUrl(raw.codexStatusUrl);
  return Object.freeze({
    enabled: raw.enabled === true,
    bothUnusableStatus: BOTH_UNUSABLE_STATUSES.has(raw.bothUnusableStatus)
      ? raw.bothUnusableStatus
      : DISABLED_DEGRADE_MAPPING.bothUnusableStatus,
    gptPoolUnusableTtlMs: positiveNumber(raw.gptPoolUnusableTtlMs, DISABLED_DEGRADE_MAPPING.gptPoolUnusableTtlMs),
    codexStatusUrl: codexStatusUrl.value,
    codexStatusTimeoutMs: positiveNumber(raw.codexStatusTimeoutMs, DISABLED_DEGRADE_MAPPING.codexStatusTimeoutMs),
    notices: Object.freeze(codexStatusUrl.notice ? [codexStatusUrl.notice] : []),
  });
}

// 起動時と POST /internal/reload 時に出す通知（設計書 §7.2・§7.3-4）。呼び出し元は
// src/proxy-server.js の2箇所（createProxyServer の初回解決直後と /internal/reload の
// 再解決直後）だけであり、gpt-* の要求ごとには出さない。
// resolveOpenAiBridgeSettings() は純粋に保ちたいので、ログ出力はこの関数へ分けてある。
// warning（fail-safe の無効化）へは載せない: shouldRouteToOpenAiBridge() が warning の
// 有無で reason を 'disabled' / 'parse-error' に振り分けており、通知を warning に
// 混ぜると gpt-* 要求ごとに parse-error-fallback のログが増えてしまうため。
// 返り値は実際に出した行の配列（何も出さないときは空配列）。degradeMapping を
// 書いていない構成では必ず空配列になる＝既存挙動への影響ゼロ。
export function logDegradeMappingConfigNotice(settings, logger) {
  const degradeMapping = settings?.degradeMapping;
  if (!degradeMapping) return [];
  const reasons = [];
  // (1) bridge 分岐が無効なまま写像だけを有効にした構成（設計書 §7.3-4）。
  if (!settings.enabled && degradeMapping.enabled === true) {
    reasons.push(DEGRADE_MAPPING_WITHOUT_BRIDGE_NOTICE);
  }
  // (2) 正規化で捨てた設定（非ループバック等の codexStatusUrl。設計書 §7.2）。
  // fail-safe 3経路では degradeMapping ごと DISABLED_DEGRADE_MAPPING に倒れており
  // notices は空なので、ここでも1行も出ない。
  // notices が欠けた settings（正規化を通っていない手組みの値）でも投げない。
  // この関数は起動経路で呼ばれるため、例外はプロセス起動そのものを壊す。
  if (Array.isArray(degradeMapping.notices)) reasons.push(...degradeMapping.notices);
  const lines = reasons.map(
    reason => `${new Date().toISOString()} openai-bridge config-notice ${reason}`,
  );
  for (const line of lines) logger?.(line);
  return lines;
}

function disabled(raw, warning, degradeMapping = DISABLED_DEGRADE_MAPPING) {
  return {
    enabled: false,
    url: raw.url,
    modelPattern: null,
    connectTimeoutMs: raw.connectTimeoutMs,
    idleTimeoutMs: raw.idleTimeoutMs,
    connectRetries: raw.connectRetries,
    degradeMapping,
    warning,
  };
}

export function resolveOpenAiBridgeSettings(config) {
  const raw = { ...DEFAULT_OPENAI_BRIDGE, ...(config?.openaiBridge || {}) };
  // 利用者が bridge 分岐を意図的に切っている経路だけは degradeMapping を正規化して返す。
  // (b) の 529 写像は bridge を必要としないため、ClaudeRotator 単体構成を成立させる
  // （設計書 §7.3-2・§14.2）。以下の fail-safe 3経路（modelPattern / url / 非ループバック）は
  // 「設定を解釈できなかった」のだから隣接する新機能も信用せず、既定（無効）のままにする。
  if (!raw.enabled) return disabled(raw, null, normalizeDegradeMapping(raw.degradeMapping));
  let modelPattern;
  try {
    modelPattern = new RegExp(raw.modelPattern);
  } catch {
    // fail-safe（仕様書 4.2.2 節 b・v3 で拡張）: コンパイル失敗でも例外を投げず、
    // 分岐を無効化して既存の Anthropic 宛転送経路を壊さない。
    return disabled(raw, 'invalid openaiBridge.modelPattern; branch disabled');
  }
  let hostname;
  try {
    hostname = new URL(raw.url).hostname;
  } catch {
    return disabled(raw, 'invalid openaiBridge.url; branch disabled');
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return disabled(raw, 'openaiBridge.url must be loopback; branch disabled');
  }
  return {
    enabled: true,
    url: raw.url,
    modelPattern,
    connectTimeoutMs: raw.connectTimeoutMs,
    idleTimeoutMs: raw.idleTimeoutMs,
    connectRetries: raw.connectRetries,
    degradeMapping: normalizeDegradeMapping(raw.degradeMapping),
    warning: null,
  };
}

export function safeParseBody(body) {
  try {
    const parsed = JSON.parse(Buffer.from(body || '').toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function safeParseModel(body) {
  const model = safeParseBody(body)?.model;
  return typeof model === 'string' ? model : null;
}

export function shouldRouteToOpenAiBridge(body, settings) {
  if (!settings?.enabled) {
    // fail-safe（仕様書 4.2.2 節 b）で無効化された場合は 'parse-error' として記録し、
    // 設定どおりの通常オフ（'disabled'）と区別する（呼び出し側のログ outcome=parse-error-fallback）。
    // 無効時は body を一切パースしない（無駄なパースを避ける早期 return）。
    return { route: false, model: null, reason: settings?.warning ? 'parse-error' : 'disabled' };
  }
  const parsed = safeParseBody(body);
  const model = typeof parsed?.model === 'string' ? parsed.model : null;
  if (!model) return { route: false, model: null, reason: 'parse-error' };
  if (!settings.modelPattern.test(model)) return { route: false, model, reason: 'no-match' };
  return { route: true, model, reason: 'match' };
}

function errorBody(reason) {
  return JSON.stringify({
    type: 'error',
    error: { type: 'permission_error', message: `openai-bridge unreachable: ${reason}` },
  });
}

function sendSynthetic(res, reason) {
  if (res.headersSent || res.writableEnded) return;
  const payload = errorBody(reason);
  res.writeHead(BRIDGE_UNREACHABLE_STATUS, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// req.url は絶対形式（proxy形式のリクエストライン。例: `http://evil.example.com/v1/messages`）
// を取り得る。`new URL(req.url, base)` は第一引数が絶対URLだと base を無視するため、
// そのまま settings.url へ渡すと接続先ホストが req.url 側に乗っ取られる。
// hostname/port は必ず settings.url 由来にし、req.url からは pathname/search だけを取る
// （src/proxy-server.js の configuredUpstreamTarget と同型）。
function pinnedUpstreamTarget(requestUrl, bridgeUrl) {
  const inbound = new URL(requestUrl, 'http://openai-bridge.internal');
  const target = new URL(bridgeUrl);
  target.pathname = inbound.pathname;
  target.search = inbound.search;
  target.hash = '';
  return target;
}

// 設計書 §9.3: degradeReason は bridge の x-ombr-degrade-reason 由来だが、
// 「不達のとき（＝契約ヘッダを1つも受け取れなかったとき）は rotator 自身が §9.4 の値を
// 入れる」。値は outcome の snake_case（degradeReason だけは snake_case ＝ §9.3 の但し書き）。
const ROTATOR_DEGRADE_REASONS = Object.freeze({
  'bridge-unreachable': 'bridge_unreachable',
  'bridge-connect-timeout': 'bridge_connect_timeout',
  'bridge-idle-timeout': 'bridge_idle_timeout',
  'bridge-stream-error': 'bridge_stream_error',
});

// ログ行は空白区切りの key=value なので、値に空白・改行を残さない（契約 §C3.1）。
// src/degrade-state.js の logToken と同型（あちらは内部関数なので公開されていない）。
function logToken(value) {
  return String(value).replace(/\s+/g, '_').slice(0, 64);
}

// 設計書 §9: エラー種別（error.code）と message をログへ残す。現行は ENOTFOUND /
// ECONNRESET / EPIPE をすべて応答本文の 'connection refused' へ丸めており、ログからも
// 区別できなかった。**応答本文の文言は変えない**（§8.9「HTTP 応答は不変」）。
// 丸めを解消するのはログ側だけであり、追記は末尾へ・値があるときだけ行う（§9.2）。
function errorLogFields(error) {
  const fields = {};
  if (error?.code) fields.errorCode = logToken(error.code);
  if (error?.message) fields.errorMessage = logToken(error.message);
  return fields;
}

// 本文送信前（＝bridge からの応答を一切受け取っていない）の接続確立失敗に限り再試行する。
// 応答を受け取った後（res.headersSent === true）に再試行すると、二重処理のリスクが生まれる。
const RETRYABLE_CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']);

// gptPoolState は任意引数である（設計書 §11.1 R3-4）。渡さない呼び出しは現行と完全に
// 同一に振る舞い、ログへ1フィールドも足さない（§14.4）。渡すのは src/proxy-server.js が
// degradeMapping.enabled を真と解決したときだけで、生成・破棄もそちらが受け持つ。
// claudeAllUnusable も任意引数である（設計書 §11.1 R4-1 の補足）。**真偽値ではなく関数**を
// 受け取るのは、要求の開始時点ではなく **bridge の応答ヘッダを受け取った時点の台帳**で
// 判定するためである（要求から応答までの間に口座が回復しうる）。渡さない呼び出しは
// 現行と完全に同一に振る舞い、403 への書換も claudePoolState の追記も起きない（§14.4）。
// claudeResetAt も同型の任意引数で、Claude 側の最も早い回復見込み時刻（RFC3339）を返す
// 関数である。403 の本文へ「GPT 側と Claude 側の早いほう」を載せるためにだけ使い、
// 書換の可否には影響しない。渡さなければ本文は GPT 側の reset-at だけで組み立てられる。
export function forwardToOpenAiBridge({
  req, res, body, model, settings, logger,
  httpRequestImpl = http.request, gptPoolState = null,
  claudeAllUnusable = null, claudeResetAt = null,
}) {
  const startedAt = Date.now();
  const target = pinnedUpstreamTarget(req.url, settings.url);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value; // Authorization/x-api-key は素通し
  }
  headers['content-length'] = String(Buffer.byteLength(body || Buffer.alloc(0)));

  const maxConnectAttempts = 1 + Math.max(0, Number(settings.connectRetries) || 0);

  return new Promise(resolve => {
    let settled = false;
    let connectTimer = null;
    let idleTimer = null;
    let currentUpstream = null;
    // upstream（ClientRequest）の 'finish' が一度でも発火したら true。'finish' は
    // リクエスト全体（ヘッダ＋本文）がOSへ渡され切った時点で発火するため、これが
    // 立った後の接続エラーは「bridge が本文を受信済みの可能性がある」ことを意味し、
    // 再試行すると二重送信（Pro枠の二重消費）になり得るため再試行しない。
    // 実測（Node 22・ループバック）では、接続が確立しさえすれば小さな本文は
    // RST 由来の 'error' より先に 'finish' が発火する。つまりこのフラグが false の
    // ままなのはソケットが接続しなかった場合（ECONNREFUSED/ENOTFOUND）だけであり、
    // 再試行は事実上「一度も接続できなかったとき」に限定される。
    // 接続確立後の即時リセットは再試行しない（本文が渡り切っている可能性があるため）。
    let requestFullySent = false;

    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
    };

    // bridge が返した契約ヘッダ（x-ombr-*）の解析結果。応答ヘッダを受け取るまでは null。
    let contract = null;

    // 設計書 §14.4「degradeMapping 無効時に openai-bridge のログ行が現行と同一である
    // （追記フィールドが1つも出ないこと）」。追記は写像機能を有効にした構成だけの挙動であり、
    // 既定（無効）の利用者のログは outcome 名の改名以外は1文字も変わらない。
    const metaEnabled = settings?.degradeMapping?.enabled === true;

    // 設計書 §9.3 / §9.5(a): 学習した (pool) / (pool, model) の状態は、状態そのものを
    // 保持しているときだけ載せる。gptPoolState を渡さない呼び出し（＝既定の経路）では
    // 1フィールドも増えない。read() は期限切れ（T6・T7）を反映した現在値を返す。
    const poolStateFields = () => {
      if (!gptPoolState) return {};
      const view = gptPoolState.read(model);
      return { gptPoolState: view.pool.state, gptModelState: view.model.state };
    };

    // 応答ヘッダを受け取った時点で1回だけ評価した Claude 側台帳の判定（null＝未評価）。
    // 評価済みの場合だけ claudePoolState をログへ載せる（§9.5(a) の完成形）。
    let claudeExhausted = null;

    // 台帳の判定は呼び出し側から注入された関数であり、ここは http の応答コールバックの
    // 内側である。例外がそのまま抜けると未捕捉例外になり、未捕捉例外ハンドラを持たない
    // rotator はプロセスごと落ちる（＝全 Claude セッション停止。§8.7 手順6 と同じ理由）。
    // 判定できなかった場合は「Claude は使える」側＝退避を試みる側へ倒す（§8.7 の安全側）。
    const evaluateClaudeLedger = () => {
      if (typeof claudeAllUnusable !== 'function') return null;
      try {
        return claudeAllUnusable() === true;
      } catch {
        return null;
      }
    };

    // 全枯渇と判定したときだけ問い合わせる（台帳を走査するので、素通しする応答では呼ばない）。
    // ここも注入された関数なので、例外は捕まえて「時刻不明」へ倒す（本文から時刻が消えるだけ）。
    const evaluateClaudeResetAt = () => {
      if (typeof claudeResetAt !== 'function') return null;
      try {
        const value = claudeResetAt();
        return typeof value === 'string' && value.length > 0 ? value : null;
      } catch {
        return null;
      }
    };

    const claudePoolStateFields = () => (claudeExhausted === null
      ? {}
      : { claudePoolState: claudeExhausted ? 'all-exhausted' : 'available' });

    // 設計書 §9.3 のフィールドを「値があるときだけ」末尾へ足す形に組み立てる。
    // 第3引数（写像の痕跡）は §9.3 の表の順序で並べたいので buildBridgeLogMeta 側へ渡す。
    const logMeta = (outcome, extra = {}, mapped = null) => {
      if (!metaEnabled) return null;
      // 契約 §C3.7-1: x-ombr-contract の無い応答は「契約前の bridge」なので、契約由来の
      // 値は1つも載せない（他の x-ombr-* が付いていても信用しない）。この場合でも、
      // rotator 自身が観測した事実（§9.4 の degradeReason・エラー種別）は残す＝§9.5(d)。
      const parsed = contract?.contract ? contract : null;
      return {
        ...buildBridgeLogMeta({
          ...(parsed || {}),
          // bridge 自身が理由を名乗っていればそれを優先する（実データ）。名乗っていない
          // 障害（不達・タイムアウト・ストリーム障害）だけ rotator 側の値を入れる。
          reason: parsed?.reason ?? ROTATOR_DEGRADE_REASONS[outcome] ?? null,
        }, { ...poolStateFields(), ...claudePoolStateFields(), ...(mapped || {}) }),
        ...extra,
      };
    };

    const finish = (outcome, status, meta = null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      logger?.(
        `${new Date().toISOString()} openai-bridge model=${model || '-'} method=${req.method} `
        + `path=${target.pathname} status=${status ?? '-'} durationMs=${Date.now() - startedAt} outcome=${outcome}`
        + formatLogMeta(meta),
      );
      resolve({ outcome, status: status ?? null });
    };

    // アイドルタイムアウト（outcome=bridge-idle-timeout。応答ヘッダの前後を問わない＝§9.4）。
    // 接続確立の直後（ヘッダ待ち）から、以後の各チャンク受信のたびに再武装するので、
    // 「接続はできたが応答が全く無い」場合と「200 を受け取った後にチャンクが来ない」場合
    // （§8.10）の両方をこの一本のタイマーだけで検出できる（connect の成否だけを見る
    // connectTimer とは責務を分ける）。ヘッダ送出後の発火では 403 を合成できず切断だけになる。
    // 無音はここで拾い、ストリームの実障害は bridge-stream-error として別に扱う。
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        currentUpstream?.destroy();
        const willSend = !res.headersSent;
        if (willSend) sendSynthetic(res, 'idle timeout');
        else res.destroy();
        finish('bridge-idle-timeout', willSend ? BRIDGE_UNREACHABLE_STATUS : null, logMeta('bridge-idle-timeout'));
      }, settings.idleTimeoutMs);
    };

    // クライアント切断の検出。readBody() で本文を読み切ってから forward するため
    // （src/proxy-server.js）、この時点で req は既に complete===true になっており
    // 'aborted' はもう発火しない。res 側の 'close'
    // （クライアントが切断し、かつまだ res.end() していない場合に発火する）で検出する。
    const onClientGone = () => {
      currentUpstream?.destroy();
      finish('client-abort', null, logMeta('client-abort'));
    };
    // 'aborted' は readBody() 前に切断された場合の保険として残す（副作用なし・二重発火は finish が防ぐ）。
    req.on('aborted', onClientGone);
    res.on('close', () => {
      if (!res.writableEnded) onClientGone();
    });

    const attemptConnect = attempt => {
      const upstream = httpRequestImpl(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: req.method,
          headers,
          // リクエストごとに使い捨てる（プールしない）。keep-alive の使い回しによる
          // ECONNRESET を避ける。new http.Agent() を毎回生成すると
          // ソケットプールが個別に残り続けるため、Node 標準の「プールしない」指定
          // である agent:false を使う。
          agent: false,
        },
        upstreamRes => {
          // 応答ヘッダを受け取った時点で契約ヘッダを解析しておく（設計書 §9.3）。
          // 値域外・未知の値はすべて null へ倒れるので、ここから先のログは
          // 「bridge が名乗った正しい値」だけを載せる。
          contract = parseBridgeContract(upstreamRes.headers);
          // 設計書 §11.1 R3-4・契約 §C10.3: 応答ヘッダの受領点で GPT プール状態を学習する。
          // 学習はメモリ上の状態を更新するだけであり、**応答は1バイトも変えない**
          // （529→403 の書換は R4-1 の範囲）。observe() 側で「契約ヘッダの無い応答は
          // 学習しない（T9）」「200 と 4xx/5xx だけが入力になる」を判定する。
          // res.destroyed のガードより前に置くのは、クライアントが切断していても
          // 「bridge がこう答えた」という事実は変わらないためである（学習を捨てると
          // 次の要求で同じ枯渇へもう1回投げることになる）。
          // degradeMapping が無効な構成では metaEnabled が偽になり、生成も観測も行わない。
          if (metaEnabled) gptPoolState?.observe(contract, upstreamRes.statusCode, model);
          if (res.destroyed) {
            upstream.destroy();
            return;
          }
          // ヘッダを受け取った時点で「アイドル」の窓を仕切り直す
          // （res.destroyed ガードの後ろに置き、切断済みクライアント宛にタイマーを
          // 張ったまま宙に浮かせない）。
          armIdleTimer();
          const responseHeaders = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
          }
          // ── R4-1: (c) 両プール利用不可のときだけ 529 を 403 へ書き換える（設計書 §8.7）──
          // 判定は degrade-state.js の decideBridgeResponse に閉じてある（4条件のすべてが
          // 成り立つときだけ真を返す）。ここでは「決まった手順で応答を作り替える」だけを行う。
          if (metaEnabled) claudeExhausted = evaluateClaudeLedger();
          // 学習済みの (pool)。gptPoolState を渡していない呼び出しでは 'unknown' 扱いになり、
          // 条件③が成り立たないので書換は起きない。
          const learnedPool = metaEnabled ? gptPoolState?.read(model).pool : null;
          const decision = metaEnabled
            ? decideBridgeResponse(contract, {
              enabled: true,
              upstreamStatus: upstreamRes.statusCode,
              claudeAllUnusable: claudeExhausted === true,
              gptPoolState: learnedPool?.state,
              gptResetAt: learnedPool?.resetAt,
              // 本文の「最早回復時刻」は GPT 側と Claude 側の早いほうを採る（§8.7）。
              claudeResetAt: claudeExhausted === true ? evaluateClaudeResetAt() : null,
              bothUnusableStatus: settings.degradeMapping.bothUnusableStatus,
            })
            : { rewrite: false };
          if (decision.rewrite) {
            const payload = Buffer.from(decision.body);
            // 手順2: 上流の本文由来ヘッダを落とす。とくに 529 の本文長を持つ Content-Length を
            // 残すとクライアントが本文を待ち続ける（transfer-encoding は HOP_BY_HOP で除去済み）。
            for (const key of Object.keys(responseHeaders)) {
              const lower = key.toLowerCase();
              if (lower === 'content-length' || lower === 'content-encoding' || lower === 'content-type') {
                delete responseHeaders[key];
              }
            }
            // 手順3: 自作した本文に一致するヘッダを入れ直す。
            responseHeaders['Content-Type'] = 'application/json';
            responseHeaders['Content-Length'] = String(payload.length);
            // 手順4。
            res.writeHead(decision.status, responseHeaders);
            res.end(payload);
            // 手順5: finish() を destroy() より先に呼ぶ（settled=true にして、破棄由来の
            // upstream 'error' で応答を二重に書かないようにする）。
            finish('forwarded-mapped', decision.status, logMeta('forwarded-mapped', {}, decision.meta));
            // 手順6: upstreamRes にはまだ 'error' ハンドラが無い。破棄由来の error を誰も
            // 受けないと未捕捉例外になり、rotator がプロセスごと落ちる（＝全 Claude セッション停止）。
            upstreamRes.on('error', () => {});
            upstream.destroy();
            // 手順7: data / end / error を装着する前に return する。装着しなければ
            // 「書換後に上流チャンクが届いて ERR_STREAM_WRITE_AFTER_END になる」経路が存在しない。
            return;
          }
          res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
          // SSE の逐次透過: 受け取り次第そのまま書き出す（バッファリングしない）。
          // クライアントが既に切断済みなら書き込まず upstream も畳む。res.write() が
          // false（バックプレッシャ）を返したら upstream を一時停止し、drain で再開する。
          upstreamRes.on('data', chunk => {
            armIdleTimer();
            if (res.destroyed) {
              upstream.destroy();
              return;
            }
            if (!res.write(chunk)) {
              upstreamRes.pause();
              res.once('drain', () => upstreamRes.resume());
            }
          });
          upstreamRes.on('end', () => {
            clearTimers();
            res.end();
            finish('forwarded', upstreamRes.statusCode || 200, logMeta('forwarded'));
          });
          // 応答ストリームの実障害（ECONNRESET・socket hang up 等）。無音は含まない
          // （無音は bridge-idle-timeout。設計書 §9.4）。
          upstreamRes.on('error', error => {
            clearTimers();
            res.destroy();
            finish('bridge-stream-error', null, logMeta('bridge-stream-error', errorLogFields(error)));
          });
        },
      );
      currentUpstream = upstream;
      upstream.once('finish', () => { requestFullySent = true; });

      // 接続確立前のタイムアウト（403 permission_error・outcome=bridge-connect-timeout）。
      // 接続拒否・DNS 失敗（bridge-unreachable）とは意味が違う——ポートは開いているのに
      // 受け付けられていない状態を指す（設計書 §9.4）。
      // TCP の接続確立（socket の 'connect'）が起きるまでだけを計測する。確立後は
      // ヘッダ待ち・チャンク間の無応答を問わずすべて idleTimer の責務にする。
      connectTimer = setTimeout(() => {
        upstream.destroy();
        sendSynthetic(res, 'connect timeout');
        finish('bridge-connect-timeout', BRIDGE_UNREACHABLE_STATUS, logMeta('bridge-connect-timeout'));
      }, settings.connectTimeoutMs);

      upstream.once('socket', socket => {
        const onConnected = () => {
          clearTimeout(connectTimer);
          // 接続確立後はヘッダ待ちもアイドル判定に含める。
          armIdleTimer();
        };
        // 既に接続済みのソケット（keep-alive の使い回し）であれば即座に扱う。
        if (socket.connecting) socket.once('connect', onConnected);
        else onConnected();
      });

      upstream.on('error', error => {
        // finish() 確定後（クライアント切断・タイムアウト等で既に処理済み）に
        // 発火した 'error'（例: destroy() 由来の ECONNRESET/socket hang up）は
        // 無視する。res 相手が既にいない状態で再試行・応答書込みを行わない。
        if (settled) return;
        // ヘッダ送出後は新しいステータスを返せない（仕様書 4.2.3 節）。応答は既に
        // 始まっていて上流側で壊れたのだから、不達ではなくストリーム障害である（§9.4）。
        if (res.headersSent) {
          res.destroy();
          finish('bridge-stream-error', null, logMeta('bridge-stream-error', errorLogFields(error)));
          return;
        }
        // まだ bridge からの応答を何も受け取っておらず、かつリクエスト全体（本文含む）
        // の送信が完了していない場合に限り settings.connectRetries まで再試行する。
        // requestFullySent===true の場合、本文は
        // 既に bridge へ渡り切っている（受信済みの可能性がある）ため、再試行すると
        // 二重送信（Pro 枠の二重消費）になり得るため再試行しない。
        if (!requestFullySent && attempt < maxConnectAttempts && RETRYABLE_CONNECT_ERROR_CODES.has(error?.code)) {
          clearTimers();
          logger?.(
            `${new Date().toISOString()} openai-bridge model=${model || '-'} method=${req.method} `
            + `path=${target.pathname} outcome=connect-retry attempt=${attempt + 1} code=${error?.code || '-'}`,
          );
          attemptConnect(attempt + 1);
          return;
        }
        // 応答本文は現行のまま（丸めたまま）にし、種別はログの errorCode で判別する（§8.9・§9）。
        sendSynthetic(res, 'connection refused');
        finish('bridge-unreachable', BRIDGE_UNREACHABLE_STATUS, logMeta('bridge-unreachable', errorLogFields(error)));
      });

      upstream.end(body);
    };

    attemptConnect(1);
  });
}
