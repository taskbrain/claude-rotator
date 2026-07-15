import http from 'node:http';
import https from 'node:https';

import { isUnifiedQuotaExhaustion } from './account-manager.js';
import { readCurrentClaudeCredentials } from './claude-credentials.js';
import {
  DEFAULT_USAGE_POLL_INTERVAL_MS,
  DEFAULT_USAGE_REFRESH_CONCURRENCY,
  DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS,
} from './config.js';
import {
  createSingleFlightTokenRefresher,
  fetchProfile,
  fetchUsage,
  isOAuthTokenRefreshRateLimit,
  isTokenExpiringSoon,
  refreshAccessToken,
} from './oauth.js';
import { createNativeClaudeRefresher } from './native-claude-refresher.js';

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
const DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_CONNECT_RETRIES = 3;
const DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS = 250;
const DEFAULT_RESET_CHECK_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_USABLE_ACCESS_TOKEN_LIFETIME_MS = 60_000;
const guardedUpstreamSockets = new WeakSet();

export function createProxyServer({
  accountManager,
  secretStore,
  config,
  reloadAccounts = null,
  tokenRefresher = null,
  currentCredentialReader = readCurrentClaudeCredentials,
  currentProfileFetcher = fetchProfile,
  usageFetcher = fetchUsage,
  logger = null,
  stateWriter = null,
}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const upstreamIdleTimeoutMs = config.proxy?.upstreamIdleTimeoutMs
    ?? config.upstreamIdleTimeoutMs
    ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS;
  const upstreamConnectTimeoutMs = config.proxy?.upstreamConnectTimeoutMs
    ?? config.upstreamConnectTimeoutMs
    ?? DEFAULT_UPSTREAM_CONNECT_TIMEOUT_MS;
  const upstreamConnectRetries = config.proxy?.upstreamConnectRetries
    ?? config.upstreamConnectRetries
    ?? DEFAULT_UPSTREAM_CONNECT_RETRIES;
  const upstreamConnectRetryDelayMs = config.proxy?.upstreamConnectRetryDelayMs
    ?? config.upstreamConnectRetryDelayMs
    ?? DEFAULT_UPSTREAM_CONNECT_RETRY_DELAY_MS;
  const resolvedTokenRefresher = tokenRefresher || defaultTokenRefresher();
  const coordinatedTokenRefresher = createSingleFlightTokenRefresher(resolvedTokenRefresher, {
    onSuccess({ context, refreshed, rotated }) {
      logger?.(`${new Date().toISOString()} credential-refresh account=${context?.accountId || 'unknown'} result=success rotated=${rotated} expiresAt=${formatCredentialExpiry(refreshed.expiresAt)}`);
    },
    onFailure({ context, error, deferred = false }) {
      const retry = error?.retryAfterMs
        ? ` retryAfterSec=${Math.ceil(error.retryAfterMs / 1000)}`
        : '';
      const retrySource = ['provider', 'fallback', 'fixed'].includes(error?.retryAfterSource)
        ? ` retrySource=${error.retryAfterSource}`
        : '';
      const result = deferred ? 'deferred' : 'failed';
      logger?.(`${new Date().toISOString()} credential-refresh account=${context?.accountId || 'unknown'} result=${result} errorType=${credentialRefreshErrorType(error)}${retry}${retrySource}`);
    },
  });

  const usageRefresher = createUsageRefresher({
    accountManager,
    secretStore,
    tokenRefresher: coordinatedTokenRefresher,
    currentCredentialReader,
    currentProfileFetcher,
    usageFetcher,
    usageRequestOptions: {
      connectTimeoutMs: upstreamConnectTimeoutMs,
      connectRetries: upstreamConnectRetries,
      connectRetryDelayMs: upstreamConnectRetryDelayMs,
    },
    usageRefreshConcurrency: usagePollingConcurrency(config, accountManager.accounts.length),
    usageRefreshRequestSpacingMs: usagePollingRequestSpacingMs(config),
    logger,
  });
  const usageScheduler = createUsageRefreshScheduler({
    config,
    usageRefresher,
    persistState,
  });
  async function persistState() {
    if (!stateWriter) return;
    try {
      await stateWriter(accountManager.exportState());
    } catch (error) {
      logger?.(`state persist failed: ${shortErrorMessage(error)}`);
    }
  }

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
        await persistState();
        sendJson(res, 200, accountManager.getStatus());
        return;
      }

      if (req.method === 'POST' && req.url === '/internal/reload') {
        invalidateLiveClaudeCodeCache();
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

      if (req.method === 'POST' && req.url === '/internal/prepare-resume') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (body.refreshUsage) await usageScheduler.refreshNow();
        const result = accountManager.prepareResumeTarget();
        await persistState();
        sendJson(res, 200, {
          ...result,
          status: accountManager.getStatus(),
        });
        return;
      }

      const body = await readBody(req);
      if (usagePollingEnabled(config) && !usageScheduler.hasAttempted()) {
        await usageScheduler.refreshNow();
      }
      await forwardWithRotation({
        req,
        res,
        body,
        upstream,
        accountManager,
        secretStore,
        tokenRefresher: coordinatedTokenRefresher,
        currentCredentialReader,
        currentProfileFetcher,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
      });
      await persistState();
    } catch (error) {
      const message = shortErrorMessage(error);
      logger?.(`${new Date().toISOString()} proxy-error method=${req.method} path=${new URL(req.url, 'http://claude-rotator.local').pathname} error=${message}`);
      if (!res.headersSent) {
        sendJson(res, 502, {
          type: 'error',
          error: { type: 'proxy_error', message },
        });
      } else {
        res.destroy(error);
      }
    }
  });

  usageScheduler.start(server);
  return server;
}

