import { emptyQuota, normalizeWeeklyScopedUsage, parseRateLimitHeaders, scopeMatchesModelFamily } from './quota.js';
import {
  DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS,
  DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS,
  DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS,
} from './oauth.js';

export const DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

/**
 * Affinity-only selector constants (design 4.2, D-56-1).
 * `DEFAULT_ASSIGN_STOP_UTILIZATION` stops NEW assignments at 90% - it is not an
 * eviction line: a session already bound to a 90% account stays there until the
 * account actually runs out (R2). `ASSIGN_BAND_WIDTH` is the 5-point band below
 * the best headroom inside which the weekly-reset priority is allowed to decide;
 * the width itself is an authoring judgement that has not been measured (U15).
 * `ASSIGN_BAND_EPSILON` only absorbs binary floating point error. It is NOT the
 * subtraction of the width that needs it - `0.9 - 0.05` is exactly `0.85`. The
 * error is in the residuals themselves, which are read back as `1 - utilization`
 * after the utilization was stored as `1 - residual`. Sweeping the best residual
 * from 0.06 to 1.00 in one-point steps, 29 of those 95 pairs push the candidate
 * that sits exactly `ASSIGN_BAND_WIDTH` below the best out of the band, and the
 * error is on the BEST side, not the candidate side: with a best of 0.30 and a
 * candidate of 0.25, the candidate reads back as exactly 0.25 while the best
 * reads back as 0.30000000000000004, so the band starts at 0.25000000000000006
 * - just above the candidate. The epsilon keeps those candidates inside. (The
 * 0.13 / 0.08 pair is also one of the 29, but it cannot be used as the example
 * here: the default `assignStopUtilization` of 0.9 only admits candidates whose
 * headroom is above 0.1, so 0.08 is dropped before the band is computed.)
 */
const DEFAULT_ASSIGN_STOP_UTILIZATION = 0.9;
const ASSIGN_BAND_WIDTH = 0.05;
const ASSIGN_BAND_EPSILON = 1e-9;
const ACCOUNT_SWITCH_TRIGGERS = new Set([
  'usage-refresh',
  '429',
  'reload',
  'manual',
  'request',
  'prepare-resume',
]);

export class AccountManager {
  constructor({
    accounts = [],
    switchThreshold = 1,
    currentAccountId = null,
    now = () => Date.now(),
    rotationPolicy = null,
    logger = null,
  } = {}) {
    this.now = now;
    this.logger = typeof logger === 'function' ? logger : null;
    this.switchThreshold = normalizeSwitchThreshold(switchThreshold);
    this.rotationPolicy = normalizeRotationPolicy(rotationPolicy);
    this.events = [];
    this.accounts = accounts.map((account, index) => this.createAccount(account, index));
    const configuredIndex = currentAccountId
      ? this.accounts.findIndex(account => account.id === currentAccountId || account.name === currentAccountId)
      : -1;
    this.currentIndex = configuredIndex >= 0 ? configuredIndex : 0;
  }

  /**
   * @param {string|null} modelFamily 'fable' for a Fable request, null for every
   *   other (or unidentified) request. A Fable-only sub-cap exhaustion never
   *   blocks a non-Fable request; a common 5h/7d exhaustion blocks every family.
   */
  getActiveAccount(modelFamily = null, { trigger = 'unknown' } = {}) {
    const current = this.accounts[this.currentIndex];
    if (this.isAvailable(current, modelFamily)) {
      current.status = 'active';
      return current;
    }

    const reason = this.unavailableReason(current);
    if (current?.status === 'error' || this.hasCredentialRefreshCooldown(current)) {
      const next = this.selectBestAvailableSwitchTarget(modelFamily, { trigger });
      if (next) {
        next.status = 'active';
        return next;
      }
      return null;
    }
    if (!isUnifiedQuotaExhaustion(reason)) return null;

    if (!commonQuotaExhausted(current.quota, this.switchThreshold)) {
      // Only a model-scoped window (e.g. Fable) is exhausted: `current` is
      // still perfectly usable for every other family, so pick an alternate
      // for THIS request only and leave `currentIndex` untouched.
      const adHoc = this.bestAvailableSwitchCandidate({ excludeCurrent: true, modelFamily });
      return adHoc ? adHoc.account : null;
    }

    const next = this.selectBestAvailableSwitchTarget(modelFamily, { trigger });
    if (next) {
      next.status = 'active';
      return next;
    }
    return null;
  }

  getCurrentAccount() {
    return this.accounts[this.currentIndex] || null;
  }

  getFallbackAccount() {
    const current = this.getCurrentAccount();
    if (!current) return null;
    const reason = this.unavailableReason(current);
    if (isUnifiedQuotaExhaustion(reason)) {
      return current;
    }
    if (current.status !== 'error') {
      return current;
    }
    return current;
  }

