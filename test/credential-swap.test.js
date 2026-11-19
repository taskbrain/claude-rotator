import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeKeychainServiceName } from '../src/claude-keychain.js';
import { createDefaultConfig, loadConfig } from '../src/config.js';
import { runCli } from '../src/cli.js';
import { normalizeCredentialSwap } from '../src/credential-swap-config.js';
import { appConfigDir, appDataDir, linuxAccountsDir, runtimeStatePath } from '../src/paths.js';
import { createSwapKeychainReader, credentialExpiryReason } from '../src/credential-swap-keychain.js';
import { authenticateCaller, CALLER_HEADER, createCredentialSwapServer,
  forwardHeaders, isSwapRequest, serveCredentialSwap } from '../src/credential-swap.js';

const CALLER = 'test-caller-credential-not-real';
const ACCESS = 'test-access-token-not-real';
const REFRESH = 'test-refresh-token-not-real';
const DISPLAY = 'test-display-token-not-real';
const NOW = 2_000_000_000_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function sandbox(t, cleanup = true) {
  const root = await mkdtemp(join(tmpdir(), 'credential-swap-test-'));
  if (cleanup) t.after(() => rm(root, { recursive: true, force: true }));
  const account = { id: 'swap-test', configDir: join(root, 'account-config'), acct: 'test-keychain-account',
    keychainPath: join(root, 'keychains', 'test.keychain-db'),
    keychainAllowlist: [join(root, 'keychains', 'test.keychain-db')] };
  account.service = claudeKeychainServiceName(account.configDir);
  const config = { credentialSwap: { enabled: true, stateDir: join(root, 'state'),
    callers: [{ sha256: hash(CALLER), accountId: 'display-test', expiresAt: NOW + 60_000 }],
    swapAccounts: [account], requestTimeoutMs: 1000 } };
  return { root, account, config };
}

function attributes(account, { acct = account.acct, service = account.service,
  file = account.keychainPath, mdat = '20330518033320Z' } = {}) {
  return `keychain: "${file}"\nversion: 512\nclass: "genp"\nattributes:\n    "acct"<blob>="${acct}"\n    "svce"<blob>="${service}"\n    "mdat"<timedate>=0x32303333 "${mdat}"\n`;
}

function fakeExecutor(account, overrides = {}) {
  const calls = [];
  let reads = 0;
  const execute = async (command, args, options) => {
    calls.push({ command, args });
    assert.equal(command, '/usr/bin/security');
    assert.equal(options.encoding, 'utf8');
    const action = args[0];
    if (action === 'list-keychains') {
      return { stdout: overrides.search ?? `    "${account.keychainPath}"\n` };
    }
    if (action === 'dump-keychain') {
      assert.ok(account.keychainAllowlist.includes(args[1]));
      const body = overrides.dump
        ? overrides.dump({ args, reads }) : attributes(account);
      return { stdout: body };
    }
    assert.deepEqual(args, ['find-generic-password', '-a', account.acct, '-s', account.service,
      '-w', account.keychainPath]);
    reads++;
    if (overrides.read) return overrides.read({ options, reads });
    return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: ACCESS,
      refreshToken: REFRESH, expiresAt: NOW + 3_600_000, ...overrides.credential } }) };
  };
  return { execute, calls, get reads() { return reads; } };
}

test('target classification uses the exact method and path, with an optional query', () => {
  for (const [method, path, expected] of [
    ['POST', '/v1/messages', true], ['POST', '/v1/messages?beta=true', true],
    ['POST', '/v1/messages?', true], ['POST', '/v1/messages/', false],
    ['post', '/v1/messages', false], ['POST', '/V1/messages', false],
    ['GET', '/v1/messages', false], ['HEAD', '/api/hello', false],
    ['POST', 'http://example.invalid/v1/messages', false],
    ['POST', '//example.invalid/v1/messages', false], ['POST', '/v1/%6dessages', false],
    ['POST', '/v1/other/../messages', false], ['POST', '/v1/messages#x', false],
  ]) assert.equal(isSwapRequest(method, path), expected, `${method} ${path}`);
});

test('caller authentication uses only a single dedicated credential and the registered identity', async t => {
  const { config } = await sandbox(t);
  const settings = normalizeCredentialSwap(config);
  const request = { headers: { [CALLER_HEADER]: CALLER, authorization: 'arbitrary',
    'x-claude-rotator-account': 'spoofed' }, rawHeaders: [CALLER_HEADER, CALLER] };
  assert.equal(authenticateCaller(request, settings, NOW), 'display-test');
  assert.equal(authenticateCaller(request, settings, NOW + 60_000), null);
  assert.equal(authenticateCaller({ ...request, rawHeaders: [...request.rawHeaders, ...request.rawHeaders] }, settings, NOW), null);
  assert.equal(authenticateCaller({ ...request, headers: {} }, settings, NOW), null);
  assert.equal(authenticateCaller({ ...request, headers: { [CALLER_HEADER]: 'test-unregistered-not-real' } }, settings, NOW), null);
});

test('forwarding removes all local and hop-by-hop headers while preserving ordinary authentication', () => {
  const headers = forwardHeaders({ authorization: `Bearer ${DISPLAY}`, 'x-api-key': DISPLAY,
    [CALLER_HEADER]: CALLER, 'x-claude-rotator-account': 'spoofed',
    connection: 'keep-alive, x-hidden', 'x-hidden': 'hidden', 'proxy-authorization': DISPLAY,
    host: 'untrusted.invalid', 'content-type': 'application/json' });
  assert.equal(headers.authorization, `Bearer ${DISPLAY}`);
  assert.equal(headers['x-api-key'], DISPLAY);
  assert.equal(headers[CALLER_HEADER], undefined);
  assert.equal(headers['x-claude-rotator-account'], undefined);
  assert.equal(headers['x-hidden'], undefined);
  assert.equal(headers['proxy-authorization'], undefined);
  assert.equal(headers.host, undefined);
});

test('existing default config and loadConfig are unchanged when the feature is absent', async t => {
  const { root } = await sandbox(t);
  const config = createDefaultConfig();
  assert.equal(Object.hasOwn(config, 'credentialSwap'), false);
  assert.equal(config.proxy.port, 37891);
  assert.equal(normalizeCredentialSwap(config), null);
  const path = join(root, 'existing.json');
  await writeFile(path, JSON.stringify(config));
  assert.deepEqual(await loadConfig(path), config);
  const cli = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /if \(command === 'server'\) \{\s*await runServer\(\{ write \}\);\s*return 0;/);
});

test('config is default-off and rejects explicit malformed values even while disabled', async t => {
  const { config } = await sandbox(t);
  delete config.credentialSwap.enabled;
  assert.equal(normalizeCredentialSwap(config).enabled, false);
  const invalid = [null, [], 'enabled'];
  for (const value of invalid) assert.throws(() => normalizeCredentialSwap({ credentialSwap: value }), /^Error: invalid_swap_config$/);
  for (const [key, value] of [['enabled', 'false'], ['enabled', 1], ['listenPort', '37991'],
    ['listenPort', 0], ['expiryMarginMs', -1], ['expiryMarginMs', null], ['callers', {}],
    ['swapAccounts', {}], ['stateDir', 'relative'], ['requestTimeoutMs', 0],
    ['legacyProxyUrl', 'https://127.0.0.1:12345'], ['legacyProxyUrl', 'http://example.invalid'],
    ['legacyProxyUrl', 'http://127.0.0.1:37991'], ['legacyProxyUrl', 'http://127.0.0.1/path']]) {
    assert.throws(() => normalizeCredentialSwap({ credentialSwap: { ...config.credentialSwap, [key]: value } }),
      /^Error: invalid_swap_config$/, key);
  }
  assert.throws(() => normalizeCredentialSwap({ credentialSwap: { ...config.credentialSwap,
    swapAccounts: [config.credentialSwap.swapAccounts[0], config.credentialSwap.swapAccounts[0]] } }));
  assert.throws(() => normalizeCredentialSwap({ credentialSwap: { ...config.credentialSwap,
    callers: [{ ...config.credentialSwap.callers[0], sha256: [hash(CALLER)] }] } }), /^Error: invalid_swap_config$/);
});

