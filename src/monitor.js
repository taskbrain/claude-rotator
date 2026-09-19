import { NEEDS_LOGIN_AVAILABILITY_STATE, isAuthExpiredReason } from './account-manager.js';
import { sanitizeAccountLabel } from './degrade-state.js';

export function progressBar(ratio, width = 10) {
  if (ratio == null || Number.isNaN(Number(ratio))) return '-'.repeat(width);
  const normalized = Math.max(0, Math.min(1, Number(ratio)));
  const filled = Math.floor(normalized * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d${restHours}h` : `${days}d`;
}

const JAPAN_TIME_OFFSET_MS = 9 * 60 * 60 * 1000;
const JAPAN_TIME_LABEL = 'JST';
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const ZERO_WIDTH_CHARACTER = /[\p{Mark}\p{Control}\p{Format}]/u;

export function renderStatus(status, options = {}) {
  const now = options.now ?? Date.now();
  const columns = terminalColumns(options.columns);
  const lines = [];
  const active = status.currentAccountName || status.currentAccount || '(none)';
  lines.push(`Claude Rotator                         current: ${active}`);
  lines.push('');
  lines.push(...renderRoutingAvailability(status, now, columns));
  lines.push('');

  const cards = (status.accounts || []).map(account => renderAccountCard(account, status, now));
  lines.push(...renderAccountCards(cards, columns));
  if (cards.length > 0) lines.push('');

  // Codex section (design doc 9.6). It is drawn only when the caller passed codex
  // data; without it nothing is appended and the output stays byte-identical.
  lines.push(...renderCodexSection(options.codex, now));

  // Session affinity section (sticky design 7.3). Drawn only when the status JSON
  // carries the section, which /internal/status omits entirely while the mode is
  // "off" - so the default configuration prints exactly what it prints today.
  lines.push(...renderAffinitySection(status.sessionAffinity));

  lines.push('Events');
  for (const event of (status.events || []).slice(0, 8)) {
    lines.push(renderEvent(event));
  }

  return `${lines.join('\n')}\n`;
}

function terminalColumns(value) {
  const parsed = Number(value ?? process.stdout.columns);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
}

function renderRoutingAvailability(status, now, columns) {
  const fable = status.routingAvailability?.fable;
  const other = status.routingAvailability?.other;
  const noAccounts = (status.accounts || []).length === 0;
  const fableBlock = renderAvailabilityBlock('Fable', fable, now, noAccounts);
  const otherBlock = renderAvailabilityBlock(
    'Other (Sonnet / Opus / Haiku)',
    other,
    now,
    noAccounts,
  );
  const sideBySide = renderBlocksSideBySide(fableBlock, otherBlock, columns);
  return [
    'Routing availability',
    ...(sideBySide || [...fableBlock, '', ...otherBlock]),
  ];
}

function renderAvailabilityBlock(label, schedule, now, noAccounts) {
  const summary = availabilitySummary(schedule, noAccounts);
  const lines = [`${label} (${summary})`];
  if (!Array.isArray(schedule)) return lines;
  for (const [index, entry] of schedule.entries()) {
    lines.push(`  ${index + 1}. ${entry.accountName || entry.account || '(unknown)'}  ${renderAvailability(entry, now, true)}`);
  }
  return lines;
}

function availabilitySummary(schedule, noAccounts) {
  if (!Array.isArray(schedule)) return 'no data';
  if (schedule.length === 0) return noAccounts ? 'no accounts' : 'no data';
  const available = schedule.filter(entry => entry?.state === 'available').length;
  return available > 0 ? `${available} now` : 'none now';
}

function renderAvailability(entry, now, includeDate = false) {
  if (!entry) return 'no data';
  if (entry.state === 'available') return 'now';
  // An expired login never recovers on its own, so "unknown" would be misleading
  // (design ruling D-72): say what is actually wrong and leave the how-to-fix
  // line to the account card, which knows the account id.
  if (entry.state === NEEDS_LOGIN_AVAILABILITY_STATE) return 'needs login';
  if (entry.state !== 'waiting') return 'unknown';
  const availableAt = Date.parse(entry.availableAt || '');
  if (!Number.isFinite(availableAt) || availableAt <= now) return 'unknown';
  const duration = formatDuration(availableAt - now);
  return includeDate ? `in ${duration} -> ${formatDate(availableAt)}` : duration;
}

function renderAccountCard(account, status, now) {
  const lines = [`${terminalPadEnd(account.name, 26)} ${account.status}`];
  const fable = findAccountAvailability(status.routingAvailability?.fable, account.id);
  const other = findAccountAvailability(status.routingAvailability?.other, account.id);
  lines.push(`routes Fable: ${renderAvailability(fable, now)} | Other: ${renderAvailability(other, now)}`);
  const reason = renderUnavailableReason(account.unavailableReason, account.id);
  if (reason) lines.push(`reason: ${reason}`);
  lines.push(renderQuotaRow('5h', account.quota?.unified5h, account.quota?.unified5hReset, now));
  lines.push(renderQuotaRow('7d', account.quota?.unified7d, account.quota?.unified7dReset, now));
  for (const limit of account.quota?.weeklyScoped || []) {
    lines.push(renderQuotaRow(`7d ${limit.label || limit.key || 'scoped'}`, limit.utilization, limit.resetAt, now));
  }
  lines.push(`requests: ${account.usage?.totalRequests ?? 0}`);
  return lines;
}

function findAccountAvailability(schedule, accountId) {
  if (!Array.isArray(schedule)) return null;
  return schedule.find(entry => entry?.account === accountId) || null;
}

function renderAccountCards(cards, columns) {
  if (cards.length === 0) return [];
  const cardWidth = Math.max(...cards.flatMap(card => card.map(terminalDisplayWidth)));
  if (cards.length < 2 || cardWidth * 2 + 3 > columns) {
    return cards.flatMap((card, index) => index === 0 ? card : ['', ...card]);
  }

  const lines = [];
  for (let index = 0; index < cards.length; index += 2) {
    if (index > 0) lines.push('');
    const right = cards[index + 1];
    if (!right) {
      lines.push(...cards[index]);
      continue;
    }
    lines.push(...joinBlocks(cards[index], right, cardWidth));
  }
  return lines;
}

function renderBlocksSideBySide(left, right, columns) {
  const leftWidth = Math.max(...left.map(terminalDisplayWidth));
  const rightWidth = Math.max(...right.map(terminalDisplayWidth));
  if (leftWidth + 3 + rightWidth > columns) return null;
  return joinBlocks(left, right, leftWidth);
}

function joinBlocks(left, right, leftWidth) {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const leftLine = left[index] || '';
    const rightLine = right[index] || '';
    return rightLine ? `${terminalPadEnd(leftLine, leftWidth)}   ${rightLine}` : leftLine;
  });
}

function terminalPadEnd(value, width) {
  const text = String(value);
  return `${text}${' '.repeat(Math.max(0, width - terminalDisplayWidth(text)))}`;
}

function terminalDisplayWidth(value) {
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(String(value))) {
    width += terminalGraphemeWidth(segment);
  }
  return width;
}

function terminalGraphemeWidth(segment) {
  if (EMOJI_GRAPHEME.test(segment) || segment.includes('\uFE0F')) return 2;
  for (const character of segment) {
    if (ZERO_WIDTH_CHARACTER.test(character)) continue;
    return isFullWidthCodePoint(character.codePointAt(0)) ? 2 : 1;
  }
  return 0;
}

function isFullWidthCodePoint(codePoint) {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function renderQuotaRow(label, ratio, resetAt, now) {
  const percent = ratio == null ? ' --%' : `${Math.round(ratio * 100).toString().padStart(3)}%`;
  const reset = resetAt ? `  reset in ${formatDuration(resetAt - now)} -> ${formatDate(resetAt)}` : '  no data yet';
  return `${label} ${progressBar(ratio, 10)} ${percent}${reset}`;
}

function renderEvent(event) {
  const at = formatEventTime(event.at);
  if (event.type === 'auto-switch') {
    return `${at} switched ${event.from || '(none)'} -> ${event.to} reason=${event.reason || 'quota-threshold'}`.trim();
  }
  if (event.type === 'fallback-switch') {
    return `${at} fallback ${event.from || '(none)'} -> ${event.to} reason=${event.reason || 'shortest-quota-reset'}`.trim();
  }
  if (event.type === 'manual-switch') {
    return `${at} manual switch -> ${event.account}`.trim();
  }
  if (event.type === 'proxy-request') {
    const status = event.statusCode ?? '-';
    const requestId = event.requestId ? ` req=${event.requestId}` : '';
    const errorType = event.errorType ? ` error=${event.errorType}` : '';
    return `${at} request ${event.account || ''} ${event.method || ''} ${event.path || ''} -> ${status} ${event.durationMs ?? 0}ms outcome=${event.outcome || 'unknown'}${requestId}${errorType}`.trim();
  }
  if (event.type === 'upstream-error') {
    const reason = renderUnavailableReason(event.reason, event.account);
    return `${at} upstream error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'quota-exhausted') {
    const reason = renderUnavailableReason(event.reason, event.account);
    return `${at} quota exhausted ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'account-error') {
    const reason = renderUnavailableReason(event.reason, event.account);
    return `${at} account error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  return `${at} ${event.type || 'event'}`.trim();
}

function renderUnavailableReason(reason, accountId = null) {
  if (!reason) return null;
  // Design ruling D-72: an expired login is the one unavailable reason a human
  // has to clear, so the screen says what to run instead of leaking the internal
  // reason type (`oauth_refresh_failed` / `authentication_error`).
  if (isAuthExpiredReason(reason)) {
    const target = typeof accountId === 'string' && accountId.length > 0 ? ` --id ${accountId}` : '';
    return `login expired${renderAuthFailureDetail(reason)} - run: claude-rotator login${target}`;
  }
  if (reason.type === 'quota_exhausted') {
    const reset = reason.resetAt ? `; reset -> ${formatDate(Date.parse(reason.resetAt))}` : '';
    return `${reason.window} quota exhausted${reset}`;
  }
  if (reason.type === 'temporary_throttle') {
    const retry = reason.retryAt ? `; retry -> ${formatDate(Date.parse(reason.retryAt))}` : '';
    return `temporary throttle${retry}`;
  }
  if (reason.type === 'temporary_upstream_error' || reason.type === 'temporary_upstream_timeout') {
    const retry = reason.retryAt ? `; retry -> ${formatDate(Date.parse(reason.retryAt))}` : '';
    const status = reason.statusCode ? ` ${reason.statusCode}` : '';
    return `${reason.type}${status}${retry}`;
  }
  if (reason.message) return `${reason.type}: ${reason.message}`;
  return reason.type;
}

/**
 * The ` (cause=...; detected MM/DD HH:MM JST)` fragment appended to the expired
 * login line.
 *
 * It says "detected" deliberately: this is when the rotator saw the credential
 * fail, NOT when the credential itself expired. The two differ whenever the
 * failure surfaces late - a parked account is only rechecked on the next usage
 * poll - so wording such as "expired at" would be read as an actual expiry time
 * the rotator does not know.
 *
 * Both fields are optional. A reason restored from a state file written before
 * they existed carries neither, and then this returns an empty string so the
 * line is byte-identical to what it printed before.
 */
function renderAuthFailureDetail(reason) {
  const detail = [];
  if (typeof reason.cause === 'string' && reason.cause.length > 0) {
    detail.push(`cause=${reason.cause}`);
  }
  const detectedAt = Date.parse(reason.at || '');
  if (Number.isFinite(detectedAt)) detail.push(`detected ${formatDate(detectedAt)}`);
  return detail.length > 0 ? ` (${detail.join('; ')})` : '';
}

function formatDate(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts + JAPAN_TIME_OFFSET_MS);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi} ${JAPAN_TIME_LABEL}`;
}

function formatEventTime(value) {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return formatDate(parsed);
}

// ---------------------------------------------------------------------------
// Codex section of `claude-rotator status` (design doc 9.6 / 13.3).
//
// `options.codex` is produced by the CLI and is one of:
//   null / undefined      no codexStatusUrl is configured, nothing is drawn
//   { ok: false, reason } the health fetch failed, one line is drawn
//   { ok: true, health }  the codex-rotator health JSON
//
// The health JSON is written by another process, so it is treated as hostile
// input: `contract`, `pool.state` and the `pool.accounts` array are required and
// anything else degrades to the single "codex: unreachable (invalid payload)"
// line, every optional key is drawn only when present, an unknown `contract`
// version is never an error, and the whole block is wrapped in a guard so that a
// broken payload can only cost this section - never the Claude side of the screen.
// Only `label` and `state` are ever drawn, and `label` must match the contract
// pattern, so an email address in the payload can never reach a status screen
// that operators paste into reports.

const CODEX_SECTION_LABEL = 'Codex Rotator';
// Same column as the `current:` field of the Claude Rotator header line.
const CODEX_HEADER_WIDTH = 39;
// Legacy layout only. The detailed layout sizes its label column from the labels
// it was actually handed, so a pool of short labels is not padded out to 20.
const CODEX_LABEL_WIDTH = 20;
const CODEX_LABEL_MIN_WIDTH = 8;
// The contract's own bound on a label (degrade-state.js: `^[a-z0-9][a-z0-9_-]{0,31}$`).
// The column stretches that far rather than stopping short: terminalPadEnd() does not
// truncate, so a narrower cap would not keep a long label inside the width budget - it
// would only push that one row's bar out of line with every other row, including the
// second-window row drawn directly underneath it. Truncating instead is worse still:
// the label is the only handle an operator has for matching a row against /healthz.
const CODEX_LABEL_MAX_WIDTH = 32;
const CODEX_STATE_WIDTH = 9;
const CODEX_STOP_WIDTH = 9;
const CODEX_DETAIL_KEY_WIDTH = 9;
const CODEX_WINDOW_WIDTH = 2;
const CODEX_BAR_WIDTH = 10;
// The screen is pasted into reports and chat, so codex lines stay inside 100
// columns for labels up to 20 characters. The contract allows 32, and a label
// longer than 20 widens its rows by the difference - see CODEX_LABEL_MAX_WIDTH.
// Only the pool header can grow without bound (one count per state word), and it
// drops its breakdown rather than run over.
const CODEX_MAX_WIDTH = 100;
// codex-account-pool.js RESUME_CONFIRMATIONS. A stop is a latch: only that many
// qualifying observations clear it, never elapsed time and never a window reset.
const CODEX_RESUME_CONFIRMATIONS = 2;
// Slack subtracted when this process's start instant is reconstructed from
// `uptimeSec`, so the reconstruction always lands at or before the true start.
// Two errors push the reconstruction the other way and both are one-directional:
// the bridge floors uptimeSec to whole seconds (up to 999ms late - undone by the
// +1s in codexProcessStartedAt), and `now` here is the instant the screen is
// drawn rather than the instant /healthz was fetched, because the CLI passes no
// `now` - so the fetch-to-draw wait is added on top of it. A startup usage GET,
// measured at 460-604ms on this bridge, can latch a stop inside that gap, and
// refusing exactly such a latch is what the check in codexSinceText() is for.
// The cost of the slack is only this: a stop that began in the few seconds
// before the process started is not dated either.
const CODEX_UPTIME_SLACK_MS = 5000;
const CODEX_INVALID_PAYLOAD = 'invalid payload';
const CODEX_UNKNOWN_LABEL = '(unknown)';
// The states that mean "this account is stopped at a usage line" - the ones the
// `<state> since ...` line and the held/capped note are about.
const CODEX_STOPPED_WORDS = new Set(['held', 'capped', 'stopped']);
// The one payload word that reads as permission to send. An account can carry it
// while being withheld, so a note that maps a row onto it has to say so.
const CODEX_PAYLOAD_SENDABLE_WORD = 'ready';
// The same character class terminalGraphemeWidth() skips when measuring width.
// Here the characters are removed instead of skipped: these strings come from
// another process, so they must not be able to move the cursor or hide text.
const CODEX_UNSAFE_CHARACTERS = new RegExp(ZERO_WIDTH_CHARACTER.source, 'gu');

function renderCodexSection(codex, now) {
  if (!codex || typeof codex !== 'object') return [];
  try {
    if (codex.ok !== true) return renderCodexUnreachable(codex.reason);
    return renderCodexHealth(codex.health, now) || renderCodexUnreachable(CODEX_INVALID_PAYLOAD);
  } catch {
    // A payload that throws while being read (a getter that raises, a label whose
    // toString is null) must not take the status screen down with it.
    return renderCodexUnreachable(CODEX_INVALID_PAYLOAD);
  }
}

function renderCodexUnreachable(reason) {
  const text = `codex: unreachable (${codexText(reason, 'no data')})`;
  return [`${terminalPadEnd(CODEX_SECTION_LABEL, CODEX_HEADER_WIDTH)}${text}`, ''];
}

// Returns null when the payload lacks the keys the contract makes mandatory
// (design doc 13.3: `contract`, `pool.state`, `accounts`), so the caller can fall
// back to the one-line form instead of drawing a half-empty section.
//
// The mandatory set is frozen on purpose: the detailed layout below reads a dozen
// further keys, and adding any of them here would make an older codex-rotator's
// payload - which reports none of them - vanish from the screen entirely. A
// payload without them degrades one layout, never the whole section. `uptimeSec`
// is read here too and is deliberately not in the set: a payload without it loses
// one line (codexSinceText), not the Codex section.
function renderCodexHealth(health, now) {
  if (!health || typeof health !== 'object' || Array.isArray(health)) return null;
  if (health.contract === undefined || health.contract === null) return null;
  const pool = health.pool;
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return null;
  if (typeof pool.state !== 'string' || !Array.isArray(pool.accounts)) return null;

  const detailed = codexSelectionReported(pool.accounts);
  const views = detailed ? pool.accounts.map(account => codexAccountView(account, pool)) : [];
  // `uptimeSec` sits at the root of the payload, next to `pool`, never on an
  // account. This is the last frame that still holds the root, so it is read here
  // and handed to the one line that needs it - see codexSinceText().
  const startedAt = codexProcessStartedAt(health, now);
  const lines = detailed
    ? renderCodexDetailedBlock(pool, views, now, startedAt)
    : renderCodexLegacyBlock(pool, now);
  lines.push(...renderCodexNotes(pool, views, detailed));
  lines.push('');
  return lines;
}

// True when at least one account reports why the rotator would or would not pick
// it. Without that the detailed layout could only guess, so the legacy layout is
// drawn instead: an older screen is honest, an invented one is not.
function codexSelectionReported(accounts) {
  return accounts.some(account => account !== null && typeof account === 'object'
    && (account.selectionEligible !== undefined
      || account.selectionBlockReason !== undefined
      || account.stopUsedPercent !== undefined));
}

// ---------------------------------------------------------------------------
// Detailed layout.
//
// The one thing this layout exists to stop being misread: a stopped account does
// NOT come back when its window resets. codex-account-pool.js keeps the stop as a
// latch that only a qualifying usage reading clears. So the reset instant is
// printed as `reset` (the window), never as a recovery time, the word `cooldown`
// is not used at all, and the line directly under the reset instant opens with
// the denial - `clears  not at that reset - ...`.
// ---------------------------------------------------------------------------

function renderCodexDetailedBlock(pool, views, now, startedAt) {
  const columns = codexColumns(views);
  const lines = [renderCodexSendableHeader(views)];
  lines.push(renderCodexReadingLine(pool));
  for (const view of views) lines.push(...renderCodexAccountBlock(view, columns, now, startedAt));
  return lines;
}

function codexColumns(views) {
  const widest = views.reduce((width, view) => Math.max(width, terminalDisplayWidth(view.label)), 0);
  return {
    label: Math.min(Math.max(widest, CODEX_LABEL_MIN_WIDTH), CODEX_LABEL_MAX_WIDTH),
    window: views.some(view => view.windowMins != null),
    stop: views.some(view => view.stop != null),
  };
}

// `sendable N/M` is counted from selectionEligible, and the breakdown from the
// very same state words the rows print, so the header can never disagree with
// the rows underneath it.
function renderCodexSendableHeader(views) {
  const sendable = views.filter(view => view.eligible).length;
  const counts = new Map();
  for (const view of views) {
    if (!view.word || view.word === 'ready') continue;
    counts.set(view.word, (counts.get(view.word) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([word, count]) => `${word} ${count}`).join(', ');
  const head = `${terminalPadEnd(CODEX_SECTION_LABEL, CODEX_HEADER_WIDTH)}sendable ${sendable}/${views.length}`;
  if (!breakdown) return head;
  const full = `${head}  (${breakdown})`;
  return terminalDisplayWidth(full) <= CODEX_MAX_WIDTH ? full : head;
}

// How the numbers were obtained, and the raw pool word they were derived from -
// the one place the screen still shows the vocabulary /healthz actually uses.
function renderCodexReadingLine(pool) {
  const observation = pool.observation;
  const parts = [];
  if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
    const source = codexSourceText(observation.source);
    if (source) parts.push(source);
    const gate = codexText(observation.gate, '');
    if (gate) parts.push(`startup check ${gate}`);
  }
  const head = parts.length > 0 ? `${parts.join(', ')}   ` : '';
  return `  ${terminalPadEnd('reading', CODEX_DETAIL_KEY_WIDTH)}${head}raw pool state: ${codexText(pool.state, 'unknown')}`;
}

function renderCodexAccountBlock(view, columns, now, startedAt) {
  const reset = codexResetClause(view.resetAt, now);
  const lines = [codexGridLine(columns, {
    label: view.label,
    word: view.word,
    windowMins: view.windowMins,
    percent: view.percent,
    fresh: view.fresh,
    stale: view.percent != null && !view.fresh,
    stop: view.stopText,
    reset,
  })];

  if (view.secondaryFresh) {
    lines.push(codexGridLine(columns, {
      windowMins: view.secondaryWindowMins,
      percent: view.secondaryPercent,
      fresh: true,
      reset: codexResetClause(view.secondaryResetAt, now),
    }));
  }

  if (view.word === 'ready' && view.fresh) return lines;

  const clears = codexClearsText(view, reset !== '');
  if (clears) lines.push(codexDetailLine('clears', clears));
  const refused = codexRefusedText(view);
  if (refused) lines.push(codexDetailLine('refused', refused));
  const since = codexSinceText(view, now, startedAt);
  if (since) lines.push(codexDetailLine(view.word, since));
  const read = codexReadText(view);
  if (read) lines.push(codexDetailLine('read', read));
  return lines;
}

// One column grid for both the account row and the second-window row underneath
// it, so the bar and the percentage of a second window sit directly below the
// ones they belong to. Trailing padding is always removed.
function codexGridLine(columns, cells) {
  let line = `  ${terminalPadEnd(cells.label ?? '', columns.label)}`;
  line += ` ${terminalPadEnd(cells.word ?? '', CODEX_STATE_WIDTH)}`;
  if (columns.window) line += ` ${codexWindowLabel(cells.windowMins).padStart(CODEX_WINDOW_WIDTH)}`;
  const ratio = cells.fresh && cells.percent != null ? cells.percent / 100 : null;
  line += ` ${progressBar(ratio, CODEX_BAR_WIDTH)}`;
  line += ` ${codexPercent(cells.percent)}${cells.stale ? '*' : ' '}`;
  if (columns.stop) line += ` ${terminalPadEnd(cells.stop ?? '', CODEX_STOP_WIDTH)}`;
  line += `  ${cells.reset ?? ''}`;
  return line.replace(/ +$/, '');
}

function codexDetailLine(key, text) {
  return `    ${terminalPadEnd(key, CODEX_DETAIL_KEY_WIDTH)}${text}`.replace(/ +$/, '');
}

// What actually clears the stop. Never a time: `not at that reset` when the row
// carries a reset instant, `not when the window resets` when it does not (right
// after a reset the instant is in the past and is no longer drawn, and "that
// reset" would then point at nothing).
function codexClearsText(view, hasReset) {
  const denial = hasReset ? 'not at that reset' : 'not when the window resets';
  switch (view.word) {
    case 'held':
    case 'capped':
      if (view.resume == null) {
        return `${denial} - needs ${CODEX_RESUME_CONFIRMATIONS} clean usage reads below the line that stopped it`;
      }
      if (view.resumeStreak != null && view.resumeStreak > 0) {
        return `${view.resumeStreak} of ${CODEX_RESUME_CONFIRMATIONS} clean reads done`
          + ` - needs ${codexRound(view.resume)}% or less, ${denial}`;
      }
      return `${denial} - needs ${CODEX_RESUME_CONFIRMATIONS} clean usage reads at ${codexRound(view.resume)}% or less`;
    case 'stopped':
      // No usage policy: codex-account-pool.js clears these on a single reading.
      return `${denial} - needs a usage read below the rotator's own limit`;
    case 'reserved':
      return 'needs one complete usage read; this account will not send while unread';
    case 'unread':
      return 'needs one complete usage read';
    case 'exhausted':
      return hasReset
        ? 'after that reset, once the rotator rechecks this account (429 seen)'
        : 'once the rotator rechecks this account (429 seen)';
    case 'blocked':
      return 'the upstream refuses ordinary use; needs a read that says otherwise';
    default:
      return '';
  }
}

