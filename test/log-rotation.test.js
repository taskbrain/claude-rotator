import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

// 回転の一時ファイルが残っていないことを確かめるため、想定したもの以外の名前を返す。
function unexpectedEntries(dir, expected) {
  return readdirSync(dir).filter(name => !expected.includes(name)).sort();
}

// src/log-rotation.js が名前で取り込んだ node:fs の関数を、fn の間だけ差し替える
// （syncBuiltinESMExports で、名前で取り込んだ側にも差し替えが届く）。
// 差し替えの中では readFileSync など他の fs の関数を使わず、確認は戻した後で行う。
function withPatchedFs(name, makeReplacement, fn) {
  const original = fs[name];
  fs[name] = makeReplacement(original);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    fs[name] = original;
    syncBuiltinESMExports();
  }
}

function errorWithCode(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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

  it('回転で新規に作る server.log.1 は、複製元が 0644 のままでも（umask 022）0600 で、server.log は切り詰められる', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    chmodSync(logPath, 0o644);
    const fd = openSync(logPath, 'a');
    const previous = process.umask(0o022);
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), true);
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
      assert.equal(readFileSync(logPath, 'utf8'), '');
      // .1 の 0600 は複製元の権限に頼らない（回転の経路では複製元を fchmod しない）。
      assert.equal(modeOf(logPath), 0o644, '回転は複製元の権限を変えない');
      assert.deepEqual(unexpectedEntries(dir, ['server.log', 'server.log.1']), [], '一時ファイルを残さない');
    } finally {
      process.umask(previous);
      closeSync(fd);
    }
  });

  it(
    '複製元を chmod できない（所有者が別で書込権だけある）ときも回転する',
    {
      skip: typeof process.getuid !== 'function' || process.getuid() !== 0
        ? '別ユーザーとして子プロセスを動かすため root が要る（root の環境、例えば手元の docker でだけ実行する）'
        : false,
    },
    () => {
      const unprivileged = 65534;
      const dir = tempDir();
      chmodSync(dir, 0o777); // 子プロセス（別ユーザー）が一時ファイルと .1 を作れるようにする
      const logPath = join(dir, 'server.log');
      writeFileSync(logPath, 'x'.repeat(2048));
      chmodSync(logPath, 0o666); // 所有者は root。別ユーザーは読み書きできるが chmod はできない
      const script = join(dir, 'rotate-as-other-user.mjs');
      const moduleUrl = new URL('../src/log-rotation.js', import.meta.url).href;
      writeFileSync(script, [
        "import { fchmodSync, openSync } from 'node:fs';",
        `import { maybeRotateLog } from ${JSON.stringify(moduleUrl)};`,
        `const logPath = ${JSON.stringify(logPath)};`,
        "const fd = openSync(logPath, 'a');",
        'let fchmodCode = null;',
        'try { fchmodSync(fd, 0o600); } catch (error) { fchmodCode = error.code; }',
        'const rotated = maybeRotateLog({ fd, logPath, maxBytes: 1024 });',
        'process.stdout.write(JSON.stringify({ fchmodCode, rotated }));',
        '',
      ].join('\n'));
      chmodSync(script, 0o644);

      const child = spawnSync(process.execPath, [script], {
        uid: unprivileged,
        gid: unprivileged,
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.equal(result.fchmodCode, 'EPERM', '前提: この server.log は chmod できない');
      assert.equal(result.rotated, true);
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      assert.equal(statSync(`${logPath}.1`).uid, unprivileged);
      assert.equal(readFileSync(logPath, 'utf8'), '', 'server.log は切り詰められる');
      assert.equal(modeOf(logPath), 0o666);
      assert.deepEqual(
        unexpectedEntries(dir, ['server.log', 'server.log.1', 'rotate-as-other-user.mjs']),
        [],
        '一時ファイルを残さない',
      );
    },
  );

  it(
    '変更不可フラグで chmod できない server.log でも、開いている fd から回転する',
    { skip: process.platform !== 'darwin' && 'chflags uchg を使うのは macOS だけ' },
    () => {
      const dir = tempDir();
      const logPath = join(dir, 'server.log');
      writeFileSync(logPath, 'x'.repeat(2048));
      chmodSync(logPath, 0o644);
      const fd = openSync(logPath, 'a');
      // 変更不可フラグを開いた後に立てると、所有者でも fchmod は EPERM になるが、
      // 開いている fd からの追記は通る（回転しなければ server.log は大きくなり続ける）。
      execFileSync('/usr/bin/chflags', ['uchg', logPath]);
      try {
        assert.throws(() => fchmodSync(fd, 0o600), { code: 'EPERM' }, '前提: この server.log は chmod できない');
        writeSync(fd, 'y'); // 前提: 追記はできる
        assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), true);
        assert.equal(readFileSync(`${logPath}.1`, 'utf8'), `${'x'.repeat(2048)}y`);
        assert.equal(modeOf(`${logPath}.1`), 0o600);
        assert.equal(readFileSync(logPath, 'utf8'), '', 'server.log は切り詰められる');
        assert.deepEqual(unexpectedEntries(dir, ['server.log', 'server.log.1']), [], '一時ファイルを残さない');
      } finally {
        execFileSync('/usr/bin/chflags', ['nouchg', logPath]);
        closeSync(fd);
      }
      assert.equal(modeOf(logPath), 0o644, '回転は複製元の権限を変えない');
    },
  );

  it('回転は既存の server.log.1 のシンボリックリンクをたどらず、リンク自体を置き換える', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const target = join(dir, 'other-file');
    writeFileSync(target, 'other\n');
    chmodSync(target, 0o644);
    symlinkSync(target, `${logPath}.1`);
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), true);
      assert.equal(lstatSync(`${logPath}.1`).isFile(), true, '.1 は通常ファイルになる');
      assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
      assert.equal(modeOf(`${logPath}.1`), 0o600);
      assert.equal(readFileSync(target, 'utf8'), 'other\n', 'リンク先ファイルの中身は変えない');
      assert.equal(modeOf(target), 0o644, 'リンク先ファイルの権限は変えない');
    } finally {
      closeSync(fd);
    }
  });

  it('server.log.1 の場所に置き換えられないもの（ディレクトリ）があれば回転せず、一時ファイルを残さない', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    mkdirSync(`${logPath}.1`);
    writeFileSync(join(`${logPath}.1`, 'keep.txt'), 'keep\n');
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    try {
      assert.equal(maybeRotateLog({ fd, logPath, maxBytes: 1024 }), false);
      assert.equal(readFileSync(logPath, 'utf8'), 'x'.repeat(2048), '切り詰めない');
      assert.equal(readFileSync(join(`${logPath}.1`, 'keep.txt'), 'utf8'), 'keep\n');
      assert.deepEqual(unexpectedEntries(dir, ['server.log', 'server.log.1']), [], '一時ファイルを残さない');
    } finally {
      closeSync(fd);
    }
  });

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

  it('回転で作る server.log.1 は umask が 0o277 でも 0600 ちょうど', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    const previous = process.umask(0o277);
    let rotated;
    try {
      rotated = maybeRotateLog({ fd, logPath, maxBytes: 1024 });
    } finally {
      process.umask(previous);
      closeSync(fd);
    }
    assert.equal(rotated, true);
    assert.equal(modeOf(`${logPath}.1`), 0o600);
    assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
    assert.equal(readFileSync(logPath, 'utf8'), '');
  });

  it('一時ファイルを fchmod できなくても、所有者以外の権限が無ければ（0600 より狭いだけなら）回転する', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    const previous = process.umask(0o277);
    let rotated;
    try {
      rotated = withPatchedFs(
        'fchmodSync',
        () => () => {
          throw errorWithCode('EPERM');
        },
        () => maybeRotateLog({ fd, logPath, maxBytes: 1024 }),
      );
    } finally {
      process.umask(previous);
      closeSync(fd);
    }
    assert.equal(rotated, true);
    assert.equal(modeOf(`${logPath}.1`), 0o400, '作成時の mode（0600 から umask で削ったもの）のまま');
    assert.equal(readFileSync(`${logPath}.1`, 'utf8'), 'x'.repeat(2048));
    assert.equal(readFileSync(logPath, 'utf8'), '');
    assert.deepEqual(unexpectedEntries(dir, ['server.log', 'server.log.1']), [], '一時ファイルを残さない');
  });

  it('一時ファイルを fchmod できず所有者以外の権限が残るときは回転せず、切り詰めず、一時ファイルを残さない', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    let rotated;
    try {
      // 所有者以外の権限を付けたうえで失敗を返す、振る舞いのおかしいファイルシステムを再現する。
      rotated = withPatchedFs(
        'fchmodSync',
        original => target => {
          original(target, 0o644);
          throw errorWithCode('EPERM');
        },
        () => maybeRotateLog({ fd, logPath, maxBytes: 1024 }),
      );
    } finally {
      closeSync(fd);
    }
    assert.equal(rotated, false);
    assert.equal(existsSync(`${logPath}.1`), false);
    assert.equal(readFileSync(logPath, 'utf8'), 'x'.repeat(2048), '切り詰めない');
    assert.deepEqual(unexpectedEntries(dir, ['server.log']), [], '一時ファイルを残さない');
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

// ---------------------------------------------------------------------------
// 回転の複製は、開始時の server.log の大きさまで
// ---------------------------------------------------------------------------

describe('回転の複製の大きさ', () => {
  it('複製の間も server.log へ追記が続いても、開始時の大きさで複製を止める', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    const initial = 'x'.repeat(3 * 1024 * 1024 + 5); // 複製の区切り（1 MiB）を何度かまたぐ
    writeFileSync(logPath, initial);
    const fd = openSync(logPath, 'a');
    const appender = openSync(logPath, 'a');
    const appendedChunk = Buffer.alloc(1024 * 1024, 'y');
    let reads = 0;
    let rotated;
    try {
      // 別のプロセスが追記し続けている状態を、読むたびに同じ量を追記して再現する。
      // 開始時の大きさで止めないと複製が終わらないので、テストが止まらないよう回数に上限を置く。
      rotated = withPatchedFs(
        'readSync',
        original => (...args) => {
          reads += 1;
          if (reads <= 16) writeSync(appender, appendedChunk);
          return original(...args);
        },
        () => maybeRotateLog({ fd, logPath, maxBytes: 1024 }),
      );
    } finally {
      closeSync(appender);
      closeSync(fd);
    }
    assert.equal(rotated, true);
    assert.equal(statSync(`${logPath}.1`).size, initial.length, '.1 は開始時の大きさちょうど');
    assert.equal(readFileSync(`${logPath}.1`, 'utf8'), initial);
    assert.equal(statSync(logPath).size, 0, 'server.log は切り詰められる');
    assert.deepEqual(unexpectedEntries(dir, ['server.log', 'server.log.1']), [], '一時ファイルを残さない');
  });

  it('複製の途中で開始時の大きさより手前で終わったら回転せず、切り詰めず、一時ファイルを残さない', () => {
    const dir = tempDir();
    const logPath = join(dir, 'server.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    const fd = openSync(logPath, 'a');
    const shrinker = openSync(logPath, 'r+');
    let shrunk = false;
    let rotated;
    try {
      // 開始時の大きさを取った後で、別のプロセスが server.log を短くした状態を再現する。
      rotated = withPatchedFs(
        'readSync',
        original => (...args) => {
          if (!shrunk) {
            ftruncateSync(shrinker, 1000);
            shrunk = true;
          }
          return original(...args);
        },
        () => maybeRotateLog({ fd, logPath, maxBytes: 1024 }),
      );
    } finally {
      closeSync(shrinker);
      closeSync(fd);
    }
    assert.equal(shrunk, true, '前提: 複製の途中で短くした');
    assert.equal(rotated, false);
    assert.equal(existsSync(`${logPath}.1`), false);
    assert.equal(readFileSync(logPath, 'utf8'), 'x'.repeat(1000), '回転の側では切り詰めない');
    assert.deepEqual(unexpectedEntries(dir, ['server.log']), [], '一時ファイルを残さない');
  });
});
