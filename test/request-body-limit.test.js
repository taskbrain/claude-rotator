// 受信本文の上限（`proxy.maxRequestBodyBytes`・既定 64 MiB）。
//
// 上流は 127.0.0.1 の一時ポートに立てた偽サーバであり、実 API・実サービスへは到達しない。
// 資格情報は MemorySecretStore に置いた合成値だけを使う。

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';

import { AccountManager } from '../src/account-manager.js';
import { MemorySecretStore } from '../src/secret-store.js';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  createProxyServer,
  readRequestBody,
} from '../src/proxy-server.js';

const cleanupCallbacks = [];

afterEach(async () => {
  for (const callback of cleanupCallbacks.splice(0).reverse()) await callback();
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref?.();
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

function send(url, { body, chunked = false }) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: chunked
        ? { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunked) {
      const half = Math.floor(body.length / 2);
      req.write(body.slice(0, half));
      req.write(body.slice(half));
    } else {
      req.write(body);
    }
    req.end();
  });
}

async function startProxy({ maxRequestBodyBytes, requestBodyDrain, startupCheckGate = null } = {}) {
  const upstreamBodies = [];
  // 本文を読み終える前に中継が上流への要求を打ち切っても数えられるよう、届いた時点で数える。
  const upstreamArrivals = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    upstreamArrivals.push(req.url);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', { accessToken: 'synthetic-access-token' });
  if (startupCheckGate) {
    // 起動時の資格情報の確認を、渡した約束が解けるまで止める。要求はこの確認を待ってから本文を読む。
    const run = secretStore.runCredentialSetExclusive.bind(secretStore);
    secretStore.runCredentialSetExclusive = async operation => {
      await startupCheckGate;
      return run(operation);
    };
  }
  const accountManager = new AccountManager({ accounts: [{ id: 'acct_1', type: 'oauth' }] });
  const logs = [];
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    logger: line => logs.push(line),
    ...(requestBodyDrain ? { requestBodyDrain } : {}),
    // 実機の資格情報・実 API へは触れさせない（呼ばれたら失敗させる）。
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: () => { throw new Error('test must not read live credentials'); },
    currentProfileFetcher: () => { throw new Error('test must not fetch a profile'); },
    usageFetcher: () => { throw new Error('test must not fetch usage'); },
    tokenRefresher: () => { throw new Error('test must not refresh tokens'); },
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      ...(maxRequestBodyBytes === undefined ? {} : { proxy: { maxRequestBodyBytes } }),
    },
  }));
  cleanupCallbacks.push(async () => {
    await close(proxy.server);
    await close(upstream.server);
  });
  return { proxy, upstreamBodies, upstreamArrivals, logs };
}

function jsonBody(totalBytes) {
  const prefix = '{"model":"sonnet","pad":"';
  const suffix = '"}';
  return prefix + 'a'.repeat(totalBytes - prefix.length - suffix.length) + suffix;
}

