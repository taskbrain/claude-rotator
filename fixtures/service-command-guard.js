// Test-only guard that keeps the suite away from the host's real service
// manager. Uninstall/install code paths shell out to `systemctl --user ...`
// (Linux) and `/bin/launchctl ...` (macOS); a test that reaches either one
// stops or unregisters the machine's own claude-rotator instance.
//
// Two independent belts, because neither one covers every spawn shape:
//
//   1. PATH — prepends ./service-command-shims, so a bare `systemctl` or
//      `launchctl` resolves to a script that appends its argv to the guard
//      log and exits 1. This belt survives any spawn shape, including
//      commands issued from shell scripts the suite renders and runs, and it
//      works when this module is imported from inside a test file.
//
//   2. child_process — wraps execFile/execFileSync/spawn/spawnSync so an
//      absolute system path (e.g. /bin/launchctl) is recorded and refused
//      too. This belt only arms when the module is loaded with
//      `node --import ./fixtures/service-command-guard.js`: by the time a
//      test file's own body runs, node:child_process' ESM bindings have
//      already been snapshotted by every module in its import graph, so a
//      late patch would not be seen. `node --test` forwards the runner's
//      execArgv to each test file's child process, so one --import on the
//      runner arms every file.
//
// Commands are refused, never executed. Fixture fakes (a `launchctl` written
// into a temp dir by a test) are left alone: only bare names and the real
// system directories are treated as the host's service manager.
//
// The Codex CLI and the codex-rotator entry point are refused more widely,
// because a real `codex` often lives outside the system directories (a version
// manager, a package manager prefix, a user bin directory):
//   - a command named `codex` or `codex-rotator`, bare or at any path;
//   - a command whose path ends with bin/codex-rotator.js;
//   - `process.execPath` (or any command named `node`) with an argument that
//     ends with bin/codex-rotator.js, or with bin/codex-rotator (node finds the
//     .js file itself when the extension is left out).
// Paths are normalized before the entry point is matched, so
// bin/./codex-rotator.js and bin//codex-rotator.js are caught as well.
// Belt 1 covers the bare names `codex` and `codex-rotator` with
// ./service-command-shims/codex and ./service-command-shims/codex-rotator. A
// test that needs a fake Codex CLI has to inject its own spawn function; an
// executable named `codex` in a temp dir is refused like the real one. The
// test runner's own child processes run test files, whose paths do not end
// with bin/codex-rotator.js, so they pass.
//
// What the guard does not reach. Belt 2 only covers calls to execFile,
// execFileSync, spawn and spawnSync that pass the command and its arguments
// separately, and it judges a call by the strings it is given, not by the
// file that would run. It does not reach:
//   - node started through a shell, e.g. `sh -c 'node .../bin/codex-rotator.js'`:
//     belt 2 only sees /bin/sh, and belt 1 has no stand-in for node;
//   - node given a string to evaluate, e.g.
//     `node -e "import('./bin/codex-rotator.js')"` (also --eval, -p, --print);
//   - a node binary whose file name is not `node` (`nodejs`, or a versioned
//     name such as `node22`), unless it is this process' own binary;
//   - fork. It is not wrapped, and it starts its child through node's own
//     internal spawn, not the wrapped one, so forking the entry point runs it;
//   - exec and execSync, which are not wrapped either. exec hands its command
//     string to the wrapped execFile, so it is checked only as a single
//     command string (next item); execSync is not checked at all;
//   - a single command string with `shell: true`. Belt 2 then tests the whole
//     string as one command, so arguments after the command or the entry path
//     get past it, and so does an entry path that ends in .js and has neither
//     / nor ./ in front (`node bin/codex-rotator.js`). Without the extension
//     (`node bin/codex-rotator`) the last path part of the string is
//     codex-rotator, which is refused by name. Behind the shell only belt 1
//     applies: a bare name with a stand-in is still caught, but a string such
//     as `/usr/local/bin/codex login` runs the real codex;
//   - a command started through /usr/bin/env: belt 2 only sees env, and after
//     it only belt 1 applies, which has no stand-in for node or for an
//     absolute path;
//   - on a case-insensitive disk, a command given as a path, or an entry path,
//     that differs only in case, e.g. `/bin/LaunchCtl` or
//     `bin/Codex-Rotator.js`: belt 2 compares names and paths exactly;
//   - what a child node process does in turn when a test starts it with
//     spawn, execFile or their Sync forms, e.g. as process.execPath. Those
//     calls give the child only the arguments they are passed, so --import
//     does not reach it and belt 2 is not armed inside it; only belt 1, the
//     stand-ins first on the PATH it inherits, still applies there. A bare
//     `codex`, `codex-rotator`, `launchctl` or `systemctl` is still caught; an
//     absolute path, or node running the entry point, is not.
// A child started with fork is different: fork gives it the parent's
// process.execArgv by default, so it starts with the same --import and belt 2
// is armed inside it (what fork itself starts is still not checked, above).
//
// A test whose child process may start the entry point, the Codex CLI or a
// real service manager must therefore inject its own spawn function and not
// start a child node process.
// Pointing HOME at a temp dir is not enough: the config location follows
// XDG_CONFIG_HOME when that is set, a daemon falls back to a default port that
// HOME does not change, and inside such a child an absolute launchctl or
// systemctl is not stopped (the macOS service code calls /bin/launchctl).
// No check over the whole suite enforces this: the isolation helper of the
// Codex tests refuses every child_process launch, but only inside a test that
// uses it, so review has to confirm that any other test whose child process
// may start the entry point, the Codex CLI or a real service manager replaces
// spawn and does not start a child node process.
//
// How to run the suite:
//   npm test / npm run check   already load this file (see package.json), so
//                              both belts are armed.
//   node --test ...            arms belt 1 only, via the import at the top of
//                              the service-related test files. Run
//                              `node --import ./fixtures/service-command-guard.js --test ...`
//                              instead: without --import, an absolute
//                              /bin/launchctl call is not intercepted.
//
// ./service-command-shims/systemctl, ./service-command-shims/launchctl,
// ./service-command-shims/codex and ./service-command-shims/codex-rotator must
// keep their executable bit (755) or belt 1 silently stops resolving.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ARMED = Symbol.for('claude-rotator.service-command-guard.armed');
const GUARDED_COMMANDS = new Set(['systemctl', 'launchctl']);
const SYSTEM_BIN_DIRS = new Set([
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin',
]);
const CODEX_COMMANDS = new Set(['codex', 'codex-rotator']);
const CODEX_ROTATOR_ENTRY = /(?:^|[\\/])bin[\\/]codex-rotator\.js$/;
// As an argument to node the entry point may be written without the extension:
// node looks for `<path>.js` when the path it is given does not exist.
const CODEX_ROTATOR_ENTRY_ARG = /(?:^|[\\/])bin[\\/]codex-rotator(?:\.js)?$/;