function defaultTokenRefresher() {
  return process.platform === 'linux'
    ? createNativeClaudeRefresher()
    : refreshAccessToken;
}

function usagePollingEnabled(config) {
  return config.usagePolling?.enabled === true;
}

function createUsageRefreshScheduler({
  config,
  usageRefresher,
  now = () => Date.now(),
  persistState = async () => {},
}) {
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
    await persistState();
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
  const delays = [];
  const resetCheckDelayMs = Number(config.usagePolling?.resetCheckDelayMs) || DEFAULT_RESET_CHECK_DELAY_MS;
  const resetAt = nextExhaustedQuotaResetAt(status);
  if (resetAt != null) {
    delays.push(Math.max(0, resetAt - nowMs) + resetCheckDelayMs);
  }
  const retryAt = nextTemporaryRetryAt(status);
  if (retryAt != null) {
    delays.push(Math.max(0, retryAt - nowMs) + resetCheckDelayMs);
  }

  const intervalMs = usagePollingIntervalMs(config);
  if (intervalMs != null) delays.push(intervalMs);

  if (delays.length === 0) return null;
  return clampTimerDelay(Math.min(...delays));
}

function usagePollingIntervalMs(config) {
  const raw = config.usagePolling?.intervalMs;
  const value = raw == null ? DEFAULT_USAGE_POLL_INTERVAL_MS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function usagePollingConcurrency(config, accountCount) {
  const parsed = Number(config.usagePolling?.concurrency);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.max(1, Math.min(accountCount || 1, DEFAULT_USAGE_REFRESH_CONCURRENCY));
  return Math.max(1, Math.min(accountCount || 1, Math.floor(parsed)));
}

function usagePollingRequestSpacingMs(config) {
  const raw = config.usagePolling?.requestSpacingMs;
  const value = raw == null ? DEFAULT_USAGE_REFRESH_REQUEST_SPACING_MS : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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

function nextTemporaryRetryAt(status) {
  const retryTimes = [];
  for (const account of status?.accounts || []) {
    const retryAt = Date.parse(account.rateLimitedUntil || account.unavailableReason?.retryAt || '');
    if (Number.isFinite(retryAt)) retryTimes.push(retryAt);
  }
  if (retryTimes.length === 0) return null;
  return Math.min(...retryTimes);
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
  currentProfileFetcher,
  usageFetcher,
  usageRequestOptions,
  usageRefreshConcurrency,
  usageRefreshRequestSpacingMs,
  logger,
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
      currentProfileFetcher,
      usageFetcher,
      usageRequestOptions,
      usageRefreshConcurrency,
      usageRefreshRequestSpacingMs,
      logger,
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
  currentProfileFetcher,
  usageFetcher,
  usageRequestOptions,
  usageRefreshConcurrency,
  usageRefreshRequestSpacingMs,
  logger,
}) {
  const results = await mapWithConcurrency(
    accountManager.accounts,
    usageRefreshConcurrency,
    usageRefreshRequestSpacingMs,
    account => refreshAccountUsage({
      account,
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      currentProfileFetcher,
      usageFetcher,
      usageRequestOptions,
      logger,
    }),
  );
  rebalanceAfterUsageRefresh(accountManager);
  return {
    ok: results.every(result => result.ok),
    refreshedAt: new Date().toISOString(),
    accounts: results,
    status: accountManager.getStatus(),
  };
}

async function mapWithConcurrency(items, concurrency, requestSpacingMs, mapper) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.floor(Number(concurrency) || items.length)));
  const results = new Array(items.length);
  let nextIndex = 0;
  let lastStartedAt = 0;
  let spacingTail = Promise.resolve();

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      if (requestSpacingMs > 0) {
        spacingTail = spacingTail.then(async () => {
          const waitMs = Math.max(0, lastStartedAt + requestSpacingMs - Date.now());
          if (waitMs > 0) await sleep(waitMs);
          lastStartedAt = Date.now();
        });
        await spacingTail;
      }
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

