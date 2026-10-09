// usage-events.jsonl の結線（forwardOnce の1回ごとに1行）を実 TCP で確かめる。
//
// 隔離: 上流は 127.0.0.1 のテスト用サーバだけで、資格情報の読取・プロファイル取得・
// usage API・トークン更新はすべてスタブを注入する（実 Keychain・実 API へ到達しない）。
// 出力先は mkdtemp の一時ディレクトリで、実マシンの ~/.config へは書かない。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { appendFile, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';
import { createUsageEventWriter, USAGE_EVENTS_FILENAME } from '../src/usage-events.js';

const gzip = promisify(zlib.gzip);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()();
});

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  // Held-open upstream responses (client-abort test) must not keep close() waiting.
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

// fetch() は Content-Encoding を勝手に解くので、クライアントが受け取った生のバイト列を
// 比べるために http.request を使う。
function requestRaw(url, options = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function isolatedServerOptions() {
  return {
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => null,
    currentProfileFetcher: async () => null,
    usageFetcher: async () => { throw new Error('usage API must not be called in this test'); },
    tokenRefresher: async () => { throw new Error('token refresh must not be called in this test'); },
  };
}

async function startProxy({
  upstreamHandler,
  dir,
  accounts,
  secrets,
  prepare,
  logger = null,
  upstreamUrl = null,
  // An injected writer (stalled disk / failing chmod). Without it the proxy builds its own from `dir`.
  writer = null,
  serverOptions = {},
}) {
  const upstream = upstreamUrl ? null : await listen(http.createServer(upstreamHandler));
  const secretStore = new MemorySecretStore();
  for (const [id, secret] of Object.entries(secrets || { acct_1: { apiKey: 'test-api-key' } })) {
    await secretStore.set(id, secret);
  }
  const accountManager = new AccountManager({
    accounts: accounts || [{ id: 'acct_1', name: 'acct-1', type: 'apikey' }],
    switchThreshold: 1,
    now: () => 1000,
  });
  prepare?.(accountManager);
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    config: {
      upstream: upstreamUrl || upstream.url,
      usagePolling: { enabled: false },
      proxy: { upstreamConnectRetries: 0 },
    },
    logger,
    ...(writer ? { usageEventWriter: writer } : { usageEventsDir: dir }),
    ...isolatedServerOptions(),
    ...serverOptions,
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    if (upstream) await close(upstream.server);
  });
  return { proxy, accountManager };
}

