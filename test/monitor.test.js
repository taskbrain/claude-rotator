import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager, familyQuotaExhaustedOnly } from '../src/account-manager.js';
import { progressBar, renderStatus, formatDuration } from '../src/monitor.js';
// 誤差(b)「GET から描画までの待ち時間」の支配項——/healthz の GET のタイムアウト——を
// 決めているのは src/monitor.js ではなくこの設定値なので、テストは 1500 を書き写さず
// ここから読む。ただしこの設定値は誤差(b) 全体の上界ではない（理由と根治策は
// 'draws the elapsed time only for a latch older than this process' の直前の注記）。
import { DISABLED_DEGRADE_MAPPING } from '../src/openai-bridge.js';

describe('monitor rendering', () => {
  it('renders unicode progress bars', () => {
    assert.equal(progressBar(0.76, 10), '███████░░░');
    assert.equal(progressBar(null, 10), '----------');
  });

  it('formats durations compactly', () => {
    assert.equal(formatDuration(42 * 60 * 1000), '42m');
    assert.equal(formatDuration((25 * 60 + 5) * 60 * 1000), '1d1h');
  });

  it('renders per-account 5h and 7d rows', () => {
    const output = renderStatus(sampleStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 100,
    });

    assert.match(output, /Claude Rotator\s+current: b@example\.com/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /reason: 5h quota exhausted; reset -> 06\/04 19:00 JST/);
    assert.match(output, /5h ██████████ 100%/);
    assert.match(output, /reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /7d ███████░░░  76%/);
    assert.match(output, /b@example\.com\s+active/);
    assert.match(output, /Events/);
    assert.match(output, /06\/04 18:02 JST fallback acct_1 -> acct_2 reason=shortest-quota-reset/);
  });

  it('renders the full Fable and Other recovery order with per-account route timing', () => {
    const output = renderStatus(modelAwareStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 160,
    });

    assert.match(output, /Routing availability/);
    assert.match(output, /Fable \(none now\)/);
    assert.match(output, /Other \(Sonnet \/ Opus \/ Haiku\)/);
    assert.match(output, /1\. a@example\.com\s+in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /1\. b@example\.com\s+now/);
    assert.match(output, /routes Fable: 1h \| Other: now/);
  });

  it('uses two account columns only when every line fits the terminal width', () => {
    const now = Date.parse('2026-06-04T09:00:00Z');
    const wide = renderStatus(modelAwareStatus(), { now, columns: 160 });
    const narrow = renderStatus(modelAwareStatus(), { now, columns: 80 });
    const accountPair = /a@example\.com\s+exhausted\s{3,}b@example\.com\s+exhausted/;

    assert.ok(wide.split('\n').some(line => accountPair.test(line)));
    assert.ok(narrow.split('\n').every(line => !accountPair.test(line)));
  });

  it('falls back to one account column when wide Unicode names exceed the terminal width', () => {
    const status = modelAwareStatus();
    const wideName = `${'日本語'.repeat(10)}@example.com`;
    status.accounts[0].name = wideName;
    for (const schedule of Object.values(status.routingAvailability)) {
      const entry = schedule.find(item => item.account === 'acct_1');
      entry.accountName = wideName;
    }

    const output = renderStatus(status, {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 150,
    });

    assert.ok(output.split('\n').every(line => !(
      line.includes(`${wideName} exhausted`)
      && line.includes('b@example.com              exhausted')
    )));
  });

  it('keeps rendering legacy status payloads without routing availability data', () => {
    const output = renderStatus(sampleStatus(), {
      now: Date.parse('2026-06-04T09:00:00Z'),
      columns: 100,
    });

    assert.match(output, /Fable \(no data\)/);
    assert.match(output, /Other \(Sonnet \/ Opus \/ Haiku\) \(no data\)/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('renders model-scoped weekly quota rows when present', () => {
    const output = renderStatus({
      currentAccount: 'acct_1',
      currentAccountName: 'a@example.com',
      accounts: [
        {
          id: 'acct_1',
          name: 'a@example.com',
          status: 'active',
          quota: {
            unified5h: 0.2,
            unified7d: 0.3,
            weeklyScoped: [
              {
                key: 'fable',
                label: 'Fable',
                utilization: 0.5,
                resetAt: Date.parse('2026-07-07T00:00:00Z'),
              },
            ],
          },
          usage: { totalRequests: 1 },
        },
      ],
      events: [],
    }, {
      now: Date.parse('2026-07-05T00:00:00Z'),
    });

    assert.match(output, /7d Fable █████░░░░░  50%  reset in 2d -> 07\/07 09:00 JST/);
  });
});

function sampleStatus() {
  return {
    currentAccount: 'acct_2',
    currentAccountName: 'b@example.com',
    switchThreshold: 1,
    accounts: [
      {
        id: 'acct_1',
        name: 'a@example.com',
        status: 'exhausted',
        quota: {
          unified5h: 1,
          unified7d: 0.76,
          unified5hReset: Date.parse('2026-06-04T10:00:00Z'),
          unified7dReset: Date.parse('2026-06-06T18:00:00Z'),
        },
        usage: { totalRequests: 12 },
        unavailableReason: {
          type: 'quota_exhausted',
          window: '5h',
          utilization: 1,
          resetAt: '2026-06-04T10:00:00.000Z',
        },
      },
      {
        id: 'acct_2',
        name: 'b@example.com',
        status: 'active',
        quota: {
          unified5h: 0.31,
          unified7d: 0.54,
          unified5hReset: Date.parse('2026-06-04T13:12:00Z'),
          unified7dReset: Date.parse('2026-06-08T01:00:00Z'),
        },
        usage: { totalRequests: 3 },
      },
    ],
    events: [
      { at: '2026-06-04T09:02:00Z', type: 'fallback-switch', from: 'acct_1', to: 'acct_2', reason: 'shortest-quota-reset' },
      { at: '2026-06-04T09:01:00Z', type: 'auto-switch', from: 'acct_1', to: 'acct_2' },
    ],
  };
}

function modelAwareStatus() {
  const status = sampleStatus();
  status.accounts[1].status = 'exhausted';
  status.accounts[1].quota.weeklyScoped = [{
    key: 'fable',
    label: 'Fable',
    utilization: 1,
    resetAt: Date.parse('2026-06-04T10:00:00Z'),
  }];
  status.accounts[1].unavailableReason = {
    type: 'quota_exhausted',
    window: '7d Fable',
    utilization: 1,
    resetAt: '2026-06-04T10:00:00.000Z',
  };
  status.routingAvailability = {
    fable: [
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
    ],
    other: [
      {
        account: 'acct_2',
        accountName: 'b@example.com',
        state: 'available',
        availableAt: null,
      },
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: 'waiting',
        availableAt: '2026-06-04T10:00:00.000Z',
      },
    ],
  };
  return status;
}

