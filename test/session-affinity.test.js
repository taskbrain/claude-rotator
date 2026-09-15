import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  SessionAffinity,
  normalizeSessionKey,
  sessionKeyFrom,
  sidHash,
} from '../src/session-affinity.js';

// sticky affinity の鍵・表・世代番号（設計書 v1.5 §2 / §3 / §4.4 / §8 / §9）。
// このファイルは src/session-affinity.js だけを見る単体テストであり、HTTP も fs も触らない。
// 時刻はすべて注入したクロックから読むので、TTL・LRU・savedAt を決定的に検証できる。

const SESSION_ID = 'bae7a638-9f3a-4b7c-8d21-0f4e6c2a11b9';
const START_MS = 1_757_000_000_000;

function collectingLogger() {
  const logger = line => logger.lines.push(line);
  logger.lines = [];
  return logger;
}

function linesOf(logger, kind) {
  return logger.lines.filter(line => line.includes(` ${kind} `));
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function createAffinity(overrides = {}) {
  const clock = { ms: overrides.startMs ?? START_MS };
  const logger = overrides.logger ?? collectingLogger();
  const affinity = new SessionAffinity({
    idleTtlMs: overrides.idleTtlMs ?? 21_600_000,
    maxSessions: overrides.maxSessions ?? 10_000,
    now: () => clock.ms,
    logger,
  });
  return { affinity, clock, logger };
}

// 予約（§4.4 ①）。R-S7 が forwardWithRotation の同期区間で呼ぶ形をそのまま使う。
function reserve(affinity, key, account, options = {}) {
  return affinity.note(key, { account, ...options });
}

function ledger(ids) {
  return { accounts: ids.map(id => ({ id })) };
}

// ---------------------------------------------------------------------------
// normalizeSessionKey（設計書 §2.2）
// ---------------------------------------------------------------------------

describe('normalizeSessionKey', () => {
  it('rejects a non-string, an empty string and whitespace only', () => {
    for (const raw of [undefined, null, 42, {}, [], Buffer.from(SESSION_ID), '', '   ']) {
      assert.equal(normalizeSessionKey(raw), null);
    }
  });

  it('rejects a key longer than 128 characters and keeps one of exactly 128', () => {
    assert.equal(normalizeSessionKey('a'.repeat(129)), null);
    assert.equal(normalizeSessionKey('a'.repeat(128)), 'a'.repeat(128));
  });

  it('rejects newlines, control characters and the comma of a joined duplicate header', () => {
    const rejected = [
      `${SESSION_ID}\r\nx`,
      `x\n${SESSION_ID}`,
      `${SESSION_ID}\u0000`,
      `${SESSION_ID}, ${SESSION_ID}`,
      'a b',
      'sid=<script>',
    ];
    for (const raw of rejected) assert.equal(normalizeSessionKey(raw), null);
  });

  it('trims the surrounding whitespace and keeps the allowed character set', () => {
    assert.equal(normalizeSessionKey(`  ${SESSION_ID}  `), SESSION_ID);
    // §2.2 は trim を先に行うので、末尾の改行は「値に混ざった改行」ではなく余白として落ちる。
    // 返る値そのものは必ず文字集合の検査を通っており、制御文字を含まない。
    assert.equal(normalizeSessionKey(`${SESSION_ID}\n`), SESSION_ID);
    assert.equal(normalizeSessionKey('A-z.0_9:x'), 'A-z.0_9:x');
  });
});

// ---------------------------------------------------------------------------
// sidHash（設計書 §2.3・R7・D-54-1）
// ---------------------------------------------------------------------------

describe('sidHash', () => {
  it('returns the first 12 hex digits of the SHA-256 of the normalized key', () => {
    const expected = createHash('sha256').update(SESSION_ID).digest('hex').slice(0, 12);
    assert.equal(sidHash(SESSION_ID), expected);
    assert.match(sidHash(SESSION_ID), /^[0-9a-f]{12}$/);
    // 正規化してから数えるので、前後の空白が付いていても同じセッションは同じ値になる。
    assert.equal(sidHash(`  ${SESSION_ID}  `), expected);
  });

  it('never returns the raw key and is null for an unusable key', () => {
    assert.ok(!sidHash(SESSION_ID).includes(SESSION_ID));
    assert.equal(sidHash(''), null);
    assert.equal(sidHash(42), null);
  });
});

// ---------------------------------------------------------------------------
// sessionKeyFrom（設計書 §2.1・D-54-1）
// ---------------------------------------------------------------------------

describe('sessionKeyFrom', () => {
  it('prefers the x-claude-code-session-id header', () => {
    const req = { headers: { 'x-claude-code-session-id': SESSION_ID } };
    const body = Buffer.from(JSON.stringify({
      metadata: { user_id: JSON.stringify({ session_id: 'other-session' }) },
    }));
    assert.equal(sessionKeyFrom(req, body), SESSION_ID);
  });

  it('ignores a duplicated session-id header and falls back to the body', () => {
    const bodySession = '11111111-2222-3333-4444-555555555555';
    const body = Buffer.from(JSON.stringify({
      metadata: { user_id: JSON.stringify({ session_id: bodySession }) },
    }));

    // Node の http は同名ヘッダをカンマで結合する。生ヘッダ配列でも配列でも鍵にしない。
    const joined = {
      headers: { 'x-claude-code-session-id': `${SESSION_ID}, ${SESSION_ID}` },
      rawHeaders: ['x-claude-code-session-id', SESSION_ID, 'X-Claude-Code-Session-Id', SESSION_ID],
    };
    assert.equal(sessionKeyFrom(joined, body), bodySession);

    const asArray = { headers: { 'x-claude-code-session-id': [SESSION_ID, SESSION_ID] } };
    assert.equal(sessionKeyFrom(asArray, body), bodySession);
  });

  it('reads session_id out of the JSON string in metadata.user_id', () => {
    const req = { headers: {} };
    const body = Buffer.from(JSON.stringify({
      model: 'claude-fable-5-1',
      metadata: {
        user_id: JSON.stringify({ device_id: 'e6db1319', account_uuid: '', session_id: SESSION_ID }),
      },
    }));
    assert.equal(sessionKeyFrom(req, body), SESSION_ID);
    // すでに解析済みの本文を渡す経路（R-S7 は routingModelFamily の解析結果を共有する）。
    assert.equal(sessionKeyFrom(req, JSON.parse(body.toString('utf8'))), SESSION_ID);
  });

  it('never mixes x-claude-code-agent-id into the key', () => {
    const agentId = '99999999-8888-7777-6666-555555555555';
    const withBoth = sessionKeyFrom(
      { headers: { 'x-claude-code-session-id': SESSION_ID, 'x-claude-code-agent-id': agentId } },
      Buffer.from('{}'),
    );
    assert.equal(withBoth, SESSION_ID);

    // ヘッダが無いときも agent-id は鍵にならない（サブエージェントは親と同じ口座へ載せる）。
    const fromBody = sessionKeyFrom(
      { headers: { 'x-claude-code-agent-id': agentId } },
      Buffer.from(JSON.stringify({ metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) } })),
    );
    assert.equal(fromBody, SESSION_ID);

    const onlyAgent = sessionKeyFrom({ headers: { 'x-claude-code-agent-id': agentId } }, Buffer.from('{}'));
    assert.equal(onlyAgent, null);
  });

  it('returns null when neither the header nor the body carries a usable session id', () => {
    assert.equal(sessionKeyFrom({ headers: {} }, Buffer.from('not json')), null);
    assert.equal(sessionKeyFrom({ headers: {} }, Buffer.from(JSON.stringify({ metadata: { user_id: 'not json' } }))), null);
    assert.equal(sessionKeyFrom({ headers: {} }, Buffer.from(JSON.stringify({ metadata: { user_id: '{"session_id":""}' } }))), null);
    assert.equal(sessionKeyFrom(null, null), null);
  });
});

