// 要求の道の資格情報の読みが、口座のロックを待ち切れずに時間切れになったときの応答を実 TCP で確かめる。
//
// 隔離: 上流は 127.0.0.1 port 0 のテスト用サーバだけで、資格情報は MemorySecretStore を継いだ偽物に
// 置いた合成値だけを使う。資格情報の読取・プロファイル取得・usage API・トークン更新はすべてスタブを
// 注入する（実 Keychain・実 API へ到達しない）。ロックの時間切れは、偽物の店が投げる誤りで作る。
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
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        rawHeaderNames: res.rawHeaders.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase()),
        text: Buffer.concat(chunks).toString('utf8'),
      }));
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

// 店がロックを待ち切れなかったときと同じ形の誤り（文に口座の id、code は SECRET_STORE_LOCK_TIMEOUT）。
function lockTimeoutError(accountId) {
  const error = new Error(`Timed out acquiring the secret-store lock for account ${accountId}`);
  error.code = 'SECRET_STORE_LOCK_TIMEOUT';
  return error;
}

// getOperational の呼ばれ方を記録し、busy に入れた口座の読みでロックの時間切れを投げる偽物。
// 起動の点検の読みも同じ口を通るが、点検は誤りを記録して先へ進むだけなので、要求には響かない。
class LockBusyStore extends MemorySecretStore {
  calls = [];
  busy = new Set();
  failure = null;
  failCredentialSet = false;

  async getOperational(...args) {
    const [accountId, options] = args;
    this.calls.push(args.length > 1 ? { accountId, options } : { accountId });
    if (this.busy.has(accountId)) throw lockTimeoutError(accountId);
    if (this.failure) throw this.failure;
    return super.getOperational(accountId);
  }

  async runCredentialSetExclusive(operation) {
    if (this.failCredentialSet) throw lockTimeoutError('all');
    return super.runCredentialSetExclusive(operation);
  }
}

const FUTURE_RESET = '4070908800';

async function startProxy({
  accounts = [{ id: 'acct_1', type: 'oauth' }],
  quotas = {},
  sessionAffinity = null,
  openaiBridge = null,
  usageFetcher = null,
  upstreamHandler = null,
  beforeStart = null,
} = {}) {
  const upstreamCalls = [];
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    upstreamCalls.push(req.headers.authorization);
    if (upstreamHandler) {
      upstreamHandler(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));
  const secretStore = new LockBusyStore();
  for (const account of accounts) {
    await secretStore.set(account.id, {
      accessToken: `access-token-${account.id}`,
      expiresAt: Date.now() + 3_600_000,
    });
  }
  const accountManager = new AccountManager({ accounts: accounts.map(account => ({ ...account })) });
  for (const [accountId, headers] of Object.entries(quotas)) accountManager.updateQuota(accountId, headers);
  beforeStart?.({ secretStore, accountManager });
  const lines = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    logger: line => lines.push(line),
    ...isolatedServerOptions(),
    ...(usageFetcher ? { usageFetcher } : {}),
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      proxy: { upstreamConnectRetries: 0 },
      ...(sessionAffinity ? { sessionAffinity } : {}),
      ...(openaiBridge ? { openaiBridge } : {}),
    },
  }));
  cleanups.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { proxy, lines, upstreamCalls, secretStore, accountManager };
}

function sendMessage(proxy, { model = 'claude-sonnet-4-5', headers = {} } = {}) {
  const body = JSON.stringify({ model });
  return requestRaw(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
    body,
  });
}

async function statusJson(proxy) {
  const response = await requestRaw(`${proxy.url}/internal/status`);
  assert.equal(response.status, 200);
  return JSON.parse(response.text);
}

// 先頭の時刻を外した proxy-error の行。
function proxyErrorLines(lines) {
  return lines
    .filter(line => / proxy-error /.test(line))
    .map(line => line.replace(/^\S+ /, ''));
}

function proxyLines(lines) {
  return lines.filter(line => / proxy account=/.test(line));
}

// 期待する応答（手で決めた値）。
const LOCK_BUSY_BODY = '{"type":"error","error":{"type":"rate_limit_error","message":"claude-rotator timed out waiting for this account\'s local lock; retry shortly."}}';
const ALLOWED_HEADER_NAMES = new Set([
  'content-type',
  'retry-after',
  'date',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
]);
const FORBIDDEN_BODY_TEXT = [
  'overloaded_error',
  'usage credits are required',
  'extra usage is required',
  'service_spend_limit_reached',
  'exceeded_limit',
  'credits_required',
  'OAuth token has been revoked',
  'OAuth access token has been revoked',
];
const REQUEST_PATH_WAIT = { lockAcquireTimeoutMs: 45000 };

