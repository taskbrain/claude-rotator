import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  assertAnthropicGatewayProviderCompatible,
  assertGatewayCompatibleAccounts,
  claudeLoginOverrideSource,
  createRuntimeStateWriter,
  credentialOwnershipConfiguration,
  ensureCredentialRevisions,
  internalApiUrl,
  removeServiceFile,
  requestJson,
  restoreRuntimeState,
  runCli,
  runMacosCliActionWithLock,
  startService,
} from '../src/cli.js';
import { AccountManager } from '../src/account-manager.js';
import { MACOS_LAUNCH_AGENT_LABEL, installSettings } from '../src/install.js';
import { SessionAffinity } from '../src/session-affinity.js';
import { writeJsonFile } from '../src/json-file.js';
import { SERVICE_COMMAND_LOG_ENV } from '../fixtures/service-command-guard.js';

// uninstallCommand's non-darwin branch stops the unit before deleting it, so
// every Linux test here must inject the command runner: left uninjected it
// runs the machine's own `systemctl --user disable --now
// claude-rotator.service` and takes down the developer's own rotator.
const LINUX_UNINSTALL_SERVICE_CALLS = [
  ['systemctl', ['--user', 'disable', '--now', 'claude-rotator.service']],
];

function createServiceCommandSpy() {
  const calls = [];
  return {
    calls,
    execFileImpl: async (command, args) => {
      calls.push([command, [...args]]);
      return { stdout: '', stderr: '' };
    },
  };
}

describe('ensureCredentialRevisions', () => {
  it('assigns a non-secret baseline only to accounts missing a revision', () => {
    const config = {
      accounts: [
        { id: 'legacy', name: 'legacy@example.com' },
        { id: 'current', name: 'current@example.com', credentialRevision: 'keep-me' },
      ],
    };
    const revisions = ['generated-revision'];

    assert.equal(ensureCredentialRevisions(config, {
      createRevision: () => revisions.shift(),
    }), true);
    assert.equal(config.accounts[0].credentialRevision, 'generated-revision');
    assert.equal(config.accounts[1].credentialRevision, 'keep-me');
    assert.equal(ensureCredentialRevisions(config, {
      createRevision: () => assert.fail('no new revision expected'),
    }), false);
  });
});

describe('gateway account compatibility', () => {
  it('rejects provider protocols that are incompatible with an Anthropic gateway', () => {
    for (const source of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE',
    ]) {
      assert.throws(
        () => assertAnthropicGatewayProviderCompatible(source),
        /provider protocol that is incompatible/,
      );
    }
    assert.doesNotThrow(() => assertAnthropicGatewayProviderCompatible('ANTHROPIC_AUTH_TOKEN'));
    assert.doesNotThrow(() => assertAnthropicGatewayProviderCompatible(null));
  });

  it('rejects live current accounts and accepts stored snapshots', () => {
    assert.throws(
      () => assertGatewayCompatibleAccounts([{
        id: 'current',
        credentialSource: 'claude-code-current',
      }]),
      /Run claude-rotator remove current first, then claude auth login --claudeai and claude-rotator login before installing\./,
    );
    assert.doesNotThrow(() => assertGatewayCompatibleAccounts([{
      id: 'saved-account',
      type: 'oauth',
    }]));
  });

  it('detects every configured credential that takes precedence over saved login', () => {
    for (const name of [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
      assert.equal(claudeLoginOverrideSource({}, { [name]: 'configured' }), name);
      assert.equal(claudeLoginOverrideSource({ env: { [name]: 'configured' } }), name);
    }
    assert.equal(
      claudeLoginOverrideSource({ apiKeyHelper: '/usr/local/bin/read-key' }),
      'apiKeyHelper',
    );
    assert.equal(
      claudeLoginOverrideSource({ env: { ANTHROPIC_AUTH_TOKEN: ' ' } }),
      'ANTHROPIC_AUTH_TOKEN',
    );
    assert.equal(claudeLoginOverrideSource({}, {}), null);
  });

  it('uses settings env values ahead of inherited shell values', () => {
    assert.equal(
      claudeLoginOverrideSource(
        { env: { ANTHROPIC_AUTH_TOKEN: '' } },
        { ANTHROPIC_AUTH_TOKEN: 'inherited' },
      ),
      null,
    );
  });

  it('builds reload results with the same credential ownership mode used at startup', () => {
    const accounts = [{ id: 'saved-account', type: 'oauth' }];

    assert.deepEqual(credentialOwnershipConfiguration(accounts, null), {
      accounts,
      allowLiveClaudeCodeCredentials: true,
    });
    assert.deepEqual(credentialOwnershipConfiguration(accounts, 'ANTHROPIC_AUTH_TOKEN'), {
      accounts,
      allowLiveClaudeCodeCredentials: false,
    });
  });

  it('returns a changed ownership mode before surfacing gateway account validation', () => {
    const accounts = [{
      id: 'current',
      type: 'oauth',
      credentialSource: 'claude-code-current',
    }];

    const result = credentialOwnershipConfiguration(accounts, 'ANTHROPIC_AUTH_TOKEN', {
      deferValidationError: true,
    });

    assert.equal(result.allowLiveClaudeCodeCredentials, false);
    assert.equal(result.accounts, accounts);
    assert.match(result.validationError.message, /Gateway authentication cannot be installed/);
  });
});

