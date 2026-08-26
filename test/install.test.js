import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  installLinuxNodeLauncher,
  installMacosLifecycle,
  installSettings,
  linuxNodeLauncherPath,
  removeLinuxNodeLauncher,
  uninstallSettings,
  renderLaunchAgentPlist,
  renderSystemdUserService,
  renderServiceStartFailureMessage,
  serviceGenerationForLaunchAgent,
  uninstallMacosLifecycle,
} from '../src/install.js';
import { LOCAL_GATEWAY_AUTH_TOKEN } from '../src/config.js';
import { fileSha256, readJsonFile, writeJsonFile } from '../src/json-file.js';

const execFileAsync = promisify(execFile);

describe('installSettings and uninstallSettings', () => {
  it('backs up settings, writes install state, and restores on uninstall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, { language: 'ja', env: { FOO: 'bar' } });
    await chmod(settingsPath, 0o644);

    const install = await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
      now: () => new Date('2026-06-05T00:00:00Z'),
    });

    assert.match(install.backupPath, /settings-2026-06-05T00-00-00-000Z\.json$/);
    assert.deepEqual(await readJsonFile(settingsPath), {
      language: 'ja',
      env: {
        FOO: 'bar',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
        ANTHROPIC_AUTH_TOKEN: LOCAL_GATEWAY_AUTH_TOKEN,
      },
    });
    const savedInstallState = await readJsonFile(installStatePath);
    assert.equal(savedInstallState.proxyBaseUrl, 'http://127.0.0.1:37891');
    assert.equal(savedInstallState.gatewayAuthToken, LOCAL_GATEWAY_AUTH_TOKEN);

    const uninstall = await uninstallSettings({ settingsPath, installStatePath });

    assert.equal(uninstall.conflict, false);
    assert.deepEqual(await readJsonFile(settingsPath), { language: 'ja', env: { FOO: 'bar' } });
    assert.equal(await readFile(install.backupPath, 'utf8'), '{\n  "language": "ja",\n  "env": {\n    "FOO": "bar"\n  }\n}\n');
    assert.equal((await stat(install.backupPath)).mode & 0o777, 0o600);
  });

  it('refuses uninstall restore when base URL was changed after install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');

    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });
    await writeJsonFile(settingsPath, { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' } });

    const result = await uninstallSettings({ settingsPath, installStatePath });

    assert.equal(result.conflict, true);
    assert.equal((await readJsonFile(settingsPath)).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9999');
  });

  it('refuses to replace an existing gateway auth token without force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, {
      env: { ANTHROPIC_AUTH_TOKEN: 'user-managed-token' },
    });

    await assert.rejects(installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    }), /ANTHROPIC_AUTH_TOKEN already exists/);
  });

  it('preserves the original settings provenance across a forced reinstall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, { language: 'ja' });

    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });
    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
      force: true,
    });

    const savedInstallState = await readJsonFile(installStatePath);
    assert.deepEqual(savedInstallState.previousBaseUrl, { existed: false });
    assert.deepEqual(savedInstallState.previousAuthToken, { existed: false });

    const uninstall = await uninstallSettings({ settingsPath, installStatePath });
    assert.equal(uninstall.conflict, false);
    assert.deepEqual(await readJsonFile(settingsPath), { language: 'ja' });
  });

  it('preserves each original gateway setting across URL and token changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    const original = {
      env: {
        ANTHROPIC_BASE_URL: 'https://original-gateway.example',
        ANTHROPIC_AUTH_TOKEN: 'original-user-token',
      },
    };
    await writeJsonFile(settingsPath, original);

    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
      force: true,
    });
    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:47891',
      gatewayAuthToken: 'claude-rotator-local-gateway-v2',
      force: true,
    });

    const savedInstallState = await readJsonFile(installStatePath);
    assert.deepEqual(savedInstallState.previousBaseUrl, {
      existed: true,
      value: 'https://original-gateway.example',
    });
    assert.deepEqual(savedInstallState.previousAuthToken, {
      existed: true,
      value: 'original-user-token',
    });

    const uninstall = await uninstallSettings({ settingsPath, installStatePath });
    assert.equal(uninstall.conflict, false);
    assert.deepEqual(await readJsonFile(settingsPath), original);
  });

  it('migrates a legacy install state and removes the newly added auth placeholder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, {
      language: 'ja',
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891' },
    });
    await writeJsonFile(installStatePath, {
      settingsPath,
      proxyBaseUrl: 'http://127.0.0.1:37891',
      previousBaseUrl: {
        existed: true,
        value: 'https://original-gateway.example',
      },
    });

    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });

    const uninstall = await uninstallSettings({ settingsPath, installStatePath });
    assert.equal(uninstall.conflict, false);
    assert.deepEqual(await readJsonFile(settingsPath), {
      language: 'ja',
      env: { ANTHROPIC_BASE_URL: 'https://original-gateway.example' },
    });
  });

  it('allows uninstall cleanup to resume after settings were already restored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, { language: 'ja', env: { FOO: 'bar' } });

    await installSettings({
      settingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });
    await uninstallSettings({ settingsPath, installStatePath });
    const alreadyRestored = await uninstallSettings({ settingsPath, installStatePath });

    assert.equal(alreadyRestored.conflict, false);
    assert.equal(alreadyRestored.alreadyRestored, true);
    assert.deepEqual(await readJsonFile(settingsPath), {
      language: 'ja',
      env: { FOO: 'bar' },
    });
  });

  it('uses the settings path recorded by the install when CLAUDE_CONFIG_DIR changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const managedSettingsPath = join(dir, 'managed', 'settings.json');
    const otherSettingsPath = join(dir, 'other', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(managedSettingsPath, { language: 'ja' });
    await writeJsonFile(otherSettingsPath, { language: 'en' });

    await installSettings({
      settingsPath: managedSettingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });
    const result = await uninstallSettings({
      settingsPath: otherSettingsPath,
      installStatePath,
    });

    assert.equal(result.conflict, false);
    assert.deepEqual(await readJsonFile(managedSettingsPath), { language: 'ja' });
    assert.deepEqual(await readJsonFile(otherSettingsPath), { language: 'en' });
  });

  it('refuses to manage a second Claude settings path before uninstall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const firstSettingsPath = join(dir, 'first', 'settings.json');
    const secondSettingsPath = join(dir, 'second', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');

    await installSettings({
      settingsPath: firstSettingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
    });

    await assert.rejects(installSettings({
      settingsPath: secondSettingsPath,
      installStatePath,
      backupDir,
      proxyBaseUrl: 'http://127.0.0.1:37891',
      force: true,
    }), /already manages a different Claude settings file/);
  });
});

