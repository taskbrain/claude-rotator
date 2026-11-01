import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus } from '../src/monitor.js';

const START = Date.parse('2026-01-01T00:00:00Z');
it('shows recovery budget waits and effective polling without inventing usage percentages', () => {
  const text = renderStatus({ accounts: [], events: [], quotaRecovery: {
    schemaVersion: 1, usagePollingEnabled: false, probeReady: false, inFlight: false,
    nextAllowedAt: START + 15 * 60_000, reason: 'account-interval', lastResult: 'no-quota',
  } }, { now: START });
  assert.match(text, /Quota recovery: waiting/);
  assert.match(text, /polling: disabled/);
  assert.match(text, /account-interval/);
  assert.match(text, /15m/);
  assert.doesNotMatch(text, /0%/);
});

it('shows one active recovery lease and hides the entire section when absent', () => {
  const base = { accounts: [], events: [] };
  assert.doesNotMatch(renderStatus(base), /Quota recovery/);
  assert.match(renderStatus({ ...base, quotaRecovery: {
    schemaVersion: 1, usagePollingEnabled: true, probeReady: false, inFlight: true,
    nextAllowedAt: null, reason: 'pool-in-flight', lastResult: null,
  } }), /Quota recovery: in-flight/);
});
