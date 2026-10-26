// 口座のフォルダを CODEX_HOME にして Codex CLI を起動するときの守り。
//
// ここに1か所だけ持ち、login・exec・doctor・shim が同じものを使う:
//   - 第1層（起動のたびに渡す指定）: exec が起動する codex の引数の先頭に、FIRST_LAYER_ARGS を
//     この順で必ず付ける。口座のフォルダの config.toml の中身に依存しない。
//   - 第2層（口座のフォルダに書く設定）: login が作る config.toml は、最初の表より前の
//     `cli_auth_credentials_store = "file"` と、[features] の表の `apps = false`・`plugins = false`
//     と、[feedback] の表の `enabled = false`（フィードバックの送信を止める）の4つの設定だけにする
//     （ACCOUNT_CONFIG_TOML）。exec と shim を通らない起動（利用者が口座のフォルダを CODEX_HOME にして
//     素の codex を起動する場合）も守るため。
//   - 起動の型: 口座を選んで起動するのは、下の型1〜3に当たる引数の並びだけにする。広く受けてから
//     危ない形を塞ぐのではなく、使う形だけを語ごとの完全一致で許す（前後の空白・引用符・大文字と
//     小文字の違いも一致しないものとして扱う）。型に当たらない並びは、exec は拒否して標準エラーに
//     `argument rejected (form)` の1行を出し（値は出さない）、shim は口座を選ばずに素通しにする。
//       型1 非対話の exec（exec と shim）: 最初の語が `exec`、最後の語が単独の `-`（文章を標準入力
//           から読む）で、`-` は1回だけ。その間に置けるのは、-s と値（read-only・workspace-write）、
//           --skip-git-repo-check、--json、-m と値（モデルの名前の形）、-c と値（通すキーの表）、
//           --image と値（`-` で始まらない空でない語）、`--`（最後の `-` の直前に1回。--image が
//           あるときは必須）。順は問わず各1回まで。ただし -c は表のキーごとに1回まで、--image は
//           繰り返してよい。
//       型2 引数の無い対話（exec と shim）: 語が1つも無い並び。
//       型3 版の表示（exec だけ）: `--version` の1語。shim は口座を選ばずに素通しにする。
//     型を足す・変えるときは、要る呼出し元と理由を書いて、レビューを通してから変える。
//   - 起動の引数の組立: 第1層を先頭に付け、型2（引数の無い対話）でだけ、その直後に --no-daemon を
//     1回付け、その後ろに利用者の引数をそのまま並べる。型1と型3には --no-daemon を付けない。
//   - フィードバックの設定の点検（下の2つの点検より前。codex を起動しない）: 型1〜3のどれでも、選んだ口座の
//     フォルダの config.toml に、[feedback] の表の `enabled = false` が決まった形で1つだけあるかを字で照らす。
//     無い・読めない・ほかの書き方で feedback を定義しているときは `feedback` で止める。第1層の -c は
//     exec を通る起動にしか付かないので、第2層の値が口座のフォルダに在ることを、起動の前に確かめるため。
//   - 起動ごとの点検（Codex CLI の更新で遮断が黙って外れないように）: codex を起動する直前に毎回、
//     選んだ口座のフォルダを CODEX_HOME にし、子と同じ作業フォルダ（exec 自身の作業フォルダの実パス）
//     で、第1層の後ろに型1の -c の値を同じ順で付けた `features list` と `mcp list --json` を、本物の
//     codex の絶対パスで shell:false で順に起動する。apps と plugins がどちらも false で、MCP サーバが
//     0件のときだけ通す。通らなければ codex を起動せず、標準エラーに `guard unverified (<理由>)` の
//     1行を出す（値は出さない）。
//   - 型2 の設定のフォルダの点検（上の2つの点検より前。codex を起動しない）: 型2（引数の無い対話）でだけ、
//     作業フォルダの実パスから、Codex と同じ決め方で求めた根までの各フォルダに `.codex` が在るか（種類を
//     問わず、有無だけ。中身は読まない）を見る。作業フォルダが git の linked worktree のときは、本体の側の
//     同じ位置の `.codex` も見る。1つでも在れば `project-config` で止める（信頼済みのフォルダでも止める）。
//     根を Codex と同じに決められないとき、または決め方がずれうるとき（根の目印を変えうる設定の層が在る・
//     読めない・形が決まった1行でないなど）は `project-root` で止める。対話の中で作業フォルダを信頼した
//     後に、プロジェクトの設定が点検を経ずに読まれる道を、起動の前に塞ぐため。
//
// 型の照合と引数の組立は純粋な関数で、子プロセスを起動しない。子プロセスを起動するのは起動ごとの
// 点検だけで、起動の関数は差し替えられる部品として受ける。ファイルは書かない。読むのは、作業フォルダの
// 実パスと、フィードバックの設定の点検が読む口座の config.toml と、型2 の設定のフォルダの点検が見るファイルの
// 有無と、根の決め方に要る小さなファイル（口座の config.toml・システムと管理の層の config・git の worktree の
// 指し先）だけで、どれも 64 KiB までにする。
// 型1の形は、Codex CLI のジョブを非対話の `codex exec … -` の形で起動するほかのツールの起動の形に合わせてある。
// その起動の形か型1の形を変えるときは、test/codex/account-config.test.js の回帰の見本と照らし直す。
import { spawn as spawnChild } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

// --- 第1層 -----------------------------------------------------------------------------------

/**
 * exec が起動する codex の引数の先頭に、この順で必ず付ける指定。feedback.enabled は、信頼済みの作業フォルダの
 * .codex/config.toml（プロジェクトの層）でも変えられるキーなので、口座の config.toml の値より強い -c でも付ける。
 */
export const FIRST_LAYER_ARGS = Object.freeze([
  '-c', 'cli_auth_credentials_store="file"',
  '-c', 'features.apps=false',
  '-c', 'features.plugins=false',
  '-c', 'feedback.enabled=false',
]);

// --- 第2層 -----------------------------------------------------------------------------------

/** login が作る config.toml の、最初の表より前に置く行。 */
export const SECOND_LAYER_ROOT_LINES = Object.freeze(['cli_auth_credentials_store = "file"']);
/** login が作る config.toml の [features] の表に置く行。 */
export const SECOND_LAYER_FEATURES_TABLE = '[features]';
export const SECOND_LAYER_FEATURES_LINES = Object.freeze(['apps = false', 'plugins = false']);
/** login が作る config.toml の [feedback] の表に置く行（フィードバックの送信を止める）。 */
export const SECOND_LAYER_FEEDBACK_TABLE = '[feedback]';
export const SECOND_LAYER_FEEDBACK_LINES = Object.freeze(['enabled = false']);

/**
 * login が口座のフォルダに書く config.toml の全文。設定は上の4つだけで、承認や
 * サンドボックスの行（approval_policy・sandbox_mode）は持たない。
 */
export const ACCOUNT_CONFIG_TOML = [
  ...SECOND_LAYER_ROOT_LINES,
  '',
  SECOND_LAYER_FEATURES_TABLE,
  ...SECOND_LAYER_FEATURES_LINES,
  '',
  SECOND_LAYER_FEEDBACK_TABLE,
  ...SECOND_LAYER_FEEDBACK_LINES,
  '',
].join('\n');

