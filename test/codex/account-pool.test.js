import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../../src/codex/account-pool.js';

const accounts = [{ key: 'a', label: 'A', models: ['astra'] }, { key: 'b', label: 'B', models: ['astra', 'other'] }];
test('pool: explicit time, model eligibility and forbidden exclusion', () => {
  const pool = module.createCodexAccountPool(accounts);
  assert.throws(() => pool.select('astra'), /time/);
  pool.credentials('a', true, 10);
  pool.credentials('b', true, 10);
  assert.equal(pool.select('astra', 10).key, 'a');
  assert.equal(pool.select('other', 10).key, 'b');
  pool.forbidden('a', 11);
  assert.equal(pool.snapshot()[0].state, 'needs-login');
  pool.credentials('a', true, 12); // Local readable token cannot undo remote 403.
  assert.equal(pool.select('astra', 12).key, 'b');
});

test('pool: stable keys preserve state and sticky across label/order changes', () => {
  const pool = module.createCodexAccountPool(accounts);
  pool.credentials('a', true, 0);
  pool.credentials('b', true, 0);
  pool.bind('conversation', 'astra', 'b', 1);
  assert.equal(pool.select('astra', 2, 'conversation').key, 'b');
  pool.forbidden('a', 3);
  pool.reconcile([{ ...accounts[1], label: 'renamed' }, accounts[0]], 4);
  assert.equal(pool.select('astra', 5, 'conversation').key, 'b');
  assert.equal(pool.snapshot().find(a => a.key === 'a').state, 'needs-login');
  const projection = pool.snapshot();
  projection[0].models.push('mutated');
  projection[0].state = 'needs-login';
  assert.equal(pool.select('mutated', 6), null);
  assert.equal(pool.select('other', 6).key, 'b');
});

test('pool: provisional key promotion transfers state, replacement does not', () => {
  const pool = module.createCodexAccountPool(accounts);
  pool.credentials('a', true, 0);
  pool.bind('conversation', 'astra', 'a', 1);
  pool.reconcile([{ key: 'confirmed', previousKey: 'a', label: 'A', models: ['astra'] }], 2);
  assert.equal(pool.select('astra', 3, 'conversation').key, 'confirmed');
  pool.forbidden('confirmed', 4);
  pool.reconcile([{ key: 'replacement', label: 'A', models: ['astra'] }], 5);
  assert.equal(pool.snapshot()[0].state, 'unknown');
});

test('pool succeeded: explicit finite nowMs, deterministic state and detached snapshots', () => {
  const pool = module.createCodexAccountPool(accounts);
  pool.forbidden('a', 10);
  const before = pool.snapshot();
  for (const value of [undefined, NaN, Infinity, '20']) {
    assert.throws(() => pool.succeeded('a', value), /time/);
    assert.deepEqual(pool.snapshot(), before);
  }
  pool.succeeded('a', 20);
  assert.equal(before[0].state, 'needs-login');
  assert.equal(pool.snapshot()[0].state, 'ready');
  assert.equal(pool.snapshot()[0].updatedAt, 20);
  const second = module.createCodexAccountPool(accounts);
  second.forbidden('a', 10);
  second.succeeded('a', 20);
  assert.deepEqual(pool.snapshot(), second.snapshot());
});

// --- quota reserve: account policy and stop latch ---

const reserve = [{ key: 'primary', label: 'primary', models: ['astra'] }, { key: 'account-b', label: 'account-b', models: ['astra'] }];
const policies = [{ label: 'primary', usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 } },
  { label: 'account-b', usagePolicy: { stopUsedPercent: 100, resumeUsedPercent: 99 } }];
const httpConfig = (overrides = {}) => ({ usageObservationMode: 'http', usagePollIntervalMs: 60000,
  usageReadTimeoutMs: 5000, rotationObservationTtlMs: 150000, accounts: policies, ...overrides });
