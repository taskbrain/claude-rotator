// Shared fixtures for tests that drive the exhaustion mapping (429 -> 529 / 403)
// over real TCP on 127.0.0.1.
//
// Isolation: every server listens on 127.0.0.1 port 0. The proxy gets an
// in-memory secret store from the caller, a credential reader that returns
// nothing, usage polling switched off, and stubs for the usage API and token
// refresh that reject instead of reaching the network. Nothing is written to
// the real config directory (no usage-events directory is passed).
//
// This file lives under test/, so `node --test` loads it as a test file
// (Node 20 treats every .js file under a test directory as one). Importing it
// must stay free of side effects.

import http from 'node:http';

import { createProxyServer } from '../../src/proxy-server.js';

/**
 * Listen on 127.0.0.1 with an ephemeral port.
 * @param {import('node:http').Server} server
 * @returns {Promise<{ server: import('node:http').Server, url: string }>}
 */
export function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Stop the server and drop every open connection so a held-open response
 * cannot keep the close waiting.
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
export function close(server) {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/**
 * Send one request on a fresh socket (agent: false by default, so keep-alive
 * sockets are never reused between tests) and read the whole response.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string|Buffer,
 *   timeoutMs?: number, agent?: import('node:http').Agent|false }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders,
 *   bodyText: string, body: unknown }>}
 */
export function requestJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 10_000,
  agent = false,
} = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        try {
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            bodyText,
            body: bodyText ? JSON.parse(bodyText) : null,
          });
        } catch (error) {
          settle(reject, error);
        }
      });
      res.on('error', error => settle(reject, error));
      res.on('close', () => settle(reject, new Error('response closed before end')));
    });
    req.on('error', error => settle(reject, error));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`test client timeout after ${timeoutMs}ms`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Start a proxy with the exhaustion mapping wired the same way as the
 * seven-path mapping tests in test/proxy-server.test.js.
 * @param {{ accountManager: object, secretStore: object, upstreamUrl: string,
 *   logLines: string[], degradeMapping?: object|null, bridgeUrl?: string|null }} options
 * @returns {Promise<{ server: import('node:http').Server, url: string }>}
 */
export async function startMappingProxy({
  accountManager,
  secretStore,
  upstreamUrl,
  logLines,
  degradeMapping = { enabled: true },
  bridgeUrl = null,
}) {
  const bridge = bridgeUrl
    ? {
      enabled: true,
      url: bridgeUrl,
      modelPattern: '^gpt-',
      connectTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      connectRetries: 0,
    }
    : { enabled: false };
  return listen(createProxyServer({
    accountManager,
    secretStore,
    config: {
      upstream: upstreamUrl,
      usagePolling: { enabled: false },
      openaiBridge: { ...bridge, ...(degradeMapping ? { degradeMapping } : {}) },
    },
    allowLiveClaudeCodeCredentials: false,
    currentCredentialReader: async () => null,
    currentProfileFetcher: async () => null,
    usageFetcher: async () => { throw new Error('usage API must not be called in this test'); },
    tokenRefresher: async () => { throw new Error('token refresh must not be called in this test'); },
    logger: line => logLines.push(line),
  }));
}

/**
 * The per-request access log lines (one per upstream attempt or local answer).
 * @param {string[]} logLines
 * @returns {string[]}
 */
export function proxyLines(logLines) {
  return logLines.filter(line => line.includes(' proxy account='));
}
