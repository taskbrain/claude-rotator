// 窓の一部だけが載った観測で停止が解けてしまう不具合の再現と、その直し方のテスト。
// 下の T1〜T10 はこのファイルの中の通し番号で、口座プール（src/codex/account-pool.js）の上で確かめる。
//
// 窓は長さで識別する（鍵は長さの申告があれば len:<分>、無ければ pos:<位置>）。停止の記録・観測の
// 保存・票の照合・欠落の数え方はこの鍵で行い、しきい値だけを位置で引く。停止した窓が観測に載らない
// 回は復帰の票にならず、欠落として数える。欠落が2回続き、かつその窓のリセット時刻を過ぎた（記録が
// 無ければ停止から rotationUsageCapNoResetProbeMs が過ぎた）ときだけ、その窓の停止を外す。
//
// 値はすべて合成（口座は zz-a）。ネットワーク・資格情報・子プロセスには触れない（隔離を通す）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FIVE_HOURS = 300; // 窓の長さ（分）
const WEEK = 10_080;
const LATER = T0 + 30 * DAY; // 試験の間に来ないリセット時刻
const KEY = 'zz-a';
const POLICY = { stopUsedPercent: 75, resumeUsedPercent: 70 };

const config = (overrides = {}) => ({ usageObservationMode: 'http', usagePollIntervalMs: 60_000, usageReadTimeoutMs: 5000,
  rotationObservationTtlMs: 125_000, accounts: [{ label: KEY, usagePolicy: { ...POLICY } }], ...overrides });

// 1つの窓: 使用率・長さ（分。無ければ長さの申告なし）・リセット時刻（無ければ記録なし）。
const five = (used, resetAt) => ({ used, minutes: FIVE_HOURS, resetAt });
const week = (used, resetAt) => ({ used, minutes: WEEK, resetAt });
const bare = used => ({ used });

// プールが受け取る平らな形（取得処理の toPoolObservation と同じキー）。
function payload(windows) {
  const flat = {};
  for (const [position, window] of Object.entries(windows)) {
    if (!window) continue;
    flat[`${position}_used_percent`] = window.used;
    if (window.minutes !== undefined) flat[`${position}_window_minutes`] = window.minutes;
    if (window.resetAt !== undefined) flat[`${position}_reset_at`] = window.resetAt;
  }
  return flat;
}

async function fixture(t, { legacy = false, ...overrides } = {}) {
  await setupCodexIsolation(t);
  // legacy: 方針を持たない口座（位置ごとの共通のしきい値〈Legacy global thresholds〉の経路）。
  const pool = createCodexAccountPool([{ key: KEY, label: KEY, models: null }],
    legacy ? { usageObservationMode: 'http', ...overrides } : config(overrides));
  pool.credentials(KEY, true, T0);
  const entry = () => pool.snapshot().find(account => account.key === KEY);
  const view = at => pool.inspect(at).find(account => account.key === KEY);
  return {
    pool, entry,
    // 完全な GET（allowed:true）。読取を始めたのは直前の停止の後（今の停止世代を名乗る）。
    read: (at, windows, meta = {}) => pool.observe(KEY, payload(windows), at,
      { source: 'usage-get', complete: true, ordinaryUsageAllowed: true, stopEpoch: entry().stopEpoch, ...meta }),
    stopped: at => view(at).cooldown,
    reason: at => view(at).selectionBlockReason,
    caps: () => Object.keys(entry().windowCaps ?? {}).sort(),
    missing: windowKey => entry().windowCaps?.[windowKey]?.missing,
  };
}

const dropped = (windowKey, position, at, windowMinutes) => ({ type: 'window-cap-dropped', window: windowKey, position,
  ...(windowMinutes === undefined ? {} : { windowMinutes }), at });

// --- T1・T2: 票は停止した窓そのものの観測で数える ---

test('T1: a weekly stop is not released by two low complete readings that carry only the five-hour window', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10, T0 + 5 * HOUR), secondary: week(80, LATER) });
  assert.equal(f.stopped(T0), true);
  f.read(T0 + MIN, { primary: five(10, T0 + 5 * HOUR) });
  f.read(T0 + 2 * MIN, { primary: five(10, T0 + 5 * HOUR) });
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'the stopped weekly window never reported low again');
  assert.equal(f.reason(T0 + 2 * MIN), 'usage-capped');
});

