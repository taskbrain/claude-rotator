// `codex-rotator exec [--account <ラベル>] -- [codex の引数...]` の本体。口座を1つ選び、その口座の
// フォルダを CODEX_HOME にして本物の codex を起動する。
//
// 流れ（この順に行い、拒否したらそこで止まる。止まったときは codex を起動しない）:
//   1. exec 自身の引数を読む（--account と `--` の後ろの語の並び）。形が違えば使い方の1行で 2。
//   2. 設定を1回だけ読む（loadCodexConfigSnapshot）。この1回の結果を、ゲート・口座の選択・起動する
//      口座のフォルダのすべてに使う。
//   3. 有効化の二重ゲート（enabled と多口座のリスク承認）。満たさなければ `disabled`。
//   4. 起動の型の照合（account-config.js）。型に当たらなければ `argument rejected (form)`。拒否は
//      使用量の読取の送信より前に行う。
//   5. 口座の選択。先に常駐へ問い合わせる（consultDaemon。既定は consultDaemonSelect で、Codex CLI が
//      見つからないときは問い合わせない）。常駐が 200 で答えたら、その判定を手順2の設定と照らして
//      使い（下の「常駐があるとき」）、1回読みはしない。常駐が無い（null）ときは、その場の1回読みで選ぶ。
//        - --account なし: 設定の並び順に1口座ずつ読み、完全な観測が読めて、上流が使えると言い、
//          申告された全部の窓が復帰しきい値以下の、最初の口座を選ぶ（使用量が分からない口座は
//          選ばない）。1つも無ければ `no account available`。
//        - --account あり: その口座だけを読む。資格情報が読めなければ方針に関係なく `no creds`、
//          申告された窓のどれかが停止しきい値以上（または上流が使えないと言った）なら
//          `account stopped`、使用量が分からないときは blockWhenUnknown が真なら
//          `usage unknown (blockWhenUnknown)`、偽なら警告の1行を出して起動する。
//      読んだ口座ごとに、判定の語の1行 `usage <ラベル>: <語>` を標準エラーへ出す（守りの点検の前）。
//   6. 起動ごとの点検（account-config.js の prepareGuardedLaunch。型の照合・第1層・--no-daemon の
//      付け方・features list と mcp list --json の点検）。通らなければ `guard unverified (<理由>)`。
//   7. 起動。stdio は受け継ぎ（exec 自身は標準出力に何も書かない）。子が生きている間だけ、4つの
//      シグナルの受け口を付けて子へ転送する。子が終了コードで終われば、その値をそのまま返す。
//      シグナルで終われば、受け口を外してから同じシグナルを自分へ当て直す（当て直しても終わらな
//      かったときのために 128＋シグナルの番号を返す）。
//
// 標準エラーの行には、ラベルと決まった語のほかに、値（パス・ヘッダの値・トークン・口座の識別子・
// メールアドレス）を入れない。拒否の終了コードは 1、使い方の誤りは 2。
//
// 資格情報は読むだけで書かない。rollout（口座のフォルダの sessions の下）は探しも読みもしない。
// ~/.codex の中は開かない（設定の検証がパスの情報を見るだけ）。
//
// 常駐があるとき（consultDaemonSelect）:
//   - 制御トークンのファイルを読み、設定の daemon.port のループバックへ POST /internal/select を1回送る
//     （本文は {} か {"label":"<ラベル>"}、トークンは要求ヘッダだけに載せる。引数・環境変数には入れない）。
//   - トークンのファイルが無い・読めない、ポートが使えない、届かない・応答のヘッダが来ないまま期限が
//     切れた、200 でない応答（401・403 など）のときは、常駐が無いものとして null を返す（呼出し元が1回読みで
//     選ぶ）。
//   - 200 の応答は、手順2で読んだ設定と照らす。次のときは、判定を使わずに `config stale` と reload の
//     案内で止まる（値・パス・ラベルは出さない）。常駐は選んだ記録を先に残すので、ここで止まっても常駐の
//     記録は進む。
//       - 200 の本文を読み切れない（上限を超えた・途中で切れた・200 のヘッダを受けた後、本文を読み終える
//         前に期限が切れた）、JSON でない。
//       - 応答の configSha256 が無い・64桁の小文字の16進でない・自分の読込みの sha256 と違う。
//       - 応答のラベルが自分の設定に無い（--account のときは明示したラベルと違う）。
//       - 判定の形が分からない（知らない判定・知らない理由の語。選んだの応答で usageKnown・lastResort が
//         真偽でない、stateWord が状態語のどれでもない）。
//       - 「選んだ」の組が、常駐が返しうる組でない（decideSelection の前の表）。no creds と停止中の状態語の
//         「選んだ」と、使用量が分からないまま選んだと答えたのに自分の設定のその口座の blockWhenUnknown
//         が真（自分の設定では選ばない口座）のものも、これに当たる。
//   - 照らして合えば判定を使う。起動する口座のフォルダは、常駐の応答ではなく手順2の設定の口座のもの。
//     判定の語の行（usage <ラベル>: <語>）は、1回読みをしないので出さない。拒否は account stopped・
//     usage unknown (blockWhenUnknown)・no creds（どれも案内付き）・no account available。使用量が
//     分からないまま選んだ（明示の口座・最後の手段）ときは警告の1行を出す。login し直しの案内を足すのは、
//     明示の口座で状態語が needs login のときだけ（no creds は login し直しでは直らないので足さない）。
import { spawn as spawnChild } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import {
  ARGUMENT_REJECTED_KIND, LAUNCH_CALLER, formatArgumentRejected, formatGuardUnverified, matchLaunchForm,
  prepareGuardedLaunch,
} from './account-config.js';
import { CLIENT_IDENTITY_REASON, composeClientIdentity, readCodexVersion } from './client-version.js';
import {
  CODEX_ACCOUNT_LABEL, CONFIG_SHA256_PATTERN, isCodexRotatorActivated, isValidUsageOriginator,
  isValidUsageUserAgent, loadCodexConfigSnapshot,
} from './config.js';
import { CONTROL_TOKEN_HEADER, readControlToken } from './control-token.js';
import { readCodexSendSnapshot } from './credentials.js';
import { CODEX_DAEMON_PATHS, CODEX_SELECT_OUTCOME, CODEX_SELECT_REFUSAL } from './daemon.js';
import { findRealCodex } from './real-codex.js';
import { readCodexUsage } from './usage.js';
import { CODEX_STATE_OF_WORD } from '../shared/codex-status-schema.js';
import { requestLocal } from '../shared/local-http.js';

