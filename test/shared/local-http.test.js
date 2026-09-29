// ループバックの共用部品（src/shared/local-http.js）のテスト。
//
// 1. src/proxy-server.js から移した4関数の判定（ループバックの3語と [::1]、Host の欠落、
//    sec-fetch-site: cross-site、Origin の不一致・https:・読めない値）。
// 2. 常駐の接続先の URL を作る関数が、0・undefined・範囲外のポートを既定値へ置き換えずに例外にすること。
//    設定の読込だけが既定のポートを補うこと（設定に daemon.port を書かない読込の結果）。
// 3. 常駐への要求の関数が、要求関数を渡されないと例外になり（既定の http.request へ落ちない）、期限と
//    応答の大きさの上限を守ること。
//
// 絶対条件: 実の待受・実の設定・実のホームへ届かない。env と要求関数は隔離の補助
// （test/codex/helpers/isolation.js）から受け取り、偽の常駐はポート0で開いて server.address().port へ
// 接続する。実の待受の番号は数で書かず、隔離の補助の REAL_SERVICE_PORTS と比べる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { inspect } from 'node:util';
import {
  DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCAL_RESPONSE_MAX_BYTES,
  LOCAL_SERVICE_HOST,
  LocalHttpError,
  assertLoopbackProxyHost,
  isLoopbackHostname,
  isTrustedLocalHttpRequest,
  localServiceUrl,
  loopbackHostAuthority,
  requestLocal,
} from '../../src/shared/local-http.js';
// 後から足した定数は名前空間から読む（直す前の版で読込そのものが失敗せず、個々のテストが落ちるように）。
import * as localHttp from '../../src/shared/local-http.js';
import { DEFAULT_DAEMON_PORT, loadCodexConfig } from '../../src/codex/config.js';
import { codexRotatorConfigPath } from '../../src/codex/paths.js';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from '../codex/helpers/isolation.js';

// 合成の目印（ヘッダと本文で渡し、例外に出ないことを確かめる）。
const HEADER_MARKER = 'zz-local-http-header-marker-5f2c';
const BODY_MARKER = 'zz-local-http-body-marker-9a41';

const requestWith = headers => ({ headers });

// 期待値は実装の定数を使わずに直書きする（実装の一覧と一致することは1件のテストで確かめる）。
// requestLocal が自分で付ける code。
const LOCAL_CODES = { timeout: 'ELOCALTIMEOUT', tooLarge: 'ELOCALTOOLARGE', cutOff: 'ELOCALCUTOFF', failed: 'ELOCALREQUEST' };
// 下の層の例外から引き継いでよい code（これ以外は 'ELOCALREQUEST' になる）。
const FORWARDED_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EADDRNOTAVAIL', 'EISOLATION'];
// setTimeout が受けられる最大の期限。
const MAX_TIMEOUT_MS = 2147483647;

// ソケットを開かない偽の要求関数。end() が呼ばれたら behave(req) を呼ぶ（behave は何もしなくてもよい）。
// 既定は同期（end の中で behave を呼ぶ）のまま残す。behave が end の中で同期に出来事を出すテストは、
// requestLocal の前提2の外（end の中の同期の出来事）を扱う保証外の回帰テストである（そう注記した）。
function fakeRequestFunction(behave = () => {}) {
  const calls = [];
  const request = (url, options) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => {
      req.destroyed = true;
      return req;
    };
    req.end = () => {
      behave(req);
      return req;
    };
    calls.push({ url, options, req });
    return req;
  };
  return { request, calls };
}

// 例外のメッセージ・スタック・JSON・util.inspect のどこにも目印が無く、cause を持たないこと。
function carriesNoMarker(error, markers) {
  if (error !== null && typeof error === 'object' && 'cause' in error) return false;
  const text = `${error?.message} ${error?.stack} ${JSON.stringify(error)} ${inspect(error, { showHidden: true, depth: 10 })}`;
  return markers.every(marker => !text.includes(marker));
}

// 偽の常駐をポート0で開き、実際に割り当てられた番号を隔離の補助へ登録する。
async function openFakeDaemon(t, isolation, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOCAL_SERVICE_HOST, resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  const { port } = server.address();
  assert.ok(Number.isInteger(port) && port > 0);
  assert.ok(!REAL_SERVICE_PORTS.includes(port), 'the fake daemon must not listen on a real service port');
  isolation.allowRequest(port);
  return { server, port };
}

// ---------------------------------------------------------------------------
// 1. 移した4関数
// ---------------------------------------------------------------------------

test('local-http: assertLoopbackProxyHost accepts the three loopback words and refuses everything else', () => {
  for (const host of ['127.0.0.1', '::1', 'localhost', ' LocalHost ', 'LOCALHOST']) {
    assert.doesNotThrow(() => assertLoopbackProxyHost(host), host);
  }
  for (const host of ['0.0.0.0', '127.0.0.2', '[::1]', 'example.invalid', '', undefined, null]) {
    assert.throws(() => assertLoopbackProxyHost(host), /must be loopback/, String(host));
  }
  assert.throws(() => assertLoopbackProxyHost(''), /received <empty>/);
});

test('local-http: isLoopbackHostname accepts 127.0.0.1, ::1, [::1] and localhost in any case', () => {
  for (const hostname of ['127.0.0.1', '::1', '[::1]', 'localhost', 'LocalHost', ' localhost ']) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  for (const hostname of ['127.0.0.2', '0.0.0.0', '::2', 'example.invalid', 'localhost.example.invalid', '', undefined, null]) {
    assert.equal(isLoopbackHostname(hostname), false, String(hostname));
  }
});