  switchTo(accountId) {
    const index = this.accounts.findIndex(account => account.id === accountId || account.name === accountId);
    if (index < 0) throw new Error(`Unknown account: ${accountId}`);
    const previous = this.accounts[this.currentIndex];
    if (previous) {
      this.refreshQuotaState(previous);
      if (previous.status === 'active') previous.status = 'ready';
    }
    this.currentIndex = index;
    this.accounts[index].status = 'active';
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'manual-switch',
      account: this.accounts[index].id,
    });
    this.logAccountSwitch({
      from: previous?.id || null,
      to: this.accounts[index].id,
      reason: 'manual',
      trigger: 'manual',
    });
  }

  updateQuota(accountId, headers, { atomicUnifiedWindows = false } = {}) {
    const account = this.find(accountId);
    const parsed = parseRateLimitHeaders(headers);
    if (atomicUnifiedWindows) {
      keepUnifiedWindowAtomic(parsed, 'unified5h', 'unified5hReset');
      keepUnifiedWindowAtomic(parsed, 'unified7d', 'unified7dReset');
    }
    account.quota = { ...account.quota, ...parsed };
    this.refreshQuotaState(account);
  }

  applyUsage(accountId, payload) {
    const account = this.find(accountId);
    this.markAuthenticated(account);
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'five_hour')) {
      if (payload.five_hour == null) {
        account.quota.unified5h = null;
        account.quota.unified5hReset = null;
      }
    }
    if (payload?.five_hour) {
      if (typeof payload.five_hour.utilization === 'number') account.quota.unified5h = payload.five_hour.utilization;
      if (Object.prototype.hasOwnProperty.call(payload.five_hour, 'resets_at')) {
        account.quota.unified5hReset = parseUsageReset(payload.five_hour.resets_at);
      }
    }
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'seven_day')) {
      if (payload.seven_day == null) {
        account.quota.unified7d = null;
        account.quota.unified7dReset = null;
      }
    }
    if (payload?.seven_day) {
      if (typeof payload.seven_day.utilization === 'number') account.quota.unified7d = payload.seven_day.utilization;
      if (Object.prototype.hasOwnProperty.call(payload.seven_day, 'resets_at')) {
        account.quota.unified7dReset = parseUsageReset(payload.seven_day.resets_at);
      }
    }
    if (Array.isArray(payload?.scoped_weekly)) {
      account.quota.weeklyScoped = normalizeWeeklyScopedUsage(payload.scoped_weekly);
    }
    this.refreshQuotaState(account);
  }

  updateUsage(accountId, { inputTokens = 0, outputTokens = 0 } = {}) {
    const account = this.find(accountId);
    account.usage.totalInputTokens += inputTokens;
    account.usage.totalOutputTokens += outputTokens;
    account.usage.totalRequests += 1;
    account.usage.lastUsed = new Date(this.now()).toISOString();
  }

  markRateLimited(accountId, retryAfterSeconds) {
    this.markTemporaryUnavailable(accountId, retryAfterSeconds, { type: 'temporary_throttle' }, {
      eventType: 'throttled',
      retryAfterSeconds,
    });
  }

  markCredentialRefreshRateLimited(accountId, retryAfterSeconds, { retryAfterSource = null } = {}) {
    this.markTemporaryUnavailable(accountId, retryAfterSeconds, {
      type: 'oauth_refresh_rate_limit',
      ...(retryAfterSource ? { retryAfterSource } : {}),
    }, {
      eventType: 'credential-refresh-throttled',
      retryAfterSeconds,
    });
  }

  markCredentialRefreshDeferred(accountId, retryAfterSeconds, { retryAfterSource = null } = {}) {
    this.markTemporaryUnavailable(accountId, retryAfterSeconds, {
      type: 'oauth_refresh_retry',
      ...(retryAfterSource ? { retryAfterSource } : {}),
    }, {
      eventType: 'credential-refresh-deferred',
      retryAfterSeconds,
    });
  }

  markTemporaryUnavailable(accountId, retryAfterSeconds, reason, event = {}) {
    const account = this.find(accountId);
    const retryAfterMs = Math.max(0, Number(retryAfterSeconds) || 0) * 1000;
    account.rateLimitedUntil = Math.min(MAX_DATE_TIMESTAMP_MS - 1, this.now() + retryAfterMs);
    account.temporaryUnavailableReason = { ...reason };
    account.status = 'throttled';
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: event.eventType || 'upstream-error',
      account: account.id,
      retryAfterSeconds: event.retryAfterSeconds ?? retryAfterSeconds,
      reason: account.temporaryUnavailableReason,
    });
  }

  /**
   * @param {{cause?: string|null, at?: string|number|null}|null} [details] Why
   *   the account failed and when that was detected.
   *
   *   `cause` is the short machine classification of the failure (e.g.
   *   `NATIVE_REFRESH_REAUTH_REQUIRED`, `http-401`) - never a raw error message,
   *   which can quote credential material.
   *
   *   `at` is kept exactly as given, so a failure that is applied late still
   *   records when it was actually seen rather than when it was finally stored.
   *   The usage-refresh path defers a failure until every newer in-flight
   *   observation has settled (see `deferFailure` in proxy-server.js), which can
   *   be minutes after the catch. Omitted `at` falls back to the store time.
   *
   *   Both are optional: a three-argument call keeps working unchanged.
   */
  markError(accountId, type = 'account_error', message = null, details = null) {
    const account = this.find(accountId);
    account.status = 'error';
    account.errorReason = { type };
    if (message) account.errorReason.message = message;
    const cause = normalizeErrorCause(details?.cause);
    if (cause) account.errorReason.cause = cause;
    account.errorReason.at = normalizeDetectedAt(details?.at)
      || new Date(this.now()).toISOString();
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'account-error',
      account: account.id,
      reason: account.errorReason,
    });
  }

  markAuthenticated(accountOrId) {
    const account = typeof accountOrId === 'string' ? this.find(accountOrId) : accountOrId;
    const credentialThrottled = isCredentialRefreshCooldown(account.temporaryUnavailableReason);
    account.errorReason = null;
    if (credentialThrottled) {
      account.rateLimitedUntil = null;
      account.temporaryUnavailableReason = null;
    }
    if (account.status === 'error' || credentialThrottled) account.status = 'ready';
  }

  recordProxyRequest(meta) {
    const event = {
      at: new Date(this.now()).toISOString(),
      type: 'proxy-request',
      account: meta.account,
      method: meta.method,
      path: meta.path,
      outcome: meta.outcome,
      durationMs: Math.max(0, Math.round(meta.durationMs || 0)),
    };
    if (meta.statusCode != null) event.statusCode = meta.statusCode;
    if (meta.requestId) event.requestId = meta.requestId;
    if (meta.errorType) event.errorType = meta.errorType;
    this.events.unshift(event);
    return event;
  }

  /**
   * Rebuild the ledger from a reloaded configuration.
   *
   * @returns {string[]} the ids of the accounts that stayed in the ledger but
   *   whose credential identity changed (D-60-3, design 8.1). The row keeps its
   *   id, so nothing downstream can tell on its own that the upstream cache
   *   behind it is gone; session affinity uses this list to drop the home and
   *   family bindings of those accounts. Accounts that were added, and accounts
   *   that disappeared, are NOT reported here - those are the account_removed
   *   case that affinity handles through prune.
   */
  replaceAccounts(accounts) {
    const previousActiveId = this.accounts[this.currentIndex]?.id ?? null;
    const existingById = new Map(this.accounts.map(account => [account.id, account]));
    const credentialChangedIds = [];
    this.accounts = accounts.map((account, index) => {
      const existing = existingById.get(account.id);
      if (!existing) return this.createAccount(account, index);
      const incomingCredentialRevision = normalizeCredentialRevision(account.credentialRevision);
      const credentialRevisionChanged = incomingCredentialRevision != null
        && existing.credentialRevision != null
        && incomingCredentialRevision !== existing.credentialRevision;
      const incomingAccountUuid = account.accountUuid || null;
      const credentialIdentityChanged = credentialRevisionChanged
        || incomingAccountUuid !== existing.accountUuid;
      if (credentialIdentityChanged) credentialChangedIds.push(existing.id);
      return {
        ...existing,
        name: account.name || account.email || account.id,
        type: account.type || 'oauth',
        accountUuid: incomingAccountUuid,
        priority: account.priority ?? index,
        credentialRevision: incomingCredentialRevision ?? existing.credentialRevision,
        status: credentialIdentityChanged ? 'ready' : existing.status,
        quota: credentialIdentityChanged ? emptyQuota() : existing.quota,
        usage: credentialIdentityChanged ? emptyAccountUsage() : existing.usage,
        errorReason: credentialIdentityChanged ? null : existing.errorReason,
        rateLimitedUntil: credentialIdentityChanged ? null : existing.rateLimitedUntil,
        temporaryUnavailableReason: credentialIdentityChanged
          ? null
          : existing.temporaryUnavailableReason,
        quotaExhaustionEventKey: credentialIdentityChanged
          ? null
          : existing.quotaExhaustionEventKey,
      };
    });
    if (this.currentIndex >= this.accounts.length) this.currentIndex = 0;
    if (this.accounts.length > 0 && !this.accounts[this.currentIndex]) this.currentIndex = 0;
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'reload',
      accounts: this.accounts.length,
    });
    this.logAccountSwitch({
      from: previousActiveId,
      to: this.accounts[this.currentIndex]?.id ?? null,
      reason: 'accounts-replaced',
      trigger: 'reload',
    });
    return credentialChangedIds;
  }

  getStatus() {
    const active = this.accounts[this.currentIndex];
    return {
      currentAccount: active?.id || null,
      currentAccountName: active?.name || null,
      switchThreshold: this.switchThreshold,
      routingAvailability: {
        fable: this.getRoutingAvailability('fable'),
        other: this.getRoutingAvailability(null),
      },
      accounts: this.accounts.map(account => {
        this.refreshQuotaState(account);
        return {
          id: account.id,
          name: account.name,
          type: account.type,
          accountUuid: account.accountUuid,
          status: this.displayStatus(account),
          quota: { ...account.quota },
          usage: { ...account.usage },
          rateLimitedUntil: account.rateLimitedUntil
            ? new Date(account.rateLimitedUntil).toISOString()
            : null,
          unavailableReason: this.unavailableReason(account),
        };
      }),
      events: this.events.slice(0, 50),
    };
  }

  getRoutingAvailability(modelFamily = null) {
    const candidates = this.accounts.map((account, index) => {
      this.refreshQuotaState(account);
      const isCurrent = index === this.currentIndex;
      const available = this.isAvailable(account, modelFamily);
      const score = available ? this.switchTargetScore(account, modelFamily) : null;

      if (available && (isCurrent || score)) {
        return {
          account,
          index,
          isCurrent,
          priority: account.priority,
          score,
          state: 'available',
          availableAt: null,
        };
      }

      return {
        account,
        index,
        isCurrent,
        priority: account.priority,
        score: null,
        ...futureAvailabilityForModelFamily(
          account,
          this.switchThreshold,
          modelFamily,
          this.now(),
        ),
      };
    });

    candidates.sort(compareRoutingAvailabilityCandidates);
    return candidates.map(candidate => ({
      account: candidate.account.id,
      accountName: candidate.account.name,
      state: candidate.state,
      availableAt: candidate.availableAt == null
        ? null
        : new Date(candidate.availableAt).toISOString(),
    }));
  }

  exportState() {
    const active = this.accounts[this.currentIndex];
    return {
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      currentAccount: active?.id || null,
      accounts: this.accounts.map(account => ({
        id: account.id,
        accountUuid: account.accountUuid,
        credentialRevision: account.credentialRevision,
        status: account.status,
        quota: { ...account.quota },
        usage: { ...account.usage },
        rateLimitedUntil: account.rateLimitedUntil ? new Date(account.rateLimitedUntil).toISOString() : null,
        temporaryUnavailableReason: clonePlainObject(account.temporaryUnavailableReason),
        errorReason: clonePlainObject(account.errorReason),
      })),
    };
  }

  /**
   * Restore the ledger from the saved runtime state.
   *
   * @returns {string[]} the same credential-identity report as
   *   `replaceAccounts` (D-60-3, design 8.1). EVERY return path returns an
   *   array, the early return for a broken saved state included: a bare
   *   `return` would hand `undefined` to session affinity exactly in the F1
   *   case (unreadable saved state), where it is least likely to be noticed.
   */
  restoreState(state) {
    if (!state || typeof state !== 'object') return [];
    const savedById = new Map((Array.isArray(state.accounts) ? state.accounts : [])
      .filter(account => account && typeof account.id === 'string')
      .map(account => [account.id, account]));

    const credentialChangedIds = [];
    for (const account of this.accounts) {
      const saved = savedById.get(account.id);
      if (!saved) continue;
      const savedCredentialRevision = normalizeCredentialRevision(saved.credentialRevision);
      const credentialRevisionChanged = savedCredentialRevision != null
        && account.credentialRevision != null
        && savedCredentialRevision !== account.credentialRevision;
      const savedHasAccountUuid = Object.prototype.hasOwnProperty.call(saved, 'accountUuid');
      const accountUuidChanged = savedHasAccountUuid
        ? (saved.accountUuid || null) !== account.accountUuid
        : account.accountUuid != null;
      const credentialIdentityChanged = credentialRevisionChanged || accountUuidChanged;
      if (credentialIdentityChanged) credentialChangedIds.push(account.id);
      account.status = credentialIdentityChanged ? 'ready' : restoreStatus(saved.status);
      account.quota = credentialIdentityChanged ? emptyQuota() : restoreQuota(saved.quota);
      account.usage = credentialIdentityChanged ? emptyAccountUsage() : restoreUsage(saved.usage);
      account.rateLimitedUntil = credentialIdentityChanged
        ? null
        : restoreTimestamp(saved.rateLimitedUntil);
      account.temporaryUnavailableReason = credentialIdentityChanged
        ? null
        : clonePlainObject(saved.temporaryUnavailableReason);
      account.errorReason = credentialIdentityChanged
        ? null
        : clonePlainObject(saved.errorReason);
      this.normalizeRestoredCredentialCooldown(account);
      account.quotaExhaustionEventKey = null;
      this.refreshQuotaState(account);
    }

    if (state.currentAccount) {
      const index = this.accounts.findIndex(account => account.id === state.currentAccount);
      if (index >= 0) this.currentIndex = index;
    }

    return credentialChangedIds;
  }

  normalizeRestoredCredentialCooldown(account) {
    const reason = account.temporaryUnavailableReason;
    if (!isCredentialRefreshCooldown(reason)) return;
    if (!account.rateLimitedUntil) return;
    const remainingMs = account.rateLimitedUntil - this.now();
    const maximumRestoredCooldownMs = restoredCredentialCooldownLimitMs(
      reason.retryAfterSource,
    );
    if (remainingMs <= maximumRestoredCooldownMs) return;
    account.rateLimitedUntil = null;
    account.temporaryUnavailableReason = null;
    if (account.status === 'throttled') account.status = 'ready';
  }

  selectBestAvailableSwitchTarget(modelFamily = null, { trigger = 'unknown' } = {}) {
    const selected = this.bestAvailableSwitchCandidate({ excludeCurrent: true, modelFamily });
    if (!selected) return null;

    const previous = this.accounts[this.currentIndex];
    const reason = this.autoSwitchReason(previous);
    return this.switchToCandidate(selected, reason, trigger);
  }

  prepareResumeTarget() {
    const previousId = this.getCurrentAccount()?.id || null;
    const available = this.bestAvailableSwitchCandidate({ excludeCurrent: false });
    if (available) {
      const account = available.index === this.currentIndex
        ? available.account
        : this.switchToCandidate(available, 'resume-ready', 'prepare-resume');
      return this.resumeTarget({
        account,
        action: 'ready',
        reason: 'available',
        resumeAt: this.now(),
        switched: previousId !== account.id,
      });
    }

    const selected = this.bestExhaustedFallbackCandidate();
    if (!selected) {
      return this.emptyResumeTarget('no-resume-target');
    }

    const account = this.switchToExhaustedFallbackCandidate(selected, 'prepare-resume');
    const resetAt = finiteResetAt(selected.score.resetAt);
    if (resetAt == null) {
      return this.resumeTarget({
        account,
        action: 'unavailable',
        reason: 'quota-reset-unknown',
        resumeAt: null,
        switched: previousId !== account.id,
        unavailableReason: this.unavailableReason(account),
      });
    }

    return this.resumeTarget({
      account,
      action: resetAt <= this.now() ? 'ready' : 'wait',
      reason: 'shortest-quota-reset',
      resumeAt: resetAt,
      switched: previousId !== account.id,
      unavailableReason: this.unavailableReason(account),
    });
  }

  rebalanceActiveAccount() {
    const current = this.getCurrentAccount();
    if (!current) return null;

    if (!this.isAvailable(current)) {
      if (!this.getActiveAccount(null, { trigger: 'usage-refresh' })) return this.getFallbackAccount();
      return this.getCurrentAccount();
    }

    const selected = this.bestAvailableSwitchCandidate({ excludeCurrent: false });
    if (!selected || selected.index === this.currentIndex) return current;
    if (!selected.score.weeklyResetPriority) return current;

    const currentScore = this.switchTargetScore(current);
    if (currentScore && compareSwitchTargetScores(selected, {
      account: current,
      index: this.currentIndex,
      score: currentScore,
    }) >= 0) {
      return current;
    }

    return this.switchToCandidate(selected, 'weekly-reset-priority', 'usage-refresh');
  }

  bestAvailableSwitchCandidate({ excludeCurrent, allowedAccounts = null, modelFamily = null } = {}) {
    const candidates = this.accounts
      .map((account, index) => ({ account, index, score: this.switchTargetScore(account, modelFamily) }))
      .filter(candidate => (
        (!excludeCurrent || candidate.index !== this.currentIndex)
        && (!allowedAccounts || allowedAccounts.has(candidate.account))
        && candidate.score
      ));

    candidates.sort((left, right) => compareSwitchTargetScores(left, right));
    return candidates[0] || null;
  }

  switchToCandidate(selected, reason, trigger = 'unknown') {
    const previous = this.accounts[this.currentIndex];
    if (previous) {
      this.refreshQuotaState(previous);
      previous.status = this.unavailableReason(previous) ? this.displayStatus(previous) : 'ready';
    }
    this.currentIndex = selected.index;
    selected.account.status = 'active';
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'auto-switch',
      from: previous?.id || null,
      to: selected.account.id,
      reason,
      targetScore: selected.score,
    });
    this.logAccountSwitch({
      from: previous?.id || null,
      to: selected.account.id,
      reason,
      trigger,
    });
    return selected.account;
  }

  selectBestExhaustedFallback({ trigger = 'unknown' } = {}) {
    const selected = this.bestExhaustedFallbackCandidate();
    if (!selected) return null;
    return this.switchToExhaustedFallbackCandidate(selected, trigger);
  }

  bestExhaustedFallbackCandidate() {
    const candidates = this.accounts
      .map((account, index) => ({ account, index, score: this.exhaustedFallbackScore(account) }))
      .filter(candidate => candidate.score);

    candidates.sort((left, right) => compareExhaustedFallbackScores(left, right));
    return candidates[0] || null;
  }

  switchToExhaustedFallbackCandidate(selected, trigger = 'unknown') {
    if (selected.index !== this.currentIndex) {
      const previous = this.accounts[this.currentIndex];
      if (previous) previous.status = this.displayStatus(previous);
      this.currentIndex = selected.index;
      this.events.unshift({
        at: new Date(this.now()).toISOString(),
        type: 'fallback-switch',
        from: previous?.id || null,
        to: selected.account.id,
        reason: 'shortest-quota-reset',
        targetScore: selected.score,
      });
      this.logAccountSwitch({
        from: previous?.id || null,
        to: selected.account.id,
        reason: 'shortest-quota-reset',
        trigger,
      });
    }
    return selected.account;
  }

  /**
   * The single counting source for a move of the globally active account
   * (D-54-13(a) / D-54-14). Callers that forget to pass a trigger produce
   * `trigger=unknown` rather than an exception, so a missed hand-off shows up
   * in the log instead of failing a live request.
   */
  logAccountSwitch({ from, to, reason, trigger }) {
    if (!this.logger) return;
    // The switch helpers still run their status/event bookkeeping when the
    // chosen candidate is the account already in use; that is not a move of
    // the active account, so it must not reach the counting source (D-54-14).
    if (from === to) return;
    const at = new Date(this.now()).toISOString();
    const normalizedTrigger = ACCOUNT_SWITCH_TRIGGERS.has(trigger) ? trigger : 'unknown';
    this.logger(`${at} account_switch from=${from ?? 'none'} to=${to ?? 'none'} reason=${reason} trigger=${normalizedTrigger}`);
  }

  resumeTarget({
    account,
    action,
    reason,
    resumeAt,
    switched,
    unavailableReason = null,
  }) {
    const resumeAtMs = finiteResetAt(resumeAt);
    const waitMs = resumeAtMs == null ? null : Math.max(0, resumeAtMs - this.now());
    const reasonDetails = unavailableReason || this.unavailableReason(account);
    return {
      ok: action !== 'unavailable',
      action,
      reason,
      account: account?.id || null,
      accountName: account?.name || null,
      switched: Boolean(switched),
      window: reasonDetails?.window || null,
      unavailableReason: reasonDetails,
      resumeAt: resumeAtMs == null ? null : new Date(resumeAtMs).toISOString(),
      resumeAtEpoch: resumeAtMs == null ? null : Math.floor(resumeAtMs / 1000),
      waitMs,
    };
  }

  emptyResumeTarget(reason) {
    return {
      ok: false,
      action: 'unavailable',
      reason,
      account: null,
      accountName: null,
      switched: false,
      window: null,
      unavailableReason: null,
      resumeAt: null,
      resumeAtEpoch: null,
      waitMs: null,
    };
  }

  switchTargetScore(account, modelFamily = null) {
    if (!this.isAvailable(account, modelFamily)) return null;
    const quota = account.quota || {};
    const utilizations = [quota.unified5h, quota.unified7d]
      .filter(value => typeof value === 'number' && Number.isFinite(value));
    if (utilizations.length === 0) return null;
    const now = this.now();
    const fiveHourUtilization = finiteNumberOrNull(quota.unified5h);
    const weeklyUtilization = finiteNumberOrNull(quota.unified7d);
    const weeklyResetAt = finiteNumberOrNull(quota.unified7dReset);
    const weeklyResetPriority = this.rotationPolicy.mode === 'use-expiring-weekly'
      && weeklyUtilization != null
      && weeklyResetAt != null
      && weeklyResetAt > now
      && weeklyResetAt - now <= this.rotationPolicy.weeklyResetPriorityWindowMs;
    return {
      weeklyResetPriority,
      weeklyResetAt: weeklyResetPriority ? weeklyResetAt : Number.MAX_SAFE_INTEGER,
      weeklyHeadroom: weeklyUtilization != null ? Math.max(0, 1 - weeklyUtilization) : -1,
      weeklyUtilization: weeklyUtilization ?? Number.MAX_SAFE_INTEGER,
      fiveHourUtilization: fiveHourUtilization ?? Number.MAX_SAFE_INTEGER,
      maxUtilization: Math.max(...utilizations),
      totalUtilization: utilizations.reduce((total, value) => total + value, 0),
      knownWindows: utilizations.length,
      priority: account.priority ?? Number.MAX_SAFE_INTEGER,
    };
  }

  exhaustedFallbackScore(account) {
    if (this.hasCredentialRefreshCooldown(account)) return null;
    const reason = this.unavailableReason(account);
    if (!isUnifiedQuotaExhaustion(reason)) return null;
    const resetAt = reason.resetAt ? Date.parse(reason.resetAt) : null;
    return {
      resetAt: Number.isFinite(resetAt) ? resetAt : Number.MAX_SAFE_INTEGER,
      utilization: typeof reason.utilization === 'number' ? reason.utilization : Number.MAX_SAFE_INTEGER,
      windowRank: reason.window === '5h' ? 0 : 1,
      priority: account.priority ?? Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * @param {string|null} modelFamily 'fable' for a Fable request, null otherwise
   *   (including when the request's model could not be identified). A model-scoped
   *   exhaustion (e.g. the Fable weekly sub-cap) only makes the account unavailable
   *   for requests of that same family; a common 5h/7d/token/request exhaustion
   *   makes it unavailable for every family.
   */
  isAvailable(account, modelFamily = null) {
    if (!account) return false;
    this.refreshQuotaState(account);
    if (this.hasCredentialRefreshCooldown(account)) return false;
    if (account.status === 'throttled') return false;
    if (account.status === 'error') return false;
    if (account.status === 'exhausted') {
      return !quotaBlocksModelFamily(account.quota, this.switchThreshold, modelFamily);
    }
    return true;
  }

  refreshQuotaState(account) {
    const now = this.now();
    const q = account.quota;

    if (q.unified5hReset && now >= q.unified5hReset) {
      q.unified5h = null;
      q.unified5hReset = null;
    }
    if (q.unified7dReset && now >= q.unified7dReset) {
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
    }
    if (Array.isArray(q.weeklyScoped)) {
      q.weeklyScoped = q.weeklyScoped.filter(limit => !limit.resetAt || now < limit.resetAt);
    } else {
      q.weeklyScoped = [];
    }
    if (account.rateLimitedUntil && now >= account.rateLimitedUntil) {
      account.rateLimitedUntil = null;
      account.temporaryUnavailableReason = null;
      account.status = 'ready';
    }
    if (account.status === 'error') return;

    const quotaReason = quotaUnavailableReason(q, this.switchThreshold);
    if (quotaReason) {
      account.status = 'exhausted';
      this.recordQuotaExhausted(account, quotaReason);
      return;
    }
    account.quotaExhaustionEventKey = null;
    if (account.rateLimitedUntil && now < account.rateLimitedUntil) {
      account.status = 'throttled';
      return;
    }
    if (account.status === 'exhausted' || account.status === 'throttled') account.status = 'ready';
  }

  recordQuotaExhausted(account, reason) {
    const key = `${reason.type}:${reason.window || ''}:${reason.resetAt || ''}`;
    if (account.quotaExhaustionEventKey === key) return;
    account.quotaExhaustionEventKey = key;
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'quota-exhausted',
      account: account.id,
      reason,
    });
  }

  unavailableReason(account) {
    if (!account) return null;
    if (account.status === 'error') {
      return account.errorReason || { type: 'account_error' };
    }
    const quotaReason = quotaUnavailableReason(account.quota, this.switchThreshold);
    if (quotaReason) return quotaReason;
    if (account.rateLimitedUntil && this.now() < account.rateLimitedUntil) {
      return {
        ...(account.temporaryUnavailableReason || { type: 'temporary_throttle' }),
        retryAt: new Date(account.rateLimitedUntil).toISOString(),
      };
    }
    return null;
  }

  hasCredentialRefreshCooldown(account) {
    return Boolean(
      account?.rateLimitedUntil
      && this.now() < account.rateLimitedUntil
      && isCredentialRefreshCooldown(account.temporaryUnavailableReason),
    );
  }

  /**
   * Same as `unavailableReason`, except a scoped weekly window (e.g. the
   * Fable sub-cap) is only trusted as THE reason when it actually matches
   * `modelFamily`. This keeps `unavailableReason` itself family-agnostic
   * (informational, used for /internal/status) while giving the proxy layer a
   * way to avoid handing a non-matching-family request a misleading claim
   * such as `seven_day_fable` when it was really blocked by a common window
   * (token/request rate limit) that happened to be checked after the scoped
   * one (m2).
   */
  unavailableReasonForModelFamily(account, modelFamily = null) {
    if (!account) return null;
    if (account.status === 'error') {
      return account.errorReason || { type: 'account_error' };
    }
    const quotaReason = quotaUnavailableReasonForModelFamily(account.quota, this.switchThreshold, modelFamily);
    if (quotaReason) return quotaReason;
    if (account.rateLimitedUntil && this.now() < account.rateLimitedUntil) {
      return {
        ...(account.temporaryUnavailableReason || { type: 'temporary_throttle' }),
        retryAt: new Date(account.rateLimitedUntil).toISOString(),
      };
    }
    return null;
  }

  autoSwitchReason(account) {
    if (this.hasCredentialRefreshCooldown(account)) {
      return account.temporaryUnavailableReason.type;
    }
    const reason = this.unavailableReason(account);
    if (!reason) return 'account-unavailable';
    if (isUnifiedQuotaExhaustion(reason)) return 'quota-threshold';
    return reason.type;
  }

  displayStatus(account) {
    if (this.accounts[this.currentIndex]?.id === account.id && !this.unavailableReason(account)) return 'active';
    if (account.status === 'exhausted') return 'exhausted';
    if (account.status === 'throttled') return 'throttled';
    if (account.status === 'error') return 'error';
    if (account.quota.unified5h == null && account.quota.unified7d == null) return 'unknown';
    return 'ready';
  }

  /**
   * Picks the account a NEW session should be bound to (design 4.2, D-56-1).
   *
   * This is the affinity-only selector. It deliberately does NOT reuse
   * `switchTargetScore` / `compareSwitchTargetScores`: that comparator ranks
   * `weeklyResetPriority` first, reads only the unified 5h/7d windows into
   * `maxUtilization` and always settles ties on ledger order, so it does not
   * pick the account with the most headroom (design 4.2 (a)-(c)). Requests
   * without a session key keep going through the existing comparator.
   *
   * Ranking, after the assign-stop gate and the missing-window split:
   *   K1 weekly reset priority (only inside the band)
   *   K2 earliest weekly reset (only between two priority accounts)
   *   K3 fewest sessions already bound (R4 - this key is reachable here,
   *      unlike in the existing comparator)
   *   K4 largest headroom, then account priority, then ledger order
   *
   * Side effect: the availability filter calls `isAvailable`, which refreshes
   * the quota state of every account it looks at. That is wanted - an expired
   * reset is applied, so a recovered account comes back as a candidate - and it
   * does not inflate the event log, because `recordQuotaExhausted` dedupes on
   * the exhaustion reason (invariant I-3).
   *
   * @param {string|null} modelFamily 'fable' for a Fable request, null otherwise.
   *   Only a Fable request counts the Fable weekly sub-cap as one of its windows.
   * @param {Set<string>|Iterable<string>|string|null} excludeAccountIds Account
   *   ids that must not be picked - the caller passes `attemptedAccountIds`
   *   and, for a sub-binding, the account that just failed.
   * @param {number} assignStopUtilization Utilization at which an account stops
   *   accepting NEW sessions. The gate is dropped entirely when it would leave
   *   no candidate at all (R1).
   * @param {Map<string,number>|Record<string,number>|null} sessionCounts Sessions
   *   already bound per account id (`SessionAffinity.summary().sessionsByAccount`).
   * @returns {object|null} The chosen account, or null when nothing is usable -
   *   the caller then falls through to the existing exhausted-response path (R1).
   */
  selectForNewAssignment({
    modelFamily = null,
    excludeAccountIds = null,
    assignStopUtilization = DEFAULT_ASSIGN_STOP_UTILIZATION,
    sessionCounts = null,
  } = {}) {
    const excluded = normalizeExcludedAccountIds(excludeAccountIds);
    const gate = normalizeAssignStopUtilization(assignStopUtilization);
    const now = this.now();

    const pool = this.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => !excluded.has(account.id) && this.isAvailable(account, modelFamily))
      .map(({ account, index }) => this.newAssignmentCandidate(account, index, modelFamily, now, sessionCounts));
    if (pool.length === 0) return null;

    const admitted = pool.filter(candidate => (
      candidate.headroom.min != null && candidate.headroom.min > 1 - gate
    ));
    const candidates = admitted.length > 0 ? admitted : pool;

    // D-60-4: split the candidates with a missing window out BEFORE the band is
    // computed. A window that could not be read must not look like headroom and
    // push a fully known candidate out of the band.
    const known = candidates.filter(candidate => candidate.headroom.complete);
    const missing = candidates.filter(candidate => !candidate.headroom.complete);
    const ranked = known.length > 0 ? known : missing;

    const best = Math.max(...ranked.map(candidate => candidate.headroom.min ?? -1));
    const band = ranked.filter(candidate => (
      (candidate.headroom.min ?? -1) >= best - ASSIGN_BAND_WIDTH - ASSIGN_BAND_EPSILON
    ));

    band.sort(compareNewAssignmentCandidates);
    return band[0].account;
  }

  /** One ranking row for `selectForNewAssignment`. Reads the ledger, never writes it. */
  newAssignmentCandidate(account, index, modelFamily, now, sessionCounts) {
    const quota = account.quota || {};
    const weeklyUtilization = finiteNumberOrNull(quota.unified7d);
    const weeklyResetAt = finiteNumberOrNull(quota.unified7dReset);
    const weeklyResetPriority = this.rotationPolicy.mode === 'use-expiring-weekly'
      && weeklyUtilization != null
      && weeklyResetAt != null
      && weeklyResetAt > now
      && weeklyResetAt - now <= this.rotationPolicy.weeklyResetPriorityWindowMs;
    return {
      account,
      index,
      headroom: assignmentHeadroom(quota, modelFamily),
      weeklyResetPriority,
      // K2 only separates two priority accounts, so everything else shares the
      // same sentinel and falls through to K3.
      weeklyResetAt: weeklyResetPriority ? weeklyResetAt : Number.MAX_SAFE_INTEGER,
      sessions: sessionCountFor(sessionCounts, account.id),
      priority: account.priority ?? Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Same lookup as `find`, but returns null instead of throwing when the id is
   * unknown. A session binding can outlive its account (a reload that drops an
   * account), and that case has to be detectable rather than fatal (design 4.3).
   */
  findOrNull(accountId) {
    if (typeof accountId !== 'string' || accountId === '') return null;
    return this.accounts.find(item => item.id === accountId || item.name === accountId) || null;
  }

  find(accountId) {
    const account = this.accounts.find(item => item.id === accountId || item.name === accountId);
    if (!account) throw new Error(`Unknown account: ${accountId}`);
    return account;
  }

  createAccount(account, index) {
    return {
      id: account.id,
      name: account.name || account.email || account.id,
      type: account.type || 'oauth',
      accountUuid: account.accountUuid || null,
      priority: account.priority ?? index,
      credentialRevision: normalizeCredentialRevision(account.credentialRevision),
      status: 'ready',
      quota: emptyQuota(),
      usage: emptyAccountUsage(),
      rateLimitedUntil: null,
      temporaryUnavailableReason: null,
      errorReason: null,
      quotaExhaustionEventKey: null,
    };
  }
}

function keepUnifiedWindowAtomic(parsed, utilizationKey, resetKey) {
  const hasUtilization = Object.prototype.hasOwnProperty.call(parsed, utilizationKey);
  const hasReset = Object.prototype.hasOwnProperty.call(parsed, resetKey);
  if (hasUtilization === hasReset) return;
  delete parsed[utilizationKey];
  delete parsed[resetKey];
}

function emptyAccountUsage() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalRequests: 0,
    lastUsed: null,
  };
}

function normalizeSwitchThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 && threshold <= 1
    ? threshold
    : 1;
}

function restoredCredentialCooldownLimitMs(retryAfterSource) {
  if (retryAfterSource === 'provider') return DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS;
  if (retryAfterSource === 'fixed') return DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS;
  return DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS;
}

function normalizeErrorCause(value) {
  if (typeof value !== 'string') return null;
  const cause = value.trim();
  return cause.length > 0 ? cause : null;
}

/**
 * Accepts either an epoch millisecond value or a parsable date string and
 * returns it as an ISO string, so the stored shape is the same one
 * `exportState` writes and `restoreState` reads back. Anything unparsable
 * returns null, which makes `markError` fall back to its own clock rather than
 * persisting a timestamp nothing can render.
 */
function normalizeDetectedAt(value) {
  if (typeof value === 'number') return isoTimestampOrNull(value);
  if (typeof value !== 'string' || value.length === 0) return null;
  return isoTimestampOrNull(Date.parse(value));
}

function isoTimestampOrNull(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  // `new Date(...).toISOString()` throws outside this range instead of
  // returning an invalid date, so it is checked rather than caught.
  if (Math.abs(timestamp) > MAX_DATE_TIMESTAMP_MS) return null;
  return new Date(timestamp).toISOString();
}