test('new CLI requires an explicit config and sanitizes startup errors without changing legacy dispatch', async () => {
  const output = [];
  const calls = [];
  const deps = { write: value => output.push(value), error: value => output.push(value),
    serveCredentialSwap: async options => { calls.push(options.configPath); } };
  assert.equal(await runCli(['credential-swap', 'serve', '--config', '/test/config.json'], deps), 0);
  assert.deepEqual(calls, ['/test/config.json']);
  assert.equal(await runCli(['credential-swap', 'serve'], deps), 1);
  assert.equal(await runCli(['credential-swap', 'serve', '--config', '/test/config.json'], {
    ...deps, serveCredentialSwap: async () => { throw new Error(ACCESS); },
  }), 1);
  assert.equal(output.join('').includes(ACCESS), false);
});

test('Keychain reads are exact, unique, read-only and compare attributes before and after', async t => {
  const { account } = await sandbox(t);
  const fake = fakeExecutor(account);
  const credential = await createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
    .read(account, { marginMs: 300_000 });
  assert.equal(credential.accessToken === ACCESS, true);
  assert.equal(Object.hasOwn(credential, 'refreshToken'), false);
  assert.deepEqual(fake.calls.map(call => call.args[0]), ['list-keychains', 'dump-keychain',
    'find-generic-password', 'list-keychains', 'dump-keychain']);
  assert.equal(fake.calls.some(call => call.args.includes(ACCESS) || call.args.includes('-d') && call.args[0] === 'dump-keychain'), false);
});

test('aborting during attribute inspection prevents the later password read', async t => {
  const { account } = await sandbox(t);
  const controller = new AbortController();
  const fake = fakeExecutor(account, { dump: () => { controller.abort(); return attributes(account); } });
  await assert.rejects(() => createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
    .read(account, { marginMs: 300_000, signal: controller.signal }), /^Error: credential_unavailable$/);
  assert.equal(fake.reads, 0);
});

for (const scenario of ['default_service', 'wrong_service', 'acct_mismatch', 'multiple_matches',
  'unknown_search', 'wrong_file', 'metadata_changed', 'search_changed', 'missing_mdat',
  'unknown_expiry', 'expired', 'under_margin', 'invalid_json', 'executor_error']) {
  test(`Keychain fails closed: ${scenario}`, async t => {
    const { account } = await sandbox(t);
    const overrides = {};
    if (scenario === 'default_service') account.service = 'Claude Code-credentials';
    if (scenario === 'wrong_service') account.service += '-invalid';
    if (scenario === 'acct_mismatch') overrides.dump = () => attributes(account, { acct: 'other-test-account' });
    if (scenario === 'multiple_matches') overrides.dump = () => attributes(account) + attributes(account);
    if (scenario === 'unknown_search') overrides.search = `"${account.keychainPath}"\n"/outside-test-allowlist"\n`;
    if (scenario === 'wrong_file') overrides.dump = () => attributes(account, { file: '/outside-test-allowlist' });
    if (scenario === 'metadata_changed') overrides.dump = ({ reads }) => attributes(account, { mdat: String(reads) });
    if (scenario === 'search_changed') {
      account.keychainAllowlist.push(join(account.configDir, 'second-test.keychain-db'));
      overrides.dump = ({ args }) => args[1] === account.keychainPath ? attributes(account) : '';
    }
    if (scenario === 'missing_mdat') overrides.dump = () => attributes(account).replace(/^.*"mdat".*\n/m, '');
    if (scenario === 'unknown_expiry') overrides.credential = { expiresAt: null };
    if (scenario === 'expired') overrides.credential = { expiresAt: NOW - 1 };
    if (scenario === 'under_margin') overrides.credential = { expiresAt: NOW + 300_000 };
    if (scenario === 'invalid_json') overrides.read = () => ({ stdout: ACCESS });
    if (scenario === 'executor_error') overrides.read = () => { throw new Error(ACCESS + REFRESH); };
    const fake = fakeExecutor(account, overrides);
    let execute = fake.execute;
    if (scenario === 'search_changed') execute = async (command, args, options) => {
      if (args[0] === 'list-keychains' && fake.reads) return { stdout: `"${account.keychainPath}"\n"${account.keychainAllowlist[1]}"` };
      return fake.execute(command, args, options);
    };
    const error = await createSwapKeychainReader({ execute, now: () => NOW })
      .read(account, { marginMs: 300_000 }).then(() => null, caught => caught);
    assert.ok(error instanceof Error);
    const expectedExpiry = { unknown_expiry: 'credential_expiry_unknown', expired: 'credential_expired',
      under_margin: 'credential_within_margin' }[scenario];
    if (expectedExpiry) assert.equal(error.message, expectedExpiry);
    assert.equal([ACCESS, REFRESH].some(value => String(error.stack).includes(value)), false);
    if (['default_service', 'wrong_service'].includes(scenario)) assert.equal(fake.calls.length, 0);
    if (['acct_mismatch', 'multiple_matches', 'unknown_search', 'wrong_file', 'missing_mdat'].includes(scenario)) assert.equal(fake.reads, 0);
    if (scenario === 'unknown_search') assert.equal(fake.calls.length, 1);
  });
}

async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  assert.ok(![37891, 37991].includes(server.address().port));
  return `http://127.0.0.1:${server.address().port}`;
}

async function unbound(t, { keychain, now = () => NOW, watchImpl, prepare, stateIO,
  readConfigFile, pollMs, mockConnect = true } = {}) {
  const s = await sandbox(t, false);
  await prepare?.(s);
  const configPath = join(s.root, 'swap-settings.json');
  await writeFile(configPath, JSON.stringify(s.config));
  let reads = 0;
  let connects = 0;
  const refuseConnect = () => { connects++; throw new Error('unexpected_test_connection'); };
  // Do not layer this mock on top of stubTransport(); stacked t.mock.method
  // restorations can leave refuseConnect in place for later HTTP tests.
  if (mockConnect) {
    t.mock.method(http, 'request', refuseConnect);
    t.mock.method(https, 'request', refuseConnect);
  }
  const instance = await createCredentialSwapServer({ configPath, now, watchImpl, stateIO, readConfigFile, pollMs,
    keychain: { read: (...args) => { reads++; return keychain?.read(...args); } } });
  t.after(async () => { await instance.close(); await rm(s.root, { recursive: true, force: true }); });
  return { ...s, instance, configPath, get reads() { return reads; }, get connects() { return connects; } };
}

// Exercise rejection before transport creation without needing a TCP listener.
function directRequest(instance, { headers = { [CALLER_HEADER]: CALLER }, path = '/v1/messages' } = {}) {
  return new Promise(done => {
    const req = new PassThrough();
    Object.assign(req, { method: 'POST', url: path, headers,
      rawHeaders: Object.entries(headers).flat() });
    let text = '';
    const res = new Writable({ write(chunk, _encoding, next) { text += chunk; next(); } });
    res.statusCode = 200;
    res.headersSent = false;
    res.writeHead = status => { res.statusCode = status; res.headersSent = true; };
    res.on('finish', () => done({ status: res.statusCode, text }));
    instance.server.emit('request', req, res);
    req.end(REFRESH);
  });
}

test('request handler rejects missing, unknown, duplicate and expired callers before any side effect', async t => {
  const h = await unbound(t);
  for (const headers of [{}, { [CALLER_HEADER]: 'test-unknown-caller-not-real' },
    { [CALLER_HEADER]: [CALLER, CALLER] }, { authorization: `Bearer ${DISPLAY}`, 'x-claude-rotator-account': 'display-test' }]) {
    assert.equal((await directRequest(h.instance, { headers })).status, 401);
  }
  h.config.credentialSwap.callers[0].expiresAt = NOW;
  await writeFile(h.configPath, JSON.stringify(h.config));
  await h.instance.reload();
  assert.equal((await directRequest(h.instance)).status, 401);
  assert.equal(h.reads, 0);
  assert.equal(h.connects, 0);
});

test('request handler rechecks caller expiry after a delayed Keychain read', async t => {
  const entered = defer();
  const release = defer();
  let current = NOW;
  const h = await unbound(t, { now: () => current, keychain: { read: async () => {
    entered.resolve(); await release.promise;
    return { accessToken: ACCESS, expiresAt: NOW + 3_600_000 };
  } } });
  const pending = directRequest(h.instance);
  await entered.promise;
  current += 60_000;
  release.resolve();
  assert.equal((await pending).status, 401);
  assert.equal(h.reads, 1);
  assert.equal(h.connects, 0);
});