test('T2: two complete readings with both windows low do release it', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, LATER) });
  f.read(T0 + MIN, { primary: five(10), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + MIN), true, 'one vote is not enough');
  f.read(T0 + 2 * MIN, { primary: five(10), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 2 * MIN), false);
  assert.deepEqual(f.caps(), []);
  assert.equal(f.entry().capped, undefined);
});

// --- T3: 上流から消えた窓の停止だけを外す ---

test('T3: only the vanished window loses its stop, after two misses and once its reset has passed', async t => {
  const f = await fixture(t);
  const weeklyReset = T0 + 10 * MIN;
  f.read(T0, { primary: five(80, T0 + 5 * HOUR), secondary: week(80, weeklyReset) });
  assert.deepEqual(f.caps(), ['len:10080', 'len:300']);
  // 5時間窓は停止と復帰の間（72%）に留まり、票にも新しい停止にもならない。
  f.read(T0 + MIN, { primary: five(72, T0 + 5 * HOUR) });
  assert.deepEqual(f.read(T0 + 2 * MIN, { primary: five(72, T0 + 5 * HOUR) }), [], 'the reset has not passed yet');
  assert.equal(f.missing('len:10080'), 2);
  assert.equal(f.missing('len:300'), 0, 'a window the reading carries is never counted missing');
  const events = f.read(weeklyReset, { primary: five(72, T0 + 5 * HOUR) });
  assert.deepEqual(events, [dropped('len:10080', 'secondary', weeklyReset, WEEK)]);
  assert.deepEqual(f.caps(), ['len:300'], 'the five-hour stop stays');
  assert.equal(f.entry().windows['len:10080'], undefined, 'the stored reading of the dropped window is gone too');
  assert.deepEqual(f.entry().capped, { primary: true });
  assert.equal(f.stopped(weeklyReset), true);
});

test('T3: before its reset has passed the vanished window keeps its stop, however many misses', async t => {
  const f = await fixture(t);
  const reset = T0 + 10 * MIN;
  f.read(T0, { primary: five(72), secondary: week(80, reset) });
  for (const at of [reset - 3 * MIN, reset - 2 * MIN, reset - MIN, reset - 1]) {
    assert.deepEqual(f.read(at, { primary: five(72) }), [], `no drop at reset - ${reset - at}ms`);
  }
  assert.equal(f.missing('len:10080'), 4);
  assert.equal(f.stopped(reset - 1), true);
  assert.deepEqual(f.read(reset, { primary: five(72) }), [dropped('len:10080', 'secondary', reset, WEEK)]);
});

for (const [why, interrupt] of [
  ['a failed read', f => f.pool.observationFailed(KEY)],
  ['an incomplete reading', (f, at) => f.read(at, { primary: five(72) }, { complete: false })],
  ['the window reported again, even between resume and stop', (f, at) => f.read(at, { primary: five(72), secondary: week(72, T0 + MIN) })],
  ['a new stop (an upstream refusal)', (f, at) => f.read(at, { primary: five(72) }, { ordinaryUsageAllowed: false })],
]) {
  test(`T3: ${why} between two misses restarts the count`, async t => {
    const f = await fixture(t);
    f.read(T0, { primary: five(72), secondary: week(80, T0 + MIN) });
    f.read(T0 + 2 * MIN, { primary: five(72) });
    assert.equal(f.missing('len:10080'), 1);
    interrupt(f, T0 + 3 * MIN);
    assert.equal(f.missing('len:10080'), 0);
    assert.deepEqual(f.read(T0 + 4 * MIN, { primary: five(72) }), [], 'one miss after the interruption is not two');
    assert.deepEqual(f.caps(), ['len:10080']);
    assert.deepEqual(f.read(T0 + 5 * MIN, { primary: five(72) }), [dropped('len:10080', 'secondary', T0 + 5 * MIN, WEEK)]);
  });
}

test('T3: a reading begun before the stop is never counted as a miss', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(72), secondary: week(80, T0 + MIN) });
  for (const at of [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 4 * MIN]) {
    assert.deepEqual(f.read(at, { primary: five(72) }, { stopEpoch: 0 }), []);
  }
  assert.equal(f.missing('len:10080'), 0);
  assert.equal(f.stopped(T0 + 4 * MIN), true);
});

