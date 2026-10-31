export function emptyQuota() {
  return {
    unified5h: null,
    unified7d: null,
    unified5hReset: null,
    unified7dReset: null,
    weeklyScoped: [],
    unifiedStatus: null,
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    resetsAt: null,
    // When unified5h / unified7d were last taken (epoch ms, like the *Reset keys)
    // and from where: 'header' (a proxied response) or 'poll' (the Usage API).
    usageUpdatedAt: null,
    usageSource: null,
  };
}

export const USAGE_SOURCES = Object.freeze(['header', 'poll']);

export function planQuotaMode(raw) {
  return ['off', 'shadow', 'on'].includes(raw?.mode) ? raw.mode : 'off';
}

export function isValidQuotaWindow(utilization, resetAt, now) {
  return Number.isFinite(utilization) && utilization >= 0 && Number.isFinite(resetAt) && resetAt > now;
}

// These observations describe reporting, not a subscription entitlement. An
// absent window never proves that a server-side restriction has been removed.
export function observeQuotaWindows(previous, fields, now, source) {
  const next = { ...previous };
  if (source === 'poll' && Array.isArray(fields.weeklyScoped)) {
    const current = new Set(fields.weeklyScoped.map(limit => `7d_${limit.key}`));
    for (const id of Object.keys(next)) if (id.startsWith('7d_') && !current.has(id)) delete next[id];
  }
  const entries = [
    ['5h', fields.unified5h, fields.unified5hReset, Object.hasOwn(fields, 'unified5h')],
    ['7d', fields.unified7d, fields.unified7dReset, Object.hasOwn(fields, 'unified7d')],
    ...(fields.weeklyScoped || []).map(limit => [`7d_${limit.key}`, limit.utilization, limit.resetAt, true]),
  ];
  for (const [id, value, resetAt, present] of entries) {
    const validPair = isValidQuotaWindow(value, resetAt, now);
    const observationState = !present ? 'missing' : value === null ? 'explicit_null' : validPair ? 'value' : 'invalid';
    const prior = previous?.[id];
    const lastKnown = validPair ? {
      usedFraction: value, resetAt: Number.isFinite(resetAt) ? resetAt : null, observedAt: now,
    } : prior?.lastKnown ?? null;
    next[id] = { observationState, observedAt: now, source, lastKnown };
  }
  return Object.fromEntries(Object.entries(next).sort(([a, av], [b, bv]) =>
    Number(b === '5h' || b === '7d') - Number(a === '5h' || a === '7d')
    || Number(isFableScopeIdentity(b.slice(3), true)) - Number(isFableScopeIdentity(a.slice(3), true))
    || (bv.lastKnown?.usedFraction ?? -1) - (av.lastKnown?.usedFraction ?? -1)).slice(0, 18));
}

export function boundWeeklyScopes(scopes) {
  if (scopes.length <= 16) return scopes;
  return [...scopes].sort((a, b) =>
    Number(scopeMatchesModelFamily(b, 'fable', true)) - Number(scopeMatchesModelFamily(a, 'fable', true))
    || (b.utilization ?? -1) - (a.utilization ?? -1)).slice(0, 16);
}

export function quotaWindowsView(quota, observations, now) {
  const limits = [
    { id: '5h', scope: 'all', usedFraction: quota.unified5h, resetAt: quota.unified5hReset },
    { id: '7d', scope: 'all', usedFraction: quota.unified7d, resetAt: quota.unified7dReset },
    ...(quota.weeklyScoped || []).map(limit => ({
      id: `7d_${limit.key}`, scope: isFableScopeIdentity(limit.key, true) || isFableScopeIdentity(limit.label, true) ? 'fable' : 'unknown',
      usedFraction: limit.utilization, resetAt: limit.resetAt,
    })),
  ];
  for (const id of Object.keys(observations || {})) {
    if (!id.startsWith('7d_') || limits.some(limit => limit.id === id)) continue;
    const last = observations[id]?.lastKnown;
    limits.push({
      id, scope: isFableScopeIdentity(id.slice(3), true) ? 'fable' : 'unknown',
      usedFraction: last?.usedFraction ?? null, resetAt: last?.resetAt ?? null,
    });
  }
  return limits.map(limit => {
    const observation = observations?.[limit.id];
    const known = observation?.lastKnown;
    const value = known?.usedFraction ?? limit.usedFraction;
    const reset = known?.resetAt ?? limit.resetAt;
    const expired = reset != null && reset <= now;
    const state = expired ? 'expired' : observation?.observationState ?? 'missing';
    const reported = state === 'value' && value != null;
    return {
      id: limit.id, scope: limit.scope,
      applicability: reported ? 'present' : 'unknown', observationState: state,
      usedFraction: reported ? value : null,
      resetAt: reported ? reset : null,
      observedAt: observation?.observedAt ?? null, source: observation?.source ?? null,
      retainedConstraint: !reported && !expired && value != null,
      lastKnown: !reported && !expired && known ? { ...known } : null,
    };
  });
}

