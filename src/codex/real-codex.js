// 本物の codex（Codex CLI）の実行ファイルの絶対パスを決める。
//
// 決め方（Codex CLI の版の番号を読むときも、shim が転送先の本物の codex を探すときも、この同じ関数を使う）:
//   1. 設定の codexPath があれば、それだけを使う。存在しない・通常のファイルでない・実行できない・
//      shim を指す、のどれかなら、PATH へは落ちずに codex-cli-missing とする。
//   2. codexPath が無ければ、渡された env の PATH を前から1つずつ当方のコードの中で調べ（stat と
//      実行できるかの確認）、最初に見つかった codex の絶対パスを使う。which などの子プロセスは
//      起動しない。相対パスと空の要素は飛ばす（今いるフォルダの codex を拾わない）。見つからなければ
//      codex-cli-missing とする。
// shim の除外（codexPath にも PATH の探索にも同じものを当てる）:
//   - 置き場所 $XDG_DATA_HOME/codex-rotator/bin/ の中（書かれたパスでも実パスでも）。実パスが shim と
//     同じファイル（shim へのシンボリックリンク）は、実パスが置き場所の中にあるのでここで除く。
//   - 実体（装置と i-node の番号）が shim と同じファイル（shim へのハードリンク）
//   - 先頭256バイトに目印 `# codex-rotator-shim` を含むファイル（置き場所の外へのコピー）
// ファイルの中身を読むのは目印を探すときだけで、先頭256バイトまでしか読まない。パスはログにも
// 例外にも出さない（戻り値の path でだけ返す）。この関数は例外を投げない。
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { isSameOrInside } from './config.js';
import { shimDir } from './paths.js';

export const CODEX_EXECUTABLE_NAME = 'codex';
// shim のスクリプトの2行目に入る目印（shim では、この後ろに版の番号が続く）。
export const CODEX_SHIM_MARKER = '# codex-rotator-shim';
export const CODEX_SHIM_MARKER_SCAN_BYTES = 256;
// 実行ファイルが見つからないときの理由の語。
export const CODEX_CLI_MISSING = 'codex-cli-missing';
// codexPath が shim を指していたときに、ログへ出してよい理由の語。
export const CODEX_PATH_POINTS_TO_SHIM = 'codexPath points to shim';

const USABLE = 'usable';
const UNUSABLE = 'unusable';
const SHIM = 'shim';

const attempt = (read, fallback = null) => {
  try {
    return read();
  } catch {
    return fallback;
  }
};

// 比べるための形。darwin のディスクは大文字小文字と Unicode の正規化形を区別しないので、そろえる
// （config.js の比べ方と同じ）。
const comparable = (path, platform) => (platform === 'darwin' ? path.normalize('NFC').toLowerCase() : path);
const fileIdentity = stats => `${stats.dev}:${stats.ino}`;

// shim の置き場所（書かれた形と実パス）と、shim の実体。shim がまだ無ければ置き場所だけ。
function describeShim(env, platform) {
  const dir = resolve(shimDir(env));
  const fileStats = attempt(() => statSync(join(dir, CODEX_EXECUTABLE_NAME)));
  return {
    dirs: [dir, attempt(() => realpathSync.native(dir))].filter(Boolean).map(path => comparable(path, platform)),
    fileId: fileStats ? fileIdentity(fileStats) : null,
  };
}

// 先頭 CODEX_SHIM_MARKER_SCAN_BYTES バイトに目印があるか。開けない・読めないファイルは目印を持たない
// ものとして扱う（shim はシェルが読んで実行する台本なので、読めないファイルは shim になりえない）。
function hasShimMarker(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const buffer = Buffer.alloc(CODEX_SHIM_MARKER_SCAN_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    return buffer.subarray(0, length).includes(CODEX_SHIM_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) attempt(() => closeSync(fd));
  }
}

// 1つの候補を、使える・使えない・shim のどれかに分ける。
function classify(path, shim, platform) {
  const stats = attempt(() => statSync(path));
  if (!stats?.isFile()) return UNUSABLE;
  if (!attempt(() => { accessSync(path, constants.X_OK); return true; }, false)) return UNUSABLE;
  const real = attempt(() => realpathSync.native(path));
  if (!real) return UNUSABLE;
  const written = comparable(resolve(path), platform);
  const actual = comparable(real, platform);
  if (shim.dirs.some(dir => isSameOrInside(written, dir) || isSameOrInside(actual, dir))) return SHIM;
  if (shim.fileId !== null && fileIdentity(stats) === shim.fileId) return SHIM;
  return hasShimMarker(real) ? SHIM : USABLE;
}

// PATH の要素のうち、絶対パスのものだけを並びのまま返す。
function pathEntries(env) {
  const value = env?.PATH;
  if (typeof value !== 'string') return [];
  return value.split(delimiter).filter(entry => entry !== '' && isAbsolute(entry)).map(entry => resolve(entry));
}

const missing = (detail = null) => ({ path: null, reason: CODEX_CLI_MISSING, detail });

/**
 * 本物の codex の絶対パスを決める。
 * @param {{ codexPath?: string|null, env: object, platform?: string }} options
 *   codexPath は検証済みの設定の値（無ければ null）。env は PATH と shim の置き場所（HOME・XDG_DATA_HOME）を
 *   読む元で、process.env を既定値にしない。
 * @returns {{ path: string, reason: null, detail: null } | { path: null, reason: 'codex-cli-missing',
 *   detail: string|null }} detail は codexPath が shim を指していたときだけ CODEX_PATH_POINTS_TO_SHIM
 */
export function findRealCodex({ codexPath = null, env, platform = process.platform } = {}) {
  // shim の置き場所が分からなければ、shim を除けないので何も使わない。
  const shim = attempt(() => describeShim(env, platform));
  if (shim === null) return missing();
  if (codexPath !== null && codexPath !== undefined) {
    if (typeof codexPath !== 'string' || !isAbsolute(codexPath)) return missing();
    const verdict = classify(codexPath, shim, platform);
    if (verdict === USABLE) return { path: resolve(codexPath), reason: null, detail: null };
    return missing(verdict === SHIM ? CODEX_PATH_POINTS_TO_SHIM : null);
  }
  for (const dir of pathEntries(env)) {
    const candidate = join(dir, CODEX_EXECUTABLE_NAME);
    if (classify(candidate, shim, platform) === USABLE) return { path: candidate, reason: null, detail: null };
  }
  return missing();
}
