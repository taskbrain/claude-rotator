import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
export const OAUTH_USER_AGENT = 'claude-code/2.1.201 (cli)';
export const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_OAUTH_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_OAUTH_CONNECT_RETRIES = 3;
export const DEFAULT_OAUTH_CONNECT_RETRY_DELAY_MS = 250;
export const DEFAULT_OAUTH_REFRESH_LEAD_MS = 30 * 60 * 1000;
export const DEFAULT_REFRESH_RESULT_RETENTION_MS = 5 * 60 * 1000;
export const DEFAULT_TOKEN_REFRESH_RETRY_AFTER_MS = 60_000;
export const DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS = 15 * 60 * 1000;
export const DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS = 60 * 60 * 1000;
export const DEFAULT_TOKEN_REFRESH_CIRCUIT_ATTEMPTS = 6;
export const DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
export const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');
export const CLAUDE_AI_OAUTH_SCOPES = Object.freeze([
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
]);

export class OAuthTokenRefreshError extends Error {
  constructor({ status, code = 'unknown', retryAfterMs = null, retryAfterSource = null }) {
    super(`Token refresh failed (${status}): ${code}`);
    this.name = 'OAuthTokenRefreshError';
    this.status = status;
    this.oauthCode = code;
    this.retryAfterMs = retryAfterMs;
    this.retryAfterSource = retryAfterSource;
  }
}

export function isOAuthTokenRefreshRateLimit(error) {
  return (error instanceof OAuthTokenRefreshError && error.status === 429)
    || (
      error?.retryAfterSource === 'fixed'
      && Number.isFinite(Number(error?.retryAfterMs))
      && Number(error.retryAfterMs) > 0
    );
}

export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return expiresAt;
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

export function isTokenExpiringSoon(expiresAt, now = Date.now(), thresholdMs = DEFAULT_OAUTH_REFRESH_LEAD_MS) {
  if (!expiresAt) return false;
  return now + thresholdMs >= normalizeExpiresAt(expiresAt);
}

