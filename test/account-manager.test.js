import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager, familyQuotaExhaustedOnly, isCommonQuotaExhausted } from '../src/account-manager.js';
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

  it('switches every model family away from common token and request exhaustion', () => {
    for (const reasonKind of ['token', 'request']) {
      for (const modelFamily of ['fable', null]) {
        const manager = new AccountManager({
          accounts: [
            { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
            { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
          ],
          switchThreshold: 1,
          now: () => 1000,
        });
        manager.updateQuota('acct_2', {
          'anthropic-ratelimit-unified-5h-utilization': '0.2',
          'anthropic-ratelimit-unified-7d-utilization': '0.3',
        });
        manager.updateQuota('acct_1', reasonKind === 'token'
          ? {
              'anthropic-ratelimit-tokens-limit': '1000',
              'anthropic-ratelimit-tokens-remaining': '0',
            }
          : {
              'anthropic-ratelimit-requests-limit': '100',
              'anthropic-ratelimit-requests-remaining': '0',
            });

        assert.equal(manager.getActiveAccount(modelFamily)?.id, 'acct_2', `${reasonKind}/${modelFamily || 'other'}`);
      }
    }
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
      at: '1970-01-01T00:00:01.000Z',
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
      at: '1970-01-01T00:00:01.000Z',
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

  it('reports model-aware availability in the order each account can actually recover', () => {
    const now = Date.parse('2026-08-29T05:00:00.000Z');
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        { id: 'acct_3', name: 'c@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => now,
    });

    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: '2026-08-29T10:00:00.000Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-09-01T05:00:00.000Z' },
      scoped_weekly: [{
        key: 'fable',
        label: 'Fable',
        utilization: 1,
        resets_at: '2026-08-29T09:00:00.000Z',
      }],
    });
    manager.applyUsage('acct_2', {
      five_hour: { utilization: 1, resets_at: '2026-08-29T06:00:00.000Z' },
      seven_day: { utilization: 0.2, resets_at: '2026-09-01T05:00:00.000Z' },
      scoped_weekly: [{
        key: 'fable',
        label: 'Fable',
        utilization: 1,
        resets_at: '2026-08-29T08:00:00.000Z',
      }],
    });
    manager.applyUsage('acct_3', {
      five_hour: { utilization: 0.2, resets_at: '2026-08-29T10:00:00.000Z' },
      seven_day: { utilization: 1, resets_at: '2026-08-29T07:00:00.000Z' },
    });

    const status = manager.getStatus();
    assert.deepEqual(status.routingAvailability.other, [
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'available',
        availableAt: null,
      },
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T06:00:00.000Z',
      },
      {
        account: 'acct_3',
        accountName: 'c@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T07:00:00.000Z',
      },
    ]);
    assert.deepEqual(status.routingAvailability.fable, [
      {
        account: 'acct_3',
        accountName: 'c@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T07:00:00.000Z',
      },
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T08:00:00.000Z',
      },
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T09:00:00.000Z',
      },
    ]);
  });

  // 母艦裁定 D-72 で credential_error の期待だけを unknown → needs-login へ反転した
  // （認証失効は時間では回復しないので「不明」と言わない）。並び順は変えていない——
  // needs-login は unknown とまったく同じ順位で扱う。
  it('reports unknown / needs-login after timed candidates when reset evidence or credentials are unusable', () => {
    const now = Date.parse('2026-08-29T05:00:00.000Z');
    const manager = new AccountManager({
      accounts: [
        { id: 'missing_reset', name: 'missing@example.com', type: 'oauth' },
        { id: 'credential_error', name: 'error@example.com', type: 'oauth' },
        { id: 'cooldown', name: 'cooldown@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => now,
    });
    manager.applyUsage('missing_reset', {
      five_hour: { utilization: 1 },
      seven_day: { utilization: 0.2, resets_at: '2026-09-01T05:00:00.000Z' },
    });
    for (const accountId of ['credential_error', 'cooldown']) {
      manager.applyUsage(accountId, {
        five_hour: { utilization: 0.2, resets_at: '2026-08-29T10:00:00.000Z' },
        seven_day: { utilization: 0.2, resets_at: '2026-09-01T05:00:00.000Z' },
      });
    }
    manager.markError('credential_error', 'oauth_refresh_failed', 'refresh failed');
    manager.markRateLimited('cooldown', 60 * 60);

    assert.deepEqual(manager.getStatus().routingAvailability.other, [
      {
        account: 'cooldown',
        accountName: 'cooldown@example.com',
        state: 'waiting',
        availableAt: '2026-08-29T06:00:00.000Z',
      },
      {
        account: 'missing_reset',
        accountName: 'missing@example.com',
        state: 'unknown',
        availableAt: null,
      },
      {
        account: 'credential_error',
        accountName: 'error@example.com',
        state: 'needs-login',
        availableAt: null,
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // R7-3（母艦裁定 D-72 の 4(ii)）: 認証失効の口座だけを needs-login として報告する。
  // 他の error は現行どおり unknown のままであり、並び順も1つも動かさない。
  // ---------------------------------------------------------------------------
  it('reports needs-login only for an expired credential, never for another account error', () => {
    const now = Date.parse('2026-08-29T05:00:00.000Z');
    const build = (type, message) => {
      const manager = new AccountManager({
        accounts: [
          { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
          { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        ],
        switchThreshold: 1,
        now: () => now,
      });
      for (const accountId of ['acct_1', 'acct_2']) {
        manager.applyUsage(accountId, {
          five_hour: { utilization: 0.2, resets_at: '2026-08-29T10:00:00.000Z' },
          seven_day: { utilization: 0.2, resets_at: '2026-09-01T05:00:00.000Z' },
        });
      }
      manager.markError('acct_1', type, message);
      return manager;
    };

    for (const type of ['oauth_refresh_failed', 'authentication_error']) {
      const status = build(type, 'OAuth token refresh failed').getStatus();
      for (const family of ['fable', 'other']) {
        const entry = status.routingAvailability[family].find(item => item.account === 'acct_1');
        assert.equal(entry.state, 'needs-login', `${type} / ${family}`);
        assert.equal(entry.availableAt, null, '回復見込み時刻は持たない（人が直すまで戻らない）');
      }
      assert.deepEqual(
        status.accounts[0].unavailableReason,
        { type, message: 'OAuth token refresh failed', at: '2026-08-29T05:00:00.000Z' },
        '台帳側の理由は、検出時刻が足された以外はそのまま（表示だけの変更である）',
      );
    }

    for (const type of ['account_error', 'upstream_error']) {
      const status = build(type, 'something else').getStatus();
      const entry = status.routingAvailability.other.find(item => item.account === 'acct_1');
      assert.equal(entry.state, 'unknown', `${type} は現行どおり unknown`);
    }
  });

  it('keeps the recovery order unchanged when an expired login sits next to an unknown one', () => {
    const now = Date.parse('2026-08-29T05:00:00.000Z');
    const manager = new AccountManager({
      accounts: [
        { id: 'first', name: 'first@example.com', type: 'oauth' },
        { id: 'second', name: 'second@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => now,
    });
    manager.markError('first', 'account_error', 'plain error');
    manager.markError('second', 'oauth_refresh_failed', 'refresh failed');

    assert.deepEqual(
      manager.getStatus().routingAvailability.other.map(entry => [entry.account, entry.state]),
      [['first', 'unknown'], ['second', 'needs-login']],
      'needs-login は unknown と同じ順位なので、並びは登録順のまま動かない',
    );
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

// ---------------------------------------------------------------------------
// (c) 認証失敗の原因コードと検出時刻の保持（母艦裁定 C-20260915-3F-03）
//
// 「認証が切れている」だけでは、いつ・何が原因で落ちたのかが分からず、
// 再ログインすべきかどうかを人が判断できない。markError に details を足して
// 原因コード（cause）と検出時刻（at）を台帳へ残し、再起動を挟んでも失わない。
// ---------------------------------------------------------------------------
describe('認証失敗の原因コードと検出時刻 (c)', () => {
  const buildManager = (now) => new AccountManager({
    accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    now,
  });

  it('keeps an explicitly detected time instead of overwriting it with the store time', () => {
    const detectedAt = '2026-09-15T01:00:00.000Z';
    const manager = buildManager(() => Date.parse('2026-09-15T01:05:00.000Z'));

    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: detectedAt,
    });

    assert.deepEqual(manager.getStatus().accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: detectedAt,
    }, '保存が5分遅れても、記録されるのは検出した時刻のほう');
  });

  it('accepts the detected time as epoch milliseconds too', () => {
    const manager = buildManager(() => Date.parse('2026-09-15T01:05:00.000Z'));

    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'http-401',
      at: Date.parse('2026-09-15T01:00:00.000Z'),
    });

    assert.equal(
      manager.getStatus().accounts[0].unavailableReason.at,
      '2026-09-15T01:00:00.000Z',
    );
  });

  it('still records the store time when no detected time is given', () => {
    const manager = buildManager(() => Date.parse('2026-09-15T01:05:00.000Z'));

    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    });

    assert.equal(
      manager.getStatus().accounts[0].unavailableReason.at,
      '2026-09-15T01:05:00.000Z',
    );
  });

  it('leaves an unparsable detected time to the clock rather than persisting it', () => {
    const manager = buildManager(() => Date.parse('2026-09-15T01:05:00.000Z'));

    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'http-401',
      at: 'not a timestamp',
    });

    assert.equal(
      manager.getStatus().accounts[0].unavailableReason.at,
      '2026-09-15T01:05:00.000Z',
    );
  });

  it('keeps the three-argument call working exactly as before', () => {
    const manager = buildManager(() => 1000);

    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');

    const reason = manager.getStatus().accounts[0].unavailableReason;
    assert.equal(manager.getStatus().accounts[0].status, 'error');
    assert.equal(reason.type, 'oauth_refresh_failed');
    assert.equal(reason.message, 'OAuth token refresh failed');
    assert.equal('cause' in reason, false, '原因が分からないときに cause を捏造しない');
    assert.equal(reason.at, '1970-01-01T00:00:01.000Z');
  });

  it('carries the cause and detected time through save and reload', () => {
    const detectedAt = '2026-09-15T01:00:00.000Z';
    const saved = buildManager(() => Date.parse('2026-09-15T01:00:00.000Z'));
    saved.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: detectedAt,
    });

    const restored = buildManager(() => Date.parse('2026-09-15T09:00:00.000Z'));
    restored.restoreState(saved.exportState());

    const reason = restored.getStatus().accounts[0].unavailableReason;
    assert.equal(restored.getStatus().accounts[0].status, 'error');
    assert.equal(reason.cause, 'NATIVE_REFRESH_REAUTH_REQUIRED');
    assert.equal(reason.at, detectedAt, '再起動しても検出時刻は起動時刻に置き換わらない');
  });

  it('restores a state file written before the cause and detected time existed', () => {
    const manager = buildManager(() => Date.parse('2026-09-15T09:00:00.000Z'));

    manager.restoreState({
      version: 1,
      currentAccount: 'acct_1',
      accounts: [{
        id: 'acct_1',
        status: 'error',
        quota: {},
        usage: {},
        rateLimitedUntil: null,
        temporaryUnavailableReason: null,
        errorReason: { type: 'oauth_refresh_failed', message: 'OAuth token refresh failed' },
      }],
    });

    const account = manager.getStatus().accounts[0];
    assert.equal(account.status, 'error');
    assert.deepEqual(account.unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
    }, '旧形式は欠けたまま読めればよい。無い検出時刻を後から作らない');
  });

  it('drops the cause and detected time when the credential identity changes', () => {
    const manager = new AccountManager({
      accounts: [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'revision-2',
      }],
      now: () => Date.parse('2026-09-15T09:00:00.000Z'),
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
        rateLimitedUntil: null,
        temporaryUnavailableReason: null,
        errorReason: {
          type: 'oauth_refresh_failed',
          message: 'OAuth token refresh failed',
          cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
          at: '2026-09-15T01:00:00.000Z',
        },
      }],
    });

    assert.equal(manager.accounts[0].errorReason, null, '別の資格情報の失敗理由を持ち越さない');
    assert.equal(manager.getStatus().accounts[0].unavailableReason, null);
  });

  it('drops the cause and detected time once the account authenticates again', () => {
    const manager = buildManager(() => Date.parse('2026-09-15T01:00:00.000Z'));
    manager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: '2026-09-15T01:00:00.000Z',
    });

    manager.applyUsage('acct_1', {
      five_hour: { utilization: 0.1, resets_at: null },
      seven_day: { utilization: 0.2, resets_at: null },
    });

    assert.equal(manager.accounts[0].errorReason, null);
    assert.equal(manager.getStatus().accounts[0].unavailableReason, null);
  });
});

