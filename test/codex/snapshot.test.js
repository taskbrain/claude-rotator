// 状態の射影（src/codex/snapshot.js）のテスト。
//
// 主な確かめ:
//   - 観測結果の種類ごとの期待値の表（OBSERVATION_ROWS の41行）: 使用量の観測結果が、口座の状態語・
//     4つの状態・reason と、プール全体の pool.state へどう射影されるか。前提は1口座のプール（方針は
//     停止 75・復帰 60・不明時に止めない）で、偽の時計の上で本物の取得処理（usage-poller.js）を
//     動かし、上流は fetchImpl に渡す偽物（または差し替えた読取関数）だけにする。各行の射影が
//     スキーマ検査を通ることも確かめる。
//   - 複数の口座のときの pool.state の表（POOL_ROWS の10行）。
//   - 実効残量の境界の表（AGGREGATE_ROWS の17行）と、窓ごとの合計。
//   - プールを作る関数が、作るときと configure() のたびに使用量の GET の方式を渡すこと。
//   - 余分なキー・ダミーのメールアドレス形式とトークン形式の文字列が JSON に出ないこと。
//
// 取得処理を動かすテストは隔離の補助（helpers/isolation.js）を通す。プールだけを使うテストは I/O が
// 無いので通さない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createCodexAccountPool, USAGE_AUTH_REJECTION_REASONS } from '../../src/codex/account-pool.js';
import { CLIENT_IDENTITY_REASON, USER_AGENT_SOURCE } from '../../src/codex/client-version.js';
import { CODEX_ACCOUNT_LABEL, CodexConfigError, validateCodexConfig } from '../../src/codex/config.js';
import { createCodexEventLog } from '../../src/codex/events.js';
import {
  CODEX_USAGE_OBSERVATION_MODE, aggregateCodexAccounts, codexAccountHeadroom, createCodexPool, projectCodexStatus,
} from '../../src/codex/snapshot.js';
import { readCodexUsage } from '../../src/codex/usage.js';
import { createUsagePoller } from '../../src/codex/usage-poller.js';
import {
  CODEX_ACCOUNT_REASONS, CODEX_LABEL_PATTERN, CODEX_STATE_OF_WORD, CODEX_USER_AGENT_SOURCES, codexIsoTime,
  codexStatusProblem,
} from '../../src/shared/codex-status-schema.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const MIN = 60_000;
const FIVE_HOURS_S = 18_000;
const WEEK_S = 604_800;
// 合成の User-Agent と originator（値は検査されず、空でなければよい）。
const FAKE_USER_AGENT = 'zz-fake-ua';
const FAKE_ORIGINATOR = 'zz-fake-originator';
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
const RESERVED_POLICY = Object.freeze({ ...POLICY, blockWhenUnknown: true });
const TIMING = Object.freeze({ usagePollIntervalMs: 60_000, usageReadTimeoutMs: 5000, rotationObservationTtlMs: 125_000,
  rotationUsageCapNoResetProbeMs: 3_600_000 });
// clock.advance は同期で、読取の続き（マイクロタスクと本文の読取）を流さない。
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };
const keyOf = label => `zz-key:${label}`;
const E = (stateWord, state, reason, poolState) => ({ stateWord, state, reason, poolState });

// --- 上流の偽物 -------------------------------------------------------------------------------

// 上流の窓（今の秒を受けて JSON の窓を返す）。
const upstreamWindow = (used, seconds, resetIn = 3_600) => nowSec => ({ used_percent: used, limit_window_seconds: seconds,
  reset_after_seconds: resetIn, reset_at: nowSec + resetIn });
const fiveHour = (used, resetIn) => upstreamWindow(used, FIVE_HOURS_S, resetIn);
const weekly = (used, resetIn = 86_400) => upstreamWindow(used, WEEK_S, resetIn);

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
}

/** 使用量の応答。allowed に null を渡すと allowed が読めない応答になる。 */
function usageResponse(clock, { allowed = true, primary, secondary } = {}) {
  const nowSec = Math.floor(clock.now() / 1000);
  return jsonResponse({ rate_limit: { allowed,
    ...(primary ? { primary_window: primary(nowSec) } : {}),
    ...(secondary ? { secondary_window: secondary(nowSec) } : {}) } });
}

const statusOnly = status => () => new Response(null, { status });
// 中断されるまで返らない読取（中断で reject する）。
const untilAborted = ({ init }) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
});
const unreadableCredentials = async () => { throw new Error('zz-fake-unreadable'); };
const identityUnavailable = reason => async () => ({ userAgent: null, originator: null, source: null, reason });

// --- 読取器の期限を偽の時計に載せる ---------------------------------------------------------------
//
// 本物の読取器（readCodexUsage）は、渡された期限で実時間のタイマーを作る。偽の時計で中断を待つテストでは、
// 負荷で待ちが長引くと実時間の期限が先に来て結果が変わりうる。そこで、本物の読取器へ渡す期限をタイマーの
// 上限（約24.8日。どのテストより長い）にして実時間の期限が来ないようにし、代わりの期限を偽の
// スケジューラに置く。偽の時計が期限を過ぎたら、上流への要求を期限切れの印（USAGE_READ_TIMEOUT）で
// 終わらせる（本物の読取器はこれを timeout に分類する）。
// 限定: この偽の期限が見るのは、上流への要求が応答のヘッダを返すまでだけ。本文の読取は含まず、期限の
// ときも上流へ渡した signal は中断しない。本文の期限を試すテストを足すときは、この補助を読取全体の
// 期限（本文を読み終えるまで・期限のときは signal も中断する）に直す。
const REAL_TIMER_CEILING_MS = 2_147_483_647;

function withFakeClockDeadline(scheduler, fetchImpl, deadlineMs) {
  return (url, init) => new Promise((resolve, reject) => {
    const timer = scheduler.setTimeout(() => reject(Object.assign(new Error('zz-fake-deadline'),
      { code: 'USAGE_READ_TIMEOUT' })), deadlineMs);
    Promise.resolve().then(() => fetchImpl(url, init)).then(
      value => { scheduler.clearTimeout(timer); resolve(value); },
      error => { scheduler.clearTimeout(timer); reject(error); });
  });
}

// --- 取得処理を動かす補助 -------------------------------------------------------------------------

/**
 * 偽の時計の上で、本物の取得処理と、createCodexPool（rawPool なら方式を渡さないプール）を作る。
 * accounts は { label, policy?, models? } の並び。respond({ clock, account, init, count }) が上流の応答を返す
 * （account は口座のラベル、count はその口座への GET の回数）。readUsage を渡さなければ、本物の読取器を
 * 期限だけ偽の時計に載せて使い、その分類を readResults に残す。ログは logs に残す。
 */
async function harness(t, { accounts = [{ label: 'zz-a' }], respond = () => { throw new Error('zz-no-upstream'); },
  readCredentials, resolveClientIdentity, readUsage, rawPool = false } = {}) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const descriptors = accounts.map(({ label, models = null }) =>
    ({ key: keyOf(label), label, home: join(isolation.root, 'accounts', label), models }));
  const config = { ...TIMING,
    accounts: accounts.map(({ label, policy = POLICY }) => ({ label, usagePolicy: { ...policy } })) };
  const pool = rawPool ? createCodexAccountPool(descriptors, config) : createCodexPool(descriptors, config);
  const events = createCodexEventLog({ now: clock.now });
  const calls = [];
  const attempts = new Map();
  const readResults = [];
  const logs = [];
  const credentialsOf = readCredentials
    ?? (async authPath => ({ accessToken: 'zz-fake-access', accountId: basename(dirname(authPath)) }));
  const reader = readUsage ?? (async options => {
    const result = await readCodexUsage({ ...options, timeoutMs: REAL_TIMER_CEILING_MS,
      fetchImpl: withFakeClockDeadline(scheduler, options.fetchImpl, options.timeoutMs) });
    readResults.push(result.classification);
    return result;
  });
  const poller = createUsagePoller({ pool, now: clock.now, scheduler,
    log: (level, event, fields) => {
      logs.push({ level, event, fields: { ...fields } });
      events.recordLog(level, event, fields);
    },
    credentialEpoch: () => 1,
    resolveClientIdentity: resolveClientIdentity
      ?? (async () => ({ userAgent: FAKE_USER_AGENT, originator: FAKE_ORIGINATOR, source: 'codex-version' })),
    readCredentials: async (authPath, options) => {
      const label = basename(dirname(authPath));
      attempts.set(label, (attempts.get(label) ?? 0) + 1);
      return credentialsOf(authPath, options);
    },
    readUsage: reader,
    fetchImpl: async (url, init) => {
      const account = init.headers['ChatGPT-Account-ID'];
      calls.push({ at: clock.now(), account });
      return respond({ clock, account, init, count: calls.filter(call => call.account === account).length });
    } });
  poller.configure(descriptors, config);
  const h = {
    clock, pool, poller, events, calls, isolation, descriptors, config, readResults, logs,
    attempts: label => attempts.get(label) ?? 0,
    // 取得処理が読取ごとに記録した観測結果の語（debug の codex_usage_read）。
    observationResults: () => logs.filter(record => record.event === 'codex_usage_read')
      .map(record => record.fields.observation_result),
    code: label => poller.accountHealth(keyOf(label)).observationErrorCode,
    project: (overrides = {}) => projectCodexStatus({ enabled: true, pool, poller, userAgentSource: 'codex-version',
      events: events.list(), daemon: { reachable: true, startedAt: START }, source: 'daemon', nowMs: clock.now(),
      ...overrides }),
    async tick(ms) {
      clock.advance(ms);
      await flush();
    },
    // 各口座の読取を n 回ずつ（1回目は起動直後、2回目以降は失敗の間隔の最大より長く空けて）。
    async reads(n) {
      for (let i = 0; i < n; i++) await h.tick(i === 0 ? 1 : 5 * MIN);
      for (const { label } of accounts) assert.equal(h.attempts(label), n, `${label} was read ${n} times`);
    },
  };
  return h;
}

/** 行の期待値と比べる4つの値。スキーマ検査を通ることもここで確かめる。 */
function rowOf(json, label) {
  assert.equal(codexStatusProblem(json), null, 'the projection passes the schema check');
  const account = json.accounts.find(item => item.label === label);
  assert.ok(account, `${label} is projected`);
  return { stateWord: account.stateWord, state: account.state, reason: account.reason, poolState: json.pool.state };
}

/**
 * プールが使用量の GET の方式（http）で動いていることの確かめ方。使用量の分からない ready の口座について、
 * 選択を止める理由が usage-unknown で、select() では選ばれず、最後の手段でだけ選ばれる。受動の方式の
 * プールでは、同じ口座が理由なしで select() に選ばれ、最後の手段は null になるので、この検査は失敗する。
 */
function assertUsageGetObservation(pool, key, nowMs) {
  const view = pool.inspect(nowMs).find(item => item.key === key);
  assert.equal(view.selectionBlockReason, 'usage-unknown', 'an account of unknown usage is blocked');
  assert.equal(pool.select(undefined, nowMs), null, 'select() does not pick an account of unknown usage');
  assert.equal(pool.lastResort(undefined, nowMs)?.key, key, 'only the last resort picks it');
}

// --- 観測結果の種類ごとの期待値の表（41行） --------------------------------------------------------
//
// row: 表の行番号。result: 観測結果の語（取得処理の observationErrorCode。成功は null）。
// scenario(t) はその観測結果が1回起きた直後（条件の列のとおり）の補助を返す。check(t) を持つ行は、
// その行だけの確かめ方をする（到達しない行・状態が変わらない行・陰性対照）。

const success = (primary, secondary, allowed = true) => ({ clock }) => usageResponse(clock, { allowed, primary, secondary });