export function createSingleFlightTokenRefresher(tokenRefresher, {
  retentionMs = DEFAULT_REFRESH_RESULT_RETENTION_MS,
  now = Date.now,
  onSuccess = null,
  onFailure = null,
  maxRateLimitBackoffMs = DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS,
} = {}) {
  const entries = new Map();
  const rateLimitAttempts = new Map();
  let refreshTail = Promise.resolve();
  const configuredMaxBackoffMs = Number(maxRateLimitBackoffMs);
  const maxBackoffMs = Number.isFinite(configuredMaxBackoffMs) && configuredMaxBackoffMs > 0
    ? configuredMaxBackoffMs
    : DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS;
  const attemptRetentionMs = Math.max(
    maxBackoffMs * 2,
    DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS * 2,
  );

  const clearRateLimitAttempt = attemptKey => {
    const state = rateLimitAttempts.get(attemptKey);
    if (state?.timer) clearTimeout(state.timer);
    rateLimitAttempts.delete(attemptKey);
  };
  const incrementRateLimitAttempt = attemptKey => {
    const previous = rateLimitAttempts.get(attemptKey);
    if (previous?.timer) clearTimeout(previous.timer);
    const state = {
      count: (previous?.count || 0) + 1,
      timer: null,
    };
    rateLimitAttempts.set(attemptKey, state);
    state.timer = setTimeout(() => {
      if (rateLimitAttempts.get(attemptKey) === state) rateLimitAttempts.delete(attemptKey);
    }, Math.min(Math.ceil(attemptRetentionMs), MAX_TIMER_DELAY_MS));
    state.timer.unref?.();
    return state.count;
  };

  return async (refreshToken, context = null) => {
    const credentialKey = credentialDigestKey(refreshToken);
    const existing = entries.get(credentialKey);
    const currentTime = now();
    if (existing && existing.expiresAt > currentTime) {
      if (existing.error) {
        const error = deferredRefreshError(existing.error, existing.expiresAt - currentTime);
        try {
          onFailure?.({ context, error, deferred: true });
        } catch {}
        throw error;
      }
      return existing.promise;
    }
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      entries.delete(credentialKey);
    }

    const executeRefresh = async () => {
      try {
        const refreshed = await tokenRefresher(refreshToken, context ?? undefined);
        clearRateLimitAttempt(credentialKey);
        return refreshed;
      } catch (error) {
        const failedAt = now();
        const requestedRetryAfterMs = boundedRetryAfterMs(
          error?.retryAfterMs,
          error?.retryAfterSource === 'provider'
            ? DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS
            : Math.max(1, MAX_DATE_TIMESTAMP_MS - Number(failedAt) - 1),
        );
        if (requestedRetryAfterMs > 0) {
          if (error?.retryAfterSource === 'provider') {
            clearRateLimitAttempt(credentialKey);
            error.retryAfterMs = requestedRetryAfterMs;
          } else if (error?.retryAfterSource === 'fixed') {
            clearRateLimitAttempt(credentialKey);
            error.retryAfterMs = requestedRetryAfterMs;
          } else {
            const attempt = incrementRateLimitAttempt(credentialKey);
            const exponentialBackoffMs = Math.min(
              maxBackoffMs,
              Math.max(requestedRetryAfterMs, 1) * (2 ** Math.min(attempt - 1, 30)),
            );
            error.retryAfterMs = boundedRetryAfterMs(
              attempt > DEFAULT_TOKEN_REFRESH_CIRCUIT_ATTEMPTS
                ? Math.max(exponentialBackoffMs, DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS)
                : exponentialBackoffMs,
              Math.max(1, MAX_DATE_TIMESTAMP_MS - Number(failedAt) - 1),
            );
            error.retryAfterSource ||= 'fallback';
          }
        } else {
          clearRateLimitAttempt(credentialKey);
        }
        throw error;
      }
    };
    const promise = refreshTail.then(executeRefresh, executeRefresh);
    refreshTail = promise.catch(() => {});
    const entry = {
      completed: false,
      error: null,
      expiresAt: Number.POSITIVE_INFINITY,
      promise,
      timer: null,
    };
    entries.set(credentialKey, entry);

    try {
      const refreshed = await entry.promise;
      if (entries.get(credentialKey) === entry && !entry.completed) {
        entry.completed = true;
        const retainedForMs = Math.max(0, Number(retentionMs) || 0);
        entry.expiresAt = now() + retainedForMs;
        entry.promise = Promise.resolve(refreshed);
        if (retainedForMs > 0) {
          scheduleEntryExpiry(entries, credentialKey, entry, now);
        } else {
          entries.delete(credentialKey);
        }
        try {
          onSuccess?.({
            context,
            refreshed,
            rotated: refreshed.refreshToken !== refreshToken,
          });
        } catch {}
      }
      return refreshed;
    } catch (error) {
      if (entries.get(credentialKey) === entry && !entry.completed) {
        entry.completed = true;
        entry.error = error;
        try {
          onFailure?.({ context, error, deferred: false });
        } catch {}
        const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
        if (retryAfterMs > 0) {
          entry.expiresAt = now() + retryAfterMs;
          scheduleEntryExpiry(entries, credentialKey, entry, now);
        } else {
          entries.delete(credentialKey);
        }
      }
      throw error;
    }
  };
}

function credentialDigestKey(refreshToken) {
  const digest = createHash('sha256').update(String(refreshToken)).digest('base64url');
  return `token-sha256:${digest}`;
}

function boundedRetryAfterMs(value, maxDelayMs) {
  const delayMs = Number(value);
  if (Number.isNaN(delayMs) || delayMs <= 0) return 0;
  return Math.min(delayMs, Math.max(1, Number(maxDelayMs) || 1));
}

function deferredRefreshError(source, retryAfterMs) {
  const error = new OAuthTokenRefreshError({
    status: source?.status || 429,
    code: source?.oauthCode || 'rate_limit_error',
    retryAfterMs: Math.max(1, Math.ceil(retryAfterMs)),
    retryAfterSource: source?.retryAfterSource || null,
  });
  error.deferred = true;
  return error;
}

