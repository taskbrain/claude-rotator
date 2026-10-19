// Tests for the drift watch: first-seen client versions, model names and weekly
// limit scopes, and the hourly cache-miss and request-size checks.
//
// Isolation: the clock, the timers, `notice`, the state reader and writer, the
// enabled check and the account ledger are all injected. No file, sender or
// network is used, except the end-to-end cases at the bottom, which talk to a
// test upstream on 127.0.0.1 (port 0) and use a fake sender that only records.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { createAlertWatch, normalizeAlertSettings } from '../src/alert-watch.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer, isCanonicalFableModelId } from '../src/proxy-server.js';
import { isFableScopeIdentity } from '../src/quota.js';
import { readFile } from 'node:fs/promises';

import {
  DRIFT_HISTORY_HOURS,
  DRIFT_LEARNING_MS,
  DRIFT_MAX_FIRST_SEEN_PER_HOUR,
  DRIFT_MAX_MODELS,
  DRIFT_MAX_SEEN,
  DRIFT_SWEEP_INTERVAL_MS,
  attachDriftWatch,
  createDriftWatch,
  parseProxyLine,
} from '../src/drift-watch.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A fixed instant on an hour boundary, computed rather than written as a date.
const BASE = 480_000 * HOUR;

// A proxy line in the form the proxy server writes. Only the fields the watch
// reads matter; the rest are filler with the same shape.
function proxyLine({
  at = new Date(BASE).toISOString(),
  account = 'acct_example',
  path = '/v1/messages',
  status = '200',
  outcome = 'ok',
  model = 'claude-opus-5-5',
  input = '1000',
  cacheRead = '0',
  cacheCreation = '0',
  usageParse = null,
  version = null,
  tail = '',
} = {}) {
  const parts = [
    `${at} proxy`,
    `account=${account}`,
    'method=POST',
    `path=${path}`,
    `status=${status}`,
    'durationMs=12',
    `outcome=${outcome}`,
    `model=${model}`,
    'sid=-',
    `in=${input}`,
    'out=5',
    `cr=${cacheRead}`,
    `cc=${cacheCreation}`,
    'c1h=0',
    'c5m=0',
    'u5h=-',
    'u5hReset=-',
    'u7d=-',
    'u7dReset=-',
    'enc=-',
  ];
  if (usageParse) parts.push(`usageParse=${usageParse}`);
  if (version) parts.push(`ua=${version}`);
  return `${parts.join(' ')}${tail}`;
}

// A small deterministic generator so the noise test is the same on every run.
function createRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('parseProxyLine', () => {
  it('reads the model, the client version and the three input counts of a successful messages line', () => {
    assert.deepEqual(
      parseProxyLine(proxyLine({ input: '1200', cacheRead: '34000', cacheCreation: '560', version: '2.1.303' })),
      { model: 'claude-opus-5-5', version: '2.1.303', input: 1200, cacheRead: 34000, cacheCreation: 560 },
    );
    assert.deepEqual(
      parseProxyLine(proxyLine({ input: '7' })),
      { model: 'claude-opus-5-5', version: null, input: 7, cacheRead: 0, cacheCreation: 0 },
    );
    // Fields added after the client version later on do not change the result.
    assert.equal(parseProxyLine(proxyLine({ version: '2.1.303', tail: ' beta=7c896b7a' })).version, '2.1.303');
  });

  it('returns null for lines that are not counted', () => {
    const rejected = [
      'not a proxy line',
      proxyLine().replace(' proxy ', ' proxy-error '),
      proxyLine({ usageParse: 'gzip_error' }),
      proxyLine({ path: '/v1/messages/count_tokens' }),
      proxyLine({ status: '529' }),
      proxyLine({ status: '-' }),
      proxyLine({ outcome: 'retry' }),
      proxyLine({ input: 'abc' }),
      proxyLine({ input: '-3' }),
      proxyLine({ input: '1.5' }),
      proxyLine({ input: '0', cacheRead: '0', cacheCreation: '0' }),
      proxyLine({ model: '-' }),
      proxyLine({ model: 'x'.repeat(65) }),
      proxyLine().replace(' cr=0', ''),
      '',
    ];
    for (const line of rejected) assert.equal(parseProxyLine(line), null, line);
    for (const value of [undefined, null, 42, {}, ['x']]) assert.equal(parseProxyLine(value), null);
  });

  it('treats a client version of another form as absent', () => {
    for (const version of ['2.1', '2.1.303.4', '2.1.303-beta', 'x.y.z']) {
      assert.equal(parseProxyLine(proxyLine({ version })).version, null, version);
    }
  });

  it('never throws on a thousand lines of random characters', () => {
    const random = createRandom(7);
    const alphabet = ' =./-_abcdefghijklmnopqrstuvwxyz0123456789proxyinccrmodelstatuspath\té';
    for (let i = 0; i < 1000; i += 1) {
      let line = random() < 0.5 ? proxyLine() : '';
      const extra = Math.floor(random() * 200);
      for (let j = 0; j < extra; j += 1) line += alphabet[Math.floor(random() * alphabet.length)];
      const cut = Math.floor(random() * line.length);
      const value = random() < 0.3 ? line.slice(0, cut) : line;
      const out = parseProxyLine(value);
      assert.ok(out === null || typeof out === 'object');
    }
  });
});

// ---- the watch with everything injected ----

