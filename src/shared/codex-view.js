// codex-rotator の状態の JSON（src/shared/codex-status-schema.js の形）を、端末に出す行に描く。
// `codex-rotator status`（引数なし）と、`claude-rotator status` の Codex の節は、この同じ関数で描く。
//
// 共用部品なので、import してよいのは src/shared/ と node: の標準部品だけ（境界検査）。
//
// 渡すのは codexStatusProblem を通った値だけ（ラベルは形を検査済みで、語はすべて決まった語）。ここでは
// 値を検査し直さない。口座はラベルだけで指し、ほかの識別子・パスは JSON に無いので画面にも出ない。
//
// 画面の作り（以前の版の `claude-rotator status` の Codex の節の項目を全部引き継ぐ。項目ごとの確かめは test/shared/codex-view.test.js）:
//   Codex Rotator                          sendable N/M  (<状態語> <件数>, …)  reset in … -> 日時
//     reading  usage GET, startup check <結果>, via daemon|direct   pool state: <語> (A/M available)
//     latch    known (daemon) | unknown (no daemon)
//     next:    <ラベル> | <ラベル> (last resort) | none
//     effective  <N> pts | unknown (≥<N> pts, <K> unknown)
//     <ラベル>  <状態語>  <窓> <バー> <%>  stop <%>  reset in … -> 日時      ← 口座ごとのカード
//               （新しい窓ごとに1行。5時間窓・週次窓・その他の窓の順）
//         clears   <停止が解ける条件・直し方>
//         refused  <上流も通常利用を断っていること>
//         <状態語> since <日時> (<経過>)
//         read     <日時> usage GET, …
//     events
//       <日時> <種類> <ラベル>
//     note: …
// 100桁を超える行は、区切り（reading の行は3つの空白の区切り、口座の行はリセット時刻の前、clears などの
// 行と注記は「,」「;」「 -」の後）で、字下げした続きの行へ移す。語は落とさない。収まる行は1行のまま。
// 停止は窓のリセットでは解けない（復帰の条件を満たした読取でだけ解ける）。リセット時刻は窓の時刻として
// `reset` と書き、`clears` の行は「not at that reset」で始める。
import { CODEX_CLEAN_READS_NEEDED, isCodexLabel } from './codex-status-schema.js';
import { formatDuration, formatJstDate, progressBar, terminalDisplayWidth, terminalPadEnd } from './terminal-text.js';

export const CODEX_SECTION_LABEL = 'Codex Rotator';
// 有効化されていないときの見出しの行の後ろ。
export const CODEX_DISABLED_TEXT = 'disabled (requires enabled and acknowledgedMultiAccountRisk)';

// Claude 側の見出しの行の `current:` と同じ39桁目にそろえる。
const HEADER_WIDTH = 39;
// ラベルの列の幅は、描くラベルの最大の幅（8〜32）。32 はラベルの形の上限で、長いラベルを切らない。
const LABEL_MIN_WIDTH = 8;
const LABEL_MAX_WIDTH = 32;
const STATE_WIDTH = 9;
const STOP_WIDTH = 9;
const DETAIL_KEY_WIDTH = 9;
const WINDOW_WIDTH = 2;
const BAR_WIDTH = 10;
// ラベルが20字までなら100桁に収める。見出しだけは状態語の内訳で伸びるので、超えるなら内訳を落とす。
// ほかの行は、超えるなら続きの行へ移す（fitWidth）。
const MAX_WIDTH = 100;
const READING_HEAD = '  reading  ';
const DETAIL_INDENT = ' '.repeat(4 + DETAIL_KEY_WIDTH);
const NOTE_INDENT = ' '.repeat('  note: '.length);
// clears などの行と注記を分けてよい所（「,」「;」「 -」の直後の空白の前）。
const CLAUSE_BREAK = /(?<=[,;]| -)(?= )/;
const EVENTS_SHOWN = 8;
const UNKNOWN_LABEL = '(unknown)';
const INVALID_LABEL = '<invalid>';
// 使用量の線で止まっていることを表す語（`<状態語> since …` の行と、held・capped の注記の対象）。
const STOPPED_WORDS = new Set(['held', 'capped', 'stopped']);
// User-Agent が作れず使用量を読めなかった理由の語と、その説明。
const UNREADABLE_CLI = Object.freeze({
  'codex-cli-missing': 'codex CLI not found',
  'codex-version-unreadable': 'codex CLI version unreadable',
});
// 親が子の出力を表示に使えなかったときの理由（決まった語だけ。どのキーが違ったかは出さない）。
const DISPLAY_ERROR_REASON = /^(timeout \d+ms|exit \d+|signal [A-Z0-9]+|spawn failed|invalid json|schema|too large)$/;

