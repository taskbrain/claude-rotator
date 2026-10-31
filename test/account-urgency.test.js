import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { isUserTurnBoundary } from '../src/account-urgency.js';

const HOUR = 3_600_000;

function setup(mode = 'shadow') {
  const clock = { ms: Date.parse('2026-10-29T07:30:00Z') };
  const logs = [];
  const manager = new AccountManager({
    accounts: ['soon', 'later', 'near-cap'].map(id => ({ id, type: 'oauth' })),
    accountUrgency: { mode },
    now: () => clock.ms,
    logger: line => logs.push(line),
  });
  function usage(id, weekly, hours, fiveHour = 0.2) {
    manager.applyUsage(id, {
      five_hour: { utilization: fiveHour, resets_at: new Date(clock.ms + HOUR).toISOString() },
      seven_day: { utilization: weekly, resets_at: new Date(clock.ms + hours * HOUR).toISOString() },
    });
  }
  usage('soon', 0.57, 4.5, 0.7);
  usage('later', 0.58, 32, 0.1);
  usage('near-cap', 0.92, 8, 0.1);
  return { manager, clock, logs, usage };
}

describe('account urgency scheduling', () => {
  it('shadow preserves the old assignment and threshold, but records the urgent alternative', () => {
    const { manager, logs } = setup();
    const before = manager.exportState();
    assert.equal(manager.selectForNewAssignment().id, 'later');
    assert.equal(manager.switchThreshold, 1);
    const section = manager.getStatus().accountUrgency;
    assert.equal(section.mode, 'shadow');
    const decision = section.decisions.at(-1);
    assert.equal(decision.actualAccountId, 'later');
    assert.equal(decision.proposedAccountId, 'soon');
    assert.equal(decision.reason, 'required-pace');
    assert.ok(Math.abs(section.accounts[0].requiredPace - 0.4 / 4.5) < 1e-10);
    assert.deepEqual(manager.exportState(), before);
    assert.ok(logs.some(line => line.includes('account_urgency ')));
  });

  it('off and invalid modes preserve routing and omit all additional status/logs', () => {
    for (const mode of ['off', 'SHADOW', true, 1]) {
      const { manager, logs } = setup(mode);
      assert.equal(manager.selectForNewAssignment().id, 'later');
      assert.equal('accountUrgency' in manager.getStatus(), false);
      assert.equal(logs.some(line => line.includes('account_urgency')), false);
    }
  });

  it('on ranks required pace without the 90% gate and stops at 97%', () => {
    const { manager, usage } = setup('on');
    usage('near-cap', 0.92, 0.1);
    assert.equal(manager.selectForNewAssignment().id, 'near-cap');
    assert.equal(manager.switchThreshold, 0.97);
    usage('near-cap', 0.97, 0.1);
    assert.equal(manager.selectForNewAssignment().id, 'soon');
    usage('soon', 0.57, 4.5, 0.97);
    assert.equal(manager.selectForNewAssignment().id, 'later');
    usage('later', 0.97, 32);
    assert.equal(manager.selectForNewAssignment(), null, 'the 97% line is never dropped');
  });

  it('uses stale evidence for recovery but excludes unknown, expired and partial observations', () => {
    const { manager, clock, usage } = setup('on');
    clock.ms += 31 * 60_000;
    assert.equal(manager.selectForNewAssignment()?.id, 'soon');
    assert.equal(manager.getStatus().accountUrgency.accounts[0].recoveryOnly, true);
    usage('later', 0.58, 32);
    assert.equal(manager.selectForNewAssignment().id, 'later');
    manager.markError('soon', 'fixture_error', 'fixture unavailable');
    manager.markError('near-cap', 'fixture_error', 'fixture unavailable');
    manager.applyUsage('later', { seven_day: { utilization: 0.1, resets_at: null } });
    assert.equal(manager.selectForNewAssignment(), null);
    usage('later', 0.58, 0);
    assert.equal(manager.selectForNewAssignment(), null);
    manager.applyUsage('later', { seven_day: { resets_at: new Date(clock.ms + HOUR).toISOString() } });
    assert.equal(manager.selectForNewAssignment(), null, 'a reset alone cannot revive old utilization');
    usage('later', 0.01, 168);
    assert.equal(manager.selectForNewAssignment().id, 'later');
  });

  it('keeps model caps, temporary errors and exclusions in force', () => {
    const { manager, usage } = setup('on');
    manager.applyUsage('soon', { scoped_weekly: [{ key: 'fable', utilization: 1, resets_at: new Date(manager.now() + HOUR).toISOString() }] });
    assert.notEqual(manager.selectForNewAssignment({ modelFamily: 'fable' })?.id, 'soon');
    assert.equal(manager.selectForNewAssignment({ excludeAccountIds: ['soon'] }).id, 'later');
    usage('later', 0.58, 32);
    manager.find('soon').status = 'error';
    assert.equal(manager.selectForNewAssignment().id, 'later');
  });

  it('derives forecasts from a same-window history and records notification drafts without sending', () => {
    const { manager, clock, usage } = setup();
    const sent = [];
    manager.setUrgencyNotifier(notice => sent.push(notice));
    assert.equal(manager.getStatus().accountUrgency.accounts[0].predictedUnusedFraction, null);
    clock.ms += 15 * 60_000;
    usage('soon', 0.58, 4.25, 0.71);
    const section = manager.getStatus().accountUrgency;
    assert.ok(Math.abs(section.accounts[0].observedPace - 0.04) < 1e-10);
    assert.ok(Math.abs(section.accounts[0].predictedUnusedFraction - 0.25) < 1e-10);
    assert.equal(section.notifications.length, 1);
    assert.equal(section.notifications[0].delivery, 'shadow-draft');
    assert.equal(sent.length, 0);
    usage('soon', 0.58, 4.25, 0.71);
    assert.equal(manager.getStatus().accountUrgency.notifications.length, 1);
  });

  it('requires risk, a turn boundary, no in-flight request and a one-hour binding before moving', () => {
    const { manager, clock, usage } = setup('on');
    clock.ms += 15 * 60_000;
    usage('soon', 0.58, 4.25, 0.71);
    usage('later', 0.59, 31.75, 0.11);
    const base = { bound: manager.find('later'), boundAt: clock.ms - HOUR, turnBoundary: true, inFlight: false };
    assert.equal(manager.planUrgencyReassignment(base)?.id, 'soon');
    assert.equal(manager.planUrgencyReassignment({ ...base, turnBoundary: false }), null);
    assert.equal(manager.planUrgencyReassignment({ ...base, inFlight: true }), null);
    assert.equal(manager.planUrgencyReassignment({ ...base, boundAt: clock.ms - HOUR + 1 }), null);
    usage('soon', 0.8, 4.25, 0.72);
    assert.equal(manager.planUrgencyReassignment(base), null, 'no move when consumption can finish the allowance');
  });

  it('shadow records a would-move decision but never returns a replacement', () => {
    const { manager, clock, usage } = setup();
    clock.ms += 15 * 60_000;
    usage('soon', 0.58, 4.25, 0.71);
    usage('later', 0.59, 31.75, 0.11);
    assert.equal(manager.planUrgencyReassignment({
      bound: manager.find('later'), boundAt: clock.ms - HOUR, turnBoundary: true, inFlight: false,
    }), null);
    const decision = manager.getStatus().accountUrgency.decisions.at(-1);
    assert.equal(decision.reason, 'unused-before-reset');
    assert.equal(decision.wouldReassign, true);
    assert.equal(decision.actualAccountId, 'later');
    assert.equal(decision.proposedAccountId, 'soon');
  });

  it('status reads do not create decisions, send notifications or inflate histories', () => {
    const { manager } = setup();
    manager.selectForNewAssignment();
    const before = manager.getStatus().accountUrgency;
    for (let i = 0; i < 75; i++) manager.newAssignmentOrder();
    const after = manager.getStatus().accountUrgency;
    assert.deepEqual(after.decisions, before.decisions);
    assert.deepEqual(after.notifications, before.notifications);
    for (let i = 0; i < 75; i++) manager.selectForNewAssignment();
    assert.equal(manager.getStatus().accountUrgency.decisions.length, 50);
  });

  it('on queues one notification per reset and reports queue failure honestly', () => {
    const { manager, clock, usage } = setup('on');
    const notices = [];
    manager.setUrgencyNotifier(notice => { notices.push(notice); return true; });
    clock.ms += 15 * 60_000;
    usage('soon', 0.58, 4.25, 0.71);
    usage('soon', 0.58, 4.25, 0.71);
    assert.equal(notices.length, 1);
    assert.equal(manager.getStatus().accountUrgency.notifications[0].delivery, 'queued');
    assert.match(notices[0].key, /^[a-f0-9]{64}$/);
    assert.equal(notices[0].text.includes('account=soon'), false, 'the webhook never receives the full identity');
    assert.equal(manager.getStatus().accountUrgency.reassignments.length, 0);
  });

  it('does not renew the weekly reading from five-hour-only updates or restored state', () => {
    const { manager, clock } = setup('on');
    const saved = manager.exportState();
    clock.ms += 31 * 60_000;
    manager.updateQuota('soon', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': String((clock.ms + HOUR) / 1000),
    });
    assert.equal(manager.selectForNewAssignment()?.id, 'soon');
    assert.equal(manager.getStatus().accountUrgency.accounts[0].weekly.fresh, false);
    const restored = new AccountManager({ accounts: [{ id: 'soon' }], accountUrgency: { mode: 'on' }, now: () => clock.ms });
    restored.restoreState(saved);
    assert.equal(restored.selectForNewAssignment()?.id, 'soon');
    assert.equal(restored.getStatus().accountUrgency.accounts[0].weekly.fresh, false);
  });

  it('clears forecasts after a lower corrected utilization, reset change or identity change', () => {
    const { manager, clock, usage } = setup('on');
    clock.ms += 15 * 60_000;
    usage('soon', 0.58, 4.25);
    assert.notEqual(manager.getStatus().accountUrgency.accounts[0].observedPace, null);
    usage('soon', 0.55, 4.25);
    assert.equal(manager.getStatus().accountUrgency.accounts[0].observedPace, null);
    manager.replaceAccounts([{ id: 'soon', type: 'oauth', accountUuid: 'new-identity' }]);
    assert.equal(manager.selectForNewAssignment(), null);
  });

  it('recognizes new user turns but rejects tool continuations and unknown bodies', () => {
    for (const content of ['hello', [{ type: 'text', text: 'hello' }], [{ type: 'image' }]]) {
      assert.equal(isUserTurnBoundary(Buffer.from(JSON.stringify({ messages: [{ role: 'user', content }] }))), true);
    }
    for (const body of [null, 'bad-json', {}, { messages: [{ role: 'assistant', content: 'continue' }] },
      { messages: [{ role: 'user', content: [{ type: 'tool_result' }, { type: 'text' }] }] }]) {
      assert.equal(isUserTurnBoundary(body), false);
    }
  });

  it('does not turn a one-minute measurement into a fifteen-minute history by waiting', () => {
    const { manager, clock, usage } = setup('on');
    clock.ms += 60_000;
    usage('soon', 0.571, 4.5 - 1 / 60);
    clock.ms += 15 * 60_000;
    const row = manager.getStatus().accountUrgency.accounts[0];
    assert.equal(row.observedPace, null);
    assert.equal(row.unusedRisk, false);
  });

  it('never reports a reserved three points after observed usage has already passed 97%', () => {
    const { manager, clock, usage } = setup();
    clock.ms += 15 * 60_000;
    usage('near-cap', 0.99, 7.75);
    let row = manager.getStatus().accountUrgency.accounts.find(account => account.accountId === 'near-cap');
    assert.ok(Math.abs(row.predictedUnusedFraction - 0.01) < 1e-10);
    clock.ms += 15 * 60_000;
    usage('near-cap', 1.01, 7.5);
    row = manager.getStatus().accountUrgency.accounts.find(account => account.accountId === 'near-cap');
    assert.equal(row.predictedUnusedFraction, 0);
  });

  it('offers the current proposed order without repeating full metrics in status history', () => {
    const { manager } = setup();
    for (let i = 0; i < 60; i++) manager.selectForNewAssignment();
    const section = manager.getStatus().accountUrgency;
    assert.deepEqual(section.proposedOrder, ['soon', 'later', 'near-cap']);
    assert.equal('metrics' in section.decisions[0], false);
    assert.ok(section.decisions.at(-1).proposedRequiredPace > section.decisions.at(-1).actualRequiredPace);
    assert.ok(Buffer.byteLength(JSON.stringify(section)) < 32_768);
    const many = new AccountManager({
      accounts: Array.from({ length: 16 }, (_, i) => ({ id: `sample-${i}` })),
      accountUrgency: { mode: 'shadow' }, now: () => manager.now(),
    });
    for (const account of many.accounts) many.applyUsage(account.id, {
      five_hour: { utilization: 0.2, resets_at: new Date(manager.now() + HOUR).toISOString() },
      seven_day: { utilization: 0.5, resets_at: new Date(manager.now() + 8 * HOUR).toISOString() },
    });
    for (let i = 0; i < 50; i++) many.selectForNewAssignment();
    assert.ok(Buffer.byteLength(JSON.stringify(many.getStatus().accountUrgency)) < 40_000);
  });
});
