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
  };
}

export function parseRateLimitHeaders(headers) {
  const get = createHeaderGetter(headers);
  const quota = {};

  setNumber(quota, 'unified5h', get('anthropic-ratelimit-unified-5h-utilization'));
  setNumber(quota, 'unified7d', get('anthropic-ratelimit-unified-7d-utilization'));
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

function setNumber(target, key, raw) {
  if (raw == null || raw === '') return;
  const value = Number(raw);
  if (Number.isFinite(value)) target[key] = value;
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