const heading = () => terminalPadEnd(CODEX_SECTION_LABEL, HEADER_WIDTH);
const timeOf = iso => (iso == null ? null : Date.parse(iso));
const roundPercent = percent => Math.round(percent);
const labelText = label => (label == null ? UNKNOWN_LABEL : isCodexLabel(label) ? label : INVALID_LABEL);

/**
 * 子の出力を表示に使えなかったときの節（見出しの1行と空行）。
 * @param {string} reason `timeout 8000ms`・`exit N`・`signal <名前>`・`spawn failed`・`invalid json`・`schema`・
 *   `too large` のどれか。ほかの値はプログラムの誤りとして TypeError。
 * @returns {string[]}
 */
export function renderCodexDisplayError(reason) {
  if (typeof reason !== 'string' || !DISPLAY_ERROR_REASON.test(reason)) throw new TypeError('unknown display error reason');
  return [`${heading()}codex: display error (${reason})`, ''];
}

/**
 * 状態の JSON を節の行にする。最後の要素は空行。
 * @param {object} status codexStatusProblem を通った状態の JSON
 * @param {{ now: number }} options now は描く時刻（ミリ秒）
 * @returns {string[]}
 */
export function renderCodexSection(status, { now }) {
  if (status.enabled !== true) return [`${heading()}${CODEX_DISABLED_TEXT}`, ''];
  const cards = status.accounts.map(cardOf);
  const columns = gridColumns(cards);
  const lines = [sendableHeader(status, now), ...readingLines(status), latchLine(status), nextLine(status),
    effectiveLine(status)];
  for (const card of cards) lines.push(...cardLines(card, columns, status, now));
  lines.push(...eventLines(status));
  lines.push(...noteLines(status, cards));
  lines.push('');
  return lines;
}

// --- 上の5行 -----------------------------------------------------------------------------------

// `sendable N/M` は選べる口座の数、内訳は口座の行と同じ状態語から数える（見出しと行が食い違わない）。
function sendableHeader(status, now) {
  const { accountsSelectable, accountsTotal } = status.aggregate;
  const head = `${heading()}sendable ${accountsSelectable}/${accountsTotal}`;
  const counts = new Map();
  for (const { stateWord } of status.accounts) {
    if (stateWord !== 'ready') counts.set(stateWord, (counts.get(stateWord) ?? 0) + 1);
  }
  const reset = resetClause(timeOf(status.pool.resetAt), now);
  const tail = reset ? `  ${reset}` : '';
  if (counts.size === 0) return `${head}${tail}`;
  const full = `${head}  (${[...counts].map(([word, count]) => `${word} ${count}`).join(', ')})${tail}`;
  return terminalDisplayWidth(full) <= MAX_WIDTH ? full : `${head}${tail}`;
}

function readingLines(status) {
  const parts = ['usage GET'];
  if (status.observation.startupCheck !== null) parts.push(`startup check ${status.observation.startupCheck}`);
  parts.push(status.source === 'daemon' ? 'via daemon' : 'direct');
  const { accountsAvailable, accountsTotal } = status.aggregate;
  const pieces = [`${READING_HEAD}${parts.join(', ')}`,
    `   pool state: ${status.pool.state} (${accountsAvailable}/${accountsTotal} available)`];
  const skipped = status.observation.userAgentSource === null
    ? status.accounts.find(account => Object.hasOwn(UNREADABLE_CLI, account.reason))?.reason : undefined;
  if (skipped !== undefined) pieces.push(`   usage read skipped: ${skipped}`);
  return fitWidth(pieces, ' '.repeat(READING_HEAD.length));
}

// 常駐が無いと停止（ラッチ）の状態は分からない。そのことを1行で言う。
function latchLine(status) {
  return `  latch    ${status.latchKnown ? 'known (daemon)' : 'unknown (no daemon)'}`;
}

function nextLine(status) {
  const { label, reason } = status.next;
  if (label === null) return '  next:    none';
  return `  next:    ${labelText(label)}${reason === 'last-resort' ? ' (last resort)' : ''}`;
}