// Starts half way into an hour, so the first hour is a partial one.
const START = BASE + 30 * MINUTE;
const TEXT_FORM = /^[\x20-\x7e]{1,300}$/;

// A clock with timers that only move when the test says so. Timers run on their
// own time, as real timers do: `set` jumps the wall clock (also backwards)
// without moving them, and `advance` moves both.
function createClock(start = START) {
  let t = start;
  let mono = 0;
  let seq = 0;
  const tasks = new Map();
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    tasks.set(id, { fn, at: mono + ms, ms, repeat });
    return { id, unref() {} };
  };
  const remove = handle => {
    if (handle) tasks.delete(handle.id);
  };
  return {
    now: () => t,
    size: () => tasks.size,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: remove,
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: remove,
    },
    set(value) {
      t = value;
    },
    advance(ms) {
      const end = mono + ms;
      for (;;) {
        let next = null;
        for (const [id, task] of tasks) {
          if (task.at > end) continue;
          if (!next || task.at < next.task.at || (task.at === next.task.at && id < next.id)) next = { id, task };
        }
        if (!next) break;
        t += next.task.at - mono;
        mono = next.task.at;
        if (next.task.repeat) next.task.at += next.task.ms;
        else tasks.delete(next.id);
        next.task.fn();
      }
      t += end - mono;
      mono = end;
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

// A state whose learning period is over, as a later start would read it.
function learnedState(clock, seen = {}) {
  return {
    format: 1,
    createdAt: clock.now() - DRIFT_LEARNING_MS - HOUR,
    seen: { clientVersions: [], models: [], scopes: [], ...seen },
    hours: {},
    episodes: {},
  };
}

function setupWatch({
  clock = createClock(),
  state = null,
  readState = null,
  writeState = null,
  notice = () => true,
  isListedModel = () => false,
  isListedScope = () => false,
  accounts = [],
} = {}) {
  const notices = [];
  const lines = [];
  const writes = [];
  const control = { enabled: true };
  const ledger = { accounts };
  const watch = createDriftWatch({
    isEnabled: () => control.enabled,
    notice: input => {
      notices.push(input);
      return notice(input);
    },
    accountManager: ledger,
    isListedModel,
    isListedScope,
    readState: readState || (async () => (state === null ? null : structuredClone(state))),
    writeState: writeState || (async value => {
      writes.push(structuredClone(value));
    }),
    logger: line => lines.push(line),
    now: clock.now,
    timers: clock.timers,
  });
  return {
    clock,
    watch,
    notices,
    lines,
    writes,
    ledger,
    control,
    async begin() {
      watch.start();
      await settle();
    },
    feed(options, times = 1) {
      for (let i = 0; i < times; i += 1) {
        watch.noteLogLine(proxyLine({ at: new Date(clock.now()).toISOString(), ...options }));
      }
    },
    driftLines: () => lines.filter(line => / drift-watch /.test(line)),
    lastWrite: () => writes[writes.length - 1],
  };
}

describe('first-seen values', () => {
  it('only remembers during the first day, then reports a newer client version once', async () => {
    const t = setupWatch({ accounts: [{ quota: { weeklyScoped: [{ key: 'seven_day_example' }] } }] });
    await t.begin();

    t.feed({ version: '2.1.303', model: 'claude-example-1' });
    t.feed({ version: '2.1.304', model: 'claude-example-2' });
    t.feed({});
    t.clock.advance(DRIFT_LEARNING_MS - HOUR);
    t.feed({ version: '2.1.305', model: 'claude-example-3' });
    assert.deepEqual(t.notices, []);
    assert.deepEqual(t.driftLines(), []);

    t.clock.advance(HOUR + MINUTE);
    t.feed({ version: '2.1.306' });
    t.feed({ version: '2.1.306' });
    // Unseen, but older than the newest version seen: only remembered.
    t.feed({ version: '2.1.300' });
    t.feed({ version: '1.0.0' });
    // Versions compare number by number, not as text.
    t.feed({ version: '2.1.1000' });

    assert.deepEqual(t.notices, [
      {
        kind: 'client-version',
        key: '2.1.306',
        text: 'claude-rotator: first time seeing Claude Code 2.1.306 (newest before: 2.1.305).',
      },
      {
        kind: 'client-version',
        key: '2.1.1000',
        text: 'claude-rotator: first time seeing Claude Code 2.1.1000 (newest before: 2.1.306).',
      },
    ]);
    assert.deepEqual(t.driftLines().map(line => line.replace(/^\S+ /, '')), [
      'drift-watch notice kind=client-version key=2.1.306 result=queued',
      'drift-watch notice kind=client-version key=2.1.1000 result=queued',
    ]);
  });

  it('does not report the first client version ever seen', async () => {
    const t = setupWatch({ state: learnedState(createClock(), { models: ['claude-opus-5-5'] }) });
    await t.begin();
    t.feed({ version: '2.1.303' });
    assert.deepEqual(t.notices, []);
  });

  it('reports a model name off the fixed list once, and never one on it', async () => {
    const clock = createClock();
    const t = setupWatch({
      clock,
      state: learnedState(clock, { models: ['claude-opus-5-5'] }),
      isListedModel: name => name === 'claude-listed-1',
      notice: input => input.key !== 'claude-refused-1',
    });
    await t.begin();

    t.feed({ model: 'claude-opus-5-5' });
    t.feed({ model: 'claude-listed-1' });
    t.feed({ model: 'claude-new-1' });
    t.feed({ model: 'claude-new-1' });
    t.feed({ model: 'claude-refused-1' });
    t.feed({ model: 'claude-refused-1' });

    assert.deepEqual(t.notices, [
      { kind: 'model-name', key: 'claude-new-1', text: 'claude-rotator: first time seeing model claude-new-1.' },
      { kind: 'model-name', key: 'claude-refused-1', text: 'claude-rotator: first time seeing model claude-refused-1.' },
    ]);
    assert.deepEqual(t.driftLines().map(line => line.replace(/^\S+ /, '')), [
      'drift-watch notice kind=model-name key=claude-new-1 result=queued',
      'drift-watch notice kind=model-name key=claude-refused-1 result=rejected',
    ]);
  });

  it('reports a weekly limit scope off the fixed list once, on the next sweep', async () => {
    const clock = createClock();
    const t = setupWatch({
      clock,
      state: learnedState(clock, { scopes: ['seven_day_known'] }),
      isListedScope: key => key === 'fable',
      accounts: [
        { quota: { weeklyScoped: [{ key: 'seven_day_known' }, { key: 'fable' }, { key: 'Bad Key' }] } },
        { quota: { weeklyScoped: [{ key: 'seven_day_example' }] } },
        { quota: null },
        null,
      ],
    });
    await t.begin();
    assert.deepEqual(t.notices, []);

    t.clock.advance(DRIFT_SWEEP_INTERVAL_MS);
    t.clock.advance(DRIFT_SWEEP_INTERVAL_MS);

    assert.deepEqual(t.notices, [{
      kind: 'limit-scope',
      key: 'seven_day_example',
      text: 'claude-rotator: first time seeing weekly limit scope seven_day_example.',
    }]);
  });

  it('keeps what it learned and the learning period across a restart', async () => {
    const clock = createClock();
    const first = setupWatch({ clock });
    await first.begin();
    first.feed({ version: '2.1.303', model: 'claude-example-1' });
    await first.watch.stop();
    const saved = first.lastWrite();
    assert.equal(saved.createdAt, START);
    assert.deepEqual(saved.seen.clientVersions, ['2.1.303']);

    // Restarted one hour later: still inside the first day, so nothing is reported.
    clock.advance(HOUR);
    const second = setupWatch({ clock, state: saved });
    await second.begin();
    second.feed({ version: '2.1.304' });
    assert.deepEqual(second.notices, []);
    await second.watch.stop();

    // Restarted after the first day: the period is not started over.
    clock.advance(DRIFT_LEARNING_MS);
    const third = setupWatch({ clock, state: second.lastWrite() });
    await third.begin();
    third.feed({ version: '2.1.304', model: 'claude-example-1' });
    assert.deepEqual(third.notices, []);
    third.feed({ version: '2.1.305', model: 'claude-example-2' });
    assert.deepEqual(third.notices.map(n => `${n.kind} ${n.key}`), [
      'client-version 2.1.305',
      'model-name claude-example-2',
    ]);
    assert.equal(third.lastWrite(), undefined);
    await third.watch.stop();
    assert.equal(third.lastWrite().createdAt, START);
  });

  it('starts over with one log line when the saved state is broken, and keeps running', async () => {
    const clock = createClock();
    const cases = [
      { readState: async () => { throw new SyntaxError('broken'); }, reason: 'unreadable' },
      { state: { ...learnedState(clock), format: 2 }, reason: 'format' },
      { state: { ...learnedState(clock), seen: 'clientVersions' }, reason: 'format' },
      { state: { ...learnedState(clock), seen: { models: 'claude-opus-5-5' } }, reason: 'format' },
      { state: { ...learnedState(clock), createdAt: 'yesterday' }, reason: 'format' },
      { state: [], reason: 'format' },
      { state: 7, reason: 'format' },
    ];
    for (const { reason, ...options } of cases) {
      const t = setupWatch({ clock, ...options });
      await t.begin();
      assert.deepEqual(t.driftLines().map(line => line.replace(/^\S+ /, '')), [`drift-watch state=ignored reason=${reason}`]);
      // A fresh state: the learning period applies again.
      t.feed({ version: '2.1.303', model: 'claude-example-1' });
      t.feed({ version: '2.1.304', model: 'claude-example-2' });
      assert.deepEqual(t.notices, []);
      await t.watch.stop();
      assert.equal(t.lastWrite().createdAt, clock.now());
      assert.deepEqual(t.lastWrite().seen.clientVersions, ['2.1.303', '2.1.304']);
    }
  });

  it('drops single values of the wrong form but keeps the rest of the state', async () => {
    const clock = createClock();
    const state = learnedState(clock, {
      clientVersions: ['2.1.303', '2.1', 7, null],
      models: ['claude-opus-5-5', 'has space', '-'],
      scopes: ['seven_day_known', 'UPPER'],
    });
    const t = setupWatch({ clock, state });
    await t.begin();
    assert.deepEqual(t.driftLines(), []);
    t.feed({ version: '2.1.303', model: 'claude-opus-5-5' });
    assert.deepEqual(t.notices, []);
    await t.watch.stop();
    assert.deepEqual(t.lastWrite().seen, {
      clientVersions: ['2.1.303'],
      models: ['claude-opus-5-5'],
      scopes: ['seven_day_known'],
    });
  });

  it('starts fresh without a log line when there is no saved state yet', async () => {
    const t = setupWatch({ state: null });
    await t.begin();
    assert.deepEqual(t.driftLines(), []);
  });

  it('puts nothing about accounts into a message', async () => {
    const clock = createClock();
    const t = setupWatch({
      clock,
      state: learnedState(clock, { clientVersions: ['2.1.303'] }),
      accounts: [{
        id: 'acct_marker_secret',
        name: 'acct_marker_name',
        quota: { weeklyScoped: [{ key: 'seven_day_example', label: 'acct_marker_label' }] },
      }],
    });
    await t.begin();
    t.feed({ account: 'acct_marker_secret', version: '2.1.304', model: 'claude-example-1' });
    clock.advance(DRIFT_SWEEP_INTERVAL_MS);

    assert.equal(t.notices.length, 3);
    for (const { text } of t.notices) {
      assert.ok(!text.includes('acct_marker'), text);
      assert.match(text, TEXT_FORM);
    }
    for (const line of t.driftLines()) assert.ok(!line.includes('acct_marker'), line);
  });

  it('reports at most ten first-seen values an hour and only remembers the rest', async () => {
    const clock = createClock();
    const t = setupWatch({ clock, state: learnedState(clock) });
    await t.begin();
    const names = Array.from({ length: 15 }, (_, i) => `claude-burst-${i + 1}`);
    for (const model of names) t.feed({ model });

    assert.equal(t.notices.length, DRIFT_MAX_FIRST_SEEN_PER_HOUR);
    assert.deepEqual(t.notices.map(n => n.key), names.slice(0, 10));
    const limited = t.driftLines().filter(line => / result=limit$/.test(line)).map(line => line.replace(/^\S+ /, ''));
    assert.deepEqual(limited, names.slice(10).map(name => `drift-watch notice kind=model-name key=${name} result=limit`));
    await t.watch.stop();
    assert.deepEqual(t.lastWrite().seen.models, names);

    // The limit is per clock hour.
    clock.advance(HOUR);
    const later = setupWatch({ clock, state: t.lastWrite() });
    await later.begin();
    later.feed({ model: 'claude-burst-16' });
    assert.deepEqual(later.notices.map(n => n.key), ['claude-burst-16']);
  });

  it('keeps each first-seen list within its size limit, dropping the oldest', async () => {
    const t = setupWatch();
    await t.begin();
    const total = DRIFT_MAX_SEEN + 100;
    for (let i = 0; i < total; i += 1) t.feed({ model: `claude-many-${i}`, version: `3.0.${i}` });
    await t.watch.stop();
    const { seen } = t.lastWrite();
    assert.equal(seen.models.length, DRIFT_MAX_SEEN);
    assert.equal(seen.clientVersions.length, DRIFT_MAX_SEEN);
    assert.equal(seen.models[0], 'claude-many-100');
    assert.equal(seen.models[DRIFT_MAX_SEEN - 1], `claude-many-${total - 1}`);
    assert.equal(seen.clientVersions[DRIFT_MAX_SEEN - 1], `3.0.${total - 1}`);
  });
});

// ---- hourly drift ----

const OPUS = 'claude-opus-5-5';
const START_HOUR = Math.floor(START / HOUR);

// Baseline rows [hour, count, missRate, p50, p95] for the same hour of the
// previous `days` days, for each of the given hours.
function baselineRows(judgedHours, { days = 7, count = 1000, miss = 0.036, p50 = 100_000, p95 = 100_000 } = {}) {
  const rows = new Map();
  for (const hour of judgedHours) {
    for (let d = 1; d <= days; d += 1) rows.set(hour - 24 * d, [hour - 24 * d, count, miss, p50, p95]);
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

function range(from, length) {
  return Array.from({ length }, (_, i) => from + i);
}

// A learned state with the baseline of the model in place.
function driftState(clock, rows, extra = {}) {
  return {
    ...learnedState(clock, { models: [OPUS], ...extra.seen }),
    hours: { [OPUS]: rows },
  };
}

// Requests of one hour: `count` requests of `size` tokens with the given hit rate.
function requests({ count = 1000, hit = 0.964, size = 100_000, model = OPUS, version = null, account = 'acct_example' } = {}) {
  const cacheRead = Math.round(size * hit);
  return { times: count, line: { model, version, account, input: String(size - cacheRead), cacheRead: String(cacheRead) } };
}

// Starts the watch and moves to the start of the next hour, the first full one.
async function beginAtNextHour(t) {
  await t.begin();
  t.clock.advance(HOUR - (t.clock.now() % HOUR));
}

// Feeds one full hour, then moves into the next hour so the sweep closes it.
function runHour(t, ...groups) {
  for (const group of groups) t.feed(group.line, group.times);
  t.clock.advance(HOUR);
}

const CACHE_MISS_TEXT = /^claude-rotator: cache misses for claude-opus-5-5 were \d+\.\dx the usual for this hour of the day \(hit rate \d+\.\d% vs \d+\.\d%, \d+ requests\)\.$/;

describe('hourly cache-miss check', () => {
  it('reports a spike in cache misses once when it starts, and again only after it has cleared', async () => {
    const clock = createClock();
    const first = START_HOUR + 1;
    const t = setupWatch({ clock, state: driftState(clock, baselineRows(range(first, 60))) });
    await beginAtNextHour(t);

    const spike = [0.9226, 0.9211, 0.8621, 0.8813, 0.8827, 0.9507, 0.8969, 0.8830, 0.8488, 0.8922];
    for (const hit of spike) runHour(t, requests({ hit, account: 'acct_marker_secret' }));
    assert.deepEqual(t.notices.map(n => `${n.kind} ${n.key}`), [`cache-miss ${OPUS}|cache|${first}`]);
    assert.match(t.notices[0].text, CACHE_MISS_TEXT);
    assert.ok(t.notices[0].text.includes('(hit rate 92.3% vs 96.4%, 1000 requests)'), t.notices[0].text);

    // Two judged hours back in range close it; the next spike is a new one.
    runHour(t, requests({ hit: 0.964 }));
    runHour(t, requests({ hit: 0.964 }));
    assert.equal(t.notices.length, 1);
    runHour(t, requests({ hit: 0.88 }));
    assert.deepEqual(t.notices.map(n => n.key), [`${OPUS}|cache|${first}`, `${OPUS}|cache|${first + 12}`]);

    // A spike left without any judged hour for a day is closed as well.
    t.clock.advance(25 * HOUR);
    runHour(t, requests({ hit: 0.88 }));
    assert.deepEqual(t.notices.map(n => n.key).slice(2), [`${OPUS}|cache|${first + 38}`]);

    for (const { text } of t.notices) {
      assert.ok(!text.includes('acct_marker'), text);
      assert.match(text, TEXT_FORM);
    }
    assert.deepEqual(t.driftLines().map(line => line.replace(/^\S+ /, '')), t.notices.map(n => `drift-watch notice kind=cache-miss key=${n.key} result=queued`));
  });

  it('does not report a rise below twice the usual miss rate', async () => {
    const clock = createClock();
    const t = setupWatch({ clock, state: driftState(clock, baselineRows(range(START_HOUR + 1, 3))) });
    await beginAtNextHour(t);
    runHour(t, requests({ hit: 0.9485 }));
    runHour(t, requests({ hit: 0.964 }));
    assert.deepEqual(t.notices, []);
  });

  it('judges only hours with enough requests and at least three baseline days', async () => {
    const clock = createClock();
    const first = START_HOUR + 1;
    const rows = [
      ...baselineRows([first, first + 2]),
      ...baselineRows([first + 1], { days: 2 }),
    ].sort((a, b) => a[0] - b[0]);
    const t = setupWatch({ clock, state: driftState(clock, rows) });
    await beginAtNextHour(t);

    runHour(t, requests({ hit: 0.8, count: 499 }));
    runHour(t, requests({ hit: 0.8 }));
    assert.deepEqual(t.notices, []);
    runHour(t, requests({ hit: 0.8, count: 500 }));
    assert.deepEqual(t.notices.map(n => n.key), [`${OPUS}|cache|${first + 2}`]);
  });

  it('does not count, save, report or log while the alerts section is off, and skips the hour it comes back in', async () => {
    const clock = createClock();
    const first = START_HOUR + 1;
    const t = setupWatch({ clock, state: driftState(clock, baselineRows(range(first, 5))) });
    await beginAtNextHour(t);
    t.control.enabled = false;

    runHour(t, requests({ hit: 0.8 }), requests({ count: 1, version: '2.1.400', model: 'claude-example-9' }));
    assert.deepEqual(t.notices, []);
    assert.deepEqual(t.writes, []);
    assert.deepEqual(t.lines, []);

    // Back on half way into an hour: that hour is not judged.
    t.clock.advance(30 * MINUTE);
    t.control.enabled = true;
    t.feed(requests({ hit: 0.8 }).line, 1000);
    t.clock.advance(30 * MINUTE + MINUTE);
    assert.deepEqual(t.notices, []);

    // The next full hour is judged, and lines seen while off were never learned.
    t.feed(requests({ hit: 0.8 }).line, 1000);
    t.feed({ version: '2.1.400', model: 'claude-example-9' });
    t.clock.advance(HOUR);
    assert.deepEqual(t.notices.map(n => `${n.kind} ${n.key}`), [
      'model-name claude-example-9',
      `cache-miss ${OPUS}|cache|${first + 2}`,
    ]);
    assert.ok(t.writes.length > 0);
  });

  it('does not close an hour while the clock is set back, and closes only hours that had requests after a jump ahead', async () => {
    const clock = createClock();
    const first = START_HOUR + 1;
    const t = setupWatch({ clock, state: driftState(clock, baselineRows(range(first, 12))) });
    await beginAtNextHour(t);

    t.feed(requests({ hit: 0.8 }).line, 1000);
    clock.set(clock.now() - HOUR + 5 * MINUTE);
    clock.advance(20 * MINUTE);
    assert.deepEqual(t.notices, []);

    // Back to normal time: the hour is closed once.
    clock.set(first * HOUR + 50 * MINUTE);
    clock.advance(20 * MINUTE);
    assert.deepEqual(t.notices.map(n => n.key), [`${OPUS}|cache|${first}`]);

    // Five hours ahead in one jump: only the hour with requests is closed.
    t.feed(requests({ hit: 0.964 }).line, 1000);
    clock.set(clock.now() + 5 * HOUR);
    clock.advance(MINUTE);
    await t.watch.stop();
    const kept = t.lastWrite().hours[OPUS].map(row => row[0]).filter(hour => hour >= first);
    assert.deepEqual(kept, [first, first + 1]);
  });
});

describe('hourly request-size check', () => {
  // The model baseline: 200,000 tokens a request, 1,000 requests an hour.
  const SIZE = 200_000;
  const VERSIONS = ['2.1.304', '2.1.305', '2.1.306', '2.1.307', '2.1.308', '2.1.309'];

  async function sizeSetup() {
    const clock = createClock();
    const first = START_HOUR + 1;
    const rows = baselineRows(range(first, 8), { p50: SIZE, p95: SIZE });
    const t = setupWatch({ clock, state: driftState(clock, rows, { seen: { clientVersions: VERSIONS } }) });
    await beginAtNextHour(t);
    return { t, first };
  }

  const usual = (count = 1400) => requests({ count, size: SIZE });

  it('reports the median size of a model on one Claude Code version from 1.75 times up or down', async () => {
    const { t, first } = await sizeSetup();
    runHour(t, usual(), requests({ count: 600, size: 360_000, version: '2.1.304' }));
    runHour(t, usual(), requests({ count: 600, size: 340_000, version: '2.1.305' }));
    runHour(t, usual(), requests({ count: 600, size: 110_000, version: '2.1.306' }));
    runHour(t, usual(), requests({ count: 600, size: 120_000, version: '2.1.307' }));

    assert.deepEqual(t.notices.map(n => `${n.kind} ${n.key}`), [
      `request-size-p50 ${OPUS}@2.1.304|p50|${first}`,
      `request-size-p50 ${OPUS}@2.1.306|p50|${first + 2}`,
    ]);
    assert.equal(
      t.notices[0].text,
      'claude-rotator: median request size for claude-opus-5-5 on Claude Code 2.1.304 was 1.8x the usual for this hour of the day (360k vs 200k tokens, 600 requests).',
    );
    assert.match(t.notices[1].text, /^claude-rotator: median request size for claude-opus-5-5 on Claude Code 2\.1\.306 was 0\.\dx the usual for this hour of the day \(110k vs 200k tokens, 600 requests\)\.$/);
  });

  it('judges the 95th percentile only with at least a thousand requests in the hour', async () => {
    const { t, first } = await sizeSetup();
    runHour(t, usual(), requests({ count: 800, size: SIZE, version: '2.1.308' }), requests({ count: 100, size: 600_000, version: '2.1.308' }));
    assert.deepEqual(t.notices, []);
    runHour(t, usual(), requests({ count: 980, size: SIZE, version: '2.1.309' }), requests({ count: 120, size: 600_000, version: '2.1.309' }));
    assert.deepEqual(t.notices.map(n => `${n.kind} ${n.key}`), [`request-size-p95 ${OPUS}@2.1.309|p95|${first + 1}`]);
    assert.equal(
      t.notices[0].text,
      'claude-rotator: 95th percentile request size for claude-opus-5-5 on Claude Code 2.1.309 was 3.0x the usual for this hour of the day (600k vs 200k tokens, 1100 requests).',
    );
  });

  it('does not report a version when the whole model is already off in the same way', async () => {
    const { t, first } = await sizeSetup();
    runHour(t, requests({ count: 1000, size: 400_000 }), requests({ count: 1000, size: 400_000, version: '2.1.304' }));
    assert.deepEqual(t.notices.map(n => n.key), [`${OPUS}|p50|${first}`, `${OPUS}|p95|${first}`]);
  });
});

describe('saving and stopping', () => {
  it('keeps the hourly history within its hour and model limits', async () => {
    const clock = createClock();
    const now = START_HOUR;
    const hours = {
      [OPUS]: [[now - 200, 1000, 0.036, 1, 1], [now - DRIFT_HISTORY_HOURS + 1, 1000, 0.036, 1, 1], [now - 24, 1000, 0.036, 1, 1]],
    };
    for (let i = 0; i < 20; i += 1) hours[`claude-extra-${i}`] = [[now - 40 + i, 1000, 0.036, 1, 1]];
    const t = setupWatch({ clock, state: { ...learnedState(clock, { models: [OPUS] }), hours } });
    await beginAtNextHour(t);
    runHour(t, requests());
    t.clock.advance(HOUR);
    await t.watch.stop();

    const saved = t.lastWrite().hours;
    assert.equal(Object.keys(saved).length, DRIFT_MAX_MODELS);
    assert.ok(!('claude-extra-4' in saved) && 'claude-extra-5' in saved);
    assert.deepEqual(saved[OPUS].map(row => row[0]), [now - 24, now + 1]);
    for (const rows of Object.values(saved)) {
      for (const [hour] of rows) assert.ok(hour >= Math.floor(clock.now() / HOUR) - DRIFT_HISTORY_HOURS);
    }
  });

  it('stops its timer, saves once, and does not throw when saving fails', async () => {
    const clock = createClock();
    let calls = 0;
    const t = setupWatch({
      clock,
      writeState: async () => {
        calls += 1;
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    await t.begin();
    t.feed({ version: '2.1.303' });
    clock.advance(DRIFT_SWEEP_INTERVAL_MS);
    await settle();
    t.feed({ version: '2.1.304' });
    clock.advance(DRIFT_SWEEP_INTERVAL_MS);
    await settle();
    const before = calls;
    assert.equal(before, 2);

    await t.watch.stop();
    assert.equal(calls, before + 1);
    assert.equal(clock.size(), 0);
    assert.deepEqual(t.driftLines().map(line => line.replace(/^\S+ /, '')), ['drift-watch state-write result=failed errorType=EACCES']);
    await t.watch.stop();
    assert.equal(calls, before + 1);
  });

  it('takes no sender and uses no file system or network of its own', async () => {
    const source = createDriftWatch.toString();
    const params = source.slice(source.indexOf('{') + 1, source.indexOf('} = {}'))
      .split(',')
      .map(part => part.split('=')[0].trim())
      .filter(Boolean);
    assert.deepEqual(params, [
      'isEnabled', 'notice', 'accountManager', 'isListedModel', 'isListedScope',
      'readState', 'writeState', 'logger', 'now', 'timers',
    ]);
    const file = await readFile(new URL('../src/drift-watch.js', import.meta.url), 'utf8');
    assert.doesNotMatch(file, /^import /m);
  });
});

// ---- the proxy server end to end ----

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

function requestRaw(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const UPSTREAM_USAGE = { input_tokens: 1200, output_tokens: 3, cache_read_input_tokens: 34000, cache_creation_input_tokens: 560 };
const UPSTREAM_MODEL = 'claude-sonnet-4-5';

// The upstream is a test server on 127.0.0.1; credential readers, profile and
// usage fetches and token refresh are stubs, so nothing reaches a real service.
async function startProxy({ logger, alertWatchFor = null } = {}) {
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_drift' });
    res.end(JSON.stringify({ id: 'msg_drift', type: 'message', model: UPSTREAM_MODEL, usage: UPSTREAM_USAGE }));
  }));
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', { apiKey: 'test-api-key' });
  const accountManager = new AccountManager({
    accounts: [{ id: 'acct_1', name: 'acct-1', type: 'apikey' }],
    switchThreshold: 1,
    now: () => 1000,
  });
  const alertWatch = alertWatchFor ? alertWatchFor(accountManager) : null;
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      proxy: { upstreamConnectRetries: 0 },
    },
    logger,
    ...(alertWatch ? { alertWatch } : {}),
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => null,
    currentProfileFetcher: async () => null,
    usageFetcher: async () => { throw new Error('usage API must not be called in this test'); },
    tokenRefresher: async () => { throw new Error('token refresh must not be called in this test'); },
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { proxy, accountManager, alertWatch };
}

function sendMessage(proxy, userAgent) {
  return requestRaw(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ model: UPSTREAM_MODEL }),
  });
}

