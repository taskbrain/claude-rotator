import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_OAUTH_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_OAUTH_CONNECT_RETRIES = 3;
export const DEFAULT_OAUTH_CONNECT_RETRY_DELAY_MS = 250;
export const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');

export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return expiresAt;
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export function isTokenExpiringSoon(expiresAt, now = Date.now(), thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return now + thresholdMs >= normalizeExpiresAt(expiresAt);
}

export function parseTokenResponse(data, previousRefreshToken, now = Date.now()) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken,
    expiresAt: normalizeExpiresAt(data.expires_at) || (now + (data.expires_in || 3600) * 1000),
  };
}

export async function refreshAccessToken(refreshToken, options = {}) {
  const endpoint = options.endpoint || OAUTH_TOKEN_URL;
  const now = options.now || Date.now;
  const response = await requestEndpoint(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  }, options);

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  return parseTokenResponse(await response.json(), refreshToken, now());
}

export async function fetchProfile(accessToken, options = {}) {
  const response = await requestEndpoint(options.endpoint || OAUTH_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  }, options);

  if (!response.ok) {
    throw new Error(`Profile fetch failed (${response.status}): ${await response.text()}`);
  }

  const data = await response.json();
  return {
    accountUuid: data.account?.uuid || null,
    email: data.account?.email || null,
    displayName: data.account?.display_name || null,
    hasClaudeMax: Boolean(data.account?.has_claude_max),
    hasClaudePro: Boolean(data.account?.has_claude_pro),
    organizationName: data.organization?.name || null,
    organizationType: data.organization?.organization_type || null,
  };
}

export async function fetchUsage(accessToken, options = {}) {
  const response = await requestEndpoint(options.endpoint || OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      Accept: 'application/json',
    },
  }, options);

  if (!response.ok) {
    throw new Error(`Usage fetch failed (${response.status}): ${await response.text()}`);
  }

  return parseUsageResponse(await response.json());
}

export function parseUsageResponse(data) {
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const sessionLimit = limits.find(limit => limit?.kind === 'session');
  const weeklyAllLimit = limits.find(limit => limit?.kind === 'weekly_all');

  return {
    five_hour: normalizeUsageBucket(data.five_hour) || normalizeUsageBucket(sessionLimit),
    seven_day: normalizeUsageBucket(data.seven_day) || normalizeUsageBucket(weeklyAllLimit),
    scoped_weekly: normalizeScopedWeeklyUsage(data, limits),
    seven_day_sonnet: data.seven_day_sonnet || null,
    extra_usage: data.extra_usage || null,
  };
}

function normalizeUsageBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const rawUtilization = bucket.utilization ?? bucket.percent;
  if (rawUtilization == null && !bucket.resets_at) return null;
  return {
    utilization: normalizeUsageUtilization(rawUtilization),
    resets_at: bucket.resets_at || null,
  };
}

function normalizeScopedWeeklyUsage(data, limits) {
  const scoped = [];
  const seen = new Set();

  for (const limit of limits) {
    if (!limit || limit.kind !== 'weekly_scoped') continue;
    const model = limit.scope?.model || {};
    const label = normalizeScopedLabel(model.display_name || model.name || model.id || 'Scoped');
    appendScopedWeeklyUsage(scoped, seen, label, limit);
  }

  for (const key of Object.keys(data || {})) {
    if (!key.startsWith('seven_day_') || key === 'seven_day') continue;
    const bucket = data[key];
    if (!bucket || typeof bucket !== 'object') continue;
    const label = labelFromLegacyScopedKey(key.slice('seven_day_'.length));
    appendScopedWeeklyUsage(scoped, seen, label, bucket);
  }

  return scoped;
}

function appendScopedWeeklyUsage(scoped, seen, label, bucket) {
  const normalized = normalizeUsageBucket(bucket);
  if (!normalized || typeof normalized.utilization !== 'number') return;
  const key = normalizeScopedKey(label);
  if (seen.has(key)) return;
  seen.add(key);
  scoped.push({
    key,
    label,
    utilization: normalized.utilization,
    resets_at: normalized.resets_at,
  });
}

function labelFromLegacyScopedKey(value) {
  return normalizeScopedLabel(String(value || '')
    .split('_')
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' '));
}

function normalizeScopedLabel(value) {
  const label = String(value || '').trim();
  return label || 'Scoped';
}

