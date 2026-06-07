import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MemorySecretStore,
  LinuxFileSecretStore,
  createSecretStore,
} from '../src/secret-store.js';

describe('MemorySecretStore', () => {
  it('stores, lists, and removes secrets without exposing internals', async () => {
    const store = new MemorySecretStore();

    await store.set('acct_1', { accessToken: 'access', refreshToken: 'refresh' });

    assert.deepEqual(await store.get('acct_1'), { accessToken: 'access', refreshToken: 'refresh' });
    assert.deepEqual(await store.list(), ['acct_1']);
    await store.delete('acct_1');
    assert.equal(await store.get('acct_1'), null);
  });
});

describe('LinuxFileSecretStore', () => {
  it('stores account secret files with private permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const store = new LinuxFileSecretStore({ accountsDir: join(dir, 'accounts') });

    await store.set('acct_1', { accessToken: 'access', refreshToken: 'refresh' });

    assert.deepEqual(await store.get('acct_1'), { accessToken: 'access', refreshToken: 'refresh' });
    assert.deepEqual(await store.list(), ['acct_1']);
    assert.equal((await stat(join(dir, 'accounts'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, 'accounts', 'acct_1.json'))).mode & 0o777, 0o600);
  });

  it('rejects unsafe account ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-secrets-'));
    const store = new LinuxFileSecretStore({ accountsDir: join(dir, 'accounts') });

    await assert.rejects(
      () => store.set('../escape', { accessToken: 'access' }),
      /Invalid account id/,
    );
  });
});

describe('createSecretStore', () => {
  it('selects Linux file storage on linux', () => {
    const store = createSecretStore({ platform: 'linux', home: '/home/alice', env: {} });

    assert.equal(store.constructor.name, 'LinuxFileSecretStore');
  });
});
