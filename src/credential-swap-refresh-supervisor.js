import { execFile, spawn } from 'node:child_process';
import { lstat, open, readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createAlertSender } from './alert-sender.js';
import { CLAUDE_PROVIDER_OVERRIDE_ENV_VARS } from './claude-provider-env.js';
import { overlaps, swapError, validateSwapAccount } from './credential-swap-config.js';
import { attribute } from './credential-swap-keychain.js';
import { ensureDirectoryDurable, readJsonFile, writeJsonFileDurable } from './json-file.js';
import { appConfigDir, appDataDir, linuxAccountsDir, runtimeStatePath } from './paths.js';

// The supervisor keeps a send-side subscription credential fresh only through
// the official client: B keeps an official interactive client running, A sends
// one fixed sentence through the official client, C asks a person to log in.
// It never reads, refreshes or writes a credential itself.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STATE_FILE = 'refresh-supervisor-state.json';
const LOCK_FILE = 'refresh-supervisor.lock';
const SECURITY = '/usr/bin/security';
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const PROBE_TIMEOUT_MS = 10_000;
const LSOF_TIMEOUT_MS = 15_000;
const MAX_EVENT_FILES = 512;
const MAX_EVENT_BYTES = 64 * 1024;
export const DEFAULT_FALLBACK_A_PROMPT = 'Reply with the single word OK.';
export const ACTIONS = ['none', 'start_resident', 'fallback_a', 'notify_login', 'notify_stale', 'notify_unknown'];
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
export const FIXED_ENV_UNSET = ['CLAUDE_CODE_OAUTH_TOKEN', ...CLAUDE_PROVIDER_OVERRIDE_ENV_VARS,
  ...PROXY_NAMES, ...PROXY_NAMES.map(name => name.toLowerCase())];
// Account ids become keys of the state file; these names would reach the
// prototype of an ordinary object.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// Only these codes ever leave the supervisor; anything else becomes a fixed
// failure code, so an error message can never carry other text.
export const REASON_CODES = Object.freeze(['fresh', 'resident_missing', 'resident_refresh_pending',
  'resident_unknown', 'resident_unverified', 'other_users_present', 'other_users_unknown', 'mdat_unknown',
  'expiry_events_unreadable', 'refresh_state_invalid', 'fallback_a_disabled', 'fallback_a_no_progress',
  'fallback_a_daily_limit', 'fallback_a_interval', 'mdat_stale', 'credential_expired', 'work_dir_not_empty',
  'work_dir_unavailable', 'resident_launcher_unconfigured', 'resident_launch_failed', 'fallback_a_failed',
  'fallback_a_unfinished', 'external_client_present']);
export const CLI_REASON_CODES = Object.freeze(['invalid_refresh_config', 'refresh_state_unavailable',
  'refresh_supervisor_locked', 'refresh_state_write_failed']);
