import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { text as readText } from 'node:stream/consumers';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const START = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;
export const OFF_MODES = ['unset', 'explicit-off'];
export const HEADER_CASES = [
  { id: 'invalid-fable', model: 'claude-fable-5', headers: {
    'anthropic-ratelimit-unified-7d-fable-utilization': 'invalid-fixture',
    'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
  } },
  { id: 'fable-value-only', model: 'claude-fable-5', headers: {
    'anthropic-ratelimit-unified-7d-fable-utilization': '0.1',
  } },
  { id: 'fable-reset-only', model: 'claude-fable-5', headers: {
    'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
  } },
  { id: 'unknown-scope', model: 'sonnet', headers: {
    'anthropic-ratelimit-unified-7d-fixture_scope-utilization': 'invalid-fixture',
    'anthropic-ratelimit-unified-7d-fixture_scope-reset': String((START + HOUR) / 1000),
  } },
  { id: 'extended-fable', model: 'claude-fable-5-1', headers: {
    'anthropic-ratelimit-unified-7d-fable_5_1-utilization': '0.99',
    'anthropic-ratelimit-unified-7d-fable_5_1-reset': String((START + HOUR) / 1000),
  } },
  { id: 'common-value-only', model: 'sonnet', headers: {
    'anthropic-ratelimit-unified-5h-utilization': '0',
  } },
  { id: 'valid-fable-stop', model: 'claude-fable-5', headers: {
    'anthropic-ratelimit-unified-7d-fable-utilization': '0.99',
    'anthropic-ratelimit-unified-7d-fable-reset': String((START + HOUR) / 1000),
  } },
];

let inMemoryCredentials = [];
const jsonBytes = value => bytes(JSON.stringify(value));
function bytes(value) {
  const buffer = Buffer.from(value);
  assert.ok(inMemoryCredentials.every(credential => !buffer.includes(credential)), 'fixture output must not contain credential values');
  return buffer.toString('base64');
}