const OBSERVATION_ROWS = [
  { row: 1, result: 'success', condition: 'complete, allowed:true, every window below 75', code: null,
    expect: E('ready', 'available', null, 'ok'),
    async scenario(t) {
      const h = await harness(t, { respond: success(fiveHour(10), weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 2, result: 'success', condition: 'complete, allowed:true, a window at 75 or above', code: null,
    expect: E('held', 'exhausted', 'usage-capped', 'exhausted'),
    async scenario(t) {
      const h = await harness(t, { respond: success(fiveHour(80), weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 3, result: 'success', condition: 'an account whose stop line is 100 with a window at 100', code: null,
    expect: E('capped', 'exhausted', 'usage-capped', 'exhausted'),
    async scenario(t) {
      const h = await harness(t, { accounts: [{ label: 'zz-a', policy: { ...POLICY, stopUsedPercent: 100 } }],
        respond: success(fiveHour(100), weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 4, result: 'success', condition: 'complete, allowed:false', code: null,
    expect: E('blocked', 'exhausted', 'upstream-blocked', 'exhausted'),
    async scenario(t) {
      const h = await harness(t, { respond: success(fiveHour(10), weekly(20), false) });
      await h.reads(1);
      return h;
    } },
  { row: 5, result: '(after the event window-cap-dropped)',
    condition: 'the stopped window is missing from two complete reads in a row after its reset: no window stop is left',
    code: null, expect: E('held', 'exhausted', 'usage-capped', 'exhausted'),
    async scenario(t) {
      // 週次窓 80% で停止（リセットは10分後）。その後は5時間窓だけの応答（65%: 停止線の下で復帰線の上なので
      // 復帰の票にならない）。リセットを過ぎた欠落で週次窓の停止だけが外れ、口座は復帰待ちで止まったまま。
      const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, count === 1
        ? { primary: fiveHour(65), secondary: weekly(80, 600) } : { primary: fiveHour(65) }) });
      await h.tick(1);
      for (let i = 0; i < 10; i++) await h.tick(MIN);
      assert.equal(h.clock.now(), START + 600_001);
      return h;
    },
    extra(h, json) {
      const account = json.accounts[0];
      assert.deepEqual(account.latch, { stopped: true, cappedWindows: [], upstreamBlocked: false, cleanReadsDone: 0,
        cleanReadsNeeded: 2, since: codexIsoTime(START + 1) });
      assert.equal(account.windows.weekly, null, 'the dropped window is gone');
      assert.equal(account.windows.fiveHour.usedPercent, 65);
      assert.deepEqual(h.events.list().map(({ type, label }) => [type, label]),
        [['stopped', 'zz-a'], ['window-cap-dropped', 'zz-a']], 'the drop is one event, and nothing was released');
      assert.deepEqual(json.events.map(event => event.type), ['stopped', 'window-cap-dropped']);
    } },
  { row: 6, result: 'allowed-unusable', condition: 'usage below 75', code: 'allowed-unusable',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: success(fiveHour(10), weekly(20), null) });
      await h.reads(1);
      return h;
    } },
  { row: 7, result: 'allowed-unusable', condition: 'usage at 75 or above (an incomplete reading still stops)',
    code: 'allowed-unusable', expect: E('held', 'exhausted', 'usage-capped', 'exhausted'),
    async scenario(t) {
      const h = await harness(t, { respond: success(fiveHour(80), weekly(20), null) });
      await h.reads(1);
      return h;
    } },
  { row: 8, result: 'window-absent', condition: 'allowed:true, no window at all', code: 'window-absent',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: success(undefined, undefined, true) });
      await h.reads(1);
      return h;
    } },
  { row: 9, result: 'window-absent', condition: 'allowed:false, no window at all', code: 'window-absent',
    expect: E('blocked', 'exhausted', 'upstream-blocked', 'exhausted'),
    async scenario(t) {
      const h = await harness(t, { respond: success(undefined, undefined, false) });
      await h.reads(1);
      return h;
    } },
  { row: 10, result: 'used-percent-unusable', condition: 'the other window below 75, allowed:true',
    code: 'used-percent-unusable', expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const broken = nowSec => ({ ...fiveHour(10)(nowSec), used_percent: 'zz' });
      const h = await harness(t, { respond: success(broken, weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 11, result: 'reset-unusable', condition: 'usage below 75, allowed:true', code: 'reset-unusable',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const broken = nowSec => ({ ...fiveHour(10)(nowSec), reset_at: -5 });
      const h = await harness(t, { respond: success(broken, weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 12, result: 'window-length-unusable', condition: 'usage below 75, allowed:true', code: 'window-length-unusable',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const broken = nowSec => ({ ...fiveHour(10)(nowSec), limit_window_seconds: 0 });
      const h = await harness(t, { respond: success(broken, weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 13, result: 'reset-in-past', condition: 'usage below 75, allowed:true', code: 'reset-in-past',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const past = nowSec => ({ ...fiveHour(10)(nowSec), reset_after_seconds: 0, reset_at: nowSec - 60 });
      const h = await harness(t, { respond: success(past, weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 14, result: 'reset-mismatch', condition: 'usage below 75, allowed:true', code: 'reset-mismatch',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const mismatch = nowSec => ({ ...fiveHour(10)(nowSec), reset_after_seconds: 60, reset_at: nowSec + 3_600 });
      const h = await harness(t, { respond: success(mismatch, weekly(20)) });
      await h.reads(1);
      return h;
    } },
  { row: 15, result: 'incomplete', condition: 'the last catch-all of incomplete readings: not reachable',
    // 到達しない根拠を、本物の読取器と取得処理で確かめる。allowed の3通り（true・false・読めない）と、
    // 2つの窓それぞれの7通り（無い・正常・壊れ方5種）の組合せ147通りを1口座へ順に返し、取得処理が
    // 読取ごとに記録する観測結果の語を見る。どの組合せでも incomplete にならず、語は「allowed が読めない
    // → 窓が無い → 最初に壊れた窓の理由 → 成功」の順で決まる。
    async check(t) {
      const states = {
        absent: () => null,
        normal: base => base,
        'used-percent-unusable': base => ({ ...base, used_percent: 'zz' }),
        'reset-unusable': base => ({ ...base, reset_at: -5 }),
        'window-length-unusable': base => ({ ...base, limit_window_seconds: 0 }),
        'reset-in-past': (base, nowSec) => ({ ...base, reset_after_seconds: 0, reset_at: nowSec - 60 }),
        'reset-mismatch': base => ({ ...base, reset_after_seconds: 60 }),
      };
      const combinations = [];
      for (const allowed of [true, false, null]) {
        for (const primary of Object.keys(states)) {
          for (const secondary of Object.keys(states)) combinations.push({ allowed, primary, secondary });
        }
      }
      const expected = ({ allowed, primary, secondary }) => {
        const present = [primary, secondary].filter(state => state !== 'absent');
        if (typeof allowed !== 'boolean') return 'allowed-unusable';
        if (present.length === 0) return 'window-absent';
        return present.find(state => state !== 'normal') ?? 'success';
      };
      const h = await harness(t, { respond: ({ clock, count }) => {
        const { allowed, primary, secondary } = combinations[count - 1];
        const nowSec = Math.floor(clock.now() / 1000);
        const rateLimit = { allowed };
        const primaryWindow = states[primary](fiveHour(10)(nowSec), nowSec);
        const secondaryWindow = states[secondary](weekly(10)(nowSec), nowSec);
        if (primaryWindow) rateLimit.primary_window = primaryWindow;
        if (secondaryWindow) rateLimit.secondary_window = secondaryWindow;
        return jsonResponse({ rate_limit: rateLimit });
      } });
      assert.equal(combinations.length, 147);
      await h.reads(combinations.length);
      const results = h.observationResults();
      assert.equal(results.length, combinations.length, 'one recorded observation result per read');
      assert.equal(results.filter(result => result === 'incomplete').length, 0, 'incomplete is never recorded');
      assert.deepEqual(results, combinations.map(expected));
      assert.deepEqual(h.readResults.filter(result => result !== 'success'), [], 'every read reached the normalizer');
    } },
  { row: 16, result: 'unauthorized', condition: 'one 401', code: 'unauthorized',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(401) });
      await h.reads(1);
      return h;
    } },
  { row: 17, result: 'unauthorized', condition: 'two 401 in a row', code: 'unauthorized',
    expect: E('needs login', 'login_required', 'upstream-unauthorized', 'needs-login'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(401) });
      await h.reads(2);
      return h;
    },
    extra(h) {
      assert.deepEqual(h.events.list().map(({ type, label }) => [type, label]), [['needs-login', 'zz-a']]);
    } },
  { row: 18, result: 'forbidden', condition: 'a single account (403 is not counted however often it comes)',
    code: 'forbidden', expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(403) });
      await h.reads(3);
      return h;
    } },
  { row: 19, result: 'forbidden', condition: 'two accounts: two 403 in a row while the other account reads fine in the same cycle',
    code: 'forbidden', expect: E('needs login', 'login_required', 'upstream-forbidden', 'degraded'),
    async scenario(t) {
      const h = await harness(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }],
        respond: args => (args.account === 'zz-a' ? new Response(null, { status: 403 })
          : usageResponse(args.clock, { primary: fiveHour(10), secondary: weekly(20) })) });
      await h.tick(1);
      await h.tick(MIN);
      assert.equal(h.attempts('zz-a'), 2);
      return h;
    },
    extra(h, json) {
      assert.equal(rowOf(json, 'zz-b').stateWord, 'ready', 'the other account is ready and selectable');
    } },
  { row: 20, result: 'not-found', condition: '404', code: 'not-found',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(404) });
      await h.reads(1);
      return h;
    } },
  { row: 21, result: 'rate-limited', condition: '429, ten times in a row (never needs login)', code: 'rate-limited',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(429) });
      await h.reads(10);
      return h;
    } },
  { row: 22, result: 'server-error', condition: '5xx', code: 'server-error',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(503) });
      await h.reads(1);
      return h;
    } },
  { row: 23, result: 'client-error', condition: 'another 4xx', code: 'client-error',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(418) });
      await h.reads(1);
      return h;
    } },
  { row: 24, result: 'redirect', condition: '3xx', code: 'redirect',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: statusOnly(302) });
      await h.reads(1);
      return h;
    } },
  { row: 25, result: 'malformed-shape', condition: 'a JSON body of another shape', code: 'malformed-shape',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: () => jsonResponse({ unexpected: true }) });
      await h.reads(1);
      return h;
    } },
  { row: 26, result: 'non-json', condition: 'a body that is not JSON', code: 'non-json',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: () => jsonResponse('<html></html>', { contentType: 'text/html' }) });
      await h.reads(1);
      return h;
    } },
  { row: 27, result: 'body-too-large', condition: 'a body over 64 KiB', code: 'body-too-large',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: () => jsonResponse(`"${'z'.repeat(64 * 1024)}"`) });
      await h.reads(1);
      return h;
    } },
  { row: 28, result: 'timeout', condition: 'the read deadline passes', code: 'timeout',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      // 上流が返らないまま、偽の時計で読取の期限（5秒）を過ぎる。
      const h = await harness(t, { respond: untilAborted });
      await h.tick(1);
      assert.equal(h.poller.accountHealth(keyOf('zz-a')).observationErrorCode, null, 'the read is still in flight');
      await h.tick(TIMING.usageReadTimeoutMs);
      assert.deepEqual(h.readResults, ['network-error']);
      return h;
    } },
  { row: 29, result: 'network', condition: 'the connection fails', code: 'network',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { respond: () => Promise.reject(new Error('zz-fake-network')) });
      await h.reads(1);
      return h;
    } },
  { row: 30, result: 'aborted', condition: 'shutdown, removal of the account or a reload while a read is in flight: nothing is applied',
    async check(t) {
      // 1回目の読取は成功（5時間窓10%・週次窓20%）。2回目の読取は上流が返らないまま止まる。
      const inFlight = async st => {
        let release;
        const h = await harness(st, { respond: args => (args.count === 1
          ? usageResponse(args.clock, { primary: fiveHour(10), secondary: weekly(20) })
          : new Promise((resolve, reject) => {
            release = resolve;
            args.init.signal.addEventListener('abort', () => reject(args.init.signal.reason), { once: true });
          })) });
        await h.tick(1);
        await h.tick(MIN);
        assert.equal(h.calls.length, 2, 'the second read is in flight');
        const before = rowOf(h.project(), 'zz-a');
        assert.deepEqual(before, E('ready', 'available', null, 'ok'));
        return { h, before, release: response => release(response) };
      };
      await t.test('shutdown', async st => {
        const { h, before } = await inFlight(st);
        h.poller.shutdown();
        await flush();
        assert.deepEqual(h.readResults, ['success', 'aborted']);
        assert.equal(h.code('zz-a'), null, 'the aborted read records no observation result');
        assert.deepEqual(rowOf(h.project(), 'zz-a'), before, 'the projection is what it was before');
      });
      await t.test('removal of the account', async st => {
        const { h, before } = await inFlight(st);
        h.poller.configure([], h.config);
        await flush();
        assert.deepEqual(h.readResults, ['success', 'aborted']);
        assert.deepEqual(rowOf(h.project(), 'zz-a'), before, 'the pool is not touched by the aborted read');
        h.poller.shutdown();
      });
      await t.test('reload', async st => {
        // reload は進行中の読取を中断しない。その読取は世代が古いので、後で返っても適用されない。
        const { h, before, release } = await inFlight(st);
        h.pool.configure(h.config, h.clock.now());
        h.poller.configure(h.descriptors, h.config);
        release(usageResponse(h.clock, { primary: fiveHour(90), secondary: weekly(90) }));
        await flush();
        assert.deepEqual(h.readResults, ['success', 'success'], 'the stale read did return');
        assert.equal(h.code('zz-a'), null);
        assert.equal(h.pool.snapshot()[0].windows['len:300'].usedPercent, 10, 'the stale reading is not applied');
        assert.deepEqual(rowOf(h.project(), 'zz-a'), before, 'the projection is what it was before');
        h.poller.shutdown();
      });
    } },
  { row: 31, result: 'internal-error', condition: 'an unexpected exception inside the poller', code: 'internal-error',
    expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { readUsage: async () => { throw new TypeError('zz-fake-internal'); } });
      await h.reads(1);
      return h;
    },
    extra(h) {
      assert.equal(h.pool.snapshot()[0].state, 'unknown', 'the auth state is not moved');
    } },
  { row: 32, result: 'credentials-expired', condition: 'the access token has expired (no read is sent)',
    code: 'credentials-expired', expect: E('needs login', 'login_required', 'access-token-expired', 'needs-login'),
    async scenario(t) {
      const h = await harness(t, { readCredentials: async () => { throw new Error('send credentials expired'); } });
      await h.reads(1);
      assert.equal(h.calls.length, 0);
      return h;
    } },
  { row: 33, result: 'credentials-unavailable', condition: 'the first cycle whose credentials cannot be read',
    code: 'credentials-unavailable', expect: E('unread', 'unknown', 'usage-unknown', 'unknown'),
    async scenario(t) {
      const h = await harness(t, { readCredentials: unreadableCredentials });
      await h.reads(1);
      return h;
    },
    extra(h) {
      assert.equal(h.pool.snapshot()[0].state, 'unknown', 'the account state stays unknown');
    } },
  { row: 34, result: 'credentials-unavailable', condition: 'the second cycle in a row', code: 'credentials-unavailable',
    expect: E('no creds', 'login_required', 'credentials-unavailable', 'credentials-unavailable'),
    async scenario(t) {
      const h = await harness(t, { readCredentials: unreadableCredentials });
      await h.reads(2);
      return h;
    } },
  { row: 35, result: 'codex-cli-missing', condition: 'the executable is not found (no read is sent)',
    code: 'codex-cli-missing', expect: E('unread', 'unknown', 'codex-cli-missing', 'unknown'),
    projectWith: { userAgentSource: null },
    async scenario(t) {
      const h = await harness(t, { resolveClientIdentity: identityUnavailable('codex-cli-missing') });
      await h.reads(1);
      assert.equal(h.calls.length, 0);
      return h;
    },
    extra(h) {
      // 38行（陰性対照）で失敗させる確かめ方が、ここ（プールを作る関数で作ったプール）では通る。
      assertUsageGetObservation(h.pool, keyOf('zz-a'), h.clock.now());
    } },
  { row: 36, result: 'codex-version-unreadable', condition: 'the version cannot be read (no read is sent)',
    code: 'codex-version-unreadable', expect: E('unread', 'unknown', 'codex-version-unreadable', 'unknown'),
    projectWith: { userAgentSource: null },
    async scenario(t) {
      const h = await harness(t, { resolveClientIdentity: identityUnavailable('codex-version-unreadable') });
      await h.reads(1);
      assert.equal(h.calls.length, 0);
      return h;
    } },
  { row: 37, result: 'codex-cli-missing / codex-version-unreadable', condition: 'an account with blockWhenUnknown:true',
    async check(t) {
      for (const cause of ['codex-cli-missing', 'codex-version-unreadable']) {
        await t.test(cause, async st => {
          const h = await harness(st, { accounts: [{ label: 'zz-a', policy: RESERVED_POLICY }],
            resolveClientIdentity: identityUnavailable(cause) });
          await h.reads(1);
          assert.equal(h.code('zz-a'), cause);
          assert.deepEqual(rowOf(h.project({ userAgentSource: null }), 'zz-a'), E('reserved', 'unknown', cause, 'unknown'));
        });
      }
    } },
  { row: 38, result: 'codex-cli-missing', condition: 'negative control: a pool made without the usage GET mode',
    // 35行と同じ場面を、方式を渡さずに作ったプールで起こす。35行の検査と、プールが使用量の GET の
    // 方式で動いていることの確かめ方（35行とプールを作る関数のテストで通るもの）の両方が、ここでは
    // 失敗することを確かめる（方式の渡し忘れを、これらの検査が捕まえる）。
    async check(t) {
      const h = await harness(t, { rawPool: true, resolveClientIdentity: identityUnavailable('codex-cli-missing') });
      await h.reads(1);
      assert.equal(h.code('zz-a'), 'codex-cli-missing');
      const row35 = OBSERVATION_ROWS.find(row => row.row === 35);
      const json = h.project(row35.projectWith);
      assert.equal(codexStatusProblem(json), null);
      assert.throws(() => assert.deepEqual(rowOf(json, 'zz-a'), row35.expect), assert.AssertionError);
      assert.throws(() => assertUsageGetObservation(h.pool, keyOf('zz-a'), h.clock.now()), assert.AssertionError);
    } },
  { row: 39, result: '(state word starting)', condition: 'after the start, before the first read of that account begins',
    async check(t) {
      const h = await harness(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-r', policy: RESERVED_POLICY }],
        respond: untilAborted });
      const json = h.project();
      assert.deepEqual(rowOf(json, 'zz-a'), E('starting', 'unknown', 'usage-unknown', 'unknown'));
      assert.equal(rowOf(json, 'zz-r').stateWord, 'reserved', 'an account whose word is not unread is never starting');
      await h.tick(1);
      assert.equal(h.poller.accountHealth(keyOf('zz-a')).observationGate, 'pending');
      assert.equal(rowOf(h.project(), 'zz-a').stateWord, 'unread', 'once the first read has begun the account is unread');
      h.poller.shutdown();
      await flush();
    } },
  { row: 40, result: '(state word no models)', condition: 'the models of the account are an empty list: not reachable',
    // 到達しない根拠のうち、設定の側を確かめる: 口座に models のキーを書いた設定は、設定の読込が拒否する
    // （読み込んだ口座は label・codexHome・usagePolicy だけを持つ）。常駐が reconcile() へ models を渡さない
    // ことの確かめは、常駐の側のテストで行う。
    async check(t) {
      const { env, root } = await setupCodexIsolation(t);
      const accountsDir = join(root, 'zz-accounts');
      const account = extra => ({ label: 'zz-a', codexHome: join(accountsDir, 'zz-a'), usagePolicy: { ...POLICY }, ...extra });
      for (const models of [[], ['zz-model']]) {
        assert.throws(() => validateCodexConfig({ accountsDir, accounts: [account({ models })] }, { env }),
          error => error instanceof CodexConfigError && /^accounts\[0\] has an unknown key: models$/.test(error.message));
      }
      const loaded = validateCodexConfig({ accountsDir, accounts: [account()] }, { env });
      assert.deepEqual(Object.keys(loaded.accounts[0]).sort(), ['codexHome', 'label', 'usagePolicy']);
    } },
  { row: 41, result: '(account states probing and exhausted)', condition: 'transitions of the sending path: not reachable',
    async check() {
      // 到達しない根拠: src/codex からこれらの遷移を呼ぶ所が0件。
      const dir = new URL('../../src/codex/', import.meta.url);
      const names = (await readdir(dir)).filter(name => name.endsWith('.js'));
      const pattern = /pool\.(exhausted|forbidden|probeFailed|succeeded)\(|recover: *true/g;
      let found = 0;
      for (const name of names) found += ((await readFile(new URL(name, dir), 'utf8')).match(pattern) ?? []).length;
      assert.equal(found, 0);
      // 強制した場合も、スキーマ検査を通る形に射影される。
      const pool = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-a' }, { key: keyOf('zz-p'), label: 'zz-p' }],
        { ...TIMING, accounts: [{ label: 'zz-a', usagePolicy: POLICY }, { label: 'zz-p', usagePolicy: POLICY }] });
      pool.exhausted(keyOf('zz-a'), { resetAt: START + 3_600_000, retryAt: START + MIN }, START);
      pool.forbidden(keyOf('zz-p'), START);
      pool.credentials(keyOf('zz-p'), true, START, { recover: true });
      assert.equal(pool.snapshot()[1].state, 'probing');
      const json = projectCodexStatus({ enabled: true, pool, source: 'daemon', nowMs: START });
      assert.deepEqual(rowOf(json, 'zz-a'), E('exhausted', 'exhausted', 'exhausted', 'unknown'));
      assert.equal(json.accounts[0].resetAt, codexIsoTime(START + 3_600_000));
      assert.equal(rowOf(json, 'zz-p').stateWord, 'unread');
    } },
];

