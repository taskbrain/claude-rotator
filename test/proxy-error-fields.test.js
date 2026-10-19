// proxy-error の行に足した欄（requestSeq・account・sid）を実 TCP で確かめる。
//
// 隔離: 上流は 127.0.0.1 port 0 のテスト用サーバだけで、資格情報は MemorySecretStore に置いた
// 合成値だけを使う。資格情報の読取・プロファイル取得・usage API・トークン更新はすべてスタブを
// 注入し、呼ばれたら失敗させる（実 Keychain・実 API へ到達しない）。
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function isolatedServerOptions() {
  return {
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => { throw new Error('test must not read live credentials'); },
    currentProfileFetcher: async () => { throw new Error('test must not fetch a profile'); },
    usageFetcher: async () => { throw new Error('test must not fetch usage'); },
    tokenRefresher: async () => { throw new Error('test must not refresh tokens'); },
  };
}

// 口座を選んだ後の内部の誤り：要求の道の資格情報の読みが、ロックの時間切れでない誤りを投げる。
// 読み自体は済ませてから投げるので、資格情報は要求の道に載っている。
class FailingReadStore extends MemorySecretStore {
  failing = false;

  async getOperational(accountId) {
    const secret = await super.getOperational(accountId);
    if (this.failing) throw new Error('intentional secret read failure');
    return secret;
  }
}

async function startProxy({
  sessionAffinity = null,
  accountName = undefined,
  accessToken = 'synthetic-access-token',
  maxRequestBodyBytes,
  reloadAccounts,
  failReads = true,
} = {}) {
  const upstreamCalls = [];
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    upstreamCalls.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));
  const secretStore = new FailingReadStore();
  await secretStore.set('acct_1', { accessToken, expiresAt: Date.now() + 3_600_000 });
  const accountManager = new AccountManager({
    accounts: [{ id: 'acct_1', type: 'oauth', ...(accountName ? { name: accountName } : {}) }],
  });
  const lines = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    logger: line => lines.push(line),
    ...isolatedServerOptions(),
    ...(reloadAccounts ? { reloadAccounts } : {}),
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      proxy: {
        upstreamConnectRetries: 0,
        ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
      },
      ...(sessionAffinity ? { sessionAffinity } : {}),
    },
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  secretStore.failing = failReads;
  return { proxy, lines, upstreamCalls };
}

function sendMessage(proxy, { headers = {}, body = JSON.stringify({ model: 'claude-sonnet-4-5' }) } = {}) {
  return requestRaw(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    body,
  });
}

// 先頭の時刻を外した proxy-error の行。
function proxyErrorLines(lines) {
  return lines
    .filter(line => / proxy-error /.test(line))
    .map(line => line.replace(/^\S+ /, ''));
}

const SESSION_KEY = 'f1-session-key-0001';
// sha256('f1-session-key-0001') の先頭12桁（試験の外で計算して書き写した値）。
const SESSION_SID = '80934db84fc0';
const INTERNAL_ERROR = 'intentional secret read failure';