// Codex section of `claude-rotator status` (design doc section 9.6 / 13.3).
// claude-rotator only ever reads the codex-rotator health JSON: every key is
// optional, an unknown contract version is not an error, and a missing or broken
// payload must never break the Claude side of the screen.
describe('codex status section', () => {
  const now = Date.parse('2026-06-04T09:00:00Z');

  it('renders the codex pool header and one row per codex account', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: true, health: codexHealth() },
    });

    assert.match(output, /Codex Rotator\s+pool: exhausted \(0\/2 available\)\s+reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /pro-a\s+█████████░\s+97% 2nd\s+41% \(7d\)\s+exhausted\s+reset in 1h -> 06\/04 19:00 JST/);
    assert.match(output, /pro-b\s+███░░░░░░░\s+31%\s+available/);
    assert.match(output, /note: accounts are shown by label/);
    // The Claude side is rendered exactly as before.
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  // 旧文言 `CLI-driven usage is not included in these numbers` は事実と逆だった。
  // openai-model-bridge は2つのことを別々に報告している: 数字は ChatGPT アプリ・
  // Codex CLI・本ブリッジを含む口座全体の消費であること（accountUsageIncludesExternalClients）
  // と、そのうち CLI 単独の取り分は切り出せないこと（cliConsumptionVisible=false）。
  // 各フラグがそれぞれ1行を出す。
  it('states what the percentages cover and never claims the CLI is excluded', () => {
    const both = codexHealth();
    both.pool.observation.accountUsageIncludesExternalClients = true;
    const visible = codexHealth();
    visible.pool.observation.cliConsumptionVisible = true;

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health: both } });

    assert.match(output, /note: percentages cover the whole account - ChatGPT app, Codex CLI, and this bridge/);
    assert.match(output, /note: the CLI's own share cannot be separated out/);
    assert.doesNotMatch(output, /CLI-driven usage is not included in these numbers/);
    assert.doesNotMatch(
      renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health: visible } }),
      /cannot be separated out/,
    );
    assert.doesNotMatch(
      renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health: codexHealth() } }),
      /percentages cover the whole account/,
    );
  });

  it('renders a single unreachable line when the health fetch failed', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: false, reason: 'timeout 1500ms' },
    });

    assert.match(output, /Codex Rotator\s+codex: unreachable \(timeout 1500ms\)/);
    assert.doesNotMatch(output, /pool:/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('OSS independence: no codex data means the status output is byte-identical', () => {
    const baseline = renderStatus(sampleStatus(), { now, columns: 100 });

    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: null }), baseline);
    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: undefined }), baseline);
    assert.doesNotMatch(baseline, /Codex Rotator/);
  });

  it('draws the optional keys only when they are present', () => {
    const output = renderStatus(sampleStatus(), {
      now,
      columns: 120,
      codex: { ok: true, health: { contract: 1, pool: { state: 'unknown', accounts: [{ label: 'pro-a' }] } } },
    });

    assert.match(output, /Codex Rotator\s+pool: unknown/);
    assert.match(output, /pro-a\s+----------\s+--%/);
    assert.doesNotMatch(output, /undefined|NaN/);
  });

  it('degrades to one line when a contract-mandated key is missing', () => {
    const payloads = [
      {},
      { contract: 1 },
      { pool: { state: 'available', accounts: [] } },
      { contract: 1, pool: null },
      { contract: 1, pool: { accounts: [] } },
      { contract: 1, pool: { state: 'available' } },
      { contract: 1, pool: { state: 'available', accounts: 'not-an-array' } },
      { contract: 1, pool: { state: 42, accounts: [] } },
    ];

    for (const health of payloads) {
      const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });
      assert.match(output, /Codex Rotator\s+codex: unreachable \(invalid payload\)/);
      assert.doesNotMatch(output, /pool:/);
      assert.match(output, /a@example\.com\s+exhausted/);
      assert.match(output, /Events/);
    }
  });

  it('never crashes on a payload built to break string conversion', () => {
    const health = codexHealth();
    health.pool.accounts[0].label = { toString: null };
    health.pool.accounts[1].state = { toString: null };

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /Codex Rotator/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
    assert.doesNotMatch(output, /\[object Object\]/);
  });

  it('replaces a label that does not match the contract pattern', () => {
    const health = codexHealth();
    health.pool.accounts[0].label = 'codex-account@example.invalid';
    health.pool.accounts[1].label = `pro-b${String.fromCharCode(0x200b)}`;

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /<invalid>\s+█████████░/);
    assert.match(output, /<invalid>\s+███░░░░░░░/);
    assert.doesNotMatch(output, /@example\.invalid/);
    assert.doesNotMatch(output, /pro-b/);
  });

  it('strips control and zero-width characters from codex states', () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const bell = String.fromCharCode(0x07);
    const health = codexHealth();
    health.pool.accounts[0].state = `exhaus${bell}ted`;
    health.pool.state = `exhaus${zeroWidth}ted`;

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /pro-a\s+█████████░/);
    assert.match(output, /exhausted/);
    assert.match(output, /pool: exhausted/);
    assert.ok(!output.includes(zeroWidth), 'zero-width characters must not reach the terminal');
    assert.ok(!output.includes(bell), 'control characters must not reach the terminal');
  });

  it('degrades to one line when reading the payload throws', () => {
    const health = codexHealth();
    Object.defineProperty(health.pool, 'observation', {
      get() { throw new Error('hostile payload'); },
    });

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /Codex Rotator\s+codex: unreachable \(invalid payload\)/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /Events/);
  });

  it('never renders an email-like identifier even when the health JSON carries one', () => {
    const health = codexHealth();
    health.pool.accounts[0].display = 'codex-account@example.invalid';
    health.pool.accounts[0].email = 'codex-account@example.invalid';

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /pro-a\s+█████████░/);
    assert.doesNotMatch(output, /example\.invalid/);
  });
});