function normalizeCredentialRevision(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return null;
}

export function quotaUnavailableReason(quota, threshold) {
  if (quota.unified5h != null && quota.unified5h >= threshold) {
    return {
      type: 'quota_exhausted',
      window: '5h',
      utilization: quota.unified5h,
      resetAt: quota.unified5hReset ? new Date(quota.unified5hReset).toISOString() : null,
    };
  }
  if (quota.unified7d != null && quota.unified7d >= threshold) {
    return {
      type: 'quota_exhausted',
      window: '7d',
      utilization: quota.unified7d,
      resetAt: quota.unified7dReset ? new Date(quota.unified7dReset).toISOString() : null,
    };
  }
  const scopedReason = scopedWeeklyQuotaUnavailableReason(quota.weeklyScoped, threshold);
  if (scopedReason) return scopedReason;
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const utilization = 1 - quota.tokensRemaining / quota.tokensLimit;
    if (utilization >= threshold) {
      return {
        type: 'token_rate_limit_exhausted',
        utilization,
        resetAt: quota.resetsAt || null,
      };
    }
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const utilization = 1 - quota.requestsRemaining / quota.requestsLimit;
    if (utilization >= threshold) {
      return {
        type: 'request_rate_limit_exhausted',
        utilization,
        resetAt: quota.resetsAt || null,
      };
    }
  }
  return null;
}

