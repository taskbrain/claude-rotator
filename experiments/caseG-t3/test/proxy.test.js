import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import * as realFs from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, symlink, link } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { claudeKeychainServiceName } from '../../../src/claude-keychain.js';
import { createProxy } from '../proxy-core.js';
import { runCli, createKeychainStore, loadConfig, projectCredentials, safeExternalPath, openExternalFile } from '../passthrough-proxy.js';
import { installMemoryHttp } from './in-memory-http.js';

// Generate disposable markers in memory; credential values never become fixtures.
function markers() {
  return Object.fromEntries(['inbound', 'swap', 'refresh'].map(kind =>
    [kind, `sk-ant-oat01-SENTINEL-${kind}-${randomBytes(12).toString('hex')}`]));
}

async function setup(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-experiment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const configDir = join(root, 'owner');
  await mkdir(home);
  await mkdir(configDir);
  const env = { HOME: home, USER: 'test-owner', CASEG_PROTO_ENABLE: '1' };
  const config = {
    logPath: join(root, 'requests.jsonl'),
    swapAccount: { configDir, service: claudeKeychainServiceName(configDir), acct: env.USER,
      keychainPath: join(root, 'selected.keychain-db'), keychainAllowlist: [join(root, 'selected.keychain-db')] },
    ...overrides,
  };
  const configFile = join(root, 'proxy.json');
  await writeFile(configFile, JSON.stringify(config));
  return { root, home, env, config, configFile };
}

