import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertMacosServiceLockHeld,
  prepareMacosServiceLock,
  reconcileMacosMainService,
  startMacosWatchdogService,
  stopMacosWatchdogService,
} from '../src/macos-service.js';

const LOCKED_ENV = { CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1' };
const MAIN_JOB = 'gui/501/io.github.claude-rotator';
const WATCHDOG_JOB = 'gui/501/io.github.claude-rotator.watchdog';

describe('macOS service lock', () => {
  it('requires the hidden lock marker and prepares a private lock file', async () => {
    assert.throws(() => assertMacosServiceLockHeld({}), /shared lock/);
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-lock-'));
    const lockPath = join(dir, 'private', 'service.lock');
    try {
      await prepareMacosServiceLock({ lockPath });
      assert.equal(await readFile(lockPath, 'utf8'), '');
      assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(dir, 'private'))).mode & 0o777, 0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('macOS service reconciliation', () => {
  it('bootstraps a missing main job and verifies it', async () => {
    const fake = createLaunchctl();

    await reconcileMacosMainService({
      uid: 501,
      plistPath: '/tmp/main.plist',
      definitionChanged: true,
      env: LOCKED_ENV,
      execFileImpl: fake.exec,
    });

    assert.deepEqual(fake.calls, [
      ['print', MAIN_JOB],
      ['bootstrap', 'gui/501', '/tmp/main.plist'],
      ['print', MAIN_JOB],
    ]);
  });

  it('kickstarts an unchanged main and reloads a changed main', async t => {
    await t.test('unchanged', async () => {
      const fake = createLaunchctl([MAIN_JOB]);
      await reconcileMacosMainService({
        uid: 501,
        plistPath: '/tmp/main.plist',
        definitionChanged: false,
        env: LOCKED_ENV,
        execFileImpl: fake.exec,
      });
      assert.deepEqual(fake.calls, [
        ['print', MAIN_JOB],
        ['kickstart', '-k', MAIN_JOB],
        ['print', MAIN_JOB],
      ]);
    });

    await t.test('changed', async () => {
      const fake = createLaunchctl([MAIN_JOB]);
      await reconcileMacosMainService({
        uid: 501,
        plistPath: '/tmp/main.plist',
        definitionChanged: true,
        env: LOCKED_ENV,
        execFileImpl: fake.exec,
      });
      assert.deepEqual(fake.calls, [
        ['print', MAIN_JOB],
        ['bootout', MAIN_JOB],
        ['print', MAIN_JOB],
        ['bootstrap', 'gui/501', '/tmp/main.plist'],
        ['print', MAIN_JOB],
      ]);
    });
  });

  it('starts and stops the watchdog idempotently', async () => {
    const fake = createLaunchctl();

    await startMacosWatchdogService({
      uid: 501,
      plistPath: '/tmp/watchdog.plist',
      env: LOCKED_ENV,
      execFileImpl: fake.exec,
    });
    await stopMacosWatchdogService({
      uid: 501,
      env: LOCKED_ENV,
      execFileImpl: fake.exec,
    });

    assert.deepEqual(fake.calls, [
      ['print', WATCHDOG_JOB],
      ['bootstrap', 'gui/501', '/tmp/watchdog.plist'],
      ['print', WATCHDOG_JOB],
      ['print', WATCHDOG_JOB],
      ['bootout', WATCHDOG_JOB],
      ['print', WATCHDOG_JOB],
    ]);
  });
});

function createLaunchctl(initialJobs = []) {
  const jobs = new Set(initialJobs);
  const calls = [];
  return {
    calls,
    async exec(command, args) {
      assert.equal(command, '/bin/launchctl');
      calls.push(args);
      const [action, ...rest] = args;
      if (action === 'print') {
        if (jobs.has(rest[0])) return;
        throw Object.assign(new Error('not found'), { code: 113 });
      }
      if (action === 'bootstrap') {
        const label = rest[1].includes('watchdog')
          ? 'io.github.claude-rotator.watchdog'
          : 'io.github.claude-rotator';
        jobs.add(`${rest[0]}/${label}`);
        return;
      }
      if (action === 'bootout') {
        jobs.delete(rest[0]);
        return;
      }
      if (action === 'kickstart') return;
      assert.fail(`unexpected launchctl action: ${action}`);
    },
  };
}
