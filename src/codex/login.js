// `codex-rotator login`: 新しい Codex の口座を、口座ごとのフォルダへ login させて設定へ登録する。
//
//   codex-rotator login --label <name> --stop <percent> --resume <percent> [--block-when-unknown]
//
// 流れ（前の手順が通らなければ、次の手順へ進まない）:
//   1. 引数と使用量の方針を検証する。ここで落ちたら、口座のフォルダを作らず、対話ログインも
//      起動せずに 2 で終わる。
//   2. 設定を1回読み（loadCodexConfigSnapshot）、次を確かめる。どれかが通らなければ、フォルダを
//      作らず対話ログインも起動せずに 1 で終わる。
//      - ラベルがまだ登録されていない。
//      - 新しい口座のフォルダ（accountsDir の直下に、accounts-dir.js の名付け方で作るもの）が、
//        ~/.codex（渡された env の HOME から求めた実パス）とも、登録済みの口座のフォルダとも
//        重ならない（同じ・含む・含まれる）。
//      - 渡された env の CODEX_HOME が空でなければ、それが絶対パスで、accountsDir・登録済みの
//        口座のフォルダ・新しい口座のフォルダのどれとも重ならない（シェルの CODEX_HOME が口座の
//        フォルダを指していると、素の codex の起動が口座の資格情報を書き換えるため）。実パスは、
//        設定の重なりの検査と同じ関数（canonicalPath。まだ無いパスでも求められる）で求める。
//      - 本物の codex の絶対パスが見つかる（real-codex.js。素の名前の codex は起動しない）。
//      - 登録済みの口座の資格情報が、どれも読める（読めない口座があると、新しい口座がそれと同じかを
//        確かめられない）。読めなければ、読めない口座のラベル（検証済みの設定の値。設定の並びの順）を
//        並べた1行と、その口座の登録を外してから新しいフォルダで入り直すよう案内する1行も出す
//        （login し直しは前の資格情報が読めないと始めないので、案内しない）。
//   3. 口座のフォルダを新しく作り、login が書く config.toml を置く（accounts-dir.js）。作る前に、
//      login し直しの c と同じ規則でシグナルの受け口を付け、コマンドが終わるときに外す（作っている
//      間に受けたシグナルでも親は終わらず、フォルダを残したことを出せるようにするため）。
//   4. そのフォルダを CODEX_HOME にして `codex -c cli_auth_credentials_store="file" login` を
//      起動し、終わるのを待つ（標準入出力は利用者の端末につなぐ）。子がシグナルで終わったときも、
//      ほかの失敗と同じく設定を変えずに 1 で終わる。
//   5. そのフォルダの資格情報を読み、口座の識別子のハッシュ（使用量の読取と同じ関数）を、登録済みの
//      ほかの口座のものと比べる。同じなら登録しない。ほかの口座の資格情報がこの時点で読めなければ、
//      2 と同じく止めて案内する。識別子とハッシュはメモリの中だけで比べ、出さない・書かない。
//   6. 設定へ口座を1件追記する（appendCodexAccount。1回目は設定を作る）。追記は、2 で読んだときの
//      sha256 と今のファイルが同じときだけ行い、失敗しても元のファイルは変わらない。
// 設定を書き換えるのは 6 だけなので、失敗したときは必ず「設定は変えていない」と出す。3 の後で
// 失敗したときは、作ったフォルダを消さずに残し、登録していないことを出す。
// 標準出力には何も書かない（子の codex の出力だけが流れる）。標準エラーに出す行は、パス・
// 口座の識別子・資格情報の値を含めない。
//
// login し直し（ログインが切れた登録済みの口座を、同じラベル・同じフォルダへ login し直す）:
//
//   codex-rotator login --label <登録済みのラベル> --relogin
//
//   a. --relogin は方針の引数（--stop・--resume・--block-when-unknown）と一緒に受けない（2 で終わる）。
//      ラベルが登録されていない・CODEX_HOME が口座の場所と重なる・codex が無いときは、ログインを
//      始めずに 1 で終わる。設定（ラベル・フォルダ・方針）は変えず、新しいフォルダも作らない。
//   b. login の前に、そのフォルダの資格情報から口座の識別子のハッシュを求める。求められなければ、
//      口座が同じかを確かめられないので、ログインを始めずに `account unverified` で 1 で終わる。
//   c. SIGINT・SIGQUIT・SIGHUP・SIGTERM の受け口を1つずつ付けてから、そのフォルダを CODEX_HOME に
//      して対話ログインを起動する。受け口はコマンドが終わるまで外さない。その間に受けたシグナルは、
//      起動中の子（login か logout）があればその子へ同じ名前で送り、子が無ければ何もしない。
//      親はシグナルでは終わらず、自分へシグナルを当て直すこともしない。
//   d. 子の終わり方（0・0以外・シグナル・起動できない）によらず、子が終わった後に、login の後の
//      ハッシュを求め、前のハッシュと、登録済みのほかの口座のハッシュと比べる（メモリの中だけ）。
//      - 読めない: 設定からそのラベルを外し（logout は起動しない）、`account unverified`。
//      - ほかの口座と同じ: 設定から外し、logout を起動し、`account duplicate`。
//      - 前と違う: 設定から外し、logout を起動し、`account changed`。
//      - 前と同じ: 子が 0 で終わっていれば 0、そうでなければ設定を変えずに 1。
//      外すのは logout より先に行い、フォルダは消さない。logout が失敗したら語の後ろに
//      ` (logout failed)`、外す書込みが失敗したら ` (remove failed)` を付け、次に行うことの案内を
//      1行出す。最後に、比べた結果の終了コードで終了の関数を呼ぶ。
//
// 部品の差し替え（第3引数 deps）: spawn（子の起動）・readCredentials（資格情報の読取）・
// findCodex（本物の codex の探索）・randomUUID（フォルダの名前）・accountDirFileOps・
// configFileOps（書込みの失敗を起こすため）・signals（シグナルの受け口。on・removeListener を
// 持つもの。既定は process。新規の login と login し直しの両方で使う）・exit（終了の関数。既定は
// process.exitCode に入れる。呼ぶのは login し直しだけ）・logoutTimeoutMs（logout の子の期限）。
// 省いたものは本物を使う。
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { FIRST_LAYER_ARGS } from './account-config.js';
import { AccountsDirError, accountDirPath, createAccountDir, newAccountDirName } from './accounts-dir.js';
import {
  CODEX_ACCOUNT_LABEL, CodexConfigError, appendCodexAccount, canonicalPath, comparisonKey,
  loadCodexConfigSnapshot, pathsOverlap, removeCodexAccount, validateCodexConfig,
} from './config.js';
import { readCodexCredentials } from './credentials.js';
import { CodexPathsError, defaultCodexHome } from './paths.js';
import { findRealCodex } from './real-codex.js';

