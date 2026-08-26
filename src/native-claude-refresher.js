import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { claudeKeychainServiceName } from './claude-keychain.js';
import { parseClaudeCredentials } from './claude-credentials.js';
import { CLAUDE_AI_OAUTH_SCOPES, OAUTH_CLIENT_ID } from './oauth.js';

export const DEFAULT_NATIVE_CLAUDE_REFRESH_TIMEOUT_MS = 30_000;
export const DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS = Object.freeze([
  'auth',
  'login',
  '--claudeai',
]);
const TEMP_DIRECTORY_PREFIX = 'claude-rotator-native-refresh-';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const SAFE_KEYCHAIN_ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;
const FALLBACK_KEYCHAIN_ACCOUNT = 'claude-code-user';
const DEFAULT_KEYCHAIN_TIMEOUT_MS = 5_000;
const NATIVE_CLAUDE_TERMINATION_GRACE_MS = 2_000;

export class NativeClaudeRefreshError extends Error {
  constructor(message, code, {
    retryAfterMs = null,
    retryAfterSource = null,
  } = {}) {
    super(message);
    this.name = 'NativeClaudeRefreshError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.retryAfterSource = retryAfterSource;
  }
}

export function createNativeClaudeRefresher(options = {}) {
  return (refreshToken, context = {}) => refreshWithNativeClaudeCode(
    refreshToken,
    context,
    options,
  );
}

