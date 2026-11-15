import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { parseUsageResponse } from '../src/oauth.js';
import { createProxyServer } from '../src/proxy-server.js';
import {
  fableQuotaCompatMode,
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
});

function oiHeaders(utilization, resetSeconds = futureSeconds) {
  return {
    'anthropic-ratelimit-unified-7d_oi-utilization': utilization,
    'anthropic-ratelimit-unified-7d_oi-reset': resetSeconds,
  };
}

function overageUsage(utilization, resetAt = START + 3_600_000) {
  return parseUsageResponse({
    seven_day_overage_included: { utilization, resets_at: new Date(resetAt).toISOString() },
  });
}

describe('fableQuotaCompat scope names', () => {
  const compatNames = ['oi', 'OI', 'overage_included', 'Overage Included', 'overage-included'];

  it('leaves the compat names unrecognised unless the caller passes the setting', () => {
    for (const name of compatNames) {
      assert.equal(isFableScopeIdentity(name), false, name);
      assert.equal(isFableScopeIdentity(name, true), false, name);
      assert.equal(isFableScopeIdentity(name, true, false), false, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, 'fable', true), false, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, 'fable', true, false), false, name);
    }
  });

  it('treats the compat names as the Fable weekly limit when the caller passes the setting', () => {
    for (const name of compatNames) {
      assert.equal(isFableScopeIdentity(name, false, true), true, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, 'fable', false, true), true, name);
      assert.equal(scopeMatchesModelFamily({ key: 'unrelated', label: name }, 'fable', false, true), true, name);
      assert.equal(scopeMatchesModelFamily({ key: name }, null, true, true), false, name);
    }
    for (const name of ['oi_extra', 'overage', 'overage_included_2', 'sonnet']) {
      assert.equal(isFableScopeIdentity(name, true, true), false, name);
    }
  });

  it('reads anything but an exact off or on as off', () => {
    const manager = new AccountManager({ accounts: [{ id: 'sample' }], now: () => START });
    for (const raw of [undefined, null, true, 'on', {}, { mode: 'ON' }, { mode: 'yes' }, { mode: 1 }]) {
      assert.equal(fableQuotaCompatMode(raw), 'off', JSON.stringify(raw));
      manager.configureFableQuotaCompat({ mode: 'on' });
      assert.equal(manager.configureFableQuotaCompat(raw), 'off', JSON.stringify(raw));
      assert.equal(manager.fableQuotaCompat, false);
    }
    assert.equal(manager.configureFableQuotaCompat({ mode: 'on' }), 'on');
    assert.equal(manager.fableQuotaCompat, true);
  });

  it('keeps the upstream name as the label of the 7d_oi header window', () => {
    const parsed = parseRateLimitHeaders(oiHeaders('0.5'), { includeScopedWindows: true });
    assert.deepEqual(parsed.weeklyScoped, [{ key: 'oi', label: 'oi', utilization: 0.5, resetAt: Number(futureSeconds) * 1000 }]);
  });
});

describe('fableQuotaCompat account availability', () => {
  for (const mode of ['off', 'on']) {
    it(`gates Fable on an exhausted 7d_oi header window only when on (compat=${mode})`, () => {
      const manager = new AccountManager({
        accounts: [{ id: 'sample' }], now: () => START, planQuota: { mode: 'on' }, fableQuotaCompat: { mode },
      });
      manager.updateQuota('sample', oiHeaders('1'));
      const account = manager.find('sample');
      assert.deepEqual(account.quota.weeklyScoped.map(limit => [limit.key, limit.label]), [['oi', 'oi']]);
      assert.equal(manager.isAvailable(account, 'fable'), mode === 'off');
      assert.equal(manager.isAvailable(account, null), true);
    });

    for (const planQuota of [null, { mode: 'on' }]) {
      it(`gates Fable on an exhausted seven_day_overage_included Usage bucket only when on (compat=${mode}, planQuota=${planQuota?.mode ?? 'unset'})`, () => {
        const manager = new AccountManager({
          accounts: [{ id: 'sample' }], now: () => START, planQuota, fableQuotaCompat: { mode },
        });
        manager.applyUsage('sample', overageUsage(100));
        const account = manager.find('sample');
        assert.equal(account.quota.weeklyScoped[0].key, 'overage_included');
        assert.equal(manager.isAvailable(account, 'fable'), mode === 'off');
        assert.equal(manager.isAvailable(account, null), true);
      });
    }
  }
});

