import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClaudeCredentials,
  readCurrentClaudeCredentials,
} from '../src/claude-credentials.js';

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

describe('readCurrentClaudeCredentials', () => {
  it('reads the standard Claude Code Keychain item on macOS', async () => {
    const calls = [];
    const credential = await readCurrentClaudeCredentials({
      platform: 'darwin',
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        return {
          stdout: JSON.stringify({
            claudeAiOauth: {
              accessToken: 'mac-access',
              refreshToken: 'mac-refresh',
              expiresAt: 1780582800000,
              scopes: ['user:profile', 'user:inference'],
            },
          }),
        };
      },
    });

    assert.deepEqual(calls, [[
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    ]]);
    assert.equal(credential.accessToken, 'mac-access');
    assert.deepEqual(credential.scopes, ['user:profile', 'user:inference']);
  });

  it('reads the CLAUDE_CONFIG_DIR-specific Keychain item on macOS', async () => {
    const calls = [];

    await readCurrentClaudeCredentials({
      platform: 'darwin',
      home: '/Users/alice',
      env: { CLAUDE_CONFIG_DIR: '~/custom-claude' },
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        return { stdout: JSON.stringify({ accessToken: 'access' }) };
      },
    });

    assert.deepEqual(calls, [[
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials-14c9a4c3', '-w'],
    ]]);
  });

  it('reads the standard credential file on Linux', async () => {
    const calls = [];
    const credential = await readCurrentClaudeCredentials({
      platform: 'linux',
      home: '/home/alice',
      readFileImpl: async (path, encoding) => {
        calls.push([path, encoding]);
        return JSON.stringify({
          claudeAiOauth: {
            accessToken: 'linux-access',
            refreshToken: 'linux-refresh',
            expiresAt: 1780582800000,
          },
        });
      },
    });

    assert.deepEqual(calls, [['/home/alice/.claude/.credentials.json', 'utf8']]);
    assert.equal(credential.refreshToken, 'linux-refresh');
  });

  it('reads Linux credentials from CLAUDE_CONFIG_DIR', async () => {
    const calls = [];

    await readCurrentClaudeCredentials({
      platform: 'linux',
      home: '/home/alice',
      env: { CLAUDE_CONFIG_DIR: '/private/claude' },
      readFileImpl: async (path, encoding) => {
        calls.push([path, encoding]);
        return JSON.stringify({ accessToken: 'access' });
      },
    });

    assert.deepEqual(calls, [['/private/claude/.credentials.json', 'utf8']]);
  });
});