export const LOGIN_USAGE = 'usage: codex-rotator login --label <name> --stop <percent> --resume <percent> [--block-when-unknown]'
  + ' | codex-rotator login --label <name> --relogin';

export const LOGIN_EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

/** 資格情報の保存先をファイルにする指定（第1層の先頭の2語と同じ）。 */
export const CREDENTIALS_STORE_ARGS = Object.freeze(FIRST_LAYER_ARGS.slice(0, 2));
/** 対話ログインの子に渡す引数。 */
export const LOGIN_CHILD_ARGS = Object.freeze([...CREDENTIALS_STORE_ARGS, 'login']);
/** login し直しで口座が違ったときに起動する logout の子の引数。 */
export const LOGOUT_CHILD_ARGS = Object.freeze([...CREDENTIALS_STORE_ARGS, 'logout']);
/** logout の子の期限（ミリ秒）。過ぎたら子を止めて logout の失敗として扱う。 */
export const CODEX_LOGOUT_TIMEOUT_MS = 10000;
/**
 * 受け口を付けている間（新規の login は口座のフォルダを作る前から、login し直しは login の子を起動する
 * 前から、どちらもコマンドの終わりまで）、
 * 親が受けて起動中の子へ送るシグナル。
 */
export const RELOGIN_SIGNALS = Object.freeze(['SIGINT', 'SIGQUIT', 'SIGHUP', 'SIGTERM']);
/** 口座のフォルダの中の資格情報ファイルの名前（Codex CLI がファイルの保存先に書くもの）。 */
export const CREDENTIALS_FILE_NAME = 'auth.json';

/** 対話ログインの子の終わり方。 */
export const LOGIN_CHILD_OUTCOME = Object.freeze({
  ok: 'ok', // 0 で終わった
  exit: 'exit', // 0 以外で終わった
  signal: 'signal', // シグナルで終わった
  notStarted: 'not-started', // 起動できなかった
});

