// 使用量の通しのテスト。上流の応答の JSON を、使用量の正規化（src/codex/usage.js）→ 取得処理
// （src/codex/usage-poller.js）→ 口座プール（src/codex/account-pool.js）の順に、本物の部品でそのまま
// 通す。部品をつないだまま使用量が正しく口座プールへ届くことと、取得処理が primary 窓の有無を
// 完全な観測の条件に足さないことを確かめる。プール単体のテストでは取得処理の追加条件を見逃すため。
//
// 上流は fetchImpl に渡す偽物だけで、実ネットワークへは出ない。資格情報の読取・その更新時刻・
// User-Agent の組立は偽物を渡す。ログは本物のロガーを通して、許可リストで落ちないことも見る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename, dirname, join } from 'node:path';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { createUsagePoller } from '../../src/codex/usage-poller.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const MIN = 60_000;
// clock.advance は同期で、読取の続き（マイクロタスク）を流さない。
const flush = async (turns = 15) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };
// 合成の User-Agent と originator（製品名の部分は zz-fake- で始める決まり）。
const fakeUserAgent = 'zz-fake-usage-pipeline/0.0.0 (zz-fake-test)';
const fakeOriginator = 'zz-fake-originator';
const FIVE_HOURS_S = 18_000;
const WEEK_S = 604_800;

// 上流の窓: 使用率・長さ（秒）・リセットまでの秒数。resetAtOffset を渡すと reset_at だけを今からの
// 秒数でずらす（過去のリセット時刻を作るため）。
const fiveHour = (used, resetIn = 3_600) => ({ used, seconds: FIVE_HOURS_S, resetIn });
const weekly = (used, resetIn = 86_400) => ({ used, seconds: WEEK_S, resetIn });

