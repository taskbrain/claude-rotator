import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { text as readStdinText } from 'node:stream/consumers';
import { isDeepStrictEqual, promisify } from 'node:util';

import { AccountManager } from './account-manager.js';
import {
  createDefaultConfig,
  DEFAULT_PORT,
  getConfigPath,
  loadConfig,
  loadOrCreateConfig,
  proxyBaseUrl,
  proxyListenHost,
  saveConfig,
} from './config.js';
import { createProxyServer, defaultTokenRefresher } from './proxy-server.js';
import { createServerLogWriter } from './log-rotation.js';
import { createSecretStore } from './secret-store.js';
import { renderStatus } from './monitor.js';
import { readCurrentClaudeCredentials } from './claude-credentials.js';
import { fetchProfile, isTokenExpiringSoon, refreshAccessToken } from './oauth.js';
import {
  createNativeClaudeRefresher,
  resolveNativeClaudeCommand,
} from './native-claude-refresher.js';
import {
  installLinuxNodeLauncher,
  installMacosLifecycle,
  installSettings,
  MACOS_LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  renderServiceStartFailureMessage,
  renderSystemdUserService,
  removeInstallState,
  removeLinuxNodeLauncher,
  serviceGenerationForLaunchAgent,
  uninstallMacosLifecycle,
  uninstallSettings,
} from './install.js';
import {
  assertMacosServiceLockHeld,
  MACOS_SERVICE_LOCK_MARKER_ENV,
  MACOS_SERVICE_LOCK_MARKER_VALUE,
  prepareMacosServiceLock,
  reconcileMacosMainService,
  stopMacosMainService,
} from './macos-service.js';
import {
  renderMacosWatchdogLaunchAgentPlist,
  renderMacosWatchdogScript,
} from './macos-watchdog.js';
import {
  appConfigDir,
  backupDir,
  claudeSettingsPath,
  installStatePath,
  macosServiceLockPath,
  macosWatchdogHelperPath,
  macosWatchdogMarkerPath,
  macosWatchdogPlistPath,
  runtimeStatePath,
  xdgConfigHome,
} from './paths.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