test('local-http: loopbackHostAuthority returns the lower-cased authority only for a loopback Host', () => {
  assert.equal(loopbackHostAuthority('127.0.0.1:4101'), '127.0.0.1:4101');
  assert.equal(loopbackHostAuthority('LOCALHOST:4102'), 'localhost:4102');
  assert.equal(loopbackHostAuthority('[::1]:4103'), '[::1]:4103');
  assert.equal(loopbackHostAuthority('localhost'), 'localhost');
  for (const value of ['example.invalid:4104', '127.0.0.2:4105', '127.0.0.1@example.invalid', 'a b', '', undefined, null, 4106]) {
    assert.equal(loopbackHostAuthority(value), null, String(value));
  }
});

test('local-http: isTrustedLocalHttpRequest refuses a missing or non-loopback Host and cross-site requests', () => {
  assert.equal(isTrustedLocalHttpRequest(requestWith({})), false, 'Host is missing');
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: '' })), false, 'Host is empty');
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: 'example.invalid:4201' })), false);
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: '127.0.0.1:4201', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: '127.0.0.1:4201', 'sec-fetch-site': 'Cross-Site' })), false);
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: '127.0.0.1:4201', 'sec-fetch-site': 'same-origin' })), true);
  for (const host of ['127.0.0.1:4201', 'localhost:4201', '[::1]:4201']) {
    assert.equal(isTrustedLocalHttpRequest(requestWith({ host })), true, `no Origin, Host ${host}`);
  }
});

test('local-http: isTrustedLocalHttpRequest checks Origin against Host (scheme, host, port, unreadable values)', () => {
  const host = '127.0.0.1:4301';
  const withOrigin = origin => isTrustedLocalHttpRequest(requestWith({ host, origin }));
  assert.equal(withOrigin('http://127.0.0.1:4301'), true);
  assert.equal(withOrigin('HTTP://127.0.0.1:4301'), true);
  assert.equal(isTrustedLocalHttpRequest(requestWith({ host: 'LocalHost:4301', origin: 'http://localhost:4301' })), true);
  assert.equal(withOrigin('https://127.0.0.1:4301'), false, 'https: is not the local listener');
  assert.equal(withOrigin('http://127.0.0.1:4302'), false, 'another port');
  assert.equal(withOrigin('http://localhost:4301'), false, 'another host word than Host');
  assert.equal(withOrigin('http://example.invalid:4301'), false, 'a non-loopback origin');
  for (const origin of ['null', 'not a url', '127.0.0.1:4301', '://']) {
    assert.equal(withOrigin(origin), false, `unreadable Origin ${origin}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 常駐の接続先の URL
// ---------------------------------------------------------------------------

test('local-http: localServiceUrl builds a loopback URL from the actual port and path', () => {
  assert.equal(LOCAL_SERVICE_HOST, '127.0.0.1');
  assert.equal(localServiceUrl(1, '/internal/status'), 'http://127.0.0.1:1/internal/status');
  assert.equal(localServiceUrl(65535, '/internal/health'), 'http://127.0.0.1:65535/internal/health');
  assert.equal(localServiceUrl(4401, '/'), 'http://127.0.0.1:4401/');
});

test('local-http: localServiceUrl throws for port 0, undefined and out-of-range values instead of using a default', () => {
  for (const port of [0, undefined, null, -1, 65536, 1.5, Number.NaN, Infinity, '4402', true, {}]) {
    assert.throws(() => localServiceUrl(port, '/internal/status'), RangeError, String(port));
  }
  // 引数を省いたとき（ポートもパスも無い）も既定値を使わない。
  assert.throws(() => localServiceUrl(), RangeError);
});

test('local-http: localServiceUrl refuses a path that is not a plain absolute path', () => {
  for (const path of [undefined, '', 'internal/status', '/internal/status?x=1', '/a#b', '/a b', 'http://127.0.0.1:4403/x', 42]) {
    assert.throws(() => localServiceUrl(4403, path), TypeError, String(path));
  }
});

test('local-http: the config loader is the only place that fills in the daemon port (daemon.port absent, 0)', async t => {
  const isolation = await setupCodexIsolation(t);
  const { env } = isolation;
  const path = codexRotatorConfigPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const writeConfig = async raw => {
    await writeFile(path, JSON.stringify(raw));
    await chmod(path, 0o600);
  };

  // daemon.port を書かない設定の読込の結果には、既定のポートが入る。URL を作る関数はその値をそのまま使う。
  await writeConfig({ enabled: false });
  const withoutPort = await loadCodexConfig({ env });
  assert.equal(withoutPort.daemon.port, DEFAULT_DAEMON_PORT);
  assert.equal(localServiceUrl(withoutPort.daemon.port, '/internal/status'),
    `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/internal/status`);

  // 設定のポートが 0 なら、URL を作る関数は既定値へ置き換えずに例外にする。
  await writeConfig({ enabled: false, daemon: { port: 0 } });
  const zeroPort = await loadCodexConfig({ env });
  assert.equal(zeroPort.daemon.port, 0);
  assert.throws(() => localServiceUrl(zeroPort.daemon.port, '/internal/status'), RangeError);

  // どれも接続は試みていない。
  assert.deepEqual(isolation.connections, []);
  assert.deepEqual(isolation.refusedConnections, []);
});

// ---------------------------------------------------------------------------
// 3. 常駐への要求
// ---------------------------------------------------------------------------

test('local-http: requestLocal throws without a request function and never falls back to http.request', async t => {
  const isolation = await setupCodexIsolation(t);
  const { port } = await openFakeDaemon(t, isolation, (req, res) => res.end('reached'));
  for (const request of [undefined, null, 'http', {}, http]) {
    assert.throws(() => requestLocal({ request, port, path: '/internal/status' }), TypeError, String(request));
  }
  assert.throws(() => requestLocal(), TypeError);
  assert.throws(() => requestLocal({ port, path: '/internal/status' }), /never falls back to http\.request/);
  // 例外は要求を出す前に起きている（関所を通った接続も拒否された接続も無い）。
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(isolation.connections, []);
  assert.deepEqual(isolation.refusedConnections, []);
  assert.deepEqual(isolation.refusedRequests, []);
  assert.deepEqual(isolation.fetchCalls, []);
});

test('local-http: requestLocal refuses bad arguments before calling the request function', async t => {
  const isolation = await setupCodexIsolation(t);
  const calls = [];
  const request = (...args) => {
    calls.push(args);
    return isolation.request(...args);
  };
  const base = { request, port: 4501, path: '/internal/status' };
  for (const port of [0, undefined, 65536, 1.5]) {
    assert.throws(() => requestLocal({ ...base, port }), RangeError, `port ${port}`);
  }
  assert.throws(() => requestLocal({ ...base, path: 'internal' }), TypeError);
  for (const method of ['DELETE', 'get', 'PUT', '']) {
    assert.throws(() => requestLocal({ ...base, method }), TypeError, `method ${method}`);
  }
  for (const headers of [null, [], 'x-a: b']) {
    assert.throws(() => requestLocal({ ...base, headers }), TypeError, `headers ${headers}`);
  }
  for (const body of [42, {}, null]) {
    assert.throws(() => requestLocal({ ...base, method: 'POST', body }), TypeError, `body ${body}`);
  }
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, '100', MAX_TIMEOUT_MS + 1, Infinity]) {
    assert.throws(() => requestLocal({ ...base, timeoutMs }), RangeError, `timeoutMs ${timeoutMs}`);
  }
  for (const maxResponseBytes of [0, -1, 1.5, '100']) {
    assert.throws(() => requestLocal({ ...base, maxResponseBytes }), RangeError, `maxResponseBytes ${maxResponseBytes}`);
  }
  assert.equal(calls.length, 0);
});

test('local-http: requestLocal reaches a fake daemon on port 0 through the given request function only', async t => {
  const isolation = await setupCodexIsolation(t);
  const seen = [];
  const { port } = await openFakeDaemon(t, isolation, (req, res) => {
    seen.push({ method: req.method, url: req.url, host: req.headers.host, trusted: isTrustedLocalHttpRequest(req) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const calls = [];
  const request = (...args) => {
    calls.push(args[0]);
    return isolation.request(...args);
  };
  const response = await requestLocal({ request, port, path: '/internal/status' });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(response.headers['content-type'], 'application/json');
  assert.deepEqual(calls, [`http://127.0.0.1:${port}/internal/status`]);
  // 要求は Host にループバックの接続先を載せ、移した検査がそれを信用する。
  assert.deepEqual(seen, [{ method: 'GET', url: '/internal/status', host: `127.0.0.1:${port}`, trusted: true }]);
  assert.deepEqual(isolation.connections.map(({ port: p }) => p), [port]);
  assert.deepEqual(isolation.fetchCalls, []);
  assert.equal(DEFAULT_LOCAL_REQUEST_TIMEOUT_MS > 0 && DEFAULT_LOCAL_RESPONSE_MAX_BYTES > 0, true);
});

test('local-http: requestLocal sends a POST body with its own content-length and the caller headers', async t => {
  const isolation = await setupCodexIsolation(t);
  const seen = [];
  const { port } = await openFakeDaemon(t, isolation, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, length: req.headers['content-length'], marker: req.headers['x-test-marker'],
        body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 202;
      res.end('');
    });
  });
  const body = JSON.stringify({ note: 'reload' });
  const response = await requestLocal({ request: isolation.request, port, path: '/internal/reload', method: 'POST',
    headers: { 'x-test-marker': 'present', 'Content-Length': '999' }, body });
  assert.equal(response.status, 202);
  assert.equal(response.body, '');
  assert.deepEqual(seen, [{ method: 'POST', length: String(Buffer.byteLength(body)), marker: 'present', body }]);
});

