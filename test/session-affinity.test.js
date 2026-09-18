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
// このファイルは src/session-affinity.js の単体テストであり（未記載構成の確認に限り src/config.js の
// createDefaultConfig も読む）、HTTP も fs も触らない。
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
    warmTtlMs: overrides.warmTtlMs ?? 3_600_000,
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

  it('never rebinds on account_removed at the confirmation stage (D-142)', () => {
    // 確定段で付け替えてよい理由は枠の枯渇（共通枠・当該系統枠）の2値だけである。
    // 台帳から口座が消えたことは予約段（affinity_switch）と退避段（affinity_evict）の
    // 事象であり、送信直前の確定でバインドを動かす理由にはならない（D-142）。
    const { affinity, logger } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    const confirmed = affinity.note(SESSION_ID, {
      account: 'acct-b',
      expectedGen: reserved.gen,
      reason: 'account_removed',
    });

    assert.equal(confirmed.disposition, 'bound');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.equal(affinity.get(SESSION_ID).gen, reserved.gen);
    assert.equal(affinity.get(SESSION_ID).switches, 0);
    assert.deepEqual(linesOf(logger, 'affinity_switch'), []);

    // 予約段では同じ理由でそのまま付け替わる（予約段は2値に絞らない）。
    const reserved2 = reserve(affinity, SESSION_ID, 'acct-b', { reason: 'account_removed' });
    assert.equal(reserved2.disposition, 'switch');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-b');
    assert.equal(linesOf(logger, 'affinity_switch').length, 1);
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

// ---------------------------------------------------------------------------
// 設定の正規化と reload（設計書 §6 / R-S6）
//
// 既存の import 文（ファイル冒頭）は1行も書き換えない。ESM の import 宣言は位置に
// 関係なく巻き上げられるため、R-S6 で足りない分だけを別の import 文にする。
// ---------------------------------------------------------------------------

import { createDefaultConfig } from '../src/config.js';
import {
  DEFAULT_SESSION_AFFINITY,
  logSessionAffinityStartupNotice,
  normalizeSessionAffinity,
} from '../src/session-affinity.js';

const FULL_SECTION = {
  mode: 'on',
  idleTtlMs: 3_600_000,
  maxSessions: 500,
  assignStopUtilization: 0.75,
  rebindGraceMs: 30_000,
  warmTtlMs: 1_800_000,
  drainStartUtilization: 0.7,
  persist: false,
};

describe('SessionAffinity holds (F9)', () => {
  it('keeps a held row through a ttl sweep and drops it once the response is released', () => {
    const { affinity, clock, logger } = createAffinity({ idleTtlMs: 60_000 });
    reserve(affinity, SESSION_ID, 'acct-a');
    const release = affinity.hold(SESSION_ID);

    clock.ms += 61_000;

    assert.deepEqual(affinity.prune(), [], '応答中の行は TTL でも落とさない');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');

    release();
    const evicted = affinity.prune();

    assert.deepEqual(evicted.map(record => record.reason), ['ttl']);
    assert.equal(affinity.size, 0);
    assert.equal(linesOf(logger, 'affinity_evict').length, 1);
  });

  it('keeps a held row when the capacity is reached and reclaims it after release', () => {
    const { affinity } = createAffinity({ maxSessions: 1 });
    reserve(affinity, 'session-stream', 'acct-a');
    const release = affinity.hold('session-stream');

    reserve(affinity, 'session-two', 'acct-b');

    assert.equal(affinity.size, 2, '応答中の行も、作ったばかりの行も退避しない');
    release();
    reserve(affinity, 'session-three', 'acct-c');

    assert.equal(affinity.get('session-stream'), null);
    assert.equal(affinity.size, 1);
  });

  it('releases only once and ignores an unknown key', () => {
    const { affinity } = createAffinity({ maxSessions: 1 });
    reserve(affinity, 'session-one', 'acct-a');
    const release = affinity.hold('session-one');
    release();
    release();
    assert.equal(typeof affinity.hold('session-missing'), 'function');
    assert.equal(typeof affinity.hold(''), 'function');

    reserve(affinity, 'session-two', 'acct-b');

    assert.equal(affinity.get('session-one'), null, '二重解放で保持数が負にならない');
    assert.equal(affinity.size, 1);
  });
});

describe('normalizeSessionAffinity (R-S6 / 設計書 §6)', () => {
  it('falls back to the shared defaults when the section is absent or is not an object', () => {
    // セクションが無い／型が違う、のいずれでも既定（mode:"off"）へ倒れる。
    for (const raw of [undefined, null, false, 0, '', 'on', 42, [], [{ mode: 'on' }]]) {
      assert.equal(
        normalizeSessionAffinity(raw),
        DEFAULT_SESSION_AFFINITY,
        `${JSON.stringify(raw) ?? String(raw)} must resolve to the shared default constant`,
      );
    }
    assert.deepEqual(DEFAULT_SESSION_AFFINITY, {
      mode: 'off',
      idleTtlMs: 21_600_000,
      maxSessions: 10_000,
      assignStopUtilization: 0.9,
      rebindGraceMs: 60_000,
      // v1.7（判断6 案(a)）で足した2つ。既定はメイン会話のキャッシュ寿命 1 時間と、
      // 冷えた固定を動かし始める利用率 85%。
      warmTtlMs: 3_600_000,
      drainStartUtilization: 0.85,
      persist: true,
    });
    assert.deepEqual(normalizeSessionAffinity({}), DEFAULT_SESSION_AFFINITY);
  });

  it('normalizes every key when the section is fully specified', () => {
    assert.deepEqual(normalizeSessionAffinity(FULL_SECTION), FULL_SECTION);
  });

  it('keeps the remaining defaults when only one key is written (浅いマージの罠)', () => {
    // createDefaultConfig() 側に既定を置いていたら、この部分指定で他のキーが
    // すべて undefined になる。専用の正規化関数を通すことでそれを避ける（§6 理由①）。
    for (const partial of [{ mode: 'on' }, { maxSessions: 5 }, { persist: false }]) {
      const normalized = normalizeSessionAffinity(partial);
      for (const key of Object.keys(DEFAULT_SESSION_AFFINITY)) {
        assert.notEqual(normalized[key], undefined, `${JSON.stringify(partial)} -> ${key}`);
      }
      assert.deepEqual(
        normalized,
        { ...DEFAULT_SESSION_AFFINITY, ...partial },
        JSON.stringify(partial),
      );
    }
  });

  it('keeps the three known modes and folds every other value into off', () => {
    for (const mode of ['off', 'observe', 'on']) {
      assert.equal(normalizeSessionAffinity({ mode }).mode, mode, mode);
    }
    // 未知の値は "off" へ倒す（§6）。大文字・真偽値・数値も未知として扱う。
    for (const mode of ['ON', 'On', 'enabled', '', 'true', true, 1, null, undefined, {}, []]) {
      assert.equal(
        normalizeSessionAffinity({ mode }).mode,
        'off',
        `mode:${JSON.stringify(mode) ?? String(mode)}`,
      );
    }
  });

  it('clamps the six numeric keys into their documented range', () => {
    const clamps = [
      ['idleTtlMs', [[0, 60_000], [1, 60_000], [60_000, 60_000], [120_000, 120_000],
        [604_800_000, 604_800_000], [604_800_001, 604_800_000]]],
      ['maxSessions', [[0, 1], [-5, 1], [1, 1], [500, 500], [10_000, 10_000], [10_001, 10_000]]],
      ['assignStopUtilization', [[-1, 0], [0, 0], [0.75, 0.75], [1, 1], [1.5, 1]]],
      ['rebindGraceMs', [[-1, 0], [0, 0], [30_000, 30_000], [600_000, 600_000], [600_001, 600_000]]],
      ['warmTtlMs', [[0, 60_000], [1, 60_000], [60_000, 60_000], [1_800_000, 1_800_000],
        [21_600_000, 21_600_000], [21_600_001, 21_600_000]]],
      ['drainStartUtilization', [[-1, 0], [0, 0], [0.7, 0.7], [1, 1], [1.5, 1]]],
    ];
    for (const [key, cases] of clamps) {
      for (const [written, expected] of cases) {
        assert.equal(
          normalizeSessionAffinity({ [key]: written })[key],
          expected,
          `${key}:${written}`,
        );
      }
    }
    // 明示された 0 は既定へ戻さない: rebindGraceMs:0 は待機の無効化（§6・v1.1 の挙動へ）、
    // assignStopUtilization:0 はゲートの最も厳しい側であって「未指定」ではない。
    assert.equal(normalizeSessionAffinity({ rebindGraceMs: 0 }).rebindGraceMs, 0);
    assert.equal(normalizeSessionAffinity({ assignStopUtilization: 0 }).assignStopUtilization, 0);
    // 端数のあるセッション数は切り捨てる（表の上限は整数）。
    assert.equal(normalizeSessionAffinity({ maxSessions: 7.9 }).maxSessions, 7);
  });

  it('falls back to the default for wrong types and non-finite numbers', () => {
    const wrong = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      '60000', null, {}, [], true, false];
    for (const key of ['idleTtlMs', 'maxSessions', 'assignStopUtilization', 'rebindGraceMs',
      'warmTtlMs', 'drainStartUtilization']) {
      for (const value of wrong) {
        assert.equal(
          normalizeSessionAffinity({ [key]: value })[key],
          DEFAULT_SESSION_AFFINITY[key],
          `${key}:${JSON.stringify(value) ?? String(value)}`,
        );
      }
    }
  });

  it('accepts only the boolean false to turn persist off', () => {
    assert.equal(normalizeSessionAffinity({ persist: false }).persist, false);
    for (const value of [true, 'false', 0, 1, null, undefined, {}, []]) {
      assert.equal(
        normalizeSessionAffinity({ persist: value }).persist,
        true,
        `persist:${JSON.stringify(value) ?? String(value)}`,
      );
    }
  });

  it('returns a frozen section so a consumer cannot flip the mode at runtime', () => {
    const normalized = normalizeSessionAffinity({ mode: 'on' });
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(DEFAULT_SESSION_AFFINITY), true);
    assert.throws(() => { 'use strict'; normalized.mode = 'off'; }, TypeError);
    assert.equal(normalized.mode, 'on');
  });
});

