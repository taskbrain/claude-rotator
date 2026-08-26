import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { isCredentialRefreshCooldown, isUnifiedQuotaExhaustion } from './account-manager.js';
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
  OAUTH_BETA_HEADER,
  refreshAccessToken,
} from './oauth.js';
import { createNativeClaudeRefresher } from './native-claude-refresher.js';
import { parseRateLimitHeaders } from './quota.js';

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
const REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS = 5_000;
const REACTIVE_QUOTA_EXHAUSTION_THRESHOLD = 1;
const REACTIVE_QUOTA_SINGLE_FLIGHT_GRACE_MS = 250;
const SCOPED_USAGE_FIELD_PREFIX = 'scoped_weekly:';
const SCOPED_USAGE_SNAPSHOT_FIELD = 'scoped_weekly:*';
const SCOPED_USAGE_MERGE_FIELD = 'scoped_weekly_merge';
const SCOPED_USAGE_PRESERVE_PREFIX = 'scoped_weekly_preserve:';
const DEFAULT_RESET_CHECK_DELAY_MS = 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MIN_USABLE_ACCESS_TOKEN_LIFETIME_MS = 60_000;
const guardedUpstreamSockets = new WeakSet();

export function createProxyServer({
  accountManager,
  secretStore,
  config,
  reloadAccounts = null,
  allowLiveClaudeCodeCredentials = true,
  tokenRefresher = null,
  currentCredentialReader = readCurrentClaudeCredentials,
  currentProfileFetcher = fetchProfile,
  usageFetcher = fetchUsage,
  reactiveQuotaConfirmTimeoutMs = REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS,
  logger = null,
  stateWriter = null,
  platform = process.platform,
  serviceGeneration = null,
}) {
  assertLoopbackProxyHost(config.proxy?.host || '127.0.0.1');
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
  const resolvedTokenRefresher = tokenRefresher || defaultTokenRefresher({
    platform,
    nativeOptions: {
      onCleanupError(error) {
        logger?.(`${new Date().toISOString()} credential-refresh-cleanup result=failed errorType=${error?.code || error?.name || 'unknown'}`);
      },
    },
  });
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

  const usageObservationTracker = createUsageObservationTracker();
  const usageRequestOptions = {
    connectTimeoutMs: upstreamConnectTimeoutMs,
    connectRetries: upstreamConnectRetries,
    connectRetryDelayMs: upstreamConnectRetryDelayMs,
  };
  const usageRefresher = createUsageRefresher({
    accountManager,
    secretStore,
    tokenRefresher: coordinatedTokenRefresher,
    currentCredentialReader,
    currentProfileFetcher,
    usageFetcher,
    usageRequestOptions,
    usageObservationTracker,
    allowLiveClaudeCodeCredentials,
    usageRefreshConcurrency: usagePollingConcurrency(config, accountManager.accounts.length),
    usageRefreshRequestSpacingMs: usagePollingRequestSpacingMs(config),
    logger,
  });
  const reactiveQuotaConfirmer = createReactiveQuotaConfirmer({
    accountManager,
    secretStore,
    currentCredentialReader,
    usageFetcher,
    usageRequestOptions,
    usageObservationTracker,
    allowLiveClaudeCodeCredentials,
    timeoutMs: positiveTimeoutOrDefault(
      reactiveQuotaConfirmTimeoutMs,
      REACTIVE_QUOTA_CONFIRM_TIMEOUT_MS,
    ),
    logger,
  });
  const usageScheduler = createUsageRefreshScheduler({
    config,
    usageRefresher,
    persistState,
  });
  let persistTail = Promise.resolve();
  function persistState() {
    if (!stateWriter) return;
    const snapshot = accountManager.exportState();
    const write = persistTail.then(() => stateWriter(snapshot));
    persistTail = write.catch(error => {
      logger?.(`state persist failed: ${shortErrorMessage(error)}`);
    });
    return persistTail;
  }
  const checkPersistedRefreshIntents = async () => {
    if (await reconcilePersistedRefreshIntents({ accountManager, secretStore, logger })) {
      await persistState();
    }
  };
  let operationalStateCheck = checkPersistedRefreshIntents();

  const server = http.createServer(async (req, res) => {
    try {
      if (!isTrustedLocalHttpRequest(req)) {
        sendJson(res, 403, {
          type: 'error',
          error: { type: 'forbidden', message: 'Cross-site proxy requests are not allowed' },
        });
        return;
      }
      // /internal/health must stay a cheap liveness probe: reconciling
      // persisted refresh intents (below) can take up to the account lock's
      // full acquire timeout per account, which would otherwise make
      // install/reinstall's bounded health poll (see waitForMacosHealth)
      // time out and roll back the install whenever any account's lock is
      // briefly held by a concurrent refresh.
      if (req.method === 'GET' && req.url === '/internal/health') {
        sendJson(res, 200, {
          ok: true,
          currentAccount: accountManager.getStatus().currentAccount,
          ...(serviceGeneration ? { serviceGeneration } : {}),
        });
        return;
      }
      await operationalStateCheck;

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
        // Reconcile in the background instead of awaiting it (or replacing
        // the shared operationalStateCheck gate other requests await): each
        // account's reconcile can block on that account's file lock for up
        // to its full acquire timeout, and every other in-flight request
        // (including /internal/status and proxied /v1/messages calls) would
        // otherwise stall behind this single reload until it finishes.
        checkPersistedRefreshIntents().catch(error => {
          logger?.(`${new Date().toISOString()} reload-reconcile result=failed error=${shortErrorMessage(error)}`);
        });
        if (usagePollingEnabled(config)) {
          await usageScheduler.refreshNow({ afterCurrent: true });
        }
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

      try {
        configuredUpstreamTarget(req.url, upstream);
      } catch {
        sendJson(res, 400, {
          type: 'error',
          error: { type: 'invalid_request_target', message: 'Invalid request target' },
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
        reactiveQuotaConfirmer,
        allowLiveClaudeCodeCredentials,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
      });
      await persistState();
    } catch (error) {
      const message = shortErrorMessage(error);
      logger?.(`${new Date().toISOString()} proxy-error method=${req.method} path=${safeRequestPath(req.url)} error=${message}`);
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

async function reconcilePersistedRefreshIntents({ accountManager, secretStore, logger }) {
  let changed = false;
  for (const account of accountManager.accounts) {
    if (
      account.type === 'apikey'
      || account.id === 'current'
      || account.credentialSource === 'claude-code-current'
    ) continue;
    try {
      await getOperationalSecret(secretStore, account.id);
    } catch (error) {
      if (error?.code !== 'NATIVE_REFRESH_OUTCOME_UNKNOWN') {
        logger?.(`${new Date().toISOString()} credential-state-check account=${account.id} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
        continue;
      }
      if (account.errorReason?.type !== 'oauth_refresh_failed') {
        accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        changed = true;
      }
    }
  }
  return changed;
}

export function defaultTokenRefresher({
  platform = process.platform,
  nativeRefresherFactory = createNativeClaudeRefresher,
  directRefresher = refreshAccessToken,
  nativeOptions = {},
} = {}) {
  if (platform === 'linux' || platform === 'darwin') {
    return nativeRefresherFactory({ ...nativeOptions, platform });
  }
  return directRefresher;
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

  const refreshNow = async (options = {}) => {
    const result = await usageRefresher.refreshAll(options);
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
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
  usageRefreshConcurrency,
  usageRefreshRequestSpacingMs,
  logger,
}) {
  let inFlight = null;
  let attempted = false;
  const refreshAll = async ({ afterCurrent = false } = {}) => {
    if (inFlight) {
      if (!afterCurrent) return inFlight;
      const current = inFlight;
      try {
        await current;
      } catch {}
      return refreshAll();
    }
    inFlight = refreshAllOnce({
      accountManager,
      secretStore,
      tokenRefresher,
      currentCredentialReader,
      currentProfileFetcher,
      usageFetcher,
      allowLiveClaudeCodeCredentials,
      usageRequestOptions,
      usageObservationTracker,
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

function createUsageObservationTracker() {
  let nextGeneration = 0;
  const states = new WeakMap();

  const stateFor = account => {
    let state = states.get(account);
    if (!state) {
      state = {
        latestStarted: 0,
        latestSuccessful: 0,
        pending: new Set(),
        fieldGenerations: new Map(),
        fieldEvidence: new Map(),
        deferredFailures: [],
      };
      states.set(account, state);
    }
    return state;
  };

  const settleDeferredFailures = state => {
    const remaining = [];
    for (const deferred of state.deferredFailures) {
      if (state.latestSuccessful > deferred.generation) continue;
      if ([...state.pending].some(generation => generation > deferred.generation)) {
        remaining.push(deferred);
        continue;
      }
      deferred.applyFailure();
    }
    state.deferredFailures = remaining;
  };

  return {
    start(account, accessToken = null) {
      nextGeneration += 1;
      const state = stateFor(account);
      state.latestStarted = nextGeneration;
      state.pending.add(nextGeneration);
      return {
        account,
        generation: nextGeneration,
        credentialFingerprint: usageCredentialFingerprint(accessToken),
        completed: false,
      };
    },
    bindCredential(observation, accessToken) {
      if (observation.completed) return;
      observation.credentialFingerprint = usageCredentialFingerprint(accessToken);
    },
    apply(observation, usage, applyUsage) {
      if (observation.completed) return observation.result;
      const state = stateFor(observation.account);
      const fields = usageObservationFields(usage);
      const acceptedFields = new Set();
      const scopedSnapshotGeneration = state.fieldGenerations.get(
        SCOPED_USAGE_SNAPSHOT_FIELD,
      ) || 0;
      const newerScopedFields = [...state.fieldGenerations.entries()]
        .filter(([field, generation]) => (
          isScopedUsageField(field) && generation > observation.generation
        ))
        .map(([field]) => field);
      for (const [field, evidence] of fields) {
        if (field === SCOPED_USAGE_SNAPSHOT_FIELD) continue;
        if (
          isScopedUsageField(field)
          && observation.generation < scopedSnapshotGeneration
        ) continue;
        if (observation.generation < (state.fieldGenerations.get(field) || 0)) continue;
        acceptedFields.add(field);
      }
      if (
        fields.has(SCOPED_USAGE_SNAPSHOT_FIELD)
        && observation.generation >= scopedSnapshotGeneration
      ) {
        acceptedFields.add(SCOPED_USAGE_SNAPSHOT_FIELD);
        if (newerScopedFields.length > 0) {
          acceptedFields.add(SCOPED_USAGE_MERGE_FIELD);
          for (const field of newerScopedFields) {
            acceptedFields.add(
              `${SCOPED_USAGE_PRESERVE_PREFIX}${scopedUsageIdentityFromField(field)}`,
            );
          }
        }
      }
      if (acceptedFields.size > 0) applyUsage(acceptedFields);
      if (acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD)) {
        const preserved = new Set(newerScopedFields);
        for (const field of state.fieldGenerations.keys()) {
          if (
            isScopedUsageField(field)
            && !preserved.has(field)
            && !acceptedFields.has(field)
          ) state.fieldGenerations.delete(field);
        }
        for (const field of state.fieldEvidence.keys()) {
          if (
            isScopedUsageField(field)
            && !preserved.has(field)
            && !acceptedFields.has(field)
          ) state.fieldEvidence.delete(field);
        }
      }
      for (const field of acceptedFields) {
        if (!fields.has(field)) continue;
        state.fieldGenerations.set(field, observation.generation);
        state.fieldEvidence.set(field, {
          generation: observation.generation,
          credentialFingerprint: observation.credentialFingerprint,
          evidence: fields.get(field),
        });
      }
      state.latestSuccessful = Math.max(state.latestSuccessful, observation.generation);
      state.pending.delete(observation.generation);
      observation.completed = true;
      observation.result = { acceptedFields };
      settleDeferredFailures(state);
      return observation.result;
    },
    fail(observation) {
      if (observation.completed) return;
      const state = stateFor(observation.account);
      state.pending.delete(observation.generation);
      observation.completed = true;
      settleDeferredFailures(state);
    },
    deferFailure(observation, applyFailure) {
      const state = stateFor(observation.account);
      if (state.latestSuccessful > observation.generation) return true;
      if ([...state.pending].some(generation => generation > observation.generation)) {
        state.deferredFailures.push({
          generation: observation.generation,
          applyFailure,
        });
        return true;
      }
      return false;
    },
    hasNewerStarted(observation) {
      return observation.generation < stateFor(observation.account).latestStarted;
    },
    newerSuccessfulEvidence(observation) {
      const state = stateFor(observation.account);
      if (
        state.latestSuccessful <= observation.generation
        || state.latestSuccessful !== state.latestStarted
      ) return null;
      const fieldEvidence = [...state.fieldEvidence.entries()]
        .filter(([, value]) => value.generation === state.latestSuccessful);
      if (
        !observation.credentialFingerprint
        || fieldEvidence.some(([, value]) => (
          value.credentialFingerprint !== observation.credentialFingerprint
        ))
      ) return null;
      return {
        generation: state.latestSuccessful,
        evidence: fieldEvidence.map(([field, value]) => [field, value.evidence]),
      };
    },
    currentSuccessfulEvidence(account, generation, credentialFingerprint = null) {
      const state = stateFor(account);
      if (state.latestStarted !== generation || state.latestSuccessful !== generation) return [];
      return [...state.fieldEvidence.entries()]
        .filter(([, value]) => (
          value.generation === generation
          && (!credentialFingerprint || value.credentialFingerprint === credentialFingerprint)
        ))
        .map(([field, value]) => [field, value.evidence]);
    },
  };
}

function createReactiveQuotaConfirmer({
  accountManager,
  secretStore,
  currentCredentialReader,
  usageFetcher,
  usageRequestOptions,
  usageObservationTracker,
  allowLiveClaudeCodeCredentials = true,
  timeoutMs,
  logger,
}) {
  const inFlight = new WeakMap();

  const fetchAndApply = ({ account, accessToken }) => {
    let accountFlights = inFlight.get(account);
    if (!accountFlights) {
      accountFlights = new Map();
      inFlight.set(account, accountFlights);
    }
    const existing = accountFlights.get(accessToken);
    if (existing) return existing;

    const observation = usageObservationTracker.start(account, accessToken);
    const entry = {
      abortController: new AbortController(),
      completed: false,
      deadline: null,
      expired: false,
      request: null,
      waiters: 0,
    };
    entry.request = Promise.resolve()
      .then(() => {
        if (!accountManager.accounts.includes(account)) {
          const error = new Error('Reactive quota account changed before usage confirmation');
          error.code = 'REACTIVE_QUOTA_ACCOUNT_STALE';
          throw error;
        }
        return Promise.all([
          usageFetcher(accessToken, {
            ...usageRequestOptions,
            timeoutMs,
            connectTimeoutMs: Math.min(
              Number(usageRequestOptions.connectTimeoutMs) || timeoutMs,
              timeoutMs,
            ),
            connectRetries: 0,
            connectRetryDelayMs: 0,
            signal: entry.abortController.signal,
          }),
          snapshotKnownAvailableAlternates({
            accountManager,
            account,
            secretStore,
            currentCredentialReader,
            allowLiveClaudeCodeCredentials,
            signal: entry.abortController.signal,
          }),
        ]);
      })
      .then(([usage, replayTargets]) => {
        if (entry.expired || !accountManager.accounts.includes(account)) {
          usageObservationTracker.fail(observation);
          return { applied: false, stale: true };
        }
        const safeUsage = safeUsageObservation(
          usage,
          accountManager.switchThreshold,
          accountManager.now(),
        );
        const result = usageObservationTracker.apply(observation, safeUsage, acceptedFields => {
          accountManager.applyUsage(
            account.id,
            usagePayloadForFields(safeUsage, acceptedFields, account),
          );
        });
        return {
          observation,
          safeUsage,
          result,
          replayTargets,
          stale: false,
        };
      }, error => {
        usageObservationTracker.fail(observation);
        entry.abortController.abort();
        throw error;
      });
    accountFlights.set(accessToken, entry);
    entry.expire = () => {
      if (entry.completed || entry.expired) return;
      entry.expired = true;
      if (accountFlights.get(accessToken) === entry) accountFlights.delete(accessToken);
      if (accountFlights.size === 0 && inFlight.get(account) === accountFlights) {
        inFlight.delete(account);
      }
      usageObservationTracker.fail(observation);
      entry.abortController.abort();
    };
    entry.deadline = withDeadline(entry.request, timeoutMs, entry.expire);
    const cleanup = () => {
      entry.completed = true;
      if (accountFlights.get(accessToken) === entry) accountFlights.delete(accessToken);
      if (accountFlights.size === 0 && inFlight.get(account) === accountFlights) {
        inFlight.delete(account);
      }
    };
    entry.request.then(
      () => {
        entry.completed = true;
        const timer = setTimeout(cleanup, REACTIVE_QUOTA_SINGLE_FLIGHT_GRACE_MS);
        timer.unref?.();
      },
      cleanup,
    );
    return entry;
  };

  return {
    async confirm({
      account,
      accessToken,
      requestBody,
      clientRequest = null,
      clientResponse = null,
    }) {
      const modelFamily = requestModelFamily(requestBody);
      let clientAborted = false;
      let entry = null;
      try {
        entry = fetchAndApply({ account, accessToken });
        entry.waiters += 1;
        const result = await waitForClientOrPromise(
          entry.deadline,
          clientRequest,
          clientResponse,
          () => { clientAborted = true; },
        );
        if (
          entry.expired
          || result.stale
          || !accountManager.accounts.includes(account)
        ) return { confirmed: false, replayTargets: new Set() };
        const directEvidence = !usageObservationTracker.hasNewerStarted(result.observation)
          && usageEvidenceConfirmsRequest(
            usageObservationFields(result.safeUsage),
            REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
            modelFamily,
            accountManager.now(),
          );
        const newerObservation = usageObservationTracker.newerSuccessfulEvidence(
          result.observation,
        );
        const newerEvidence = usageEvidenceConfirmsRequest(
          newerObservation?.evidence || [],
          REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
          modelFamily,
          accountManager.now(),
        );
        const authorizationGeneration = directEvidence
          ? result.observation.generation
          : (newerEvidence ? newerObservation.generation : null);
        const replayTargets = authorizationGeneration == null
          ? new Map()
          : result.replayTargets;
        const confirmed = replayTargets.size > 0;
        logger?.(`${new Date().toISOString()} reactive-quota-confirmation account=${account.id} model=${modelFamily || 'unknown'} result=${confirmed ? 'confirmed' : 'not-confirmed'}`);
        return {
          confirmed,
          replayTargets,
          replayAuthorization: confirmed ? {
            source: account,
            generation: authorizationGeneration,
            credentialFingerprint: result.observation.credentialFingerprint,
            modelFamily,
          } : null,
        };
      } catch (error) {
        logger?.(`${new Date().toISOString()} reactive-quota-confirmation account=${account.id} model=${modelFamily || 'unknown'} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
        return { confirmed: false, replayTargets: new Map(), replayAuthorization: null };
      } finally {
        if (entry) {
          entry.waiters = Math.max(0, entry.waiters - 1);
          if (clientAborted && entry.waiters === 0) entry.expire();
        }
      }
    },
    isReplayAuthorized(authorization) {
      if (!authorization || !accountManager.accounts.includes(authorization.source)) return false;
      const nowMs = accountManager.now();
      const evidence = usageObservationTracker.currentSuccessfulEvidence(
        authorization.source,
        authorization.generation,
        authorization.credentialFingerprint,
      );
      return usageEvidenceConfirmsRequest(
        evidence,
        REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
        authorization.modelFamily,
        nowMs,
      ) && accountQuotaConfirmsModelFamily(
        authorization.source,
        authorization.modelFamily,
        REACTIVE_QUOTA_EXHAUSTION_THRESHOLD,
        nowMs,
      );
    },
  };
}

function waitForClientOrPromise(promise, req, res, onClientAbort) {
  if (!req || !res) return promise;
  if (req.aborted || res.destroyed) {
    onClientAbort?.();
    return Promise.reject(clientRequestAbortedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      req.removeListener('aborted', abort);
      res.removeListener('close', close);
    };
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => {
      onClientAbort?.();
      settle(clientRequestAbortedError());
    };
    const close = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', close);
    if (req.aborted || res.destroyed) {
      abort();
      return;
    }
    promise.then(value => settle(null, value), error => settle(error));
  });
}

function clientRequestAbortedError() {
  const error = new Error('Client request aborted');
  error.code = 'CLIENT_REQUEST_ABORTED';
  return error;
}

function withDeadline(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      const error = new Error(`Reactive quota confirmation timed out after ${timeoutMs}ms`);
      error.code = 'REACTIVE_QUOTA_CONFIRM_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function positiveTimeoutOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, fallback)
    : fallback;
}

function requestModelFamily(body) {
  try {
    const model = JSON.parse(body.toString('utf8'))?.model;
    return isCanonicalFableModelId(model) ? 'fable' : null;
  } catch {
    return null;
  }
}

function isCanonicalFableModelId(value) {
  return value === 'claude-fable-5';
}

function safeUsageObservation(usage, threshold, nowMs) {
  const safe = {};
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'five_hour')) {
    const fiveHour = safeUsageBucket(usage.five_hour, threshold, nowMs);
    if (fiveHour.accepted) safe.five_hour = fiveHour.value;
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'seven_day')) {
    const sevenDay = safeUsageBucket(usage.seven_day, threshold, nowMs);
    if (sevenDay.accepted) safe.seven_day = sevenDay.value;
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'scoped_weekly')) {
    const scopedIsArray = Array.isArray(usage.scoped_weekly);
    const scopedResults = (scopedIsArray ? usage.scoped_weekly : [])
      .map(limit => safeScopedUsageBucket(limit, threshold, nowMs));
    const acceptedScopedResults = scopedResults.filter(result => result.accepted);
    if (
      scopedIsArray
      && (usage.scoped_weekly.length === 0 || acceptedScopedResults.length > 0)
    ) {
      safe.scopedWeeklyFields = acceptedScopedResults.map(result => ({
        field: scopedUsageField(result.limit),
        value: result.value,
      }));
      safe.scoped_weekly = acceptedScopedResults
        .map(result => result.value)
        .filter(Boolean);
      safe.scopedWeeklyComplete = scopedResults.every(result => result.accepted);
    }
  }
  return safe;
}

function safeUsageBucket(bucket, threshold, nowMs) {
  if (bucket == null) return { accepted: true, value: null };
  const utilization = typeof bucket?.utilization === 'number'
    ? bucket.utilization
    : Number.NaN;
  if (!Number.isFinite(utilization)) return { accepted: false, value: null };
  const resetAt = Date.parse(bucket?.resets_at);
  if (utilization >= threshold && (!Number.isFinite(resetAt) || resetAt <= nowMs)) {
    return { accepted: true, value: null };
  }
  return {
    accepted: true,
    value: {
      utilization,
      resets_at: Number.isFinite(resetAt) ? new Date(resetAt).toISOString() : null,
    },
  };
}

function safeScopedUsageBucket(limit, threshold, nowMs) {
  if (!limit || typeof limit !== 'object') return { accepted: false, value: null };
  const bucket = safeUsageBucket(limit, threshold, nowMs);
  if (!bucket.accepted) return { accepted: false, value: null };
  if (bucket.value == null) return { accepted: true, limit, value: null };
  return {
    accepted: true,
    limit,
    value: {
      key: limit?.key,
      label: limit?.label,
      ...bucket.value,
    },
  };
}

function usageObservationFields(usage) {
  const fields = new Map([['auth', true]]);
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'five_hour')) {
    fields.set('five_hour', usage.five_hour);
  }
  if (Object.prototype.hasOwnProperty.call(usage || {}, 'seven_day')) {
    fields.set('seven_day', usage.seven_day);
  }
  for (const scopedField of usage?.scopedWeeklyFields || []) {
    fields.set(scopedField.field, scopedField.value);
  }
  if (usage?.scopedWeeklyComplete) {
    fields.set(SCOPED_USAGE_SNAPSHOT_FIELD, usage.scoped_weekly);
  }
  return fields;
}

