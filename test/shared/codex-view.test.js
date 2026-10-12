// 共用の部品のテスト: Codex の状態の描画（src/shared/codex-view.js）、端末の文字列の部品
// （src/shared/terminal-text.js）、codex-rotator の置き場所（src/shared/codex-locator.js）。
//
// 描画は、Codex の節に出す項目（src/shared/codex-view.js の頭の注記に並べた画面の作り）を、項目ごとに
// 1つ以上のテストで確かめる。見本の状態の JSON は合成の値で、描く前にスキーマ検査を通す（検査の外の値で
// 描き方を確かめるテストだけは、その旨を書いて検査を通さない）。
// 純粋関数だけで、I/O はしない（置き場所のテストが入口のファイルがあるかを1回だけ見る）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatRemoveGuidance, formatReloginGuidance } from '../../src/codex/exec.js';
import { codexRotatorConfigPath } from '../../src/codex/paths.js';
import { aggregateCodexAccounts, codexAccountHeadroom } from '../../src/codex/snapshot.js';
import { formatDuration as monitorDuration, progressBar as monitorBar } from '../../src/monitor.js';
import { codexRotatorConfigFile, codexRotatorEntryPath } from '../../src/shared/codex-locator.js';
import {
  CODEX_POOL_STATES, CODEX_STARTUP_CHECKS, CODEX_STATE_OF_WORD, CODEX_STATE_WORDS, codexIsoTime, codexStatusProblem,
} from '../../src/shared/codex-status-schema.js';
import { CODEX_DISABLED_TEXT, renderCodexDisplayError, renderCodexSection } from '../../src/shared/codex-view.js';
import {
  formatDuration, formatJstDate, progressBar, terminalDisplayWidth, terminalPadEnd,
} from '../../src/shared/terminal-text.js';

const NOW = Date.UTC(2027, 0, 15, 8, 0, 0);
const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = ms => codexIsoTime(ms);
const HEADING = terminalPadEnd('Codex Rotator', 39);
const POLICY = Object.freeze({ stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false });

const windowOf = (overrides = {}) => ({ usedPercent: 40, resetAt: iso(NOW + 2 * HOUR), windowMinutes: 300, fresh: true,
  observedAt: iso(NOW - MIN), lengthSource: 'reported', ...overrides });
const weeklyOf = (overrides = {}) => windowOf({ usedPercent: 60, resetAt: iso(NOW + 3 * DAY), windowMinutes: 10080, ...overrides });
const latchOf = (overrides = {}) => ({ stopped: true, cappedWindows: ['fiveHour'], upstreamBlocked: false, cleanReadsDone: 0,
  cleanReadsNeeded: 2, since: null, ...overrides });

// 口座1つ（既定は使える口座）。stateWord を渡すと state もそれに合わせる。
function accountOf(label, overrides = {}) {
  const stateWord = overrides.stateWord ?? 'ready';
  return {
    label, order: 1, stateWord, selectable: stateWord === 'ready', reason: null, resetAt: null,
    ordinaryUsageAllowed: true, nextObservationAt: iso(NOW + MIN), policy: { ...POLICY }, latch: null,
    windows: { fiveHour: windowOf(), weekly: weeklyOf() }, otherWindows: [], observedAt: iso(NOW - MIN), headroomPercent: null,
    ...overrides,
    state: CODEX_STATE_OF_WORD[stateWord],
  };
}
// 使用量の分からない口座。
const unreadOf = (label, overrides = {}) => accountOf(label, { stateWord: 'unread', reason: 'usage-unknown',
  ordinaryUsageAllowed: null, windows: { fiveHour: null, weekly: null }, observedAt: null, ...overrides });
const heldOf = (label, overrides = {}) => accountOf(label, { stateWord: 'held', reason: 'usage-capped', latch: latchOf(),
  windows: { fiveHour: windowOf({ usedPercent: 80 }), weekly: weeklyOf() }, ...overrides });

// 状態の JSON。order・口座ごとの実効残量・全体の値は、射影と同じ関数で埋める。
function statusOf(accounts, { source = 'daemon', ...top } = {}) {
  const numbered = accounts.map((account, index) => {
    const next = { ...account, order: index + 1 };
    next.headroomPercent = codexAccountHeadroom(next, { source });
    return next;
  });
  return {
    schemaVersion: 1, provider: 'codex', enabled: true, generatedAt: iso(NOW), source, latchKnown: source === 'daemon',
    daemon: { reachable: source === 'daemon', startedAt: source === 'daemon' ? iso(NOW - HOUR) : null },
    pool: { state: 'ok', resetAt: null },
    observation: { method: 'usage-get', startupCheck: source === 'daemon' ? 'passed' : null,
      accountUsageIncludesExternalClients: true, cliConsumptionVisible: false, userAgentSource: 'codex-version' },
    next: { label: null, reason: 'none' },
    accounts: numbered,
    aggregate: aggregateCodexAccounts(numbered, { enabled: true, source }),
    events: [],
    ...top,
  };
}

