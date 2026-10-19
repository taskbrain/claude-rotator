// Drift watch: notices when something about the traffic changes.
//
// It reads the proxy lines the server already writes and tells a human, through
// the alert watch's `notice()`, about:
//   - first-seen values: a Claude Code version newer than any seen before, a
//     model name that is not on the fixed list, a weekly limit scope that is
//     not on the fixed list;
//   - hourly drift: the cache-miss rate, or the median / 95th percentile request
//     size, of a model (and of a model on one Claude Code version) far from the
//     same hour of the previous days.
//
// Design lines:
// - **No sender, no file, no request path.** Messages go only through the
//   injected `notice()`; the state is read and written only through the injected
//   `readState` / `writeState`. The proxy is not touched: proxy lines come in
//   through `noteLogLine`, which only counts.
// - **Nothing about accounts.** The `account=` field of a proxy line is never
//   read, and from the ledger only `quota.weeklyScoped[].key` is read. Message
//   texts carry versions, model names, scope names, ratios and request counts.
// - **Never throws to the caller.** A failing reader, writer, notice or logger
//   only affects this watch.

/** How often the watch closes finished hours, reads the ledger and saves. */
export const DRIFT_SWEEP_INTERVAL_MS = 60_000;
/** After a fresh start, first-seen values are only remembered for this long. */
export const DRIFT_LEARNING_MS = 24 * 60 * 60_000;
/** The baseline is the same hour of this many previous days. */
export const DRIFT_BASELINE_DAYS = 7;
/** An hour is judged only when at least this many baseline days are known. */
export const DRIFT_MIN_BASELINE_DAYS = 3;
/** Hours with fewer counted requests are neither judged nor kept. */
export const DRIFT_MIN_REQUESTS = 500;
/** The 95th percentile needs at least this many requests in the hour. */
export const DRIFT_MIN_REQUESTS_P95 = 1000;
/** Cache misses at or above this multiple of the baseline are reported. */
export const DRIFT_MISS_RATIO = 2.0;
/** Median request size at or above this multiple (or at or below its inverse). */
export const DRIFT_P50_RATIO = 1.75;
/** 95th percentile request size at or above this multiple (or at or below its inverse). */
export const DRIFT_P95_RATIO = 2.0;
/** An open drift closes after this many judged hours in a row back in range. */
export const DRIFT_EPISODE_CLEAR_HOURS = 2;
/** An open drift closes when it has not been judged for this many hours. */
export const DRIFT_EPISODE_IDLE_HOURS = 24;
/** First-seen notices per clock hour. Past this, values are only remembered. */
export const DRIFT_MAX_FIRST_SEEN_PER_HOUR = 10;
/** Each first-seen list keeps at most this many values (oldest dropped first). */
export const DRIFT_MAX_SEEN = 500;
/** Hourly history is kept for at most this many models. */
export const DRIFT_MAX_MODELS = 16;
/** Hourly history older than this many hours is dropped. */
export const DRIFT_HISTORY_HOURS = 192;

const HOUR_MS = 3_600_000;
const STATE_FORMAT = 1;
const MAX_LINE_LENGTH = 8192;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const SCOPE_PATTERN = /^[a-z0-9_]{1,64}$/;
const COUNT_PATTERN = /^\d{1,15}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Reads one proxy line. Returns null unless it is a successful
 * `/v1/messages` line with a usable model and input counts.
 *
 * Counted: the second word is `proxy`, `path=/v1/messages`, `status=200`,
 * `outcome=ok`, no `usageParse=`, a model of `[A-Za-z0-9._-]{1,64}` other than
 * `-`, whole-number `in=`, `cr=` and `cc=` with a positive sum. `ua=` becomes
 * `version` when it has the `<n>.<n>.<n>` form, otherwise null. `account=` is
 * not read.
 *
 * @param {string} line
 * @returns {{model: string, version: string|null, input: number, cacheRead: number, cacheCreation: number}|null}
 */
