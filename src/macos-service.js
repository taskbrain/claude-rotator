import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE_REMOVAL_TIMEOUT_MS = 15_000;
const SERVICE_REMOVAL_POLL_INTERVAL_MS = 50;

export const MACOS_SERVICE_LOCK_MARKER_ENV = 'CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED';
export const MACOS_SERVICE_LOCK_MARKER_VALUE = '1';
export const MACOS_MAIN_SERVICE_LABEL = 'io.github.claude-rotator';
export const MACOS_WATCHDOG_SERVICE_LABEL = 'io.github.claude-rotator.watchdog';

export function assertMacosServiceLockHeld(env = process.env) {
  if (env[MACOS_SERVICE_LOCK_MARKER_ENV] === MACOS_SERVICE_LOCK_MARKER_VALUE) return;
  throw new Error('macOS service changes require the shared lock');
}

export async function prepareMacosServiceLock({ lockPath }) {
  const parent = dirname(lockPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const handle = await open(lockPath, 'a', 0o600);
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export async function snapshotMacosManagedFile(path) {
  try {
    const [bytes, fileStat] = await Promise.all([readFile(path), stat(path)]);
    return { exists: true, bytes, mode: fileStat.mode & 0o777 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

export async function replaceMacosManagedFile({ path, contents, mode, env = process.env }) {
  assertMacosServiceLockHeld(env);
  const desired = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const previous = await snapshotMacosManagedFile(path);
  if (previous.exists && previous.mode === mode && previous.bytes.equals(desired)) {
    return false;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, desired, { flag: 'wx', mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return true;
}

export async function removeMacosManagedFile({ path, env = process.env }) {
  assertMacosServiceLockHeld(env);
  await rm(path, { force: true });
}

export async function restoreMacosManagedFile({ path, snapshot, env = process.env }) {
  if (!snapshot.exists) {
    await removeMacosManagedFile({ path, env });
    return;
  }
  await replaceMacosManagedFile({
    path,
    contents: snapshot.bytes,
    mode: snapshot.mode,
    env,
  });
}

export async function reconcileMacosMainService({
  uid,
  plistPath,
  definitionChanged,
  env = process.env,
  execFileImpl = execFileAsync,
  sleep = delay,
  serviceTimeoutMs = SERVICE_REMOVAL_TIMEOUT_MS,
  monotonicNow = () => performance.now(),
}) {
  assertMacosServiceLockHeld(env);
  const operation = createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep });
  const target = serviceTarget(uid, MACOS_MAIN_SERVICE_LABEL);
  const registered = await queryRegistration(execFileImpl, target.job, operation);

  if (registered && !definitionChanged) {
    await runLaunchctl(execFileImpl, ['kickstart', '-k', target.job], operation);
    await requireRegistration(execFileImpl, target.job, 'main service', operation);
    return;
  }
  if (registered) {
    await runLaunchctl(execFileImpl, ['bootout', target.job], operation);
    await requireNoRegistration(execFileImpl, target.job, 'main service', operation);
  }
  await runLaunchctl(execFileImpl, ['bootstrap', target.domain, plistPath], operation);
  await requireRegistration(execFileImpl, target.job, 'main service', operation);
}

export async function startMacosWatchdogService({
  uid,
  plistPath,
  env = process.env,
  execFileImpl = execFileAsync,
  sleep = delay,
  serviceTimeoutMs = SERVICE_REMOVAL_TIMEOUT_MS,
  monotonicNow = () => performance.now(),
}) {
  assertMacosServiceLockHeld(env);
  const operation = createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep });
  const target = serviceTarget(uid, MACOS_WATCHDOG_SERVICE_LABEL);
  if (await queryRegistration(execFileImpl, target.job, operation)) return;
  await runLaunchctl(execFileImpl, ['bootstrap', target.domain, plistPath], operation);
  await requireRegistration(execFileImpl, target.job, 'watchdog service', operation);
}

export async function stopMacosMainService(options) {
  return stopMacosService({ ...options, label: MACOS_MAIN_SERVICE_LABEL, name: 'main service' });
}

export async function stopMacosWatchdogService(options) {
  return stopMacosService({ ...options, label: MACOS_WATCHDOG_SERVICE_LABEL, name: 'watchdog service' });
}

export async function isMacosServiceRegistered({
  uid,
  label,
  env = process.env,
  execFileImpl = execFileAsync,
  sleep = delay,
  serviceTimeoutMs = SERVICE_REMOVAL_TIMEOUT_MS,
  monotonicNow = () => performance.now(),
}) {
  assertMacosServiceLockHeld(env);
  const operation = createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep });
  return queryRegistration(execFileImpl, serviceTarget(uid, label).job, operation);
}

export async function restoreMacosServiceRegistration({
  uid,
  label,
  plistPath,
  registered,
  env = process.env,
  execFileImpl = execFileAsync,
  sleep = delay,
  serviceTimeoutMs = SERVICE_REMOVAL_TIMEOUT_MS,
  monotonicNow = () => performance.now(),
}) {
  const operation = createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep });
  await stopMacosService({ uid, label, name: 'service', env, execFileImpl, operation });
  if (!registered) return;
  const target = serviceTarget(uid, label);
  await runLaunchctl(execFileImpl, ['bootstrap', target.domain, plistPath], operation);
  await requireRegistration(execFileImpl, target.job, 'service', operation);
}