test('local-http: requestLocal rejects with ECONNREFUSED when the port is not registered with the isolation', async t => {
  const isolation = await setupCodexIsolation(t);
  const port = 4601;
  assert.ok(!REAL_SERVICE_PORTS.includes(port));
  await assert.rejects(
    requestLocal({ request: isolation.request, port, path: '/internal/status',
      headers: { 'x-codex-rotator-token': HEADER_MARKER } }),
    error => error instanceof LocalHttpError && error.code === 'ECONNREFUSED'
      && !error.message.includes(HEADER_MARKER) && !JSON.stringify(error).includes(HEADER_MARKER),
  );
  assert.deepEqual(isolation.refusedRequests.map(({ port: p }) => p), [port]);
  assert.deepEqual(isolation.connections, []);
});

// 期限と「例外に要求の中身が出ない」ことは、応答を返さない偽の要求関数で確かめる（実時間の競争が無い）。
// テスト自体にも期限を付ける（期限の処理が壊れたときに、止まらずに赤になるように）。
test('local-http: requestLocal gives up at its deadline and the error carries no request content', { timeout: 10_000 }, async () => {
  const { request, calls } = fakeRequestFunction(); // 応答も error も出さない
  await assert.rejects(
    requestLocal({ request, port: 4701, path: '/internal/reload', method: 'POST', timeoutMs: 20,
      headers: { 'x-codex-rotator-token': HEADER_MARKER }, body: BODY_MARKER }),
    error => error instanceof LocalHttpError && error.code === 'ELOCALTIMEOUT'
      && carriesNoMarker(error, [HEADER_MARKER, BODY_MARKER]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-codex-rotator-token'], HEADER_MARKER, 'the header was handed to the request function');
  assert.equal(calls[0].req.destroyed, true, 'the request is destroyed at the deadline');
});

// 保証外の回帰テスト: 前提2の外（end の中の同期の出来事）。
test('local-http: requestLocal accepts the largest timer value and refuses one above it before any request', () => {
  const { request, calls } = fakeRequestFunction(req => req.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
  assert.throws(() => requestLocal({ request, port: 4702, path: '/internal/status', timeoutMs: MAX_TIMEOUT_MS + 1 }), RangeError);
  assert.equal(calls.length, 0);
  assert.equal(localHttp.MAX_LOCAL_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return assert.rejects(requestLocal({ request, port: 4702, path: '/internal/status', timeoutMs: MAX_TIMEOUT_MS }),
    error => error instanceof LocalHttpError && error.code === 'ECONNREFUSED');
});

// 実のソケットでも期限で諦めて止まること。期限が短いので、偽の常駐が要求を受け取る前に諦めることもある。
test('local-http: requestLocal gives up at its deadline on a real socket as well', { timeout: 10_000 }, async t => {
  const isolation = await setupCodexIsolation(t);
  let received = 0;
  const { port } = await openFakeDaemon(t, isolation, () => { received++; /* 応答しない */ });
  await assert.rejects(requestLocal({ request: isolation.request, port, path: '/internal/status', timeoutMs: 50 }),
    error => error instanceof LocalHttpError && error.code === 'ELOCALTIMEOUT');
  assert.ok(received <= 1);
});

// 下の層の例外（要求関数が同期で投げたもの・要求の error・応答の error）は、許した code だけを引き継ぎ、
// メッセージ・スタック・任意の code を持ち込まない。
// 要求の error・応答の error の4行は、保証外の回帰テスト: 前提2の外（end の中の同期の出来事）。
test('local-http: requestLocal does not carry request content out of lower-layer errors', async () => {
  const MARK = 'zz-local-http-lower-layer-marker-3d7e';
  const markedError = () => Object.assign(new Error(`lower layer ${MARK}`), { code: MARK, detail: MARK });
  const markedLocalError = () => Object.assign(new LocalHttpError(`lower layer ${MARK}`, MARK), { detail: MARK });
  const throwing = make => () => { throw make(); };
  const fakeResponse = () => Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, destroy() {} });
  const cases = [
    ['the request function throws an error with an arbitrary code', throwing(markedError)],
    ['the request function throws a LocalHttpError', throwing(markedLocalError)],
    ['the request emits error with an arbitrary code', fakeRequestFunction(req => req.emit('error', markedError())).request],
    ['the request emits error with a LocalHttpError', fakeRequestFunction(req => req.emit('error', markedLocalError())).request],
    ['the response emits error', fakeRequestFunction(req => {
      const res = fakeResponse();
      req.emit('response', res);
      res.emit('error', markedError());
    }).request],
    ['the response emits error with a LocalHttpError', fakeRequestFunction(req => {
      const res = fakeResponse();
      req.emit('response', res);
      res.emit('error', markedLocalError());
    }).request],
  ];
  for (const [name, request] of cases) {
    await assert.rejects(
      requestLocal({ request, port: 4801, path: '/internal/reload', method: 'POST',
        headers: { 'x-codex-rotator-token': HEADER_MARKER }, body: BODY_MARKER }),
      error => error instanceof LocalHttpError && error.code === 'ELOCALREQUEST'
        && error.detail === undefined && carriesNoMarker(error, [MARK, HEADER_MARKER, BODY_MARKER]),
      name,
    );
  }
});

test('local-http: the exported code vocabulary matches the values written in the tests', () => {
  assert.deepEqual({ ...localHttp.LOCAL_HTTP_ERROR }, LOCAL_CODES);
  assert.deepEqual([...localHttp.LOCAL_HTTP_FORWARDED_CODES], FORWARDED_CODES);
  assert.equal(localHttp.MAX_LOCAL_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS);
});

// code を読む仕掛けのある例外（1回目だけ許した語を返す getter・読むと投げる getter・調べると投げる Proxy）。
// どれも目印を持ち、同期で投げる・要求の error・応答の error の3経路で試す。
test('local-http: requestLocal is not fooled by tricky code properties and always cleans up', { timeout: 10_000 }, async () => {
  const MARK = 'zz-local-http-getter-marker-6e0a';
  const markedError = () => Object.assign(new Error(`lower layer ${MARK}`), { detail: MARK });
  const tricks = {
    'a getter that returns an allowed word only on its first read': () => {
      let reads = 0;
      return Object.defineProperty(markedError(), 'code', {
        get() { reads++; return reads === 1 ? 'ECONNREFUSED' : MARK; }, enumerable: true });
    },
    'a getter that throws when read': () => Object.defineProperty(markedError(), 'code', {
      get() { throw Object.assign(new Error(`getter ${MARK}`), { code: MARK }); }, enumerable: true }),
    'a getter inherited from the prototype': () => {
      let reads = 0;
      const prototype = Object.create(Error.prototype, {
        code: { get() { reads++; return reads === 1 ? 'ECONNREFUSED' : MARK; }, enumerable: true },
      });
      return Object.setPrototypeOf(markedError(), prototype);
    },
    'a proxy that throws on any inspection': () => new Proxy(markedError(), {
      get() { throw new Error(`proxy get ${MARK}`); },
      getOwnPropertyDescriptor() { throw new Error(`proxy descriptor ${MARK}`); },
      has() { throw new Error(`proxy has ${MARK}`); },
    }),
  };
  const fakeResponse = () => Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, destroy() {} });
  const paths = {
    'thrown by the request function': make => ({ request: () => { throw make(); }, cleaned: () => true }),
    // 要求と応答の error は、本物と同じく後から（別のティックで）届ける。変換が投げると、Promise の外へ出る。
    'emitted as a request error': make => {
      const fake = fakeRequestFunction(req => setImmediate(() => req.emit('error', make())));
      return { request: fake.request, cleaned: () => fake.calls[0].req.destroyed };
    },
    'emitted as a response error': make => {
      const fake = fakeRequestFunction(req => setImmediate(() => {
        const res = fakeResponse();
        req.emit('response', res);
        res.emit('error', make());
      }));
      return { request: fake.request, cleaned: () => fake.calls[0].req.destroyed };
    },
  };
  for (const [trickName, make] of Object.entries(tricks)) {
    for (const [pathName, build] of Object.entries(paths)) {
      const { request, cleaned } = build(make);
      const name = `${trickName} / ${pathName}`;
      await assert.rejects(
        requestLocal({ request, port: 4804, path: '/internal/reload', method: 'POST',
          headers: { 'x-codex-rotator-token': HEADER_MARKER }, body: BODY_MARKER }),
        error => error instanceof LocalHttpError && error.code === 'ELOCALREQUEST' && !String(error.code).includes(MARK)
          && error.detail === undefined && carriesNoMarker(error, [MARK, HEADER_MARKER, BODY_MARKER]),
        name,
      );
      assert.equal(cleaned(), true, `the request is destroyed: ${name}`);
    }
  }
});

