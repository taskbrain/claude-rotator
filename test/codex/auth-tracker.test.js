// ログイン切れの検出（src/codex/auth-tracker.js）のテスト。
//
// 規則だけを確かめる。GET の結果（readCodexUsage の戻り値の形）と資格情報の読取の結果は合成で
// 渡し、本物の口座プールの状態で結果を見る。ネットワーク・資格情報のファイル・子プロセスには
// 触れない（テストの隔離を通す）。取得処理と組み合わせた確かめは usage-poller.test.js にある。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USAGE_AUTH_REJECTION_REASONS, createCodexAccountPool } from '../../src/codex/account-pool.js';
import {
  AUTH_REJECTIONS_FOR_NEEDS_LOGIN, AUTH_REJECTION_REASON, CREDENTIALS_OUTCOME, UNREADABLE_CYCLES_FOR_NO_CREDS,
  createAuthTracker,
} from '../../src/codex/auth-tracker.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const CYCLE_MS = 60_000;
const RECHECK_MS = 600_000;

const ok = () => ({ classification: 'success', failure: null, status: 200 });
const rejected = status => ({ classification: 'http-error', failure: status === 401 ? 'unauthorized' : 'forbidden', status });
const NEUTRAL_RESULTS = Object.freeze({
  timeout: () => ({ classification: 'network-error', failure: 'timeout', status: null }),
  'server-error': () => ({ classification: 'http-error', failure: 'server-error', status: 503 }),
  'rate-limited': () => ({ classification: 'http-error', failure: 'rate-limited', status: 429 }),
});

async function fixture(t, { accounts = 2 } = {}) {
  await setupCodexIsolation(t);
  let at = START;
  const entries = Array.from({ length: accounts }, (_, i) => ({ key: `zz-key-${i}`, label: `zz-${i}`, models: null }));
  const pool = createCodexAccountPool(entries, { usageObservationMode: 'http', usagePollIntervalMs: CYCLE_MS,
    usageReadTimeoutMs: 5000, rotationObservationTtlMs: 125000,
    accounts: entries.map(entry => ({ label: entry.label, usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 } })) });
  const logs = [];
  const tracker = createAuthTracker({ pool, now: () => at, log: (level, event, fields) => logs.push({ level, event, fields }) });
  tracker.configure(entries, { usagePollIntervalMs: CYCLE_MS });
  const keyOf = index => entries[index].key;
  const entryOf = index => pool.snapshot().find(entry => entry.key === keyOf(index));
  return {
    pool, tracker, logs,
    state: index => entryOf(index).state,
    entry: entryOf,
    advance(ms) { at += ms; },
    now: () => at,
    /** 1つの口座の1周期: 資格情報が読めて、GET の結果が result だった。 */
    cycle(index, result, epoch = 1) {
      tracker.credentialsRead(keyOf(index), CREDENTIALS_OUTCOME.readable, epoch);
      tracker.usageResult(keyOf(index), result, epoch, { startedAt: at });
    },
    credentials(index, outcome, epoch = 1) { tracker.credentialsRead(keyOf(index), outcome, epoch); },
    shouldRead(index, epoch = 1) { return tracker.shouldRead(keyOf(index), epoch); },
    logged: event => logs.filter(line => line.event === event),
  };
}

test('auth tracker: the rule constants and the reasons match the pool', async t => {
  await setupCodexIsolation(t);
  assert.equal(AUTH_REJECTIONS_FOR_NEEDS_LOGIN, 2);
  assert.equal(UNREADABLE_CYCLES_FOR_NO_CREDS, 2);
  assert.deepEqual(Object.values(AUTH_REJECTION_REASON).sort(), [...USAGE_AUTH_REJECTION_REASONS].sort());
  assert.throws(() => createAuthTracker(), /pool/);
});

test('auth tracker: readable credentials make an unknown account ready without waiting for a GET', async t => {
  const f = await fixture(t);
  assert.equal(f.state(0), 'unknown');
  f.credentials(0, CREDENTIALS_OUTCOME.readable);
  assert.equal(f.state(0), 'ready');
});

// --- ログイン切れの検出の規則 ---

test('auth tracker: a single 401 does not make needs login', async t => {
  const f = await fixture(t);
  f.cycle(0, ok());
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401));
  assert.equal(f.state(0), 'ready');
  f.advance(CYCLE_MS);
  f.cycle(0, ok());
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401));
  assert.equal(f.state(0), 'ready', 'a success between two 401s resets the count');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
});

