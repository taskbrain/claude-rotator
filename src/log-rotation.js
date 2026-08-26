import { copyFileSync, fstatSync, ftruncateSync, statSync } from 'node:fs';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Rotates a file-descriptor-backed log using the copytruncate strategy.
 *
 * This copies the current content of `logPath` aside to `${logPath}.1` and
 * truncates the open `fd` back to zero.
 *
 * Contract (caller's responsibility): `fd` must be open O_APPEND. Under
 * O_APPEND, every write seeks to end-of-file first, so once this function
 * truncates the file, the very next write lands at offset 0 with no extra
 * coordination. With a non-O_APPEND fd (e.g. a `>` redirect held open at a
 * fixed offset), a write after truncate would resume at the old offset and
 * leave a sparse hole instead of rotating cleanly. This function is
 * therefore only safe on the service's stdout, which launchd
 * (`StandardOutPath`) and systemd (`StandardOutput=append:`) both open
 * O_APPEND — not on arbitrary redirected file descriptors.
 *
 * Never throws: any failure (including logPath not actually being the file
 * behind fd) is treated as "skip rotation" so a logging problem can never
 * take the server down.
 */
export function maybeRotateLog({ fd = 1, logPath, maxBytes = LOG_MAX_BYTES } = {}) {
  try {
    const fdStat = fstatSync(fd);
    if (fdStat.size <= maxBytes) return false;

    const pathStat = statSync(logPath);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) return false;

    copyFileSync(logPath, `${logPath}.1`);
    ftruncateSync(fd, 0);
    return true;
  } catch {
    return false;
  }
}