export const EXEC_USAGE = 'usage: codex-rotator exec [--account <label>] -- [codex arguments...]';
export const EXEC_USAGE_EXIT_CODE = 2;
export const EXEC_REFUSED_EXIT_CODE = 1;

const ACCOUNT_OPTION = '--account';
const SEPARATOR = '--';

/** 拒否と警告で標準エラーへ出す決まった行（改行は含めない。値は含めない）。 */
export const EXEC_LINE = Object.freeze({
  disabled: 'disabled',
  configUnreadable: 'config unreadable',
  accountNotRegistered: 'account not registered',
  accountStopped: 'account stopped',
  usageUnknownBlocked: 'usage unknown (blockWhenUnknown)',
  noCreds: 'no creds',
  noAccountAvailable: 'no account available',
  launchFailed: 'launch failed',
  configStale: 'config stale',
});

/** 常駐への問い合わせの全体の期限（要求を出してから応答を読み終えるまで）。 */
export const EXEC_DAEMON_TIMEOUT_MS = 1000;
// 常駐の select の応答の大きさの上限（応答は8つのキーの小さな JSON）。
const DAEMON_ANSWER_MAX_BYTES = 16 * 1024;

/** 判定の語のうち、この部品が決める語。ほかは使用量の読取の失敗の分類と、版の読取の理由の語。 */
export const VERDICT = Object.freeze({
  ok: 'ok',
  accessTokenExpired: 'access-token-expired',
  credentialsUnavailable: 'credentials-unavailable',
  internalError: 'internal-error',
});

// 失効を示す判定の語（login し直しを案内する）。unauthorized は使用量の読取の 401。
const NEEDS_LOGIN_VERDICTS = new Set([VERDICT.accessTokenExpired, 'unauthorized']);

// 子が生きている間に受けて子へ転送するシグナル。
export const FORWARDED_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']);

// 資格情報の読取が期限切れのときに投げる例外のメッセージ（credentials.js の取り決め）。
const CREDENTIALS_EXPIRED_MESSAGE = 'send credentials expired';
const USAGE_WINDOWS = Object.freeze(['primary', 'secondary']);

// --- 標準エラーの行 ----------------------------------------------------------------------------

/** 判定の語の1行（改行は含めない）。含めるのはラベルと語だけ。 */
export function formatVerdictLine(label, word) {
  return `usage ${label}: ${word}`;
}

