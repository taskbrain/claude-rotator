import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';

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
    assert.equal(config.openaiBridge.idleTimeoutMs, 30000, '接続確立後のアイドルタイムアウト（outcome=bridge-idle-timeout 側。ステータスは403で統一）');
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

  it('never parses the body when the bridge is disabled (regression)', () => {
    // safeParseBody() は内部で JSON.parse() を呼ぶ。無効時に早期 return していれば、
    // JSON.parse は一度も呼ばれない。呼び出し回数を直接計測して確認する
    // （戻り値だけでは disabled 時に parsed が返らないことしか確認できず、
    //  内部で実際にパースを試みたかどうかは判定できないため）。
    const originalParse = JSON.parse;
    let parseCalls = 0;
    JSON.parse = (...args) => { parseCalls += 1; return originalParse(...args); };
    try {
      const body = Buffer.from('{"model":"gpt-6-astra"}');
      const disabledSettings = resolveOpenAiBridgeSettings(createDefaultConfig());
      const disabledResult = shouldRouteToOpenAiBridge(body, disabledSettings);
      assert.equal(disabledResult.reason, 'disabled');
      assert.equal(disabledResult.route, false);
      assert.equal(parseCalls, 0, 'JSON.parse must not run at all when the bridge is disabled');

      const enabledSettings = resolveOpenAiBridgeSettings({ openaiBridge: { ...createDefaultConfig().openaiBridge, enabled: true } });
      const enabledResult = shouldRouteToOpenAiBridge(body, enabledSettings);
      assert.equal(enabledResult.route, true);
      assert.equal(parseCalls, 1, 'JSON.parse must run once the bridge is enabled');
    } finally {
      JSON.parse = originalParse;
    }
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

// ---------------------------------------------------------------------------
// httpRequestImpl を差し替えるための最小フェイク（idle-timeout・背圧の回帰テスト用）
// 実ネットワークに頼らず、接続確立・応答・データイベントを手動で駆動する。
// ---------------------------------------------------------------------------

function fakeIncomingRequest({ url = '/v1/messages', method = 'POST', headers = {} } = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = headers;
  return req;
}

function fakeServerResponse() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writes = [];
  let forceNextWriteFalse = false;
  res.writeHead = (statusCode, headers) => {
    res.headersSent = true;
    res.statusCode = statusCode;
    res.headers = headers;
  };
  res.write = chunk => {
    res.writes.push(chunk);
    if (forceNextWriteFalse) {
      forceNextWriteFalse = false;
      return false;
    }
    return true;
  };
  res.forceNextWriteToReportBackpressure = () => { forceNextWriteFalse = true; };
  res.end = () => { res.writableEnded = true; };
  res.destroy = () => {
    // 実際の http.ServerResponse#destroy() は 'close' を非同期に発火する
    // （基底ソケットのクローズ経由）。同期発火にすると、この destroy() 自体を
    // 呼び出したコード（例: upstream の 'error' ハンドラ）が続けて finish() を
    // 呼ぶより先に res.on('close') 経由の finish('client-abort') が先着してしまい、
    // 本来の outcome を上書きしてしまう。process.nextTick で実機の順序を再現する。
    if (res.destroyed) return;
    res.destroyed = true;
    process.nextTick(() => res.emit('close'));
  };
  return res;
}

// 接続は常に即座に（次tickで）成功したことにする最小の httpRequestImpl。
// テスト側は返り値の getCallback()/getUpstream() で upstream 応答を手動駆動する。
function createManualUpstream() {
  let callback = null;
  let upstream = null;
  const requestImpl = (options, cb) => {
    callback = cb;
    upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.destroy = () => { upstream.destroyed = true; };
    upstream.end = () => {
      process.nextTick(() => upstream.emit('socket', { connecting: false }));
    };
    return upstream;
  };
  return {
    requestImpl,
    getCallback: () => callback,
    getUpstream: () => upstream,
  };
}

function fakeUpstreamResponse(statusCode = 200, headers = {}) {
  const upstreamRes = new EventEmitter();
  upstreamRes.statusCode = statusCode;
  upstreamRes.headers = headers;
  upstreamRes.paused = false;
  upstreamRes.pause = () => { upstreamRes.paused = true; };
  upstreamRes.resume = () => { upstreamRes.paused = false; };
  return upstreamRes;
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
    assert.ok(lines.some(l => /outcome=bridge-idle-timeout/.test(l)), lines.join('\n'));
  });

  it('unifies the HTTP status to 403 but keeps connect failure and idle timeout distinguishable via outcome', async () => {
    // 仕様書 4.2.1 節・4.2.4 節（v3、追試4b・2026-09-07反映）: 接続確立前と確立後は
    // 別障害であり、設定キーは分かれている。HTTPステータスは403で統一するが、
    // ログの outcome（bridge-unreachable / bridge-idle-timeout）で両者を取り違えないことを固定する。
    const { response, lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { connectTimeoutMs: 5000, idleTimeoutMs: 150 },
      bridgeHandler: () => { /* accepts, never responds */ },
    });
    assert.equal(response.status, 403);
    assert.ok(lines.some(l => /outcome=bridge-idle-timeout/.test(l)), lines.join('\n'));
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

  it('propagates a client abort to the upstream bridge connection (production shape: req fully drained before forward, regression)', async () => {
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
    const front = http.createServer(async (req, res) => {
      // src/proxy-server.js の readBody(req) と同じく、for-await で本文を読み切って
      // から forward する。これで req.complete===true になり、この時点以降
      // 'aborted' はもう発火しない。client-abort の検出は res.on('close') 経由で
      // なければならない（旧テストは body を読み切らずに forward していたため、
      // 本番では起きない 'aborted' 発火に依存する空振りテストになっていた）。
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.complete, true, 'the request body must be fully drained before forwarding, matching production readBody()');
      const body = Buffer.concat(chunks);
      await forwardToOpenAiBridge({ req, res, body, model: safeParseModel(body), settings, logger: l => { lines.push(l); finished(); } });
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
    assert.ok(bridgeReqAborted, 'the upstream bridge request must be destroyed when the client aborts (detected via res.on("close"), not req.on("aborted"))');
    assert.ok(lines.some(l => /outcome=client-abort/.test(l)), lines.join('\n'));
  });

  it('pins the upstream host/port to settings.url even for an absolute-form req.url (regression)', async () => {
    // HTTP のリクエストラインは絶対形式（proxy形式）を取り得る。req.url をそのまま
    // `new URL(req.url, settings.url)` に渡すと、絶対URLが base を無視して接続先
    // ホストを乗っ取ってしまう。hostname/port は必ず settings.url 由来であることを固定する。
    let seenPath = null;
    const { server: bridge, port } = await startFakeBridge((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: `http://127.0.0.1:${port}`, modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 0 },
    });
    const front = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      await forwardToOpenAiBridge({ req, res, body, model: safeParseModel(body), settings, logger: () => {} });
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: front.address().port,
        // 絶対形式のリクエストライン。攻撃者が req.url でホストを制御しようとする状況を再現する。
        path: 'http://evil.example.com:1/v1/messages?beta=true',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      });
      request.on('error', reject);
      request.end('{"model":"gpt-6-astra"}');
    });
    front.close();
    bridge.close();
    assert.equal(response.status, 200, response.text);
    assert.equal(seenPath, '/v1/messages?beta=true', 'the bridge must only see the path/query; the evil.example.com host from the absolute-form request line must never reach it');
  });

  it('does not retry a connection reset that arrives after the request was accepted, even immediately (double-send risk, regression)', async () => {
    // 旧テストは「接続直後の即時リセットなら安全に再試行できる」
    // という前提で connectionCount>=2・200 を期待していたが、実測（/tmp/dbg.js 相当の
    // 検証）で、小さな本文はローカルループバック上では socket の 'connect' →
    // ClientRequest の 'finish'（全データをOSへ渡し終えた合図）が、RST由来の
    // 'error' より必ず先に発火することを確認した。つまり「応答がまだ何も届いて
    // いない」ことは「本文がまだ bridge に渡っていない」ことを一切保証しない。
    // このため再検証指摘1でこの再試行経路自体を閉じており、本テストは
    // 「即時リセットでも再試行しない・403で統一される」ことを固定する内容へ更新した。
    let connectionCount = 0;
    const bridge = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    bridge.on('connection', socket => {
      connectionCount += 1;
      if (connectionCount === 1) socket.destroy(); // 最初の接続だけ即座にリセットする
    });
    await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
    const port = bridge.address().port;
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: `http://127.0.0.1:${port}`, modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 1 },
    });
    const lines = [];
    const front = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      await forwardToOpenAiBridge({ req, res, body, model: safeParseModel(body), settings, logger: l => lines.push(l) });
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"gpt-6-astra"}',
    });
    const text = await response.text();
    front.close();
    bridge.close();
    assert.equal(response.status, 403, text);
    assert.equal(connectionCount, 1, `expected exactly 1 connection attempt (no retry after the request body may already have been sent), saw ${connectionCount}`);
    assert.ok(lines.some(l => /outcome=bridge-unreachable/.test(l)), lines.join('\n'));
  });

  it('does not retry once a response has already been forwarded to the client (no double-processing after res.headersSent)', async () => {
    // ヘッダ送出後（res.headersSent===true）に低レベルの接続エラーが起きても、
    // bridge は既にリクエストを処理し始めているため再試行してはいけない
    // （二重処理のリスク）。fake httpRequestImpl で決定的に再現する
    // （実ソケットで headers 送出直後に destroy() すると、Node の http クライアントが
    //  ヘッダ受信自体を完了できず response イベントより先に ECONNRESET を req 側で
    //  検出することがあり、実ネットワークでは再現が不安定なため）。
    let requestImplCalls = 0;
    const manual = createManualUpstream();
    const countingRequestImpl = (options, callback) => {
      requestImplCalls += 1;
      return manual.requestImpl(options, callback);
    };
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 2 },
    });
    const donePromise = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: () => {}, httpRequestImpl: countingRequestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));

    const upstreamRes = fakeUpstreamResponse(200, {});
    manual.getCallback()(upstreamRes); // ヘッダ受信 → res.writeHead() が走り res.headersSent=true になる
    assert.equal(res.headersSent, true, 'precondition: the response head must already be forwarded to the client');

    // ヘッダ送出後に bridge 側の接続が切れた状況を模す。
    manual.getUpstream().emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    assert.equal(requestImplCalls, 1, 'a failure after the response head was already forwarded must never open a retry connection');
    const result = await donePromise;
    assert.equal(result.outcome, 'bridge-stream-error');
  });

  it('does not retry once the request body has been fully flushed to the bridge, even before any response arrives (no double-send, regression)', async () => {
    // upstream.end(body) は接続直後に本文を送り切るため、リクエスト全体（ヘッダ＋
    // 本文）の送信完了（'finish'）後の ECONNRESET は「bridge が本文を全受信した後に
    // 落ちた」可能性があり、再試行すると二重送信（Pro 枠の二重消費）になる。
    // res.headersSent だけを見る旧実装はこのケースを再試行してしまっていた。
    let requestImplCalls = 0;
    const manual = createManualUpstream();
    const countingRequestImpl = (options, callback) => {
      requestImplCalls += 1;
      return manual.requestImpl(options, callback);
    };
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 1 },
    });
    const donePromise = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: () => {}, httpRequestImpl: countingRequestImpl,
    });
    // manual upstream の end() が次tickで 'socket' を発火するまで待つ（bridge からの
    // 応答はまだ何も届いていない）。
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(res.headersSent, false, 'precondition: no bridge response has been forwarded yet');

    // bridge が本文を全受信した（＝クライアント側の書き込みが完了した）状況を
    // 'finish' で模してから、直後に接続がリセットされた状況を再現する。
    manual.getUpstream().emit('finish');
    manual.getUpstream().emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));

    assert.equal(requestImplCalls, 1, 'a reset after the request body was fully sent must never open a retry connection (double-send risk)');
    const result = await donePromise;
    assert.equal(result.outcome, 'bridge-unreachable');
    assert.equal(res.headersSent, true, 'a synthetic error response must still be sent to the client');
    assert.equal(res.statusCode, 403);
  });

  it('ignores an upstream error that fires after finish() has already settled a client abort (regression)', async () => {
    // onClientGone() は currentUpstream.destroy() を呼ぶ。実機（Node 22）では
    // ClientRequest の destroy() 由来の 'error'（ECONNRESET/socket hang up）が
    // 遅れて発火することがあり、settled ガードが無いと res.headersSent===false の
    // まま再試行条件を通過して、クライアント不在のまま2回目のリクエストが飛ぶ。
    let requestImplCalls = 0;
    const manual = createManualUpstream();
    const countingRequestImpl = (options, callback) => {
      requestImplCalls += 1;
      return manual.requestImpl(options, callback);
    };
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 1 },
    });
    const donePromise = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: () => {}, httpRequestImpl: countingRequestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));

    // クライアントが切断し、res.on('close') 経由で finish('client-abort') が
    // 既に確定した状況を模す（production の onClientGone と同じ経路）。
    res.destroy();
    await new Promise(resolve => setImmediate(resolve));
    const result = await donePromise;
    assert.equal(result.outcome, 'client-abort');
    assert.equal(requestImplCalls, 1, 'precondition: only the initial connection was opened so far');

    // finish() 確定後に、destroy() されたソケット由来の 'error' が遅れて発火した
    // 状況を再現する。settled ガードが無いとここで再試行接続が開いてしまう。
    manual.getUpstream().emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    assert.equal(requestImplCalls, 1, 'an error firing after finish() has already settled must never open a retry connection');
  });

  it('logs a connect-retry line before re-attempting a refused connection (regression)', async () => {
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 3000, idleTimeoutMs: 3000, connectRetries: 1 },
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
    await response.text();
    front.close();
    assert.equal(response.status, 403);
    assert.ok(lines.some(l => /outcome=connect-retry attempt=2 code=ECONNREFUSED/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => /outcome=bridge-unreachable/.test(l)), lines.join('\n'));
  });

  it('logs the synthesized 403 status for an idle-timeout, not the placeholder "-" (regression)', async () => {
    // 旧実装は sendSynthetic() を呼んだ後に res.headersSent を再評価していたため、
    // sendSynthetic 自身が headersSent を true にしてしまい、実際には403を送っている
    // のにログの status が null（"-"）になるバグがあった。sendSynthetic 前に
    // willSend を確定してから使う。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 20, connectRetries: 0 },
    });
    const result = await forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    assert.equal(result.outcome, 'bridge-idle-timeout');
    assert.equal(result.status, 403, 'a synthesized 403 must be reported as the log status, not null');
    const logLine = lines.find(l => /outcome=bridge-idle-timeout/.test(l));
    assert.ok(logLine, lines.join('\n'));
    assert.match(logLine, /status=403/);
  });

  it('pauses the upstream response and resumes on drain when the client write buffer is full (regression)', async () => {
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 0 },
    });
    const donePromise = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: () => {}, httpRequestImpl: manual.requestImpl,
    });

    // フェイクの接続確立（process.nextTick で 'socket' イベントが発火する）を待つ。
    await new Promise(resolve => setImmediate(resolve));

    const upstreamRes = fakeUpstreamResponse(200, { 'content-type': 'text/event-stream' });
    manual.getCallback()(upstreamRes);

    res.forceNextWriteToReportBackpressure();
    upstreamRes.emit('data', Buffer.from('chunk-1'));
    assert.equal(upstreamRes.paused, true, 'the upstream response must be paused when res.write() reports backpressure');

    res.emit('drain');
    assert.equal(upstreamRes.paused, false, 'the upstream response must resume once the client drains');

    upstreamRes.emit('data', Buffer.from('chunk-2'));
    assert.deepEqual(res.writes.map(chunk => chunk.toString()), ['chunk-1', 'chunk-2']);

    upstreamRes.emit('end');
    const result = await donePromise;
    assert.equal(result.outcome, 'forwarded');
  });

  it('drops incoming chunks and destroys the upstream once the client response is already destroyed (data ハンドラ先頭のガード)', async () => {
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: true, url: 'http://127.0.0.1:1', modelPattern: '^gpt-', connectTimeoutMs: 2000, idleTimeoutMs: 2000, connectRetries: 0 },
    });
    const donePromise = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra', settings,
      logger: () => {}, httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    const upstreamRes = fakeUpstreamResponse(200, {});
    manual.getCallback()(upstreamRes);

    res.destroyed = true;
    let upstreamDestroyed = false;
    manual.getUpstream().destroy = () => { upstreamDestroyed = true; };
    upstreamRes.emit('data', Buffer.from('too-late'));
    assert.equal(upstreamDestroyed, true, 'the upstream request must be destroyed once the client response is already gone');
    assert.deepEqual(res.writes, [], 'no data may be written to an already-destroyed client response');

    // 後始末: end を発火させて Promise を解決させる（未解決の Promise を残さない）。
    upstreamRes.emit('end');
    await donePromise;
  });
});