const PREFIX = 'codex-rotator login: ';
export const CONFIG_UNCHANGED_LINE = `${PREFIX}the codex-rotator config was not changed.`;
export const FOLDER_LEFT_LINE = `${PREFIX}the new account folder was left in place; it is not registered.`;
export const REGISTERED_LINE = `${PREFIX}registered the new account in the codex-rotator config.`;
export const CONFIG_CREATED_LINE = `${PREFIX}created the codex-rotator config with enabled and acknowledgedMultiAccountRisk set to false;`
  + ' read the README section on the risks of using several accounts, and only then set both to true by hand to start switching accounts.';
// 登録済みの口座の資格情報が読めずに止めたとき。読めない口座のラベルを並べる行の書き出しと、案内の行。
// ラベルは検証済みの設定の値（a-z・0-9・_・- だけ）なので、そのまま並べる。パス・値・ハッシュは出さない。
export const UNREADABLE_ACCOUNTS_LINE_START = `${PREFIX}registered accounts whose credentials cannot be read: `;
export const OTHER_CREDENTIALS_HINT_LINE = `${PREFIX}for each of these accounts, run "codex-rotator remove --label <label>" and then log in with`
  + ' "codex-rotator login --label <label> --stop <percent> --resume <percent>" (a new folder is made).';

/** 読めない口座のラベルを、渡された順に並べた1行。 */
export function unreadableAccountsLine(labels) {
  return `${UNREADABLE_ACCOUNTS_LINE_START}${labels.join(', ')}`;
}
export const RELOAD_HINT_LINE = `${PREFIX}if the codex-rotator daemon is running, run "codex-rotator reload" so that it reads the changed config.`;

// login し直しの判定の語と、その後ろに付ける印。
export const RELOGIN_WORD = Object.freeze({
  changed: 'account changed',
  duplicate: 'account duplicate',
  unverified: 'account unverified',
});
export const RELOGIN_MARK = Object.freeze({ logoutFailed: ' (logout failed)', removeFailed: ' (remove failed)' });
export const RELOGIN_OK_LINE = `${PREFIX}logged in again to the same account; the codex-rotator config was not changed.`;
// login の前の資格情報が読めないとき（ログインは始めていない）。
export const RELOGIN_UNVERIFIED_BEFORE_LINE = `${PREFIX}the account in this folder cannot be verified without its current credentials, so login was not started;`
  + ' run "codex-rotator remove --label <label>" and then log in with'
  + ' "codex-rotator login --label <label> --stop <percent> --resume <percent>" (a new folder is made).';
// 当方が設定からラベルを外せたとき。
export const RELOGIN_REMOVED_LINE = `${PREFIX}the label was removed from the codex-rotator config and its folder was left in place;`
  + ' log in to the correct account with "codex-rotator login --label <label> --stop <percent> --resume <percent>" (a new folder is made),'
  + ' remove the unregistered folder with "codex-rotator purge",'
  + ' and if the codex-rotator daemon is running, run "codex-rotator reload".';
// 外す書込みが失敗したとき（登録は残っている）。
export const RELOGIN_REMOVE_FAILED_LINE = `${PREFIX}the label is still registered; first set "enabled" to false in the codex-rotator config to stop account switching,`
  + ' do not use the label and do not log in if Codex shows its own login screen,'
  + ' then run "codex-rotator remove --label <label>", set "enabled" back to true and run "codex-rotator reload".';

// 失敗の理由の文（パスも値も含めない）。
export const LOGIN_FAILURE = Object.freeze({
  labelRegistered: 'the label is already registered',
  labelNotRegistered: 'the label is not registered; --relogin logs in again only to a registered account',
  overlapsDefaultCodexHome: 'the new account folder would overlap ~/.codex',
  overlapsAccount: 'the new account folder would overlap a registered account folder',
  codexHomeRelative: 'CODEX_HOME is a relative path; set it to an absolute path or unset it',
  codexHomeOverlaps: 'CODEX_HOME overlaps accountsDir or an account folder; unset it or point it elsewhere',
  codexMissing: 'the Codex CLI (codex) was not found',
  childNotStarted: 'codex login could not be started',
  childFailed: 'codex login did not finish successfully',
  childSignaled: 'codex login was ended by a signal',
  credentialsUnreadable: 'the credentials that codex login wrote could not be read as file credentials',
  otherCredentialsUnreadable: 'the credentials of a registered account could not be read, so a duplicate account cannot be ruled out',
  duplicateAccount: 'this account is already registered under another label',
  unexpected: 'an unexpected error occurred (details are withheld)',
});

