#!/usr/bin/env node
// Checks an installed Claude Code binary for the strings claude-rotator relies on.
//
// The binary is only read, never run: no child process, no network, no file
// writes. The script reads the file in chunks, looks for each expected string,
// and reports per item whether the strings are still there:
//   ok      every string of the item was found
//   warn    at least one string of the item is missing (or, for fable-ids, an
//           unlisted canonical-looking Fable model id was found)
//   unknown the file could not be judged at all (see REASONS); every item is
//           then reported as unknown
//
// A string being present does not prove the contract still holds (the binary
// also bundles libraries that may contain the same words); a string being
// absent is the useful signal.
//
// The table below duplicates strings from src/. The test suite checks that
// every string in the table still appears in the source file it names,
// compares the exported OAuth and session id header constants by value, and
// compares the refresh child's environment variables, the canonical Fable ids
// and the quoted x-claude-code-* request header names in src/ in both
// directions.
//
// Usage: node scripts/claude-update-compat.js <path-to-binary>
// Exit codes: 0 ok, 1 warn, 2 unknown, 64 usage error.

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = 1;
export const TOOL_NAME = 'claude-update-compat';

export const EXIT_OK = 0;
export const EXIT_WARN = 1;
export const EXIT_UNKNOWN = 2;
export const EXIT_USAGE = 64;

export const REASONS = Object.freeze({
  notFound: 'not-found',
  notAFile: 'not-a-file',
  empty: 'empty',
  readError: 'read-error',
  versionUnknown: 'version-unknown',
  unreadableForm: 'unreadable-form',
  internalError: 'internal-error',
});

// Items checked by plain string presence. `caseInsensitive` is used only for
// HTTP header names. `sources` are the files in this repository the strings
// come from.
export const STRING_CHECKS = Object.freeze([
  {
    id: 'base-url-env',
    description: 'Environment variables that point Claude Code at the local proxy',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/install.js'],
    strings: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  },
  {
    id: 'refresh-token-env',
    description: 'Environment variables that hand a refresh token to the native refresh child',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/native-claude-refresher.js'],
    strings: ['CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES'],
  },
  {
    id: 'refresh-child-args',
    description: 'Command-line flag used to start the native refresh child',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/native-claude-refresher.js'],
    strings: ['--claudeai'],
  },
  {
    id: 'child-isolation-env',
    description: 'Environment variables that keep the refresh child inside its sandbox',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/native-claude-refresher.js'],
    strings: [
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_SECURESTORAGE_CONFIG_DIR',
      'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
      'CLAUDE_TMPDIR',
    ],
  },
  {
    id: 'child-quiet-env',
    description: 'Environment variables that keep the refresh child quiet',
    weight: 'low',
    caseInsensitive: false,
    sources: ['src/native-claude-refresher.js'],
    strings: [
      'CLAUDE_CODE_MAX_RETRIES',
      'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
      'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
      'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS',
      'CLAUDE_CODE_DISABLE_WORKFLOWS',
      'CLAUDE_CODE_DISABLE_CRON',
      'CLAUDE_CODE_DISABLE_AGENT_VIEW',
      'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
      'CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING',
      'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
      'CLAUDE_CODE_AUTO_CONNECT_IDE',
      'DISABLE_AUTOUPDATER',
      'DISABLE_TELEMETRY',
      'DISABLE_ERROR_REPORTING',
      'DO_NOT_TRACK',
    ],
  },
  {
    id: 'credential-store',
    description: 'Where Claude Code keeps its OAuth credentials',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/claude-credentials.js', 'src/native-claude-refresher.js'],
    strings: ['claude-code-user', '.credentials.json', 'claudeAiOauth'],
  },
  {
    id: 'expiry-fields',
    description: 'Fields that carry the refresh token expiry',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/claude-credentials.js', 'src/oauth.js'],
    strings: ['refreshTokenExpiresAt', 'refresh_token_expires_in'],
  },
  {
    id: 'credential-fields',
    description: 'Credential fields read by the rotator',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/claude-credentials.js'],
    strings: ['subscriptionType', 'rateLimitTier'],
  },
  {
    id: 'oauth-client-id',
    description: 'OAuth client id',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/oauth.js'],
    strings: ['9d1c250a-e61b-44d9-88ed-5944d1962f5e'],
  },
  {
    id: 'oauth-token-url',
    description: 'OAuth token endpoint',
    weight: 'high',
    caseInsensitive: false,
    sources: ['src/oauth.js'],
    strings: ['https://platform.claude.com/v1/oauth/token'],
  },
  {
    id: 'oauth-api-paths',
    description: 'Profile and usage API paths',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/oauth.js'],
    strings: ['/api/oauth/profile', '/api/oauth/usage'],
  },
  {
    id: 'oauth-scopes',
    description: 'OAuth scopes requested on refresh',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/oauth.js'],
    strings: [
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
    ],
  },
  {
    id: 'oauth-beta',
    description: 'OAuth beta header value',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/oauth.js'],
    strings: ['oauth-2025-04-20'],
  },
  {
    id: 'session-header',
    description: 'Request header that carries the session id',
    weight: 'high',
    caseInsensitive: true,
    sources: ['src/session-key.js'],
    strings: ['x-claude-code-session-id'],
  },
  {
    id: 'ratelimit-headers',
    description: 'Rate limit response headers the rotator writes on a synthetic 429',
    weight: 'medium',
    caseInsensitive: true,
    sources: ['src/proxy-server.js'],
    strings: [
      'anthropic-ratelimit-unified-status',
      'anthropic-ratelimit-unified-representative-claim',
      'anthropic-ratelimit-unified-reset',
    ],
  },
  {
    id: 'messages-path',
    description: 'Request path whose usage the rotator measures',
    weight: 'medium',
    caseInsensitive: false,
    sources: ['src/proxy-server.js'],
    strings: ['/v1/messages'],
  },
  {
    id: 'request-class-header',
    description: 'Request header the proxy reads to set the request class it logs as rc=',
    weight: 'low',
    caseInsensitive: true,
    sources: ['src/proxy-server.js'],
    strings: ['x-claude-code-request-class'],
  },
]);

