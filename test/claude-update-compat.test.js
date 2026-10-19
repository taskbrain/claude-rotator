// Tests for scripts/claude-update-compat.js.
//
// Every input is a small synthetic file built here from the rotator's own
// strings and filler bytes. No real Claude Code binary is read, and the only
// child processes are node running the script itself (with the service command
// guard imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  DEFAULT_CHUNK_BYTES,
  EXIT_OK,
  EXIT_UNKNOWN,
  EXIT_USAGE,
  EXIT_WARN,
  FABLE_CHECK,
  MIN_FOUND_STRINGS,
  OVERLAP_BYTES,
  REASONS,
  ROTATOR_USER_AGENT_VERSION,
  STRING_CHECKS,
  TOTAL_STRINGS,
  inspectDistribution,
  runCli,
} from '../scripts/claude-update-compat.js';
import {
  CLAUDE_AI_OAUTH_SCOPES,
  OAUTH_BETA_HEADER,
  OAUTH_CLIENT_ID,
  OAUTH_PROFILE_URL,
  OAUTH_SCOPES,
  OAUTH_TOKEN_URL,
  OAUTH_USAGE_URL,
  OAUTH_USER_AGENT,
} from '../src/oauth.js';
import { DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS } from '../src/native-claude-refresher.js';
import { SESSION_ID_HEADER } from '../src/session-key.js';
import { setupCodexIsolation } from './codex/helpers/isolation.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/claude-update-compat.js', import.meta.url));
const GUARD_PATH = fileURLToPath(new URL('../fixtures/service-command-guard.js', import.meta.url));

const VERSION = '9.9.9';
const FILLER = '\u0000|~~|\u0000';
const ALL_STRINGS = STRING_CHECKS.flatMap(check => check.strings);
const CHECK_IDS = [...STRING_CHECKS.map(check => check.id), FABLE_CHECK.id];
const NEW_FABLE_ID = 'claude-fable-6';
const DATED_FABLE_ID = 'claude-fable-5-20260818';
const LONGEST_STRING = ALL_STRINGS.reduce((a, b) => (b.length > a.length ? b : a));

