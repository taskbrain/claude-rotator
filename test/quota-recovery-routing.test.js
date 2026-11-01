import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeStateWriter } from '../src/cli.js';
import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';
import { OAuthTokenRefreshError } from '../src/oauth.js';

const START = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;
const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  assert.notEqual(port, 37891);
  cleanup.push(() => new Promise(done => { server.closeAllConnections(); server.close(done); }));
  resolve({ server, url: `http://127.0.0.1:${port}` });
}));
function request(url, { method = 'GET', body = null, headers = {} } = {}) {
  assert.notEqual(new URL(url).port, '37891');
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBytes = Buffer.concat(chunks);
        const text = bodyBytes.toString();
        let body; try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, headers: res.headers, body, bodyBytes });
      });
    });
    req.on('error', reject);
    req.end(body === null ? undefined : JSON.stringify(body));
  });
}

async function fixture({ scenario = 'unobserved', policy = 'plan', mode = 'on', count = 1, id = 'sample-a', timeoutMs = 1000,
  restoredState = null, startAt = START, refreshable = false, credentialExpiry = 'valid', degradeMapping = null } = {}) {
  const clock = { ms: startAt };
  const seen = [];
  const sendTimes = [];
  const logs = [];
  const events = [];
  const snapshots = [];
  let usageCalls = 0;
  let refreshCalls = 0;
  const state = { status: 200, headers: true, extraHeaders: {}, writer: async () => {}, hold: null,
    onRequest: null, afterHead: null, responseBody: null, rawBody: null, refresh: null,
    credentialCheck: null, credentialAccepted: [], beforeCredentialRead: null };
  const upstream = await listen(http.createServer(async (req, res) => {
    seen.push(req.url);
    sendTimes.push(clock.ms);
    events.push('upstream');
    req.resume();
    if (state.onRequest) await state.onRequest();
    if (state.hold) await state.hold();
    if (res.destroyed) return;
    const accepted = state.credentialCheck ? state.credentialCheck(req.headers) : true;
    if (state.credentialCheck) state.credentialAccepted.push(accepted);
    const responseStatus = accepted ? state.status : 401;
    const headers = { 'content-type': 'application/json', ...state.extraHeaders };
    if (state.headers) {
      headers['anthropic-ratelimit-unified-7d-utilization'] = '0.25';
      headers['anthropic-ratelimit-unified-7d-reset'] = String((START + 7 * 24 * HOUR) / 1000);
    }
    res.writeHead(responseStatus, headers);
    if (state.afterHead) { res.flushHeaders(); await state.afterHead(); }
    if (res.destroyed) return;
    res.end(state.rawBody ?? JSON.stringify(state.responseBody
      || (responseStatus === 200 ? { ok: true } : { error: { type: 'fixture_error' } })));
  }));
  const oauth = scenario !== 'apikey';
  const accounts = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? id : `sample-${index}`, type: oauth ? 'oauth' : 'apikey', credentialRevision: 1,
  }));
  const manager = new AccountManager({ accounts, now: () => clock.ms,
    planQuota: { mode: policy === 'plan' ? mode : 'off' },
    accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
  });
  if (restoredState) manager.restoreState(restoredState);
  if (!['unobserved', 'relogin'].includes(scenario)) {
    for (const account of accounts) manager.applyUsage(account.id, {
      seven_day: { utilization: 0.3, resets_at: new Date(START + 60_000).toISOString() },
    });
    clock.ms += 60_000;
  }
  if (scenario === 'relogin') {
    manager.markError(id, 'authentication_error', 'fixture rejection');
    manager.replaceAccounts(accounts.map(account => ({ ...account, credentialRevision: 2 })));
  }
  const store = new MemorySecretStore();
  const secrets = [];
  for (const [index, account] of accounts.entries()) {
    const value = randomUUID(); secrets.push(value);
    const lifetime = index === 0 && credentialExpiry === 'expired' ? -HOUR
      : index === 0 && credentialExpiry === 'soon' ? 60_000
        : index === 0 && credentialExpiry === 'usable-soon' ? 120_000 : 24 * HOUR;
    const metadata = {};
    if (oauth && refreshable) {
      metadata.refreshToken = randomUUID();
      secrets.push(metadata.refreshToken);
    }
    await store.set(account.id, oauth
      ? { accessToken: value, expiresAt: Date.now() + lifetime, ...metadata } : { apiKey: value });
  }
  const get = store.get.bind(store);
  store.get = async key => { events.push('secret'); return get(key); };
  const getOperational = store.getOperational.bind(store);
  store.getOperational = async key => {
    events.push('secret');
    if (state.beforeCredentialRead) await state.beforeCredentialRead(key);
    return getOperational(key);
  };
  const config = {
    upstream: upstream.url, sessionAffinity: { mode: 'on' },
    proxy: { upstreamIdleTimeoutMs: timeoutMs },
    ...(degradeMapping === null ? {} : { openaiBridge: { enabled: false, degradeMapping } }),
    planQuota: { mode: policy === 'plan' ? mode : 'off' },
    accountUrgency: { mode: policy === 'urgency' ? mode : 'off' },
    ...(scenario === 'old-config' ? {} : { usagePolling: {
      enabled: ['apikey', 'usage-429'].includes(scenario), concurrency: 2, requestSpacingMs: 0, intervalMs: HOUR,
    } }),
  };
  const proxy = await listen(createProxyServer({
    accountManager: manager, secretStore: store, config, logger: line => logs.push(line),
    currentCredentialReader: async () => assert.fail('must not read live credentials'),
    currentProfileFetcher: async () => assert.fail('must not fetch a live profile'),
    tokenRefresher: async (...args) => {
      refreshCalls++;
      events.push('refresh');
      if (state.refresh) return state.refresh(...args);
      assert.fail('unexpected credential refresh in fixture');
    },
    usageFetcher: async () => { usageCalls++; throw new Error('Usage fetch failed (429)'); },
    stateWriter: async snapshot => {
      snapshots.push(structuredClone(snapshot));
      if (snapshot.quotaRecovery?.pending) events.push('persist-pending');
      await state.writer(snapshot);
    },
  }));
  await request(proxy.url + '/internal/status');
  events.length = 0;
  const ask = (body = { model: 'sonnet', messages: [{ role: 'user', content: 'fixture request' }] }, headers = {}) =>
    request(proxy.url + '/v1/messages', { method: 'POST', body, headers });
  return { manager, clock, state, seen, sendTimes, logs, events, snapshots, ask, proxy, accounts, secrets, store,
    usageCalls: () => usageCalls, refreshCalls: () => refreshCalls };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('fixture condition did not settle');
}

