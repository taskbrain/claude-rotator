// codex-rotator の状態の JSON の形の検査（src/shared/codex-status-schema.js）のテスト。
// 正しい見本が通ること、余分なキー・欠けたキー・型違い・語彙の外の値が落ちること、落ちたときの説明に
// 値と知らないキーの名前が出ないこと、語彙と時間の定数を確かめる。純粋関数だけで、I/O はしない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_ACCOUNT_REASONS, CODEX_ACCOUNT_STATES, CODEX_CHILD_TIMEOUT_MS, CODEX_DIRECT_READ_CONCURRENCY,
  CODEX_EVENTS_LIMIT, CODEX_EVENT_TYPES, CODEX_NEXT_REASONS, CODEX_POOL_STATES, CODEX_SECTION_DEADLINE_MS,
  CODEX_STATE_OF_WORD, CODEX_STATE_WORDS, CODEX_USER_AGENT_SOURCES, codexIsoTime, codexStatusProblem,
  isCodexIsoTime, isCodexLabel, isValidCodexStatus,
} from '../../src/shared/codex-status-schema.js';

const T0 = '2027-01-15T08:00:00Z';
const LATER = '2027-01-15T10:00:00Z';
const DUMMY_EMAIL = 'zz-dummy@example.invalid';

const windowOf = overrides => ({ usedPercent: 40, resetAt: LATER, windowMinutes: 300, fresh: true, observedAt: T0,
  lengthSource: 'reported', ...overrides });
const policyOf = () => ({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });

// 3口座（使える・自分の線で停止・ログイン切れ）の正しい見本。
function sample() {
  return {
    schemaVersion: 1,
    provider: 'codex',
    enabled: true,
    generatedAt: T0,
    source: 'daemon',
    latchKnown: true,
    daemon: { reachable: true, startedAt: '2027-01-15T07:00:00Z' },
    pool: { state: 'mixed', resetAt: null },
    observation: { method: 'usage-get', startupCheck: 'passed', accountUsageIncludesExternalClients: true,
      cliConsumptionVisible: false, userAgentSource: 'codex-version' },
    next: { label: 'zz-a', reason: 'selectable' },
    accounts: [
      { label: 'zz-a', state: 'available', stateWord: 'ready', selectable: true, reason: null, resetAt: null,
        ordinaryUsageAllowed: true, nextObservationAt: '2027-01-15T08:01:00Z', policy: policyOf(), latch: null,
        windows: { fiveHour: windowOf(), weekly: windowOf({ usedPercent: 60, windowMinutes: 10080 }) },
        otherWindows: [], observedAt: T0, headroomPercent: 15 },
      { label: 'zz-b', state: 'exhausted', stateWord: 'held', selectable: false, reason: 'usage-capped', resetAt: null,
        ordinaryUsageAllowed: true, nextObservationAt: null, policy: policyOf(),
        latch: { stopped: true, cappedWindows: ['fiveHour'], upstreamBlocked: false, cleanReadsDone: 1,
          cleanReadsNeeded: 2, since: T0 },
        windows: { fiveHour: windowOf({ usedPercent: 80 }), weekly: null },
        otherWindows: [windowOf({ windowMinutes: 120 })], observedAt: T0, headroomPercent: 0 },
      { label: 'zz-c', state: 'login_required', stateWord: 'needs login', selectable: false,
        reason: 'upstream-unauthorized', resetAt: null, ordinaryUsageAllowed: null, nextObservationAt: null,
        policy: policyOf(), latch: null, windows: { fiveHour: null, weekly: null }, otherWindows: [],
        observedAt: null, headroomPercent: 0 },
    ],
    aggregate: { effectiveRemainingPercent: 15, lowerBoundPercent: 15, fiveHourRemainingPercent: 35,
      weeklyRemainingPercent: 15, accountsTotal: 3, accountsAvailable: 1, accountsSelectable: 1, accountsUnknown: 0,
      unit: 'percent-points-of-one-account' },
    events: [{ at: T0, type: 'stopped', label: 'zz-b' }, { at: T0, type: 'reloaded', label: null }],
  };
}

function mutated(change) {
  const value = sample();
  change(value);
  return value;
}

test('schema: the sample passes and so does its JSON round trip', () => {
  assert.equal(codexStatusProblem(sample()), null);
  assert.equal(codexStatusProblem(JSON.parse(JSON.stringify(sample()))), null);
  assert.equal(isValidCodexStatus(sample()), true);
});