async function rig(t, { mode = 'swap-messages', handler, read, now, timeoutMs = 1000 } = {}) {
  installMemoryHttp(t);
  const settings = await setup(t);
  const secrets = markers();
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push({ method: req.method, path: req.url, headers: req.headers });
    req.resume();
    if (handler) handler(req, res);
    else res.end('ok');
  });
  await new Promise((resolve, reject) => upstream.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  let reads = 0;
  const store = { async read(identity) {
    assert.equal(identity.service, settings.config.swapAccount.service);
    assert.equal(identity.acct, settings.env.USER);
    reads++;
    if (read) return read({ reads, secrets });
    return {
      credentialJson: JSON.stringify({ claudeAiOauth: {
        accessToken: secrets.swap, refreshToken: secrets.refresh,
        expiresAt: (now ? now() : Date.now()) + 3600000,
      } }), modifiedAt: 1000,
    };
  } };
  const proxy = await createProxy({
    ...settings, mode, apply: true, port: 0,
    upstream: `http://127.0.0.1:${upstream.address().port}`, store, now, timeoutMs,
  });
  await proxy.listen();
  t.after(() => proxy.close());
  const request = (path = '/v1/messages', method = 'POST', headers = {}, body = '') =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.address().port,
        path, method, headers: Object.fromEntries(Object.entries({ authorization: `Bearer ${secrets.inbound}`, ...headers })
          .filter(([, value]) => value !== undefined)) }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('error', () => reject(new Error('client response interrupted')));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', () => reject(new Error('client request failed')));
      req.end(body);
    });
  const logs = async () => (await readFile(settings.config.logPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { ...settings, secrets, received, proxy, request, logs, reads: () => reads };
}

test('CLI refuses missing enable, configuration, mode, unsafe ports and upstream overrides without effects', async t => {
  const s = await setup(t);
  for (const [args, env] of [
    [[], s.env], [['--config', s.configFile], s.env],
    [['--mode', 'passthrough'], s.env],
    [['--mode', 'passthrough', '--config', s.configFile], { ...s.env, CASEG_PROTO_ENABLE: undefined }],
    ...['37891', '37992', '0'].map(port => [['--mode', 'passthrough', '--config', s.configFile, '--port', port], s.env]),
    [['--mode', 'passthrough', '--config', s.configFile, '--upstream', 'http://127.0.0.1:37891'], s.env],
  ]) {
    assert.notEqual(await runCli(args, { env, stdout: () => {}, stderr: () => {} }), 0);
  }
  await assert.rejects(stat(s.config.logPath), { code: 'ENOENT' });
});

test('dry run validates but neither listens, reads credentials nor creates logs', async t => {
  const s = await setup(t);
  const output = [];
  assert.equal(await runCli(['--mode', 'swap-messages', '--config', s.configFile], {
    env: s.env, stdout: v => output.push(v), stderr: v => output.push(v),
  }), 0);
  assert.ok(output.join('').includes('dry-run'));
  await assert.rejects(stat(s.config.logPath), { code: 'ENOENT' });
});

test('configuration refuses production identities, unsafe homes, mismatched USER and symlinks', async t => {
  const s = await setup(t);
  const original = structuredClone(s.config);
  const badAccounts = [
    { ...original.swapAccount, service: 'Claude Code-credentials' },
    { ...original.swapAccount, service: 'Claude Code-credentials-00000000' },
    { ...original.swapAccount, acct: 'someone-else' },
    ...['.claude', '.claude/sub', '.claude.json', '.config/claude-rotator'].map(p => {
      const configDir = join(s.home, p);
      return { ...original.swapAccount, configDir, service: claudeKeychainServiceName(configDir) };
    }),
  ];
  await symlink(join(s.home, '.claude'), join(s.root, 'alias'));
  badAccounts.push({ ...original.swapAccount, configDir: join(s.root, 'alias'), service: claudeKeychainServiceName(join(s.root, 'alias')) });
  for (const swapAccount of badAccounts) {
    await writeFile(s.configFile, JSON.stringify({ ...original, swapAccount }));
    await assert.rejects(loadConfig(s.configFile, { env: s.env }));
  }
  await writeFile(s.configFile, JSON.stringify(original));
  await assert.rejects(loadConfig(s.configFile, { env: { ...s.env, USER: undefined } }));
  await assert.rejects(loadConfig(join(s.home, '.claude', 'settings.json'), { env: s.env }));
  await writeFile(s.configFile, JSON.stringify({ ...original, logPath: join(s.home, '.config/claude-rotator/state') }));
  await assert.rejects(loadConfig(s.configFile, { env: s.env }));
});

test('core refuses disabled writes, production port and non-loopback test upstream', async t => {
  const s = await setup(t);
  for (const extra of [
    { apply: false }, { mode: undefined }, { env: { ...s.env, CASEG_PROTO_ENABLE: '0' } },
    { port: 37891 }, { upstream: 'http://127.0.0.1:37891' },
    { upstream: 'https://example.invalid' }, { upstream: 'http://api.anthropic.com' },
    { upstream: 'https://api.anthropic.com:444' },
  ]) {
    await assert.rejects(createProxy({ ...s, apply: true, mode: 'passthrough', port: 0, ...extra }));
  }
});

test('real credential adapter always throws in the test runner before invoking a command', async t => {
  const s = await setup(t);
  await assert.rejects(createKeychainStore().read(s.config.swapAccount), /unavailable/);
});

test('passthrough preserves Authorization for every path and never reads the store', async t => {
  const r = await rig(t, { mode: 'passthrough' });
  for (const [method, path] of [['POST', '/v1/messages?beta=true'], ['GET', '/v1/messages'], ['POST', '/api/feedback']]) {
    assert.equal((await r.request(path, method)).status, 200);
  }
  assert.equal(r.reads(), 0);
  assert.ok(r.received.every(v => v.headers.authorization === `Bearer ${r.secrets.inbound}`));
  assert.ok((await r.logs()).every(v => !v.swapped && v.upstreamAuthEqualsInbound && !v.upstreamAuthIsSwapAccount));
});

test('only POST with normalized messages pathname swaps, including query strings', async t => {
  const r = await rig(t);
  const cases = [
    ['POST', '/v1/messages', '/v1/messages', true],
    ['POST', '/v1/messages?beta=true', '/v1/messages', true],
    ['GET', '/v1/messages', '/v1/messages', false],
    ['POST', '/v1/messages/count_tokens', '/v1/messages/count_tokens', false],
    ['POST', '/v1/messages/', '/v1/messages/', false],
    ['POST', '/v1//messages', '/v1//messages', false],
    ['POST', '/v1/messages/../x', '/v1/x', false],
    ['POST', '/api/eval/feedback', '/api/eval/feedback', false],
  ];
  for (const [method, path] of cases) assert.equal((await r.request(path, method)).status, 200);
  const logs = await r.logs();
  for (let i = 0; i < cases.length; i++) {
    const [, , pathname, swapped] = cases[i];
    assert.equal(logs[i].pathname, pathname);
    assert.equal(logs[i].swapped, swapped);
    assert.equal(logs[i].upstreamAuthEqualsInbound, !swapped);
    assert.equal(logs[i].upstreamAuthIsSwapAccount, swapped);
    assert.equal(logs[i].inboundAuthPresent, true);
    assert.ok(r.received[i].headers.authorization === `Bearer ${swapped ? r.secrets.swap : r.secrets.inbound}`);
  }
  assert.equal(r.received[1].path, '/v1/messages?beta=true');
});

for (const failure of ['expired', 'near-expiry', 'unreadable', 'malformed', 'missing-expiry', 'bad-token']) {
  test(`credential ${failure} latches 503 with no inbound fallback`, async t => {
    const r = await rig(t, { read({ secrets }) {
      if (failure === 'unreadable') throw new Error(secrets.refresh);
      return { credentialJson: failure === 'malformed' ? '{' : JSON.stringify({ claudeAiOauth: {
        accessToken: failure === 'bad-token' ? `${secrets.swap}\r\n` : secrets.swap,
        expiresAt: failure === 'missing-expiry' ? undefined : Date.now() + (failure === 'near-expiry' ? 1000 : -1000),
        refreshToken: secrets.refresh,
      } }), modifiedAt: 1000 };
    } });
    assert.equal((await r.request()).status, 503);
    assert.equal((await r.request()).status, 503);
    assert.equal(r.received.length, 0);
    assert.equal(r.reads(), 1);
    assert.equal((await r.request('/api/feedback')).status, 200);
    assert.equal(r.received.length, 1);
    assert.ok((await r.logs()).slice(0, 2).every(v => !v.swapped && !v.upstreamAuthEqualsInbound && !v.upstreamAuthIsSwapAccount));
  });
}

for (const status of [401, 403]) {
  test(`swapped ${status} permanently stops swaps without retrying`, async t => {
    const r = await rig(t, { handler(req, res) {
      res.writeHead(status, { 'www-authenticate': 'Bearer upstream-only', 'x-upstream-auth': req.headers.authorization });
      res.end(req.headers.authorization);
    } });
    const response = await r.request();
    assert.equal(response.status, 503);
    assert.equal(response.body === 'Swap unavailable\n', true);
    assert.equal(response.headers['www-authenticate'], undefined);
    assert.equal(response.headers['x-upstream-auth'], undefined);
    assert.equal(response.body.includes(r.secrets.swap), false);
    assert.equal((await r.request()).status, 503);
    assert.equal(r.received.length, 1);
    const row = (await r.logs())[0];
    assert.equal(row.stopReason, 'auth_rejected');
    assert.equal(row.status, 503);
  });
}

for (const caller of ['missing-auth', 'basic-auth', 'empty-bearer', 'foreign-host', 'wrong-port', 'origin', 'empty-origin']) {
  test(`messages refuses ${caller} before reading or forwarding credentials`, async t => {
    const r = await rig(t);
    const headers = {
      'missing-auth': { authorization: undefined },
      'basic-auth': { authorization: 'Basic invalid' },
      'empty-bearer': { authorization: 'Bearer ' },
      'foreign-host': { host: 'example.invalid' },
      'wrong-port': { host: '127.0.0.1:37891' },
      origin: { origin: 'http://localhost' },
      'empty-origin': { origin: '' },
    }[caller];
    const response = await r.request('/v1/messages?beta=true', 'POST', headers);
    assert.ok(response.status >= 400 && response.status < 500);
    assert.equal(r.reads(), 0);
    assert.equal(r.received.length, 0);
    assert.equal((await r.logs())[0].swapped, false);
    assert.equal((await r.request()).status, 200);
  });
}

test('messages accepts the explicit localhost host at its injected listener port', async t => {
  const r = await rig(t);
  assert.equal((await r.request('/v1/messages', 'POST', { host: `localhost:${r.proxy.address().port}` })).status, 200);
  assert.equal((await r.logs())[0].swapped, true);
});

test('untouched responses retain their original authentication rejection status', async t => {
  const r = await rig(t, { handler(req, res) { res.writeHead(401); res.end('unchanged'); } });
  const response = await r.request('/api/feedback');
  assert.equal(response.status, 401);
  assert.equal(response.body, 'unchanged');
  assert.equal(r.reads(), 0);
});

for (const rollback of ['modifiedAt', 'expiresAt']) {
  test(`${rollback} rollback on reread stops swaps as suspected stale credentials`, async t => {
    let clock = 1000000;
    const r = await rig(t, { now: () => clock, read({ reads, secrets }) {
      return { credentialJson: JSON.stringify({ accessToken: secrets.swap, refreshToken: secrets.refresh,
        expiresAt: reads === 1 ? 1400000 : (rollback === 'expiresAt' ? 1399999 : 2000000),
      }), modifiedAt: reads === 1 ? 2000 : (rollback === 'modifiedAt' ? 1999 : 3000) };
    } });
    assert.equal((await r.request()).status, 200);
    clock += 100000;
    assert.equal((await r.request()).status, 503);
    assert.equal((await r.request()).status, 503);
    assert.equal(r.received.length, 1);
    assert.equal((await r.logs())[1].stopReason, 'r8_suspected');
  });
}

test('near-expiry cache rereads the owner, serializes concurrent reads and accepts newer credentials', async t => {
  let clock = 1000000;
  const r = await rig(t, { now: () => clock, async read({ reads, secrets }) {
    await delay(10);
    return { credentialJson: JSON.stringify({ accessToken: secrets.swap, expiresAt: reads === 1 ? 1400000 : 2000000 }), modifiedAt: reads * 1000 };
  } });
  await Promise.all([r.request(), r.request()]);
  assert.equal(r.reads(), 1);
  clock += 100000;
  assert.equal((await r.request()).status, 200);
  assert.equal(r.reads(), 2);
});

test('SSE arrives incrementally and preserves split bytes with hop headers stripped', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const r = await rig(t, { mode: 'passthrough', handler: async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive, x-private-hop', 'x-private-hop': 'drop' });
    res.write('data: first\n\n');
    await gate;
    res.end('data: second\n\n');
  } });
  const req = http.get({ host: '127.0.0.1', port: r.proxy.address().port, path: '/events',
    headers: { connection: 'x-client-hop', 'x-client-hop': 'drop', authorization: `Bearer ${r.secrets.inbound}` } });
  const [res] = await once(req, 'response');
  assert.equal(res.headers['x-private-hop'], undefined);
  const [first] = await once(res, 'data');
  assert.equal(first.toString(), 'data: first\n\n');
  const rest = [];
  res.on('data', chunk => rest.push(chunk));
  release();
  await once(res, 'end');
  assert.equal(Buffer.concat(rest).toString(), 'data: second\n\n');
  assert.equal(r.received[0].headers['x-client-hop'], undefined);
  assert.match(r.received[0].headers.host, /^127\.0\.0\.1:/);
});

