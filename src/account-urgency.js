import { createHash, randomUUID } from 'node:crypto';
import { boundWeeklyScopes, scopeMatchesModelFamily } from './quota.js';

const HOUR = 3_600_000;
const MAX_AGE = 30 * 60_000;
const MIN_HISTORY = 15 * 60_000;
const LIMIT = 50;
const LOG_REASONS = new Set(['required-pace', 'no-known-candidate', 'no-unused-risk', 'within-turn',
  'request-in-flight', 'binding-cooldown', 'current-unknown-or-unavailable', 'pace-hysteresis', 'unused-before-reset']);
const fingerprint = id => typeof id === 'string' ? createHash('sha256').update(id).digest('hex').slice(0, 12) : null;
export const URGENCY_THRESHOLD = 0.97;

export function urgencyMode(raw) {
  return ['off', 'shadow', 'on'].includes(raw?.mode) ? raw.mode : 'off';
}

// No I/O and no credentials. Observations must carry utilization AND reset in
// the same update. A shared ledger timestamp cannot establish window freshness.
export class AccountUrgency {
  constructor({ mode, now, logger }) {
    this.mode = mode;
    this.now = now;
    this.logger = logger;
    this.instanceId = randomUUID();
    this.sequence = 0;
    this.observations = new Map();
    this.decisions = [];
    this.reassignments = [];
    this.notifications = [];
    this.notified = new Map();
    this.notifier = null;
  }

  observe(id, fields, source = null) {
    const state = this.observations.get(id) || {};
    state.fiveHourReporting = !Object.hasOwn(fields, 'unified5h') ? 'missing'
      : fields.unified5h === null ? 'explicit_null'
        : Number.isFinite(fields.unified5h) && fields.unified5h >= 0
          && Number.isFinite(fields.unified5hReset) && fields.unified5hReset > this.now() ? 'value' : 'invalid';
    state.fiveHourReportedAt = this.now();
    state.fiveHourReportingSource = source;
    for (const [name, valueKey, resetKey] of [
      ['fiveHour', 'unified5h', 'unified5hReset'],
      ['weekly', 'unified7d', 'unified7dReset'],
    ]) {
      if (!(valueKey in fields) && !(resetKey in fields)) continue;
      const used = fields[valueKey];
      const resetAt = fields[resetKey];
      if (!Number.isFinite(used) || used < 0 || !Number.isFinite(resetAt) || resetAt <= this.now()) {
        // Missing/null/partial five-hour reports do not lift a positive
        // restriction that is still in its original cycle.
        if (name !== 'fiveHour' || !state[name] || state[name].resetAt <= this.now()) state[name] = null;
        continue;
      }
      const at = this.now();
      const previous = state[name];
      let samples = previous?.resetAt === resetAt && previous.observedAt <= at && used >= previous.usedFraction
        ? previous.samples.filter(sample => at - sample.at <= HOUR)
        : [];
      // Keep at most one sample per minute, plus the current reading below.
      if (!samples.length || at - samples.at(-1).at >= 60_000) samples = [...samples, { at, used }];
      state[name] = { usedFraction: used, resetAt, observedAt: at, source, samples: samples.slice(-61) };
    }
    if (Array.isArray(fields.weeklyScoped)) {
      const scoped = fields.scopedWeeklyPartial ? new Map(state.scopedWeekly || []) : new Map();
      for (const limit of fields.weeklyScoped) {
        const previous = new Map(state.scopedWeekly || []).get(limit.key);
        const valid = Number.isFinite(limit.utilization) && limit.utilization >= 0
          && Number.isFinite(limit.resetAt) && limit.resetAt > this.now();
        const at = this.now();
        if (!valid && previous && previous.resetAt > at) {
          scoped.set(limit.key, { ...previous, reportingValid: false,
            reportingState: limit.utilization === null ? 'explicit_null' : 'invalid', source });
          continue;
        }
        let samples = valid && previous?.resetAt === limit.resetAt && previous.observedAt <= at
          && limit.utilization >= previous.usedFraction ? previous.samples.filter(sample => at - sample.at <= HOUR) : [];
        if (valid && (!samples.length || at - samples.at(-1).at >= 60_000)) samples = [...samples, { at, used: limit.utilization }];
        scoped.set(limit.key, { ...limit,
          usedFraction: valid ? limit.utilization : null, resetAt: limit.resetAt,
          observedAt: at, source, samples: samples.slice(-61), reportingValid: valid,
          reportingState: valid ? 'value' : limit.utilization === null ? 'explicit_null' : 'invalid',
        });
      }
      state.scopedWeekly = boundWeeklyScopes([...scoped.values()]).map(limit => [limit.key, limit]);
    }
    this.observations.set(id, state);
  }