/** 失効した口座の login し直しの案内。 */
export function formatReloginGuidance(label) {
  return `run codex-rotator login --label ${label} --relogin`;
}

/** 資格情報が読めない口座の案内（登録を外してから新しく login する）。 */
export function formatRemoveGuidance(label) {
  return `run codex-rotator remove --label ${label}, then log in again with codex-rotator login`;
}

// 使用量が分からないまま起動する警告に、失効しているときだけ login し直しの案内を足す。
const withReloginAdvice = (text, label, needsLogin) => (needsLogin
  ? `${text}; if codex asks you to log in, stop it and run codex-rotator login --label ${label} --relogin`
  : text);

const unknownUsageWarning = (label, needsLogin) =>
  withReloginAdvice(`warning: usage unknown for ${label}; launching anyway (blockWhenUnknown is false)`, label, needsLogin);

/** 使用量が分からないまま明示の口座で起動するときの警告の1行。失効の語なら login し直しの案内を足す。 */
export function formatUnknownUsageWarning(label, word) {
  return unknownUsageWarning(label, NEEDS_LOGIN_VERDICTS.has(word));
}

/**
 * 常駐が最後の手段で使用量の分からない口座を選んだときの警告の1行。最後の手段は、使える状態で使用量だけが
 * 分からない口座（状態語 unread・starting）なので、login し直しの案内は足さない。
 */
export function formatLastResortWarning(label) {
  return `warning: usage unknown for ${label}; launching it as the last resort`;
}

/** config stale の後に出す案内の1行（値・パス・ラベルを含めない）。 */
export function formatConfigStaleGuidance() {
  return 'run codex-rotator reload; if config stale continues after that, check what codex-rotator reload reports';
}

/** Codex CLI が見つからず起動できないときの1行。 */
export function formatCannotLaunch(reason) {
  return `cannot launch (${reason})`;
}

// --- 引数 ----------------------------------------------------------------------------------------

/**
 * exec 自身の引数を読む。`--` より前に置けるのは `--account <ラベル>` の1組だけ。`--` が無ければ
 * codex の引数は空（引数の無い対話）とする。入力の配列は変えない。
 * @param {readonly string[]} argv
 * @returns {{ ok: true, account: string|null, codexArgs: string[] } | { ok: false }}
 */
export function parseExecArgs(argv) {
  if (!Array.isArray(argv) || !argv.every(word => typeof word === 'string')) return { ok: false };
  const separator = argv.indexOf(SEPARATOR);
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const codexArgs = separator === -1 ? [] : argv.slice(separator + 1);
  let account = null;
  for (let i = 0; i < own.length; i += 2) {
    const [option, value] = [own[i], own[i + 1]];
    if (option !== ACCOUNT_OPTION || account !== null || typeof value !== 'string' || !CODEX_ACCOUNT_LABEL.test(value)) {
      return { ok: false };
    }
    account = value;
  }
  return { ok: true, account, codexArgs };
}

// --- 常駐を使わない1回読み ----------------------------------------------------------------------

// 完全な観測にならなかった理由の語（常駐の取得処理のログの語と同じ決め方）。
function incompleteWord(observation) {
  if (typeof observation.ordinaryUsageAllowed !== 'boolean') return 'allowed-unusable';
  if (!USAGE_WINDOWS.some(name => observation[name])) return 'window-absent';
  return USAGE_WINDOWS.map(name => observation[name]?.incompleteReason).find(Boolean) ?? 'incomplete';
}

/**
 * 使用量の読取の結果を判定の語にする。完全な観測なら ok、読めなければ失敗の分類の語（401 は
 * unauthorized、403 は forbidden、そのほかの 4xx は後ろに状態コードの数を付けた client-error）。
 * @param {object} result readCodexUsage の戻り値
 * @returns {string}
 */
export function verdictWordOf(result) {
  if (result?.classification === 'success' && result.observation) {
    return result.observation.complete === true ? VERDICT.ok : incompleteWord(result.observation);
  }
  const word = result?.failure ?? result?.errorCode ?? result?.classification ?? VERDICT.internalError;
  return word === 'client-error' && Number.isInteger(result.status) ? `${word} ${result.status}` : word;
}

