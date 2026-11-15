import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { parseUsageResponse } from '../src/oauth.js';
import { createProxyServer } from '../src/proxy-server.js';
import {
  configureFableQuotaCompat,
  fableQuotaCompatEnabled,
  isFableScopeIdentity,
  parseRateLimitHeaders,
  scopeMatchesModelFamily,
} from '../src/quota.js';
import { MemorySecretStore } from '../src/secret-store.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const futureSeconds = String((START + 3_600_000) / 1000);
const cleanups = [];

afterEach(async () => {
  for (const callback of cleanups.splice(0).reverse()) await callback();
  configureFableQuotaCompat(undefined);
});

describe('fableQuotaCompat scope names', () => {
  const compatNames = ['oi', 'OI', 'overage_included', 'Overage Included', 'overage-included'];

  it('leaves the compat names unrecognised by default', () => {
    assert.equal(fableQuotaCompatEnabled(), false);
    for (const name of compatNames) {
      assert.equal(isFableScopeIdentity(name), false, name);
      assert.equal(isFableScopeIdentity(name, true), false, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, 'fable', true), false, name);
    }
  });

  it('treats the compat names as the Fable weekly limit when on', () => {
    assert.equal(configureFableQuotaCompat({ mode: 'on' }), 'on');
    assert.equal(fableQuotaCompatEnabled(), true);
    for (const name of compatNames) {
      assert.equal(isFableScopeIdentity(name), true, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, 'fable'), true, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, null, true), false, name);
    }
    for (const name of ['oi_extra', 'overage', 'overage_included_2', 'sonnet']) {
      assert.equal(isFableScopeIdentity(name, true), false, name);
    }
  });

  it('reads anything but an exact off or on as off', () => {
    for (const raw of [undefined, null, true, 'on', {}, { mode: 'ON' }, { mode: 'yes' }, { mode: 1 }]) {
      configureFableQuotaCompat({ mode: 'on' });
      assert.equal(configureFableQuotaCompat(raw), 'off', JSON.stringify(raw));
      assert.equal(fableQuotaCompatEnabled(), false);
    }
  });

  it('labels the 7d_oi header window as Fable only when on', () => {
    const headers = {
      'anthropic-ratelimit-unified-7d_oi-utilization': '0.5',
      'anthropic-ratelimit-unified-7d_oi-reset': futureSeconds,
    };
    const off = parseRateLimitHeaders(headers, { includeScopedWindows: true });
    assert.deepEqual(off.weeklyScoped, [{ key: 'oi', label: 'oi', utilization: 0.5, resetAt: Number(futureSeconds) * 1000 }]);
    configureFableQuotaCompat({ mode: 'on' });
    const on = parseRateLimitHeaders(headers, { includeScopedWindows: true });
    assert.deepEqual(on.weeklyScoped, [{ key: 'oi', label: 'Fable', utilization: 0.5, resetAt: Number(futureSeconds) * 1000 }]);
  });
});

describe('fableQuotaCompat account availability', () => {
  for (const mode of ['off', 'on']) {
    it(`gates Fable on an exhausted 7d_oi header window only when on (compat=${mode})`, () => {
      configureFableQuotaCompat({ mode });
      const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => START, planQuota: { mode: 'on' } });
      manager.updateQuota('sample', {
        'anthropic-ratelimit-unified-7d_oi-utilization': '1',
        'anthropic-ratelimit-unified-7d_oi-reset': futureSeconds,
      });
      const account = manager.find('sample');
      assert.equal(manager.isAvailable(account, 'fable'), mode === 'off');
      assert.equal(manager.isAvailable(account, null), true);
    });

    for (const planQuota of [null, { mode: 'on' }]) {
      it(`gates Fable on an exhausted seven_day_overage_included Usage bucket only when on (compat=${mode}, planQuota=${planQuota?.mode ?? 'unset'})`, () => {
        configureFableQuotaCompat({ mode });
        const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => START, planQuota });
        manager.applyUsage('sample', parseUsageResponse({
          seven_day_overage_included: { utilization: 100, resets_at: new Date(START + 3_600_000).toISOString() },
        }));
        const account = manager.find('sample');
        assert.equal(account.quota.weeklyScoped[0].key, 'overage_included');
        assert.equal(manager.isAvailable(account, 'fable'), mode === 'off');
        assert.equal(manager.isAvailable(account, null), true);
      });
    }
  }
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref?.();
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function startProxy({ fableQuotaCompat, usageCalls }) {
  const seen = [];
  const upstream = await listen(http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer access-token-1') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', { accessToken: 'access-token-1' });
  await secretStore.set('acct_2', { accessToken: 'access-token-2' });
  const accountManager = new AccountManager({ accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }] });
  accountManager.updateQuota('acct_2', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
  const lines = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => null,
    config: { upstream: upstream.url, usagePolling: { enabled: false }, ...(fableQuotaCompat === undefined ? {} : { fableQuotaCompat }) },
    logger: line => lines.push(line),
    usageFetcher: async () => {
      usageCalls.count += 1;
      return parseUsageResponse({
        seven_day_overage_included: { utilization: 100, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      });
    },
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { url: proxy.url, seen, lines };
}

describe('fableQuotaCompat reactive Usage confirmation', () => {
  it('keeps a claude-fable-5-2 429 unconfirmed and unchanged by default', async () => {
    const usageCalls = { count: 0 };
    const h = await startProxy({ usageCalls });
    const response = await post(`${h.url}/v1/messages`, { model: 'claude-fable-5-2' });
    assert.equal(response.status, 429);
    assert.equal(usageCalls.count, 0);
    assert.deepEqual(h.seen, ['Bearer access-token-1']);
    assert.equal(h.lines.some(line => line.includes('fable-quota-compat')), false);
  });

  it('confirms a claude-fable-5-2 429 through seven_day_overage_included and replays it when on', async () => {
    const usageCalls = { count: 0 };
    const h = await startProxy({ fableQuotaCompat: { mode: 'on' }, usageCalls });
    const response = await post(`${h.url}/v1/messages`, { model: 'claude-fable-5-2' });
    assert.equal(response.status, 200);
    assert.equal(usageCalls.count, 1);
    assert.deepEqual(h.seen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.ok(h.lines.includes('fable-quota-compat mode=on'));
  });

  it('accepts only the exact claude-fable-5-<number> form when on', async () => {
    const usageCalls = { count: 0 };
    const h = await startProxy({ fableQuotaCompat: { mode: 'on' }, usageCalls });
    const models = [
      'claude-fable-5-2-20261101',
      'claude-fable-5-20260818',
      'claude-fable-5-2x',
      'claude-fable-5-02',
      'claude-fable-5-0',
      ' claude-fable-5-2',
      'CLAUDE-FABLE-5-2',
      'claude-fable-6-1',
    ];
    for (const model of models) {
      assert.equal((await post(`${h.url}/v1/messages`, { model })).status, 429, model);
    }
    assert.equal(usageCalls.count, 0);
  });

  it('logs one warning and stays off for an invalid mode', async () => {
    const usageCalls = { count: 0 };
    const h = await startProxy({ fableQuotaCompat: { mode: 'enabled' }, usageCalls });
    assert.deepEqual(h.lines.filter(line => line.includes('fable-quota-compat')),
      ['fable-quota-compat warning=invalid-mode mode=off']);
    assert.equal(fableQuotaCompatEnabled(), false);
    assert.equal((await post(`${h.url}/v1/messages`, { model: 'claude-fable-5-2' })).status, 429);
    assert.equal(usageCalls.count, 0);
  });
});
