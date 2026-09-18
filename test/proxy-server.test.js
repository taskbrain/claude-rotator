import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountManager, familyQuotaExhaustedOnly } from '../src/account-manager.js';
import { LOCAL_GATEWAY_AUTH_TOKEN } from '../src/config.js';
import { renderStatus } from '../src/monitor.js';
import { OAuthTokenRefreshError, parseUsageResponse } from '../src/oauth.js';
import { LinuxFileSecretStore, MemorySecretStore } from '../src/secret-store.js';
import { sidHash } from '../src/session-affinity.js';
import { createProxyServer, defaultTokenRefresher } from '../src/proxy-server.js';

const cleanupCallbacks = [];

afterEach(async () => {
  const callbacks = cleanupCallbacks.splice(0).reverse();
  for (const callback of callbacks) await callback();
});

function cleanupAfterTest(callback) {
  cleanupCallbacks.push(callback);
}

describe('defaultTokenRefresher', () => {
  it('uses the native Claude Code adapter on Ubuntu/Linux and macOS', () => {
    const calls = [];
    const nativeRefresherFactory = options => {
      calls.push(options);
      return `native-${options.platform}`;
    };
    const directRefresher = () => 'direct';

    assert.equal(defaultTokenRefresher({
      platform: 'linux',
      nativeRefresherFactory,
      directRefresher,
      nativeOptions: { marker: 'linux-test' },
    }), 'native-linux');
    assert.equal(defaultTokenRefresher({
      platform: 'darwin',
      nativeRefresherFactory,
      directRefresher,
      nativeOptions: { marker: 'mac-test' },
    }), 'native-darwin');
    assert.deepEqual(calls, [
      { marker: 'linux-test', platform: 'linux' },
      { marker: 'mac-test', platform: 'darwin' },
    ]);
  });

  it('keeps the direct OAuth refresher as the fallback on other platforms', () => {
    const directRefresher = () => 'direct';

    assert.equal(defaultTokenRefresher({
      platform: 'win32',
      nativeRefresherFactory: () => assert.fail('native adapter must not be selected'),
      directRefresher,
    }), directRefresher);
  });
});

