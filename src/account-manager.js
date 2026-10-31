import { AccountUrgency, urgencyMode, URGENCY_THRESHOLD } from './account-urgency.js';
import {
  emptyQuota,
  normalizeWeeklyScopedUsage,
  normalizeWeeklyScopedObservations,
  parseRateLimitHeaders,
  planQuotaMode,
  observeQuotaWindows,
  quotaWindowsView,
  restoreQuotaWindowObservations,
  boundWeeklyScopes,
  scopeMatchesModelFamily,
  isValidQuotaWindow,
  USAGE_SOURCES,
} from './quota.js';
import {
  DEFAULT_MAX_PROVIDER_RETRY_AFTER_MS,
  DEFAULT_MAX_TOKEN_REFRESH_BACKOFF_MS,
  DEFAULT_SUSTAINED_TOKEN_REFRESH_RETRY_MS,
} from './oauth.js';

export const DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

/**
 * Whether a value can be used as a login expiry (ms): a finite number above 0,
 * no later than the last time a Date can hold. The ledger and the alert watch
 * both accept exactly these values.
 */
export function isLoginExpiryValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_TIMESTAMP_MS;
}

/**
 * Affinity-only selector constants.
 * `DEFAULT_ASSIGN_STOP_UTILIZATION` stops NEW assignments at 90% - it is not an
 * eviction line: a session already bound to a 90% account stays there until the
 * account actually runs out. `ASSIGN_BAND_WIDTH` is the 5-point band below
 * the best headroom inside which the load keys are allowed to decide; the width
 * itself is an authoring judgement that has not been measured.
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
// `getStatus()` has always returned the newest 50 events; the same number bounds
// the array in memory and in the saved state once the history is enabled.
const EVENT_HISTORY_LIMIT = 50;
// The same account / key / value dropped from a utilization header is recorded
// as a `quota-header-rejected` event at most once per this interval.
const QUOTA_HEADER_REJECT_EVENT_INTERVAL_MS = 10 * 60 * 1000;
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
    accountUrgency = null,
    planQuota = null,
    logger = null,
    // Keep `events` as a bounded, persisted history.
    // The ledger is told nothing about session affinity - not the instance, not
    // the mode string: the caller that knows the mode passes this one
    // boolean. While it is false the array behaves exactly as it does today -
    // unbounded, never exported, never restored - so the default configuration
    // keeps runtime-state.json, /internal/status and `claude-rotator status`
    // byte-identical. The unbounded growth that leaves behind is a separate
    // follow-up, deliberately not fixed here.
    eventHistory = false,
  } = {}) {
    this.now = now;
    this.logger = typeof logger === 'function' ? logger : null;
    this.switchThreshold = normalizeSwitchThreshold(switchThreshold);
    this.rotationPolicy = normalizeRotationPolicy(rotationPolicy);
    this.eventHistoryEnabled = eventHistory === true;
    this.stateListener = null;
    this.events = [];
    this.quotaHeaderRejectRecordedAt = new Map();
    this.accounts = accounts.map((account, index) => this.createAccount(account, index));
    const configuredIndex = currentAccountId
      ? this.accounts.findIndex(account => account.id === currentAccountId || account.name === currentAccountId)
      : -1;
    this.currentIndex = configuredIndex >= 0 ? configuredIndex : 0;
    this.configuredSwitchThreshold = this.switchThreshold;
    this.urgency = null;
    this.configureAccountUrgency(accountUrgency);
    this.configurePlanQuota(planQuota);
  }

  configurePlanQuota(raw) {
    this.planQuotaMode = planQuotaMode(raw);
    for (const account of this.accounts) account.extendedQuotaScopes = this.planQuotaMode === 'on' || this.urgency?.mode === 'on';
    if (this.planQuotaMode === 'on' || this.urgency?.mode === 'on') {
      for (const account of this.accounts) {
        const last = account.windowObservations?.['5h']?.lastKnown;
        if (isValidQuotaWindow(last?.usedFraction, last?.resetAt, this.now())) {
          account.quota.unified5h = last.usedFraction;
          account.quota.unified5hReset = last.resetAt;
        }
        const scopes = new Map(account.quota.weeklyScoped.map(limit => [limit.key, limit]));
        for (const [id, observation] of Object.entries(account.windowObservations || {})) {
          const known = observation.lastKnown;
          if (!id.startsWith('7d_') || !isValidQuotaWindow(known?.usedFraction, known?.resetAt, this.now())) continue;
          const key = id.slice(3);
          scopes.set(key, { key, label: scopes.get(key)?.label || key,
            utilization: known.usedFraction, resetAt: known.resetAt });
        }
        account.quota.weeklyScoped = boundWeeklyScopes([...scopes.values()]);
      }
    }
  }

  observePlanQuota(account, fields, source) {
    if (this.planQuotaMode === 'off' && !this.urgency) return;
    account.windowObservations = observeQuotaWindows(account.windowObservations, fields, this.now(), source);
  }

  quotaWindowsStatus() {
    return {
      schemaVersion: 1, mode: this.planQuotaMode, generatedAt: this.now(),
      accounts: this.accounts.map(account => ({
        accountId: account.id, windows: quotaWindowsView(account.quota, account.windowObservations, this.now()),
      })),
    };
  }

  configureAccountUrgency(raw) {
    const mode = urgencyMode(raw);
    if (mode === 'off') this.urgency = null;
    else if (!this.urgency) this.urgency = new AccountUrgency({ mode, now: this.now, logger: this.logger });
    else if (this.urgency.mode !== mode) {
      this.urgency.mode = mode;
      this.urgency.notified.clear();
    }
    this.switchThreshold = mode === 'on' ? Math.min(URGENCY_THRESHOLD, this.configuredSwitchThreshold) : this.configuredSwitchThreshold;
    for (const account of this.accounts) account.extendedQuotaScopes = mode === 'on' || this.planQuotaMode === 'on';
  }

  setUrgencyNotifier(notifier) {
    if (this.urgency) this.urgency.notifier = notifier;
  }

  urgencyRows(modelFamily = null) {
    if (!this.urgency) return [];
    return this.accounts.map(account => {
      this.refreshQuotaState(account);
      const row = this.urgency.metrics(account.id, account.status === 'error'
      || Boolean(account.rateLimitedUntil && this.now() < account.rateLimitedUntil)
      || quotaBlocksModelFamily(account.quota, Math.min(URGENCY_THRESHOLD, this.configuredSwitchThreshold), modelFamily, true),
      modelFamily, account.quota.weeklyScoped);
      const recoveryOnly = ['weekly-unknown-or-stale', 'scoped-weekly-unknown-or-stale'].includes(row.exclusionReason)
        && this.canRecoverWeeklyQuota(account, modelFamily, Math.min(URGENCY_THRESHOLD, this.configuredSwitchThreshold));
      return { ...row, recoveryOnly, ...(recoveryOnly ? { eligible: true, exclusionReason: null, unusedRisk: false } : {}) };
    });
  }

  canSendWithUrgency(account, modelFamily = null) {
    if (this.urgency?.mode === 'on') return this.urgencyRows(modelFamily).some(row => row.accountId === account?.id && row.eligible);
    return this.planQuotaMode !== 'on' || this.canRecoverWeeklyQuota(account, modelFamily);
  }

  hasFreshWeeklyQuota(account, modelFamily = null) {
    if (!account) return false;
    const now = this.now();
    const fresh = (id, value, resetAt) => {
      const observation = account.windowObservations?.[id];
      const at = observation?.lastKnown?.observedAt;
      return Number.isFinite(value) && Number.isFinite(resetAt) && resetAt > now
        && Number.isFinite(at) && at <= now && now - at <= 30 * 60_000
        && !['explicit_null', 'invalid'].includes(observation.observationState);
    };
    return fresh('7d', account.quota.unified7d, account.quota.unified7dReset)
      && (account.quota.weeklyScoped || []).filter(limit => scopeMatchesModelFamily(limit, modelFamily, true))
        .every(limit => fresh(`7d_${limit.key}`, limit.utilization, limit.resetAt));
  }

  canRecoverWeeklyQuota(account, modelFamily = null, threshold = this.switchThreshold) {
    if (!account || !this.isAvailable(account, modelFamily)
      || quotaBlocksModelFamily(account.quota, threshold, modelFamily, true)) return false;
    const now = this.now();
    const usable = (id, utilization, resetAt) => {
      const observation = account.windowObservations?.[id];
      return isValidQuotaWindow(utilization, resetAt, now) && utilization < threshold && resetAt - now <= 168 * 3_600_000
        && (!observation || (observation.observedAt <= now
          && !['explicit_null', 'invalid'].includes(observation.observationState)));
    };
    if (!usable('7d', account.quota.unified7d, account.quota.unified7dReset)) return false;
    const scopes = new Map(account.quota.weeklyScoped.map(limit => [limit.key, limit]));
    for (const [id, observation] of Object.entries(account.windowObservations || {})) {
      if (!id.startsWith('7d_') || scopes.has(id.slice(3))) continue;
      scopes.set(id.slice(3), { key: id.slice(3), utilization: observation.lastKnown?.usedFraction,
        resetAt: observation.lastKnown?.resetAt });
    }
    return [...scopes.values()].filter(limit => scopeMatchesModelFamily(limit, modelFamily, true))
      .every(limit => usable(`7d_${limit.key}`, limit.utilization, limit.resetAt));
  }

  observeUrgency(account, fields, source = null) {
    if (!this.urgency) return;
    this.urgency.observe(account.id, fields, source);
    this.urgency.checkRisks(this.urgencyRows());
  }

  planUrgencyReassignment({ bound, boundAt, modelFamily = null, turnBoundary, inFlight, sid = null, onDecision = null }) {
    if (!this.urgency || !bound) return null;
    const rows = this.urgencyRows(modelFamily);
    const target = this.urgency.rank(rows).find(row => row.unusedRisk && row.accountId !== bound.id);
    const current = rows.find(row => row.accountId === bound.id);
    const reason = !target ? 'no-unused-risk'
      : !turnBoundary ? 'within-turn'
        : inFlight ? 'request-in-flight'
          : !Number.isFinite(boundAt) || this.now() - boundAt < 3_600_000 ? 'binding-cooldown'
            : !current?.eligible || current.recoveryOnly ? 'current-unknown-or-unavailable'
              : target.requiredPace < current.requiredPace * 1.25
                || target.requiredPace - current.requiredPace < 0.01 ? 'pace-hysteresis'
                : 'unused-before-reset';
    const wouldReassign = reason === 'unused-before-reset';
    const decision = {
      purpose: 'reassignment', sid,
      actualAccountId: this.urgency.mode === 'on' && wouldReassign ? target.accountId : bound.id,
      proposedAccountId: target?.accountId ?? bound.id, reason, wouldReassign,
      metrics: rows,
    };
    if (onDecision) onDecision(decision);
    else this.urgency.record('decisions', decision);
    return this.urgency.mode === 'on' && wouldReassign ? this.findOrNull(target.accountId) : null;
  }

  recordUrgencyReassignment(from, to, sid) {
    this.urgency?.record('reassignments', { fromAccountId: from, toAccountId: to, sid, reason: 'unused-before-reset' });
  }

  /**
   * @param {string|null} modelFamily 'fable' for a Fable request, null for every
   *   other (or unidentified) request. A Fable-only sub-cap exhaustion never
   *   blocks a non-Fable request; a common 5h/7d exhaustion blocks every family.
   */
  getActiveAccount(modelFamily = null, { trigger = 'unknown' } = {}) {
    if (this.urgency?.mode === 'on' || this.planQuotaMode === 'on') {
      const account = this.selectForNewAssignment({ modelFamily });
      if (!account) return null;
      const index = this.accounts.indexOf(account);
      if (index !== this.currentIndex) return this.switchToCandidate({ account, index, score: {} },
        this.urgency?.mode === 'on' ? 'required-pace' : 'weekly-headroom', trigger);
      return account;
    }
    const actual = this.getLegacyActiveAccount(modelFamily, { trigger });
    if (this.urgency && trigger === 'request') {
      const rows = this.urgencyRows(modelFamily);
      this.urgency.record('decisions', {
        purpose: 'keyless-request', actualAccountId: actual?.id ?? null,
        proposedAccountId: this.urgency.rank(rows)[0]?.accountId ?? null,
        reason: 'required-pace', metrics: rows,
      });
    }
    return actual;
  }

  getLegacyActiveAccount(modelFamily = null, { trigger = 'unknown' } = {}) {
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
    this.recordEvent({
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
    const parsed = parseRateLimitHeaders(headers, {
      onInvalid: rejected => this.recordQuotaHeaderRejected(account, rejected),
      includeScopedWindows: this.planQuotaMode !== 'off' || this.urgency !== null,
    });
    const reported = structuredClone(parsed);
    const validateValues = this.planQuotaMode === 'on' || this.urgency?.mode === 'on';
    if (atomicUnifiedWindows || validateValues) {
      keepUnifiedWindowAtomic(parsed, 'unified5h', 'unified5hReset', this.now(), validateValues);
      keepUnifiedWindowAtomic(parsed, 'unified7d', 'unified7dReset', this.now(), validateValues);
    }
    // A response without unified utilization (or whose values were all dropped)
    // leaves the previous reading and its source untouched.
    if ('unified5h' in parsed || 'unified7d' in parsed) {
      parsed.usageSource = 'header';
      parsed.usageUpdatedAt = this.now();
    }
    const applied = { ...parsed };
    if (this.planQuotaMode !== 'on' && this.urgency?.mode !== 'on') delete applied.weeklyScoped;
    if (applied.weeklyScoped) {
      const byKey = new Map((account.quota.weeklyScoped || []).map(limit => [limit.key, limit]));
      for (const limit of applied.weeklyScoped) byKey.set(limit.key, limit);
      account.quota = { ...account.quota, ...applied, weeklyScoped: boundWeeklyScopes([...byKey.values()]) };
    } else account.quota = { ...account.quota, ...applied };
    this.observePlanQuota(account, reported, 'header');
    this.observeUrgency(account, { ...reported, scopedWeeklyPartial: true }, 'header');
    this.refreshQuotaState(account);
  }

  recordQuotaHeaderRejected(account, { key, value }) {
    const now = this.now();
    const dedupeKey = JSON.stringify([account.id, key, value]);
    const last = this.quotaHeaderRejectRecordedAt.get(dedupeKey);
    if (last != null && now - last < QUOTA_HEADER_REJECT_EVENT_INTERVAL_MS) return;
    for (const [entry, at] of this.quotaHeaderRejectRecordedAt) {
      if (now - at >= QUOTA_HEADER_REJECT_EVENT_INTERVAL_MS) this.quotaHeaderRejectRecordedAt.delete(entry);
    }
    this.quotaHeaderRejectRecordedAt.set(dedupeKey, now);
    this.recordEvent({
      at: new Date(now).toISOString(),
      type: 'quota-header-rejected',
      account: account.id,
      key,
      value,
    });
  }

  applyUsage(accountId, payload) {
    const account = this.find(accountId);
    this.markAuthenticated(account);
    let utilizationUpdated = false;
    const atomicUsage = this.planQuotaMode === 'on' || this.urgency?.mode === 'on';
    const completeBucket = bucket => isValidQuotaWindow(bucket?.utilization, parseUsageReset(bucket?.resets_at), this.now());
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'five_hour')) {
      if (payload.five_hour == null) {
        const retain = (this.planQuotaMode === 'on' || this.urgency?.mode === 'on')
          && account.quota.unified5h != null
          && (account.quota.unified5hReset == null || account.quota.unified5hReset > this.now());
        if (!retain) {
          account.quota.unified5h = null;
          account.quota.unified5hReset = null;
        }
      }
    }
    if (payload?.five_hour && (!atomicUsage || completeBucket(payload.five_hour))) {
      if (typeof payload.five_hour.utilization === 'number') {
        account.quota.unified5h = payload.five_hour.utilization;
        utilizationUpdated = true;
      }
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
    if (payload?.seven_day && (!atomicUsage || completeBucket(payload.seven_day))) {
      if (typeof payload.seven_day.utilization === 'number') {
        account.quota.unified7d = payload.seven_day.utilization;
        utilizationUpdated = true;
      }
      if (Object.prototype.hasOwnProperty.call(payload.seven_day, 'resets_at')) {
        account.quota.unified7dReset = parseUsageReset(payload.seven_day.resets_at);
      }
    }
    if (Array.isArray(payload?.scoped_weekly)) {
      account.quota.weeklyScoped = atomicUsage ? boundWeeklyScopes(normalizeWeeklyScopedObservations(payload.scoped_weekly).map(limit => {
        if (Number.isFinite(limit.utilization) && Number.isFinite(limit.resetAt) && limit.resetAt > this.now()) return limit;
        const prior = account.quota.weeklyScoped.find(previous => previous.key === limit.key);
        return prior && (prior.resetAt == null || prior.resetAt > this.now()) ? prior : limit;
      })) : normalizeWeeklyScopedUsage(payload.scoped_weekly);
    }
    // Only a 5h / 7d utilization reading counts; a scoped-weekly-only payload
    // leaves the previous source and time in place.
    if (utilizationUpdated) {
      account.quota.usageSource = 'poll';
      account.quota.usageUpdatedAt = this.now();
    }
    const observed = {};
    for (const [source, valueKey, resetKey] of [
      ['five_hour', 'unified5h', 'unified5hReset'],
      ['seven_day', 'unified7d', 'unified7dReset'],
    ]) {
      if (!Object.prototype.hasOwnProperty.call(payload || {}, source)) continue;
      observed[valueKey] = payload[source] === null ? null : payload[source]?.utilization;
      observed[resetKey] = parseUsageReset(payload[source]?.resets_at);
    }
    if (Array.isArray(payload?.scoped_weekly)) observed.weeklyScoped = normalizeWeeklyScopedObservations(payload.scoped_weekly);
    this.observePlanQuota(account, observed, 'poll');
    this.observeUrgency(account, observed, 'poll');
    this.refreshQuotaState(account);
  }

  /**
   * 1応答ぶんの usage を積む。
   *
   * `countRequest` は**usage を実際に読めたときだけ**真にすること（呼び出し側で
   * `parseUsageObservation()` の `parse === 'ok'` を判定する）。旧実装はストリーム応答で
   * `message_start` と `message_delta` の2回呼ばれ、1要求で `totalRequests` が 2 増えていた。
   * 「1応答＝1件」に直すため、件数の計上を引数で明示的に受け取る形にした。
   * 読めなかった要求の件数は `server.log` の `usageParse=` の分布から数える。
   */
  updateUsage(accountId, {
    inputTokens = 0,
    outputTokens = 0,
    cacheReadTokens = 0,
    cacheCreation1hTokens = 0,
    cacheCreation5mTokens = 0,
    countRequest = false,
  } = {}) {
    const account = this.find(accountId);
    account.usage.totalInputTokens += inputTokens;
    account.usage.totalOutputTokens += outputTokens;
    account.usage.totalCacheReadTokens += cacheReadTokens;
    account.usage.totalCacheCreation1hTokens += cacheCreation1hTokens;
    account.usage.totalCacheCreation5mTokens += cacheCreation5mTokens;
    if (countRequest) account.usage.totalRequests += 1;
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
    this.recordEvent({
      at: new Date(this.now()).toISOString(),
      type: event.eventType || 'upstream-error',
      account: account.id,
      retryAfterSeconds: event.retryAfterSeconds ?? retryAfterSeconds,
      reason: account.temporaryUnavailableReason,
    });
    this.notifyStateListener(account);
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
    this.recordEvent({
      at: new Date(this.now()).toISOString(),
      type: 'account-error',
      account: account.id,
      reason: account.errorReason,
    });
    this.notifyStateListener(account);
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
    this.notifyStateListener(account);
  }

  /**
   * Register the one function told about account state changes (the alert
   * watch). It is called with the ledger row after `markError`,
   * `markTemporaryUnavailable`, `markAuthenticated`, and for every row after
   * `replaceAccounts` with `{ credentialChanged }`. The row carries no
   * credential material. Anything but a function clears it.
   *
   * @param {((account: object, details?: {credentialChanged: boolean}) => void)|null} listener
   */
  setStateListener(listener) {
    this.stateListener = typeof listener === 'function' ? listener : null;
  }

  /**
   * Record the login expiry a credential refresh just reported for an account
   * (ms, or null when the refresh gave none). `getStatus()` shows it as the
   * row's `loginExpiry`. A value that is not a usable expiry keeps the one
   * already known. Unknown ids are ignored. Never throws, and does not call the
   * state listener.
   */
  noteLoginExpiry(accountId, value) {
    const account = this.accounts.find(item => item.id === accountId);
    if (!account) return;
    account.loginExpirySeen = true;
    if (isLoginExpiryValue(value)) account.loginExpiresAt = value;
  }

  // A listener failure must never change the ledger or reach the caller.
  notifyStateListener(account, details) {
    if (!this.stateListener || !account) return;
    try {
      this.stateListener(account, details);
    } catch {
      // Swallowed on purpose: the state change itself is already done.
    }
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
    this.recordEvent(event);
    return event;
  }

  /**
   * Rebuild the ledger from a reloaded configuration.
   *
   * @returns {string[]} the ids of the accounts that stayed in the ledger but
   *   whose credential identity changed. The row keeps its
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
        // A changed credential has its own expiry, not known until its first refresh.
        loginExpiryTracked: tracksLoginExpiry(account),
        loginExpiresAt: credentialIdentityChanged ? null : existing.loginExpiresAt,
        loginExpirySeen: credentialIdentityChanged ? false : existing.loginExpirySeen,
        windowObservations: credentialIdentityChanged ? {} : existing.windowObservations,
        extendedQuotaScopes: this.planQuotaMode === 'on' || this.urgency?.mode === 'on',
      };
    });
    this.urgency?.prune(this.accounts.map(account => account.id).filter(id => !credentialChangedIds.includes(id)));
    if (this.currentIndex >= this.accounts.length) this.currentIndex = 0;
    if (this.accounts.length > 0 && !this.accounts[this.currentIndex]) this.currentIndex = 0;
    this.recordEvent({
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
    if (this.stateListener) {
      const changed = new Set(credentialChangedIds);
      for (const account of this.accounts) {
        this.notifyStateListener(account, { credentialChanged: changed.has(account.id) });
      }
    }
    return credentialChangedIds;
  }

  /**
   * Turn the bounded, persisted event history on or off.
   * Called by the wiring that owns the session-affinity mode - at startup and
   * again on POST /internal/reload, so a mode change takes effect immediately.
   *
   * @param {boolean} enabled
   */
  setEventHistoryEnabled(enabled) {
    this.eventHistoryEnabled = enabled === true;
  }

  // The single write port for `events`. The cap is applied only while the
  // history is enabled; with it off the array keeps growing exactly as today.
  recordEvent(event) {
    this.events.unshift(event);
    if (this.eventHistoryEnabled && this.events.length > EVENT_HISTORY_LIMIT) {
      this.events.length = EVENT_HISTORY_LIMIT;
    }
    return event;
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
          ...(account.loginExpiryTracked ? { loginExpiry: loginExpiryOf(account) } : {}),
        };
      }),
      events: this.events.slice(0, EVENT_HISTORY_LIMIT),
      ...(this.urgency ? { accountUrgency: this.urgency.status(this.urgencyRows(), this.urgencyRows('fable'),
        new Map(this.accounts.map(account => [account.id, account.windowObservations]))) } : {}),
      ...(this.planQuotaMode !== 'off' ? { quotaWindows: this.quotaWindowsStatus() } : {}),
    };
  }

  getRoutingAvailability(modelFamily = null) {
    const candidates = this.accounts.map((account, index) => {
      this.refreshQuotaState(account);
      const isCurrent = index === this.currentIndex;
      const available = this.isAvailable(account, modelFamily)
        && this.canSendWithUrgency(account, modelFamily);
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
      // The key itself is absent while the history is off, so the saved file of
      // a default configuration stays byte-identical.
      ...(this.eventHistoryEnabled
        ? { events: this.events.slice(0, EVENT_HISTORY_LIMIT) }
        : {}),
      accounts: this.accounts.map(account => ({
        id: account.id,
        accountUuid: account.accountUuid,
        credentialRevision: account.credentialRevision,
        status: account.status,
        quota: { ...account.quota },
        ...(this.planQuotaMode !== 'off' || this.urgency
          ? { windowObservations: structuredClone(account.windowObservations) } : {}),
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
   *   `replaceAccounts`. EVERY return path returns an
   *   array, the early return for a broken saved state included: a bare
   *   `return` would hand `undefined` to session affinity exactly in the
   *   case of an unreadable saved state, where it is least likely to be noticed.
   */
  restoreState(state) {
    if (!state || typeof state !== 'object') return [];
    const savedById = new Map((Array.isArray(state.accounts) ? state.accounts : [])
      .filter(account => account && typeof account.id === 'string')
      .map(account => [account.id, account]));

    const credentialChangedIds = [];
    for (const account of this.accounts) {
      const saved = savedById.get(account.id);
      if (!saved) {
        // 保存側に使える行が無い口座（行が壊れていて id で引けない、
        // または保存より後に足された）は、資格情報が同じである証拠が無いので
        // 「変わった」側へ倒す。表にバインドが無ければ evictAccounts は何も落とさない
        // ので、安全側へ倒しても副作用は無い。
        credentialChangedIds.push(account.id);
        continue;
      }
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
      if (!credentialIdentityChanged && (this.planQuotaMode === 'on' || this.urgency?.mode === 'on')) {
        account.quota.weeklyScoped = boundWeeklyScopes(normalizeWeeklyScopedObservations(saved.quota?.weeklyScoped));
      }
      account.windowObservations = credentialIdentityChanged || (this.planQuotaMode === 'off' && !this.urgency)
        ? {} : restoreQuotaWindowObservations(saved.windowObservations);
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

    // A saved state written before this key existed (or with a broken value) is
    // not an error: the history simply starts empty.
    if (this.eventHistoryEnabled) {
      this.events = (Array.isArray(state.events) ? state.events : [])
        .filter(event => event && typeof event === 'object' && !Array.isArray(event))
        .slice(0, EVENT_HISTORY_LIMIT);
    }

    if (this.planQuotaMode === 'on' || this.urgency?.mode === 'on') {
      this.configurePlanQuota({ mode: this.planQuotaMode });
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
    // Proactive urgency moves are reserved at a user turn, never at a poll.
    if (this.urgency?.mode === 'on') return current;

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
    if (this.urgency?.mode === 'on') {
      const ranked = this.urgency.rank(this.urgencyRows(modelFamily));
      for (const row of ranked) {
        const account = this.findOrNull(row.accountId);
        const index = this.accounts.indexOf(account);
        if (excludeCurrent && index === this.currentIndex) continue;
        if (allowedAccounts && !allowedAccounts.has(account)) continue;
        return { account, index, score: this.switchTargetScore(account, modelFamily) || {} };
      }
      return null;
    }
    const candidates = this.accounts
      .map((account, index) => ({ account, index, score: this.switchTargetScore(account, modelFamily) }))
      .filter(candidate => (
        (!excludeCurrent || candidate.index !== this.currentIndex)
        && (!allowedAccounts || allowedAccounts.has(candidate.account))
        && (this.planQuotaMode !== 'on' || this.canRecoverWeeklyQuota(candidate.account, modelFamily))
        && candidate.score
      ));

    candidates.sort((left, right) => (this.planQuotaMode === 'on'
      ? Number(this.hasFreshWeeklyQuota(right.account, modelFamily)) - Number(this.hasFreshWeeklyQuota(left.account, modelFamily)) : 0)
      || compareSwitchTargetScores(left, right));
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
    this.recordEvent({
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
      this.recordEvent({
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
   * The single counting source for a move of the globally active account.
   * Callers that forget to pass a trigger produce
   * `trigger=unknown` rather than an exception, so a missed hand-off shows up
   * in the log instead of failing a live request.
   */
  logAccountSwitch({ from, to, reason, trigger }) {
    if (!this.logger) return;
    // The switch helpers still run their status/event bookkeeping when the
    // chosen candidate is the account already in use; that is not a move of
    // the active account, so it must not reach the counting source.
    if (from === to) return;
    const at = new Date(this.now()).toISOString();
    const normalizedTrigger = ACCOUNT_SWITCH_TRIGGERS.has(trigger) ? trigger : 'unknown';
    // Whitespace would split one field into two; every other character is kept as is.
    const field = value => String(value).replace(/\s/g, '_');
    this.logger(`${at} account_switch from=${field(from ?? 'none')} to=${field(to ?? 'none')} reason=${field(reason)} trigger=${normalizedTrigger}`);
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
    const utilizations = (this.planQuotaMode === 'on'
      ? [quota.unified7d, ...(quota.weeklyScoped || []).filter(limit => scopeMatchesModelFamily(limit, modelFamily, true)).map(limit => limit.utilization)]
      : [quota.unified5h, quota.unified7d])
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
      fiveHourUtilization: this.planQuotaMode === 'on' ? null : fiveHourUtilization ?? Number.MAX_SAFE_INTEGER,
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
    // Scoped exhaustion can mask the throttled status. On policies must honor
    // an upstream short-term hold for every model; off/shadow keep legacy routing.
    if ((this.planQuotaMode === 'on' || this.urgency?.mode === 'on') && account.rateLimitedUntil > this.now()) return false;
    if (account.status === 'exhausted') {
      return !quotaBlocksModelFamily(account.quota, this.switchThreshold, modelFamily, account.extendedQuotaScopes);
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
    this.recordEvent({
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
    const quotaReason = quotaUnavailableReasonForModelFamily(account.quota, this.switchThreshold, modelFamily, account.extendedQuotaScopes);
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
   * Picks the account a NEW session should be bound to.
   *
   * This is the affinity-only selector. It deliberately does NOT reuse
   * `switchTargetScore` / `compareSwitchTargetScores`: that comparator ranks
   * `weeklyResetPriority` first, reads only the unified 5h/7d windows into
   * `maxUtilization` and always settles ties on ledger order, so it does not
   * pick the account with the most headroom. Requests
   * without a session key keep going through the existing comparator.
   *
   * Ranking inside the band, after the assign-stop gate and the missing-window
   * split. The band, the gate, the split and the gate release are unchanged
   * from the earlier version; only the ORDER inside
   * the band moved:
   *   K1 smallest real 5h load (`load5h`, an unreadable window sorts last)
   *   K2 fewest WARM sessions already bound
   *   K3 weekly reset priority, then the earliest weekly reset - both were K1/K2
   *      in the earlier version and are now tie-breakers: spreading the load across accounts
   *      beats draining an account whose weekly window is about to reset
   *   K4 largest headroom, then account priority, then ledger order
   *
   * Everything here is O(accounts) and reads only numbers the ledger already
   * holds. No model call, no I/O.
   *
   * Side effect: the availability filter calls `isAvailable`, which refreshes
   * the quota state of every account it looks at. That is wanted - an expired
   * reset is applied, so a recovered account comes back as a candidate - and it
   * does not inflate the event log, because `recordQuotaExhausted` dedupes on
   * the exhaustion reason.
   *
   * @param {string|null} modelFamily 'fable' for a Fable request, null otherwise.
   *   Only a Fable request counts the Fable weekly sub-cap as one of its windows.
   * @param {Set<string>|Iterable<string>|string|null} excludeAccountIds Account
   *   ids that must not be picked - the caller passes `attemptedAccountIds`
   *   and, for a sub-binding, the account that just failed.
   * @param {number} assignStopUtilization Utilization at which an account stops
   *   accepting NEW sessions. The gate is dropped entirely when it would leave
   *   no candidate at all.
   * @param {Map<string,number>|Record<string,number>|null} sessionCounts WARM
   *   sessions already bound per account id - `SessionAffinity.warmSessionCounts()`.
   *   A session that has gone cold no longer holds a cache on
   *   its account, so counting it here would keep steering new sessions away from
   *   an account that is in fact free. The caller used to pass the total
   *   (`summary().sessionsByAccount`); a total still works, it is just a coarser
   *   signal.
   * @returns {object|null} The chosen account, or null when nothing is usable -
   *   the caller then falls through to the existing exhausted-response path.
   */
  selectForNewAssignment({
    modelFamily = null,
    excludeAccountIds = null,
    assignStopUtilization = DEFAULT_ASSIGN_STOP_UTILIZATION,
    sessionCounts = null,
    recordDecision = true,
  } = {}) {
    if (!this.urgency) return this.selectLegacyAssignment({ modelFamily, excludeAccountIds, assignStopUtilization, sessionCounts });
    const rows = this.urgencyRows(modelFamily);
    const ranked = this.urgency.rank(rows, normalizeExcludedAccountIds(excludeAccountIds));
    const proposed = this.findOrNull(ranked[0]?.accountId);
    const actual = this.urgency.mode === 'on' ? proposed
      : this.selectLegacyAssignment({ modelFamily, excludeAccountIds, assignStopUtilization, sessionCounts });
    if (recordDecision) this.urgency.record('decisions', {
      purpose: 'assignment', actualAccountId: actual?.id ?? null,
      proposedAccountId: proposed?.id ?? null,
      reason: proposed ? 'required-pace' : 'no-known-candidate', metrics: rows,
    });
    return actual;
  }

  selectLegacyAssignment({ modelFamily, excludeAccountIds, assignStopUtilization, sessionCounts }) {
    if (this.planQuotaMode === 'on') return this.selectWeeklyAssignment({ modelFamily, excludeAccountIds, assignStopUtilization, sessionCounts });
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

    // Split the candidates with a missing window out BEFORE the band is
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

  selectWeeklyAssignment({ modelFamily, excludeAccountIds, assignStopUtilization, sessionCounts }) {
    const excluded = normalizeExcludedAccountIds(excludeAccountIds);
    const now = this.now();
    const gate = normalizeAssignStopUtilization(assignStopUtilization);
    const pool = this.accounts.map((account, index) => ({ account, index }))
      .filter(({ account }) => !excluded.has(account.id) && this.isAvailable(account, modelFamily)
        && this.canRecoverWeeklyQuota(account, modelFamily))
      .map(({ account, index }) => {
        const quota = account.quota;
        const weekly = [quota.unified7d,
          ...(quota.weeklyScoped || []).filter(limit => scopeMatchesModelFamily(limit, modelFamily, true)).map(limit => limit.utilization)]
          .filter(value => Number.isFinite(value));
        return { ...this.newAssignmentCandidate(account, index, modelFamily, now, sessionCounts),
          weeklyHeadroom: weekly.length ? Math.min(...weekly.map(value => 1 - value)) : null };
      }).filter(candidate => candidate.weeklyHeadroom != null);
    if (!pool.length) return null;
    const fresh = pool.filter(candidate => this.hasFreshWeeklyQuota(candidate.account, modelFamily));
    const rankedPool = fresh.length ? fresh : pool;
    const admitted = rankedPool.filter(candidate => candidate.headroom.min != null && candidate.headroom.min > 1 - gate);
    const candidates = admitted.length ? admitted : rankedPool;
    const best = Math.max(...candidates.map(candidate => candidate.weeklyHeadroom));
    return candidates.filter(candidate => candidate.weeklyHeadroom >= best - ASSIGN_BAND_WIDTH - ASSIGN_BAND_EPSILON)
      .sort((a, b) => a.warm - b.warm
        || Number(b.weeklyResetPriority) - Number(a.weeklyResetPriority)
        || a.weeklyResetAt - b.weeklyResetAt || b.weeklyHeadroom - a.weeklyHeadroom
        || a.priority - b.priority || a.index - b.index)[0].account;
  }

  /**
   * The headroom `selectForNewAssignment` would give this account. The
   * reservation stage needs the SAME reading to decide whether a bound
   * account is utilised enough to drain a cold session off it; re-deriving it from
   * `quota` in the proxy would let the two drift apart the first time a window is
   * added. `1 - min` is the utilisation; a `min` of null means it could not be
   * read, and the caller must NOT read that as "idle".
   *
   * Pure: it does not refresh the quota state and does not touch the ledger. A
   * window whose reset has already passed is read the way `refreshQuotaState`
   * would leave it, because a bound account is kept out of the selector and so
   * may still carry the reading from before its reset.
   *
   * @param {object|null} account
   * @param {string|null} modelFamily
   * @returns {{min:number|null, complete:boolean}}
   */
  assignmentHeadroomFor(account, modelFamily = null) {
    if (!account) return { min: null, complete: false };
    return assignmentHeadroom(account.quota || {}, modelFamily, this.now(), this.planQuotaMode === 'on', account.extendedQuotaScopes);
  }

  /**
   * The order in which the usable accounts would be handed a NEW session, for
   * display only. Row 1 is what `selectForNewAssignment` returns right now; row
   * k is what it returns once the k-1 accounts above it are excluded, which is
   * where a new session goes when those accounts could not take its request.
   *
   * The rows are produced by calling the selector again with one more account
   * excluded each time, never by sorting one band: the band is redrawn around
   * the accounts that are left, so a sorted band would name an account the
   * selector does not actually move on to.
   *
   * `overStopLine` is true for an account the assign-stop line does not admit -
   * it has used at least `assignStopUtilization` of its tightest window, or none
   * of its windows could be read. The selector reaches such an account only
   * when no admitted account is left, so those rows always come last.
   *
   * Takes the same `modelFamily`, `assignStopUtilization` and `sessionCounts`
   * as `selectForNewAssignment`, and touches the ledger no more than that
   * selector does.
   *
   * @returns {Array<{account:string, accountName:string, overStopLine:boolean}>}
   *   Every account usable for `modelFamily`; empty when there is none.
   */
  newAssignmentOrder({
    modelFamily = null,
    assignStopUtilization = DEFAULT_ASSIGN_STOP_UTILIZATION,
    sessionCounts = null,
  } = {}) {
    const gate = normalizeAssignStopUtilization(assignStopUtilization);
    const listed = new Set();
    const order = [];
    // One account per pass, so the ledger size bounds the loop. An account the
    // exclusion set cannot hold (an empty id) would be returned again; stopping
    // on a repeat keeps that from listing it twice.
    for (let pass = 0; pass < this.accounts.length; pass += 1) {
      const account = this.selectForNewAssignment({
        modelFamily,
        excludeAccountIds: order.map(entry => entry.account),
        assignStopUtilization,
        sessionCounts,
        recordDecision: false,
      });
      if (!account || listed.has(account)) break;
      listed.add(account);
      const headroom = this.assignmentHeadroomFor(account, modelFamily);
      order.push({
        account: account.id,
        accountName: account.name,
        overStopLine: !(headroom.min != null && headroom.min > 1 - (this.urgency?.mode === 'on' ? this.switchThreshold : gate)),
      });
    }
    return order;
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
      headroom: assignmentHeadroom(quota, modelFamily, now, this.planQuotaMode === 'on', account.extendedQuotaScopes),
      // K1: how much of the 5h window this account has actually
      // burned, not how much is left on its tightest window. `headroom.min` can be
      // dominated by the WEEKLY window, so an account that has barely touched its
      // 5h window can lose to one that is halfway through it.
      load5h: fiveHourLoad(quota, now),
      // K2: only the WARM bindings.
      warm: sessionCountFor(sessionCounts, account.id),
      weeklyResetPriority,
      // The reset instant only separates two priority accounts, so everything else
      // shares the same sentinel and falls through to the next key.
      weeklyResetAt: weeklyResetPriority ? weeklyResetAt : Number.MAX_SAFE_INTEGER,
      priority: account.priority ?? Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Same lookup as `find`, but returns null instead of throwing when the id is
   * unknown. A session binding can outlive its account (a reload that drops an
   * account), and that case has to be detectable rather than fatal.
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
      windowObservations: {},
      extendedQuotaScopes: this.planQuotaMode === 'on' || this.urgency?.mode === 'on',
      usage: emptyAccountUsage(),
      rateLimitedUntil: null,
      temporaryUnavailableReason: null,
      errorReason: null,
      quotaExhaustionEventKey: null,
      loginExpiryTracked: tracksLoginExpiry(account),
      loginExpiresAt: null,
      loginExpirySeen: false,
    };
  }
}

// The login expiry is shown only for accounts the rotator refreshes itself: not
// for API keys, nor for the accounts that read Claude Code's current login.
function tracksLoginExpiry(account) {
  return account.type !== 'apikey'
    && account.id !== 'current'
    && account.credentialSource !== 'claude-code-current';
}

// `known` with the time, `none` when a refresh reported no expiry, `unknown`
// before the first refresh (after a start or a new login).
function loginExpiryOf(account) {
  if (account.loginExpiresAt != null) return { state: 'known', at: new Date(account.loginExpiresAt).toISOString() };
  return { state: account.loginExpirySeen ? 'none' : 'unknown', at: null };
}

function keepUnifiedWindowAtomic(parsed, utilizationKey, resetKey, now, validateValues) {
  const complete = validateValues
    ? isValidQuotaWindow(parsed[utilizationKey], parsed[resetKey], now)
    : Object.hasOwn(parsed, utilizationKey) === Object.hasOwn(parsed, resetKey);
  if (complete) return;
  delete parsed[utilizationKey];
  delete parsed[resetKey];
}

function emptyAccountUsage() {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    // キャッシュ4分類のうち集計するのは3つ。`cache_creation_input_tokens`（合計）は
    // 1h と 5m の和なので状態には持たず、要求単位の `cc=` だけをログへ出す。
    totalCacheReadTokens: 0,
    totalCacheCreation1hTokens: 0,
    totalCacheCreation5mTokens: 0,
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
export function quotaUnavailableReasonForModelFamily(quota, threshold, modelFamily, extended = false) {
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
      if (!scopeMatchesModelFamily(limit, modelFamily, extended)) continue;
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
 * Routing availability state used for an account whose login has expired.
 * It ranks exactly like `unknown` - neither carries a
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

const RELOGIN_REQUIRED_CAUSES = new Set(['NATIVE_REFRESH_REAUTH_REQUIRED', 'invalid_grant']);

/**
 * True when the account's refresh credential itself can no longer be used (it
 * expired or was refused), so the account stays unusable until a human runs
 * `claude-rotator login` again: the refresh failed (`oauth_refresh_failed`)
 * with the cause `NATIVE_REFRESH_REAUTH_REQUIRED` or `invalid_grant`.
 *
 * Narrower than `isAuthExpiredReason` on purpose. An upstream 401
 * (`authentication_error`), a refresh whose outcome is unknown, an HTTP error
 * status from a refresh, a failure with no recorded cause and the refresh
 * cooldowns are all false here: none of them says that only a new login will
 * bring the account back.
 */
export function requiresRelogin(account) {
  const reason = account?.errorReason;
  return reason?.type === 'oauth_refresh_failed' && RELOGIN_REQUIRED_CAUSES.has(reason.cause);
}

/**
 * Decides whether an account's quota gates a request of the given model family.
 * This evaluates every window directly (never a single classified "the" reason)
 * so a model-scoped exhaustion can never mask a concurrent common-quota
 * exhaustion, and so a scoped exhaustion buried behind an earlier non-matching
 * scoped entry is never missed.
 *
 * Common windows (5h / 7d / token / request rate limits) gate every family.
 * Every entry in `weeklyScoped` is scanned independently via
 * `scopeMatchesModelFamily`: a Fable-scoped entry at/over threshold gates only
 * Fable requests; an unrecognized scope is reported but never gates any request.
 */
function quotaBlocksModelFamily(quota, threshold, modelFamily, extended = false) {
  if (!quota) return true;
  if (commonQuotaExhausted(quota, threshold)) return true;
  if (Array.isArray(quota.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!limit || typeof limit.utilization !== 'number' || limit.utilization < threshold) continue;
      if (scopeMatchesModelFamily(limit, modelFamily, extended)) return true;
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
  return commonQuotaWindowsOver(quota, threshold) !== null;
}

/**
 * The common windows of `quota` that are at or over `threshold`, in the fixed
 * order 5h, 7d, tokens, requests, each as `{ basis, utilization }`; null when
 * none is. A missing quota counts as exhausted with no window to name, so it
 * gives an empty list. `commonQuotaExhausted` is "this is not null", which is
 * what keeps the decision and `commonQuotaEvidence` from ever disagreeing.
 */
function commonQuotaWindowsOver(quota, threshold) {
  if (!quota) return [];
  const over = [];
  if (quota.unified5h != null && quota.unified5h >= threshold) {
    over.push({ basis: '5h', utilization: quota.unified5h });
  }
  if (quota.unified7d != null && quota.unified7d >= threshold) {
    over.push({ basis: '7d', utilization: quota.unified7d });
  }
  if (quota.tokensLimit != null && quota.tokensRemaining != null) {
    const utilization = 1 - quota.tokensRemaining / quota.tokensLimit;
    if (utilization >= threshold) over.push({ basis: 'tokens', utilization });
  }
  if (quota.requestsLimit != null && quota.requestsRemaining != null) {
    const utilization = 1 - quota.requestsRemaining / quota.requestsLimit;
    if (utilization >= threshold) over.push({ basis: 'requests', utilization });
  }
  return over.length > 0 ? over : null;
}

/**
 * What made `isCommonQuotaExhausted(account, threshold)` true, read from the
 * same ledger values; null exactly when it is false.
 *
 * - `basis`: the windows at or over the threshold (`5h`, `7d`, `tokens`,
 *   `requests`, in that order; empty when the account has no quota at all).
 * - `util`: the largest utilization among them (the ledger value for 5h and
 *   7d; `1 - remaining/limit` for tokens and requests), unrounded.
 * - `src` / `srcAgeMs`: where that value came from and how old it is at `now`.
 *   The 5h and 7d values share one source and time per account
 *   (`quota.usageSource` / `quota.usageUpdatedAt`), so a 5h reading carries the
 *   source of the latest 5h-or-7d update. Token and request values only ever
 *   come from response headers and their time is not kept, so they give
 *   `header` and a null age.
 *
 * Reads only: it neither writes the ledger nor calls `refreshQuotaState`, so it
 * sees exactly what the decision that called it saw.
 */
export function commonQuotaEvidence(account, threshold, now) {
  if (!account) return null;
  const quota = account.quota;
  const over = commonQuotaWindowsOver(quota, threshold);
  if (over === null) return null;
  let top = null;
  for (const window of over) {
    if (!Number.isFinite(window.utilization)) continue;
    if (top === null || window.utilization > top.utilization) top = window;
  }
  const evidence = { basis: over.map(window => window.basis), util: null, src: null, srcAgeMs: null };
  if (top === null) return evidence;
  evidence.util = top.utilization;
  if (top.basis === 'tokens' || top.basis === 'requests') {
    evidence.src = 'header';
    return evidence;
  }
  evidence.src = USAGE_SOURCES.includes(quota.usageSource) ? quota.usageSource : null;
  const ageMs = now - quota.usageUpdatedAt;
  evidence.srcAgeMs = Number.isFinite(quota.usageUpdatedAt) && Number.isFinite(ageMs) && ageMs >= 0
    ? ageMs
    : null;
  return evidence;
}

/**
 * Public form of the module-private `commonQuotaExhausted`.
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
 * True only for the "sub-cap only" case: a model-scoped
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
 * behaviour. `refreshQuotaState` can rewrite `status` to `'exhausted'`
 * while a back-off is still running, which is why the back-off is read from
 * `rateLimitedUntil` rather than from `status` alone.
 *
 * Reads the ledger without touching it: unlike `isAvailable` it never calls
 * `refreshQuotaState`, so evaluating it cannot add a `quota-exhausted` event
 * or move an account's status.
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
  return quotaBlocksModelFamily(account.quota, threshold, modelFamily, account.extendedQuotaScopes);
}

function futureAvailabilityForModelFamily(account, threshold, modelFamily, now) {
  if (!account) return { state: 'unknown', availableAt: null };
  if (account.status === 'error') {
    // An expired login is reported as such so the screen can tell the
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
      if (!scopeMatchesModelFamily(limit, modelFamily, account.extendedQuotaScopes)) continue;
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
 * Headroom of an account for `selectForNewAssignment`.
 *
 * `min` is the residual (1 - utilization) of the tightest window that could be
 * read, so the account is ranked by the window that will run out first. A Fable
 * request also counts the Fable weekly sub-cap, which is what keeps a 95%
 * sub-cap account from becoming the home of a new Fable session.
 *
 * A window that could not be read is NOT treated as 100% free: it is left out of
 * `min` and reported through `complete: false`, so the caller can rank those
 * candidates behind the fully known ones instead of trusting a flattering value.
 *
 * A window whose reset has passed at `now` is read as `refreshQuotaState` would
 * leave it: a 5h or 7d window counts as not read, and a scoped weekly limit is
 * dropped. Nothing is written back.
 */
function assignmentHeadroom(quota, modelFamily, now, optionalFiveHour = false, extended = false) {
  const five = quota?.unified5hReset && now >= quota.unified5hReset ? null : finiteNumberOrNull(quota?.unified5h);
  const utilizations = [
    ...(optionalFiveHour && five == null ? [] : [five]),
    quota?.unified7dReset && now >= quota.unified7dReset ? null : finiteNumberOrNull(quota?.unified7d),
  ];
  if (modelFamily === 'fable' && Array.isArray(quota?.weeklyScoped)) {
    for (const limit of quota.weeklyScoped) {
      if (!scopeMatchesModelFamily(limit, modelFamily, extended)) continue;
      if (limit.resetAt && now >= limit.resetAt) continue;
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

/**
 * The real 5h load of an account (the K1 key of `selectForNewAssignment`).
 *
 * A 5h window whose reset instant has already passed is zero load, not a missing
 * reading - the window has simply started over. (`refreshQuotaState` normally
 * clears both fields before a candidate is ever built, so this branch is the
 * belt-and-braces one; it matters for any caller that scores an account without
 * going through the availability filter first.)
 *
 * A window that could NOT be read stays `null` and the comparator sorts it last.
 * Reading it as 0 would make an account nobody has measured look like the idlest
 * account there is, which is the same trap `assignmentHeadroom` avoids for the
 * residuals.
 */
function fiveHourLoad(quota, now) {
  const resetAt = finiteNumberOrNull(quota?.unified5hReset);
  if (resetAt != null && resetAt < now) return 0;
  return finiteNumberOrNull(quota?.unified5h);
}

/**
 * The band comparator. Used for BOTH a brand-new session and a
 * rebind target, because both go through `selectForNewAssignment`.
 *
 * The earlier order led with the weekly-reset priority, so a single account that
 * happened to be closest to its weekly reset collected every new session in the
 * band until it ran out. Leading with the real 5h load spreads the sessions and
 * leaves the weekly-reset preference as a tie-breaker.
 */
function compareNewAssignmentCandidates(left, right) {
  if (left.load5h !== right.load5h) {
    // 欠測は末尾。`!==` は両方 null のときに偽になるので、ここは片方だけが null。
    if (left.load5h == null) return 1;
    if (right.load5h == null) return -1;
    return left.load5h - right.load5h;
  }
  if (left.warm !== right.warm) {
    return left.warm - right.warm;
  }
  if (left.weeklyResetPriority !== right.weeklyResetPriority) {
    return left.weeklyResetPriority ? -1 : 1;
  }
  if (left.weeklyResetAt !== right.weeklyResetAt) {
    return left.weeklyResetAt - right.weeklyResetAt;
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

/**
 * The exclusion set is addressed by account id. An earlier version put
 * every element of any iterable straight into a Set, so an account OBJECT was
 * accepted silently and then never matched an id - the caller believed it had
 * excluded an account while the selector could still return it. Only strings
 * and account-shaped objects (`{ id }`) are honoured now; anything else is
 * dropped instead of becoming an entry that can never match.
 */
function normalizeExcludedAccountIds(value) {
  if (!value) return new Set();
  if (typeof value === 'string') return new Set([value]);
  if (typeof value[Symbol.iterator] !== 'function') return new Set();
  const excluded = new Set();
  for (const item of value) {
    if (typeof item === 'string' && item !== '') excluded.add(item);
    else if (item && typeof item.id === 'string' && item.id !== '') excluded.add(item.id);
  }
  return excluded;
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
  // Saved before these keys existed -> both stay null.
  if (USAGE_SOURCES.includes(value.usageSource)) quota.usageSource = value.usageSource;
  return quota;
}

function restoreUsage(value) {
  return {
    totalInputTokens: restoreNumber(value?.totalInputTokens),
    totalOutputTokens: restoreNumber(value?.totalOutputTokens),
    // 3キーを持たない旧い runtime-state.json でも restoreNumber が 0 を返すだけで壊れない。
    totalCacheReadTokens: restoreNumber(value?.totalCacheReadTokens),
    totalCacheCreation1hTokens: restoreNumber(value?.totalCacheCreation1hTokens),
    totalCacheCreation5mTokens: restoreNumber(value?.totalCacheCreation5mTokens),
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