describe('OSS 独立性 > sessionAffinity 未記載 (R-S6)', () => {
  it('leaves createDefaultConfig() unchanged and resolves to off', () => {
    // 新規インストールの config.json（createDefaultConfig）にはセクションが無い。
    // 生成物を1バイトも変えないため、既定側にキーを足していないことを固定する（§6 理由②）。
    const config = createDefaultConfig();
    assert.equal(config.sessionAffinity, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'sessionAffinity'), false);
    assert.deepEqual(Object.keys(config), [
      'proxy', 'upstream', 'switchThreshold', 'rotationPolicy', 'usagePolling',
      'openaiBridge', 'accounts',
    ]);
    assert.equal(normalizeSessionAffinity(config.sessionAffinity), DEFAULT_SESSION_AFFINITY);
    assert.equal(normalizeSessionAffinity(config.sessionAffinity).mode, 'off');
  });
});

describe('SessionAffinity applySettings (R-S6 / 設計書 §6 の reload)', () => {
  it('starts from an empty table when the mode goes from off to on', () => {
    const { affinity, logger } = createAffinity();
    reserve(affinity, 'session-a', 'acct-a');
    reserve(affinity, 'session-b', 'acct-b');

    const result = affinity.applySettings({ mode: 'on' }, { previousMode: 'off' });

    assert.equal(affinity.size, 0, 'off→on は空表から開始する');
    assert.equal(result.mode, 'on');
    assert.equal(result.previousMode, 'off');
    assert.equal(result.cleared, 2);
    assert.deepEqual(linesOf(logger, 'affinity_disabled'), [], '有効化では1行も出さない');
  });

  it('discards the table and logs one affinity_disabled line when the mode goes to off', () => {
    const { affinity, clock, logger } = createAffinity();
    reserve(affinity, 'session-a', 'acct-a');
    reserve(affinity, 'session-b', 'acct-b');

    const result = affinity.applySettings({ mode: 'off' }, { previousMode: 'on' });

    assert.equal(affinity.size, 0);
    assert.equal(result.mode, 'off');
    assert.equal(result.cleared, 2);
    assert.deepEqual(linesOf(logger, 'affinity_disabled'), [
      `${isoAt(clock.ms)} affinity_disabled sessions=2`,
    ]);
    // 値そのものは出さない（§6）。設定由来の数値・ハッシュ・口座名を載せない。
    const [line] = linesOf(logger, 'affinity_disabled');
    for (const forbidden of ['21600000', '10000', 'idleTtlMs', 'maxSessions', 'acct-a', sidHash('session-a')]) {
      assert.equal(line.includes(forbidden), false, forbidden);
    }
  });

  it('logs nothing when the mode was already off', () => {
    const { affinity, logger } = createAffinity();

    const result = affinity.applySettings({ mode: 'off' }, { previousMode: 'off' });

    assert.equal(result.cleared, 0);
    assert.deepEqual(logger.lines, []);
  });

  it('re-applies the clamped limits and trims the table immediately', () => {
    const { affinity, logger } = createAffinity({ maxSessions: 10 });
    reserve(affinity, 'session-a', 'acct-a');
    reserve(affinity, 'session-b', 'acct-b');
    reserve(affinity, 'session-c', 'acct-c');

    // 0 は 1 へクランプされるので、最も新しい1件だけが残る（§3 の LRU）。
    const result = affinity.applySettings({ mode: 'on', maxSessions: 0 }, { previousMode: 'on' });

    assert.equal(affinity.maxSessions, 1);
    assert.equal(affinity.size, 1);
    assert.equal(affinity.get('session-c').home, 'acct-c');
    assert.equal(result.evicted.length, 2);
    assert.deepEqual([...new Set(result.evicted.map(entry => entry.reason))], ['capacity']);
    assert.deepEqual(linesOf(logger, 'affinity_disabled'), []);
  });

  it('keeps the bindings when the mode stays enabled', () => {
    const { affinity } = createAffinity();
    reserve(affinity, 'session-a', 'acct-a');

    const result = affinity.applySettings({ mode: 'observe' }, { previousMode: 'on' });

    assert.equal(affinity.size, 1);
    assert.equal(affinity.get('session-a').home, 'acct-a');
    assert.equal(result.mode, 'observe');
    assert.equal(result.cleared, 0);
  });

  it('accepts an already normalized section unchanged', () => {
    const { affinity } = createAffinity();
    const settings = normalizeSessionAffinity({ mode: 'on', idleTtlMs: 60_000 });

    const result = affinity.applySettings(settings, { previousMode: 'on' });

    assert.equal(result.mode, 'on');
    assert.equal(affinity.idleTtlMs, 60_000);
  });
});