// Builds a synthetic binary. `strings` defaults to every checked string in the
// form the rotator uses; `replace` swaps single strings; `extra` is appended.
function fixtureText({
  strings = ALL_STRINGS,
  omit = [],
  replace = {},
  extra = [],
  version = VERSION,
  fableIds = FABLE_CHECK.known,
} = {}) {
  const parts = ['head'];
  if (version) parts.push(version);
  for (const value of strings) {
    if (omit.includes(value)) continue;
    parts.push(Object.hasOwn(replace, value) ? replace[value] : value);
  }
  parts.push(...fableIds, ...extra, 'tail');
  return parts.join(FILLER);
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-update-compat-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFixture(dir, content, name = VERSION) {
  const path = join(dir, name);
  await writeFile(path, typeof content === 'string' ? Buffer.from(content, 'latin1') : content);
  return path;
}

function sink() {
  const stream = {
    text: '',
    write(chunk) {
      stream.text += chunk;
      return true;
    },
  };
  return stream;
}

function runInProcess(args, options = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = runCli(args, { stdout, stderr, ...options });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function runChild(args) {
  const result = spawnSync(process.execPath, ['--import', GUARD_PATH, SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseOneLine(stdout) {
  const lines = stdout.split('\n');
  assert.equal(lines.length, 2, 'stdout must be exactly one line ending in a newline');
  assert.equal(lines[1], '');
  return JSON.parse(lines[0]);
}

function checkById(report, id) {
  const check = report.checks.find(item => item.id === id);
  assert.ok(check, `missing check ${id}`);
  return check;
}

function assertAllOk(report) {
  assert.equal(report.result, 'ok');
  assert.equal(report.reason, null);
  for (const check of report.checks) assert.equal(check.status, 'ok', check.id);
}

function assertAllUnknown(report, reason) {
  assert.equal(report.result, 'unknown');
  assert.equal(report.reason, reason);
  assert.deepEqual(report.checks.map(check => check.id), CHECK_IDS);
  for (const check of report.checks) {
    assert.equal(check.status, 'unknown', check.id);
    if (check.id === FABLE_CHECK.id) {
      assert.deepEqual(check.known, {});
      assert.deepEqual(check.unexpected, []);
    } else {
      assert.deepEqual(check.missing, []);
    }
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

test('a binary with every expected string is ok, both in process and as a CLI', async t => {
  const dir = await tempDir(t);
  const path = await writeFixture(dir, fixtureText());

  const inProcess = runInProcess([path]);
  assert.equal(inProcess.code, EXIT_OK);
  const report = parseOneLine(inProcess.stdout);
  assertAllOk(report);
  assert.deepEqual(report.checks.map(check => check.id), CHECK_IDS);
  assert.deepEqual(checkById(report, FABLE_CHECK.id).known, { 'claude-fable-5': true, 'claude-fable-5-1': true });
  assert.deepEqual(report.info, [{ id: 'user-agent-version', rotator: ROTATOR_USER_AGENT_VERSION, distribution: VERSION }]);

  const child = runChild([path]);
  assert.equal(child.code, EXIT_OK, child.stderr);
  assert.deepEqual(parseOneLine(child.stdout), report);
});

test('removing the strings of one item makes only that item warn', async t => {
  const dir = await tempDir(t);
  for (const target of STRING_CHECKS) {
    const path = await writeFixture(dir, fixtureText({ omit: target.strings }));
    const run = runInProcess([path]);
    assert.equal(run.code, EXIT_WARN, target.id);
    const report = parseOneLine(run.stdout);
    assert.equal(report.result, 'warn');
    for (const check of report.checks) {
      if (check.id === target.id) {
        assert.equal(check.status, 'warn', check.id);
        assert.deepEqual(check.missing, target.strings);
      } else {
        assert.equal(check.status, 'ok', `${check.id} while removing ${target.id}`);
      }
    }
  }
});

test('removing a single string of an item lists only that string as missing', async t => {
  const dir = await tempDir(t);
  const target = STRING_CHECKS.find(check => check.strings.length > 1);
  const path = await writeFixture(dir, fixtureText({ omit: [target.strings[1]] }));
  const report = inspectDistribution(path);
  assert.equal(report.result, 'warn');
  assert.deepEqual(checkById(report, target.id).missing, [target.strings[1]]);
});

test('an unlisted canonical Fable id warns; a date-suffixed id does not', async t => {
  const dir = await tempDir(t);
  const added = inspectDistribution(await writeFixture(dir, fixtureText({ extra: [NEW_FABLE_ID] })));
  assert.equal(added.result, 'warn');
  const fable = checkById(added, FABLE_CHECK.id);
  assert.equal(fable.status, 'warn');
  assert.deepEqual(fable.unexpected, [NEW_FABLE_ID]);
  for (const check of added.checks) if (check.id !== FABLE_CHECK.id) assert.equal(check.status, 'ok');

  for (const id of [DATED_FABLE_ID, 'claude-fable-5-1-20260901', 'claude-fable-123']) {
    const dated = inspectDistribution(await writeFixture(dir, fixtureText({ extra: [id] })));
    assertAllOk(dated);
    assert.deepEqual(checkById(dated, FABLE_CHECK.id).unexpected, []);
  }

  const twoPart = inspectDistribution(await writeFixture(dir, fixtureText({ extra: ['claude-fable-6-2'] })));
  assert.deepEqual(checkById(twoPart, FABLE_CHECK.id).unexpected, ['claude-fable-6-2']);
});

test('a known Fable id that disappears stays ok and is reported as not seen', async t => {
  const dir = await tempDir(t);
  const [first, second] = FABLE_CHECK.known;
  const report = inspectDistribution(await writeFixture(dir, fixtureText({ fableIds: [second] })));
  assertAllOk(report);
  const fable = checkById(report, FABLE_CHECK.id);
  assert.deepEqual(fable.known, { [first]: false, [second]: true });
  assert.deepEqual(fable.unexpected, []);

  const none = inspectDistribution(await writeFixture(dir, fixtureText({ fableIds: [] })));
  assertAllOk(none);
  assert.deepEqual(checkById(none, FABLE_CHECK.id).known, { [first]: false, [second]: false });
});

test('header names match in any case; other strings are case-sensitive', async t => {
  const dir = await tempDir(t);
  const header = inspectDistribution(await writeFixture(dir, fixtureText({
    replace: {
      'x-claude-code-session-id': 'X-Claude-Code-Session-Id',
      'anthropic-ratelimit-unified-status': 'Anthropic-RateLimit-Unified-Status',
    },
  })));
  assertAllOk(header);

  const lowered = inspectDistribution(await writeFixture(dir, fixtureText({
    replace: { ANTHROPIC_BASE_URL: 'anthropic_base_url' },
  })));
  assert.equal(lowered.result, 'warn');
  assert.deepEqual(checkById(lowered, 'base-url-env').missing, ['ANTHROPIC_BASE_URL']);
});

test('the chunk size must be larger than the overlap', async t => {
  const dir = await tempDir(t);
  const path = await writeFixture(dir, fixtureText());
  assert.throws(() => inspectDistribution(path, { chunkBytes: OVERLAP_BYTES }), RangeError);
  assert.throws(() => inspectDistribution(path, { chunkBytes: 1 }), RangeError);
  assert.throws(() => inspectDistribution(path, { chunkBytes: OVERLAP_BYTES + 0.5 }), RangeError);
  assertAllOk(inspectDistribution(path, { chunkBytes: OVERLAP_BYTES + 1 }));
  assert.ok(DEFAULT_CHUNK_BYTES > OVERLAP_BYTES);
});

test('ids and strings are found at every offset across chunk and overlap boundaries', async t => {
  const dir = await tempDir(t);
  const chunkBytes = OVERLAP_BYTES + 11;
  const cases = [
    { token: NEW_FABLE_ID, base: fixtureText(), expectUnexpected: [NEW_FABLE_ID] },
    { token: DATED_FABLE_ID, base: fixtureText(), expectUnexpected: [] },
    { token: LONGEST_STRING, base: fixtureText({ omit: [LONGEST_STRING] }), expectUnexpected: [] },
    {
      token: 'X-Claude-Code-Session-Id',
      base: fixtureText({ omit: ['x-claude-code-session-id'] }),
      expectUnexpected: [],
    },
  ];
  // Offsets from 0 to two chunks cover the overlap start and the chunk end of
  // the first two chunks, and every offset relative to a chunk.
  for (const { token, base, expectUnexpected } of cases) {
    for (let offset = 0; offset <= 2 * chunkBytes; offset++) {
      const content = `${'.'.repeat(offset)}${token} ${base}`;
      const report = inspectDistribution(await writeFixture(dir, content), { chunkBytes });
      const label = `${token} at ${offset}`;
      assert.equal(report.result, expectUnexpected.length > 0 ? 'warn' : 'ok', label);
      for (const check of report.checks) {
        if (check.id === FABLE_CHECK.id) {
          assert.deepEqual(check.unexpected, expectUnexpected, label);
          assert.equal(check.status, expectUnexpected.length > 0 ? 'warn' : 'ok', label);
        } else {
          assert.equal(check.status, 'ok', `${check.id}: ${label}`);
        }
      }
    }
  }
});

test('ids in the last overlap of the file are judged correctly, including a size that is a multiple of the chunk', async t => {
  const dir = await tempDir(t);
  const chunkBytes = OVERLAP_BYTES + 11;
  const base = fixtureText();
  for (const [token, expected] of [[NEW_FABLE_ID, [NEW_FABLE_ID]], [DATED_FABLE_ID, []]]) {
    let sawMultiple = false;
    for (let pad = 0; pad <= chunkBytes + OVERLAP_BYTES; pad++) {
      const content = `${base}${'.'.repeat(pad)}${token}`;
      if (content.length % chunkBytes === 0) sawMultiple = true;
      const report = inspectDistribution(await writeFixture(dir, content), { chunkBytes });
      assert.deepEqual(checkById(report, FABLE_CHECK.id).unexpected, expected, `${token} with pad ${pad}`);
    }
    assert.ok(sawMultiple, 'one case must have a file size that is a multiple of the chunk size');
  }
});

test('short reads still find everything', async t => {
  const dir = await tempDir(t);
  const shortRead = (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, Math.min(length, 7), position);
  for (const offset of [0, 3, 40, 97]) {
    const content = `${'.'.repeat(offset)}${NEW_FABLE_ID} ${fixtureText()}${DATED_FABLE_ID}`;
    const report = inspectDistribution(await writeFixture(dir, content), { chunkBytes: OVERLAP_BYTES + 5, readImpl: shortRead });
    assert.equal(report.result, 'warn');
    assert.deepEqual(checkById(report, FABLE_CHECK.id).unexpected, [NEW_FABLE_ID]);
    for (const check of report.checks) if (check.id !== FABLE_CHECK.id) assert.equal(check.status, 'ok', check.id);
    assert.equal(report.target.sha256, sha256(Buffer.from(content, 'latin1')));
  }
});

test('inputs that cannot be judged are unknown with the matching reason', async t => {
  const dir = await tempDir(t);
  const full = Buffer.from(fixtureText(), 'latin1');
  const folder = join(dir, 'folder', VERSION);
  await mkdir(folder, { recursive: true });
  await mkdir(join(dir, 'empty'));
  await mkdir(join(dir, 'gzip'));
  const cases = [
    { name: 'missing path', path: join(dir, 'absent', VERSION), reason: REASONS.notFound },
    { name: 'directory', path: folder, reason: REASONS.notAFile },
    { name: 'empty file', path: await writeFixture(join(dir, 'empty'), ''), reason: REASONS.empty },
    { name: 'name claude', path: await writeFixture(dir, full, 'claude'), reason: REASONS.versionUnknown },
    { name: 'name cli.js', path: await writeFixture(dir, full, 'cli.js'), reason: REASONS.versionUnknown },
    {
      name: 'version name absent',
      path: await writeFixture(dir, fixtureText({ version: null })),
      reason: REASONS.unreadableForm,
    },
    { name: 'gzip-compressed', path: await writeFixture(join(dir, 'gzip'), gzipSync(full)), reason: REASONS.unreadableForm },
  ];
  for (const { name, path, reason } of cases) {
    const run = runInProcess([path]);
    assert.equal(run.code, EXIT_UNKNOWN, name);
    const report = parseOneLine(run.stdout);
    assertAllUnknown(report, reason);
    assert.equal(report.target.path, path, name);
    assert.ok(run.stderr.startsWith('claude-update-compat: unknown'), name);
  }

  const missing = parseOneLine(runInProcess([cases[0].path]).stdout);
  assert.deepEqual(missing.target, { path: cases[0].path, resolved: null, version: null, bytes: null, sha256: null });
  const empty = parseOneLine(runInProcess([cases[2].path]).stdout);
  assert.equal(empty.target.bytes, 0);
  assert.equal(empty.target.sha256, null);
  const unnamed = parseOneLine(runInProcess([cases[3].path]).stdout);
  assert.equal(unnamed.target.version, null);
  assert.equal(unnamed.target.bytes, full.length);
  assert.equal(unnamed.target.sha256, null);
  const noVersion = parseOneLine(runInProcess([cases[5].path]).stdout);
  assert.equal(noVersion.target.version, VERSION);
  assert.equal(noVersion.target.sha256, sha256(Buffer.from(fixtureText({ version: null }), 'latin1')));

  const child = runChild([cases[0].path]);
  assert.equal(child.code, EXIT_UNKNOWN);
  assertAllUnknown(parseOneLine(child.stdout), REASONS.notFound);
});

test('fewer than half of the strings found is unknown; exactly the minimum is a warning', async t => {
  const dir = await tempDir(t);
  const below = inspectDistribution(await writeFixture(dir, fixtureText({ strings: ALL_STRINGS.slice(0, MIN_FOUND_STRINGS - 1) })));
  assertAllUnknown(below, REASONS.unreadableForm);
  assert.equal(below.target.version, VERSION);

  const atMinimum = inspectDistribution(await writeFixture(dir, fixtureText({ strings: ALL_STRINGS.slice(0, MIN_FOUND_STRINGS) })));
  assert.equal(atMinimum.result, 'warn');
  const missing = atMinimum.checks.flatMap(check => check.missing ?? []);
  assert.equal(missing.length, TOTAL_STRINGS - MIN_FOUND_STRINGS);
  assert.ok(MIN_FOUND_STRINGS * 2 >= TOTAL_STRINGS && (MIN_FOUND_STRINGS - 1) * 2 < TOTAL_STRINGS);
});

test('usage errors exit 64 with usage on stderr and nothing on stdout; --help exits 0', async () => {
  for (const args of [[], ['one', 'two'], ['--bogus'], ['--help', 'extra']]) {
    const child = runChild(args);
    assert.equal(child.code, EXIT_USAGE, JSON.stringify(args));
    assert.equal(child.stdout, '', JSON.stringify(args));
    assert.notEqual(child.stderr, '', JSON.stringify(args));
    assert.match(child.stderr, /^Usage: /);
  }
  const help = runChild(['--help']);
  assert.equal(help.code, EXIT_OK);
  assert.match(help.stdout, /^Usage: /);
  assert.equal(help.stderr, '');
  assert.throws(() => JSON.parse(help.stdout));
});

test('every inspected run prints one JSON line with the documented shape and a summary per item', async t => {
  const dir = await tempDir(t);
  const okContent = Buffer.from(fixtureText(), 'latin1');
  const warnContent = Buffer.from(fixtureText({ omit: ['DO_NOT_TRACK'] }), 'latin1');
  await mkdir(join(dir, 'ok'));
  await mkdir(join(dir, 'warn'));
  const runs = [
    { path: await writeFixture(join(dir, 'ok'), okContent), code: EXIT_OK, content: okContent },
    { path: await writeFixture(join(dir, 'warn'), warnContent), code: EXIT_WARN, content: warnContent },
    { path: join(dir, 'absent', VERSION), code: EXIT_UNKNOWN, content: null },
  ];
  for (const { path, code, content } of runs) {
    const child = runChild([path]);
    assert.equal(child.code, code, child.stderr);
    const report = parseOneLine(child.stdout);
    assert.deepEqual(Object.keys(report), ['schema', 'tool', 'result', 'reason', 'target', 'checks', 'info']);
    assert.equal(report.schema, 1);
    assert.equal(report.tool, 'claude-update-compat');
    assert.deepEqual(Object.keys(report.target), ['path', 'resolved', 'version', 'bytes', 'sha256']);
    for (const check of report.checks) {
      const keys = check.id === FABLE_CHECK.id
        ? ['id', 'weight', 'status', 'known', 'unexpected']
        : ['id', 'weight', 'status', 'missing'];
      assert.deepEqual(Object.keys(check), keys);
      assert.ok(['high', 'medium', 'low'].includes(check.weight));
    }
    assert.deepEqual(report.info.map(item => item.id), ['user-agent-version']);
    if (content) {
      assert.equal(report.target.bytes, content.length);
      assert.equal(report.target.sha256, sha256(content));
      assert.equal(report.target.version, VERSION);
    }
    const lines = child.stderr.trimEnd().split('\n');
    assert.match(lines[0], new RegExp(`^claude-update-compat: ${report.result}, version `));
    assert.equal(lines.length, 1 + report.checks.length + report.info.length);
  }
});

test('the script reads the binary without child processes, fetch or sockets', async t => {
  const dir = await tempDir(t);
  const path = await writeFixture(dir, fixtureText());
  const isolation = await setupCodexIsolation(t);
  const report = inspectDistribution(path);
  assertAllOk(report);
  assert.deepEqual(isolation.refusedChildProcesses, []);
  assert.deepEqual(isolation.fetchCalls, []);
  assert.deepEqual(isolation.refusedConnections, []);
  assert.deepEqual(isolation.connections, []);
  assert.deepEqual(isolation.refusedRequests, []);
  assert.deepEqual(isolation.refusedSpawns, []);
});

test('the script source imports only fs, crypto, path and url and never calls fetch', async () => {
  const source = await readFile(SCRIPT_PATH, 'utf8');
  const imported = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.ok(imported.length > 0);
  for (const name of imported) assert.ok(['node:crypto', 'node:fs', 'node:path', 'node:url'].includes(name), name);
  assert.doesNotMatch(source, /child_process|node:net|node:http|node:https|node:dgram|node:tls|node:dns|worker_threads/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.doesNotMatch(source, /\brequire\s*\(/);
});

async function sourceText(file) {
  return readFile(join(REPO_ROOT, file), 'utf8');
}

function extracted(values, what) {
  assert.ok(values.length > 0, `nothing was extracted for ${what}`);
  return values;
}

test('every checked string still appears in the rotator source it comes from', async () => {
  for (const check of [...STRING_CHECKS, FABLE_CHECK]) {
    const texts = await Promise.all(check.sources.map(sourceText));
    const values = check.strings ?? check.known;
    for (const value of values) {
      assert.ok(texts.some(text => text.includes(value)), `${check.id}: ${value} not found in ${check.sources.join(', ')}`);
    }
  }
});

test('exported rotator constants match the table by value', () => {
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'oauth-client-id').strings, [OAUTH_CLIENT_ID]);
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'oauth-token-url').strings, [OAUTH_TOKEN_URL]);
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'oauth-api-paths').strings,
    [new URL(OAUTH_PROFILE_URL).pathname, new URL(OAUTH_USAGE_URL).pathname]);
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'oauth-scopes').strings, OAUTH_SCOPES.split(' '));
  for (const scope of CLAUDE_AI_OAUTH_SCOPES) assert.ok(OAUTH_SCOPES.split(' ').includes(scope), scope);
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'oauth-beta').strings, [OAUTH_BETA_HEADER]);
  assert.deepEqual(STRING_CHECKS.find(check => check.id === 'session-header').strings, [SESSION_ID_HEADER]);
  assert.ok(DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS.includes(STRING_CHECKS.find(check => check.id === 'refresh-child-args').strings[0]));
  assert.equal(OAUTH_USER_AGENT, `claude-code/${ROTATOR_USER_AGENT_VERSION} (cli)`);
});

