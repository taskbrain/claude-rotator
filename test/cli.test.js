import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runCli, startService } from '../src/cli.js';

describe('runCli', () => {
  it('prints help', async () => {
    const io = createIo();

    const code = await runCli(['help'], { ...io });

    assert.equal(code, 0);
    assert.match(io.output(), /claude-rotator install/);
    assert.match(io.output(), /claude-rotator monitor/);
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
    assert.match(io.output(), /include a refresh token/);
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
    assert.match(io.output(), /Could not verify the current Claude Code login/);
  });

  it('configures live current Claude Code login without storing a token snapshot', async () => {
    const io = createIo();
    let savedConfig = null;
    let reloaded = false;

    const code = await runCli(['use-current', '--only'], {
      ...io,
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
        set: async (id, secret) => { stored.push({ id, secret }); },
      },
      reloadServer: async () => {},
    });

    assert.equal(code, 0);
    assert.deepEqual(stored, [{ id: 'custom-person', secret: { accessToken: 'new-access', refreshToken: 'new-refresh' } }]);
    assert.deepEqual(savedConfig.accounts, [{
      id: 'custom-person',
      name: 'person@example.com',
      type: 'oauth',
      accountUuid: 'uuid-1',
    }]);
    assert.match(io.output(), /Imported person@example\.com/);
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
    assert.match(io.output(), /warning: current: static accountUuid is obsolete; run claude-rotator use-current to normalize it/);
    assert.match(io.output(), /warning: bad: credential profile check failed: Profile fetch failed \(401\)/);
    assert.match(io.output(), /warning: live duplicate accountUuid for current, duplicate/);
  });

  it('refreshes expired stored credentials before doctor profile checks', async () => {
    const io = createIo();
    const stored = {
      acct_1: {
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        expiresAt: 1000,
        scopes: ['user:profile', 'user:inference'],
        refreshTokenExpiresAt: 9999999999999,
      },
    };
    const secretStore = {
      get: async id => stored[id],
      set: async (id, secret) => { stored[id] = secret; },
    };

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
    assert.equal(stored.acct_1.accessToken, 'fresh-token');
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

  it('discards a doctor refresh result when a newer credential was stored in flight', async () => {
    const io = createIo();
    const stored = {
      acct_1: {
        accessToken: 'expired-token',
        refreshToken: 'refresh-token-1',
        expiresAt: 1000,
      },
    };
    const newerSecret = {
      accessToken: 'newer-token',
      refreshToken: 'refresh-token-3',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    const secretStore = {
      get: async id => stored[id],
      set: async (id, secret) => { stored[id] = secret; },
    };

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
        await secretStore.set('acct_1', newerSecret);
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
    assert.deepEqual(stored.acct_1, newerSecret);
  });
});

describe('startService', () => {
  it('restarts a macOS LaunchAgent before kickstart', async () => {
    const calls = [];

    await startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      sleepImpl: async () => {},
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
      },
    });

    assert.deepEqual(calls, [
      ['launchctl', ['bootout', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['enable', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['kickstart', '-k', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
    ]);
  });

  it('falls back to launchctl load when macOS bootstrap fails', async () => {
    const calls = [];

    await startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      sleepImpl: async () => {},
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
        if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5');
      },
    });

    assert.deepEqual(calls, [
      ['launchctl', ['bootout', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['load', '-w', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['enable', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['kickstart', '-k', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
    ]);
  });

  it('retries bootstrap when load exits before registering the macOS service', async () => {
    const calls = [];
    let bootstrapCalls = 0;
    let printCalls = 0;

    await startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      sleepImpl: async () => {},
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
        if (args[0] === 'bootstrap') {
          bootstrapCalls += 1;
          if (bootstrapCalls < 3) throw new Error('Bootstrap failed: 5');
        }
        if (args[0] === 'print') {
          printCalls += 1;
          if (printCalls < 3) throw new Error('service not found');
        }
      },
    });

    assert.deepEqual(calls, [
      ['launchctl', ['bootout', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['load', '-w', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['enable', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['kickstart', '-k', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
    ]);
  });

  it('retries bootstrap when the macOS service disappears after kickstart', async () => {
    const calls = [];
    let printCalls = 0;

    await startService({
      platform: 'darwin',
      uid: 501,
      plistPath: '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist',
      sleepImpl: async () => {},
      execFileImpl: async (cmd, args) => {
        calls.push([cmd, args]);
        if (args[0] === 'print') {
          printCalls += 1;
          if (printCalls === 2) throw new Error('service not found');
        }
      },
    });

    assert.deepEqual(calls, [
      ['launchctl', ['bootout', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['enable', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['kickstart', '-k', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
      ['launchctl', ['bootstrap', 'gui/501', '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.plist']],
      ['launchctl', ['print', 'gui/501/io.github.claude-rotator']],
    ]);
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