describe('account_switch log line', () => {
  function collectingLogger() {
    const logger = line => logger.lines.push(line);
    logger.lines = [];
    return logger;
  }

  function switchLines(logger) {
    return logger.lines.filter(line => line.includes(' account_switch '));
  }

  it('writes one account_switch line for a proactive weekly-reset switch', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'soon-weekly', name: 'soon@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
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

    manager.rebalanceActiveAccount();

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=soon-weekly reason=weekly-reset-priority trigger=usage-refresh',
    ]);
  });

  it('writes one account_switch line when the usage refresh finds the current account unusable', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.rebalanceActiveAccount();

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=available reason=quota-threshold trigger=usage-refresh',
    ]);
  });

  it('writes one account_switch line for a reactive 429', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'lower-usage', name: 'lower@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '0.40',
      'anthropic-ratelimit-unified-7d-utilization': '0.45',
    });
    manager.updateQuota('lower-usage', {
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
    });
    const reactiveSelection = manager.bestAvailableSwitchCandidate({ excludeCurrent: false });

    manager.switchToCandidate(reactiveSelection, 'quota-threshold', '429');

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=lower-usage reason=quota-threshold trigger=429',
    ]);
  });

  it('writes one account_switch line when a request finds the current account unusable', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.getActiveAccount(null, { trigger: 'request' });

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=available reason=quota-threshold trigger=request',
    ]);
  });

  it('writes one account_switch line when the exhausted response picks the shortest reset', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'weekly-a', name: 'weekly-a@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
        { id: 'weekly-b', name: 'weekly-b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
      logger,
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

    manager.selectBestExhaustedFallback({ trigger: 'request' });

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=weekly-a to=dev reason=shortest-quota-reset trigger=request',
    ]);
  });

  it('writes one account_switch line for a manual switch', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });

    manager.switchTo('acct_2');

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=acct_1 to=acct_2 reason=manual trigger=manual',
    ]);
  });

  it('writes one account_switch line for prepare-resume', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.prepareResumeTarget();

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=available reason=resume-ready trigger=prepare-resume',
    ]);
  });

  it('writes one account_switch line for prepare-resume when every account is exhausted', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'weekly-a', name: 'weekly-a@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
        { id: 'weekly-b', name: 'weekly-b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
      logger,
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

    manager.prepareResumeTarget();

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=weekly-a to=dev reason=shortest-quota-reset trigger=prepare-resume',
    ]);
  });

  it('writes one account_switch line when a reload swaps the account at the unchanged index', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_a', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_b', name: 'b@example.com', type: 'oauth' },
        { id: 'acct_c', name: 'c@example.com', type: 'oauth' },
      ],
      currentAccountId: 'acct_b',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });

    manager.replaceAccounts([
      { id: 'acct_a', name: 'a@example.com', type: 'oauth' },
      { id: 'acct_c', name: 'c@example.com', type: 'oauth' },
    ]);

    assert.equal(manager.currentIndex, 1);
    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=acct_b to=acct_c reason=accounts-replaced trigger=reload',
    ]);
  });

  it('writes nothing when the reactive selection is the current account', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'higher-usage', name: 'higher@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '0.05',
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
    });
    manager.updateQuota('higher-usage', {
      'anthropic-ratelimit-unified-5h-utilization': '0.40',
      'anthropic-ratelimit-unified-7d-utilization': '0.45',
    });
    const reactiveSelection = manager.bestAvailableSwitchCandidate({ excludeCurrent: false });
    assert.equal(reactiveSelection.account.id, 'current');

    manager.switchToCandidate(reactiveSelection, 'quota-threshold', '429');

    assert.deepEqual(switchLines(logger), []);
    assert.equal(manager.getStatus().events[0].type, 'auto-switch');
  });

  it('writes nothing when a reload keeps the current account', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_a', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_b', name: 'b@example.com', type: 'oauth' },
      ],
      currentAccountId: 'acct_b',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });

    manager.replaceAccounts([
      { id: 'acct_a', name: 'a@example.com', type: 'oauth' },
      { id: 'acct_b', name: 'b@example.com', type: 'oauth' },
    ]);

    assert.deepEqual(switchLines(logger), []);
    assert.equal(manager.getStatus().events[0].type, 'reload');
  });

  it('defaults trigger to unknown when a caller does not pass one', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    manager.getActiveAccount();

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=available reason=quota-threshold trigger=unknown',
    ]);
  });

  it('normalizes an unrecognised trigger to unknown instead of throwing', () => {
    const logger = collectingLogger();
    const manager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'available', name: 'available@example.com', type: 'oauth' },
      ],
      currentAccountId: 'current',
      switchThreshold: 1,
      now: () => 1000,
      logger,
    });
    manager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '20',
    });
    manager.updateQuota('available', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });

    assert.doesNotThrow(() => manager.getActiveAccount(null, { trigger: 'bogus' }));

    assert.deepEqual(switchLines(logger), [
      '1970-01-01T00:00:01.000Z account_switch from=current to=available reason=quota-threshold trigger=unknown',
    ]);
  });
});