// 応答の処理の中で出た例外（headers・statusCode の読取、destroy）は、Promise の外へ出さずに reject する。
// 応答は本物と同じく後から（別のティックで）届ける。
test('local-http: requestLocal turns exceptions inside response handling into a clean rejection', { timeout: 10_000 }, async () => {
  const MARK = 'zz-local-http-response-marker-4c9f';
  const thrower = where => () => { throw Object.assign(new Error(`${where} ${MARK}`), { code: MARK, detail: MARK }); };
  const limit = 16;
  // 上限超えは先に決着するので、destroy が同期に投げても ELOCALTOOLARGE のまま。
  const expectedCodes = {
    'reading headers throws': 'ELOCALREQUEST',
    'destroy throws on a declared oversize body': 'ELOCALTOOLARGE',
    'destroy throws on a streamed oversize body': 'ELOCALTOOLARGE',
    'reading statusCode throws at the end': 'ELOCALREQUEST',
  };
  const cases = {
    'reading headers throws': (req) => {
      const res = new EventEmitter();
      Object.defineProperty(res, 'headers', { get: thrower('headers') });
      res.destroy = () => {};
      req.emit('response', res);
    },
    'destroy throws on a declared oversize body': (req) => {
      const res = Object.assign(new EventEmitter(), { headers: { 'content-length': String(limit + 1) }, statusCode: 200,
        destroy: thrower('destroy') });
      req.emit('response', res);
    },
    'destroy throws on a streamed oversize body': (req) => {
      const res = Object.assign(new EventEmitter(), { headers: {}, statusCode: 200, destroy: thrower('destroy') });
      req.emit('response', res);
      res.emit('data', Buffer.alloc(limit + 1));
    },
    'reading statusCode throws at the end': (req) => {
      const res = Object.assign(new EventEmitter(), { headers: {}, destroy() {} });
      Object.defineProperty(res, 'statusCode', { get: thrower('statusCode') });
      req.emit('response', res);
      res.emit('end');
    },
  };
  let escaped = 0;
  const onUncaught = () => { escaped++; };
  process.on('uncaughtException', onUncaught);
  try {
    for (const [name, respond] of Object.entries(cases)) {
      const { request, calls } = fakeRequestFunction(req => setImmediate(() => respond(req)));
      await assert.rejects(
        requestLocal({ request, port: 4805, path: '/internal/reload', method: 'POST', timeoutMs: 1000,
          maxResponseBytes: limit, headers: { 'x-codex-rotator-token': HEADER_MARKER }, body: BODY_MARKER }),
        error => error instanceof LocalHttpError && error.code === expectedCodes[name] && error.detail === undefined
          && carriesNoMarker(error, [MARK, HEADER_MARKER, BODY_MARKER]),
        name,
      );
      assert.equal(calls[0].req.destroyed, true, `the request is destroyed: ${name}`);
    }
  } finally {
    process.removeListener('uncaughtException', onUncaught);
  }
  assert.equal(escaped, 0, 'no exception escaped the promise');
});