describe('fableQuotaCompat belongs to one ledger', () => {
  for (const order of [['on', 'off'], ['off', 'on']]) {
    it(`keeps each ledger to its own setting (created ${order.join(' then ')})`, () => {
      const managers = Object.fromEntries(order.map(mode => [mode, new AccountManager({
        accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' }, fableQuotaCompat: { mode },
      })]));
      for (const [mode, manager] of Object.entries(managers)) {
        manager.updateQuota('header', oiHeaders('1'));
        manager.applyUsage('usage', overageUsage(100));
        for (const id of ['header', 'usage']) {
          assert.equal(manager.isAvailable(manager.find(id), 'fable'), mode === 'off', `${mode}/${id}`);
        }
      }
    });
  }

  it('stores the same ledger whether the setting is on or off', () => {
    const states = ['on', 'off'].map(mode => {
      const manager = new AccountManager({
        accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' }, fableQuotaCompat: { mode },
      });
      manager.updateQuota('header', {
        ...oiHeaders('1'),
        'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.9',
        'anthropic-ratelimit-unified-7d_sonnet-reset': futureSeconds,
      });
      manager.applyUsage('usage', overageUsage(100));
      return JSON.stringify(manager.exportState());
    });
    assert.equal(states[0], states[1]);
  });

  it('stops gating Fable on windows read while on once turned off, and gates again when turned back on', () => {
    const manager = new AccountManager({
      accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' }, fableQuotaCompat: { mode: 'on' },
    });
    manager.updateQuota('header', oiHeaders('1'));
    manager.applyUsage('usage', overageUsage(100));
    const accounts = ['header', 'usage'].map(id => manager.find(id));
    for (const account of accounts) {
      assert.equal(manager.isAvailable(account, 'fable'), false, account.id);
      assert.equal(manager.unavailableReasonForModelFamily(account, 'fable')?.type, 'quota_exhausted', account.id);
    }

    manager.configureFableQuotaCompat({ mode: 'off' });
    const fresh = new AccountManager({
      accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' },
    });
    fresh.updateQuota('header', oiHeaders('1'));
    fresh.applyUsage('usage', overageUsage(100));
    for (const account of accounts) {
      assert.deepEqual(account.quota.weeklyScoped, fresh.find(account.id).quota.weeklyScoped, account.id);
      assert.equal(manager.isAvailable(account, 'fable'), true, account.id);
      assert.equal(manager.isAvailable(account, 'fable'), fresh.isAvailable(fresh.find(account.id), 'fable'), account.id);
      assert.equal(manager.unavailableReasonForModelFamily(account, 'fable'), null, account.id);
    }

    manager.configureFableQuotaCompat({ mode: 'on' });
    for (const account of accounts) assert.equal(manager.isAvailable(account, 'fable'), false, account.id);
  });

  it('reads a restored ledger by the setting applied after the restore', () => {
    const source = new AccountManager({
      accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' }, fableQuotaCompat: { mode: 'on' },
    });
    source.updateQuota('header', oiHeaders('1'));
    source.applyUsage('usage', overageUsage(100));
    const saved = JSON.parse(JSON.stringify(source.exportState()));
    for (const mode of ['off', 'on']) {
      const restored = new AccountManager({
        accounts: [{ id: 'header' }, { id: 'usage' }], now: () => START, planQuota: { mode: 'on' },
      });
      restored.restoreState(saved);
      restored.configureFableQuotaCompat({ mode });
      for (const id of ['header', 'usage']) {
        assert.equal(restored.isAvailable(restored.find(id), 'fable'), mode === 'off', `${mode}/${id}`);
      }
    }
  });
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

async function startProxy({ fableQuotaCompat, usageCalls, planQuota, reloadFableQuotaCompat = null }) {
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
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      ...(fableQuotaCompat === undefined ? {} : { fableQuotaCompat }),
      ...(planQuota === undefined ? {} : { planQuota }),
    },
    reloadFableQuotaCompat,
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
  return { url: proxy.url, seen, lines, accountManager };
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
    assert.equal(h.accountManager.fableQuotaCompat, false);
    assert.equal((await post(`${h.url}/v1/messages`, { model: 'claude-fable-5-2' })).status, 429);
    assert.equal(usageCalls.count, 0);
  });
});

describe('fableQuotaCompat belongs to one relay', () => {
  for (const order of [['on', 'off'], ['off', 'on']]) {
    it(`keeps each relay in one process to its own setting (started ${order.join(' then ')})`, async () => {
      const relays = {};
      for (const mode of order) {
        const usageCalls = { count: 0 };
        relays[mode] = { usageCalls, h: await startProxy({ fableQuotaCompat: { mode }, usageCalls }) };
      }
      for (const [mode, { usageCalls, h }] of Object.entries(relays)) {
        const response = await post(`${h.url}/v1/messages`, { model: 'claude-fable-5-2' });
        assert.equal(response.status, mode === 'on' ? 200 : 429, mode);
        assert.equal(usageCalls.count, mode === 'on' ? 1 : 0, mode);
        h.accountManager.applyUsage('acct_1', overageUsage(100, Date.now() + 86_400_000));
        assert.equal(h.accountManager.isAvailable(h.accountManager.find('acct_1'), 'fable'), mode === 'off', mode);
      }
    });
  }

  it('drops and restores the reading of stored windows across internal reloads', async () => {
    const usageCalls = { count: 0 };
    let next = { mode: 'on' };
    const h = await startProxy({
      fableQuotaCompat: { mode: 'on' }, planQuota: { mode: 'on' }, usageCalls, reloadFableQuotaCompat: async () => next,
    });
    const resetSeconds = String(Math.floor((Date.now() + 86_400_000) / 1000));
    h.accountManager.updateQuota('acct_1', oiHeaders('1', resetSeconds));
    h.accountManager.applyUsage('acct_2', overageUsage(100, Date.now() + 86_400_000));
    const available = () => ['acct_1', 'acct_2'].map(id => h.accountManager.isAvailable(h.accountManager.find(id), 'fable'));
    assert.deepEqual(available(), [false, false]);

    next = { mode: 'off' };
    assert.equal((await post(`${h.url}/internal/reload`, {})).status, 200);
    assert.deepEqual(available(), [true, true]);
    assert.equal(h.accountManager.fableQuotaCompat, false);

    next = { mode: 'on' };
    assert.equal((await post(`${h.url}/internal/reload`, {})).status, 200);
    assert.deepEqual(available(), [false, false]);
  });
});
