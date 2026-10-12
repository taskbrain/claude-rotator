// `claude-rotator status` の Codex の節を子プロセスで読む部品（src/codex-status-child.js）と、それを使う
// `claude-rotator status` のテスト。Codex の設定ファイルが無いときの画面、子の起動の引数、子の出力を表示に
// 使えないときの1行と理由、親が子を待つ期限、時間の約束の親の側（子が期限内に書いた JSON を親が節として描く）、
// 秘密とパスの目印が画面にも子の標準エラーにも出ないこと、ログインが切れた口座の出方を確かめる。
//
// 隔離: 本物の子プロセスは起動しない。spawn は偽物に替え、子の中身が要るテストは、同じプロセスの中で
// `codex-rotator status --json --section` の本体（runStatus）を走らせる偽物を使う。env・常駐への要求関数・
// child_process は隔離の補助（test/codex/helpers/isolation.js）のもので、Codex CLI も常駐も使わない。
// 偽の資格情報と上流の応答の中身は合成の値。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runCli } from '../src/cli.js';
import { CODEX_SECTION_ARGS, CODEX_SECTION_MAX_BYTES, createCodexSectionReader } from '../src/codex-status-child.js';
import { CODEX_VERSION_READ_TIMEOUT_MS } from '../src/codex/client-version.js';
import { CODEX_CONFIG_DEFAULTS, DEFAULT_DAEMON_PORT } from '../src/codex/config.js';
import { STATUS_DAEMON_TIMEOUT_MS, STATUS_LINE, disabledCodexStatus, runStatus } from '../src/codex/direct-read.js';
import { codexRotatorConfigDir, codexRotatorConfigPath } from '../src/codex/paths.js';
import { renderStatus } from '../src/monitor.js';
import { codexRotatorEntryPath } from '../src/shared/codex-locator.js';
import { CODEX_CHILD_TIMEOUT_MS, CODEX_SECTION_DEADLINE_MS } from '../src/shared/codex-status-schema.js';
import { renderCodexDisplayError } from '../src/shared/codex-view.js';
import { terminalPadEnd } from '../src/shared/terminal-text.js';
import { createFakeClock, createFakeScheduler } from './codex/helpers/fake-time.js';
import { setupCodexIsolation } from './codex/helpers/isolation.js';

const START = Date.UTC(2027, 0, 15, 8, 0, 0);
const HEADING = terminalPadEnd('Codex Rotator', 39);
// 偽の codex の場所（起動されない。探す処理と spawn は偽物）。
const CODEX_PATH = '/zz-fake-bin/codex';
const FAKE_VERSION = [9, 8, 7].join('.');
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
const overrideIdentity = Object.freeze({ usageUserAgent: 'zz-fake-ua', usageOriginator: 'zz-fake-originator' });
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };

// 本物の時計で少しずつ待ち、predicate が真になるのを待つ（ファイルの有無を確かめる間の待ち）。
async function waitFor(predicate, message) {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), message);
}

// Claude 側の状態（合成の値。時刻に依る項目を持たない）。
const claudeStatus = () => ({
  currentAccount: 'acct_1',
  currentAccountName: 'zz-claude-one',
  accounts: [{ id: 'acct_1', name: 'zz-claude-one', status: 'active', quota: { unified5h: 0.76, unified7d: 0.4 },
    usage: { totalRequests: 1 } }],
  events: [],
});

// `claude-rotator status` を走らせ、終了コードと画面を返す。
async function statusScreen(readCodexSection, status = claudeStatus()) {
  let out = '';
  const code = await runCli(['status'], {
    readStatus: async () => status,
    ...(readCodexSection ? { readCodexSection } : {}),
    write: text => { out += text; },
    error: text => { out += text; },
  });
  return { code, out };
}

// 画面の Codex の節の行（見出しの行から、節の終わりの空行の前まで）。
function codexLines(out) {
  const lines = out.split('\n');
  const start = lines.findIndex(line => line.startsWith('Codex Rotator'));
  if (start < 0) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start, end < 0 ? undefined : end);
}
const rowOf = (lines, label) => lines.find(line => line.startsWith(`  ${label} `));