// hints は、止めた理由の行などの後に、この順で出す行（無ければ空）。
class LoginError extends Error {
  constructor(message, { hints = [] } = {}) {
    super(message);
    this.name = 'LoginError';
    this.hints = hints;
  }
}

// --- 引数 --------------------------------------------------------------------------------------

const VALUE_OPTIONS = Object.freeze({ '--label': 'label', '--stop': 'stop', '--resume': 'resume' });
const FLAG_OPTIONS = Object.freeze({ '--block-when-unknown': 'blockWhenUnknown', '--relogin': 'relogin' });
// login し直しでは受けない、使用量の方針の引数（設定の方針は変えないため）。
const POLICY_KEYS = Object.freeze(['stop', 'resume', 'blockWhenUnknown']);
const LABEL_PROBLEM = '--label must be 1 to 32 characters of a-z, 0-9, _ and -, starting with a-z or 0-9';
// 百分率の書き方（10進の数。符号・指数・16進は受けない）。
const PERCENT_PATTERN = /^\d{1,3}(?:\.\d{1,6})?$/;

function percent(value) {
  return typeof value === 'string' && PERCENT_PATTERN.test(value) ? Number(value) : null;
}

/**
 * 使用量の方針の検証（設定の検証と同じ規則: 0 < stop <= 100、0 <= resume < stop）。
 * @returns {string|null} 通らない理由。通れば null
 */
export function usagePolicyProblem(stop, resume) {
  if (stop === null || !(stop > 0 && stop <= 100)) return '--stop must be a number greater than 0 and at most 100';
  if (resume === null || !(resume >= 0 && resume < stop)) return '--resume must be a number from 0 up to, but not including, --stop';
  return null;
}

/**
 * login の引数を読む。値を取る指定と真偽の指定は、それぞれ1回まで。--relogin のときは --label だけを
 * 受け、options は { label, relogin: true } になる。
 * @param {string[]} argv 副コマンドの語を含まない引数
 * @returns {{ ok: true, options: { label: string, usagePolicy?: object, relogin?: true } } | { ok: false, problem: string }}
 */
export function parseLoginArgs(argv) {
  if (!Array.isArray(argv)) return { ok: false, problem: 'arguments must be a list' };
  const seen = {};
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (Object.hasOwn(FLAG_OPTIONS, word)) {
      const key = FLAG_OPTIONS[word];
      if (Object.hasOwn(seen, key)) return { ok: false, problem: `${word} is given more than once` };
      seen[key] = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_OPTIONS, word)) return { ok: false, problem: 'an unknown argument was given' };
    const key = VALUE_OPTIONS[word];
    if (Object.hasOwn(seen, key)) return { ok: false, problem: `${word} is given more than once` };
    if (index + 1 >= argv.length) return { ok: false, problem: `${word} needs a value` };
    seen[key] = argv[++index];
  }
  if (seen.relogin === true) {
    if (POLICY_KEYS.some(key => Object.hasOwn(seen, key))) {
      return { ok: false, problem: '--relogin cannot be combined with --stop, --resume or --block-when-unknown' };
    }
    if (!Object.hasOwn(seen, 'label')) return { ok: false, problem: '--label is required' };
    if (!CODEX_ACCOUNT_LABEL.test(seen.label)) return { ok: false, problem: LABEL_PROBLEM };
    return { ok: true, options: { label: seen.label, relogin: true } };
  }
  for (const [word, key] of Object.entries(VALUE_OPTIONS)) {
    if (!Object.hasOwn(seen, key)) return { ok: false, problem: `${word} is required` };
  }
  if (typeof seen.label !== 'string' || !CODEX_ACCOUNT_LABEL.test(seen.label)) {
    return { ok: false, problem: LABEL_PROBLEM };
  }
  const stop = percent(seen.stop);
  const resume = percent(seen.resume);
  const problem = usagePolicyProblem(stop, resume);
  if (problem) return { ok: false, problem };
  return {
    ok: true,
    options: {
      label: seen.label,
      usagePolicy: { stopUsedPercent: stop, resumeUsedPercent: resume, blockWhenUnknown: seen.blockWhenUnknown === true },
    },
  };
}

// --- 事前の確かめ --------------------------------------------------------------------------------

function comparable(path, where) {
  return comparisonKey(canonicalPath(path, { where }));
}

