import http from 'node:http';
import https from 'node:https';

import { readCurrentClaudeCredentials } from './claude-credentials.js';
import { isTokenExpiringSoon, refreshAccessToken } from './oauth.js';

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 180000;
const DEFAULT_RETRYABLE_UPSTREAM_HOLD_SECONDS = 30;

export function createProxyServer({
  accountManager,
  secretStore,
  config,
  reloadAccounts = null,
  tokenRefresher = refreshAccessToken,
  currentCredentialReader = readCurrentClaudeCredentials,
  logger = null,
}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const upstreamIdleTimeoutMs = config.proxy?.upstreamIdleTimeoutMs
    ?? config.upstreamIdleTimeoutMs
    ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const retryableUpstreamHoldSeconds = config.proxy?.retryableUpstreamHoldSeconds
    ?? config.retryableUpstreamHoldSeconds
    ?? DEFAULT_RETRYABLE_UPSTREAM_HOLD_SECONDS;

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/internal/health') {
        sendJson(res, 200, {
          ok: true,
          currentAccount: accountManager.getStatus().currentAccount,
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/internal/status') {
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/switch') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        accountManager.switchTo(body.account);
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/reload') {
        if (reloadAccounts) {
          const accounts = await reloadAccounts();
          accountManager.replaceAccounts(accounts);
        }
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      const body = await readBody(req);
      await forwardWithRotation({
        req,
        res,
        body,
        upstream,
        accountManager,
        secretStore,
        tokenRefresher,
        currentCredentialReader,
        logger,
        upstreamIdleTimeoutMs,
        retryableUpstreamHoldSeconds,
      });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message: error.message },
        });
      } else {
        res.destroy(error);
      }
    }
  });
}

async function forwardWithRotation({
  req,
  res,
  body,
  upstream,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  logger,
  upstreamIdleTimeoutMs,
  retryableUpstreamHoldSeconds,
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);
  let lastRetryableResponse = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = accountManager.getActiveAccount();
    if (!account) {
      if (await forwardCurrentUnavailableAccount({
        req,
        res,
        body,
        upstream,
        accountManager,
        secretStore,
        tokenRefresher,
        currentCredentialReader,
        logger,
        upstreamIdleTimeoutMs,
        retryableUpstreamHoldSeconds,
      })) return;
      sendUnavailableAccounts(res);
      return;
    }

    const secret = await resolveSecretForAccount({ account, secretStore, currentCredentialReader });
    if (!secret) {
      accountManager.markError(account.id, 'credential_missing', 'No stored credential for account');
      continue;
    }

    let freshSecret;
    try {
      freshSecret = await refreshSecretIfExpiring({
        account,
        secret,
        secretStore,
        tokenRefresher,
      });
    } catch {
      accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
      continue;
    }

    const result = await forwardOnce({
      req,
      res,
      body,
      upstream,
      account,
      secret: freshSecret,
      accountManager,
      logger,
      upstreamIdleTimeoutMs,
      retryableUpstreamHoldSeconds,
    });
    if (result.retryAfterRefresh) {
      let refreshedSecret;
      try {
        refreshedSecret = await refreshAndStoreSecret({
          account,
          secret: freshSecret,
          secretStore,
          tokenRefresher,
        });
      } catch {
        accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        continue;
      }
      const retryResult = await forwardOnce({
        req,
        res,
        body,
        upstream,
        account,
        secret: refreshedSecret,
        accountManager,
        logger,
        upstreamIdleTimeoutMs,
        retryableUpstreamHoldSeconds,
      });
      if (retryResult.retryAfterRefresh) {
        accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
        continue;
      }
      if (retryResult.retryNextAccount) {
        lastRetryableResponse = retryResult.passthroughResponse || retryResult.syntheticResponse || lastRetryableResponse;
        continue;
      }
      return;
    }
    if (result.retryNextAccount) {
      lastRetryableResponse = result.passthroughResponse || result.syntheticResponse || lastRetryableResponse;
      continue;
    }
    return;
  }

  if (!res.headersSent) {
    if (lastRetryableResponse) {
      sendBufferedResponse(res, lastRetryableResponse);
      return;
    }
    if (await forwardCurrentUnavailableAccount({
      req,
      res,
      body,
      upstream,
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      logger,
      upstreamIdleTimeoutMs,
      retryableUpstreamHoldSeconds,
    })) return;
    sendUnavailableAccounts(res);
  }
}

async function forwardCurrentUnavailableAccount({
  req,
  res,
  body,
  upstream,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  logger,
  upstreamIdleTimeoutMs,
  retryableUpstreamHoldSeconds,
}) {
  const account = accountManager.getFallbackAccount();
  if (!account) return false;

  const secret = await resolveSecretForAccount({ account, secretStore, currentCredentialReader });
  if (!secret) return false;

  let freshSecret;
  try {
    freshSecret = await refreshSecretIfExpiring({
      account,
      secret,
      secretStore,
      tokenRefresher,
    });
  } catch {
    freshSecret = secret;
  }

  await forwardOnce({
    req,
    res,
    body,
    upstream,
    account,
    secret: freshSecret,
    accountManager,
    passthroughErrors: true,
    logger,
    upstreamIdleTimeoutMs,
    retryableUpstreamHoldSeconds,
  });
  return true;
}