// --- 起動の型 --------------------------------------------------------------------------------

/** 型の名前（型1〜3）。 */
export const LAUNCH_FORM = Object.freeze({
  exec: 'exec-stdin', // 型1 非対話の exec
  interactive: 'interactive', // 型2 引数の無い対話
  version: 'version', // 型3 版の表示
});

/** 型を照らす呼出し元。型3は exec だけが口座を選んで起動する。 */
export const LAUNCH_CALLER = Object.freeze({ exec: 'exec', shim: 'shim' });

const FORM_CALLERS = Object.freeze({
  [LAUNCH_FORM.exec]: Object.freeze([LAUNCH_CALLER.exec, LAUNCH_CALLER.shim]),
  [LAUNCH_FORM.interactive]: Object.freeze([LAUNCH_CALLER.exec, LAUNCH_CALLER.shim]),
  [LAUNCH_FORM.version]: Object.freeze([LAUNCH_CALLER.exec]),
});

/**
 * 通すキーの表（型1の -c の値）。値の語の全体が pattern に合うときだけ通す。-c と値は別の語。
 *   - model_reasoning_effort: Codex CLI のジョブを非対話の `codex exec … -` の形で起動するほかのツールが、全部のジョブで渡す。
 *   - features.image_generation: 同じツールが画像のジョブで渡す（true だけ）。
 */
export const ALLOWED_CONFIG_OVERRIDES = Object.freeze([
  Object.freeze({ key: 'model_reasoning_effort', pattern: /^model_reasoning_effort=[a-z]+$/ }),
  Object.freeze({ key: 'features.image_generation', pattern: /^features\.image_generation=true$/ }),
]);

/** 型1の -s に許す値。 */
export const ALLOWED_SANDBOX_VALUES = Object.freeze(['read-only', 'workspace-write']);
/** 型1の -m の値の形（Codex CLI のジョブを非対話の `codex exec … -` の形で起動するほかのツールがモデルの名前に許す形と同じ）。 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

const STDIN_MARKER = '-';
const SEPARATOR = '--';
const EXEC_WORD = 'exec';
const VERSION_WORD = '--version';

// 型1の、値を取らない指定と値を取る指定。値の検査は語の全体に対して行う。
const EXEC_FLAGS = new Set(['--skip-git-repo-check', '--json']);
const EXEC_VALUE_OPTIONS = Object.freeze({
  '-s': value => ALLOWED_SANDBOX_VALUES.includes(value),
  '-m': value => MODEL_NAME_PATTERN.test(value),
  '--image': value => value.length > 0 && !value.startsWith('-'),
});
const REPEATABLE_OPTIONS = new Set(['--image']);

// --- 拒否 ------------------------------------------------------------------------------------

/** 拒否の種類の語（標準エラーの `argument rejected (<種類>)` に入る）。 */
export const ARGUMENT_REJECTED_REASON = 'form';

/**
 * 拒否した理由の細目。標準エラーには出さない（出すのは ARGUMENT_REJECTED_REASON だけ）。
 * 呼出し元とテストが、どの規則で拒否したかを見分けるために使う。どれも値を含まない固定の語。
 */
export const FORM_REJECTION = Object.freeze({
  notWords: 'not-words', // 引数が文字列の配列でない
  notExec: 'not-exec', // 型2・型3でなく、最初の語が exec でない（副コマンド・文章・指定など）
  callerNotAllowed: 'caller-not-allowed', // 型には当たるが、その呼出し元には許していない
  stdinMarker: 'stdin-marker', // 単独の `-` が無い・2つ以上ある・最後でない
  unknownWord: 'unknown-word', // 型1の間に置けない語
  missingValue: 'missing-value', // 値を取る指定の後ろに語が無い
  valueShape: 'value-shape', // 値が許す形に合わない
  configKey: 'config-key', // -c のキーが通すキーの表に無い
  duplicate: 'duplicate', // 1回までの指定が2回以上
  separatorPosition: 'separator-position', // `--` が最後の `-` の直前にない
  missingSeparator: 'missing-separator', // --image があるのに `--` が無い
});

/**
 * 拒否したときに標準エラーへ出す1行（改行は含めない）。値は含めない。
 * @param {string} [reason]
 * @returns {string}
 */
export function formatArgumentRejected(reason = ARGUMENT_REJECTED_REASON) {
  return `argument rejected (${reason})`;
}

function reject(detail) {
  return Object.freeze({ ok: false, reason: ARGUMENT_REJECTED_REASON, detail });
}

function accept(form, configOverrides = []) {
  return Object.freeze({ ok: true, form, configOverrides: Object.freeze([...configOverrides]) });
}

// -c の値の語を通すキーの表と照らす。通すなら表の項目、通さないなら拒否の細目。
function matchConfigOverride(value) {
  const entry = ALLOWED_CONFIG_OVERRIDES.find(item => value.startsWith(`${item.key}=`));
  if (!entry) return { detail: FORM_REJECTION.configKey };
  if (!entry.pattern.test(value)) return { detail: FORM_REJECTION.valueShape };
  return { entry };
}

// 型1の最初の `exec` と最後の `-` の間の語を照らす。
function matchExecMiddle(middle) {
  const seen = new Set();
  const configOverrides = [];
  let imageCount = 0;
  for (let i = 0; i < middle.length; i += 1) {
    const word = middle[i];
    if (word === SEPARATOR) {
      if (seen.has(SEPARATOR)) return { rejected: FORM_REJECTION.duplicate };
      if (i !== middle.length - 1) return { rejected: FORM_REJECTION.separatorPosition };
      seen.add(SEPARATOR);
      continue;
    }
    if (EXEC_FLAGS.has(word)) {
      if (seen.has(word)) return { rejected: FORM_REJECTION.duplicate };
      seen.add(word);
      continue;
    }
    if (word === '-c' || Object.hasOwn(EXEC_VALUE_OPTIONS, word)) {
      if (i + 1 >= middle.length) return { rejected: FORM_REJECTION.missingValue };
      const value = middle[i + 1];
      i += 1;
      if (word === '-c') {
        const { entry, detail } = matchConfigOverride(value);
        if (!entry) return { rejected: detail };
        const seenKey = `-c ${entry.key}`;
        if (seen.has(seenKey)) return { rejected: FORM_REJECTION.duplicate };
        seen.add(seenKey);
        configOverrides.push(value);
        continue;
      }
      if (!EXEC_VALUE_OPTIONS[word](value)) return { rejected: FORM_REJECTION.valueShape };
      if (REPEATABLE_OPTIONS.has(word)) {
        imageCount += 1;
        continue;
      }
      if (seen.has(word)) return { rejected: FORM_REJECTION.duplicate };
      seen.add(word);
      continue;
    }
    return { rejected: FORM_REJECTION.unknownWord };
  }
  if (imageCount > 0 && !seen.has(SEPARATOR)) return { rejected: FORM_REJECTION.missingSeparator };
  return { configOverrides };
}

