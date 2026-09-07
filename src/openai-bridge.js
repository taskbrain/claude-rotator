import http from 'node:http';

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

function disabled(raw, warning) {
  return {
    enabled: false,
    url: raw.url,
    modelPattern: null,
    connectTimeoutMs: raw.connectTimeoutMs,
    idleTimeoutMs: raw.idleTimeoutMs,
    connectRetries: raw.connectRetries,
    warning,
  };
}

export function resolveOpenAiBridgeSettings(config) {
  const raw = { ...DEFAULT_OPENAI_BRIDGE, ...(config?.openaiBridge || {}) };
  if (!raw.enabled) return disabled(raw, null);
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
    // 無効時は body を一切パースしない（レビュー指摘8: 無駄なパースを避ける早期return）。
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
// そのまま settings.url へ渡すと接続先ホストが req.url 側に乗っ取られる（レビュー指摘3）。
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

// 本文送信前（＝bridge からの応答を一切受け取っていない）の接続確立失敗に限り再試行する。
// 応答を受け取った後（res.headersSent === true）に再試行すると、二重処理のリスクが生まれる。
const RETRYABLE_CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']);

export function forwardToOpenAiBridge({ req, res, body, model, settings, logger, httpRequestImpl = http.request }) {
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
    // 再試行すると二重送信（Pro枠の二重消費）になり得るため再試行しない
    // （レビュー再検証指摘1）。接続確立直後（'connect'）に即座に切断された場合は
    // 通常 'finish' が間に合わず立たないため、既存の「接続直後リセット」再試行
    // （レビュー指摘2）は引き続き機能する。
    let requestFullySent = false;

    const clearTimers = () => {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
    };

    const finish = (outcome, status) => {
      if (settled) return;
      settled = true;
      clearTimers();
      logger?.(
        `${new Date().toISOString()} openai-bridge model=${model || '-'} method=${req.method} `
        + `path=${target.pathname} status=${status ?? '-'} durationMs=${Date.now() - startedAt} outcome=${outcome}`,
      );
      resolve({ outcome, status: status ?? null });
    };

    // アイドルタイムアウト（403 permission_error・outcome=bridge-timeout 側）。
    // 接続確立の直後（ヘッダ待ち）から、以後の各チャンク受信のたびに再武装する。
    // 「接続はできたが応答が全く無い」場合もこの一本のタイマーだけで検出できる
    // （connect の成否だけを見る connectTimer とは責務を分ける）。
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        currentUpstream?.destroy();
        const willSend = !res.headersSent;
        if (willSend) sendSynthetic(res, 'idle timeout');
        else res.destroy();
        finish('bridge-timeout', willSend ? BRIDGE_UNREACHABLE_STATUS : null);
      }, settings.idleTimeoutMs);
    };

    // クライアント切断の検出。readBody() で本文を読み切ってから forward するため
    // （src/proxy-server.js）、この時点で req は既に complete===true になっており
    // 'aborted' はもう発火しない（レビュー指摘1）。res 側の 'close'
    // （クライアントが切断し、かつまだ res.end() していない場合に発火する）で検出する。
    const onClientGone = () => {
      currentUpstream?.destroy();
      finish('client-abort', null);
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
          // ECONNRESET を避ける（レビュー指摘2）。new http.Agent() を毎回生成すると
          // ソケットプールが個別に残り続けるため、Node 標準の「プールしない」指定
          // である agent:false を使う（レビュー再検証指摘4）。
          agent: false,
        },
        upstreamRes => {
          if (res.destroyed) {
            upstream.destroy();
            return;
          }
          // ヘッダを受け取った時点で「アイドル」の窓を仕切り直す
          // （res.destroyed ガードの後ろに置き、切断済みクライアント宛にタイマーを
          // 張ったまま宙に浮かせない。レビュー再検証指摘3）。
          armIdleTimer();
          const responseHeaders = {};
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
          }
          res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
          // SSE の逐次透過: 受け取り次第そのまま書き出す（バッファリングしない）。
          // クライアントが既に切断済みなら書き込まず upstream も畳む。res.write() が
          // false（バックプレッシャ）を返したら upstream を一時停止し、drain で再開する
          // （レビュー指摘7）。
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
            finish('forwarded', upstreamRes.statusCode || 200);
          });
          upstreamRes.on('error', () => {
            clearTimers();
            res.destroy();
            finish('bridge-timeout', null);
          });
        },
      );
      currentUpstream = upstream;
      upstream.once('finish', () => { requestFullySent = true; });

      // 接続確立前のタイムアウト（403 permission_error・outcome=bridge-unreachable 側）。
      // TCP の接続確立（socket の 'connect'）が起きるまでだけを計測する。確立後は
      // ヘッダ待ち・チャンク間の無応答を問わずすべて idleTimer の責務にする。
      connectTimer = setTimeout(() => {
        upstream.destroy();
        sendSynthetic(res, 'connect timeout');
        finish('bridge-unreachable', BRIDGE_UNREACHABLE_STATUS);
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
        // 無視する。res 相手が既にいない状態で再試行・応答書込みを行わない
        // （レビュー再検証指摘2）。
        if (settled) return;
        // ヘッダ送出後は新しいステータスを返せない（仕様書 4.2.3 節）
        if (res.headersSent) {
          res.destroy();
          finish('bridge-unreachable', null);
          return;
        }
        // まだ bridge からの応答を何も受け取っておらず、かつリクエスト全体（本文含む）
        // の送信が完了していない場合に限り settings.connectRetries まで再試行する
        // （レビュー指摘2・再検証指摘1）。requestFullySent===true の場合、本文は
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
        sendSynthetic(res, 'connection refused');
        finish('bridge-unreachable', BRIDGE_UNREACHABLE_STATUS);
      });

      upstream.end(body);
    };

    attemptConnect(1);
  });
}