  prune(ids) {
    const valid = new Set(ids);
    for (const id of this.observations.keys()) {
      if (!valid.has(id)) {
        this.observations.delete(id);
        this.notified.delete(id);
      }
    }
  }

  window(observation, maxHorizon) {
    if (!observation) return {
      usedFraction: null, resetAt: null, observedAt: null, fresh: false, observedPace: null,
      predictedExhaustsAt: null, source: null, applicability: 'unknown', observationState: 'missing',
    };
    const { usedFraction, resetAt, observedAt, samples } = observation;
    const now = this.now();
    const fresh = observation.reportingValid !== false && Number.isFinite(usedFraction) && usedFraction >= 0
      && observedAt <= now && now - observedAt <= MAX_AGE
      && resetAt > now && resetAt - now <= maxHorizon;
    const anchor = fresh ? samples.find(sample => observedAt - sample.at >= MIN_HISTORY && observedAt - sample.at <= HOUR) : null;
    const observedPace = anchor && observedAt > anchor.at
      ? Math.max(0, (usedFraction - anchor.used) * HOUR / (observedAt - anchor.at)) : null;
    const exhaustsAt = usedFraction >= URGENCY_THRESHOLD ? now
      : observedPace > 0 ? observedAt + (URGENCY_THRESHOLD - usedFraction) / observedPace * HOUR : null;
    return {
      usedFraction, resetAt, observedAt, fresh, observedPace,
      source: observation.source, applicability: observation.reportingValid !== false && Number.isFinite(usedFraction) && resetAt > now ? 'present' : 'unknown',
      observationState: Number.isFinite(resetAt) && resetAt <= now ? 'expired'
        : observation.reportingState ?? (Number.isFinite(usedFraction) ? 'value' : 'invalid'),
      predictedExhaustsAt: fresh && exhaustsAt != null && exhaustsAt < resetAt ? Math.max(now, exhaustsAt) : null,
    };
  }

