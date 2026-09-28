// 使用量の定期取得（src/codex/usage-poller.js）のテスト。
//
// 確かめること:
//   - 予定・同時数・間隔・縮退・古い結果・終了。観測方式は http に固定で、縮退してもプールの規則を変えない。
//   - ログは codex-rotator のロガーの許可リストに載る項目だけを出す。
//   - 資格情報の期限切れは、ログイン切れの規則（auth-tracker.js）に従う。
//   - User-Agent と originator を依存から受け取ること、ログイン切れの規則と取得処理の組み合わせ。
//
// 実ネットワークへは出ない。上流は fetchImpl に渡す偽物だけで、読取器（usage.js）は本物を通す
// （取得処理と読取器の間の約束を実地で確かめるため）。資格情報の読取・その更新時刻・User-Agent の
// 組立も偽物を渡す。テストの隔離（helpers/isolation.js）を毎回通す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexAccountPool } from '../../src/codex/account-pool.js';
import { CredentialsError } from '../../src/codex/credentials.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { CODEX_USAGE_URL } from '../../src/codex/usage.js';
import { createUsagePoller } from '../../src/codex/usage-poller.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
// clock.advance は同期で、読取の続き（マイクロタスク）を流さない。
const flush = async (turns = 15) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };
// 合成の User-Agent と originator（製品名の部分は zz-fake- で始める決まり）。
const fakeUserAgent = 'zz-fake-usage-poller/0.0.0 (zz-fake-test)';
const fakeOriginator = 'zz-fake-originator';
const SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'codex');

/** 使用量の応答の形（両窓・allowed・reset_at・limit_window_seconds）。 */
function usageResponse(clock, { used = 10, allowed = true, secondary = null } = {}) {
  const resetAt = Math.floor(clock.now() / 1000) + 3600;
  const window = (usedPercent, limitWindowSeconds) => ({ used_percent: usedPercent, reset_at: resetAt,
    reset_after_seconds: 3600, limit_window_seconds: limitWindowSeconds });
  return new Response(JSON.stringify({ rate_limit: { allowed, primary_window: window(used, 18000),
    secondary_window: secondary === null ? null : window(secondary, 604800) } }),
  { status: 200, headers: { 'content-type': 'application/json' } });
}
const httpError = status => new Response(JSON.stringify({ error: 'synthetic' }), { status,
  headers: { 'content-type': 'application/json' } });

async function fixture(t, { accounts = 2, settings = {}, respond, log, readUsage } = {}) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const entries = Array.from({ length: accounts }, (_, i) =>
    ({ key: `home:${i}`, home: join(isolation.root, 'accounts', `zz-home-${i}`), label: `zz-${i}`, models: null }));
  const config = { usageObservationMode: 'http', usagePollIntervalMs: 60000, usageReadTimeoutMs: 5000,
    rotationObservationTtlMs: 150000,
    accounts: entries.map(entry => ({ label: entry.label, usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 } })),
    ...settings };
  const live = createCodexAccountPool(entries, config);
  for (const entry of entries) live.credentials(entry.key, true, clock.now());
  const observed = [];
  const poolCalls = [];
  const pool = { ...live,
    observe(key, observation, nowMs, meta) { observed.push({ key, observation, nowMs, meta }); return live.observe(key, observation, nowMs, meta); },
    configure(...args) { poolCalls.push('configure'); return live.configure(...args); } };
  const calls = [];
  const logs = [];
  const credentialReads = [];
  const epochs = new Map();
  let credentials = null;
  let gate = null; // 資格情報の読取を保留させる関門（終了の割り込み点を作る）。
  let identity = { userAgent: fakeUserAgent, originator: fakeOriginator, source: 'config' };
  const identityCalls = [];
  const poller = createUsagePoller({ pool, now: clock.now, scheduler, ...(readUsage ? { readUsage } : {}),
    log: (level, event, fields) => { logs.push({ level, event, fields }); log?.(level, event, fields); },
    credentialEpoch: account => epochs.get(account.key) ?? 1,
    resolveClientIdentity: async () => {
      identityCalls.push(clock.now());
      if (identity instanceof Error) throw identity;
      return identity;
    },
    readCredentials: async authPath => {
      credentialReads.push(authPath);
      if (credentials instanceof Error) throw credentials;
      if (gate) await gate;
      return { accessToken: 'e30.e30.sig', accountId: basename(dirname(authPath)) };
    },
    fetchImpl: async (url, init) => {
      const call = { url, at: clock.now(), account: init.headers['ChatGPT-Account-ID'], headers: init.headers };
      calls.push(call);
      return respond({ ...call, clock, index: calls.length - 1, signal: init.signal });
    } });
  return { isolation, clock, entries, config, pool: live, observed, poolCalls, calls, poller, logs, credentialReads,
    identityCalls,
    logged: event => logs.filter(line => line.event === event),
    reads: home => calls.filter(call => call.account === home).length,
    view: (key, at) => live.inspect(at ?? clock.now()).find(account => account.key === key),
    account: key => live.snapshot().find(entry => entry.key === key),
    failCredentials: error => { credentials = error; },
    setEpoch: (key, value) => { epochs.set(key, value); },
    setIdentity: value => { identity = value; },
    holdCredentials() {
      let open;
      gate = new Promise(resolve => { open = resolve; });
      return () => { gate = null; open(); };
    },
    async start() { poller.configure(entries, config); await flush(); },
    async tick(ms = 0) { clock.advance(ms); await flush(); } };
}

// --- 予定・同時数・間隔・縮退・古い結果・終了 ---

