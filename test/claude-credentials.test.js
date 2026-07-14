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

  it('preserves Claude Code OAuth refresh metadata', () => {
    const parsed = parseClaudeCredentials({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1780582800000,
      refreshTokenExpiresAt: 1812118800000,
      scopes: ['user:profile', 'user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });

    assert.deepEqual(parsed, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1780582800000,
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: 1812118800000,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
  });

  it('rejects JSON without accessToken', () => {
    assert.throws(() => parseClaudeCredentials({ refreshToken: 'refresh' }), /accessToken/);
  });
});
