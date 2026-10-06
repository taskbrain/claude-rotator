// 常駐の操作の入口に掛ける制御トークン。
//
// 常駐は起動のたびに新しいトークンを作り、待ち受けを始める前に
// `$XDG_CONFIG_HOME/codex-rotator/control-token.json`（0600）へ書く。CLI 側はこのファイルを読み、
// 要求ヘッダ X-Codex-Rotator-Token で渡す。
//
// 約束:
//   - 置き場所は、呼び出し側が渡した env から1回だけ求めて覚える。書くのも消すのも、覚えたその場所だけ
//     （起動の後に env を書き換えられても、別の場所を消さない）。env を既定値で補わない。
//   - 消すのは、覚えた場所のファイルが自分の書いた値を持つときだけ（読んで照合してから消す）。別の値に
//     置き換わっていたら消さない。
//   - 書く前に、親フォルダが自分だけのフォルダ（0700 まで・所有者が自分・シンボリックリンクでない）で
//     あることを確かめる。書き方は一時ファイルを作ってから名前を置き換える形（json-file.js）。
//   - 照合は、両方を SHA-256 にかけて長さを32バイトにそろえてから timingSafeEqual で比べる。
//   - 例外のメッセージは固定の文言だけで、トークン・ファイルの中身・パスを入れない。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FSGUARD_REASON, FsGuardError, assertPrivateDirectory, readPrivateFile } from './fsguard.js';
import { controlTokenPath } from './paths.js';
import { writeJsonFileDurable } from '../json-file.js';

/** トークンを渡す要求ヘッダの名前（HTTP のヘッダ名は大文字小文字を区別しない。Node は小文字で渡す）。 */
export const CONTROL_TOKEN_HEADER = 'x-codex-rotator-token';
export const CONTROL_TOKEN_MIN_LENGTH = 32;
export const CONTROL_TOKEN_MAX_LENGTH = 256;
/** CLI 側が読むファイルの大きさの上限（トークンの上限の長さと JSON の枠が収まる）。 */
export const CONTROL_TOKEN_FILE_MAX_BYTES = 1024;
/** ファイルの権限（所有者だけが読み書きできる）。 */
export const CONTROL_TOKEN_FILE_MODE = 0o600;

// ヘッダに載せてよい文字だけ（区切りの `,`・空白・引用符を含めない）。
const TOKEN_CHARACTERS = /^[A-Za-z0-9_-]+$/;

// 理由の語。呼び出し側は message ではなくこれで分岐する。
export const CONTROL_TOKEN_REASON = Object.freeze({
  invalidToken: 'invalid-token',
  path: 'path',
  folder: 'folder',
  write: 'write',
  missing: FSGUARD_REASON.missing,
  symlink: FSGUARD_REASON.symlink,
  notRegularFile: FSGUARD_REASON.notRegularFile,
  wrongOwner: FSGUARD_REASON.wrongOwner,
  modeTooOpen: FSGUARD_REASON.modeTooOpen,
  tooLarge: FSGUARD_REASON.tooLarge,
  unreadable: FSGUARD_REASON.unreadable,
  malformed: 'malformed',
});

const REASON_TEXT = Object.freeze({
  [CONTROL_TOKEN_REASON.invalidToken]: 'the generated control token is not usable',
  [CONTROL_TOKEN_REASON.path]: 'the control token location cannot be determined',
  [CONTROL_TOKEN_REASON.folder]: 'the control token folder is not private',
  [CONTROL_TOKEN_REASON.write]: 'the control token file cannot be written',
  [CONTROL_TOKEN_REASON.missing]: 'the control token file does not exist',
  [CONTROL_TOKEN_REASON.symlink]: 'the control token file must not be a symbolic link',
  [CONTROL_TOKEN_REASON.notRegularFile]: 'the control token file must be a regular file',
  [CONTROL_TOKEN_REASON.wrongOwner]: 'the control token file must be owned by the current user',
  [CONTROL_TOKEN_REASON.modeTooOpen]: 'the control token file must be private (at most 0600)',
  [CONTROL_TOKEN_REASON.tooLarge]: 'the control token file is larger than allowed',
  [CONTROL_TOKEN_REASON.unreadable]: 'the control token file cannot be read',
  [CONTROL_TOKEN_REASON.malformed]: 'the control token file does not hold a usable token',
});

/** 制御トークンの失敗。メッセージは理由ごとの固定の文言だけで、下の層の例外を持ち込まない。 */
export class ControlTokenError extends Error {
  constructor(reason) {
    const known = Object.hasOwn(REASON_TEXT, reason) ? reason : CONTROL_TOKEN_REASON.unreadable;
    super(REASON_TEXT[known]);
    this.name = 'ControlTokenError';
    this.reason = known;
  }
}

/** 既定の生成関数: 32バイトの乱数を16進にした64文字。 */
export const generateControlToken = () => randomBytes(32).toString('hex');

/** 文字列で、ヘッダに載せてよい文字だけからなり、32〜256文字か。 */
export function isWellFormedControlToken(value) {
  return typeof value === 'string' && value.length >= CONTROL_TOKEN_MIN_LENGTH
    && value.length <= CONTROL_TOKEN_MAX_LENGTH && TOKEN_CHARACTERS.test(value);
}

function assertEnv(env) {
  if (env === null || typeof env !== 'object') throw new TypeError('env is required');
}

// env から置き場所を求める。求められなければ（HOME が絶対パスでないなど）固定の失敗にする。
function tokenPathOf(env) {
  try {
    return controlTokenPath(env);
  } catch {
    throw new ControlTokenError(CONTROL_TOKEN_REASON.path);
  }
}

