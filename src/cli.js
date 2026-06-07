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
import { fetchProfile } from './oauth.js';
import {
  installSettings,
  renderLaunchAgentPlist,
  renderServiceStartFailureMessage,
  renderSystemdUserService,
  removeInstallState,
  uninstallSettings,
} from './install.js';
import { appConfigDir, backupDir, claudeSettingsPath, installStatePath } from './paths.js';

const execFileAsync = promisify(execFile);

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
      await postJson('/internal/switch', { account });
      write(`Switched to ${account}\n`);
      return 0;
    }

    if (command === 'doctor') {
      const status = await readHealth();
      write(`server: ${status.ok ? 'ok' : 'error'}\n`);
      return status.ok ? 0 : 1;
    }

    if (command === 'login') {
      if (argValue(argv, '--json')) await loginJsonCommand({ argv, write, deps });
      else await loginCurrentCommand({ argv, write, deps });
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
  claude-rotator accounts
  claude-rotator login [--id <id>] [--name <email>]
  claude-rotator login --id <id> --name <email> --json <token-json>
  claude-rotator import-current --id <id> --name <email>
  claude-rotator doctor
`;
}

async function runServer({ write }) {
  const config = await loadOrCreateConfig();
  const secretStore = createSecretStore();
  const accountManager = new AccountManager({ accounts: config.accounts, switchThreshold: config.switchThreshold });
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
  const profile = await readProfileForLogin(secret, deps);
  const config = await loadOrCreateConfig();
  const name = argValue(argv, '--name') || profile?.email || argValue(argv, '--id') || nextAccountId(config);
  const id = argValue(argv, '--id') || accountIdFromName(name);

  if (deps.saveImportedAccount) {
    await deps.saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret });
  } else {
    await saveImportedAccount({ id, name, accountUuid: profile?.accountUuid || null, secret });
  }
  await notifyReload({ deps, write });
  write(`Imported ${name}\n`);
}

async function importCurrentCommand({ argv, write, deps }) {
  const id = argValue(argv, '--id');
  const name = argValue(argv, '--name') || id;
  if (!id) throw new Error('Usage: claude-rotator import-current --id <id> --name <email>');

  const secret = deps.readCurrentCredentials
    ? await deps.readCurrentCredentials()
    : await readCurrentClaudeCredentials();
  if (deps.saveImportedAccount) {
    await deps.saveImportedAccount({ id, name, secret });
  } else {
    await saveImportedAccount({ id, name, secret });
  }
  await notifyReload({ deps, write });
  write(`Imported ${name}\n`);
}

async function saveImportedAccount({ id, name, accountUuid = null, secret }) {
  const config = await loadOrCreateConfig();
  const store = createSecretStore();
  await store.set(id, secret);
  const account = { id, name, type: secret.apiKey ? 'apikey' : 'oauth', accountUuid };
  const existing = config.accounts.findIndex(item => item.id === id);
  if (existing >= 0) config.accounts[existing] = account;
  else config.accounts.push(account);
  await saveConfig(config);
}

async function readProfileForLogin(secret, deps) {
  if (secret.apiKey || !secret.accessToken) return null;
  try {
    return deps.fetchProfile ? await deps.fetchProfile(secret.accessToken) : await fetchProfile(secret.accessToken);
  } catch {
    return null;
  }
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
    const path = join(homedir(), 'Library', 'LaunchAgents', 'com.cirkit.claude-rotator.plist');
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
  await rm(join(homedir(), 'Library', 'LaunchAgents', 'com.cirkit.claude-rotator.plist'), { force: true });
  await rm(join(homedir(), '.config', 'systemd', 'user', 'claude-rotator.service'), { force: true });
}

async function startService() {
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.cirkit.claude-rotator.plist');
    await execFileAsync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
    return;
  }
  await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  await execFileAsync('systemctl', ['--user', 'enable', '--now', 'claude-rotator.service']);
}

async function stopService() {
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.cirkit.claude-rotator.plist');
    await execFileAsync('launchctl', ['bootout', `gui/${process.getuid()}`, plist]);
    return;
  }
  await execFileAsync('systemctl', ['--user', 'disable', '--now', 'claude-rotator.service']);
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
