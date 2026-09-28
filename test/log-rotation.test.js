import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServerLogWriter, maybeRotateLog, LOG_FILE_MODE, LOG_MAX_BYTES } from '../src/log-rotation.js';
import { DEFAULT_OBSERVABILITY } from '../src/usage-observation.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'claude-rotator-log-rotation-'));
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

describe('LOG_MAX_BYTES', () => {
  it('is 32 MiB, the production effective default', () => {
    assert.equal(LOG_MAX_BYTES, 32 * 1024 * 1024);
  });

  it('is the single definition behind config.observability.logMaxBytes', () => {
    assert.equal(DEFAULT_OBSERVABILITY.logMaxBytes, LOG_MAX_BYTES);
  });
});

describe('maybeRotateLog', () => {
  it('does nothing exactly at the size limit, and rotates one byte past it', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const maxBytes = 16;

    writeFileSync(logPath, 'x'.repeat(maxBytes));
    let fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes }), false);
      assert.equal(existsSync(`${logPath}.1`), false);
      assert.equal(readFileSync(logPath, 'utf8'), 'x'.repeat(maxBytes));
    } finally {
      closeSync(fd);
    }

    writeFileSync(logPath, 'x'.repeat(maxBytes + 1));
    fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes }), true);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(maxBytes + 1));
      assert.equal(readFileSync(logPath, 'utf8'), '');
    } finally {
      closeSync(fd);
    }
  });

  it('rotates when the log exceeds the size limit and resumes writes at offset 0 (O_APPEND)', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const oldContent = 'x'.repeat(2048);
    writeFileSync(logPath, oldContent);
    const fd = openSync(logPath, 'a');

    try {
      const rotated = maybeRotateLog({ fd, logPath, maxBytes: 1024 });

      assert.equal(rotated, true);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), oldContent);
      assert.equal(readFileSync(logPath, 'utf8'), '');

      writeSync(fd, Buffer.from('next line\n'));
      assert.equal(readFileSync(logPath, 'utf8'), 'next line\n');
    } finally {
      closeSync(fd);
    }
  });

  it('does nothing when fd points at a different file than logPath (identity check)', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const otherPath = join(dir, 'other.log');
    const logContent = 'y'.repeat(2048);
    const otherContent = 'z'.repeat(2048);
    writeFileSync(logPath, logContent);
    writeFileSync(otherPath, otherContent);
    const fd = openSync(otherPath, 'a');

    try {
      const rotated = maybeRotateLog({ fd, logPath, maxBytes: 1024 });

      assert.equal(rotated, false);
      assert.equal(existsSync(`${logPath}.1`), false);
      assert.equal(readFileSync(logPath, 'utf8'), logContent);
      assert.equal(readFileSync(otherPath, 'utf8'), otherContent);
    } finally {
      closeSync(fd);
    }
  });

  it('overwrites an existing .1 backup', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const newContent = 'n'.repeat(2048);
    writeFileSync(logPath, newContent);
    writeFileSync(`${logPath}.1`, 'stale-previous-backup');
    const fd = openSync(logPath, 'a');

    try {
      const rotated = maybeRotateLog({ fd, logPath, maxBytes: 1024 });

      assert.equal(rotated, true);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), newContent);
    } finally {
      closeSync(fd);
    }
  });

  it('returns false without throwing when logPath no longer exists', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const missingPath = join(dir, 'gone.log');
    writeFileSync(logPath, 'w'.repeat(2048));
    const fd = openSync(logPath, 'a');

    try {
      assert.doesNotThrow(() => {
        const rotated = maybeRotateLog({ fd, logPath: missingPath, maxBytes: 1024 });
        assert.equal(rotated, false);
      });
    } finally {
      closeSync(fd);
    }
  });

  it('returns false without throwing when the fd is invalid', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'w'.repeat(2048));

    assert.doesNotThrow(() => {
      const rotated = maybeRotateLog({ fd: 999999, logPath, maxBytes: 1024 });
      assert.equal(rotated, false);
    });
  });
});