function render(status, { schema = true } = {}) {
  if (schema) assert.equal(codexStatusProblem(status), null, 'the fixture passes the schema check');
  return renderCodexSection(status, { now: NOW });
}
const lineWith = (lines, text) => lines.find(line => line.includes(text));
const cardRow = (lines, label) => lines.find(line => line.startsWith(`  ${label} `));
const detail = (key, text) => `    ${terminalPadEnd(key, 9)}${text}`;

// --- 端末の文字列の部品 -----------------------------------------------------------------------------

test('terminal text: monitor.js hands out the shared bar and duration functions as they are', () => {
  assert.equal(monitorBar, progressBar);
  assert.equal(monitorDuration, formatDuration);
});

test('terminal text: widths count wide, emoji, combining and control characters the way a terminal shows them', () => {
  assert.equal(terminalDisplayWidth('zz-a'), 4);
  assert.equal(terminalDisplayWidth('日本'), 4);
  assert.equal(terminalDisplayWidth('é'), 1);
  assert.equal(terminalDisplayWidth('\u{1F44D}'), 2);
  assert.equal(terminalDisplayWidth('\u0007'), 0);
  assert.equal(terminalPadEnd('日本', 6), '日本  ');
  assert.equal(terminalPadEnd('toolong', 3), 'toolong', 'a long string is never cut');
  assert.equal(formatJstDate(NOW), '01/15 17:00 JST');
  assert.equal(formatJstDate(Number.NaN), '');
});

// --- 置き場所 -----------------------------------------------------------------------------------

test('locator: the config file is where the Codex side looks for it, from the env given and nothing else', () => {
  const envs = [
    { HOME: '/zz-home' },
    { HOME: '/zz-home', XDG_CONFIG_HOME: '/zz-xdg' },
    { HOME: '/zz-home', XDG_CONFIG_HOME: 'relative/xdg' },
    { HOME: '/zz-home/../zz-other', XDG_CONFIG_HOME: '/zz-xdg/./config' },
  ];
  for (const env of envs) assert.equal(codexRotatorConfigFile(env), codexRotatorConfigPath(env), JSON.stringify(env));
  assert.equal(codexRotatorConfigFile({ XDG_CONFIG_HOME: '/zz-xdg' }), codexRotatorConfigPath({ XDG_CONFIG_HOME: '/zz-xdg' }));
  for (const env of [{}, { HOME: 'relative-home' }, { HOME: 'relative-home', XDG_CONFIG_HOME: 'relative' }, null]) {
    assert.equal(codexRotatorConfigFile(env), null, JSON.stringify(env));
  }
});

test('locator: the entry point is the bin/codex-rotator.js of this package, found without a PATH search', () => {
  const entry = codexRotatorEntryPath();
  assert.equal(entry, fileURLToPath(new URL('../../bin/codex-rotator.js', import.meta.url)));
  assert.ok(existsSync(entry));
});

// --- 節の全体 -----------------------------------------------------------------------------------

test('section: a ready account with fresh windows is drawn as a header, four summary lines, its two rows and the notes', () => {
  const status = statusOf([accountOf('zz-a')], { next: { label: 'zz-a', reason: 'selectable' } });
  assert.deepEqual(render(status), [
    `${HEADING}sendable 1/1`,
    '  reading  usage GET, startup check passed, via daemon   pool state: ok (1/1 available)',
    '  latch    known (daemon)',
    '  next:    zz-a',
    '  effective  15 pts',
    '  zz-a     ready     5h ████░░░░░░  40%  stop 75%   reset in 2h -> 01/15 19:00 JST',
    `${' '.repeat(21)}7d ██████░░░░  60%${' '.repeat(13)}reset in 3d -> 01/18 17:00 JST`,
    '  note: percentages cover the whole account - ChatGPT app, Codex CLI, and any other client',
    "  note: the CLI's own share cannot be separated out",
    '  note: accounts are shown by label',
    '',
  ]);
});

test('section: not enabled draws the one disabled line under the heading', () => {
  const lines = renderCodexSection({ enabled: false }, { now: NOW });
  assert.deepEqual(lines, [`${HEADING}${CODEX_DISABLED_TEXT}`, '']);
  // 有効になるのは2つの設定がどちらも true のときなので、2つとも名指す。
  assert.equal(CODEX_DISABLED_TEXT, 'disabled (requires enabled and acknowledgedMultiAccountRisk)');
  assert.ok(terminalDisplayWidth(lines[0]) <= 100, lines[0]);
});

test('heading: the heading is always drawn, at the column of the Claude current: field', () => {
  for (const status of [statusOf([]), statusOf([accountOf('zz-a')]), statusOf([unreadOf('zz-a')], { source: 'direct' })]) {
    const [first] = render(status);
    assert.ok(first.startsWith('Codex Rotator '));
    assert.equal(first.indexOf('sendable'), 39);
  }
  const empty = render(statusOf([], { pool: { state: 'no-account', resetAt: null } }));
  assert.equal(empty[0], `${HEADING}sendable 0/0`);
  assert.equal(lineWith(empty, 'effective'), '  effective  0 pts');
  assert.equal(lineWith(empty, 'accounts are shown by label'), undefined, 'no label note without accounts');
});