// ---------------------------------------------------------------------------
// Task 27: POST /internal/reload の openaiBridge 対応（V-9）
// ---------------------------------------------------------------------------

describe('POST /internal/reload with openaiBridge', () => {
  it('reverts to the default (disabled) bridge config once the section/config.json disappears on reload (regression)', async () => {
    // reloadOpenAiBridge が undefined を返す状況（openaiBridge セクションが config.json
    // から削除された、または config.json 自体が無い）を模す。旧実装は falsy を
    // 「変更なし」と誤認し、削除後も古い（有効な）設定を保持し続けるバグがあった。
    const anthropicSeen = [];
    const anthropic = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      anthropicSeen.push({ body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    }));

    const bridgeSeen = [];
    const bridge = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      bridgeSeen.push({ body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    // 起動時は明示的に enabled:true
    const config = {
      upstream: anthropic.url,
      usagePolling: { enabled: false },
      openaiBridge: {
        enabled: true,
        url: bridge.url,
        modelPattern: '^gpt-',
        connectTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        connectRetries: 0,
      },
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config,
      // undefined を返す = openaiBridge セクション・config.json が消えた状態
      reloadOpenAiBridge: async () => undefined,
    }));

    try {
      const before = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6-astra' }),
        headers: {
          authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(before.status, 200);
      assert.equal(bridgeSeen.length, 1, 'starts enabled, so the request must reach the bridge stub');

      const reloadResponse = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
      assert.equal(reloadResponse.status, 200);

      const after = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-6-astra' }),
        headers: {
          authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(after.status, 200);
      assert.equal(bridgeSeen.length, 1, 'the bridge stub must not see a second request once the section disappears');
      assert.equal(anthropicSeen.length, 1, 'the request must fall back to the Anthropic stub once the branch reverts to the default (disabled)');
    } finally {
      await close(proxy.server);
      await close(anthropic.server);
      await close(bridge.server);
    }
  });

  it('logs the openaiBridge config-warning only once at startup, not per request (regression)', async () => {
    const anthropicSeen = [];
    const anthropic = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      anthropicSeen.push({ body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    const lines = [];
    // modelPattern が不正 → resolveOpenAiBridgeSettings のフェイルセーフで無効化され、
    // warning が立つ（仕様書 4.2.2 節 b）。
    const badOpenaiBridgeConfig = {
      enabled: true,
      url: 'http://127.0.0.1:18765',
      modelPattern: '([unclosed',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
    };
    const config = {
      upstream: anthropic.url,
      usagePolling: { enabled: false },
      openaiBridge: { ...badOpenaiBridgeConfig },
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config,
      reloadOpenAiBridge: async () => badOpenaiBridgeConfig,
      logger: line => lines.push(line),
    }));
    const countConfigWarnings = () => lines.filter(l => /openai-bridge config-warning/.test(l)).length;

    try {
      assert.equal(countConfigWarnings(), 1, 'exactly one config-warning line must be logged at startup');

      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await requestJson(`${proxy.url}/v1/messages`, {
          method: 'POST',
          body: JSON.stringify({ model: 'gpt-6-astra' }),
          headers: {
            authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
            'content-type': 'application/json',
          },
        });
        assert.equal(response.status, 200);
      }
      assert.equal(anthropicSeen.length, 3, 'the fail-safe branch must still fall back to the Anthropic stub for every request');
      assert.equal(countConfigWarnings(), 1, 'sending more requests must not repeat the per-request config-warning log line (旧実装は毎リクエスト再ログしていた)');

      const reloadResponse = await requestJson(`${proxy.url}/internal/reload`, { method: 'POST' });
      assert.equal(reloadResponse.status, 200);
      assert.equal(countConfigWarnings(), 1, 'reload must not add a second separate config-warning line; the warning is folded into the reload log line instead');
      assert.ok(lines.some(l => /openai-bridge reload/.test(l) && /warning=/.test(l)), lines.join('\n'));
    } finally {
      await close(proxy.server);
      await close(anthropic.server);
    }
  });

  it('does not log parse-error-fallback for a bodyless request, but does for a malformed non-empty body (regression)', async () => {
    const anthropicSeen = [];
    const anthropic = await listen(http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      anthropicSeen.push({ method: req.method, url: req.url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    }));
    const bridge = await listen(http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    }));

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
      now: () => 1000,
    });

    const lines = [];
    const config = {
      upstream: anthropic.url,
      usagePolling: { enabled: false },
      openaiBridge: {
        enabled: true,
        url: bridge.url,
        modelPattern: '^gpt-',
        connectTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        connectRetries: 0,
      },
    };
    const proxy = await listen(createProxyServer({
      accountManager,
      secretStore,
      config,
      logger: line => lines.push(line),
    }));

    try {
      // 本文なしの GET は無ログ（HEAD/GET相当。仕様書のテスト対象そのもの）。
      const getResponse = await requestJson(`${proxy.url}/v1/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}` },
      });
      assert.equal(getResponse.status, 200);
      assert.equal(anthropicSeen.length, 1, 'a GET with no matching model must still reach the Anthropic stub');
      assert.ok(lines.every(l => !/parse-error-fallback/.test(l)), `a bodyless GET must not log parse-error-fallback: ${lines.join('\n')}`);

      // 本文はあるが JSON として壊れているリクエストは記録する。
      const badResponse = await requestJson(`${proxy.url}/v1/messages`, {
        method: 'POST',
        body: '<<not json>>',
        headers: {
          authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`,
          'content-type': 'application/json',
        },
      });
      assert.equal(badResponse.status, 200);
      assert.ok(lines.some(l => /parse-error-fallback/.test(l)), `a malformed non-empty body must still be logged: ${lines.join('\n')}`);
    } finally {
      await close(proxy.server);
      await close(anthropic.server);
      await close(bridge.server);
    }
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
// R3-2: openaiBridge.degradeMapping の設定解決（設計書 §7.1〜§7.3・§14.1〜§14.4）
// ---------------------------------------------------------------------------

// 既存の import 文（ファイル冒頭）は1行も書き換えない（受入条件: 本ファイルの削除行が0）。
// ESM の import 宣言は位置に関係なく巻き上げられるため、追加分は別の import 文にする。
import {
  DEFAULT_OPENAI_BRIDGE,
  DISABLED_DEGRADE_MAPPING,
  logDegradeMappingConfigNotice,
  normalizeDegradeMapping,
} from '../src/openai-bridge.js';

const enabledBridgeConfig = extra => ({
  openaiBridge: { ...createDefaultConfig().openaiBridge, enabled: true, ...extra },
});

describe('normalizeDegradeMapping (R3-2 / 設計書 §7.3)', () => {
  it('falls back to the disabled defaults when the section is absent or is not an object', () => {
    // セクションが無い／型が違う、のいずれでも「無効」に倒れる（§7.3-3）。
    for (const raw of [undefined, null, false, 0, '', 'degradeMapping', 42, [], [{ enabled: true }]]) {
      assert.equal(
        normalizeDegradeMapping(raw),
        DISABLED_DEGRADE_MAPPING,
        `${JSON.stringify(raw) ?? String(raw)} must resolve to the shared disabled constant`,
      );
    }
  });

  it('normalizes every key when the section is fully specified', () => {
    assert.deepEqual(
      normalizeDegradeMapping({
        enabled: true,
        bothUnusableStatus: 529,
        gptPoolUnusableTtlMs: 30000,
        codexStatusUrl: 'http://127.0.0.1:18765/healthz',
        codexStatusTimeoutMs: 800,
      }),
      {
        enabled: true,
        bothUnusableStatus: 529,
        gptPoolUnusableTtlMs: 30000,
        codexStatusUrl: 'http://127.0.0.1:18765/healthz',
        codexStatusTimeoutMs: 800,
        notices: [],
      },
    );
  });

  it('keeps the remaining defaults when only enabled is written (R-14 の浅いマージの罠)', () => {
    // DEFAULT_OPENAI_BRIDGE へ既定を置いていたら、この部分指定で他のキーが
    // すべて undefined になる。専用の正規化関数を通すことでそれを避ける（§7.3-1 理由A）。
    assert.deepEqual(normalizeDegradeMapping({ enabled: true }), {
      enabled: true,
      bothUnusableStatus: 403,
      gptPoolUnusableTtlMs: 60000,
      codexStatusUrl: null,
      codexStatusTimeoutMs: 1500,
      notices: [],
    });
  });

  it('falls back to the safe side for wrong types and out-of-range values', () => {
    // enabled は真偽値の true だけを受け付ける（判定式を1つに保つ＝§7.3-3）。
    for (const value of ['true', 1, 'yes', {}, [], null]) {
      assert.equal(normalizeDegradeMapping({ enabled: value }).enabled, false, `enabled:${JSON.stringify(value)}`);
    }
    // bothUnusableStatus は 403（明示停止）か 529（退避継続）のみ。不正値は 403 側へ倒す。
    for (const value of [500, 429, '529', null, undefined, true]) {
      assert.equal(normalizeDegradeMapping({ enabled: true, bothUnusableStatus: value }).bothUnusableStatus, 403);
    }
    assert.equal(normalizeDegradeMapping({ enabled: true, bothUnusableStatus: 529 }).bothUnusableStatus, 529);
    // ミリ秒は有限の正数のみ。0・負・NaN・Infinity・文字列はすべて既定へ戻す。
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000', null, {}]) {
      assert.equal(normalizeDegradeMapping({ gptPoolUnusableTtlMs: value }).gptPoolUnusableTtlMs, 60000);
      assert.equal(normalizeDegradeMapping({ codexStatusTimeoutMs: value }).codexStatusTimeoutMs, 1500);
    }
    assert.equal(normalizeDegradeMapping({ codexStatusTimeoutMs: 1 }).codexStatusTimeoutMs, 1, '有限の正数は通す');
  });

  it('accepts only loopback urls for codexStatusUrl', () => {
    // openaiBridge.url と同じ規律（§7.2）。非ループバックは警告つきで null と同じ扱いにする。
    for (const value of ['http://127.0.0.1:18765/healthz', 'http://localhost:18765/healthz']) {
      assert.equal(normalizeDegradeMapping({ codexStatusUrl: value }).codexStatusUrl, value);
    }
    for (const value of ['http://evil.example.com/healthz', 'https://1.2.3.4/healthz', 'not a url', '', 123, null]) {
      assert.equal(
        normalizeDegradeMapping({ codexStatusUrl: value }).codexStatusUrl,
        null,
        `${JSON.stringify(value)} must not be fetched`,
      );
    }
  });

  it('accepts the IPv6 loopback for codexStatusUrl (bracketed and expanded)', () => {
    // new URL('http://[::1]:18765/healthz').hostname は角括弧つきの '[::1]' を返すため、
    // 素の '::1' を持つ許可リストと突き合わせる前に角括弧を外す必要がある
    // （修正前はこの URL が黙って null になっていた）。
    for (const value of [
      'http://[::1]:18765/healthz',
      'http://[::1]/healthz',
      // WHATWG URL が '[::1]' へ正規化する展開形。許可リストの素の '::1' と一致する。
      'http://[0:0:0:0:0:0:0:1]:18765/healthz',
    ]) {
      assert.equal(normalizeDegradeMapping({ codexStatusUrl: value }).codexStatusUrl, value, value);
      assert.deepEqual(normalizeDegradeMapping({ codexStatusUrl: value }).notices, [], value);
    }
    // ループバック以外の IPv6 は拒否側へ倒す。'[::]'（未指定アドレス）と
    // '[::ffff:127.0.0.1]'（IPv4 射影。hostname は '[::ffff:7f00:1]' へ正規化される）も
    // 許可リストに無いので通さない。
    for (const value of [
      'http://[fe80::1]:18765/healthz',
      'http://[2001:db8::1]/healthz',
      'http://[::]/healthz',
      'http://[::ffff:127.0.0.1]/healthz',
    ]) {
      assert.equal(normalizeDegradeMapping({ codexStatusUrl: value }).codexStatusUrl, null, value);
    }
  });

  it('records why a codexStatusUrl was dropped instead of discarding it silently', () => {
    // 非ループバックを黙って捨てない。理由は notices に載せ、
    // 起動時と reload 時に logDegradeMappingConfigNotice() が1行で出す（§7.2）。
    for (const value of ['http://evil.example.com/healthz', 'https://1.2.3.4/healthz', 'http://[fe80::1]/healthz']) {
      assert.deepEqual(
        normalizeDegradeMapping({ codexStatusUrl: value }).notices,
        ['degradeMapping.codexStatusUrl must be loopback; codex status section disabled'],
        value,
      );
    }
    for (const value of ['not a url', '', 123, {}, true]) {
      assert.deepEqual(
        normalizeDegradeMapping({ codexStatusUrl: value }).notices,
        ['degradeMapping.codexStatusUrl is not a usable url; codex status section disabled'],
        JSON.stringify(value) ?? String(value),
      );
    }
    // 未指定は既定そのものなので通知しない（既定構成で1行も出さないための条件）。
    for (const raw of [{}, { codexStatusUrl: null }, { codexStatusUrl: undefined }, { enabled: true }]) {
      assert.deepEqual(normalizeDegradeMapping(raw).notices, [], JSON.stringify(raw));
    }
    assert.deepEqual(DISABLED_DEGRADE_MAPPING.notices, []);
    // notices も凍結する（消費側が実行時に書き換えられない）。
    assert.equal(Object.isFrozen(normalizeDegradeMapping({ codexStatusUrl: 'http://evil.example.com' }).notices), true);
  });

  it('returns a frozen section so a consumer cannot flip enabled at runtime', () => {
    const normalized = normalizeDegradeMapping({ enabled: false });
    assert.equal(Object.isFrozen(normalized), true);
    assert.throws(() => { 'use strict'; normalized.enabled = true; }, TypeError);
    assert.equal(normalized.enabled, false);
  });
});

describe('resolveOpenAiBridgeSettings degradeMapping (R3-2 / 設計書 §7.3-2)', () => {
  it('exposes the normalized section on the enabled path', () => {
    const settings = resolveOpenAiBridgeSettings(enabledBridgeConfig({
      degradeMapping: { enabled: true, bothUnusableStatus: 529 },
    }));
    assert.equal(settings.enabled, true);
    assert.equal(settings.warning, null);
    assert.deepEqual(settings.degradeMapping, {
      enabled: true,
      bothUnusableStatus: 529,
      gptPoolUnusableTtlMs: 60000,
      codexStatusUrl: null,
      codexStatusTimeoutMs: 1500,
      notices: [],
    });
  });

  it('exposes the shared disabled section on the enabled path when nothing is written', () => {
    const settings = resolveOpenAiBridgeSettings(enabledBridgeConfig());
    assert.equal(settings.enabled, true);
    assert.equal(settings.degradeMapping, DISABLED_DEGRADE_MAPPING);
  });
});

describe('OSS 独立性', () => {
  it('degradeMapping 未指定なら無効になる', () => {
    // 新規インストールの config.json（createDefaultConfig）にはセクションが無い。
    // 生成物を1バイトも変えないため、既定側にキーを足していないことも固定する（§7.3-1 理由B）。
    assert.equal(createDefaultConfig().openaiBridge.degradeMapping, undefined);
    assert.equal(DEFAULT_OPENAI_BRIDGE.degradeMapping, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_OPENAI_BRIDGE, 'degradeMapping'), false);

    const fromDefaults = resolveOpenAiBridgeSettings(createDefaultConfig());
    assert.equal(fromDefaults.degradeMapping, DISABLED_DEGRADE_MAPPING, 'セクションが無い');
    assert.equal(fromDefaults.degradeMapping.enabled, false);

    // キーが無い／型が違う場合も同じく無効へ倒れる。
    assert.equal(resolveOpenAiBridgeSettings(enabledBridgeConfig({ degradeMapping: {} })).degradeMapping.enabled, false);
    assert.equal(
      resolveOpenAiBridgeSettings(enabledBridgeConfig({ degradeMapping: 'enabled' })).degradeMapping,
      DISABLED_DEGRADE_MAPPING,
    );
    assert.equal(resolveOpenAiBridgeSettings({}).degradeMapping, DISABLED_DEGRADE_MAPPING);
    assert.equal(resolveOpenAiBridgeSettings(undefined).degradeMapping, DISABLED_DEGRADE_MAPPING);
  });

  it('fail-safe 3経路では degradeMapping も無効になる', () => {
    // 設定を解釈できなかったのだから、隣接する新機能も信用しない（§7.3-2）。
    const degradeMapping = { enabled: true, bothUnusableStatus: 529, gptPoolUnusableTtlMs: 1000 };
    const failSafeCases = [
      ['modelPattern', { modelPattern: '([unclosed' }, /modelPattern/],
      ['url', { url: 'not-a-url' }, /openaiBridge\.url/],
      ['non-loopback', { url: 'http://evil.example.com:80' }, /loopback/],
    ];
    for (const [name, override, warningPattern] of failSafeCases) {
      const settings = resolveOpenAiBridgeSettings(enabledBridgeConfig({ ...override, degradeMapping }));
      assert.equal(settings.enabled, false, `${name}: 分岐は無効化される`);
      assert.match(settings.warning, warningPattern, name);
      assert.equal(settings.degradeMapping, DISABLED_DEGRADE_MAPPING, `${name}: 写像だけが生き残ってはならない`);
      assert.equal(settings.degradeMapping.enabled, false, name);
    }
  });

  it('openaiBridge 無効でも degradeMapping は正規化される', () => {
    // 構成①（ClaudeRotator 単体）の成立。(b) の 529 写像は bridge を必要としない（§14.2）。
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: {
        enabled: false,
        degradeMapping: { enabled: true, gptPoolUnusableTtlMs: 30000 },
      },
    });
    assert.equal(settings.enabled, false, 'gpt-* の分岐そのものは起きない');
    assert.equal(settings.warning, null, 'fail-safe ではないので warning は立てない');
    assert.equal(settings.degradeMapping.enabled, true);
    assert.equal(settings.degradeMapping.gptPoolUnusableTtlMs, 30000);
    assert.equal(settings.degradeMapping.bothUnusableStatus, 403);

    // warning に通知を載せていないこと（載せると reason が 'disabled' から 'parse-error' へ
    // 変わり、gpt-* 要求ごとに parse-error-fallback のログが増える）。
    const routing = shouldRouteToOpenAiBridge(Buffer.from('{"model":"gpt-6-astra"}'), settings);
    assert.equal(routing.route, false);
    assert.equal(routing.reason, 'disabled', 'degradeMapping を有効にしても現行のログ分類を変えない');
  });
});

describe('degradeMapping の config-notice (設計書 §7.3-4)', () => {
  it('logs exactly one notice line when degradeMapping is enabled without openaiBridge', () => {
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: { enabled: false, degradeMapping: { enabled: true } },
    });
    const lines = [];
    const returned = logDegradeMappingConfigNotice(settings, line => lines.push(line));
    assert.equal(lines.length, 1, '警告は1行だけ');
    assert.deepEqual(returned, lines, '返り値は実際に出した行の配列');
    assert.match(
      lines[0],
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge config-notice degradeMapping enabled without openaiBridge; 529 mapping applies to Claude-internal fallback only$/,
    );
  });

  it('logs one line per dropped codexStatusUrl (§7.2)', () => {
    // 非ループバック URL を黙って捨てない。bridge 分岐が有効なので
    // §7.3-4 の「bridge 無しで写像だけ有効」の行は出ず、この1行だけになる。
    const settings = resolveOpenAiBridgeSettings(enabledBridgeConfig({
      degradeMapping: { enabled: true, codexStatusUrl: 'http://evil.example.com/healthz' },
    }));
    assert.equal(settings.degradeMapping.codexStatusUrl, null, '取得先としては使わない');
    const lines = [];
    const returned = logDegradeMappingConfigNotice(settings, line => lines.push(line));
    assert.equal(lines.length, 1);
    assert.deepEqual(returned, lines);
    assert.match(
      lines[0],
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge config-notice degradeMapping\.codexStatusUrl must be loopback; codex status section disabled$/,
    );
    // 利用者が書いた URL そのものはログへ転記しない。
    assert.equal(lines[0].includes('evil.example.com'), false);
  });

  it('logs both notices when the bridge is off and the codexStatusUrl is unusable', () => {
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: {
        enabled: false,
        degradeMapping: { enabled: true, codexStatusUrl: 'http://[fe80::1]:18765/healthz' },
      },
    });
    const lines = [];
    assert.equal(logDegradeMappingConfigNotice(settings, line => lines.push(line)).length, 2);
    assert.match(lines[0], /degradeMapping enabled without openaiBridge/);
    assert.match(lines[1], /degradeMapping\.codexStatusUrl must be loopback/);
  });

  it('logs nothing for a loopback IPv6 codexStatusUrl', () => {
    // 修正前は [::1] が黙って捨てられていた。いまは値が残り通知も出ない。
    const settings = resolveOpenAiBridgeSettings(enabledBridgeConfig({
      degradeMapping: { enabled: true, codexStatusUrl: 'http://[::1]:18765/healthz' },
    }));
    assert.equal(settings.degradeMapping.codexStatusUrl, 'http://[::1]:18765/healthz');
    assert.deepEqual(logDegradeMappingConfigNotice(settings, () => assert.fail('must not log')), []);
  });

  it('logs nothing when the notice does not apply', () => {
    const cases = [
      ['bridge も写像も有効', resolveOpenAiBridgeSettings(enabledBridgeConfig({ degradeMapping: { enabled: true } }))],
      ['写像が無効', resolveOpenAiBridgeSettings({ openaiBridge: { enabled: false } })],
      ['既定（新規インストール）', resolveOpenAiBridgeSettings(createDefaultConfig())],
      ['fail-safe 経路', resolveOpenAiBridgeSettings(enabledBridgeConfig({
        modelPattern: '([unclosed',
        degradeMapping: { enabled: true },
      }))],
    ];
    for (const [name, settings] of cases) {
      const lines = [];
      assert.deepEqual(logDegradeMappingConfigNotice(settings, line => lines.push(line)), [], name);
      assert.deepEqual(lines, [], name);
    }
  });

  it('does not throw without a logger or without settings', () => {
    const settings = resolveOpenAiBridgeSettings({ openaiBridge: { enabled: false, degradeMapping: { enabled: true } } });
    assert.match(logDegradeMappingConfigNotice(settings)[0], /config-notice/, 'logger 省略でも行を返す');
    assert.deepEqual(logDegradeMappingConfigNotice(undefined, () => { throw new Error('must not log'); }), []);
    assert.deepEqual(logDegradeMappingConfigNotice({}, () => { throw new Error('must not log'); }), []);
    // 正規化を通っていない手組みの settings（notices 欠落）でも投げない。この関数は
    // createProxyServer の起動経路で呼ばれるため、例外は起動そのものを壊す。
    assert.deepEqual(logDegradeMappingConfigNotice({ enabled: true, degradeMapping: { enabled: true } }), []);
    assert.deepEqual(
      logDegradeMappingConfigNotice({ enabled: false, degradeMapping: { enabled: true } }).length,
      1,
      'notices が無くても §7.3-4 の行は出る',
    );
  });
});

describe('POST /internal/reload と degradeMapping', () => {
  // src/proxy-server.js:327-336 の再読込手順（config.openaiBridge を差し替えてから
  // resolveOpenAiBridgeSettings を呼び直す）をそのまま再現する。degradeMapping は
  // openaiBridge セクションの下にあるので、src/cli.js:370 の reloadOpenAiBridge にも
  // reload の配線にも1行も足さずに反映される（§7.1）。解決済みの settings は
  // createProxyServer の外へ露出しないため、HTTP 経由ではなくこの単位で固定する。
  const applyReload = (config, nextOpenaiBridge) => {
    config.openaiBridge = nextOpenaiBridge !== undefined ? nextOpenaiBridge : { ...DEFAULT_OPENAI_BRIDGE };
    return resolveOpenAiBridgeSettings(config);
  };

  it('picks up a degradeMapping change on reload without touching cli/config wiring', () => {
    const config = { openaiBridge: { ...createDefaultConfig().openaiBridge, enabled: true } };
    assert.equal(resolveOpenAiBridgeSettings(config).degradeMapping.enabled, false, '起動時は無効');

    const enabled = applyReload(config, {
      ...config.openaiBridge,
      degradeMapping: { enabled: true, bothUnusableStatus: 529 },
    });
    assert.equal(enabled.degradeMapping.enabled, true, 'reload で有効になる');
    assert.equal(enabled.degradeMapping.bothUnusableStatus, 529);
    assert.equal(enabled.degradeMapping.gptPoolUnusableTtlMs, 60000);

    // 制約3（可逆性）: プロセスを止めずに1分以内で現行挙動へ戻せること。
    const reverted = applyReload(config, { ...config.openaiBridge, degradeMapping: { enabled: false } });
    assert.equal(reverted.degradeMapping.enabled, false, 'reload で即座に無効へ戻せる');
  });

  it('reverts to the disabled degradeMapping once the openaiBridge section disappears', () => {
    const config = {
      openaiBridge: {
        ...createDefaultConfig().openaiBridge,
        enabled: true,
        degradeMapping: { enabled: true },
      },
    };
    assert.equal(resolveOpenAiBridgeSettings(config).degradeMapping.enabled, true);

    // reloadOpenAiBridge が undefined を返す＝セクション・config.json が消えた状態。
    const afterRemoval = applyReload(config, undefined);
    assert.equal(afterRemoval.enabled, false);
    assert.equal(afterRemoval.degradeMapping, DISABLED_DEGRADE_MAPPING);
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

// ---------------------------------------------------------------------------
// R3-3: outcome の分岐（設計書 §9.4）とログ meta の併記（§9.3）
//
// 既存ケースは1件も削除・書換しない（§14.4）。以下はすべて新規追加である。
// ---------------------------------------------------------------------------

// 接続確立前で止まったままの upstream。socket は 'connecting' のまま 'connect' を
// 永久に発火しないので、connectTimer だけが発火する（＝bridge-connect-timeout）。
function createStalledUpstream() {
  let callback = null;
  let upstream = null;
  const requestImpl = (options, cb) => {
    callback = cb;
    upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.destroy = () => { upstream.destroyed = true; };
    upstream.end = () => {
      process.nextTick(() => {
        const socket = new EventEmitter();
        socket.connecting = true;
        upstream.emit('socket', socket);
      });
    };
    return upstream;
  };
  return { requestImpl, getCallback: () => callback, getUpstream: () => upstream };
}

function bridgeSettings(overrides = {}) {
  return resolveOpenAiBridgeSettings({
    openaiBridge: {
      enabled: true,
      url: 'http://127.0.0.1:1',
      modelPattern: '^gpt-',
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      connectRetries: 0,
      // §9.3 の追記は写像機能を有効にした構成だけの挙動（§14.4）。既定は無効なので、
      // 追記を検証するケースではここで明示的に有効化する。
      degradeMapping: { enabled: true },
      ...overrides,
    },
  });
}

// ログ行の outcome=... 以降（追記された meta の部分）だけを取り出す。
function metaTail(line, outcome) {
  const marker = `outcome=${outcome}`;
  const at = line.indexOf(marker);
  return at === -1 ? null : line.slice(at + marker.length);
}

describe('forwardToOpenAiBridge outcome branches (設計書 §9.4)', () => {
  it('reports bridge-unreachable with the real error code when the connection is refused', async () => {
    // 接続そのものが確立できない＝codex-rotator のプロセスが動いていない（§9.4）。
    const settings = bridgeSettings({ connectTimeoutMs: 500, idleTimeoutMs: 500 });
    const lines = [];
    const front = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await forwardToOpenAiBridge({ req, res, body: Buffer.concat(chunks), model: 'gpt-6-astra', settings, logger: l => lines.push(l) });
    });
    await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":"gpt-6-astra"}',
    });
    const body = await response.json();
    front.close();

    assert.equal(response.status, 403, 'HTTP 応答は現行のまま（§8.9）');
    assert.match(body.error.message, /openai-bridge unreachable: connection refused/, '応答本文の文言は変えない');
    const line = lines.find(l => /outcome=bridge-unreachable/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.match(line, /degradeReason=bridge_unreachable/, '不達のときは rotator 自身が degradeReason を入れる（§9.3）');
    assert.match(line, /errorCode=ECONNREFUSED/, 'ログにはエラー種別を残す');
    assert.match(line, /errorMessage=connect_ECONNREFUSED/, 'message も残す（空白は _ に潰す）');
  });

  it('keeps ENOTFOUND distinguishable in the log while the response body stays rounded (丸めの解消)', async () => {
    // 現行は ENOTFOUND / ECONNRESET / EPIPE をすべて応答本文の 'connection refused' へ
    // 丸めていた。応答本文は不変のまま、ログの errorCode で種別を判別できるようにする。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings(), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getUpstream().emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.invalid'), { code: 'ENOTFOUND' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-unreachable');
    assert.equal(result.status, 403);
    assert.equal(res.statusCode, 403);
    const line = lines.find(l => /outcome=bridge-unreachable/.test(l));
    assert.match(line, /errorCode=ENOTFOUND/, 'ログでは ECONNREFUSED と ENOTFOUND を取り違えない');
    assert.match(line, /errorMessage=getaddrinfo_ENOTFOUND_nowhere.invalid/);
  });

  it('reports bridge-connect-timeout when the socket never finishes connecting', async () => {
    // ポートは開いているが受け付けられていない状態（§9.4）。bridge-unreachable から分離する。
    const stalled = createStalledUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const result = await forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings({ connectTimeoutMs: 20, idleTimeoutMs: 5000 }),
      logger: l => lines.push(l), httpRequestImpl: stalled.requestImpl,
    });

    assert.equal(result.outcome, 'bridge-connect-timeout');
    assert.equal(result.status, 403, 'HTTP 応答は現行のまま 403（§8.9）');
    assert.equal(stalled.getUpstream().destroyed, true);
    const line = lines.find(l => /outcome=bridge-connect-timeout/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.match(line, /status=403/);
    assert.match(line, /degradeReason=bridge_connect_timeout/);
    assert.ok(lines.every(l => !/outcome=bridge-unreachable/.test(l)), '接続拒否と取り違えない');
  });

  it('reports bridge-idle-timeout when the bridge goes silent after starting a 200 (§8.10)', async () => {
    // 「200 を受け取った後にチャンクが 30,000ms 来ない」ケース。ここでは注入した
    // idleTimeoutMs=25ms が本番の 30,000ms の役を務める（タイマーは設定注入で短縮する）。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings({ idleTimeoutMs: 25 }), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getCallback()(fakeUpstreamResponse(200, { 'content-type': 'text/event-stream' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-idle-timeout', '無音は stream-error ではなく idle-timeout（§8.10）');
    assert.equal(result.status, null, 'ヘッダ送出後は 403 を合成できず切断するだけになる');
    assert.equal(res.destroyed, true);
    const line = lines.find(l => /outcome=bridge-idle-timeout/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.match(line, /status=-/);
    assert.match(line, /degradeReason=bridge_idle_timeout/);
  });

  it('still reports bridge-idle-timeout (403) when nothing arrives before the response head', async () => {
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const result = await forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings({ idleTimeoutMs: 20 }), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });

    assert.equal(result.outcome, 'bridge-idle-timeout');
    assert.equal(result.status, 403);
    assert.equal(res.statusCode, 403);
    assert.match(lines.find(l => /outcome=bridge-idle-timeout/.test(l)), /degradeReason=bridge_idle_timeout/);
  });

  it('reports bridge-stream-error when the upstream response breaks mid-stream', async () => {
    // ストリーム途中の実障害（ECONNRESET 等）。無音（idle-timeout）とは別物である（§9.4）。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings(), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    const upstreamRes = fakeUpstreamResponse(200, { 'content-type': 'text/event-stream' });
    manual.getCallback()(upstreamRes);
    upstreamRes.emit('data', Buffer.from('event: message_start\n\n'));
    upstreamRes.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-stream-error');
    assert.equal(result.status, null);
    const line = lines.find(l => /outcome=bridge-stream-error/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.match(line, /errorCode=ECONNRESET/);
    assert.ok(lines.every(l => !/outcome=bridge-idle-timeout/.test(l)), '実障害を無音と取り違えない');
  });

  it('reports bridge-stream-error when the upstream request errors after the head was sent', async () => {
    // EPIPE 等が応答開始後に上がる経路。現行はここも bridge-unreachable だった。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings(), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getCallback()(fakeUpstreamResponse(200, {}));
    manual.getUpstream().emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-stream-error', '応答開始後の障害は unreachable ではない');
    assert.equal(result.status, null);
    assert.match(lines.find(l => /outcome=bridge-stream-error/.test(l)), /errorCode=EPIPE/);
  });
});

describe('forwardToOpenAiBridge log meta (設計書 §9.3)', () => {
  it('appends the x-ombr-* meta in the §9.3 order, for keys that have a value only', async () => {
    const { response, lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        res.writeHead(529, {
          'Content-Type': 'application/json',
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'codex_pool_exhausted',
          'x-ombr-pool-state': 'exhausted',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-upstream-status': '429',
          'x-ombr-upstream-sent': 'yes',
          'x-ombr-cached': 'no',
          'x-ombr-account': 'pro-b',
          'x-ombr-reset-at': '2026-09-08T13:00:00Z',
          'x-ombr-primary-used-percent': '97.5',
          'x-ombr-secondary-used-percent': '12.5',
        }).end('{"type":"error"}');
      },
    });

    assert.equal(response.status, 529, '応答は1バイトも変えない（素通し）');
    const line = lines.find(l => /outcome=forwarded/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.equal(
      metaTail(line, 'forwarded'),
      ' bridgeContract=1 degradeReason=codex_pool_exhausted poolState=exhausted degradeScope=pool'
      + ' upstreamStatus=429 upstreamSent=yes bridgeCached=no accountLabel=pro-b'
      + ' resetAt=2026-09-08T13:00:00Z primaryUsedPercent=97.5 secondaryUsedPercent=12.5',
      '§9.3 の表の順序どおりに、値があるキーだけを末尾へ追記する',
    );
    assert.match(line, /status=529 durationMs=\d+ outcome=forwarded /, '既存フィールドの順序・名前・書式は変えない');
  });

  it('omits the keys the bridge did not send (partial headers)', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-ombr-contract': '1', 'x-ombr-pool-state': 'ok' }).end('{}');
      },
    });
    const line = lines.find(l => /outcome=forwarded/.test(l));
    assert.equal(metaTail(line, 'forwarded'), ' bridgeContract=1 poolState=ok');
  });

  it('drops values outside the contract enumeration instead of logging them verbatim', async () => {
    // bridge 側の不具合で識別子が混入しても状態にもログにも残さない（契約 §C3.4）。
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'someone@example.com',
          'x-ombr-account': 'someone@example.com',
        }).end('{}');
      },
    });
    const line = lines.find(l => /outcome=forwarded/.test(l));
    assert.equal(metaTail(line, 'forwarded'), ' bridgeContract=1 degradeReason=unknown accountLabel=<invalid>');
    assert.ok(!/example\.com/.test(line), '列挙外の値は原文のままログへ出さない');
  });

  it('logs a line identical to the current format when the bridge sends no x-ombr-* header (不変性)', async () => {
    // §9.2: 値が1つも無ければ行は現行とバイト単位で同一になる。
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      bridgeHandler: (req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'),
    });
    const line = lines.find(l => /openai-bridge/.test(l));
    assert.match(
      line,
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=200 durationMs=\d+ outcome=forwarded$/,
      '契約ヘッダが無い応答では追記が1つも無く、現行と完全に同じ行になる',
    );
  });

  it('logs a line identical to the current format for client-abort (不変性)', async () => {
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings(), logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    res.emit('close');
    const result = await done;

    assert.equal(result.outcome, 'client-abort');
    assert.match(
      lines.find(l => /openai-bridge/.test(l)),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=- durationMs=\d+ outcome=client-abort$/,
    );
  });
});

describe('OSS 独立性 > degradeMapping 無効時に openai-bridge のログ行が現行と同一である (§14.4)', () => {
  // 現行（3ae4aeb 時点）のログ行の形。差分は outcome 名の改名だけであること。
  const CURRENT_FORMAT = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=\d+ durationMs=\d+ outcome=forwarded$/;

  it('appends nothing when degradeMapping is disabled, even if the bridge sends every x-ombr-* header', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      // settingsOverride を渡さない＝既定（degradeMapping 無効）。OSS 利用者の構成。
      bridgeHandler: (req, res) => {
        res.writeHead(529, {
          'Content-Type': 'application/json',
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'codex_pool_exhausted',
          'x-ombr-pool-state': 'exhausted',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-upstream-status': '429',
        }).end('{"type":"error"}');
      },
    });
    const line = lines.find(l => /openai-bridge/.test(l));
    assert.match(line, CURRENT_FORMAT, '無効時は追記フィールドが1つも出ない（ログ行の文字列一致）');
  });

  it('appends nothing for a failure outcome either when degradeMapping is disabled', async () => {
    // degradeReason=bridge_* / errorCode / errorMessage も追記であり、無効時は出さない
    // （§9.3 は無効時にも出すとは定めていないので安全側へ倒す）。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req, res, body: Buffer.from('{"model":"gpt-6-astra"}'), model: 'gpt-6-astra',
      settings: bridgeSettings({ degradeMapping: undefined }),
      logger: l => lines.push(l), httpRequestImpl: manual.requestImpl,
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getUpstream().emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.invalid'), { code: 'ENOTFOUND' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-unreachable');
    assert.match(
      lines.find(l => /openai-bridge/.test(l)),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=403 durationMs=\d+ outcome=bridge-unreachable$/,
      '無効時は degradeReason も errorCode も出さない',
    );
  });

  it('appends nothing when x-ombr-contract is missing, even with degradeMapping enabled (契約 §C3.7-1)', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        // 契約版を名乗らない bridge。他の x-ombr-* が付いていても信用しない。
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-ombr-pool-state': 'ok',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-account': 'pro-b',
        }).end('{}');
      },
    });
    assert.match(lines.find(l => /openai-bridge/.test(l)), CURRENT_FORMAT);
  });

  it('appends the meta once the bridge declares x-ombr-contract and degradeMapping is enabled', async () => {
    const { lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'x-ombr-contract': '1', 'x-ombr-pool-state': 'ok' }).end('{}');
      },
    });
    assert.equal(metaTail(lines.find(l => /outcome=forwarded/.test(l)), 'forwarded'), ' bridgeContract=1 poolState=ok');
  });
});

// ---------------------------------------------------------------------------
// R3-4: GPT プール状態の学習を配線する（設計書 §11.1 R3-4・§8.6、契約 v1.4 §C10.3）
//
// 学習は応答ヘッダの受領点で完結し、**応答は1バイトも変えない**（403 書換は R4-1）。
// 既存ケースは1件も削除・書換しない（§14.4）。以下はすべて新規追加である。
// 既存の import 文は書き換えず、追加分は別の import 文にする（ESM は巻き上げられる）。
// ---------------------------------------------------------------------------

import { createGptPoolState } from '../src/degrade-state.js';

// 既存の callThroughRotator（:143）は1行も変えずに残し、gptPoolState を渡す経路だけを
// 別のヘルパとして足す。偽 bridge は実 TCP で立てる（既存ヘルパと同じ流儀）。
async function callWithPoolState({ bridgeHandler, requestBody, settingsOverride = {}, gptPoolState = null }) {
  const { server: bridge, port } = await startFakeBridge(bridgeHandler);
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      enabled: true,
      url: `http://127.0.0.1:${port}`,
      modelPattern: '^gpt-',
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      connectRetries: 0,
      ...settingsOverride,
    },
  });
  const lines = [];
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await forwardToOpenAiBridge({
      req,
      res,
      body,
      model: safeParseModel(body),
      settings,
      logger: line => lines.push(line),
      // 未指定＝現行と同一の経路であることを保つため、渡すときだけキーを足す。
      ...(gptPoolState ? { gptPoolState } : {}),
    });
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
  return { response, text, lines };
}