async function refreshAccountUsage({
  account,
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  usageFetcher,
  usageRequestOptions,
  logger,
}) {
  if (account.type === 'apikey') return { account: account.id, ok: true, skipped: 'apikey' };

  try {
    const secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      logger,
    });
    if (!secret?.accessToken) throw new Error('OAuth access token is missing');
    const credentialCooldown = accountManager.unavailableReason(account)?.type === 'oauth_refresh_rate_limit';
    if (credentialCooldown && !hasUsableAccessToken(secret)) {
      return { account: account.id, ok: false, skipped: 'credential-refresh-cooldown' };
    }
    const freshSecret = credentialCooldown && hasUsableAccessToken(secret)
      ? secret
      : await refreshSecretIfExpiring({
        account,
        secret,
        secretStore,
        tokenRefresher,
        logger,
      });
    const usage = await usageFetcher(freshSecret.accessToken, usageRequestOptions);
    accountManager.applyUsage(account.id, usage);
    return { account: account.id, ok: true };
  } catch (caught) {
    const message = shortErrorMessage(caught);
    const refreshRateLimited = markOAuthRefreshRateLimit(accountManager, account.id, caught);
    if (!refreshRateLimited && isOAuthCredentialError(message)) {
      accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
    }
    return {
      account: account.id,
      ok: false,
      error: message,
    };
  }
}

function rebalanceAfterUsageRefresh(accountManager) {
  accountManager.rebalanceActiveAccount();
}

function isOAuthCredentialError(message) {
  return /OAuth access token is missing|Token refresh failed|Usage fetch failed \(401\)/.test(String(message || ''));
}

function markOAuthRefreshRateLimit(accountManager, accountId, error) {
  if (!isOAuthTokenRefreshRateLimit(error)) return false;
  const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
  accountManager.markCredentialRefreshRateLimited(accountId, retryAfterSeconds, {
    retryAfterSource: error.retryAfterSource,
  });
  return true;
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
  currentProfileFetcher,
  logger,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);
  let lastRetryableResponse = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = accountManager.getActiveAccount();
    if (!account) {
      if (sendCurrentQuotaUnavailableResponse({
        req,
        res,
        accountManager,
        logger,
      })) return;
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
        currentProfileFetcher,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
      })) return;
      sendUnavailableAccounts(res, accountManager);
      return;
    }

    const secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      logger,
    });
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
        logger,
      });
    } catch (caught) {
      if (!markOAuthRefreshRateLimit(accountManager, account.id, caught)) {
        accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
      }
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
      upstreamConnectTimeoutMs,
      upstreamConnectRetries,
      upstreamConnectRetryDelayMs,
    });
    if (result.retryAfterRefresh) {
      let refreshedSecret;
      try {
        refreshedSecret = await refreshAndStoreSecret({
          account,
          secret: freshSecret,
          secretStore,
          tokenRefresher,
          logger,
        });
      } catch (caught) {
        if (!markOAuthRefreshRateLimit(accountManager, account.id, caught)) {
          accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        }
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
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
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
    if (sendCurrentQuotaUnavailableResponse({
      req,
      res,
      accountManager,
      logger,
    })) return;
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
      currentProfileFetcher,
      logger,
      upstreamIdleTimeoutMs,
      upstreamConnectTimeoutMs,
      upstreamConnectRetries,
      upstreamConnectRetryDelayMs,
    })) return;
    sendUnavailableAccounts(res, accountManager);
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
  currentProfileFetcher,
  logger,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
}) {
  if (sendCurrentQuotaUnavailableResponse({
    req,
    res,
    accountManager,
    logger,
  })) return true;

  const account = accountManager.getFallbackAccount();
  if (!account) return false;

  const secret = await resolveSecretForAccount({
    account,
    secretStore,
    currentCredentialReader,
    currentProfileFetcher,
    logger,
  });
  if (!secret) return false;

  if (secret.liveClaudeCodeCredential && hasUsableAccessToken(secret)) {
    accountManager.markAuthenticated(account.id);
  }
  if (isCredentialUnavailable(accountManager.unavailableReason(account))) return false;

  let freshSecret;
  try {
    freshSecret = await refreshSecretIfExpiring({
      account,
      secret,
      secretStore,
      tokenRefresher,
      logger,
    });
  } catch {
    return false;
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
    upstreamConnectTimeoutMs,
    upstreamConnectRetries,
    upstreamConnectRetryDelayMs,
  });
  return true;
}

