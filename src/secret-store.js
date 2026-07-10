import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { linuxAccountsDir } from './paths.js';
import { writeJsonFile } from './json-file.js';

const execFileAsync = promisify(execFile);
const ID_RE = /^[A-Za-z0-9._@-]+$/;
const KEYCHAIN_SERVICE_PREFIX = 'claude-rotator';

function assertSafeAccountId(accountId) {
  if (!ID_RE.test(accountId)) {
    throw new Error(`Invalid account id: ${accountId}`);
  }
}

export class MemorySecretStore {
  constructor() {
    this.items = new Map();
  }

  async set(accountId, secret) {
    assertSafeAccountId(accountId);
    this.items.set(accountId, JSON.parse(JSON.stringify(secret)));
  }

  async get(accountId) {
    assertSafeAccountId(accountId);
    const value = this.items.get(accountId);
    return value ? JSON.parse(JSON.stringify(value)) : null;
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
  constructor({ accountsDir = linuxAccountsDir() } = {}) {
    this.accountsDir = accountsDir;
  }

  secretPath(accountId) {
    assertSafeAccountId(accountId);
    return join(this.accountsDir, `${accountId}.json`);
  }

  async set(accountId, secret) {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
    await writeJsonFile(this.secretPath(accountId), secret, 0o600);
  }

  async get(accountId) {
    try {
      return JSON.parse(await readFile(this.secretPath(accountId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(accountId) {
    await rm(this.secretPath(accountId), { force: true });
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
    await rm(this.accountsDir, { recursive: true, force: true });
  }
}

export class MacOSKeychainSecretStore {
  serviceName(accountId) {
    assertSafeAccountId(accountId);
    return `${KEYCHAIN_SERVICE_PREFIX}:${accountId}`;
  }

  async set(accountId, secret) {
    const payload = JSON.stringify(secret);
    await execFileAsync('security', [
      'add-generic-password',
      '-a', accountId,
      '-s', this.serviceName(accountId),
      '-w', payload,
      '-U',
    ]);
  }

  async get(accountId) {
    try {
      const { stdout } = await execFileAsync('security', [
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
    await execFileAsync('security', [
      'delete-generic-password',
      '-a', accountId,
      '-s', this.serviceName(accountId),
    ]).catch(error => {
      if (error.code === 44 || /could not be found|not found/i.test(error.stderr || '')) return;
      throw error;
    });
  }

  async list() {
    return [];
  }

  async purge(accountIds = []) {
    await Promise.all(accountIds.map(id => this.delete(id)));
  }
}

export function createSecretStore({ platform = process.platform, env = process.env, home } = {}) {
  if (platform === 'darwin') return new MacOSKeychainSecretStore();
  if (platform === 'linux') {
    return new LinuxFileSecretStore({ accountsDir: linuxAccountsDir(env, home) });
  }
  return new LinuxFileSecretStore({ accountsDir: linuxAccountsDir(env, home) });
}
