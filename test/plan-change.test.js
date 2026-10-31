import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { parseRateLimitHeaders } from '../src/quota.js';
import { renderStatus } from '../src/monitor.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
function setup(mode = 'on') {
  const clock = { ms: START };
  const manager = new AccountManager({
    accounts: [{ id: 'sample-a' }, { id: 'sample-b' }],
    planQuota: { mode }, switchThreshold: 0.97, now: () => clock.ms,
  });
  const week = utilization => ({ utilization, resets_at: new Date(START + 24 * HOUR).toISOString() });
  return { manager, clock, week };
}

describe('optional five-hour windows', () => {
  it('does not shorten a retained cycle from a reset-only header or incomplete usage update', () => {
    const { manager, clock, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
    } });
    manager.updateQuota('sample-a', { 'anthropic-ratelimit-unified-5h-reset': String((START + 60_000) / 1000) });
    manager.applyUsage('sample-a', { five_hour: { resets_at: new Date(START + 60_000).toISOString() } });
    clock.ms += 60_000;
    assert.equal(manager.isAvailable(manager.find('sample-a')), false);
    assert.equal(manager.find('sample-a').quota.unified5hReset, START + HOUR);
  });

  it('requires valid weekly evidence and can recover stale new and keyless assignments', () => {
    const { manager, clock, week } = setup();
    assert.equal(manager.getActiveAccount(), null);
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: null });
    assert.equal(manager.getActiveAccount()?.id, 'sample-a');
    clock.ms += 31 * 60_000;
    assert.equal(manager.selectForNewAssignment()?.id, 'sample-a');
    assert.equal(manager.getActiveAccount()?.id, 'sample-a');
    assert.equal(manager.hasFreshWeeklyQuota(manager.find('sample-a')), false);
    manager.applyUsage('sample-a', { seven_day: { utilization: 0.3, resets_at: null } });
    assert.equal(manager.selectForNewAssignment(), null);
  });

  it('keeps extended Fable identities out of the legacy off and shadow routing decision', () => {
    for (const mode of ['off', 'shadow']) {
      const { manager, week } = setup(mode);
      manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
        utilization: 0.2, resets_at: new Date(START + HOUR).toISOString(),
      }, scoped_weekly: [{ key: 'fable_5_1', label: 'fable_5_1', ...week(0.99) }] });
      assert.equal(manager.isAvailable(manager.find('sample-a'), 'fable'), true);
      assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' })?.id, 'sample-a');
    }
  });

  it('does not demote an unreported five-hour window behind an equally used weekly account', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3) });
    manager.applyUsage('sample-b', { seven_day: week(0.3), five_hour: {
      utilization: 0.1, resets_at: new Date(START + HOUR).toISOString(),
    } });
    assert.equal(manager.selectForNewAssignment().id, 'sample-a');
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    assert.equal(manager.switchTargetScore(manager.find('sample-a')).fiveHourUtilization, null,
      'a neutral score must not expose unknown five-hour usage as zero');
    const five = manager.getStatus().quotaWindows.accounts[0].windows.find(w => w.id === '5h');
    assert.equal(five.applicability, 'unknown');
    assert.equal(five.observationState, 'missing');
    assert.equal(five.usedFraction, null);
  });

  it('keeps a prior high five-hour reading on null, and releases the old cycle at its reset', () => {
    const { manager, clock, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.99, resets_at: new Date(START + 10 * 60_000).toISOString(),
    } });
    manager.applyUsage('sample-a', { seven_day: week(0.31), five_hour: null });
    assert.equal(manager.find('sample-a').quota.unified5h, 0.99);
    assert.equal(manager.isAvailable(manager.find('sample-a')), false);
    let five = manager.getStatus().quotaWindows.accounts[0].windows.find(w => w.id === '5h');
    assert.equal(five.applicability, 'unknown');
    assert.equal(five.observationState, 'explicit_null');
    assert.equal(five.retainedConstraint, true);
    clock.ms += 10 * 60_000;
    assert.equal(manager.isAvailable(manager.find('sample-a')), true);
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    manager.applyUsage('sample-a', { seven_day: week(0.32) });
    assert.equal(manager.selectForNewAssignment().id, 'sample-a');
    manager.applyUsage('sample-a', { seven_day: week(0.33), five_hour: {
      utilization: 0.98, resets_at: new Date(clock.ms + HOUR).toISOString(),
    } });
    assert.equal(manager.isAvailable(manager.find('sample-a')), false);
  });

  it('uses the weekly headroom before five-hour load and keeps Fable caps scoped', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.2), five_hour: {
      utilization: 0.8, resets_at: new Date(START + HOUR).toISOString(),
    }, scoped_weekly: [{ key: 'fable', label: 'Fable', ...week(0.98) }] });
    manager.applyUsage('sample-b', { seven_day: week(0.6), five_hour: {
      utilization: 0.1, resets_at: new Date(START + HOUR).toISOString(),
    } });
    assert.equal(manager.selectForNewAssignment().id, 'sample-a');
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }).id, 'sample-b');
  });

  it('shadow keeps the legacy ledger and selection unchanged', () => {
    const a = setup('shadow');
    const b = setup('off');
    for (const { manager, week } of [a, b]) {
      manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
        utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
      } });
      manager.applyUsage('sample-a', { seven_day: week(0.31), five_hour: null });
      manager.applyUsage('sample-b', { seven_day: week(0.4), five_hour: {
        utilization: 0.2, resets_at: new Date(START + HOUR).toISOString(),
      } });
    }
    const shadowState = a.manager.exportState();
    assert.ok(shadowState.accounts.every(account => Object.hasOwn(account, 'windowObservations')));
    assert.deepEqual({
      ...shadowState,
      accounts: shadowState.accounts.map(({ windowObservations: _observations, ...account }) => account),
    }, b.manager.exportState());
    assert.equal(a.manager.selectForNewAssignment().id, b.manager.selectForNewAssignment().id);
    assert.equal(a.manager.getStatus().quotaWindows.mode, 'shadow');
  });

  it('renders unknown five-hour observations without a zero-percent or no-data claim', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: null });
    const text = renderStatus(manager.getStatus(), { now: START });
    assert.match(text, /5h.*unknown.*explicit_null/);
    assert.doesNotMatch(text.split('\n').filter(line => line.includes('5h')).join('\n'), /0%|no data yet/);
  });

  it('retains a five-hour blocker through save and restore without making it fresh', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
    } });
    manager.applyUsage('sample-a', { seven_day: week(0.31), five_hour: null });
    const restored = setup().manager;
    restored.restoreState(manager.exportState());
    assert.equal(restored.isAvailable(restored.find('sample-a')), false);
    const five = restored.getStatus().quotaWindows.accounts[0].windows.find(w => w.id === '5h');
    assert.equal(five.applicability, 'unknown');
    assert.equal(five.observationState, 'explicit_null');
  });

  it('reports an expired observed cycle even after the live ledger clears its numeric fields', () => {
    const { manager, clock, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: {
      utilization: 0.4, resets_at: new Date(START + 60_000).toISOString(),
    } });
    clock.ms += 60_000;
    const five = manager.getStatus().quotaWindows.accounts[0].windows.find(w => w.id === '5h');
    assert.equal(five.observationState, 'expired');
    assert.equal(five.usedFraction, null);
  });

  it('observes new scoped headers in shadow without applying them to the legacy ledger', () => {
    const { manager } = setup('shadow');
    manager.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
      'anthropic-ratelimit-unified-7d-reset': String((START + HOUR) / 1000),
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
    });
    assert.deepEqual(manager.find('sample-a').quota.weeklyScoped, []);
    assert.equal(manager.isAvailable(manager.find('sample-a'), 'fable'), true);
    const scope = manager.getStatus().quotaWindows.accounts[0].windows.find(w => w.id === '7d_fable');
    assert.equal(scope.usedFraction, 0.99);
    assert.equal(scope.scope, 'fable');
  });

  it('removes an obsolete scoped display row only from a complete scoped snapshot', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), scoped_weekly: [
      { key: 'fable', label: 'Fable', ...week(0.3) },
    ] });
    manager.applyUsage('sample-a', { seven_day: week(0.31), scoped_weekly: [] });
    const windows = manager.getStatus().quotaWindows.accounts[0].windows;
    assert.equal(windows.some(window => window.id === '7d_fable'), false);
  });
});

