import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;
function setup(mode = 'on', policy = 'plan', id = 'sample-a', switchThreshold = 1) {
  const clock = { ms: START };
  const accounts = [{ id, type: 'apikey', credentialRevision: 1 }];
  const manager = new AccountManager({ accounts, now: () => clock.ms, switchThreshold,
    planQuota: { mode: policy === 'plan' ? mode : 'off' },
    accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
  });
  return { manager, clock, accounts };
}
const bucket = (used, at) => ({ utilization: used, resets_at: new Date(at).toISOString() });

describe('retained scoped limits during quota recovery', () => {
  const futureReset = START + HOUR;
  const fableHeaders = used => ({
    'anthropic-ratelimit-unified-7d-fable-utilization': String(used),
    'anthropic-ratelimit-unified-7d-fable-reset': String(futureReset / 1000),
  });
  const incompleteUpdates = [
    ['utilization only', { 'anthropic-ratelimit-unified-7d-fable-utilization': '0.1' }],
    ['null reset', { ...fableHeaders(0.1), 'anthropic-ratelimit-unified-7d-fable-reset': null }],
    ['invalid reset', { ...fableHeaders(0.1), 'anthropic-ratelimit-unified-7d-fable-reset': 'invalid-fixture' }],
    ['expired reset', { ...fableHeaders(0.1), 'anthropic-ratelimit-unified-7d-fable-reset': String((START - 1000) / 1000) }],
    ['null utilization', { ...fableHeaders(0.1), 'anthropic-ratelimit-unified-7d-fable-utilization': null }],
    ['invalid utilization', { ...fableHeaders(0.1), 'anthropic-ratelimit-unified-7d-fable-utilization': 'invalid-fixture' }],
    ['reset only', { 'anthropic-ratelimit-unified-7d-fable-reset': String(futureReset / 1000) }],
  ];

  for (const policy of ['plan', 'urgency']) {
    for (const [name, headers] of incompleteUpdates) {
      it(`keeps a Fable 99 percent stop after ${name} with no common week (${policy})`, () => {
        const { manager, clock } = setup('on', policy);
        manager.setQuotaRecoveryPersistence(true, false);
        manager.updateQuota('sample-a', fableHeaders(0.99));
        clock.ms += 1000;
        manager.updateQuota('sample-a', headers, { recoveryStatus: 200 });

        const account = manager.find('sample-a');
        assert.equal(account.quota.unified7d, null);
        assert.equal(account.quota.weeklyScoped.find(limit => limit.key === 'fable')?.utilization, 0.99);
        assert.equal(account.quota.weeklyScoped.find(limit => limit.key === 'fable')?.resetAt, futureReset);
        assert.equal(account.windowObservations['7d_fable'].lastKnown.usedFraction, 0.99);
        assert.equal(account.windowObservations['7d_fable'].lastKnown.observedAt, START);
        assert.equal(manager.quotaRecoveryEligible(account, 'fable'), false);
        assert.equal(manager.reserveQuotaRecovery('fable'), null);
        assert.equal(manager.exportState().quotaRecovery.accounts.length, 0);
      });
    }

    it(`checks retained Fable evidence before admitting a missing common week (${policy})`, () => {
      const { manager } = setup('on', policy);
      manager.setQuotaRecoveryPersistence(true, false);
      manager.updateQuota('sample-a', fableHeaders(0.99));
      const account = manager.find('sample-a');
      // 現在のscoped値が欠け、観測履歴だけが残る入力状態を作る。
      account.quota.weeklyScoped = [];
      assert.equal(account.quota.unified7d, null);
      assert.equal(account.windowObservations['7d_fable'].lastKnown.usedFraction, 0.99);
      assert.equal(account.windowObservations['7d_fable'].lastKnown.resetAt, futureReset);

      assert.equal(manager.quotaRecoveryEligible(account, 'fable'), false);
      assert.equal(manager.reserveQuotaRecovery('fable'), null);
      assert.equal(manager.exportState().quotaRecovery.accounts.length, 0);
      assert.ok(manager.reserveQuotaRecovery(null), 'a Fable-only stop must still allow other models');
    });

    for (const transition of ['mode change', 'restart']) {
      it(`keeps a shadow Fable stop after ${transition} and an incomplete update (${policy})`, () => {
        const shadow = setup('shadow', policy);
        shadow.manager.updateQuota('sample-a', fableHeaders(0.99));
        assert.deepEqual(shadow.manager.find('sample-a').quota.weeklyScoped, []);

        let active;
        if (transition === 'restart') {
          const saved = shadow.manager.exportState();
          active = setup('on', policy);
          active.clock.ms += 31 * 60_000;
          active.manager.restoreState(saved);
        } else {
          active = shadow;
          active.clock.ms += 31 * 60_000;
          active.manager.configureAccountUrgency({ mode: policy === 'urgency' ? 'on' : 'off' });
          active.manager.configurePlanQuota({ mode: policy === 'plan' ? 'on' : 'off' });
        }
        active.manager.setQuotaRecoveryPersistence(true, false);
        active.manager.updateQuota('sample-a', {
          'anthropic-ratelimit-unified-7d-fable-utilization': '0.1',
        }, { recoveryStatus: 200 });

        const account = active.manager.find('sample-a');
        assert.equal(account.windowObservations['7d_fable'].lastKnown.observedAt, START);
        assert.equal(active.manager.quotaRecoveryEligible(account, 'fable'), false);
        assert.equal(active.manager.reserveQuotaRecovery('fable'), null);
        assert.equal(active.manager.exportState().quotaRecovery.accounts.length, 0);
      });
    }

    for (const [threshold, used, allowed] of [
      [1, 0.969, true],
      [1, 0.97, false],
      [0.9, 0.899, true],
      [0.9, 0.9, false],
    ]) {
      it(`rechecks the stop after a valid Fable update to ${used} with threshold ${threshold} (${policy})`, () => {
        const { manager } = setup('on', policy, 'sample-a', threshold);
        manager.setQuotaRecoveryPersistence(true, false);
        manager.updateQuota('sample-a', fableHeaders(0.99));
        manager.updateQuota('sample-a', fableHeaders(used), { recoveryStatus: 200 });

        const account = manager.find('sample-a');
        assert.equal(account.windowObservations['7d_fable'].lastKnown.usedFraction, used);
        assert.equal(manager.quotaRecoveryEligible(account, 'fable'), allowed);
        assert.equal(manager.reserveQuotaRecovery('fable') !== null, allowed);
      });
    }

    for (const field of ['five_hour', 'seven_day']) {
      it(`does not release a ${field} stop when the Fable window is updated (${policy})`, () => {
        const { manager } = setup('on', policy);
        manager.setQuotaRecoveryPersistence(true, false);
        manager.applyUsage('sample-a', { [field]: bucket(0.97, futureReset) });
        manager.updateQuota('sample-a', fableHeaders(0.99));
        manager.updateQuota('sample-a', fableHeaders(0.1), { recoveryStatus: 200 });

        assert.equal(manager.quotaRecoveryEligible(manager.find('sample-a'), 'fable'), false);
        assert.equal(manager.reserveQuotaRecovery('fable'), null);
        assert.equal(manager.exportState().quotaRecovery.accounts.length, 0);
      });
    }

    it(`allows recovery after the retained Fable reset has passed (${policy})`, () => {
      const { manager, clock } = setup('on', policy);
      manager.setQuotaRecoveryPersistence(true, false);
      manager.updateQuota('sample-a', fableHeaders(0.99));
      clock.ms = futureReset;

      assert.equal(manager.quotaRecoveryEligible(manager.find('sample-a'), 'fable'), true);
      assert.ok(manager.reserveQuotaRecovery('fable'));
    });
  }
});