async function collect(sourceRoot, storage, scope) {
  const credentials = JSON.parse(await readText(process.stdin));
  assert.equal(credentials.length, 2);
  assert.ok(credentials.every(value => typeof value === 'string' && value.length > 0));
  inMemoryCredentials = credentials;
  const RealDate = Date;
  const clock = { ms: START };
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock.ms])); }
    static now() { return clock.ms; }
  };
  const load = name => import(pathToFileURL(join(sourceRoot, 'src', name)).href);
  const [{ AccountManager }, { createProxyServer }, { MemorySecretStore }, { createRuntimeStateWriter }, { renderStatus }] =
    await Promise.all([load('account-manager.js'), load('proxy-server.js'), load('secret-store.js'), load('cli.js'), load('monitor.js')]);
  const accounts = [{ id: 'sample-a', type: 'apikey', credentialRevision: 1 },
    { id: 'sample-b', type: 'apikey', credentialRevision: 1 }];
  const configFor = mode => mode === 'unset' ? {} : { planQuota: { mode: 'off' }, accountUrgency: { mode: 'off' } };
  const makeManager = (mode, logs) => {
    const manager = new AccountManager({ accounts, ...configFor(mode), now: () => clock.ms, logger: line => logs.push(line) });
    for (const [index, account] of accounts.entries()) manager.updateQuota(account.id, {
      'anthropic-ratelimit-unified-5h-utilization': String((index + 1) / 10),
      'anthropic-ratelimit-unified-5h-reset': String((START + HOUR) / 1000),
      'anthropic-ratelimit-unified-7d-utilization': String((index + 3) / 10),
      'anthropic-ratelimit-unified-7d-reset': String((START + 24 * HOUR) / 1000),
    });
    return manager;
  };
  const captureManager = (manager, logs, selections) => {
    const status = manager.getStatus();
    const state = manager.exportState();
    assert.equal(Object.hasOwn(status, 'quotaRecovery'), false);
    assert.equal(Object.hasOwn(state, 'quotaRecovery'), false);
    assert.equal(Object.hasOwn(status, 'quotaWindows'), false);
    assert.ok(state.accounts.every(account => !Object.hasOwn(account, 'windowObservations')));
    return { selection: jsonBytes(selections), status: jsonBytes(status), state: jsonBytes(state),
      monitor: bytes(renderStatus(status, { now: clock.ms, columns: 100 })), logs: jsonBytes(logs) };
  };
  const results = { manager: {}, http: {}, observation: {} };
  if (scope !== 'observation') {
    for (const mode of OFF_MODES) for (const scenario of HEADER_CASES) {
      clock.ms = START;
      const logs = [];
      const manager = makeManager(mode, logs);
      const selections = [manager.selectForNewAssignment({ modelFamily: scenario.model === 'sonnet' ? null : 'fable' })?.id ?? null];
      manager.updateQuota('sample-a', scenario.headers, { atomicUnifiedWindows: true });
      selections.push(manager.selectForNewAssignment({ modelFamily: scenario.model === 'sonnet' ? null : 'fable' })?.id ?? null);
      assert.deepEqual(selections, ['sample-a', 'sample-a']);
      results.manager[`${mode}/${scenario.id}`] = captureManager(manager, logs, selections);
    }
  }

  async function collectHttp(mode, scenario, responseStatus, observation) {
    clock.ms = START;
    const id = `${mode}/${scenario.id}/${responseStatus}`;
    const logs = [];
    const manager = makeManager(mode, logs);
    const upstreamSeen = [];
    const upstream = http.createServer(async (req, res) => {
      const body = await readText(req);
      const index = credentials.findIndex(value => value === req.headers['x-api-key']);
      assert.ok(index >= 0, 'only a generated in-memory credential may reach the fixture');
      upstreamSeen.push({ account: accounts[index].id, method: req.method, path: req.url, body });
      const payload = responseStatus === 200 ? '{ "ok": true }\n'
        : '{ "type":"error", "error":{"type":"rate_limit_error","message":"fixture 429"} }\n';
      res.writeHead(responseStatus, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)),
        date: new RealDate(START).toUTCString(), 'request-id': 'fixture-byte-response', 'retry-after': '1200', ...scenario.headers });
      res.end(payload);
    });
    let proxy;
    try {
      const upstreamUrl = await listen(upstream);
      const store = new MemorySecretStore();
      for (const [index, account] of accounts.entries()) await store.set(account.id, { apiKey: credentials[index] });
      const directory = join(storage, observation ? 'observation' : 'http', mode, `${scenario.id}-${responseStatus}`);
      await mkdir(directory, { recursive: true });
      const statePath = join(directory, 'runtime-state.json');
      const durableWriter = createRuntimeStateWriter(statePath);
      const writes = [];
      proxy = createProxyServer({ accountManager: manager, secretStore: store,
        config: { upstream: upstreamUrl, ...configFor(mode), usagePolling: { enabled: false },
          sessionAffinity: { mode: 'off' }, ...(observation ? { quotaObservation: { enabled: true } } : {}) },
        currentCredentialReader: async () => assert.fail('live credentials must not be read'),
        currentProfileFetcher: async () => assert.fail('live profiles must not be fetched'),
        tokenRefresher: async () => assert.fail('no credential refresh is needed in this fixture'),
        usageFetcher: async () => assert.fail('usage polling must stay disabled'),
        logger: line => logs.push(line),
        stateWriter: async state => { await durableWriter(state); writes.push(JSON.stringify(state)); },
      });
      proxy.prependListener('request', (_req, res) => res.setHeader('date', new RealDate(START).toUTCString()));
      const proxyUrl = await listen(proxy);
      const initial = await request(proxyUrl + '/internal/status');
      assert.equal(initial.status, 200);
      const beforeWrites = writes.length;
      const response = await request(proxyUrl + '/v1/messages', JSON.stringify({ model: scenario.model,
        messages: [{ role: 'user', content: 'fixture request' }] }));
      await until(() => writes.length > beforeWrites);
      const internal = await request(proxyUrl + '/internal/status');
      assert.equal(internal.status, 200);
      assert.equal(response.status, responseStatus);
      assert.equal(upstreamSeen.length, 1);
      assert.equal(upstreamSeen[0].account, 'sample-a');
      const selections = [manager.selectForNewAssignment({ modelFamily: scenario.model === 'sonnet' ? null : 'fable' })?.id ?? null];
      assert.deepEqual(selections, [responseStatus === 200 ? 'sample-a' : 'sample-b']);
      return [id, { ...captureManager(manager, logs, selections), initial: initial.bytes, response: response.bytes,
        internal: internal.bytes, runtime: bytes(await readFile(statePath)), writes: jsonBytes(writes), upstream: jsonBytes(upstreamSeen) }];
    } finally {
      await close(proxy);
      await close(upstream);
    }
  }

  if (scope !== 'observation') {
    for (const mode of OFF_MODES) for (const scenario of HEADER_CASES) for (const status of [200, 429]) {
      const [id, artifact] = await collectHttp(mode, scenario, status, false);
      results.http[id] = artifact;
    }
  }
  for (const mode of OFF_MODES) for (const status of [200, 429]) {
    const [id, artifact] = await collectHttp(mode, HEADER_CASES[0], status, true);
    results.observation[id] = artifact;
  }
  process.stdout.write(JSON.stringify(results));
}

function listen(server) {
  return new Promise((resolveUrl, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      assert.notEqual(server.address().port, 37891);
      resolveUrl(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
}

function request(url, body = null) {
  assert.notEqual(new URL(url).port, '37891');
  return new Promise((resolveResponse, reject) => {
    const req = http.request(url, { method: body === null ? 'GET' : 'POST' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const head = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`
          + res.rawHeaders.reduce((lines, value, index, all) => index % 2 === 0 ? lines + `${value}: ${all[index + 1]}\r\n` : lines, '')
          + '\r\n';
        resolveResponse({ status: res.statusCode, bytes: bytes(Buffer.concat([Buffer.from(head), ...chunks])) });
      });
    });
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail('fixture persistence did not settle');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await collect(resolve(process.argv[2]), resolve(process.argv[3]), process.argv[4]).catch(error => {
    process.stderr.write(`compatibility fixture failed: ${error.code || 'fixture-error'}\n`);
    process.exitCode = 1;
  });
}