async function writeCodexConfig(env, raw = {}) {
  const folder = codexRotatorConfigDir(env);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  await writeFile(codexRotatorConfigPath(env), JSON.stringify(raw), { mode: 0o600 });
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

// 偽の spawn。呼出しを calls に残し、behave(child) で子の振る舞いを決める（spawn から戻った後に走らせる）。
function fakeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    calls.push({ command, args, options, child });
    setImmediate(() => behave(child));
    return child;
  };
  return { spawn, calls };
}
const printAndExit = (stdout, code = 0, signal = null) => child => {
  if (stdout !== null) child.stdout.emit('data', Buffer.from(stdout));
  child.emit('close', code, signal);
};

// 子の代わりに、同じプロセスの中で `codex-rotator status --json --section` の本体（runStatus）を走らせる偽の
// spawn。子の標準出力は偽の子の stdout へ流し（書いた時刻を writtenAt に残す）、標準エラーは呼出しごとに
// stderr に残す。終わったら終了コードで閉じる。
function inProcessChild(deps) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = fakeChild();
    const call = { command, args, options, child, stderr: '', writtenAt: null };
    calls.push(call);
    const [, subcommand, ...rest] = args;
    assert.equal(subcommand, 'status');
    const io = {
      stdout: { write: chunk => {
        call.writtenAt = (deps.now ?? Date.now)();
        child.stdout.emit('data', Buffer.from(String(chunk)));
        return true;
      } },
      stderr: { write: chunk => { call.stderr += String(chunk); return true; } },
      env: options.env,
    };
    Promise.resolve().then(() => runStatus(rest, io, deps)).then(code => child.emit('close', code, null));
    return child;
  };
  return { spawn, calls };
}

// --- Codex の設定ファイルが無いとき -------------------------------------------------------------------

// 記録した見本（test/golden/status/）と同じ合成の入力。test/status-golden.test.js の入力と同じ値で、
// 食い違えば見本とのバイト比較が落ちる。
const GOLDEN_NOW = Date.UTC(2026, 5, 4, 9, 0, 0);
const goldenMinutes = n => n * 60000;
const goldenHours = n => goldenMinutes(60 * n);
const goldenDays = n => goldenHours(24 * n);
const goldenIso = ms => new Date(ms).toISOString();
const goldenRoute = (account, accountName, state, availableAt = null) =>
  ({ account, accountName, state, availableAt: availableAt === null ? null : goldenIso(availableAt) });