test('usage poller: the gate reads every account once, then once per interval, never twice at a time', async t => {
  let release;
  const f = await fixture(t, { respond: ({ url, clock, index }) => {
    assert.equal(url, CODEX_USAGE_URL);
    // The second read of zz-home-1 never answers: its account must not be read again.
    if (index === 3) return new Promise(resolve => { release = () => resolve(usageResponse(clock)); });
    return usageResponse(clock);
  } });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 2, 'the verification gate reads every registered account once');
  assert.equal(f.poller.observation().gate, 'passed');
  await f.tick(59_999);
  assert.equal(f.calls.length, 2, 'nothing is read before the poll interval elapses');
  await f.tick(1);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2].at - f.calls[0].at, 60_000);
  for (let i = 0; i < 3; i++) await f.tick(60_000);
  assert.equal(f.reads('zz-home-1'), 2, 'an account with a read in flight is never read again');
  assert.equal(f.reads('zz-home-0'), 5);
  release();
  await f.tick(0); // the read settles, and only then is the next one scheduled.
  await f.tick(59_999);
  assert.equal(f.reads('zz-home-1'), 2);
  await f.tick(1);
  assert.equal(f.reads('zz-home-1'), 3, 'the account resumes its schedule once the read settles');
});

test('usage poller: the per account floor holds even when the interval is shorter', async t => {
  const f = await fixture(t, { accounts: 1, settings: { usagePollIntervalMs: 1000 },
    respond: ({ clock }) => usageResponse(clock) });
  await f.start();
  await f.tick(1);
  await f.tick(29_999);
  assert.equal(f.calls.length, 1, 'thirty seconds is the floor between two reads of one account');
  await f.tick(1);
  assert.equal(f.calls.length, 2);
});

test('usage poller: a failed gate degrades at once, backs off 60/120/300s and recovers on success', async t => {
  let healthy = false;
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => healthy ? usageResponse(clock) : httpError(500) });
  await f.start();
  assert.equal(f.poller.observation().gate, 'pending');
  await f.tick(1);
  assert.deepEqual(f.poller.observation(), { source: 'usage-get', gate: 'failed',
    cliConsumptionVisible: false, accountUsageIncludesExternalClients: true });
  assert.equal(f.poller.accountHealth('home:0').observationErrorCode, 'server-error');
  assert.equal(f.poller.accountHealth('home:0').observationDegraded, true);
  assert.deepEqual(f.poolCalls, [], 'the degradation is not handed to the pool');
  for (const backoff of [60_000, 120_000, 300_000, 300_000]) {
    const before = f.calls.length;
    await f.tick(backoff - 1);
    assert.equal(f.calls.length, before, `no read before ${backoff}ms of backoff`);
    await f.tick(1);
    assert.equal(f.calls.length, before + 1);
  }
  healthy = true;
  await f.tick(300_000);
  assert.equal(f.poller.observation().gate, 'passed');
  assert.equal(f.poller.accountHealth('home:0').observationDegraded, false);
  const before = f.calls.length;
  await f.tick(59_999);
  assert.equal(f.calls.length, before, 'a recovered account is back on the poll interval');
  await f.tick(1);
  assert.equal(f.calls.length, before + 1);
});

test('usage poller: five consecutive failures degrade an account that passed the gate', async t => {
  let healthy = true;
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => healthy ? usageResponse(clock) : httpError(404) });
  await f.start();
  await f.tick(1);
  assert.equal(f.poller.accountHealth('home:0').observationDegraded, false);
  healthy = false;
  for (let i = 0; i < 4; i++) await f.tick(300_000);
  assert.equal(f.calls.length, 5);
  assert.equal(f.poller.accountHealth('home:0').observationDegraded, false, 'four failures do not degrade a gated account');
  assert.equal(f.poller.accountHealth('home:0').observationErrorCode, 'not-found');
  await f.tick(300_000);
  assert.equal(f.poller.accountHealth('home:0').observationDegraded, true);
  assert.equal(f.poller.observation().gate, 'passed', 'the startup check itself had passed');
});

test('usage poller: a read that began before a stop never votes for recovery', async t => {
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => index === 0
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock, { used: 10 })); })
    : usageResponse(clock, { used: 10 }) });
  const key = 'home:0';
  // A response header stops the account before the first read is even scheduled. It names the
  // same five-hour window the GETs report (windows are matched by their length, not their position).
  f.pool.observe(key, { primary_used_percent: 99, primary_window_minutes: 300 }, f.clock.now(), {});
  assert.equal(f.pool.snapshot()[0].stopEpoch, 1);
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  // While that read is in flight the account is stopped again: a newer epoch opens.
  f.pool.observe(key, { primary_used_percent: 99, primary_window_minutes: 300 }, f.clock.now(), {});
  assert.equal(f.pool.snapshot()[0].stopEpoch, 2);
  release();
  await f.tick(0);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].meta.stopEpoch, 1, 'the epoch the read began in travels with the result');
  assert.equal(f.observed[0].meta.source, 'usage-get');
  assert.equal(f.observed[0].meta.complete, true);
  assert.deepEqual(f.pool.snapshot()[0].capped, { primary: true }, 'a late read cannot lift the newer stop');
  assert.equal(f.pool.snapshot()[0].resumeStreak, undefined);
  // Two reads that do belong to the current epoch recover it, and not one sooner.
  await f.tick(60_000);
  assert.deepEqual(f.pool.snapshot()[0].capped, { primary: true });
  assert.equal(f.pool.snapshot()[0].resumeStreak, 1);
  const revision = f.pool.revision();
  await f.tick(60_000);
  assert.equal(f.pool.snapshot()[0].capped, undefined);
  assert.ok(f.pool.revision() > revision, 'a recovery advances the revision');
});

