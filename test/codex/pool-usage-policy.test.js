import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';

const entries = [{ key: 'pro-a', models: ['astra'] }, { key: 'pro-b', models: ['astra'] }];
function fixture(config) {
  const pool = createCodexAccountPool(entries, config);
  for (const a of entries) pool.credentials(a.key, true, 0);
  return pool;
}
for (const dimension of ['primary', 'secondary']) {
  test(`pool: ${dimension} 95.0 excludes, 95.0 does not recover, 94.9 recovers`, () => {
    const pool = fixture();
    pool.observe('pro-a', { [`${dimension}_used_percent`]: 95 }, 10);
    assert.equal(pool.select('astra', 10).key, 'pro-b');
    pool.observe('pro-a', { [`${dimension}_used_percent`]: 95 }, 20);
    assert.equal(pool.select('astra', 20).key, 'pro-b');
    pool.observe('pro-a', { [`${dimension}_used_percent`]: 94.9 }, 30);
    assert.equal(pool.select('astra', 30).key, 'pro-a');
    assert.equal(pool.snapshot()[0].state, 'ready');
  });
}
test('pool: unobserved is eligible, fresh ready precedes unknown, TTL expiry latches instead of zeroing usage', () => {
  const pool = fixture();
  assert.equal(pool.select('astra', 0).key, 'pro-a');
  pool.observe('pro-b', { primary_used_percent: 94.9 }, 10);
  assert.equal(pool.select('astra', 10).key, 'pro-b');
  pool.observe('pro-a', { primary_used_percent: 95 }, 10);
  assert.equal(pool.select('astra', 60009).key, 'pro-b');
  // An expired observation is unknown usage, never zero: the stop stays latched
  // and pro-b (stale but never stopped) keeps the traffic.
  assert.equal(pool.select('astra', 60010).key, 'pro-b');
  assert.equal(pool.snapshot()[0].observation.primary.usedPercent, 95);
  assert.equal(pool.snapshot()[0].capped.primary, true);
});
test('pool: exclusion is separate from confirmed exhaustion and its reset never unlatches it', () => {
  const pool = fixture();
  pool.observe('pro-a', { primary_used_percent: 95, primary_reset_at: 30100 }, 100);
  pool.observe('pro-b', { secondary_used_percent: 99, secondary_reset_at: 15100 }, 100);
  assert.equal(pool.select('astra', 101), null);
  const terminal = pool.terminal('astra', 101);
  assert.equal(terminal.status, 529);
  assert.equal(terminal.type, 'overloaded_error');
  assert.equal(terminal.reason, 'codex_pool_exhausted');
  assert.equal(terminal.scope, 'pool');
  assert.equal(terminal.state, 'exhausted');
  assert.equal(terminal.resetAt, 15100);
  assert.ok(pool.snapshot().every(a => a.state === 'ready'));
  assert.equal(pool.select('astra', 15099), null);
  // Reaching the reset never unlatches the stop.
  assert.equal(pool.select('astra', 15100), null);
  assert.equal(pool.snapshot().find(a => a.key === 'pro-b').capped.secondary, true);
});
test('pool: both windows must stop excluding; missing resets are never invented', () => {
  const pool = fixture();
  pool.observe('pro-a', { primary_used_percent: 95, primary_reset_at: 6010, secondary_used_percent: 95 }, 10);
  pool.observe('pro-b', { primary_used_percent: 95 }, 10);
  assert.equal(pool.select('astra', 6010), null);
  assert.equal(pool.terminal('astra', 6010).resetAt, undefined);
  pool.observe('pro-a', { primary_used_percent: 94.9 }, 6020);
  assert.equal(pool.select('astra', 6020), null, 'missing secondary does not erase its live exclusion');
  pool.observe('pro-a', { secondary_used_percent: 94.9 }, 6030);
  assert.equal(pool.select('astra', 6030).key, 'pro-a');
});
test('pool: model scope preserves another healthy model; its failure yields pool mixed', () => {
  const pool = fixture();
  pool.reconcile([{ ...entries[0] }, { ...entries[1], models: ['other'] }], 0);
  pool.observe('pro-a', { primary_used_percent: 95 }, 10);
  assert.equal(pool.terminal('astra', 10).scope, 'model');
  assert.equal(pool.select('other', 10).key, 'pro-b');
  pool.forbidden('pro-b', 20);
  assert.deepEqual(pool.terminal('astra', 20), { status: 529, type: 'overloaded_error',
    reason: 'codex_pool_mixed', scope: 'pool', state: 'mixed', resetAt: undefined });
  assert.notEqual(pool.terminal('astra', 20).status, 403);
});
test('pool: excluded accounts on distinct models yield pool scope and zero available health', () => {
  const pool = fixture();
  pool.reconcile([entries[0], { ...entries[1], models: ['other'] }], 0);
  pool.observe('pro-a', { primary_used_percent: 95 }, 10);
  pool.observe('pro-b', { secondary_used_percent: 95 }, 10);
  assert.equal(pool.terminal('astra', 10).scope, 'pool');
  assert.equal(pool.terminal('other', 10).scope, 'pool');
  assert.deepEqual(pool.health(10), { state: 'exhausted', accountsAvailable: 0, resetAt: null });
  pool.observe('pro-b', { secondary_used_percent: 10 }, 20);
  assert.equal(pool.terminal('astra', 20).scope, 'model');
  assert.deepEqual(pool.health(20), { state: 'degraded', accountsAvailable: 1, resetAt: null });
});
test('pool: observations are detached, reject older updates and survive identity promotion', () => {
  const pool = fixture();
  const observation = { primary_used_percent: 95 };
  pool.observe('pro-a', observation, 20);
  observation.primary_used_percent = 0;
  pool.observe('pro-a', { primary_used_percent: 0 }, 10);
  const snapshot = pool.snapshot();
  snapshot[0].observation.primary.usedPercent = 0;
  pool.reconcile([{ key: 'promoted', previousKey: 'pro-a', models: ['astra'] }, entries[1]], 30);
  pool.credentials('promoted', true, 30);
  pool.succeeded('promoted', 30);
  assert.equal(pool.select('astra', 30).key, 'pro-b');
  assert.throws(() => pool.observe('promoted', {}, NaN), /time/);
});
test('pool: custom primary and secondary thresholds include their boundaries', () => {
  const pool = fixture({ rotationPrimaryUsedPercentMax: 50, rotationSecondaryUsedPercentMax: 100 });
  pool.observe('pro-a', { primary_used_percent: 50 }, 1);
  pool.observe('pro-b', { secondary_used_percent: 99.9 }, 1);
  assert.equal(pool.select('astra', 1).key, 'pro-b');
  pool.observe('pro-b', { secondary_used_percent: 100 }, 2);
  assert.equal(pool.select('astra', 2), null);
});
test('pool: old or same-time success keeps newer login failure; newer success clears it', () => {
  const pool = fixture();
  pool.forbidden('pro-a', 20);
  pool.reconcile(entries, 21);
  pool.succeeded('pro-a', 30, 10);
  assert.equal(pool.snapshot()[0].state, 'needs-login');
  pool.succeeded('pro-a', 31, 20);
  assert.equal(pool.snapshot()[0].state, 'needs-login');
  pool.succeeded('pro-a', 32, 21);
  assert.equal(pool.snapshot()[0].state, 'ready');
  assert.throws(() => pool.succeeded('pro-a', 33, NaN), /time/);
});