const GET = { source: 'usage-get', complete: true, ordinaryUsageAllowed: true };
// A GET only votes for recovery when it names the stop epoch the reader
// held when it began, so every reading that expects to recover must carry one.
const current = (pool, key = 'primary') => ({ ...GET, stopEpoch: pool.snapshot().find(a => a.key === key).stopEpoch });
const used = (usedPercent, extra = {}) => ({ primary_used_percent: usedPercent, ...extra });
// Under http an unobserved account is unselectable, so the alternative account
// carries a fresh reading unless a test is specifically about unknown usage.
function reserved(config = httpConfig(), { seed = true } = {}) {
  const pool = module.createCodexAccountPool(reserve, config);
  for (const account of reserve) pool.credentials(account.key, true, 0);
  if (seed) pool.observe('account-b', used(1), 0, GET);
  return pool;
}

test('reserve pool: account policy stops at its own boundary and ignores the window threshold', () => {
  const pool = reserved();
  pool.observe('primary', used(74), 10, GET);
  pool.observe('account-b', used(99), 10, GET);
  assert.equal(pool.select('astra', 10).key, 'primary');
  pool.observe('primary', used(75), 20, GET); // `>=` stops; the global 95 never applies.
  assert.equal(pool.select('astra', 20).key, 'account-b');
  pool.observe('account-b', used(100), 30, GET);
  assert.equal(pool.select('astra', 30), null);
  assert.equal(pool.terminal('astra', 30).reason, 'codex_pool_exhausted');
  assert.equal(pool.terminal('astra', 30).observationOnly, true);
});

test('reserve pool: a fractional header reading stops at the same boundary as an integer GET', () => {
  for (const [usedPercent, stops] of [[74.99, false], [75.0, true]]) {
    const pool = reserved();
    pool.observe('primary', used(1), 0, GET); // A header alone never makes an account selectable.
    pool.observe('primary', used(usedPercent), 10);
    assert.equal(pool.select('astra', 10).key, stops ? 'account-b' : 'primary');
  }
});

test('reserve pool: the stop is latched against elapsed time and against its reset instant', () => {
  const pool = reserved();
  pool.observe('primary', used(80, { primary_reset_at: 5000 }), 10, GET);
  for (const [at, why] of [[5000, 'reaching reset_at does not release'], [864000010, 'ten days do not release']]) {
    pool.observe('account-b', used(1), at, GET); // Only the alternative needs to stay fresh.
    assert.equal(pool.select('astra', at).key, 'account-b', why);
  }
  assert.equal(pool.snapshot().find(a => a.key === 'primary').capped.primary, true);
});

test('reserve pool: recovery needs two consecutive complete allowed GETs at or below resume', () => {
  const pool = reserved();
  pool.observe('primary', used(80), 10, GET);
  pool.observe('primary', used(71), 70, current(pool)); // 71 > 70: still above the resume threshold.
  assert.equal(pool.select('astra', 70).key, 'account-b');
  pool.observe('primary', used(70), 130, current(pool));
  assert.equal(pool.select('astra', 130).key, 'account-b', 'one confirmation is not enough');
  pool.observe('primary', used(70), 190, current(pool));
  assert.equal(pool.select('astra', 190).key, 'primary');
  assert.equal(pool.snapshot().find(a => a.key === 'primary').capped, undefined);
});

test('reserve pool: an incomplete, refused or header-sourced reading never confirms recovery', () => {
  for (const meta of [{ source: 'usage-get', complete: false, ordinaryUsageAllowed: true },
    { source: 'usage-get', complete: true, ordinaryUsageAllowed: false },
    { source: 'response-header' }]) {
    const pool = reserved();
    pool.observe('primary', used(80), 10, GET);
    // The epoch is always current, so only the source, completeness or refusal can block.
    for (const at of [70, 130, 190]) pool.observe('primary', used(10), at, { ...current(pool), ...meta });
    assert.equal(pool.select('astra', 190).key, 'account-b', JSON.stringify(meta));
  }
});

test('reserve pool: a failed reading between two good ones restarts the confirmation count', () => {
  const pool = reserved();
  pool.observe('primary', used(80), 10, GET);
  pool.observe('primary', used(70), 70, current(pool));
  pool.observe('primary', used(70), 130, { source: 'usage-get', complete: false });
  pool.observe('primary', used(70), 190, current(pool));
  assert.equal(pool.select('astra', 190).key, 'account-b');
  pool.observe('primary', used(70), 250, current(pool));
  assert.equal(pool.select('astra', 250).key, 'primary');
});