export function parseProxyLine(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return null;
  const words = line.split(' ');
  if (words[1] !== 'proxy') return null;
  const fields = new Map();
  for (let i = 2; i < words.length; i += 1) {
    const word = words[i];
    const eq = word.indexOf('=');
    if (eq <= 0) continue;
    const name = word.slice(0, eq);
    // `account=` is skipped on purpose: nothing about accounts is kept.
    if (name === 'account' || fields.has(name)) continue;
    fields.set(name, word.slice(eq + 1));
  }
  if (fields.get('path') !== '/v1/messages' || fields.get('status') !== '200' || fields.get('outcome') !== 'ok') {
    return null;
  }
  if (fields.has('usageParse')) return null;
  const model = fields.get('model');
  if (typeof model !== 'string' || model === '-' || !MODEL_PATTERN.test(model)) return null;
  const input = wholeNumber(fields.get('in'));
  const cacheRead = wholeNumber(fields.get('cr'));
  const cacheCreation = wholeNumber(fields.get('cc'));
  if (input === null || cacheRead === null || cacheCreation === null) return null;
  if (input + cacheRead + cacheCreation <= 0) return null;
  const ua = fields.get('ua');
  const version = typeof ua === 'string' && VERSION_PATTERN.test(ua) ? ua : null;
  return { model, version, input, cacheRead, cacheCreation };
}

function wholeNumber(value) {
  return typeof value === 'string' && COUNT_PATTERN.test(value) ? Number(value) : null;
}

/**
 * Wires the drift watch between the server's logger and the alert watch.
 *
 * `logger` is the one log writer for the whole server: every line goes to
 * `baseLogger`, and then, once connected, to the drift watch. The drift watch
 * writes its own lines to `baseLogger` only, so they are not fed back.
 *
 * `connect` creates the drift watch only when `enabled` is true (the alerts
 * section at start). It is on while `alertWatch.statusSection()` is not null and
 * reports through `alertWatch.notice()`. `start` starts the alert watch, then
 * the drift watch; `stop` saves the drift state, then stops the alert watch.
 * Before `connect`, `start` and `stop` do nothing. Nothing here throws, and
 * `stop` never rejects.
 *
 * @param {{baseLogger: (line: string) => void}} options
 * @returns {{logger: (line: string) => void, connect: (options: object) => boolean, start: () => void, stop: () => Promise<void>}}
 */
export function attachDriftWatch({ baseLogger } = {}) {
  let connected = false;
  let alertWatch = null;
  let driftWatch = null;
  const base = line => {
    try {
      baseLogger?.(line);
    } catch {}
  };
  return {
    logger(line) {
      base(line);
      try {
        driftWatch?.noteLogLine(line);
      } catch {}
    },
    connect({
      enabled = false,
      alertWatch: watch = null,
      accountManager = null,
      isListedModel = null,
      isListedScope = null,
      readState = null,
      writeState = null,
      now,
      timers,
    } = {}) {
      try {
        if (connected) return false;
        connected = true;
        alertWatch = watch;
        if (enabled !== true || !watch) return false;
        driftWatch = createDriftWatch({
          isEnabled: () => watch.statusSection() !== null,
          notice: input => watch.notice(input),
          accountManager,
          isListedModel,
          isListedScope,
          readState,
          writeState,
          logger: base,
          ...(typeof now === 'function' ? { now } : {}),
          ...(timers ? { timers } : {}),
        });
        return true;
      } catch {
        return false;
      }
    },
    start() {
      if (!alertWatch) return;
      try {
        alertWatch.start();
      } catch {}
      driftWatch?.start();
    },
    async stop() {
      if (!alertWatch) return;
      try {
        await driftWatch?.stop();
      } catch {}
      try {
        alertWatch.stop();
      } catch {}
    },
  };
}

