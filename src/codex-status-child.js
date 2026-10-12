// `claude-rotator status` と monitor の Codex の節を読む部品。codex-rotator を子プロセスで起動し、その状態の
// JSON（`codex-rotator status --json --section`）を受け取る。
//
// 読取関数を作るのは bin/claude-rotator.js だけで、本物の env と本物の spawn はそこから渡す。src/cli.js は
// 渡された読取関数を呼ぶだけで、渡されなければ codex-rotator の設定も探さず、子も起こさない。
//
// 読取関数が返すもの（例外は投げない。どの失敗も節の1行になり、`claude-rotator status` の終了コードを変えない）:
//   null                   codex-rotator の設定ファイルが無い（節を描かない。画面は1バイトも変わらない）
//   { ok: true, status }   子が出した JSON。スキーマ検査を通ったものだけ
//   { ok: false, reason }  子の出力を表示に使えなかった理由（決まった語だけ。下の FAILURE）
//
// 子は PATH を探さずに、この Node の実行ファイルと入口の絶対パスで起動する（shell は使わない）。子の標準入力と
// 標準エラーはつながない（子の診断は画面にもログにも出さない）。待つのは CODEX_CHILD_TIMEOUT_MS まで、受け取る
// のは CODEX_SECTION_MAX_BYTES までで、超えたら子を止める。
import { access } from 'node:fs/promises';
import { codexRotatorConfigFile, codexRotatorEntryPath } from './shared/codex-locator.js';
import { CODEX_CHILD_TIMEOUT_MS, codexStatusProblem } from './shared/codex-status-schema.js';

/** 子に渡す引数（入口のパスの後ろ）。 */
export const CODEX_SECTION_ARGS = Object.freeze(['status', '--json', '--section']);
/** 子の標準出力の大きさの上限。 */
export const CODEX_SECTION_MAX_BYTES = 256 * 1024;

// 表示に使えなかった理由の語（`codex: display error (<理由>)` の括弧の中）。
const FAILURE = Object.freeze({
  spawn: 'spawn failed',
  json: 'invalid json',
  schema: 'schema',
  size: 'too large',
  timeout: `timeout ${CODEX_CHILD_TIMEOUT_MS}ms`,
});

const failed = reason => ({ ok: false, reason });

// 設定ファイルがあるか。無いとき（その途中のフォルダが無いときを含む）だけ false。読めないなど、ほかの理由で
// 確かめられないときは true にして子に任せる（子は設定が読めないと 0 以外で終わり、節の1行になる）。
async function configFileExists(env) {
  const path = codexRotatorConfigFile(env);
  if (path === null) return false;
  try {
    await access(path);
    return true;
  } catch (error) {
    return error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR';
  }
}

function parseSection(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failed(FAILURE.json);
  }
  return codexStatusProblem(value) === null ? { ok: true, status: value } : failed(FAILURE.schema);
}

function readFromChild({ env, spawnImpl, scheduler }) {
  return new Promise(resolve => {
    let child = null;
    let settled = false;
    let size = 0;
    const chunks = [];
    const settle = (result, { stop = false } = {}) => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(timer);
      if (stop) {
        try {
          child?.kill('SIGKILL');
        } catch {
          // 止められなくても、返す結果は変えない。
        }
      }
      resolve(result);
    };
    const timer = scheduler.setTimeout(() => settle(failed(FAILURE.timeout), { stop: true }), CODEX_CHILD_TIMEOUT_MS);
    try {
      child = spawnImpl(process.execPath, [codexRotatorEntryPath(), ...CODEX_SECTION_ARGS],
        { shell: false, env, stdio: ['ignore', 'pipe', 'ignore'] });
      child.on('error', () => settle(failed(FAILURE.spawn), { stop: true }));
      // 標準出力の管の error も同じ1行にする（受け手が無いと、親のプロセスごと落ちる）。
      child.stdout.on('error', () => settle(failed(FAILURE.spawn), { stop: true }));
      child.stdout.on('data', chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > CODEX_SECTION_MAX_BYTES) settle(failed(FAILURE.size), { stop: true });
        else chunks.push(buffer);
      });
      child.on('close', (code, signal) => {
        if (signal) settle(failed(`signal ${signal}`));
        else if (code !== 0) settle(failed(`exit ${code}`));
        else settle(parseSection(Buffer.concat(chunks).toString('utf8')));
      });
    } catch {
      // 起動そのものが例外になったとき（子を起こす関数がその場で断ったときを含む）。
      settle(failed(FAILURE.spawn), { stop: true });
    }
  });
}

/**
 * Codex の節の読取関数を作る。
 * @param {{ env: object, spawnImpl: Function, scheduler?: { setTimeout: Function, clearTimeout: Function } }} options
 *   env は設定ファイルの場所を決め、子にもそのまま渡す。spawnImpl は子を起こす関数（Node の spawn と同じ形）で、
 *   省けない。scheduler は待つ期限のタイマー（テストが偽の時計を渡す）。
 * @returns {() => Promise<null | { ok: true, status: object } | { ok: false, reason: string }>}
 */
export function createCodexSectionReader({ env, spawnImpl, scheduler = globalThis } = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('createCodexSectionReader needs a spawn function');
  return async function readCodexSection() {
    if (!await configFileExists(env)) return null;
    return readFromChild({ env, spawnImpl, scheduler });
  };
}