test('usage poller: shutdown clears the timers and applies nothing afterwards', async t => {
  let release;
  const f = await fixture(t, { respond: ({ clock, index }) => index === 1
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock, { used: 99 })); })
    : usageResponse(clock) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.observed.length, 1, 'the second account is still reading');
  f.poller.shutdown();
  release();
  await f.tick(600_000);
  assert.equal(f.calls.length, 2, 'no timer survives shutdown');
  assert.equal(f.observed.length, 1, 'a read that lands after shutdown changes nothing');
  assert.equal(f.poller.accountHealth('home:1').nextObservationAt, null);
});

test('usage poller: the observation method is fixed, so a config without any mode key still arms the gate', async t => {
  // 方式のキーが http でなくてもタイマーを張る。codex-rotator の設定には方式の
  // キーが無い（設定の検証が拒否する）ので、キーが無くても、古い値が残っていても読む。
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock) });
  const { usageObservationMode: _ignored, ...withoutMode } = f.config;
  f.poller.configure(f.entries, withoutMode);
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.poller.observation().gate, 'passed');
  assert.equal(Object.hasOwn(f.poller.observation(), 'mode'), false, 'there is no observation mode to report');
  f.poller.configure(f.entries, { ...withoutMode, usageObservationMode: 'passive' });
  await f.tick(30_000);
  assert.equal(f.calls.length, 2, 'a leftover mode key is not read at all');
});

test('usage poller: a failed read breaks the run of complete readings a recovery needs', async t => {
  // 復帰には「完全な新しい観測が2回連続」が要る。読取が失敗した回は観測を生まないので何も
  // 証明しないが、連続は断たれる（さもないと低い使用率の成功→失敗→成功で停止が解ける）。
  let healthy = true;
  const f = await fixture(t, { accounts: 1,
    respond: ({ clock }) => (healthy ? usageResponse(clock, { used: 10 }) : httpError(500)) });
  const key = 'home:0';
  // A response header stops it, naming the same five-hour window the GETs report.
  f.pool.observe(key, { primary_used_percent: 99, primary_window_minutes: 300 }, f.clock.now(), {});
  assert.deepEqual(f.account(key).capped, { primary: true });
  await f.start();
  await f.tick(1);
  assert.equal(f.account(key).resumeStreak, 1, 'the first complete reading votes once');
  healthy = false;
  await f.tick(60_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.poller.accountHealth(key).observationErrorCode, 'server-error');
  assert.equal(f.account(key).resumeStreak, undefined, 'a failed read clears the vote it cannot confirm');
  healthy = true;
  await f.tick(60_000);
  assert.equal(f.account(key).resumeStreak, 1, 'the run restarts at one, it does not resume at two');
  assert.deepEqual(f.account(key).capped, { primary: true }, 'success/failure/success never lifts the stop');
  await f.tick(60_000);
  assert.equal(f.account(key).capped, undefined, 'two complete readings in a row do lift it');
});

test('usage poller: an unreadable account degrades alone and still follows the http rules, with no trial send', async t => {
  // 縮退は口座ごとの記録で、プールの規則は変えない。読めない口座も、使用量が不明な間は選ばれず、
  // 鮮度は http の長さで測り、停止した後も時間の経過では開かない（試し打ちの経路はプールに無い）。
  let healthy = true;
  const f = await fixture(t, { respond: ({ account, clock }) =>
    (!healthy && account === 'zz-home-0' ? httpError(500) : usageResponse(clock, { used: 10 })) });
  const key = 'home:0';
  const other = 'home:1';
  await f.start();
  await f.tick(1);
  healthy = false;
  for (let i = 0; i < 4; i++) await f.tick(300_000);
  assert.equal(f.poller.accountHealth(key).observationDegraded, false, 'four failures are not five');
  await f.tick(300_000);
  assert.equal(f.poller.accountHealth(key).observationDegraded, true);
  assert.equal(f.poller.accountHealth(other).observationDegraded, false, 'the health value is per account');
  assert.deepEqual(f.poolCalls, [], 'nothing switches the pool to other rules');

  // 125s = 2 polls + one read deadline. The configured 150s TTL is never applied to it.
  const future = f.clock.now() + 130_000;
  assert.equal(f.view(key, future).freshnessMs, 125_000, 'the degraded account keeps the http freshness');
  assert.equal(f.view(key, future).selectionBlockReason, 'usage-unknown', 'unknown usage still blocks it');

  const stopAt = f.clock.now();
  for (const account of [key, other]) {
    f.pool.observe(account, { primary_used_percent: 99, primary_reset_at: stopAt + 60_000 }, stopAt, {});
  }
  assert.equal(f.pool.probe, undefined, 'the pool has no trial send to hand out');
  for (const at of [stopAt + 60_000, stopAt + 3_600_001, stopAt + 864_000_000]) {
    assert.equal(f.pool.select('astra', at), null, `no stopped account opens at +${at - stopAt}ms`);
    assert.equal(f.pool.lastResort('astra', at), null, `nor is one handed out as a last resort at +${at - stopAt}ms`);
  }
  healthy = true;
  await f.tick(300_000);
  assert.equal(f.poller.accountHealth(key).observationDegraded, false, 'one complete reading clears the record');
});