/**
 * @param {object} options
 * @param {() => boolean} options.isEnabled False while the alerts section is
 *   off: nothing is counted, saved, reported or logged.
 * @param {(input: {kind: string, key: string, text: string}) => boolean} options.notice
 * @param {{accounts?: object[]}|null} options.accountManager Read only, and
 *   only `quota.weeklyScoped[].key`.
 * @param {(name: string) => boolean} options.isListedModel Model names on the fixed list.
 * @param {(key: string) => boolean} options.isListedScope Scope names on the fixed list.
 * @param {() => Promise<object|null>} options.readState Null when nothing is saved yet.
 * @param {(state: object) => Promise<void>} options.writeState
 * @param {((line: string) => void)|null} options.logger
 * @param {() => number} options.now
 * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} options.timers
 */
export function createDriftWatch({
  isEnabled = null,
  notice = null,
  accountManager = null,
  isListedModel = null,
  isListedScope = null,
  readState = null,
  writeState = null,
  logger = null,
  now = () => Date.now(),
  timers = defaultTimers(),
} = {}) {
  let started = false;
  let stopped = false;
  let ready = false;
  let enabledNow = true;
  let sweepTimer = null;
  let createdAt = 0;
  let newestVersion = null;
  let dirty = false;
  let writing = null;
  let writeAgain = false;
  let lastWriteError = null;
  let limitHour = null;
  let limitCount = 0;
  const seen = { clientVersions: new Set(), models: new Set(), scopes: new Set() };
  // model -> rows [hour, count, missRate, p50, p95], oldest first.
  const hours = new Map();
  // `<series>|<metric>` -> { since, within, last } (hour numbers).
  const episodes = new Map();
  // hour -> (series -> counts of that hour). A series is a model, or
  // `<model>@<version>` for the requests of one Claude Code version.
  const buckets = new Map();
  // Hours up to this one are never closed: the hour the watch started or came
  // back in (a partial hour), and every hour already closed.
  let floorHour = -1;

  return {
    /** Counts one log line. Only proxy lines matter; never throws. */
    noteLogLine(line) {
      try {
        if (!ready || stopped) return;
        const parsed = parseProxyLine(line);
        if (!parsed || !checkEnabled()) return;
        observeVersion(parsed.version);
        observeModel(parsed.model);
        countRequest(parsed);
      } catch {}
    },
    start() {
      try {
        if (started || stopped) return;
        started = true;
        sweepTimer = timers.setInterval(() => {
          try {
            sweep();
          } catch {}
        }, DRIFT_SWEEP_INTERVAL_MS);
        sweepTimer?.unref?.();
        let reading;
        try {
          reading = Promise.resolve(typeof readState === 'function' ? readState() : null);
        } catch (error) {
          reading = Promise.reject(error);
        }
        reading
          .then(raw => restore(raw), () => restore(undefined, 'unreadable'))
          .catch(() => {});
      } catch {}
    },
    /** Stops the sweep and saves once. Never rejects. */
    async stop() {
      try {
        if (stopped) return;
        stopped = true;
        if (sweepTimer) timers.clearInterval(sweepTimer);
        sweepTimer = null;
        if (writing) await writing;
        if (!ready || !enabled()) return;
        await writeOnce(snapshot());
      } catch {}
    },
  };

  // ---- small helpers ----

  // Lines are written only while the alerts section is on.
  function log(line) {
    try {
      if (!enabled()) return;
      logger?.(`${new Date(now()).toISOString()} drift-watch ${line}`);
    } catch {}
  }

  function enabled() {
    try {
      return typeof isEnabled === 'function' && isEnabled() === true;
    } catch {
      return false;
    }
  }

  // Returns whether the watch is on now. Counts from before a change are
  // dropped, and the hour it comes back in is a partial one.
  function checkEnabled() {
    const on = enabled();
    if (on !== enabledNow) {
      enabledNow = on;
      buckets.clear();
      if (on) floorHour = Math.max(floorHour, hourOf(now()));
    }
    return on;
  }

  function listed(fn, value) {
    try {
      return typeof fn === 'function' && fn(value) === true;
    } catch {
      return false;
    }
  }

  function learning() {
    return now() - createdAt < DRIFT_LEARNING_MS;
  }

  // ---- state ----

  function restore(raw, failure = null) {
    if (stopped) return;
    const parsed = failure ? null : readSavedState(raw, hourOf(now()));
    if (failure || (raw != null && !parsed)) {
      log(`state=ignored reason=${failure || 'format'}`);
    }
    if (parsed) {
      createdAt = parsed.createdAt;
      for (const name of Object.keys(seen)) {
        for (const value of parsed.seen[name]) remember(seen[name], value);
      }
      for (const [model, rows] of parsed.hours) hours.set(model, rows);
      for (const [key, episode] of parsed.episodes) episodes.set(key, episode);
      newestVersion = newest(seen.clientVersions);
      dirty = false;
    } else {
      createdAt = now();
      dirty = true;
    }
    ready = true;
    enabledNow = true;
    floorHour = Math.max(floorHour, hourOf(now()));
  }

  function remember(set, value) {
    set.add(value);
    // A Set keeps insertion order, so the first value is the oldest.
    while (set.size > DRIFT_MAX_SEEN) set.delete(set.values().next().value);
    dirty = true;
  }

  function snapshot() {
    return {
      format: STATE_FORMAT,
      createdAt,
      seen: {
        clientVersions: [...seen.clientVersions],
        models: [...seen.models],
        scopes: [...seen.scopes],
      },
      hours: Object.fromEntries([...hours].map(([model, rows]) => [model, rows.map(row => [...row])])),
      episodes: Object.fromEntries([...episodes].map(([key, episode]) => [key, { ...episode }])),
    };
  }

  // Writes one at a time; a save asked for during a write runs after it.
  function save() {
    if (writing) {
      writeAgain = true;
      return;
    }
    dirty = false;
    writing = writeOnce(snapshot()).finally(() => {
      writing = null;
      if (writeAgain && !stopped) {
        writeAgain = false;
        save();
      }
    });
  }

  async function writeOnce(state) {
    try {
      if (typeof writeState !== 'function') return;
      await writeState(state);
      lastWriteError = null;
    } catch (error) {
      const code = typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code) ? error.code : 'other';
      if (code === lastWriteError) return;
      lastWriteError = code;
      log(`state-write result=failed errorType=${code}`);
    }
  }

  // ---- sweep ----

  function sweep() {
    if (!ready || stopped || !checkEnabled()) return;
    const hour = hourOf(now());
    closeHours(hour);
    closeIdleEpisodes(hour);
    observeScopes();
    if (dirty) save();
  }

  // ---- hourly counts and checks ----

  function countRequest({ model, version, input, cacheRead, cacheCreation }) {
    const hour = hourOf(now());
    if (hour <= floorHour) return;
    let bucket = buckets.get(hour);
    if (!bucket) {
      bucket = new Map();
      buckets.set(hour, bucket);
    }
    addToSeries(bucket, model, model, null, input, cacheRead, cacheCreation);
    if (version !== null) addToSeries(bucket, `${model}@${version}`, model, version, input, cacheRead, cacheCreation);
  }

  function addToSeries(bucket, key, model, version, input, cacheRead, cacheCreation) {
    let series = bucket.get(key);
    if (!series) {
      // Bounds the memory of an hour with many odd model names or versions.
      if (bucket.size >= DRIFT_MAX_SEEN) return;
      series = { model, version, count: 0, input: 0, cacheRead: 0, cacheCreation: 0, sizes: [] };
      bucket.set(key, series);
    }
    series.count += 1;
    series.input += input;
    series.cacheRead += cacheRead;
    series.cacheCreation += cacheCreation;
    series.sizes.push(input + cacheRead + cacheCreation);
  }

  // Closes the finished hours that had requests, oldest first. Nothing is
  // closed while the clock is behind an hour that has counts.
  function closeHours(currentHour) {
    for (const hour of [...buckets.keys()].sort((a, b) => a - b)) {
      if (hour >= currentHour) continue;
      const bucket = buckets.get(hour);
      buckets.delete(hour);
      if (hour <= floorHour) continue;
      floorHour = hour;
      closeHour(hour, bucket, currentHour);
    }
  }

  function closeHour(hour, bucket, currentHour) {
    const all = [...bucket].map(([key, series]) => [key, summarize(series)]);
    for (const [, st] of all) {
      if (st.version === null && st.count >= DRIFT_MIN_REQUESTS) keepHour(st.model, [hour, st.count, st.miss, st.p50, st.p95]);
    }
    pruneHistory(currentHour);
    // A model that is off on a measure covers its versions on that measure.
    const modelOff = new Map();
    for (const [key, st] of all) {
      if (st.version === null) modelOff.set(st.model, judgeSeries(key, st, hour, new Set()));
    }
    for (const [key, st] of all) {
      if (st.version !== null) judgeSeries(key, st, hour, modelOff.get(st.model) || new Set());
    }
    dirty = true;
  }

  function keepHour(model, row) {
    const rows = (hours.get(model) || []).filter(existing => existing[0] !== row[0]);
    rows.push(row);
    rows.sort((a, b) => a[0] - b[0]);
    hours.delete(model);
    hours.set(model, rows);
    trimModels(hours);
  }

  function pruneHistory(currentHour) {
    const oldest = currentHour - DRIFT_HISTORY_HOURS;
    for (const [model, rows] of hours) {
      const kept = rows.filter(row => row[0] >= oldest);
      if (kept.length === 0) hours.delete(model);
      else if (kept.length !== rows.length) hours.set(model, kept);
    }
  }

  // Judges one series against the model's same hour of the previous days.
  // Returns the measures on which the series is off.
  function judgeSeries(key, st, hour, skip) {
    const byHour = new Map((hours.get(st.model) || []).map(row => [row[0], row]));
    const previous = [];
    for (let day = 1; day <= DRIFT_BASELINE_DAYS; day += 1) {
      const row = byHour.get(hour - 24 * day);
      if (row) previous.push(row);
    }
    const off = new Set();
    for (const measure of MEASURES) {
      if (skip.has(measure.name)) continue;
      const verdict = judgeMeasure(measure, st, previous);
      if (!verdict) continue;
      if (verdict.off) off.add(measure.name);
      trackEpisode(key, measure, st, hour, verdict);
    }
    return off;
  }

  function trackEpisode(key, measure, st, hour, verdict) {
    const episodeKey = `${key}|${measure.name}`;
    const episode = episodes.get(episodeKey);
    if (verdict.off) {
      if (episode) {
        episode.within = 0;
        episode.last = hour;
        return;
      }
      if (episodes.size >= DRIFT_MAX_SEEN) return;
      episodes.set(episodeKey, { since: hour, within: 0, last: hour });
      sendNotice(measure.kind, `${episodeKey}|${hour}`, measure.text(st, verdict));
      return;
    }
    if (!episode) return;
    episode.within += 1;
    episode.last = hour;
    if (episode.within >= DRIFT_EPISODE_CLEAR_HOURS) episodes.delete(episodeKey);
  }

  function closeIdleEpisodes(currentHour) {
    for (const [key, episode] of episodes) {
      if (currentHour - episode.last >= DRIFT_EPISODE_IDLE_HOURS) {
        episodes.delete(key);
        dirty = true;
      }
    }
  }

  // ---- first-seen values ----

  function observeVersion(version) {
    if (version === null || seen.clientVersions.has(version)) return;
    const previous = newestVersion;
    remember(seen.clientVersions, version);
    if (previous !== null && compareVersions(version, previous) <= 0) return;
    newestVersion = version;
    if (previous === null || learning()) return;
    reportFirstSeen('client-version', version,
      `claude-rotator: first time seeing Claude Code ${version} (newest before: ${previous}).`);
  }

  function observeModel(model) {
    if (seen.models.has(model)) return;
    remember(seen.models, model);
    if (learning() || listed(isListedModel, model)) return;
    reportFirstSeen('model-name', model, `claude-rotator: first time seeing model ${model}.`);
  }

  function observeScopes() {
    const accounts = Array.isArray(accountManager?.accounts) ? accountManager.accounts : [];
    for (const account of accounts) {
      const scoped = account?.quota?.weeklyScoped;
      if (!Array.isArray(scoped)) continue;
      for (const limit of scoped) {
        const key = limit?.key;
        if (typeof key !== 'string' || !SCOPE_PATTERN.test(key) || seen.scopes.has(key)) continue;
        remember(seen.scopes, key);
        if (learning() || listed(isListedScope, key)) continue;
        reportFirstSeen('limit-scope', key, `claude-rotator: first time seeing weekly limit scope ${key}.`);
      }
    }
  }

  function reportFirstSeen(kind, key, text) {
    const hour = hourOf(now());
    if (hour !== limitHour) {
      limitHour = hour;
      limitCount = 0;
    }
    if (limitCount >= DRIFT_MAX_FIRST_SEEN_PER_HOUR) {
      log(`notice kind=${kind} key=${key} result=limit`);
      return;
    }
    limitCount += 1;
    sendNotice(kind, key, text);
  }

  function sendNotice(kind, key, text) {
    let queued = false;
    try {
      queued = typeof notice === 'function' && notice({ kind, key, text }) === true;
    } catch {}
    log(`notice kind=${kind} key=${key} result=${queued ? 'queued' : 'rejected'}`);
  }
}

