import { it } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaRecovery } from '../src/quota-recovery.js';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = 1_800_000_000_000;
const ACCOUNT = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const IDENTITY = 'c'.repeat(64);
const NEW_IDENTITY = 'd'.repeat(64);

function setup(at = BASE) {
  assert.equal(typeof QuotaRecovery, 'function', 'QuotaRecovery must be implemented');
  const clock = { ms: at };
  const recovery = new QuotaRecovery({ now: () => clock.ms });
  return { recovery, clock };
}

function complete(recovery, account = ACCOUNT, identity = IDENTITY, outcome = { result: 'observed' }) {
  const lease = recovery.reserve(account, identity);
  assert.ok(lease);
  assert.equal(recovery.settle(lease, outcome), true);
  return lease;
}

it('inspection never creates accounts and invalid hashes never reserve', () => {
  const { recovery } = setup();
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).probeReady, true);
  assert.deepEqual(recovery.exportState().accounts, []);
  for (const value of [null, '', 'a'.repeat(63), 'g'.repeat(64), {}, 1]) {
    assert.equal(recovery.inspect(value, IDENTITY).reason, 'invalid-input');
    assert.equal(recovery.reserve(ACCOUNT, value), null);
  }
  assert.deepEqual(recovery.exportState().accounts, []);
});

for (const [offset, ready] of [[15 * MINUTE - 1, false], [15 * MINUTE, true], [15 * MINUTE + 1, true]]) {
  it(`enforces the account start interval at ${offset}ms`, () => {
    const { recovery, clock } = setup();
    complete(recovery);
    clock.ms += offset;
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).probeReady, ready);
    assert.equal(Boolean(recovery.reserve(ACCOUNT, IDENTITY)), ready);
  });
}

it('allows only two starts in a rolling hour and releases the oldest exactly at one hour', () => {
  const { recovery, clock } = setup();
  complete(recovery);
  clock.ms += 15 * MINUTE;
  complete(recovery);
  clock.ms = BASE + HOUR - 1;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'hourly-limit');
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + HOUR);
  assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
  clock.ms = BASE + HOUR;
  complete(recovery);
  clock.ms = BASE + HOUR + 1;
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
});

it('enforces a pool start interval of sixty seconds across different accounts', () => {
  const { recovery, clock } = setup();
  complete(recovery);
  clock.ms += MINUTE - 1;
  assert.equal(recovery.inspect(OTHER, IDENTITY).reason, 'pool-interval');
  assert.equal(recovery.inspect(OTHER, IDENTITY).nextAllowedAt, BASE + MINUTE);
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  clock.ms++;
  assert.ok(recovery.reserve(OTHER, IDENTITY));
});

it('anchors the account interval after delayed preparation and preserves it through restore', () => {
  const { recovery, clock } = setup();
  const lease = recovery.reserve(ACCOUNT, IDENTITY);
  clock.ms += 10 * MINUTE;
  assert.equal(recovery.settle(lease, { result: 'no-quota' }), true);
  const saved = recovery.exportState();
  assert.equal(saved.sequence, 1);
  assert.equal(saved.accounts[0].starts.length, 1);
  const restored = setup(BASE + 15 * MINUTE);
  restored.recovery.restoreState(saved);
  assert.equal(restored.recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 25 * MINUTE);
  assert.equal(restored.recovery.reserve(ACCOUNT, IDENTITY), null);
  restored.clock.ms = BASE + 25 * MINUTE - 1;
  assert.equal(restored.recovery.reserve(ACCOUNT, IDENTITY), null);
  restored.clock.ms++;
  assert.ok(restored.recovery.reserve(ACCOUNT, IDENTITY));
});

