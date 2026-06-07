import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { progressBar, renderStatus, formatDuration } from '../src/monitor.js';

describe('monitor rendering', () => {
  it('renders unicode progress bars', () => {
    assert.equal(progressBar(0.76, 10), '███████░░░');
    assert.equal(progressBar(null, 10), '----------');
  });

  it('formats durations compactly', () => {
    assert.equal(formatDuration(42 * 60 * 1000), '42m');
    assert.equal(formatDuration((25 * 60 + 5) * 60 * 1000), '1d1h');
  });

  it('renders per-account 5h and 7d rows', () => {
    const output = renderStatus(sampleStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 100,
    });

    assert.match(output, /Claude Rotator\s+active: b@example\.com/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /reason: 5h quota exhausted; reset -> 06\/04 10:00/);
    assert.match(output, /5h ██████████ 100%/);
    assert.match(output, /7d ███████░░░  76%/);
    assert.match(output, /b@example\.com\s+active/);
    assert.match(output, /Events/);
    assert.match(output, /fallback acct_1 -> acct_2 reason=shortest-quota-reset/);
  });
});

function sampleStatus() {
  return {
    currentAccount: 'acct_2',
    currentAccountName: 'b@example.com',
    switchThreshold: 1,
    accounts: [
      {
        id: 'acct_1',
        name: 'a@example.com',
        status: 'exhausted',
        quota: {
          unified5h: 1,
          unified7d: 0.76,
          unified5hReset: Date.parse('2026-06-04T10:00:00Z'),
          unified7dReset: Date.parse('2026-06-06T18:00:00Z'),
        },
        usage: { totalRequests: 12 },
        unavailableReason: {
          type: 'quota_exhausted',
          window: '5h',
          utilization: 1,
          resetAt: '2026-06-04T10:00:00.000Z',
        },
      },
      {
        id: 'acct_2',
        name: 'b@example.com',
        status: 'active',
        quota: {
          unified5h: 0.31,
          unified7d: 0.54,
          unified5hReset: Date.parse('2026-06-04T13:12:00Z'),
          unified7dReset: Date.parse('2026-06-08T01:00:00Z'),
        },
        usage: { totalRequests: 3 },
      },
    ],
    events: [
      { at: '2026-06-04T09:02:00Z', type: 'fallback-switch', from: 'acct_1', to: 'acct_2', reason: 'shortest-quota-reset' },
      { at: '2026-06-04T09:01:00Z', type: 'auto-switch', from: 'acct_1', to: 'acct_2' },
    ],
  };
}
