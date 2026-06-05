import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager } from '../src/account-manager.js';
import { parseRateLimitHeaders } from '../src/quota.js';

describe('parseRateLimitHeaders', () => {
  it('parses unified quota utilization and reset headers', () => {
    const parsed = parseRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.76',
      'anthropic-ratelimit-unified-7d-utilization': '0.51',
      'anthropic-ratelimit-unified-5h-reset': '1780582800',
      'anthropic-ratelimit-unified-7d-reset': '1780702800',
      'anthropic-ratelimit-unified-status': 'allowed_warning',
    });

    assert.equal(parsed.unified5h, 0.76);
    assert.equal(parsed.unified7d, 0.51);
    assert.equal(parsed.unified5hReset, 1780582800000);
    assert.equal(parsed.unified7dReset, 1780702800000);
    assert.equal(parsed.unifiedStatus, 'allowed_warning');
  });
});

describe('AccountManager', () => {
  it('switches away from an account whose 5h quota reaches threshold', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 0.99,
      now: () => 1000,
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.991',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });

    assert.equal(manager.getActiveAccount().id, 'acct_2');
  });

  it('makes quota-limited accounts available after reset time passes', () => {
    let now = 1000;
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 0.99,
      now: () => now,
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '2',
    });

    assert.equal(manager.getActiveAccount().id, 'acct_2');
    now = 2500;
    manager.switchTo('acct_1');

    assert.equal(manager.getActiveAccount().id, 'acct_1');
  });

  it('reports status without credentials', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth', accessToken: 'secret' },
      ],
      now: () => 1000,
    });

    manager.updateUsage('acct_1', { inputTokens: 10, outputTokens: 20 });
    const status = manager.getStatus();

    assert.equal(status.currentAccount, 'acct_1');
    assert.equal(status.accounts[0].id, 'acct_1');
    assert.equal(status.accounts[0].name, 'a@example.com');
    assert.equal(status.accounts[0].usage.totalInputTokens, 10);
    assert.equal(JSON.stringify(status).includes('secret'), false);
  });

  it('marks retry-after throttled accounts unavailable', () => {
    let now = 1000;
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => now,
    });

    manager.markRateLimited('acct_1', 10);

    assert.equal(manager.getActiveAccount().id, 'acct_2');
    now = 12000;
    manager.switchTo('acct_1');
    assert.equal(manager.getActiveAccount().id, 'acct_1');
  });

  it('replaces account metadata for server reload', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    manager.replaceAccounts([
      { id: 'acct_2', name: 'b@example.com', type: 'oauth', accountUuid: 'uuid-2' },
    ]);

    const status = manager.getStatus();
    assert.equal(status.currentAccount, 'acct_2');
    assert.equal(status.accounts.length, 1);
    assert.equal(status.accounts[0].name, 'b@example.com');
    assert.equal(status.accounts[0].accountUuid, 'uuid-2');
  });
});
