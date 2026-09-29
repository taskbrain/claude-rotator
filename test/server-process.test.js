import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SERVICE_COMMAND_LOG_ENV } from '../fixtures/service-command-guard.js';
import { writeJsonFile } from '../src/json-file.js';

it('keeps the server process alive after listening', async () => {
  const { dir, env, port } = await prepareSandbox();
  const child = spawnServer(env);

  try {
    await waitForOutput(child, /listening on/);
    assert.equal(child.exitCode, null);
    const health = await getJson(`http://127.0.0.1:${port}/internal/health`);
    assert.equal(health.ok, true);
  } finally {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  }
});

// 子プロセスの HOME・XDG・Claude 設定をすべて一時ディレクトリへ向ける。CLAUDE_ROTATOR_CONFIG
// だけを差し替えると runtime-state.json・usage-events が実 ~/.config/claude-rotator を指す。
async function prepareSandbox() {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-server-'));
  const configPath = join(dir, 'config.json');
  await writeJsonFile(configPath, {
    proxy: { host: '127.0.0.1', port },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 1,
    usagePolling: { enabled: false },
    accounts: [],
  });
  const env = { ...process.env };
  // 親から継承した CLAUDE_ROTATOR_*（USAGE_EVENTS_DIR・CLAUDE_BIN・SERVICE_GENERATION・
  // MACOS_SERVICE_LOCKED 等）は実環境の値なので持ち込まない。guard のログ先だけは残す。
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE_ROTATOR_') && name !== SERVICE_COMMAND_LOG_ENV) delete env[name];
  }
  // ログイン上書きの判定を開発機の環境変数に依存させない。
  for (const name of LOGIN_OVERRIDE_ENV_VARS) delete env[name];
  Object.assign(env, {
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'xdg-config'),
    XDG_DATA_HOME: join(dir, 'xdg-data'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    CLAUDE_ROTATOR_CONFIG: configPath,
  });
  return { dir, configPath, env, port };
}

const LOGIN_OVERRIDE_ENV_VARS = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
]);

function spawnServer(env) {
  return spawn(process.execPath, [resolve('bin/claude-rotator.js'), 'server'], {
    cwd: resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolveDone => child.once('exit', resolveDone));
}

function freePort() {
  return new Promise(resolveDone => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolveDone(port));
    });
  });
}

function waitForOutput(child, pattern) {
  return new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for server output')), 3000);
    let buffer = '';
    const onData = chunk => {
      buffer += chunk.toString('utf8');
      if (pattern.test(buffer)) {
        clearTimeout(timer);
        resolveDone(buffer);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Process exited before server was ready: ${code}; output=${buffer}`));
    });
  });
}

function getJson(url) {
  const target = new URL(url);
  return new Promise((resolveDone, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolveDone(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      });
    });
    req.on('error', reject);
    req.end();
  });
}
