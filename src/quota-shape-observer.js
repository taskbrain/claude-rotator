import { createHash } from 'node:crypto';

// Fixed names bound both key characters/length and output size. Unknown suffixes
// and model labels never become log keys or values.
const USAGE_KEYS = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_fable', 'seven_day_oauth_apps', 'seven_day_cowork'];
const LIMIT_KINDS = ['session', 'weekly_all', 'weekly_scoped'];
const HEADER_NAMES = [
  'anthropic-ratelimit-unified-5h-utilization',
  'anthropic-ratelimit-unified-7d-utilization',
  'anthropic-ratelimit-unified-5h-reset',
  'anthropic-ratelimit-unified-7d-reset',
  'anthropic-ratelimit-unified-grace-5h-utilization',
  'anthropic-ratelimit-unified-grace-7d-utilization',
  'anthropic-ratelimit-unified-reset',
  'anthropic-ratelimit-unified-status',
  'anthropic-ratelimit-unified-overage-status',
  'anthropic-ratelimit-unified-overage-in-use',
  'anthropic-ratelimit-unified-representative-claim',
];
const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MAX_TRACKED_SOURCES = 2048;
const MAX_LIMITS = 16;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const typeOnly = value => ({ type: value === undefined ? 'missing' : value === null ? 'null' : 'invalid' });

function numberShape(value, { header = false, reset = false } = {}) {
  if (value === undefined || value === null) return typeOnly(value);
  let numeric = value;
  if (typeof value === 'string') {
    if (header && value.length <= 32 && /^\d+(?:\.\d+)?$/.test(value)) numeric = Number(value);
    else if (reset && value.length <= 35 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) numeric = Date.parse(value) / 1000;
  }
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0
    ? { type: 'number', value: numeric }
    : { type: 'invalid' };
}

// Validate projected callback data too: injected fetchers cannot turn the logger
// into a sink for arbitrary object properties or strings.
function projectedNumber(value) {
  if (!object(value)) return { type: 'invalid' };
  if (value.type === 'missing' || value.type === 'null' || value.type === 'invalid') return { type: value.type };
  return value.type === 'number' ? numberShape(value.value) : { type: 'invalid' };
}

function bucketShape(value, projected) {
  if (!object(value)) return typeOnly(value);
  if (projected && ['missing', 'null', 'invalid'].includes(value.type)) return { type: value.type };
  return {
    utilization: projected ? projectedNumber(value.utilization) : numberShape(value.utilization),
    percent: projected ? projectedNumber(value.percent) : numberShape(value.percent),
    resets_at: projected ? projectedNumber(value.resets_at) : numberShape(value.resets_at, { reset: true }),
  };
}

function scopeShape(value, projected) {
  if (!object(value)) return typeOnly(value);
  if (projected && ['missing', 'null', 'invalid'].includes(value.type)) return { type: value.type };
  const model = value.model;
  if (!object(model)) return { model: typeOnly(model) };
  if (projected && ['missing', 'null', 'invalid'].includes(model.type)) return { model: { type: model.type } };
  return { model: Object.fromEntries(['id', 'name', 'display_name'].map(key => [key,
    projected && object(model[key]) && ['missing', 'null'].includes(model[key].type)
      ? { type: model[key].type }
      : typeOnly(projected ? true : model[key]),
  ])) };
}

function usageShape(data, projected = false) {
  const source = object(data) ? data : {};
  const shape = Object.fromEntries(USAGE_KEYS.map(key => [key, bucketShape(source[key], projected)]));
  const limits = source.limits;
  shape.limits = Array.isArray(limits)
    ? limits.slice(0, MAX_LIMITS).filter(limit => object(limit) && LIMIT_KINDS.includes(limit.kind)).map(limit => ({
      kind: limit.kind,
      ...bucketShape(limit, projected),
      scope: scopeShape(limit.scope, projected),
    }))
    : projected && object(limits) && ['missing', 'null', 'invalid'].includes(limits.type)
      ? { type: limits.type }
      : typeOnly(limits);
  return shape;
}

export function projectUsageQuotaShape(data) {
  return usageShape(data);
}

function headerShape(headers) {
  return Object.fromEntries(HEADER_NAMES.map(name => {
    const value = typeof headers?.get === 'function'
      ? headers.has(name) ? headers.get(name) : undefined
      : headers?.[name];
    return [name, name.endsWith('-utilization') || name.endsWith('-reset')
      ? numberShape(value, { header: true })
      : typeOnly(value)];
  }));
}

export function createQuotaShapeObserver({ enabled = false, logger = null, now = Date.now, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const active = enabled === true && typeof logger === 'function';
  const recent = new Map();
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  function record(accountId, source, status, shape) {
    if (typeof accountId !== 'string') return;
    const account = createHash('sha256').update(accountId).digest('hex').slice(0, 12);
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    const fingerprint = JSON.stringify([safeStatus, shape]);
    const timestamp = now();
    const key = `${account}:${source}`;
    const previous = recent.get(key);
    if (previous?.fingerprint === fingerprint && timestamp >= previous.time && timestamp - previous.time < interval) return;
    recent.delete(key);
    recent.set(key, { fingerprint, time: timestamp });
    if (recent.size > MAX_TRACKED_SOURCES) recent.delete(recent.keys().next().value);
    const result = logger(JSON.stringify({ event: 'quota_shape', time: new Date(timestamp).toISOString(), account, source, status: safeStatus, shape }));
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }
  return {
    headers(accountId, status, headers) {
      if (!active) return;
      try { record(accountId, 'header', status, headerShape(headers)); } catch { /* Observation cannot interrupt routing. */ }
    },
    usage(accountId, observation) {
      if (!active) return;
      try { record(accountId, 'usage', observation?.status, usageShape(observation?.shape, true)); } catch { /* Observation cannot interrupt routing. */ }
    },
  };
}