describe('createProxyServer', () => {
  it('replaces the local gateway placeholder with the selected OAuth token', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push({
        url: req.url,
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
        beta: req.headers['anthropic-beta'],
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
      headers: {
        authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
        'anthropic-beta': 'example-capability',
        'x-api-key': 'client-key',
      },
    });
    const duplicateResponse = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
      headers: {
        authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
        'anthropic-beta': 'oauth-2025-04-20,example-capability,oauth-2025-04-20',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(duplicateResponse.status, 200);
    assert.equal(upstreamSeen[0].authorization, 'Bearer access-token-1');
    assert.equal(upstreamSeen[0].apiKey, undefined);
    assert.deepEqual(
      upstreamSeen[0].beta.split(','),
      ['example-capability', 'oauth-2025-04-20'],
    );
    assert.deepEqual(
      upstreamSeen[1].beta.split(','),
      ['example-capability', 'oauth-2025-04-20'],
    );

    const status = accountManager.getStatus();
    assert.equal(status.accounts[0].quota.unified5h, 0.76);
    assert.equal(status.accounts[0].usage.totalInputTokens, 20);
    assert.equal(status.accounts[0].usage.totalOutputTokens, 40);

    await close(proxy.server);
    await close(upstream.server);
  });

  it('replaces the local gateway placeholder with a selected API key without OAuth capability', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push({
        authorization: req.headers.authorization,
        apiKey: req.headers['x-api-key'],
        beta: req.headers['anthropic-beta'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('api_account', { apiKey: 'selected-api-key' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'api_account', name: 'api-account', type: 'apikey' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
    }));

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
      headers: {
        authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
        'anthropic-beta': 'example-capability',
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, [{
      authorization: undefined,
      apiKey: 'selected-api-key',
      beta: 'example-capability',
    }]);

    await close(proxy.server);
    await close(upstream.server);
  });

  it('does not apply a delayed old-identity response quota or usage to a reloaded same-id account', async () => {
    let releaseResponse;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    let markUpstreamStarted;
    const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
    const upstream = await listen(http.createServer(async (_req, res) => {
      markUpstreamStarted();
      await responseGate;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.9',
      });
      res.end(JSON.stringify({ usage: { input_tokens: 11, output_tokens: 7 }, ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'old-access-token' });
    const accountManager = new AccountManager({
      accounts: [{
        id: 'acct_1', type: 'oauth', accountUuid: 'uuid-old', credentialRevision: 'revision-old',
      }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => {
        throw new Error('live Claude Code credential lookup should not run in this test');
      },
    }));
    cleanupAfterTest(async () => {
      releaseResponse?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
    });
    await upstreamStarted;
    const oldAccount = accountManager.find('acct_1');
    accountManager.replaceAccounts([{
      id: 'acct_1', type: 'oauth', accountUuid: 'uuid-new', credentialRevision: 'revision-new',
    }]);
    const newAccount = accountManager.find('acct_1');
    assert.notEqual(newAccount, oldAccount);
    releaseResponse();

    const response = await responsePending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      usage: { input_tokens: 11, output_tokens: 7 }, ok: true,
    });
    assert.equal(newAccount.quota.unified5h, null);
    assert.deepEqual(newAccount.usage, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreation1hTokens: 0,
      totalCacheCreation5mTokens: 0,
      totalRequests: 0,
      lastUsed: null,
    });
    assert.equal(
      accountManager.events.some(event => event.type === 'proxy-request' && event.account === 'acct_1'),
      false,
    );
  });

  it('returns a delayed old-identity quota response without replaying it after same-id reload', async () => {
    const upstreamSeen = [];
    let releaseBody;
    const bodyGate = new Promise(resolve => { releaseBody = resolve; });
    const resetAt = String(Math.floor(Date.parse(futureReset()) / 1000));
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'old identity quota' },
    };
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer old-access-token') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reload-test': 'old-identity',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': resetAt,
        });
        res.flushHeaders();
        await bodyGate;
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ replayed: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'old-access-token' });
    await secretStore.set('acct_2', { accessToken: 'target-access-token' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth', accountUuid: 'uuid-old', credentialRevision: 'revision-old' },
        { id: 'acct_2', type: 'oauth', accountUuid: 'uuid-target', credentialRevision: 'revision-target' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => {
        throw new Error('live Claude Code credential lookup should not run in this test');
      },
    }));
    cleanupAfterTest(async () => {
      releaseBody?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
    });
    const oldQuotaApplied = await waitForStatus(
      () => accountManager.find('acct_1').quota.unified5h,
      utilization => utilization === 1,
      250,
    );
    assert.equal(oldQuotaApplied, 1);
    accountManager.replaceAccounts([
      { id: 'acct_2', type: 'oauth', accountUuid: 'uuid-target', credentialRevision: 'revision-target' },
      { id: 'acct_1', type: 'oauth', accountUuid: 'uuid-new', credentialRevision: 'revision-new' },
    ]);
    const newAccount = accountManager.find('acct_1');
    releaseBody();

    const response = await responsePending;
    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reload-test'], 'old-identity');
    assert.deepEqual(upstreamSeen, ['Bearer old-access-token']);
    assert.equal(newAccount.quota.unified5h, null);
  });

  it('streams a delayed response from a removed account without mutating the replacement account set', async () => {
    let releaseResponse;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    let markUpstreamStarted;
    const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
    const upstream = await listen(http.createServer(async (_req, res) => {
      markUpstreamStarted();
      await responseGate;
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.8',
      });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'old-access-token' });
    await secretStore.set('acct_2', { accessToken: 'new-access-token' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth', accountUuid: 'uuid-old' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => {
        throw new Error('live Claude Code credential lookup should not run in this test');
      },
    }));
    cleanupAfterTest(async () => {
      releaseResponse?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
    });
    await upstreamStarted;
    accountManager.replaceAccounts([{ id: 'acct_2', type: 'oauth', accountUuid: 'uuid-new' }]);
    releaseResponse();

    const response = await responsePending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(accountManager.find('acct_2').quota.unified5h, null);
    const health = await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 500 });
    assert.equal(health.status, 200);
  });

  it('turns an upstream response callback exception into a bounded proxy error', async () => {
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    accountManager.updateQuota = () => {
      throw new Error('intentional response callback failure');
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
    });
    assert.equal(response.status, 502);
    const health = await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 500 });
    assert.equal(health.status, 200);
  });

  it('does not forward an unavailable-account credential resolved across a same-id reload', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    const accountManager = new AccountManager({
      accounts: [{
        id: 'current', type: 'oauth', accountUuid: 'uuid-old', credentialRevision: 'revision-old',
      }],
    });
    accountManager.markRateLimited('current', 60);
    let markCredentialReadStarted;
    const credentialReadStarted = new Promise(resolve => { markCredentialReadStarted = resolve; });
    let releaseCredentialRead;
    const credentialReadGate = new Promise(resolve => { releaseCredentialRead = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => {
        markCredentialReadStarted();
        await credentialReadGate;
        return { accessToken: 'old-live-token' };
      },
    }));
    cleanupAfterTest(async () => {
      releaseCredentialRead?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
    });
    await credentialReadStarted;
    accountManager.replaceAccounts([{
      id: 'current', type: 'oauth', accountUuid: 'uuid-new', credentialRevision: 'revision-new',
    }]);
    releaseCredentialRead();

    const response = await responsePending;
    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, []);
    assert.equal(accountManager.find('current').accountUuid, 'uuid-new');
    assert.equal(accountManager.find('current').status, 'ready');
  });

  it('keeps absolute-form request targets on the configured upstream origin', async () => {
    const configuredSeen = [];
    const configuredUpstream = await listen(http.createServer(async (req, res) => {
      configuredSeen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ routed: 'configured' }));
    }));
    const otherSeen = [];
    const otherOrigin = await listen(http.createServer(async (req, res) => {
      otherSeen.push(req.url);
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ routed: 'other' }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager, secretStore, config: { upstream: configuredUpstream.url },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(configuredUpstream.server);
      await close(otherOrigin.server);
    });

    const response = await requestJson(proxy.url, {
      method: 'POST',
      path: `${otherOrigin.url}/v1/messages?absolute=true`,
      body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { routed: 'configured' });
    assert.deepEqual(configuredSeen, [{
      url: '/v1/messages?absolute=true', authorization: 'Bearer access-token-1',
    }]);
    assert.deepEqual(otherSeen, []);
  });

  it('responds safely to a malformed absolute-form target without an unhandled rejection or hang', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    const unhandledRejections = [];
    const onUnhandledRejection = reason => { unhandledRejections.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    cleanupAfterTest(async () => {
      process.off('unhandledRejection', onUnhandledRejection);
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(proxy.url, {
      method: 'POST',
      path: 'http://[',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 500,
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(response.status >= 400 && response.status < 600);
    assert.equal(typeof response.body?.error?.message, 'string');
    assert.ok(response.body.error.message.length > 0);
    assert.deepEqual(upstreamSeen, []);
    assert.deepEqual(unhandledRejections, []);
  });

  it('rejects non-loopback bind configuration before creating the credential-bearing proxy', () => {
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });

    assert.throws(() => createProxyServer({
      accountManager,
      secretStore: new MemorySecretStore(),
      config: {
        upstream: 'http://127.0.0.1:1',
        proxy: { host: '0.0.0.0' },
      },
    }), /Proxy host must be loopback/);
  });

  it('rejects hostile Host and cross-site browser requests before forwarding credentials', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const hostileHost = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { host: 'attacker.example' },
      body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const crossSiteOrigin = await requestJson(`${proxy.url}/internal/switch`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
      body: JSON.stringify({ account: 'acct_1' }),
    });
    const crossSiteFetch = await requestJson(`${proxy.url}/internal/switch`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ account: 'acct_1' }),
    });
    const otherLoopbackOrigin = await requestJson(`${proxy.url}/internal/switch`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:9' },
      body: JSON.stringify({ account: 'acct_1' }),
    });

    assert.equal(hostileHost.status, 403);
    assert.equal(crossSiteOrigin.status, 403);
    assert.equal(crossSiteFetch.status, 403);
    assert.equal(otherLoopbackOrigin.status, 403);
    assert.deepEqual(upstreamSeen, []);
  });

  it('closes the in-flight upstream request promptly when the downstream client disconnects', async () => {
    let releaseUpstreamStarted;
    const upstreamStarted = new Promise(resolve => { releaseUpstreamStarted = resolve; });
    let releaseUpstreamClosed;
    const upstreamClosed = new Promise(resolve => { releaseUpstreamClosed = resolve; });
    const upstream = await listen(http.createServer((req, res) => {
      releaseUpstreamStarted();
      const markClosed = () => releaseUpstreamClosed();
      req.once('aborted', markClosed);
      res.once('close', markClosed);
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        proxy: { upstreamIdleTimeoutMs: 5_000 },
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const target = new URL(`${proxy.url}/v1/messages`);
    const client = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ model: 'claude-fable-5' }));
    await upstreamStarted;
    client.destroy();

    const closedPromptly = await Promise.race([
      upstreamClosed.then(() => true),
      sleep(500).then(() => false),
    ]);
    assert.equal(closedPromptly, true);
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
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: 9999999999999,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async (refreshToken, context) => {
        assert.equal(refreshToken, 'refresh-token-1');
        assert.equal(context.accountId, 'acct_1');
        assert.equal(context.accessToken, 'expired-token');
        assert.equal(context.refreshToken, 'refresh-token-1');
        assert.equal(context.expiresAt, 900);
        assert.deepEqual(context.scopes, ['user:profile', 'user:inference']);
        assert.equal(context.refreshTokenExpiresAt, 9999999999999);
        return {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: 100000,
          scopes: context.scopes,
          refreshTokenExpiresAt: context.refreshTokenExpiresAt,
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
      scopes: ['user:profile', 'user:inference'],
      refreshTokenExpiresAt: 9999999999999,
    });

    await close(proxy.server);
    await close(upstream.server);
  });

  it('keeps using a valid access token when proactive refresh is rate limited', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'still-valid-token',
      refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 4 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        throw new OAuthTokenRefreshError({
          status: 429,
          code: 'rate_limit_error',
          retryAfterMs: 60_000,
        });
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer still-valid-token']);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason, null);
    assert.match(logLines.join('\n'), /credential-refresh-fallback account=acct_1/);
  });

  it('parks two forward attempts after one ambiguous handoff even with a usable access token', async () => {
    let upstreamCalls = 0;
    const upstream = await listen(http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'usable-forward-access-fixture',
      refreshToken: 'forward-refresh-fixture',
      expiresAt: Date.now() + 4 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', credentialRevision: 'rev-1' }],
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      tokenRefresher: async (_refreshToken, context) => {
        refreshCalls += 1;
        await context.beforeHandoff();
        throw Object.assign(new Error('ambiguous forward handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const first = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });
    const second = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.notEqual(first.status, 200);
    assert.notEqual(second.status, 200);
    assert.equal(refreshCalls, 1);
    assert.equal(upstreamCalls, 0);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_failed');
    assert.equal(JSON.stringify([first.body, second.body]).includes('forward-refresh-fixture'), false);
  });

  it('uses the newer credential without refreshing when it changes before the locked re-read', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
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
    const newerSecret = {
      accessToken: 'newer-access-token',
      refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
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
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        refreshCalls += 1;
        return {
          accessToken: 'stale-refresh-result',
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer newer-access-token']);
    assert.deepEqual(await secretStore.get('acct_1'), newerSecret);
    assert.equal(refreshCalls, 0);
    assert.match(logLines.join('\n'), /result=discarded reason=credential-changed/);
  });

  it('does not start a competing refresh before a failed updater releases the account lock', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-1',
      expiresAt: 900,
    });
    const firstAccountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const secondAccountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    let refreshCalls = 0;
    let releaseFirstUpdater;
    let firstUpdaterEntered;
    let secondUpdaterEntered;
    const firstUpdaterGate = new Promise(resolve => { releaseFirstUpdater = resolve; });
    const firstUpdaterStarted = new Promise(resolve => { firstUpdaterEntered = resolve; });
    const secondUpdaterStarted = new Promise(resolve => { secondUpdaterEntered = resolve; });
    const tokenRefresher = async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        firstUpdaterEntered();
        await firstUpdaterGate;
        throw new Error('first refresh failed');
      }
      secondUpdaterEntered();
      return {
        accessToken: 'fresh-token',
        refreshToken: 'refresh-token-2',
        expiresAt: 200000,
      };
    };
    const firstProxy = await listen(createProxyServer({
      accountManager: firstAccountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher,
    }));
    const secondProxy = await listen(createProxyServer({
      accountManager: secondAccountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher,
    }));
    cleanupAfterTest(async () => {
      await close(firstProxy.server);
      await close(secondProxy.server);
      await close(upstream.server);
    });

    const firstResponse = requestJson(`${firstProxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet', request: 1 }),
    });
    await firstUpdaterStarted;
    const secondResponse = requestJson(`${secondProxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet', request: 2 }),
    });
    const secondStartedBeforeRelease = await Promise.race([
      secondUpdaterStarted.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 25)),
    ]);
    assert.equal(secondStartedBeforeRelease, false);
    assert.equal(refreshCalls, 1);
    releaseFirstUpdater();

    const responses = await Promise.all([firstResponse, secondResponse]);
    assert.deepEqual(responses.map(response => response.status), [503, 200]);
    assert.equal(refreshCalls, 2);
    assert.deepEqual(upstreamSeen, ['Bearer fresh-token']);
  });

  it('refreshes an expired OAuth token only once for concurrent requests', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
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
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        refreshCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const responses = await Promise.all([
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet', request: 1 }),
      }),
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet', request: 2 }),
      }),
    ]);

    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer fresh-token', 'Bearer fresh-token']);
    assert.equal((await secretStore.get('acct_1')).refreshToken, 'refresh-token-2');
    const refreshLogs = logLines.filter(line => line.includes('credential-refresh') && line.includes('result=success'));
    assert.equal(refreshLogs.length, 1);
    assert.match(refreshLogs[0], /account=acct_1 result=success rotated=true/);
    assert.equal(refreshLogs[0].includes('refresh-token'), false);
    assert.equal(refreshLogs[0].includes('fresh-token'), false);
  });

  it('logs only sanitized OAuth refresh retry metadata', async () => {
    const logLines = [];
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'secret-refresh-token',
      expiresAt: 900,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        throw new OAuthTokenRefreshError({
          status: 429,
          code: 'rate_limit_error',
          retryAfterMs: 60_000,
          retryAfterSource: 'fallback',
        });
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.match(logLines.join('\n'), /retryAfterSec=60 retrySource=fallback/);
    assert.equal(logLines.join('\n').includes('secret-refresh-token'), false);
    assert.equal(logLines.join('\n').includes('expired-token'), false);
  });

  it('uses live Claude Code credentials for the current account', async () => {
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
    cleanupAfterTest(async () => {
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

  it('uses live Claude Code credentials for an expired saved account with the same accountUuid', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-saved-token',
      refreshToken: 'saved-refresh-token',
      expiresAt: 900,
      clientId: 'stale-custom-client',
      scopes: ['stale:scope'],
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    const liveExpiresAt = Date.now() + 60 * 60 * 1000;
    const liveRefreshExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        throw new Error('token refresh should not be called');
      },
      currentCredentialReader: async () => ({
        accessToken: 'live-claude-code-token',
        refreshToken: 'live-claude-code-refresh',
        expiresAt: liveExpiresAt,
        refreshTokenExpiresAt: liveRefreshExpiresAt,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
      }),
      currentProfileFetcher: async accessToken => {
        assert.equal(accessToken, 'live-claude-code-token');
        return { accountUuid: 'uuid-live' };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer live-claude-code-token']);
    assert.deepEqual(await secretStore.get('acct_1'), {
      accessToken: 'live-claude-code-token',
      refreshToken: 'live-claude-code-refresh',
      expiresAt: liveExpiresAt,
      refreshTokenExpiresAt: liveRefreshExpiresAt,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
    });
  });

  it('refreshes the stored account instead of using matching live credentials in gateway mode', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const expired = {
      accessToken: 'expired-saved-token',
      refreshToken: 'saved-refresh-token',
      expiresAt: 900,
    };
    const freshExpiresAt = Date.now() + 60 * 60 * 1000;
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', expired);
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      allowLiveClaudeCodeCredentials: false,
      tokenRefresher: async refreshToken => {
        refreshCalls += 1;
        assert.equal(refreshToken, 'saved-refresh-token');
        return {
          accessToken: 'fresh-stored-token',
          refreshToken,
          expiresAt: freshExpiresAt,
        };
      },
      currentCredentialReader: async () => {
        throw new Error('gateway mode must not read the saved /login credential');
      },
      currentProfileFetcher: async () => {
        throw new Error('gateway mode must not profile the saved /login credential');
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer fresh-stored-token']);
    assert.deepEqual(await secretStore.get('acct_1'), {
      accessToken: 'fresh-stored-token',
      refreshToken: 'saved-refresh-token',
      expiresAt: freshExpiresAt,
    });
  });

  it('does not roll a fresh stored account back to stale live credentials in gateway mode', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const stored = {
      accessToken: 'fresh-stored-token',
      refreshToken: 'fresh-stored-refresh',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', stored);
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      allowLiveClaudeCodeCredentials: false,
      tokenRefresher: async () => {
        throw new Error('fresh stored credential must not be refreshed');
      },
      currentCredentialReader: async () => ({
        accessToken: 'stale-live-token',
        refreshToken: 'stale-live-refresh',
        expiresAt: 900,
      }),
      currentProfileFetcher: async () => ({ accountUuid: 'uuid-live' }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer fresh-stored-token']);
    assert.deepEqual(await secretStore.get('acct_1'), stored);
  });

  it('does not let live credential mirroring overwrite an in-flight metadata update', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    const stored = {
      accessToken: 'saved-token',
      refreshToken: 'shared-refresh-token',
      expiresAt: 900,
      subscriptionType: 'pro',
    };
    const concurrentUpdate = {
      ...stored,
      accessToken: 'concurrent-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      subscriptionType: 'max',
      rateLimitTier: 'tier-2',
    };
    await secretStore.set('acct_1', stored);
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      currentCredentialReader: async () => ({
        accessToken: 'live-token',
        refreshToken: 'shared-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      currentProfileFetcher: async () => {
        await secretStore.set('acct_1', concurrentUpdate);
        return { accountUuid: 'uuid-live' };
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer live-token']);
    assert.deepEqual(await secretStore.get('acct_1'), concurrentUpdate);
    assert.match(logLines.join('\n'), /credential-sync-discarded account=acct_1 reason=credential-changed/);
  });

  it('records proxy request diagnostics without secrets', async () => {
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
    cleanupAfterTest(async () => {
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

  it('refreshes and retries once when upstream rejects the OAuth token', async () => {
    const upstreamSeen = [];
    const freshExpiresAt = Date.now() + 2 * 60 * 60 * 1000;
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
          expiresAt: freshExpiresAt,
        };
      },
    }));
    cleanupAfterTest(async () => {
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
      expiresAt: freshExpiresAt,
    });
  });

  it('does not repeat an ambiguous refresh entered from the upstream 401 path', async () => {
    let upstreamCalls = 0;
    const upstream = await listen(http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'rejected-access-fixture',
      refreshToken: 'rejected-refresh-fixture',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', credentialRevision: 'rev-1' }],
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      tokenRefresher: async (_refreshToken, context) => {
        refreshCalls += 1;
        await context.beforeHandoff();
        throw Object.assign(new Error('ambiguous 401 refresh handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const first = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });
    const second = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.notEqual(first.status, 200);
    assert.notEqual(second.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_failed');
  });

  it('reloads a live Claude Code credential after an OAuth rejection', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer fresh-current-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
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
    let currentToken = 'stale-current-token';
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      currentCredentialReader: async () => ({
        accessToken: currentToken,
        refreshToken: 'live-current-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      tokenRefresher: async () => {
        throw new Error('live Claude Code credentials must not be refreshed by the rotator');
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/api/oauth/profile`);

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid authentication credentials' },
    });
    assert.deepEqual(upstreamSeen, ['Bearer stale-current-token']);
    assert.equal(accountManager.getStatus().currentAccount, 'current');
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason, null);

    currentToken = 'fresh-current-token';
    const retried = await requestJson(`${proxy.url}/api/oauth/profile`);
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body, { ok: true });
    assert.deepEqual(upstreamSeen, ['Bearer stale-current-token', 'Bearer fresh-current-token']);
  });

  it('switches to the emptiest known account when the current account reaches quota', async () => {
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
    cleanupAfterTest(async () => {
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

  it('confirms an ambiguous Fable 429 from same-account usage and retries exactly once', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
    });
    accountManager.updateQuota('acct_2', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async token => {
        usageCalls += 1;
        assert.equal(token, 'access-token-1');
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.window, '7d Fable');
  });

  it('confirms an ambiguous Fable 5.1 429 from same-account usage and retries exactly once', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
    });
    accountManager.updateQuota('acct_2', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async token => {
        usageCalls += 1;
        assert.equal(token, 'access-token-1');
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5-1' }),
    });

    assert.equal(response.status, 200);
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.window, '7d Fable');
  });

  it('forwards a non-fable request to an account whose fable weekly sub-cap is already exhausted', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    // acct_1's common windows have headroom; only the Fable weekly sub-cap is exhausted.
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });

    assert.equal(response.status, 200);
    // Must stay on acct_1 in a single attempt: a Fable-only exhaustion never
    // excludes a non-Fable request, so no switch to acct_2 should occur.
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('routes a non-fable request away from a refresh cooldown hidden by fable quota exhaustion', async () => {
    const upstreamSeen = [];
    const alternateAccessToken = randomUUID();
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresAt: 1,
    });
    await secretStore.set('acct_2', { accessToken: alternateAccessToken });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    accountManager.markCredentialRefreshDeferred('acct_1', 300, { retryAfterSource: 'fixed' });
    accountManager.applyUsage('acct_2', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        refreshCalls += 1;
        throw new Error('credential refresh must remain in cooldown');
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });

    assert.equal(response.status, 200);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(upstreamSeen, [`Bearer ${alternateAccessToken}`]);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_2');
  });

  it('forwards a fable request away from an account whose fable weekly sub-cap is already exhausted', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    // acct_2 needs known unified-quota headroom to be scored as a switch target.
    accountManager.applyUsage('acct_2', {
      five_hour: { utilization: 0.3, resets_at: futureReset() },
      seven_day: { utilization: 0.3, resets_at: futureReset() },
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    // Must skip straight to acct_2 in a single attempt: the Fable request is
    // gated by the exhausted Fable sub-cap on acct_1.
    assert.deepEqual(upstreamSeen, ['Bearer access-token-2']);
    // The pick is ad-hoc, for THIS Fable request only: a model-scoped-only
    // exhaustion must not permanently move the `currentIndex` pointer, or a
    // later non-Fable request would be stranded on acct_2 while acct_1's
    // common-quota headroom for non-Fable models sits idle (M2).
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');

    const sonnetResponse = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });

    assert.equal(sonnetResponse.status, 200);
    // The non-fable follow-up must still land on acct_1 (the fable-only
    // exhaustion never blocked it), not the ad-hoc fable target acct_2.
    assert.deepEqual(upstreamSeen, ['Bearer access-token-2', 'Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('routes concurrent Fable and Sonnet requests independently without moving the shared current account', async () => {
    const upstreamSeen = [];
    let releaseBoth;
    const bothArrived = new Promise(resolve => { releaseBoth = resolve; });
    const upstream = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
      upstreamSeen.push([model, req.headers.authorization]);
      if (upstreamSeen.length === 2) releaseBoth();
      await bothArrived;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    accountManager.applyUsage('acct_2', {
      five_hour: { utilization: 0.3, resets_at: futureReset() },
      seven_day: { utilization: 0.3, resets_at: futureReset() },
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => {
      releaseBoth?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const [fableResponse, sonnetResponse] = await Promise.all([
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-fable-5' }),
      }),
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-5' }),
      }),
    ]);

    assert.equal(fableResponse.status, 200);
    assert.equal(sonnetResponse.status, 200);
    assert.deepEqual(new Map(upstreamSeen), new Map([
      ['claude-fable-5', 'Bearer access-token-2'],
      ['claude-sonnet-5', 'Bearer access-token-1'],
    ]));
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('routes a dated/suffixed Fable model id away from a fable-exhausted account (M3)', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => 1000,
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    accountManager.applyUsage('acct_2', {
      five_hour: { utilization: 0.3, resets_at: futureReset() },
      seven_day: { utilization: 0.3, resets_at: futureReset() },
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    // A dated/numbered Fable id must still be routed as a Fable request, even
    // though the strict canonical check used for reactive-confirmation
    // (`requestModelFamily`/`isCanonicalFableModelId`) intentionally rejects it.
    for (const model of ['claude-fable-5-20260818', 'CLAUDE-FABLE-5', ' claude-fable-5 ', 'claude-fable-5-1', 'claude-fable-5-1-20260901']) {
      upstreamSeen.length = 0;
      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      });
      assert.equal(response.status, 200, model);
      assert.deepEqual(upstreamSeen, ['Bearer access-token-2'], `${model} must route straight to acct_2`);
    }
  });

  it('keeps the canonical Fable id set a subset of the Fable routing set (canonical subset of routing invariant)', async () => {
    // isCanonicalFableModelId() and isFableRoutingModelId() are internal
    // (unexported) helpers in src/proxy-server.js, so this invariant is
    // pinned behaviorally through the proxy, the same way the M3 test above
    // pins isFableRoutingModelId(): if an id is canonical (drives reactive
    // Usage confirmation; see 'confirms an ambiguous Fable ... 429 ...'
    // tests), it must also be treated as Fable for account-selection
    // ROUTING, i.e. it must be routed away from an account whose Fable
    // weekly sub-cap alone is exhausted. The two ids below are exactly the
    // canonical set (CANONICAL_FABLE_MODEL_IDS in src/proxy-server.js).
    const canonicalFableModelIds = ['claude-fable-5', 'claude-fable-5-1'];
    for (const model of canonicalFableModelIds) {
      const upstreamSeen = [];
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      await secretStore.set('acct_2', { accessToken: 'access-token-2' });
      const accountManager = new AccountManager({
        accounts: [
          { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
          { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        ],
        switchThreshold: 1,
        now: () => 1000,
      });
      accountManager.applyUsage('acct_1', {
        five_hour: { utilization: 0.2, resets_at: futureReset() },
        seven_day: { utilization: 0.2, resets_at: futureReset() },
        scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
      });
      accountManager.applyUsage('acct_2', {
        five_hour: { utilization: 0.3, resets_at: futureReset() },
        seven_day: { utilization: 0.3, resets_at: futureReset() },
      });
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
      }));
      cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      });
      assert.equal(response.status, 200, model);
      assert.deepEqual(upstreamSeen, ['Bearer access-token-2'], `${model} (canonical) must also route as Fable, straight to acct_2`);
    }
  });

  it('routes every model family away from common token and request exhaustion', async () => {
    for (const reasonKind of ['token', 'request']) {
      const upstreamSeen = [];
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      await secretStore.set('acct_2', { accessToken: 'access-token-2' });
      const accountManager = new AccountManager({
        accounts: [
          { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
          { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
        ],
        switchThreshold: 1,
        now: () => 1000,
      });
      accountManager.updateQuota('acct_2', {
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
      });
      accountManager.updateQuota('acct_1', reasonKind === 'token'
        ? {
            'anthropic-ratelimit-tokens-limit': '1000',
            'anthropic-ratelimit-tokens-remaining': '0',
          }
        : {
            'anthropic-ratelimit-requests-limit': '100',
            'anthropic-ratelimit-requests-remaining': '0',
          });
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
      }));
      cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

      for (const model of ['claude-fable-5', 'claude-sonnet-5']) {
        const response = await requestJson(`${proxy.url}/v1/messages`, {
          method: 'POST',
          body: JSON.stringify({ model }),
        });
        assert.equal(response.status, 200, `${reasonKind}/${model}`);
      }

      assert.deepEqual(upstreamSeen, ['Bearer access-token-2', 'Bearer access-token-2']);
    }
  });

  it('m2: the synthesized quota-unavailable response never carries a fable claim for a non-fable request (regression via unavailableReasonForModelFamily)', async () => {
    const upstream = await listen(http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      switchThreshold: 1,
      now: () => 1000,
    });
    // Single account, no fallback: the Fable weekly sub-cap is exhausted AND,
    // independently, the common token rate limit is exhausted too.
    // Pre-fix, `sendCurrentQuotaUnavailableResponse` used the family-agnostic
    // `unavailableReason`, which reports the scoped Fable window first (it is
    // checked before tokens/requests) — so a plain Sonnet request could have
    // been handed a synthetic 429 claiming `seven_day_fable`, which is false.
    // The common token-rate exhaustion must be reported without borrowing the
    // unrelated Fable-scoped claim that appears first in the general status.
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.2, resets_at: futureReset() },
      seven_day: { utilization: 0.2, resets_at: futureReset() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-tokens-limit': '1000',
      'anthropic-ratelimit-tokens-remaining': '0',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });

    assert.notEqual(
      response.headers['anthropic-ratelimit-unified-representative-claim'],
      'seven_day_fable',
      'a non-fable request must never be told it was blocked by the fable sub-cap',
    );
    assert.notEqual(response.body?.error?.details?.window, '7d Fable');
  });

  it('revalidates exact Fable exhaustion independently of scoped order and canonical id spelling', async () => {
    const scenarios = [
      {
        name: 'Fable after exhausted Sonnet',
        scopedWeekly: [
          { key: 'sonnet', label: 'Sonnet', utilization: 1, resets_at: futureReset() },
          { key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() },
        ],
      },
      {
        name: 'canonical Fable id only',
        scopedWeekly: [{
          key: 'claude_fable_5',
          label: 'claude-fable-5',
          utilization: 1,
          resets_at: futureReset(),
        }],
      },
      {
        name: 'valid Fable alongside an unrelated malformed scope',
        scopedWeekly: [
          { key: 'sonnet', label: 'Sonnet', utilization: null, resets_at: null },
          {
            key: 'claude_fable_5',
            label: 'claude-fable-5',
            utilization: 1,
            resets_at: futureReset(),
          },
        ],
      },
    ];

    for (const scenario of scenarios) {
      const upstreamSeen = [];
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization);
        if (req.headers.authorization === 'Bearer access-token-1') {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error', error: { type: 'rate_limit_error', message: scenario.name },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      await secretStore.set('acct_2', { accessToken: 'access-token-2' });
      const accountManager = new AccountManager({
        accounts: [
          { id: 'acct_1', type: 'oauth' },
          { id: 'acct_2', type: 'oauth' },
        ],
      });
      accountManager.updateQuota('acct_2', {
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
      });
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
        usageFetcher: async () => ({ scoped_weekly: scenario.scopedWeekly }),
      }));
      try {
        const response = await requestJson(`${proxy.url}/v1/messages`, {
          method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
        });

        assert.equal(response.status, 200, scenario.name);
        assert.deepEqual(
          upstreamSeen,
          ['Bearer access-token-1', 'Bearer access-token-2'],
          scenario.name,
        );
      } finally {
        await close(proxy.server);
        await close(upstream.server);
      }
    }
  });

  it('uses the configured switch threshold for a complete current-response quota header', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '0.8',
          'anthropic-ratelimit-unified-5h-reset': String(
            Math.floor(Date.parse(futureReset()) / 1000),
          ),
        });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'configured threshold' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      switchThreshold: 0.8,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => assert.fail('complete quota headers must not require Usage'),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
  });

  it('requires actual 100% Usage for reactive replay even when the rotation threshold is lower', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous throttle at 80%' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'below-exhaustion-threshold',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      switchThreshold: 0.8,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 0.8, resets_at: futureReset(),
        }],
      }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'below-exhaustion-threshold',
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('can replay to a known live current-account credential without a stored secret', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable exhausted' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'current', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('current', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => ({
        accessToken: 'live-current-token',
        refreshToken: 'live-current-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
        }],
      }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.deepEqual(upstreamSeen, [
      'Bearer access-token-1',
      'Bearer live-current-token',
    ]);
    // 反応的確認が確定したのは Fable の系統枠だけなので、R-S2b（設計書 §5.1）により
    // この要求だけが `current` へ流れ、currentIndex は acct_1 に残る。
    // 再生先の資格情報を実口座から読めることを押さえるのがこのテストの主旨で、そこは不変。
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('does not reuse a stored five-hour reset to replay a newer reset-less exhaustion header', async () => {
    const now = Date.now();
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'reset omitted on current 429' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'x-reactive-test': 'reset-less-current-header',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      now: () => now,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((now + 60_000) / 1000)),
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return { scoped_weekly: [] };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'reset-less-current-header',
      usageCalls: 0,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('preserves the original Fable 429 when reactive usage is below the limit', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'temporary model throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-upstream-marker': 'preserved',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.4, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-upstream-marker'], 'preserved');
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 0.4);
  });

  it('does not use an exhausted Fable scope to replay a Sonnet request', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'sonnet throttle' },
      }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(usageCalls, 0);
    assert.deepEqual(accountManager.find('acct_1').quota.weeklyScoped, []);
  });

  it('preserves an ambiguous Fable 429 when its reset is missing or no target is known', async () => {
    for (const scenario of ['missing-reset', 'no-known-target']) {
      const upstreamSeen = [];
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: scenario },
        }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      await secretStore.set('acct_2', { accessToken: 'access-token-2' });
      const accountManager = new AccountManager({
        accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      });
      if (scenario === 'missing-reset') {
        accountManager.updateQuota('acct_2', {
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
        });
      }
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
        usageFetcher: async () => ({
          scoped_weekly: [{
            key: 'fable',
            label: 'Fable',
            utilization: 1,
            ...(scenario === 'missing-reset' ? {} : { resets_at: futureReset() }),
          }],
        }),
      }));
      try {
        const response = await requestJson(`${proxy.url}/v1/messages`, {
          method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
        });
        assert.equal(response.status, 429, scenario);
        assert.deepEqual(upstreamSeen, ['Bearer access-token-1'], scenario);
      } finally {
        await close(proxy.server);
        await close(upstream.server);
      }
    }
  });

  it('does not turn a reset-only Usage bucket into a known zero-utilization replay target', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'no genuinely known target' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'reset-only-target',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    let accountOneUsageCalls = 0;
    let accountTwoUsageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token === 'access-token-2') {
          accountTwoUsageCalls += 1;
          return {
            five_hour: { utilization: null, resets_at: futureReset() },
          };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          return {
            five_hour: { utilization: 0.2, resets_at: futureReset() },
          };
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledResponse = await requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 500,
    });
    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 500,
    });

    assert.deepEqual({
      scheduledStatus: scheduledResponse.status,
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      targetUtilization: accountManager.find('acct_2').quota.unified5h,
      accountOneUsageCalls,
      accountTwoUsageCalls,
      upstreamSeen,
    }, {
      scheduledStatus: 200,
      status: 429,
      body: originalBody,
      marker: 'reset-only-target',
      targetUtilization: null,
      accountOneUsageCalls: 2,
      accountTwoUsageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('does not clear known quota from a malformed reset-only Usage bucket', async () => {
    const resetAt = futureReset();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 1, resets_at: resetAt },
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      usageFetcher: async () => ({
        five_hour: { utilization: null, resets_at: resetAt },
      }),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const response = await requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 500,
    });

    assert.equal(response.status, 200);
    assert.equal(accountManager.find('acct_1').quota.unified5h, 1);
    assert.equal(accountManager.find('acct_1').quota.unified5hReset, Date.parse(resetAt));
  });

  it('does not clear known Fable quota from a fully malformed scoped sentinel', async () => {
    const resetAt = futureReset();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    accountManager.applyUsage('acct_1', {
      scoped_weekly: [{
        key: 'fable', label: 'Fable', utilization: 1, resets_at: resetAt,
      }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: null, resets_at: null,
        }],
      }),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const response = await requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 500,
    });

    assert.equal(response.status, 200);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].key, 'fable');
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].resetAt, Date.parse(resetAt));
  });

  it('does not let a malformed scoped sentinel supersede an older pending valid observation', async () => {
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'malformed scoped Usage' },
    };
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let markScheduledStarted;
    const scheduledStarted = new Promise(resolve => { markScheduledStarted = resolve; });
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    const resetAt = futureReset();
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          markScheduledStarted();
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: resetAt,
            }],
          };
        }
        return {
          scoped_weekly: [
            { key: 'sonnet', label: 'Sonnet', utilization: 0.1, resets_at: futureReset() },
            { key: 'fable', label: 'Fable', utilization: null, resets_at: null },
          ],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledResponsePending = requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 1_000,
    });
    await scheduledStarted;
    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_000,
    });
    releaseScheduled();
    const scheduledResponse = await scheduledResponsePending;

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountOneUsageCalls, 2);
    assert.deepEqual(
      accountManager.find('acct_1').quota.weeklyScoped.map(limit => [limit.key, limit.utilization]),
      [['fable', 1], ['sonnet', 0.1]],
    );
  });

  it('clears scopes omitted by an older complete snapshot while preserving a newer partial scope', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-2') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'scoped snapshot merge' },
      }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.applyUsage('acct_1', {
      scoped_weekly: [{
        key: 'opus', label: 'Opus', utilization: 0.2, resets_at: futureReset(),
      }],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let markScheduledStarted;
    const scheduledStarted = new Promise(resolve => { markScheduledStarted = resolve; });
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          markScheduledStarted();
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 0.4, resets_at: futureReset(),
            }],
          };
        }
        return {
          scoped_weekly: [
            { key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() },
            { key: 'sonnet', label: 'Sonnet', utilization: null, resets_at: null },
          ],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledResponsePending = requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 1_000,
    });
    await scheduledStarted;
    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_000,
    });
    releaseScheduled();
    const scheduledResponse = await scheduledResponsePending;

    assert.equal(response.status, 200);
    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountOneUsageCalls, 2);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.deepEqual(
      accountManager.find('acct_1').quota.weeklyScoped.map(limit => [
        limit.key, limit.utilization,
      ]),
      [['fable', 1]],
    );
  });

  it('does not reactively confirm quota for API-key or non-messages requests', async () => {
    for (const scenario of ['api-key', 'non-messages']) {
      const upstreamSeen = [];
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization || req.headers['x-api-key']);
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: scenario },
        }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', scenario === 'api-key'
        ? { apiKey: 'api-key-1' }
        : { accessToken: 'access-token-1' });
      const accountManager = new AccountManager({
        accounts: [{ id: 'acct_1', type: scenario === 'api-key' ? 'apikey' : 'oauth' }],
      });
      let usageCalls = 0;
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
        usageFetcher: async () => { usageCalls += 1; return {}; },
      }));
      try {
        const path = scenario === 'api-key' ? '/v1/messages' : '/v1/complete';
        const response = await requestJson(`${proxy.url}${path}`, {
          method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
        });
        assert.equal(response.status, 429, scenario);
        assert.equal(usageCalls, 0, scenario);
        assert.equal(upstreamSeen.length, 1, scenario);
      } finally {
        await close(proxy.server);
        await close(upstream.server);
      }
    }
  });

  it('does not reactively confirm a second 429 after one Fable failover', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'rate_limit_error', message: req.headers.authorization },
      }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of [1, 2, 3]) {
      await secretStore.set(`acct_${id}`, { accessToken: `access-token-${id}` });
    }
    const accountManager = new AccountManager({
      accounts: [1, 2, 3].map(id => ({ id: `acct_${id}`, type: 'oauth' })),
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    accountManager.updateQuota('acct_3', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 429);
    assert.equal(response.body.error.message, 'Bearer access-token-2');
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
  });

  it('single-flights same-account concurrent Fable confirmations so duplicate Usage calls cannot split retries', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    let releaseUsage;
    const usagePending = new Promise(resolve => { releaseUsage = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        await usagePending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseUsage?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const firstPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const secondPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const synchronized = await waitForStatus(
      () => ({
        usageCalls,
        firstAccountRequests: upstreamSeen.filter(value => value === 'Bearer access-token-1').length,
      }),
      value => value.usageCalls === 1 && value.firstAccountRequests === 2,
    );
    assert.deepEqual(synchronized, { usageCalls: 1, firstAccountRequests: 2 });
    releaseUsage();
    const [firstResponse, secondResponse] = await Promise.all([firstPending, secondPending]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(usageCalls, 1);
    assert.equal(upstreamSeen.filter(value => value === 'Bearer access-token-1').length, 2);
    assert.equal(upstreamSeen.filter(value => value === 'Bearer access-token-2').length, 2);
  });

  it('snapshots stored reactive replay targets without fetching or mirroring the live Claude profile', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    await secretStore.set('acct_3', { accessToken: 'access-token-3' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth', accountUuid: 'uuid-live' },
        { id: 'acct_3', type: 'oauth', accountUuid: 'uuid-other' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    accountManager.updateQuota('acct_3', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });
    const storedTarget = await secretStore.get('acct_2');
    const originalCompareAndSet = secretStore.compareAndSet.bind(secretStore);
    let compareAndSetCalls = 0;
    secretStore.compareAndSet = async (...args) => {
      compareAndSetCalls += 1;
      return originalCompareAndSet(...args);
    };
    let profileCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      currentCredentialReader: async () => ({
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      currentProfileFetcher: async () => {
        profileCalls += 1;
        await new Promise(resolve => setImmediate(resolve));
        return { accountUuid: 'uuid-live' };
      },
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
        }],
      }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.equal(profileCalls, 0);
    assert.equal(compareAndSetCalls, 0);
    assert.deepEqual(await secretStore.get('acct_2'), storedTarget);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
  });

  it('does not share reactive Usage single-flight across different access tokens for the same account', async () => {
    const upstreamSeen = [];
    const originalBodies = {
      A: { type: 'error', error: { type: 'rate_limit_error', message: 'token A throttle' } },
      B: { type: 'error', error: { type: 'rate_limit_error', message: 'token B throttle' } },
    };
    const upstream = await listen(http.createServer((req, res) => {
      const requestId = req.headers['x-client-request'];
      upstreamSeen.push({ requestId, authorization: req.headers.authorization });
      if (req.headers.authorization !== 'Bearer access-token-2') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': `token-isolation-${requestId}`,
        });
        res.end(JSON.stringify(originalBodies[requestId]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'stored-token' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let accountOneSecretReads = 0;
    const readAccountOneSecret = async accountId => {
      if (accountId !== 'acct_1') return originalGetSecret(accountId);
      accountOneSecretReads += 1;
      return {
        accessToken: accountOneSecretReads === 1 ? 'access-token-a' : 'access-token-b',
      };
    };
    secretStore.get = readAccountOneSecret;
    secretStore.getOperational = readAccountOneSecret;
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const usageTokens = [];
    let releaseTokenA;
    const tokenAPending = new Promise(resolve => { releaseTokenA = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async token => {
        usageTokens.push(token);
        if (token === 'access-token-a') {
          await tokenAPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseTokenA?.();
      await close(proxy.server);
      await close(upstream.server);
    });
    // Startup reconciliation (operationalStateCheck) reads every account's
    // operational secret once before the server accepts requests. Settle it
    // and reset the read counter so the assertions below only observe reads
    // triggered by the requests this test sends.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    accountOneSecretReads = 0;

    const requestA = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-client-request': 'A' },
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_000,
    });
    const tokenAStarted = await waitForStatus(
      () => usageTokens.slice(),
      tokens => tokens.length === 1,
      250,
    );
    assert.deepEqual(tokenAStarted, ['access-token-a']);
    const requestB = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-client-request': 'B' },
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_000,
    });
    const tokenBReachedUpstream = await waitForStatus(
      () => upstreamSeen.some(entry => entry.requestId === 'B'),
      Boolean,
      250,
    );
    assert.equal(tokenBReachedUpstream, true);
    await waitForStatus(() => usageTokens.length, count => count === 2, 100);
    releaseTokenA();
    const [, responseB] = await Promise.all([requestA, requestB]);
    const requestBUpstream = upstreamSeen.filter(entry => entry.requestId === 'B');

    assert.deepEqual({
      status: responseB.status,
      body: responseB.body,
      marker: responseB.headers['x-reactive-test'],
      usageTokens,
      requestBUpstream,
    }, {
      status: 429,
      body: originalBodies.B,
      marker: 'token-isolation-B',
      usageTokens: ['access-token-a', 'access-token-b'],
      requestBUpstream: [{ requestId: 'B', authorization: 'Bearer access-token-b' }],
    });
  });

  it('does not authorize an older token request with newer reactive evidence from another token', async () => {
    const upstreamSeen = [];
    const originalBodies = {
      A: { type: 'error', error: { type: 'rate_limit_error', message: 'token A throttle' } },
      B: { type: 'error', error: { type: 'rate_limit_error', message: 'token B throttle' } },
    };
    const upstream = await listen(http.createServer((req, res) => {
      const requestId = req.headers['x-client-request'];
      upstreamSeen.push({ requestId, authorization: req.headers.authorization });
      if (req.headers.authorization !== 'Bearer access-token-2') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': `token-evidence-${requestId}`,
        });
        res.end(JSON.stringify(originalBodies[requestId]));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'stored-token' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let accountOneSecretReads = 0;
    const readAccountOneSecret = async accountId => {
      if (accountId !== 'acct_1') return originalGetSecret(accountId);
      accountOneSecretReads += 1;
      return {
        accessToken: accountOneSecretReads === 1 ? 'access-token-a' : 'access-token-b',
      };
    };
    secretStore.get = readAccountOneSecret;
    secretStore.getOperational = readAccountOneSecret;
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const usageTokens = [];
    let releaseTokenA;
    const tokenAPending = new Promise(resolve => { releaseTokenA = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async token => {
        usageTokens.push(token);
        if (token === 'access-token-a') {
          await tokenAPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
            }],
          };
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseTokenA?.();
      await close(proxy.server);
      await close(upstream.server);
    });
    // Startup reconciliation (operationalStateCheck) reads every account's
    // operational secret once before the server accepts requests. Settle it
    // and reset the read counter so the assertions below only observe reads
    // triggered by the requests this test sends.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    accountOneSecretReads = 0;

    const requestA = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-client-request': 'A' },
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_000,
    });
    const tokenAStarted = await waitForStatus(
      () => usageTokens.slice(),
      tokens => tokens.length === 1,
      250,
    );
    assert.deepEqual(tokenAStarted, ['access-token-a']);
    const responseB = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      headers: { 'x-client-request': 'B' },
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_000,
    });
    assert.equal(responseB.status, 200);
    releaseTokenA();
    const responseA = await requestA;

    assert.deepEqual({
      status: responseA.status,
      body: responseA.body,
      marker: responseA.headers['x-reactive-test'],
      usageTokens,
      requestAUpstream: upstreamSeen.filter(entry => entry.requestId === 'A'),
    }, {
      status: 429,
      body: originalBodies.A,
      marker: 'token-evidence-A',
      usageTokens: ['access-token-a', 'access-token-b'],
      requestAUpstream: [{ requestId: 'A', authorization: 'Bearer access-token-a' }],
    });
  });

  it('keeps per-model decisions from one shared Usage response so only exhausted Fable retries', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'model throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'shared-model-scopes',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    let releaseUsage;
    const usagePending = new Promise(resolve => { releaseUsage = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        await usagePending;
        return {
          scoped_weekly: [
            { key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() },
            { key: 'sonnet', label: 'Sonnet', utilization: 0.1, resets_at: futureReset() },
          ],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseUsage?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const fablePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const firstStarted = await waitForStatus(
      () => upstreamSeen.filter(value => value === 'Bearer access-token-1').length,
      count => count === 1,
    );
    assert.equal(firstStarted, 1);
    const sonnetPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    });
    const synchronized = await waitForStatus(
      () => ({
        usageCalls,
        firstAccountRequests: upstreamSeen.filter(value => value === 'Bearer access-token-1').length,
      }),
      value => value.usageCalls === 1 && value.firstAccountRequests === 2,
    );
    assert.deepEqual(synchronized, { usageCalls: 1, firstAccountRequests: 2 });
    releaseUsage();
    const [fableResponse, sonnetResponse] = await Promise.all([fablePending, sonnetPending]);

    assert.equal(fableResponse.status, 200);
    assert.equal(sonnetResponse.status, 429);
    assert.deepEqual(sonnetResponse.body, originalBody);
    assert.equal(sonnetResponse.headers['x-reactive-test'], 'shared-model-scopes');
    assert.equal(usageCalls, 1);
    assert.equal(upstreamSeen.filter(value => value === 'Bearer access-token-2').length, 1);
    const storedScopes = Object.fromEntries(
      accountManager.find('acct_1').quota.weeklyScoped.map(limit => [limit.key, limit.utilization]),
    );
    assert.deepEqual(storedScopes, { fable: 1, sonnet: 0.1 });
  });

  it('rejects an older scheduled exhaustion that finishes after a newer reactive low observation', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          scheduledStarted = true;
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 0.1);
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;

    assert.equal(scheduledResponse.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 0.1);
    assert.notEqual(
      accountManager.getStatus().accounts.find(account => account.id === 'acct_1').unavailableReason?.type,
      'quota_exhausted',
    );
  });

  it('keeps untouched global fields from an older scheduled response while a newer reactive scoped snapshot owns Fable', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-reactive-test': 'field-generation-merge',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    let usageCalls = 0;
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async () => {
        usageCalls += 1;
        if (usageCalls === 1) {
          scheduledStarted = true;
          await scheduledPending;
          return {
            five_hour: { utilization: 0.2, resets_at: futureReset() },
            seven_day: { utilization: 0.3, resets_at: futureReset() },
            scoped_weekly: [{
              key: 'sonnet', label: 'Sonnet', utilization: 0.4, resets_at: futureReset(),
            }],
          };
        }
        reactiveStarted = true;
        await reactivePending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'field-generation-merge');
    assert.deepEqual(
      accountManager.find('acct_1').quota.weeklyScoped.map(limit => [limit.key, limit.utilization]),
      [['fable', 0.1]],
    );
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;
    const finalQuota = accountManager.find('acct_1').quota;

    assert.equal(scheduledResponse.status, 200);
    assert.equal(usageCalls, 2);
    assert.equal(finalQuota.unified5h, 0.2);
    assert.equal(finalQuota.unified7d, 0.3);
    assert.deepEqual(
      finalQuota.weeklyScoped.map(limit => [limit.key, limit.utilization]),
      [['fable', 0.1]],
    );
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('lets a newer reactive low observation overwrite an older scheduled exhaustion that applied first', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          scheduledStarted = true;
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        reactiveStarted = true;
        await reactivePending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;

    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    assert.equal(
      accountManager.getStatus().accounts.find(account => account.id === 'acct_1').unavailableReason?.type,
      'quota_exhausted',
    );
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 0.1);
    assert.notEqual(
      accountManager.getStatus().accounts.find(account => account.id === 'acct_1').unavailableReason?.type,
      'quota_exhausted',
    );
  });

  it('retries from newer scheduled exact Fable quota when an older reactive observation is superseded', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          reactiveStarted = true;
          await reactivePending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
            }],
          };
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    const scheduledResponse = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
  });

  it('does not replay from an older reactive Fable high while a newer scheduled low observation is pending', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'newer-scheduled-pending',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          reactiveStarted = true;
          await reactivePending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        scheduledStarted = true;
        await scheduledPending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseReactive?.();
      releaseScheduled?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'newer-scheduled-pending');
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;
    const finalAccount = accountManager.getStatus().accounts
      .find(account => account.id === 'acct_1');

    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountOneUsageCalls, 2);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 0.1);
    assert.notEqual(finalAccount.unavailableReason?.type, 'quota_exhausted');
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('logs an observable line when a scheduled usage refresh fails', async () => {
    const logLines = [];
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async () => {
        throw new Error('Usage fetch failed (429): {"detail":"SENTINEL_BODY_do_not_log"}');
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(response.status, 200);
    const logText = logLines.join('\n');
    assert.match(
      logText,
      /usage-refresh account=acct_1 result=failed errorType=http-429/,
    );
    assert.doesNotMatch(logText, /SENTINEL_BODY_do_not_log/);
  });

  it('does not let an older scheduled Usage 401 mark error after a newer reactive observation starts', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let scheduledStarted = false;
    let rejectScheduled;
    let releaseScheduledSafely;
    const scheduledPending = new Promise((resolve, reject) => {
      rejectScheduled = reject;
      releaseScheduledSafely = () => resolve({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
        }],
      });
    });
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          scheduledStarted = true;
          return scheduledPending;
        }
        reactiveStarted = true;
        await reactivePending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduledSafely?.();
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    rejectScheduled(new Error('Usage fetch failed (401)'));
    const scheduledResponse = await scheduledRefresh;

    assert.equal(scheduledResponse.status, 200);
    const accountWhileReactivePending = accountManager.getStatus().accounts
      .find(account => account.id === 'acct_1');
    assert.notEqual(accountWhileReactivePending.status, 'error');
    assert.notEqual(accountWhileReactivePending.unavailableReason?.type, 'oauth_refresh_failed');
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    const finalAccount = accountManager.getStatus().accounts.find(account => account.id === 'acct_1');
    assert.notEqual(finalAccount.status, 'error');
    assert.equal(finalAccount.unavailableReason?.type, 'quota_exhausted');
    assert.equal(finalAccount.unavailableReason?.window, '7d Fable');
  });

  it('applies an older deferred Usage 401 when the newer reactive confirmation fails instead of dropping the error', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-reactive-test': 'deferred-usage-401',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    let usageCalls = 0;
    let scheduledStarted = false;
    let rejectScheduled;
    let releaseScheduledSafely;
    const scheduledPending = new Promise((resolve, reject) => {
      rejectScheduled = reject;
      releaseScheduledSafely = () => resolve({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
        }],
      });
    });
    let reactiveStarted = false;
    let rejectReactive;
    let releaseReactiveSafely;
    const reactivePending = new Promise((resolve, reject) => {
      rejectReactive = reject;
      releaseReactiveSafely = () => resolve({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
        }],
      });
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      reactiveQuotaConfirmTimeoutMs: 500,
      usageFetcher: async () => {
        usageCalls += 1;
        if (usageCalls === 1) {
          scheduledStarted = true;
          return scheduledPending;
        }
        reactiveStarted = true;
        return reactivePending;
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduledSafely?.();
      releaseReactiveSafely?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    rejectScheduled(new Error('Usage fetch failed (401)'));
    const scheduledResponse = await scheduledRefresh;
    const accountWhileReactivePending = accountManager.getStatus().accounts
      .find(account => account.id === 'acct_1');

    assert.equal(scheduledResponse.status, 200);
    assert.notEqual(accountWhileReactivePending.status, 'error');
    assert.notEqual(accountWhileReactivePending.unavailableReason?.type, 'oauth_refresh_failed');
    rejectReactive(new Error('reactive Usage fetch failed'));
    const response = await responsePending;
    const finalAccount = accountManager.getStatus().accounts
      .find(account => account.id === 'acct_1');

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'deferred-usage-401');
    assert.equal(usageCalls, 2);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(finalAccount.status, 'error');
    assert.equal(finalAccount.unavailableReason?.type, 'oauth_refresh_failed');
  });

  // (c) 分類できない失敗では cause を捏造せず、検出時刻だけを残す。
  it('records only the detected time when the failure has no machine code to name', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { refreshToken: 'refresh-only-fixture' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      allowLiveClaudeCodeCredentials: false,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async () => assert.fail('usage must not be fetched without an access token'),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.deepEqual(refresh.body.status.accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
      at: '1970-01-01T00:00:01.000Z',
    }, 'cause=Error のような中身のない原因を画面へ出さない');
  });

  // (c) 母艦裁定 C-20260915-3F-03。上のテストと同じ「古い失敗を後から適用する」経路で、
  // 記録される検出時刻が「適用した時刻」ではなく「実際に失敗を見た時刻」であることを見る。
  // 適用は newer な観測が片付くまで待たされるので、適用時に時計を読むと、口座が落ちた
  // 時刻が実際より後ろにずれて記録されてしまう。
  it('stamps a deferred Usage 401 with when it was seen, not when it was finally applied', async () => {
    const upstream = await listen(http.createServer((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'temporary Fable throttle' },
      }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    let clockMs = Date.now();
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => clockMs,
    });
    let usageCalls = 0;
    let scheduledStarted = false;
    let rejectScheduled;
    let releaseScheduledSafely;
    const scheduledPending = new Promise((resolve, reject) => {
      rejectScheduled = reject;
      releaseScheduledSafely = () => resolve({});
    });
    let reactiveStarted = false;
    let rejectReactive;
    let releaseReactiveSafely;
    const reactivePending = new Promise((resolve, reject) => {
      rejectReactive = reject;
      releaseReactiveSafely = () => resolve({});
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      reactiveQuotaConfirmTimeoutMs: 500,
      usageFetcher: async () => {
        usageCalls += 1;
        if (usageCalls === 1) {
          scheduledStarted = true;
          return scheduledPending;
        }
        reactiveStarted = true;
        return reactivePending;
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduledSafely?.();
      releaseReactiveSafely?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    assert.equal(await waitForStatus(() => scheduledStarted, Boolean), true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    assert.equal(await waitForStatus(() => reactiveStarted, Boolean), true);

    const detectedAtMs = clockMs;
    rejectScheduled(new Error('Usage fetch failed (401)'));
    await scheduledRefresh;
    assert.notEqual(
      accountManager.getStatus().accounts[0].status,
      'error',
      '新しい観測が飛んでいる間は、まだ失敗を適用しない（前提の確認）',
    );

    clockMs += 5 * 60 * 1000;
    assert.equal(clockMs - detectedAtMs, 5 * 60 * 1000, '適用までに時計を5分進めた');

    rejectReactive(new Error('reactive Usage fetch failed'));
    await responsePending;

    const reason = accountManager.getStatus().accounts[0].unavailableReason;
    assert.equal(reason.type, 'oauth_refresh_failed');
    assert.equal(reason.cause, 'http-401', '原因コードは server.log の errorType= と同じ値');
    assert.equal(
      reason.at,
      new Date(detectedAtMs).toISOString(),
      '5分後に適用されても、記録は失敗を見た時刻のまま',
    );
  });

  it('serializes stateWriter snapshots so an older slow write cannot roll back newer quota', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    let usageCalls = 0;
    let durableState = null;
    const writerStarts = [];
    const writerFinishes = [];
    let releaseFirstWrite;
    const firstWritePending = new Promise(resolve => { releaseFirstWrite = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          five_hour: {
            utilization: usageCalls === 1 ? 0.1 : 0.8,
            resets_at: futureReset(),
          },
        };
      },
      stateWriter: async snapshot => {
        const utilization = snapshot.accounts[0].quota.unified5h;
        writerStarts.push(utilization);
        if (writerStarts.length === 1) await firstWritePending;
        durableState = snapshot;
        writerFinishes.push(utilization);
      },
    }));
    cleanupAfterTest(async () => {
      releaseFirstWrite?.();
      await close(proxy.server);
    });

    const firstRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const firstWriterStarted = await waitForStatus(() => writerStarts.length, count => count === 1);
    assert.equal(firstWriterStarted, 1);
    const secondRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const secondSnapshotCaptured = await waitForStatus(
      () => ({
        usageCalls,
        utilization: accountManager.find('acct_1').quota.unified5h,
      }),
      value => value.usageCalls === 2 && value.utilization === 0.8,
    );
    assert.deepEqual(secondSnapshotCaptured, { usageCalls: 2, utilization: 0.8 });
    assert.deepEqual(writerStarts, [0.1]);
    releaseFirstWrite();
    const [firstResponse, secondResponse] = await Promise.all([firstRefresh, secondRefresh]);

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(writerStarts, [0.1, 0.8]);
    assert.deepEqual(writerFinishes, [0.1, 0.8]);
    assert.equal(durableState.accounts[0].quota.unified5h, 0.8);
  });

  it('tokenizes model families so claude-unfabled-5 cannot match Fable by substring', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'unrelated model throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'substring-boundary',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-unfabled-5' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'substring-boundary');
    assert.equal(usageCalls, 0);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('requires an exact canonical Fable model id set match for reactive Usage confirmation', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'negated model throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'negated-fable-token',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const models = [
      'claude-not-fable-5',
      'CLAUDE-FABLE-5',
      ' claude-fable-5 ',
      'claude-fable-5-20260818',
      'claude-fable-5-1-20260901',
      'claude-mythos-5-1',
    ];
    for (const model of models) {
      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model }),
      });
      assert.equal(response.status, 429, model);
      assert.deepEqual(response.body, originalBody, model);
      assert.equal(response.headers['x-reactive-test'], 'negated-fable-token', model);
    }
    assert.equal(usageCalls, 0);
    assert.deepEqual(upstreamSeen, Array(models.length).fill('Bearer access-token-1'));
  });

  it('expires a 20ms reactive confirmation so late Usage success cannot mutate quota', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'deadline throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-reactive-test': 'external-deadline',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    let usageReturned = false;
    let releaseUsage;
    const usagePending = new Promise(resolve => { releaseUsage = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 20,
      usageFetcher: async () => {
        usageCalls += 1;
        await usagePending;
        usageReturned = true;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseUsage?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const startedAt = Date.now();
    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 500,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'external-deadline');
    assert.equal(usageCalls, 1);
    assert.equal(usageReturned, false);
    assert.ok(elapsedMs >= 10 && elapsedMs < 250, `expected 20ms deadline, got ${elapsedMs}ms`);
    releaseUsage();
    const lateUsageReturned = await waitForStatus(() => usageReturned, Boolean);
    assert.equal(lateUsageReturned, true);
    await sleep(10);

    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.deepEqual(accountManager.find('acct_1').quota.weeklyScoped, []);
    assert.notEqual(
      accountManager.getStatus().accounts.find(account => account.id === 'acct_1').unavailableReason?.type,
      'quota_exhausted',
    );
  });

  it('aborts reactive Usage promptly when the client disconnects instead of waiting for its deadline', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'client went away' },
      }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageStarted = false;
    let usageSignal = null;
    let usageAborted = false;
    let settleUsage;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 5_000,
      usageFetcher: async (_token, { signal }) => new Promise((resolve, reject) => {
        usageStarted = true;
        usageSignal = signal;
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          usageAborted = true;
          const error = new Error('reactive Usage aborted with client');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        settleUsage = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve({
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
            }],
          });
        };
      }),
    }));
    cleanupAfterTest(async () => {
      settleUsage?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const target = new URL(`${proxy.url}/v1/messages`);
    const clientRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
    });
    clientRequest.on('error', () => {});
    clientRequest.end(JSON.stringify({ model: 'claude-fable-5' }));
    const started = await waitForStatus(() => usageStarted, Boolean, 250);
    assert.equal(started, true);
    const abortedAt = Date.now();
    clientRequest.destroy();
    const abortedPromptly = await waitForStatus(() => usageAborted, Boolean, 250);
    const abortElapsedMs = Date.now() - abortedAt;
    settleUsage?.();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual({
      abortedPromptly,
      signalAborted: usageSignal?.aborted,
      beforeFiveSecondDeadline: abortElapsedMs < 1_000,
      upstreamSeen,
    }, {
      abortedPromptly: true,
      signalAborted: true,
      beforeFiveSecondDeadline: true,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('keeps reactive target snapshots read-only when Usage confirmation rejects', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'client went away' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const storedTarget = { accessToken: 'access-token-2' };
    await secretStore.set('acct_2', storedTarget);
    const originalCompareAndSet = secretStore.compareAndSet.bind(secretStore);
    let compareAndSetCalls = 0;
    secretStore.compareAndSet = async (...args) => {
      compareAndSetCalls += 1;
      return originalCompareAndSet(...args);
    };
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth', accountUuid: 'uuid-live' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let profileCalls = 0;
    const currentProfileFetcher = async () => {
      profileCalls += 1;
      return { accountUuid: 'uuid-live' };
    };
    let usageSignal = null;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 500,
      currentCredentialReader: async () => ({
        accessToken: 'live-access-token',
        refreshToken: 'live-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      currentProfileFetcher,
      usageFetcher: async (_token, options) => {
        usageSignal = options.signal;
        throw new Error('Usage unavailable');
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_000,
    });

    assert.equal(response.status, 429);
    assert.equal(usageSignal?.aborted, true);
    assert.equal(profileCalls, 0);
    assert.equal(compareAndSetCalls, 0);
    assert.deepEqual(await secretStore.get('acct_2'), storedTarget);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('aborts token-bearing Usage when a reactive target snapshot fails', async () => {
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'snapshot failed' },
    };
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    let markUsageStarted;
    const usageStarted = new Promise(resolve => { markUsageStarted = resolve; });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageAborted = false;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async (_token, options) => new Promise((resolve, reject) => {
        const onAbort = () => {
          usageAborted = true;
          const error = new Error('Usage aborted after sibling failure');
          error.name = 'AbortError';
          reject(error);
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        markUsageStarted();
        if (options.signal.aborted) onAbort();
      }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });
    // Let startup reconciliation (operationalStateCheck) read every account's
    // real operational secret before installing a mock that hangs until the
    // reactive Usage fetch starts; otherwise reconcile would deadlock waiting
    // on the request it is itself blocking.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    const originalGet = secretStore.get.bind(secretStore);
    const readAccountTwoAfterUsageStarted = async accountId => {
      if (accountId !== 'acct_2') return originalGet(accountId);
      await usageStarted;
      throw new Error('target secret read failed');
    };
    secretStore.get = readAccountTwoAfterUsageStarted;
    secretStore.getOperational = readAccountTwoAfterUsageStarted;

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_000,
    });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(usageAborted, true);
  });

  it('keeps a shared reactive Usage fetch alive while another downstream waiter remains', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth', accountUuid: 'uuid-live' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    let usageSignal = null;
    let releaseUsage;
    const usagePending = new Promise(resolve => { releaseUsage = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 1_000,
      currentProfileFetcher: async () => assert.fail('reactive snapshots must not fetch profile'),
      usageFetcher: async (_token, options) => {
        usageCalls += 1;
        usageSignal = options.signal;
        await usagePending;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseUsage?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const target = new URL(`${proxy.url}/v1/messages`);
    const abandonedRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
    });
    abandonedRequest.on('error', () => {});
    abandonedRequest.end(JSON.stringify({ model: 'claude-fable-5' }));
    const usageStarted = await waitForStatus(() => usageCalls, count => count === 1, 250);
    assert.equal(usageStarted, 1);
    const survivingRequest = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_500,
    });
    const bothWaiting = await waitForStatus(
      () => upstreamSeen.filter(value => value === 'Bearer access-token-1').length,
      count => count === 2,
      250,
    );
    assert.equal(bothWaiting, 2);
    abandonedRequest.destroy();
    await sleep(20);

    assert.equal(usageSignal?.aborted, false);
    releaseUsage();
    const response = await survivingRequest;

    assert.equal(response.status, 200);
    assert.equal(usageCalls, 1);
    assert.equal(usageSignal?.aborted, false);
  });

  it('stops all quota replays after one reactive failover so a confirmed second 429 is returned without posting to a third account', async () => {
    const upstreamSeen = [];
    const secondAccountBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'second account quota' },
    };
    const secondAccountReset = String(Math.floor(Date.parse(futureReset()) / 1000));
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous Fable limit' },
        }));
        return;
      }
      if (req.headers.authorization === 'Bearer access-token-2') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'second-account-quota',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': secondAccountReset,
        });
        res.end(JSON.stringify(secondAccountBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of [1, 2, 3]) {
      await secretStore.set(`acct_${id}`, { accessToken: `access-token-${id}` });
    }
    const accountManager = new AccountManager({
      accounts: [1, 2, 3].map(id => ({ id: `acct_${id}`, type: 'oauth' })),
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    accountManager.updateQuota('acct_3', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, secondAccountBody);
    assert.equal(response.headers['x-reactive-test'], 'second-account-quota');
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
  });

  it('does not replay from an older scheduled Fable scope when the newer reactive Usage payload omits Fable', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'newer-scope-omission',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          scheduledStarted = true;
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        reactiveStarted = true;
        await reactivePending;
        return {
          scoped_weekly: [{
            key: 'sonnet', label: 'Sonnet', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;

    assert.equal(scheduledResponse.status, 200);
    assert.equal(accountManager.find('acct_1').quota.weeklyScoped[0].utilization, 1);
    releaseReactive();
    const response = await responsePending;

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'newer-scope-omission');
    assert.equal(accountOneUsageCalls, 2);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('clears an older future-reset Fable high when the newer reactive Fable high has a past reset', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous Fable throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'invalid-reactive-clears-stale-scope',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    let scheduledStarted = false;
    let releaseScheduled;
    const scheduledPending = new Promise(resolve => { releaseScheduled = resolve; });
    let reactiveStarted = false;
    let releaseReactive;
    const reactivePending = new Promise(resolve => { releaseReactive = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        if (accountOneUsageCalls === 1) {
          scheduledStarted = true;
          await scheduledPending;
          return {
            scoped_weekly: [{
              key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
            }],
          };
        }
        reactiveStarted = true;
        await reactivePending;
        return {
          scoped_weekly: [{
            key: 'fable',
            label: 'Fable',
            utilization: 1,
            resets_at: new Date(Date.now() - 60_000).toISOString(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseScheduled?.();
      releaseReactive?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const scheduledRefresh = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const scheduledObserved = await waitForStatus(() => scheduledStarted, Boolean);
    assert.equal(scheduledObserved, true);
    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const reactiveObserved = await waitForStatus(() => reactiveStarted, Boolean);
    assert.equal(reactiveObserved, true);
    releaseScheduled();
    const scheduledResponse = await scheduledRefresh;
    const storedHigh = accountManager.find('acct_1').quota.weeklyScoped[0];

    assert.equal(scheduledResponse.status, 200);
    assert.equal(storedHigh.utilization, 1);
    assert.ok(storedHigh.resetAt > Date.now());
    assert.equal(
      accountManager.getStatus().accounts.find(account => account.id === 'acct_1')
        .unavailableReason?.type,
      'quota_exhausted',
    );
    releaseReactive();
    const response = await responsePending;
    const finalAccount = accountManager.getStatus().accounts
      .find(account => account.id === 'acct_1');

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'invalid-reactive-clears-stale-scope');
    assert.equal(accountOneUsageCalls, 2);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.deepEqual(accountManager.find('acct_1').quota.weeklyScoped, []);
    assert.notEqual(finalAccount.unavailableReason?.type, 'quota_exhausted');
  });

  it('does not post to an account identity introduced after reactive confirmation but before replay selection', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'identity race throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'identity-replaced-before-replay',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    await secretStore.set('acct_new', { accessToken: 'access-token-new' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const originalIsAvailable = accountManager.isAvailable.bind(accountManager);
    let armReplacement = false;
    let replacementScheduled = false;
    let replacementApplied = false;
    accountManager.isAvailable = account => {
      const available = originalIsAvailable(account);
      if (
        armReplacement
        && account.id === 'acct_2'
        && available
        && !replacementScheduled
      ) {
        replacementScheduled = true;
        queueMicrotask(() => {
          accountManager.replaceAccounts([{ id: 'acct_new', type: 'oauth' }]);
          replacementApplied = true;
        });
      }
      return available;
    };
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        armReplacement = true;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(replacementApplied, true);
    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-reactive-test'], 'identity-replaced-before-replay');
    assert.equal(usageCalls, 1);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
  });

  it('does not replay with a changed OAuth access token hidden by a stable mixed-secret API key', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'target credential changed' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'target-secret-changed',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', {
      accessToken: 'old-target-token',
      apiKey: 'stable-unused-api-key',
    });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let targetSecretReads = 0;
    let secretChangeApplied = false;
    const readAccountTwoWithMutationOnFirstRead = async accountId => {
      const secret = await originalGetSecret(accountId);
      if (accountId === 'acct_2') {
        targetSecretReads += 1;
        if (targetSecretReads === 1) {
          queueMicrotask(async () => {
            await secretStore.set('acct_2', {
              accessToken: 'new-target-token',
              apiKey: 'stable-unused-api-key',
            });
            secretChangeApplied = true;
          });
        }
      }
      return secret;
    };
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    const targetAccount = accountManager.find('acct_2');
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });
    // Let startup reconciliation read every account's real operational secret
    // before installing a mock that mutates acct_2 on its first read.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    secretStore.get = readAccountTwoWithMutationOnFirstRead;
    secretStore.getOperational = readAccountTwoWithMutationOnFirstRead;

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });
    const replaySecretReads = targetSecretReads;
    const storedTarget = await secretStore.get('acct_2');

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      secretChangeApplied,
      replaySecretReads,
      sameAccountObject: accountManager.find('acct_2') === targetAccount,
      currentAccount: accountManager.getStatus().currentAccount,
      storedTargetToken: storedTarget.accessToken,
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'target-secret-changed',
      secretChangeApplied: true,
      replaySecretReads: 2,
      sameAccountObject: true,
      currentAccount: 'acct_1',
      storedTargetToken: 'new-target-token',
      usageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('preserves the original reactive 429 when the final target secret read fails', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'target read failed' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'target-read-failed',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let targetSecretReads = 0;
    const readAccountTwoFailingOnFinalRead = async accountId => {
      if (accountId === 'acct_2') {
        targetSecretReads += 1;
        // Duplicate-token preflight and refresh-intent reconciliation perform
        // the first two reads; reactive snapshot/final resolution are 3/4.
        if (targetSecretReads === 4) throw new Error('final reactive target read failed');
      }
      return originalGetSecret(accountId);
    };
    secretStore.get = readAccountTwoFailingOnFinalRead;
    secretStore.getOperational = readAccountTwoFailingOnFinalRead;
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      targetSecretReads,
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'target-read-failed',
      targetSecretReads: 4,
      usageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('excludes a parked candidate account from the reactive replay path instead of reusing its stale secret', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'fable exhausted, only alternate is parked' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-reactive-test': 'parked-alternate-excluded',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', {
      accessToken: 'access-token-2',
      refreshToken: 'refresh-token-2',
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });
    // Let startup reconciliation settle first, then park acct_2 (durable
    // "handed_off" refresh-intent, mirroring an ambiguous native refresh
    // handoff) after the server is already serving. accountManager still
    // considers acct_2 quota-available; only secretStore knows it is parked.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    await assert.rejects(
      secretStore.refreshIfUnchanged(
        'acct_2',
        await secretStore.get('acct_2'),
        async (_current, transaction) => {
          await transaction.beforeHandoff();
          throw Object.assign(new Error('ambiguous handoff'), {
            code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
          });
        },
      ),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_000,
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'parked-alternate-excluded',
      usageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('preserves the original reactive 429 when its only replay target becomes throttled before account selection', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'replay target disappeared' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'target-throttled-before-replay',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const originalIsAvailable = accountManager.isAvailable.bind(accountManager);
    let armThrottle = false;
    let throttleScheduled = false;
    let throttleApplied = false;
    accountManager.isAvailable = account => {
      const available = originalIsAvailable(account);
      if (
        armThrottle
        && account.id === 'acct_2'
        && available
        && !throttleScheduled
      ) {
        throttleScheduled = true;
        queueMicrotask(() => {
          accountManager.markRateLimited('acct_2', 60);
          throttleApplied = true;
        });
      }
      return available;
    };
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        armThrottle = true;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      rotatorAccount: response.headers['x-claude-rotator-account'],
      throttleApplied,
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'target-throttled-before-replay',
      rotatorAccount: undefined,
      throttleApplied: true,
      usageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('does not replay after the confirmed Fable reset expires while resolving the target secret', async () => {
    let now = Date.now();
    const resetAt = now + 1_000;
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'short-lived confirmation' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'confirmation-expired-before-replay',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let targetSecretReads = 0;
    let releaseTargetSecret;
    const targetSecretGate = new Promise(resolve => { releaseTargetSecret = resolve; });
    const readAccountTwoGatedByTargetSecret = async accountId => {
      const secret = await originalGetSecret(accountId);
      if (accountId === 'acct_2') {
        targetSecretReads += 1;
        await targetSecretGate;
      }
      return secret;
    };
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      now: () => now,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => {
        usageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable',
            label: 'Fable',
            utilization: 1,
            resets_at: new Date(resetAt).toISOString(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseTargetSecret?.();
      await close(proxy.server);
      await close(upstream.server);
    });
    // Let startup reconciliation read every account's real operational secret
    // before installing a mock that gates on acct_2's target-secret read.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    secretStore.get = readAccountTwoGatedByTargetSecret;
    secretStore.getOperational = readAccountTwoGatedByTargetSecret;

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 500,
    });
    const secretReadStarted = await waitForStatus(
      () => targetSecretReads,
      count => count === 1,
      250,
    );
    assert.equal(secretReadStarted, 1);
    now = resetAt + 1;
    releaseTargetSecret();
    const response = await responsePending;

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      rotatorAccount: response.headers['x-claude-rotator-account'],
      resetExpired: now > resetAt,
      targetSecretReads,
      usageCalls,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'confirmation-expired-before-replay',
      rotatorAccount: undefined,
      resetExpired: true,
      targetSecretReads: 1,
      usageCalls: 1,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('does not replay after a newer scheduled Fable low applies while resolving the target secret', async () => {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'scheduled low superseded high' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'scheduled-low-before-replay',
        });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const originalGetSecret = secretStore.get.bind(secretStore);
    let targetSecretReads = 0;
    let releaseTargetSecret;
    const targetSecretGate = new Promise(resolve => { releaseTargetSecret = resolve; });
    const readAccountTwoGatedByTargetSecret = async accountId => {
      const secret = await originalGetSecret(accountId);
      if (accountId === 'acct_2') {
        targetSecretReads += 1;
        await targetSecretGate;
      }
      return secret;
    };
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      switchThreshold: 0.8,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let accountOneUsageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        if (token !== 'access-token-1') {
          return { five_hour: { utilization: 0.1, resets_at: futureReset() } };
        }
        accountOneUsageCalls += 1;
        return {
          scoped_weekly: [{
            key: 'fable',
            label: 'Fable',
            utilization: accountOneUsageCalls === 1 ? 1 : 0.8,
            resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseTargetSecret?.();
      await close(proxy.server);
      await close(upstream.server);
    });
    // Let startup reconciliation read every account's real operational secret
    // before installing a mock that gates on acct_2's target-secret read.
    await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });
    secretStore.get = readAccountTwoGatedByTargetSecret;
    secretStore.getOperational = readAccountTwoGatedByTargetSecret;

    const responsePending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 500,
    });
    const secretReadStarted = await waitForStatus(
      () => targetSecretReads,
      count => count >= 1,
      250,
    );
    assert.ok(secretReadStarted >= 1);
    const scheduledPending = requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 500,
    });
    const scheduledLow = await waitForStatus(
      () => accountManager.find('acct_1').quota.weeklyScoped[0]?.utilization,
      utilization => utilization === 0.8,
      250,
    );
    assert.equal(scheduledLow, 0.8);
    releaseTargetSecret();
    const [response, scheduledResponse] = await Promise.all([responsePending, scheduledPending]);

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      scheduledStatus: scheduledResponse.status,
      accountOneUsageCalls,
      finalFable: accountManager.find('acct_1').quota.weeklyScoped[0]?.utilization,
      upstreamSeen,
    }, {
      status: 429,
      body: originalBody,
      marker: 'scheduled-low-before-replay',
      scheduledStatus: 200,
      accountOneUsageCalls: 2,
      finalFable: 0.8,
      upstreamSeen: ['Bearer access-token-1'],
    });
  });

  it('starts one replacement Usage fetch after an expired forever-pending confirmation and makes concurrent callers join it', async () => {
    let now = Date.now();
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'pending Usage throttle' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-reactive-test': 'bounded-replacement-fetch',
      });
      res.end(JSON.stringify(originalBody));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => now,
    });
    let usageCalls = 0;
    let liveUsageFetches = 0;
    let maxLiveUsageFetches = 0;
    let releaseReplacement;
    const replacementPending = new Promise(resolve => { releaseReplacement = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 250,
      usageFetcher: async () => {
        usageCalls += 1;
        liveUsageFetches += 1;
        maxLiveUsageFetches = Math.max(maxLiveUsageFetches, liveUsageFetches);
        if (usageCalls === 1) return new Promise(() => {});
        await replacementPending;
        liveUsageFetches -= 1;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseReplacement?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const firstResponse = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_500,
    });

    assert.equal(firstResponse.status, 429);
    assert.deepEqual(firstResponse.body, originalBody);
    assert.equal(usageCalls, 1);
    now += 61_000;
    const secondPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_500,
    });
    const thirdPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-fable-5' }),
      timeoutMs: 1_500,
    });
    const callersJoinedReplacement = await waitForStatus(
      () => ({ usageCalls, upstreamRequests: upstreamSeen.length }),
      value => value.usageCalls === 2 && value.upstreamRequests === 3,
      1_000,
    );
    assert.deepEqual(callersJoinedReplacement, { usageCalls: 2, upstreamRequests: 3 });
    releaseReplacement();
    const [secondResponse, thirdResponse] = await Promise.all([secondPending, thirdPending]);

    assert.equal(secondResponse.status, 429);
    assert.equal(thirdResponse.status, 429);
    assert.deepEqual(secondResponse.body, originalBody);
    assert.deepEqual(thirdResponse.body, originalBody);
    assert.equal(usageCalls, 2);
    assert.equal(maxLiveUsageFetches, 2);
    assert.equal(liveUsageFetches, 1);
    assert.deepEqual(upstreamSeen, [
      'Bearer access-token-1',
      'Bearer access-token-1',
      'Bearer access-token-1',
    ]);
  });

  it('keeps a replacement Usage single-flight registered after the expired fetch settles late', async () => {
    let now = Date.now();
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error', error: { type: 'rate_limit_error', message: 'late old Usage' },
      }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => now,
    });
    let usageCalls = 0;
    let firstFetchSettled = false;
    let releaseFirst;
    const firstPending = new Promise(resolve => { releaseFirst = resolve; });
    let releaseReplacement;
    const replacementPending = new Promise(resolve => { releaseReplacement = resolve; });
    const usageSignals = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reactiveQuotaConfirmTimeoutMs: 1_000,
      usageFetcher: async (_token, { signal }) => {
        usageCalls += 1;
        usageSignals.push(signal);
        if (usageCalls === 1) {
          await firstPending;
          firstFetchSettled = true;
        } else {
          await replacementPending;
        }
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 0.1, resets_at: futureReset(),
          }],
        };
      },
    }));
    cleanupAfterTest(async () => {
      releaseFirst?.();
      releaseReplacement?.();
      await close(proxy.server);
      await close(upstream.server);
    });

    const target = new URL(`${proxy.url}/v1/messages`);
    const abandonedRequest = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
    });
    abandonedRequest.on('error', () => {});
    abandonedRequest.end(JSON.stringify({ model: 'claude-fable-5' }));
    assert.equal(await waitForStatus(() => usageCalls, count => count === 1), 1);
    abandonedRequest.destroy();
    assert.equal(
      await waitForStatus(() => usageSignals[0]?.aborted, Boolean),
      true,
    );
    now += 61_000;

    const secondPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_500,
    });
    assert.equal(await waitForStatus(() => usageCalls, count => count === 2), 2);
    releaseFirst();
    assert.equal(await waitForStatus(() => firstFetchSettled, Boolean), true);
    await sleep(300);

    const thirdPending = requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }), timeoutMs: 1_500,
    });
    assert.equal(await waitForStatus(() => upstreamSeen.length, count => count === 3), 3);
    assert.equal(usageCalls, 2);
    releaseReplacement();
    const [secondResponse, thirdResponse] = await Promise.all([secondPending, thirdPending]);

    assert.equal(secondResponse.status, 429);
    assert.equal(thirdResponse.status, 429);
    assert.equal(usageCalls, 2);
  });

  it('returns a refreshable 401 unchanged after one reactive replay without refreshing or reposting the request', async () => {
    const upstreamSeen = [];
    const authenticationBody = {
      type: 'error',
      error: { type: 'authentication_error', message: 'second account token rejected' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous Fable limit' },
        }));
        return;
      }
      if (req.headers.authorization === 'Bearer stale-access-token-2') {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'x-reactive-test': 'second-account-authentication',
        });
        res.end(JSON.stringify(authenticationBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', {
      accessToken: 'stale-access-token-2',
      refreshToken: 'refresh-token-2',
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
      tokenRefresher: async (refreshToken, context) => {
        await context.beforeHandoff();
        refreshCalls += 1;
        assert.equal(refreshToken, 'refresh-token-2');
        return {
          accessToken: 'refreshed-access-token-2',
          refreshToken: 'refresh-token-2-next',
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      marker: response.headers['x-reactive-test'],
      refreshCalls,
      upstreamSeen,
    }, {
      status: 401,
      body: authenticationBody,
      marker: 'second-account-authentication',
      refreshCalls: 0,
      upstreamSeen: ['Bearer access-token-1', 'Bearer stale-access-token-2'],
    });
  });

  for (const scenario of [
    {
      name: 'matching Sonnet scope is exhausted',
      usage: () => ({
        scoped_weekly: [{
          key: 'sonnet', label: 'Sonnet', utilization: 1, resets_at: futureReset(),
        }],
      }),
    },
    {
      name: 'global five-hour quota is exhausted',
      usage: () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
    },
  ]) {
    it(`keeps reactive Usage confirmation Fable-only for Sonnet even when ${scenario.name}`, async () => {
      const upstreamSeen = [];
      const originalBody = {
        type: 'error', error: { type: 'rate_limit_error', message: 'ambiguous Sonnet limit' },
      };
      const upstream = await listen(http.createServer((req, res) => {
        upstreamSeen.push(req.headers.authorization);
        if (req.headers.authorization === 'Bearer access-token-1') {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'x-reactive-test': 'sonnet-fable-only',
          });
          res.end(JSON.stringify(originalBody));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      await secretStore.set('acct_2', { accessToken: 'access-token-2' });
      const accountManager = new AccountManager({
        accounts: [
          { id: 'acct_1', type: 'oauth' },
          { id: 'acct_2', type: 'oauth' },
        ],
      });
      accountManager.updateQuota('acct_2', {
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
      });
      let usageCalls = 0;
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
        usageFetcher: async () => {
          usageCalls += 1;
          return scenario.usage();
        },
      }));
      cleanupAfterTest(async () => {
        await close(proxy.server);
        await close(upstream.server);
      });

      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5' }),
      });

      assert.deepEqual({
        status: response.status,
        body: response.body,
        marker: response.headers['x-reactive-test'],
        usageCalls,
        upstreamSeen,
      }, {
        status: 429,
        body: originalBody,
        marker: 'sonnet-fable-only',
        usageCalls: 0,
        upstreamSeen: ['Bearer access-token-1'],
      });
    });
  }

  it('passes through retryable server errors without switching accounts', async () => {
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
    cleanupAfterTest(async () => {
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

  it('passes through a retryable server error when no alternate account is available', async () => {
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
    cleanupAfterTest(async () => {
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

  it('returns an upstream timeout without switching accounts', async () => {
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
    cleanupAfterTest(async () => {
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

  it('does not treat an unrelated socket timeout event as the configured upstream idle timeout', async () => {
    const originalRequest = http.request;
    http.request = function patchedRequest(...args) {
      const clientRequest = originalRequest.apply(this, args);
      const originalSetTimeout = clientRequest.setTimeout;
      clientRequest.setTimeout = function patchedSetTimeout(timeoutMs, callback) {
        if (typeof callback === 'function') setTimeout(callback, 5);
        return originalSetTimeout.call(this, timeoutMs, callback);
      };
      return clientRequest;
    };

    try {
      const upstream = await listen(http.createServer(async (req, res) => {
        await sleep(30);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'access-token-1' });
      const accountManager = new AccountManager({
        accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      });
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: {
          upstream: upstream.url,
          proxy: { upstreamIdleTimeoutMs: 1000 },
          usagePolling: { enabled: false },
        },
      }));
      cleanupAfterTest(async () => {
        await close(proxy.server);
        await close(upstream.server);
      });

      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet' }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
    } finally {
      http.request = originalRequest;
    }
  });

  it('retries upstream connect timeouts before sending an error to Claude Code', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        proxy: {
          upstreamConnectRetries: 1,
          upstreamConnectTimeoutMs: 10,
          upstreamIdleTimeoutMs: 1000,
        },
        usagePolling: { enabled: false },
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const upstreamPort = new URL(upstream.url).port;
    const originalRequest = http.request;
    let upstreamRequests = 0;
    http.request = function patchedRequest(options, ...args) {
      if (String(options?.port) === upstreamPort && upstreamRequests++ === 0) {
        const fakeRequest = new EventEmitter();
        fakeRequest.write = () => {};
        fakeRequest.end = () => {
          setTimeout(() => {
            const error = new Error('connect ETIMEDOUT');
            error.code = 'ETIMEDOUT';
            fakeRequest.emit('error', error);
          }, 1);
        };
        fakeRequest.destroy = error => {
          if (error) setTimeout(() => fakeRequest.emit('error', error), 0);
        };
        return fakeRequest;
      }
      return originalRequest.call(this, options, ...args);
    };

    try {
      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet' }),
      });

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });
      assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
      assert.equal(upstreamRequests, 2);
    } finally {
      http.request = originalRequest;
    }
  });

  it('returns an upstream timeout when connect retries are exhausted', async () => {
    const upstream = await listen(http.createServer(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstream.url,
        proxy: {
          upstreamConnectRetries: 1,
          upstreamConnectTimeoutMs: 5,
          upstreamConnectRetryDelayMs: 1,
          upstreamIdleTimeoutMs: 1000,
        },
        usagePolling: { enabled: false },
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const upstreamPort = new URL(upstream.url).port;
    const originalRequest = http.request;
    let upstreamRequests = 0;
    http.request = function patchedRequest(options, ...args) {
      if (String(options?.port) === upstreamPort) {
        upstreamRequests++;
        const fakeRequest = new EventEmitter();
        fakeRequest.write = () => {};
        fakeRequest.end = () => {};
        fakeRequest.destroy = () => {};
        return fakeRequest;
      }
      return originalRequest.call(this, options, ...args);
    };

    try {
      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'sonnet' }),
      });

      assert.equal(response.status, 504);
      assert.equal(response.body.error.type, 'upstream_timeout');
      assert.equal(upstreamRequests, 2);
    } finally {
      http.request = originalRequest;
    }
  });

  it('does not rotate after a streaming response has already started', async () => {
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
    cleanupAfterTest(async () => {
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

    const health = await requestJson(`${proxy.url}/internal/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
  });

  it('persists a native refresh outcome with unknown result', async () => {
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
        throw Object.assign(new Error('native refresh outcome is unknown'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(upstreamSeen, []);
    assert.equal(response.body.error.type, 'api_error');
    assert.equal(response.headers['retry-after'], undefined);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
    assert.deepEqual(accountManager.getStatus().accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
      cause: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
      at: '1970-01-01T00:00:01.000Z',
    });
  });

  it('fails closed before refresh when the secret store lacks conditional update transactions', async () => {
    const upstreamSeen = [];
    let refreshCalls = 0;
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secret = {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: 900,
    };
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore: {
        get: async () => ({ ...secret }),
        compareAndSet: async () => assert.fail('legacy compare-and-set must not be used'),
      },
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        refreshCalls++;
        return { accessToken: 'must-not-be-used' };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 503);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(upstreamSeen, []);
  });

  it('uses the earliest known credential retry or quota reset for a local 503', async () => {
    const now = Date.now();
    const accountManager = new AccountManager({
      accounts: [
        { id: 'slow', name: 'slow@example.com', type: 'oauth' },
        { id: 'fast', name: 'fast@example.com', type: 'oauth' },
        { id: 'quota', name: 'quota@example.com', type: 'oauth' },
      ],
      now: () => now,
    });
    accountManager.markCredentialRefreshRateLimited('slow', 120);
    accountManager.markCredentialRefreshRateLimited('fast', 30);
    accountManager.updateQuota('quota', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.ceil((now + 5_000) / 1000)),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore: new MemorySecretStore(),
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      tokenRefresher: async () => {
        throw new Error('token refresher should not be called');
      },
      currentCredentialReader: async () => null,
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    const retryAfter = Number.parseInt(response.headers['retry-after'], 10);
    assert.equal(response.status, 503);
    assert.ok(retryAfter >= 1 && retryAfter <= 6, `unexpected Retry-After: ${retryAfter}`);
    assert.equal(accountManager.getStatus().currentAccount, 'slow');
  });

  it('switches to a known available account when the current OAuth refresh fails', async () => {
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
    cleanupAfterTest(async () => {
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

  it('switches to a known available account when OAuth refresh is rate limited', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'rate-limited-refresh-token',
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
      tokenRefresher: async () => {
        throw new OAuthTokenRefreshError({
          status: 429,
          code: 'rate_limit_error',
          retryAfterMs: 60_000,
        });
      },
    }));
    cleanupAfterTest(async () => {
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
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_rate_limit');
  });

  it('switches to a known available account when local OAuth refresh retry is deferred', async () => {
    const upstreamSeen = [];
    const upstream = await listen(http.createServer(async (req, res) => {
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'native-refresh-token',
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
      tokenRefresher: async () => {
        throw Object.assign(new Error('native refresh command failed'), {
          code: 'NATIVE_REFRESH_COMMAND_FAILED',
          retryAfterMs: 60_000,
          retryAfterSource: 'fixed',
        });
      },
    }));
    cleanupAfterTest(async () => {
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
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.type, 'oauth_refresh_retry');
  });

  it('returns local quota exhaustion when the only account is exhausted', async () => {
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
    cleanupAfterTest(async () => {
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

  it('overrides a misleading upstream monthly limit message when local usage is 5h exhausted', async () => {
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
    cleanupAfterTest(async () => {
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

  it('does not fall back to a quota-exhausted account when the current account is errored', async () => {
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
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(upstreamSeen, []);
    assert.equal(response.body.error.type, 'api_error');
    assert.equal(accountManager.getStatus().currentAccount, 'other');
  });

  it('returns local quota exhaustion when all accounts are exhausted', async () => {
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
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 429);
    assert.deepEqual(upstreamSeen, []);
    assert.match(response.body.error.message, /You've hit your session limit/);
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'five_hour');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], '10');
    assert.equal(response.headers['anthropic-ratelimit-unified-5h-utilization'], '1');
    assert.equal(response.body.error.details.window, '5h');
    assert.match(response.body.error.details.rotator_message, /Claude 5h usage limit exhausted/);
    assert.equal(accountManager.getStatus().currentAccount, 'dev');
  });

  it('prepares a resume target through the internal API', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('weekly-a', { accessToken: 'weekly-a-token' });
    await secretStore.set('dev', { accessToken: 'dev-token' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'weekly-a', name: 'weekly-a@example.com', type: 'oauth' },
        { id: 'dev', name: 'dev@example.com', type: 'oauth' },
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
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1' },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/prepare-resume`, { method: 'POST' });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.action, 'wait');
    assert.equal(response.body.account, 'dev');
    assert.equal(response.body.window, '5h');
    assert.equal(response.body.resumeAtEpoch, 10);
    assert.equal(response.body.status.currentAccount, 'dev');
    assert.equal(JSON.stringify(response.body).includes('dev-token'), false);
  });

  it('refreshes usage for prepare-resume even when polling is disabled', async () => {
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
    let calls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        calls += 1;
        if (token === 'weekly-token') {
          return {
            seven_day: { utilization: 1, resets_at: '2026-06-11T12:00:00Z' },
          };
        }
        return {
          five_hour: { utilization: 1, resets_at: '2026-06-08T10:50:00Z' },
          seven_day: { utilization: 0.2, resets_at: '2026-06-15T03:00:00Z' },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/prepare-resume`, {
      method: 'POST',
      body: JSON.stringify({ refreshUsage: true }),
    });

    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    assert.equal(response.body.action, 'wait');
    assert.equal(response.body.account, 'dev');
    assert.equal(response.body.resumeAtEpoch, Date.parse('2026-06-08T10:50:00Z') / 1000);
  });

  it('waits for initial usage refresh before forwarding the first API request', async () => {
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
      config: { upstream: upstream.url, usagePolling: { enabled: true, requestSpacingMs: 0 } },
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
    cleanupAfterTest(async () => {
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

  it('refreshes OAuth usage into status for inactive accounts', async () => {
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
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
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
    cleanupAfterTest(async () => {
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

  it('preserves known quota when the parsed OAuth payload omits all usage observations', async () => {
    const resetAt = '2026-09-08T09:00:00Z';
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => Date.parse('2026-09-01T00:00:00Z'),
    });
    accountManager.applyUsage('acct_1', {
      five_hour: { utilization: 0.7, resets_at: resetAt },
      seven_day: { utilization: 0.8, resets_at: resetAt },
      scoped_weekly: [{
        key: 'fable', label: 'Fable', utilization: 0.9, resets_at: resetAt,
      }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      usageFetcher: async () => parseUsageResponse({}),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST', timeoutMs: 500,
    });
    const quota = accountManager.find('acct_1').quota;

    assert.equal(refresh.status, 200);
    assert.equal(quota.unified5h, 0.7);
    assert.equal(quota.unified7d, 0.8);
    assert.deepEqual(quota.weeklyScoped.map(limit => [limit.key, limit.utilization]), [
      ['fable', 0.9],
    ]);
  });

  it('passes upstream connect retry settings to OAuth usage refreshes', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('dev', { accessToken: 'dev-token' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'dev', name: 'dev@example.com', type: 'oauth' }],
      currentAccountId: 'dev',
    });
    let seenOptions = null;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        proxy: {
          upstreamConnectTimeoutMs: 3210,
          upstreamConnectRetries: 7,
          upstreamConnectRetryDelayMs: 123,
        },
        usagePolling: { enabled: false },
      },
      usageFetcher: async (token, options) => {
        assert.equal(token, 'dev-token');
        seenOptions = options;
        return {
          five_hour: { utilization: 0.2, resets_at: null },
          seven_day: { utilization: 0.3, resets_at: null },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(seenOptions.connectTimeoutMs, 3210);
    assert.equal(seenOptions.connectRetries, 7);
    assert.equal(seenOptions.connectRetryDelayMs, 123);
  });

  it('refreshes OAuth usage with live Claude Code credentials for a matching expired saved account', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-saved-token',
      refreshToken: 'saved-refresh-token',
      expiresAt: 900,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    accountManager.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed');
    const seenTokens = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        throw new Error('token refresh should not be called');
      },
      currentCredentialReader: async () => ({
        accessToken: 'live-claude-code-token',
        refreshToken: 'live-claude-code-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
      }),
      currentProfileFetcher: async accessToken => {
        assert.equal(accessToken, 'live-claude-code-token');
        return { accountUuid: 'uuid-live' };
      },
      usageFetcher: async token => {
        seenTokens.push(token);
        return {
          five_hour: { utilization: 0.2, resets_at: null },
          seven_day: { utilization: 0.3, resets_at: null },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.ok, true);
    assert.deepEqual(seenTokens, ['live-claude-code-token']);
    assert.equal(refresh.body.status.accounts[0].status, 'active');
    assert.equal(refresh.body.status.accounts[0].unavailableReason, null);
  });

  it('refreshes stored OAuth usage credentials without live mirroring in gateway mode', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-saved-token',
      refreshToken: 'saved-refresh-token',
      expiresAt: 900,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', accountUuid: 'uuid-live' }],
      now: () => 1000,
    });
    const seenTokens = [];
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      allowLiveClaudeCodeCredentials: false,
      tokenRefresher: async refreshToken => {
        refreshCalls += 1;
        return {
          accessToken: 'fresh-stored-token',
          refreshToken,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      currentCredentialReader: async () => {
        throw new Error('gateway mode must not read the saved /login credential');
      },
      currentProfileFetcher: async () => {
        throw new Error('gateway mode must not profile the saved /login credential');
      },
      usageFetcher: async token => {
        seenTokens.push(token);
        return {
          five_hour: { utilization: 0.2, resets_at: null },
          seven_day: { utilization: 0.3, resets_at: null },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.ok, true);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(seenTokens, ['fresh-stored-token']);
    assert.equal(refresh.body.status.accounts[0].unavailableReason, null);
  });

  it('refreshes OAuth usage accounts concurrently when configured', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    let resolveBothCalled;
    let releaseUsage;
    const bothCalled = new Promise(resolve => {
      resolveBothCalled = resolve;
    });
    const release = new Promise(resolve => {
      releaseUsage = resolve;
    });
    const calls = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        calls.push(token);
        if (calls.length === 2) resolveBothCalled();
        await release;
        return {
          five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:00:00Z' },
          seven_day: { utilization: 0.5, resets_at: '2026-06-10T11:00:00Z' },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refreshPromise = requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const startedConcurrently = await Promise.race([
      bothCalled.then(() => true),
      sleep(100).then(() => false),
    ]);
    releaseUsage();
    const refresh = await refreshPromise;

    assert.equal(startedConcurrently, true, 'usage refresh did not start both account fetches concurrently');
    assert.equal(refresh.status, 200);
    assert.deepEqual(calls.sort(), ['access-token-1', 'access-token-2']);
    assert.equal(refresh.body.accounts.filter(account => account.ok).length, 2);
  });

  it('does not refresh an expired credential when quota exhaustion hides its refresh cooldown', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.markCredentialRefreshDeferred('acct_1', 300, {
      retryAfterSource: 'fixed',
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '60',
    });
    assert.equal(accountManager.unavailableReason(accountManager.accounts[0]).type, 'quota_exhausted');

    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
      },
      tokenRefresher: async () => {
        refreshCalls += 1;
        throw new Error('credential refresh must remain in cooldown');
      },
      usageFetcher: async () => {
        throw new Error('usage fetch must not run with an expired credential');
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.accounts[0].skipped, 'credential-refresh-cooldown');
    assert.equal(refreshCalls, 0);
  });

  it('attempts each expired account when token refreshes are rate limited', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-access-1',
      refreshToken: 'refresh-token-1',
      expiresAt: 1,
    });
    await secretStore.set('acct_2', {
      accessToken: 'expired-access-2',
      refreshToken: 'refresh-token-2',
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    const refreshCalls = [];
    let active = 0;
    let maxActive = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, concurrency: 2, requestSpacingMs: 0 },
      },
      tokenRefresher: async refreshToken => {
        refreshCalls.push(refreshToken);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setImmediate(resolve));
        active -= 1;
        throw new OAuthTokenRefreshError({
          status: 429,
          code: 'rate_limit_error',
          retryAfterMs: 60_000,
          retryAfterSource: 'fallback',
        });
      },
      usageFetcher: async () => {
        throw new Error('usage fetch should not run with expired credentials');
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.ok, false);
    assert.deepEqual(refreshCalls.sort(), ['refresh-token-1', 'refresh-token-2']);
    assert.equal(maxActive, 1);
    assert.equal(refresh.body.accounts.filter(account => account.ok).length, 0);
    assert.deepEqual(
      refresh.body.status.accounts.map(account => account.unavailableReason.type),
      ['oauth_refresh_rate_limit', 'oauth_refresh_rate_limit'],
    );
    assert.deepEqual(
      refresh.body.status.accounts.map(account => account.unavailableReason.retryAfterSource),
      ['fallback', 'fallback'],
    );
    assert.equal(JSON.stringify(refresh.body).includes('refresh-token-'), false);
  });

  it('利用量更新で再ログイン必須の認証を枠待ちではなく認証失敗として表示する', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '60',
    });
    assert.equal(accountManager.getStatus().accounts[0].unavailableReason.type, 'quota_exhausted');
    let usageCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      allowLiveClaudeCodeCredentials: false,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        throw Object.assign(new Error('The stored OAuth refresh credential has expired and must be linked again'), {
          code: 'NATIVE_REFRESH_REAUTH_REQUIRED',
        });
      },
      usageFetcher: async () => { usageCalls += 1; },
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.accounts[0].ok, false);
    assert.equal(usageCalls, 0);
    assert.deepEqual(refresh.body.status.accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: '1970-01-01T00:00:01.000Z',
    });
  });

  it('keeps the displayed diagnostic cause identical to the logged classifier code while humanizing the main reason', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: randomUUID(),
      refreshToken: randomUUID(),
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const logs = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      allowLiveClaudeCodeCredentials: false,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        throw Object.assign(new Error('The stored OAuth refresh credential has expired and must be linked again'), {
          code: 'NATIVE_REFRESH_REAUTH_REQUIRED',
        });
      },
      usageFetcher: async () => assert.fail('usage fetch must not run after the refresh fails'),
      logger: line => logs.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.accounts[0].ok, false);
    const failureLog = logs.find(line => line.includes('usage-refresh account=acct_1 result=failed'));
    const loggedCause = failureLog?.match(/\berrorType=(\S+)/)?.[1];
    assert.equal(loggedCause, 'NATIVE_REFRESH_REAUTH_REQUIRED');

    const output = renderStatus(refresh.body.status, { now: 1000, columns: 200 });
    const reasonLine = output.split('\n').find(line => line.startsWith('reason: '));
    assert.match(reasonLine, /^reason: login expired \(cause=NATIVE_REFRESH_REAUTH_REQUIRED; detected /);
    assert.match(reasonLine, / - run: claude-rotator login --id acct_1$/);
    assert.equal(reasonLine.match(/\(cause=([^;]+)/)?.[1], loggedCause);
    assert.match(output, /routes Fable: needs login \| Other: needs login/);
    assert.doesNotMatch(output, /oauth_refresh_failed|OAuth token refresh failed/);
  });

  for (const { code, message, retryAfterMs, expectedReason } of [
    { code: 'SECRET_STORE_LOCK_TIMEOUT', message: 'Timed out waiting for credential lock', expectedReason: null },
    { code: 'ETIMEDOUT', message: 'Native Claude refresh command timed out', expectedReason: null },
    { code: 'NATIVE_REFRESH_COMMAND_FAILED', message: 'native refresh command failed', retryAfterMs: 60_000, expectedReason: 'oauth_refresh_retry' },
  ]) {
    it(`利用量更新で一時的な ${code} を再ログイン必須と誤分類しない`, async () => {
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', {
        accessToken: randomUUID(),
        refreshToken: randomUUID(),
        expiresAt: 1,
      });
      const accountManager = new AccountManager({
        accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
        now: () => 1000,
      });
      let usageCalls = 0;
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        allowLiveClaudeCodeCredentials: false,
        config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
        tokenRefresher: async () => {
          throw Object.assign(new Error(message), { code, retryAfterMs });
        },
        usageFetcher: async () => { usageCalls += 1; },
      }));
      cleanupAfterTest(async () => close(proxy.server));

      const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

      assert.equal(refresh.status, 200);
      assert.equal(refresh.body.accounts[0].ok, false);
      assert.equal(usageCalls, 0);
      assert.equal(refresh.body.status.accounts[0].unavailableReason?.type ?? null, expectedReason);
    });
  }

  it('persists an unknown native refresh outcome from usage polling', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-access-token',
      refreshToken: 'native-refresh-token',
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async () => {
        throw Object.assign(new Error('native refresh outcome is unknown'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
      usageFetcher: async () => assert.fail('usage fetch must not run after unknown refresh outcome'),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.accounts[0].ok, false);
    assert.deepEqual(accountManager.getStatus().accounts[0].unavailableReason, {
      type: 'oauth_refresh_failed',
      message: 'OAuth token refresh failed',
      cause: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
      at: '1970-01-01T00:00:01.000Z',
    });
  });

  it('parks two consecutive usage refreshes after one ambiguous handoff', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-usage-access-fixture',
      refreshToken: 'usage-refresh-fixture',
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth', credentialRevision: 'rev-1' }],
      now: () => 1000,
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      tokenRefresher: async (_refreshToken, context) => {
        refreshCalls += 1;
        await context.beforeHandoff();
        throw Object.assign(new Error('ambiguous usage handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      },
      usageFetcher: async () => assert.fail('parked usage credential must not be fetched'),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const first = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    const second = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(first.body.accounts[0].ok, false);
    assert.equal(second.body.accounts[0].ok, false);
    assert.equal(refreshCalls, 1);
    assert.equal(second.body.status.accounts[0].unavailableReason.type, 'oauth_refresh_failed');
  });

  it('parks every account sharing a refresh token before native handoff', async () => {
    const secretStore = new MemorySecretStore();
    for (const [accountId, accessToken] of [
      ['acct_1', 'duplicate-access-fixture-1'],
      ['acct_2', 'duplicate-access-fixture-2'],
    ]) {
      await secretStore.set(accountId, {
        accessToken,
        refreshToken: 'duplicate-refresh-fixture',
        expiresAt: 1,
      });
    }
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      tokenRefresher: async () => {
        refreshCalls += 1;
        return assert.fail('duplicate refresh credential must not reach native handoff');
      },
      usageFetcher: async () => assert.fail('duplicate refresh credential must not fetch usage'),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(
      refresh.body.status.accounts.map(account => account.unavailableReason.type),
      ['oauth_refresh_failed', 'oauth_refresh_failed'],
    );
    assert.equal(JSON.stringify(refresh.body).includes('duplicate-refresh-fixture'), false);
  });

  it('rescans for refresh-token duplicates immediately before native handoff', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'late-duplicate-access-1',
      refreshToken: 'late-duplicate-refresh-1',
      expiresAt: 1,
    });
    await secretStore.set('acct_2', {
      accessToken: 'late-duplicate-access-2',
      refreshToken: 'late-duplicate-refresh-2',
      expiresAt: 1,
    });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => 1000,
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      tokenRefresher: async (refreshToken, context) => {
        await context.beforeHandoff();
        refreshCalls += 1;
        return {
          accessToken: 'must-not-be-committed',
          refreshToken,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      usageFetcher: async () => assert.fail('duplicate refresh credential must not fetch usage'),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    await requestJson(`${proxy.url}/internal/status`);
    await secretStore.replaceLinkedCredential('acct_2', {
      accessToken: 'late-duplicate-access-2-updated',
      refreshToken: 'late-duplicate-refresh-1',
      expiresAt: 1,
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refreshCalls, 0);
    assert.deepEqual(
      refresh.body.status.accounts.map(account => account.unavailableReason.type),
      ['oauth_refresh_failed', 'oauth_refresh_failed'],
    );
  });

  it('includes a newly-published account in the pre-handoff duplicate scan before reload', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'publish-window-access-1',
      refreshToken: 'publish-window-refresh',
      expiresAt: 1,
    });
    let configuredAccounts = [
      { id: 'acct_1', name: 'one@example.com', type: 'oauth' },
    ];
    const accountManager = new AccountManager({
      accounts: configuredAccounts,
      now: () => 1000,
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      credentialAccountsReader: async () => configuredAccounts,
      reloadAccounts: async () => configuredAccounts,
      tokenRefresher: async (_refreshToken, context) => {
        await context.beforeHandoff();
        refreshCalls += 1;
        return assert.fail('newly-published duplicate must not reach native handoff');
      },
      usageFetcher: async () => assert.fail('duplicate refresh credential must not fetch usage'),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    await requestJson(`${proxy.url}/internal/status`);

    let signalPublish;
    let releasePublish;
    const publishStarted = new Promise(resolve => { signalPublish = resolve; });
    const publishGate = new Promise(resolve => { releasePublish = resolve; });
    const publish = secretStore.replaceLinkedCredentialAndRun(
      'acct_2',
      {
        accessToken: 'publish-window-access-2',
        refreshToken: 'publish-window-refresh',
        expiresAt: 1,
      },
      async () => {
        configuredAccounts = [
          ...configuredAccounts,
          { id: 'acct_2', name: 'two@example.com', type: 'oauth' },
        ];
        signalPublish();
        await publishGate;
      },
    );
    await publishStarted;
    let refreshSettled = false;
    const refreshPending = requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST',
    }).then(result => {
      refreshSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(refreshSettled, false);

    releasePublish();
    await publish;
    const refresh = await refreshPending;
    const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refreshCalls, 0);
    assert.equal(reload.status, 200);
    assert.deepEqual(
      reload.body.accounts.map(account => account.unavailableReason.type),
      ['oauth_refresh_failed', 'oauth_refresh_failed'],
    );
  });

  it('unparks duplicate refresh-token accounts after a credential-changing reload resolves the duplicate', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'reload-duplicate-access-1',
      refreshToken: 'reload-duplicate-refresh',
      expiresAt: 1,
    });
    await secretStore.set('acct_2', {
      accessToken: 'reload-duplicate-access-2',
      refreshToken: 'reload-duplicate-refresh',
      expiresAt: 1,
    });
    const accounts = [
      { id: 'acct_1', name: 'a@example.com', type: 'oauth', credentialRevision: 'rev-1' },
      { id: 'acct_2', name: 'b@example.com', type: 'oauth', credentialRevision: 'rev-1' },
    ];
    let reloadedAccounts = accounts;
    let refreshCalls = 0;
    const accountManager = new AccountManager({ accounts, now: () => 1000 });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      reloadAccounts: async () => reloadedAccounts,
      tokenRefresher: async refreshToken => {
        refreshCalls += 1;
        return {
          accessToken: `refreshed-access-${refreshCalls}`,
          refreshToken,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      usageFetcher: async () => ({
        five_hour: { utilization: 0.1, resets_at: futureReset() },
        seven_day: { utilization: 0.2, resets_at: futureReset() },
      }),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const parked = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    assert.equal(refreshCalls, 0);
    assert.deepEqual(
      parked.body.status.accounts.map(account => account.unavailableReason.type),
      ['oauth_refresh_failed', 'oauth_refresh_failed'],
    );

    await secretStore.set('acct_2', {
      accessToken: 'reload-distinct-access-2',
      refreshToken: 'reload-distinct-refresh-2',
      expiresAt: 1,
    });
    reloadedAccounts = accounts.map(account => ({
      ...account,
      credentialRevision: account.id === 'acct_2' ? 'rev-2' : account.credentialRevision,
    }));
    const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    const refreshed = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(reload.status, 200);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshCalls, 2);
    assert.deepEqual(refreshed.body.status.accounts.map(account => account.unavailableReason), [null, null]);
    assert.equal(JSON.stringify([reload.body, refreshed.body]).includes('reload-duplicate-refresh'), false);
  });

  it('keeps a persisted marker authoritative during startup and revision-only reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-startup-marker-'));
    const accountsDir = join(dir, 'accounts');
    const originalStore = new LinuxFileSecretStore({ accountsDir });
    const original = {
      accessToken: 'startup-access-fixture',
      refreshToken: 'startup-refresh-fixture',
      expiresAt: 1,
    };
    await originalStore.set('acct_1', original);
    await assert.rejects(
      () => originalStore.refreshIfUnchanged('acct_1', original, async (_current, transaction) => {
        await transaction.beforeHandoff();
        throw Object.assign(new Error('startup marker fixture'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    const secretStore = new LinuxFileSecretStore({ accountsDir });
    const getOperational = secretStore.getOperational.bind(secretStore);
    let operationalReads = 0;
    secretStore.getOperational = async accountId => {
      operationalReads += 1;
      return getOperational(accountId);
    };
    const accounts = [{
      id: 'acct_1',
      name: 'a@example.com',
      type: 'oauth',
      credentialRevision: 'rev-1',
    }];
    const accountManager = new AccountManager({ accounts, now: () => 1000 });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: true },
      },
      reloadAccounts: async () => accounts.map(account => ({
        ...account,
        credentialRevision: 'rev-2-without-credential-change',
      })),
      tokenRefresher: async () => {
        refreshCalls += 1;
        return assert.fail('startup/reload must not invoke a parked refresh token');
      },
      usageFetcher: async () => assert.fail('startup/reload must not fetch usage while parked'),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await rm(dir, { recursive: true, force: true });
    });

    const startup = await requestJson(`${proxy.url}/internal/status`);
    const startupOperationalReads = operationalReads;
    const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });

    assert.equal(refreshCalls, 0);
    assert.equal(startupOperationalReads, 2);
    assert.equal(operationalReads, 4);
    assert.equal(startup.body.accounts[0].unavailableReason.type, 'oauth_refresh_failed');
    assert.equal(reload.body.accounts[0].unavailableReason.type, 'oauth_refresh_failed');
    assert.equal(JSON.stringify([startup.body, reload.body]).includes('startup-refresh-fixture'), false);
  });

  it('responds to /internal/health immediately even while startup reconciliation is stuck on an account lock', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    let releaseReconcile;
    const reconcileGate = new Promise(resolve => { releaseReconcile = resolve; });
    const originalGetOperational = secretStore.getOperational.bind(secretStore);
    secretStore.getOperational = async accountId => {
      await reconcileGate;
      return originalGetOperational(accountId);
    };
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => {
      releaseReconcile();
      await close(proxy.server);
    });

    // Startup reconciliation (operationalStateCheck) is stuck reading
    // acct_1's operational secret (as it would be if the account lock were
    // held by a concurrent refresh). /internal/health must not wait for it
    // -- install/reinstall's bounded health poll would otherwise time out
    // and roll back a routine install whenever a refresh happens to be in
    // flight, even though the server itself is up and serving.
    const health = await requestJson(`${proxy.url}/internal/health`, { timeoutMs: 1_000 });

    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
  });

  it('does not stall /internal/status or proxied requests behind a reload stuck reconciling a held account lock', async () => {
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    // acct_1 simulates the account whose lock a concurrent refresh holds;
    // acct_2 is the account actually serving traffic, so a proxied request
    // only reflects the shared reconcile gate, not acct_1's own stuck lock.
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_2', type: 'oauth' },
        { id: 'acct_1', type: 'oauth' },
      ],
      currentAccountId: 'acct_2',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      reloadAccounts: async () => accountManager.accounts,
    }));
    let releaseReconcile;
    const reconcileGate = new Promise(resolve => { releaseReconcile = resolve; });
    cleanupAfterTest(async () => {
      releaseReconcile();
      await close(proxy.server);
      await close(upstream.server);
    });

    // Let the real startup reconciliation (unrelated to this test) settle
    // first, then make only acct_1's operational read hang -- as it would
    // while its account lock is held by a concurrent refresh -- for the
    // reload triggered below.
    await requestJson(`${proxy.url}/internal/status`, { timeoutMs: 1_000 });
    const originalGetOperational = secretStore.getOperational.bind(secretStore);
    secretStore.getOperational = async accountId => {
      if (accountId === 'acct_1') await reconcileGate;
      return originalGetOperational(accountId);
    };

    const reload = await requestJson(`${proxy.url}/internal/reload`, {
      method: 'POST', timeoutMs: 1_000,
    });
    // The reload response itself must not wait for the (now-stuck)
    // reconciliation it kicks off in the background.
    assert.equal(reload.status, 200);

    // Neither /internal/status nor a proxied request (through the
    // unaffected acct_2) may be stuck behind reload's still-pending
    // background reconcile of acct_1: only /internal/reload itself may ever
    // replace the shared operationalStateCheck gate, and it must not do so
    // anymore.
    const [status, forwarded] = await Promise.all([
      requestJson(`${proxy.url}/internal/status`, { timeoutMs: 1_000 }),
      requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model: 'sonnet' }), timeoutMs: 1_000,
      }),
    ]);

    assert.equal(status.status, 200);
    assert.equal(forwarded.status, 200);
    assert.deepEqual(forwarded.body, { ok: true });
  });

  it('refreshes OAuth usage accounts serially by default', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(token);
        await sleep(5);
        active--;
        return {
          five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:00:00Z' },
          seven_day: { utilization: 0.5, resets_at: '2026-06-10T11:00:00Z' },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(maxActive, 1);
    assert.deepEqual(calls, ['access-token-1', 'access-token-2']);
    assert.equal(refresh.body.accounts.filter(account => account.ok).length, 2);
  });

  it('spaces OAuth usage refresh requests by default', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    const startedAt = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async () => {
        startedAt.push(Date.now());
        return {
          five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:00:00Z' },
          seven_day: { utilization: 0.5, resets_at: '2026-06-10T11:00:00Z' },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(startedAt.length, 2);
    assert.ok(startedAt[1] - startedAt[0] >= 1400);
  });

  it('limits OAuth usage refresh concurrency from config', async () => {
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
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    let active = 0;
    let maxActive = 0;
    const calls = [];
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false, concurrency: 1, requestSpacingMs: 0 },
      },
      usageFetcher: async token => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(token);
        await sleep(5);
        active--;
        return {
          five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:00:00Z' },
          seven_day: { utilization: 0.5, resets_at: '2026-06-10T11:00:00Z' },
        };
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(maxActive, 1);
    assert.deepEqual(calls, ['access-token-1', 'access-token-2', 'access-token-3']);
    assert.equal(refresh.body.accounts.filter(account => account.ok).length, 3);
  });

  it('persists account state after usage refresh', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const persisted = [];
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async () => ({
        five_hour: { utilization: 0.25, resets_at: '2026-06-07T13:00:00Z' },
        seven_day: { utilization: 0.5, resets_at: '2026-06-10T11:00:00Z' },
      }),
      stateWriter: async state => {
        persisted.push(state);
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].accounts[0].quota.unified5h, 0.25);
    assert.equal(persisted[0].accounts[0].quota.unified7d, 0.5);
  });

  it('surfaces usage refresh network causes without leaking tokens', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => Date.parse('2026-06-07T11:00:00Z'),
    });
    const fetchError = new TypeError('fetch failed');
    fetchError.cause = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
      syscall: 'connect',
      address: '160.79.104.10',
      port: 443,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      usageFetcher: async () => {
        throw fetchError;
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.ok, false);
    assert.match(refresh.body.accounts[0].error, /fetch failed/);
    assert.match(refresh.body.accounts[0].error, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(refresh.body.accounts[0].error, /160\.79\.104\.10:443/);
    assert.equal(JSON.stringify(refresh.body).includes('access-token-1'), false);
  });

  it('waits for the initial OAuth usage refresh before returning status', async () => {
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
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/status`);

    assert.equal(response.status, 200);
    assert.equal(response.body.accounts[0].quota.unified5h, 0.25);
    assert.equal(response.body.accounts[0].quota.unified7d, 0.5);
    assert.equal(response.body.accounts[0].status, 'active');
  });

  it('retries a rate-limited token refresh after the server cooldown', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', {
      accessToken: 'expired-token',
      refreshToken: 'refresh-token-1',
      expiresAt: 900,
    });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => Date.now(),
    });
    accountManager.applyUsage('acct_1', {
      seven_day: {
        utilization: 1,
        resets_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
    let refreshCalls = 0;
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: {
          enabled: true,
          intervalMs: 10_000,
          requestSpacingMs: 0,
          resetCheckDelayMs: 5,
        },
      },
      tokenRefresher: async () => {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          throw new OAuthTokenRefreshError({
            status: 429,
            code: 'rate_limit_error',
            retryAfterMs: 500,
          });
        }
        return {
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      },
      usageFetcher: async () => ({
        five_hour: { utilization: 0.2, resets_at: null },
        seven_day: { utilization: 0.3, resets_at: null },
      }),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const first = await requestJson(`${proxy.url}/internal/status`);
    assert.equal(first.body.accounts[0].status, 'exhausted');
    assert.notEqual(first.body.accounts[0].rateLimitedUntil, null);

    await waitForStatus(() => refreshCalls, calls => calls >= 2, 3000);
    const recovered = await requestJson(`${proxy.url}/internal/status`);
    assert.equal(refreshCalls, 2);
    assert.equal(recovered.body.accounts[0].status, 'active');
    assert.equal(recovered.body.accounts[0].unavailableReason, null);
    assert.equal((await secretStore.get('acct_1')).refreshToken, 'refresh-token-2');
  });

  it('refreshes exhausted usage again at the reported reset time', async () => {
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
        usagePolling: { enabled: true, resetCheckDelayMs: 5, requestSpacingMs: 0 },
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
    cleanupAfterTest(async () => {
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

  it('periodically refreshes usage and switches before the next API request', async () => {
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
        usagePolling: { enabled: true, intervalMs: 5, requestSpacingMs: 0 },
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
    cleanupAfterTest(async () => {
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

  it('periodically refreshes usage and proactively switches to an account with a soon weekly reset', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('active-account', { accessToken: 'access-token-current' });
    await secretStore.set('soon-weekly', { accessToken: 'access-token-soon' });
    const accountManager = new AccountManager({
      accounts: [
        { id: 'active-account', name: 'current@example.com', type: 'oauth' },
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
        usagePolling: { enabled: true, intervalMs: 5, requestSpacingMs: 0 },
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
    cleanupAfterTest(async () => {
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
      serviceGeneration: 'generation-1',
    }));

    const health = await requestJson(`${proxy.url}/internal/health`);
    const status = await requestJson(`${proxy.url}/internal/status`);

    assert.equal(health.body.ok, true);
    assert.equal(health.body.serviceGeneration, 'generation-1');
    assert.equal(status.body.currentAccount, 'acct_1');
    assert.equal(JSON.stringify(status.body).includes('access-token-1'), false);

    await close(proxy.server);
  });

  for (const scenario of [
    { name: 'manual to gateway', initialAllowLive: true, nextAllowLive: false },
    { name: 'gateway to manual', initialAllowLive: false, nextAllowLive: true },
  ]) {
    it(`requires a restart when credential ownership changes from ${scenario.name}`, async () => {
      let upstreamCalls = 0;
      const upstream = await listen(http.createServer((_req, res) => {
        upstreamCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }));
      const secretStore = new MemorySecretStore();
      await secretStore.set('acct_1', { accessToken: 'ownership-access-fixture' });
      const accounts = [{
        id: 'acct_1',
        name: 'a@example.com',
        type: 'oauth',
        credentialRevision: 'ownership-rev-1',
      }];
      const accountManager = new AccountManager({ accounts });
      let currentCredentialReads = 0;
      let usageCalls = 0;
      const proxy = await listen(createProxyServer({
        accountManager,
        secretStore,
        config: { upstream: upstream.url, usagePolling: { enabled: false } },
        allowLiveClaudeCodeCredentials: scenario.initialAllowLive,
        reloadAccounts: async () => ({
          accounts: accounts.map(account => ({ ...account, name: 'must-not-apply@example.com' })),
          allowLiveClaudeCodeCredentials: scenario.nextAllowLive,
        }),
        currentCredentialReader: async () => {
          currentCredentialReads += 1;
          return { accessToken: 'must-not-be-read' };
        },
        usageFetcher: async () => {
          usageCalls += 1;
          return {};
        },
      }));
      cleanupAfterTest(async () => {
        await close(proxy.server);
        await close(upstream.server);
      });

      const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
      const health = await requestJson(`${proxy.url}/internal/health`);
      const status = await requestJson(`${proxy.url}/internal/status`);
      const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
      const forwarded = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-sonnet-5' }),
      });

      assert.equal(reload.status, 409);
      assert.equal(reload.body.error.type, 'restart_required');
      assert.equal(health.status, 200);
      assert.equal(status.status, 200);
      assert.equal(status.body.accounts[0].name, 'a@example.com');
      assert.equal(refresh.status, 503);
      assert.equal(forwarded.status, 503);
      assert.equal(currentCredentialReads, 0);
      assert.equal(usageCalls, 0);
      assert.equal(upstreamCalls, 0);
    });
  }

  it('keeps the previous accounts when same-mode reload validation fails', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'reload-validation-access' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'before@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
      allowLiveClaudeCodeCredentials: false,
      reloadAccounts: async () => ({
        accounts: [{ id: 'acct_1', name: 'must-not-apply@example.com', type: 'oauth' }],
        allowLiveClaudeCodeCredentials: false,
        validationError: new Error('candidate gateway configuration is invalid'),
      }),
    }));
    cleanupAfterTest(async () => close(proxy.server));

    const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    const status = await requestJson(`${proxy.url}/internal/status`);

    assert.equal(reload.status, 502);
    assert.equal(status.status, 200);
    assert.equal(status.body.accounts[0].name, 'before@example.com');
  });

  it('returns a non-empty proxy error message for empty internal errors', async () => {
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore: {
        async get() {
          throw new Error('');
        },
      },
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false } },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 502);
    assert.equal(response.body.error.type, 'proxy_error');
    assert.notEqual(response.body.error.message, '');
  });

  it('waits for new-token Usage after same-id reload supersedes an in-flight old-account refresh', async () => {
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'old-token' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'old account', type: 'oauth' }],
    });
    const oldAccount = accountManager.find('acct_1');
    const usageTokens = [];
    let oldUsageCalls = 0;
    let releaseOldUsage;
    const oldUsageGate = new Promise(resolve => { releaseOldUsage = resolve; });
    let newUsageCalls = 0;
    let releaseNewUsage;
    const newUsageGate = new Promise(resolve => { releaseNewUsage = resolve; });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: {
          enabled: true,
          intervalMs: 0,
          concurrency: 1,
          requestSpacingMs: 0,
        },
      },
      usageFetcher: async token => {
        usageTokens.push(token);
        if (token === 'old-token') {
          oldUsageCalls += 1;
          await oldUsageGate;
          return { five_hour: { utilization: 0.8, resets_at: futureReset() } };
        }
        newUsageCalls += 1;
        await newUsageGate;
        return { five_hour: { utilization: 0.2, resets_at: futureReset() } };
      },
      reloadAccounts: async () => {
        await secretStore.set('acct_1', { accessToken: 'new-token' });
        return [{ id: 'acct_1', name: 'new account', type: 'oauth' }];
      },
    }));
    cleanupAfterTest(async () => {
      releaseOldUsage?.();
      releaseNewUsage?.();
      await close(proxy.server);
    });

    const oldStarted = await waitForStatus(() => oldUsageCalls, count => count === 1, 250);
    assert.equal(oldStarted, 1);
    let reloadSettled = false;
    const reloadPending = requestJson(`${proxy.url}/internal/reload`, {
      method: 'POST', timeoutMs: 1_000,
    }).then(response => {
      reloadSettled = true;
      return response;
    });
    const newObjectInstalled = await waitForStatus(
      () => accountManager.find('acct_1') !== oldAccount,
      Boolean,
      250,
    );
    assert.equal(newObjectInstalled, true);
    releaseOldUsage();
    const newStarted = await waitForStatus(() => newUsageCalls, count => count === 1, 250);
    const reloadWaitedForNewUsage = !reloadSettled;
    releaseNewUsage();
    const reloadResponse = await reloadPending;

    assert.deepEqual({
      reloadStatus: reloadResponse.status,
      newStarted,
      reloadWaitedForNewUsage,
      oldUsageCalls,
      newUsageCalls,
      usageTokens,
      currentName: reloadResponse.body.accounts[0].name,
      finalUtilization: accountManager.find('acct_1').quota.unified5h,
    }, {
      reloadStatus: 200,
      newStarted: 1,
      reloadWaitedForNewUsage: true,
      oldUsageCalls: 1,
      newUsageCalls: 1,
      usageTokens: ['old-token', 'new-token'],
      currentName: 'new account',
      finalUtilization: 0.2,
    });
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

// ---------------------------------------------------------------------------
// R3-2 の配線: degradeMapping の config-notice を起動時と /internal/reload 時に出す
// （設計書 §7.2・§7.3-4）。通知文言そのものの検査は test/openai-bridge.test.js 側にあり、
// ここでは「本番の呼び出し元が実在すること」と「既定構成では1行も出ないこと」だけを固定する。
// ---------------------------------------------------------------------------
describe('openai-bridge degradeMapping config-notice の配線', () => {
  const CONFIG_NOTICE = 'openai-bridge config-notice';

  function startProxy({ config, logLines, reloadOpenAiBridge = null }) {
    return listen(createProxyServer({
      accountManager: new AccountManager({
        accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
        now: () => 1000,
      }),
      secretStore: new MemorySecretStore(),
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false }, ...config },
      reloadOpenAiBridge,
      logger: line => logLines.push(line),
    }));
  }

  it('emits the notice once at startup when degradeMapping is enabled without openaiBridge', async () => {
    const logLines = [];
    const proxy = await startProxy({
      logLines,
      config: { openaiBridge: { enabled: false, degradeMapping: { enabled: true } } },
    });
    cleanupAfterTest(async () => close(proxy.server));

    const notices = logLines.filter(line => line.includes(CONFIG_NOTICE));
    assert.equal(notices.length, 1, '起動時に1行だけ出る');
    assert.match(notices[0], /degradeMapping enabled without openaiBridge/);
  });

  it('emits the notice at startup when a non-loopback codexStatusUrl is dropped', async () => {
    const logLines = [];
    const proxy = await startProxy({
      logLines,
      config: {
        openaiBridge: {
          enabled: true,
          url: 'http://127.0.0.1:18765',
          degradeMapping: { enabled: true, codexStatusUrl: 'http://evil.example.com/healthz' },
        },
      },
    });
    cleanupAfterTest(async () => close(proxy.server));

    const notices = logLines.filter(line => line.includes(CONFIG_NOTICE));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /degradeMapping\.codexStatusUrl must be loopback/);
    assert.equal(notices[0].includes('evil.example.com'), false, '設定値そのものは転記しない');
  });

  it('stays silent for configurations that do not use degradeMapping', async () => {
    // 既存挙動への影響ゼロ: degradeMapping を書いていない構成では起動でも reload でも
    // config-notice を1行も出さない。
    for (const openaiBridge of [
      undefined,
      { enabled: false },
      { enabled: true, url: 'http://127.0.0.1:18765' },
      // fail-safe 経路（modelPattern のコンパイル失敗）では degradeMapping ごと無効になる。
      { enabled: true, url: 'http://127.0.0.1:18765', modelPattern: '([unclosed', degradeMapping: { enabled: true } },
    ]) {
      const logLines = [];
      const proxy = await startProxy({
        logLines,
        config: openaiBridge === undefined ? {} : { openaiBridge },
        reloadOpenAiBridge: async () => openaiBridge,
      });
      cleanupAfterTest(async () => close(proxy.server));
      const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });

      assert.equal(reload.status, 200);
      assert.deepEqual(
        logLines.filter(line => line.includes(CONFIG_NOTICE)),
        [],
        JSON.stringify(openaiBridge) ?? 'openaiBridge 未指定',
      );
    }
  });

  it('re-emits the notice after POST /internal/reload turns degradeMapping on', async () => {
    const logLines = [];
    let nextOpenaiBridge = { enabled: false };
    const proxy = await startProxy({
      logLines,
      config: { openaiBridge: nextOpenaiBridge },
      reloadOpenAiBridge: async () => nextOpenaiBridge,
    });
    cleanupAfterTest(async () => close(proxy.server));
    assert.deepEqual(logLines.filter(line => line.includes(CONFIG_NOTICE)), [], '起動時は無効なので出ない');

    nextOpenaiBridge = { enabled: false, degradeMapping: { enabled: true } };
    const reload = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    assert.equal(reload.status, 200);
    assert.equal(logLines.filter(line => line.includes(CONFIG_NOTICE)).length, 1, 'reload で1行出る');

    // 可逆性: reload で戻せば以後は出ない（新たな行が増えない）。
    nextOpenaiBridge = { enabled: false, degradeMapping: { enabled: false } };
    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    assert.equal(logLines.filter(line => line.includes(CONFIG_NOTICE)).length, 1, '無効へ戻したら増えない');
  });
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref?.();
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

function futureReset() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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
      path: options.path || `${target.pathname}${target.search}`,
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
      res.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('response aborted before end'));
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

// ---------------------------------------------------------------------------
// R3-4 の配線: GPT プール状態の生成・受け渡しと、/internal/reload での破棄
// （設計書 §11.1 R3-4）。
//
// 状態機械そのものの検査は test/degrade-state.test.js と test/openai-bridge.test.js に
// あり、ここでは「本番の生成元・受け渡し・reload での破棄が実在すること」だけを固定する。
// 既存ケースは1件も削除・書換しない（§14.4）。以下はすべて新規追加である。
// ---------------------------------------------------------------------------
describe('openai-bridge の GPT プール状態の配線 (R3-4)', () => {
  // 契約ヘッダ付きの 529（＝(pool) を unusable にする）と、契約ヘッダ無しの 200
  // （＝学習しないので、そのとき保持している状態がログにそのまま出る）を切り替える偽 bridge。
  async function startContractBridge() {
    let withContract = true;
    const bridge = await listen(http.createServer((req, res) => {
      req.resume();
      if (withContract) {
        res.writeHead(529, {
          'Content-Type': 'application/json',
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'codex_pool_exhausted',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-pool-state': 'exhausted',
        });
        res.end('{"type":"error"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }));
    return { ...bridge, stopSendingContract: () => { withContract = false; } };
  }

  function startBridgeProxy({ openaiBridge, logLines, reloadOpenAiBridge = null }) {
    return listen(createProxyServer({
      accountManager: new AccountManager({
        accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
        now: () => 1000,
      }),
      secretStore: new MemorySecretStore(),
      config: { upstream: 'http://127.0.0.1:1', usagePolling: { enabled: false }, openaiBridge },
      reloadOpenAiBridge,
      logger: line => logLines.push(line),
    }));
  }

  async function askAstra(proxy) {
    return requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra' }),
      headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`, 'content-type': 'application/json' },
    });
  }

  function lastBridgeLine(logLines) {
    return logLines.filter(line => / openai-bridge model=/.test(line)).at(-1);
  }

  it('discards the learned pool state on POST /internal/reload so it returns to unknown', async () => {
    const bridge = await startContractBridge();
    cleanupAfterTest(async () => close(bridge.server));
    const logLines = [];
    const openaiBridge = {
      enabled: true,
      url: bridge.url,
      modelPattern: '^gpt-',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
      degradeMapping: { enabled: true },
    };
    const proxy = await startBridgeProxy({ openaiBridge, logLines, reloadOpenAiBridge: async () => openaiBridge });
    cleanupAfterTest(async () => close(proxy.server));

    const learned = await askAstra(proxy);
    assert.equal(learned.status, 529, '応答は素通し（書換は R4-1 の範囲）');
    assert.match(lastBridgeLine(logLines), /gptPoolState=unusable/, '契約ヘッダから (pool)=unusable を学習する');

    // 以後の応答は契約ヘッダを持たない＝学習しないので、ログの値は保持状態を映す。
    bridge.stopSendingContract();
    assert.equal((await askAstra(proxy)).status, 200);
    assert.match(lastBridgeLine(logLines), /gptPoolState=unusable/, 'reload するまでは保持される');

    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    assert.equal((await askAstra(proxy)).status, 200);
    assert.match(
      lastBridgeLine(logLines),
      /gptPoolState=unknown gptModelState=unknown/,
      'reload で学習前（unknown＝利用可能扱い）へ戻る',
    );
  });

  it('creates no pool state at all while degradeMapping is disabled (§14.4)', async () => {
    const bridge = await startContractBridge();
    cleanupAfterTest(async () => close(bridge.server));
    const logLines = [];
    const openaiBridge = {
      enabled: true,
      url: bridge.url,
      modelPattern: '^gpt-',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
    };
    const proxy = await startBridgeProxy({ openaiBridge, logLines, reloadOpenAiBridge: async () => openaiBridge });
    cleanupAfterTest(async () => close(proxy.server));

    assert.equal((await askAstra(proxy)).status, 529);
    assert.match(
      lastBridgeLine(logLines),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=529 durationMs=\d+ outcome=forwarded$/,
      '既定構成のログ行は現行と文字列一致する（gptPoolState も出ない）',
    );

    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    assert.equal((await askAstra(proxy)).status, 529);
    assert.equal(
      logLines.filter(line => line.includes('gptPoolState=')).length,
      0,
      'reload を挟んでも生成されない',
    );
  });

  it('keeps the pool state per process while degradeMapping stays enabled across a reload that turns it off', async () => {
    // 有効→無効の reload では破棄だけを行う（以後は観測もログ追記もしない）。
    const bridge = await startContractBridge();
    cleanupAfterTest(async () => close(bridge.server));
    const logLines = [];
    let nextOpenaiBridge = {
      enabled: true,
      url: bridge.url,
      modelPattern: '^gpt-',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
      degradeMapping: { enabled: true },
    };
    const proxy = await startBridgeProxy({
      openaiBridge: nextOpenaiBridge,
      logLines,
      reloadOpenAiBridge: async () => nextOpenaiBridge,
    });
    cleanupAfterTest(async () => close(proxy.server));

    assert.equal((await askAstra(proxy)).status, 529);
    assert.match(lastBridgeLine(logLines), /gptPoolState=unusable/);

    nextOpenaiBridge = { ...nextOpenaiBridge, degradeMapping: { enabled: false } };
    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    bridge.stopSendingContract();
    assert.equal((await askAstra(proxy)).status, 200);
    assert.match(
      lastBridgeLine(logLines),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=200 durationMs=\d+ outcome=forwarded$/,
      '無効化後は追記フィールドが1つも出ない',
    );
  });
});

// ---------------------------------------------------------------------------
// R4-1 の配線: Claude 側台帳の判定を gpt-* 経路へ「関数」で渡す
// （設計書 §11.1 R4-1 の補足・§4.2）。
//
// 書換の判定そのものは test/degrade-state.test.js と test/openai-bridge.test.js が
// 網羅している。ここでは「本番の呼び出しが台帳を実際に見ていること」と
// 「見る時点が応答受領時であること（要求ごとに評価し直すこと）」だけを固定する。
// 既存ケースは1件も削除・書換しない（§14.4）。以下はすべて新規追加である。
// ---------------------------------------------------------------------------
describe('openai-bridge へ渡す Claude 側台帳の判定 (R4-1 / 設計書 §4.2)', () => {
  // 全口座枯渇（scope=pool の 529）を常に返す偽 bridge。
  async function startExhaustedBridge() {
    return listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(529, {
        'Content-Type': 'application/json',
        'content-length': Buffer.byteLength('{"type":"error","error":{"type":"overloaded_error"}}'),
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-upstream-status': '429',
        'x-ombr-reset-at': '2099-01-01T00:00:00Z',
      });
      res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    }));
  }

  async function startProxyFor({ accounts, logLines, degradeMapping = { enabled: true } }) {
    const bridge = await startExhaustedBridge();
    cleanupAfterTest(async () => close(bridge.server));
    const accountManager = new AccountManager({ accounts, now: () => 1000 });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore: new MemorySecretStore(),
      config: {
        upstream: 'http://127.0.0.1:1',
        usagePolling: { enabled: false },
        openaiBridge: {
          enabled: true,
          url: bridge.url,
          modelPattern: '^gpt-',
          connectTimeoutMs: 1000,
          idleTimeoutMs: 1000,
          connectRetries: 0,
          ...(degradeMapping ? { degradeMapping } : {}),
        },
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    const askAstra = () => requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra' }),
      headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`, 'content-type': 'application/json' },
    });
    return { accountManager, askAstra, lastBridgeLine: () => logLines.filter(l => / openai-bridge model=/.test(l)).at(-1) };
  }

  it('re-evaluates the ledger per response: 529 while an account is usable, 403 once every account is not', async () => {
    const logLines = [];
    const { accountManager, askAstra, lastBridgeLine } = await startProxyFor({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      logLines,
    });

    const usable = await askAstra();
    assert.equal(usable.status, 529, 'Claude が使えるうちは Opus へ退避させる（素通し）');
    assert.match(lastBridgeLine(), /claudePoolState=available/);

    // 同じプロセス・同じ設定のまま台帳だけを全枯渇にする。
    accountManager.markRateLimited('acct_1', 60);

    const exhausted = await askAstra();
    assert.equal(exhausted.status, 403, '両プール利用不可なので明示停止する');
    assert.equal(exhausted.body.error.type, 'permission_error');
    assert.match(
      exhausted.body.error.message,
      /All Claude accounts and the Codex pool are unavailable\. Earliest recovery: 1970-01-01T00:01:01\.000Z\./,
      '最早回復時刻は GPT 側（2099年）と Claude 側（now+60s）の早いほう＝Claude 側を出す',
    );
    assert.match(lastBridgeLine(), /outcome=forwarded-mapped /);
    assert.match(lastBridgeLine(), /claudePoolState=all-exhausted mappedFrom=529 .*mappedTo=403 mapReason=both_pools_unusable/);
    assert.match(lastBridgeLine(), / status=403 .*upstreamStatus=429/, '実際の上流ステータスを同じ行に残す（受入条件7）');
  });

  it('never rewrites while no account is registered at all (インストール直後の保険)', async () => {
    const logLines = [];
    const { askAstra, lastBridgeLine } = await startProxyFor({ accounts: [], logLines });

    assert.equal((await askAstra()).status, 529, '口座0件は「全枯渇」とみなさない（設計書 §4.2）');
    assert.match(lastBridgeLine(), /claudePoolState=available/);
  });

  it('passes no ledger probe at all while degradeMapping is disabled (§14.4)', async () => {
    const logLines = [];
    const { accountManager, askAstra, lastBridgeLine } = await startProxyFor({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      logLines,
      degradeMapping: null,
    });
    accountManager.markRateLimited('acct_1', 60);

    assert.equal((await askAstra()).status, 529, '既定の構成では書換が起きない');
    assert.match(
      lastBridgeLine(),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=529 durationMs=\d+ outcome=forwarded$/,
      'ログ行も現行と文字列一致する（claudePoolState も出ない）',
    );
  });

  it('treats a Fable-only sub-cap exhaustion as "Claude is still usable" (共通枠で問う)', async () => {
    // gpt-* 経路は最初から modelFamily を持たない（null＝共通枠）で台帳へ問う。
    // Fable 週次サブキャップだけが切れていても Opus へ退避できるので 403 にしない。
    const logLines = [];
    const { accountManager, askAstra, lastBridgeLine } = await startProxyFor({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      logLines,
    });
    accountManager.applyUsage('acct_1', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    assert.equal(accountManager.isAvailable(accountManager.find('acct_1'), 'fable'), false, '前提: Fable では使えない');
    assert.equal(accountManager.isAvailable(accountManager.find('acct_1'), null), true, '前提: 共通枠では使える');

    assert.equal((await askAstra()).status, 529, 'Fable サブキャップだけでは 403 にしない');
    assert.match(lastBridgeLine(), /claudePoolState=available/);
  });
});

// ---------------------------------------------------------------------------
// R4-2 / R4-3 / R4-4 / R4-6 の配線: Claude 全枯渇の 429 を 529（両プールとも利用
// 不可なら 403）へ写像する単一判定関数 mapClaudeExhaustion を、429 を書き出す
// 7系統すべて（設計書 §4.2 の P-a〜P-g）へ結線したこと。
//
// 判定そのものの検査は test/degrade-state.test.js にあり、ここでは「本番の各終端
// 経路が実際にその1関数を通ること」を実 TCP で固定する（設計書 §11.3 受入条件
// 4-a〜4-g・5-a〜5-c）。既存ケースは1件も削除・書換していない（§14.4）。
// ---------------------------------------------------------------------------
describe('Claude 全枯渇 429 の 529 写像を7系統へ結線する (R4-2/R4-3/R4-4/R4-6 / 設計書 §4.2)', () => {
  const ENABLED = { enabled: true };

  async function startProxy({
    accountManager,
    secretStore = new MemorySecretStore(),
    upstreamUrl = 'http://127.0.0.1:1',
    logLines = [],
    degradeMapping = ENABLED,
    bridgeUrl = null,
    usageFetcher = null,
  }) {
    const bridge = bridgeUrl
      ? {
        enabled: true,
        url: bridgeUrl,
        modelPattern: '^gpt-',
        connectTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        connectRetries: 0,
      }
      : { enabled: false };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstreamUrl,
        usagePolling: { enabled: false },
        openaiBridge: { ...bridge, ...(degradeMapping ? { degradeMapping } : {}) },
      },
      currentCredentialReader: async () => null,
      ...(usageFetcher ? { usageFetcher } : {}),
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    return proxy;
  }

  const ask = (proxy, model = 'sonnet') => requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model }),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3_000,
  });

  // 写像したときだけ出る痕跡（degradeLog）。R4-5 で暫定行を廃止し、その要求の proxy ログ行へ併記する形にしたので、ここも proxy 行を見る。
  // **proxy ログ行を持たない経路（P-b / P-g）では痕跡が残らない**ため、
  // それらのケースは応答（status・上流が付けた x-path-test ヘッダ）で経路を固定する。
  // P-d は R-S9b（母艦裁定 D-197）で proxy 行を持つようになった（下の 4-d 2件）。
  const mapLines = logLines => logLines.filter(line => / proxy account=/.test(line) && /mapReason=/.test(line));
  const lastMapLine = logLines => mapLines(logLines).at(-1);

  const exhaustedBody = '{"type":"error","error":{"type":"overloaded_error"}}';

  // (pool)=unusable を学習させるための偽 bridge（契約 §C10.3 T3）。
  async function startExhaustedBridge() {
    const bridge = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(529, {
        'Content-Type': 'application/json',
        'content-length': String(Buffer.byteLength(exhaustedBody)),
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-upstream-status': '429',
        'x-ombr-reset-at': '2099-01-01T00:00:00Z',
      });
      res.end(exhaustedBody);
    }));
    cleanupAfterTest(async () => close(bridge.server));
    return bridge;
  }

  // 上流に一度も届かない構成（P-a / P-d は上流へ送らずに 429 を作る）。
  async function startUnusedUpstream() {
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }));
    cleanupAfterTest(async () => close(upstream.server));
    return { upstream, seen };
  }

  // -------------------------------------------------------------------------
  // R4-2: P-a（局所合成の 429）と P-d（sendUnavailableAccounts の 429 分岐）
  // -------------------------------------------------------------------------

  it('4-a: maps the locally synthesised quota 429 (P-a) to 529 overloaded_error', async () => {
    const { upstream, seen } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 529, '全枠切れの合成 429 は Astra へ退避させる');
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.body.error.message, 'All Claude accounts are exhausted.');
    assert.deepEqual(seen, [], 'P-a は上流へ送らない');
    assert.match(lastMapLine(logLines), /mapPath=a/);
    assert.match(lastMapLine(logLines), /mappedFrom=429 mappedFromType=rate_limit_error mappedTo=529/);
    assert.match(lastMapLine(logLines), /mapReason=all_claude_accounts_exhausted/);
    assert.equal(
      response.headers['content-length'],
      String(Buffer.byteLength(response.bodyText)),
      'Content-Length は写像後の本文長へ入れ替える（§8.7 手順3）',
    );
  });

  it('4-d: maps the sendUnavailableAccounts 429 branch (P-d) to 529', async () => {
    const { upstream, seen } = await startUnusedUpstream();
    // 資格情報が1つも無いので forwardCurrentUnavailableAccount は送信せずに false を返し、
    // P-d の 429 分岐へ落ちる（reason は temporary_throttle なので P-a は発火しない）。
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.markRateLimited('acct_1', 60);
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.deepEqual(seen, []);
    // R-S9b（母艦裁定 D-197）でこの経路にも痕跡が残るようになった。R4-5 の時点では
    // P-d は proxy ログ行を1行も持たず、写像したことがログのどこにも出なかった。
    const pdLines = logLines.filter(line => / proxy account=/.test(line));
    assert.equal(pdLines.length, 1, 'P-d の痕跡は1行だけ（R-S9b）');
    assert.match(pdLines[0], /mapPath=d rotatorReason=quota_exhausted$/);
  });

  // 【R-S9】この経路の期待値は 503 → 529 へ変わった（設計書 §5.3(d)・§14.2 案イ・
  // 坂根氏の判断⑤(e)）。全滅台帳の終端が口座の個別 state で 503 に化けると、529 を
  // fallbackModel の発火条件にしている bridge 側で退避が働かないためである（I-6・
  // D-67-2）。503 は「写像しないと決まったとき」だけ残る（同 describe の 5-b 群と、
  // 「全滅時の終端応答を写像入口へ揃える (R-S9 …)」describe が押さえる）。
  it('4-d: routes the credential branch of P-d through the mapper as well (R-S9 / I-6)', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.markError('acct_1', 'authentication_error', 'OAuth token rejected');
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529, '認証失敗でも全滅時の終端は写像入口を通す（I-6）');
    assert.equal(response.body.error.type, 'overloaded_error');
    // R-S9b（母艦裁定 D-197）: 資格情報起因の全滅は理由まで痕跡に残す（4-d 上段と同じ1行）。
    // D-199 で語彙を分割したので、認証失効は「人を呼ぶ」側の credential_login_required。
    const pdLines = logLines.filter(line => / proxy account=/.test(line));
    assert.equal(pdLines.length, 1, 'P-d の痕跡は1行だけ（R-S9b）');
    assert.match(pdLines[0], /mapPath=d rotatorReason=credential_login_required$/);
  });

  it('5-b: keeps the P-a response at 429 while degradeMapping is unset (§14.4)', async () => {
    const { upstream } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping: null,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 429, '既定（未指定）では現行どおり 429 を返す');
    assert.equal(response.body.error.type, 'rate_limit_error');
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.deepEqual(mapLines(logLines), []);
  });

  it('5-c: never maps while no account is registered at all', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = new AccountManager({ accounts: [], now: () => 1000 });
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 429, '口座0件（インストール直後）は「全枯渇」とみなさない');
    assert.equal(response.body.error.message, 'All configured accounts are unavailable.');
    assert.deepEqual(mapLines(logLines), []);
  });

  it('5-a: never maps the P-a 429 while an un-polled peer account is still usable', async () => {
    // acct_2 は使用量が未取得なので switchTargetScore() は null を返す（R-10）。
    // getRoutingAvailability().state を判定根拠にすると「使えない」と誤判定して
    // 過剰に 529 を返すが、isAvailable() を根拠にすれば写像は起きない（設計書 §4.2）。
    const { upstream, seen } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 429, '写像せず現行どおりの 429 を返す');
    assert.equal(response.body.error.type, 'rate_limit_error');
    assert.equal(
      accountManager.isAvailable(accountManager.find('acct_2')),
      true,
      '判定根拠は isAvailable（台帳）であって応答の見た目でも routing state でもない',
    );
    assert.deepEqual(seen, []);
    assert.deepEqual(mapLines(logLines), []);
  });

  // -------------------------------------------------------------------------
  // R4-3: P-b（lastRetryableResponse の再生）
  // -------------------------------------------------------------------------

  // 反応的枠確認が「確認済み」になった後、唯一の再生先が選択前に throttled になり、
  // 直前の上流 429 がそのまま再生される経路（設計書 §4.2 の P-b）。
  async function runReactiveReplayScenario({ degradeMapping = ENABLED } = {}) {
    const upstreamSeen = [];
    const originalBody = {
      type: 'error', error: { type: 'rate_limit_error', message: 'replay target disappeared' },
    };
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'x-replay-test': 'map-b' });
        res.end(JSON.stringify(originalBody));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    cleanupAfterTest(async () => close(upstream.server));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
    });
    accountManager.updateQuota('acct_2', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    const originalIsAvailable = accountManager.isAvailable.bind(accountManager);
    let armThrottle = false;
    let throttleScheduled = false;
    accountManager.isAvailable = (account, modelFamily = null) => {
      const available = originalIsAvailable(account, modelFamily);
      if (armThrottle && account?.id === 'acct_2' && available && !throttleScheduled) {
        throttleScheduled = true;
        queueMicrotask(() => accountManager.markRateLimited('acct_2', 60));
      }
      return available;
    };
    const logLines = [];
    const proxy = await startProxy({
      accountManager,
      secretStore,
      upstreamUrl: upstream.url,
      logLines,
      degradeMapping,
      usageFetcher: async () => {
        armThrottle = true;
        return {
          scoped_weekly: [{
            key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
          }],
        };
      },
    });

    const response = await ask(proxy, 'claude-fable-5');
    return { response, logLines, upstreamSeen, originalBody };
  }

  it('4-b: maps the replayed lastRetryableResponse 429 (P-b) to 529', async () => {
    const { response, logLines, upstreamSeen } = await runReactiveReplayScenario();

    assert.deepEqual(upstreamSeen, ['Bearer access-token-1'], '再生であって再送ではない');
    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-replay-test'], 'map-b', '再生された応答であること＝P-b');
    // P-b の proxy 行は「上流が 429 を返した時点」（quota-retry）で既に書き終えている
    // ので、後から起きる再生の写像はその行へは載せられない。529 を返した事実は
    // claude-exhaustion-replay の1行が持つ。
    assert.match(
      logLines.filter(line => / proxy account=/.test(line)).at(-1),
      / status=429 /,
      '再生元の上流応答の行は 429 のまま残る',
    );
    const replayLines = logLines.filter(line => / claude-exhaustion-replay /.test(line));
    assert.equal(replayLines.length, 1, '写像した再生は1行だけ残す');
    assert.match(
      replayLines[0],
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z claude-exhaustion-replay account=acct_1 method=POST path=\/v1\/messages status=529 durationMs=0 outcome=quota-exhausted-replay upstreamStatus=429 gptPoolState=unknown claudePoolState=all-exhausted mappedFrom=429 mappedFromType=rate_limit_error mappedTo=529 mapReason=all_claude_accounts_exhausted mapPath=b$/,
      '既存 proxy 行と同じ形＋§9.3 の順序で写像フィールドを併記する',
    );
    assert.ok(
      logLines.indexOf(replayLines[0]) > logLines.findLastIndex(line => / proxy account=/.test(line)),
      '再生元の 429 行の後に出る',
    );
  });

  it('4-b: leaves the replayed 529 (P-b) untouched when upstreamOverloadTo429 is on', async () => {
    // 上流 529 の 429 写像は「Anthropic が返した 529」だけが対象。rotator が合成した
    // 529（再生を含む）は入力集合に入らないので、新キーを真にしても答えは変わらない。
    const base = await runReactiveReplayScenario();
    const withKey = await runReactiveReplayScenario({
      degradeMapping: { enabled: true, upstreamOverloadTo429: true, upstreamOverloadRetryAfterSeconds: 5 },
    });

    assert.equal(withKey.response.status, base.response.status);
    assert.equal(withKey.response.status, 529);
    assert.equal(withKey.response.bodyText, base.response.bodyText);
    assert.equal(withKey.response.headers['retry-after'], undefined, '待機ヘッダを足さない');
    assert.deepEqual(
      withKey.logLines
        .filter(line => / claude-exhaustion-replay /.test(line))
        .map(line => line.replace(/^\S+ /, '')),
      base.logLines
        .filter(line => / claude-exhaustion-replay /.test(line))
        .map(line => line.replace(/^\S+ /, '')),
      '再生の写像ログも同一',
    );
    assert.equal(/claude_upstream_overloaded/.test(withKey.logLines.join('\n')), false);
  });

  it('4-b: keeps the replayed upstream headers and only replaces the body', async () => {
    const { response } = await runReactiveReplayScenario();

    assert.equal(response.headers['x-replay-test'], 'map-b', '上流のヘッダは残す');
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(
      response.headers['content-length'],
      String(Buffer.byteLength(response.bodyText)),
      'content-* だけは写像後の本文に合わせて入れ替える（§8.7 手順2・3）',
    );
  });

  it('5-b: replays the upstream 429 unchanged while degradeMapping is unset (§14.4)', async () => {
    const { response, originalBody, logLines } = await runReactiveReplayScenario({ degradeMapping: null });

    assert.equal(response.status, 429);
    assert.deepEqual(response.body, originalBody);
    assert.equal(response.headers['x-replay-test'], 'map-b');
    assert.deepEqual(
      logLines.filter(line => /claude-exhaustion-replay/.test(line)),
      [],
      '無効な構成では replay 行も出ない（ログは現行と一致）',
    );
  });


  // -------------------------------------------------------------------------
  // R4-4: P-c（利用不可口座での実送信）と P-e（通常ローテーションの素通し）
  // -------------------------------------------------------------------------

  // markRateLimited 済みの単一口座＋資格情報あり ⇒ forwardCurrentUnavailableAccount が
  // passthroughErrors:true で1回だけ実送信する（設計書 §4.2 の P-c）。
  async function runUnavailableAccountSendScenario({
    upstreamStatus = 429,
    degradeMapping = ENABLED,
  } = {}) {
    const upstreamBody = upstreamStatus === 200
      ? JSON.stringify({ ok: true })
      : JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream said 429' } });
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json', 'x-path-test': 'p-c' });
      res.end(upstreamBody);
    }));
    cleanupAfterTest(async () => close(upstream.server));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.markRateLimited('acct_1', 60);
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping,
    });

    const response = await ask(proxy);
    return { response, logLines, upstreamSeen, upstreamBody };
  }

  it('4-c: maps the 429 sent from an unavailable account (P-c) to 529', async () => {
    const { response, logLines, upstreamSeen } = await runUnavailableAccountSendScenario();

    assert.deepEqual(upstreamSeen, ['Bearer access-token-1'], '利用不可口座でも1回は実送信する');
    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-path-test'], 'p-c');
    assert.match(lastMapLine(logLines), /mapPath=c/);
  });

  it('4-c: never maps a 200 from the unavailable-account send (退避のラダーを潰さない)', async () => {
    const { response, logLines, upstreamBody } = await runUnavailableAccountSendScenario({
      upstreamStatus: 200,
    });

    assert.equal(response.status, 200);
    assert.equal(response.bodyText, upstreamBody);
    assert.deepEqual(mapLines(logLines), []);
  });

  it('4-c: never maps a 5xx from the unavailable-account send', async () => {
    const { response, logLines, upstreamBody } = await runUnavailableAccountSendScenario({
      upstreamStatus: 503,
    });

    assert.equal(response.status, 503);
    assert.equal(response.bodyText, upstreamBody);
    assert.deepEqual(mapLines(logLines), []);
  });

  // 通常ローテーション（passthroughErrors:false）で上流 429 を素通しする経路。
  // markRateLimited() が同じ応答の中で先に走るため、「台帳を全枯渇へ変える最後の
  // 1件」がその場で写像される（設計書 §4.2 の P-e）。
  async function runRateLimitPassthroughScenario({
    accounts,
    degradeMapping = ENABLED,
    bridgeUrl = null,
    warmBridge = false,
  } = {}) {
    const upstreamBody = JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error', message: 'upstream throttled' },
    });
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      upstreamSeen.push(req.headers.authorization);
      res.writeHead(429, { 'Content-Type': 'application/json', 'x-path-test': 'p-e' });
      res.end(upstreamBody);
    }));
    cleanupAfterTest(async () => close(upstream.server));
    const secretStore = new MemorySecretStore();
    for (const account of accounts) {
      await secretStore.set(account.id, { accessToken: `access-token-${account.id}` });
    }
    const accountManager = new AccountManager({ accounts, now: () => 1000 });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping, bridgeUrl,
    });
    if (warmBridge) {
      // (pool)=unusable を学習させる1往復（Claude 側の台帳はまだ全枯渇ではない）。
      const warm = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6-astra' }),
        headers: { 'content-type': 'application/json' },
        timeoutMs: 3_000,
      });
      assert.equal(warm.status, 529, '前提: bridge の 529 は素通しされ (pool) が学習される');
    }

    const response = await ask(proxy);
    return { response, logLines, upstreamSeen, upstreamBody, accountManager };
  }

  it('4-e: maps the very 429 that turns the ledger fully unusable (P-e)', async () => {
    const { response, logLines, upstreamSeen, accountManager } = await runRateLimitPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
    });

    assert.deepEqual(upstreamSeen, ['Bearer access-token-acct_1']);
    assert.equal(response.status, 529, 'markRateLimited() の後に判定するので同じ応答で写像される');
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-path-test'], 'p-e');
    assert.equal(accountManager.isAvailable(accountManager.find('acct_1')), false);
    assert.match(lastMapLine(logLines), /mapPath=e/);
  });

  it('5-a: passes the P-e 429 through untouched while a peer account is still usable', async () => {
    const { response, logLines, upstreamBody } = await runRateLimitPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
    });

    assert.equal(response.status, 429, '単一口座の一時 429 は写像しない');
    assert.equal(response.bodyText, upstreamBody);
    assert.deepEqual(mapLines(logLines), []);
  });

  it('5-b: passes the P-e 429 through byte-for-byte while degradeMapping is unset (§14.4)', async () => {
    const { response, logLines, upstreamBody } = await runRateLimitPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      degradeMapping: null,
    });

    assert.equal(response.status, 429);
    assert.equal(response.bodyText, upstreamBody);
    assert.equal(response.headers['x-path-test'], 'p-e');
    assert.deepEqual(mapLines(logLines), []);
  });

  it('4-i: stops with 403 permission_error once the GPT pool is known unusable too', async () => {
    const bridge = await startExhaustedBridge();
    const { response, logLines } = await runRateLimitPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      bridgeUrl: bridge.url,
      warmBridge: true,
    });

    assert.equal(response.status, 403, '529 では無言で固まる（M-6）ので明示停止する');
    assert.equal(response.body.error.type, 'permission_error');
    assert.match(
      response.body.error.message,
      /^All Claude accounts and the Codex pool are unavailable\. Earliest recovery: /,
    );
    assert.equal(
      response.headers['content-length'],
      String(Buffer.byteLength(response.bodyText)),
      '403 本文の長さと Content-Length が一致する（受入条件 4-j）',
    );
    assert.match(lastMapLine(logLines), /mapPath=e/);
    assert.match(lastMapLine(logLines), /gptPoolState=unusable /);
    assert.match(lastMapLine(logLines), /mappedTo=403 mapReason=both_pools_unusable/);
  });

  // -------------------------------------------------------------------------
  // 403 昇格の根拠は「要求モデル系列の枯渇」ではなく「共通枠の枯渇」（設計書 §4.2）。
  // Fable 週次サブキャップだけが全口座で切れている状態は、GPT プールが使えなくても
  // Opus へ退避できるので 529 に留める（403 にすると Claude Code が止まってしまう）。
  // -------------------------------------------------------------------------
  async function runFableSubCapScenario({ exhaustCommonQuota = false } = {}) {
    const bridge = await startExhaustedBridge();
    const { upstream, seen } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-acct_1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    // 共通枠（5h/7d・トークン/リクエスト）は残したまま Fable サブキャップだけを使い切る。
    accountManager.applyUsage('acct_1', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, bridgeUrl: bridge.url,
    });
    // (pool)=unusable を学習させる1往復（この時点の共通枠はまだ残っている）。
    const warm = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra' }),
      headers: { 'content-type': 'application/json' },
      timeoutMs: 3_000,
    });
    assert.equal(warm.status, 529, '前提: bridge の 529 は素通しされ (pool) が学習される');
    if (exhaustCommonQuota) {
      accountManager.updateQuota('acct_1', {
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': '10',
      });
    }

    const response = await ask(proxy, 'claude-fable-5');
    return { response, logLines, seen, accountManager };
  }

  it('4-i: keeps the Fable request at 529 while only the Fable sub-cap is exhausted', async () => {
    const { response, logLines, seen, accountManager } = await runFableSubCapScenario();
    const account = accountManager.find('acct_1');

    assert.equal(accountManager.isAvailable(account, 'fable'), false, '前提: Fable では全口座が使えない');
    assert.equal(accountManager.isAvailable(account, null), true, '前提: 共通枠ではまだ使える');
    assert.equal(response.status, 529, 'Opus へ退避できるので 403 で止めない');
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.body.error.message, 'All Claude accounts are exhausted.');
    assert.deepEqual(seen, [], 'P-a は上流へ送らない');
    assert.match(lastMapLine(logLines), /mapPath=a/);
    assert.match(lastMapLine(logLines), /gptPoolState=unusable /, 'GPT 側が使えない事実は痕跡に残す');
    assert.match(lastMapLine(logLines), /mappedTo=529 mapReason=all_claude_accounts_exhausted/);
  });

  it('4-i: escalates the Fable request to 403 once the common quota is exhausted too', async () => {
    const { response, logLines, accountManager } = await runFableSubCapScenario({ exhaustCommonQuota: true });

    assert.equal(accountManager.isAvailable(accountManager.find('acct_1'), null), false, '前提: 共通枠も枯渇');
    assert.equal(response.status, 403, '退避先が本当に無いときだけ明示停止する');
    assert.equal(response.body.error.type, 'permission_error');
    assert.match(
      response.body.error.message,
      /^All Claude accounts and the Codex pool are unavailable\./,
    );
    assert.match(lastMapLine(logLines), /mappedTo=403 mapReason=both_pools_unusable/);
  });

  // 403 の根拠が共通枠の枯渇である以上、本文へ載せる「最早回復時刻」も共通枠で問う。
  // 要求系列（Fable 週次サブキャップ）で引くと、共通枠より遠いリセット時刻を表示して
  // しまい、実際にはもっと早く再開できるのに「まだ待たされる」と誤解させる。
  it('4-i: reports the common-quota recovery time in the 403 body, not the far Fable weekly reset', async () => {
    const { response, accountManager } = await runFableSubCapScenario({ exhaustCommonQuota: true });
    const earliestResetFor = modelFamily => accountManager
      .getRoutingAvailability(modelFamily)
      .map(entry => entry?.availableAt)
      .filter(Boolean)
      .sort()[0];
    const commonReset = earliestResetFor(null);
    const fableReset = earliestResetFor('fable');

    assert.ok(commonReset && fableReset, '前提: どちらの問い方でも回復時刻が読める');
    assert.ok(commonReset < fableReset, '前提: 共通枠のほうが Fable 週次より早く回復する');
    assert.equal(response.status, 403);
    assert.equal(
      response.body.error.message,
      `All Claude accounts and the Codex pool are unavailable. Earliest recovery: ${commonReset}.`,
      '403 の根拠と同じ共通枠のリセットを載せる',
    );
    assert.equal(
      response.body.error.message.includes(fableReset),
      false,
      '要求系列（Fable 週次）の遠いリセットは載せない',
    );
  });

  // -------------------------------------------------------------------------
  // R4-6: P-f（反応的枠確認が未確認に終わった再生）と P-g（reload で消えた口座）
  // -------------------------------------------------------------------------

  async function runReactivePendingScenario({ accounts, fableUtilization, degradeMapping = ENABLED }) {
    const upstreamBody = JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error', message: 'fable throttled' },
    });
    const upstreamSeen = [];
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-acct_1') {
        res.writeHead(429, { 'Content-Type': 'application/json', 'x-path-test': 'p-f' });
        res.end(upstreamBody);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    cleanupAfterTest(async () => close(upstream.server));
    const secretStore = new MemorySecretStore();
    for (const account of accounts) {
      await secretStore.set(account.id, { accessToken: `access-token-${account.id}` });
    }
    const accountManager = new AccountManager({ accounts });
    // 先頭以外は再生先の候補になれるよう使用量を入れておく（switchTargetScore が
    // null の口座は snapshotKnownAvailableAlternates が候補にしない＝R-10）。
    for (const account of accounts.slice(1)) {
      accountManager.updateQuota(account.id, { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    }
    const logLines = [];
    const proxy = await startProxy({
      accountManager,
      secretStore,
      upstreamUrl: upstream.url,
      logLines,
      degradeMapping,
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: fableUtilization, resets_at: futureReset(),
        }],
      }),
    });

    const response = await ask(proxy, 'claude-fable-5');
    return { response, logLines, upstreamSeen, upstreamBody };
  }

  it('4-f: maps the buffered replay of an unconfirmed reactive 429 (P-f) to 529', async () => {
    const { response, logLines, upstreamSeen } = await runReactivePendingScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      fableUtilization: 0.1,
    });

    assert.deepEqual(upstreamSeen, ['Bearer access-token-acct_1'], '未確認なので再生だけを行う');
    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-path-test'], 'p-f');
    assert.match(lastMapLine(logLines), /mapPath=f/);
  });

  it('4-f: never maps once the reactive confirmation succeeds and the request is replayed', async () => {
    const { response, logLines, upstreamSeen } = await runReactivePendingScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      fableUtilization: 1,
    });

    assert.equal(response.status, 200, '確認できた（quota-retry）経路は次の口座へ回す');
    assert.deepEqual(upstreamSeen, ['Bearer access-token-acct_1', 'Bearer access-token-acct_2']);
    assert.deepEqual(mapLines(logLines), []);
  });

  // (g1) 応答ヘッダが届いた時点で口座が台帳から消えていた場合。
  async function runStaleHeadScenario({ upstreamStatus = 429, degradeMapping = ENABLED } = {}) {
    let releaseResponse;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    let markUpstreamStarted;
    const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
    const upstreamBody = upstreamStatus === 200
      ? JSON.stringify({ ok: true })
      : JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'stale head' } });
    const upstream = await listen(http.createServer(async (req, res) => {
      req.resume();
      markUpstreamStarted();
      await responseGate;
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json', 'x-path-test': 'p-g1' });
      res.end(upstreamBody);
    }));
    cleanupAfterTest(async () => {
      releaseResponse?.();
      await close(upstream.server);
    });
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({ accounts: [{ id: 'acct_1', type: 'oauth' }] });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping,
    });

    const pending = ask(proxy);
    await upstreamStarted;
    accountManager.replaceAccounts([{ id: 'acct_2', type: 'oauth' }]);
    accountManager.markRateLimited('acct_2', 60);
    releaseResponse();
    return { response: await pending, logLines, upstreamBody };
  }

  it('4-g1: maps a 429 whose account had already left the ledger when the head arrived', async () => {
    const { response, logLines } = await runStaleHeadScenario();

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-path-test'], 'p-g1', '上流ヘッダが残るので経路を固定できる');
    // 台帳から消えた口座の要求は c0f79d4 の時点から proxy ログ行を出さない
    // （recordProxyRequest が accounts.includes(account) で守られている）ため、
    // 痕跡の残し先が無い（R4-5 の残課題）。
    assert.deepEqual(logLines.filter(line => / proxy account=/.test(line)), []);
  });

  it('4-g1: does not let finishStaleAccountResponse rewrite or append after the mapping', async () => {
    const { response, logLines } = await runStaleHeadScenario();

    assert.equal(
      response.bodyText,
      '{"type":"error","error":{"type":"overloaded_error","message":"All Claude accounts are exhausted."}}',
      '上流 429 の本文が後ろへ継ぎ足されない',
    );
    assert.equal(
      response.headers['content-length'],
      String(Buffer.byteLength(response.bodyText)),
    );
    // 写像が2回起きれば本文が二重に書かれて上の2つが壊れる（res.headersSent 後は
    // 写像しない＝§8.6）。P-g はログ行を持たないので、検証は応答側で行う。
    assert.equal(logLines.filter(line => /mapReason=/.test(line)).length, 0, 'P-g は痕跡行を持たない');
  });

  it('4-g: never maps a stale 200', async () => {
    const { response, logLines, upstreamBody } = await runStaleHeadScenario({ upstreamStatus: 200 });

    assert.equal(response.status, 200);
    assert.equal(response.bodyText, upstreamBody);
    assert.deepEqual(mapLines(logLines), []);
  });

  it('5-b: passes the stale 429 through while degradeMapping is unset (§14.4)', async () => {
    const { response, logLines, upstreamBody } = await runStaleHeadScenario({ degradeMapping: null });

    assert.equal(response.status, 429);
    assert.equal(response.bodyText, upstreamBody);
    assert.deepEqual(mapLines(logLines), []);
  });

  // (g2) onResponse が false を返して本文をバッファした後（quota-retry）に消えた場合。
  it('4-g2: maps the buffered 429 replayed by finishStaleAccountResponse', async () => {
    let releaseBody;
    const bodyGate = new Promise(resolve => { releaseBody = resolve; });
    const resetAt = String(Math.floor(Date.parse(futureReset()) / 1000));
    const upstreamBody = JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error', message: 'stale body' },
    });
    const upstream = await listen(http.createServer(async (req, res) => {
      req.resume();
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'x-path-test': 'p-g2',
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': resetAt,
      });
      res.flushHeaders();
      await bodyGate;
      res.end(upstreamBody);
    }));
    cleanupAfterTest(async () => {
      releaseBody?.();
      await close(upstream.server);
    });
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({ accounts: [{ id: 'acct_1', type: 'oauth' }] });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines,
    });

    const pending = ask(proxy);
    const applied = await waitForStatus(
      () => accountManager.find('acct_1').quota.unified5h,
      utilization => utilization === 1,
      500,
    );
    assert.equal(applied, 1, '前提: 応答ヘッダは口座がまだ台帳にあるうちに届いている');
    accountManager.replaceAccounts([{ id: 'acct_2', type: 'oauth' }]);
    accountManager.markRateLimited('acct_2', 60);
    releaseBody();

    const response = await pending;
    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.headers['x-path-test'], 'p-g2', '上流ヘッダが残るので経路を固定できる');
    // P-g1 と同じく、台帳から消えた口座の要求は proxy ログ行を持たない（R4-5 の残課題）。
    assert.deepEqual(logLines.filter(line => / proxy account=/.test(line)), []);
  });
});