test('T3: when the dropped window was the only stop, the two readings that counted it missing release the account', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, T0 + MIN) });
  const revision = f.pool.revision();
  f.read(T0 + 2 * MIN, { primary: five(70) });
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'one miss drops nothing');
  assert.equal(f.entry().resumeStreak, undefined, 'a reading without the stopped window is no vote while it is stopped');
  assert.deepEqual(f.read(T0 + 3 * MIN, { primary: five(70) }), [dropped('len:10080', 'secondary', T0 + 3 * MIN, WEEK)]);
  assert.equal(f.stopped(T0 + 3 * MIN), false, 'both readings were complete, allowed and at or below resume');
  assert.equal(f.entry().resumePending, undefined);
  assert.ok(f.pool.revision() > revision, 'the release is an improvement');
});

test('T3: when a remaining window is above resume, the account stays stopped after the drop until two clean readings', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, T0 + MIN) });
  f.read(T0 + 2 * MIN, { primary: five(72) });
  assert.equal(f.read(T0 + 3 * MIN, { primary: five(72) }).length, 1);
  assert.deepEqual(f.caps(), [], 'no window stop is left');
  assert.equal(f.stopped(T0 + 3 * MIN), true, 'yet the account is still stopped');
  assert.equal(f.reason(T0 + 3 * MIN), 'usage-capped');
  assert.equal(f.pool.lastResort('astra', T0 + 3 * MIN), null, 'and it is no last resort either');
  f.read(T0 + 4 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 4 * MIN), true, 'one clean reading is not two');
  f.read(T0 + 5 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 5 * MIN), false);
});

// 停止した窓について外す判定に使うリセット時刻は、使用量の GET の完全な観測が有効な未来の時刻を
// 届けたときだけ入れ替える。リセット時刻の無い観測・不完全な観測・過去の時刻・応答ヘッダでは、消さず
// 上書きもしない（当てにならない値で、記録済みのリセット時刻を失ったりずらしたりしないように）。
test('T3 (a): a complete reading without a reset time keeps the recorded reset (no fall back to the one-hour T4)', async t => {
  const f = await fixture(t);
  const weeklyReset = T0 + 7 * DAY;
  f.read(T0, { primary: five(10), secondary: week(80, weeklyReset) });
  f.read(T0 + MIN, { primary: five(10), secondary: week(80) }); // 同じ窓が、リセット時刻の無い完全な観測で届く
  for (const at of [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 2 * HOUR, weeklyReset - 1]) {
    assert.deepEqual(f.read(at, { primary: five(10) }), [], `no drop at +${at - T0}ms`);
  }
  assert.equal(f.stopped(weeklyReset - 1), true, 'the seven-day reset still stands');
  assert.deepEqual(f.read(weeklyReset, { primary: five(10) }), [dropped('len:10080', 'secondary', weeklyReset, WEEK)]);
});

test('T3 (b): a past reset from an incomplete reading does not replace the recorded reset', async t => {
  const f = await fixture(t);
  const weeklyReset = T0 + 7 * DAY;
  f.read(T0, { primary: five(10), secondary: week(80, weeklyReset) });
  // 正規化が reset-in-past として不完全にした応答（取得処理はそのリセット時刻もプールへ渡す）。
  f.read(T0 + MIN, { primary: five(10), secondary: week(80, T0 - MIN) }, { complete: false });
  for (const at of [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 2 * HOUR, weeklyReset - 1]) {
    assert.deepEqual(f.read(at, { primary: five(10) }), [], `no drop at +${at - T0}ms`);
  }
  assert.equal(f.stopped(weeklyReset - 1), true);
  assert.deepEqual(f.read(weeklyReset, { primary: five(10) }), [dropped('len:10080', 'secondary', weeklyReset, WEEK)]);
});