test('reserve pool: allowed=false withholds an account whose percentages are low', () => {
  const pool = reserved();
  pool.observe('primary', used(1), 10, { source: 'usage-get', complete: true, ordinaryUsageAllowed: false });
  assert.equal(pool.select('astra', 10).key, 'account-b');
  for (const at of [70, 130]) pool.observe('primary', used(1), at, current(pool));
  assert.equal(pool.select('astra', 130).key, 'primary');
});

test('reserve pool: each window latches on its own and both must clear together', () => {
  const pool = reserved();
  const both = (primary, secondary, at) => pool.observe('primary',
    { primary_used_percent: primary, secondary_used_percent: secondary }, at, current(pool));
  both(10, 90, 10);
  assert.deepEqual(pool.snapshot().find(a => a.key === 'primary').capped, { secondary: true });
  for (const at of [70, 130]) both(10, 90, at);
  assert.equal(pool.select('astra', 130).key, 'account-b', 'a low primary window does not release a stopped secondary');
  for (const at of [190, 250]) both(10, 70, at);
  assert.equal(pool.select('astra', 250).key, 'primary');
});

test('reserve pool: unknown usage is unselectable under http and selectable under passive', () => {
  const http = reserved(httpConfig(), { seed: false });
  assert.equal(http.select('astra', 0), null, 'nothing is chosen before the first read completes');
  assert.equal(http.terminal('astra', 0).state, 'degraded', 'unknown is not a terminal population');
  http.observe('primary', used(10), 10, GET);
  assert.equal(http.select('astra', 10).key, 'primary');
  assert.equal(http.select('astra', 125010), null, 'min(ttl, 2 polls + read) bounds an http observation');
  const passive = reserved({ accounts: policies }, { seed: false });
  assert.equal(passive.select('astra', 0).key, 'primary');
});

test('reserve pool: a succeeded generation and a credential read never release a stop', () => {
  const pool = reserved();
  pool.observe('primary', used(80), 10, GET);
  pool.succeeded('primary', 20);
  pool.credentials('primary', true, 21);
  assert.equal(pool.select('astra', 21).key, 'account-b');
  assert.equal(pool.snapshot().find(a => a.key === 'primary').state, 'ready');
});

test('reserve pool: superseded generation, replayed order and pre-stop reads are discarded', () => {
  const pool = reserved();
  pool.observe('primary', used(80), 10, GET);
  for (const at of [70, 130]) pool.observe('primary', used(10), at, { ...GET, generation: 99 });
  assert.equal(pool.select('astra', 130).key, 'account-b', 'another configuration epoch is another world');
  for (const at of [190, 250]) pool.observe('primary', used(10), at, { ...GET, stopEpoch: 0 });
  assert.equal(pool.select('astra', 250).key, 'account-b', 'a read begun before the stop cannot describe it');
  pool.observe('primary', used(10), 310, { ...current(pool), sequence: 7 });
  pool.observe('primary', used(90), 370, { ...current(pool), sequence: 6 });
  assert.equal(pool.snapshot().find(a => a.key === 'primary').observation.primary.usedPercent, 10);
  pool.observe('primary', used(10), 370, { ...current(pool), sequence: 8 });
  assert.equal(pool.select('astra', 370).key, 'primary');
});

test('reserve pool: revision advances on recovery and stands still while availability worsens', () => {
  const pool = reserved();
  const before = pool.revision();
  pool.observe('primary', used(80), 10, GET);
  pool.observe('account-b', used(100), 10, GET);
  assert.equal(pool.revision(), before, 'stopping two accounts is not an improvement');
  for (const at of [70, 130]) pool.observe('primary', used(10), at, current(pool));
  assert.equal(pool.revision(), before + 1);
});

