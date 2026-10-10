// `claude-rotator status` の出力の見本（golden）との比べ合わせ。
//
// 合成の入力（口座0・1・3件、Events、セッション固定の節）だけを runCli へ渡し、画面の文字列が
// test/golden/status/ の見本とバイト単位で一致することを確かめる。Codex の節を描く処理を足しても、
// Codex の設定ファイルが無いときの画面が1バイトも変わらないことを固定するためのもの。
//
// 隔離: env は一時フォルダの中だけを指し、Claude 側の設定ファイルも Codex の設定ファイルも置かない
// （どちらの設定も「無い」状態で描く）。状態は readStatus の差し替えで渡し、常駐へは問い合わせない。
// 画面は時刻と端末の幅で変わるので、描く間だけ Date.now を固定の時刻にし、端末の幅を「分からない」
// （既定の 80 桁）にそろえる。
//
// 見本の記録: 見本のファイルが無い・中身が違うときは、今の出力を base64 にして
// `golden-record <名前> <base64>` の診断の1行に出し、テストを失敗させる。記録するときは、変更前の版で
// このテストを走らせ、その行の base64 を復号して test/golden/status/<名前>.txt に保存する（手で写さない）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const GOLDEN_DIR = new URL('./golden/status/', import.meta.url);
const NOW = Date.UTC(2026, 5, 4, 9, 0, 0);
const minutes = n => n * 60000;
const hours = n => minutes(60 * n);
const days = n => hours(24 * n);
const iso = ms => new Date(ms).toISOString();

const routeOf = (account, accountName, state, availableAt = null) =>
  ({ account, accountName, state, availableAt: availableAt === null ? null : iso(availableAt) });

// 口座0件。Events も空で、セッション固定の節も無い。
const accountsZero = () => ({
  currentAccount: null,
  currentAccountName: null,
  switchThreshold: 1,
  routingAvailability: { fable: [], other: [] },
  accounts: [],
  events: [],
});

// 口座1件と Events。
const accountsOne = () => ({
  currentAccount: 'acct_1',
  currentAccountName: 'zz-golden-one',
  switchThreshold: 1,
  routingAvailability: {
    fable: [routeOf('acct_1', 'zz-golden-one', 'available')],
    other: [routeOf('acct_1', 'zz-golden-one', 'available')],
  },
  accounts: [{
    id: 'acct_1',
    name: 'zz-golden-one',
    status: 'active',
    quota: {
      unified5h: 0.31,
      unified7d: 0.54,
      unified5hReset: NOW + hours(2) + minutes(12),
      unified7dReset: NOW + days(3) + hours(16),
      weeklyScoped: [{ key: 'fable', label: 'Fable', utilization: 0.5, resetAt: NOW + days(2) }],
    },
    usage: { totalRequests: 3 },
  }],
  events: [
    { at: iso(NOW - minutes(2)), type: 'proxy-request', account: 'acct_1', method: 'POST', path: '/v1/messages',
      statusCode: 200, durationMs: 812, outcome: 'success', requestId: 'zz-request-1' },
    { at: iso(NOW - minutes(5)), type: 'upstream-error', account: 'acct_1',
      reason: { type: 'temporary_throttle', retryAt: iso(NOW - minutes(4)) } },
    { at: iso(NOW - minutes(9)), type: 'auto-switch', from: null, to: 'acct_1' },
  ],
});

