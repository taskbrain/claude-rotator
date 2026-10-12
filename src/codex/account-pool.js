// Pure account state. Only the manager mutates a live instance; snapshots are
// detached projections. Transport, credentials and path resolution live outside.
function time(nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError('explicit finite time required');
}

// A stop is a latch: only a qualifying observation clears it, never elapsed
// time and never a reset instant. Recovery needs this many complete GETs. A reset
// instant (or, without one, the probe interval) matters only for dropping the stop of
// a window that vanished from the upstream, and only together with misses: see countMisses().
const RESUME_CONFIRMATIONS = 2;
// 窓の停止を、上流から消えた窓について外すのに要る、続けての欠落の回数（時刻の条件と併せて要る）。
const MISSES_TO_DROP = 2;
const POSITIONS = Object.freeze(['primary', 'secondary']);
// RFC3339 で表現できる上限。
const MAX_TIMESTAMP_MS = 253402300799999;
// observe() が返す出来事の種類: 上流から消えた窓の停止だけを外した。
export const WINDOW_CAP_DROPPED = 'window-cap-dropped';

// usageAuthRejected() が受け取る理由（auth-tracker.js の規則が決める）。これ以外は拒否する。
export const USAGE_AUTH_REJECTION_REASONS = Object.freeze(['upstream-unauthorized', 'upstream-forbidden', 'access-token-expired']);

// 窓は長さで識別する。鍵は長さの申告があれば len:<分>、無ければ pos:<位置>（位置は、長さの
// 申告が無いときにだけ鍵に使う）。停止の記録・観測の保存・票の照合・欠落の数え方はこの鍵で行い、
// しきい値だけを位置で引く。len: の鍵は同じ長さを申告した窓とだけ、pos: の鍵は同じ位置の長さの
// 申告が無い窓とだけ照合する。
const windowKeyOf = (position, windowDurationMins) =>
  (windowDurationMins === undefined ? `pos:${position}` : `len:${windowDurationMins}`);

