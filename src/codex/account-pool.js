// Pure account state. Only the manager mutates a live instance; snapshots are
// detached projections. Transport, credentials and path resolution live outside.
function time(nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('explicit finite time required');
}

// A stop is a latch: only a qualifying observation clears it, never elapsed
// time and never a reset instant. Recovery needs this many complete GETs.
const RESUME_CONFIRMATIONS = 2;

export function createCodexAccountPool(initialAccounts = [], options = {}) {
  let thresholds, policies, freshnessMs, ttlMs, httpMode, needsLoginRecheckMs, probeIntervalMs, probeEnabled;
  let generation = 0; // Configuration epoch: a read started earlier describes another world.
  let revision = 0; // Advances only when availability improves; terminal caches key off it.
  function applyOptions({
    rotationPrimaryUsedPercentMax = 95, rotationSecondaryUsedPercentMax = 95,
    rotationNeedsLoginRecheckMs = 600000, rotationObservationTtlMs = 60000,
    usagePollIntervalMs = 60000, usageReadTimeoutMs = 5000,
    rotationUsageCapNoResetProbeMs = 3600000, rotationRecoveryProbeEnabled = true,
    usageObservationMode = 'passive', accounts,
  } = {}) {
    thresholds = { primary: rotationPrimaryUsedPercentMax, secondary: rotationSecondaryUsedPercentMax };
    needsLoginRecheckMs = rotationNeedsLoginRecheckMs;
    httpMode = usageObservationMode === 'http';
    probeIntervalMs = rotationUsageCapNoResetProbeMs; // 0 disables the no-reset valve only.
    probeEnabled = rotationRecoveryProbeEnabled !== false;
    ttlMs = rotationObservationTtlMs; // The passive freshness, and the ceiling for the http one.
    // An http observation may not outlive two polls plus one read deadline.
    freshnessMs = httpMode ? Math.min(ttlMs, 2 * usagePollIntervalMs + usageReadTimeoutMs) : ttlMs;
    // Account policy is keyed by label because reconcile entries carry no policy.
    policies = new Map((accounts ?? []).filter(account => account?.label && account.usagePolicy)
      .map(account => [account.label, { ...account.usagePolicy }]));
  }
  applyOptions(options);
  const improved = () => { revision++; };
  const policyOf = entry => policies.get(entry.label) ?? null;
  // Window thresholds and account policy are alternatives, never multiplied together.
  const stopOf = (entry, dimension) => policyOf(entry)?.stopUsedPercent ?? thresholds[dimension];
  // An account may be reserved -- forbidden to carry
  // ANY request while its usage is unknown. This is not a threshold: no observation at
  // all withholds the account exactly as a high one does.
  const reserved = entry => policyOf(entry)?.blockWhenUnknown === true;
  const copyObservation = observation => Object.fromEntries(Object.entries(observation).map(([key, value]) => [key, { ...value }]));
  const copy = entry => ({ ...entry, models: entry.models ? [...entry.models] : null,
    // Always a number: a reader captures it before a GET and hands it back to observe().
    stopEpoch: entry.stopEpoch ?? 0,
    ...(entry.observation ? { observation: copyObservation(entry.observation) } : {}),
    ...(entry.capped ? { capped: { ...entry.capped } } : {}) });
  // 使用量読取の縮退は口座ごとに効く。GET が壊れた口座だけを passive の規律（使用量
  // 不明でも選択可・latch は probe で解ける・鮮度は TTL）で扱い、まだ読める口座は
  // http の規律のまま残す。プール全体のモード（httpMode）はここでは動かさない。
  const httpFor = entry => httpMode && entry.usageDegraded !== true;
  const freshnessOf = entry => (httpFor(entry) ? freshnessMs : ttlMs);
  const fresh = (entry, window, nowMs) => window && nowMs - window.observedAt < freshnessOf(entry) &&
    (window.resetAt === undefined || nowMs < window.resetAt);
  const capped = entry => Object.keys(entry.capped ?? {}).length > 0;
  // The latched windows themselves, not whichever observation is still fresh.
  const cappedWindows = entry => Object.keys(entry.capped ?? {}).map(key => entry.observation?.[key]).filter(Boolean);
  const stopped = entry => capped(entry) || entry.upstreamBlocked === true;
  const observed = (entry, nowMs) => Object.values(entry.observation ?? {}).some(window => fresh(entry, window, nowMs));
  // Selection under http rests on the freshness of complete GETs alone. A response
  // header may stop an account, never make one selectable or recovered again.
  const surveyed = (entry, nowMs) => Number.isFinite(entry.usageGetAt) && nowMs - entry.usageGetAt < freshnessOf(entry);
  // Reserved accounts: the single piece of evidence that opens a reserved account -- a complete GET
  // the upstream also declared usable. It is judged by the configured ceiling rather than
  // by freshnessOf(), so this account's own degradation can never WIDEN its freshness:
  // a broken GET must not buy the passive TTL for an account that is not allowed to guess.
  const assured = (entry, nowMs) => Number.isFinite(entry.usageAllowedAt) && nowMs - entry.usageAllowedAt < freshnessMs;
  // Unknown usage blocks selection only under http, where a poll is expected -- except
  // for a reserved account, which is withheld under every mode and every degradation.
  const blockReason = (entry, nowMs) => capped(entry) ? 'usage-capped'
    : entry.upstreamBlocked ? 'upstream-blocked'
      : reserved(entry) && !assured(entry, nowMs) ? 'usage-unknown-reserved'
        : httpFor(entry) && !surveyed(entry, nowMs) ? 'usage-unknown' : null;
  const excluded = (entry, nowMs) => blockReason(entry, nowMs) !== null;
  // Every stop opens a new epoch. A read that began in an older one describes the
  // world before that stop and never counts as a recovery vote, however late it lands.
  // The epoch, not `stoppedAt`, decides: a stop and a read can share a millisecond.
  const stop = (entry, nowMs) => {
    entry.stopEpoch = (entry.stopEpoch ?? 0) + 1;
    entry.stoppedAt = nowMs;
    delete entry.resumeStreak;
  };
  const release = entry => {
    delete entry.capped; delete entry.cappedSince; delete entry.upstreamBlocked;
    delete entry.resumeStreak; delete entry.stoppedAt; delete entry.probeUsedAt;
    improved();
  };
  // passive only: a latched account earns ONE generation once the reset the
  // upstream advertised has passed, or one safety interval after the latch when it
  // advertised none. http recovers from complete GETs and never probes -- but an
  // account whose own GET has broken is on the passive rules and does earn a probe,
  // otherwise it would stay latched until an observation that can no longer arrive.
  // A reserved account is the one exception to that exception. Its latch is only
  // ever lifted by two complete GETs in a row, so a probe would be a generation sent on an
  // account whose usage is either known to be above its stop or not known at all --
  // precisely what the reserve forbids. Neither a reset nor the safety interval buys one.
  const probeReadyAt = entry => {
    if (!probeEnabled || reserved(entry) || httpFor(entry) || entry.upstreamBlocked || !capped(entry)) return Infinity;
    const valve = probeIntervalMs > 0 ? entry.cappedSince + probeIntervalMs : Infinity;
    let at = entry.cappedSince;
    for (const dimension of Object.keys(entry.capped)) {
      const resetAt = entry.observation?.[dimension]?.resetAt;
      at = Math.max(at, Number.isFinite(resetAt) && resetAt > entry.cappedSince ? resetAt : valve);
    }
    if (entry.probeUsedAt === undefined || at > entry.probeUsedAt) return at;
    // A spent probe re-arms on newer evidence or after the safety interval, never sooner.
    return probeIntervalMs > 0 ? entry.probeUsedAt + probeIntervalMs : Infinity;
  };
  let accounts = new Map();
  const sticky = new Map();
  const payouts = new Map(); // key -> the last probe handed out, so an unsent one can be returned.
  const stickyKey = (conversation, model) => JSON.stringify([conversation, model]);
  function reconcile(entries, nowMs) {
    time(nowMs);
    const next = new Map();
    const promoted = new Map();
    for (const entry of entries) {
      if (!entry.key || next.has(entry.key)) throw new TypeError('duplicate or missing account key');
      const prior = accounts.get(entry.key) ?? accounts.get(entry.previousKey);
      next.set(entry.key, { key: entry.key, label: entry.label, models: entry.models ? [...entry.models] : null,
        state: prior?.state ?? 'unknown', updatedAt: prior?.updatedAt ?? nowMs,
        ...(prior?.retryAt !== undefined ? { retryAt: prior.retryAt } : {}),
        ...(prior?.resetAt !== undefined ? { resetAt: prior.resetAt } : {}),
        ...(prior?.forbiddenAt !== undefined ? { forbiddenAt: prior.forbiddenAt } : {}),
        ...(prior?.recheckAt !== undefined ? { recheckAt: prior.recheckAt } : {}),
        ...(prior?.seenMtime !== undefined ? { seenMtime: prior.seenMtime } : {}),
        ...(prior?.observation ? { observation: copyObservation(prior.observation) } : {}),
        // A usage stop survives identity promotion; it is about the upstream account.
        ...(prior?.capped ? { capped: { ...prior.capped } } : {}),
        ...(prior?.cappedSince !== undefined ? { cappedSince: prior.cappedSince } : {}),
        ...(prior?.upstreamBlocked !== undefined ? { upstreamBlocked: prior.upstreamBlocked } : {}),
        ...(prior?.stoppedAt !== undefined ? { stoppedAt: prior.stoppedAt } : {}),
        ...(prior?.stopEpoch !== undefined ? { stopEpoch: prior.stopEpoch } : {}),
        ...(prior?.probeUsedAt !== undefined ? { probeUsedAt: prior.probeUsedAt } : {}),
        ...(prior?.usageGetAt !== undefined ? { usageGetAt: prior.usageGetAt } : {}),
        ...(prior?.usageAllowedAt !== undefined ? { usageAllowedAt: prior.usageAllowedAt } : {}),
        ...(prior?.observationSequence !== undefined ? { observationSequence: prior.observationSequence } : {}) });
      if (prior && entry.previousKey) promoted.set(entry.previousKey, entry.key);
    }
    accounts = next;
    for (const key of payouts.keys()) if (!accounts.has(key)) payouts.delete(key);
    for (const [key, accountKey] of sticky) {
      const current = promoted.get(accountKey) ?? accountKey;
      if (accounts.has(current)) sticky.set(key, current);
      else sticky.delete(key);
    }
    improved();
  }
  reconcile(initialAccounts, 0);
  const eligible = (entry, model, nowMs) => ['ready', 'probing'].includes(entry.state) && assigned(entry, model) && !excluded(entry, nowMs);
  const assigned = (entry, model) => !entry.models || entry.models.includes(model);
  const usable = (entry, nowMs) => entry.state === 'ready' && (!entry.models || entry.models.length > 0) && !excluded(entry, nowMs);
  function classify(entries, nowMs, scope = 'pool') {
    const result = (status, type, reason, state, resetAt) => ({ status, type, reason, scope, state, resetAt });
    // Unknown usage is not a terminal population: it stays in the degraded branch.
    const usageExcluded = entries.filter(a => a.state === 'ready' && stopped(a));
    // Observed exclusion counts as time-recoverable for the outward pool- and model-scope mixed
    // classification, but never learns confirmed exhaustion internally.
    if (usageExcluded.length && entries.every(a =>
      ['exhausted', 'needs-login', 'credentials-unavailable'].includes(a.state) || usageExcluded.includes(a))) {
      const mixed = entries.some(a => ['needs-login', 'credentials-unavailable'].includes(a.state));
      const resets = entries.flatMap(a => a.state === 'exhausted' ? [a.resetAt]
        : usageExcluded.includes(a) ? cappedWindows(a).map(window => window.resetAt) : [])
        // A reset already in the past is a re-observation cue, never a recovery promise.
        .filter(value => Number.isFinite(value) && value > nowMs);
      return { ...result(529, 'overloaded_error', mixed ? 'codex_pool_mixed' : 'codex_pool_exhausted',
        mixed ? 'mixed' : 'exhausted', resets.length ? Math.min(...resets) : undefined),
        ...(!mixed ? { observationOnly: true } : {}) };
    }
    // Empty/unknown/remaining healthy candidates are not proof of a terminal pool.
    if (!entries.length || entries.some(a => !['needs-login', 'credentials-unavailable', 'exhausted'].includes(a.state))) {
      return { ...result(529, 'overloaded_error', 'codex_attempt_limit', 'degraded'), scope: 'pool' };
    }
    const exhausted = entries.filter(a => a.state === 'exhausted');
    if (exhausted.length) {
      const mixed = exhausted.length !== entries.length;
      const resets = exhausted.map(a => a.resetAt).filter(Number.isFinite);
      return result(529, 'overloaded_error', mixed ? 'codex_pool_mixed' : 'codex_pool_exhausted',
        mixed ? 'mixed' : 'exhausted', resets.length ? Math.min(...resets) : undefined);
    }
    const login = entries.some(a => a.state === 'needs-login');
    return result(403, 'permission_error', login ? 'codex_needs_login' : 'codex_credentials_unavailable',
      login ? 'needs-login' : 'credentials-unavailable');
  }
  return {
    reconcile,
    generation: () => generation,
    revision: () => revision,
    // Reload path: thresholds, freshness and account policy change without losing state.
    configure(next = {}, nowMs) {
      time(nowMs);
      applyOptions(next);
      generation++;
      for (const entry of accounts.values()) {
        // A tightened stop latches now; a loosened one never resumes on old evidence.
        let latched = false;
        for (const [dimension, window] of Object.entries(entry.observation ?? {})) {
          if (window.usedPercent < stopOf(entry, dimension)) continue;
          entry.capped = { ...entry.capped, [dimension]: true };
          entry.cappedSince ??= nowMs;
          latched = true;
        }
        if (latched) stop(entry, nowMs); else delete entry.resumeStreak;
      }
    },
    terminal(model, nowMs) {
      time(nowMs);
      const all = [...accounts.values()];
      const candidates = all.filter(a => assigned(a, model));
      if (all.length && !candidates.length) return { status: 403, type: 'permission_error',
        reason: 'codex_no_account_for_model', scope: 'model', state: 'no-account-for-model', resetAt: undefined };
      // A pool scope classifies every account, not just the model's candidates under another label.
      return all.some(a => usable(a, nowMs) && !assigned(a, model))
        ? classify(candidates, nowMs, 'model') : classify(all, nowMs);
    },
    // Read-only projection for /healthz. It reuses the very predicates
    // select() rests on, so a published reason cannot drift from the live rule.
    // Model assignment is not a health dimension: an account restricted to other
    // models is eligible here and its `models` list says so.
    inspect(nowMs) {
      time(nowMs);
      return [...accounts.values()].map(entry => {
        const policy = policyOf(entry);
        const reason = Array.isArray(entry.models) && entry.models.length === 0 ? 'model-unassigned'
          : ['exhausted', 'needs-login', 'credentials-unavailable'].includes(entry.state) ? entry.state
            : blockReason(entry, nowMs);
        return { key: entry.key, selectionBlockReason: reason,
          selectionEligible: reason === null && ['ready', 'probing'].includes(entry.state),
          // A stopped but authenticated account reads as cooldown outward.
          cooldown: entry.state === 'ready' && stopped(entry),
          stopUsedPercent: policy?.stopUsedPercent ?? null, resumeUsedPercent: policy?.resumeUsedPercent ?? null,
          // The applied reserve, so a deployment can verify the flag really took
          // effect on this account instead of inferring it from a block that may not be showing.
          blockWhenUnknown: policy ? policy.blockWhenUnknown === true : null,
          fresh: Object.fromEntries(['primary', 'secondary'].map(d => [d, fresh(entry, entry.observation?.[d], nowMs) === true])),
          // The freshness actually applied to this account: a degraded one is judged
          // by the passive TTL, because no poll is coming to renew it.
          surveyed: surveyed(entry, nowMs), freshnessMs: freshnessOf(entry) };
      });
    },
    health(nowMs) {
      time(nowMs);
      const all = [...accounts.values()];
      const available = all.filter(a => usable(a, nowMs)).length;
      return { state: all.length && available === all.length ? 'ok' : classify(all, nowMs).state,
        accountsAvailable: available, resetAt: classify(all, nowMs).resetAt ?? null };
    },
    // `source` separates integer GET readings from fractional response headers;
    // the two are never compared as one series and only a GET may recover.
    observe(key, observation, nowMs, meta = {}) {
      time(nowMs);
      const entry = accounts.get(key);
      if (!entry || !observation) return;
      // `stopEpoch` is the epoch the reader held when the GET began (snapshot().stopEpoch).
      const { source = 'response-header', complete = false, ordinaryUsageAllowed, sequence, stopEpoch } = meta;
      if (meta.generation !== undefined && meta.generation !== generation) return;
      if (Number.isFinite(sequence)) {
        if (sequence <= (entry.observationSequence ?? -Infinity)) return;
        entry.observationSequence = sequence;
      }
      const applied = [];
      for (const dimension of ['primary', 'secondary']) {
        const usedPercent = observation[`${dimension}_used_percent`];
        if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
        if (entry.observation?.[dimension]?.observedAt > nowMs) continue;
        // A rolling window's duration is not evidence of its reset time.
        const resetAt = observation[`${dimension}_reset_at`];
        const windowDurationMins = observation[`${dimension}_window_minutes`];
        entry.observation ??= {};
        entry.observation[dimension] = { usedPercent, observedAt: nowMs, source,
          ...(Number.isFinite(windowDurationMins) && windowDurationMins > 0 ? { windowDurationMins } : {}),
          // Only advertise a reset representable as an RFC3339 timestamp.
          ...(Number.isSafeInteger(resetAt) && resetAt >= 0 && resetAt <= 253402300799999 ? { resetAt } : {}) };
        applied.push(dimension);
      }
      // Only a complete GET dates the survey that http selection rests on.
      if (source === 'usage-get' && complete === true && applied.length > 0) {
        entry.usageGetAt = nowMs;
        // Reserved accounts: the same reading, and only when the upstream also said ordinary usage is
        // allowed, dates the evidence a reserved account needs before it may carry anything.
        if (ordinaryUsageAllowed === true) entry.usageAllowedAt = nowMs;
      }
      // A refused account is withheld however low its percentages read.
      if (source === 'usage-get' && ordinaryUsageAllowed === false) {
        entry.upstreamBlocked = true;
        stop(entry, nowMs);
      }
      // Either source alone stops the account, at or above the threshold.
      let latched = false;
      for (const dimension of applied) {
        if (entry.observation[dimension].usedPercent < stopOf(entry, dimension)) continue;
        entry.capped = { ...entry.capped, [dimension]: true };
        entry.cappedSince ??= nowMs;
        latched = true;
      }
      if (latched) stop(entry, nowMs);
      const policy = policyOf(entry);
      if (!policy) {
        // Legacy global thresholds keep their single-observation release per window.
        for (const dimension of applied) {
          if (entry.observation[dimension].usedPercent >= thresholds[dimension] || !entry.capped?.[dimension]) continue;
          delete entry.capped[dimension];
          if (capped(entry)) continue;
          release(entry);
        }
        return;
      }
      // Recovery needs a complete GET below the resume threshold, twice in a row.
      const qualifies = source === 'usage-get' && complete === true && ordinaryUsageAllowed === true
        && applied.length > 0 && applied.every(d => entry.observation[d].usedPercent <= policy.resumeUsedPercent);
      // Only a read that names the epoch it began in can be placed after the stop that
      // closed it -- including the stop this very call latched, which already advanced it.
      // snapshot() always hands the reader a number, so a missing or mismatched epoch is
      // an unplaceable read: evidence for stopping above, never a vote for recovery.
      const current = Number.isFinite(stopEpoch) && stopEpoch === (entry.stopEpoch ?? 0);
      if (!qualifies || !current) { delete entry.resumeStreak; return; }
      entry.resumeStreak = (entry.resumeStreak ?? 0) + 1;
      if (entry.resumeStreak < RESUME_CONFIRMATIONS || !stopped(entry)) return;
      release(entry);
    },
    // The poller marks the account whose usage GET has broken (a failed
    // verification gate, or five consecutive failures). Only that account falls back
    // to the passive discipline; every still-readable account keeps the http rules,
    // so one unreadable account no longer leaves itself unselectable and unprobeable.
    usageDegraded(key, degraded) {
      const entry = accounts.get(key);
      const next = degraded === true;
      if (!entry || (entry.usageDegraded === true) === next) return;
      if (!next) { delete entry.usageDegraded; return; }
      entry.usageDegraded = true;
      improved(); // Unknown usage becomes selectable again: availability only widens.
    },
    // A read that produced no observation (timeout, 5xx, unparsable body, unreadable
    // credentials) is evidence of nothing -- but it does break the run of complete
    // readings recovery requires, so a success/failure/success sequence must not recover.
    observationFailed(key) {
      const entry = accounts.get(key);
      if (entry) delete entry.resumeStreak;
    },
    exhausted(key, { resetAt, retryAt }, nowMs) {
      time(nowMs);
      time(retryAt);
      const entry = accounts.get(key);
      if (!entry) return;
      entry.state = 'exhausted';
      entry.updatedAt = nowMs;
      entry.retryAt = retryAt;
      if (Number.isFinite(resetAt)) entry.resetAt = resetAt;
      else delete entry.resetAt;
    },
    credentials(key, readable, nowMs, { recover = false } = {}) {
      time(nowMs);
      const entry = accounts.get(key);
      if (!entry) return;
      if (entry.state === 'needs-login') {
        if (recover && readable) { entry.state = 'probing'; entry.updatedAt = nowMs; improved(); }
        return;
      }
      if (entry.state === 'probing') return;
      if (readable && entry.state === 'exhausted' && entry.retryAt > nowMs) return;
      delete entry.resetAt;
      delete entry.retryAt;
      const before = entry.state;
      entry.state = readable ? 'ready' : 'credentials-unavailable';
      entry.updatedAt = nowMs;
      if (entry.state === 'ready' && before !== 'ready') improved();
    },
    succeeded(key, nowMs, issuedAtMs = nowMs) {
      time(nowMs);
      time(issuedAtMs);
      const entry = accounts.get(key);
      if (!entry || (entry.forbiddenAt !== undefined && issuedAtMs <= entry.forbiddenAt)) return;
      // An ordinary generation proves credentials, never a released usage stop.
      // The one exception is the probe the latch itself authorised: it recovers the
      // account unless the very response that carried it stopped the account again.
      if (entry.probeUsedAt !== undefined && issuedAtMs >= entry.probeUsedAt
        && (entry.stoppedAt ?? -Infinity) < entry.probeUsedAt) release(entry);
      const before = entry.state;
      entry.state = 'ready';
      delete entry.forbiddenAt;
      delete entry.recheckAt;
      delete entry.seenMtime;
      delete entry.resetAt;
      delete entry.retryAt;
      entry.updatedAt = nowMs;
      if (before !== 'ready') improved();
    },
    rechecked(key, seenMtime, nowMs) {
      time(nowMs);
      const entry = accounts.get(key);
      if (!entry) return;
      entry.seenMtime = seenMtime;
      entry.recheckAt = nowMs + needsLoginRecheckMs;
    },
    probeFailed(key, nowMs) {
      time(nowMs);
      const entry = accounts.get(key);
      if (entry?.state !== 'probing') return;
      entry.state = 'needs-login';
      entry.recheckAt = nowMs + needsLoginRecheckMs;
      entry.updatedAt = nowMs;
    },
    forbidden(key, nowMs, seenMtime = null) {
      time(nowMs);
      const entry = accounts.get(key);
      if (!entry) return;
      entry.state = 'needs-login';
      entry.forbiddenAt = Math.max(entry.forbiddenAt ?? nowMs, nowMs);
      entry.seenMtime = seenMtime;
      entry.recheckAt = entry.forbiddenAt + needsLoginRecheckMs;
      delete entry.resetAt;
      delete entry.retryAt;
      entry.updatedAt = nowMs;
    },
    select(model, nowMs, conversation, attempted) {
      time(nowMs);
      const preferred = conversation ? accounts.get(sticky.get(stickyKey(conversation, model))) : null;
      const candidates = [...accounts.values()].filter(a => !attempted?.has(a.key) && eligible(a, model, nowMs));
      const entry = preferred && candidates.includes(preferred) ? preferred
        : candidates.find(a => a.state === 'ready' && observed(a, nowMs))
          ?? candidates.find(a => a.state === 'probing') ?? candidates[0];
      return entry ? copy(entry) : null;
    },
    // Last resort after select() finds nothing: hand back one latched account so a
    // single generation can test the stop. Callers must treat it as an attempt.
    probe(model, nowMs, attempted) {
      time(nowMs);
      const entry = [...accounts.values()].find(a => !attempted?.has(a.key) && ['ready', 'probing'].includes(a.state)
        && assigned(a, model) && nowMs >= probeReadyAt(a));
      if (!entry) return null;
      payouts.set(entry.key, { at: nowMs, previous: entry.probeUsedAt });
      entry.probeUsedAt = nowMs;
      return copy(entry);
    },
    // A payout the caller never sent buys nothing: the latch is still owed its one
    // generation, so the spend is undone and probeReadyAt() returns to what it was.
    refundProbe(key) {
      const entry = accounts.get(key);
      const payout = payouts.get(key);
      if (!entry || !payout || entry.probeUsedAt !== payout.at) return;
      if (payout.previous === undefined) delete entry.probeUsedAt; else entry.probeUsedAt = payout.previous;
      payouts.delete(key);
    },
    bind(conversation, model, key, nowMs) {
      time(nowMs);
      if (conversation && accounts.has(key)) sticky.set(stickyKey(conversation, model), key);
    },
    snapshot() {
      return [...accounts.values()].map(copy);
    },
  };
}