test('strings the rotator sets but does not export match the table in both directions', async () => {
  const refresher = await sourceText('src/native-claude-refresher.js');
  const body = refresher.match(/function isolatedEnvironment\([\s\S]*?\n}\n/);
  assert.ok(body, 'isolatedEnvironment was not found');
  const isolationKeys = extracted(
    [...body[0].matchAll(/^\s+((?:CLAUDE_|DISABLE_)[A-Z0-9_]+|DO_NOT_TRACK):/gm)].map(match => match[1]),
    'isolatedEnvironment',
  );
  const tableIsolation = ['child-isolation-env', 'child-quiet-env']
    .flatMap(id => STRING_CHECKS.find(check => check.id === id).strings);
  assert.deepEqual([...isolationKeys].sort(), [...tableIsolation].sort());

  const refreshKeys = extracted(
    [...new Set([...refresher.matchAll(/^\s+(CLAUDE_CODE_OAUTH_[A-Z0-9_]+):/gm)].map(match => match[1]))],
    'refresh child environment',
  );
  assert.deepEqual(refreshKeys.sort(), [...STRING_CHECKS.find(check => check.id === 'refresh-token-env').strings].sort());

  const proxy = await sourceText('src/proxy-server.js');
  const set = proxy.match(/const CANONICAL_FABLE_MODEL_IDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'CANONICAL_FABLE_MODEL_IDS was not found');
  const ids = extracted([...set[1].matchAll(/'([^']+)'/g)].map(match => match[1]), 'CANONICAL_FABLE_MODEL_IDS');
  assert.deepEqual(ids.sort(), [...FABLE_CHECK.known].sort());
});

test('strings outside the checked set never appear in the checks', async t => {
  const dir = await tempDir(t);
  const outside = ['ANTHROPIC_API_KEY', 'accessToken', 'https://claude.ai/oauth/authorize'];
  const report = inspectDistribution(await writeFixture(dir, fixtureText({ extra: outside })));
  assertAllOk(report);
  assert.deepEqual(report.checks.map(check => check.id), CHECK_IDS);
  const text = JSON.stringify(report.checks);
  for (const value of outside) assert.ok(!text.includes(value), value);

  const warn = inspectDistribution(await writeFixture(dir, fixtureText({ omit: ['DO_NOT_TRACK'], extra: outside })));
  const warnText = JSON.stringify(warn.checks);
  for (const value of outside) assert.ok(!warnText.includes(value), value);
});

test('an unexpected exception becomes an internal-error report with exit code 2', async t => {
  const dir = await tempDir(t);
  const path = await writeFixture(dir, fixtureText());
  const failing = () => {
    throw new TypeError('synthetic failure');
  };
  const run = runInProcess([path], { readImpl: failing });
  assert.equal(run.code, EXIT_UNKNOWN);
  const report = parseOneLine(run.stdout);
  assertAllUnknown(report, REASONS.internalError);
  assert.equal(report.target.path, path);
  assert.equal(report.target.version, VERSION);
  assert.equal(report.target.sha256, null);
  assert.match(run.stderr, /synthetic failure/);

  const badCount = runInProcess([path], { readImpl: () => -1 });
  assert.equal(badCount.code, EXIT_UNKNOWN);
  assertAllUnknown(parseOneLine(badCount.stdout), REASONS.internalError);

  const tinyChunk = runInProcess([path], { chunkBytes: 1 });
  assert.equal(tinyChunk.code, EXIT_UNKNOWN);
  assertAllUnknown(parseOneLine(tinyChunk.stdout), REASONS.internalError);
});

test('a failed or short read is a read-error', async t => {
  const dir = await tempDir(t);
  const path = await writeFixture(dir, fixtureText());
  const ioError = () => {
    throw Object.assign(new Error('synthetic io failure'), { code: 'EIO' });
  };
  const failed = runInProcess([path], { readImpl: ioError });
  assert.equal(failed.code, EXIT_UNKNOWN);
  assertAllUnknown(parseOneLine(failed.stdout), REASONS.readError);

  let calls = 0;
  const stopsEarly = (fd, buffer, offset, length, position) => (calls++ === 0 ? readSync(fd, buffer, offset, 10, position) : 0);
  const short = runInProcess([path], { readImpl: stopsEarly });
  assert.equal(short.code, EXIT_UNKNOWN);
  const report = parseOneLine(short.stdout);
  assertAllUnknown(report, REASONS.readError);
  assert.equal(report.target.sha256, null);
});
