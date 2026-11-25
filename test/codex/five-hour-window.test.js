// 設定 fiveHourWindow.enabled（5時間の窓を扱うか。既定は扱わない）のテスト。常駐を偽の時計と偽の上流で動かし、
// GET /internal/status の形と口座の選び方を確かめる。
//   - 扱わない（既定）: windows.fiveHour と aggregate.fiveHourRemainingPercent が null（キーは残る）で、スキーマの
//     検査に通る。長さ5時間の窓は、停止にも otherWindows にもログの使用率にも使わない。上流が使えないと
//     答えた口座（allowed:false）は、扱わない設定でも止まる。
//   - 扱う: 5時間の窓が windows.fiveHour に出て、その窓で口座が止まる。
//   - 真偽値でない値は扱わない（false）とし、常駐がログに1行出す。
//   - 読み直し（POST /internal/reload）で切り替わる。扱わない設定へ切り替えると、5時間の窓だけで止まって
//     いた口座の停止を解く。
//
// 絶対条件: 実の待受・実の設定・実のホーム・実の Codex CLI・実の上流へ届かない。env・要求関数・起動関数は
// 隔離の補助（helpers/isolation.js）のもの。常駐はポート0で待ち受け、割り当てられた番号だけを許して接続する。
// 上流は fetchImpl に渡す偽物、資格情報は readCredentials に渡す合成の値だけ。User-Agent と originator は
// 設定の合成の値を使い、版の読取（子プロセス）を起こさない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CodexConfigError, validateCodexConfig } from '../../src/codex/config.js';
import { startCodexDaemon } from '../../src/codex/daemon.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { codexRotatorConfigDir, codexRotatorConfigPath } from '../../src/codex/paths.js';
import { CONTROL_TOKEN_HEADER, readControlToken } from '../../src/codex/control-token.js';
import { codexStatusProblem } from '../../src/shared/codex-status-schema.js';
import { requestLocal } from '../../src/shared/local-http.js';
import { createFakeClock, createFakeScheduler } from './helpers/fake-time.js';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from './helpers/isolation.js';

const START = 1_800_000_000_000;
const MIN = 60_000;
const FIVE_HOURS_S = 18_000;
const WEEK_S = 604_800;
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });
const flush = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise(setImmediate); };

const upstreamWindow = (used, seconds, resetIn) => nowSec => ({ used_percent: used, limit_window_seconds: seconds,
  reset_after_seconds: resetIn, reset_at: nowSec + resetIn });
// zz-a は5時間の窓が止める線（75）を越え、週の窓は低い。zz-b は上流が使えないと答える。
const READINGS = Object.freeze({
  'zz-a': { allowed: true, primary: upstreamWindow(98, FIVE_HOURS_S, 600), secondary: upstreamWindow(20, WEEK_S, 86_400) },
  'zz-b': { allowed: false, primary: upstreamWindow(10, FIVE_HOURS_S, 600), secondary: upstreamWindow(10, WEEK_S, 86_400) },
});

