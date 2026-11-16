import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants, watch } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { dirname, join, posix, resolve } from 'node:path';
import { credentialSwapStartupReason, normalizeCredentialSwap, swapError } from './credential-swap-config.js';
import { createSwapKeychainReader, credentialExpiryReason, EXPIRY_REASONS } from './credential-swap-keychain.js';
import { removeFileDurable, writeJsonFileDurable } from './json-file.js';

export const CALLER_HEADER = 'x-claude-rotator-caller';
const UPSTREAM = 'https://api.anthropic.com';
const MAX_EVENT_FILES = 128;
const MAX_EVENT_BYTES = 64 * 1024;
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];

export function isSwapRequest(method, target) {
  return method === 'POST' && /^\/v1\/messages(?:\?[^#]*)?$/.test(target);
}

export function authenticateCaller(req, config, now = Date.now()) {
  const supplied = req.headers[CALLER_HEADER];
  if (typeof supplied !== 'string' || !/^[\x21-\x7e]{16,512}$/.test(supplied)) return null;
  if (req.rawHeaders?.filter((value, index) => index % 2 === 0
    && value.toLowerCase() === CALLER_HEADER).length !== 1) return null;
  const digest = createHash('sha256').update(supplied).digest();
  let found = null;
  for (const caller of config.callers) {
    const same = timingSafeEqual(digest, Buffer.from(caller.sha256, 'hex'));
    if (same && caller.expiresAt > now) found = caller.accountId;
  }
  return found;
}

export function forwardHeaders(headers) {
  const blocked = new Set([...HOP_HEADERS, 'host', ...String(headers.connection || '')
    .split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('x-claude-rotator-')));
}

// The CLI supplies neither transport nor credential overrides. Tests can use
// an ephemeral loopback upstream and a fake read-only Keychain executor.
export async function createCredentialSwapServer({ configPath, keychain = createSwapKeychainReader(),
  upstream = UPSTREAM, now = Date.now, pollMs = 250, watchImpl = watch, stateIO = {} } = {}) {
  let config = await readSettings(configPath);
  if (!config) throw swapError('swap_config_required');
  const initial = config;
  let valid = true;
  let epoch = new AbortController();
  let stopped = false;
  let stateFailed = false;
  let closed = false;
  const pendingEvents = new Set();
  const eventsDir = join(config.stateDir, 'events');
  const stoppedPath = join(config.stateDir, 'stopped.json');
  const startedPath = join(config.stateDir, 'started-once');
  const canaryPath = join(config.stateDir, 'persist-canary');
  const writeStopFile = stateIO.writeFile || writeFile;
  const openState = stateIO.open || open;
  const writeStateDurable = stateIO.writeJsonFileDurable || writeJsonFileDurable;
  const removeStateDurable = stateIO.removeFileDurable || removeFileDurable;
  async function persistStop() {
    try {
      // Establish presence before the temporary-file/rename sequence can fail.
      await writeStopFile(stoppedPath, '', { mode: 0o600, flush: true });
      const directory = await openState(config.stateDir, fsConstants.O_RDONLY);
      try { await directory.sync(); }
      finally { await directory.close(); }
      await writeStateDurable(stoppedPath, { stopped: true, reason: 'upstream_forbidden' });
    } catch {
      // A missing canary fences a later start even if no stop file was created.
      await removeStateDurable(canaryPath).catch(() => {});
    }
  }
  try {
    await mkdir(eventsDir, { recursive: true, mode: 0o700 });
    const names = await readdir(config.stateDir);
    const started = names.includes('started-once');
    stopped = names.includes('stopped.json')
      || names.some(name => name.startsWith('stopped.json.') && name.endsWith('.tmp'))
      || (started && !names.includes('persist-canary'));
    if (stopped && !names.includes('stopped.json')) await persistStop();
    if (!started) {
      // Publish the first-start marker only after the canary is durable.
      await writeStateDurable(canaryPath, { present: true });
      await writeStateDurable(startedPath, { present: true });
    }
  } catch { throw swapError('swap_state_unavailable'); }

  // Serialize writes and evictions so concurrent completions cannot exceed
  // either retention bound. Temporary files share the same dedicated directory.
  const eventFiles = [];
  let eventBytes = 0;
  let eventTail = Promise.resolve();
  let queuedEvents = 0;
  async function trimEvents(extraFiles = 0, extraBytes = 0) {
    while (eventFiles.length + extraFiles > MAX_EVENT_FILES || eventBytes + extraBytes > MAX_EVENT_BYTES) {
      const oldest = eventFiles[0];
      await removeStateDurable(join(eventsDir, oldest.name));
      eventFiles.shift();
      eventBytes -= oldest.size;
    }
  }
  try {
    for (const name of await readdir(eventsDir)) {
      const info = await lstat(join(eventsDir, name));
      if (!info.isFile()) throw swapError();
      eventFiles.push({ name, size: info.size, mtime: info.mtimeMs });
      eventBytes += info.size;
    }
    eventFiles.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    await trimEvents();
  } catch { stateFailed = true; }

  let reloadChain = Promise.resolve();
  function reload() {
    // Each caller waits for a pass that starts after this request, so a write
    // followed by await reload() cannot join a read that began against the old file.
    const run = reloadChain.then(async () => {
      try {
        const next = await readSettings(configPath);
        if (!next || next.stateDir !== initial.stateDir || next.listenPort !== initial.listenPort)
          throw swapError();
        if (!valid || JSON.stringify(next) !== JSON.stringify(config)) {
          config = next;
          valid = true;
          epoch.abort();
          epoch = new AbortController();
        }
      } catch {
        valid = false;
        epoch.abort();
        epoch = new AbortController();
      }
    });
    reloadChain = run.catch(() => {});
    return run;
  }
  let watcher;
  try {
    watcher = watchImpl(dirname(resolve(configPath)), () => { void reload(); });
    watcher.on('error', () => { watcher.close(); });
  } catch { /* The periodic reread also covers unavailable file watching. */ }
  const timer = setInterval(() => { void reload(); }, pollMs);
  timer.unref();

  function record(event) {
    if (stateFailed) return;
    if (queuedEvents >= MAX_EVENT_FILES) { stateFailed = true; return; }
    queuedEvents++;
    const pending = eventTail.then(async () => {
      if (stateFailed) return;
      const size = Buffer.byteLength(`${JSON.stringify(event, null, 2)}\n`);
      if (size > MAX_EVENT_BYTES) throw swapError();
      await trimEvents(1, size);
      const name = `${event.requestId}.json`;
      await writeStateDurable(join(eventsDir, name), event);
      eventFiles.push({ name, size });
      eventBytes += size;
    }).catch(() => { stateFailed = true; }).finally(() => {
      queuedEvents--;
      pendingEvents.delete(pending);
    });
    eventTail = pending;
    pendingEvents.add(pending);
  }

  const server = http.createServer((req, res) => {
    const event = { requestId: randomUUID(), route: 'rejected', swapped: false,
      sentAccountId: null, displayAccountId: null, statusCode: null, reason: 'unavailable' };
    let logged = false;
    let outgoing;
    let incoming;
    let deadline;
    let persistingStop = false;
    const cancelled = new AbortController();
    function finish(reason, statusCode = res.statusCode) {
      if (logged) return;
      logged = true;
      clearTimeout(deadline);
      event.reason = reason;
      event.statusCode = statusCode;
      record(event);
    }
    function fail(status, reason) {
      if (logged) return;
      finish(reason, status);
      outgoing?.destroy();
      incoming?.destroy();
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: status === 401 ? 'Caller unauthorized' : 'Swap unavailable' }));
      } else res.destroy();
    }
    function cancel() {
      cancelled.abort();
      if (!logged) finish('client_cancelled', 499);
      outgoing?.destroy();
      incoming?.destroy();
    }
    req.on('aborted', cancel);
    req.on('error', cancel);
    res.on('close', () => { if (!res.writableFinished) cancel(); });
    res.on('error', cancel);

    async function route() {
      if (!req.url.startsWith('/') || req.url.startsWith('//') || /[#\s\\]/.test(req.url)) {
        fail(400, 'invalid_target'); return;
      }
      const inference = isSwapRequest(req.method, req.url);
      while (!logged) {
        const selected = config;
        const generation = epoch.signal;
        if (!valid || closed) { fail(503, 'config_unavailable'); return; }
        const display = authenticateCaller(req, selected, now());
        if (!display) { fail(401, 'caller_unauthorized'); return; }
        event.displayAccountId = display;
        const path = req.url.split('?', 1)[0];
        // Keep routing exact: reject encoded or noncanonical paths rather than
        // forwarding a target that another HTTP layer could interpret differently.
        let decoded;
        try { decoded = decodeURIComponent(path); }
        catch { fail(400, 'invalid_target'); return; }
        if (decoded !== path || posix.normalize(decoded) !== path) {
          fail(400, 'invalid_target'); return;
        }
        if (path === '/internal' || path.startsWith('/internal/')) {
          fail(404, 'internal_target'); return;
        }
        if (inference && stopped && selected.enabled) { fail(503, 'inference_stopped'); return; }
        if (inference && stateFailed && selected.enabled) { fail(503, 'state_unavailable'); return; }
        const headers = forwardHeaders(req.headers);
        let destination = upstream;
        event.route = inference ? (selected.enabled ? 'swap' : 'legacy') : 'passthrough';
        if (inference && !selected.enabled) destination = selected.legacyProxyUrl;
        if (inference && selected.enabled) {
          const signal = AbortSignal.any([generation, cancelled.signal]);
          let credential;
          try {
            credential = await abortable(keychain.read(selected.swapAccounts[0], {
              marginMs: selected.expiryMarginMs, signal,
            }), signal);
          } catch (error) {
            if (logged) return;
            if (generation.aborted) continue;
            fail(503, EXPIRY_REASONS.has(error?.message) ? error.message : 'credential_unavailable'); return;
          }
          if (generation.aborted) continue;
          if (stopped || stateFailed) { fail(503, 'inference_stopped'); return; }
          if (!authenticateCaller(req, selected, now())) { fail(401, 'caller_unauthorized'); return; }
          const expiryReason = credentialExpiryReason(credential.expiresAt, now(), selected.expiryMarginMs);
          if (expiryReason) {
            fail(503, expiryReason); return;
          }
          headers.authorization = `Bearer ${credential.accessToken}`;
          delete headers['x-api-key'];
          event.swapped = true;
          event.sentAccountId = selected.swapAccounts[0].id;
        } else event.sentAccountId = display;
        if (logged || cancelled.signal.aborted) return;
        // No await between the final generation check and dispatch: a sent
        // request owns its destination even if the feature is then disabled.
        const target = new URL(destination);
        const transport = target.protocol === 'https:' ? https : http;
        function armTimeout() {
          clearTimeout(deadline);
          deadline = setTimeout(() => fail(504, 'upstream_timeout'), selected.requestTimeoutMs);
        }
        outgoing = transport.request(target, { method: req.method, path: req.url,
          headers, agent: false }, response => {
          incoming = response;
          response.on('error', () => { if (!persistingStop) fail(502, 'upstream_disconnected'); });
          response.on('aborted', () => { if (!persistingStop) fail(502, 'upstream_disconnected'); });
          if (event.swapped && (response.statusCode === 401 || response.statusCode === 403)) {
            if (response.statusCode === 403) {
              stopped = true;
              persistingStop = true;
              clearTimeout(deadline);
              // Persist before answering; new inference is already fenced.
              const pending = persistStop()
                .finally(() => { fail(503, 'upstream_forbidden'); pendingEvents.delete(pending); });
              pendingEvents.add(pending);
              response.destroy();
              return;
            }
            fail(503, 'upstream_unauthorized'); return;
          }
          armTimeout();
          res.writeHead(response.statusCode, forwardHeaders(response.headers));
          response.on('data', armTimeout);
          response.on('end', () => clearTimeout(deadline));
          res.once('finish', () => finish('completed', response.statusCode));
          response.pipe(res);
        });
        outgoing.on('error', () => { if (!persistingStop) fail(502, 'upstream_disconnected'); });
        armTimeout();
        req.pipe(outgoing);
        return;
      }
    }
    void route().catch(() => fail(503, 'request_unavailable'));
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  server.on('close', () => { clearInterval(timer); watcher?.close(); });

  return {
    server, reload,
    get enabled() { return valid && config.enabled; },
    async flushEvents() { while (pendingEvents.size) await Promise.all([...pendingEvents]); },
    async close() {
      closed = true;
      epoch.abort();
      clearInterval(timer);
      watcher?.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(done => server.close(done));
      while (pendingEvents.size) await Promise.all([...pendingEvents]);
    },
    listenPort: initial.listenPort,
  };
}

async function readSettings(path) {
  try { return normalizeCredentialSwap(JSON.parse(await readFile(path, 'utf8'))); }
  catch { throw swapError('invalid_swap_config'); }
}

function abortable(promise, signal) {
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(swapError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    Promise.resolve(promise).then(resolvePromise, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function serveCredentialSwap({ configPath, write = text => process.stdout.write(text) }) {
  let instance;
  try {
    instance = await createCredentialSwapServer({ configPath });
    await new Promise((done, reject) => {
      instance.server.once('error', reject);
      instance.server.listen(instance.listenPort, '127.0.0.1', done);
    });
    write('Credential swap listening on loopback\n');
    await new Promise(done => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); done(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) { throw swapError(credentialSwapStartupReason(error)); }
  finally { await instance?.close(); }
}
