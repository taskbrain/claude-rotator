import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { mergeClaudeSettings, restoreClaudeSettings } from './config.js';
import { fileSha256, readJsonFile, writeJsonFile } from './json-file.js';
import {
  assertMacosServiceLockHeld,
  isMacosServiceRegistered,
  MACOS_MAIN_SERVICE_LABEL,
  MACOS_WATCHDOG_SERVICE_LABEL,
  reconcileMacosMainService,
  removeMacosManagedFile,
  replaceMacosManagedFile,
  restoreMacosManagedFile,
  restoreMacosServiceRegistration,
  snapshotMacosManagedFile,
  startMacosWatchdogService,
  stopMacosMainService,
  stopMacosWatchdogService,
} from './macos-service.js';

export const MACOS_LAUNCH_AGENT_LABEL = 'io.github.claude-rotator';
export const SERVICE_NODE_OPTIONS = '--dns-result-order=ipv4first';
export const LINUX_NODE_LAUNCHER_NAME = 'claude-rotator';
export const SERVICE_GENERATION_ENV = 'CLAUDE_ROTATOR_SERVICE_GENERATION';

export async function installSettings({
  settingsPath,
  installStatePath,
  backupDir,
  proxyBaseUrl,
  now = () => new Date(),
  force = false,
}) {
  const settings = await readJsonFile(settingsPath, {});
  const existingBaseUrl = settings.env?.ANTHROPIC_BASE_URL;
  if (existingBaseUrl && existingBaseUrl !== proxyBaseUrl && !force) {
    throw new Error(`ANTHROPIC_BASE_URL already exists: ${existingBaseUrl}`);
  }

  await mkdir(backupDir, { recursive: true });
  const backupPath = join(backupDir, `settings-${timestampForFile(now())}.json`);
  await writeJsonFile(settingsPath, settings);
  await copyFile(settingsPath, backupPath);

  const settingsHashBefore = await fileSha256(settingsPath);
  const merged = mergeClaudeSettings(settings, proxyBaseUrl);
  await writeJsonFile(settingsPath, merged.settings);

  const installState = {
    installedAt: now().toISOString(),
    settingsPath,
    backupPath,
    settingsHashBefore,
    proxyBaseUrl,
    previousBaseUrl: merged.previousBaseUrl,
  };
  await writeJsonFile(installStatePath, installState);
  return installState;
}

export async function uninstallSettings({ settingsPath, installStatePath, force = false }) {
  const installState = await readJsonFile(installStatePath);
  const settings = await readJsonFile(settingsPath, {});
  const restored = restoreClaudeSettings(settings, installState, { force });
  if (!restored.conflict) {
    await writeJsonFile(settingsPath, restored.settings);
  }
  return restored;
}

export async function removeInstallState(installStatePath) {
  await rm(installStatePath, { force: true });
}

