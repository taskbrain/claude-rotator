// The `fiveHourWindow.enabled` switch. Off, the five-hour window is treated as
// absent: it is not judged, shown, saved or written to the request log, while an
// upstream 429 is still honored exactly as before. On (and whenever a component
// is told nothing) everything stays as it was before the switch existed.
//
// Isolation: the upstream is a 127.0.0.1 port-0 test server, credentials are
// in-memory API keys, and the Usage API, credential reads and token refresh are
// stubs. The clock is injected; nothing reaches a real service.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { fiveHourWindowSetting } from '../src/config.js';
import { renderStatus } from '../src/monitor.js';
import { createProxyServer } from '../src/proxy-server.js';
import { MemorySecretStore } from '../src/secret-store.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-01-01T00:00:00Z');
const OFF = { enabled: false };
const ON = { enabled: true };
const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

const iso = ms => new Date(ms).toISOString();
const seconds = ms => String(Math.floor(ms / 1000));
const signals = logs => logs.filter(line => line.includes(' five_hour_signal_while_disabled '));

function ledger({ fiveHourWindow, ids = ['sample-a', 'sample-b', 'sample-c'], urgency = 'off', plan = 'off', clock }) {
  const logs = [];
  const manager = new AccountManager({
    accounts: ids.map(id => ({ id, type: 'apikey' })),
    accountUrgency: { mode: urgency },
    planQuota: { mode: plan },
    ...(fiveHourWindow === undefined ? {} : { fiveHourWindow }),
    now: () => clock.ms,
    logger: line => logs.push(line),
  });
  return { manager, logs };
}