describe('service file rendering', () => {
  it('creates a Linux Node launcher with a stable process name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-launcher-'));
    const configPath = join(dir, 'config.json');
    const launcherPath = await installLinuxNodeLauncher({
      nodePath: '/usr/bin/node',
      configPath,
    });

    assert.equal(launcherPath, join(dir, 'runtime', 'claude-rotator'));
    assert.equal(launcherPath, linuxNodeLauncherPath(configPath));
    assert.equal((await lstat(launcherPath)).isSymbolicLink(), true);
    assert.equal(await readlink(launcherPath), '/usr/bin/node');

    await removeLinuxNodeLauncher(configPath);
    await assert.rejects(lstat(launcherPath), { code: 'ENOENT' });
  });

  it('renders a macOS LaunchAgent plist', () => {
    const serviceGeneration = serviceGenerationForLaunchAgent({
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/.config/claude-rotator/config.json',
      claudePath: '/opt/homebrew/bin/claude',
      servicePath: '/opt/homebrew/bin:/usr/bin:/bin',
    });
    const plist = renderLaunchAgentPlist({
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/.config/claude-rotator/config.json',
      claudeConfigDir: '/home/alice/.claude',
      claudePath: '/opt/homebrew/bin/claude',
      servicePath: '/opt/homebrew/bin:/usr/bin:/bin',
      serviceGeneration,
    });

    assert.match(plist, /io\.github\.claude-rotator/);
    assert.match(plist, /<string>server<\/string>/);
    assert.match(plist, /<key>CLAUDE_ROTATOR_CONFIG<\/key>/);
    assert.match(plist, /<key>CLAUDE_CONFIG_DIR<\/key>/);
    assert.match(plist, /<string>\/home\/alice\/\.claude<\/string>/);
    assert.match(plist, /<string>\/home\/alice\/.config\/claude-rotator\/config.json<\/string>/);
    assert.match(plist, /<key>NODE_OPTIONS<\/key>/);
    assert.match(plist, /<string>--dns-result-order=ipv4first<\/string>/);
    assert.match(plist, /<key>CLAUDE_ROTATOR_CLAUDE_BIN<\/key>/);
    assert.match(plist, /<string>\/opt\/homebrew\/bin\/claude<\/string>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.match(plist, /<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
    assert.match(plist, /<key>CLAUDE_ROTATOR_SERVICE_GENERATION<\/key>/);
    assert.match(plist, new RegExp(`<string>${serviceGeneration}<\\/string>`));
    assert.match(
      plist,
      /<key>ProcessType<\/key>\s*<string>Interactive<\/string>/,
    );
  });

  it('renders a LaunchAgent accepted by macOS plutil', {
    skip: process.platform !== 'darwin',
  }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-plist-'));
    const path = join(dir, 'io.github.claude-rotator.plist');
    await writeFile(path, renderLaunchAgentPlist({
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/Users/alice/.config/claude-rotator/config.json',
      claudeConfigDir: '/Users/alice/.claude',
      claudePath: '/opt/homebrew/bin/claude',
      servicePath: '/opt/homebrew/bin:/usr/bin:/bin',
    }), 'utf8');

    const { stdout } = await execFileAsync('plutil', ['-lint', path]);
    assert.match(stdout, /OK/);
    const { stdout: processType } = await execFileAsync('plutil', [
      '-extract', 'ProcessType', 'raw', '-o', '-', path,
    ]);
    assert.equal(processType.trim(), 'Interactive');
  });

  it('renders a Linux systemd user service', () => {
    const configPath = '/home/alice/.config/claude-rotator/config.json';
    const service = renderSystemdUserService({
      nodePath: linuxNodeLauncherPath(configPath),
      cliPath: '/repo/bin/claude-rotator.js',
      configPath,
      claudeConfigDir: '/home/alice/.claude',
      claudePath: '/home/alice/.nvm/versions/node/v20/bin/claude',
      servicePath: '/home/alice/.nvm/versions/node/v20/bin:/usr/local/bin:/usr/bin:/bin',
    });

    assert.match(service, /ExecStart=\/home\/alice\/\.config\/claude-rotator\/runtime\/claude-rotator \/repo\/bin\/claude-rotator\.js server/);
    assert.deepEqual(
      service.split('\n').filter((line) => line.startsWith('Environment=')),
      [
        'Environment="CLAUDE_ROTATOR_CONFIG=/home/alice/.config/claude-rotator/config.json"',
        'Environment="CLAUDE_CONFIG_DIR=/home/alice/.claude"',
        'Environment="NODE_OPTIONS=--dns-result-order=ipv4first"',
        'Environment="CLAUDE_ROTATOR_CLAUDE_BIN=/home/alice/.nvm/versions/node/v20/bin/claude"',
        'Environment="PATH=/home/alice/.nvm/versions/node/v20/bin:/usr/local/bin:/usr/bin:/bin"',
      ],
    );
    assert.match(service, /TimeoutStopSec=10/);
    assert.match(service, /StandardOutput=append:\/home\/alice\/.config\/claude-rotator\/server\.log/);
    assert.match(service, /StandardError=append:\/home\/alice\/.config\/claude-rotator\/server\.err/);
    assert.doesNotMatch(service, /XDG_CONFIG_HOME/);
    assert.doesNotMatch(service, /XDG_DATA_HOME/);
  });

  it('embeds custom XDG paths into the LaunchAgent plist and systemd unit when set', () => {
    const plist = renderLaunchAgentPlist({
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/xdg-config/claude-rotator/config.json',
      claudePath: '/opt/homebrew/bin/claude',
      servicePath: '/opt/homebrew/bin:/usr/bin:/bin',
      xdgConfigHome: '/home/alice/xdg-config',
      xdgDataHome: '/home/alice/xdg-data',
    });

    assert.match(plist, /<key>XDG_CONFIG_HOME<\/key>\s*<string>\/home\/alice\/xdg-config<\/string>/);
    assert.match(plist, /<key>XDG_DATA_HOME<\/key>\s*<string>\/home\/alice\/xdg-data<\/string>/);

    const service = renderSystemdUserService({
      nodePath: '/home/alice/xdg-config/claude-rotator/runtime/claude-rotator',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/xdg-config/claude-rotator/config.json',
      claudePath: '/home/alice/.nvm/versions/node/v20/bin/claude',
      servicePath: '/home/alice/.nvm/versions/node/v20/bin:/usr/local/bin:/usr/bin:/bin',
      xdgConfigHome: '/home/alice/xdg-config',
      xdgDataHome: '/home/alice/xdg-data',
    });

    assert.match(service, /Environment=XDG_CONFIG_HOME=\/home\/alice\/xdg-config/);
    assert.match(service, /Environment=XDG_DATA_HOME=\/home\/alice\/xdg-data/);
  });

  it('changes the LaunchAgent service generation when XDG paths change', () => {
    const base = {
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/.config/claude-rotator/config.json',
      claudePath: '/opt/homebrew/bin/claude',
      servicePath: '/opt/homebrew/bin:/usr/bin:/bin',
    };

    const withoutXdg = serviceGenerationForLaunchAgent(base);
    const withXdg = serviceGenerationForLaunchAgent({
      ...base,
      xdgConfigHome: '/home/alice/xdg-config',
      xdgDataHome: '/home/alice/xdg-data',
    });
    const withDifferentXdg = serviceGenerationForLaunchAgent({
      ...base,
      xdgConfigHome: '/home/alice/other-config',
      xdgDataHome: '/home/alice/xdg-data',
    });

    assert.notEqual(withoutXdg, withXdg);
    assert.notEqual(withXdg, withDifferentXdg);
  });

  it('quotes and escapes special characters in every systemd Environment assignment', () => {
    const service = renderSystemdUserService({
      nodePath: '/usr/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: String.raw`/home/alice/Config Root/"main"\100%/config.json`,
      claudeConfigDir: String.raw`/home/alice/Claude Data/"primary"\200%`,
      claudePath: String.raw`/home/alice/Bin Set/"claude"\300%`,
      servicePath: String.raw`/home/alice/Bin Set/"tools"\400%:/usr/bin`,
    });

    assert.deepEqual(
      service.split('\n').filter((line) => line.startsWith('Environment=')),
      [
        String.raw`Environment="CLAUDE_ROTATOR_CONFIG=/home/alice/Config Root/\"main\"\\100%%/config.json"`,
        String.raw`Environment="CLAUDE_CONFIG_DIR=/home/alice/Claude Data/\"primary\"\\200%%"`,
        'Environment="NODE_OPTIONS=--dns-result-order=ipv4first"',
        String.raw`Environment="CLAUDE_ROTATOR_CLAUDE_BIN=/home/alice/Bin Set/\"claude\"\\300%%"`,
        String.raw`Environment="PATH=/home/alice/Bin Set/\"tools\"\\400%%:/usr/bin"`,
      ],
    );
  });

  it('renders Ubuntu recovery commands when systemd user service start fails', () => {
    const message = renderServiceStartFailureMessage({
      platform: 'linux',
      error: new Error('Failed to connect to bus'),
    });

    assert.match(message, /Service start failed: Failed to connect to bus/);
    assert.match(message, /systemctl --user daemon-reload/);
    assert.match(message, /systemctl --user enable --now claude-rotator\.service/);
    assert.match(message, /journalctl --user -u claude-rotator\.service -f/);
    assert.match(message, /loginctl enable-linger \$USER/);
    assert.doesNotMatch(message, /launchctl/);
  });

  it('renders macOS recovery commands when LaunchAgent start fails', () => {
    const message = renderServiceStartFailureMessage({
      platform: 'darwin',
      uid: 501,
      error: new Error('service already bootstrapped'),
    });

    assert.match(message, /Service start failed: service already bootstrapped/);
    assert.match(message, /claude-rotator install --force/);
    assert.doesNotMatch(message, /launchctl bootout/);
    assert.doesNotMatch(message, /launchctl load/);
    assert.doesNotMatch(message, /systemctl/);
  });
});

