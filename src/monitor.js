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

export function renderStatus(status, options = {}) {
  const now = options.now ?? Date.now();
  const lines = [];
  const active = status.currentAccountName || status.currentAccount || '(none)';
  lines.push(`Claude Rotator                         active: ${active}`);
  lines.push('');

  for (const account of status.accounts || []) {
    lines.push(`${account.name.padEnd(26)} ${account.status}`);
    const reason = renderUnavailableReason(account.unavailableReason);
    if (reason) lines.push(`reason: ${reason}`);
    lines.push(renderQuotaRow('5h', account.quota?.unified5h, account.quota?.unified5hReset, now));
    lines.push(renderQuotaRow('7d', account.quota?.unified7d, account.quota?.unified7dReset, now));
    lines.push(`requests: ${account.usage?.totalRequests ?? 0}`);
    lines.push('');
  }

  lines.push('Events');
  for (const event of (status.events || []).slice(0, 8)) {
    lines.push(renderEvent(event));
  }

  return `${lines.join('\n')}\n`;
}

function renderQuotaRow(label, ratio, resetAt, now) {
  const percent = ratio == null ? ' --%' : `${Math.round(ratio * 100).toString().padStart(3)}%`;
  const reset = resetAt ? `  reset in ${formatDuration(resetAt - now)} -> ${formatDate(resetAt)}` : '  no data yet';
  return `${label} ${progressBar(ratio, 10)} ${percent}${reset}`;
}

function renderEvent(event) {
  if (event.type === 'auto-switch') {
    return `${event.at || ''} switched ${event.from || '(none)'} -> ${event.to} reason=${event.reason || 'quota-threshold'}`.trim();
  }
  if (event.type === 'fallback-switch') {
    return `${event.at || ''} fallback ${event.from || '(none)'} -> ${event.to} reason=${event.reason || 'shortest-quota-reset'}`.trim();
  }
  if (event.type === 'manual-switch') {
    return `${event.at || ''} manual switch -> ${event.account}`.trim();
  }
  if (event.type === 'proxy-request') {
    const status = event.statusCode ?? '-';
    const requestId = event.requestId ? ` req=${event.requestId}` : '';
    const errorType = event.errorType ? ` error=${event.errorType}` : '';
    return `${event.at || ''} request ${event.account || ''} ${event.method || ''} ${event.path || ''} -> ${status} ${event.durationMs ?? 0}ms outcome=${event.outcome || 'unknown'}${requestId}${errorType}`.trim();
  }
  if (event.type === 'upstream-error') {
    const reason = renderUnavailableReason(event.reason);
    return `${event.at || ''} upstream error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'quota-exhausted') {
    const reason = renderUnavailableReason(event.reason);
    return `${event.at || ''} quota exhausted ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  if (event.type === 'account-error') {
    const reason = renderUnavailableReason(event.reason);
    return `${event.at || ''} account error ${event.account || ''}${reason ? ` (${reason})` : ''}`.trim();
  }
  return `${event.at || ''} ${event.type || 'event'}`.trim();
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
  const date = new Date(ts);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}
