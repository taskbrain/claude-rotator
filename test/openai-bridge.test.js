import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { AccountManager } from '../src/account-manager.js';
import { LOCAL_GATEWAY_AUTH_TOKEN, createDefaultConfig } from '../src/config.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { createProxyServer } from '../src/proxy-server.js';
import {
  forwardToOpenAiBridge,
  resolveOpenAiBridgeSettings,
  safeParseModel,
  shouldRouteToOpenAiBridge,
} from '../src/openai-bridge.js';

// production 側（src/proxy-server.js の分岐）は shouldRouteToOpenAiBridge が返す
// model をそのまま forwardToOpenAiBridge へ渡す。ここでも同じ経路を再現する。

// ---------------------------------------------------------------------------
// Task 25: 設定セクションと判定ロジック
// ---------------------------------------------------------------------------

describe('openaiBridge defaults', () => {
  it('is disabled by default', () => {
    const config = createDefaultConfig();
    assert.equal(config.openaiBridge.enabled, false);
    assert.equal(config.openaiBridge.url, 'http://127.0.0.1:18765');
    assert.equal(config.openaiBridge.modelPattern, '^gpt-|^o[0-9]|^openai/');
    assert.equal(config.openaiBridge.connectTimeoutMs, 5000, '接続確立前のタイムアウト（outcome=bridge-unreachable 側。ステータスは403で統一）');
    assert.equal(config.openaiBridge.idleTimeoutMs, 30000, '接続確立後のアイドルタイムアウト（outcome=bridge-timeout 側。ステータスは403で統一）');
    assert.equal(config.openaiBridge.connectRetries, 0, '既定では接続前失敗も再試行しない');
    assert.equal(config.openaiBridge.timeoutMs, undefined, 'v3 で 3 キーへ分割済み。旧キーは残さない');
  });
});

describe('safeParseModel', () => {
  it('reads the model field', () => {
    assert.equal(safeParseModel(Buffer.from('{"model":"gpt-6-astra"}')), 'gpt-6-astra');
  });

  it('returns null for invalid JSON, empty bodies and missing model', () => {
    assert.equal(safeParseModel(Buffer.from('not json')), null);
    assert.equal(safeParseModel(Buffer.alloc(0)), null);
    assert.equal(safeParseModel(Buffer.from('{"messages":[]}')), null);
    assert.equal(safeParseModel(undefined), null);
  });
});