function scheduleEntryExpiry(entries, credentialKey, entry, now) {
  const expire = () => {
    if (entries.get(credentialKey) !== entry) return;
    const remainingMs = entry.expiresAt - now();
    if (remainingMs <= 0) {
      entries.delete(credentialKey);
      return;
    }
    entry.timer = setTimeout(expire, Math.min(Math.ceil(remainingMs), MAX_TIMER_DELAY_MS));
    entry.timer.unref?.();
  };
  expire();
}

export function parseTokenResponse(data, previousRefreshToken, now = Date.now(), previous = {}) {
  const parsed = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || previousRefreshToken,
    expiresAt: normalizeExpiresAt(data.expires_at) || (now + (data.expires_in || 3600) * 1000),
  };

  const responseScopes = normalizeOAuthScopes(data.scope);
  const scopes = responseScopes.length > 0
    ? responseScopes
    : normalizeOAuthScopes(previous.scopes);
  if (scopes.length > 0) parsed.scopes = scopes;

  const rawRefreshTokenExpiresIn = data.refresh_token_expires_in;
  const refreshTokenExpiresIn = Number(rawRefreshTokenExpiresIn);
  const refreshTokenExpiresAt = now + refreshTokenExpiresIn * 1000;
  if (
    rawRefreshTokenExpiresIn != null
    && rawRefreshTokenExpiresIn !== ''
    && Number.isFinite(refreshTokenExpiresIn)
    && refreshTokenExpiresIn >= 0
    && Number.isFinite(refreshTokenExpiresAt)
    && refreshTokenExpiresAt <= MAX_DATE_TIMESTAMP_MS
  ) {
    parsed.refreshTokenExpiresAt = refreshTokenExpiresAt;
  } else if (previous.refreshTokenExpiresAt != null) {
    parsed.refreshTokenExpiresAt = normalizeExpiresAt(previous.refreshTokenExpiresAt);
  }

  for (const field of ['clientId', 'subscriptionType', 'rateLimitTier']) {
    if (previous[field] != null) parsed[field] = previous[field];
  }
  return parsed;
}

export async function refreshAccessToken(refreshToken, options = {}) {
  options ||= {};
  const endpoint = options.endpoint || OAUTH_TOKEN_URL;
  const now = options.now || Date.now;
  const scopes = normalizeOAuthScopes(options.scopes);
  if (scopes.length === 0 && options.clientId && options.clientId !== OAUTH_CLIENT_ID) {
    throw new Error('OAuth scopes are required for custom client credentials');
  }
  const refreshScopes = scopes.length > 0 ? scopes : [...CLAUDE_AI_OAUTH_SCOPES];
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: options.clientId || OAUTH_CLIENT_ID,
    scope: refreshScopes.join(' '),
  });
  const response = await requestEndpoint(endpoint, {
    method: 'POST',
    headers: {
      ...oauthClientHeaders(),
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  }, options);

  if (!response.ok) {
    const body = await response.text();
    const retryAfter = response.status === 429
      ? oauthRetryAfter(response.headers, body, now())
      : { retryAfterMs: null, retryAfterSource: null };
    throw new OAuthTokenRefreshError({
      status: response.status,
      code: oauthErrorCode(body),
      ...retryAfter,
    });
  }

  return parseTokenResponse(await response.json(), refreshToken, now(), {
    scopes: refreshScopes,
    refreshTokenExpiresAt: options.refreshTokenExpiresAt,
    clientId: options.clientId,
    subscriptionType: options.subscriptionType,
    rateLimitTier: options.rateLimitTier,
  });
}

function normalizeOAuthScopes(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(entries.map(scope => String(scope).trim()).filter(Boolean))];
}

export async function fetchProfile(accessToken, options = {}) {
  const response = await requestEndpoint(options.endpoint || OAUTH_PROFILE_URL, {
    headers: {
      ...oauthClientHeaders(),
      Authorization: `Bearer ${accessToken}`,
    },
    signal: options.signal,
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
      ...oauthClientHeaders(),
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      Accept: 'application/json',
    },
    signal: options.signal,
  }, options);

  if (!response.ok) {
    throw new Error(`Usage fetch failed (${response.status}): ${await response.text()}`);
  }

  return parseUsageResponse(await response.json());
}

