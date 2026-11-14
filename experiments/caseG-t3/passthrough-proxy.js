import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeKeychainServiceName } from '../../src/claude-keychain.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IN_TEST = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
const MAX_BYTES = 1024 * 1024;
const MODES = new Set(['passthrough', 'swap-messages']);
const failure = () => new Error('Prototype configuration or operation unavailable');
const within = (path, root) => {
  const rel = relative(root.toLowerCase(), path.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function homePaths(env) {
  return [...new Set([env.HOME, userInfo().homedir].filter(Boolean).map(p => resolve(normalize(p))))];
}

function checkPath(path, env, extraHomes = []) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.length > 4096) throw failure();
  const normalized = resolve(normalize(path));
  const homes = new Set([...homePaths(env), ...extraHomes]);
  const forbidden = [...homes].flatMap(home => [
    join(home, '.claude'), join(home, '.claude.json'), join(home, '.config/claude-rotator'),
  ]);
  if (env.XDG_CONFIG_HOME) forbidden.push(join(resolve(env.XDG_CONFIG_HOME), 'claude-rotator'));
  if (forbidden.some(root => within(normalized, root)) || within(normalized, REPO)) throw failure();
  return normalized;
}

// The lexical gate runs before any filesystem call, including home canonicalization.
export async function safeExternalPath(path, env = process.env, fsOps = filesystem) {
  const lexical = checkPath(path, env);
  const canonicalize = async candidate => {
    checkPath(candidate, env);
    try { return checkPath(await fsOps.realpath(candidate), env); } catch (error) {
      if (error.code !== 'ENOENT' || dirname(candidate) === candidate) throw failure();
      return checkPath(join(await canonicalize(dirname(candidate)), basename(candidate)), env);
    }
  };
  const canonical = await canonicalize(lexical);
  const homes = [];
  for (const home of homePaths(env)) {
    try { homes.push(await fsOps.realpath(home)); } catch (error) {
      if (error.code !== 'ENOENT') throw failure();
    }
  }
  return checkPath(canonical, env, homes);
}

// Darwin's O_NOFOLLOW_ANY (sys/fcntl.h) rejects symlinks in every component
// atomically. Linux instead traverses pinned directory descriptors from root.
export async function openExternalFile(path, {
  env = process.env, fsOps = filesystem, flags = constants.O_RDONLY, mode,
} = {}) {
  const canonical = await safeExternalPath(path, env, fsOps);
  if (process.platform === 'darwin') {
    try {
      // Darwin rejects combining O_NOFOLLOW_ANY with O_NOFOLLOW.
      return await fsOps.open(canonical, (flags & ~constants.O_NOFOLLOW) | 0x20000000 | constants.O_NONBLOCK, mode);
    } catch { throw failure(); }
  }
  if (process.platform !== 'linux') throw failure();
  const pieces = canonical.split(sep).filter(Boolean);
  if (!pieces.length || constants.O_DIRECTORY === undefined) throw failure();
  const directories = [];
  const fdRoot = '/proc/self/fd';
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let directory = await fsOps.open(sep, directoryFlags);
    directories.push(directory);
    for (const piece of pieces.slice(0, -1)) {
      directory = await fsOps.open(`${fdRoot}/${directory.fd}/${piece}`, directoryFlags);
      directories.push(directory);
    }
    return await fsOps.open(`${fdRoot}/${directory.fd}/${pieces.at(-1)}`,
      flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
  } catch { throw failure(); } finally {
    await Promise.allSettled(directories.reverse().map(directory => directory.close()));
  }
}

export function isTestRuntime() { return IN_TEST; }

function knownKeys(object, keys) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).some(key => !keys.includes(key))) throw failure();
}

