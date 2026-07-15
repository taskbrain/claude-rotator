import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createNativeClaudeRefresher,
  DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS,
  DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS,
  NativeClaudeRefreshError,
  refreshWithNativeClaudeCode,
} from '../src/native-claude-refresher.js';

const OLD_ACCESS_TOKEN = 'old-access-token-secret';
const OLD_REFRESH_TOKEN = 'old-refresh-token-secret';
const NEW_ACCESS_TOKEN = 'new-access-token-secret';
const NEW_REFRESH_TOKEN = 'rotated-refresh-token-secret';
const NOW = 1_700_000_000_000;
const OLD_EXPIRES_AT = 1_800_000_000_000;
const NEW_EXPIRES_AT = OLD_EXPIRES_AT + 60 * 60 * 1000;

describe('native Claude credential refresher', () => {
  let testRoot;

  beforeEach(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'native-claude-refresher-test-'));
  });

  afterEach(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('refreshes inside private isolated config and leaves global credentials and settings untouched', async () => {
    const globalHome = join(testRoot, 'global-home');
    const globalConfig = join(testRoot, 'global-claude-config');
    const globalCredentialPath = join(globalConfig, '.credentials.json');
    const globalSettingsPath = join(globalConfig, 'settings.json');
    await mkdir(globalConfig, { recursive: true });
    await mkdir(join(globalHome, '.claude'), { recursive: true });
    await writeFile(globalCredentialPath, 'global-credential-sentinel');
    await writeFile(globalSettingsPath, 'global-settings-sentinel');
    await writeFile(join(globalHome, '.claude', 'settings.json'), 'home-settings-sentinel');

    let sandbox;
    const execFileImpl = async (command, args, options) => {
      sandbox = dirname(options.cwd);
      const credentialPath = join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json');
      const credentialMode = (await stat(credentialPath)).mode & 0o777;
      const sandboxMode = (await stat(sandbox)).mode & 0o777;
      const workMode = (await stat(options.cwd)).mode & 0o777;
      const configMode = (await stat(options.env.CLAUDE_CONFIG_DIR)).mode & 0o777;
      const managedSettingsMode = (await stat(
        options.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH,
      )).mode & 0o777;
      const seeded = JSON.parse(await readFile(credentialPath, 'utf8'));

      assert.equal(command, 'claude');
      assert.deepEqual(args, DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS);
      assert.equal(sandboxMode, 0o700);
      assert.equal(workMode, 0o700);
      assert.equal(configMode, 0o700);
      assert.equal(managedSettingsMode, 0o600);
      assert.equal(credentialMode, 0o600);
      assert.equal(dirname(options.env.CLAUDE_CONFIG_DIR), sandbox);
      assert.equal(options.cwd, join(sandbox, 'work'));
      assert.equal(options.env.HOME, join(sandbox, 'home'));
      assert.equal(options.env.XDG_CONFIG_HOME, join(sandbox, 'xdg-config'));
      assert.equal(options.env.XDG_CACHE_HOME, join(sandbox, 'xdg-cache'));
      assert.equal(options.env.XDG_DATA_HOME, join(sandbox, 'xdg-data'));
      assert.equal(options.env.XDG_STATE_HOME, join(sandbox, 'xdg-state'));
      assert.equal(options.env.TMPDIR, join(sandbox, 'tmp'));
      assert.equal(options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, undefined);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.HTTPS_PROXY, undefined);
      assert.deepEqual(seeded, {
        claudeAiOauth: {
          accessToken: OLD_ACCESS_TOKEN,
          refreshToken: OLD_REFRESH_TOKEN,
          expiresAt: NOW - 1,
          scopes: ['user:profile', 'user:inference'],
          refreshTokenExpiresAt: 1_900_000_000_000,
          clientId: 'client-id',
          subscriptionType: 'max',
          rateLimitTier: 'tier',
        },
      });

      await writeCredential(credentialPath, {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresAt: NEW_EXPIRES_AT,
        scopes: ['user:profile', 'user:inference'],
        refreshTokenExpiresAt: 1_900_000_000_000,
        clientId: 'client-id',
        subscriptionType: 'max',
        rateLimitTier: 'tier',
      });
      return {
        stdout: `ignored output ${OLD_ACCESS_TOKEN}`,
        stderr: `ignored error output ${OLD_REFRESH_TOKEN}`,
      };
    };

    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        execFileImpl,
        tempRoot: testRoot,
        now: () => NOW,
        env: {
          PATH: process.env.PATH,
          HOME: globalHome,
          CLAUDE_CONFIG_DIR: globalConfig,
          ANTHROPIC_AUTH_TOKEN: 'global-auth-token',
          ANTHROPIC_API_KEY: 'global-api-key',
          ANTHROPIC_BASE_URL: 'https://example.invalid',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'global-refresh-token',
          HTTPS_PROXY: 'http://proxy.invalid',
        },
      },
    );

    assert.deepEqual(refreshed, {
      accessToken: NEW_ACCESS_TOKEN,
      refreshToken: NEW_REFRESH_TOKEN,
      expiresAt: NEW_EXPIRES_AT,
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: 1_900_000_000_000,
      clientId: 'client-id',
      subscriptionType: 'max',
      rateLimitTier: 'tier',
    });
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
    assert.equal(await readFile(globalCredentialPath, 'utf8'), 'global-credential-sentinel');
    assert.equal(await readFile(globalSettingsPath, 'utf8'), 'global-settings-sentinel');
    assert.equal(
      await readFile(join(globalHome, '.claude', 'settings.json'), 'utf8'),
      'home-settings-sentinel',
    );
  });

  it('accepts a rotated refresh token and preserves metadata omitted by native Claude', async () => {
    const refresher = createNativeClaudeRefresher({
      tempRoot: testRoot,
      execFileImpl: async (command, args, options) => {
        await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
          accessToken: NEW_ACCESS_TOKEN,
          refreshToken: NEW_REFRESH_TOKEN,
          expiresAt: NEW_EXPIRES_AT,
        });
      },
    });

    const refreshed = await refresher(OLD_REFRESH_TOKEN, previousContext());

    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.deepEqual(refreshed.scopes, ['user:profile', 'user:inference']);
    assert.equal(refreshed.clientId, 'client-id');
    assert.equal(refreshed.subscriptionType, 'max');
    assert.equal(refreshed.rateLimitTier, 'tier');
    assert.equal(refreshed.refreshTokenExpiresAt, 1_900_000_000_000);
  });

  it('accepts an extended expiry even when native Claude retains the access token', async () => {
    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: OLD_ACCESS_TOKEN,
            refreshToken: OLD_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
        },
      },
    );

    assert.equal(refreshed.accessToken, OLD_ACCESS_TOKEN);
    assert.equal(refreshed.expiresAt, NEW_EXPIRES_AT);
  });

  it('accepts a refreshed credential even though the isolated inference command fails locally', async () => {
    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
          throw new Error('expected loopback connection failure');
        },
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(refreshed.expiresAt, NEW_EXPIRES_AT);
  });

  it('rejects mismatched context before executing native Claude', async () => {
    let executed = false;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        { ...previousContext(), refreshToken: 'different-refresh-token' },
        {
          tempRoot: testRoot,
          execFileImpl: async () => {
            executed = true;
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INPUT_MISMATCH',
    );
    assert.equal(executed, false);
  });

  it('rejects unchanged credentials and removes the isolated directory', async () => {
    let sandbox;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            sandbox = options.cwd;
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_NOT_UPDATED',
    );
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
  });

  it('rejects a regressed expiry even when the access token changes', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
              accessToken: NEW_ACCESS_TOKEN,
              refreshToken: NEW_REFRESH_TOKEN,
              expiresAt: OLD_EXPIRES_AT - 1,
            });
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  });

  it('sanitizes command failures and always removes the isolated directory', async () => {
    let sandbox;
    const leakedStdout = `stdout-${OLD_ACCESS_TOKEN}`;
    const leakedStderr = `stderr-${OLD_REFRESH_TOKEN}`;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            sandbox = options.cwd;
            const error = new Error(`${leakedStdout} ${leakedStderr}`);
            error.stdout = leakedStdout;
            error.stderr = leakedStderr;
            throw error;
          },
        },
      ),
      error => {
        assert.equal(error.code, 'NATIVE_REFRESH_COMMAND_FAILED');
        assert.equal(error.retryAfterMs, DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS);
        assert.equal(error.retryAfterSource, 'fixed');
        assert.doesNotMatch(error.message, /old-access-token-secret/);
        assert.doesNotMatch(error.message, /old-refresh-token-secret/);
        assert.doesNotMatch(error.message, /stdout|stderr/);
        return true;
      },
    );
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
  });

  it('enforces its own timeout for an injected executor and cleans up', async () => {
    let sandbox;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          timeoutMs: 10,
          execFileImpl: async (command, args, options) => {
            sandbox = options.cwd;
            return new Promise(() => {});
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_TIMEOUT'
        && error.retryAfterMs === DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS
        && error.retryAfterSource === 'fixed',
    );
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
  });

  it('does not expose credential contents when native output is invalid', async () => {
    let sandbox;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            sandbox = options.cwd;
            await writeFile(
              join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
              `{invalid-${OLD_ACCESS_TOKEN}-${OLD_REFRESH_TOKEN}`,
            );
          },
        },
      ),
      error => {
        assert.equal(error.code, 'NATIVE_REFRESH_INVALID_OUTPUT');
        assert.doesNotMatch(error.message, /old-access-token-secret|old-refresh-token-secret/);
        return true;
      },
    );
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
  });

  it('rejects a symlinked native credential output without touching its target', async () => {
    const externalCredential = join(testRoot, 'external-credential.json');
    const externalContents = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'external-access',
        refreshToken: 'external-refresh',
        expiresAt: NEW_EXPIRES_AT,
      },
    });
    await writeFile(externalCredential, externalContents, { mode: 0o600 });

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            const credentialPath = join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json');
            await unlink(credentialPath);
            await symlink(externalCredential, credentialPath);
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
    );
    assert.equal(await readFile(externalCredential, 'utf8'), externalContents);
    assert.equal((await stat(externalCredential)).mode & 0o777, 0o600);
  });

  it('rejects refreshed credentials that are already expired', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          now: () => NEW_EXPIRES_AT + 1,
          execFileImpl: async (command, args, options) => {
            await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
              accessToken: NEW_ACCESS_TOKEN,
              refreshToken: NEW_REFRESH_TOKEN,
              expiresAt: NEW_EXPIRES_AT,
            });
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  });

  it('rejects refreshed credentials that drop an existing OAuth scope', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
              accessToken: NEW_ACCESS_TOKEN,
              refreshToken: NEW_REFRESH_TOKEN,
              expiresAt: NEW_EXPIRES_AT,
              scopes: ['user:profile'],
            });
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  });

  it('requires relinking when the refresh credential itself is expired', async () => {
    let executed = false;
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        {
          ...previousContext(),
          refreshTokenExpiresAt: 1,
        },
        {
          tempRoot: testRoot,
          execFileImpl: async () => {
            executed = true;
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_REAUTH_REQUIRED',
    );
    assert.equal(executed, false);
  });

  it('rejects an expired refresh-credential expiry produced by native Claude', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          now: () => NOW,
          execFileImpl: async (command, args, options) => {
            await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
              accessToken: NEW_ACCESS_TOKEN,
              refreshToken: NEW_REFRESH_TOKEN,
              expiresAt: NEW_EXPIRES_AT,
              refreshTokenExpiresAt: NOW - 1,
            });
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  });

  it('surfaces cleanup failures even when the native refresh command also fails', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async () => {
            throw new Error('command failure');
          },
          removeImpl: async () => {
            throw new Error('cleanup failure');
          },
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_CLEANUP_FAILED'
        && !/command failure|cleanup failure/.test(error.message),
    );
  });
});

function previousContext() {
  return {
    accessToken: OLD_ACCESS_TOKEN,
    refreshToken: OLD_REFRESH_TOKEN,
    expiresAt: OLD_EXPIRES_AT,
    scopes: ['user:profile', 'user:inference', 'user:profile'],
    refreshTokenExpiresAt: 1_900_000_000_000,
    clientId: 'client-id',
    subscriptionType: 'max',
    rateLimitTier: 'tier',
  };
}

async function writeCredential(path, credential) {
  await writeFile(path, JSON.stringify({ claudeAiOauth: credential }), {
    encoding: 'utf8',
    mode: 0o600,
  });
}