// ---------------------------------------------------------------------------
// バインドの予約と確定（設計書 §3・§4.4）
// ---------------------------------------------------------------------------

describe('SessionAffinity binding', () => {
  it('binds a new session to the account it was noted with and logs one affinity_bind line', () => {
    const { affinity, logger } = createAffinity();

    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    assert.equal(reserved.disposition, 'new');
    assert.equal(reserved.account, 'acct-a');
    assert.equal(reserved.gen, 1);
    assert.equal(reserved.sid, sidHash(SESSION_ID));
    assert.equal(affinity.size, 1);

    const entry = affinity.get(SESSION_ID);
    assert.equal(entry.home, 'acct-a');
    assert.equal(entry.bound, 'acct-a');
    assert.equal(entry.requests, 1);
    assert.equal(entry.switches, 0);
    assert.deepEqual(entry.families, {});

    assert.deepEqual(linesOf(logger, 'affinity_bind'), [
      `2025-09-04T15:33:20.000Z affinity_bind sid=${sidHash(SESSION_ID)} account=acct-a reason=new_session sessions=1`,
    ]);
    // 生のセッション id はどの行にも出さない（R7・D-54-1）。
    for (const line of logger.lines) assert.ok(!line.includes(SESSION_ID));
  });

  it('returns the same binding on a revisit without bumping the generation', () => {
    const { affinity, clock, logger } = createAffinity();
    const first = reserve(affinity, SESSION_ID, 'acct-a');

    clock.ms += 60_000;
    const second = reserve(affinity, SESSION_ID, 'acct-a');

    assert.equal(second.disposition, 'bound');
    assert.equal(second.gen, first.gen);
    assert.equal(affinity.get(SESSION_ID).requests, 2);
    assert.equal(affinity.get(SESSION_ID).lastSeen, clock.ms);
    assert.equal(linesOf(logger, 'affinity_bind').length, 1);
    assert.equal(linesOf(logger, 'affinity_switch').length, 0);
  });

  it('ignores a request it cannot key and one without an account', () => {
    const { affinity } = createAffinity();
    assert.equal(affinity.note('', { account: 'acct-a' }), null);
    assert.equal(affinity.note(SESSION_ID, { account: '' }), null);
    assert.equal(affinity.get(''), null);
    assert.equal(affinity.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 世代照合（設計書 §4.4・D-60-1・D-63 C3）
// ---------------------------------------------------------------------------

describe('SessionAffinity generations', () => {
  it('confirms the reservation when the request went to the reserved account', () => {
    const { affinity, logger } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    const confirmed = affinity.note(SESSION_ID, { account: 'acct-a', expectedGen: reserved.gen });

    assert.equal(confirmed.disposition, 'bound');
    assert.equal(confirmed.gen, reserved.gen);
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.equal(linesOf(logger, 'affinity_stale').length, 0);
    assert.equal(linesOf(logger, 'affinity_switch').length, 0);
  });

  it('drops a late confirmation whose generation is behind the table', () => {
    const { affinity, logger } = createAffinity();
    // R1 が A を予約する（gen=1）。
    const r1 = reserve(affinity, SESSION_ID, 'acct-a');
    // 待っているあいだに R2 が B へ付け替える（gen=2）。
    reserve(affinity, SESSION_ID, 'acct-b', { reason: 'common_exhausted' });

    // R1 が目を覚まし、C で確定に到達する。
    const late = affinity.note(SESSION_ID, { account: 'acct-c', expectedGen: r1.gen, reason: 'common_exhausted' });

    assert.equal(late.disposition, 'stale');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-b');
    assert.equal(affinity.get(SESSION_ID).gen, 2);
    assert.deepEqual(linesOf(logger, 'affinity_stale'), [
      `2025-09-04T15:33:20.000Z affinity_stale sid=${sidHash(SESSION_ID)} myGen=1 curGen=2 dropped=acct-c`,
    ]);
  });

  it('drops a confirmation for a session that is no longer in the table', () => {
    const { affinity, logger } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');
    affinity.evictAccounts(['acct-a'], { reason: 'credential_changed' });

    const late = affinity.note(SESSION_ID, { account: 'acct-a', expectedGen: reserved.gen });

    assert.equal(late.disposition, 'stale');
    assert.equal(affinity.size, 0);
    assert.deepEqual(linesOf(logger, 'affinity_stale'), [
      `2025-09-04T15:33:20.000Z affinity_stale sid=${sidHash(SESSION_ID)} myGen=1 curGen=none dropped=acct-a`,
    ]);
  });

  it('keeps the binding when the request completed on another account for a transient reason', () => {
    const { affinity, clock, logger } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    clock.ms += 1_000;
    // 認証失敗・throttled・5xx・短期レート制限は reason を持たずにここへ来る（D-63 C3）。
    const confirmed = affinity.note(SESSION_ID, { account: 'acct-b', expectedGen: reserved.gen });

    assert.equal(confirmed.disposition, 'bound');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.equal(affinity.get(SESSION_ID).switches, 0);
    assert.equal(affinity.get(SESSION_ID).lastSeen, clock.ms);
    assert.equal(linesOf(logger, 'affinity_switch').length, 0);
  });

  it('rebinds on a quota exhaustion and counts one switch', () => {
    const { affinity, logger } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    const confirmed = affinity.note(SESSION_ID, {
      account: 'acct-d',
      expectedGen: reserved.gen,
      reason: 'common_exhausted',
    });

    assert.equal(confirmed.disposition, 'switch');
    assert.equal(confirmed.slot, 'home');
    assert.equal(confirmed.gen, reserved.gen + 1);
    assert.equal(affinity.get(SESSION_ID).home, 'acct-d');
    assert.equal(affinity.get(SESSION_ID).switches, 1);
    assert.deepEqual(linesOf(logger, 'affinity_switch'), [
      `2025-09-04T15:33:20.000Z affinity_switch sid=${sidHash(SESSION_ID)} from=acct-a to=acct-d`
      + ' reason=common_exhausted family=other switches=1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 系統別副バインド（設計書 §4.1・§4.3・D-54-3・D-63 C2）
// ---------------------------------------------------------------------------

describe('SessionAffinity family sub-bindings', () => {
  it('creates one family sub-binding and leaves the home for the other families', () => {
    const { affinity, logger } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');

    const sub = reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });

    assert.equal(sub.disposition, 'switch');
    assert.equal(sub.slot, 'family');
    assert.equal(affinity.get(SESSION_ID, { modelFamily: 'fable' }).bound, 'acct-d');
    assert.equal(affinity.get(SESSION_ID).bound, 'acct-a');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.deepEqual(affinity.get(SESSION_ID).families, { fable: 'acct-d' });
    assert.deepEqual(linesOf(logger, 'affinity_switch'), [
      `2025-09-04T15:33:20.000Z affinity_switch sid=${sidHash(SESSION_ID)} from=acct-a to=acct-d`
      + ' reason=family_exhausted family=fable switches=1',
    ]);
  });

  it('replaces only the family sub-binding when that sub-binding is the one that failed', () => {
    const { affinity } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');
    reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });

    // 副バインド先 D の共通枠が枯れた。付け替えるのは Fable の副バインドだけ（D-63 C2）。
    const moved = reserve(affinity, SESSION_ID, 'acct-e', { modelFamily: 'fable', reason: 'common_exhausted' });

    assert.equal(moved.slot, 'family');
    assert.deepEqual(affinity.get(SESSION_ID).families, { fable: 'acct-e' });
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.equal(affinity.get(SESSION_ID, { modelFamily: 'fable' }).bound, 'acct-e');
  });

  it('drops the family sub-bindings when the home itself is rebound', () => {
    const { affinity } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');
    reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });

    const moved = reserve(affinity, SESSION_ID, 'acct-b', { reason: 'common_exhausted' });

    assert.equal(moved.slot, 'home');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-b');
    assert.deepEqual(affinity.get(SESSION_ID).families, {});
    assert.equal(affinity.get(SESSION_ID, { modelFamily: 'fable' }).bound, 'acct-b');
  });
});

// ---------------------------------------------------------------------------
// TTL・LRU・容量（設計書 §3・§8・F4・F6）
// ---------------------------------------------------------------------------

describe('SessionAffinity ttl and capacity', () => {
  it('hides and evicts an entry that has been idle for longer than idleTtlMs', () => {
    const { affinity, clock, logger } = createAffinity({ idleTtlMs: 21_600_000 });
    reserve(affinity, SESSION_ID, 'acct-a');

    clock.ms += 21_600_001;

    assert.equal(affinity.get(SESSION_ID), null);
    assert.equal(affinity.size, 0);
    assert.deepEqual(linesOf(logger, 'affinity_evict'), [
      `${isoAt(clock.ms)} affinity_evict sid=${sidHash(SESSION_ID)} account=acct-a reason=ttl ageMs=21600001`,
    ]);
  });

  it('evicts the idle entries on prune and leaves the fresh ones alone', () => {
    const { affinity, clock, logger } = createAffinity({ idleTtlMs: 60_000 });
    reserve(affinity, 'session-old', 'acct-a');
    clock.ms += 30_000;
    reserve(affinity, 'session-new', 'acct-b');
    clock.ms += 31_000;

    const evicted = affinity.prune();

    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].reason, 'ttl');
    assert.equal(evicted[0].sid, sidHash('session-old'));
    assert.equal(affinity.size, 1);
    assert.equal(affinity.get('session-new').home, 'acct-b');
    assert.equal(linesOf(logger, 'affinity_evict').length, 1);
  });

  it('does not evict anything when the clock goes backwards', () => {
    const { affinity, clock, logger } = createAffinity({ idleTtlMs: 60_000 });
    reserve(affinity, SESSION_ID, 'acct-a');

    clock.ms -= 86_400_000;

    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.deepEqual(affinity.prune(), []);
    assert.equal(affinity.size, 1);
    // 巻き戻った時刻へ丸める（負の経過時間で全消ししない・F4）。
    assert.equal(affinity.get(SESSION_ID).lastSeen, clock.ms);
    assert.equal(linesOf(logger, 'affinity_evict').length, 0);
  });

  it('evicts the least recently seen session when maxSessions is reached', () => {
    const { affinity, clock, logger } = createAffinity({ maxSessions: 2 });
    reserve(affinity, 'session-1', 'acct-a');
    clock.ms += 1_000;
    reserve(affinity, 'session-2', 'acct-b');
    clock.ms += 1_000;
    // session-1 を触り直すので、最も古いのは session-2 になる。
    reserve(affinity, 'session-1', 'acct-a');
    clock.ms += 1_000;

    reserve(affinity, 'session-3', 'acct-c');

    assert.equal(affinity.size, 2);
    assert.equal(affinity.get('session-2'), null);
    assert.equal(affinity.get('session-1').home, 'acct-a');
    assert.equal(affinity.get('session-3').home, 'acct-c');
    assert.deepEqual(linesOf(logger, 'affinity_evict'), [
      `${isoAt(clock.ms)} affinity_evict sid=${sidHash('session-2')} account=acct-b reason=capacity ageMs=2000`,
    ]);
  });

  it('trims the table immediately when maxSessions is lowered', () => {
    const { affinity, clock, logger } = createAffinity({ maxSessions: 10 });
    for (const index of [1, 2, 3, 4]) {
      reserve(affinity, `session-${index}`, `acct-${index}`);
      clock.ms += 1_000;
    }

    affinity.configure({ maxSessions: 2 });

    assert.equal(affinity.size, 2);
    assert.equal(affinity.get('session-1'), null);
    assert.equal(affinity.get('session-2'), null);
    assert.equal(affinity.get('session-3').home, 'acct-3');
    assert.equal(affinity.get('session-4').home, 'acct-4');
    assert.deepEqual(linesOf(logger, 'affinity_evict').map(line => line.split(' reason=')[1]), [
      'capacity ageMs=4000',
      'capacity ageMs=3000',
    ]);
  });

  it('drops the bindings of accounts the ledger no longer has when prune is given the known ids', () => {
    const { affinity } = createAffinity();
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-1', 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });
    reserve(affinity, 'session-2', 'acct-b');

    const evicted = affinity.prune({ knownAccountIds: ['acct-a', 'acct-b'] });

    assert.deepEqual(evicted.map(record => record.reason), ['account_removed']);
    // home は残り、消えた口座を指していた副バインドだけが落ちる。
    assert.equal(affinity.get('session-1').home, 'acct-a');
    assert.deepEqual(affinity.get('session-1').families, {});
    assert.equal(affinity.get('session-2').home, 'acct-b');
  });
});

// ---------------------------------------------------------------------------
// evictAccounts（設計書 §8.1・D-60-3）
// ---------------------------------------------------------------------------

describe('SessionAffinity evictAccounts', () => {
  it('drops the whole session when its home account is evicted', () => {
    const { affinity, clock, logger } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');
    reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });
    reserve(affinity, 'other-session', 'acct-b');
    clock.ms += 5_000;

    const evicted = affinity.evictAccounts(['acct-a'], { reason: 'credential_changed' });

    assert.equal(evicted.length, 1);
    assert.equal(affinity.get(SESSION_ID), null);
    assert.equal(affinity.get('other-session').home, 'acct-b');
    assert.deepEqual(linesOf(logger, 'affinity_evict'), [
      `${isoAt(clock.ms)} affinity_evict sid=${sidHash(SESSION_ID)} account=acct-a reason=credential_changed ageMs=5000`,
    ]);
  });

  it('drops only the sub-binding when the evicted account is a family sub-binding', () => {
    const { affinity } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');
    reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });

    const evicted = affinity.evictAccounts(['acct-d'], { reason: 'credential_changed' });

    assert.equal(evicted.length, 1);
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.deepEqual(affinity.get(SESSION_ID).families, {});
    assert.equal(affinity.get(SESSION_ID, { modelFamily: 'fable' }).bound, 'acct-a');
  });

  it('does nothing for an empty or missing id list', () => {
    const { affinity, logger } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');

    assert.deepEqual(affinity.evictAccounts([]), []);
    assert.deepEqual(affinity.evictAccounts(undefined), []);
    assert.equal(affinity.size, 1);
    assert.equal(linesOf(logger, 'affinity_evict').length, 0);
  });
});