function assertLockBusyResponse(response, markers = []) {
  assert.equal(response.status, 429);
  assert.equal(response.headers['retry-after'], '5');
  assert.equal(response.headers['content-type'], 'application/json');
  for (const name of response.rawHeaderNames) {
    assert.ok(ALLOWED_HEADER_NAMES.has(name), `unexpected header ${name}`);
    assert.ok(!name.startsWith('anthropic-ratelimit-'), name);
  }
  assert.equal(response.headers['x-should-retry'], undefined);
  assert.equal(response.headers['x-claude-rotator-reason'], undefined);
  assert.equal(response.text, LOCK_BUSY_BODY);
  for (const text of [...FORBIDDEN_BODY_TEXT, ...markers]) {
    assert.ok(!response.text.includes(text), text);
  }
}

const SESSION_KEY = 'lock-busy-session-0001';
// sha256('lock-busy-session-0001') の先頭12桁（試験の外で計算して書き写した値）。
const SESSION_SID = '9de1ea084801';

describe('request-path secret lock timeout', () => {
  it('answers a request-path lock timeout with a bounded 429 and keeps the proxy-error line', async () => {
    const accountId = 'acct_lockmark7';
    const accountName = 'lockmark.person@example.com';
    const { proxy, lines, upstreamCalls, secretStore, accountManager } = await startProxy({
      accounts: [{ id: accountId, name: accountName, type: 'oauth' }],
      sessionAffinity: { mode: 'on' },
    });
    secretStore.busy.add(accountId);

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY } });

    assertLockBusyResponse(response, [accountId, accountName, SESSION_KEY, `access-token-${accountId}`]);
    assert.deepEqual(upstreamCalls, []);
    assert.deepEqual(
      secretStore.calls.filter(call => call.options),
      [{ accountId, options: REQUEST_PATH_WAIT }],
    );
    assert.deepEqual(proxyErrorLines(lines), [
      `proxy-error method=POST path=/v1/messages requestSeq=1 account=${accountId} sid=${SESSION_SID} `
        + `error=Timed out acquiring the secret-store lock for account ${accountId}`,
    ]);
    assert.deepEqual(proxyLines(lines), []);
    assert.equal(accountManager.unavailableReason(accountManager.accounts[0]), null);
    for (const line of lines) {
      assert.ok(!line.includes('Symbol('), line);
      assert.ok(!line.includes(accountName), line);
      assert.ok(!line.includes(SESSION_KEY), line);
      assert.ok(!line.includes(`access-token-${accountId}`), line);
    }
  });

  it('does not move to another account, mark the account or count a detour', async () => {
    const { proxy, upstreamCalls, secretStore, accountManager } = await startProxy({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      quotas: {
        acct_1: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' },
        acct_2: { 'anthropic-ratelimit-unified-5h-utilization': '0.9' },
      },
      sessionAffinity: { mode: 'on' },
    });
    const before = (await statusJson(proxy)).sessionAffinity;
    const callsBefore = secretStore.calls.length;
    secretStore.busy.add('acct_1');

    const response = await sendMessage(proxy, { headers: { 'x-claude-code-session-id': SESSION_KEY } });

    assertLockBusyResponse(response);
    assert.deepEqual(upstreamCalls, []);
    assert.deepEqual(secretStore.calls.slice(callsBefore), [{ accountId: 'acct_1', options: REQUEST_PATH_WAIT }]);
    for (const account of accountManager.accounts) {
      assert.equal(accountManager.unavailableReason(account), null, account.id);
    }
    const after = (await statusJson(proxy)).sessionAffinity;
    assert.deepEqual(after.detoursByAccount, before.detoursByAccount);
    assert.deepEqual(after.dispersion, before.dispersion);
  });

  it('answers 429 when the lock times out on the unavailable-account fallback path', async () => {
    const { proxy, upstreamCalls, secretStore } = await startProxy({
      beforeStart: ({ accountManager }) => accountManager.markRateLimited('acct_1', 60),
    });
    const callsBefore = secretStore.calls.length;
    secretStore.busy.add('acct_1');

    const response = await sendMessage(proxy);

    assertLockBusyResponse(response);
    assert.deepEqual(upstreamCalls, []);
    assert.deepEqual(
      secretStore.calls.slice(callsBefore).filter(call => call.options),
      [{ accountId: 'acct_1', options: REQUEST_PATH_WAIT }],
    );
  });

  it('passes the wait to the reactive replay read only, and still replays the earlier response', async () => {
    const upstreamBody = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Fable limit marker' } });
    const { proxy, upstreamCalls, secretStore } = await startProxy({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      quotas: { acct_2: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' } },
      usageFetcher: async () => ({
        scoped_weekly: [{ key: 'fable', label: 'Fable', utilization: 1, resets_at: '2099-01-01T00:00:00Z' }],
      }),
      upstreamHandler: (req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json', 'x-replay-marker': 'earlier' });
        res.end(upstreamBody);
      },
    });
    await statusJson(proxy);
    const callsBefore = secretStore.calls.length;
    // 1回目の acct_2 の読み（反応的な枠の確かめの中の写し）は通し、2回目（再送の周の読み）で時間切れにする。
    const originalGetOperational = secretStore.getOperational.bind(secretStore);
    let acct2Reads = 0;
    secretStore.getOperational = async (...args) => {
      if (args[0] === 'acct_2') {
        acct2Reads += 1;
        if (acct2Reads === 2) secretStore.busy.add('acct_2');
      }
      return originalGetOperational(...args);
    };

    const response = await sendMessage(proxy, { model: 'claude-fable-5' });

    assert.equal(response.status, 429);
    assert.equal(response.text, upstreamBody);
    assert.equal(response.headers['x-replay-marker'], 'earlier');
    assert.deepEqual(upstreamCalls, ['Bearer access-token-acct_1']);
    assert.deepEqual(secretStore.calls.slice(callsBefore), [
      { accountId: 'acct_1', options: REQUEST_PATH_WAIT },
      { accountId: 'acct_2' },
      { accountId: 'acct_2', options: REQUEST_PATH_WAIT },
    ]);
  });

  it('leaves the usage refresh and start-up check reads on the store default wait', async () => {
    const { proxy, secretStore } = await startProxy({
      usageFetcher: async () => ({}),
    });
    await statusJson(proxy);
    assert.deepEqual(secretStore.calls, [{ accountId: 'acct_1' }]);

    const callsBefore = secretStore.calls.length;
    const refreshed = await requestRaw(`${proxy.url}/internal/refresh-usage`, { method: 'POST' });

    assert.equal(refreshed.status, 200);
    assert.deepEqual(secretStore.calls.slice(callsBefore), [{ accountId: 'acct_1' }]);
  });

  it('keeps 502 proxy_error for an internal error that is not a lock timeout', async () => {
    const { proxy, lines, secretStore } = await startProxy();
    await statusJson(proxy);
    secretStore.failure = new Error('intentional non-lock failure');

    const response = await sendMessage(proxy);

    assert.equal(response.status, 502);
    assert.equal(response.headers['retry-after'], undefined);
    assert.deepEqual(JSON.parse(response.text), {
      type: 'error',
      error: { type: 'proxy_error', message: 'intentional non-lock failure' },
    });
    assert.deepEqual(proxyErrorLines(lines), [
      'proxy-error method=POST path=/v1/messages requestSeq=2 account=acct_1 error=intentional non-lock failure',
    ]);
  });

  it('answers a fresh 429 rather than replaying an earlier upstream 429 on a non-reactive attempt', async () => {
    const { proxy, upstreamCalls, secretStore } = await startProxy({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      quotas: { acct_2: { 'anthropic-ratelimit-unified-5h-utilization': '0.2' } },
      upstreamHandler: (req, res) => {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': FUTURE_RESET,
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream quota marker' } }));
      },
    });
    await statusJson(proxy);
    const callsBefore = secretStore.calls.length;
    secretStore.busy.add('acct_2');

    const response = await sendMessage(proxy);

    assertLockBusyResponse(response, ['upstream quota marker']);
    assert.deepEqual(upstreamCalls, ['Bearer access-token-acct_1']);
    assert.deepEqual(secretStore.calls.slice(callsBefore), [
      { accountId: 'acct_1', options: REQUEST_PATH_WAIT },
      { accountId: 'acct_2', options: REQUEST_PATH_WAIT },
    ]);
  });

  it('sends the next request of the same session to the same account', async () => {
    const { proxy, lines, upstreamCalls, secretStore } = await startProxy({
      accounts: [{ id: 'acct_1', type: 'oauth' }, { id: 'acct_2', type: 'oauth' }],
      quotas: {
        acct_1: { 'anthropic-ratelimit-unified-5h-utilization': '0.1' },
        acct_2: { 'anthropic-ratelimit-unified-5h-utilization': '0.9' },
      },
      sessionAffinity: { mode: 'on' },
    });
    await statusJson(proxy);
    secretStore.busy.add('acct_1');
    const sessionHeaders = { 'x-claude-code-session-id': SESSION_KEY };

    assertLockBusyResponse(await sendMessage(proxy, { headers: sessionHeaders }));
    secretStore.busy.delete('acct_1');
    const second = await sendMessage(proxy, { headers: sessionHeaders });

    assert.equal(second.status, 200);
    assert.deepEqual(upstreamCalls, ['Bearer access-token-acct_1']);
    const sent = proxyLines(lines);
    assert.equal(sent.length, 1);
    assert.match(sent[0], / proxy account=acct_1 /);
    assert.match(sent[0], new RegExp(` sid=${SESSION_SID} aff=bound fam=other`));
  });

  it('keeps 502 for a lock timeout from the start-up check that holds the whole credential set', async () => {
    const { proxy, lines, upstreamCalls } = await startProxy({
      beforeStart: ({ secretStore }) => { secretStore.failCredentialSet = true; },
    });
    const expected = {
      type: 'error',
      error: { type: 'proxy_error', message: 'Timed out acquiring the secret-store lock for account all' },
    };

    const messages = await sendMessage(proxy);
    const status = await requestRaw(`${proxy.url}/internal/status`);

    for (const response of [messages, status]) {
      assert.equal(response.status, 502);
      assert.equal(response.headers['retry-after'], undefined);
      assert.deepEqual(JSON.parse(response.text), expected);
    }
    assert.deepEqual(upstreamCalls, []);
    assert.deepEqual(proxyErrorLines(lines), [
      'proxy-error method=POST path=/v1/messages requestSeq=1 error=Timed out acquiring the secret-store lock for account all',
      'proxy-error method=GET path=/internal/status requestSeq=2 error=Timed out acquiring the secret-store lock for account all',
    ]);
  });

  it('keeps the lock-timeout 429 out of the degradeMapping rewrites while those rewrites are active', async () => {
    const openaiBridge = { enabled: false, degradeMapping: { enabled: true, upstreamOverloadTo429: true } };
    let upstreamMode = 'overloaded';
    const { proxy, upstreamCalls, secretStore, accountManager } = await startProxy({
      openaiBridge,
      upstreamHandler: (req, res) => {
        if (upstreamMode === 'overloaded') {
          res.writeHead(529, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    // 対照1：同じ設定で、上流の 529 が 429 と Retry-After 30 へ写る（upstreamOverloadTo429 が効いている）。
    const overloaded = await sendMessage(proxy);
    assert.equal(overloaded.status, 429);
    assert.equal(overloaded.headers['retry-after'], '30');
    assert.equal(JSON.parse(overloaded.text).error.type, 'rate_limit_error');
    assert.equal(upstreamCalls.length, 1);
    upstreamMode = 'ok';

    // (a) ふつうの道の時間切れ。
    secretStore.busy.add('acct_1');
    const plain = await sendMessage(proxy);
    assertLockBusyResponse(plain);

    // (b) 全口座を markError で使えなくして、予備の口座の道に入った時間切れ。
    accountManager.markError('acct_1', 'account_error', 'synthetic unusable account');
    const callsBefore = secretStore.calls.length;
    const fallback = await sendMessage(proxy);
    assertLockBusyResponse(fallback);
    assert.deepEqual(secretStore.calls.slice(callsBefore), [{ accountId: 'acct_1', options: REQUEST_PATH_WAIT }]);
    assert.equal(upstreamCalls.length, 1);

    // 対照2：同じ設定で、全口座が枠切れなら 529 へ写る（exhaustionMapper が効いている）。
    const exhausted = await startProxy({
      openaiBridge,
      quotas: {
        acct_1: {
          'anthropic-ratelimit-unified-7d-utilization': '1',
          'anthropic-ratelimit-unified-7d-reset': FUTURE_RESET,
        },
      },
    });
    const mapped = await sendMessage(exhausted.proxy);
    assert.equal(mapped.status, 529);
    assert.equal(mapped.headers['x-claude-rotator-reason'], 'quota_exhausted');
    assert.deepEqual(exhausted.upstreamCalls, []);
  });
});