test('auth tracker: 401, a credential file update, then 401 counts afresh and does not make needs login', async t => {
  const f = await fixture(t);
  f.cycle(0, rejected(401), 1);
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401), 2); // The CLI rewrote auth.json in between: its mtime moved.
  assert.equal(f.state(0), 'ready');
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401), 2); // The same new token refused twice does count.
  assert.equal(f.state(0), 'needs-login');
});

test('auth tracker: two 401s in a row make needs login with the reason upstream-unauthorized', async t => {
  const f = await fixture(t, { accounts: 1 });
  f.cycle(0, rejected(401), 7);
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401), 7);
  const entry = f.entry(0);
  assert.equal(entry.state, 'needs-login');
  assert.equal(entry.authReason, 'upstream-unauthorized');
  assert.equal(entry.seenMtime, 7);
  assert.equal(entry.recheckAt, f.now() + RECHECK_MS);
  assert.deepEqual(f.logged('codex_auth_needs_login').map(line => ({ level: line.level, ...line.fields })),
    [{ level: 'info', account_label: 'zz-0', reason: 'upstream-unauthorized' }]);
});

test('auth tracker: with a single account 403 is never counted, however often it repeats', async t => {
  const f = await fixture(t, { accounts: 1 });
  for (let i = 0; i < 10; i++) {
    f.cycle(0, rejected(403));
    f.advance(CYCLE_MS);
  }
  assert.equal(f.state(0), 'ready');
  // 401 still counts with one account, and a 403 in between neither adds to it nor resets it.
  f.cycle(0, rejected(401));
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(403));
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401));
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.entry(0).authReason, 'upstream-unauthorized');
});

for (const order of ['403 lands first', 'the other success lands first']) {
  test(`auth tracker: two 403s make needs login when another account succeeded in the same cycle (${order})`, async t => {
    const f = await fixture(t);
    f.cycle(0, rejected(403));
    f.cycle(1, ok());
    assert.equal(f.state(0), 'ready', 'one 403 is not enough, whoever else succeeded');
    f.advance(CYCLE_MS);
    if (order === 'the other success lands first') f.cycle(1, ok());
    f.cycle(0, rejected(403));
    if (order === '403 lands first') {
      assert.equal(f.state(0), 'ready', 'a success one full cycle earlier does not corroborate this 403');
      f.cycle(1, ok());
    }
    assert.equal(f.state(0), 'needs-login');
    assert.equal(f.entry(0).authReason, 'upstream-forbidden');
    assert.equal(f.state(1), 'ready');
    assert.deepEqual(f.logged('codex_auth_needs_login').map(line => line.fields),
      [{ account_label: 'zz-0', reason: 'upstream-forbidden' }]);
  });
}

test('auth tracker: in a cycle where every account fails, a run of 403s never makes needs login', async t => {
  const f = await fixture(t, { accounts: 3 });
  for (let i = 0; i < 10; i++) {
    f.cycle(0, rejected(403));
    f.cycle(1, rejected(403));
    f.cycle(2, NEUTRAL_RESULTS['server-error']());
    f.advance(CYCLE_MS);
  }
  for (const index of [0, 1, 2]) assert.equal(f.state(index), 'ready');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
});

for (const [name, result] of Object.entries(NEUTRAL_RESULTS)) {
  test(`auth tracker: ${name} ten times in a row never makes needs login, and neither adds to nor resets a 401 run`, async t => {
    const f = await fixture(t);
    f.cycle(1, ok());
    for (let i = 0; i < 10; i++) {
      f.cycle(0, result());
      f.advance(CYCLE_MS);
    }
    assert.equal(f.state(0), 'ready');
    f.cycle(0, rejected(401));
    f.advance(CYCLE_MS);
    f.cycle(0, result());
    f.advance(CYCLE_MS);
    assert.equal(f.state(0), 'ready');
    f.cycle(0, rejected(401));
    assert.equal(f.state(0), 'needs-login', `${name} between two 401s does not reset the run`);
  });
}

