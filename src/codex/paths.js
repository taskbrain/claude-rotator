// codex-rotator の置き場所（設定・制御トークン・shim・状態）を決める。
//
// 読むのは、呼び出し側が渡した env オブジェクトの HOME・XDG_CONFIG_HOME・XDG_DATA_HOME・
// XDG_STATE_HOME の4つだけである。process.env を既定値にしない（テストが渡し忘れても実の
// ホームへ届かないようにするため）。OS のユーザー情報からホームを推測することもしない。
// 置き場所を上書きする独自の環境変数（CLAUDE_ROTATOR_CONFIG に当たるもの）は持たない。
import { isAbsolute, join, resolve } from 'node:path';

export const CODEX_ROTATOR_APP_NAME = 'codex-rotator';
// 口座フォルダの根の既定値（設定の accountsDir が無いとき）。展開は expandHomePath で行う。
export const DEFAULT_ACCOUNTS_DIR = '~/.codex-accounts';

export class CodexPathsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexPathsError';
  }
}

/** env の HOME。絶対パスでなければ例外（相対・未設定のまま実のホームを推測しない）。 */
export function homeDir(env) {
  const home = env?.HOME;
  if (typeof home !== 'string' || !isAbsolute(home)) {
    throw new CodexPathsError('HOME must be an absolute path');
  }
  return resolve(home);
}

// XDG の値は絶対パスのときだけ使う（XDG Base Directory の規則。相対の値は無視する）。
function xdgDir(env, key, fallbackSegments) {
  const value = env?.[key];
  if (typeof value === 'string' && isAbsolute(value)) return resolve(value);
  return join(homeDir(env), ...fallbackSegments);
}

export const xdgConfigHome = env => xdgDir(env, 'XDG_CONFIG_HOME', ['.config']);
export const xdgDataHome = env => xdgDir(env, 'XDG_DATA_HOME', ['.local', 'share']);
export const xdgStateHome = env => xdgDir(env, 'XDG_STATE_HOME', ['.local', 'state']);

/** `$XDG_CONFIG_HOME/codex-rotator`（設定と制御トークンの親フォルダ）。 */
export const codexRotatorConfigDir = env => join(xdgConfigHome(env), CODEX_ROTATOR_APP_NAME);
/** `$XDG_CONFIG_HOME/codex-rotator/config.json`。 */
export const codexRotatorConfigPath = env => join(codexRotatorConfigDir(env), 'config.json');
/** `$XDG_CONFIG_HOME/codex-rotator/control-token.json`（常駐が起動のたびに書き、CLI が常駐の操作の入口へ渡す制御トークン）。 */
export const controlTokenPath = env => join(codexRotatorConfigDir(env), 'control-token.json');
/** `$XDG_DATA_HOME/codex-rotator`。 */
export const codexRotatorDataDir = env => join(xdgDataHome(env), CODEX_ROTATOR_APP_NAME);
/** `$XDG_DATA_HOME/codex-rotator/bin`（shim の置き場所。本物の codex を探すときは飛ばす）。 */
export const shimDir = env => join(codexRotatorDataDir(env), 'bin');
/** `$XDG_STATE_HOME/codex-rotator`（ログなど、消えても設定に響かないもの）。 */
export const codexRotatorStateDir = env => join(xdgStateHome(env), CODEX_ROTATOR_APP_NAME);
/** `~/.codex`（Codex CLI の既定の CODEX_HOME）。口座の外であり、口座として登録できない。 */
export const defaultCodexHome = env => join(homeDir(env), '.codex');

/**
 * 先頭の `~`・`~/` を env の HOME で展開する。それ以外（`~user` を含む）はそのまま返す。
 * 展開は文字列の操作だけで、ファイルシステムには触れない。
 */
export function expandHomePath(value, env) {
  if (value === '~') return homeDir(env);
  if (typeof value === 'string' && value.startsWith('~/')) return join(homeDir(env), value.slice(2));
  return value;
}