// 使用量の読取に付ける User-Agent と originator。Codex CLI が見つからなければ読取を送らない（起動
// できないので、設定の上書きがあっても送らない）。設定の組があればそれを使い、無ければ版を読む。
async function resolveOneShotIdentity({ config, codexPath, spawn, readVersion }) {
  if (codexPath === null) return { reason: CLIENT_IDENTITY_REASON.cliMissing };
  const userAgent = config.usageUserAgent ?? null;
  const originator = config.usageOriginator ?? null;
  if (userAgent !== null || originator !== null) {
    return isValidUsageUserAgent(userAgent) && isValidUsageOriginator(originator)
      ? { userAgent, originator } : { reason: CLIENT_IDENTITY_REASON.versionUnreadable };
  }
  try {
    const version = await readVersion(codexPath, { spawn });
    const identity = version === null ? null : composeClientIdentity(version);
    return identity ?? { reason: CLIENT_IDENTITY_REASON.versionUnreadable };
  } catch {
    return { reason: CLIENT_IDENTITY_REASON.versionUnreadable };
  }
}

/**
 * 常駐を使わずに、口座の使用量をその場で1回だけ読む部品を作る（資格情報の読取・User-Agent の組立・
 * 使用量の読取の組み合わせは、この関数の中だけにある）。版の読取は、作った部品の中で最初に要った
 * ときに1回だけ行う。資格情報は読むだけで、トークンの更新も書込みもしない。
 *
 * 返す関数 readAccount(account) は { word, observation, sent } を返し、例外を投げない。word は判定の語、
 * observation は読めた観測（読取を送らなかった・失敗したときは null）、sent は読取を送ったか。
 *
 * @param {{
 *   config: object, codexPath: string|null, spawn?: Function, readVersion?: Function,
 *   readCredentials?: Function, readUsage?: Function, fetchImpl?: typeof fetch, now?: () => number,
 * }} options
 */
export function createOneShotUsageReader({ config, codexPath, spawn = spawnChild, readVersion = readCodexVersion,
  readCredentials = readCodexSendSnapshot, readUsage = readCodexUsage, fetchImpl = globalThis.fetch,
  now = Date.now } = {}) {
  let identity = null;
  const identityOnce = () => {
    identity ??= resolveOneShotIdentity({ config, codexPath, spawn, readVersion });
    return identity;
  };
  const notSent = word => ({ word, observation: null, sent: false });
  return async function readAccount(account) {
    let credentials;
    try {
      credentials = await readCredentials(join(account.codexHome, 'auth.json'), { nowMs: now() });
    } catch (error) {
      return notSent(error?.message === CREDENTIALS_EXPIRED_MESSAGE ? VERDICT.accessTokenExpired : VERDICT.credentialsUnavailable);
    }
    const client = await identityOnce();
    if (client.reason) return notSent(client.reason);
    try {
      const result = await readUsage({ credentials, userAgent: client.userAgent, originator: client.originator,
        fetchImpl, now, timeoutMs: config.usageReadTimeoutMs });
      return { word: verdictWordOf(result), observation: result?.observation ?? null, sent: true };
    } catch {
      return notSent(VERDICT.internalError);
    }
  };
}

// --- 口座の選択（常駐なし） ----------------------------------------------------------------------

const declaredWindows = observation => USAGE_WINDOWS.map(name => observation?.[name])
  .filter(window => window && Number.isFinite(window.usedPercent));

// 停止中とみなすか: 申告された窓のどれかが停止しきい値以上か、上流が使えないと言った。
function looksStopped(observation, policy) {
  if (!observation) return false;
  if (observation.ordinaryUsageAllowed === false) return true;
  return declaredWindows(observation).some(window => window.usedPercent >= policy.stopUsedPercent);
}

// 自動で選べるか: 完全な観測で、上流が使えると言い、申告された全部の窓が復帰しきい値以下。
function selectableWithoutDaemon(reading, policy) {
  if (reading.word !== VERDICT.ok || reading.observation?.ordinaryUsageAllowed !== true) return false;
  const windows = declaredWindows(reading.observation);
  return windows.length > 0 && windows.every(window => window.usedPercent <= policy.resumeUsedPercent);
}

// 判定の語に応じた案内の行（失効なら login し直し、資格情報が読めなければ登録を外して login）。
function guidanceLines(label, word) {
  if (NEEDS_LOGIN_VERDICTS.has(word)) return [formatReloginGuidance(label)];
  if (word === VERDICT.credentialsUnavailable) return [formatRemoveGuidance(label)];
  return [];
}

const refuse = lines => Object.freeze({ ok: false, lines: Object.freeze(lines) });
const choose = (account, lines) => Object.freeze({ ok: true, account, lines: Object.freeze(lines) });

