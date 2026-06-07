import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeJsonFile } from '../src/json-file.js';

it('keeps the server process alive after listening', async () => {
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

  const child = spawn(process.execPath, [resolve('bin/claude-rotator.js'), 'server'], {
    cwd: resolve('.'),
    env: { ...process.env, CLAUDE_ROTATOR_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForOutput(child, /listening on/);
    assert.equal(child.exitCode, null);
    const health = await getJson(`http://127.0.0.1:${port}/internal/health`);
    assert.equal(health.ok, true);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolveDone => child.once('exit', resolveDone));
  }
});

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