it('anchors the pool interval after delayed preparation and preserves it through restore', () => {
  const { recovery, clock } = setup();
  const lease = recovery.reserve(ACCOUNT, IDENTITY);
  clock.ms += 5 * MINUTE;
  assert.equal(recovery.settle(lease, { result: 'no-quota' }), true);
  const restored = setup(BASE + 6 * MINUTE - 1);
  restored.recovery.restoreState(recovery.exportState());
  assert.equal(restored.recovery.inspect(OTHER, IDENTITY).nextAllowedAt, BASE + 6 * MINUTE);
  assert.equal(restored.recovery.reserve(OTHER, IDENTITY), null);
  restored.clock.ms++;
  assert.ok(restored.recovery.reserve(OTHER, IDENTITY));
});

it('keeps two delayed sends inside the rolling-hour budget after restore', () => {
  const { recovery, clock } = setup();
  const first = recovery.reserve(ACCOUNT, IDENTITY);
  clock.ms = BASE + 20 * MINUTE;
  assert.equal(recovery.settle(first, { result: 'no-quota' }), true);
  clock.ms = BASE + 35 * MINUTE;
  const second = recovery.reserve(ACCOUNT, IDENTITY);
  assert.ok(second);
  clock.ms = BASE + 50 * MINUTE;
  assert.equal(recovery.settle(second, { result: 'no-quota' }), true);
  const saved = recovery.exportState();
  assert.equal(saved.sequence, 2);
  assert.equal(saved.accounts[0].starts.length, 2);
  const restored = setup(BASE + HOUR);
  restored.recovery.restoreState(saved);
  assert.equal(restored.recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 80 * MINUTE);
  assert.equal(restored.recovery.reserve(ACCOUNT, IDENTITY), null);
  restored.clock.ms = BASE + 80 * MINUTE - 1;
  assert.equal(restored.recovery.reserve(ACCOUNT, IDENTITY), null);
  restored.clock.ms++;
  assert.ok(restored.recovery.reserve(ACCOUNT, IDENTITY));
  assert.equal(restored.recovery.exportState().sequence, 3);
});

for (const result of ['aborted', 'persistence-failed', 'transport-error']) {
  it(`does not refund a delayed ${result} reservation`, () => {
    const { recovery, clock } = setup();
    const lease = recovery.reserve(ACCOUNT, IDENTITY);
    clock.ms += 10 * MINUTE;
    assert.equal(recovery.settle(lease, { result }), true);
    assert.equal(recovery.exportState().sequence, 1);
    assert.equal(recovery.exportState().accounts[0].starts.length, 1);
    assert.equal(recovery.inspect(ACCOUNT, NEW_IDENTITY).nextAllowedAt, BASE + 25 * MINUTE);
    clock.ms = BASE + 25 * MINUTE - 1;
    assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
    clock.ms++;
    assert.ok(recovery.reserve(ACCOUNT, NEW_IDENTITY));
  });
}

it('permits only one pool lease and exposes only known future waiting times', () => {
  const { recovery, clock } = setup();
  const lease = recovery.reserve(ACCOUNT, IDENTITY);
  assert.equal(recovery.isCurrent(lease), true);
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  assert.deepEqual(recovery.inspect(OTHER, IDENTITY), {
    probeReady: false, inFlight: true, nextAllowedAt: BASE + MINUTE,
    reason: 'pool-in-flight', lastResult: null,
  });
  clock.ms += MINUTE;
  assert.equal(recovery.inspect(OTHER, IDENTITY).nextAllowedAt, null);
  assert.equal(recovery.settle({ ...lease, identityHash: NEW_IDENTITY }, { result: 'observed' }), false);
  assert.equal(recovery.isCurrent(lease), true);
  assert.equal(recovery.settle(lease, { result: 'observed' }), true);
  assert.equal(recovery.isCurrent(lease), false);
  assert.equal(recovery.settle(lease, { result: 'observed' }), false);
});

it('waits for the maximum of a rate-limit deadline and all start budgets', () => {
  const { recovery, clock } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 5 * MINUTE });
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
  clock.ms += 15 * MINUTE;
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 2 * HOUR });
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 2 * HOUR);
  clock.ms = BASE + 2 * HOUR - 1;
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  clock.ms++;
  assert.ok(recovery.reserve(ACCOUNT, IDENTITY));
});