// --account で明示した口座の判定。
async function judgeExplicitAccount(account, { readAccount, codexPath }) {
  const { label, usagePolicy: policy } = account;
  const reading = await readAccount(account);
  const lines = [formatVerdictLine(label, reading.word)];
  if (reading.word === VERDICT.credentialsUnavailable) {
    return refuse([...lines, EXEC_LINE.noCreds, formatRemoveGuidance(label)]);
  }
  if (codexPath === null) return refuse([...lines, formatCannotLaunch(CLIENT_IDENTITY_REASON.cliMissing)]);
  if (looksStopped(reading.observation, policy)) return refuse([...lines, EXEC_LINE.accountStopped]);
  if (reading.word === VERDICT.ok) return choose(account, lines);
  if (policy.blockWhenUnknown) {
    return refuse([...lines, EXEC_LINE.usageUnknownBlocked, ...guidanceLines(label, reading.word)]);
  }
  return choose(account, [...lines, formatUnknownUsageWarning(label, reading.word)]);
}

// --account を付けないときの選択。設定の並び順に読み、最初に選べた口座で止める。
async function selectFirstAvailable(accounts, { readAccount, codexPath }) {
  const lines = [];
  for (const account of accounts) {
    const reading = await readAccount(account);
    lines.push(formatVerdictLine(account.label, reading.word), ...guidanceLines(account.label, reading.word));
    if (codexPath !== null && selectableWithoutDaemon(reading, account.usagePolicy)) return choose(account, lines);
  }
  return refuse([...lines, EXEC_LINE.noAccountAvailable]);
}

/**
 * 常駐を使わずに口座を選ぶ。戻り値は決定 { ok: true, account, lines } か { ok: false, lines }。lines は
 * 標準エラーへこの順で出す行（判定の語の行・案内・警告・拒否の理由）。
 * @param {{ config: object, label: string|null, codexPath: string|null, readAccount: Function }} options
 *   label は --account のラベル（登録済みであることは呼出し元が確かめる）。
 */
export async function selectWithoutDaemon({ config, label, codexPath, readAccount }) {
  if (label !== null) {
    return judgeExplicitAccount(config.accounts.find(account => account.label === label), { readAccount, codexPath });
  }
  return selectFirstAvailable(config.accounts, { readAccount, codexPath });
}

// --- 口座の選択（常駐あり） ----------------------------------------------------------------------

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const staleDecision = () => refuse([EXEC_LINE.configStale, formatConfigStaleGuidance()]);
// 常駐の状態語が、login し直しで直るログイン切れか（no creds は登録を外してから login するので含めない）。
const needsLoginWord = stateWord => stateWord === 'needs login';
// 常駐の状態語（status と同じ12語）のどれかか。
const isStateWord = stateWord => typeof stateWord === 'string' && Object.hasOwn(CODEX_STATE_OF_WORD, stateWord);

// 要求関数を包み、最初に知らせた応答の状態コードを seen.status に残す（本文を読み終える前に分かる）。
function watchingStatus(request, seen) {
  return (...args) => {
    const req = request(...args);
    req.on('response', response => {
      if (seen.status !== null) return;
      try {
        seen.status = response.statusCode;
      } catch {
        // 読めなければ、状態コードは分からないまま。
      }
    });
    return req;
  };
}

// 常駐へ select を1回送る。200 なら { body }（本文が JSON でない・200 の本文を読み切れなかったときは body は
// null。200 のヘッダを受けた後に期限が切れたときも、読み切れなかったものとして null）、それ以外（トークンの
// ファイルが無い・読めない、ポートが使えない、届かない・応答のヘッダが来ないまま期限が切れた、200 でない
// 応答）は null。例外を投げない。
async function askDaemonToSelect({ port, label, env, request, readToken, timeoutMs }) {
  let token;
  try {
    token = await readToken({ env });
  } catch {
    return null;
  }
  const seen = { status: null };
  let response;
  try {
    response = await requestLocal({ request: watchingStatus(request, seen), port, path: CODEX_DAEMON_PATHS.select,
      method: 'POST', headers: { 'content-type': 'application/json', [CONTROL_TOKEN_HEADER]: token },
      body: JSON.stringify(label === null ? {} : { label }), timeoutMs, maxResponseBytes: DAEMON_ANSWER_MAX_BYTES });
  } catch {
    // 常駐は 200 で答えたが本文を読み切れなかった（上限を超えた・途中で切れた・200 のヘッダを受けた後、本文を
    // 読み終える前に期限が切れた）ときは、形の分からない応答として扱う（常駐が無いものとして1回読みへ移らない。
    // 常駐は選んだ記録を残しているので、1回読みで別の口座を選ばない）。
    return seen.status === 200 ? { body: null } : null;
  }
  if (response.status !== 200) return null;
  try {
    return { body: JSON.parse(response.body) };
  } catch {
    return { body: null };
  }
}