describe('logSessionAffinityStartupNotice (R-S6 / U17)', () => {
  it('records the switch threshold on exactly one line while affinity runs', () => {
    for (const mode of ['on', 'observe']) {
      const lines = [];
      const returned = logSessionAffinityStartupNotice(
        normalizeSessionAffinity({ mode }),
        { switchThreshold: 0.8, logger: line => lines.push(line), now: START_MS },
      );
      assert.deepEqual(returned, lines, '返り値は実際に出した行の配列');
      assert.deepEqual(lines, [`${isoAt(START_MS)} affinity_config mode=${mode} switchThreshold=0.8`]);
    }
  });

  it('stays silent when the section is absent or the mode is off', () => {
    for (const raw of [undefined, null, {}, { mode: 'off' }, { mode: 'ON' }]) {
      const lines = [];
      const returned = logSessionAffinityStartupNotice(
        normalizeSessionAffinity(raw),
        { switchThreshold: 1, logger: line => lines.push(line), now: START_MS },
      );
      assert.deepEqual(lines, [], JSON.stringify(raw) ?? String(raw));
      assert.deepEqual(returned, []);
    }
  });

  it('does not print undefined when the threshold is not a finite number', () => {
    const lines = [];
    logSessionAffinityStartupNotice(
      normalizeSessionAffinity({ mode: 'on' }),
      { switchThreshold: undefined, logger: line => lines.push(line), now: START_MS },
    );
    assert.deepEqual(lines, [`${isoAt(START_MS)} affinity_config mode=on switchThreshold=unknown`]);
  });
});

