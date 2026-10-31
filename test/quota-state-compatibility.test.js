import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

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
