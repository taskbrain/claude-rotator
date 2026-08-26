import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeJsonFile } from '../src/json-file.js';

it('flushes large prepare-resume JSON when stdout is a pipe', async () => {
  const port = await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-cli-'));
  const configPath = join(dir, 'config.json');
  await writeJsonFile(configPath, {
    proxy: { host: '127.0.0.1', port },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 1,
    usagePolling: { enabled: false },
    accounts: [],
  });

  // Node.js stdout pipes buffer around 64KiB (65536 bytes) before backpressure
  // kicks in. Use a payload well beyond that so a truncation bug is detectable.
  const largeStatus = {
    currentAccount: 'alice-example-com',
    accounts: Array.from({ length: 4000 }, (_, index) => ({
      id: `account-${index}`,
      name: `account-${index}@example.com`,
      status: 'ready',
      quota: { unified5h: 0, unified7d: 0.33, unifiedStatus: 'allowed' },
      usage: { totalRequests: index },
    })),
    events: Array.from({ length: 4000 }, (_, index) => ({
      at: '2026-07-06T21:54:32.767Z',
      type: 'quota-exhausted',
      account: `account-${index}`,
      reason: { type: 'quota_exhausted', window: '7d Fable', utilization: 1 },
    })),
  };
  const response = {
    ok: true,
    action: 'ready',
    reason: 'available',
    account: 'alice-example-com',
    accountName: 'alice@example.com',
    switched: false,
    resumeAtEpoch: 1783375173,
    status: largeStatus,
  };
  assert.ok(JSON.stringify(response).length > 65536, 'payload must exceed the ~64KiB pipe buffer to detect truncation');

  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/internal/prepare-resume') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await listen(server, port);

  try {
    const result = await runProcess(process.execPath, [resolve('bin/claude-rotator.js'), 'prepare-resume', '--json'], {
      cwd: resolve('.'),
      env: { ...process.env, CLAUDE_ROTATOR_CONFIG: configPath },
    });

    assert.equal(result.code, 0, result.stderr);
    const expected = `${JSON.stringify(response)}\n`;
    assert.equal(result.stdout.length, expected.length);
    assert.equal(JSON.parse(result.stdout).account, 'alice-example-com');
    assert.deepEqual(JSON.parse(result.stdout).status.events.length, 4000);
  } finally {
    await close(server);
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

function listen(server, port) {
  return new Promise(resolveDone => server.listen(port, '127.0.0.1', resolveDone));
}

function close(server) {
  return new Promise(resolveDone => server.close(resolveDone));
}

function runProcess(command, args, options) {
  return new Promise((resolveDone, reject) => {
    // Pipe stdout, matching how external tools (e.g. shell wrappers) consume
    // this CLI's --json output.
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('exit', code => {
      resolveDone({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