// ---- the hourly measures ----

function summarize(series) {
  const total = series.input + series.cacheRead + series.cacheCreation;
  const sizes = Float64Array.from(series.sizes).sort();
  return {
    model: series.model,
    version: series.version,
    count: series.count,
    miss: total > 0 ? (series.input + series.cacheCreation) / total : 0,
    p50: quantile(sizes, 0.5),
    p95: quantile(sizes, 0.95),
  };
}

// Linear between the two nearest ranks of sorted values.
function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const k = (sorted.length - 1) * q;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (k - lo);
}

function median(values) {
  return quantile(Float64Array.from(values).sort(), 0.5);
}

// Returns { off, ratio, base } or null when the hour cannot be judged.
function judgeMeasure(measure, st, previous) {
  if (st.count < measure.minRequests) return null;
  const base = previous.filter(row => row[1] >= measure.minRequests).map(row => row[measure.column]);
  if (base.length < DRIFT_MIN_BASELINE_DAYS) return null;
  const usual = median(base);
  if (!(usual > 0)) return null;
  const ratio = measure.value(st) / usual;
  return { off: measure.isOff(ratio), ratio, base: usual };
}

function seriesLabel(st) {
  return st.version === null ? st.model : `${st.model} on Claude Code ${st.version}`;
}

