import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { mergeClaudeSettings, restoreClaudeSettings } from './config.js';
import { fileSha256, readJsonFile, writeJsonFile } from './json-file.js';

export const MACOS_LAUNCH_AGENT_LABEL = 'io.github.claude-rotator';
export const SERVICE_NODE_OPTIONS = '--dns-result-order=ipv4first';

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

export function renderLaunchAgentPlist({ nodePath, cliPath, configPath }) {
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
  </dict>
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

export function renderSystemdUserService({ nodePath, cliPath, configPath }) {
  const configDir = dirname(configPath);
  return `[Unit]
Description=Claude Rotator proxy
After=network-online.target

[Service]
Type=simple
Environment=CLAUDE_ROTATOR_CONFIG=${systemdEscape(configPath)}
Environment=NODE_OPTIONS=${systemdEscape(SERVICE_NODE_OPTIONS)}
ExecStart=${systemdEscape(nodePath)} ${systemdEscape(cliPath)} server
Restart=always
RestartSec=3
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
      `  launchctl bootout ${domain}/${MACOS_LAUNCH_AGENT_LABEL} 2>/dev/null || true`,
      `  launchctl bootstrap ${domain} ~/Library/LaunchAgents/${MACOS_LAUNCH_AGENT_LABEL}.plist`,
      `  launchctl load -w ~/Library/LaunchAgents/${MACOS_LAUNCH_AGENT_LABEL}.plist`,
      `  launchctl kickstart -k ${domain}/${MACOS_LAUNCH_AGENT_LABEL}`,
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
