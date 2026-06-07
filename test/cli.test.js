import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runCli } from '../src/cli.js';

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

  it('imports current Claude Code credentials through injected reader', async () => {
    const io = createIo();
    const imported = [];
    let reloaded = false;

    const code = await runCli(['import-current', '--id', 'acct_1', '--name', 'a@example.com'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      saveImportedAccount: async account => imported.push(account),
      reloadServer: async () => { reloaded = true; },
    });

    assert.equal(code, 0);
    assert.deepEqual(imported, [{
      id: 'acct_1',
      name: 'a@example.com',
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
      accountUuid: 'uuid-1',
    }]);
    assert.equal(reloaded, true);
    assert.match(io.output(), /Using live Claude Code login as person@example\.com/);
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
    assert.match(io.output(), /warning: current: config accountUuid differs from live login/);
    assert.match(io.output(), /warning: bad: credential profile check failed: Profile fetch failed \(401\)/);
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
