import { constants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { claudeKeychainServiceName } from '../../src/claude-keychain.js';

const CODES = new Set(['DISABLED', 'CONFIG_REQUIRED', 'INVALID_CONFIG', 'UNSAFE_PATH',
  'INVALID_COMMAND', 'LOCKED', 'HUMAN_REVIEW', 'SOURCE_CONSUMED', 'INITIAL_IMPORT_REQUIRED',
  'INITIAL_MISMATCH', 'MISSING_ITEM', 'VAULT_OCCUPIED', 'EXPIRY_UNSAFE', 'LANE_CONFLICT',
  'LANE_CHANGED', 'METADATA_CONFLICT', 'VERIFY_FAILED', 'R8_SUSPECTED', 'TEST_CONTEXT',
  'KEYCHAIN_FAILED', 'OPERATION_FAILED']);

export class TrialError extends Error {
  constructor(code) {
    super(CODES.has(code) ? code : 'OPERATION_FAILED');
    this.code = this.message;
  }
}
export function fail(code) { throw new TrialError(code); }
export function safeError(error) {
  return error instanceof TrialError ? new TrialError(error.code) : new TrialError('OPERATION_FAILED');
}
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const inside = (path, root) => path === root || (!relative(root, path).startsWith('../')
  && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const validConfigs = new WeakSet();

export function assertConfig(config) {
  if (!validConfigs.has(config)) fail('INVALID_CONFIG');
}

function absolute(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f]/.test(path)) fail('UNSAFE_PATH');
  return path;
}

function forbidden(path, env) {
  const homes = [resolve(userInfo().homedir), resolve(absolute(env.HOME))];
  const roots = homes.flatMap(home => [join(home, '.claude'), join(home, '.config', 'claude-rotator'),
    join(home, '.local', 'state', 'claude-rotator'), join(home, '.local', 'share', 'claude-rotator')]);
  for (const [key, suffix] of [['XDG_CONFIG_HOME', 'claude-rotator'], ['XDG_STATE_HOME', 'claude-rotator'], ['XDG_DATA_HOME', 'claude-rotator']]) {
    if (env[key]) roots.push(join(absolute(env[key]), suffix));
  }
  const compare = value => process.platform === 'darwin' ? value.toLowerCase() : value;
  if (homes.some(home => compare(path) === compare(join(home, '.claude.json')))
    || roots.some(root => inside(compare(path), compare(root)))) fail('UNSAFE_PATH');
}

