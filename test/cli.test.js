import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import {
  assertAnthropicGatewayProviderCompatible,
  assertGatewayCompatibleAccounts,
  claudeLoginOverrideSource,
  credentialOwnershipConfiguration,
  ensureCredentialRevisions,
  internalApiUrl,
  removeServiceFile,
  requestJson,
  runCli,
  runMacosCliActionWithLock,
  startService,
} from '../src/cli.js';
import { MACOS_LAUNCH_AGENT_LABEL } from '../src/install.js';

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
        secretStoreFactory,
      });

      assert.equal(code, 0);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], ['acct_1', 'acct_2', 'current']);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

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
