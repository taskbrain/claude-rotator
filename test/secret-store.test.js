import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemorySecretStore,
  LinuxFileSecretStore,
  MacOSKeychainSecretStore,
  createSecretStore,
  secretStoreProcessIdentity,
} from '../src/secret-store.js';

describe('MemorySecretStore', () => {
  it('stores, lists, and removes secrets without exposing internals', async () => {
    const store = new MemorySecretStore();

    await store.set('acct_1', { accessToken: 'access', refreshToken: 'refresh' });

    assert.deepEqual(await store.get('acct_1'), { accessToken: 'access', refreshToken: 'refresh' });
    assert.deepEqual(await store.list(), ['acct_1']);
    await store.delete('acct_1');
    assert.equal(await store.get('acct_1'), null);
  });

  it('compares the complete secret atomically, including metadata', async () => {
    const store = new MemorySecretStore();
    const original = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scopes: ['user:inference'],
      subscriptionType: 'pro',
    };
    await store.set('acct_1', original);

    assert.equal(await store.compareAndSet('acct_1', {
      ...original,
      subscriptionType: 'max',
    }, { accessToken: 'must-not-be-stored' }), false);
    assert.deepEqual(await store.get('acct_1'), original);
    assert.equal(await store.compareAndSet('acct_1', original, {
      ...original,
      accessToken: 'access-2',
    }), true);
    assert.equal((await store.get('acct_1')).accessToken, 'access-2');
  });
});

