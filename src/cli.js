import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { AccountManager } from './account-manager.js';
import { createDefaultConfig, getConfigPath, loadOrCreateConfig, proxyBaseUrl, saveConfig } from './config.js';
import { createProxyServer } from './proxy-server.js';
import { createSecretStore } from './secret-store.js';
import { renderStatus } from './monitor.js';
import { readCurrentClaudeCredentials } from './claude-credentials.js';
import { fetchProfile, isTokenExpiringSoon, refreshAccessToken } from './oauth.js';
import {
  installSettings,
  MACOS_LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  renderServiceStartFailureMessage,
  renderSystemdUserService,
  removeInstallState,
  uninstallSettings,
} from './install.js';
import { appConfigDir, backupDir, claudeSettingsPath, installStatePath } from './paths.js';

const execFileAsync = promisify(execFile);
const CURRENT_ACCOUNT_ID = 'current';

export async function runCli(argv = [], deps = {}) {
  const write = deps.write || (text => process.stdout.write(text));
  const error = deps.error || (text => process.stderr.write(text));
  const command = argv[0] || 'help';

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

    if (command === 'install') {
      await installCommand({ argv, write });
      return 0;
    }

    if (command === 'uninstall') {
      await uninstallCommand({ argv, write });
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
      const result = await postJson('/internal/refresh-usage', {});
      const total = result.accounts?.length || 0;
      const ok = (result.accounts || []).filter(account => account.ok).length;
      write(`Refreshed usage for ${ok}/${total} accounts\n`);
      for (const account of result.accounts || []) {
        if (!account.ok) write(`warning: ${account.account}: ${account.error}\n`);
      }
      return result.ok ? 0 : 1;
    }

    if (command === 'doctor') {
      return doctorCommand({ write, deps });
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

export function helpText() {
  return `Usage:
  claude-rotator install [--no-start] [--force]
  claude-rotator uninstall [--purge-secrets] [--force]
  claude-rotator server
  claude-rotator status
  claude-rotator monitor
  claude-rotator switch <account>
  claude-rotator refresh-usage
  claude-rotator accounts
  claude-rotator login [--id <id>] [--name <email>]
  claude-rotator login --id <id> --name <email> --json <token-json>
  claude-rotator use-current [--name <email>] [--only]
  claude-rotator remove <account> [--keep-secret]
  claude-rotator import-current --id <id> --name <email>
  claude-rotator doctor
`;
}

async function runServer({ write }) {
  const config = await loadOrCreateConfig();
  const secretStore = createSecretStore();
  const accountManager = new AccountManager({
    accounts: config.accounts,
    switchThreshold: config.switchThreshold,
    currentAccountId: config.activeAccount,
    rotationPolicy: config.rotationPolicy,
  });
  const server = createProxyServer({
    accountManager,
    secretStore,
    config,
    reloadAccounts: async () => (await loadOrCreateConfig()).accounts,
    logger: line => write(`${line}\n`),
  });
  await new Promise(resolve => server.listen(config.proxy.port, config.proxy.host, resolve));
  write(`claude-rotator listening on ${proxyBaseUrl(config)}\n`);
  await waitForShutdown(server);
}

function waitForShutdown(server) {
  return new Promise(resolve => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

async function installCommand({ argv, write }) {
  const config = await loadOrCreateConfig();
  const home = homedir();
  const configPath = getConfigPath();
  const statePath = installStatePath(process.env, home);
  const settingsPath = claudeSettingsPath(home);
  const force = argv.includes('--force');
  const noStart = argv.includes('--no-start');
  await installSettings({
    settingsPath,
    installStatePath: statePath,
    backupDir: backupDir(process.env, home),
    proxyBaseUrl: proxyBaseUrl(config),
    force,
  });
  await installServiceFile({ configPath });
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

async function uninstallCommand({ argv, write }) {
  const home = homedir();
  const statePath = installStatePath(process.env, home);
  const settingsPath = claudeSettingsPath(home);
  const force = argv.includes('--force');
  const purgeSecrets = argv.includes('--purge-secrets');
  await stopService().catch(() => {});
  const result = await uninstallSettings({ settingsPath, installStatePath: statePath, force });
  if (result.conflict) throw new Error(result.reason);
  await removeServiceFile();
  await removeInstallState(statePath);
  if (purgeSecrets) await createSecretStore().purge();
  write('Uninstalled claude-rotator\n');
}

async function loginJsonCommand({ argv, write, deps }) {
  const id = argValue(argv, '--id');
  const name = argValue(argv, '--name') || id;
  const json = argValue(argv, '--json');
  if (!id || !json) throw new Error('Usage: claude-rotator login --id <id> --name <email> --json <token-json>');
  assertSnapshotAccountId(id);

  const secret = JSON.parse(json);
  const config = await loadOrCreateConfig();
  const store = createSecretStore();
  await store.set(id, secret);

  const account = { id, name, type: secret.apiKey ? 'apikey' : 'oauth' };
  const existing = config.accounts.findIndex(item => item.id === id);
  if (existing >= 0) config.accounts[existing] = account;
  else config.accounts.push(account);
  await saveConfig(config);
  await notifyReload({ deps, write });
  write(`Added ${name}\n`);
}

async function loginCurrentCommand({ argv, write, deps }) {
  const secret = deps.readCurrentCredentials
    ? await deps.readCurrentCredentials()
    : await readCurrentClaudeCredentials();
  if (!secret.refreshToken) {
    throw new Error(
      'Current Claude Code credentials do not include a refresh token. ' +
      'Run claude auth login, then retry claude-rotator login.'
    );
  }
  const profile = await readProfileForLogin(secret, deps);
  const config = deps.loadConfig ? await deps.loadConfig() : await loadOrCreateConfig();
  const explicitId = Boolean(argValue(argv, '--id'));
  const explicitName = Boolean(argValue(argv, '--name'));
  if (!profile && !explicitId && !explicitName) {
    throw new Error(
      'Could not verify the current Claude Code login. ' +
      'Run claude auth login and retry, or pass both --id and --name for a known-good credential.'
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
  await store.set(targetId, secret);
  const account = { id: targetId, name, type: secret.apiKey ? 'apikey' : 'oauth', accountUuid };
  const existing = config.accounts.findIndex(item => item.id === targetId);
  if (existing >= 0) config.accounts[existing] = account;
  else config.accounts.push(account);
  if (deps.saveConfig) await deps.saveConfig(config);
  else await saveConfig(config);
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
  const tokenRefresher = deps.refreshAccessToken || refreshAccessToken;
  const liveProfiles = [];

  for (const account of accounts) {
    if (account.type === 'apikey') continue;

    try {
      const secret = account.id === CURRENT_ACCOUNT_ID
        ? await readCurrent()
        : await store.get(account.id);

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
        if (!secret.refreshToken || profileSecret !== secret) throw profileError;
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
        warnings.push(`${account.id}: static accountUuid is obsolete; run claude-rotator use-current to normalize it`);
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
  if (!secret.refreshToken || !isTokenExpiringSoon(secret.expiresAt)) return secret;
  return refreshDoctorSecret({ account, secret, store, tokenRefresher });
}

async function refreshDoctorSecret({ account, secret, store, tokenRefresher }) {
  const refreshed = { ...secret, ...(await tokenRefresher(secret.refreshToken)) };
  if (account.id !== CURRENT_ACCOUNT_ID && store.set) await store.set(account.id, refreshed);
  return refreshed;
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

async function installServiceFile({ configPath }) {
  const cliPath = resolve(process.argv[1]);
  if (process.platform === 'darwin') {
    const path = macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, renderLaunchAgentPlist({ nodePath: process.execPath, cliPath, configPath }), 'utf8');
    return;
  }
  const path = join(appConfigDir(), 'claude-rotator.service');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderSystemdUserService({ nodePath: process.execPath, cliPath, configPath }), 'utf8');
  await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(join(homedir(), '.config', 'systemd', 'user', 'claude-rotator.service'), renderSystemdUserService({ nodePath: process.execPath, cliPath, configPath }), 'utf8');
}

async function removeServiceFile() {
  await rm(macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL), { force: true });
  await rm(join(homedir(), '.config', 'systemd', 'user', 'claude-rotator.service'), { force: true });
}

async function startService() {
  if (process.platform === 'darwin') {
    const plist = macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL);
    await execFileAsync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    return;
  }
  await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  await execFileAsync('systemctl', ['--user', 'enable', '--now', 'claude-rotator.service']);
}

async function stopService() {
  if (process.platform === 'darwin') {
    await execFileAsync('launchctl', ['bootout', `gui/${process.getuid()}`, macosLaunchAgentPath(MACOS_LAUNCH_AGENT_LABEL)]);
    return;
  }
  await execFileAsync('systemctl', ['--user', 'disable', '--now', 'claude-rotator.service']);
}

function macosLaunchAgentPath(label) {
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
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
  return getJson(`http://${config.proxy.host}:${config.proxy.port}/internal/status`);
}

async function readHealth() {
  const config = await loadOrCreateConfig();
  return getJson(`http://${config.proxy.host}:${config.proxy.port}/internal/health`);
}

async function postJson(path, body) {
  const config = await loadOrCreateConfig();
  return requestJson(`http://${config.proxy.host}:${config.proxy.port}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getJson(url) {
  return requestJson(url, { method: 'GET' });
}

async function requestJson(url, options) {
  const target = new URL(url);
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers: options.headers || {},
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