/**
 * 利用者の引数（exec の `--` の後ろの語の並び全体）が、起動の型1〜3のどれに当たるかを照らす。
 * 入力の配列は変えない。
 *
 * 当たれば { ok: true, form, configOverrides }。configOverrides は型1の -c の値を現れた順に並べた
 * もの（型2・型3では空）。当たらなければ { ok: false, reason: 'form', detail }。detail は
 * FORM_REJECTION の語で、値を含まない。
 *
 * @param {readonly string[]} args
 * @param {{ caller?: 'exec'|'shim' }} [options]
 */
export function matchLaunchForm(args, { caller = LAUNCH_CALLER.exec } = {}) {
  if (!Object.values(LAUNCH_CALLER).includes(caller)) throw new TypeError('unknown launch caller');
  if (!Array.isArray(args) || !args.every(word => typeof word === 'string')) return reject(FORM_REJECTION.notWords);
  const words = [...args];
  const forCaller = (form, configOverrides) =>
    (FORM_CALLERS[form].includes(caller) ? accept(form, configOverrides) : reject(FORM_REJECTION.callerNotAllowed));

  if (words.length === 0) return forCaller(LAUNCH_FORM.interactive);
  if (words.length === 1 && words[0] === VERSION_WORD) return forCaller(LAUNCH_FORM.version);
  if (words[0] !== EXEC_WORD) return reject(FORM_REJECTION.notExec);

  const markers = words.filter(word => word === STDIN_MARKER).length;
  if (markers !== 1 || words[words.length - 1] !== STDIN_MARKER) return reject(FORM_REJECTION.stdinMarker);

  const result = matchExecMiddle(words.slice(1, -1));
  if (result.rejected) return reject(result.rejected);
  return forCaller(LAUNCH_FORM.exec, result.configOverrides);
}

// --- 起動の引数の組立 ------------------------------------------------------------------------

/** 型2（引数の無い対話）でだけ、第1層の直後に付ける指定。利用者が付けたものは型の照合で拒否する。 */
export const NO_DAEMON_ARG = '--no-daemon';

/**
 * 利用者の引数を型と照らし、当たれば codex に渡す引数の並びを組み立てる。入力の配列は変えない。
 *
 * 当たれば { ok: true, form, configOverrides, launchArgs }。launchArgs は、第1層・（型2だけ）
 * --no-daemon・利用者の引数をそのまま、の順に並べたもの。当たらなければ matchLaunchForm と同じ拒否
 * （{ ok: false, reason: 'form', detail }）をそのまま返す。
 *
 * @param {readonly string[]} args
 * @param {{ caller?: 'exec'|'shim' }} [options]
 */
export function buildLaunchArgs(args, options) {
  const match = matchLaunchForm(args, options);
  if (!match.ok) return match;
  const noDaemon = match.form === LAUNCH_FORM.interactive ? [NO_DAEMON_ARG] : [];
  return Object.freeze({
    ...match,
    launchArgs: Object.freeze([...FIRST_LAYER_ARGS, ...noDaemon, ...args]),
  });
}

// --- 起動ごとの点検 --------------------------------------------------------------------------

/** 点検の起動1つずつの期限（ミリ秒）。過ぎたら子を止めて timeout とする。 */
export const CODEX_GUARD_CHECK_TIMEOUT_MS = 3000;
/** 点検の起動1つずつで読む標準出力の上限（バイト）。超えたら子を止めて too-large とする。 */
export const CODEX_GUARD_CHECK_MAX_STDOUT_BYTES = 64 * 1024;

/** 点検で起動する副コマンド（この順に起動する）。どちらもモデルを使わない。 */
export const GUARD_CHECK_FEATURES_ARGS = Object.freeze(['features', 'list']);
export const GUARD_CHECK_MCP_ARGS = Object.freeze(['mcp', 'list', '--json']);

/** 点検の出力で、ちょうど1行ずつあって、どちらも最後の欄が false でなければならない機能の名前。 */
export const GUARD_CHECK_FEATURES = Object.freeze(['apps', 'plugins']);

/** 点検が通らなかった理由の語（標準エラーの `guard unverified (<理由>)` に入る）。 */
export const GUARD_UNVERIFIED = Object.freeze({
  featureEnabled: 'feature-enabled', // apps か plugins の最後の欄が true
  mcpPresent: 'mcp-present', // MCP サーバが1件以上
  outputFormat: 'output-format', // 行が無い・2行以上・最後の欄が真偽でない・JSON の配列でない
  exit: 'exit', // 0以外の終了・シグナル・起動や読取の失敗・作業フォルダの実パスが求められない
  timeout: 'timeout', // 期限切れ
  tooLarge: 'too-large', // 標準出力が上限を超えた
  projectConfig: 'project-config', // 型2：作業フォルダから根まで（linked worktree では本体の側の同じ位置も）に .codex が在る
  projectRoot: 'project-root', // 型2：根を Codex と同じに決められない、または決め方がずれうる
  feedback: 'feedback', // 口座の config.toml に、フィードバックの送信を止める設定が決まった形で無い
});

/** 点検が通らなかった結果の種類（拒否の結果の種類と見分けるため）。 */
export const GUARD_UNVERIFIED_KIND = 'guard-unverified';
/** 型の照合で拒否した結果の種類。 */
export const ARGUMENT_REJECTED_KIND = 'argument-rejected';

/**
 * 点検が通らなかったときに標準エラーへ出す1行（改行は含めない）。値は含めない。
 * @param {string} reason GUARD_UNVERIFIED の語
 * @returns {string}
 */
export function formatGuardUnverified(reason) {
  return `guard unverified (${reason})`;
}

const TRUE_WORD = 'true';
const FALSE_WORD = 'false';
const KILL_SIGNAL = 'SIGKILL';

/**
 * 点検で起動する2つの引数の並びを組み立てる。第1層を先頭に付け、その後ろに型1の -c の値を同じ順で
 * `-c <値>` として付け、最後に副コマンドを付ける。
 *
 * includeFirstLayer を false にすると第1層を付けない（口座のフォルダの config.toml だけで遮断が
 * 効いているかを見る点検のため）。configOverrides の値は通すキーの表に合うものだけを受け、
 * 合わなければ TypeError を投げる。
 *
 * @param {readonly string[]} [configOverrides] matchLaunchForm の結果の configOverrides
 * @param {{ includeFirstLayer?: boolean }} [options]
 * @returns {{ featuresList: readonly string[], mcpList: readonly string[] }}
 */
export function buildGuardCheckArgs(configOverrides = [], { includeFirstLayer = true } = {}) {
  if (!Array.isArray(configOverrides)) throw new TypeError('configOverrides must be a list');
  const overrideArgs = [];
  for (const value of configOverrides) {
    if (typeof value !== 'string' || !ALLOWED_CONFIG_OVERRIDES.some(entry => entry.pattern.test(value))) {
      throw new TypeError('config override outside the pass-through table');
    }
    overrideArgs.push('-c', value);
  }
  const head = [...(includeFirstLayer ? FIRST_LAYER_ARGS : []), ...overrideArgs];
  return Object.freeze({
    featuresList: Object.freeze([...head, ...GUARD_CHECK_FEATURES_ARGS]),
    mcpList: Object.freeze([...head, ...GUARD_CHECK_MCP_ARGS]),
  });
}