export async function validateAccount(account, env = process.env, fsOps = filesystem) {
  knownKeys(account, ['configDir', 'service', 'acct', 'keychainPath', 'keychainAllowlist']);
  if (typeof env.USER !== 'string' || !env.USER.trim() || account.acct !== env.USER
    || /[\0\r\n]/.test(account.acct)
    || typeof account.service !== 'string'
    || !/^Claude Code-credentials-[0-9a-f]{8}$/.test(account.service)
    || account.service !== claudeKeychainServiceName(account.configDir)) throw failure();
  if (!Array.isArray(account.keychainAllowlist) || !account.keychainAllowlist.length) throw failure();
  checkPath(account.configDir, env);
  checkPath(account.keychainPath, env);
  for (const allowed of account.keychainAllowlist) checkPath(allowed, env);
  const keychainPath = await safeExternalPath(account.keychainPath, env, fsOps);
  const keychainAllowlist = [];
  for (const allowed of account.keychainAllowlist) keychainAllowlist.push(await safeExternalPath(allowed, env, fsOps));
  if (!keychainAllowlist.includes(keychainPath)) throw failure();
  const handle = await openExternalFile(account.configDir,
    { env, fsOps, flags: constants.O_RDONLY | constants.O_DIRECTORY });
  try { if (!(await handle.stat()).isDirectory()) throw failure(); } finally { await handle.close(); }
  // Derive the service from the supplied spelling, as Claude Code does.
  return Object.freeze({ configDir: account.configDir, service: account.service, acct: account.acct,
    keychainPath, keychainAllowlist: Object.freeze(keychainAllowlist) });
}

export async function loadConfig(configFile, { env = process.env, fsOps = filesystem } = {}) {
  try {
    if (typeof env.USER !== 'string' || !env.USER.trim()) throw failure();
    const path = await safeExternalPath(configFile, env, fsOps);
    const handle = await openExternalFile(path, { env, fsOps });
    let config;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw failure();
      config = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    knownKeys(config, ['logPath', 'swapAccount', 'expiryMarginMs', 'timeoutMs']);
    const logPath = await safeExternalPath(config.logPath, env, fsOps);
    if (logPath === path || logPath === config.swapAccount?.configDir) throw failure();
    const expiryMarginMs = config.expiryMarginMs ?? 300000;
    const timeoutMs = config.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(expiryMarginMs) || expiryMarginMs < 0
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw failure();
    const swapAccount = config.swapAccount ? await validateAccount(config.swapAccount, env, fsOps) : null;
    if (swapAccount && within(logPath, await safeExternalPath(swapAccount.configDir, env, fsOps))) throw failure();
    if (swapAccount?.keychainAllowlist.includes(logPath)) throw failure();
    return Object.freeze({ logPath, swapAccount, expiryMarginMs, timeoutMs });
  } catch { throw failure(); }
}

export function validateMode(mode) {
  if (!MODES.has(mode)) throw failure();
}

// No original parser exception, JSON, refresh field, or raw storage result escapes this boundary.
export function projectCredentials(raw, modifiedAt) {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw failure();
    const parsed = JSON.parse(raw, (key, value) => /refresh/i.test(key) ? undefined : value);
    const data = parsed?.claudeAiOauth ?? parsed;
    if (!data || typeof data.accessToken !== 'string' || !data.accessToken
      || !/^[\x21-\x7e]+$/.test(data.accessToken)
      || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= 0
      || !Number.isSafeInteger(modifiedAt) || modifiedAt < 0) throw failure();
    return { accessToken: data.accessToken, expiresAt: data.expiresAt, modifiedAt };
  } catch { throw failure(); }
}

function securityRead(args) {
  return new Promise((resolveResult, reject) => {
    execFile('/usr/bin/security', args, { encoding: 'utf8', timeout: 10000, maxBuffer: MAX_BYTES },
      (error, stdout, stderr) => {
        if (error?.code === 44 && args[0] === 'find-generic-password' && !args.includes('-w')) resolveResult({ found: false });
        else if (error) reject(failure());
        else resolveResult({ stdout, stderr });
      });
  });
}

