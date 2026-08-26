import { closeSync, copyFileSync, fstatSync, ftruncateSync, openSync, statSync, writeSync } from 'node:fs';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Rotates a file-descriptor-backed log using the copytruncate strategy.
 *
 * This copies the current content of `logPath` aside to `${logPath}.1` and
 * truncates the open `fd` back to zero.
 *
 * Contract (caller's responsibility): `fd` is required and must be open
 * O_APPEND. Under O_APPEND, every write seeks to end-of-file first, so once
 * this function truncates the file, the very next write lands at offset 0
 * with no extra coordination. With a non-O_APPEND fd (e.g. a `>` redirect
 * held open at a fixed offset), a write after truncate would resume at the
 * old offset and leave a sparse hole instead of rotating cleanly, growing
 * without bound. `createServerLogWriter` below satisfies this contract
 * structurally by always opening its own fd with the `'a'` flag (O_APPEND)
 * rather than trusting an fd it did not open itself (e.g. inherited
 * stdout, which may be a plain `>` redirect) — do not call this function
 * directly against an fd of unknown provenance. There is deliberately no
 * default fd: the most "unknown provenance" fd of all is the process's own
 * inherited stdout, so silently falling back to it would contradict the
 * rule above.
 *
 * Never throws: any failure (including logPath not actually being the file
 * behind fd) is treated as "skip rotation" so a logging problem can never
 * take the server down.
 */
export function maybeRotateLog({ fd, logPath, maxBytes = LOG_MAX_BYTES } = {}) {
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

/**
 * Creates a self-contained writer for the service's metadata-only request
 * log. Opens its own fd on `logPath` with the `'a'` flag (O_APPEND),
 * independent of process.stdout — this is what makes it safe to rotate:
 * the fd is guaranteed O_APPEND because this function is the one that
 * opened it, satisfying `maybeRotateLog`'s contract regardless of how the
 * process's own stdout happens to be redirected.
 *
 * Returns `null` if `logPath` cannot be opened (e.g. missing directory),
 * so callers can fall back to another output. `write()` never throws: a
 * failure to rotate or append is swallowed so logging can never take the
 * server down.
 */
export function createServerLogWriter({ logPath, maxBytes = LOG_MAX_BYTES } = {}) {
  let fd;
  try {
    fd = openSync(logPath, 'a');
  } catch {
    return null;
  }

  return {
    write(line) {
      if (fd < 0) return; // closed: never write through a stale/reused fd number
      try {
        maybeRotateLog({ fd, logPath, maxBytes });
        writeSync(fd, `${line}\n`);
      } catch {
        // A logging failure must never take the server down.
      }
    },
    close() {
      try {
        closeSync(fd);
      } catch {
        // Already closed or otherwise unusable; nothing more to do.
      } finally {
        // The OS is free to reuse this fd number for an unrelated file
        // (config.json, runtime-state.json, ...) as soon as it's closed.
        // Invalidate it here so any late write() can never land there.
        fd = -1;
      }
    },
  };
}
