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
    assert.equal(result.outcome, 'bridge-unreachable');
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
    assert.equal(result.outcome, 'bridge-timeout');
    assert.equal(result.status, 403, 'a synthesized 403 must be reported as the log status, not null');
    const logLine = lines.find(l => /outcome=bridge-timeout/.test(l));
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