// bridge が「契約ヘッダを1つも付けない」応答を返すハンドラ。契約 §C10.3 T9 により
// 学習は起きないので、この応答を挟むと「そのとき保持している状態」をログで観測できる。
function respondWithoutContract(req, res) {
  req.resume();
  res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
}

function contractHandler(status, headers, body = '{"type":"error"}') {
  return (req, res) => {
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-ombr-contract': '1', ...headers }).end(body);
  };
}

describe('forwardToOpenAiBridge > GPT プール状態の学習 (R3-4 / 契約 §C10.3)', () => {
  it('T2: learns available for both keys from a 200 with pool-state ok', async () => {
    const gptPoolState = createGptPoolState({ now: () => 1000 });
    const { response, text, lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(200, { 'x-ombr-pool-state': 'ok', 'x-ombr-account': 'pro-b' }, '{"ok":true}'),
    });

    assert.equal(response.status, 200, '応答は1バイトも変えない');
    assert.equal(text, '{"ok":true}');
    const view = gptPoolState.read('gpt-6-astra');
    assert.equal(view.pool.state, 'available');
    assert.equal(view.model.state, 'available');
    assert.match(lines.find(l => /outcome=forwarded/.test(l)), /gptPoolState=available gptModelState=available/);
  });

  it('T3: learns (pool)=unusable with reason and resetAt from a 529 scope=pool exhausted', async () => {
    const gptPoolState = createGptPoolState({ now: () => Date.parse('2026-09-08T12:00:00Z') });
    const { response, text, lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-upstream-status': '429',
        'x-ombr-reset-at': '2026-09-08T13:00:00Z',
      }),
    });

    assert.equal(response.status, 529, 'この段階では書き換えない（403 書換は R4-1）');
    assert.equal(text, '{"type":"error"}', '本文もそのまま素通しする');
    const view = gptPoolState.read('gpt-6-astra');
    assert.deepEqual(
      { state: view.pool.state, reason: view.pool.reason, resetAt: view.pool.resetAt },
      { state: 'unusable', reason: 'codex_pool_exhausted', resetAt: '2026-09-08T13:00:00Z' },
    );
    assert.equal(view.model.state, 'unknown', '(pool, model) は変えない');
    assert.match(lines.find(l => /outcome=forwarded/.test(l)), /gptPoolState=unusable gptModelState=unknown/);
  });

  it('T4: a 403 scope=model no-account-for-model marks only (pool, model) unusable', async () => {
    const gptPoolState = createGptPoolState({ now: () => 1000 });
    // 先に 200 を1回通して (pool)=available を学習させ、「不変」を意味のある形で検査する。
    await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(200, { 'x-ombr-pool-state': 'ok' }, '{}'),
    });
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'available');

    const { response } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(403, {
        'x-ombr-degrade-reason': 'codex_no_account_for_model',
        'x-ombr-degrade-scope': 'model',
        'x-ombr-pool-state': 'no-account-for-model',
      }),
    });

    assert.equal(response.status, 403, '応答は素通し');
    const view = gptPoolState.read('gpt-6-astra');
    assert.equal(view.model.state, 'unusable');
    assert.equal(view.model.reason, 'codex_no_account_for_model');
    assert.equal(view.pool.state, 'available', '(pool) は 403 書換の根拠にならないので変えない');
    assert.equal(gptPoolState.read('gpt-5.6-sol').model.state, 'unknown', '他モデルへは波及しない');
  });

  it('T5: pool-state degraded (codex_attempt_limit) changes nothing and does not extend an existing unusable', async () => {
    const gptPoolState = createGptPoolState({ now: () => Date.parse('2026-09-08T12:00:00Z') });
    await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-reset-at': '2026-09-08T13:00:00Z',
      }),
    });

    await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_attempt_limit',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'degraded',
        'x-ombr-reset-at': '2026-09-08T23:00:00Z',
      }),
    });

    const view = gptPoolState.read('gpt-6-astra');
    assert.equal(view.pool.state, 'unusable', '試行上限では unusable を解除しない');
    assert.equal(view.pool.reason, 'codex_pool_exhausted', '理由を上書きしない');
    assert.equal(view.pool.resetAt, '2026-09-08T13:00:00Z', 'resetAt を延命しない');
  });

  it('T9: learns nothing from a response without x-ombr-* headers (契約ヘッダなし → unknown のまま)', async () => {
    const gptPoolState = createGptPoolState({ now: () => 1000 });
    const { response, lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: respondWithoutContract,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(gptPoolState.snapshot().pool, { state: 'unknown', reason: null, resetAt: null, learnedAt: null });
    assert.equal(gptPoolState.read('gpt-6-astra').model.state, 'unknown');
    assert.equal(
      metaTail(lines.find(l => /outcome=forwarded/.test(l)), 'forwarded'),
      ' gptPoolState=unknown gptModelState=unknown',
      '契約由来のフィールドは1つも出ず、保持している状態だけが載る',
    );
  });

  it('T10: scope=account touches neither key (契約違反の応答でも安全側へ倒す)', async () => {
    const gptPoolState = createGptPoolState({ now: () => 1000 });
    const { response } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_account_exhausted',
        'x-ombr-degrade-scope': 'account',
        'x-ombr-pool-state': 'exhausted',
      }),
    });

    assert.equal(response.status, 529, '529 のまま素通しする');
    const view = gptPoolState.read('gpt-6-astra');
    assert.equal(view.pool.state, 'unknown');
    assert.equal(view.model.state, 'unknown');
  });

  it('T8: an unreachable bridge changes nothing that was already learned', async () => {
    const gptPoolState = createGptPoolState({ now: () => Date.parse('2026-09-08T12:00:00Z') });
    await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_needs_login',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'needs-login',
      }),
    });
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unusable');

    // 不達（S1・S2a・S2b）は状態を変えない。ログには保持中の値が載る（§9.5(d)）。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req,
      res,
      body: Buffer.from('{"model":"gpt-6-astra"}'),
      model: 'gpt-6-astra',
      settings: bridgeSettings(),
      logger: line => lines.push(line),
      httpRequestImpl: manual.requestImpl,
      gptPoolState,
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getUpstream().emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const result = await done;

    assert.equal(result.outcome, 'bridge-unreachable');
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unusable', '不達では学習も解除もしない');
    assert.match(lines.find(l => /outcome=bridge-unreachable/.test(l)), /gptPoolState=unusable gptModelState=unknown/);
  });

  it('T6: releases the unusable state once resetAt has passed (時刻注入)', async () => {
    let clock = Date.parse('2026-09-08T12:00:00Z');
    const gptPoolState = createGptPoolState({ now: () => clock });
    await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
        'x-ombr-reset-at': '2026-09-08T13:00:00Z',
      }),
    });
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unusable');

    clock = Date.parse('2026-09-08T13:00:01Z');
    const { lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: respondWithoutContract,
    });

    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unknown', 'resetAt 到来で unknown へ戻る');
    assert.match(lines.find(l => /outcome=forwarded/.test(l)), /gptPoolState=unknown/);
  });

  it('T7: releases an unusable without resetAt after gptPoolUnusableTtlMs (時刻注入)', async () => {
    let clock = 1_000_000;
    const gptPoolState = createGptPoolState({ now: () => clock, unusableTtlMs: 60000 });
    const exhausted = contractHandler(529, {
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
    });
    const first = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: exhausted,
    });
    assert.match(first.lines.find(l => /outcome=forwarded/.test(l)), /gptPoolState=unusable/);

    clock += 59_999;
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unusable', 'TTL 到来前は保持する');

    clock += 1;
    const { lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: respondWithoutContract,
    });
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unknown', 'TTL 到来で unknown へ戻る');
    assert.match(lines.find(l => /outcome=forwarded/.test(l)), /gptPoolState=unknown gptModelState=unknown/);
  });

  it('learns nothing while degradeMapping is disabled, even when a pool state instance is passed', async () => {
    // 設計書 §14.4: 未指定なら現行と完全に同一。生成も観測も行わないのが既定である。
    const gptPoolState = createGptPoolState({ now: () => 1000 });
    const { response, lines } = await callWithPoolState({
      gptPoolState,
      requestBody: '{"model":"gpt-6-astra"}',
      // settingsOverride を渡さない＝degradeMapping 無効（OSS 利用者の構成）。
      bridgeHandler: contractHandler(529, {
        'x-ombr-degrade-reason': 'codex_pool_exhausted',
        'x-ombr-degrade-scope': 'pool',
        'x-ombr-pool-state': 'exhausted',
      }),
    });

    assert.equal(response.status, 529);
    assert.equal(gptPoolState.read('gpt-6-astra').pool.state, 'unknown', '無効時は観測しない');
    assert.match(
      lines.find(l => /openai-bridge/.test(l)),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=529 durationMs=\d+ outcome=forwarded$/,
      '無効時のログ行は現行と文字列一致する',
    );
  });
});