// Canonical Fable model ids the rotator knows (src/proxy-server.js). A known id
// that disappears does not break the rotator. A new canonical-looking id
// matters because the proxy's exact canonical-id check, which gates reactive
// Usage confirmation, would not match it (account routing still treats any
// claude-fable-<digit> id as Fable).
export const FABLE_CHECK = Object.freeze({
  id: 'fable-ids',
  description: 'Canonical Fable model ids not known to the rotator',
  weight: 'medium',
  sources: ['src/proxy-server.js'],
  known: ['claude-fable-5', 'claude-fable-5-1'],
});
const FABLE_PREFIX = 'claude-fable-';
// claude-fable-<1-2 digits>, optionally -<1-2 digits>, not followed by '-' or a
// digit. Date- or build-suffixed ids are deliberately not counted.
const FABLE_ID_PATTERN = /claude-fable-\d{1,2}(?:-\d{1,2})?(?![-\d])/g;
const LONGEST_FABLE_ID = FABLE_PREFIX.length + 2 + 1 + 2;

// The User-Agent version the rotator sends (src/oauth.js). Reported next to the
// binary version for information only.
export const ROTATOR_USER_AGENT_VERSION = '2.1.201';

const VERSION_NAME_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const LONGEST_VERSION_NAME = 6 * 3 + 2;

const ALL_STRINGS = STRING_CHECKS.flatMap(check => check.strings);
export const TOTAL_STRINGS = ALL_STRINGS.length;
// Fewer found strings than this means the file is not in a form this script can
// read (compressed, split, or a different format), not that half the contract
// changed at once.
export const MIN_FOUND_STRINGS = Math.ceil(TOTAL_STRINGS / 2);

// Each chunk starts with the last OVERLAP_BYTES of the previous chunk, so a
// string or id that spans the boundary is still seen whole. It must be longer
// than the longest string, the version name, and the longest id plus the one
// character the id pattern looks at after it.
export const OVERLAP_BYTES = Math.max(
  ...ALL_STRINGS.map(value => value.length),
  LONGEST_VERSION_NAME,
  LONGEST_FABLE_ID + 1,
) + 1;
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export const USAGE = `Usage: node scripts/claude-update-compat.js <path-to-claude-code-binary>
       node scripts/claude-update-compat.js --help

Reads an installed Claude Code binary without running it and checks that the
strings claude-rotator depends on are still present. The path may be a symlink;
the file it resolves to must be named after its version (for example 2.1.0).

Output: one JSON line on stdout and a short summary on stderr.
Exit codes: 0 every item ok, 1 at least one item warns, 2 the file could not be
judged (unreadable input or an internal error), 64 usage error.
`;

function newTarget(path) {
  return { path, resolved: null, version: null, bytes: null, sha256: null };
}

function unknownReport(target, reason) {
  return {
    schema: SCHEMA_VERSION,
    tool: TOOL_NAME,
    result: 'unknown',
    reason,
    target,
    checks: [
      ...STRING_CHECKS.map(check => ({ id: check.id, weight: check.weight, status: 'unknown', missing: [] })),
      { id: FABLE_CHECK.id, weight: FABLE_CHECK.weight, status: 'unknown', known: {}, unexpected: [] },
    ],
    info: [{ id: 'user-agent-version', rotator: ROTATOR_USER_AGENT_VERSION, distribution: target.version }],
  };
}