// ---------------------------------------------------------------------------
// summary（設計書 §7.3）
// ---------------------------------------------------------------------------

describe('SessionAffinity summary', () => {
  it('counts sessions per account so the per-account total can exceed the session count', () => {
    const { affinity } = createAffinity({ maxSessions: 500 });
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-1', 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });
    reserve(affinity, 'session-2', 'acct-a');

    const summary = affinity.summary();

    assert.equal(summary.sessions, 2);
    assert.equal(summary.capacity, 500);
    assert.equal(summary.idleTtlMs, 21_600_000);
    assert.deepEqual(summary.sessionsByAccount, { 'acct-a': 2, 'acct-d': 1 });
    // 口座別の合計はセッション総数と一致しない（系統別副バインドで分散するため）。
    const total = Object.values(summary.sessionsByAccount).reduce((sum, count) => sum + count, 0);
    assert.equal(total, 3);
    assert.notEqual(total, summary.sessions);
    assert.deepEqual(summary.switchesByReason, { family_exhausted: 1 });
    assert.deepEqual(summary.evictionsByReason, {});
  });

  it('counts the evictions by reason', () => {
    const { affinity, clock } = createAffinity({ idleTtlMs: 60_000 });
    reserve(affinity, 'session-1', 'acct-a');
    clock.ms += 60_001;
    affinity.prune();

    assert.deepEqual(affinity.summary().evictionsByReason, { ttl: 1 });
    assert.equal(affinity.summary().sessions, 0);
  });
});