// A usage stop and an upstream refusal are two latches, and the same reading has
// to clear both: codex-account-pool.js raises the refusal on any complete GET the
// upstream answered with ordinary usage disallowed, and makes
// `ordinaryUsageAllowed === true` part of every recovery vote. Its block reason
// names the usage stop first, so an account that is refused outright still shows
// up here as `held` - the word for "we stopped it at our own line". Lowering that
// line, or waiting for the percentage to fall, would then change nothing at all,
// which is why the refusal is printed as its own condition directly under the
// `clears` line that would otherwise read as the whole story.
//
// Only the policy-driven words get this line. An account with no usage policy
// takes the legacy release path, where a single reading below the global
// threshold clears its latches - the refusal among them - so naming the upstream
// as a second condition there would overstate what it takes to recover.
function codexRefusedText(view) {
  if (view.ordinaryUsageAllowed !== false) return '';
  if (view.word !== 'held' && view.word !== 'capped') return '';
  return 'the upstream refuses ordinary use too - those reads must say otherwise';
}

// How long the account has been stopped - drawn only when the payload can support
// that claim.
//
// `cappedSince` is a lower bound, not a measurement (codex-manager.js: "少なくとも
// この時刻から止まっている"). The bridge keeps the latch time in a process-local Map
// with nothing on disk behind it, so a restart does not clear the field: the pool
// starts empty and the first usage read at or above the stop line re-stamps it
// (`entry.cappedSince ??= nowMs`). The same account, stopped since the 15th and
// never released, then publishes a timestamp minutes old - and this line, which
// exists so that a hold going long gets noticed, would say the opposite of the
// truth in the only direction that matters.
//
// Nothing in the payload distinguishes a re-stamp from a real one, so the contract
// asks the consumer to compare it against `uptimeSec` from the root of /healthz and
// to refuse the value when `cappedSince >= now - uptimeSec * 1000`. That is what
// `startedAt` is: the instant this bridge process began. A latch that predates it
// cannot have been re-stamped by it, and only that case is dated here.
//
// Everything else draws nothing, which is what this screen already does for a
// payload carrying no cappedSince at all - the same state of knowledge, since a
// bound that only says "at some point after this process booted" answers neither
// "how long" nor "long enough to act on". An `at least ... (3m+)` form was the
// alternative; it keeps a number on screen that no reader can act on, and the one
// `+` carrying "possibly ten days" is the whole difference between it and a lie.
//
// NOT REACHED IN PRODUCTION TODAY (坂根氏判断 2026-09-17). The deployed bridge does
// not publish `cappedSince` at all: the field was withdrawn because the latch time
// lives only in a process-local Map, so every restart re-stamps it and this guard
// would then refuse every value it was handed - the line would never be drawn while
// still pretending to be live. The receiving, drawing and guarding code is kept here
// on purpose. It becomes live with no change to this file on the day the bridge
// persists the latch across restarts and publishes the field again, which is
// scheduled after the account-rotation effect measurement ending at the primary
// reset of 2026-09-21 20:59 JST.
function codexSinceText(view, now, startedAt) {
  if (view.cappedSince == null || !CODEX_STOPPED_WORDS.has(view.word)) return '';
  if (startedAt == null || view.cappedSince >= startedAt) return '';
  // Past that guard `cappedSince < startedAt <= now - CODEX_UPTIME_SLACK_MS`, so the
  // elapsed time is at least the slack and formatDuration() can never return 'now'.
  return `since ${formatDate(view.cappedSince)} (${formatDuration(now - view.cappedSince)})`;
}