// ---------------------------------------------------------------------------
// reload のモード記憶と表の変化通知（R-S11 / FU-69・D-175・設計書 §6・§8）
//
// FU-69: 直前のモードを結線側が渡す方式だと、渡し忘れた瞬間に「有効→off」の
// `affinity_disabled` が黙って消える。モードはインスタンスが持ち、`applySettings` は
// 明示の `previousMode` が無ければ自分の値を使う。
//
// 表の変化通知（`onChange`）は永続化の dirty 判定の唯一の入口である。バインドが
// 変わったときだけ呼ばれ、`lastSeen` の更新（再訪）では呼ばれない（設計書 §8）。
// ---------------------------------------------------------------------------

describe('SessionAffinity mode memory and change notice (R-S11 / FU-69)', () => {
  function createTracked(overrides = {}) {
    const clock = { ms: overrides.startMs ?? START_MS };
    const logger = overrides.logger ?? collectingLogger();
    const changes = [];
    const affinity = new SessionAffinity({
      mode: overrides.mode ?? 'on',
      idleTtlMs: overrides.idleTtlMs ?? 21_600_000,
      maxSessions: overrides.maxSessions ?? 10_000,
      now: () => clock.ms,
      logger,
      onChange: () => changes.push(affinity.size),
    });
    return { affinity, clock, logger, changes };
  }

  it('remembers the mode it was built with and reports it', () => {
    const { affinity } = createTracked({ mode: 'observe' });

    assert.equal(affinity.mode, 'observe');
    assert.equal(new SessionAffinity().mode, 'off', '既定は off（R-S6 の未記載構成と同じ）');
  });

  it('uses its own mode as previousMode when the caller does not pass one', () => {
    const { affinity, clock, logger } = createTracked({ mode: 'on' });
    reserve(affinity, 'session-a', 'acct-a');
    reserve(affinity, 'session-b', 'acct-b');

    // 結線側が previousMode を渡し忘れても、有効→off の1行は消えない（FU-69）。
    const result = affinity.applySettings({ mode: 'off' });

    assert.equal(result.previousMode, 'on');
    assert.equal(affinity.size, 0);
    assert.deepEqual(linesOf(logger, 'affinity_disabled'), [
      `${isoAt(clock.ms)} affinity_disabled sessions=2`,
    ]);
  });

  it('records the new mode so a second reload to off stays silent', () => {
    const { affinity, logger } = createTracked({ mode: 'on' });
    reserve(affinity, 'session-a', 'acct-a');

    affinity.applySettings({ mode: 'off' });
    affinity.applySettings({ mode: 'off' });

    assert.equal(affinity.mode, 'off');
    assert.equal(linesOf(logger, 'affinity_disabled').length, 1, '2回目の reload では出さない');
  });

  it('starts from an empty table when its own mode was off and the reload enables it', () => {
    const { affinity, logger } = createTracked({ mode: 'off' });
    reserve(affinity, 'session-a', 'acct-a');

    const result = affinity.applySettings({ mode: 'on' });

    assert.equal(result.previousMode, 'off');
    assert.equal(affinity.mode, 'on');
    assert.equal(affinity.size, 0, 'off→on は空表から開始する（§6）');
    assert.deepEqual(linesOf(logger, 'affinity_disabled'), []);
  });

  it('still honours an explicit previousMode over its own', () => {
    const { affinity, logger } = createTracked({ mode: 'off' });
    reserve(affinity, 'session-a', 'acct-a');

    const result = affinity.applySettings({ mode: 'off' }, { previousMode: 'on' });

    assert.equal(result.previousMode, 'on');
    assert.equal(linesOf(logger, 'affinity_disabled').length, 1);
  });

  it('notifies onChange for a new binding, a rebind and an eviction', () => {
    const { affinity, changes } = createTracked();

    reserve(affinity, 'session-a', 'acct-a');
    assert.equal(changes.length, 1, '新規バインド');

    reserve(affinity, 'session-a', 'acct-b', { reason: 'quota-exhausted' });
    assert.equal(changes.length, 2, '付け替え');

    affinity.evictAccounts(['acct-b']);
    assert.equal(changes.length, 3, '退避');
  });

  it('does not notify onChange when a bound session is simply revisited', () => {
    const { affinity, clock, changes } = createTracked();
    reserve(affinity, 'session-a', 'acct-a');
    const afterBind = changes.length;

    clock.ms += 1_000;
    reserve(affinity, 'session-a', 'acct-a');
    clock.ms += 1_000;
    affinity.get('session-a');

    assert.equal(changes.length, afterBind, 'lastSeen の更新だけでは表は「変わっていない」');
  });

  it('notifies onChange when a reload to off discards the table', () => {
    const { affinity, changes } = createTracked({ mode: 'on' });
    reserve(affinity, 'session-a', 'acct-a');
    const afterBind = changes.length;

    affinity.applySettings({ mode: 'off' });

    assert.equal(changes.length, afterBind + 1);
  });
});