describe('internal API transport', () => {
  it('uses a valid IPv6 loopback URL for local CLI requests', async t => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '::1', resolve);
      });
    } catch (error) {
      if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error?.code)) {
        t.skip('IPv6 loopback is unavailable on this host');
        return;
      }
      throw error;
    }

    try {
      const port = server.address().port;
      const url = internalApiUrl({ proxy: { host: '::1', port } }, '/internal/health');
      assert.equal(url, `http://[::1]:${port}/internal/health`);
      assert.deepEqual(await requestJson(url, { method: 'GET' }), {
        ok: true,
        path: '/internal/health',
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
import { MemorySecretStore } from '../src/secret-store.js';

describe('runCli', () => {
  it('prints help', async () => {
    const io = createIo();

    const code = await runCli(['help'], { ...io });

    assert.equal(code, 0);
    assert.match(io.output(), /claude-rotator install/);
    assert.match(io.output(), /claude-rotator monitor/);
  });

  it('routes public macOS install through the shared lock without forwarding unrelated arguments', async () => {
    const io = createIo();
    const calls = [];

    const code = await runCli(['install', '--force'], {
      ...io,
      platform: 'darwin',
      home: '/Users/alice',
      env: {},
      cliPath: '/app/bin/claude-rotator.js',
      runLockedMacosAction: async options => {
        calls.push(options);
        return 0;
      },
    });

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].argv, ['install', '--force']);
    assert.equal(calls[0].lockPath, '/Users/alice/.config/claude-rotator/macos-service.lock');
  });

  it('reports a locked macOS child failure as a normal CLI failure', async () => {
    const io = createIo();

    const code = await runCli(['install'], {
      ...io,
      platform: 'darwin',
      home: '/Users/alice',
      env: {},
      cliPath: '/app/bin/claude-rotator.js',
      runLockedMacosAction: async () => { throw new Error('lock child failed'); },
    });

    assert.equal(code, 1);
    assert.match(io.output(), /lock child failed/);
  });

  it('rejects the hidden macOS action unless the lock workflow marker is present', async () => {
    const io = createIo();
    let installCalls = 0;

    const code = await runCli(['__macos-service-action', 'install'], {
      ...io,
      platform: 'darwin',
      env: {},
      installAction: async () => { installCalls += 1; },
    });

    assert.equal(code, 1);
    assert.equal(installCalls, 0);
    assert.match(io.output(), /shared lock/);
  });

  it('executes the hidden macOS action in the marked lock child', async () => {
    const io = createIo();
    const calls = [];

    const code = await runCli(['__macos-service-action', 'install', '--no-start'], {
      ...io,
      platform: 'darwin',
      env: { CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1' },
      installAction: async options => { calls.push(options.argv); },
    });

    assert.equal(code, 0);
    assert.deepEqual(calls, [['install', '--no-start']]);
  });

  it('keeps Linux install in-process', async () => {
    const io = createIo();
    let installCalls = 0;

    const code = await runCli(['install', '--no-start'], {
      ...io,
      platform: 'linux',
      installAction: async () => { installCalls += 1; },
      runLockedMacosAction: async () => assert.fail('Linux must not use lockf'),
    });

    assert.equal(code, 0);
    assert.equal(installCalls, 1);
  });

  it('prints status using injected status reader', async () => {
    const io = createIo();

    const code = await runCli(['status'], {
      ...io,
      readStatus: async () => ({
        currentAccount: 'acct_1',
        currentAccountName: 'a@example.com',
        accounts: [{
          id: 'acct_1',
          name: 'a@example.com',
          status: 'active',
          quota: { unified5h: 0.76, unified7d: 0.4 },
          usage: { totalRequests: 1 },
        }],
        events: [],
      }),
    });

    assert.equal(code, 0);
    assert.match(io.output(), /a@example\.com\s+active/);
    assert.match(io.output(), /5h ███████░░░  76%/);
  });

  it('prints a useful refresh-usage warning when an account is in credential cooldown', async () => {
    const io = createIo();

    const code = await runCli(['refresh-usage'], {
      ...io,
      postJson: async (path, body) => {
        assert.equal(path, '/internal/refresh-usage');
        assert.deepEqual(body, {});
        return {
          ok: false,
          accounts: [{
            account: 'acct_1',
            ok: false,
            skipped: 'credential-refresh-cooldown',
          }],
        };
      },
    });

    assert.equal(code, 1);
    assert.match(io.output(), /credential refresh cooldown is active/);
    assert.doesNotMatch(io.output(), /undefined/);
  });

  it('prints prepare-resume JSON using the internal API', async () => {
    const io = createIo();

    const code = await runCli(['prepare-resume', '--json'], {
      ...io,
      postJson: async (path, body) => {
        assert.equal(path, '/internal/prepare-resume');
        assert.deepEqual(body, { refreshUsage: false });
        return {
          ok: true,
          action: 'wait',
          account: 'dev',
          resumeAtEpoch: 1780614000,
        };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(io.output()), {
      ok: true,
      action: 'wait',
      account: 'dev',
      resumeAtEpoch: 1780614000,
    });
  });

  it('imports current Claude Code credentials through injected reader', async () => {
    const io = createIo();
    const imported = [];
    let reloaded = false;

    const code = await runCli(['import-current', '--id', 'acct_1', '--name', 'a@example.com'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => ({ email: 'a@example.com', accountUuid: 'uuid-1' }),
      saveImportedAccount: async account => imported.push(account),
      reloadServer: async () => { reloaded = true; },
    });

    assert.equal(code, 0);
    assert.deepEqual(imported, [{
      id: 'acct_1',
      name: 'a@example.com',
      accountUuid: 'uuid-1',
      secret: { accessToken: 'access', refreshToken: 'refresh' },
    }]);
    assert.equal(reloaded, true);
    assert.match(io.output(), /Imported a@example\.com/);
  });

  it('uses current Claude Code login when login is called without token JSON', async () => {
    const io = createIo();
    const imported = [];

    const code = await runCli(['login'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      saveImportedAccount: async account => imported.push(account),
      reloadServer: async () => {},
    });

    assert.equal(code, 0);
    assert.deepEqual(imported, [{
      id: 'person-example-com',
      name: 'person@example.com',
      accountUuid: 'uuid-1',
      secret: { accessToken: 'access', refreshToken: 'refresh' },
    }]);
    assert.match(io.output(), /Imported person@example\.com/);
  });

  it('refuses to import current login when no refresh token is available', async () => {
    const io = createIo();
    const imported = [];

    const code = await runCli(['login'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: null }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      saveImportedAccount: async account => imported.push(account),
      reloadServer: async () => {},
    });

    assert.equal(code, 1);
    assert.deepEqual(imported, []);
    assert.match(
      io.output(),
      /Run claude auth login --claudeai, then retry claude-rotator login\./,
    );
  });

  it('refuses to create a fallback account when current login cannot be verified', async () => {
    const io = createIo();
    const imported = [];

    const code = await runCli(['login'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => {
        throw new Error('Profile fetch failed (401): invalid credentials');
      },
      loadConfig: async () => ({ accounts: [] }),
      saveImportedAccount: async account => imported.push(account),
      reloadServer: async () => {},
    });

    assert.equal(code, 1);
    assert.deepEqual(imported, []);
    assert.doesNotMatch(io.output(), /Imported account1/);
    assert.match(
      io.output(),
      /Could not verify the current Claude Code login\. Run claude auth login --claudeai and retry,/,
    );
  });

  it('configures live current Claude Code login without storing a token snapshot', async () => {
    const io = createIo();
    let savedConfig = null;
    let reloaded = false;

    const code = await runCli(['use-current', '--only'], {
      ...io,
      isGatewayAuthConfigured: async () => false,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      loadConfig: async () => ({
        accounts: [{ id: 'stale-account', name: 'old@example.com', type: 'oauth' }],
      }),
      saveConfig: async config => { savedConfig = config; },
      reloadServer: async () => { reloaded = true; },
    });

    assert.equal(code, 0);
    assert.deepEqual(savedConfig.accounts, [{
      id: 'current',
      name: 'person@example.com',
      type: 'oauth',
      credentialSource: 'claude-code-current',
    }]);
    assert.equal(reloaded, true);
    assert.match(io.output(), /Using live Claude Code login as person@example\.com/);
  });

  it('refuses to add live current when it duplicates a saved account', async () => {
    const io = createIo();
    let savedConfig = null;

    const code = await runCli(['use-current'], {
      ...io,
      isGatewayAuthConfigured: async () => false,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      loadConfig: async () => ({
        accounts: [{ id: 'person-example-com', name: 'person@example.com', type: 'oauth', accountUuid: 'uuid-1' }],
      }),
      saveConfig: async config => { savedConfig = config; },
      reloadServer: async () => {},
    });

    assert.equal(code, 1);
    assert.equal(savedConfig, null);
    assert.match(io.output(), /already registered as person-example-com/);
    assert.match(io.output(), /use-current --only/);
  });

  it('rejects use-current while local gateway authentication is configured', async () => {
    const io = createIo();
    let credentialsRead = false;

    const code = await runCli(['use-current', '--only'], {
      ...io,
      isGatewayAuthConfigured: async () => true,
      readCurrentCredentials: async () => {
        credentialsRead = true;
        return { accessToken: 'access', refreshToken: 'refresh' };
      },
    });

    assert.equal(code, 1);
    assert.equal(credentialsRead, false);
    assert.match(io.output(), /incompatible with installed gateway authentication/);
    assert.match(io.output(), /claude-rotator login/);
  });

  it('updates an existing account when login sees the same accountUuid without an explicit id', async () => {
    const io = createIo();
    let savedConfig = null;
    const stored = [];

    const code = await runCli(['login'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh' }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      loadConfig: async () => ({
        accounts: [{ id: 'custom-person', name: 'old@example.com', type: 'oauth', accountUuid: 'uuid-1' }],
      }),
      saveConfig: async config => { savedConfig = config; },
      secretStore: {
        get: async () => null,
        replaceLinkedCredential: async (id, secret) => { stored.push({ id, secret }); },
      },
      reloadServer: async () => {},
    });

    assert.equal(code, 0);
    assert.deepEqual(stored, [{ id: 'custom-person', secret: { accessToken: 'new-access', refreshToken: 'new-refresh' } }]);
    assert.deepEqual(savedConfig.accounts.map(({ credentialRevision, ...account }) => account), [{
      id: 'custom-person',
      name: 'person@example.com',
      type: 'oauth',
      accountUuid: 'uuid-1',
    }]);
    assert.match(savedConfig.accounts[0].credentialRevision, /^[0-9a-f-]{36}$/);
    assert.match(io.output(), /Imported person@example\.com/);
  });

  it('relinks a parked account only with a new refresh token and changes its revision', async () => {
    const original = {
      accessToken: 'relink-old-access-fixture',
      refreshToken: 'relink-old-refresh-fixture',
      expiresAt: 1,
    };
    const store = new MemorySecretStore();
    await store.set('acct_1', original);
    await assert.rejects(
      () => store.refreshIfUnchanged('acct_1', original, async (_current, transaction) => {
        await transaction.beforeHandoff();
        throw Object.assign(new Error('ambiguous relink fixture'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    const originalConfig = {
      accounts: [{
        id: 'acct_1',
        name: 'person@example.com',
        type: 'oauth',
        accountUuid: 'uuid-1',
        credentialRevision: 'revision-before-relink',
      }],
    };
    let credential = { ...original, accessToken: 'same-token-rewrite-fixture' };
    let savedConfig = null;
    const dependencies = () => ({
      readCurrentCredentials: async () => credential,
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      loadConfig: async () => structuredClone(originalConfig),
      saveConfig: async config => { savedConfig = config; },
      secretStore: store,
      reloadServer: async () => {},
    });

    const rejectedIo = createIo();
    assert.equal(await runCli(['login'], { ...rejectedIo, ...dependencies() }), 1);
    assert.equal(savedConfig, null);
    await assert.rejects(
      () => store.getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    credential = {
      accessToken: 'relink-new-access-fixture',
      refreshToken: 'relink-new-refresh-fixture',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    const acceptedIo = createIo();
    assert.equal(await runCli(['login'], { ...acceptedIo, ...dependencies() }), 0);

    assert.deepEqual(await store.getOperational('acct_1'), credential);
    assert.notEqual(savedConfig.accounts[0].credentialRevision, 'revision-before-relink');
    assert.match(savedConfig.accounts[0].credentialRevision, /^[0-9a-f-]{36}$/);
  });

  it('refuses an explicit account id when the accountUuid already exists', async () => {
    const io = createIo();
    let savedConfig = null;

    const code = await runCli(['login', '--id', 'second-person'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      fetchProfile: async () => ({ email: 'person@example.com', accountUuid: 'uuid-1' }),
      loadConfig: async () => ({
        accounts: [{ id: 'person-example-com', name: 'person@example.com', type: 'oauth', accountUuid: 'uuid-1' }],
      }),
      saveConfig: async config => { savedConfig = config; },
      secretStore: {
        set: async () => {},
      },
      reloadServer: async () => {},
    });

    assert.equal(code, 1);
    assert.equal(savedConfig, null);
    assert.match(io.output(), /already registered as person-example-com/);
  });

  it('reads the token JSON from stdin when --json is -, keeping it out of argv', async () => {
    const io = createIo();
    let savedConfig = null;
    const stored = [];

    const code = await runCli(
      ['login', '--id', 'acct_1', '--name', 'person@example.com', '--json', '-'],
      {
        ...io,
        stdin: Readable.from(['{"accessToken":"access-1","refreshToken":"refresh-1"}']),
        loadConfig: async () => ({ accounts: [] }),
        saveConfig: async config => { savedConfig = config; },
        secretStore: {
          get: async () => null,
          replaceLinkedCredential: async (id, secret) => { stored.push({ id, secret }); },
        },
        reloadServer: async () => {},
      },
    );

    assert.equal(code, 0);
    assert.deepEqual(stored, [{ id: 'acct_1', secret: { accessToken: 'access-1', refreshToken: 'refresh-1' } }]);
    assert.equal(savedConfig.accounts[0].id, 'acct_1');
    assert.match(io.output(), /Added person@example\.com/);
  });

  it('publishes a new login config while the credential-set transaction is held', async () => {
    const io = createIo();
    let transactionHeld = false;
    let configSaved = false;
    let reloadObserved = false;
    const code = await runCli(
      ['login', '--id', 'acct_2', '--name', 'person@example.com', '--json', '-'],
      {
        ...io,
        stdin: Readable.from(['{"accessToken":"atomic-access","refreshToken":"atomic-refresh"}']),
        loadConfig: async () => ({ accounts: [] }),
        saveConfig: async config => {
          assert.equal(transactionHeld, true);
          assert.equal(config.accounts[0].id, 'acct_2');
          configSaved = true;
        },
        secretStore: {
          get: async () => null,
          replaceLinkedCredential: async () => assert.fail('atomic publish API must be used'),
          replaceLinkedCredentialAndRun: async (_id, _secret, afterWrite) => {
            transactionHeld = true;
            await afterWrite();
            transactionHeld = false;
          },
        },
        reloadServer: async () => {
          assert.equal(transactionHeld, false);
          assert.equal(configSaved, true);
          reloadObserved = true;
        },
      },
    );

    assert.equal(code, 0);
    assert.equal(reloadObserved, true);
  });

  it('login --json shows the safe stdin form first, with literal-JSON exposure risk noted', async () => {
    const io = createIo();

    // Missing --id triggers loginJsonCommand's own argument-check Usage error
    // (dispatcher already requires --json to have a value to reach this code path).
    const code = await runCli(['login', '--json', '-'], { ...io });

    assert.equal(code, 1);
    const output = io.output();
    const safeIndex = output.indexOf('--json -');
    const literalIndex = output.indexOf('--json <token-json>');
    assert.ok(safeIndex >= 0, 'expected the stdin form "--json -" in the Usage message');
    assert.ok(literalIndex >= 0, 'expected the literal form "--json <token-json>" in the Usage message');
    assert.ok(safeIndex < literalIndex, 'expected "--json -" to appear before "--json <token-json>"');
    assert.match(
      output,
      /(process listing|ps output|shell history)/,
      'expected the literal form to be annotated with a process listing / shell history exposure warning',
    );
  });

  it('refuses login --json - immediately when stdin is a terminal, instead of hanging', async () => {
    const io = createIo();

    const code = await runCli(
      ['login', '--id', 'acct_1', '--name', 'person@example.com', '--json', '-'],
      {
        ...io,
        stdin: { isTTY: true },
      },
    );

    assert.equal(code, 1);
    assert.match(io.output(), /stdin is a terminal/);
  });

  it('refuses login --json - when stdin has no token JSON', async () => {
    const io = createIo();

    const code = await runCli(
      ['login', '--id', 'acct_1', '--name', 'person@example.com', '--json', '-'],
      {
        ...io,
        stdin: Readable.from([]),
      },
    );

    assert.equal(code, 1);
    assert.match(io.output(), /received no token JSON on stdin/);
  });

  it('does not leak the token JSON in the parse error message', async () => {
    const io = createIo();

    const code = await runCli(
      ['login', '--id', 'acct_1', '--name', 'person@example.com', '--json', '-'],
      {
        ...io,
        stdin: Readable.from(['sk-ant-oat01-SECRET']),
      },
    );

    assert.equal(code, 1);
    assert.doesNotMatch(io.output(), /sk-ant/);
    assert.match(io.output(), /Could not parse the token JSON/);
  });

  it('still accepts a literal token JSON via --json for backward compatibility', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    let savedConfig = null;

    const code = await runCli(
      [
        'login', '--id', 'acct_1', '--name', 'person@example.com',
        '--json', '{"accessToken":"access-1","refreshToken":"refresh-1"}',
      ],
      {
        ...io,
        loadConfig: async () => ({ accounts: [] }),
        saveConfig: async config => { savedConfig = config; },
        secretStore,
        reloadServer: async () => {},
      },
    );

    assert.equal(code, 0);
    assert.deepEqual(await secretStore.get('acct_1'), { accessToken: 'access-1', refreshToken: 'refresh-1' });
    assert.equal(savedConfig.accounts[0].id, 'acct_1');
    assert.match(io.output(), /Added person@example\.com/);
  });

  it('removes an account and its stored secret by default', async () => {
    const io = createIo();
    let savedConfig = null;
    const deleted = [];
    let reloaded = false;

    const code = await runCli(['remove', 'acct_1'], {
      ...io,
      loadConfig: async () => ({
        accounts: [
          { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
          { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        ],
      }),
      saveConfig: async config => { savedConfig = config; },
      deleteSecret: async id => { deleted.push(id); },
      reloadServer: async () => { reloaded = true; },
    });

    assert.equal(code, 0);
    assert.deepEqual(savedConfig.accounts, [
      { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
    ]);
    assert.deepEqual(deleted, ['acct_1']);
    assert.equal(reloaded, true);
    assert.match(io.output(), /Removed acct_1/);
  });

  it('prints doctor warnings for duplicate and stale account credentials', async () => {
    const io = createIo();
    const secretStore = {
      get: async id => {
        if (id === 'bad') return { accessToken: 'bad-token' };
        return { accessToken: 'stored-token' };
      },
    };

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      readCurrentCredentials: async () => ({ accessToken: 'live-token' }),
      loadConfig: async () => ({
        accounts: [
          { id: 'current', name: 'old@example.com', type: 'oauth', accountUuid: 'uuid-old' },
          { id: 'duplicate', name: 'dup@example.com', type: 'oauth', accountUuid: 'uuid-old' },
          { id: 'bad', name: 'bad@example.com', type: 'oauth', accountUuid: 'uuid-bad' },
        ],
      }),
      secretStore,
      fetchProfile: async token => {
        if (token === 'bad-token') throw new Error('Profile fetch failed (401): invalid credentials');
        return { email: 'live@example.com', accountUuid: 'uuid-live' };
      },
    });

    assert.equal(code, 0);
    assert.match(io.output(), /server: ok/);
    assert.match(io.output(), /warning: duplicate accountUuid for current, duplicate/);
    assert.match(io.output(), /warning: current: config name old@example\.com differs from live login live@example\.com/);
    assert.match(io.output(), /warning: current: static accountUuid is obsolete; run claude-rotator remove current first, then claude auth login --claudeai and claude-rotator login/);
    assert.match(io.output(), /warning: bad: credential profile check failed: Profile fetch failed \(401\)/);
    assert.match(io.output(), /warning: live duplicate accountUuid for current, duplicate/);
  });

  it('refreshes expired stored credentials before doctor profile checks', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: 1000,
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: 9999999999999,
    });

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [
          { id: 'acct_1', name: 'person@example.com', type: 'oauth', accountUuid: 'uuid-1' },
        ],
      }),
      secretStore,
      refreshAccessToken: async (refreshToken, context) => {
        assert.equal(refreshToken, 'refresh-token');
        assert.equal(context.accessToken, 'expired-token');
        assert.equal(context.refreshToken, 'refresh-token');
        assert.equal(context.expiresAt, 1000);
        assert.deepEqual(context.scopes, ['user:profile', 'user:inference']);
        assert.equal(context.refreshTokenExpiresAt, 9999999999999);
        assert.equal(context.accountId, 'acct_1');
        return {
          accessToken: 'fresh-token',
          refreshToken,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      fetchProfile: async token => {
        assert.equal(token, 'fresh-token');
        return { email: 'person@example.com', accountUuid: 'uuid-1' };
      },
    });

    assert.equal(code, 0);
    assert.match(io.output(), /accounts: ok/);
    assert.equal((await secretStore.get('acct_1')).accessToken, 'fresh-token');
  });

  it('does not hand off duplicate refresh tokens during doctor checks', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    for (const accountId of ['acct_1', 'acct_2']) {
      await secretStore.set(accountId, {
        accessToken: `doctor-duplicate-access-${accountId}`,
        refreshToken: 'doctor-duplicate-refresh',
        expiresAt: 1,
      });
    }
    let handoffs = 0;
    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [
          { id: 'acct_1', name: 'one@example.com', type: 'oauth' },
          { id: 'acct_2', name: 'two@example.com', type: 'oauth' },
        ],
      }),
      secretStore,
      refreshAccessToken: async (_refreshToken, context) => {
        await context.beforeHandoff();
        handoffs += 1;
        return assert.fail('duplicate refresh token must not reach provider handoff');
      },
      fetchProfile: async () => assert.fail('duplicate credential must not fetch profile'),
    });

    assert.equal(code, 0);
    assert.equal(handoffs, 0);
    assert.match(io.output(), /refresh token is linked to multiple accounts/);
    assert.doesNotMatch(io.output(), /doctor-duplicate-refresh/);
  });

  it('parks two consecutive doctor runs after one ambiguous handoff', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-doctor-access-fixture',
      refreshToken: 'doctor-refresh-fixture',
      expiresAt: 1,
    });
    let refreshCalls = 0;
    const deps = {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [{
          id: 'acct_1',
          name: 'person@example.com',
          type: 'oauth',
          credentialRevision: 'rev-1',
        }],
      }),
      secretStore,
      refreshAccessToken: async (_refreshToken, context) => {
        refreshCalls += 1;
        await context.beforeHandoff();
        throw Object.assign(new Error('ambiguous doctor handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
      fetchProfile: async () => assert.fail('doctor profile fetch must not run while parked'),
    };

    assert.equal(await runCli(['doctor'], deps), 0);
    assert.equal(await runCli(['doctor'], deps), 0);

    assert.equal(refreshCalls, 1);
    assert.match(io.output(), /credential profile check failed/);
    assert.doesNotMatch(io.output(), /doctor-refresh-fixture/);
  });

  it('retracts a doctor refresh intent when the native child never starts', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresAt: 1,
    });
    let refreshCalls = 0;
    const deps = {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [{ id: 'acct_1', name: 'person@example.com', type: 'oauth' }],
      }),
      secretStore,
      refreshAccessToken: async (_refreshToken, context) => {
        refreshCalls += 1;
        await context.beforeHandoff();
        await context.retractHandoff();
        throw Object.assign(new Error('native child did not start'), {
          code: 'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
        });
      },
      fetchProfile: async () => assert.fail('profile fetch must not run after refresh failure'),
    };

    assert.equal(await runCli(['doctor'], deps), 0);
    assert.equal(await runCli(['doctor'], deps), 0);

    assert.equal(refreshCalls, 2, 'a pre-spawn failure must remain retryable instead of parking the account');
    assert.match(io.output(), /native child did not start/);
  });

  it('leaves current Claude Code credential refresh to Claude Code', async () => {
    const io = createIo();
    let refreshCalls = 0;

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [{ id: 'current', name: 'person@example.com', type: 'oauth' }],
      }),
      readCurrentCredentials: async () => ({
        accessToken: 'expired-current-token',
        refreshToken: 'current-refresh-token',
        expiresAt: 1000,
      }),
      refreshAccessToken: async () => {
        refreshCalls += 1;
        throw new Error('current credential must not be refreshed by doctor');
      },
      fetchProfile: async () => {
        throw new Error('Profile fetch failed (401)');
      },
    });

    assert.equal(code, 0);
    assert.equal(refreshCalls, 0);
    assert.match(io.output(), /current: credential profile check failed: Profile fetch failed \(401\)/);
  });

  it('uses the newer doctor credential without refreshing when it changes before the locked re-read', async () => {
    const io = createIo();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-1',
      expiresAt: 1000,
      subscriptionType: 'pro',
    });
    const newerSecret = {
      accessToken: 'newer-token',
      refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier-2',
    };
    const refreshIfUnchanged = secretStore.refreshIfUnchanged.bind(secretStore);
    let replaceBeforeLockedRead = true;
    secretStore.refreshIfUnchanged = async (...args) => {
      if (replaceBeforeLockedRead) {
        replaceBeforeLockedRead = false;
        await secretStore.set('acct_1', newerSecret);
      }
      return refreshIfUnchanged(...args);
    };
    let refreshCalls = 0;

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [
          { id: 'acct_1', name: 'person@example.com', type: 'oauth', accountUuid: 'uuid-1' },
        ],
      }),
      secretStore,
      refreshAccessToken: async () => {
        refreshCalls += 1;
        return {
          accessToken: 'stale-refresh-result',
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      fetchProfile: async token => {
        assert.equal(token, 'newer-token');
        return { email: 'person@example.com', accountUuid: 'uuid-1' };
      },
    });

    assert.equal(code, 0);
    assert.deepEqual(await secretStore.get('acct_1'), newerSecret);
    assert.equal(refreshCalls, 0);
  });

  it('fails doctor refresh closed when conditional update transactions are unavailable', async () => {
    const io = createIo();
    let refreshCalls = 0;
    const secret = {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: 1000,
    };

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => ({ ok: true }),
      loadConfig: async () => ({
        accounts: [{ id: 'acct_1', name: 'person@example.com', type: 'oauth' }],
      }),
      secretStore: {
        get: async () => ({ ...secret }),
        compareAndSet: async () => assert.fail('legacy compare-and-set must not be used'),
      },
      refreshAccessToken: async () => {
        refreshCalls++;
        return { accessToken: 'must-not-be-used' };
      },
      fetchProfile: async () => ({ email: 'person@example.com' }),
    });

    assert.equal(code, 0);
    assert.equal(refreshCalls, 0);
    assert.match(io.output(), /Secret store does not support conditional update transaction/);
  });

  it('reports a doctor health-check failure as a normal CLI failure', async () => {
    const io = createIo();

    const code = await runCli(['doctor'], {
      ...io,
      readHealth: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:37891'); },
      loadConfig: async () => ({ accounts: [] }),
    });

    assert.equal(code, 1);
    assert.match(io.output(), /connect ECONNREFUSED 127\.0\.0\.1:37891/);
  });
});

