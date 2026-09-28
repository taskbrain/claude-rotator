import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function readJsonFile(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function writeJsonFile(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;

  try {
    await writeFile(tmpPath, body, { mode });
    await rename(tmpPath, path);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeJsonFileDurable(path, value, mode = 0o600, deps = {}) {
  const openImpl = deps.open || open;
  const renameImpl = deps.rename || rename;
  const unlinkImpl = deps.unlink || unlink;
  await ensureDirectoryDurable(dirname(path), 0o700, deps);
  const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  let handle;

  try {
    handle = await openImpl(tmpPath, 'wx', mode);
    await handle.writeFile(body);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameImpl(tmpPath, path);
    await syncParentDirectory(path, { ...deps, open: openImpl });
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlinkImpl(tmpPath).catch(() => {});
    throw error;
  }
}

export async function ensureDirectoryDurable(path, mode = 0o700, deps = {}) {
  const mkdirImpl = deps.mkdir || mkdir;
  const target = resolve(path);
  const firstCreated = await mkdirImpl(target, { recursive: true, mode });
  if (typeof firstCreated !== 'string') return;

  const first = resolve(firstCreated);
  const createdDirectories = [];
  let current = target;
  while (true) {
    createdDirectories.unshift(current);
    if (current === first) break;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error('mkdir returned a directory outside the requested path');
    }
    current = parent;
  }
  for (const directory of createdDirectories) {
    await syncParentDirectory(directory, deps);
  }
}

export async function removeFileDurable(path, deps = {}) {
  const rmImpl = deps.rm || rm;
  await rmImpl(path, { force: true });
  await syncParentDirectory(path, deps);
}

async function syncParentDirectory(path, deps = {}) {
  const openImpl = deps.open || open;
  const handle = await openImpl(dirname(path), fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// writeJsonFile / writeJsonFileDurable の一時ファイル名は `<path>.<pid>.<12桁hex>.tmp`。
// rename 前にプロセスが SIGKILL 等で消えると、この一時ファイルが残る（catch の unlink が走らない）。
export const DEFAULT_STALE_TMP_MAX_AGE_MS = 10 * 60_000;

/**
 * `path` の原子的書き込みが残した一時ファイルのうち、確実に持ち主のいないものだけを消す。
 *
 * 消す条件（すべて満たすもの）: 名前が `<basename>.<pid>.<12桁hex>.tmp` の形／pid が 1 以上で
 * 自分ではない／`kill(pid, 0)` が ESRCH（EPERM・成功は生存扱いで残す）／通常ファイル
 * （lstat で判定。シンボリックリンク・ディレクトリは消さない）／mtime が `maxAgeMs` より古い。
 * 1件の削除失敗で止めず、`failed` へ積んで次へ進む。ディレクトリが無ければ何もしない。
 * ESRCH を「持ち主不在」と読むのは、ディレクトリを同じ PID 名前空間のプロセスだけが使う前提による
 * （別の名前空間の書き手は生存中でも ESRCH に見える）。共有構成での無効化は呼び出し側で行う。
 * ディレクトリの一覧取得そのものの失敗（ENOENT 以外）は呼び出し側へ投げる。
 *
 * @returns {Promise<{removed: string[], failed: string[]}>} ファイル名（basename）の一覧。
 */
export async function removeStaleTmpFiles(path, {
  maxAgeMs = DEFAULT_STALE_TMP_MAX_AGE_MS,
  now = Date.now,
  pid = process.pid,
  kill = (target, signal) => process.kill(target, signal),
  readdir: readdirImpl = readdir,
  lstat: lstatImpl = lstat,
  unlink: unlinkImpl = unlink,
} = {}) {
  const dir = dirname(path);
  const pattern = new RegExp(`^${escapeRegExp(basename(path))}\\.(\\d+)\\.[0-9a-f]{12}\\.tmp$`);
  const removed = [];
  const failed = [];
  let names;
  try {
    names = await readdirImpl(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { removed, failed };
    throw error;
  }
  const cutoff = now() - maxAgeMs;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid === pid) continue;
    const filePath = join(dir, name);
    try {
      const info = await lstatImpl(filePath);
      if (!info.isFile() || !(info.mtimeMs < cutoff)) continue;
      if (!isProcessGone(ownerPid, kill)) continue;
      await unlinkImpl(filePath);
      removed.push(name);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      failed.push(name);
    }
  }
  return { removed, failed };
}

function isProcessGone(pid, kill) {
  try {
    kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function fileSha256(path) {
  const body = await readFile(path);
  return createHash('sha256').update(body).digest('hex');
}