// When this bridge process started, from `uptimeSec` at the root of the health
// payload - reconstructed deliberately EARLY rather than accurately, so that the
// comparison above can only ever err towards drawing nothing. null - a payload that
// omits it, or reports something that is not a usable number of seconds - means the
// check above cannot be made, and the caller then withholds rather than guesses. It
// is never an error: an older bridge, or a truncated payload, must cost one line and
// no more.
function codexProcessStartedAt(health, now) {
  const uptimeSec = codexNumber(health.uptimeSec);
  if (uptimeSec == null || uptimeSec < 0) return null;
  // +1s undoes the bridge's floor to whole seconds; the slack covers the rest of the
  // one-directional error described at CODEX_UPTIME_SLACK_MS.
  return now - (uptimeSec + 1) * 1000 - CODEX_UPTIME_SLACK_MS;
}

// When the numbers were read, and what the reading itself said. A stale reading
// says so and names the next attempt, so a frozen percentage is never mistaken
// for a current one. The source is named only when it can be this reading's:
// the payload reports one source per account, taken from whichever window was
// read last, so on an account whose second window was read more recently it
// describes the other reading. The date then stands on its own rather than
// carrying a source that may not belong to it.
function codexReadText(view) {
  if (view.observedAt == null) return '';
  const source = view.sourceDescribesPrimary ? codexSourceText(view.source) : '';
  const head = `${formatDate(view.observedAt)}${source ? ` ${source}` : ''}`;
  if (!view.fresh) {
    const next = view.nextObservationAt == null ? '' : `, next try ${formatDate(view.nextObservationAt)}`;
    return `${head} - stale${next}`;
  }
  const parts = [];
  if (view.ordinaryUsageAllowed === true) parts.push('ordinary use allowed');
  if (view.ordinaryUsageAllowed === false) parts.push('ordinary use refused');
  if (view.blockWhenUnknown === true) parts.push('stops when unread');
  if (view.blockWhenUnknown === false) parts.push('sends when unread');
  return parts.length > 0 ? `${head}, ${parts.join(', ')}` : head;
}

