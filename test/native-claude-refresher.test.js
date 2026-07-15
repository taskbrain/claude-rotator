import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createNativeClaudeCredentialStorage,
  createNativeClaudeRefresher,
  DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS,
  DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS,
  executeSecurityCommand,
  NativeClaudeRefreshError,
  nativeClaudeKeychainAccount,
  nativeClaudeKeychainServiceName,
  refreshWithNativeClaudeCode,
  resolveNativeClaudeCommand,
  resolveNativeTempRoot,
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

  it('prefers an override, then an executable native installer binary, then PATH', async () => {
    let accessCalls = 0;
    assert.equal(await resolveNativeClaudeCommand({
      command: '/configured/claude',
      env: { HOME: '/home/tester' },
      accessImpl: async () => {
        accessCalls += 1;
      },
    }), '/configured/claude');
    assert.equal(accessCalls, 0);

    const nativeInstallerCommand = '/home/tester/.local/bin/claude';
    assert.equal(await resolveNativeClaudeCommand({
      env: { HOME: '/home/tester' },
      accessImpl: async (path, mode) => {
        accessCalls += 1;
        assert.equal(path, nativeInstallerCommand);
        assert.equal(mode, fsConstants.X_OK);
      },
    }), nativeInstallerCommand);
    assert.equal(accessCalls, 1);

    assert.equal(await resolveNativeClaudeCommand({
      env: { HOME: '/home/tester' },
      accessImpl: async () => {
        throw Object.assign(new Error('not executable'), { code: 'EACCES' });
      },
    }), 'claude');

    const checked = [];
    assert.equal(await resolveNativeClaudeCommand({
      env: {
        HOME: '/Users/tester',
        PATH: '/missing:/opt/homebrew/bin:/usr/bin',
      },
      accessImpl: async (path, mode) => {
        checked.push(path);
        assert.equal(mode, fsConstants.X_OK);
        if (path !== '/opt/homebrew/bin/claude') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    }), '/opt/homebrew/bin/claude');
    assert.ok(checked.includes('/Users/tester/.local/bin/claude'));
    assert.ok(checked.includes('/opt/homebrew/bin/claude'));
  });

  it('uses only a private owner-matched XDG runtime directory as the default temp root', async () => {
    const runtimeDir = join(testRoot, 'runtime');
    await mkdir(runtimeDir, { mode: 0o700 });
    await chmod(runtimeDir, 0o700);

    assert.equal(await resolveNativeTempRoot({
      env: { XDG_RUNTIME_DIR: runtimeDir },
      fallback: '/fallback',
    }), runtimeDir);

    await chmod(runtimeDir, 0o755);
    assert.equal(await resolveNativeTempRoot({
      env: { XDG_RUNTIME_DIR: runtimeDir },
      fallback: '/fallback',
    }), '/fallback');
  });

  it('derives the exact normalized Claude Code Keychain identity and sanitizes USER', () => {
    const decomposedConfigDir = join(testRoot, 'cafe\u0301');
    const normalized = decomposedConfigDir.normalize('NFC');
    const expectedHash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);

    assert.equal(
      nativeClaudeKeychainServiceName(decomposedConfigDir),
      `Claude Code-credentials-${expectedHash}`,
    );
    assert.equal(
      nativeClaudeKeychainServiceName(normalized),
      `Claude Code-credentials-${expectedHash}`,
    );
    assert.equal(
      nativeClaudeKeychainAccount({ USER: 'safe.user-1' }, () => ({ username: 'ignored' })),
      'safe.user-1',
    );
    assert.equal(
      nativeClaudeKeychainAccount({ USER: 'unsafe user;rm' }, () => ({ username: 'ignored' })),
      'claude-code-user',
    );
    assert.equal(
      nativeClaudeKeychainAccount({}, () => ({ username: 'local_user' })),
      'local_user',
    );
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

  it('refreshes on macOS through an isolated temporary Keychain service without argv secrets', async () => {
    const keychain = createFakeKeychainExecutor();
    let isolatedService;
    let isolatedAccount;

    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        platform: 'darwin',
        tempRoot: testRoot,
        env: {
          HOME: join(testRoot, 'global-home'),
          USER: 'mac.test-user',
          LOGNAME: 'different-global-name',
          PATH: process.env.PATH,
        },
        keychainExecImpl: keychain.exec,
        now: () => NOW,
        execFileImpl: async (command, args, options) => {
          isolatedService = nativeClaudeKeychainServiceName(
            options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
          );
          isolatedAccount = options.env.USER;
          assert.equal(options.env.LOGNAME, isolatedAccount);
          assert.equal(options.env.CLAUDE_CONFIG_DIR, options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR);
          await assert.rejects(
            access(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json')),
            error => error.code === 'ENOENT',
          );

          const seeded = JSON.parse(keychain.items.get(
            keychainItemKey(isolatedAccount, isolatedService),
          ));
          assert.equal(seeded.claudeAiOauth.accessToken, OLD_ACCESS_TOKEN);
          assert.equal(seeded.claudeAiOauth.refreshToken, OLD_REFRESH_TOKEN);
          assert.equal(seeded.claudeAiOauth.expiresAt, NOW - 1);
          keychain.items.set(
            keychainItemKey(isolatedAccount, isolatedService),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: NEW_ACCESS_TOKEN,
                refreshToken: NEW_REFRESH_TOKEN,
                expiresAt: NEW_EXPIRES_AT,
              },
            }),
          );
        },
      },
    );

    assert.equal(isolatedAccount, 'mac.test-user');
    assert.match(isolatedService, /^Claude Code-credentials-[0-9a-f]{8}$/);
    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(refreshed.expiresAt, NEW_EXPIRES_AT);
    assert.equal(keychain.items.size, 0);
    const seedCall = keychain.calls.find(call => call.args[0] === '-i');
    assert.deepEqual(seedCall.args, ['-i']);
    assert.doesNotMatch(seedCall.args.join(' '), /old-access|old-refresh|new-access|new-refresh/);
    assert.match(seedCall.options.input, /^add-generic-password .+ -X "[0-9a-f]+"\n$/);
  });

  it('round-trips an isolated credential through the real macOS Keychain adapter', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const configDir = join(testRoot, 'native-keychain-config');
    const account = `ci-${process.pid}-${Date.now()}`;
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const storage = createNativeClaudeCredentialStorage({
      platform: 'darwin',
      configDir,
      keychainAccount: account,
      keychainExecImpl: executeSecurityCommand,
      openImpl: open,
      timeoutMs: 5_000,
    });
    const credential = {
      accessToken: 'fake-native-access-token',
      refreshToken: 'fake-native-refresh-token',
      expiresAt: 4_102_444_800_000,
      scopes: ['user:inference'],
    };

    try {
      await storage.seed(credential);
      assert.deepEqual(await storage.read('seed'), credential);
      await storage.cleanup();
      await assert.rejects(
        () => storage.read('refreshed'),
        error => error.code === 'NATIVE_REFRESH_INVALID_OUTPUT',
      );
    } finally {
      await storage.cleanup().catch(() => {});
    }
  });

  it('waits for child close and pending pre-input fencing before rejecting a timeout', async () => {
    let closeObserved = false;
    let beforeInputFinished = false;
    let releaseBeforeInput;
    let settled = false;
    const beforeInputGate = new Promise(resolve => { releaseBeforeInput = resolve; });

    const execution = executeSecurityCommand(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], {
      timeout: 20,
      beforeInput: async () => {
        await beforeInputGate;
        beforeInputFinished = true;
      },
      afterClose: () => {
        closeObserved = true;
      },
    });
    execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal(beforeInputFinished, false);

    releaseBeforeInput();
    await assert.rejects(
      () => execution,
      error => error.code === 'ETIMEDOUT',
    );
    assert.equal(beforeInputFinished, true);
    assert.equal(closeObserved, true);
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

  it('reads from an O_NOFOLLOW file handle safely when the path is swapped after open', async () => {
    const externalCredential = join(testRoot, 'external-swap-target.json');
    const externalContents = 'external-target-must-not-be-read-or-modified';
    await writeFile(externalCredential, externalContents, { mode: 0o600 });
    let readOpenCount = 0;
    const cleanupReports = [];

    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        tempRoot: testRoot,
        openImpl: async (path, flags, ...rest) => {
          const handle = await open(path, flags, ...rest);
          if (flags === (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)) {
            readOpenCount += 1;
            if (readOpenCount === 2) {
              await rename(path, `${path}.opened`);
              await symlink(externalCredential, path);
            }
          }
          return handle;
        },
        execFileImpl: async (command, args, options) => {
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
        },
        onCleanupError: error => cleanupReports.push(error),
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(readOpenCount, 2);
    assert.equal(await readFile(externalCredential, 'utf8'), externalContents);
    assert.equal((await stat(externalCredential)).mode & 0o777, 0o600);
    assert.equal(cleanupReports.length, 1);
    assert.equal(cleanupReports[0].code, 'NATIVE_REFRESH_CLEANUP_FAILED');
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

  it('preserves a primary command failure and reports cleanup failures separately', async () => {
    const cleanupReports = [];
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
          onCleanupError: error => cleanupReports.push(error),
        },
      ),
      error => error instanceof NativeClaudeRefreshError
        && error.code === 'NATIVE_REFRESH_COMMAND_FAILED'
        && !/command failure|cleanup failure/.test(error.message),
    );
    assert.equal(cleanupReports.length, 1);
    assert.equal(cleanupReports[0].code, 'NATIVE_REFRESH_CLEANUP_FAILED');
    assert.doesNotMatch(cleanupReports[0].message, /old-access|old-refresh|cleanup failure/);
  });

  it('returns a refreshed result when sandbox cleanup fails and reports the failure', async () => {
    const cleanupReports = [];
    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
        },
        removeImpl: async () => {
          throw new Error(`cleanup-${OLD_ACCESS_TOKEN}-${OLD_REFRESH_TOKEN}`);
        },
        onCleanupError: error => cleanupReports.push(error),
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(cleanupReports.length, 1);
    assert.equal(cleanupReports[0].code, 'NATIVE_REFRESH_CLEANUP_FAILED');
    assert.doesNotMatch(cleanupReports[0].message, /old-access|old-refresh/);
  });

  it('returns a macOS refreshed result when Keychain deletion fails and reports the failure', async () => {
    const keychain = createFakeKeychainExecutor({ deleteFailure: true });
    const cleanupReports = [];
    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        platform: 'darwin',
        tempRoot: testRoot,
        env: { USER: 'mac-user', HOME: testRoot },
        keychainExecImpl: keychain.exec,
        execFileImpl: async (command, args, options) => {
          const service = nativeClaudeKeychainServiceName(
            options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
          );
          keychain.items.set(
            keychainItemKey(options.env.USER, service),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: NEW_ACCESS_TOKEN,
                refreshToken: NEW_REFRESH_TOKEN,
                expiresAt: NEW_EXPIRES_AT,
              },
            }),
          );
        },
        onCleanupError: error => cleanupReports.push(error),
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(cleanupReports.length, 1);
    assert.equal(cleanupReports[0].code, 'NATIVE_REFRESH_CLEANUP_FAILED');
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

