import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { maybeRotateLog, LOG_MAX_BYTES } from '../src/log-rotation.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'claude-rotator-log-rotation-'));
}

describe('LOG_MAX_BYTES', () => {
  it('is fixed at 10MB', () => {
    assert.equal(LOG_MAX_BYTES, 10 * 1024 * 1024);
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