// ---------------------------------------------------------------------------
// 復元したあとの LRU 順（R-S12 / FU-54）
//
// 表の順序は Map の挿入順＝recency（古い順）であり、`trimToCapacity` は「先頭が最も古い」
// という前提で退避先を選ぶ。空の表へ読み戻す起動時はそれで正しいが、すでに行のある表へ
// 読み戻すと、いま触られたばかりの行が先頭に残ったまま古い復元分が後ろへ並ぶ。その状態で
// 容量を超えると、生きているセッションのほうが先に落ちる。restore の直後に `lastSeen`
// 昇順で並べ直して、この取り違えを防ぐ。
// ---------------------------------------------------------------------------

describe('SessionAffinity restore ordering (R-S12 / FU-54)', () => {
  it('re-orders the table by last seen so a restore into a live table still evicts the oldest first', () => {
    const { affinity, clock } = createAffinity({ maxSessions: 3 });
    // いま触ったばかりのセッション。挿入順ではこれが先頭にいる。
    reserve(affinity, 'live-session', 'acct-a');

    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('older'), a: 'acct-a', t: START_MS - 120_000, s: 0 },
        { k: sidHash('oldest'), a: 'acct-a', t: START_MS - 300_000, s: 0 },
      ],
    }, { accountManager: ledger(['acct-a']) });

    assert.equal(result.restored, 2);
    assert.equal(affinity.size, 3);

    // 4件目で容量を超える。落ちるのは最も長く触られていない復元分であって、
    // いま触ったばかりの行ではない。
    clock.ms += 1_000;
    reserve(affinity, 'new-session', 'acct-a');

    assert.equal(affinity.size, 3);
    assert.equal(affinity.get('oldest'), null, '最も古い行が落ちる');
    assert.equal(affinity.get('live-session')?.home, 'acct-a', '生きている行は残る');
    assert.equal(affinity.get('older')?.home, 'acct-a');
    assert.equal(affinity.get('new-session')?.home, 'acct-a');
  });
});