/**
 * 常駐の側の制御トークンのファイル。作った時点で置き場所を1回だけ求めて覚える。
 * writeJson は書込の関数（既定は json-file.js の writeJsonFileDurable）。
 * テストで失敗の経路を試すためだけのもの。常駐を起動するコマンドは渡さない。
 * @param {{ env: object, generateToken?: () => string, writeJson?: Function }} options
 * @returns {{
 *   assertFolder: () => Promise<void>,
 *   generate: () => string,
 *   write: (token: string) => Promise<void>,
 *   remove: () => Promise<void>,
 * }}
 */
export function createControlTokenFile({ env, generateToken = generateControlToken, writeJson = writeJsonFileDurable } = {}) {
  assertEnv(env);
  if (typeof generateToken !== 'function') throw new TypeError('generateToken must be a function');
  if (typeof writeJson !== 'function') throw new TypeError('writeJson must be a function');
  const path = tokenPathOf(env);
  const folder = dirname(path);
  // 書こうとした値。書込の途中（名前の置き換えの後の同期など）で失敗しても、消せるように先に覚える。
  let owned = null;

  const assertFolder = async () => {
    try {
      await assertPrivateDirectory(folder, { what: 'the control token folder' });
    } catch {
      throw new ControlTokenError(CONTROL_TOKEN_REASON.folder);
    }
  };

  return {
    /** 親フォルダが自分だけのフォルダであることを確かめる。違えば ControlTokenError（folder）。 */
    assertFolder,
    /** 生成関数を呼び、形を確かめてから返す。形が違えば ControlTokenError（invalid-token）。 */
    generate() {
      let token;
      try {
        token = generateToken();
      } catch {
        throw new ControlTokenError(CONTROL_TOKEN_REASON.invalidToken);
      }
      if (!isWellFormedControlToken(token)) throw new ControlTokenError(CONTROL_TOKEN_REASON.invalidToken);
      return token;
    },
    /**
     * 覚えた場所へ `{ "token": "<値>" }` だけを 0600 で書く。書く直前にも親フォルダを確かめる
     * （違えば folder）。書込の失敗は ControlTokenError（write）。
     */
    async write(token) {
      if (!isWellFormedControlToken(token)) throw new ControlTokenError(CONTROL_TOKEN_REASON.invalidToken);
      await assertFolder();
      owned = token;
      try {
        await writeJson(path, { token }, CONTROL_TOKEN_FILE_MODE);
      } catch {
        throw new ControlTokenError(CONTROL_TOKEN_REASON.write);
      }
    },
    /**
     * 覚えた場所のファイルを、自分の書いた値を持つときだけ消す。読取は fsguard の検査（シンボリックリンク
     * でない・通常のファイル・所有者・0600 まで・上限 1 KiB）を通す。読めない・形が違う・値が違うときは
     * 消さない。書こうとしていなければ何もしない。失敗しても例外を外へ出さない（次の起動で置き換わる）。
     */
    async remove() {
      const expected = owned;
      owned = null;
      if (expected === null) return;
      try {
        const present = await readTokenFile(path);
        if (!controlTokenMatches(expected, present)) return;
        // 照合から unlink までの間の差し替えは、同じ利用者の権限でしかできない（その利用者は元から
        // このファイルを消せる）ので、脅威の想定の内側として受け入れる。
        await unlink(path);
      } catch {
        // 読めない・形が違う・消せない。どれも外へ出さない。
      }
    },
  };
}

// JSON の値が、自身のキーとして token だけを持つ素のオブジェクトか。
function tokenOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'token') return null;
  return isWellFormedControlToken(value.token) ? value.token : null;
}

/**
 * CLI 側の読取。ファイルを fsguard の検査（シンボリックリンクでない・通常のファイル・所有者・0600 まで・
 * 大きさの上限）を通してから読み、JSON と token の形を確かめて返す。
 * 失敗は ControlTokenError（メッセージにファイルの中身とパスを入れない）。
 * @param {{ env: object, uid?: number }} options uid は所有者として期待する uid（既定は自分）
 * @returns {Promise<string>}
 */
export async function readControlToken({ env, uid } = {}) {
  assertEnv(env);
  return readTokenFile(tokenPathOf(env), uid);
}

// 置き場所のファイルを検査してから読み、token の値を返す。失敗は ControlTokenError（中身とパスを含めない）。
async function readTokenFile(path, uid) {
  let text;
  try {
    text = await readPrivateFile(path, { what: 'the control token file', maxBytes: CONTROL_TOKEN_FILE_MAX_BYTES, uid });
  } catch (error) {
    throw new ControlTokenError(error instanceof FsGuardError ? error.reason : CONTROL_TOKEN_REASON.unreadable);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ControlTokenError(CONTROL_TOKEN_REASON.malformed);
  }
  const token = tokenOf(parsed);
  if (token === null) throw new ControlTokenError(CONTROL_TOKEN_REASON.malformed);
  return token;
}

const digestOf = value => createHash('sha256').update(value, 'utf8').digest();

/**
 * 渡された値が期待するトークンと一致するか。どちらかが文字列でなければ一致しない。
 * 両方を SHA-256 にかけて長さを32バイトにそろえてから timingSafeEqual で比べる。
 * @param {string} expected 常駐が持つトークン
 * @param {unknown} presented 要求ヘッダの値（無い・複数の値のときは文字列でないか、連結された値）
 */
export function controlTokenMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string') return false;
  return timingSafeEqual(digestOf(expected), digestOf(presented));
}