/**
 * 渡された env の CODEX_HOME が、口座のフォルダの場所と重ならないことを確かめる。
 * 未設定・空なら確かめない。相対パスと、実パスに直せない値（行き先の無いリンク）は拒否する。
 * @param {object} env
 * @param {string[]} places accountsDir・登録済みの口座のフォルダ・新しい口座のフォルダ
 */
export function assertCodexHomeEnvSeparate(env, places) {
  const value = env?.CODEX_HOME;
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !isAbsolute(value)) throw new LoginError(LOGIN_FAILURE.codexHomeRelative);
  const codexHome = comparable(value, 'CODEX_HOME');
  if (places.some(place => pathsOverlap(codexHome, comparable(place, 'an account folder')))) {
    throw new LoginError(LOGIN_FAILURE.codexHomeOverlaps);
  }
}

async function preflight({ label }, env, deps) {
  const snapshot = await loadCodexConfigSnapshot({ env });
  // 設定が無いときは既定値の設定で確かめる（既定の accountsDir と ~/.codex の重なりもここで落ちる）。
  const config = snapshot?.config ?? validateCodexConfig({}, { env });
  if (config.accounts.some(account => account.label === label)) throw new LoginError(LOGIN_FAILURE.labelRegistered);
  const name = newAccountDirName({ randomUUID: deps.randomUUID });
  const home = accountDirPath(config.accountsDir, name);
  const homeKey = comparable(home, 'the new account folder');
  if (pathsOverlap(homeKey, comparable(defaultCodexHome(env), '~/.codex'))) {
    throw new LoginError(LOGIN_FAILURE.overlapsDefaultCodexHome);
  }
  const accountHomes = config.accounts.map(account => account.codexHome);
  if (accountHomes.some(other => pathsOverlap(homeKey, comparable(other, 'an account folder')))) {
    throw new LoginError(LOGIN_FAILURE.overlapsAccount);
  }
  assertCodexHomeEnvSeparate(env, [config.accountsDir, ...accountHomes, home]);
  const codex = deps.findCodex({ codexPath: config.codexPath, env });
  if (typeof codex?.path !== 'string' || !isAbsolute(codex.path)) throw new LoginError(LOGIN_FAILURE.codexMissing);
  await assertRegisteredAccountsReadable(config.accounts, deps.readCredentials);
  return { snapshot, config, name, home, codexPath: codex.path };
}

// --- 対話ログインの子 ------------------------------------------------------------------------------

// logout の子が期限内に終わらなかったこと（対話ログインの子の終わり方には無い）。
const CHILD_TIMED_OUT = 'timed-out';

// 口座のフォルダを CODEX_HOME にして codex を起動し、終わり方を返す（例外にしない）。
// onRunning は、子が動いている間はその子、終わったら null で呼ばれる（シグナルの送り先に使う）。
// timeoutMs を渡すと、その時間で子を SIGKILL で止めて CHILD_TIMED_OUT を返す。
function runCodexChild({ spawnImpl, codexPath, args, codexHome, env, stdio, onRunning = () => {}, timeoutMs = null }) {
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const settle = (outcome, code = null, signal = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      onRunning(null);
      resolve({ outcome, code, signal });
    };
    let child;
    try {
      child = spawnImpl(codexPath, [...args], { env: { ...env, CODEX_HOME: codexHome }, stdio, shell: false });
    } catch {
      settle(LOGIN_CHILD_OUTCOME.notStarted);
      return;
    }
    if (typeof child?.on !== 'function' || typeof child?.once !== 'function') {
      settle(LOGIN_CHILD_OUTCOME.notStarted);
      return;
    }
    // 'error' は、起動できなかったときのほか、起動した後（シグナルを送れなかったときなど）にも来る。
    // 起動できなかった（pid が無い）ときだけ起動できなかったものとして決め、起動した後の 'error' では
    // 決めずに 'exit' を待つ。何回来ても親が落ちないよう、一度で外れない受け口で受ける。
    child.on('error', () => {
      if (!Number.isInteger(child.pid)) settle(LOGIN_CHILD_OUTCOME.notStarted);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) settle(LOGIN_CHILD_OUTCOME.ok, 0, null);
      else if (typeof signal === 'string') settle(LOGIN_CHILD_OUTCOME.signal, null, signal);
      else settle(LOGIN_CHILD_OUTCOME.exit, Number.isInteger(code) ? code : null, null);
    });
    onRunning(child);
    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 止められなくても、期限切れとして扱う。
        }
        settle(CHILD_TIMED_OUT);
      }, timeoutMs);
    }
  });
}