test('schema: an extra key is refused at every level', () => {
  const places = {
    'status': value => value,
    'status.daemon': value => value.daemon,
    'status.pool': value => value.pool,
    'status.observation': value => value.observation,
    'status.next': value => value.next,
    'status.accounts[0]': value => value.accounts[0],
    'status.accounts[0].policy': value => value.accounts[0].policy,
    'status.accounts[1].latch': value => value.accounts[1].latch,
    'status.accounts[0].windows': value => value.accounts[0].windows,
    'status.accounts[0].windows.fiveHour': value => value.accounts[0].windows.fiveHour,
    'status.accounts[1].otherWindows[0]': value => value.accounts[1].otherWindows[0],
    'status.aggregate': value => value.aggregate,
    'status.events[0]': value => value.events[0],
  };
  for (const [where, pick] of Object.entries(places)) {
    const value = mutated(v => { pick(v).zzExtra = 1; });
    assert.equal(codexStatusProblem(value), `${where} has an unknown key`, where);
  }
});

test('schema: a key with a symbol name or a non-plain object is refused', () => {
  assert.match(codexStatusProblem(mutated(v => { v.pool[Symbol('zz')] = 1; })), /^status\.pool has an unknown key$/);
  class Holder {}
  assert.match(codexStatusProblem(mutated(v => { v.daemon = Object.assign(new Holder(), v.daemon); })),
    /^status\.daemon must be an object$/);
  assert.match(codexStatusProblem(mutated(v => { v.accounts[0] = [v.accounts[0]]; })), /^status\.accounts\[0\] must be an object$/);
  assert.match(codexStatusProblem(null), /^status must be an object$/);
});

test('schema: an array with a missing element is refused, before and after the JSON round trip', () => {
  const cases = [
    [v => { v.events = new Array(1); }, 'status.events[0] is missing', 'status.events[0] must be an object'],
    [v => { delete v.accounts[1]; }, 'status.accounts[1] is missing', 'status.accounts[1] must be an object'],
    [v => { v.accounts[1].otherWindows = new Array(1); }, 'status.accounts[1].otherWindows[0] is missing',
      'status.accounts[1].otherWindows[0] must be an object'],
    [v => { v.accounts[1].latch.cappedWindows = new Array(1); }, 'status.accounts[1].latch.cappedWindows[0] is missing',
      'status.accounts[1].latch.cappedWindows[0] is not an allowed value'],
  ];
  for (const [change, before, after] of cases) {
    const value = mutated(change);
    assert.equal(codexStatusProblem(value), before);
    assert.equal(codexStatusProblem(JSON.parse(JSON.stringify(value))), after, 'the JSON of it is refused as well');
  }
});

test('schema: an array with a key of its own is refused', () => {
  const cases = [
    [v => { v.events.zzExtra = 1; }, 'status.events has an unknown key'],
    [v => { v.accounts.zzExtra = 'zz-dummy@example.invalid'; }, 'status.accounts has an unknown key'],
    [v => { v.accounts[1].otherWindows[Symbol('zz')] = 1; }, 'status.accounts[1].otherWindows has an unknown key'],
    [v => { v.accounts[1].latch.cappedWindows['-1'] = 'weekly'; }, 'status.accounts[1].latch.cappedWindows has an unknown key'],
    [v => { v.events['01'] = v.events[0]; }, 'status.events has an unknown key'],
  ];
  for (const [change, problem] of cases) assert.equal(codexStatusProblem(mutated(change)), problem);
  // JSON にすると余分なキーは消えるので、送る前の値の検査のほうが厳しい。
  assert.equal(codexStatusProblem(JSON.parse(JSON.stringify(mutated(v => { v.events.zzExtra = 1; })))), null);
});

test('schema: a missing key is refused (unknown values are null, never left out)', () => {
  assert.equal(codexStatusProblem(mutated(v => { delete v.events; })), 'status.events is missing');
  assert.equal(codexStatusProblem(mutated(v => { delete v.accounts[0].headroomPercent; })),
    'status.accounts[0].headroomPercent is missing');
  assert.equal(codexStatusProblem(mutated(v => { delete v.accounts[1].latch.since; })), 'status.accounts[1].latch.since is missing');
  assert.equal(codexStatusProblem(mutated(v => { v.accounts[0].otherWindows = null; })),
    'status.accounts[0].otherWindows must be an array');
});

