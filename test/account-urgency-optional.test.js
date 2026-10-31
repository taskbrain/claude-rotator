import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { parseUsageResponse } from '../src/oauth.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
function setup(mode = 'on') {
  const clock = { ms: START };
  const manager = new AccountManager({
    accounts: [{ id: 'sample-a' }, { id: 'sample-b' }],
    accountUrgency: { mode }, now: () => clock.ms,
  });
  const week = utilization => ({ utilization, resets_at: new Date(START + 24 * HOUR).toISOString() });
  return { manager, clock, week };
}
function row(manager, family = 'other') {
  const status = manager.getStatus().accountUrgency;
  return { ...status.accounts[0], ...status.byModelFamily[family].accounts[0] };
}

describe('urgency with optional five-hour windows', () => {
  it('releases an expired five-hour cycle before a direct new assignment without a status or poll', () => {
    const { manager, clock, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.99, resets_at: new Date(START + 60_000).toISOString(),
    } });
    clock.ms += 60_000;
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
  });

  it('retains a known Fable stop across a null report, and treats an initially null Fable week as unknown', () => {
    const { manager } = setup();
    const raw = fable => ({
      seven_day: { utilization: 30, resets_at: new Date(START + 24 * HOUR).toISOString() },
      seven_day_fable: fable,
    });
    manager.applyUsage('sample-a', parseUsageResponse(raw({
      utilization: 99, resets_at: new Date(START + HOUR).toISOString(),
    })));
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }), null);
    manager.applyUsage('sample-a', parseUsageResponse(raw(null)));
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }), null);
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    manager.applyUsage('sample-b', parseUsageResponse(raw(null)));
    assert.equal(manager.canSendWithUrgency(manager.find('sample-b'), 'fable'), false);
    assert.equal(manager.canSendWithUrgency(manager.find('sample-b')), true);
  });

  it('keeps a reported but unknown Fable scope after restore and a common-week-only observation', () => {
    const { manager } = setup();
    manager.applyUsage('sample-a', parseUsageResponse({
      seven_day: { utilization: 30, resets_at: new Date(START + HOUR).toISOString() }, seven_day_fable: null,
    }));
    const restored = setup().manager;
    restored.restoreState(manager.exportState());
    restored.applyUsage('sample-a', { seven_day: {
      utilization: 0.31, resets_at: new Date(START + HOUR).toISOString(),
    } });
    assert.equal(restored.selectForNewAssignment({ modelFamily: 'fable' }), null);
    assert.equal(restored.selectForNewAssignment()?.id, 'sample-a');
  });

  it('keeps account labels out of new scheduling logs', () => {
    const logs = [];
    const id = 'sample@example.invalid';
    const manager = new AccountManager({
      accounts: [{ id }], accountUrgency: { mode: 'on' }, now: () => START, logger: line => logs.push(line),
    });
    manager.applyUsage(id, { seven_day: { utilization: 0.3, resets_at: new Date(START + HOUR).toISOString() } });
    manager.selectForNewAssignment();
    const lines = logs.filter(line => line.includes('account_urgency'));
    assert.ok(lines.length > 0);
    assert.equal(lines.some(line => line.includes(id)), false);
    assert.match(lines.join(''), /"proposedAccount":"[a-f0-9]{12}"/);
  });

  it('preserves an explicitly stricter local stop threshold', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'sample' }], accountUrgency: { mode: 'on' }, switchThreshold: 0.9, now: () => START,
    });
    manager.applyUsage('sample', { seven_day: {
      utilization: 0.91, resets_at: new Date(START + HOUR).toISOString(),
    }, five_hour: null });
    assert.equal(manager.switchThreshold, 0.9);
    assert.equal(manager.selectForNewAssignment(), null);
  });

  it('selects a weekly-only account and reports unknown instead of a fictitious zero', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3) });
    const status = manager.getStatus();
    assert.ok(status.accountUrgency, 'the requested scheduler must be active');
    assert.equal(status.accountUrgency.schemaVersion, 2);
    assert.equal(row(manager).eligible, true);
    assert.equal(row(manager).fiveHour.applicability, 'unknown');
    assert.equal(row(manager).fiveHour.usedFraction, null);
    assert.equal(manager.selectForNewAssignment().id, 'sample-a');
  });

  it('handles missing, null, returning and expiring five-hour windows on the same account', () => {
    const { manager, clock, week } = setup();
    for (const usage of [
      { seven_day: week(0.3) },
      { seven_day: week(0.31), five_hour: null },
      { seven_day: week(0.32), five_hour: { utilization: 0.4, resets_at: new Date(START + 10 * 60_000).toISOString() } },
      { seven_day: week(0.33) },
      { seven_day: week(0.34), five_hour: null },
    ]) {
      manager.applyUsage('sample-a', usage);
      assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
      assert.equal(row(manager).exclusionReason, null);
    }
    manager.applyUsage('sample-a', { seven_day: week(0.35), five_hour: {
      utilization: 0.97, resets_at: new Date(START + 10 * 60_000).toISOString(),
    } });
    manager.applyUsage('sample-a', { seven_day: week(0.36), five_hour: null });
    assert.equal(manager.selectForNewAssignment(), null);
    assert.equal(row(manager).exclusionReason, 'five-hour-stop');
    clock.ms += 10 * 60_000;
    manager.applyUsage('sample-a', { seven_day: week(0.37), five_hour: null });
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    assert.equal(row(manager).fiveHour.usedFraction, null);
  });

  it('does not require five-hour freshness when weekly observations are fresh', () => {
    const { manager, clock, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.2, resets_at: new Date(START + HOUR).toISOString(),
    } });
    clock.ms += 31 * 60_000;
    manager.applyUsage('sample-a', { seven_day: week(0.4) });
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    assert.equal(row(manager).fiveHour.fresh, false);
    assert.equal(row(manager).exclusionReason, null);
    clock.ms += 31 * 60_000;
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a', 'a stale valid week permits recovery');
    assert.equal(row(manager).weekly.fresh, false);
    assert.equal(row(manager).recoveryOnly, true);
  });

  it('evaluates a Fable weekly cap only for Fable and never drops the 97 percent gate', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), scoped_weekly: [
      { key: 'claude_fable_5', label: 'Fable 5', ...week(0.97) },
    ] });
    manager.applyUsage('sample-b', { seven_day: week(0.96), five_hour: null });
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    assert.equal(row(manager, 'other').eligible, true);
    assert.equal(row(manager, 'fable').eligible, false);
    assert.equal(row(manager, 'fable').exclusionReason, 'scoped-weekly-stop');
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' })?.id, 'sample-b');
    manager.applyUsage('sample-b', { seven_day: week(0.97), five_hour: null });
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }), null);
    assert.equal(manager.canSendWithUrgency(manager.find('sample-a'), 'fable'), false);
    assert.equal(manager.canSendWithUrgency(manager.find('sample-a')), true);
  });

  it('does not make weekly-only candidates less urgent by inventing a five-hour tie-breaker', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: null });
    manager.applyUsage('sample-b', { seven_day: week(0.3), five_hour: {
      utilization: 0, resets_at: new Date(START + HOUR).toISOString(),
    } });
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
  });
});
