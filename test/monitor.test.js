import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager, familyQuotaExhaustedOnly } from '../src/account-manager.js';
import { progressBar, renderStatus, formatDuration } from '../src/monitor.js';
import { createCodexPool, projectCodexStatus } from '../src/codex/snapshot.js';
import { renderCodexDisplayError, renderCodexSection } from '../src/shared/codex-view.js';

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

// Codex section of `claude-rotator status` and `monitor`. renderStatus draws what
// the Codex section reader returned (src/codex-status-child.js) with the shared
// view that `codex-rotator status` uses, between the account cards and the session
// affinity section. Without it the screen is byte-identical.
describe('codex status section', () => {
  const now = Date.parse('2026-06-04T09:00:00Z');
  const codexStatus = () => projectCodexStatus({
    enabled: true,
    pool: createCodexPool([{ key: 'zz-key-a', label: 'zz-a' }],
      { accounts: [{ label: 'zz-a', usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false } }] }),
    daemon: { reachable: true, startedAt: now - 60000 },
    source: 'daemon',
    nowMs: now,
  });
  // The screen without a Codex section, with the given lines put right after the
  // account cards (that is, right before the Events heading in sampleStatus()).
  const withCodexLines = (baseline, lines) => baseline.replace('\nEvents\n', `\n${lines.join('\n')}\nEvents\n`);

  it('OSS independence: no codex data means the status output is byte-identical', () => {
    const baseline = renderStatus(sampleStatus(), { now, columns: 100 });

    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: null }), baseline);
    assert.equal(renderStatus(sampleStatus(), { now, columns: 100, codex: undefined }), baseline);
    assert.doesNotMatch(baseline, /Codex Rotator/);
  });

  it('draws the status JSON with the same lines as codex-rotator status, after the cards, leaving the Claude side as it was', () => {
    const status = codexStatus();
    const baseline = renderStatus(sampleStatus(), { now, columns: 120 });

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: true, status } });

    assert.equal(output, withCodexLines(baseline, renderCodexSection(status, { now })));
    assert.match(output, /Codex Rotator {26}sendable \d+\/1/);
  });

  it('draws one display error line when the child output could not be used', () => {
    const baseline = renderStatus(sampleStatus(), { now, columns: 120 });

    const output = renderStatus(sampleStatus(), { now, columns: 120, codex: { ok: false, reason: 'timeout 8000ms' } });

    assert.equal(output, withCodexLines(baseline, renderCodexDisplayError('timeout 8000ms')));
    assert.match(output, /Codex Rotator {26}codex: display error \(timeout 8000ms\)\n\nEvents/);
  });

  it('keeps the Codex section above the session affinity section', () => {
    const status = { ...sampleStatus(), sessionAffinity: { mode: 'on', sessions: 0 } };

    const output = renderStatus(status, { now, columns: 120, codex: { ok: false, reason: 'exit 1' } });

    assert.ok(output.indexOf('Codex Rotator') < output.indexOf('Session Affinity'));
    assert.ok(output.indexOf('Session Affinity') < output.indexOf('\nEvents\n'));
  });
});

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