/**
 * Same idea as `quotaUnavailableReason`, but a `weeklyScoped` window is only
 * eligible to be returned when it matches `modelFamily` (via
 * `scopeMatchesModelFamily`). This lets the proxy layer report the true
 * common-quota reason (token/request rate limit) to a non-matching-family
 * request instead of a scoped claim that does not apply to it (m2).
 */
export function quotaUnavailableReasonForModelFamily(quota, threshold, modelFamily) {
  if (quota.unified5h != null && quota.unified5h >= threshold) {
    return {
      type: 'quota_exhausted',
      window: '5h',
      utilization: quota.unified5h,
      resetAt: quota.unified5hReset ? new Date(quota.unified5hReset).toISOString() : null,
    };
  }
  if (quota.unified7d != null && quota.unified7d >= threshold) {
    return {
      type: 'quota_exhausted',
      window: '7d',
      utilization: quota.unified7d,
      resetAt: quota.unified7dReset ? new Date(quota.unified7dReset).toISOString() : null,
    };
  }
  if (Array.isArray(quota.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!limit || typeof limit.utilization !== 'number' || limit.utilization < threshold) continue;
      if (!scopeMatchesModelFamily(limit, modelFamily)) continue;
      return {
        type: 'quota_exhausted',
        window: `7d ${limit.label || limit.key || 'scoped'}`,
        claim: `seven_day_${limit.key || 'scoped'}`,
        utilization: limit.utilization,
        resetAt: limit.resetAt ? new Date(limit.resetAt).toISOString() : null,
      };
    }
  }
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const utilization = 1 - quota.tokensRemaining / quota.tokensLimit;
    if (utilization >= threshold) {
      return {
        type: 'token_rate_limit_exhausted',
        utilization,
        resetAt: quota.resetsAt || null,
      };
    }
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const utilization = 1 - quota.requestsRemaining / quota.requestsLimit;
    if (utilization >= threshold) {
      return {
        type: 'request_rate_limit_exhausted',
        utilization,
        resetAt: quota.resetsAt || null,
      };
    }
  }
  return null;
}