/**
 * `features list` の標準出力を判定する。通れば null、通らなければ理由の語。
 *
 * 各行を空白で分け、1つ目の欄が apps の行と plugins の行を探す。どちらもちょうど1行で、最後の欄が
 * true か false でなければ output-format。形が合ったうえで、どちらかの最後の欄が true なら
 * feature-enabled。形の違いを先に見るのは、出力の形が変わったこと（Codex CLI の更新）を
 * 見分けやすくするため。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function judgeFeaturesList(text) {
  if (typeof text !== 'string') return GUARD_UNVERIFIED.outputFormat;
  const rows = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => line.split(/\s+/));
  const values = [];
  for (const name of GUARD_CHECK_FEATURES) {
    const matched = rows.filter(fields => fields[0] === name);
    if (matched.length !== 1) return GUARD_UNVERIFIED.outputFormat;
    const last = matched[0][matched[0].length - 1];
    if (matched[0].length < 2 || (last !== TRUE_WORD && last !== FALSE_WORD)) return GUARD_UNVERIFIED.outputFormat;
    values.push(last);
  }
  return values.includes(TRUE_WORD) ? GUARD_UNVERIFIED.featureEnabled : null;
}

/**
 * `mcp list --json` の標準出力を判定する。通れば null、通らなければ理由の語。
 *
 * JSON として読めて配列で、長さが0なら通す（Codex CLI の版 0.157.1 は、MCP サーバが無いとき `[]` を
 * 出す）。長さが1以上なら mcp-present。配列でない・JSON として読めないなら output-format。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function judgeMcpList(text) {
  if (typeof text !== 'string') return GUARD_UNVERIFIED.outputFormat;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return GUARD_UNVERIFIED.outputFormat;
  }
  if (!Array.isArray(parsed)) return GUARD_UNVERIFIED.outputFormat;
  return parsed.length === 0 ? null : GUARD_UNVERIFIED.mcpPresent;
}

// 点検の起動を1つ行い、標準出力の文字列か、通らなかった理由の語を返す。例外を投げない。
// 標準エラーは読まずに捨てる。エラーのメッセージと出力の中身は、理由の語へ持ち込まない。
function runCheckCommand({ codexPath, args, spawnOptions, spawn, scheduler, timeoutMs, maxBytes }) {
  return new Promise(resolveRun => {
    let child = null;
    let timer;
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = outcome => {
      if (settled) return;
      settled = true;
      try { scheduler.clearTimeout(timer); } catch { /* 期限の片付けの失敗で結果を変えない */ }
      resolveRun(outcome);
    };
    const stopWith = reason => {
      if (settled) return;
      try { child?.kill?.(KILL_SIGNAL); } catch { /* 止められなくても、結果は通らなかったもの */ }
      finish({ reason });
    };
    try {
      child = spawn(codexPath, [...args], spawnOptions);
      if (typeof child?.on !== 'function' || typeof child.stdout?.on !== 'function') {
        stopWith(GUARD_UNVERIFIED.exit);
        return;
      }
      child.on('error', () => stopWith(GUARD_UNVERIFIED.exit));
      child.stdout.on('error', () => stopWith(GUARD_UNVERIFIED.exit));
      child.stdout.on('data', chunk => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > maxBytes) {
          stopWith(GUARD_UNVERIFIED.tooLarge);
          return;
        }
        chunks.push(bytes);
      });
      child.on('close', (code, signal) => {
        if (code !== 0 || signal) {
          finish({ reason: GUARD_UNVERIFIED.exit });
          return;
        }
        finish({ stdout: Buffer.concat(chunks).toString('utf8') });
      });
      timer = scheduler.setTimeout(() => stopWith(GUARD_UNVERIFIED.timeout), timeoutMs);
      timer?.unref?.();
    } catch {
      stopWith(GUARD_UNVERIFIED.exit);
    }
  });
}

function requireAbsolute(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
}

const verified = () => Object.freeze({ ok: true });
const unverified = reason => Object.freeze({ ok: false, kind: GUARD_UNVERIFIED_KIND, reason });

/**
 * 起動ごとの点検を行う。`features list` を起動して判定し、通れば `mcp list --json` を起動して判定する。
 * 例外を投げない（引数の誤りだけは TypeError を投げる）。
 *
 * 起動は spawn(codexPath, <引数>, { shell: false, cwd, env: { ...env, CODEX_HOME: codexHome },
 * stdio: ['ignore', 'pipe', 'ignore'] })。PATH の解決を spawn に任せない。
 *
 * @param {{
 *   codexPath: string, codexHome: string, cwd: string, env: object,
 *   configOverrides?: readonly string[], includeFirstLayer?: boolean,
 *   spawn?: Function, scheduler?: { setTimeout: Function, clearTimeout: Function },
 *   timeoutMs?: number, maxBytes?: number,
 * }} options codexPath は本物の codex の絶対パス、codexHome は選んだ口座のフォルダ、cwd は子と同じ
 *   作業フォルダ（どれも絶対パス）。env は子へ渡す環境で、process.env を既定値にしない。
 * @returns {Promise<{ ok: true } | { ok: false, kind: 'guard-unverified', reason: string }>}
 */
export async function runGuardCheck({ codexPath, codexHome, cwd, env, configOverrides = [],
  includeFirstLayer = true, spawn = spawnChild, scheduler = globalThis,
  timeoutMs = CODEX_GUARD_CHECK_TIMEOUT_MS, maxBytes = CODEX_GUARD_CHECK_MAX_STDOUT_BYTES } = {}) {
  requireAbsolute(codexPath, 'codexPath');
  requireAbsolute(codexHome, 'codexHome');
  requireAbsolute(cwd, 'cwd');
  if (env === null || typeof env !== 'object') throw new TypeError('env must be an object');
  if (typeof spawn !== 'function') throw new TypeError('spawn must be a function');
  const checkArgs = buildGuardCheckArgs(configOverrides, { includeFirstLayer });
  const spawnOptions = { shell: false, cwd, env: { ...env, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'ignore'] };
  const steps = [[checkArgs.featuresList, judgeFeaturesList], [checkArgs.mcpList, judgeMcpList]];
  for (const [args, judge] of steps) {
    const outcome = await runCheckCommand({ codexPath, args, spawnOptions, spawn, scheduler, timeoutMs, maxBytes });
    if (outcome.reason) return unverified(outcome.reason);
    const reason = judge(outcome.stdout);
    if (reason) return unverified(reason);
  }
  return verified();
}

/**
 * exec 自身の作業フォルダの実パス。求められなければ null。例外を投げない。
 * @param {{ processCwd?: () => string, realpath?: (path: string) => string }} [options]
 * @returns {string|null}
 */
