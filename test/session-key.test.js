// セッション鍵の純関数テスト（計画書 Task 2 Step 1）。
//
// **sticky（`feat/session-affinity`）の `test/session-affinity.test.js` の該当ケースと
// 同じ入力・同じ期待値にしてある。** 将来 sticky と統合するときに挙動の差が出ないよう、
// 期待値を独自に作り直さないこと。
//
// HTTP を使わないので実サービス・実 API へは構造的に到達しない。
// SESSION_ID は本ファイルで作った合成値であり、実在のセッション id ではない。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  MAX_SESSION_KEY_LENGTH,
  normalizeSessionKey,
  sessionKeyFrom,
  sidHash,
} from '../src/session-key.js';

const SESSION_ID = '00000000-1111-2222-3333-444444444444';

describe('normalizeSessionKey', () => {
  it('rejects a non-string, an empty string and whitespace only', () => {
    for (const raw of [undefined, null, 42, {}, [], Buffer.from(SESSION_ID), '', '   ']) {
      assert.equal(normalizeSessionKey(raw), null);
    }
  });

  it('rejects a key longer than 128 characters and keeps one of exactly 128', () => {
    assert.equal(MAX_SESSION_KEY_LENGTH, 128);
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
    // trim を先に行うので、末尾の改行は「値に混ざった改行」ではなく余白として落ちる。
    // 返る値そのものは必ず文字集合の検査を通っており、制御文字を含まない。
    assert.equal(normalizeSessionKey(`${SESSION_ID}\n`), SESSION_ID);
    assert.equal(normalizeSessionKey('A-z.0_9:x'), 'A-z.0_9:x');
  });
});

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
    assert.equal(sidHash(null), null);
  });

  it('12 hex 以外の値を返す入力が無い', () => {
    const inputs = [SESSION_ID, 'a', 'a'.repeat(128), 'A-z.0_9:x', `  ${SESSION_ID}  `];
    for (const raw of inputs) assert.match(sidHash(raw), /^[0-9a-f]{12}$/);
  });
});

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
    // すでに解析済みの本文を渡す経路。
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

  it('body に null を渡すと本文を読まない（sessionFromBody:false の既定経路）', () => {
    const body = Buffer.from(JSON.stringify({
      metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
    }));
    assert.equal(sessionKeyFrom({ headers: {} }, body), SESSION_ID);
    assert.equal(sessionKeyFrom({ headers: {} }, null), null);
  });
});