// ---------------------------------------------------------------------------
// 上流 529 overloaded を 429 ＋ Retry-After へ写像する（坂根氏 2026-09-18 の要件）。
//
// 「ハイデマンドで Fable 5.1 が使えない時は、リトライが走る 429 になるように」。
// Claude Code は 529 を3回で fallbackModel へ退避させるが、429 なら同じモデルのまま
// 待って再試行する。ここでは偽 Anthropic 上流を立て、実 TCP で写像を固定する。
//
// 対象は上流（Anthropic）が返した 529（本文 overloaded_error）だけ。rotator が合成する
// 529 も bridge 経由の 529 も入力集合に入らない（(c)）。口座台帳は一切学習しない（(e)）。
// ---------------------------------------------------------------------------
describe('上流 529 overloaded の 429 写像 (upstreamOverloadTo429)', () => {
  const OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  const ON = { upstreamOverloadTo429: true };

  async function startProxy({
    accountManager,
    secretStore,
    upstreamUrl,
    logLines = [],
    degradeMapping = ON,
    reloadOpenAiBridge = null,
  }) {
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstreamUrl,
        usagePolling: { enabled: false },
        openaiBridge: { enabled: false, ...(degradeMapping ? { degradeMapping } : {}) },
      },
      currentCredentialReader: async () => null,
      ...(reloadOpenAiBridge ? { reloadOpenAiBridge } : {}),
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    return proxy;
  }

  // 本文と付随ヘッダを差し替えられる偽 Anthropic 上流。上流が実際に付けてくる
  // 待機ヘッダ（残すと最大数時間の無音待機になる）を必ず載せる。
  async function startOverloadedUpstream({ body = OVERLOADED, extraHeaders = {} } = {}) {
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(529, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
        'request-id': 'req_upstream_529',
        'Retry-After': '900',
        'anthropic-ratelimit-unified-reset': '1789000000',
        'anthropic-ratelimit-requests-remaining': '0',
        ...extraHeaders,
      });
      res.end(body);
    }));
    cleanupAfterTest(async () => close(upstream.server));
    return { upstream, seen };
  }

  async function readyAccountManager(ids = ['acct_1']) {
    const secretStore = new MemorySecretStore();
    for (const id of ids) await secretStore.set(id, { accessToken: `access-token-${id}` });
    const accountManager = new AccountManager({
      accounts: ids.map(id => ({ id, type: 'oauth' })),
      now: () => 1000,
    });
    return { secretStore, accountManager };
  }

  const ask = proxy => requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-fable-5-1' }),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3_000,
  });

  // 壊れた JSON の透過も観測するので、本文を解析しない素の要求を使う。
  const askRaw = proxy => new Promise((resolve, reject) => {
    const target = new URL(`${proxy.url}/v1/messages`);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(3_000, () => request.destroy(new Error('test client timeout')));
    request.end(JSON.stringify({ model: 'claude-fable-5-1' }));
  });

  const proxyLines = logLines => logLines.filter(line => / proxy account=/.test(line));

  it('(a) answers 429 rate_limit_error with Retry-After and logs mapReason on the same line', async () => {
    const { upstream } = await startOverloadedUpstream();
    const { secretStore, accountManager } = await readyAccountManager();
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 429, '529 だと Claude Code が fallbackModel へ退避してしまう');
    assert.equal(response.body.error.type, 'rate_limit_error');
    assert.equal(response.headers['retry-after'], '30');
    assert.deepEqual(
      Object.keys(response.headers).filter(key => key.startsWith('anthropic-ratelimit-')),
      [],
      '上流の枠ヘッダを残すと Claude Code がその時刻まで無音で眠る',
    );
    assert.equal(
      response.headers['content-length'],
      String(Buffer.byteLength(response.bodyText)),
      'Content-Length は写像後の本文長へ入れ替える',
    );
    assert.equal(response.headers['request-id'], 'req_upstream_529', '診断用ヘッダは残す');

    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, '行は増やさない（既存の1行へ併記する）');
    assert.match(
      lines[0],
      / status=429 durationMs=\d+ outcome=upstream-error-passthrough requestId=req_upstream_529/,
      '返した status（429）を行の status にする',
    );
    // 行末で閉じない。観測整備（PR #42）の `model= sid= in= …` が同じ行のこの後ろへ
    // 付くので、`$` で留めると写像とは無関係な理由で落ちる（§7.1「追記は末尾で、
    // 順序に依存しない読み方をすること」）。写像フィールドが連続していることは見る。
    assert.match(
      lines[0],
      / upstreamStatus=529 mappedFrom=529 mappedFromType=overloaded_error mappedTo=429 retryAfter=30 mapReason=claude_upstream_overloaded/,
      '実際の上流ステータスを必ず同じ行へ残す',
    );
  });

  it('(a) uses the configured Retry-After seconds', async () => {
    const { upstream } = await startOverloadedUpstream();
    const { secretStore, accountManager } = await readyAccountManager();
    const logLines = [];
    const proxy = await startProxy({
      accountManager,
      secretStore,
      upstreamUrl: upstream.url,
      logLines,
      degradeMapping: { upstreamOverloadTo429: true, upstreamOverloadRetryAfterSeconds: 7 },
    });

    const response = await ask(proxy);
    assert.equal(response.headers['retry-after'], '7');
    // 同じ理由で行末に留めない（この後ろに観測整備の追記が続く）。
    assert.match(proxyLines(logLines).at(-1), /retryAfter=7 mapReason=claude_upstream_overloaded/);
  });

  it('(b) passes an upstream 529 through untouched when the body is not overloaded_error', async () => {
    for (const [body, label] of [
      ['{"type":"error","error":{"type":"api_error","message":"temporary upstream failure"}}', 'api_error'],
      ['', '空本文'],
      ['{"type":"error",', '壊れた JSON'],
    ]) {
      const { upstream } = await startOverloadedUpstream({ body });
      const { secretStore, accountManager } = await readyAccountManager();
      const logLines = [];
      const proxy = await startProxy({
        accountManager, secretStore, upstreamUrl: upstream.url, logLines,
      });

      const response = await askRaw(proxy);

      assert.equal(response.status, 529, label);
      assert.equal(response.bodyText, body, `${label}: 本文をそのまま返す`);
      assert.equal(response.headers['request-id'], 'req_upstream_529', label);
      assert.equal(response.headers['retry-after'], '900', `${label}: 上流のヘッダを書き換えない`);
      assert.equal(
        /mapReason=/.test(proxyLines(logLines).at(-1)),
        false,
        `${label}: 写像していないので痕跡も出ない`,
      );
    }
  });

  it('(e) never learns quota exhaustion or marks the account unusable', async () => {
    // 台帳の扱いは「写像したときも off のときと1つも変わらない」ことで固定する。
    // 上流 529 に枠ヘッダが付いていれば updateQuota はどちらでも同じように記録するので、
    // 「不変」ではなく「off と同値」が正しい言明である（updateQuota は意図的に残す）。
    const ledgerSnapshot = manager => ({
      currentAccount: manager.getStatus().currentAccount,
      status: manager.accounts[0].status,
      quota: structuredClone(manager.accounts[0].quota ?? null),
      rateLimitedUntil: manager.accounts[0].rateLimitedUntil ?? null,
      errorReason: manager.accounts[0].errorReason ?? null,
      eventTypes: manager.events.map(event => event.type),
    });

    // 同じ 529 を3回叩いても口座が落ちず、ローテーションも起きない（要件④）。
    const run = async degradeMapping => {
      const { upstream, seen } = await startOverloadedUpstream();
      const { secretStore, accountManager } = await readyAccountManager();
      const proxy = await startProxy({
        accountManager, secretStore, upstreamUrl: upstream.url, degradeMapping,
      });
      const statuses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) statuses.push((await ask(proxy)).status);
      return { statuses, seen, ledger: ledgerSnapshot(accountManager) };
    };

    const on = await run(ON);
    const off = await run(null);

    assert.deepEqual(on.statuses, [429, 429, 429], '前提: 3回とも写像されている');
    assert.deepEqual(off.statuses, [529, 529, 529], '前提: off では素通しされている');
    assert.deepEqual(on.ledger, off.ledger, 'スイッチの有無で口座台帳の扱いが1つも変わらない');

    assert.equal(on.ledger.currentAccount, 'acct_1', '選択は動かない');
    assert.equal(on.ledger.status, 'active', 'throttled / error にしない');
    assert.equal(on.ledger.rateLimitedUntil, null, 'markRateLimited を呼ばない');
    assert.equal(on.ledger.errorReason, null, 'markError を呼ばない');
    assert.deepEqual(
      on.ledger.eventTypes,
      ['proxy-request', 'proxy-request', 'proxy-request'],
      '529 overloaded で増えるのは proxy-request だけ（口座の状態遷移イベントは1件も出ない）',
    );
    assert.deepEqual(
      on.seen,
      ['Bearer access-token-acct_1', 'Bearer access-token-acct_1', 'Bearer access-token-acct_1'],
      '別口座を試さない（毎回同じ Bearer で届く）',
    );
  });

  it('(c) leaves the locally synthesised 529 (P-a) exactly as it is', async () => {
    // rotator が自分で作る 529（all_claude_accounts_exhausted）は対象外。
    const { upstream, seen } = await startOverloadedUpstream();
    const { secretStore, accountManager } = await readyAccountManager();
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager,
      secretStore,
      upstreamUrl: upstream.url,
      logLines,
      degradeMapping: { enabled: true, upstreamOverloadTo429: true },
    });

    const response = await ask(proxy);

    assert.equal(response.status, 529, '合成 529 は退避させたままにする');
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.body.error.message, 'All Claude accounts are exhausted.');
    assert.equal(response.headers['retry-after'], undefined);
    assert.deepEqual(seen, [], '上流へは送っていない');
    assert.match(proxyLines(logLines).at(-1), /mapReason=all_claude_accounts_exhausted mapPath=a$/);
  });

  it('(g) picks the mapping up and drops it again through POST /internal/reload', async () => {
    const { upstream } = await startOverloadedUpstream();
    const { secretStore, accountManager } = await readyAccountManager();
    let nextBridge = { enabled: false };
    const proxy = await startProxy({
      accountManager,
      secretStore,
      upstreamUrl: upstream.url,
      degradeMapping: null,
      reloadOpenAiBridge: async () => nextBridge,
    });
    const reload = () => requestJson(`${proxy.url}/internal/reload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}` },
      timeoutMs: 5_000,
    });

    assert.equal((await ask(proxy)).status, 529, '既定 off では素通し');

    nextBridge = { enabled: false, degradeMapping: { upstreamOverloadTo429: true } };
    assert.equal((await reload()).status, 200);
    const mapped = await ask(proxy);
    assert.equal(mapped.status, 429, 'プロセス再起動なしで有効になる');
    assert.equal(mapped.headers['retry-after'], '30');

    nextBridge = { enabled: false, degradeMapping: { upstreamOverloadTo429: false } };
    assert.equal((await reload()).status, 200);
    assert.equal((await ask(proxy)).status, 529, 'キーを false にするだけで即座に切り戻せる');
  });
});