// 追記は forwardOnce() の finally で、応答を書き終えた後に走る。クライアントが応答を
// 受け取った時点では、まだファイルに載っていないことがあるので、件数が揃うまで待つ。
async function readEvents(dir, { count = 1, timeoutMs = 2000 } = {}) {
  const path = join(dir, USAGE_EVENTS_FILENAME);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let lines = [];
    try {
      lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (lines.length >= count || Date.now() >= deadline) return lines.map(line => JSON.parse(line));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function oauthRetryServerOptions() {
  return {
    tokenRefresher: async refreshToken => {
      assert.equal(refreshToken, 'refresh-token-1');
      return { accessToken: 'fresh-token', refreshToken: 'refresh-token-2', expiresAt: Date.now() + 2 * 60 * 60 * 1000 };
    },
  };
}

function oauthRetrySecrets() {
  return {
    acct_1: { accessToken: 'stale-token', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000 },
  };
}

// First call: 401 (token rejected). Second call (fresh token): 200 with usage.
function oauthRetryUpstream(upstreamSeen) {
  return (req, res) => {
    upstreamSeen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer stale-token') {
      res.writeHead(401, { 'content-type': 'application/json', 'request-id': 'req_401' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Invalid authentication credentials' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_after_refresh' });
    res.end(JSON.stringify({ id: 'msg_r', model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 4 } }));
  };
}

async function tempDir() {
  return join(await mkdtemp(join(tmpdir(), 'usage-events-forward-')), 'usage-events');
}

describe('usage-events.jsonl from forwardOnce', () => {
  it('records a gzip-compressed streaming response without touching the client bytes', async () => {
    const dir = await tempDir();
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":1,"cache_read_input_tokens":7,"cache_creation_input_tokens":0}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":42}}',
      '',
      '',
    ].join('\n');
    const compressed = await gzip(sse);
    const { proxy, accountManager } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'request-id': 'req_stream',
        });
        res.end(compressed);
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'claude-sonnet-4-5' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.deepEqual(response.body, compressed);

    const events = await readEvents(dir);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].usage, {
      inputTokens: 100,
      outputTokens: 42,
      cacheCreation5m: 0,
      cacheCreation1h: 0,
      cacheRead: 7,
    });
    assert.equal(events[0].eventId, 'req_stream/1');
    assert.equal(events[0].requestId, 'req_stream');
    assert.equal(events[0].messageId, 'msg_1');
    assert.equal(events[0].model, 'claude-sonnet-4-5');
    assert.equal(events[0].accountId, 'acct_1');
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].outcome, 'ok');
    assert.equal(events[0].statusCode, 200);
    assert.equal(events[0].errorType, null);
    assert.ok(Number.isFinite(Date.parse(events[0].ts)));
    // The API key sent upstream must never reach the JSONL.
    assert.doesNotMatch(await readFile(join(dir, USAGE_EVENTS_FILENAME), 'utf8'), /test-api-key/);

    // The legacy totals are still updated exactly once per response (no double count).
    const usage = accountManager.getStatus().accounts[0].usage;
    assert.equal(usage.totalRequests, 1);
    assert.equal(usage.totalInputTokens, 100);
    assert.equal(usage.totalOutputTokens, 42);
  });

  it('records a failure event with usage=null when upstream returns 500', async () => {
    const dir = await tempDir();
    const { proxy } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        res.writeHead(500, { 'content-type': 'application/json', 'request-id': 'req_fail' });
        res.end('{"type":"error","error":{"type":"api_error","message":"boom"}}');
      },
    });

    await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });

    const events = await readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].statusCode, 500);
    assert.equal(events[0].usage, null);
    assert.equal(events[0].eventId, 'req_fail/1');
    assert.equal(events[0].outcome, 'upstream-error-passthrough');
  });

  it('records a connection failure with a UUID eventId and the error type', async () => {
    const dir = await tempDir();
    // A port that was just released: nothing listens there any more.
    const closed = await listen(http.createServer());
    await close(closed.server);
    const { proxy } = await startProxy({ dir, upstreamUrl: closed.url });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.ok(response.status >= 500);

    const events = await readEvents(dir);
    assert.equal(events.length, 1);
    assert.match(events[0].eventId, UUID_V4);
    assert.equal(events[0].requestId, null);
    assert.equal(events[0].statusCode, null);
    assert.equal(events[0].outcome, 'upstream-error');
    assert.equal(events[0].errorType, 'ECONNREFUSED');
    assert.equal(events[0].usage, null);
  });

  it('does not record events for paths other than POST /v1/messages', async () => {
    const dir = await tempDir();
    const { proxy } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_paths' });
        res.end('{"usage":{"input_tokens":5,"output_tokens":5}}');
      },
    });

    await requestRaw(`${proxy.url}/v1/models`, { method: 'GET' });
    await requestRaw(`${proxy.url}/v1/messages/count_tokens`, { method: 'POST', body: '{}' });
    // Positive control in the same dir: proves the writer is wired, so the absence
    // of the two requests above is meaningful.
    await requestRaw(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', body: '{}' });

    const events = await readEvents(dir, { count: 2, timeoutMs: 300 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'req_paths/1');
  });

  it('does not count usage when the body does not decode as its stacked content-encoding', async () => {
    const dir = await tempDir();
    const body = await gzip(JSON.stringify({
      id: 'msg_2',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 9, output_tokens: 3 },
    }));
    const { proxy, accountManager } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip, br',
          'request-id': 'req_multi',
        });
        res.end(body);
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, body);

    const events = await readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].usage, null);
    assert.equal(events[0].outcome, 'ok');
    assert.equal(events[0].statusCode, 200);
    assert.equal(accountManager.getStatus().accounts[0].usage.totalInputTokens, 0);
  });

  it('numbers attempts across an account switch within one client request', async () => {
    const dir = await tempDir();
    const { proxy, accountManager } = await startProxy({
      dir,
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      secrets: {
        acct_1: { accessToken: 'access-token-1' },
        acct_2: { accessToken: 'access-token-2' },
      },
      prepare(manager) {
        manager.updateQuota('acct_2', {
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-utilization': '0.1',
        });
      },
      upstreamHandler(req, res) {
        if (req.headers.authorization === 'Bearer access-token-1') {
          res.writeHead(429, {
            'content-type': 'application/json',
            'request-id': 'req_quota_1',
            'anthropic-ratelimit-unified-5h-utilization': '1',
            'anthropic-ratelimit-unified-5h-reset': '10',
          });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: '5h' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_ok_2' });
        res.end(JSON.stringify({ id: 'msg_ok', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }));
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, {
      method: 'POST',
      body: JSON.stringify({ model: 'sonnet' }),
    });
    assert.equal(response.status, 200);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_2');

    const events = await readEvents(dir, { count: 2 });
    assert.deepEqual(
      events.map(event => [event.eventId, event.accountId, event.attempt, event.outcome, event.statusCode]),
      [
        ['req_quota_1/1', 'acct_1', 1, 'quota-retry', 429],
        ['req_ok_2/2', 'acct_2', 2, 'ok', 200],
      ],
    );
    assert.equal(events[0].usage, null);
    assert.deepEqual(events[1].usage, {
      inputTokens: 1, outputTokens: 1, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead: 0,
    });
  });

  it('keeps forwarding and account rotation fail-open when the append and its logger both throw', async () => {
    const base = await mkdtemp(join(tmpdir(), 'usage-events-forward-'));
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory');
    const loggerCalls = [];
    const logger = line => {
      loggerCalls.push(line);
      if (/\busage-events?\b/.test(line)) throw new Error('logger boom');
    };
    const upstreamSeen = [];
    const { proxy, accountManager } = await startProxy({
      dir: join(blocker, 'usage-events'),
      logger,
      accounts: [
        { id: 'acct_1', name: 'a@example.com', type: 'oauth' },
        { id: 'acct_2', name: 'b@example.com', type: 'oauth' },
      ],
      secrets: {
        acct_1: { accessToken: 'access-token-1' },
        acct_2: { accessToken: 'access-token-2' },
      },
      prepare(manager) {
        manager.updateQuota('acct_2', {
          'anthropic-ratelimit-unified-5h-utilization': '0.1',
          'anthropic-ratelimit-unified-7d-utilization': '0.1',
        });
      },
      upstreamHandler(req, res) {
        upstreamSeen.push(req.headers.authorization);
        if (req.headers.authorization === 'Bearer access-token-1') {
          res.writeHead(429, {
            'content-type': 'application/json',
            'request-id': 'req_quota_1',
            'anthropic-ratelimit-unified-5h-utilization': '1',
            'anthropic-ratelimit-unified-5h-reset': '10',
          });
          res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: '5h' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_ok_2' });
        res.end(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }));
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer access-token-1', 'Bearer access-token-2']);
    assert.equal(accountManager.getStatus().currentAccount, 'acct_2');
    // The failure path was actually exercised, not skipped by another branch. The append runs
    // after the response (it is not awaited on the hot path), so wait for the log line.
    await waitFor(() => loggerCalls.some(line => /usage-events-append result=failed errorType=ENOTDIR/.test(line)));
  });

  it('writes one event per attempt across a 401 -> token refresh -> resend', async () => {
    const dir = await tempDir();
    const upstreamSeen = [];
    const { proxy } = await startProxy({
      dir,
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      secrets: oauthRetrySecrets(),
      serverOptions: oauthRetryServerOptions(),
      upstreamHandler: oauthRetryUpstream(upstreamSeen),
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamSeen, ['Bearer stale-token', 'Bearer fresh-token']);

    const events = await readEvents(dir, { count: 3, timeoutMs: 300 });
    assert.deepEqual(
      events.map(event => [event.eventId, event.accountId, event.attempt, event.outcome, event.statusCode]),
      [
        ['req_401/1', 'acct_1', 1, 'auth-refresh-retry', 401],
        ['req_after_refresh/2', 'acct_1', 2, 'ok', 200],
      ],
    );
    assert.equal(events[0].usage, null);
    assert.deepEqual(events[1].usage, {
      inputTokens: 3, outputTokens: 4, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead: 0,
    });
    assert.doesNotMatch(await readFile(join(dir, USAGE_EVENTS_FILENAME), 'utf8'), /stale-token|fresh-token|refresh-token/);
  });

  it('writes exactly one client-aborted event when the client disconnects mid-stream', async () => {
    const dir = await tempDir();
    let upstreamCalls = 0;
    const { proxy } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        upstreamCalls += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_abort' });
        // Send the first event and then hold the stream open.
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_a","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
      },
    });

    await new Promise((resolve, reject) => {
      const target = new URL(`${proxy.url}/v1/messages`);
      const req = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      }, res => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      req.end('{}');
    });

    const events = await readEvents(dir, { count: 2, timeoutMs: 500 });
    assert.equal(upstreamCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'req_abort/1');
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].outcome, 'client-aborted');
    assert.equal(events[0].statusCode, 200);
    assert.equal(events[0].usage, null);
  });

  it('writes one event with the parsed usage when the account leaves the ledger mid-request', async () => {
    const dir = await tempDir();
    let accountManagerRef = null;
    let upstreamCalls = 0;
    const { proxy, accountManager } = await startProxy({
      dir,
      prepare(manager) {
        accountManagerRef = manager;
      },
      upstreamHandler(req, res) {
        upstreamCalls += 1;
        // A reload drops acct_1 while its request is in flight.
        accountManagerRef.replaceAccounts([{ id: 'acct_new', name: 'new', type: 'apikey' }]);
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_stale' });
        res.end(JSON.stringify({ id: 'msg_s', model: 'claude-sonnet-4-5', usage: { input_tokens: 5, output_tokens: 6 } }));
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(accountManager.accounts.map(account => account.id), ['acct_new']);

    const events = await readEvents(dir, { count: 2, timeoutMs: 300 });
    assert.equal(upstreamCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'req_stale/1');
    assert.equal(events[0].accountId, 'acct_1');
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].outcome, 'ok');
    assert.equal(events[0].messageId, 'msg_s');
    assert.deepEqual(events[0].usage, {
      inputTokens: 5, outputTokens: 6, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead: 0,
    });
  });

  it('does not hold the 401 resend or the client response while the event write is stalled', async () => {
    const dir = await tempDir();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    // Every disk operation of the writer waits on the gate, from the first mkdir onwards.
    let stalledCalls = 0;
    const stalled = fn => async (...args) => {
      stalledCalls += 1;
      await gate;
      return fn(...args);
    };
    const writer = createUsageEventWriter({
      dir,
      fsOps: { appendFile: stalled(appendFile), chmod: stalled(chmod), mkdir: stalled(mkdir), stat: stalled(stat) },
    });
    const upstreamSeen = [];
    const { proxy } = await startProxy({
      dir,
      writer,
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      secrets: oauthRetrySecrets(),
      serverOptions: oauthRetryServerOptions(),
      upstreamHandler: oauthRetryUpstream(upstreamSeen),
    });

    try {
      const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
      // Both attempts reached upstream and the client got its answer while the disk was stuck.
      assert.equal(response.status, 200);
      assert.deepEqual(upstreamSeen, ['Bearer stale-token', 'Bearer fresh-token']);
      assert.ok(stalledCalls >= 1);
      assert.equal((await readEvents(dir, { count: 1, timeoutMs: 0 })).length, 0);
    } finally {
      release();
    }

    await writer.flush();
    const events = await readEvents(dir, { count: 2, timeoutMs: 0 });
    assert.deepEqual(events.map(event => event.eventId), ['req_401/1', 'req_after_refresh/2']);
  });

  it('forwards normally but writes nothing while the file cannot be made 0600', async () => {
    const dir = await tempDir();
    const logs = [];
    const writer = createUsageEventWriter({
      dir,
      logger: line => logs.push(line),
      fsOps: {
        async chmod(target) {
          if (/usage-events-[0-9]{8}\.jsonl$/.test(target)) throw Object.assign(new Error('nope'), { code: 'EPERM' });
        },
      },
    });
    const { proxy } = await startProxy({
      dir,
      writer,
      upstreamHandler(req, res) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_perm' });
        res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
      },
    });

    const response = await requestRaw(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);

    await writer.flush();
    // The day's file was created empty and never written to.
    assert.equal(await readFile(writer.currentPath(), 'utf8'), '');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /usage-events-chmod result=failed target=file reason=chmod errorType=EPERM action=skip-event/);
  });

  it('records proxy-error instead of ok when bookkeeping throws after a parsed 200', async () => {
    const dir = await tempDir();
    const { proxy } = await startProxy({
      dir,
      prepare(manager) {
        manager.recordProxyRequest = () => {
          throw new TypeError('bookkeeping boom');
        };
      },
      upstreamHandler(req, res) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_boom' });
        res.end(JSON.stringify({ id: 'msg_b', model: 'claude-sonnet-4-5', usage: { input_tokens: 2, output_tokens: 2 } }));
      },
    });

    // The proxy destroys the already-started response, so wait for the socket to close
    // rather than for a complete response.
    await new Promise(resolve => {
      const target = new URL(`${proxy.url}/v1/messages`);
      const req = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      }, res => {
        res.on('error', () => {});
        res.resume();
        res.on('close', resolve);
      });
      req.on('error', resolve);
      req.end('{}');
    });

    const events = await readEvents(dir, { count: 2, timeoutMs: 300 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'req_boom/1');
    assert.equal(events[0].outcome, 'proxy-error');
    assert.equal(events[0].errorType, 'TypeError');
    assert.equal(events[0].statusCode, 200);
  });

  it('keeps upstream-error when the send on a rate-limited account fails and the error is rethrown', async () => {
    const dir = await tempDir();
    // The only account is rate limited, so the proxy sends on it anyway with
    // upstream errors passed through; the connection failure is rethrown
    // instead of being answered with a synthetic 502 inside the attempt.
    let proxy;
    for (let attempt = 1; ; attempt += 1) {
      // A port that was just released: nothing listens there any more.
      const closed = await listen(http.createServer());
      await close(closed.server);
      ({ proxy } = await startProxy({
        dir,
        upstreamUrl: closed.url,
        accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
        secrets: { acct_1: { accessToken: 'access-token-1' } },
        prepare(manager) {
          manager.markRateLimited('acct_1', 60);
        },
      }));
      // The OS may hand the released port straight to the proxy; it would then
      // forward to itself instead of hitting a refused connection. Retry then.
      if (new URL(proxy.url).port !== new URL(closed.url).port) break;
      await close(proxy.server);
      if (attempt >= 3) assert.fail('the proxy kept getting the released upstream port');
    }

    await new Promise(resolve => {
      const target = new URL(`${proxy.url}/v1/messages`);
      const req = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      }, res => {
        res.on('error', () => {});
        res.resume();
        res.on('close', resolve);
      });
      req.on('error', resolve);
      req.end('{}');
    });

    const events = await readEvents(dir, { count: 2, timeoutMs: 300 });
    assert.equal(events.length, 1);
    assert.match(events[0].eventId, UUID_V4);
    assert.equal(events[0].accountId, 'acct_1');
    assert.equal(events[0].outcome, 'upstream-error');
    assert.equal(events[0].errorType, 'ECONNREFUSED');
    assert.equal(events[0].statusCode, null);
    assert.equal(events[0].usage, null);
  });

  it('keeps upstream-error, not proxy-error, when upstream drops the socket after sending headers', async () => {
    const dir = await tempDir();
    const { proxy } = await startProxy({
      dir,
      upstreamHandler(req, res) {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_drop' });
        // Push the head and a first event out, then cut the connection mid-body.
        res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_d"}}\n\n');
        setTimeout(() => res.socket?.destroy(), 20);
      },
    });

    await new Promise(resolve => {
      const target = new URL(`${proxy.url}/v1/messages`);
      const req = http.request({
        hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      }, res => {
        res.on('error', () => {});
        res.resume();
        res.on('close', resolve);
      });
      req.on('error', resolve);
      req.end('{}');
    });

    const events = await readEvents(dir, { count: 2, timeoutMs: 300 });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, 'req_drop/1');
    assert.equal(events[0].outcome, 'upstream-error');
    assert.equal(events[0].statusCode, 200);
    assert.equal(events[0].usage, null);
  });
});