// ---------------------------------------------------------------------------
// warm セッション数の増分保持（R-S16 / 設計書 v1.7 §3・P-c）
//
// 「温かい」＝最後に触れてから `warmTtlMs`（既定 1 時間）以内。要求ごとに表を全件
// 走査して数え直すのをやめ、bind / rebind / evict と `lastSeen` の更新で増分更新する。
// 冷えたことは事象を伴わないので、表の先頭（＝最も古い行）から冷えた分だけを落とす
// `pruneWarm()` を 1,000 要求ごとに償却で回す（新しいタイマーは作らない）。
// ---------------------------------------------------------------------------

describe('SessionAffinity warm counts (R-S16 / 設計書 v1.7 P-c)', () => {
  it('counts a binding as warm until warmTtlMs has passed and drops it on the amortised sweep', () => {
    const { affinity, clock } = createAffinity({ warmTtlMs: 3_600_000 });
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-2', 'acct-b');

    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1, 'acct-b': 1 });

    clock.ms += 3_600_001;
    // 冷えるだけでは事象が起きないので、掃除を呼ぶまで数は動かない（償却の設計）。
    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1, 'acct-b': 1 });
    assert.equal(affinity.pruneWarm(), 2);
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {});
    assert.equal(affinity.pruneWarm(), 0, '二度目の掃除は何も落とさない');

    // セッションそのものは idleTtlMs（6時間）まで残る——冷えただけでは退避しない。
    assert.equal(affinity.summary().sessions, 2);
    assert.deepEqual(affinity.summary().sessionsByAccount, { 'acct-a': 1, 'acct-b': 1 });
  });

  it('re-warms a cold session when it comes back', () => {
    const { affinity, clock } = createAffinity({ warmTtlMs: 3_600_000 });
    reserve(affinity, 'session-1', 'acct-a');

    clock.ms += 3_600_001;
    affinity.pruneWarm();
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {});

    reserve(affinity, 'session-1', 'acct-a');
    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1 });
    // `get()` は `lastSeen` を動かさないので温め直さない（表を読むだけ・§3）。
    // 温め直すのは予約（`note()`）であり、要求は必ずそこを通る。
    clock.ms += 3_600_001;
    affinity.pruneWarm();
    affinity.get('session-1');
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {});
  });

  it('moves the warm count with a rebind and with a family sub-binding', () => {
    const { affinity } = createAffinity();
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-1', 'acct-d', { modelFamily: 'fable', reason: 'family_exhausted' });

    assert.deepEqual(
      affinity.summary().warmSessionsByAccount,
      { 'acct-a': 1, 'acct-d': 1 },
      '副バインドは sessionsByAccount と同じ数え方（口座ごとに1回）',
    );

    reserve(affinity, 'session-1', 'acct-c', { reason: 'common_exhausted' });

    assert.deepEqual(
      affinity.summary().warmSessionsByAccount,
      { 'acct-c': 1 },
      'home の付け替えで副バインドが消えるので、その口座の warm も消える',
    );
  });

  it('removes the warm count when the row is evicted', () => {
    const { affinity, clock } = createAffinity({ idleTtlMs: 60_000, warmTtlMs: 60_000 });
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-2', 'acct-b');

    affinity.evictAccounts(['acct-b']);
    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1 });

    clock.ms += 60_001;
    affinity.prune();
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {}, 'TTL 退避でも数は残らない');
    assert.equal(affinity.size, 0);
  });

  it('never goes negative and drops the key once the count reaches zero', () => {
    const { affinity } = createAffinity({ maxSessions: 1 });
    reserve(affinity, 'session-1', 'acct-a');
    reserve(affinity, 'session-2', 'acct-a');

    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1 });
    assert.deepEqual(
      Object.keys(affinity.summary().warmSessionsByAccount).filter(id => id === 'acct-b'),
      [],
      '触れていない口座の鍵は生えない',
    );
  });

  it('exposes the counts as a map the selector can read without a full scan', () => {
    const { affinity } = createAffinity();
    reserve(affinity, 'session-1', 'acct-a');

    const counts = affinity.warmSessionCounts();

    assert.equal(counts instanceof Map, true);
    assert.equal(counts.get('acct-a'), 1);
    counts.set('acct-a', 999);
    assert.equal(affinity.summary().warmSessionsByAccount['acct-a'], 1, '戻り値は複製で内部を壊せない');
  });

  it('re-syncs the counts when warmTtlMs changes on reload', () => {
    const { affinity, clock } = createAffinity({ warmTtlMs: 3_600_000 });
    reserve(affinity, 'session-1', 'acct-a');
    clock.ms += 1_800_000;
    reserve(affinity, 'session-2', 'acct-b');

    // `previousMode:'on'` は「有効なまま設定だけ変えた reload」。既定の 'off' からの
    // 有効化だと表ごと捨てるので、数え直しの検証にならない（§6）。
    affinity.applySettings({ mode: 'on', warmTtlMs: 60_000 }, { previousMode: 'on' });

    assert.deepEqual(
      affinity.summary().warmSessionsByAccount,
      { 'acct-b': 1 },
      '短くした窓で数え直す（session-1 は 30 分前なので冷える）',
    );

    affinity.applySettings({ mode: 'on', warmTtlMs: 21_600_000 }, { previousMode: 'on' });

    assert.deepEqual(
      affinity.summary().warmSessionsByAccount,
      { 'acct-a': 1, 'acct-b': 1 },
      '広げた窓でも数え直す',
    );
  });

  it('seeds the counts from the restored last seen and clears them when the mode goes off', () => {
    const { affinity, clock } = createAffinity({ warmTtlMs: 3_600_000 });

    const result = affinity.restore({
      version: 1,
      savedAt: isoAt(clock.ms),
      entries: [
        { k: sidHash('warm-one'), a: 'acct-a', t: START_MS - 60_000, s: 0 },
        { k: sidHash('cold-one'), a: 'acct-b', t: START_MS - 7_200_000, s: 0 },
      ],
    }, { accountManager: ledger(['acct-a', 'acct-b']) });

    assert.equal(result.restored, 2, '6時間の idleTtl では冷えた行も復元される');
    assert.deepEqual(
      affinity.summary().warmSessionsByAccount,
      { 'acct-a': 1 },
      '復元直後から温かい行だけが数に入る',
    );

    affinity.applySettings({ mode: 'off' });
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {});
  });
});