for (const row of OBSERVATION_ROWS) {
  test(`observation row ${row.row}: ${row.result} (${row.condition})`, async t => {
    if (row.check) {
      await row.check(t);
      return;
    }
    const h = await row.scenario(t);
    assert.equal(h.code('zz-a'), row.code, 'the scenario produced the observation result of this row');
    const json = h.project(row.projectWith);
    assert.deepEqual(rowOf(json, 'zz-a'), row.expect);
    row.extra?.(h, json);
  });
}

// 到達しない行（15・40）を、読取関数や口座の記述を差し替えて強制した場合も、安全側の形に射影される。
// 到達しない根拠を確かめるテスト（上の OBSERVATION_ROWS の row 15・row 40 の check）とは別に置く。
test('forced (row 15): an incomplete reading without a reason still projects as unread', async t => {
  const h = await harness(t, { readUsage: async ({ now }) => {
    const at = now();
    return { classification: 'success', failure: null, status: 200, retryAfter: null, errorCode: null,
      startedAt: at, receivedAt: at, durationMs: 0,
      observation: { ordinaryUsageAllowed: true, rateLimitReachedType: null, complete: false, secondary: null,
        primary: { usedPercent: 10, windowResetAt: at + 3_600_000, limitWindowSeconds: FIVE_HOURS_S, complete: true,
          incompleteReason: null } } };
  } });
  await h.reads(1);
  assert.equal(h.code('zz-a'), 'incomplete');
  assert.deepEqual(rowOf(h.project(), 'zz-a'), E('unread', 'unknown', 'usage-unknown', 'unknown'));
});

test('forced (row 40): an account whose models are an empty list projects as no models', async t => {
  const h = await harness(t, { accounts: [{ label: 'zz-a', models: [] }] });
  const { stateWord, state, reason } = rowOf(h.project(), 'zz-a');
  assert.deepEqual({ stateWord, state, reason }, { stateWord: 'no models', state: 'unknown', reason: 'model-unassigned' });
  h.poller.shutdown();
});

test('observation rows: the table has 41 rows and covers every observation result word', () => {
  assert.deepEqual(OBSERVATION_ROWS.map(row => row.row), Array.from({ length: 41 }, (_, i) => i + 1));
  const words = ['aborted', 'allowed-unusable', 'body-too-large', 'client-error', 'codex-cli-missing',
    'codex-version-unreadable', 'credentials-expired', 'credentials-unavailable', 'forbidden', 'incomplete',
    'internal-error', 'malformed-shape', 'network', 'non-json', 'not-found', 'rate-limited', 'redirect', 'reset-in-past',
    'reset-mismatch', 'reset-unusable', 'server-error', 'success', 'timeout', 'unauthorized', 'used-percent-unusable',
    'window-absent', 'window-length-unusable'];
  assert.equal(words.length, 27);
  const covered = new Set(OBSERVATION_ROWS.flatMap(row => row.result.split(' / ')));
  for (const word of words) assert.ok(covered.has(word), word);
});

