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
// How to run the suite:
//   npm test / npm run check   already load this file (see package.json), so
//                              both belts are armed.
//   node --test ...            arms belt 1 only, via the import at the top of
//                              the service-related test files. Run
//                              `node --import ./fixtures/service-command-guard.js --test ...`
//                              instead: without --import, an absolute
//                              /bin/launchctl call is not intercepted.
//
// ./service-command-shims/systemctl and ./service-command-shims/launchctl must
// keep their executable bit (755) or belt 1 silently stops resolving.
import { createRequire } from 'node:module';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ARMED = Symbol.for('claude-rotator.service-command-guard.armed');
const GUARDED_COMMANDS = new Set(['systemctl', 'launchctl']);
const SYSTEM_BIN_DIRS = new Set([
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin',
]);

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

function recordAndRefuse(command, args) {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const line = `${command} ${argv.join(' ')}\n`;
  try {
    appendFileSync(serviceCommandLogPath(), line);
  } catch {
    // The log is evidence, not a dependency: still refuse the call below.
  }
  const error = new Error(
    `refused: the test suite must not run the real ${basename(String(command))}`,
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
      if (isRealServiceCommand(command)) {
        const error = recordAndRefuse(command, Array.isArray(rest[0]) ? rest[0] : []);
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
          if (isRealServiceCommand(command)) {
            return Promise.reject(recordAndRefuse(command, Array.isArray(rest[0]) ? rest[0] : []));
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