// 明示した口座を常駐が選ばなかったときの行。知らない理由の語なら null。
function daemonRefusalLines(label, answer) {
  switch (answer.refusal) {
    case CODEX_SELECT_REFUSAL.accountStopped:
      return [EXEC_LINE.accountStopped];
    case CODEX_SELECT_REFUSAL.usageUnknown:
      return [EXEC_LINE.usageUnknownBlocked, ...(needsLoginWord(answer.stateWord) ? [formatReloginGuidance(label)] : [])];
    case CODEX_SELECT_REFUSAL.noCreds:
      return [EXEC_LINE.noCreds, formatRemoveGuidance(label)];
    default:
      return null;
  }
}

// 常駐が使用量の分からない口座を選んだときの警告（分かっていれば行は無い）。login し直しの案内は、明示の
// 口座で状態語が needs login のときだけ（最後の手段の状態語は unread か starting）。
function daemonSelectionLines(label, answer) {
  if (answer.usageKnown === true) return [];
  if (answer.lastResort === true) return [formatLastResortWarning(label)];
  return [unknownUsageWarning(label, needsLoginWord(answer.stateWord))];
}

// 「選んだ」の応答の形が分かるか: usageKnown と lastResort が真偽で、stateWord が状態語のどれか。
const isSelectionShape = answer => typeof answer.usageKnown === 'boolean' && typeof answer.lastResort === 'boolean'
  && isStateWord(answer.stateWord);

// 常駐が「選んだ」と答えうる組（常駐の select の判定と、状態の JSON の next の規則による）:
//   - 使用量が分かっている口座（自動の選べる口座・明示の口座）: lastResort が偽で、状態語は ready。
//   - 明示の口座を使用量が分からないまま選んだ: lastResort が偽で、状態語は needs login・no models・unread・
//     starting のどれか（停止中と no creds は断る。reserved は blockWhenUnknown が真の口座なので断る）。
//   - 自動の選択の最後の手段: lastResort が真・usageKnown が偽で、状態語は unread か starting（使える状態で、
//     使用量だけが分からない口座。blockWhenUnknown が真の口座は選ばない）。
// no creds と停止の類（4つの状態の exhausted に写る語）は、どの組にも入らない。
const SELECTED_STATE_WORDS = Object.freeze({
  usageKnown: new Set(['ready']),
  explicitUnknown: new Set(['needs login', 'no models', 'unread', 'starting']),
  lastResort: new Set(['unread', 'starting']),
});

// 「選んだ」の組が、常駐が返しうる組か（label は --account のラベル。無ければ null）。使用量が分からないまま
// 選んだと答えたのに、自分の設定のその口座の blockWhenUnknown が真なら、自分の設定では選ばない口座なので偽。
function isReturnableSelection(account, answer, label) {
  const { usageKnown, lastResort, stateWord } = answer;
  if (usageKnown) return !lastResort && SELECTED_STATE_WORDS.usageKnown.has(stateWord);
  if (account.usagePolicy?.blockWhenUnknown === true) return false;
  if (label !== null) return !lastResort && SELECTED_STATE_WORDS.explicitUnknown.has(stateWord);
  return lastResort && SELECTED_STATE_WORDS.lastResort.has(stateWord);
}

// 「選んだ」の応答を、自分の設定の口座と照らして決定にする。形が分からない、または常駐が返しうる組でなければ
// config stale（起動しない。資格情報が無い口座・停止中の口座など、常駐が選んだとは答えない組のまま起動しないため）。
function decideSelection(account, answer, label) {
  if (!isSelectionShape(answer) || !isReturnableSelection(account, answer, label)) return staleDecision();
  return choose(account, daemonSelectionLines(account.label, answer));
}

/**
 * 常駐の select の 200 の応答を、自分で読んだ設定と照らして決定にする。値が無い・形が違う・自分の読込みの
 * sha256 と違う、ラベルが自分の設定に無い（label があるときは明示したラベルと違う）、判定の形が分からない、
 * 「選んだ」の組が常駐の返しうる組でない（自分の設定では選ばない口座を含む）ときは config stale の拒否。
 * 起動する口座は、自分の設定の口座（応答のほかのキーは使わない）。
 * @param {unknown} answer 応答の本文を JSON として読んだ値（読めなければ null）
 * @param {{ config: object, configSha256: string, label: string|null }} own
 */