describe('recovery admission after a clock rollback', () => {
  for (const policy of ['plan', 'urgency']) {
    it(`resumes bounded recovery after the wall clock catches up (${policy})`, () => {
      const { manager, clock } = setup('on', policy);
      manager.setQuotaRecoveryPersistence(true, false);
      const first = manager.reserveQuotaRecovery();
      assert.ok(first);
      assert.equal(manager.settleQuotaRecovery(first, { result: 'no-quota' }), true);
      clock.ms--;
      assert.equal(manager.reserveQuotaRecovery(), null);
      clock.ms = START + 15 * 60_000 - 1;
      assert.equal(manager.reserveQuotaRecovery(), null);
      clock.ms++;
      const second = manager.reserveQuotaRecovery();
      assert.ok(second);
      assert.equal(manager.settleQuotaRecovery(second, { result: 'no-quota' }), true);
      clock.ms = START + 30 * 60_000;
      assert.equal(manager.reserveQuotaRecovery(), null);
      clock.ms = START + HOUR - 1;
      assert.equal(manager.reserveQuotaRecovery(), null);
      clock.ms++;
      assert.ok(manager.reserveQuotaRecovery());
      assert.equal(manager.exportState().quotaRecovery.sequence, 3);
    });
  }
});

describe('restored recovery outcome holds', () => {
  for (const [name, planMode, urgencyMode] of [
    ['off', 'off', 'off'],
    ['plan shadow', 'shadow', 'off'],
    ['urgency shadow', 'off', 'shadow'],
  ]) {
    it(`preserves recovery snapshot bytes and ordinary selection after pending restore in ${name}`, () => {
      const first = setup();
      first.manager.setQuotaRecoveryPersistence(true, false);
      assert.ok(first.manager.reserveQuotaRecovery());
      const accounts = [...first.accounts, { id: 'sample-b', type: 'apikey', credentialRevision: 1 }];
      first.manager.replaceAccounts(accounts);
      first.manager.applyUsage('sample-b', { seven_day: bucket(0.2, START + 24 * HOUR) });
      const saved = first.manager.exportState();
      const restoredAt = START + 5 * 60_000;
      const restored = new AccountManager({ accounts, now: () => restoredAt,
        planQuota: { mode: planMode }, accountUrgency: { mode: urgencyMode },
      });
      restored.restoreState(saved);
      const expected = {
        ...saved.quotaRecovery, lastSeenAt: restoredAt, pending: null,
        accounts: saved.quotaRecovery.accounts.map(account => ({ ...account, lastResult: 'interrupted', unresolved: true })),
      };
      assert.equal(JSON.stringify(restored.exportState().quotaRecovery), JSON.stringify(expected));
      assert.equal(Object.hasOwn(restored.getStatus(), 'quotaRecovery'), false);
      assert.equal(restored.reserveQuotaRecovery(), null);
      assert.equal(restored.selectForNewAssignment()?.id, 'sample-b');
      assert.equal(JSON.stringify(restored.exportState().quotaRecovery), JSON.stringify(expected));
    });
  }

  for (const policy of ['plan', 'urgency']) {
    for (const elapsed of [15 * 60_000, HOUR]) {
      for (const fresh of [false, true]) {
        it(`keeps a pending account unavailable after ${elapsed}ms with fresh observation=${fresh} (${policy})`, () => {
          const first = setup('on', policy);
          first.manager.setQuotaRecoveryPersistence(true, false);
          assert.ok(first.manager.reserveQuotaRecovery());
          const saved = first.manager.exportState();
          const restored = setup('on', policy);
          restored.clock.ms += elapsed;
          restored.manager.restoreState(saved);
          restored.manager.setQuotaRecoveryPersistence(true, false);
          if (fresh) restored.manager.applyUsage('sample-a', { seven_day: bucket(0.2, START + 24 * HOUR) });

          assert.equal(restored.manager.isAvailable(restored.manager.find('sample-a')), false);
          assert.equal(restored.manager.selectForNewAssignment(), null);
          assert.equal(restored.manager.reserveQuotaRecovery(), null);
          assert.equal(restored.manager.exportState().quotaRecovery.sequence, 1);
          assert.deepEqual(restored.manager.exportState().quotaRecovery.accounts[0].starts, [START]);

          const again = setup('on', policy);
          again.clock.ms += elapsed + 1;
          again.manager.restoreState(restored.manager.exportState());
          again.manager.setQuotaRecoveryPersistence(true, false);
          assert.equal(again.manager.isAvailable(again.manager.find('sample-a')), false);
          assert.equal(again.manager.selectForNewAssignment(), null);
          assert.equal(again.manager.reserveQuotaRecovery(), null);
        });
      }
    }

    it(`keeps an unresolved restored outcome held through mode changes (${policy})`, () => {
      const first = setup('on', policy);
      first.manager.setQuotaRecoveryPersistence(true, false);
      assert.ok(first.manager.reserveQuotaRecovery());
      const restored = setup('on', policy);
      restored.clock.ms += HOUR;
      restored.manager.restoreState(first.manager.exportState());
      restored.manager.configureAccountUrgency({ mode: 'off' });
      restored.manager.configurePlanQuota({ mode: 'off' });
      restored.manager.applyUsage('sample-a', { seven_day: bucket(0.2, START + 24 * HOUR) });

      assert.equal(restored.manager.isAvailable(restored.manager.find('sample-a')), false);
      assert.equal(restored.manager.selectForNewAssignment(), null);
      assert.equal(restored.manager.exportState().quotaRecovery.sequence, 1);
      restored.manager.configureAccountUrgency({ mode: policy === 'urgency' ? 'on' : 'off' });
      restored.manager.configurePlanQuota({ mode: policy === 'plan' ? 'on' : 'off' });
      restored.manager.setQuotaRecoveryPersistence(true, false);
      assert.equal(restored.manager.selectForNewAssignment(), null);
      assert.equal(restored.manager.reserveQuotaRecovery(), null);
    });

    it(`keeps another ordinary account available while a restored outcome is unknown (${policy})`, () => {
      const first = setup('on', policy);
      first.manager.setQuotaRecoveryPersistence(true, false);
      assert.ok(first.manager.reserveQuotaRecovery());
      const accounts = [...first.accounts, { id: 'sample-b', type: 'apikey', credentialRevision: 1 }];
      first.manager.replaceAccounts(accounts);
      first.manager.applyUsage('sample-b', { seven_day: bucket(0.2, START + 24 * HOUR) });
      const restored = new AccountManager({ accounts, now: () => START + HOUR,
        planQuota: { mode: policy === 'plan' ? 'on' : 'off' },
        accountUrgency: { mode: policy === 'urgency' ? 'on' : 'off' },
      });
      restored.restoreState(first.manager.exportState());
      restored.setQuotaRecoveryPersistence(true, false);

      assert.equal(restored.selectForNewAssignment()?.id, 'sample-b');
      assert.equal(restored.isAvailable(restored.find('sample-a')), false);
      assert.equal(restored.isAvailable(restored.find('sample-b')), true);
      assert.equal(restored.exportState().quotaRecovery.sequence, 1);
    });
  }
});