/** 上流の応答。渡さなかった窓は JSON に載せない（キーごと欠ける）。 */
function upstream(clock, { primary, secondary, allowed = true } = {}) {
  const nowSec = Math.floor(clock.now() / 1000);
  const window = ({ used, seconds, resetIn, resetAtOffset = resetIn }) => ({ used_percent: used,
    limit_window_seconds: seconds, reset_after_seconds: resetIn, reset_at: nowSec + resetAtOffset });
  return new Response(JSON.stringify({ rate_limit: { allowed,
    ...(primary ? { primary_window: window(primary) } : {}),
    ...(secondary ? { secondary_window: window(secondary) } : {}) } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
}

async function fixture(t, { accounts = 1, respond }) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const entries = Array.from({ length: accounts }, (_, i) =>
    ({ key: `home:${i}`, home: join(isolation.root, 'accounts', `zz-home-${i}`), label: `zz-${i}`, models: null }));
  const config = { usageObservationMode: 'http', usagePollIntervalMs: 60_000, usageReadTimeoutMs: 5000,
    rotationObservationTtlMs: 125_000,
    accounts: entries.map(entry => ({ label: entry.label, usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 } })) };
  const pool = createCodexAccountPool(entries, config);
  const records = [];
  const logger = createCodexLogger({ level: 'debug', write: line => records.push(JSON.parse(line)) });
  const calls = [];
  const poller = createUsagePoller({ pool, now: clock.now, scheduler,
    log: (level, event, fields) => logger[level](event, fields),
    credentialEpoch: () => 1,
    resolveClientIdentity: async () => ({ userAgent: fakeUserAgent, originator: fakeOriginator }),
    readCredentials: async authPath => ({ accessToken: 'e30.e30.sig', accountId: basename(dirname(authPath)) }),
    fetchImpl: async (url, init) => {
      calls.push({ at: clock.now(), account: init.headers['ChatGPT-Account-ID'] });
      return respond({ clock, account: init.headers['ChatGPT-Account-ID'] });
    } });
  poller.configure(entries, config);
  await flush();
  const account = key => pool.snapshot().find(entry => entry.key === key);
  const view = key => pool.inspect(clock.now()).find(entry => entry.key === key);
  return { clock, pool, poller, calls, records,
    account, view,
    caps: key => Object.keys(account(key).windowCaps ?? {}).sort(),
    missing: (key, windowKey) => account(key).windowCaps?.[windowKey]?.missing,
    stopped: key => view(key).cooldown,
    logged: event => records.filter(record => record.event === event),
    async tick(ms) { clock.advance(ms); await flush(); } };
}

test('pipeline: a response without the primary window and one without the secondary window are both complete', async t => {
  const f = await fixture(t, { accounts: 2, respond: ({ clock, account }) => (account === 'zz-home-0'
    ? upstream(clock, { secondary: weekly(10) })
    : upstream(clock, { primary: fiveHour(10) })) });
  await f.tick(1);
  assert.equal(f.calls.length, 2);
  for (const key of ['home:0', 'home:1']) {
    assert.equal(f.poller.accountHealth(key).observationErrorCode, null, `${key}: no incomplete code`);
    assert.equal(f.poller.accountHealth(key).observationGate, 'passed', key);
    assert.equal(f.view(key).surveyed, true, `${key}: the complete GET dates the survey selection rests on`);
    assert.equal(f.view(key).selectionEligible, true, key);
  }
  assert.equal(f.poller.observation().gate, 'passed');
  assert.deepEqual(f.logged('codex_usage_read').map(record => record.observation_result), ['success', 'success']);
  // 窓は長さで識別される（どちらの応答も、載っている窓だけを持つ）。
  assert.deepEqual(Object.keys(f.account('home:0').windows), ['len:10080']);
  assert.equal(f.account('home:0').windows['len:10080'].position, 'secondary');
  assert.deepEqual(Object.keys(f.account('home:1').windows), ['len:300']);
});

test('pipeline: responses without the secondary window count the stopped weekly window missing and drop it after its reset', async t => {
  let shape = 'both';
  const f = await fixture(t, { respond: ({ clock }) => upstream(clock, shape === 'both'
    ? { primary: fiveHour(10), secondary: weekly(80, 600) }
    : { primary: fiveHour(10) }) });
  const key = 'home:0';
  await f.tick(1); // +1ms: 週次窓 80% で停止
  assert.deepEqual(f.caps(key), ['len:10080']);
  assert.equal(f.account(key).windows['len:10080'].resetAt, START + 600_000);
  shape = 'primary-only';
  await f.tick(MIN);
  assert.equal(f.poller.accountHealth(key).observationErrorCode, null, 'a response without the secondary window is complete');
  assert.equal(f.missing(key, 'len:10080'), 1);
  await f.tick(MIN);
  assert.equal(f.missing(key, 'len:10080'), 2);
  assert.equal(f.stopped(key), true, 'two low five-hour readings do not speak for the weekly window');
  assert.equal(f.account(key).windows['len:10080'].usedPercent, 80, 'the absent window is not read as zero');
  for (let i = 0; i < 7; i++) await f.tick(MIN);
  assert.equal(f.clock.now(), START + 540_001);
  assert.equal(f.stopped(key), true, 'still before the recorded weekly reset');
  assert.equal(f.logged('codex_usage_window_cap_dropped').length, 0);
  await f.tick(MIN); // +600001ms: リセット時刻を過ぎた欠落
  assert.equal(f.stopped(key), false);
  assert.deepEqual(f.caps(key), []);
  const drops = f.logged('codex_usage_window_cap_dropped');
  assert.deepEqual(drops.map(({ ts: _ts, ...record }) => record), [{ level: 'info', event: 'codex_usage_window_cap_dropped',
    account_label: 'zz-0', event_type: 'window-cap-dropped', window: 'secondary', window_minutes: 10_080 }]);
  const recovered = f.logged('codex_usage_recovered');
  assert.equal(recovered.length, 1);
  assert.ok(f.records.indexOf(drops[0]) < f.records.indexOf(recovered[0]), 'the drop is recorded before the release');
});

test('pipeline: responses without the primary window count the stopped five-hour window missing until it returns', async t => {
  let shape = 'high';
  const f = await fixture(t, { respond: ({ clock }) => upstream(clock, {
    high: { primary: fiveHour(80, 600), secondary: weekly(10) },
    'secondary-only': { secondary: weekly(10) },
    low: { primary: fiveHour(10), secondary: weekly(10) } }[shape]) });
  const key = 'home:0';
  await f.tick(1);
  assert.deepEqual(f.caps(key), ['len:300']);
  shape = 'secondary-only';
  await f.tick(MIN);
  assert.equal(f.poller.accountHealth(key).observationErrorCode, null, 'a response without the primary window is complete');
  assert.equal(f.missing(key, 'len:300'), 1);
  await f.tick(MIN);
  assert.equal(f.missing(key, 'len:300'), 2);
  assert.equal(f.stopped(key), true, 'a low weekly window does not speak for the stopped five-hour window');
  shape = 'low';
  await f.tick(MIN);
  assert.equal(f.missing(key, 'len:300'), 0, 'the returning five-hour window is matched by its length');
  assert.equal(f.account(key).resumeStreak, 1, 'the reading before it lacked the stopped window, so this is the first vote');
  assert.equal(f.stopped(key), true);
  await f.tick(MIN);
  assert.equal(f.stopped(key), false);
  assert.equal(f.logged('codex_usage_window_cap_dropped').length, 0, 'nothing was dropped: the window came back');
  assert.equal(f.logged('codex_usage_recovered').length, 1);
});

test('pipeline: a response whose weekly reset is already past is incomplete and does not replace the recorded reset', async t => {
  let shape = 'stop';
  const f = await fixture(t, { respond: ({ clock }) => upstream(clock, {
    stop: { primary: fiveHour(10), secondary: weekly(80, 7 * 86_400) },
    past: { primary: fiveHour(10), secondary: { used: 80, seconds: WEEK_S, resetIn: 0, resetAtOffset: -60 } },
    'primary-only': { primary: fiveHour(10) } }[shape]) });
  const key = 'home:0';
  await f.tick(1);
  assert.deepEqual(f.caps(key), ['len:10080']);
  shape = 'past';
  await f.tick(MIN);
  assert.equal(f.poller.accountHealth(key).observationErrorCode, 'reset-in-past', 'the normalizer marks it incomplete');
  shape = 'primary-only';
  for (let i = 0; i < 4; i++) await f.tick(MIN);
  assert.equal(f.stopped(key), true, 'the seven-day reset recorded by the complete reading still stands');
  assert.equal(f.logged('codex_usage_window_cap_dropped').length, 0);
  assert.equal(f.logged('codex_usage_recovered').length, 0);
  assert.equal(f.missing(key, 'len:10080'), 4, 'four misses, none of them past the recorded reset');
});