function usageResponse(clock, { allowed, primary, secondary }) {
  const nowSec = Math.floor(clock.now() / 1000);
  return new Response(JSON.stringify({ rate_limit: { allowed, primary_window: primary(nowSec),
    secondary_window: secondary(nowSec) } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function rawConfig(isolation, fiveHourWindow) {
  const accountsDir = join(isolation.root, 'zz-accounts');
  return {
    enabled: true,
    acknowledgedMultiAccountRisk: true,
    accountsDir,
    daemon: { port: 0 },
    usageUserAgent: 'zz-fake-agent (zz-fake-comment)',
    usageOriginator: 'zz-fake-originator',
    ...(fiveHourWindow === undefined ? {} : { fiveHourWindow }),
    accounts: Object.keys(READINGS).map(label => ({ label, codexHome: join(accountsDir, label), usagePolicy: { ...POLICY } })),
  };
}

async function writeConfig(env, raw) {
  const dir = codexRotatorConfigDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(codexRotatorConfigPath(env), JSON.stringify(raw), { mode: 0o600 });
  await chmod(codexRotatorConfigPath(env), 0o600);
}

async function startDaemon(t, fiveHourWindow) {
  const isolation = await setupCodexIsolation(t);
  const clock = createFakeClock({ startMs: START });
  const scheduler = createFakeScheduler(clock);
  const env = isolation.env;
  await writeConfig(env, rawConfig(isolation, fiveHourWindow));
  const records = [];
  const logger = createCodexLogger({ level: 'debug', write: line => records.push(JSON.parse(line)) });
  let daemon;
  for (let attempt = 0; ; attempt++) {
    daemon = await startCodexDaemon({ env, spawn: isolation.spawn, now: clock.now, scheduler, logger,
      credentialEpoch: () => 1,
      readCredentials: async authPath => ({ accessToken: 'zz-fake-access', accountId: basename(dirname(authPath)) }),
      fetchImpl: async (url, init) => usageResponse(clock, READINGS[init.headers['ChatGPT-Account-ID']]) });
    if (!REAL_SERVICE_PORTS.includes(daemon.port)) break;
    await daemon.stop();
    if (attempt >= 5) throw new Error('the system kept assigning a real service port');
  }
  t.after(() => daemon.stop());
  isolation.allowRequest(daemon.port);
  const call = (path, options = {}) => requestLocal({ request: isolation.request, port: daemon.port, path, ...options });
  const f = {
    isolation, records,
    async tick(ms) { clock.advance(ms); await flush(); },
    async status() {
      const response = await call('/internal/status');
      assert.equal(response.status, 200);
      return JSON.parse(response.body);
    },
    async reload(nextFiveHourWindow) {
      await writeConfig(env, rawConfig(isolation, nextFiveHourWindow));
      const token = await readControlToken({ env });
      const response = await call('/internal/reload', { method: 'POST', headers: { [CONTROL_TOKEN_HEADER]: token } });
      assert.equal(response.status, 200, 'the reload is applied');
    },
    ignoredLines: () => records.filter(record => record.event === 'codex_daemon_setting_ignored'),
  };
  await f.tick(1);
  return f;
}

const accountOf = (json, label) => json.accounts.find(account => account.label === label);
const fiveHourIn = window => window.windowMinutes === FIVE_HOURS_S / 60;

// 5時間の窓を扱わないときの形: キーは残して null、どこにも長さ5時間の窓が出ない、5時間の窓で止まらない。
function assertFiveHourAbsent(json) {
  assert.equal(codexStatusProblem(json), null, 'the status passes the schema check');
  for (const account of json.accounts) {
    assert.ok(Object.hasOwn(account.windows, 'fiveHour'), 'the fiveHour key stays');
    assert.equal(account.windows.fiveHour, null);
    assert.equal(account.otherWindows.some(fiveHourIn), false, 'no five-hour window moves to otherWindows');
    assert.equal(account.latch?.cappedWindows.includes('fiveHour') ?? false, false);
  }
  assert.ok(Object.hasOwn(json.aggregate, 'fiveHourRemainingPercent'), 'the aggregate key stays');
  assert.equal(json.aggregate.fiveHourRemainingPercent, null);
  const a = accountOf(json, 'zz-a');
  assert.equal(a.windows.weekly.usedPercent, 20);
  assert.equal(a.stateWord, 'ready', 'a five-hour reading above the stop line does not stop the account');
  assert.equal(a.selectable, true);
  assert.equal(a.latch, null);
  assert.equal(json.next.label, 'zz-a');
  assert.equal(accountOf(json, 'zz-b').stateWord, 'blocked', 'an upstream refusal still stops the account');
}

test('five-hour window off (the default): the keys are null, the schema passes and the window is never used', async t => {
  const f = await startDaemon(t, undefined);
  assertFiveHourAbsent(await f.status());
  const reads = f.records.filter(record => record.event === 'codex_usage_read' && record.account_label === 'zz-a');
  assert.ok(reads.length > 0, 'zz-a was read');
  assert.ok(reads.every(record => record.used_percent === 20), 'the read log carries only the weekly percentage');
  assert.equal(f.ignoredLines().length, 0);
});

test('five-hour window on: the window is shown, counted and stops the account as before', async t => {
  const f = await startDaemon(t, { enabled: true });
  const json = await f.status();
  assert.equal(codexStatusProblem(json), null);
  const a = accountOf(json, 'zz-a');
  assert.equal(a.windows.fiveHour.usedPercent, 98);
  assert.equal(a.windows.fiveHour.windowMinutes, 300);
  assert.equal(a.stateWord, 'held');
  assert.deepEqual(a.latch.cappedWindows, ['fiveHour']);
  assert.equal(typeof json.aggregate.fiveHourRemainingPercent, 'number');
  assert.equal(accountOf(json, 'zz-b').windows.fiveHour.usedPercent, 10);
});

test('fiveHourWindow.enabled that is not true or false is treated as false, and an unknown key inside is refused', async t => {
  const isolation = await setupCodexIsolation(t);
  const validate = raw => validateCodexConfig(raw, { env: isolation.env });
  assert.deepEqual(validate({}).fiveHourWindow, { enabled: false });
  assert.deepEqual(validate({ fiveHourWindow: { enabled: true } }).fiveHourWindow, { enabled: true });
  for (const enabled of ['true', 1, null, {}]) {
    assert.deepEqual(validate({ fiveHourWindow: { enabled } }).fiveHourWindow, { enabled: false, enabledValueIgnored: true });
  }
  assert.throws(() => validate({ fiveHourWindow: { enable: true } }), CodexConfigError, 'an unknown key is refused');
});

test('a reload switches the five-hour window: off forgets the five-hour stop, on brings the window back', async t => {
  const f = await startDaemon(t, { enabled: true });
  assert.equal(accountOf(await f.status(), 'zz-a').stateWord, 'held');

  await f.reload({ enabled: false });
  assertFiveHourAbsent(await f.status());
  await f.tick(MIN);
  assertFiveHourAbsent(await f.status());

  await f.reload({ enabled: 'yes' });
  assertFiveHourAbsent(await f.status());
  assert.equal(f.ignoredLines().length, 1, 'one line for the ignored value');
  assert.equal(f.ignoredLines()[0].reason, 'five-hour-window-enabled-not-boolean');

  await f.reload({ enabled: true });
  await f.tick(MIN);
  const json = await f.status();
  assert.equal(codexStatusProblem(json), null);
  assert.equal(accountOf(json, 'zz-a').windows.fiveHour.usedPercent, 98);
  assert.equal(accountOf(json, 'zz-a').stateWord, 'held');
  assert.equal(typeof json.aggregate.fiveHourRemainingPercent, 'number');
});