describe('familyQuotaExhaustedOnly / isCommonQuotaExhausted (D-56-3 / 設計書 §5)', () => {
  const NOW = Date.parse('2026-06-04T09:00:00.000Z');
  const FABLE_RESET = '2026-06-06T09:00:00.000Z';
  const LATER = '2026-06-08T09:00:00.000Z';

  function makeManager(ids = ['acct_1']) {
    return new AccountManager({
      accounts: ids.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      switchThreshold: 1,
      now: () => NOW,
    });
  }

  function fableSubCapOnly(manager, id) {
    manager.applyUsage(id, {
      five_hour: { utilization: 0.2, resets_at: LATER },
      seven_day: { utilization: 0.3, resets_at: LATER },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: FABLE_RESET }],
    });
    return manager.find(id);
  }

  it('is true only for a model-scoped exhaustion', () => {
    const manager = makeManager(['acct_1', 'healthy']);
    const scoped = fableSubCapOnly(manager, 'acct_1');
    manager.applyUsage('healthy', {
      five_hour: { utilization: 0.2, resets_at: LATER },
      seven_day: { utilization: 0.3, resets_at: LATER },
    });

    assert.equal(
      familyQuotaExhaustedOnly(scoped, manager.switchThreshold, 'fable', NOW),
      true,
      'the Fable sub-cap is the only exhausted window, so the Fable family is blocked',
    );
    assert.equal(
      familyQuotaExhaustedOnly(scoped, manager.switchThreshold, null, NOW),
      false,
      'a Fable-scoped window never blocks a non-Fable request',
    );
    assert.equal(
      familyQuotaExhaustedOnly(manager.find('healthy'), manager.switchThreshold, 'fable', NOW),
      false,
      'an account with no exhausted window at all is not "family-exhausted only"',
    );
    assert.equal(familyQuotaExhaustedOnly(null, manager.switchThreshold, 'fable', NOW), false);
  });

  it('is false when the common quota is exhausted', () => {
    const manager = makeManager(['both', 'commonOnly']);
    manager.applyUsage('both', {
      five_hour: { utilization: 1, resets_at: LATER },
      seven_day: { utilization: 0.3, resets_at: LATER },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: FABLE_RESET }],
    });
    manager.applyUsage('commonOnly', {
      five_hour: { utilization: 0.2, resets_at: LATER },
      seven_day: { utilization: 1, resets_at: LATER },
    });

    assert.equal(
      familyQuotaExhaustedOnly(manager.find('both'), manager.switchThreshold, 'fable', NOW),
      false,
      'a common window that is also exhausted makes this a global exhaustion, not a sub-cap one',
    );
    assert.equal(
      familyQuotaExhaustedOnly(manager.find('commonOnly'), manager.switchThreshold, 'fable', NOW),
      false,
    );
  });

  it('is false for a credential cooldown, a throttled account and an errored account', () => {
    const manager = makeManager(['cooldown', 'throttled', 'errored']);
    for (const id of ['cooldown', 'throttled', 'errored']) fableSubCapOnly(manager, id);
    manager.markCredentialRefreshRateLimited('cooldown', 300);
    manager.markRateLimited('throttled', 300);
    manager.markError('errored', 'authentication_error', 'OAuth token rejected');

    for (const id of ['cooldown', 'throttled', 'errored']) {
      assert.equal(
        familyQuotaExhaustedOnly(manager.find(id), manager.switchThreshold, 'fable', NOW),
        false,
        `${id}: the binding must not be treated as a sub-cap exhaustion (D-56-3)`,
      );
      assert.equal(
        isCommonQuotaExhausted(manager.find(id), manager.switchThreshold),
        false,
        `${id}: neither predicate may claim a quota exhaustion for this account`,
      );
    }
  });

  it('delegates isCommonQuotaExhausted to the family-independent windows only', () => {
    const manager = makeManager(['fiveHour', 'sevenDay', 'tokenRate', 'scoped']);
    manager.applyUsage('fiveHour', { five_hour: { utilization: 1, resets_at: LATER } });
    manager.applyUsage('sevenDay', { seven_day: { utilization: 1, resets_at: LATER } });
    manager.updateQuota('tokenRate', {
      'anthropic-ratelimit-tokens-limit': '100',
      'anthropic-ratelimit-tokens-remaining': '0',
    });
    fableSubCapOnly(manager, 'scoped');

    assert.deepEqual([
      isCommonQuotaExhausted(manager.find('fiveHour'), manager.switchThreshold),
      isCommonQuotaExhausted(manager.find('sevenDay'), manager.switchThreshold),
      isCommonQuotaExhausted(manager.find('tokenRate'), manager.switchThreshold),
      isCommonQuotaExhausted(manager.find('scoped'), manager.switchThreshold),
      isCommonQuotaExhausted(null, manager.switchThreshold),
    ], [true, true, true, false, false]);
  });
});