test('display error: a child output that cannot be used is one display error line with one of the fixed reasons', () => {
  for (const reason of ['timeout 8000ms', 'exit 1', 'signal SIGTERM', 'spawn failed', 'invalid json', 'schema', 'too large']) {
    assert.deepEqual(renderCodexDisplayError(reason), [`${HEADING}codex: display error (${reason})`, ''], reason);
  }
  for (const reason of ['unreachable', 'schema status.accounts[0]', 'exit -1', '', null]) {
    assert.throws(() => renderCodexDisplayError(reason), TypeError, String(reason));
  }
});

test('header: the sendable header counts the selectable accounts and the state words of the rows; a long breakdown is dropped', () => {
  const lines = render(statusOf([accountOf('zz-a'), heldOf('zz-b'), unreadOf('zz-c')]));
  assert.equal(lines[0], `${HEADING}sendable 1/3  (held 1, unread 1)`);
  const words = CODEX_STATE_WORDS.filter(word => word !== 'ready');
  const many = render(statusOf(words.map((word, index) => accountOf(`zz-${index}`, { stateWord: word, selectable: false }))));
  assert.ok(terminalDisplayWidth(`${HEADING}sendable 0/11  (${words.map(word => `${word} 1`).join(', ')})`) > 100);
  assert.equal(many[0], `${HEADING}sendable 0/11`);
});

test('reading line: the reading line names the method, the start-up check, the source and the pool state', () => {
  const daemon = render(statusOf([accountOf('zz-a'), heldOf('zz-b')], { pool: { state: 'degraded', resetAt: null } }));
  assert.equal(daemon[1], '  reading  usage GET, startup check passed, via daemon   pool state: degraded (1/2 available)');
  const direct = render(statusOf([accountOf('zz-a')], { source: 'direct' }));
  assert.equal(direct[1], '  reading  usage GET, direct   pool state: ok (1/1 available)');
});

test('header: the pool reset instant is added at the end of the header only while it is ahead', () => {
  const ahead = render(statusOf([heldOf('zz-a')], { pool: { state: 'exhausted', resetAt: iso(NOW + HOUR) } }));
  assert.equal(ahead[0], `${HEADING}sendable 0/1  (held 1)  reset in 1h -> 01/15 18:00 JST`);
  const past = render(statusOf([heldOf('zz-a')], { pool: { state: 'exhausted', resetAt: iso(NOW - HOUR) } }));
  assert.equal(past[0], `${HEADING}sendable 0/1  (held 1)`);
});

test('card: both windows of an account are on its card (the old one-line row is folded into the card)', () => {
  const lines = render(statusOf([accountOf('zz-a')]));
  const row = lines.indexOf(cardRow(lines, 'zz-a'));
  assert.match(lines[row], / 5h ████░░░░░░  40% /);
  assert.match(lines[row + 1], /^ {21}7d ██████░░░░  60% /);
});

test('card: labels are drawn as they are; a label outside the pattern is <invalid> (outside the schema)', () => {
  const twenty = 'zz-label-of-twenty-c';
  assert.equal(twenty.length, 20);
  const lines = render(statusOf([accountOf(twenty), accountOf('zz-a')]));
  assert.ok(cardRow(lines, twenty).startsWith(`  ${twenty} ready`));
  assert.ok(cardRow(lines, 'zz-a').startsWith(`  zz-a${' '.repeat(17)}ready`), 'the label column is as wide as the widest label');
  const bad = render(statusOf([accountOf('ZZ-UPPER')]), { schema: false });
  assert.ok(cardRow(bad, '<invalid>'));
  assert.equal(lineWith(bad, 'ZZ-UPPER'), undefined);
});

test('card: every one of the twelve state words is drawn on its row', () => {
  for (const word of CODEX_STATE_WORDS) {
    const lines = render(statusOf([accountOf('zz-a', { stateWord: word, selectable: word === 'ready' })]));
    assert.ok(cardRow(lines, 'zz-a').startsWith(`  zz-a     ${terminalPadEnd(word, 9)} `), word);
  }
});

test('card: the window length label comes from the reported length, and -- without one', () => {
  const lengths = [[300, '5h'], [10080, '7d'], [120, '2h'], [null, '--']];
  for (const [minutes, label] of lengths) {
    // 長さの列は、どれかの窓が長さを申告しているときだけある（zz-b がその窓）。
    const lines = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf({ windowMinutes: minutes,
      lengthSource: minutes === null ? 'position' : 'reported' }), weekly: null } }), accountOf('zz-b')]));
    assert.ok(cardRow(lines, 'zz-a').includes(` ${label} ████░░░░░░`), String(minutes));
  }
  const noLength = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf({ windowMinutes: null,
    lengthSource: 'position' }), weekly: null } })]));
  assert.ok(cardRow(noLength, 'zz-a').startsWith('  zz-a     ready     ████░░░░░░'), 'no length anywhere, no length column');
});

test('card: the bar and an integer percentage are drawn for a fresh window; a stale one gets * and no bar', () => {
  const fresh = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf({ usedPercent: 40.6 }), weekly: null } })]));
  assert.match(cardRow(fresh, 'zz-a'), / 5h ████░░░░░░  41% {2}stop/);
  const stale = render(statusOf([accountOf('zz-a', { stateWord: 'unread', selectable: false, reason: 'usage-unknown',
    windows: { fiveHour: windowOf({ fresh: false }), weekly: null } })]));
  assert.match(cardRow(stale, 'zz-a'), / 5h ---------- {2}40%\* stop/);
});