// ---------------------------------------------------------------------------
// R4-5: 写像した要求の「既存の proxy ログ行」へ、写像フィールドを併記すること。
//
// 設計書 §9.1「529 と偽装する以上、実際の上流ステータスを必ず同じ行に残す」
// （受入条件7）を、暫定行ではなく本来のログ行で満たす。
// 追記は §9.3 の順序で、値があるキーだけを末尾へ足す。写像しなかった要求と
// degradeMapping を書いていない構成では、行は現行（c0f79d4）と文字列一致する（§14.4）。
// ---------------------------------------------------------------------------
describe('写像フィールドを既存の proxy ログ行へ併記する (R4-5 / 設計書 §9.3・§9.5)', () => {
  const ENABLED = { enabled: true };
  // c0f79d4 時点の proxy 行の形（末尾に何も足さない）。requestId / errorType は
  // 任意なので、この正規表現は「追記フィールドが1つも無いこと」を見ている。
  const LEGACY_PROXY_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z proxy account=\S+ method=\S+ path=\S+ status=\S+ durationMs=\d+ outcome=[a-z-]+(?: requestId=\S+)?(?: errorType=\S+)?$/;

  async function startProxy({
    accountManager,
    secretStore = new MemorySecretStore(),
    upstreamUrl = 'http://127.0.0.1:1',
    logLines = [],
    degradeMapping = ENABLED,
    bridgeUrl = null,
  }) {
    const bridge = bridgeUrl
      ? {
        enabled: true,
        url: bridgeUrl,
        modelPattern: '^gpt-',
        connectTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        connectRetries: 0,
      }
      : { enabled: false };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstreamUrl,
        usagePolling: { enabled: false },
        openaiBridge: { ...bridge, ...(degradeMapping ? { degradeMapping } : {}) },
        // この describe が固定しているのは「degradeMapping が proxy 行を変えないこと」であって、
        // キャッシュ観測の追記ではない。観測は既定 on（U-3）なので、明示的に切って
        // degradeMapping だけを見る。観測を on にした行の形は
        // describe('cache observability') と test/invariance.test.js が固定する。
        observability: { requestLog: { enabled: false } },
      },
      currentCredentialReader: async () => null,
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    return proxy;
  }

  const ask = (proxy, model = 'sonnet') => requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model }),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3_000,
  });

  const proxyLines = logLines => logLines.filter(line => / proxy account=/.test(line));

  // P-a（局所合成の 429）。上流へは一度も送らないので proxy 行は1本だけになる。
  async function runExhaustedAccountScenario({ degradeMapping = ENABLED } = {}) {
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }));
    cleanupAfterTest(async () => close(upstream.server));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping,
    });

    const response = await ask(proxy);
    return { response, logLines };
  }

  // P-e（通常ローテーションの素通し）。bridge を先に1往復させると (pool)=unusable を
  // 学習し、同じ 429 が 403 へ写像される（設計書 §8.7）。
  async function runPassthroughScenario({ accounts, degradeMapping = ENABLED, warmBridge = false } = {}) {
    const upstreamBody = JSON.stringify({
      type: 'error', error: { type: 'rate_limit_error', message: 'upstream throttled' },
    });
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(upstreamBody);
    }));
    cleanupAfterTest(async () => close(upstream.server));
    let bridgeUrl = null;
    if (warmBridge) {
      const exhaustedBody = '{"type":"error","error":{"type":"overloaded_error"}}';
      const bridge = await listen(http.createServer((req, res) => {
        req.resume();
        res.writeHead(529, {
          'Content-Type': 'application/json',
          'content-length': String(Buffer.byteLength(exhaustedBody)),
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'codex_pool_exhausted',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-pool-state': 'exhausted',
          'x-ombr-upstream-status': '429',
          'x-ombr-reset-at': '2099-01-01T00:00:00Z',
        });
        res.end(exhaustedBody);
      }));
      cleanupAfterTest(async () => close(bridge.server));
      bridgeUrl = bridge.url;
    }
    const secretStore = new MemorySecretStore();
    for (const account of accounts) {
      await secretStore.set(account.id, { accessToken: `access-token-${account.id}` });
    }
    const accountManager = new AccountManager({ accounts, now: () => 1000 });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping, bridgeUrl,
    });
    if (warmBridge) {
      assert.equal((await ask(proxy, 'gpt-6-astra')).status, 529, '前提: (pool)=unusable を学習させる');
    }

    const response = await ask(proxy);
    return { response, logLines, upstreamBody };
  }

  it('R4-5-1: keeps the real upstream status on the very line that returned 529 (P-a / 受入条件7)', async () => {
    const { response, logLines } = await runExhaustedAccountScenario();

    assert.equal(response.status, 529);
    const line = proxyLines(logLines).at(-1);
    assert.match(
      line,
      / status=529 durationMs=\d+ outcome=quota-exhausted-local upstreamStatus=429 gptPoolState=unknown claudePoolState=all-exhausted mappedFrom=429 mappedFromType=rate_limit_error mappedTo=529 mapReason=all_claude_accounts_exhausted mapPath=a$/,
      '返した status（529）と実際の上流ステータス（429）が同じ1行に並ぶ（§9.3 の順序）',
    );
    assert.equal(proxyLines(logLines).length, 1, 'P-a は行を増やさない（既存の1行へ併記する）');
  });

  it('R4-5-2: records mappedTo=403, mapReason and resetAt when both pools are unusable', async () => {
    const { response, logLines } = await runPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      warmBridge: true,
    });

    assert.equal(response.status, 403);
    const line = proxyLines(logLines).at(-1);
    assert.match(line, / status=403 /, '返した status が行の status になる');
    assert.match(line, / upstreamStatus=429 resetAt=\S+ gptPoolState=unusable claudePoolState=all-exhausted /);
    // mappedFromType はヘッダ送出点（P-c / P-e / P-g1）では本文がまだ届いていないので
    // 出ない。「値があるキーだけを載せる」（§9.2）の当然の帰結である。
    assert.match(line, /mappedFrom=429 mappedTo=403 mapReason=both_pools_unusable mapPath=e$/);
  });

  it('R4-5-3: leaves a non-mapped 429 line exactly as it is today (§14.4)', async () => {
    const { response, logLines, upstreamBody } = await runPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
    });

    assert.equal(response.status, 429, '他口座が使えるので写像しない');
    assert.equal(response.bodyText, upstreamBody);
    assert.ok(proxyLines(logLines).length > 0, '比較対象の行が実際に出ている');
    for (const line of proxyLines(logLines)) assert.match(line, LEGACY_PROXY_LINE);
    assert.deepEqual(
      logLines.filter(line => /claude-exhaustion-replay/.test(line)),
      [],
      '写像しない要求では P-b の replay 行も出ない',
    );
  });

  it('R4-5-4: leaves every proxy line unchanged while degradeMapping is unset (§14.4)', async () => {
    const passthrough = await runPassthroughScenario({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      degradeMapping: null,
    });
    const synthesised = await runExhaustedAccountScenario({ degradeMapping: null });

    assert.equal(passthrough.response.status, 429);
    assert.equal(synthesised.response.status, 429);
    const lines = [...proxyLines(passthrough.logLines), ...proxyLines(synthesised.logLines)];
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, LEGACY_PROXY_LINE);
  });

  it('R4-5-5: no longer writes the interim claude-exhaustion-map line', async () => {
    const { response, logLines } = await runExhaustedAccountScenario();

    assert.equal(response.status, 529, '写像そのものは起きている');
    assert.deepEqual(logLines.filter(line => line.includes('claude-exhaustion-map')), []);
  });
});