test('T3: only a complete GET with a future reset moves the recorded reset; a past value, an incomplete reading or a header never does', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, T0 + 10 * MIN) });
  f.read(T0 + MIN, { primary: five(10), secondary: week(72, T0 + 20 * MIN) }); // 完全・未来: +20分へ移す
  f.read(T0 + 2 * MIN, { primary: five(10), secondary: week(72, T0 + MIN) }); // 完全だが過去: 使わない
  f.pool.observe(KEY, payload({ secondary: week(72, T0 + 3 * MIN) }), T0 + 2 * MIN + 1); // 応答ヘッダ: 使わない
  f.read(T0 + 2 * MIN + 2, { secondary: week(72, T0 + 3 * MIN) }, { complete: false }); // 不完全・未来: 使わない
  f.pool.observe(KEY, payload({ secondary: week(72, T0 + 3 * MIN) }), T0 + 2 * MIN + 3, // 完全と名乗る応答ヘッダ: 使わない
    { source: 'response-header', complete: true, ordinaryUsageAllowed: true });
  for (const at of [T0 + 4 * MIN, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 20 * MIN - 1]) {
    assert.deepEqual(f.read(at, { primary: five(10) }), [], `no drop at +${at - T0}ms`);
  }
  assert.deepEqual(f.read(T0 + 20 * MIN, { primary: five(10) }), [dropped('len:10080', 'secondary', T0 + 20 * MIN, WEEK)]);
});

test('T3: a stop latched on reload takes the reset a complete GET recorded for that window', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(60, T0 + 7 * DAY) }); // 停止しきい値 75 の下
  f.pool.configure(config({ accounts: [{ label: KEY, usagePolicy: { stopUsedPercent: 50, resumeUsedPercent: 40 } }] }), T0 + MIN);
  assert.deepEqual(f.caps(), ['len:10080']);
  for (const at of [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 2 * HOUR]) {
    assert.deepEqual(f.read(at, { primary: five(10) }), [], 'the recorded seven-day reset, not the one-hour interval');
  }
  assert.equal(f.stopped(T0 + 2 * HOUR), true);
});

test('T3: a stop latched by an incomplete reading keeps the reset an earlier complete GET recorded', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(10, T0 + 7 * DAY) }); // 完全な GET（7日後・10%）。停止なし
  // 過去のリセット時刻を持つ不完全な観測（90%）で止まる。その時刻は外す判定に使わない。
  f.read(T0 + MIN, { primary: five(10), secondary: week(90, T0 - MIN) }, { complete: false });
  assert.deepEqual(f.caps(), ['len:10080']);
  for (const at of [T0 + 2 * MIN, T0 + 3 * MIN, T0 + 2 * HOUR, T0 + 7 * DAY - 1]) {
    assert.deepEqual(f.read(at, { primary: five(10) }), [], `no drop at +${at - T0}ms (not the one-hour interval)`);
  }
  assert.deepEqual(f.read(T0 + 7 * DAY, { primary: five(10) }), [dropped('len:10080', 'secondary', T0 + 7 * DAY, WEEK)]);
});

test('T3: a complete reading that does not state allowed is never counted as a miss', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(72), secondary: week(80, T0 + MIN) });
  for (const [at, allowed] of [[T0 + 2 * MIN, undefined], [T0 + 3 * MIN, null], [T0 + 4 * MIN, undefined]]) {
    assert.deepEqual(f.read(at, { primary: five(72) }, { ordinaryUsageAllowed: allowed }), []);
  }
  assert.equal(f.missing('len:10080'), 0);
  assert.equal(f.stopped(T0 + 4 * MIN), true);
  // 同じ観測でも allowed を言えば数える。
  assert.deepEqual(f.read(T0 + 5 * MIN, { primary: five(72) }), []);
  assert.equal(f.read(T0 + 6 * MIN, { primary: five(72) }).length, 1);
});

// --- T4: リセット時刻の記録が無い窓 ---

test('T4: without a recorded reset, two misses and the probe interval since the stop are both needed', async t => {
  const f = await fixture(t); // rotationUsageCapNoResetProbeMs は既定の1時間
  f.read(T0, { primary: five(10), secondary: week(80) });
  f.read(T0 + MIN, { primary: five(10) });
  assert.deepEqual(f.read(T0 + 2 * MIN, { primary: five(10) }), [], 'two misses, but the hour has not passed');
  assert.deepEqual(f.read(T0 + HOUR - 1, { primary: five(10) }), []);
  assert.equal(f.stopped(T0 + HOUR - 1), true);
  assert.deepEqual(f.read(T0 + HOUR, { primary: five(10) }), [dropped('len:10080', 'secondary', T0 + HOUR, WEEK)]);
  assert.equal(f.stopped(T0 + HOUR), false);
});

