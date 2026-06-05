import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installSettings,
  uninstallSettings,
  renderLaunchAgentPlist,
  renderSystemdUserService,
} from '../src/install.js';
import { readJsonFile, writeJsonFile } from '../src/json-file.js';

describe('installSettings and uninstallSettings', () => {
  it('backs up settings, writes install state, and restores on uninstall', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-install-'));
    const settingsPath = join(dir, '.claude', 'settings.json');
    const installStatePath = join(dir, 'install-state.json');
    const backupDir = join(dir, 'backups');
    await writeJsonFile(settingsPath, { language: 'ja', env: { FOO: 'bar' } });

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
      },
    });
    assert.equal((await readJsonFile(installStatePath)).proxyBaseUrl, 'http://127.0.0.1:37891');

    const uninstall = await uninstallSettings({ settingsPath, installStatePath });

    assert.equal(uninstall.conflict, false);
    assert.deepEqual(await readJsonFile(settingsPath), { language: 'ja', env: { FOO: 'bar' } });
    assert.equal(await readFile(install.backupPath, 'utf8'), '{\n  "language": "ja",\n  "env": {\n    "FOO": "bar"\n  }\n}\n');
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
});

describe('service file rendering', () => {
  it('renders a macOS LaunchAgent plist', () => {
    const plist = renderLaunchAgentPlist({
      nodePath: '/opt/homebrew/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/.config/claude-rotator/config.json',
    });

    assert.match(plist, /com\.cirkit\.claude-rotator/);
    assert.match(plist, /<string>server<\/string>/);
    assert.match(plist, /<key>CLAUDE_ROTATOR_CONFIG<\/key>/);
    assert.match(plist, /<string>\/home\/alice\/.config\/claude-rotator\/config.json<\/string>/);
  });

  it('renders a Linux systemd user service', () => {
    const service = renderSystemdUserService({
      nodePath: '/usr/bin/node',
      cliPath: '/repo/bin/claude-rotator.js',
      configPath: '/home/alice/.config/claude-rotator/config.json',
    });

    assert.match(service, /ExecStart=\/usr\/bin\/node \/repo\/bin\/claude-rotator\.js server/);
    assert.match(service, /Environment=CLAUDE_ROTATOR_CONFIG=\/home\/alice\/.config\/claude-rotator\/config.json/);
  });
});
