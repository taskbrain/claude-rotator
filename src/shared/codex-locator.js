// codex-rotator の置き場所のうち、Claude 側（`claude-rotator status`・monitor）が Codex の節を描くために
// 要るもの: codex-rotator の設定ファイルの場所と、codex-rotator の入口（bin/codex-rotator.js）の絶対パス。
//
// 共用部品なので、import してよいのは src/shared/ と node: の標準部品だけ（境界検査）。Codex 側の
// src/codex/paths.js を import できないので、設定ファイルの場所の決め方を同じ規則でここにも持つ
// （揃っていることは test/shared/codex-view.test.js で確かめる）。
//
// 読むのは、渡された env の HOME と XDG_CONFIG_HOME だけ。process.env を既定値にしない（渡し忘れても
// 実のホームへ届かないようにするため）。ファイルシステムには触れない。
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_NAME = 'codex-rotator';
const CONFIG_FILE = 'config.json';

/**
 * codex-rotator の設定ファイルの場所（`$XDG_CONFIG_HOME/codex-rotator/config.json`。XDG_CONFIG_HOME が
 * 絶対パスでなければ `$HOME/.config/codex-rotator/config.json`）。HOME が絶対パスでなく、XDG_CONFIG_HOME も
 * 使えないときは、場所を決められないので null。
 * @param {object} env
 * @returns {string|null}
 */
export function codexRotatorConfigFile(env) {
  const xdg = env?.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && isAbsolute(xdg)) return join(resolve(xdg), APP_NAME, CONFIG_FILE);
  const home = env?.HOME;
  if (typeof home !== 'string' || !isAbsolute(home)) return null;
  return join(resolve(home), '.config', APP_NAME, CONFIG_FILE);
}

/** codex-rotator の入口の絶対パス（このファイルの場所から求める。PATH は探さない）。 */
export function codexRotatorEntryPath() {
  return fileURLToPath(new URL('../../bin/codex-rotator.js', import.meta.url));
}