describe('createServerLogWriter', () => {
  it('appends lines to logPath', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const writer = createServerLogWriter({ logPath, maxBytes: LOG_MAX_BYTES });

    try {
      writer.write('first');
      writer.write('second');

      assert.equal(readFileSync(logPath, 'utf8'), 'first\nsecond\n');
    } finally {
      writer.close();
    }
  });

  it('rotates once its own fd crosses maxBytes, resuming subsequent writes at offset 0', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const maxBytes = 10;
    const writer = createServerLogWriter({ logPath, maxBytes });

    try {
      writer.write('x'.repeat(20)); // 21 bytes written, size 0 <= 10 before this write: no rotation yet
      writer.write('next'); // size 21 > 10 before this write: rotates, then writes "next\n"

      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), `${'x'.repeat(20)}\n`);
      assert.equal(readFileSync(logPath, 'utf8'), 'next\n');
    } finally {
      writer.close();
    }
  });

  it('returns null without throwing when logPath cannot be opened', () => {
    const dir = tempDir();
    const logPath = join(dir, 'no-such-subdir', 'server.log');

    let writer;
    assert.doesNotThrow(() => {
      writer = createServerLogWriter({ logPath, maxBytes: LOG_MAX_BYTES });
    });
    assert.equal(writer, null);
  });

  it(
    'regression: rotating through its own O_APPEND fd never truncates/sparse-fies a ' +
      'coexisting non-append fd on the same server.log (simulates `claude-rotator server > server.log`, ' +
      'where the shell-owned fd 1 is opened O_TRUNC/non-append while this writer holds its own O_APPEND fd)',
    () => {
      const dir = tempDir();
      const logPath = join(dir, 'server.log');
      const maxBytes = 40;

      // Simulate the shell's `>` redirect: opens fd 1 with O_TRUNC, non-append,
      // and (per the real runServer() code) writes exactly one startup line
      // through it before the dedicated log writer is ever created.
      const redirectFd = openSync(logPath, 'w');
      writeSync(redirectFd, 'start\n');

      const writer = createServerLogWriter({ logPath, maxBytes });
      assert.notEqual(writer, null);

      try {
        writer.write('A'.repeat(30)); // size 6 <= 40 before write: no rotation. total becomes 37.
        writer.write('B'.repeat(10)); // size 37 <= 40 before write: no rotation. total becomes 48.
        writer.write('C'.repeat(5)); // size 48 > 40 before write: rotates, then writes "CCCCC\n"

        const expectedBackup = `start\n${'A'.repeat(30)}\n${'B'.repeat(10)}\n`;
        const backupContent = readFileSync(`${logPath}.1`, 'utf8');
        assert.equal(backupContent, expectedBackup);
        assert.equal(backupContent.includes('\0'), false, 'backup must hold real bytes only, never a sparse hole');

        const currentContent = readFileSync(logPath, 'utf8');
        assert.equal(currentContent, 'CCCCC\n');
        assert.equal(currentContent.includes('\0'), false, 'server.log must resume at offset 0, never a sparse hole');

        // The redirect fd shares the same inode: fstat through it reports the
        // real (post-rotation) file size, proving the file itself was cleanly
        // rotated rather than left as a huge sparse file that a stray write
        // through fd 1 would otherwise inflate further.
        assert.equal(fstatSync(redirectFd).size, Buffer.byteLength('CCCCC\n'));

        // A late write through the redirect fd itself (its own stale,
        // non-append cursor) must not blow the file up or leave a hole:
        // it can only ever land once, at its own fixed offset -- never
        // repeatedly, since this code path no longer routes any per-request
        // logging through fd 1.
        const sizeBeforeStrayWrite = fstatSync(redirectFd).size;
        writeSync(redirectFd, 'stray-redirect-write\n');
        const contentAfterStrayWrite = readFileSync(logPath, 'utf8');
        assert.equal(
          contentAfterStrayWrite.includes('\0'),
          false,
          'a single stray write through the redirect fd must never create a sparse hole',
        );
        assert.equal(
          Buffer.byteLength(contentAfterStrayWrite, 'utf8'),
          sizeBeforeStrayWrite + Buffer.byteLength('stray-redirect-write\n'),
          'a single stray write through the redirect fd must grow the file by exactly its own byte length, not balloon',
        );

        assert.doesNotThrow(() => closeSync(redirectFd));
      } finally {
        writer.close();
      }
    },
  );

  it(
    'dual O_APPEND coexistence (launchd/systemd path): after one O_APPEND fd rotates the log, ' +
      'a write through a second, independently-held O_APPEND fd on the same path lands at the ' +
      'new end-of-file (offset 0) with no sparse hole',
    () => {
      const dir = tempDir();
      const logPath = join(dir, 'server.log');
      writeFileSync(logPath, '');
      const maxBytes = 20;

      // fdA plays the role of this app's own log writer; fdB plays the role of
      // the launchd StandardOutPath / systemd `append:` redirect -- both are
      // genuinely O_APPEND, as confirmed on real running services.
      const fdA = openSync(logPath, 'a');
      const fdB = openSync(logPath, 'a');

      try {
        writeSync(fdA, 'aaaa\n'); // total 5
        writeSync(fdB, 'bbbb\n'); // O_APPEND seeks to real EOF (5) -> total 10
        writeSync(fdA, 'cccc\n'); // seeks to real EOF (10) -> total 15
        writeSync(fdB, 'dddd\n'); // seeks to real EOF (15) -> total 20
        writeSync(fdA, 'e\n'); // seeks to real EOF (20) -> total 22, now over maxBytes

        const rotated = maybeRotateLog({ fd: fdA, logPath, maxBytes });
        assert.equal(rotated, true);
        assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'aaaa\nbbbb\ncccc\ndddd\ne\n');
        assert.equal(readFileSync(logPath, 'utf8'), '');

        // fdB never triggered the rotation and was not truncated directly --
        // this proves O_APPEND recomputes the true EOF on every write, so the
        // next write through fdB still lands at offset 0, not at its old
        // (now stale) 20-byte position.
        writeSync(fdB, 'FFFF\n');
        const finalContent = readFileSync(logPath, 'utf8');
        assert.equal(finalContent, 'FFFF\n');
        assert.equal(finalContent.includes('\0'), false, 'no sparse hole should appear before the fdB write');
      } finally {
        closeSync(fdA);
        closeSync(fdB);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// createServerLogWriter の maxBytes（計画書 Task 4）
// ---------------------------------------------------------------------------

describe('createServerLogWriter の maxBytes', () => {
  it('渡した閾値でローテーションする（既定の 32 MiB を待たない）', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const writer = createServerLogWriter({ logPath, maxBytes: 64 });
    try {
      writer.write('x'.repeat(40));
      assert.equal(existsSync(`${logPath}.1`), false, '閾値以下では回さない');
      writer.write('y'.repeat(40));
      writer.write('z');
      assert.equal(existsSync(`${logPath}.1`), true, '閾値超で .1 ができる');
      assert.ok(readFileSync(`${logPath}.1`, 'utf8').includes('x'.repeat(40)));
    } finally {
      writer.close();
    }
  });

  it('maxBytes を渡さなければ既定の LOG_MAX_BYTES を使う', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const writer = createServerLogWriter({ logPath });
    try {
      writer.write('x'.repeat(1024));
      assert.equal(existsSync(`${logPath}.1`), false);
    } finally {
      writer.close();
    }
  });
});