async function refreshSecretIfExpiring({ account, secret, secretStore, tokenRefresher }) {
  if (!canRefreshSecret(account, secret)) return secret;
  if (!isTokenExpiringSoon(secret.expiresAt)) return secret;
  return refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher });
}

async function refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher }) {
  const refreshed = await tokenRefresher(secret.refreshToken);
  const nextSecret = { ...secret, ...refreshed };
  await secretStore.set(account.id, nextSecret);
  return nextSecret;
}

function canRefreshSecret(account, secret) {
  if (secret.liveClaudeCodeCredential) return false;
  return account.type !== 'apikey' && !secret.apiKey && Boolean(secret.refreshToken);
}

async function resolveSecretForAccount({ account, secretStore, currentCredentialReader }) {
  if (account.id === 'current' && account.type !== 'apikey') {
    return {
      ...(await currentCredentialReader()),
      liveClaudeCodeCredential: true,
    };
  }
  return secretStore.get(account.id);
}

async function forwardOnce({
  req,
  res,
  body,
  upstream,
  account,
  secret,
  accountManager,
  passthroughErrors = false,
  logger = null,
  upstreamIdleTimeoutMs,
  retryableUpstreamHoldSeconds,
}) {
  const target = new URL(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret);
  const startedAt = Date.now();
  let outcome = 'ok';

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstream({
      target,
      method: req.method,
      headers,
      body,
      idleTimeoutMs: upstreamIdleTimeoutMs,
      onResponse(upstreamRes) {
        accountManager.updateQuota(account.id, upstreamRes.headers);

        if (!passthroughErrors && upstreamRes.statusCode === 429) {
          outcome = 'rate-limit-retry';
          const unavailableReason = accountManager.unavailableReason(account);
          if (unavailableReason?.type !== 'quota_exhausted') {
            accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamRes.headers, 60));
          }
          return false;
        }

        if (!passthroughErrors && upstreamRes.statusCode === 401 && canRefreshSecret(account, secret)) {
          outcome = 'auth-refresh-retry';
          return false;
        }

        if (!passthroughErrors && isRetryableServerError(upstreamRes.statusCode, upstreamRes.headers)) {
          outcome = 'upstream-retry';
          accountManager.markTemporaryUnavailable(
            account.id,
            retryAfterSeconds(upstreamRes.headers, retryableUpstreamHoldSeconds),
            {
              type: 'temporary_upstream_error',
              statusCode: upstreamRes.statusCode,
              message: 'Retryable upstream server error',
            },
          );
          return false;
        }

        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!HOP_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
        }
        res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
        return true;
      },
      onChunk(chunk) {
        if (!res.destroyed) res.write(chunk);
      },
    });
  } catch (error) {
    outcome = isUpstreamTimeout(error) ? 'upstream-timeout' : 'upstream-error';
    recordProxyRequest({
      accountManager,
      logger,
      account,
      method: req.method,
      path: target.pathname,
      outcome,
      durationMs: Date.now() - startedAt,
      errorType: error.code || error.name,
    });

    if (!passthroughErrors && !res.headersSent) {
      const reasonType = isUpstreamTimeout(error)
        ? 'temporary_upstream_timeout'
        : 'temporary_upstream_error';
      accountManager.markTemporaryUnavailable(
        account.id,
        retryableUpstreamHoldSeconds,
        {
          type: reasonType,
          message: error.message,
        },
      );
      return {
        retryNextAccount: true,
        syntheticResponse: syntheticUpstreamErrorResponse(error),
      };
    }
    throw error;
  }

  recordProxyRequest({
    accountManager,
    logger,
    account,
    method: req.method,
    path: target.pathname,
    statusCode: upstreamResponse.statusCode,
    requestId: headerValue(upstreamResponse.headers['request-id'])
      || headerValue(upstreamResponse.headers['x-request-id']),
    outcome: outcomeForResponse(outcome, upstreamResponse.statusCode),
    durationMs: Date.now() - startedAt,
  });

  if (!passthroughErrors && upstreamResponse.statusCode === 429) {
    return { retryNextAccount: true, passthroughResponse: upstreamResponse };
  }

  if (!passthroughErrors && upstreamResponse.statusCode === 401 && canRefreshSecret(account, secret)) {
    return { retryAfterRefresh: true };
  }

  if (!passthroughErrors && outcome === 'upstream-retry') {
    return { retryNextAccount: true, passthroughResponse: upstreamResponse };
  }

  if (upstreamResponse.body.length > 0) {
    extractUsage(upstreamResponse.body, account.id, accountManager);
  }

  if (!res.writableEnded) res.end();
  return { retryNextAccount: false };
}