test('card: the stop line of the policy is drawn; without one it reads stop  n/a (outside the schema)', () => {
  assert.match(cardRow(render(statusOf([accountOf('zz-a')])), 'zz-a'), / stop 75% {3}reset/);
  const noPolicy = render(statusOf([accountOf('zz-a', { policy: { stopUsedPercent: null, resumeUsedPercent: null,
    blockWhenUnknown: false } }), accountOf('zz-b')]), { schema: false });
  assert.match(cardRow(noPolicy, 'zz-a'), / stop {2}n\/a {2}/);
});

test('card: a reset instant is drawn only while ahead, and an exhausted account uses its own reset instant', () => {
  const past = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf({ resetAt: iso(NOW - MIN) }), weekly: null } })]));
  assert.equal(cardRow(past, 'zz-a').includes('reset in'), false);
  const exhausted = render(statusOf([accountOf('zz-a', { stateWord: 'exhausted', selectable: false, reason: 'exhausted',
    resetAt: iso(NOW + 30 * MIN) })]));
  assert.match(cardRow(exhausted, 'zz-a'), /reset in 30m -> 01\/15 17:30 JST$/);
});

test('card: each fresh window gets its own row: the five-hour, the weekly, then the other windows', () => {
  const lines = render(statusOf([accountOf('zz-a', { otherWindows: [windowOf({ usedPercent: 20, windowMinutes: 120,
    resetAt: iso(NOW + 90 * MIN) })] })]));
  const row = lines.indexOf(cardRow(lines, 'zz-a'));
  assert.match(lines[row], / 5h .* 40% /);
  assert.match(lines[row + 1], / 7d .* 60% /);
  assert.match(lines[row + 2], / 2h ██░░░░░░░░  20% .*reset in 1h30m/);
});

test('details: the clears line says what clears each state word, and never a time', () => {
  const clearsOf = account => lineWith(render(statusOf([account])), '    clears   ');
  assert.equal(clearsOf(heldOf('zz-a')), detail('clears', 'not at that reset - needs 2 clean usage reads at 60% or less'));
  assert.equal(clearsOf(heldOf('zz-a', { latch: latchOf({ cleanReadsDone: 1 }) })),
    detail('clears', '1 of 2 clean reads done - needs 60% or less, not at that reset'));
  assert.equal(clearsOf(heldOf('zz-a', { windows: { fiveHour: windowOf({ usedPercent: 80, resetAt: iso(NOW - MIN) }), weekly: null } })),
    detail('clears', 'not when the window resets - needs 2 clean usage reads at 60% or less'));
  assert.equal(clearsOf(accountOf('zz-a', { stateWord: 'capped', selectable: false, reason: 'usage-capped', latch: latchOf(),
    policy: { stopUsedPercent: 100, resumeUsedPercent: 90, blockWhenUnknown: false } })),
  detail('clears', 'not at that reset - needs 2 clean usage reads at 90% or less'));
  const noResume = render(statusOf([heldOf('zz-a', { policy: { stopUsedPercent: 75, resumeUsedPercent: null,
    blockWhenUnknown: false } })]), { schema: false });
  assert.equal(lineWith(noResume, 'clears'), detail('clears', 'not at that reset - needs 2 clean usage reads below the line that stopped it'));
  const expected = {
    stopped: "not at that reset - needs a usage read below the rotator's own limit",
    reserved: 'needs one complete usage read; this account will not send while unread',
    unread: 'needs one complete usage read',
    starting: 'needs the first usage read after the daemon started',
    exhausted: 'after that reset, once the rotator rechecks this account (429 seen)',
    blocked: 'the upstream refuses ordinary use; needs a read that says otherwise',
    'needs login': 'run codex-rotator login --label zz-a --relogin',
    'no creds': 'run codex-rotator remove --label zz-a, then log in again with codex-rotator login',
    'no models': 'needs a model assigned to this account',
  };
  for (const [word, text] of Object.entries(expected)) {
    assert.equal(clearsOf(accountOf('zz-a', { stateWord: word, selectable: false })), detail('clears', text), word);
  }
  assert.equal(clearsOf(accountOf('zz-a', { stateWord: 'exhausted', selectable: false,
    windows: { fiveHour: windowOf({ resetAt: iso(NOW - MIN) }), weekly: null } })),
  detail('clears', 'once the rotator rechecks this account (429 seen)'));
  // ログイン切れと資格情報が読めない口座の直し方は、exec が出す案内と同じ文。
  assert.equal(expected['needs login'], formatReloginGuidance('zz-a'));
  assert.equal(expected['no creds'], formatRemoveGuidance('zz-a'));
});