describe('quota recovery HTTP scenarios', () => {
  for (const policy of ['plan', 'urgency']) {
    for (const scenario of ['polling-false', 'old-config', 'apikey', 'usage-429', 'unobserved', 'relogin', 'all-reset']) {
      it(`recovers ${scenario} using only a user request (${policy})`, async () => {
        const h = await fixture({ scenario, policy, count: scenario === 'all-reset' ? 3 : 1 });
        if (scenario === 'usage-429') await request(h.proxy.url + '/internal/refresh-usage', { method: 'POST' });
        const polls = h.usageCalls();
        h.events.length = 0;
        const response = await h.ask();
        assert.equal(response.status, 200);
        assert.equal(h.seen.length, 1);
        assert.equal(h.usageCalls(), polls, 'probe must not add usage polling');
        assert.equal(h.refreshCalls(), 0);
        assert.ok(h.events.indexOf('persist-pending') >= 0);
        assert.ok(h.events.slice(h.events.indexOf('persist-pending') + 1).includes('secret'),
          'selected-account credential resolution follows the durable reservation; startup checks are independent');
        assert.ok(h.events.indexOf('persist-pending') < h.events.indexOf('upstream'));
        assert.equal(h.manager.find(h.accounts[0].id).quota.unified7d, 0.25);
        assert.equal(h.manager.find(h.accounts[0].id).quota.unified5h, null);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }
  }

  it('returns a 200 without inventing quota, then waits for its budget', async () => {
    const h = await fixture();
    h.state.headers = false;
    assert.equal((await h.ask()).status, 200);
    assert.equal(h.manager.find('sample-a').quota.unified7d, null);
    const second = await h.ask();
    assert.equal(second.status, 503);
    assert.equal(second.headers['retry-after'], '900');
    assert.equal(h.seen.length, 1);
    assert.equal(h.manager.getStatus().quotaRecovery.lastResult, 'no-quota');
  });

  for (const [name, headers, seconds] of [
    ['reset', { 'anthropic-ratelimit-unified-reset': String((START + 2 * HOUR) / 1000) }, 7200],
    ['retry-after', { 'retry-after': '1200' }, 1200],
    ['unknown deadline', {}, 3600],
  ]) {
    it(`passes a 429 with ${name} once and respects its next-allowed time`, async () => {
      const h = await fixture({ count: 2 });
      h.state.status = 429; h.state.headers = false; h.state.extraHeaders = headers;
      assert.equal((await h.ask()).status, 429);
      assert.equal(h.seen.length, 1, 'the same request must not probe another account');
      const account = h.manager.quotaRecovery.inspect(h.manager.quotaRecoveryKey(h.manager.find('sample-a')),
        h.manager.quotaRecoveryIdentity(h.manager.find('sample-a')));
      assert.equal(account.nextAllowedAt, START + seconds * 1000);
    });
  }

  for (const status of [401, 403]) {
    it(`does not retry or refresh after a probe returns ${status}`, async () => {
      const h = await fixture({ count: 2 });
      h.state.status = status; h.state.headers = false;
      assert.equal((await h.ask()).status, status);
      assert.equal(h.seen.length, 1);
      assert.equal(h.refreshCalls(), 0);
    });
  }

  it('does not send when the required durable write fails and does not expose error strings', async () => {
    const h = await fixture();
    h.state.writer = async () => { throw new Error('UNTRUSTED-PERSIST-MESSAGE'); };
    assert.equal((await h.ask()).status, 503);
    assert.equal(h.seen.length, 0);
    assert.equal(h.logs.join('').includes('UNTRUSTED-PERSIST-MESSAGE'), false);
    assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    h.manager.applyUsage('sample-a', { seven_day: {
      utilization: 0.3, resets_at: new Date(START + HOUR).toISOString(),
    } });
    assert.equal((await h.ask()).status, 200, 'ordinary traffic must survive a probe persistence failure');
  });

  it('rechecks identity after persistence and never resolves credentials for an obsolete lease', async () => {
    const h = await fixture();
    h.state.writer = async snapshot => {
      if (snapshot.quotaRecovery?.pending) h.manager.replaceAccounts([{ ...h.accounts[0], credentialRevision: 2 }]);
    };
    assert.equal((await h.ask()).status, 503);
    assert.equal(h.seen.length, 0);
    assert.equal(h.events.includes('secret'), false);
    assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
  });

  it('admits only one concurrent probe while its persistence is pending', async () => {
    const h = await fixture({ count: 2 });
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.state.writer = async snapshot => { if (snapshot.quotaRecovery?.pending) { began(); await gate; } };
    const first = h.ask();
    await started;
    const second = await h.ask();
    assert.equal(second.status, 503);
    assert.equal(h.seen.length, 0);
    release();
    assert.equal((await first).status, 200);
    assert.equal(h.seen.length, 1);
  });

  it('keeps new recovery outputs hashed and free of request or credential values', async () => {
    const h = await fixture({ id: 'sample@example.invalid' });
    await h.ask({ model: 'sonnet', messages: [{ role: 'user', content: 'PRIVATE-FIXTURE-TEXT' }] });
    const output = JSON.stringify(h.manager.getStatus().quotaRecovery)
      + JSON.stringify(h.manager.exportState().quotaRecovery) + h.logs.join('');
    for (const value of [...h.secrets, 'sample@example.invalid', 'PRIVATE-FIXTURE-TEXT']) assert.equal(output.includes(value), false);
  });

  for (const field of ['five_hour', 'seven_day', 'fable']) {
    it(`does not probe a known future 97 percent ${field} window`, async () => {
      const h = await fixture({ policy: 'urgency' });
      const limit = { utilization: 0.97, resets_at: new Date(START + HOUR).toISOString() };
      h.manager.applyUsage('sample-a', field === 'fable'
        ? { scoped_weekly: [{ key: 'fable', label: 'Fable', ...limit }] } : { [field]: limit });
      await h.ask({ model: field === 'fable' ? 'claude-fable-5' : 'sonnet' });
      assert.equal(h.seen.length, 0);
      assert.equal(h.manager.exportState().quotaRecovery.accounts.length, 0);
    });
  }

  it('does not apply a Fable-only stop to a non-Fable recovery request', async () => {
    const h = await fixture({ policy: 'urgency' });
    h.manager.applyUsage('sample-a', { scoped_weekly: [{
      key: 'fable', label: 'Fable', utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
    }] });
    assert.equal((await h.ask()).status, 200);
    assert.equal(h.seen.length, 1);
  });

  for (const policy of ['plan', 'urgency']) {
    for (const [name, incompleteHeaders] of [
      ['missing reset', { 'anthropic-ratelimit-unified-7d-fable-utilization': '0.1' }],
      ['expired reset', {
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.1',
        'anthropic-ratelimit-unified-7d-fable-reset': String((START - 1000) / 1000),
      }],
    ]) {
      it(`sends no Fable request after ${name} overwrites a retained stop (${policy})`, async () => {
        const h = await fixture({ policy });
        h.manager.updateQuota('sample-a', {
          'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
          'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
        });
        h.manager.updateQuota('sample-a', incompleteHeaders, { recoveryStatus: 200 });

        await h.ask({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'fixture request' }] });
        assert.equal(h.seen.length, 0, 'a retained Fable stop must prevent an upstream request');
        assert.equal(h.manager.exportState().quotaRecovery.accounts.length, 0, 'a rejected request must not spend recovery budget');

        assert.equal((await h.ask()).status, 200, 'the Fable-only stop must still allow a Sonnet recovery request');
        assert.equal(h.seen.length, 1);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }
  }

  it('honors an explicitly stricter stop threshold', async () => {
    const h = await fixture({ policy: 'urgency' });
    h.manager.configuredSwitchThreshold = 0.9;
    h.manager.configureAccountUrgency({ mode: 'on' });
    h.manager.applyUsage('sample-a', { five_hour: { utilization: 0.91, resets_at: new Date(START + HOUR).toISOString() } });
    await h.ask();
    assert.equal(h.seen.length, 0);
  });

  it('keeps persistence-failed, timeout and aborted attempts spent', async () => {
    const h = await fixture({ timeoutMs: 20 });
    let release;
    h.state.hold = () => new Promise(resolve => { release = resolve; });
    cleanup.push(async () => release?.());
    assert.equal((await h.ask()).status, 502);
    assert.equal(h.seen.length, 1);
    assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    assert.equal(h.manager.getStatus().quotaRecovery.lastResult, 'transport-error');
  });

  it('releases a consumed lease after a client abort without refunding it', async () => {
    const h = await fixture();
    let release;
    h.state.hold = () => new Promise(resolve => { release = resolve; });
    cleanup.push(async () => release?.());
    const req = http.request(h.proxy.url + '/v1/messages', { method: 'POST' });
    req.on('error', () => {});
    req.end(JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'fixture' }] }));
    await until(() => h.seen.length === 1);
    req.destroy();
    await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'aborted');
    assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
  });

  it('writes the pending reservation through the real durable writer before upstream receives it', async () => {
    const h = await fixture();
    const dir = await mkdtemp(join(tmpdir(), 'quota-recovery-durable-'));
    const path = join(dir, 'runtime-state.json');
    const writer = createRuntimeStateWriter(path);
    h.state.writer = writer;
    let pendingAtUpstream = false;
    h.state.onRequest = async () => {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      pendingAtUpstream = saved.quotaRecovery.pending !== null;
    };
    assert.equal((await h.ask()).status, 200);
    assert.equal(pendingAtUpstream, true);
  });

  it('holds an unresolved 429 as soon as its headers arrive', async () => {
    const h = await fixture({ policy: 'urgency' });
    h.manager.applyUsage('sample-a', {
      seven_day: { utilization: 0.3, resets_at: new Date(START + HOUR).toISOString() },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: null, resets_at: null }],
    });
    h.state.status = 429; h.state.headers = false;
    let release;
    let arrived;
    const headersSent = new Promise(resolve => { arrived = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    cleanup.push(async () => release());
    h.state.afterHead = async () => { arrived(); await gate; };
    const pending = h.ask({ model: 'claude-fable-5' });
    await headersSent;
    await until(() => h.manager.find('sample-a').rateLimitedUntil !== null);
    assert.equal(h.manager.isAvailable(h.manager.find('sample-a')), false);
    release();
    assert.equal((await pending).status, 429);
  });

  for (const mode of ['off', 'shadow']) {
    it(`keeps normal legacy traffic but never creates probe state in ${mode}`, async () => {
      const h = await fixture({ mode });
      assert.equal((await h.ask()).status, 200);
      assert.equal(Object.hasOwn(h.manager.getStatus(), 'quotaRecovery'), false);
      assert.equal(Object.hasOwn(h.manager.exportState(), 'quotaRecovery'), false);
      assert.equal(h.events.includes('persist-pending'), false);
      assert.equal(h.logs.some(line => line.startsWith('quota_recovery ')), false);
    });
  }

  for (const elapsed of [0, 31 * 60_000]) {
    it(`uses an ordinary candidate instead of a probe at observation age ${elapsed}`, async () => {
      const h = await fixture();
      h.manager.applyUsage('sample-a', { seven_day: { utilization: 0.3, resets_at: new Date(START + HOUR).toISOString() } });
      h.clock.ms += elapsed;
      assert.equal((await h.ask()).status, 200);
      assert.equal(h.manager.exportState().quotaRecovery.accounts.length, 0);
      assert.equal(h.events.includes('persist-pending'), false);
    });
  }

  it('continues with ordinary traffic if a fresh observation arrives during failed probe persistence', async () => {
    const h = await fixture();
    h.state.writer = async snapshot => {
      if (snapshot.quotaRecovery?.pending) {
        h.manager.applyUsage('sample-a', { seven_day: {
          utilization: 0.3, resets_at: new Date(START + HOUR).toISOString(),
        } });
        throw new Error('fixture persistence failure');
      }
    };
    assert.equal((await h.ask()).status, 200);
    assert.equal(h.seen.length, 1);
    assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
  });

  it('preserves consumed starts across an HTTP restart and the rolling-hour boundary', async () => {
    const first = await fixture();
    first.state.headers = false;
    assert.equal((await first.ask()).status, 200);
    await until(() => first.manager.getStatus().quotaRecovery.lastResult === 'no-quota');
    const saved = first.manager.exportState();
    const second = await fixture({ restoredState: saved, startAt: START + 15 * 60_000 });
    second.state.headers = false;
    assert.equal((await second.ask()).status, 200);
    await until(() => second.manager.getStatus().quotaRecovery.lastResult === 'no-quota');
    second.clock.ms = START + HOUR - 1;
    assert.equal((await second.ask()).status, 503);
    second.clock.ms = START + HOUR;
    assert.equal((await second.ask()).status, 200);
    assert.equal(second.seen.length, 2);
    assert.equal(second.manager.exportState().quotaRecovery.accounts[0].starts.length, 2);
  });

  it('spends a restored pending reservation without sending the obsolete instance', async () => {
    const first = await fixture();
    let release;
    let saved;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    cleanup.push(async () => release());
    first.state.writer = async snapshot => {
      if (snapshot.quotaRecovery?.pending) { saved = structuredClone(snapshot); began(); await gate; }
    };
    const pending = first.ask();
    await started;
    const restarted = await fixture({ restoredState: saved });
    const rejected = await restarted.ask();
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers['retry-after'], '900');
    assert.equal(restarted.seen.length, 0);
    assert.equal(restarted.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    first.manager.replaceAccounts([{ ...first.accounts[0], credentialRevision: 2 }]);
    release();
    assert.equal((await pending).status, 503);
    assert.equal(first.seen.length, 0);
  });

  it('does not move a warm binding during a tool continuation, but may recover at the next user turn', async () => {
    const h = await fixture({ count: 2, policy: 'urgency' });
    const headers = { 'x-claude-code-session-id': 'quota-recovery-session' };
    h.state.headers = false;
    assert.equal((await h.ask(undefined, headers)).status, 200);
    await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'no-quota');
    h.clock.ms += 60_000;
    h.manager.applyUsage('sample-a', { seven_day: {
      utilization: 0.99, resets_at: new Date(START + HOUR).toISOString(),
    } });
    await h.ask({ model: 'sonnet', messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'fixture' }] }] }, headers);
    assert.equal(h.seen.length, 1);
    h.state.headers = true;
    assert.equal((await h.ask(undefined, headers)).status, 200);
    assert.equal(h.seen.length, 2);
  });

  it('keeps organization rejection in the existing owner flow without a second probe', async () => {
    const h = await fixture();
    h.state.status = 403; h.state.headers = false;
    h.state.responseBody = { error: { type: 'permission_error', details: { error_code: 'oauth_not_allowed_for_organization' } } };
    assert.equal((await h.ask()).status, 403);
    assert.equal(h.manager.find('sample-a').errorReason.type, 'oauth_organization_denied');
    assert.equal((await h.ask()).status, 403);
    assert.equal(h.seen.length, 1);
    assert.equal(h.refreshCalls(), 0);
  });

  it('keeps an unresolved common rejection active when a different Fable scope is exhausted', async () => {
    const h = await fixture();
    h.manager.applyUsage('sample-a', { scoped_weekly: [{
      key: 'fable', label: 'Fable', utilization: 1, resets_at: new Date(START + 2 * HOUR).toISOString(),
    }] });
    h.state.status = 429; h.state.headers = false;
    assert.equal((await h.ask()).status, 429);
    h.manager.applyUsage('sample-a', { seven_day: {
      utilization: 0.25, resets_at: new Date(START + 24 * HOUR).toISOString(),
    } });
    assert.equal(h.manager.selectForNewAssignment(), null);
    assert.equal((await h.ask()).status, 503);
    assert.equal(h.seen.length, 1);
  });

  it('does not use an unrelated Fable reset as the deadline of a non-Fable rejection', async () => {
    const h = await fixture();
    h.state.status = 429; h.state.headers = false;
    h.state.extraHeaders = {
      'retry-after': '1200',
      'anthropic-ratelimit-unified-7d-fable-utilization': '1',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + 7 * 24 * HOUR) / 1000),
    };
    assert.equal((await h.ask()).status, 429);
    const status = h.manager.quotaRecovery.inspect(h.manager.quotaRecoveryKey(h.manager.find('sample-a')),
      h.manager.quotaRecoveryIdentity(h.manager.find('sample-a')));
    assert.equal(status.nextAllowedAt, START + 1200 * 1000);
  });
});

