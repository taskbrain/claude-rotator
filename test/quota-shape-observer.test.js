import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

import { fetchUsage } from '../src/oauth.js';
import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { LOCAL_GATEWAY_AUTH_TOKEN } from '../src/config.js';
import { createProxyServer } from '../src/proxy-server.js';

const observerModule = () => import('../src/quota-shape-observer.js');
const sampleTime = Date.parse('2026-10-31T00:00:00Z');

describe('quota shape observation', () => {
  it('leaves disabled observations unread and emits nothing', async () => {
    const { createQuotaShapeObserver } = await observerModule();
    const observer = createQuotaShapeObserver({ enabled: false, logger: () => assert.fail('disabled log') });
    const unread = new Proxy({}, { get: () => assert.fail('disabled read') });
    observer.headers(unread, unread, unread);
    observer.usage(unread, unread);
  });

  it('records absent, null and zero usage separately with a hashed account', async () => {
    const { createQuotaShapeObserver, projectUsageQuotaShape } = await observerModule();
    const lines = [];
    const observer = createQuotaShapeObserver({ enabled: true, logger: line => lines.push(line), now: () => sampleTime });
    const accountId = 'fixture-account';
    for (const data of [{}, { five_hour: null }, { five_hour: { utilization: 0 }, seven_day: null }]) {
      observer.usage(accountId, { status: 200, shape: projectUsageQuotaShape(data) });
    }
    const events = lines.map(JSON.parse);
    assert.equal(events.length, 3);
    assert.equal(events[0].event, 'quota_shape');
    assert.equal(events[0].account, createHash('sha256').update(accountId).digest('hex').slice(0, 12));
    assert.equal(events[0].time, '2026-10-31T00:00:00.000Z');
    assert.equal(events[0].source, 'usage');
    assert.equal(events[0].status, 200);
    assert.deepEqual(events[0].shape.five_hour, { type: 'missing' });
    assert.deepEqual(events[1].shape.five_hour, { type: 'null' });
    assert.deepEqual(events[2].shape.five_hour.utilization, { type: 'number', value: 0 });
    assert.deepEqual(events[2].shape.seven_day, { type: 'null' });
    assert.equal(lines.join('').includes(accountId), false);
  });

  it('projects only known usage keys, numeric values and scope structure', async () => {
    const { projectUsageQuotaShape } = await observerModule();
    const forbidden = () => assert.fail('unrelated value was read');
    const data = {
      five_hour: { utilization: 97, resets_at: '2026-11-01T00:00:00Z' },
      seven_day_sonnet: { utilization: null },
      seven_day_fable: { percent: 0 },
      seven_day_unknown: { utilization: 80 },
      limits: [
        { kind: 'weekly_scoped', percent: 45, scope: { model: { id: 'untrusted-model', display_name: 'untrusted-label' } } },
        { kind: 'unknown-kind', percent: 99 },
      ],
    };
    Object.defineProperty(data, 'authorization', { enumerable: true, get: forbidden });
    Object.defineProperty(data, 'seven_day_secret', { enumerable: true, get: forbidden });
    Object.defineProperty(data.five_hour, 'token', { enumerable: true, get: forbidden });
    const shape = projectUsageQuotaShape(data);
    assert.deepEqual(shape.five_hour.utilization, { type: 'number', value: 97 });
    assert.deepEqual(shape.five_hour.resets_at, { type: 'number', value: 1793491200 });
    assert.deepEqual(shape.seven_day_sonnet.utilization, { type: 'null' });
    assert.deepEqual(shape.seven_day_fable.percent, { type: 'number', value: 0 });
    assert.equal(shape.limits.length, 1);
    assert.equal(shape.limits[0].kind, 'weekly_scoped');
    assert.deepEqual(shape.limits[0].scope.model.id, { type: 'invalid' });
    assert.equal(JSON.stringify(shape).includes('untrusted'), false);
    assert.equal('seven_day_unknown' in shape, false);
    assert.equal('seven_day_secret' in shape, false);
  });

  it('bounds known structured entries and rejects malformed numeric or reset values', async () => {
    const { projectUsageQuotaShape } = await observerModule();
    const shape = projectUsageQuotaShape({
      five_hour: { utilization: Infinity, resets_at: 'untrusted-reset' },
      seven_day: { utilization: -1, percent: '99' },
      limits: Array.from({ length: 1000 }, () => ({ kind: 'session', percent: 1 })),
    });
    assert.deepEqual(shape.five_hour.utilization, { type: 'invalid' });
    assert.deepEqual(shape.five_hour.resets_at, { type: 'invalid' });
    assert.deepEqual(shape.seven_day.utilization, { type: 'invalid' });
    assert.deepEqual(shape.seven_day.percent, { type: 'invalid' });
    assert.equal(shape.limits.length, 16);
    assert.ok(JSON.stringify(shape).length < 5000);
  });

  it('reads only allowed headers and preserves missing, null, zero and HTTP 429', async () => {
    const { createQuotaShapeObserver } = await observerModule();
    const lines = [];
    const headers = {
      'anthropic-ratelimit-unified-5h-utilization': '0',
      'anthropic-ratelimit-unified-7d-utilization': null,
      'anthropic-ratelimit-unified-5h-reset': '1793491200',
      'anthropic-ratelimit-unified-status': 'untrusted-state',
    };
    for (const key of ['authorization', 'set-cookie', 'anthropic-ratelimit-unified-secret']) {
      Object.defineProperty(headers, key, { enumerable: true, get: () => assert.fail('forbidden header read') });
    }
    const observer = createQuotaShapeObserver({ enabled: true, logger: line => lines.push(line), now: () => sampleTime });
    observer.headers('fixture-account', 429, headers);
    const event = JSON.parse(lines[0]);
    assert.equal(event.status, 429);
    assert.equal(event.source, 'header');
    assert.deepEqual(event.shape['anthropic-ratelimit-unified-5h-utilization'], { type: 'number', value: 0 });
    assert.deepEqual(event.shape['anthropic-ratelimit-unified-7d-utilization'], { type: 'null' });
    assert.deepEqual(event.shape['anthropic-ratelimit-unified-7d-reset'], { type: 'missing' });
    assert.deepEqual(event.shape['anthropic-ratelimit-unified-5h-reset'], { type: 'number', value: 1793491200 });
    assert.equal(lines[0].includes('untrusted'), false);
    assert.equal(lines[0].includes('secret'), false);
  });

  it('deduplicates per account and source until the interval while reporting changes immediately', async () => {
    const { createQuotaShapeObserver, projectUsageQuotaShape } = await observerModule();
    let now = sampleTime;
    const lines = [];
    const observer = createQuotaShapeObserver({ enabled: true, logger: line => lines.push(line), now: () => now, intervalMs: 1000 });
    const observation = { status: 200, shape: projectUsageQuotaShape({ five_hour: null }) };
    observer.usage('one', observation);
    observer.usage('one', observation);
    now += 999;
    observer.usage('one', observation);
    assert.equal(lines.length, 1);
    observer.usage('two', observation);
    observer.headers('one', 200, {});
    assert.equal(lines.length, 3);
    observer.usage('one', { ...observation, status: 429 });
    assert.equal(lines.length, 4);
    observer.usage('one', observation);
    assert.equal(lines.length, 5);
    now += 1000;
    observer.usage('one', observation);
    assert.equal(lines.length, 6);
  });

  it('contains synchronous and asynchronous logger failures', async () => {
    const { createQuotaShapeObserver } = await observerModule();
    for (const logger of [() => { throw new Error('fixture failure'); }, () => Promise.reject(new Error('fixture failure'))]) {
      const observer = createQuotaShapeObserver({ enabled: true, logger });
      assert.doesNotThrow(() => observer.headers('fixture-account', 200, {}));
    }
    await new Promise(resolve => setImmediate(resolve));
  });

  it('revalidates injected callback shapes rather than logging arbitrary callback properties', async () => {
    const { createQuotaShapeObserver } = await observerModule();
    const lines = [];
    const observer = createQuotaShapeObserver({ enabled: true, logger: line => lines.push(line) });
    observer.usage('fixture-account', {
      status: 'untrusted-status',
      shape: {
        unexpected: 'untrusted-property',
        five_hour: { utilization: { type: 'number', value: 'untrusted-value' } },
        limits: [{ kind: 'weekly_scoped', percent: { type: 'number', value: 50 }, scope: { model: { id: { type: 'invalid', value: 'untrusted-model' } } } }],
      },
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes('untrusted'), false);
    assert.deepEqual(JSON.parse(lines[0]).shape.five_hour.utilization, { type: 'invalid' });
    assert.equal(JSON.parse(lines[0]).status, null);
  });

  it('preserves absent header fields through the standard Headers interface', async () => {
    const { createQuotaShapeObserver } = await observerModule();
    const lines = [];
    const observer = createQuotaShapeObserver({ enabled: true, logger: line => lines.push(line) });
    observer.headers('fixture-account', 200, new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0' }));
    const shape = JSON.parse(lines[0]).shape;
    assert.deepEqual(shape['anthropic-ratelimit-unified-5h-utilization'], { type: 'number', value: 0 });
    assert.deepEqual(shape['anthropic-ratelimit-unified-7d-utilization'], { type: 'missing' });
  });
});

describe('fetchUsage quota observation hook', () => {
  it('passes safe raw quota shape before normalization without exposing unrelated response fields', async () => {
    const observations = [];
    const usage = await fetchUsage(randomUUID(), {
      fetchImpl: async () => new Response(JSON.stringify({
        five_hour: { utilization: 0 }, seven_day: null, unexpected: 'untrusted-body',
      }), { status: 200 }),
      onQuotaObservation: observation => observations.push(observation),
    });
    assert.equal(usage.five_hour.utilization, 0);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 200);
    assert.deepEqual(observations[0].shape.seven_day, { type: 'null' });
    assert.equal(JSON.stringify(observations).includes('untrusted'), false);
  });

  it('observes failure status without reading an error body as quota data', async () => {
    const observations = [];
    await assert.rejects(fetchUsage(randomUUID(), {
      fetchImpl: async () => new Response('{}', { status: 429 }),
      onQuotaObservation: observation => observations.push(observation),
    }), /429/);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 429);
    assert.deepEqual(observations[0].shape.five_hour, { type: 'missing' });
  });

  it('keeps usage results unchanged when an observer fails', async () => {
    const usage = await fetchUsage(randomUUID(), {
      fetchImpl: async () => new Response('{"five_hour":{"utilization":50}}', { status: 200 }),
      onQuotaObservation: () => { throw new Error('fixture observer failure'); },
    });
    assert.equal(usage.five_hour.utilization, 0.5);
  });

  it('retains HTTP status when a successful response contains invalid JSON', async () => {
    const observations = [];
    await assert.rejects(fetchUsage(randomUUID(), {
      fetchImpl: async () => new Response('invalid-json', { status: 200 }),
      onQuotaObservation: observation => observations.push(observation),
    }), SyntaxError);
    assert.equal(observations.length, 1);
    assert.equal(observations[0].status, 200);
    assert.deepEqual(observations[0].shape.five_hour, { type: 'missing' });
  });
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

describe('proxy quota observation wiring', () => {
  for (const enabled of [false, true]) {
    it(`observes existing header and usage paths only when enabled=${enabled}`, async t => {
      const upstream = await listen(http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-5h-utilization': '0' });
        res.end('{}');
      }), t);
      const accountManager = new AccountManager({ accounts: [{ id: 'fixture-account', type: 'oauth' }] });
      const secretStore = new MemorySecretStore();
      await secretStore.set('fixture-account', { accessToken: randomUUID() });
      const lines = [];
      let callbacks = 0;
      const proxy = await listen(createProxyServer({
        accountManager, secretStore, allowLiveClaudeCodeCredentials: false,
        config: { upstream, quotaObservation: { enabled }, usagePolling: { enabled: false } },
        logger: line => lines.push(line),
        usageFetcher: async (token, options) => {
          if (options.onQuotaObservation) callbacks++;
          return fetchUsage(token, {
            ...options,
            fetchImpl: async () => new Response('{"five_hour":null,"seven_day":{"utilization":0}}', { status: 200 }),
          });
        },
      }), t);
      const headers = { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`, 'content-type': 'application/json' };
      const forwarded = await fetch(`${proxy}/v1/messages`, { method: 'POST', headers, body: '{"model":"sonnet"}' });
      assert.equal(forwarded.status, 200);
      await forwarded.text();
      const refreshed = await fetch(`${proxy}/internal/refresh-usage`, { method: 'POST', headers, body: '{}' });
      assert.equal(refreshed.status, 200);
      await refreshed.text();
      const events = lines.filter(line => line.startsWith('{')).map(JSON.parse).filter(event => event.event === 'quota_shape');
      assert.equal(callbacks, enabled ? 1 : 0);
      assert.equal(events.length, enabled ? 2 : 0);
      if (enabled) {
        assert.deepEqual(events.map(event => event.source).sort(), ['header', 'usage']);
        assert.equal(events.some(event => event.account === 'fixture-account'), false);
      }
    });
  }
});