/**
 * 口座のフォルダを CODEX_HOME にして対話ログインを起動し、終わり方を返す（例外にしない）。
 * 渡された env は変えない（子へ渡すのは写しに CODEX_HOME を足したもの）。
 * onRunning は、子が動いている間はその子、終わったら null で呼ばれる（省いてよい）。
 * @returns {Promise<{ outcome: string, code: number|null, signal: string|null }>}
 */
export function runLoginChild({ spawn: spawnImpl, codexPath, codexHome, env, onRunning }) {
  return runCodexChild({ spawnImpl, codexPath, args: LOGIN_CHILD_ARGS, codexHome, env, stdio: 'inherit', onRunning });
}

const CHILD_FAILURE = Object.freeze({
  [LOGIN_CHILD_OUTCOME.exit]: LOGIN_FAILURE.childFailed,
  [LOGIN_CHILD_OUTCOME.signal]: LOGIN_FAILURE.childSignaled,
  [LOGIN_CHILD_OUTCOME.notStarted]: LOGIN_FAILURE.childNotStarted,
});

// --- 口座の同一性 -----------------------------------------------------------------------------------

/**
 * 口座のフォルダの資格情報から、口座の識別子のハッシュを求める。読めなければ null（理由は出さない）。
 * @returns {Promise<string|null>}
 */
export async function readAccountIdHash(codexHome, readCredentials) {
  try {
    const identity = await readCredentials(join(codexHome, CREDENTIALS_FILE_NAME));
    return typeof identity?.accountIdHash === 'string' && identity.accountIdHash !== '' ? identity.accountIdHash : null;
  } catch {
    return null;
  }
}

// 登録済みの口座の資格情報が読めないときの止め方（読めない口座のラベルの行と、登録を外してから
// 新しいフォルダで入り直す案内を付ける）。
function otherCredentialsUnreadable(labels) {
  return new LoginError(LOGIN_FAILURE.otherCredentialsUnreadable, {
    hints: [unreadableAccountsLine(labels), OTHER_CREDENTIALS_HINT_LINE],
  });
}

// 資格情報が読めない口座のラベルを、設定の並びの順で集める。
async function unreadableLabels(accounts, readCredentials) {
  const labels = [];
  for (const account of accounts) {
    if (await readAccountIdHash(account.codexHome, readCredentials) === null) labels.push(account.label);
  }
  return labels;
}

// 事前の確かめ（フォルダを作る前・対話ログインの前）: 登録済みの口座の資格情報が、どれも読める。
async function assertRegisteredAccountsReadable(accounts, readCredentials) {
  const labels = await unreadableLabels(accounts, readCredentials);
  if (labels.length > 0) throw otherCredentialsUnreadable(labels);
}

// 設定の並びの順に比べ、先に当たったもので決める（読めない口座が先なら、残りの口座からは読めない
// ラベルだけを集める）。
async function assertNewAccount(home, accounts, readCredentials) {
  const hash = await readAccountIdHash(home, readCredentials);
  if (hash === null) throw new LoginError(LOGIN_FAILURE.credentialsUnreadable);
  for (const [index, account] of accounts.entries()) {
    const other = await readAccountIdHash(account.codexHome, readCredentials);
    if (other === null) {
      const rest = await unreadableLabels(accounts.slice(index + 1), readCredentials);
      throw otherCredentialsUnreadable([account.label, ...rest]);
    }
    if (other === hash) throw new LoginError(LOGIN_FAILURE.duplicateAccount);
  }
}

// --- 本体 -----------------------------------------------------------------------------------------

function setExitCode(code) {
  process.exitCode = code;
}

/**
 * 差し替えの部品を、省いたものを本物で補って返す（既定のシグナルの受け口は process）。
 * 受け口を付けるのは本体（新規の login と login し直し）で、この関数は何も付けない。
 */
export function resolveLoginDeps(deps = {}) {
  return {
    spawn: deps.spawn ?? spawn,
    readCredentials: deps.readCredentials ?? readCodexCredentials,
    findCodex: deps.findCodex ?? findRealCodex,
    randomUUID: deps.randomUUID,
    accountDirFileOps: deps.accountDirFileOps ?? {},
    configFileOps: deps.configFileOps ?? {},
    signals: deps.signals ?? process,
    exit: deps.exit ?? setExitCode,
    logoutTimeoutMs: deps.logoutTimeoutMs ?? CODEX_LOGOUT_TIMEOUT_MS,
  };
}