function weekAndFive(clock, weekly, weeklyHours, fiveHour = undefined) {
  return {
    seven_day: { utilization: weekly, resets_at: iso(clock.ms + weeklyHours * HOUR) },
    ...(fiveHour === undefined ? {} : { five_hour: { utilization: fiveHour, resets_at: iso(clock.ms + 2 * HOUR) } }),
  };
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

function request(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: { 'content-type': 'application/json', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startProxy({ manager, upstreamHandler, logs = [], serverOptions = {}, config = {} }) {
  const seen = [];
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.headers['x-api-key']);
      upstreamHandler(req, res);
    });
  }));
  const secretStore = new MemorySecretStore();
  for (const account of manager.accounts) await secretStore.set(account.id, { apiKey: `key-${account.id}` });
  const proxy = await listen(createProxyServer({
    accountManager: manager,
    secretStore,
    config: { upstream: upstream.url, usagePolling: { enabled: false }, proxy: { upstreamConnectRetries: 0 }, ...config },
    logger: line => logs.push(line),
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => null,
    currentProfileFetcher: async () => null,
    usageFetcher: async () => { throw new Error('the Usage API is not reachable in this test'); },
    tokenRefresher: async () => { throw new Error('no token refresh in this test'); },
    ...serverOptions,
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  const send = (headers = {}) => request(`${proxy.url}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { url: proxy.url, seen, logs, send };
}

function okResponse(res, headers = {}) {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({
    id: 'msg_fixture', type: 'message', model: 'claude-sonnet-4-5',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }));
}

describe('five-hour window off', () => {
  it('changes neither the order nor the exclusion for 98% and 92% readings, and logs one signal per account per UTC day', () => {
    const clock = { ms: START };
    const off = ledger({ fiveHourWindow: OFF, urgency: 'on', clock });
    const plain = ledger({ fiveHourWindow: OFF, urgency: 'on', clock });
    for (const [id, weekly, hours, five] of [['sample-a', 0.5, 30, 0.98], ['sample-b', 0.4, 40, 0.92], ['sample-c', 0.3, 50, undefined]]) {
      off.manager.applyUsage(id, weekAndFive(clock, weekly, hours, five));
      off.manager.applyUsage(id, weekAndFive(clock, weekly, hours, five));
      plain.manager.applyUsage(id, weekAndFive(clock, weekly, hours));
    }
    const rows = manager => manager.getStatus().accountUrgency.accounts
      .map(({ accountId, eligible, exclusionReason }) => ({ accountId, eligible, exclusionReason }));
    assert.deepEqual(rows(off.manager), rows(plain.manager));
    assert.ok(rows(off.manager).every(row => row.eligible));
    assert.deepEqual(off.manager.getStatus().accountUrgency.proposedOrder,
      plain.manager.getStatus().accountUrgency.proposedOrder);
    assert.equal(off.manager.selectForNewAssignment().id, plain.manager.selectForNewAssignment().id);

    const lines = signals(off.logs);
    assert.equal(lines.length, 2, lines.join('\n'));
    for (const line of lines) {
      assert.match(line, / five_hour_signal_while_disabled account=[0-9a-f]{12} source=usage$/);
      assert.doesNotMatch(line, /0\.98|0\.92|sample-/);
    }
    clock.ms = Date.parse('2026-01-02T00:00:01Z');
    off.manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 0.98));
    assert.equal(signals(off.logs).length, 3, 'a new UTC day logs the account again');
  });

  it('keeps an account with a 98% header reading available, and logs a header signal once', () => {
    const clock = { ms: START };
    const { manager, logs } = ledger({ fiveHourWindow: OFF, clock });
    const fiveHourHeaders = {
      'anthropic-ratelimit-unified-5h-utilization': '0.98',
      'anthropic-ratelimit-unified-5h-reset': seconds(clock.ms + HOUR),
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': seconds(clock.ms + 48 * HOUR),
    };
    manager.updateQuota('sample-a', fiveHourHeaders);
    manager.updateQuota('sample-a', fiveHourHeaders);
    manager.updateQuota('sample-b', {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    });
    const account = manager.find('sample-a');
    assert.equal(manager.isAvailable(account), true);
    assert.equal(manager.unavailableReason(account), null);
    assert.equal(account.quota.unified5h, null);
    assert.deepEqual(signals(logs).map(line => line.split(' ').at(-1)), ['source=header', 'source=header']);
  });

  it('shows the five-hour window nowhere in GET /internal/status', async () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: OFF, urgency: 'shadow', plan: 'shadow', clock });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 0.6));
    const h = await startProxy({
      manager, upstreamHandler: okResponse,
      config: { planQuota: { mode: 'shadow' }, accountUrgency: { mode: 'shadow' } },
    });
    const status = JSON.parse((await request(`${h.url}/internal/status`)).text);
    assert.deepEqual(status.fiveHourWindow, { enabled: false });
    for (const account of status.accounts) {
      assert.ok(Object.hasOwn(account.quota, 'unified5h') && Object.hasOwn(account.quota, 'unified5hReset'));
      assert.equal(account.quota.unified5h, null);
      assert.equal(account.quota.unified5hReset, null);
    }
    assert.ok(status.quotaWindows.accounts.every(row => row.windows.every(window => window.id !== '5h')));
    assert.ok(status.accountUrgency.accounts.every(row => !Object.hasOwn(row, 'fiveHour')
      && row.windows.every(window => window.id !== '5h')));
    assert.ok(manager.exportState().accounts.every(account => account.quota.unified5h === null
      && !Object.hasOwn(account.windowObservations, '5h')));
  });

  it('waits for the weekly reset in prepare-resume and synthesizes a weekly 429, not a five-hour one', async () => {
    for (const fiveHourWindow of [OFF, ON]) {
      const clock = { ms: START };
      const { manager } = ledger({ fiveHourWindow, ids: ['sample-a'], clock });
      manager.updateQuota('sample-a', {
        'anthropic-ratelimit-unified-5h-utilization': '1',
        'anthropic-ratelimit-unified-5h-reset': seconds(clock.ms + 2 * HOUR),
        'anthropic-ratelimit-unified-7d-utilization': '1',
        'anthropic-ratelimit-unified-7d-reset': seconds(clock.ms + 48 * HOUR),
      });
      const h = await startProxy({ manager, upstreamHandler: okResponse });
      const response = await h.send();
      assert.equal(response.status, 429);
      assert.deepEqual(h.seen, [], 'the exhausted account is answered locally');
      const claim = response.headers['anthropic-ratelimit-unified-representative-claim'];
      const resume = JSON.parse((await request(`${h.url}/internal/prepare-resume`, { method: 'POST', body: '{}' })).text);
      if (fiveHourWindow.enabled) {
        assert.equal(claim, 'five_hour');
        assert.equal(resume.resumeAtEpoch, Math.floor((START + 2 * HOUR) / 1000));
      } else {
        assert.equal(claim, 'seven_day');
        assert.equal(response.headers['anthropic-ratelimit-unified-5h-utilization'], undefined);
        assert.equal(resume.window, '7d');
        assert.equal(resume.resumeAtEpoch, Math.floor((START + 48 * HOUR) / 1000));
      }
    }
  });

  it('leaves the 5h row out of the status screen and u5h=, u5hReset= and g5h= out of the request log', async () => {
    for (const fiveHourWindow of [OFF, ON]) {
      const clock = { ms: START };
      const { manager } = ledger({ fiveHourWindow, ids: ['sample-a'], clock });
      const h = await startProxy({
        manager,
        upstreamHandler: (req, res) => okResponse(res, {
          'anthropic-ratelimit-unified-5h-utilization': '0.4',
          'anthropic-ratelimit-unified-5h-reset': seconds(clock.ms + HOUR),
          'anthropic-ratelimit-unified-7d-utilization': '0.3',
          'anthropic-ratelimit-unified-7d-reset': seconds(clock.ms + 48 * HOUR),
          'anthropic-ratelimit-unified-grace-5h-utilization': '0.5',
        }),
      });
      assert.equal((await h.send()).status, 200);
      let line;
      for (let attempt = 0; attempt < 200 && !line; attempt++) {
        line = h.logs.find(entry => / proxy account=/.test(entry));
        if (!line) await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(line, h.logs.join('\n'));
      const screen = renderStatus(manager.getStatus(), { now: clock.ms, columns: 100 });
      if (fiveHourWindow.enabled) {
        assert.match(line, / u5h=0\.4 u5hReset=\d+ /);
        assert.match(line, / g5h=0\.5 g7d=- /);
        assert.match(screen, /^5h /m);
      } else {
        assert.doesNotMatch(line, /u5h=|u5hReset=|g5h=|g7d=/);
        assert.match(line, / u7d=0\.3 /);
        assert.doesNotMatch(screen, /^5h /m);
        assert.match(screen, /^7d /m);
      }
    }
  });

  it('drops readings on reload to off, starts empty on reload to on, ignores saved readings while off, and reads invalid settings as off', async () => {
    const reported = [];
    assert.deepEqual(fiveHourWindowSetting(undefined, { onInvalid: () => reported.push('absent') }), OFF);
    assert.deepEqual(fiveHourWindowSetting({}, { onInvalid: () => reported.push('empty') }), OFF);
    assert.deepEqual(fiveHourWindowSetting({ enabled: true }, { onInvalid: () => reported.push('true') }), ON);
    assert.deepEqual(fiveHourWindowSetting({ enabled: 'true' }, { onInvalid: () => reported.push('string') }), OFF);
    assert.deepEqual(fiveHourWindowSetting(true, { onInvalid: () => reported.push('boolean section') }), OFF);
    assert.deepEqual(reported, ['string', 'boolean section']);

    const clock = { ms: START };
    const saved = ledger({ fiveHourWindow: ON, plan: 'shadow', clock });
    saved.manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 0.99));
    const state = saved.manager.exportState();
    assert.equal(state.accounts[0].quota.unified5h, 0.99);
    const restored = ledger({ fiveHourWindow: OFF, plan: 'shadow', clock });
    restored.manager.restoreState(state);
    assert.equal(restored.manager.find('sample-a').quota.unified5h, null);
    assert.equal(restored.manager.isAvailable(restored.manager.find('sample-a')), true);
    assert.equal(Object.hasOwn(restored.manager.exportState().accounts[0].windowObservations, '5h'), false);

    const { manager } = ledger({ urgency: 'shadow', clock });
    let next = OFF;
    const h = await startProxy({
      manager, upstreamHandler: okResponse, serverOptions: { reloadFiveHourWindow: async () => next },
      config: { accountUrgency: { mode: 'shadow' } },
    });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 1));
    manager.applyUsage('sample-b', weekAndFive(clock, 0.5, 30, 0.4));
    assert.equal(manager.isAvailable(manager.find('sample-a')), false, 'a component told nothing keeps the window on');
    assert.equal((await request(`${h.url}/internal/reload`, { method: 'POST', body: '{}' })).status, 200);
    assert.equal(manager.fiveHourWindowEnabled, false);
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    assert.equal(manager.find('sample-b').quota.unified5h, null);
    assert.equal(manager.isAvailable(manager.find('sample-a')), false, 'a used-up window stays a hold until its reset');
    assert.equal(manager.isAvailable(manager.find('sample-b')), true);
    assert.equal(manager.unavailableReason(manager.find('sample-a')).type, 'temporary_throttle');
    assert.equal(Object.hasOwn(manager.getStatus().accountUrgency.accounts[0], 'fiveHour'), false);
    next = ON;
    assert.equal((await request(`${h.url}/internal/reload`, { method: 'POST', body: '{}' })).status, 200);
    const row = manager.getStatus().accountUrgency.accounts.find(entry => entry.accountId === 'sample-a');
    assert.equal(row.fiveHour.observationState, 'missing', 'turning the window on starts from nothing');
    assert.equal(manager.find('sample-a').quota.unified5h, null);
    assert.equal(Object.hasOwn(manager.getStatus(), 'fiveHourWindow'), false);
  });
});

describe('five-hour window on', () => {
  it('excludes a 98% reading, keeps an unknown window, and returns the account after the reset', () => {
    const clock = { ms: START };
    for (const fiveHourWindow of [undefined, ON]) {
      const { manager } = ledger({ fiveHourWindow, urgency: 'on', clock });
      manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 0.98));
      manager.applyUsage('sample-b', weekAndFive(clock, 0.4, 40));
      const row = id => manager.getStatus().accountUrgency.accounts.find(entry => entry.accountId === id);
      assert.equal(row('sample-a').exclusionReason, 'five-hour-stop');
      assert.equal(row('sample-b').eligible, true, 'an unknown five-hour window does not exclude');
      assert.equal(row('sample-b').fiveHour.applicability, 'unknown');
      assert.equal(Object.hasOwn(manager.getStatus(), 'fiveHourWindow'), false);
      clock.ms += 2 * HOUR + 1000;
      assert.equal(row('sample-a').eligible, true);
      clock.ms = START;
    }
  });

  it('gives the same status as a ledger that was told nothing', () => {
    const clock = { ms: START };
    const told = ledger({ fiveHourWindow: ON, urgency: 'shadow', plan: 'shadow', clock });
    const silent = ledger({ urgency: 'shadow', plan: 'shadow', clock });
    for (const { manager } of [told, silent]) {
      manager.applyUsage('sample-a', weekAndFive(clock, 0.5, 30, 0.6));
      manager.updateQuota('sample-b', {
        'anthropic-ratelimit-unified-5h-utilization': '0.3',
        'anthropic-ratelimit-unified-5h-reset': seconds(clock.ms + HOUR),
      });
    }
    const strip = status => JSON.stringify({ ...status, accountUrgency: { ...status.accountUrgency, instanceId: null } });
    assert.equal(strip(told.manager.getStatus()), strip(silent.manager.getStatus()));
    assert.equal(told.manager.getStatus().accounts[0].quota.unified5h, 0.6);
    assert.ok(told.manager.getStatus().quotaWindows.accounts[0].windows.some(window => window.id === '5h'));
    assert.equal(JSON.stringify(told.manager.exportState()), JSON.stringify(silent.manager.exportState()));
  });
});

describe('an upstream 429 explained by the five-hour window', () => {
  for (const fiveHourWindow of [OFF, ON]) {
    it(`drops the account until the five-hour reset and moves the request to the next account (${fiveHourWindow.enabled ? 'on' : 'off'})`, async () => {
      const clock = { ms: START };
      const { manager, logs } = ledger({ fiveHourWindow, ids: ['sample-a', 'sample-b'], clock });
      // The legacy selector only moves to an account with a known reading.
      for (const id of ['sample-a', 'sample-b']) manager.updateQuota(id, {
        'anthropic-ratelimit-unified-7d-utilization': '0.3',
        'anthropic-ratelimit-unified-7d-reset': seconds(clock.ms + 48 * HOUR),
      });
      const h = await startProxy({
        manager,
        logs,
        upstreamHandler: (req, res) => {
          if (req.headers['x-api-key'] !== 'key-sample-a') return okResponse(res);
          res.writeHead(429, {
            'content-type': 'application/json', 'retry-after': '60',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-representative-claim': 'five_hour',
            'anthropic-ratelimit-unified-reset': seconds(clock.ms + 2 * HOUR),
            'anthropic-ratelimit-unified-5h-utilization': '1',
            'anthropic-ratelimit-unified-5h-reset': seconds(clock.ms + 2 * HOUR),
          });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } }));
        },
      });
      const response = await h.send();
      assert.equal(response.status, 200);
      assert.deepEqual(h.seen, ['key-sample-a', 'key-sample-b']);
      const a = manager.find('sample-a');
      clock.ms += HOUR;
      assert.equal(manager.isAvailable(a), false, 'still out before the five-hour reset, past retry-after');
      const held = manager.getStatus();
      assert.equal(held.currentAccount, 'sample-b');
      clock.ms = START + 2 * HOUR + 1000;
      assert.equal(manager.isAvailable(a), true, 'back after the five-hour reset');
      assert.equal(a.quota.unified5h, null);
      if (fiveHourWindow.enabled) {
        assert.equal(signals(logs).length, 0);
        assert.equal(held.accounts[0].quota.unified5h, 1);
      } else {
        assert.equal(signals(logs).length, 1);
        assert.equal(held.accounts[0].quota.unified5h, null, 'status shows no five-hour value while it is off');
        assert.equal(held.fiveHourWindow.enabled, false);
      }
    });
  }

  it('holds an account until the five-hour reset when a Usage reading confirms a 429 while off, and for no other Usage reading', () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], clock });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.2, 48, 1), { upstreamRateLimited: true });
    manager.applyUsage('sample-b', weekAndFive(clock, 0.2, 48, 1));
    assert.equal(manager.isAvailable(manager.find('sample-a')), false);
    assert.equal(manager.isAvailable(manager.find('sample-b')), true);
    assert.equal(manager.getStatus().accounts[0].quota.unified5h, null);
    assert.equal(manager.exportState().accounts[0].quota.unified5h, null);
    manager.applyUsage('sample-a', weekAndFive(clock, 0.2, 48, 0.1));
    assert.equal(manager.isAvailable(manager.find('sample-a')), false, 'a later poll does not lift the rejection early');
    clock.ms += 2 * HOUR + 1000;
    assert.equal(manager.isAvailable(manager.find('sample-a')), true);
  });
});

// The headers of an upstream 429 the five-hour window explains.
function fiveHourRejection(clock, { fiveHourReset = clock.ms + 2 * HOUR, utilization = '1', unifiedReset = fiveHourReset, retryAfter = '60' } = {}) {
  return {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    ...(retryAfter === null ? {} : { 'retry-after': retryAfter }),
    ...(unifiedReset === null ? {} : { 'anthropic-ratelimit-unified-reset': seconds(unifiedReset) }),
    ...(utilization === null ? {} : { 'anthropic-ratelimit-unified-5h-utilization': utilization }),
    ...(fiveHourReset === null ? {} : { 'anthropic-ratelimit-unified-5h-reset': seconds(fiveHourReset) }),
  };
}
const as429 = { atomicUnifiedWindows: true, upstreamRateLimited: true };

describe('a five-hour rejection held while the window is off', () => {
  it('ends the hold at the five-hour reset, else the unified reset, else retry-after', () => {
    const cases = [
      [{}, 2 * HOUR],
      [{ fiveHourReset: null, unifiedReset: START + 3 * HOUR }, 3 * HOUR],
      [{ fiveHourReset: null, unifiedReset: null, retryAfter: '120' }, 120_000],
      [{ fiveHourReset: null, unifiedReset: null, retryAfter: null, utilization: null }, 60_000],
    ];
    for (const [options, length] of cases) {
      const clock = { ms: START };
      const { manager } = ledger({ fiveHourWindow: OFF, ids: ['sample-a'], clock });
      manager.updateQuota('sample-a', fiveHourRejection(clock, options), as429);
      const account = manager.find('sample-a');
      assert.equal(account.rateLimitedUntil, START + length, JSON.stringify(options));
      assert.deepEqual(account.temporaryUnavailableReason, { type: 'temporary_throttle', quotaRejected: true });
      assert.equal(account.quota.unified5h, null);
    }
  });

  it('keeps the hold through a save and restore: out before the five-hour reset, back after it', () => {
    const clock = { ms: START };
    const first = ledger({ fiveHourWindow: OFF, clock });
    first.manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
    const state = JSON.parse(JSON.stringify(first.manager.exportState()));
    assert.equal(state.accounts[0].quota.unified5h, null);
    const second = ledger({ fiveHourWindow: OFF, clock });
    second.manager.restoreState(state);
    const account = second.manager.find('sample-a');
    clock.ms += HOUR;
    assert.equal(second.manager.isAvailable(account), false);
    assert.equal(second.manager.unavailableReason(account).type, 'temporary_throttle');
    clock.ms = START + 2 * HOUR + 1000;
    assert.equal(second.manager.isAvailable(account), true);
  });

  it('keeps an account rejected while on out until the five-hour reset after a reload to off', () => {
    const clock = { ms: START };
    const { manager } = ledger({ clock });
    manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
    const account = manager.find('sample-a');
    assert.equal(manager.unavailableReason(account).window, '5h');
    manager.configureFiveHourWindow(OFF);
    assert.equal(account.quota.unified5h, null);
    clock.ms += HOUR;
    assert.equal(manager.isAvailable(account), false);
    assert.deepEqual(manager.unavailableReason(account).type, 'temporary_throttle');
    clock.ms = START + 2 * HOUR + 1000;
    assert.equal(manager.isAvailable(account), true);
  });

  it('keeps the hold after a reload to on, where the five-hour observations start empty', () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: OFF, urgency: 'shadow', clock });
    manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
    manager.configureFiveHourWindow(ON);
    const account = manager.find('sample-a');
    assert.equal(account.quota.unified5h, null);
    const row = manager.getStatus().accountUrgency.accounts.find(entry => entry.accountId === 'sample-a');
    assert.equal(row.fiveHour.observationState, 'missing');
    clock.ms += HOUR;
    assert.equal(manager.isAvailable(account), false, 'the rejection is still honored');
    clock.ms = START + 2 * HOUR + 1000;
    assert.equal(manager.isAvailable(account), true);
  });

  it('shows no five-hour window in the local 429, the reason, prepare-resume, events or status afterwards', async () => {
    const clock = { ms: START };
    const { manager, logs } = ledger({ fiveHourWindow: OFF, ids: ['sample-a'], urgency: 'on', clock });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.3, 48));
    const h = await startProxy({
      manager, logs,
      config: { sessionAffinity: { mode: 'on' }, accountUrgency: { mode: 'on' } },
      serverOptions: { stateWriter: async () => {} },
      upstreamHandler: (req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', ...fiveHourRejection(clock) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } }));
      },
    });
    assert.equal((await h.send()).status, 429);
    const local = await h.send();
    assert.equal(local.status, 429);
    assert.equal(h.seen.length, 1, 'the held account is not sent to again');
    assert.equal(local.headers['anthropic-ratelimit-unified-representative-claim'], undefined);
    assert.ok(Object.keys(local.headers).every(name => !name.startsWith('anthropic-ratelimit-unified-5h')));
    const status = manager.getStatus();
    assert.deepEqual(status.fiveHourWindow, { enabled: false });
    assert.equal(status.accounts[0].quota.unified5h, null);
    assert.equal(status.accounts[0].unavailableReason.type, 'temporary_throttle');
    assert.equal(Object.hasOwn(status.accounts[0].unavailableReason, 'window'), false);
    assert.ok(status.events.every(event => event.type !== 'quota-exhausted' && event.reason?.window !== '5h'));
    const resume = JSON.parse((await request(`${h.url}/internal/prepare-resume`, { method: 'POST', body: '{}' })).text);
    assert.equal(resume.window, null);
    assert.equal(resume.action, 'wait');
    assert.equal(resume.resumeAtEpoch, Math.floor((START + 2 * HOUR) / 1000), 'the hold ends at the rejection reset');
  });

  it('moves a pinned session to the next account with accountUrgency and sessionAffinity on', async () => {
    const clock = { ms: START };
    const { manager, logs } = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], urgency: 'on', clock });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.3, 24));
    manager.applyUsage('sample-b', weekAndFive(clock, 0.3, 48));
    const h = await startProxy({
      manager, logs,
      config: { sessionAffinity: { mode: 'on' }, accountUrgency: { mode: 'on' } },
      serverOptions: { stateWriter: async () => {} },
      upstreamHandler: (req, res) => {
        if (req.headers['x-api-key'] !== 'key-sample-a') return okResponse(res);
        res.writeHead(429, { 'content-type': 'application/json', ...fiveHourRejection(clock) });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fixture limit' } }));
      },
    });
    const session = { 'x-claude-code-session-id': 'fixture-session-1' };
    assert.equal((await h.send(session)).status, 200);
    assert.deepEqual(h.seen, ['key-sample-a', 'key-sample-b']);
    clock.ms += HOUR;
    assert.equal(manager.isAvailable(manager.find('sample-a')), false, 'out past retry-after, before the five-hour reset');
    assert.equal((await h.send(session)).status, 200);
    assert.deepEqual(h.seen, ['key-sample-a', 'key-sample-b', 'key-sample-b']);
    assert.equal(manager.getStatus().accounts[0].quota.unified5h, null);
    assert.equal(signals(logs).length, 1);
  });
});

describe('a five-hour rejection hold against the other ledger states', () => {
  // `sample-a`: common week 30%, Fable week used up, a five-hour 429 hold two
  // hours ahead. `sample-b`: usable. Both policies are off (the legacy path).
  function fableUsedUp(manager, clock) {
    for (const id of ['sample-a', 'sample-b']) {
      manager.applyUsage(id, {
        seven_day: { utilization: 0.3, resets_at: iso(clock.ms + 48 * HOUR) },
        ...(id === 'sample-a' ? { scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: iso(clock.ms + 48 * HOUR) }] } : {}),
      });
    }
  }
  function assertHeldForOtherModels(manager, label) {
    const a = manager.find('sample-a');
    assert.equal(manager.isAvailable(a), false, `${label}: the held account takes no request`);
    assert.equal(manager.getActiveAccount(null, { trigger: 'request' })?.id, 'sample-b', label);
  }

  it('keeps an account with a used-up Fable week out for other models after a 429, a reload to off and a restore', () => {
    const scenarios = {
      'a 429 while off': clock => {
        const { manager } = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], clock });
        fableUsedUp(manager, clock);
        manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
        return manager;
      },
      'a reload from on to off': clock => {
        const { manager } = ledger({ ids: ['sample-a', 'sample-b'], clock });
        fableUsedUp(manager, clock);
        manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
        manager.configureFiveHourWindow(OFF);
        return manager;
      },
      'a save and restore': clock => {
        const first = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], clock });
        fableUsedUp(first.manager, clock);
        first.manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
        const second = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], clock });
        second.manager.restoreState(JSON.parse(JSON.stringify(first.manager.exportState())));
        return second.manager;
      },
    };
    for (const [label, build] of Object.entries(scenarios)) {
      const clock = { ms: START };
      const manager = build(clock);
      assertHeldForOtherModels(manager, label);
      clock.ms += HOUR;
      assertHeldForOtherModels(manager, `${label}, one hour later`);
      clock.ms = START + 2 * HOUR + 1000;
      assert.equal(manager.isAvailable(manager.find('sample-a')), true, `${label}: back for other models after the reset`);
      assert.equal(manager.isAvailable(manager.find('sample-a'), 'fable'), false, `${label}: the Fable week still applies`);
    }
  });

  it('makes no hold and no throttled event from a used-up reading whose reset has passed on a reload to off', () => {
    const clock = { ms: START };
    const { manager } = ledger({ ids: ['sample-a'], clock });
    manager.applyUsage('sample-a', {
      five_hour: { utilization: 1, resets_at: iso(clock.ms + HOUR) },
      seven_day: { utilization: 0.3, resets_at: iso(clock.ms + 48 * HOUR) },
    });
    clock.ms += 2 * HOUR;
    manager.configureFiveHourWindow(OFF);
    const account = manager.find('sample-a');
    assert.equal(account.rateLimitedUntil, null);
    assert.equal(account.temporaryUnavailableReason, null);
    assert.equal(manager.getStatus().events.some(event => event.type === 'throttled'), false);
    assert.equal(manager.isAvailable(account), true);
  });

  it('keeps the longer five-hour hold and its mark when a restored recovery reservation is pending', () => {
    const clock = { ms: START };
    const first = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], plan: 'on', clock });
    first.manager.setQuotaRecoveryPersistence(true, true);
    const probe = first.manager.reserveQuotaRecovery();
    assert.equal(probe?.account.id, 'sample-a', 'the fixture needs a pending reservation on the held account');
    first.manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
    const state = JSON.parse(JSON.stringify(first.manager.exportState()));
    assert.ok(state.quotaRecovery?.pending, 'the saved state carries the pending reservation');

    const second = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], plan: 'on', clock });
    second.manager.restoreState(state);
    const account = second.manager.find('sample-a');
    assert.equal(account.rateLimitedUntil, START + 2 * HOUR);
    assert.deepEqual(account.temporaryUnavailableReason, { type: 'temporary_throttle', quotaRejected: true });
    clock.ms += HOUR;
    assert.equal(second.manager.isAvailable(account), false);
  });

  it('answers prepare-resume with a wait until the hold ends while the only account is held, then ready', async () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: OFF, ids: ['sample-a'], clock });
    manager.applyUsage('sample-a', weekAndFive(clock, 0.3, 48));
    manager.updateQuota('sample-a', fiveHourRejection(clock), as429);
    const h = await startProxy({ manager, upstreamHandler: okResponse });
    const prepare = async () => {
      const response = await request(`${h.url}/internal/prepare-resume`, { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const { status, ...result } = JSON.parse(response.text);
      assert.equal(typeof status, 'object');
      return result;
    };
    const holdEnd = iso(START + 2 * HOUR);
    const waiting = await prepare();
    assert.deepEqual(waiting, {
      ok: true,
      action: 'wait',
      reason: 'shortest-quota-reset',
      account: 'sample-a',
      accountName: 'sample-a',
      switched: false,
      window: null,
      unavailableReason: { type: 'temporary_throttle', quotaRejected: true, retryAt: holdEnd, resetAt: holdEnd },
      resumeAt: holdEnd,
      resumeAtEpoch: Math.floor((START + 2 * HOUR) / 1000),
      waitMs: 2 * HOUR,
    });
    assert.deepEqual(manager.prepareResumeTarget(), waiting);

    clock.ms = START + 2 * HOUR + 1000;
    assert.deepEqual(await prepare(), {
      ok: true,
      action: 'ready',
      reason: 'available',
      account: 'sample-a',
      accountName: 'sample-a',
      switched: false,
      window: null,
      unavailableReason: null,
      resumeAt: iso(clock.ms),
      resumeAtEpoch: Math.floor(clock.ms / 1000),
      waitMs: 0,
    });
  });

  it('answers locally with a plain usage-limit 429 at the earliest hold end when every account is held (off)', async () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: OFF, ids: ['sample-a', 'sample-b'], clock });
    manager.updateQuota('sample-a', fiveHourRejection(clock, { fiveHourReset: START + 3 * HOUR }), as429);
    manager.updateQuota('sample-b', fiveHourRejection(clock, { fiveHourReset: START + 2 * HOUR }), as429);
    const h = await startProxy({ manager, upstreamHandler: okResponse });
    const response = await h.send();
    assert.equal(response.status, 429);
    assert.deepEqual(h.seen, [], 'answered without sending upstream');
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], seconds(START + 2 * HOUR));
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], undefined);
    assert.ok(Object.keys(response.headers).every(name => !/^anthropic-ratelimit-unified-(5h|7d)/.test(name)));
    assert.equal(response.headers['x-claude-rotator-account'], 'sample-b');
    assert.equal(response.headers['x-claude-rotator-quota-window'], '');
    const body = JSON.parse(response.text);
    assert.equal(body.error.type, 'rate_limit_error');
    assert.match(body.error.message, /^You've hit your usage limit · resets \d{1,2}(:\d{2})?(am|pm)$/);
    assert.doesNotMatch(response.text, /5h|five_hour|session limit/);
    assert.equal(body.error.details.reset_at, iso(START + 2 * HOUR));
    assert.equal(body.error.details.rotator_message,
      `Claude usage limit exhausted for sample-b. Resets at ${iso(START + 2 * HOUR)}. No available rotation target.`);
    assert.ok(h.logs.some(line => / proxy account=sample-b .* outcome=quota-exhausted-local/.test(line)), h.logs.join('\n'));

    // With the 429-to-529 mapping on, it is mapped the same way as a used-up window while on.
    const mapped = await startProxy({
      manager, upstreamHandler: okResponse,
      config: { openaiBridge: { enabled: false, degradeMapping: { enabled: true } } },
    });
    assert.equal((await mapped.send()).status, 529);
    assert.deepEqual(mapped.seen, []);
  });

  it('keeps the five-hour local 429 when every account is used up while on', async () => {
    const clock = { ms: START };
    const { manager } = ledger({ fiveHourWindow: ON, ids: ['sample-a', 'sample-b'], clock });
    manager.updateQuota('sample-a', fiveHourRejection(clock, { fiveHourReset: START + 3 * HOUR }), as429);
    manager.updateQuota('sample-b', fiveHourRejection(clock, { fiveHourReset: START + 2 * HOUR }), as429);
    const h = await startProxy({ manager, upstreamHandler: okResponse });
    const response = await h.send();
    assert.equal(response.status, 429);
    assert.deepEqual(h.seen, []);
    assert.equal(response.headers['anthropic-ratelimit-unified-status'], 'rejected');
    assert.equal(response.headers['anthropic-ratelimit-unified-representative-claim'], 'five_hour');
    assert.equal(response.headers['anthropic-ratelimit-unified-reset'], seconds(START + 2 * HOUR));
    assert.equal(response.headers['anthropic-ratelimit-unified-5h-utilization'], '1');
    assert.equal(response.headers['anthropic-ratelimit-unified-5h-reset'], seconds(START + 2 * HOUR));
    assert.equal(response.headers['x-claude-rotator-quota-window'], '5h');
    const body = JSON.parse(response.text);
    assert.match(body.error.message, /^You've hit your session limit · resets /);
    assert.equal(body.error.details.rotator_message,
      `Claude 5h usage limit exhausted for sample-b. Resets at ${iso(START + 2 * HOUR)}. No available rotation target.`);
    const resume = manager.prepareResumeTarget();
    assert.equal(resume.window, '5h');
    assert.equal(resume.resumeAtEpoch, Math.floor((START + 2 * HOUR) / 1000));
  });
});