describe('macOS WatchDock lifecycle', () => {
  it('installs the main service before committing settings, marker, and watchdog', async () => {
    const fixture = await createMacosLifecycleFixture();
    try {
      await installMacosLifecycle(fixture.installOptions());

      assert.equal(fixture.jobs.has(fixture.mainJob), true);
      assert.equal(fixture.jobs.has(fixture.watchdogJob), true);
      assert.equal((await readJsonFile(fixture.paths.settingsPath)).env.ANTHROPIC_BASE_URL, fixture.proxyBaseUrl);
      assert.deepEqual(await readJsonFile(fixture.paths.markerPath), {
        version: 1,
        installStateSha256: await fileSha256(fixture.paths.installStatePath),
      });
      assert.equal(await readFile(fixture.paths.helperPath, 'utf8'), fixture.artifacts.helper);
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps settings and both jobs inactive for a fresh --no-start install', async () => {
    const fixture = await createMacosLifecycleFixture();
    try {
      await installMacosLifecycle(fixture.installOptions({ noStart: true }));

      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
      assert.equal(await exists(fixture.paths.installStatePath), false);
      assert.equal(await exists(fixture.paths.markerPath), false);
      assert.deepEqual([...fixture.jobs], []);
      assert.equal(await readFile(fixture.paths.helperPath, 'utf8'), fixture.artifacts.helper);
    } finally {
      await fixture.cleanup();
    }
  });

  it('reinstalls without replacing the original settings recovery state', async () => {
    const fixture = await createInstalledMacosLifecycleFixture();
    try {
      const firstState = await readJsonFile(fixture.paths.installStatePath);
      await installMacosLifecycle(fixture.installOptions({
        proxyBaseUrl: 'http://127.0.0.1:40000',
      }));
      const secondState = await readJsonFile(fixture.paths.installStatePath);

      assert.equal(secondState.backupPath, firstState.backupPath);
      assert.equal(
        (await readJsonFile(fixture.paths.settingsPath)).env.ANTHROPIC_BASE_URL,
        'http://127.0.0.1:40000',
      );
      await uninstallMacosLifecycle(fixture.uninstallOptions());
      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('restores the fresh-install state when watchdog registration fails', async () => {
    const fixture = await createMacosLifecycleFixture({ failWatchdogBootstrap: true });
    try {
      await assert.rejects(
        installMacosLifecycle(fixture.installOptions()),
        /launchctl bootstrap failed \(exit status 5\)/,
      );

      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
      for (const key of ['installStatePath', 'markerPath', 'mainPlistPath', 'watchdogPlistPath', 'helperPath']) {
        assert.equal(await exists(fixture.paths[key]), false, key);
      }
      assert.deepEqual([...fixture.jobs], []);
    } finally {
      await fixture.cleanup();
    }
  });

  it('bounds a non-responsive health check and rolls the install back', async () => {
    const fixture = await createMacosLifecycleFixture();
    let healthSignal;
    let guardTimer;
    try {
      const outcome = await Promise.race([
        installMacosLifecycle(fixture.installOptions({
          healthTimeoutMs: 20,
          healthCheck: ({ signal } = {}) => {
            healthSignal = signal;
            return new Promise(() => {});
          },
        })).then(
          () => ({ type: 'resolved' }),
          error => ({ type: 'rejected', error }),
        ),
        new Promise(resolve => {
          guardTimer = setTimeout(() => resolve({ type: 'still-pending' }), 250);
        }),
      ]);
      clearTimeout(guardTimer);

      assert.equal(outcome.type, 'rejected');
      assert.match(outcome.error.message, /did not become healthy/);
      assert.equal(healthSignal.aborted, true);
      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
      assert.equal(await exists(fixture.paths.installStatePath), false);
      assert.equal(await exists(fixture.paths.markerPath), false);
      assert.deepEqual([...fixture.jobs], []);
    } finally {
      clearTimeout(guardTimer);
      await fixture.cleanup();
    }
  });

  it('continues rollback after one managed-file restore fails', async () => {
    const fixture = await createMacosLifecycleFixture({ failWatchdogBootstrap: true });
    try {
      fixture.onWatchdogBootstrapFailure = async () => {
        await rm(fixture.paths.watchdogPlistPath, { force: true });
        await mkdir(fixture.paths.watchdogPlistPath);
      };

      await assert.rejects(
        installMacosLifecycle(fixture.installOptions()),
        /rollback failed/,
      );

      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
      assert.equal(await exists(fixture.paths.installStatePath), false);
      assert.equal(await exists(fixture.paths.markerPath), false);
      assert.equal(await exists(fixture.paths.helperPath), false);
      assert.equal(fixture.jobs.has(fixture.mainJob), false);
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not mutate service state when uninstall finds a settings conflict', async () => {
    const fixture = await createInstalledMacosLifecycleFixture();
    try {
      await writeJsonFile(fixture.paths.settingsPath, {
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999' },
      });
      fixture.launchctlCalls.length = 0;

      await assert.rejects(uninstallMacosLifecycle(fixture.uninstallOptions()), /ANTHROPIC_BASE_URL/);

      assert.deepEqual(fixture.launchctlCalls, []);
      assert.equal(await exists(fixture.paths.markerPath), true);
      assert.equal(await exists(fixture.paths.mainPlistPath), true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes the marker before stopping watchdog then main', async () => {
    const fixture = await createInstalledMacosLifecycleFixture();
    try {
      fixture.onBootout = async job => {
        if (job === fixture.watchdogJob) assert.equal(await exists(fixture.paths.markerPath), false);
      };

      await uninstallMacosLifecycle(fixture.uninstallOptions());

      const bootouts = fixture.launchctlCalls
        .filter(args => args[0] === 'bootout')
        .map(args => args[1]);
      assert.deepEqual(bootouts, [fixture.watchdogJob, fixture.mainJob]);
      assert.deepEqual([...fixture.jobs], []);
      for (const key of ['installStatePath', 'markerPath', 'mainPlistPath', 'watchdogPlistPath', 'helperPath']) {
        assert.equal(await exists(fixture.paths[key]), false, key);
      }
      assert.deepEqual(await readJsonFile(fixture.paths.settingsPath), { language: 'ja' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('preserves installed artifacts when stopping the watchdog fails', async () => {
    const fixture = await createInstalledMacosLifecycleFixture();
    try {
      fixture.failWatchdogBootout = true;

      await assert.rejects(uninstallMacosLifecycle(fixture.uninstallOptions()), /bootout failed/);

      assert.equal(await exists(fixture.paths.markerPath), true);
      assert.equal(await exists(fixture.paths.mainPlistPath), true);
      assert.equal(await exists(fixture.paths.watchdogPlistPath), true);
      assert.equal(fixture.jobs.has(fixture.mainJob), true);
      assert.equal(fixture.jobs.has(fixture.watchdogJob), true);
      assert.equal(
        (await readJsonFile(fixture.paths.settingsPath)).env.ANTHROPIC_BASE_URL,
        fixture.proxyBaseUrl,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

async function createInstalledMacosLifecycleFixture() {
  const fixture = await createMacosLifecycleFixture();
  await installMacosLifecycle(fixture.installOptions());
  return fixture;
}

async function createMacosLifecycleFixture({ failWatchdogBootstrap = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-macos-lifecycle-'));
  const paths = {
    settingsPath: join(dir, '.claude', 'settings.json'),
    installStatePath: join(dir, 'config', 'install-state.json'),
    markerPath: join(dir, 'config', 'watchdog.json'),
    mainPlistPath: join(dir, 'LaunchAgents', 'io.github.claude-rotator.plist'),
    watchdogPlistPath: join(dir, 'LaunchAgents', 'io.github.claude-rotator.watchdog.plist'),
    helperPath: join(dir, 'data', 'macos-watchdog.sh'),
  };
  const artifacts = {
    mainPlist: '<plist>main</plist>\n',
    watchdogPlist: '<plist>watchdog</plist>\n',
    helper: '#!/bin/sh\nexit 0\n',
  };
  const proxyBaseUrl = 'http://127.0.0.1:37891';
  const mainJob = 'gui/501/io.github.claude-rotator';
  const watchdogJob = 'gui/501/io.github.claude-rotator.watchdog';
  const jobs = new Set();
  const launchctlCalls = [];
  const fixture = {
    dir,
    paths,
    artifacts,
    proxyBaseUrl,
    mainJob,
    watchdogJob,
    jobs,
    launchctlCalls,
    onBootout: async () => {},
    failWatchdogBootout: false,
    onWatchdogBootstrapFailure: async () => {},
  };
  await writeJsonFile(paths.settingsPath, { language: 'ja' });

  const execFileImpl = async (command, args) => {
    assert.equal(command, '/bin/launchctl');
    launchctlCalls.push(args);
    const [action, ...rest] = args;
    if (action === 'print') {
      if (jobs.has(rest[0])) return;
      throw Object.assign(new Error('not found'), { code: 113 });
    }
    if (action === 'bootstrap') {
      const job = rest[1].includes('watchdog') ? watchdogJob : mainJob;
      if (failWatchdogBootstrap && job === watchdogJob) {
        await fixture.onWatchdogBootstrapFailure();
        throw Object.assign(new Error('watchdog bootstrap failed'), { code: 5 });
      }
      jobs.add(job);
      return;
    }
    if (action === 'bootout') {
      if (fixture.failWatchdogBootout && rest[0] === watchdogJob) {
        throw Object.assign(new Error('watchdog bootout failed'), { code: 5 });
      }
      await fixture.onBootout(rest[0]);
      jobs.delete(rest[0]);
      return;
    }
    if (action === 'kickstart') return;
    assert.fail(`unexpected launchctl action: ${action}`);
  };

  fixture.installOptions = overrides => ({
    uid: 501,
    env: { CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1' },
    paths,
    artifacts,
    backupDir: join(dir, 'config', 'backups'),
    proxyBaseUrl,
    expectedServiceGeneration: 'generation-1',
    healthCheck: async () => ({ ok: true, serviceGeneration: 'generation-1' }),
    execFileImpl,
    ...overrides,
  });
  fixture.uninstallOptions = overrides => ({
    uid: 501,
    env: { CLAUDE_ROTATOR_MACOS_SERVICE_LOCKED: '1' },
    paths,
    execFileImpl,
    ...overrides,
  });
  fixture.cleanup = () => rm(dir, { recursive: true, force: true });
  return fixture;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
