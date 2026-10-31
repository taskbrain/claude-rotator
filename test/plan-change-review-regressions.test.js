import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
function setup(policy = 'plan', mode = 'on') {
  const clock = { ms: START };
  const manager = new AccountManager({
    accounts: [{ id: 'sample-a' }, { id: 'sample-b' }],
    planQuota: { mode: policy === 'plan' ? mode : 'off' },
    accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
    switchThreshold: 0.97, now: () => clock.ms,
  });
  const week = utilization => ({ utilization, resets_at: new Date(START + 24 * HOUR).toISOString() });
  return { manager, clock, week };
}

describe('review regressions: quota observations', () => {
  it('keeps the proposed 97 percent stops in shadow when the actual legacy threshold is higher', () => {
    for (const window of ['five_hour', 'seven_day']) {
      const clock = { ms: START };
      const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => clock.ms,
        accountUrgency: { mode: 'shadow' }, switchThreshold: 1 });
      manager.applyUsage('sample', {
        five_hour: { utilization: window === 'five_hour' ? 0.99 : 0.1, resets_at: new Date(START + HOUR).toISOString() },
        seven_day: { utilization: window === 'seven_day' ? 0.99 : 0.3, resets_at: new Date(START + 24 * HOUR).toISOString() },
      });
      clock.ms += 31 * 60_000;
      assert.equal(manager.getStatus().accountUrgency.accounts[0].eligible, false);
      assert.equal(manager.isAvailable(manager.find('sample')), true, 'shadow keeps the actual legacy threshold');
    }
  });

  for (const policy of ['plan', 'urgency']) {
    it(`retains a valid five-hour stop after invalid or absent header pairs (${policy})`, () => {
      for (const reset of ['0', String((START - 1000) / 1000), undefined]) {
        const { manager, week } = setup(policy);
        manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
          utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
        } });
        manager.updateQuota('sample-a', {
          'anthropic-ratelimit-unified-5h-utilization': '0',
          ...(reset === undefined ? {} : { 'anthropic-ratelimit-unified-5h-reset': reset }),
        });
        assert.equal(manager.find('sample-a').quota.unified5h, 0.99);
        assert.equal(manager.find('sample-a').quota.unified5hReset, START + HOUR);
        assert.equal(manager.selectForNewAssignment(), null);
        manager.updateQuota('sample-a', {
          'anthropic-ratelimit-unified-5h-utilization': '0',
          'anthropic-ratelimit-unified-5h-reset': String((START + HOUR) / 1000),
        });
        assert.equal(manager.selectForNewAssignment()?.id, 'sample-a', 'a valid new zero measurement is allowed');
      }
    });

    it(`uses stale but valid weekly observations for recovery and prefers a fresh candidate (${policy})`, () => {
      const { manager, clock, week } = setup(policy);
      manager.applyUsage('sample-a', { seven_day: week(0.2), five_hour: null });
      clock.ms += 31 * 60_000;
      assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
      assert.equal(manager.canSendWithUrgency(manager.find('sample-a')), true);
      manager.applyUsage('sample-b', { seven_day: week(0.7), five_hour: null });
      assert.equal(manager.selectForNewAssignment()?.id, 'sample-b', 'fresh evidence takes precedence over stale headroom');
      manager.applyUsage('sample-a', { seven_day: week(0.99), five_hour: null });
      clock.ms += 31 * 60_000;
      assert.equal(manager.canSendWithUrgency(manager.find('sample-a')), false, 'staleness never lifts a known stop');
      assert.equal(manager.selectForNewAssignment()?.id, 'sample-b');
    });

    it(`can recover after restoring an old weekly snapshot without treating it as fresh (${policy})`, () => {
      const original = setup(policy);
      original.manager.applyUsage('sample-a', { seven_day: original.week(0.3), five_hour: null });
      const saved = original.manager.exportState();
      const restored = setup(policy);
      restored.clock.ms += 31 * 60_000;
      restored.manager.restoreState(saved);
      assert.equal(restored.manager.selectForNewAssignment()?.id, 'sample-a');
      if (policy === 'urgency') {
        const row = restored.manager.getStatus().accountUrgency.accounts[0];
        assert.equal(row.weekly.fresh, false);
        assert.equal(row.recoveryOnly, true);
        assert.equal(row.unusedRisk, false);
      } else assert.equal(restored.manager.hasFreshWeeklyQuota(restored.manager.find('sample-a')), false);
    });

    it(`does not turn an explicitly unknown Fable week into a recovery candidate (${policy})`, () => {
      const { manager, clock, week } = setup(policy);
      manager.applyUsage('sample-a', { seven_day: week(0.3), scoped_weekly: [
        { key: 'fable', label: 'Fable', utilization: null, resets_at: null },
      ] });
      clock.ms += 31 * 60_000;
      assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }), null);
      assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    });
  }

  it('transfers shadow header Fable observations into on without refreshing their timestamps', () => {
    const { manager, clock } = setup('plan', 'shadow');
    manager.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
      'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + 24 * HOUR) / 1000),
    });
    assert.deepEqual(manager.find('sample-a').quota.weeklyScoped, []);
    clock.ms += 1000;
    manager.configurePlanQuota({ mode: 'on' });
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }), null);
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    const scoped = manager.getStatus().quotaWindows.accounts[0].windows.find(window => window.id === '7d_fable');
    assert.equal(scoped.observedAt, START);
    assert.equal(scoped.usedFraction, 0.99);
  });
});