export function restoreQuotaWindowObservations(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [id, entry] of Object.entries(value).slice(0, 18)) {
    if (!/^(?:5h|7d|7d_[a-z0-9_]{1,40})$/.test(id) || !entry || typeof entry !== 'object') continue;
    if (!['missing', 'explicit_null', 'value', 'invalid'].includes(entry.observationState)) continue;
    if (!Number.isFinite(entry.observedAt) || !USAGE_SOURCES.includes(entry.source)) continue;
    const last = entry.lastKnown;
    const lastKnown = last && Number.isFinite(last.usedFraction) && last.usedFraction >= 0
      && Number.isFinite(last.observedAt) && Number.isFinite(last.resetAt)
      ? { usedFraction: last.usedFraction, resetAt: last.resetAt, observedAt: last.observedAt } : null;
    result[id] = { observationState: entry.observationState, observedAt: entry.observedAt, source: entry.source, lastKnown };
  }
  return result;
}

/**
 * @param {object} headers
 * @param {{ onInvalid?: (rejected: { key: string, value: number|string }) => void, includeScopedWindows?: boolean }} [options]
 *   `onInvalid` is told about every utilization header that was dropped because
 *   it was not a finite number or was negative. `value` is the parsed number when
 *   it is finite, otherwise the raw text cut to 32 characters. Callers without it
 *   behave as before except that such a value no longer reaches the result.
 *   Scoped window enumeration is opt-in; legacy callers never scan these names.
 */
export function parseRateLimitHeaders(headers, { onInvalid = null, includeScopedWindows = false } = {}) {
  const get = createHeaderGetter(headers);
  const quota = {};

  setUtilization(quota, 'unified5h', get('anthropic-ratelimit-unified-5h-utilization'), onInvalid);
  setUtilization(quota, 'unified7d', get('anthropic-ratelimit-unified-7d-utilization'), onInvalid);
  setEpochSeconds(quota, 'unified5hReset', get('anthropic-ratelimit-unified-5h-reset'));
  setEpochSeconds(quota, 'unified7dReset', get('anthropic-ratelimit-unified-7d-reset'));
  setString(quota, 'unifiedStatus', get('anthropic-ratelimit-unified-status'));
  if (includeScopedWindows === true) {
    const names = typeof headers?.keys === 'function' ? [...headers.keys()] : Object.keys(headers || {});
    const scoped = [];
    for (const name of names) {
      const match = /^anthropic-ratelimit-unified-7d[-_]([a-z0-9][a-z0-9_-]{0,39})-utilization$/.exec(name.toLowerCase());
      if (!match || scoped.length >= 16) continue;
      const parsed = {};
      setUtilization(parsed, 'utilization', get(name), () => onInvalid?.({ key: 'weeklyScoped', value: 'invalid' }));
      if (!('utilization' in parsed)) continue;
      setEpochSeconds(parsed, 'resetAt', get(name.replace(/-utilization$/i, '-reset')));
      const key = normalizeScopedKey(match[1]);
      scoped.push({ key, label: isFableScopeIdentity(key) ? 'Fable' : key, utilization: parsed.utilization, resetAt: parsed.resetAt ?? null });
    }
    if (scoped.length) quota.weeklyScoped = scoped;
  }

  setInteger(quota, 'tokensLimit', get('anthropic-ratelimit-tokens-limit'));
  setInteger(quota, 'tokensRemaining', get('anthropic-ratelimit-tokens-remaining'));
  setInteger(quota, 'requestsLimit', get('anthropic-ratelimit-requests-limit'));
  setInteger(quota, 'requestsRemaining', get('anthropic-ratelimit-requests-remaining'));
  setString(quota, 'resetsAt', get('anthropic-ratelimit-tokens-reset') || get('anthropic-ratelimit-requests-reset'));

  return quota;
}

