// 口座のフォルダを CODEX_HOME にして Codex CLI を起動するときの守り。
//
// ここに1か所だけ持ち、login・exec・doctor・shim が同じものを使う:
//   - 第1層（起動のたびに渡す指定）: exec が起動する codex の引数の先頭に、FIRST_LAYER_ARGS を
//     この順で必ず付ける。口座のフォルダの config.toml の中身に依存しない。
//   - 第2層（口座のフォルダに書く設定）: login が作る config.toml は、最初の表より前の
//     `cli_auth_credentials_store = "file"` と、[features] の表の `apps = false`・`plugins = false`
//     の3つの設定だけにする（ACCOUNT_CONFIG_TOML）。exec と shim を通らない起動（利用者が口座のフォルダを
//     CODEX_HOME にして素の codex を起動する場合）も守るため。
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
//   - 起動ごとの点検（Codex CLI の更新で遮断が黙って外れないように）: codex を起動する直前に毎回、
//     選んだ口座のフォルダを CODEX_HOME にし、子と同じ作業フォルダ（exec 自身の作業フォルダの実パス）
//     で、第1層の後ろに型1の -c の値を同じ順で付けた `features list` と `mcp list --json` を、本物の
//     codex の絶対パスで shell:false で順に起動する。apps と plugins がどちらも false で、MCP サーバが
//     0件のときだけ通す。通らなければ codex を起動せず、標準エラーに `guard unverified (<理由>)` の
//     1行を出す（値は出さない）。
//
// 型の照合と引数の組立は純粋な関数で、子プロセスを起動しない。子プロセスを起動するのは起動ごとの
// 点検だけで、起動の関数は差し替えられる部品として受ける。ファイルは読み書きしない（作業フォルダの
// 実パスを求めるだけ）。
// 型1の形は、Codex CLI のジョブを非対話の `codex exec … -` の形で起動するほかのツールの起動の形に合わせてある。
// その起動の形か型1の形を変えるときは、test/codex/account-config.test.js の回帰の見本と照らし直す。
import { spawn as spawnChild } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// --- 第1層 -----------------------------------------------------------------------------------

/** exec が起動する codex の引数の先頭に、この順で必ず付ける指定。 */
export const FIRST_LAYER_ARGS = Object.freeze([
  '-c', 'cli_auth_credentials_store="file"',
  '-c', 'features.apps=false',
  '-c', 'features.plugins=false',
]);

// --- 第2層 -----------------------------------------------------------------------------------

/** login が作る config.toml の、最初の表より前に置く行。 */
export const SECOND_LAYER_ROOT_LINES = Object.freeze(['cli_auth_credentials_store = "file"']);
/** login が作る config.toml の [features] の表に置く行。 */
export const SECOND_LAYER_FEATURES_TABLE = '[features]';
export const SECOND_LAYER_FEATURES_LINES = Object.freeze(['apps = false', 'plugins = false']);

/**
 * login が口座のフォルダに書く config.toml の全文。設定は上の3つだけで、承認や
 * サンドボックスの行（approval_policy・sandbox_mode）は持たない。
 */
export const ACCOUNT_CONFIG_TOML = [
  ...SECOND_LAYER_ROOT_LINES,
  '',
  SECOND_LAYER_FEATURES_TABLE,
  ...SECOND_LAYER_FEATURES_LINES,
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

/**
 * 型の照合・引数の組立・起動ごとの点検をまとめて行い、通れば子の起動の指定を返す。点検の起動と
 * 子の起動には、同じ作業フォルダ（exec 自身の作業フォルダの実パス）と同じ環境を渡す。
 *
 * 型に当たらなければ点検を起動せず { ok: false, kind: 'argument-rejected', reason: 'form', detail }。
 * 作業フォルダの実パスが求められなければ点検を起動せず、点検が通らなかったものとして exit。
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
 * }} options
 */
export async function prepareGuardedLaunch({ args, caller, codexPath, codexHome, env, spawn, scheduler,
  timeoutMs, maxBytes, processCwd, realpath } = {}) {
  requireAbsolute(codexPath, 'codexPath');
  requireAbsolute(codexHome, 'codexHome');
  if (env === null || typeof env !== 'object') throw new TypeError('env must be an object');
  const built = buildLaunchArgs(args, caller ? { caller } : undefined);
  if (!built.ok) return Object.freeze({ ...built, kind: ARGUMENT_REJECTED_KIND });
  const cwd = resolveLaunchWorkingDirectory({ processCwd, realpath });
  if (cwd === null) return unverified(GUARD_UNVERIFIED.exit);
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