// 下の層の出来事の順序の表（前提1〜3の内側。基本の順序に、code の getter が読むたびに
// 値を変える行・headers が投げる行などを足したもの）。
//
// 行の書き方:
//   steps の要素は1つの出来事。modes の 'ticks' は各出来事を別のティックで出し、'same-turn' は期限以外の
//   連続した出来事を1つの手番で続けて出す（受け手の関数が戻ってから次を出すので、前提2の内側）。
//   出来事: response:<名前>[:<種類>]（初回は種類で作る。2回目以降は同じオブジェクトを再通知）・
//     data:<名前>:<バイト数>・end:<名前>・close:<名前>・res-error:<名前>:<code>・req-error:<code|flip>・deadline
//   応答の種類: ok（200）・second（201）・headers-throw・status-throw・declared-oversize。+destroy-throws で
//     destroy が同期に投げる。
//   request: 'throws:<code>'（要求関数が投げる）・'end-throws:<code>'（end が投げる）・'destroy-throws'
//     （要求の destroy が投げる）。
//   code の MARK は目印（許していない code）に置き換える。
// 各行で数えること: 決着の回数・結果（code は直書き）・目印と cause が例外に無いこと（メッセージ・スタック・
//   JSON・util.inspect）・外へ出た例外（uncaughtException・unhandledRejection）が0件・要求の end の回数・
//   要求と各応答の破棄の回数・受け手の重複・期限の解除の回数。
const ORDER_LIMIT = 8;
const ORDER_DEADLINE_MS = 40;
const BOTH = ['ticks', 'same-turn'];
const TICKS = ['ticks'];
const ORDER_TABLE = [
  // 成功（後から届く通知で結果が変わらない）
  { name: 'body and end, then a late error and close', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:3', 'end:R1', 'res-error:R1:MARK', 'close:R1'], expect: { status: 200, body: 'aaa' } },
  { name: 'empty body, then a late error', modes: BOTH,
    steps: ['response:R1:ok', 'end:R1', 'res-error:R1:MARK'], expect: { status: 200, body: '' } },
  { name: 'body exactly at the limit', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:8', 'end:R1'], expect: { status: 200, body: 'a'.repeat(8) } },
  // 上限超え（先に決着し、破棄が投げても code は変わらない）
  { name: 'declared oversize, then the response errors and closes', modes: TICKS,
    steps: ['response:R1:declared-oversize', 'res-error:R1:MARK', 'close:R1'], expect: { code: 'ELOCALTOOLARGE' } },
  { name: 'declared oversize whose destroy throws, then the response errors and closes', modes: TICKS,
    steps: ['response:R1:declared-oversize+destroy-throws', 'res-error:R1:MARK', 'close:R1'], expect: { code: 'ELOCALTOOLARGE' } },
  { name: 'streamed oversize, then end and a late error', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:5', 'data:R1:4', 'end:R1', 'res-error:R1:MARK'], expect: { code: 'ELOCALTOOLARGE' } },
  { name: 'streamed oversize whose destroy throws, then end and a late error', modes: BOTH,
    steps: ['response:R1:ok+destroy-throws', 'data:R1:5', 'data:R1:4', 'end:R1', 'res-error:R1:MARK'], expect: { code: 'ELOCALTOOLARGE' } },
  // 途中切れ
  { name: 'partial body and close, then an error and end', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:2', 'close:R1', 'res-error:R1:MARK', 'end:R1'], expect: { code: 'ELOCALCUTOFF' } },
  // 下の層の error
  { name: 'request error with an allowed code, then another request error', modes: TICKS,
    steps: ['req-error:ECONNRESET', 'req-error:MARK'], expect: { code: 'ECONNRESET' } },
  { name: 'response error with an allowed code, then end and close', modes: TICKS,
    steps: ['response:R1:ok', 'res-error:R1:ECONNRESET', 'end:R1', 'close:R1'], expect: { code: 'ECONNRESET' } },
  { name: 'response error with another code, then end and close', modes: TICKS,
    steps: ['response:R1:ok', 'res-error:R1:MARK', 'end:R1', 'close:R1'], expect: { code: 'ELOCALREQUEST' } },
  { name: 'request error with a lying code getter, then another request error', modes: TICKS,
    steps: ['req-error:flip', 'req-error:MARK'], expect: { code: 'ELOCALREQUEST' } },
  // 期限
  { name: 'no response, deadline, then request errors', modes: TICKS, deadline: true,
    steps: ['deadline', 'req-error:MARK', 'req-error:ECONNRESET'], expect: { code: 'ELOCALTIMEOUT' } },
  { name: 'deadline in the middle of the body, then errors and close', modes: TICKS, deadline: true,
    steps: ['response:R1:ok', 'data:R1:2', 'deadline', 'res-error:R1:MARK', 'req-error:MARK', 'close:R1'], expect: { code: 'ELOCALTIMEOUT' } },
  { name: 'deadline while the request destroy throws, then a request error', modes: TICKS, deadline: true, request: 'destroy-throws',
    steps: ['deadline', 'req-error:MARK'], expect: { code: 'ELOCALTIMEOUT' } },
  // 決着の後に届いた応答（読まずに、error を受けられる状態にして破棄する）
  { name: 'request error first, then a late response with throwing headers that errors and closes', modes: TICKS,
    steps: ['req-error:ECONNREFUSED', 'response:R1:headers-throw', 'res-error:R1:MARK', 'close:R1'], expect: { code: 'ECONNREFUSED' } },
  { name: 'deadline, then a late response with throwing headers that errors, and the request errors', modes: TICKS, deadline: true,
    steps: ['deadline', 'response:R1:headers-throw', 'res-error:R1:MARK', 'req-error:MARK'], expect: { code: 'ELOCALTIMEOUT' } },
  // 応答の重複（最初の応答だけを採る）
  { name: 'the same response notified twice, then 5 bytes and end', modes: BOTH,
    steps: ['response:R1:ok', 'response:R1', 'data:R1:5', 'end:R1'], expect: { status: 200, body: 'aaaaa' } },
  { name: 'a second response mixed in, notified twice, errors and closes, then the first ends', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:2', 'response:R2:second', 'response:R2', 'data:R2:3', 'res-error:R2:MARK', 'close:R2', 'end:R1'],
    expect: { status: 200, body: 'aa' } },
  { name: 'a second response whose destroy throws, then the first ends', modes: BOTH,
    steps: ['response:R1:ok', 'data:R1:2', 'response:R2:second+destroy-throws', 'response:R2', 'res-error:R2:MARK', 'end:R1'],
    expect: { status: 200, body: 'aa' } },
  { name: 'success, then the first response again, then a second response that errors', modes: TICKS,
    steps: ['response:R1:ok', 'data:R1:1', 'end:R1', 'response:R1', 'response:R2:second', 'res-error:R2:MARK'],
    expect: { status: 200, body: 'a' } },
  // 読取が投げる
  { name: 'headers throw, then the response errors', modes: TICKS,
    steps: ['response:R1:headers-throw', 'res-error:R1:MARK'], expect: { code: 'ELOCALREQUEST' } },
  { name: 'statusCode throws at the end, then the response errors and closes', modes: TICKS,
    steps: ['response:R1:status-throw', 'data:R1:2', 'end:R1', 'res-error:R1:MARK', 'close:R1'], expect: { code: 'ELOCALREQUEST' } },
  // 要求関数・end が同期に投げる
  { name: 'the request function throws an allowed code', modes: TICKS, request: 'throws:ECONNREFUSED',
    steps: [], expect: { code: 'ECONNREFUSED' } },
  { name: 'the request function throws another code', modes: TICKS, request: 'throws:MARK',
    steps: [], expect: { code: 'ELOCALREQUEST' } },
  { name: 'req.end throws an allowed code', modes: TICKS, request: 'end-throws:EPIPE',
    steps: [], expect: { code: 'EPIPE' } },
  { name: 'req.end throws another code', modes: TICKS, request: 'end-throws:MARK',
    steps: [], expect: { code: 'ELOCALREQUEST' } },
];

test('local-http: requestLocal settles once, cleans up once and lets nothing escape, for every row of the event order table', { timeout: 60_000 }, async () => {
  const MARK = 'zz-local-http-order-marker-2a8d';
  const codeOf = code => (code === 'MARK' ? MARK : code);
  const marked = code => Object.assign(new Error(`lower layer ${MARK}`), { code: codeOf(code), detail: MARK });
  const lyingCode = () => {
    let reads = 0;
    return Object.defineProperty(marked('MARK'), 'code', { get() { reads++; return reads === 1 ? 'ECONNREFUSED' : MARK; } });
  };
  const throwing = () => { throw marked('MARK'); };
  const makeResponse = (name, kindText) => {
    const [kind, extra] = kindText.split('+');
    const res = new EventEmitter();
    res.name = name;
    res.destroyCount = 0;
    res.destroy = () => {
      res.destroyCount++;
      if (extra === 'destroy-throws') throw marked('MARK');
    };
    if (kind === 'headers-throw') Object.defineProperty(res, 'headers', { get: throwing });
    else res.headers = kind === 'declared-oversize' ? { 'content-length': String(ORDER_LIMIT + 1) } : {};
    if (kind === 'status-throw') Object.defineProperty(res, 'statusCode', { get: throwing });
    else res.statusCode = kind === 'second' ? 201 : 200;
    return res;
  };
  const fillOf = name => (name === 'R1' ? 0x61 : 0x62);

  // 出来事の並びを手番に分ける（'ticks' は1つずつ、'same-turn' は期限以外の連続を1つに）。
  const turnsOf = (steps, mode) => {
    const turns = [];
    for (const step of steps) {
      const last = turns[turns.length - 1];
      if (step === 'deadline' || mode === 'ticks' || !Array.isArray(last)) turns.push(step === 'deadline' ? step : [step]);
      else last.push(step);
    }
    return turns;
  };
  // 1つの手番を別のティックで出す。出来事が投げても（受け手が無い error など）次へ進めるよう、先に次の
  // 手番を予約してから出す（投げた例外は uncaughtException として数えられる）。
  const deliver = actions => new Promise(resolve => setImmediate(() => {
    setImmediate(resolve);
    for (const action of actions) action();
  }));

  let escaped = 0;
  const onEscape = () => { escaped++; };
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  try {
    for (const row of ORDER_TABLE) {
      for (const mode of row.modes) {
        const label = `${row.name} [${mode}]`;
        const escapedBefore = escaped;
        const [requestKind, requestArg] = (row.request ?? '').split(':');
        let req = null;
        let endCount = 0;
        let reqDestroyCount = 0;
        const responses = new Map();
        const request = () => {
          if (requestKind === 'throws') throw marked(requestArg);
          req = new EventEmitter();
          req.destroy = () => {
            reqDestroyCount++;
            if (requestKind === 'destroy-throws') throw marked('MARK');
          };
          req.end = () => {
            endCount++;
            if (requestKind === 'end-throws') throw marked(requestArg);
          };
          return req;
        };

        // 期限のタイマーを見分ける: requestLocal を呼んでいる間（同期）に作られたタイマーだけを記録する。
        const timers = [];
        const cleared = [];
        globalThis.setTimeout = (...args) => {
          const handle = realSetTimeout(...args);
          timers.push(handle);
          return handle;
        };
        globalThis.clearTimeout = handle => {
          cleared.push(handle);
          return realClearTimeout(handle);
        };
        const outcomes = [];
        let pending;
        try {
          pending = requestLocal({ request, port: 4806, path: '/internal/reload', method: 'POST',
            timeoutMs: row.deadline ? ORDER_DEADLINE_MS : 5000, maxResponseBytes: ORDER_LIMIT,
            headers: { 'x-codex-rotator-token': HEADER_MARKER }, body: BODY_MARKER })
            .then(value => outcomes.push({ value }), error => outcomes.push({ error }));
        } finally {
          globalThis.setTimeout = realSetTimeout;
        }

        const act = step => {
          const [kind, name, arg] = step.split(':');
          if (kind === 'response') {
            if (!responses.has(name)) responses.set(name, makeResponse(name, arg));
            return () => req.emit('response', responses.get(name));
          }
          if (kind === 'data') return () => responses.get(name).emit('data', Buffer.alloc(Number(arg), fillOf(name)));
          if (kind === 'end' || kind === 'close') return () => responses.get(name).emit(kind);
          if (kind === 'res-error') return () => responses.get(name).emit('error', marked(arg));
          if (kind === 'req-error') return () => req.emit('error', name === 'flip' ? lyingCode() : marked(name));
          throw new Error(`unknown step ${step}`);
        };
        try {
          for (const turn of turnsOf(row.steps, mode)) {
            if (turn === 'deadline') await new Promise(resolve => realSetTimeout(resolve, ORDER_DEADLINE_MS + 60));
            else await deliver(turn.map(act));
          }
          await pending;
          await new Promise(resolve => setImmediate(resolve));
        } finally {
          globalThis.clearTimeout = realClearTimeout;
        }

        // 決着は1回・期限は1回だけ作られ、1回だけ解除される。
        assert.equal(outcomes.length, 1, `settled once: ${label}`);
        assert.equal(timers.length, 1, `one deadline timer: ${label}`);
        assert.equal(cleared.filter(handle => handle === timers[0]).length, 1, `the deadline is cleared once: ${label}`);
        const [outcome] = outcomes;
        const rejected = row.expect.code !== undefined;
        if (rejected) {
          const { error } = outcome;
          assert.ok(error instanceof LocalHttpError, `rejected with LocalHttpError: ${label}`);
          assert.equal(error.code, row.expect.code, label);
          assert.equal(error.detail, undefined, label);
          assert.ok(carriesNoMarker(error, [MARK, HEADER_MARKER, BODY_MARKER]), `no marker and no cause: ${label}`);
        } else {
          assert.equal(outcome.error, undefined, label);
          assert.equal(outcome.value.status, row.expect.status, label);
          assert.equal(outcome.value.body, row.expect.body, label);
        }
        // 要求: end は1回（要求関数が投げたときは要求が無い）。破棄は reject なら1回、成功なら0回。
        if (requestKind === 'throws') {
          assert.equal(req, null, label);
        } else {
          assert.equal(endCount, 1, `end once: ${label}`);
          assert.equal(reqDestroyCount, rejected ? 1 : 0, `request destroyed ${rejected ? 'once' : 'never'}: ${label}`);
          assert.equal(req.listenerCount('error'), 1, `one request error listener: ${label}`);
          assert.equal(req.listenerCount('response'), 1, `one response listener: ${label}`);
        }
        // 応答: reject ならすべて1回ずつ破棄。成功なら採用した R1 は0回、ほかは1回ずつ。受け手は重ならない。
        for (const [name, res] of responses) {
          const expected = rejected || name !== 'R1' ? 1 : 0;
          assert.equal(res.destroyCount, expected, `${name} destroyed ${expected} time(s): ${label}`);
          for (const event of ['error', 'close', 'data', 'end']) {
            assert.ok(res.listenerCount(event) <= 1, `${name} has at most one ${event} listener: ${label}`);
          }
        }
        assert.equal(escaped - escapedBefore, 0, `nothing escaped: ${label}`);
      }
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    process.removeListener('uncaughtException', onEscape);
    process.removeListener('unhandledRejection', onEscape);
  }
  assert.equal(escaped, 0);
});

// 実の接続の失敗（待受を閉じた番号への接続）の code も、そのまま引き継ぐ（常駐が無いときの判定）。
test('local-http: requestLocal forwards a real ECONNREFUSED from a closed listener', async t => {
  const isolation = await setupCodexIsolation(t);
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  assert.ok(!REAL_SERVICE_PORTS.includes(port));
  isolation.allowRequest(port);
  await new Promise(resolve => server.close(() => resolve()));
  await assert.rejects(requestLocal({ request: isolation.request, port, path: '/internal/status' }),
    error => error instanceof LocalHttpError && error.code === 'ECONNREFUSED');
  assert.deepEqual(isolation.connections.map(({ port: p }) => p), [port]);
});

test('local-http: requestLocal forwards only the allowed connection codes (ECONNREFUSED stays as is)', async () => {
  const MARK = 'zz-local-http-forwarded-marker-8b1c';
  for (const code of FORWARDED_CODES) {
    const lower = () => Object.assign(new Error(`lower layer ${MARK}`), { code });
    // 保証外の回帰テスト: 前提2の外（end の中の同期の出来事）。
    const viaEvent = fakeRequestFunction(req => req.emit('error', lower())).request;
    const viaThrow = () => { throw lower(); };
    for (const request of [viaEvent, viaThrow]) {
      await assert.rejects(requestLocal({ request, port: 4802, path: '/internal/status' }),
        error => error instanceof LocalHttpError && error.code === code && carriesNoMarker(error, [MARK]), code);
    }
  }
  // 一覧に無い code と、code の無い例外は ELOCALREQUEST。
  // 保証外の回帰テスト: 前提2の外（end の中の同期の出来事）。
  for (const code of ['ENOTFOUND', 'econnrefused', 'ERR_INVALID_URL', 42, undefined]) {
    const request = fakeRequestFunction(req => req.emit('error', Object.assign(new Error('x'), { code }))).request;
    await assert.rejects(requestLocal({ request, port: 4803, path: '/internal/status' }),
      error => error instanceof LocalHttpError && error.code === 'ELOCALREQUEST', String(code));
  }
});

test('local-http: requestLocal refuses a response larger than the limit (declared or streamed)', async t => {
  const isolation = await setupCodexIsolation(t);
  const limit = 64;
  const { port } = await openFakeDaemon(t, isolation, (req, res) => {
    if (req.url === '/declared') {
      res.setHeader('content-length', String(limit + 1));
      res.end('x'.repeat(limit + 1));
    } else if (req.url === '/streamed') {
      // content-length を付けず、分けて送る。
      res.write('y'.repeat(limit));
      setImmediate(() => res.end('y'.repeat(limit)));
    } else {
      res.end('z'.repeat(limit));
    }
  });
  for (const path of ['/declared', '/streamed']) {
    await assert.rejects(requestLocal({ request: isolation.request, port, path, maxResponseBytes: limit }),
      error => error instanceof LocalHttpError && error.code === 'ELOCALTOOLARGE', path);
  }
  // ちょうど上限の大きさは受け取る。
  const exact = await requestLocal({ request: isolation.request, port, path: '/exact', maxResponseBytes: limit });
  assert.equal(exact.body, 'z'.repeat(limit));
});

test('local-http: requestLocal rejects when the response is cut off before its end', async t => {
  const isolation = await setupCodexIsolation(t);
  const { port } = await openFakeDaemon(t, isolation, (req, res) => {
    res.setHeader('content-length', '100');
    res.write('partial');
    setImmediate(() => res.socket.destroy());
  });
  await assert.rejects(requestLocal({ request: isolation.request, port, path: '/internal/status' }),
    error => error instanceof LocalHttpError && ['ELOCALCUTOFF', 'ECONNRESET'].includes(error.code));
});
