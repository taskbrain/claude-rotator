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
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });

  return {
    ...response,
    body: response.bodyText ? JSON.parse(response.bodyText) : null,
  };
}