function usagePayloadForFields(usage, acceptedFields, account = null) {
  const payload = {};
  if (acceptedFields.has('five_hour')) payload.five_hour = usage.five_hour;
  if (acceptedFields.has('seven_day')) payload.seven_day = usage.seven_day;
  const acceptedScopedFields = [...acceptedFields].filter(isScopedUsageField);
  if (
    acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD)
    && !acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)
  ) {
    payload.scoped_weekly = usage.scoped_weekly;
  } else if (
    acceptedScopedFields.length > 0
    || acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)
  ) {
    payload.scoped_weekly = mergeAcceptedScopedUsage({
      existing: account?.quota?.weeklyScoped,
      observedFields: usage.scopedWeeklyFields,
      acceptedFields,
      replace: acceptedFields.has(SCOPED_USAGE_SNAPSHOT_FIELD),
    });
  }
  return payload;
}

function mergeAcceptedScopedUsage({ existing, observedFields, acceptedFields, replace }) {
  const merged = new Map();
  if (!replace) {
    for (const limit of Array.isArray(existing) ? existing : []) {
      merged.set(scopedUsageIdentity(limit), limit);
    }
  }
  for (const observed of observedFields || []) {
    if (!acceptedFields.has(observed.field)) continue;
    const identity = scopedUsageIdentityFromField(observed.field);
    if (observed.value == null) merged.delete(identity);
    else merged.set(identity, observed.value);
  }
  if (replace && acceptedFields.has(SCOPED_USAGE_MERGE_FIELD)) {
    for (const limit of Array.isArray(existing) ? existing : []) {
      const identity = scopedUsageIdentity(limit);
      if (acceptedFields.has(`${SCOPED_USAGE_PRESERVE_PREFIX}${identity}`)) {
        merged.set(identity, limit);
      }
    }
  }
  return [...merged.values()];
}