function sizeText(what, st, verdict, value) {
  return `claude-rotator: ${what} request size for ${seriesLabel(st)} was ${verdict.ratio.toFixed(1)}x the usual`
    + ` for this hour of the day (${Math.round(value / 1000)}k vs ${Math.round(verdict.base / 1000)}k tokens, ${st.count} requests).`;
}

const MEASURES = [
  {
    name: 'cache',
    kind: 'cache-miss',
    column: 2,
    minRequests: DRIFT_MIN_REQUESTS,
    value: st => st.miss,
    isOff: ratio => ratio >= DRIFT_MISS_RATIO,
    text: (st, verdict) => `claude-rotator: cache misses for ${seriesLabel(st)} were ${verdict.ratio.toFixed(1)}x the usual`
      + ` for this hour of the day (hit rate ${percent(1 - st.miss)}% vs ${percent(1 - verdict.base)}%, ${st.count} requests).`,
  },
  {
    name: 'p50',
    kind: 'request-size-p50',
    column: 3,
    minRequests: DRIFT_MIN_REQUESTS,
    value: st => st.p50,
    isOff: ratio => ratio >= DRIFT_P50_RATIO || ratio <= 1 / DRIFT_P50_RATIO,
    text: (st, verdict) => sizeText('median', st, verdict, st.p50),
  },
  {
    name: 'p95',
    kind: 'request-size-p95',
    column: 4,
    minRequests: DRIFT_MIN_REQUESTS_P95,
    value: st => st.p95,
    isOff: ratio => ratio >= DRIFT_P95_RATIO || ratio <= 1 / DRIFT_P95_RATIO,
    text: (st, verdict) => sizeText('95th percentile', st, verdict, st.p95),
  },
];