test('reserve pool: configure swaps thresholds in place, tightening at once and loosening never', () => {
  const pool = reserved();
  pool.observe('primary', used(60), 10, GET);
  assert.equal(pool.select('astra', 10).key, 'primary');
  const tighter = [{ label: 'primary', usagePolicy: { stopUsedPercent: 50, resumeUsedPercent: 40 } }, policies[1]];
  pool.configure(httpConfig({ accounts: tighter }), 20);
  assert.equal(pool.select('astra', 20).key, 'account-b', 'a lowered stop applies to the observation already held');
  assert.equal(pool.snapshot().find(a => a.key === 'primary').observation.primary.usedPercent, 60, 'state survives');
  pool.configure(httpConfig(), 30);
  assert.equal(pool.select('astra', 30).key, 'account-b', 'raising the stop again does not resume on old evidence');
  for (const at of [70, 130]) pool.observe('primary', used(10), at, { ...current(pool), generation: pool.generation() });
  assert.equal(pool.select('astra', 130).key, 'primary');
  assert.throws(() => pool.configure(httpConfig()), /time/);
});

// --- passive degrade: the one-generation recovery probe ---

const passiveConfig = (overrides = {}) => ({ accounts: policies, ...overrides });
function passive(config = passiveConfig()) {
  const pool = module.createCodexAccountPool(reserve, config);
  for (const account of reserve) pool.credentials(account.key, true, 0);
  return pool;
}

test('reserve pool: a passive stop reopens for exactly one probe once its reset passes', () => {
  const pool = passive();
  pool.observe('primary', used(80, { primary_reset_at: 5000 }), 10);
  assert.equal(pool.probe('astra', 4999), null, 'nothing is owed before the advertised reset');
  assert.equal(pool.select('astra', 5000).key, 'account-b', 'reaching the reset does not unlatch the stop');
  assert.equal(pool.probe('astra', 5000).key, 'primary');
  assert.equal(pool.probe('astra', 5000), null, 'one generation only');
  pool.succeeded('primary', 5001, 5000);
  assert.equal(pool.snapshot().find(a => a.key === 'primary').capped, undefined, 'a clean probe recovers');
  assert.equal(pool.select('astra', 5002).key, 'primary');
});

test('reserve pool: a probe answered above the threshold re-latches instead of recovering', () => {
  const pool = passive();
  pool.observe('primary', used(80, { primary_reset_at: 5000 }), 10);
  assert.equal(pool.probe('astra', 5000).key, 'primary');
  pool.observe('primary', used(80), 5001); // The probe's own response still reads high.
  pool.succeeded('primary', 5002, 5000);
  assert.deepEqual(pool.snapshot().find(a => a.key === 'primary').capped, { primary: true });
  assert.equal(pool.probe('astra', 3600009), null, 'a spent probe re-arms no sooner than the valve');
  assert.equal(pool.probe('astra', 3600010).key, 'primary');
});

test('reserve pool: a reset-less stop waits the safety interval, which the kill switch and http remove', () => {
  for (const [name, config, at, expected] of [
    ['passive default', passiveConfig(), 3600009, null],
    ['passive default', passiveConfig(), 3600010, 'primary'],
    ['kill switch off', passiveConfig({ rotationRecoveryProbeEnabled: false }), 864000010, null],
    ['valve disabled', passiveConfig({ rotationUsageCapNoResetProbeMs: 0 }), 864000010, null],
    ['http never probes', httpConfig(), 864000010, null],
  ]) {
    const http = config.usageObservationMode === 'http';
    const pool = passive(config);
    pool.observe('primary', used(80), 10, http ? GET : {});
    assert.equal(pool.probe('astra', at)?.key ?? null, expected, `${name} at ${at}`);
  }
});

// --- observation source: http selects on complete GETs alone ---

test('reserve pool: under http only a complete GET makes an account selectable', () => {
  const pool = reserved(httpConfig(), { seed: false });
  pool.observe('primary', used(10), 10); // A response header is not a survey.
  assert.equal(pool.select('astra', 10), null);
  assert.equal(pool.terminal('astra', 10).state, 'degraded', 'unknown usage is not a terminal population');
  pool.observe('primary', used(10), 20, GET);
  assert.equal(pool.select('astra', 20).key, 'primary');
  pool.observe('primary', used(10), 125019); // A fresh header cannot extend the survey.
  assert.equal(pool.select('astra', 125020), null);
  assert.equal(pool.snapshot().find(a => a.key === 'primary').observation.primary.observedAt, 125019);
});

// --- late reads: stop epochs, not the first latch ---

