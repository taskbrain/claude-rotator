import { emptyQuota, normalizeWeeklyScopedUsage, parseRateLimitHeaders } from './quota.js';
import {
  DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS,
  DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS,
} from './oauth.js';

export const DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export class AccountManager {
  constructor({
    accounts = [],
    switchThreshold = 1,
    currentAccountId = null,
    now = () => Date.now(),
    rotationPolicy = null,
  } = {}) {
    this.now = now;
    this.switchThreshold = switchThreshold;
    this.rotationPolicy = normalizeRotationPolicy(rotationPolicy);
    this.events = [];
    this.accounts = accounts.map((account, index) => this.createAccount(account, index));
    const configuredIndex = currentAccountId
      ? this.accounts.findIndex(account => account.id === currentAccountId || account.name === currentAccountId)
      : -1;
    this.currentIndex = configuredIndex >= 0 ? configuredIndex : 0;
  }

  getActiveAccount() {
    const current = this.accounts[this.currentIndex];
    if (this.isAvailable(current)) {
      current.status = 'active';
      return current;
    }

    const reason = this.unavailableReason(current);
    if (current?.status === 'error' || reason?.type === 'oauth_refresh_rate_limit') {
      const next = this.selectBestAvailableSwitchTarget();
      if (next) {
        next.status = 'active';
        return next;
      }
      return null;
    }
    if (!isUnifiedQuotaExhaustion(reason)) return null;

    const next = this.selectBestAvailableSwitchTarget();
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
  }

  updateQuota(accountId, headers) {
    const account = this.find(accountId);
    const parsed = parseRateLimitHeaders(headers);
    account.quota = { ...account.quota, ...parsed };
    this.refreshQuotaState(account);
  }

  applyUsage(accountId, payload) {
    const account = this.find(accountId);
    this.markAuthenticated(account);
    if (payload?.five_hour) {
      if (typeof payload.five_hour.utilization === 'number') account.quota.unified5h = payload.five_hour.utilization;
      if (Object.prototype.hasOwnProperty.call(payload.five_hour, 'resets_at')) {
        account.quota.unified5hReset = parseUsageReset(payload.five_hour.resets_at);
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

  markError(accountId, type = 'account_error', message = null) {
    const account = this.find(accountId);
    account.status = 'error';
    account.errorReason = { type };
    if (message) account.errorReason.message = message;
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'account-error',
      account: account.id,
      reason: account.errorReason,
    });
  }

  markAuthenticated(accountOrId) {
    const account = typeof accountOrId === 'string' ? this.find(accountOrId) : accountOrId;
    const credentialThrottled = account.temporaryUnavailableReason?.type === 'oauth_refresh_rate_limit';
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

  replaceAccounts(accounts) {
    const existingById = new Map(this.accounts.map(account => [account.id, account]));
    this.accounts = accounts.map((account, index) => {
      const existing = existingById.get(account.id);
      if (!existing) return this.createAccount(account, index);
      const resetCredentialCooldown = existing.temporaryUnavailableReason?.type
        === 'oauth_refresh_rate_limit';
      const resetError = existing.status === 'error';
      return {
        ...existing,
        name: account.name || account.email || account.id,
        type: account.type || 'oauth',
        accountUuid: account.accountUuid || null,
        priority: account.priority ?? index,
        status: resetError || resetCredentialCooldown ? 'ready' : existing.status,
        errorReason: resetError ? null : existing.errorReason,
        rateLimitedUntil: resetCredentialCooldown ? null : existing.rateLimitedUntil,
        temporaryUnavailableReason: resetCredentialCooldown
          ? null
          : existing.temporaryUnavailableReason,
      };
    });
    if (this.currentIndex >= this.accounts.length) this.currentIndex = 0;
    if (this.accounts.length > 0 && !this.accounts[this.currentIndex]) this.currentIndex = 0;
    this.events.unshift({
      at: new Date(this.now()).toISOString(),
      type: 'reload',
      accounts: this.accounts.length,
    });
  }

  getStatus() {
    const active = this.accounts[this.currentIndex];
    return {
      currentAccount: active?.id || null,
      currentAccountName: active?.name || null,
      switchThreshold: this.switchThreshold,
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

  exportState() {
    const active = this.accounts[this.currentIndex];
    return {
      version: 1,
      savedAt: new Date(this.now()).toISOString(),
      currentAccount: active?.id || null,
      accounts: this.accounts.map(account => ({
        id: account.id,
        status: account.status,
        quota: { ...account.quota },
        usage: { ...account.usage },
        rateLimitedUntil: account.rateLimitedUntil ? new Date(account.rateLimitedUntil).toISOString() : null,
        temporaryUnavailableReason: clonePlainObject(account.temporaryUnavailableReason),
        errorReason: clonePlainObject(account.errorReason),
      })),
    };
  }

  restoreState(state) {
    if (!state || typeof state !== 'object') return;
    const savedById = new Map((Array.isArray(state.accounts) ? state.accounts : [])
      .filter(account => account && typeof account.id === 'string')
      .map(account => [account.id, account]));

    for (const account of this.accounts) {
      const saved = savedById.get(account.id);
      if (!saved) continue;
      account.status = restoreStatus(saved.status);
      account.quota = restoreQuota(saved.quota);
      account.usage = restoreUsage(saved.usage);
      account.rateLimitedUntil = restoreTimestamp(saved.rateLimitedUntil);
      account.temporaryUnavailableReason = clonePlainObject(saved.temporaryUnavailableReason);
      account.errorReason = clonePlainObject(saved.errorReason);
      this.normalizeRestoredCredentialCooldown(account);
      account.quotaExhaustionEventKey = null;
      this.refreshQuotaState(account);
    }

    if (state.currentAccount) {
      const index = this.accounts.findIndex(account => account.id === state.currentAccount);
      if (index >= 0) this.currentIndex = index;
    }
  }

  normalizeRestoredCredentialCooldown(account) {
    const reason = account.temporaryUnavailableReason;
    if (reason?.type !== 'oauth_refresh_rate_limit') return;
    if (!account.rateLimitedUntil) return;
    const remainingMs = account.rateLimitedUntil - this.now();
    if (reason.retryAfterSource === 'provider') {
      account.rateLimitedUntil = Math.min(
        account.rateLimitedUntil,
        this.now() + DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS,
      );
      return;
    }
    if (remainingMs <= DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS) return;
    account.rateLimitedUntil = null;
    account.temporaryUnavailableReason = null;
    if (account.status === 'throttled') account.status = 'ready';
  }

  selectBestAvailableSwitchTarget() {
    const selected = this.bestAvailableSwitchCandidate({ excludeCurrent: true });
    if (!selected) return null;

    const previous = this.accounts[this.currentIndex];
    const reason = this.autoSwitchReason(previous);
    return this.switchToCandidate(selected, reason);
  }

  prepareResumeTarget() {
    const previousId = this.getCurrentAccount()?.id || null;
    const available = this.bestAvailableSwitchCandidate({ excludeCurrent: false });
    if (available) {
      const account = available.index === this.currentIndex
        ? available.account
        : this.switchToCandidate(available, 'resume-ready');
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

    const account = this.switchToExhaustedFallbackCandidate(selected);
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
      if (!this.getActiveAccount()) return this.getFallbackAccount();
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

    return this.switchToCandidate(selected, 'weekly-reset-priority');
  }

  bestAvailableSwitchCandidate({ excludeCurrent } = {}) {
    const candidates = this.accounts
      .map((account, index) => ({ account, index, score: this.switchTargetScore(account) }))
      .filter(candidate => (!excludeCurrent || candidate.index !== this.currentIndex) && candidate.score);

    candidates.sort((left, right) => compareSwitchTargetScores(left, right));
    return candidates[0] || null;
  }

  switchToCandidate(selected, reason) {
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
    return selected.account;
  }

  selectBestExhaustedFallback() {
    const selected = this.bestExhaustedFallbackCandidate();
    if (!selected) return null;
    return this.switchToExhaustedFallbackCandidate(selected);
  }

  bestExhaustedFallbackCandidate() {
    const candidates = this.accounts
      .map((account, index) => ({ account, index, score: this.exhaustedFallbackScore(account) }))
      .filter(candidate => candidate.score);

    candidates.sort((left, right) => compareExhaustedFallbackScores(left, right));
    return candidates[0] || null;
  }

  switchToExhaustedFallbackCandidate(selected) {
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
    }
    return selected.account;
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

  switchTargetScore(account) {
    if (!this.isAvailable(account)) return null;
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

  isAvailable(account) {
    if (!account) return false;
    this.refreshQuotaState(account);
    if (account.status === 'throttled') return false;
    if (account.status === 'exhausted') return false;
    if (account.status === 'error') return false;
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

  autoSwitchReason(account) {
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
      status: 'ready',
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      temporaryUnavailableReason: null,
      errorReason: null,
      quotaExhaustionEventKey: null,
    };
  }
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

export function isUnifiedQuotaExhaustion(reason) {
  return reason?.type === 'quota_exhausted'
    && (['5h', '7d'].includes(reason.window) || String(reason.window || '').startsWith('7d '));
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