export async function installMacosLifecycle({
  uid,
  env = process.env,
  paths,
  artifacts,
  backupDir,
  proxyBaseUrl,
  expectedServiceGeneration,
  healthCheck,
  force = false,
  noStart = false,
  execFileImpl,
  healthTimeoutMs = 15_000,
  healthPollIntervalMs = 100,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
}) {
  assertMacosServiceLockHeld(env);
  const snapshots = await snapshotMacosLifecycleFiles(paths);
  const previousInstallState = snapshots.installStatePath.exists
    ? JSON.parse(snapshots.installStatePath.bytes.toString('utf8'))
    : null;
  const registrations = await snapshotMacosRegistrations({ uid, env, execFileImpl });
  let createdBackupPath = null;

  try {
    await rm(paths.markerPath, { force: true });
    await stopMacosWatchdogService({ uid, env, execFileImpl });
    await replaceMacosManagedFile({
      path: paths.mainPlistPath,
      contents: artifacts.mainPlist,
      mode: 0o600,
      env,
    });
    await replaceMacosManagedFile({
      path: paths.watchdogPlistPath,
      contents: artifacts.watchdogPlist,
      mode: 0o600,
      env,
    });
    await replaceMacosManagedFile({
      path: paths.helperPath,
      contents: artifacts.helper,
      mode: 0o700,
      env,
    });

    if (noStart) {
      await stopMacosMainService({ uid, env, execFileImpl });
      if (previousInstallState) {
        const result = await uninstallSettings({
          settingsPath: paths.settingsPath,
          installStatePath: paths.installStatePath,
          force,
        });
        if (result.conflict) throw new Error(result.reason);
        await removeInstallState(paths.installStatePath);
      }
      return;
    }

    const definitionChanged = !snapshots.mainPlistPath.exists
      || !snapshots.mainPlistPath.bytes.equals(Buffer.from(artifacts.mainPlist));
    await reconcileMacosMainService({
      uid,
      plistPath: paths.mainPlistPath,
      definitionChanged,
      env,
      execFileImpl,
    });
    await waitForMacosHealth({
      healthCheck,
      expectedServiceGeneration,
      timeoutMs: healthTimeoutMs,
      intervalMs: healthPollIntervalMs,
      sleep,
    });
    const installState = previousInstallState
      ? await updateMacosInstalledSettings({
        settingsPath: paths.settingsPath,
        installStatePath: paths.installStatePath,
        previousInstallState,
        proxyBaseUrl,
        force,
      })
      : await installSettings({
        settingsPath: paths.settingsPath,
        installStatePath: paths.installStatePath,
        backupDir,
        proxyBaseUrl,
        force,
      });
    if (!previousInstallState) createdBackupPath = installState.backupPath;
    await writeJsonFile(paths.markerPath, {
      version: 1,
      installStateSha256: await fileSha256(paths.installStatePath),
    });
    await startMacosWatchdogService({
      uid,
      plistPath: paths.watchdogPlistPath,
      env,
      execFileImpl,
    });
  } catch (error) {
    const rollbackErrors = await rollbackMacosLifecycle({
      uid,
      env,
      paths,
      snapshots,
      registrations,
      execFileImpl,
    });
    if (createdBackupPath) {
      await attemptRollback(rollbackErrors, () => rm(createdBackupPath, { force: true }));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `${error?.message || 'macOS install failed'}; rollback failed`,
      );
    }
    throw error;
  }
}

async function updateMacosInstalledSettings({
  settingsPath,
  installStatePath,
  previousInstallState,
  proxyBaseUrl,
  force,
}) {
  if (
    previousInstallState.settingsPath !== settingsPath
    || typeof previousInstallState.backupPath !== 'string'
    || typeof previousInstallState.proxyBaseUrl !== 'string'
  ) {
    throw new Error('Existing macOS install state is invalid');
  }
  const settings = await readJsonFile(settingsPath, {});
  const currentBaseUrl = settings.env?.ANTHROPIC_BASE_URL;
  if (
    currentBaseUrl
    && currentBaseUrl !== previousInstallState.proxyBaseUrl
    && currentBaseUrl !== proxyBaseUrl
    && !force
  ) {
    throw new Error(`ANTHROPIC_BASE_URL changed after install: ${currentBaseUrl}`);
  }
  const merged = mergeClaudeSettings(settings, proxyBaseUrl);
  await writeJsonFile(settingsPath, merged.settings);
  const nextState = {
    ...previousInstallState,
    installedAt: new Date().toISOString(),
    proxyBaseUrl,
  };
  await writeJsonFile(installStatePath, nextState);
  return nextState;
}

export async function uninstallMacosLifecycle({
  uid,
  env = process.env,
  paths,
  force = false,
  purgeSecrets = false,
  execFileImpl,
  purgeSecretsImpl = async () => {},
}) {
  assertMacosServiceLockHeld(env);
  const snapshots = await snapshotMacosLifecycleFiles(paths);
  if (snapshots.installStatePath.exists) {
    const result = await uninstallSettings({
      settingsPath: paths.settingsPath,
      installStatePath: paths.installStatePath,
      force,
    });
    if (result.conflict) throw new Error(result.reason);
  }

  let registrations;
  try {
    registrations = await snapshotMacosRegistrations({ uid, env, execFileImpl });
    await rm(paths.markerPath, { force: true });
    await stopMacosWatchdogService({ uid, env, execFileImpl });
    await stopMacosMainService({ uid, env, execFileImpl });
    for (const key of ['mainPlistPath', 'watchdogPlistPath', 'helperPath']) {
      await removeMacosManagedFile({ path: paths[key], env });
    }
    await removeInstallState(paths.installStatePath);
    if (purgeSecrets) await purgeSecretsImpl();
  } catch (error) {
    const rollbackErrors = await restoreMacosLifecycleFiles({ paths, snapshots, env });
    if (registrations) {
      rollbackErrors.push(...await restoreMacosRegistrations({
        uid,
        env,
        paths,
        registrations,
        execFileImpl,
      }));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `${error?.message || 'macOS uninstall failed'}; rollback failed`,
      );
    }
    throw error;
  }
}