async function refreshSecretIfExpiring({ account, secret, secretStore, tokenRefresher, logger }) {
  if (!canRefreshSecret(account, secret)) return secret;
  if (!isTokenExpiringSoon(secret.expiresAt)) return secret;
  try {
    return await refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher, logger });
  } catch (error) {
    if (!hasUsableAccessToken(secret)) throw error;
    const expiresAt = normalizeCredentialExpiry(secret.expiresAt);
    const remainingSec = expiresAt == null ? 'unknown' : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    logger?.(`${new Date().toISOString()} credential-refresh-fallback account=${account.id} remainingSec=${remainingSec} errorType=${credentialRefreshErrorType(error)}`);
    return secret;
  }
}

async function refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher, logger }) {
  const refreshed = await tokenRefresher(secret.refreshToken, tokenRefreshContext(account, secret));
  const nextSecret = { ...secret, ...refreshed };
  try {
    const latestSecret = await secretStore.get(account.id);
    if (latestSecret?.refreshToken !== secret.refreshToken) {
      logger?.(`${new Date().toISOString()} credential-refresh account=${account.id} result=discarded reason=credential-changed`);
      if (latestSecret?.accessToken) return latestSecret;
      throw new Error('Stored OAuth credential changed while token refresh was in flight');
    }
    await secretStore.set(account.id, nextSecret);
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-store account=${account.id} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
    throw error;
  }
  return nextSecret;
}

function tokenRefreshContext(account, secret) {
  return {
    accountId: account.id,
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt,
    scopes: secret.scopes,
    refreshTokenExpiresAt: secret.refreshTokenExpiresAt,
    clientId: secret.clientId,
    subscriptionType: secret.subscriptionType,
    rateLimitTier: secret.rateLimitTier,
  };
}

function credentialRefreshErrorType(error) {
  const message = String(error?.message || '');
  if (/invalid_grant/i.test(message)) return 'invalid_grant';
  const status = message.match(/Token refresh failed \((\d+)\)/)?.[1];
  return status ? `http-${status}` : (error?.code || error?.name || 'unknown');
}

function canRefreshSecret(account, secret) {
  if (secret.liveClaudeCodeCredential) return false;
  return account.type !== 'apikey' && !secret.apiKey && Boolean(secret.refreshToken);
}

async function resolveSecretForAccount({
  account,
  secretStore,
  currentCredentialReader,
  currentProfileFetcher,
  logger,
}) {
  if (account.type === 'apikey') return secretStore.get(account.id);
  if (account.id === 'current' || account.credentialSource === 'claude-code-current') {
    return liveClaudeCodeSecret(currentCredentialReader);
  }

  const stored = await secretStore.get(account.id);
  if (!account.accountUuid) return stored;

  const current = await liveClaudeCodeCredentialWithProfile({
    currentCredentialReader,
    currentProfileFetcher,
  }).catch(() => null);
  const matchesStoredCredential = Boolean(
    current?.secret
    && stored
    && (
      stored.accessToken === current.secret.accessToken
      || stored.refreshToken === current.secret.refreshToken
    )
  );
  if (!matchesStoredCredential && current?.profile?.accountUuid !== account.accountUuid) return stored;
  await mirrorLiveClaudeCodeCredential({
    account,
    stored,
    live: current.secret,
    secretStore,
    logger,
  });
  return current.secret;
}