describe('recovery budgets after asynchronous preparation', () => {
  const MINUTE = 60_000;
  const DELAY = 5 * MINUTE;
  function delayPreparation(h, kind) {
    let delayed = false;
    const delay = async () => {
      if (delayed) return;
      delayed = true;
      await new Promise(resolve => setImmediate(resolve));
      h.clock.ms += DELAY;
    };
    if (kind === 'persistence') h.state.writer = async snapshot => { if (snapshot.quotaRecovery?.pending) await delay(); };
    else if (kind === 'credential read') h.state.beforeCredentialRead = async () => {
      if (h.events.includes('persist-pending')) await delay();
    };
    else {
      const updated = { accessToken: randomUUID(), expiresAt: Date.now() + 24 * HOUR };
      h.secrets.push(updated.accessToken);
      h.state.refresh = async () => { await delay(); return updated; };
    }
    h.state.headers = false;
  }

  for (const policy of ['plan', 'urgency']) {
    for (const kind of ['persistence', 'credential read', 'credential refresh']) {
      const options = { policy, ...(kind === 'credential refresh' ? { refreshable: true, credentialExpiry: 'expired' } : {}) };
      it(`keeps actual recovery sends sixty seconds apart after delayed ${kind} (${policy})`, async () => {
        const h = await fixture({ ...options, count: 2 });
        delayPreparation(h, kind);
        assert.equal((await h.ask()).status, 200);
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'no-quota');
        assert.deepEqual(h.sendTimes, [START + DELAY]);
        assert.equal((await h.ask()).status, 503);
        assert.equal(h.seen.length, 1);
        h.clock.ms = START + DELAY + MINUTE - 1;
        assert.equal((await h.ask()).status, 503);
        assert.equal(h.seen.length, 1);
        h.clock.ms++;
        assert.equal((await h.ask()).status, 200);
        assert.deepEqual(h.sendTimes, [START + DELAY, START + DELAY + MINUTE]);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 2);
      });

      it(`keeps actual account sends fifteen minutes apart after delayed ${kind} (${policy})`, async () => {
        const h = await fixture(options);
        delayPreparation(h, kind);
        assert.equal((await h.ask()).status, 200);
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'no-quota');
        assert.deepEqual(h.sendTimes, [START + DELAY]);
        h.clock.ms = START + 15 * MINUTE;
        assert.equal((await h.ask()).status, 503);
        assert.equal(h.seen.length, 1);
        h.clock.ms = START + DELAY + 15 * MINUTE - 1;
        assert.equal((await h.ask()).status, 503);
        h.clock.ms++;
        assert.equal((await h.ask()).status, 200);
        assert.deepEqual(h.sendTimes, [START + DELAY, START + DELAY + 15 * MINUTE]);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 2);
      });
    }

    it(`keeps delayed actual sends within two per rolling hour (${policy})`, async () => {
      const h = await fixture({ policy });
      h.state.headers = false;
      const delayed = new Set();
      h.state.writer = async snapshot => {
        const id = snapshot.quotaRecovery?.pending?.id;
        if (!id || delayed.has(id)) return;
        delayed.add(id);
        await new Promise(resolve => setImmediate(resolve));
        h.clock.ms += id === 1 ? 20 * MINUTE : id === 2 ? 15 * MINUTE : 0;
      };
      assert.equal((await h.ask()).status, 200);
      await until(() => h.manager.exportState().quotaRecovery.accounts[0]?.lastResult === 'no-quota');
      h.clock.ms = START + 35 * MINUTE;
      assert.equal((await h.ask()).status, 200);
      await until(() => h.manager.exportState().quotaRecovery.pending === null);
      assert.deepEqual(h.sendTimes, [START + 20 * MINUTE, START + 50 * MINUTE]);
      h.clock.ms = START + HOUR;
      assert.equal((await h.ask()).status, 503);
      assert.equal(h.seen.length, 2);
      h.clock.ms = START + 80 * MINUTE - 1;
      assert.equal((await h.ask()).status, 503);
      h.clock.ms++;
      assert.equal((await h.ask()).status, 200);
      assert.deepEqual(h.sendTimes, [START + 20 * MINUTE, START + 50 * MINUTE, START + 80 * MINUTE]);
      assert.equal(h.manager.exportState().quotaRecovery.sequence, 3);
    });

    it(`persists the pool wait after a delayed save and a completed recovery send (${policy})`, async () => {
      const h = await fixture({ policy, count: 2 });
      h.state.headers = false;
      const directory = await mkdtemp(join(tmpdir(), 'quota-recovery-send-time-'));
      const path = join(directory, 'runtime-state.json');
      const durableWriter = createRuntimeStateWriter(path);
      let delayed = false;
      let committed = false;
      h.state.writer = async snapshot => {
        if (snapshot.quotaRecovery?.pending && !delayed) {
          delayed = true;
          await new Promise(resolve => setImmediate(resolve));
          h.clock.ms += DELAY;
        }
        await durableWriter(snapshot);
        if (snapshot.quotaRecovery?.pending === null && snapshot.quotaRecovery.accounts[0]?.lastResult === 'no-quota') committed = true;
      };
      assert.equal((await h.ask()).status, 200);
      await until(() => committed);
      assert.deepEqual(h.sendTimes, [START + DELAY]);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      const restarted = await fixture({ policy, count: 2, restoredState: saved, startAt: START + DELAY + MINUTE - 1 });
      restarted.state.headers = false;
      assert.equal((await restarted.ask()).status, 503);
      assert.equal(restarted.seen.length, 0);
      restarted.clock.ms++;
      assert.equal((await restarted.ask()).status, 200);
      assert.deepEqual(restarted.sendTimes, [START + DELAY + MINUTE]);
      assert.equal(restarted.manager.exportState().quotaRecovery.sequence, 2);
    });
  }
});