function scopedUsageField(limit) {
  return `${SCOPED_USAGE_FIELD_PREFIX}${scopedUsageIdentity(limit)}`;
}

function isScopedUsageField(field) {
  return typeof field === 'string'
    && field.startsWith(SCOPED_USAGE_FIELD_PREFIX)
    && field !== SCOPED_USAGE_SNAPSHOT_FIELD;
}

function scopedUsageIdentityFromField(field) {
  return field.slice(SCOPED_USAGE_FIELD_PREFIX.length);
}

function scopedUsageIdentity(limit) {
  const value = String(limit?.key || limit?.label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return isExactFableScopeIdentity(value) ? 'fable' : (value || 'scoped');
}

function usageEvidenceConfirmsRequest(fields, threshold, modelFamily, nowMs) {
  for (const [field, evidence] of fields) {
    if (
      (field === 'five_hour' || field === 'seven_day')
      && usageBucketConfirmsQuota(evidence, threshold, nowMs)
    ) return true;
    if (
      isScopedUsageField(field)
      && modelFamily
      && scopedUsageMatchesModelFamily(evidence, modelFamily)
      && usageBucketConfirmsQuota(evidence, threshold, nowMs)
    ) return true;
  }
  return false;
}

function usageBucketConfirmsQuota(bucket, threshold, nowMs) {
  const utilization = Number(bucket?.utilization);
  const rawResetAt = bucket?.resets_at ?? bucket?.resetAt;
  const resetAt = typeof rawResetAt === 'number' ? rawResetAt : Date.parse(rawResetAt);
  return Number.isFinite(utilization)
    && utilization >= threshold
    && Number.isFinite(resetAt)
    && resetAt > nowMs;
}

function accountQuotaConfirmsModelFamily(account, modelFamily, threshold, nowMs) {
  const quota = account?.quota || {};
  if (usageBucketConfirmsQuota({
    utilization: quota.unified5h,
    resetAt: quota.unified5hReset,
  }, threshold, nowMs)) return true;
  if (usageBucketConfirmsQuota({
    utilization: quota.unified7d,
    resetAt: quota.unified7dReset,
  }, threshold, nowMs)) return true;
  return modelFamily === 'fable'
    && Array.isArray(quota.weeklyScoped)
    && quota.weeklyScoped.some(limit => (
      scopedUsageMatchesModelFamily(limit, modelFamily)
      && usageBucketConfirmsQuota(limit, threshold, nowMs)
    ));
}

function scopedUsageMatchesModelFamily(limit, modelFamily) {
  if (modelFamily !== 'fable') return false;
  const key = String(limit?.key || '').trim().toLowerCase();
  if (key) return isExactFableScopeIdentity(key);
  const label = String(limit?.label || '').trim().toLowerCase();
  return isExactFableScopeIdentity(label);
}

function isExactFableScopeIdentity(value) {
  return [
    'fable',
    'fable 5',
    'fable_5',
    'claude-fable-5',
    'claude_fable_5',
  ].includes(String(value || '').trim().toLowerCase());
}

function unifiedQuotaHeaderEvidence(headers, threshold, nowMs) {
  const parsed = parseRateLimitHeaders(headers);
  const windows = [
    [parsed.unified5h, parsed.unified5hReset],
    [parsed.unified7d, parsed.unified7dReset],
  ];
  const confirmsExhaustion = windows.some(([utilization, resetAt]) => (
    Number.isFinite(utilization)
    && utilization >= threshold
    && Number.isFinite(resetAt)
    && resetAt > nowMs
  ));
  const hasIncompleteExhaustion = windows.some(([utilization, resetAt]) => (
    Number.isFinite(utilization)
    && utilization >= threshold
    && (!Number.isFinite(resetAt) || resetAt <= nowMs)
  ));
  return { confirmsExhaustion, hasIncompleteExhaustion };
}

async function snapshotKnownAvailableAlternates({
  accountManager,
  account,
  secretStore,
  currentCredentialReader,
  allowLiveClaudeCodeCredentials = true,
  signal = null,
}) {
  throwIfOperationAborted(signal);
  const candidates = accountManager.accounts.filter(candidate => (
    candidate !== account
    && accountManager.isAvailable(candidate)
    && accountManager.switchTargetScore(candidate) != null
  ));
  const snapshots = await Promise.all(candidates.map(async candidate => {
    const secret = await resolveReactiveReplaySecret({
      account: candidate,
      secretStore,
      currentCredentialReader,
      allowLiveClaudeCodeCredentials,
      signal,
    });
    throwIfOperationAborted(signal);
    if (!stableReactiveReplaySecret(candidate, secret)) return null;
    return [candidate, {
      credentialRevision: candidate.credentialRevision,
      credentialFingerprint: replayCredentialFingerprint(candidate, secret),
    }];
  }));
  return new Map(snapshots.filter(Boolean));
}

async function resolveReactiveReplaySecret({
  account,
  secretStore,
  currentCredentialReader,
  allowLiveClaudeCodeCredentials = true,
  signal = null,
}) {
  throwIfOperationAborted(signal);
  if (account.id === 'current' || account.credentialSource === 'claude-code-current') {
    if (!allowLiveClaudeCodeCredentials) {
      throw new Error('Live current account is unavailable while Claude login is overridden');
    }
    const secret = await liveClaudeCodeSecret(currentCredentialReader);
    throwIfOperationAborted(signal);
    return secret;
  }
  const secret = await getOperationalSecret(secretStore, account.id);
  throwIfOperationAborted(signal);
  return secret;
}

function validReactiveReplayTarget({
  accountManager,
  reactiveQuotaConfirmer,
  authorization,
  source,
  targets,
  candidate,
  secret = null,
}) {
  const snapshot = targets?.get(candidate);
  return Boolean(
    source
    && candidate
    && snapshot
    && accountManager.accounts.includes(source)
    && accountManager.accounts.includes(candidate)
    && accountManager.isAvailable(candidate)
    && accountManager.switchTargetScore(candidate) != null
    && candidate.credentialRevision === snapshot.credentialRevision
    && (!secret || (
      stableReactiveReplaySecret(candidate, secret)
      && replayCredentialFingerprint(candidate, secret) === snapshot.credentialFingerprint
    ))
    && reactiveQuotaConfirmer?.isReplayAuthorized(authorization)
  );
}

function stableReactiveReplaySecret(account, secret) {
  if (account.type === 'apikey') return Boolean(secret?.apiKey);
  return hasUsableAccessToken(secret)
    && !(canRefreshSecret(account, secret) && isTokenExpiringSoon(secret.expiresAt));
}

function replayCredentialFingerprint(account, secret) {
  return credentialFingerprint(
    account.type === 'apikey' ? 'apikey' : 'oauth',
    account.type === 'apikey' ? secret?.apiKey : secret?.accessToken,
  );
}

async function refreshAllOnce({
  accountManager,
  secretStore,
  tokenRefresher,
  currentCredentialReader,
  currentProfileFetcher,
  usageFetcher,
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
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
      allowLiveClaudeCodeCredentials,
      usageRequestOptions,
      usageObservationTracker,
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
  allowLiveClaudeCodeCredentials,
  usageRequestOptions,
  usageObservationTracker,
  logger,
}) {
  if (account.type === 'apikey') return { account: account.id, ok: true, skipped: 'apikey' };
  const observation = usageObservationTracker.start(account);

  try {
    const secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      allowLiveClaudeCodeCredentials,
      logger,
    });
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    if (!secret?.accessToken) throw new Error('OAuth access token is missing');
    const credentialCooldown = isCredentialRefreshCooldown(accountManager.unavailableReason(account));
    if (credentialCooldown && !hasUsableAccessToken(secret)) {
      usageObservationTracker.fail(observation);
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
    usageObservationTracker.bindCredential(observation, freshSecret.accessToken);
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    const usage = await usageFetcher(freshSecret.accessToken, usageRequestOptions);
    if (!accountManager.accounts.includes(account)) {
      usageObservationTracker.fail(observation);
      return { account: account.id, ok: true, stale: true };
    }
    const safeUsage = safeUsageObservation(
      usage,
      accountManager.switchThreshold,
      accountManager.now(),
    );
    const result = usageObservationTracker.apply(observation, safeUsage, acceptedFields => {
      accountManager.applyUsage(
        account.id,
        usagePayloadForFields(safeUsage, acceptedFields, account),
      );
    });
    return {
      account: account.id,
      ok: true,
      ...(result.acceptedFields.size > 0 ? {} : { stale: true }),
    };
  } catch (caught) {
    const message = shortErrorMessage(caught);
    logger?.(`${new Date().toISOString()} usage-refresh account=${account.id} result=failed errorType=${usageRefreshErrorType(caught)}`);
    usageObservationTracker.fail(observation);
    if (!accountManager.accounts.includes(account)) {
      return { account: account.id, ok: false, stale: true, error: message };
    }
    const applyFailure = () => {
      if (!accountManager.accounts.includes(account)) return;
      const refreshUnavailable = markOAuthRefreshUnavailable(accountManager, account.id, caught);
      if (!refreshUnavailable && isOAuthCredentialError(message, caught)) {
        accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
      }
    };
    const deferred = usageObservationTracker.deferFailure(observation, applyFailure);
    if (!deferred) applyFailure();
    return {
      account: account.id,
      ok: false,
      ...(deferred ? { stale: true } : {}),
      error: message,
    };
  }
}