const GOLDEN_SAMPLES = Object.freeze({
  'accounts-0': () => ({ currentAccount: null, currentAccountName: null, switchThreshold: 1,
    routingAvailability: { fable: [], other: [] }, accounts: [], events: [] }),
  'accounts-1-events': () => ({
    currentAccount: 'acct_1',
    currentAccountName: 'zz-golden-one',
    switchThreshold: 1,
    routingAvailability: {
      fable: [goldenRoute('acct_1', 'zz-golden-one', 'available')],
      other: [goldenRoute('acct_1', 'zz-golden-one', 'available')],
    },
    accounts: [{
      id: 'acct_1',
      name: 'zz-golden-one',
      status: 'active',
      quota: {
        unified5h: 0.31,
        unified7d: 0.54,
        unified5hReset: GOLDEN_NOW + goldenHours(2) + goldenMinutes(12),
        unified7dReset: GOLDEN_NOW + goldenDays(3) + goldenHours(16),
        weeklyScoped: [{ key: 'fable', label: 'Fable', utilization: 0.5, resetAt: GOLDEN_NOW + goldenDays(2) }],
      },
      usage: { totalRequests: 3 },
    }],
    events: [
      { at: goldenIso(GOLDEN_NOW - goldenMinutes(2)), type: 'proxy-request', account: 'acct_1', method: 'POST',
        path: '/v1/messages', statusCode: 200, durationMs: 812, outcome: 'success', requestId: 'zz-request-1' },
      { at: goldenIso(GOLDEN_NOW - goldenMinutes(5)), type: 'upstream-error', account: 'acct_1',
        reason: { type: 'temporary_throttle', retryAt: goldenIso(GOLDEN_NOW - goldenMinutes(4)) } },
      { at: goldenIso(GOLDEN_NOW - goldenMinutes(9)), type: 'auto-switch', from: null, to: 'acct_1' },
    ],
  }),
  'accounts-3-events-affinity': () => {
    const routes = () => [
      goldenRoute('acct_2', 'zz-golden-two', 'available'),
      goldenRoute('acct_1', 'zz-golden-one', 'waiting', GOLDEN_NOW + goldenHours(1)),
      goldenRoute('acct_3', 'zz-golden-three', 'needs-login'),
    ];
    return {
      currentAccount: 'acct_2',
      currentAccountName: 'zz-golden-two',
      switchThreshold: 1,
      routingAvailability: { fable: routes(), other: routes() },
      accounts: [
        {
          id: 'acct_1',
          name: 'zz-golden-one',
          status: 'exhausted',
          quota: { unified5h: 1, unified7d: 0.76, unified5hReset: GOLDEN_NOW + goldenHours(1),
            unified7dReset: GOLDEN_NOW + goldenDays(2) + goldenHours(9) },
          usage: { totalRequests: 12 },
          unavailableReason: { type: 'quota_exhausted', window: '5h', utilization: 1,
            resetAt: goldenIso(GOLDEN_NOW + goldenHours(1)) },
        },
        {
          id: 'acct_2',
          name: 'zz-golden-two',
          status: 'active',
          quota: { unified5h: 0.08, unified7d: 0.21, unified5hReset: GOLDEN_NOW + goldenHours(4) + goldenMinutes(40),
            unified7dReset: GOLDEN_NOW + goldenDays(5) + goldenHours(1) },
          usage: { totalRequests: 7 },
        },
        {
          id: 'acct_3',
          name: 'zz-golden-three',
          status: 'error',
          quota: {},
          usage: { totalRequests: 0 },
          unavailableReason: { type: 'oauth_refresh_failed', cause: 'http-401',
            at: goldenIso(GOLDEN_NOW - goldenHours(3)) },
        },
      ],
      events: [
        { at: goldenIso(GOLDEN_NOW - goldenMinutes(1)), type: 'manual-switch', account: 'acct_2' },
        { at: goldenIso(GOLDEN_NOW - goldenMinutes(7)), type: 'fallback-switch', from: 'acct_1', to: 'acct_2',
          reason: 'shortest-quota-reset' },
        { at: goldenIso(GOLDEN_NOW - goldenMinutes(8)), type: 'quota-exhausted', account: 'acct_1',
          reason: { type: 'quota_exhausted', window: '5h', resetAt: goldenIso(GOLDEN_NOW + goldenHours(1)) } },
        { at: goldenIso(GOLDEN_NOW - goldenHours(3)), type: 'account-error', account: 'acct_3',
          reason: { type: 'oauth_refresh_failed' } },
      ],
      sessionAffinity: {
        mode: 'on',
        sessions: 2,
        capacity: 10000,
        sessionsByAccount: { acct_1: 1, acct_2: 1 },
        switchesByReason: { common_exhausted: 1 },
        evictionsByReason: { ttl: 3 },
        requests: { proxied: 3, keyed: 2 },
        sidRate: 0.6667,
      },
    };
  },
});

// 見本を記録したときと同じく、描く間だけ時刻を見本の時刻にし、端末の幅を既定の80桁にそろえる。
async function goldenScreen(reader, status) {
  const realNow = Date.now;
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Date.now = () => GOLDEN_NOW;
  Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true, writable: true });
  try {
    return await statusScreen(reader, status);
  } finally {
    Date.now = realNow;
    if (columns) Object.defineProperty(process.stdout, 'columns', columns);
    else delete process.stdout.columns;
  }
}

test('no config file: nothing is started and claude-rotator status prints every recorded sample byte for byte', async t => {
  const isolation = await setupCodexIsolation(t);
  const fake = fakeSpawn(printAndExit('{}'));
  const reader = createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn });
  assert.equal(await reader(), null);
  // 記録した見本の全部について、同じ入力で描き、見本のファイルとバイト単位で比べる。
  for (const [name, build] of Object.entries(GOLDEN_SAMPLES)) {
    const screen = await goldenScreen(reader, build());
    assert.equal(screen.code, 0, name);
    assert.equal(screen.out, await readFile(new URL(`./golden/status/${name}.txt`, import.meta.url), 'utf8'), name);
  }
  // ほかの画面も、読取関数が無いときと1バイトも変わらない。
  assert.deepEqual(await statusScreen(reader), await statusScreen(undefined));
  // 場所を決められない env（HOME も XDG_CONFIG_HOME も絶対パスでない）でも、何も起こさない。
  const nowhere = createCodexSectionReader({ env: { HOME: 'relative-home' }, spawnImpl: fake.spawn });
  assert.equal(await nowhere(), null);
  assert.equal(fake.calls.length, 0, 'no child is started without a config file');
});

