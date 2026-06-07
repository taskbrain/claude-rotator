import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseClaudeCredentials } from '../src/claude-credentials.js';

describe('parseClaudeCredentials', () => {
  it('parses nested Claude Code credential JSON', () => {
    const parsed = parseClaudeCredentials(JSON.stringify({
      claudeAiOauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1780582800000,
      },
    }));

    assert.deepEqual(parsed, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1780582800000,
    });
  });

  it('parses flat credential JSON', () => {
    const parsed = parseClaudeCredentials({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1780582800000,
    });

    assert.equal(parsed.accessToken, 'access');
  });

  it('rejects JSON without accessToken', () => {
    assert.throws(() => parseClaudeCredentials({ refreshToken: 'refresh' }), /accessToken/);
  });
});