// 実効残量（1口座の % を単位にした残りの量）。小数は切り捨てる（残りを多めに見せない）。
function effectiveLine(status) {
  const { effectiveRemainingPercent, lowerBoundPercent } = status.aggregate;
  if (effectiveRemainingPercent !== null) return `  effective  ${Math.floor(effectiveRemainingPercent)} pts`;
  const unknown = status.accounts.filter(account => account.headroomPercent === null).length;
  return `  effective  unknown (≥${Math.floor(lowerBoundPercent)} pts, ${unknown} unknown)`;
}

// --- 口座のカード ------------------------------------------------------------------------------

// 窓は5時間窓・週次窓・その他の窓の順。最初の窓を口座の行に、残りを下の行（新しい窓）か注記（古い窓）に描く。
// slot は長さの申告が無い窓の呼び名（最初・2つ目・その他）。
function cardOf(account) {
  const rows = [];
  if (account.windows.fiveHour) rows.push({ slot: 'first', window: account.windows.fiveHour });
  if (account.windows.weekly) rows.push({ slot: 'second', window: account.windows.weekly });
  for (const window of account.otherWindows) rows.push({ slot: 'other', window });
  return { account, label: labelText(account.label), word: account.stateWord, main: rows[0] ?? null, extra: rows.slice(1) };
}

function gridColumns(cards) {
  const widest = cards.reduce((width, card) => Math.max(width, terminalDisplayWidth(card.label)), 0);
  const windows = cards.flatMap(card => [card.main, ...card.extra]).filter(Boolean).map(row => row.window);
  return {
    label: Math.min(Math.max(widest, LABEL_MIN_WIDTH), LABEL_MAX_WIDTH),
    window: windows.some(window => window.windowMinutes !== null),
    stop: cards.some(card => card.account.policy?.stopUsedPercent != null),
  };
}

function cardLines(card, columns, status, now) {
  const { account, main } = card;
  // 枠切れ（429）は口座のリセット時刻を先に使う（窓の時刻で置き換えると、429 が持ってきた値を落とすため）。
  const resetAt = card.word === 'exhausted'
    ? (timeOf(account.resetAt) ?? timeOf(main?.window.resetAt))
    : (timeOf(main?.window.resetAt) ?? timeOf(account.resetAt));
  const reset = resetClause(resetAt, now);
  const fresh = main?.window.fresh === true;
  const percent = main?.window.usedPercent ?? null;
  const lines = gridLines(columns, { label: card.label, word: card.word, windowMinutes: main?.window.windowMinutes ?? null,
    percent, fresh, stale: percent !== null && !fresh, stop: stopText(account.policy?.stopUsedPercent), reset });
  for (const { window } of card.extra) {
    if (window.fresh !== true) continue;
    lines.push(...gridLines(columns, { windowMinutes: window.windowMinutes, percent: window.usedPercent, fresh: true,
      reset: resetClause(timeOf(window.resetAt), now) }));
  }
  if (card.word === 'ready' && fresh) return lines;
  const clears = clearsText(card, reset !== '');
  if (clears) lines.push(...detailLines('clears', clears));
  const refused = refusedText(card);
  if (refused) lines.push(...detailLines('refused', refused));
  const since = sinceText(card, status, now);
  if (since) lines.push(...detailLines(card.word, since));
  const read = readText(card, status);
  if (read) lines.push(...detailLines('read', read));
  return lines;
}

// 口座の行と、下の窓の行の共通の桁。末尾の空白は落とす。100桁を超えるならリセット時刻を続きの行へ移す。
// ラベルが20字までで長さの列が2字（5h・7d など）なら収まる。長さの列が申告の長さで2字を超えるとき
// （1h30m など）と、ラベルが21字以上のときは、リセット時刻の長さによって超えることがある。
function gridLines(columns, cells) {
  let line = `  ${terminalPadEnd(cells.label ?? '', columns.label)}`;
  line += ` ${terminalPadEnd(cells.word ?? '', STATE_WIDTH)}`;
  if (columns.window) line += ` ${windowLabel(cells.windowMinutes).padStart(WINDOW_WIDTH)}`;
  const ratio = cells.fresh && cells.percent !== null ? cells.percent / 100 : null;
  line += ` ${progressBar(ratio, BAR_WIDTH)}`;
  line += ` ${percentText(cells.percent)}${cells.stale ? '*' : ' '}`;
  if (columns.stop) line += ` ${terminalPadEnd(cells.stop ?? '', STOP_WIDTH)}`;
  const pieces = cells.reset ? [line, `  ${cells.reset}`] : [line];
  return fitWidth(pieces, ' '.repeat(2 + columns.label + 1 + STATE_WIDTH + 1)).map(text => text.replace(/ +$/, ''));
}