describe('OSS 独立性 > gptPoolState を渡さない forwardToOpenAiBridge が現行と同一に振る舞う (§14.4)', () => {
  it('appends no gptPoolState/gptModelState field when no instance is passed', async () => {
    // degradeMapping を有効にし、bridge が契約ヘッダを full で返しても、状態を保持して
    // いない呼び出しでは追記は R3-3 時点のフィールドだけになる（1フィールドも増えない）。
    const { response, lines } = await callThroughRotator({
      requestBody: '{"model":"gpt-6-astra"}',
      settingsOverride: { degradeMapping: { enabled: true } },
      bridgeHandler: (req, res) => {
        res.writeHead(529, {
          'Content-Type': 'application/json',
          'x-ombr-contract': '1',
          'x-ombr-degrade-reason': 'codex_pool_exhausted',
          'x-ombr-pool-state': 'exhausted',
          'x-ombr-degrade-scope': 'pool',
          'x-ombr-upstream-status': '429',
        }).end('{"type":"error"}');
      },
    });

    assert.equal(response.status, 529);
    assert.equal(
      metaTail(lines.find(l => /outcome=forwarded/.test(l)), 'forwarded'),
      ' bridgeContract=1 degradeReason=codex_pool_exhausted poolState=exhausted degradeScope=pool upstreamStatus=429',
      'gptPoolState / gptModelState は保持しているときだけ載る（§9.3）',
    );
  });
});

