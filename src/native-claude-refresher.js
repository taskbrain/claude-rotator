import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseClaudeCredentials } from './claude-credentials.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_NATIVE_CLAUDE_REFRESH_TIMEOUT_MS = 30_000;
export const DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS = 5 * 60 * 1000;
export const DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS = Object.freeze([
  '-p',
  'Reply only OK',
  '--model',
  'haiku',
  '--max-turns',
  '1',
  '--no-session-persistence',
  '--disable-slash-commands',
  '--tools',
  '',
  '--setting-sources=',
  '--settings',
  '{}',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--no-chrome',
  '--system-prompt',
  'Reply exactly OK. Do not use tools.',
  '--output-format',
  'json',
]);

const TEMP_DIRECTORY_PREFIX = 'claude-rotator-native-refresh-';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const LOOPBACK_UPSTREAM = 'http://127.0.0.1:9';

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
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_NATIVE_CLAUDE_REFRESH_TIMEOUT_MS,
  tempRoot = tmpdir(),
  env = process.env,
  now = Date.now,
  removeImpl = rm,
} = {}) {
  const currentTime = normalizeNow(now);
  const previous = validatePreviousCredential(refreshToken, context, currentTime);
  const configuredTimeoutMs = normalizeTimeout(timeoutMs);
  const configuredCommand = command === undefined
    ? defaultNativeClaudeCommand(env)
    : command;
  const commandArgs = validateCommand(configuredCommand, args, execFileImpl);
  if (typeof removeImpl !== 'function') {
    throw new NativeClaudeRefreshError(
      'Native Claude refresh cleanup configuration is invalid',
      'NATIVE_REFRESH_INVALID_INPUT',
    );
  }
  let sandbox = null;

  try {
    sandbox = await mkdtemp(join(tempRoot, TEMP_DIRECTORY_PREFIX));
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

    const credentialPath = join(configDir, '.credentials.json');
    // Force native Claude's preflight refresh even when this refresh was triggered by an
    // upstream 401 before the stored access-token expiry window.
    const forcedSeedExpiry = Math.max(1, currentTime - 1);
    const managedSettingsPath = join(sandbox, 'managed-settings.json');
    await writeFile(managedSettingsPath, '{}\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: PRIVATE_FILE_MODE,
    });
    await writeFile(
      credentialPath,
      `${JSON.stringify({
        claudeAiOauth: credentialDocument({
          ...previous,
          expiresAt: forcedSeedExpiry,
        }),
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: PRIVATE_FILE_MODE },
    );
    await chmod(credentialPath, PRIVATE_FILE_MODE);
    await assertSeedCredential(credentialPath, refreshToken, forcedSeedExpiry);

    let executionFailure = null;
    try {
      await executeNativeRefresh({
        command: configuredCommand,
        args: commandArgs,
        execFileImpl,
        timeoutMs: configuredTimeoutMs,
        cwd: workDir,
        env: isolatedEnvironment({
          source: env,
          configDir,
          homeDir,
          xdgConfigDir,
          xdgCacheDir,
          xdgDataDir,
          xdgStateDir,
          tempDir,
          sandbox,
        }),
      });
    } catch (error) {
      executionFailure = error;
    }

    let result;
    try {
      await protectCredentialFile(credentialPath);
      const refreshed = await readRefreshedCredential(credentialPath);
      result = validateRefreshedCredential(
        previous,
        refreshed,
        normalizeNow(now),
        forcedSeedExpiry,
      );
    } catch (error) {
      if (executionFailure) throw executionFailure;
      throw error;
    }
    return result;
  } finally {
    if (sandbox) {
      try {
        await removeImpl(sandbox, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
      } catch {
        throw new NativeClaudeRefreshError(
          'Could not remove the isolated native Claude credential directory',
          'NATIVE_REFRESH_CLEANUP_FAILED',
        );
      }
    }
  }
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

function credentialDocument(credential) {
  return {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    ...optionalCredentialMetadata(credential),
  };
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function assertSeedCredential(credentialPath, refreshToken, forcedSeedExpiry) {
  let seeded;
  try {
    seeded = parseClaudeCredentials(await readFile(credentialPath, 'utf8'));
  } catch {
    throw new NativeClaudeRefreshError(
      'Could not verify the isolated native Claude credential',
      'NATIVE_REFRESH_SEED_INVALID',
    );
  }
  if (
    seeded.refreshToken !== refreshToken
    || normalizedTimestamp(seeded.expiresAt) !== forcedSeedExpiry
  ) {
    throw new NativeClaudeRefreshError(
      'Isolated native Claude credential does not match the requested credential',
      'NATIVE_REFRESH_INPUT_MISMATCH',
    );
  }
}

async function protectCredentialFile(credentialPath) {
  let metadata;
  try {
    metadata = await lstat(credentialPath);
  } catch {
    throw new NativeClaudeRefreshError(
      'Native Claude did not produce an OAuth credential file',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
  if (!metadata.isFile()) {
    throw new NativeClaudeRefreshError(
      'Native Claude produced an unsafe OAuth credential file',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
  await chmod(credentialPath, PRIVATE_FILE_MODE);
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
}) {
  const inherited = source || {};
  return {
    PATH: inherited.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: inherited.LANG || 'C.UTF-8',
    LC_ALL: inherited.LC_ALL || inherited.LANG || 'C.UTF-8',
    USER: inherited.USER || 'ubuntu',
    LOGNAME: inherited.LOGNAME || inherited.USER || 'ubuntu',
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
    ANTHROPIC_BASE_URL: LOOPBACK_UPSTREAM,
    API_TIMEOUT_MS: '1000',
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
}) {
  let timer = null;
  const abortController = new AbortController();
  const nativeExecution = Promise.resolve().then(() => execFileImpl(
    command,
    [...args],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      signal: abortController.signal,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      windowsHide: true,
    },
  ));
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new NativeClaudeRefreshError(
        'Native Claude credential refresh timed out',
        'NATIVE_REFRESH_TIMEOUT',
        nativeRetryMetadata(),
      ));
    }, timeoutMs);
  });

  try {
    await Promise.race([nativeExecution, timeout]);
  } catch (error) {
    if (error instanceof NativeClaudeRefreshError) throw error;
    if (['ENOENT', 'EACCES'].includes(error?.code)) {
      throw new NativeClaudeRefreshError(
        'Native Claude is not available for OAuth credential refresh',
        'NATIVE_REFRESH_COMMAND_UNAVAILABLE',
      );
    }
    throw new NativeClaudeRefreshError(
      'Native Claude credential refresh command failed',
      'NATIVE_REFRESH_COMMAND_FAILED',
      nativeRetryMetadata(),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
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

async function readRefreshedCredential(credentialPath) {
  try {
    return parseClaudeCredentials(await readFile(credentialPath, 'utf8'));
  } catch {
    throw new NativeClaudeRefreshError(
      'Native Claude did not produce valid OAuth credentials',
      'NATIVE_REFRESH_INVALID_OUTPUT',
    );
  }
}

function validateRefreshedCredential(previous, refreshed, now, forcedSeedExpiry) {
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
    && expiresAt === forcedSeedExpiry
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

function defaultNativeClaudeCommand(env) {
  const configured = env?.CLAUDE_ROTATOR_CLAUDE_BIN;
  if (isNonEmptyString(configured)) return configured;
  if (isNonEmptyString(env?.HOME)) return join(env.HOME, '.local', 'bin', 'claude');
  return 'claude';
}

function nativeRetryMetadata() {
  return {
    retryAfterMs: DEFAULT_NATIVE_CLAUDE_REFRESH_RETRY_AFTER_MS,
    retryAfterSource: 'fixed',
  };
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