it('retains the hourly budget when a known rate-limit deadline is earlier', () => {
  const { recovery, clock } = setup();
  complete(recovery);
  clock.ms += 15 * MINUTE;
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 20 * MINUTE });
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + HOUR);
});

for (const deadline of [null, undefined, 'unparseable', NaN, Infinity]) {
  it(`holds an unparsed 429 deadline for an hour (${String(deadline)})`, () => {
    const { recovery, clock } = setup();
    complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: deadline });
    clock.ms += HOUR - 1;
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + HOUR);
    assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
    clock.ms++;
    assert.ok(recovery.reserve(ACCOUNT, IDENTITY));
  });
}

for (const result of ['transport-error', 'aborted', 'persistence-failed', 'identity-changed', 'interrupted', 'no-quota', 'unknown']) {
  it(`does not refund a ${result} reservation`, () => {
    const { recovery, clock } = setup();
    complete(recovery, ACCOUNT, IDENTITY, { result });
    assert.equal(recovery.inspect(ACCOUNT, NEW_IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
    clock.ms += 15 * MINUTE;
    complete(recovery, ACCOUNT, NEW_IDENTITY, { result });
    clock.ms += 15 * MINUTE;
    assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  });
}

it('keeps a restored pending account quarantined without reusing its consumed lease', () => {
  const { recovery, clock } = setup();
  const oldLease = recovery.reserve(ACCOUNT, IDENTITY);
  const snapshot = recovery.exportState();
  const restored = new QuotaRecovery({ now: () => clock.ms });
  restored.restoreState(snapshot);
  assert.equal(restored.isCurrent(oldLease), false);
  assert.equal(restored.settle(oldLease, { result: 'observed' }), false);
  assert.equal(restored.inspect(ACCOUNT, IDENTITY).lastResult, 'interrupted');
  assert.equal(restored.inspect(ACCOUNT, IDENTITY).inFlight, false);
  assert.equal(restored.reserve(ACCOUNT, NEW_IDENTITY), null);
  for (const elapsed of [15 * MINUTE, HOUR, 2 * HOUR]) {
    clock.ms = BASE + elapsed;
    assert.equal(restored.inspect(ACCOUNT, IDENTITY).probeReady, false);
    assert.equal(restored.reserve(ACCOUNT, NEW_IDENTITY), null);
  }
  assert.deepEqual(restored.exportState().accounts[0].starts, [BASE]);
  const newLease = restored.reserve(OTHER, IDENTITY);
  assert.ok(newLease);
  assert.ok(newLease.id > oldLease.id);
  assert.equal(restored.settle(oldLease, { result: 'observed' }), false);
});

it('quarantines a legacy pending snapshot and delays other recovery accounts for one minute', () => {
  const snapshot = {
    schemaVersion: 1, sequence: 1, lastSeenAt: BASE, fault: null, poolLastStartedAt: BASE,
    pending: { id: 1, accountHash: ACCOUNT, identityHash: IDENTITY, startedAt: BASE },
    accounts: [{ accountHash: ACCOUNT, starts: [BASE], blockedUntil: null, lastResult: null, deniedIdentity: null }],
  };
  const { recovery, clock } = setup(BASE + HOUR);
  recovery.restoreState(snapshot);
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).inFlight, false);
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
  assert.equal(recovery.inspect(OTHER, IDENTITY).nextAllowedAt, BASE + HOUR + MINUTE);
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  clock.ms += MINUTE - 1;
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  clock.ms++;
  assert.ok(recovery.reserve(OTHER, IDENTITY));
  assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
});