test('usage poller: when no account can be read, nothing switches the whole pool to other rules', async t => {
  const f = await fixture(t, { respond: () => httpError(500) });
  await f.start();
  await f.tick(1);
  for (const key of ['home:0', 'home:1']) assert.equal(f.poller.accountHealth(key).observationDegraded, true);
  assert.equal(f.poller.observation().gate, 'failed');
  assert.deepEqual(f.poolCalls, [], 'the pool configuration is never touched by the poller');
  assert.equal(Object.hasOwn(f.poller, 'degraded'), false, 'there is no pool-wide degradation to announce');
  for (const key of ['home:0', 'home:1']) {
    assert.equal(f.view(key).freshnessMs, 125_000);
    assert.equal(f.view(key).selectionBlockReason, 'usage-unknown');
  }
  assert.equal(f.pool.select('astra', f.clock.now()), null, 'unknown usage is not selectable by the ordinary rules');
  assert.equal(f.pool.lastResort('astra', f.clock.now()).key, 'home:0', 'only the last resort may pick it');
});

test('usage poller: a shutdown while the credentials are being read sends no usage GET', async t => {
  const f = await fixture(t, { accounts: 1, respond: () => assert.fail('no usage GET may start after shutdown') });
  const open = f.holdCredentials();
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 0, 'the read is suspended on the credential file');
  f.poller.shutdown();
  open();
  await f.tick(600_000);
  assert.equal(f.calls.length, 0, 'the awaited credential read does not resume into a GET');
  assert.equal(f.poller.accountHealth('home:0').nextObservationAt, null);
});

test('usage poller: shutdown aborts a usage GET that is already in flight', async t => {
  let aborted = false;
  const f = await fixture(t, { accounts: 1, respond: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  assert.equal(aborted, false, 'the read is still in flight');
  f.poller.shutdown();
  assert.equal(aborted, true, 'shutdown interrupts the GET instead of leaving it to its own deadline');
  await f.tick(0);
  assert.equal(f.observed.length, 0, 'an interrupted read applies nothing');
});

test('usage poller: a reload never starts a second read of an account already reading', async t => {
  // reload は状態のオブジェクトを作り直すが、読取を1本に保つのは口座のキーで行う。古い読取が
  // 30秒以上かかっても、同じ口座の GET が2本並ぶことはない。
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => (index === 0
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock)); })
    : usageResponse(clock)) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  f.poller.configure(f.entries, f.config); // A reload while that first read is still in flight.
  await f.tick(600_000);
  assert.equal(f.calls.length, 1, 'the reload waits for the read in flight instead of racing it');
  release();
  await f.tick(0);
  assert.equal(f.calls.length, 1, 'the settling read is applied before the next one is armed');
  await f.tick(1);
  assert.equal(f.calls.length, 2, 'and the account returns to its schedule once it settles');
});

test('usage poller: a gate failure that lands after a reload degrades nothing', async t => {
  // reload の前に始まった検証の GET が reload の後に失敗して着いても、その結果は古い状態の話なので
  // 何にも反映しない（失敗の数にも、縮退の記録にも、プールにも）。
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => (index === 0
    ? new Promise(resolve => { release = () => resolve(httpError(500)); })
    : usageResponse(clock, { used: 10 })) });
  const key = 'home:0';
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1, 'the gate read is in flight');
  f.poller.configure(f.entries, f.config); // The state object is rebuilt under it.
  release();
  await f.tick(0);
  assert.equal(f.poller.accountHealth(key).observationDegraded, false);
  assert.equal(f.poller.accountHealth(key).observationErrorCode, null, 'and it is not counted as a failure');
  assert.equal(f.observed.length, 0);
  assert.equal(f.poller.observation().gate, 'pending', 'the fresh gate is still owed its own read');
  await f.tick(30_000);
  assert.equal(f.calls.length, 2, 'the reloaded state runs the gate again');
  assert.equal(f.poller.observation().gate, 'passed');
  assert.equal(f.poller.accountHealth(key).observationDegraded, false);
  assert.equal(f.view(key).freshnessMs, 125_000);
});

test('usage poller: an account degraded before a reload clears on the first success after it', async t => {
  // 縮退の記録を外すのも口座ごとで、成功1回で外れる。reload をまたいで遅れて着いた古い状態の
  // 成功は、その代わりにならない（観測にも数えない）。
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => (index === 1
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock, { used: 10 })); })
    : index === 0 ? httpError(500) : usageResponse(clock, { used: 10 })) });
  const key = 'home:0';
  await f.start();
  await f.tick(1);
  assert.equal(f.poller.accountHealth(key).observationDegraded, true, 'the failed gate degrades the account');
  await f.tick(60_000); // The backoff read starts and hangs.
  assert.equal(f.calls.length, 2);
  f.poller.configure(f.entries, f.config);
  assert.equal(f.poller.accountHealth(key).observationDegraded, false, 'the reload re-runs the gate and clears the record');
  release();
  await f.tick(0);
  assert.equal(f.observed.length, 0, 'a reading from the previous state is not published to the pool');
  assert.equal(f.poller.observation().gate, 'pending', 'nor does it pass the fresh gate');
  await f.tick(30_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.poller.observation().gate, 'passed', 'the new state earns the gate with its own read');
  assert.equal(f.poller.accountHealth(key).observationDegraded, false);
});

test('usage poller: at most two accounts are read at a time and the third waits for a free slot', async t => {
  const pending = [];
  const f = await fixture(t, { accounts: 3, respond: ({ clock }) =>
    new Promise(resolve => { pending.push(() => resolve(usageResponse(clock))); }) });
  await f.start();
  await f.tick(1);
  assert.deepEqual(f.calls.map(call => call.account), ['zz-home-0', 'zz-home-1']);
  await f.tick(60_000);
  assert.equal(f.calls.length, 2, 'the third account waits while two reads are in flight');
  pending.shift()();
  await f.tick(0);
  assert.equal(f.calls.length, 3, 'a settled read frees its slot for the waiting account');
  assert.equal(f.calls[2].account, 'zz-home-2');
});

