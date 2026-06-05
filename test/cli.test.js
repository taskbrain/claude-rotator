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

    const code = await runCli(['import-current', '--id', 'acct_1', '--name', 'a@example.com'], {
      ...io,
      readCurrentCredentials: async () => ({ accessToken: 'access', refreshToken: 'refresh' }),
      saveImportedAccount: async account => imported.push(account),
    });

    assert.equal(code, 0);
    assert.deepEqual(imported, [{
      id: 'acct_1',
      name: 'a@example.com',
      secret: { accessToken: 'access', refreshToken: 'refresh' },
    }]);
    assert.match(io.output(), /Imported a@example\.com/);
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