describe('recovery entry after an ordinary upstream send', () => {
  for (const policy of ['plan', 'urgency']) {
    for (const [name, errorFactory] of [
      ['relogin refusal', () => Object.assign(new Error('fixture relogin required'), { code: 'NATIVE_REFRESH_REAUTH_REQUIRED' })],
      ['refresh rate limit', () => new OAuthTokenRefreshError({ status: 429, code: 'rate_limit_error',
        retryAfterMs: 120_000, retryAfterSource: 'provider' })],
      ['unknown refresh result', () => Object.assign(new Error('fixture refresh outcome unknown'), { code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN' })],
    ]) {
      it(`does not recover through another account after an ordinary 401 and ${name} (${policy})`, async () => {
        const h = await fixture({ policy, count: 2, refreshable: true });
        h.manager.applyUsage('sample-a', { seven_day: {
          utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString(),
        } });
        h.state.headers = false;
        h.state.onRequest = async () => { h.state.status = h.seen.length === 1 ? 401 : 200; };
        h.state.refresh = async () => { throw errorFactory(); };
        const response = await h.ask();
        assert.equal(h.seen.length, 1, 'an ordinary upstream send must close recovery entry for this logical request');
        assert.equal(response.status, 503);
        assert.equal(h.refreshCalls(), 1);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 0);
        assert.deepEqual(h.manager.exportState().quotaRecovery.accounts, []);
        assert.equal((await h.ask()).status, 200, 'a later logical request may recover the still-unknown account');
        assert.equal(h.seen.length, 2);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 1);
      });
    }

    it(`still permits recovery when credential resolution failed before any upstream send (${policy})`, async () => {
      const h = await fixture({ policy, count: 2 });
      h.manager.applyUsage('sample-a', { seven_day: {
        utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString(),
      } });
      await h.store.delete('sample-a');
      assert.equal((await h.ask()).status, 200);
      assert.equal(h.seen.length, 1);
      assert.equal(h.manager.find('sample-a').errorReason?.type, 'credential_missing');
      assert.equal(h.manager.exportState().quotaRecovery.sequence, 1);
    });
  }
});

describe('response mapping on quota recovery requests', () => {
  const rateBody = Buffer.from('{\n "type":"error", "error":{"type":"rate_limit_error","message":"fixture 429"} }\n');
  const overloadBody = Buffer.from('{\n "type":"error", "error":{"type":"overloaded_error","message":"fixture overloaded"} }\n');
  const replyHeaders = {
    'content-type': 'application/json',
    'date': new Date(START).toUTCString(),
    'request-id': 'fixture-mapping-response',
    'retry-after': '1200',
    'anthropic-ratelimit-unified-reset': String((START + 2 * HOUR) / 1000),
  };
  const mapping = { enabled: true, upstreamOverloadTo429: true, upstreamOverloadRetryAfterSeconds: 7 };
  function reply(h, status, body) {
    h.state.status = status;
    h.state.headers = false;
    h.state.rawBody = body;
    h.state.extraHeaders = { ...replyHeaders, 'content-length': String(body.length) };
  }
  function makeOrdinary(h) {
    h.manager.applyUsage('sample-a', { seven_day: {
      utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString(),
    } });
  }

  for (const policy of ['plan', 'urgency']) {
    it(`maps a recovery 429 exactly like an ordinary request without remapping its synthetic 529 (${policy})`, async () => {
      const ordinary = await fixture({ policy, degradeMapping: mapping });
      makeOrdinary(ordinary);
      reply(ordinary, 429, rateBody);
      const baseline = await ordinary.ask();
      assert.equal(baseline.status, 529);

      const h = await fixture({ policy, degradeMapping: mapping });
      reply(h, 429, rateBody);
      const response = await h.ask();
      assert.equal(response.status, 529);
      assert.deepEqual(response.headers, baseline.headers);
      assert.ok(response.bodyBytes.equals(baseline.bodyBytes));
      assert.equal(response.body.error.type, 'overloaded_error');
      assert.equal(response.body.error.message, 'All Claude accounts are exhausted.');
      assert.equal(response.headers['x-claude-rotator-reason'], 'quota_exhausted');
      assert.equal(ordinary.seen.length, 1);
      assert.equal(h.seen.length, 1);
      assert.equal(ordinary.manager.exportState().quotaRecovery.sequence, 0);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
      assert.equal(h.manager.exportState().quotaRecovery.accounts[0].blockedUntil, START + 2 * HOUR);
      assert.equal(h.manager.find('sample-a').rateLimitedUntil, START + 2 * HOUR);
      assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    });

    it(`maps an upstream recovery 529 exactly like an ordinary request without learning a 429 hold (${policy})`, async () => {
      const ordinary = await fixture({ policy, degradeMapping: mapping });
      makeOrdinary(ordinary);
      reply(ordinary, 529, overloadBody);
      const baseline = await ordinary.ask();
      assert.equal(baseline.status, 429);

      const h = await fixture({ policy, degradeMapping: mapping });
      reply(h, 529, overloadBody);
      const response = await h.ask();
      assert.equal(response.status, 429);
      assert.deepEqual(response.headers, baseline.headers);
      assert.ok(response.bodyBytes.equals(baseline.bodyBytes));
      assert.equal(response.body.error.type, 'rate_limit_error');
      assert.equal(response.body.error.message, 'The Claude upstream is overloaded. Retrying automatically.');
      assert.equal(response.headers['retry-after'], '7');
      assert.equal(Object.keys(response.headers).some(key => key.startsWith('anthropic-ratelimit-')), false);
      assert.equal(h.seen.length, 1);
      assert.equal(ordinary.seen.length, 1);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'transport-error');
      const saved = h.manager.exportState().quotaRecovery;
      assert.equal(saved.accounts[0].blockedUntil, null);
      assert.equal(h.manager.find('sample-a').rateLimitedUntil, null);
      assert.equal(saved.accounts[0].starts.length, 1);
    });

    for (const change of ['same-settings replacement', 'account removal']) {
      for (const [setting, settings, expectedStatus] of [
        ['enabled', mapping, 429],
        ['independently enabled', { ...mapping, enabled: false }, 429],
        ['disabled', { ...mapping, upstreamOverloadTo429: false }, 529],
      ]) {
        it(`keeps ${setting} overload mapping after ${change} during recovery (${policy})`, async () => {
          const replace = h => h.manager.replaceAccounts(change === 'account removal'
            ? [] : h.accounts.map(account => ({ ...account })));
          const ordinary = await fixture({ policy, degradeMapping: settings });
          makeOrdinary(ordinary);
          reply(ordinary, 529, overloadBody);
          ordinary.state.onRequest = async () => replace(ordinary);
          ordinary.state.extraHeaders['anthropic-ratelimit-unified-7d-utilization'] = '0.99';
          ordinary.state.extraHeaders['anthropic-ratelimit-unified-7d-reset'] = String((START + 2 * HOUR) / 1000);
          const baseline = await ordinary.ask();
          assert.equal(baseline.status, expectedStatus);

          const h = await fixture({ policy, degradeMapping: settings });
          reply(h, 529, overloadBody);
          h.state.onRequest = async () => replace(h);
          h.state.extraHeaders['anthropic-ratelimit-unified-7d-utilization'] = '0.99';
          h.state.extraHeaders['anthropic-ratelimit-unified-7d-reset'] = String((START + 2 * HOUR) / 1000);
          const response = await h.ask();
          assert.equal(response.status, expectedStatus);
          assert.deepEqual(response.headers, baseline.headers);
          assert.ok(response.bodyBytes.equals(baseline.bodyBytes));
          assert.equal(h.seen.length, 1);
          assert.equal(ordinary.seen.length, 1);
          if (expectedStatus === 429) {
            assert.equal(response.headers['retry-after'], '7');
            assert.equal(Object.keys(response.headers).some(key => key.startsWith('anthropic-ratelimit-')), false);
          } else {
            assert.equal(response.headers['retry-after'], '1200');
            assert.ok(response.bodyBytes.equals(overloadBody));
          }
          await until(() => h.manager.exportState().quotaRecovery.accounts[0]?.lastResult === 'identity-changed');
          const saved = h.manager.exportState().quotaRecovery;
          assert.equal(saved.pending, null);
          assert.equal(saved.sequence, 1);
          assert.equal(saved.accounts[0].blockedUntil, null);
          assert.equal(saved.accounts[0].deniedIdentity, null);
          assert.deepEqual(saved.accounts[0].starts, [START]);
          if (change === 'account removal') assert.equal(h.manager.accounts.length, 0);
          else {
            assert.equal(h.manager.find('sample-a').quota.unified7d, null, 'the stale response must not update the replacement account');
            assert.equal(h.manager.find('sample-a').rateLimitedUntil, null);
          }
        });
      }
    }

    for (const [model, commonWeek, expectedStatus] of [
      ['claude-fable-5', true, 529],
      ['sonnet', false, 429],
    ]) {
      it(`keeps request-family mapping semantics for ${model} with another Fable-stopped account (${policy})`, async () => {
        const h = await fixture({ policy, count: 2, degradeMapping: mapping });
        h.manager.applyUsage('sample-1', {
          ...(commonWeek ? { seven_day: {
            utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString(),
          } } : {}),
          scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1,
            resets_at: new Date(START + 24 * HOUR).toISOString() }],
        });
        assert.equal(h.manager.isAvailable(h.manager.find('sample-1'), 'fable'), false);
        assert.equal(h.manager.isAvailable(h.manager.find('sample-1'), null), true);
        reply(h, 429, rateBody);
        const response = await h.ask({ model, messages: [{ role: 'user', content: 'fixture request' }] });
        assert.equal(response.status, expectedStatus);
        if (expectedStatus === 529) assert.equal(response.headers['x-claude-rotator-reason'], 'quota_exhausted');
        else assert.ok(response.bodyBytes.equals(rateBody));
        assert.equal(h.seen.length, 1, 'mapping must not add a second recovery attempt');
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
        assert.equal(h.manager.exportState().quotaRecovery.accounts.length, 1);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }

    it(`keeps a configured exhaustion passthrough response unchanged (${policy})`, async () => {
      const h = await fixture({ policy, degradeMapping: { ...mapping, claudeExhaustedTo529: false } });
      reply(h, 429, rateBody);
      const response = await h.ask();
      assert.equal(response.status, 429);
      assert.ok(response.bodyBytes.equals(rateBody));
      assert.equal(response.headers['x-claude-rotator-reason'], undefined);
      assert.equal(h.seen.length, 1);
    });

    it(`uses independently enabled overload mapping with exhaustion mapping off (${policy})`, async () => {
      const h = await fixture({ policy, degradeMapping: { ...mapping, enabled: false } });
      reply(h, 529, overloadBody);
      const response = await h.ask();
      assert.equal(response.status, 429);
      assert.equal(response.headers['retry-after'], '7');
      assert.equal(response.body.error.type, 'rate_limit_error');
      assert.equal(h.seen.length, 1);
    });

    for (const [mode, settings] of [['unset', null], ['off', { enabled: false, upstreamOverloadTo429: false }]]) {
      for (const [status, body] of [[429, rateBody], [529, overloadBody]]) {
        it(`preserves raw ${status} response bytes with mapping ${mode} (${policy})`, async () => {
          const h = await fixture({ policy, degradeMapping: settings });
          reply(h, status, body);
          const response = await h.ask();
          assert.equal(response.status, status);
          assert.ok(response.bodyBytes.equals(body));
          for (const [key, value] of Object.entries(replyHeaders)) assert.equal(response.headers[key], value);
          assert.equal(response.headers['content-length'], String(body.length));
          assert.equal(response.headers['x-claude-rotator-reason'], undefined);
          assert.equal(h.seen.length, 1);
          await until(() => h.manager.getStatus().quotaRecovery.lastResult === (status === 429 ? 'rate-limit' : 'transport-error'));
          assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
        });
      }
    }

    it(`does not map an upstream 529 whose body is not overloaded_error (${policy})`, async () => {
      const h = await fixture({ policy, degradeMapping: mapping });
      const body = Buffer.from('{ "type":"error", "error":{"type":"api_error","message":"fixture temporary error"} }\n');
      reply(h, 529, body);
      const response = await h.ask();
      assert.equal(response.status, 529);
      assert.ok(response.bodyBytes.equals(body));
      assert.equal(response.headers['retry-after'], '1200');
      assert.equal(h.seen.length, 1);
    });

    it(`does not map an overloaded 529 when only exhaustion mapping is enabled (${policy})`, async () => {
      const h = await fixture({ policy, degradeMapping: { ...mapping, upstreamOverloadTo429: false } });
      reply(h, 529, overloadBody);
      const response = await h.ask();
      assert.equal(response.status, 529);
      assert.ok(response.bodyBytes.equals(overloadBody));
      assert.equal(response.headers['retry-after'], '1200');
      assert.equal(h.seen.length, 1);
    });
  }
});