test('reserve pool: a read begun before the latest stop is no recovery vote, only before the first', () => {
  const pool = reserved();
  pool.observe('primary', used(80), 10, GET);
  pool.observe('primary', used(90), 100, GET); // Re-stopped: a second epoch opens.
  assert.equal(pool.snapshot().find(a => a.key === 'primary').stopEpoch, 2);
  for (const at of [160, 220]) pool.observe('primary', used(10), at, { ...GET, stopEpoch: 1 });
  assert.equal(pool.select('astra', 220).key, 'account-b', 'a read from the previous epoch never recovers');
  for (const at of [280, 340]) pool.observe('primary', used(10), at, { ...GET, stopEpoch: 2 });
  assert.equal(pool.select('astra', 340).key, 'primary');
});

test('reserve pool: the recovery vote is keyed to the stop epoch, not to the instant a read began', () => {
  // A stop and a read that began before it can share a millisecond, so the clock alone
  // cannot separate them; the epoch the reader held when it started can.
  const same = reserved();
  same.observe('primary', used(80), 10, GET);
  assert.equal(same.snapshot().find(a => a.key === 'primary').stopEpoch, 1);
  same.observe('primary', used(90), 100, GET); // Re-stopped in the same millisecond the read lands.
  for (const at of [100, 160]) same.observe('primary', used(10), at, { ...GET, stopEpoch: 1 });
  assert.equal(same.select('astra', 160).key, 'account-b', 'startedAt === stoppedAt is not proof the read is newer');

  // A read begun before the first stop, however late it arrives.
  const before = reserved();
  before.observe('primary', used(80), 10, GET);
  for (const at of [70, 130]) before.observe('primary', used(10), at, { ...GET, stopEpoch: 0 });
  assert.equal(before.select('astra', 130).key, 'account-b', 'a pre-stop read is no recovery vote');
  assert.equal(before.snapshot().find(a => a.key === 'primary').resumeStreak, undefined);

  // Reads begun after the stop carry the current epoch and do confirm recovery.
  const after = reserved();
  after.observe('primary', used(80), 10, GET);
  const epoch = after.snapshot().find(a => a.key === 'primary').stopEpoch;
  after.observe('primary', used(10), 70, { ...GET, stopEpoch: epoch });
  assert.equal(after.select('astra', 70).key, 'account-b', 'one confirmation is not enough');
  after.observe('primary', used(10), 130, { ...GET, stopEpoch: epoch });
  assert.equal(after.select('astra', 130).key, 'primary');
});

test('reserve pool: a usage-get observation without a stop epoch never counts as a recovery vote', () => {
  // snapshot() always hands the reader a number, so a reading that carries none -- or
  // carries something that is not one -- cannot be placed against the stop it must clear.
  for (const [why, meta] of [['absent', { ...GET }], ['undefined', { ...GET, stopEpoch: undefined }],
    ['null', { ...GET, stopEpoch: null }], ['a string', { ...GET, stopEpoch: '1' }],
    ['NaN', { ...GET, stopEpoch: NaN }], ['Infinity', { ...GET, stopEpoch: Infinity }]]) {
    const pool = reserved();
    pool.observe('primary', used(80), 10, GET);
    for (const at of [70, 130, 190]) pool.observe('primary', used(10), at, meta);
    assert.equal(pool.select('astra', 190).key, 'account-b', `${why}: an unplaceable read is no recovery vote`);
    assert.equal(pool.snapshot().find(a => a.key === 'primary').resumeStreak, undefined, why);
  }
  // The very same readings recover once they name the epoch they began in.
  const named = reserved();
  named.observe('primary', used(80), 10, GET);
  for (const at of [70, 130]) named.observe('primary', used(10), at, current(named));
  assert.equal(named.select('astra', 130).key, 'primary');
});

test('reserve pool: a probe that is never sent is refunded and the valve still owes one', () => {
  const pool = passive();
  pool.observe('primary', used(80, { primary_reset_at: 5000 }), 10);
  assert.equal(pool.probe('astra', 5000).key, 'primary');
  assert.equal(pool.probe('astra', 5000), null, 'one generation only');
  pool.refundProbe('primary');
  assert.equal(pool.snapshot().find(a => a.key === 'primary').probeUsedAt, undefined);
  assert.equal(pool.probe('astra', 5000).key, 'primary', 'the refunded generation is owed again');
  // A refund never returns a probe the caller actually spent earlier.
  pool.succeeded('primary', 5001, 5000);
  pool.refundProbe('primary');
  assert.equal(pool.snapshot().find(a => a.key === 'primary').capped, undefined, 'the spent probe still recovered');
  pool.refundProbe('missing-account');
});