// ---------------------------------------------------------------------------
// R-S9b（母艦裁定 D-197。語彙は D-199 で分割した）: 写像後の 529 / 403 が「なぜ止まって
// いるのか」を機械可読で名乗る。ヘッダは `x-claude-rotator-reason` の1本だけで、語彙は
// 既存の分類をそのまま写した3値（`quota_exhausted` / `credential_cooldown` /
// `credential_login_required`）。新しい分類は作らない。読み手が最初に知りたいのは
// 「待てば回復するのか、人を呼ぶのか」なので、資格情報起因はそこで2つに割る。
// あわせて、これまで proxy ログ行を1行も持たなかった P-d（sendUnavailableAccounts）に、
// 写像したときだけ既存と同じ形の行を1行出す（末尾に mapPath=d と rotatorReason）。
// degradeMapping を書いていない構成では、ヘッダも行も1つも増えない（§14.4）。
// ---------------------------------------------------------------------------
describe('写像後 529 の理由ヘッダと P-d の proxy 行 (R-S9b / 母艦裁定 D-197)', () => {
  const ENABLED = { enabled: true };
  const REASON_HEADER = 'x-claude-rotator-reason';

  async function startProxy({
    accountManager,
    secretStore = new MemorySecretStore(),
    upstreamUrl,
    logLines,
    degradeMapping = ENABLED,
  }) {
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: {
        upstream: upstreamUrl,
        usagePolling: { enabled: false },
        openaiBridge: { enabled: false, ...(degradeMapping ? { degradeMapping } : {}) },
      },
      currentCredentialReader: async () => null,
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => close(proxy.server));
    return proxy;
  }

  // P-a も P-d も上流へは送らずに終端する（上流に1件も届かないことで経路を固定する）。
  async function startUnusedUpstream() {
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }));
    cleanupAfterTest(async () => close(upstream.server));
    return { upstream, seen };
  }

  const ask = proxy => requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'sonnet' }),
    headers: { 'content-type': 'application/json' },
    timeoutMs: 3_000,
  });

  const proxyLines = logLines => logLines.filter(line => / proxy account=/.test(line));

  function singleAccountManager() {
    return new AccountManager({ accounts: [{ id: 'acct_1', type: 'oauth' }], now: () => 1000 });
  }

  it('9b-1: labels the mapped P-a 529 as quota_exhausted', async () => {
    const { upstream, seen } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = singleAccountManager();
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(response.headers[REASON_HEADER], 'quota_exhausted', '枠の枯渇は quota_exhausted');
    assert.deepEqual(seen, [], 'P-a は上流へ送らない');
  });

  it('9b-2: labels the mapped P-d 529 as credential_login_required and writes one proxy line with mapPath=d', async () => {
    const { upstream, seen } = await startUnusedUpstream();
    const accountManager = singleAccountManager();
    accountManager.markError('acct_1', 'authentication_error', 'OAuth token rejected');
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529, '資格情報の全滅でも終端は写像入口を通す（R-S9 / I-6）');
    assert.equal(response.headers[REASON_HEADER], 'credential_login_required');
    assert.deepEqual(seen, [], 'P-d は上流へ送らない');
    const lines = proxyLines(logLines);
    assert.equal(lines.length, 1, 'P-d の痕跡は1行だけ');
    assert.match(lines[0], / status=529 durationMs=0 outcome=unavailable-accounts-local/);
    assert.match(lines[0], /mapReason=all_claude_accounts_exhausted/);
    assert.match(lines[0], /mapPath=d rotatorReason=credential_login_required$/);
    // D-199 (B): 行頭の時刻は実時計ではなく注入した時計（now: () => 1000）から取る。
    // 他の proxy 行（accountManager.recordProxyRequest）と同じ出所にしておかないと、
    // 時刻を固定したテストでこの行だけがずれる。
    assert.match(lines[0], /^1970-01-01T00:00:01\.000Z proxy account=acct_1 /);
  });

  it('9b-3: keeps quota_exhausted on a P-d whose terminal reason is not a credential failure', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = singleAccountManager();
    accountManager.markRateLimited('acct_1', 60);
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(response.headers[REASON_HEADER], 'quota_exhausted', '新しい分類は作らない');
    assert.match(proxyLines(logLines).at(-1), /mapPath=d rotatorReason=quota_exhausted$/);
  });

  it('9b-4: adds neither the header nor the P-d line while degradeMapping is unset (§14.4)', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = singleAccountManager();
    accountManager.markError('acct_1', 'authentication_error', 'OAuth token rejected');
    const logLines = [];
    const proxy = await startProxy({
      accountManager, upstreamUrl: upstream.url, logLines, degradeMapping: null,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 503, '写像しない構成では現行どおり 503 を返す');
    assert.equal(response.headers[REASON_HEADER], undefined, '無効な構成ではヘッダを足さない');
    assert.deepEqual(proxyLines(logLines), [], 'P-d のログ行も出ない');
  });

  it('9b-5: leaves the P-a 429 without the header while degradeMapping is unset (§14.4)', async () => {
    const { upstream } = await startUnusedUpstream();
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = singleAccountManager();
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': '10',
    });
    const logLines = [];
    const proxy = await startProxy({
      accountManager, secretStore, upstreamUrl: upstream.url, logLines, degradeMapping: null,
    });

    const response = await ask(proxy);

    assert.equal(response.status, 429);
    assert.equal(response.headers[REASON_HEADER], undefined);
  });

  // -------------------------------------------------------------------------
  // D-199 (A): P-d の分類は `currentIndex` が指す1口座の理由ではなく、**全口座**の
  // `unavailableReason` を走査して決める。このヘッダの用途は「待てばよいのか、人を呼ぶ
  // のか」の機械判別なので、現在口座が枠切れでも別の口座が再ログイン待ちなら人を呼ぶ
  // 価値がある。優先は credential_login_required ＞ credential_cooldown ＞ quota_exhausted。
  // 503 分岐（写像しない構成）の述語と挙動は変えていない（9b-4 が押さえる）。
  // -------------------------------------------------------------------------

  function twoAccountManager() {
    return new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      now: () => 1000,
    });
  }

  it('9b-6: reports credential_login_required when any account needs a re-login', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = twoAccountManager();
    accountManager.markRateLimited('acct_1', 60);
    accountManager.markError('acct_2', 'authentication_error', 'OAuth token rejected');
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(
      response.headers[REASON_HEADER],
      'credential_login_required',
      '現在口座が枠切れでも、別口座が再ログイン待ちなら人を呼ぶ側を名乗る',
    );
    assert.match(proxyLines(logLines).at(-1), /mapPath=d rotatorReason=credential_login_required$/);
  });

  it('9b-7: reports credential_cooldown when any account only waits out a refresh cooldown', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = twoAccountManager();
    accountManager.markRateLimited('acct_1', 60);
    accountManager.markCredentialRefreshRateLimited('acct_2', 60);
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(
      response.headers[REASON_HEADER],
      'credential_cooldown',
      '資格情報側だが待てば回復する（人を呼ぶ必要は無い）',
    );
    assert.match(proxyLines(logLines).at(-1), /mapPath=d rotatorReason=credential_cooldown$/);
  });

  it('9b-8: stays quota_exhausted while no account has a credential problem', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = twoAccountManager();
    accountManager.markRateLimited('acct_1', 60);
    accountManager.markRateLimited('acct_2', 60);
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(response.headers[REASON_HEADER], 'quota_exhausted');
    assert.match(proxyLines(logLines).at(-1), /mapPath=d rotatorReason=quota_exhausted$/);
  });

  it('9b-9: prefers credential_login_required over a concurrent cooldown (優先順位)', async () => {
    const { upstream } = await startUnusedUpstream();
    const accountManager = twoAccountManager();
    accountManager.markCredentialRefreshRateLimited('acct_1', 60);
    accountManager.markError('acct_2', 'oauth_refresh_failed', 'refresh failed');
    const logLines = [];
    const proxy = await startProxy({ accountManager, upstreamUrl: upstream.url, logLines });

    const response = await ask(proxy);

    assert.equal(response.status, 529);
    assert.equal(response.headers[REASON_HEADER], 'credential_login_required');
  });
});