describe('OAuth refresh before quota recovery', () => {
  function refreshedCredential(h) {
    const value = randomUUID();
    h.secrets.push(value);
    h.state.credentialCheck = headers => headers.authorization === `Bearer ${value}`;
    return { accessToken: value, expiresAt: Date.now() + 24 * HOUR };
  }

  for (const policy of ['plan', 'urgency']) {
    for (const credentialExpiry of ['expired', 'soon']) {
      it(`refreshes an ${credentialExpiry} OAuth credential after persistence and before one send (${policy})`, async () => {
        const h = await fixture({ policy, refreshable: true, credentialExpiry });
        const updated = refreshedCredential(h);
        h.state.refresh = async () => updated;
        assert.equal(h.refreshCalls(), 0);
        assert.equal((await h.ask()).status, 200);
        assert.equal(h.seen.length, 1);
        assert.deepEqual(h.state.credentialAccepted, [true]);
        assert.equal(h.refreshCalls(), 1);
        assert.ok(h.events.indexOf('persist-pending') >= 0);
        assert.ok(h.events.indexOf('persist-pending') < h.events.indexOf('refresh'));
        assert.ok(h.events.indexOf('refresh') < h.events.indexOf('upstream'));
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
        const output = JSON.stringify(h.manager.getStatus()) + JSON.stringify(h.manager.exportState()) + h.logs.join('');
        for (const value of h.secrets) assert.equal(output.includes(value), false, 'credential values must stay in memory');
      });
    }

    for (const scenario of ['apikey', 'unobserved']) {
      it(`does not refresh an unnecessary ${scenario} credential (${policy})`, async () => {
        const h = await fixture({ policy, scenario, refreshable: true });
        assert.equal((await h.ask()).status, 200);
        assert.equal(h.seen.length, 1);
        assert.equal(h.refreshCalls(), 0);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }

    it(`does not refresh or send an expired credential when the pending save fails (${policy})`, async () => {
      const h = await fixture({ policy, refreshable: true, credentialExpiry: 'expired' });
      h.state.refresh = async () => assert.fail('refresh must follow durable reservation');
      h.state.writer = async () => { throw new Error('fixture pending save failed'); };
      assert.equal((await h.ask()).status, 503);
      assert.equal(h.refreshCalls(), 0);
      assert.equal(h.seen.length, 0);
      assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    });

    for (const [name, errorFactory, expectedType, expectedCause] of [
      ['rate limit', () => new OAuthTokenRefreshError({ status: 429, code: 'rate_limit_error',
        retryAfterMs: 120_000, retryAfterSource: 'provider' }), 'oauth_refresh_rate_limit', null],
      ['relogin required', () => Object.assign(new Error('fixture relogin required'),
        { code: 'NATIVE_REFRESH_REAUTH_REQUIRED' }), 'oauth_refresh_failed', 'NATIVE_REFRESH_REAUTH_REQUIRED'],
      ['unknown result', () => Object.assign(new Error('fixture refresh outcome unknown'),
        { code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN' }), 'oauth_refresh_failed', 'NATIVE_REFRESH_OUTCOME_UNKNOWN'],
    ]) {
      for (const credentialExpiry of ['expired', 'usable-soon']) {
        it(`keeps a refresh ${name} in the existing owner flow without any upstream send (${policy}, ${credentialExpiry})`, async () => {
          const h = await fixture({ policy, count: 2, refreshable: true, credentialExpiry });
          h.state.refresh = async () => { throw errorFactory(); };
          const response = await h.ask();
          assert.equal(h.seen.length, 0);
          assert.equal(response.status, 503);
          assert.equal(h.refreshCalls(), 1);
          const account = h.manager.find('sample-a');
          const reason = h.manager.unavailableReasonForModelFamily(account);
          assert.equal(reason?.type, expectedType);
          if (expectedCause) assert.equal(reason?.cause, expectedCause);
          if (name === 'rate limit') assert.ok(account.rateLimitedUntil >= START + 120_000);
          assert.equal((await h.ask()).status, 503);
          assert.equal(h.seen.length, 0, 'the same request and the pool interval must not trigger another account');
          assert.equal(h.refreshCalls(), 1);
          assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
        });
      }
    }

    it(`does not refresh again or retry another account after the refreshed request gets 401 (${policy})`, async () => {
      const h = await fixture({ policy, count: 2, refreshable: true, credentialExpiry: 'expired' });
      const updated = refreshedCredential(h);
      h.state.refresh = async () => updated;
      h.state.status = 401; h.state.headers = false;
      assert.equal((await h.ask()).status, 401);
      assert.equal(h.seen.length, 1);
      assert.equal(h.refreshCalls(), 1);
      assert.deepEqual(h.state.credentialAccepted, [true]);
      assert.equal(h.manager.find('sample-a').errorReason?.type, 'authentication_error');
      assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    });

    for (const change of ['revision', 'removal', 'Fable stop', '429 hold']) {
      it(`rechecks a ${change} after asynchronous credential refresh (${policy})`, async () => {
        const h = await fixture({ policy, refreshable: true, credentialExpiry: 'expired' });
        const updated = refreshedCredential(h);
        h.state.refresh = async () => {
          await new Promise(resolve => setImmediate(resolve));
          if (change === 'revision') h.manager.replaceAccounts([{ ...h.accounts[0], credentialRevision: 2 }]);
          else if (change === 'removal') h.manager.replaceAccounts([]);
          else if (change === 'Fable stop') h.manager.updateQuota('sample-a', {
            'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
            'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
          });
          else h.manager.markRateLimited('sample-a', 2 * HOUR / 1000);
          return updated;
        };
        const response = await h.ask({ model: 'claude-fable-5', messages: [{ role: 'user', content: 'fixture request' }] });
        assert.equal(h.seen.length, 0, 'a changed identity or stop must be checked after refresh');
        assert.ok([429, 503].includes(response.status));
        assert.equal(h.refreshCalls(), 1);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 1);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }

    it(`uses an ordinary candidate that appears during refresh without a second recovery reservation (${policy})`, async () => {
      const h = await fixture({ policy, refreshable: true, credentialExpiry: 'expired' });
      const updated = refreshedCredential(h);
      h.state.refresh = async () => {
        await new Promise(resolve => setImmediate(resolve));
        h.manager.applyUsage('sample-a', { seven_day: {
          utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString(),
        } });
        return updated;
      };
      assert.equal((await h.ask()).status, 200);
      assert.equal(h.seen.length, 1);
      assert.equal(h.refreshCalls(), 1);
      assert.deepEqual(h.state.credentialAccepted, [true]);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'aborted');
      assert.equal(h.manager.exportState().quotaRecovery.sequence, 1);
    });

    it(`does not send when the client disconnects during refresh (${policy})`, async () => {
      const h = await fixture({ policy, refreshable: true, credentialExpiry: 'expired' });
      const updated = refreshedCredential(h);
      const disconnected = new Promise(resolve => {
        h.proxy.server.once('request', (incoming, res) => {
          incoming.once('aborted', resolve);
          res.once('close', resolve);
        });
      });
      await new Promise(resolve => {
        const req = http.request(h.proxy.url + '/v1/messages', { method: 'POST' }, res => {
          res.resume();
          res.once('end', resolve);
        });
        req.once('error', resolve);
        req.once('close', resolve);
        h.state.refresh = async () => {
          req.destroy();
          await disconnected;
          return updated;
        };
        req.end(JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'fixture request' }] }));
      });
      assert.equal(h.seen.length, 0);
      assert.equal(h.refreshCalls(), 1);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'aborted');
      assert.equal(h.manager.exportState().quotaRecovery.sequence, 1);
      assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
    });
  }
});