// --- 複数の口座のときの pool.state（10行） -------------------------------------------------------

const AB = [{ label: 'zz-a' }, { label: 'zz-b' }];
const byAccount = handlers => args => handlers[args.account](args);
const POOL_ROWS = [
  { row: 'P1', combination: 'no account', raw: 'degraded', expect: 'no-account', accounts: [], reads: 0, words: {} },
  { row: 'P2', combination: 'every account ready and selectable', raw: 'ok', expect: 'ok', accounts: AB, reads: 1,
    respond: success(fiveHour(10), weekly(20)), words: { 'zz-a': 'ready', 'zz-b': 'ready' } },
  { row: 'P3', combination: 'ready (selectable) and unread', raw: 'degraded', expect: 'degraded', accounts: AB, reads: 1,
    respond: byAccount({ 'zz-a': success(fiveHour(10), weekly(20)), 'zz-b': statusOnly(503) }),
    words: { 'zz-a': 'ready', 'zz-b': 'unread' } },
  { row: 'P4', combination: 'every account unread', raw: 'degraded', expect: 'unknown', accounts: AB, reads: 1,
    respond: statusOnly(503), words: { 'zz-a': 'unread', 'zz-b': 'unread' } },
  { row: 'P5', combination: 'held and needs login', raw: 'mixed', expect: 'mixed', accounts: AB, reads: 2,
    respond: byAccount({ 'zz-a': success(fiveHour(80), weekly(20)), 'zz-b': statusOnly(401) }),
    words: { 'zz-a': 'held', 'zz-b': 'needs login' } },
  { row: 'P6', combination: 'unread and needs login', raw: 'degraded', expect: 'unknown', accounts: AB, reads: 2,
    respond: byAccount({ 'zz-a': statusOnly(503), 'zz-b': statusOnly(401) }),
    words: { 'zz-a': 'unread', 'zz-b': 'needs login' } },
  { row: 'P7', combination: 'every account needs login', raw: 'needs-login', expect: 'needs-login', accounts: AB, reads: 2,
    respond: statusOnly(401), words: { 'zz-a': 'needs login', 'zz-b': 'needs login' } },
  { row: 'P8', combination: 'every account has no readable credentials', raw: 'credentials-unavailable',
    expect: 'credentials-unavailable', accounts: AB, reads: 2, readCredentials: unreadableCredentials,
    words: { 'zz-a': 'no creds', 'zz-b': 'no creds' } },
  { row: 'P9', combination: 'held and no creds', raw: 'mixed', expect: 'mixed', accounts: AB, reads: 2,
    respond: success(fiveHour(80), weekly(20)),
    readCredentials: async authPath => {
      if (basename(dirname(authPath)) === 'zz-b') throw new Error('zz-fake-unreadable');
      return { accessToken: 'zz-fake-access', accountId: 'zz-a' };
    },
    words: { 'zz-a': 'held', 'zz-b': 'no creds' } },
  { row: 'P10', combination: 'every account held or blocked', raw: 'exhausted', expect: 'exhausted', accounts: AB, reads: 1,
    respond: byAccount({ 'zz-a': success(fiveHour(80), weekly(20)), 'zz-b': success(fiveHour(10), weekly(20), false) }),
    words: { 'zz-a': 'held', 'zz-b': 'blocked' } },
];

for (const row of POOL_ROWS) {
  test(`pool state row ${row.row}: ${row.combination}`, async t => {
    const h = await harness(t, { accounts: row.accounts, respond: row.respond, readCredentials: row.readCredentials });
    await h.reads(row.reads);
    const json = h.project();
    assert.equal(codexStatusProblem(json), null);
    assert.deepEqual(Object.fromEntries(json.accounts.map(account => [account.label, account.stateWord])), row.words);
    assert.equal(h.pool.health(h.clock.now()).state, row.raw, 'the raw pool state');
    assert.equal(json.pool.state, row.expect, 'the projected pool state');
  });
}

test('pool state rows: the table has ten rows', () => {
  assert.deepEqual(POOL_ROWS.map(row => row.row), Array.from({ length: 10 }, (_, i) => `P${i + 1}`));
});

// --- プールを作る関数 ------------------------------------------------------------------------------

test('pool: createCodexPool passes the usage GET mode when it creates the pool and on every configure()', () => {
  const entries = [{ key: keyOf('zz-a'), label: 'zz-a', models: null }];
  // 有効期限を長くして、方式で鮮度が変わるようにする（http は取得の間隔2回分＋読取の期限1回分が上限）。
  const options = { usagePollIntervalMs: 60_000, usageReadTimeoutMs: 5000, rotationObservationTtlMs: 600_000,
    accounts: [{ label: 'zz-a', usagePolicy: POLICY }] };
  // 口座を使える状態（ready）にし、使用量は分からないままにしてから、方式の確かめ方を当てる。
  const check = (pool, nowMs) => {
    pool.credentials(keyOf('zz-a'), true, nowMs);
    assertUsageGetObservation(pool, keyOf('zz-a'), nowMs);
    const view = pool.inspect(nowMs)[0];
    assert.equal(view.freshnessMs, 125_000, 'the http freshness: two polls plus one read deadline');
  };
  assert.equal(CODEX_USAGE_OBSERVATION_MODE, 'http');

  const pool = createCodexPool(entries, options);
  assert.equal(Object.isFrozen(pool), true);
  check(pool, START);
  pool.configure(options, START + 1);
  check(pool, START + 1);
  pool.configure({ ...options, usageObservationMode: 'passive' }, START + 2);
  check(pool, START + 2);
  assert.equal(pool.generation(), 2, 'configure() reached the pool');
  check(createCodexPool(entries, { ...options, usageObservationMode: 'passive' }), START);
  const withoutOptions = createCodexPool(entries, null);
  withoutOptions.credentials(keyOf('zz-a'), true, START);
  assertUsageGetObservation(withoutOptions, keyOf('zz-a'), START);

  // 陰性対照: 同じ確かめ方が、方式を渡さずに作ったプールと、作るときだけ渡して configure() で渡し忘れた
  // プール（configure() は既定値から作り直すので受動の方式へ戻る。包みが要る理由）では失敗する。
  assert.throws(() => check(createCodexAccountPool(entries, options), START), assert.AssertionError);
  const bare = createCodexAccountPool(entries, { ...options, usageObservationMode: 'http' });
  check(bare, START);
  bare.configure(options, START + 1);
  assert.throws(() => check(bare, START + 1), assert.AssertionError);
});

// --- 余分なキー・ダミーの識別子 ---------------------------------------------------------------------

// 状態のあるプール（口座 zz-a は5時間窓で停止、zz-b は使える）を、プールだけで作る。
function statefulPool({ keyOfLabel = keyOf } = {}) {
  const pool = createCodexPool([{ key: keyOfLabel('zz-a'), label: 'zz-a' }, { key: keyOfLabel('zz-b'), label: 'zz-b' }],
    { ...TIMING, accounts: [{ label: 'zz-a', usagePolicy: POLICY }, { label: 'zz-b', usagePolicy: POLICY }] });
  const reading = used => ({ primary_used_percent: used, primary_window_minutes: 300, primary_reset_at: START + 3_600_000,
    secondary_used_percent: 20, secondary_window_minutes: 10080, secondary_reset_at: START + 86_400_000 });
  for (const [label, used] of [['zz-a', 80], ['zz-b', 10]]) {
    pool.usageConfirmed(keyOfLabel(label), START);
    pool.observe(keyOfLabel(label), reading(used), START,
      { source: 'usage-get', complete: true, ordinaryUsageAllowed: true, stopEpoch: 0 });
  }
  return pool;
}

test('projection: keys added on the pool side or the poller side never reach the JSON', () => {
  const EXTRA = { zzExtraKey: 'zz-extra-value', accountId: 'zz-extra-account-id', home: '/zz-extra/home',
    accessToken: 'zz-extra-access-token' };
  const pool = statefulPool();
  const withExtra = value => (value && typeof value === 'object' ? { ...value, ...EXTRA } : value);
  const eachWithExtra = records => Object.fromEntries(Object.entries(records ?? {}).map(([key, value]) => [key, withExtra(value)]));
  const wrapped = {
    ...pool,
    snapshot: () => pool.snapshot().map(entry => ({ ...withExtra(entry), windows: eachWithExtra(entry.windows),
      ...(entry.windowCaps ? { windowCaps: eachWithExtra(entry.windowCaps) } : {}) })),
    inspect: nowMs => pool.inspect(nowMs).map(withExtra),
    health: nowMs => withExtra(pool.health(nowMs)),
    select: (...args) => withExtra(pool.select(...args)),
    lastResort: (...args) => withExtra(pool.lastResort(...args)),
  };
  const poller = {
    accountHealth: () => withExtra({ lastObservationAttemptAt: START, lastObservationSuccessAt: START,
      nextObservationAt: START + MIN, observationErrorCode: null, observationDegraded: false, observationGate: 'passed',
      ordinaryUsageAllowed: true, rateLimitReachedType: null }),
    observation: () => withExtra({ source: 'usage-get', gate: 'passed', cliConsumptionVisible: false,
      accountUsageIncludesExternalClients: true }),
  };
  const events = [withExtra({ at: codexIsoTime(START), type: 'stopped', label: 'zz-a' })];
  const json = projectCodexStatus({ enabled: true, pool: wrapped, poller, userAgentSource: 'config', events,
    daemon: withExtra({ reachable: true, startedAt: START }), source: 'daemon', nowMs: START + 1 });
  assert.equal(codexStatusProblem(json), null, 'no unknown key at any level');
  const text = JSON.stringify(json);
  for (const [key, value] of Object.entries(EXTRA)) {
    assert.equal(text.includes(key), false, key);
    assert.equal(text.includes(value), false, value);
  }
  // 包まずに射影した値と同じ（余分なキーは何も変えない）。
  assert.deepEqual(json, projectCodexStatus({ enabled: true, pool, poller: { accountHealth: () => ({
    lastObservationAttemptAt: START, lastObservationSuccessAt: START, nextObservationAt: START + MIN, observationErrorCode: null,
    observationDegraded: false, observationGate: 'passed', ordinaryUsageAllowed: true, rateLimitReachedType: null }),
  observation: () => ({ gate: 'passed' }) }, userAgentSource: 'config', events: [{ at: codexIsoTime(START), type: 'stopped', label: 'zz-a' }],
  daemon: { reachable: true, startedAt: START }, source: 'daemon', nowMs: START + 1 }));
});

test('projection: mail-address-like and token-like strings outside the labels never reach the JSON', () => {
  const DUMMY_EMAIL = 'zz-dummy@example.invalid';
  const DUMMY_JWT = ['eyJhbGciOiJub25lIn0', 'eyJ6eiI6InRlc3QifQ', 'zz-fake-signature'].join('.');
  const DUMMY_BEARER = 'Bearer zz-fake-bearer-token';
  // 内部のキーそのものをメールアドレス形式にする。
  const pool = statefulPool({ keyOfLabel: label => `${label}:${DUMMY_EMAIL}` });
  pool.usageAuthRejected(`zz-b:${DUMMY_EMAIL}`, START, { reason: 'upstream-unauthorized' });
  const wrapped = {
    ...pool,
    snapshot: () => pool.snapshot().map(entry => ({ ...entry, email: DUMMY_EMAIL, accessToken: DUMMY_JWT,
      ...(entry.state === 'needs-login' ? { authReason: DUMMY_BEARER } : {}) })),
  };
  const poller = {
    accountHealth: () => ({ lastObservationAttemptAt: START, observationErrorCode: DUMMY_JWT, observationGate: DUMMY_BEARER,
      ordinaryUsageAllowed: DUMMY_EMAIL, nextObservationAt: DUMMY_EMAIL }),
    observation: () => ({ gate: DUMMY_JWT }),
  };
  const events = [
    { at: codexIsoTime(START), type: 'stopped', label: DUMMY_EMAIL },
    { at: codexIsoTime(START), type: DUMMY_JWT, label: 'zz-a' },
    { at: DUMMY_BEARER, type: 'stopped', label: 'zz-a' },
    { at: codexIsoTime(START), type: 'released', label: 'zz-a' },
  ];
  const json = projectCodexStatus({ enabled: true, pool: wrapped, poller, userAgentSource: 'codex-version', events,
    source: 'daemon', nowMs: START + 1 });
  assert.equal(codexStatusProblem(json), null);
  const text = JSON.stringify(json);
  assert.equal(text.match(/[^\s"]+@[^\s"]+/g), null, 'no mail-address-like string');
  assert.equal(text.match(/eyJ[A-Za-z0-9_-]*/g), null, 'no token-like string');
  assert.equal(text.includes('Bearer'), false);
  for (const value of [DUMMY_EMAIL, DUMMY_JWT, DUMMY_BEARER]) assert.equal(text.includes(value), false, value);
  assert.deepEqual(json.accounts.map(account => account.label), ['zz-a', 'zz-b']);
  assert.equal(json.accounts[1].reason, null, 'an auth reason outside the three words is not passed through');
  assert.deepEqual(json.events, [{ at: codexIsoTime(START), type: 'released', label: 'zz-a' }]);
});

