import { createHash, randomBytes } from 'node:crypto';

export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
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
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || Date.now;
  const response = await fetchImpl(endpoint, {
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
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed (${response.status}): ${await response.text()}`);
  }

  return parseTokenResponse(await response.json(), refreshToken, now());
}

export async function fetchProfile(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(options.endpoint || OAUTH_PROFILE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

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
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(options.endpoint || OAUTH_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Usage fetch failed (${response.status}): ${await response.text()}`);
  }

  return parseUsageResponse(await response.json());
}

export function parseUsageResponse(data) {
  return {
    five_hour: data.five_hour
      ? {
          utilization: normalizeUsageUtilization(data.five_hour.utilization),
          resets_at: data.five_hour.resets_at,
        }
      : null,
    seven_day: data.seven_day
      ? {
          utilization: normalizeUsageUtilization(data.seven_day.utilization),
          resets_at: data.seven_day.resets_at,
        }
      : null,
    seven_day_sonnet: data.seven_day_sonnet || null,
    extra_usage: data.extra_usage || null,
  };
}

function normalizeUsageUtilization(value) {
  if (value == null) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return number > 1 ? number / 100 : number;
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
  fetchImpl = globalThis.fetch,
}) {
  const response = await fetchImpl(OAUTH_TOKEN_URL, {
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
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${await response.text()}`);
  }

  return parseTokenResponse(await response.json(), null);
}