async function snapshotMacosLifecycleFiles(paths) {
  const entries = await Promise.all(
    ['mainPlistPath', 'watchdogPlistPath', 'helperPath', 'markerPath', 'settingsPath', 'installStatePath']
      .map(async key => [key, await snapshotMacosManagedFile(paths[key])]),
  );
  return Object.fromEntries(entries);
}

async function snapshotMacosRegistrations({ uid, env, execFileImpl }) {
  return {
    main: await isMacosServiceRegistered({
      uid,
      label: MACOS_MAIN_SERVICE_LABEL,
      env,
      execFileImpl,
    }),
    watchdog: await isMacosServiceRegistered({
      uid,
      label: MACOS_WATCHDOG_SERVICE_LABEL,
      env,
      execFileImpl,
    }),
  };
}

async function rollbackMacosLifecycle({ uid, env, paths, snapshots, registrations, execFileImpl }) {
  const errors = [];
  await attemptRollback(errors, () => rm(paths.markerPath, { force: true }));
  await attemptRollback(errors, () => stopMacosWatchdogService({ uid, env, execFileImpl }));
  errors.push(...await restoreMacosLifecycleFiles({ paths, snapshots, env }));
  errors.push(...await restoreMacosRegistrations({
    uid,
    env,
    paths,
    registrations,
    execFileImpl,
  }));
  return errors;
}

async function restoreMacosLifecycleFiles({ paths, snapshots, env }) {
  const errors = [];
  for (const key of ['mainPlistPath', 'watchdogPlistPath', 'helperPath', 'settingsPath', 'installStatePath', 'markerPath']) {
    await attemptRollback(errors, () => restoreMacosManagedFile({
      path: paths[key],
      snapshot: snapshots[key],
      env,
    }));
  }
  return errors;
}

async function restoreMacosRegistrations({ uid, env, paths, registrations, execFileImpl }) {
  const errors = [];
  await attemptRollback(errors, () => restoreMacosServiceRegistration({
    uid,
    label: MACOS_MAIN_SERVICE_LABEL,
    plistPath: paths.mainPlistPath,
    registered: registrations.main,
    env,
    execFileImpl,
  }));
  await attemptRollback(errors, () => restoreMacosServiceRegistration({
    uid,
    label: MACOS_WATCHDOG_SERVICE_LABEL,
    plistPath: paths.watchdogPlistPath,
    registered: registrations.watchdog,
    env,
    execFileImpl,
  }));
  return errors;
}

async function attemptRollback(errors, operation) {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
}

async function waitForMacosHealth({
  healthCheck,
  expectedServiceGeneration,
  timeoutMs,
  intervalMs,
  sleep,
}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const health = await runMacosHealthAttempt({ healthCheck, deadline });
      if (health?.ok === true && health.serviceGeneration === expectedServiceGeneration) return;
    } catch {
      // The service may still be starting.
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error('macOS service did not become healthy');
}