export function createCodexAccountPool(initialAccounts = [], options = {}) {
  let thresholds, policies, freshnessMs, ttlMs, httpMode, needsLoginRecheckMs, noResetProbeMs;
  let generation = 0; // Configuration epoch: a read started earlier describes another world.
  let revision = 0; // Advances only when availability improves; terminal caches key off it.
  function applyOptions({
    rotationPrimaryUsedPercentMax = 95, rotationSecondaryUsedPercentMax = 95,
    rotationNeedsLoginRecheckMs = 600000, rotationObservationTtlMs = 60000,
    usagePollIntervalMs = 60000, usageReadTimeoutMs = 5000,
    rotationUsageCapNoResetProbeMs = 3600000,
    usageObservationMode = 'passive', accounts,
  } = {}) {
    thresholds = { primary: rotationPrimaryUsedPercentMax, secondary: rotationSecondaryUsedPercentMax };
    needsLoginRecheckMs = rotationNeedsLoginRecheckMs;
    // リセット時刻の記録が無い窓の停止を、欠落2回に加えて停止からこの時間が過ぎたら外す。0 は外さない。
    // 値の検査は設定の読込（config.js）が行う。
    noResetProbeMs = rotationUsageCapNoResetProbeMs;
    httpMode = usageObservationMode === 'http';
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
  // Both are looked up by the position a window was reported at, never by its key.
  const stopOf = (entry, position) => policyOf(entry)?.stopUsedPercent ?? thresholds[position];
  // An account may be reserved -- forbidden to carry
  // ANY request while its usage is unknown. This is not a threshold: no observation at
  // all withholds the account exactly as a high one does.
  const reserved = entry => policyOf(entry)?.blockWhenUnknown === true;
  // 口座の中の窓の記録（すべて窓の鍵で引く）:
  //   windows[鍵]    保存した観測（鍵・最後に報告された位置・使用率・時刻・長さ・リセット時刻）。
  //                  resetAt は表示用で、観測ごとに置き換わる。confirmedResetAt は、使用量の GET の完全な
  //                  観測が届けた未来のリセット時刻だけを持ち、それ以外の観測では前の値を引き継ぐ
  //   positions[位置] その位置で最後に報告された窓の鍵
  //   windowCaps[鍵] 窓の停止の記録（missing は欠落の連続回数、resetAt は外す判定に使うリセット時刻）
  //   cleanReads     直近の票の候補（完全・allowed・今の停止世代・全窓が復帰しきい値以下の観測）ごとに、
  //                  その観測に載っていなかった停止中の窓の鍵。新しい順に RESUME_CONFIRMATIONS 個まで
  //   resumePending  窓の停止を全部外した後も、口座の停止が復帰の規則を待っている
  const copyEach = records => Object.fromEntries(Object.entries(records).map(([key, value]) => [key, { ...value }]));
  // その位置で最後に報告された窓。窓が別の位置へ移った後は、元の位置には何も無い。
  const windowAt = (entry, position) => {
    const window = entry.windows?.[entry.positions?.[position]];
    return window?.position === position ? window : undefined;
  };
  // 票: 直近の候補のうち、載っていなかった窓の停止がもう残っていないものを、新しい方から続けて数える。
  // 停止した窓が載らない観測は、その窓の停止が残っている間は票にならない。欠落を数えてその窓の停止を
  // 外したら、その観測は（残りの条件を満たしていれば）票になる。
  const votes = entry => {
    let count = 0;
    for (const lacking of [...(entry.cleanReads ?? [])].reverse()) {
      if (lacking.some(key => entry.windowCaps?.[key])) break;
      count++;
    }
    return count;
  };
  // 位置で見た写し（窓を primary・secondary の位置で読む読み手のため）: observation はその位置で最後に報告された窓、capped は
  // 停止中の窓が最後に報告された位置。窓の鍵で見たものは windows と windowCaps にある。
  const copy = entry => {
    const { windows, positions, windowCaps, cleanReads, ...rest } = entry;
    const observation = Object.fromEntries(POSITIONS.filter(position => windowAt(entry, position))
      .map(position => [position, { ...windowAt(entry, position) }]));
    const streak = votes(entry);
    return { ...rest, models: entry.models ? [...entry.models] : null,
      // Always a number: a reader captures it before a GET and hands it back to observe().
      stopEpoch: entry.stopEpoch ?? 0,
      ...(windows ? { windows: copyEach(windows), observation } : {}),
      ...(windowCaps ? { windowCaps: copyEach(windowCaps),
        capped: Object.fromEntries(Object.keys(windowCaps).filter(key => windows?.[key])
          .map(key => [windows[key].position, true])) } : {}),
      ...(streak > 0 ? { resumeStreak: streak } : {}) };
  };
  // 使用量の読取が壊れた口座（縮退）も、選択の規則は変えない。縮退は「使用量が読めない」という
  // 記録とログのためだけのもので、取得処理（usage-poller.js）が持ち、プールへは伝えない。口座ごとに
  // 規則を切り替える経路（使用量不明でも選べる・停止が試し打ちで解ける・鮮度を TTL で測る）は無い。
  const freshnessOf = () => (httpMode ? freshnessMs : ttlMs);
  const fresh = (entry, window, nowMs) => window && nowMs - window.observedAt < freshnessOf(entry) &&
    (window.resetAt === undefined || nowMs < window.resetAt);
  const capped = entry => Object.keys(entry.windowCaps ?? {}).length > 0;
  // The latched windows themselves, not whichever observation is still fresh -- and only
  // those still reported at their position: a window another one has replaced there no
  // longer dates a reset for the account.
  const cappedWindows = entry => Object.keys(entry.windowCaps ?? {}).map(key => entry.windows?.[key])
    .filter(window => window && entry.positions?.[window.position] === window.key);
  const stopped = entry => capped(entry) || entry.upstreamBlocked === true || entry.resumePending === true;
  const observed = (entry, nowMs) => Object.values(entry.windows ?? {}).some(window => fresh(entry, window, nowMs));
  // Selection under http rests on the freshness of complete GETs alone. A response
  // header may stop an account, never make one selectable or recovered again.
  const surveyed = (entry, nowMs) => Number.isFinite(entry.usageGetAt) && nowMs - entry.usageGetAt < freshnessOf(entry);
  // Reserved accounts: the single piece of evidence that opens a reserved account -- a complete GET
  // the upstream also declared usable. It is judged by the configured ceiling rather than
  // by freshnessOf(), so the passive TTL can never WIDEN the evidence a reserved account needs.
  const assured = (entry, nowMs) => Number.isFinite(entry.usageAllowedAt) && nowMs - entry.usageAllowedAt < freshnessMs;
  // Unknown usage blocks selection only under http, where a poll is expected -- except
  // for a reserved account, which is withheld under every mode. An account whose window
  // stops were all dropped still waits for the resume rule under the usage-capped reason.
  const blockReason = (entry, nowMs) => capped(entry) ? 'usage-capped'
    : entry.upstreamBlocked ? 'upstream-blocked'
      : entry.resumePending ? 'usage-capped'
        : reserved(entry) && !assured(entry, nowMs) ? 'usage-unknown-reserved'
          : httpMode && !surveyed(entry, nowMs) ? 'usage-unknown' : null;
  const excluded = (entry, nowMs) => blockReason(entry, nowMs) !== null;
  const clearMisses = entry => { for (const cap of Object.values(entry.windowCaps ?? {})) cap.missing = 0; };
  // Every stop opens a new epoch. A read that began in an older one describes the
  // world before that stop and never counts as a recovery vote, however late it lands.
  // The epoch, not `stoppedAt`, decides: a stop and a read can share a millisecond.
  // A new stop also restarts every miss count.
  const stop = (entry, nowMs) => {
    entry.stopEpoch = (entry.stopEpoch ?? 0) + 1;
    entry.stoppedAt = nowMs;
    delete entry.cleanReads;
    clearMisses(entry);
  };
  // 新しい窓の停止は、その窓について完全な GET が届けたリセット時刻を、まだ先の時刻なら引き継ぐ。
  const latch = (entry, window, nowMs) => {
    entry.windowCaps ??= {};
    entry.windowCaps[window.key] ??= { missing: 0,
      ...(window.confirmedResetAt > nowMs ? { resetAt: window.confirmedResetAt } : {}) };
    entry.cappedSince ??= nowMs;
  };
  const release = entry => {
    delete entry.windowCaps; delete entry.cappedSince; delete entry.upstreamBlocked;
    delete entry.cleanReads; delete entry.stoppedAt; delete entry.resumePending;
    improved();
  };
  // 上流から消えた窓の停止を外してよいか。条件の1つ目: その窓の停止に記録したリセット時刻（windowCaps[鍵].resetAt。
  // 使用量の GET の完全な観測が届けた未来の時刻だけで入れ替え、ほかの観測では消さない）を過ぎている。
  // 条件の2つ目: その値が一度も入らなかったときだけ、停止（今の停止世代の始まり）から noResetProbeMs が過ぎている
  // （0 なら外さない）。どちらも、欠落の連続回数の条件（呼び出し側）と併せて初めて成り立つ。
  const lapsed = (entry, cap, nowMs) => (Number.isFinite(cap.resetAt) ? nowMs >= cap.resetAt
    : noResetProbeMs > 0 && Number.isFinite(entry.stoppedAt) && nowMs - entry.stoppedAt >= noResetProbeMs);
  // 停止した窓の鍵ごとの欠落の連続回数。今の停止世代で始まった、allowed が読めた完全な GET に、その鍵に
  // 照合できる窓が無ければ1つ増やす。その窓が載った回（使用率によらない）と、数えられない観測（不完全・
  // 別の停止世代・応答ヘッダ）では0に戻す。2回以上続き、かつ lapsed() なら、その鍵の停止と保存した観測の
  // 両方を消す（configure() が古い観測で掛け直さないため）。外した窓の出来事を返す。
  function countMisses(entry, applied, countable, nowMs) {
    const present = new Set(applied.map(window => window.key));
    const events = [];
    for (const [windowKey, cap] of Object.entries(entry.windowCaps ?? {})) {
      if (present.has(windowKey) || !countable) { cap.missing = 0; continue; }
      cap.missing++;
      const window = entry.windows?.[windowKey];
      if (cap.missing < MISSES_TO_DROP || !lapsed(entry, cap, nowMs)) continue;
      delete entry.windowCaps[windowKey];
      delete entry.windows?.[windowKey];
      if (window && entry.positions?.[window.position] === windowKey) delete entry.positions[window.position];
      events.push({ type: WINDOW_CAP_DROPPED, window: windowKey, position: window?.position,
        ...(window?.windowDurationMins !== undefined ? { windowMinutes: window.windowDurationMins } : {}), at: nowMs });
    }
    // 窓の停止が残らなくても、口座の停止は復帰の規則で解けるまで残す。
    if (events.length && !capped(entry)) { delete entry.windowCaps; entry.resumePending = true; }
    return events;
  }
  // 停止中の口座への試し打ち（生成を1回だけ送って停止を確かめる経路）は無い。停止が解けるのは
  // observe() の復帰の規則（完全な観測の2回連続、方針を持たない口座は窓ごとに位置ごとの共通のしきい値（Legacy global thresholds）を下回る観測の1回、上流の
  // 拒否は方針の有無によらず allowed:true の完全な観測の2回連続）だけ。窓の停止
  // だけは、上流から消えた窓について countMisses() が外す（口座の停止は復帰の規則で解くまで残る）。
  let accounts = new Map();
  const sticky = new Map();
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
        ...(prior?.authReason !== undefined ? { authReason: prior.authReason } : {}),
        ...(prior?.windows ? { windows: copyEach(prior.windows) } : {}),
        ...(prior?.positions ? { positions: { ...prior.positions } } : {}),
        // A usage stop survives identity promotion; it is about the upstream account.
        ...(prior?.windowCaps ? { windowCaps: copyEach(prior.windowCaps) } : {}),
        ...(prior?.resumePending !== undefined ? { resumePending: prior.resumePending } : {}),
        ...(prior?.cappedSince !== undefined ? { cappedSince: prior.cappedSince } : {}),
        ...(prior?.upstreamBlocked !== undefined ? { upstreamBlocked: prior.upstreamBlocked } : {}),
        ...(prior?.stoppedAt !== undefined ? { stoppedAt: prior.stoppedAt } : {}),
        ...(prior?.stopEpoch !== undefined ? { stopEpoch: prior.stopEpoch } : {}),
        ...(prior?.usageGetAt !== undefined ? { usageGetAt: prior.usageGetAt } : {}),
        ...(prior?.usageAllowedAt !== undefined ? { usageAllowedAt: prior.usageAllowedAt } : {}),
        ...(prior?.observationSequence !== undefined ? { observationSequence: prior.observationSequence } : {}) });
      if (prior && entry.previousKey) promoted.set(entry.previousKey, entry.key);
    }
    accounts = next;
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
        // A dropped window left no stored reading behind, so nothing latches it again here.
        let latched = false;
        for (const window of Object.values(entry.windows ?? {})) {
          if (window.usedPercent < stopOf(entry, window.position)) continue;
          latch(entry, window, nowMs);
          latched = true;
        }
        // Either way the reload restarts the vote run and every miss count.
        if (latched) stop(entry, nowMs);
        else { delete entry.cleanReads; clearMisses(entry); }
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
          fresh: Object.fromEntries(POSITIONS.map(position => [position, fresh(entry, windowAt(entry, position), nowMs) === true])),
          // The freshness actually applied to this account: the http ceiling (two polls plus
          // one read deadline, capped by the TTL) under http, the TTL under passive. A broken
          // usage read never changes it; the pool is not told about degradation at all.
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
    // Returns what happened beyond the latch itself: the windows whose stop was dropped
    // because they vanished from the upstream (see countMisses()). Empty otherwise.
    observe(key, observation, nowMs, meta = {}) {
      time(nowMs);
      const entry = accounts.get(key);
      if (!entry || !observation) return [];
      // `stopEpoch` is the epoch the reader held when the GET began (snapshot().stopEpoch).
      const { source = 'response-header', complete = false, ordinaryUsageAllowed, sequence, stopEpoch } = meta;
      if (meta.generation !== undefined && meta.generation !== generation) return [];
      if (Number.isFinite(sequence)) {
        if (sequence <= (entry.observationSequence ?? -Infinity)) return [];
        entry.observationSequence = sequence;
      }
      const applied = [];
      const confirmed = new Set(); // 窓の鍵: この観測が、外す判定に使うリセット時刻を届けた窓
      for (const position of POSITIONS) {
        const usedPercent = observation[`${position}_used_percent`];
        if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) continue;
        const minutes = observation[`${position}_window_minutes`];
        const windowDurationMins = Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
        const windowKey = windowKeyOf(position, windowDurationMins);
        const prior = entry.windows?.[windowKey];
        if (prior?.observedAt > nowMs) continue;
        // A rolling window's duration is not evidence of its reset time.
        const resetAt = observation[`${position}_reset_at`];
        // Only advertise a reset representable as an RFC3339 timestamp.
        const representable = Number.isSafeInteger(resetAt) && resetAt >= 0 && resetAt <= MAX_TIMESTAMP_MS;
        // Only a complete GET may date the reset a window stop is dropped at, and only with a
        // future instant. A reading without one, an incomplete one or a header keeps the last.
        const confirms = source === 'usage-get' && complete === true && representable && resetAt > nowMs;
        if (confirms) confirmed.add(windowKey);
        entry.windows ??= {};
        entry.windows[windowKey] = { key: windowKey, position, usedPercent, observedAt: nowMs, source,
          ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
          ...(representable ? { resetAt } : {}),
          ...(confirms ? { confirmedResetAt: resetAt }
            : prior?.confirmedResetAt !== undefined ? { confirmedResetAt: prior.confirmedResetAt } : {}) };
        entry.positions ??= {};
        entry.positions[position] = windowKey;
        applied.push(entry.windows[windowKey]);
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
      // Either source alone stops the account, at or above the threshold of the position
      // the window was reported at. The stop is recorded under the window's key.
      let latched = false;
      for (const window of applied) {
        if (window.usedPercent < stopOf(entry, window.position)) continue;
        latch(entry, window, nowMs);
        latched = true;
      }
      if (latched) stop(entry, nowMs);
      for (const windowKey of confirmed) {
        const cap = entry.windowCaps?.[windowKey];
        if (cap) cap.resetAt = entry.windows[windowKey].confirmedResetAt;
      }
      // Only a read that names the epoch it began in can be placed after the stop that
      // closed it -- including the stop this very call latched, which already advanced it.
      // snapshot() always hands the reader a number, so a missing or mismatched epoch is
      // an unplaceable read: evidence for stopping above, never a vote for recovery.
      const current = Number.isFinite(stopEpoch) && stopEpoch === (entry.stopEpoch ?? 0);
      const events = countMisses(entry, applied, current && source === 'usage-get' && complete === true
        && typeof ordinaryUsageAllowed === 'boolean' && applied.length > 0, nowMs);
      const policy = policyOf(entry);
      if (!policy) {
        // Legacy global thresholds keep their single-observation release per window: a
        // reading below the threshold of its position lifts the stop of that window's key.
        for (const window of applied) {
          if (window.usedPercent >= thresholds[window.position] || !entry.windowCaps?.[window.key]) continue;
          delete entry.windowCaps[window.key];
          if (capped(entry)) continue;
          delete entry.windowCaps;
          // An upstream refusal still holds the account; releasing it here would erase the refusal too.
          if (!entry.upstreamBlocked) release(entry);
        }
        // A refusal clears by the same rule as under a policy: two complete allowed GETs of
        // this stop epoch in a row. The account is then released unless a window stop remains,
        // which keeps waiting for its own single-observation release above.
        const allowedGet = source === 'usage-get' && complete === true && ordinaryUsageAllowed === true && current
          && applied.length > 0;
        if (!allowedGet) delete entry.cleanReads;
        else entry.cleanReads = [...(entry.cleanReads ?? []), []].slice(-RESUME_CONFIRMATIONS);
        if (entry.upstreamBlocked && votes(entry) >= RESUME_CONFIRMATIONS) {
          delete entry.upstreamBlocked;
          if (!capped(entry)) release(entry);
        }
        // With no window stop left and no refusal, nothing else holds a legacy account.
        if (entry.resumePending && !capped(entry) && !entry.upstreamBlocked) release(entry);
        return events;
      }
      // Recovery needs, twice in a row, a complete allowed GET of this stop epoch with every
      // window it carries at or below resume and every stopped window among them (votes()).
      const clean = source === 'usage-get' && complete === true && ordinaryUsageAllowed === true && current
        && applied.length > 0 && applied.every(window => window.usedPercent <= policy.resumeUsedPercent);
      if (!clean) { delete entry.cleanReads; return events; }
      const present = new Set(applied.map(window => window.key));
      const lacking = Object.keys(entry.windowCaps ?? {}).filter(windowKey => !present.has(windowKey));
      entry.cleanReads = [...(entry.cleanReads ?? []), lacking].slice(-RESUME_CONFIRMATIONS);
      if (votes(entry) >= RESUME_CONFIRMATIONS && stopped(entry)) release(entry);
      return events;
    },
    // A read that produced no observation (timeout, 5xx, unparsable body, unreadable
    // credentials) is evidence of nothing -- but it does break the run of complete
    // readings recovery requires, so a success/failure/success sequence must not recover.
    // It breaks every run of misses the same way.
    observationFailed(key) {
      const entry = accounts.get(key);
      if (!entry) return;
      delete entry.cleanReads;
      clearMisses(entry);
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
    // 使用量の GET が 2xx で返った（この口座のトークンを上流が受け付けた）ときの遷移。
    // unknown・credentials-unavailable・needs-login・probing の口座を ready へ移す。証明するのは
    // 認証だけで、使用量の停止は解かない（解くのは observe() の復帰の規則だけ）。ログイン切れと
    // 決めた時刻以前に始まった GET は、その決定を覆さない。
    usageConfirmed(key, nowMs, startedAtMs = nowMs) {
      time(nowMs);
      time(startedAtMs);
      const entry = accounts.get(key);
      if (!entry || (entry.forbiddenAt !== undefined && startedAtMs <= entry.forbiddenAt)) return;
      if (entry.state === 'exhausted' && entry.retryAt > nowMs) return;
      const before = entry.state;
      entry.state = 'ready';
      delete entry.forbiddenAt;
      delete entry.recheckAt;
      delete entry.seenMtime;
      delete entry.authReason;
      delete entry.resetAt;
      delete entry.retryAt;
      entry.updatedAt = nowMs;
      if (before !== 'ready') improved();
    },
    // ログイン切れ（needs-login）へ移す遷移。理由は auth-tracker.js の規則が決めた3つだけ:
    // upstream-unauthorized（GET の 401 が続いた）・upstream-forbidden（GET の 403 が続き、他の口座の
    // 成功で裏付けた）・access-token-expired（手元の時計で access token の期限が過ぎていた）。
    // seenMtime はその時点の資格情報ファイルの更新時刻で、再確認の時期の判断に使う。
    usageAuthRejected(key, nowMs, { reason, seenMtime = null } = {}) {
      time(nowMs);
      if (!USAGE_AUTH_REJECTION_REASONS.includes(reason)) throw new TypeError('known auth rejection reason required');
      const entry = accounts.get(key);
      if (!entry) return;
      entry.state = 'needs-login';
      entry.authReason = reason;
      entry.forbiddenAt = Math.max(entry.forbiddenAt ?? nowMs, nowMs);
      entry.seenMtime = seenMtime;
      entry.recheckAt = nowMs + needsLoginRecheckMs;
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
    // 最後の手段。select() が1つも選べなかったときだけ呼ぶ。使用量が分からない口座のうち、
    // (i) 停止していない（窓の停止も上流の拒否も、窓の停止を外した後の復帰待ちも無い）、(ii) blockWhenUnknown が付いていない、
    // (iii) 使える状態（ready）である、の3つを満たす口座を、設定の並び順で1つ返す。無ければ null。
    // 停止中の口座は選ばない（試し打ちはしない）。使用量が分かっていて選べない口座も選ばない。
    lastResort(model, nowMs) {
      time(nowMs);
      const entry = [...accounts.values()].find(a => a.state === 'ready' && assigned(a, model)
        && !stopped(a) && !reserved(a) && blockReason(a, nowMs) === 'usage-unknown');
      return entry ? copy(entry) : null;
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