describe('recovery responses during a clock rollback', () => {
  for (const policy of ['plan', 'urgency']) {
    for (const [name, headers, waitMs] of [
      ['unknown deadline', {}, HOUR],
      ['known reset', { 'anthropic-ratelimit-unified-reset': String((START + 2 * HOUR) / 1000) }, 2 * HOUR],
    ]) {
      for (const restart of [false, true]) {
        it(`settles a ${name} 429 during rollback and resumes with restart=${restart} (${policy})`, async () => {
          const first = await fixture({ policy });
          let writes = 0;
          first.state.writer = async () => { writes++; };
          first.state.status = 429; first.state.headers = false; first.state.extraHeaders = headers;
          first.state.onRequest = async () => { first.clock.ms--; };
          assert.equal((await first.ask()).status, 429);
          await until(() => writes >= 2);
          const saved = first.snapshots.at(-1);
          assert.equal(saved.quotaRecovery.pending, null, 'clock waiting must not lose the completed response');
          assert.equal(saved.quotaRecovery.lastSeenAt, START);
          assert.equal(saved.quotaRecovery.sequence, 1);
          assert.deepEqual(saved.quotaRecovery.accounts[0].starts, [START]);
          assert.equal(saved.quotaRecovery.accounts[0].lastResult, 'rate-limit');
          assert.ok(saved.quotaRecovery.accounts[0].blockedUntil >= START + waitMs,
            'the hold must use the last confirmed time instead of the rolled-back wall clock');

          const active = restart
            ? await fixture({ policy, restoredState: saved, startAt: START - 1 }) : first;
          const seen = active.seen.length;
          active.state.onRequest = null;
          active.state.status = 200; active.state.headers = false; active.state.extraHeaders = {};
          assert.equal((await active.ask()).status, 503);
          assert.equal(active.seen.length, seen);
          active.clock.ms = START + waitMs - 1;
          assert.equal((await active.ask()).status, 503);
          assert.equal(active.seen.length, seen);
          active.clock.ms = START + waitMs + 1000;
          assert.equal((await active.ask()).status, 200);
          assert.equal(active.seen.length, seen + 1);
          assert.equal(active.manager.exportState().quotaRecovery.sequence, 2);
        });
      }
    }
  }
});

