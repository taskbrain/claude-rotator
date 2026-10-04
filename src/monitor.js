import { NEEDS_LOGIN_AVAILABILITY_STATE, isAuthExpiredReason } from './account-manager.js';
import { renderCodexDisplayError, renderCodexSection } from './shared/codex-view.js';
import {
  formatDuration,
  formatJstDate as formatDate,
  progressBar,
  terminalDisplayWidth,
  terminalPadEnd,
} from './shared/terminal-text.js';

// The bar and the duration are the ones the Codex section draws with, kept exported
// from here for the callers of this module.
export { formatDuration, progressBar };

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

  // Codex section, drawn only when the caller passed what the Codex section reader
  // returned (src/codex-status-child.js); without it nothing is appended and the
  // output stays byte-identical.
  lines.push(...codexSectionLines(options.codex, now));

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

function formatEventTime(value) {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  return formatDate(parsed);
}

// ---------------------------------------------------------------------------
// Codex section of `claude-rotator status` and `monitor`.
//
// `codex` is what the Codex section reader returned (src/codex-status-child.js):
//   null / undefined      no codex-rotator config file, nothing is drawn
//   { ok: false, reason } the child's output could not be used: one line
//   { ok: true, status }  the status JSON, already through the schema check
// Both forms are drawn by the same functions as `codex-rotator status`.
// ---------------------------------------------------------------------------

function codexSectionLines(codex, now) {
  if (!codex) return [];
  try {
    if (codex.ok !== true) return renderCodexDisplayError(codex.reason);
    return renderCodexSection(codex.status, { now });
  } catch {
    // A section that throws while it is drawn must not take the Claude side of the
    // screen or the exit code down with it: it becomes the one line for a status
    // the view cannot use.
    return renderCodexDisplayError('schema');
  }
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