async function mirrorLiveClaudeCodeCredential({ account, stored, live, secretStore, logger }) {
  if (!live?.accessToken || !live.refreshToken) return;
  const mirrored = {
    ...(stored || {}),
    ...live,
  };
  for (const field of ['clientId', 'scopes']) {
    if (!(field in live)) delete mirrored[field];
  }
  delete mirrored.liveClaudeCodeCredential;
  if (credentialsMatch(stored, mirrored)) return;

  try {
    await secretStore.set(account.id, mirrored);
    logger?.(`${new Date().toISOString()} credential-sync account=${account.id} source=claude-code-current expiresAt=${formatCredentialExpiry(live.expiresAt)}`);
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-sync-failed account=${account.id} error=${shortErrorMessage(error)}`);
  }
}

function credentialsMatch(left, right) {
  return left?.accessToken === right?.accessToken
    && left?.refreshToken === right?.refreshToken
    && normalizeCredentialExpiry(left?.expiresAt) === normalizeCredentialExpiry(right?.expiresAt)
    && normalizeCredentialExpiry(left?.refreshTokenExpiresAt)
      === normalizeCredentialExpiry(right?.refreshTokenExpiresAt)
    && JSON.stringify(left?.scopes || null) === JSON.stringify(right?.scopes || null)
    && left?.clientId === right?.clientId
    && left?.subscriptionType === right?.subscriptionType
    && left?.rateLimitTier === right?.rateLimitTier;
}

function normalizeCredentialExpiry(expiresAt) {
  const value = Number(expiresAt);
  if (!Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function hasUsableAccessToken(secret, now = Date.now()) {
  if (!secret?.accessToken) return false;
  const expiresAt = normalizeCredentialExpiry(secret.expiresAt);
  return expiresAt == null || expiresAt - now > MIN_USABLE_ACCESS_TOKEN_LIFETIME_MS;
}

function isCredentialUnavailable(reason) {
  return reason?.type === 'oauth_refresh_rate_limit'
    || reason?.type === 'oauth_refresh_failed'
    || reason?.type === 'authentication_error';
}

function formatCredentialExpiry(expiresAt) {
  const value = normalizeCredentialExpiry(expiresAt);
  return value == null ? 'unknown' : new Date(value).toISOString();
}

async function liveClaudeCodeSecret(currentCredentialReader) {
  return {
    ...(await currentCredentialReader()),
    liveClaudeCodeCredential: true,
  };
}

const LIVE_CLAUDE_CODE_CACHE_TTL_MS = 60_000;
let liveClaudeCodeCache = null;

function invalidateLiveClaudeCodeCache() {
  liveClaudeCodeCache = null;
}

async function liveClaudeCodeCredentialWithProfile({
  currentCredentialReader,
  currentProfileFetcher,
}) {
  const now = Date.now();
  if (
    liveClaudeCodeCache
    && liveClaudeCodeCache.currentCredentialReader === currentCredentialReader
    && liveClaudeCodeCache.currentProfileFetcher === currentProfileFetcher
    && liveClaudeCodeCache.expiresAt > now
  ) {
    return liveClaudeCodeCache.value;
  }

  const secret = await liveClaudeCodeSecret(currentCredentialReader);
  let profile = null;
  if (secret.accessToken) {
    try {
      profile = await currentProfileFetcher(secret.accessToken);
    } catch {}
  }
  const value = { secret, profile };
  liveClaudeCodeCache = {
    currentCredentialReader,
    currentProfileFetcher,
    expiresAt: now + LIVE_CLAUDE_CODE_CACHE_TTL_MS,
    value,
  };
  return value;
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
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
}) {
  const target = new URL(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret);
  const startedAt = Date.now();
  let outcome = 'ok';

  let upstreamResponse;
  try {
    upstreamResponse = await requestUpstreamWithConnectRetries({
      target,
      method: req.method,
      headers,
      body,
      idleTimeoutMs: upstreamIdleTimeoutMs,
      connectTimeoutMs: upstreamConnectTimeoutMs,
      connectRetries: upstreamConnectRetries,
      connectRetryDelayMs: upstreamConnectRetryDelayMs,
      onRetry(error, attempt, maxAttempts) {
        logger?.(`${new Date().toISOString()} upstream-connect-retry account=${account.id} method=${req.method} path=${target.pathname} attempt=${attempt}/${maxAttempts} errorType=${error.code || error.name}`);
      },
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
          } else if (secret.liveClaudeCodeCredential) {
            outcome = 'auth-live-reload';
            invalidateLiveClaudeCodeCache();
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

async function requestUpstreamWithConnectRetries(options) {
  const retryCount = Math.max(0, Number(options.connectRetries) || 0);
  const maxAttempts = retryCount + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestUpstream(options);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;
      options.onRetry?.(error, attempt, maxAttempts);
      await sleep(Math.max(0, Number(options.connectRetryDelayMs) || 0));
    }
  }
  throw new Error('unreachable upstream retry state');
}

function requestUpstream({
  target,
  method,
  headers,
  body,
  idleTimeoutMs,
  connectTimeoutMs,
  onResponse,
  onChunk,
}) {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    let idleTimer = null;
    let connectTimer = null;
    let connected = false;
    let responseStarted = false;
    let req = null;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (connectTimer) clearTimeout(connectTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const markConnected = () => {
      connected = true;
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const startConnectTimer = () => {
      if (!connectTimeoutMs || connectTimeoutMs <= 0 || settled) return;
      connectTimer = setTimeout(() => {
        const error = new Error(`Upstream connection timeout after ${connectTimeoutMs}ms`);
        error.code = 'UPSTREAM_CONNECT_TIMEOUT';
        error.connectPhase = true;
        req?.destroy(error);
        settle(error);
      }, connectTimeoutMs);
      connectTimer.unref?.();
    };
    const resetIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const error = new Error(`Upstream request idle timeout after ${idleTimeoutMs}ms`);
        error.code = 'UPSTREAM_IDLE_TIMEOUT';
        req?.destroy(error);
        settle(error);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };
    req = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, upstreamRes => {
      responseStarted = true;
      markConnected();
      resetIdleTimer();
      const shouldStream = onResponse(upstreamRes);
      const chunks = [];
      upstreamRes.on('data', chunk => {
        resetIdleTimer();
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
    req.on('socket', socket => {
      guardUpstreamSocket(socket);
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
    if (!['GET', 'HEAD'].includes(method) && body.length > 0) req.write(body);
    startConnectTimer();
    resetIdleTimer();
    req.end();
  });
}

function guardUpstreamSocket(socket) {
  if (guardedUpstreamSockets.has(socket)) return;
  guardedUpstreamSockets.add(socket);
  // A TLS socket can emit a late EPIPE after its ClientRequest has already settled.
  socket.on('error', () => {});
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
    'UPSTREAM_CONNECT_TIMEOUT',
  ].includes(error?.code);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise(resolve => setTimeout(resolve, ms));
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
  return error?.code === 'UPSTREAM_IDLE_TIMEOUT'
    || error?.code === 'UPSTREAM_CONNECT_TIMEOUT';
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

function sendCurrentQuotaUnavailableResponse({ req, res, accountManager, logger }) {
  let account = accountManager.getCurrentAccount();
  let reason = accountManager.unavailableReason(account);
  if (!isUnifiedQuotaExhaustion(reason)) return false;

  const shortestResetAccount = accountManager.selectBestExhaustedFallback();
  if (shortestResetAccount) {
    account = shortestResetAccount;
    reason = accountManager.unavailableReason(account);
    if (!isUnifiedQuotaExhaustion(reason)) return false;
  }

  const response = syntheticQuotaExhaustedResponse(account, reason);
  recordProxyRequest({
    accountManager,
    logger,
    account,
    method: req.method,
    path: new URL(req.url, 'http://claude-rotator.local').pathname,
    statusCode: response.statusCode,
    outcome: 'quota-exhausted-local',
    durationMs: 0,
  });
  sendBufferedResponse(res, response);
  return true;
}

function syntheticQuotaExhaustedResponse(account, reason) {
  const windowHeader = quotaWindowHeader(reason.window);
  const claim = reason.claim || quotaRepresentativeClaim(reason.window);
  const resetSeconds = quotaResetSeconds(reason.resetAt);
  const headers = {
    'content-type': 'application/json',
    'x-claude-rotator-account': account?.id || '',
    'x-claude-rotator-quota-window': reason.window || '',
  };
  if (claim) {
    headers['anthropic-ratelimit-unified-status'] = 'rejected';
    headers['anthropic-ratelimit-unified-representative-claim'] = claim;
  }
  if (resetSeconds) headers['anthropic-ratelimit-unified-reset'] = resetSeconds;
  if (windowHeader) {
    headers[`anthropic-ratelimit-unified-${windowHeader}-utilization`] = String(reason.utilization ?? 1);
    if (resetSeconds) headers[`anthropic-ratelimit-unified-${windowHeader}-reset`] = resetSeconds;
  }

  const rotatorMessage = quotaExhaustedRotatorMessage(account, reason);
  return {
    statusCode: 429,
    headers,
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: quotaExhaustedOfficialMessage(reason),
        details: {
          source: 'claude-rotator',
          account: account?.id || null,
          account_name: account?.name || null,
          window: reason.window,
          utilization: reason.utilization,
          reset_at: reason.resetAt || null,
          rotator_message: rotatorMessage,
        },
      },
    })),
  };
}

function quotaWindowHeader(window) {
  if (window === '5h') return '5h';
  if (window === '7d') return '7d';
  return null;
}

function quotaRepresentativeClaim(window) {
  if (window === '5h') return 'five_hour';
  if (window === '7d') return 'seven_day';
  return null;
}

function quotaResetSeconds(resetAt) {
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return null;
  return String(Math.floor(parsed / 1000));
}

function quotaExhaustedOfficialMessage(reason) {
  const limit = reason.window === '5h'
    ? 'session limit'
    : reason.window === '7d'
      ? 'weekly limit'
      : String(reason.window || '').startsWith('7d ')
        ? `${reason.window.slice(3)} weekly limit`
        : 'usage limit';
  const reset = reason.resetAt ? ` · resets ${formatClaudeResetTime(reason.window, reason.resetAt)}` : '';
  return `You've hit your ${limit}${reset}`;
}

function quotaExhaustedRotatorMessage(account, reason) {
  const reset = reason.resetAt ? ` Resets at ${reason.resetAt}.` : '';
  return `Claude ${reason.window} usage limit exhausted for ${account?.name || account?.id || 'current account'}.${reset} No available rotation target.`;
}

function formatClaudeResetTime(window, resetAt) {
  const parsed = Date.parse(resetAt);
  if (!Number.isFinite(parsed)) return resetAt;
  const date = new Date(parsed);
  const time = formatTwelveHourTime(date);
  if (window === '7d' || String(window || '').startsWith('7d ')) {
    const month = date.toLocaleString('en-US', { month: 'short' });
    return `${month} ${date.getDate()} at ${time}`;
  }
  return time;
}

function formatTwelveHourTime(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const hour = hours % 12 || 12;
  const suffix = hours < 12 ? 'am' : 'pm';
  if (minutes === 0) return `${hour}${suffix}`;
  return `${hour}:${String(minutes).padStart(2, '0')}${suffix}`;
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

function sendUnavailableAccounts(res, accountManager = null) {
  const current = accountManager?.getCurrentAccount();
  const reason = current ? accountManager.unavailableReason(current) : null;
  if (isCredentialUnavailable(reason)) {
    const headers = { 'Content-Type': 'application/json' };
    const now = Date.now();
    const retryTimes = (accountManager?.accounts || [])
      .map(account => accountManager.unavailableReason(account))
      .map(accountReason => Date.parse(accountReason?.retryAt || ''))
      .filter(retryAt => Number.isFinite(retryAt) && retryAt > now);
    const retryAt = retryTimes.length > 0 ? Math.min(...retryTimes) : null;
    if (retryAt != null) {
      headers['Retry-After'] = String(Math.max(1, Math.ceil((retryAt - now) / 1000)));
    }
    res.writeHead(503, headers);
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'No usable OAuth credential is currently available.',
      },
    }));
    return;
  }
  sendJson(res, 429, {
    type: 'error',
    error: { type: 'rate_limit_error', message: 'All configured accounts are unavailable.' },
  });
}

function shortErrorMessage(error) {
  const parts = [error?.message || error || 'unknown error'];
  const cause = error?.cause;
  if (cause) {
    const causeParts = [
      cause.name,
      cause.code,
      cause.message,
      cause.syscall,
      cause.address && cause.port ? `${cause.address}:${cause.port}` : cause.address,
    ].filter(Boolean);
    if (causeParts.length > 0) parts.push(`cause: ${causeParts.join(' ')}`);
  }
  return String(parts.join(' · ')).replace(/\s+/g, ' ').slice(0, 360);
}