  metrics(id, unavailable = false, modelFamily = null, expectedScopes = []) {
    const state = this.observations.get(id);
    const weekly = this.window(state?.weekly, 168 * HOUR);
    const lastFive = this.window(state?.fiveHour, 5 * HOUR);
    const fiveActive = Number.isFinite(lastFive.usedFraction) && lastFive.resetAt > this.now();
    const fiveReported = fiveActive && state?.fiveHourReporting === 'value';
    const fiveHour = {
      ...lastFive, usedFraction: fiveReported ? lastFive.usedFraction : null,
      resetAt: fiveReported ? lastFive.resetAt : null,
      fresh: fiveReported && lastFive.fresh,
      source: state?.fiveHourReportingSource ?? null, reportedAt: state?.fiveHourReportedAt ?? null,
      applicability: fiveReported ? 'present' : 'unknown',
      observationState: state?.fiveHourReporting === 'value' && !fiveActive ? 'expired' : state?.fiveHourReporting ?? 'missing',
      retainedConstraint: fiveActive && !fiveReported,
      lastKnown: fiveActive && !fiveReported ? {
        usedFraction: lastFive.usedFraction, resetAt: lastFive.resetAt, observedAt: lastFive.observedAt,
      } : null,
    };
    const scopes = new Map(state?.scopedWeekly || []);
    for (const limit of expectedScopes) if (!scopes.has(limit.key)) scopes.set(limit.key, {
      key: limit.key, label: limit.label, usedFraction: null, resetAt: null, observedAt: null,
      samples: [], reportingValid: false, reportingState: 'missing',
    });
    const scopedWeekly = [...scopes].map(([, limit]) => {
      const window = this.window(limit, 168 * HOUR);
      const retained = limit.reportingValid === false && Number.isFinite(limit.usedFraction) && limit.resetAt > this.now();
      return {
        key: limit.key, label: limit.label,
        scope: scopeMatchesModelFamily(limit, 'fable', true) ? 'fable' : 'unknown', ...window,
        usedFraction: retained ? null : window.usedFraction, resetAt: retained ? null : window.resetAt,
        retainedConstraint: retained, lastKnown: retained ? {
          usedFraction: limit.usedFraction, resetAt: limit.resetAt, observedAt: limit.observedAt,
        } : null,
      };
    });
    const applicableScoped = scopedWeekly.filter(limit => scopeMatchesModelFamily(limit, modelFamily, true));
    const hoursLeft = weekly.fresh ? (weekly.resetAt - this.now()) / HOUR : null;
    const requiredPace = hoursLeft != null ? Math.max(0, URGENCY_THRESHOLD - weekly.usedFraction) / hoursLeft : null;
    const predictedUnusedFraction = weekly.observedPace != null
      ? Math.max(0, Math.min(1 - weekly.usedFraction,
        Math.max(1 - URGENCY_THRESHOLD, 1 - weekly.usedFraction - weekly.observedPace * (weekly.resetAt - weekly.observedAt) / HOUR))) : null;
    const reason = !weekly.fresh ? 'weekly-unknown-or-stale'
      : weekly.usedFraction >= URGENCY_THRESHOLD ? 'weekly-stop'
        : fiveActive && lastFive.usedFraction >= URGENCY_THRESHOLD ? 'five-hour-stop'
          : applicableScoped.some(limit => (limit.lastKnown?.usedFraction ?? limit.usedFraction) >= URGENCY_THRESHOLD
            && (limit.lastKnown?.resetAt ?? limit.resetAt) > this.now()) ? 'scoped-weekly-stop'
            : applicableScoped.some(limit => !limit.fresh) ? 'scoped-weekly-unknown-or-stale'
              : unavailable ? 'unavailable' : null;
    const firstExhausted = [weekly, ...(fiveActive ? [lastFive] : []), ...applicableScoped]
      .filter(window => window.predictedExhaustsAt != null)
      .sort((a, b) => a.predictedExhaustsAt - b.predictedExhaustsAt)[0];
    return {
      accountId: id, weekly, fiveHour, scopedWeekly, modelFamily: modelFamily || 'other',
      windows: [{ id: '7d', scope: 'all', ...weekly }, { id: '5h', scope: 'all', ...fiveHour },
        ...scopedWeekly.map(limit => ({ id: `7d_${limit.key}`, ...limit }))].map(window => ({
          id: window.id, scope: window.scope, applicability: window.applicability,
          observationState: window.observationState, usedFraction: window.usedFraction,
          resetAt: window.resetAt, observedAt: window.observedAt, source: window.source,
          ...(typeof window.retainedConstraint === 'boolean' ? { retainedConstraint: window.retainedConstraint, lastKnown: window.lastKnown } : {}),
        })),
      requiredPace, observedPace: weekly.observedPace,
      predictedUnusedFraction,
      predictedExhaustsAt: firstExhausted?.predictedExhaustsAt ?? null,
      predictedBlockedUntil: firstExhausted?.resetAt ?? null,
      eligible: reason === null, exclusionReason: reason,
      unusedRisk: reason === null && hoursLeft <= 12 && predictedUnusedFraction != null && predictedUnusedFraction >= 0.1,
    };
  }

  rank(rows, excluded = new Set()) {
    return rows.filter(row => row.eligible && !excluded.has(row.accountId)).sort((a, b) => (
      Number(a.recoveryOnly === true) - Number(b.recoveryOnly === true)
      || b.requiredPace - a.requiredPace || a.weekly.resetAt - b.weekly.resetAt
      || a.accountId.localeCompare(b.accountId)
    ));
  }

