#!/usr/bin/env node
// Test-only helper for the caseG T4/T5 runbooks. It is not part of the shipped package (src/ is untouched).
//
// What it reads: one macOS Keychain item, scoped by service name, acct and keychain path, after checking
// that exactly one such item exists across the search list. What it prints: at most three lines —
//   withinMargin=<true|false>   whether the access token expires within 5 minutes
//   deltaMin=<none|+N|-N>        how many minutes the expiry moved since the previous run
//   remainingMin10=<N>           minutes until expiry, rounded to 10, printed only right after a refresh
//                                (that is, only when the expiry moved forward since the previous run)
// It never prints, logs, stores or throws the token, the credential JSON or the expiry time itself.
// On any problem it prints a fixed reason code and exits 2.
//
// It never writes to the Keychain and never refreshes anything. The only file it writes is the state file
// inside the run directory given on the command line: one JSON line, mode 0600, holding the service name,
// acct, keychain path and the previous expiry number (no token, no credential). A state file written for a
// different item stops the helper with reason state-mismatch; --clear-state removes it at the end of a run.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARGIN_MS = 5 * 60 * 1000;
const MAX_BYTES = 64 * 1024;
const SERVICE_PREFIX = 'Claude Code-credentials';
const SECURITY = '/usr/bin/security';
const ALLOWED_SECURITY_COMMANDS = new Set(['list-keychains', 'find-generic-password']);

// Every failure carries one of these codes and nothing else.
export const REASONS = Object.freeze(['args', 'scope', 'search-list', 'not-unique', 'read', 'shape',
  'changed', 'state', 'state-mismatch', 'environment']);

export class HelperStop extends Error {
  constructor(reason) {
    super(`expiry-helper stopped: ${REASONS.includes(reason) ? reason : 'args'}`);
    this.reason = REASONS.includes(reason) ? reason : 'args';
  }
}
const stop = reason => new HelperStop(reason);

export function serviceNameFor(configDir) {
  const suffix = createHash('sha256').update(String(configDir).normalize('NFC')).digest('hex').slice(0, 8);
  return `${SERVICE_PREFIX}-${suffix}`;
}

function insideTestRuntime(env) {
  return Boolean(env.NODE_TEST_CONTEXT) || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.execArgv.some(arg => arg.startsWith('--test'));
}

// The real backend. Refuses to run under the test runner or off macOS, accepts only read commands,
// and never forwards the raw error (stderr or message may echo arguments).
export function createSecurityBackend({ env = process.env, platform = process.platform } = {}) {
  return Object.freeze({
    run(args) {
      if (insideTestRuntime(env) || platform !== 'darwin') return Promise.reject(stop('environment'));
      assertReadOnly(args);
      return new Promise((resolveResult, reject) => {
        execFile(SECURITY, args, { encoding: 'utf8', timeout: 15000, maxBuffer: MAX_BYTES,
          env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: env.HOME ?? '' } },
        (error, stdout, stderr) => {
          if (error?.code === 44 && args[0] === 'find-generic-password' && !args.includes('-w')) {
            resolveResult({ found: false });
          } else if (error) {
            reject(stop('read'));
          } else {
            resolveResult({ stdout, stderr });
          }
        });
      });
    },
  });
}

export function assertReadOnly(args) {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw stop('args');
  if (!ALLOWED_SECURITY_COMMANDS.has(args[0])) throw stop('args');
  // -g prints the password with the attributes; -w is allowed only in the single scoped read below.
  if (args.includes('-g')) throw stop('args');
}

function parseKeychainLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    if (typeof value !== 'string' || !isAbsolute(value)) throw stop('search-list');
    return value;
  } catch { throw stop('search-list'); }
}

function outputOf(result) {
  if (typeof result?.stdout !== 'string' || typeof result?.stderr !== 'string') throw stop('read');
  return result.stdout + result.stderr;
}