test('T4: elapsed time alone, with zero or one miss, never drops the stop', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80) });
  assert.equal(f.stopped(T0 + 10 * HOUR), true, 'ten hours and no reading at all');
  assert.deepEqual(f.read(T0 + 10 * HOUR, { primary: five(10) }), [], 'ten hours and one miss');
  assert.equal(f.stopped(T0 + 10 * HOUR), true);
  assert.equal(f.read(T0 + 10 * HOUR + MIN, { primary: five(10) }).length, 1, 'the second miss completes it');
});

test('T4: with rotationUsageCapNoResetProbeMs 0 a stop without a recorded reset is never dropped automatically', async t => {
  const f = await fixture(t, { rotationUsageCapNoResetProbeMs: 0 });
  f.read(T0, { primary: five(10), secondary: week(80) });
  for (let i = 1; i <= 20; i++) assert.deepEqual(f.read(T0 + i * 12 * HOUR, { primary: five(10) }), []);
  assert.equal(f.missing('len:10080'), 20);
  assert.equal(f.stopped(T0 + 10 * DAY), true);
});

test('T4: configure() reads rotationUsageCapNoResetProbeMs again, and the interval runs from the latest stop', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80) });
  f.pool.configure(config({ rotationUsageCapNoResetProbeMs: 0 }), T0 + MIN); // 保存した 80% で掛け直す
  for (let i = 1; i <= 5; i++) assert.deepEqual(f.read(T0 + i * 3 * HOUR, { primary: five(10) }), []);
  const restop = T0 + DAY;
  f.pool.configure(config({ rotationUsageCapNoResetProbeMs: 2 * HOUR }), restop);
  f.read(restop + MIN, { primary: five(10) });
  assert.deepEqual(f.read(restop + 2 * HOUR - 1, { primary: five(10) }), []);
  assert.equal(f.read(restop + 2 * HOUR, { primary: five(10) }).length, 1);
});

// --- T5・T6: 上流の拒否による停止 ---

test('T5: a stop by upstream refusal alone has no window condition and clears after two allowed complete readings', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(10, LATER) }, { ordinaryUsageAllowed: false });
  assert.equal(f.reason(T0), 'upstream-blocked');
  assert.equal(f.entry().capped, undefined);
  // 窓の停止が無いので、窓が1つしか載らない観測でも票になる。
  f.read(T0 + MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + MIN), true);
  f.read(T0 + 2 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 2 * MIN), false);
  assert.equal(f.entry().upstreamBlocked, undefined);
});

test('T6: a window stop together with an upstream refusal clears only when both conditions hold', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, LATER) }, { ordinaryUsageAllowed: false });
  assert.deepEqual(f.entry().capped, { secondary: true });
  assert.equal(f.entry().upstreamBlocked, true);
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: five(10), secondary: week(72, LATER) });
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'allowed, but the weekly window is above resume');
  for (const at of [T0 + 3 * MIN, T0 + 4 * MIN]) {
    f.read(at, { primary: five(10), secondary: week(10, LATER) }, { ordinaryUsageAllowed: false });
  }
  assert.equal(f.stopped(T0 + 4 * MIN), true, 'the windows are low, but the upstream still refuses');
  f.read(T0 + 5 * MIN, { primary: five(10), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 5 * MIN), true);
  f.read(T0 + 6 * MIN, { primary: five(10), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 6 * MIN), false);
  assert.equal(f.entry().upstreamBlocked, undefined);
});

// --- T7〜T9: 位置でなく長さで照合する ---

test('T7: the weekly stop follows the weekly window when it moves from primary to secondary', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: week(80, LATER) });
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: five(10, T0 + 5 * HOUR), secondary: week(72, LATER) });
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'a low five-hour window at primary does not speak for the weekly one');
  assert.equal(f.missing('len:10080'), 0, 'the weekly window is present, only at another position');
  assert.deepEqual(f.entry().capped, { secondary: true });
  f.read(T0 + 3 * MIN, { primary: five(10, T0 + 5 * HOUR), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 3 * MIN), true);
  f.read(T0 + 4 * MIN, { primary: five(10, T0 + 5 * HOUR), secondary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 4 * MIN), false, 'once the weekly window itself is low twice, it clears');
});