test('usage poller: a read in flight while the pool is reconfigured applies nothing', async t => {
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => (index === 0
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock, { used: 99 })); })
    : usageResponse(clock, { used: 10 })) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  f.pool.configure(f.config, f.clock.now()); // Only the pool's configuration generation moves on.
  release();
  await f.tick(0);
  assert.equal(f.observed.length, 0, 'the reading describes the previous configuration');
  assert.equal(f.account('home:0').capped, undefined);
  assert.equal(f.poller.accountHealth('home:0').observationErrorCode, null);
  assert.equal(f.poller.observation().gate, 'pending', 'nor does it pass the gate');
  await f.tick(60_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.observed.length, 1, 'the next read, begun under the new generation, is applied');
  assert.equal(f.poller.observation().gate, 'passed');
});

test('usage poller: a read in flight while the credential file changes applies nothing', async t => {
  let release;
  const f = await fixture(t, { accounts: 1, respond: ({ clock, index }) => (index === 0
    ? new Promise(resolve => { release = () => resolve(usageResponse(clock, { used: 99 })); })
    : usageResponse(clock, { used: 10 })) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  f.setEpoch('home:0', 2); // auth.json was rewritten while the GET was in flight.
  release();
  await f.tick(0);
  assert.equal(f.observed.length, 0, 'the reading was made with credentials that are no longer on disk');
  assert.equal(f.account('home:0').capped, undefined);
  assert.equal(f.poller.accountHealth('home:0').observationErrorCode, null);
  assert.equal(f.poller.observation().gate, 'pending');
  await f.tick(60_000);
  assert.equal(f.observed.length, 1, 'the next read, begun with the new file, is applied');
});

test('usage poller: removing an account aborts its read in flight and never reads it again', async t => {
  let aborted = false;
  const f = await fixture(t, { respond: ({ account, clock, signal }) => (account === 'zz-home-1'
    ? new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    })
    : usageResponse(clock)) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 2);
  assert.equal(aborted, false, 'the read of the second account is still in flight');
  f.poller.configure([f.entries[0]], f.config);
  assert.equal(aborted, true, 'the removed account read is interrupted at once');
  await f.tick(0);
  assert.equal(f.observed.filter(line => line.key === 'home:1').length, 0);
  assert.equal(f.poller.accountHealth('home:1').observationGate, 'not-required', 'no state is kept for it');
  await f.tick(600_000);
  assert.equal(f.reads('zz-home-1'), 1, 'and it is never scheduled again');
  assert.ok(f.reads('zz-home-0') > 1);
});

test('usage poller: an unexpected exception outside the credential read is recorded as internal-error, never as unreadable credentials', async t => {
  const f = await fixture(t, { accounts: 1, respond: () => assert.fail('the injected reader sends nothing'),
    readUsage: async () => { throw new TypeError('zz-marker-internal-error'); } });
  const key = 'home:0';
  await f.start();
  await f.tick(1);
  await f.tick(60_000);
  await f.tick(120_000);
  assert.equal(f.credentialReads.length, 3, 'the credentials were read fine each time');
  assert.equal(f.account(key).state, 'ready', 'three cycles of a program error are not unreadable credentials');
  assert.equal(f.poller.accountHealth(key).observationErrorCode, 'internal-error');
  assert.equal(f.poller.accountHealth(key).observationDegraded, true, 'it is still an observation failure');
  assert.deepEqual(f.logged('codex_usage_internal_error').map(line => ({ level: line.level, ...line.fields })),
    Array.from({ length: 3 }, () => ({ level: 'error', account_label: 'zz-0' })));
  // info は同じ失敗を60秒の間は繰り返さない: +1ms と +180001ms の2回（+60001ms はちょうど60秒で抑える側）。
  assert.deepEqual(f.logged('codex_usage_unavailable').map(line => line.fields.observation_result),
    ['internal-error', 'internal-error']);
  assert.equal(f.logged('codex_credentials_unavailable').length, 0);
  assert.equal(JSON.stringify(f.logs).includes('zz-marker-internal-error'), false, 'the exception message is not logged');
});

test('usage poller: completeness is the reader\'s verdict alone; a response with no window at all is window-absent', async t => {
  // 完全かどうかに primary 窓の有無を足さない（primary 窓の無い応答は usage-pipeline.test.js で確かめる）。
  // 窓が1つも無い応答は正規化が不完全と判定し、理由の語は window-absent になる。
  const f = await fixture(t, { accounts: 1, respond: () => new Response(JSON.stringify({ rate_limit: { allowed: true } }),
    { status: 200, headers: { 'content-type': 'application/json' } }) });
  await f.start();
  await f.tick(1);
  assert.equal(f.observed.length, 1);
  assert.equal(f.observed[0].meta.complete, false);
  assert.equal(f.poller.accountHealth('home:0').observationErrorCode, 'window-absent');
  assert.equal(f.poller.observation().gate, 'failed');
});

// --- ログ（読取ごとの debug と、停止・解除・読めないこと・ログイン切れの info） ---

test('usage poller: a successful read logs one debug line with the reading and never the client identity', async t => {
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock, { used: 42, secondary: 7 }) });
  await f.start();
  await f.tick(1);
  assert.equal(f.logs.length, 1, 'a healthy read is debug only -- nothing is announced at info');
  const [line] = f.logged('codex_usage_read');
  assert.equal(line.level, 'debug');
  assert.deepEqual(line.fields, { account_label: 'zz-0', observation_result: 'success', usage_read_duration_ms: 0,
    usage_read_status: 200, observation_age_ms: undefined, used_percent: 42, ordinary_usage_allowed: true });
  await f.tick(60_000);
  assert.equal(f.logged('codex_usage_read')[1].fields.observation_age_ms, 60_000, 'the gap since the last success');
  const text = JSON.stringify(f.logs);
  for (const secret of [fakeUserAgent, fakeOriginator, 'e30.e30.sig']) assert.equal(text.includes(secret), false);
});