export function applyUsagePayload(quota, payload) {
  if (payload?.five_hour) {
    if (typeof payload.five_hour.utilization === 'number') quota.unified5h = payload.five_hour.utilization;
    if (payload.five_hour.resets_at) quota.unified5hReset = Date.parse(payload.five_hour.resets_at);
  }
  if (payload?.seven_day) {
    if (typeof payload.seven_day.utilization === 'number') quota.unified7d = payload.seven_day.utilization;
    if (payload.seven_day.resets_at) quota.unified7dReset = Date.parse(payload.seven_day.resets_at);
  }
  if (Array.isArray(payload?.scoped_weekly)) {
    quota.weeklyScoped = normalizeWeeklyScopedUsage(payload.scoped_weekly);
  }
  return quota;
}

export function normalizeWeeklyScopedUsage(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(limit => {
      if (!limit || typeof limit !== 'object') return null;
      const utilization = finiteNumberOrNull(limit.utilization);
      if (utilization == null) return null;
      return {
        key: normalizeScopedKey(limit.key || limit.label),
        label: normalizeScopedLabel(limit.label || limit.key),
        utilization,
        resetAt: parseResetAt(limit.resetAt ?? limit.resets_at),
      };
    })
    .filter(Boolean);
}

export function normalizeWeeklyScopedObservations(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(limit => limit && typeof limit === 'object').map(limit => ({
    key: normalizeScopedKey(limit.key || limit.label),
    label: normalizeScopedLabel(limit.label || limit.key),
    utilization: Number.isFinite(limit.utilization) && limit.utilization >= 0 ? limit.utilization : null,
    resetAt: parseResetAt(limit.resetAt ?? limit.resets_at),
  }));
}

function createHeaderGetter(headers) {
  if (!headers) return () => undefined;
  if (typeof headers.get === 'function') {
    return name => headers.get(name);
  }

  const normalized = new Map();
  for (const [key, value] of Object.entries(headers)) {
    normalized.set(key.toLowerCase(), value);
  }
  return name => normalized.get(name.toLowerCase());
}

// Only a value that is not a finite number, or is negative, is dropped, so a
// malformed header can never overwrite the last good value. A value above 1
// (e.g. 1.02 on a 429) is kept as is: it is the exhaustion signal that the
// switch threshold and the quota-retry path rely on.
function setUtilization(target, key, raw, onInvalid) {
  if (raw == null || raw === '') return;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) {
    target[key] = value;
    return;
  }
  onInvalid?.({ key, value: Number.isFinite(value) ? value : String(raw).slice(0, 32) });
}

function setInteger(target, key, raw) {
  if (raw == null || raw === '') return;
  const value = Number.parseInt(raw, 10);
  if (Number.isFinite(value)) target[key] = value;
}

function setEpochSeconds(target, key, raw) {
  if (raw == null || raw === '') return;
  const value = Number.parseInt(raw, 10);
  if (Number.isFinite(value)) target[key] = value * 1000;
}

function setString(target, key, raw) {
  if (raw != null && raw !== '') target[key] = raw;
}

function parseResetAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

/** True when a weeklyScoped entry's key/label denotes the Fable sub-cap. */
export function isFableScopeIdentity(value, extended = false) {
  if (typeof value !== 'string') return false;
  const identity = value.trim().toLowerCase();
  return ['fable', 'fable 5', 'fable5', 'fable_5', 'claude-fable-5', 'claude_fable_5'].includes(identity)
    || (extended && /^(?:claude[-_])?fable(?:[ _-]?\d+(?:[._-]\d+)*)?$/.test(identity));
}

/**
 * True when a weeklyScoped limit belongs to the model family of the request.
 * `modelFamily` is null for every non-Fable request, so Fable-scoped limits
 * never gate Opus/Sonnet/Haiku traffic. Unknown (non-Fable) scoped limits are
 * reported but never gate any request family.
 */
export function scopeMatchesModelFamily(limit, modelFamily, extended = false) {
  if (!limit) return false;
  const isFableScope = isFableScopeIdentity(limit.key, extended) || isFableScopeIdentity(limit.label, extended);
  if (isFableScope) return modelFamily === 'fable';
  return false;
}
