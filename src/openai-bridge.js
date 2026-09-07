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
  // parsed は1回だけパースして呼び出し側へ返す（body を再パースしない。仕様書 4.2.2 節 a）
  const parsed = safeParseBody(body);
  if (!settings?.enabled) {
    // fail-safe（仕様書 4.2.2 節 b）で無効化された場合は 'parse-error' として記録し、
    // 設定どおりの通常オフ（'disabled'）と区別する（呼び出し側のログ outcome=parse-error-fallback）。
    return { route: false, model: null, reason: settings?.warning ? 'parse-error' : 'disabled', parsed };
  }
  const model = typeof parsed?.model === 'string' ? parsed.model : null;
  if (!model) return { route: false, model: null, reason: 'parse-error', parsed };
  if (!settings.modelPattern.test(model)) return { route: false, model, reason: 'no-match', parsed };
  return { route: true, model, reason: 'match', parsed };
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

export function forwardToOpenAiBridge({ req, res, body, model, settings, logger, httpRequestImpl = http.request }) {
  const startedAt = Date.now();
  const target = new URL(req.url, settings.url);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value; // Authorization/x-api-key は素通し
  }
  headers['content-length'] = String(Buffer.byteLength(body || Buffer.alloc(0)));

  return new Promise(resolve => {
    let settled = false;
    let connectTimer = null;
    let idleTimer = null;

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
        upstream.destroy();
        if (!res.headersSent) sendSynthetic(res, 'idle timeout');
        else res.destroy();
        finish('bridge-timeout', res.headersSent ? null : BRIDGE_UNREACHABLE_STATUS);
      }, settings.idleTimeoutMs);
    };

    const upstream = httpRequestImpl(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      upstreamRes => {
        // ヘッダを受け取った時点で「アイドル」の窓を仕切り直す。
        armIdleTimer();
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders[key] = value;
        }
        res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
        // SSE の逐次透過: 受け取り次第そのまま書き出す（バッファリングしない）
        upstreamRes.on('data', chunk => {
          armIdleTimer();
          res.write(chunk);
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

    // 接続確立前のタイムアウト（403 permission_error・outcome=bridge-unreachable 側）。
    // TCP の接続確立（socket の 'connect'）が起きるまでだけを計測する。確立後は
    // ヘッダ待ち・チャンク間の無応答を問わずすべて idleTimer の責務にする。
    // settings.connectRetries が 1 以上でも、まだ何も送っていないため再試行して
    // 二重処理のリスクは無い（仕様書 4.4.5 節）。既定は0回のため再試行しない。
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

    upstream.on('error', () => {
      // ヘッダ送出後は新しいステータスを返せない（仕様書 4.2.3 節）
      if (res.headersSent) {
        res.destroy();
        finish('bridge-unreachable', null);
        return;
      }
      sendSynthetic(res, 'connection refused');
      finish('bridge-unreachable', BRIDGE_UNREACHABLE_STATUS);
    });

    // クライアント abort の伝播
    req.on('aborted', () => {
      upstream.destroy();
      finish('client-abort', null);
    });

    upstream.end(body);
  });
}
