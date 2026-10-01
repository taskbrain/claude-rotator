// Tests for the guard in fixtures/service-command-guard.js, which keeps the
// suite away from the host's service manager and from a real Codex CLI.
//
// These tests call node:child_process directly, outside any helper that
// replaces it, so every call reaches the guard itself. Run them the way
// npm test does: `node --import ./fixtures/service-command-guard.js --test ...`.
//
// Every executable a call could reach is a fake that the test writes into a
// temp dir, and a fake does nothing but create `<its own path>.ran`. A refused
// call must leave no such marker; the controls that are allowed to run show
// that the marker does appear when a fake really runs. The guard log is
// pointed at a temp file for each test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  SERVICE_COMMAND_LOG_ENV,
  SERVICE_COMMAND_SHIM_DIR,
} from '../fixtures/service-command-guard.js';

const SHELL_FAKE = '#!/bin/sh\n: > "$0.ran"\n';
const NODE_FAKE = "require('node:fs').writeFileSync(`${__filename}.ran`, '');\n";

// Every child_process launcher the guard wraps. Each one must throw before a
// process starts.
const LAUNCHERS = Object.freeze([
  ['spawnSync', (command, args) => childProcess.spawnSync(command, args)],
  ['execFileSync', (command, args) => childProcess.execFileSync(command, args)],
  ['spawn', (command, args) => childProcess.spawn(command, args)],
  ['execFile', (command, args) => childProcess.execFile(command, args, () => {})],
]);

const refusedAs = name => error => error.code === 'ETESTGUARD'
  && error.message === `refused: the test suite must not run the real ${name}`;

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'claude-rotator-guard-test-'));
  const logPath = join(root, 'guard.log');
  const saved = process.env[SERVICE_COMMAND_LOG_ENV];
  process.env[SERVICE_COMMAND_LOG_ENV] = logPath;
  t.after(async () => {
    if (saved === undefined) delete process.env[SERVICE_COMMAND_LOG_ENV];
    else process.env[SERVICE_COMMAND_LOG_ENV] = saved;
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    logLines: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []),
    async fake(relativePath, body = SHELL_FAKE) {
      const path = join(root, relativePath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      await chmod(path, 0o755);
      return path;
    },
  };
}

const ran = path => existsSync(`${path}.ran`);

// Tries every launcher, and the promisified execFile, on one command line and
// expects each to be refused. Returns the log lines this should have added.
async function expectRefusedEverywhere(command, args, name) {
  for (const [launcher, launch] of LAUNCHERS) {
    assert.throws(() => launch(command, args), refusedAs(name), `${launcher} ${command}`);
  }
  await assert.rejects(promisify(childProcess.execFile)(command, args), refusedAs(name),
    `promisified execFile ${command}`);
  const line = `${command} ${args.join(' ')}`;
  return Array(LAUNCHERS.length + 1).fill(line);
}

test('guard: a codex or codex-rotator executable in any directory is refused and recorded', async t => {
  const box = await sandbox(t);
  const fakes = [
    [await box.fake('zz-tools/bin/codex'), 'codex'],
    [await box.fake('zz-version-manager/versions/9/bin/codex'), 'codex'],
    [await box.fake('zz-prefix/bin/codex-rotator'), 'codex-rotator'],
  ];
  const expected = [];
  for (const [path, name] of fakes) {
    expected.push(...await expectRefusedEverywhere(path, ['--version'], name));
  }
  // A relative path is refused the same way (nothing exists there, so nothing could run).
  expected.push(...await expectRefusedEverywhere('zz-relative/codex', ['--version'], 'codex'));
  for (const [path] of fakes) assert.equal(ran(path), false, `${path} never ran`);
  assert.deepEqual(box.logLines(), expected);

  const [[first]] = fakes;
  assert.throws(() => childProcess.spawnSync(first, ['--help']),
    error => error.guardedCommand === `${first} --help`);
});

