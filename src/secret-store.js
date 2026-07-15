import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

import { appDataDir, linuxAccountsDir } from './paths.js';
import { writeJsonFile } from './json-file.js';
import { executeSecurityCommand } from './native-claude-refresher.js';

const execFileAsync = promisify(execFile);
const ID_RE = /^[A-Za-z0-9._@-]+$/;
const KEYCHAIN_SERVICE_PREFIX = 'claude-rotator';
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 60_000;
let linuxBootIdentityPromise = null;
let darwinBootIdentityPromise = null;

function assertSafeAccountId(accountId) {
  if (!ID_RE.test(accountId)) {
    throw new Error(`Invalid account id: ${accountId}`);
  }
}

function cloneSecret(secret) {
  return secret == null ? secret : JSON.parse(JSON.stringify(secret));
}

function lockTimeoutError(accountId) {
  const error = new Error(`Timed out acquiring the secret-store lock for account ${accountId}`);
  error.code = 'SECRET_STORE_LOCK_TIMEOUT';
  return error;
}

class AccountFileLock {
  constructor({
    lockDir,
    acquireTimeoutMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    retryMs = DEFAULT_LOCK_RETRY_MS,
    staleMs = DEFAULT_LOCK_STALE_MS,
    now = () => Date.now(),
    sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
    hostnameImpl = hostname,
    processIdentityImpl = processIdentity,
  }) {
    this.lockDir = lockDir;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.retryMs = retryMs;
    this.staleMs = staleMs;
    this.now = now;
    this.sleepImpl = sleepImpl;
    this.hostname = hostnameImpl();
    this.processIdentityImpl = processIdentityImpl;
    this.localProcessIdentityPromise = null;
  }

  async run(accountId, operation) {
    const lease = await this.acquire(accountId);
    try {
      return await operation(lease);
    } finally {
      await lease.release();
    }
  }

  async acquire(accountId) {
    assertSafeAccountId(accountId);
    await mkdir(this.lockDir, { recursive: true, mode: 0o700 });
    await chmod(this.lockDir, 0o700);
    const lockPath = join(this.lockDir, `${accountId}.lock`);
    const startedAt = this.now();
    const ownerProcessIdentity = await this.localProcessIdentity();

    while (true) {
      if (await hasActiveRecoveryIntent(this.lockDir, accountId, {
        localHostname: this.hostname,
        staleMs: this.staleMs,
        now: this.now(),
        processIdentityImpl: this.processIdentityImpl,
      })) {
        await this.waitForRetry(accountId, startedAt);
        continue;
      }

      const token = randomUUID();
      const pendingPath = join(this.lockDir, `.${accountId}.${process.pid}.${token}.pending`);
      try {
        await mkdir(pendingPath, { mode: 0o700 });
        await writeFile(join(pendingPath, 'owner.json'), JSON.stringify({
          token,
          pid: process.pid,
          hostname: this.hostname,
          acquiredAt: this.now(),
          processIdentity: ownerProcessIdentity,
        }), { mode: 0o600, flag: 'wx' });
        await rename(pendingPath, lockPath);
        try {
          const recoveryActive = await hasActiveRecoveryIntent(this.lockDir, accountId, {
            localHostname: this.hostname,
            staleMs: this.staleMs,
            now: this.now(),
            processIdentityImpl: this.processIdentityImpl,
          });
          const owner = await readLockOwner(lockPath);
          if (recoveryActive || owner?.token !== token) {
            if (owner?.token === token) {
              await releaseOwnedLock(lockPath, this.lockDir, accountId, token, {
                localHostname: this.hostname,
                now: this.now,
                ownerProcessIdentity,
              });
            }
            await this.waitForRetry(accountId, startedAt);
            continue;
          }
        } catch (error) {
          const owner = await readLockOwner(lockPath).catch(() => null);
          if (owner?.token === token) {
            await releaseOwnedLock(lockPath, this.lockDir, accountId, token, {
              localHostname: this.hostname,
              now: this.now,
              ownerProcessIdentity,
            }).catch(() => {});
          }
          throw error;
        }
        return {
          release: () => releaseOwnedLock(lockPath, this.lockDir, accountId, token, {
            localHostname: this.hostname,
            now: this.now,
            ownerProcessIdentity,
          }),
          protectChildPid: childPid => protectOwnedLockWithChildPid(
            lockPath,
            token,
            childPid,
            this.now,
            this.processIdentityImpl,
          ),
          clearChildPid: childPid => clearOwnedLockChildPid(
            lockPath,
            token,
            childPid,
          ),
        };
      } catch (error) {
        await rm(pendingPath, { recursive: true, force: true }).catch(() => {});
        if (!isLockAlreadyHeldError(error)) throw error;
      }

      const observed = await inspectLock(lockPath, this.now());
      if (observed && await isStaleLock(observed, {
        localHostname: this.hostname,
        staleMs: this.staleMs,
        processIdentityImpl: this.processIdentityImpl,
      })) {
        await recoverObservedLock(lockPath, observed, this.lockDir, accountId, {
          localHostname: this.hostname,
          staleMs: this.staleMs,
          now: this.now,
          processIdentityImpl: this.processIdentityImpl,
          ownerProcessIdentity,
        });
        continue;
      }

      await this.waitForRetry(accountId, startedAt);
    }
  }