test('client disconnect closes the upstream stream', async t => {
  let closed;
  const done = new Promise(resolve => { closed = resolve; });
  const r = await rig(t, { handler(req, res) {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: open\n\n');
  } });
  const req = http.get({ host: '127.0.0.1', port: r.proxy.address().port, path: '/events' });
  const [res] = await once(req, 'response');
  await once(res, 'data');
  res.destroy();
  await Promise.race([done, delay(2000).then(() => { throw new Error('upstream stayed open'); })]);
});

test('redirect is relayed once without following its destination', async t => {
  const r = await rig(t, { handler(req, res) { res.writeHead(302, { location: 'https://example.invalid/' }); res.end(); } });
  assert.equal((await r.request()).status, 302);
  assert.equal(r.received.length, 1);
});

test('upstream timeout returns 504 and stops subsequent swaps', async t => {
  const r = await rig(t, { timeoutMs: 40, handler() {} });
  assert.equal((await r.request()).status, 504);
  assert.equal((await r.request()).status, 503);
  assert.equal(r.received.length, 1);
});

test('upstream disconnect returns 502 and stops subsequent swaps', async t => {
  const r = await rig(t, { handler(req) { req.socket.destroy(); } });
  assert.equal((await r.request()).status, 502);
  assert.equal((await r.request()).status, 503);
  assert.equal(r.received.length, 1);
});

