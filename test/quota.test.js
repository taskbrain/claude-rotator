import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isFableScopeIdentity, scopeMatchesModelFamily } from '../src/quota.js';

describe('isFableScopeIdentity', () => {
  it('accepts every known spelling', () => {
    for (const v of ['fable', 'Fable', 'fable 5', 'fable_5', 'claude-fable-5', 'claude_fable_5']) {
      assert.equal(isFableScopeIdentity(v), true, `expected true for ${v}`);
    }
  });

  it('rejects other scopes', () => {
    for (const v of ['opus', 'sonnet', 'claude-opus-5', '', null, undefined, 42]) {
      assert.equal(isFableScopeIdentity(v), false, `expected false for ${String(v)}`);
    }
  });
});

describe('scopeMatchesModelFamily', () => {
  it('pairs a fable scope with the fable family only', () => {
    const limit = { key: 'fable', label: 'Fable', utilization: 1 };
    assert.equal(scopeMatchesModelFamily(limit, 'fable'), true);
    assert.equal(scopeMatchesModelFamily(limit, null), false);
    assert.equal(scopeMatchesModelFamily(limit, 'opus'), false);
  });

  it('never gates a request for an unknown (non-fable) scope', () => {
    const limit = { key: 'some_other_cap', label: 'Some Other Cap', utilization: 1 };
    assert.equal(scopeMatchesModelFamily(limit, 'fable'), false);
    assert.equal(scopeMatchesModelFamily(limit, null), false);
  });

  it('returns false for a missing limit', () => {
    assert.equal(scopeMatchesModelFamily(null, 'fable'), false);
    assert.equal(scopeMatchesModelFamily(undefined, null), false);
  });
});
