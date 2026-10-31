import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { restoreQuotaWindowObservations } from '../src/quota.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;
const future = String((START + HOUR) / 1000);
const make = (policy = 'plan', mode = 'off', at = START, switchThreshold = 1) => new AccountManager({
  accounts: [{ id: 'sample-a' }, { id: 'sample-b' }], now: () => at,
  switchThreshold,
  planQuota: { mode: policy === 'plan' ? mode : 'off' },
  accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
});

describe('default-off rate-limit compatibility', () => {
  for (const mode of ['off', 'shadow']) {
    for (const [name, headers, selected, used, resetAt] of [
      ['past reset', { 'anthropic-ratelimit-unified-5h-utilization': '0',
        'anthropic-ratelimit-unified-5h-reset': String((START - 1000) / 1000) }, 'sample-b', null, null],
      ['zero reset', { 'anthropic-ratelimit-unified-5h-utilization': '0',
        'anthropic-ratelimit-unified-5h-reset': '0' }, 'sample-a', 0, 0],
      ['utilization only', { 'anthropic-ratelimit-unified-5h-utilization': '0' }, 'sample-a', 0.1, START + HOUR],
      ['reset only', { 'anthropic-ratelimit-unified-5h-reset': '0' }, 'sample-a', 0.1, START + HOUR],
    ]) {
      it(`keeps the legacy 429 assignment and quota for ${name} in ${mode}`, () => {
        const manager = make('plan', mode);
        for (const [id, value] of [['sample-a', '0.1'], ['sample-b', '0.2']]) manager.updateQuota(id, {
          'anthropic-ratelimit-unified-5h-utilization': value,
          'anthropic-ratelimit-unified-5h-reset': future,
        });
        assert.equal(manager.selectForNewAssignment().id, 'sample-a');
        manager.updateQuota('sample-a', headers, { atomicUnifiedWindows: true });
        assert.equal(manager.selectForNewAssignment().id, selected);
        assert.equal(manager.find('sample-a').quota.unified5h, used);
        assert.equal(manager.find('sample-a').quota.unified5hReset, resetAt);
      });
    }
  }
});

describe('shadow observation persistence', () => {
  for (const policy of ['plan', 'urgency']) {
    it(`restores a shadow Fable stop before selecting an on-mode recovery account (${policy})`, () => {
      const shadow = make(policy, 'shadow', START, 0.97);
      shadow.updateQuota('sample-a', {
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
        'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
        'anthropic-ratelimit-unified-7d-fable-reset': String((START + 24 * HOUR) / 1000),
      });
      assert.deepEqual(shadow.find('sample-a').quota.weeklyScoped, []);
      const saved = shadow.exportState();
      assert.ok(saved.accounts[0].windowObservations, 'shadow observations must be persisted');
      assert.equal(saved.accounts[0].windowObservations['7d_fable'].lastKnown.usedFraction, 0.99);
      const restored = make(policy, 'on', START + 31 * 60_000, 0.97);
      restored.restoreState(saved);
      assert.equal(restored.selectForNewAssignment({ modelFamily: 'fable' }), null);
      assert.equal(restored.canRecoverWeeklyQuota(restored.find('sample-a'), 'fable'), false);
      assert.equal(restored.selectForNewAssignment()?.id, 'sample-a');
      assert.equal(restored.find('sample-a').windowObservations['7d_fable'].lastKnown.observedAt, START);
      restored.updateQuota('sample-a', {
        'anthropic-ratelimit-unified-7d-utilization': '0.31',
        'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
      });
      assert.equal(restored.canSendWithUrgency(restored.find('sample-a'), 'fable'), false);
    });
  }

  it('keeps observations through a shadow restart without changing the legacy quota', () => {
    const shadow = make('plan', 'shadow');
    shadow.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + 24 * HOUR) / 1000),
    });
    const saved = shadow.exportState();
    const restored = make('plan', 'shadow');
    restored.restoreState(saved);
    assert.deepEqual(restored.find('sample-a').windowObservations, saved.accounts[0].windowObservations);
    assert.deepEqual(restored.find('sample-a').quota, shadow.find('sample-a').quota);
  });

  it('omits the new observation state when both policies are off', () => {
    const off = make();
    off.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': future,
    });
    assert.equal(Object.hasOwn(off.exportState().accounts[0], 'windowObservations'), false);
  });
});

