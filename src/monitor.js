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
  const reason = renderUnavailableReason(account.unavailableReason);
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
    const reason = renderUnavailableReason(event.reason);
    return `${at} upstream error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'quota-exhausted') {
    const reason = renderUnavailableReason(event.reason);
    return `${at} quota exhausted ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'account-error') {
    const reason = renderUnavailableReason(event.reason);
    return `${at} account error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  return `${at} ${event.type || 'event'}`.trim();
}

function renderUnavailableReason(reason) {
  if (!reason) return null;
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