test('reader: it cannot be built without a spawn function', () => {
  assert.throws(() => createCodexSectionReader({ env: {} }), TypeError);
});

// --- 子の起動 -------------------------------------------------------------------------------------

test('reader: starts this Node binary on the absolute entry path with status --json --section, without a shell or a PATH search', async t => {
  const isolation = await setupCodexIsolation(t);
  await writeCodexConfig(isolation.env);
  const status = disabledCodexStatus(START);
  const fake = fakeSpawn(printAndExit(`${JSON.stringify(status)}\n`));
  const result = await createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn })();
  assert.equal(fake.calls.length, 1);
  const [{ command, args, options }] = fake.calls;
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [codexRotatorEntryPath(), 'status', '--json', '--section']);
  assert.deepEqual(CODEX_SECTION_ARGS, ['status', '--json', '--section']);
  assert.ok(isAbsolute(args[0]), args[0]);
  assert.ok(args[0].endsWith(join('bin', 'codex-rotator.js')), args[0]);
  assert.equal(options.shell, false);
  assert.equal(options.env, isolation.env, 'the child gets the env the reader was given');
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore'], 'the child stdin and stderr are not connected');
  assert.deepEqual(result, { ok: true, status });
  const screen = await statusScreen(createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn }));
  assert.equal(screen.code, 0);
  assert.deepEqual(codexLines(screen.out), [`${HEADING}disabled (requires enabled and acknowledgedMultiAccountRisk)`]);
});

// --- 子の出力を表示に使えないとき ---------------------------------------------------------------------------

test('reader: output that cannot be used is one display error line with a fixed reason, and the exit code stays 0', async t => {
  const isolation = await setupCodexIsolation(t);
  await writeCodexConfig(isolation.env);
  const valid = JSON.stringify(disabledCodexStatus(START));
  const startError = Object.assign(new Error('zz-spawn-error'), { code: 'ENOENT' });
  const cases = [
    { name: 'not JSON', behave: printAndExit('{"schemaVersion":'), reason: 'invalid json' },
    { name: 'an extra key', behave: printAndExit(JSON.stringify({ ...JSON.parse(valid), zzExtra: 1 })), reason: 'schema' },
    { name: 'a wrong type', behave: printAndExit(JSON.stringify({ ...JSON.parse(valid), enabled: 'yes' })), reason: 'schema' },
    { name: 'over the size limit', behave: printAndExit(`${valid}${' '.repeat(CODEX_SECTION_MAX_BYTES - valid.length + 1)}`),
      reason: 'too large', killed: true },
    { name: 'a non-zero exit', behave: printAndExit(valid, 3), reason: 'exit 3' },
    { name: 'a signal', behave: printAndExit(null, null, 'SIGTERM'), reason: 'signal SIGTERM' },
    { name: 'a child that cannot start', behave: child => child.emit('error', startError), reason: 'spawn failed', killed: true },
    // 子の標準出力の管が error を出したとき（受け手が無いと、親のプロセスごと落ちる）。
    { name: 'an error on the child stdout', behave: child => child.stdout.emit('error', new Error('zz-stdout-error')),
      reason: 'spawn failed', killed: true },
  ];
  for (const { name, behave, reason, killed = false } of cases) {
    const fake = fakeSpawn(behave);
    const reader = createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn });
    const result = await reader();
    assert.deepEqual(result, { ok: false, reason }, name);
    assert.deepEqual(fake.calls[0].child.kills, killed ? ['SIGKILL'] : [], `${name}: stopped only when still running`);
    const screen = await statusScreen(reader);
    assert.equal(screen.code, 0, name);
    assert.deepEqual(codexLines(screen.out), [`${HEADING}codex: display error (${reason})`], name);
    assert.deepEqual(renderCodexDisplayError(reason), [`${HEADING}codex: display error (${reason})`, ''], name);
    assert.equal(screen.out, renderStatus(claudeStatus(), { codex: result }), `${name}: the Claude side is drawn as before`);
    assert.ok(screen.out.includes('zz-claude-one'), name);
  }
  // spawn がその場で例外を投げる（起動の関数が断る）ときも同じ1行になる。
  const throwing = () => { throw Object.assign(new Error('zz-refused'), { code: 'EACCES' }); };
  const reader = createCodexSectionReader({ env: isolation.env, spawnImpl: throwing });
  assert.deepEqual(await reader(), { ok: false, reason: 'spawn failed' });
  assert.deepEqual(codexLines((await statusScreen(reader)).out), [`${HEADING}codex: display error (spawn failed)`]);
});