function keychainItemKey(account, service) {
  return `${account}\0${service}`;
}

function createFakeKeychainExecutor({ deleteFailure = false } = {}) {
  const items = new Map();
  const calls = [];
  const exec = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], options: { ...options } });
    assert.equal(command, 'security');
    if (args[0] === '-i') {
      const match = options.input.match(
        /^add-generic-password -U -a "([a-zA-Z0-9._-]+)" -s "(Claude Code-credentials-[0-9a-f]{8})" -X "([0-9a-f]+)"\n$/,
      );
      assert.ok(match, 'seed command must use safe identifiers and a hex stdin payload');
      items.set(keychainItemKey(match[1], match[2]), Buffer.from(match[3], 'hex').toString('utf8'));
      return { stdout: '', stderr: '' };
    }

    const account = args[args.indexOf('-a') + 1];
    const service = args[args.indexOf('-s') + 1];
    const key = keychainItemKey(account, service);
    if (args[0] === 'find-generic-password') {
      if (!items.has(key)) {
        const error = new Error('missing keychain item');
        error.code = 44;
        throw error;
      }
      return { stdout: items.get(key), stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      if (deleteFailure) throw new Error('injected keychain cleanup failure');
      if (!items.delete(key)) {
        const error = new Error('missing keychain item');
        error.code = 44;
        throw error;
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error('unexpected fake Keychain command');
  };
  return { calls, exec, items };
}