// The proxy line is written after the response, so wait until it is there.
async function waitForProxyLine(lines, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const found = lines.filter(line => / proxy /.test(line));
    if (found.length > 0) {
      assert.equal(found.length, 1, found.join('\n'));
      return found[0];
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no proxy line:\n${lines.join('\n')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('reading the proxy server line', () => {
  it('gets the same model, client version and counts the upstream returned', async () => {
    const lines = [];
    const { proxy } = await startProxy({ logger: line => lines.push(line) });

    const response = await sendMessage(proxy, 'claude-cli/2.1.303 (external, cli)');

    assert.equal(response.status, 200);
    const line = await waitForProxyLine(lines);
    assert.deepEqual(parseProxyLine(line), {
      model: UPSTREAM_MODEL,
      version: '2.1.303',
      input: UPSTREAM_USAGE.input_tokens,
      cacheRead: UPSTREAM_USAGE.cache_read_input_tokens,
      cacheCreation: UPSTREAM_USAGE.cache_creation_input_tokens,
    });
  });
});

// ---- the wiring helper ----

// Records every call, in order, into one list.
function recordingAlertWatch(calls, { section = () => null } = {}) {
  const notices = [];
  return {
    notices,
    watch: {
      statusSection() {
        return section();
      },
      notice(input) {
        calls.push('notice');
        notices.push(input);
        return true;
      },
      start() {
        calls.push('alert.start');
      },
      stop() {
        calls.push('alert.stop');
      },
    },
  };
}

function connectOptions(clock, calls, overrides = {}) {
  return {
    enabled: true,
    accountManager: { accounts: [] },
    isListedModel: () => false,
    isListedScope: () => false,
    readState: async () => {
      calls.push('readState');
      return learnedState(clock, { clientVersions: ['2.1.303'], models: [OPUS] });
    },
    writeState: async () => {
      calls.push('writeState');
      await settle();
      calls.push('writeState.done');
    },
    now: clock.now,
    timers: clock.timers,
    ...overrides,
  };
}

const newVersionLine = () => proxyLine({ version: '2.1.304' });

describe('attachDriftWatch', () => {
  it('reports nothing and logs nothing while the alert watch has no status section', async () => {
    const clock = createClock();
    const calls = [];
    const base = [];
    const alerts = recordingAlertWatch(calls, { section: () => null });
    const link = attachDriftWatch({ baseLogger: line => base.push(line) });
    assert.equal(link.connect({ ...connectOptions(clock, calls), alertWatch: alerts.watch }), true);
    link.start();
    await settle();

    link.logger(newVersionLine());
    clock.advance(DRIFT_SWEEP_INTERVAL_MS);

    assert.equal(alerts.notices.length, 0);
    assert.deepEqual(base, [newVersionLine()]);
  });

  it('passes every line to the base logger and on to the watch while the alert watch is on', async () => {
    const clock = createClock();
    const calls = [];
    const base = [];
    const alerts = recordingAlertWatch(calls, { section: () => ({}) });
    const link = attachDriftWatch({ baseLogger: line => base.push(line) });
    link.connect({ ...connectOptions(clock, calls), alertWatch: alerts.watch });
    link.start();
    await settle();

    link.logger(newVersionLine());

    assert.deepEqual(alerts.notices.map(n => `${n.kind} ${n.key}`), ['client-version 2.1.304']);
    assert.equal(base[0], newVersionLine());
    // The watch's own line goes to the base logger once and is not fed back.
    assert.deepEqual(base.slice(1).map(line => line.replace(/^\S+ /, '')), ['drift-watch notice kind=client-version key=2.1.304 result=queued']);
  });

  it('starts the alert watch before reading the state, and stops it after the state is saved', async () => {
    const clock = createClock();
    const calls = [];
    const alerts = recordingAlertWatch(calls, { section: () => ({}) });
    const link = attachDriftWatch({ baseLogger: () => {} });
    link.connect({ ...connectOptions(clock, calls), alertWatch: alerts.watch });
    link.start();
    await settle();
    await link.stop();
    assert.deepEqual(calls, ['alert.start', 'readState', 'writeState', 'writeState.done', 'alert.stop']);

    // A failing save does not make stop fail, and the alert watch is still stopped.
    const failing = [];
    const other = recordingAlertWatch(failing, { section: () => ({}) });
    const second = attachDriftWatch({ baseLogger: () => {} });
    second.connect({
      ...connectOptions(clock, failing, { writeState: async () => { throw new Error('denied'); } }),
      alertWatch: other.watch,
    });
    second.start();
    await settle();
    await second.stop();
    assert.deepEqual(failing, ['alert.start', 'readState', 'alert.stop']);
  });

  it('leaves out the watch when the alerts section is off at start', async () => {
    const clock = createClock();
    const calls = [];
    const base = [];
    const alerts = recordingAlertWatch(calls, { section: () => ({}) });
    const link = attachDriftWatch({ baseLogger: line => base.push(line) });

    // Before connect, start and stop do nothing.
    link.start();
    await link.stop();
    assert.deepEqual(calls, []);

    assert.equal(link.connect({ ...connectOptions(clock, calls), enabled: false, alertWatch: alerts.watch }), false);
    link.start();
    await settle();
    link.logger(newVersionLine());
    await link.stop();

    assert.deepEqual(calls, ['alert.start', 'alert.stop']);
    assert.deepEqual(base, [newVersionLine()]);
    assert.equal(alerts.notices.length, 0);
  });
});

describe('the drift watch wired as the server wires it', () => {
  it('sends one message for a newer Claude Code version seen in a real proxy line', async () => {
    const clock = createClock();
    const sent = { notifyMac: [], postWebhook: [], stop: 0 };
    const sender = {
      notifyMac(args) {
        sent.notifyMac.push(args);
        return { result: 'exited-0' };
      },
      postWebhook(args) {
        sent.postWebhook.push(args);
        return { result: 'ok', reason: null };
      },
      checkWebhookFile() {
        return { usable: true, problem: null };
      },
      stop() {
        sent.stop += 1;
      },
    };
    // Never read: only the fake sender above sees it.
    const settings = { macNotification: true, webhookUrlFile: '/nonexistent/example/hook-url' };
    const base = [];
    const writes = [];
    const link = attachDriftWatch({ baseLogger: line => base.push(line) });
    const { proxy, accountManager, alertWatch } = await startProxy({
      logger: link.logger,
      alertWatchFor: manager => createAlertWatch({
        accountManager: manager,
        sender,
        settings,
        logger: link.logger,
        now: clock.now,
        timers: clock.timers,
      }),
    });
    assert.equal(link.connect({
      enabled: normalizeAlertSettings(settings).enabled,
      alertWatch,
      accountManager,
      isListedModel: isCanonicalFableModelId,
      isListedScope: isFableScopeIdentity,
      readState: async () => learnedState(clock, { clientVersions: ['2.1.303'], models: [UPSTREAM_MODEL] }),
      writeState: async state => {
        writes.push(structuredClone(state));
      },
      now: clock.now,
      timers: clock.timers,
    }), true);
    link.start();
    await new Promise(setImmediate);

    const response = await sendMessage(proxy, 'claude-cli/2.1.304 (external, cli)');
    assert.equal(response.status, 200);
    await waitForProxyLine(base);
    clock.advance(60_000);
    for (let i = 0; i < 5; i += 1) await settle();

    const expected = 'claude-rotator: first time seeing Claude Code 2.1.304 (newest before: 2.1.303).';
    assert.equal(sent.notifyMac.length, 1);
    assert.equal(sent.postWebhook.length, 1);
    assert.ok(sent.notifyMac[0].body.split('\n').includes(expected), sent.notifyMac[0].body);
    assert.ok(sent.postWebhook[0].text.split('\n').includes(expected), sent.postWebhook[0].text);
    assert.equal(base.filter(line => / drift-watch notice kind=client-version key=2\.1\.304 result=queued$/.test(line)).length, 1);

    await link.stop();
    assert.ok(writes.length > 0);
    assert.ok(writes[writes.length - 1].seen.clientVersions.includes('2.1.304'));
    assert.equal(sent.stop, 1);
  });
});
