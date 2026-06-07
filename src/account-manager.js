import { emptyQuota, parseRateLimitHeaders } from './quota.js';

export class AccountManager {
  constructor({ accounts = [], switchThreshold = 0.99, now = () => Date.now() } = {}) {
    this.now = now;
    this.switchThreshold = switchThreshold;
    this.events = [];
    this.accounts = accounts.map((account, index) => this.createAccount(account, index));
    this.currentIndex = 0;
  }

  getActiveAccount() {
    const current = this.accounts[this.currentIndex];
    if (this.isAvailable(current)) {
      current.status = 'active';
      return current;
    }

    const next = this.selectNextAvailable();
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
    return this.accounts.find(account => this.unavailableReason(account)?.type === 'quota_exhausted')
      || this.getCurrentAccount();
  }

  switchTo(accountId) {
    const index = this.accounts.findIndex(account => account.id === accountId || account.name === accountId);
    if (index < 0) throw new Error(`Unknown account: ${accountId}`);
    this.accounts[this.currentIndex].status = 'ready';
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
    if (payload?.five_hour) {
      if (typeof payload.five_hour.utilization === 'number') account.quota.unified5h = payload.five_hour.utilization;
      if (payload.five_hour.resets_at) account.quota.unified5hReset = Date.parse(payload.five_hour.resets_at);
    }
    if (payload?.seven_day) {
      if (typeof payload.seven_day.utilization === 'number') account.quota.unified7d = payload.seven_day.utilization;
      if (payload.seven_day.resets_at) account.quota.unified7dReset = Date.parse(payload.seven_day.resets_at);
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

  markTemporaryUnavailable(accountId, retryAfterSeconds, reason, event = {}) {
    const account = this.find(accountId);
    account.rateLimitedUntil = this.now() + retryAfterSeconds * 1000;
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
      return {
        ...existing,
        name: account.name || account.email || account.id,
        type: account.type || 'oauth',
        accountUuid: account.accountUuid || null,
        priority: account.priority ?? index,
        status: existing.status === 'error' ? 'ready' : existing.status,
        errorReason: existing.status === 'error' ? null : existing.errorReason,
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

  selectNextAvailable() {
    const start = this.currentIndex;
    for (let offset = 1; offset <= this.accounts.length; offset++) {
      const index = (start + offset) % this.accounts.length;
      const candidate = this.accounts[index];
      if (this.isAvailable(candidate)) {
        const previous = this.accounts[this.currentIndex];
        const reason = this.autoSwitchReason(previous);
        if (previous) previous.status = this.displayStatus(previous);
        this.currentIndex = index;
        this.events.unshift({
          at: new Date(this.now()).toISOString(),
          type: 'auto-switch',
          from: previous?.id || null,
          to: candidate.id,
          reason,
        });
        return candidate;
      }
    }
    return null;
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
    if (account.rateLimitedUntil && now >= account.rateLimitedUntil) {
      account.rateLimitedUntil = null;
      account.temporaryUnavailableReason = null;
      account.status = 'ready';
    }

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
    const quotaReason = quotaUnavailableReason(account.quota, this.switchThreshold);
    if (quotaReason) return quotaReason;
    if (account.rateLimitedUntil && this.now() < account.rateLimitedUntil) {
      return {
        ...(account.temporaryUnavailableReason || { type: 'temporary_throttle' }),
        retryAt: new Date(account.rateLimitedUntil).toISOString(),
      };
    }
    if (account.status === 'error') {
      return account.errorReason || { type: 'account_error' };
    }
    return null;
  }

  autoSwitchReason(account) {
    const reason = this.unavailableReason(account);
    if (!reason) return 'account-unavailable';
    if (reason.type === 'quota_exhausted') return 'quota-threshold';
    return reason.type;
  }

  displayStatus(account) {
    if (account.status === 'active' && this.accounts[this.currentIndex]?.id === account.id) return 'active';
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

export function isNearQuota(quota, threshold) {
  if (quota.unified5h != null && quota.unified5h >= threshold) return true;
  if (quota.unified7d != null && quota.unified7d >= threshold) return true;
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    if (1 - quota.tokensRemaining / quota.tokensLimit >= threshold) return true;
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    if (1 - quota.requestsRemaining / quota.requestsLimit >= threshold) return true;
  }
  return false;
}
