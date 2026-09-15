import http from 'node:http';

import {
  buildBridgeLogMeta, decideAuthDegradeRewrite, decideBridgeResponse, formatLogMeta,
  parseBridgeContract,
} from './degrade-state.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const HOP_BY_HOP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
]);

// 契約ヘッダ（x-ombr-*）は rotator と bridge の間だけで意味を持つ名前空間である。
// 利用者（Claude Code）から届いた同名ヘッダをそのまま上流へ流すと、bridge が
// 「rotator が名乗った値」と区別できず、契約の偽装を許すことになる。転送前に
// 接頭辞一致（大文字小文字を区別しない）ですべて落とす。
const CONTRACT_HEADER_PREFIX = 'x-ombr-';

// 契約 §C4.6: bridge は非 SSE 要求の生存通知（102 Processing）を
// 「rotator の idleTimeoutMs の 1/2 以下」の間隔で送る義務を負う。その 1/2 を計算する
// ためには rotator が実際に使っている打ち切り時間を知る必要があるので、要求ヘッダで渡す。
const IDLE_TIMEOUT_REQUEST_HEADER = 'x-ombr-idle-timeout-ms';

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

// 転送要求から落とす契約ヘッダの判定。req.headers のキーは Node が小文字化するが、
// 手組みの req（テスト・将来の呼び出し元）でも取りこぼさないよう明示的に畳む。
function isContractHeader(name) {
  return name.toLowerCase().startsWith(CONTRACT_HEADER_PREFIX);
}