// ---------------------------------------------------------------------------
// Legacy layout: byte for byte what this section printed before the detailed
// layout existed, for a codex-rotator that reports no selection fields.
// ---------------------------------------------------------------------------

function renderCodexLegacyBlock(pool, now) {
  const lines = [renderCodexPoolHeader(pool, now)];
  for (const account of pool.accounts) lines.push(renderCodexAccountRow(account, now));
  return lines;
}

function renderCodexPoolHeader(pool, now) {
  const available = codexNumber(pool.accountsAvailable);
  const total = codexNumber(pool.accountsTotal);
  const counts = available == null || total == null ? '' : ` (${available}/${total} available)`;
  const state = codexText(pool.state, 'unknown');
  const reset = codexResetClause(codexTimestamp(pool.resetAt), now);
  return `${terminalPadEnd(CODEX_SECTION_LABEL, CODEX_HEADER_WIDTH)}pool: ${state}${counts}${reset ? `  ${reset}` : ''}`;
}

function renderCodexAccountRow(account, now) {
  const source = account && typeof account === 'object' ? account : {};
  const primary = codexNumber(source.primaryUsedPercent);
  const secondary = codexNumber(source.secondaryUsedPercent);
  const windowMins = codexNumber(source.windowDurationMins);
  // The health JSON never promises a fixed window (design doc 13.3): the label is
  // derived from windowDurationMins when it is there and omitted when it is not.
  const window = windowMins == null || windowMins <= 0 ? '' : ` (${formatDuration(windowMins * 60000)})`;
  const state = codexText(source.state, '');
  const reset = codexResetClause(codexTimestamp(source.resetAt), now);
  return `  ${terminalPadEnd(codexLabel(source.label), CODEX_LABEL_WIDTH)} ${progressBar(primary == null ? null : primary / 100, 10)}`
    + ` ${codexPercent(primary)}${secondary == null ? '' : ` 2nd ${codexPercent(secondary)}`}${window}`
    + `${state ? `  ${state}` : ''}${reset ? `  ${reset}` : ''}`;
}