export function resolveLaunchWorkingDirectory({ processCwd = () => process.cwd(), realpath = realpathSync.native } = {}) {
  try {
    const real = realpath(processCwd());
    return typeof real === 'string' && isAbsolute(real) ? real : null;
  } catch {
    return null;
  }
}

// --- 型2 の設定のフォルダの点検 ----------------------------------------------------------------
//
// Codex CLI（確かめた版 rust-v0.160.1）の根の決め方を写す。根は、作業フォルダから `/` へ祖先を1つずつ見て、
// 根の目印（既定は `.git`）が最初に在った祖先。目印はリンクの先までたどり、ファイルでもフォルダでも数える。
// ただし `.git` がフォルダで中に `HEAD` が無ければ数えない。どこにも無ければ作業フォルダが根。目印の値は、
// プロジェクトのもの以外の層（システム・クラウド・口座の config・profile・`-c`・ファイルの管理の層・MDM）を
// 合わせて決まる。ここでは口座の config の値だけを使い、ほかの層が目印を変えうるときは止める側に倒す。
// Codex が点検の対象にしない所（クラウドから配る設定の初回、`.codex/` の外で効くものなど）は既知の限り。

/** 型2 の点検が見る、プロジェクトの層の外の置き場（試験では仮のフォルダへ向ける）。 */
export const PROJECT_LAYER_PATHS = Object.freeze({
  systemConfig: '/etc/codex/config.toml', // システムの層
  managedConfig: '/etc/codex/managed_config.toml', // ファイルで置く管理の層（Unix）
  managedPreferencesDir: '/Library/Managed Preferences', // macOS の管理の設定（MDM）の置き場
});
/** MDM の設定のファイルの名（置き場の直下と、その下のユーザーごとのフォルダの中を見る）。 */
export const MANAGED_PREFERENCES_FILE = 'com.openai.codex.plist';
/** 口座のフォルダの直下に置かれる、クラウドから配る設定の控え。 */
export const CLOUD_CONFIG_CACHE_FILE = 'cloud-config-bundle-cache.json';
/** 根の目印の既定。 */
export const DEFAULT_PROJECT_ROOT_MARKERS = Object.freeze(['.git']);
/** 点検で読むファイルの上限（バイト）。超えたら根を決められないものとして止める。 */
export const PROJECT_CHECK_MAX_FILE_BYTES = 64 * 1024;