test('reader: output exactly at the size limit is still used', async t => {
  const isolation = await setupCodexIsolation(t);
  await writeCodexConfig(isolation.env);
  const status = disabledCodexStatus(START);
  const text = JSON.stringify(status);
  const fake = fakeSpawn(printAndExit(`${text}${' '.repeat(CODEX_SECTION_MAX_BYTES - text.length)}`));
  assert.deepEqual(await createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn })(), { ok: true, status });
});

test('reader: a child still running at 8000 ms is stopped and drawn as timeout 8000ms', async t => {
  const isolation = await setupCodexIsolation(t);
  await writeCodexConfig(isolation.env);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const fake = fakeSpawn(() => {});
  const reader = createCodexSectionReader({ env: isolation.env, spawnImpl: fake.spawn, scheduler });
  let settled = false;
  const screen = statusScreen(reader).finally(() => { settled = true; });
  await waitFor(() => fake.calls.length === 1, 'the child is started');
  assert.equal(CODEX_CHILD_TIMEOUT_MS, 8000);
  clock.advance(CODEX_CHILD_TIMEOUT_MS - 1);
  await flush();
  assert.equal(settled, false, 'the parent still waits 1 ms before its deadline');
  clock.advance(1);
  await flush();
  const { code, out } = await screen;
  assert.equal(code, 0);
  assert.deepEqual(codexLines(out), [`${HEADING}codex: display error (timeout 8000ms)`]);
  assert.deepEqual(fake.calls[0].child.kills, ['SIGKILL']);
});

// --- 時間の約束（親の側） ------------------------------------------------------------------------------

function configOf(labels, overrides = {}) {
  return {
    enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: '/zz-accounts', daemon: { port: DEFAULT_DAEMON_PORT },
    usagePollIntervalMs: 60000, usageReadTimeoutMs: CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs,
    rotationObservationTtlMs: 125000, rotationUsageCapNoResetProbeMs: 3600000,
    codexPath: CODEX_PATH, usageUserAgent: null, usageOriginator: null,
    accounts: labels.map(label => ({ label, codexHome: `/zz-accounts/${label}`, usagePolicy: { ...POLICY } })),
    ...overrides,
  };
}

const credentialsOf = async path => {
  const label = path.split('/').at(-2);
  return { accountId: `zz-account-id-${label}`, accessToken: 'zz-fake-access-token' };
};

function windowOf(used, seconds, resetIn) {
  return { usedPercent: used, windowResetAt: START + resetIn * 1000, resetAfterSeconds: resetIn, limitWindowSeconds: seconds,
    complete: true, incompleteReason: null };
}
const usageResult = () => ({ classification: 'success', status: 200, receivedAt: START, failure: null, errorCode: null,
  retryAfter: null, observation: { ordinaryUsageAllowed: true, rateLimitReachedType: null, complete: true,
    primary: windowOf(10, 18000, 3600), secondary: windowOf(20, 604800, 86400) } });

// 偽の時計で ms の後に結果を返す（null なら返さない）。
const after = (scheduler, ms, result) => new Promise(resolve => {
  if (ms !== null) scheduler.setTimeout(() => resolve(result), ms);
});

// 受け付けて何も返さない常駐への要求関数。
function stallingRequest() {
  const calls = [];
  const request = url => {
    const req = new EventEmitter();
    req.end = () => {};
    req.destroy = () => { req.destroyed = true; return req; };
    calls.push(String(url));
    return req;
  };
  return { request, calls };
}

// 偽の codex の `--version` の子。afterMs の後に版を出して閉じる（null なら何も出さない）。
function versionSpawn(scheduler, { afterMs }) {
  const calls = [];
  const spawn = (command, args) => {
    const child = fakeChild();
    calls.push({ command, args });
    if (afterMs !== null) {
      scheduler.setTimeout(() => {
        child.stdout.emit('data', Buffer.from(`codex-cli ${FAKE_VERSION}\n`));
        child.emit('close', 0, null);
      }, afterMs);
    }
    return child;
  };
  return { spawn, calls };
}