export function decideFromDaemonAnswer(answer, { config, configSha256, label }) {
  if (!isPlainObject(answer)) return staleDecision();
  const sha256 = answer.configSha256;
  if (typeof sha256 !== 'string' || !CONFIG_SHA256_PATTERN.test(sha256) || sha256 !== configSha256) return staleDecision();
  const account = typeof answer.label === 'string' ? config.accounts.find(entry => entry.label === answer.label) : undefined;
  const matchesRequest = account !== undefined && (label === null || account.label === label);
  switch (answer.outcome) {
    case CODEX_SELECT_OUTCOME.selected:
      return matchesRequest ? decideSelection(account, answer, label) : staleDecision();
    case CODEX_SELECT_OUTCOME.refused: {
      const lines = label !== null && matchesRequest ? daemonRefusalLines(label, answer) : null;
      return lines === null ? staleDecision() : refuse(lines);
    }
    case CODEX_SELECT_OUTCOME.none:
      return label === null ? refuse([EXEC_LINE.noAccountAvailable]) : staleDecision();
    default:
      // unknown-label（自分の設定にはあるラベルを常駐の世代が知らない）と、知らない判定の語。
      return staleDecision();
  }
}

/**
 * 常駐に口座を選ばせる（runExec の consultDaemon の既定）。常駐が無ければ null、200 で答えたら
 * decideFromDaemonAnswer の決定を返す。例外を投げない。
 * @param {{ config: object, configSha256: string, label: string|null, env: object }} options
 * @param {{ request?: Function, readToken?: Function, timeoutMs?: number }} [deps] request は http.request と
 *   同じ呼び方の関数、readToken は制御トークンを読む関数（既定は control-token.js の readControlToken）
 * @returns {Promise<{ ok: boolean, account?: object, lines: string[] }|null>}
 */
export async function consultDaemonSelect({ config, configSha256, label, env },
  { request = httpRequest, readToken = readControlToken, timeoutMs = EXEC_DAEMON_TIMEOUT_MS } = {}) {
  const reply = await askDaemonToSelect({ port: config?.daemon?.port, label, env, request, readToken, timeoutMs });
  return reply === null ? null : decideFromDaemonAnswer(reply.body, { config, configSha256, label });
}

// --- 起動とシグナル ------------------------------------------------------------------------------

const processSignals = Object.freeze({
  on: (signal, handler) => process.on(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
});
const raiseOnSelf = signal => process.kill(process.pid, signal);

/**
 * 子を起動し、終わるまで待つ。子が生きている間だけ FORWARDED_SIGNALS の受け口を付けて子へ転送する。
 * 子が終了コードで終われば、その値を返す。シグナルで終われば、受け口を外してから raiseSignal で同じ
 * シグナルを自分へ当て直し、128＋シグナルの番号を返す。起動できなければ launch failed で 1。
 * @returns {Promise<number>}
 */
export function launchAndRelay(launch, { spawn = spawnChild, signals = processSignals, raiseSignal = raiseOnSelf,
  say = () => {} } = {}) {
  return new Promise(resolveExit => {
    const handlers = new Map();
    let settled = false;
    const detach = () => {
      for (const [signal, handler] of handlers) {
        try { signals.off(signal, handler); } catch { /* 外せなくても終了コードは変えない */ }
      }
      handlers.clear();
    };
    const finish = code => {
      if (settled) return;
      settled = true;
      detach();
      resolveExit(code);
    };
    const failed = () => {
      say(EXEC_LINE.launchFailed);
      finish(EXEC_REFUSED_EXIT_CODE);
    };
    let child;
    try {
      child = spawn(launch.command, [...launch.args], { ...launch.options, stdio: 'inherit' });
    } catch {
      failed();
      return;
    }
    if (typeof child?.on !== 'function') {
      failed();
      return;
    }
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        try { child.kill(signal); } catch { /* 子が既に終わっていれば送れなくてよい */ }
      };
      handlers.set(signal, handler);
      signals.on(signal, handler);
    }
    // error は起動できなかったときのほか、転送の kill が失敗したときにも届く。起動できていれば
    // （pid があれば）子の終わりを待つ。
    child.on('error', () => {
      if (child.pid === undefined) failed();
    });
    child.on('close', (code, signal) => {
      if (Number.isInteger(code)) {
        finish(code);
        return;
      }
      if (typeof signal === 'string') {
        detach();
        try { raiseSignal(signal); } catch { /* 当て直せなくても、下の終了コードで伝える */ }
        finish(128 + (osConstants.signals[signal] ?? 0));
        return;
      }
      finish(EXEC_REFUSED_EXIT_CODE);
    });
  });
}