describe('request body limit', () => {
  it('defaults to a limit that is not below the Messages API request size limit (32 MB)', () => {
    assert.equal(DEFAULT_MAX_REQUEST_BODY_BYTES, 64 * 1024 * 1024);
    assert.ok(DEFAULT_MAX_REQUEST_BODY_BYTES >= 32 * 1000 * 1000);
    assert.ok(DEFAULT_MAX_REQUEST_BODY_BYTES >= 32 * 1024 * 1024);
  });

  it('answers 413 request_too_large when Content-Length exceeds the limit, without reaching upstream', async () => {
    const { proxy, upstreamBodies, logs } = await startProxy({ maxRequestBodyBytes: 1024 });
    const response = await send(`${proxy.url}/v1/messages`, { body: jsonBody(4096) });
    assert.equal(response.status, 413);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.text), {
      type: 'error',
      error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' },
    });
    assert.equal(upstreamBodies.length, 0);
    assert.ok(logs.some(line => line.includes('error=request_too_large limitBytes=1024')));
  });

  it('stops reading a chunked body once it exceeds the limit and answers 413', async () => {
    const { proxy, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024 });
    const response = await send(`${proxy.url}/v1/messages`, { body: jsonBody(4096), chunked: true });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.text).error.type, 'request_too_large');
    assert.equal(upstreamBodies.length, 0);
  });

  it('forwards a body exactly at the limit unchanged', async () => {
    const { proxy, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024 });
    const body = jsonBody(1024);
    const response = await send(`${proxy.url}/v1/messages`, { body, chunked: true });
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].toString('utf8'), body);
  });

  it('falls back to the default limit when the configured value is not a positive integer, with a warning', async () => {
    const { proxy, upstreamBodies, logs } = await startProxy({ maxRequestBodyBytes: 'huge' });
    const response = await send(`${proxy.url}/v1/messages`, { body: jsonBody(4096) });
    assert.equal(response.status, 200);
    assert.equal(upstreamBodies.length, 1);
    const warnings = logs.filter(line => line.includes('config-warning proxy.maxRequestBodyBytes'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /using default 67108864/);
  });

  it('does not warn when the key is absent', async () => {
    const { logs } = await startProxy();
    assert.equal(logs.some(line => line.includes('maxRequestBodyBytes')), false);
  });
});

// 回帰（L1 指摘）: 上限を超えた後もクライアントが送信を続けていると、読み込みを止めて
// 閉じた時点で RST になり 413 が捨てられていた。残りを読み捨ててから閉じることで、
// クライアントは毎回 413 を受け取る。
const BIG_BODY = Buffer.alloc(4 * 1024 * 1024, 0x61);
// 安定性を確かめるときは BODY_LIMIT_REPEAT で回数を増やす（例: 100）。
const REPEAT = Number(process.env.BODY_LIMIT_REPEAT) || 10;

// 送信中に応答を受け取れるよう、応答・送信エラー・ソケットの close をすべて拾う。
function sendBig(url, { mode, body = BIG_BODY, writeAll = true }) {
  const target = new URL(url);
  return new Promise(resolve => {
    const result = { status: null, error: null, text: '' };
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      agent: false,
      headers: mode === 'content-length'
        ? { 'content-type': 'application/json', 'content-length': body.length }
        : { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, res => {
      result.status = res.statusCode;
      res.on('data', chunk => { result.text += chunk; });
      res.on('error', () => {});
    });
    req.on('error', error => { result.error ??= error.code; });
    req.on('socket', socket => socket.on('close', () => resolve(result)));
    if (!writeAll) {
      req.write(body.subarray(0, 2048));
      return;
    }
    const step = 256 * 1024;
    for (let offset = 0; offset < body.length; offset += step) {
      req.write(body.subarray(offset, offset + step));
    }
    req.end();
  });
}