// ---------------------------------------------------------------------------
// R4-1: (c) 両プール利用不可のときだけ bridge の 529 を 403 へ書き換える
//        （設計書 §8.7 / 契約 v1.4 §C10.5 の4条件・§C10.7）
//
// 既存ケースは1件も削除・書換しない（§14.4）。以下はすべて新規追加である。
// 偽 bridge は契約 v1.4 の状態表をそのまま返す test/helpers/fake-bridge.js を使う。
// ---------------------------------------------------------------------------

import { startFakeBridge as startContractBridge } from './helpers/fake-bridge.js';
import { buildDegradeBody, parseBridgeContract } from '../src/degrade-state.js';

// 学習した unusable が read() の期限切れ判定で消えないよう、十分に先の時刻を使う。
const FAR_FUTURE_RESET_AT = '2099-01-01T00:00:00Z';

/**
 * 契約 v1.4 のモードを返す偽 bridge を立て、forwardToOpenAiBridge を1回だけ通す。
 * Claude 側の台帳は「関数」で注入する（応答ヘッダ受領時点で評価される＝設計書 §11.1 R4-1 補足）。
 */
async function callWithLedger({
  mode,
  requestBody = '{"model":"gpt-6-astra"}',
  degradeMapping = { enabled: true },
  claudeAllUnusable = null,
  claudeResetAt = null,
  gptPoolState = createGptPoolState(),
  resetAt = FAR_FUTURE_RESET_AT,
}) {
  const bridge = await startContractBridge({ port: 0, mode, resetAt });
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      enabled: true,
      url: bridge.url,
      modelPattern: '^gpt-',
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      connectRetries: 0,
      ...(degradeMapping ? { degradeMapping } : {}),
    },
  });
  const lines = [];
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await forwardToOpenAiBridge({
      req,
      res,
      body,
      model: safeParseModel(body),
      settings,
      logger: line => lines.push(line),
      // 未指定＝現行と同一の経路であることを保つため、渡すときだけキーを足す。
      ...(gptPoolState ? { gptPoolState } : {}),
      ...(claudeAllUnusable ? { claudeAllUnusable } : {}),
      ...(claudeResetAt ? { claudeResetAt } : {}),
    });
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: requestBody,
  });
  const text = await response.text();
  front.close();
  await bridge.close();
  return { response, text, lines, gptPoolState, bridgeLine: lines.find(l => / openai-bridge model=/.test(l)) };
}