describe('quota recovery admission', () => {
  for (const policy of ['plan', 'urgency']) {
    it(`admits unknown windows only when there is no ordinary candidate (${policy})`, () => {
      const { manager, clock } = setup('on', policy);
      assert.equal(typeof manager.reserveQuotaRecovery, 'function');
      manager.setQuotaRecoveryPersistence(true, false);
      manager.applyUsage('sample-a', { seven_day: bucket(0.3, START + HOUR) });
      assert.equal(manager.reserveQuotaRecovery(), null);
      clock.ms += 31 * 60_000;
      assert.equal(manager.reserveQuotaRecovery(), null, 'valid stale observations remain ordinary recovery');
      clock.ms = START + HOUR;
      const probe = manager.reserveQuotaRecovery();
      assert.equal(probe?.account.id, 'sample-a');
      assert.equal(manager.find('sample-a').quota.unified7d, null);
      assert.equal(manager.quotaRecoveryStatus().inFlight, true);
      assert.equal(manager.reserveQuotaRecovery(), null);
    });

    it(`keeps all quota-recovery state out of off and shadow (${policy})`, () => {
      for (const mode of ['off', 'shadow']) {
        const { manager } = setup(mode, policy);
        manager.setQuotaRecoveryPersistence(true, true);
        assert.equal(manager.reserveQuotaRecovery(), null);
        assert.equal(Object.hasOwn(manager.getStatus(), 'quotaRecovery'), false);
        assert.equal(Object.hasOwn(manager.exportState(), 'quotaRecovery'), false);
      }
    });
  }

  for (const field of ['five_hour', 'seven_day']) {
    it(`never probes a known ${field} stop or an authentication error`, () => {
      const { manager } = setup();
      manager.setQuotaRecoveryPersistence(true, false);
      manager.applyUsage('sample-a', { [field]: bucket(0.97, START + HOUR) });
      assert.equal(manager.reserveQuotaRecovery(), null);
      manager.find('sample-a').quota.unified5h = null;
      manager.find('sample-a').quota.unified7d = null;
      manager.markError('sample-a', 'authentication_error', 'fixture rejection');
      assert.equal(manager.reserveQuotaRecovery(), null);
    });
  }

  it('scopes a known Fable stop and does not apply it to other models', () => {
    const { manager } = setup();
    manager.setQuotaRecoveryPersistence(true, true);
    manager.applyUsage('sample-a', { scoped_weekly: [{ key: 'fable', label: 'Fable', ...bucket(0.97, START + HOUR) }] });
    assert.equal(manager.reserveQuotaRecovery('fable'), null);
    assert.ok(manager.reserveQuotaRecovery(null));
  });

  it('spends pending reservations through restore and identity changes without storing raw labels', () => {
    const { manager, accounts, clock } = setup('on', 'plan', 'sample@example.invalid');
    manager.setQuotaRecoveryPersistence(true, false);
    const probe = manager.reserveQuotaRecovery();
    assert.ok(probe);
    const saved = manager.exportState();
    assert.equal(JSON.stringify(saved.quotaRecovery).includes(accounts[0].id), false);
    const restored = setup('on', 'plan', accounts[0].id).manager;
    restored.restoreState(saved);
    restored.setQuotaRecoveryPersistence(true, false);
    assert.equal(restored.reserveQuotaRecovery(), null);
    manager.replaceAccounts([{ ...accounts[0], credentialRevision: 2 }]);
    assert.equal(manager.isCurrentQuotaRecovery(probe), false);
    manager.settleQuotaRecovery(probe, { result: 'identity-changed' });
    assert.equal(manager.reserveQuotaRecovery(), null);
    clock.ms += 15 * 60_000;
    assert.ok(manager.reserveQuotaRecovery());
  });

  it('does not admit probes without a durable writer', () => {
    const { manager } = setup();
    assert.equal(manager.reserveQuotaRecovery(), null);
    assert.equal(manager.quotaRecoveryStatus().reason, 'persistence-unavailable');
  });

  it('keeps spent history through a disabled-policy restart without creating a key for never-enabled off', () => {
    const { manager } = setup();
    manager.setQuotaRecoveryPersistence(true, false);
    const probe = manager.reserveQuotaRecovery();
    manager.settleQuotaRecovery(probe, { result: 'no-quota' });
    manager.configurePlanQuota({ mode: 'off' });
    const saved = manager.exportState();
    assert.equal(saved.quotaRecovery.accounts[0].starts.length, 1);
    const off = setup('off').manager;
    off.restoreState(saved);
    assert.equal(Object.hasOwn(off.getStatus(), 'quotaRecovery'), false);
    assert.equal(off.exportState().quotaRecovery.accounts[0].starts.length, 1);
    off.configurePlanQuota({ mode: 'on' });
    off.setQuotaRecoveryPersistence(true, false);
    assert.equal(off.reserveQuotaRecovery(), null);
    assert.equal(Object.hasOwn(setup('off').manager.exportState(), 'quotaRecovery'), false);
  });

  it('retains an existing invalid budget as a fault instead of dropping it on an off save', () => {
    const off = setup('off').manager;
    off.restoreState({ accounts: [], quotaRecovery: { schemaVersion: 1, invalid: true } });
    assert.equal(off.exportState().quotaRecovery?.fault, 'invalid-state');
  });
});