describe('findOrNull (設計書 §5)', () => {
  function makeManager() {
    return new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
  }

  it('returns the account for a known id or name', () => {
    const manager = makeManager();

    assert.equal(manager.findOrNull('acct_1').id, 'acct_1');
    assert.equal(manager.findOrNull('a@example.com').id, 'acct_1');
  });

  it('returns null where find() throws, so a removed binding can be detected', () => {
    const manager = makeManager();

    assert.throws(() => manager.find('gone'), /Unknown account: gone/);
    assert.equal(manager.findOrNull('gone'), null);
    assert.equal(manager.findOrNull(null), null);
    assert.equal(manager.findOrNull(''), null);
    assert.equal(manager.findOrNull(undefined), null);
  });
});

describe('selectForNewAssignment (D-56-1 / D-60-4 / 設計書 §4.2)', () => {
  const NOW = Date.parse('2026-06-04T09:00:00.000Z');
  // 36h の週次リセット優先窓（DEFAULT_WEEKLY_RESET_PRIORITY_WINDOW_MS）の内と外。
  const SOON_WEEKLY = '2026-06-04T15:00:00.000Z'; // NOW + 6h  -> weeklyResetPriority = true
  const LATE_WEEKLY = '2026-06-08T09:00:00.000Z'; // NOW + 4d  -> weeklyResetPriority = false
  const FIVE_HOUR_RESET = '2026-06-04T12:00:00.000Z';

  function makeManager(ids) {
    return new AccountManager({
      accounts: ids.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      switchThreshold: 1,
      now: () => NOW,
    });
  }

  /** `residual` は「残率」。utilization = 1 - residual で使用量へ直して台帳へ入れる。 */
  function setWindows(manager, id, { fiveHour = null, weekly = null, weeklyResetAt = LATE_WEEKLY, fableSubCap = null }) {
    const payload = {};
    if (fiveHour != null) payload.five_hour = { utilization: 1 - fiveHour, resets_at: FIVE_HOUR_RESET };
    if (weekly != null) payload.seven_day = { utilization: 1 - weekly, resets_at: weeklyResetAt };
    if (fableSubCap != null) {
      payload.scoped_weekly = [
        { key: 'fable', label: 'Fable', utilization: 1 - fableSubCap, resets_at: LATE_WEEKLY },
      ];
    }
    manager.applyUsage(id, payload);
  }

  function existingComparatorPick(manager, modelFamily = null) {
    return manager.bestAvailableSwitchCandidate({ excludeCurrent: false, modelFamily })?.account.id ?? null;
  }

  it('§4.2 例①: prefers 90% headroom over an 11% account whose weekly window resets sooner', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0.11, weekly: 0.80, weeklyResetAt: SOON_WEEKLY });
    setWindows(manager, 'cand2', { fiveHour: 0.90, weekly: 0.95, weeklyResetAt: LATE_WEEKLY });

    assert.equal(
      existingComparatorPick(manager),
      'cand1',
      '既存比較器は weeklyResetPriority が第0キーなので残 11% を無条件に先着させる（§4.2 (a)）',
    );
    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'cand2',
      'cand1 は best(0.90) の 5 ポイント帯域から外れるので週次リセット優先まで到達しない',
    );
  });

  it('§4.2 例②: never hands a new Fable session to an account whose Fable sub-cap is at 95%', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0.80, weekly: 0.70, fableSubCap: 0.05 });
    setWindows(manager, 'cand2', { fiveHour: 0.60, weekly: 0.50, fableSubCap: 0.90 });

    assert.equal(
      existingComparatorPick(manager, 'fable'),
      'cand1',
      '既存の maxUtilization は 5h/7d しか見ないので F7d 残 5% の口座を選ぶ（§4.2 (b)）',
    );
    assert.equal(
      manager.selectForNewAssignment({ modelFamily: 'fable', assignStopUtilization: 0.9 })?.id,
      'cand2',
      'headroom が F7d を同列に入れるので cand1 の min は 0.05 になり割当停止ゲートで落ちる',
    );
    assert.equal(
      manager.selectForNewAssignment({ modelFamily: null, assignStopUtilization: 0.9 })?.id,
      'cand1',
      '非 Fable の要求では F7d を見ないので cand1 が残る（scopeMatchesModelFamily）',
    );
  });

  it('§4.2 例③: breaks an exact tie by the number of sessions already bound', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0.80, weekly: 0.70 });
    setWindows(manager, 'cand2', { fiveHour: 0.80, weekly: 0.70 });

    assert.equal(
      existingComparatorPick(manager),
      'cand1',
      '既存比較器の最終キーは台帳順なので常に同じ口座へ寄る（§4.2 (c)）',
    );
    assert.equal(
      manager.selectForNewAssignment({
        assignStopUtilization: 0.9,
        sessionCounts: new Map([['cand1', 12], ['cand2', 1]]),
      })?.id,
      'cand2',
      'K3（バインド済みセッション数）が台帳順より前にあるので必ず効く',
    );
    assert.equal(
      manager.selectForNewAssignment({
        assignStopUtilization: 0.9,
        sessionCounts: { cand1: 12, cand2: 1 },
      })?.id,
      'cand2',
      'summary().sessionsByAccount のような素のオブジェクトでも同じ結果になる',
    );
  });

  it('§4.2 例④: one missing window must not push a known candidate out of the band', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0.40, weekly: 0.60 });
    setWindows(manager, 'cand2', { fiveHour: 0.95 }); // 7d の利用率が取得できない

    assert.equal(
      existingComparatorPick(manager),
      'cand2',
      '既存の maxUtilization は取得できた窓だけから作られるので欠測の口座が勝つ',
    );
    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'cand1',
      '欠測候補は帯域を決める前に分離されるので、帯域は既知の cand1 だけで決まる（D-60-4）',
    );
  });

  it('disables the assign-stop gate when no account clears it (R1)', () => {
    const manager = makeManager(['low', 'lower']);
    setWindows(manager, 'low', { fiveHour: 0.08, weekly: 0.90 });
    setWindows(manager, 'lower', { fiveHour: 0.02, weekly: 0.90 });

    const selected = manager.selectForNewAssignment({ assignStopUtilization: 0.9 });

    assert.equal(selected?.id, 'low', 'ゲートを無効化したうえで残枠の大きい方を選ぶ');
  });

  it('honours the exclusion set and returns null once every account is excluded', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0.90, weekly: 0.90 });
    setWindows(manager, 'cand2', { fiveHour: 0.40, weekly: 0.40 });

    assert.equal(manager.selectForNewAssignment({})?.id, 'cand1');
    assert.equal(
      manager.selectForNewAssignment({ excludeAccountIds: new Set(['cand1']) })?.id,
      'cand2',
      'attemptedAccountIds をそのまま渡せる（Set）',
    );
    assert.equal(
      manager.selectForNewAssignment({ excludeAccountIds: ['cand1'] })?.id,
      'cand2',
      '配列でも同じ',
    );
    assert.equal(manager.selectForNewAssignment({ excludeAccountIds: ['cand1', 'cand2'] }), null);
  });

  it('lets the weekly-reset priority decide only inside the band', () => {
    const manager = makeManager(['soon', 'late']);
    setWindows(manager, 'soon', { fiveHour: 0.80, weekly: 0.90, weeklyResetAt: SOON_WEEKLY });
    setWindows(manager, 'late', { fiveHour: 0.82, weekly: 0.90, weeklyResetAt: LATE_WEEKLY });

    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'soon',
      'best=0.82 の帯域（0.77 以上）に両方入るので K1 の週次リセット優先が効く',
    );
  });

  it('keeps a candidate exactly five points below the best inside the band', () => {
    const manager = makeManager(['best', 'edge']);
    setWindows(manager, 'best', { fiveHour: 0.90, weekly: 0.90, weeklyResetAt: LATE_WEEKLY });
    setWindows(manager, 'edge', { fiveHour: 0.85, weekly: 0.90, weeklyResetAt: SOON_WEEKLY });

    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'edge',
      '帯域はちょうど 5 ポイントまでを含む（0.90 - 0.05 の二進小数誤差で落とさない）',
    );
  });

  it('uses candidates with a missing window only when no complete candidate is left (D-60-4)', () => {
    const manager = makeManager(['knownSmall', 'missingLarge']);
    setWindows(manager, 'knownSmall', { fiveHour: 0.30, weekly: 0.40 });
    setWindows(manager, 'missingLarge', { fiveHour: 0.70 });

    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'knownSmall',
      '既知候補が1つでもあれば欠測候補は使わない',
    );
    assert.equal(
      manager.selectForNewAssignment({
        assignStopUtilization: 0.9,
        excludeAccountIds: ['knownSmall'],
      })?.id,
      'missingLarge',
      '既知候補が0になって初めて欠測候補が順位付けの対象になる',
    );
  });

  it('keeps an account whose windows are all missing as a candidate (R1)', () => {
    const manager = makeManager(['unknown', 'known']);

    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'unknown',
      '全窓欠測でも候補から外さない（使用量が未取得の口座で要求を止めない）',
    );

    setWindows(manager, 'known', { fiveHour: 0.30, weekly: 0.30 });

    assert.equal(
      manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id,
      'known',
      '既知候補があるときは全窓欠測の口座を選ばない',
    );
  });

  it('returns null when every account is unavailable so the caller keeps the current exhausted path (R1)', () => {
    const manager = makeManager(['cand1', 'cand2']);
    setWindows(manager, 'cand1', { fiveHour: 0, weekly: 0.90 });
    setWindows(manager, 'cand2', { fiveHour: 0, weekly: 0.90 });

    assert.equal(manager.selectForNewAssignment({}), null);
  });

  it('does not multiply quota-exhausted events when the selector evaluates the same account repeatedly', () => {
    const manager = makeManager(['exhausted', 'healthy']);
    setWindows(manager, 'exhausted', { fiveHour: 0, weekly: 0.90 });
    setWindows(manager, 'healthy', { fiveHour: 0.80, weekly: 0.80 });

    const before = manager.events.filter(event => event.type === 'quota-exhausted').length;
    for (let i = 0; i < 50; i += 1) {
      assert.equal(manager.selectForNewAssignment({ assignStopUtilization: 0.9 })?.id, 'healthy');
    }
    const after = manager.events.filter(event => event.type === 'quota-exhausted').length;

    assert.equal(before, 1, '枯渇は台帳へ取り込んだ時点で1件だけ積まれている');
    assert.equal(after, 1, 'セレクタが同じ口座を何度評価しても quota-exhausted は増えない（I-3）');
  });
});