it('keeps a restored unknown outcome quarantined through a second save and restart', () => {
  const first = setup();
  const lease = first.recovery.reserve(ACCOUNT, IDENTITY);
  const second = setup(BASE + HOUR);
  second.recovery.restoreState(first.recovery.exportState());
  const third = setup(BASE + 2 * HOUR);
  third.recovery.restoreState(second.recovery.exportState());
  assert.equal(third.recovery.isCurrent(lease), false);
  assert.equal(third.recovery.settle(lease, { result: 'observed' }), false);
  assert.equal(third.recovery.inspect(ACCOUNT, IDENTITY).probeReady, false);
  assert.equal(third.recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
  assert.equal(third.recovery.exportState().sequence, 1);
  assert.deepEqual(third.recovery.exportState().accounts[0].starts, [BASE]);
  assert.equal(third.recovery.inspect(OTHER, IDENTITY).nextAllowedAt, BASE + 2 * HOUR + MINUTE);
  assert.equal(third.recovery.reserve(OTHER, IDENTITY), null);
  third.clock.ms += MINUTE;
  assert.ok(third.recovery.reserve(OTHER, IDENTITY));
});

it('keeps a restored rate-limit deadline and start history', () => {
  const { recovery, clock } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 2 * HOUR });
  clock.ms += MINUTE;
  const restored = new QuotaRecovery({ now: () => clock.ms });
  restored.restoreState(recovery.exportState());
  assert.equal(restored.inspect(ACCOUNT, NEW_IDENTITY).nextAllowedAt, BASE + 2 * HOUR);
  assert.equal(restored.reserve(ACCOUNT, NEW_IDENTITY), null);
});

for (const status of [401, 403]) {
  it(`denies the same identity after ${status}, keeping account budgets for a new identity`, () => {
    const { recovery, clock } = setup();
    complete(recovery, ACCOUNT, IDENTITY, { result: 'unknown', status });
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'identity-denied');
    assert.equal(recovery.inspect(ACCOUNT, NEW_IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
    clock.ms += 15 * MINUTE;
    assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
    complete(recovery, ACCOUNT, NEW_IDENTITY);
    clock.ms += 15 * MINUTE;
    assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
    const restored = new QuotaRecovery({ now: () => clock.ms });
    restored.restoreState(recovery.exportState());
    assert.equal(restored.inspect(ACCOUNT, IDENTITY).reason, 'identity-denied');
  });
}

it('waits through a one-millisecond rollback without refunding start budgets', () => {
  const { recovery, clock } = setup();
  complete(recovery);
  clock.ms--;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  clock.ms = BASE;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
  clock.ms = BASE + MINUTE - 1;
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  clock.ms++;
  complete(recovery, OTHER);
  clock.ms = BASE + 15 * MINUTE - 1;
  assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
  clock.ms++;
  complete(recovery, ACCOUNT, NEW_IDENTITY);
  clock.ms = BASE + 30 * MINUTE;
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + HOUR);
  clock.ms = BASE + HOUR - 1;
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  clock.ms++;
  complete(recovery);
  assert.equal(recovery.exportState().sequence, 4);
});

it('preserves a known rejection deadline when a rolled-back clock catches up', () => {
  const { recovery, clock } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 2 * HOUR });
  clock.ms--;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
  clock.ms = BASE;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 2 * HOUR);
  assert.equal(recovery.isHeld(ACCOUNT), true);
  clock.ms = BASE + 2 * HOUR - 1;
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  clock.ms++;
  complete(recovery);
  assert.equal(recovery.exportState().sequence, 2);
});

it('keeps a denied identity after recovering from a rollback', () => {
  const { recovery, clock } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'authentication', status: 401 });
  clock.ms--;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
  clock.ms = BASE + HOUR;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'identity-denied');
  assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  assert.ok(recovery.reserve(ACCOUNT, NEW_IDENTITY));
});

it('does not erase an unresolved restored outcome when rollback waiting ends', () => {
  const first = setup();
  assert.ok(first.recovery.reserve(ACCOUNT, IDENTITY));
  const { recovery, clock } = setup();
  recovery.restoreState(first.recovery.exportState());
  clock.ms--;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
  clock.ms = BASE + HOUR;
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'outcome-unknown');
  assert.equal(recovery.reserve(ACCOUNT, NEW_IDENTITY), null);
  assert.ok(recovery.reserve(OTHER, IDENTITY));
});