// --- User-Agent の出どころと理由の語 ---------------------------------------------------------------

test('projection: every userAgentSource value and both cause reasons pass the schema check, other values do not', () => {
  assert.deepEqual(CODEX_USER_AGENT_SOURCES, Object.values(USER_AGENT_SOURCE));
  for (const source of [...CODEX_USER_AGENT_SOURCES, null]) {
    const json = projectCodexStatus({ enabled: true, pool: statefulPool(), userAgentSource: source, source: 'daemon', nowMs: START });
    assert.equal(codexStatusProblem(json), null, String(source));
    assert.equal(json.observation.userAgentSource, source);
  }
  for (const cause of Object.values(CLIENT_IDENTITY_REASON)) {
    assert.ok(CODEX_ACCOUNT_REASONS.includes(cause), cause);
    const pool = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-a' }], { ...TIMING, accounts: [{ label: 'zz-a', usagePolicy: POLICY }] });
    pool.credentials(keyOf('zz-a'), true, START);
    const poller = { accountHealth: () => ({ lastObservationAttemptAt: START, observationErrorCode: cause, observationGate: 'failed' }),
      observation: () => ({ gate: 'failed' }) };
    const json = projectCodexStatus({ enabled: true, pool, poller, userAgentSource: null, source: 'daemon', nowMs: START });
    assert.deepEqual(rowOf(json, 'zz-a'), E('unread', 'unknown', cause, 'unknown'));
    assert.equal(json.observation.startupCheck, 'failed');
  }
  assert.throws(() => projectCodexStatus({ enabled: true, pool: statefulPool(), userAgentSource: 'other', source: 'daemon', nowMs: START }),
    TypeError);
  const json = projectCodexStatus({ enabled: true, pool: statefulPool(), userAgentSource: 'config', source: 'daemon', nowMs: START });
  json.observation.userAgentSource = 'other';
  assert.equal(codexStatusProblem(json), 'status.observation.userAgentSource is not an allowed value');
});

test('projection: the three needs-login reasons reach the JSON as they are', () => {
  assert.deepEqual([...USAGE_AUTH_REJECTION_REASONS].sort(), ['access-token-expired', 'upstream-forbidden', 'upstream-unauthorized']);
  for (const reason of USAGE_AUTH_REJECTION_REASONS) {
    assert.ok(CODEX_ACCOUNT_REASONS.includes(reason), reason);
    const pool = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-a' }], { ...TIMING, accounts: [{ label: 'zz-a', usagePolicy: POLICY }] });
    pool.credentials(keyOf('zz-a'), true, START);
    pool.usageAuthRejected(keyOf('zz-a'), START, { reason });
    const json = projectCodexStatus({ enabled: true, pool, source: 'daemon', nowMs: START });
    assert.deepEqual(rowOf(json, 'zz-a'), E('needs login', 'login_required', reason, 'needs-login'));
    assert.equal(json.accounts[0].headroomPercent, 0);
  }
});

test('projection: the label pattern and the auth reasons agree with the Codex side', () => {
  assert.equal(CODEX_LABEL_PATTERN.source, CODEX_ACCOUNT_LABEL.source);
  assert.equal(CODEX_LABEL_PATTERN.flags, CODEX_ACCOUNT_LABEL.flags);
});

// --- 停止の記録と復帰の票 ----------------------------------------------------------------------------

test('projection: a stopped account under a policy shows 0 or 1 clean reads, and is released at the second', async t => {
  const h = await harness(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b', policy: { ...POLICY, resumeUsedPercent: 50 } }],
    respond: ({ clock, count }) => usageResponse(clock, count === 1
      ? { primary: fiveHour(80), secondary: weekly(20) } : { primary: fiveHour(10), secondary: weekly(10) }) });
  const steps = [];
  for (let i = 0; i < 3; i++) {
    await h.tick(i === 0 ? 1 : MIN);
    for (const view of h.pool.inspect(h.clock.now())) {
      assert.notEqual(view.stopUsedPercent, null, 'every account has a policy');
      assert.notEqual(view.resumeUsedPercent, null);
    }
    const json = h.project();
    assert.equal(codexStatusProblem(json), null);
    for (const entry of h.pool.snapshot()) {
      const latch = json.accounts.find(account => account.label === entry.label).latch;
      if (latch) assert.ok(entry.resumeStreak === undefined || entry.resumeStreak === 1, 'a stopped account holds 0 or 1 vote');
    }
    const { stateWord, latch } = json.accounts[0];
    steps.push({ word: stateWord, done: latch ? latch.cleanReadsDone : null });
  }
  assert.deepEqual(steps, [{ word: 'held', done: 0 }, { word: 'held', done: 1 }, { word: 'ready', done: null }]);
  assert.deepEqual(h.events.list().filter(event => event.label === 'zz-a').map(event => event.type), ['stopped', 'released']);
});

test('events from the poller logs: needs-login and recovered', async t => {
  const h = await harness(t, { respond: ({ clock, count }) => (count <= 2 ? new Response(null, { status: 401 })
    : usageResponse(clock, { primary: fiveHour(10), secondary: weekly(20) })) });
  await h.reads(2);
  assert.equal(rowOf(h.project(), 'zz-a').stateWord, 'needs login');
  // ログイン切れの間は再確認の時刻（10分後）まで読まない。
  for (let i = 0; i < 11 && h.calls.length < 3; i++) await h.tick(MIN);
  assert.equal(h.calls.length, 3);
  assert.equal(rowOf(h.project(), 'zz-a').stateWord, 'ready', 'the recheck read brings the login and the usage back');
  assert.deepEqual(h.events.list().map(event => event.type), ['needs-login', 'recovered']);
});

// --- 窓の振り分け -------------------------------------------------------------------------------------

function onePool({ policy = POLICY } = {}) {
  const pool = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-a' }], { ...TIMING, accounts: [{ label: 'zz-a', usagePolicy: policy }] });
  pool.usageConfirmed(keyOf('zz-a'), START);
  return pool;
}
const observeGet = (pool, reading, nowMs, extra = {}) => pool.observe(keyOf('zz-a'), reading, nowMs,
  { source: 'usage-get', complete: true, ordinaryUsageAllowed: true, stopEpoch: pool.snapshot()[0].stopEpoch, ...extra });
const accountAt = (pool, nowMs, input = {}) => {
  const json = projectCodexStatus({ enabled: true, pool, source: 'daemon', nowMs, ...input });
  assert.equal(codexStatusProblem(json), null);
  return json.accounts[0];
};

test('windows: reported lengths decide the slot, whatever the position', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 60, primary_window_minutes: 10080, primary_reset_at: START + 86_400_000,
    secondary_used_percent: 30, secondary_window_minutes: 300, secondary_reset_at: START + 3_600_000 }, START);
  const account = accountAt(pool, START + 1);
  assert.deepEqual(account.windows.weekly, { usedPercent: 60, resetAt: codexIsoTime(START + 86_400_000), windowMinutes: 10080,
    fresh: true, observedAt: codexIsoTime(START), lengthSource: 'reported' });
  assert.equal(account.windows.fiveHour.usedPercent, 30);
  assert.equal(account.windows.fiveHour.windowMinutes, 300);
  assert.deepEqual(account.otherWindows, []);
  assert.equal(account.headroomPercent, 15);
  assert.equal(account.observedAt, codexIsoTime(START));
});

test('windows: other lengths go to otherWindows, and a length that is not whole minutes has no windowMinutes', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 50, primary_window_minutes: 120, secondary_used_percent: 20,
    secondary_window_minutes: 1.5 }, START);
  const account = accountAt(pool, START + 1);
  assert.deepEqual([account.windows.fiveHour, account.windows.weekly], [null, null]);
  assert.deepEqual(account.otherWindows.map(window => [window.usedPercent, window.windowMinutes, window.lengthSource]),
    [[50, 120, 'reported'], [20, null, 'reported']]);
});

test('windows: without a reported length the position decides, and a taken slot sends the window to otherWindows', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 10, secondary_used_percent: 20 }, START);
  const first = accountAt(pool, START + 1);
  assert.equal(first.windows.fiveHour.lengthSource, 'position');
  assert.equal(first.windows.fiveHour.windowMinutes, null);
  assert.equal(first.windows.weekly.lengthSource, 'position');
  // 同じ位置に5時間の長さを申告した窓が来ると、長さの窓が枠を取り、位置の窓は otherWindows へ。
  // （2回目は不完全な観測にして、最後の完全な観測に載っていた位置の窓を残す。）
  observeGet(pool, { primary_used_percent: 30, primary_window_minutes: 300 }, START + 1000, { complete: false });
  const second = accountAt(pool, START + 2000);
  assert.equal(second.windows.fiveHour.lengthSource, 'reported');
  assert.equal(second.windows.fiveHour.usedPercent, 30);
  assert.deepEqual(second.otherWindows.map(window => [window.usedPercent, window.lengthSource]), [[10, 'position']]);
});

test('windows: the latch names the stopped window by its length, not by the position it was last seen at', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 80, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 }, START);
  // 5時間窓は上流から消え、同じ位置に週次窓が来た。位置で見た写しは、停止を週次窓の位置のものと読む。
  observeGet(pool, { primary_used_percent: 10, primary_window_minutes: 10080, primary_reset_at: START + 86_400_000 }, START + 1000);
  const entry = pool.snapshot()[0];
  assert.deepEqual(entry.capped, { primary: true }, 'the positional copy points at the position only');
  assert.equal(entry.observation.primary.usedPercent, 10);
  const account = accountAt(pool, START + 2000);
  assert.deepEqual(account.latch.cappedWindows, ['fiveHour']);
  assert.equal(account.windows.fiveHour.usedPercent, 80);
  assert.equal(account.windows.weekly.usedPercent, 10);
  assert.equal(account.stateWord, 'held');
  assert.equal(account.latch.since, codexIsoTime(START));
});

test('windows: freshness follows the pool rule (age under the freshness and before the reset)', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 10, primary_window_minutes: 300, primary_reset_at: START + 200_000,
    secondary_used_percent: 20, secondary_window_minutes: 10080, secondary_reset_at: START + 86_400_000 }, START);
  const fresh = at => { const account = accountAt(pool, at); return [account.windows.fiveHour.fresh, account.windows.weekly.fresh]; };
  assert.deepEqual(fresh(START + 124_999), [true, true]);
  assert.deepEqual(fresh(START + 125_000), [false, false], 'the http freshness is two polls plus one read deadline');
  const early = onePool();
  observeGet(early, { primary_used_percent: 10, primary_window_minutes: 300, primary_reset_at: START + 50_000 }, START);
  assert.equal(accountAt(early, START + 50_000).windows.fiveHour.fresh, false, 'a window past its reset is not fresh');
});

// --- 上流から消えた窓 -----------------------------------------------------------------------------------

test('vanished window: when the weekly window vanishes, sixty minutes of five-hour-only reads keep the headroom known', async t => {
  const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, count === 1
    ? { primary: fiveHour(40), secondary: weekly(60) } : { primary: fiveHour(40) }) });
  await h.tick(1);
  assert.equal(h.project().accounts[0].headroomPercent, 15, 'both windows at first: min(35, 15)');
  for (let i = 0; i < 60; i++) await h.tick(MIN);
  assert.equal(h.attempts('zz-a'), 61);
  const json = h.project();
  assert.equal(codexStatusProblem(json), null);
  const [account] = json.accounts;
  assert.equal(account.stateWord, 'ready');
  assert.equal(account.windows.weekly, null, 'the window the upstream no longer declares is not shown');
  assert.equal(account.windows.fiveHour.usedPercent, 40);
  assert.equal(account.windows.fiveHour.fresh, true);
  assert.equal(account.headroomPercent, 35);
  assert.deepEqual([json.aggregate.effectiveRemainingPercent, json.aggregate.lowerBoundPercent,
    json.aggregate.fiveHourRemainingPercent, json.aggregate.weeklyRemainingPercent], [35, 35, 35, null]);
  assert.ok(h.pool.snapshot()[0].windows['len:10080'], 'the pool itself still keeps the old weekly reading');
});

