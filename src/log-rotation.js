import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
 * server.log と server.log.1 に設定する権限（所有者だけが読み書きできる 0600）。中身は
 * メタデータだけだが、アカウント ID や要求経路を含むので、所有者以外に読ませないために使う。
 */
export const LOG_FILE_MODE = 0o600;

/**
 * Rotates a file-descriptor-backed log using the copytruncate strategy.
 *
 * This copies the current content of `logPath` aside to `${logPath}.1` and
 * truncates the open `fd` back to zero. The steps, in order:
 *
 * 1. fstat `fd`. If its size is not greater than `maxBytes`, return false.
 * 2. Open `logPath` again with O_RDONLY | O_NONBLOCK and fstat it. If its
 *    dev/ino differ from `fd`'s, return false.
 * 3. Create a temporary file in the same directory, named
 *    `.<basename>.<pid>.<12 hex digits>.rotating`, with
 *    O_CREAT | O_EXCL | O_WRONLY and mode 0600 (the umask can only narrow
 *    it). If creation fails (including when that name already exists, even as
 *    a symlink), rotation is abandoned and nothing is removed.
 * 4. fchmod the temporary file to 0600. If that fchmod fails, fstat the file:
 *    rotation continues only when it has no group or other permission bits
 *    (its mode may then be narrower than 0600); if it has any, or if that
 *    fstat fails, rotation is abandoned.
 * 5. Copy from offset 0 up to the length returned by the fstat in step 2,
 *    using positional reads of at most 1 MiB. What is fixed is that length,
 *    not the content: each read returns what the file holds at that offset
 *    when the read runs. Because the length is fixed, a writer that keeps
 *    appending cannot keep the synchronous copy running. If a read returns 0
 *    bytes before that length is reached, rotation is abandoned without
 *    truncating. The length is not checked again after the last read.
 * 6. Close the temporary file, then rename it over `${logPath}.1`. rename
 *    replaces an existing `${logPath}.1` symlink rather than following it.
 * 7. ftruncate `fd` to 0 and return true.
 *
 * A failure that stops rotation returns false. Two kinds of failure are
 * exceptions and do not by themselves make it return false: a failed fchmod
 * that step 4 tolerates (the temporary file has no group or other permission
 * bits), and a failed close or removal in the cleanup, which is ignored. So
 * true can still be returned after a tolerated fchmod failure or a failed
 * close in the cleanup. Closing is attempted once for each descriptor
 * opened here: for the temporary file in step 6, or in the cleanup when
 * rotation stops before step 6; for the other one in the cleanup. Close
 * errors in the cleanup are ignored. Removal of the temporary file is
 * attempted only when it was created and the rename in step 6 has not
 * completed; a failed removal is ignored, so the file can be left behind. If
 * ftruncate in step 7 fails, `${logPath}.1` has already been replaced,
 * `logPath` is not truncated, and false is returned.
 *
 * This function never changes the mode of `logPath`; the mode of the new
 * `${logPath}.1` comes from steps 3 and 4 only. In this implementation, if
 * the file is not truncated by anyone else and is only appended to at its
 * end between the fstat in step 2 and the truncate in step 7, and that
 * truncate succeeds, the bytes appended in that interval are lost: they are
 * neither copied nor kept.
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
 * Never throws: a failure that stops rotation (including logPath not actually
 * being the file behind fd) returns false instead, and the exceptions above
 * are not thrown either, so a logging problem can never take the server down.
 */
export function maybeRotateLog({ fd, logPath, maxBytes = LOG_MAX_BYTES } = {}) {
  let sourceFd;
  let tempFd;
  let tempPath = null;
  try {
    const fdStat = fstatSync(fd);
    if (fdStat.size <= maxBytes) return false;

    // O_NONBLOCK: 通常ファイルでは効果が無く、FIFO へ差し替えられていても open で止まらない。
    sourceFd = openSync(logPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const sourceStat = fstatSync(sourceFd);
    if (sourceStat.dev !== fdStat.dev || sourceStat.ino !== fdStat.ino) return false;

    // 複製元の権限には頼らない（chmod できない server.log でも回転を止めない）。
    // 一時ファイルは O_EXCL で新しく作るので、既存のファイルやシンボリックリンクを開かない。
    const candidatePath = rotationTempPath(logPath);
    tempFd = openSync(
      candidatePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      LOG_FILE_MODE,
    );
    // 作れたときだけ後始末の対象にする（O_EXCL で失敗した名前は他人のファイルかもしれない）。
    tempPath = candidatePath;
    restrictTempMode(tempFd);
    // 開始時の大きさまでだけ複製する（追記が続いても同期の複製が終わらなくならない）。
    copyFdContents(sourceFd, tempFd, sourceStat.size);
    const tempFdToClose = tempFd;
    tempFd = undefined; // closeSync が失敗しても finally で同じ番号をもう一度閉じない
    closeSync(tempFdToClose);
    // rename は既存の .1 がシンボリックリンクでもリンク自体を置き換える（リンク先に触れない）。
    renameSync(tempPath, `${logPath}.1`);
    tempPath = null;
    ftruncateSync(fd, 0);
    return true;
  } catch {
    return false;
  } finally {
    closeQuietly(tempFd);
    closeQuietly(sourceFd);
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath);
      } catch {
        // 作れなかった・既に無いときは何もしない。
      }
    }
  }
}

/**
 * 回転の一時ファイルの名前。server.log と同じディレクトリに置き（rename を同じファイル
 * システム内で行うため）、ドットで始めて一覧で目立たせない。末尾は `.rotating` とし、
 * 他の一時ファイルの掃除（`.tmp` で終わる名前が対象）には当たらないようにする。
 */
function rotationTempPath(logPath) {
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}.rotating`;
  return join(dirname(logPath), `.${basename(logPath)}.${suffix}`);
}

/**
 * 一時ファイルを fchmod で 0600 にする（成功すれば umask と無関係に 0600 ちょうど）。
 * fchmod が失敗したときは fstat し、所有者以外の権限（0o077）が無ければ何もせず戻る
 * （mode は 0600 より狭いこともある。回転を止めて server.log を肥大させるより良い）。
 * 所有者以外の権限があるときは fchmod の例外を投げ直し、fstat が失敗したときはその例外が
 * 出て、どちらも回転をやめさせる。
 */
function restrictTempMode(fd) {
  try {
    fchmodSync(fd, LOG_FILE_MODE);
  } catch (error) {
    if ((fstatSync(fd).mode & 0o077) !== 0) throw error;
  }
}

const COPY_CHUNK_BYTES = 1024 * 1024;

/**
 * fromFd の先頭から length バイトを toFd へ写す。length に届く前に読み取りが 0 バイトを
 * 返したら（回転の途中で server.log が短くなった）例外を投げ、回転をやめさせる。最後の
 * 読み取りの後に短くなった場合は検出しない。
 */
function copyFdContents(fromFd, toFd, length) {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (position < length) {
    const bytesRead = readSync(fromFd, buffer, 0, Math.min(buffer.length, length - position), position);
    if (bytesRead === 0) throw new Error('log file shrank while it was being rotated');
    let written = 0;
    while (written < bytesRead) {
      written += writeSync(toFd, buffer, written, bytesRead - written);
    }
    position += bytesRead;
  }
}

function closeQuietly(fd) {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // 閉じられなくても server は続ける。
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
  // 作った server.log など）には効かない。新しく作ったか既存かを問わず、開いた先が
  // 通常ファイルなら fchmod で 0600 への補正を試みる（/dev/null へのシンボリックリンク
  // などの権限は変えない）。
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
    closeQuietly(fd);
  }
}