// 設定が無効（未設定・非数値・0 以下）ならヘッダを付けない。付けないことが
// 「rotator は値を名乗らなかった」の意味になり、bridge 側は自分の既定へ倒せる。
// 値は10進整数の文字列にする（HTTP ヘッダに小数を載せない）。
function idleTimeoutRequestHeaderValue(settings) {
  const idleTimeoutMs = positiveNumber(settings?.idleTimeoutMs, null);
  return idleTimeoutMs === null ? null : String(Math.trunc(idleTimeoutMs));
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

// 再試行してよいのは「TCP 接続が一度も確立しなかった」失敗だけである。ECONNREFUSED は
// 定義上そこにしか現れない（相手がポートを開いていない＝本文は1バイトも渡っていない）。
// 旧実装は ECONNRESET / ENOTFOUND も対象にしていたが、
//   - ECONNRESET は「一度は接続できた」証拠であり、再送は二重送信（Pro 枠の二重消費）になり得る。
//   - ENOTFOUND は名前解決の失敗で、即時に繰り返しても結果は変わらない。
// ので外した。実際の判定はコード名だけでなく「接続が確立していないこと」との論理積で行う
// （下の connectionEstablished）。
const RETRYABLE_CONNECT_ERROR_CODES = new Set(['ECONNREFUSED']);

// 接続前リトライの境界値。いずれも実測に基づく確定値ではなく、bridge の再起動
// （設定適用）が数秒で終わることを前提にした保守的な暫定値である。
//   - MAX_CONNECT_RETRIES: connectRetries の上限。**再試行の回数**であり、接続試行の
//     総数は connectRetries + 1（off-by-one の定義）。上限 12 ＝ 接続試行 13 回。
//   - CONNECT_RETRY_DELAY_MS: 各再試行の前に必ず待つ時間。即時再試行は、落ちている
//     bridge へ連打するだけで復帰を助けない。
//   - CONNECT_RETRY_BUDGET_MS: 接続が確立するまでに費やしてよい総時間（待機と接続試行の
//     両方を含む）。待機の完了がこの予算を超える再試行は予約しない。
//     6000ms ÷ 500ms ＝ 12 なので、予算側の上限も再試行 12 回で MAX_CONNECT_RETRIES と一致する。
export const MAX_CONNECT_RETRIES = 12;
export const CONNECT_RETRY_DELAY_MS = 500;
export const CONNECT_RETRY_BUDGET_MS = 6000;

// connectRetries の正規化。0..12 の有限整数だけを受け付け、それ以外（NaN・Infinity・
// 負数・小数・範囲外の巨大値・文字列・null など）は「設定を解釈できなかった」として
// 既定の 0（再試行しない）へ倒す。resolveOpenAiBridgeSettings() の fail-safe 3経路
// （modelPattern / url / 非ループバック）と同じ考え方で、解釈できない設定で勝手に
// 再接続を撃たない。
export function normalizeConnectRetries(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0;
  if (value < 0 || value > MAX_CONNECT_RETRIES) return 0;
  return value;
}

// 再試行を予約してよいかの判定（純関数）。attempt は今まさに失敗した試行の番号（1 始まり）。
// retries は正規化前の設定値でよい（ここで正規化する）。elapsedMs は要求の開始からの経過。
export function planConnectRetry({ attempt, retries, elapsedMs }) {
  const delayMs = CONNECT_RETRY_DELAY_MS;
  const allowed = normalizeConnectRetries(retries);
  if (!Number.isInteger(attempt) || attempt < 1) return { retry: false, delayMs };
  // attempt 回目の失敗後に許される再試行は attempt <= allowed のときだけ
  // （allowed=1 なら 1 回目の失敗だけが再試行でき、2 回目の失敗では打ち切る）。
  if (attempt > allowed) return { retry: false, delayMs };
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : Number.POSITIVE_INFINITY;
  // 「待機が明けた時点」が予算内であることを求める（＝待機時間も予算に含める）。
  if (elapsed + delayMs > CONNECT_RETRY_BUDGET_MS) return { retry: false, delayMs };
  return { retry: true, delayMs };
}

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
    if (isContractHeader(key)) continue; // 利用者が名乗った x-ombr-* は転送しない（偽装防止）
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value; // Authorization/x-api-key は素通し
  }
  headers['content-length'] = String(Buffer.byteLength(body || Buffer.alloc(0)));
  // 除去のあとに付けるので、利用者が同名ヘッダを送っていても rotator の値だけが残る。
  // degradeMapping の有効・無効には依存させない（契約ヘッダの偽装防止も、生存通知の
  // 周期を決めるための値の受け渡しも、写像機能の有無とは無関係な rotator の基本挙動）。
  const idleTimeoutHeader = idleTimeoutRequestHeaderValue(settings);
  if (idleTimeoutHeader !== null) headers[IDLE_TIMEOUT_REQUEST_HEADER] = idleTimeoutHeader;

  // 解釈できない設定（NaN・Infinity・負数・小数・範囲外・文字列）は 0 へ倒す。
  // 旧実装は `Math.max(0, Number(...) || 0)` だけだったため、Infinity がそのまま
  // 上限になり、bridge が落ちている間ずっと再接続を撃ち続ける経路が開いていた。
  const connectRetries = normalizeConnectRetries(settings.connectRetries);

  // 接続前リトライを使う構成だけが持つ「接続前の締切」（絶対時刻）。
  // 予算（CONNECT_RETRY_BUDGET_MS）を待機の予約時にしか見ていなかったため、予約された
  // 次の試行には connectTimeoutMs が丸ごと付き直し、総時間が予算を大きく超え得た
  // （実測: connectRetries=12 / connectTimeoutMs=5000 で、最初の未接続が 4800ms 目に
  // ECONNREFUSED → 2回目の接続開始が 5306ms 目 → 最終 403 が 10307ms 目）。
  // 締切を1本だけ持ち、
  //   (1) 各試行の connect タイムアウトを残予算以内へ切り詰める
  //   (2) 待機 callback が締切より後に走ったら、新しい接続を開かない
  // の2点で閉じる。
  // **この締切は接続が確立するまでにしか効かない。** 接続後は connectTimer を解除して
  // idleTimer へ引き継ぐ設計（下の onConnected）なので、接続済み・送信中の正常な要求を
  // 途中で切ることはない（長考の応答待ちは従来どおり idleTimeoutMs の責務）。
  // connectRetries=0（既定）では締切を持たず、connectTimeoutMs は現行のまま素通しする。
  const connectDeadlineAt = connectRetries > 0 ? startedAt + CONNECT_RETRY_BUDGET_MS : null;
  const remainingConnectBudgetMs = () => (
    connectDeadlineAt === null ? null : connectDeadlineAt - Date.now()
  );

  return new Promise(resolve => {
    let settled = false;
    let connectTimer = null;
    let idleTimer = null;
    let retryTimer = null;
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
      // 再試行の待機タイマーも同じ場所で畳む。クライアント切断・タイムアウトで
      // finish() が確定した後に待機が明けて、宛先のいない接続を開かないようにする。
      clearTimeout(retryTimer);
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
      // 要求ごとに張ったリスナーを解放する（req/res はこの後も生き得る）。
      // 二重発火は settled が防ぐので挙動は変わらない。解放そのものが目的。
      req.off?.('aborted', onClientGone);
      res.off?.('close', onResponseClose);
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
    const onResponseClose = () => {
      if (!res.writableEnded) onClientGone();
    };
    req.on('aborted', onClientGone);
    res.on('close', onResponseClose);

    const attemptConnect = attempt => {
      // この試行を捨てたら true。捨てた後に遅れて届くイベント（error・socket・
      // information・finish）から、次の試行を生やしたりタイマーを張り直したりしない。
      let attemptAbandoned = false;
      // この試行で TCP 接続が確立したか。再試行してよいのは「一度も接続できなかった」
      // ときだけなので、'finish'（requestFullySent）とは別にここを明示して追う。
      // requestFullySent だけを見る旧実装では、接続が確立した後・'finish' の前に
      // 起きた失敗を「未送信」と誤認して再送し得た。
      let connectionEstablished = false;
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
          let decision = metaEnabled
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
          // ── R7-1（母艦裁定 D-72）: 認証失効の 403 だけは 529 へ書き換える ──
          // 上の判定（529→403）とは入力が排他である（片方は 529 だけを、こちらは 403
          // だけを見る）ので、先に決まっていなければ評価する、という順序で足りる。
          // 応答の作り替え手順は下の decision.rewrite の分岐をそのまま使う。
          if (metaEnabled && !decision.rewrite) {
            const authDecision = decideAuthDegradeRewrite(contract, {
              enabled: true,
              upstreamStatus: upstreamRes.statusCode,
            });
            if (authDecision.rewrite) decision = authDecision;
          }
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
      upstream.once('finish', () => {
        if (attemptAbandoned) return; // 捨てた試行の遅れた 'finish' で次の試行を縛らない
        requestFullySent = true;
      });

      // 非 SSE 要求の生存通知（契約 §C4.6）。非ストリーミング応答には SSE の開始マーカーに
      // 相当する「流すもの」が無いため、bridge が上流の応答ヘッダを待っている間は rotator へ
      // 1バイトも届かず、長考がアイドル判定を超えた時点で 403 を合成してしまう。bridge が
      // 周期送出する 102 Processing を「bridge は生きている」の合図として受け取り、
      // アイドルタイマーだけを再武装する。
      //   - 下流へは転送しない（消費するだけ）。res へ1バイトも書かないので、Claude Code
      //     から見た応答は 102 が無かった場合とバイト単位で同一であり、res.headersSent も
      //     偽のままなので後から 403 を合成する能力・529→403 の書換も保たれる。
      //   - 最終ステータス・outcome・ログ書式・設定キーはいずれも変えない（ログ行も足さない）。
      //   - 101 Switching Protocols は対象外（Node の 'information' も 101 では発火しない）。
      //   - connectTimer には触れない。接続確立の計測は socket の 'connect' だけが閉じる
      //     ので、TCP 接続前の判定はこの再武装の影響を受けない。
      //   - 102 が1つも来なければ従来どおり bridge-idle-timeout で切る（無応答の検出能力は不変）。
      upstream.on('information', info => {
        const informationalStatus = Number(info?.statusCode);
        if (!Number.isInteger(informationalStatus)) return;
        if (informationalStatus < 100 || informationalStatus > 199 || informationalStatus === 101) return;
        // settled 後に武装すると、誰も止めないタイマーが後から destroy() を撃つ。
        // 捨てた試行から遅れて届いた 102 も同じ（現行の試行のタイマーを乱さない）。
        if (settled || attemptAbandoned || res.destroyed) return;
        armIdleTimer();
      });

      // 接続確立前のタイムアウト（403 permission_error・outcome=bridge-connect-timeout）。
      // 接続拒否・DNS 失敗（bridge-unreachable）とは意味が違う——ポートは開いているのに
      // 受け付けられていない状態を指す（設計書 §9.4）。
      // TCP の接続確立（socket の 'connect'）が起きるまでだけを計測する。確立後は
      // ヘッダ待ち・チャンク間の無応答を問わずすべて idleTimer の責務にする。
      // 再試行が有効なときは、この待ちも「接続前の締切」の内側に収める。試行ごとに
      // connectTimeoutMs を丸ごと付け直すと、再試行のたびに予算が伸びてしまうため。
      // 再試行が無効（既定）なら remaining は null で、現行と同じ値をそのまま使う。
      const remainingBudgetMs = remainingConnectBudgetMs();
      const connectTimeoutMs = remainingBudgetMs === null
        ? settings.connectTimeoutMs
        : Math.max(0, Math.min(settings.connectTimeoutMs, remainingBudgetMs));
      connectTimer = setTimeout(() => {
        upstream.destroy();
        sendSynthetic(res, 'connect timeout');
        finish('bridge-connect-timeout', BRIDGE_UNREACHABLE_STATUS, logMeta('bridge-connect-timeout'));
      }, connectTimeoutMs);

      upstream.once('socket', socket => {
        const onConnected = () => {
          if (attemptAbandoned || settled) return;
          connectionEstablished = true;
          clearTimeout(connectTimer);
          // 接続確立後はヘッダ待ちもアイドル判定に含める。
          armIdleTimer();
        };
        // 「まだ接続の途中である」と積極的に判定できるときだけ 'connect' を待つ。
        // それ以外は接続済みとして扱い、再送の根拠にしない（保守側へ倒す）:
        //   - keep-alive の使い回し（最初から connecting=false）
        //   - 状態を確かめられないソケット（connecting が真偽値でない・socket が無い）
        //   - TLS（https）のソケット。TCP の 'connect' は TLS ハンドシェイクより先に
        //     発火するので、そこで「接続済み」とみなすのが保守的な扱いになる。
        //     （settings.url はループバック http に限定されるため実運用の経路には現れない）
        if (socket?.connecting === true) socket.once('connect', onConnected);
        else onConnected();
      });

      upstream.on('error', error => {
        // finish() 確定後（クライアント切断・タイムアウト等で既に処理済み）に
        // 発火した 'error'（例: destroy() 由来の ECONNRESET/socket hang up）は
        // 無視する。res 相手が既にいない状態で再試行・応答書込みを行わない。
        if (settled) return;
        // 捨てた試行から遅れて届いた 'error'（destroy() 由来の重複など）。現行の試行は
        // 別にあるので、ここから再試行も応答書込みもしない。
        if (attemptAbandoned) return;
        // ヘッダ送出後は新しいステータスを返せない（仕様書 4.2.3 節）。応答は既に
        // 始まっていて上流側で壊れたのだから、不達ではなくストリーム障害である（§9.4）。
        if (res.headersSent) {
          res.destroy();
          finish('bridge-stream-error', null, logMeta('bridge-stream-error', errorLogFields(error)));
          return;
        }
        // 再試行してよいのは、次の3つがすべて成り立つときだけである。
        //   ① TCP 接続が一度も確立していない（connectionEstablished===false）
        //   ② リクエスト全体の送信が完了していない（requestFullySent===false）
        //   ③ エラーが ECONNREFUSED（＝相手がポートを開いていない＝本文は渡っていない）
        // ①②のどちらかでも崩れると、本文が bridge に届いている可能性があり、再送は
        // 二重送信（Pro 枠の二重消費）になり得る。①は②より早く真になるため、
        // 'finish' 前でも接続後は再送しない（旧実装はここを塞げていなかった）。
        const canRetry = !connectionEstablished
          && !requestFullySent
          && RETRYABLE_CONNECT_ERROR_CODES.has(error?.code);
        const plan = canRetry
          ? planConnectRetry({ attempt, retries: connectRetries, elapsedMs: Date.now() - startedAt })
          : { retry: false, delayMs: CONNECT_RETRY_DELAY_MS };
        if (plan.retry) {
          attemptAbandoned = true;
          clearTimers();
          logger?.(
            `${new Date().toISOString()} openai-bridge model=${model || '-'} method=${req.method} `
            + `path=${target.pathname} outcome=connect-retry attempt=${attempt + 1} code=${error?.code || '-'}`,
          );
          // 即時ではなく一定時間待ってから開き直す。待機中にクライアントが切れたら
          // clearTimers()（finish 経由）がこのタイマーごと畳む。
          retryTimer = setTimeout(() => {
            if (settled) return;
            // 待機 callback は、イベントループが詰まれば要求した時刻より後に走る。
            // 予約時点（planConnectRetry）の判断だけを信じて開くと、締切を過ぎてから
            // 新しい接続を開き、その試行にまた connect タイムアウトが付いて予算を超える。
            // 残予算が尽きていたら開かずに、1回目の失敗と同じ形で打ち切る。
            const leftMs = remainingConnectBudgetMs();
            if (leftMs !== null && leftMs <= 0) {
              sendSynthetic(res, 'connection refused');
              finish('bridge-unreachable', BRIDGE_UNREACHABLE_STATUS, logMeta('bridge-unreachable', errorLogFields(error)));
              return;
            }
            attemptConnect(attempt + 1);
          }, plan.delayMs);
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
