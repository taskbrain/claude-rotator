import { execFile } from 'node:child_process';
import { assertConfig, fail } from './safety.js';

/** Store contract: attributes(service) -> {exists, updatedAt}; read(service) -> string;
 * write(service, string, {expectedUpdatedAt}?) -> {written, beforeUpdatedAt, updatedAt}.
 * Values and raw subprocess errors never cross diagnostics. */
export class MemoryStore {
  constructor({ fixedUpdatedAt = null } = {}) { this.entries = new Map(); this.calls = []; this.sequence = 0; this.before = null; this.fixedUpdatedAt = fixedUpdatedAt; }
  seed(service, value) { this.entries.set(service, { value, updatedAt: this.fixedUpdatedAt ?? String(++this.sequence) }); }
  async invoke(operation, service) {
    this.calls.push({ operation, service });
    if (this.before) await this.before(operation, service);
  }
  async attributes(service) {
    await this.invoke('attributes', service);
    const item = this.entries.get(service);
    return { exists: !!item, updatedAt: item?.updatedAt ?? null };
  }
  async read(service) {
    await this.invoke('read', service);
    if (!this.entries.has(service)) fail('MISSING_ITEM');
    return this.entries.get(service).value;
  }
  async write(service, value, { expectedUpdatedAt } = {}) {
    await this.invoke('write', service);
    const before = await this.attributes(service);
    if (expectedUpdatedAt !== undefined && before.updatedAt !== expectedUpdatedAt) {
      return { written: false, beforeUpdatedAt: before.updatedAt, updatedAt: before.updatedAt };
    }
    if (this.beforeCommit) await this.beforeCommit(service);
    this.seed(service, value);
    const after = await this.attributes(service);
    return { written: true, beforeUpdatedAt: before.updatedAt, updatedAt: after.updatedAt };
  }
}

function testGuard() {
  if (process.env.NODE_TEST_CONTEXT !== undefined || process.env.NODE_ENV === 'test'
    || process.env.JEST_WORKER_ID !== undefined || process.env.VITEST !== undefined
    || process.execArgv.some(arg => arg === '--test' || arg.startsWith('--test-'))) fail('TEST_CONTEXT');
  if (process.platform !== 'darwin') fail('KEYCHAIN_FAILED');
}

// This is the security tool's interactive command language, never shell syntax.
export function writeRequest(service, acct, value) {
  if (!/^(?:Claude Code-credentials-[0-9a-f]{8}|caseG-T1-vault-[A-Za-z0-9_-]+)$/.test(service)
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(acct) || typeof value !== 'string' || value.length > 1024 * 1024) fail('INVALID_CONFIG');
  return { args: ['-i'], input: `add-generic-password -U -a "${acct}" -s "${service}" -X "${Buffer.from(value, 'utf8').toString('hex')}"\n` };
}

export function parseAttributes(result) {
  const modified = result.match(/"mdat"<timedate>=0x([0-9A-Fa-f]+)/);
  if (!modified || modified[1].length % 2 !== 0) fail('KEYCHAIN_FAILED');
  const timestamp = Buffer.from(modified[1], 'hex').toString('utf8').replace(/\0+$/, '');
  if (!/^\d{14}Z$/.test(timestamp)) fail('KEYCHAIN_FAILED');
  return { exists: true, updatedAt: timestamp };
}

function execute(args, input) {
  testGuard();
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', args, {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024, shell: false,
    }, (error, stdout) => {
      if (error) {
        // Keep only the numeric not-found result. Never forward Error.cmd/stderr.
        if (error.code === 44) resolve(null);
        else reject(new Error('KEYCHAIN_FAILED'));
      } else resolve(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export class MacOSStore {
  #config;
  #allowed;
  constructor(config) {
    testGuard(); assertConfig(config);
    this.#config = config;
    this.#allowed = new Set([config.lane.service, ...Object.values(config.accounts).flatMap(account => [account.sourceService, account.vaultService])]);
  }
  check(service) {
    testGuard();
    if (!this.#allowed.has(service) && !/^caseG-T1-vault-quarantine-\d{16}$/.test(service)) fail('INVALID_CONFIG');
  }
  async attributes(service) {
    this.check(service);
    const result = await execute(['find-generic-password', '-a', this.#config.acct, '-s', service]);
    if (result === null) return { exists: false, updatedAt: null };
    return parseAttributes(result);
  }
  async read(service) {
    this.check(service);
    const result = await execute(['find-generic-password', '-a', this.#config.acct, '-s', service, '-w']);
    if (result === null) fail('MISSING_ITEM');
    return result.replace(/\r?\n$/, '');
  }
  async write(service, value, { expectedUpdatedAt } = {}) {
    this.check(service);
    const before = await this.attributes(service);
    if (expectedUpdatedAt !== undefined && before.updatedAt !== expectedUpdatedAt) {
      return { written: false, beforeUpdatedAt: before.updatedAt, updatedAt: before.updatedAt };
    }
    const request = writeRequest(service, this.#config.acct, value);
    await execute(request.args, request.input);
    const after = await this.attributes(service);
    return { written: true, beforeUpdatedAt: before.updatedAt, updatedAt: after.updatedAt };
  }
}