async function runMacosHealthAttempt({ healthCheck, deadline }) {
  const remainingMs = Math.max(0, deadline - Date.now());
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('macOS health attempt timed out'));
    }, remainingMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => healthCheck({ signal: controller.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function linuxNodeLauncherPath(configPath) {
  return join(dirname(configPath), 'runtime', LINUX_NODE_LAUNCHER_NAME);
}

export async function installLinuxNodeLauncher({ nodePath, configPath }) {
  const launcherPath = linuxNodeLauncherPath(configPath);
  await mkdir(dirname(launcherPath), { recursive: true });
  await rm(launcherPath, { force: true });
  await symlink(nodePath, launcherPath);
  return launcherPath;
}

export async function removeLinuxNodeLauncher(configPath) {
  await rm(linuxNodeLauncherPath(configPath), { force: true });
}

export function renderLaunchAgentPlist({
  nodePath,
  cliPath,
  configPath,
  claudePath,
  servicePath,
  serviceGeneration = null,
  xdgConfigHome = null,
  xdgDataHome = null,
}) {
  const xdgEnvEntries = [
    xdgConfigHome ? `    <key>XDG_CONFIG_HOME</key>
    <string>${xmlEscape(xdgConfigHome)}</string>
` : '',
    xdgDataHome ? `    <key>XDG_DATA_HOME</key>
    <string>${xmlEscape(xdgDataHome)}</string>
` : '',
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_ROTATOR_CONFIG</key>
    <string>${xmlEscape(configPath)}</string>
    <key>NODE_OPTIONS</key>
    <string>${xmlEscape(SERVICE_NODE_OPTIONS)}</string>
    <key>CLAUDE_ROTATOR_CLAUDE_BIN</key>
    <string>${xmlEscape(claudePath)}</string>
    <key>PATH</key>
    <string>${xmlEscape(servicePath)}</string>
${xdgEnvEntries}${serviceGeneration ? `    <key>${SERVICE_GENERATION_ENV}</key>
    <string>${xmlEscape(serviceGeneration)}</string>
` : ''}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(dirname(configPath))}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(dirname(configPath))}/server.err</string>
</dict>
</plist>
`;
}

export function serviceGenerationForLaunchAgent({
  nodePath,
  cliPath,
  configPath,
  claudePath,
  servicePath,
  xdgConfigHome = null,
  xdgDataHome = null,
}) {
  return createHash('sha256').update(JSON.stringify({
    nodePath,
    cliPath,
    configPath,
    claudePath,
    servicePath,
    xdgConfigHome,
    xdgDataHome,
  })).digest('hex');
}

export function renderSystemdUserService({
  nodePath,
  cliPath,
  configPath,
  claudePath,
  servicePath,
  xdgConfigHome = null,
  xdgDataHome = null,
}) {
  const configDir = dirname(configPath);
  const xdgEnvLines = [
    xdgConfigHome ? `Environment=XDG_CONFIG_HOME=${systemdEscape(xdgConfigHome)}\n` : '',
    xdgDataHome ? `Environment=XDG_DATA_HOME=${systemdEscape(xdgDataHome)}\n` : '',
  ].join('');
  return `[Unit]
Description=Claude Rotator proxy
After=network-online.target

[Service]
Type=simple
Environment=CLAUDE_ROTATOR_CONFIG=${systemdEscape(configPath)}
Environment=NODE_OPTIONS=${systemdEscape(SERVICE_NODE_OPTIONS)}
Environment=CLAUDE_ROTATOR_CLAUDE_BIN=${systemdEscape(claudePath)}
Environment=PATH=${systemdEscape(servicePath)}
${xdgEnvLines}ExecStart=${systemdEscape(nodePath)} ${systemdEscape(cliPath)} server
Restart=always
RestartSec=3
TimeoutStopSec=10
StandardOutput=append:${systemdEscape(join(configDir, 'server.log'))}
StandardError=append:${systemdEscape(join(configDir, 'server.err'))}

[Install]
WantedBy=default.target
`;
}

export function renderServiceStartFailureMessage({
  platform = process.platform,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  error,
} = {}) {
  const reason = error?.message || String(error || 'unknown error');
  if (platform === 'darwin') {
    const domain = uid == null ? 'gui/$(id -u)' : `gui/${uid}`;
    return [
      `Service start failed: ${reason}`,
      'Try:',
      '  claude-rotator install --force',
      `  launchctl print ${domain}/${MACOS_LAUNCH_AGENT_LABEL}`,
    ].join('\n');
  }

  return [
    `Service start failed: ${reason}`,
    'Try:',
    '  systemctl --user daemon-reload',
    '  systemctl --user enable --now claude-rotator.service',
    '  systemctl --user status claude-rotator.service',
    '  journalctl --user -u claude-rotator.service -f',
    'If this Ubuntu session has no user systemd bus:',
    '  loginctl enable-linger $USER',
    '  log out and back in, then rerun the systemctl --user commands above',
  ].join('\n');
}

function timestampForFile(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function systemdEscape(value) {
  return String(value).replaceAll('%', '%%');
}