test('request handler sanitizes credential errors and logs only allowlisted fields', async t => {
  const h = await unbound(t, { keychain: { read: async () => { throw new Error(ACCESS + REFRESH); } } });
  const response = await directRequest(h.instance);
  assert.equal(response.status, 503);
  await h.instance.flushEvents();
  const directory = join(h.config.credentialSwap.stateDir, 'events');
  const events = await readdir(directory);
  assert.equal(events.length, 1);
  const logged = await readFile(join(directory, events[0]), 'utf8');
  for (const value of [ACCESS, REFRESH, DISPLAY, CALLER]) {
    assert.equal((logged + response.text).includes(value), false);
  }
  assert.equal(h.connects, 0);
});

test('polling reloads off within one second without watch events or waiting for a pending credential read', async t => {
  const pending = defer();
  const h = await unbound(t, { watchImpl: () => ({ close() {}, on() {} }),
    keychain: { read: () => pending.promise } });
  // Hold an independent credential operation while checking the config monitor.
  const reader = createSwapKeychainReader({ execute: () => pending.promise });
  const reading = reader.read(h.account, { marginMs: 300_000 }).catch(() => {});
  h.config.credentialSwap.enabled = false;
  const temp = `${h.configPath}.next`;
  await writeFile(temp, JSON.stringify(h.config));
  await rename(temp, h.configPath);
  const deadline = Date.now() + 1000;
  while (h.instance.enabled && Date.now() < deadline) await delay(10);
  assert.equal(h.instance.enabled, false);
  pending.resolve({ stdout: '' });
  await reading;
  assert.equal(h.connects, 0);
});

test('invalid reload fails closed; recovery does not silently enable the feature', async t => {
  const h = await unbound(t);
  await writeFile(h.configPath, ACCESS);
  await h.instance.reload();
  assert.equal((await directRequest(h.instance)).status, 503);
  delete h.config.credentialSwap.enabled;
  await writeFile(h.configPath, JSON.stringify(h.config));
  await h.instance.reload();
  assert.equal(h.instance.enabled, false);
  assert.equal(h.reads, 0);
  assert.equal(h.connects, 0);
});

test('expiry reasons distinguish unknown, expired, margin boundary and usable', () => {
  assert.equal(credentialExpiryReason(undefined, NOW, 300_000), 'credential_expiry_unknown');
  assert.equal(credentialExpiryReason(NOW, NOW, 300_000), 'credential_expired');
  assert.equal(credentialExpiryReason(NOW + 300_000, NOW, 300_000), 'credential_within_margin');
  assert.equal(credentialExpiryReason(NOW + 300_001, NOW, 300_000), null);
});

test('a reload requested during an old config read waits for a fresh read of the new config', async t => {
  const entered = defer();
  const release = defer();
  let reads = 0;
  const h = await unbound(t, { watchImpl: () => ({ close() {}, on() {} }), pollMs: 60_000,
    readConfigFile: async (...args) => {
      const contents = await readFile(...args);
      reads++;
      if (reads === 2) { entered.resolve(); await release.promise; }
      return contents;
    },
  });
  const oldReload = h.instance.reload();
  await entered.promise;
  try {
    h.config.credentialSwap.enabled = false;
    await writeFile(h.configPath, JSON.stringify(h.config));
    let completed = false;
    const newReload = h.instance.reload().then(() => { completed = true; });
    await new Promise(setImmediate);
    assert.equal(reads, 2);
    assert.equal(completed, false);
    assert.equal(h.instance.enabled, true);
    release.resolve();
    await oldReload;
    await newReload;
    assert.equal(reads, 3);
    assert.equal(h.instance.enabled, false);
    assert.equal(h.reads, 0);
    assert.equal(h.connects, 0);
  } finally { release.resolve(); }
});

test('a malformed persisted stop marker fences enabled inference after reopening', async t => {
  const h = await unbound(t, { prepare: async s => {
    await mkdir(s.config.credentialSwap.stateDir);
    await writeFile(join(s.config.credentialSwap.stateDir, 'stopped.json'), '{');
  } });
  assert.equal((await directRequest(h.instance)).status, 503);
  await h.instance.close();
  const reopened = await createCredentialSwapServer({ configPath: h.configPath, now: () => NOW,
    keychain: { read() { throw new Error('unexpected_test_read'); } } });
  try { assert.equal((await directRequest(reopened)).status, 503); }
  finally { await reopened.close(); }
  assert.equal(h.reads, 0);
  assert.equal(h.connects, 0);
});

async function harness(t, { handler, enabled = true, timeout = 1000, executor, watchImpl, stateIO, prepare } = {}) {
  const s = await sandbox(t, false);
  let instance;
  const upstreamCalls = [];
  const legacyCalls = [];
  const upstream = http.createServer((req, res) => {
    upstreamCalls.push(req);
    if (handler) handler(req, res);
    else { req.resume(); req.on('end', () => res.end('upstream-test')); }
  });
  const legacy = http.createServer((req, res) => {
    legacyCalls.push(req); req.resume(); req.on('end', () => res.end('legacy-test'));
  });
  t.after(async () => {
    await instance?.close();
    for (const server of [upstream, legacy]) {
      server.closeAllConnections();
      if (server.listening) await new Promise(done => server.close(done));
    }
    await rm(s.root, { recursive: true, force: true });
  });
  const target = await listen(upstream);
  const legacyUrl = await listen(legacy);
  Object.assign(s.config.credentialSwap, { enabled, legacyProxyUrl: legacyUrl, requestTimeoutMs: timeout });
  const configPath = join(s.root, 'swap-settings.json');
  await writeFile(configPath, JSON.stringify(s.config));
  await prepare?.(s);
  const fake = fakeExecutor(s.account, executor);
  instance = await createCredentialSwapServer({ configPath,
    keychain: createSwapKeychainReader({ execute: fake.execute, now: () => NOW }),
    upstream: target, now: () => NOW, watchImpl, stateIO });
  const url = await listen(instance.server);
  async function rewrite(update, reload = true) {
    update(s.config.credentialSwap);
    const temp = `${configPath}.next`;
    await writeFile(temp, JSON.stringify(s.config));
    await rename(temp, configPath);
    if (reload) await instance.reload();
  }
  return { ...s, instance, url, fake, upstreamCalls, legacyCalls, configPath, rewrite, upstreamUrl: target };
}

function request(url, { method = 'POST', path = '/v1/messages', headers = {}, body = '{"test":true}' } = {}) {
  return new Promise((done, reject) => {
    const req = http.request(url, { method, path, agent: false,
      // Node does not automatically frame GET/HEAD bodies passed to end().
      headers: { [CALLER_HEADER]: CALLER, authorization: `Bearer ${DISPLAY}`,
        'content-length': Buffer.byteLength(body), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, text, headers: res.headers }));
      res.on('aborted', () => done({ status: res.statusCode, text, aborted: true }));
      res.on('error', () => {});
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('HTTP swaps only inference, strips local headers, and preserves display authentication elsewhere', async t => {
  const h = await harness(t);
  for (const [method, path, swapped] of [['POST', '/v1/messages', true], ['POST', '/v1/messages?beta=true', true],
    ['POST', '/v1/messages/', false], ['POST', '/V1/messages', false], ['GET', '/v1/messages', false], ['HEAD', '/api/hello', false]]) {
    const reply = await request(h.url, { method, path, headers: { 'x-api-key': DISPLAY, 'x-claude-rotator-account': 'spoofed' } });
    assert.equal(reply.status, 200, `${method} ${path}`);
    const sent = h.upstreamCalls.at(-1);
    assert.equal(sent.url, path);
    assert.equal(sent.headers.authorization === `Bearer ${swapped ? ACCESS : DISPLAY}`, true);
    assert.equal(sent.headers['x-api-key'], swapped ? undefined : DISPLAY);
    assert.equal(sent.headers[CALLER_HEADER], undefined);
    assert.equal(sent.headers['x-claude-rotator-account'], undefined);
  }
  assert.equal(h.fake.reads, 2);
  assert.equal(h.legacyCalls.length, 0);
});

test('HTTP absolute targets are refused without contacting Keychain or upstream', async t => {
  const h = await harness(t);
  for (const path of ['http://example.invalid/v1/messages', '//example.invalid/v1/messages']) {
    assert.equal((await request(h.url, { path })).status, 400);
  }
  assert.equal(h.fake.calls.length, 0);
  assert.equal(h.upstreamCalls.length + h.legacyCalls.length, 0);
});

test('HTTP unauthorized, missing, expired and forged callers never read Keychain or connect upstream', async t => {
  const h = await harness(t);
  for (const headers of [{ [CALLER_HEADER]: '' }, { [CALLER_HEADER]: 'test-unknown-credential-not-real' },
    { [CALLER_HEADER]: '', 'x-claude-rotator-account': 'display-test' }]) {
    assert.equal((await request(h.url, { headers })).status, 401);
  }
  await h.rewrite(config => { config.callers[0].expiresAt = NOW; });
  assert.equal((await request(h.url)).status, 401);
  assert.equal(h.fake.calls.length, 0);
  assert.equal(h.upstreamCalls.length + h.legacyCalls.length, 0);
});

test('HTTP off routes authorized inference to legacy with original authentication and zero Keychain reads', async t => {
  const h = await harness(t, { enabled: false });
  assert.equal((await request(h.url)).text, 'legacy-test');
  assert.equal(h.legacyCalls[0].headers.authorization === `Bearer ${DISPLAY}`, true);
  assert.equal(h.legacyCalls[0].headers[CALLER_HEADER], undefined);
  assert.equal(h.fake.calls.length, 0);
  assert.equal((await request(h.url, { method: 'HEAD', path: '/api/hello' })).status, 200);
  assert.equal(h.upstreamCalls.length, 1);
});

test('HTTP upstream 401 becomes a fixed 503 without leaking headers/body or retrying', async t => {
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(401, { 'x-test-private': ACCESS }); res.end(REFRESH); });
  } });
  const reply = await request(h.url);
  assert.equal(reply.status, 503);
  assert.equal(reply.headers['x-test-private'], undefined);
  assert.equal(reply.text.includes(REFRESH), false);
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.legacyCalls.length, 0);
});