// --- reserved accounts: blockWhenUnknown ---
// 予約した口座（下のテストでは primary）へは、使用率 75% 以上の新鮮な観測がある間と、観測が不明な間は、新しく送らない。
// 閾値ではないので、観測が 1 つも無い状態は高い観測と同じだけ強く口座を止める。

// The reserve is a property of the account policy, so it rides the same reload path.
const withReserve = (primary, accountB) => [{ ...policies[0], usagePolicy: { ...policies[0].usagePolicy, blockWhenUnknown: primary } },
  { ...policies[1], usagePolicy: { ...policies[1].usagePolicy, blockWhenUnknown: accountB } }];
const why = (pool, at, key = 'primary') => pool.inspect(at).find(a => a.key === key).selectionBlockReason;

test('reserve pool: a reserved account waits for a fresh complete allowed GET and for nothing else', () => {
  const pool = reserved(httpConfig({ accounts: withReserve(true, false) }), { seed: false });
  pool.observe('account-b', used(1), 0, GET);
  assert.equal(pool.select('astra', 0).key, 'account-b', 'no observation at all withholds the reserved account');
  assert.equal(why(pool, 0), 'usage-unknown-reserved');
  pool.observe('primary', used(10), 10, GET);
  assert.equal(why(pool, 10), null);
  assert.equal(pool.select('astra', 10).key, 'primary');
  // min(ttl, 2 polls + read) = 125,000ms. The block returns the instant that lapses.
  assert.equal(pool.select('astra', 125009).key, 'primary');
  pool.observe('account-b', used(1), 125010, GET); // Only the alternative needs to stay fresh.
  assert.equal(why(pool, 125010), 'usage-unknown-reserved', 'an expired survey is unknown usage again');
  assert.equal(pool.select('astra', 125010).key, 'account-b');
  pool.observe('primary', used(10), 125011); // A response header is not a survey.
  assert.equal(why(pool, 125011), 'usage-unknown-reserved', 'a header reading never lifts the reserve');
  pool.observe('primary', used(10), 125012, { source: 'usage-get', complete: false, ordinaryUsageAllowed: true });
  assert.equal(why(pool, 125012), 'usage-unknown-reserved', 'an incomplete GET never lifts the reserve');
  // This complete GET does refresh the usage reading, so only the reserve can still be holding the account.
  pool.observe('primary', used(10), 125013, { source: 'usage-get', complete: true });
  assert.equal(why(pool, 125013), 'usage-unknown-reserved', 'a GET that does not state allowed never lifts it');
  pool.observe('primary', used(10), 125014, GET);
  assert.equal(pool.select('astra', 125014).key, 'primary');
});

test('reserve pool: a broken GET never widens the freshness the reserve is judged by', () => {
  // A degraded account falls back to the passive TTL (150,000ms here) for its window
  // freshness. The reserve must not inherit that: an account forbidden to guess cannot
  // gain 25 extra seconds of sending by having its own reader break.
  const pool = reserved(httpConfig({ accounts: withReserve(true, false) }), { seed: false });
  for (const key of ['primary', 'account-b']) pool.observe(key, used(10), 10, GET);
  pool.usageDegraded('primary', true);
  assert.equal(pool.select('astra', 125009).key, 'primary');
  assert.equal(why(pool, 125010), 'usage-unknown-reserved', 'the http ceiling still bounds the reserve evidence');
  // The window reading itself is still fresh by the passive TTL the degradation grants.
  assert.equal(pool.inspect(125010).find(a => a.key === 'primary').fresh.primary, true);
});

test('reserve pool: a GET the upstream refuses is no evidence for a reserved account', () => {
  const pool = reserved(httpConfig({ accounts: withReserve(true, false) }), { seed: false });
  pool.observe('account-b', used(1), 0, GET);
  pool.observe('primary', used(1), 10, { source: 'usage-get', complete: true, ordinaryUsageAllowed: false });
  assert.equal(why(pool, 10), 'upstream-blocked');
  // The two-reading recovery rule still governs the release; the reserve adds no second route back in.
  pool.observe('primary', used(1), 70, current(pool));
  assert.equal(pool.select('astra', 70).key, 'account-b', 'one confirmation is not enough');
  pool.observe('primary', used(1), 130, current(pool));
  assert.equal(pool.select('astra', 130).key, 'primary');
});