for (const fault of [null, 'clock-rollback']) {
  it(`restores a structurally valid future clock snapshot and resumes after catch-up (fault=${fault})`, () => {
    const first = setup();
    complete(first.recovery);
    first.clock.ms = BASE + 10 * MINUTE;
    const snapshot = { ...first.recovery.exportState(), fault };
    const { recovery, clock } = setup(BASE + 10 * MINUTE - 1);
    recovery.restoreState(snapshot);
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
    assert.equal(recovery.reserve(OTHER, IDENTITY), null);
    clock.ms++;
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
    const otherLease = recovery.reserve(OTHER, IDENTITY);
    assert.ok(otherLease);
    assert.equal(recovery.settle(otherLease, { result: 'no-quota' }), true);
    clock.ms = BASE + 15 * MINUTE;
    complete(recovery);
    assert.equal(recovery.exportState().sequence, 3);
  });
}

it('recovers a legacy rollback fault immediately when the clock has already caught up', () => {
  const first = setup();
  complete(first.recovery);
  const snapshot = { ...first.recovery.exportState(), fault: 'clock-rollback' };
  const { recovery } = setup(BASE + 15 * MINUTE);
  recovery.restoreState(snapshot);
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).probeReady, true);
  assert.ok(recovery.reserve(ACCOUNT, IDENTITY));
  assert.equal(recovery.exportState().sequence, 2);
});

for (const [name, notBefore, deadline] of [
  ['unknown deadline', null, BASE + HOUR],
  ['known deadline', BASE + 2 * HOUR, BASE + 2 * HOUR],
]) {
  it(`settles a pending 429 during rollback and keeps its ${name}`, () => {
    const { recovery, clock } = setup();
    const lease = recovery.reserve(ACCOUNT, IDENTITY);
    clock.ms--;
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).reason, 'clock-rollback');
    assert.equal(recovery.isCurrent(lease), true, 'admission waiting must not invalidate an in-flight response');
    assert.equal(recovery.reserve(OTHER, IDENTITY), null);
    assert.equal(recovery.settle(lease, { result: 'rate-limit', status: 429, notBefore }), true);
    const saved = recovery.exportState();
    assert.equal(saved.pending, null);
    assert.equal(saved.lastSeenAt, BASE);
    assert.equal(saved.sequence, 1);
    assert.deepEqual(saved.accounts[0].starts, [BASE]);
    assert.equal(saved.accounts[0].blockedUntil, deadline);

    const restored = setup();
    restored.recovery.restoreState(saved);
    assert.equal(restored.recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, deadline);
    restored.clock.ms = deadline - 1;
    assert.equal(restored.recovery.reserve(ACCOUNT, IDENTITY), null);
    restored.clock.ms++;
    complete(restored.recovery);
    assert.equal(restored.recovery.exportState().sequence, 2);
    assert.equal(restored.recovery.settle(lease, { result: 'observed' }), false);
  });
}

it('rejects malformed snapshots without throwing', () => {
  const { recovery } = setup();
  complete(recovery);
  const valid = recovery.exportState();
  const corruptions = [
    {}, [], false, 'arbitrary', { ...valid, schemaVersion: 2 },
    { ...valid, sequence: -1 }, { ...valid, lastSeenAt: -1 }, { ...valid, lastSeenAt: Infinity },
    { ...valid, poolLastStartedAt: BASE + 1 },
    { ...valid, accounts: [{ ...valid.accounts[0], starts: [BASE + 1] }] },
    { ...valid, accounts: [{ ...valid.accounts[0], starts: [] }] },
    { ...valid, accounts: [{ ...valid.accounts[0], lastResult: null }] },
    { ...valid, accounts: [{ ...valid.accounts[0], accountHash: 'raw-account' }] },
    { ...valid, accounts: [{ ...valid.accounts[0], lastResult: 'arbitrary' }] },
    { ...valid, accounts: [...valid.accounts, valid.accounts[0]] },
    { ...valid, sequence: 2, accounts: [...valid.accounts, { ...valid.accounts[0], accountHash: OTHER }] },
    { ...valid, unexpected: 'arbitrary' },
    { ...valid, pending: { id: 99, accountHash: ACCOUNT, identityHash: IDENTITY, startedAt: BASE } },
  ];
  for (const value of corruptions) {
    const candidate = new QuotaRecovery({ now: () => BASE });
    assert.doesNotThrow(() => candidate.restoreState(value));
    assert.equal(candidate.inspect(ACCOUNT, IDENTITY).reason, 'invalid-state');
    assert.equal(candidate.reserve(OTHER, NEW_IDENTITY), null);
    candidate.restoreState(null);
    assert.equal(candidate.reserve(OTHER, NEW_IDENTITY), null);
  }
});