test('logs append one metadata line per request, use mode 0600 and omit all credential markers', async t => {
  const r = await rig(t);
  const stdout = [], stderr = [];
  assert.equal((await r.request(`/v1/messages?hidden=${r.secrets.refresh}`, 'POST', {}, r.secrets.inbound)).status, 200);
  assert.equal((await r.request('/api/feedback')).status, 200);
  const text = await readFile(r.config.logPath, 'utf8');
  assert.equal((await stat(r.config.logPath)).mode & 0o777, 0o600);
  const logs = await r.logs();
  assert.equal(logs.length, 2);
  assert.ok(logs.every(v => typeof v.time === 'string' && Number.isFinite(v.durationMs) && v.status === 200));
  await runCli(['--mode', 'bad', '--config', r.configFile], {
    env: r.env, stdout: v => stdout.push(v), stderr: v => stderr.push(v),
  });
  for (const value of Object.values(r.secrets)) {
    assert.equal(text.includes(value), false);
    assert.equal([...stdout, ...stderr].join('').includes(value), false);
  }
});

test('no inbound Authorization remains absent and is compared without inventing credentials', async t => {
  const r = await rig(t, { mode: 'passthrough' });
  assert.equal((await r.request('/api/feedback', 'POST', { authorization: undefined })).status, 200);
  const [row] = await r.logs();
  assert.equal(row.inboundAuthPresent, false);
  assert.equal(row.upstreamAuthEqualsInbound, true);
  assert.equal(r.received[0].headers.authorization, undefined);
});