// ---------------------------------------------------------------------------
// Notes.
// ---------------------------------------------------------------------------

function renderCodexNotes(pool, views, detailed) {
  const lines = [];
  if (detailed) {
    const words = new Set(views.map(view => view.word));
    if (words.has('held') || words.has('capped')) {
      lines.push('  note: held = stopped at our own line, capped = the plan limit itself');
    }
    if (views.some(view => codexRefusedText(view) !== '')) {
      lines.push('  note: refused = the upstream refuses it too; the usage stop is not the only latch');
    }
    lines.push(...renderCodexPayloadWordNotes(views));
    for (const view of views) {
      const note = codexStaleSecondaryNote(view);
      if (note) lines.push(note);
    }
  }
  const observation = pool.observation;
  if (observation && typeof observation === 'object' && !Array.isArray(observation)) {
    // What the percentages actually cover. The pool reports these two facts
    // separately, and they say different things: the first that the number is the
    // whole account's, the second that our own share of it cannot be isolated.
    if (observation.accountUsageIncludesExternalClients === true) {
      lines.push('  note: percentages cover the whole account - ChatGPT app, Codex CLI, and this bridge');
    }
    if (observation.cliConsumptionVisible === false) {
      lines.push("  note: the CLI's own share cannot be separated out");
    }
  }
  if (pool.accounts.length > 0) lines.push('  note: accounts are shown by label');
  return lines;
}