// --- 入口 ----------------------------------------------------------------------------------------

/**
 * `codex-rotator exec` の入口（cli.js の取り決めの runExec(argv, io)）。
 * @param {string[]} argv exec の後ろの引数
 * @param {{ stdout?: object, stderr?: object, env?: object }} [io] exec 自身は stdout に書かない
 * @param {{
 *   spawn?: Function, loadConfigSnapshot?: Function, findCodex?: Function, platform?: string,
 *   readVersion?: Function, readCredentials?: Function, readUsage?: Function, fetchImpl?: typeof fetch,
 *   now?: () => number, consultDaemon?: Function, request?: Function, readControlToken?: Function,
 *   signals?: { on: Function, off: Function }, raiseSignal?: (signal: string) => void,
 *   processCwd?: () => string, realpath?: (path: string) => string, scheduler?: object,
 * }} [deps] 差し替えの部品（テストのため）。省いたものは本物を使う。request と readControlToken は、
 *   consultDaemon を省いたときの consultDaemonSelect へ渡す。
 * @returns {Promise<number>} 終了コード
 */
export async function runExec(argv = [], io = {}, deps = {}) {
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const say = line => stderr.write(`${line}\n`);
  const {
    spawn = spawnChild, loadConfigSnapshot = loadCodexConfigSnapshot, findCodex = findRealCodex,
    platform = process.platform, processCwd = () => process.cwd(), realpath = realpathSync.native, scheduler,
    signals, raiseSignal,
    consultDaemon = options => consultDaemonSelect(options, { request: deps.request, readToken: deps.readControlToken }),
  } = deps;

  const parsed = parseExecArgs(argv);
  if (!parsed.ok) {
    say(EXEC_USAGE);
    return EXEC_USAGE_EXIT_CODE;
  }
  let snapshot;
  try {
    snapshot = await loadConfigSnapshot({ env });
  } catch {
    say(EXEC_LINE.configUnreadable);
    return EXEC_REFUSED_EXIT_CODE;
  }
  const config = snapshot?.config ?? null;
  if (!isCodexRotatorActivated(config)) {
    say(EXEC_LINE.disabled);
    return EXEC_REFUSED_EXIT_CODE;
  }
  const form = matchLaunchForm(parsed.codexArgs, { caller: LAUNCH_CALLER.exec });
  if (!form.ok) {
    say(formatArgumentRejected(form.reason));
    return EXEC_REFUSED_EXIT_CODE;
  }
  if (parsed.account !== null && !config.accounts.some(account => account.label === parsed.account)) {
    say(EXEC_LINE.accountNotRegistered);
    return EXEC_REFUSED_EXIT_CODE;
  }

  const codexPath = findCodex({ codexPath: config.codexPath, env, platform }).path ?? null;
  const readAccount = createOneShotUsageReader({ config, codexPath, spawn, readVersion: deps.readVersion,
    readCredentials: deps.readCredentials, readUsage: deps.readUsage, fetchImpl: deps.fetchImpl, now: deps.now });
  // Codex CLI が見つからなければ起動するものが無いので、常駐に選ばせない（常駐に選んだ記録を残さない）。
  const daemonDecision = codexPath === null ? null
    : await consultDaemon({ config, configSha256: snapshot.sha256, label: parsed.account, env });
  const decision = daemonDecision ?? await selectWithoutDaemon({ config, label: parsed.account, codexPath, readAccount });
  for (const line of decision.lines) say(line);
  if (!decision.ok) return EXEC_REFUSED_EXIT_CODE;
  if (codexPath === null) {
    say(formatCannotLaunch(CLIENT_IDENTITY_REASON.cliMissing));
    return EXEC_REFUSED_EXIT_CODE;
  }

  const prepared = await prepareGuardedLaunch({ args: parsed.codexArgs, caller: LAUNCH_CALLER.exec, codexPath,
    codexHome: decision.account.codexHome, env, spawn, scheduler, processCwd, realpath });
  if (!prepared.ok) {
    say(prepared.kind === ARGUMENT_REJECTED_KIND ? formatArgumentRejected(prepared.reason) : formatGuardUnverified(prepared.reason));
    return EXEC_REFUSED_EXIT_CODE;
  }
  return launchAndRelay(prepared.launch, { spawn, signals, raiseSignal, say });
}