describe('uninstall --purge-secrets account id targeting', () => {
  // Regression coverage for the macOS Keychain purge silently deleting nothing:
  // `uninstall --purge-secrets` must forward the configured account ids (plus
  // the "current" account) to secretStore.purge(ids), on both the darwin and
  // non-darwin code paths, instead of calling purge() with no arguments.
  const noopExecFileImpl = async (command, args) => {
    if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 });
    return { stdout: '', stderr: '' };
  };

  async function writeConfigWithAccounts(configPath) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
    }), 'utf8');
  }

  function createPurgeSpy() {
    const calls = [];
    const secretStoreFactory = () => ({
      purge: async ids => { calls.push(ids); },
    });
    return { calls, secretStoreFactory };
  }

  it('darwin: purges the configured account ids plus the current account', async () => {
    const io = createIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-darwin-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeConfigWithAccounts(configPath);
      const { calls, secretStoreFactory } = createPurgeSpy();

      const code = await runCli(['__macos-service-action', 'uninstall', '--purge-secrets'], {
        ...io,
        platform: 'darwin',
        home,
        env: {
          CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
        },
        execFileImpl: noopExecFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['acct_1', 'acct_2', 'current']);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('darwin: does not purge when --purge-secrets is omitted', async () => {
    const io = createIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-no-purge-darwin-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeConfigWithAccounts(configPath);
      const { calls, secretStoreFactory } = createPurgeSpy();

      const code = await runCli(['__macos-service-action', 'uninstall'], {
        ...io,
        platform: 'darwin',
        home,
        env: {
          CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
        },
        execFileImpl: noopExecFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.equal(calls.length, 0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('non-darwin (linux): purges the configured account ids plus the current account', async () => {
    const io = createIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-linux-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeConfigWithAccounts(configPath);
      // uninstallSettings() reads installStatePath eagerly with no ENOENT
      // fallback, so a prior "install" state must exist for the restore step
      // to no-op cleanly instead of throwing.
      await writeFile(join(xdgConfig, 'claude-rotator', 'install-state.json'), '{}', 'utf8');
      const { calls, secretStoreFactory } = createPurgeSpy();
      const service = createServiceCommandSpy();

      // removeServiceFile() (called by uninstallCommand's non-darwin branch)
      // threads the `home` passed below straight into macosLaunchAgentPath()
      // and never falls back to the real os.homedir(), so no real-HOME
      // sandboxing is needed here (see the dedicated "removeServiceFile only
      // deletes ... never under process.env.HOME" regression test below).
      const code = await runCli(['uninstall', '--purge-secrets'], {
        ...io,
        platform: 'linux',
        home,
        env: { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData },
        execFileImpl: service.execFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['acct_1', 'acct_2', 'current']);
      // The injected runner must be the one that saw the stop, which is only
      // true while uninstallCommand threads deps.execFileImpl into
      // stopService() instead of letting it default to the real execFile.
      assert.deepEqual(service.calls, LINUX_UNINSTALL_SERVICE_CALLS);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe('uninstall --purge-secrets config read failure warning', () => {
  // Regression coverage for #31: purgeTargetAccountIds() used to swallow every
  // loadConfig() error via `.catch(() => null)`, so a corrupt config.json
  // silently narrowed the macOS Keychain purge down to only the "current"
  // account while `uninstall` still reported plain success. On macOS,
  // MacOSKeychainSecretStore.purge(ids) only deletes the given ids, so other
  // accounts' Keychain secrets were left behind with no warning at all.
  const noopExecFileImpl = async (command, args) => {
    if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 });
    return { stdout: '', stderr: '' };
  };

  function createSplitIo() {
    let stdout = '';
    let stderr = '';
    return {
      write: chunk => { stdout += chunk; },
      error: chunk => { stderr += chunk; },
      stdout: () => stdout,
      stderr: () => stderr,
    };
  }

  function createPurgeSpy() {
    const calls = [];
    const secretStoreFactory = () => ({
      purge: async ids => { calls.push(ids); },
    });
    return { calls, secretStoreFactory };
  }

  async function writeBrokenConfig(configPath) {
    await mkdir(dirname(configPath), { recursive: true });
    // Deliberately invalid JSON (not a secret) so loadConfig() throws a
    // SyntaxError instead of returning null the way a merely-missing file
    // (ENOENT) does.
    await writeFile(configPath, '{ this is not valid json', 'utf8');
  }

  it('darwin: uninstall --purge-secrets warns on stderr and still purges "current" when config read fails', async () => {
    const io = createSplitIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-warn-darwin-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeBrokenConfig(configPath);
      const { calls, secretStoreFactory } = createPurgeSpy();

      const code = await runCli(['__macos-service-action', 'uninstall', '--purge-secrets'], {
        write: io.write,
        error: io.error,
        platform: 'darwin',
        home,
        env: {
          CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
        },
        execFileImpl: noopExecFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.match(io.stdout(), /Uninstalled claude-rotator/);
      const stderrLines = io.stderr().split('\n').filter(Boolean);
      assert.equal(stderrLines.length, 1, `expected exactly one stderr warning line, got: ${io.stderr()}`);
      assert.match(io.stderr(), /warning:.*purg/i);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['current']);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('darwin: uninstall --purge-secrets does not warn when config is simply absent (ENOENT)', async () => {
    const io = createSplitIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-enoent-darwin-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      // No config.json is written at all: loadConfig() must treat this as
      // "never installed" (existing behaviour) and stay silent.
      const { calls, secretStoreFactory } = createPurgeSpy();

      const code = await runCli(['__macos-service-action', 'uninstall', '--purge-secrets'], {
        write: io.write,
        error: io.error,
        platform: 'darwin',
        home,
        env: {
          CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
        },
        execFileImpl: noopExecFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.match(io.stdout(), /Uninstalled claude-rotator/);
      assert.equal(io.stderr(), '');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['current']);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('linux: uninstall --purge-secrets never warns about "current"-only deletion, even when config read fails', async () => {
    const io = createSplitIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-warn-linux-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeBrokenConfig(configPath);
      // uninstallSettings() reads installStatePath eagerly with no ENOENT
      // fallback, so a prior "install" state must exist for the restore step
      // to no-op cleanly instead of throwing (see the darwin/linux purge
      // tests above for the same setup).
      await writeFile(join(xdgConfig, 'claude-rotator', 'install-state.json'), '{}', 'utf8');
      const { calls, secretStoreFactory } = createPurgeSpy();
      const service = createServiceCommandSpy();

      const code = await runCli(['uninstall', '--purge-secrets'], {
        write: io.write,
        error: io.error,
        platform: 'linux',
        home,
        env: { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData },
        execFileImpl: service.execFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.match(io.stdout(), /Uninstalled claude-rotator/);
      // LinuxFileSecretStore.purge() enumerates its own secrets directory and
      // ignores the id list entirely, so a config read failure never shrinks
      // what actually gets deleted on Linux; warning here would misinform
      // the user that only "current" was removed.
      assert.equal(io.stderr(), '');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['current']);
      assert.deepEqual(service.calls, LINUX_UNINSTALL_SERVICE_CALLS);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('darwin: uninstall --purge-secrets does not claim a Keychain purge when uninstall fails before any purge runs', async () => {
    // Regression coverage for the false-completeness report: if
    // uninstallMacosLifecycle() throws before purgeSecretsImpl() ever runs
    // (e.g. Claude settings were edited after install, so uninstallSettings()
    // detects a conflict and refuses to proceed without --force), the whole
    // uninstall rolls back and the command exits 1. The config-read-failure
    // warning must not appear in that case: nothing was purged at all, so
    // "the 'current' Keychain entry was removed" would be a false claim.
    const io = createSplitIo();
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-warn-conflict-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      const settingsPath = join(home, '.claude', 'settings.json');
      const installStatePath = join(xdgConfig, 'claude-rotator', 'install-state.json');

      // A corrupt config.json is what would otherwise trigger the "config
      // read failed" warning path.
      await writeBrokenConfig(configPath);
      // Install for real, then edit the managed settings file afterwards so
      // uninstallSettings() detects the conflict and throws without --force.
      await installSettings({
        settingsPath,
        installStatePath,
        backupDir: join(xdgConfig, 'claude-rotator', 'backups'),
        proxyBaseUrl: 'http://127.0.0.1:37891',
      });
      await writeJsonFile(settingsPath, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } });
      const { calls, secretStoreFactory } = createPurgeSpy();

      const code = await runCli(['__macos-service-action', 'uninstall', '--purge-secrets'], {
        write: io.write,
        error: io.error,
        platform: 'darwin',
        home,
        env: {
          CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
        },
        execFileImpl: noopExecFileImpl,
        secretStoreFactory,
      });

      assert.equal(code, 1);
      assert.match(io.stdout(), /^$/);
      assert.match(io.stderr(), /ANTHROPIC_BASE_URL is/);
      assert.doesNotMatch(io.stderr(), /warning:.*purg/i);
      assert.equal(calls.length, 0);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('darwin: uninstall --purge-secrets warning reaches the real OS-level stderr of the re-executed process (stdio inheritance)', async () => {
    // The public `uninstall --purge-secrets` command on macOS re-execs itself
    // as a locked child process via runMacosCliActionWithLock(), which spawns
    // with `stdio: 'inherit'` so the child's real stderr fd is shared
    // directly with the parent's terminal (no Node-level piping in between).
    // This test exercises that same re-executed-process code path as a real,
    // separate OS process (not a mocked `error` callback) and captures its
    // genuine stdout/stderr file descriptors independently, to confirm the
    // warning is actually written to real process.stderr rather than only to
    // a test double.
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-uninstall-purge-warn-realproc-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      await writeBrokenConfig(configPath);

      const cliPath = resolve('src/cli.js');
      const scriptPath = join(sandbox, 'run-hidden-uninstall.mjs');
      await writeFile(scriptPath, `
        import { runCli } from ${JSON.stringify(cliPath)};

        const noopExecFileImpl = async (command, args) => {
          if (args[0] === 'print') throw Object.assign(new Error('not found'), { code: 113 });
          return { stdout: '', stderr: '' };
        };

        const code = await runCli(['__macos-service-action', 'uninstall', '--purge-secrets'], {
          platform: 'darwin',
          home: ${JSON.stringify(home)},
          env: {
            CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1',
            XDG_CONFIG_HOME: ${JSON.stringify(xdgConfig)},
            XDG_DATA_HOME: ${JSON.stringify(xdgData)},
          },
          execFileImpl: noopExecFileImpl,
          secretStoreFactory: () => ({ purge: async () => {} }),
        });
        process.exitCode = code;
      `, 'utf8');

      const result = await runNodeScript(scriptPath);

      assert.equal(result.code, 0, `stderr: ${result.stderr}`);
      assert.match(result.stdout, /Uninstalled claude-rotator/);
      assert.match(result.stderr, /warning:.*purg/i);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function runNodeScript(scriptPath) {
  return new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', code => {
      resolveDone({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

describe('runMacosCliActionWithLock', () => {
  it('prepares the lock and re-execs the CLI through absolute lockf', async () => {
    const calls = [];
    const child = new EventEmitter();
    const result = runMacosCliActionWithLock({
      argv: ['uninstall', '--force'],
      lockPath: '/Users/alice/.config/claude-rotator/macos-service.lock',
      nodePath: '/usr/local/bin/node',
      cliPath: '/app/bin/claude-rotator.js',
      env: { PATH: '/usr/bin:/bin' },
      prepareLockImpl: async options => calls.push(['prepare', options]),
      spawnImpl: (command, args, options) => {
        calls.push(['spawn', command, args, options]);
        queueMicrotask(() => child.emit('exit', 0, null));
        return child;
      },
    });

    assert.equal(await result, 0);
    assert.deepEqual(calls[0], ['prepare', {
      lockPath: '/Users/alice/.config/claude-rotator/macos-service.lock',
    }]);
    assert.deepEqual(calls[1][0], 'spawn');
    assert.equal(calls[1][1], '/usr/bin/lockf');
    assert.deepEqual(calls[1][2], [
      '-k',
      '/Users/alice/.config/claude-rotator/macos-service.lock',
      '/usr/local/bin/node',
      '/app/bin/claude-rotator.js',
      '__macos-service-action',
      'uninstall',
      '--force',
    ]);
    assert.equal(calls[1][3].env.CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED, '1');
    assert.equal(calls[1][3].stdio, 'inherit');
  });
});

describe('startService', () => {
  it('enables and restarts an existing Linux service after daemon reload', async () => {
    const calls = [];

    await startService({
      platform: 'linux',
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
      },
    });

    assert.deepEqual(calls, [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', 'claude-rotator.service']],
      ['systemctl', ['--user', 'restart', 'claude-rotator.service']],
    ]);
  });

  it('requires the shared lock for macOS service changes', async () => {
    const calls = [];

    await assert.rejects(startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
      },
    }), /shared lock/);

    assert.deepEqual(calls, []);
  });

  it('uses the verified macOS service reconciler while locked', async () => {
    const calls = [];
    let registered = false;

    await startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      definitionChanged: true,
      env: { CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1' },
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
        assert.equal(cmd, '/bin/launchctl');
        if (args[0] === 'print' && !registered) {
          throw Object.assign(new Error('not found'), { code: 113 });
        }
        if (args[0] === 'bootstrap') registered = true;
      },
    });

    assert.deepEqual(calls, [
      ['/bin/launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['/bin/launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['/bin/launchctl', ['print', 'gui/501/io.github.claude-rotator']],
    ]);
  });
});

describe('installServiceFile / removeServiceFile XDG wiring (regression)', () => {
  // Guards against reverting src/cli.js's env/home threading while leaving
  // install.js's XDG-aware renderers untouched: without the wiring, this
  // test fails even though renderSystemdUserService/renderLaunchAgentPlist
  // unit tests (test/install.test.js) still pass on their own.
  //
  // installServiceFile/removeServiceFile branch on the REAL process.platform
  // and fall back to the REAL home directory, which would touch this
  // machine's actual ~/Library/LaunchAgents and ~/.config files if left
  // unguarded. Every call below runs with process.platform and process.env.HOME
  // temporarily overridden to an isolated sandbox, restored in a finally block.
  async function withSandboxedHomeAndPlatform(platform, home, fn) {
    const originalPlatform = process.platform;
    const originalHome = process.env.HOME;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    process.env.HOME = home;
    try {
      await fn();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  }

  it('embeds XDG_CONFIG_HOME/XDG_DATA_HOME into the systemd unit written by installServiceFile', async () => {
    const { installServiceFile } = await import('../src/cli.js');
    assert.equal(typeof installServiceFile, 'function', 'installServiceFile must be exported for this wiring test');

    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-xdg-install-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      const claudePath = join(sandbox, 'bin', 'claude');
      const env = { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData };

      await withSandboxedHomeAndPlatform('linux', home, async () => {
        await installServiceFile({ configPath, claudePath, env, home });
      });

      const unitPath = join(xdgConfig, 'systemd', 'user', 'claude-rotator.service');
      const unit = await readFile(unitPath, 'utf8');
      assert.ok(
        unit.includes(`Environment=XDG_CONFIG_HOME=${xdgConfig}`),
        'systemd unit must embed XDG_CONFIG_HOME from the install-time environment',
      );
      assert.ok(
        unit.includes(`Environment=XDG_DATA_HOME=${xdgData}`),
        'systemd unit must embed XDG_DATA_HOME from the install-time environment',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('removes a legacy ~/.config/systemd/user unit left behind when XDG_CONFIG_HOME differs', async () => {
    const { removeServiceFile } = await import('../src/cli.js');
    assert.equal(typeof removeServiceFile, 'function', 'removeServiceFile must be exported for this wiring test');

    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-xdg-uninstall-'));
    try {
      const home = join(sandbox, 'home');
      const xdgConfig = join(sandbox, 'xdg-config');
      const xdgData = join(sandbox, 'xdg-data');
      const configPath = join(xdgConfig, 'claude-rotator', 'config.json');
      const env = { XDG_CONFIG_HOME: xdgConfig, XDG_DATA_HOME: xdgData };

      const legacyUnitPath = join(home, '.config', 'systemd', 'user', 'claude-rotator.service');
      const xdgUnitPath = join(xdgConfig, 'systemd', 'user', 'claude-rotator.service');
      await mkdir(dirname(legacyUnitPath), { recursive: true });
      await writeFile(legacyUnitPath, 'legacy unit from a pre-XDG install', 'utf8');
      await mkdir(dirname(xdgUnitPath), { recursive: true });
      await writeFile(xdgUnitPath, 'current XDG-scoped unit', 'utf8');

      await withSandboxedHomeAndPlatform('linux', home, async () => {
        await removeServiceFile({ configPath, env, home });
      });

      await assert.rejects(
        stat(legacyUnitPath),
        { code: 'ENOENT' },
        'the legacy unit at the pre-XDG default path must be removed on uninstall',
      );
      await assert.rejects(stat(xdgUnitPath), { code: 'ENOENT' });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  // Regression for a real incident: removeServiceFile/installServiceFile used
  // to build the macOS LaunchAgent path via macosLaunchAgentPath(label) with
  // NO `home` argument, so it silently fell back to the real homedir() even
  // when the caller passed an explicit `home`. Because homedir() itself
  // resolves through process.env.HOME on POSIX, we must never let the
  // function's explicit `home` argument collide with process.env.HOME in
  // this test, or a still-buggy implementation would coincidentally target
  // the same directory and the regression would go undetected.
  //
  // So `process.env.HOME` is pointed at a "decoy" temp directory (standing
  // in for what would be the real home) that is DIFFERENT from the `home`
  // argument explicitly passed to the function under test. A fixed
  // implementation only ever touches the explicit `home` argument's
  // directory; a buggy one reaches for the decoy via the overridden
  // homedir(). Neither directory is the real $HOME.
  it('removeServiceFile only deletes the LaunchAgent plist under the explicit home, never under process.env.HOME', async () => {
    const { removeServiceFile } = await import('../src/cli.js');

    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-launchagent-remove-'));
    try {
      const decoyHome = join(sandbox, 'decoy-home'); // stands in for the real $HOME
      const explicitHome = join(sandbox, 'explicit-home'); // the `home` passed to removeServiceFile
      const configPath = join(explicitHome, '.config', 'claude-rotator', 'config.json');

      const decoyPlistPath = join(decoyHome, 'Library', 'LaunchAgents', 'io.github.claude-rotator.plist');
      const explicitPlistPath = join(explicitHome, 'Library', 'LaunchAgents', 'io.github.claude-rotator.plist');
      await mkdir(dirname(decoyPlistPath), { recursive: true });
      await writeFile(decoyPlistPath, 'decoy plist: must survive', 'utf8');
      await mkdir(dirname(explicitPlistPath), { recursive: true });
      await writeFile(explicitPlistPath, 'explicit-home plist: must be removed', 'utf8');

      await withSandboxedHomeAndPlatform('darwin', decoyHome, async () => {
        await removeServiceFile({ configPath, env: {}, home: explicitHome });
      });

      await assert.rejects(
        stat(explicitPlistPath),
        { code: 'ENOENT' },
        'removeServiceFile must delete the LaunchAgent plist under the explicit home it was given',
      );
      await assert.equal(
        await readFile(decoyPlistPath, 'utf8'),
        'decoy plist: must survive',
        'removeServiceFile must NOT touch a LaunchAgent plist reachable only via process.env.HOME/homedir()',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('installServiceFile only writes the LaunchAgent plist under the explicit home, never under process.env.HOME', async () => {
    const { installServiceFile } = await import('../src/cli.js');

    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-launchagent-install-'));
    try {
      const decoyHome = join(sandbox, 'decoy-home'); // stands in for the real $HOME
      const explicitHome = join(sandbox, 'explicit-home'); // the `home` passed to installServiceFile
      const configPath = join(explicitHome, '.config', 'claude-rotator', 'config.json');

      const decoyPlistPath = join(decoyHome, 'Library', 'LaunchAgents', 'io.github.claude-rotator.plist');
      const explicitPlistPath = join(explicitHome, 'Library', 'LaunchAgents', 'io.github.claude-rotator.plist');

      await withSandboxedHomeAndPlatform('darwin', decoyHome, async () => {
        await installServiceFile({ configPath, env: {}, home: explicitHome });
      });

      const written = await readFile(explicitPlistPath, 'utf8');
      assert.ok(
        written.includes('io.github.claude-rotator'),
        'installServiceFile must write the LaunchAgent plist under the explicit home it was given',
      );
      await assert.rejects(
        stat(decoyPlistPath),
        { code: 'ENOENT' },
        'installServiceFile must NOT write a LaunchAgent plist reachable only via process.env.HOME/homedir()',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

function createIo() {
  let text = '';
  return {
    write: chunk => { text += chunk; },
    error: chunk => { text += chunk; },
    output: () => text,
  };
}

import { renderStatus } from '../src/monitor.js';
import { fetchCodexHealth } from '../src/cli.js';

// `claude-rotator status` grows a Codex section (design doc section 9.6). The
// fetch lives in the CLI only: proxy-server never talks to codex-rotator, and a
// missing, slow or malformed codex-rotator may only cost this one block.
describe('codex status section (CLI)', () => {
  const claudeStatus = {
    currentAccount: 'acct_1',
    currentAccountName: 'a@example.com',
    accounts: [{
      id: 'acct_1',
      name: 'a@example.com',
      status: 'active',
      quota: { unified5h: 0.76, unified7d: 0.4 },
      usage: { totalRequests: 1 },
    }],
    events: [],
  };
  const readStatus = async () => claudeStatus;

  it('OSS independence: prints the current output verbatim when no codexStatusUrl is set', async () => {
    const io = createIo();

    const code = await runCli(['status'], {
      ...io,
      readStatus,
      loadConfig: async () => ({ openaiBridge: { enabled: true, url: 'http://127.0.0.1:18765' } }),
    });

    assert.equal(code, 0);
    assert.equal(io.output(), renderStatus(claudeStatus));
    assert.doesNotMatch(io.output(), /Codex Rotator/);
  });

  it('renders the codex section from the codex-rotator health endpoint', async () => {
    const paths = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        contract: 1,
        pool: {
          state: 'available',
          accountsTotal: 1,
          accountsAvailable: 1,
          observation: { cliConsumptionVisible: false },
          accounts: [{ label: 'pro-a', state: 'available', primaryUsedPercent: 12 }],
        },
      }));
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.deepEqual(paths, ['/healthz']);
      assert.match(io.output(), /Codex Rotator\s+pool: available \(1\/1 available\)/);
      assert.match(io.output(), /pro-a\s+█░░░░░░░░░\s+12%\s+available/);
      assert.match(io.output(), /note: CLI-driven usage is not included in these numbers/);
      assert.match(io.output(), /a@example\.com\s+active/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('OSS independence: a closed codex-rotator port degrades to one line', async () => {
    const port = await unusedCodexLoopbackPort();
    const io = createIo();
    const startedAt = Date.now();

    const code = await runCli(['status'], {
      ...io,
      readStatus,
      loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`, 400),
    });

    assert.equal(code, 0);
    assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(/);
    assert.match(io.output(), /a@example\.com\s+active/);
    assert.match(io.output(), /5h ███████░░░  76%/);
    assert.ok(Date.now() - startedAt < 5000, 'status must not hang on an absent codex-rotator');
  });

  it('OSS independence: a codex-rotator that never answers is cut off at the configured deadline', async () => {
    const sockets = new Set();
    const server = http.createServer(() => {});
    server.on('connection', socket => sockets.add(socket));
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const startedAt = Date.now();

      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`, 250),
      });
      const elapsed = Date.now() - startedAt;

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(timeout 250ms\)/);
      assert.match(io.output(), /a@example\.com\s+active/);
      assert.ok(elapsed >= 200, `the deadline must be honoured, waited ${elapsed}ms`);
      assert.ok(elapsed < 5000, `status must not hang on a silent codex-rotator, waited ${elapsed}ms`);
    } finally {
      for (const socket of sockets) socket.destroy();
      await closeCodexServer(server);
    }
  });

  it('degrades to one line when the health response is not JSON', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('<html>not json</html>');
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(invalid response\)/);
      assert.doesNotMatch(io.output(), /not json/);
      assert.match(io.output(), /a@example\.com\s+active/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('degrades to one line on an error status without echoing the response body', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'secret-looking-detail' }));
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(http 500\)/);
      assert.doesNotMatch(io.output(), /secret-looking-detail/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('still draws the section when the health JSON carries only the required keys', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', contract: 99, pool: { state: 'available', accounts: [] } }));
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+pool: available$/m);
      assert.doesNotMatch(io.output(), /undefined|NaN/);
      assert.match(io.output(), /a@example\.com\s+active/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('never prints an email-like identifier returned by the health endpoint', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        contract: 1,
        pool: {
          state: 'available',
          accounts: [{
            label: 'pro-a',
            state: 'available',
            display: 'codex-account@example.invalid',
            email: 'codex-account@example.invalid',
          }],
        },
      }));
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.match(io.output(), /pro-a/);
      assert.doesNotMatch(io.output(), /example\.invalid/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('settles when codex-rotator drops the socket after sending headers', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '4096' });
      response.write('{"contract":1,"pool":{"state":"avail');
      response.socket.destroy();
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const startedAt = Date.now();

      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`, 5000),
      });
      const elapsed = Date.now() - startedAt;

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(/);
      assert.match(io.output(), /a@example\.com\s+active/);
      assert.ok(elapsed < 2000, `a dropped connection must settle at once, waited ${elapsed}ms`);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('degrades to one line when the health JSON lacks a contract-mandated key', async () => {
    const server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const code = await runCli(['status'], {
        ...io,
        readStatus,
        loadConfig: async () => codexStatusConfig(`http://127.0.0.1:${port}/healthz`),
      });

      assert.equal(code, 0);
      assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(invalid payload\)/);
      assert.match(io.output(), /a@example\.com\s+active/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('OSS independence: degradeMapping disabled means no request and no section', async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    const port = await listenOnCodexLoopback(server);

    try {
      const io = createIo();
      const config = codexStatusConfig(`http://127.0.0.1:${port}/healthz`);
      config.openaiBridge.degradeMapping.enabled = false;

      const code = await runCli(['status'], { ...io, readStatus, loadConfig: async () => config });

      assert.equal(code, 0);
      assert.equal(requests, 0);
      assert.equal(io.output(), renderStatus(claudeStatus));
      assert.doesNotMatch(io.output(), /Codex Rotator/);
    } finally {
      await closeCodexServer(server);
    }
  });

  it('never fetches a non-loopback codexStatusUrl', async () => {
    const io = createIo();

    const code = await runCli(['status'], {
      ...io,
      readStatus,
      loadConfig: async () => codexStatusConfig('http://198.51.100.7:18765/healthz'),
    });

    assert.equal(code, 0);
    assert.equal(io.output(), renderStatus(claudeStatus));
    assert.doesNotMatch(io.output(), /Codex Rotator/);
  });
});

// Opus review NEW-1: http.request() throws synchronously for a url its client
// cannot use. The fetch has to survive that without leaving a timer armed on an
// uninitialised request binding, which used to surface as an uncaught
// ReferenceError and took the whole process down instead of one status block.
describe('codex health fetch guard', () => {
  it('rejects at once and arms no late timer when the http client refuses the url', async () => {
    const startedAt = Date.now();

    await assert.rejects(fetchCodexHealth('https://127.0.0.1:9999/healthz', 30), /invalid url/);
    const elapsed = Date.now() - startedAt;
    // Outlive the deadline: a timer left armed on the failed request would fire here.
    await new Promise(resolve => setTimeout(resolve, 120));

    assert.ok(elapsed < 500, `a refused url must settle at once, waited ${elapsed}ms`);
  });

  it('never issues a request for a non-http codexStatusUrl and keeps the output verbatim', async () => {
    const io = createIo();

    const code = await runCli(['status'], {
      ...io,
      readStatus: async () => ({
        currentAccount: 'acct_1',
        currentAccountName: 'a@example.com',
        accounts: [{
          id: 'acct_1',
          name: 'a@example.com',
          status: 'active',
          quota: { unified5h: 0.76, unified7d: 0.4 },
          usage: { totalRequests: 1 },
        }],
        events: [],
      }),
      loadConfig: async () => codexStatusConfig('https://127.0.0.1:18765/healthz'),
    });

    assert.equal(code, 0);
    assert.doesNotMatch(io.output(), /Codex Rotator/);
    assert.match(io.output(), /a@example\.com\s+active/);
  });
});

function codexStatusConfig(codexStatusUrl, codexStatusTimeoutMs = 2000) {
  return {
    openaiBridge: {
      enabled: true,
      url: 'http://127.0.0.1:18765',
      degradeMapping: { enabled: true, codexStatusUrl, codexStatusTimeoutMs },
    },
  };
}

async function listenOnCodexLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeCodexServer(server) {
  await new Promise(resolve => server.close(resolve));
}

async function unusedCodexLoopbackPort() {
  const server = http.createServer(() => {});
  const port = await listenOnCodexLoopback(server);
  await closeCodexServer(server);
  return port;
}

// ---------------------------------------------------------------------------
// runtime-state の耐久書き込みと起動時の復元（R-S11 / 設計書 v1.5 §8・§8.1）
//
// `runServer` は実サーバを起動しないと呼べないので、状態の入出力だけを2つの小さな
// 関数として切り出し、ここで直接押さえる。実 Keychain・実サービスには触れない
// （一時ディレクトリと差し替えた読み取り関数だけを使う）。
// ---------------------------------------------------------------------------

describe('runtime state wiring (R-S11)', () => {
  it('writes the runtime state durably, with a private parent directory', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-runtime-state-'));
    try {
      // 親ディレクトリごと新規に作らせる。durable でない writeJsonFile は 0700 を付けない。
      const statePath = join(sandbox, 'nested', 'runtime-state.json');
      const write = createRuntimeStateWriter(statePath);

      await write({ version: 1, accounts: [] });

      assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), { version: 1, accounts: [] });
      assert.equal((await stat(statePath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(sandbox, 'nested'))).mode & 0o777, 0o700);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('restores the ledger first and hands back the accounts whose credential changed', async () => {
    const calls = [];
    const accountManager = {
      restoreState(state) {
        calls.push(state);
        return ['acct_b'];
      },
    };

    const result = await restoreRuntimeState('/tmp/does-not-matter', accountManager, {
      readJson: async () => ({ version: 1, sessionAffinity: { version: 1, entries: [] } }),
    });

    assert.equal(calls.length, 1, '台帳の復元が先（順序を逆にすると F3 を取り逃がす）');
    assert.deepEqual(result.credentialChangedAccountIds, ['acct_b']);
    assert.deepEqual(result.savedState.sessionAffinity, { version: 1, entries: [] });
  });

  it('returns an empty id list and no saved state when there is nothing to restore', async () => {
    let restored = 0;
    const accountManager = { restoreState() { restored += 1; return ['never']; } };

    const result = await restoreRuntimeState('/tmp/does-not-matter', accountManager, {
      readJson: async () => null,
    });

    assert.equal(restored, 0);
    assert.equal(result.savedState, null);
    assert.deepEqual(result.credentialChangedAccountIds, []);
  });

  it('reports an unreadable state file and still starts with an empty restore', async () => {
    const skipped = [];
    const accountManager = { restoreState() { return ['never']; } };

    const result = await restoreRuntimeState('/tmp/does-not-matter', accountManager, {
      readJson: async () => { throw new Error('permission denied'); },
      onSkipped: message => skipped.push(message),
    });

    assert.deepEqual(skipped, ['permission denied']);
    assert.equal(result.savedState, null);
    assert.deepEqual(result.credentialChangedAccountIds, []);
  });
});

// ---------------------------------------------------------------------------
// FU-99: `runServer` 自身の結線（設計書 v1.5 §8・§8.1・§5.2(b) ／ D-56-5・D-60-3・D-182）
//
// 切り出した `createRuntimeStateWriter` ／ `restoreRuntimeState` と `createProxyServer`
// 側は上の R-S11 で個別に押さえてあるが、**それらを runServer が実際に繋いでいるか**は
// 自動テストの外にあった（FU-99）。`runServer` は export されていないので、
// `bin/claude-rotator.js server` を子プロセスとして起動し、外から見える形で3点を押さえる。
//
//   ① `stateWriter: createRuntimeStateWriter(statePath)`（＝`writeJsonFileDurable`）:
//      `runtime-state.json` が `runtimeStatePath()` の位置へ書かれ、**そのとき新規に
//      作られた親ディレクトリが 0700**・ファイルが 0600 であること。`writeJsonFile` へ
//      戻す回帰（D-56-5 の逆行）は `mkdir` に mode を渡さないので親ディレクトリに
//      0700 が付かない（既定の 0777 & ~umask のまま）。
//   ② `restoreRuntimeState` の戻り値2つが `createProxyServer` へ渡ること:
//      保存された2件のうち、資格情報が別物になった口座（`credentialRevision` が config と
//      食い違う `acct_a`）のバインドだけが落ち、もう1件が残る。`savedState` が渡らなければ
//      0件、`credentialChangedAccountIds` が渡らなければ2件になるので、**片方だけの結線では
//      この 1件 にならない**。
//   ③ `eventHistory` が mode に連動すること（`src/cli.js` の AccountManager 構築時・D-182）:
//      `createProxyServer` 側の `setEventHistoryEnabled` は復元より**後**に走るため、構築時に
//      渡し忘れると `mode:"on"` でも `events` が1件も復元されない。`mode` 未記載（off）では
//      逆に復元されないことも確かめる（負の対照）。
//
// 隔離: 実サービスへ到達する経路は `server` コマンドには無い（`install` ／ `uninstall`
// だけ）。それでも guard のシムを載せた PATH のまま起動し、guard ログが増えないことを
// 確かめる。`HOME` ／ `XDG_*` ／ `CLAUDE_CONFIG_DIR` ／ `CLAUDE_ROTATOR_CONFIG` はすべて
// 一時ディレクトリへ向け、実 Keychain（口座は `type:'apikey'` なので読み出し経路へ入らない）・
// `~/.config/claude-rotator/`・本番 rotator（37891）には触れない。口座は合成ラベルと
// `*@example.com`、セッション鍵は合成の12桁ハッシュだけを使う。
// ---------------------------------------------------------------------------

const FU99_CONFIG_ACCOUNTS = Object.freeze([
  // `type:'apikey'` にして資格情報の読み出し（macOS では Keychain）経路へ入れない。
  { id: 'acct_a', name: 'acct_a@example.com', type: 'apikey', credentialRevision: 'rev-a-2' },
  { id: 'acct_b', name: 'acct_b@example.com', type: 'apikey', credentialRevision: 'rev-b-1' },
]);
// 保存側の `acct_a` だけ版を古くする＝資格情報が別物になった口座（§8 の破棄条件⑥・F3）。
const FU99_SAVED_REVISIONS = Object.freeze({ acct_a: 'rev-a-1', acct_b: 'rev-b-1' });
const FU99_SEEDED_EVENT_TYPE = 'seeded-switch';
const FU99_CHANGED_SID = 'a1a1a1a1a1a1';
const FU99_KEPT_SID = 'b2b2b2b2b2b2';
const PRODUCTION_ROTATOR_PORT = 37891;

function fu99SavedState(nowMs) {
  const savedAt = new Date(nowMs - 60_000).toISOString();
  return {
    version: 1,
    savedAt,
    currentAccount: 'acct_a',
    // ③ の観測対象。`eventHistory` が真のときだけ復元される（D-56-6・D-182）。
    events: [{ at: savedAt, type: FU99_SEEDED_EVENT_TYPE, account: 'acct_b' }],
    accounts: FU99_CONFIG_ACCOUNTS.map(account => ({
      id: account.id,
      accountUuid: null,
      credentialRevision: FU99_SAVED_REVISIONS[account.id],
      status: 'ready',
      quota: {},
      usage: {},
      rateLimitedUntil: null,
      temporaryUnavailableReason: null,
      errorReason: null,
    })),
    sessionAffinity: {
      version: 1,
      savedAt,
      entries: [
        { k: FU99_CHANGED_SID, a: 'acct_a', t: nowMs - 60_000, s: 0 },
        { k: FU99_KEPT_SID, a: 'acct_b', t: nowMs - 60_000, s: 1 },
      ],
    },
  };
}

async function fu99StartServer({ home, sessionAffinity, guardLogPath }) {
  const configPath = join(home, 'config', 'config.json');
  const port = await unusedCodexLoopbackPort();
  assert.ok(port > 0, '空きポートが取れていること');
  assert.notEqual(port, PRODUCTION_ROTATOR_PORT, '本番 rotator のポートは使わない');
  await mkdir(dirname(configPath), { recursive: true });
  await writeJsonFile(configPath, {
    // port を 0 にすると `config.proxy?.port || DEFAULT_PORT` が本番ポートへ落ちるので、
    // 必ず実ポートを書く。
    proxy: { host: '127.0.0.1', port },
    // 上流へは1件も送らない（叩くのは /internal/* だけである）。
    upstream: 'http://127.0.0.1:1',
    switchThreshold: 1,
    usagePolling: { enabled: false },
    accounts: FU99_CONFIG_ACCOUNTS.map(account => ({ ...account })),
    ...(sessionAffinity === undefined ? {} : { sessionAffinity }),
  });

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'xdg'),
    XDG_DATA_HOME: join(home, 'share'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    CLAUDE_ROTATOR_CONFIG: configPath,
    // guard のログは**この子プロセス専用**のパスへ向ける（他のテストファイルと
    // 並行実行されても、他人の1行で判定が揺れない）。PATH に載ったシムがここへ書く。
    [SERVICE_COMMAND_LOG_ENV]: guardLogPath,
  };
  // ログイン上書きの判定を実行環境に依存させない（開発機の環境変数を持ち込まない）。
  for (const name of [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
    'CLAUDE_CODE_USE_MANTLE',
  ]) delete env[name];

  const cliPath = fileURLToPath(new URL('../bin/claude-rotator.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
  };
  try {
    await fu99WaitForOutput(child, /listening on/);
  } catch (error) {
    await stop();
    throw error;
  }
  return { child, port, url: `http://127.0.0.1:${port}`, stop };
}

function fu99WaitForOutput(child, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for the server; output=${buffer}`)),
      timeoutMs,
    );
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      if (!pattern.test(buffer)) return;
      clearTimeout(timer);
      resolve(buffer);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited before listening: ${code}; output=${buffer}`));
    });
  });
}

describe('runServer wiring (FU-99)', () => {
  it('hands the durable writer, both restore results and the event-history flag to the proxy', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-runserver-'));
    // 起動した子プロセスが実サービスへ届いていないことの証拠（PATH のシムが書く）。
    const guardLogPath = join(sandbox, 'service-command-guard.log');
    const nowMs = Date.now();
    const servers = [];
    try {
      // --- ① 耐久書き込みの結線: 何も無いところへ runtime-state.json を書かせる ---
      const freshHome = join(sandbox, 'fresh');
      const freshStateDir = join(freshHome, 'xdg', 'claude-rotator');
      const freshStatePath = join(freshStateDir, 'runtime-state.json');
      await assert.rejects(
        stat(freshStateDir),
        error => error.code === 'ENOENT',
        '起動前は runtime-state.json の親ディレクトリが存在しないこと（0700 の判定が意味を持つ前提）',
      );

      const fresh = await fu99StartServer({ home: freshHome, sessionAffinity: { mode: 'on' }, guardLogPath });
      servers.push(fresh);
      // 末尾で必ず persistState() を await する経路（/internal/prepare-resume）で1回書かせる。
      await requestJson(`${fresh.url}/internal/prepare-resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      const savedFresh = JSON.parse(await readFile(freshStatePath, 'utf8'));
      assert.equal(savedFresh.version, 1, 'runtime-state.json が runtimeStatePath() の位置へ書かれていること');
      assert.ok(savedFresh.sessionAffinity, 'mode:"on" ＋ persist 既定 true なので表の節が載ること');
      assert.equal(
        (await stat(freshStatePath)).mode & 0o777,
        0o600,
        '① 保存ファイルは 0600（writeJsonFileDurable）',
      );
      assert.equal(
        (await stat(freshStateDir)).mode & 0o777,
        0o700,
        '① 新規に作られた親ディレクトリは 0700。writeJsonFile へ戻す回帰では 0700 が付かない（D-56-5）',
      );

      // --- ②③ 復元の結線: 保存ファイルを置いた状態で起動する ---
      const restoreHome = join(sandbox, 'restore');
      const restoreStatePath = join(restoreHome, 'xdg', 'claude-rotator', 'runtime-state.json');
      await writeJsonFile(restoreStatePath, fu99SavedState(nowMs));

      const restored = await fu99StartServer({ home: restoreHome, sessionAffinity: { mode: 'on' }, guardLogPath });
      servers.push(restored);
      const onStatus = await requestJson(`${restored.url}/internal/status`, { method: 'GET' });

      assert.ok(onStatus.sessionAffinity, 'mode:"on" では status に sessionAffinity 節が出る');
      assert.equal(
        onStatus.sessionAffinity.sessions,
        1,
        '② savedState と credentialChangedAccountIds の両方が渡って初めて「2件中1件」になる'
        + '（savedState 未渡し＝0件 / 資格情報の変更が未渡し＝2件）',
      );
      assert.deepEqual(
        onStatus.sessionAffinity.sessionsByAccount,
        { acct_b: 1 },
        '② 残るのは資格情報が変わっていない acct_b のバインドだけ（§8 の破棄条件⑥・F3）',
      );
      assert.deepEqual(
        onStatus.events.filter(event => event.type === FU99_SEEDED_EVENT_TYPE),
        [fu99SavedState(nowMs).events[0]],
        '③ mode:"on" では eventHistory が真で構築され、保存された events が復元される（D-182）',
      );

      // --- ③ の負の対照: 同じ保存ファイルを mode 未記載（＝off）で読み戻す ---
      const offHome = join(sandbox, 'off');
      const offStatePath = join(offHome, 'xdg', 'claude-rotator', 'runtime-state.json');
      await writeJsonFile(offStatePath, fu99SavedState(nowMs));

      const off = await fu99StartServer({ home: offHome, sessionAffinity: undefined, guardLogPath });
      servers.push(off);
      const offStatus = await requestJson(`${off.url}/internal/status`, { method: 'GET' });

      assert.equal(
        'sessionAffinity' in offStatus,
        false,
        '未記載構成では status に sessionAffinity キー自体が出ない（R7・D-56-6）',
      );
      assert.deepEqual(
        offStatus.events.filter(event => event.type === FU99_SEEDED_EVENT_TYPE),
        [],
        '③ 未記載構成では eventHistory が偽で構築され、保存された events を復元しない',
      );

      // 3本とも実サービス（launchctl / systemctl）へ1回も届いていないこと。
      assert.equal(
        await readFile(guardLogPath, 'utf8').catch(() => null),
        null,
        `起動した server が実サービスへ到達している: ${guardLogPath}`,
      );
    } finally {
      for (const server of servers.reverse()) await server.stop();
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('uses observations that actually change when a wiring point is missing (positive control)', async () => {
    // この対照が無いと、上のテストは「結線を1本外しても緑のまま」になりうる。
    // `runServer` は src なので壊せない。代わりに**同じ入力を同じ層へ直接与えて**、
    // 3点それぞれの観測が本当に差を出すことを示す。
    const nowMs = Date.now();
    const saved = fu99SavedState(nowMs);
    const accountsForLedger = () => FU99_CONFIG_ACCOUNTS.map(account => ({ ...account }));

    // ① 耐久書き込み: writeJsonFile は mkdir に mode を渡さないので 0700 にならない。
    const sandbox = await mkdtemp(join(tmpdir(), 'claude-rotator-runserver-control-'));
    try {
      const plainDir = join(sandbox, 'plain');
      await writeJsonFile(join(plainDir, 'runtime-state.json'), { version: 1 });
      // umask 022 の環境では 0755 になり、0700 との差で writer の取り違えを検出できる
      // （umask 077 の環境ではこの1点だけでは差が出ない——だから②③も併せて見る）。
      assert.equal(
        (await stat(plainDir)).mode & 0o777,
        0o777 & ~process.umask(),
        '① writeJsonFile が作る親ディレクトリは umask のまま（durable 側だけが 0700 を付ける）',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }

    // ② 復元の戻り値2つ: 片方でも渡さなければ「2件中1件」にならない。
    const restoreWith = credentialChangedAccountIds => {
      const accountManager = new AccountManager({ accounts: accountsForLedger() });
      accountManager.restoreState(saved);
      const table = new SessionAffinity({ mode: 'on', now: () => nowMs });
      table.restore(saved.sessionAffinity, { accountManager, credentialChangedAccountIds });
      return table.size;
    };
    const ledger = new AccountManager({ accounts: accountsForLedger() });
    assert.deepEqual(
      ledger.restoreState(saved),
      ['acct_a'],
      '② 台帳の復元は acct_a を「資格情報が別物になった口座」として返す',
    );
    assert.equal(restoreWith(['acct_a']), 1, '② 両方渡したときだけ1件になる');
    assert.equal(restoreWith(undefined), 2, '② credentialChangedAccountIds を渡さないと2件残る');
    const emptyTable = new SessionAffinity({ mode: 'on', now: () => nowMs });
    assert.equal(emptyTable.size, 0, '② savedState を渡さなければ表は0件（復元そのものが起きない）');

    // ③ eventHistory: 構築時に偽だと、mode:"on" でも events は1件も復元されない。
    const withHistory = new AccountManager({ accounts: accountsForLedger(), eventHistory: true });
    withHistory.restoreState(saved);
    assert.equal(
      withHistory.getStatus().events.filter(event => event.type === FU99_SEEDED_EVENT_TYPE).length,
      1,
      '③ eventHistory:true で構築すると復元される',
    );
    const withoutHistory = new AccountManager({ accounts: accountsForLedger(), eventHistory: false });
    withoutHistory.restoreState(saved);
    assert.deepEqual(
      withoutHistory.getStatus().events,
      [],
      '③ eventHistory:false で構築すると復元されない（setEventHistoryEnabled は復元より後に走る）',
    );
  });
});