test('vanished window: a stopped window that vanished is still shown, and the account stays held', async t => {
  const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, count === 1
    ? { primary: fiveHour(40), secondary: weekly(80) } : { primary: fiveHour(40) }) });
  await h.tick(1);
  for (let i = 0; i < 5; i++) await h.tick(MIN);
  const json = h.project();
  assert.equal(codexStatusProblem(json), null);
  const [account] = json.accounts;
  assert.equal(account.stateWord, 'held');
  assert.deepEqual(account.latch.cappedWindows, ['weekly']);
  assert.equal(account.windows.weekly.usedPercent, 80, 'the stopped window explains the stop');
  assert.equal(account.windows.weekly.fresh, false);
  assert.equal(account.headroomPercent, 0);
});

test('vanished window: a window an incomplete reading could not read is not taken for a vanished one', async t => {
  const broken = nowSec => ({ ...weekly(60)(nowSec), used_percent: 'zz' });
  const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, [
    { primary: fiveHour(40), secondary: weekly(60) },
    { primary: fiveHour(40), secondary: broken },
    { allowed: null, primary: fiveHour(40) },
  ][count - 1]) });
  await h.tick(1);
  const weeklyAt = account => [account.windows.weekly?.usedPercent, account.windows.weekly?.observedAt];
  await h.tick(MIN);
  assert.equal(h.code('zz-a'), 'used-percent-unusable');
  const second = h.project();
  assert.equal(codexStatusProblem(second), null);
  assert.deepEqual(weeklyAt(second.accounts[0]), [60, codexIsoTime(START + 1)], 'the unreadable weekly window stays');
  assert.equal(second.accounts[0].headroomPercent, 15);
  await h.tick(MIN);
  assert.equal(h.code('zz-a'), 'allowed-unusable');
  const third = h.project();
  assert.equal(codexStatusProblem(third), null);
  assert.deepEqual(weeklyAt(third.accounts[0]), [60, codexIsoTime(START + 1)],
    'a weekly window missing from an incomplete reading stays');
});

test('vanished window: a vanished window declared again in an unreadable form is shown as missing, not removed', async t => {
  // 0秒に両窓を完全に読み、60秒に5時間窓だけを完全に読み（週次窓が消える）、120秒に使用率の読めない週次窓を
  // 含む不完全な観測を受ける。最後の読取が失敗しているので、週次窓は外さずに鮮度切れの欠測として見せる。
  const broken = nowSec => ({ ...weekly(60)(nowSec), used_percent: 'zz' });
  const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, count === 1
    ? { primary: fiveHour(40), secondary: weekly(60) }
    : count === 2 ? { primary: fiveHour(40) } : { primary: fiveHour(40), secondary: broken }) });
  await h.tick(1);
  await h.tick(MIN);
  assert.equal(h.code('zz-a'), null);
  assert.equal(h.project().accounts[0].windows.weekly, null, 'after a successful read the vanished window is left out');
  await h.tick(MIN);
  assert.equal(h.code('zz-a'), 'used-percent-unusable');
  await h.tick(10_000);
  assert.equal(h.clock.now(), START + 130_001);
  const at130 = h.project();
  assert.equal(codexStatusProblem(at130), null);
  assert.equal(at130.accounts[0].stateWord, 'ready');
  assert.deepEqual([at130.accounts[0].windows.weekly?.usedPercent, at130.accounts[0].windows.weekly?.fresh], [60, false],
    'the weekly window is shown again, stale');
  assert.equal(at130.accounts[0].headroomPercent, null);
  assert.equal(at130.aggregate.effectiveRemainingPercent, null);
  await h.tick(MIN);
  assert.equal(h.clock.now(), START + 190_001);
  const at190 = h.project();
  assert.equal(codexStatusProblem(at190), null);
  assert.equal(at190.accounts[0].stateWord, 'unread');
  assert.equal(at190.aggregate.effectiveRemainingPercent, null);
});

test('vanished window: without the poller no window is left out', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 40, primary_window_minutes: 300, primary_reset_at: START + 3_600_000,
    secondary_used_percent: 60, secondary_window_minutes: 10080, secondary_reset_at: START + 86_400_000 }, START);
  observeGet(pool, { primary_used_percent: 40, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 }, START + MIN);
  assert.equal(accountAt(pool, START + MIN + 1).windows.weekly.usedPercent, 60);
});

test('vanished window: after a reload the window stays until a read succeeds again, then it is left out', async t => {
  // 0秒に両窓を完全に読み、60秒に5時間窓だけを完全に読み（週次窓が消える）、120秒に使用率の読めない週次窓を
  // 含む不完全な観測を受ける。130秒に読み直す。読み直しの後、次の読取が成功するまでは、週次窓を古い値の
  // まま残して残量を null にする。次の読取（5時間窓だけの完全な観測）が成功すれば、週次窓は外れる。
  const broken = nowSec => ({ ...weekly(60)(nowSec), used_percent: 'zz' });
  const h = await harness(t, { respond: ({ clock, count }) => usageResponse(clock, [
    { primary: fiveHour(40), secondary: weekly(60) },
    { primary: fiveHour(40) },
    { primary: fiveHour(40), secondary: broken },
    { primary: fiveHour(40) },
  ][count - 1]) });
  await h.tick(1);
  await h.tick(MIN);
  await h.tick(MIN);
  assert.equal(h.code('zz-a'), 'used-percent-unusable');
  await h.tick(10_000);
  h.pool.configure(h.config, h.clock.now());
  h.poller.configure(h.descriptors, h.config);
  const health = h.poller.accountHealth(keyOf('zz-a'));
  assert.deepEqual([health.observationGate, health.observationErrorCode], ['pending', null], 'the reload forgot the failure');
  const afterReload = h.project();
  assert.equal(codexStatusProblem(afterReload), null);
  assert.equal(afterReload.accounts[0].stateWord, 'ready');
  assert.deepEqual([afterReload.accounts[0].windows.weekly?.usedPercent, afterReload.accounts[0].windows.weekly?.fresh],
    [60, false], 'before the next read the weekly window stays with its old reading');
  assert.equal(afterReload.accounts[0].headroomPercent, null);
  assert.equal(afterReload.aggregate.effectiveRemainingPercent, null);
  await h.tick(20_000);
  assert.equal(h.attempts('zz-a'), 4, 'the first read after the reload');
  assert.equal(h.poller.accountHealth(keyOf('zz-a')).observationGate, 'passed');
  const afterRead = h.project();
  assert.equal(codexStatusProblem(afterRead), null);
  assert.equal(afterRead.accounts[0].windows.weekly, null, 'a successful read after the reload leaves the vanished window out');
  assert.equal(afterRead.accounts[0].headroomPercent, 35);
  assert.equal(afterRead.aggregate.effectiveRemainingPercent, 35);
});

// --- 窓を外すかどうかの判定の表（src/codex/snapshot.js の stillDeclared の直前の表と1行ずつ対応） ------------
//
// health: 取得処理が示す口座の状態。capped: その窓（週次窓）の停止が記録されている。older: その窓の観測の時刻が
// 口座の最後の完全な観測（usageGetAt）より前。expect: 外す（leave out）か、外さない（keep）か。

const HEALTH_OF = {
  'no poller': null,
  'not-required': { observationGate: 'not-required', observationErrorCode: null, lastObservationAttemptAt: null },
  pending: { observationGate: 'pending', observationErrorCode: null, lastObservationAttemptAt: START },
  failed: { observationGate: 'failed', observationErrorCode: 'server-error', lastObservationAttemptAt: START + MIN },
  'passed with an error': { observationGate: 'passed', observationErrorCode: 'server-error', lastObservationAttemptAt: START + MIN },
  'passed without an error': { observationGate: 'passed', observationErrorCode: null, lastObservationAttemptAt: START + MIN },
};

const STILL_DECLARED_TABLE = [
  { row: 1, health: 'no poller', capped: false, older: false, expect: 'keep' },
  { row: 2, health: 'no poller', capped: false, older: true, expect: 'keep' },
  { row: 3, health: 'no poller', capped: true, older: false, expect: 'keep' },
  { row: 4, health: 'no poller', capped: true, older: true, expect: 'keep' },
  { row: 5, health: 'not-required', capped: false, older: false, expect: 'keep' },
  { row: 6, health: 'not-required', capped: false, older: true, expect: 'keep' },
  { row: 7, health: 'not-required', capped: true, older: false, expect: 'keep' },
  { row: 8, health: 'not-required', capped: true, older: true, expect: 'keep' },
  { row: 9, health: 'pending', capped: false, older: false, expect: 'keep' },
  { row: 10, health: 'pending', capped: false, older: true, expect: 'keep' },
  { row: 11, health: 'pending', capped: true, older: false, expect: 'keep' },
  { row: 12, health: 'pending', capped: true, older: true, expect: 'keep' },
  { row: 13, health: 'failed', capped: false, older: false, expect: 'keep' },
  { row: 14, health: 'failed', capped: false, older: true, expect: 'keep' },
  { row: 15, health: 'failed', capped: true, older: false, expect: 'keep' },
  { row: 16, health: 'failed', capped: true, older: true, expect: 'keep' },
  { row: 17, health: 'passed with an error', capped: false, older: false, expect: 'keep' },
  { row: 18, health: 'passed with an error', capped: false, older: true, expect: 'keep' },
  { row: 19, health: 'passed with an error', capped: true, older: false, expect: 'keep' },
  { row: 20, health: 'passed with an error', capped: true, older: true, expect: 'keep' },
  { row: 21, health: 'passed without an error', capped: false, older: false, expect: 'keep' },
  { row: 22, health: 'passed without an error', capped: false, older: true, expect: 'leave out' },
  { row: 23, health: 'passed without an error', capped: true, older: false, expect: 'keep' },
  { row: 24, health: 'passed without an error', capped: true, older: true, expect: 'keep' },
];

// 口座1つのプール。1回目（START）に両窓を完全に読む（週次窓は停止中なら80%、そうでなければ20%）。2回目
// （START + 1分）は、古い場合は5時間窓だけ、古くない場合は両窓を完全に読む。
function stillDeclaredPool({ capped, older }) {
  const pool = onePool();
  const fiveHourReading = { primary_used_percent: 10, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 };
  const weeklyReading = { secondary_used_percent: capped ? 80 : 20, secondary_window_minutes: 10080,
    secondary_reset_at: START + 86_400_000 };
  observeGet(pool, { ...fiveHourReading, ...weeklyReading }, START);
  observeGet(pool, older ? fiveHourReading : { ...fiveHourReading, ...weeklyReading }, START + MIN);
  return pool;
}

for (const row of STILL_DECLARED_TABLE) {
  test(`still-declared row ${row.row}: ${row.health}, capped ${row.capped}, older ${row.older} -> ${row.expect}`, () => {
    const pool = stillDeclaredPool(row);
    const entry = pool.snapshot()[0];
    assert.equal(Boolean(entry.windowCaps?.['len:10080']), row.capped, 'the stop of the weekly window is as the row says');
    assert.equal(entry.windows['len:10080'].observedAt < entry.usageGetAt, row.older, 'the age of the weekly window is as the row says');
    const health = HEALTH_OF[row.health];
    const poller = health === null ? null
      : { accountHealth: () => ({ ...health }), observation: () => ({ gate: health.observationGate }) };
    const json = projectCodexStatus({ enabled: true, pool, poller, source: 'daemon', nowMs: START + MIN + 1 });
    assert.equal(codexStatusProblem(json), null);
    assert.equal(json.accounts[0].windows.weekly === null ? 'leave out' : 'keep', row.expect);
  });
}