it('accepts an absent initial snapshot but cannot erase a consumed budget', () => {
  for (const absent of [undefined, null]) {
    const { recovery } = setup();
    recovery.restoreState(absent);
    complete(recovery);
    recovery.restoreState(absent);
    assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  }
});

it('fails closed if the clock throws or returns an invalid value', () => {
  for (const now of [() => NaN, () => Infinity, () => -1, () => { throw new Error('not exposed'); }]) {
    const recovery = new QuotaRecovery({ now });
    assert.doesNotThrow(() => recovery.inspect(ACCOUNT, IDENTITY));
    assert.equal(recovery.inspect(ACCOUNT, IDENTITY).probeReady, false);
    assert.equal(recovery.reserve(ACCOUNT, IDENTITY), null);
  }
});

it('bounds account capacity without dropping live waiting budgets', () => {
  const { recovery, clock } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'rate-limit', status: 429, notBefore: BASE + 365 * 24 * HOUR });
  for (let index = 1; index < 2048; index++) {
    clock.ms += MINUTE;
    complete(recovery, index.toString(16).padStart(64, '0'));
  }
  clock.ms += MINUTE;
  assert.equal(recovery.inspect(OTHER, IDENTITY).reason, 'capacity');
  assert.equal(recovery.reserve(OTHER, IDENTITY), null);
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).nextAllowedAt, BASE + 365 * 24 * HOUR);
  assert.equal(recovery.exportState().accounts.length, 2048);
});

it('exports independent clones containing only hashes, numbers, null and fixed vocabulary', () => {
  const { recovery } = setup();
  complete(recovery, ACCOUNT, IDENTITY, { result: 'untrusted result', status: 401 });
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).lastResult, 'unknown');
  const snapshot = recovery.exportState();
  const allowed = new Set(['unknown', 'observed', 'no-quota', 'rate-limit', 'authentication', 'forbidden',
    'transport-error', 'aborted', 'persistence-failed', 'identity-changed', 'interrupted',
    'invalid-state', 'clock-rollback', 'clock-unavailable']);
  function check(value) {
    if (value === null) return;
    if (typeof value === 'number') return assert.ok(Number.isSafeInteger(value));
    if (typeof value === 'string') return assert.ok(/^[a-f0-9]{64}$/.test(value) || allowed.has(value));
    assert.equal(typeof value, 'object');
    for (const item of Object.values(value)) check(item);
  }
  check(snapshot);
  snapshot.accounts[0].starts.length = 0;
  snapshot.accounts[0].blockedUntil = 0;
  assert.equal(recovery.inspect(ACCOUNT, NEW_IDENTITY).nextAllowedAt, BASE + 15 * MINUTE);
});

it('normalizes the result from a single outcome read before retaining it', () => {
  const { recovery } = setup();
  let reads = 0;
  complete(recovery, ACCOUNT, IDENTITY, {
    get result() { return ++reads === 1 ? 'observed' : 'untrusted result'; },
  });
  assert.equal(recovery.inspect(ACCOUNT, IDENTITY).lastResult, 'observed');
});