test('reserve pool: a degraded reserved account earns no probe from its reset, the hour or ten days', () => {
  const pool = reserved(httpConfig({ accounts: withReserve(true, false) }), { seed: false });
  pool.observe('primary', used(80, { primary_reset_at: 5000 }), 10, GET);
  pool.usageDegraded('primary', true); // Its own GET has broken: the passive rules would apply.
  for (const at of [5000, 3600011, 864000010]) {
    assert.equal(pool.probe('astra', at), null, `no generation is owed at ${at}`);
  }
  assert.equal(pool.select('astra', 864000010), null);
  assert.equal(why(pool, 864000010), 'usage-capped', 'the latch is the nearer reason while it holds');
  // The same account without the reserve keeps the existing passive valve.
  const open = reserved(httpConfig({ accounts: withReserve(false, false) }), { seed: false });
  open.observe('primary', used(80, { primary_reset_at: 5000 }), 10, GET);
  open.usageDegraded('primary', true);
  assert.equal(open.probe('astra', 4999), null);
  assert.equal(open.probe('astra', 5000).key, 'primary');
});

test('reserve pool: under passive a reserved account is unselectable and never rescues a stopped pool', () => {
  const pool = passive(passiveConfig({ accounts: withReserve(true, false) }));
  assert.equal(pool.select('astra', 0).key, 'account-b', 'passive tolerates unknown usage only where it is allowed');
  assert.equal(why(pool, 0), 'usage-unknown-reserved');
  pool.observe('primary', used(10), 5); // A header cannot open it, even where headers are the source.
  assert.equal(pool.select('astra', 5).key, 'account-b');
  pool.observe('primary', used(10), 10, GET);
  assert.equal(pool.select('astra', 10).key, 'primary', 'a complete allowed GET is the one thing that opens it');
  assert.equal(pool.select('astra', 60009).key, 'primary');
  assert.equal(pool.select('astra', 60010).key, 'account-b', 'the TTL bounds the reserve evidence under passive too');
  pool.observe('account-b', used(100), 60011); // Now nothing at all is selectable.
  assert.equal(pool.select('astra', 60011), null);
  assert.equal(pool.terminal('astra', 60011).status, 529);
  assert.equal(pool.probe('astra', 3660012).key, 'account-b', 'only the unreserved account may be probed');
});

test('reserve pool: configure turns the reserve on and off without discarding the observation', () => {
  const pool = passive(passiveConfig());
  pool.observe('primary', used(10), 10, GET);
  assert.equal(pool.select('astra', 10).key, 'primary');
  pool.configure(passiveConfig({ accounts: withReserve(true, false) }), 20);
  assert.equal(pool.select('astra', 20).key, 'primary', 'the GET already held still counts');
  assert.equal(pool.inspect(20).find(a => a.key === 'primary').blockWhenUnknown, true);
  assert.equal(pool.select('astra', 60010).key, 'account-b', 'once it lapses the reserve withholds the account');
  pool.configure(passiveConfig(), 60020);
  assert.equal(pool.select('astra', 60020).key, 'primary', 'clearing the flag restores the passive behaviour');
  assert.equal(pool.inspect(60020).find(a => a.key === 'primary').blockWhenUnknown, false);
  assert.equal(pool.inspect(60020).find(a => a.key === 'account-b').blockWhenUnknown, false);
});

test('reserve pool: without a policy the global window thresholds keep their passive behaviour', () => {
  const pool = module.createCodexAccountPool(reserve, { rotationPrimaryUsedPercentMax: 95 });
  for (const account of reserve) pool.credentials(account.key, true, 0);
  pool.observe('primary', used(95), 10);
  assert.equal(pool.select('astra', 10).key, 'account-b');
  pool.observe('primary', used(94.9), 20); // One header reading suffices here.
  assert.equal(pool.select('astra', 20).key, 'primary');
});
