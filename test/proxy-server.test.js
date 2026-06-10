import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';

describe('createProxyServer', () => {
  it('forwards requests with the selected OAuth token and records quota headers', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push({
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.76',
        'anthropic-ratelimit-unified-7d-utilization': '0.33',
        'anthropic-ratelimit-unified-5h-reset': '1780582800',
      });
      res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 }, ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
      headers: { 'x-api-key': 'client-key' },
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamSeen[0].authorization, 'Bearer access-token-1');
    assert.equal(upstreamSeen[0].apiKey, undefined);

    const status = accountManager.getStatus();
    assert.equal(status.accounts[0].quota.unified5h, 0.76);
    assert.equal(status.accounts[0].usage.totalInputTokens, 10);
    assert.equal(status.accounts[0].usage.totalOutputTokens, 20);

    await close(proxy.server);
    await close(upstream.server);
  });

  it('refreshes an expired OAuth token before forwarding', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push({ authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-1',
      expiresAt: 900,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async refreshToken => {
        assert.equal(refreshToken, 'refresh-token-1');
        return {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: 100000,
        };
      },
    }));

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamSeen[0].authorization, 'Bearer fresh-token');
    assert.deepEqual(await secretStore.get('acct_1'), {
      accessToken: 'fresh-token',
      refreshToken: 'refresh-token-2',
      expiresAt: 100000,
    });

    await close(proxy.server);
    await close(upstream.server);
  });

  it('uses live Claude Code credentials for the current account', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('current', {
      accessToken: 'stale-stored-token',
      refreshToken: 'stale-stored-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'current', name: 'current', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      currentCredentialReader: async () => ({
        accessToken: 'live-claude-code-token',
        refreshToken: 'live-claude-code-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer live-claude-code-token']);
  });

  it('records proxy request diagnostics without secrets', async t => {
    const logLines = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'request-id': 'req_diagnostic_1',
      });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      logger: line => logLines.push(line),
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
      headers: { authorization: 'Bearer client-token', 'x-api-key': 'client-key' },
    });

    assert.equal(response.status, 200);
    const event = accountManager.getStatus().events.find(item => item.type === 'proxy-request');
    assert.equal(event.account, 'acct_1');
    assert.equal(event.method, 'POST');
    assert.equal(event.path, '/v1/messages');
    assert.equal(event.statusCode, 200);
    assert.equal(event.requestId, 'req_diagnostic_1');
    assert.equal(event.outcome, 'ok');
    assert.equal(typeof event.durationMs, 'number');

    const serialized = JSON.stringify(accountManager.getStatus()) + logLines.join('\n');
    assert.equal(serialized.includes('access-token-1'), false);
    assert.equal(serialized.includes('client-token'), false);
    assert.equal(serialized.includes('client-key'), false);
    assert.match(logLines.join('\n'), /proxy account=acct_1 method=POST path=\/v1\/messages status=200/);
  });

  it('refreshes and retries once when upstream rejects the OAuth token', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (upstreamSeen.length === 1) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'stale-token',
      refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async refreshToken => {
        assert.equal(refreshToken, 'refresh-token-1');
        return {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: 200000,
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer stale-token', 'Bearer fresh-token']);
    assert.deepEqual(await secretStore.get('acct_1'), {
      accessToken: 'fresh-token',
      refreshToken: 'refresh-token-2',
      expiresAt: 200000,
    });
  });

  it('passes through a non-refreshable OAuth rejection without switching accounts', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(401, { 'Content-Type': 'application/json', 'request-id': 'req_current_401' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid authentication credentials' },
      }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_2', {
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      currentCredentialReader: async () => ({
        accessToken: 'live-current-token',
        refreshToken: 'live-current-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/api/oauth/profile`);

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid authentication credentials' },
    });
    assert.deepEqual(upstreamSeen, ['Bearer live-current-token']);
    assert.equal(accountManager.getStatus().currentAccount, 'current');
    assert.deepEqual(accountManager.getStatus().accounts[0].unavailableReason, {
      type: 'authentication_error',
      message: 'OAuth token rejected',
    });
  });

  it('switches to the emptiest known account when the current account reaches quota', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'request-id': 'req_quota_1',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': '10',
        });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: '5h quota exhausted' },
        }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': 'req_ok_3' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    await secretStore.set('acct_3', { accessToken: 'access-token-3' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        { id: 'acct_3', name: 'c@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.9',
      'anthropic-ratelimit-unified-7d-utilization': '0.4',
    });
    accountManager.updateQuota('acct_3', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-utilization': '0.3',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-3']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_3');
  });

  it('passes through retryable server errors without switching accounts', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'request-id': 'req_retryable_500',
        'x-should-retry': 'true',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'temporary upstream failure' },
      }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 500);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
    assert.match(response.body.error.message, /temporary upstream failure/);
  });

  it('passes through a retryable server error when no alternate account is available', async t => {
    const upstreamBody = {
      type: 'error',
      error: { type: 'api_error', message: 'temporary upstream failure' },
    };
    const upstream = await listen(http.createServer(async (req, res) => {
      res.writeHead(529, {
        'Content-Type': 'application/json',
        'request-id': 'req_only_529',
        'x-should-retry': 'true',
      });
      res.end(JSON.stringify(upstreamBody));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 529);
    assert.equal(response.headers['request-id'], 'req_only_529');
    assert.deepEqual(response.body, upstreamBody);
    assert.notEqual(response.body.error.message, 'All configured accounts are unavailable.');
  });

  it('returns an upstream timeout without switching accounts', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tooLate: true }));
      }, 250);
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        proxy: { upstreamIdleTimeoutMs: 50 },
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
      timeoutMs: 500,
    });

    assert.equal(response.status, 504);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
    assert.equal(response.body.error.type, 'upstream_timeout');
  });

  it('does not rotate after a streaming response has already started', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n');
      setTimeout(() => res.destroy(new Error('stream interrupted')), 25);
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        proxy: { upstreamIdleTimeoutMs: 50 },
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    await assert.rejects(
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet' }),
        timeoutMs: 500,
      }),
      /aborted|socket hang up|ECONNRESET|Parse Error|stream interrupted/,
    );

    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('keeps the current account when refreshing an expired token fails', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'invalid-refresh-token',
      expiresAt: 900,
    });
    await secretStore.set('acct_2', {
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        throw new Error('refresh token revoked');
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer expired-token']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
    assert.deepEqual(accountManager.getStatus().accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
    });
  });

  it('switches to a known available account when the current OAuth refresh fails', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'invalid-refresh-token',
      expiresAt: 900,
    });
    await secretStore.set('acct_2', {
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async refreshToken => {
        if (refreshToken === 'invalid-refresh-token') throw new Error('refresh token revoked');
        return { accessToken: 'fresh-token-2', refreshToken };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-2']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_2');
    assert.equal(accountManager.getStatus().accounts[0].status, 'error');
  });

  it('returns local quota exhaustion when the only account is exhausted', async t => {
    const upstreamSeen = [];
    const upstreamBody = {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: "You've hit your session limit · resets 1:20am",
      },
    };
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': '10',
      });
      res.end(JSON.stringify(upstreamBody));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, []);
    assert.equal(response.body.error.type, 'rate_limit_error');
    assert.match(response.body.error.message, /You've hit your session limit/);
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'five_hour');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], '10');
    assert.equal(response.headers['anthropic-ratelimit-unified-5h-utilization'], '1');
    assert.doesNotMatch(response.body.error.message, /monthly spend limit/i);
    assert.equal(response.body.error.details.window, '5h');
    assert.match(response.body.error.details.rotator_message, /Claude 5h usage limit exhausted/);
    assert.notEqual(response.body.error.details.rotator_message, 'All configured accounts are unavailable.');
  });

  it('overrides a misleading upstream monthly limit message when local usage is 5h exhausted', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': '10',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: "You've hit your monthly spend limit.",
        },
      }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.match(response.body.error.message, /You've hit your session limit/);
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'five_hour');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], '10');
    assert.doesNotMatch(response.body.error.message, /monthly spend limit/i);
    assert.match(response.body.error.details.rotator_message, /Claude 5h usage limit exhausted/);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.window, '5h');
  });

  it('does not fall back to a quota-exhausted account when the current account is errored', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer live-current-token') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: "You've hit your session limit · resets 1:20am",
          },
        }));
        return;
      }

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid authentication credentials' },
      }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('other', {
      accessToken: 'stale-other-token',
      refreshToken: 'stale-other-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current', type: 'oauth' },
        { id: 'other', name: 'other@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    accountManager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    accountManager.switchTo('other');
    accountManager.markError('other', 'oauth_refresh_failed', 'OAuth token refresh failed');
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      currentCredentialReader: async () => ({
        accessToken: 'live-current-token',
        refreshToken: 'live-current-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(upstreamSeen, ['Bearer stale-other-token']);
    assert.equal(response.body.error.type, 'authentication_error');
    assert.equal(accountManager.getStatus().currentAccount, 'other');
  });

  it('returns local quota exhaustion when all accounts are exhausted', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer dev-token') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: "You've hit your session limit · resets 10:20pm",
          },
        }));
        return;
      }

      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: "You've hit your weekly limit · resets Jun 11 at 9pm",
        },
      }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('weekly-a', { accessToken: 'weekly-a-token' });
    await secretStore.set('dev', { accessToken: 'dev-token' });
    await secretStore.set('weekly-b', { accessToken: 'weekly-b-token' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'weekly-a', name: 'weekly-a@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
        { id: 'weekly-b', name: 'weekly-b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.updateQuota('weekly-a', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '100',
    });
    accountManager.updateQuota('dev', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
      'anthropic-ratelimit-unified-7d-utilization': '0.41',
    });
    accountManager.updateQuota('weekly-b', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': '50',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, []);
    assert.match(response.body.error.message, /You've hit your weekly limit/);
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'seven_day');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], '100');
    assert.equal(response.headers['anthropic-ratelimit-unified-7d-utilization'], '1');
    assert.equal(response.body.error.details.window, '7d');
    assert.match(response.body.error.details.rotator_message, /Claude 7d usage limit exhausted/);
    assert.equal(accountManager.getStatus().currentAccount, 'weekly-a');
  });

  it('waits for initial usage refresh before forwarding the first API request', async t => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('weekly', { accessToken: 'weekly-token' });
    await secretStore.set('dev', { accessToken: 'dev-token' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'weekly', name: 'weekly@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => Date.parse('2026-06-08T06:00:00Z'),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: true } },
      usageFetcher: async token => {
        if (token === 'weekly-token') {
          return {
            seven_day: { utilization: 1, resets_at: '2026-06-11T12:00:00Z' },
          };
        }
        return {
          five_hour: { utilization: 0.11, resets_at: '2026-06-08T10:50:00Z' },
          seven_day: { utilization: 0.03, resets_at: '2026-06-15T03:00:00Z' },
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer dev-token']);
    assert.equal(accountManager.getStatus().currentAccount, 'dev');
  });

  it('refreshes OAuth usage into status for inactive accounts', async t => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('dev', { accessToken: 'dev-token' });
    await secretStore.set('account-two', { accessToken: 'account-two-token' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'account-two', name: 'account-two@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      currentAccountId: 'dev',
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async token => {
        if (token === 'dev-token') {
          return {
            five_hour: { utilization: 1, resets_at: '2026-06-07T13:20:00Z' },
            seven_day: { utilization: 0.41, resets_at: '2026-06-13T10:00:00Z' },
          };
        }
        return {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: 1, resets_at: '2026-06-11T12:00:00Z' },
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const status = refresh.body.status;

    assert.equal(refresh.status, 200);
    assert.equal(status.currentAccount, 'dev');
    assert.equal(status.accounts[0].quota.unified5h, 0);
    assert.equal(status.accounts[0].quota.unified7d, 1);
    assert.equal(status.accounts[0].status, 'exhausted');
    assert.equal(status.accounts[0].unavailableReason.window, '7d');
    assert.equal(status.accounts[1].quota.unified5h, 1);
    assert.equal(status.accounts[1].quota.unified7d, 0.41);
    assert.equal(status.accounts[1].status, 'exhausted');
    assert.equal(status.accounts[1].unavailableReason.window, '5h');
    assert.equal(JSON.stringify(refresh.body).includes('dev-token'), false);
    assert.equal(JSON.stringify(refresh.body).includes('account-two-token'), false);
  });

  it('waits for the initial OAuth usage refresh before returning status', async t => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: true },
      },
      usageFetcher: async () => ({
        five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:20:00Z' },
        seven_day: { utilization: 0.5, resets_at: '2026-06-13T10:00:00Z' },
      }),
    }));
    t.after(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/status`);

    assert.equal(response.status, 200);
    assert.equal(response.body.accounts[0].quota.unified5h, 0.25);
    assert.equal(response.body.accounts[0].quota.unified7d, 0.5);
    assert.equal(response.body.accounts[0].status, 'active');
  });

  it('refreshes exhausted usage again at the reported reset time', async t => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => Date.now(),
    });
    let calls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: true, resetCheckDelayMs: 5 },
      },
      usageFetcher: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            five_hour: { utilization: 0.2, resets_at: null },
            seven_day: {
              utilization: 1,
              resets_at: new Date(Date.now() + 25).toISOString(),
            },
          };
        }
        return {
          five_hour: { utilization: 0.2, resets_at: null },
          seven_day: { utilization: 0, resets_at: null },
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
    });

    const first = await requestJson(`${proxy.url}/internal/status`);
    assert.equal(first.body.accounts[0].status, 'exhausted');
    assert.equal(first.body.accounts[0].unavailableReason.window, '7d');

    await sleep(80);
    const second = await requestJson(`${proxy.url}/internal/status`);

    assert.ok(calls >= 2);
    assert.equal(second.body.accounts[0].quota.unified7d, 0);
    assert.equal(second.body.accounts[0].status, 'active');
  });

  it('periodically refreshes usage and switches before the next API request', async t => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 0.99,
      now: () => Date.now(),
    });
    let accountOneRefreshes = 0;
    const soonResetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const laterResetAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: true, intervalMs: 5 },
      },
      usageFetcher: async token => {
        if (token === 'access-token-1') {
          accountOneRefreshes += 1;
          const utilization = accountOneRefreshes >= 2 ? 1 : 0.5;
          return {
            five_hour: { utilization, resets_at: soonResetAt },
            seven_day: { utilization: 0.35, resets_at: laterResetAt },
          };
        }
        return {
          five_hour: { utilization: 0.1, resets_at: soonResetAt },
          seven_day: { utilization: 0.2, resets_at: laterResetAt },
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
    });

    const status = await waitForStatus(
      () => accountManager.getStatus(),
      status => status.currentAccount === 'acct_2'
    );

    assert.ok(accountOneRefreshes >= 2);
    assert.equal(status.currentAccount, 'acct_2');
    assert.equal(status.accounts[0].status, 'exhausted');
    assert.equal(status.accounts[1].status, 'active');
  });

  it('periodically refreshes usage and proactively switches to an account with a soon weekly reset', async t => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('current', { accessToken: 'access-token-current' });
    await secretStore.set('soon-weekly', { accessToken: 'access-token-soon' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'current', name: 'current@example.com', type: 'oauth' },
        { id: 'soon-weekly', name: 'soon@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => Date.now(),
    });
    const soonResetAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const laterResetAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: true, intervalMs: 5 },
      },
      usageFetcher: async token => {
        if (token === 'access-token-current') {
          return {
            five_hour: { utilization: 0.12, resets_at: soonResetAt },
            seven_day: { utilization: 0.30, resets_at: laterResetAt },
          };
        }
        return {
          five_hour: { utilization: 0.33, resets_at: soonResetAt },
          seven_day: { utilization: 0.07, resets_at: soonResetAt },
        };
      },
    }));
    t.after(async () => {
      await close(proxy.server);
    });

    const status = await waitForStatus(
      () => accountManager.getStatus(),
      value => value.currentAccount === 'soon-weekly'
    );

    assert.equal(status.currentAccount, 'soon-weekly');
    assert.equal(status.events[0].reason, 'weekly-reset-priority');
  });

  it('exposes health and status without secrets', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1' },
    }));

    const health = await requestJson(`${proxy.url}/internal/health`);
    const status = await requestJson(`${proxy.url}/internal/status`);

    assert.equal(health.body.ok, true);
    assert.equal(status.body.currentAccount, 'acct_1');
    assert.equal(JSON.stringify(status.body).includes('access-token-1'), false);

    await close(proxy.server);
  });

  it('reloads accounts from the current config without restarting the server', async () => {
    const secretStore = new MemorySecretStore();
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1' },
      reloadAccounts: async () => [
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
    }));

    const response = await requestJson(`${proxy.url}/internal/reload`, {
      method: 'POST',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.currentAccount, 'acct_2');
    assert.equal(response.body.accounts[0].name, 'b@example.com');

    await close(proxy.server);
  });
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForStatus(readStatus, predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  let status = readStatus();
  while (!predicate(status) && Date.now() - startedAt < timeoutMs) {
    await sleep(10);
    status = readStatus();
  }
  return status;
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        settled = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bodyText: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('aborted', () => {
        if (!settled) {
          settled = true;
          reject(new Error('response aborted'));
        }
      });
      res.on('error', error => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
    req.on('error', error => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`test client timeout after ${options.timeoutMs}ms`));
      });
    }
    if (options.body) req.write(options.body);
    req.end();
  });

  return {
    ...response,
    body: response.bodyText ? JSON.parse(response.bodyText) : null,
  };
}