test('usage poller: the stop and its release are each announced once with the applied policy', async t => {
  let used = 80;
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock, { used }) });
  await f.start();
  await f.tick(1);
  assert.deepEqual(f.logged('codex_usage_capped').map(line => line.fields),
    [{ account_label: 'zz-0', used_percent: 80, stop_used_percent: 75 }]);
  assert.equal(f.logged('codex_usage_capped')[0].level, 'info');
  await f.tick(60_000);
  assert.equal(f.logged('codex_usage_capped').length, 1, 'a stop that is already latched is not re-announced');
  used = 70;
  await f.tick(60_000); // first resume vote,
  assert.equal(f.logged('codex_usage_recovered').length, 0, 'one vote is not a recovery');
  await f.tick(60_000); // second vote: the latch opens.
  assert.equal(f.account('home:0').capped, undefined);
  assert.deepEqual(f.logged('codex_usage_recovered').map(line => line.fields),
    [{ account_label: 'zz-0', used_percent: 70, resume_used_percent: 70 }]);
  assert.equal(f.logged('codex_usage_recovered')[0].level, 'info');
});

test('usage poller: the same failure is not repeated to info within 60s, a different one is announced at once', async t => {
  let status = 500;
  const f = await fixture(t, { accounts: 1, respond: () => httpError(status) });
  await f.start();
  await f.tick(1);
  assert.deepEqual(f.logged('codex_usage_unavailable').map(line => ({ ...line.fields, level: line.level })),
    [{ level: 'info', account_label: 'zz-0', observation_result: 'server-error' }]);
  // A reload re-runs the gate, so a second failure lands inside the same minute
  // (the per account floor of 30s is the soonest a read can follow another).
  status = 429;
  f.poller.configure(f.entries, f.config);
  await f.tick(30_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.logged('codex_usage_unavailable').length, 2, 'a different failure is announced without waiting');
  assert.equal(f.logged('codex_usage_unavailable')[1].fields.observation_result, 'rate-limited');
  f.poller.configure(f.entries, f.config);
  await f.tick(30_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.logged('codex_usage_unavailable').length, 2, 'the same failure stays out of info for 60s');
  assert.equal(f.logged('codex_usage_read').length, 3, 'every read is still recorded at debug');
  assert.deepEqual(f.logged('codex_usage_read').map(line => line.fields.observation_result),
    ['server-error', 'rate-limited', 'rate-limited']);
  await f.tick(60_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.logged('codex_usage_unavailable').length, 3, 'past the interval the ongoing failure is announced again');
});

test('usage poller: the steady backoff never repeats the same failure at the 60s boundary', async t => {
  // 失敗の間隔は 60→120→300 秒。1段目は続けて出さない間隔と同じ60秒ちょうどなので、境界を
  // 含めて抑えないと、続いている同じ失敗が読取のたびに info に並ぶ。
  const f = await fixture(t, { accounts: 1, respond: () => httpError(500) });
  await f.start();
  await f.tick(1);
  assert.equal(f.logged('codex_usage_unavailable').length, 1);
  await f.tick(60_000);
  assert.equal(f.calls.length, 2, 'the account is read again after the first backoff');
  assert.equal(f.logged('codex_usage_unavailable').length, 1, 'the 60s boundary itself is still inside the interval');
  await f.tick(120_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.logged('codex_usage_unavailable').length, 2, 'past the interval the ongoing failure returns to info');
  await f.tick(300_000);
  assert.equal(f.calls.length, 4);
  assert.equal(f.logged('codex_usage_unavailable').length, 3);
  assert.deepEqual(f.logged('codex_usage_unavailable').map(line => ({ ...line.fields, level: line.level })),
    Array.from({ length: 3 }, () => ({ level: 'info', account_label: 'zz-0', observation_result: 'server-error' })));
  assert.equal(f.logged('codex_usage_read').length, 4, 'every read is still recorded at debug');
});