test('auth tracker: an expired access token makes needs login at once with the reason access-token-expired', async t => {
  const f = await fixture(t);
  f.credentials(0, CREDENTIALS_OUTCOME.readable);
  f.credentials(0, CREDENTIALS_OUTCOME.expired, 5);
  const entry = f.entry(0);
  assert.equal(entry.state, 'needs-login');
  assert.equal(entry.authReason, 'access-token-expired');
  assert.equal(entry.seenMtime, 5);
  assert.deepEqual(f.logged('codex_auth_needs_login').map(line => line.fields),
    [{ account_label: 'zz-0', reason: 'access-token-expired' }]);
  // (usage-poller.test.js confirms that the poller sends no GET for this cycle.)
});

test('auth tracker: unreadable credentials hold for one cycle and become no creds on the second', async t => {
  const f = await fixture(t);
  f.credentials(0, CREDENTIALS_OUTCOME.readable);
  f.credentials(0, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.state(0), 'ready', 'one unreadable cycle is held');
  f.credentials(0, CREDENTIALS_OUTCOME.readable);
  f.credentials(0, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.state(0), 'ready', 'a readable cycle in between starts the count again');
  f.credentials(0, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.state(0), 'credentials-unavailable');
  assert.deepEqual(f.logged('codex_credentials_unavailable').map(line => line.fields), [{ account_label: 'zz-0' }]);
  f.credentials(0, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.logged('codex_credentials_unavailable').length, 1, 'announced once, not every cycle');
  f.credentials(0, CREDENTIALS_OUTCOME.readable);
  assert.equal(f.state(0), 'ready', 'readable credentials bring it back');
  // From the initial unknown state the same two-cycle rule applies.
  f.credentials(1, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.state(1), 'unknown');
  f.credentials(1, CREDENTIALS_OUTCOME.unreadable);
  assert.equal(f.state(1), 'credentials-unavailable');
});

test('auth tracker: no GET while needs login; the recheck sends one and a 2xx brings the account back', async t => {
  const f = await fixture(t);
  f.cycle(0, rejected(401), 3);
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401), 3);
  assert.equal(f.state(0), 'needs-login');
  const rejectedAt = f.now();
  for (let elapsed = CYCLE_MS; elapsed < RECHECK_MS; elapsed += CYCLE_MS) {
    f.advance(CYCLE_MS);
    assert.equal(f.shouldRead(0, 3), false, `no read ${elapsed}ms after the rejection`);
  }
  f.advance(CYCLE_MS);
  assert.equal(f.now() - rejectedAt, RECHECK_MS);
  assert.equal(f.shouldRead(0, 3), true, 'the recheck interval has passed');
  // A recheck that is refused again, or that fails otherwise, keeps it and books the next recheck.
  f.cycle(0, rejected(401), 3);
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.entry(0).recheckAt, f.now() + RECHECK_MS);
  assert.equal(f.shouldRead(0, 3), false);
  f.advance(RECHECK_MS);
  f.cycle(0, NEUTRAL_RESULTS.timeout(), 3);
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.shouldRead(0, 3), false);
  // A credential file update opens the recheck early (a new login, or the CLI refreshing the token).
  f.advance(CYCLE_MS);
  assert.equal(f.shouldRead(0, 4), true);
  f.cycle(0, ok(), 4);
  assert.equal(f.state(0), 'ready');
  for (const field of ['authReason', 'recheckAt', 'forbiddenAt']) assert.equal(f.entry(0)[field], undefined, field);
  assert.deepEqual(f.logged('codex_auth_recovered').map(line => line.fields), [{ account_label: 'zz-0' }]);
  assert.equal(f.shouldRead(0, 4), true);
});

test('auth tracker: an expired token is rechecked by reading the credentials again, never by guessing', async t => {
  const f = await fixture(t);
  f.credentials(0, CREDENTIALS_OUTCOME.expired, 1);
  f.advance(RECHECK_MS);
  assert.equal(f.shouldRead(0, 1), true);
  f.credentials(0, CREDENTIALS_OUTCOME.expired, 1); // Still expired at the recheck.
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.entry(0).recheckAt, f.now() + RECHECK_MS);
  f.credentials(0, CREDENTIALS_OUTCOME.readable, 2); // Readable again: still needs a 2xx.
  assert.equal(f.state(0), 'needs-login', 'a readable local token alone does not end the login requirement');
  f.tracker.usageResult('zz-key-0', null, 2); // No GET was sent (for example no User-Agent).
  assert.equal(f.state(0), 'needs-login');
  f.cycle(0, ok(), 2);
  assert.equal(f.state(0), 'ready');
});