describe('LinuxFileSecretStore', () => {
  it('stores account secret files with private permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const store = new LinuxFileSecretStore({ accountsDir: join(dir, 'accounts') });

    await store.set('acct_1', { accessToken: 'access', refreshToken: 'refresh' });

    assert.deepEqual(await store.get('acct_1'), { accessToken: 'access', refreshToken: 'refresh' });
    assert.deepEqual(await store.list(), ['acct_1']);
    assert.equal((await stat(join(dir, 'accounts'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'accounts', 'acct_1.json'))).mode & 0o777, 0o600);
  });

  it('rejects unsafe account ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const store = new LinuxFileSecretStore({ accountsDir: join(dir, 'accounts') });

    await assert.rejects(
      () => store.set('../escape', { accessToken: 'access' }),
      /Invalid account id/,
    );
  });

  it('allows only one compare-and-set winner across store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const first = new LinuxFileSecretStore({ accountsDir });
    const second = new LinuxFileSecretStore({ accountsDir });
    const original = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      scopes: ['user:inference'],
    };
    const nextA = { ...original, accessToken: 'access-a' };
    const nextB = { ...original, accessToken: 'access-b' };
    await first.set('acct_1', original);

    const results = await Promise.all([
      first.compareAndSet('acct_1', original, nextA),
      second.compareAndSet('acct_1', original, nextB),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
    assert.ok([
      JSON.stringify(nextA),
      JSON.stringify(nextB),
    ].includes(JSON.stringify(await first.get('acct_1'))));
  });

  it('does not preempt a paused live CAS writer when another clock is far ahead', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const first = new LinuxFileSecretStore({ accountsDir });
    const second = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 0,
      now: () => Date.now() + 2 * 60_000,
    });
    const original = { accessToken: 'original' };
    const nextA = { accessToken: 'writer-a' };
    const nextB = { accessToken: 'writer-b' };
    await first.set('acct_1', original);
    const originalSetUnlocked = first.setUnlocked.bind(first);
    let releaseWriter;
    let writerEntered;
    const writerGate = new Promise(resolve => { releaseWriter = resolve; });
    const writerStarted = new Promise(resolve => { writerEntered = resolve; });
    first.setUnlocked = async (accountId, secret) => {
      if (secret.accessToken === 'writer-a') {
        writerEntered();
        await writerGate;
      }
      return originalSetUnlocked(accountId, secret);
    };

    const firstResult = first.compareAndSet('acct_1', original, nextA);
    await writerStarted;
    await assert.rejects(
      () => second.compareAndSet('acct_1', original, nextB),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
    releaseWriter();

    assert.equal(await firstResult, true);
    assert.deepEqual(await first.get('acct_1'), nextA);
  });

  it('recovers a lock left by a dead local process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'abandoned-lock',
      pid: 2_147_483_647,
      hostname: hostname(),
      acquiredAt: 0,
    }), { mode: 0o600 });
    const store = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 100,
      lockRetryMs: 1,
    });

    await store.set('acct_1', { accessToken: 'access-after-recovery' });

    assert.equal((await store.get('acct_1')).accessToken, 'access-after-recovery');
  });

  it('allows one CAS winner when store instances concurrently recover the same dead lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'abandoned-lock',
      pid: 2_147_483_647,
      hostname: hostname(),
      acquiredAt: 0,
    }), { mode: 0o600 });
    const options = {
      accountsDir,
      lockAcquireTimeoutMs: 1_000,
      lockRetryMs: 1,
    };
    const first = new LinuxFileSecretStore(options);
    const second = new LinuxFileSecretStore(options);
    const nextA = { accessToken: 'access-a' };
    const nextB = { accessToken: 'access-b' };

    const results = await Promise.all([
      first.compareAndSet('acct_1', null, nextA),
      second.compareAndSet('acct_1', null, nextB),
    ]);

    assert.deepEqual([...results].sort(), [false, true]);
    assert.ok([
      JSON.stringify(nextA),
      JSON.stringify(nextB),
    ].includes(JSON.stringify(await first.get('acct_1'))));
  });

  it('bounds lock acquisition while a live process owns the account lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-lock',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
    }), { mode: 0o600 });
    const store = new LinuxFileSecretStore({ accountsDir, lockAcquireTimeoutMs: 0 });

    await assert.rejects(
      () => store.delete('acct_1'),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
  });

  it('does not destroy a live account lock while purging secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const secretPath = join(accountsDir, 'acct_1.json');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(secretPath, JSON.stringify({ accessToken: 'must-remain' }), { mode: 0o600 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-lock',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
    }), { mode: 0o600 });
    const store = new LinuxFileSecretStore({ accountsDir, lockAcquireTimeoutMs: 0 });

    await assert.rejects(
      () => store.purge(),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
    assert.equal((await stat(lockPath)).isDirectory(), true);
    assert.equal((await store.get('acct_1')).accessToken, 'must-remain');
  });

  it('purges both committed secrets and abandoned atomic-write temporary files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const store = new LinuxFileSecretStore({ accountsDir });
    const temporaryPath = join(accountsDir, 'acct_1.json.1234.abcdef123456.tmp');
    await store.set('acct_1', { accessToken: 'committed-secret' });
    await writeFile(temporaryPath, JSON.stringify({ accessToken: 'temporary-secret' }), {
      mode: 0o600,
    });

    await store.purge();

    assert.equal(await store.get('acct_1'), null);
    await assert.rejects(stat(temporaryPath), { code: 'ENOENT' });
  });

  it('never preempts a lock while its Keychain child process is still alive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'orphaned-parent-live-child',
      pid: 2_147_483_647,
      childPid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
    }), { mode: 0o600 });

    const protectedStore = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 0,
    });
    await assert.rejects(
      () => protectedStore.delete('acct_1'),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );

    const advancedClockStore = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 0,
      lockRetryMs: 1,
      now: () => Date.now() + 6 * 60_000,
    });
    await assert.rejects(
      () => advancedClockStore.set('acct_1', { accessToken: 'must-not-preempt' }),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
  });

  it('recovers a live numeric pid only when its process-start identity changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'owner-from-previous-pid-generation',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
      processIdentity: { platform: 'test', bootId: 'old-boot', startId: 'old-start' },
    }), { mode: 0o600 });
    const store = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 100,
      lockRetryMs: 1,
      processIdentityImpl: async () => ({
        platform: 'test',
        bootId: 'current-boot',
        startId: 'current-start',
      }),
    });

    await store.set('acct_1', { accessToken: 'after-pid-reuse' });
    assert.equal((await store.get('acct_1')).accessToken, 'after-pid-reuse');
  });

  it('does not let one account purge a prefix-related account temporary credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const firstTemp = join(accountsDir, 'a.json.1234.abcdef123456.tmp');
    const secondAccount = 'a.json.123';
    const secondTemp = join(accountsDir, `${secondAccount}.json.5678.abcdef654321.tmp`);
    const secondLockPath = join(accountsDir, '.locks', `${secondAccount}.lock`);
    await mkdir(secondLockPath, { recursive: true, mode: 0o700 });
    await writeFile(firstTemp, JSON.stringify({ accessToken: 'first-temp' }), { mode: 0o600 });
    await writeFile(secondTemp, JSON.stringify({ accessToken: 'second-live-temp' }), { mode: 0o600 });
    await writeFile(join(secondLockPath, 'owner.json'), JSON.stringify({
      token: 'live-prefix-account-lock',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
    }), { mode: 0o600 });
    const store = new LinuxFileSecretStore({ accountsDir, lockAcquireTimeoutMs: 0 });

    await assert.rejects(
      () => store.purge(),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
    await assert.rejects(stat(firstTemp), { code: 'ENOENT' });
    assert.equal((await stat(secondTemp)).isFile(), true);
  });
});