export const SERVICE_COMMAND_SHIM_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'service-command-shims',
);

export const SERVICE_COMMAND_LOG_ENV = 'CLAUDE_ROTATOR_SERVICE_COMMAND_LOG';

export function serviceCommandLogPath(env = process.env) {
  return env[SERVICE_COMMAND_LOG_ENV]
    || join(tmpdir(), 'claude-rotator-service-command-guard.log');
}

// True only for the machine's own service manager: a bare name resolved
// through PATH, or an absolute path inside a real system bin directory.
export function isRealServiceCommand(command) {
  const text = String(command ?? '');
  if (!GUARDED_COMMANDS.has(basename(text))) return false;
  if (!isAbsolute(text)) return !text.includes('/');
  return SYSTEM_BIN_DIRS.has(dirname(text));
}

// The entry point is matched on the normalized path, so `bin/./` and `bin//`
// do not hide it.
function matchesEntryPoint(pattern, value) {
  return pattern.test(normalize(String(value ?? '')));
}

// True for the Codex CLI or the codex-rotator entry point, wherever it lives:
// a bare name, a relative path or an absolute path in any directory.
export function isCodexCommand(command) {
  const text = String(command ?? '');
  return CODEX_COMMANDS.has(basename(text)) || matchesEntryPoint(CODEX_ROTATOR_ENTRY, text);
}

