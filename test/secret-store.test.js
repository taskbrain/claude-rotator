import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemorySecretStore,
  LinuxFileSecretStore,
  MacOSKeychainSecretStore,
  createSecretStore,
  secretStoreProcessIdentity,
} from '../src/secret-store.js';
import { executeNativeClaudeCommand } from '../src/native-claude-refresher.js';
import { refreshAccessToken } from '../src/oauth.js';
import { createFileBackedFakeKeychainOptions } from '../fixtures/file-backed-fake-keychain.js';

function createFakeKeychainStoreOptions(lockDir) {
  const keychain = new Map();
  return {
    lockDir,
    execFileImpl: async (command, args, options = {}) => {
      assert.equal(command, 'security');
      if (args[0] === '-i') {
        await options.beforeInput?.(process.pid);
        const accountId = options.input.match(/ -a "([^"]+)"/)?.[1];
        assert.ok(accountId);
        if (options.input.startsWith('delete-generic-password ')) {
          keychain.delete(accountId);
        } else {
          const payloadHex = options.input.match(/ -X "([0-9a-f]+)"/)?.[1];
          assert.ok(payloadHex);
          keychain.set(accountId, Buffer.from(payloadHex, 'hex').toString('utf8'));
        }
        await options.afterClose?.(process.pid);
        return { stdout: '' };
      }
      const accountId = args[args.indexOf('-a') + 1];
      if (!keychain.has(accountId)) {
        const error = new Error('not found');
        error.code = 44;
        throw error;
      }
      return { stdout: `${keychain.get(accountId)}\n` };
    },
  };
}