const allClaudeExhausted = () => true;
const someClaudeAvailable = () => false;

describe('forwardToOpenAiBridge > 529 → 403 の書換 (R4-1 / 設計書 §8.7)', () => {
  it('(a) rewrites the exhausted 529 to 403 permission_error when every Claude account is unusable', async () => {
    const { response, text, bridgeLine } = await callWithLedger({
      mode: 'exhausted',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 403, '両プール利用不可なので明示停止する（M-5）');
    const body = JSON.parse(text);
    assert.equal(body.error.type, 'permission_error');
    assert.equal(
      body.error.message,
      `All Claude accounts and the Codex pool are unavailable. Earliest recovery: ${FAR_FUTURE_RESET_AT}.`,
      '本文に「両方とも使えないこと」と最も早い回復見込みを入れる（§8.7）',
    );
    assert.equal(
      response.headers.get('content-length'),
      String(Buffer.byteLength(text)),
      'Content-Length は上流 529 の本文長ではなく、自作した 403 本文の長さと一致する',
    );
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('content-encoding'), null);
    // 上流の契約ヘッダ（hop-by-hop ではない）はそのまま残る＝診断のため。
    assert.equal(response.headers.get('x-ombr-pool-state'), 'exhausted');

    assert.match(bridgeLine, / status=403 /, '書き換えた後のステータスを status に出す');
    assert.equal(
      metaTail(bridgeLine, 'forwarded-mapped'),
      ' bridgeContract=1 degradeReason=codex_pool_exhausted poolState=exhausted degradeScope=pool'
      + ` upstreamStatus=429 upstreamSent=yes accountLabel=acct-a resetAt=${FAR_FUTURE_RESET_AT}`
      + ' gptPoolState=unusable gptModelState=unknown claudePoolState=all-exhausted'
      + ' mappedFrom=529 mappedFromType=overloaded_error mappedTo=403 mapReason=both_pools_unusable',
      '実際の上流ステータス（529・429）を必ず同じ行に残す（§9.1・受入条件7）',
    );
  });

  it('(b) forwards the exhausted 529 untouched while any Claude account is still usable', async () => {
    const { response, text, bridgeLine } = await callWithLedger({
      mode: 'exhausted',
      claudeAllUnusable: someClaudeAvailable,
    });

    assert.equal(response.status, 529, 'Claude が使えるなら Opus へ退避させる（素通し）');
    assert.match(text, /codex pool exhausted/, '本文は bridge のものをそのまま返す');
    assert.match(bridgeLine, /outcome=forwarded /, '書換なしの outcome は forwarded のまま');
    assert.match(bridgeLine, /gptPoolState=unusable gptModelState=unknown claudePoolState=available/);
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false, '写像していないので mapped* は出さない');
  });

  it('(c) rewrites the mixed 529 to 403 as well (§C10.7 規則2・境界の反対側)', async () => {
    const { response, text, bridgeLine } = await callWithLedger({
      mode: 'mixed',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 403, 'pool-state: mixed も書換の対象（§8.7 条件①）');
    assert.equal(JSON.parse(text).error.type, 'permission_error');
    assert.match(bridgeLine, /degradeReason=codex_pool_mixed poolState=mixed/);
    assert.match(bridgeLine, /mapReason=both_pools_unusable/);
  });

  it('(d) never rewrites nor learns from an attempt-limit 529 (pool-state: degraded)', async () => {
    const { response, text, bridgeLine, gptPoolState } = await callWithLedger({
      mode: 'attempt-limit',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 529, '未試行の口座が残っているので止めない（§C10.5 の「根拠にならないもの」）');
    assert.match(text, /codex attempt limit/);
    assert.equal(gptPoolState.snapshot().pool.state, 'unknown', 'T5: 学習もしない');
    assert.match(bridgeLine, /outcome=forwarded /);
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false);
  });

  it('(e) forwards the no-account 403 (scope=model) untouched and leaves (pool) alone', async () => {
    const { response, text, gptPoolState, bridgeLine } = await callWithLedger({
      mode: 'no-account',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 403, '元から 403 なので作り替えない（素通し）');
    assert.match(text, /no Codex account is assigned/, '本文も bridge のまま');
    assert.equal(gptPoolState.snapshot().pool.state, 'unknown', 'scope=model は (pool) を汚さない（T4）');
    assert.equal(gptPoolState.read('gpt-6-astra').model.state, 'unusable');
    assert.match(bridgeLine, /outcome=forwarded /);
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false);
  });

  it('(f) forwards the needs-login 403 untouched (§8.8: CR は素通しするだけ)', async () => {
    const { response, text, gptPoolState, bridgeLine } = await callWithLedger({
      mode: 'needs-login',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 403);
    assert.match(text, /codex login required/, '本文は bridge のまま（rotator は作り替えない）');
    assert.equal(gptPoolState.snapshot().pool.state, 'unusable', '学習だけは起きる（T3）');
    assert.match(bridgeLine, /outcome=forwarded /);
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false);
  });

  it('(g) forwards a legacy 429 without contract headers untouched (§C3.7-1)', async () => {
    const { response, text, gptPoolState, bridgeLine } = await callWithLedger({
      mode: 'legacy',
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 429, '契約前 bridge の応答は現行とまったく同じ意味に扱う');
    assert.equal(JSON.parse(text).error.type, 'rate_limit_error');
    assert.equal(gptPoolState.snapshot().pool.state, 'unknown');
    assert.equal(/bridgeContract=/.test(bridgeLine), false, '契約由来の値は1つも載せない');
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false);
  });

  it('(h) changes nothing at all while degradeMapping is disabled (§14.4)', async () => {
    // 既定の構成。gptPoolState と claudeAllUnusable を渡しても、写像機能が無効なら
    // 観測も評価も書換もログ追記も起きない。
    const { response, text, bridgeLine, gptPoolState } = await callWithLedger({
      mode: 'exhausted',
      degradeMapping: null,
      claudeAllUnusable: () => {
        throw new Error('claudeAllUnusable must not be evaluated while degradeMapping is disabled');
      },
    });

    assert.equal(response.status, 529);
    assert.match(text, /codex pool exhausted/);
    assert.equal(gptPoolState.snapshot().pool.state, 'unknown');
    assert.match(
      bridgeLine,
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z openai-bridge model=gpt-6-astra method=POST path=\/v1\/messages status=529 durationMs=\d+ outcome=forwarded$/,
      'ログ行は現行と文字列一致する（追記フィールドが1つも出ない）',
    );
  });

  it('(i) keeps the 529 as-is when bothUnusableStatus is configured to 529', async () => {
    const { response, text, bridgeLine } = await callWithLedger({
      mode: 'exhausted',
      degradeMapping: { enabled: true, bothUnusableStatus: 529 },
      claudeAllUnusable: allClaudeExhausted,
    });

    assert.equal(response.status, 529, '設定で 529 を選んだ構成では書換そのものを行わない（§8.7）');
    assert.match(text, /codex pool exhausted/, '本文も上流のまま（自作の本文へ差し替えない）');
    assert.match(bridgeLine, /outcome=forwarded /);
    assert.equal(/mapped(From|To)=/.test(bridgeLine), false);
  });
});

describe('forwardToOpenAiBridge > 書換後のイベント順序 (R4-1 / 設計書 §8.7 手順5〜7)', () => {
  // 上流応答を手で駆動して、書換の「後」に届くイベントを1つずつ確かめる。
  function driveRewrite({ upstreamHeaders, claudeAllUnusable = () => true } = {}) {
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    const lines = [];
    const done = forwardToOpenAiBridge({
      req,
      res,
      body: Buffer.from('{"model":"gpt-6-astra"}'),
      model: 'gpt-6-astra',
      settings: bridgeSettings(),
      logger: line => lines.push(line),
      httpRequestImpl: manual.requestImpl,
      gptPoolState: createGptPoolState(),
      claudeAllUnusable,
    });
    const upstreamRes = fakeUpstreamResponse(529, {
      'content-type': 'application/json',
      'Content-Length': '999',
      'content-encoding': 'gzip',
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
      'x-ombr-upstream-status': '429',
      'x-ombr-reset-at': FAR_FUTURE_RESET_AT,
      ...upstreamHeaders,
    });
    return { manual, req, res, lines, done, upstreamRes };
  }

  it('drops the upstream content-length / content-encoding / content-type and writes its own', async () => {
    const { manual, res, done, upstreamRes } = driveRewrite();
    await new Promise(resolve => setImmediate(resolve));
    manual.getCallback()(upstreamRes);

    const expected = buildDegradeBody(403, { resetAts: [FAR_FUTURE_RESET_AT] });
    assert.equal(res.statusCode, 403);
    const keys = Object.keys(res.headers).map(key => key.toLowerCase());
    assert.equal(keys.filter(key => key === 'content-length').length, 1, '大小文字違いの重複を残さない');
    assert.equal(keys.includes('content-encoding'), false, '上流の content-encoding を落とす（本文を作り替えたため）');
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.equal(
      res.headers['Content-Length'],
      String(Buffer.byteLength(expected)),
      '上流 529 の Content-Length（999）が残るとクライアントが本文を待ち続ける（§8.7 手順2）',
    );
    assert.equal(res.writableEnded, true);
    assert.equal(manual.getUpstream().destroyed, true, '上流本文は読まずに接続を畳む');
    assert.equal((await done).outcome, 'forwarded-mapped');
  });

  it('survives upstream chunks, end and errors that arrive after the rewrite', async () => {
    const { manual, res, done, upstreamRes, lines } = driveRewrite();
    await new Promise(resolve => setImmediate(resolve));
    manual.getCallback()(upstreamRes);
    const result = await done;

    // 破棄由来の 'error' を誰も受けないと未捕捉例外になり、rotator ごと落ちる（§8.7 手順6）。
    upstreamRes.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    // 'data' / 'end' を装着していないので、遅れて届くチャンクは
    // ERR_STREAM_WRITE_AFTER_END を起こす経路そのものが無い（§8.7 手順7）。
    upstreamRes.emit('data', Buffer.from('late chunk'));
    upstreamRes.emit('end');
    manual.getUpstream().emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(result.outcome, 'forwarded-mapped');
    assert.equal(result.status, 403);
    assert.deepEqual(res.writes, [], '書換後に上流のバイト列を1つも書かない');
    assert.equal(
      lines.filter(line => / openai-bridge model=/.test(line)).length,
      1,
      'finish() は1回だけ（二重ログ・二重解決なし）',
    );
  });

  it('does not rewrite and does not crash when the Claude ledger probe throws', async () => {
    // 台帳の判定で例外が出ても、未捕捉例外にせず「Claude は使える」側へ倒す（安全側）。
    const { manual, res, done, upstreamRes } = driveRewrite({
      claudeAllUnusable: () => { throw new Error('ledger unavailable'); },
    });
    await new Promise(resolve => setImmediate(resolve));
    manual.getCallback()(upstreamRes);

    assert.equal(res.statusCode, 529, '判定できないなら退避を試みる側へ倒す');
    // 素通し経路なので data / end が装着されている（上流本文をそのまま流し切る）。
    upstreamRes.emit('end');
    const result = await done;
    assert.equal(result.outcome, 'forwarded');
  });
});

// ---------------------------------------------------------------------------
// R4-1 の再検証で見つかった2件の回帰テスト（2026-09-08）
//   ① x-ombr-contract が無い・不正な応答は、過去に学習した (pool)=unusable が
//      残っていても書き換えない（契約 §C3.7-1 の後方互換原則）
//   ② 403 の本文の「最早回復時刻」は GPT 側と Claude 側の早いほうを出す
// ---------------------------------------------------------------------------

// 学習済みの (pool)=unusable を持つ状態を作る（契約 §C10.3 T3）。
function poolStateLearnedAsUnusable() {
  const gptPoolState = createGptPoolState();
  gptPoolState.observe(
    parseBridgeContract({
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
      'x-ombr-reset-at': FAR_FUTURE_RESET_AT,
    }),
    529,
    'gpt-6-astra',
  );
  assert.equal(gptPoolState.snapshot().pool.state, 'unusable', 'precondition');
  return gptPoolState;
}

/** 任意のハンドラを持つ偽 bridge を通して1回だけ転送する（契約ヘッダを自由に欠かせる）。 */
async function callHandlerWithLedger({ bridgeHandler, gptPoolState, claudeAllUnusable, claudeResetAt = null }) {
  const { server: bridge, port } = await startFakeBridge(bridgeHandler);
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      enabled: true,
      url: `http://127.0.0.1:${port}`,
      modelPattern: '^gpt-',
      connectTimeoutMs: 2000,
      idleTimeoutMs: 2000,
      connectRetries: 0,
      degradeMapping: { enabled: true },
    },
  });
  const lines = [];
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await forwardToOpenAiBridge({
      req,
      res,
      body,
      model: safeParseModel(body),
      settings,
      logger: line => lines.push(line),
      gptPoolState,
      claudeAllUnusable,
      ...(claudeResetAt ? { claudeResetAt } : {}),
    });
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"model":"gpt-6-astra"}',
  });
  const text = await response.text();
  front.close();
  bridge.close();
  return { response, text, bridgeLine: lines.find(l => / openai-bridge model=/.test(l)) };
}