test('usage poller: every recorded field survives the codex-rotator logger allow list', async t => {
  // 許可リストに無いキーは黙って捨てられる。偽の受け手ではそれを見抜けないので、本物の
  // ロガーを通した行を読み直して確かめる。
  const records = [];
  const logger = createCodexLogger({ level: 'debug', write: line => records.push(JSON.parse(line)) });
  let status = 200;
  const f = await fixture(t, { accounts: 1, log: (level, event, fields) => logger[level](event, fields),
    respond: ({ clock }) => status === 200 ? usageResponse(clock, { used: 80, secondary: 7 }) : httpError(status) });
  await f.start();
  await f.tick(1);
  const read = records.find(record => record.event === 'codex_usage_read');
  assert.equal(read.level, 'debug');
  assert.deepEqual(Object.keys(read).sort(), ['account_label', 'event', 'level', 'observation_result',
    'ordinary_usage_allowed', 'ts', 'usage_read_duration_ms', 'usage_read_status', 'used_percent'].sort());
  assert.deepEqual([read.account_label, read.observation_result, read.usage_read_status, read.used_percent,
    read.ordinary_usage_allowed], ['zz-0', 'success', 200, 80, true]);
  const capped = records.find(record => record.event === 'codex_usage_capped');
  assert.deepEqual(Object.keys(capped).sort(),
    ['account_label', 'event', 'level', 'stop_used_percent', 'ts', 'used_percent'].sort());
  assert.deepEqual([capped.level, capped.account_label, capped.used_percent, capped.stop_used_percent],
    ['info', 'zz-0', 80, 75]);
  status = 401;
  await f.tick(60_000);
  await f.tick(60_000);
  const unavailable = records.find(record => record.event === 'codex_usage_unavailable');
  assert.deepEqual(Object.keys(unavailable).sort(), ['account_label', 'event', 'level', 'observation_result', 'ts'].sort());
  const login = records.find(record => record.event === 'codex_auth_needs_login');
  assert.deepEqual(Object.keys(login).sort(), ['account_label', 'event', 'level', 'reason', 'ts'].sort());
  assert.deepEqual([login.level, login.account_label, login.reason], ['info', 'zz-0', 'upstream-unauthorized']);
  const text = records.map(record => JSON.stringify(record)).join('\n');
  for (const secret of [fakeUserAgent, fakeOriginator, 'e30.e30.sig', f.isolation.root]) {
    assert.equal(text.includes(secret), false);
  }
});

// --- User-Agent と originator（依存から受け取る） ---

test('usage poller: the client identity it is handed goes into the GET headers as it is', async t => {
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock) });
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers['User-Agent'], fakeUserAgent);
  assert.equal(f.calls[0].headers.originator, fakeOriginator);
  assert.equal(f.identityCalls.length, 1, 'the identity is asked for on each read (caching is the resolver\'s job)');
  assert.throws(() => createUsagePoller({ pool: f.pool }), /resolveClientIdentity/);
});

// 空白だけの値（ヘッダの値を文字列リテラルで直書きしない決まりに合わせて、組み立てて作る）。
const blankValue = ' '.repeat(2);
for (const [name, identity, reason] of [
  ['no executable', { userAgent: null, originator: null, reason: 'codex-cli-missing' }, 'codex-cli-missing'],
  ['an unreadable version', { reason: 'codex-version-unreadable' }, 'codex-version-unreadable'],
  ['a User-Agent without an originator', { userAgent: fakeUserAgent, originator: blankValue }, 'codex-version-unreadable'],
  ['an unknown reason word', { reason: 'zz-some-other-reason' }, 'codex-version-unreadable'],
  ['a resolver that throws', new Error('zz-marker-resolver-error'), 'codex-version-unreadable'],
]) {
  test(`usage poller: ${name} sends no GET, records ${reason} and leaves the login count alone`, async t => {
    const f = await fixture(t, { accounts: 1, respond: () => assert.fail('no usage GET without a client identity') });
    f.setIdentity(identity);
    await f.start();
    await f.tick(1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.poller.accountHealth('home:0').observationErrorCode, reason);
    assert.deepEqual(f.logged('codex_usage_unavailable').map(line => line.fields),
      [{ account_label: 'zz-0', observation_result: reason }]);
    assert.equal(f.account('home:0').state, 'ready', 'no GET was sent, so nothing is counted against the login');
    assert.equal(JSON.stringify(f.logs).includes('zz-marker-resolver-error'), false);
    await f.tick(60_000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.account('home:0').state, 'ready');
  });
}

// --- ログイン切れの規則と組み合わせた件 ---

test('usage poller: two 401s make needs login, no GET or credential read while it lasts, and the recheck restores it', async t => {
  let status = 401;
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => status === 200 ? usageResponse(clock) : httpError(status) });
  const key = 'home:0';
  await f.start();
  await f.tick(1);
  assert.equal(f.account(key).state, 'ready', 'one 401 is not enough');
  await f.tick(60_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.account(key).state, 'needs-login');
  assert.equal(f.account(key).authReason, 'upstream-unauthorized');
  const reads = f.credentialReads.length;
  await f.tick(599_999);
  assert.equal(f.calls.length, 2, 'no usage GET while the account needs a login');
  assert.equal(f.credentialReads.length, reads, 'and the credential file is not read either');
  await f.tick(1);
  assert.equal(f.calls.length, 3, 'the recheck interval sends exactly one GET');
  assert.equal(f.account(key).state, 'needs-login', 'refused again: it stays');
  status = 200;
  await f.tick(599_999);
  assert.equal(f.calls.length, 3);
  await f.tick(1);
  assert.equal(f.calls.length, 4);
  assert.equal(f.account(key).state, 'ready', 'a 2xx at the recheck brings it back');
  assert.deepEqual(f.logged('codex_auth_recovered').map(line => line.fields), [{ account_label: 'zz-0' }]);
  await f.tick(60_000);
  assert.equal(f.calls.length, 5, 'and the account is back on the poll interval');
});

test('usage poller: a credential file update opens the recheck early', async t => {
  let status = 401;
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => status === 200 ? usageResponse(clock) : httpError(status) });
  const key = 'home:0';
  await f.start();
  await f.tick(1);
  await f.tick(60_000);
  assert.equal(f.account(key).state, 'needs-login');
  await f.tick(180_000);
  assert.equal(f.calls.length, 2);
  f.setEpoch(key, 2); // A new login rewrote auth.json.
  status = 200;
  await f.tick(60_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.account(key).state, 'ready');
});