async function stopMacosService({
  uid,
  label,
  name,
  env = process.env,
  execFileImpl = execFileAsync,
  sleep = delay,
  serviceTimeoutMs = SERVICE_REMOVAL_TIMEOUT_MS,
  monotonicNow = () => performance.now(),
  operation = null,
}) {
  assertMacosServiceLockHeld(env);
  operation ||= createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep });
  const target = serviceTarget(uid, label);
  if (!(await queryRegistration(execFileImpl, target.job, operation))) return;
  await runLaunchctl(execFileImpl, ['bootout', target.job], operation);
  await requireNoRegistration(execFileImpl, target.job, name, operation);
}

function serviceTarget(uid, label) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error('A numeric macOS user id is required');
  const domain = `gui/${uid}`;
  return { domain, job: `${domain}/${label}` };
}

async function queryRegistration(execFileImpl, job, operation) {
  try {
    await executeLaunchctl(execFileImpl, ['print', job], operation);
    return true;
  } catch (error) {
    if (error?.code === 113) return false;
    if (error?.code === 'MACOS_SERVICE_TIMEOUT') throw error;
    throw launchctlError('print', error);
  }
}

async function runLaunchctl(execFileImpl, args, operation) {
  try {
    await executeLaunchctl(execFileImpl, args, operation);
  } catch (error) {
    if (error?.code === 'MACOS_SERVICE_TIMEOUT') throw error;
    throw launchctlError(args[0], error);
  }
}

async function requireRegistration(execFileImpl, job, name, operation) {
  if (!(await queryRegistration(execFileImpl, job, operation))) {
    throw new Error(`${name} was not registered`);
  }
}

async function requireNoRegistration(execFileImpl, job, name, operation) {
  while (true) {
    const beforeQuery = remainingServiceTime(operation);
    if (beforeQuery <= 0) throw new Error(`${name} is still registered`);
    if (!(await queryRegistration(execFileImpl, job, operation))) return;
    const remaining = remainingServiceTime(operation);
    if (remaining <= 0) throw new Error(`${name} is still registered`);
    await operation.sleep(Math.min(SERVICE_REMOVAL_POLL_INTERVAL_MS, remaining));
  }
}

function createServiceOperation({ serviceTimeoutMs, monotonicNow, sleep }) {
  const timeoutMs = Number(serviceTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('A positive macOS service timeout is required');
  }
  return {
    deadline: monotonicNow() + timeoutMs,
    monotonicNow,
    sleep,
  };
}

function remainingServiceTime(operation) {
  return operation.deadline - operation.monotonicNow();
}

async function executeLaunchctl(execFileImpl, args, operation) {
  const remaining = remainingServiceTime(operation);
  if (remaining <= 0) throw serviceTimeoutError();
  const controller = new AbortController();
  const timeoutError = serviceTimeoutError();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
      controller.abort();
    }, Math.max(1, Math.ceil(remaining)));
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => execFileImpl('/bin/launchctl', args, {
        signal: controller.signal,
      })),
      timeout,
    ]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (remainingServiceTime(operation) <= 0) throw timeoutError;
}

function serviceTimeoutError() {
  const error = new Error('macOS service operation timed out');
  error.code = 'MACOS_SERVICE_TIMEOUT';
  return error;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function launchctlError(action, error) {
  const status = Number.isInteger(error?.code) ? error.code : 'unknown';
  return new Error(`launchctl ${action} failed (exit status ${status})`);
}