// 口座3件（使える・枠切れ・ログイン切れ）、Events、セッション固定の節。
const accountsThree = () => ({
  currentAccount: 'acct_2',
  currentAccountName: 'zz-golden-two',
  switchThreshold: 1,
  routingAvailability: {
    fable: [
      routeOf('acct_2', 'zz-golden-two', 'available'),
      routeOf('acct_1', 'zz-golden-one', 'waiting', NOW + hours(1)),
      routeOf('acct_3', 'zz-golden-three', 'needs-login'),
    ],
    other: [
      routeOf('acct_2', 'zz-golden-two', 'available'),
      routeOf('acct_1', 'zz-golden-one', 'waiting', NOW + hours(1)),
      routeOf('acct_3', 'zz-golden-three', 'needs-login'),
    ],
  },
  accounts: [
    {
      id: 'acct_1',
      name: 'zz-golden-one',
      status: 'exhausted',
      quota: { unified5h: 1, unified7d: 0.76, unified5hReset: NOW + hours(1), unified7dReset: NOW + days(2) + hours(9) },
      usage: { totalRequests: 12 },
      unavailableReason: { type: 'quota_exhausted', window: '5h', utilization: 1, resetAt: iso(NOW + hours(1)) },
    },
    {
      id: 'acct_2',
      name: 'zz-golden-two',
      status: 'active',
      quota: { unified5h: 0.08, unified7d: 0.21, unified5hReset: NOW + hours(4) + minutes(40),
        unified7dReset: NOW + days(5) + hours(1) },
      usage: { totalRequests: 7 },
    },
    {
      id: 'acct_3',
      name: 'zz-golden-three',
      status: 'error',
      quota: {},
      usage: { totalRequests: 0 },
      unavailableReason: { type: 'oauth_refresh_failed', cause: 'http-401', at: iso(NOW - hours(3)) },
    },
  ],
  events: [
    { at: iso(NOW - minutes(1)), type: 'manual-switch', account: 'acct_2' },
    { at: iso(NOW - minutes(7)), type: 'fallback-switch', from: 'acct_1', to: 'acct_2', reason: 'shortest-quota-reset' },
    { at: iso(NOW - minutes(8)), type: 'quota-exhausted', account: 'acct_1',
      reason: { type: 'quota_exhausted', window: '5h', resetAt: iso(NOW + hours(1)) } },
    { at: iso(NOW - hours(3)), type: 'account-error', account: 'acct_3', reason: { type: 'oauth_refresh_failed' } },
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
});

const SAMPLES = Object.freeze({
  'accounts-0': accountsZero,
  'accounts-1-events': accountsOne,
  'accounts-3-events-affinity': accountsThree,
});

// 描く間だけ、時刻と端末の幅を固定する（終わったら元へ戻す）。
async function withFixedScreen(action) {
  const realNow = Date.now;
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Date.now = () => NOW;
  Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true, writable: true });
  try {
    return await action();
  } finally {
    Date.now = realNow;
    if (columns) Object.defineProperty(process.stdout, 'columns', columns);
    else delete process.stdout.columns;
  }
}

// 一時フォルダの env で `claude-rotator status` を走らせ、終了コードと標準出力・標準エラーを返す。
async function renderStatusScreen(status) {
  const root = await mkdtemp(join(tmpdir(), 'status-golden-'));
  const env = {
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    CLAUDE_ROTATOR_CONFIG: join(root, 'absent', 'config.json'),
    PATH: join(root, 'empty-bin'),
  };
  const out = [];
  const err = [];
  try {
    const code = await withFixedScreen(() => runCli(['status'], {
      env,
      readStatus: async () => status,
      write: text => { out.push(String(text)); },
      error: text => { err.push(String(text)); },
    }));
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readGolden(name) {
  try {
    return await readFile(new URL(`${name}.txt`, GOLDEN_DIR), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

for (const [name, build] of Object.entries(SAMPLES)) {
  test(`claude-rotator status prints the recorded sample byte for byte: ${name}`, async t => {
    const { code, stdout, stderr } = await renderStatusScreen(build());
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const expected = await readGolden(name);
    if (expected !== stdout) t.diagnostic(`golden-record ${name} ${Buffer.from(stdout, 'utf8').toString('base64')}`);
    assert.notEqual(expected, null, `no recorded sample: test/golden/status/${name}.txt`);
    assert.equal(stdout, expected);
  });
}