describe('persisted five-hour display', () => {
  for (const [state, fiveHour] of [
    ['missing', undefined],
    ['explicit_null', null],
    ['invalid', { utilization: '0', resets_at: new Date(START + HOUR).toISOString() }],
  ]) {
    it(`preserves a retained five-hour display after an urgency-only restart (${state})`, () => {
      const clock = { ms: START };
      const create = () => new AccountManager({ accounts: [{ id: 'sample-a' }],
        accountUrgency: { mode: 'on' }, now: () => clock.ms });
      const manager = create();
      const week = { utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString() };
      manager.applyUsage('sample-a', { seven_day: week, five_hour: {
        utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
      } });
      clock.ms += 60_000;
      manager.applyUsage('sample-a', { seven_day: week,
        ...(state === 'missing' ? {} : { five_hour: fiveHour }) });
      const before = manager.getStatus().accountUrgency.accounts[0].fiveHour;
      const known = { usedFraction: 0.99, resetAt: START + HOUR, observedAt: START };
      assert.equal(before.retainedConstraint, true);
      assert.deepEqual(before.lastKnown, known);
      assert.equal(manager.selectForNewAssignment(), null);

      const saved = JSON.parse(JSON.stringify(manager.exportState()));
      clock.ms += 60_000;
      const restarted = create();
      restarted.restoreState(saved);
      const persisted = restarted.exportState();
      const section = restarted.getStatus().accountUrgency;
      const five = section.accounts[0].fiveHour;
      assert.equal(five.retainedConstraint, true);
      assert.deepEqual(five.lastKnown, known);
      assert.equal(five.observedAt, START);
      assert.equal(five.reportedAt, START + 60_000);
      assert.equal(five.observationState, state);
      assert.equal(five.source, before.source);
      assert.equal(five.usedFraction, null);
      assert.equal(five.fresh, false);
      assert.equal(section.accounts[0].weekly.fresh, false);
      assert.equal(section.accounts[0].requiredPace, null);
      const displayWindow = section.accounts[0].windows.find(window => window.id === '5h');
      assert.equal(displayWindow.retainedConstraint, true);
      assert.deepEqual(displayWindow.lastKnown, known);
      assert.equal(displayWindow.observedAt, START);
      assert.deepEqual(restarted.exportState(), persisted, 'status must not turn saved values into new observations');
      assert.equal(restarted.urgencyRows()[0].fiveHour.retainedConstraint, false, 'policy metrics remain unrestored');
      assert.equal(restarted.canSendWithUrgency(restarted.find('sample-a')), false);
      assert.equal(restarted.selectForNewAssignment(), null);

      clock.ms = START + HOUR;
      assert.equal(restarted.getStatus().accountUrgency.accounts[0].fiveHour.retainedConstraint, false);
      assert.equal(restarted.getStatus().accountUrgency.accounts[0].fiveHour.lastKnown, null);
      assert.equal(restarted.selectForNewAssignment()?.id, 'sample-a');
    });
  }
});

describe('upstream short-term holds with scoped exhaustion', () => {
  for (const policy of ['plan', 'urgency']) {
    for (const mode of ['off', 'shadow', 'on']) {
      it(`honors a short-term hold only in on mode and releases it at its deadline (${policy}, ${mode})`, () => {
        const clock = { ms: START };
        const manager = new AccountManager({ accounts: [{ id: 'sample-a' }], now: () => clock.ms,
          planQuota: { mode: policy === 'plan' ? mode : 'off' },
          accountUrgency: { mode: policy === 'urgency' ? mode : 'off' } });
        manager.applyUsage('sample-a', {
          seven_day: { utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString() },
          scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1,
            resets_at: new Date(START + HOUR).toISOString() }],
        });
        const account = manager.find('sample-a');
        assert.equal(manager.isAvailable(account), true);
        manager.markRateLimited('sample-a', 60);
        assert.equal(manager.isAvailable(account), mode !== 'on');
        assert.equal(account.status, 'exhausted', 'a scope stop must not hide the upstream hold in on mode');
        assert.equal(manager.isAvailable(account, 'fable'), false);
        clock.ms += 59_999;
        assert.equal(manager.isAvailable(account), mode !== 'on');
        clock.ms++;
        assert.equal(manager.isAvailable(account), true);
        assert.equal(account.rateLimitedUntil, null);
        assert.equal(manager.isAvailable(account, 'fable'), false);
      });
    }
  }
});

describe('restored quota reset validation', () => {
  it('discards last-known windows with missing or non-finite resets', () => {
    for (const id of ['5h', '7d', '7d_fable']) {
      for (const resetAt of [null, undefined, NaN, Infinity, -Infinity, '2026-01-02T00:00:00Z']) {
        const observations = restoreQuotaWindowObservations({ [id]: {
          observationState: 'missing', observedAt: START + 60_000, source: 'header',
          lastKnown: { usedFraction: 0.99, resetAt, observedAt: START },
        } });
        assert.equal(observations[id].lastKnown, null, `${id}: ${String(resetAt)}`);
      }
    }
  });

  for (const policy of ['plan', 'urgency']) {
    it(`does not restore an unbounded five-hour stop from a corrupt saved state (${policy})`, () => {
      const original = make(policy, 'on');
      original.applyUsage('sample-a', { seven_day: {
        utilization: 0.3, resets_at: new Date(START + 24 * HOUR).toISOString(),
      } });
      const saved = JSON.parse(JSON.stringify(original.exportState()));
      saved.accounts[0].windowObservations['5h'] = {
        observationState: 'missing', observedAt: START, source: 'header',
        lastKnown: { usedFraction: 0.99, resetAt: null, observedAt: START },
      };
      const restored = make(policy, 'on');
      restored.restoreState(saved);
      assert.equal(restored.find('sample-a').windowObservations['5h'].lastKnown, null);
      assert.equal(restored.find('sample-a').quota.unified5h, null);
      assert.equal(restored.find('sample-a').quota.unified5hReset, null);
      assert.equal(restored.selectForNewAssignment()?.id, 'sample-a');
    });
  }

  it('does not write an unbounded five-hour observation back when enabling plan quota', () => {
    const manager = make('plan', 'shadow');
    manager.find('sample-a').windowObservations['5h'] = {
      observationState: 'missing', observedAt: START, source: 'header',
      lastKnown: { usedFraction: 0.99, resetAt: null, observedAt: START },
    };
    manager.configurePlanQuota({ mode: 'on' });
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    assert.equal(manager.find('sample-a').quota.unified5hReset, null);
  });
});