test('still-declared table: 24 rows, every combination once, and only row 22 leaves the window out', () => {
  assert.deepEqual(STILL_DECLARED_TABLE.map(row => row.row), Array.from({ length: 24 }, (_, i) => i + 1));
  const combinations = new Set(STILL_DECLARED_TABLE.map(row => `${row.health}|${row.capped}|${row.older}`));
  assert.equal(combinations.size, Object.keys(HEALTH_OF).length * 2 * 2);
  assert.deepEqual(STILL_DECLARED_TABLE.filter(row => row.expect === 'leave out').map(row => row.row), [22]);
});

// --- 停止した時刻 --------------------------------------------------------------------------------------

test('latch: a stop by the upstream refusal alone has no start time, however often the refusal is read', () => {
  // プールは拒否を読むたびに停止を記録し直し、stoppedAt を進める。それを停止の始まりとして見せない。
  const pool = onePool();
  const refused = { primary_used_percent: 10, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 };
  observeGet(pool, refused, START + 5000, { ordinaryUsageAllowed: false });
  const first = accountAt(pool, START + 6000);
  assert.equal(first.stateWord, 'blocked');
  assert.deepEqual(first.latch, { stopped: true, cappedWindows: [], upstreamBlocked: true, cleanReadsDone: 0,
    cleanReadsNeeded: 2, since: null });
  observeGet(pool, refused, START + 65_000, { ordinaryUsageAllowed: false });
  assert.equal(pool.snapshot()[0].stoppedAt, START + 65_000, 'the pool moved its record of the stop');
  const second = accountAt(pool, START + 66_000);
  assert.equal(second.stateWord, 'blocked');
  assert.equal(second.latch.since, null, 'the second refusal does not move the start either');
  // 窓の停止があれば、その始まりの時刻を使う（上流の拒否で停止を記録し直しても動かない）。
  const capped = onePool();
  observeGet(capped, { primary_used_percent: 80, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 }, START);
  observeGet(capped, { primary_used_percent: 80, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 }, START + 1000,
    { ordinaryUsageAllowed: false });
  assert.equal(capped.snapshot()[0].stoppedAt, START + 1000);
  assert.equal(accountAt(capped, START + 2000).latch.since, codexIsoTime(START));
});

// --- 次に選ばれる口座・無効・常駐が無いとき ------------------------------------------------------------

test('next: selectable, last resort, none and disabled', () => {
  const reading = { primary_used_percent: 10, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 };
  const selectable = onePool();
  observeGet(selectable, reading, START);
  assert.deepEqual(projectCodexStatus({ enabled: true, pool: selectable, source: 'daemon', nowMs: START }).next,
    { label: 'zz-a', reason: 'selectable' });
  assert.deepEqual(projectCodexStatus({ enabled: true, pool: onePool(), source: 'daemon', nowMs: START }).next,
    { label: 'zz-a', reason: 'last-resort' });
  assert.deepEqual(projectCodexStatus({ enabled: true, pool: onePool({ policy: RESERVED_POLICY }), source: 'daemon', nowMs: START }).next,
    { label: null, reason: 'none' });
  const disabled = projectCodexStatus({ enabled: false, pool: selectable, source: 'daemon', nowMs: START });
  assert.equal(codexStatusProblem(disabled), null);
  assert.deepEqual(disabled.next, { label: null, reason: 'disabled' });
  assert.equal(disabled.aggregate.effectiveRemainingPercent, null);
  assert.equal(disabled.enabled, false);
});

test('projection: without the daemon the latch is unknown, while selectable, its count and next follow the pool rule', () => {
  const pool = onePool();
  observeGet(pool, { primary_used_percent: 30, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 }, START);
  const json = projectCodexStatus({ enabled: true, pool, source: 'direct', nowMs: START + 1 });
  assert.equal(codexStatusProblem(json), null);
  assert.equal(json.latchKnown, false);
  assert.deepEqual(json.daemon, { reachable: false, startedAt: null });
  assert.equal(json.accounts[0].selectable, true, 'aggregate.accountsSelectable is an integer, so selectable is filled');
  assert.equal(json.aggregate.accountsSelectable, 1);
  assert.deepEqual(json.next, { label: 'zz-a', reason: 'selectable' });
  assert.equal(json.accounts[0].headroomPercent, null, 'without the daemon the headroom is unknown (rule 2)');
  assert.equal(json.observation.startupCheck, null);
});

test('projection: selectable, accountsSelectable and next agree with each other, with and without the daemon', () => {
  // zz-a は使える（完全な観測が新しい）、zz-b は使用量が分からない（最後の手段でだけ選ばれる）、zz-c は停止中。
  const pool = createCodexPool(['zz-a', 'zz-b', 'zz-c'].map(label => ({ key: keyOf(label), label })),
    { ...TIMING, accounts: ['zz-a', 'zz-b', 'zz-c'].map(label => ({ label, usagePolicy: POLICY })) });
  for (const label of ['zz-a', 'zz-b', 'zz-c']) pool.usageConfirmed(keyOf(label), START);
  const reading = used => ({ primary_used_percent: used, primary_window_minutes: 300, primary_reset_at: START + 3_600_000 });
  for (const [label, used] of [['zz-a', 30], ['zz-c', 80]]) {
    pool.observe(keyOf(label), reading(used), START, { source: 'usage-get', complete: true, ordinaryUsageAllowed: true, stopEpoch: 0 });
  }
  const agree = json => {
    assert.equal(codexStatusProblem(json), null);
    const selectable = json.accounts.filter(account => account.selectable === true).map(account => account.label);
    assert.equal(json.aggregate.accountsSelectable, selectable.length);
    if (json.next.reason === 'selectable') assert.ok(selectable.includes(json.next.label), 'next is a selectable account');
    if (json.next.reason === 'last-resort') assert.equal(selectable.includes(json.next.label), false);
    return { selectable, next: json.next };
  };
  for (const source of ['daemon', 'direct']) {
    assert.deepEqual(agree(projectCodexStatus({ enabled: true, pool, source, nowMs: START + 1 })),
      { selectable: ['zz-a'], next: { label: 'zz-a', reason: 'selectable' } }, source);
  }
  // zz-a の観測が古くなると、選べる口座は無く、最後の手段が次になる（使用量の分からない zz-a と zz-b の
  // うち、並び順で最初の zz-a）。
  for (const source of ['daemon', 'direct']) {
    assert.deepEqual(agree(projectCodexStatus({ enabled: true, pool, source, nowMs: START + 200_000 })),
      { selectable: [], next: { label: 'zz-a', reason: 'last-resort' } }, source);
  }
});