// 偽の時計の上で `claude-rotator status` を始める。Codex の節は、同じ偽の時計で動く子（runStatus）から読む。
// build(scheduler) が子の差し替えの部品 { config, request, spawn, readUsage } を返す。
async function startScreenOnFakeClock(t, build) {
  const isolation = await setupCodexIsolation(t);
  await writeCodexConfig(isolation.env);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const { config, request, spawn, readUsage } = build(scheduler);
  const child = inProcessChild({ now: clock.now, scheduler, request: request ?? isolation.request,
    loadConfigSnapshot: async () => ({ config, sha256: 'f'.repeat(64) }), findCodex: () => ({ path: CODEX_PATH }),
    spawn: spawn ?? isolation.spawn, readCredentials: credentialsOf, readUsage });
  const reader = createCodexSectionReader({ env: isolation.env, spawnImpl: child.spawn, scheduler });
  let settled = false;
  const screen = statusScreen(reader).finally(() => { settled = true; });
  await waitFor(() => child.calls.length === 1, 'the child is started');
  await flush();
  return { clock, child, screen, isolation, settled: () => settled };
}

test('time budget: after a silent daemon, a read that returns 1 ms before the child deadline is drawn as the Codex section', async t => {
  const stall = stallingRequest();
  const run = await startScreenOnFakeClock(t, scheduler => ({ config: configOf(['zz-a'], overrideIdentity),
    request: stall.request,
    readUsage: () => after(scheduler, CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS - 1, usageResult()) }));
  assert.equal(stall.calls.length, 1, 'the child asked the daemon');
  run.clock.advance(STATUS_DAEMON_TIMEOUT_MS);
  await flush();
  run.clock.advance(CODEX_SECTION_DEADLINE_MS - STATUS_DAEMON_TIMEOUT_MS - 1);
  await flush();
  const { code, out } = await run.screen;
  assert.equal(code, 0);
  assert.equal(run.child.calls[0].writtenAt, START + CODEX_SECTION_DEADLINE_MS - 1, 'the child wrote its JSON in time');
  const lines = codexLines(out);
  assert.ok(lines[0].startsWith(`${HEADING}sendable 1/1`), lines[0]);
  assert.ok(lines[1].startsWith('  reading  usage GET, direct'), lines[1]);
  assert.ok(lines.includes('  latch    unknown (no daemon)'));
  assert.ok(rowOf(lines, 'zz-a').includes(' ready '));
  assert.ok(!out.includes('display error'));
});

test('time budget: eight slow accounts are cut by the child at its deadline and drawn as unread (read-deadline)', async t => {
  const labels = ['zz-a', 'zz-b', 'zz-c', 'zz-d', 'zz-e', 'zz-f', 'zz-g', 'zz-h'];
  const config = configOf(labels, overrideIdentity);
  config.accounts[7].usagePolicy.blockWhenUnknown = true;
  const run = await startScreenOnFakeClock(t, () => ({ config, readUsage: () => new Promise(() => {}) }));
  run.clock.advance(CODEX_SECTION_DEADLINE_MS - 1);
  await flush();
  assert.equal(run.settled(), false, 'nothing is drawn before the child deadline');
  run.clock.advance(1);
  await flush();
  const { code, out } = await run.screen;
  assert.equal(code, 0);
  assert.equal(run.child.calls[0].writtenAt, START + CODEX_SECTION_DEADLINE_MS);
  const lines = codexLines(out);
  for (const label of labels.slice(0, 7)) assert.ok(rowOf(lines, label).includes(' unread '), label);
  assert.ok(rowOf(lines, 'zz-h').includes(' reserved '));
  assert.ok(!out.includes('display error'));
});

test('time budget: a version read that returns 1 ms before its own deadline leaves a Codex section in time', async t => {
  let version;
  const run = await startScreenOnFakeClock(t, scheduler => {
    version = versionSpawn(scheduler, { afterMs: CODEX_VERSION_READ_TIMEOUT_MS - 1 });
    return { config: configOf(['zz-a']), spawn: version.spawn,
      readUsage: () => after(scheduler, CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs - 1, usageResult()) };
  });
  run.clock.advance(CODEX_VERSION_READ_TIMEOUT_MS - 1);
  await flush();
  run.clock.advance(CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs - 1);
  await flush();
  const { code, out } = await run.screen;
  assert.equal(code, 0);
  assert.ok(run.child.calls[0].writtenAt < START + CODEX_SECTION_DEADLINE_MS);
  assert.equal(version.calls.length, 1);
  assert.ok(rowOf(codexLines(out), 'zz-a').includes(' ready '));
  assert.ok(!out.includes('display error'));
});