// --- login し直し -----------------------------------------------------------------------------------

async function reloginPreflight(label, env, deps) {
  const snapshot = await loadCodexConfigSnapshot({ env });
  const account = snapshot?.config.accounts.find(entry => entry.label === label);
  if (!account) throw new LoginError(LOGIN_FAILURE.labelNotRegistered);
  const { accounts, accountsDir, codexPath } = snapshot.config;
  assertCodexHomeEnvSeparate(env, [accountsDir, ...accounts.map(entry => entry.codexHome)]);
  const codex = deps.findCodex({ codexPath, env });
  if (typeof codex?.path !== 'string' || !isAbsolute(codex.path)) throw new LoginError(LOGIN_FAILURE.codexMissing);
  return { label, home: account.codexHome, accounts, codexPath: codex.path };
}

// 4つのシグナルに受け口を1つずつ付ける。受けたシグナルは、起動中の子があれば同じ名前で送り、
// 無ければ何もしない（親は終わらず、自分へ当て直さない）。remove で付けた受け口だけを外す。
function forwardSignals(signals) {
  let running = null;
  const handlers = RELOGIN_SIGNALS.map(name => {
    const handler = () => {
      if (running === null) return;
      try {
        running.kill(name);
      } catch {
        // 送れなくても流れは変えない。
      }
    };
    signals.on(name, handler);
    return [name, handler];
  });
  return {
    setRunning(child) {
      running = child ?? null;
    },
    remove() {
      for (const [name, handler] of handlers) signals.removeListener(name, handler);
    },
  };
}

// login の後の口座を、前の口座・登録済みのほかの口座と比べる。ハッシュはこの関数の外へ出さない。
// ほかの口座の資格情報が読めないときは、その口座とは比べない（前と同じなら、その口座との重なりは
// 登録したときに確かめてあり、前と違うなら、どちらでも登録を外すので結果の扱いは変わらない）。
async function compareAccount({ label, home, accounts }, before, readCredentials) {
  const after = await readAccountIdHash(home, readCredentials);
  if (after === null) return 'unverified';
  for (const account of accounts) {
    if (account.label === label) continue;
    if (await readAccountIdHash(account.codexHome, readCredentials) === after) return 'duplicate';
  }
  return after === before ? 'same' : 'changed';
}

// 設定からそのラベルを外す。外せた・既に無いときは true、書込みが失敗したときは false。
async function removeRegistration(label, env, deps) {
  try {
    await removeCodexAccount({ env, label, fileOps: deps.configFileOps });
    return true;
  } catch {
    return false;
  }
}