test('swap-account observation compares actual Authorization even on an untouched request', async t => {
  const r = await rig(t);
  await r.request();
  await r.request('/api/feedback', 'POST', { authorization: `Bearer ${r.secrets.swap}` });
  const row = (await r.logs())[1];
  assert.equal(row.swapped, false);
  assert.equal(row.upstreamAuthEqualsInbound, true);
  assert.equal(row.upstreamAuthIsSwapAccount, true);
});

test('an unreadable owner during reread latches a failure after previously usable credentials', async t => {
  let clock = 1000000;
  const r = await rig(t, { now: () => clock, read({ reads, secrets }) {
    if (reads > 1) throw new Error(secrets.refresh);
    return { credentialJson: JSON.stringify({ accessToken: secrets.swap, expiresAt: 1400000 }), modifiedAt: 1000 };
  } });
  await r.request();
  clock += 100000;
  assert.equal((await r.request()).status, 503);
  assert.equal((await r.request()).status, 503);
  assert.equal(r.received.length, 1);
  assert.equal(r.reads(), 2);
});

test('projection drops every refresh field and sanitizes parser and store exceptions', async t => {
  const secrets = markers();
  const projected = projectCredentials(JSON.stringify({ claudeAiOauth: {
    accessToken: secrets.swap, expiresAt: 10000000, refreshToken: secrets.refresh,
    refreshTokenExpiresAt: 20000000,
  } }), 1000);
  assert.deepEqual(Object.keys(projected).sort(), ['accessToken', 'expiresAt', 'modifiedAt']);
  const exceptions = [];
  try { projectCredentials(`${secrets.refresh}{`, 1000); } catch (error) { exceptions.push(error); }
  try { await createKeychainStore().read({ acct: secrets.inbound, service: secrets.swap }); } catch (error) { exceptions.push(error); }
  assert.equal(exceptions.length, 2);
  for (const error of exceptions) {
    for (const value of Object.values(secrets)) assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(value), false);
    assert.equal(error.cause, undefined);
  }
});

