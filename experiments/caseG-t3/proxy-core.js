import http from 'node:http';
import https from 'node:https';
import { constants, writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createKeychainStore, isTestRuntime, loadConfig, openExternalFile, projectCredentials, validateMode } from './passthrough-proxy.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);
const unavailable = () => new Error('Prototype operation unavailable');

function endToEnd(headers) {
  const blocked = new Set([...HOP, ...String(headers.connection ?? '').toLowerCase().split(',').map(v => v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function upstreamTarget(value, injected) {
  try {
    const target = new URL(value);
    const production = target.protocol === 'https:' && target.hostname === 'api.anthropic.com'
      && (!target.port || target.port === '443');
    const fake = isTestRuntime() && injected && target.protocol === 'http:' && target.hostname === '127.0.0.1'
      && Number(target.port) > 0 && Number(target.port) !== 37891;
    if ((!production && !fake) || target.username || target.password || target.pathname !== '/'
      || target.search || target.hash || (isTestRuntime() && !fake)) throw unavailable();
    return target;
  } catch { throw unavailable(); }
}

function credentials(store, account, margin, now) {
  let cached = null;
  let pending = null;
  let stopped = null;
  function stop(reason) { stopped ||= reason; cached = null; }
  async function get() {
    if (stopped) throw unavailable();
    if (cached && cached.expiresAt > now() + margin) return cached.accessToken;
    if (!pending) pending = (async () => {
      try {
        let item = await store.read(account);
        const next = item.credentialJson !== undefined
          ? projectCredentials(item.credentialJson, item.modifiedAt)
          : projectCredentials(JSON.stringify({ accessToken: item.accessToken, expiresAt: item.expiresAt }), item.modifiedAt);
        item = null;
        if (cached && (next.expiresAt < cached.expiresAt || next.modifiedAt < cached.modifiedAt)) {
          stop('r8_suspected');
          throw unavailable();
        }
        if (stopped) throw unavailable();
        if (next.expiresAt <= now() + margin) throw unavailable();
        cached = next;
      } catch {
        stop('credential_unavailable');
        throw unavailable();
      }
    })().finally(() => { pending = null; });
    await pending;
    if (stopped || !cached || cached.expiresAt <= now() + margin) {
      stop('credential_unavailable');
      throw unavailable();
    }
    return cached.accessToken;
  }
  return { get, stop, reason: () => stopped,
    matches: value => Boolean(cached && value === `Bearer ${cached.accessToken}`) };
}

export async function createProxy(options = {}) {
  const { configFile, env = process.env, mode, apply, port = 37991, store,
    now = Date.now, upstream = 'https://api.anthropic.com' } = options;
  if (env.CASEG_PROTO_ENABLE !== '1' || apply !== true || !configFile) throw unavailable();
  validateMode(mode);
  const testing = isTestRuntime();
  if (!testing && ['upstream', 'store', 'port', 'now', 'timeoutMs'].some(key => options[key] !== undefined)) throw unavailable();
  if (testing && (options.upstream === undefined || !store || typeof store.read !== 'function')) throw unavailable();
  if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 37891) throw unavailable();
  const target = upstreamTarget(upstream, options.upstream !== undefined);
  const config = await loadConfig(configFile, { env });
  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw unavailable();
  if (mode === 'swap-messages' && !config.swapAccount) throw unavailable();
  const auth = mode === 'swap-messages'
    ? credentials(store ?? createKeychainStore(), config.swapAccount, config.expiryMarginMs, now) : null;
  let logHandle;
  try {
    logHandle = await openExternalFile(config.logPath, { env,
      flags: constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, mode: 0o600 });
    const info = await logHandle.stat();
    if (!info.isFile() || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw unavailable();
    await logHandle.chmod(0o600);
  } catch {
    if (logHandle) await logHandle.close();
    throw unavailable();
  }
  let count = 0;
  let failed = false;
  let closing = false;
  let finishClose;
  const closed = new Promise(resolve => { finishClose = resolve; });
  const active = new Set();
  const server = http.createServer((req, res) => { void handle(req, res); });
  const close = async () => {
    if (!closing) {
      closing = true;
      auth?.stop('stopped');
      for (const abort of active) abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await logHandle.close();
      finishClose();
    }
    return closed;
  };

  async function handle(req, res) {
    const began = performance.now();
    const inbound = req.headers.authorization;
    const row = { time: new Date().toISOString(), method: req.method, pathname: '<invalid>',
      status: 0, durationMs: 0, swapped: false, inboundAuthPresent: inbound !== undefined,
      upstreamAuthEqualsInbound: false, upstreamAuthIsSwapAccount: false };
    let upstreamReq;
    let upstreamRes;
    let done = false;
    let timer;
    const finish = status => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      active.delete(abort);
      row.status = status;
      row.durationMs = Math.round((performance.now() - began) * 1000) / 1000;
      count++;
      try {
        const line = Buffer.from(`${JSON.stringify(row)}\n`);
        if (writeSync(logHandle.fd, line) !== line.length) throw unavailable();
      } catch {
        failed = true;
        auth?.stop('logging_unavailable');
        void close();
      }
    };
    const abort = () => {
      finish(499);
      upstreamReq?.destroy();
      upstreamRes?.destroy();
      res.destroy();
    };
    const fail = (status, reason) => {
      if (done) return;
      row.stopReason = reason;
      auth?.stop(reason);
      upstreamReq?.destroy();
      upstreamRes?.destroy();
      if (res.headersSent) {
        finish(status);
        res.destroy();
      } else {
        res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
        res.end('Proxy request unavailable\n');
      }
    };
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(504, 'upstream_timeout'), timeoutMs);
      timer.unref();
    };
    active.add(abort);
    req.on('aborted', abort);
    req.on('error', abort);
    res.once('finish', () => finish(res.statusCode));
    res.once('close', () => { if (!done) abort(); });
    res.on('error', abort);
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || req.url.includes('#')) {
        res.writeHead(400); res.end(); return;
      }
      const parsed = new URL(req.url, 'http://proxy.invalid');
      row.pathname = parsed.pathname;
      const swap = mode === 'swap-messages' && req.method === 'POST' && parsed.pathname === '/v1/messages';
      const headers = endToEnd(req.headers);
      headers.host = target.host;
      if (swap) {
        const listenPort = server.address()?.port;
        if (typeof inbound !== 'string' || !/^Bearer [\x21-\x7e]+$/.test(inbound)
          || ![`127.0.0.1:${listenPort}`, `localhost:${listenPort}`].includes(req.headers.host)
          || req.headers.origin !== undefined) {
          res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' });
          res.end('Request refused\n'); return;
        }
        try {
          const token = await auth.get();
          if (done || closing) return;
          if (auth.reason()) throw unavailable();
          headers.authorization = `Bearer ${token}`;
        } catch {
          row.stopReason = auth.reason();
          res.writeHead(503, { connection: 'close' }); res.end('Swap unavailable\n'); return;
        }
      }
      if (done || closing) return;
      // Validate the immutable destination again immediately before connecting.
      upstreamTarget(target.href, options.upstream !== undefined);
      upstreamReq = (target.protocol === 'https:' ? https : http).request({
        protocol: target.protocol, hostname: target.hostname, port: target.port,
        path: `${parsed.pathname}${parsed.search}`, method: req.method, headers, agent: false,
      }, response => {
        upstreamRes = response;
        if (done) { response.destroy(); return; }
        resetTimeout();
        if (swap && [401, 403].includes(response.statusCode)) {
          auth.stop('auth_rejected');
          row.stopReason = 'auth_rejected';
          res.writeHead(503, { 'content-type': 'text/plain', connection: 'close' });
          res.end('Swap unavailable\n');
          finish(503);
          response.on('error', () => {});
          response.destroy();
          upstreamReq.destroy();
          return;
        }
        response.on('error', () => fail(502, 'upstream_error'));
        response.on('aborted', () => fail(502, 'upstream_error'));
        response.on('data', resetTimeout);
        res.writeHead(response.statusCode, endToEnd(response.headers));
        res.flushHeaders();
        // pipe handles pause/drain in both directions without accumulating bodies.
        response.pipe(res);
      });
      row.swapped = swap;
      row.upstreamAuthEqualsInbound = headers.authorization === inbound;
      row.upstreamAuthIsSwapAccount = auth?.matches(headers.authorization) ?? false;
      upstreamReq.on('error', () => fail(502, 'upstream_error'));
      upstreamReq.on('upgrade', (_response, socket) => { socket.destroy(); fail(502, 'upstream_error'); });
      resetTimeout();
      req.on('data', resetTimeout);
      req.pipe(upstreamReq);
    } catch { fail(502, 'upstream_error'); }
  }

  server.on('clientError', (_error, socket) => { socket.destroy(); });
  return Object.freeze({
    async listen() {
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
        });
      } catch { failed = true; await close(); throw unavailable(); }
    },
    close, closed, address: () => server.address(), count: () => count, failed: () => failed,
  });
}
