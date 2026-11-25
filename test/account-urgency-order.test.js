// `accountUrgency.order`. "reset-first" (the default) ranks eligible accounts
// by tier (0: at least 10 points left before the 97% line; 1: less than that,
// or with the five-hour window on a known five-hour reading of 90% or more;
// 2: usable only to recover a stale reading), then by the common weekly reset
// (earliest first), then by room left (most first), then by id.
// "required-pace" keeps the order by the pace needed to use the allowance.
//
// Isolation: the clock is injected and readings are applied to an in-memory
// ledger. The one proxy test uses a 127.0.0.1 port-0 upstream, in-memory API
// keys and stubbed Usage, credential and token calls; nothing reaches a real
// service.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/proxy-server.js';
import { MemorySecretStore } from '../src/secret-store.js';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-24T23:07:00Z');
const cleanups = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

// Four accounts (weekly utilization, reset in hours from START). By reset
// they are a, b, c, d; by required pace they are the reverse, d, c, b, a.
const FOUR = [['a', 0.44, 36.88], ['b', 0.41, 37.88], ['c', 0.26, 47.86], ['d', 0, 64.88]];

function ledger({ ids, mode = 'on', order, fiveHourWindow, clock, extra = {} }) {
  const logs = [];
  const manager = new AccountManager({
    accounts: ids.map(id => ({ id, type: 'apikey' })),
    accountUrgency: { mode, ...(order === undefined ? {} : { order }) },
    ...(fiveHourWindow === undefined ? {} : { fiveHourWindow }),
    now: () => clock.ms,
    logger: line => logs.push(line),
    ...extra,
  });
  // `resetAt` is absolute, so a later reading of the same window keeps it.
  const observe = (id, used, resetAt, more = {}) => manager.applyUsage(id, {
    seven_day: { utilization: used, resets_at: new Date(resetAt).toISOString() }, ...more,
  });
  return { manager, logs, observe };
}

function four({ order, fiveHourWindow, mode = 'on', extra } = {}) {
  const clock = { ms: START };
  const built = ledger({ ids: FOUR.map(([id]) => id), mode, order, fiveHourWindow, clock, extra });
  const resets = new Map(FOUR.map(([id, , hours]) => [id, START + hours * HOUR]));
  const refresh = () => { for (const [id, used] of FOUR) built.observe(id, used, resets.get(id)); };
  refresh();
  return { ...built, clock, resets, refresh };
}