test('details: an account read without a codex CLI says so on unread and reserved cards alike', () => {
  const missing = statusOf([unreadOf('zz-a', { reason: 'codex-cli-missing' }),
    accountOf('zz-b', { stateWord: 'reserved', selectable: false, reason: 'codex-cli-missing',
      policy: { ...POLICY, blockWhenUnknown: true }, windows: { fiveHour: null, weekly: null }, observedAt: null })]);
  missing.observation.userAgentSource = null;
  const lines = render(missing);
  const clears = lines.filter(line => line.startsWith('    clears'));
  assert.deepEqual(clears, [detail('clears', 'needs a readable codex CLI (codex CLI not found)'),
    detail('clears', 'needs a readable codex CLI (codex CLI not found)')]);
  assert.equal(lines[2], `${' '.repeat(11)}usage read skipped: codex-cli-missing`, 'over 100 columns, so on the continuation line');
  const unreadable = statusOf([unreadOf('zz-a', { reason: 'codex-version-unreadable' })]);
  unreadable.observation.userAgentSource = null;
  const other = render(unreadable);
  assert.equal(lineWith(other, 'clears'), detail('clears', 'needs a readable codex CLI (codex CLI version unreadable)'));
  assert.equal(other[2], `${' '.repeat(11)}usage read skipped: codex-version-unreadable`);
  // User-Agent が作れたとき（出どころがある）は、読取を飛ばしたとは書かない。
  assert.equal(render(statusOf([unreadOf('zz-a')])).some(line => line.includes('skipped')), false);
});

test('details: a held account the upstream refuses too gets the refused line', () => {
  const byAllowed = render(statusOf([heldOf('zz-a', { ordinaryUsageAllowed: false })]));
  assert.equal(lineWith(byAllowed, 'refused  '), detail('refused', 'the upstream refuses ordinary use too - those reads must say otherwise'));
  const byLatch = render(statusOf([heldOf('zz-a', { latch: latchOf({ upstreamBlocked: true }) })]));
  assert.ok(lineWith(byLatch, '    refused  '));
  assert.equal(lineWith(render(statusOf([heldOf('zz-a')])), '    refused'), undefined);
});

test('details: the since line is drawn only for a stop that began before the daemon started', () => {
  const before = render(statusOf([heldOf('zz-a', { latch: latchOf({ since: iso(NOW - 3 * HOUR) }) })]));
  assert.equal(lineWith(before, 'since'), detail('held', 'since 01/15 14:00 JST (3h)'));
  const after = render(statusOf([heldOf('zz-a', { latch: latchOf({ since: iso(NOW - 30 * MIN) }) })]));
  assert.equal(lineWith(after, 'since'), undefined, 'a stop stamped after the daemon started says nothing about how long');
  const direct = render(statusOf([heldOf('zz-a', { latch: latchOf({ since: iso(NOW - 3 * HOUR) }) })], { source: 'direct' }));
  assert.equal(lineWith(direct, 'since'), undefined, 'without the daemon start time nothing is dated');
});

test('details: the read line gives the time, the method, staleness and what the reading said', () => {
  const fresh = render(statusOf([heldOf('zz-a')]));
  assert.equal(lineWith(fresh, '    read'), detail('read', '01/15 16:59 JST usage GET, ordinary use allowed, sends when unread'));
  const refused = render(statusOf([heldOf('zz-a', { ordinaryUsageAllowed: false, policy: { ...POLICY, blockWhenUnknown: true } })]));
  assert.equal(lineWith(refused, '    read'), detail('read', '01/15 16:59 JST usage GET, ordinary use refused, stops when unread'));
  const staleWindows = { fiveHour: windowOf({ fresh: false, observedAt: iso(NOW - 10 * MIN) }), weekly: null };
  const stale = render(statusOf([unreadOf('zz-a', { windows: staleWindows, observedAt: iso(NOW - 10 * MIN),
    nextObservationAt: iso(NOW + 2 * MIN) })]));
  assert.equal(lineWith(stale, '    read'), detail('read', '01/15 16:50 JST usage GET - stale, next try 01/15 17:02 JST'));
  const direct = render(statusOf([unreadOf('zz-a', { windows: staleWindows, observedAt: iso(NOW - 10 * MIN),
    nextObservationAt: null })], { source: 'direct' }));
  assert.equal(lineWith(direct, '    read'), detail('read', '01/15 16:50 JST usage GET - stale (no daemon)'));
  assert.equal(lineWith(render(statusOf([unreadOf('zz-a')])), '    read'), undefined, 'nothing read yet, no read line');
});

test('details: an account that was read but reported no window is not called stale', () => {
  const lines = render(statusOf([unreadOf('zz-a', { ordinaryUsageAllowed: true, observedAt: iso(NOW - MIN) })]));
  assert.equal(lineWith(lines, '    read'), detail('read', '01/15 16:59 JST usage GET, ordinary use allowed, sends when unread'));
  const direct = render(statusOf([unreadOf('zz-a', { ordinaryUsageAllowed: true, observedAt: iso(NOW - MIN),
    nextObservationAt: null })], { source: 'direct' }));
  assert.equal(lineWith(direct, '    read'), detail('read', '01/15 16:59 JST usage GET, ordinary use allowed, sends when unread'));
});

