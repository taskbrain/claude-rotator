// 出来事の記録（src/codex/events.js）のテスト。メモリだけの記録で、I/O も子プロセスも無いので、
// 隔離の補助は使わない。時計は偽物を渡す。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CODEX_EVENT_TYPE_OF_LOG, createCodexEventLog } from '../../src/codex/events.js';
import { CODEX_EVENTS_LIMIT, CODEX_EVENT_TYPES, codexIsoTime } from '../../src/shared/codex-status-schema.js';

const START = 1_800_000_000_000;

function clockAt(startMs) {
  let now = startMs;
  return { now: () => now, set: value => { now = value; } };
}

test('events: a record carries only at, type and label, with the time in UTC seconds', () => {
  const clock = clockAt(START + 999);
  const log = createCodexEventLog({ now: clock.now });
  assert.equal(log.record('stopped', 'zz-a'), true);
  assert.equal(log.record('reloaded'), true, 'the label may be left out');
  assert.equal(log.record('selected', null), true);
  assert.deepEqual(log.list(), [
    { at: codexIsoTime(START), type: 'stopped', label: 'zz-a' },
    { at: codexIsoTime(START), type: 'reloaded', label: null },
    { at: codexIsoTime(START), type: 'selected', label: null },
  ]);
  for (const entry of log.list()) assert.deepEqual(Object.keys(entry), ['at', 'type', 'label']);
  assert.equal(log.total(), 3);
});

test('events: the 51st record drops the oldest one', () => {
  const clock = clockAt(START);
  const log = createCodexEventLog({ now: clock.now });
  for (let index = 0; index <= CODEX_EVENTS_LIMIT; index++) {
    clock.set(START + index * 1000);
    assert.equal(log.record('selected', `zz-${index}`), true);
  }
  const list = log.list();
  assert.equal(CODEX_EVENTS_LIMIT, 50);
  assert.equal(list.length, 50);
  assert.equal(list[0].label, 'zz-1', 'the first record is gone');
  assert.equal(list.at(-1).label, 'zz-50');
  assert.equal(list[0].at, codexIsoTime(START + 1000));
  assert.equal(log.total(), 51, 'total counts every record, including the dropped one');
});

test('events: a type outside the vocabulary is not recorded', () => {
  const log = createCodexEventLog({ now: () => START });
  for (const type of ['deleted', 'STOPPED', '', '__proto__', 'constructor', undefined, null, 1]) {
    assert.equal(log.record(type, 'zz-a'), false, String(type));
  }
  assert.deepEqual(log.list(), []);
  assert.equal(log.total(), 0);
});

test('events: a label that does not match the account label form is not recorded', () => {
  const log = createCodexEventLog({ now: () => START });
  for (const label of ['zz-dummy@example.invalid', 'ZZ-upper', '-zz', 'z'.repeat(33), '', 7, {}]) {
    assert.equal(log.record('stopped', label), false, String(label));
  }
  assert.deepEqual(log.list(), []);
});

test('events: a time that cannot be represented is not recorded', () => {
  for (const at of [Number.NaN, Infinity, -1, undefined]) {
    const log = createCodexEventLog({ now: () => at });
    assert.equal(log.record('stopped', 'zz-a'), false, String(at));
    assert.deepEqual(log.list(), []);
  }
  assert.throws(() => createCodexEventLog({ now: START }), TypeError);
});

test('events: recordLog maps the five log events of the poller and the auth rules, and ignores the others', () => {
  const log = createCodexEventLog({ now: () => START });
  assert.deepEqual(CODEX_EVENT_TYPE_OF_LOG, {
    codex_usage_capped: 'stopped',
    codex_usage_recovered: 'released',
    codex_usage_window_cap_dropped: 'window-cap-dropped',
    codex_auth_needs_login: 'needs-login',
    codex_auth_recovered: 'recovered',
  });
  for (const [event, index] of Object.keys(CODEX_EVENT_TYPE_OF_LOG).map((name, i) => [name, i])) {
    assert.equal(log.recordLog('info', event, { account_label: `zz-${index}`, used_percent: 80 }), true, event);
  }
  for (const event of ['codex_usage_read', 'codex_usage_unavailable', 'codex_credentials_unavailable', 'constructor',
    '__proto__', 'toString', undefined]) {
    assert.equal(log.recordLog('info', event, { account_label: 'zz-a' }), false, String(event));
  }
  assert.equal(log.recordLog('info', 'codex_usage_capped', { account_label: 'zz-dummy@example.invalid' }), false,
    'a label of the wrong form is not recorded');
  assert.equal(log.recordLog('info', 'codex_auth_recovered'), true, 'a log event without a label records null');
  assert.deepEqual(log.list().map(({ type, label }) => [type, label]), [
    ['stopped', 'zz-0'], ['released', 'zz-1'], ['window-cap-dropped', 'zz-2'], ['needs-login', 'zz-3'],
    ['recovered', 'zz-4'], ['recovered', null],
  ]);
  for (const type of Object.values(CODEX_EVENT_TYPE_OF_LOG)) assert.ok(CODEX_EVENT_TYPES.includes(type), type);
});

test('events: the mapped log event names are the ones the poller and the auth rules write', async () => {
  const sources = await Promise.all(['usage-poller.js', 'auth-tracker.js']
    .map(name => readFile(new URL(`../../src/codex/${name}`, import.meta.url), 'utf8')));
  const text = sources.join('\n');
  for (const event of Object.keys(CODEX_EVENT_TYPE_OF_LOG)) {
    assert.ok(text.includes(`'${event}'`), `${event} is written by the poller or the auth rules`);
  }
});

test('events: list() returns copies', () => {
  const log = createCodexEventLog({ now: () => START });
  log.record('stopped', 'zz-a');
  const first = log.list();
  first[0].label = 'zz-changed';
  first.push({ at: 'x', type: 'y', label: null });
  assert.deepEqual(log.list(), [{ at: codexIsoTime(START), type: 'stopped', label: 'zz-a' }]);
});
