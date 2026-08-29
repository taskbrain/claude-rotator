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
  realpath,
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
  executeNativeClaudeCommand,
  NativeClaudeRefreshError,
  nativeClaudeKeychainAccount,
  nativeClaudeKeychainServiceName,
  refreshWithNativeClaudeCode as refreshWithNativeClaudeCodeImpl,
  resolveNativeClaudeCommand,
  resolveNativeTempRoot,
} from '../src/native-claude-refresher.js';
import { CLAUDE_AI_OAUTH_SCOPES, OAUTH_CLIENT_ID } from '../src/oauth.js';
import { LinuxFileSecretStore } from '../src/secret-store.js';

const OLD_ACCESS_TOKEN = 'old-access-token-secret';
const OLD_REFRESH_TOKEN = 'old-refresh-token-secret';
const NEW_ACCESS_TOKEN = 'new-access-token-secret';
const NEW_REFRESH_TOKEN = 'rotated-refresh-token-secret';
const NOW = 1_700_000_000_000;
const OLD_EXPIRES_AT = 1_800_000_000_000;
const NEW_EXPIRES_AT = OLD_EXPIRES_AT + 60 * 60 * 1000;

// Touches the real macOS Keychain (via the `security` CLI), which triggers OS
// authentication prompts on a developer machine. Skipped by default; CI opts
// in via CLAUDE_ROTATOR_REAL_KEYCHAIN=1 (see .github/workflows/ci.yml).
const REAL_KEYCHAIN_SKIP_REASON = process.platform !== 'darwin'
  ? 'darwin only'
  : (process.env.CLAUDE_ROTATOR_REAL_KEYCHAIN === '1'
    ? false
    : 'set CLAUDE_ROTATOR_REAL_KEYCHAIN=1 to run tests that touch the real macOS Keychain');

function refreshWithNativeClaudeCode(refreshToken, previousCredential, options = {}) {
  return refreshWithNativeClaudeCodeImpl(refreshToken, previousCredential, {
    platform: 'linux',
    ...options,
  });
}