const execFileAsync = promisify(execFile);
const CURRENT_ACCOUNT_ID = 'current';
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const MACOS_HIDDEN_SERVICE_ACTION = '__macos-service-action';
const CLAUDE_PROVIDER_OVERRIDE_ENV_VARS = Object.freeze([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
]);
const CLAUDE_LOGIN_OVERRIDE_ENV_VARS = Object.freeze([
  ...CLAUDE_PROVIDER_OVERRIDE_ENV_VARS,
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export async function runCli(argv = [], deps = {}) {
  const write = deps.write || (text => process.stdout.write(text));
  const error = deps.error || (text => process.stderr.write(text));
  const command = argv[0] || 'help';
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;

  try {
    if (command === 'help' || command === '--help' || command === '-h') {
      write(helpText());
      return 0;
    }

    if (command === 'status') {
      const status = deps.readStatus ? await deps.readStatus() : await readStatus();
      write(renderStatus(status));
      return 0;
    }

    if (command === 'monitor') {
      const once = argv.includes('--once') || !process.stdout.isTTY;
      const status = deps.readStatus ? await deps.readStatus() : await readStatus();
      write(renderStatus(status));
      if (!once) await monitorLoop({ write, readStatus: deps.readStatus || readStatus });
      return 0;
    }

    if (command === 'server') {
      await runServer({ write });
      return 0;
    }

    if (command === MACOS_HIDDEN_SERVICE_ACTION) {
      if (platform !== 'darwin') throw new Error('Internal macOS service action is macOS-only');
      assertMacosServiceLockHeld(env);
      const actionArgv = sanitizeMacosServiceActionArgv(argv.slice(1));
      if (actionArgv[0] === 'install') {
        await (deps.installAction || installCommand)({ argv: actionArgv, write, deps });
        return 0;
      }
      await (deps.uninstallAction || uninstallCommand)({ argv: actionArgv, write, deps });
      return 0;
    }

    if ((command === 'install' || command === 'uninstall') && platform === 'darwin') {
      return await (deps.runLockedMacosAction || runMacosCliActionWithLock)({
        argv: sanitizeMacosServiceActionArgv(argv),
        lockPath: macosServiceLockPath(env, deps.home || homedir()),
        nodePath: deps.execPath || process.execPath,
        cliPath: resolve(deps.cliPath || process.argv[1]),
        env,
        prepareLockImpl: deps.prepareLockImpl,
        spawnImpl: deps.spawnImpl,
      });
    }

    if (command === 'install') {
      await (deps.installAction || installCommand)({ argv, write, deps });
      return 0;
    }

    if (command === 'uninstall') {
      await (deps.uninstallAction || uninstallCommand)({ argv, write, deps });
      return 0;
    }

    if (command === 'accounts') {
      const config = await loadOrCreateConfig();
      for (const account of config.accounts) write(`${account.id}\t${account.name}\t${account.type}\n`);
      return 0;
    }

    if (command === 'switch') {
      const account = argv[1];
      if (!account) throw new Error('Usage: claude-rotator switch <account>');
      const status = await postJson('/internal/switch', { account });
      const config = await loadOrCreateConfig();
      config.activeAccount = status.currentAccount || account;
      await saveConfig(config);
      write(`Switched to ${account}\n`);
      return 0;
    }

    if (command === 'refresh-usage') {
      const result = await (deps.postJson || postJson)('/internal/refresh-usage', {});
      const total = result.accounts?.length || 0;
      const ok = (result.accounts || []).filter(account => account.ok).length;
      write(`Refreshed usage for ${ok}/${total} accounts\n`);
      for (const account of result.accounts || []) {
        if (!account.ok) write(`warning: ${account.account}: ${refreshUsageWarning(account)}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === 'prepare-resume') {
      const result = await (deps.postJson || postJson)('/internal/prepare-resume', {
        refreshUsage: argv.includes('--refresh'),
      });
      if (argv.includes('--json')) {
        write(`${JSON.stringify(result)}\n`);
      } else {
        write(renderPrepareResume(result));
      }
      return result.ok ? 0 : 1;
    }

    if (command === 'doctor') {
      return await doctorCommand({ write, deps });
    }

    if (command === 'login') {
      if (argValue(argv, '--json')) await loginJsonCommand({ argv, write, deps });
      else await loginCurrentCommand({ argv, write, deps });
      return 0;
    }

    if (command === 'use-current') {
      await useCurrentCommand({ argv, write, deps });
      return 0;
    }

    if (command === 'remove') {
      await removeCommand({ argv, write, deps });
      return 0;
    }

    if (command === 'import-current') {
      await importCurrentCommand({ argv, write, deps });
      return 0;
    }

    error(`Unknown command: ${command}\n\n${helpText()}`);
    return 1;
  } catch (caught) {
    error(`${caught.message}\n`);
    return 1;
  }
}

export async function runMacosCliActionWithLock({
  argv,
  lockPath,
  nodePath,
  cliPath,
  env = process.env,
  prepareLockImpl = prepareMacosServiceLock,
  spawnImpl = spawn,
}) {
  const safeArgv = sanitizeMacosServiceActionArgv(argv);
  await prepareLockImpl({ lockPath });
  let child;
  try {
    child = spawnImpl('/usr/bin/lockf', [
      '-k',
      lockPath,
      nodePath,
      cliPath,
      MACOS_HIDDEN_SERVICE_ACTION,
      ...safeArgv,
    ], {
      env: {
        ...env,
        [MACOS_SERVICE_LOCK_MARKER_ENV]: MACOS_SERVICE_LOCK_MARKER_VALUE,
      },
      stdio: 'inherit',
    });
  } catch {
    throw new Error('Could not start the locked macOS service action');
  }

  return new Promise((resolveChild, rejectChild) => {
    child.once('error', () => rejectChild(new Error('Could not start the locked macOS service action')));
    child.once('exit', (code, signal) => {
      if (Number.isInteger(code)) {
        resolveChild(code);
        return;
      }
      rejectChild(new Error(`Locked macOS service action ended by ${signal || 'unknown signal'}`));
    });
  });
}

function sanitizeMacosServiceActionArgv(argv) {
  const action = argv[0];
  const allowed = action === 'install'
    ? ['--no-start', '--force']
    : action === 'uninstall'
      ? ['--purge-secrets', '--force']
      : null;
  if (!allowed) throw new Error('Unknown internal macOS service action');
  const provided = argv.slice(1);
  if (provided.some(argument => !allowed.includes(argument))) {
    throw new Error('Invalid macOS service action arguments');
  }
  const selected = new Set(provided);
  return [action, ...allowed.filter(argument => selected.has(argument))];
}

function refreshUsageWarning(account) {
  if (account.error) return account.error;
  if (account.skipped === 'credential-refresh-cooldown') {
    return 'credential refresh cooldown is active';
  }
  if (account.skipped) return `skipped: ${account.skipped}`;
  return 'unknown refresh error';
}

export function helpText() {
  return `Usage:
  claude-rotator install [--no-start] [--force]
  claude-rotator uninstall [--purge-secrets] [--force]
  claude-rotator server
  claude-rotator status
  claude-rotator monitor
  claude-rotator switch <account>
  claude-rotator refresh-usage
  claude-rotator prepare-resume [--json] [--refresh]
  claude-rotator accounts
  claude-rotator login [--id <id>] [--name <email>]
  claude-rotator login --id <id> --name <email> --json -             (read token JSON from stdin; keeps it out of argv)
  claude-rotator login --id <id> --name <email> --json <token-json>  (token appears in ps output and shell history)
  claude-rotator use-current [--name <email>] [--only]
  claude-rotator remove <account> [--keep-secret]
  claude-rotator import-current --id <id> --name <email>
  claude-rotator doctor
`;
}

function renderPrepareResume(result) {
  const account = result.accountName || result.account || '(none)';
  if (result.action === 'ready') {
    const switched = result.switched ? ' (switched)' : '';
    return `Resume target ready: ${account}${switched}\n`;
  }
  if (result.action === 'wait') {
    const wait = result.waitMs == null ? '' : ` in ${Math.ceil(result.waitMs / 60000)}m`;
    const switched = result.switched ? ' (switched)' : '';
    return `Resume target: ${account}${switched}; wait until ${result.resumeAt}${wait}\n`;
  }
  return `No resume target available: ${result.reason || 'unknown'}\n`;
}

async function runServer({ write }) {
  const config = await loadOrCreateConfig();
  const listenHost = proxyListenHost(config);
  const loginOverride = await localClaudeLoginOverrideSource();
  assertAnthropicGatewayProviderCompatible(loginOverride);
  if (loginOverride) assertGatewayCompatibleAccounts(config.accounts);
  if (ensureCredentialRevisions(config)) await saveConfig(config);
  const secretStore = createSecretStore();
  const accountManager = new AccountManager({
    accounts: config.accounts,
    switchThreshold: config.switchThreshold,
    currentAccountId: config.activeAccount,
    rotationPolicy: config.rotationPolicy,
  });
  const statePath = runtimeStatePath();
  const savedState = await readJsonFile(statePath, null).catch(error => {
    write(`runtime state restore skipped: ${shortErrorMessage(error)}\n`);
    return null;
  });
  if (savedState) accountManager.restoreState(savedState);
  const logPath = join(dirname(getConfigPath()), 'server.log');
  const logWriter = process.stdout.isTTY ? null : createServerLogWriter({ logPath });
  const server = createProxyServer({
    accountManager,
    secretStore,
    config,
    allowLiveClaudeCodeCredentials: !loginOverride,
    reloadAccounts: async () => {
      const nextAccounts = (await loadOrCreateConfig()).accounts;
      const nextLoginOverride = await localClaudeLoginOverrideSource();
      assertAnthropicGatewayProviderCompatible(nextLoginOverride);
      if (nextLoginOverride) {
        assertGatewayCompatibleAccounts(nextAccounts);
      }
      return nextAccounts;
    },
    logger: line => {
      if (logWriter) logWriter.write(line);
      else write(`${line}\n`);
    },
    stateWriter: state => writeJsonFile(statePath, state),
    serviceGeneration: process.env.CLAUDE_ROTATOR_SERVICE_GENERATION || null,
  });
  await new Promise(resolve => server.listen(
    config.proxy?.port || DEFAULT_PORT,
    listenHost,
    resolve,
  ));
  write(`claude-rotator listening on ${proxyBaseUrl(config)}\n`);
  try {
    await waitForShutdown(server);
  } finally {
    logWriter?.close();
  }
}

export function assertGatewayCompatibleAccounts(accounts = []) {
  if (accounts.some(account => (
    account.id === CURRENT_ACCOUNT_ID
    || account.credentialSource === 'claude-code-current'
  ))) {
    throw new Error(
      'Gateway authentication cannot be installed while a live current account is configured. Run claude-rotator remove current first, then claude auth login --claudeai and claude-rotator login before installing.',
    );
  }
}

export function assertAnthropicGatewayProviderCompatible(source) {
  if (CLAUDE_PROVIDER_OVERRIDE_ENV_VARS.includes(source)) {
    throw new Error(
      `${source} selects a provider protocol that is incompatible with the Anthropic-compatible claude-rotator gateway. Remove it before installing or starting claude-rotator.`,
    );
  }
}

export function claudeLoginOverrideSource(settings = {}, env = {}) {
  const settingsEnv = settings.env || {};
  for (const name of CLAUDE_LOGIN_OVERRIDE_ENV_VARS) {
    const value = Object.prototype.hasOwnProperty.call(settingsEnv, name)
      ? settingsEnv[name]
      : env[name];
    if (value != null && String(value) !== '') return name;
  }
  if (settings.apiKeyHelper != null && String(settings.apiKeyHelper) !== '') {
    return 'apiKeyHelper';
  }
  return null;
}

async function localClaudeLoginOverrideSource() {
  const home = homedir();
  const settings = await readJsonFile(claudeSettingsPath(home), {});
  return claudeLoginOverrideSource(settings, process.env);
}

export function ensureCredentialRevisions(config, {
  createRevision = randomUUID,
} = {}) {
  let changed = false;
  config.accounts = (config.accounts || []).map(account => {
    if (typeof account.credentialRevision === 'string' && account.credentialRevision.length > 0) {
      return account;
    }
    changed = true;
    return { ...account, credentialRevision: createRevision() };
  });
  return changed;
}

function waitForShutdown(server) {
  return new Promise(resolve => {
    const shutdown = () => {
      closeServerWithDeadline(server).then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

export function closeServerWithDeadline(server, timeoutMs = DEFAULT_SHUTDOWN_GRACE_MS) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);

    server.close(finish);
    server.closeIdleConnections?.();
  });
}

async function installCommand({ argv, write, deps = {} }) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const config = await loadOrCreateConfig();
  assertAnthropicGatewayProviderCompatible(await localClaudeLoginOverrideSource());
  assertGatewayCompatibleAccounts(config.accounts);
  const configPath = getConfigPath();
  const statePath = installStatePath(env, home);
  const settingsPath = claudeSettingsPath(home);
  const force = argv.includes('--force');
  const noStart = argv.includes('--no-start');
  let claudePath = null;
  if (['darwin', 'linux'].includes(platform)) {
    claudePath = await resolveNativeClaudeCommand();
    if (!isAbsolute(claudePath)) {
      throw new Error('Could not resolve an absolute Claude Code executable for the service');
    }
    await access(claudePath, fsConstants.X_OK);
    if (!(await stat(claudePath)).isFile()) {
      throw new Error('Claude Code executable for the service is not a regular file');
    }
  }
  if (platform === 'darwin') {
    await installMacosCommand({
      argv,
      write,
      deps,
      env,
      home,
      config,
      configPath,
      settingsPath,
      statePath,
      claudePath,
      force,
      noStart,
    });
    return;
  }
  await installSettings({
    settingsPath,
    installStatePath: statePath,
    backupDir: backupDir(env, home),
    proxyBaseUrl: proxyBaseUrl(config),
    force,
  });
  await installServiceFile({
    configPath,
    claudePath,
    env,
    home,
    claudeConfigDir: dirname(settingsPath),
  });
  write(`Installed claude-rotator at ${proxyBaseUrl(config)}\n`);
  if (noStart) {
    write('Service start skipped because --no-start was set.\n');
    return;
  }
  try {
    await startService();
    write('Service started\n');
  } catch (caught) {
    write(`${renderServiceStartFailureMessage({
      platform: process.platform,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      error: caught,
    })}\n`);
  }
}

async function purgeTargetAccountIds(configPath) {
  const config = await loadConfig(configPath).catch(() => null);
  const ids = (config?.accounts || []).map(account => account.id).filter(Boolean);
  return [...new Set([...ids, CURRENT_ACCOUNT_ID])];
}

async function uninstallCommand({ argv, write, deps = {} }) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const configPath = getConfigPath(env);
  const statePath = installStatePath(env, home);
  const settingsPath = claudeSettingsPath(home);
  const force = argv.includes('--force');
  const purgeSecrets = argv.includes('--purge-secrets');
  const purgeAccountIds = purgeSecrets ? await purgeTargetAccountIds(configPath) : [];
  if (platform === 'darwin') {
    await uninstallMacosLifecycle({
      uid: deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null),
      env,
      paths: macosLifecyclePaths({ env, home, settingsPath, statePath }),
      force,
      purgeSecrets,
      execFileImpl: deps.execFileImpl || execFileAsync,
      purgeSecretsImpl: async () => (deps.secretStoreFactory || createSecretStore)({ platform, env, home })
        .purge(purgeAccountIds),
    });
    write('Uninstalled claude-rotator\n');
    return;
  }
  const result = await uninstallSettings({ settingsPath, installStatePath: statePath, force });
  if (result.conflict) throw new Error(result.reason);
  await stopService().catch(() => {});
  await removeServiceFile({ configPath, env, home });
  await removeInstallState(statePath);
  if (purgeSecrets) {
    await (deps.secretStoreFactory || createSecretStore)({ platform, env, home }).purge(purgeAccountIds);
  }
  write('Uninstalled claude-rotator\n');
}

async function installMacosCommand({
  write,
  deps,
  env,
  home,
  config,
  configPath,
  settingsPath,
  statePath,
  claudePath,
  force,
  noStart,
}) {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  const cliPath = resolve(deps.cliPath || process.argv[1]);
  const servicePath = serviceEnvironmentPath(claudePath);
  const generationOptions = {
    nodePath: process.execPath,
    cliPath,
    configPath,
    claudeConfigDir: dirname(settingsPath),
    claudePath,
    servicePath,
    ...serviceXdgOverrides(env),
  };
  const serviceGeneration = serviceGenerationForLaunchAgent(generationOptions);
  const paths = macosLifecyclePaths({ env, home, settingsPath, statePath });
  const domain = `gui/${uid}`;
  const artifacts = {
    mainPlist: renderLaunchAgentPlist({ ...generationOptions, serviceGeneration }),
    helper: renderMacosWatchdogScript({
      markerPath: paths.markerPath,
      installStatePath: paths.installStatePath,
      mainPlistPath: paths.mainPlistPath,
      domain,
    }),
    watchdogPlist: renderMacosWatchdogLaunchAgentPlist({
      lockPath: macosServiceLockPath(env, home),
      helperPath: paths.helperPath,
    }),
  };

  await installMacosLifecycle({
    uid,
    env,
    paths,
    artifacts,
    backupDir: backupDir(env, home),
    proxyBaseUrl: proxyBaseUrl(config),
    expectedServiceGeneration: serviceGeneration,
    healthCheck: deps.healthCheck || readHealth,
    force,
    noStart,
    execFileImpl: deps.execFileImpl || execFileAsync,
  });
  write(`Installed claude-rotator at ${proxyBaseUrl(config)}\n`);
  if (noStart) write('Service start skipped because --no-start was set.\n');
  else write('Service and watchdog started\n');
}

function macosLifecyclePaths({ env, home, settingsPath, statePath }) {
  return {
    settingsPath,
    installStatePath: statePath,
    markerPath: macosWatchdogMarkerPath(env, home),
    mainPlistPath: macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL, home),
    watchdogPlistPath: macosWatchdogPlistPath(home),
    helperPath: macosWatchdogHelperPath(env, home),
  };
}

function serviceXdgOverrides(env) {
  return {
    xdgConfigHome: env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : null,
    xdgDataHome: env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : null,
  };
}

function serviceEnvironmentPath(claudePath) {
  return [...new Set([
    claudePath ? dirname(claudePath) : null,
    dirname(process.execPath),
    process.env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean))].join(':');
}

async function loginJsonCommand({ argv, write, deps }) {
  const id = argValue(argv, '--id');
  const name = argValue(argv, '--name') || id;
  const jsonArg = argValue(argv, '--json');
  if (!id || !jsonArg) throw new Error('Usage: claude-rotator login --id <id> --name <email> --json <token-json>');
  assertSnapshotAccountId(id);

  const json = jsonArg === '-' ? await readStdinJson(deps) : jsonArg;
  const secret = parseTokenJson(json);
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  const store = deps.secretStore || createSecretStore();
  const previousSecret = await store.get(id);
  await store.replaceLinkedCredential(id, secret);

  const existing = config.accounts.findIndex(item => item.id === id);
  const account = {
    id,
    name,
    type: secret.apiKey ? 'apikey' : 'oauth',
    credentialRevision: credentialRevisionAfterWrite(
      config.accounts[existing],
      previousSecret,
      secret,
    ),
  };
  if (existing >= 0) config.accounts[existing] = account;
  else config.accounts.push(account);
  if (deps.saveConfig) await deps.saveConfig(config);
  else await saveConfig(config);
  await notifyReload({ deps, write });
  write(`Added ${name}\n`);
}

async function readStdinJson(deps) {
  const stdin = deps.stdin || process.stdin;
  if (stdin.isTTY) {
    throw new Error(
      'login --json - reads the token JSON from stdin, but stdin is a terminal. Pipe the JSON instead.'
    );
  }
  const input = (await readStdinText(stdin)).trim();
  if (!input) {
    throw new Error('login --json - received no token JSON on stdin.');
  }
  return input;
}

function parseTokenJson(json) {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(
      'Could not parse the token JSON. Expected an object such as {"accessToken":"...","refreshToken":"..."}.'
    );
  }
}

async function loginCurrentCommand({ argv, write, deps }) {
  const secret = deps.readCurrentCredentials
    ? await deps.readCurrentCredentials()
    : await readCurrentClaudeCredentials();
  if (!secret.refreshToken) {
    throw new Error(
      'Current Claude Code credentials do not include a refresh token. ' +
      'Run claude auth login --claudeai, then retry claude-rotator login.'
    );
  }
  const profile = await readProfileForLogin(secret, deps);
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  const explicitId = Boolean(argValue(argv, '--id'));
  const explicitName = Boolean(argValue(argv, '--name'));
  if (!profile && !explicitId && !explicitName) {
    throw new Error(
      'Could not verify the current Claude Code login. ' +
      'Run claude auth login --claudeai and retry, or pass both --id and --name for a known-good credential.'
    );
  }
  const name = argValue(argv, '--name') || profile?.email || argValue(argv, '--id') || nextAccountId(config);
  const id = argValue(argv, '--id') || accountIdFromName(name);
  assertSnapshotAccountId(id);

  if (deps.saveImportedAccount) {
    await deps.saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret });
  } else {
    await saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret, explicitId }, deps);
  }
  await notifyReload({ deps, write });
  write(`Imported ${name}\n`);
}

async function importCurrentCommand({ argv, write, deps }) {
  const id = argValue(argv, '--id');
  if (!id) throw new Error('Usage: claude-rotator import-current --id <id> --name <email>');
  assertSnapshotAccountId(id);

  const secret = deps.readCurrentCredentials
    ? await deps.readCurrentCredentials()
    : await readCurrentClaudeCredentials();
  const profile = await readProfileForLogin(secret, deps);
  const name = argValue(argv, '--name') || profile?.email || id;
  if (deps.saveImportedAccount) {
    await deps.saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret });
  } else {
    await saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret, explicitId: true }, deps);
  }
  await notifyReload({ deps, write });
  write(`Imported ${name}\n`);
}

async function useCurrentCommand({ argv, write, deps }) {
  const gatewayAuthConfigured = deps.isGatewayAuthConfigured
    ? await deps.isGatewayAuthConfigured()
    : Boolean(await localClaudeLoginOverrideSource());
  if (gatewayAuthConfigured) {
    throw new Error(
      'use-current is incompatible with installed gateway authentication because Claude Code does not refresh its saved /login while a gateway credential is active. Use claude-rotator login to save the account instead.',
    );
  }
  const secret = deps.readCurrentCredentials
    ? await deps.readCurrentCredentials()
    : await readCurrentClaudeCredentials();
  const profile = await readProfileForLogin(secret, deps);
  const name = argValue(argv, '--name') || profile?.email || 'current';
  const account = {
    id: CURRENT_ACCOUNT_ID,
    name,
    type: 'oauth',
    credentialSource: 'claude-code-current',
  };
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  config.accounts ||= [];

  if (argv.includes('--only')) {
    config.accounts = [account];
  } else {
    const duplicate = findAccountByUuid(config.accounts, profile?.accountUuid, CURRENT_ACCOUNT_ID);
    if (duplicate) {
      throw new Error(
        `Current Claude Code login is already registered as ${duplicate.id}. ` +
        'Use claude-rotator use-current --only or remove the saved account first.'
      );
    }
    const existing = config.accounts.findIndex(item => item.id === CURRENT_ACCOUNT_ID);
    if (existing >= 0) config.accounts[existing] = account;
    else config.accounts.unshift(account);
  }

  if (deps.saveConfig) await deps.saveConfig(config);
  else await saveConfig(config);
  await notifyReload({ deps, write });
  write(`Using live Claude Code login as ${name}\n`);
}

async function removeCommand({ argv, write, deps }) {
  const accountRef = argv[1];
  if (!accountRef) throw new Error('Usage: claude-rotator remove <account> [--keep-secret]');

  const keepSecret = argv.includes('--keep-secret');
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  const account = resolveAccount(config.accounts || [], accountRef);
  config.accounts = (config.accounts || []).filter(item => item.id !== account.id);

  if (deps.saveConfig) await deps.saveConfig(config);
  else await saveConfig(config);

  if (!keepSecret) {
    if (deps.deleteSecret) await deps.deleteSecret(account.id);
    else await createSecretStore().delete(account.id);
  }

  await notifyReload({ deps, write });
  write(`Removed ${account.id} (${account.name || account.id})\n`);
}

async function saveImportedAccount({ id, name, accountUuid = null, secret, explicitId = false }, deps = {}) {
  assertSnapshotAccountId(id);
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  config.accounts ||= [];
  const duplicate = findAccountByUuid(config.accounts, accountUuid, id);
  let targetId = id;
  if (duplicate) {
    if (explicitId) {
      throw new Error(
        `Claude account is already registered as ${duplicate.id} (${duplicate.name || duplicate.id}). ` +
        'Use that account id or remove it first.'
      );
    }
    targetId = duplicate.id;
  }

  const store = deps.secretStore || createSecretStore();
  const previousSecret = await store.get(targetId);
  if (typeof store.replaceLinkedCredential !== 'function') {
    throw new Error('Secret store does not support explicit credential replacement');
  }
  await store.replaceLinkedCredential(targetId, secret);
  const existing = config.accounts.findIndex(item => item.id === targetId);
  const account = {
    id: targetId,
    name,
    type: secret.apiKey ? 'apikey' : 'oauth',
    accountUuid,
    credentialRevision: credentialRevisionAfterWrite(
      config.accounts[existing],
      previousSecret,
      secret,
    ),
  };
  if (existing >= 0) config.accounts[existing] = account;
  else config.accounts.push(account);
  if (deps.saveConfig) await deps.saveConfig(config);
  else await saveConfig(config);
}

function credentialRevisionAfterWrite(existingAccount, previousSecret, nextSecret) {
  if (isDeepStrictEqual(previousSecret, nextSecret)) {
    return existingAccount?.credentialRevision || null;
  }
  return randomUUID();
}

async function readProfileForLogin(secret, deps) {
  if (secret.apiKey || !secret.accessToken) return null;
  try {
    return deps.fetchProfile ? await deps.fetchProfile(secret.accessToken) : await fetchProfile(secret.accessToken);
  } catch {
    return null;
  }
}

async function doctorCommand({ write, deps }) {
  const status = deps.readHealth ? await deps.readHealth() : await readHealth();
  write(`server: ${status.ok ? 'ok' : 'error'}\n`);

  const warnings = await inspectDoctorWarnings(deps);
  if (warnings.length === 0) {
    write('accounts: ok\n');
  } else {
    for (const warning of warnings) write(`warning: ${warning}\n`);
  }

  return status.ok ? 0 : 1;
}

async function inspectDoctorWarnings(deps = {}) {
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  const accounts = config.accounts || [];
  const warnings = duplicateAccountUuidWarnings(accounts);
  const store = deps.secretStore || createSecretStore();
  const readCurrent = deps.readCurrentCredentials || readCurrentClaudeCredentials;
  const profileFetcher = deps.fetchProfile || fetchProfile;
  const tokenRefresher = deps.refreshAccessToken || defaultTokenRefresher({
    platform: deps.platform || process.platform,
    nativeRefresherFactory: options => createNativeClaudeRefresher(options),
    directRefresher: refreshAccessToken,
  });
  const liveProfiles = [];

  for (const account of accounts) {
    if (account.type === 'apikey') continue;

    try {
      const secret = account.id === CURRENT_ACCOUNT_ID
        ? await readCurrent()
        : await getOperationalSecret(store, account.id);

      if (!secret) {
        warnings.push(`${account.id}: stored credential is missing`);
        continue;
      }
      if (!secret.accessToken) {
        warnings.push(`${account.id}: OAuth access token is missing`);
        continue;
      }

      const profileSecret = await refreshDoctorSecretIfNeeded({
        account,
        secret,
        store,
        tokenRefresher,
      });
      let profile;
      try {
        profile = await profileFetcher(profileSecret.accessToken);
      } catch (profileError) {
        if (
          account.id === CURRENT_ACCOUNT_ID
          || !secret.refreshToken
          || profileSecret !== secret
        ) throw profileError;
        const refreshedSecret = await refreshDoctorSecret({
          account,
          secret,
          store,
          tokenRefresher,
        });
        profile = await profileFetcher(refreshedSecret.accessToken);
      }
      if (profile?.accountUuid) liveProfiles.push({ id: account.id, accountUuid: profile.accountUuid });
      if (profile?.email && account.name && profile.email !== account.name) {
        warnings.push(`${account.id}: config name ${account.name} differs from live login ${profile.email}`);
      }
      if (account.id === CURRENT_ACCOUNT_ID && account.accountUuid) {
        warnings.push(`${account.id}: static accountUuid is obsolete; run claude-rotator remove current first, then claude auth login --claudeai and claude-rotator login`);
      } else if (profile?.accountUuid && account.accountUuid && profile.accountUuid !== account.accountUuid) {
        warnings.push(`${account.id}: config accountUuid differs from live login`);
      }
    } catch (caught) {
      warnings.push(`${account.id}: credential profile check failed: ${shortErrorMessage(caught)}`);
    }
  }

  warnings.push(...duplicateAccountUuidWarnings(liveProfiles).map(warning => `live ${warning}`));
  return warnings;
}

async function refreshDoctorSecretIfNeeded({ account, secret, store, tokenRefresher }) {
  if (account.id === CURRENT_ACCOUNT_ID) return secret;
  if (!secret.refreshToken || !isTokenExpiringSoon(secret.expiresAt)) return secret;
  return refreshDoctorSecret({ account, secret, store, tokenRefresher });
}

async function refreshDoctorSecret({ account, secret, store, tokenRefresher }) {
  if (account.id === CURRENT_ACCOUNT_ID) {
    throw new Error('Live Claude Code credentials must be refreshed by Claude Code');
  }
  if (typeof store?.refreshIfUnchanged !== 'function') {
    const error = new Error('Secret store does not support conditional update transaction');
    error.code = 'SECRET_STORE_TRANSACTION_UNAVAILABLE';
    throw error;
  }
  const result = await store.refreshIfUnchanged(
    account.id,
    secret,
    async (currentSecret, transaction) => ({
      ...currentSecret,
      ...(await tokenRefresher(
        currentSecret.refreshToken,
        tokenRefreshContext(account, currentSecret, transaction),
      )),
    }),
  );
  if (!result.updated) {
    if (result.secret?.accessToken) return result.secret;
    throw new Error('Stored OAuth credential changed while token refresh was in flight');
  }
  return result.secret;
}

function tokenRefreshContext(account, secret, transaction = {}) {
  return {
    accountId: account.id,
    accessToken: secret.accessToken,
    refreshToken: secret.refreshToken,
    expiresAt: secret.expiresAt,
    scopes: secret.scopes,
    refreshTokenExpiresAt: secret.refreshTokenExpiresAt,
    clientId: secret.clientId,
    subscriptionType: secret.subscriptionType,
    rateLimitTier: secret.rateLimitTier,
    beforeHandoff: transaction.beforeHandoff,
    retractHandoff: transaction.retractHandoff,
    protectChildPid: transaction.protectChildPid,
    clearChildPid: transaction.clearChildPid,
  };
}

function getOperationalSecret(store, accountId) {
  if (typeof store?.getOperational === 'function') return store.getOperational(accountId);
  return store.get(accountId);
}

function duplicateAccountUuidWarnings(accounts) {
  const byUuid = new Map();
  for (const account of accounts) {
    if (!account.accountUuid) continue;
    const existing = byUuid.get(account.accountUuid) || [];
    existing.push(account.id);
    byUuid.set(account.accountUuid, existing);
  }

  return [...byUuid.values()]
    .filter(ids => ids.length > 1)
    .map(ids => `duplicate accountUuid for ${ids.join(', ')}`);
}

function findAccountByUuid(accounts, accountUuid, excludingId = null) {
  if (!accountUuid) return null;
  return accounts.find(account => account.accountUuid === accountUuid && account.id !== excludingId) || null;
}

function assertSnapshotAccountId(id) {
  if (id === CURRENT_ACCOUNT_ID) {
    throw new Error('Account id "current" is reserved for claude-rotator use-current');
  }
}

function resolveAccount(accounts, accountRef) {
  const byId = accounts.find(account => account.id === accountRef);
  if (byId) return byId;

  const byName = accounts.filter(account => account.name === accountRef);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(`Account name matches multiple ids: ${byName.map(account => account.id).join(', ')}`);
  }
  throw new Error(`Unknown account: ${accountRef}`);
}

function shortErrorMessage(error) {
  return String(error?.message || error || 'unknown error').replace(/\s+/g, ' ').slice(0, 240);
}

async function notifyReload({ deps, write }) {
  try {
    if (deps.reloadServer) await deps.reloadServer();
    else await reloadServer();
  } catch (caught) {
    write(`Saved account. Server reload skipped: ${caught.message}\n`);
  }
}

async function reloadServer() {
  await postJson('/internal/reload', {});
}

function accountIdFromName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'account';
}

function nextAccountId(config) {
  const used = new Set((config.accounts || []).map(account => account.id));
  for (let i = 1; i < 1000; i++) {
    const id = `account${i}`;
    if (!used.has(id)) return id;
  }
  return `account${Date.now()}`;
}

export async function installServiceFile({
  configPath,
  claudePath = null,
  env = process.env,
  home = homedir(),
  claudeConfigDir = null,
}) {
  const cliPath = resolve(process.argv[1]);
  const servicePath = [...new Set([
    claudePath ? dirname(claudePath) : null,
    dirname(process.execPath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean))].join(':');
  const xdgOverrides = serviceXdgOverrides(env);
  if (process.platform === 'darwin') {
    const path = macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL, home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderLaunchAgentPlist({
      nodePath: process.execPath,
      cliPath,
      configPath,
      claudeConfigDir,
      claudePath,
      servicePath,
      ...xdgOverrides,
    }), 'utf8');
    return;
  }
  const nodePath = await installLinuxNodeLauncher({ nodePath: process.execPath, configPath });
  const service = renderSystemdUserService({
    nodePath,
    cliPath,
    configPath,
    claudeConfigDir,
    claudePath,
    servicePath,
    ...xdgOverrides,
  });
  const path = join(appConfigDir(env, home), 'claude-rotator.service');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, service, 'utf8');
  const systemdUserDir = join(xdgConfigHome(env, home), 'systemd', 'user');
  await mkdir(systemdUserDir, { recursive: true });
  await writeFile(join(systemdUserDir, 'claude-rotator.service'), service, 'utf8');
}

export async function removeServiceFile({ configPath, env = process.env, home = homedir() }) {
  await rm(macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL, home), { force: true });
  const xdgServicePath = join(xdgConfigHome(env, home), 'systemd', 'user', 'claude-rotator.service');
  await rm(xdgServicePath, { force: true });
  const legacyServicePath = join(home, '.config', 'systemd', 'user', 'claude-rotator.service');
  if (legacyServicePath !== xdgServicePath) {
    await rm(legacyServicePath, { force: true });
  }
  await removeLinuxNodeLauncher(configPath);
}

export async function startService({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  execFileImpl = execFileAsync,
  plistPath = macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL),
  definitionChanged = false,
  env = process.env,
} = {}) {
  if (platform === 'darwin') {
    return reconcileMacosMainService({
      uid,
      plistPath,
      definitionChanged,
      env,
      execFileImpl,
    });
  }
  await execFileImpl('systemctl', ['--user', 'daemon-reload']);
  await execFileImpl('systemctl', ['--user', 'enable', 'claude-rotator.service']);
  await execFileImpl('systemctl', ['--user', 'restart', 'claude-rotator.service']);
}

async function stopService({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  env = process.env,
  execFileImpl = execFileAsync,
} = {}) {
  if (platform === 'darwin') {
    return stopMacosMainService({ uid, env, execFileImpl });
  }
  await execFileImpl('systemctl', ['--user', 'disable', '--now', 'claude-rotator.service']);
}

function macosLaunchAgentPath(label, home = homedir()) {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

async function monitorLoop({ write, readStatus }) {
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    write('\x1b[H\x1b[2J');
    write(renderStatus(await readStatus()));
  }
}

async function readStatus() {
  const config = await loadOrCreateConfig();
  return getJson(internalApiUrl(config, '/internal/status'));
}

async function readHealth({ signal } = {}) {
  const config = await loadOrCreateConfig();
  return getJson(internalApiUrl(config, '/internal/health'), { signal });
}

async function postJson(path, body) {
  const config = await loadOrCreateConfig();
  return requestJson(internalApiUrl(config, path), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

export function internalApiUrl(config, path) {
  return `${proxyBaseUrl(config)}${path}`;
}

async function getJson(url, { signal } = {}) {
  return requestJson(url, { method: 'GET', signal });
}

export async function requestJson(url, options) {
  const target = new URL(url);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(target, {
      method: options.method,
      headers: options.headers || {},
      signal: options.signal,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}: ${response.text}`);
  }
  return JSON.parse(response.text);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}