describe('MacOSKeychainSecretStore', () => {
  it('derives the same live process identity across shell locale and timezone differences', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const previous = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      TZ: process.env.TZ,
    };
    try {
      process.env.LANG = 'ja_JP.UTF-8';
      process.env.LC_ALL = 'ja_JP.UTF-8';
      process.env.TZ = 'Asia/Tokyo';
      const interactiveIdentity = await secretStoreProcessIdentity(process.pid);
      process.env.LANG = 'C';
      process.env.LC_ALL = 'C';
      process.env.TZ = 'UTC';
      const launchdIdentity = await secretStoreProcessIdentity(process.pid);

      assert.deepEqual(interactiveIdentity, launchdIdentity);
      assert.equal(interactiveIdentity.platform, 'darwin');
      assert.match(interactiveIdentity.bootId, /^\d+$/);
      assert.ok(interactiveIdentity.startId.length > 0);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps Keychain compare-and-set and writers inside the filesystem lock', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-keychain-locks-'));
    const keychain = new Map();
    const calls = [];
    let blockNextRead = false;
    let releaseRead;
    let readEntered;
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const readStarted = new Promise(resolve => { readEntered = resolve; });
    const execFileImpl = async (command, args, options = {}) => {
      assert.equal(command, 'security');
      const action = args[0];
      if (action === '-i') {
        assert.ok(!args.some(argument => argument.includes('access-')));
        await options.beforeInput?.(process.pid);
        const accountId = options.input.match(/ -a "([^"]+)"/)?.[1];
        assert.ok(accountId);
        if (options.input.startsWith('delete-generic-password ')) {
          calls.push('delete-generic-password');
          keychain.delete(accountId);
          await options.afterClose?.(process.pid);
          return { stdout: '' };
        }
        const payloadHex = options.input.match(/ -X "([0-9a-f]+)"/)?.[1];
        assert.ok(payloadHex);
        calls.push('add-generic-password');
        keychain.set(accountId, Buffer.from(payloadHex, 'hex').toString('utf8'));
        await options.afterClose?.(process.pid);
        return { stdout: '' };
      }
      const accountId = args[args.indexOf('-a') + 1];
      calls.push(action);
      if (action === 'find-generic-password') {
        if (blockNextRead) {
          blockNextRead = false;
          readEntered();
          await readGate;
        }
        if (!keychain.has(accountId)) {
          const error = new Error('not found');
          error.code = 44;
          throw error;
        }
        return { stdout: `${keychain.get(accountId)}\n` };
      }
      if (action === 'delete-generic-password') {
        keychain.delete(accountId);
        return { stdout: '' };
      }
      throw new Error(`Unexpected security action: ${action}`);
    };
    const options = {
      lockDir: join(dir, 'locks'),
      execFileImpl,
      lockAcquireTimeoutMs: 1_000,
      lockRetryMs: 1,
    };
    const first = new MacOSKeychainSecretStore(options);
    const second = new MacOSKeychainSecretStore(options);
    const original = { accessToken: 'access-1', refreshToken: 'refresh-1' };
    await first.set('acct_1', original);
    blockNextRead = true;

    const cas = first.compareAndSet('acct_1', original, {
      ...original,
      accessToken: 'access-from-cas',
    });
    await readStarted;
    const competingSet = second.set('acct_1', {
      ...original,
      accessToken: 'access-from-set',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [
      'add-generic-password',
      'find-generic-password',
      'find-generic-password',
    ]);

    releaseRead();
    assert.equal(await cas, true);
    await competingSet;

    assert.deepEqual(calls, [
      'add-generic-password',
      'find-generic-password',
      'find-generic-password',
      'add-generic-password',
      'find-generic-password',
      'add-generic-password',
      'find-generic-password',
    ]);
    assert.equal((await first.get('acct_1')).accessToken, 'access-from-set');
  });

  it('round-trips a fake credential through the real macOS Keychain', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-keychain-integration-'));
    const accountId = `ci-${process.pid}-${Date.now()}`;
    const store = new MacOSKeychainSecretStore({ lockDir: join(dir, 'locks') });
    const original = {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      expiresAt: 4_102_444_800_000,
    };
    const replacement = { ...original, accessToken: 'fake-access-token-2' };

    try {
      await store.set(accountId, original);
      assert.deepEqual(await store.get(accountId), original);
      assert.equal(await store.compareAndSet(accountId, original, replacement), true);
      assert.deepEqual(await store.get(accountId), replacement);
    } finally {
      await store.delete(accountId).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createSecretStore', () => {
  it('selects Linux file storage on linux', () => {
    const store = createSecretStore({ platform: 'linux', home: '/home/alice', env: {} });

    assert.equal(store.constructor.name, 'LinuxFileSecretStore');
  });
});