// ---------------------------------------------------------------------------
// export / restore（設計書 §8・§8.1・F1）
// ---------------------------------------------------------------------------

describe('SessionAffinity export and restore', () => {
  it('exports hashes, accounts, sub-bindings, last seen and switches only', () => {
    const { affinity, clock } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');
    reserve(affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });
    clock.ms += 2_000;
    reserve(affinity, 'plain-session', 'acct-b');

    const saved = affinity.export();

    assert.equal(saved.version, 1);
    assert.equal(saved.savedAt, isoAt(clock.ms));
    assert.deepEqual(saved.entries, [
      { k: sidHash(SESSION_ID), a: 'acct-a', f: { fable: 'acct-d' }, t: START_MS, s: 1 },
      { k: sidHash('plain-session'), a: 'acct-b', t: START_MS + 2_000, s: 0 },
    ]);
    // 生のセッション id も世代番号も保存しない（§8・D-60-1）。
    const serialized = JSON.stringify(saved);
    assert.ok(!serialized.includes(SESSION_ID));
    assert.ok(!serialized.includes('gen'));
    assert.ok(!serialized.includes('@'));
  });

  it('restores the table so the same session key finds the same account', () => {
    const source = createAffinity();
    reserve(source.affinity, SESSION_ID, 'acct-a');
    reserve(source.affinity, SESSION_ID, 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });
    const saved = source.affinity.export();

    const { affinity } = createAffinity();
    const result = affinity.restore(saved, { accountManager: ledger(['acct-a', 'acct-d']) });

    assert.equal(result.restored, 1);
    assert.equal(result.skipped, null);
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.equal(affinity.get(SESSION_ID, { modelFamily: 'fable' }).bound, 'acct-d');
    assert.equal(affinity.get(SESSION_ID).switches, 1);
    // 世代は保存していないので 0 から数え直す（D-60-1）。
    assert.equal(affinity.get(SESSION_ID).gen, 0);
  });

  it('discards a saved table whose version does not match', () => {
    const { affinity, clock, logger } = createAffinity();
    const result = affinity.restore(
      { version: 2, savedAt: isoAt(clock.ms), entries: [{ k: sidHash(SESSION_ID), a: 'acct-a', t: START_MS, s: 0 }] },
      { accountManager: ledger(['acct-a']) },
    );

    assert.equal(result.skipped, 'version');
    assert.equal(result.restored, 0);
    assert.equal(affinity.size, 0);
    assert.deepEqual(linesOf(logger, 'affinity_restore'), [
      `${isoAt(clock.ms)} affinity_restore skipped=version`,
    ]);
  });

  it('discards a saved table whose savedAt is in the future and one that is malformed', () => {
    const { affinity, clock, logger } = createAffinity();

    const future = affinity.restore(
      { version: 1, savedAt: isoAt(clock.ms + 60_000), entries: [{ k: sidHash(SESSION_ID), a: 'acct-a', t: START_MS, s: 0 }] },
      { accountManager: ledger(['acct-a']) },
    );
    assert.equal(future.skipped, 'saved-at');
    assert.equal(affinity.size, 0);

    for (const broken of [null, undefined, 'nope', { version: 1, savedAt: isoAt(clock.ms) }]) {
      const result = affinity.restore(broken, { accountManager: ledger(['acct-a']) });
      assert.equal(result.skipped, 'malformed');
      assert.equal(result.restored, 0);
    }
    assert.equal(affinity.size, 0);
    // 壊れた保存データの本文はログへ出さない（F1）。
    assert.equal(linesOf(logger, 'affinity_restore').length, 5);
    for (const line of logger.lines) assert.ok(!line.includes('nope'));
  });

  it('drops entries whose account is no longer in the ledger', () => {
    const { affinity, clock } = createAffinity();
    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('kept'), a: 'acct-a', f: { fable: 'acct-gone' }, t: START_MS, s: 0 },
        { k: sidHash('dropped'), a: 'acct-gone', t: START_MS, s: 0 },
      ],
    }, { accountManager: ledger(['acct-a']) });

    assert.equal(result.restored, 1);
    assert.equal(result.dropped.unknown_account, 1);
    assert.equal(affinity.get('dropped'), null);
    assert.equal(affinity.get('kept').home, 'acct-a');
    // 台帳から消えた口座を指す副バインドだけも落とす。
    assert.deepEqual(affinity.get('kept').families, {});
  });

  it('drops entries that have been idle for longer than idleTtlMs', () => {
    const { affinity, clock } = createAffinity({ idleTtlMs: 60_000 });
    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('fresh'), a: 'acct-a', t: START_MS - 10_000, s: 0 },
        { k: sidHash('stale'), a: 'acct-a', t: START_MS - 70_000, s: 0 },
      ],
    }, { accountManager: ledger(['acct-a']) });

    assert.equal(result.restored, 1);
    assert.equal(result.dropped.ttl, 1);
    assert.equal(affinity.get('fresh').home, 'acct-a');
    assert.equal(affinity.get('stale'), null);
  });

  it('keeps the most recently seen entries when the saved table is larger than maxSessions', () => {
    const { affinity, clock } = createAffinity({ maxSessions: 2 });
    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('oldest'), a: 'acct-a', t: START_MS - 3_000, s: 0 },
        { k: sidHash('newest'), a: 'acct-a', t: START_MS - 1_000, s: 0 },
        { k: sidHash('middle'), a: 'acct-a', t: START_MS - 2_000, s: 0 },
      ],
    }, { accountManager: ledger(['acct-a']) });

    assert.equal(result.restored, 2);
    assert.equal(result.dropped.capacity, 1);
    assert.equal(affinity.size, 2);
    assert.equal(affinity.get('oldest'), null);
    assert.equal(affinity.get('newest').home, 'acct-a');
    assert.equal(affinity.get('middle').home, 'acct-a');
  });

  it('drops entries bound to an account whose credentials changed', () => {
    const { affinity, clock, logger } = createAffinity();
    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('rebound'), a: 'acct-a', t: START_MS, s: 0 },
        { k: sidHash('kept'), a: 'acct-b', f: { fable: 'acct-a' }, t: START_MS, s: 0 },
      ],
    }, {
      accountManager: ledger(['acct-a', 'acct-b']),
      credentialChangedAccountIds: ['acct-a'],
    });

    assert.equal(result.restored, 1);
    assert.equal(result.dropped.credential_changed, 1);
    assert.equal(affinity.get('rebound'), null);
    assert.equal(affinity.get('kept').home, 'acct-b');
    assert.deepEqual(affinity.get('kept').families, {});
    assert.equal(linesOf(logger, 'affinity_restore').length, 0);
  });

  it('treats a missing credentialChangedAccountIds as none changed', () => {
    const { affinity, clock } = createAffinity();
    const saved = {
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [{ k: sidHash('kept'), a: 'acct-a', t: START_MS, s: 0 }],
    };

    // restoreState の早期 return が undefined を返した場合でも壊れない（v1.5 §8.1）。
    const result = affinity.restore(saved, {
      accountManager: ledger(['acct-a']),
      credentialChangedAccountIds: undefined,
    });

    assert.equal(result.restored, 1);
    assert.equal(affinity.get('kept').home, 'acct-a');
  });
});