test('T7: a window that moves to the other position is shown only where it was last reported', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: week(20, LATER) });
  f.read(T0 + MIN, { secondary: week(30, LATER) });
  const { observation } = f.entry();
  assert.equal(observation.primary, undefined, 'nothing is reported at primary any more');
  assert.equal(observation.secondary.usedPercent, 30);
  assert.deepEqual(f.pool.inspect(T0 + MIN)[0].fresh, { primary: false, secondary: true });
});

test('T8: a window of another length at the same position is no vote, and the stopped one counts as missing', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: week(80, LATER) });
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: { used: 10, minutes: 60, resetAt: T0 + HOUR } });
  assert.equal(f.stopped(T0 + 2 * MIN), true);
  assert.equal(f.entry().resumeStreak, undefined);
  assert.equal(f.missing('len:10080'), 2);
});

test('T9: readings whose windows report no length never vote for a stop keyed by length', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, LATER) });
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: bare(10), secondary: bare(10) });
  assert.equal(f.stopped(T0 + 2 * MIN), true);
  assert.equal(f.entry().resumeStreak, undefined);
  assert.deepEqual(f.caps(), ['len:10080']);
});

test('T9: a stop taken without a length is matched only by windows that still report none', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: bare(80) });
  assert.deepEqual(f.caps(), ['pos:primary']);
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: five(10, LATER) });
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'a length-reporting window at the same position is another window');
  for (const at of [T0 + 3 * MIN, T0 + 4 * MIN]) f.read(at, { primary: bare(10) });
  assert.equal(f.stopped(T0 + 4 * MIN), false);
});

// --- T10: 設定の読み直しで掛け直さない ---

test('T10: configure() after a drop does not latch the dropped window again', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, T0 + MIN) });
  f.read(T0 + 2 * MIN, { primary: five(10) });
  f.read(T0 + 3 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 3 * MIN), false);
  f.pool.configure(config(), T0 + 4 * MIN);
  assert.equal(f.stopped(T0 + 4 * MIN), false, 'the old 80% reading of the weekly window was removed with its stop');
  assert.deepEqual(f.caps(), []);
});

test('T10: configure() restarts the miss count from zero', async t => {
  const f = await fixture(t);
  f.read(T0, { primary: five(10), secondary: week(80, T0 + MIN) });
  // 週次窓は停止と復帰の間（72%）で一度載る。保存した値が停止しきい値を下回るので、読み直しで掛け直さない。
  f.read(T0 + MIN, { primary: five(72), secondary: week(72, T0 + MIN) });
  f.read(T0 + 2 * MIN, { primary: five(72) });
  assert.equal(f.missing('len:10080'), 1);
  const epoch = f.entry().stopEpoch;
  f.pool.configure(config(), T0 + 3 * MIN);
  assert.equal(f.entry().stopEpoch, epoch, 'nothing was latched again');
  assert.equal(f.missing('len:10080'), 0);
  assert.deepEqual(f.read(T0 + 4 * MIN, { primary: five(72) }), [], 'the count starts again at one');
  assert.equal(f.read(T0 + 5 * MIN, { primary: five(72) }).length, 1);
});

// --- 方針を持たない口座（位置ごとの共通のしきい値〈Legacy global thresholds〉の経路）: しきい値は位置で引き、停止は鍵で記録する ---

test('legacy thresholds: a different window at the same position does not lift a stop recorded by length', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: week(96, LATER) });
  f.read(T0 + MIN, { primary: five(10, T0 + 5 * HOUR) });
  assert.equal(f.stopped(T0 + MIN), true);
  f.read(T0 + 2 * MIN, { primary: week(94, LATER) }); // 1回の観測で外す規則は変えない
  assert.equal(f.stopped(T0 + 2 * MIN), false);
});

test('legacy thresholds: the threshold is looked up by position', async t => {
  const f = await fixture(t, { legacy: true, rotationPrimaryUsedPercentMax: 95, rotationSecondaryUsedPercentMax: 50 });
  f.read(T0, { primary: five(60), secondary: week(60, LATER) });
  assert.deepEqual(f.entry().capped, { secondary: true });
  f.read(T0 + MIN, { primary: five(60), secondary: week(49, LATER) });
  assert.equal(f.stopped(T0 + MIN), false);
});