// Dummy codex-rotator health payload. Labels are placeholders on purpose: by
// contract the health JSON carries no email address, and this fixture must not
// introduce one.
function codexHealth() {
  return {
    status: 'ok',
    contract: 1,
    pool: {
      state: 'exhausted',
      accountsTotal: 2,
      accountsAvailable: 0,
      resetAt: '2026-06-04T10:00:00Z',
      observation: { mode: 'passive', source: 'response-header', cliConsumptionVisible: false },
      accounts: [
        {
          label: 'pro-a',
          state: 'exhausted',
          primaryUsedPercent: 97,
          secondaryUsedPercent: 41,
          windowDurationMins: 10080,
          resetAt: '2026-06-04T10:00:00Z',
        },
        {
          label: 'pro-b',
          state: 'available',
          primaryUsedPercent: 31,
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// R7-3: 認証失効の表示（母艦裁定 D-72 の 4）
//
// 坂根氏の判断③「claude-rotator status には認証が切れているというメッセージだけ出す」。
// 内部の型名（oauth_refresh_failed 等）を画面へ素出しせず、何をすればよいかを出す。
// 認証失効が1件も無い構成では、出力は1文字も変わらない。
// ---------------------------------------------------------------------------

describe('認証失効の表示 (D-72)', () => {
  const now = Date.parse('2026-06-04T09:00:00Z');

  it('tells the operator how to recover instead of printing the internal reason type', () => {
    for (const type of ['oauth_refresh_failed', 'authentication_error']) {
      const output = renderStatus(authExpiredStatus(type), { now, columns: 120 });

      assert.match(
        output,
        /reason: login expired - run: claude-rotator login --id acct_1/,
        '何をすればよいかを1行で出す',
      );
      assert.doesNotMatch(output, new RegExp(type), '内部の型名を画面へ出さない');
      assert.doesNotMatch(output, /OAuth token/, '内部のメッセージも出さない');
    }
  });

  it('shows "needs login" in Routing availability instead of "unknown"', () => {
    const output = renderStatus(authExpiredStatus('oauth_refresh_failed'), { now, columns: 160 });

    assert.match(output, /2\. a@example\.com\s+needs login/, '回復順の一覧でも状態が読める');
    assert.match(output, /routes Fable: needs login \| Other: needs login/, '口座カードの routes 行も同じ');
    assert.doesNotMatch(output, /needs login.*\bunknown\b/, '「不明」で塗り潰さない');
  });

  it('keeps rendering a non-auth account error exactly as before', () => {
    const output = renderStatus(authExpiredStatus('account_error'), { now, columns: 160 });

    assert.match(output, /reason: account_error: OAuth token refresh failed/, '他の error は現行のまま');
    assert.match(output, /2\. a@example\.com\s+unknown/, 'routing の状態も unknown のまま');
    assert.doesNotMatch(output, /needs login|login expired/);
  });

  it('changes nothing at all for a status that carries no auth failure', () => {
    for (const status of [sampleStatus(), modelAwareStatus()]) {
      const output = renderStatus(status, { now, columns: 160 });
      assert.doesNotMatch(output, /needs login/);
      assert.doesNotMatch(output, /login expired/);
    }
  });

  it('renders a signed-out codex pool from the health JSON (D-72 の 4(iii))', () => {
    const health = codexHealth();
    health.pool.state = 'needs-login';
    health.pool.accountsAvailable = 0;
    health.pool.accounts[0].state = 'needs-login';
    health.pool.accounts[1].state = 'needs-login';

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, health } });

    assert.match(output, /Codex Rotator\s+pool: needs-login \(0\/2 available\)/);
    assert.match(output, /pro-a\s+█████████░\s+97% 2nd\s+41% \(7d\)\s+needs-login/);
    assert.match(output, /pro-b\s+███░░░░░░░\s+31%\s+needs-login/);
  });
});

// ---------------------------------------------------------------------------
// (c) 認証失敗の原因コードと検出時刻の表示（母艦裁定 C-20260915-3F-03）
//
// 「認証が切れている」だけでは、いつ・何が原因で落ちたのかが読めない。
// 再ログインの案内（D-72）はそのまま残したうえで、原因コードと「検出した時刻」を
// 添える。表示は必ず detected と書く——資格情報が実際に満了した時刻は当方では
// 分からず、expired at と書けば別の時刻として読まれてしまうため。
// ---------------------------------------------------------------------------
describe('認証失敗の原因コードと検出時刻の表示 (c)', () => {
  const now = Date.parse('2026-06-04T09:00:00Z');

  it('adds the cause and the detected time without dropping the login guidance', () => {
    const status = authExpiredStatus('oauth_refresh_failed');
    Object.assign(status.accounts[0].unavailableReason, {
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: '2026-06-04T08:00:00.000Z',
    });

    const output = renderStatus(status, { now, columns: 200 });

    assert.match(
      output,
      /reason: login expired \(cause=NATIVE_REFRESH_REAUTH_REQUIRED; detected 06\/04 17:00 JST\) - run: claude-rotator login --id acct_1/,
      '原因と検出時刻を足しても、何をすればよいかの案内は消えない',
    );
    assert.doesNotMatch(output, /expired at|expires at/, '検出時刻を「満了時刻」と読める書き方にしない');
  });

  it('prints whichever of the two it has, and nothing when it has neither', () => {
    const onlyCause = authExpiredStatus('oauth_refresh_failed');
    onlyCause.accounts[0].unavailableReason.cause = 'http-401';
    assert.match(
      renderStatus(onlyCause, { now, columns: 200 }),
      /reason: login expired \(cause=http-401\) - run: claude-rotator login --id acct_1/,
    );

    const onlyDetectedAt = authExpiredStatus('oauth_refresh_failed');
    onlyDetectedAt.accounts[0].unavailableReason.at = '2026-06-04T08:00:00.000Z';
    assert.match(
      renderStatus(onlyDetectedAt, { now, columns: 200 }),
      /reason: login expired \(detected 06\/04 17:00 JST\) - run: claude-rotator login --id acct_1/,
    );

    assert.match(
      renderStatus(authExpiredStatus('oauth_refresh_failed'), { now, columns: 200 }),
      /reason: login expired - run: claude-rotator login --id acct_1/,
      '旧い state から復元した理由には何も足さない（1文字も変わらない）',
    );
  });

  it('ignores an unparsable detected time instead of printing a broken date', () => {
    const status = authExpiredStatus('oauth_refresh_failed');
    status.accounts[0].unavailableReason.at = 'not a timestamp';

    assert.match(
      renderStatus(status, { now, columns: 200 }),
      /reason: login expired - run: claude-rotator login --id acct_1/,
    );
  });

  it('survives the whole save/reload path from markError to the screen', () => {
    const detectedAt = '2026-06-04T08:00:00.000Z';
    const accounts = [
      { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
      { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
    ];
    const before = new AccountManager({ accounts, now: () => Date.parse(detectedAt) });
    before.markError('acct_1', 'oauth_refresh_failed', 'OAuth token refresh failed', {
      cause: 'NATIVE_REFRESH_REAUTH_REQUIRED',
      at: detectedAt,
    });

    const afterRestart = new AccountManager({ accounts, now: () => now });
    afterRestart.restoreState(before.exportState());

    const output = renderStatus(afterRestart.getStatus(), { now, columns: 200 });

    assert.match(
      output,
      /reason: login expired \(cause=NATIVE_REFRESH_REAUTH_REQUIRED; detected 06\/04 17:00 JST\) - run: claude-rotator login --id acct_1/,
      '再起動を挟んでも、原因と「1時間前に検出した」ことが画面から読める',
    );
    assert.match(output, /needs login/, 'D-72 の routing 表示も従来どおり');
  });
});

// 認証が失効した口座を1つ含む status。Claude 側の error reason は
// src/account-manager.js の markError() が入れる形（type ＋ message）に揃える。
function authExpiredStatus(type) {
  const status = sampleStatus();
  status.accounts[0].status = 'error';
  status.accounts[0].unavailableReason = { type, message: 'OAuth token refresh failed' };
  status.routingAvailability = {
    fable: [
      { account: 'acct_2', accountName: 'b@example.com', state: 'available', availableAt: null },
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: type === 'account_error' ? 'unknown' : 'needs-login',
        availableAt: null,
      },
    ],
    other: [
      { account: 'acct_2', accountName: 'b@example.com', state: 'available', availableAt: null },
      {
        account: 'acct_1',
        accountName: 'a@example.com',
        state: type === 'account_error' ? 'unknown' : 'needs-login',
        availableAt: null,
      },
    ],
  };
  return status;
}

describe('サブキャップ 429 で稼働口座が動かないときの表示 (P-4 / 設計書 §7.3)', () => {
  const NOW = Date.parse('2026-06-04T09:00:00.000Z');
  const FIVE_HOUR_RESET = '2026-06-04T12:00:00.000Z';
  const SEVEN_DAY_RESET = '2026-06-08T09:00:00.000Z';
  const FABLE_RESET = '2026-06-06T09:00:00.000Z';

  // R-S2b（設計書 §5.1）は、反応的 429 の switchToCandidate を
  // familyQuotaExhaustedOnly で条件付きにする。ここではその条件式をそのまま置き、
  // 系統枠だけが枯れた場合と共通枠が枯れた場合で画面がどう変わるかを固定する（P-4 の差分）。
  function statusAfterReactive429({ commonExhausted }) {
    const manager = new AccountManager({
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      switchThreshold: 1,
      now: () => NOW,
    });
    manager.applyUsage('acct_1', {
      five_hour: { utilization: commonExhausted ? 1 : 0.2, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.3, resets_at: SEVEN_DAY_RESET },
      scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: FABLE_RESET }],
    });
    manager.applyUsage('acct_2', {
      five_hour: { utilization: 0.1, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 0.1, resets_at: SEVEN_DAY_RESET },
    });

    const source = manager.find('acct_1');
    if (!familyQuotaExhaustedOnly(source, manager.switchThreshold, 'fable', manager.now())) {
      manager.switchToCandidate(
        manager.bestAvailableSwitchCandidate({ excludeCurrent: false, modelFamily: 'fable' }),
        'quota-threshold',
        '429',
      );
    }
    return manager.getStatus();
  }

  it('keeps the sub-cap-exhausted account as current and shows no account as active', () => {
    const subCap = statusAfterReactive429({ commonExhausted: false });
    const common = statusAfterReactive429({ commonExhausted: true });

    assert.deepEqual({
      currentAccount: subCap.currentAccount,
      accounts: subCap.accounts.map(account => [account.id, account.status]),
      autoSwitchEvents: subCap.events.filter(event => event.type === 'auto-switch').length,
    }, {
      currentAccount: 'acct_1',
      accounts: [['acct_1', 'exhausted'], ['acct_2', 'ready']],
      autoSwitchEvents: 0,
    });
    // 共通枠が枯れた 429 は従来どおり切り替わり、active の付け替えも従来どおり起きる。
    assert.deepEqual({
      currentAccount: common.currentAccount,
      accounts: common.accounts.map(account => [account.id, account.status]),
      autoSwitchEvents: common.events.filter(event => event.type === 'auto-switch').length,
    }, {
      currentAccount: 'acct_2',
      accounts: [['acct_1', 'exhausted'], ['acct_2', 'active']],
      autoSwitchEvents: 1,
    });

    const output = renderStatus(subCap, { now: NOW, columns: 100 });
    assert.match(output, /current: a@example\.com/);
    assert.match(output, /a@example\.com\s+exhausted/);
    assert.match(output, /b@example\.com\s+ready/);
    assert.ok(!/\bactive\b/.test(output), 'no account row may be labelled active');
    assert.ok(!output.includes('switched acct_1 -> acct_2'), 'no auto-switch line is rendered');
    // 消えるのは active の表示だけ。枯渇理由・回復時刻・経路は現行のまま（I-1 / I-2）。
    assert.match(output, /reason: 7d Fable quota exhausted; reset -> 06\/06 18:00 JST/);
    assert.match(output, /routes Fable: 2d \| Other: now/);
    assert.match(renderStatus(common, { now: NOW, columns: 100 }), /b@example\.com\s+active/);
  });
});

// ---------------------------------------------------------------------------
// セッション固定の節（R-S12 / 設計書 §7.3）
//
// 描くのは status JSON が `sessionAffinity` を持っているときだけである。`mode:"off"` では
// `/internal/status` がキー自体を出さないので、この節は1行も描かれず `claude-rotator status`
// の出力は現行とバイト同一になる（R7）。Codex 節（`renderCodexSection`）と同型で、
// `renderStatus` からの呼び出しは1箇所だけである。
// ---------------------------------------------------------------------------

describe('session affinity section (R-S12 / 設計書 §7.3)', () => {
  const NOW = Date.parse('2026-09-16T09:00:00.000Z');

  function baseStatus() {
    return {
      currentAccount: 'acct_1',
      currentAccountName: 'a@example.com',
      switchThreshold: 1,
      routingAvailability: { fable: [], other: [] },
      accounts: [],
      events: [],
    };
  }

  const SECTION = {
    mode: 'on',
    sessions: 2,
    capacity: 10000,
    sessionsByAccount: { acct_1: 2, acct_2: 1 },
    switchesByReason: { common_exhausted: 1 },
    evictionsByReason: { ttl: 3 },
    requests: { proxied: 3, keyed: 2 },
    sidRate: 0.6667,
  };

  function render(status) {
    return renderStatus(status, { now: NOW, columns: 100 });
  }

  it('draws nothing at all when the status carries no sessionAffinity section', () => {
    const output = render(baseStatus());

    assert.equal(output.includes('Session Affinity'), false);
    assert.equal(output.includes('sid:'), false);
  });

  it('appends the section without changing one byte of the rest of the screen', () => {
    const before = render(baseStatus());

    const after = render({ ...baseStatus(), sessionAffinity: SECTION });

    const lines = after.split('\n');
    const start = lines.findIndex(line => line.startsWith('Session Affinity'));
    assert.ok(start >= 0, '節が描かれていない');
    const end = lines.indexOf('', start);
    assert.ok(end > start, '節は空行で終わる（Codex 節と同型）');
    assert.equal([...lines.slice(0, start), ...lines.slice(end + 1)].join('\n'), before);
  });

  it('renders the mode, the session counts, the sid coverage and the reason breakdowns', () => {
    const output = render({ ...baseStatus(), sessionAffinity: SECTION });

    assert.match(output, /Session Affinity\s+mode: on {2}sessions: 2\/10000 {2}sid: 67% \(2\/3\)/);
    assert.match(output, /\n {2}by account: acct_1 2, acct_2 1\n/);
    assert.match(output, /\n {2}switches: common_exhausted 1\n/);
    assert.match(output, /\n {2}evictions: ttl 3\n/);
  });

  it('omits the empty breakdowns and says so when no request has been forwarded yet', () => {
    const output = render({
      ...baseStatus(),
      sessionAffinity: {
        mode: 'observe',
        sessions: 0,
        capacity: 500,
        sessionsByAccount: {},
        switchesByReason: {},
        evictionsByReason: {},
        requests: { proxied: 0, keyed: 0 },
        sidRate: null,
      },
    });

    assert.match(output, /Session Affinity\s+mode: observe {2}sessions: 0\/500 {2}sid: no requests/);
    assert.equal(output.includes('by account:'), false);
    assert.equal(output.includes('switches:'), false);
    assert.equal(output.includes('evictions:'), false);
  });

  it('keeps drawing the screen when the section is malformed', () => {
    const output = render({
      ...baseStatus(),
      sessionAffinity: { mode: 42, sessions: 'many', sessionsByAccount: 'nope' },
    });

    assert.match(output, /Session Affinity\s+mode: unknown {2}sessions: 0 {2}sid: no requests/);
    assert.match(output, /Events/);
  });
});

// ---------------------------------------------------------------------------
// Codex 節の詳細表示（口座ごとのリセット時刻・温存の可視化）
//
// この画面が防ぎたい誤読はただ1つ:「リセット時刻になれば送れるようになる」。
// codex-account-pool.js の停止はラッチで、解けるのは条件を満たす観測だけであり、
// 時間の経過でもリセット時刻でも解けない。だから状態語から時間の含意を消し
// （cooldown を使わない）、リセット時刻の直下の行を否定文で始める。
//
// 状態語は stopUsedPercent の値だけで決める。どの窓がラッチしたかは /healthz に
// 出ていないので「98% は 75% の線を超えたから」という不等式は偽になり得る。
// ---------------------------------------------------------------------------
describe('codex status section: detailed layout', () => {
  // 2026-09-16 15:33 JST。実データ（primary 98%/stop 75%、pro2 100%/stop 100%）と同時刻。
  const now = Date.parse('2026-09-16T06:33:00Z');

  it('draws one screen per account: row, what clears it, and when it was read', () => {
    const lines = codexSectionLines(renderCodexStatus(codexDetailedHealth(), now));

    assert.deepEqual(lines, [
      'Codex Rotator                          sendable 0/2  (held 1, capped 1)',
      '  reading  usage GET, startup check passed   raw pool state: exhausted',
      '  primary  held      7d █████████░  98%  stop 75%   reset in 5d5h -> 09/21 20:59 JST',
      '    clears   not at that reset - needs 2 clean usage reads at 70% or less',
      '    read     09/16 15:32 JST usage GET, ordinary use allowed, stops when unread',
      '  pro2     capped    7d ██████████ 100%  stop 100%  reset in 3d1h -> 09/19 17:10 JST',
      '    clears   not at that reset - needs 2 clean usage reads at 99% or less',
      '    read     09/16 15:32 JST usage GET, ordinary use allowed, sends when unread',
      '  note: held = stopped at our own line, capped = the plan limit itself',
      '  note: held / capped read as "cooldown" in /healthz',
      '  note: second window on pro2 is stale - last read 0% on 09/16 06:23 JST',
      '  note: percentages cover the whole account - ChatGPT app, Codex CLI, and this bridge',
      "  note: the CLI's own share cannot be separated out",
      '  note: accounts are shown by label',
    ]);
  });

  it('never promises that a reset instant lifts the stop', () => {
    const output = renderCodexStatus(codexDetailedHealth(), now);
    const lines = codexSectionLines(output);

    // ヘッダはプールの resetAt を描かない（全口座・全窓の最小値で、どの口座の
    // 値かを名乗れないため。今日の画面で最大の誤読源）。
    assert.doesNotMatch(lines[0], /reset/);
    // リセット時刻を持つ行の直下は必ず否定文で始まる。
    for (const [index, line] of lines.entries()) {
      if (!/reset in/.test(line)) continue;
      assert.match(lines[index + 1], /^ {4}clears {3}not at that reset - /, line);
    }
    // 復帰を時間で語る言い回しを1つも使わない。`cooldown` が残ってよいのは
    // 「/healthz ではこう出る」と対応を示す note の中だけ。
    assert.deepEqual(
      lines.filter(line => line.includes('cooldown')),
      ['  note: held / capped read as "cooldown" in /healthz'],
    );
    assert.doesNotMatch(output, /available in|back in|usable at|retry at/);
  });

  // ① 同じ 'usage-capped' でも、自分の線で止めた held と上流の枠が尽きた capped は別物。
  it('tells our own stop line (held) from the plan limit itself (capped)', () => {
    const health = codexDetailedHealth();
    const output = renderCodexStatus(health, now);

    assert.match(output, /^ {2}primary {2}held {6}7d .* {2}98% {2}stop 75%/m);
    assert.match(output, /^ {2}pro2 {5}capped {4}7d .*100% {2}stop 100%/m);
    assert.match(output, /sendable 0\/2 {2}\(held 1, capped 1\)/);
    assert.match(output, /note: held = stopped at our own line, capped = the plan limit itself/);
  });

  // ① 境界: stop 75% の口座が 100% に達しても held のまま（語は stop の値だけで決める）。
  it('keeps calling it held when a 75% account reaches 100%', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].primaryUsedPercent = 100;

    const output = renderCodexStatus(health, now);

    assert.match(output, /^ {2}primary {2}held {6}7d .*100% {2}stop 75%/m, '実測% と stop% を両方出す');
    assert.doesNotMatch(output, /primary {2}capped/);
  });

  // ② usagePolicy を持たない口座は上流の枠が尽きたわけではない。capped と書けば嘘になる。
  it('calls an account with no usage policy stopped, never capped', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].stopUsedPercent = null;
    health.pool.accounts[0].resumeUsedPercent = null;

    const output = renderCodexStatus(health, now);

    assert.match(output, /^ {2}primary {2}stopped {3}7d .* {2}98% {2}stop {2}n\/a/m);
    assert.doesNotMatch(output, /primary {2}capped/);
    assert.match(output, / {4}clears {3}not at that reset - needs a usage read below the rotator's own limit/);
  });

  // ③ 過ぎたリセット時刻は1つも描かない（`reset in now` は「もうすぐ」と読まれる）。
  it('draws no reset instant that has already passed', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[1];
    account.primaryWindowResetAt = '2026-09-15T21:23:24.926Z';
    account.secondaryWindowResetAt = '2026-09-15T21:23:24.926Z';
    account.resetAt = '2026-09-15T21:23:24.926Z';

    const output = renderCodexStatus(health, now);
    const row = codexSectionLines(output).find(line => line.startsWith('  pro2'));

    assert.doesNotMatch(row, /reset in/);
    assert.doesNotMatch(output, /reset in now/);
    // 過去の時刻が `reset in` の形で画面へ出ることは一度も無い。
    assert.ok(codexSectionLines(output).every(line => !/reset in .*09\/1[56] /.test(line)));
    // ④ 行にリセット句が無いので clears の文面が切り替わる。
    assert.match(output, / {4}clears {3}not when the window resets - needs 2 clean usage reads at 99% or less/);
  });

  // ④ 鮮度が切れた読み取りは、最後に取れた値を残しつつバーを満杯にしない。
  it('marks a stale reading with * and empties the bar instead of filling it', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.primaryUsedPercent = null;
    account.primaryObservationFresh = false;
    account.lastKnownPrimaryObservedAt = '2026-09-16T06:20:00.000Z';

    const output = renderCodexStatus(health, now);

    assert.match(output, /^ {2}primary {2}held {6}7d ---------- {2}98%\* stop 75%/m);
    assert.doesNotMatch(output, /primary.*█/);
    assert.match(output, / {4}read {5}09\/16 15:20 JST usage GET - stale, next try 09\/16 15:34 JST/);
  });

  // ⑤ リセットを跨いだ直後は句が消える。「that reset」が宙に浮かないようにする。
  it('switches the denial when the row carries no reset instant at all', () => {
    const health = codexDetailedHealth();
    for (const account of health.pool.accounts) {
      account.primaryWindowResetAt = null;
      account.resetAt = null;
    }

    const output = renderCodexStatus(health, now);

    assert.doesNotMatch(output, /reset in/);
    assert.match(output, / {4}clears {3}not when the window resets - needs 2 clean usage reads at 70% or less/);
    assert.doesNotMatch(output, /not at that reset/);
  });

  // ⑥ 429 を観測した口座のリセット時刻は account.resetAt。窓の値へ付け替えると黙って消える。
  it('prefers the 429 reset instant over the window one for an exhausted account', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[1];
    account.state = 'exhausted';
    account.selectionBlockReason = 'exhausted';
    account.resetAt = '2026-09-19T08:10:37.000Z';
    account.primaryWindowResetAt = '2026-09-21T11:59:55.000Z';

    const output = renderCodexStatus(health, now);
    const row = codexSectionLines(output).find(line => line.startsWith('  pro2'));

    assert.match(row, /^ {2}pro2 {5}exhausted 7d .*reset in 3d1h -> 09\/19 17:10 JST$/);
    assert.doesNotMatch(row, /09\/21/);
    assert.match(output, / {4}clears {3}after that reset, once the rotator rechecks this account \(429 seen\)/);
  });

  // ⑦ 選択の材料を1つも報告しないブリッジでは、推測せずに今日の画面のまま出す。
  it('falls back to the previous screen when no account reports why it was skipped', () => {
    const health = codexDetailedHealth();
    for (const account of health.pool.accounts) {
      delete account.selectionEligible;
      delete account.selectionBlockReason;
      delete account.stopUsedPercent;
    }

    const output = renderCodexStatus(health, now);

    assert.match(output, /Codex Rotator {26}pool: exhausted \(0\/2 available\) {2}reset in 3d1h -> 09\/19 17:10 JST/);
    assert.match(output, /^ {2}primary {14}█████████░ {2}98% {2}cooldown$/m);
    assert.doesNotMatch(output, /sendable|clears|held|capped/);
    assert.doesNotMatch(output, /undefined|NaN/);
  });

  // ⑧ 画面は報告へ貼られる。桁の回帰をテストで止める。
  it('keeps every codex line inside 100 columns', () => {
    for (const health of [codexDetailedHealth(), codexEveryStateHealth()]) {
      for (const line of codexSectionLines(renderCodexStatus(health, now))) {
        assert.ok([...line].length <= 100, `${[...line].length} columns: ${line}`);
      }
    }
  });

  // ⑨ ブリッジ側の任意フィールドは、無くても画面が完成しなければならない。
  it('renders a complete screen when the bridge reports neither cappedSince nor resumeStreak', () => {
    const health = codexDetailedHealth();
    for (const account of health.pool.accounts) {
      assert.equal(Object.hasOwn(account, 'cappedSince'), false);
      assert.equal(Object.hasOwn(account, 'resumeStreak'), false);
    }

    const output = renderCodexStatus(health, now);

    assert.match(output, / {4}clears {3}not at that reset - needs 2 clean usage reads at 70% or less/);
    assert.doesNotMatch(output, /since|clean reads done/);
    assert.doesNotMatch(output, /undefined|NaN|null/);
  });

  // 次回ブリッジ再起動以降の本番形。坂根氏判断 2026-09-17 でブリッジは resumeStreak を
  // 公開し cappedSince を公開しないと確定したので、実機に出るのはこの「resumeStreak だけ」
  // の形である。上の⑨（どちらも無い）と下（どちらもある）の間が抜けていた。
  // 固定するのは4点: `since` 行が1本も出ないこと、`clears` 行が進捗つきへ正しく分岐
  // すること（0 / 1 / 2 の3通り）、画面が最後まで完成すること、全行が100桁以内であること。
  // ただしこのテストは前半と後半で主張の強さが違う。前半の deepEqual だけが「本番でこう出る」
  // の主張で、後半のループは表示側が 0〜2 を受けきることの防御的な固定である（resumeStreak=2
  // は本番の停止中の口座には現れない。理由は後半の注記）。
  it('renders the shape the restarted bridge will publish: resumeStreak without cappedSince', () => {
    const health = codexDetailedHealth();
    for (const account of health.pool.accounts) {
      assert.equal(Object.hasOwn(account, 'cappedSince'), false, 'ブリッジは cappedSince を公開しない');
      account.resumeStreak = 1;
    }

    // ここからが本番形の主張: 次回再起動後のブリッジが実際に publish する形そのもの。
    assert.deepEqual(codexSectionLines(renderCodexStatus(health, now)), [
      'Codex Rotator                          sendable 0/2  (held 1, capped 1)',
      '  reading  usage GET, startup check passed   raw pool state: exhausted',
      '  primary  held      7d █████████░  98%  stop 75%   reset in 5d5h -> 09/21 20:59 JST',
      '    clears   1 of 2 clean reads done - needs 70% or less, not at that reset',
      '    read     09/16 15:32 JST usage GET, ordinary use allowed, stops when unread',
      '  pro2     capped    7d ██████████ 100%  stop 100%  reset in 3d1h -> 09/19 17:10 JST',
      '    clears   1 of 2 clean reads done - needs 99% or less, not at that reset',
      '    read     09/16 15:32 JST usage GET, ordinary use allowed, sends when unread',
      '  note: held = stopped at our own line, capped = the plan limit itself',
      '  note: held / capped read as "cooldown" in /healthz',
      '  note: second window on pro2 is stale - last read 0% on 09/16 06:23 JST',
      '  note: percentages cover the whole account - ChatGPT app, Codex CLI, and this bridge',
      "  note: the CLI's own share cannot be separated out",
      '  note: accounts are shown by label',
    ]);

    // ここから下は本番形の主張ではなく、表示側の契約（resumeStreak として 0〜2 を受ける）の
    // 防御的な固定である。0 は「1回も進んでいない」ので静的な文へ縮退する。2 は解除の1歩手前
    // だが、**ブリッジ側では解除と同時に落ちるため、本番の停止中の口座には現れない**——
    // openai-model-bridge 側の codex-account-pool.js は上限（RESUME_CONFIRMATIONS=2）に達した
    // 呼び出しでその場で release し、codex-manager.js は止まっていない口座には 0 を publish
    // するので、停止中に外から見える値は 0 か 1 だけになる（ブリッジ側のコメント自身がそう
    // 明記している）。それでも 2 を受けきること、2 が来ても「次のリセットでは解けない」を
    // 言い続けること（時間では解けないラッチだから）をここで固定する。
    const expected = [
      [0, 'not at that reset - needs 2 clean usage reads at 70% or less'],
      [1, '1 of 2 clean reads done - needs 70% or less, not at that reset'],
      [2, '2 of 2 clean reads done - needs 70% or less, not at that reset'],
    ];
    for (const [resumeStreak, clears] of expected) {
      health.pool.accounts[0].resumeStreak = resumeStreak;
      const output = renderCodexStatus(health, now);
      const lines = codexSectionLines(output);
      const label = `resumeStreak=${resumeStreak}`;

      assert.ok(lines.includes(`    clears   ${clears}`), `${label}: ${lines[3]}`);
      // cappedSince が無い以上、どの状態語でも経過時間の行は描かれない。
      assert.equal(lines.some(line => / {4}(held|capped|stopped) {2,}since /.test(line)), false, label);
      // 画面は最後まで完成する（節の始まりと終わりの note が両方出ている）。
      assert.equal(lines[0], 'Codex Rotator                          sendable 0/2  (held 1, capped 1)', label);
      assert.equal(lines.at(-1), '  note: accounts are shown by label', label);
      assert.doesNotMatch(output, /invalid payload|undefined|NaN|null|Invalid Date/, label);
      for (const line of lines) assert.ok([...line].length <= 100, `${label}: ${[...line].length} columns: ${line}`);
    }
  });

  // 現行のブリッジは cappedSince を公開しない（ラッチ時刻がプロセス内にしか無く、
  // 再起動のたびに刻み直されるため、坂根氏判断 2026-09-17 で公開を取り下げた）。
  // したがって `held ... since` 行は本番では一度も描かれない。この固定は、
  // 09/21 の効果測定後にブリッジがラッチを永続化して再公開したときのためのもので、
  // その日に rotator を無改修で有効にするのが狙いである。
  it('uses cappedSince and resumeStreak when the bridge does report them', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.cappedSince = '2026-09-15T13:20:00.000Z';
    account.resumeStreak = 1;

    const lines = codexSectionLines(renderCodexStatus(health, now));

    assert.ok(lines.includes('    clears   1 of 2 clean reads done - needs 70% or less, not at that reset'));
    assert.ok(lines.includes('    held     since 09/15 22:20 JST (17h13m)'));
    // 0 は「1回も進んでいない」なので静的な文へ縮退する。
    account.resumeStreak = 0;
    assert.match(renderCodexStatus(health, now), / {4}clears {3}not at that reset - needs 2 clean usage reads at 70% or less/);
  });

  // cappedSince は「少なくともこの時刻から」の下限であって経過時間の実測ではない。
  // ブリッジを再起動すると pool は空から始まり、起動後最初の usage GET が停止線以上を
  // 読んだ瞬間に `entry.cappedSince ??= nowMs` が走るので、**同じ口座が同じ停止状態の
  // まま、ラッチ開始時刻だけプロセス起動後へ巻き直される**。09/15 から温存されている
  // 口座が「3分前から」と出るのは、この行が防ぐべき誤読そのもの（長期化に気づくための
  // 行が、長期化していないと言う）。見分ける材料は /healthz 直下の uptimeSec だけ。
  it('refuses to date a stop that this process could have re-stamped', () => {
    const health = codexDetailedHealth();
    health.uptimeSec = 180;
    const account = health.pool.accounts[0];
    account.cappedSince = new Date(now - 2 * 60 * 1000).toISOString();
    account.resumeStreak = 1;

    const output = renderCodexStatus(health, now);
    const lines = codexSectionLines(output);

    assert.equal(lines.some(line => line.startsWith('    held     since')), false, '経過時間を実測として描かない');
    assert.doesNotMatch(output, /since 09\/16/);
    // 落ちるのはこの1行だけ。行も、解除条件も、読み取り時刻も従来どおり残る。
    assert.match(output, /^ {2}primary {2}held {6}7d .* {2}98% {2}stop 75%/m);
    assert.ok(lines.includes('    clears   1 of 2 clean reads done - needs 70% or less, not at that reset'));
    assert.match(output, / {4}read {5}09\/16 15:32 JST usage GET/);
    assert.doesNotMatch(output, /undefined|NaN|Invalid Date/);
  });

  // 境界: 復元した起動時刻は必ず真の起動時刻以前へ倒す。誤差は2つあり、どちらも
  // 「起動時刻を実際より新しく（＝後ろへ）見せる」一方向である。
  //   (a) 秒未満の位相: ブリッジは uptimeSec を秒へ切り捨てて公開するので、報告値は
  //       /healthz を返した瞬間の真の稼働時間より最大 999ms 短い。上界は 999ms で確定。
  //   (b) GET から描画までの待ち時間: ここの now は /healthz を取った時刻ではなく画面を描く
  //       時刻で（src/monitor.js の renderStatus() は options.now ?? Date.now()）、CLI は
  //       fetch 時刻を渡さない。**この区間に上界は無い。** 設定値
  //       openaiBridge.degradeMapping.codexStatusTimeoutMs（既定 1500ms）が上界を与えるのは
  //       /healthz の GET そのものだけ（src/cli.js:1390 の fetchCodexHealth）で、その後に走る
  //       readStatus()（src/cli.js:1367 → getJson → requestJson。req.setTimeout も
  //       AbortSignal も無く、signal は undefined のまま渡る）の往復は無制限に延びうる。
  //       renderStatus() が呼ばれて now が取られるのは、さらにその後（src/cli.js:113-118）。
  // だから codexProcessStartedAt() は +1秒（(a) の打ち消し）とスラック5秒を引く。ただしこの
  // 5秒は (b) の上界ではなく、実測に基づく当て込みにすぎない。/healthz が 0.5 秒で返っても
  // /internal/status が 4 秒詰まれば (a)+(b) は枠 6000ms を超え、復元した起動時刻が真の起動
  // より後ろへ回って、この一連のテストが防ごうとしている嘘の経過時間がそのまま描かれる
  // （しかもテストは全件グリーンのまま）。
  //
  // 【根治策・申し送り】上限クランプ（codexStatusTimeoutMs に最大値を設ける）を入れても
  // 直らない。無制限なのは readStatus() 側で、この設定値の配下ではないからである。根治は
  // 「CLI が /healthz を取得した時刻を控え、それを renderStatus() へ now として渡す」こと
  // （src/cli.js:113-118 で fetch 直後に Date.now() を控え、renderStatus(status, { codex, now })
  // として渡す。renderStatus は既に options.now を受ける）。そうすれば (b) は構造的に 0 に
  // なり、必要なスラックは (a) の 999ms だけで足りる。src/cli.js と src/monitor.js は今回の
  // 許可範囲外なので、ここに書き置くだけにしてある。
  //
  // このテストは (a)(b) を含まない素の境界だけを見る。境界ちょうどなら描かない、
  // 1ミリ秒でも前なら描く。(a)(b) を実際に含んだ配置は次の2本で見る。
  it('draws the elapsed time only for a latch older than this process', () => {
    const health = codexDetailedHealth();
    health.uptimeSec = 3600;
    // src/monitor.js の codexProcessStartedAt(): now - (uptimeSec + 1) * 1000 - 5000。
    const safeStartedAt = now - (3600 + 1) * 1000 - 5000;
    const account = health.pool.accounts[0];

    account.cappedSince = new Date(safeStartedAt).toISOString();
    assert.doesNotMatch(renderCodexStatus(health, now), / {4}held {5}since /);

    // スラック分を見た上でなお起動より前なら、従来どおり日付と経過時間を出す。
    account.cappedSince = new Date(safeStartedAt - 1).toISOString();
    assert.match(renderCodexStatus(health, now), / {4}held {5}since 09\/16 14:32 JST \(1h1m\)/);
  });

  // 欠陥そのものの再現。(a) 秒未満の位相 600ms と (b) GET→描画の待ち時間 1500ms を
  // フィクスチャの now / uptimeSec / cappedSince の関係として実際に作り込む。
  // 旧実装 `now - uptimeSec * 1000` はこの配置で起動時刻を真の起動より 2.1 秒後ろへ
  // 置くので、起動 0.6 秒後（起動時の検証ゲートの usage GET は実測 460～604ms）に
  // 刻み直されたラッチを「起動より前」と誤判定し、`since 09/16 14:32 JST (1h1m)` と
  // 描いてしまう。実際には同じ停止が 09/15 から続いていることも、たった今始まった
  // ことも有り得る値で、長期化に気づくためのこの行が「1時間前から」と嘘をつく。
  it('refuses a latch re-stamped just after boot, sub-second phase and fetch wait included', () => {
    // (a) /healthz を返した瞬間の真の稼働時間。ブリッジはこれを秒へ切り捨てて公開する。
    const trueUptimeAtFetchMs = 3600 * 1000 + 600;
    // (b) その GET から画面を描くまでの待ち時間。この区間に上界は無いので、支配項である
    // /healthz の GET のタイムアウトを「ありそうな大きさ」の詰め物として置く（上の注記）。
    const fetchToDrawMs = DISABLED_DEGRADE_MAPPING.codexStatusTimeoutMs;
    // 描画時刻 now から逆算した、このブリッジプロセスの真の起動時刻。
    const trueStartedAt = now - trueUptimeAtFetchMs - fetchToDrawMs;

    const health = codexDetailedHealth();
    health.uptimeSec = Math.floor(trueUptimeAtFetchMs / 1000);
    const account = health.pool.accounts[0];
    account.cappedSince = new Date(trueStartedAt + 600).toISOString();
    account.resumeStreak = 1;

    // この詰め物が欠陥の発生条件を満たしていること自体を固定する。旧式の復元が
    // ラッチより後ろに来ていなければ（＝旧実装でも描かれないなら）このテストは空振りで、
    // 何も守っていない。ここで落として気づけるようにする。
    const legacyStartedAt = now - health.uptimeSec * 1000;
    assert.ok(
      Date.parse(account.cappedSince) < legacyStartedAt,
      `旧実装が描いてしまう配置であること: cappedSince=${account.cappedSince} / `
        + `旧式の起動時刻=${new Date(legacyStartedAt).toISOString()}`,
    );

    const output = renderCodexStatus(health, now);
    const lines = codexSectionLines(output);

    assert.equal(lines.some(line => line.startsWith('    held     since')), false, '刻み直しを実測として描かない');
    assert.doesNotMatch(output, /since 09\/16 14:32 JST/, '旧実装が出していた文字列そのもの');
    // 落ちるのはこの1行だけ。行も、解除条件も、読み取り時刻も従来どおり残る。
    assert.match(output, /^ {2}primary {2}held {6}7d .* {2}98% {2}stop 75%/m);
    assert.ok(lines.includes('    clears   1 of 2 clean reads done - needs 70% or less, not at that reset'));
    assert.match(output, / {4}read {5}09\/16 15:32 JST usage GET/);
    assert.doesNotMatch(output, /undefined|NaN|Invalid Date/);
  });

  // src/monitor.js の CODEX_UPTIME_SLACK_MS = 5000 で足りるかどうかを大きく左右するのは、
  // あの定数ではなく設定値 codexStatusTimeoutMs である。src は触らないので、その依存関係を
  // テスト側で固定する。**これは最悪ケースの証明ではない。** 誤差(b) には上界が無く（上の
  // 注記のとおり readStatus() の往復は無制限）、このテストが見ているのは次の2点だけ:
  //   ・誤差(b) の支配項である /healthz の GET のタイムアウトが既定 1500ms から動いていないこと
  //   ・その既定のもとでなら 999ms（位相）+ 1500ms が枠 6000ms に収まること
  // 既定値が動いたら、スラックの当て込みを計算し直すためにここが落ちる。
  it('pins the configured fetch timeout that dominates the uptime slack budget', () => {
    const subSecondPhaseMs = 999;
    const fetchTimeoutMs = DISABLED_DEGRADE_MAPPING.codexStatusTimeoutMs;
    assert.equal(fetchTimeoutMs, 1500, '現行の実配備値。変えるならスラックの余裕を計算し直す');
    // src/openai-bridge.js の positiveNumber() には上限クランプが無いので、この支配項だけでも
    // 設定次第で枠を食い破れる（5001ms を超えると復元が真の起動より後ろへ回り得る）。ただし
    // クランプの有無そのものはここでは固定しない。normalizeDegradeMapping の許容範囲は
    // test/openai-bridge.test.js の領分であり、しかも上限クランプは誤差(b) の無制限項を塞がず
    // 単独では根治にならない（根治策は上の注記）。ここで「クランプが無いこと」を期待値として
    // 持つと、その是正を入れた人がスラックの話のテストで落ちて原因を読み違える。

    // 枠は codexProcessStartedAt() が引く分そのもの: (uptimeSec + 1) の +1秒とスラック5秒。
    const budgetMs = 1000 + 5000;
    assert.ok(
      subSecondPhaseMs + fetchTimeoutMs < budgetMs,
      `支配項の誤差 ${subSecondPhaseMs + fetchTimeoutMs}ms は枠 ${budgetMs}ms に収まること`,
    );

    // 最悪の位相と、支配項が既定いっぱいまで延びた待ち時間を同時に置いてなお、起動と同時刻に
    // 刻まれたラッチ（刻み直しの限界ケース）を日付として描かない。
    const trueUptimeAtFetchMs = 3600 * 1000 + subSecondPhaseMs;
    const trueStartedAt = now - trueUptimeAtFetchMs - fetchTimeoutMs;
    const health = codexDetailedHealth();
    health.uptimeSec = Math.floor(trueUptimeAtFetchMs / 1000);
    health.pool.accounts[0].cappedSince = new Date(trueStartedAt).toISOString();

    assert.doesNotMatch(renderCodexStatus(health, now), / {4}held {5}since /);
  });

  // 起動前から続いている停止は従来どおり日付と経過時間を出す。この行の本来の用途
  // （温存の長期化に気づく）が生きるのはこの場合だけ。
  //
  // この状態は現行のブリッジでは発生しない。cappedSince の公開は 2026-09-17 の坂根氏
  // 判断で取り下げられており（ブリッジはラッチ時刻を永続化していない）、将来 09/21 の
  // 効果測定後に永続化して再公開されたときのためにこの期待値を固定してある。
  it('dates a stop that began before this bridge process did', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.cappedSince = '2026-09-15T13:20:00.000Z';
    account.resumeStreak = 1;

    const lines = codexSectionLines(renderCodexStatus(health, now));

    assert.ok(lines.includes('    held     since 09/15 22:20 JST (17h13m)'));
  });

  // uptimeSec が無いペイロード（旧ブリッジ・壊れたペイロード）では突合ができない。
  // 例外にせず、必須キー検査にも足さず、安全側（描かない）へ倒す。Codex 節ごと
  // 消すのは、1行の欠落より遥かに重い損失。
  it('withholds the elapsed time when the payload carries no uptimeSec to check it against', () => {
    for (const uptimeSec of [undefined, null, 'lots', Number.NaN, -1]) {
      const health = codexDetailedHealth();
      if (uptimeSec === undefined) delete health.uptimeSec;
      else health.uptimeSec = uptimeSec;
      const account = health.pool.accounts[0];
      account.cappedSince = '2026-09-15T13:20:00.000Z';
      account.resumeStreak = 1;

      const output = renderCodexStatus(health, now);
      const label = String(uptimeSec);

      assert.doesNotMatch(output, / {4}held {5}since /, label);
      // 画面は完成したまま: 節も、行も、解除条件も出る。
      assert.match(output, /Codex Rotator {26}sendable 0\/2 {2}\(held 1, capped 1\)/, label);
      assert.match(output, /^ {2}primary {2}held {6}7d .* {2}98% {2}stop 75%/m, label);
      assert.ok(codexSectionLines(output)
        .includes('    clears   1 of 2 clean reads done - needs 70% or less, not at that reset'), label);
      assert.doesNotMatch(output, /invalid payload|undefined|NaN/, label);
    }
  });

  it('adds neither field to the mandatory key check', () => {
    const health = {
      contract: 1,
      pool: { state: 'degraded', accounts: [{ label: 'pro-a', selectionEligible: true }] },
    };

    const output = renderCodexStatus(health, now);

    assert.match(output, /Codex Rotator {26}sendable 1\/1$/m);
    assert.doesNotMatch(output, /invalid payload/);
    assert.doesNotMatch(output, /undefined|NaN/);
  });

  it('shows a second window only while its own reading is current', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.secondaryObservationFresh = true;
    account.secondaryUsedPercent = 20;
    account.secondaryWindowDurationMins = 300;
    account.secondaryWindowResetAt = '2026-09-16T08:30:00.000Z';

    const lines = codexSectionLines(renderCodexStatus(health, now));
    const row = lines.findIndex(line => line.startsWith('  primary'));

    // 主窓の真下に、バーと % が縦に揃う形で並ぶ。
    assert.equal(
      lines[row + 1],
      `  ${' '.repeat(8)} ${' '.repeat(9)} 5h ██░░░░░░░░  20%${' '.repeat(13)}reset in 1h57m -> 09/16 17:30 JST`,
    );
    assert.equal(lines[row].indexOf('██'), lines[row + 1].indexOf('██'));
    // 鮮度が切れている副窓は行に出さず、note で開示する（今日の pro2）。
    assert.match(renderCodexStatus(health, now), /note: second window on pro2 is stale - last read 0% on 09\/16 06:23 JST/);
  });

  // 使用率は主窓だけから採る。max(primary, secondary) は隣の stop 線と比較できない。
  it('never lets a second window supply the percentage on the main row', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.secondaryUsedPercent = 100;
    account.secondaryObservationFresh = true;
    account.secondaryWindowDurationMins = 300;

    const row = codexSectionLines(renderCodexStatus(health, now)).find(line => line.startsWith('  primary'));

    assert.match(row, / {2}98% {2}stop 75%/);
  });

  it('states what the percentages cover instead of claiming the CLI is excluded', () => {
    const health = codexDetailedHealth();

    const output = renderCodexStatus(health, now);

    assert.match(output, /note: percentages cover the whole account - ChatGPT app, Codex CLI, and this bridge/);
    assert.match(output, /note: the CLI's own share cannot be separated out/);
    assert.doesNotMatch(output, /CLI-driven usage is not included/);

    health.pool.observation.accountUsageIncludesExternalClients = false;
    health.pool.observation.cliConsumptionVisible = true;
    const quiet = renderCodexStatus(health, now);

    assert.doesNotMatch(quiet, /percentages cover the whole account/);
    assert.doesNotMatch(quiet, /cannot be separated out/);
  });

  it('keeps every state word out of the payload vocabulary it cannot mean', () => {
    const lines = codexSectionLines(renderCodexStatus(codexEveryStateHealth(), now));
    const words = {
      ready1: 'ready',
      held1: 'held',
      reserved1: 'reserved',
      exhausted1: 'exhausted',
      stopped1: 'stopped',
      blocked1: 'blocked',
      needslogin1: 'needs login',
      starting1: 'starting',
      // 知らない語は素通しする。嘘をつくより曖昧なまま出す。
      unknown1: 'draining',
    };

    for (const [label, word] of Object.entries(words)) {
      const row = lines.find(line => line.startsWith(`  ${label} `));
      assert.match(row, new RegExp(`^ {2}${label} +${word}(?= |$)`), label);
    }
    assert.doesNotMatch(renderCodexStatus(codexEveryStateHealth(), now), /^ {2}\w+ +cooldown/m);
  });

  // /healthz の語との対応は固定表では書けない。`cooldown` と出るのは停止ラッチの
  // 掛かった口座だけで、reserved / unread はラッチを持たないので `ready` のまま出る。
  // だから対応は画面が受け取ったペイロードから起こし、その画面に居る語だけを示す。
  it('states which /healthz word each row actually arrives under', () => {
    const notes = codexSectionLines(renderCodexStatus(codexEveryStateHealth(), now))
      .filter(line => line.includes('/healthz'));

    assert.deepEqual(notes, [
      '  note: held / stopped / blocked read as "cooldown" in /healthz',
      '  note: reserved reads as "ready" in /healthz - not sendable all the same',
      '  note: needs login reads as "needs-login" in /healthz',
      '  note: starting reads as "unknown" in /healthz',
    ]);
  });

  // 温存された口座を /healthz で探す運用者が `cooldown` を grep しても出てこない。
  // 画面が「cooldown と出る」と書いていると、画面と /healthz のどちらが壊れて
  // いるのかの判断を誤らせる。
  it('never claims that reserved or unread read as cooldown', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].state = 'ready';
    health.pool.accounts[0].selectionBlockReason = 'usage-unknown-reserved';
    health.pool.accounts[1].state = 'ready';
    health.pool.accounts[1].selectionBlockReason = 'usage-unknown';

    const output = renderCodexStatus(health, now);

    assert.ok(codexSectionLines(output)
      .includes('  note: reserved / unread read as "ready" in /healthz - not sendable all the same'));
    assert.doesNotMatch(output, /cooldown/);
  });

  // 逆向き: /healthz が cooldown を返す語（blocked / stopped）だけの画面でも
  // 対応が出る。旧実装の固定表はこの2語を挙げていなかったので1行も出なかった。
  it('states the cooldown mapping for the words that actually reach it', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].selectionBlockReason = 'upstream-blocked';
    health.pool.accounts[0].ordinaryUsageAllowed = false;
    health.pool.accounts[1].stopUsedPercent = null;
    health.pool.accounts[1].resumeUsedPercent = null;

    const lines = codexSectionLines(renderCodexStatus(health, now));

    assert.ok(lines.includes('  note: blocked / stopped read as "cooldown" in /healthz'));
  });

  // 使用率の停止線と上流の拒否は別のラッチで、解除には同じ1回の観測が両方を
  // 満たす必要がある。ブロック理由は使用率を先に名乗るので、拒否された口座も
  // `held`（当方の線で止めた）と出る。`clears` 行だけを読んで停止線を緩めても、
  // 拒否が続くかぎりその口座は1本も送れない。
  it('names the upstream refusal as its own condition under a held row', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].ordinaryUsageAllowed = false;

    const lines = codexSectionLines(renderCodexStatus(health, now));
    const clears = lines.findIndex(line => line.startsWith('    clears'));

    assert.match(lines[clears], /^ {4}clears {3}not at that reset - /);
    assert.equal(lines[clears + 1],
      '    refused  the upstream refuses ordinary use too - those reads must say otherwise');
    assert.ok(lines.includes('  note: refused = the upstream refuses it too; the usage stop is not the only latch'));
  });

  it('draws no refusal line while the upstream still allows ordinary use', () => {
    const output = renderCodexStatus(codexDetailedHealth(), now);

    assert.match(output, / {4}read {5}.*ordinary use allowed/);
    assert.doesNotMatch(output, /refused/);
  });

  // 個別の停止線を持たない口座はレガシー経路で解ける（1回の観測で使用率の
  // ラッチも上流の拒否も落ちる）。そこへ上流の同意を条件として書くと過大になる。
  it('adds no refusal condition to an account with no usage policy', () => {
    const health = codexDetailedHealth();
    health.pool.accounts[0].stopUsedPercent = null;
    health.pool.accounts[0].resumeUsedPercent = null;
    health.pool.accounts[0].ordinaryUsageAllowed = false;

    const output = renderCodexStatus(health, now);

    assert.match(output, /^ {2}primary {2}stopped/m);
    assert.doesNotMatch(output, / {4}refused/);
  });

  // ラベル欄は契約が許す32桁まで伸ばす。20桁で頭打ちにすると、長いラベルの行だけ
  // バーが右へずれ、真下に描く副窓の行とも他の口座の行とも縦が揃わなくなる
  // （terminalPadEnd は切り詰めないので、桁が収まるわけでもない）。
  it('keeps the grid aligned for a label as long as the contract allows', () => {
    const label = 'a'.repeat(32);
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.label = label;
    account.secondaryObservationFresh = true;
    account.secondaryUsedPercent = 20;
    account.secondaryWindowDurationMins = 300;

    const lines = codexSectionLines(renderCodexStatus(health, now));
    const row = lines.findIndex(line => line.startsWith(`  ${label} `));

    assert.ok(row > 0, 'ラベルは切り詰めずに全文を出す');
    // 副窓の行のバーが主窓のバーの真下に来る。
    assert.equal(lines[row].indexOf('██'), lines[row + 1].indexOf('██'));
    // 他の口座の行とも同じ桁で揃う。
    assert.equal(lines[row].indexOf('██'), lines.find(line => line.startsWith('  pro2')).indexOf('██'));
  });

  // 口座レベルの観測出所は主窓・副窓のうち新しい方のものなので、副窓のほうが
  // 新しい口座では主窓の読み取りの出所ではない。取り違えるくらいなら名乗らない。
  it('never attributes a newer second-window reading to the primary one', () => {
    const health = codexDetailedHealth();
    const account = health.pool.accounts[0];
    account.observationSource = 'response-header';
    account.lastKnownSecondaryObservedAt = '2026-09-16T06:32:30.000Z';

    const output = renderCodexStatus(health, now);

    assert.match(output, / {4}read {5}09\/16 15:32 JST, ordinary use allowed, stops when unread/);
    assert.doesNotMatch(output, /response headers/);
  });
});

