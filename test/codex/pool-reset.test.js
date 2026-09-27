import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';

const NOW = 1_800_000_000_000;

test('reset: pure pool uses only normalized direct timestamps and forgets missing evidence on update', () => {
  const pool = createCodexAccountPool([{ key: 'pro-a', models: ['astra'] }]);
  pool.credentials('pro-a', true, NOW);
  pool.observe('pro-a', { primary_used_percent: 95, primary_reset_at: NOW + 30000 }, NOW);
  assert.equal(pool.terminal('astra', NOW).resetAt, NOW + 30000);
  pool.observe('pro-a', { primary_used_percent: 95, primary_window_minutes: 10080 }, NOW + 1);
  assert.equal(pool.terminal('astra', NOW + 1).resetAt, undefined);
  assert.equal(pool.select('astra', NOW + 30000), null);
  for (const value of [NaN, Infinity, -1, '1800000015000', 253402300800000]) {
    pool.observe('pro-a', { primary_used_percent: 95, primary_reset_at: value }, NOW + 2);
    assert.equal(pool.terminal('astra', NOW + 2).resetAt, undefined);
  }
});
