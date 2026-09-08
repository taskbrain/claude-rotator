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

    assert.match(output, /Claude Rotator\s+current: b@example\.com/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /reason: 5h quota exhausted; reset -> 06\/04 19:00 JST/);
    assert.match(output, /5h ██████████ 100%/);
    assert.match(output, /reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /7d ███████░░░  76%/);
    assert.match(output, /b@example\.com\s+active/);
    assert.match(output, /Events/);
    assert.match(output, /06\/04 18:02 JST fallback acct_1 -> acct_2 reason=shortest-quota-reset/);
  });

  it('renders the full Fable and Other recovery order with per-account route timing', () => {
    const output = renderStatus(modelAwareStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 160,
    });

    assert.match(output, /Routing availability/);
    assert.match(output, /Fable \(none now\)/);
    assert.match(output, /Other \(Sonnet \/ Opus \/ Haiku\)/);
    assert.match(output, /1\. a@example\.com\s+in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /1\. b@example\.com\s+now/);
    assert.match(output, /routes Fable: 1h \| Other: now/);
  });

  it('uses two account columns only when every line fits the terminal width', () => {
    const now = Date.parse('2026-06-04T09:00:00Z');
    const wide = renderStatus(modelAwareStatus(), { now, columns: 160 });
    const narrow = renderStatus(modelAwareStatus(), { now, columns: 80 });
    const accountPair = /a@example\.com\s+exhausted\s{3,}b@example\.com\s+exhausted/;

    assert.ok(wide.split('\n').some(line => accountPair.test(line)));
    assert.ok(narrow.split('\n').every(line => !accountPair.test(line)));
  });

  it('falls back to one account column when wide Unicode names exceed the terminal width', () => {
    const status = modelAwareStatus();
    const wideName = `${'日本語'.repeat(10)}@example.com`;
    status.accounts[0].name = wideName;
    for (const schedule of Object.values(status.routingAvailability)) {
      const entry = schedule.find(item => item.account === 'acct_1');
      entry.accountName = wideName;
    }

    const output = renderStatus(status, {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 150,
    });

    assert.ok(output.split('\n').every(line => !(
      line.includes(`${wideName} exhausted`)
      && line.includes('b@example.com              exhausted')
    )));
  });

  it('keeps rendering legacy status payloads without routing availability data', () => {
    const output = renderStatus(sampleStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 100,
    });

    assert.match(output, /Fable \(no data\)/);
    assert.match(output, /Other \(Sonnet \/ Opus \/ Haiku\) \(no data\)/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('renders model-scoped weekly quota rows when present', () => {
    const output = renderStatus({
      currentAccount: 'acct_1',
      currentAccountName: 'a@example.com',
      accounts: [
        {
          id: 'acct_1',
          name: 'a@example.com',
          status: 'active',
          quota: {
            unified5h: 0.2,
            unified7d: 0.3,
            weeklyScoped: [
              {
                key: 'fable',
                label: 'Fable',
                utilization: 0.5,
                resetAt: Date.parse('2026-07-07T00:00:00Z'),
              },
            ],
          },
          usage: { totalRequests: 1 },
        },
      ],
      events: [],
    }, {
      now: Date.parse('2026-07-05T00:00:00Z'),
    });

    assert.match(output, /7d Fable █████░░░░░  50%  reset in 2d -> 07\/07 09:00 JST/);
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

function modelAwareStatus() {
  const status = sampleStatus();
  status.accounts[1].status = 'exhausted';
  status.accounts[1].quota.weeklyScoped = [{
    key: 'fable',
    label: 'Fable',
    utilization: 1,
    resetAt: Date.parse('2026-06-04T10:00:00Z'),
  }];
  status.accounts[1].unavailableReason = {
    type: 'quota_exhausted',
    window: '7d Fable',
    utilization: 1,
    resetAt: '2026-06-04T10:00:00.000Z',
  };
  status.routingAvailability = {
    fable: [
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
    ],
    other: [
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'available',
        availableAt: null,
      },
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
    ],
  };
  return status;
}

// Codex section of `claude-rotator status` (design doc section 9.6 / 13.3).
// claude-rotator only ever reads the codex-rotator health JSON: every key is
// optional, an unknown contract version is not an error, and a missing or broken
// payload must never break the Claude side of the screen.
describe('codex status section', () => {
  const now = Date.parse('2026-06-04T09:00:00Z');

  it('renders the codex pool header and one row per codex account', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: true, health: codexHealth() },
    });

    assert.match(output, /Codex Rotator\s+pool: exhausted \(0\/2 available\)\s+reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /pro-a\s+█████████░\s+97% 2nd\s+41% \(7d\)\s+exhausted\s+reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /pro-b\s+███░░░░░░░\s+31%\s+available/);
    assert.match(output, /note: accounts are shown by label/);
    // The Claude side is rendered exactly as before.
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('renders the CLI-consumption note only when the pool reports it', () => {
    const visible = codexHealth();
    visible.pool.observation.cliConsumptionVisible = true;

    assert.match(
      renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health: codexHealth() } }),
      /note: CLI-driven usage is not included in these numbers/,
    );
    assert.doesNotMatch(
      renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health: visible } }),
      /note: CLI-driven usage is not included in these numbers/,
    );
  });

  it('renders a single unreachable line when the health fetch failed', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: false, reason: 'timeout 1500ms' },
    });

    assert.match(output, /Codex Rotator\s+codex: unreachable \(timeout 1500ms\)/);
    assert.doesNotMatch(output, /pool:/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('OSS independence: no codex data means the status output is byte-identical', () => {
    const baseline = renderStatus(sampleStatus(), { now, columns: 100 });

    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: null }), baseline);
    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: undefined }), baseline);
    assert.doesNotMatch(baseline, /Codex Rotator/);
  });

  it('draws the optional keys only when they are present', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: true, health: { contract: 1, pool: { state: 'unknown', accounts: [{ label: 'pro-a' }] } } },
    });

    assert.match(output, /Codex Rotator\s+pool: unknown/);
    assert.match(output, /pro-a\s+----------\s+--%/);
    assert.doesNotMatch(output, /undefined|NaN/);
  });

  it('degrades to one line when a contract-mandated key is missing', () => {
    const payloads = [
      {},
      { contract: 1 },
      { pool: { state: 'available', accounts: [] } },
      { contract: 1, pool: null },
      { contract: 1, pool: { accounts: [] } },
      { contract: 1, pool: { state: 'available' } },
      { contract: 1, pool: { state: 'available', accounts: 'not-an-array' } },
      { contract: 1, pool: { state: 42, accounts: [] } },
    ];

    for (const health of payloads) {
      const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });
      assert.match(output, /Codex Rotator\s+codex: unreachable \(invalid payload\)/);
      assert.doesNotMatch(output, /pool:/);
      assert.match(output, /a@example\.com\s+exhausted/);
      assert.match(output, /Events/);
    }
  });

  it('never crashes on a payload built to break string conversion', () => {
    const health = codexHealth();
    health.pool.accounts[0].label = { toString: null };
    health.pool.accounts[1].state = { toString: null };

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /Codex Rotator/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
    assert.doesNotMatch(output, /\[object Object\]/);
  });

  it('replaces a label that does not match the contract pattern', () => {
    const health = codexHealth();
    health.pool.accounts[0].label = 'codex-account@example.invalid';
    health.pool.accounts[1].label = `pro-b${String.fromCharCode(0x200b)}`;

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /<invalid>\s+█████████░/);
    assert.match(output, /<invalid>\s+███░░░░░░░/);
    assert.doesNotMatch(output, /@example\.invalid/);
    assert.doesNotMatch(output, /pro-b/);
  });

  it('strips control and zero-width characters from codex states', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const bell = String.fromCharCode(0x07);
    const health = codexHealth();
    health.pool.accounts[0].state = `exhaus${bell}ted`;
    health.pool.state = `exhaus${zeroWidth}ted`;

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /pro-a\s+█████████░/);
    assert.match(output, /exhausted/);
    assert.match(output, /pool: exhausted/);
    assert.ok(!output.includes(zeroWidth), 'zero-width characters must not reach the terminal');
    assert.ok(!output.includes(bell), 'control characters must not reach the terminal');
  });

  it('degrades to one line when reading the payload throws', () => {
    const health = codexHealth();
    Object.defineProperty(health.pool, 'observation', {
      get() { throw new Error('hostile payload'); },
    });

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /Codex Rotator\s+codex: unreachable \(invalid payload\)/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('never renders an email-like identifier even when the health JSON carries one', () => {
    const health = codexHealth();
    health.pool.accounts[0].display = 'codex-account@example.invalid';
    health.pool.accounts[0].email = 'codex-account@example.invalid';

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /pro-a\s+█████████░/);
    assert.doesNotMatch(output, /example\.invalid/);
  });
});

// Dummy codex-rotator health payload. Labels are placeholders on purpose: by
// contract the health JSON carries no email address, and this fixture must not
// introduce one.
function codexHealth() {
  return {
    status: 'ok',
    contract: 1,
    pool: {
      state: 'exhausted',
      accountsTotal: 2,
      accountsAvailable: 0,
      resetAt: '2026-06-04T10:00:00Z',
      observation: { mode: 'passive', source: 'response-header', cliConsumptionVisible: false },
      accounts: [
        {
          label: 'pro-a',
          state: 'exhausted',
          primaryUsedPercent: 97,
          secondaryUsedPercent: 41,
          windowDurationMins: 10080,
          resetAt: '2026-06-04T10:00:00Z',
        },
        {
          label: 'pro-b',
          state: 'available',
          primaryUsedPercent: 31,
        },
      ],
    },
  };
}