test('HTTP 403 fences swapping through off and restart while allowing legacy rollback and hello', async t => {
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(403); res.end(ACCESS); });
  } });
  assert.equal((await request(h.url)).status, 503);
  await h.rewrite(config => { config.enabled = false; });
  const reads = h.fake.reads;
  assert.equal((await request(h.url)).status, 200);
  assert.equal(h.legacyCalls.length, 1);
  assert.equal(h.legacyCalls[0].headers.authorization, `Bearer ${DISPLAY}`);
  assert.equal(h.fake.reads, reads);
  await h.rewrite(config => { config.enabled = true; });
  assert.equal((await request(h.url)).status, 503);
  assert.equal(h.fake.reads, reads);
  await h.instance.close();
  const next = await createCredentialSwapServer({ configPath: h.configPath,
    keychain: { read() { throw new Error('must not read'); } }, now: () => NOW,
    upstream: h.upstreamUrl });
  try {
    const url = await listen(next.server);
    assert.equal((await request(url)).status, 503);
    assert.equal(h.upstreamCalls.length, 1);
    assert.equal((await request(url, { method: 'HEAD', path: '/api/hello' })).status, 403);
    const stopped = JSON.parse(await readFile(join(h.config.credentialSwap.stateDir, 'stopped.json'), 'utf8'));
    assert.equal(stopped.stopped, true);
  } finally {
    // Drain the reopened server's events before the harness removes its state.
    await next.close();
  }
  await h.rewrite(config => { config.enabled = false; }, false);
  const off = await createCredentialSwapServer({ configPath: h.configPath,
    keychain: { read() { throw new Error('must not read'); } }, now: () => NOW,
    upstream: h.upstreamUrl });
  try {
    assert.equal((await request(await listen(off.server))).status, 200);
    assert.equal(h.legacyCalls.length, 2);
    assert.equal(h.legacyCalls[1].headers.authorization, `Bearer ${DISPLAY}`);
    assert.equal(h.upstreamCalls.length, 2);
  } finally { await off.close(); }
});

for (const enabled of [true, false]) {
  test(`HTTP internal targets are rejected locally after authentication (enabled=${enabled})`, async t => {
    const h = await harness(t, { enabled });
    for (const path of ['/internal', '/internal/', '/internal/reload', '/internal/reload?x=1']) {
      assert.equal((await request(h.url, { path, headers: { [CALLER_HEADER]: '' } })).status, 401);
      assert.equal((await request(h.url, { path })).status, 404);
    }
    assert.equal(h.fake.calls.length, 0);
    assert.equal(h.upstreamCalls.length, 0);
    assert.equal(h.legacyCalls.length, 0);
    await h.instance.flushEvents();
    const eventsDir = join(h.config.credentialSwap.stateDir, 'events');
    const events = await Promise.all((await readdir(eventsDir)).map(async name =>
      JSON.parse(await readFile(join(eventsDir, name), 'utf8'))));
    assert.equal(events.filter(event => event.reason === 'internal_target').length, 4);
    assert.equal((await request(h.url, { path: '/internal-foo' })).status, 200);
    assert.equal(h.upstreamCalls.length, 1);
    assert.equal(h.upstreamCalls[0].headers.authorization, `Bearer ${DISPLAY}`);
    assert.equal((await request(h.url)).status, 200);
    assert.equal(h.fake.reads, enabled ? 1 : 0);
    assert.equal(h.upstreamCalls.length, enabled ? 2 : 1);
    assert.equal(h.legacyCalls.length, enabled ? 0 : 1);
  });
}

// A transport stand-in exercises dispatch and stop persistence without a socket.
function stubTransport(t, statusCode) {
  const calls = [];
  t.mock.method(http, 'request', (target, options, callback) => {
    calls.push({ target: String(target), ...options });
    const outgoing = new Writable({ write(_chunk, _encoding, done) { done(); } });
    outgoing.on('finish', () => {
      const response = new PassThrough();
      Object.assign(response, { statusCode, headers: {} });
      callback(response);
      response.end();
    });
    return outgoing;
  });
  return calls;
}

for (const enabled of [true, false]) {
  test(`internal targets reject before credential or transport access without sockets (enabled=${enabled})`, async t => {
    const h = await unbound(t, {
      prepare: s => { s.config.credentialSwap.enabled = enabled; },
      keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
      mockConnect: false,
    });
    for (const path of ['/internal', '/internal/', '/internal/reload', '/internal/reload?x=1']) {
      assert.equal((await directRequest(h.instance, { path, headers: {} })).status, 401);
      assert.equal((await directRequest(h.instance, { path })).status, 404);
    }
    assert.equal(h.reads, 0);
    assert.equal(h.connects, 0);
    await h.instance.flushEvents();
    const dir = join(h.config.credentialSwap.stateDir, 'events');
    const events = await Promise.all((await readdir(dir)).map(async name =>
      JSON.parse(await readFile(join(dir, name), 'utf8'))));
    assert.equal(events.filter(event => event.reason === 'internal_target').length, 4);
    const calls = stubTransport(t, 200);
    t.mock.method(https, 'request', http.request);
    const headers = { [CALLER_HEADER]: CALLER, authorization: `Bearer ${DISPLAY}` };
    assert.equal((await directRequest(h.instance, { path: '/internal-foo', headers })).status, 200);
    assert.equal(calls[0].headers.authorization, `Bearer ${DISPLAY}`);
    assert.equal((await directRequest(h.instance, { headers })).status, 200);
    assert.equal(h.reads, enabled ? 1 : 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers.authorization, `Bearer ${enabled ? ACCESS : DISPLAY}`);
    assert.equal(calls[1].target, enabled ? 'https://api.anthropic.com/' : 'http://127.0.0.1:37891/');
  });
}