test('notes: the held/capped note and the refused note', () => {
  const lines = render(statusOf([heldOf('zz-a', { ordinaryUsageAllowed: false })]));
  assert.ok(lines.includes('  note: held = stopped at our own line, capped = the plan limit itself'));
  assert.ok(lines.includes('  note: refused = the upstream refuses it too; the usage stop is not the only latch'));
  const plain = render(statusOf([accountOf('zz-a')]));
  assert.equal(lineWith(plain, 'note: held'), undefined);
  assert.equal(lineWith(plain, 'note: refused'), undefined);
});

test('notes: the note maps the screen words onto the four states of status --json', () => {
  const lines = render(statusOf([accountOf('zz-a'), heldOf('zz-b'),
    accountOf('zz-c', { stateWord: 'reserved', selectable: false, policy: { ...POLICY, blockWhenUnknown: true } }),
    unreadOf('zz-d'), accountOf('zz-e', { stateWord: 'needs login', selectable: false })]));
  const notes = lines.filter(line => line.includes('in status --json'));
  assert.deepEqual(notes, [
    '  note: held reads as "exhausted" in status --json',
    '  note: reserved / unread read as "unknown" in status --json - not sendable all the same',
    '  note: needs login reads as "login_required" in status --json',
  ]);
});

test('notes: a stale window that has no row of its own is told in a note', () => {
  const lines = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf(),
    weekly: weeklyOf({ fresh: false, observedAt: iso(NOW - 2 * HOUR) }) } })]));
  assert.ok(lines.includes('  note: 7d window on zz-a is stale - last read 60% on 01/15 15:00 JST'));
  assert.equal(lines.filter(line => /^ {21}7d /.test(line)).length, 0, 'the stale window gets no row');
  const position = render(statusOf([accountOf('zz-a', { windows: { fiveHour: windowOf(),
    weekly: weeklyOf({ fresh: false, windowMinutes: null, lengthSource: 'position', observedAt: iso(NOW - 2 * HOUR) }) } })]));
  assert.ok(position.includes('  note: second window on zz-a is stale - last read 60% on 01/15 15:00 JST'));
});

test('notes: what the percentages cover, the CLI share, and that accounts are shown by label', () => {
  const lines = render(statusOf([accountOf('zz-a')]));
  assert.ok(lines.includes('  note: percentages cover the whole account - ChatGPT app, Codex CLI, and any other client'));
  assert.ok(lines.includes("  note: the CLI's own share cannot be separated out"));
  assert.ok(lines.includes('  note: accounts are shown by label'));
});

test('width: with labels up to 20 characters every line stays inside 100 columns', () => {
  const label = 'zz-label-of-twenty-c';
  const lines = render(statusOf([
    heldOf(label, { ordinaryUsageAllowed: false, latch: latchOf({ cleanReadsDone: 1, since: iso(NOW - 3 * DAY) }),
      otherWindows: [windowOf({ windowMinutes: 120, resetAt: iso(NOW + 23 * HOUR + 59 * MIN) })] }),
    unreadOf('zz-b', { reason: 'codex-version-unreadable' }),
  ], { pool: { state: 'mixed', resetAt: iso(NOW + 23 * HOUR + 59 * MIN) },
    events: [{ at: iso(NOW - MIN), type: 'window-cap-dropped', label }] }));
  for (const line of lines) assert.ok(terminalDisplayWidth(line) <= 100, line);
  assert.ok(cardRow(lines, label));
});

// 続きの行（reading の行の11桁・clears などの行の13桁・注記の8桁の字下げで始まる行と、字下げした
// リセット時刻）を前の行へつなぎ、空白の並びを1つにする。
const CONTINUATION = /^( {8}| {11}| {13})\S|^ +reset in /;
const squeeze = line => line.replace(/ +/g, ' ');
function joinContinuations(lines) {
  const joined = [];
  for (const line of lines) {
    if (joined.length > 0 && CONTINUATION.test(line)) joined[joined.length - 1] += ` ${line.trim()}`;
    else joined.push(line);
  }
  return joined.map(squeeze);
}