describe('shouldRouteToOpenAiBridge', () => {
  const settings = resolveOpenAiBridgeSettings({ openaiBridge: { ...createDefaultConfig().openaiBridge, enabled: true } });

  it('routes gpt-, o-series and openai/ prefixed models', () => {
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'o3-mini', 'openai/gpt-6-astra']) {
      const result = shouldRouteToOpenAiBridge(Buffer.from(JSON.stringify({ model })), settings);
      assert.equal(result.route, true, `${model} should route`);
      assert.equal(result.model, model);
      assert.equal(result.reason, 'match');
    }
  });

  it('returns the parsed body so callers never re-parse it (仕様書 4.2.2 節 a)', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-6-astra', max_tokens: 7 }));
    const result = shouldRouteToOpenAiBridge(body, settings);
    assert.equal(typeof result.parsed, 'object');
    assert.equal(result.parsed.max_tokens, 7);
    // Claude 宛（no-match）でも parsed を返す。forwardWithRotation 側へ渡して再パースを避けるため。
    const claude = shouldRouteToOpenAiBridge(Buffer.from(JSON.stringify({ model: 'claude-opus-5' })), settings);
    assert.equal(claude.route, false);
    assert.equal(claude.parsed.model, 'claude-opus-5');
  });

  it('never routes Claude models', () => {
    for (const model of ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-sonnet-5']) {
      const result = shouldRouteToOpenAiBridge(Buffer.from(JSON.stringify({ model })), settings);
      assert.equal(result.route, false, `${model} must stay on the Anthropic path`);
      assert.equal(result.reason, 'no-match');
    }
  });

  it('falls back to the Anthropic path when the body cannot be parsed', () => {
    const result = shouldRouteToOpenAiBridge(Buffer.from('<<not json>>'), settings);
    assert.equal(result.route, false);
    assert.equal(result.reason, 'parse-error');
  });

  it('falls back to the Anthropic path for bodyless requests (HEAD /api/hello)', () => {
    const result = shouldRouteToOpenAiBridge(Buffer.alloc(0), settings);
    assert.equal(result.route, false);
    assert.equal(result.reason, 'parse-error');
  });

  it('does nothing at all when disabled', () => {
    const disabledSettings = resolveOpenAiBridgeSettings(createDefaultConfig());
    const result = shouldRouteToOpenAiBridge(Buffer.from('{"model":"gpt-6-astra"}'), disabledSettings);
    assert.equal(result.route, false);
    assert.equal(result.reason, 'disabled');
  });

  it('falls back to the Anthropic path when modelPattern does not compile (fail-safe)', () => {
    // 仕様書 4.2.2 節 b（v3 で拡張）: JSON パース失敗**または** modelPattern コンパイル失敗のときは
    // forwardWithRotation() へ進み、outcome=parse-error-fallback を記録する。
    const settingsBad = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:18765', modelPattern: '([unclosed', connectTimeoutMs: 1000, idleTimeoutMs: 1000 },
    });
    assert.equal(settingsBad.enabled, false, '例外を投げず分岐を無効化する');
    assert.match(settingsBad.warning, /modelPattern/);
    const result = shouldRouteToOpenAiBridge(Buffer.from('{"model":"gpt-6-astra"}'), settingsBad);
    assert.equal(result.route, false, 'Claude 宛の既存経路へ進む（全トラフィックを壊さない）');
    assert.equal(result.reason, 'parse-error', 'ログの outcome は parse-error-fallback になる');
  });

  it('refuses a non-loopback bridge url', () => {
    const settingsRemote = resolveOpenAiBridgeSettings({ openaiBridge: { enabled: true, url: 'http://evil.example.com:80', modelPattern: '^gpt-', connectTimeoutMs: 1000, idleTimeoutMs: 1000 } });
    assert.equal(settingsRemote.enabled, false);
    assert.match(settingsRemote.warning, /loopback/);
  });
});

// ---------------------------------------------------------------------------
// Task 26: forwardToOpenAiBridge（SSE 透過・タイムアウト・abort 伝播）
// ---------------------------------------------------------------------------

function startFakeBridge(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function callThroughRotator({ bridgeHandler, requestBody, settingsOverride = {} }) {
  const { server: bridge, port } = await startFakeBridge(bridgeHandler);
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: { enabled: true, url: `http://127.0.0.1:${port}`, modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 0, ...settingsOverride },
  });
  const lines = [];
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await forwardToOpenAiBridge({ req, res, body, model: safeParseModel(body), settings, logger: l => lines.push(l) });
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'claude-rotator-local-gateway', 'anthropic-version': '2023-06-01' },
    body: requestBody,
  });
  const text = await response.text();
  front.close();
  bridge.close();
  return { response, text, lines, bridgePort: port };
}