test('legacy thresholds: a vanished window is dropped the same way and the account is released', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: five(10), secondary: week(96, T0 + MIN) });
  f.read(T0 + 2 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 2 * MIN), true);
  assert.deepEqual(f.read(T0 + 3 * MIN, { primary: five(10) }), [dropped('len:10080', 'secondary', T0 + 3 * MIN, WEEK)]);
  assert.equal(f.stopped(T0 + 3 * MIN), false);
});

test('legacy thresholds: a refused reading that lifts the last window stop leaves the account stopped by the refusal', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: week(96, LATER) });
  f.read(T0 + MIN, { primary: week(10, LATER) }, { ordinaryUsageAllowed: false });
  assert.equal(f.stopped(T0 + MIN), true);
  assert.equal(f.reason(T0 + MIN), 'upstream-blocked');
  assert.equal(f.entry().upstreamBlocked, true, 'the refusal is not erased with the window stop');
  assert.equal(f.entry().capped, undefined, 'the window stop itself is lifted');
});

// 上流の拒否による停止は、方針の有無によらず T5 の規則で解く: 今の停止世代で allowed:true の完全な GET が
// 2回続いたら拒否の記録を消す。窓の停止が残っていなければ口座を解除し、残っていればその窓の条件を待つ。
// 窓の停止を1回の観測で外す、位置ごとの共通のしきい値（Legacy global thresholds）の規則は変えない。
test('legacy thresholds (T5): after a refusal at high usage, two allowed low readings release the account, one does not', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: week(96, LATER) }, { ordinaryUsageAllowed: false });
  assert.equal(f.entry().upstreamBlocked, true);
  f.read(T0 + MIN, { primary: week(10, LATER) });
  assert.equal(f.stopped(T0 + MIN), true, 'one allowed reading lifts the window stop but not the refusal');
  assert.equal(f.reason(T0 + MIN), 'upstream-blocked');
  f.read(T0 + 2 * MIN, { primary: week(10, LATER) });
  assert.equal(f.stopped(T0 + 2 * MIN), false);
  assert.equal(f.entry().upstreamBlocked, undefined);
});

test('legacy thresholds (T5): a stop by refusal alone clears only after two consecutive allowed complete readings of this stop', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: five(10) }, { ordinaryUsageAllowed: false });
  assert.equal(f.reason(T0), 'upstream-blocked');
  // 拒否より前に始まった読取は票にならない。
  for (const at of [T0 + MIN, T0 + 2 * MIN]) f.read(at, { primary: five(10) }, { stopEpoch: 0 });
  assert.equal(f.stopped(T0 + 2 * MIN), true);
  // 間に不完全な観測が挟まると数え直す。
  f.read(T0 + 3 * MIN, { primary: five(10) });
  f.read(T0 + 4 * MIN, { primary: five(10) }, { complete: false });
  f.read(T0 + 5 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 5 * MIN), true, 'the run restarted at one');
  f.read(T0 + 6 * MIN, { primary: five(10) });
  assert.equal(f.stopped(T0 + 6 * MIN), false);
  assert.equal(f.entry().upstreamBlocked, undefined);
});

test('legacy thresholds (T5): with a window stop and a refusal, the account waits for both conditions', async t => {
  const f = await fixture(t, { legacy: true });
  f.read(T0, { primary: five(10), secondary: week(96, LATER) }, { ordinaryUsageAllowed: false });
  // 週次窓が載らない allowed:true の観測2回: 拒否は解けるが、週次窓の停止は残る。
  f.read(T0 + MIN, { primary: five(10) });
  f.read(T0 + 2 * MIN, { primary: five(10) });
  assert.equal(f.entry().upstreamBlocked, undefined, 'the refusal cleared after two allowed readings');
  assert.equal(f.stopped(T0 + 2 * MIN), true, 'the weekly window stop still holds');
  assert.equal(f.reason(T0 + 2 * MIN), 'usage-capped');
  f.read(T0 + 3 * MIN, { primary: five(10), secondary: week(10, LATER) }); // 1回の観測で窓の停止を外す規則は変わらない
  assert.equal(f.stopped(T0 + 3 * MIN), false);
});