const section = manager => manager.getStatus().accountUrgency;
const row = (manager, id) => section(manager).accounts.find(entry => entry.accountId === id);
const decision = manager => section(manager).decisions.at(-1);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// Each account is read twice, 15 minutes apart, at the same utilization, so
// its observed pace is zero and its reset is `hours` from the second reading.
function reassignmentLedger(readings, order) {
  const clock = { ms: START };
  const built = ledger({ ids: readings.map(([id]) => id), order, clock });
  const resets = new Map(readings.map(([id, , hours]) => [id, START + 15 * 60_000 + hours * HOUR]));
  for (const [id, used] of readings) built.observe(id, used, resets.get(id));
  clock.ms += 15 * 60_000;
  for (const [id, used] of readings) built.observe(id, used, resets.get(id));
  const plan = bound => built.manager.planUrgencyReassignment({
    bound: built.manager.find(bound), boundAt: clock.ms - HOUR, turnBoundary: true, inFlight: false,
  });
  return { ...built, clock, plan };
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

function request(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: { 'content-type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function startProxy({ manager, config, serverOptions }) {
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    res.writeHead(500);
    res.end();
  }));
  const secretStore = new MemorySecretStore();
  for (const account of manager.accounts) await secretStore.set(account.id, { apiKey: `key-${account.id}` });
  const proxy = await listen(createProxyServer({
    accountManager: manager,
    secretStore,
    config: { upstream: upstream.url, usagePolling: { enabled: false }, proxy: { upstreamConnectRetries: 0 }, ...config },
    logger: () => {},
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
  return proxy.url;
}

describe('reset-first account order', () => {
  it('ranks four accounts by weekly reset and sends a new session to the earliest', () => {
    const { manager } = four({ extra: { currentAccountId: 'd' } });
    const status = section(manager);
    assert.equal(status.order, 'reset-first');
    assert.deepEqual(status.proposedOrder, ['a', 'b', 'c', 'd']);
    assert.equal(manager.selectForNewAssignment().id, 'a');
    assert.equal(decision(manager).reason, 'reset-first');
    for (const [id, used] of FOUR) {
      assert.equal(row(manager, id).orderTier, 0);
      near(row(manager, id).remainingFraction, 0.97 - used);
    }
    assert.ok(row(manager, 'a').requiredPace < row(manager, 'd').requiredPace, 'required pace is still reported');
    assert.equal(manager.getActiveAccount(null, { trigger: 'request' }).id, 'a');
    assert.deepEqual(manager.events.filter(event => event.type === 'auto-switch')
      .map(({ from, to, reason }) => ({ from, to, reason })), [{ from: 'd', to: 'a', reason: 'reset-first' }]);
  });

  it('puts exactly 10 points left in tier 0 and 9.9 points in tier 1', () => {
    const clock = { ms: START };
    const { manager, observe } = ledger({ ids: ['edge', 'other'], clock });
    observe('other', 0.5, START + 40 * HOUR);
    observe('edge', 0.87, START + 2 * HOUR);
    assert.equal(row(manager, 'edge').orderTier, 0);
    assert.deepEqual(section(manager).proposedOrder, ['edge', 'other']);
    observe('edge', 0.871, START + 2 * HOUR);
    assert.equal(row(manager, 'edge').orderTier, 1);
    assert.deepEqual(section(manager).proposedOrder, ['other', 'edge']);
  });

  it('moves an account close to its reset with little left behind those with room', () => {
    const clock = { ms: START };
    const { manager, observe } = ledger({ ids: ['x', 'y', 'z'], clock });
    observe('x', 0.9, START + 2 * HOUR);
    observe('y', 0.3, START + 40 * HOUR);
    observe('z', 0.5, START + 60 * HOUR);
    assert.deepEqual(section(manager).proposedOrder, ['y', 'z', 'x']);
    assert.equal(manager.selectForNewAssignment().id, 'y');
    observe('x', 0.85, START + 2 * HOUR);
    assert.deepEqual(section(manager).proposedOrder, ['x', 'y', 'z'], 'with 12 points left it leads again');
  });

  it('orders accounts that all have little left by reset and still selects one', () => {
    const clock = { ms: START };
    const { manager, observe } = ledger({ ids: ['p', 'q', 'r'], clock });
    observe('p', 0.95, START + 10 * HOUR);
    observe('q', 0.9, START + 30 * HOUR);
    observe('r', 0.92, START + 50 * HOUR);
    assert.deepEqual(section(manager).accounts.map(entry => entry.orderTier), [1, 1, 1]);
    assert.deepEqual(section(manager).proposedOrder, ['p', 'q', 'r']);
    assert.equal(manager.selectForNewAssignment().id, 'p');
  });

  it('breaks a reset tie by room left, a full tie by id, and never rounds a one-minute gap', () => {
    const clock = { ms: START };
    const { manager, observe } = ledger({ ids: ['q', 'p'], clock });
    observe('p', 0.57, START + 20 * HOUR);
    observe('q', 0.37, START + 20 * HOUR);
    assert.deepEqual(section(manager).proposedOrder, ['q', 'p']);
    observe('q', 0.57, START + 20 * HOUR);
    assert.deepEqual(section(manager).proposedOrder, ['p', 'q']);
    observe('q', 0.37, START + 20 * HOUR + 60_000);
    assert.deepEqual(section(manager).proposedOrder, ['p', 'q']);
  });

  it('keeps the same account first for a day of unchanged readings, where required pace switches', () => {
    const firstChoices = order => {
      const { manager, clock, refresh } = four({ order });
      const chosen = [];
      for (let step = 0; step <= 96; step++) {
        refresh();
        chosen.push(manager.getActiveAccount(null, { trigger: 'request' }).id);
        clock.ms += 15 * 60_000;
      }
      return { chosen, switches: manager.events.filter(event => event.type === 'auto-switch') };
    };
    const resetFirst = firstChoices('reset-first');
    assert.deepEqual([...new Set(resetFirst.chosen)], ['a']);
    assert.equal(resetFirst.switches.length, 0);
    const requiredPace = firstChoices('required-pace');
    assert.equal(requiredPace.chosen[0], 'd');
    assert.ok(new Set(requiredPace.chosen).size > 1);
    assert.ok(requiredPace.switches.length > 1, 'it moves again as the readings age');
    assert.ok(requiredPace.switches.every(event => event.reason === 'required-pace'));
  });

  it('moves a session to an account at risk that resets before the current one', () => {
    const { manager, plan } = reassignmentLedger([['d', 0.05, 40], ['a', 0.44, 11.9]]);
    assert.equal(row(manager, 'a').unusedRisk, true);
    assert.equal(plan('d')?.id, 'a');
    assert.equal(decision(manager).reason, 'unused-before-reset');
  });

  it('does not move a session to an account that resets after the current one, and records reset-order', () => {
    const readings = [['b', 0.77, 8], ['c', 0.37, 11]];
    const { manager, logs, plan } = reassignmentLedger(readings);
    assert.equal(row(manager, 'c').unusedRisk, true);
    assert.equal(plan('b'), null);
    assert.equal(decision(manager).reason, 'reset-order');
    assert.equal(decision(manager).wouldReassign, false);
    assert.equal(decision(manager).actualAccountId, 'b');
    assert.match(logs.filter(line => line.includes(' account_urgency ')).at(-1), /"reason":"reset-order"/);
    const legacy = reassignmentLedger(readings, 'required-pace');
    assert.equal(legacy.plan('b')?.id, 'c', 'required pace still moves it');
  });

  it('moves a session off an account with less than 10 points left to one that resets later', () => {
    const { manager, plan } = reassignmentLedger([['b', 0.92, 8], ['c', 0.37, 11]]);
    assert.equal(row(manager, 'b').orderTier, 1);
    assert.equal(plan('b')?.id, 'c');
    assert.equal(decision(manager).reason, 'unused-before-reset');
  });

  it('ranks stale accounts after fresh ones, and among themselves by reset', () => {
    const clock = { ms: START };
    const { manager, observe } = ledger({ ids: ['a', 'b', 'f', 'g'], clock });
    observe('g', 0.1, START + 45 * 60_000 + 30 * HOUR);
    observe('f', 0.3, START + 45 * 60_000 + 20 * HOUR);
    clock.ms += 45 * 60_000;
    observe('a', 0.44, clock.ms + 36.88 * HOUR);
    observe('b', 0.41, clock.ms + 37.88 * HOUR);
    assert.equal(row(manager, 'f').recoveryOnly, true);
    assert.equal(row(manager, 'f').orderTier, 2);
    assert.equal(row(manager, 'g').orderTier, 2);
    assert.deepEqual(section(manager).proposedOrder, ['a', 'b', 'f', 'g']);
  });

  it('puts an account in tier 1 for a Fable request when its Fable weekly window has less than 10 points left', () => {
    const { manager, observe, resets } = four();
    for (const [id, used] of FOUR) observe(id, used, resets.get(id), {
      scoped_weekly: [{ key: 'fable', utilization: id === 'a' ? 0.9 : 0.1, resets_at: new Date(START + 100 * HOUR).toISOString() }],
    });
    const status = section(manager);
    assert.deepEqual(status.byModelFamily.other.proposedOrder, ['a', 'b', 'c', 'd']);
    assert.deepEqual(status.byModelFamily.fable.proposedOrder, ['b', 'c', 'd', 'a']);
    assert.equal(manager.selectForNewAssignment({ modelFamily: 'fable' }).id, 'b');
    assert.equal(manager.selectForNewAssignment().id, 'a');
  });

  it('ranks by required pace when the order is "required-pace"', () => {
    const { manager } = four({ order: 'required-pace' });
    assert.equal(section(manager).order, 'required-pace');
    assert.deepEqual(section(manager).proposedOrder, ['d', 'c', 'b', 'a']);
    assert.equal(manager.selectForNewAssignment().id, 'd');
    assert.equal(decision(manager).reason, 'required-pace');
  });

  it('reads an unknown order as "reset-first" and logs one line while it stays unknown', () => {
    for (const order of ['bogus', 1, true]) {
      const { manager, logs } = four({ order });
      const warnings = () => logs.filter(line => line === 'account-urgency warning=invalid-order order=reset-first');
      assert.equal(section(manager).order, 'reset-first');
      assert.deepEqual(section(manager).proposedOrder, ['a', 'b', 'c', 'd']);
      assert.equal(warnings().length, 1);
      manager.configureAccountUrgency({ mode: 'on', order });
      assert.equal(warnings().length, 1);
      manager.configureAccountUrgency({ mode: 'on', order: 'reset-first' });
      manager.configureAccountUrgency({ mode: 'on', order });
      assert.equal(warnings().length, 2);
    }
    for (const order of [undefined, null, 'reset-first', 'required-pace']) {
      assert.equal(four({ order }).logs.some(line => line.includes('invalid-order')), false);
    }
    assert.equal(four({ mode: 'off', order: 'bogus' }).logs.some(line => line.includes('invalid-order')), false);
  });

  it('applies a reload that changes only the order', async () => {
    const { manager } = four({ mode: 'shadow', order: 'reset-first' });
    let next = { mode: 'shadow', order: 'required-pace' };
    const url = await startProxy({
      manager,
      config: { accountUrgency: { mode: 'shadow', order: 'reset-first' } },
      serverOptions: { reloadAccountUrgency: async () => next },
    });
    const read = async () => JSON.parse((await request(`${url}/internal/status`)).text).accountUrgency;
    let status = await read();
    assert.equal(status.order, 'reset-first');
    assert.deepEqual(status.proposedOrder, ['a', 'b', 'c', 'd']);
    assert.ok(status.accounts.every(entry => entry.orderTier === 0 && Number.isFinite(entry.remainingFraction)));
    const instance = manager.urgency;
    assert.equal((await request(`${url}/internal/reload`, { method: 'POST', body: '{}' })).status, 200);
    status = await read();
    assert.equal(status.order, 'required-pace');
    assert.equal(status.mode, 'shadow');
    assert.deepEqual(status.proposedOrder, ['d', 'c', 'b', 'a']);
    assert.equal(manager.urgency, instance, 'the history is kept');
    next = { mode: 'shadow' };
    assert.equal((await request(`${url}/internal/reload`, { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await read()).order, 'reset-first', 'an absent order is "reset-first"');
  });

  for (const order of ['reset-first', 'required-pace']) {
    it(`leaves out an account the upstream rejected with 429 until its retry time (${order})`, () => {
      for (const fiveHourWindow of [{ enabled: false }, { enabled: true }]) {
        const { manager, clock } = four({ order, fiveHourWindow });
        const leader = section(manager).proposedOrder[0];
        manager.markRateLimited(leader, 600);
        assert.equal(row(manager, leader).eligible, false);
        assert.equal(section(manager).proposedOrder.includes(leader), false);
        assert.notEqual(manager.selectForNewAssignment().id, leader);
        clock.ms += 601_000;
        manager.find(leader).status = 'ready';
        for (const [id, used, hours] of FOUR) manager.applyUsage(id, {
          seven_day: { utilization: used, resets_at: new Date(START + hours * HOUR).toISOString() },
        });
        assert.equal(section(manager).proposedOrder[0], leader);
      }
    });
  }

  it('uses a five-hour reading of 90% or more for tier 1 only while the five-hour window is on', () => {
    for (const [fiveHourWindow, used, expected] of [
      [{ enabled: true }, 0.92, ['b', 'c', 'd', 'a']],
      [{ enabled: true }, 0.9, ['b', 'c', 'd', 'a']],
      [{ enabled: true }, 0.89, ['a', 'b', 'c', 'd']],
      [{ enabled: false }, 0.92, ['a', 'b', 'c', 'd']],
    ]) {
      const { manager, observe, resets, clock } = four({ fiveHourWindow });
      observe('a', 0.44, resets.get('a'), { five_hour: { utilization: used, resets_at: new Date(clock.ms + 2 * HOUR).toISOString() } });
      assert.deepEqual(section(manager).proposedOrder, expected, `${used} with the window ${fiveHourWindow.enabled ? 'on' : 'off'}`);
    }
    const { manager } = four({ fiveHourWindow: { enabled: true } });
    assert.deepEqual(section(manager).proposedOrder, ['a', 'b', 'c', 'd'], 'an unknown five-hour window does not lower a tier');
  });
  it('ranks status orders from the rows it selects with, not from saved five-hour readings shown in status', () => {
    const clock = { ms: START };
    const make = () => ledger({ ids: ['a', 'b', 'c'], fiveHourWindow: { enabled: true }, clock });
    const saved = make();
    saved.observe('a', 0.3, START + 10 * HOUR, { five_hour: { utilization: 0.95, resets_at: new Date(START + 2 * HOUR).toISOString() } });
    const { manager, observe } = make();
    manager.restoreState(saved.manager.exportState());
    for (const [id, hours] of [['a', 10], ['b', 20], ['c', 30]]) observe(id, 0.3, START + hours * HOUR);
    const status = section(manager);
    assert.equal(row(manager, 'a').fiveHour.retainedConstraint, true, 'the saved 95% reading is shown');
    assert.equal(row(manager, 'a').fiveHour.lastKnown.usedFraction, 0.95);
    const selected = manager.newAssignmentOrder().map(entry => entry.account);
    assert.deepEqual(selected, ['a', 'b', 'c']);
    assert.deepEqual(status.proposedOrder, selected);
    assert.deepEqual(status.byModelFamily.other.proposedOrder, selected);
    assert.equal(row(manager, 'a').orderTier, 0);
  });

  it('places recovery-only accounts restored after a restart by their saved weekly reset', () => {
    const clock = { ms: START };
    const make = () => ledger({ ids: ['a', 'b', 'c'], order: 'reset-first', clock });
    const saved = make();
    saved.observe('a', 0.3, START + 48 * HOUR);
    saved.observe('b', 0.3, START + 24 * HOUR);
    saved.observe('c', 0.6, START + 36 * HOUR);
    assert.deepEqual(section(saved.manager).proposedOrder, ['b', 'c', 'a']);
    const { manager } = make();
    manager.restoreState(saved.manager.exportState());
    const status = section(manager);
    assert.ok(status.accounts.every(entry => entry.recoveryOnly === true && entry.orderTier === 2
      && entry.weekly.fresh === false), 'still recovery-only and stale');
    assert.deepEqual(status.proposedOrder, ['b', 'c', 'a']);
    assert.equal(manager.selectForNewAssignment().id, 'b');
  });
});
