import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultConfig,
  LOCAL_GATEWAY_AUTH_TOKEN,
  mergeClaudeSettings,
  proxyBaseUrl,
  proxyListenHost,
  restoreClaudeSettings,
} from '../src/config.js';
import { writeJsonFile, readJsonFile, fileSha256 } from '../src/json-file.js';
import {
  claudeConfigDir,
  claudeSettingsPath,
  defaultConfigPath,
  expandHome,
  macosServiceLockPath,
  macosWatchdogHelperPath,
  macosWatchdogMarkerPath,
  macosWatchdogPlistPath,
  xdgConfigHome,
  xdgDataHome,
} from '../src/paths.js';

describe('path helpers', () => {
  it('resolves XDG config path and expands home', () => {
    const env = { XDG_CONFIG_HOME: '/tmp/xdg' };

    assert.equal(xdgConfigHome(env, '/home/alice'), '/tmp/xdg');
    assert.equal(defaultConfigPath(env, '/home/alice'), '/tmp/xdg/claude-rotator/config.json');
    assert.equal(expandHome('~/settings.json', '/home/alice'), '/home/alice/settings.json');
  });

  it('ignores relative XDG overrides and falls back to the default home-based path', () => {
    const env = { XDG_CONFIG_HOME: 'relative/config', XDG_DATA_HOME: 'relative/data' };

    assert.equal(xdgConfigHome(env, '/home/alice'), '/home/alice/.config');
    assert.equal(xdgDataHome(env, '/home/alice'), '/home/alice/.local/share');
  });

  it('keeps every WatchDock asset under the user-owned config, data, or LaunchAgents directory', () => {
    const env = {
      XDG_CONFIG_HOME: '/Users/alice/.config',
      XDG_DATA_HOME: '/Users/alice/.local/share',
    };

    assert.equal(
      macosServiceLockPath(env, '/Users/alice'),
      '/Users/alice/.config/claude-rotator/macos-service.lock',
    );
    assert.equal(
      macosWatchdogMarkerPath(env, '/Users/alice'),
      '/Users/alice/.config/claude-rotator/watchdog.json',
    );
    assert.equal(
      macosWatchdogHelperPath(env, '/Users/alice'),
      '/Users/alice/.local/share/claude-rotator/macos-watchdog.sh',
    );
    assert.equal(
      macosWatchdogPlistPath('/Users/alice'),
      '/Users/alice/Library/LaunchAgents/io.github.claude-rotator.watchdog.plist',
    );
  });

  it('honors CLAUDE_CONFIG_DIR for Claude settings paths', () => {
    const env = { CLAUDE_CONFIG_DIR: '~/custom-claude' };

    assert.equal(claudeConfigDir(env, '/home/alice'), '/home/alice/custom-claude');
    assert.equal(
      claudeSettingsPath('/home/alice', env),
      '/home/alice/custom-claude/settings.json',
    );
  });
});

describe('json file helpers', () => {
  it('writes JSON atomically with mode 0600', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-json-'));
    const file = join(dir, 'nested', 'config.json');

    await writeJsonFile(file, { ok: true });

    assert.deepEqual(await readJsonFile(file), { ok: true });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await fileSha256(file), /^[a-f0-9]{64}$/);
    assert.equal(await readFile(file, 'utf8'), '{\n  "ok": true\n}\n');
  });
});

describe('config defaults', () => {
  it('creates a conservative default config', () => {
    const config = createDefaultConfig();

    assert.equal(config.proxy.host, '127.0.0.1');
    assert.equal(config.proxy.upstreamConnectTimeoutMs, 10 * 1000);
    assert.equal(config.proxy.upstreamConnectRetries, 3);
    assert.equal(config.proxy.upstreamConnectRetryDelayMs, 250);
    assert.equal(config.switchThreshold, 1);
    assert.deepEqual(config.accounts, []);
    assert.deepEqual(config.rotationPolicy, {
      mode: 'use-expiring-weekly',
      weeklyResetPriorityWindowMs: 36 * 60 * 60 * 1000,
    });
    assert.equal(config.usagePolling.enabled, true);
    assert.equal(config.usagePolling.intervalMs, 15 * 60 * 1000);
    assert.equal(config.usagePolling.concurrency, 1);
    assert.equal(config.usagePolling.requestSpacingMs, 1500);
  });

  it('falls back to IPv4 loopback when proxy.host is missing', () => {
    const config = { proxy: { port: 37891 } };

    assert.equal(proxyListenHost(config), '127.0.0.1');
    assert.equal(proxyBaseUrl(config), 'http://127.0.0.1:37891');
  });

  it('formats IPv6 loopback and rejects non-loopback proxy hosts', () => {
    assert.equal(
      proxyBaseUrl({ proxy: { host: '::1', port: 37891 } }),
      'http://[::1]:37891',
    );
    assert.throws(
      () => proxyListenHost({ proxy: { host: '0.0.0.0' } }),
      /must be a loopback address/,
    );
    assert.throws(
      () => proxyListenHost({ proxy: { host: '192.168.1.10' } }),
      /must be a loopback address/,
    );
  });
});

describe('Claude settings merge and restore', () => {
  it('adds the local gateway URL and auth token while preserving existing env values', () => {
    const original = {
      language: 'ja',
      env: {
        FOO: 'bar',
      },
    };

    const result = mergeClaudeSettings(original, 'http://127.0.0.1:37891');

    assert.deepEqual(result.previousBaseUrl, { existed: false, value: undefined });
    assert.deepEqual(result.previousAuthToken, { existed: false, value: undefined });
    assert.deepEqual(result.settings, {
      language: 'ja',
      env: {
        FOO: 'bar',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
        ANTHROPIC_AUTH_TOKEN: LOCAL_GATEWAY_AUTH_TOKEN,
      },
    });
  });

  it('restores previously missing gateway settings by removing them', () => {
    const installed = {
      env: {
        FOO: 'bar',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
        ANTHROPIC_AUTH_TOKEN: LOCAL_GATEWAY_AUTH_TOKEN,
      },
    };
    const installState = {
      proxyBaseUrl: 'http://127.0.0.1:37891',
      gatewayAuthToken: LOCAL_GATEWAY_AUTH_TOKEN,
      previousBaseUrl: { existed: false },
      previousAuthToken: { existed: false },
    };

    const result = restoreClaudeSettings(installed, installState);

    assert.equal(result.conflict, false);
    assert.deepEqual(result.settings, { env: { FOO: 'bar' } });
  });

  it('refuses to restore when ANTHROPIC_BASE_URL was changed by someone else', () => {
    const changed = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      },
    };
    const installState = {
      proxyBaseUrl: 'http://127.0.0.1:37891',
      previousBaseUrl: { existed: true, value: 'https://example.test' },
    };

    const result = restoreClaudeSettings(changed, installState);

    assert.equal(result.conflict, true);
    assert.deepEqual(result.settings, changed);
  });

  it('refuses to restore when ANTHROPIC_AUTH_TOKEN was changed by someone else', () => {
    const changed = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
        ANTHROPIC_AUTH_TOKEN: 'user-managed-token',
      },
    };
    const installState = {
      proxyBaseUrl: 'http://127.0.0.1:37891',
      gatewayAuthToken: LOCAL_GATEWAY_AUTH_TOKEN,
      previousBaseUrl: { existed: false },
      previousAuthToken: { existed: false },
    };

    const result = restoreClaudeSettings(changed, installState);

    assert.equal(result.conflict, true);
    assert.match(result.reason, /ANTHROPIC_AUTH_TOKEN/);
    assert.deepEqual(result.settings, changed);
  });
});
