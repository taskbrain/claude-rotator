import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  const mkdirImpl = deps.mkdir || mkdir;
  const openImpl = deps.open || open;
  const renameImpl = deps.rename || rename;
  const unlinkImpl = deps.unlink || unlink;
  await mkdirImpl(dirname(path), { recursive: true });
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

export async function fileSha256(path) {
  const body = await readFile(path);
  return createHash('sha256').update(body).digest('hex');
}