test('schema: values of the wrong type or out of range are refused', () => {
  const cases = [
    [v => { v.enabled = 'true'; }, 'status.enabled must be true or false'],
    [v => { v.latchKnown = 1; }, 'status.latchKnown must be true or false'],
    [v => { v.accounts[0].selectable = 'yes'; }, 'status.accounts[0].selectable must be true or false'],
    [v => { v.accounts[0].windows.fiveHour.usedPercent = '40'; }, 'status.accounts[0].windows.fiveHour.usedPercent must be a finite number'],
    [v => { v.accounts[0].windows.fiveHour.usedPercent = 101; }, 'status.accounts[0].windows.fiveHour.usedPercent is above its range'],
    [v => { v.accounts[0].windows.fiveHour.windowMinutes = 1.5; }, 'status.accounts[0].windows.fiveHour.windowMinutes must be an integer in its range'],
    [v => { v.accounts[0].windows.fiveHour.windowMinutes = 0; }, 'status.accounts[0].windows.fiveHour.windowMinutes must be an integer in its range'],
    [v => { v.accounts[0].windows.fiveHour.fresh = null; }, 'status.accounts[0].windows.fiveHour.fresh must be true or false'],
    [v => { v.accounts[0].headroomPercent = -1; }, 'status.accounts[0].headroomPercent is below its range'],
    [v => { v.accounts[0].policy.stopUsedPercent = 0; }, 'status.accounts[0].policy.stopUsedPercent is below its range'],
    [v => { v.accounts[0].policy.resumeUsedPercent = 75; }, 'status.accounts[0].policy.resumeUsedPercent is above its range'],
    [v => { v.accounts[0].policy.blockWhenUnknown = null; }, 'status.accounts[0].policy.blockWhenUnknown must be true or false'],
    [v => { v.accounts[1].latch.stopped = 'true'; }, 'status.accounts[1].latch.stopped must be true or false'],
    [v => { v.aggregate.lowerBoundPercent = null; }, 'status.aggregate.lowerBoundPercent must be a finite number'],
    [v => { v.aggregate.effectiveRemainingPercent = Number.NaN; }, 'status.aggregate.effectiveRemainingPercent must be a finite number'],
    [v => { v.aggregate.accountsTotal = 2; }, 'status.aggregate.accountsTotal does not match the number of accounts'],
    [v => { v.aggregate.accountsUnknown = -1; }, 'status.aggregate.accountsUnknown must be an integer in its range'],
    [v => { v.aggregate.accountsSelectable = 4; }, 'status.aggregate.accountsSelectable must be an integer in its range'],
    [v => { v.daemon.reachable = null; }, 'status.daemon.reachable must be true or false'],
  ];
  for (const [change, problem] of cases) assert.equal(codexStatusProblem(mutated(change)), problem);
});

test('schema: times must be UTC seconds without milliseconds and must exist', () => {
  const problem = 'status.generatedAt must be a UTC time of the form YYYY-MM-DDTHH:MM:SSZ';
  for (const value of ['2027-01-15T08:00:00.000Z', '2027-01-15T17:00:00+09:00', '2027-02-30T00:00:00Z', '2027-01-15 08:00:00Z',
    1_800_000_000_000, null]) {
    assert.equal(codexStatusProblem(mutated(v => { v.generatedAt = value; })), problem, String(value));
  }
  assert.equal(codexStatusProblem(mutated(v => { v.accounts[0].windows.fiveHour.observedAt = '2027-01-15T08:00:00.5Z'; })),
    'status.accounts[0].windows.fiveHour.observedAt must be a UTC time of the form YYYY-MM-DDTHH:MM:SSZ');
  assert.equal(codexStatusProblem(mutated(v => { v.pool.resetAt = null; v.daemon.startedAt = null; })), null);
});

