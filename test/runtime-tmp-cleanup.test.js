// 起動時の runtime-state 一時ファイル片付け（removeStaleTmpFiles / cleanupStaleRuntimeStateTmpFiles）。
//
// 一時ディレクトリだけで完結させる。実 HOME・実 ~/.config には触れない。プロセスの生存確認は
// `kill` を差し替えて行い、実プロセスへシグナルを送らない（signal 0 も送らない）。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lutimes, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeStaleTmpFiles } from '../src/json-file.js';
import { cleanupStaleRuntimeStateTmpFiles } from '../src/cli.js';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const OLD = new Date(NOW - 11 * 60_000);
const FRESH = new Date(NOW - 9 * 60_000);
const SELF_PID = 4242;

function killFor({ alive = [], eperm = [] } = {}) {
  const calls = [];
  const kill = (pid, signal) => {
    calls.push([pid, signal]);
    if (alive.includes(pid)) return true;
    const error = new Error(eperm.includes(pid) ? 'EPERM' : 'ESRCH');
    error.code = eperm.includes(pid) ? 'EPERM' : 'ESRCH';
    throw error;
  };
  return { kill, calls };
}

async function withSandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-tmp-cleanup-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(path, mtime = OLD) {
  await writeFile(path, '{}\n');
  await utimes(path, mtime, mtime);
}

describe('removeStaleTmpFiles', () => {
  it('removes only old temp files left by dead pids, keeping everything else', async () => {
    await withSandbox(async dir => {
      const statePath = join(dir, 'runtime-state.json');
      const stale = 'runtime-state.json.111.0123456789ab.tmp';
      const staleToo = 'runtime-state.json.222.abcdefabcdef.tmp';
      const keep = [
        'runtime-state.json',
        `runtime-state.json.${SELF_PID}.aaaaaaaaaaaa.tmp`, // 自分自身
        'runtime-state.json.333.bbbbbbbbbbbb.tmp', // 生存中
        'runtime-state.json.444.cccccccccccc.tmp', // EPERM（別ユーザーで生存）
        'runtime-state.json.555.dddddddddddd.tmp', // 新しい（10分以内）
        'runtime-state.json.0.eeeeeeeeeeee.tmp', // pid 0 は process group を指すので対象外
        'runtime-state.json.666.not-hex-name.tmp', // 名前の形が違う
        'runtime-state.json.666.0123456789ab.tmp.bak',
        'config.json.111.0123456789ab.tmp', // 別ファイルの一時ファイル
        'xruntime-state.json.111.0123456789ab.tmp',
      ];
      for (const name of [stale, staleToo, ...keep]) {
        await touch(join(dir, name), name.startsWith('runtime-state.json.555.') ? FRESH : OLD);
      }
      const { kill, calls } = killFor({ alive: [333], eperm: [444] });

      const result = await removeStaleTmpFiles(statePath, { now: () => NOW, pid: SELF_PID, kill });

      assert.deepEqual(result.removed.sort(), [stale, staleToo].sort());
      assert.deepEqual(result.failed, []);
      assert.deepEqual((await readdir(dir)).sort(), keep.sort());
      assert.ok(calls.every(([, signal]) => signal === 0), '生存確認は signal 0 だけ');
      assert.ok(!calls.some(([pid]) => pid === SELF_PID || pid === 0), '自分と pid 0 には問い合わせない');
      assert.ok(!calls.some(([pid]) => pid === 555), '新しいファイルは pid を確かめる前に除外する');
    });
  });

  it('never removes symlinks or directories, even with a matching stale name', async () => {
    await withSandbox(async dir => {
      const statePath = join(dir, 'runtime-state.json');
      const target = join(dir, 'precious.txt');
      await touch(target);
      const link = join(dir, 'runtime-state.json.111.0123456789ab.tmp');
      await symlink(target, link);
      // utimes はリンク先をたどるので、リンク自身の mtime は lutimes で古くする。そうしないと
      // 年齢の条件で先に除外され、通常ファイル判定（isFile）を検証できない。
      await lutimes(link, OLD, OLD);
      const subdir = join(dir, 'runtime-state.json.222.0123456789ab.tmp');
      await mkdir(subdir);
      await touch(join(subdir, 'inside'));
      await utimes(subdir, OLD, OLD);
      const { kill } = killFor();

      const result = await removeStaleTmpFiles(statePath, { now: () => NOW, pid: SELF_PID, kill });

      assert.deepEqual(result.removed, []);
      // ディレクトリへ unlink を試みると failed に入る。isFile で手前に除外していることを確かめる。
      assert.deepEqual(result.failed, []);
      assert.deepEqual(
        (await readdir(dir)).sort(),
        ['precious.txt', 'runtime-state.json.111.0123456789ab.tmp', 'runtime-state.json.222.0123456789ab.tmp'],
      );
      assert.deepEqual(await readdir(subdir), ['inside']);
    });
  });

  it('returns an empty result when the directory does not exist', async () => {
    await withSandbox(async dir => {
      const result = await removeStaleTmpFiles(join(dir, 'missing', 'runtime-state.json'), {
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
      });
      assert.deepEqual(result, { removed: [], failed: [] });
    });
  });

  it('keeps going when one file cannot be removed and reports it', async () => {
    await withSandbox(async dir => {
      const statePath = join(dir, 'runtime-state.json');
      const a = 'runtime-state.json.111.0123456789ab.tmp';
      const b = 'runtime-state.json.222.0123456789ab.tmp';
      await touch(join(dir, a));
      await touch(join(dir, b));
      const unlink = async path => {
        if (path.endsWith(a)) {
          const error = new Error('EACCES: permission denied');
          error.code = 'EACCES';
          throw error;
        }
        await rm(path);
      };

      const result = await removeStaleTmpFiles(statePath, {
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
        unlink,
      });

      assert.deepEqual(result.removed, [b]);
      assert.deepEqual(result.failed, [a]);
      assert.deepEqual(await readdir(dir), [a]);
    });
  });
});