// `claude-rotator status` の Codex 節だけを取り出す。Claude 側の2列レイアウトは
// 120桁で、桁の検査を混ぜると意味が無くなるため口座を持たない status で描く。
function renderCodexStatus(health, now) {
  return renderStatus({ accounts: [], events: [] }, { now, columns: 120, codex: { ok: true, health } });
}

function codexSectionLines(output) {
  const lines = output.split('\n');
  const start = lines.findIndex(line => line.startsWith('Codex Rotator'));
  if (start < 0) return [];
  const rest = lines.slice(start);
  const end = rest.indexOf('');
  return end < 0 ? rest : rest.slice(0, end);
}

// 2026-09-16 15:33 JST の /healthz を写した詰め物。ラベルは契約どおり label のみで、
// メールアドレスは持たない。cappedSince / resumeStreak は**わざと持たせない**
// （ブリッジ側の任意フィールドで、無くても画面が完成することを固定するため）。
function codexDetailedHealth() {
  return {
    status: 'ok',
    contract: 1,
    // 実データと同じくルート直下に出る。2026-09-16 06:02 JST 配備のプロセスを
    // 15:33 JST に読んだときの値（9h31m）。cappedSince の下限判定に要る唯一の材料で、
    // これが無いと経過時間は描けない（描いたら再起動で巻き直された値を実測として
    // 出すことになる）。
    uptimeSec: 34260,
    pool: {
      state: 'exhausted',
      accountsTotal: 2,
      accountsAvailable: 0,
      resetAt: '2026-09-19T08:10:37.000Z',
      observation: {
        mode: 'http',
        source: 'usage-get',
        gate: 'passed',
        cliConsumptionVisible: false,
        accountUsageIncludesExternalClients: true,
      },
      accounts: [
        {
          label: 'primary',
          state: 'cooldown',
          selectionEligible: false,
          selectionBlockReason: 'usage-capped',
          stopUsedPercent: 75,
          resumeUsedPercent: 70,
          primaryUsedPercent: 98,
          lastKnownPrimaryUsedPercent: 98,
          primaryObservationFresh: true,
          secondaryObservationFresh: false,
          primaryWindowDurationMins: 10080,
          primaryWindowResetAt: '2026-09-21T11:59:55.000Z',
          primaryObservedAt: '2026-09-16T06:32:00.000Z',
          nextObservationAt: '2026-09-16T06:34:00.000Z',
          observationSource: 'usage-get',
          ordinaryUsageAllowed: true,
          blockWhenUnknown: true,
        },
        {
          label: 'pro2',
          state: 'cooldown',
          selectionEligible: false,
          selectionBlockReason: 'usage-capped',
          stopUsedPercent: 100,
          resumeUsedPercent: 99,
          primaryUsedPercent: 100,
          primaryObservationFresh: true,
          secondaryObservationFresh: false,
          lastKnownSecondaryUsedPercent: 0,
          lastKnownSecondaryObservedAt: '2026-09-15T21:23:24.926Z',
          secondaryWindowResetAt: '2026-09-15T21:23:24.926Z',
          primaryWindowDurationMins: 10080,
          primaryWindowResetAt: '2026-09-19T08:10:37.000Z',
          primaryObservedAt: '2026-09-16T06:32:00.000Z',
          observationSource: 'usage-get',
          ordinaryUsageAllowed: true,
          blockWhenUnknown: false,
        },
      ],
    },
  };
}