describe('account_switch trigger wiring', () => {
  function switchLines(logLines) {
    return logLines.filter(line => line.includes(' account_switch '));
  }

  it('passes trigger=request when a request leaves an unusable account', async () => {
    const logLines = [];
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      logger,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(futureReset() / 1000)),
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 200);
    assert.equal(switchLines(logLines).length, 1);
    assert.match(
      switchLines(logLines)[0],
      / account_switch from=acct_1 to=acct_2 reason=quota-threshold trigger=request$/,
    );
  });

  it('passes trigger=429 when a reactive Fable 429 moves the active account', async () => {
    const logLines = [];
    const upstream = await listen(http.createServer((req, res) => {
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      logger,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      // 反応的確認が確定させるのは共通枠（5h）の枯渇。系統枠だけの枯渇では
      // R-S2b（設計書 §5.1）により currentIndex が動かず、切替行そのものが出ない。
      usageFetcher: async () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.equal(response.status, 200);
    assert.equal(switchLines(logLines).length, 1);
    assert.match(
      switchLines(logLines)[0],
      / account_switch from=acct_1 to=acct_2 reason=quota-threshold trigger=429$/,
    );
  });

  it('passes trigger=request when the exhausted response picks the shortest reset', async () => {
    const logLines = [];
    const upstream = await listen(http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      logger,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor(futureReset() / 1000) + 3600),
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor(futureReset() / 1000)),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'sonnet' }),
    });

    assert.equal(response.status, 429);
    assert.equal(switchLines(logLines).length, 1);
    assert.match(
      switchLines(logLines)[0],
      / account_switch from=acct_1 to=acct_2 reason=shortest-quota-reset trigger=request$/,
    );
  });
});

describe('サブキャップ 429 の非対称の是正 (R-S2b / 設計書 §5.1)', () => {
  function switchLines(logLines) {
    return logLines.filter(line => line.includes(' account_switch '));
  }

  // 429 を返す口座（acct_1）だけが 429 を返し、ほかの資格情報は 200 を返す上流。
  async function exhaustedOnFirstAccountUpstream(upstreamSeen) {
    return listen(http.createServer((req, res) => {
      upstreamSeen.push(req.headers.authorization);
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit' },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
  }

  it('does not move currentIndex for a reactive sub-cap 429', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await exhaustedOnFirstAccountUpstream(upstreamSeen);
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      logger,
    });
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
        }],
      }),
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      upstreamSeen,
      currentAccount: accountManager.getStatus().currentAccount,
      switches: switchLines(logLines).length,
    }, {
      status: 200,
      body: { ok: true },
      // この要求だけが acct_2 へ流れる。先回り経路（getActiveAccount の ad-hoc 選択）と同じ扱い。
      upstreamSeen: ['Bearer access-token-1', 'Bearer access-token-2'],
      currentAccount: 'acct_1',
      switches: 0,
    });
  });

  it('still moves currentIndex for a reactive common-quota 429', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await exhaustedOnFirstAccountUpstream(upstreamSeen);
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('acct_2', { accessToken: 'access-token-2' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'acct_2', type: 'oauth' },
      ],
      logger,
    });
    accountManager.updateQuota('acct_2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      // 反応的確認が返すのは共通枠（5h）の枯渇。系統枠ではない。
      usageFetcher: async () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      currentAccount: accountManager.getStatus().currentAccount,
      switches: switchLines(logLines).length,
    }, {
      status: 200,
      body: { ok: true },
      currentAccount: 'acct_2',
      switches: 1,
    });
    assert.match(
      switchLines(logLines)[0],
      / account_switch from=acct_1 to=acct_2 reason=quota-threshold trigger=429$/,
    );
  });

  it('judges the sub-cap 429 by the quota of the account that returned it, not by the switch target', async () => {
    const upstreamSeen = [];
    const logLines = [];
    const upstream = await exhaustedOnFirstAccountUpstream(upstreamSeen);
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    await secretStore.set('common_exhausted', { accessToken: 'access-token-common' });
    await secretStore.set('target', { accessToken: 'access-token-target' });
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: [
        { id: 'acct_1', type: 'oauth' },
        { id: 'common_exhausted', type: 'oauth' },
        { id: 'target', type: 'oauth' },
      ],
      logger,
    });
    // 429 を返す口座: 共通枠は健全、系統枠（Fable）だけが枯れる（反応的確認で確定する）。
    accountManager.updateQuota('acct_1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.2',
    });
    // 共通枠が枯れた口座。切替先にはなれないが、台帳に共通枠の状態が逆の口座を置く。
    accountManager.updateQuota('common_exhausted', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.floor((Date.now() + 3_600_000) / 1000)),
    });
    // 実際の切替先候補。共通枠も系統枠も健全なので familyQuotaExhaustedOnly は偽になる。
    accountManager.updateQuota('target', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false } },
      usageFetcher: async () => ({
        scoped_weekly: [{
          key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset(),
        }],
      }),
      logger,
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const response = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-fable-5' }),
    });

    const now = accountManager.now();
    const source = accountManager.find('acct_1');
    const switchTarget = accountManager.find('target');
    // 判定対象を取り違えると結論が逆になることを、述語そのもので固定する。
    assert.deepEqual({
      source: familyQuotaExhaustedOnly(source, accountManager.switchThreshold, 'fable', now),
      switchTarget: familyQuotaExhaustedOnly(switchTarget, accountManager.switchThreshold, 'fable', now),
    }, { source: true, switchTarget: false });

    assert.deepEqual({
      status: response.status,
      body: response.body,
      servedBy: upstreamSeen[upstreamSeen.length - 1],
      currentAccount: accountManager.getStatus().currentAccount,
      switches: switchLines(logLines).length,
    }, {
      status: 200,
      body: { ok: true },
      // 切替先は実際に選ばれている（reactiveSelection で判定していれば切替が起きるはず）。
      servedBy: 'Bearer access-token-target',
      currentAccount: 'acct_1',
      switches: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// sticky affinity 本体の結線（R-S7 / 設計書 v1.5 §4.1・§4.4・§7.1・§7.2・§9 F9）
//
// 統合①②③④⑥⑦⑫⑬⑯㉑ ＋ `fam=` 1件 ＋ F9 1件。
// 既存ケースは1件も削除・書換しない。`mode:"off"`（既定・未記載）では proxy 行が
// 追加前とバイト同一であること（`fam` 用の1件で固定する）。
// ---------------------------------------------------------------------------
describe('session affinity wiring (R-S7)', () => {
  // 末尾追記あり（§7.1）。sid は鍵を持つ要求だけに出る。
  const AFFINITY_PROXY_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z proxy account=\S+ method=\S+ path=\S+ status=\S+ durationMs=\d+ outcome=[a-z-]+(?: requestId=\S+)?(?: errorType=\S+)?(?: sid=[0-9a-f]{12})? aff=(?:new|bound|switch|none) fam=(?:fable|other)$/;
  // 追記が1つも無い現行の形（`mode:"off"` で守る）。
  const LEGACY_PROXY_LINE_RS7 = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z proxy account=\S+ method=\S+ path=\S+ status=\S+ durationMs=\d+ outcome=[a-z-]+(?: requestId=\S+)?(?: errorType=\S+)?$/;

  function eventLines(logLines, kind) {
    return logLines.filter(line => line.includes(` ${kind} `));
  }

  function proxyLines(logLines) {
    return logLines.filter(line => line.includes(' proxy account='));
  }

  function futureResetSeconds(offsetMs = 3_600_000) {
    return String(Math.floor((Date.now() + offsetMs) / 1000));
  }

  async function waitFor(predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!predicate() && Date.now() - startedAt < timeoutMs) await sleep(5);
    return predicate();
  }

  // 資格情報の解決（`resolveSecretForAccount` の await）を任意の口座で止められる保管庫。
  // 統合⑫（予約が無い実装なら2本目が別口座へ割れる）と⑯（遅着した確定）で使う。
  class GatedSecretStore extends MemorySecretStore {
    constructor() {
      super();
      this.gate = null;
      this.entered = [];
    }

    async getOperational(accountId) {
      if (this.gate && this.gate.accountId === accountId) {
        this.entered.push(accountId);
        await this.gate.promise;
      }
      return super.getOperational(accountId);
    }

    openGate(accountId) {
      let release = null;
      const promise = new Promise(resolve => { release = resolve; });
      this.gate = { accountId, promise, release };
      return () => { this.gate = null; release(); };
    }
  }

  async function startAffinity({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on' },
    upstream: upstreamHandler = null,
    secretStore: providedStore = null,
    tokenRefresher = null,
    clock = null,
  } = {}) {
    const logLines = [];
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (upstreamHandler && upstreamHandler({ req, res, seen }) === true) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = providedStore || new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, type: 'oauth' })),
      logger,
      ...(clock ? { now: () => clock.ms } : {}),
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger,
      ...(tokenRefresher ? { tokenRefresher } : {}),
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        ...(sessionAffinity ? { sessionAffinity } : {}),
        // この describe が固定しているのは sticky の追記（sid=/aff=/fam=）と `mode:"off"` で
        // 行が現行のままであることで、キャッシュ観測の追記ではない。観測は既定 on（U-3）で
        // 同じ行の**さらに末尾**へ足すので、ここは明示的に切って affinity だけを見る。
        // 観測を on にした行の形は describe('cache observability') と
        // test/invariance.test.js が固定する。
        observability: { requestLog: { enabled: false } },
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, model = 'sonnet', headers = {} } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: { ...(sid ? { 'x-claude-code-session-id': sid } : {}), ...headers },
      },
    );
    return { proxy, upstream, seen, secretStore, accountManager, logLines, logger, ask };
  }

  it('①: two sessions land on two different accounts', async () => {
    const { ask, seen, logLines } = await startAffinity();

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal((await ask({ sid: 'session-two' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_b']);
    assert.equal(eventLines(logLines, 'affinity_bind').length, 2, '新規バインドは2件');
  });

  it('②: ten requests of one session stay on the bound account after another account gains headroom', async () => {
    const { ask, seen, accountManager, logLines } = await startAffinity();

    // 先に別セッションを acct_a へ載せ、対象のセッションが acct_b（＝`currentIndex` が
    // 指していない口座）へ結び付く状態を作る。固定していなければ acct_a へ戻ってしまう。
    assert.equal((await ask({ sid: 'session-zero' })).status, 200);
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    // 結び付け先の残枠が減り、他口座の残枠が上回っても既存セッションは動かない（R2）。
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.8' });
    for (let index = 0; index < 9; index += 1) {
      assert.equal((await ask({ sid: 'session-one' })).status, 200);
    }

    assert.equal(seen.length, 11);
    assert.equal(seen[0], 'Bearer token-acct_a');
    assert.deepEqual(new Set(seen.slice(1)), new Set(['Bearer token-acct_b']));
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), []);
  });

  it('③: a side request on another model family keeps the session on its account', async () => {
    const { ask, seen } = await startAffinity();

    await ask({ sid: 'session-zero' });
    await ask({ sid: 'session-one', model: 'claude-fable-5' });
    await ask({ sid: 'session-one', model: 'claude-3-5-haiku-20241022' });

    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_b',
    ]);
  });

  it('④: a sub-agent request with an agent id stays on the parent account', async () => {
    const { ask, seen } = await startAffinity();

    await ask({ sid: 'session-one' });
    // 別セッションを先に作って、鍵に agent-id が混ざれば別口座へ行く状態にする。
    await ask({ sid: 'session-two' });
    await ask({ sid: 'session-one', headers: { 'x-claude-code-agent-id': 'agent-7' } });

    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_a',
    ]);
  });

  it('⑥: a Fable-only sub-cap moves only the Fable sub-binding', async () => {
    const { ask, seen, accountManager, logLines } = await startAffinity();

    await ask({ sid: 'session-one' });
    accountManager.applyUsage('acct_a', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });

    await ask({ sid: 'session-one', model: 'claude-fable-5' });
    await ask({ sid: 'session-one', model: 'sonnet' });

    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_a',
    ]);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(switches[0], / reason=family_exhausted family=fable switches=1$/);
  });

  it('⑦: the assign-stop gate skips a loaded account for a new session but keeps the bound one', async () => {
    const { ask, seen, accountManager } = await startAffinity();

    await ask({ sid: 'session-one' });
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.95' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });

    await ask({ sid: 'session-one' });
    await ask({ sid: 'session-two' });

    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_a',
      'Bearer token-acct_b',
    ]);
  });

  it('⑫: two concurrent requests of one session share the account across the credential await', async () => {
    const secretStore = new GatedSecretStore();
    const { ask, seen, accountManager, logLines } = await startAffinity({ secretStore });

    // 先に別セッションを acct_a へ載せ、K3（バインド数の少ない口座）で acct_b が選ばれる
    // 状態を作る。予約が無い実装では、2本目が独立に選び直して acct_a へ割れる。
    assert.equal((await ask({ sid: 'session-zero' })).status, 200);

    const release = secretStore.openGate('acct_b');
    const first = ask({ sid: 'session-one' }).catch(error => ({ error }));
    const firstWaited = await waitFor(() => secretStore.entered.length === 1);
    // ② と同じ手法を足す（R-S7 の L1 申し送り）: 1本目がゲートで待つあいだに
    // acct_a の残枠を acct_b より良くし、新規割当の帯を acct_a だけにする。確定1点だけの
    // 実装はここで 2本目が acct_a を選び直し、同じセッションが2口座へ割れる。
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    const second = ask({ sid: 'session-one' }).catch(error => ({ error }));
    const secondWaited = await waitFor(() => secretStore.entered.length === 2);
    release();
    const firstResult = await first;
    const secondResult = await second;

    assert.ok(firstWaited, '1本目が資格情報の解決で待つ');
    assert.ok(secondWaited, '2本目も同じ口座の解決へ入る');
    assert.equal(firstResult.status, 200);
    assert.equal(secondResult.status, 200);
    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_b',
    ]);
    assert.equal(eventLines(logLines, 'affinity_bind').length, 2, '2本目は新規バインドを作らない');
    // 帯が acct_a だけになっていたことの直接確認。新規セッションは acct_a へ行くので、
    // 予約を持たない実装なら 2本目も acct_a を選んで上の deepEqual が割れる。
    assert.equal((await ask({ sid: 'session-two' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a');
  });

  it('⑬: a short rate limit on the bound account leaves the binding alone', async () => {
    const clock = { ms: Date.now() };
    let rateLimited = false;
    const { ask, seen, logLines } = await startAffinity({
      clock,
      upstream: ({ req, res }) => {
        if (!rateLimited || req.headers.authorization !== 'Bearer token-acct_a') return false;
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
        return true;
      },
    });

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    rateLimited = true;
    assert.equal((await ask({ sid: 'session-one' })).status, 429, '短期レート制限はそのまま返る');
    rateLimited = false;
    clock.ms += 61_000;
    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_a',
      'Bearer token-acct_a',
    ], 'バインド先は一度も変わらない');
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), []);
    assert.deepEqual(
      proxyLines(logLines).map(line => line.split(' aff=')[1]),
      ['new fam=other', 'bound fam=other', 'bound fam=other'],
    );
  });

  it('⑯: a late confirmation does not overwrite the binding a newer request made', async () => {
    const secretStore = new GatedSecretStore();
    const { ask, seen, accountManager, logLines } = await startAffinity({ secretStore });

    const release = secretStore.openGate('acct_a');
    const first = ask({ sid: 'session-one' }).catch(error => ({ error }));
    const waited = await waitFor(() => secretStore.entered.length === 1);

    // R1 が待っているあいだに acct_a の共通枠が枯れ、R2 が acct_b へ付け替える。
    accountManager.updateQuota('acct_a', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': futureResetSeconds(),
    });
    const second = await ask({ sid: 'session-one' }).catch(error => ({ error }));
    release();
    const firstResult = await first;

    assert.ok(waited, 'R1 が acct_a を予約して待つ');
    assert.equal(second.status, 200);
    assert.equal(firstResult.status, 200);

    const stale = eventLines(logLines, 'affinity_stale');
    assert.equal(stale.length, 1);
    assert.match(stale[0], / myGen=1 curGen=2 dropped=acct_a$/);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(switches[0], / from=acct_a to=acct_b reason=common_exhausted family=other switches=1$/);

    // 表は R2 が作ったバインド（acct_b）のままである。
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b');
  });

  it('㉑: a transient auth failure completes on another account without moving the binding', async () => {
    let authFails = true;
    const { ask, seen, accountManager, logLines } = await startAffinity({
      tokenRefresher: async () => ({
        accessToken: 'token-acct_a-fresh',
        refreshToken: 'refresh-acct_a-2',
        expiresAt: Date.now() + 3_600_000,
      }),
      upstream: ({ req, res }) => {
        if (!authFails || !String(req.headers.authorization).startsWith('Bearer token-acct_a')) return false;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid authentication credentials' } }));
        return true;
      },
    });

    const response = await ask({ sid: 'session-one' });

    assert.equal(response.status, 200, '別口座で完走する');
    assert.equal(seen.at(-1), 'Bearer token-acct_b');
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), [], 'バインドは動かない');

    // 一時障害が解けたら、次の要求は元の口座へ戻る。
    authFails = false;
    accountManager.markAuthenticated('acct_a');
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a-fresh');
  });

  it('records fam=fable / fam=other while affinity runs and keeps the line byte-identical while it is off', async () => {
    const enabled = await startAffinity();
    await enabled.ask({ sid: 'session-one', model: 'claude-fable-5' });
    await enabled.ask({ sid: 'session-one', model: 'sonnet' });
    await enabled.ask({ model: 'sonnet' });

    const lines = proxyLines(enabled.logLines);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.match(line, AFFINITY_PROXY_LINE);
    assert.match(lines[0], / sid=[0-9a-f]{12} aff=new fam=fable$/);
    assert.match(lines[1], / sid=[0-9a-f]{12} aff=bound fam=other$/);
    assert.match(lines[2], / outcome=ok aff=none fam=other$/, '鍵の無い要求に sid は出ない');

    const off = await startAffinity({ sessionAffinity: null });
    await off.ask({ sid: 'session-one', model: 'claude-fable-5' });
    await off.ask({ model: 'sonnet' });
    const offLines = proxyLines(off.logLines);
    assert.equal(offLines.length, 2);
    for (const line of offLines) assert.match(line, LEGACY_PROXY_LINE_RS7);
    assert.deepEqual(off.logLines.filter(line => line.includes(' affinity_')), []);
  });

  it('F9: releases the table row of a long stream when the client aborts', async () => {
    const streams = [];
    const upstreamClosed = [];
    const { proxy, ask, logLines } = await startAffinity({
      sessionAffinity: { mode: 'on', maxSessions: 1 },
      upstream: ({ req, res }) => {
        if (req.headers['x-stream-forever'] !== '1') return false;
        streams.push(res);
        // クライアントが切ると proxy は上流要求を destroy する。その到達を待って
        // 「proxy の res close が既に走った」ことを確定させる（解放の観測点）。
        req.on('close', () => upstreamClosed.push(1));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: ping\n\n');
        return true;
      },
    });
    cleanupAfterTest(async () => { for (const res of streams) res.end(); });

    const target = new URL(proxy.url);
    const stream = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': 'session-stream',
        'x-stream-forever': '1',
      },
    });
    stream.on('error', () => {});
    cleanupAfterTest(async () => stream.destroy());
    stream.end(JSON.stringify({ model: 'sonnet' }));
    assert.ok(await waitFor(() => streams.length === 1), '長時間 SSE が上流まで届く');

    // 応答中の行は落とさない（maxSessions=1 でも退避されない）。
    assert.equal((await ask({ sid: 'session-two' })).status, 200);
    assert.deepEqual(eventLines(logLines, 'affinity_evict'), [], '応答終了まで表の行を保持する');

    stream.destroy();
    assert.ok(await waitFor(() => upstreamClosed.length === 1), 'abort が proxy まで伝わる');
    assert.equal((await ask({ sid: 'session-three' })).status, 200);

    const evicted = eventLines(logLines, 'affinity_evict');
    assert.ok(evicted.length >= 1, '解放された行は容量退避の対象へ戻る');
    assert.match(evicted[0], / reason=capacity /);
    assert.ok(
      evicted.some(line => line.includes(` sid=${sidHash('session-stream')} `)),
      '切られた SSE の行が退避された',
    );
  });
});