function detailLines(key, text) {
  return fitWidth(`    ${terminalPadEnd(key, DETAIL_KEY_WIDTH)}${text}`.replace(/ +$/, '').split(CLAUSE_BREAK), DETAIL_INDENT);
}

// 停止が解ける条件と直し方。時刻ではない（リセット時刻を描くときは「not at that reset」、描かないときは
// 「not when the window resets」）。ログイン切れと資格情報が読めない口座は、直すコマンドを書く。
function clearsText(card, hasReset) {
  const { account, word, label } = card;
  const denial = hasReset ? 'not at that reset' : 'not when the window resets';
  const needed = account.latch?.cleanReadsNeeded ?? CODEX_CLEAN_READS_NEEDED;
  const resume = account.policy?.resumeUsedPercent ?? null;
  const done = account.latch?.cleanReadsDone ?? 0;
  const cli = UNREADABLE_CLI[account.reason];
  switch (word) {
    case 'held':
    case 'capped':
      if (resume === null) return `${denial} - needs ${needed} clean usage reads below the line that stopped it`;
      if (done > 0) return `${done} of ${needed} clean reads done - needs ${roundPercent(resume)}% or less, ${denial}`;
      return `${denial} - needs ${needed} clean usage reads at ${roundPercent(resume)}% or less`;
    case 'stopped':
      return `${denial} - needs a usage read below the rotator's own limit`;
    case 'reserved':
      return cli ? `needs a readable codex CLI (${cli})` : 'needs one complete usage read; this account will not send while unread';
    case 'unread':
      return cli ? `needs a readable codex CLI (${cli})` : 'needs one complete usage read';
    case 'starting':
      return 'needs the first usage read after the daemon started';
    case 'exhausted':
      return hasReset
        ? 'after that reset, once the rotator rechecks this account (429 seen)'
        : 'once the rotator rechecks this account (429 seen)';
    case 'blocked':
      return 'the upstream refuses ordinary use; needs a read that says otherwise';
    case 'needs login':
      return `run codex-rotator login --label ${label} --relogin`;
    case 'no creds':
      return `run codex-rotator remove --label ${label}, then log in again with codex-rotator login`;
    case 'no models':
      return 'needs a model assigned to this account';
    default:
      return '';
  }
}

// 使用量の線の停止と上流の拒否は別の2つのラッチで、同じ読取が両方を解く必要がある。held・capped の口座で
// 上流も通常利用を断っているときは、そのことを別の行で言う。
function refusedText(card) {
  if (card.word !== 'held' && card.word !== 'capped') return '';
  const refused = card.account.latch?.upstreamBlocked === true || card.account.ordinaryUsageAllowed === false;
  return refused ? 'the upstream refuses ordinary use too - those reads must say otherwise' : '';
}

// 停止した時刻。常駐は停止を保存しないので、起動の後に付け直した時刻は「いつから止まっているか」を
// 言わない。常駐の起動時刻より前の停止だけを描く（そうでなければ何も描かない）。
function sinceText(card, status, now) {
  if (!STOPPED_WORDS.has(card.word)) return '';
  const since = timeOf(card.account.latch?.since);
  const startedAt = timeOf(status.daemon.startedAt);
  if (since === null || startedAt === null || since >= startedAt) return '';
  return `since ${formatJstDate(since)} (${formatDuration(now - since)})`;
}

// 読んだ時刻と、その読取が言ったこと。古い窓の値はそう書き、次に読む予定を添える（常駐が無ければ予定は
// 無い）。読めたが窓が1つも無い口座は、古くなった値も無いので stale とは書かない。
function readText(card, status) {
  const { account, main } = card;
  const observedAt = timeOf(main?.window.observedAt ?? account.observedAt);
  if (observedAt === null) return '';
  const head = `${formatJstDate(observedAt)} usage GET`;
  if (main !== null && main.window.fresh !== true) {
    if (status.source === 'direct') return `${head} - stale (no daemon)`;
    const next = timeOf(account.nextObservationAt);
    return `${head} - stale${next === null ? '' : `, next try ${formatJstDate(next)}`}`;
  }
  const parts = [];
  if (account.ordinaryUsageAllowed === true) parts.push('ordinary use allowed');
  if (account.ordinaryUsageAllowed === false) parts.push('ordinary use refused');
  if (account.policy?.blockWhenUnknown === true) parts.push('stops when unread');
  if (account.policy?.blockWhenUnknown === false) parts.push('sends when unread');
  return parts.length > 0 ? `${head}, ${parts.join(', ')}` : head;
}