  async waitForRetry(accountId, startedAt) {
    const elapsedMs = this.now() - startedAt;
    if (elapsedMs >= this.acquireTimeoutMs) throw lockTimeoutError(accountId);
    await this.sleepImpl(Math.min(this.retryMs, this.acquireTimeoutMs - elapsedMs));
  }

  async localProcessIdentity() {
    this.localProcessIdentityPromise ||= Promise.resolve()
      .then(() => this.processIdentityImpl(process.pid));
    let identity;
    try {
      identity = await this.localProcessIdentityPromise;
    } catch (error) {
      this.localProcessIdentityPromise = null;
      throw error;
    }
    if (identity == null) {
      this.localProcessIdentityPromise = null;
      throw processIdentityUnavailableError();
    }
    return identity;
  }
}

function isLockAlreadyHeldError(error) {
  return ['EEXIST', 'ENOTEMPTY'].includes(error?.code);
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') return null;
    throw error;
  }
}

async function inspectLock(lockPath, now) {
  try {
    const info = await stat(lockPath);
    const owner = await readLockOwner(lockPath);
    const childLease = owner?.token
      ? await readChildLease(lockPath, owner.token)
      : null;
    return {
      dev: info.dev,
      ino: info.ino,
      ageMs: Math.max(0, now - info.mtimeMs),
      owner: childLease
        ? {
          ...owner,
          childPid: childLease.childPid,
          childProcessIdentity: childLease.childProcessIdentity,
        }
        : owner,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function childLeasePath(lockPath, token) {
  return join(lockPath, `.child-${token}.json`);
}

async function readChildLease(lockPath, token) {
  try {
    return JSON.parse(await readFile(childLeasePath(lockPath, token), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error.name === 'SyntaxError') return null;
    throw error;
  }
}

async function isStaleLock(observed, {
  localHostname,
  staleMs,
  processIdentityImpl = processIdentity,
}) {
  const { owner } = observed;
  if (owner?.hostname === localHostname) {
    const parentPid = Number.isInteger(owner.pid) && owner.pid > 0 ? owner.pid : null;
    const childPid = Number.isInteger(owner.childPid) && owner.childPid > 0
      ? owner.childPid
      : null;
    if (childPid && await processIdentityMatches(
      childPid,
      owner.childProcessIdentity,
      processIdentityImpl,
    )) return false;
    if (parentPid && await processIdentityMatches(
      parentPid,
      owner.processIdentity,
      processIdentityImpl,
    )) return false;
    if (parentPid || childPid) return true;
  }
  return observed.ageMs >= staleMs;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processIdentityUnavailableError() {
  const error = new Error('Could not establish a safe secret-store process identity');
  error.code = 'SECRET_STORE_PROCESS_IDENTITY_UNAVAILABLE';
  return error;
}

async function processIdentityMatches(pid, expectedIdentity, processIdentityImpl) {
  if (!isProcessAlive(pid)) return false;
  if (expectedIdentity == null) return true;
  const currentIdentity = await processIdentityImpl(pid).catch(() => null);
  // Failure to inspect a live process must fail safe and keep its lock.
  if (currentIdentity == null) return true;
  return isDeepStrictEqual(currentIdentity, expectedIdentity);
}

export async function secretStoreProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      linuxBootIdentityPromise ||= readFile('/proc/sys/kernel/random/boot_id', 'utf8')
        .then(value => value.trim())
        .then(value => {
          if (!value) linuxBootIdentityPromise = null;
          return value || null;
        })
        .catch(() => {
          linuxBootIdentityPromise = null;
          return null;
        });
      const [bootId, processStat] = await Promise.all([
        linuxBootIdentityPromise,
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const commandEnd = processStat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = processStat.slice(commandEnd + 1).trim().split(/\s+/);
      const startId = fieldsAfterCommand[19];
      if (!bootId || !startId) return null;
      return { platform: 'linux', bootId, startId };
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      darwinBootIdentityPromise ||= execFileAsync(
        'sysctl',
        ['-n', 'kern.boottime'],
        { encoding: 'utf8', timeout: 1_000 },
      ).then(({ stdout }) => stdout.match(/\bsec\s*=\s*(\d+)/)?.[1] || null)
        .then(value => {
          if (!value) darwinBootIdentityPromise = null;
          return value;
        })
        .catch(() => {
          darwinBootIdentityPromise = null;
          return null;
        });
      const stableProcessEnvironment = {
        ...process.env,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
      };
      const [bootId, { stdout }] = await Promise.all([
        darwinBootIdentityPromise,
        execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          env: stableProcessEnvironment,
          timeout: 1_000,
        }),
      ]);
      const startId = stdout.trim();
      return bootId && startId ? { platform: 'darwin', bootId, startId } : null;
    } catch {
      return null;
    }
  }
  return null;
}

const processIdentity = secretStoreProcessIdentity;

function recoveryIntentPrefix(accountId) {
  // `+` is deliberately outside ID_RE, so one account id cannot be a prefix
  // match for another account's transition intent.
  return `.${accountId}+`;
}

function isRecoveryIntentName(name, accountId) {
  return name.startsWith(recoveryIntentPrefix(accountId)) && name.endsWith('.recovery');
}

function sameObservedLock(current, observed) {
  return current?.dev === observed.dev
    && current?.ino === observed.ino
    && current?.owner?.token === observed.owner?.token;
}

async function hasActiveRecoveryIntent(lockDir, accountId, {
  localHostname,
  staleMs,
  now,
  processIdentityImpl,
}) {
  let entries;
  try {
    entries = await readdir(lockDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  let active = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRecoveryIntentName(entry.name, accountId)) continue;
    const intentPath = join(lockDir, entry.name);
    const observed = await inspectLock(intentPath, now);
    if (!observed) continue;
    if (await isStaleLock(observed, {
      localHostname,
      staleMs,
      processIdentityImpl,
    })) {
      // Recovery intent names contain a UUID and are never reused, so deleting a
      // confirmed-dead intent cannot remove a replacement owner's lock.
      await rm(intentPath, { recursive: true, force: true });
    } else {
      active = true;
    }
  }
  return active;
}

async function recoverObservedLock(lockPath, observed, lockDir, accountId, {
  localHostname,
  staleMs,
  now,
  processIdentityImpl,
  ownerProcessIdentity,
}) {
  const intentPath = await createTransitionIntent(lockDir, accountId, {
    localHostname,
    now,
    ownerProcessIdentity,
  });
  try {
    const current = await inspectLock(lockPath, now());
    if (!sameObservedLock(current, observed)) return false;
    if (!await isStaleLock(current, {
      localHostname,
      staleMs,
      processIdentityImpl,
    })) return false;
    return retireObservedLock(lockPath, current, lockDir, accountId, 'stale');
  } finally {
    await rm(intentPath, { recursive: true, force: true });
  }
}

async function releaseOwnedLock(lockPath, lockDir, accountId, token, {
  localHostname,
  now,
  ownerProcessIdentity,
}) {
  const intentPath = await createTransitionIntent(lockDir, accountId, {
    localHostname,
    now,
    ownerProcessIdentity,
  });
  try {
    const current = await inspectLock(lockPath, now());
    if (current?.owner?.token !== token) return false;
    return retireObservedLock(lockPath, current, lockDir, accountId, 'released');
  } finally {
    await rm(intentPath, { recursive: true, force: true });
  }
}

async function protectOwnedLockWithChildPid(
  lockPath,
  token,
  childPid,
  now,
  processIdentityImpl,
) {
  if (!Number.isInteger(childPid) || childPid <= 0) {
    throw new Error('Keychain child process did not provide a valid pid');
  }
  const current = await inspectLock(lockPath, now());
  if (current?.owner?.token !== token) {
    const error = new Error('Secret-store lock ownership changed before Keychain mutation');
    error.code = 'SECRET_STORE_LOCK_LOST';
    throw error;
  }

  const targetPath = childLeasePath(lockPath, token);
  const pendingPath = join(lockPath, `.child-${token}.${randomUUID()}.tmp`);
  try {
    const childProcessIdentity = await processIdentityImpl(childPid);
    if (childProcessIdentity == null) throw processIdentityUnavailableError();
    await writeFile(pendingPath, JSON.stringify({
      childPid,
      childProcessIdentity,
    }), { mode: 0o600, flag: 'wx' });
    await rename(pendingPath, targetPath);
    const verified = await inspectLock(lockPath, now());
    if (verified?.owner?.token !== token || verified.owner.childPid !== childPid) {
      await rm(targetPath, { force: true }).catch(() => {});
      const error = new Error('Secret-store lock ownership changed before Keychain mutation');
      error.code = 'SECRET_STORE_LOCK_LOST';
      throw error;
    }
  } catch (error) {
    await rm(pendingPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function clearOwnedLockChildPid(lockPath, token, childPid) {
  const leasePath = childLeasePath(lockPath, token);
  const childLease = await readChildLease(lockPath, token);
  if (childLease?.childPid === childPid) await rm(leasePath, { force: true });
}

async function createTransitionIntent(lockDir, accountId, {
  localHostname,
  now,
  ownerProcessIdentity,
}) {
  const token = randomUUID();
  const intentPath = join(lockDir, `${recoveryIntentPrefix(accountId)}${process.pid}.${token}.recovery`);
  await mkdir(intentPath, { mode: 0o700 });
  try {
    if (ownerProcessIdentity == null) throw processIdentityUnavailableError();
    await writeFile(join(intentPath, 'owner.json'), JSON.stringify({
      token,
      pid: process.pid,
      hostname: localHostname,
      acquiredAt: now(),
      processIdentity: ownerProcessIdentity,
    }), { mode: 0o600, flag: 'wx' });
    return intentPath;
  } catch (error) {
    await rm(intentPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function retireObservedLock(lockPath, observed, lockDir, accountId, suffix) {
  const retiredPath = join(lockDir, `.${accountId}.${randomUUID()}.${suffix}`);
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  const moved = await inspectLock(retiredPath, Date.now());
  if (!sameObservedLock(moved, observed)) {
    try {
      await rename(retiredPath, lockPath);
    } catch (error) {
      if (!isLockAlreadyHeldError(error)) throw error;
    }
    return false;
  }

  await rm(retiredPath, { recursive: true, force: true });
  return true;
}

export class MemorySecretStore {
  constructor() {
    this.items = new Map();
  }

  async set(accountId, secret) {
    assertSafeAccountId(accountId);
    this.items.set(accountId, cloneSecret(secret));
  }

  async get(accountId) {
    assertSafeAccountId(accountId);
    const value = this.items.get(accountId);
    return value ? cloneSecret(value) : null;
  }

  async compareAndSet(accountId, expectedSecret, nextSecret) {
    assertSafeAccountId(accountId);
    const current = this.items.has(accountId) ? this.items.get(accountId) : null;
    if (!isDeepStrictEqual(current, expectedSecret)) return false;
    this.items.set(accountId, cloneSecret(nextSecret));
    return true;
  }

  async delete(accountId) {
    assertSafeAccountId(accountId);
    this.items.delete(accountId);
  }

  async list() {
    return [...this.items.keys()].sort();
  }

  async purge() {
    this.items.clear();
  }
}

export class LinuxFileSecretStore {
  constructor({
    accountsDir = linuxAccountsDir(),
    lockAcquireTimeoutMs,
    lockRetryMs,
    lockStaleMs,
    now,
    sleepImpl,
    hostnameImpl,
    processIdentityImpl,
  } = {}) {
    this.accountsDir = accountsDir;
    this.accountLock = new AccountFileLock({
      lockDir: join(accountsDir, '.locks'),
      acquireTimeoutMs: lockAcquireTimeoutMs,
      retryMs: lockRetryMs,
      staleMs: lockStaleMs,
      now,
      sleepImpl,
      hostnameImpl,
      processIdentityImpl,
    });
  }

  secretPath(accountId) {
    assertSafeAccountId(accountId);
    return join(this.accountsDir, `${accountId}.json`);
  }

  async set(accountId, secret) {
    return this.accountLock.run(accountId, () => this.setUnlocked(accountId, secret));
  }

  async setUnlocked(accountId, secret) {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    await chmod(this.accountsDir, 0o700);
    await writeJsonFile(this.secretPath(accountId), secret, 0o600);
  }

  async get(accountId) {
    return this.getUnlocked(accountId);
  }

  async getUnlocked(accountId) {
    try {
      return JSON.parse(await readFile(this.secretPath(accountId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(accountId) {
    return this.accountLock.run(accountId, () => rm(this.secretPath(accountId), { force: true }));
  }

  async compareAndSet(accountId, expectedSecret, nextSecret) {
    return this.accountLock.run(accountId, async () => {
      const current = await this.getUnlocked(accountId);
      if (!isDeepStrictEqual(current, expectedSecret)) return false;
      await this.setUnlocked(accountId, nextSecret);
      return true;
    });
  }

  async list() {
    try {
      const files = await readdir(this.accountsDir);
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
        .filter(id => ID_RE.test(id))
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async purge() {
    const accountIds = await this.list();
    for (const accountId of accountIds) {
      await this.delete(accountId);
    }
    const temporaryAccountIds = await this.listTemporarySecretAccountIds();
    for (const accountId of temporaryAccountIds) {
      await this.accountLock.run(
        accountId,
        () => this.removeTemporarySecretsUnlocked(accountId),
      );
    }
  }

  async listTemporarySecretAccountIds() {
    try {
      const files = await readdir(this.accountsDir);
      return [...new Set(files.map(file => {
        const match = file.match(/^(.+)\.json\.\d+\.[0-9a-f]{12}\.tmp$/);
        return match && ID_RE.test(match[1]) ? match[1] : null;
      }).filter(Boolean))].sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async removeTemporarySecretsUnlocked(accountId) {
    const files = await readdir(this.accountsDir).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(files
      .filter(file => file.match(/^(.+)\.json\.\d+\.[0-9a-f]{12}\.tmp$/)?.[1] === accountId)
      .map(file => rm(join(this.accountsDir, file), { force: true })));
  }
}

export class MacOSKeychainSecretStore {
  constructor({
    lockDir = join(appDataDir(), 'secret-locks'),
    execFileImpl = executeSecurityCommand,
    lockAcquireTimeoutMs,
    lockRetryMs,
    lockStaleMs,
    now,
    sleepImpl,
    hostnameImpl,
    processIdentityImpl,
  } = {}) {
    this.execFileImpl = execFileImpl;
    this.accountLock = new AccountFileLock({
      lockDir,
      acquireTimeoutMs: lockAcquireTimeoutMs,
      retryMs: lockRetryMs,
      staleMs: lockStaleMs,
      now,
      sleepImpl,
      hostnameImpl,
      processIdentityImpl,
    });
  }

  serviceName(accountId) {
    assertSafeAccountId(accountId);
    return `${KEYCHAIN_SERVICE_PREFIX}:${accountId}`;
  }

  async set(accountId, secret) {
    return this.accountLock.run(
      accountId,
      lease => this.setUnlocked(accountId, secret, lease),
    );
  }

  async setUnlocked(accountId, secret, lease) {
    const payloadHex = Buffer.from(JSON.stringify(secret), 'utf8').toString('hex');
    const input = `add-generic-password -U -a "${accountId}" -s "${this.serviceName(accountId)}" -X "${payloadHex}"\n`;
    await this.execFileImpl('security', ['-i'], {
      input,
      beforeInput: childPid => lease.protectChildPid(childPid),
      afterClose: childPid => lease.clearChildPid(childPid).catch(() => {}),
    });
    if (!isDeepStrictEqual(await this.getUnlocked(accountId), secret)) {
      const error = new Error('Could not verify the Keychain credential write');
      error.code = 'SECRET_STORE_WRITE_VERIFY_FAILED';
      throw error;
    }
  }

  async get(accountId) {
    return this.getUnlocked(accountId);
  }

  async getUnlocked(accountId) {
    try {
      const { stdout } = await this.execFileImpl('security', [
        'find-generic-password',
        '-a', accountId,
        '-s', this.serviceName(accountId),
        '-w',
      ]);
      return JSON.parse(stdout.trim());
    } catch (error) {
      if (error.code === 44 || /could not be found|not found/i.test(error.stderr || '')) return null;
      throw error;
    }
  }

  async delete(accountId) {
    return this.accountLock.run(
      accountId,
      lease => this.deleteUnlocked(accountId, lease),
    );
  }

  async deleteUnlocked(accountId, lease) {
    const input = `delete-generic-password -a "${accountId}" -s "${this.serviceName(accountId)}"\n`;
    await this.execFileImpl('security', ['-i'], {
      input,
      beforeInput: childPid => lease.protectChildPid(childPid),
      afterClose: childPid => lease.clearChildPid(childPid).catch(() => {}),
    }).catch(error => {
      if (error.code === 44 || /could not be found|not found/i.test(error.stderr || '')) return;
      throw error;
    });
    if (await this.getUnlocked(accountId) != null) {
      const error = new Error('Could not verify the Keychain credential deletion');
      error.code = 'SECRET_STORE_DELETE_VERIFY_FAILED';
      throw error;
    }
  }

  async compareAndSet(accountId, expectedSecret, nextSecret) {
    return this.accountLock.run(accountId, async lease => {
      const current = await this.getUnlocked(accountId);
      if (!isDeepStrictEqual(current, expectedSecret)) return false;
      await this.setUnlocked(accountId, nextSecret, lease);
      return true;
    });
  }

  async list() {
    return [];
  }

  async purge(accountIds = []) {
    for (const accountId of accountIds) {
      await this.delete(accountId);
    }
  }
}

export function createSecretStore({ platform = process.platform, env = process.env, home } = {}) {
  if (platform === 'darwin') {
    return new MacOSKeychainSecretStore({ lockDir: join(appDataDir(env, home), 'secret-locks') });
  }
  if (platform === 'linux') {
    return new LinuxFileSecretStore({ accountsDir: linuxAccountsDir(env, home) });
  }
  return new LinuxFileSecretStore({ accountsDir: linuxAccountsDir(env, home) });
}