describe('forwardToOpenAiBridge', () => {
  it('forwards method, path, query, headers and body unchanged', async () => {
    let seen = null;
    const { response, bridgePort } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra","messages":[]}',
      bridgeHandler: async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      },
    });
    assert.equal(response.status, 200);
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.equal(seen.body, '{"model":"gpt-6-astra","messages":[]}');
    assert.equal(seen.headers['x-api-key'], 'claude-rotator-local-gateway', 'auth headers pass through untouched');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    // 'host' はホップバイホップとして除去され、Node の http.request が接続先
    // （bridge自身のhost:port）を使って再設定する。front（クライアント→rotator間）の
    // host をそのまま bridge へ横流ししていないことがこれで確認できる。
    // ('connection' ヘッダは Node の http クライアントが自分の接続管理のために
    //  常に独自の値を付け直すため、undefined を期待するアサーションは実機と噛み合わない。)
    assert.equal(seen.headers.host, `127.0.0.1:${bridgePort}`, 'hop-by-hop host header is replaced with the bridge target, not forwarded from the client');
  });

  it('streams SSE chunks through without buffering the whole body', async () => {
    const { text } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra","stream":true}',
      bridgeHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => {
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.end();
        }, 30);
      },
    });
    assert.match(text, /message_start/);
    assert.match(text, /message_stop/);
    assert.ok(text.indexOf('message_start') < text.indexOf('message_stop'));
  });

  it('returns 403 permission_error when the bridge refuses the connection (追試4b確定)', async () => {
    // bridge不達（接続拒否）は403 permission_errorで即座に返す。502/504は
    // Claude Codeが最大301回・指数バックオフで再試行し続けるため採用しない
    // （docs/research/11b_spike4b-nonretryable-status.md）。
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 500, idleTimeoutMs: 500, connectRetries: 0 },
    });
    const lines = [];
    const front = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await forwardToOpenAiBridge({ req, res, body: Buffer.concat(chunks), settings, logger: l => lines.push(l) });
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"gpt-6-astra"}',
    });
    const body = await response.json();
    front.close();
    assert.equal(response.status, 403);
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'permission_error');
    assert.match(body.error.message, /openai-bridge unreachable/);
    assert.ok(lines.some(l => /outcome=bridge-unreachable/.test(l)), lines.join('\n'));
  });

  it('returns 403 permission_error when the bridge accepts but never answers (idleTimeoutMs、追試4b確定)', async () => {
    const { response, text, lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { idleTimeoutMs: 150 },
      bridgeHandler: () => { /* never responds */ },
    });
    assert.equal(response.status, 403, '接続確立後の無応答も403で統一する（502/504は再試行対象のため不採用）');
    assert.match(text, /openai-bridge unreachable/);
    assert.match(text, /idle timeout/);
    assert.ok(lines.some(l => /outcome=bridge-timeout/.test(l)), lines.join('\n'));
  });

  it('unifies the HTTP status to 403 but keeps connect failure and idle timeout distinguishable via outcome', async () => {
    // 仕様書 4.2.1 節・4.2.4 節（v3、追試4b・2026-09-07反映）: 接続確立前と確立後は
    // 別障害であり、設定キーは分かれている。HTTPステータスは403で統一するが、
    // ログの outcome（bridge-unreachable / bridge-timeout）で両者を取り違えないことを固定する。
    const { response, lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { connectTimeoutMs: 5000, idleTimeoutMs: 150 },
      bridgeHandler: () => { /* accepts, never responds */ },
    });
    assert.equal(response.status, 403);
    assert.ok(lines.some(l => /outcome=bridge-timeout/.test(l)), lines.join('\n'));
    assert.ok(lines.every(l => !/outcome=bridge-unreachable/.test(l)), lines.join('\n'));
  });

  it('never returns 404 for any bridge failure', async () => {
    const { response } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { idleTimeoutMs: 150 },
      bridgeHandler: () => { /* never responds */ },
    });
    assert.notEqual(response.status, 404);
  });

  it('logs one openai-bridge line per forwarded request', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      bridgeHandler: (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
    });
    const logLine = lines.find(l => /openai-bridge/.test(l));
    assert.ok(logLine, lines.join('\n'));
    assert.match(logLine, /model=gpt-6-astra/);
    assert.match(logLine, /method=POST/);
    assert.match(logLine, /path=\/v1\/messages/);
    assert.match(logLine, /status=200/);
    assert.match(logLine, /durationMs=\d+/);
    assert.match(logLine, /outcome=forwarded/);
  });

  it('does not log request bodies', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra","messages":[{"role":"user","content":"secret text"}]}',
      bridgeHandler: (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
    });
    assert.ok(lines.every(l => !/secret text/.test(l)));
  });

  it('propagates a client abort to the upstream bridge connection', async () => {
    let bridgeReqAborted = false;
    const { server: bridge, port } = await startFakeBridge((req, res) => {
      req.on('aborted', () => { bridgeReqAborted = true; });
      // never respond; wait for the client to abort first
    });
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: `http://127.0.0.1:${port}`, modelPattern: '^gpt-', connectTimeoutMs: 5000, idleTimeoutMs: 5000, connectRetries: 0 },
    });
    const lines = [];
    let finished;
    const finishedPromise = new Promise(resolve => { finished = resolve; });
    const front = http.createServer((req, res) => {
      forwardToOpenAiBridge({ req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), settings, logger: l => { lines.push(l); finished(); } });
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"model":"gpt-6-astra"}',
      signal: controller.signal,
    }).catch(() => { /* expected: the client aborted the request itself */ });
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await pending;
    await finishedPromise;
    // upstream.destroy() が bridge 側のソケットへ反映されるまで少し待つ（ネットワーク越しのイベント）
    await new Promise(resolve => setTimeout(resolve, 50));
    front.close();
    bridge.close();
    assert.ok(bridgeReqAborted, 'the upstream bridge request must be destroyed when the client aborts');
    assert.ok(lines.some(l => /outcome=client-abort/.test(l)), lines.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Task 27: POST /internal/reload の openaiBridge 対応（V-9）
// ---------------------------------------------------------------------------

describe('POST /internal/reload with openaiBridge', () => {
  it('applies an openaiBridge change without a process restart', async () => {
    // config オブジェクトを差し替えるリロード関数を模し、reload 後に enabled が効くことを確認する
    const config = { openaiBridge: { enabled: false, url: 'http://127.0.0.1:18765', modelPattern: '^gpt-', connectTimeoutMs: 1000, idleTimeoutMs: 1000, connectRetries: 0 } };
    const before = resolveOpenAiBridgeSettings(config);
    assert.equal(before.enabled, false);
    // reload 相当: 設定ファイルの内容で config を更新する
    Object.assign(config, { openaiBridge: { ...config.openaiBridge, enabled: true } });
    const after = resolveOpenAiBridgeSettings(config);
    assert.equal(after.enabled, true, 'the branch must pick up the reloaded config object');
  });

  it('serves a reloaded openaiBridge setting on the next request', async () => {
    // createProxyServer に渡す config オブジェクトを外から書き換え、
    // POST /internal/reload の後に model=gpt-* が bridge へ流れることを確認する。
    const anthropicSeen = [];
    const anthropic = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      anthropicSeen.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    }));

    const bridgeSeen = [];
    const bridge = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      bridgeSeen.push({ url: req.url, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    // ①enabled:false で起動
    let openaiBridgeFileConfig = {
      enabled: false,
      url: bridge.url,
      modelPattern: '^gpt-',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
    };
    const config = {
      upstream: anthropic.url,
      usagePolling: { enabled: false },
      openaiBridge: { ...openaiBridgeFileConfig },
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config,
      reloadOpenAiBridge: async () => openaiBridgeFileConfig,
    }));

    try {
      // ②gpt-6-astra を投げて Anthropic 側スタブへ届くことを確認
      const before = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6-astra' }),
        headers: {
          authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(before.status, 200);
      assert.equal(anthropicSeen.length, 1, 'bridge is disabled, so the request must go to the Anthropic stub');
      assert.equal(bridgeSeen.length, 0);

      // ③config.openaiBridge.enabled = true にして POST /internal/reload
      openaiBridgeFileConfig = { ...openaiBridgeFileConfig, enabled: true };
      const reloadResponse = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
      assert.equal(reloadResponse.status, 200);

      // ④再度 gpt-6-astra を投げて bridge スタブへ届くことを確認
      const after = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6-astra' }),
        headers: {
          authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(after.status, 200);
      assert.equal(bridgeSeen.length, 1, 'after reload, the request must reach the bridge stub without a process restart');
      assert.equal(anthropicSeen.length, 1, 'the Anthropic stub must not see the second request');
    } finally {
      await close(proxy.server);
      await close(anthropic.server);
      await close(bridge.server);
    }
  });
});

// ---------------------------------------------------------------------------
// テストヘルパ（test/proxy-server.test.js の既存パターンを流用）
// ---------------------------------------------------------------------------

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref?.();
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: options.path || `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, bodyText: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', error => {
        if (!settled) { settled = true; reject(error); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
  return response;
}