const PROJECT_CONFIG_DIR = '.codex';
const GIT_MARKER = '.git';
const MARKERS_KEY = 'project_root_markers';
// 目印の値として受けるのは、最初の表より前の1行に書いた、空でない文字列の配列だけ。
const MARKERS_LINE = /^[ \t]*project_root_markers[ \t]*=[ \t]*\[([^\]\n]*)\][ \t]*(?:#[^\n]*)?$/;
const MARKER_ELEMENT = /^[ \t]*(?:"([^"\\\x00-\x1f\x7f]*)"|'([^'\x00-\x1f\x7f]*)')[ \t]*$/;
const TABLE_HEADER_LINE = /^[ \t]*\[/;
// 口座の config の profile・profiles の鍵（表の見出し・点で続く鍵・引用符で囲んだ鍵を含む）。
const PROFILE_KEY_LINE = /^[ \t]*\[{0,2}[ \t]*["']?profiles?["']?[ \t]*[=.\]]/m;
// 複数行の文字列の区切りと、文字列のエスケープ。字で照らす点検は、これらがあると鍵と値を Codex と同じに
// 読めないので、根を決められないものとして止める。
const TOML_UNREADABLE_TEXT = /"""|'''|\\/;
// 口座の config.toml で、字で照らす点検が通す形。どの行も、空の行・注記の行・表の見出し・その行で閉じる
// 「鍵 = 値」のどれか。鍵はエスケープの無い名、値はエスケープの無い1行の文字列・真偽・数（日時は含めない）・
// その行で閉じる配列と inline table だけで、どれも TOML 1.0 の正しい形（TOML 1.1 でも同じ意味）。複数行に
// 分けた配列や inline table（TOML 1.1）の中の行は一番上の階層の行と見分けられないので、ほかの形が1つでも
// あれば止める。制御文字（タブと改行を除く）・改行でない CR・BOM も止める。
const PLAIN_TOML_FORBIDDEN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufeff]|\r(?!\n)/;
const PLAIN_SPACE = /[ \t]*/y;
const PLAIN_KEY_PART = /[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*'/y;
const PLAIN_SCALAR = new RegExp([
  '"[^"\\\\]*"', "'[^']*'", 'true', 'false', '[+-]?(?:inf|nan)',
  '0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*', '0o[0-7](?:_?[0-7])*', '0b[01](?:_?[01])*',
  '[+-]?(?:0|[1-9](?:_?[0-9])*)(?:\\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?',
].join('|'), 'y');
const PLAIN_MAX_DEPTH = 8;
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** 点検に使うファイルの道具（試験では差し替える）。どれも同期の関数。 */
const NODE_PROJECT_FS = Object.freeze({
  lstat: lstatSync, stat: statSync, readFile: readFileSync, readdir: readdirSync, realpath: realpathSync.native,
});

// 根を決められないときに投げる印。点検の関数の外へは出さない。
class ProjectRootUndetermined extends Error {}
const undetermined = () => new ProjectRootUndetermined();

// 在れば true、無ければ（ENOENT・ENOTDIR）false。ほかの誤りは、決められないものとして投げる。
function present(fsImpl, method, path) {
  try {
    fsImpl[method](path);
    return true;
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return false;
    throw undetermined();
  }
}

// 小さなファイルを読む。無ければ null。ファイルでない・上限を超える・読めないときは投げる。
function readSmallText(fsImpl, path) {
  let info;
  try {
    info = fsImpl.stat(path);
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return null;
    throw undetermined();
  }
  if (!info.isFile() || info.size > PROJECT_CHECK_MAX_FILE_BYTES) throw undetermined();
  const text = fsImpl.readFile(path, 'utf8');
  if (typeof text !== 'string' || Buffer.byteLength(text) > PROJECT_CHECK_MAX_FILE_BYTES) throw undetermined();
  return text;
}

// 行 line の at から re（sticky）に合う字を読み、読み終えた位置を返す。合わなければ -1。
function eatPlain(re, line, at) {
  re.lastIndex = at;
  return re.test(line) ? re.lastIndex : -1;
}

const skipPlainSpace = (line, at) => eatPlain(PLAIN_SPACE, line, at);

// 点で続く鍵（`a . "b".'c'`）を読み、読み終えた位置を返す。読めなければ -1。
function eatPlainKey(line, at) {
  for (let end = eatPlain(PLAIN_KEY_PART, line, at); end !== -1; end = eatPlain(PLAIN_KEY_PART, line, at)) {
    const next = skipPlainSpace(line, end);
    if (line[next] !== '.') return end;
    at = skipPlainSpace(line, next + 1);
  }
  return -1;
}

// 値を1つ読み、読み終えた位置を返す。配列と inline table は、同じ行の中で閉じるものだけ。読めなければ -1。
function eatPlainValue(line, at, depth) {
  const open = line[at];
  if (open !== '[' && open !== '{') return eatPlain(PLAIN_SCALAR, line, at);
  if (depth >= PLAIN_MAX_DEPTH) return -1;
  const close = open === '[' ? ']' : '}';
  at = skipPlainSpace(line, at + 1);
  if (line[at] === close) return at + 1;
  for (;;) {
    if (open === '{') {
      at = eatPlainKey(line, at);
      if (at === -1) return -1;
      at = skipPlainSpace(line, at);
      if (line[at] !== '=') return -1;
      at = skipPlainSpace(line, at + 1);
    }
    at = eatPlainValue(line, at, depth + 1);
    if (at === -1) return -1;
    at = skipPlainSpace(line, at);
    if (line[at] === close) return at + 1;
    if (line[at] !== ',') return -1;
    at = skipPlainSpace(line, at + 1);
    // 配列は末尾のカンマを受ける（TOML 1.0）。inline table の末尾のカンマは TOML 1.1 だけなので受けない。
    if (open === '[' && line[at] === close) return at + 1;
  }
}

// 1行が、空の行・注記の行・表の見出し・その行で閉じる「鍵 = 値」のどれかか。
function isPlainTomlLine(line) {
  let at = skipPlainSpace(line, 0);
  if (at === line.length || line[at] === '#') return true;
  if (line[at] === '[') {
    const close = line[at + 1] === '[' ? ']]' : ']';
    at = eatPlainKey(line, skipPlainSpace(line, at + close.length));
    if (at === -1) return false;
    at = skipPlainSpace(line, at);
    if (!line.startsWith(close, at)) return false;
    at += close.length;
  } else {
    at = eatPlainKey(line, at);
    if (at === -1) return false;
    at = skipPlainSpace(line, at);
    if (line[at] !== '=') return false;
    at = eatPlainValue(line, skipPlainSpace(line, at + 1), 0);
    if (at === -1) return false;
  }
  at = skipPlainSpace(line, at);
  return at === line.length || line[at] === '#';
}

/**
 * 口座の config.toml の全文から、根の目印を読む。鍵が無ければ既定（`.git`）、受ける形なら値、ほかは null
 * （根を決められない）。受ける形は、最初の表より前の1行の `project_root_markers = ["…", …]`（要素は空でない
 * 1段の名で、`/`・`.`・`..` を含まない文字列）だけ。鍵が2回以上出る・表の中にある・値が配列でない・空の配列・
 * 複数行の配列・注記の中にだけ在る、と、全文のどこかに複数行の文字列の区切り（`"""`・`'''`）か文字列の
 * エスケープ（`\`）がある、と、全文のどこかに上の PLAIN_TOML_FORBIDDEN に当たる字か、空の行・注記の行・
 * 表の見出し・その行で閉じる「鍵 = 値」のほかの行がある（複数行に分けた配列や inline table など）、はどれも null。
 * @param {string|null} text
 * @returns {readonly string[]|null}
 */
export function readProjectRootMarkers(text) {
  if (text === null || text === undefined) return DEFAULT_PROJECT_ROOT_MARKERS;
  if (typeof text !== 'string' || TOML_UNREADABLE_TEXT.test(text) || PLAIN_TOML_FORBIDDEN.test(text)) return null;
  if (!text.split(/\r?\n/).every(isPlainTomlLine)) return null;
  const count = text.split(MARKERS_KEY).length - 1;
  if (count === 0) return DEFAULT_PROJECT_ROOT_MARKERS;
  if (count > 1) return null;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(line => line.includes(MARKERS_KEY));
  const firstTable = lines.findIndex(line => TABLE_HEADER_LINE.test(line));
  if (firstTable !== -1 && firstTable < at) return null;
  const match = MARKERS_LINE.exec(lines[at]);
  if (!match || match[1].trim() === '') return null;
  const markers = [];
  for (const part of match[1].split(',')) {
    const element = MARKER_ELEMENT.exec(part);
    if (!element) return null;
    const name = element[1] ?? element[2];
    if (name === '' || name === '.' || name === '..' || name.includes('/')) return null;
    markers.push(name);
  }
  return Object.freeze(markers);
}

/**
 * Codex に渡す引数の並びに、根の目印か profile を変えうる指定があるか（`--profile`・`--profile=…`・`-p` で
 * 始まる1字の指定、`project_root_markers` を含む語〈`-c`・`--config` の値や `=` で続ける形〉）。
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export function launchArgsChangeProjectRoot(args) {
  return args.some(word => typeof word !== 'string' || word.includes(MARKERS_KEY) || word === '--profile'
    || word.startsWith('--profile=') || (word.startsWith('-p') && !word.startsWith('--')));
}

// 根の目印が在るか。リンクの先までたどる。`.git` のフォルダは中に HEAD が在るときだけ数える。先までたどれない
// リンク（切れたリンク）と、ENOENT・ENOTDIR 以外の誤りは、決められないものとして投げる。
function isRootMarker(fsImpl, path, marker) {
  let info;
  try {
    info = fsImpl.stat(path);
  } catch (error) {
    if (!ABSENT_CODES.has(error?.code)) throw undetermined();
    if (present(fsImpl, 'lstat', path)) throw undetermined();
    return false;
  }
  if (marker === GIT_MARKER && info.isDirectory()) return present(fsImpl, 'stat', join(path, 'HEAD'));
  return true;
}

// 作業フォルダから祖先へ、目印が最初に在った祖先。どこにも無ければ作業フォルダ。
function findProjectRoot(fsImpl, cwd, markers) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (markers.some(marker => isRootMarker(fsImpl, join(dir, marker), marker))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}

// 作業フォルダから根までのフォルダ（作業フォルダが先）。
function foldersUpToRoot(cwd, root) {
  const folders = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    folders.push(dir);
    if (dir === root || dirname(dir) === dir) return folders;
  }
}

// git の作業ツリーの根（Codex の find_git_checkout_root と同じ）：作業フォルダから祖先へ、`.git` が在る
// 最初の祖先。`.git` がフォルダで中に HEAD が無ければ飛ばす。無ければ null。
function findGitCheckoutRoot(fsImpl, cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (isRootMarker(fsImpl, join(dir, GIT_MARKER), GIT_MARKER)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

// `gitdir:` などの1行のファイルの値。読めない・形が違えば投げる。
function readPointer(fsImpl, path, prefix = '') {
  const text = readSmallText(fsImpl, path);
  if (text === null) throw undetermined();
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) throw undetermined();
  const value = trimmed.slice(prefix.length).trim();
  if (value === '' || value.includes('\n') || value.includes('\0')) throw undetermined();
  return value;
}

const againstFolder = (folder, value) => (isAbsolute(value) ? value : join(folder, value));

/**
 * linked worktree の本体の根（Codex の resolve_root_git_project_for_trust と同じ求め方で、確かめを足したもの）。
 * `.git` がフォルダなら null（本体の側は見ない）。求められなければ投げる。
 */
function resolveMainCheckoutRoot(fsImpl, checkoutRoot) {
  const dotGit = join(checkoutRoot, GIT_MARKER);
  // Codex はリンクの先までたどってフォルダか見て、フォルダなら本体の側を見ない。フォルダでないときは、
  // リンクでない普通のファイルだけを読む（リンクのファイルは本体の場所を決められないものとして止める）。
  if (fsImpl.stat(dotGit).isDirectory()) return null;
  const info = fsImpl.lstat(dotGit);
  if (!info.isFile() || info.isSymbolicLink()) throw undetermined();
  const gitDir = againstFolder(checkoutRoot, readPointer(fsImpl, dotGit, 'gitdir:'));
  const canonicalGitDir = fsImpl.realpath(gitDir);
  const registeredDotGit = againstFolder(canonicalGitDir, readPointer(fsImpl, join(canonicalGitDir, 'gitdir')));
  if (fsImpl.realpath(dirname(registeredDotGit)) !== fsImpl.realpath(checkoutRoot)) throw undetermined();
  const commonDir = fsImpl.realpath(againstFolder(canonicalGitDir, readPointer(fsImpl, join(canonicalGitDir, 'commondir'))));
  if (commonDir !== dirname(dirname(canonicalGitDir))) throw undetermined();
  const mainRoot = dirname(dirname(dirname(gitDir)));
  if (fsImpl.realpath(join(mainRoot, GIT_MARKER)) !== commonDir) throw undetermined();
  return mainRoot;
}

// MDM の設定のファイルが、置き場の直下か、その下のユーザーごとのフォルダの中に在るか。
function managedPreferencesPresent(fsImpl, dir) {
  if (present(fsImpl, 'lstat', join(dir, MANAGED_PREFERENCES_FILE))) return true;
  let names;
  try {
    names = fsImpl.readdir(dir);
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return false;
    throw undetermined();
  }
  return names.some(name => present(fsImpl, 'lstat', join(dir, String(name), MANAGED_PREFERENCES_FILE)));
}

/**
 * 型2 の設定のフォルダの点検。codex を起動しない。通れば null、止めるなら理由の語（`project-config` か
 * `project-root`）。例外を投げない（思わない誤りも `project-root` にする）。
 * `.codex`・クラウドの控え・MDM の設定のファイルは有無だけを見て、中身を読まない。
 * @param {{
 *   cwd: string, codexHome: string, launchArgs?: readonly string[],
 *   fs?: object, paths?: { systemConfig: string, managedConfig: string, managedPreferencesDir: string },
 * }} options cwd は作業フォルダの実パス、codexHome は選んだ口座のフォルダ（どちらも絶対パス）
 * @returns {string|null}
 */
export function checkProjectFolders({ cwd, codexHome, launchArgs = [], fs: fsImpl = NODE_PROJECT_FS,
  paths = PROJECT_LAYER_PATHS } = {}) {
  try {
    if (!isAbsolute(cwd) || !isAbsolute(codexHome)) return GUARD_UNVERIFIED.projectRoot;
    if (present(fsImpl, 'lstat', join(cwd, PROJECT_CONFIG_DIR))) return GUARD_UNVERIFIED.projectConfig;
    if (!Array.isArray(launchArgs) || launchArgsChangeProjectRoot(launchArgs)) return GUARD_UNVERIFIED.projectRoot;
    const accountConfig = readSmallText(fsImpl, join(codexHome, 'config.toml'));
    if (accountConfig !== null && PROFILE_KEY_LINE.test(accountConfig)) return GUARD_UNVERIFIED.projectRoot;
    const markers = readProjectRootMarkers(accountConfig);
    if (markers === null) return GUARD_UNVERIFIED.projectRoot;
    if (present(fsImpl, 'lstat', join(codexHome, CLOUD_CONFIG_CACHE_FILE))) return GUARD_UNVERIFIED.projectRoot;
    for (const layer of [paths.systemConfig, paths.managedConfig]) {
      const text = readSmallText(fsImpl, layer);
      if (text !== null && (text.includes(MARKERS_KEY) || TOML_UNREADABLE_TEXT.test(text))) {
        return GUARD_UNVERIFIED.projectRoot;
      }
    }
    if (managedPreferencesPresent(fsImpl, paths.managedPreferencesDir)) return GUARD_UNVERIFIED.projectRoot;
    const root = findProjectRoot(fsImpl, cwd, markers);
    const folders = foldersUpToRoot(cwd, root);
    if (folders.some(dir => present(fsImpl, 'lstat', join(dir, PROJECT_CONFIG_DIR)))) {
      return GUARD_UNVERIFIED.projectConfig;
    }
    const checkoutRoot = findGitCheckoutRoot(fsImpl, cwd);
    const mainRoot = checkoutRoot === null ? null : resolveMainCheckoutRoot(fsImpl, checkoutRoot);
    if (mainRoot !== null) {
      for (const dir of folders) {
        const inside = relative(checkoutRoot, dir);
        if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
        if (present(fsImpl, 'lstat', join(mainRoot, inside, PROJECT_CONFIG_DIR))) return GUARD_UNVERIFIED.projectConfig;
      }
    }
    return null;
  } catch {
    return GUARD_UNVERIFIED.projectRoot;
  }
}

// --- フィードバックの設定の点検 ----------------------------------------------------------------
//
// 口座の config.toml を、型2 の点検と同じ行の読み手（isPlainTomlLine など）で字で照らす。その読み手が通す
// 全文では、どの行も一番上の階層の行なので、`[` で始まる行は表の見出し、ほかは見出しの表の「鍵 = 値」と
// 決められる。迷う書き方（引用符で囲んだ鍵・点で続く鍵・表の中のほかの鍵など）は通さない。

const FEEDBACK_KEY = 'feedback';
const FEEDBACK_ENABLED_KEY = 'enabled';
const FEEDBACK_DISABLED_VALUE = /^false[ \t]*(?:#.*)?$/;

// 行 line の at から点で続く鍵を読み、部分ごとの名（引用符を外したもの）と引用符の無い名だったかと、読み終えた
// 位置を返す。読めなければ null。
function readPlainKeyParts(line, at) {
  const parts = [];
  for (;;) {
    PLAIN_KEY_PART.lastIndex = at;
    const match = PLAIN_KEY_PART.exec(line);
    if (!match) return null;
    const raw = match[0];
    const quoted = raw[0] === '"' || raw[0] === "'";
    parts.push({ name: quoted ? raw.slice(1, -1) : raw, bare: !quoted });
    const end = at + raw.length;
    const next = skipPlainSpace(line, end);
    if (line[next] !== '.') return { parts, end };
    at = skipPlainSpace(line, next + 1);
  }
}

// 鍵が、引用符の無い1つの名 name だけか。
const isBareKey = (key, name) => key.parts.length === 1 && key.parts[0].bare && key.parts[0].name === name;

/**
 * 口座の config.toml の全文が、フィードバックの送信を止める設定を持つかを判定する。通れば null、通らなければ
 * `feedback`。
 *
 * 通すのは、引用符の無い `[feedback]` の見出しの行がちょうど1つあり、その表の中（次の見出しの行まで）の
 * 「鍵 = 値」が、引用符の無い `enabled` と真偽の `false` の1行だけ（等号の前後の空白と行末の注記は受ける）で、
 * ほかに feedback を定義する書き方が無いときだけ。通さないのは、全文が無い（null）・文字列でない、
 * readProjectRootMarkers が根を決められないとする書き方（複数行の文字列・エスケープ・決まった単純な形でない行・
 * 制御文字など）がある、`[feedback]` が無い・2つ以上ある、その表の中に enabled が無い・2つ以上ある・値が false の
 * 真偽でない・ほかの鍵（引用符で囲んだ `"enabled"`・点で続く鍵を含む）がある、最初の表より前に最初の部分が
 * feedback の鍵（`feedback.enabled = …`・`feedback = { … }`・引用符で囲んだもの）がある、最初の部分が feedback の
 * ほかの見出し（`[feedback.…]`・`[[feedback]]`・`["feedback"]`）がある、のどれか。
 * @param {string|null} text
 * @returns {string|null}
 */
export function judgeFeedbackConfig(text) {
  const unverifiedFeedback = GUARD_UNVERIFIED.feedback;
  if (typeof text !== 'string' || TOML_UNREADABLE_TEXT.test(text) || PLAIN_TOML_FORBIDDEN.test(text)) return unverifiedFeedback;
  const lines = text.split(/\r?\n/);
  if (!lines.every(isPlainTomlLine)) return unverifiedFeedback;
  let inFeedback = false;
  let inOtherTable = false;
  let headers = 0;
  let disabled = 0;
  for (const line of lines) {
    const at = skipPlainSpace(line, 0);
    if (at === line.length || line[at] === '#') continue;
    if (line[at] === '[') {
      const arrayOfTables = line[at + 1] === '[';
      const key = readPlainKeyParts(line, skipPlainSpace(line, at + (arrayOfTables ? 2 : 1)));
      if (key === null) return unverifiedFeedback;
      inFeedback = key.parts[0].name === FEEDBACK_KEY;
      inOtherTable = !inFeedback;
      if (!inFeedback) continue;
      if (arrayOfTables || !isBareKey(key, FEEDBACK_KEY)) return unverifiedFeedback;
      headers += 1;
      continue;
    }
    const key = readPlainKeyParts(line, at);
    if (key === null) return unverifiedFeedback;
    if (inOtherTable) continue;
    if (!inFeedback) {
      if (key.parts[0].name === FEEDBACK_KEY) return unverifiedFeedback;
      continue;
    }
    if (!isBareKey(key, FEEDBACK_ENABLED_KEY)) return unverifiedFeedback;
    const valueAt = skipPlainSpace(line, skipPlainSpace(line, key.end) + 1);
    if (!FEEDBACK_DISABLED_VALUE.test(line.slice(valueAt))) return unverifiedFeedback;
    disabled += 1;
  }
  return headers === 1 && disabled === 1 ? null : unverifiedFeedback;
}

/**
 * フィードバックの設定の点検。選んだ口座のフォルダの config.toml（64 KiB まで）を読み、judgeFeedbackConfig で
 * 判定する。codex を起動しない。通れば null、止めるなら `feedback`。例外を投げない（ファイルが無い・普通の
 * ファイルでない・上限を超える・読めない、と思わない誤りも `feedback` にする）。
 * @param {{ codexHome: string, fs?: object }} options codexHome は選んだ口座のフォルダ（絶対パス）
 * @returns {string|null}
 */
export function checkFeedbackConfig({ codexHome, fs: fsImpl = NODE_PROJECT_FS } = {}) {
  try {
    if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) return GUARD_UNVERIFIED.feedback;
    return judgeFeedbackConfig(readSmallText(fsImpl, join(codexHome, 'config.toml')));
  } catch {
    return GUARD_UNVERIFIED.feedback;
  }
}

/**
 * 型の照合・引数の組立・起動ごとの点検をまとめて行い、通れば子の起動の指定を返す。点検の起動と
 * 子の起動には、同じ作業フォルダ（exec 自身の作業フォルダの実パス）と同じ環境を渡す。
 *
 * 型に当たらなければ点検を起動せず { ok: false, kind: 'argument-rejected', reason: 'form', detail }。
 * 作業フォルダの実パスが求められなければ点検を起動せず、点検が通らなかったものとして exit。
 * 型1〜3のどれでも、続けてフィードバックの設定の点検（checkFeedbackConfig）を行い、通らなければ点検を
 * 起動せずに feedback。
 * 型2 では、点検を起動する前に設定のフォルダの点検（checkProjectFolders）を行い、通らなければ点検を
 * 起動せずに project-config か project-root。
 * 点検が通らなければ { ok: false, kind: 'guard-unverified', reason }。通れば
 * { ok: true, form, launch: { command, args, options: { shell: false, cwd, env } } }（stdio は呼出し元が
 * 決める）。
 *
 * 呼出し元は、口座を選ぶ前に matchLaunchForm で照らし、拒否したら使用率の読取も点検もしない。
 *
 * @param {{
 *   args: readonly string[], caller?: 'exec'|'shim', codexPath: string, codexHome: string, env: object,
 *   spawn?: Function, scheduler?: object, timeoutMs?: number, maxBytes?: number,
 *   processCwd?: () => string, realpath?: (path: string) => string,
 *   projectFs?: object, projectLayerPaths?: object,
 * }} options projectFs と projectLayerPaths は、フィードバックの設定の点検と設定のフォルダの点検のファイルの
 *   道具と、プロジェクトの層の外の置き場（試験のため。省けば本物）
 */
export async function prepareGuardedLaunch({ args, caller, codexPath, codexHome, env, spawn, scheduler,
  timeoutMs, maxBytes, processCwd, realpath, projectFs, projectLayerPaths } = {}) {
  requireAbsolute(codexPath, 'codexPath');
  requireAbsolute(codexHome, 'codexHome');
  if (env === null || typeof env !== 'object') throw new TypeError('env must be an object');
  const built = buildLaunchArgs(args, caller ? { caller } : undefined);
  if (!built.ok) return Object.freeze({ ...built, kind: ARGUMENT_REJECTED_KIND });
  const cwd = resolveLaunchWorkingDirectory({ processCwd, realpath });
  if (cwd === null) return unverified(GUARD_UNVERIFIED.exit);
  const feedbackReason = checkFeedbackConfig({ codexHome, fs: projectFs });
  if (feedbackReason !== null) return unverified(feedbackReason);
  if (built.form === LAUNCH_FORM.interactive) {
    const projectReason = checkProjectFolders({
      cwd, codexHome, launchArgs: built.launchArgs, fs: projectFs, paths: projectLayerPaths,
    });
    if (projectReason !== null) return unverified(projectReason);
  }
  const check = await runGuardCheck({
    codexPath, codexHome, cwd, env, configOverrides: built.configOverrides, spawn, scheduler, timeoutMs, maxBytes,
  });
  if (!check.ok) return check;
  return Object.freeze({
    ok: true,
    form: built.form,
    launch: Object.freeze({
      command: codexPath,
      args: built.launchArgs,
      options: Object.freeze({ shell: false, cwd, env: { ...env, CODEX_HOME: codexHome } }),
    }),
  });
}