export function parseUsageResponse(data) {
  const source = data && typeof data === 'object' ? data : {};
  const limits = Array.isArray(source.limits) ? source.limits : [];
  const result = {
    seven_day_sonnet: source.seven_day_sonnet || null,
    extra_usage: source.extra_usage || null,
  };
  const fiveHour = globalUsageObservation(source, 'five_hour', limits, 'session');
  const sevenDay = globalUsageObservation(source, 'seven_day', limits, 'weekly_all');
  const scopedWeekly = normalizeScopedWeeklyUsage(source, limits);
  if (fiveHour.observed) result.five_hour = fiveHour.value;
  if (sevenDay.observed) result.seven_day = sevenDay.value;
  if (scopedWeekly.observed) result.scoped_weekly = scopedWeekly.value;
  return result;
}

function globalUsageObservation(data, key, limits, structuredKind) {
  const structured = structuredUsageObservation(limits, structuredKind);
  const legacyObserved = Object.prototype.hasOwnProperty.call(data, key);
  const legacy = legacyObserved ? normalizeObservedUsageBucket(data[key], true) : undefined;
  if (legacyObserved) {
    return {
      observed: true,
      value: preferredAuthoritativeUsageObservation(legacy, structured.value),
    };
  }
  return structured.observed
    ? { observed: true, value: structured.value }
    : { observed: false, value: undefined };
}

function structuredUsageObservation(limits, kind) {
  let observed = false;
  let value;
  for (const limit of limits) {
    if (!limit || limit.kind !== kind) continue;
    const next = normalizeObservedUsageBucket(limit);
    value = observed ? preferredAuthoritativeUsageObservation(value, next) : next;
    observed = true;
  }
  return { observed, value };
}

function normalizeObservedUsageBucket(bucket, explicitNullClears = false) {
  if (bucket === null && explicitNullClears) return null;
  return normalizeUsageBucket(bucket) || { utilization: null, resets_at: null };
}

function preferredAuthoritativeUsageObservation(primary, secondary) {
  const primaryHasUtilization = Number.isFinite(primary?.utilization);
  const secondaryHasUtilization = Number.isFinite(secondary?.utilization);
  if (!primaryHasUtilization) return secondaryHasUtilization ? secondary : primary;
  if (!secondaryHasUtilization || primary.utilization !== secondary.utilization) return primary;
  const primaryReset = Date.parse(primary.resets_at);
  const secondaryReset = Date.parse(secondary.resets_at);
  if (!Number.isFinite(primaryReset) && Number.isFinite(secondaryReset)) {
    return { ...primary, resets_at: secondary.resets_at };
  }
  return primary;
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
  const seen = new Map();
  const structuredObserved = Array.isArray(data?.limits);
  let legacyObserved = false;

  for (const limit of limits) {
    if (!limit || limit.kind !== 'weekly_scoped') continue;
    const model = limit.scope?.model || {};
    const label = normalizeScopedLabel(model.display_name || model.name || model.id || 'Scoped');
    appendScopedWeeklyUsage(scoped, seen, label, limit, model.id || label);
  }

  for (const key of Object.keys(data || {})) {
    if (!key.startsWith('seven_day_') || key === 'seven_day') continue;
    legacyObserved = true;
    const bucket = data[key];
    const label = labelFromLegacyScopedKey(key.slice('seven_day_'.length));
    appendScopedWeeklyUsage(scoped, seen, label, bucket, label);
  }

  return {
    observed: structuredObserved || legacyObserved,
    value: scoped,
  };
}