function isSystemError(error) {
  return typeof error?.code === 'string';
}

function lowerAscii(source, length, out) {
  for (let i = 0; i < length; i++) {
    const byte = source[i];
    out[i] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
}

function scanChunk(state, chunk, isLast) {
  for (const needle of state.pending) {
    if (chunk.indexOf(needle.bytes) !== -1) state.pending.delete(needle);
  }
  if (state.pendingInsensitive.size > 0) {
    const lower = state.lower.subarray(0, chunk.length);
    lowerAscii(chunk, chunk.length, lower);
    for (const needle of state.pendingInsensitive) {
      if (lower.indexOf(needle.bytes) !== -1) state.pendingInsensitive.delete(needle);
    }
  }
  if (chunk.indexOf(FABLE_PREFIX) === -1) return;
  // A match that starts inside the tail overlap is skipped here: the next chunk
  // begins with the same bytes and sees it whole, together with what follows.
  const keepBefore = isLast ? Infinity : chunk.length - OVERLAP_BYTES;
  const text = chunk.toString('latin1');
  for (const match of text.matchAll(FABLE_ID_PATTERN)) {
    if (match.index >= keepBefore) continue;
    state.fableIds.add(match[0]);
  }
}

function inspectInto(target, { chunkBytes = DEFAULT_CHUNK_BYTES, readImpl = readSync } = {}) {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= OVERLAP_BYTES) {
    throw new RangeError(`chunkBytes must be an integer greater than ${OVERLAP_BYTES}`);
  }

  try {
    target.resolved = realpathSync(target.path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return unknownReport(target, REASONS.notFound);
    if (isSystemError(error)) return unknownReport(target, REASONS.readError);
    throw error;
  }

  let stat;
  try {
    stat = statSync(target.resolved);
  } catch (error) {
    if (isSystemError(error)) return unknownReport(target, REASONS.readError);
    throw error;
  }
  if (!stat.isFile()) return unknownReport(target, REASONS.notAFile);
  target.bytes = stat.size;
  if (stat.size === 0) return unknownReport(target, REASONS.empty);
  const name = basename(target.resolved);
  if (!VERSION_NAME_PATTERN.test(name)) return unknownReport(target, REASONS.versionUnknown);
  target.version = name;

  const versionNeedle = { value: name, bytes: Buffer.from(name, 'latin1') };
  const sensitive = [];
  const insensitive = [];
  for (const check of STRING_CHECKS) {
    for (const value of check.strings) {
      const needle = { check: check.id, value, bytes: Buffer.from(check.caseInsensitive ? value.toLowerCase() : value, 'latin1') };
      (check.caseInsensitive ? insensitive : sensitive).push(needle);
    }
  }
  const state = {
    pending: new Set([versionNeedle, ...sensitive]),
    pendingInsensitive: new Set(insensitive),
    fableIds: new Set(),
    lower: Buffer.alloc(chunkBytes + OVERLAP_BYTES),
  };

  const hash = createHash('sha256');
  const chunk = Buffer.alloc(chunkBytes + OVERLAP_BYTES);
  let fd;
  try {
    fd = openSync(target.resolved, 'r');
  } catch (error) {
    if (isSystemError(error)) return unknownReport(target, REASONS.readError);
    throw error;
  }
  let position = 0;
  try {
    if (!fstatSync(fd).isFile()) return unknownReport(target, REASONS.notAFile);
    let carry = 0;
    for (;;) {
      let read;
      try {
        read = readImpl(fd, chunk, carry, chunkBytes, position);
      } catch (error) {
        if (isSystemError(error)) return unknownReport(target, REASONS.readError);
        throw error;
      }
      if (!Number.isInteger(read) || read < 0 || read > chunkBytes) {
        throw new TypeError(`read returned an invalid byte count: ${read}`);
      }
      if (read === 0) break;
      position += read;
      const length = carry + read;
      hash.update(chunk.subarray(carry, length));
      scanChunk(state, chunk.subarray(0, length), position >= stat.size);
      const keep = Math.min(OVERLAP_BYTES, length);
      chunk.copy(chunk, 0, length - keep, length);
      carry = keep;
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing was written; a failed close does not change what was read.
    }
  }
  if (position !== stat.size) return unknownReport(target, REASONS.readError);
  target.sha256 = hash.digest('hex');

  const missing = new Set([...state.pending, ...state.pendingInsensitive]);
  if (missing.has(versionNeedle)) return unknownReport(target, REASONS.unreadableForm);
  missing.delete(versionNeedle);
  if (TOTAL_STRINGS - missing.size < MIN_FOUND_STRINGS) return unknownReport(target, REASONS.unreadableForm);

  const missingByCheck = new Map(STRING_CHECKS.map(check => [check.id, new Set()]));
  for (const needle of missing) missingByCheck.get(needle.check).add(needle.value);
  const checks = STRING_CHECKS.map(check => {
    const absent = check.strings.filter(value => missingByCheck.get(check.id).has(value));
    return { id: check.id, weight: check.weight, status: absent.length === 0 ? 'ok' : 'warn', missing: absent };
  });
  const known = Object.fromEntries(FABLE_CHECK.known.map(id => [id, state.fableIds.has(id)]));
  const unexpected = [...state.fableIds].filter(id => !FABLE_CHECK.known.includes(id)).sort();
  checks.push({
    id: FABLE_CHECK.id,
    weight: FABLE_CHECK.weight,
    status: unexpected.length === 0 ? 'ok' : 'warn',
    known,
    unexpected,
  });

  return {
    schema: SCHEMA_VERSION,
    tool: TOOL_NAME,
    result: checks.some(check => check.status === 'warn') ? 'warn' : 'ok',
    reason: null,
    target,
    checks,
    info: [{ id: 'user-agent-version', rotator: ROTATOR_USER_AGENT_VERSION, distribution: target.version }],
  };
}

/**
 * Inspects one binary. Returns the report object written by the CLI.
 * `chunkBytes` and `readImpl` (same signature as fs.readSync) exist for tests.
 * Throws on unexpected errors; the CLI turns those into an internal-error report.
 */
export function inspectDistribution(path, options = {}) {
  return inspectInto(newTarget(path), options);
}

export function exitCodeFor(report) {
  if (report.result === 'unknown') return EXIT_UNKNOWN;
  if (report.result === 'warn') return EXIT_WARN;
  return EXIT_OK;
}

export function formatSummary(report) {
  const head = [`${TOOL_NAME}: ${report.result}`, `version ${report.target.version ?? 'unknown'}`];
  if (report.reason) head.push(`reason ${report.reason}`);
  const lines = [head.join(', ')];
  for (const check of report.checks) {
    let detail = '';
    if (check.id === FABLE_CHECK.id) {
      const parts = [];
      if (check.unexpected.length > 0) parts.push(`unexpected: ${check.unexpected.join(', ')}`);
      const absent = Object.entries(check.known).filter(([, seen]) => !seen).map(([id]) => id);
      if (absent.length > 0) parts.push(`known id not seen: ${absent.join(', ')}`);
      if (parts.length > 0) detail = ` - ${parts.join('; ')}`;
    } else if (check.missing.length > 0) {
      detail = ` - missing: ${check.missing.join(', ')}`;
    }
    lines.push(`  ${check.status.padEnd(7)} ${check.id} (${check.weight})${detail}`);
  }
  for (const item of report.info) {
    lines.push(`  info    ${item.id}: rotator ${item.rotator}, binary ${item.distribution ?? 'unknown'}`);
  }
  return `${lines.join('\n')}\n`;
}

function writeReport(report, stdout, stderr, extra = '') {
  stdout.write(`${JSON.stringify(report)}\n`);
  stderr.write(formatSummary(report) + extra);
}

/**
 * Runs the command line. `stdout` and `stderr` need a write(string) method.
 * Returns the exit code. Never throws for an inspected path: unexpected errors
 * become an internal-error report with exit code 2.
 */
export function runCli(argv, { stdout, stderr, ...inspectOptions }) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout.write(USAGE);
    return EXIT_OK;
  }
  if (argv.length !== 1 || argv[0].startsWith('-') || argv[0] === '') {
    stderr.write(USAGE);
    return EXIT_USAGE;
  }
  const target = newTarget(argv[0]);
  let report;
  try {
    report = inspectInto(target, inspectOptions);
  } catch (error) {
    report = unknownReport(target, REASONS.internalError);
    writeReport(report, stdout, stderr, `  error: ${error?.message ?? String(error)}\n`);
    return EXIT_UNKNOWN;
  }
  writeReport(report, stdout, stderr);
  return exitCodeFor(report);
}

function invokedAsCli() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  const argv = process.argv.slice(2);
  let finished = false;
  const fail = error => {
    if (finished) return;
    finished = true;
    const report = unknownReport(newTarget(argv.length === 1 ? argv[0] : null), REASONS.internalError);
    try {
      writeSync(1, `${JSON.stringify(report)}\n`);
      writeSync(2, `${formatSummary(report)}  error: ${error?.message ?? String(error)}\n`);
    } finally {
      process.exit(EXIT_UNKNOWN);
    }
  };
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  try {
    process.exitCode = runCli(argv, { stdout: process.stdout, stderr: process.stderr });
    finished = true;
  } catch (error) {
    fail(error);
  }
}