test('width: a line over 100 columns moves its tail to an indented continuation line', () => {
  const noCreds = label => accountOf(label, { stateWord: 'no creds', selectable: false, reason: 'credentials-unavailable',
    windows: { fiveHour: null, weekly: null }, observedAt: null });
  const unreadable = (top, check) => {
    const status = statusOf([unreadOf('zz-a', { reason: 'codex-version-unreadable' })],
      { pool: { state: 'unknown', resetAt: null }, ...top });
    status.observation.startupCheck = check;
    status.observation.userAgentSource = null;
    return render(status);
  };
  const cases = [
    // 常駐あり、全口座の資格情報が読めない。
    [render(statusOf([noCreds('zz-a'), noCreds('zz-b')], { pool: { state: 'credentials-unavailable', resetAt: null } })), 1, [
      '  reading  usage GET, startup check passed, via daemon',
      '           pool state: credentials-unavailable (0/2 available)']],
    // 常駐なし、版が読めない。
    [unreadable({ source: 'direct' }, null), 1, [
      '  reading  usage GET, direct   pool state: unknown (0/1 available)',
      '           usage read skipped: codex-version-unreadable']],
    // 常駐あり、起動直後の確かめが pending、版が読めない。
    [unreadable({}, 'pending'), 1, [
      '  reading  usage GET, startup check pending, via daemon   pool state: unknown (0/1 available)',
      '           usage read skipped: codex-version-unreadable']],
  ];
  // ラベル20字の no creds の口座の clears の行。
  const clears = render(statusOf([noCreds('zz-label-of-twenty-c')]));
  cases.push([clears, clears.indexOf(lineWith(clears, '    clears')), [
    '    clears   run codex-rotator remove --label zz-label-of-twenty-c,',
    '             then log in again with codex-rotator login']]);
  // 4語が同時にある注記。
  const four = render(statusOf(['no models', 'reserved', 'unread', 'starting'].map((word, index) =>
    accountOf(`zz-${index}`, { stateWord: word, selectable: false }))));
  cases.push([four, four.indexOf(lineWith(four, 'in status --json')), [
    '  note: no models / reserved / unread / starting read as "unknown" in status --json -',
    '        not sendable all the same']]);
  for (const [lines, at, expected] of cases) {
    assert.deepEqual(lines.slice(at, at + expected.length), expected);
    // 1行につないだ形（直す前の形。空白の並びを1つにつめても）は100桁を超える。
    assert.ok(terminalDisplayWidth(joinContinuations(expected)[0]) > 100, expected[0]);
    for (const line of lines) assert.ok(terminalDisplayWidth(line) <= 100, line);
  }
  assert.equal(joinContinuations(cases[3][2])[0], squeeze(detail('clears', formatRemoveGuidance('zz-label-of-twenty-c'))));
});

// 20字のラベル（状態語ごとに1つ。空白は - にして、x で20字まで埋める）。
const label20 = word => `zz-${word.replace(' ', '-')}-`.padEnd(20, 'x');
const LATEST_RESET = iso(NOW + 23 * HOUR + 59 * MIN);

// 状態語ごとに、行が長くなる形の口座（20字のラベル・23h59m 先のリセット・申告の長さ 1h30m の窓・古い週次窓）。
// skip は User-Agent が作れなかった理由で、reserved と unread の口座の reason に入れる。
function widestAccount(word, skip) {
  const latch = latchOf({ cleanReadsDone: 1, since: iso(NOW - 3 * DAY), upstreamBlocked: true });
  const stopped = { reason: 'usage-capped', latch, ordinaryUsageAllowed: false };
  const unknownWindows = { ordinaryUsageAllowed: null, otherWindows: [],
    windows: { fiveHour: windowOf({ usedPercent: 100, fresh: false, observedAt: iso(NOW - 2 * HOUR) }), weekly: null } };
  const noWindows = { windows: { fiveHour: null, weekly: null }, otherWindows: [], observedAt: null };
  const byWord = {
    ready: {},
    held: stopped,
    capped: stopped,
    stopped,
    exhausted: { reason: 'exhausted', resetAt: LATEST_RESET },
    blocked: { reason: 'upstream-blocked', ordinaryUsageAllowed: false },
    'needs login': { reason: 'upstream-unauthorized' },
    'no creds': { reason: 'credentials-unavailable', ...noWindows },
    'no models': { reason: 'model-unassigned' },
    reserved: { reason: skip ?? 'usage-unknown-reserved', ...unknownWindows },
    unread: { reason: skip ?? 'usage-unknown', ...unknownWindows },
    starting: { reason: 'usage-unknown', ordinaryUsageAllowed: null, ...noWindows },
  };
  return accountOf(label20(word), {
    stateWord: word, selectable: word === 'ready',
    policy: { stopUsedPercent: 100, resumeUsedPercent: 90, blockWhenUnknown: word === 'reserved' },
    windows: { fiveHour: windowOf({ usedPercent: 99.6, resetAt: LATEST_RESET }),
      weekly: weeklyOf({ fresh: false, observedAt: iso(NOW - 2 * HOUR) }) },
    otherWindows: [windowOf({ usedPercent: 20, windowMinutes: 90, resetAt: LATEST_RESET })],
    ...byWord[word],
  });
}