function buildUpstreamHeaders(inputHeaders, account, secret) {
  const headers = {};
  for (const [key, value] of Object.entries(inputHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (lower === 'x-api-key' || lower === 'authorization') continue;
    headers[key] = value;
  }

  if (account.type === 'apikey') {
    headers['x-api-key'] = secret.apiKey;
  } else {
    headers.authorization = `Bearer ${secret.accessToken}`;
  }
  return headers;
}

function requestUpstream({ target, method, headers, body, idleTimeoutMs, onResponse, onChunk }) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, upstreamRes => {
      const shouldStream = onResponse(upstreamRes);
      const chunks = [];
      upstreamRes.on('data', chunk => {
        chunks.push(chunk);
        if (shouldStream) onChunk(chunk);
      });
      upstreamRes.on('end', () => {
        settle(null, {
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
      upstreamRes.on('aborted', () => {
        const error = new Error('Upstream response aborted');
        error.code = 'UPSTREAM_RESPONSE_ABORTED';
        settle(error);
      });
      upstreamRes.on('error', settle);
    });
    if (idleTimeoutMs > 0) {
      req.setTimeout(idleTimeoutMs, () => {
        const error = new Error(`Upstream request idle timeout after ${idleTimeoutMs}ms`);
        error.code = 'UPSTREAM_IDLE_TIMEOUT';
        req.destroy(error);
      });
    }
    req.on('error', settle);
    if (!['GET', 'HEAD'].includes(method) && body.length > 0) req.write(body);
    req.end();
  });
}

function isRetryableServerError(statusCode, headers = {}) {
  if (truthyHeader(headers['x-should-retry'])) return true;
  return [500, 502, 503, 504, 529].includes(statusCode);
}

function retryAfterSeconds(headers = {}, fallbackSeconds) {
  const parsed = Number.parseInt(headerValue(headers['retry-after']), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackSeconds;
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0];
  return value == null ? null : String(value);
}

function truthyHeader(value) {
  const normalized = headerValue(value)?.toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function isUpstreamTimeout(error) {
  return error?.code === 'UPSTREAM_IDLE_TIMEOUT';
}

function outcomeForResponse(outcome, statusCode) {
  if (outcome !== 'ok') return outcome;
  if (statusCode >= 500) return 'upstream-error-passthrough';
  if (statusCode >= 400) return 'client-error-passthrough';
  return 'ok';
}

function recordProxyRequest({
  accountManager,
  logger,
  account,
  method,
  path,
  statusCode = null,
  requestId = null,
  outcome,
  durationMs,
  errorType = null,
}) {
  const event = accountManager.recordProxyRequest({
    account: account.id,
    method,
    path,
    statusCode,
    requestId,
    outcome,
    durationMs,
    errorType,
  });
  writeProxyLog(logger, event);
}

function writeProxyLog(logger, event) {
  if (!logger) return;
  const fields = [
    `${event.at} proxy`,
    `account=${event.account}`,
    `method=${event.method}`,
    `path=${event.path}`,
    `status=${event.statusCode ?? '-'}`,
    `durationMs=${event.durationMs}`,
    `outcome=${event.outcome}`,
  ];
  if (event.requestId) fields.push(`requestId=${event.requestId}`);
  if (event.errorType) fields.push(`errorType=${event.errorType}`);
  logger(fields.join(' '));
}

function syntheticUpstreamErrorResponse(error) {
  const statusCode = isUpstreamTimeout(error) ? 504 : 502;
  const type = isUpstreamTimeout(error) ? 'upstream_timeout' : 'upstream_error';
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type,
        message: error.message,
      },
    })),
  };
}

function sendBufferedResponse(res, response) {
  const headers = {};
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (!HOP_HEADERS.has(key.toLowerCase())) headers[key] = value;
  }
  res.writeHead(response.statusCode || 502, headers);
  res.end(response.body || Buffer.alloc(0));
}

function extractUsage(body, accountId, accountManager) {
  const text = body.toString('utf8');
  try {
    const json = JSON.parse(text);
    if (json.usage) {
      accountManager.updateUsage(accountId, {
        inputTokens: json.usage.input_tokens || 0,
        outputTokens: json.usage.output_tokens || 0,
      });
    }
    return;
  } catch {
    // Continue with SSE parsing.
  }

  for (const event of text.split('\n\n')) {
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === 'message_start' && data.message?.usage) {
        accountManager.updateUsage(accountId, {
          inputTokens: data.message.usage.input_tokens || 0,
        });
      } else if (data.type === 'message_delta' && data.usage) {
        accountManager.updateUsage(accountId, {
          outputTokens: data.usage.output_tokens || 0,
        });
      }
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendUnavailableAccounts(res) {
  sendJson(res, 429, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'All configured accounts are unavailable.' },
  });
}
