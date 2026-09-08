import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

  it('never parses the body when the bridge is disabled (レビュー指摘8)', () => {
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
// httpRequestImpl を差し替えるための最小フェイク（Task 26 追試: レビュー指摘6・7）
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

  it('propagates a client abort to the upstream bridge connection (production shape: req fully drained before forward, レビュー指摘1)', async () => {
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

  it('pins the upstream host/port to settings.url even for an absolute-form req.url (レビュー指摘3)', async () => {
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

  it('does not retry a connection reset that arrives after the request was accepted, even immediately (double-send risk, レビュー再検証指摘1で挙動修正)', async () => {
    // 旧テスト（レビュー指摘2時点）は「接続直後の即時リセットなら安全に再試行できる」
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

  it('does not retry once the request body has been fully flushed to the bridge, even before any response arrives (no double-send, レビュー再検証指摘1)', async () => {
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

  it('ignores an upstream error that fires after finish() has already settled a client abort (レビュー再検証指摘2)', async () => {
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

  it('logs a connect-retry line before re-attempting a refused connection (レビュー指摘5)', async () => {
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

  it('logs the synthesized 403 status for an idle-timeout, not the placeholder "-" (レビュー指摘6)', async () => {
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

  it('pauses the upstream response and resumes on drain when the client write buffer is full (レビュー指摘7)', async () => {
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
  it('reverts to the default (disabled) bridge config once the section/config.json disappears on reload (レビュー指摘4)', async () => {
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

  it('logs the openaiBridge config-warning only once at startup, not per request (レビュー指摘5)', async () => {
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

  it('does not log parse-error-fallback for a bodyless request, but does for a malformed non-empty body (レビュー指摘5)', async () => {
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
    // （レビュー指摘2。修正前はこの URL が黙って null になっていた）。
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
    // 非ループバックを黙って捨てない（レビュー指摘3）。理由は notices に載せ、
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
    // 非ループバック URL を黙って捨てない（レビュー指摘3）。bridge 分岐が有効なので
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
    // 修正前は [::1] が黙って捨てられていた（レビュー指摘2）。いまは値が残り通知も出ない。
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
