// 自分だけが読み書きできるフォルダ・ファイルであることの検査。
//
// 対象は、口座フォルダの根（accountsDir）、制御トークンのファイルとその親フォルダなど、
// 他の利用者やシンボリックリンクの差し替えで中身を読まれたり書き換えられたりしては
// 困る場所である。検査は4つ:
//   - シンボリックリンクでないこと（lstat で見る。リンク先は辿らない）
//   - 種類（フォルダ／通常のファイル）
//   - 所有者が自分（実行中のプロセスの uid）
//   - 権限が広すぎない（フォルダはグループと他人のビットが0＝0700 まで。ファイルはそれに加えて
//     実行ビットと setuid・setgid・sticky のビットも0＝0600 まで）
// 例外のメッセージにはパスを入れない（口座フォルダのパスをログへ出さない約束のため）。
// どの場所の話かは、呼び出し側が渡す what（例 'accountsDir'）で示す。
import { constants, lstatSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// 読み込むファイルの大きさの既定の上限（制御トークンのような小さなファイルが対象）。
export const DEFAULT_PRIVATE_FILE_MAX_BYTES = 64 * 1024;

// 理由の語。呼び出し側は message ではなくこれで分岐する。
export const FSGUARD_REASON = Object.freeze({
  missing: 'missing',
  symlink: 'symlink',
  notDirectory: 'not-directory',
  notRegularFile: 'not-regular-file',
  wrongOwner: 'wrong-owner',
  modeTooOpen: 'mode-too-open',
  tooLarge: 'too-large',
  unreadable: 'unreadable',
});

const REASON_TEXT = Object.freeze({
  [FSGUARD_REASON.missing]: 'does not exist',
  [FSGUARD_REASON.symlink]: 'must not be a symbolic link',
  [FSGUARD_REASON.notDirectory]: 'must be a directory',
  [FSGUARD_REASON.notRegularFile]: 'must be a regular file',
  [FSGUARD_REASON.wrongOwner]: 'must be owned by the current user',
  [FSGUARD_REASON.modeTooOpen]: 'must be private (at most 0700 for a directory and 0600 for a file, no special bits on a file)',
  [FSGUARD_REASON.tooLarge]: 'is larger than allowed',
  [FSGUARD_REASON.unreadable]: 'cannot be inspected',
});

export class FsGuardError extends Error {
  constructor(what, reason) {
    super(`${what} ${REASON_TEXT[reason] ?? REASON_TEXT[FSGUARD_REASON.unreadable]}`);
    this.name = 'FsGuardError';
    this.reason = reason;
  }
}

function currentUid(uid) {
  if (Number.isInteger(uid)) return uid;
  if (typeof process.getuid !== 'function') {
    // 所有者を確かめられない環境では、確かめずに通すことはしない。
    throw new FsGuardError('owner check', FSGUARD_REASON.unreadable);
  }
  return process.getuid();
}

// 権限ビットのうち、立っていてはいけないもの。
//   - ファイル: グループと他人のビット、所有者の実行ビット、setuid・setgid・sticky（0o7177）。
//   - フォルダ: グループと他人のビットだけ（0o077）。setuid・setgid・sticky は拒否しない。
//     フォルダの setgid は、中に作るものへグループを引き継がせるだけで（Linux では新しい
//     フォルダにも setgid が写る。親に立っていると 0700 で作っても 02700 になる）、sticky は
//     削除できる人を絞るだけ、setuid はフォルダでは意味を持たない。グループと他人のビットが0なら、
//     どれも所有者以外に読み書きや一覧を許さない。
const FORBIDDEN_MODE_BITS = Object.freeze({ directory: 0o077, file: 0o7177 });

// lstat・fstat の結果を検査する。isSymbolicLink は lstat の結果でだけ意味を持つ。
function checkStats(stats, { what, kind, uid }) {
  if (stats.isSymbolicLink()) throw new FsGuardError(what, FSGUARD_REASON.symlink);
  if (kind === 'directory' && !stats.isDirectory()) throw new FsGuardError(what, FSGUARD_REASON.notDirectory);
  if (kind === 'file' && !stats.isFile()) throw new FsGuardError(what, FSGUARD_REASON.notRegularFile);
  if (stats.uid !== uid) throw new FsGuardError(what, FSGUARD_REASON.wrongOwner);
  if ((stats.mode & FORBIDDEN_MODE_BITS[kind]) !== 0) throw new FsGuardError(what, FSGUARD_REASON.modeTooOpen);
}

function lstatFailure(error, what) {
  const reason = error?.code === 'ENOENT' ? FSGUARD_REASON.missing : FSGUARD_REASON.unreadable;
  return new FsGuardError(what, reason);
}

async function lstatOrThrow(path, what, lstatImpl) {
  try {
    return await lstatImpl(path);
  } catch (error) {
    throw lstatFailure(error, what);
  }
}

/**
 * フォルダが「シンボリックリンクでない・フォルダ・所有者が自分・0700 より広くない」ことを確かめる。
 * @param {string} path
 * @param {{ what?: string, uid?: number, lstatImpl?: typeof lstat }} [options]
 */
export async function assertPrivateDirectory(path, { what = 'directory', uid, lstatImpl = lstat } = {}) {
  const expectedUid = currentUid(uid);
  checkStats(await lstatOrThrow(path, what, lstatImpl), { what, kind: 'directory', uid: expectedUid });
}

/**
 * assertPrivateDirectory の同期版（ログの書き手のように、同期で動く呼び出し側のため）。
 * @param {string} path
 * @param {{ what?: string, uid?: number, lstatSyncImpl?: typeof lstatSync }} [options]
 */
export function assertPrivateDirectorySync(path, { what = 'directory', uid, lstatSyncImpl = lstatSync } = {}) {
  const expectedUid = currentUid(uid);
  let stats;
  try {
    stats = lstatSyncImpl(path);
  } catch (error) {
    throw lstatFailure(error, what);
  }
  checkStats(stats, { what, kind: 'directory', uid: expectedUid });
}

/**
 * ファイルが「シンボリックリンクでない・通常のファイル・所有者が自分・0600 より広くない」ことを確かめる。
 * 検査の後で中身を読むなら、検査と読込の間の差し替えを防げる readPrivateFile を使う。
 * @param {string} path
 * @param {{ what?: string, uid?: number, lstatImpl?: typeof lstat }} [options]
 */
export async function assertPrivateFile(path, { what = 'file', uid, lstatImpl = lstat } = {}) {
  const expectedUid = currentUid(uid);
  checkStats(await lstatOrThrow(path, what, lstatImpl), { what, kind: 'file', uid: expectedUid });
}

/**
 * assertPrivateFile と同じ検査を、開いたファイルそのもの（fstat）に対して行ってから読む。
 * O_NOFOLLOW で最後の部分がシンボリックリンクなら開かず、O_NONBLOCK で名前付きパイプに
 * 読込で止められない。検査と読込の間にファイルを差し替えられても、読むのは検査した実体である。
 * @param {string} path
 * @param {{ what?: string, uid?: number, maxBytes?: number, openImpl?: typeof open }} [options]
 * @returns {Promise<string>}
 */
export async function readPrivateFile(path, {
  what = 'file', uid, maxBytes = DEFAULT_PRIVATE_FILE_MAX_BYTES, openImpl = open,
} = {}) {
  const expectedUid = currentUid(uid);
  let handle;
  try {
    handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new FsGuardError(what, FSGUARD_REASON.missing);
    if (error?.code === 'ELOOP') throw new FsGuardError(what, FSGUARD_REASON.symlink);
    throw new FsGuardError(what, FSGUARD_REASON.unreadable);
  }
  try {
    const stats = await handle.stat();
    checkStats(stats, { what, kind: 'file', uid: expectedUid });
    if (stats.size > maxBytes) throw new FsGuardError(what, FSGUARD_REASON.tooLarge);
    // 検査の後に書き足されても、読むのは上限＋1バイトまで（超えたら拒否する）。
    const limit = maxBytes + 1;
    const buffer = Buffer.alloc(limit);
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, total, limit - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new FsGuardError(what, FSGUARD_REASON.tooLarge);
    return buffer.subarray(0, total).toString('utf8');
  } catch (error) {
    if (error instanceof FsGuardError) throw error;
    throw new FsGuardError(what, FSGUARD_REASON.unreadable);
  } finally {
    await handle.close().catch(() => {});
  }
}
