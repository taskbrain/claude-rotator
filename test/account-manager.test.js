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
  it('normalizes an out-of-range switch threshold before selecting quota targets', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'exhausted', type: 'oauth' },
        { id: 'available', type: 'oauth' },
      ],
      switchThreshold: 1.5,
      now: () => 1000,
    });
    manager.updateQuota('exhausted', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });

    assert.equal(manager.switchThreshold, 1);
    assert.equal(manager.getActiveAccount().id, 'available');
  });

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

  it('prefers a ready account with a soon weekly reset over a lower-usage account', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'soon-weekly', name: 'soon@example.com', type: 'oauth' },
        { id: 'later-low-usage', name: 'later@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.updateQuota('soon-weekly', {
      'anthropic-ratelimit-unified-5h-utilization': '0.33',
      'anthropic-ratelimit-unified-7d-utilization': '0.08',
      'anthropic-ratelimit-unified-7d-reset': '100',
    });
    manager.updateQuota('later-low-usage', {
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
      'anthropic-ratelimit-unified-7d-reset': '500000',
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });

    assert.equal(manager.getActiveAccount().id, 'soon-weekly');
  });

  it('proactively rebalances to a ready account with a soon weekly reset after usage refresh', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'soon-weekly', name: 'soon@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-utilization': '0.30',
      'anthropic-ratelimit-unified-7d-reset': '500000',
    });
    manager.updateQuota('soon-weekly', {
      'anthropic-ratelimit-unified-5h-utilization': '0.33',
      'anthropic-ratelimit-unified-7d-utilization': '0.07',
      'anthropic-ratelimit-unified-7d-reset': '100',
    });

    assert.equal(manager.rebalanceActiveAccount().id, 'soon-weekly');
    assert.equal(manager.getCurrentAccount().id, 'soon-weekly');
    assert.equal(manager.getStatus().events[0].reason, 'weekly-reset-priority');
  });

  it('does not proactively rebalance ordinary available accounts without a soon weekly reset', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'lower-usage', name: 'lower@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '0.40',
      'anthropic-ratelimit-unified-7d-utilization': '0.45',
    });
    manager.updateQuota('lower-usage', {
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
    });

    assert.equal(manager.rebalanceActiveAccount().id, 'current');
    assert.equal(manager.getCurrentAccount().id, 'current');
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

  it('prepares resume on the available account immediately when one exists', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    const target = manager.prepareResumeTarget();

    assert.equal(target.ok, true);
    assert.equal(target.action, 'ready');
    assert.equal(target.account, 'available');
    assert.equal(target.switched, true);
    assert.equal(target.resumeAtEpoch, 1);
    assert.equal(manager.getCurrentAccount().id, 'available');
  });

  it('prepares resume on the exhausted account with the shortest reset', () => {
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
    });
    manager.updateQuota('weekly-b', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '50',
    });

    const target = manager.prepareResumeTarget();

    assert.equal(target.ok, true);
    assert.equal(target.action, 'wait');
    assert.equal(target.account, 'dev');
    assert.equal(target.window, '5h');
    assert.equal(target.resumeAt, '1970-01-01T00:00:10.000Z');
    assert.equal(target.resumeAtEpoch, 10);
    assert.equal(target.waitMs, 9000);
    assert.equal(target.switched, true);
    assert.equal(manager.getCurrentAccount().id, 'dev');
    assert.equal(manager.getStatus().events[0].type, 'fallback-switch');
  });

  it('does not prepare an unknown-usage account as immediately ready', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'unknown', name: 'unknown@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });

    const target = manager.prepareResumeTarget();

    assert.equal(target.ok, false);
    assert.equal(target.action, 'unavailable');
    assert.equal(target.reason, 'no-resume-target');
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

  it('reports the configured current account as active in status', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      currentAccountId: 'acct_2',
    });

    assert.equal(manager.getStatus().currentAccount, 'acct_2');
    assert.equal(manager.getStatus().accounts[1].status, 'active');
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

  it('switches from an OAuth refresh cooldown to a known available account', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.markCredentialRefreshRateLimited('acct_1', 60);

    assert.equal(manager.getActiveAccount().id, 'acct_2');
    assert.equal(manager.getCurrentAccount().id, 'acct_2');
    assert.equal(manager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_rate_limit');
  });

  it('treats a local OAuth refresh retry as a credential cooldown', () => {
    const manager = new AccountManager({
      accounts: [
        {
          id: 'acct_1',
          name: 'a@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.markCredentialRefreshDeferred('acct_1', 60, { retryAfterSource: 'fixed' });

    assert.equal(manager.getActiveAccount().id, 'acct_2');
    assert.equal(manager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_retry');

    manager.markAuthenticated('acct_1');
    assert.equal(manager.getStatus().accounts[0].unavailableReason, null);

    manager.markCredentialRefreshDeferred('acct_1', 60, { retryAfterSource: 'fixed' });
    manager.replaceAccounts([
      {
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      },
      { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
    ]);

    assert.equal(manager.getStatus().accounts[0].unavailableReason, null);
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

  it('switches from an errored current account to a known available alternate', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.markError('current', 'oauth_refresh_failed', 'OAuth token refresh failed');
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    assert.equal(manager.getActiveAccount().id, 'available');
    assert.equal(manager.getCurrentAccount().id, 'available');
    assert.equal(manager.getStatus().accounts[0].status, 'error');
  });

  it('keeps an errored previous account marked as error after a manual switch', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.markError('current', 'oauth_refresh_failed', 'OAuth token refresh failed');
    manager.switchTo('available');

    assert.equal(manager.getCurrentAccount().id, 'available');
    assert.equal(manager.getStatus().accounts[0].status, 'error');
  });

  it('keeps authentication errors ahead of stale quota exhaustion', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '10',
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'error');
    assert.deepEqual(account.unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
    });
    assert.equal(manager.selectBestExhaustedFallback(), null);
  });

  it('clears a stale authentication error after authenticated usage succeeds', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');

    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.1, resets_at: null },
      seven_day: { utilization: 0.2, resets_at: null },
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.unavailableReason, null);
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

  it('allows an errored existing account to be retried after its credential revision changes', () => {
    const manager = new AccountManager({
      accounts: [
        {
          id: 'acct_1',
          name: 'a@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
        {
          id: 'acct_2',
          name: 'b@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
      ],
      now: () => 1000,
    });
    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');

    manager.replaceAccounts([
      {
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      },
      {
        id: 'acct_2',
        name: 'b@example.com',
        type: 'oauth',
        credentialRevision: 'revision-1',
      },
    ]);

    assert.equal(manager.getActiveAccount().id, 'acct_1');
    assert.equal(manager.accounts[0].credentialRevision, 'revision-2');
    assert.equal(manager.accounts[0].errorReason, null);
    assert.equal(manager.getStatus().accounts[0].unavailableReason, null);
  });

  it('clears quota and usage when a reloaded account has a new credential identity', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        accountUuid: 'uuid-1',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.8',
      'anthropic-ratelimit-unified-5h-reset': '3600',
      'anthropic-ratelimit-unified-7d-utilization': '0.6',
      'anthropic-ratelimit-unified-7d-reset': '7200',
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '200',
    });
    manager.applyUsage('acct_1', {
      scoped_weekly: [{
        key: 'fable',
        label: 'Fable',
        utilization: 0.7,
        resets_at: '2026-07-07T00:00:00Z',
      }],
    });
    manager.updateUsage('acct_1', { inputTokens: 100, outputTokens: 50 });

    manager.replaceAccounts([{
      id: 'acct_1',
      name: 'a@example.com',
      type: 'oauth',
      accountUuid: 'uuid-2',
      credentialRevision: 'revision-2',
    }]);

    const account = manager.getStatus().accounts[0];
    assert.equal(account.accountUuid, 'uuid-2');
    assert.deepEqual(account.quota, {
      unified5h: null,
      unified7d: null,
      unified5hReset: null,
      unified7dReset: null,
      weeklyScoped: [],
      unifiedStatus: null,
      tokensLimit: null,
      tokensRemaining: null,
      requestsLimit: null,
      requestsRemaining: null,
      resetsAt: null,
    });
    assert.deepEqual(account.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
  });

  it('clears quota and usage when only a reloaded account UUID changes', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        accountUuid: 'uuid-1',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.8',
      'anthropic-ratelimit-unified-5h-reset': '3600',
    });
    manager.updateUsage('acct_1', { inputTokens: 100, outputTokens: 50 });

    manager.replaceAccounts([{
      id: 'acct_1',
      name: 'a@example.com',
      type: 'oauth',
      accountUuid: 'uuid-2',
      credentialRevision: 'revision-1',
    }]);

    const account = manager.getStatus().accounts[0];
    assert.equal(account.quota.unified5h, null);
    assert.equal(account.quota.unified5hReset, null);
    assert.deepEqual(account.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
  });

  it('keeps an OAuth error when the credential revision is unchanged', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });
    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');

    manager.replaceAccounts([{
      id: 'acct_1',
      name: 'a@example.com',
      type: 'oauth',
      credentialRevision: 'revision-1',
    }]);

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'error');
    assert.equal(account.unavailableReason.type, 'oauth_refresh_failed');
  });

  it('clears only the changed account OAuth cooldown after credential reload', () => {
    const manager = new AccountManager({
      accounts: [
        {
          id: 'acct_1',
          name: 'a@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
        {
          id: 'acct_2',
          name: 'b@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
      ],
      now: () => 1000,
    });
    manager.markCredentialRefreshRateLimited('acct_1', 3600, {
      retryAfterSource: 'fallback',
    });
    manager.markCredentialRefreshRateLimited('acct_2', 3600, {
      retryAfterSource: 'fallback',
    });

    manager.replaceAccounts([
      {
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      },
      {
        id: 'acct_2',
        name: 'b@example.com',
        type: 'oauth',
        credentialRevision: 'revision-1',
      },
    ]);

    const status = manager.getStatus();
    assert.equal(status.accounts[0].status, 'active');
    assert.equal(status.accounts[0].rateLimitedUntil, null);
    assert.equal(status.accounts[0].unavailableReason, null);
    assert.equal(status.accounts[1].status, 'throttled');
    assert.notEqual(status.accounts[1].rateLimitedUntil, null);
    assert.equal(status.accounts[1].unavailableReason.type, 'oauth_refresh_rate_limit');
    assert.equal(manager.accounts[0].credentialRevision, 'revision-2');
    assert.equal(manager.accounts[1].credentialRevision, 'revision-1');
  });

  it('keeps OAuth state when either credential revision is missing', () => {
    const manager = new AccountManager({
      accounts: [
        {
          id: 'existing-revision',
          name: 'a@example.com',
          type: 'oauth',
          credentialRevision: 'revision-1',
        },
        { id: 'new-revision', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    manager.markError(
      'existing-revision',
      'oauth_refresh_failed',
      'OAuth token refresh failed',
    );
    manager.markCredentialRefreshRateLimited('new-revision', 3600, {
      retryAfterSource: 'fallback',
    });

    manager.replaceAccounts([
      { id: 'existing-revision', name: 'a@example.com', type: 'oauth' },
      {
        id: 'new-revision',
        name: 'b@example.com',
        type: 'oauth',
        credentialRevision: 'revision-1',
      },
    ]);

    const status = manager.getStatus();
    assert.equal(status.accounts[0].status, 'error');
    assert.equal(status.accounts[0].unavailableReason.type, 'oauth_refresh_failed');
    assert.equal(status.accounts[1].status, 'throttled');
    assert.equal(status.accounts[1].unavailableReason.type, 'oauth_refresh_rate_limit');
    assert.equal(manager.accounts[0].credentialRevision, 'revision-1');
    assert.equal(manager.accounts[1].credentialRevision, 'revision-1');
  });

  it('does not restore a credential error from an older credential revision', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      }],
      now: () => 1000,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        credentialRevision: 'revision-1',
        status: 'error',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(61_000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_rate_limit',
          retryAfterSource: 'fallback',
        },
        errorReason: { type: 'oauth_refresh_failed' },
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
  });

  it('does not restore quota, usage, or availability evidence from an older credential revision', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      }],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        credentialRevision: 'revision-1',
        status: 'exhausted',
        quota: {
          unified5h: 1,
          unified5hReset: 3600000,
          unified7d: 0.9,
          unified7dReset: 7200000,
          weeklyScoped: [{
            key: 'fable',
            label: 'Fable',
            utilization: 1,
            resetAt: 7200000,
          }],
          tokensLimit: 1000,
          tokensRemaining: 0,
        },
        usage: {
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalRequests: 3,
          lastUsed: '2026-07-01T00:00:00.000Z',
        },
        rateLimitedUntil: new Date(3600000).toISOString(),
        temporaryUnavailableReason: { type: 'oauth_refresh_rate_limit' },
        errorReason: { type: 'oauth_refresh_failed' },
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
    assert.deepEqual(account.quota, {
      unified5h: null,
      unified7d: null,
      unified5hReset: null,
      unified7dReset: null,
      weeklyScoped: [],
      unifiedStatus: null,
      tokensLimit: null,
      tokensRemaining: null,
      requestsLimit: null,
      requestsRemaining: null,
      resetsAt: null,
    });
    assert.deepEqual(account.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
  });

  it('does not restore quota or usage from a different account UUID with the same revision', () => {
    const original = new AccountManager({
      accounts: [{
        id: 'acct_1',
        type: 'oauth',
        accountUuid: 'uuid-1',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });
    original.applyUsage('acct_1', {
      five_hour: { utilization: 1, resets_at: '2026-08-20T00:00:00.000Z' },
    });
    original.updateUsage('acct_1', { inputTokens: 100, outputTokens: 50 });
    const saved = original.exportState();
    assert.equal(saved.accounts[0].accountUuid, 'uuid-1');

    const restarted = new AccountManager({
      accounts: [{
        id: 'acct_1',
        type: 'oauth',
        accountUuid: 'uuid-2',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });
    restarted.restoreState(saved);

    const account = restarted.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.unavailableReason, null);
    assert.equal(account.quota.unified5h, null);
    assert.deepEqual(account.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
  });

  it('does not restore availability evidence from legacy state without an account UUID', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        type: 'oauth',
        accountUuid: 'uuid-current',
        credentialRevision: 'revision-1',
      }],
      now: () => 1000,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        credentialRevision: 'revision-1',
        status: 'ready',
        quota: {
          unified5h: 0.05,
          unified5hReset: 3600000,
          unified7d: 0.1,
          unified7dReset: 7200000,
        },
        usage: {
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalRequests: 3,
          lastUsed: '2026-07-01T00:00:00.000Z',
        },
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.quota.unified5h, null);
    assert.equal(account.quota.unified7d, null);
    assert.equal(manager.switchTargetScore(manager.accounts[0]), null);
    assert.deepEqual(account.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
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

  it('stores model-scoped weekly usage from OAuth usage refresh payloads', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    manager.applyUsage('acct_1', {
      scoped_weekly: [
        {
          key: 'fable',
          label: 'Fable',
          utilization: 0.5,
          resets_at: '2026-07-07T00:00:00Z',
        },
      ],
    });

    const status = manager.getStatus();
    assert.deepEqual(status.accounts[0].quota.weeklyScoped, [
      {
        key: 'fable',
        label: 'Fable',
        utilization: 0.5,
        resetAt: Date.parse('2026-07-07T00:00:00Z'),
      },
    ]);
  });

  it('clears exhausted quota from a full empty OAuth usage snapshot', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.applyUsage('acct_1', {
      five_hour: { utilization: 1, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 1, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [{
        key: 'fable',
        label: 'Fable',
        utilization: 1,
        resets_at: '2026-07-07T00:00:00Z',
      }],
    });
    manager.applyUsage('acct_1', {
      five_hour: null,
      seven_day: null,
      scoped_weekly: [],
    });

    const account = manager.getStatus().accounts[0];
    assert.deepEqual([
      account.quota.unified5h,
      account.quota.unified5hReset,
      account.quota.unified7d,
      account.quota.unified7dReset,
      account.quota.weeklyScoped,
    ], [null, null, null, null, []]);
    assert.equal(account.unavailableReason, null);
  });

  function makeManagerWithFableExhaustedPrimary() {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });

    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [
        {
          key: 'fable',
          label: 'Fable',
          utilization: 1,
          resets_at: '2026-07-07T00:00:00Z',
        },
      ],
    });
    manager.applyUsage('acct_2', {
      five_hour: { utilization: 0.4, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.4, resets_at: '2026-07-07T00:00:00Z' },
    });

    return manager;
  }

  it('still reports the fable sub-cap exhaustion for status/monitoring regardless of the requested model', () => {
    const manager = makeManagerWithFableExhaustedPrimary();
    const exhausted = manager.getStatus().accounts[0];
    assert.equal(exhausted.status, 'exhausted');
    assert.deepEqual(exhausted.unavailableReason, {
      type: 'quota_exhausted',
      window: '7d Fable',
      claim: 'seven_day_fable',
      utilization: 1,
      resetAt: '2026-07-07T00:00:00.000Z',
    });
  });

  it('switches away from a fable-exhausted account for FABLE requests', () => {
    const manager = makeManagerWithFableExhaustedPrimary();
    const picked = manager.getActiveAccount('fable');
    assert.notEqual(picked.id, 'acct_1', 'fable request must skip the fable-exhausted account');
    assert.equal(picked.id, 'acct_2');
  });

  it('does not permanently move currentIndex for a model-scoped-only switch (M2)', () => {
    const manager = makeManagerWithFableExhaustedPrimary();

    const fablePicked = manager.getActiveAccount('fable');
    assert.equal(fablePicked.id, 'acct_2', 'the fable request is routed ad-hoc to acct_2');
    assert.equal(
      manager.getCurrentAccount().id,
      'acct_1',
      'a scoped-only exhaustion must not move currentIndex away from acct_1',
    );

    const sonnetPicked = manager.getActiveAccount(null);
    assert.equal(
      sonnetPicked.id,
      'acct_1',
      'a later non-fable request must still land on acct_1, not the fable ad-hoc target',
    );
  });

  it('keeps using a fable-exhausted account for NON-fable requests (opus/sonnet/haiku)', () => {
    const manager = makeManagerWithFableExhaustedPrimary();
    const picked = manager.getActiveAccount(null);
    assert.equal(picked.id, 'acct_1', 'non-fable request must still use the account');
  });

  it('treats an omitted model family the same as a non-fable request (default behavior)', () => {
    const manager = makeManagerWithFableExhaustedPrimary();
    // Calling with no argument at all must behave exactly like modelFamily = null,
    // i.e. a request whose model could not be identified is routed as non-Fable.
    const picked = manager.getActiveAccount();
    assert.equal(picked.id, 'acct_1', 'omitting modelFamily must default to non-fable (permissive) routing');
  });

  it('rejects every model family when the common weekly/5h window is exhausted (not model-scoped)', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 1, resets_at: '2026-07-07T00:00:00Z' },
    });

    assert.equal(manager.isAvailable(manager.accounts[0], 'fable'), false, 'common quota exhaustion must block fable requests too');
    assert.equal(manager.isAvailable(manager.accounts[0], null), false, 'common quota exhaustion must block non-fable requests too');
    assert.equal(manager.getActiveAccount('fable'), null);
    assert.equal(manager.getActiveAccount(null), null);
  });

  it('CASE B: rejects every model family when a common token-rate-limit exhaustion is hidden behind a fable-scoped exhaustion', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
    // Unified 5h/7d have headroom. The Fable weekly sub-cap is exhausted AND,
    // independently, the common token rate limit is exhausted too.
    // `quotaUnavailableReason` would report the Fable-scoped reason first
    // (scoped windows are checked before tokens/requests) — a gate that only
    // looked at that single classified reason would incorrectly let a
    // non-fable request through even though the account has no token budget
    // left for anyone.
    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: '2026-07-07T00:00:00Z' }],
    });
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '0',
    });

    assert.equal(manager.isAvailable(manager.accounts[0], 'fable'), false, 'token exhaustion must block fable requests too');
    assert.equal(manager.isAvailable(manager.accounts[0], null), false, 'token exhaustion must block non-fable requests too, even though the fable-scoped reason sorts first');
    assert.equal(manager.getActiveAccount('fable'), null);
    assert.equal(manager.getActiveAccount(null), null);
  });

  it('CASE C: rejects a fable request when the fable-scoped entry is not the first element of weeklyScoped', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
    // scopedWeeklyQuotaUnavailableReason only ever returns the FIRST exhausted
    // entry it finds; if an unrelated scoped cap comes first in the array, a
    // gate built on that single reason would never see the fable exhaustion
    // that follows it.
    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [
        { key: 'some_other_cap', label: 'Some Other Cap', utilization: 1, resets_at: '2026-07-07T00:00:00Z' },
        { key: 'fable', label: 'Fable', utilization: 1, resets_at: '2026-07-07T00:00:00Z' },
      ],
    });

    assert.equal(
      manager.isAvailable(manager.accounts[0], 'fable'),
      false,
      'a fable-scoped exhaustion must be found even when it is not the first weeklyScoped entry',
    );
    assert.equal(
      manager.isAvailable(manager.accounts[0], null),
      true,
      'an unrecognized scoped cap ahead of it must not gate a non-fable request',
    );
    assert.equal(manager.getActiveAccount('fable'), null);
    assert.equal(manager.getActiveAccount(null)?.id, 'acct_1');
  });

  it('m2: unavailableReasonForModelFamily reports the true common-quota reason to a non-matching-family request', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
    // Same fixture as CASE B: unified 5h/7d have headroom, the Fable weekly
    // sub-cap is exhausted, and the common token rate limit is exhausted too.
    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: '2026-07-07T00:00:00Z' }],
    });
    manager.updateQuota('acct_1', {
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '0',
    });
    const account = manager.accounts[0];

    const fableReason = manager.unavailableReasonForModelFamily(account, 'fable');
    assert.equal(fableReason.type, 'quota_exhausted');
    assert.equal(fableReason.window, '7d Fable');
    assert.equal(fableReason.claim, 'seven_day_fable');

    const nonFableReason = manager.unavailableReasonForModelFamily(account, null);
    assert.equal(
      nonFableReason.type,
      'token_rate_limit_exhausted',
      'a non-fable request must be told the true (token) reason, not the fable-scoped one',
    );
    assert.equal(nonFableReason.claim, undefined, 'the token-exhaustion reason must not carry a fable claim');

    // The unfiltered, family-agnostic reason (used for /internal/status) is
    // unaffected: it still reports whichever reason the existing priority
    // (5h -> 7d -> scoped -> tokens -> requests) surfaces first.
    assert.equal(manager.unavailableReason(account).window, '7d Fable');
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

  it('keeps a credential refresh cooldown authoritative when a scoped quota reason hides it', () => {
    const manager = new AccountManager({
      accounts: [
        { id: 'cooldown', name: 'cooldown@example.com', type: 'oauth' },
        { id: 'quota', name: 'quota@example.com', type: 'oauth' },
      ],
      currentAccountId: 'cooldown',
      switchThreshold: 1,
      now: () => 1000,
    });
    manager.applyUsage('cooldown', {
      five_hour: { utilization: 0.2, resets_at: '2026-07-05T05:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-07-07T00:00:00Z' },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: '2026-07-07T00:00:00Z' }],
    });
    manager.markCredentialRefreshDeferred('cooldown', 300, { retryAfterSource: 'fixed' });
    manager.updateQuota('quota', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '60',
    });

    const cooldown = manager.find('cooldown');
    assert.equal(manager.unavailableReason(cooldown).type, 'quota_exhausted');
    assert.equal(manager.hasCredentialRefreshCooldown(cooldown), true);
    assert.equal(manager.isAvailable(cooldown, null), false);
    assert.equal(manager.getActiveAccount(null), null);
    assert.equal(manager.getCurrentAccount().id, 'cooldown');
    assert.equal(manager.exhaustedFallbackScore(cooldown), null);

    const resume = manager.prepareResumeTarget();
    assert.equal(resume.account, 'quota');
    assert.equal(resume.reason, 'shortest-quota-reset');
  });

  it('restores persisted quota state for resume target selection after restart', () => {
    const now = Date.parse('2026-06-07T11:00:00Z');
    const accounts = [
      { id: 'current', name: 'current@example.com', type: 'oauth' },
      { id: 'ready', name: 'ready@example.com', type: 'oauth' },
    ];
    const manager = new AccountManager({
      accounts,
      currentAccountId: 'current',
      now: () => now,
    });
    manager.applyUsage('current', {
      five_hour: { utilization: 1, resets_at: '2026-06-07T14:00:00Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-06-10T11:00:00Z' },
    });
    manager.applyUsage('ready', {
      five_hour: { utilization: 0.1, resets_at: '2026-06-07T13:00:00Z' },
      seven_day: { utilization: 0.3, resets_at: '2026-06-10T11:00:00Z' },
    });

    const restarted = new AccountManager({
      accounts,
      currentAccountId: 'current',
      now: () => now,
    });
    restarted.restoreState(manager.exportState());

    const target = restarted.prepareResumeTarget();

    assert.equal(target.action, 'ready');
    assert.equal(target.account, 'ready');
    assert.equal(target.switched, true);
    const status = restarted.getStatus();
    assert.equal(status.accounts[0].status, 'exhausted');
    assert.equal(status.accounts[1].status, 'active');
  });

  it('clears an excessive legacy OAuth refresh cooldown after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 45 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: { type: 'oauth_refresh_rate_limit' },
        errorReason: { type: 'oauth_refresh_failed' },
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
  });

  it('preserves a fallback OAuth refresh cooldown up to fifteen minutes after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 15 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_rate_limit',
          retryAfterSource: 'fallback',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'throttled');
    assert.equal(account.rateLimitedUntil, '2026-07-12T12:15:00.000Z');
    assert.deepEqual(account.unavailableReason, {
      type: 'oauth_refresh_rate_limit',
      retryAfterSource: 'fallback',
      retryAt: '2026-07-12T12:15:00.000Z',
    });
  });

  it('clears a fallback OAuth refresh cooldown over fifteen minutes after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 16 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_rate_limit',
          retryAfterSource: 'fallback',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
  });

  it('preserves a fixed local OAuth refresh retry up to one hour after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 60 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_retry',
          retryAfterSource: 'fixed',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'throttled');
    assert.equal(account.rateLimitedUntil, '2026-07-12T13:00:00.000Z');
    assert.equal(account.unavailableReason.type, 'oauth_refresh_retry');
    assert.equal(account.unavailableReason.retryAfterSource, 'fixed');
  });

  it('clears a fixed local OAuth refresh retry over one hour after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 61 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_retry',
          retryAfterSource: 'fixed',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
  });

  it('preserves a long provider Retry-After after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_rate_limit',
          retryAfterSource: 'provider',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'throttled');
    assert.equal(account.unavailableReason.retryAfterSource, 'provider');
    assert.equal(account.unavailableReason.retryAt, '2026-07-12T14:00:00.000Z');
  });

  it('clears an excessive persisted provider Retry-After after restart', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    const manager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => now,
    });

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'throttled',
        quota: {},
        usage: {},
        rateLimitedUntil: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
        temporaryUnavailableReason: {
          type: 'oauth_refresh_rate_limit',
          retryAfterSource: 'provider',
        },
        errorReason: null,
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'active');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.unavailableReason, null);
  });
});
