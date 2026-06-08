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
  it('switches to the emptiest known account when 5h quota reaches threshold', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        { id: 'acct_3', name: 'c@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.72',
      'anthropic-ratelimit-unified-7d-utilization': '0.61',
    });
    manager.updateQuota('acct_3', {
      'anthropic-ratelimit-unified-5h-utilization': '0.23',
      'anthropic-ratelimit-unified-7d-utilization': '0.34',
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });

    assert.equal(manager.getActiveAccount().id, 'acct_3');
  });

  it('does not switch when quota is exhausted but no known available target exists', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '10',
    });

    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.getCurrentAccount().id, 'acct_1');
    assert.equal(manager.getFallbackAccount().id, 'acct_1');
  });

  it('keeps the current quota-exhausted account when no available target exists', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'weekly-a', name: 'weekly-a@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
        { id: 'weekly-b', name: 'weekly-b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.updateQuota('weekly-a', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '100',
    });
    manager.updateQuota('dev', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
      'anthropic-ratelimit-unified-7d-utilization': '0.41',
    });
    manager.updateQuota('weekly-b', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '50',
    });

    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.getFallbackAccount().id, 'weekly-a');
    assert.equal(manager.getCurrentAccount().id, 'weekly-a');
  });

  it('starts on the configured active account', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      currentAccountId: 'acct_2',
    });

    assert.equal(manager.getCurrentAccount().id, 'acct_2');
  });

  it('makes quota-limited accounts available after reset time passes', () => {
    let now = 1000;
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => now,
    });
    manager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
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

  it('does not switch accounts for retry-after throttling', () => {
    let now = 1000;
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => now,
    });

    manager.markRateLimited('acct_1', 10);

    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.getCurrentAccount().id, 'acct_1');
    assert.equal(manager.getFallbackAccount().id, 'acct_1');
    now = 12000;
    manager.switchTo('acct_1');
    assert.equal(manager.getActiveAccount().id, 'acct_1');
  });

  it('falls back to the current throttled account before an exhausted alternate', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'throttled', name: 'a@example.com', type: 'oauth' },
        { id: 'exhausted', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.markRateLimited('throttled', 60);
    manager.updateQuota('exhausted', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '10',
    });

    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.getFallbackAccount().id, 'throttled');
  });

  it('does not fall back to an exhausted alternate when the current account has an auth error', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'exhausted', name: 'exhausted@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.markError('current', 'oauth_refresh_failed', 'OAuth token refresh failed');
    manager.updateQuota('exhausted', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '10',
    });

    assert.equal(manager.getActiveAccount(), null);
    assert.equal(manager.getFallbackAccount().id, 'current');
    assert.equal(manager.getCurrentAccount().id, 'current');
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

  it('allows an errored existing account to be retried after reload', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.accounts[0].status = 'error';

    manager.replaceAccounts([
      { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
      { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
    ]);

    assert.equal(manager.getActiveAccount().id, 'acct_1');
  });

  it('reports precise unavailable reasons for quota, throttling, and errors', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        { id: 'acct_3', name: 'c@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    manager.markRateLimited('acct_2', 30);
    manager.markError('acct_3', 'authentication_error', 'OAuth token rejected');

    const status = manager.getStatus();

    assert.deepEqual(status.accounts[0].unavailableReason, {
      type: 'quota_exhausted',
      window: '5h',
      utilization: 1,
      resetAt: '1970-01-01T00:00:10.000Z',
    });
    assert.deepEqual(status.accounts[1].unavailableReason, {
      type: 'temporary_throttle',
      retryAt: '1970-01-01T00:00:31.000Z',
    });
    assert.deepEqual(status.accounts[2].unavailableReason, {
      type: 'authentication_error',
      message: 'OAuth token rejected',
    });
  });

  it('records quota exhaustion events once per quota window', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });

    const headers = {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    };
    manager.updateQuota('acct_1', headers);
    manager.getStatus();
    manager.updateQuota('acct_1', headers);

    const events = manager.getStatus().events.filter(event => event.type === 'quota-exhausted');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].reason, {
      type: 'quota_exhausted',
      window: '5h',
      utilization: 1,
      resetAt: '1970-01-01T00:00:10.000Z',
    });
  });

  it('clears stale reset times from OAuth usage refresh payloads', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0, resets_at: null },
    });

    const status = manager.getStatus();
    assert.equal(status.accounts[0].quota.unified5h, 0);
    assert.equal(status.accounts[0].quota.unified5hReset, null);
  });

  it('reports quota exhaustion ahead of retry-after throttling', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.markRateLimited('acct_1', 60);
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'exhausted');
    assert.equal(account.unavailableReason.type, 'quota_exhausted');
    assert.equal(account.unavailableReason.window, '5h');
  });
});