describe('SessionAffinity warm sweep (R-S17 / 設計書 v1.7 P-c の遅延償却)', () => {
  it('sweeps once every 1,000 requests instead of on every request or on a timer', () => {
    const { affinity, clock } = createAffinity({ warmTtlMs: 60_000 });
    reserve(affinity, 'cold-session', 'acct-a');
    clock.ms += 60_001;

    for (let i = 1; i < 1_000; i += 1) {
      assert.equal(affinity.sweepWarm(), 0, `${i} 本目では掃除しない`);
    }
    assert.deepEqual(affinity.summary().warmSessionsByAccount, { 'acct-a': 1 });

    assert.equal(affinity.sweepWarm(), 1, '1,000 本目で1回だけ掃除する');
    assert.deepEqual(affinity.summary().warmSessionsByAccount, {});

    // 次の周期がまた 1,000 本ぶん続く。
    assert.equal(affinity.sweepWarm(), 0);
  });
});

// ---------------------------------------------------------------------------
// 冷えた固定の解放（R-S18 / 設計書 v1.7 §4.3・P-b）
//
// 予約段だけの理由である。キャッシュが失効したセッションを空いている口座へ動かすのは
// 費用ゼロなので付け替えてよいが、**送信直前の確定（§4.4 ②）では付け替えない**
// ——確定で動かしてよいのは枠の枯渇の2値だけという D-142 は v1.7 でも変えない。
// ---------------------------------------------------------------------------