describe('recovery rejection holds across observations and restarts', () => {
  const freshUsage = () => ({
    seven_day: { utilization: 0.2, resets_at: new Date(START + 24 * HOUR).toISOString() },
    five_hour: { utilization: 0.2, resets_at: new Date(START + 5 * HOUR).toISOString() },
    scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 0.2,
      resets_at: new Date(START + 24 * HOUR).toISOString() }],
  });
  const rejectedWindows = [
    ['common five-hour', 'sonnet', {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String((START + 2 * HOUR) / 1000),
    }],
    ['common weekly', 'sonnet', {
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String((START + 2 * HOUR) / 1000),
    }],
    ['Fable weekly', 'claude-fable-5', {
      'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
      'anthropic-ratelimit-unified-7d-fable-reset': String((START + 2 * HOUR) / 1000),
    }],
  ];

  for (const policy of ['plan', 'urgency']) {
    for (const [name, model, headers] of rejectedWindows) {
      it(`blocks ordinary sends after a ${name} recovery 429 and fresh quota (${policy})`, async () => {
        const h = await fixture({ policy, count: 2 });
        h.state.status = 429; h.state.headers = false; h.state.extraHeaders = headers;
        const body = { model, messages: [{ role: 'user', content: 'fixture request' }] };
        assert.equal((await h.ask(body)).status, 429);
        assert.equal(h.seen.length, 1, 'the original request must not try another recovery account');
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
        h.manager.applyUsage('sample-a', freshUsage());
        h.state.status = 200; h.state.extraHeaders = {};
        const response = await h.ask(body);

        assert.equal(h.seen.length, 1, 'fresh quota must not release the unresolved upstream 429');
        assert.equal(response.status, 503);
        assert.equal(h.manager.selectForNewAssignment({ modelFamily: model === 'sonnet' ? null : 'fable' }), null);
        assert.equal(h.manager.find('sample-a').rateLimitedUntil, START + 2 * HOUR);
        assert.equal(h.manager.exportState().quotaRecovery.accounts[0].starts.length, 1);
      });
    }

    it(`keeps a common recovery rejection held while another Fable limit stays exhausted (${policy})`, async () => {
      const h = await fixture({ policy });
      h.state.status = 429; h.state.headers = false;
      h.state.extraHeaders = { ...rejectedWindows[1][2],
        'anthropic-ratelimit-unified-7d-fable-utilization': '1',
        'anthropic-ratelimit-unified-7d-fable-reset': String((START + 7 * 24 * HOUR) / 1000) };
      assert.equal((await h.ask()).status, 429);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
      h.manager.applyUsage('sample-a', { seven_day: freshUsage().seven_day });
      h.state.status = 200; h.state.extraHeaders = {};
      const response = await h.ask();
      assert.equal(h.seen.length, 1, 'a Fable-only stop must not mask the common rejection');
      assert.equal(response.status, 503);
      assert.equal(h.manager.find('sample-a').quota.weeklyScoped.find(limit => limit.key === 'fable')?.utilization, 1);
      assert.equal(h.manager.find('sample-a').rateLimitedUntil, START + 2 * HOUR);
    });

    it(`holds a known exhausted account as soon as recovery 429 headers arrive (${policy})`, async () => {
      const h = await fixture({ policy });
      h.state.status = 429; h.state.headers = false;
      h.state.extraHeaders = rejectedWindows[0][2];
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      h.state.afterHead = () => gate;
      const pending = h.ask();
      try {
        await until(() => h.manager.find('sample-a').quota.unified5h === 1);
        assert.equal(h.manager.find('sample-a').rateLimitedUntil, START + 2 * HOUR);
        h.manager.applyUsage('sample-a', freshUsage());
        assert.equal(h.manager.selectForNewAssignment(), null);
      } finally {
        release();
        await pending;
      }
    });

    it(`does not shorten a longer hold learned while recovery is in flight (${policy})`, async () => {
      const h = await fixture({ policy, count: 2 });
      h.state.status = 429; h.state.headers = false; h.state.extraHeaders = { 'retry-after': '120' };
      h.state.onRequest = async () => h.manager.markRateLimited('sample-a', 3 * HOUR / 1000);
      assert.equal((await h.ask()).status, 429);
      await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
      const account = h.manager.find('sample-a');
      assert.equal(h.seen.length, 1);
      assert.equal(account.rateLimitedUntil, START + 3 * HOUR);
      const info = h.manager.quotaRecovery.inspect(h.manager.quotaRecoveryKey(account),
        h.manager.quotaRecoveryIdentity(account));
      assert.equal(info.nextAllowedAt, START + 3 * HOUR);
    });

    for (const [offset, allowed] of [[2 * HOUR - 1, false], [2 * HOUR, true], [2 * HOUR + 1, true]]) {
      it(`respects a known recovery 429 deadline at offset ${offset}ms (${policy})`, async () => {
        const h = await fixture({ policy });
        h.state.status = 429; h.state.headers = false; h.state.extraHeaders = rejectedWindows[1][2];
        assert.equal((await h.ask()).status, 429);
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
        h.clock.ms = START + offset;
        h.manager.applyUsage('sample-a', freshUsage());
        h.state.status = 200; h.state.extraHeaders = {};
        const response = await h.ask();
        assert.equal(response.status, allowed ? 200 : 503);
        assert.equal(h.seen.length, allowed ? 2 : 1);
        assert.equal(h.manager.exportState().quotaRecovery.sequence, 1, 'ordinary traffic must not spend a recovery start');
      });
    }

    for (const [name, headers] of [
      ['unknown deadline', {}],
      ['two-hour reset', { 'anthropic-ratelimit-unified-reset': String((START + 2 * HOUR) / 1000) }],
    ]) {
      for (const fresh of [false, true]) {
        it(`keeps a lost ${name} result held after restart with fresh observation=${fresh} (${policy})`, async () => {
          const first = await fixture({ policy });
          let durable = null;
          let failedWrites = 0;
          first.state.writer = async snapshot => {
            if (!durable && snapshot.quotaRecovery?.pending) {
              durable = structuredClone(snapshot);
              return;
            }
            if (durable) {
              failedWrites++;
              throw new Error('fixture settlement save failed');
            }
          };
          first.state.status = 429; first.state.headers = false; first.state.extraHeaders = headers;
          assert.equal((await first.ask()).status, 429);
          await until(() => failedWrites > 0);
          assert.equal(first.seen.length, 1);
          assert.ok(durable?.quotaRecovery.pending, 'only the successful pre-send write is restart evidence');

          for (const elapsed of [15 * 60_000, HOUR]) {
            const restarted = await fixture({ policy, restoredState: durable, startAt: START + elapsed });
            if (fresh) restarted.manager.applyUsage('sample-a', freshUsage());
            const response = await restarted.ask();
            assert.equal(restarted.seen.length, 0, 'a lost 429 result must not become ordinary or recovery traffic');
            assert.equal(response.status, 503);
            assert.equal(restarted.manager.exportState().quotaRecovery.sequence, 1);
            assert.deepEqual(restarted.manager.exportState().quotaRecovery.accounts[0].starts, [START]);
          }
        });
      }
    }

    for (const [name, headers, waitMs] of [
      ['unknown deadline', {}, HOUR],
      ['two-hour reset', { 'anthropic-ratelimit-unified-reset': String((START + 2 * HOUR) / 1000) }, 2 * HOUR],
    ]) {
      it(`restores a committed ${name} hold through its exact boundary (${policy})`, async () => {
        const first = await fixture({ policy });
        let durable = null;
        first.state.writer = async snapshot => { durable = structuredClone(snapshot); };
        first.state.status = 429; first.state.headers = false; first.state.extraHeaders = headers;
        assert.equal((await first.ask()).status, 429);
        await until(() => durable?.quotaRecovery.pending === null
          && durable.quotaRecovery.accounts[0]?.lastResult === 'rate-limit');
        const restarted = await fixture({ policy, restoredState: durable, startAt: START + waitMs - 1 });
        restarted.manager.applyUsage('sample-a', freshUsage());
        assert.equal(restarted.manager.find('sample-a').rateLimitedUntil, START + waitMs);
        assert.equal((await restarted.ask()).status, 503);
        assert.equal(restarted.seen.length, 0);
        restarted.clock.ms++;
        assert.equal((await restarted.ask()).status, 200);
        assert.equal(restarted.seen.length, 1);
        assert.equal(restarted.manager.exportState().quotaRecovery.sequence, 1);
      });
    }
  }
});