test('usage poller: an expired access token sends no GET and makes needs login at once', async t => {
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock) });
  const key = 'home:0';
  f.failCredentials(new CredentialsError('send credentials expired', 'file'));
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 0, 'no GET is sent with an expired token');
  assert.equal(f.account(key).state, 'needs-login');
  assert.equal(f.account(key).authReason, 'access-token-expired');
  assert.equal(f.poller.accountHealth(key).observationErrorCode, 'credentials-expired');
  assert.deepEqual(f.logged('codex_usage_unavailable').map(line => line.fields),
    [{ account_label: 'zz-0', observation_result: 'credentials-expired' }]);
  assert.deepEqual(f.logged('codex_auth_needs_login').map(line => line.fields),
    [{ account_label: 'zz-0', reason: 'access-token-expired' }]);
  await f.tick(300_000);
  assert.equal(f.calls.length, 0);
  // The CLI refreshes the token: auth.json changes and the next cycle reads and confirms it.
  f.failCredentials(null);
  f.setEpoch(key, 2);
  await f.tick(60_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.account(key).state, 'ready');
});

test('usage poller: unreadable credentials hold for one cycle and become no creds on the second', async t => {
  const f = await fixture(t, { accounts: 1, respond: ({ clock }) => usageResponse(clock) });
  const key = 'home:0';
  f.failCredentials(new CredentialsError('credentials identity unavailable', 'file'));
  await f.start();
  await f.tick(1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.account(key).state, 'ready', 'one unreadable cycle is held');
  await f.tick(60_000);
  assert.equal(f.account(key).state, 'credentials-unavailable');
  assert.equal(f.poller.accountHealth(key).observationErrorCode, 'credentials-unavailable');
  f.failCredentials(null);
  await f.tick(120_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.account(key).state, 'ready');
});

test('usage poller: two 403s make needs login when another account succeeded in the same cycle', async t => {
  const f = await fixture(t, { respond: ({ account, clock }) => account === 'zz-home-0' ? httpError(403) : usageResponse(clock) });
  await f.start();
  await f.tick(1);
  assert.equal(f.account('home:0').state, 'ready', 'one 403 is not enough');
  await f.tick(60_000);
  assert.equal(f.account('home:0').state, 'needs-login');
  assert.equal(f.account('home:0').authReason, 'upstream-forbidden');
  assert.equal(f.account('home:1').state, 'ready');
  const reads = f.reads('zz-home-0');
  await f.tick(300_000);
  assert.equal(f.reads('zz-home-0'), reads, 'no GET for the refused account until its recheck');
});

test('usage poller: a success in the previous cycle does not corroborate a 403 (the other read lands 1s late)', async t => {
  // A は毎回 403。B は最初の読取の応答が 1 秒遅れて成功し、次の周期は 503。A の2回目の 403
  // （+60001ms）の周期には、どの口座の成功も無い。
  let otherCalls = 0;
  let releaseOther;
  const f = await fixture(t, { respond: ({ account, clock }) => {
    if (account === 'zz-home-0') return httpError(403);
    otherCalls++;
    if (otherCalls === 1) return new Promise(resolve => { releaseOther = () => resolve(usageResponse(clock)); });
    return httpError(503);
  } });
  await f.start();
  await f.tick(1); // A 403 at +1ms, B in flight
  await f.tick(1_000);
  releaseOther();
  await f.tick(0); // B succeeds at +1001ms
  assert.equal(f.account('home:1').state, 'ready');
  await f.tick(59_000); // +60001ms: A's second 403
  assert.equal(f.reads('zz-home-0'), 2);
  assert.equal(f.account('home:0').state, 'ready', 'the success 59s earlier belongs to the previous cycle');
  await f.tick(1_000); // +61001ms: B fails
  assert.equal(f.reads('zz-home-1'), 2);
  assert.equal(f.account('home:0').state, 'ready');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
});

test('usage poller: when every account fails, a run of 403s never makes needs login', async t => {
  const f = await fixture(t, { respond: ({ account }) => account === 'zz-home-0' ? httpError(403) : httpError(500) });
  await f.start();
  await f.tick(1);
  for (let i = 0; i < 6; i++) await f.tick(300_000);
  assert.ok(f.reads('zz-home-0') >= 5);
  assert.equal(f.account('home:0').state, 'ready');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
});

test('usage poller: connection failures, 5xx and 429 never make needs login however long they last', async t => {
  // 読取の期限切れ（timeout）は読取器の本物のタイマーで起きるので、ここでは同じ network-error の
  // 分類になる接続の失敗で代える。期限切れの分類そのものは auth-tracker.test.js で確かめる。
  let index = 0;
  const failures = [() => Promise.reject(Object.assign(new Error('zz-connection-reset'), { code: 'ECONNRESET' })),
    () => httpError(503), () => httpError(429)];
  const f = await fixture(t, { accounts: 1, respond: () => failures[index++ % failures.length]() });
  await f.start();
  await f.tick(1);
  for (let i = 0; i < 12; i++) await f.tick(300_000);
  assert.ok(f.calls.length >= 10);
  assert.equal(f.account('home:0').state, 'ready');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
});

// --- 構造: 生成の成功の遷移・試し打ち・プール全体の切替を使わない ---

test('usage poller and auth tracker: no generation success, no probe and no pool-wide switch in the source', async () => {
  for (const file of ['usage-poller.js', 'auth-tracker.js']) {
    const source = await readFile(join(SOURCE_DIR, file), 'utf8');
    for (const forbidden of ['succeeded(', '.probe(', 'refundProbe', 'usageDegraded', 'pool.configure(', 'onModeChange']) {
      assert.equal(source.includes(forbidden), false, `${file} must not contain ${forbidden}`);
    }
  }
});
