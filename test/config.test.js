import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultConfig,
  mergeClaudeSettings,
  restoreClaudeSettings,
} from '../src/config.js';
import { writeJsonFile, readJsonFile, fileSha256 } from '../src/json-file.js';
import { defaultConfigPath, expandHome, xdgConfigHome } from '../src/paths.js';

describe('path helpers', () => {
  it('resolves XDG config path and expands home', () => {
    const env = { XDG_CONFIG_HOME: '/tmp/xdg' };

    assert.equal(xdgConfigHome(env, '/home/alice'), '/tmp/xdg');
    assert.equal(defaultConfigPath(env, '/home/alice'), '/tmp/xdg/claude-rotator/config.json');
    assert.equal(expandHome('~/settings.json', '/home/alice'), '/home/alice/settings.json');
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
    assert.equal(Object.hasOwn(config.usagePolling, 'intervalMs'), false);
  });
});

describe('Claude settings merge and restore', () => {
  it('adds ANTHROPIC_BASE_URL while preserving existing env values', () => {
    const original = {
      language: 'ja',
      env: {
        FOO: 'bar',
      },
    };

    const result = mergeClaudeSettings(original, 'http://127.0.0.1:37891');

    assert.deepEqual(result.previousBaseUrl, { existed: false, value: undefined });
    assert.deepEqual(result.settings, {
      language: 'ja',
      env: {
        FOO: 'bar',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
      },
    });
  });

  it('restores a previously missing ANTHROPIC_BASE_URL by removing it', () => {
    const installed = {
      env: {
        FOO: 'bar',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:37891',
      },
    };
    const installState = {
      proxyBaseUrl: 'http://127.0.0.1:37891',
      previousBaseUrl: { existed: false },
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
});