test('auth tracker: a reload keeps the count of accounts that stay and drops the ones removed', async t => {
  const f = await fixture(t);
  f.cycle(0, rejected(401));
  f.tracker.configure([{ key: 'zz-key-0', label: 'zz-0' }], { usagePollIntervalMs: CYCLE_MS });
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(401));
  assert.equal(f.state(0), 'needs-login', 'a reload is not a reason to count afresh');
  f.tracker.usageResult('zz-key-unknown', rejected(401), 1);
  f.tracker.credentialsRead('zz-key-unknown', CREDENTIALS_OUTCOME.unreadable, 1);
  assert.equal(f.tracker.shouldRead('zz-key-unknown', 1), true);
});

// --- 見落としやすい2件の再現（前の周期の成功を裏付けにしない／403 が1回混ざっても 401 の連続で決める） ---

test('auth tracker: a success in the previous cycle does not corroborate a 403 (A 0s 403, B 1s ok, A 60s 403, B 61s 503)', async t => {
  const f = await fixture(t);
  f.cycle(0, rejected(403)); // A at 0s
  f.advance(1_000);
  f.cycle(1, ok()); // B at 1s: this belongs to the first cycle
  f.advance(59_000);
  f.cycle(0, rejected(403)); // A at 60s: its own cycle has no success yet
  assert.equal(f.state(0), 'ready', 'the success 59s earlier is the previous cycle, not this one');
  f.advance(1_000);
  f.cycle(1, NEUTRAL_RESULTS['server-error']()); // B at 61s fails: every account failed this cycle
  assert.equal(f.state(0), 'ready');
  assert.equal(f.logged('codex_auth_needs_login').length, 0);
  // The nearest success still corroborates, even a second off.
  f.advance(59_000);
  f.cycle(0, rejected(403)); // A at 120s
  f.advance(1_000);
  f.cycle(1, ok()); // B at 121s
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.entry(0).authReason, 'upstream-forbidden');
});

test('auth tracker: one 403 does not block a later run of 401s (two accounts, the other failing throughout)', async t => {
  const f = await fixture(t);
  const sequence = [403, 401, 401, 401, 401];
  const states = [];
  for (const status of sequence) {
    f.cycle(1, NEUTRAL_RESULTS['server-error']());
    f.cycle(0, rejected(status));
    states.push(f.state(0));
    if (f.state(0) === 'needs-login') break;
    f.advance(CYCLE_MS);
  }
  assert.deepEqual(states, ['ready', 'ready', 'needs-login'], 'the two most recent refusals are both 401');
  assert.equal(f.entry(0).authReason, 'upstream-unauthorized');
});

test('auth tracker: a 403 before a reload to one account does not block the 401s after it', async t => {
  const f = await fixture(t);
  f.cycle(0, rejected(403));
  f.tracker.configure([{ key: 'zz-key-0', label: 'zz-0' }], { usagePollIntervalMs: CYCLE_MS });
  const states = [];
  for (let i = 0; i < 3; i++) {
    f.advance(CYCLE_MS);
    f.cycle(0, rejected(401));
    states.push(f.state(0));
    if (f.state(0) === 'needs-login') break;
  }
  assert.deepEqual(states, ['ready', 'needs-login']);
  assert.equal(f.entry(0).authReason, 'upstream-unauthorized');
});

test('auth tracker: exactly half a poll interval apart is not the same cycle, on either side of the 403', async t => {
  // 「同じ周期」は時刻の差が取得の間隔（60s）の半分より短いこと。ちょうど半分（30s）は裏付けの無い側に倒す。
  const f = await fixture(t);
  f.cycle(0, rejected(403)); // A at 0s
  f.advance(CYCLE_MS);
  f.cycle(0, rejected(403)); // A at 60s: two 403s in a row
  f.advance(CYCLE_MS / 2);
  f.cycle(1, ok()); // B at +90000ms: exactly half an interval after A's second 403
  assert.equal(f.state(0), 'ready', 'a success exactly half an interval later does not corroborate');
  f.advance(CYCLE_MS / 2);
  f.cycle(0, rejected(403)); // A at 120s: exactly half an interval after B's success
  assert.equal(f.state(0), 'ready', 'nor does one exactly half an interval earlier');
  f.advance(CYCLE_MS / 2 - 1);
  f.cycle(1, ok()); // B one millisecond inside the half interval
  assert.equal(f.state(0), 'needs-login');
  assert.equal(f.entry(0).authReason, 'upstream-forbidden');
});