/** All filesystem entry points share the same lexical guard and injectable backend. */
export function createFileAccess(env, { fs = defaultFs } = {}) {
  function check(path) {
    if (typeof path !== 'string' || /[\x00-\x1f]/.test(path)) fail('UNSAFE_PATH');
    forbidden(normalize(resolve(path)), env);
    return absolute(path);
  }

async function directory(path) {
  check(path);
  let current = parse(path).root;
  for (const component of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH');
  }
  const stat = await fs.lstat(path);
  const canonical = await fs.realpath(path);
  check(canonical);
  if (stat.uid !== process.getuid() || canonical !== path) fail('UNSAFE_PATH');
}

async function fileInfo(path, { optional = false, privateFile = false } = {}) {
  check(path);
  await directory(dirname(path));
  let stat;
  try { stat = await fs.lstat(path); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1
    || (privateFile && (stat.mode & 0o777) !== 0o600)) fail('UNSAFE_PATH');
  const canonical = await fs.realpath(path);
  check(canonical);
  if (canonical !== path) fail('UNSAFE_PATH');
  return stat;
}

async function readText(path, { optional = false, privateFile = false } = {}) {
  if (!await fileInfo(path, { optional, privateFile })) return null;
  const handle = await fs.open(check(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('UNSAFE_PATH');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function atomicWrite(path, text, { expected } = {}) {
  await fileInfo(path, { optional: true });
  const temporary = join(dirname(path), `.trial-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(check(temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await fileInfo(path, { optional: true });
    if (expected !== undefined && await readText(path, { optional: true }) !== expected) fail('METADATA_CONFLICT');
    await fs.rename(check(temporary), check(path));
    const parent = await fs.open(check(dirname(path)), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    if (handle) await handle.close();
    await fs.unlink(check(temporary)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

  return Object.freeze({ check, directory, fileInfo, readText, atomicWrite,
    open: async (path, ...args) => {
      check(path); await directory(dirname(path));
      return fs.open(path, ...args);
    },
    unlink: async path => {
      check(path); await directory(dirname(path));
      return fs.unlink(path);
    },
  });
}

export function json(raw) {
  try { return JSON.parse(raw); } catch { fail('OPERATION_FAILED'); }
}

export async function loadConfig(configPath, env, { fs } = {}) {
  if (env.CASEG_PROTO_ENABLE !== '1') fail('DISABLED');
  if (!configPath) fail('CONFIG_REQUIRED');
  if (!env.USER || !env.HOME) fail('INVALID_CONFIG');
  const files = createFileAccess(env, { fs });
  const { check, readText, directory, fileInfo } = files;
  check(configPath);
  if (inside(configPath, repoRoot)) fail('UNSAFE_PATH');
  const data = json(await readText(configPath));
  if (!object(data) || !object(data.lane) || !object(data.accounts)
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(data.acct || '') || data.acct !== env.USER) fail('INVALID_CONFIG');
  const labels = Object.keys(data.accounts);
  if (labels.length < 2 || labels.some(label => !/^[A-Za-z0-9_-]{1,48}$/.test(label)
    || label.startsWith('quarantine-') || ['__proto__', 'constructor', 'prototype'].includes(label))
    || !labels.includes(data.initialAccount)) fail('INVALID_CONFIG');
  const paths = [data.lane.dir, data.trialDir, ...labels.map(label => data.accounts[label]?.sourceDir)];
  for (const path of paths) check(path);
  const sourceDirs = labels.map(label => data.accounts[label]?.sourceDir);
  if (new Set(sourceDirs).size !== sourceDirs.length || sourceDirs.includes(data.trialDir)
    || data.lane.dir === data.trialDir || labels.some(label => label !== data.initialAccount
      && data.accounts[label]?.sourceDir === data.lane.dir)) fail('INVALID_CONFIG');
  const service = (name, dir) => {
    if (!/^Claude Code-credentials-[0-9a-f]{8}$/.test(name || '') || name !== claudeKeychainServiceName(dir)) fail('INVALID_CONFIG');
  };
  service(data.lane.service, data.lane.dir);
  const accounts = {};
  for (const label of labels) {
    const source = data.accounts[label];
    if (!object(source)) fail('INVALID_CONFIG');
    service(source.sourceService, source.sourceDir);
    if (source.vaultService !== `caseG-T1-vault-${label}`) fail('INVALID_CONFIG');
    accounts[label] = Object.freeze({ sourceDir: source.sourceDir, sourceService: source.sourceService, vaultService: source.vaultService });
  }
  const services = [data.lane.service, ...Object.entries(accounts).filter(([label, account]) =>
    label !== data.initialAccount || account.sourceDir !== data.lane.dir).map(([, account]) => account.sourceService)];
  if (new Set(services).size !== services.length) fail('INVALID_CONFIG');
  const config = {
    lane: Object.freeze({ dir: data.lane.dir, service: data.lane.service }), accounts: Object.freeze(accounts),
    initialAccount: data.initialAccount, acct: data.acct, trialDir: data.trialDir,
    ledgerPath: data.ledgerPath, logPath: data.logPath,
    journalPath: join(data.trialDir, 'journal.json'), lockPath: join(data.lane.dir, '.caseg-t1.lock'),
    marginMs: data.marginMs ?? 1_800_000, watchMs: data.watchMs ?? 120_000, pollMs: data.pollMs ?? 1000,
    files,
  };
  if (![config.marginMs, config.watchMs, config.pollMs].every(value => Number.isSafeInteger(value) && value > 0)
    || config.marginMs < 1_800_000 || config.watchMs < 60_000 || config.pollMs < 1000
    || config.watchMs >= config.marginMs || config.pollMs > config.watchMs) fail('INVALID_CONFIG');
  const statePaths = [config.ledgerPath, config.logPath, config.journalPath];
  for (const path of statePaths) {
    check(path);
    if (dirname(path) !== data.trialDir || path.endsWith('/.claude.json')) fail('UNSAFE_PATH');
  }
  if (new Set(statePaths).size !== statePaths.length) fail('INVALID_CONFIG');
  // Check every derived path before any configured directory is inspected.
  for (const dir of [data.lane.dir, ...Object.values(accounts).map(account => account.sourceDir)]) {
    check(join(dir, '.claude.json'));
  }
  check(config.lockPath);
  for (const path of paths) await directory(path);
  for (const dir of [data.lane.dir, ...Object.values(accounts).map(account => account.sourceDir)]) {
    await fileInfo(join(dir, '.claude.json'));
  }
  for (const path of statePaths) await fileInfo(path, { optional: true, privateFile: true });
  Object.freeze(config);
  validConfigs.add(config);
  return config;
}