function isRetrylessOutcomeUnknown(error) {
  assert.equal(error instanceof NativeClaudeRefreshError, true);
  assert.equal(error.code, 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
  assert.equal(error.retryAfterMs, null);
  assert.equal(error.retryAfterSource, null);
  return true;
}

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

    const nvmCommand = '/home/tester/.nvm/versions/node/v20/bin/claude';
    assert.equal(await resolveNativeClaudeCommand({
      env: {
        HOME: '/home/tester',
        PATH: '/home/tester/.nvm/versions/node/v20/bin:/usr/bin',
      },
      accessImpl: async path => {
        if (path !== nvmCommand) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    }), nvmCommand);
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

  it('uses the documented auth-login contract inside isolated storage', async () => {
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
    let callCount = 0;
    const apiTimeoutValues = [];
    const execFileImpl = async (command, args, options) => {
      sandbox = dirname(options.cwd);
      const credentialPath = join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json');
      const sandboxMode = (await stat(sandbox)).mode & 0o777;
      const workMode = (await stat(options.cwd)).mode & 0o777;
      const configMode = (await stat(options.env.CLAUDE_CONFIG_DIR)).mode & 0o777;
      const managedSettingsMode = (await stat(
        options.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH,
      )).mode & 0o777;
      assert.equal(command, 'claude');
      assert.equal(sandboxMode, 0o700);
      assert.equal(workMode, 0o700);
      assert.equal(configMode, 0o700);
      assert.equal(managedSettingsMode, 0o600);
      assert.equal(dirname(options.env.CLAUDE_CONFIG_DIR), sandbox);
      assert.equal(options.cwd, join(sandbox, 'work'));
      assert.equal(options.env.HOME, join(sandbox, 'home'));
      assert.equal(options.env.XDG_CONFIG_HOME, join(sandbox, 'xdg-config'));
      assert.equal(options.env.XDG_CACHE_HOME, join(sandbox, 'xdg-cache'));
      assert.equal(options.env.XDG_DATA_HOME, join(sandbox, 'xdg-data'));
      assert.equal(options.env.XDG_STATE_HOME, join(sandbox, 'xdg-state'));
      assert.equal(options.env.TMPDIR, join(sandbox, 'tmp'));
      assert.equal(options.env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(options.env.HTTPS_PROXY, undefined);
      apiTimeoutValues.push(options.env.API_TIMEOUT_MS);
      await assert.rejects(
        access(credentialPath),
        error => error.code === 'ENOENT',
      );

      callCount += 1;
      assert.equal(callCount, 1);
      assert.deepEqual(args, ['auth', 'login', '--claudeai']);
      assert.equal(options.timeoutMs, 28_000);
      assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, OLD_REFRESH_TOKEN);
      assert.equal(
        options.env.CLAUDE_CODE_OAUTH_SCOPES,
        'user:profile user:inference',
      );
      assert.equal(args.includes(OLD_REFRESH_TOKEN), false);
      assert.equal(sandboxMode, 0o700);
      assert.equal(workMode, 0o700);
      assert.equal(configMode, 0o700);
      assert.equal(managedSettingsMode, 0o600);

      await writeCredential(credentialPath, {
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresAt: NEW_EXPIRES_AT,
        scopes: ['user:profile', 'user:inference'],
        refreshTokenExpiresAt: 1_900_000_000_000,
          clientId: OAUTH_CLIENT_ID,
        subscriptionType: 'max',
        rateLimitTier: 'tier',
      });
      return {
        stdout: `ignored output ${OLD_ACCESS_TOKEN}`,
        stderr: `ignored error output ${OLD_REFRESH_TOKEN}`,
      };
    };

    const refreshed = await refreshWithNativeClaudeCodeImpl(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        platform: 'linux',
        command: 'claude',
        execFileImpl,
        tempRoot: testRoot,
        now: () => NOW,
        deadlineNow: () => 1_000,
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
      clientId: OAUTH_CLIENT_ID,
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
    assert.equal(callCount, 1);
    assert.deepEqual(apiTimeoutValues, [undefined]);
  });

  it('gives the sole auth-login command the remaining shared timeout budget', async () => {
    let deadlineTime = 1_000;
    let loginTimeoutMs;

    const refreshed = await refreshWithNativeClaudeCodeImpl(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        platform: 'linux',
        command: '/fake/claude',
        tempRoot: testRoot,
        timeoutMs: 6_000,
        now: () => NOW,
        deadlineNow: () => deadlineTime,
        accessImpl: async () => { deadlineTime += 500; },
        realpathImpl: async path => path,
        execFileImpl: async (command, args, options) => {
          assert.deepEqual(args, DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS);
          loginTimeoutMs = options.timeoutMs;
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
          return { stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(loginTimeoutMs, 3_000);
    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
  });

  it('fails locally before token handoff when the remaining budget cannot fence a child', async () => {
    let deadlineTime = 1_000;
    let handoffCalls = 0;
    let commandCalls = 0;

    await assert.rejects(
      refreshWithNativeClaudeCodeImpl(
        OLD_REFRESH_TOKEN,
        {
          ...previousContext(),
          beforeHandoff: async () => { handoffCalls += 1; },
        },
        {
          platform: 'linux',
          command: '/fake/claude',
          tempRoot: testRoot,
          timeoutMs: 2_500,
          now: () => NOW,
          deadlineNow: () => deadlineTime,
          accessImpl: async () => { deadlineTime += 300; },
          realpathImpl: async path => path,
          execFileImpl: async () => { commandCalls += 1; },
        },
      ),
      error => error.code === 'NATIVE_REFRESH_COMMAND_FAILED'
        && error.retryAfterMs === DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS
        && error.retryAfterSource === 'fixed',
    );

    assert.equal(commandCalls, 0);
    assert.equal(handoffCalls, 0);
  });

  it('fails closed without spawning login if the budget expires while arming handoff', async () => {
    let deadlineTime = 1_000;
    let handoffCalls = 0;
    let commandCalls = 0;

    // The durable handoff fence arms before the spawn attempt (see "arms the
    // handoff fence before the native child ever spawns" below), so once
    // arming itself consumes the remaining budget, the fence is already up
    // and the outcome must fail closed instead of returning a plain
    // recoverable error.
    await assert.rejects(
      refreshWithNativeClaudeCodeImpl(
        OLD_REFRESH_TOKEN,
        {
          ...previousContext(),
          beforeHandoff: async () => {
            handoffCalls += 1;
            deadlineTime += 600;
          },
        },
        {
          platform: 'linux',
          command: 'claude',
          tempRoot: testRoot,
          timeoutMs: 2_500,
          now: () => NOW,
          deadlineNow: () => deadlineTime,
          execFileImpl: async () => { commandCalls += 1; },
        },
      ),
      isRetrylessOutcomeUnknown,
    );

    assert.equal(commandCalls, 0);
    assert.equal(handoffCalls, 1);
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
          assert.equal(options.env.HOME, join(testRoot, 'global-home'));
          assert.equal(options.env.CLAUDE_CONFIG_DIR, options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR);
          assert.notEqual(options.env.HOME, dirname(options.env.CLAUDE_CONFIG_DIR));
          await assert.rejects(
            access(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json')),
            error => error.code === 'ENOENT',
          );

          assert.equal(keychain.items.has(keychainItemKey(isolatedAccount, isolatedService)), false);
          assert.deepEqual(args, ['auth', 'login', '--claudeai']);
          assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, OLD_REFRESH_TOKEN);
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
    assert.equal(keychain.calls.some(call => call.args[0] === '-i'), false);
  });

  it('reads a successful refresh from the plaintext fallback when the macOS Keychain write silently failed', async () => {
    const keychain = createFakeKeychainExecutor();
    let plaintextPath;

    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      {
        command: 'claude',
        platform: 'darwin',
        tempRoot: testRoot,
        env: {
          HOME: join(testRoot, 'global-home'),
          USER: 'mac.fallback-user',
          PATH: process.env.PATH,
        },
        keychainExecImpl: keychain.exec,
        now: () => NOW,
        execFileImpl: async (command, args, options) => {
          // Claude Code 2.1.246 falls back to a plaintext credential file
          // inside CLAUDE_SECURESTORAGE_CONFIG_DIR when the Keychain WRITE
          // itself fails (e.g. Keychain unavailable under launchd). Simulate
          // that here: never touch the fake Keychain, only write the file.
          plaintextPath = join(options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, '.credentials.json');
          await writeFile(plaintextPath, `${JSON.stringify({
            claudeAiOauth: {
              accessToken: NEW_ACCESS_TOKEN,
              refreshToken: NEW_REFRESH_TOKEN,
              expiresAt: NEW_EXPIRES_AT,
            },
          })}\n`, { encoding: 'utf8', mode: 0o600 });
        },
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(refreshed.expiresAt, NEW_EXPIRES_AT);
    // Nothing was ever seeded into (or read successfully from) the Keychain.
    assert.equal(keychain.items.size, 0);
    assert.equal(keychain.calls.some(call => call.args[0] === '-i'), false);
    // The plaintext fallback must be read-once-and-wiped, exactly like the
    // Linux isolated credential file, so the refreshed token does not
    // linger on disk after this call returns.
    await assert.rejects(access(plaintextPath), error => error.code === 'ENOENT');
  });

  it('round-trips an isolated credential through the real macOS Keychain adapter', {
    skip: REAL_KEYCHAIN_SKIP_REASON,
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
      platform: 'linux',
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
    assert.equal(refreshed.clientId, OAUTH_CLIENT_ID);
    assert.equal(refreshed.subscriptionType, 'max');
    assert.equal(refreshed.rateLimitTier, 'tier');
    assert.equal(refreshed.refreshTokenExpiresAt, 1_900_000_000_000);
  });

  it('awaits handoff before auth-login and forwards the child PID lease hooks', async () => {
    const events = [];
    let releaseHandoff;
    let signalHandoffStarted;
    const handoffGate = new Promise(resolve => { releaseHandoff = resolve; });
    const handoffStarted = new Promise(resolve => { signalHandoffStarted = resolve; });
    let loginStarted = false;
    const refresh = refreshWithNativeClaudeCodeImpl(
      OLD_REFRESH_TOKEN,
      {
        ...previousContext(),
        beforeHandoff: async () => {
          events.push('handoff-start');
          signalHandoffStarted();
          await handoffGate;
          events.push('handoff-finished');
        },
        protectChildPid: async childPid => events.push(`protect-${childPid}`),
        clearChildPid: async childPid => events.push(`clear-${childPid}`),
      },
      {
        platform: 'linux',
        command: 'claude',
        tempRoot: testRoot,
        execFileImpl: async (_command, args, options) => {
          assert.deepEqual(args, DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS);
          loginStarted = true;
          events.push('login');
          await options.afterSpawn(4321);
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
          await options.afterClose(4321);
          return { stdout: '', stderr: '' };
        },
      },
    );

    await handoffStarted;
    assert.equal(loginStarted, false);
    assert.deepEqual(events, ['handoff-start']);
    releaseHandoff();
    await refresh;
    assert.deepEqual(events, [
      'handoff-start',
      'handoff-finished',
      'login',
      'protect-4321',
      'clear-4321',
    ]);
  });

  it('retracts the handoff fence instead of leaving it armed when the native command never spawns a pid', async () => {
    let handoffCalls = 0;
    let retractCalls = 0;
    let protectCalls = 0;

    await assert.rejects(
      refreshWithNativeClaudeCodeImpl(
        OLD_REFRESH_TOKEN,
        {
          ...previousContext(),
          beforeHandoff: async () => { handoffCalls += 1; },
          retractHandoff: async () => { retractCalls += 1; },
          protectChildPid: async () => { protectCalls += 1; },
        },
        {
          platform: 'linux',
          command: 'claude',
          tempRoot: testRoot,
          execFileImpl: async () => {
            // No pid was ever assigned: afterSpawn must not be invoked (so
            // the PID lease never arms), but beforeHandoff has already run
            // before this call. A plain ENOENT/EACCES spawn failure must not
            // permanently park the account -- the refresh token never left
            // this process -- so the fence armed above must be retracted.
            const error = new Error('spawn ENOENT');
            error.code = 'ENOENT';
            throw error;
          },
        },
      ),
      error => error.code === 'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
    );

    assert.equal(handoffCalls, 1);
    assert.equal(protectCalls, 0);
    assert.equal(retractCalls, 1);
  });

  it('surfaces NATIVE_REFRESH_COMMAND_UNAVAILABLE for a genuinely missing claude binary instead of collapsing it into a permanent park', async () => {
    // Uses the real spawn path (default execFileImpl = executeNativeClaudeCommand)
    // with a command name that cannot exist on PATH, so the OS itself
    // produces the ENOENT -- not a mock -- exercising the exact "claude
    // binary missing/inaccessible" local failure this guards. Every account
    // sharing this environment would otherwise be misreported as needing a
    // manual relink (NATIVE_REFRESH_OUTCOME_UNKNOWN) for what is really just
    // a PATH/installation problem.
    await assert.rejects(
      refreshWithNativeClaudeCodeImpl(
        OLD_REFRESH_TOKEN,
        {
          ...previousContext(),
          beforeHandoff: async () => {},
          retractHandoff: async () => {},
        },
        {
          platform: 'linux',
          command: 'claude-rotator-test-definitely-missing-binary',
          tempRoot: testRoot,
        },
      ),
      error => error.code === 'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
    );
  });

  it('persists the durable handoff intent through the real secret-store transaction before the native child ever spawns', async () => {
    const accountsDir = join(testRoot, 'accounts');
    const secretStore = new LinuxFileSecretStore({ accountsDir });
    const intentPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const original = {
      accessToken: OLD_ACCESS_TOKEN,
      refreshToken: OLD_REFRESH_TOKEN,
      expiresAt: OLD_EXPIRES_AT,
    };
    await secretStore.set('acct_1', original);

    let intentExistedBeforeSpawn = null;
    const result = await secretStore.refreshIfUnchanged('acct_1', original, async (current, transaction) => ({
      ...current,
      ...(await refreshWithNativeClaudeCodeImpl(current.refreshToken, {
        ...previousContext(),
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        expiresAt: current.expiresAt,
        beforeHandoff: transaction.beforeHandoff,
        retractHandoff: transaction.retractHandoff,
        protectChildPid: transaction.protectChildPid,
        clearChildPid: transaction.clearChildPid,
      }, {
        platform: 'linux',
        command: 'claude',
        tempRoot: testRoot,
        execFileImpl: async (_command, _args, options) => {
          intentExistedBeforeSpawn = await pathExists(intentPath);
          // A real, live pid is required here: this goes through the actual
          // secret-store account-lock child-pid lease, which verifies the
          // pid corresponds to a running process.
          await options.afterSpawn(process.pid);
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
          await options.afterClose(process.pid);
          return { stdout: '', stderr: '' };
        },
      })),
    }));

    // Fixes the window this test guards: if this process died anywhere
    // between the child actually spawning and the transaction committing,
    // the durable intent already on disk -- not the (about to become stale)
    // stored secret -- is what would prevent the old refresh token from
    // being reused.
    assert.equal(intentExistedBeforeSpawn, true);
    assert.equal(result.updated, true);
    assert.equal(result.secret.accessToken, NEW_ACCESS_TOKEN);
    // A cleanly committed transaction leaves no dangling intent behind.
    await assert.rejects(stat(intentPath), { code: 'ENOENT' });
  });

  it('leaves no durable intent behind through the real secret-store transaction when the native command never spawns a pid', async () => {
    const accountsDir = join(testRoot, 'accounts');
    const secretStore = new LinuxFileSecretStore({ accountsDir });
    const intentPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const original = {
      accessToken: OLD_ACCESS_TOKEN,
      refreshToken: OLD_REFRESH_TOKEN,
      expiresAt: OLD_EXPIRES_AT,
    };
    await secretStore.set('acct_1', original);

    await assert.rejects(
      secretStore.refreshIfUnchanged('acct_1', original, async (current, transaction) => ({
        ...current,
        ...(await refreshWithNativeClaudeCodeImpl(current.refreshToken, {
          ...previousContext(),
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          expiresAt: current.expiresAt,
          beforeHandoff: transaction.beforeHandoff,
          retractHandoff: transaction.retractHandoff,
          protectChildPid: transaction.protectChildPid,
          clearChildPid: transaction.clearChildPid,
        }, {
          platform: 'linux',
          command: 'claude',
          tempRoot: testRoot,
          execFileImpl: async () => {
            const error = new Error('spawn ENOENT');
            error.code = 'ENOENT';
            throw error;
          },
        })),
      })),
      error => error.code === 'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
    );

    // The intent must not persist: nothing was ever handed to a child, so
    // the account must not be parked awaiting a manual relink.
    await assert.rejects(stat(intentPath), { code: 'ENOENT' });
    assert.deepEqual(await secretStore.get('acct_1'), original);
  });

  it('links an actually spawned native child to one PID lease until close', async () => {
    const events = [];

    await executeNativeClaudeCommand(process.execPath, ['-e', ''], {
      timeoutMs: 5_000,
      afterSpawn: async childPid => events.push(['protect', childPid]),
      afterClose: async childPid => events.push(['clear', childPid]),
    });

    assert.equal(events.length, 2);
    assert.deepEqual(events.map(([event]) => event), ['protect', 'clear']);
    assert.equal(Number.isInteger(events[0][1]), true);
    assert.equal(events[1][1], events[0][1]);
  });

  it('backfills current first-party OAuth scopes before native Claude refresh', async () => {
    const refreshed = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      {
        accessToken: OLD_ACCESS_TOKEN,
        refreshToken: OLD_REFRESH_TOKEN,
        expiresAt: OLD_EXPIRES_AT,
      },
      {
        tempRoot: testRoot,
        now: () => NOW,
        execFileImpl: async (command, args, options) => {
          const credentialPath = join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json');
          await assert.rejects(access(credentialPath), error => error.code === 'ENOENT');
          assert.equal(options.env.CLAUDE_CODE_OAUTH_SCOPES, CLAUDE_AI_OAUTH_SCOPES.join(' '));
          await writeCredential(credentialPath, {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
        },
      },
    );

    assert.deepEqual(refreshed.scopes, CLAUDE_AI_OAUTH_SCOPES);
  });

  it('rejects a custom OAuth client before invoking native Claude', async () => {
    const customClientId = 'custom-client-id';
    let invoked = false;
    await assert.rejects(
      refreshWithNativeClaudeCode(OLD_REFRESH_TOKEN, {
        accessToken: OLD_ACCESS_TOKEN,
        refreshToken: OLD_REFRESH_TOKEN,
        expiresAt: OLD_EXPIRES_AT,
        clientId: customClientId,
      }, {
        tempRoot: testRoot,
        execFileImpl: async () => { invoked = true; },
      }),
      error => error.code === 'NATIVE_REFRESH_UNSUPPORTED_CLIENT',
    );
    assert.equal(invoked, false);
  });

  it('rejects an explicit empty OAuth client ID before invoking native Claude', async () => {
    let invoked = false;
    await assert.rejects(
      refreshWithNativeClaudeCode(OLD_REFRESH_TOKEN, {
        ...previousContext(),
        clientId: '',
      }, {
        tempRoot: testRoot,
        execFileImpl: async () => { invoked = true; },
      }),
      error => error.code === 'NATIVE_REFRESH_UNSUPPORTED_CLIENT',
    );
    assert.equal(invoked, false);
  });

  it('treats nullish OAuth client IDs as missing first-party metadata', async () => {
    for (const clientId of [null, undefined]) {
      const refreshed = await refreshWithNativeClaudeCode(OLD_REFRESH_TOKEN, {
        accessToken: OLD_ACCESS_TOKEN,
        refreshToken: OLD_REFRESH_TOKEN,
        expiresAt: OLD_EXPIRES_AT,
        clientId,
      }, {
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          assert.equal(options.env.CLAUDE_CODE_OAUTH_SCOPES, CLAUDE_AI_OAUTH_SCOPES.join(' '));
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
        },
      });
      assert.deepEqual(refreshed.scopes, CLAUDE_AI_OAUTH_SCOPES);
    }
  });

  it('pins a configured Claude executable before the durable handoff', async () => {
    const originalTarget = join(testRoot, 'claude-original');
    const replacementTarget = join(testRoot, 'claude-replacement');
    const configuredCommand = join(testRoot, 'claude-current');
    await writeFile(originalTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(replacementTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await symlink(originalTarget, configuredCommand);
    const pinnedTarget = await realpath(originalTarget);
    const commands = [];

    const refreshed = await refreshWithNativeClaudeCodeImpl(
      OLD_REFRESH_TOKEN,
      {
        ...previousContext(),
        beforeHandoff: async () => {
          await unlink(configuredCommand);
          await symlink(replacementTarget, configuredCommand);
        },
      },
      {
        platform: 'linux',
        command: configuredCommand,
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          commands.push({ command, args });
          await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
          });
          return { stdout: '', stderr: '' };
        },
      },
    );

    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.deepEqual(commands.map(entry => entry.args), [DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS]);
    assert.deepEqual(commands.map(entry => entry.command), [pinnedTarget]);
  });

  it('parks retrylessly when an unsupported CLI rejects auth-login after handoff', async () => {
    const environments = [];
    let handoffCalls = 0;
    await assert.rejects(
      refreshWithNativeClaudeCodeImpl(OLD_REFRESH_TOKEN, {
        ...previousContext(),
        beforeHandoff: async () => { handoffCalls += 1; },
        protectChildPid: async () => {},
      }, {
        platform: 'linux',
        command: 'claude',
        tempRoot: testRoot,
        execFileImpl: async (command, args, options) => {
          environments.push({ args, env: options.env });
          // The child actually spawns (so a pid is assigned, and the already
          // -armed fence stays armed) before the CLI itself rejects the
          // unsupported flag.
          await options.afterSpawn(process.pid);
          throw Object.assign(new Error('unknown option --claudeai'), { code: 1 });
        },
      }),
      isRetrylessOutcomeUnknown,
    );
    assert.equal(handoffCalls, 1);
    assert.deepEqual(environments.map(entry => entry.args), [DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS]);
    assert.equal(environments[0].env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, OLD_REFRESH_TOKEN);
  });

  it('waits for child close after timeout before allowing credential cleanup', async () => {
    const events = [];
    const marker = join(testRoot, 'child-closed');
    await assert.rejects(
      executeNativeClaudeCommand(process.execPath, ['-e', `
        const fs = require('node:fs');
        process.on('SIGTERM', () => {
          setTimeout(() => {
            fs.writeFileSync(${JSON.stringify(marker)}, 'closed');
            process.exit(0);
          }, 25);
        });
        setInterval(() => {}, 1000);
      `], { timeoutMs: 200 }),
      error => error.code === 'ETIMEDOUT',
    );
    events.push('child-close');
    await readFile(marker, 'utf8');
    events.push('credential-read');
    await rm(marker);
    events.push('credential-cleanup');
    assert.deepEqual(events, ['child-close', 'credential-read', 'credential-cleanup']);
  });

  it('kills a child that ignores SIGTERM after the bounded grace period', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      executeNativeClaudeCommand(process.execPath, ['-e', `
        process.on('SIGTERM', () => {});
        setInterval(() => {}, 1000);
      `], { timeoutMs: 20 }),
      error => error.code === 'ETIMEDOUT',
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 2_000, `elapsed ${elapsed}ms must include SIGTERM grace`);
    assert.ok(elapsed < 3_500, `elapsed ${elapsed}ms exceeded bounded SIGTERM grace`);
  });

  it('kills a SIGTERM-ignoring grandchild after its direct child closes', {
    skip: process.platform !== 'linux',
  }, async () => {
    const grandchildPidPath = join(testRoot, 'grandchild.pid');
    const startedAt = Date.now();
    let grandchildPid = null;
    try {
      await assert.rejects(
        executeNativeClaudeCommand(process.execPath, ['-e', `
          const { spawn } = require('node:child_process');
          const fs = require('node:fs');
          const grandchild = spawn(process.execPath, ['-e', \
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'\
          ], { stdio: 'ignore' });
          fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
          process.stdout.destroy();
          process.stderr.destroy();
          process.on('SIGTERM', () => process.exit(0));
          setInterval(() => {}, 1000);
        `], { timeoutMs: 200 }),
        error => error.code === 'ETIMEDOUT',
      );
      const elapsed = Date.now() - startedAt;
      grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
      assert.ok(elapsed >= 2_000, `elapsed ${elapsed}ms must include group termination grace`);
      const processState = await readFile(`/proc/${grandchildPid}/stat`, 'utf8')
        .then(statLine => statLine.split(' ')[2])
        .catch(error => ['ENOENT', 'ESRCH'].includes(error.code) ? 'gone' : Promise.reject(error));
      assert.ok(['Z', 'gone'].includes(processState), `grandchild state was ${processState}`);
    } finally {
      if (Number.isInteger(grandchildPid)) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
    }
  });

  it('rejects a child spawn error only after its close event', async () => {
    const events = [];
    const execution = executeNativeClaudeCommand('/definitely/missing/claude', [], {
      afterClose: () => events.push('close'),
    });
    execution.catch(() => events.push('reject'));
    await assert.rejects(execution, error => error.code === 'ENOENT');
    assert.deepEqual(events, ['close', 'reject']);
  });

  it('rejects child output beyond 64 KiB without retaining it', async () => {
    await assert.rejects(
      executeNativeClaudeCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(65537));"], {
        timeoutMs: 5_000,
      }),
      error => error.code === 'ENOBUFS'
        && error.stdout === undefined
        && error.stderr === undefined,
    );
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

  it('accepts a refreshed credential written before a non-zero auth-login exit', async () => {
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
          const error = new Error('expected auth-login exit failure');
          error.code = 1;
          throw error;
        },
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
    assert.equal(refreshed.expiresAt, NEW_EXPIRES_AT);
  });

  it('accepts a refreshed credential written before an auth-login timeout', async () => {
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
          const error = new Error('expected auth-login timeout');
          error.code = 'ETIMEDOUT';
          throw error;
        },
      },
    );

    assert.equal(refreshed.accessToken, NEW_ACCESS_TOKEN);
    assert.equal(refreshed.refreshToken, NEW_REFRESH_TOKEN);
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

  it('parks retrylessly when auth-login exits zero without writing credentials', async () => {
    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async () => ({ stdout: '', stderr: '' }),
        },
      ),
      isRetrylessOutcomeUnknown,
    );
  });

  it('parks retrylessly when auth-login exits zero with unchanged credentials', async () => {
    let sandbox;

    await assert.rejects(
      refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        {
          tempRoot: testRoot,
          execFileImpl: async (command, args, options) => {
            sandbox = options.cwd;
            await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), {
              ...previousContext(),
            });
          },
        },
      ),
      isRetrylessOutcomeUnknown,
    );
    await assert.rejects(access(sandbox), error => error.code === 'ENOENT');
  });

  it('parks retrylessly when auth-login exits zero with a regressed expiry', async () => {
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
      isRetrylessOutcomeUnknown,
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
        assert.equal(error.code, 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
        assert.equal(error.retryAfterMs, null);
        assert.equal(error.retryAfterSource, null);
        assert.doesNotMatch(error.message, /old-access-token-secret/);
        assert.doesNotMatch(error.message, /old-refresh-token-secret/);
        assert.doesNotMatch(error.message, /stdout|stderr/);
        return true;
      },
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
        assert.equal(isRetrylessOutcomeUnknown(error), true);
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
            await symlink(externalCredential, credentialPath);
          },
        },
      ),
      isRetrylessOutcomeUnknown,
    );
    assert.equal(await readFile(externalCredential, 'utf8'), externalContents);
    assert.equal((await stat(externalCredential)).mode & 0o777, 0o600);
  });

  it('does not touch an external credential while reading isolated output', async () => {
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
    assert.equal(readOpenCount, 1);
    assert.equal(await readFile(externalCredential, 'utf8'), externalContents);
    assert.equal((await stat(externalCredential)).mode & 0o777, 0o600);
    assert.equal(cleanupReports.length, 0);
  });

  it('parks retrylessly when auth-login writes already-expired credentials', async () => {
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
      isRetrylessOutcomeUnknown,
    );
  });

  it('parks retrylessly when auth-login drops an existing OAuth scope', async () => {
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
      isRetrylessOutcomeUnknown,
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

  it('parks retrylessly when auth-login writes an expired refresh credential', async () => {
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
      isRetrylessOutcomeUnknown,
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
        && error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
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
    clientId: OAUTH_CLIENT_ID,
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

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
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