export function modificationTime(raw) {
  const match = /"mdat"<timedate>=[^\n]*?"(\d{14})Z/.exec(raw);
  if (!match) throw stop('shape');
  const v = match[1];
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`;
  const time = Date.parse(iso);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString().slice(0, 19) !== iso.slice(0, 19)) throw stop('shape');
  return time;
}

// Keeps only the expiry number. The reviver drops every other key while parsing, so the parsed object
// never holds the access token or the refresh token. The raw string is still in memory until it is released.
export function projectExpiry(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw stop('shape');
  let parsed;
  try {
    parsed = JSON.parse(raw.trim(), function reviver(key, value) {
      if (key === '' || key === 'claudeAiOauth' || key === 'expiresAt') return value;
      return undefined;
    });
  } catch { throw stop('shape'); }
  const data = parsed && typeof parsed === 'object' ? (parsed.claudeAiOauth ?? parsed) : null;
  const expiresAt = data?.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw stop('shape');
  return expiresAt;
}

async function scan(run, scope) {
  const listed = outputOf(await run(['list-keychains'])).split(/\r?\n/).map(parseKeychainLine).filter(Boolean);
  if (new Set(listed).size !== listed.length || !listed.includes(scope.keychainPath)) throw stop('search-list');
  const matches = [];
  for (const path of listed) {
    const result = await run(['find-generic-password', '-a', scope.acct, '-s', scope.service, path]);
    if (result?.found === false) continue;
    const raw = outputOf(result);
    const declared = /^keychain:\s*("(?:[^"\\]|\\.)*")\s*$/m.exec(raw);
    let declaredPath;
    try { declaredPath = declared ? JSON.parse(declared[1]) : null; } catch { declaredPath = null; }
    if (declaredPath !== path) throw stop('not-unique');
    const svce = /"svce"<blob>="((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
    const acct = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
    if (svce !== scope.service || acct !== scope.acct) throw stop('not-unique');
    matches.push({ path, modifiedAt: modificationTime(raw) });
  }
  if (matches.length !== 1 || matches[0].path !== scope.keychainPath) throw stop('not-unique');
  return { paths: [...listed].sort(), modifiedAt: matches[0].modifiedAt };
}

// Reads the expiry of exactly one scoped item. Scans before and after the read and stops if the item
// changed in between (another writer refreshed it), so the number always belongs to the scanned item.
export async function readScopedExpiry(run, scope) {
  const before = await scan(run, scope);
  let result = await run(['find-generic-password', '-a', scope.acct, '-s', scope.service, '-w', scope.keychainPath]);
  if (typeof result?.stdout !== 'string') { result = null; throw stop('read'); }
  let expiresAt;
  try { expiresAt = projectExpiry(result.stdout); } finally { result = null; }
  const after = await scan(run, scope);
  if (before.modifiedAt !== after.modifiedAt || before.paths.join('\n') !== after.paths.join('\n')) throw stop('changed');
  return expiresAt;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Checks where the state file may live: directly inside the run directory, which must be a real
// directory outside the rotator's config, the account folder, ~/.claude and the Keychain folder.
export async function validateStateLocation({ runDir, stateFile, configDir = null },
  { env = process.env, fsOps = { realpath, lstat } } = {}) {
  for (const value of [runDir, stateFile]) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw stop('args');
  }
  const run = resolve(runDir);
  const state = resolve(stateFile);
  if (dirname(state) !== run || !/^[A-Za-z0-9._-]{1,64}$/.test(state.slice(run.length + 1))) throw stop('state');
  let realRun;
  try {
    realRun = await fsOps.realpath(run);
    const info = await fsOps.lstat(run);
    if (!info.isDirectory()) throw stop('state');
  } catch { throw stop('state'); }
  const home = env.HOME || homedir();
  const forbidden = [join(home, '.config', 'claude-rotator'), join(home, '.claude'), join(home, 'Library', 'Keychains')];
  if (env.XDG_CONFIG_HOME) forbidden.push(join(env.XDG_CONFIG_HOME, 'claude-rotator'));
  if (configDir) forbidden.push(resolve(configDir));
  for (const bad of forbidden) {
    for (const candidate of [run, realRun]) {
      if (candidate === bad || isWithin(bad, candidate) || isWithin(candidate, bad)) throw stop('state');
    }
  }
  return { runDir: run, stateFile: state };
}

// Validates the command-line scope and the state file location without touching the Keychain.
export async function validateScope(options, { env = process.env, fsOps } = {}) {
  const { configDir, service, acct, keychainPath } = options;
  for (const value of [configDir, keychainPath]) {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) throw stop('args');
  }
  if (typeof acct !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(acct)) throw stop('args');
  if (typeof service !== 'string' || service !== serviceNameFor(configDir)) throw stop('scope');
  if (!keychainPath.endsWith('.keychain-db') && !keychainPath.endsWith('.keychain')) throw stop('scope');
  const location = await validateStateLocation({ runDir: options.runDir, stateFile: options.stateFile, configDir },
    fsOps ? { env, fsOps } : { env });
  return Object.freeze({ configDir, service, acct, keychainPath, ...location });
}

// The state file holds the previous expiry bound to the item it came from: one JSON line with the service
// name, acct, keychain path and the expiry number (no token, no credential). It must be a regular file owned
// by this user with mode 0600 and a single link; anything else stops the helper. A state written for a
// different item stops the helper with reason state-mismatch instead of being compared.
const STATE_VERSION = 1;
const STATE_KEYS = ['v', 'service', 'acct', 'keychain', 'expiresAt'];

export async function readState(stateFile, scope) {
  let handle;
  try {
    handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw stop('state');
  }
  let record;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600
      || (process.getuid && info.uid !== process.getuid()) || info.size > 4096) throw stop('state');
    record = JSON.parse(await handle.readFile({ encoding: 'utf8' }));
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== [...STATE_KEYS].sort().join(',')
      || record.v !== STATE_VERSION || typeof record.service !== 'string' || typeof record.acct !== 'string'
      || typeof record.keychain !== 'string' || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) {
      throw stop('state');
    }
  } catch { throw stop('state'); } finally { await handle.close(); }
  if (record.service !== scope.service || record.acct !== scope.acct || record.keychain !== scope.keychainPath) {
    throw stop('state-mismatch');
  }
  return record.expiresAt;
}

const tempPathFor = stateFile => `${stateFile}.tmp`;

// Removes a temp file left by an interrupted earlier run (only a regular file at the fixed temp path).
async function removeStaleTemp(stateFile) {
  const temp = tempPathFor(stateFile);
  try {
    const info = await lstat(temp);
    if (!info.isFile()) throw stop('state');
    await unlink(temp);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw stop('state');
  }
}

export async function writeState(stateFile, scope, expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw stop('state');
  const body = `${JSON.stringify({ v: STATE_VERSION, service: scope.service, acct: scope.acct,
    keychain: scope.keychainPath, expiresAt })}\n`;
  await removeStaleTemp(stateFile);
  const temp = tempPathFor(stateFile);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(body, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, stateFile);
  } catch {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw stop('state');
  }
}

export async function clearState(stateFile) {
  try { await unlink(stateFile); } catch (error) { if (error?.code !== 'ENOENT') throw stop('state'); }
  await removeStaleTemp(stateFile);
}

// Pure: turns two expiry numbers into the three allowed outputs.
export function summarize({ expiresAt, previous, now }) {
  const lines = [`withinMargin=${expiresAt <= now + MARGIN_MS}`];
  if (previous == null) {
    lines.push('deltaMin=none');
  } else {
    const delta = Math.round((expiresAt - previous) / 60000);
    lines.push(`deltaMin=${delta >= 0 ? '+' : ''}${delta}`);
    if (delta > 0) {
      const remaining = Math.max(0, Math.round((expiresAt - now) / 600000) * 10);
      lines.push(`remainingMin10=${remaining}`);
    }
  }
  return lines;
}

const FLAGS = new Map([
  ['--config-dir', 'configDir'], ['--service', 'service'], ['--acct', 'acct'], ['--keychain', 'keychainPath'],
  ['--run-dir', 'runDir'], ['--state', 'stateFile'],
]);

export function parseArgs(argv) {
  const options = {};
  let clear = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--clear-state') { if (clear) throw stop('args'); clear = true; continue; }
    const key = FLAGS.get(flag);
    if (!key || key in options || i + 1 >= argv.length) throw stop('args');
    options[key] = argv[++i];
  }
  return { options, clear };
}

export async function runCli(argv, {
  env = process.env, backend = null, now = Date.now,
  stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text),
} = {}) {
  try {
    if (env.CASEG_EXPIRY_ENABLE !== '1') throw stop('environment');
    const { options, clear } = parseArgs(argv);
    if (clear) {
      if (Object.keys(options).length !== 2 || !options.runDir || !options.stateFile) throw stop('args');
      const location = await validateStateLocation(options, { env });
      await clearState(location.stateFile);
      stdout('stateCleared=true\n');
      return 0;
    }
    if (Object.keys(options).length !== FLAGS.size) throw stop('args');
    const scope = await validateScope(options, { env });
    const previous = await readState(scope.stateFile, scope);
    const run = (backend ?? createSecurityBackend({ env })).run;
    const guarded = args => { assertReadOnly(args); return run(args); };
    const expiresAt = await readScopedExpiry(guarded, scope);
    const lines = summarize({ expiresAt, previous, now: now() });
    await writeState(scope.stateFile, scope, expiresAt);
    stdout(`${lines.join('\n')}\n`);
    return 0;
  } catch (error) {
    const reason = error instanceof HelperStop ? error.reason : 'read';
    stderr(`expiry-helper: stopped reason=${reason}\n`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}

// Exported for tests only.
export const _internal = Object.freeze({ scan, isWithin });
