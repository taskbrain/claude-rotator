// proxy の行の末尾の effort=・effortMsg=（要求の本文の output_config.effort）と、
// hdrMs=（上流の応答の見出しを受け取るまでのミリ秒）を実 TCP で確かめる。
//
// 隔離: 上流と bridge は 127.0.0.1 port 0 のテスト用サーバだけで、資格情報の読取・プロファイル取得・
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

function requestRaw(url, { method = 'POST', headers = {}, body = null } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: false,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
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

const OK_BODY = JSON.stringify({
  id: 'msg_effort',
  type: 'message',
  model: 'claude-sonnet-4-5',
  usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

function answerOk(req, res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(OK_BODY);
}

// 偽の上流は受け取った見出しと本文を覚えてから handler に答えさせる。
async function startUpstream(handler = answerOk) {
  const seen = [];
  const upstream = await listen(http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: Buffer.concat(chunks) });
      handler(req, res);
    });
  }));
  cleanups.push(() => close(upstream.server));
  return { url: upstream.url, seen };
}

async function startProxy({
  upstreamUrl,
  accounts = [{ id: 'acct_1', name: 'acct-1', type: 'apikey' }],
  secrets = { acct_1: { apiKey: 'test-api-key' } },
  prepare = null,
  config = {},
  serverOptions = {},
} = {}) {
  const secretStore = new MemorySecretStore();
  for (const [id, secret] of Object.entries(secrets)) await secretStore.set(id, secret);
  const accountManager = new AccountManager({ accounts, switchThreshold: 1, now: () => 1000 });
  prepare?.(accountManager);
  const lines = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    config: {
      upstream: upstreamUrl,
      usagePolling: { enabled: false },
      proxy: { upstreamConnectRetries: 0 },
      ...config,
    },
    logger: line => lines.push(line),
    ...isolatedServerOptions(),
    ...serverOptions,
  }));
  cleanups.push(() => close(proxy.server));
  return { proxy, lines };
}

