import http from 'node:http';
import https from 'node:https';

import { isUnifiedQuotaExhaustion } from './account-manager.js';
import { readCurrentClaudeCredentials } from './claude-credentials.js';
import { fetchUsage, isTokenExpiringSoon, refreshAccessToken } from './oauth.js';

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
const DEFAULT_RESET_CHECK_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createProxyServer({
  accountManager,
  secretStore,
  config,
  reloadAccounts = null,
  tokenRefresher = refreshAccessToken,
  currentCredentialReader = readCurrentClaudeCredentials,
  usageFetcher = fetchUsage,
  logger = null,
}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const upstreamIdleTimeoutMs = config.proxy?.upstreamIdleTimeoutMs
    ?? config.upstreamIdleTimeoutMs
    ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;

  const usageRefresher = createUsageRefresher({
    accountManager,
    secretStore,
    tokenRefresher,
    currentCredentialReader,
    usageFetcher,
  });
  const usageScheduler = createUsageRefreshScheduler({
    config,
    usageRefresher,
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/internal/health') {
        sendJson(res, 200, {
          ok: true,
          currentAccount: accountManager.getStatus().currentAccount,
        });
        return;
      }

      if (req.method === 'GET' && req.url === '/internal/status') {
        if (usagePollingEnabled(config) && !usageScheduler.hasAttempted()) {
          await usageScheduler.refreshNow();
        }
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
        if (usagePollingEnabled(config)) await usageScheduler.refreshNow();
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/refresh-usage') {
        sendJson(res, 200, await usageScheduler.refreshNow());
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

  usageScheduler.start(server);
  return server;
}

function usagePollingEnabled(config) {
  return config.usagePolling?.enabled === true;
}

function createUsageRefreshScheduler({ config, usageRefresher, now = () => Date.now() }) {
  let timer = null;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const scheduleFromStatus = status => {
    if (!usagePollingEnabled(config)) return;
    stop();
    const delayMs = nextUsageRefreshDelay(status, config, now());
    if (delayMs == null) return;
    timer = setTimeout(() => {
      timer = null;
      refreshNow().catch(() => {
        scheduleFromStatus(null);
      });
    }, delayMs);
    timer.unref?.();
  };

  const refreshNow = async () => {
    const result = await usageRefresher.refreshAll();
    scheduleFromStatus(result.status);
    return result;
  };

  const start = server => {
    if (!usagePollingEnabled(config)) return;
    refreshNow().catch(() => {
      scheduleFromStatus(null);
    });
    server.on('close', stop);
  };

  return {
    start,
    refreshNow,
    hasAttempted: usageRefresher.hasAttempted,
  };
}

function nextUsageRefreshDelay(status, config, nowMs) {
  const resetCheckDelayMs = Number(config.usagePolling?.resetCheckDelayMs) || DEFAULT_RESET_CHECK_DELAY_MS;
  const resetAt = nextExhaustedQuotaResetAt(status);
  if (resetAt != null) {
    return clampTimerDelay(Math.max(0, resetAt - nowMs) + resetCheckDelayMs);
  }
  return null;
}

function nextExhaustedQuotaResetAt(status) {
  const resetTimes = [];
  for (const account of status?.accounts || []) {
    const reason = account.unavailableReason;
    if (!isUnifiedQuotaExhaustion(reason) || !reason.resetAt) continue;
    const resetAt = Date.parse(reason.resetAt);
    if (Number.isFinite(resetAt)) resetTimes.push(resetAt);
  }
  if (resetTimes.length === 0) return null;
  return Math.min(...resetTimes);
}

function clampTimerDelay(delayMs) {
  if (!Number.isFinite(delayMs)) return DEFAULT_RESET_CHECK_DELAY_MS;
  return Math.max(0, Math.min(delayMs, MAX_TIMER_DELAY_MS));
}

function createUsageRefresher({
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  usageFetcher,
}) {
  let inFlight = null;
  let attempted = false;
  const refreshAll = async () => {
    if (inFlight) return inFlight;
    inFlight = refreshAllOnce({
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      usageFetcher,
    }).finally(() => {
      attempted = true;
      inFlight = null;
    });
    return inFlight;
  };
  return {
    refreshAll,
    hasAttempted: () => attempted,
  };
}

async function refreshAllOnce({
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  usageFetcher,
}) {
  const results = [];
  for (const account of accountManager.accounts) {
    if (account.type === 'apikey') {
      results.push({ account: account.id, ok: true, skipped: 'apikey' });
      continue;
    }

    try {
      const secret = await resolveSecretForAccount({ account, secretStore, currentCredentialReader });
      if (!secret?.accessToken) throw new Error('OAuth access token is missing');
      const freshSecret = await refreshSecretIfExpiring({
        account,
        secret,
        secretStore,
        tokenRefresher,
      });
      const usage = await usageFetcher(freshSecret.accessToken);
      accountManager.applyUsage(account.id, usage);
      results.push({ account: account.id, ok: true });
    } catch (caught) {
      results.push({
        account: account.id,
        ok: false,
        error: shortErrorMessage(caught),
      });
    }
  }
  rebalanceAfterUsageRefresh(accountManager);
  return {
    ok: results.every(result => result.ok),
    refreshedAt: new Date().toISOString(),
    accounts: results,
    status: accountManager.getStatus(),
  };
}

function rebalanceAfterUsageRefresh(accountManager) {
  const current = accountManager.getCurrentAccount();
  if (!isUnifiedQuotaExhaustion(accountManager.unavailableReason(current))) return;
  if (!accountManager.getActiveAccount()) accountManager.getFallbackAccount();
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
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);
  let lastRetryableResponse = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = accountManager.getActiveAccount();
    if (!account) {
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
          const unavailableReason = accountManager.unavailableReason(account);
          if (isUnifiedQuotaExhaustion(unavailableReason)) {
            outcome = 'quota-retry';
            return false;
          }
          outcome = 'rate-limit-passthrough';
          if (!unavailableReason) {
            accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamRes.headers, 60));
          }
        }

        if (!passthroughErrors && upstreamRes.statusCode === 401) {
          if (canRefreshSecret(account, secret)) {
            outcome = 'auth-refresh-retry';
            return false;
          } else {
            outcome = 'auth-account-passthrough';
            accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
          }
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
      sendBufferedResponse(res, syntheticUpstreamErrorResponse(error));
      return { retryNextAccount: false };
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

  if (!passthroughErrors && outcome === 'quota-retry') {
    return { retryNextAccount: true, passthroughResponse: upstreamResponse };
  }

  if (!passthroughErrors && upstreamResponse.statusCode === 401) {
    if (canRefreshSecret(account, secret)) return { retryAfterRefresh: true };
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

function retryAfterSeconds(headers = {}, fallbackSeconds) {
  const parsed = Number.parseInt(headerValue(headers['retry-after']), 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallbackSeconds;
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0];
  return value == null ? null : String(value);
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

function shortErrorMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 240);
}