test('width: every combination of word, pool state, daemon, start-up check and skipped read stays inside 100 columns and keeps every word', t => {
  // User-Agent の出どころと、作れなかった理由（版が読める・設定の上書き・読取を送らなかった・CLI が無い・版が読めない）。
  const userAgents = [['codex-version', undefined], ['config', undefined], [null, undefined], [null, 'codex-cli-missing'],
    [null, 'codex-version-unreadable']];
  // 12語の口座を全部並べた形と、1語ずつの形。
  const wordSets = [CODEX_STATE_WORDS, ...CODEX_STATE_WORDS.map(word => [word])];
  let combinations = 0;
  let widest = 0;
  for (const pool of CODEX_POOL_STATES) {
    for (const source of ['daemon', 'direct']) {
      for (const check of [null, ...CODEX_STARTUP_CHECKS]) {
        for (const [userAgentSource, skip] of userAgents) {
          for (const words of wordSets) {
            const status = statusOf(words.map(word => widestAccount(word, skip)), { source,
              pool: { state: pool, resetAt: LATEST_RESET }, next: { label: label20('ready'), reason: 'last-resort' },
              events: [{ at: iso(NOW - MIN), type: 'window-cap-dropped', label: label20('held') }] });
            status.observation.startupCheck = check;
            status.observation.userAgentSource = userAgentSource;
            const name = `${pool}/${source}/${check}/${userAgentSource}/${skip}/${words.join('+')}`;
            const lines = render(status);
            combinations++;
            for (const line of lines) {
              widest = Math.max(widest, terminalDisplayWidth(line));
              assert.ok(terminalDisplayWidth(line) <= 100, `${name}: ${line}`);
            }
            // 続きの行へ移した語・数・理由が欠けていない。
            const joined = joinContinuations(lines);
            const parts = ['usage GET', ...(check === null ? [] : [`startup check ${check}`]),
              source === 'daemon' ? 'via daemon' : 'direct'];
            const skipped = userAgentSource === null && skip !== undefined
              && words.some(word => word === 'reserved' || word === 'unread');
            const { accountsAvailable, accountsTotal } = status.aggregate;
            assert.equal(joined[1], squeeze(`  reading  ${parts.join(', ')}   pool state: ${pool} `
              + `(${accountsAvailable}/${accountsTotal} available)${skipped ? `   usage read skipped: ${skip}` : ''}`), name);
            for (const word of words) {
              const label = label20(word);
              assert.ok(cardRow(lines, label).startsWith(`  ${label} ${terminalPadEnd(word, 9)}`), `${name}: ${word}`);
              const state = CODEX_STATE_OF_WORD[word];
              if (state !== 'available' && state !== word) {
                assert.ok(joined.some(line => line.includes('in status --json') && line.includes(word)
                  && line.includes(`as "${state}"`)), `${name}: ${word} in the note`);
              }
            }
            for (const [word, guidance] of [['needs login', formatReloginGuidance], ['no creds', formatRemoveGuidance]]) {
              if (words.includes(word)) assert.ok(joined.includes(squeeze(detail('clears', guidance(label20(word))))), `${name}: ${word}`);
            }
            // 申告の長さ 1h30m の窓の行は、続きの行へ移したリセット時刻ごとそろっている。
            const shortWindows = joined.filter(line => line.includes(' 1h30m '));
            assert.equal(shortWindows.length, words.filter(word => widestAccount(word).otherWindows.length > 0).length, name);
            for (const line of shortWindows) assert.ok(line.endsWith(' reset in 23h59m -> 01/16 16:59 JST'), `${name}: ${line}`);
            if (words.length === CODEX_STATE_WORDS.length) {
              assert.ok(joined.includes(squeeze('  note: no models / reserved / unread / starting read as "unknown" in status --json'
                + ' - not sendable all the same')), name);
            }
          }
        }
      }
    }
  }
  assert.equal(combinations, CODEX_POOL_STATES.length * 2 * 4 * userAgents.length * wordSets.length);
  t.diagnostic(`combinations ${combinations}, widest line ${widest} columns`);
});

test('latch, next and effective: the summary lines under the reading line', () => {
  assert.equal(render(statusOf([accountOf('zz-a')]))[2], '  latch    known (daemon)');
  assert.equal(render(statusOf([unreadOf('zz-a')], { source: 'direct' }))[2], '  latch    unknown (no daemon)');
  assert.equal(render(statusOf([accountOf('zz-a')], { next: { label: 'zz-a', reason: 'selectable' } }))[3], '  next:    zz-a');
  assert.equal(render(statusOf([unreadOf('zz-a')], { next: { label: 'zz-a', reason: 'last-resort' } }))[3],
    '  next:    zz-a (last resort)');
  assert.equal(render(statusOf([heldOf('zz-a')]))[3], '  next:    none');
  // 実効残量の境界：A が ready（40%・60%）、B が capped で、C が unread のときと C が無いとき。
  const capped = accountOf('zz-b', { stateWord: 'capped', selectable: false, reason: 'usage-capped', latch: latchOf(),
    policy: { stopUsedPercent: 100, resumeUsedPercent: 90, blockWhenUnknown: false } });
  assert.equal(render(statusOf([accountOf('zz-a'), capped, unreadOf('zz-c')]))[4], '  effective  unknown (≥15 pts, 1 unknown)');
  assert.equal(render(statusOf([accountOf('zz-a'), capped]))[4], '  effective  15 pts');
});

test('events: the newest eight events are listed, newest first', () => {
  const events = Array.from({ length: 10 }, (_, index) => ({ at: iso(NOW - (10 - index) * MIN), type: 'selected',
    label: index % 2 === 0 ? 'zz-a' : null }));
  const lines = render(statusOf([accountOf('zz-a')], { events }));
  const start = lines.indexOf('  events');
  assert.ok(start > 0);
  assert.deepEqual(lines.slice(start + 1, start + 3), ['    01/15 16:59 JST selected', '    01/15 16:58 JST selected zz-a']);
  assert.equal(lines.filter(line => line.startsWith('    01/15') && line.includes('selected')).length, 8);
  assert.equal(lineWith(render(statusOf([accountOf('zz-a')])), '  events'), undefined, 'no events, no block');
});