// What /healthz calls the accounts on this screen, read off the payload rather
// than written down here. The mapping is neither one-way nor safe to tabulate:
// the payload says `cooldown` only for an account a latch is holding, so held,
// capped, stopped and blocked all arrive under that one word, while reserved and
// unread - withheld by the selection rules with no latch on them - arrive as
// `ready`, the word that invites an operator to conclude the screen is the broken
// one. A table written out in this file would also be a second source of truth
// that a change on the bridge could falsify without anything failing here.
function renderCodexPayloadWordNotes(views) {
  const groups = new Map();
  for (const view of views) {
    if (!view.word || !view.rawState || view.word === view.rawState) continue;
    const words = groups.get(view.rawState) ?? [];
    if (!words.includes(view.word)) words.push(view.word);
    groups.set(view.rawState, words);
  }
  return [...groups].map(([state, words]) => {
    const verb = words.length === 1 ? 'reads' : 'read';
    const tail = state === CODEX_PAYLOAD_SENDABLE_WORD ? ' - not sendable all the same' : '';
    return `  note: ${words.join(' / ')} ${verb} as "${state}" in /healthz${tail}`;
  });
}

// A second window whose reading has gone stale is disclosed here instead of in
// the grid: printing a frozen bar next to a live one invites reading both as
// current, and secondaryWindowResetAt is a window instant, not a read time.
function codexStaleSecondaryNote(view) {
  if (view.secondaryFresh) return '';
  const percent = view.secondaryPercent;
  if (percent == null) return '';
  const at = view.secondaryObservedAt == null ? '' : ` on ${formatDate(view.secondaryObservedAt)}`;
  return `  note: second window on ${view.label} is stale - last read ${codexRound(percent)}%${at}`;
}