export function isUnifiedQuotaExhaustion(reason) {
  return ['token_rate_limit_exhausted', 'request_rate_limit_exhausted'].includes(reason?.type)
    || (reason?.type === 'quota_exhausted'
      && (['5h', '7d'].includes(reason.window) || String(reason.window || '').startsWith('7d ')));
}

export function isCredentialRefreshCooldown(reason) {
  return reason?.type === 'oauth_refresh_rate_limit'
    || reason?.type === 'oauth_refresh_retry';
}

/**
 * Routing availability state used for an account whose login has expired
 * (design ruling D-72). It ranks exactly like `unknown` - neither carries a
 * recovery time - so the ordering of the recovery list is unchanged; only the
 * word the screen prints differs, because "unknown" wrongly suggests the
 * account might come back on its own.
 */
export const NEEDS_LOGIN_AVAILABILITY_STATE = 'needs-login';

const AUTH_EXPIRED_REASON_TYPES = new Set(['oauth_refresh_failed', 'authentication_error']);

/**
 * True when the account is unusable because its credentials were rejected or
 * could not be refreshed - the one case a human has to clear by running
 * `claude-rotator login` again. Excludes the refresh cooldown reasons, which do
 * recover on their own (see `isCredentialRefreshCooldown`).
 */
export function isAuthExpiredReason(reason) {
  return AUTH_EXPIRED_REASON_TYPES.has(reason?.type);
}