for (const failure of ['direct', 'durable']) {
  test(`403 remains stopped after a ${failure} stop-write failure and restart without sockets`, async t => {
    const writes = [];
    const { writeJsonFileDurable } = await import('../src/json-file.js');
    const h = await unbound(t, {
      keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
      mockConnect: false,
      stateIO: {
        async writeFile(path, ...args) {
          writes.push('direct');
          if (failure === 'direct') throw new Error('injected_write_failure');
          return writeFile(path, ...args);
        },
        async writeJsonFileDurable(path, ...args) {
          if (path.endsWith('/stopped.json')) {
            writes.push('durable');
            assert.equal(await readFile(path, 'utf8'), '');
            throw new Error('injected_write_failure');
          }
          return writeJsonFileDurable(path, ...args);
        },
      },
    });
    // Only the stand-in HTTP transport can be reached by these requests.
    const calls = stubTransport(t, 403);
    h.config.credentialSwap.legacyProxyUrl = 'http://127.0.0.1:12345';
    await writeFile(h.configPath, JSON.stringify(h.config));
    await h.instance.reload();
    const stateDir = h.config.credentialSwap.stateDir;
    assert.ok((await readdir(stateDir)).includes('started-once'));
    assert.ok((await readdir(stateDir)).includes('persist-canary'));
    // The default upstream uses HTTPS; substitute the same stand-in for it.
    t.mock.method(https, 'request', http.request);
    assert.equal((await directRequest(h.instance)).status, 503);
    assert.deepEqual(writes, failure === 'direct' ? ['direct'] : ['direct', 'durable']);
    assert.equal((await readdir(stateDir)).includes('persist-canary'), false);
    assert.equal(h.reads, 1);
    h.config.credentialSwap.enabled = false;
    await writeFile(h.configPath, JSON.stringify(h.config));
    await h.instance.reload();
    assert.equal((await directRequest(h.instance, { headers: {
      [CALLER_HEADER]: CALLER, authorization: `Bearer ${DISPLAY}`,
    } })).status, 403);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].target, h.config.credentialSwap.legacyProxyUrl + '/');
    assert.equal(calls[1].headers.authorization, `Bearer ${DISPLAY}`);
    assert.equal(h.reads, 1);
    h.config.credentialSwap.enabled = true;
    await writeFile(h.configPath, JSON.stringify(h.config));
    await h.instance.reload();
    assert.equal((await directRequest(h.instance)).status, 503);
    assert.equal(calls.length, 2);
    assert.equal(h.reads, 1);
    await h.instance.close();
    let reads = 0;
    const reopened = await createCredentialSwapServer({ configPath: h.configPath, now: () => NOW,
      keychain: { read() { reads++; throw new Error('unexpected_test_read'); } } });
    try {
      assert.equal((await directRequest(reopened)).status, 503);
      assert.equal(reads, 0);
      assert.equal(calls.length, 2);
      assert.ok((await readdir(stateDir)).includes('stopped.json'));
      assert.equal((await readdir(stateDir)).includes('persist-canary'), false);
    } finally { await reopened.close(); }
    h.config.credentialSwap.enabled = false;
    await writeFile(h.configPath, JSON.stringify(h.config));
    const off = await createCredentialSwapServer({ configPath: h.configPath, now: () => NOW,
      keychain: { read() { reads++; throw new Error('unexpected_test_read'); } } });
    try {
      assert.equal((await directRequest(off)).status, 403);
      assert.equal(reads, 0);
      assert.equal(calls.length, 3);
      assert.equal(calls[2].target, h.config.credentialSwap.legacyProxyUrl + '/');
    } finally { await off.close(); }
  });
}

for (const marker of ['tmp', 'canary']) {
  test(`startup fences uncertain stop persistence from ${marker}`, async t => {
    const h = await unbound(t, { prepare: async s => {
      const dir = s.config.credentialSwap.stateDir;
      await mkdir(dir);
      await writeFile(join(dir, 'started-once'), '{}');
      if (marker === 'tmp') {
        await writeFile(join(dir, 'persist-canary'), '{}');
        await writeFile(join(dir, 'stopped.json.123.abcdef123456.tmp'), '{');
      }
    } });
    assert.equal((await directRequest(h.instance)).status, 503);
    assert.equal(h.reads, 0);
    assert.equal(h.connects, 0);
    assert.ok((await readdir(h.config.credentialSwap.stateDir)).includes('stopped.json'));
    if (marker === 'canary') assert.equal((await readdir(h.config.credentialSwap.stateDir)).includes('persist-canary'), false);
  });
}

for (const marker of ['started-once', 'persist-canary']) {
  test(`startup fails closed if ${marker} cannot be created`, async t => {
    const s = await sandbox(t);
    const configPath = join(s.root, 'swap-settings.json');
    await writeFile(configPath, JSON.stringify(s.config));
    const { writeJsonFileDurable } = await import('../src/json-file.js');
    await assert.rejects(createCredentialSwapServer({ configPath, stateIO: {
      writeJsonFileDurable(path, ...args) {
        if (path.endsWith(`/${marker}`)) throw new Error('injected_write_failure');
        return writeJsonFileDurable(path, ...args);
      },
    } }), /^Error: swap_state_unavailable$/);
  });
}

test('HTTP SSE is streamed incrementally without buffering or altering payloads', async t => {
  const first = defer();
  const proceed = defer();
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      await proceed.promise;
      res.end('data: second\n\n');
    });
  } });
  const result = new Promise((done, reject) => {
    const req = http.request(h.url, { method: 'POST', path: '/v1/messages', headers: { [CALLER_HEADER]: CALLER } }, res => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk.toString()); first.resolve(); });
      res.on('end', () => done(chunks.join('')));
    });
    req.on('error', reject); req.end('{}');
  });
  await first.promise;
  proceed.resolve();
  assert.equal(await result, 'data: first\n\ndata: second\n\n');
});

test('HTTP client cancellation aborts the upstream stream and never resends', async t => {
  const closed = defer();
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: test\n\n'); });
    res.on('close', () => closed.resolve());
  } });
  await new Promise((done, reject) => {
    const req = http.request(h.url, { method: 'POST', path: '/v1/messages', headers: { [CALLER_HEADER]: CALLER } }, res => {
      res.once('data', () => { res.destroy(); done(); });
    });
    req.on('error', reject); req.end('{}');
  });
  await closed.promise;
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.legacyCalls.length, 0);
});

test('HTTP upstream disconnect after response headers closes the client without retry', async t => {
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200); res.write('test-partial'); setImmediate(() => res.destroy());
    });
  } });
  const result = await request(h.url);
  assert.equal(result.aborted, true);
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.legacyCalls.length, 0);
});

test('HTTP timeout after sending the body never retries with another credential or legacy', async t => {
  const h = await harness(t, { timeout: 40, handler: req => req.resume() });
  assert.equal((await request(h.url)).status, 504);
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.legacyCalls.length, 0);
});

test('HTTP off interrupts both a locked credential queue and a stuck value read within one second', async t => {
  const reading = defer();
  const release = defer();
  const h = await harness(t, { executor: { read: async () => {
    reading.resolve(); await release.promise;
    return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, expiresAt: NOW + 3_600_000 } }) };
  } } });
  t.after(() => release.resolve());
  const first = request(h.url);
  await reading.promise;
  const second = request(h.url);
  await delay(20);
  const started = Date.now();
  await h.rewrite(config => { config.enabled = false; }, false);
  const results = await Promise.all([first, second]);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(results.map(result => result.text), ['legacy-test', 'legacy-test']);
  assert.equal(h.fake.reads, 1);
  assert.equal(h.upstreamCalls.length, 0);
  assert.equal(h.legacyCalls.length, 2);
  release.resolve();
});

test('HTTP polling detects off after an atomic config rename even when watch notifications are lost', async t => {
  const h = await harness(t, { watchImpl: () => ({ close() {}, on() {} }) });
  await h.rewrite(config => { config.enabled = false; }, false);
  const deadline = Date.now() + 1000;
  while (h.instance.enabled && Date.now() < deadline) await delay(10);
  assert.equal(h.instance.enabled, false);
  assert.equal((await request(h.url)).text, 'legacy-test');
});

test('HTTP a dispatched request stays with its destination after off without replaying its body', async t => {
  const received = defer();
  const release = defer();
  let bodies = 0;
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', async () => { bodies++; received.resolve(); await release.promise; res.end('sent-once'); });
  } });
  const pending = request(h.url);
  await received.promise;
  await h.rewrite(config => { config.enabled = false; });
  assert.equal((await request(h.url)).text, 'legacy-test');
  release.resolve();
  assert.equal((await pending).text, 'sent-once');
  assert.equal(bodies, 1);
  assert.equal(h.upstreamCalls.length, 1);
  assert.equal(h.legacyCalls.length, 1);
});

test('HTTP events and errors contain no dummy secrets, request bodies, queries or caller headers', async t => {
  const h = await harness(t, { handler: (req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(401); res.end(REFRESH); });
  } });
  const result = await request(h.url, { path: `/v1/messages?test=${ACCESS}`, body: REFRESH });
  await h.instance.flushEvents();
  const files = await readdir(join(h.config.credentialSwap.stateDir, 'events'));
  assert.equal(files.length, 1);
  const logged = await readFile(join(h.config.credentialSwap.stateDir, 'events', files[0]), 'utf8');
  for (const value of [ACCESS, REFRESH, DISPLAY, CALLER]) {
    assert.equal(logged.includes(value), false);
    assert.equal(result.text.includes(value), false);
  }
  const event = JSON.parse(logged);
  assert.deepEqual(Object.keys(event).sort(), ['displayAccountId', 'reason', 'requestId', 'route', 'sentAccountId', 'statusCode', 'swapped'].sort());
  assert.equal(event.displayAccountId, 'display-test');
  assert.equal(event.sentAccountId, 'swap-test');
  assert.equal(event.reason, 'upstream_unauthorized');
});