test('unsafe log destinations, repository config and hardlinked config are refused', async t => {
  const s = await setup(t);
  await assert.rejects(loadConfig(new URL('../local.json', import.meta.url).pathname, { env: s.env }));
  const alias = join(s.root, 'config-alias.json');
  await link(s.configFile, alias);
  await assert.rejects(loadConfig(alias, { env: s.env }));
  await rm(alias);
  for (const logPath of [join(s.config.swapAccount.configDir, 'requests'), s.configFile,
    join(s.home, '.claude', 'requests'), join(s.home, '.claude.json')]) {
    await writeFile(s.configFile, JSON.stringify({ ...s.config, logPath }));
    await assert.rejects(loadConfig(s.configFile, { env: s.env }));
  }
});

test('swap mode refuses a config with no swap account while passthrough can dry-run it', async t => {
  const s = await setup(t);
  await writeFile(s.configFile, JSON.stringify({ logPath: s.config.logPath }));
  const args = ['--config', s.configFile, '--mode'];
  assert.equal(await runCli([...args, 'swap-messages'], { env: s.env, stdout() {}, stderr() {} }), 1);
  assert.equal(await runCli([...args, 'passthrough'], { env: s.env, stdout() {}, stderr() {} }), 0);
});

test('truncated SSE fails the client stream, logs the error and blocks later swaps', async t => {
  const r = await rig(t, { handler(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: incomplete\n\n');
    setImmediate(() => res.destroy());
  } });
  await assert.rejects(r.request(), /interrupted|failed/);
  assert.equal((await r.request()).status, 503);
  const row = (await r.logs())[0];
  assert.equal(row.status, 502);
  assert.equal(row.stopReason, 'upstream_error');
});

test('large streaming response applies backpressure and preserves every byte', async t => {
  const totalChunks = 128;
  const chunk = Buffer.alloc(65536, 97);
  let produced = 0;
  const r = await rig(t, { timeoutMs: 5000, handler: async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let i = 0; i < totalChunks; i++) {
      produced++;
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end();
  } });
  const req = http.get({ host: '127.0.0.1', port: r.proxy.address().port, path: '/events' });
  const [res] = await once(req, 'response');
  res.pause();
  await delay(20);
  assert.ok(produced < totalChunks, 'upstream must wait for the downstream reader');
  let bytes = 0;
  let valid = true;
  res.on('data', buffer => { bytes += buffer.length; valid &&= buffer.every(value => value === 97); });
  res.resume();
  await once(res, 'end');
  assert.equal(bytes, totalChunks * chunk.length);
  assert.equal(valid, true);
});

test('credential failure markers never reach process stdout, stderr, logs or client errors', async t => {
  const r = await rig(t, { read({ secrets }) { throw new Error(Object.values(secrets).join(' ')); } });
  const captured = [];
  const capture = (chunk, encoding, callback) => {
    captured.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    else callback?.();
    return true;
  };
  const out = t.mock.method(process.stdout, 'write', capture);
  const err = t.mock.method(process.stderr, 'write', capture);
  let result;
  try { result = await r.request(); } finally { out.mock.restore(); err.mock.restore(); }
  assert.equal(result.status, 503);
  const outputs = [result.body, ...captured, await readFile(r.config.logPath, 'utf8')].join('');
  for (const value of Object.values(r.secrets)) assert.equal(outputs.includes(value), false);
});