test('schema: values outside the vocabulary are refused', () => {
  const cases = [
    [v => { v.observation.userAgentSource = 'other'; }, 'status.observation.userAgentSource is not an allowed value'],
    [v => { v.accounts[0].stateWord = 'cooldown'; }, 'status.accounts[0].stateWord is not an allowed value'],
    [v => { v.accounts[0].state = 'ready'; }, 'status.accounts[0].state is not an allowed value'],
    [v => { v.accounts[0].state = 'unknown'; }, 'status.accounts[0].state does not match stateWord'],
    [v => { v.accounts[1].latch.cleanReadsDone = 2; }, 'status.accounts[1].latch.cleanReadsDone must be an integer in its range'],
    [v => { v.accounts[1].latch.cleanReadsNeeded = 3; }, 'status.accounts[1].latch.cleanReadsNeeded is not an allowed value'],
    [v => { v.accounts[1].latch.cappedWindows = ['primary']; }, 'status.accounts[1].latch.cappedWindows[0] is not an allowed value'],
    [v => { v.accounts[1].latch.cappedWindows = ['weekly', 'weekly']; }, 'status.accounts[1].latch.cappedWindows must not repeat a window'],
    [v => { v.pool.state = 'overloaded'; }, 'status.pool.state is not an allowed value'],
    [v => { v.accounts[2].reason = 'needs-login'; }, 'status.accounts[2].reason is not an allowed value'],
    [v => { v.accounts[0].reason = 'disabled'; }, 'status.accounts[0].reason is not an allowed value'],
    [v => { v.next.reason = 'usage-capped'; }, 'status.next.reason is not an allowed value'],
    [v => { v.events[0].type = 'deleted'; }, 'status.events[0].type is not an allowed value'],
    [v => { v.accounts[0].windows.fiveHour.lengthSource = 'guess'; }, 'status.accounts[0].windows.fiveHour.lengthSource is not an allowed value'],
    [v => { v.observation.startupCheck = 'skipped'; }, 'status.observation.startupCheck is not an allowed value'],
    [v => { v.observation.method = 'response-headers'; }, 'status.observation.method is not an allowed value'],
    [v => { v.schemaVersion = 2; }, 'status.schemaVersion is not an allowed value'],
    [v => { v.provider = 'claude'; }, 'status.provider is not an allowed value'],
    [v => { v.source = 'cache'; }, 'status.source is not an allowed value'],
    [v => { v.aggregate.unit = 'percent'; }, 'status.aggregate.unit is not an allowed value'],
  ];
  for (const [change, problem] of cases) assert.equal(codexStatusProblem(mutated(change)), problem);
});

test('schema: every allowed value of each vocabulary passes', () => {
  for (const source of [...CODEX_USER_AGENT_SOURCES, null]) {
    assert.equal(codexStatusProblem(mutated(v => { v.observation.userAgentSource = source; })), null, String(source));
  }
  for (const word of CODEX_STATE_WORDS) {
    assert.equal(codexStatusProblem(mutated(v => { v.accounts[0].stateWord = word; v.accounts[0].state = CODEX_STATE_OF_WORD[word]; })),
      null, word);
  }
  for (const reason of CODEX_ACCOUNT_REASONS) {
    assert.equal(codexStatusProblem(mutated(v => { v.accounts[1].reason = reason; })), null, reason);
  }
  for (const reason of CODEX_NEXT_REASONS) {
    assert.equal(codexStatusProblem(mutated(v => { v.next = { label: null, reason }; })), null, reason);
  }
  for (const state of CODEX_POOL_STATES) assert.equal(codexStatusProblem(mutated(v => { v.pool.state = state; })), null, state);
  for (const type of CODEX_EVENT_TYPES) assert.equal(codexStatusProblem(mutated(v => { v.events[0].type = type; })), null, type);
  assert.equal(codexStatusProblem(mutated(v => { v.accounts[1].latch.cleanReadsDone = 0; v.accounts[1].latch.cappedWindows = []; })), null);
  assert.equal(codexStatusProblem(mutated(v => { v.next = { label: null, reason: null }; })), null);
});

test('schema: an empty pool passes with accountsTotal 0', () => {
  const value = mutated(v => {
    v.accounts = [];
    v.pool.state = 'no-account';
    v.next = { label: null, reason: 'none' };
    Object.assign(v.aggregate, { effectiveRemainingPercent: 0, lowerBoundPercent: 0, fiveHourRemainingPercent: 0,
      weeklyRemainingPercent: 0, accountsTotal: 0, accountsAvailable: 0, accountsSelectable: 0, accountsUnknown: 0 });
  });
  assert.equal(codexStatusProblem(value), null);
});

