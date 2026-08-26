import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import { AccountManager } from '../src/account-manager.js';
import { OAuthTokenRefreshError, parseUsageResponse } from '../src/oauth.js';
import { MemorySecretStore } from '../src/secret-store.js';
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

  it('discards a refresh result when credential metadata changed in flight', async () => {
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
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config: { upstream: upstream.url },
      tokenRefresher: async () => {
        await secretStore.set('acct_1', newerSecret);
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
    assert.match(logLines.join('\n'), /result=discarded reason=credential-changed/);
    assert.equal(logLines.join('\n').includes('stale-refresh-result'), false);
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
      expiresAt: 200000,
    });
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
    assert.equal(accountManager.getStatus().currentAccount, 'current');
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
    secretStore.get = async accountId => {
      if (accountId !== 'acct_1') return originalGetSecret(accountId);
      accountOneSecretReads += 1;
      return {
        accessToken: accountOneSecretReads === 1 ? 'access-token-a' : 'access-token-b',
      };
    };
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
    secretStore.get = async accountId => {
      if (accountId !== 'acct_1') return originalGetSecret(accountId);
      accountOneSecretReads += 1;
      return {
        accessToken: accountOneSecretReads === 1 ? 'access-token-a' : 'access-token-b',
      };
    };
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
        throw new Error('Usage fetch failed (429): rate limited');
      },
      logger: line => logLines.push(line),
    }));
    cleanupAfterTest(async () => {
      await close(proxy.server);
    });

    const response = await requestJson(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(response.status, 200);
    assert.match(
      logLines.join('\n'),
      /usage-refresh account=acct_1 result=failed error=Usage fetch failed \(429\)/,
    );
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

  it('requires the exact canonical Fable 5 model id for reactive Usage confirmation', async () => {
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

    for (const model of [
      'claude-not-fable-5',
      'CLAUDE-FABLE-5',
      ' claude-fable-5 ',
      'claude-fable-5-20260818',
    ]) {
      const response = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model }),
      });
      assert.equal(response.status, 429, model);
      assert.deepEqual(response.body, originalBody, model);
      assert.equal(response.headers['x-reactive-test'], 'negated-fable-token', model);
    }
    assert.equal(usageCalls, 0);
    assert.deepEqual(upstreamSeen, Array(4).fill('Bearer access-token-1'));
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
    const originalGet = secretStore.get.bind(secretStore);
    secretStore.get = async accountId => {
      if (accountId !== 'acct_2') return originalGet(accountId);
      await usageStarted;
      throw new Error('target secret read failed');
    };
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
    secretStore.get = async accountId => {
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
    secretStore.get = async accountId => {
      if (accountId === 'acct_2') {
        targetSecretReads += 1;
        if (targetSecretReads === 2) throw new Error('final reactive target read failed');
      }
      return originalGetSecret(accountId);
    };
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
      targetSecretReads: 2,
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
    secretStore.get = async accountId => {
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
    secretStore.get = async accountId => {
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
      tokenRefresher: async refreshToken => {
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

  it('does not send an expired token upstream when refresh fails', async () => {
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
    });
  });

  it('fails closed before refresh when the secret store lacks atomic compare-and-set', async () => {
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
      secretStore: { get: async () => ({ ...secret }) },
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