function sendMessage(proxy, body, headers = {}) {
  return requestRaw(`${proxy.url}/v1/messages`, {
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function proxyLines(lines) {
  return lines.filter(line => / proxy account=/.test(line));
}

// proxy の行は応答を書き終えた後に出るので、数がそろうまで待つ。
async function waitForProxyLines(lines, count, { timeoutMs = 2000 } = {}) {
  const started = Date.now();
  for (;;) {
    const found = proxyLines(lines);
    if (found.length >= count) {
      assert.equal(found.length, count, found.join('\n'));
      return found;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`expected ${count} proxy line(s):\n${lines.join('\n')}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function numberField(line, key) {
  const match = new RegExp(` ${key}=(\\d+)(?: |$)`).exec(line);
  assert.ok(match, `${key}= is missing: ${line}`);
  return Number(match[1]);
}

// 欄が enc=（と猶予の欄）より後ろにあることだけを見る。rc= などほかの末尾の欄との順は見ない。
function assertAfterObservation(line, field) {
  const at = line.indexOf(` ${field}=`);
  assert.ok(at > line.indexOf(' enc='), `${field}= comes after enc=: ${line}`);
  const ovu = line.indexOf(' ovu=');
  if (ovu >= 0) assert.ok(at > ovu, `${field}= comes after the grace fields: ${line}`);
}

function assertHeaderTiming(line) {
  const hdrMs = numberField(line, 'hdrMs');
  assert.ok(hdrMs >= 0, line);
  assert.ok(hdrMs <= numberField(line, 'durationMs'), `hdrMs is not larger than durationMs: ${line}`);
  assertAfterObservation(line, 'hdrMs');
  return hdrMs;
}

describe('proxy line effort= and effortMsg= from the request body', () => {
  it('appends effort=, effortMsg= and hdrMs= in that order after enc= and forwards the body unchanged', async () => {
    const upstream = await startUpstream();
    const { proxy, lines } = await startProxy({ upstreamUrl: upstream.url });
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      output_config: { effort: 'xhigh' },
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'system', content: 'turn setting', output_config: { effort: 'max' } },
        { role: 'user', content: 'second turn' },
        { role: 'system', content: 'turn setting', output_config: { effort: 'low' } },
        { role: 'user', content: 'third turn' },
      ],
    });

    const response = await sendMessage(proxy, body);

    assert.equal(response.status, 200);
    const [line] = await waitForProxyLines(lines, 1);
    assert.match(line, / effort=xhigh /);
    assert.match(line, / effortMsg=low /);
    assertAfterObservation(line, 'effort');
    assert.ok(line.indexOf(' effort=') < line.indexOf(' effortMsg='), line);
    assert.ok(line.indexOf(' effortMsg=') < line.indexOf(' hdrMs='), line);
    assertHeaderTiming(line);
    assert.equal(upstream.seen.length, 1);
    assert.equal(Buffer.compare(upstream.seen[0].body, Buffer.from(body)), 0, 'the body goes upstream byte for byte');
  });

  it('writes neither field when the body has no usable effort, and the line only gains hdrMs=', async () => {
    const upstream = await startUpstream();
    const { proxy, lines } = await startProxy({ upstreamUrl: upstream.url });

    const bodies = [
      { model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: 'no setting' }] },
      {
        model: 'claude-sonnet-4-5',
        output_config: { effort: '  ' },
        messages: [{ role: 'system', output_config: { effort: 5 } }, { role: 'user', content: 'hi' }],
      },
      { model: 'claude-sonnet-4-5', output_config: 'high', messages: 'not a list' },
    ];
    for (const body of bodies) assert.equal((await sendMessage(proxy, body)).status, 200);

    for (const line of await waitForProxyLines(lines, bodies.length)) {
      assert.doesNotMatch(line, / effort=/);
      assert.doesNotMatch(line, / effortMsg=/);
      assertHeaderTiming(line);
      assert.match(line.replace(/ hdrMs=\d+$/, ''), / enc=\S+$/, 'apart from hdrMs= the line ends where it did before');
    }
  });

  for (const sessionFromBody of [false, true]) {
    it(`maps unknown values to other and never writes body text to any line (sessionFromBody: ${sessionFromBody})`, async () => {
      const upstream = await startUpstream();
      const { proxy, lines } = await startProxy({
        upstreamUrl: upstream.url,
        config: { observability: { requestLog: { sessionFromBody } } },
      });

      const response = await sendMessage(proxy, {
        model: 'claude-sonnet-4-5',
        system: 'BODY-MARKER-SYSTEM-4b1e',
        output_config: { effort: 'BODY-MARKER-EFFORT-77c3' },
        metadata: {
          user_id: JSON.stringify({ device_id: 'BODY-MARKER-DEVICE-0d9a', account_uuid: '', session_id: 'BODY-MARKER-SESSION-e2f5' }),
        },
        messages: [
          { role: 'user', content: 'BODY-MARKER-USER-6a20' },
          { role: 'system', content: 'BODY-MARKER-TURN-91bd', output_config: { effort: 'BODY-MARKER-TURN-EFFORT-3c58' } },
        ],
        tools: [{ name: 'lookup', description: 'BODY-MARKER-TOOL-f013', input_schema: { type: 'object' } }],
      });

      assert.equal(response.status, 200);
      const [line] = await waitForProxyLines(lines, 1);
      assert.match(line, / effort=other effortMsg=other /);
      assert.ok(lines.length > 0);
      for (const logged of lines) assert.doesNotMatch(logged, /MARKER/);
    });
  }

  it('leaves fam= as it was and writes no effort= when the body is not JSON', async () => {
    const upstream = await startUpstream();
    const { proxy, lines } = await startProxy({
      upstreamUrl: upstream.url,
      config: { sessionAffinity: { mode: 'on' } },
    });

    const cases = [
      [{ model: 'claude-fable-5', output_config: { effort: 'max' } }, / fam=fable /, ' effort=max '],
      [{ model: 'claude-fable-5' }, / fam=fable /, null],
      ['{"model":"claude-fable-5","output_config":{"effort":"max"}', / fam=other /, null],
      [{ model: 'claude-sonnet-4-5', output_config: { effort: 'max' } }, / fam=other /, ' effort=max '],
    ];
    for (const [body] of cases) assert.equal((await sendMessage(proxy, body)).status, 200);

    const found = await waitForProxyLines(lines, cases.length);
    for (const [index, [, family, effort]] of cases.entries()) {
      assert.match(found[index], family);
      if (effort) assert.ok(found[index].includes(effort), found[index]);
      else assert.doesNotMatch(found[index], / effort=/);
      assertHeaderTiming(found[index]);
    }
  });

  it('sends gpt-* requests to the bridge and writes no effort= or hdrMs= on any line', async () => {
    const upstream = await startUpstream();
    const bridgeSeen = [];
    const bridge = await listen(http.createServer((req, res) => {
      req.resume();
      bridgeSeen.push(req.url);
      answerOk(req, res);
    }));
    cleanups.push(() => close(bridge.server));
    const { proxy, lines } = await startProxy({
      upstreamUrl: upstream.url,
      config: {
        openaiBridge: {
          enabled: true,
          url: bridge.url,
          modelPattern: '^gpt-',
          connectTimeoutMs: 1000,
          idleTimeoutMs: 1000,
          connectRetries: 0,
        },
      },
    });

    const response = await sendMessage(proxy, { model: 'gpt-6-astra', output_config: { effort: 'high' } });

    assert.equal(response.status, 200);
    assert.equal(bridgeSeen.length, 1);
    assert.equal(upstream.seen.length, 0);
    assert.ok(lines.some(line => / openai-bridge /.test(line)), lines.join('\n'));
    assert.deepEqual(proxyLines(lines), []);
    for (const line of lines) {
      assert.doesNotMatch(line, / effort=/);
      assert.doesNotMatch(line, / hdrMs=/);
    }
  });
});

describe('proxy line hdrMs=', () => {
  it('measures until the upstream headers arrive, not until the body ends', async () => {
    const WAIT_MS = 300;
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end(OK_BODY), WAIT_MS);
    });
    const { proxy, lines } = await startProxy({ upstreamUrl: upstream.url });

    const response = await sendMessage(proxy, { model: 'claude-sonnet-4-5' });

    assert.equal(response.status, 200);
    const [line] = await waitForProxyLines(lines, 1);
    const hdrMs = assertHeaderTiming(line);
    assert.ok(hdrMs < WAIT_MS, `hdrMs=${hdrMs} is shorter than the wait before the body: ${line}`);
  });

  it('puts hdrMs= and effort= on both lines of a quota 429 that moves to the next account', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.headers.authorization === 'Bearer access-token-1') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-utilization': '1',
          'anthropic-ratelimit-unified-5h-reset': '10',
        });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: '5h' } }));
        return;
      }
      answerOk(req, res);
    });
    const { proxy, lines } = await startProxy({
      upstreamUrl: upstream.url,
      accounts: [
        { id: 'acct_1', name: 'acct-1', type: 'oauth' },
        { id: 'acct_2', name: 'acct-2', type: 'oauth' },
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
    });

    const response = await sendMessage(proxy, { model: 'claude-sonnet-4-5', output_config: { effort: 'high' } });

    assert.equal(response.status, 200);
    assert.deepEqual(upstream.seen.map(seen => seen.authorization), ['Bearer access-token-1', 'Bearer access-token-2']);
    const [retried, answered] = await waitForProxyLines(lines, 2);
    assert.match(retried, / account=acct_1 .* status=429 .* outcome=quota-retry /);
    assert.match(answered, / account=acct_2 .* status=200 .* outcome=ok /);
    for (const line of [retried, answered]) {
      assert.match(line, / effort=high /);
      assertHeaderTiming(line);
    }
  });

  it('puts hdrMs= and effort= on both lines of a 401 that is sent again after a token refresh', async () => {
    const upstream = await startUpstream((req, res) => {
      if (req.headers.authorization === 'Bearer stale-token') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'rejected' } }));
        return;
      }
      answerOk(req, res);
    });
    const { proxy, lines } = await startProxy({
      upstreamUrl: upstream.url,
      accounts: [{ id: 'acct_1', name: 'acct-1', type: 'oauth' }],
      secrets: {
        acct_1: { accessToken: 'stale-token', refreshToken: 'refresh-token-1', expiresAt: Date.now() + 60 * 60 * 1000 },
      },
      serverOptions: {
        tokenRefresher: async () => ({
          accessToken: 'fresh-token',
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        }),
      },
    });

    const response = await sendMessage(proxy, { model: 'claude-sonnet-4-5', output_config: { effort: 'medium' } });

    assert.equal(response.status, 200);
    assert.deepEqual(upstream.seen.map(seen => seen.authorization), ['Bearer stale-token', 'Bearer fresh-token']);
    const found = await waitForProxyLines(lines, 2);
    assert.match(found[0], / outcome=auth-refresh-retry /);
    assert.match(found[1], / outcome=ok /);
    for (const line of found) {
      assert.match(line, / effort=medium /);
      assertHeaderTiming(line);
    }
  });

  it('puts hdrMs= and effort= on the single send from an account that is not usable', async () => {
    const upstream = await startUpstream();
    const { proxy, lines } = await startProxy({
      upstreamUrl: upstream.url,
      accounts: [{ id: 'acct_1', name: 'acct-1', type: 'oauth' }],
      secrets: { acct_1: { accessToken: 'access-token-1' } },
      prepare(manager) {
        manager.markRateLimited('acct_1', 60);
      },
    });

    const response = await sendMessage(proxy, { model: 'claude-sonnet-4-5', output_config: { effort: 'low' } });

    assert.equal(response.status, 200);
    assert.equal(upstream.seen.length, 1);
    const [line] = await waitForProxyLines(lines, 1);
    assert.match(line, / effort=low /);
    assertHeaderTiming(line);
  });

  it('writes neither hdrMs= nor effort= on lines without the cache fields', async () => {
    const body = {
      model: 'claude-sonnet-4-5',
      output_config: { effort: 'high' },
      messages: [{ role: 'system', output_config: { effort: 'low' } }],
    };
    const scenarios = {
      'a locally answered quota 429': async () => {
        const upstream = await startUpstream();
        const started = await startProxy({
          upstreamUrl: upstream.url,
          prepare(manager) {
            manager.updateQuota('acct_1', {
              'anthropic-ratelimit-unified-5h-utilization': '1',
              'anthropic-ratelimit-unified-5h-reset': '10',
            });
          },
        });
        const response = await sendMessage(started.proxy, body);
        assert.equal(response.status, 429);
        assert.equal(upstream.seen.length, 0, 'the local 429 never reaches upstream');
        return started.lines;
      },
      'a connection failure': async () => {
        const unused = await listen(http.createServer());
        await close(unused.server);
        const started = await startProxy({ upstreamUrl: unused.url });
        const response = await sendMessage(started.proxy, body);
        assert.equal(response.status, 502);
        return started.lines;
      },
      'observability.requestLog.enabled: false': async () => {
        const upstream = await startUpstream();
        const started = await startProxy({
          upstreamUrl: upstream.url,
          config: { observability: { requestLog: { enabled: false } } },
        });
        assert.equal((await sendMessage(started.proxy, body)).status, 200);
        return started.lines;
      },
    };

    for (const [name, run] of Object.entries(scenarios)) {
      const lines = await run();
      const found = await waitForProxyLines(lines, 1);
      assert.doesNotMatch(found[0], / enc=/, `${name}: the line has no cache fields`);
      for (const line of lines) {
        assert.doesNotMatch(line, / hdrMs=/, `${name}: ${line}`);
        assert.doesNotMatch(line, / effort=/, `${name}: ${line}`);
        assert.doesNotMatch(line, / effortMsg=/, `${name}: ${line}`);
      }
    }
  });
});