export async function refreshWithNativeClaudeCode(refreshToken, context = {}, {
  command = undefined,
  args = DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS,
  execFileImpl = executeNativeClaudeCommand,
  accessImpl = access,
  realpathImpl = realpath,
  openImpl = open,
  keychainExecImpl = executeSecurityCommand,
  userInfoImpl = userInfo,
  platform = process.platform,
  timeoutMs = DEFAULT_NATIVE_CLAUDE_REFRESH_TIMEOUT_MS,
  tempRoot = undefined,
  env = process.env,
  now = Date.now,
  deadlineNow = () => performance.now(),
  removeImpl = rm,
  onCleanupError = () => {},
} = {}) {
  const configuredTimeoutMs = normalizeTimeout(timeoutMs);
  const refreshDeadline = normalizeDeadlineNow(deadlineNow) + configuredTimeoutMs;
  const currentTime = normalizeNow(now);
  const previous = validatePreviousCredential(refreshToken, context, currentTime);
  const resolvedCommand = await resolveNativeClaudeCommand({
    command,
    env,
    accessImpl,
  });
  const configuredCommand = await pinNativeClaudeCommand({
    command: resolvedCommand,
    accessImpl,
    realpathImpl,
  });
  const commandArgs = validateCommand(configuredCommand, args, execFileImpl);
  if (
    typeof removeImpl !== 'function'
    || typeof openImpl !== 'function'
    || typeof keychainExecImpl !== 'function'
    || typeof userInfoImpl !== 'function'
    || typeof onCleanupError !== 'function'
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh platform configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  const configuredTempRoot = tempRoot === undefined
    ? await resolveNativeTempRoot({ env })
    : tempRoot;
  if (!isNonEmptyString(configuredTempRoot)) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh temporary directory configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  let sandbox = null;
  let credentialStorage = null;
  let result;
  let primaryError = null;

  try {
    sandbox = await mkdtemp(join(configuredTempRoot, TEMP_DIRECTORY_PREFIX));
    await chmod(sandbox, PRIVATE_DIRECTORY_MODE);

    const configDir = join(sandbox, 'claude-config');
    const homeDir = join(sandbox, 'home');
    const xdgConfigDir = join(sandbox, 'xdg-config');
    const xdgCacheDir = join(sandbox, 'xdg-cache');
    const xdgDataDir = join(sandbox, 'xdg-data');
    const xdgStateDir = join(sandbox, 'xdg-state');
    const tempDir = join(sandbox, 'tmp');
    const workDir = join(sandbox, 'work');
    await Promise.all([
      createPrivateDirectory(configDir),
      createPrivateDirectory(homeDir),
      createPrivateDirectory(xdgConfigDir),
      createPrivateDirectory(xdgCacheDir),
      createPrivateDirectory(xdgDataDir),
      createPrivateDirectory(xdgStateDir),
      createPrivateDirectory(tempDir),
      createPrivateDirectory(workDir),
    ]);

    const managedSettingsPath = join(sandbox, 'managed-settings.json');
    await writeFile(managedSettingsPath, '{}\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    const keychainAccount = nativeClaudeKeychainAccount(env, userInfoImpl);
    const nativeHomeDir = platform === 'darwin'
      ? nativeClaudeKeychainHome(env, userInfoImpl)
      : homeDir;
    credentialStorage = createNativeClaudeCredentialStorage({
      platform,
      configDir,
      keychainAccount,
      keychainExecImpl,
      openImpl,
      timeoutMs: Math.min(configuredTimeoutMs, DEFAULT_KEYCHAIN_TIMEOUT_MS),
    });
    const environment = isolatedEnvironment({
      source: env,
      configDir,
      homeDir: nativeHomeDir,
      xdgConfigDir,
      xdgCacheDir,
      xdgDataDir,
      xdgStateDir,
      tempDir,
      sandbox,
      user: platform === 'darwin' ? keychainAccount : undefined,
    });
    if (remainingNativeCommandTimeout(refreshDeadline, deadlineNow) == null) {
      throw nativeRefreshCommandFailedError();
    }
    await context.beforeHandoff?.();
    const loginTimeoutMs = remainingNativeCommandTimeout(refreshDeadline, deadlineNow);
    if (loginTimeoutMs == null) {
      // The durable handoff fence may already be armed, so fail closed even
      // though no child can now be started safely inside the deadline.
      throw new NativeClaudeRefreshError(
        'Native Claude OAuth credential refresh outcome is unknown',
        'NATIVE_REFRESH_OUTCOME_UNKNOWN',
      );
    }
    try {
      await executeNativeRefresh({
        command: configuredCommand,
        args: commandArgs,
        execFileImpl,
        timeoutMs: loginTimeoutMs,
        cwd: workDir,
        env: {
          ...environment,
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: previous.refreshToken,
          CLAUDE_CODE_OAUTH_SCOPES: previous.scopes.join(' '),
        },
        afterSpawn: context.protectChildPid,
        afterClose: context.clearChildPid,
      });
    } catch {}

    try {
      const refreshed = await credentialStorage.read('refreshed');
      result = validateRefreshedCredential(
        previous,
        refreshed,
        normalizeNow(now),
      );
    } catch {
      throw new NativeClaudeRefreshError(
        'Native Claude OAuth credential refresh outcome is unknown',
        'NATIVE_REFRESH_OUTCOME_UNKNOWN',
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    // Credential reads, child-lease clearing, and cleanup are safety fences: they
    // stay awaited even after the execution deadline so no secret or child is orphaned.
    if (credentialStorage) {
      await runCleanupStep(
        () => credentialStorage.cleanup(),
        onCleanupError,
        'Could not wipe the isolated native Claude credential',
      );
    }
    if (sandbox) {
      await runCleanupStep(
        () => removeImpl(sandbox, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        }),
        onCleanupError,
        'Could not remove the isolated native Claude credential directory',
      );
    }
  }

  if (primaryError) throw primaryError;
  return result;
}

function validatePreviousCredential(refreshToken, context, now) {
  if (!isNonEmptyString(refreshToken)) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh requires an OAuth refresh token',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  if (context?.refreshToken != null && context.refreshToken !== refreshToken) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh credential context does not match the requested credential',
      'NATIVE_REFRESH_INPUT_MISMATCH',
    );
  }
  if (!isNonEmptyString(context?.accessToken)) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh requires the current OAuth access credential',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  const expiresAt = normalizedTimestamp(context?.expiresAt);
  if (expiresAt == null) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh requires a valid access credential expiry',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }

  const metadata = optionalCredentialMetadata(context);
  if (
    Object.prototype.hasOwnProperty.call(context || {}, 'clientId')
    && context.clientId != null
    && context.clientId !== OAUTH_CLIENT_ID
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh does not support a non-first-party OAuth client',
      'NATIVE_REFRESH_UNSUPPORTED_CLIENT',
    );
  }
  if (!metadata.scopes) {
    metadata.scopes = [...CLAUDE_AI_OAUTH_SCOPES];
  }
  if (metadata.refreshTokenExpiresAt != null && metadata.refreshTokenExpiresAt <= now) {
    throw new NativeClaudeRefreshError(
      'The stored OAuth refresh credential has expired and must be linked again',
      'NATIVE_REFRESH_REAUTH_REQUIRED',
    );
  }

  return {
    accessToken: context.accessToken,
    refreshToken,
    expiresAt,
    ...metadata,
  };
}