function appendScopedWeeklyUsage(scoped, seen, label, bucket, identity) {
  const normalized = normalizeUsageBucket(bucket) || {
    utilization: null,
    resets_at: null,
  };
  const key = scopedOutputKey(label, identity);
  const next = {
    key,
    label,
    utilization: Number.isFinite(normalized.utilization)
      ? normalized.utilization
      : null,
    resets_at: normalized.resets_at,
  };
  const identityKey = normalizeScopedIdentity(key);
  const existingIndex = seen.get(identityKey);
  if (existingIndex == null) {
    seen.set(identityKey, scoped.length);
    scoped.push(next);
    return;
  }
  scoped[existingIndex] = preferredAuthoritativeScopedObservation(
    scoped[existingIndex],
    next,
  );
}

function preferredAuthoritativeScopedObservation(existing, next) {
  const preferred = preferredAuthoritativeUsageObservation(existing, next);
  if (preferred === next) return next;
  if (preferred.resets_at !== existing.resets_at) {
    return { ...existing, resets_at: preferred.resets_at };
  }
  return existing;
}

function normalizeScopedIdentity(value) {
  const key = normalizeScopedKey(value);
  if (['fable', 'fable_5', 'claude_fable_5'].includes(key)) return 'claude_fable_5';
  return key;
}

function scopedOutputKey(label, identity) {
  const labelKey = normalizeScopedKey(label);
  const identityKey = normalizeScopedKey(identity || label);
  const labelIsFable = normalizeScopedIdentity(labelKey) === 'claude_fable_5';
  const identityIsFable = normalizeScopedIdentity(identityKey) === 'claude_fable_5';
  if (labelIsFable !== identityIsFable) return identityKey;
  return labelKey;
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

function oauthErrorCode(body) {
  try {
    const parsed = JSON.parse(body);
    const value = parsed?.error?.type || parsed?.error || parsed?.type;
    if (typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value)) return value;
  } catch {}
  return 'unknown';
}

function oauthRetryAfter(headers, body, nowMs) {
  const retryAfter = responseHeader(headers, 'retry-after');
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return {
        retryAfterMs: boundedRetryAfterMs(seconds * 1000, DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS),
        retryAfterSource: 'provider',
      };
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return {
        retryAfterMs: boundedRetryAfterMs(at - nowMs, DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS),
        retryAfterSource: 'provider',
      };
    }
  }

  try {
    const parsed = JSON.parse(body);
    const seconds = Number(parsed?.retry_after ?? parsed?.error?.retry_after);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return {
        retryAfterMs: boundedRetryAfterMs(seconds * 1000, DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS),
        retryAfterSource: 'provider',
      };
    }
  } catch {}
  return {
    retryAfterMs: DEFAULT_TOKEN_REFRESH_RETRY_AFTER_MS,
    retryAfterSource: 'fallback',
  };
}

function responseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const match = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  return Array.isArray(value) ? value[0] : value;
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

function oauthClientHeaders() {
  return {
    'User-Agent': OAUTH_USER_AGENT,
    'Accept-Encoding': 'identity',
  };
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
    headers: { ...oauthClientHeaders(), 'Content-Type': 'application/json' },
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
    signal: init.signal,
  });
}

async function requestHttpWithConnectRetries(endpoint, options = {}) {
  const retryCount = Math.max(0, Number(options.connectRetries) || 0);
  const maxAttempts = retryCount + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await requestHttp(endpoint, options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;
      await sleep(Math.max(0, Number(options.connectRetryDelayMs) || 0), options.signal);
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
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(oauthRequestAbortedError());
      return;
    }
    const target = new URL(endpoint);
    const client = target.protocol === 'http:' ? http : https;
    const chunks = [];
    let settled = false;
    let connected = false;
    let responseStarted = false;
    let connectTimer = null;
    let onAbort = null;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (connectTimer) clearTimeout(connectTimer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
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

    onAbort = () => {
      const error = oauthRequestAbortedError();
      req.destroy(error);
      settle(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

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

function oauthRequestAbortedError() {
  const error = new Error('OAuth request aborted');
  error.code = 'OAUTH_REQUEST_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw oauthRequestAbortedError();
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

async function sleep(ms, signal = null) {
  if (ms <= 0) return;
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(oauthRequestAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