function normalizeScopedKey(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return key || 'scoped';
}

function normalizeUsageUtilization(value) {
  if (value == null) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Math.max(0, Math.min(1, number / 100));
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function createAuthorizationUrl({
  redirectUri,
  state,
  codeChallenge,
  clientId = OAUTH_CLIENT_ID,
}) {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', OAUTH_SCOPES);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url;
}

export async function exchangeAuthorizationCode({
  code,
  state,
  redirectUri,
  codeVerifier,
  fetchImpl = null,
  requestImpl = null,
  timeoutMs = DEFAULT_OAUTH_REQUEST_TIMEOUT_MS,
}) {
  const response = await requestEndpoint(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  }, { fetchImpl, requestImpl, timeoutMs });

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }

  return parseTokenResponse(await response.json(), null);
}

async function requestEndpoint(endpoint, init, options = {}) {
  if (options.fetchImpl) return options.fetchImpl(endpoint, init);
  const requestImpl = options.requestImpl || requestHttpWithConnectRetries;
  return requestImpl(endpoint, {
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body || null,
    timeoutMs: options.timeoutMs ?? DEFAULT_OAUTH_REQUEST_TIMEOUT_MS,
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_OAUTH_CONNECT_TIMEOUT_MS,
    connectRetries: options.connectRetries ?? DEFAULT_OAUTH_CONNECT_RETRIES,
    connectRetryDelayMs: options.connectRetryDelayMs ?? DEFAULT_OAUTH_CONNECT_RETRY_DELAY_MS,
  });
}

async function requestHttpWithConnectRetries(endpoint, options = {}) {
  const retryCount = Math.max(0, Number(options.connectRetries) || 0);
  const maxAttempts = retryCount + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestHttp(endpoint, options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;
      await sleep(Math.max(0, Number(options.connectRetryDelayMs) || 0));
    }
  }
  throw new Error('unreachable OAuth retry state');
}

function requestHttp(endpoint, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = DEFAULT_OAUTH_REQUEST_TIMEOUT_MS,
  connectTimeoutMs = DEFAULT_OAUTH_CONNECT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(endpoint);
    const client = target.protocol === 'http:' ? http : https;
    const chunks = [];
    let settled = false;
    let connected = false;
    let responseStarted = false;
    let connectTimer = null;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const markConnected = () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const startConnectTimer = req => {
      if (!connectTimeoutMs || connectTimeoutMs <= 0 || settled) return;
      connectTimer = setTimeout(() => {
        const error = new Error(`OAuth connection timeout after ${connectTimeoutMs}ms`);
        error.code = 'OAUTH_CONNECT_TIMEOUT';
        error.connectPhase = true;
        req.destroy(error);
        settle(error);
      }, connectTimeoutMs);
      connectTimer.unref?.();
    };
    const req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, res => {
      responseStarted = true;
      markConnected();
      res.on('data', chunk => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        settle(null, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          async text() {
            return buffer.toString('utf8');
          },
          async json() {
            return JSON.parse(buffer.toString('utf8'));
          },
        });
      });
      res.on('aborted', () => {
        const error = new Error('OAuth response aborted');
        error.code = 'OAUTH_RESPONSE_ABORTED';
        settle(error);
      });
      res.on('error', settle);
    });

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const error = new Error(`OAuth request timeout after ${timeoutMs}ms`);
        error.code = 'OAUTH_REQUEST_TIMEOUT';
        if (!connected && !responseStarted) error.connectPhase = true;
        req.destroy(error);
      });
    }
    req.on('socket', socket => {
      if (!socket.connecting) {
        markConnected();
        return;
      }
      if (target.protocol === 'https:') socket.once('secureConnect', markConnected);
      else socket.once('connect', markConnected);
    });
    req.on('error', error => {
      if (!connected && !responseStarted && isConnectNetworkError(error)) {
        error.connectPhase = true;
      }
      settle(error);
    });
    if (body) req.write(body);
    startConnectTimer(req);
    req.end();
  });
}

function isRetryableConnectError(error) {
  return Boolean(error?.connectPhase) && isConnectNetworkError(error);
}

function isConnectNetworkError(error) {
  return [
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'ECONNRESET',
    'UND_ERR_CONNECT_TIMEOUT',
    'OAUTH_CONNECT_TIMEOUT',
    'OAUTH_REQUEST_TIMEOUT',
  ].includes(error?.code);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
}
