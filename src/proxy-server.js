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

export function createProxyServer({
  accountManager,
  secretStore,
  config,
  reloadAccounts = null,
  tokenRefresher = refreshAccessToken,
  currentCredentialReader = readCurrentClaudeCredentials,
}) {
  const upstream = config.upstream || 'https://api.anthropic.com';

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
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);

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
      });
      if (retryResult.retryNextAccount || retryResult.retryAfterRefresh) {
        accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
        continue;
      }
      return;
    }
    if (result.retryNextAccount) continue;
    return;
  }

  if (!res.headersSent) {
    if (await forwardCurrentUnavailableAccount({
      req,
      res,
      body,
      upstream,
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
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
}) {
  const account = accountManager.getCurrentAccount();
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
}) {
  const target = new URL(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret);

  const upstreamResponse = await requestUpstream({
    target,
    method: req.method,
    headers,
    body,
    onResponse(upstreamRes) {
      accountManager.updateQuota(account.id, upstreamRes.headers);

      if (!passthroughErrors && upstreamRes.statusCode === 429) {
        const unavailableReason = accountManager.unavailableReason(account);
        if (unavailableReason?.type !== 'quota_exhausted') {
          const retryAfter = Number.parseInt(upstreamRes.headers['retry-after'], 10) || 60;
          accountManager.markRateLimited(account.id, retryAfter);
        }
        upstreamRes.resume();
        return false;
      }

      if (!passthroughErrors && upstreamRes.statusCode === 401 && canRefreshSecret(account, secret)) {
        upstreamRes.resume();
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

  if (!passthroughErrors && upstreamResponse.statusCode === 429) {
    return { retryNextAccount: true };
  }

  if (!passthroughErrors && upstreamResponse.statusCode === 401 && canRefreshSecret(account, secret)) {
    return { retryAfterRefresh: true };
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

function requestUpstream({ target, method, headers, body, onResponse, onChunk }) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
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
        resolve({
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (!['GET', 'HEAD'].includes(method) && body.length > 0) req.write(body);
    req.end();
  });
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