// ---------------------------------------------------------------------------
// server.log / server.log.1 の権限（0600）
//
// 既存ファイルは chmodSync で明示的に 0644 にしてから始めるので、実行環境の
// umask に結果が左右されない。新規作成の検査は umask を 0 にして行い、
// umask 任せでは 0600 にならない条件でも 0600 になることを確かめる。
// ---------------------------------------------------------------------------

describe('server.log の権限', () => {
  it('LOG_FILE_MODE は 0600', () => {
    assert.equal(LOG_FILE_MODE, 0o600);
  });

  it('新規作成した server.log は umask が 0 でも 0600', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const previous = process.umask(0);
    let writer;
    try {
      writer = createServerLogWriter({ logPath, maxBytes: 1024 });
    } finally {
      process.umask(previous);
    }
    try {
      assert.notEqual(writer, null);
      writer.write('line');
      assert.equal(modeOf(logPath), 0o600);
    } finally {
      writer.close();
    }
  });

  it('起動時に既存の server.log と server.log.1 を 0644 から 0600 へ補正する', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'old\n');
    writeFileSync(`${logPath}.1`, 'older\n');
    chmodSync(logPath, 0o644);
    chmodSync(`${logPath}.1`, 0o644);

    const writer = createServerLogWriter({ logPath, maxBytes: 1024 });
    try {
      assert.equal(modeOf(logPath), 0o600);
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      assert.equal(readFileSync(logPath, 'utf8'), 'old\n', '補正は中身を変えない');
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'older\n');
    } finally {
      writer.close();
    }
  });

  it('server.log.1 が無くても起動できる（.1 はまだ作らない）', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const writer = createServerLogWriter({ logPath, maxBytes: 1024 });
    try {
      assert.notEqual(writer, null);
      assert.equal(existsSync(`${logPath}.1`), false);
    } finally {
      writer.close();
    }
  });

  it('回転で新規に作る server.log.1 は、複製元が 0644 でも 0600', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    chmodSync(logPath, 0o644);
    const fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), true);
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      // .1 の 0600 は複製元を先に 0600 にしたことで得ている（コピー後の chmod ではない）。
      assert.equal(modeOf(logPath), 0o600, '複製元はコピーの前に 0600 へ補正される');
    } finally {
      closeSync(fd);
    }
  });

  it(
    '複製元を 0600 にできないときは回転しない（.1 を作らず、切り詰めもしない）',
    { skip: process.platform !== 'darwin' && 'chflags uchg で fchmod を失敗させるのは macOS だけ' },
    () => {
      const dir = tempDir();
      const logPath = join(dir, 'server.log');
      writeFileSync(logPath, 'x'.repeat(2048));
      chmodSync(logPath, 0o644);
      const fd = openSync(logPath, 'a');
      // 変更不可フラグを立てると、所有者でも fchmod が EPERM で失敗する。
      execFileSync('/usr/bin/chflags', ['uchg', logPath]);
      try {
        assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), false);
        assert.equal(existsSync(`${logPath}.1`), false, '0644 の .1 を作らない');
      } finally {
        execFileSync('/usr/bin/chflags', ['nouchg', logPath]);
        closeSync(fd);
      }
      assert.equal(readFileSync(logPath, 'utf8'), 'x'.repeat(2048));
    },
  );

  it('起動時の補正は server.log.1 のシンボリックリンクをたどらない（リンク先がディレクトリ）', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const target = join(dir, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep\n');
    chmodSync(target, 0o755);
    symlinkSync(target, `${logPath}.1`);

    const writer = createServerLogWriter({ logPath, maxBytes: 1024 });
    try {
      assert.notEqual(writer, null, 'server は動き続ける');
      writer.write('line');
      assert.equal(modeOf(target), 0o755, 'リンク先ディレクトリの権限は変えない');
      assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'keep\n');
    } finally {
      writer.close();
    }
  });

  it('起動時の補正は server.log.1 のシンボリックリンクをたどらない（リンク先が通常ファイル）', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const target = join(dir, 'other-file');
    writeFileSync(target, 'other\n');
    chmodSync(target, 0o644);
    symlinkSync(target, `${logPath}.1`);

    const writer = createServerLogWriter({ logPath, maxBytes: 1024 });
    try {
      assert.notEqual(writer, null);
      writer.write('line');
      assert.equal(modeOf(target), 0o644, 'リンク先ファイルの権限は変えない');
      assert.equal(readFileSync(target, 'utf8'), 'other\n', 'リンク先ファイルの中身は変えない');
    } finally {
      writer.close();
    }
  });

  it('回転で上書きする既存の server.log.1 が 0644 でも 0600 になる', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    writeFileSync(`${logPath}.1`, 'stale');
    chmodSync(logPath, 0o644);
    chmodSync(`${logPath}.1`, 0o644);
    const fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), true);
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
    } finally {
      closeSync(fd);
    }
  });

  it('writer 経由の回転後も server.log と server.log.1 は 0600', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const writer = createServerLogWriter({ logPath, maxBytes: 10 });
    try {
      writer.write('x'.repeat(20));
      writer.write('next');
      assert.equal(existsSync(`${logPath}.1`), true);
      assert.equal(modeOf(logPath), 0o600);
      assert.equal(modeOf(`${logPath}.1`), 0o600);
    } finally {
      writer.close();
    }
  });
});