describe('cleanupStaleRuntimeStateTmpFiles', () => {
  it('logs one line with the number of removed files', async () => {
    await withSandbox(async dir => {
      const statePath = join(dir, 'runtime-state.json');
      await touch(join(dir, 'runtime-state.json.111.0123456789ab.tmp'));
      await touch(join(dir, 'runtime-state.json.222.0123456789ab.tmp'));
      const lines = [];

      await cleanupStaleRuntimeStateTmpFiles(statePath, {
        logger: line => lines.push(line),
        env: {}, // 親プロセスの CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP を引き継がない
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
      });

      assert.deepEqual(lines, ['runtime state temp cleanup: removed 2 stale temp file(s)']);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  it('stays silent when there is nothing to remove', async () => {
    await withSandbox(async dir => {
      const lines = [];
      await cleanupStaleRuntimeStateTmpFiles(join(dir, 'runtime-state.json'), {
        logger: line => lines.push(line),
        env: {}, // 親プロセスの CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP を引き継がない
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
      });
      assert.deepEqual(lines, []);
    });
  });

  it('never throws and logs a single line when listing the directory fails', async () => {
    const lines = [];
    await cleanupStaleRuntimeStateTmpFiles('/nonexistent-for-test/runtime-state.json', {
      logger: line => lines.push(line),
      env: {}, // 親プロセスの CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP を引き継がない
      readdir: async () => {
        const error = new Error('EACCES: permission denied, scandir');
        error.code = 'EACCES';
        throw error;
      },
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^runtime state temp cleanup failed: EACCES/);
  });

  it('skips the cleanup entirely when disabled by CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP', async () => {
    for (const value of ['off', '0', 'false', ' OFF ']) {
      await withSandbox(async dir => {
        const name = 'runtime-state.json.111.0123456789ab.tmp';
        await touch(join(dir, name));
        const lines = [];
        const { kill, calls } = killFor();
        await cleanupStaleRuntimeStateTmpFiles(join(dir, 'runtime-state.json'), {
          logger: line => lines.push(line),
          env: { CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP: value },
          now: () => NOW,
          pid: SELF_PID,
          kill,
        });
        assert.deepEqual(lines, ['runtime state temp cleanup skipped: disabled by CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP']);
        assert.deepEqual(await readdir(dir), [name], value);
        assert.deepEqual(calls, [], '無効時は生存確認もしない');
      });
    }
  });

  it('runs the cleanup when the switch holds any other value', async () => {
    await withSandbox(async dir => {
      await touch(join(dir, 'runtime-state.json.111.0123456789ab.tmp'));
      const lines = [];
      await cleanupStaleRuntimeStateTmpFiles(join(dir, 'runtime-state.json'), {
        logger: line => lines.push(line),
        env: { CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP: 'on' },
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
      });
      assert.deepEqual(lines, ['runtime state temp cleanup: removed 1 stale temp file(s)']);
      assert.deepEqual(await readdir(dir), []);
    });
  });

  it('logs the failed count in one line when some files could not be removed', async () => {
    await withSandbox(async dir => {
      const statePath = join(dir, 'runtime-state.json');
      await touch(join(dir, 'runtime-state.json.111.0123456789ab.tmp'));
      const lines = [];
      await cleanupStaleRuntimeStateTmpFiles(statePath, {
        logger: line => lines.push(line),
        env: {}, // 親プロセスの CLAUDE_ROTATOR_RUNTIME_TMP_CLEANUP を引き継がない
        now: () => NOW,
        pid: SELF_PID,
        kill: killFor().kill,
        unlink: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
      });
      assert.deepEqual(lines, ['runtime state temp cleanup: removed 0 stale temp file(s), 1 could not be removed']);
    });
  });
});
