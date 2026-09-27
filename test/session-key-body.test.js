// 本文を文字列にできない要求と、鍵関数の一本化の確認。
//
// HTTP も fs も使わないので実サービス・実 API へは構造的に到達しない。
// SESSION_ID は本ファイルで作った合成値であり、実在のセッション id ではない。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as affinity from '../src/session-affinity.js';
import * as key from '../src/session-key.js';

const SESSION_ID = '00000000-1111-2222-3333-444444444444';

function userIdBody(session) {
  return Buffer.from(JSON.stringify({
    metadata: { user_id: JSON.stringify({ session_id: session }) },
  }));
}

// 約 512MiB を超える本文では `Buffer#toString` が `ERR_STRING_TOO_LONG` を投げる。
// 本当に 512MiB は確保せず、toString だけを投げるものに差し替えて再現する。
function bufferWhoseToStringThrows() {
  const body = userIdBody(SESSION_ID);
  body.toString = () => {
    const error = new RangeError('Cannot create a string longer than 0x1fffffe8 characters');
    error.code = 'ERR_STRING_TOO_LONG';
    throw error;
  };
  return body;
}

describe('sessionKeyFrom with a body that cannot be turned into a string', () => {
  for (const [name, mod] of [['session-key.js', key], ['session-affinity.js', affinity]]) {
    it(`${name}: does not throw and treats the request as having no session key`, () => {
      const body = bufferWhoseToStringThrows();
      assert.equal(Buffer.isBuffer(body), true);
      assert.doesNotThrow(() => mod.sessionKeyFrom({ headers: {} }, body));
      assert.equal(mod.sessionKeyFrom({ headers: {} }, body), null);
      assert.equal(mod.sidHash(mod.sessionKeyFrom({ headers: {} }, body)), null);
    });

    it(`${name}: still takes the header when the body cannot be read`, () => {
      const body = bufferWhoseToStringThrows();
      const req = { headers: { 'x-claude-code-session-id': SESSION_ID } };
      assert.equal(mod.sessionKeyFrom(req, body), SESSION_ID);
    });
  }
});

describe('session key helpers are shared between session-affinity.js and session-key.js', () => {
  it('exports the very same functions and constant', () => {
    assert.equal(affinity.sessionKeyFrom, key.sessionKeyFrom);
    assert.equal(affinity.normalizeSessionKey, key.normalizeSessionKey);
    assert.equal(affinity.sidHash, key.sidHash);
    assert.equal(affinity.MAX_SESSION_KEY_LENGTH, key.MAX_SESSION_KEY_LENGTH);
    assert.equal(affinity.MAX_SESSION_KEY_LENGTH, 128);
  });

  it('extracts the same key and fingerprint from the same request', () => {
    const cases = [
      [{ headers: { 'x-claude-code-session-id': SESSION_ID } }, null, SESSION_ID],
      [{ headers: { 'x-claude-code-session-id': ` ${SESSION_ID} ` } }, null, SESSION_ID],
      [
        { rawHeaders: ['X-Claude-Code-Session-Id', SESSION_ID, 'x-claude-code-session-id', 'other'] },
        userIdBody('from-body'),
        'from-body',
      ],
      [{ headers: {} }, userIdBody(SESSION_ID), SESSION_ID],
      [{ headers: {} }, JSON.stringify({ metadata: { user_id: { session_id: SESSION_ID } } }), SESSION_ID],
      [{ headers: {} }, { metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) } }, SESSION_ID],
      [{ headers: {} }, userIdBody('x'.repeat(129)), null],
      [{ headers: {} }, userIdBody('has space'), null],
      [{ headers: {} }, Buffer.from('not json'), null],
      [{ headers: {} }, bufferWhoseToStringThrows(), null],
      [null, null, null],
    ];
    for (const [req, body, expected] of cases) {
      const fromKey = key.sessionKeyFrom(req, body);
      const fromAffinity = affinity.sessionKeyFrom(req, body);
      assert.equal(fromKey, expected);
      assert.equal(fromAffinity, fromKey);
      assert.equal(affinity.sidHash(fromAffinity), key.sidHash(fromKey));
    }
  });
});