// ---------------------------------------------------------------------------
// R-S8: 固定セッションの試行ループと終端（設計書 §4.1・§4.3・§4.5・§5.3(a)(b)）。
//
// 押さえるのは3点である。
//   (a) 再バインドは重複ガードへ到達する前に終わっており、固定セッションの試行ループの
//       上限は「バインド先1 ＋ 再バインド候補数」である（鍵の無い要求は口座総数のまま）。
//   (b) 固定セッションの枯渇応答は `selectBestExhaustedFallback` を通らない（P-2）。
//   (c) 付け替える範囲は「いま使えなかった結び付け先」だけである（D-63 C2）。
// 加えて D-154（反応的 429 の周のうちに系統別の副バインドを作る）を固定する。
// ---------------------------------------------------------------------------
describe('session affinity rebind and terminal (R-S8)', () => {
  function eventLines(logLines, kind) {
    return logLines.filter(line => line.includes(` ${kind} `));
  }

  function futureResetSeconds(offsetMs = 3_600_000) {
    return String(Math.floor((Date.now() + offsetMs) / 1000));
  }

  // 「枠が枯れたことが確定した」429（`unifiedQuotaHeaderEvidence.confirmsExhaustion`）。
  function exhaustedQuota429(res, offsetMs = 3_600_000) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': futureResetSeconds(offsetMs),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'usage limit reached' },
    }));
  }

  // 枠の証拠を持たない Fable の 429（反応的確認へ落ちる形）。
  function bareFable429(res) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Fable limit' },
    }));
  }

  function commonExhaustedHeaders(offsetMs = 3_600_000) {
    return {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': futureResetSeconds(offsetMs),
    };
  }

  /**
   * `currentIndex` の全代入点を直接見張る（統合⑪・D-54-2 の再定義）。関数名ではなく
   * インスタンスへの代入そのものを捕まえるので、7点のどれから書かれても記録に残る。
   */
  function watchCurrentIndex(accountManager) {
    const assignments = [];
    let value = accountManager.currentIndex;
    Object.defineProperty(accountManager, 'currentIndex', {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: next => { assignments.push(next); value = next; },
    });
    return assignments;
  }

  async function startAffinity({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on' },
    upstream: upstreamHandler = null,
    usageFetcher = null,
  } = {}) {
    const logLines = [];
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (upstreamHandler && upstreamHandler({ req, res, seen }) === true) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, type: 'oauth' })),
      logger,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger,
      ...(usageFetcher ? { usageFetcher } : {}),
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        ...(sessionAffinity ? { sessionAffinity } : {}),
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, model = 'sonnet', headers = {} } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: { ...(sid ? { 'x-claude-code-session-id': sid } : {}), ...headers },
      },
    );
    return { proxy, upstream, seen, secretStore, accountManager, logLines, logger, ask };
  }

  it('⑤: a confirmed quota 429 on the bound account rebinds and completes in the same request', async () => {
    let exhausted = false;
    const { ask, seen, logLines } = await startAffinity({
      upstream: ({ req, res }) => {
        if (!exhausted || req.headers.authorization !== 'Bearer token-acct_a') return false;
        exhaustedQuota429(res);
        return true;
      },
    });

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    exhausted = true;
    const response = await ask({ sid: 'session-one' });

    assert.equal(response.status, 200, '素の 429 ではなく再バインドして完走する');
    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_a',
      'Bearer token-acct_b',
    ]);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(switches[0], / from=acct_a to=acct_b reason=common_exhausted family=other switches=1$/);

    exhausted = false;
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b', '次の要求は新しい結び付け先へ行く');
  });

  it('⑪: a pinned request reaches none of the 7 currentIndex assignment points', async () => {
    // まず「代入点は7点・6関数」という前提そのものを固定する（D-54-2 の再定義・§5.3(b)）。
    // 8点目が増えたらこの行で落ちるので、見張りの網が実装より遅れない。
    const source = await readFile(
      resolve(dirname(fileURLToPath(import.meta.url)), '../src/account-manager.js'),
      'utf8',
    );
    const sourceLines = source.split('\n');
    const methodPattern = /^ {2}([A-Za-z_$][\w$]*)\(/;
    const assignmentPoints = [];
    let enclosingMethod = null;
    for (const line of sourceLines) {
      const method = methodPattern.exec(line);
      if (method) enclosingMethod = method[1];
      if (line.includes('currentIndex = ')) assignmentPoints.push(enclosingMethod);
    }
    assert.equal(assignmentPoints.length, 7, 'currentIndex の代入点は7点');
    assert.deepEqual(new Set(assignmentPoints), new Set([
      'constructor',
      'switchTo',
      'replaceAccounts',
      'restoreState',
      'switchToCandidate',
      'switchToExhaustedFallbackCandidate',
    ]), '代入点を持つのは6関数');

    // (i) 反応的 429 の再試行の周（`switchToCandidate` が第5の代入点）。
    let fableLimited = false;
    const reactive = await startAffinity({
      usageFetcher: async () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
      upstream: ({ req, res }) => {
        if (!fableLimited || req.headers.authorization !== 'Bearer token-acct_a') return false;
        bareFable429(res);
        return true;
      },
    });
    // 反応的確認の再生先は `switchTargetScore` が非 null の口座だけなので、
    // acct_b に既知の利用率を与えておく（枠の数字が1つも無い口座は候補にならない）。
    reactive.accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    reactive.accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    assert.equal((await reactive.ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);
    const reactiveAssignments = watchCurrentIndex(reactive.accountManager);
    fableLimited = true;
    assert.equal((await reactive.ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);
    assert.deepEqual(
      reactiveAssignments,
      [],
      '反応的 429 の周でも固定セッションは currentIndex を代入しない',
    );
    assert.deepEqual(eventLines(reactive.logLines, 'account_switch'), []);

    // (ii) 枯渇応答の生成（`switchToExhaustedFallbackCandidate` が第6の代入点）。
    const terminal = await startAffinity();
    assert.equal((await terminal.ask({ sid: 'session-one' })).status, 200);
    const terminalAssignments = watchCurrentIndex(terminal.accountManager);
    terminal.accountManager.updateQuota('acct_a', commonExhaustedHeaders(7_200_000));
    terminal.accountManager.updateQuota('acct_b', commonExhaustedHeaders(1_800_000));
    assert.equal((await terminal.ask({ sid: 'session-one' })).status, 429);
    assert.deepEqual(
      terminalAssignments,
      [],
      '枯渇応答の生成でも固定セッションは currentIndex を代入しない',
    );
  });

  it('⑮: a common-quota exhaustion rebinds each pinned session on its own and moves currentIndex only for a keyless request', async () => {
    const { ask, seen, accountManager, logLines } = await startAffinity();
    // acct_b を新規割当の帯の外へ出して、2セッションとも acct_a へ結び付ける。
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal((await ask({ sid: 'session-two' })).status, 200);
    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);

    const assignments = watchCurrentIndex(accountManager);
    accountManager.updateQuota('acct_a', commonExhaustedHeaders());
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal((await ask({ sid: 'session-two' })).status, 200);

    assert.deepEqual(seen.slice(2), ['Bearer token-acct_b', 'Bearer token-acct_b']);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 2, '縛られていた2セッションが1本ずつ個別に付け替わる');
    for (const line of switches) {
      assert.match(line, / from=acct_a to=acct_b reason=common_exhausted family=other /);
    }
    assert.deepEqual(assignments, [], '固定セッションの付け替えでは currentIndex は動かない');
    assert.deepEqual(eventLines(logLines, 'account_switch'), []);

    // 鍵の無い要求のためだけに、既存ロジックが currentIndex を動かす（§4.5）。
    assert.equal((await ask({})).status, 200);
    assert.deepEqual(assignments, [1]);
    const globalSwitches = eventLines(logLines, 'account_switch');
    assert.equal(globalSwitches.length, 1);
    assert.match(globalSwitches[0], / from=acct_a to=acct_b reason=\S+ trigger=request$/);
  });

  it('⑳: a common-quota exhaustion on the sub-binding moves only that family binding', async () => {
    const { ask, seen, accountManager, logLines } = await startAffinity({
      accounts: ['acct_a', 'acct_b', 'acct_c'],
    });
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.02' });
    accountManager.updateQuota('acct_c', { 'anthropic-ratelimit-unified-5h-utilization': '0.03' });
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a', 'home は acct_a');

    // Fable のサブキャップだけが枯れる -> その系統専用の副バインドが acct_b にできる。
    accountManager.applyUsage('acct_a', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    assert.equal((await ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b');

    // 副バインド先の共通枠が枯れる -> 動くのは副バインドだけである（D-63 C2）。
    const assignments = watchCurrentIndex(accountManager);
    accountManager.updateQuota('acct_b', commonExhaustedHeaders());
    assert.equal((await ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_c', '副バインドだけが acct_c へ移る');
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a', 'home は acct_a のまま動かない');

    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 2);
    assert.match(switches[0], / from=acct_a to=acct_b reason=family_exhausted family=fable switches=1$/);
    assert.match(switches[1], / from=acct_b to=acct_c reason=common_exhausted family=fable switches=2$/);
    assert.deepEqual(assignments, []);
  });

  it('㉒: a pinned session walks its rebind candidates instead of returning the bare all-unavailable 429', async () => {
    const exhaustedIds = new Set();
    const { ask, seen, accountManager, logLines } = await startAffinity({
      accounts: ['acct_a', 'acct_b', 'acct_c'],
      upstream: ({ req, res }) => {
        const id = String(req.headers.authorization).replace('Bearer token-', '');
        if (!exhaustedIds.has(id)) return false;
        exhaustedQuota429(res);
        return true;
      },
    });
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.02' });
    accountManager.updateQuota('acct_c', { 'anthropic-ratelimit-unified-5h-utilization': '0.03' });
    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    exhaustedIds.add('acct_a');
    exhaustedIds.add('acct_b');
    const response = await ask({ sid: 'session-one' });

    assert.equal(response.status, 200, '台帳に使える口座が残るかぎり完走する');
    assert.ok(
      !response.bodyText.includes('All configured accounts are unavailable'),
      '素の 429 を返さない',
    );
    assert.deepEqual(seen.slice(1), [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_c',
    ], 'バインド先1 ＋ 再バインド候補2 を最後まで試す');
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 2);
    assert.match(switches[0], / from=acct_a to=acct_b reason=common_exhausted family=other switches=1$/);
    assert.match(switches[1], / from=acct_b to=acct_c reason=common_exhausted family=other switches=2$/);
  });

  it('㉓: the exhausted terminal of a pinned session moves neither currentIndex nor the fallback-switch event', async () => {
    const { ask, accountManager, logLines } = await startAffinity();
    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    const assignments = watchCurrentIndex(accountManager);
    accountManager.updateQuota('acct_a', commonExhaustedHeaders(7_200_000));
    accountManager.updateQuota('acct_b', commonExhaustedHeaders(1_800_000));
    const response = await ask({ sid: 'session-one' });

    assert.equal(response.status, 429);
    assert.equal(
      response.body.error.details.account,
      'acct_b',
      '応答はいちばん早く回復する口座で合成する（現行と同じ中身）',
    );
    assert.deepEqual(assignments, [], 'selectBestExhaustedFallback を通らない');
    assert.deepEqual(
      accountManager.events.filter(event => event.type === 'fallback-switch'),
      [],
      'fallback-switch も積まれない',
    );
    assert.deepEqual(eventLines(logLines, 'account_switch'), []);

    // 鍵の無い要求は現行どおり動く（固定セッション用の経路と分かれている証拠）。
    assert.equal((await ask({})).status, 429);
    assert.deepEqual(assignments, [1]);
    assert.equal(
      accountManager.events.filter(event => event.type === 'fallback-switch').length,
      1,
    );
  });

  it('D-154: an upstream 429 with family-quota evidence creates the sub-binding inside the same round', async () => {
    let fableLimited = true;
    const { ask, seen, accountManager, logLines } = await startAffinity({
      usageFetcher: async () => ({
        scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
      }),
      upstream: ({ req, res }) => {
        if (!fableLimited || req.headers.authorization !== 'Bearer token-acct_a') return false;
        bareFable429(res);
        return true;
      },
    });

    // 再生先の候補になれるのは枠の数字が既知の口座だけである（`switchTargetScore`）。
    // acct_a を帯の先頭に置いて、新規セッションが acct_a へ結び付くようにする。
    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    const response = await ask({ sid: 'session-one', model: 'claude-fable-5' });

    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_b']);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1, '反応的 429 の周のうちに副バインドを作る');
    assert.match(switches[0], / from=acct_a to=acct_b reason=family_exhausted family=fable switches=1$/);

    // home は動いていないので、非 Fable の要求は acct_a のままである。
    fableLimited = false;
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a');
    // 次の Fable 要求は、表に載った副バインドへ直行する。
    assert.equal((await ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b');
    assert.equal(eventLines(logLines, 'affinity_switch').length, 1, '付け替えは1回だけ');
  });

  it('D-154: an upstream 429 with common-quota evidence rebinds the home in the same round', async () => {
    let limited = true;
    const { ask, seen, accountManager, logLines } = await startAffinity({
      usageFetcher: async () => ({
        five_hour: { utilization: 1, resets_at: futureReset() },
      }),
      upstream: ({ req, res }) => {
        if (!limited || req.headers.authorization !== 'Bearer token-acct_a') return false;
        bareFable429(res);
        return true;
      },
    });

    accountManager.updateQuota('acct_a', { 'anthropic-ratelimit-unified-5h-utilization': '0.01' });
    accountManager.updateQuota('acct_b', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
    assert.equal((await ask({ sid: 'session-one', model: 'claude-fable-5' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_b']);
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(switches[0], / from=acct_a to=acct_b reason=common_exhausted family=fable switches=1$/);
    assert.deepEqual(eventLines(logLines, 'account_switch'), [], 'currentIndex は動かない');

    // home が移ったので、非 Fable の要求も acct_b へ行く（副バインドは破棄・§4.1）。
    limited = false;
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b');
    assert.equal(accountManager.getCurrentAccount().id, 'acct_a', '稼働口座は据え置き');
  });
});

// ---------------------------------------------------------------------------
// R-S9: 全滅時の終端応答を写像入口へ揃える（統合テスト㉔ / 設計書 §5.3(d)・§14.2 案イ /
// 不変条件 I-6・実装で守る点 P-6）。
//
// 現行は `sendUnavailableAccounts` の資格情報分岐が写像器を呼ばずに 503 を書いて
// return するため、同じ「全滅」台帳でも固定先（= `getCurrentAccount()` が返す口座）が
// 認証失敗・資格情報 cooldown のときだけ 529 が 503 に化ける。bridge は 529 を
// Claude Code の fallbackModel の発火条件として前提にしているので、503 では退避が
// 働かない（D-67-2）。sticky ではセッションが1口座へ張り付くぶん、この化けが
// そのセッションの全滅時応答に居座り続ける。
//
// 述語 `isCredentialUnavailable` は status 画面（`src/monitor.js` の
// `login expired` / `needs login`）と `futureAvailabilityForModelFamily` と共有して
// いるので触らない。変更するのは分岐側だけで、「503 の意味（認証情報が使えない）を
// 運用者へ伝える役割は status 画面が担う」という整理は §14.2（D-72）のまま変えない。
// ---------------------------------------------------------------------------
describe('全滅時の終端応答を写像入口へ揃える (R-S9 / 統合㉔ / I-6・P-6)', () => {
  const ENABLED_MAPPING = { enabled: true };

  const exhaustedBridgeBody = '{"type":"error","error":{"type":"overloaded_error"}}';

  // (pool)=unusable を学習させるための偽 bridge（契約 §C10.3 T3）。
  async function startUnusableBridge() {
    const bridge = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(529, {
        'Content-Type': 'application/json',
        'content-length': String(Buffer.byteLength(exhaustedBridgeBody)),
        'x-ombr-contract': '1',
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-upstream-status': '429',
        'x-ombr-reset-at': '2099-01-01T00:00:00Z',
      });
      res.end(exhaustedBridgeBody);
    }));
    cleanupAfterTest(async () => close(bridge.server));
    return bridge;
  }

  async function startTerminal({
    accounts = ['acct_a'],
    sessionAffinity = { mode: 'on' },
    degradeMapping = ENABLED_MAPPING,
    bridgeUrl = null,
    tokenRefresher = null,
    usageFetcher = null,
  } = {}) {
    const logLines = [];
    const seen = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      logger,
    });
    const bridge = bridgeUrl
      ? {
        enabled: true,
        url: bridgeUrl,
        modelPattern: '^gpt-',
        connectTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        connectRetries: 0,
      }
      : { enabled: false };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger,
      allowLiveClaudeCodeCredentials: false,
      currentCredentialReader: async () => null,
      ...(tokenRefresher ? { tokenRefresher } : {}),
      ...(usageFetcher ? { usageFetcher } : {}),
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        openaiBridge: { ...bridge, ...(degradeMapping ? { degradeMapping } : {}) },
        ...(sessionAffinity ? { sessionAffinity } : {}),
      },
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });

    const ask = ({ sid = 'session-one', model = 'sonnet' } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: {
          'content-type': 'application/json',
          ...(sid ? { 'x-claude-code-session-id': sid } : {}),
        },
        timeoutMs: 3_000,
      },
    );
    return { proxy, accountManager, secretStore, logLines, seen, ask };
  }

  function exhaustCommonQuota(accountManager, id, offsetMs = 3_600_000) {
    accountManager.updateQuota(id, {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(Math.ceil((Date.now() + offsetMs) / 1000)),
    });
  }

  function assertNoCredential503(response) {
    assert.notEqual(response.status, 503, '固定先の個別 state で 503 に化けない（I-6）');
    assert.ok(
      !response.bodyText.includes('No usable OAuth credential'),
      '資格情報分岐の 503 本文が漏れない',
    );
  }

  it('㉔(i): keeps the pinned terminal at 529 when every account is quota-exhausted', async () => {
    const { ask, accountManager } = await startTerminal({ accounts: ['acct_a', 'acct_b'] });
    assert.equal((await ask()).status, 200);

    exhaustCommonQuota(accountManager, 'acct_a', 7_200_000);
    exhaustCommonQuota(accountManager, 'acct_b', 1_800_000);
    const response = await ask();

    assert.equal(response.status, 529, '全口座枯渇は現行どおり写像入口を通る（非回帰）');
    assert.equal(response.body.error.type, 'overloaded_error');
    assertNoCredential503(response);
  });

  it('㉔(ii): ends a pinned session at 529 when its bound account is rejected (authentication_error)', async () => {
    const { ask, accountManager, seen } = await startTerminal();
    assert.equal((await ask()).status, 200);

    accountManager.markError('acct_a', 'authentication_error', 'OAuth token rejected');
    const response = await ask();

    assert.equal(response.status, 529, '固定先が認証失敗でも退避が働く 529 を返す');
    assert.equal(response.body.error.type, 'overloaded_error');
    assert.equal(response.body.error.message, 'All Claude accounts are exhausted.');
    assertNoCredential503(response);
    assert.equal(seen.length, 1, '終端の判定で上流へ送り直さない');
  });

  it('㉔(ii): ends a pinned session at 529 when the stored refresh credential expired (NATIVE_REFRESH_REAUTH_REQUIRED)', async () => {
    const { ask, proxy, secretStore } = await startTerminal({
      tokenRefresher: async () => {
        throw Object.assign(
          new Error('The stored OAuth refresh credential has expired and must be linked again'),
          { code: 'NATIVE_REFRESH_REAUTH_REQUIRED' },
        );
      },
      usageFetcher: async () => assert.fail('usage fetch must not run after the refresh fails'),
    });
    assert.equal((await ask()).status, 200);

    // 46e7d9c（J-1）で「保存済み refresh 資格情報の期限切れ」が認証失効へ分類される
    // ようになった経路をそのまま通す（§0）。この入口は v1.0 起点のテストには無い。
    await secretStore.set('acct_a', {
      accessToken: 'token-acct_a',
      refreshToken: 'refresh-acct_a',
      expiresAt: 1,
    });
    const refresh = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });
    assert.equal(refresh.status, 200);
    assert.equal(
      refresh.body.status.accounts[0].unavailableReason?.type,
      'oauth_refresh_failed',
      '前提: 46e7d9c の分類で認証失効になっている',
    );

    const response = await ask();

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assertNoCredential503(response);

    // 503 の意味（認証情報が使えない）は status 画面が担う。文言は1文字も変えない
    // （D-72・§14.2 の整理）。
    const status = await requestJson(`${proxy.url}/internal/status`);
    const output = renderStatus(status.body, { columns: 200 });
    assert.match(output, /reason: login expired .* - run: claude-rotator login --id acct_a/);
    assert.match(output, /needs login/);
    assert.doesNotMatch(output, /oauth_refresh_failed|OAuth token refresh failed/);
  });

  it('㉔(iii): ends a pinned session at 529 while its bound account sits in the credential refresh cooldown', async () => {
    const { ask, accountManager } = await startTerminal();
    assert.equal((await ask()).status, 200);

    accountManager.markCredentialRefreshRateLimited('acct_a', 120);
    const response = await ask();

    assert.equal(response.status, 529);
    assert.equal(response.body.error.type, 'overloaded_error');
    assertNoCredential503(response);
    assert.equal(
      response.headers['retry-after'],
      undefined,
      '写像した終端は他の6系統と同じ形（Retry-After を新たに足さない）',
    );
  });

  it('㉔: escalates the credential terminal to 403 once the GPT pool is known unusable too', async () => {
    const bridge = await startUnusableBridge();
    const { ask, accountManager, proxy } = await startTerminal({ bridgeUrl: bridge.url });
    assert.equal((await ask()).status, 200);
    const warm = await requestJson(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-astra' }),
      headers: { 'content-type': 'application/json' },
      timeoutMs: 3_000,
    });
    assert.equal(warm.status, 529, '前提: bridge の 529 は素通しされ (pool) が学習される');

    accountManager.markError('acct_a', 'authentication_error', 'OAuth token rejected');
    const response = await ask();

    assert.equal(response.status, 403, '両プール枯渇なら 403（I-6）');
    assert.equal(response.body.error.type, 'permission_error');
    assert.match(response.body.error.message, /^All Claude accounts and the Codex pool are unavailable\./);
    assertNoCredential503(response);
  });

  it('㉔: keeps the 503 and its Retry-After when nothing maps the terminal (§14.4・案イ)', async () => {
    const { ask, accountManager } = await startTerminal({ degradeMapping: null });
    assert.equal((await ask()).status, 200);

    accountManager.markCredentialRefreshRateLimited('acct_a', 120);
    const response = await ask();

    assert.equal(response.status, 503, '写像しないと決まったときだけ 503 を返す');
    assert.equal(response.body.error.type, 'api_error');
    assert.equal(response.body.error.message, 'No usable OAuth credential is currently available.');
    const retryAfter = Number.parseInt(response.headers['retry-after'], 10);
    assert.ok(retryAfter >= 1 && retryAfter <= 120, `unexpected Retry-After: ${retryAfter}`);
  });

  it('㉔: takes the same terminal for a keyless request (sessionAffinity 未記載)', async () => {
    const { ask, accountManager } = await startTerminal({ sessionAffinity: null });
    assert.equal((await ask({ sid: null })).status, 200);

    accountManager.markError('acct_a', 'authentication_error', 'OAuth token rejected');
    const response = await ask({ sid: null });

    assert.equal(response.status, 529, '終端は1本にする（鍵の有無で分けない）');
    assert.equal(response.body.error.type, 'overloaded_error');
    assertNoCredential503(response);
  });
});

// ---------------------------------------------------------------------------
// R-S10: 再バインドの猶予（設計書 §4.3.1・D-60-2・D-62-2・D-63 C4）。
//
// 押さえるのは2点である。
//   ⑰ 回復見込みが `rebindGraceMs` 以内の共通枠枯渇では再バインドしない——選択の直後・
//      資格情報の解決の前に有界待機を挟み、**同じ口座へ1回だけ**送る。回復見込みが
//      取得できない／`rebindGraceMs` より先／`rebindGraceMs:0` のときは待たずに即再バインド。
//   ⑲ 待機中にクライアントが切断したら待たずに抜け、上流へ1回も送らない。
//
// どちらも「待機中に `res` へ1バイトも書かれていない」ことを直接固定する——猶予は上流へ
// 送る前の待機なので、「応答が始まった後に送り直さない」は位置によって構造的に守られる。
// `attemptedAccountIds` に同じ口座が2回入らないことは、上流が受け取った要求の本数
// （猶予の周は1本だけ）と、重複ガードの終端（429/529）ではなく 200 が返ることで見る。
// ---------------------------------------------------------------------------
describe('session affinity rebind grace (R-S10)', () => {
  function eventLines(logLines, kind) {
    return logLines.filter(line => line.includes(` ${kind} `));
  }

  async function waitFor(predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!predicate() && Date.now() - startedAt < timeoutMs) await sleep(5);
    return predicate();
  }

  function resetAfter(ms) {
    return new Date(Date.now() + ms).toISOString();
  }

  // 共通枠（unified 5h）を閾値まで埋める。`resetsAt` が null なら回復見込みは取得不能。
  function exhaustCommonQuota(accountManager, accountId, resetsAt) {
    accountManager.applyUsage(accountId, {
      five_hour: { utilization: 1, resets_at: resetsAt },
    });
  }

  /**
   * proxy が応答へ書いた量を要求ごとに数える（`x-test-round` ヘッダで分ける）。
   *
   * `createProxyServer` が返す `http.Server` へ2本目の 'request' 監視を足すだけで、
   * 本体のハンドラは1行も変わらない。ハンドラは非同期で、最初の `await` で必ず制御を
   * 返すため、この監視は最初の書き込みより先に `res` を包める。
   */
  function watchResponseBytes(server) {
    const bytes = new Map();
    const size = chunk => (
      typeof chunk === 'string' || Buffer.isBuffer(chunk) ? Buffer.byteLength(chunk) : 0
    );
    server.on('request', (req, res) => {
      const round = req.headers['x-test-round'] || '-';
      if (!bytes.has(round)) bytes.set(round, 0);
      const add = value => bytes.set(round, bytes.get(round) + value);
      const original = { writeHead: res.writeHead, write: res.write, end: res.end };
      // ヘッダだけでも「応答が始まった」ので 1 と数える（本文 0 バイトの終端も同じ）。
      res.writeHead = (...args) => { add(1); return original.writeHead.apply(res, args); };
      res.write = (chunk, ...rest) => {
        add(size(chunk));
        return original.write.call(res, chunk, ...rest);
      };
      res.end = (chunk, ...rest) => {
        add(Math.max(1, size(chunk)));
        return original.end.call(res, chunk, ...rest);
      };
    });
    return round => bytes.get(round) || 0;
  }

  async function startGrace({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on' },
    upstream: upstreamHandler = null,
  } = {}) {
    const logLines = [];
    const seen = [];
    const rounds = [];
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      rounds.push(req.headers['x-test-round'] || '-');
      if (upstreamHandler && upstreamHandler({ req, res, seen, rounds }) === true) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, type: 'oauth' })),
      logger,
    });
    const server = createProxyServer({
      accountManager,
      secretStore,
      logger,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        ...(sessionAffinity ? { sessionAffinity } : {}),
      },
    });
    const bytesFor = watchResponseBytes(server);
    const proxy = await listen(server);
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, round = '-', model = 'sonnet' } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: {
          ...(sid ? { 'x-claude-code-session-id': sid } : {}),
          'x-test-round': round,
        },
      },
    );
    return {
      proxy, upstream, seen, rounds, secretStore, accountManager, logLines, logger, ask, bytesFor,
    };
  }

  it('⑰: waits out a recovery inside the grace and sends once to the same account', async () => {
    let bytesAtUpstream = null;
    let bytesFor = null;
    const started = await startGrace({
      sessionAffinity: { mode: 'on', rebindGraceMs: 5_000 },
      upstream: ({ req }) => {
        if (req.headers['x-test-round'] === '2') bytesAtUpstream = bytesFor('2');
        return false;
      },
    });
    const { ask, seen, rounds, logLines, accountManager } = started;
    bytesFor = started.bytesFor;

    assert.equal((await ask({ sid: 'session-one', round: '1' })).status, 200);
    // 結び付け先の共通枠が枯れるが、回復見込みは猶予（5,000ms）の内側にある。
    exhaustCommonQuota(accountManager, 'acct_a', resetAfter(250));

    const startedAt = Date.now();
    const response = await ask({ sid: 'session-one', round: '2' });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.status, 200, '猶予の後に同じ口座で完走する');
    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a'], '再バインドしない');
    assert.deepEqual(
      rounds.filter(round => round === '2'),
      ['2'],
      '同じ口座へ送るのは1回だけ（attemptedAccountIds に2回入らない）',
    );
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), [], 'affinity_switch は0行');

    const defers = eventLines(logLines, 'affinity_defer');
    assert.equal(defers.length, 1, 'affinity_defer は1行');
    assert.match(
      defers[0],
      new RegExp(` affinity_defer sid=${sidHash('session-one')} account=acct_a reason=quota_grace waitMs=(\\d+)$`),
    );
    const waitMs = Number(/ waitMs=(\d+)$/.exec(defers[0])[1]);
    assert.ok(waitMs > 0 && waitMs <= 5_000, `unexpected waitMs: ${waitMs}`);
    assert.ok(elapsedMs >= 50, `待たずに送っている: ${elapsedMs}ms`);
    assert.equal(bytesAtUpstream, 0, '待機中に res へ1バイトも書かれていない');
  });

  it('⑰: rebinds at once when the recovery estimate cannot be read', async () => {
    const { ask, seen, logLines, accountManager } = await startGrace({
      sessionAffinity: { mode: 'on', rebindGraceMs: 5_000 },
    });

    assert.equal((await ask({ sid: 'session-one', round: '1' })).status, 200);
    exhaustCommonQuota(accountManager, 'acct_a', null);

    const startedAt = Date.now();
    assert.equal((await ask({ sid: 'session-one', round: '2' })).status, 200);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(seen.at(-1), 'Bearer token-acct_b', '待たずに付け替える');
    assert.deepEqual(eventLines(logLines, 'affinity_defer'), [], '猶予の経路へ入らない');
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(switches[0], / from=acct_a to=acct_b reason=common_exhausted family=other switches=1$/);
    assert.ok(elapsedMs < 250, `待ってしまっている: ${elapsedMs}ms`);
  });

  it('⑰: rebinds at once when the recovery estimate is beyond the grace', async () => {
    const { ask, seen, logLines, accountManager } = await startGrace({
      sessionAffinity: { mode: 'on', rebindGraceMs: 60_000 },
    });

    assert.equal((await ask({ sid: 'session-one', round: '1' })).status, 200);
    exhaustCommonQuota(accountManager, 'acct_a', resetAfter(3_600_000));

    assert.equal((await ask({ sid: 'session-one', round: '2' })).status, 200);

    assert.equal(seen.at(-1), 'Bearer token-acct_b', '猶予より先の回復は待たない');
    assert.deepEqual(eventLines(logLines, 'affinity_defer'), [], '猶予の経路へ入らない');
    assert.equal(eventLines(logLines, 'affinity_switch').length, 1);
  });

  it('⑰: rebindGraceMs:0 never enters the grace path', async () => {
    const { ask, seen, logLines, accountManager } = await startGrace({
      sessionAffinity: { mode: 'on', rebindGraceMs: 0 },
    });

    assert.equal((await ask({ sid: 'session-one', round: '1' })).status, 200);
    // 既定（60,000ms）の猶予なら確実に待つ回復見込みでも、0 なら1度も待たない。
    exhaustCommonQuota(accountManager, 'acct_a', resetAfter(250));

    const startedAt = Date.now();
    assert.equal((await ask({ sid: 'session-one', round: '2' })).status, 200);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(seen.at(-1), 'Bearer token-acct_b', 'v1.1 と同じ挙動へ戻る');
    assert.deepEqual(eventLines(logLines, 'affinity_defer'), [], '猶予の経路へ入らない');
    assert.equal(eventLines(logLines, 'affinity_switch').length, 1);
    assert.ok(elapsedMs < 250, `待ってしまっている: ${elapsedMs}ms`);
  });

  it('⑲: a client disconnect during the grace wait sends nothing upstream', async () => {
    const { proxy, ask, seen, logLines, accountManager, bytesFor } = await startGrace({
      sessionAffinity: { mode: 'on', rebindGraceMs: 5_000 },
    });

    assert.equal((await ask({ sid: 'session-one', round: '1' })).status, 200);
    exhaustCommonQuota(accountManager, 'acct_a', resetAfter(400));

    const target = new URL(proxy.url);
    const pending = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-claude-code-session-id': 'session-one',
        'x-test-round': '2',
      },
    });
    pending.on('error', () => {});
    cleanupAfterTest(async () => pending.destroy());
    pending.end(JSON.stringify({ model: 'sonnet' }));

    assert.ok(
      await waitFor(() => eventLines(logLines, 'affinity_defer').length === 1),
      '猶予の待機に入る',
    );
    assert.equal(seen.length, 1, '待機中はまだ上流へ送っていない');
    pending.destroy();

    // 切断で待機を抜けたら、そのまま要求を終える（回復見込みの時刻を過ぎても送らない）。
    assert.equal(await waitFor(() => seen.length > 1, 600), false, '上流へ1回も送らない');
    assert.equal(bytesFor('2'), 0, '待機中に res へ1バイトも書かれていない');
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), [], 'バインドも変えない');
  });
});

// ---------------------------------------------------------------------------
// 永続化・復元・reload の結線（R-S11 / 設計書 v1.5 §8・§8.1・§6・F1/F4/F5/F10）
//
// 固定するのは次の3群である。
//   (a) 保存: 既存の runtime-state.json へ相乗りし、新しいファイルは作らない。
//       `mode:"off"`／`persist:false` では節そのものを書かない。保存 JSON に秘密・
//       口座メール・生のセッション UUID が1つも無く、世代番号 `gen` も保存しない。
//   (b) 復元: §8 の破棄条件①〜⑥（version／未来の savedAt／未知口座／TTL 超過／容量／
//       資格情報の変化）と F1（壊れた保存データでも起動する）・F4（時計の逆行）。
//   (c) reload: 設定の再正規化 → applySettings → U17 の通知 →
//       evictAccounts(credential_changed) → prune(account_removed)（D-155 ①〜④）。
//
// 時刻は AccountManager へ注入したクロックから読む（SessionAffinity も同じ時計を使う）
// ので、TTL・savedAt・ageMs はすべて決定的である。
// ---------------------------------------------------------------------------

