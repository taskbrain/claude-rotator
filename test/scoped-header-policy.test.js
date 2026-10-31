import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { AccountManager } from '../src/account-manager.js';
import { parseRateLimitHeaders } from '../src/quota.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const future = String((START + 3_600_000) / 1000);

describe('scoped header activation', () => {
  it('does not enumerate or read scoped headers in the default parser', () => {
    const headers = {
      get(name) {
        assert.equal(name.includes('fable'), false);
        return undefined;
      },
      keys() { assert.fail('legacy parsing must not enumerate scope names'); },
    };
    assert.deepEqual(parseRateLimitHeaders(headers), {});
  });

  for (const eventHistory of [false, true]) {
    it(`leaves off status and saved state unchanged for normal and invalid scoped headers (history=${eventHistory})`, () => {
      const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => START, eventHistory });
      manager.updateQuota('sample', {
        'anthropic-ratelimit-unified-5h-utilization': '0.1', 'anthropic-ratelimit-unified-5h-reset': future,
      });
      const status = JSON.stringify(manager.getStatus());
      const saved = JSON.stringify(manager.exportState());
      for (const value of ['0.99', 'invalid-fixture']) {
        manager.updateQuota('sample', {
          'anthropic-ratelimit-unified-7d-fable-utilization': value,
          'anthropic-ratelimit-unified-7d-fable-reset': future,
        });
        assert.equal(JSON.stringify(manager.getStatus()), status);
        assert.equal(JSON.stringify(manager.exportState()), saved);
      }
    });
  }

  for (const mode of ['shadow', 'on']) {
    it(`keeps scoped observation enabled for an explicit ${mode} policy`, () => {
      const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => START,
        switchThreshold: 0.97, planQuota: { mode } });
      manager.updateQuota('sample', {
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
        'anthropic-ratelimit-unified-7d-reset': future,
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
        'anthropic-ratelimit-unified-7d-fable-reset': future,
      });
      assert.equal(manager.exportState().accounts[0].windowObservations['7d_fable'].lastKnown.usedFraction, 0.99);
      assert.equal(manager.isAvailable(manager.find('sample'), 'fable'), mode === 'shadow');
    });
  }

  for (const enabled of [false, true]) {
    it(`does not activate scoped policy events when only recording is enabled=${enabled}`, async () => {
      const logs = [];
      const manager = new AccountManager({ accounts: [{ id: 'sample', type: 'apikey' }], now: () => START });
      const secrets = new MemorySecretStore();
      await secrets.set('sample', { apiKey: randomUUID() });
      const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        assert.notEqual(server.address().port, 37891);
        resolve(`http://127.0.0.1:${server.address().port}`);
      }));
      const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      const upstream = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-5h-reset': future,
          'anthropic-ratelimit-unified-7d-fable-utilization': 'invalid-fixture',
          'anthropic-ratelimit-unified-7d-fable-reset': future,
        });
        res.end('{"ok":true}');
      });
      const upstreamUrl = await listen(upstream);
      const proxy = createProxyServer({ accountManager: manager, secretStore: secrets,
        config: { upstream: upstreamUrl, usagePolling: { enabled: false }, quotaObservation: { enabled } },
        logger: line => logs.push(line),
      });
      try {
        const url = await listen(proxy);
        const response = await new Promise((resolve, reject) => {
          const req = http.request(url + '/v1/messages', { method: 'POST' }, res => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          });
          req.on('error', reject); req.end(JSON.stringify({ model: 'sonnet' }));
        });
        assert.equal(response, 200);
        assert.equal(manager.getStatus().events.some(event => event.type === 'quota-header-rejected'), false);
        assert.equal(Object.hasOwn(manager.getStatus(), 'quotaWindows'), false);
        assert.equal(Object.hasOwn(manager.exportState().accounts[0], 'windowObservations'), false);
        assert.equal(logs.some(line => line.includes('"event":"quota_shape"')), enabled);
      } finally { await close(proxy); await close(upstream); }
    });
  }
});