  record(kind, data) {
    const sequence = ++this.sequence;
    const actual = data.metrics?.find(row => row.accountId === data.actualAccountId);
    const proposed = data.metrics?.find(row => row.accountId === data.proposedAccountId);
    const comparison = kind === 'decisions' ? {
      actualRequiredPace: actual?.requiredPace ?? null,
      proposedRequiredPace: proposed?.requiredPace ?? null,
    } : {};
    const event = { eventId: `${this.instanceId}:${sequence}`, sequence, at: this.now(), kind, mode: this.mode, ...data, ...comparison };
    const history = this[kind];
    history.push(event);
    if (history.length > LIMIT) history.shift();
    const logEvent = {
      at: event.at, sequence, mode: this.mode, kind,
      reason: LOG_REASONS.has(event.reason) ? event.reason : 'unknown',
      actualAccount: fingerprint(event.actualAccountId), proposedAccount: fingerprint(event.proposedAccountId),
      fromAccount: fingerprint(event.fromAccountId), toAccount: fingerprint(event.toAccountId),
      account: fingerprint(event.accountId),
      actualRequiredPace: event.actualRequiredPace ?? null, proposedRequiredPace: event.proposedRequiredPace ?? null,
      wouldReassign: event.wouldReassign === true,
    };
    try { this.logger?.(`${new Date(event.at).toISOString()} account_urgency ${JSON.stringify(logEvent)}`); } catch {}
    return event;
  }

  checkRisks(rows) {
    for (const row of rows) {
      if (!row.unusedRisk || this.notified.get(row.accountId) === row.weekly.resetAt) continue;
      this.notified.set(row.accountId, row.weekly.resetAt);
      const dedupeKey = createHash('sha256').update(`${row.accountId}:${row.weekly.resetAt}`).digest('hex');
      // The existing notice channel only accepts bounded printable ASCII.
      const accountHash = createHash('sha256').update(row.accountId).digest('hex').slice(0, 12);
      const text = `claude-rotator: weekly unused risk ${Math.round(row.predictedUnusedFraction * 100)}pt; reset ${new Date(row.weekly.resetAt).toISOString()}; move at next eligible user turn. account=${accountHash}`;
      let delivery = 'shadow-draft';
      if (this.mode === 'on') {
        try {
          delivery = this.notifier?.({ kind: 'weekly-unused', key: dedupeKey, text }) === true ? 'queued' : 'not-queued';
        } catch { delivery = 'not-queued'; }
      }
      this.record('notifications', { accountId: row.accountId, resetAt: row.weekly.resetAt, dedupeKey, text, delivery });
    }
  }

  status(rows, fableRows = rows) {
    const familyStatus = accounts => ({
      accounts: accounts.map(({ accountId, eligible, exclusionReason, predictedExhaustsAt, predictedBlockedUntil, recoveryOnly }) => ({
        accountId, eligible, exclusionReason, predictedExhaustsAt, predictedBlockedUntil, recoveryOnly,
      })),
      proposedOrder: this.rank(accounts).map(row => row.accountId),
    });
    return {
      schemaVersion: 2, mode: this.mode, activationBlock: this.activationBlock ?? null,
      instanceId: this.instanceId, sequence: this.sequence,
      generatedAt: this.now(), threshold: URGENCY_THRESHOLD, paceUnit: 'fraction-per-hour', historyLimit: LIMIT,
      maxObservationAgeMs: MAX_AGE, minHistoryMs: MIN_HISTORY, accounts: rows,
      proposedOrder: this.rank(rows).map(row => row.accountId),
      byModelFamily: {
        other: familyStatus(rows),
        fable: familyStatus(fableRows),
      },
      // History carries decisions only. Repeating every account's metrics for
      // every decision makes a frequently polled status unnecessarily large.
      decisions: this.decisions.map(({ metrics: _metrics, ...event }) => structuredClone(event)),
      reassignments: this.reassignments.map(event => structuredClone(event)),
      notifications: this.notifications.map(event => structuredClone(event)),
    };
  }
}

// A tool-result continuation is part of the same turn. Unknown body shapes do
// not authorize a proactive move. No body text is retained or logged.
export function isUserTurnBoundary(body) {
  try {
    const parsed = Buffer.isBuffer(body) || typeof body === 'string' ? JSON.parse(body.toString()) : body;
    const last = parsed?.messages?.at(-1);
    if (last?.role !== 'user') return false;
    if (typeof last.content === 'string') return last.content.length > 0;
    return Array.isArray(last.content) && last.content.length > 0
      && last.content.every(block => ['text', 'image', 'document'].includes(block?.type));
  } catch { return false; }
}