test('time budget: a version read that runs out leaves every account unread (reserved when it blocks), drawn as a section', async t => {
  const config = configOf(['zz-a', 'zz-b']);
  config.accounts[1].usagePolicy.blockWhenUnknown = true;
  const run = await startScreenOnFakeClock(t, scheduler => ({ config,
    spawn: versionSpawn(scheduler, { afterMs: null }).spawn, readUsage: () => assert.fail('no usage read without a User-Agent') }));
  run.clock.advance(CODEX_VERSION_READ_TIMEOUT_MS);
  await flush();
  const { code, out } = await run.screen;
  assert.equal(code, 0);
  assert.ok(run.child.calls[0].writtenAt < START + CODEX_SECTION_DEADLINE_MS);
  const lines = codexLines(out);
  assert.ok(rowOf(lines, 'zz-a').includes(' unread '));
  assert.ok(rowOf(lines, 'zz-b').includes(' reserved '));
  const clears = `    ${terminalPadEnd('clears', 9)}needs a readable codex CLI (codex CLI version unreadable)`;
  assert.equal(lines.filter(line => line === clears).length, 2);
  assert.ok(!out.includes('display error'));
});

// --- 秘密とパスの目印、ログインが切れた口座 ---------------------------------------------------------------

// パスに含める合成の目印と、偽の資格情報・上流の応答に入れる合成の値（どれも画面にも子の標準エラーにも出てはならない）。
const PATH_MARKER = 'ZZ-PATH-MARKER';
const TOKEN_MARKER = 'ZZTOKENMARKER'.repeat(3);
const FAKE_EMAIL = 'zz-fake-user@example.invalid';
const FAKE_REFRESH_TOKEN = `rt_zz_fake_${'9'.repeat(32)}`;
const FAKE_USER_ID = 'zz-user-id-marker';
const DUMMY_BEARER = 'Bearer zz-fake-bearer-token';
const MAIL_LIKE = /[^\s"]+@[^\s"]+/g;
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]*/g;
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = claims => `${base64url({ alg: 'none' })}.${base64url(claims)}.${'Z'.repeat(24)}`;
const accountIdOf = label => `zz-account-id-${label}-marker`;
const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

function authJson(label, { expired = false } = {}) {
  const expSeconds = Math.floor((expired ? FIXED_NOW_MS - 3600000 : FIXED_NOW_MS + 3600000) / 1000);
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: {
    id_token: fakeJwt({ email: FAKE_EMAIL, 'https://api.openai.com/auth': { chatgpt_account_id: accountIdOf(label) } }),
    access_token: fakeJwt({ exp: expSeconds, zz: TOKEN_MARKER }),
    refresh_token: FAKE_REFRESH_TOKEN,
    account_id: accountIdOf(label),
  } });
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const usageBody = () => ({ email: FAKE_EMAIL, user_id: FAKE_USER_ID, note: DUMMY_BEARER, rate_limit: { allowed: true,
  primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 600 },
  secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_after_seconds: 6000 } } });

// 隔離の一時フォルダに、Codex の設定・口座のフォルダ・偽の資格情報を作り、子（runStatus）を同じプロセスで走らせる
// 読取関数を返す。creds は 'ok'・'expired'・'missing'。respondFor(label) が上流の応答。
async function markedFixture(t, accounts, respondFor) {
  const isolation = await setupCodexIsolation(t);
  const accountsDir = join(isolation.home, `zz-accounts-${PATH_MARKER}`);
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  await chmod(accountsDir, 0o700);
  const entries = [];
  for (const { label, creds = 'ok' } of accounts) {
    const codexHome = join(accountsDir, `${PATH_MARKER}-${label}`);
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    if (creds !== 'missing') {
      await writeFile(join(codexHome, 'auth.json'), authJson(label, { expired: creds === 'expired' }), { mode: 0o600 });
    }
    entries.push({ label, codexHome, usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 60 } });
  }
  await writeCodexConfig(isolation.env, { enabled: true, acknowledgedMultiAccountRisk: true, accountsDir,
    ...overrideIdentity, accounts: entries });
  const fetchImpl = async (url, init) => {
    const label = init.headers['ChatGPT-Account-ID'].replace(/^zz-account-id-/, '').replace(/-marker$/, '');
    return respondFor(label);
  };
  const childFor = (deps = {}) => inProcessChild({ now: () => FIXED_NOW_MS, request: isolation.request,
    findCodex: () => ({ path: CODEX_PATH }), spawn: isolation.spawn, fetchImpl, ...deps });
  const secrets = [PATH_MARKER, isolation.root, accountsDir, TOKEN_MARKER, FAKE_EMAIL, FAKE_REFRESH_TOKEN, FAKE_USER_ID,
    DUMMY_BEARER, 'zz-fake-ua', 'zz-fake-originator', ...accounts.map(({ label }) => accountIdOf(label))];
  return { isolation, childFor, secrets };
}