function rebalanceAfterUsageRefresh(accountManager) {
  accountManager.rebalanceActiveAccount();
}

function isOAuthCredentialError(message, error = null) {
  return error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
    || /OAuth access token is missing|Token refresh failed|Usage fetch failed \(401\)/.test(String(message || ''));
}

function markOAuthRefreshUnavailable(accountManager, accountId, error) {
  const retryAfterSeconds = Math.max(1, Math.ceil(Number(error?.retryAfterMs) / 1000) || 1);
  if (isOAuthTokenRefreshRateLimit(error)) {
    accountManager.markCredentialRefreshRateLimited(accountId, retryAfterSeconds, {
      retryAfterSource: error.retryAfterSource,
    });
    return true;
  }
  if (!(Number.isFinite(Number(error?.retryAfterMs)) && Number(error.retryAfterMs) > 0)) return false;
  accountManager.markCredentialRefreshDeferred(accountId, retryAfterSeconds, {
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
  reactiveQuotaConfirmer,
  allowLiveClaudeCodeCredentials,
  logger,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
}) {
  const maxAttempts = Math.max(1, accountManager.accounts.length);
  const attemptedAccountIds = new Set();
  let lastRetryableResponse = null;
  let reactiveQuotaRetryUsed = false;
  let reactiveQuotaSource = null;
  let reactiveReplayTargets = null;
  let reactiveReplayAuthorization = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (req.aborted || res.destroyed) return;
    const reactiveSelection = reactiveQuotaRetryUsed
      ? accountManager.bestAvailableSwitchCandidate({
        excludeCurrent: false,
        allowedAccounts: new Set(reactiveReplayTargets?.keys() || []),
      })
      : null;
    const account = reactiveQuotaRetryUsed
      ? reactiveSelection?.account
      : accountManager.getActiveAccount();
    if (!account) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendBufferedResponse(res, lastRetryableResponse);
        return;
      }
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
        allowLiveClaudeCodeCredentials,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
      })) return;
      sendUnavailableAccounts(res, accountManager);
      return;
    }

    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
      })
    ) {
      if (lastRetryableResponse) sendBufferedResponse(res, lastRetryableResponse);
      else sendUnavailableAccounts(res, accountManager);
      return;
    }

    let secret;
    try {
      secret = reactiveQuotaRetryUsed
        ? await resolveReactiveReplaySecret({
          account,
          secretStore,
          currentCredentialReader,
          allowLiveClaudeCodeCredentials,
        })
        : await resolveSecretForAccount({
          account,
          secretStore,
          currentCredentialReader,
          currentProfileFetcher,
          allowLiveClaudeCodeCredentials,
          logger,
        });
    } catch (error) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        if (req.aborted || res.destroyed) return;
        sendBufferedResponse(res, lastRetryableResponse);
        return;
      }
      if (error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN') {
        if (!markOAuthRefreshUnavailable(accountManager, account.id, error)) {
          accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        }
        continue;
      }
      throw error;
    }
    if (req.aborted || res.destroyed) return;
    if (!accountManager.accounts.includes(account)) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendBufferedResponse(res, lastRetryableResponse);
        return;
      }
      continue;
    }
    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
        secret,
      })
    ) {
      sendBufferedResponse(res, lastRetryableResponse);
      return;
    }
    if (!secret) {
      accountManager.markError(account.id, 'credential_missing', 'No stored credential for account');
      continue;
    }

    let freshSecret = secret;
    if (!reactiveQuotaRetryUsed) {
      try {
        freshSecret = await refreshSecretIfExpiring({
          account,
          secret,
          secretStore,
          tokenRefresher,
          logger,
        });
      } catch (caught) {
        if (!accountManager.accounts.includes(account)) continue;
        if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
          accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        }
        continue;
      }
    }

    if (req.aborted || res.destroyed) return;
    if (!accountManager.accounts.includes(account)) {
      if (reactiveQuotaRetryUsed && lastRetryableResponse) {
        sendBufferedResponse(res, lastRetryableResponse);
        return;
      }
      continue;
    }
    if (
      reactiveQuotaRetryUsed
      && !validReactiveReplayTarget({
        accountManager,
        reactiveQuotaConfirmer,
        authorization: reactiveReplayAuthorization,
        source: reactiveQuotaSource,
        targets: reactiveReplayTargets,
        candidate: account,
        secret: freshSecret,
      })
    ) {
      sendBufferedResponse(res, lastRetryableResponse);
      return;
    }
    if (attemptedAccountIds.has(account.id)) {
      if (lastRetryableResponse) sendBufferedResponse(res, lastRetryableResponse);
      else sendUnavailableAccounts(res, accountManager);
      return;
    }
    attemptedAccountIds.add(account.id);
    if (reactiveQuotaRetryUsed) {
      accountManager.switchToCandidate(reactiveSelection, 'quota-threshold');
    }

    const result = await forwardOnce({
      req,
      res,
      body,
      upstream,
      account,
      secret: freshSecret,
      accountManager,
      reactiveQuotaConfirmer,
      allowReactiveQuotaConfirmation: !reactiveQuotaRetryUsed,
      allowQuotaRetry: !reactiveQuotaRetryUsed,
      allowAuthRefreshRetry: !reactiveQuotaRetryUsed,
      logger,
      upstreamIdleTimeoutMs,
      upstreamConnectTimeoutMs,
      upstreamConnectRetries,
      upstreamConnectRetryDelayMs,
    });
    if (!accountManager.accounts.includes(account)) {
      finishStaleAccountResponse(res, result.passthroughResponse);
      return;
    }
    if (result.retryAfterRefresh) {
      if (req.aborted || res.destroyed) return;
      if (!accountManager.accounts.includes(account)) continue;
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
        if (!accountManager.accounts.includes(account)) continue;
        if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
          accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
        }
        continue;
      }
      if (req.aborted || res.destroyed) return;
      if (!accountManager.accounts.includes(account)) continue;
      const retryResult = await forwardOnce({
        req,
        res,
        body,
        upstream,
        account,
        secret: refreshedSecret,
        accountManager,
        reactiveQuotaConfirmer,
        allowReactiveQuotaConfirmation: !reactiveQuotaRetryUsed,
        allowQuotaRetry: !reactiveQuotaRetryUsed,
        allowAuthRefreshRetry: !reactiveQuotaRetryUsed,
        logger,
        upstreamIdleTimeoutMs,
        upstreamConnectTimeoutMs,
        upstreamConnectRetries,
        upstreamConnectRetryDelayMs,
      });
      if (!accountManager.accounts.includes(account)) {
        finishStaleAccountResponse(res, retryResult.passthroughResponse);
        return;
      }
      if (retryResult.retryAfterRefresh) {
        if (!accountManager.accounts.includes(account)) continue;
        accountManager.markError(account.id, 'authentication_error', 'OAuth token rejected');
        continue;
      }
      if (retryResult.retryNextAccount) {
        if (retryResult.reactiveQuotaRetry) {
          reactiveQuotaRetryUsed = true;
          reactiveQuotaSource = retryResult.reactiveQuotaSource;
          reactiveReplayTargets = retryResult.reactiveReplayTargets;
          reactiveReplayAuthorization = retryResult.reactiveReplayAuthorization;
        }
        lastRetryableResponse = retryResult.passthroughResponse || retryResult.syntheticResponse || lastRetryableResponse;
        if (req.aborted || res.destroyed) return;
        continue;
      }
      return;
    }
    if (result.retryNextAccount) {
      if (result.reactiveQuotaRetry) {
        reactiveQuotaRetryUsed = true;
        reactiveQuotaSource = result.reactiveQuotaSource;
        reactiveReplayTargets = result.reactiveReplayTargets;
        reactiveReplayAuthorization = result.reactiveReplayAuthorization;
      }
      lastRetryableResponse = result.passthroughResponse || result.syntheticResponse || lastRetryableResponse;
      if (req.aborted || res.destroyed) return;
      continue;
    }
    return;
  }

  if (!res.headersSent) {
    if (reactiveQuotaRetryUsed && lastRetryableResponse) {
      sendBufferedResponse(res, lastRetryableResponse);
      return;
    }
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
      allowLiveClaudeCodeCredentials,
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
  allowLiveClaudeCodeCredentials,
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

  let secret;
  try {
    secret = await resolveSecretForAccount({
      account,
      secretStore,
      currentCredentialReader,
      currentProfileFetcher,
      allowLiveClaudeCodeCredentials,
      logger,
    });
  } catch (caught) {
    if (caught?.code !== 'NATIVE_REFRESH_OUTCOME_UNKNOWN') throw caught;
    if (!markOAuthRefreshUnavailable(accountManager, account.id, caught)) {
      accountManager.markError(account.id, 'oauth_refresh_failed', 'OAuth token refresh failed');
    }
    return false;
  }
  if (req.aborted || res.destroyed || !accountManager.accounts.includes(account)) return false;
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
  if (req.aborted || res.destroyed || !accountManager.accounts.includes(account)) return false;

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
    if (error?.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN') throw error;
    if (!hasUsableAccessToken(secret)) throw error;
    const expiresAt = normalizeCredentialExpiry(secret.expiresAt);
    const remainingSec = expiresAt == null ? 'unknown' : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    logger?.(`${new Date().toISOString()} credential-refresh-fallback account=${account.id} remainingSec=${remainingSec} errorType=${credentialRefreshErrorType(error)}`);
    return secret;
  }
}

