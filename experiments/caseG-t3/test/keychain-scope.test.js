import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeKeychainServiceName } from '../../../src/claude-keychain.js';
import { createScopedKeychainStore, validateAccount, loadConfig } from '../passthrough-proxy.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scoped-storage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const configDir = join(root, 'owner');
  await mkdir(home);
  await mkdir(configDir);
  const selected = join(root, 'selected.keychain-db');
  const other = join(root, 'other.keychain-db');
  const env = { HOME: home, USER: 'test-owner' };
  const account = { configDir, service: claudeKeychainServiceName(configDir), acct: env.USER,
    keychainPath: selected, keychainAllowlist: [selected, other] };
  const markers = Object.fromEntries(['access', 'refresh'].map(key =>
    [key, `sk-ant-oat01-SENTINEL-${key}-${randomBytes(12).toString('hex')}`]));
  const state = { matches: new Set([selected]), lists: 0, values: 0, commands: [], changeList: false,
    changeMetadata: false, throwValue: false };
  const backend = { async run(args) {
    state.commands.push([...args]);
    if (args[0] === 'list-keychains') {
      assert.deepEqual(args, ['list-keychains']);
      state.lists++;
      return { stdout: (state.changeList && state.lists > 1 ? [other] : [selected, other]).map(JSON.stringify).join('\n'), stderr: '' };
    }
    assert.deepEqual(args.slice(0, 5), ['find-generic-password', '-a', account.acct, '-s', account.service]);
    const keychain = args.at(-1);
    assert.ok([selected, other].includes(keychain));
    if (args.includes('-w')) {
      assert.equal(args.length, 7);
      state.values++;
      assert.equal(keychain, selected);
      if (state.throwValue) throw new Error(markers.refresh);
      return { stdout: JSON.stringify({ claudeAiOauth: {
        accessToken: markers.access, refreshToken: markers.refresh, expiresAt: Date.now() + 3600000,
      } }), stderr: '' };
    }
    assert.equal(args.length, 6);
    if (!state.matches.has(keychain)) return { found: false };
    const declared = state.changeMetadata && state.values > 0 ? other : keychain;
    return { stdout: `keychain: ${JSON.stringify(declared)}\n"mdat"<timedate>="20250101000000Z"\n`, stderr: '' };
  } };
  return { root, env, account, selected, other, markers, state,
    store: createScopedKeychainStore(backend, { env }) };
}

test('scoped storage reads only the unique selected file with explicit service and acct on all reads', async t => {
  const f = await fixture(t);
  const projected = await f.store.read(f.account);
  assert.equal(projected.accessToken === f.markers.access, true);
  assert.deepEqual(Object.keys(projected).sort(), ['accessToken', 'expiresAt', 'modifiedAt']);
  assert.equal(f.state.values, 1);
  assert.equal(f.state.lists, 2);
  assert.equal(f.state.commands.filter(args => args[0] === 'find-generic-password' && args.at(-1) === f.selected).length, 3);
  for (const value of Object.values(f.markers)) assert.equal(JSON.stringify(f.state.commands).includes(value), false);
});

for (const matches of ['duplicate', 'outside-only', 'none']) {
  test(`scoped storage refuses ${matches} before reading a value`, async t => {
    const f = await fixture(t);
    f.state.matches = new Set(matches === 'duplicate' ? [f.selected, f.other] : matches === 'outside-only' ? [f.other] : []);
    await assert.rejects(f.store.read(f.account), /unavailable/);
    assert.equal(f.state.values, 0);
  });
}

for (const change of ['changeList', 'changeMetadata']) {
  test(`scoped storage refuses ${change} during the read and never returns the token`, async t => {
    const f = await fixture(t);
    f.state[change] = true;
    await assert.rejects(f.store.read(f.account), error => {
      for (const value of Object.values(f.markers)) assert.equal(String(error.stack).includes(value), false);
      return /unavailable/.test(error.message);
    });
    assert.equal(f.state.values, 1);
  });
}

test('scoped storage pins the selected file across subsequent reads even if another file is allowlisted', async t => {
  const f = await fixture(t);
  await f.store.read(f.account);
  f.state.matches = new Set([f.other]);
  const previousCalls = f.state.commands.length;
  await assert.rejects(f.store.read({ ...f.account, keychainPath: f.other }), /unavailable/);
  assert.equal(f.state.commands.length, previousCalls);
  assert.equal(f.state.values, 1);
});

test('scoped storage sanitizes a value-reader error containing a refresh marker', async t => {
  const f = await fixture(t);
  f.state.throwValue = true;
  await assert.rejects(f.store.read(f.account), error => {
    for (const value of Object.values(f.markers)) assert.equal(String(error.stack).includes(value), false);
    assert.equal(error.cause, undefined);
    return /unavailable/.test(error.message);
  });
});

test('swap account requires an absolute selected keychain in an explicit allowlist', async t => {
  const f = await fixture(t);
  for (const patch of [
    { keychainPath: undefined, keychainAllowlist: undefined },
    { keychainPath: 'selected.keychain-db' },
    { keychainAllowlist: undefined }, { keychainAllowlist: [] },
    { keychainAllowlist: [f.other] }, { keychainAllowlist: ['relative.keychain-db'] },
    { keychainPath: join(f.env.HOME, '.claude', 'keychain-db') },
  ]) await assert.rejects(validateAccount({ ...f.account, ...patch }, f.env), /unavailable/);
  const valid = await validateAccount(f.account, f.env);
  assert.equal(valid.keychainPath, f.selected);
});

test('the log cannot be placed at a configured keychain file', async t => {
  const f = await fixture(t);
  const configFile = join(f.root, 'proxy.json');
  await writeFile(configFile, JSON.stringify({ logPath: f.selected, swapAccount: f.account }));
  await assert.rejects(loadConfig(configFile, { env: f.env }), /unavailable/);
});
