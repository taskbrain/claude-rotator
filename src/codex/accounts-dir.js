// 口座のフォルダ（口座ごとの CODEX_HOME）の名付けと作成。
//
// 名付け方:
//   - 口座のフォルダは、口座フォルダの根（設定の accountsDir）の直下に、変わらないローカルの
//     識別子を名前にして作る。識別子は乱数から作る UUID（版4・小文字）で、ラベルやメールアドレス
//     など口座の中身から作らない。ラベルを後で変えてもフォルダの名前は変わらない。
//   - 名前の形は ACCOUNT_DIR_NAME_PATTERN（36文字）。ラベルは32文字までなので、口座のフォルダの
//     名前がラベルと同じ形になることは無い。登録を外したフォルダを片付けるときも、この形に合う
//     名前だけを対象にする。
// 作成:
//   - 根が無ければ 0700 で作り、あれば自分だけのフォルダであることを確かめる（fsguard.js）。
//   - 口座のフォルダは、既にあるものを使わない（中身が空でも、シンボリックリンクでも、作らずに
//     拒否する）。新しく 0700 で作り、その中に login が書く config.toml（account-config.js の
//     ACCOUNT_CONFIG_TOML）を 0600 で新しく書く。
//   - 途中で失敗しても、作ったフォルダは消さない（呼び出し側が、登録していないことを知らせる）。
// 例外のメッセージにはパスを入れない（口座のフォルダのパスをログへ出さない約束のため）。
import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDirectoryDurable } from '../json-file.js';
import { ACCOUNT_CONFIG_TOML } from './account-config.js';
import { assertPrivateDirectory } from './fsguard.js';

/** 口座のフォルダの名前の形（UUID の版4、小文字の16進）。 */
export const ACCOUNT_DIR_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 口座のフォルダの中に login が書く設定ファイルの名前。 */
export const ACCOUNT_CONFIG_FILE_NAME = 'config.toml';

// 理由の語。呼び出し側は message ではなくこれで分岐する。
export const ACCOUNTS_DIR_REASON = Object.freeze({
  badName: 'bad-name',
  rootUnusable: 'root-unusable',
  exists: 'exists',
  createFailed: 'create-failed',
  notPrivate: 'not-private',
  configWriteFailed: 'config-write-failed',
});

const REASON_TEXT = Object.freeze({
  [ACCOUNTS_DIR_REASON.badName]: 'the new account folder name is not a local identifier',
  [ACCOUNTS_DIR_REASON.rootUnusable]: 'accountsDir could not be created or is not a private folder',
  [ACCOUNTS_DIR_REASON.exists]: 'a folder or file with the new account folder name already exists',
  [ACCOUNTS_DIR_REASON.createFailed]: 'the new account folder could not be created',
  [ACCOUNTS_DIR_REASON.notPrivate]: 'the new account folder is not a private folder',
  [ACCOUNTS_DIR_REASON.configWriteFailed]: 'the config.toml of the new account folder could not be written',
});

export class AccountsDirError extends Error {
  /**
   * @param {string} reason ACCOUNTS_DIR_REASON のどれか
   * @param {{ folderCreated?: boolean }} [details] folderCreated は、失敗の前に口座のフォルダを
   *   作っていたか（作っていれば、そのフォルダは消さずに残っている）
   */
  constructor(reason, { folderCreated = false } = {}) {
    super(REASON_TEXT[reason]);
    this.name = 'AccountsDirError';
    this.reason = reason;
    this.folderCreated = folderCreated;
  }
}

/** 名前が口座のフォルダの名付け方に合うか。 */
export function isAccountDirName(name) {
  return typeof name === 'string' && ACCOUNT_DIR_NAME_PATTERN.test(name);
}

/**
 * 新しい口座のフォルダの名前を作る。
 * @param {{ randomUUID?: () => string }} [deps] randomUUID はテストが名前を決めるための差し替え
 * @returns {string}
 */
export function newAccountDirName({ randomUUID = cryptoRandomUUID } = {}) {
  const name = randomUUID();
  if (!isAccountDirName(name)) throw new AccountsDirError(ACCOUNTS_DIR_REASON.badName);
  return name;
}

/** 根と名前から口座のフォルダのパスを作る（ファイルシステムには触れない）。 */
export function accountDirPath(accountsDir, name) {
  if (!isAccountDirName(name)) throw new AccountsDirError(ACCOUNTS_DIR_REASON.badName);
  return join(accountsDir, name);
}

// 名前を付けた後のフォルダの書き出し。失敗しても作成の結果は変えない。
async function syncFolder(folder, openImpl) {
  let handle;
  try {
    handle = await openImpl(folder, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // 書き出しを扱えないファイルシステムでも、作ったものはそのまま使う。
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeNewPrivateFile(path, text, openImpl) {
  let handle;
  try {
    handle = await openImpl(path, 'wx', 0o600);
    await handle.writeFile(text);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 根の直下に新しい口座のフォルダを作り、login が書く config.toml を置く。
 * @param {{ accountsDir: string, name: string,
 *   fileOps?: { mkdir?: Function, open?: Function, lstat?: Function } }} options
 *   accountsDir は検証済みの設定の値（絶対パス）。fileOps はテストが失敗を起こすための差し替え。
 * @returns {Promise<string>} 作った口座のフォルダのパス
 */
export async function createAccountDir({ accountsDir, name, fileOps = {} }) {
  const path = accountDirPath(accountsDir, name);
  const mkdirImpl = fileOps.mkdir ?? mkdir;
  const openImpl = fileOps.open ?? open;
  try {
    await ensureDirectoryDurable(accountsDir, 0o700, { mkdir: mkdirImpl, open: openImpl });
    await assertPrivateDirectory(accountsDir, { what: 'accountsDir', lstatImpl: fileOps.lstat });
  } catch {
    throw new AccountsDirError(ACCOUNTS_DIR_REASON.rootUnusable);
  }
  try {
    // recursive にしない。既にある名前（フォルダ・リンク・ファイル）は EEXIST で止まる。
    await mkdirImpl(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new AccountsDirError(ACCOUNTS_DIR_REASON.exists);
    throw new AccountsDirError(ACCOUNTS_DIR_REASON.createFailed);
  }
  await syncFolder(accountsDir, openImpl);
  try {
    await assertPrivateDirectory(path, { what: 'the new account folder', lstatImpl: fileOps.lstat });
  } catch {
    throw new AccountsDirError(ACCOUNTS_DIR_REASON.notPrivate, { folderCreated: true });
  }
  try {
    await writeNewPrivateFile(join(path, ACCOUNT_CONFIG_FILE_NAME), ACCOUNT_CONFIG_TOML, openImpl);
  } catch {
    throw new AccountsDirError(ACCOUNTS_DIR_REASON.configWriteFailed, { folderCreated: true });
  }
  await syncFolder(path, openImpl);
  return path;
}