// 同じ関数が描く状態語をすべて1画面に並べた詰め物（桁の上限と語彙の確認用）。
function codexEveryStateHealth() {
  const window = { primaryWindowDurationMins: 10080, primaryWindowResetAt: '2026-09-21T11:59:55.000Z' };
  return {
    contract: 1,
    pool: {
      state: 'degraded',
      observation: { source: 'usage-get', gate: 'passed' },
      accounts: [
        {
          label: 'ready1', state: 'ready', selectionEligible: true, selectionBlockReason: null,
          stopUsedPercent: 75, resumeUsedPercent: 70, primaryUsedPercent: 31,
          primaryObservationFresh: true, primaryObservedAt: '2026-09-16T06:32:00.000Z', ...window,
        },
        {
          label: 'held1', state: 'cooldown', selectionEligible: false, selectionBlockReason: 'usage-capped',
          stopUsedPercent: 75, resumeUsedPercent: 70, primaryUsedPercent: null,
          lastKnownPrimaryUsedPercent: 98, primaryObservationFresh: false,
          cappedSince: '2026-09-15T13:20:00.000Z', resumeStreak: 1, ...window,
        },
        {
          label: 'reserved1', state: 'ready', selectionEligible: false,
          selectionBlockReason: 'usage-unknown-reserved', stopUsedPercent: 100,
          primaryUsedPercent: null, blockWhenUnknown: true, ...window,
        },
        {
          label: 'exhausted1', state: 'exhausted', selectionEligible: false, selectionBlockReason: 'exhausted',
          stopUsedPercent: 100, primaryUsedPercent: 100, primaryObservationFresh: true,
          resetAt: '2026-09-19T08:10:37.000Z', ...window,
        },
        {
          label: 'stopped1', state: 'cooldown', selectionEligible: false, selectionBlockReason: 'usage-capped',
          stopUsedPercent: null, primaryUsedPercent: 96, primaryObservationFresh: true, ...window,
        },
        {
          label: 'blocked1', state: 'cooldown', selectionEligible: false, selectionBlockReason: 'upstream-blocked',
          stopUsedPercent: 75, resumeUsedPercent: 70, primaryUsedPercent: 41,
          primaryObservationFresh: true, ordinaryUsageAllowed: false, ...window,
        },
        { label: 'needslogin1', state: 'needs-login', selectionEligible: false, selectionBlockReason: 'needs-login' },
        { label: 'starting1', state: 'unknown', selectionEligible: false, selectionBlockReason: null },
        // 知らない語は素通しする。嘘をつくより曖昧なまま出す。
        { label: 'unknown1', state: 'draining', selectionEligible: false, selectionBlockReason: null },
      ],
    },
  };
}
