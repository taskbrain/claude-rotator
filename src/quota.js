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

/**
 * @param {object} headers
 * @param {{ onInvalid?: (rejected: { key: string, value: number|string }) => void }} [options]
 *   `onInvalid` is told about every utilization header that was dropped because
 *   it was not a finite number or was negative. `value` is the parsed number when
 *   it is finite, otherwise the raw text cut to 32 characters. Callers without it
 *   behave as before except that such a value no longer reaches the result.
 */
export function parseRateLimitHeaders(headers, { onInvalid = null } = {}) {
  const get = createHeaderGetter(headers);
  const quota = {};

  setUtilization(quota, 'unified5h', get('anthropic-ratelimit-unified-5h-utilization'), onInvalid);
  setUtilization(quota, 'unified7d', get('anthropic-ratelimit-unified-7d-utilization'), onInvalid);
  setEpochSeconds(quota, 'unified5hReset', get('anthropic-ratelimit-unified-5h-reset'));
  setEpochSeconds(quota, 'unified7dReset', get('anthropic-ratelimit-unified-7d-reset'));
  setString(quota, 'unifiedStatus', get('anthropic-ratelimit-unified-status'));

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

const FABLE_SCOPE_IDENTITIES = new Set([
  'fable',
  'fable 5',
  'fable5',
  'fable_5',
  'claude-fable-5',
  'claude_fable_5',
]);

/** True when a weeklyScoped entry's key/label denotes the Fable sub-cap. */
export function isFableScopeIdentity(value) {
  if (typeof value !== 'string') return false;
  return FABLE_SCOPE_IDENTITIES.has(value.trim().toLowerCase());
}

/**
 * True when a weeklyScoped limit belongs to the model family of the request.
 * `modelFamily` is null for every non-Fable request, so Fable-scoped limits
 * never gate Opus/Sonnet/Haiku traffic. Unknown (non-Fable) scoped limits are
 * reported but never gate any request family.
 */
export function scopeMatchesModelFamily(limit, modelFamily) {
  if (!limit) return false;
  const isFableScope = isFableScopeIdentity(limit.key) || isFableScopeIdentity(limit.label);
  if (isFableScope) return modelFamily === 'fable';
  return false;
}