test('spoofed HOME cannot allow access to the OS user production directory', async t => {
  const s = await setup(t);
  const actualHome = userInfo().homedir;
  let calls = 0;
  const fsOps = Object.fromEntries(['lstat', 'realpath', 'open', 'stat', 'readlink'].map(name =>
    [name, async () => { calls++; throw new Error('filesystem must not be reached'); }]));
  const previous = process.env.HOME;
  process.env.HOME = s.home;
  try {
    for (const home of [actualHome, s.home]) {
      for (const path of ['.claude', '.claude/settings.json', '.claude.json', '.config/claude-rotator/state', 'safe/../.claude']) {
        await assert.rejects(safeExternalPath(join(home, path), s.env, fsOps));
        await assert.rejects(openExternalFile(join(home, path), { env: s.env, fsOps, flags: 0 }));
        await assert.rejects(loadConfig(join(home, path), { env: s.env, fsOps }));
        assert.equal(calls, 0);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test('realpath recheck rejects an alias into a forbidden destination before open', async t => {
  const s = await setup(t);
  let resolved = 0;
  let opened = 0;
  const fsOps = {
    async realpath() { resolved++; return join(s.home, '.claude', 'settings.json'); },
    async open() { opened++; throw new Error('open must not be reached'); },
  };
  await assert.rejects(openExternalFile(join(s.root, 'alias'), { env: s.env, fsOps, flags: 0 }));
  assert.equal(resolved, 1);
  assert.equal(opened, 0);
});

test('parent replacement after realpath cannot redirect config reads', async t => {
  const s = await setup(t);
  const parent = join(s.root, 'parent');
  const decoy = join(s.root, 'decoy');
  await mkdir(parent);
  await mkdir(decoy);
  const path = join(parent, 'proxy.json');
  await writeFile(path, JSON.stringify({ logPath: s.config.logPath }));
  await writeFile(join(decoy, 'proxy.json'), 'must not be read');
  let replaced = false;
  let contentReads = 0;
  const fsOps = { ...realFs,
    async open(...args) {
      if (!replaced) {
        replaced = true;
        await realFs.rename(parent, join(s.root, 'original'));
        await symlink(decoy, parent);
      }
      const handle = await realFs.open(...args);
      return new Proxy(handle, { get(target, property) {
        if (property === 'readFile') return async () => { contentReads++; throw new Error('must not read'); };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
  await assert.rejects(loadConfig(path, { env: s.env, fsOps }));
  assert.equal(replaced, true);
  assert.equal(contentReads, 0);
});

test('parent replacement after realpath cannot redirect log creation', async t => {
  const s = await setup(t);
  const parent = join(s.root, 'log-parent');
  const decoy = join(s.root, 'decoy-log-parent');
  await mkdir(parent);
  await mkdir(decoy);
  const path = join(parent, 'requests.jsonl');
  let replaced = false;
  const fsOps = { ...realFs, async open(...args) {
    if (!(await realFs.lstat(parent)).isSymbolicLink()) {
      await realFs.rename(parent, join(s.root, 'original-log-parent'));
      await symlink(decoy, parent);
      replaced = true;
    }
    return realFs.open(...args);
  } };
  await assert.rejects(openExternalFile(path, { env: s.env, fsOps,
    flags: constants.O_WRONLY | constants.O_CREAT,
    mode: 0o600 }));
  assert.equal(replaced, true);
  await assert.rejects(stat(join(decoy, 'requests.jsonl')), { code: 'ENOENT' });
});

test('normal processes reject test injection before reading config or opening logs', async t => {
  const s = await setup(t);
  const env = { ...process.env, ...s.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const result = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['experiments/caseG-t3/test/runtime-probe.js', s.configFile], { env },
      (error, stdout, stderr) => error ? reject(new Error('runtime injection was accepted')) : resolve({ stdout, stderr }));
  });
  assert.equal(result.stdout, 'refused\n');
  assert.equal(result.stderr, '');
  await assert.rejects(stat(s.config.logPath), { code: 'ENOENT' });
});

test('fake upstream without explicit fake storage is rejected before log creation', async t => {
  const s = await setup(t);
  await assert.rejects(createProxy({ ...s, mode: 'passthrough', apply: true, port: 0,
    upstream: 'http://127.0.0.1:41999' }));
  await assert.rejects(stat(s.config.logPath), { code: 'ENOENT' });
});

test('approved external config opens with parent protection', async t => {
  const s = await setup(t);
  const fsOps = { ...realFs, async open(...args) {
    try { return await realFs.open(...args); } catch (error) {
      t.diagnostic(`protected open failed: ${error.code}`);
      throw error;
    }
  } };
  const loaded = await loadConfig(s.configFile, { env: s.env, fsOps });
  assert.equal(loaded.swapAccount.acct, s.env.USER);
});