test('schema: labels must match the account label pattern wherever they appear', () => {
  const bad = [DUMMY_EMAIL, 'ZZ-upper', '-zz', 'z'.repeat(33), '', 7];
  for (const label of bad) {
    assert.equal(codexStatusProblem(mutated(v => { v.accounts[0].label = label; })),
      'status.accounts[0].label must match the account label pattern', String(label));
    assert.equal(codexStatusProblem(mutated(v => { v.next.label = label; })), 'status.next.label must match the account label pattern');
    assert.equal(codexStatusProblem(mutated(v => { v.events[0].label = label; })),
      'status.events[0].label must match the account label pattern');
  }
  for (const label of ['a', '0', 'zz_a-1', 'z'.repeat(32)]) assert.equal(isCodexLabel(label), true, label);
});

test('schema: the events list is bounded', () => {
  const events = n => Array.from({ length: n }, () => ({ at: T0, type: 'selected', label: 'zz-a' }));
  assert.equal(CODEX_EVENTS_LIMIT, 50);
  assert.equal(codexStatusProblem(mutated(v => { v.events = events(50); })), null);
  assert.equal(codexStatusProblem(mutated(v => { v.events = events(51); })), 'status.events has more entries than the limit');
});

test('schema: the problem names the place but never the value or the name of an unknown key', () => {
  const extraKey = codexStatusProblem(mutated(v => { v.accounts[0][DUMMY_EMAIL] = 'zz-fake-value'; }));
  const badLabel = codexStatusProblem(mutated(v => { v.accounts[0].label = DUMMY_EMAIL; }));
  const badReason = codexStatusProblem(mutated(v => { v.accounts[0].reason = DUMMY_EMAIL; }));
  for (const problem of [extraKey, badLabel, badReason]) {
    assert.equal(typeof problem, 'string');
    assert.equal(problem.includes('@'), false, problem);
    assert.equal(problem.includes('zz-fake-value'), false, problem);
  }
});

test('schema: the state words map onto the four states as the table says', () => {
  assert.deepEqual(CODEX_ACCOUNT_STATES, ['available', 'exhausted', 'login_required', 'unknown']);
  assert.equal(CODEX_STATE_WORDS.length, 12);
  const byState = state => CODEX_STATE_WORDS.filter(word => CODEX_STATE_OF_WORD[word] === state).sort();
  assert.deepEqual(byState('available'), ['ready']);
  assert.deepEqual(byState('exhausted'), ['blocked', 'capped', 'exhausted', 'held', 'stopped']);
  assert.deepEqual(byState('login_required'), ['needs login', 'no creds']);
  assert.deepEqual(byState('unknown'), ['no models', 'reserved', 'starting', 'unread']);
  assert.equal(CODEX_POOL_STATES.length, 8);
  assert.deepEqual(CODEX_USER_AGENT_SOURCES, ['codex-version', 'config']);
  assert.equal(CODEX_ACCOUNT_REASONS.includes('disabled'), false, 'disabled is a word of next.reason only');
  assert.equal(CODEX_NEXT_REASONS.includes('disabled'), true);
});

test('schema: the time budget constants for the status child process', () => {
  assert.equal(CODEX_SECTION_DEADLINE_MS, 6000);
  assert.equal(CODEX_DIRECT_READ_CONCURRENCY, 4);
  assert.equal(CODEX_CHILD_TIMEOUT_MS, 8000);
  assert.equal(CODEX_CHILD_TIMEOUT_MS - CODEX_SECTION_DEADLINE_MS, 2000, 'the parent waits the child deadline plus the start-up margin');
});

test('schema: codexIsoTime drops milliseconds and refuses times it cannot represent', () => {
  const at = Date.parse(T0);
  assert.equal(codexIsoTime(at), T0);
  assert.equal(codexIsoTime(at + 999), T0);
  assert.equal(codexIsoTime(0), '1970-01-01T00:00:00Z');
  assert.equal(codexIsoTime(253402300799999), '9999-12-31T23:59:59Z');
  for (const value of [Number.NaN, Infinity, -1, 253402300800000, '1800000000000', null, undefined]) {
    assert.equal(codexIsoTime(value), null, String(value));
  }
  assert.equal(isCodexIsoTime(T0), true);
  assert.equal(isCodexIsoTime('2027-13-01T00:00:00Z'), false);
});