describe('SessionAffinity cold_reassign (R-S18 / 設計書 v1.7 P-b)', () => {
  it('counts and logs cold_reassign as a known switch reason at the reservation stage', () => {
    const { affinity, logger } = createAffinity();
    reserve(affinity, SESSION_ID, 'acct-a');

    const switched = reserve(affinity, SESSION_ID, 'acct-b', { reason: 'cold_reassign' });

    assert.equal(switched.disposition, 'switch');
    assert.equal(switched.account, 'acct-b');
    assert.equal(switched.reason, 'cold_reassign', 'unknown へ落とさない');
    assert.deepEqual(affinity.summary().switchesByReason, { cold_reassign: 1 });
    assert.match(
      linesOf(logger, 'affinity_switch')[0],
      / from=acct-a to=acct-b reason=cold_reassign family=other switches=1$/,
    );
  });

  it('refuses to move the binding when cold_reassign arrives at the confirm stage (D-142)', () => {
    const { affinity } = createAffinity();
    const reserved = reserve(affinity, SESSION_ID, 'acct-a');

    const confirmed = affinity.note(SESSION_ID, {
      account: 'acct-b',
      expectedGen: reserved.gen,
      reason: 'cold_reassign',
    });

    assert.equal(confirmed.disposition, 'bound');
    assert.equal(confirmed.account, 'acct-a', '確定では冷えた解放を理由に付け替えない');
    assert.equal(affinity.get(SESSION_ID).home, 'acct-a');
    assert.deepEqual(affinity.summary().switchesByReason, {});
  });
});