for (const enabled of [true, false]) {
  test(`noncanonical internal paths are rejected after authentication (enabled=${enabled})`, async t => {
    const h = await unbound(t, { prepare: s => { s.config.credentialSwap.enabled = enabled; } });
    for (const path of ['/v1/../internal/reload', '/%69nternal/reload', '/%2e/internal',
      '/v1/%2e%2e/internal/reload', '/internal%2freload', '/internal//reload',
      '/%2569nternal/reload', '/internal%5creload', '/bad%xx']) {
      assert.equal((await directRequest(h.instance, { path, headers: {} })).status, 401, path);
      assert.equal((await directRequest(h.instance, { path })).status, 400, path);
    }
    assert.equal(h.reads, 0);
    assert.equal(h.connects, 0);
  });
}

test('event write failure fences only swapping and preserves off rollback and passthrough', async t => {
  const { writeJsonFileDurable } = await import('../src/json-file.js');
  const h = await unbound(t, { mockConnect: false,
    keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
    stateIO: { writeJsonFileDurable(path, ...args) {
      if (dirname(path).endsWith('/events')) throw new Error(ACCESS);
      return writeJsonFileDurable(path, ...args);
    } },
  });
  const calls = stubTransport(t, 200);
  t.mock.method(https, 'request', http.request);
  assert.equal((await directRequest(h.instance, { path: '/internal' })).status, 404);
  await h.instance.flushEvents();
  assert.equal((await directRequest(h.instance)).status, 503);
  assert.equal(h.reads, 0);
  h.config.credentialSwap.enabled = false;
  h.config.credentialSwap.legacyProxyUrl = 'http://127.0.0.1:12345';
  await writeFile(h.configPath, JSON.stringify(h.config));
  await h.instance.reload();
  const headers = { [CALLER_HEADER]: CALLER, authorization: `Bearer ${DISPLAY}`, 'x-api-key': DISPLAY };
  assert.equal((await directRequest(h.instance, { headers })).status, 200);
  assert.equal((await directRequest(h.instance, { headers, path: '/api/hello' })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target, 'http://127.0.0.1:12345/');
  assert.equal(calls[0].headers.authorization, `Bearer ${DISPLAY}`);
  assert.equal(calls[0].headers['x-api-key'], DISPLAY);
  assert.equal(calls[1].headers.authorization, `Bearer ${DISPLAY}`);
  assert.equal(h.reads, 0);
});

test('off reroutes an unsent credential wait after event storage fails without replay', async t => {
  const entered = defer();
  const release = defer();
  const { writeJsonFileDurable } = await import('../src/json-file.js');
  const h = await unbound(t, { mockConnect: false, keychain: { read: async () => {
    entered.resolve(); await release.promise;
    return { accessToken: ACCESS, expiresAt: NOW + 3_600_000 };
  } }, stateIO: { writeJsonFileDurable(path, ...args) {
    if (dirname(path).endsWith('/events')) throw new Error('injected_event_failure');
    return writeJsonFileDurable(path, ...args);
  } } });
  const calls = stubTransport(t, 200);
  t.mock.method(https, 'request', http.request);
  const pending = directRequest(h.instance, { headers: {
    [CALLER_HEADER]: CALLER, authorization: `Bearer ${DISPLAY}`,
  } });
  await entered.promise;
  try {
    assert.equal((await directRequest(h.instance, { path: '/internal' })).status, 404);
    await h.instance.flushEvents();
    h.config.credentialSwap.enabled = false;
    h.config.credentialSwap.legacyProxyUrl = 'http://127.0.0.1:12345';
    await writeFile(h.configPath, JSON.stringify(h.config));
    await h.instance.reload();
    assert.equal((await pending).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, 'http://127.0.0.1:12345/');
    assert.equal(calls[0].headers.authorization, `Bearer ${DISPLAY}`);
    assert.equal(h.reads, 1);
  } finally { release.resolve(); }
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
});

for (const failure of [null, 'file_sync', 'directory_sync']) {
  test(`empty stop marker is durable before replacement (${failure || 'success'})`, async t => {
    const operations = [];
    let injected = false;
    const { writeJsonFileDurable, removeFileDurable } = await import('../src/json-file.js');
    const h = await unbound(t, { mockConnect: false,
      keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
      stateIO: {
        async writeFile(path, body, options) {
          operations.push('empty_file');
          assert.equal(body, '');
          assert.equal(options.flush, true);
          await writeFile(path, body, options);
          if (failure === 'file_sync') { injected = true; throw new Error('injected_sync_failure'); }
        },
        async open(path, flags) {
          const handle = await open(path, flags);
          return { async sync() {
            operations.push('directory_sync');
            if (failure === 'directory_sync') { injected = true; throw new Error('injected_sync_failure'); }
            await handle.sync();
          }, close: () => handle.close() };
        },
        writeJsonFileDurable(path, ...args) {
          if (path.endsWith('/stopped.json')) operations.push('replace');
          return writeJsonFileDurable(path, ...args);
        },
        async removeFileDurable(path) {
          operations.push('remove_canary');
          assert.ok(path.endsWith('/persist-canary'));
          return removeFileDurable(path);
        },
      },
    });
    stubTransport(t, 403);
    t.mock.method(https, 'request', http.request);
    assert.equal((await directRequest(h.instance)).status, 503);
    assert.equal(injected, Boolean(failure));
    assert.deepEqual(operations, failure === 'file_sync' ? ['empty_file', 'remove_canary']
      : failure === 'directory_sync' ? ['empty_file', 'directory_sync', 'remove_canary']
        : ['empty_file', 'directory_sync', 'replace']);
    const dir = h.config.credentialSwap.stateDir;
    assert.equal((await readdir(dir)).includes('persist-canary'), !failure);
    await h.instance.close();
    const reopened = await createCredentialSwapServer({ configPath: h.configPath, now: () => NOW,
      keychain: { read() { throw new Error('unexpected_test_read'); } } });
    try { assert.equal((await directRequest(reopened)).status, 503); }
    finally { await reopened.close(); }
  });
}

test('Keychain ignores unrelated null, escaped and unparseable attributes from a fixture', async t => {
  const { account } = await sandbox(t);
  const fixture = (await readFile(new URL('../fixtures/credential-swap-unrelated-attributes.txt', import.meta.url), 'utf8'))
    .replaceAll('@KEYCHAIN@', account.keychainPath);
  const fake = fakeExecutor(account, { dump: () => fixture + attributes(account) });
  const credential = await createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
    .read(account, { marginMs: 300_000 });
  assert.equal(credential.accessToken, ACCESS);
  assert.equal(fake.reads, 1);
});

test('Keychain reads the anonymized dump timedate with octal NUL and one or two separator spaces', async t => {
  const { account } = await sandbox(t);
  const fixture = await readFile(new URL('../fixtures/credential-swap-dump-mdat.txt', import.meta.url), 'utf8');
  const unrelated = await readFile(new URL('../fixtures/credential-swap-unrelated-attributes.txt', import.meta.url), 'utf8');
  assert.equal(fixture.includes('\0'), false);
  assert.match(fixture, /^ {4}"mdat"<timedate>=0x[0-9A-Fa-f]{32} {2}"\d{14}Z\\000"$/m);
  for (const spaces of [' ', '  ']) {
    const dump = (fixture.replace(/ {2}(?="\d{14}Z)/, spaces) + unrelated)
      .replaceAll('@KEYCHAIN@', account.keychainPath).replaceAll('@ACCOUNT@', account.acct)
      .replaceAll('@SERVICE@', account.service);
    const fake = fakeExecutor(account, { dump: () => dump });
    const reader = createSwapKeychainReader({ execute: fake.execute, now: () => NOW });
    assert.equal((await reader.read(account, { marginMs: 300_000 })).accessToken, ACCESS);
    assert.equal(fake.reads, 1);
    const duplicate = fakeExecutor(account, { dump: () => dump + attributes(account) });
    await assert.rejects(createSwapKeychainReader({ execute: duplicate.execute, now: () => NOW })
      .read(account, { marginMs: 300_000 }), /^Error: credential_unavailable$/);
    assert.equal(duplicate.reads, 0);
  }
});

test('dump quotes decode octal bytes but reject JSON-only and malformed escapes on possible matches', async t => {
  const { account } = await sandbox(t);
  const octal = fakeExecutor(account, { dump: () => attributes(account, {
    acct: account.acct.replaceAll('-', '\\055'),
  }) });
  await createSwapKeychainReader({ execute: octal.execute, now: () => NOW })
    .read(account, { marginMs: 300_000 });
  assert.equal(octal.reads, 1);
  const dumps = [attributes(account, { acct: account.acct.replaceAll('-', '\\u002d') }),
    ...['20330518033320Z\\u0000', '20330518033320Z\\0', '20330518033320Z\\400',
      '20330518033320Z\0', '20330518033320Z\\n'].map(mdat => attributes(account, { mdat }))];
  for (const dump of dumps) {
    const fake = fakeExecutor(account, { dump: () => dump });
    await assert.rejects(createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
      .read(account, { marginMs: 300_000 }), /^Error: credential_unavailable$/);
    assert.equal(fake.reads, 0);
  }
});

for (const malformed of ['unknown_account', 'unknown_service', 'duplicate_account']) {
  test(`Keychain rejects ambiguous potentially matching attributes: ${malformed}`, async t => {
    const { account } = await sandbox(t);
    let ambiguous = attributes(account);
    if (malformed === 'unknown_account') ambiguous = ambiguous.replace(`="${account.acct}"`, '=unrecognised-test-format');
    if (malformed === 'unknown_service') ambiguous = ambiguous.replace(`="${account.service}"`, '=unrecognised-test-format');
    if (malformed === 'duplicate_account') ambiguous += `    "acct"<blob>="unrelated-test-account"\n`;
    const fake = fakeExecutor(account, { dump: () => attributes(account) + ambiguous });
    await assert.rejects(createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
      .read(account, { marginMs: 300_000 }), /^Error: credential_unavailable$/);
    assert.equal(fake.reads, 0);
  });
}

test('expiry rollback is rejected without dispatch and a fresh reader accepts a valid shorter reissue', async t => {
  let expiry = NOW + 3_600_000;
  let token = ACCESS;
  const h = await sandbox(t, false);
  const fake = fakeExecutor(h.account, { read: () => ({ stdout: JSON.stringify({ claudeAiOauth: {
    accessToken: token, expiresAt: expiry,
  } }) }) });
  const reader = createSwapKeychainReader({ execute: fake.execute, now: () => NOW });
  const configPath = join(h.root, 'swap-settings.json');
  await writeFile(configPath, JSON.stringify(h.config));
  const instance = await createCredentialSwapServer({ configPath, now: () => NOW, keychain: reader });
  t.after(async () => { await instance.close(); await rm(h.root, { recursive: true, force: true }); });
  const calls = stubTransport(t, 200);
  t.mock.method(https, 'request', http.request);
  assert.equal((await directRequest(instance)).status, 200);
  expiry = NOW + 1_800_000;
  token = 'test-reissued-token-not-real';
  assert.equal((await directRequest(instance)).status, 503);
  assert.equal((await directRequest(instance)).status, 503);
  assert.equal(calls.length, 1);
  await instance.flushEvents();
  const reasons = await Promise.all((await readdir(join(h.config.credentialSwap.stateDir, 'events')))
    .map(async name => JSON.parse(await readFile(join(h.config.credentialSwap.stateDir, 'events', name), 'utf8')).reason));
  assert.equal(reasons.filter(reason => reason === 'credential_expiry_rollback').length, 2);
  const fresh = createSwapKeychainReader({ execute: fake.execute, now: () => NOW });
  assert.equal((await fresh.read(h.account, { marginMs: 300_000 })).expiresAt, expiry);
  expiry = NOW + 3_600_000;
  assert.equal((await reader.read(h.account, { marginMs: 300_000 })).expiresAt, expiry);
  expiry++;
  assert.equal((await reader.read(h.account, { marginMs: 300_000 })).expiresAt, expiry);
});

test('same-second attribute changes reject a credential even when mdat is unchanged', async t => {
  const { account } = await sandbox(t);
  const fake = fakeExecutor(account, { dump: ({ reads }) => attributes(account)
    + `    "labl"<blob>="test-label-${reads}"\n` });
  await assert.rejects(createSwapKeychainReader({ execute: fake.execute, now: () => NOW })
    .read(account, { marginMs: 300_000 }), /^Error: credential_unavailable$/);
  assert.equal(fake.reads, 1);
});

test('state directory rejects overlaps with existing application state before filesystem access', async t => {
  const { config, root, account } = await sandbox(t);
  for (const protectedPath of [appConfigDir(), runtimeStatePath(), appDataDir(), linuxAccountsDir(),
    account.configDir, dirname(account.keychainPath)]) {
    for (const stateDir of [protectedPath, dirname(protectedPath), join(protectedPath, 'swap'),
      `${protectedPath}/child/..`, `${protectedPath}/`]) {
      config.credentialSwap.stateDir = stateDir;
      assert.throws(() => normalizeCredentialSwap(config), /^Error: invalid_swap_config$/);
    }
  }
  for (const stateDir of [join(root, 'isolated'), `${appConfigDir()}-separate`,
    `${appDataDir()}-separate`, `${account.configDir}-separate`, `${dirname(account.keychainPath)}-separate`]) {
    config.credentialSwap.stateDir = stateDir;
    assert.equal(normalizeCredentialSwap(config).stateDir, stateDir);
  }
});

test('state separation follows this process environment for config, data and account roots', async t => {
  const { config, root } = await sandbox(t);
  const saved = Object.fromEntries(['XDG_CONFIG_HOME', 'XDG_DATA_HOME'].map(key => [key, process.env[key]]));
  try {
    process.env.XDG_CONFIG_HOME = join(root, 'config-home');
    process.env.XDG_DATA_HOME = join(root, 'data-home');
    assert.equal(appConfigDir(), join(root, 'config-home', 'claude-rotator'));
    assert.equal(appDataDir(), join(root, 'data-home', 'claude-rotator'));
    assert.equal(linuxAccountsDir(), join(root, 'data-home', 'claude-rotator', 'accounts'));
    config.credentialSwap.enabled = false;
    config.credentialSwap.swapAccounts = [];
    for (const protectedPath of [appConfigDir(), appDataDir(), linuxAccountsDir()]) {
      for (const stateDir of [protectedPath, dirname(protectedPath), join(protectedPath, 'swap')]) {
        config.credentialSwap.stateDir = stateDir;
        assert.throws(() => normalizeCredentialSwap(config), /^Error: invalid_swap_config$/);
      }
    }
    config.credentialSwap.stateDir = join(root, 'isolated');
    assert.equal(normalizeCredentialSwap(config).stateDir, config.credentialSwap.stateDir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('event retention bounds file count and bytes while continuing to record recent requests', async t => {
  const h = await unbound(t);
  for (let i = 0; i < 150; i++) {
    assert.equal((await directRequest(h.instance, { headers: {} })).status, 401);
    await h.instance.flushEvents();
  }
  const directory = join(h.config.credentialSwap.stateDir, 'events');
  const names = await readdir(directory);
  assert.ok(names.length > 0 && names.length <= 128);
  const sizes = await Promise.all(names.map(name => stat(join(directory, name))));
  assert.ok(sizes.reduce((total, info) => total + info.size, 0) <= 64 * 1024);
  assert.equal((await directRequest(h.instance, { headers: {} })).status, 401);
  await h.instance.flushEvents();
  const latest = await readdir(directory);
  assert.ok(latest.some(name => !names.includes(name)));
});

test('event retention trims oversized historical files on startup and deletion failure preserves off rollback', async t => {
  const h = await unbound(t, { mockConnect: false, prepare: async s => {
    const dir = join(s.config.credentialSwap.stateDir, 'events');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'test-old.json'), ' '.repeat(70 * 1024));
  } });
  assert.deepEqual(await readdir(join(h.config.credentialSwap.stateDir, 'events')), []);
  await h.instance.close();
  const directory = join(h.config.credentialSwap.stateDir, 'events');
  await writeFile(join(directory, 'test-old.json'), ' '.repeat(70 * 1024));
  const instance = await createCredentialSwapServer({ configPath: h.configPath, now: () => NOW,
    stateIO: { removeFileDurable() { throw new Error(ACCESS); } },
    keychain: { read() { throw new Error('unexpected_test_read'); } } });
  try {
    assert.equal((await directRequest(instance)).status, 503);
    h.config.credentialSwap.enabled = false;
    h.config.credentialSwap.legacyProxyUrl = 'http://127.0.0.1:12345';
    await writeFile(h.configPath, JSON.stringify(h.config));
    await instance.reload();
    const calls = stubTransport(t, 200);
    assert.equal((await directRequest(instance)).status, 200);
    assert.equal(calls.length, 1);
  } finally { await instance.close(); }
});

test('pre-authentication floods leave all authenticated event slots available and swapping enabled', async t => {
  const entered = defer();
  const release = defer();
  const { writeJsonFileDurable } = await import('../src/json-file.js');
  let eventWrites = 0;
  const h = await unbound(t, { mockConnect: false,
    keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
    stateIO: { async writeJsonFileDurable(path, ...args) {
      if (dirname(path).endsWith('/events')) {
        eventWrites++;
        entered.resolve();
        await release.promise;
      }
      return writeJsonFileDurable(path, ...args);
    } },
  });
  const calls = stubTransport(t, 200);
  t.mock.method(https, 'request', http.request);
  assert.equal((await directRequest(h.instance, { headers: {} })).status, 401);
  await entered.promise;
  try {
    const replies = await Promise.all(Array.from({ length: 512 }, (_, index) => directRequest(h.instance,
      index % 2 ? { headers: {} } : { path: 'http://example.invalid/v1/messages' })));
    assert.equal(replies.filter(reply => reply.status === 401).length, 256);
    assert.equal(replies.filter(reply => reply.status === 400).length, 256);
    assert.equal(h.reads, 0);
    assert.equal(calls.length, 0);
    const authenticated = await Promise.all(Array.from({ length: 127 }, () =>
      directRequest(h.instance, { path: '/internal' })));
    assert.equal(authenticated.every(reply => reply.status === 404), true);
    assert.equal((await directRequest(h.instance)).status, 200);
    assert.equal(h.reads, 1);
    assert.equal(calls.length, 1);
    assert.equal(eventWrites, 1);
  } finally { release.resolve(); }
  await h.instance.flushEvents();
  assert.equal(eventWrites, 129);
  assert.equal((await readdir(join(h.config.credentialSwap.stateDir, 'events'))).length, 128);
  assert.equal((await directRequest(h.instance)).status, 200);
  assert.equal(h.reads, 2);
  assert.equal(calls.length, 2);
});

test('pre-authentication event write failures do not fence later authenticated swaps', async t => {
  const { writeJsonFileDurable } = await import('../src/json-file.js');
  let rejectedWrites = 0;
  const h = await unbound(t, { mockConnect: false,
    keychain: { read: async () => ({ accessToken: ACCESS, expiresAt: NOW + 3_600_000 }) },
    stateIO: { writeJsonFileDurable(path, event, ...args) {
      if (dirname(path).endsWith('/events') && event.displayAccountId === null) {
        rejectedWrites++;
        throw new Error('injected_rejection_write_failure');
      }
      return writeJsonFileDurable(path, event, ...args);
    } },
  });
  const calls = stubTransport(t, 200);
  t.mock.method(https, 'request', http.request);
  for (const [options, status] of [[{ headers: {} }, 401], [{ path: '//example.invalid/v1/messages' }, 400]]) {
    assert.equal((await directRequest(h.instance, options)).status, status);
    await h.instance.flushEvents();
    assert.equal((await directRequest(h.instance)).status, 200);
    await h.instance.flushEvents();
  }
  assert.equal(rejectedWrites, 2);
  assert.equal(h.reads, 2);
  assert.equal(calls.length, 2);
  assert.equal((await readdir(join(h.config.credentialSwap.stateDir, 'events'))).length, 2);
});

test('a saturated authenticated event queue stays bounded and permits off rollback', async t => {
  const entered = defer();
  const release = defer();
  const { writeJsonFileDurable } = await import('../src/json-file.js');
  let eventWrites = 0;
  const h = await unbound(t, { mockConnect: false, stateIO: {
    async writeJsonFileDurable(path, ...args) {
      if (dirname(path).endsWith('/events')) {
        eventWrites++;
        entered.resolve();
        await release.promise;
      }
      return writeJsonFileDurable(path, ...args);
    },
  } });
  assert.equal((await directRequest(h.instance, { path: '/internal' })).status, 404);
  await entered.promise;
  try {
    const replies = await Promise.all(Array.from({ length: 128 }, () => directRequest(h.instance, { path: '/internal' })));
    assert.equal(replies.every(reply => reply.status === 404), true);
    assert.equal((await directRequest(h.instance)).status, 503);
    h.config.credentialSwap.enabled = false;
    h.config.credentialSwap.legacyProxyUrl = 'http://127.0.0.1:12345';
    await writeFile(h.configPath, JSON.stringify(h.config));
    await h.instance.reload();
    const calls = stubTransport(t, 200);
    assert.equal((await directRequest(h.instance)).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(h.reads, 0);
  } finally { release.resolve(); }
  await h.instance.flushEvents();
  assert.equal(eventWrites, 1);
  assert.equal((await readdir(join(h.config.credentialSwap.stateDir, 'events'))).length, 1);
});

for (const [code, reason] of [['EADDRINUSE', 'swap_port_in_use'], ['EPERM', 'swap_listen_unavailable']]) {
  test(`CLI reports a fixed startup reason for ${code} without opening a socket`, async t => {
    const { root, config } = await sandbox(t);
    config.credentialSwap.listenPort = 12345;
    const configPath = join(root, 'swap-settings.json');
    await writeFile(configPath, JSON.stringify(config));
    t.mock.method(http.Server.prototype, 'listen', function (port, host) {
      assert.equal(port, 12345);
      assert.equal(host, '127.0.0.1');
      queueMicrotask(() => this.emit('error', Object.assign(new Error(ACCESS), { code })));
      return this;
    });
    const errors = [];
    assert.equal(await runCli(['credential-swap', 'serve', '--config', configPath], {
      error: text => errors.push(text), serveCredentialSwap,
    }), 1);
    assert.deepEqual(errors, [`${reason}\n`]);
  });
}

for (const scenario of ['invalid', 'absent', 'state']) {
  test(`CLI distinguishes ${scenario} startup failure without disclosing raw errors`, async t => {
    const { root, config } = await sandbox(t);
    if (scenario === 'absent') delete config.credentialSwap;
    if (scenario === 'state') {
      await writeFile(config.credentialSwap.stateDir, 'test-file-not-directory');
    }
    const configPath = join(root, 'swap-settings.json');
    await writeFile(configPath, scenario === 'invalid' ? ACCESS : JSON.stringify(config));
    const errors = [];
    assert.equal(await runCli(['credential-swap', 'serve', '--config', configPath], {
      error: text => errors.push(text), serveCredentialSwap,
    }), 1);
    assert.deepEqual(errors, [`${{ invalid: 'invalid_swap_config', absent: 'swap_config_required',
      state: 'swap_state_unavailable' }[scenario]}\n`]);
  });
}

test('slow downstream backpressure pauses the upstream and preserves every byte without replay', async t => {
  const h = await unbound(t, { mockConnect: false });
  let incoming;
  let connects = 0;
  const entered = defer();
  const release = defer();
  const chunk = Buffer.alloc(4096, 0x78);
  let produced = 0;
  const total = 128;
  t.mock.method(https, 'request', (_target, _options, callback) => {
    connects++;
    const outgoing = new Writable({ write(_data, _encoding, next) { next(); } });
    outgoing.on('finish', () => {
      incoming = new Readable({ highWaterMark: 4096, read() {
        if (produced === total) this.push(null);
        else { produced++; this.push(chunk); }
      } });
      Object.assign(incoming, { statusCode: 200, headers: {} });
      callback(incoming);
    });
    return outgoing;
  });
  let bytes = 0;
  const response = new Writable({ highWaterMark: 4096, write(data, _encoding, next) {
    bytes += data.length;
    assert.ok(data.equals(chunk));
    entered.resolve();
    void release.promise.then(next);
  } });
  response.writeHead = status => { response.statusCode = status; response.headersSent = true; };
  const finished = new Promise((done, reject) => { response.on('finish', done); response.on('error', reject); });
  const req = new PassThrough();
  Object.assign(req, { method: 'POST', url: '/api/hello', headers: { [CALLER_HEADER]: CALLER },
    rawHeaders: [CALLER_HEADER, CALLER] });
  h.instance.server.emit('request', req, response);
  req.end('test-body');
  await entered.promise;
  await new Promise(setImmediate);
  const stalledAt = produced;
  assert.ok(stalledAt < total);
  assert.equal(incoming.isPaused(), true);
  await new Promise(setImmediate);
  assert.equal(produced, stalledAt);
  release.resolve();
  await finished;
  assert.equal(bytes, total * chunk.length);
  assert.equal(connects, 1);
});