// 契約ヘッダ以外は「書換の4条件を満たす」形をした 529 を返す（x-ombr-contract だけを操作する）。
function exhaustedHandlerWithContract(contractHeaderValue) {
  const body = '{"type":"error","error":{"type":"overloaded_error"}}';
  return (req, res) => {
    req.resume();
    res.writeHead(529, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(contractHeaderValue === null ? {} : { 'x-ombr-contract': contractHeaderValue }),
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
      'x-ombr-upstream-status': '429',
    }).end(body);
  };
}

describe('forwardToOpenAiBridge > 契約ヘッダの無い応答は書き換えない (R4-1 再検証①)', () => {
  for (const [label, contractHeaderValue] of [
    ['x-ombr-contract が無い', null],
    ['x-ombr-contract が不正値（abc）', 'abc'],
    ['x-ombr-contract が 0', '0'],
  ]) {
    it(`forwards the 529 untouched when ${label}, even with a learned (pool)=unusable`, async () => {
      const gptPoolState = poolStateLearnedAsUnusable();
      const { response, text, bridgeLine } = await callHandlerWithLedger({
        bridgeHandler: exhaustedHandlerWithContract(contractHeaderValue),
        gptPoolState,
        claudeAllUnusable: allClaudeExhausted,
      });

      assert.equal(response.status, 529, '契約前 bridge の応答は現行とまったく同じ意味に扱う（§C3.7-1）');
      assert.equal(JSON.parse(text).error.type, 'overloaded_error', '本文も上流のまま');
      assert.equal(/mapped(From|To)=/.test(bridgeLine), false, '過去の学習だけを根拠に書き換えない');
      assert.equal(/bridgeContract=/.test(bridgeLine), false, '契約由来の値は1つも載せない');
    });
  }
});

describe('forwardToOpenAiBridge > 403 本文の最早回復時刻 (R4-1 再検証②)', () => {
  const CLAUDE_RESET_AT = '2026-09-08T13:00:00Z';

  it('prefers the Claude side reset time when it is earlier than the Codex one', async () => {
    const { response, text } = await callWithLedger({
      mode: 'exhausted',
      claudeAllUnusable: allClaudeExhausted,
      claudeResetAt: () => CLAUDE_RESET_AT,
    });

    assert.equal(response.status, 403);
    assert.equal(
      JSON.parse(text).error.message,
      `All Claude accounts and the Codex pool are unavailable. Earliest recovery: ${CLAUDE_RESET_AT}.`,
      `GPT 側の ${FAR_FUTURE_RESET_AT} ではなく、早いほうの Claude 側を出す`,
    );
  });

  it('falls back to the Codex reset time when the Claude side cannot be determined', async () => {
    for (const claudeResetAt of [() => null, () => { throw new Error('ledger unavailable'); }]) {
      const { response, text } = await callWithLedger({
        mode: 'exhausted',
        claudeAllUnusable: allClaudeExhausted,
        claudeResetAt,
      });
      assert.equal(response.status, 403);
      assert.match(JSON.parse(text).error.message, new RegExp(`Earliest recovery: ${FAR_FUTURE_RESET_AT}\\.$`));
    }
  });
});

// Opus review NEW-1: http.request() cannot speak any scheme but http: and throws
// synchronously, so a loopback https url has to be dropped at settings-resolution
// time - with a notice, like every other discarded value (design doc 7.2).
describe('degradeMapping codexStatusUrl scheme', () => {
  it('drops a non-http scheme even on loopback, with a notice', () => {
    for (const value of [
      'https://127.0.0.1:18765/healthz',
      'https://localhost:18765/healthz',
      'https://[::1]:18765/healthz',
    ]) {
      const normalized = normalizeDegradeMapping({ enabled: true, codexStatusUrl: value });
      assert.equal(normalized.codexStatusUrl, null, value);
      assert.deepEqual(
        normalized.notices,
        ['degradeMapping.codexStatusUrl must use http: scheme; codex status section disabled'],
        value,
      );
    }
  });

  it('keeps loopback http urls untouched', () => {
    for (const value of ['http://127.0.0.1:18765/healthz', 'http://[::1]/healthz']) {
      const normalized = normalizeDegradeMapping({ enabled: true, codexStatusUrl: value });
      assert.equal(normalized.codexStatusUrl, value, value);
      assert.deepEqual(normalized.notices, [], value);
    }
  });

  it('logs the dropped scheme without copying the configured url', () => {
    const settings = resolveOpenAiBridgeSettings({
      openaiBridge: {
        enabled: true,
        url: 'http://127.0.0.1:18765',
        degradeMapping: { enabled: true, codexStatusUrl: 'https://127.0.0.1:18765/healthz' },
      },
    });
    const lines = [];

    assert.equal(settings.degradeMapping.codexStatusUrl, null);
    logDegradeMappingConfigNotice(settings, line => lines.push(line));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /degradeMapping\.codexStatusUrl must use http: scheme; codex status section disabled$/);
    assert.equal(lines[0].includes('healthz'), false);
  });
});

// ---------------------------------------------------------------------------
// R6-2: 非 SSE 要求の生存通知（HTTP 102 Processing）
// 契約 §C4.6（非 SSE 要求の生存通知）／§C13.4 テスト30。
//
// 非 SSE の応答には SSE の開始マーカーに相当する「流すもの」が無いため、bridge が上流
// 応答ヘッダを待っている間、rotator には1バイトも届かない。放置すると bridge も上流も
// 正常なのに長考がアイドル判定（既定 30,000ms）を超えた時点で rotator が 403 を合成する。
// bridge は生存通知として 102 Processing を周期送出し、rotator は information（1xx。
// 101 を除く）でアイドルタイマーを再武装する。102 は下流へ転送しない（消費のみ）ため、
// Claude Code から見た応答は 102 が無い場合とバイト単位で同一になる。
// 最終ステータス・outcome・ログ書式・設定キーはいずれも変えない。
// ---------------------------------------------------------------------------

// 実寸（アイドル 30,000ms・102 は 12,000ms ごと・生成 90,000ms）と同じ比のまま縮めた値。
const PROCESSING_IDLE_MS = 400;
const PROCESSING_INTERVAL_MS = PROCESSING_IDLE_MS / 2; // §C4.6 の 2「idleTimeoutMs の 1/2 以下」
const PROCESSING_HEAD_DELAY_MS = PROCESSING_IDLE_MS * 3; // アイドルの3倍だけ応答ヘッダを遅らせる
const PROCESSING_OK_BODY = JSON.stringify({ type: 'message', content: 'ok' });
const PROCESSING_ERROR_BODY = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream failed' } });

/**
 * 偽 bridge が 102 Processing を送る。ServerResponse#writeProcessing() は
 * "HTTP/1.1 102 Processing\r\n\r\n" だけを書き、最終応答ヘッダを確定させない（§C4.6 の 1）。
 * 返す counter で「実際に何回送ったか」をテスト側から確認する。
 */
function start102Heartbeat(res, { intervalMs = null, counter }) {
  counter.sent += 1;
  res.writeProcessing();
  if (intervalMs === null) return () => {};
  const timer = setInterval(() => {
    counter.sent += 1;
    res.writeProcessing();
  }, intervalMs);
  const stop = () => clearInterval(timer);
  res.on('close', stop);
  return stop;
}

/**
 * 102 の送出パターンと最終応答の組み合わせで偽 bridge のハンドラを作る。
 * heartbeat: 'none'（送らない）/ 'once'（1回だけ）/ 'periodic'（周期送出）
 * ending:    'ok'（200 JSON）/ 'error'（500 JSON）/ 'destroy'（ソケットを切る）
 */
function processingBridge({ heartbeat = 'none', first102DelayMs = 0, headDelayMs = 0, ending = 'ok' }) {
  const counter = { sent: 0 };
  const pending = new Set();
  const handler = (req, res) => {
    req.resume();
    let stopHeartbeat = () => {};
    const beat = () => {
      stopHeartbeat = start102Heartbeat(res, {
        intervalMs: heartbeat === 'periodic' ? PROCESSING_INTERVAL_MS : null,
        counter,
      });
    };
    if (heartbeat !== 'none') {
      if (first102DelayMs === 0) beat();
      else {
        const beatTimer = setTimeout(() => { pending.delete(beatTimer); beat(); }, first102DelayMs);
        pending.add(beatTimer);
      }
    }
    if (ending === 'silence') return; // 102 のあとは無音のまま保持する（対照）
    const timer = setTimeout(() => {
      pending.delete(timer);
      stopHeartbeat(); // §C4.6 の 3: 上流応答ヘッダを受領した時点で送出を止める
      if (ending === 'destroy') {
        res.socket?.destroy();
        return;
      }
      const body = ending === 'error' ? PROCESSING_ERROR_BODY : PROCESSING_OK_BODY;
      res.writeHead(ending === 'error' ? 500 : 200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    }, headDelayMs);
    pending.add(timer);
  };
  const cleanup = () => {
    for (const timer of pending) clearTimeout(timer);
    pending.clear();
  };
  return { handler, counter, cleanup };
}

/** 生ソケットで POST し、下流が受け取ったバイト列をそのまま返す（102 の混入を見るため）。 */
function rawPost(port, body) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        'POST /v1/messages HTTP/1.1\r\n'
        + `host: 127.0.0.1:${port}\r\n`
        + 'content-type: application/json\r\n'
        + 'anthropic-version: 2023-06-01\r\n'
        + `content-length: ${Buffer.byteLength(body)}\r\n`
        + 'connection: close\r\n\r\n'
        + body,
      );
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

/** Date ヘッダだけは秒単位の実時刻なので、バイト比較の前に伏せる。 */
function maskDateHeader(raw) {
  return raw.replace(/\r\nDate: [^\r\n]+\r\n/, '\r\nDate: <masked>\r\n');
}

/**
 * 偽 bridge を立て、forwardToOpenAiBridge を1回だけ通す（既存の callThroughRotator と
 * 同型だが、outcome と生バイト列を返す点だけが違う）。
 */