// --- 出来事と注記 ------------------------------------------------------------------------------

// 新しい方から決まった件数まで。
function eventLines(status) {
  if (status.events.length === 0) return [];
  const shown = status.events.slice(-EVENTS_SHOWN).reverse();
  return ['  events', ...shown.map(event =>
    `    ${formatJstDate(timeOf(event.at))} ${event.type}${event.label === null ? '' : ` ${labelText(event.label)}`}`)];
}

function noteLines(status, cards) {
  const lines = [];
  const words = new Set(cards.map(card => card.word));
  if (words.has('held') || words.has('capped')) {
    lines.push('  note: held = stopped at our own line, capped = the plan limit itself');
  }
  if (cards.some(card => refusedText(card) !== '')) {
    lines.push('  note: refused = the upstream refuses it too; the usage stop is not the only latch');
  }
  lines.push(...jsonWordNotes(cards));
  for (const card of cards) lines.push(...staleWindowNotes(card));
  if (status.observation.accountUsageIncludesExternalClients === true) {
    lines.push('  note: percentages cover the whole account - ChatGPT app, Codex CLI, and any other client');
  }
  if (status.observation.cliConsumptionVisible === false) {
    lines.push("  note: the CLI's own share cannot be separated out");
  }
  if (cards.length > 0) lines.push('  note: accounts are shown by label');
  return lines.flatMap(line => fitWidth(line.split(CLAUSE_BREAK), NOTE_INDENT));
}

// 画面の状態語が `status --json` の4つの状態のどれに当たるか。ready（available）と、語と状態が同じ
// exhausted は書かない。unknown に当たる語は、送れる口座に数えないことも書く。
function jsonWordNotes(cards) {
  const groups = new Map();
  for (const { word, account } of cards) {
    if (account.state === 'available' || word === account.state) continue;
    const list = groups.get(account.state) ?? [];
    if (!list.includes(word)) list.push(word);
    groups.set(account.state, list);
  }
  return [...groups].map(([state, list]) => {
    const verb = list.length === 1 ? 'reads' : 'read';
    const tail = state === 'unknown' ? ' - not sendable all the same' : '';
    return `  note: ${list.join(' / ')} ${verb} as "${state}" in status --json${tail}`;
  });
}

// 口座の行に描かない窓のうち、古くなった窓は、行ではなく注記で言う（古いバーを新しいバーと並べない）。
function staleWindowNotes(card) {
  return card.extra.filter(({ window }) => window.fresh !== true && window.usedPercent !== null).map(({ slot, window }) => {
    const name = window.windowMinutes === null ? slot : windowLabel(window.windowMinutes);
    const at = timeOf(window.observedAt);
    return `  note: ${name} window on ${card.label} is stale - last read ${roundPercent(window.usedPercent)}%`
      + `${at === null ? '' : ` on ${formatJstDate(at)}`}`;
  });
}

// --- 部品 ------------------------------------------------------------------------------------

// pieces をつないで1行にする。100桁を超えるところでは、その piece から先を、頭の空白を除いて indent を
// 付けた続きの行に置く（続きの行にも、収まる限り後ろの piece をつなぐ）。収まる行は pieces をつないだまま。
function fitWidth(pieces, indent) {
  const lines = [pieces[0]];
  for (const piece of pieces.slice(1)) {
    const last = lines[lines.length - 1];
    if (terminalDisplayWidth(last + piece) <= MAX_WIDTH) lines[lines.length - 1] = last + piece;
    else lines.push(indent + piece.trimStart());
  }
  return lines;
}

// リセット時刻は、まだ先のときだけ描く（過ぎた時刻を「reset in now」と描かない）。
function resetClause(at, now) {
  if (at === null || at === undefined || !(at > now)) return '';
  return `reset in ${formatDuration(at - now)} -> ${formatJstDate(at)}`;
}

function windowLabel(minutes) {
  return minutes === null || minutes === undefined ? '--' : formatDuration(minutes * 60000);
}

function stopText(stop) {
  return stop == null ? 'stop  n/a' : `stop ${roundPercent(stop)}%`;
}

function percentText(percent) {
  return percent === null || percent === undefined ? ' --%' : `${roundPercent(percent).toString().padStart(3)}%`;
}