describe('quota recovery rejection deadlines', () => {
  const epoch = at => String(at / 1000);
  const healthyWindows = {
    'anthropic-ratelimit-unified-5h-utilization': '0.2',
    'anthropic-ratelimit-unified-5h-reset': epoch(START + 5 * HOUR),
    'anthropic-ratelimit-unified-7d-utilization': '0.25',
    'anthropic-ratelimit-unified-7d-reset': epoch(START + 7 * 24 * HOUR),
  };
  const overlappingRejections = {
    'retry-after': '1200',
    'anthropic-ratelimit-unified-reset': epoch(START + 3 * HOUR),
    'anthropic-ratelimit-unified-5h-utilization': '0.97',
    'anthropic-ratelimit-unified-5h-reset': epoch(START + 2 * HOUR),
    'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
    'anthropic-ratelimit-unified-7d-fable-reset': epoch(START + 4 * HOUR),
  };
  const cases = [
    {
      name: 'ignores healthy five-hour and weekly resets after a short numeric retry-after',
      headers: { ...healthyWindows, 'retry-after': '120' },
      waitMs: 15 * 60_000, checkThrottle: true,
    },
    {
      name: 'ignores healthy windows while honoring an HTTP-date retry-after',
      headers: { ...healthyWindows, 'retry-after': new Date(START + 20 * 60_000).toUTCString() },
      waitMs: 20 * 60_000,
    },
    {
      name: 'ignores healthy windows while honoring an explicit unified rejection reset',
      headers: { ...healthyWindows, 'anthropic-ratelimit-unified-reset': epoch(START + 2 * HOUR) },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses the unknown-429 hold when only healthy windows provide resets',
      headers: healthyWindows,
      waitMs: HOUR,
    },
    {
      name: 'uses the unknown-429 hold for a reset-only window without a claim',
      headers: { 'anthropic-ratelimit-unified-7d-reset': epoch(START + 7 * 24 * HOUR) },
      waitMs: HOUR,
    },
    {
      name: 'does not guess a rejected window from an unknown claim',
      headers: { ...healthyWindows,
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'unrecognized_fixture_window' },
      waitMs: HOUR,
    },
    {
      name: 'keeps an explicit retry-after despite an unknown claim',
      headers: { ...healthyWindows, 'retry-after': '1200',
        'anthropic-ratelimit-unified-representative-claim': 'unrecognized_fixture_window' },
      waitMs: 20 * 60_000,
    },
    {
      name: 'keeps an explicit unified rejection reset despite an unknown claim',
      headers: { ...healthyWindows,
        'anthropic-ratelimit-unified-reset': epoch(START + 2 * HOUR),
        'anthropic-ratelimit-unified-representative-claim': 'unrecognized_fixture_window' },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses an exhausted five-hour window without adding a healthy weekly reset',
      headers: { ...healthyWindows,
        'anthropic-ratelimit-unified-5h-utilization': '0.97',
        'anthropic-ratelimit-unified-5h-reset': epoch(START + 2 * HOUR) },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses an exhausted weekly window without adding a healthy five-hour reset',
      headers: { ...healthyWindows,
        'anthropic-ratelimit-unified-7d-utilization': '0.97',
        'anthropic-ratelimit-unified-7d-reset': epoch(START + 2 * HOUR) },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses the Fable rejection reset for a Fable request',
      headers: {
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
        'anthropic-ratelimit-unified-7d-fable-reset': epoch(START + 2 * HOUR),
      },
      model: 'claude-fable-5', waitMs: 2 * HOUR,
    },
    {
      name: 'leaves an unrelated Fable reset out of a Sonnet rejection',
      headers: {
        'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
        'anthropic-ratelimit-unified-7d-fable-reset': epoch(START + 7 * 24 * HOUR),
      },
      waitMs: HOUR,
    },
    {
      name: 'uses the latest actual rejection deadline for Fable',
      headers: overlappingRejections,
      model: 'claude-fable-5', waitMs: 4 * HOUR,
    },
    {
      name: 'uses the latest common rejection deadline for Sonnet',
      headers: overlappingRejections,
      waitMs: 3 * HOUR,
    },
    {
      name: 'uses a stricter configured threshold to identify a rejected window',
      headers: { ...healthyWindows,
        'anthropic-ratelimit-unified-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': epoch(START + 2 * HOUR) },
      threshold: 0.9, waitMs: 2 * HOUR,
    },
    {
      name: 'uses the unknown-429 hold when all deadline values are malformed',
      headers: {
        'retry-after': 'invalid-fixture',
        'anthropic-ratelimit-unified-reset': 'invalid-fixture',
        'anthropic-ratelimit-unified-5h-reset': 'invalid-fixture',
        'anthropic-ratelimit-unified-7d-reset': 'invalid-fixture',
      },
      waitMs: HOUR,
    },
    {
      name: 'uses the unknown-429 hold when every supplied deadline is past',
      headers: {
        'retry-after': new Date(START - 60_000).toUTCString(),
        'anthropic-ratelimit-unified-reset': epoch(START - 60_000),
        'anthropic-ratelimit-unified-7d-reset': epoch(START - 60_000),
      },
      waitMs: HOUR,
    },
    {
      name: 'does not parse a negative retry-after as an HTTP date',
      headers: { 'retry-after': '-1' },
      waitMs: HOUR,
    },
    {
      name: 'honors a zero retry-after while keeping the account interval',
      headers: { 'retry-after': '0' },
      waitMs: 15 * 60_000,
    },
    {
      name: 'uses a known five-hour rejection claim with its reset',
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-5h-reset': epoch(START + 2 * HOUR),
        'anthropic-ratelimit-unified-7d-utilization': '0.25',
        'anthropic-ratelimit-unified-7d-reset': epoch(START + 7 * 24 * HOUR),
      },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses a known weekly rejection claim with its reset',
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-7d-reset': epoch(START + 2 * HOUR),
        'anthropic-ratelimit-unified-5h-utilization': '0.2',
        'anthropic-ratelimit-unified-5h-reset': epoch(START + 5 * HOUR),
      },
      waitMs: 2 * HOUR,
    },
    {
      name: 'uses a known Fable rejection claim with its reset',
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable',
        'anthropic-ratelimit-unified-7d-fable-reset': epoch(START + 2 * HOUR),
      },
      model: 'claude-fable-5', waitMs: 2 * HOUR,
    },
  ];

  for (const policy of ['plan', 'urgency']) {
    for (const { name, headers, model = 'sonnet', threshold = 1, waitMs, checkThrottle = false } of cases) {
      it(`${name} (${policy})`, async () => {
        const h = await fixture({ policy, count: 2 });
        h.manager.configuredSwitchThreshold = threshold;
        h.manager.configureAccountUrgency({ mode: policy === 'urgency' ? 'on' : 'off' });
        h.state.status = 429;
        h.state.headers = false;
        h.state.extraHeaders = headers;

        const response = await h.ask({ model, messages: [{ role: 'user', content: 'fixture request' }] });
        assert.equal(response.status, 429);
        assert.equal(h.seen.length, 1, 'one request must not recover through a second account');
        await until(() => h.manager.getStatus().quotaRecovery.lastResult === 'rate-limit');
        const account = h.manager.find('sample-a');
        const budget = h.manager.quotaRecovery.inspect(h.manager.quotaRecoveryKey(account),
          h.manager.quotaRecoveryIdentity(account));
        assert.equal(budget.nextAllowedAt, START + waitMs);
        if (checkThrottle) assert.equal(account.rateLimitedUntil, START + waitMs);
        const saved = h.manager.exportState().quotaRecovery;
        assert.equal(saved.accounts.length, 1);
        assert.equal(saved.accounts[0].starts.length, 1);
      });
    }
  }
});