// ---------------------------------------------------------------------------
// Shared readers.
// ---------------------------------------------------------------------------

// One account, read once. Every key is optional: the payload is written by
// another process, and a key that is missing must cost its own cell, never a row.
function codexAccountView(account, pool) {
  const source = account !== null && typeof account === 'object' ? account : {};
  const primary = codexNumber(source.primaryUsedPercent);
  const lastPrimary = codexNumber(source.lastKnownPrimaryUsedPercent);
  const fresh = primary != null && source.primaryObservationFresh !== false;
  const secondaryFresh = source.secondaryObservationFresh === true;
  const secondary = codexNumber(source.secondaryUsedPercent) ?? codexNumber(source.lastKnownSecondaryUsedPercent);
  const stop = codexNumber(source.stopUsedPercent);
  const word = codexStateWord(source, stop);
  // 鮮度が切れている行が名乗るのは「いま出している値を読んだ時刻」。だから
  // その場合だけ lastKnown 側を先に採る（現在の観測は途切れているため）。
  const observedAt = fresh
    ? (codexTimestamp(source.primaryObservedAt) ?? codexTimestamp(source.lastKnownPrimaryObservedAt))
    : (codexTimestamp(source.lastKnownPrimaryObservedAt) ?? codexTimestamp(source.primaryObservedAt));
  const secondaryObservedAt = codexTimestamp(source.lastKnownSecondaryObservedAt)
    ?? codexTimestamp(source.secondaryObservedAt);
  return {
    label: codexLabel(source.label),
    word,
    // The word the payload itself uses, kept so the screen can state the mapping
    // between the two vocabularies from the data instead of from a fixed table.
    rawState: codexText(source.state, ''),
    eligible: source.selectionEligible === true,
    // The window that drives selection. max(primary, secondary) is never taken:
    // the two windows are different sizes, and one number that is sometimes one
    // and sometimes the other cannot be compared with the stop line beside it.
    percent: fresh ? primary : (lastPrimary ?? primary),
    fresh,
    windowMins: codexWindowMins(source.primaryWindowDurationMins) ?? codexWindowMins(source.windowDurationMins),
    stop,
    stopText: codexStopText(stop),
    resume: codexNumber(source.resumeUsedPercent),
    resumeStreak: codexStreak(source.resumeStreak),
    cappedSince: codexTimestamp(source.cappedSince),
    // A 429 puts the reset instant on the account itself; taking the window's
    // instant in its place would silently drop the value the 429 carried.
    resetAt: word === 'exhausted'
      ? (codexTimestamp(source.resetAt) ?? codexTimestamp(source.primaryWindowResetAt))
      : (codexTimestamp(source.primaryWindowResetAt) ?? codexTimestamp(source.resetAt)),
    secondaryFresh,
    secondaryPercent: secondary,
    secondaryWindowMins: codexWindowMins(source.secondaryWindowDurationMins),
    secondaryResetAt: codexTimestamp(source.secondaryWindowResetAt),
    secondaryObservedAt,
    observedAt,
    // The account-level source belongs to the window that was read last, so it
    // describes this reading only when no later one exists on the other window.
    sourceDescribesPrimary: !(secondaryObservedAt != null && observedAt != null && secondaryObservedAt > observedAt),
    nextObservationAt: codexTimestamp(source.nextObservationAt),
    ordinaryUsageAllowed: typeof source.ordinaryUsageAllowed === 'boolean' ? source.ordinaryUsageAllowed : null,
    blockWhenUnknown: typeof source.blockWhenUnknown === 'boolean' ? source.blockWhenUnknown : null,
    source: codexText(source.observationSource, '')
      || (pool.observation && typeof pool.observation === 'object' ? codexText(pool.observation.source, '') : ''),
  };
}