const NOTICE_SUCCESS = new Set(['exited-0', 'sent']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathText = value => typeof value === 'string' && value.length > 0
  && !/[\x00-\x1f\x7f"\\]/.test(value) && isAbsolute(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const refreshError = (reason = 'invalid_refresh_config') => swapError(reason);

export function reasonCode(error, fallback) {
  return REASON_CODES.includes(error?.message) ? error.message : fallback;
}

export function refreshSupervisorCliReason(error) {
  return CLI_REASON_CODES.includes(error?.message) ? error.message : 'refresh_supervisor_failed';
}

export function normalizeRefreshSupervisor(config) {
  if (!object(config) || !object(config.refreshSupervisor)) throw refreshError();
  const raw = config.refreshSupervisor;
  const result = {
    expectedIntervalMs: 8 * HOUR,
    staleAfterMs: 9 * HOUR,
    notifyDedupeMs: 6 * HOUR,
    ...raw,
  };
  const fallbackRaw = raw.fallbackA ?? {};
  if (!object(fallbackRaw)) throw refreshError();
  result.fallbackA = {
    enabled: false,
    minIntervalMs: 6 * HOUR,
    maxPerDay: 2,
    timeoutMs: 120_000,
    prompt: DEFAULT_FALLBACK_A_PROMPT,
    ...fallbackRaw,
  };
  const fallback = result.fallbackA;
  if (!pathText(result.stateDir) || !pathText(result.claudeBin)
    || !integer(result.expectedIntervalMs, 60_000)
    || !integer(result.staleAfterMs, result.expectedIntervalMs)
    || !integer(result.notifyDedupeMs, 0)
    || typeof fallback.enabled !== 'boolean'
    || !integer(fallback.minIntervalMs, 60_000)
    || !integer(fallback.maxPerDay, 1, 24)
    || !integer(fallback.timeoutMs, 1_000, 30 * 60_000)
    || !validPrompt(fallback.prompt)
    || !Array.isArray(result.accounts) || result.accounts.length === 0) throw refreshError();
  if (raw.launcher !== undefined) result.launcher = normalizeLauncher(raw.launcher);
  result.stateDir = resolve(result.stateDir);
  const ids = new Set();
  const workDirs = [];
  for (const account of result.accounts) {
    try { validateSwapAccount(account); } catch { throw refreshError(); }
    if (ids.has(account.id) || RESERVED_IDS.has(account.id) || !pathText(account.workDir)
      || (account.swapStateDir !== undefined && !pathText(account.swapStateDir))) throw refreshError();
    ids.add(account.id);
    const workDir = resolve(account.workDir);
    const keychainDirs = account.keychainAllowlist.map(file => dirname(file));
    const guarded = [account.configDir, ...keychainDirs, result.stateDir,
      ...(account.swapStateDir ? [account.swapStateDir] : []), ...workDirs];
    if (guarded.some(path => overlaps(workDir, resolve(path)))) throw refreshError();
    workDirs.push(workDir);
    // The Orca launcher puts these paths inside single quotes of a shell command.
    if (result.launcher && [account.workDir, account.configDir].some(path => path.includes("'")))
      throw refreshError();
  }
  if (result.launcher && result.claudeBin.includes("'")) throw refreshError();
  const protectedPaths = [appConfigDir(), runtimeStatePath(), appDataDir(), linuxAccountsDir(),
    ...result.accounts.flatMap(account => [account.configDir,
      ...account.keychainAllowlist.map(file => dirname(file)),
      ...(account.swapStateDir ? [account.swapStateDir] : [])])];
  if (protectedPaths.some(path => overlaps(result.stateDir, resolve(path)))) throw refreshError();
  return structuredClone(result);
}

// Values that reach the Orca command line or the terminal shell carry no
// quote, control character, escape or shell operator.
const LAUNCHER_KEYS = ['kind', 'orcaBin', 'worktree', 'title'];
const SHELL_UNSAFE = /[\x00-\x1f\x7f'"`$;&|\\]/;

function validWorktree(value) {
  const match = /^(path|id|folder):(.+)$/.exec(value);
  return Boolean(match) && (match[1] !== 'path' || isAbsolute(match[2]));
}

function normalizeLauncher(value) {
  if (!exactKeys(value, LAUNCHER_KEYS) || value.kind !== 'orca'
    || !pathText(value.orcaBin) || value.orcaBin.includes("'")
    || typeof value.worktree !== 'string' || SHELL_UNSAFE.test(value.worktree) || !validWorktree(value.worktree)
    || typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 60
    || SHELL_UNSAFE.test(value.title) || value.title.startsWith('-')) throw refreshError();
  return { kind: 'orca', orcaBin: value.orcaBin, worktree: value.worktree, title: value.title };
}

// The prompt is one fixed sentence. A leading '-' would read as an option and a
// leading '/' as a client command (for example a login or logout command).
function validPrompt(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && !/[\x00-\x1f\x7f]/.test(value) && !/^[-/\s]/.test(value) && value.trim() === value;
}

export async function loadRefreshSupervisorConfig(path, readConfigFile = readFile) {
  try { return normalizeRefreshSupervisor(JSON.parse(await readConfigFile(path, 'utf8'))); }
  catch { throw refreshError(); }
}

// ---------------------------------------------------------------------------
// Observation. Every probe is read-only and reports 'unknown' instead of
// guessing. Command shapes are fixed here; nothing else is ever executed.

function probeOptions() {
  return { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS };
}

export function parseKeychainMdat(value) {
  const match = typeof value === 'string'
    && value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z\x00?$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second)
    return null;
  return ms;
}

// Parses attribute-only dumps of every allowed file. Exactly one generic
// password item must match acct and service, and it must live in keychainPath.
export function mdatFromDumps(account, dumps) {
  const matches = [];
  for (const { file, stdout } of dumps) {
    const body = String(stdout).trim();
    if (!body) continue;
    for (const block of body.split(/(?=^keychain: )/m).filter(Boolean)) {
      if (!block.startsWith(`keychain: "${file}"\n`) || /^data:/m.test(block)) return { status: 'unknown' };
      if (!/^class: "genp"$/m.test(block)) continue;
      const acct = attribute(block, 'acct', 'blob');
      const service = attribute(block, 'svce', 'blob');
      if ((acct !== undefined && acct !== account.acct)
        || (service !== undefined && service !== account.service)) continue;
      if (acct === undefined || service === undefined) return { status: 'unknown' };
      if (file !== account.keychainPath) return { status: 'unknown' };
      const mdatMs = parseKeychainMdat(attribute(block, 'mdat', 'timedate'));
      if (mdatMs === null) return { status: 'unknown' };
      const created = attribute(block, 'cdat', 'timedate');
      matches.push({ mdatMs, identity: typeof created === 'string' ? created : null });
    }
  }
  if (matches.length !== 1) return { status: 'unknown' };
  return { status: 'ok', ...matches[0] };
}

export async function probeMdat(account, execute) {
  const dumps = [];
  try {
    for (const file of account.keychainAllowlist) {
      const { stdout } = await execute(SECURITY, ['dump-keychain', file], probeOptions());
      dumps.push({ file, stdout });
    }
  } catch { return { status: 'unknown' }; }
  return mdatFromDumps(account, dumps);
}

// Reads only statusCode, reason and the account field of each swap event; the
// time is the file's modification time because events carry no timestamp.
export async function probeExpiryEvents(account, io = {}) {
  const result = { latestExpiredMs: null, unreadable: 0 };
  if (!account.swapStateDir) return result;
  const readdirImpl = io.readdir || readdir;
  const lstatImpl = io.lstat || lstat;
  const readImpl = io.readFile || readFile;
  const eventsDir = join(account.swapStateDir, 'events');
  let names;
  try { names = await readdirImpl(eventsDir); }
  catch (error) {
    if (error?.code !== 'ENOENT') result.unreadable++;
    return result;
  }
  for (const name of names.filter(name => name.endsWith('.json')).slice(0, MAX_EVENT_FILES)) {
    try {
      const path = join(eventsDir, name);
      const info = await lstatImpl(path);
      if (!info.isFile() || info.size > MAX_EVENT_BYTES) throw swapError();
      const parsed = JSON.parse(await readImpl(path, 'utf8'));
      if (!object(parsed)) throw swapError();
      const reason = parsed.reason;
      const statusCode = parsed.statusCode;
      const sent = parsed.sentAccountId;
      // A credential failure is recorded before a sent account is assigned, so
      // the field is null for the account this swap state directory serves.
      if (reason !== 'credential_expired' || (sent !== null && sent !== undefined && sent !== account.id)
        || (statusCode !== null && statusCode !== undefined && !integer(statusCode, 100, 599))) continue;
      if (result.latestExpiredMs === null || info.mtimeMs > result.latestExpiredMs)
        result.latestExpiredMs = Math.floor(info.mtimeMs);
    } catch { result.unreadable++; }
  }
  return result;
}

function normalizeStart(text) {
  return text.trim().replace(/\s+/g, ' ');
}

export function parsePsLine(stdout) {
  const lines = String(stdout).split('\n').filter(line => line.trim());
  if (lines.length !== 1) return null;
  const match = lines[0].match(/^\s*([A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(\S.*)$/);
  if (!match) return null;
  return { startedAt: normalizeStart(match[1]), command: match[2].trimEnd() };
}

// Only start time and command are read. Environments of other processes are
// never requested.
export async function probeResidentProcess(pid, execute, timeoutMs = PROBE_TIMEOUT_MS) {
  if (!integer(pid, 2, 2 ** 31 - 1)) return { status: 'unknown' };
  try {
    // lstart follows the locale; a fixed locale keeps the recorded start comparable.
    const { stdout } = await execute(PS, ['-p', String(pid), '-o', 'lstart=,command='],
      { ...probeOptions(), timeout: timeoutMs, env: { ...process.env, LC_ALL: 'C' } });
    const parsed = parsePsLine(stdout);
    return parsed ? { status: 'running', ...parsed } : { status: 'unknown' };
  } catch (error) {
    // ps exits 1 with no output for a missing process. Any diagnostic, kill or
    // signal is a failed observation, not proof of absence. Its text is dropped.
    if (error?.code === 1 && !error.killed && !error.signal && !String(error.stdout ?? '').trim()
      && !String(error.stderr ?? '').trim()) return { status: 'absent' };
    return { status: 'unknown' };
  }
}


// 'absent' means the recorded process is proven gone or replaced; 'unknown'
// keeps the record. A launch whose identity could not be confirmed stays
// 'unverified' until ps proves that process gone.
export async function probeResident(account, accountState, config, execute) {
  const unverified = accountState?.residentUnverified;
  // A launch recorded before its pid was known, or one whose client could not
  // be identified (manual), is never cleared automatically: the recorded pid
  // may be the terminal's parent while its client child lives on. A person
  // checks the processes and corrects the state file.
  if (unverified?.pid === null || unverified?.manual === true)
    return { status: 'unverified', pid: unverified.pid, clearUnverified: false };
  if (unverified) {
    const seen = await probeResidentProcess(unverified.pid, execute);
    const replaced = seen.status === 'running' && unverified.startedAt !== null
      && seen.startedAt !== unverified.startedAt;
    if (seen.status !== 'absent' && !replaced) return { status: 'unverified', pid: unverified.pid, clearUnverified: false };
  }
  const clearUnverified = Boolean(unverified);
  const resident = accountState?.resident;
  if (!resident) return { status: 'absent', pid: null, clearUnverified };
  const seen = await probeResidentProcess(resident.pid, execute);
  if (seen.status === 'unknown') return { status: 'unknown', pid: null, clearUnverified };
  if (seen.status === 'absent' || seen.startedAt !== resident.startedAt
    || seen.command !== config.claudeBin) return { status: 'absent', pid: null, clearUnverified };
  return { status: 'alive', pid: resident.pid, clearUnverified };
}

// -t prints only process ids. Any other line, or a diagnostic on stderr, makes
// the answer unknown. The detailed form also returns the pids it found.
export async function probeOtherUsersDetailed(account, residentPid, execute) {
  let stdout;
  try {
    ({ stdout } = await execute(LSOF, ['-nP', '-t', '+D', account.configDir],
      { ...probeOptions(), timeout: LSOF_TIMEOUT_MS }));
  } catch (error) {
    // lsof exits 1 when no process has a file open below the directory.
    if (error?.code !== 1 || error.killed || error.signal || String(error.stderr ?? '').trim())
      return { status: 'unknown', pids: new Set() };
    stdout = error.stdout ?? '';
  }
  const pids = new Set();
  for (const line of String(stdout).split('\n').filter(Boolean)) {
    if (!/^\d{1,10}$/.test(line)) return { status: 'unknown', pids: new Set() };
    pids.add(Number(line));
  }
  pids.delete(process.pid);
  if (residentPid !== null) pids.delete(residentPid);
  return { status: pids.size === 0 ? 'none' : 'present', pids };
}

export async function probeOtherUsers(account, residentPid, execute) {
  return (await probeOtherUsersDetailed(account, residentPid, execute)).status;
}

// Counted in pids: one client may own both a .json and a .key name.
const MAX_SESSION_PIDS = 64;
const SESSION_REUSE_SLACK_MS = 120_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ps prints lstart in the C locale as local time, e.g. 'Wed May 18 03:00:00 2033'.
export function parsePsStart(text) {
  const match = typeof text === 'string'
    && text.match(/^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (month < 0) return null;
  const [day, hour, minute, second, year] = match.slice(2).map(Number);
  const date = new Date(year, month, day, hour, minute, second);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day
    || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return null;
  return date.getTime();
}

// A running official client does not necessarily keep a file open below its
// configuration folder, so lsof alone can miss it. The client names files
// sessions/<pid>.json and sessions/<pid>.<64 hex>.key there. While the client
// waits on its first confirmation screen only the .key name exists (observed
// 2026-11-18), so both shapes name a client. Only entry names and their
// metadata (lstat) are read; no file is opened. Names that
// do not start with '<digits>.' are ignored. A name starting with a pid is
// ignored, before its shape is looked at, when the pid is outside 2..2^31-1
// (including 11 or more digits: no process can have it), is this process or is
// the recorded resident. Any other name starting with a pid but of another
// shape is unexpected. A name that lstat reports missing (ENOENT) is treated
// as absent. Each pid with a remaining name is checked with ps, and creation
// times are taken per group (expected or unexpected names), using whichever
// name of the group was created last:
// - gone: stale names, ignored;
// - started more than a short slack after a group was created: the pid was
//   reused by another process, that group is stale and ignored;
// - an unexpected name that is not stale: unknown;
// - expected names, running as the official client: found;
// - running as anything else, or not determinable: the answer is unknown.
// No name or pid is reported.
export async function probeSessionClientsDetailed(account, residentPid, config, execute, io = {}) {
  const unknown = { status: 'unknown', pids: new Set() };
  const readdirImpl = io.readdir || readdir;
  const lstatImpl = io.lstat || lstat;
  const sessionsDir = join(account.configDir, 'sessions');
  let names;
  try { names = await readdirImpl(sessionsDir); }
  catch (error) { return error?.code === 'ENOENT' ? { status: 'none', pids: new Set() } : unknown; }
  if (!Array.isArray(names)) return unknown;
  // pid -> { names: expected names, odd: names of another shape }
  const candidates = new Map();
  for (const name of names) {
    if (typeof name !== 'string') return unknown;
    const match = name.match(/^(\d+)\.(.*)$/s);
    if (!match) continue;
    if (match[1].length > 10) continue;
    const pid = Number(match[1]);
    if (!integer(pid, 2, 2 ** 31 - 1) || pid === process.pid || pid === residentPid) continue;
    const entry = candidates.get(pid) ?? { names: [], odd: [] };
    if (/^(?:json|[0-9a-fA-F]{64}\.key)$/.test(match[2])) entry.names.push(name);
    else entry.odd.push(name);
    candidates.set(pid, entry);
  }
  if (candidates.size > MAX_SESSION_PIDS) return unknown;
  const found = new Set();
  // Latest creation time of the names that still exist, null when none does,
  // undefined when one cannot be read.
  const latestCreated = async groupNames => {
    let latest = null;
    for (const name of groupNames) {
      let info;
      try { info = await lstatImpl(join(sessionsDir, name)); }
      catch (error) {
        if (error?.code === 'ENOENT') continue;
        return undefined;
      }
      const at = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs;
      if (!Number.isFinite(at) || at <= 0) return undefined;
      latest = Math.max(latest ?? at, at);
    }
    return latest;
  };
  for (const [pid, { names: pidNames, odd }] of candidates) {
    const createdMs = await latestCreated(pidNames);
    const oddCreatedMs = await latestCreated(odd);
    if (createdMs === undefined || oddCreatedMs === undefined) return unknown;
    if (createdMs === null && oddCreatedMs === null) continue;
    const seen = await probeResidentProcess(pid, execute);
    if (seen.status === 'unknown') return unknown;
    if (seen.status === 'absent') continue;
    const startedMs = parsePsStart(seen.startedAt);
    if (startedMs === null) return unknown;
    const stale = created => startedMs > created + SESSION_REUSE_SLACK_MS;
    if (oddCreatedMs !== null && !stale(oddCreatedMs)) return unknown;
    if (createdMs === null || stale(createdMs)) continue;
    if (!officialClientCommand(seen.command, config.claudeBin)) return unknown;
    found.add(pid);
  }
  return { status: found.size ? 'present' : 'none', pids: found };
}

export async function probeSessionClients(account, residentPid, config, execute, io = {}) {
  return (await probeSessionClientsDetailed(account, residentPid, config, execute, io)).status;
}

// The command column shows argv[0] and the arguments as launched: 'claude'
// from a shell, or a path. A path must be claudeBin (which may contain spaces,
// so it is matched as a prefix followed by a space) or an executable in
// claudeBin's folder.
function officialClientCommand(command, claudeBin) {
  const text = String(command);
  if (text === claudeBin || text.startsWith(`${claudeBin} `)) return true;
  const first = text.split(/\s+/, 1)[0];
  if (first === 'claude') return true;
  return isAbsolute(first) && dirname(first) === dirname(claudeBin);
}

export async function observeAccount(account, accountState, config, { execute, eventsIO, sessionsIO } = {}) {
  const mdat = await probeMdat(account, execute);
  const expiry = await probeExpiryEvents(account, eventsIO);
  const resident = await probeResident(account, accountState, config, execute);
  const lsofUsers = await probeOtherUsersDetailed(account, resident.pid, execute);
  const sessions = await probeSessionClientsDetailed(account, resident.pid, config, execute, sessionsIO);
  const otherUsers = lsofUsers.status === 'unknown' || sessions.status === 'unknown' ? 'unknown'
    : lsofUsers.status === 'present' || sessions.status === 'present' ? 'present' : 'none';
  // A process lsof saw that is not a confirmed official client is someone else.
  const otherThanClients = [...lsofUsers.pids].some(pid => !sessions.pids.has(pid));
  return { mdat, expiry, resident: resident.status, residentPid: resident.pid,
    clearUnverified: resident.clearUnverified, otherUsers,
    externalClient: sessions.status === 'present', otherThanClients };
}

// ---------------------------------------------------------------------------
// Decision. Pure: the same inputs give the same action. Whatever cannot be
// established leads to a notice, never to an automatic action.

export function decide(observation, state = {}, policy, now) {
  if (state?.invalid === true) return { action: 'notify_unknown', reason: 'refresh_state_invalid' };
  const mdat = observation.mdat;
  if (mdat?.status !== 'ok') return { action: 'notify_unknown', reason: 'mdat_unknown' };
  if (observation.expiry?.unreadable > 0) return { action: 'notify_unknown', reason: 'expiry_events_unreadable' };
  if (observation.resident === 'unverified') return { action: 'notify_unknown', reason: 'resident_unverified' };
  if (observation.resident === 'unknown') return { action: 'notify_unknown', reason: 'resident_unknown' };
  const expiredAfterMdat = observation.expiry?.latestExpiredMs != null
    && observation.expiry.latestExpiredMs > mdat.mdatMs;
  const aged = now - mdat.mdatMs >= policy.staleAfterMs;
  if (!aged && observation.resident === 'alive') {
    // A running official client refreshes near expiry by itself; an expiry
    // seen by the swap server just before that refresh is not yet a failure.
    return { action: 'none', reason: expiredAfterMdat ? 'resident_refresh_pending' : 'fresh' };
  }
  if (!aged && !expiredAfterMdat) {
    if (observation.otherUsers === 'unknown' || !['none', 'present'].includes(observation.otherUsers))
      return { action: 'notify_unknown', reason: 'other_users_unknown' };
    // An official client found by its session name refreshes by itself; leave
    // the folder to it rather than starting a second client or notifying.
    if (observation.externalClient === true && observation.otherThanClients !== true)
      return { action: 'none', reason: 'external_client_present' };
    if (observation.otherUsers === 'present') return { action: 'notify_unknown', reason: 'other_users_present' };
    return { action: 'start_resident', reason: 'resident_missing' };
  }
  const fallback = policy.fallbackA;
  if (!fallback.enabled) return { action: 'notify_login', reason: 'fallback_a_disabled' };
  const attempts = state.fallbackA?.attempts ?? [];
  const lastAttemptMdat = state.fallbackA?.lastAttemptMdat;
  if (attempts.length && integer(lastAttemptMdat, 0) && mdat.mdatMs <= lastAttemptMdat)
    return { action: 'notify_login', reason: 'fallback_a_no_progress' };
  if (attempts.filter(at => at > now - DAY).length >= fallback.maxPerDay)
    return { action: 'notify_login', reason: 'fallback_a_daily_limit' };
  if (attempts.some(at => at > now - fallback.minIntervalMs))
    return { action: 'notify_stale', reason: 'fallback_a_interval' };
  if (observation.otherUsers === 'present') return { action: 'notify_stale', reason: 'other_users_present' };
  if (observation.otherUsers !== 'none') return { action: 'notify_stale', reason: 'other_users_unknown' };
  return { action: 'fallback_a', reason: expiredAfterMdat ? 'credential_expired' : 'mdat_stale' };
}

// ---------------------------------------------------------------------------
// Plans. Each plan names the absolute official executable, a fixed argv, an
// empty dedicated working directory and the environment changes. Values of
// the inherited environment never enter a plan.

export function envUnsetNames(env = process.env) {
  return [...new Set([...Object.keys(env).filter(name => name.startsWith('ANTHROPIC_')),
    ...FIXED_ENV_UNSET])].sort();
}

export function planEnvironment(plan, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) if (name.startsWith('ANTHROPIC_')) delete env[name];
  for (const name of [...FIXED_ENV_UNSET, ...plan.envUnset]) delete env[name];
  return { ...env, ...plan.envSet };
}

async function assertEmptyWorkDir(workDir, readdirImpl = readdir) {
  let entries;
  try { entries = await readdirImpl(workDir); }
  catch { throw refreshError('work_dir_unavailable'); }
  if (entries.length) throw refreshError('work_dir_not_empty');
}

export async function buildResidentPlan(account, config, { env = process.env, readdir: readdirImpl } = {}) {
  await assertEmptyWorkDir(account.workDir, readdirImpl);
  return {
    file: config.claudeBin,
    args: [],
    cwd: account.workDir,
    envUnset: envUnsetNames(env),
    envSet: { CLAUDE_CONFIG_DIR: account.configDir },
  };
}

// Options are limited to those listed by the official client's --help
// (2.1.326): --tools "" disables built-in tools, --strict-mcp-config ignores
// MCP configurations, and --permission-prompts none denies anything that would
// prompt instead of asking (it applies to --print). Permission bypass options
// are never used.
export async function buildFallbackAPlan(account, config, options = {}) {
  const resident = await buildResidentPlan(account, config, options);
  return {
    ...resident,
    args: ['-p', config.fallbackA.prompt, '--tools', '', '--strict-mcp-config',
      '--permission-prompts', 'none'],
    timeoutMs: config.fallbackA.timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Default side effects.

export async function defaultLauncher() {
  throw refreshError('resident_launcher_unconfigured');
}

// The terminal's shell is not the supervisor's, so its environment is emptied
// with env -i and rebuilt from this allow list instead of removing names: every
// ANTHROPIC_*, CLAUDE_CODE_*, proxy or other variable of the terminal is
// dropped. exec with an absolute path bypasses shell aliases.
// The terminal's login shell is assumed to be zsh or bash.
const ORCA_ENV_ALLOW = 'HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" TERM="$TERM" '
  + 'LANG=en_US.UTF-8 TMPDIR="$TMPDIR" PATH=/usr/bin:/bin:/usr/sbin:/sbin';
// The orca CLI itself gets only these names from the supervisor's environment.
const ORCA_CLI_ENV = ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG'];
// ps prints whole seconds; a client started before the orca call minus this
// slack is some other process.
const LAUNCH_START_SLACK_MS = 2_000;
const PGREP = '/usr/bin/pgrep';
const LOGIN = '/usr/bin/login';
const ORCA_TIMEOUT_MS = 20_000;
const FIND_WAIT_MS = 30_000;
const FIND_STEP_MS = 1_000;
const MAX_DESCENDANTS = 64;

export function buildOrcaCommand(plan) {
  const configDir = plan?.envSet?.CLAUDE_CONFIG_DIR;
  if (!Array.isArray(plan?.args) || plan.args.length !== 0 || !object(plan.envSet)
    || Object.keys(plan.envSet).length !== 1
    || [plan.cwd, configDir, plan.file].some(value => !pathText(value) || value.includes("'")))
    throw refreshError('resident_launch_failed');
  return `cd '${plan.cwd}' && exec /usr/bin/env -i ${ORCA_ENV_ALLOW} CLAUDE_CONFIG_DIR='${configDir}' '${plan.file}'`;
}

// pgrep exits 1 with no output when a process has no children; anything else
// is a failed observation.
async function childPids(pid, execute, timeoutMs) {
  try {
    const { stdout } = await execute(PGREP, ['-P', String(pid)], { ...probeOptions(), timeout: timeoutMs });
    const lines = String(stdout).split('\n').map(line => line.trim()).filter(Boolean);
    const pids = lines.map(Number);
    return lines.every(line => /^\d{1,10}$/.test(line)) && pids.every(child => integer(child, 2, 2 ** 31 - 1))
      ? pids : null;
  } catch (error) {
    if (error?.code === 1 && !error.killed && !error.signal && !String(error.stdout ?? '').trim()
      && !String(error.stderr ?? '').trim()) return [];
    return null;
  }
}

// Walks the terminal's process and its descendants (parent to child from
// rootPid) with pgrep and ps only. A candidate is a process whose command is
// exactly claudeBin and that started no earlier than notBeforeMs. Returns the
// candidate pids, null when any step could not be observed, or 'expired' when
// the deadline passed. Each probe's timeout is limited to the time left, read
// once per probe; with less than 1 ms left no probe is made.
// The terminal process Orca reports is that terminal's own /usr/bin/login (its
// child is the login shell). Anything else is not a terminal this launcher can
// vouch for, and nothing below it is searched.
const isLoginCommand = command => command === LOGIN || command.startsWith(`${LOGIN} `);

async function claudeDescendants(rootPid, claudeBin, execute, { notBeforeMs, deadline, now }) {
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  const matches = [];
  const probeTimeout = () => {
    const left = Math.floor(deadline - now());
    return left >= 1 ? Math.min(PROBE_TIMEOUT_MS, left) : null;
  };
  while (queue.length) {
    const pid = queue.shift();
    const psTimeout = probeTimeout();
    if (psTimeout === null) return 'expired';
    const proc = await probeResidentProcess(pid, execute, psTimeout);
    if (proc.status === 'unknown') return null;
    if (pid === rootPid && (proc.status !== 'running' || !isLoginCommand(proc.command))) return 'not_login';
    if (proc.status === 'running' && proc.command === claudeBin) {
      const startedMs = parsePsStart(proc.startedAt);
      if (startedMs === null) return null;
      if (startedMs >= notBeforeMs) matches.push(pid);
    }
    const pgrepTimeout = probeTimeout();
    if (pgrepTimeout === null) return 'expired';
    const children = await childPids(pid, execute, pgrepTimeout);
    if (children === null) return null;
    for (const child of children) {
      if (seen.has(child)) continue;
      if (seen.size >= MAX_DESCENDANTS) return null;
      seen.add(child);
      queue.push(child);
    }
  }
  return matches;
}

// Opens one Orca terminal that runs the official client and only identifies
// it afterwards. Nothing is ever typed into, sent to or closed in the terminal.
// The terminal handle is not returned, reported or stored.
export function createOrcaLauncher({ config, execute = promisify(execFile),
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)), now = Date.now } = {}) {
  const { orcaBin, worktree, title } = config.launcher;
  return async (plan, env = {}) => {
    const command = buildOrcaCommand(plan);
    const orcaEnv = {};
    for (const name of ORCA_CLI_ENV) if (typeof env[name] === 'string') orcaEnv[name] = env[name];
    const notBeforeMs = now() - LAUNCH_START_SLACK_MS;
    let parsed;
    try {
      const { stdout } = await execute(orcaBin, ['terminal', 'create', '--worktree', worktree, '--title', title,
        '--command', command, '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: ORCA_TIMEOUT_MS,
        env: orcaEnv });
      parsed = JSON.parse(stdout);
    } catch { throw refreshError('resident_launch_failed'); }
    const terminal = parsed?.ok === true && object(parsed.result) ? parsed.result.terminal : null;
    const rootPid = terminal?.processId;
    if (!object(terminal) || !integer(rootPid, 2, 2 ** 31 - 1)
      || typeof terminal.handle !== 'string' || !terminal.handle) throw refreshError('resident_launch_failed');
    const deadline = now() + FIND_WAIT_MS;
    for (;;) {
      const found = await claudeDescendants(rootPid, plan.file, execute, { notBeforeMs, deadline, now });
      // Unobservable, not a login terminal, ambiguous or out of time: the
      // terminal's pid is kept as unverified.
      if (!Array.isArray(found) || found.length > 1) return { pid: rootPid, verified: false };
      if (found.length === 1) return { pid: found[0], verified: true };
      if (now() >= deadline) return { pid: rootPid, verified: false };
      await sleep(FIND_STEP_MS);
    }
  };
}

// No shell; stdin is closed; output is counted and discarded. At the time limit
// the child gets SIGTERM, then SIGKILL after a grace period; if it still does
// not close, the run resolves as unfinished instead of waiting forever.
export function defaultRunner(plan, env, { spawn: spawnImpl = spawn, timers = { setTimeout, clearTimeout },
  killGraceMs = 5_000, closeWaitMs = 5_000 } = {}) {
  return new Promise(resolveRun => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let done = false;
    const pending = [];
    const finish = result => {
      if (done) return;
      done = true;
      for (const timer of pending) timers.clearTimeout(timer);
      resolveRun({ code: null, signal: null, error: false, unfinished: false,
        ...result, timedOut, stdoutBytes, stderrBytes });
    };
    const later = (ms, callback) => { pending.push(timers.setTimeout(callback, ms)); };
    let child;
    try {
      child = spawnImpl(plan.file, plan.args, { cwd: plan.cwd, env, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { finish({ error: true }); return; }
    const signal = name => { try { child.kill(name); } catch { /* already gone */ } };
    later(plan.timeoutMs, () => {
      timedOut = true;
      signal('SIGTERM');
      later(killGraceMs, () => {
        signal('SIGKILL');
        later(closeWaitMs, () => finish({ unfinished: true }));
      });
    });
    child.stdout?.on('data', chunk => { stdoutBytes += chunk.length; });
    child.stderr?.on('data', chunk => { stderrBytes += chunk.length; });
    child.on('error', () => finish({ error: true }));
    child.on('close', (code, closeSignal) => finish({ code, signal: closeSignal }));
  });
}

export function defaultNotify() {
  const sender = createAlertSender({ execFile: promisify(execFile), fetchImpl: fetch });
  return message => sender.notifyMac(message);
}

export function notificationText(accountId, action, reason) {
  const title = 'claude-rotator';
  if (action === 'notify_login') return { title,
    body: `送信側口座 ${accountId} の資格が更新されていません。公式の /login をその設定フォルダで行ってください。` };
  if (action === 'notify_stale') return { title,
    body: `送信側口座 ${accountId} の資格の更新が遅れています（${reason}）。` };
  return { title,
    body: `送信側口座 ${accountId} の資格の状態を確認できません（${reason}）。自動の行動はしていません。` };
}

// ---------------------------------------------------------------------------
// State. Only times, process identity and action names are kept. A malformed
// account entry is left exactly as found and stops automatic action for that
// account; it is never reset to defaults.

const ACCOUNT_STATE_KEYS = new Set(['lastMdat', 'lastAction', 'lastReason', 'resident', 'residentUnverified',
  'fallbackA', 'notified']);
const START_TEXT = /^[A-Za-z0-9 :]{1,40}$/;
const NOTICE_KEY = /^notify_(?:login|stale|unknown):[a-z_]{1,64}$/;

function emptyAccountState() {
  return { lastMdat: null, lastAction: null, lastReason: null, resident: null, residentUnverified: null,
    fallbackA: { attempts: [], lastAttemptMdat: null }, notified: Object.create(null) };
}

const exactKeys = (value, keys) => object(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Either a launch whose pid is not yet known ({ pid: null, startedAt: null,
// pendingSince }), a launched pid whose client could not be identified
// ({ pid, startedAt, pendingSince, manual: true }), or an older record of a
// launched pid whose identity was not confirmed.
function validUnverified(value) {
  if (exactKeys(value, ['pid', 'startedAt', 'pendingSince', 'manual'])) {
    if (value.manual !== true || !integer(value.pendingSince, 0)) return false;
  } else if (exactKeys(value, ['pid', 'startedAt', 'pendingSince'])) {
    if (!integer(value.pendingSince, 0)) return false;
    if (value.pid === null) return value.startedAt === null;
  } else if (!exactKeys(value, ['pid', 'startedAt'])) return false;
  return integer(value.pid, 2)
    && (value.startedAt === null || (typeof value.startedAt === 'string' && START_TEXT.test(value.startedAt)));
}

export function parseAccountState(raw) {
  if (raw === undefined) return emptyAccountState();
  if (!object(raw) || Object.keys(raw).some(key => !ACCOUNT_STATE_KEYS.has(key))) return null;
  const state = emptyAccountState();
  const nullable = (key, valid) => {
    if (!Object.hasOwn(raw, key) || raw[key] === null) return true;
    if (!valid(raw[key])) return false;
    state[key] = raw[key];
    return true;
  };
  const ok = nullable('lastMdat', value => integer(value, 0))
    && nullable('lastAction', value => ACTIONS.includes(value))
    && nullable('lastReason', value => REASON_CODES.includes(value))
    && nullable('resident', value => exactKeys(value, ['pid', 'startedAt']) && integer(value.pid, 2)
      && typeof value.startedAt === 'string' && START_TEXT.test(value.startedAt))
    && nullable('residentUnverified', validUnverified);
  if (!ok) return null;
  if (state.resident) state.resident = { ...state.resident };
  if (state.residentUnverified) state.residentUnverified = { ...state.residentUnverified };
  if (Object.hasOwn(raw, 'fallbackA')) {
    const fallback = raw.fallbackA;
    if (!exactKeys(fallback, ['attempts', 'lastAttemptMdat']) || !Array.isArray(fallback.attempts)
      || fallback.attempts.length > 32 || !fallback.attempts.every(at => integer(at, 0))
      || !(fallback.lastAttemptMdat === null || integer(fallback.lastAttemptMdat, 0))
      || (fallback.attempts.length === 0) !== (fallback.lastAttemptMdat === null)) return null;
    state.fallbackA = { attempts: [...fallback.attempts], lastAttemptMdat: fallback.lastAttemptMdat };
  }
  if (Object.hasOwn(raw, 'notified')) {
    if (!object(raw.notified)) return null;
    for (const [key, at] of Object.entries(raw.notified)) {
      if (!NOTICE_KEY.test(key) || !integer(at, 0)) return null;
      state.notified[key] = at;
    }
  }
  return state;
}

export function refreshStatePath(config) {
  return join(config.stateDir, STATE_FILE);
}

export function refreshLockPath(config) {
  return join(config.stateDir, LOCK_FILE);
}

// Returns raw entries (kept for writing back unchanged) and the parsed state of
// each configured account (null when malformed).
export async function readRefreshState(config) {
  let raw;
  try { raw = await readJsonFile(refreshStatePath(config), { version: 1, accounts: {} }); }
  catch { throw refreshError('refresh_state_unavailable'); }
  if (!object(raw) || raw.version !== 1 || !object(raw.accounts)) throw refreshError('refresh_state_unavailable');
  const stored = Object.create(null);
  for (const [id, value] of Object.entries(raw.accounts)) stored[id] = value;
  const parsed = new Map();
  for (const account of config.accounts) {
    parsed.set(account.id, parseAccountState(Object.hasOwn(raw.accounts, account.id)
      ? raw.accounts[account.id] : undefined));
  }
  return { stored, parsed };
}

// A null-prototype map keeps every stored id, including ones that would reach
// an ordinary object's prototype, as a plain own key.
function serializeState(stored) {
  const accounts = Object.create(null);
  for (const id of Object.keys(stored)) accounts[id] = stored[id];
  return { version: 1, accounts };
}

// ---------------------------------------------------------------------------
// Exclusive lock for --apply. The lock is never removed on someone else's
// behalf; a leftover lock is reported and needs a person to look at it.

async function acquireLock(config, now) {
  const path = refreshLockPath(config);
  const token = { pid: process.pid, startedAt: now() };
  try { await ensureDirectoryDurable(config.stateDir, 0o700); }
  catch { throw refreshError('refresh_state_unavailable'); }
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw refreshError('refresh_supervisor_locked');
    throw refreshError('refresh_state_unavailable');
  }
  try {
    await handle.writeFile(`${JSON.stringify(token)}\n`);
    await handle.chmod(0o600);
    await handle.sync();
  } finally { await handle.close(); }
  return async () => {
    try {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current?.pid === token.pid && current?.startedAt === token.startedAt) await unlink(path);
    } catch { /* A lock that is not ours, or already gone, stays as it is. */ }
  };
}

// ---------------------------------------------------------------------------
// One pass. Dry-run observes and decides only: no lock, launcher, runner,
// alert or state write.

function publicObservation(observation, now) {
  return {
    mdat: observation.mdat.status,
    mdatAgeMs: observation.mdat.status === 'ok' ? now - observation.mdat.mdatMs : null,
    expiredAfterMdat: observation.mdat.status === 'ok' && observation.expiry.latestExpiredMs !== null
      && observation.expiry.latestExpiredMs > observation.mdat.mdatMs,
    unreadableEvents: observation.expiry.unreadable,
    resident: observation.resident,
    otherUsers: observation.otherUsers,
    externalClient: observation.externalClient === true,
  };
}

export async function runRefreshSupervisor({ apply = false, now = Date.now, ...options } = {}) {
  if (!apply) return supervisePass({ ...options, apply, now });
  const release = await acquireLock(options.config, now);
  let keepLock = false;
  try { return await supervisePass({ ...options, apply, now }); }
  catch (error) {
    // After a launch or an A run, a state that could not be saved leaves the
    // lock in place, so no later pass acts until a person has looked.
    keepLock = error?.keepLock === true;
    throw error;
  } finally { if (!keepLock) await release(); }
}

async function supervisePass({
  config,
  apply,
  now,
  execute = promisify(execFile),
  eventsIO,
  sessionsIO,
  launcher = defaultLauncher,
  runner = defaultRunner,
  notify,
  env = process.env,
  workDirIO,
  writeState = writeJsonFileDurable,
}) {
  const { stored, parsed } = await readRefreshState(config);
  const report = { mode: apply ? 'apply' : 'dry-run', accounts: [] };
  let actionStarted = false;
  const persist = async () => {
    try { await writeState(refreshStatePath(config), serializeState(stored), 0o600); }
    catch {
      const error = refreshError('refresh_state_write_failed');
      error.keepLock = actionStarted;
      throw error;
    }
  };
  const rethrowWriteFailure = error => {
    if (error?.message === 'refresh_state_write_failed') throw error;
  };
  let notifier = notify;
  const deliver = async (accountId, action, reason) => {
    notifier ??= defaultNotify();
    let outcome;
    try { outcome = (await notifier(notificationText(accountId, action, reason)))?.result ?? 'sent'; }
    catch { outcome = 'failed'; }
    return /^[a-z0-9-]{1,32}$/.test(outcome) ? outcome : 'failed';
  };
  for (const account of config.accounts) {
    const accountState = parsed.get(account.id);
    if (!accountState) {
      // Leave the malformed entry untouched; without a trusted record of past
      // notices, this notice is not deduplicated.
      const decision = decide({}, { invalid: true }, config, now());
      const entry = { id: account.id, ...decision, observation: null };
      report.accounts.push(entry);
      if (apply) entry.notice = await deliver(account.id, decision.action, decision.reason);
      continue;
    }
    const observed = await observeAccount(account, accountState, config, { execute, eventsIO, sessionsIO });
    const at = now();
    const decision = decide(observed, accountState, config, at);
    const entry = { id: account.id, ...decision, observation: publicObservation(observed, at) };
    report.accounts.push(entry);
    if (!apply) continue;

    stored[account.id] = accountState;
    if (observed.mdat.status === 'ok') accountState.lastMdat = observed.mdat.mdatMs;
    if (observed.clearUnverified) accountState.residentUnverified = null;
    if (observed.resident === 'absent') accountState.resident = null;
    accountState.lastAction = decision.action;
    accountState.lastReason = decision.reason;

    const sendNotice = async (action, reason) => {
      const key = `${action}:${reason}`;
      const sentAt = now();
      if (integer(accountState.notified[key], 0) && sentAt - accountState.notified[key] < config.notifyDedupeMs)
        return 'deduped';
      const outcome = await deliver(account.id, action, reason);
      if (NOTICE_SUCCESS.has(outcome)) accountState.notified[key] = sentAt;
      return outcome;
    };

    if (decision.action === 'start_resident') {
      try {
        const plan = await buildResidentPlan(account, config, { env, readdir: workDirIO?.readdir });
        // Record the launch durably before it happens; without that record the
        // launcher is not called.
        const pendingSince = now();
        accountState.residentUnverified = { pid: null, startedAt: null, pendingSince };
        await persist();
        actionStarted = true;
        const launched = await launcher(plan, planEnvironment(plan, env));
        if (!integer(launched?.pid, 2)) throw refreshError('resident_launch_failed');
        const seen = await probeResidentProcess(launched.pid, execute);
        if (launched.verified === false || seen.status !== 'running' || seen.command !== config.claudeBin) {
          // The launched process is neither trusted nor stopped. Its record
          // blocks further launches until a person has looked (manual), even
          // if ps later reports the recorded pid gone.
          accountState.residentUnverified = { pid: launched.pid,
            startedAt: seen.status === 'running' ? seen.startedAt : null, pendingSince, manual: true };
          throw refreshError('resident_unverified');
        }
        accountState.resident = { pid: launched.pid, startedAt: seen.startedAt };
        accountState.residentUnverified = null;
        entry.result = 'started';
      } catch (error) {
        rethrowWriteFailure(error);
        entry.result = reasonCode(error, 'resident_launch_failed');
        entry.notice = await sendNotice('notify_unknown', entry.result);
      }
    } else if (decision.action === 'fallback_a') {
      try {
        const plan = await buildFallbackAPlan(account, config, { env, readdir: workDirIO?.readdir });
        accountState.fallbackA.attempts = [...accountState.fallbackA.attempts, now()]
          .filter(time => time > now() - 2 * DAY).slice(-32);
        accountState.fallbackA.lastAttemptMdat = observed.mdat.mdatMs;
        await persist();
        actionStarted = true;
        const run = await runner(plan, planEnvironment(plan, env));
        entry.run = { code: integer(run?.code, 0, 255) ? run.code : null, timedOut: run?.timedOut === true,
          stdoutBytes: integer(run?.stdoutBytes, 0) ? run.stdoutBytes : 0,
          stderrBytes: integer(run?.stderrBytes, 0) ? run.stderrBytes : 0 };
        if (run?.unfinished === true) throw refreshError('fallback_a_unfinished');
        if (run?.error === true) throw refreshError('fallback_a_failed');
        const after = await probeMdat(account, execute);
        const sameItem = after.status === 'ok' && (observed.mdat.identity === null
          || after.identity === null || after.identity === observed.mdat.identity);
        if (sameItem && after.mdatMs > observed.mdat.mdatMs) {
          accountState.lastMdat = after.mdatMs;
          entry.result = 'refreshed';
        } else {
          entry.result = 'no_progress';
          entry.notice = await sendNotice('notify_login', 'fallback_a_no_progress');
        }
      } catch (error) {
        rethrowWriteFailure(error);
        entry.result = reasonCode(error, 'fallback_a_failed');
        entry.notice = await sendNotice('notify_login', entry.result);
      }
    } else if (decision.action !== 'none') {
      entry.notice = await sendNotice(decision.action, decision.reason);
    }
    await persist();
  }
  return report;
}