async function refreshAndStoreSecret({ account, secret, secretStore, tokenRefresher, logger }) {
  const refreshIfUnchanged = requireSecretStoreRefreshIfUnchanged(secretStore);
  try {
    const result = await refreshIfUnchanged(account.id, secret, async (currentSecret, transaction) => ({
      ...currentSecret,
      ...(await tokenRefresher(
        currentSecret.refreshToken,
        tokenRefreshContext(account, currentSecret, transaction),
      )),
    }));
    if (!result.updated) {
      logger?.(`${new Date().toISOString()} credential-refresh account=${account.id} result=discarded reason=credential-changed`);
      if (result.secret?.accessToken) return result.secret;
      throw new Error('Stored OAuth credential changed while token refresh was in flight');
    }
    return result.secret;
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-store account=${account.id} result=failed errorType=${error?.code || error?.name || 'unknown'}`);
    throw error;
  }
}

function tokenRefreshContext(account, secret, transaction = {}) {
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
    beforeHandoff: transaction.beforeHandoff,
    retractHandoff: transaction.retractHandoff,
    protectChildPid: transaction.protectChildPid,
    clearChildPid: transaction.clearChildPid,
  };
}

function credentialRefreshErrorType(error) {
  const message = String(error?.message || '');
  if (/invalid_grant/i.test(message)) return 'invalid_grant';
  const status = message.match(/Token refresh failed \((\d+)\)/)?.[1];
  return status ? `http-${status}` : (error?.code || error?.name || 'unknown');
}

function usageRefreshErrorType(error) {
  const status = String(error?.message || '').match(/Usage fetch failed \((\d+)\)/)?.[1];
  return status ? `http-${status}` : credentialRefreshErrorType(error);
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
  signal = null,
  liveCredentialLoader = null,
  allowLiveClaudeCodeCredentials = true,
  logger,
}) {
  throwIfOperationAborted(signal);
  if (account.type === 'apikey') {
    const secret = await secretStore.get(account.id);
    throwIfOperationAborted(signal);
    return secret;
  }
  if (account.id === 'current' || account.credentialSource === 'claude-code-current') {
    if (!allowLiveClaudeCodeCredentials) {
      throw new Error('Live current account is unavailable while Claude login is overridden');
    }
    const secret = await liveClaudeCodeSecret(currentCredentialReader);
    throwIfOperationAborted(signal);
    return secret;
  }

  const stored = await getOperationalSecret(secretStore, account.id);
  throwIfOperationAborted(signal);
  if (!allowLiveClaudeCodeCredentials || !account.accountUuid) return stored;

  const current = await (liveCredentialLoader
    ? liveCredentialLoader()
    : liveClaudeCodeCredentialWithProfile({
      currentCredentialReader,
      currentProfileFetcher,
      signal,
    }))
    .catch(() => null);
  throwIfOperationAborted(signal);
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
    signal,
    logger,
  });
  throwIfOperationAborted(signal);
  return current.secret;
}

async function mirrorLiveClaudeCodeCredential({
  account,
  stored,
  live,
  secretStore,
  signal = null,
  logger,
}) {
  throwIfOperationAborted(signal);
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
    const compareAndSet = requireSecretStoreCompareAndSet(secretStore);
    throwIfOperationAborted(signal);
    if (!await compareAndSet(account.id, stored, mirrored)) {
      logger?.(`${new Date().toISOString()} credential-sync-discarded account=${account.id} reason=credential-changed`);
      return;
    }
    logger?.(`${new Date().toISOString()} credential-sync account=${account.id} source=claude-code-current expiresAt=${formatCredentialExpiry(live.expiresAt)}`);
  } catch (error) {
    logger?.(`${new Date().toISOString()} credential-sync-failed account=${account.id} error=${shortErrorMessage(error)}`);
  }
}

function requireSecretStoreCompareAndSet(secretStore) {
  if (typeof secretStore?.compareAndSet !== 'function') {
    const error = new Error('Secret store does not support atomic compare-and-set');
    error.code = 'SECRET_STORE_CAS_UNAVAILABLE';
    throw error;
  }
  return secretStore.compareAndSet.bind(secretStore);
}

function requireSecretStoreRefreshIfUnchanged(secretStore) {
  if (typeof secretStore?.refreshIfUnchanged !== 'function') {
    const error = new Error('Secret store does not support conditional refresh transaction');
    error.code = 'SECRET_STORE_TRANSACTION_UNAVAILABLE';
    throw error;
  }
  return secretStore.refreshIfUnchanged.bind(secretStore);
}

function getOperationalSecret(secretStore, accountId) {
  if (typeof secretStore?.getOperational === 'function') {
    return secretStore.getOperational(accountId);
  }
  return secretStore.get(accountId);
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
  return isCredentialRefreshCooldown(reason)
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
  signal = null,
}) {
  throwIfOperationAborted(signal);
  const now = Date.now();
  if (
    liveClaudeCodeCache
    && liveClaudeCodeCache.currentCredentialReader === currentCredentialReader
    && liveClaudeCodeCache.currentProfileFetcher === currentProfileFetcher
    && liveClaudeCodeCache.expiresAt > now
  ) {
    throwIfOperationAborted(signal);
    return liveClaudeCodeCache.value;
  }

  const secret = await liveClaudeCodeSecret(currentCredentialReader);
  throwIfOperationAborted(signal);
  let profile = null;
  if (secret.accessToken) {
    try {
      profile = await currentProfileFetcher(secret.accessToken, { signal });
    } catch {}
  }
  throwIfOperationAborted(signal);
  const value = { secret, profile };
  liveClaudeCodeCache = {
    currentCredentialReader,
    currentProfileFetcher,
    expiresAt: now + LIVE_CLAUDE_CODE_CACHE_TTL_MS,
    value,
  };
  return value;
}

function usageCredentialFingerprint(accessToken) {
  return credentialFingerprint('oauth', accessToken);
}

function credentialFingerprint(type, credential) {
  if (!credential) return null;
  return createHash('sha256').update(JSON.stringify([type, credential])).digest('hex');
}

function throwIfOperationAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  throw error;
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
  reactiveQuotaConfirmer = null,
  allowReactiveQuotaConfirmation = false,
  allowQuotaRetry = true,
  allowAuthRefreshRetry = true,
  logger = null,
  upstreamIdleTimeoutMs,
  upstreamConnectTimeoutMs,
  upstreamConnectRetries,
  upstreamConnectRetryDelayMs,
}) {
  const target = configuredUpstreamTarget(req.url, upstream);
  const headers = buildUpstreamHeaders(req.headers, account, secret);
  const startedAt = Date.now();
  let outcome = 'ok';
  let bufferedPassthrough = false;
  let reactiveQuotaRetry = false;
  let reactiveQuotaSource = null;
  let reactiveReplayTargets = null;
  let reactiveReplayAuthorization = null;

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
      clientRequest: req,
      clientResponse: res,
      onRetry(error, attempt, maxAttempts) {
        logger?.(`${new Date().toISOString()} upstream-connect-retry account=${account.id} method=${req.method} path=${target.pathname} attempt=${attempt}/${maxAttempts} errorType=${error.code || error.name}`);
      },
      onResponse(upstreamRes) {
        if (!accountManager.accounts.includes(account)) {
          writeUpstreamResponseHead(res, upstreamRes);
          return true;
        }
        const responseQuotaEvidence = unifiedQuotaHeaderEvidence(
          upstreamRes.headers,
          accountManager.switchThreshold,
          accountManager.now(),
        );
        accountManager.updateQuota(account.id, upstreamRes.headers, {
          atomicUnifiedWindows: upstreamRes.statusCode === 429,
        });

        if (!passthroughErrors && upstreamRes.statusCode === 429) {
          const unavailableReason = accountManager.unavailableReason(account);
          if (
            allowQuotaRetry
            && responseQuotaEvidence.confirmsExhaustion
          ) {
            outcome = 'quota-retry';
            return false;
          }
          if (
            allowReactiveQuotaConfirmation
            && reactiveQuotaConfirmer
            && req.method === 'POST'
            && target.pathname === '/v1/messages'
            && account.type !== 'apikey'
            && requestModelFamily(body) === 'fable'
            && !responseQuotaEvidence.hasIncompleteExhaustion
            && typeof secret?.accessToken === 'string'
            && secret.accessToken.length > 0
          ) {
            outcome = 'reactive-quota-pending';
            return false;
          }
          outcome = 'rate-limit-passthrough';
          if (!unavailableReason) {
            accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamRes.headers, 60));
          }
        }

        if (!passthroughErrors && upstreamRes.statusCode === 401) {
          if (allowAuthRefreshRetry && canRefreshSecret(account, secret)) {
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

        writeUpstreamResponseHead(res, upstreamRes);
        return true;
      },
      onChunk(chunk) {
        if (!res.destroyed) res.write(chunk);
      },
    });
  } catch (error) {
    if (error?.code === 'CLIENT_REQUEST_ABORTED' || req.aborted || res.destroyed) {
      return { retryNextAccount: false };
    }
    outcome = isUpstreamTimeout(error) ? 'upstream-timeout' : 'upstream-error';
    if (accountManager.accounts.includes(account)) {
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
    }

    if (!passthroughErrors && !res.headersSent) {
      sendBufferedResponse(res, syntheticUpstreamErrorResponse(error));
      return { retryNextAccount: false };
    }
    throw error;
  }

  if (!accountManager.accounts.includes(account)) {
    finishStaleAccountResponse(res, upstreamResponse);
    return { retryNextAccount: false, passthroughResponse: upstreamResponse };
  }

  if (outcome === 'reactive-quota-pending') {
    const confirmation = !req.aborted && !res.destroyed
      ? await reactiveQuotaConfirmer.confirm({
        account,
        accessToken: secret.accessToken,
        requestBody: body,
        clientRequest: req,
        clientResponse: res,
      })
      : { confirmed: false, replayTargets: new Map(), replayAuthorization: null };
    if (!accountManager.accounts.includes(account)) {
      finishStaleAccountResponse(res, upstreamResponse);
      return { retryNextAccount: false, passthroughResponse: upstreamResponse };
    }
    if (confirmation.confirmed && !req.aborted && !res.destroyed) {
      outcome = 'quota-retry';
      reactiveQuotaRetry = true;
      reactiveQuotaSource = account;
      reactiveReplayTargets = confirmation.replayTargets;
      reactiveReplayAuthorization = confirmation.replayAuthorization;
    } else {
      outcome = 'rate-limit-passthrough';
      if (accountManager.accounts.includes(account)) {
        const unavailableReason = accountManager.unavailableReason(account);
        if (!unavailableReason) {
          accountManager.markRateLimited(account.id, retryAfterSeconds(upstreamResponse.headers, 60));
        }
      }
      bufferedPassthrough = true;
    }
  }

  if (accountManager.accounts.includes(account)) {
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
  }

  if (!passthroughErrors && outcome === 'quota-retry') {
    return {
      retryNextAccount: true,
      passthroughResponse: upstreamResponse,
      reactiveQuotaRetry,
      reactiveQuotaSource,
      reactiveReplayTargets,
      reactiveReplayAuthorization,
    };
  }

  if (bufferedPassthrough) {
    if (!req.aborted && !res.destroyed) sendBufferedResponse(res, upstreamResponse);
    return { retryNextAccount: false };
  }

  if (!passthroughErrors && outcome === 'auth-refresh-retry') {
    return { retryAfterRefresh: true, passthroughResponse: upstreamResponse };
  }

  if (accountManager.accounts.includes(account) && upstreamResponse.body.length > 0) {
    extractUsage(upstreamResponse.body, account.id, accountManager);
  }

  if (!res.writableEnded) res.end();
  return { retryNextAccount: false };
}

function writeUpstreamResponseHead(res, upstreamRes) {
  const responseHeaders = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (!HOP_HEADERS.has(key.toLowerCase())) responseHeaders[key] = value;
  }
  res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
}

function finishStaleAccountResponse(res, upstreamResponse) {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent && upstreamResponse) sendBufferedResponse(res, upstreamResponse);
  else res.end();
}

function configuredUpstreamTarget(requestTarget, upstream) {
  const inbound = new URL(requestTarget, 'http://claude-rotator.local');
  const target = new URL(upstream);
  target.pathname = inbound.pathname;
  target.search = inbound.search;
  target.hash = '';
  return target;
}

function safeRequestPath(requestTarget) {
  try {
    return new URL(requestTarget, 'http://claude-rotator.local').pathname;
  } catch {
    return '<invalid-request-target>';
  }
}

function assertLoopbackProxyHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (['127.0.0.1', '::1', 'localhost'].includes(normalized)) return;
  throw new Error(`Proxy host must be loopback, received ${normalized || '<empty>'}`);
}

function isTrustedLocalHttpRequest(req) {
  const hostAuthority = loopbackHostAuthority(req.headers.host);
  if (!hostAuthority) return false;
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && isLoopbackHostname(parsed.hostname)
      && parsed.host.toLowerCase() === hostAuthority;
  } catch {
    return false;
  }
}

function loopbackHostAuthority(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return isLoopbackHostname(parsed.hostname) ? parsed.host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(
    String(hostname || '').trim().toLowerCase(),
  );
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
    appendHeaderCapability(headers, 'anthropic-beta', OAUTH_BETA_HEADER);
    headers.authorization = `Bearer ${secret.accessToken}`;
  }
  return headers;
}

function appendHeaderCapability(headers, headerName, capability) {
  const existingKey = Object.keys(headers)
    .find(key => key.toLowerCase() === headerName.toLowerCase());
  const current = existingKey == null ? '' : headers[existingKey];
  const values = (Array.isArray(current) ? current : [current])
    .flatMap(value => String(value || '').split(','))
    .map(value => String(value).trim())
    .filter(Boolean);
  const normalized = values.filter(value => value !== capability);
  normalized.push(capability);
  if (existingKey != null && existingKey !== headerName) delete headers[existingKey];
  headers[headerName] = normalized.join(',');
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
  clientRequest = null,
  clientResponse = null,
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
    const cleanupClientListeners = () => {
      clientRequest?.removeListener('aborted', onClientAborted);
      clientResponse?.removeListener('close', onClientResponseClose);
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (connectTimer) clearTimeout(connectTimer);
      cleanupClientListeners();
      if (error) reject(error);
      else resolve(result);
    };
    const onClientAborted = () => {
      const error = clientRequestAbortedError();
      req?.destroy(error);
      settle(error);
    };
    const onClientResponseClose = () => {
      if (!clientResponse?.writableEnded) onClientAborted();
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
      const chunks = [];
      let shouldStream = false;
      upstreamRes.on('error', settle);
      try {
        shouldStream = onResponse(upstreamRes);
      } catch (error) {
        upstreamRes.destroy(error);
        settle(error);
        return;
      }
      upstreamRes.on('data', chunk => {
        if (settled) return;
        try {
          resetIdleTimer();
          chunks.push(chunk);
          if (shouldStream) onChunk(chunk);
        } catch (error) {
          upstreamRes.destroy(error);
          settle(error);
        }
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
    clientRequest?.once('aborted', onClientAborted);
    clientResponse?.once('close', onClientResponseClose);
    if (clientRequest?.aborted || clientResponse?.destroyed) {
      onClientAborted();
      return;
    }
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
      .flatMap(accountReason => [accountReason?.retryAt, accountReason?.resetAt])
      .map(recoveryAt => Date.parse(recoveryAt || ''))
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