// The word the row prints. It is derived here rather than taken from the payload
// because the payload calls every one of held / capped / reserved / unread the
// same thing - `cooldown` - a word that promises the account comes back on its
// own once enough time has passed. None of them do.
//
// Which of them it is, is decided by the stop line alone and never by the
// percentage: the payload does not say which window latched the stop, so
// "98% is over the 75% line" is an inference that is false whenever the second
// window was the one that tripped.
function codexStateWord(source, stop) {
  const reason = codexText(source.selectionBlockReason, '');
  const state = codexText(source.state, '');
  if (reason === 'needs-login' || state === 'needs-login') return 'needs login';
  if (reason === 'credentials-unavailable') return 'no creds';
  if (reason === 'model-unassigned') return 'no models';
  if (reason === 'exhausted' || state === 'exhausted') return 'exhausted';
  if (reason === 'upstream-blocked') return 'blocked';
  if (reason === 'usage-capped') {
    if (stop == null) return 'stopped';
    return stop >= 100 ? 'capped' : 'held';
  }
  if (reason === 'usage-unknown-reserved') return 'reserved';
  if (reason === 'usage-unknown') return 'unread';
  if (source.selectionEligible === true) return 'ready';
  if (state === 'unknown') return 'starting';
  // An unknown word is passed through rather than guessed at: being vague is
  // recoverable, being wrong is not.
  return state;
}

// The label is the only account identifier the contract allows, and it is bounded
// by `^[a-z0-9][a-z0-9_-]{0,31}$` (design doc 13.3). Everything else - an email
// address above all - is replaced by the shared `<invalid>` marker rather than
// drawn, so the pattern is the thing that keeps identifiers off this screen.
function codexLabel(value) {
  return sanitizeAccountLabel(typeof value === 'string' ? value : null) ?? CODEX_UNKNOWN_LABEL;
}

// A reset instant is drawn only while it is still ahead of us. A past instant
// used to print as `reset in now`, which reads as "any moment now" for a window
// that reset days ago.
function codexResetClause(at, now) {
  if (at == null || !(at > now)) return '';
  return `reset in ${formatDuration(at - now)} -> ${formatDate(at)}`;
}

function codexTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(typeof value === 'string' ? value : '');
  return Number.isFinite(parsed) ? parsed : null;
}

function codexWindowMins(value) {
  const mins = codexNumber(value);
  return mins == null || mins <= 0 ? null : mins;
}

function codexWindowLabel(mins) {
  return mins == null ? '--' : formatDuration(mins * 60000);
}

function codexStopText(stop) {
  return stop == null ? 'stop  n/a' : `stop ${codexRound(stop)}%`;
}

function codexSourceText(value) {
  const text = codexText(value, '');
  if (text === 'usage-get') return 'usage GET';
  if (text === 'response-header') return 'response headers';
  return text;
}

function codexStreak(value) {
  const streak = codexNumber(value);
  if (streak == null || !Number.isInteger(streak)) return null;
  return streak >= 0 && streak <= CODEX_RESUME_CONFIRMATIONS ? streak : null;
}

function codexPercent(percent) {
  return percent == null ? ' --%' : `${codexRound(percent).toString().padStart(3)}%`;
}

function codexRound(percent) {
  return Math.round(percent);
}

function codexNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function codexText(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(CODEX_UNSAFE_CHARACTERS, '');
  return cleaned || fallback;
}

// ---------------------------------------------------------------------------
// Session affinity section of `claude-rotator status` (sticky design 7.3).
//
// `status.sessionAffinity` is written by src/proxy-server.js and is absent while
// the mode is "off"; nothing is drawn then, so the screen stays byte-identical to
// the one operators see today (R7). Same shape as the Codex section above: a
// header line in the `current:` column, indented detail rows, one trailing blank
// line. Every field is optional as far as this renderer is concerned - a status
// JSON from an older or newer proxy can only cost this section detail, never the
// Claude side of the screen.
// ---------------------------------------------------------------------------

const AFFINITY_SECTION_LABEL = 'Session Affinity';
// Same column as the `current:` field of the Claude Rotator header line.
const AFFINITY_HEADER_WIDTH = 39;

function renderAffinitySection(affinity) {
  if (!affinity || typeof affinity !== 'object' || Array.isArray(affinity)) return [];
  const lines = [
    `${terminalPadEnd(AFFINITY_SECTION_LABEL, AFFINITY_HEADER_WIDTH)}${affinityHeadline(affinity)}`,
  ];
  for (const [label, counts] of [
    ['by account', affinity.sessionsByAccount],
    ['switches', affinity.switchesByReason],
    ['evictions', affinity.evictionsByReason],
  ]) {
    const rendered = affinityCounts(counts);
    if (rendered) lines.push(`  ${label}: ${rendered}`);
  }
  lines.push('');
  return lines;
}

function affinityHeadline(affinity) {
  const mode = typeof affinity.mode === 'string' && affinity.mode ? affinity.mode : 'unknown';
  const sessions = affinityNumber(affinity.sessions) ?? 0;
  const capacity = affinityNumber(affinity.capacity);
  const of = capacity == null ? '' : `/${capacity}`;
  return `mode: ${mode}  sessions: ${sessions}${of}  sid: ${affinitySidCoverage(affinity)}`;
}

// The share of forwarded requests that carried a session key (design 7.3). It is
// counted per request, so it cannot be derived from the session counts above.
function affinitySidCoverage(affinity) {
  const proxied = affinityNumber(affinity.requests?.proxied) ?? 0;
  const keyed = affinityNumber(affinity.requests?.keyed) ?? 0;
  if (proxied <= 0) return 'no requests';
  const rate = affinityNumber(affinity.sidRate) ?? keyed / proxied;
  return `${Math.round(rate * 100)}% (${keyed}/${proxied})`;
}

function affinityCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return '';
  return Object.entries(counts)
    .filter(([, value]) => affinityNumber(value) != null)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
}

function affinityNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