describe('variable weekly response windows', () => {
  it('applies versioned Fable scope identifiers without a fixed version list', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), five_hour: null });
    manager.updateQuota('sample-a', {
      'anthropic-ratelimit-unified-7d-fable-5-1-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-5-1-reset': String((START + HOUR) / 1000),
    });
    assert.equal(manager.isAvailable(manager.find('sample-a'), 'fable'), false);
    assert.equal(manager.isAvailable(manager.find('sample-a')), true);
  });

  it('discovers weekly scope identifiers while keeping grace and overage out of ordinary windows', () => {
    const parsed = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.98',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
      'anthropic-ratelimit-unified-7d-research-utilization': '0.2',
      'anthropic-ratelimit-unified-grace-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-overage-utilization': '0.9',
    }, { includeScopedWindows: true });
    assert.deepEqual(parsed.weeklyScoped.map(w => w.key), ['fable', 'research']);
    assert.equal(parsed.weeklyScoped[0].utilization, 0.98);
    assert.equal(parsed.weeklyScoped[0].resetAt, START + HOUR);
  });

  it('bounds accumulated window identifiers without discarding an active Fable stop', () => {
    const { manager, week } = setup();
    manager.applyUsage('sample-a', { seven_day: week(0.3), scoped_weekly: [
      { key: 'fable', label: 'Fable', ...week(0.99) },
    ] });
    for (let i = 0; i < 40; i++) manager.updateQuota('sample-a', {
      [`anthropic-ratelimit-unified-7d-scope${i}-utilization`]: '0.1',
      [`anthropic-ratelimit-unified-7d-scope${i}-reset`]: String((START + HOUR) / 1000),
    });
    assert.ok(manager.getStatus().quotaWindows.accounts[0].windows.length <= 18);
    assert.ok(manager.find('sample-a').quota.weeklyScoped.length <= 16);
    assert.equal(manager.isAvailable(manager.find('sample-a'), 'fable'), false);
  });
});