test('projection: the top level, the daemon block, times without milliseconds and the pool reset', () => {
  const h = { pool: statefulPool() };
  const json = projectCodexStatus({ enabled: true, pool: h.pool, userAgentSource: 'codex-version',
    daemon: { reachable: true, startedAt: START - 3_600_000 + 123 }, source: 'daemon', nowMs: START + 999 });
  assert.equal(codexStatusProblem(json), null);
  assert.deepEqual(Object.keys(json), ['schemaVersion', 'provider', 'enabled', 'generatedAt', 'source', 'latchKnown', 'daemon',
    'pool', 'observation', 'next', 'accounts', 'aggregate', 'events']);
  assert.equal(json.generatedAt, codexIsoTime(START));
  assert.equal(json.generatedAt.endsWith(':00Z'), true);
  assert.deepEqual(json.daemon, { reachable: true, startedAt: codexIsoTime(START - 3_600_000) });
  assert.deepEqual(json.observation, { method: 'usage-get', startupCheck: null, accountUsageIncludesExternalClients: true,
    cliConsumptionVisible: false, userAgentSource: 'codex-version' });
  assert.deepEqual(json.pool, { state: 'degraded', resetAt: null });
  assert.deepEqual(json.accounts.map(account => account.stateWord), ['held', 'ready']);
  assert.deepEqual(json.accounts[0].policy, { stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
  assert.deepEqual(json.accounts[0].latch, { stopped: true, cappedWindows: ['fiveHour'], upstreamBlocked: false, cleanReadsDone: 0,
    cleanReadsNeeded: 2, since: codexIsoTime(START) });
  assert.equal(json.accounts[0].resetAt, null);
  assert.equal(json.accounts[1].latch, null);
  assert.deepEqual(json.events, []);
});

test('projection: the events are copied with their three keys only, bounded to the last 50', () => {
  const events = Array.from({ length: 55 }, (_, i) => ({ at: codexIsoTime(START + i * 1000), type: 'selected', label: `zz-${i}` }));
  const json = projectCodexStatus({ enabled: true, pool: onePool(), events, source: 'daemon', nowMs: START });
  assert.equal(codexStatusProblem(json), null);
  assert.equal(json.events.length, 50);
  assert.equal(json.events[0].label, 'zz-5');
  assert.throws(() => projectCodexStatus({ enabled: true, pool: onePool(), events: null, source: 'daemon', nowMs: START }), TypeError);
});

test('projection: refuses what cannot be projected, without putting the value in the message', () => {
  const noPolicy = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-a' }], TIMING);
  assert.throws(() => projectCodexStatus({ enabled: true, pool: noPolicy, source: 'daemon', nowMs: START }),
    { name: 'TypeError', message: 'every account needs a usage policy' });
  const badLabel = createCodexPool([{ key: keyOf('zz-a'), label: 'zz-dummy@example.invalid' }],
    { ...TIMING, accounts: [{ label: 'zz-dummy@example.invalid', usagePolicy: POLICY }] });
  assert.throws(() => projectCodexStatus({ enabled: true, pool: badLabel, source: 'daemon', nowMs: START }),
    error => error instanceof TypeError && !error.message.includes('@'));
  const pool = onePool();
  for (const input of [{ enabled: 'yes' }, { source: 'cache' }, { nowMs: Number.NaN }, { nowMs: -1 }, { pool: {} },
    { poller: {} }, { daemon: { reachable: 'yes', startedAt: null } }, { daemon: { reachable: true, startedAt: 'zz' } }]) {
    assert.throws(() => projectCodexStatus({ enabled: true, pool, source: 'daemon', nowMs: START, ...input }), TypeError,
      JSON.stringify(input));
  }
});

// --- 実効残量の境界の表（17行） ---------------------------------------------------------------------

const W = (usedPercent, { fresh = true, windowMinutes = 300 } = {}) => ({ usedPercent, resetAt: null, windowMinutes, fresh,
  observedAt: codexIsoTime(START), lengthSource: 'reported' });
function jsonAccount(label, stateWord, { fiveHour = null, weekly = null, other = [], reason = null } = {}) {
  return { label, state: CODEX_STATE_OF_WORD[stateWord], stateWord, selectable: stateWord === 'ready', reason, resetAt: null,
    ordinaryUsageAllowed: null, nextObservationAt: null, policy: { ...POLICY }, latch: null, windows: { fiveHour, weekly },
    otherWindows: other, observedAt: null, headroomPercent: null };
}
const readyA = (fiveHourUsed = 40, weeklyUsed = 60, options = {}) => jsonAccount('zz-a', 'ready',
  { fiveHour: W(fiveHourUsed), weekly: W(weeklyUsed, { windowMinutes: 10080 }), ...options });

const AGGREGATE_ROWS = [
  { row: 1, accounts: [], expect: [0, 0] },
  { row: 2, accounts: [], enabled: false, expect: [null, 0] },
  { row: 3, accounts: ['zz-a', 'zz-b', 'zz-c'].map(label => jsonAccount(label, 'unread')), expect: [null, 0] },
  { row: 4, accounts: [readyA(), jsonAccount('zz-b', 'capped'), jsonAccount('zz-c', 'unread')], expect: [null, 15],
    windows: [null, null] },
  { row: 5, accounts: [readyA(), jsonAccount('zz-b', 'capped')], expect: [15, 15], windows: [35, 15] },
  { row: 6, accounts: [jsonAccount('zz-a', 'ready', { fiveHour: W(40), weekly: W(60, { windowMinutes: 10080, fresh: false }) })],
    expect: [null, 0], windows: [35, null] },
  { row: 7, accounts: [jsonAccount('zz-a', 'ready', { fiveHour: W(null), weekly: W(60, { windowMinutes: 10080 }) })],
    expect: [null, 0] },
  { row: 8, accounts: [jsonAccount('zz-a', 'reserved')], expect: [0, 0] },
  { row: 9, accounts: [jsonAccount('zz-a', 'needs login')], expect: [0, 0] },
  { row: 10, accounts: [jsonAccount('zz-a', 'no models')], expect: [0, 0] },
  // 常駐が無いときの停止の判定も、窓ごとの合計ではその窓だけに当てる（5時間窓は0、週次窓はしきい値の
  // 下なので規則1に当たらず、常駐が無いので規則2で null）。
  { row: 11, source: 'direct', accounts: [readyA(80, 20)], expect: [0, 0], windows: [0, null] },
  { row: 12, source: 'direct', accounts: [readyA(30, 30)], expect: [null, 0] },
  { row: 13, accounts: [jsonAccount('zz-a', 'ready', { other: [W(50, { windowMinutes: 120 })] })], expect: [25, 25],
    windows: [null, null] },
  { row: 14, accounts: [jsonAccount('zz-a', 'ready')], expect: [null, 0] },
  { row: 15, accounts: [jsonAccount('zz-a', 'ready', { fiveHour: W(90) })], expect: [0, 0] },
  { row: 16, accounts: [readyA(), jsonAccount('zz-b', 'unread')], expect: [null, 15] },
  { row: 17, source: 'direct', accounts: [readyA(30, 30), jsonAccount('zz-b', 'unread', { reason: 'read-deadline' })],
    expect: [null, 0] },
];

for (const row of AGGREGATE_ROWS) {
  test(`aggregate row ${row.row}`, () => {
    const aggregate = aggregateCodexAccounts(row.accounts, { enabled: row.enabled ?? true, source: row.source ?? 'daemon' });
    assert.deepEqual([aggregate.effectiveRemainingPercent, aggregate.lowerBoundPercent], row.expect);
    if (row.windows) assert.deepEqual([aggregate.fiveHourRemainingPercent, aggregate.weeklyRemainingPercent], row.windows);
    assert.equal(aggregate.accountsTotal, row.accounts.length);
    assert.equal(aggregate.unit, 'percent-points-of-one-account');
  });
}

test('aggregate rows: the table has 17 rows, five of them with the per-window totals', () => {
  assert.deepEqual(AGGREGATE_ROWS.map(row => row.row), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.deepEqual(AGGREGATE_ROWS.filter(row => row.windows).map(row => row.row), [4, 5, 6, 11, 13]);
});

// --- 実効残量の境界の表を、射影を通して確かめる -----------------------------------------------------------
//
// 各行の口座をプールの状態として作り、projectCodexStatus() の出力で、全体の値・下限・窓ごとの合計・口座ごとの
// 寄与と、スキーマ検査を確かめる。プールで作れない状態（7行: 使用率の無い窓、14行: 窓の無い使える口座）
// だけは、プールの写しを差し替えて作る。11行と15行は、プールが停止しきい値以上の窓で口座を止めるので、
// 口座は held になり規則1（exhausted）で0になる。

const BOUNDARY_NOW = START + 20_000;
const completeRead = (pool, label, reading, nowMs = START) => pool.observe(keyOf(label), reading, nowMs,
  { source: 'usage-get', complete: true, ordinaryUsageAllowed: true, stopEpoch: pool.snapshot().find(e => e.key === keyOf(label)).stopEpoch });
const readingOf = (fiveHourUsed, weeklyUsed, { weeklyResetAt = START + 86_400_000 } = {}) => ({
  ...(fiveHourUsed === undefined ? {} : { primary_used_percent: fiveHourUsed, primary_window_minutes: 300,
    primary_reset_at: START + 3_600_000 }),
  ...(weeklyUsed === undefined ? {} : { secondary_used_percent: weeklyUsed, secondary_window_minutes: 10080,
    secondary_reset_at: weeklyResetAt }) });
const spec = {
  ready: (label, fiveHourUsed = 40, weeklyUsed = 60) =>
    ({ label, setup: pool => completeRead(pool, label, readingOf(fiveHourUsed, weeklyUsed)) }),
  unread: label => ({ label }),
  capped: label => ({ label, policy: { stopUsedPercent: 100 }, setup: pool => completeRead(pool, label, readingOf(100)) }),
  reserved: label => ({ label, policy: { blockWhenUnknown: true } }),
  needsLogin: label => ({ label, setup: pool => pool.usageAuthRejected(keyOf(label), START, { reason: 'upstream-unauthorized' }) }),
  noModels: label => ({ label, models: [] }),
  staleWeekly: label => ({ label, setup: pool => completeRead(pool, label, readingOf(40, 60, { weeklyResetAt: START + 10_000 })) }),
  otherOnly: label => ({ label, setup: pool => completeRead(pool, label,
    { primary_used_percent: 50, primary_window_minutes: 120, primary_reset_at: START + 3_600_000 }) }),
};

function boundaryProjection({ accounts, source = 'daemon', enabled = true, adapt = pool => pool, poller = null }) {
  const pool = createCodexPool(accounts.map(({ label, models = null }) => ({ key: keyOf(label), label, models })),
    { ...TIMING, accounts: accounts.map(({ label, policy }) => ({ label, usagePolicy: { ...POLICY, ...policy } })) });
  for (const { label, setup } of accounts) {
    pool.usageConfirmed(keyOf(label), START);
    setup?.(pool);
  }
  return projectCodexStatus({ enabled, pool: adapt(pool), poller, source, nowMs: BOUNDARY_NOW });
}

// プールの写しの窓を差し替える（プールで作れない状態のため）。
const withWindows = change => pool => ({ ...pool,
  snapshot: () => pool.snapshot().map(entry => ({ ...entry, windows: change(entry.windows) })) });

const BOUNDARY_PROJECTIONS = [
  { row: 1, accounts: [], expect: [0, 0], headrooms: [] },
  { row: 2, accounts: [], enabled: false, expect: [null, 0], headrooms: [] },
  { row: 3, accounts: ['zz-a', 'zz-b', 'zz-c'].map(spec.unread), expect: [null, 0], headrooms: [null, null, null] },
  { row: 4, accounts: [spec.ready('zz-a'), spec.capped('zz-b'), spec.unread('zz-c')], expect: [null, 15],
    windows: [null, null], headrooms: [15, 0, null] },
  { row: 5, accounts: [spec.ready('zz-a'), spec.capped('zz-b')], expect: [15, 15], windows: [35, 15], headrooms: [15, 0] },
  { row: 6, accounts: [spec.staleWeekly('zz-a')], expect: [null, 0], windows: [35, null], headrooms: [null] },
  { row: 7, accounts: [spec.ready('zz-a')], expect: [null, 0], headrooms: [null],
    adapt: withWindows(windows => ({ ...windows, 'len:300': { ...windows['len:300'], usedPercent: undefined } })) },
  { row: 8, accounts: [spec.reserved('zz-a')], expect: [0, 0], headrooms: [0] },
  { row: 9, accounts: [spec.needsLogin('zz-a')], expect: [0, 0], headrooms: [0] },
  { row: 10, accounts: [spec.noModels('zz-a')], expect: [0, 0], headrooms: [0] },
  { row: 11, source: 'direct', accounts: [spec.ready('zz-a', 80, 20)], expect: [0, 0], windows: [0, 0], headrooms: [0] },
  { row: 12, source: 'direct', accounts: [spec.ready('zz-a', 30, 30)], expect: [null, 0], headrooms: [null] },
  { row: 13, accounts: [spec.otherOnly('zz-a')], expect: [25, 25], windows: [null, null], headrooms: [25] },
  { row: 14, accounts: [spec.ready('zz-a')], expect: [null, 0], headrooms: [null], adapt: withWindows(() => ({})) },
  { row: 15, accounts: [{ label: 'zz-a', setup: pool => completeRead(pool, 'zz-a', readingOf(90)) }], expect: [0, 0],
    headrooms: [0] },
  { row: 16, accounts: [spec.ready('zz-a'), spec.unread('zz-b')], expect: [null, 15], headrooms: [15, null] },
  { row: 17, source: 'direct', accounts: [spec.ready('zz-a', 30, 30), spec.unread('zz-b')], expect: [null, 0],
    headrooms: [null, null],
    poller: { observation: () => ({ gate: 'failed' }),
      accountHealth: key => (key === keyOf('zz-b')
        ? { lastObservationAttemptAt: START, observationErrorCode: 'read-deadline', observationGate: 'failed' }
        : { lastObservationAttemptAt: START, observationErrorCode: null, observationGate: 'passed', ordinaryUsageAllowed: true }) } },
];

for (const row of BOUNDARY_PROJECTIONS) {
  test(`aggregate row ${row.row} through the projection`, () => {
    const json = boundaryProjection(row);
    assert.equal(codexStatusProblem(json), null, 'the projection passes the schema check');
    const { aggregate } = json;
    assert.deepEqual([aggregate.effectiveRemainingPercent, aggregate.lowerBoundPercent], row.expect);
    if (row.windows) assert.deepEqual([aggregate.fiveHourRemainingPercent, aggregate.weeklyRemainingPercent], row.windows);
    const headrooms = json.accounts.map(account => account.headroomPercent);
    assert.deepEqual(headrooms, row.headrooms);
    assert.equal(aggregate.lowerBoundPercent, headrooms.filter(value => value !== null).reduce((sum, value) => sum + value, 0));
    assert.equal(aggregate.accountsTotal, row.accounts.length);
    if (row.row === 17) assert.equal(json.accounts[1].reason, 'read-deadline');
  });
}

// 15行の条件どおり「使える口座で5時間窓が90%（停止の手前の一瞬）」を、射影の出力でも確かめる。プールは
// 停止しきい値以上の窓を読むとその場で止めるので、プールには10%を読ませて使える口座のままにし、7行・14行と
// 同じく写しの窓だけを90%へ差し替える（プールの選択の規則は10%を読んだまま、選べる口座として答える）。
test('aggregate row 15 through the projection, with the account still ready at 90% (the moment before the stop)', () => {
  const json = boundaryProjection({ accounts: [spec.ready('zz-a', 10)],
    adapt: withWindows(windows => ({ ...windows, 'len:300': { ...windows['len:300'], usedPercent: 90 } })) });
  assert.equal(codexStatusProblem(json), null);
  const [account] = json.accounts;
  assert.equal(account.stateWord, 'ready');
  assert.equal(account.windows.fiveHour.usedPercent, 90);
  assert.equal(account.headroomPercent, 0, 'max(0, 75 - 90) for the five-hour window');
  assert.deepEqual([json.aggregate.effectiveRemainingPercent, json.aggregate.lowerBoundPercent], [0, 0]);
  assert.deepEqual([json.aggregate.fiveHourRemainingPercent, json.aggregate.weeklyRemainingPercent], [0, 15]);
});

test('aggregate rows through the projection: 17 rows, with the per-window totals of rows 4, 5, 6, 11 and 13', () => {
  assert.deepEqual(BOUNDARY_PROJECTIONS.map(row => row.row), Array.from({ length: 17 }, (_, i) => i + 1));
  assert.deepEqual(BOUNDARY_PROJECTIONS.filter(row => row.windows).map(row => row.row), [4, 5, 6, 11, 13]);
});

test('aggregate: the counts, a three-account example (ready, capped, unread) and the per-account headroom', () => {
  const accounts = [readyA(), jsonAccount('zz-b', 'capped'), jsonAccount('zz-c', 'unread')];
  assert.deepEqual(accounts.map(account => codexAccountHeadroom(account, { source: 'daemon' })), [15, 0, null]);
  assert.deepEqual(accounts.map(account => codexAccountHeadroom(account, { source: 'daemon', part: 'fiveHour' })), [35, 0, null]);
  assert.deepEqual(aggregateCodexAccounts(accounts, { enabled: true, source: 'daemon' }), {
    effectiveRemainingPercent: null, lowerBoundPercent: 15, fiveHourRemainingPercent: null, weeklyRemainingPercent: null,
    accountsTotal: 3, accountsAvailable: 1, accountsSelectable: 1, accountsUnknown: 1, unit: 'percent-points-of-one-account' });
  assert.equal(aggregateCodexAccounts(accounts.slice(0, 2), { enabled: true, source: 'daemon' }).effectiveRemainingPercent, 15);
  assert.throws(() => codexAccountHeadroom(accounts[0], { source: 'daemon', part: 'constructor' }), TypeError);
  assert.throws(() => aggregateCodexAccounts(accounts, { enabled: true, source: 'cache' }), TypeError);
});