// Touches the real macOS Keychain (via the `security` CLI), which triggers OS
// authentication prompts on a developer machine. Skipped by default; CI opts
// in via CLAUDE_ROTATOR_REAL_KEYCHAIN=1 (see .github/workflows/ci.yml).
const REAL_KEYCHAIN_SKIP_REASON = process.platform !== 'darwin'
  ? 'darwin only'
  : (process.env.CLAUDE_ROTATOR_REAL_KEYCHAIN === '1'
    ? false
    : 'set CLAUDE_ROTATOR_REAL_KEYCHAIN=1 to run tests that touch the real macOS Keychain');

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
    await assert.rejects(
      () => store.set('..', { accessToken: 'access' }),
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

  it('serializes refresh updates across store instances and returns the rotated credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const first = new LinuxFileSecretStore({ accountsDir });
    const second = new LinuxFileSecretStore({ accountsDir });
    const expiredSecret = {
      accessToken: 'expired-access',
      refreshToken: 'refresh-token-1',
      expiresAt: 1000,
    };
    const rotatedSecret = {
      accessToken: 'rotated-access',
      refreshToken: 'refresh-token-2',
      expiresAt: 200000,
    };
    await first.set('acct_1', expiredSecret);

    let exchangeCalls = 0;
    let releaseFirstUpdater;
    let firstUpdaterEntered;
    const firstUpdaterGate = new Promise(resolve => { releaseFirstUpdater = resolve; });
    const firstUpdaterStarted = new Promise(resolve => { firstUpdaterEntered = resolve; });
    const firstUpdate = first.updateIfUnchanged('acct_1', expiredSecret, async current => {
      exchangeCalls += 1;
      firstUpdaterEntered();
      await firstUpdaterGate;
      return { ...current, ...rotatedSecret };
    });
    await firstUpdaterStarted;
    const secondUpdate = second.updateIfUnchanged('acct_1', expiredSecret, async () => {
      exchangeCalls += 1;
      return assert.fail('stale updater must not be called');
    });
    releaseFirstUpdater();

    const results = await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(exchangeCalls, 1);
    assert.deepEqual(results.map(result => result.secret.accessToken), [
      'rotated-access',
      'rotated-access',
    ]);
    assert.deepEqual(await first.get('acct_1'), rotatedSecret);
  });

  it('exchanges the refresh token only once when two store instances race to refresh the same account', async () => {
    // Mirrors the "server" (long-lived proxy process) and "doctor" (a
    // separate CLI invocation) both racing to refresh the same OAuth
    // account through the durable refreshIfUnchanged transaction that
    // production code actually uses (refreshAndStoreSecret), not the
    // simpler updateIfUnchanged CAS API exercised above.
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const server = new LinuxFileSecretStore({ accountsDir });
    const doctor = new LinuxFileSecretStore({ accountsDir });
    const original = {
      accessToken: 'stale-access',
      refreshToken: 'refresh-token-1',
      expiresAt: 1000,
    };
    const rotated = {
      accessToken: 'rotated-access',
      refreshToken: 'refresh-token-2',
      expiresAt: 200000,
    };
    await server.set('acct_1', original);

    let exchangeCalls = 0;
    let releaseServerExchange;
    let signalServerExchangeStarted;
    const serverExchangeGate = new Promise(resolve => { releaseServerExchange = resolve; });
    const serverExchangeStarted = new Promise(resolve => { signalServerExchangeStarted = resolve; });
    const serverRefresh = server.refreshIfUnchanged('acct_1', original, async (current, transaction) => {
      exchangeCalls += 1;
      await transaction.beforeHandoff();
      signalServerExchangeStarted();
      await serverExchangeGate;
      return { ...current, ...rotated };
    });
    await serverExchangeStarted;
    const doctorRefresh = doctor.refreshIfUnchanged('acct_1', original, async () => {
      exchangeCalls += 1;
      return assert.fail('a concurrent refresh must not exchange the same refresh token twice');
    });
    releaseServerExchange();

    const [serverResult, doctorResult] = await Promise.all([serverRefresh, doctorRefresh]);

    assert.equal(exchangeCalls, 1);
    assert.equal(serverResult.secret.accessToken, 'rotated-access');
    // doctor observed the already-rotated credential once it acquired the
    // lock behind server, instead of exchanging the (now stale) refresh
    // token a second time.
    assert.equal(doctorResult.updated, false);
    assert.equal(doctorResult.secret.accessToken, 'rotated-access');
    assert.deepEqual(await server.get('acct_1'), rotated);
  });

  it('waits beyond five virtual seconds for a Linux refresh transaction and invokes one updater', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-linux-long-lock-'));
    const accountsDir = join(dir, 'accounts');
    let virtualNow = 0;
    let releaseFirstUpdater;
    const firstUpdaterGate = new Promise(resolve => { releaseFirstUpdater = resolve; });
    const first = new LinuxFileSecretStore({ accountsDir, now: () => virtualNow });
    const second = new LinuxFileSecretStore({
      accountsDir,
      now: () => virtualNow,
      lockRetryMs: 250,
      sleepImpl: async milliseconds => {
        virtualNow += milliseconds;
        if (virtualNow >= 5_250) releaseFirstUpdater();
        await new Promise(resolve => setImmediate(resolve));
      },
    });
    const original = { accessToken: 'linux-original', refreshToken: 'linux-refresh' };
    const committed = { ...original, accessToken: 'linux-committed' };
    await first.set('acct_1', original);
    let updaterCalls = 0;
    let signalUpdaterStarted;
    const updaterStarted = new Promise(resolve => { signalUpdaterStarted = resolve; });
    const firstUpdate = first.updateIfUnchanged('acct_1', original, async () => {
      updaterCalls += 1;
      signalUpdaterStarted();
      await firstUpdaterGate;
      return committed;
    });
    await updaterStarted;
    const secondUpdate = second.updateIfUnchanged('acct_1', original, async () => {
      updaterCalls += 1;
      return assert.fail('stale Linux updater must not run');
    });

    const [firstResult, secondResult] = await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(virtualNow > 5_000, true);
    assert.equal(updaterCalls, 1);
    assert.deepEqual(firstResult.secret, committed);
    assert.deepEqual(secondResult.secret, committed);
  });

  it('leaves the original credential intact and releases the lock when an updater fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const accountsDir = join(dir, 'accounts');
    const first = new LinuxFileSecretStore({ accountsDir });
    const second = new LinuxFileSecretStore({ accountsDir });
    const original = { accessToken: 'original-access', refreshToken: 'refresh-token-1' };
    const replacement = { accessToken: 'replacement-access', refreshToken: 'refresh-token-2' };
    await first.set('acct_1', original);

    await assert.rejects(
      () => first.updateIfUnchanged('acct_1', original, async () => {
        throw new Error('refresh failed');
      }),
      /refresh failed/,
    );
    assert.deepEqual(await first.get('acct_1'), original);

    assert.deepEqual(
      await second.updateIfUnchanged('acct_1', original, async () => replacement),
      { updated: true, secret: replacement },
    );
    assert.deepEqual(await first.get('acct_1'), replacement);
  });

  it('persists a private non-secret handoff marker and parks a newly constructed store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-refresh-intent-'));
    const accountsDir = join(dir, 'accounts');
    const markerPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const original = {
      accessToken: 'fixture-access-must-not-leak',
      refreshToken: 'fixture-refresh-must-not-leak',
      expiresAt: 1,
    };
    const first = new LinuxFileSecretStore({ accountsDir });
    assert.equal(typeof first.refreshIfUnchanged, 'function');
    assert.equal(typeof first.getOperational, 'function');
    await first.set('acct_1', original);
    let exchangeCalls = 0;

    await assert.rejects(
      () => first.refreshIfUnchanged('acct_1', original, async (current, transaction) => {
        exchangeCalls += 1;
        assert.deepEqual(current, original);
        assert.equal(typeof transaction.beforeHandoff, 'function');
        await transaction.beforeHandoff();
        throw Object.assign(new Error(`unsafe driver detail ${original.refreshToken}`), {
          code: 'DRIVER_RETRYABLE_FAILURE',
          retryAfterMs: 60_000,
          retryAfterSource: 'fixed',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
        && error.retryAfterMs === null
        && error.retryAfterSource === null
        && !error.message.includes(original.accessToken)
        && !error.message.includes(original.refreshToken),
    );

    const marker = await readFile(markerPath, 'utf8');
    assert.equal(marker.length < 4_096, true);
    assert.equal(marker.includes(original.accessToken), false);
    assert.equal(marker.includes(original.refreshToken), false);
    assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(accountsDir, '.locks'))).mode & 0o777, 0o700);
    assert.equal(JSON.parse(marker).phase, 'handed_off');

    const second = new LinuxFileSecretStore({ accountsDir });
    await assert.rejects(
      () => second.getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
        && !error.message.includes(original.accessToken)
        && !error.message.includes(original.refreshToken),
    );
    await assert.rejects(
      () => second.refreshIfUnchanged('acct_1', original, async () => {
        exchangeCalls += 1;
        return assert.fail('a parked credential must not be handed off again');
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    assert.equal(exchangeCalls, 1);
  });

  it('reconciles a committed target after a crash between credential write and marker deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-refresh-commit-'));
    const accountsDir = join(dir, 'accounts');
    const markerPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const original = {
      accessToken: 'source-access-fixture',
      refreshToken: 'source-refresh-fixture',
      expiresAt: 1,
    };
    const target = {
      accessToken: 'target-access-fixture',
      refreshToken: 'target-refresh-fixture',
      expiresAt: 4_102_444_800_000,
    };
    const crashing = new LinuxFileSecretStore({ accountsDir });
    assert.equal(typeof crashing.refreshIfUnchanged, 'function');
    assert.equal(typeof crashing.getOperational, 'function');
    await crashing.set('acct_1', original);
    const setUnlocked = crashing.setUnlocked.bind(crashing);
    crashing.setUnlocked = async (accountId, secret) => {
      await setUnlocked(accountId, secret);
      throw new Error('simulated process death after credential write');
    };

    await assert.rejects(
      () => crashing.refreshIfUnchanged('acct_1', original, async (current, transaction) => {
        await transaction.beforeHandoff();
        return { ...current, ...target };
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
        && error.retryAfterMs === null
        && !error.message.includes(original.refreshToken)
        && !error.message.includes(target.refreshToken),
    );
    const committingMarker = await readFile(markerPath, 'utf8');
    assert.equal(JSON.parse(committingMarker).phase, 'committing');
    assert.equal(committingMarker.includes(target.accessToken), false);
    assert.equal(committingMarker.includes(target.refreshToken), false);

    const recovered = new LinuxFileSecretStore({ accountsDir });
    assert.deepEqual(await recovered.getOperational('acct_1'), target);
    await assert.rejects(stat(markerPath), { code: 'ENOENT' });
  });

  it('keeps a malformed direct 200 response parked without a second token handoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-invalid-direct-refresh-'));
    const accountsDir = join(dir, 'accounts');
    const original = {
      accessToken: 'direct-invalid-access-fixture',
      refreshToken: 'direct-invalid-refresh-fixture',
      expiresAt: 1,
      scopes: ['user:profile', 'user:inference'],
    };
    const first = new LinuxFileSecretStore({ accountsDir });
    await first.set('acct_1', original);
    let requestCalls = 0;
    const exchange = async (current, transaction) => ({
      ...current,
      ...(await refreshAccessToken(current.refreshToken, {
        ...current,
        beforeHandoff: transaction.beforeHandoff,
        fetchImpl: async () => {
          requestCalls += 1;
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({}),
          };
        },
        now: () => 1_000,
      })),
    });

    await assert.rejects(
      () => first.refreshIfUnchanged('acct_1', original, exchange),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    const storedAfterFirstAttempt = await first.get('acct_1');
    const recovered = new LinuxFileSecretStore({ accountsDir });
    await assert.rejects(
      () => recovered.refreshIfUnchanged('acct_1', storedAfterFirstAttempt, exchange),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    assert.equal(requestCalls, 1);
    assert.deepEqual(await recovered.get('acct_1'), original);
  });

  it('does not persist a non-JSON refresh target as commit proof', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-invalid-refresh-target-'));
    const accountsDir = join(dir, 'accounts');
    const original = {
      accessToken: 'invalid-target-access-fixture',
      refreshToken: 'invalid-target-refresh-fixture',
      expiresAt: 1,
    };
    const store = new LinuxFileSecretStore({ accountsDir });
    await store.set('acct_1', original);

    await assert.rejects(
      () => store.refreshIfUnchanged('acct_1', original, async (current, transaction) => {
        await transaction.beforeHandoff();
        return {
          ...current,
          accessToken: undefined,
          expiresAt: 4_102_444_800_000,
        };
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    assert.deepEqual(await store.get('acct_1'), original);
    await assert.rejects(
      () => new LinuxFileSecretStore({ accountsDir }).getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
  });

  it('only an explicit replacement with a genuinely new refresh token clears a handoff marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-refresh-relink-'));
    const accountsDir = join(dir, 'accounts');
    const original = {
      accessToken: 'original-access-fixture',
      refreshToken: 'original-refresh-fixture',
      expiresAt: 1,
    };
    const store = new LinuxFileSecretStore({ accountsDir });
    assert.equal(typeof store.refreshIfUnchanged, 'function');
    assert.equal(typeof store.replaceLinkedCredential, 'function');
    await store.set('acct_1', original);
    await assert.rejects(
      () => store.refreshIfUnchanged('acct_1', original, async (current, transaction) => {
        await transaction.beforeHandoff();
        throw Object.assign(new Error('ambiguous handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    await assert.rejects(
      () => store.replaceLinkedCredential('acct_1', {
        ...original,
        accessToken: 'rewritten-access-fixture',
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    await assert.rejects(
      () => store.getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    await assert.rejects(
      () => store.compareAndSet('acct_1', original, {
        ...original,
        accessToken: 'live-mirror-rewrite-fixture',
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    const replacement = {
      accessToken: 'replacement-access-fixture',
      refreshToken: 'replacement-refresh-fixture',
      expiresAt: 4_102_444_800_000,
    };
    await store.replaceLinkedCredential('acct_1', replacement);
    assert.deepEqual(await store.getOperational('acct_1'), replacement);
  });

  it('fails closed on corrupt and unknown-phase refresh markers without exposing credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-corrupt-refresh-marker-'));
    const accountsDir = join(dir, 'accounts');
    const markerPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const secret = {
      accessToken: 'corrupt-marker-access-fixture',
      refreshToken: 'corrupt-marker-refresh-fixture',
    };
    const store = new LinuxFileSecretStore({ accountsDir });
    await store.set('acct_1', secret);

    for (const marker of ['{', JSON.stringify({ version: 1, phase: 'unknown' })]) {
      await writeFile(markerPath, marker, { mode: 0o600 });
      await assert.rejects(
        () => new LinuxFileSecretStore({ accountsDir }).getOperational('acct_1'),
        error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
          && !error.message.includes(secret.accessToken)
          && !error.message.includes(secret.refreshToken),
      );
    }
  });

  it('clears a handed-off marker for a proven provider 429 cooldown', async () => {
    const store = new MemorySecretStore();
    const original = {
      accessToken: 'rate-limit-access-fixture',
      refreshToken: 'rate-limit-refresh-fixture',
    };
    await store.set('acct_1', original);

    await assert.rejects(
      () => store.refreshIfUnchanged('acct_1', original, async (_current, transaction) => {
        await transaction.beforeHandoff();
        const error = new Error('provider cooldown');
        error.name = 'OAuthTokenRefreshError';
        error.status = 429;
        error.retryAfterMs = 60_000;
        throw error;
      }),
      error => error.name === 'OAuthTokenRefreshError' && error.status === 429,
    );

    assert.deepEqual(await store.getOperational('acct_1'), original);
  });

  it('keeps a persisted handoff marker authoritative after the lock owner is killed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-refresh-owner-death-'));
    const accountsDir = join(dir, 'accounts');
    const original = {
      accessToken: 'owner-death-access-fixture',
      refreshToken: 'owner-death-refresh-fixture',
      expiresAt: 1,
    };
    const store = new LinuxFileSecretStore({ accountsDir });
    await store.set('acct_1', original);
    const worker = fork(
      new URL('../fixtures/secret-store-handoff-worker.js', import.meta.url),
      [accountsDir, 'acct_1'],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    const [message] = await Promise.race([
      once(worker, 'message'),
      once(worker, 'exit').then(([code, signal]) => [{ type: 'worker-exit', code, signal }]),
    ]);
    assert.deepEqual(message, { type: 'handed-off' });
    worker.kill('SIGKILL');
    await once(worker, 'exit');

    const recovered = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 1_000,
      lockRetryMs: 1,
    });
    let exchangeCalls = 0;
    await assert.rejects(
      () => recovered.refreshIfUnchanged('acct_1', original, async () => {
        exchangeCalls += 1;
        return assert.fail('dead-owner recovery must not repeat the handoff');
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    assert.equal(exchangeCalls, 0);
  });

  it('keeps the marker authoritative after a leased native child closes and before commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-native-child-marker-'));
    const accountsDir = join(dir, 'accounts');
    const markerPath = join(accountsDir, '.locks', 'acct_1.refresh-intent.json');
    const original = {
      accessToken: 'native-child-access-fixture',
      refreshToken: 'native-child-refresh-fixture',
      expiresAt: 1,
    };
    const store = new LinuxFileSecretStore({ accountsDir });
    await store.set('acct_1', original);

    await assert.rejects(
      () => store.refreshIfUnchanged('acct_1', original, async (_current, transaction) => {
        await transaction.beforeHandoff();
        await executeNativeClaudeCommand(process.execPath, ['-e', ''], {
          timeoutMs: 5_000,
          afterSpawn: transaction.protectChildPid,
          afterClose: transaction.clearChildPid,
        });
        assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).phase, 'handed_off');
        throw Object.assign(new Error('crash window after native child close'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );

    await assert.rejects(
      () => new LinuxFileSecretStore({ accountsDir }).getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
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

  it('bounds lock acquisition with a monotonic clock even if the wall clock jumps backward', {
    timeout: 2_000,
  }, async () => {
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

    const wallClockBase = Date.now();
    let wallClockCalls = 0;
    const store = new LinuxFileSecretStore({
      accountsDir,
      lockAcquireTimeoutMs: 300,
      lockRetryMs: 10,
      // Simulates an NTP-style backward wall-clock jump: the first read
      // captures "started at", every read after that is 60s in the past.
      now: () => {
        wallClockCalls += 1;
        return wallClockCalls === 1 ? wallClockBase : wallClockBase - 60_000;
      },
    });

    const startedAt = performance.now();
    await assert.rejects(
      () => store.delete('acct_1'),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
    assert.ok(performance.now() - startedAt < 2_000);
  });

  it('times out deterministically at the finite 90-second default lock bound', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-default-lock-bound-'));
    const accountsDir = join(dir, 'accounts');
    const lockPath = join(accountsDir, '.locks', 'acct_1.lock');
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      token: 'live-default-bound-lock',
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: 0,
    }), { mode: 0o600 });
    let virtualNow = 0;
    const store = new LinuxFileSecretStore({
      accountsDir,
      now: () => virtualNow,
      monotonicNow: () => virtualNow,
      lockRetryMs: 1_000,
      sleepImpl: async milliseconds => { virtualNow += milliseconds; },
    });

    await assert.rejects(
      () => store.delete('acct_1'),
      error => error.code === 'SECRET_STORE_LOCK_TIMEOUT',
    );
    assert.equal(virtualNow, 90_000);
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

  it('waits beyond five virtual seconds for fake-Keychain contention and invokes one updater', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-keychain-long-lock-'));
    const lockDir = join(dir, 'locks');
    const shared = createFakeKeychainStoreOptions(lockDir);
    let virtualNow = 0;
    let releaseFirstUpdater;
    const firstUpdaterGate = new Promise(resolve => { releaseFirstUpdater = resolve; });
    const first = new MacOSKeychainSecretStore({ ...shared, now: () => virtualNow });
    const second = new MacOSKeychainSecretStore({
      ...shared,
      now: () => virtualNow,
      lockRetryMs: 250,
      sleepImpl: async milliseconds => {
        virtualNow += milliseconds;
        if (virtualNow >= 5_250) releaseFirstUpdater();
        await new Promise(resolve => setImmediate(resolve));
      },
    });
    const original = { accessToken: 'mac-original', refreshToken: 'mac-refresh' };
    const committed = { ...original, accessToken: 'mac-committed' };
    await first.set('acct_1', original);
    let updaterCalls = 0;
    let signalUpdaterStarted;
    const updaterStarted = new Promise(resolve => { signalUpdaterStarted = resolve; });
    const firstUpdate = first.updateIfUnchanged('acct_1', original, async () => {
      updaterCalls += 1;
      signalUpdaterStarted();
      await firstUpdaterGate;
      return committed;
    });
    await updaterStarted;
    const secondUpdate = second.updateIfUnchanged('acct_1', original, async () => {
      updaterCalls += 1;
      return assert.fail('stale fake-Keychain updater must not run');
    });

    const [firstResult, secondResult] = await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(virtualNow > 5_000, true);
    assert.equal(updaterCalls, 1);
    assert.deepEqual(firstResult.secret, committed);
    assert.deepEqual(secondResult.secret, committed);
  });

  it('parks the same handed-off refresh token across fake-Keychain store instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-keychain-refresh-intent-'));
    const lockDir = join(dir, 'locks');
    const markerPath = join(lockDir, 'acct_1.refresh-intent.json');
    const options = createFakeKeychainStoreOptions(lockDir);
    const first = new MacOSKeychainSecretStore(options);
    assert.equal(typeof first.refreshIfUnchanged, 'function');
    assert.equal(typeof first.getOperational, 'function');
    const original = {
      accessToken: 'mac-access-fixture-must-not-leak',
      refreshToken: 'mac-refresh-fixture-must-not-leak',
      expiresAt: 1,
    };
    await first.set('acct_1', original);
    let exchangeCalls = 0;

    await assert.rejects(
      () => first.refreshIfUnchanged('acct_1', original, async (_current, transaction) => {
        exchangeCalls += 1;
        await transaction.beforeHandoff();
        throw Object.assign(new Error('ambiguous fake-Keychain handoff'), {
          code: 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
        });
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    const marker = await readFile(markerPath, 'utf8');
    assert.equal(marker.includes(original.accessToken), false);
    assert.equal(marker.includes(original.refreshToken), false);

    const second = new MacOSKeychainSecretStore(options);
    await assert.rejects(
      () => second.getOperational('acct_1'),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    await assert.rejects(
      () => second.refreshIfUnchanged('acct_1', original, async () => {
        exchangeCalls += 1;
        return assert.fail('a parked fake-Keychain token must not be handed off again');
      }),
      error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
    );
    assert.equal(exchangeCalls, 1);
  });

  it('keeps a fake-Keychain handoff parked after its lock owner is killed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-keychain-owner-death-'));
    const lockDir = join(dir, 'locks');
    const keychainPath = join(dir, 'keychain.json');
    const accountId = 'acct_1';
    const original = {
      accessToken: 'mac-owner-death-access-fixture',
      refreshToken: 'mac-owner-death-refresh-fixture',
      expiresAt: 1,
    };
    const first = new MacOSKeychainSecretStore(
      createFileBackedFakeKeychainOptions(lockDir, keychainPath),
    );
    await first.set(accountId, original);
    const worker = fork(
      new URL('../fixtures/macos-secret-store-handoff-worker.js', import.meta.url),
      [lockDir, keychainPath, accountId],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );

    try {
      const [message] = await Promise.race([
        once(worker, 'message'),
        once(worker, 'exit').then(([code, signal]) => [{
          type: 'worker-exit',
          code,
          signal,
        }]),
      ]);
      assert.deepEqual(message, { type: 'handed-off' });
      worker.kill('SIGKILL');
      await once(worker, 'exit');

      const recovered = new MacOSKeychainSecretStore({
        ...createFileBackedFakeKeychainOptions(lockDir, keychainPath),
        lockAcquireTimeoutMs: 1_000,
        lockRetryMs: 1,
      });
      let exchangeCalls = 0;
      await assert.rejects(
        () => recovered.refreshIfUnchanged(accountId, original, async () => {
          exchangeCalls += 1;
          return assert.fail('dead fake-Keychain owner must not repeat the handoff');
        }),
        error => error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN',
      );
      assert.equal(exchangeCalls, 0);
      assert.deepEqual(await recovered.get(accountId), original);
    } finally {
      if (worker.exitCode == null && worker.signalCode == null) worker.kill('SIGKILL');
    }
  });

  it('round-trips a fake credential through the real macOS Keychain', {
    skip: REAL_KEYCHAIN_SKIP_REASON,
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
