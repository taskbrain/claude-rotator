import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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

export async function fileSha256(path) {
  const body = await readFile(path);
  return createHash('sha256').update(body).digest('hex');
}