function modificationTime(raw) {
  const match = /"mdat"<timedate>=[^\n]*?"(\d{14})Z/.exec(raw);
  if (!match) throw failure();
  const v = match[1];
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`;
  const time = Date.parse(iso);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString().slice(0, 19) !== iso.slice(0, 19)) throw failure();
  return time;
}

export function createKeychainStore() {
  const scoped = scopedKeychainStore(securityRead, process.env, filesystem);
  return Object.freeze({ async read(identity) {
    if (IN_TEST || process.env.NODE_TEST_CONTEXT || process.platform !== 'darwin') throw failure();
    return scoped.read(identity);
  } });
}

export function createScopedKeychainStore(backend, { env = process.env, fsOps = filesystem } = {}) {
  if (!IN_TEST || typeof backend?.run !== 'function') throw failure();
  return scopedKeychainStore(args => backend.run(args), env, fsOps);
}

function scopedKeychainStore(run, env, fsOps) {
  let pinned = null;
  let stopped = false;
  const output = result => {
    if (typeof result?.stdout !== 'string' || typeof result?.stderr !== 'string') throw failure();
    return result.stdout + result.stderr;
  };
  async function scan(scope) {
    const listed = output(await run(['list-keychains'])).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const paths = [];
    for (const line of listed) paths.push(await safeExternalPath(JSON.parse(line), env, fsOps));
    if (new Set(paths).size !== paths.length || !paths.includes(scope.keychainPath)) throw failure();
    const matches = [];
    for (const path of paths) {
      const result = await run(['find-generic-password', '-a', scope.acct, '-s', scope.service, path]);
      if (result?.found === false) continue;
      const raw = output(result);
      const declared = /^keychain:\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(raw);
      if (!declared || await safeExternalPath(JSON.parse(declared[1]), env, fsOps) !== path) throw failure();
      matches.push({ path, modifiedAt: modificationTime(raw) });
    }
    if (matches.length !== 1 || matches[0].path !== scope.keychainPath) throw failure();
    return { paths: paths.sort(), modifiedAt: matches[0].modifiedAt };
  }
  return Object.freeze({ async read(identity) {
    if (stopped) throw failure();
    try {
      const scope = await validateAccount(identity, env, fsOps);
      if (pinned && ['configDir', 'service', 'acct', 'keychainPath'].some(key => scope[key] !== pinned[key])) throw failure();
      pinned ||= scope;
      const before = await scan(scope);
      const projected = projectCredentials((await run([
        'find-generic-password', '-a', scope.acct, '-s', scope.service, '-w', scope.keychainPath,
      ])).stdout, before.modifiedAt);
      const after = await scan(scope);
      if (before.modifiedAt !== after.modifiedAt || before.paths.length !== after.paths.length
        || before.paths.some((path, index) => path !== after.paths[index])) throw failure();
      return projected;
    } catch { stopped = true; throw failure(); }
  } });
}

export async function runCli(argv, {
  env = process.env, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text),
} = {}) {
  try {
    if (env.CASEG_PROTO_ENABLE !== '1') throw failure();
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (!['--mode', '--config', '--apply', '--port'].includes(flag) || flag in flags) throw failure();
      flags[flag] = flag === '--apply' ? true : argv[++i];
      if (flags[flag] === undefined) throw failure();
    }
    validateMode(flags['--mode']);
    if (flags['--port'] !== undefined && flags['--port'] !== '37991') throw failure();
    const config = await loadConfig(flags['--config'], { env });
    if (flags['--mode'] === 'swap-messages' && !config.swapAccount) throw failure();
    if (!flags['--apply']) {
      stdout('dry-run: would listen on 127.0.0.1:37991 and append request metadata; no changes made\n');
      return 0;
    }
    // The command line has no upstream injection route.
    const { createProxy } = await import('./proxy-core.js');
    const proxy = await createProxy({ configFile: flags['--config'], env, mode: flags['--mode'], apply: true });
    await proxy.listen();
    stdout('started requests=0\n');
    const stop = () => { void proxy.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try { await proxy.closed; } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    stdout(`stopped requests=${proxy.count()}\n`);
    return proxy.failed() ? 1 : 0;
  } catch {
    stderr('Prototype refused or unavailable\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