test('guard: node running bin/codex-rotator.js is refused and recorded, while node running another script still runs', async t => {
  const box = await sandbox(t);
  const entry = await box.fake('zz-checkout/bin/codex-rotator.js', NODE_FAKE);
  const other = await box.fake('zz-checkout/bin/other.js', NODE_FAKE);
  const binDir = dirname(entry);
  // The same entry point written with `./` or a doubled slash, and, for node, without
  // the extension (node then finds bin/codex-rotator.js itself).
  const dotted = `${binDir}/./codex-rotator.js`;
  const doubled = `${binDir}//codex-rotator.js`;
  const extensionless = join(binDir, 'codex-rotator');
  const expected = [
    ...await expectRefusedEverywhere(process.execPath, [entry, 'status', '--json'], 'codex-rotator'),
    // The entry point is found among the arguments, not only as the first one.
    ...await expectRefusedEverywhere(process.execPath, ['--no-warnings', entry], 'codex-rotator'),
    // Any command named node, not only this process' own binary.
    ...await expectRefusedEverywhere('node', [entry, 'status'], 'codex-rotator'),
    // The entry point run directly as the command.
    ...await expectRefusedEverywhere(entry, ['status'], 'codex-rotator.js'),
    // The path is normalized before it is matched.
    ...await expectRefusedEverywhere(process.execPath, [dotted, 'status'], 'codex-rotator'),
    ...await expectRefusedEverywhere(process.execPath, [doubled, 'status'], 'codex-rotator'),
    ...await expectRefusedEverywhere(dotted, ['status'], 'codex-rotator.js'),
    ...await expectRefusedEverywhere(doubled, ['status'], 'codex-rotator.js'),
    // node given the entry point without its extension.
    ...await expectRefusedEverywhere(process.execPath, [extensionless, 'status'], 'codex-rotator'),
  ];
  assert.equal(ran(entry), false, 'the entry point never ran');
  assert.deepEqual(box.logLines(), expected);

  // Control: the same node binary with a script that is not the entry point runs.
  const result = childProcess.spawnSync(process.execPath, [other], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ran(other), true, 'the other script ran');
  assert.deepEqual(box.logLines(), expected, 'nothing was recorded for the control');
});

test('guard: a bare codex or codex-rotator reaches its recording stand-in through PATH, and is refused by the child_process wrapper', async t => {
  const box = await sandbox(t);
  assert.equal(process.env.PATH.split(':')[0], SERVICE_COMMAND_SHIM_DIR, 'the stand-ins come first on PATH');
  const shim = join(SERVICE_COMMAND_SHIM_DIR, 'codex');
  assert.equal(statSync(shim).mode & 0o777, 0o755, 'the codex stand-in keeps its executable bit');
  const rotatorShim = join(SERVICE_COMMAND_SHIM_DIR, 'codex-rotator');
  assert.equal(statSync(rotatorShim).mode & 0o777, 0o755, 'the codex-rotator stand-in keeps its executable bit');

  // A shell resolves the bare name through PATH: the stand-in records the call and fails.
  const viaShell = childProcess.spawnSync('/bin/sh', ['-c', 'codex --version'], { encoding: 'utf8' });
  assert.equal(viaShell.status, 1);
  assert.match(viaShell.stderr, /refused: the test suite must not run the real codex/);
  assert.deepEqual(box.logLines(), ['codex --version']);

  // The same for codex-rotator: the shell runs the stand-in, the first match on PATH, so a
  // real codex-rotator later on PATH is never reached.
  const rotatorViaShell = childProcess.spawnSync('/bin/sh', ['-c', 'codex-rotator --version'], { encoding: 'utf8' });
  assert.equal(rotatorViaShell.status, 1);
  assert.match(rotatorViaShell.stderr, /refused: the test suite must not run the real codex-rotator/);
  assert.deepEqual(box.logLines(), ['codex --version', 'codex-rotator --version']);

  // Launched by name through child_process, the wrapper refuses it before PATH is searched.
  const expected = [
    'codex --version',
    'codex-rotator --version',
    ...await expectRefusedEverywhere('codex', ['--version'], 'codex'),
    ...await expectRefusedEverywhere('codex-rotator', ['--version'], 'codex-rotator'),
  ];
  assert.deepEqual(box.logLines(), expected);
});

test('guard: the service manager is still refused as before, and a fixture launchctl in a temp dir still runs', async t => {
  const box = await sandbox(t);
  const expected = [
    ...await expectRefusedEverywhere('launchctl', ['list'], 'launchctl'),
    ...await expectRefusedEverywhere('/bin/launchctl', ['list'], 'launchctl'),
    ...await expectRefusedEverywhere('systemctl', ['--user', 'status'], 'systemctl'),
    ...await expectRefusedEverywhere('/usr/bin/systemctl', ['--user', 'status'], 'systemctl'),
  ];
  assert.deepEqual(box.logLines(), expected);

  for (const [name, line] of [['launchctl', 'launchctl list'], ['systemctl', 'systemctl --user status']]) {
    const viaShell = childProcess.spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
    assert.equal(viaShell.status, 1, name);
    assert.match(viaShell.stderr, new RegExp(`refused: the test suite must not run the real ${name}`));
    expected.push(line);
  }
  assert.deepEqual(box.logLines(), expected);

  // Control: a launchctl that a test writes into a temp dir is a fixture, not the host's.
  const fixture = await box.fake('zz-fixture-bin/launchctl');
  const result = childProcess.spawnSync(fixture, ['list'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(ran(fixture), true, 'the fixture launchctl ran');
  assert.deepEqual(box.logLines(), expected, 'nothing was recorded for the fixture');
});