function percent(rate) {
  return (rate * 100).toFixed(1);
}

// ---- saved state ----

// Returns the saved state in memory form, or null when its shape is wrong.
// Single values of the wrong form are dropped; the rest is kept.
function readSavedState(raw, currentHour) {
  if (!isPlainObject(raw) || raw.format !== STATE_FORMAT) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;
  if (!isPlainObject(raw.seen)) return null;
  const seenLists = {};
  const forms = { clientVersions: VERSION_PATTERN, models: MODEL_PATTERN, scopes: SCOPE_PATTERN };
  for (const [name, pattern] of Object.entries(forms)) {
    const list = raw.seen[name] ?? [];
    if (!Array.isArray(list)) return null;
    seenLists[name] = list.filter(value => typeof value === 'string' && value !== '-' && pattern.test(value));
  }
  const rawHours = raw.hours ?? {};
  const rawEpisodes = raw.episodes ?? {};
  if (!isPlainObject(rawHours) || !isPlainObject(rawEpisodes)) return null;
  const hours = new Map();
  for (const [model, rows] of Object.entries(rawHours)) {
    if (!MODEL_PATTERN.test(model) || model === '-' || !Array.isArray(rows)) continue;
    const byHour = new Map();
    for (const row of rows) {
      if (isHourRow(row) && row[0] >= currentHour - DRIFT_HISTORY_HOURS) byHour.set(row[0], [...row]);
    }
    if (byHour.size > 0) hours.set(model, [...byHour.values()].sort((a, b) => a[0] - b[0]));
  }
  trimModels(hours);
  const episodes = new Map();
  for (const [key, episode] of Object.entries(rawEpisodes)) {
    if (!EPISODE_KEY_PATTERN.test(key) || !isPlainObject(episode)) continue;
    const { since, within, last } = episode;
    if (![since, within, last].every(value => Number.isSafeInteger(value) && value >= 0)) continue;
    episodes.set(key, { since, within, last });
    if (episodes.size >= DRIFT_MAX_SEEN) break;
  }
  return { createdAt: raw.createdAt, seen: seenLists, hours, episodes };
}

const EPISODE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}(@\d{1,4}\.\d{1,4}\.\d{1,6})?\|(cache|p50|p95)$/;

function isHourRow(row) {
  if (!Array.isArray(row) || row.length !== 5) return false;
  const [hour, count, miss, p50, p95] = row;
  return Number.isSafeInteger(hour) && hour >= 0
    && Number.isSafeInteger(count) && count >= 0
    && Number.isFinite(miss) && miss >= 0 && miss <= 1
    && Number.isFinite(p50) && p50 >= 0
    && Number.isFinite(p95) && p95 >= 0;
}

// Keeps the models whose newest hour is the most recent.
function trimModels(hours) {
  while (hours.size > DRIFT_MAX_MODELS) {
    let oldest = null;
    for (const [model, rows] of hours) {
      const latest = rows[rows.length - 1][0];
      if (oldest === null || latest < oldest.latest) oldest = { model, latest };
    }
    hours.delete(oldest.model);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---- numbers ----

function hourOf(ms) {
  return Math.floor(ms / HOUR_MS);
}

function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

function newest(versions) {
  let best = null;
  for (const version of versions) {
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle),
  };
}