describe('proxy-error line fields', () => {
  it('adds requestSeq, account and sid between path= and error= when affinity is on', async () => {
    const { proxy, lines, upstreamCalls } = await startProxy({ sessionAffinity: { mode: 'on' } });

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY } });

    assert.equal(response.status, 502);
    assert.equal(upstreamCalls.length, 0);
    assert.deepEqual(proxyErrorLines(lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=acct_1 sid=${SESSION_SID} error=${INTERNAL_ERROR}`,
    ]);
  });

  it('adds sid in observe mode too', async () => {
    const { proxy, lines } = await startProxy({ sessionAffinity: { mode: 'observe' } });

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY } });

    assert.equal(response.status, 502);
    assert.deepEqual(proxyErrorLines(lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=acct_1 sid=${SESSION_SID} error=${INTERNAL_ERROR}`,
    ]);
  });

  it('writes requestSeq and account but no sid without a sessionAffinity section', async () => {
    const { proxy, lines } = await startProxy();

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY } });

    assert.equal(response.status, 502);
    assert.deepEqual(proxyErrorLines(lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=acct_1 error=${INTERNAL_ERROR}`,
    ]);
  });

  it('writes only requestSeq for an error before any account is chosen', async () => {
    const { proxy, lines, upstreamCalls } = await startProxy({
      failReads: false,
      reloadAccounts: async () => ({
        accounts: [{ id: 'acct_1', type: 'oauth' }],
        allowLiveClaudeCodeCredentials: false,
        validationError: new Error('candidate gateway configuration is invalid'),
      }),
    });

    const response = await requestRaw(`${proxy.url}/internal/reload`, { method: 'POST' });

    assert.equal(response.status, 502);
    assert.equal(upstreamCalls.length, 0);
    assert.deepEqual(proxyErrorLines(lines), [
      'proxy-error method=POST path=/internal/reload requestSeq=1 error=candidate gateway configuration is invalid',
    ]);
  });

  it('writes requestSeq before error= on the request-too-large line', async () => {
    const { proxy, lines, upstreamCalls } = await startProxy({
      sessionAffinity: { mode: 'on' },
      maxRequestBodyBytes: 1024,
      failReads: false,
    });
    const body = `{"model":"sonnet","pad":"${'a'.repeat(4096)}"}`;

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY }, body });

    assert.equal(response.status, 413);
    assert.equal(upstreamCalls.length, 0);
    assert.deepEqual(proxyErrorLines(lines), [
      'proxy-error method=POST path=/v1/messages requestSeq=1 error=request_too_large limitBytes=1024',
    ]);
  });

  it('never writes the raw session id, account name, access token, client header text or rc=', async () => {
    const rawSession = 'rawsession-marker-5f3a';
    const accountName = 'marker.person@example.com';
    const accessToken = 'fake-access-token-marker-91';
    const { proxy, lines } = await startProxy({
      sessionAffinity: { mode: 'on' },
      accountName,
      accessToken,
    });

    const response = await sendMessage(proxy, {
      headers: {
        'x-claude-code-session-id': rawSession,
        'x-claude-code-request-class': 'auxiliary',
        'x-marker-header': 'HEADER-MARKER-77',
      },
    });

    assert.equal(response.status, 502);
    const errorLines = proxyErrorLines(lines);
    assert.deepEqual(errorLines, [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=acct_1 sid=e1fc3ff8bb85 error=${INTERNAL_ERROR}`,
    ]);
    assert.doesNotMatch(errorLines[0], / rc=/);
    for (const text of [...lines, response.text]) {
      assert.ok(!text.includes(rawSession), text);
      assert.ok(!text.includes(accountName), text);
      assert.ok(!text.includes(accessToken), text);
      assert.ok(!text.includes('HEADER-MARKER-77'), text);
    }
  });

  it('numbers requests in arrival order and starts again from 1 on a new server', async () => {
    const first = await startProxy();
    // 1番目：エラーにならない内部の口。2番目と3番目：口座を選んだ後の誤り。
    const health = await requestRaw(`${first.proxy.url}/internal/health`);
    assert.equal(health.status, 200);
    assert.equal((await sendMessage(first.proxy)).status, 502);
    assert.equal((await sendMessage(first.proxy)).status, 502);

    assert.deepEqual(proxyErrorLines(first.lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=2 account=acct_1 error=${INTERNAL_ERROR}`,
      `proxy-error method=POST path=/v1/messages requestSeq=3 account=acct_1 error=${INTERNAL_ERROR}`,
    ]);

    const second = await startProxy();
    assert.equal((await sendMessage(second.proxy)).status, 502);
    assert.deepEqual(proxyErrorLines(second.lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=acct_1 error=${INTERNAL_ERROR}`,
    ]);
  });
});