async function callWith102Bridge({ bridge: bridgeSpec, idleTimeoutMs = PROCESSING_IDLE_MS, degradeMapping = null, raw = false }) {
  const { server: bridgeServer, port } = await startFakeBridge(bridgeSpec.handler);
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      enabled: true,
      url: `http://127.0.0.1:${port}`,
      modelPattern: '^gpt-',
      connectTimeoutMs: 2000,
      idleTimeoutMs,
      connectRetries: 0,
      // 未指定＝現行と同一の経路であることを保つため、渡すときだけキーを足す。
      ...(degradeMapping ? { degradeMapping } : {}),
    },
  });
  const lines = [];
  let resolveResult;
  const settled = new Promise(resolve => { resolveResult = resolve; });
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    resolveResult(await forwardToOpenAiBridge({
      req, res, body, model: safeParseModel(body), settings, logger: line => lines.push(line),
    }));
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const frontPort = front.address().port;
  const requestBody = '{"model":"gpt-6-astra"}';

  let response = null;
  let text = null;
  let rawText = null;
  if (raw) {
    rawText = await rawPost(frontPort, requestBody);
  } else {
    response = await fetch(`http://127.0.0.1:${frontPort}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: requestBody,
    });
    text = await response.text();
  }
  const result = await settled;
  front.close();
  bridgeServer.close();
  bridgeSpec.cleanup();
  return {
    response, text, raw: rawText, lines, result,
    bridgeLine: lines.find(line => / openai-bridge model=/.test(line)),
    processingSent: bridgeSpec.counter.sent,
  };
}

describe('forwardToOpenAiBridge > 非 SSE の生存通知 102 Processing (R6-2 / 契約 §C4.6)', () => {
  it('(a) keeps the request alive while 102 keeps arriving, and never forwards 102 downstream', async () => {
    // アイドルの3倍だけ応答ヘッダを遅らせる。102 が届かなければ必ず切られる長さである。
    const bridge = processingBridge({ heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS });
    const { response, text, result, lines, bridgeLine, processingSent } = await callWith102Bridge({ bridge });

    assert.equal(result.outcome, 'forwarded', '102 で再武装されるのでアイドル判定は発火しない');
    assert.equal(result.status, 200);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), JSON.parse(PROCESSING_OK_BODY));
    assert.ok(processingSent >= 3, `102 が周期送出されていること (sent=${processingSent})`);
    assert.match(bridgeLine, /status=200 durationMs=\d+ outcome=forwarded$/, 'ログ書式は不変（102 でフィールドを増やさない）');
    assert.equal(
      lines.filter(line => / openai-bridge /.test(line)).length,
      1,
      '102 の受信でログ行を増やさない（§C4.6 の「ログ書式は不変」）',
    );
  });

  it('(a) the downstream bytes are identical to a run without any 102', async () => {
    const withProcessing = processingBridge({ heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS });
    const withProcessingRun = await callWith102Bridge({ bridge: withProcessing, raw: true });
    // 対照は 102 を1回も送らず、遅延なしで同じ本文を返す偽 bridge。
    const control = processingBridge({ heartbeat: 'none', headDelayMs: 0 });
    const controlRun = await callWith102Bridge({ bridge: control, raw: true });

    assert.ok(withProcessingRun.processingSent >= 3, '102 は実際に流れている');
    assert.equal(controlRun.processingSent, 0);
    assert.equal(/HTTP\/1\.1 102/.test(withProcessingRun.raw), false, '102 は下流へ1バイトも流れない');
    assert.equal(
      maskDateHeader(withProcessingRun.raw),
      maskDateHeader(controlRun.raw),
      'Claude Code から見た応答は 102 が無かった場合とバイト単位で同一',
    );
  });

  it('(b) still reports bridge-idle-timeout when only one 102 arrives and the bridge then goes silent', async () => {
    // 「開始通知として1回だけ」では足りない（アイドルの窓を1つ買い直すだけ）ことと、
    // 無応答の検出能力を失っていないことを同時に固定する。アイドルの半分だけ待ってから
    // 1回だけ 102 を送るので、再武装が効いていれば打ち切りはアイドルの 1.5 倍付近まで
    // 遅れ、それでも結局は切られる（タイマーは遅れる方向にしかぶれないので下限で見る）。
    const bridge = processingBridge({
      heartbeat: 'once', first102DelayMs: PROCESSING_IDLE_MS / 2, ending: 'silence',
    });
    const { response, text, result, bridgeLine, processingSent } = await callWith102Bridge({ bridge });

    assert.equal(processingSent, 1);
    assert.equal(result.outcome, 'bridge-idle-timeout');
    assert.equal(result.status, 403);
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(text).error.type, 'permission_error');
    assert.match(bridgeLine, /status=403 durationMs=\d+ outcome=bridge-idle-timeout$/);
    const durationMs = Number(/durationMs=(\d+)/.exec(bridgeLine)[1]);
    assert.ok(
      durationMs >= PROCESSING_IDLE_MS * 1.4,
      `1回の 102 でアイドルの窓を1つ買い直していること (durationMs=${durationMs})`,
    );
  });

  it('(b) the control without any 102 is cut at the same outcome, status and body', async () => {
    const silent = processingBridge({ heartbeat: 'none', ending: 'silence' });
    const silentRun = await callWith102Bridge({ bridge: silent });
    const once = processingBridge({
      heartbeat: 'once', first102DelayMs: PROCESSING_IDLE_MS / 2, ending: 'silence',
    });
    const onceRun = await callWith102Bridge({ bridge: once });

    assert.equal(silentRun.result.outcome, 'bridge-idle-timeout');
    assert.equal(onceRun.result.outcome, silentRun.result.outcome);
    assert.equal(onceRun.result.status, silentRun.result.status);
    assert.equal(onceRun.text, silentRun.text);
  });

  it('(c) a disconnect after 102 stays bridge-unreachable with the current body', async () => {
    // 応答ヘッダより先に切られるので、102 が無い場合と同じく 403 を合成する。
    const afterProcessing = processingBridge({
      heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS, ending: 'destroy',
    });
    const afterRun = await callWith102Bridge({ bridge: afterProcessing });
    const control = processingBridge({ heartbeat: 'none', headDelayMs: 0, ending: 'destroy' });
    const controlRun = await callWith102Bridge({ bridge: control });

    assert.ok(afterRun.processingSent >= 3);
    assert.equal(afterRun.result.outcome, 'bridge-unreachable', '102 は最終ステータスに影響しない');
    assert.equal(afterRun.result.status, 403);
    assert.equal(afterRun.result.outcome, controlRun.result.outcome);
    assert.equal(afterRun.result.status, controlRun.result.status);
    assert.equal(afterRun.text, controlRun.text, '本文も現行と一致する');
  });

  it('(c) a 5xx after 102 is forwarded unchanged, exactly like a 5xx without 102', async () => {
    const afterProcessing = processingBridge({
      heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS, ending: 'error',
    });
    const afterRun = await callWith102Bridge({ bridge: afterProcessing });
    const control = processingBridge({ heartbeat: 'none', headDelayMs: 0, ending: 'error' });
    const controlRun = await callWith102Bridge({ bridge: control });

    assert.ok(afterRun.processingSent >= 3);
    assert.equal(afterRun.result.outcome, 'forwarded');
    assert.equal(afterRun.result.status, 500);
    assert.equal(afterRun.response.status, 500);
    assert.equal(afterRun.result.outcome, controlRun.result.outcome);
    assert.equal(afterRun.result.status, controlRun.result.status);
    assert.equal(afterRun.text, controlRun.text);
  });

  it('(d) behaves the same whether degradeMapping is off (default) or on', async () => {
    // 102 の消費は degradeMapping と無関係な rotator の基本挙動である
    // （§C4.6 は bridge 側の設定フラグで制御する）。
    const off = processingBridge({ heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS });
    const offRun = await callWith102Bridge({ bridge: off, degradeMapping: null });
    const on = processingBridge({ heartbeat: 'periodic', headDelayMs: PROCESSING_HEAD_DELAY_MS });
    const onRun = await callWith102Bridge({ bridge: on, degradeMapping: { enabled: true } });

    for (const run of [offRun, onRun]) {
      assert.equal(run.result.outcome, 'forwarded');
      assert.equal(run.result.status, 200);
      assert.deepEqual(JSON.parse(run.text), JSON.parse(PROCESSING_OK_BODY));
      assert.ok(run.processingSent >= 3);
    }
    // 契約ヘッダの無い 200 では追記フィールドが1つも出ない（§14.4）。102 でも増えない。
    assert.match(offRun.bridgeLine, /outcome=forwarded$/);
    assert.match(onRun.bridgeLine, /outcome=forwarded$/);
  });

  it('never arms a new idle timer for a 102 that arrives after the request has settled', async () => {
    // finish() 確定後に届いた 102 で再武装すると、誰も止めないタイマーが残り、
    // 応答済みの res を後から destroy() で撃つ。settled ガードがそれを止めることを固定する。
    const manual = createManualUpstream();
    const req = fakeIncomingRequest();
    const res = fakeServerResponse();
    let destroyCalls = 0;
    const innerDestroy = res.destroy;
    res.destroy = () => { destroyCalls += 1; innerDestroy(); };
    const lines = [];

    // forwardToOpenAiBridge が張ったタイマーのうち、まだ生きているものを数える。
    const live = new Set();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      const handle = realSetTimeout((...fired) => { live.delete(handle); fn(...fired); }, ms, ...args);
      live.add(handle);
      return handle;
    };
    globalThis.clearTimeout = handle => { live.delete(handle); return realClearTimeout(handle); };

    let result;
    try {
      const forwarded = forwardToOpenAiBridge({
        req,
        res,
        body: Buffer.from('{"model":"gpt-6-astra"}'),
        model: 'gpt-6-astra',
        settings: bridgeSettings({ idleTimeoutMs: 30 }),
        logger: line => lines.push(line),
        httpRequestImpl: manual.requestImpl,
      });
      await new Promise(resolve => realSetTimeout(resolve, 10));
      // 接続前失敗で確定させる（sendSynthetic 済み・res は destroy されていない）。
      manual.getUpstream().emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
      result = await forwarded;
      // 確定後に遅れて届いた 102。
      manual.getUpstream().emit('information', { statusCode: 102, statusMessage: 'Processing', headers: {} });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }

    assert.equal(result.outcome, 'bridge-unreachable');
    assert.equal(live.size, 0, '確定後の 102 でタイマーを張り直さない');
    await new Promise(resolve => realSetTimeout(resolve, 90)); // idleTimeoutMs の3倍待つ
    assert.equal(destroyCalls, 0, '応答済みの res を後から destroy() しない');
    assert.equal(lines.filter(line => / openai-bridge /.test(line)).length, 1, 'ログ行も増えない');
  });
});

// ---------------------------------------------------------------------------
// R6-4: rotator → bridge の要求ヘッダ（契約 §C4.6 の生存通知の周期を決める値の受け渡しと、
// 利用者が名乗った契約ヘッダの除去）。どちらも degradeMapping の有無に依存しない。
// ---------------------------------------------------------------------------

// 実 HTTP で往復し、偽 bridge が実際に受け取った要求ヘッダを返す。
// 設定は createDefaultConfig() の openaiBridge そのまま（＝既定の idleTimeoutMs 30000）で
// 組み立て、url と enabled だけを差し替える。
async function forwardWithClientHeaders({ clientHeaders = {}, openaiBridgeOverride = {} } = {}) {
  let seen = null;
  const { server: bridge, port } = await startFakeBridge(async (req, res) => {
    for await (const chunk of req) void chunk;
    seen = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      ...createDefaultConfig().openaiBridge,
      enabled: true,
      url: `http://127.0.0.1:${port}`,
      ...openaiBridgeOverride,
    },
  });
  const front = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    await forwardToOpenAiBridge({ req, res, body, model: safeParseModel(body), settings });
  });
  await new Promise(resolve => front.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${front.address().port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: '{"model":"gpt-6-astra"}',
  });
  const text = await response.text();
  front.close();
  bridge.close();
  return { seen, response, text };
}

// http.Server は受信ヘッダ名を必ず小文字へ畳むため、実 HTTP では「大文字混じりの
// 契約ヘッダ」を再現できない。除去の判定が大文字小文字を区別しないことは、req を
// 手組みして httpRequestImpl が受け取った headers を直接見ることで固定する。
async function forwardedUpstreamHeaders({ requestHeaders = {}, openaiBridgeOverride = {} } = {}) {
  let seen = null;
  const requestImpl = options => {
    seen = options.headers;
    const upstream = new EventEmitter();
    upstream.destroyed = false;
    upstream.destroy = () => { upstream.destroyed = true; };
    // ヘッダを捕まえるのが目的なので、接続前失敗で即座に確定させる（タイマーを残さない）。
    upstream.end = () => {
      process.nextTick(() => upstream.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    };
    return upstream;
  };
  const settings = resolveOpenAiBridgeSettings({
    openaiBridge: {
      ...createDefaultConfig().openaiBridge,
      enabled: true,
      url: 'http://127.0.0.1:1',
      ...openaiBridgeOverride,
    },
  });
  await forwardToOpenAiBridge({
    req: fakeIncomingRequest({ headers: requestHeaders }),
    res: fakeServerResponse(),
    body: Buffer.from('{"model":"gpt-6-astra"}'),
    model: 'gpt-6-astra',
    settings,
    httpRequestImpl: requestImpl,
  });
  return seen;
}

function contractHeaderNames(headers) {
  return Object.keys(headers).filter(name => name.toLowerCase().startsWith('x-ombr-')).sort();
}

describe('forwardToOpenAiBridge > R6-4 契約ヘッダの送出と利用者ヘッダの除去', () => {
  it('(a) sends the rotator idle timeout as x-ombr-idle-timeout-ms with the default settings', async () => {
    const { seen, response } = await forwardWithClientHeaders();
    assert.equal(response.status, 200);
    assert.equal(seen['x-ombr-idle-timeout-ms'], '30000', '既定の idleTimeoutMs を10進整数文字列で名乗る');
    assert.deepEqual(contractHeaderNames(seen), ['x-ombr-idle-timeout-ms'], '契約ヘッダはこの1本だけ');
  });

  it('(b) reflects a configured idleTimeoutMs in the forwarded contract header', async () => {
    const { seen } = await forwardWithClientHeaders({ openaiBridgeOverride: { idleTimeoutMs: 45000 } });
    assert.equal(seen['x-ombr-idle-timeout-ms'], '45000');
  });

  it('(c) drops client supplied x-ombr-* headers and pins the rotator value', async () => {
    // 実 HTTP 経路（server が小文字へ畳んだあと）。
    const { seen } = await forwardWithClientHeaders({
      clientHeaders: { 'X-OMBR-Idle-Timeout-Ms': '5', 'x-ombr-pool-state': 'exhausted' },
    });
    assert.equal(seen['x-ombr-idle-timeout-ms'], '30000', '利用者の 5 ではなく rotator の値が届く');
    assert.equal(seen['x-ombr-pool-state'], undefined, '契約ヘッダの偽装は bridge まで届かない');
    assert.deepEqual(contractHeaderNames(seen), ['x-ombr-idle-timeout-ms']);

    // 手組みの req（大文字混じりのまま）でも同じ結果になる＝判定は大文字小文字を区別しない。
    const upstreamHeaders = await forwardedUpstreamHeaders({
      requestHeaders: { 'X-OMBR-Idle-Timeout-Ms': '5', 'X-Ombr-Pool-State': 'exhausted' },
    });
    assert.equal(upstreamHeaders['x-ombr-idle-timeout-ms'], '30000');
    assert.deepEqual(contractHeaderNames(upstreamHeaders), ['x-ombr-idle-timeout-ms']);
  });

  it('(d) keeps forwarding client headers outside the x-ombr- namespace', async () => {
    const { seen } = await forwardWithClientHeaders({
      clientHeaders: {
        'x-request-id': 'req-0001',
        'x-api-key': 'claude-rotator-local-gateway',
        'anthropic-version': '2023-06-01',
        'x-ombr-pool-state': 'exhausted',
      },
    });
    assert.equal(seen['x-request-id'], 'req-0001', '接頭辞が違うヘッダは従来どおり素通しする');
    assert.equal(seen['x-api-key'], 'claude-rotator-local-gateway');
    assert.equal(seen['anthropic-version'], '2023-06-01');
    assert.equal(seen['x-ombr-pool-state'], undefined, '除去は x-ombr- 接頭辞だけに効く');
  });

  it('(e) behaves the same whether degradeMapping is off (default) or on', async () => {
    // 契約ヘッダの偽装防止と生存通知の値の受け渡しは、写像機能の有無と無関係な基本挙動である。
    const clientHeaders = { 'X-OMBR-Idle-Timeout-Ms': '5', 'x-ombr-pool-state': 'exhausted' };
    const off = await forwardWithClientHeaders({ clientHeaders });
    const on = await forwardWithClientHeaders({ clientHeaders, openaiBridgeOverride: { degradeMapping: { enabled: true } } });

    for (const { seen } of [off, on]) {
      assert.equal(seen['x-ombr-idle-timeout-ms'], '30000');
      assert.deepEqual(contractHeaderNames(seen), ['x-ombr-idle-timeout-ms']);
    }
  });
});
