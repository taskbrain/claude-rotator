import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { collectUsage } from '../scripts/codex-usage/collect.js';

const execute = promisify(execFile);
const HOUR = 3_600_000;
const START = Date.parse('2026-01-15T00:00:00Z'); // 09:00 JST
const RESET = '2026-01-16T00:00:00.000Z';
const iso = time => new Date(time).toISOString();
const usageWindow = (usedPercent, observedAt, overrides = {}) => ({
  usedPercent, resetAt: RESET, windowMinutes: 10080, observedAt: iso(observedAt), fresh: true, ...overrides,
});
const snapshot = window => ({ accounts: [{
  label: 'example', state: 'available', windows: { fiveHour: null, weekly: window }, otherWindows: [],
}] });

async function harness(t, { customPaths = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const output = customPaths ? join(root, 'output') : join(home, '.claude/work/routing');
  const fake = join(root, 'fake-status.cjs');
  const response = join(root, 'snapshot.json');
  const calls = join(root, 'calls.jsonl');
  await mkdir(home);
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_FAIL === '1') {
  process.stderr.write('fake failure detail');
  process.exit(7);
}
process.stdout.write(fs.readFileSync(process.env.FAKE_RESPONSE, 'utf8'));
`, { mode: 0o755 });
  // The fake has a different basename so the suite's real-command guard stays armed.
  const env = {
    ...process.env, HOME: home, CODEX_USAGE_ROTATOR: fake, CODEX_USAGE_DIR: '',
    FAKE_RESPONSE: response, FAKE_CALLS: calls,
  };
  if (customPaths) env.CODEX_USAGE_DIR = output;
  const set = value => writeFile(response, JSON.stringify(value));
  const run = async (value, now) => { await set(value); await collectUsage({ env, now }); };
  const samplePath = join(output, 'codex-usage-samples.jsonl');
  return {
    root, home, output, env, set, run, samplePath,
    samples: async () => (await readFile(samplePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    calls: async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    report: async (date = '2026-01-15') => JSON.parse(await readFile(join(output, `codex-usage-forecast-${date}.json`), 'utf8')),
    seed: async rows => {
      await mkdir(output, { recursive: true });
      await writeFile(samplePath, rows.map(row => JSON.stringify(row) + '\n').join(''));
    },
  };
}

function rows(values = [10, 20, 30], overrides = {}) {
  return values.map((value, i) => ({
    label: 'example', window: 'weekly', state: 'available',
    ...usageWindow(value, START + i * HOUR), ...overrides,
  }));
}

test('hourly records project a constant pace with one status call per run', async t => {
  const h = await harness(t);
  // Accumulate before the forecast hours, then forecast at 08:00 JST.
  for (let i = 0; i < 3; i++) {
    await h.run(snapshot(usageWindow(10 + 10 * i, START - (3 - i) * HOUR)), START - (3 - i) * HOUR);
  }
  const report = await h.report();
  const window = report.accounts[0].windows[0];
  assert.equal(window.status, 'reaches-90');
  assert.equal(window.sampleCount, 3);
  assert.equal(window.ratePercentPerHour, 10);
  assert.equal(window.reachesAt, iso(START + 5 * HOUR));
  assert.deepEqual(await h.calls(), Array(3).fill(['status', '--json']));
  assert.deepEqual(await h.samples(), rows().map((row, i) => ({ ...row, observedAt: iso(START - (3 - i) * HOUR) })));
  assert.equal(await readFile(join(h.output, 'latest.json'), 'utf8'),
    await readFile(join(h.output, 'codex-usage-forecast-2026-01-15.json'), 'utf8'));
  assert.match(await readFile(join(h.output, 'codex-usage-forecast-2026-01-15.md'), 'utf8'), /表示専用.*振り分け/);
});

test('least squares uses uneven observation times and all points', async t => {
  const h = await harness(t);
  const points = rows([10, 40, 40]);
  points[2].observedAt = iso(START + 3 * HOUR);
  await h.seed(points);
  await h.run(snapshot(points[2]), START + 3 * HOUR);
  const window = (await h.report()).accounts[0].windows[0];
  assert.ok(Math.abs(window.ratePercentPerHour - 60 / 7) < 1e-10);
  assert.equal(window.reachesAt, iso(START + (8 + 1 / 3) * HOUR));
});

for (const [name, values, overrides, expected, reason, count] of [
  ['insufficient points', [10, 20], {}, 'unknown', 'insufficient-points', 2],
  ['latest value is stale', [10, 20, 30], { fresh: false }, 'unknown', 'stale', 0],
  ['zero pace', [20, 20, 20], {}, 'not-reaching', 'non-positive-rate', 3],
  ['negative pace', [30, 20, 10], {}, 'not-reaching', 'non-positive-rate', 3],
  ['90 percent after reset', [10, 11, 12], {}, 'not-reaching', 'at-or-after-reset', 3],
  ['90 percent exactly at reset', [66, 67, 68], {}, 'not-reaching', 'at-or-after-reset', 3],
  ['reset changed', [10, 20, 30], { resetAt: '2026-01-17T00:00:00.000Z' }, 'unknown', 'insufficient-points', 1],
  ['window length changed', [10, 20, 30], { windowMinutes: 300 }, 'unknown', 'insufficient-points', 1],
  ['window identity missing', [10, 20, 30], { resetAt: null }, 'unknown', 'incomplete-window', 0],
  ['reset has passed', [10, 20, 30], { resetAt: iso(START + HOUR) }, 'unknown', 'expired-window', 0],
  ['observation time missing', [10, 20, 30], { observedAt: null }, 'unknown', 'invalid-observation', 0],
  ['threshold already reached', [70, 80, 90], {}, 'reaches-90', 'already-at-90', 3],
]) {
  test(name, async t => {
    const h = await harness(t);
    const points = rows(values);
    await h.seed(points);
    await h.run(snapshot({ ...points.at(-1), ...overrides }), START + 2 * HOUR);
    const window = (await h.report()).accounts[0].windows[0];
    assert.equal(window.status, expected);
    assert.equal(window.reason, reason);
    assert.equal(window.sampleCount, count);
    if (expected !== 'reaches-90') assert.equal(window.reachesAt, null);
  });
}

test('historical stale points and repeated observation times do not supply three points', async t => {
  const h = await harness(t);
  const points = rows();
  await h.seed([points[0], { ...points[1], fresh: false }, points[2], points[2]]);
  await h.run(snapshot(points[2]), START + 2 * HOUR);
  const window = (await h.report()).accounts[0].windows[0];
  assert.equal(window.status, 'unknown');
  assert.equal(window.sampleCount, 2);
});

test('repeated observedAt is stored once per account and window; custom paths work', async t => {
  const h = await harness(t, { customPaths: true });
  const value = snapshot(usageWindow(20, START));
  value.accounts[0].windows.fiveHour = usageWindow(15, START, { windowMinutes: 300 });
  value.accounts[0].otherWindows = [usageWindow(12, START, { windowMinutes: 60 })];
  value.accounts.push({ ...value.accounts[0], label: 'second' });
  await h.run(value, START);
  await h.run(value, START + HOUR);
  assert.equal((await h.samples()).length, 6);
  assert.equal((await h.calls()).length, 2);
  assert.deepEqual((await h.report()).accounts.map(account => account.label), ['example', 'second']);
  await assert.rejects(readFile(join(h.home, '.claude/work/routing/codex-usage-samples.jsonl')), { code: 'ENOENT' });
});

for (const [time, forecast] of [
  ['2026-01-14T22:59:59Z', false], // 07:59 JST
  ['2026-01-14T23:00:00Z', true],
  ['2026-01-15T11:59:59Z', true], // 20:59 JST
  ['2026-01-15T12:00:00Z', false],
  ['2026-01-15T15:00:00Z', false], // Next JST day
]) {
  test(`JST time gate at ${time}`, async t => {
    const h = await harness(t);
    const now = Date.parse(time);
    await h.run(snapshot(usageWindow(10, now)), now);
    assert.equal((await h.samples()).length, 1);
    const files = await readdir(h.output);
    assert.equal(files.some(file => file.endsWith('.json')), forecast);
    assert.equal(files.some(file => file.endsWith('.md')), forecast);
  });
}

test('daily JSON is immutable, derived files recover, and the next day gets its own report', async t => {
  const h = await harness(t);
  await h.run(snapshot(usageWindow(10, START)), START);
  const original = await h.report();
  await rm(join(h.output, 'latest.json'));
  await rm(join(h.output, 'codex-usage-forecast-2026-01-15.md'));
  await h.run(snapshot(usageWindow(50, START + HOUR)), START + HOUR);
  assert.deepEqual(await h.report(), original);
  assert.deepEqual(JSON.parse(await readFile(join(h.output, 'latest.json'), 'utf8')), original);
  assert.match(await readFile(join(h.output, 'codex-usage-forecast-2026-01-15.md'), 'utf8'), /判定不能/);
  await h.run(snapshot(usageWindow(5, START + 24 * HOUR, { resetAt: '2026-01-18T00:00:00.000Z' })), START + 24 * HOUR);
  assert.equal((await h.report('2026-01-16')).date, '2026-01-16');
  assert.equal((await readdir(h.output)).filter(file => /forecast-.*\.json$/.test(file)).length, 2);
  assert.deepEqual(await h.report(), original);
});

test('date lock excludes a second publisher and concurrent runs share one daily JSON', async t => {
  const h = await harness(t);
  await h.seed(rows());
  const lock = join(h.output, 'codex-usage-forecast-2026-01-15.lock');
  await mkdir(lock);
  await h.run(snapshot(rows()[2]), START + 2 * HOUR);
  await assert.rejects(h.report(), { code: 'ENOENT' });
  await rm(lock, { recursive: true });
  await h.set(snapshot(rows()[2]));
  await Promise.all(Array.from({ length: 3 }, () => collectUsage({ env: h.env, now: START + 2 * HOUR })));
  assert.equal((await h.report()).accounts[0].windows[0].sampleCount, 3);
  assert.deepEqual((await readdir(h.output)).sort(), [
    'codex-usage-forecast-2026-01-15.json', 'codex-usage-forecast-2026-01-15.md',
    'codex-usage-samples.jsonl', 'latest.json',
  ]);
});

test('an account without windows is displayed as indeterminate', async t => {
  const h = await harness(t);
  await h.run(snapshot(null), START);
  assert.deepEqual((await h.report()).accounts[0].windows, []);
  assert.match(await readFile(join(h.output, 'codex-usage-forecast-2026-01-15.md'), 'utf8'), /判定不能: 窓の値がない/);
});

test('rotator failure exits nonzero, prints a short error, writes nothing and never retries', async t => {
  const h = await harness(t);
  const env = { ...h.env, FAKE_FAIL: '1' };
  const error = await execute(process.execPath, [resolve('scripts/codex-usage/collect.js')], { env })
    .then(() => assert.fail('expected failure'), error => error);
  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.equal(error.stderr, 'codex-usage: rotator status failed\n');
  assert.deepEqual(await h.calls(), [['status', '--json']]);
  await assert.rejects(readdir(h.output), { code: 'ENOENT' });
  await h.run(snapshot(usageWindow(10, START)), START);
  const before = await Promise.all((await readdir(h.output)).map(async file => [file, await readFile(join(h.output, file), 'utf8')]));
  await assert.rejects(collectUsage({ env, now: START + HOUR }), /rotator status failed/);
  const after = await Promise.all(before.map(async ([file]) => [file, await readFile(join(h.output, file), 'utf8')]));
  assert.deepEqual(after, before);
});

test('invalid status JSON does not create output', async t => {
  const h = await harness(t);
  await h.set({});
  await assert.rejects(collectUsage({ env: h.env, now: START }), /invalid status JSON/);
  await assert.rejects(readdir(h.output), { code: 'ENOENT' });
});