// True when node (this process' own binary, or any command named `node`) is
// asked to run the codex-rotator entry point.
export function isCodexRotatorEntryLaunch(command, args) {
  const text = String(command ?? '');
  if (text !== process.execPath && basename(text) !== 'node') return false;
  return Array.isArray(args) && args.some(arg => matchesEntryPoint(CODEX_ROTATOR_ENTRY_ARG, arg));
}

// The name to put in the refusal message, or null when the call may run.
export function guardedCommandName(command, args) {
  if (isRealServiceCommand(command) || isCodexCommand(command)) return basename(String(command));
  if (isCodexRotatorEntryLaunch(command, args)) return 'codex-rotator';
  return null;
}

function recordAndRefuse(command, args, name) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const line = `${command} ${argv.join(' ')}\n`;
  try {
    appendFileSync(serviceCommandLogPath(), line);
  } catch {
    // The log is evidence, not a dependency: still refuse the call below.
  }
  const error = new Error(
    `refused: the test suite must not run the real ${name}`,
  );
  error.code = 'ETESTGUARD';
  error.guardedCommand = line.trimEnd();
  return error;
}

function armPathBelt(env = process.env) {
  const current = env.PATH || '';
  const segments = current.split(':');
  if (segments[0] !== SERVICE_COMMAND_SHIM_DIR) {
    env.PATH = current ? `${SERVICE_COMMAND_SHIM_DIR}:${current}` : SERVICE_COMMAND_SHIM_DIR;
  }
  env[SERVICE_COMMAND_LOG_ENV] ||= serviceCommandLogPath(env);
}

function armChildProcessBelt() {
  const require = createRequire(import.meta.url);
  const childProcess = require('node:child_process');
  if (childProcess[ARMED]) return;
  childProcess[ARMED] = true;

  for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
    const real = childProcess[name];
    if (typeof real !== 'function') continue;
    const wrapped = function guarded(command, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const refusedName = guardedCommandName(command, args);
      if (refusedName) {
        const error = recordAndRefuse(command, args, refusedName);
        // execFile/spawn are callback- and event-shaped; throwing synchronously
        // is still the loudest failure and cannot be swallowed silently by a
        // caller that only awaits a promise.
        throw error;
      }
      return real.call(this, command, ...rest);
    };
    for (const key of Reflect.ownKeys(real)) {
      if (key === promisify.custom) continue;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(real, key));
      } catch {
        // Non-configurable function internals (length/name) are not needed.
      }
    }
    // execFile carries a util.promisify custom implementation that closes over
    // the unwrapped function and resolves to { stdout, stderr }. Copying it
    // verbatim would let `promisify(execFile)` walk straight past the guard,
    // and dropping it would change the resolved shape the callers destructure,
    // so re-wrap it instead of doing either.
    const realCustom = real[promisify.custom];
    if (typeof realCustom === 'function') {
      Object.defineProperty(wrapped, promisify.custom, {
        value: function guardedPromisified(command, ...rest) {
          const args = Array.isArray(rest[0]) ? rest[0] : [];
          const refusedName = guardedCommandName(command, args);
          if (refusedName) {
            return Promise.reject(recordAndRefuse(command, args, refusedName));
          }
          return realCustom.call(this, command, ...rest);
        },
        configurable: true,
      });
    }
    childProcess[name] = wrapped;
  }
}

export function installServiceCommandGuard({ env = process.env } = {}) {
  armPathBelt(env);
  return { shimDir: SERVICE_COMMAND_SHIM_DIR, logPath: serviceCommandLogPath(env) };
}

armPathBelt();
armChildProcessBelt();