describe('request body limit while the client is still sending', () => {
  for (const mode of ['chunked', 'content-length']) {
    it(`${mode}: the client receives 413 every time (${REPEAT} rounds, 4 MiB against 1024)`, async () => {
      const { proxy, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024 });
      const statuses = [];
      for (let round = 0; round < REPEAT; round += 1) {
        const result = await sendBig(`${proxy.url}/v1/messages`, { mode });
        statuses.push(result.status ?? result.error);
        assert.equal(result.status, 413, `round ${round}: ${result.status ?? result.error}`);
        assert.equal(JSON.parse(result.text).error.type, 'request_too_large');
      }
      assert.deepEqual(statuses, Array(REPEAT).fill(413));
      assert.equal(upstreamBodies.length, 0);
    });
  }

  it('destroys the connection once the discarded bytes exceed the drain cap (no hang)', async () => {
    const { proxy, logs } = await startProxy({
      maxRequestBodyBytes: 1024,
      requestBodyDrain: { maxBytes: 64 * 1024, timeoutMs: 10_000 },
    });
    const startedAt = Date.now();
    const result = await sendBig(`${proxy.url}/v1/messages`, { mode: 'chunked' });
    assert.ok(Date.now() - startedAt < 5_000);
    assert.ok(result.status === 413 || result.error, JSON.stringify(result));
    assert.ok(logs.some(line => line.includes('request-body-drain aborted reason=bytes')));
    const open = await new Promise(resolve => proxy.server.getConnections((_e, count) => resolve(count)));
    assert.equal(open, 0);
  });

  // Node の http クライアントは `Connection: close` の応答を読み終えると自分で閉じるので、
  // 送信を止めたまま接続を保つクライアントは生ソケットで作る。
  it('destroys the connection when the client stalls past the drain timeout (no hang)', async () => {
    const { proxy, logs } = await startProxy({
      maxRequestBodyBytes: 1024,
      requestBodyDrain: { maxBytes: 64 * 1024 * 1024, timeoutMs: 200 },
    });
    const { port } = new URL(proxy.url);
    const startedAt = Date.now();
    const received = await new Promise((resolve, reject) => {
      const chunks = [];
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
          + `Content-Length: ${1024 * 1024}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(2048, 0x61));
      });
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('error', () => {});
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      setTimeout(() => reject(new Error('server did not close the stalled connection')), 5_000).unref();
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 150 && elapsed < 5_000, `elapsed ${elapsed}`);
    assert.match(received, /^HTTP\/1\.1 413 /);
    assert.match(received, /request_too_large/);
    assert.ok(logs.some(line => line.includes('request-body-drain aborted reason=timeout')));
  });
});

// 413 を返した接続は `Connection: close` で閉じるが、Node は閉じるまでの間に同じ接続で
// 続けて届いた（パイプライン化された）要求も処理関数へ渡す。その要求を上流へ転送すると、
// 応答はクライアントへ届かずに捨てられるので、転送しない。
function rawRequest(head, body = '') {
  return `${head}\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n`
    + (body === null ? '' : `Content-Length: ${Buffer.byteLength(body)}\r\n`)
    + `\r\n${body ?? ''}`;
}

// 生のソケットで1回の write にまとめて送り、サーバが閉じるまでに届いたバイト列を返す。
function sendOnOneConnection(url, payload) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(Number(port), '127.0.0.1', () => socket.write(payload));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
    setTimeout(() => reject(new Error('server did not close the connection')), 5_000).unref();
  });
}

// 上流へ届かないこと（不在）を確かめるので、接続が閉じた後に一定の時間だけ待つ。
const ABSENCE_WAIT_MS = 200;

describe('requests sent on the same connection after a 413', () => {
  const FOLLOWING = rawRequest('POST /v1/messages HTTP/1.1', '{"model":"sonnet"}');

  it('does not forward a request pipelined after a body whose Content-Length exceeds the limit', async () => {
    const { proxy, upstreamArrivals, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024 });
    const tooLarge = rawRequest('POST /v1/messages HTTP/1.1', 'a'.repeat(2048));

    const received = await sendOnOneConnection(proxy.url, tooLarge + FOLLOWING);
    await new Promise(resolve => setTimeout(resolve, ABSENCE_WAIT_MS));

    assert.deepEqual(received.match(/^HTTP\/1\.1 \d{3}/gm), ['HTTP/1.1 413']);
    assert.deepEqual(upstreamArrivals, []);
    assert.equal(upstreamBodies.length, 0);
  });

  it('does not forward a request pipelined after a chunked body that exceeds the limit', async () => {
    const { proxy, upstreamArrivals, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024 });
    const chunk = 'a'.repeat(4096);
    const tooLarge = rawRequest('POST /v1/messages HTTP/1.1\r\nTransfer-Encoding: chunked', null)
      + `${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`;

    const received = await sendOnOneConnection(proxy.url, tooLarge + FOLLOWING);
    await new Promise(resolve => setTimeout(resolve, ABSENCE_WAIT_MS));

    assert.deepEqual(received.match(/^HTTP\/1\.1 \d{3}/gm), ['HTTP/1.1 413']);
    assert.deepEqual(upstreamArrivals, []);
    assert.equal(upstreamBodies.length, 0);
  });

  it('does not forward a pipelined request whose handler started before the 413 was found', async () => {
    // 起動時の確認が終わるまで、どちらの要求も本文を読み始めない。続く要求の処理関数はその間に
    // 始まるので、処理関数の先頭では印がまだ無く、本文を読み終えた後の確かめで捨てる。
    let releaseStartupCheck;
    const startupCheckGate = new Promise(resolve => { releaseStartupCheck = resolve; });
    const { proxy, upstreamArrivals, upstreamBodies } = await startProxy({ maxRequestBodyBytes: 1024, startupCheckGate });
    let started = 0;
    const bothStarted = new Promise((resolve, reject) => {
      proxy.server.on('request', () => { started += 1; if (started === 2) resolve(); });
      setTimeout(() => reject(new Error(`only ${started} request(s) reached the proxy`)), 5_000).unref();
    });
    const tooLarge = rawRequest('POST /v1/messages HTTP/1.1', 'a'.repeat(2048));

    const closed = sendOnOneConnection(proxy.url, tooLarge + FOLLOWING);
    await bothStarted;
    releaseStartupCheck();
    const received = await closed;
    await new Promise(resolve => setTimeout(resolve, ABSENCE_WAIT_MS));

    assert.deepEqual(received.match(/^HTTP\/1\.1 \d{3}/gm), ['HTTP/1.1 413']);
    assert.deepEqual(upstreamArrivals, []);
    assert.equal(upstreamBodies.length, 0);
  });
});

describe('a client that disconnects while the 413 is discarding its body', () => {
  it('stops discarding without an exception, a leftover connection or an aborted-drain log line', async () => {
    const { proxy, logs } = await startProxy({
      maxRequestBodyBytes: 1024,
      requestBodyDrain: { maxBytes: 64 * 1024 * 1024, timeoutMs: 100 },
    });
    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUncaught);
    cleanupCallbacks.push(() => {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUncaught);
    });
    const { port } = new URL(proxy.url);

    const received = await new Promise((resolve, reject) => {
      let text = '';
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
          + `Content-Length: ${1024 * 1024}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(4096, 0x61));
      });
      socket.on('data', chunk => {
        text += chunk.toString('latin1');
        // 413 のヘッダを受け取った時点で、本文を送り切らずに切断する。
        if (text.includes('\r\n\r\n')) socket.destroy();
      });
      socket.on('error', () => {});
      socket.on('close', () => resolve(text));
      setTimeout(() => reject(new Error('the 413 did not arrive')), 5_000).unref();
    });
    // 読み捨ての打ち切りの時計（100ms）が残っていれば、この間に動いてログを出す。
    await new Promise(resolve => setTimeout(resolve, 300));

    assert.match(received, /^HTTP\/1\.1 413 /);
    assert.deepEqual(logs.filter(line => line.includes('request-body-drain aborted')), []);
    const open = await new Promise(resolve => proxy.server.getConnections((_e, count) => resolve(count)));
    assert.equal(open, 0);
    assert.deepEqual(uncaught, []);
  });
});

describe('readRequestBody', () => {
  it('rejects with REQUEST_BODY_TOO_LARGE after the limit and stops listening for data', async () => {
    const stream = new PassThrough();
    stream.headers = {};
    const pending = readRequestBody(stream, 8);
    stream.write(Buffer.alloc(5));
    stream.write(Buffer.alloc(5));
    await assert.rejects(pending, error => error.code === 'REQUEST_BODY_TOO_LARGE' && error.limitBytes === 8);
    assert.equal(stream.listenerCount('data'), 0);
    assert.equal(stream.isPaused(), true);
  });

  it('resolves the whole body when it fits', async () => {
    const stream = new PassThrough();
    stream.headers = {};
    const pending = readRequestBody(stream, 8);
    stream.end(Buffer.from('12345678'));
    assert.equal((await pending).toString('utf8'), '12345678');
  });
});