function assertNothingSecret(text, secrets, where) {
  for (const value of secrets) assert.equal(text.includes(value), false, `${where}: ${value}`);
  assert.equal(text.match(MAIL_LIKE), null, `${where}: a mail-address-like string`);
  assert.equal(text.match(TOKEN_LIKE), null, `${where}: a token-like string`);
  assert.equal(text.includes('auth.json'), false, where);
}

test('secrets: no mail address, token, account id or path marker reaches the screen or the child stderr, and expired logins show how to fix them', async t => {
  const f = await markedFixture(t, [{ label: 'zz-ok' }, { label: 'zz-expired', creds: 'expired' }, { label: 'zz-unauth' },
    { label: 'zz-forbid' }, { label: 'zz-nocreds', creds: 'missing' }], label => ({
    'zz-unauth': jsonResponse({ error: DUMMY_BEARER, email: FAKE_EMAIL }, 401),
    'zz-forbid': jsonResponse({ error: DUMMY_BEARER, email: FAKE_EMAIL }, 403),
  })[label] ?? jsonResponse(usageBody()));
  const child = f.childFor();
  const { code, out } = await statusScreen(createCodexSectionReader({ env: f.isolation.env, spawnImpl: child.spawn }));
  assert.equal(code, 0);
  assert.equal(child.calls[0].stderr, '', 'nothing on the child stderr when it succeeds');
  assertNothingSecret(out, f.secrets, 'screen');
  const lines = codexLines(out);
  const clearsAfter = label => lines.slice(lines.indexOf(rowOf(lines, label)) + 1).find(line => line.startsWith('    clears'));
  for (const label of ['zz-expired', 'zz-unauth', 'zz-forbid']) {
    assert.ok(rowOf(lines, label).includes(' needs login '), label);
    assert.ok(clearsAfter(label).endsWith(`run codex-rotator login --label ${label} --relogin`), label);
  }
  assert.ok(rowOf(lines, 'zz-nocreds').includes(' no creds '));
  assert.ok(clearsAfter('zz-nocreds').endsWith('run codex-rotator remove --label zz-nocreds, then log in again with codex-rotator login'));
  assert.ok(rowOf(lines, 'zz-ok').includes(' ready '));
});

test('secrets: when the child fails, its stderr carries only the fixed words and the screen only the display error line', async t => {
  const f = await markedFixture(t, [{ label: 'zz-a' }], () => jsonResponse(usageBody()));
  // 予期しない失敗（目印を含む例外）: 子は status unavailable だけを書いて 1 で終わる。
  const failing = f.childFor({ findCodex: () => { throw new Error(`zz-unexpected ${PATH_MARKER} ${FAKE_EMAIL}`); } });
  const failed = await statusScreen(createCodexSectionReader({ env: f.isolation.env, spawnImpl: failing.spawn }));
  assert.equal(failed.code, 0);
  assert.equal(failing.calls[0].stderr, `${STATUS_LINE.failed}\n`);
  assert.deepEqual(codexLines(failed.out), [`${HEADING}codex: display error (exit 1)`]);
  // 読めない設定（自分以外も読める権限）: 子は config unreadable だけを書いて 1 で終わる。
  await chmod(codexRotatorConfigPath(f.isolation.env), 0o644);
  const unreadable = f.childFor();
  const screen = await statusScreen(createCodexSectionReader({ env: f.isolation.env, spawnImpl: unreadable.spawn }));
  assert.equal(unreadable.calls[0].stderr, `${STATUS_LINE.configUnreadable}\n`);
  assert.deepEqual(codexLines(screen.out), [`${HEADING}codex: display error (exit 1)`]);
  for (const text of [failing.calls[0].stderr, unreadable.calls[0].stderr, failed.out, screen.out]) {
    assertNothingSecret(text, f.secrets, 'child stderr and screen');
  }
});