// そのフォルダで logout を起動する。0 で終わり、資格情報ファイルが無くなったときだけ true。
async function logoutAccount({ home, codexPath }, env, deps, forwarding) {
  const result = await runCodexChild({
    spawnImpl: deps.spawn, codexPath, args: LOGOUT_CHILD_ARGS, codexHome: home, env,
    stdio: 'ignore', onRunning: forwarding.setRunning, timeoutMs: deps.logoutTimeoutMs,
  });
  if (result.outcome !== LOGIN_CHILD_OUTCOME.ok) return false;
  try {
    await lstat(join(home, CREDENTIALS_FILE_NAME));
    return false;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

async function runRelogin(label, env, deps, say) {
  let target;
  try {
    target = await reloginPreflight(label, env, deps);
  } catch (error) {
    say(`${PREFIX}${failureReason(error)}.`);
    say(CONFIG_UNCHANGED_LINE);
    return LOGIN_EXIT.failed;
  }
  const before = await readAccountIdHash(target.home, deps.readCredentials);
  if (before === null) {
    say(`${PREFIX}${RELOGIN_WORD.unverified}`);
    say(RELOGIN_UNVERIFIED_BEFORE_LINE);
    return LOGIN_EXIT.failed;
  }
  const forwarding = forwardSignals(deps.signals);
  try {
    const child = await runLoginChild({
      spawn: deps.spawn, codexPath: target.codexPath, codexHome: target.home, env, onRunning: forwarding.setRunning,
    });
    const verdict = await compareAccount(target, before, deps.readCredentials);
    if (verdict === 'same') {
      if (child.outcome === LOGIN_CHILD_OUTCOME.ok) {
        say(RELOGIN_OK_LINE);
        return LOGIN_EXIT.ok;
      }
      say(`${PREFIX}${CHILD_FAILURE[child.outcome]}.`);
      say(CONFIG_UNCHANGED_LINE);
      return LOGIN_EXIT.failed;
    }
    // 外すのを logout より先にする（登録の解除を logout の成否によらせないため）。
    const removed = await removeRegistration(label, env, deps);
    const loggedOut = verdict === 'unverified' ? true : await logoutAccount(target, env, deps, forwarding);
    const marks = (loggedOut ? '' : RELOGIN_MARK.logoutFailed) + (removed ? '' : RELOGIN_MARK.removeFailed);
    say(`${PREFIX}${RELOGIN_WORD[verdict]}${marks}`);
    say(removed ? RELOGIN_REMOVED_LINE : RELOGIN_REMOVE_FAILED_LINE);
    return LOGIN_EXIT.failed;
  } finally {
    forwarding.remove();
  }
}

// 標準エラーへ出してよい失敗の理由。自分で作った文と、パスを含めないと決めてある部品の例外だけを
// そのまま出し、ほかは中身を出さない。
function failureReason(error) {
  if (error instanceof LoginError || error instanceof CodexConfigError || error instanceof AccountsDirError
    || error instanceof CodexPathsError) {
    return error.message;
  }
  return LOGIN_FAILURE.unexpected;
}

/**
 * `codex-rotator login` の本体（入口 cli.js から呼ばれる）。--relogin のときは、返す前に同じ終了コードで
 * 終了の関数（deps.exit）を1回呼ぶ。
 * @param {string[]} argv 副コマンドの語を含まない引数
 * @param {{ stdout?: object, stderr?: object, env?: object }} [io]
 * @param {object} [deps] 差し替える部品（上の説明）
 * @returns {Promise<number>} 終了コード
 */
export async function runLogin(argv, io = {}, deps = {}) {
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const say = line => stderr.write(`${line}\n`);
  const parsed = parseLoginArgs(argv);
  if (!parsed.ok) {
    say(`${PREFIX}${parsed.problem}`);
    say(LOGIN_USAGE);
    return LOGIN_EXIT.usage;
  }
  const parts = resolveLoginDeps(deps);
  if (parsed.options.relogin === true) {
    let code;
    try {
      code = await runRelogin(parsed.options.label, env, parts, say);
    } catch {
      say(`${PREFIX}${LOGIN_FAILURE.unexpected}.`);
      code = LOGIN_EXIT.failed;
    }
    parts.exit(code);
    return code;
  }
  return runNewLogin(parsed.options, env, parts, say);
}

// 新規の login（冒頭の流れの 2〜6）。シグナルの受け口は、事前の確かめが通った後、口座のフォルダを
// 作る前に付け、コマンドが終わるとき（結果の行を出した後）に外す。
async function runNewLogin(options, env, deps, say) {
  let folderCreated = false;
  let plan;
  let forwarding = null;
  try {
    try {
      plan = await preflight(options, env, deps);
      forwarding = forwardSignals(deps.signals);
      try {
        await createAccountDir({ accountsDir: plan.config.accountsDir, name: plan.name, fileOps: deps.accountDirFileOps });
      } catch (error) {
        folderCreated = error instanceof AccountsDirError && error.folderCreated;
        throw error;
      }
      folderCreated = true;
      const child = await runLoginChild({
        spawn: deps.spawn, codexPath: plan.codexPath, codexHome: plan.home, env, onRunning: forwarding.setRunning,
      });
      if (child.outcome !== LOGIN_CHILD_OUTCOME.ok) throw new LoginError(CHILD_FAILURE[child.outcome]);
      await assertNewAccount(plan.home, plan.config.accounts, deps.readCredentials);
      await appendCodexAccount({
        env,
        account: { label: options.label, codexHome: plan.home, usagePolicy: options.usagePolicy },
        expectedSha256: plan.snapshot?.sha256 ?? null,
        fileOps: deps.configFileOps,
      });
    } catch (error) {
      say(`${PREFIX}${failureReason(error)}.`);
      say(CONFIG_UNCHANGED_LINE);
      if (folderCreated) say(FOLDER_LEFT_LINE);
      if (error instanceof LoginError) for (const line of error.hints) say(line);
      return LOGIN_EXIT.failed;
    }
    // 追記の後は設定が変わっているので、ここから先は「変えていない」と出す経路に入れない。
    say(REGISTERED_LINE);
    if (plan.snapshot === null) say(CONFIG_CREATED_LINE);
    say(RELOAD_HINT_LINE);
    return LOGIN_EXIT.ok;
  } finally {
    forwarding?.remove();
  }
}