function optionalCredentialMetadata(source) {
  const metadata = {};
  const scopes = normalizeScopes(source?.scopes);
  if (scopes.length > 0) metadata.scopes = scopes;
  const refreshTokenExpiresAt = normalizedTimestamp(source?.refreshTokenExpiresAt);
  if (refreshTokenExpiresAt != null) metadata.refreshTokenExpiresAt = refreshTokenExpiresAt;
  for (const field of ['clientId', 'subscriptionType', 'rateLimitTier']) {
    if (source?.[field] != null) metadata[field] = source[field];
  }
  return metadata;
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

export function createNativeClaudeCredentialStorage({
  platform,
  configDir,
  keychainAccount,
  keychainExecImpl,
  openImpl,
  timeoutMs,
}) {
  if (platform === 'darwin') {
    return createMacOSKeychainCredentialStorage({
      configDir,
      account: keychainAccount,
      execImpl: keychainExecImpl,
      timeoutMs,
    });
  }
  return createLinuxCredentialStorage({ configDir, openImpl });
}

function createLinuxCredentialStorage({ configDir, openImpl }) {
  const credentialPath = join(configDir, '.credentials.json');
  return {
    async seed(credential) {
      try {
        await writeFile(
          credentialPath,
          `${JSON.stringify({ claudeAiOauth: credential })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE },
        );
        await chmod(credentialPath, PRIVATE_FILE_MODE);
      } catch {
        throw new NativeClaudeRefreshError(
          'Could not create the isolated native Claude credential',
          'NATIVE_REFRESH_SEED_INVALID',
        );
      }
    },
    read(phase) {
      return readLinuxCredentialFile(credentialPath, {
        openImpl,
        errorCode: phase === 'seed'
          ? 'NATIVE_REFRESH_SEED_INVALID'
          : 'NATIVE_REFRESH_INVALID_OUTPUT',
      });
    },
    cleanup() {
      return wipeLinuxCredentialFile(credentialPath, openImpl);
    },
  };
}

function createMacOSKeychainCredentialStorage({
  configDir,
  account,
  execImpl,
  timeoutMs,
}) {
  const service = nativeClaudeKeychainServiceName(configDir);
  if (!SAFE_KEYCHAIN_ACCOUNT_RE.test(account)) {
    throw new NativeClaudeRefreshError(
      'Native Claude Keychain account configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  const executionOptions = {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    windowsHide: true,
  };

  return {
    async seed(credential) {
      const payloadHex = Buffer.from(
        JSON.stringify({ claudeAiOauth: credential }),
        'utf8',
      ).toString('hex');
      // `security -i` receives the secret through stdin, keeping it out of argv and
      // process listings. All interpolated identifiers have strict safe alphabets.
      const input = `add-generic-password -U -a "${account}" -s "${service}" -X "${payloadHex}"\n`;
      try {
        await execImpl('security', ['-i'], { ...executionOptions, input });
      } catch {
        throw new NativeClaudeRefreshError(
          'Could not create the isolated native Claude Keychain credential',
          'NATIVE_REFRESH_SEED_INVALID',
        );
      }
    },
    async read(phase) {
      try {
        const output = await execImpl('security', [
          'find-generic-password',
          '-a', account,
          '-s', service,
          '-w',
        ], executionOptions);
        return parseCredentialOutput(commandStdout(output), phase);
      } catch (error) {
        if (error instanceof NativeClaudeRefreshError) throw error;
        throw invalidCredentialOutputError(phase);
      }
    },
    async cleanup() {
      try {
        await execImpl('security', [
          'delete-generic-password',
          '-a', account,
          '-s', service,
        ], executionOptions);
      } catch (error) {
        if (isMissingKeychainItem(error)) return;
        throw error;
      }
    },
  };
}

export function nativeClaudeKeychainServiceName(configDir) {
  if (!isNonEmptyString(configDir)) {
    throw new NativeClaudeRefreshError(
      'Native Claude Keychain directory configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return claudeKeychainServiceName(configDir);
}

export function nativeClaudeKeychainAccount(env = process.env, userInfoImpl = userInfo) {
  let candidate;
  try {
    candidate = env?.USER || userInfoImpl().username;
  } catch {
    candidate = FALLBACK_KEYCHAIN_ACCOUNT;
  }
  return SAFE_KEYCHAIN_ACCOUNT_RE.test(candidate || '')
    ? candidate
    : FALLBACK_KEYCHAIN_ACCOUNT;
}

function nativeClaudeKeychainHome(env, userInfoImpl) {
  let candidate = env?.HOME;
  if (!isNonEmptyString(candidate)) {
    try {
      candidate = userInfoImpl().homedir;
    } catch {
      candidate = null;
    }
  }
  if (!isNonEmptyString(candidate) || !isAbsolute(candidate)) {
    throw new NativeClaudeRefreshError(
      'Native Claude Keychain home directory configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return resolve(candidate);
}

async function readLinuxCredentialFile(credentialPath, { openImpl, errorCode }) {
  let handle;
  try {
    handle = await openImpl(
      credentialPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size > MAX_CREDENTIAL_BYTES
    ) {
      throw invalidCredentialOutputError(
        errorCode === 'NATIVE_REFRESH_SEED_INVALID' ? 'seed' : 'refreshed',
      );
    }
    await handle.chmod(PRIVATE_FILE_MODE);
    const raw = await handle.readFile({ encoding: 'utf8' });
    return parseCredentialOutput(
      raw,
      errorCode === 'NATIVE_REFRESH_SEED_INVALID' ? 'seed' : 'refreshed',
    );
  } catch (error) {
    if (error instanceof NativeClaudeRefreshError) throw error;
    throw invalidCredentialOutputError(
      errorCode === 'NATIVE_REFRESH_SEED_INVALID' ? 'seed' : 'refreshed',
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function wipeLinuxCredentialFile(credentialPath, openImpl) {
  let wipeFailure = null;
  let handle;
  try {
    handle = await openImpl(
      credentialPath,
      fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error('unsafe credential output');
    }
    const bytesToWipe = Math.min(metadata.size, MAX_CREDENTIAL_BYTES);
    if (bytesToWipe > 0) {
      const zeroes = Buffer.alloc(Math.min(bytesToWipe, 8 * 1024));
      let offset = 0;
      while (offset < bytesToWipe) {
        const length = Math.min(zeroes.length, bytesToWipe - offset);
        await handle.write(zeroes, 0, length, offset);
        offset += length;
      }
      await handle.sync();
    }
    await handle.truncate(0);
    await handle.sync();
  } catch (error) {
    if (error?.code !== 'ENOENT') wipeFailure = error;
  } finally {
    await handle?.close().catch(() => {});
    await rm(credentialPath, { force: true }).catch(error => {
      wipeFailure ||= error;
    });
  }
  if (wipeFailure) throw wipeFailure;
}

function parseCredentialOutput(raw, phase) {
  try {
    return parseClaudeCredentials(String(raw).trim());
  } catch {
    throw invalidCredentialOutputError(phase);
  }
}

function invalidCredentialOutputError(phase) {
  if (phase === 'seed') {
    return new NativeClaudeRefreshError(
      'Could not verify the isolated native Claude credential',
      'NATIVE_REFRESH_SEED_INVALID',
    );
  }
  return new NativeClaudeRefreshError(
    'Native Claude did not produce valid OAuth credentials',
    'NATIVE_REFRESH_INVALID_OUTPUT',
  );
}

function commandStdout(result) {
  if (typeof result === 'string') return result;
  return result?.stdout ?? '';
}

function isMissingKeychainItem(error) {
  return error?.code === 44
    || /could not be found|not found|errsecitemnotfound/i.test(error?.stderr || '');
}

function isolatedEnvironment({
  source,
  configDir,
  homeDir,
  xdgConfigDir,
  xdgCacheDir,
  xdgDataDir,
  xdgStateDir,
  tempDir,
  sandbox,
  user,
}) {
  const inherited = source || {};
  const isolatedUser = user || inherited.USER || 'ubuntu';
  return {
    PATH: inherited.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: inherited.LANG || 'C.UTF-8',
    LC_ALL: inherited.LC_ALL || inherited.LANG || 'C.UTF-8',
    USER: isolatedUser,
    LOGNAME: user || inherited.LOGNAME || isolatedUser,
    SHELL: inherited.SHELL || '/bin/bash',
    TERM: 'dumb',
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: join(sandbox, 'managed-settings.json'),
    HOME: homeDir,
    XDG_CONFIG_HOME: xdgConfigDir,
    XDG_CACHE_HOME: xdgCacheDir,
    XDG_DATA_HOME: xdgDataDir,
    XDG_STATE_HOME: xdgStateDir,
    TMPDIR: tempDir,
    CLAUDE_TMPDIR: tempDir,
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DO_NOT_TRACK: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

async function executeNativeRefresh({
  command,
  args,
  execFileImpl,
  timeoutMs,
  cwd,
  env,
  afterSpawn = null,
  afterClose = null,
}) {
  try {
    await execFileImpl(command, [...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeoutMs,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
      afterSpawn,
      afterClose,
    });
  } catch (error) {
    if (error instanceof NativeClaudeRefreshError) throw error;
    if (['ENOENT', 'EACCES'].includes(error?.code)) {
      throw new NativeClaudeRefreshError(
        'Native Claude is not available for OAuth credential refresh',
        'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
      );
    }
    throw nativeRefreshCommandFailedError();
  }
}

export function executeNativeClaudeCommand(command, args, {
  timeoutMs = DEFAULT_NATIVE_CLAUDE_REFRESH_TIMEOUT_MS,
  cwd = undefined,
  env = undefined,
  encoding = 'utf8',
  maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
  windowsHide = true,
  afterSpawn = null,
  afterClose = null,
} = {}) {
  const timeout = normalizeTimeout(timeoutMs);
  const outputLimit = Math.min(MAX_COMMAND_OUTPUT_BYTES, Math.max(1, Number(maxBuffer) || 0));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer = null;
    let graceTimer = null;
    let terminationError = null;
    let childError = null;
    let childClosed = false;
    let lifecycleSettled = false;
    let terminationFenced = false;
    let outputBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, [...args], {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide,
    });
    let spawnHook;
    try {
      spawnHook = typeof afterSpawn === 'function' && Number.isInteger(child.pid)
        ? Promise.resolve(afterSpawn(child.pid))
        : Promise.resolve();
    } catch (error) {
      spawnHook = Promise.reject(error);
    }

    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      timeoutTimer = null;
      graceTimer = null;
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) reject(error);
      else resolve(value);
    };
    const finishAfterClose = (code, signal) => {
      if (!childClosed || !lifecycleSettled || (terminationError && !terminationFenced)) return;
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (childError) {
        finish(childError);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString(encoding);
      const stderr = Buffer.concat(stderrChunks).toString(encoding);
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const error = new Error('Native Claude command failed');
      error.code = code ?? signal;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error);
    };
    const signalProcessGroup = signal => {
      if (!Number.isInteger(child.pid)) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const terminate = error => {
      if (terminationError || settled) return;
      terminationError = error;
      signalProcessGroup('SIGTERM');
      graceTimer = setTimeout(() => {
        signalProcessGroup('SIGKILL');
        terminationFenced = true;
        finishAfterClose();
      }, NATIVE_CLAUDE_TERMINATION_GRACE_MS);
    };
    spawnHook.catch(error => {
      childError ||= error;
      terminate(error);
    });
    const append = (chunks, chunk) => {
      if (terminationError) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputLimit) {
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        const error = new Error('Native Claude command output exceeded the safe limit');
        error.code = 'ENOBUFS';
        terminate(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };

    child.stdout.on('data', chunk => append(stdoutChunks, chunk));
    child.stderr.on('data', chunk => append(stderrChunks, chunk));
    child.on('error', error => {
      childError ||= error;
    });
    child.on('close', (code, signal) => {
      childClosed = true;
      Promise.resolve(spawnHook).catch(() => {}).then(async () => {
        try {
          if (typeof afterClose === 'function') await afterClose(child.pid);
        } catch (error) {
          childError ||= error;
        }
        lifecycleSettled = true;
        finishAfterClose(code, signal);
      });
    });
    timeoutTimer = setTimeout(() => {
      const error = new Error('Native Claude command timed out');
      error.code = 'ETIMEDOUT';
      terminate(error);
    }, timeout);
  });
}

function validateCommand(command, args, execFileImpl) {
  if (
    !isNonEmptyString(command)
    || !Array.isArray(args)
    || args.some(argument => typeof argument !== 'string')
    || typeof execFileImpl !== 'function'
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh command configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return [...args];
}

function validateRefreshedCredential(previous, refreshed, now) {
  if (!isNonEmptyString(refreshed.accessToken) || !isNonEmptyString(refreshed.refreshToken)) {
    throw new NativeClaudeRefreshError(
      'Native Claude did not produce complete OAuth credentials',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
  const expiresAt = normalizedTimestamp(refreshed.expiresAt);
  if (
    refreshed.accessToken === previous.accessToken
    && refreshed.refreshToken === previous.refreshToken
    && expiresAt === previous.expiresAt
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude did not refresh the OAuth credential',
      'NATIVE_REFRESH_NOT_UPDATED',
      nativeRetryMetadata(),
    );
  }
  if (expiresAt == null || expiresAt <= now || expiresAt < previous.expiresAt) {
    throw new NativeClaudeRefreshError(
      'Native Claude produced an invalid OAuth credential expiry',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
  if (refreshed.accessToken === previous.accessToken && expiresAt <= previous.expiresAt) {
    throw new NativeClaudeRefreshError(
      'Native Claude did not refresh the OAuth credential',
      'NATIVE_REFRESH_NOT_UPDATED',
      nativeRetryMetadata(),
    );
  }

  const refreshedScopes = normalizeScopes(refreshed.scopes);
  const previousScopes = normalizeScopes(previous.scopes);
  if (
    refreshedScopes.length > 0
    && previousScopes.some(scope => !refreshedScopes.includes(scope))
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude produced OAuth credentials with incomplete authorization scopes',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
  const refreshedRefreshTokenExpiry = normalizedTimestamp(refreshed.refreshTokenExpiresAt);
  if (
    refreshed.refreshTokenExpiresAt != null
    && (refreshedRefreshTokenExpiry == null || refreshedRefreshTokenExpiry <= now)
  ) {
    throw new NativeClaudeRefreshError(
      'Native Claude produced an expired OAuth refresh credential',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }

  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt,
    ...optionalCredentialMetadata({
      ...previous,
      ...refreshed,
      scopes: refreshedScopes.length > 0 ? refreshedScopes : previousScopes,
    }),
  };
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh timeout must be a positive number',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return Math.max(1, Math.floor(parsed));
}

function remainingNativeCommandTimeout(deadline, deadlineNow, maximum = Infinity) {
  // The command timer fires before process termination; reserve the complete
  // SIGTERM-to-SIGKILL grace so the child lifecycle stays inside the deadline.
  const executionBudgetMs = Math.floor(
    deadline - normalizeDeadlineNow(deadlineNow) - NATIVE_CLAUDE_TERMINATION_GRACE_MS,
  );
  if (executionBudgetMs < 1) return null;
  return Math.min(executionBudgetMs, maximum);
}

function normalizeNow(now) {
  if (typeof now !== 'function') {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh clock configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  const value = Number(now());
  if (!Number.isFinite(value) || value <= 0) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh clock returned an invalid timestamp',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return value;
}

function normalizeDeadlineNow(deadlineNow) {
  if (typeof deadlineNow !== 'function') {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh deadline clock configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  const value = Number(deadlineNow());
  if (!Number.isFinite(value) || value < 0) {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh deadline clock returned an invalid timestamp',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  return value;
}

export async function resolveNativeClaudeCommand({
  command = undefined,
  env = process.env,
  accessImpl = access,
} = {}) {
  if (command !== undefined) return command;
  const configured = env?.CLAUDE_ROTATOR_CLAUDE_BIN;
  if (isNonEmptyString(configured)) return configured;
  if (typeof accessImpl !== 'function') {
    throw new NativeClaudeRefreshError(
      'Native Claude command resolver configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  if (isNonEmptyString(env?.HOME)) {
    const nativeInstallerCommand = join(env.HOME, '.local', 'bin', 'claude');
    try {
      await accessImpl(nativeInstallerCommand, fsConstants.X_OK);
      return nativeInstallerCommand;
    } catch {
      // npm/Homebrew installs are commonly available only through PATH.
    }
  }
  const searchDirectories = [
    ...String(env?.PATH || '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const directory of new Set(searchDirectories.filter(isNonEmptyString))) {
    const candidate = resolve(directory, 'claude');
    try {
      await accessImpl(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH and the standard Homebrew locations.
    }
  }
  return 'claude';
}

async function pinNativeClaudeCommand({ command, accessImpl, realpathImpl }) {
  if (!isAbsolute(command)) return command;
  if (typeof accessImpl !== 'function' || typeof realpathImpl !== 'function') {
    throw new NativeClaudeRefreshError(
      'Native Claude command resolver configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  try {
    await accessImpl(command, fsConstants.X_OK);
    const pinned = await realpathImpl(command);
    await accessImpl(pinned, fsConstants.X_OK);
    return pinned;
  } catch {
    throw new NativeClaudeRefreshError(
      'Native Claude is not available for OAuth credential refresh',
      'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
    );
  }
}

export async function resolveNativeTempRoot({
  env = process.env,
  fallback = tmpdir(),
  lstatImpl = lstat,
  accessImpl = access,
  getuidImpl = typeof process.getuid === 'function' ? process.getuid.bind(process) : null,
} = {}) {
  const candidate = env?.XDG_RUNTIME_DIR;
  if (!isNonEmptyString(candidate)) return fallback;
  try {
    const metadata = await lstatImpl(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return fallback;
    if ((metadata.mode & 0o077) !== 0) return fallback;
    if (getuidImpl && metadata.uid !== getuidImpl()) return fallback;
    await accessImpl(candidate, fsConstants.W_OK | fsConstants.X_OK);
    return candidate;
  } catch {
    return fallback;
  }
}

async function runCleanupStep(step, onCleanupError, message) {
  try {
    await step();
  } catch {
    const error = new NativeClaudeRefreshError(
      message,
      'NATIVE_REFRESH_CLEANUP_FAILED',
    );
    try {
      await onCleanupError(error);
    } catch {
      // Cleanup reporting must not replace either a refreshed result or the primary error.
    }
  }
}

export function executeSecurityCommand(command, args, {
  input = '',
  encoding = 'utf8',
  timeout = DEFAULT_KEYCHAIN_TIMEOUT_MS,
  maxBuffer = MAX_COMMAND_OUTPUT_BYTES,
  windowsHide = true,
  beforeInput = null,
  afterClose = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let terminationError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide,
    });
    const beforeInputPromise = Promise.resolve()
      .then(() => (typeof beforeInput === 'function' ? beforeInput(child.pid) : undefined));

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const terminateAfterClose = error => {
      if (settled || terminationError) return;
      terminationError = error;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.kill('SIGKILL');
    };
    const append = (chunks, chunk, stream) => {
      if (terminationError) return;
      const size = Buffer.byteLength(chunk);
      if (stream === 'stdout') stdoutBytes += size;
      else stderrBytes += size;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        const error = new Error('Keychain command output exceeded the safe limit');
        error.code = 'ENOBUFS';
        terminateAfterClose(error);
        return;
      }
      chunks.push(Buffer.from(chunk));
    };

    child.stdout.on('data', chunk => append(stdoutChunks, chunk, 'stdout'));
    child.stderr.on('data', chunk => append(stderrChunks, chunk, 'stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => void (async () => {
      try {
        await beforeInputPromise;
      } catch (error) {
        terminationError ||= error;
      }
      if (typeof afterClose === 'function' && Number.isInteger(child.pid)) {
        try {
          await afterClose(child.pid);
        } catch (error) {
          terminationError ||= error;
        }
      }
      const stdout = Buffer.concat(stdoutChunks).toString(encoding);
      const stderr = Buffer.concat(stderrChunks).toString(encoding);
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const error = new Error('Keychain command failed');
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(error);
    })());
    child.stdin.on('error', () => {});
    timer = setTimeout(() => {
      const error = new Error('Keychain command timed out');
      error.code = 'ETIMEDOUT';
      terminateAfterClose(error);
    }, timeout);
    void beforeInputPromise
      .then(() => {
        if (!settled && !terminationError) child.stdin.end(input, encoding);
      })
      .catch(error => terminateAfterClose(error));
  });
}

function nativeRetryMetadata() {
  return {
    retryAfterMs: DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS,
    retryAfterSource: 'fixed',
  };
}

function nativeRefreshCommandFailedError() {
  return new NativeClaudeRefreshError(
    'Native Claude credential refresh command failed',
    'NATIVE_REFRESH_COMMAND_FAILED',
    nativeRetryMetadata(),
  );
}

function normalizedTimestamp(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const milliseconds = parsed < 1e12 ? parsed * 1000 : parsed;
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizeScopes(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  return [...new Set(entries.map(scope => String(scope).trim()).filter(Boolean))];
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}
