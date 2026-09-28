import {
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  statSync,
  writeSync,
} from 'node:fs';

/**
 * server.log のローテーション閾値の既定値。**ここが唯一の定義である。**
 *
 * `config.observability.logMaxBytes` の既定（`DEFAULT_OBSERVABILITY.logMaxBytes`、
 * src/usage-observation.js）もこの値を参照する。本番の server は常に
 * `serverLogWriterOptions()`（src/cli.js）経由で正規化済みの値を渡すので、
 * 実効値は config 未指定なら 32 MiB になる。
 */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * server.log と server.log.1 の権限。中身はメタデータだけだが、口座名や要求経路などの
 * 運用情報を含むので所有者以外に読ませない。
 */
export const LOG_FILE_MODE = 0o600;

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

    // copyFileSync（libuv）はコピー先を複製元の mode で作り、既存のコピー先も中身を
    // 書く前に複製元の mode へ fchmod する。そこで複製元を先に 0600 にしておけば、
    // .1 は中身が入った時点から 0600 になる。直せないときは回転しない（例外は下の
    // catch で握りつぶし、false を返す）。
    if ((fdStat.mode & 0o777) !== LOG_FILE_MODE) fchmodSync(fd, LOG_FILE_MODE);
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
    fd = openSync(logPath, 'a', LOG_FILE_MODE);
  } catch {
    return null;
  }
  // 作成時の mode は umask で削られるだけで、既存ファイル（launchd/systemd が先に
  // 作った server.log など）には効かない。起動時に umask と無関係に 0600 へ補正する。
  // 通常ファイルに限る（/dev/null へのシンボリックリンクなどの権限は変えない）。
  try {
    if (fstatSync(fd).isFile()) fchmodSync(fd, LOG_FILE_MODE);
  } catch {
    // 権限を直せなくてもログは書く（ログで server を落とさない）。
  }
  restrictBackupMode(`${logPath}.1`);

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

/**
 * 既存の server.log.1 を 0600 にする。シンボリックリンクはたどらず、通常ファイルだけを
 * 対象に、開いた fd へ fchmod する（パスへの chmod はリンク先の権限を変えてしまう）。
 * 無い・条件に合わない・直せないときは何もしない（例外を投げない）。
 */
function restrictBackupMode(path) {
  let fd;
  try {
    if (!lstatSync(path).isFile()) return;
    // O_NONBLOCK: lstat と open の間に FIFO へ差し替えられても open で止まらない。
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (fstatSync(fd).isFile()) fchmodSync(fd, LOG_FILE_MODE);
  } catch {
    // ENOENT（まだ回転していない）・ELOOP（シンボリックリンク）を含め、補正を飛ばす。
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // 閉じられなくても server は続ける。
      }
    }
  }
}
