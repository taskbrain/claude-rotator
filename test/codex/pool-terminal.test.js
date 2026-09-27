import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';

const NOW = 1_800_000_000_000;
function poolWith(states, models = states.map(() => ['astra'])) {
  const pool = createCodexAccountPool(states.map((_, i) => ({ key: String(i), label: `a${i}`, models: models[i] })));
  states.forEach((state, i) => {
    pool.credentials(String(i), state !== 'credentials-unavailable', NOW);
    if (state === 'needs-login') pool.forbidden(String(i), NOW);
    if (state === 'exhausted') pool.exhausted(String(i), { resetAt: NOW + (i + 1) * 1000, retryAt: NOW + 60000 }, NOW);
  });
  return pool;
}
const tuple = (status, type, reason, scope, state, resetAt) => ({ status, type, reason, scope, state, resetAt });
const rows = [
  ['needs-login/pool', ['needs-login', 'credentials-unavailable'], undefined, tuple(403, 'permission_error', 'codex_needs_login', 'pool', 'needs-login', undefined)],
  ['needs-login/model', ['needs-login', 'ready'], [['astra'], ['other']], tuple(403, 'permission_error', 'codex_needs_login', 'model', 'needs-login', undefined)],
  ['credentials-unavailable/pool', ['credentials-unavailable', 'credentials-unavailable'], undefined, tuple(403, 'permission_error', 'codex_credentials_unavailable', 'pool', 'credentials-unavailable', undefined)],
  ['credentials-unavailable/model', ['credentials-unavailable', 'ready'], [['astra'], ['other']], tuple(403, 'permission_error', 'codex_credentials_unavailable', 'model', 'credentials-unavailable', undefined)],
  ['exhausted/pool', ['exhausted', 'exhausted'], undefined, tuple(529, 'overloaded_error', 'codex_pool_exhausted', 'pool', 'exhausted', NOW + 1000)],
  ['mixed/pool', ['needs-login', 'exhausted'], undefined, tuple(529, 'overloaded_error', 'codex_pool_mixed', 'pool', 'mixed', NOW + 2000)],
  ['no-account-for-model/model', ['ready', 'ready'], [['other'], []], tuple(403, 'permission_error', 'codex_no_account_for_model', 'model', 'no-account-for-model', undefined)],
];
for (const [name, states, models, expected] of rows) {
  test(`pool ${name}: all six terminal elements`, () => {
    assert.deepEqual(poolWith(states, models).terminal('astra', NOW), expected);
  });
}
for (const states of [['exhausted', 'needs-login'], ['exhausted', 'credentials-unavailable'], ['credentials-unavailable', 'exhausted'], ['exhausted', 'exhausted']]) {
  test(`pure exhaustion/mixed boundary: ${states.join('+')}`, () => {
    assert.equal(poolWith(states).terminal('astra', NOW).state, states.every(s => s === 'exhausted') ? 'exhausted' : 'mixed');
  });
}
test('pool scope recomputes every element over P including another model reset', () => {
  assert.deepEqual(poolWith(['needs-login', 'exhausted'], [['astra'], ['other']]).terminal('astra', NOW),
    tuple(529, 'overloaded_error', 'codex_pool_mixed', 'pool', 'mixed', NOW + 2000));
});
test('pool model login plus missing credentials stays needs-login/model', () => {
  assert.deepEqual(poolWith(['needs-login', 'credentials-unavailable', 'ready'], [['astra'], ['astra'], ['other']]).terminal('astra', NOW),
    tuple(403, 'permission_error', 'codex_needs_login', 'model', 'needs-login', undefined));
});
test('pool healthy other model prevents pool-wide exhaustion', () => {
  assert.equal(poolWith(['exhausted', 'ready'], [['astra'], ['other']]).terminal('astra', NOW).scope, 'model');
});
test('pool reset is earliest known exhausted account, not a default TTL', () => {
  const pool = poolWith(['ready', 'ready']);
  pool.exhausted('0', { retryAt: NOW + 60000 }, NOW);
  pool.exhausted('1', { resetAt: NOW + 5000, retryAt: NOW + 5000 }, NOW);
  assert.equal(pool.terminal('astra', NOW).resetAt, NOW + 5000);
  pool.exhausted('1', { retryAt: NOW + 60000 }, NOW);
  assert.equal(pool.terminal('astra', NOW).resetAt, undefined);
});
test('pool readable credentials preserve exhaustion until retry time; reload preserves reset', () => {
  const pool = poolWith(['exhausted']);
  pool.reconcile([{ key: '0', label: 'renamed', models: ['astra'] }], NOW);
  pool.credentials('0', true, NOW + 1);
  assert.equal(pool.select('astra', NOW + 1), null);
  assert.equal(pool.terminal('astra', NOW + 1).resetAt, NOW + 1000);
  pool.credentials('0', true, NOW + 60000);
  assert.equal(pool.select('astra', NOW + 60000).key, '0');
});
test('pool disappearing exhausted credentials no longer claim time recovery', () => {
  const pool = poolWith(['exhausted']);
  pool.credentials('0', false, NOW + 1);
  assert.deepEqual(pool.terminal('astra', NOW + 1), tuple(403, 'permission_error', 'codex_credentials_unavailable', 'pool', 'credentials-unavailable', undefined));
});
test('pool unassigned ready account cannot hide a pool-wide login failure', () => {
  const pool = poolWith(['needs-login', 'ready'], [['astra'], []]);
  // A credential with no model assignment is not an available destination.
  assert.equal(pool.terminal('astra', NOW).scope, 'pool');
  assert.equal(pool.health(NOW).accountsAvailable, 0);
});
test('pool empty guard and unknown candidates retain the unclassified 529 receiver', () => {
  for (const entries of [[], [{ key: 'a', models: ['astra'] }]]) {
    const pool = createCodexAccountPool(entries);
    assert.deepEqual(pool.terminal('astra', NOW), tuple(529, 'overloaded_error', 'codex_attempt_limit', 'pool', 'degraded', undefined));
  }
});