/**
 * Decides whether an account's quota gates a request of the given model family.
 * This evaluates every window directly (never a single classified "the" reason)
 * so a model-scoped exhaustion can never mask a concurrent common-quota
 * exhaustion, and so a scoped exhaustion buried behind an earlier non-matching
 * scoped entry is never missed (Blockers B1/B2).
 *
 * Common windows (5h / 7d / token / request rate limits) gate every family.
 * Every entry in `weeklyScoped` is scanned independently via
 * `scopeMatchesModelFamily`: a Fable-scoped entry at/over threshold gates only
 * Fable requests; an unrecognized scope is reported but never gates any request.
 */
function quotaBlocksModelFamily(quota, threshold, modelFamily) {
  if (!quota) return true;
  if (commonQuotaExhausted(quota, threshold)) return true;
  if (Array.isArray(quota.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!limit || typeof limit.utilization !== 'number' || limit.utilization < threshold) continue;
      if (scopeMatchesModelFamily(limit, modelFamily)) return true;
    }
  }
  return false;
}

/**
 * True when a common (family-independent) window is exhausted: unified 5h/7d,
 * or the token/request rate limit. These block every model family. Does NOT
 * consider `weeklyScoped` — a model-scoped exhaustion is never "common".
 */
function commonQuotaExhausted(quota, threshold) {
  if (!quota) return true;
  if (quota.unified5h != null && quota.unified5h >= threshold) return true;
  if (quota.unified7d != null && quota.unified7d >= threshold) return true;
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const utilization = 1 - quota.tokensRemaining / quota.tokensLimit;
    if (utilization >= threshold) return true;
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const utilization = 1 - quota.requestsRemaining / quota.requestsLimit;
    if (utilization >= threshold) return true;
  }
  return false;
}

/**
 * Public form of the module-private `commonQuotaExhausted` (design §5, D-56-3).
 * True when a family-independent window of THIS account is at or over the
 * threshold: unified 5h/7d, or the token/request rate limit. A model-scoped
 * weekly window is never "common", so it never makes this true.
 *
 * Takes the account rather than the raw quota so callers outside this module
 * never have to reach into `account.quota` themselves. A missing account is
 * `false`: "no account" is not evidence of an exhausted common window.
 */
export function isCommonQuotaExhausted(account, threshold) {
  if (!account) return false;
  return commonQuotaExhausted(account.quota, threshold);
}

/**
 * True only for the "sub-cap only" case of design §5.1 / D-56-3: a model-scoped
 * weekly window blocks `modelFamily` while every common window is still below
 * the threshold. This is the one case where the account stays perfectly usable
 * for every other family, so the reactive 429 path must not move `currentIndex`.
 *
 * The three states that are NOT a quota exhaustion - an expired or rejected
 * login (`status === 'error'`), a throttle (`status === 'throttled'`) and any
 * live short-term back-off, which covers both the plain rate limit and the
 * credential-refresh cooldown (`rateLimitedUntil` in the future) - are false
 * here even when a scoped window happens to be over the threshold as well.
 * Those belong to the existing retry path, which must keep its current
 * behaviour (§4.3). `refreshQuotaState` can rewrite `status` to `'exhausted'`
 * while a back-off is still running, which is why the back-off is read from
 * `rateLimitedUntil` rather than from `status` alone.
 *
 * Reads the ledger without touching it: unlike `isAvailable` it never calls
 * `refreshQuotaState`, so evaluating it cannot add a `quota-exhausted` event
 * or move an account's status (invariant I-3).
 *
 * @param {number} [now] Clock used for the back-off comparison, in ms. Callers
 *   holding an `AccountManager` pass `accountManager.now()` so a test clock is
 *   honoured; the default keeps the predicate callable on its own.
 */
export function familyQuotaExhaustedOnly(account, threshold, modelFamily, now = Date.now()) {
  if (!account) return false;
  if (account.status === 'error' || account.status === 'throttled') return false;
  if (account.rateLimitedUntil != null && now < account.rateLimitedUntil) return false;
  if (commonQuotaExhausted(account.quota, threshold)) return false;
  return quotaBlocksModelFamily(account.quota, threshold, modelFamily);
}

function futureAvailabilityForModelFamily(account, threshold, modelFamily, now) {
  if (!account) return { state: 'unknown', availableAt: null };
  if (account.status === 'error') {
    // D-72: an expired login is reported as such so the screen can tell the
    // operator to run `claude-rotator login`. Every other error stays `unknown`.
    return {
      state: isAuthExpiredReason(account.errorReason) ? NEEDS_LOGIN_AVAILABILITY_STATE : 'unknown',
      availableAt: null,
    };
  }

  const blockers = [];
  const quota = account.quota || {};
  if (quota.unified5h != null && quota.unified5h >= threshold) {
    blockers.push(availabilityResetTimestamp(quota.unified5hReset));
  }
  if (quota.unified7d != null && quota.unified7d >= threshold) {
    blockers.push(availabilityResetTimestamp(quota.unified7dReset));
  }
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const utilization = 1 - quota.tokensRemaining / quota.tokensLimit;
    if (utilization >= threshold) blockers.push(availabilityResetTimestamp(quota.resetsAt));
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const utilization = 1 - quota.requestsRemaining / quota.requestsLimit;
    if (utilization >= threshold) blockers.push(availabilityResetTimestamp(quota.resetsAt));
  }
  if (Array.isArray(quota.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!limit || typeof limit.utilization !== 'number' || limit.utilization < threshold) continue;
      if (!scopeMatchesModelFamily(limit, modelFamily)) continue;
      blockers.push(availabilityResetTimestamp(limit.resetAt));
    }
  }
  if (account.rateLimitedUntil && account.rateLimitedUntil > now) {
    blockers.push(availabilityResetTimestamp(account.rateLimitedUntil));
  }

  if (blockers.length === 0 || blockers.some(resetAt => resetAt == null || resetAt <= now)) {
    return { state: 'unknown', availableAt: null };
  }
  return { state: 'waiting', availableAt: Math.max(...blockers) };
}

function availabilityResetTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareRoutingAvailabilityCandidates(left, right) {
  const rank = { available: 0, waiting: 1, unknown: 2, [NEEDS_LOGIN_AVAILABILITY_STATE]: 2 };
  if (rank[left.state] !== rank[right.state]) return rank[left.state] - rank[right.state];
  if (left.state === 'available') {
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    if (left.score && right.score) return compareSwitchTargetScores(left, right);
  }
  if (left.state === 'waiting' && left.availableAt !== right.availableAt) {
    return left.availableAt - right.availableAt;
  }
  if (left.priority !== right.priority) return left.priority - right.priority;
  return left.index - right.index;
}

/**
 * Headroom of an account for `selectForNewAssignment` (design 4.2).
 *
 * `min` is the residual (1 - utilization) of the tightest window that could be
 * read, so the account is ranked by the window that will run out first. A Fable
 * request also counts the Fable weekly sub-cap, which is what keeps a 95%
 * sub-cap account from becoming the home of a new Fable session.
 *
 * A window that could not be read is NOT treated as 100% free: it is left out of
 * `min` and reported through `complete: false`, so the caller can rank those
 * candidates behind the fully known ones instead of trusting a flattering value.
 */
function assignmentHeadroom(quota, modelFamily) {
  const utilizations = [finiteNumberOrNull(quota?.unified5h), finiteNumberOrNull(quota?.unified7d)];
  if (modelFamily === 'fable' && Array.isArray(quota?.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!scopeMatchesModelFamily(limit, modelFamily)) continue;
      utilizations.push(finiteNumberOrNull(limit.utilization));
    }
  }
  const residuals = utilizations
    .filter(utilization => utilization != null)
    .map(utilization => 1 - utilization);
  return {
    min: residuals.length > 0 ? Math.min(...residuals) : null,
    complete: residuals.length === utilizations.length,
  };
}

function compareNewAssignmentCandidates(left, right) {
  if (left.weeklyResetPriority !== right.weeklyResetPriority) {
    return left.weeklyResetPriority ? -1 : 1;
  }
  if (left.weeklyResetAt !== right.weeklyResetAt) {
    return left.weeklyResetAt - right.weeklyResetAt;
  }
  if (left.sessions !== right.sessions) {
    return left.sessions - right.sessions;
  }
  const leftHeadroom = left.headroom.min ?? -1;
  const rightHeadroom = right.headroom.min ?? -1;
  if (leftHeadroom !== rightHeadroom) {
    return rightHeadroom - leftHeadroom;
  }
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }
  return left.index - right.index;
}

function normalizeExcludedAccountIds(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (typeof value === 'string') return new Set([value]);
  if (typeof value[Symbol.iterator] === 'function') return new Set(value);
  return new Set();
}

function normalizeAssignStopUtilization(value) {
  const utilization = Number(value);
  if (!Number.isFinite(utilization)) return DEFAULT_ASSIGN_STOP_UTILIZATION;
  return Math.min(1, Math.max(0, utilization));
}

function sessionCountFor(sessionCounts, accountId) {
  if (!sessionCounts) return 0;
  const raw = typeof sessionCounts.get === 'function' ? sessionCounts.get(accountId) : sessionCounts[accountId];
  const count = Number(raw);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function compareSwitchTargetScores(left, right) {
  if (left.score.weeklyResetPriority !== right.score.weeklyResetPriority) {
    return left.score.weeklyResetPriority ? -1 : 1;
  }
  if (left.score.weeklyResetPriority && right.score.weeklyResetPriority) {
    if (left.score.weeklyResetAt !== right.score.weeklyResetAt) {
      return left.score.weeklyResetAt - right.score.weeklyResetAt;
    }
    if (left.score.weeklyHeadroom !== right.score.weeklyHeadroom) {
      return right.score.weeklyHeadroom - left.score.weeklyHeadroom;
    }
    if (left.score.fiveHourUtilization !== right.score.fiveHourUtilization) {
      return left.score.fiveHourUtilization - right.score.fiveHourUtilization;
    }
  }
  if (left.score.maxUtilization !== right.score.maxUtilization) {
    return left.score.maxUtilization - right.score.maxUtilization;
  }
  if (left.score.totalUtilization !== right.score.totalUtilization) {
    return left.score.totalUtilization - right.score.totalUtilization;
  }
  if (left.score.knownWindows !== right.score.knownWindows) {
    return right.score.knownWindows - left.score.knownWindows;
  }
  if (left.score.priority !== right.score.priority) {
    return left.score.priority - right.score.priority;
  }
  return left.index - right.index;
}

function compareExhaustedFallbackScores(left, right) {
  if (left.score.resetAt !== right.score.resetAt) {
    return left.score.resetAt - right.score.resetAt;
  }
  if (left.score.windowRank !== right.score.windowRank) {
    return left.score.windowRank - right.score.windowRank;
  }
  if (left.score.utilization !== right.score.utilization) {
    return left.score.utilization - right.score.utilization;
  }
  if (left.score.priority !== right.score.priority) {
    return left.score.priority - right.score.priority;
  }
  return left.index - right.index;
}

function parseUsageReset(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function restoreQuota(value) {
  const quota = emptyQuota();
  if (!value || typeof value !== 'object') return quota;
  for (const key of Object.keys(quota)) {
    if (key === 'weeklyScoped') continue;
    quota[key] = restoreNumberOrNull(value[key]);
  }
  quota.weeklyScoped = normalizeWeeklyScopedUsage(value.weeklyScoped);
  if (typeof value.unifiedStatus === 'string') quota.unifiedStatus = value.unifiedStatus;
  if (typeof value.resetsAt === 'string') quota.resetsAt = value.resetsAt;
  return quota;
}

function restoreUsage(value) {
  return {
    totalInputTokens: restoreNumber(value?.totalInputTokens),
    totalOutputTokens: restoreNumber(value?.totalOutputTokens),
    totalRequests: restoreNumber(value?.totalRequests),
    lastUsed: typeof value?.lastUsed === 'string' ? value.lastUsed : null,
  };
}

function restoreTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function restoreNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function restoreNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function restoreStatus(value) {
  return ['ready', 'active', 'exhausted', 'throttled', 'error'].includes(value) ? value : 'ready';
}

function clonePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function normalizeRotationPolicy(policy) {
  const weeklyResetPriorityWindowMs = Number(policy?.weeklyResetPriorityWindowMs);
  return {
    mode: policy?.mode || 'use-expiring-weekly',
    weeklyResetPriorityWindowMs: Number.isFinite(weeklyResetPriorityWindowMs) && weeklyResetPriorityWindowMs > 0
      ? weeklyResetPriorityWindowMs
      : DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS,
  };
}

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteResetAt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value !== Number.MAX_SAFE_INTEGER ? value : null;
}

function scopedWeeklyQuotaUnavailableReason(value, threshold) {
  if (!Array.isArray(value)) return null;
  for (const limit of value) {
    if (!limit || typeof limit.utilization !== 'number' || limit.utilization < threshold) continue;
    return {
      type: 'quota_exhausted',
      window: `7d ${limit.label || limit.key || 'scoped'}`,
      claim: `seven_day_${limit.key || 'scoped'}`,
      utilization: limit.utilization,
      resetAt: limit.resetAt ? new Date(limit.resetAt).toISOString() : null,
    };
  }
  return null;
}

export function isNearQuota(quota, threshold) {
  if (quota.unified5h != null && quota.unified5h >= threshold) return true;
  if (quota.unified7d != null && quota.unified7d >= threshold) return true;
  if (Array.isArray(quota.weeklyScoped) && quota.weeklyScoped.some(limit => limit.utilization >= threshold)) return true;
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    if (1 - quota.tokensRemaining / quota.tokensLimit >= threshold) return true;
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    if (1 - quota.requestsRemaining / quota.requestsLimit >= threshold) return true;
  }
  return false;
}