describe('session affinity persistence and reload (R-S11)', () => {
  // 生のセッション UUID が保存 JSON・ログへ出ないことを見るための既知の値。
  const RAW_SESSION_ID = 'c7e1a904-5b6d-4f28-9a31-2e8b70d4f6c1';
  const OTHER_SESSION_ID = 'd18f2b35-6c7e-4a19-b042-3f9c81e5a7d2';
  const CLOCK_START_MS = Date.parse('2026-09-16T09:00:00.000Z');
  // 追記が1つも無い現行の proxy 行（`mode:"off"` へ戻したあとで守る形）。
  const LEGACY_PROXY_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z proxy account=\S+ method=\S+ path=\S+ status=\S+ durationMs=\d+ outcome=[a-z-]+(?: requestId=\S+)?(?: errorType=\S+)?$/;

  function eventLines(logLines, kind) {
    return logLines.filter(line => line.includes(` ${kind} `));
  }

  function proxyLines(logLines) {
    return logLines.filter(line => line.includes(' proxy account='));
  }

  function futureReset() {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  async function waitFor(predicate, timeoutMs = 2000) {
    const startedAt = Date.now();
    while (!predicate() && Date.now() - startedAt < timeoutMs) await sleep(5);
    return predicate();
  }

  async function startPersisting({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on' },
    savedState = null,
    credentialChangedAccountIds = null,
    reloadable = false,
    stateWriter = null,
    sessionAffinityPersistIntervalMs = null,
    upstream: upstreamHandler = null,
  } = {}) {
    const logLines = [];
    const seen = [];
    const persisted = [];
    const clock = { ms: CLOCK_START_MS };
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      if (upstreamHandler && upstreamHandler({ req, res, seen }) === true) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      // 口座のメールアドレスは台帳にだけ載る合成値。保存 JSON には出てはならない。
      accounts: accounts.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      logger,
      now: () => clock.ms,
    });
    // reload で差し替える設定はここに置き、両 reloader が同じものを読む。
    const holder = {
      accounts: accounts.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      sessionAffinity,
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger,
      savedState,
      ...(credentialChangedAccountIds ? { credentialChangedAccountIds } : {}),
      ...(sessionAffinityPersistIntervalMs == null
        ? {}
        : { sessionAffinityPersistIntervalMs }),
      ...(reloadable
        ? {
          reloadAccounts: async () => holder.accounts,
          reloadSessionAffinity: async () => holder.sessionAffinity,
        }
        : {}),
      stateWriter: stateWriter || (async state => { persisted.push(state); }),
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        ...(sessionAffinity ? { sessionAffinity } : {}),
        // reload で `mode:"off"` へ戻したとき proxy 行が現行の形へ帰ることを見る describe。
        // キャッシュ観測（既定 on・U-3）は同じ行のさらに末尾へ足すので、ここは明示的に
        // 切って affinity の追記だけを見る（観測側の形は describe('cache observability')）。
        observability: { requestLog: { enabled: false } },
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, model = 'sonnet' } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: { ...(sid ? { 'x-claude-code-session-id': sid } : {}) },
      },
    );
    const reload = () => requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    return {
      proxy, upstream, seen, persisted, secretStore, accountManager,
      logLines, logger, ask, reload, holder, clock,
    };
  }

  // 保存済みの表を手で組む（復元の破棄条件を1つずつ狙うため）。
  function savedTable(entries, { version = 1, savedAtMs = CLOCK_START_MS - 1_000 } = {}) {
    return {
      version: 1,
      savedAt: new Date(savedAtMs).toISOString(),
      currentAccount: 'acct_a',
      accounts: [],
      sessionAffinity: {
        version,
        savedAt: new Date(savedAtMs).toISOString(),
        entries,
      },
    };
  }

  function entryFor(sid, account, { t = CLOCK_START_MS - 1_000, s = 0, f = null } = {}) {
    return { k: sidHash(sid), a: account, ...(f ? { f } : {}), t, s };
  }

  // -- (a) 保存 ------------------------------------------------------------

  it('rides along the existing runtime state instead of writing a second file', async () => {
    const { ask, persisted } = await startPersisting();

    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200);

    const saved = persisted.at(-1);
    assert.ok(saved.accounts, '口座台帳の節はそのまま');
    assert.equal(saved.sessionAffinity.version, 1);
    assert.equal(saved.sessionAffinity.entries.length, 1);
    assert.equal(saved.sessionAffinity.entries[0].a, 'acct_a');
    assert.equal(saved.sessionAffinity.entries[0].k, sidHash(RAW_SESSION_ID));
  });

  it('keeps secrets, account mail addresses, the raw session id and gen out of the saved state', async () => {
    const { ask, persisted } = await startPersisting();

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });

    const saved = persisted.at(-1);
    const text = JSON.stringify(saved);
    for (const forbidden of [
      RAW_SESSION_ID,
      OTHER_SESSION_ID,
      'token-acct_a',
      'refresh-acct_a',
      'acct_a@example.com',
      'acct_b@example.com',
    ]) {
      assert.equal(text.includes(forbidden), false, `保存 JSON に ${forbidden} が入っている`);
    }
    for (const entry of saved.sessionAffinity.entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['a', 'k', 's', 't'],
        '保存するのは ①ハッシュ ②口座ラベル ③副バインド ④epoch ms ⑤切替回数だけ',
      );
      assert.equal('gen' in entry, false, '世代番号は保存しない（D-60-1）');
      assert.match(entry.k, /^[0-9a-f]{12}$/);
    }
  });

  it('writes no sessionAffinity section at all while the mode is off', async () => {
    const { ask, persisted, accountManager } = await startPersisting({ sessionAffinity: null });

    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200);

    const saved = persisted.at(-1);
    assert.equal('sessionAffinity' in saved, false);
    // 時計を固定しているので savedAt まで含めてバイト同一を比べられる。
    assert.equal(JSON.stringify(saved), JSON.stringify(accountManager.exportState()));
  });

  it('keeps the table in memory only when persist is false', async () => {
    const { ask, persisted } = await startPersisting({
      sessionAffinity: { mode: 'on', persist: false },
    });

    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200);

    assert.equal('sessionAffinity' in persisted.at(-1), false);
  });

  it('does not read a saved table back when persist is false', async () => {
    const { ask, seen, logLines } = await startPersisting({
      sessionAffinity: { mode: 'on', persist: false },
      savedState: savedTable([entryFor(RAW_SESSION_ID, 'acct_b')]),
    });

    await ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(seen, ['Bearer token-acct_a'], '復元しないので新規割当になる');
    assert.deepEqual(eventLines(logLines, 'affinity_restore'), []);
  });

  it('flushes a binding into the state within the persist interval while a long response is still open', async () => {
    let release = null;
    const held = new Promise(resolve => { release = resolve; });
    const { ask, persisted } = await startPersisting({
      sessionAffinityPersistIntervalMs: 25,
      upstream: ({ res }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        held.then(() => res.end(JSON.stringify({ ok: true })));
        return true;
      },
    });

    const pending = ask({ sid: RAW_SESSION_ID });
    const flushed = await waitFor(() => persisted.some(
      state => state.sessionAffinity?.entries?.length === 1,
    ));
    release();
    await pending;

    assert.equal(flushed, true, 'バインドは応答の完了を待たずに保存される（5秒上限の合流）');
  });

  it('keeps serving and logs one warning when the state write fails (F10)', async () => {
    const { ask, logLines } = await startPersisting({
      stateWriter: async () => { throw new Error('disk full'); },
    });

    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200, 'HTTP 処理は続く');

    assert.ok(
      await waitFor(() => logLines.some(line => line.includes('state persist failed: disk full'))),
      '警告が1行出る',
    );
  });

  // -- (b) 復元 ------------------------------------------------------------

  it('⑩: a restart puts the same session back on the same account', async () => {
    const first = await startPersisting();
    await first.ask({ sid: RAW_SESSION_ID });
    await first.ask({ sid: OTHER_SESSION_ID });
    const saved = first.persisted.at(-1);
    assert.deepEqual(first.seen, ['Bearer token-acct_a', 'Bearer token-acct_b']);

    const second = await startPersisting({ savedState: saved });
    // 空表から始めれば acct_a へ載る順番の要求を、わざと先に投げる。
    await second.ask({ sid: OTHER_SESSION_ID });
    await second.ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(second.seen, ['Bearer token-acct_b', 'Bearer token-acct_a']);
    assert.deepEqual(eventLines(second.logLines, 'affinity_bind'), [], '新規バインドは1件も無い');
    assert.deepEqual(
      proxyLines(second.logLines).map(line => line.split(' aff=')[1].split(' ')[0]),
      ['bound', 'bound'],
    );
  });

  it('F1: starts with an empty table and logs one reason code when the saved table is unreadable', async () => {
    const { ask, seen, logLines } = await startPersisting({
      savedState: { version: 1, accounts: [], sessionAffinity: 'not-a-table' },
    });

    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200, '起動も応答も成功させる');

    const restore = eventLines(logLines, 'affinity_restore');
    assert.equal(restore.length, 1);
    assert.match(restore[0], / affinity_restore skipped=malformed$/);
    assert.equal(restore[0].includes('not-a-table'), false, '本文はログへ出さない');
    assert.deepEqual(seen, ['Bearer token-acct_a']);
  });

  it('①: drops the whole table when the saved version does not match', async () => {
    const { logLines } = await startPersisting({
      savedState: savedTable([entryFor(RAW_SESSION_ID, 'acct_b')], { version: 99 }),
    });

    assert.match(eventLines(logLines, 'affinity_restore')[0], / affinity_restore skipped=version$/);
  });

  it('②: drops the whole table when savedAt is in the future', async () => {
    const { logLines } = await startPersisting({
      savedState: savedTable(
        [entryFor(RAW_SESSION_ID, 'acct_b')],
        { savedAtMs: CLOCK_START_MS + 60_000 },
      ),
    });

    assert.match(eventLines(logLines, 'affinity_restore')[0], / affinity_restore skipped=saved-at$/);
  });

  it('logs nothing when the saved state simply has no table yet', async () => {
    const { ask, logLines } = await startPersisting({
      savedState: { version: 1, savedAt: new Date(CLOCK_START_MS).toISOString(), accounts: [] },
    });

    await ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(eventLines(logLines, 'affinity_restore'), [], '節が無いのは「壊れている」ではない');
  });

  it('③: drops the rows of accounts the ledger no longer has', async () => {
    const { ask, seen, logLines } = await startPersisting({
      savedState: savedTable([
        entryFor(RAW_SESSION_ID, 'acct_gone'),
        entryFor(OTHER_SESSION_ID, 'acct_b'),
      ]),
    });

    await ask({ sid: OTHER_SESSION_ID });
    await ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(seen, ['Bearer token-acct_b', 'Bearer token-acct_a']);
    assert.equal(eventLines(logLines, 'affinity_bind').length, 1, '消えた口座の行だけ作り直す');
  });

  it('④/F5: drops the rows whose last visit is older than the idle ttl', async () => {
    const { ask, logLines } = await startPersisting({
      sessionAffinity: { mode: 'on', idleTtlMs: 60_000 },
      savedState: savedTable([
        entryFor(RAW_SESSION_ID, 'acct_b', { t: CLOCK_START_MS - 120_000 }),
        entryFor(OTHER_SESSION_ID, 'acct_b', { t: CLOCK_START_MS - 30_000 }),
      ]),
    });

    await ask({ sid: OTHER_SESSION_ID });
    await ask({ sid: RAW_SESSION_ID });

    assert.equal(eventLines(logLines, 'affinity_bind').length, 1, 'TTL 超過の1件だけ作り直す');
  });

  it('⑤: keeps only the most recent rows when the saved table exceeds maxSessions', async () => {
    const { ask, seen, logLines } = await startPersisting({
      sessionAffinity: { mode: 'on', maxSessions: 1 },
      savedState: savedTable([
        entryFor(RAW_SESSION_ID, 'acct_b', { t: CLOCK_START_MS - 300_000 }),
        entryFor(OTHER_SESSION_ID, 'acct_b', { t: CLOCK_START_MS - 1_000 }),
      ]),
    });

    await ask({ sid: OTHER_SESSION_ID });

    assert.deepEqual(seen, ['Bearer token-acct_b'], '新しいほうが残る');
    assert.deepEqual(eventLines(logLines, 'affinity_bind'), []);
  });

  it('⑥: drops the rows of accounts whose credential identity changed before the restart', async () => {
    const { ask, seen, logLines } = await startPersisting({
      savedState: savedTable([
        entryFor(RAW_SESSION_ID, 'acct_b'),
        entryFor(OTHER_SESSION_ID, 'acct_a'),
      ]),
      credentialChangedAccountIds: ['acct_b'],
    });

    await ask({ sid: OTHER_SESSION_ID });
    await ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_b']);
    assert.equal(eventLines(logLines, 'affinity_bind').length, 1, '資格情報が変わった口座の行だけ作り直す');
  });

  it('F4: keeps a row whose last visit is ahead of the clock instead of dropping it', async () => {
    const { ask, seen, logLines } = await startPersisting({
      sessionAffinity: { mode: 'on', idleTtlMs: 60_000 },
      savedState: savedTable([
        entryFor(RAW_SESSION_ID, 'acct_b', { t: CLOCK_START_MS + 3_600_000 }),
      ]),
    });

    await ask({ sid: RAW_SESSION_ID });

    assert.deepEqual(seen, ['Bearer token-acct_b'], '時計の逆行でエントリを捨てない');
    assert.deepEqual(eventLines(logLines, 'affinity_bind'), []);
  });

  // -- (c) reload ----------------------------------------------------------

  it('⑨: a reload that removes one account rebinds only that account\'s sessions', async () => {
    const { ask, seen, reload, holder, logLines } = await startPersisting({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    holder.accounts = holder.accounts.filter(account => account.id !== 'acct_b');

    assert.equal((await reload()).status, 200);
    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });

    const evicted = eventLines(logLines, 'affinity_evict');
    assert.equal(evicted.length, 1);
    assert.match(evicted[0], / account=acct_b reason=account_removed /);
    assert.equal(evicted[0].includes(sidHash(OTHER_SESSION_ID)), true);
    assert.deepEqual(seen, [
      'Bearer token-acct_a',
      'Bearer token-acct_b',
      'Bearer token-acct_a',
      'Bearer token-acct_a',
    ]);
  });

  it('⑱: a reload that changes a credential drops the home binding and its family sub-binding', async () => {
    const { ask, seen, reload, holder, accountManager, logLines } = await startPersisting({
      reloadable: true,
    });

    await ask({ sid: RAW_SESSION_ID });
    accountManager.applyUsage('acct_a', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    await ask({ sid: RAW_SESSION_ID, model: 'claude-fable-5' });
    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_b'], 'Fable は副バインドへ');

    holder.accounts = holder.accounts.map(account => (account.id === 'acct_a'
      ? { ...account, accountUuid: 'uuid-acct-a-2' }
      : account));
    assert.equal((await reload()).status, 200);
    await ask({ sid: RAW_SESSION_ID, model: 'claude-fable-5' });

    const evicted = eventLines(logLines, 'affinity_evict');
    assert.equal(evicted.length, 1, '基本バインドごと落ちるので行は1つ');
    assert.match(evicted[0], / account=acct_a reason=credential_changed /);
    assert.equal(
      seen.at(-1),
      'Bearer token-acct_a',
      '副バインドも一緒に消えているので acct_b へは戻らない',
    );
    assert.equal(eventLines(logLines, 'affinity_bind').length, 2, '次の要求で作り直す');
  });

  it('⑱: a credential change on the sub-binding account drops only the sub-binding', async () => {
    const { ask, seen, reload, holder, accountManager, logLines } = await startPersisting({
      reloadable: true,
    });

    await ask({ sid: RAW_SESSION_ID });
    accountManager.applyUsage('acct_a', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    await ask({ sid: RAW_SESSION_ID, model: 'claude-fable-5' });

    holder.accounts = holder.accounts.map(account => (account.id === 'acct_b'
      ? { ...account, accountUuid: 'uuid-acct-b-2' }
      : account));
    assert.equal((await reload()).status, 200);
    await ask({ sid: RAW_SESSION_ID });

    const evicted = eventLines(logLines, 'affinity_evict');
    assert.equal(evicted.length, 1);
    assert.match(evicted[0], / account=acct_b reason=credential_changed /);
    assert.equal(seen.at(-1), 'Bearer token-acct_a', '基本バインドは残る');
    assert.equal(eventLines(logLines, 'affinity_bind').length, 1, '新規バインドは最初の1件だけ');
  });

  it('FU-65: no account is handled as both credential_changed and account_removed', async () => {
    const { ask, reload, holder, logLines } = await startPersisting({
      reloadable: true,
      accounts: ['acct_a', 'acct_b', 'acct_c'],
    });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    await ask({ sid: 'e2f9c108-7a4b-4d36-91c5-6b0d24e8f3a7' });
    holder.accounts = holder.accounts
      .filter(account => account.id !== 'acct_b')
      .map(account => (account.id === 'acct_c'
        ? { ...account, accountUuid: 'uuid-acct-c-2' }
        : account));

    assert.equal((await reload()).status, 200);

    const evicted = eventLines(logLines, 'affinity_evict');
    const byAccount = new Map();
    for (const line of evicted) {
      const account = line.match(/ account=(\S+) /)[1];
      const reason = line.match(/ reason=(\S+) /)[1];
      byAccount.set(account, [...(byAccount.get(account) ?? []), reason]);
    }
    assert.deepEqual([...byAccount.keys()].sort(), ['acct_b', 'acct_c']);
    assert.deepEqual(byAccount.get('acct_b'), ['account_removed'], '消えた口座は prune 側だけ');
    assert.deepEqual(byAccount.get('acct_c'), ['credential_changed'], '残った口座は evictAccounts 側だけ');
    assert.equal(evicted.length, 2, '同じ口座が両方で処理されない');
  });

  it('D-155 ①②: a reload re-normalizes the section instead of keeping the startup values', async () => {
    const { ask, reload, holder, logLines } = await startPersisting({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    // 0 は 1 へクランプされる。再正規化していなければ maxSessions は起動時の 10,000 のまま。
    holder.sessionAffinity = { mode: 'on', maxSessions: 0 };

    assert.equal((await reload()).status, 200);

    const evicted = eventLines(logLines, 'affinity_evict');
    assert.equal(evicted.length, 1);
    assert.match(evicted[0], / reason=capacity /);
  });

  it('D-155 ③: a reload records the U17 config line again', async () => {
    const { reload, holder, logLines } = await startPersisting({ reloadable: true });
    const atStartup = eventLines(logLines, 'affinity_config');
    assert.equal(atStartup.length, 1);

    holder.sessionAffinity = { mode: 'observe' };
    assert.equal((await reload()).status, 200);

    const after = logLines.filter(line => line.includes(' affinity_config '));
    assert.equal(after.length, 2);
    assert.match(after[1], / affinity_config mode=observe switchThreshold=\S+$/);
  });

  it('FU-69: a reload to off logs affinity_disabled once and returns the proxy line to its current shape', async () => {
    const { ask, reload, holder, logLines, persisted } = await startPersisting({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    holder.sessionAffinity = undefined;

    assert.equal((await reload()).status, 200);
    assert.equal((await ask({ sid: RAW_SESSION_ID })).status, 200);

    assert.deepEqual(
      eventLines(logLines, 'affinity_disabled').map(line => line.split(' affinity_disabled ')[1]),
      ['sessions=2'],
    );
    assert.match(proxyLines(logLines).at(-1), LEGACY_PROXY_LINE);
    assert.equal('sessionAffinity' in persisted.at(-1), false, '無効化のあとは節を書かない');
  });

  it('a reload from off to on starts from an empty table and begins binding', async () => {
    const { ask, seen, reload, holder, logLines, persisted } = await startPersisting({
      reloadable: true,
      sessionAffinity: null,
    });

    await ask({ sid: RAW_SESSION_ID });
    assert.match(proxyLines(logLines).at(-1), LEGACY_PROXY_LINE);
    holder.sessionAffinity = { mode: 'on' };

    assert.equal((await reload()).status, 200);
    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: RAW_SESSION_ID });

    assert.equal(eventLines(logLines, 'affinity_bind').length, 1);
    assert.deepEqual(seen.slice(1), ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.equal(persisted.at(-1).sessionAffinity.entries.length, 1);
    assert.equal(
      logLines.filter(line => line.includes(' affinity_config ')).length,
      1,
      '起動時は off なので1行も出ず、reload で初めて出る',
    );
  });

  it('persists the table once when a reload changes it', async () => {
    const { ask, reload, holder, persisted } = await startPersisting({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    const beforeReload = persisted.length;
    holder.accounts = holder.accounts.filter(account => account.id !== 'acct_b');

    assert.equal((await reload()).status, 200);

    assert.ok(persisted.length > beforeReload, 'reload で表が変わったら保存する');
    assert.equal(persisted.at(-1).sessionAffinity.entries.length, 1);
  });
});

// ---------------------------------------------------------------------------
// status 出力への sessionAffinity 節と events の条件付き永続化（R-S12・設計書 §7.3）
//
// 節は **`mode:"off"` ではキー自体を出さない**。off の `/internal/status` の JSON は
// 現行とバイト同一であり、`claude-rotator status` の出力も変わらない（R7）。
// 組み立ては結線側の1箇所（`sessionAffinityStatusSection`）だけで行い、status JSON を返す
// すべての経路が同じ節を返す。口座台帳（AccountManager）は sticky の表を知らない（D-182）
// ——台帳が受け取るのは「events を履歴として扱うか」の真偽値1つだけである。
//
// sid 付与率は要求単位（鍵を抽出できた要求 ÷ この proxy が転送した要求）で数える。
// 表の `summary()` には要求の数が無いので（FU-55）、結線側で数える。
// ---------------------------------------------------------------------------

describe('session affinity status section and event history (R-S12)', () => {
  const RAW_SESSION_ID = 'a41f77c2-0b93-4e58-9d17-5c3e8a1b2049';
  const OTHER_SESSION_ID = 'b52a88d3-1ca4-4f69-8e28-6d4f9b2c3150';
  const CLOCK_START_MS = Date.parse('2026-09-16T09:00:00.000Z');

  function futureReset() {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  async function startStatus({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on' },
    reloadable = false,
  } = {}) {
    const logLines = [];
    const persisted = [];
    const clock = { ms: CLOCK_START_MS };
    const upstream = await listen(http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      logger: line => logLines.push(line),
      now: () => clock.ms,
      // 結線側が渡す真偽値。off では偽なので現行と同一（D-56-6）。
      eventHistory: (sessionAffinity?.mode ?? 'off') !== 'off',
    });
    const holder = {
      accounts: accounts.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
      sessionAffinity,
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger: line => logLines.push(line),
      // usage の取得は外へ出ない偽物に差し替える（/internal/refresh-usage の経路用）。
      usageFetcher: async () => ({}),
      ...(reloadable
        ? {
          reloadAccounts: async () => holder.accounts,
          reloadSessionAffinity: async () => holder.sessionAffinity,
        }
        : {}),
      stateWriter: async state => { persisted.push(state); },
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        ...(sessionAffinity ? { sessionAffinity } : {}),
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, model = 'sonnet' } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: { ...(sid ? { 'x-claude-code-session-id': sid } : {}) },
      },
    );
    const status = () => requestJson(`${proxy.url}/internal/status`);
    const reload = () => requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    return {
      proxy, accountManager, secretStore, logLines, persisted, clock, holder, ask, status, reload,
    };
  }

  it('writes no sessionAffinity key into the status JSON while the mode is off', async () => {
    const { ask, status, accountManager } = await startStatus({ sessionAffinity: null });

    await ask({ sid: RAW_SESSION_ID });
    const response = await status();

    assert.equal(response.status, 200);
    assert.equal('sessionAffinity' in response.body, false);
    // 時計を固定しているので台帳の出力とバイト単位で比べられる。
    assert.equal(response.bodyText, JSON.stringify(accountManager.getStatus()));
  });

  it('reports the mode, the session counts, the capacity and the reason breakdowns', async () => {
    const { ask, status, accountManager } = await startStatus();

    await ask({ sid: RAW_SESSION_ID });
    // acct_a の Fable 枠だけを枯らして、同じセッションに Fable 専用の副バインドを作らせる。
    accountManager.applyUsage('acct_a', {
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: futureReset() }],
    });
    await ask({ sid: RAW_SESSION_ID, model: 'claude-fable-5' });
    await ask({ sid: OTHER_SESSION_ID });

    const section = (await status()).body.sessionAffinity;

    assert.equal(section.mode, 'on');
    assert.equal(section.sessions, 2);
    assert.equal(section.capacity, 10_000);
    assert.deepEqual(section.sessionsByAccount, { acct_a: 2, acct_b: 1 });
    // 口座別の合計は総数と一致しない（系統別副バインドで1セッションが2口座に数えられる）。
    const perAccountTotal = Object.values(section.sessionsByAccount)
      .reduce((sum, count) => sum + count, 0);
    assert.equal(perAccountTotal, 3);
    assert.notEqual(perAccountTotal, section.sessions);
    assert.deepEqual(section.switchesByReason, { family_exhausted: 1 });
    assert.deepEqual(section.evictionsByReason, {});
  });

  // 設計書 v1.7 §7.3 の確定形は `{ mode, sessions, capacity, warmTtlMs, sessionsByAccount,
  // warmSessionsByAccount, switchesByReason, evictionsByReason, requests, sidRate }` である。
  // v1.6 の形に足した2つを status 側で直接押さえる——`summary()` が返していても節へ載せ
  // 忘れれば、README と設計書が約束した項目が欠ける（R-S18-FIX1 差戻し2）。
  it('reports the warm window and the warm per-account counts in the status section (v1.7 §7.3)', async () => {
    const { ask, status } = await startStatus();

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });

    const section = (await status()).body.sessionAffinity;

    assert.equal(section.warmTtlMs, 3_600_000, '既定の warm 窓（1時間）を節へ出す');
    assert.deepEqual(
      section.warmSessionsByAccount,
      { acct_a: 1, acct_b: 1 },
      'いま来たばかりの2セッションはどちらも温かい（2本目は別口座へ散る）',
    );
    // 冷えた行も表には残るので、総数側は別に読める（2つの差が冷えた本数・§7.3）。
    assert.deepEqual(section.sessionsByAccount, { acct_a: 1, acct_b: 1 });
    assert.deepEqual(Object.keys(section), [
      'mode', 'sessions', 'capacity', 'warmTtlMs', 'sessionsByAccount',
      'warmSessionsByAccount', 'switchesByReason', 'evictionsByReason', 'requests', 'sidRate',
    ], '§7.3 の確定形どおりの並び');
  });

  it('counts the sid coverage per request instead of per session', async () => {
    const { ask, status } = await startStatus();

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: RAW_SESSION_ID });
    await ask();

    const section = (await status()).body.sessionAffinity;

    assert.deepEqual(section.requests, { proxied: 3, keyed: 2 });
    assert.equal(section.sidRate, 0.6667);
    assert.equal(section.sessions, 1, '鍵の無い要求は表に載らない');
  });

  it('returns the same section from every path that answers with the status JSON', async () => {
    const { ask, status, reload, proxy } = await startStatus({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });

    const fromStatus = (await status()).body.sessionAffinity;
    const fromSwitch = (await requestJson(`${proxy.url}/internal/switch`, {
      method: 'POST',
      body: JSON.stringify({ account: 'acct_a' }),
    })).body.sessionAffinity;
    const fromReload = (await reload()).body.sessionAffinity;
    const fromPrepareResume = (await requestJson(`${proxy.url}/internal/prepare-resume`, {
      method: 'POST',
      body: JSON.stringify({}),
    })).body.status.sessionAffinity;
    const fromRefreshUsage = (await requestJson(`${proxy.url}/internal/refresh-usage`, {
      method: 'POST',
    })).body.status.sessionAffinity;

    for (const [label, section] of [
      ['switch', fromSwitch],
      ['reload', fromReload],
      ['prepare-resume', fromPrepareResume],
      ['refresh-usage', fromRefreshUsage],
    ]) {
      assert.deepEqual(section, fromStatus, `${label} の節が /internal/status と違う`);
    }
    assert.equal(fromStatus.sessions, 1);
  });

  it('drops the section from every path once a reload turns the mode off', async () => {
    const { ask, status, reload, holder, proxy } = await startStatus({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    holder.sessionAffinity = undefined;

    const fromReload = (await reload()).body;
    const fromStatus = (await status()).body;
    const fromSwitch = (await requestJson(`${proxy.url}/internal/switch`, {
      method: 'POST',
      body: JSON.stringify({ account: 'acct_a' }),
    })).body;

    for (const [label, body] of [
      ['reload', fromReload],
      ['status', fromStatus],
      ['switch', fromSwitch],
    ]) {
      assert.equal('sessionAffinity' in body, false, `${label} が off なのに節を返した`);
    }
  });

  it('FU-97: persists the table when a reload only changes the settings', async () => {
    const { ask, reload, holder, persisted } = await startStatus({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    await ask({ sid: OTHER_SESSION_ID });
    const beforeShrink = persisted.length;
    // 口座は1つも変わらない。容量だけを 1 へ縮めるので、表から1件退避する。
    holder.sessionAffinity = { mode: 'on', maxSessions: 1 };

    assert.equal((await reload()).status, 200);

    assert.equal(persisted.length - beforeShrink, 1, '容量縮小で表が変わったら1回だけ保存する');
    assert.equal(persisted.at(-1).sessionAffinity.entries.length, 1);

    const beforeOff = persisted.length;
    holder.sessionAffinity = { mode: 'off' };

    assert.equal((await reload()).status, 200);

    assert.equal(persisted.length - beforeOff, 1, 'on→off で表を捨てたことを1回だけ保存する');
    assert.equal('sessionAffinity' in persisted.at(-1), false);
  });

  it('FU-97: a reload that changes neither the accounts nor the table persists nothing extra', async () => {
    const { ask, reload, persisted } = await startStatus({ reloadable: true });

    await ask({ sid: RAW_SESSION_ID });
    const before = persisted.length;

    assert.equal((await reload()).status, 200);

    assert.equal(persisted.length, before, '変化が無ければ保存を増やさない');
  });

  it('persists the events only while the mode is not off', async () => {
    const enabled = await startStatus();
    await enabled.ask({ sid: RAW_SESSION_ID });
    const savedWhileOn = enabled.persisted.at(-1);
    assert.ok(Array.isArray(savedWhileOn.events), 'observe/on では events を保存する');
    assert.ok(savedWhileOn.events.length > 0);

    const disabled = await startStatus({ sessionAffinity: null });
    await disabled.ask({ sid: RAW_SESSION_ID });
    assert.equal('events' in disabled.persisted.at(-1), false, 'off では events を保存しない');
  });

  it('starts persisting the events when a reload turns the mode on', async () => {
    const { ask, reload, holder, persisted } = await startStatus({
      reloadable: true,
      sessionAffinity: null,
    });

    await ask({ sid: RAW_SESSION_ID });
    assert.equal('events' in persisted.at(-1), false);
    holder.sessionAffinity = { mode: 'observe' };

    assert.equal((await reload()).status, 200);
    await ask({ sid: RAW_SESSION_ID });

    assert.ok(Array.isArray(persisted.at(-1).events));
  });
});

// ---------------------------------------------------------------------------
// 冷えた固定の解放（R-S18 / 設計書 v1.7 §4.3・P-b）
//
// v1.6 は「口座が枯れるまで動かさない」だった。v1.7（2026-09-18 判断6 案(a)）は、
// **キャッシュが失効したセッションだけ**を、利用率の高い口座から空いている口座へ
// 動かしてよいことにする。移すキャッシュがもう無いので費用はゼロであり、温かい
// セッションはこの線では1本も動かない。
// ---------------------------------------------------------------------------

describe('session affinity cold reassign (R-S18 / 設計書 v1.7 P-b)', () => {
  function eventLines(logLines, kind) {
    return logLines.filter(line => line.includes(` ${kind} `));
  }

  async function startCold({
    accounts = ['acct_a', 'acct_b'],
    sessionAffinity = { mode: 'on', warmTtlMs: 60_000 },
  } = {}) {
    const logLines = [];
    const seen = [];
    // 時計は台帳へ注入する。affinity は `() => accountManager.now()` を読むので、
    // これ1つで warm TTL を決定的に動かせる（実時間を待たない）。
    const clock = { ms: Date.now() };
    const upstream = await listen(http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));
    const secretStore = new MemorySecretStore();
    for (const id of accounts) {
      await secretStore.set(id, {
        accessToken: `token-${id}`,
        refreshToken: `refresh-${id}`,
        expiresAt: Date.now() + 3_600_000,
      });
    }
    const logger = line => logLines.push(line);
    const accountManager = new AccountManager({
      accounts: accounts.map(id => ({ id, type: 'oauth' })),
      logger,
      now: () => clock.ms,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      logger,
      config: {
        upstream: upstream.url,
        usagePolling: { enabled: false },
        sessionAffinity,
      },
    }));
    cleanupAfterTest(async () => { await close(proxy.server); await close(upstream.server); });

    const ask = ({ sid = null, model = 'sonnet' } = {}) => requestJson(
      `${proxy.url}/v1/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ model }),
        headers: { ...(sid ? { 'x-claude-code-session-id': sid } : {}) },
      },
    );
    return { seen, accountManager, logLines, ask, clock };
  }

  /** 枯渇はさせずに利用率だけを上げる（switchThreshold の既定は 1）。 */
  function setUtilization(accountManager, id, { fiveHour, weekly }) {
    const now = accountManager.now();
    accountManager.applyUsage(id, {
      five_hour: { utilization: fiveHour, resets_at: new Date(now + 3_600_000).toISOString() },
      seven_day: { utilization: weekly, resets_at: new Date(now + 86_400_000).toISOString() },
    });
  }

  it('moves a cold session off a heavily used account and records reason=cold_reassign', async () => {
    const { ask, seen, logLines, accountManager, clock } = await startCold();

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_a');

    // 結び付け先は 90% まで使われているが、まだ枯れてはいない（要求は通る）。
    setUtilization(accountManager, 'acct_a', { fiveHour: 0.90, weekly: 0.10 });
    assert.equal(accountManager.isAvailable(accountManager.find('acct_a')), true);
    // キャッシュが失効するまで放置する。
    clock.ms += 60_001;

    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.equal(seen.at(-1), 'Bearer token-acct_b', '空いている口座へ移る');
    const switches = eventLines(logLines, 'affinity_switch');
    assert.equal(switches.length, 1);
    assert.match(
      switches[0],
      / from=acct_a to=acct_b reason=cold_reassign family=other switches=1$/,
    );

    // 移った先が新しい結び付け先になる（毎回さまよわない）。
    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    assert.equal(seen.at(-1), 'Bearer token-acct_b');
    assert.equal(eventLines(logLines, 'affinity_switch').length, 1);
  });

  it('never moves a warm session, however used the bound account is', async () => {
    const { ask, seen, logLines, accountManager } = await startCold();

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    setUtilization(accountManager, 'acct_a', { fiveHour: 0.99, weekly: 0.10 });

    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), [], '温かいセッションは動かさない');
  });

  it('keeps a cold session where it is while the account is still below drainStartUtilization', async () => {
    const { ask, seen, logLines, accountManager, clock } = await startCold();

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    setUtilization(accountManager, 'acct_a', { fiveHour: 0.50, weekly: 0.10 });
    clock.ms += 60_001;

    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.deepEqual(
      eventLines(logLines, 'affinity_switch'),
      [],
      '冷えていても、口座が混んでいなければ動かす理由が無い',
    );
  });

  it('turns the whole line off when drainStartUtilization is 1', async () => {
    const { ask, seen, logLines, accountManager, clock } = await startCold({
      sessionAffinity: { mode: 'on', warmTtlMs: 60_000, drainStartUtilization: 1 },
    });

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    setUtilization(accountManager, 'acct_a', { fiveHour: 0.99, weekly: 0.10 });
    clock.ms += 60_001;

    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), []);
  });

  it('leaves a cold session alone when the utilisation of the bound account cannot be read', async () => {
    const { ask, seen, logLines, clock } = await startCold();

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    // 使用量を一度も取得できていない口座。0% と読んでも 100% と読んでもいけない。
    clock.ms += 60_001;

    assert.equal((await ask({ sid: 'session-one' })).status, 200);

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), []);
  });

  it('keeps the cold session on its account when there is nowhere better to go', async () => {
    const { ask, seen, logLines, accountManager, clock } = await startCold({
      accounts: ['acct_a'],
    });

    assert.equal((await ask({ sid: 'session-one' })).status, 200);
    setUtilization(accountManager, 'acct_a', { fiveHour: 0.95, weekly: 0.10 });
    clock.ms += 60_001;

    assert.equal((await ask({ sid: 'session-one' })).status, 200, '要求は必ず通す（R1）');

    assert.deepEqual(seen, ['Bearer token-acct_a', 'Bearer token-acct_a']);
    assert.deepEqual(eventLines(logLines, 'affinity_switch'), []);
  });
});

// ---------------------------------------------------------------------------
// キャッシュ観測（計画書 Task 1 Step 6・Task 2）
//
// 偽上流はすべて listen(0, '127.0.0.1')。実サービス・実 API・稼働中 rotator へは
// 到達しない（~/.claude/rules/02-verification.md §3）。
// fixture のセッション id は本ファイルで作った合成値である。
// ---------------------------------------------------------------------------

const OBSERVED_SSE = [
  'event: message_start',
  'data: ' + JSON.stringify({
    type: 'message_start',
    message: {
      model: 'claude-opus-5-1',
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 99000,
        cache_creation_input_tokens: 1500,
        cache_creation: { ephemeral_1h_input_tokens: 1500, ephemeral_5m_input_tokens: 0 },
      },
    },
  }),
  '',
  'event: message_delta',
  'data: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 20 } }),
  '',
  '',
].join('\n');

const QUOTA_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.76',
  'anthropic-ratelimit-unified-7d-utilization': '0.33',
  'anthropic-ratelimit-unified-5h-reset': '1789012345',
  'anthropic-ratelimit-unified-7d-reset': '1789098765',
};

async function startObservabilityProxy({ upstreamHandler, observability, logLines = [] }) {
  const upstreamSeen = [];
  const upstream = await listen(http.createServer((req, res) => {
    upstreamSeen.push({ acceptEncoding: req.headers['accept-encoding'] });
    upstreamHandler(req, res);
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
    config: { upstream: upstream.url, ...(observability === undefined ? {} : { observability }) },
    logger: line => logLines.push(line),
  }));
  cleanupAfterTest(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { proxy, accountManager, logLines, upstreamSeen };
}

function proxyLine(logLines) {
  return logLines.find(line => line.includes(' proxy '));
}

// 圧縮された応答を受け取るので、本文を JSON として解釈しない生のクライアント。
// listen(0, '127.0.0.1') の偽上流としか話さない。
function requestRaw(url, { method = 'POST', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      headers: { 'content-type': 'application/json', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('cache observability', () => {
  it('gzip で圧縮された SSE からも usage を集計する（現行は 0 件で終わる欠陥）', async () => {
    const zlib = await import('node:zlib');
    const { proxy, accountManager } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          ...QUOTA_HEADERS,
        });
        res.end(zlib.gzipSync(Buffer.from(OBSERVED_SSE, 'utf8')));
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5-1' }),
    });
    assert.equal(response.status, 200);

    const { usage } = accountManager.getStatus().accounts[0];
    assert.equal(usage.totalCacheReadTokens, 99000);
    assert.equal(usage.totalCacheCreation1hTokens, 1500);
    assert.equal(usage.totalCacheCreation5mTokens, 0);
    assert.equal(usage.totalInputTokens, 10);
    assert.equal(usage.totalOutputTokens, 20);
  });

  it('1要求で totalRequests が 1 だけ増える（旧実装はストリームで 2 増えた）', async () => {
    const { proxy, accountManager } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(OBSERVED_SSE);
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-1' }),
    });
    assert.equal(accountManager.getStatus().accounts[0].usage.totalRequests, 1);
  });

  it('usage が読めなかった要求は totalRequests に数えない', async () => {
    const { proxy, accountManager, logLines } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        // 解けない符号化。解析は unsupported-encoding で観測可能に落ちる。
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'snappy' });
        res.end(OBSERVED_SSE);
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-1' }),
    });
    const { usage } = accountManager.getStatus().accounts[0];
    assert.equal(usage.totalRequests, 0);
    assert.equal(usage.totalCacheReadTokens, 0);
    assert.match(proxyLine(logLines), / enc=snappy usageParse=unsupported-encoding$/);
  });

  it('proxy 行の末尾へ計画書の順序で観測を追記する', async () => {
    const zlib = await import('node:zlib');
    const { proxy, logLines } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Content-Encoding': 'gzip',
          ...QUOTA_HEADERS,
        });
        res.end(zlib.gzipSync(Buffer.from(OBSERVED_SSE, 'utf8')));
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5-1' }),
      headers: { 'x-claude-code-session-id': 'synthetic-session-0001' },
    });

    assert.match(
      proxyLine(logLines),
      / model=claude-opus-5-1 sid=[0-9a-f]{12} in=10 out=20 cr=99000 cc=1500 c1h=1500 c5m=0 u5h=0\.76 u5hReset=1789012345 u7d=0\.33 u7dReset=1789098765 enc=gzip$/,
    );
    // 生のセッション id はどこにも出さない。
    assert.ok(!logLines.join('\n').includes('synthetic-session-0001'));
  });

  it('セッションヘッダの無い要求では sid=- になる（付与率の測定）', async () => {
    const { proxy, logLines } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(OBSERVED_SSE);
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-1' }),
    });
    assert.match(proxyLine(logLines), / sid=- /);
  });

  it('requestLog.enabled=false のとき proxy 行は現行と同じ形へ戻るが usage 集計は続く', async () => {
    const zlib = await import('node:zlib');
    const { proxy, accountManager, logLines } = await startObservabilityProxy({
      observability: { requestLog: { enabled: false } },
      upstreamHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip', ...QUOTA_HEADERS });
        res.end(zlib.gzipSync(Buffer.from(OBSERVED_SSE, 'utf8')));
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-1' }),
    });

    const line = proxyLine(logLines);
    assert.ok(!line.includes(' model='), line);
    assert.ok(!line.includes(' sid='), line);
    assert.ok(!line.includes(' enc='), line);
    assert.match(line, /outcome=ok$/);
    // 観測の無効化は集計まで止めない（欠陥修正そのものは設定に従属させない）。
    assert.equal(accountManager.getStatus().accounts[0].usage.totalCacheReadTokens, 99000);
  });

  it('解けない符号化を上流向けの accept-encoding から落とす', async () => {
    const { proxy, upstreamSeen } = await startObservabilityProxy({
      upstreamHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5-1' }),
      // Task 1 Step 0 で実測した Claude Code 2.1.275 の実際の値。
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });

    const zstdDecodable = typeof (await import('node:zlib')).default.zstdDecompress === 'function';
    assert.equal(upstreamSeen[0].acceptEncoding, zstdDecodable ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br');
  });

  it('dropUndecodableAcceptEncoding=false なら accept-encoding を素通しする', async () => {
    const { proxy, upstreamSeen } = await startObservabilityProxy({
      observability: { upstream: { dropUndecodableAcceptEncoding: false } },
      upstreamHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-opus-5-1' }),
      headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
    });
    assert.equal(upstreamSeen[0].acceptEncoding, 'gzip, deflate, br, zstd');
  });
});

describe('cache observability の reload', () => {
  async function startReloadProxy({ observability, nextObservability }) {
    const logLines = [];
    const upstream = await listen(http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...QUOTA_HEADERS });
      res.end(JSON.stringify({ model: 'claude-opus-5-1', usage: { input_tokens: 10, output_tokens: 20 } }));
    }));
    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url, usagePolling: { enabled: false }, observability },
      currentCredentialReader: async () => null,
      reloadObservability: async () => nextObservability,
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
      await close(upstream.server);
    });
    return { proxy, logLines };
  }

  const ask = proxy => requestRaw(`${proxy.url}/v1/messages`, {
    method: 'POST', body: JSON.stringify({ model: 'claude-opus-5-1' }),
  });
  const proxyLinesOf = logLines => logLines.filter(line => line.includes(' proxy '));

  it('reload で observability セクションを消すと既定（on）へ戻る', async () => {
    const { proxy, logLines } = await startReloadProxy({
      observability: { requestLog: { enabled: false } },
      nextObservability: undefined,
    });

    await ask(proxy);
    assert.ok(!proxyLinesOf(logLines).at(-1).includes(' model='), '起動時は無効');

    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    await ask(proxy);
    assert.match(proxyLinesOf(logLines).at(-1), / model=claude-opus-5-1 sid=- in=10 out=20 /);
  });

  it('reload で無効化すると行が現行の形へ戻る', async () => {
    const { proxy, logLines } = await startReloadProxy({
      observability: undefined,
      nextObservability: { requestLog: { enabled: false } },
    });

    await ask(proxy);
    assert.match(proxyLinesOf(logLines).at(-1), / model=claude-opus-5-1 /, '起動時は既定 on');

    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    await ask(proxy);
    assert.match(proxyLinesOf(logLines).at(-1), /outcome=ok$/);
  });

  it('reload の値にもクランプが効く（毎回 normalizeObservability を通し直す）', async () => {
    const { proxy, logLines } = await startReloadProxy({
      observability: undefined,
      // maxBodyBytes を 1 にしても 1 MiB へクランプされるので too-large にはならない。
      nextObservability: { requestLog: { maxBodyBytes: 1 } },
    });

    assert.equal((await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' })).status, 200);
    await ask(proxy);
    const line = proxyLinesOf(logLines).at(-1);
    assert.ok(!line.includes('usageParse=too-large'), line);
    assert.match(line, / in=10 out=20 /);
  });

  it('reload を2回叩いても行は増えない', async () => {
    const { proxy, logLines } = await startReloadProxy({
      observability: undefined,
      nextObservability: { requestLog: { enabled: true } },
    });
    await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    const after = logLines.length;
    await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
    assert.equal(logLines.length, after, 'reload 自体は observability の行を出さない');
  });
});
