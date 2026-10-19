// proxy の行の末尾の rc=（x-claude-code-request-class 見出しの値）を実 TCP で確かめる。
//
// 隔離: 上流は 127.0.0.1 port 0 のテスト用サーバだけで、資格情報の読取・プロファイル取得・
// usage API・トークン更新はすべてスタブを注入する（実 Keychain・実 API へ到達しない）。
// usage-events の出力先は渡さないので、ファイルは書かない。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';

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
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(() => resolve()));
}

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

// 偽の上流は受け取った見出しを覚え、usage つきの JSON を返す。
async function startProxy({ observability } = {}) {
  const upstreamSeen = [];
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    upstreamSeen.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_class' });
    res.end(JSON.stringify({
      id: 'msg_class',
      type: 'message',
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  }));
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', { apiKey: 'test-api-key' });
  const accountManager = new AccountManager({
    accounts: [{ id: 'acct_1', name: 'acct-1', type: 'apikey' }],
    switchThreshold: 1,
    now: () => 1000,
  });
  const lines = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      proxy: { upstreamConnectRetries: 0 },
      ...(observability ? { observability } : {}),
    },
    logger: line => lines.push(line),
    ...isolatedServerOptions(),
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { proxy, lines, upstreamSeen };
}

function sendMessage(proxy, { headers = {}, body = { model: 'claude-sonnet-4-5' } } = {}) {
  return requestRaw(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// proxy の行は応答を書き終えた後に出るので、出るまで待つ。
async function proxyLine(lines, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const found = lines.filter(line => / proxy /.test(line));
    if (found.length > 0) {
      assert.equal(found.length, 1, found.join('\n'));
      return found[0];
    }
    if (Date.now() - started > timeoutMs) throw new Error(`no proxy line:\n${lines.join('\n')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('proxy line rc= from x-claude-code-request-class', () => {
  it('ends the proxy line with rc=auxiliary and forwards the header unchanged', async () => {
    const { proxy, lines, upstreamSeen } = await startProxy();

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-request-class': 'auxiliary' } });

    assert.equal(response.status, 200);
    const line = await proxyLine(lines);
    assert.ok(line.endsWith(' rc=auxiliary'), line);
    assert.equal(upstreamSeen.length, 1);
    assert.equal(upstreamSeen[0]['x-claude-code-request-class'], 'auxiliary');
  });

  it('adds nothing after enc= when the header is absent', async () => {
    const { proxy, lines } = await startProxy();

    const response = await sendMessage(proxy);

    assert.equal(response.status, 200);
    const line = await proxyLine(lines);
    assert.doesNotMatch(line, / rc=/);
    assert.match(line, / enc=\S+$/);
  });

  it('maps an unknown value to rc=other and never writes body or header text to any line', async () => {
    const { proxy, lines } = await startProxy();

    const response = await sendMessage(proxy, {
      headers: { 'x-claude-code-request-class': 'HEADER-MARKER-77' },
      body: {
        model: 'claude-sonnet-4-5',
        system: 'BODY-MARKER-SYSTEM-91c2',
        messages: [{ role: 'user', content: 'BODY-MARKER-USER-5d7e' }],
        tools: [{ name: 'lookup', description: 'BODY-MARKER-TOOL-a3f0', input_schema: { type: 'object' } }],
      },
    });

    assert.equal(response.status, 200);
    const line = await proxyLine(lines);
    assert.ok(line.endsWith(' rc=other'), line);
    for (const logged of lines) {
      assert.doesNotMatch(logged, /BODY-MARKER/);
      assert.doesNotMatch(logged, /HEADER-MARKER/);
    }
  });

  it('writes no rc= when observability.requestLog.enabled is false', async () => {
    const { proxy, lines } = await startProxy({ observability: { requestLog: { enabled: false } } });

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-request-class': 'auxiliary' } });

    assert.equal(response.status, 200);
    const line = await proxyLine(lines);
    assert.doesNotMatch(line, / rc=/);
  });
});
