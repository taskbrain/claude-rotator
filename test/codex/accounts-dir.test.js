// 口座のフォルダの名付けと作成（src/codex/accounts-dir.js）のテスト。
//
// どのテストも setupCodexIsolation の一時フォルダの中だけで作る（実のホームの口座のフォルダに
// 触れない）。資格情報は合成の値だけを使う。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, open, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupCodexIsolation } from './helpers/isolation.js';
import {
  ACCOUNT_CONFIG_FILE_NAME, ACCOUNT_DIR_NAME_PATTERN, ACCOUNTS_DIR_REASON, AccountsDirError,
  accountDirPath, createAccountDir, isAccountDirName, newAccountDirName,
} from '../../src/codex/accounts-dir.js';
import {
  ACCOUNT_CONFIG_TOML, SECOND_LAYER_FEATURES_LINES, SECOND_LAYER_FEATURES_TABLE, SECOND_LAYER_ROOT_LINES,
} from '../../src/codex/account-config.js';
import { CODEX_ACCOUNT_LABEL } from '../../src/codex/config.js';
import { readCodexCredentials } from '../../src/codex/credentials.js';

const FIXED_NAME = '0f1e2d3c-4b5a-4968-8776-655443322110';

function syntheticAuthJson(accountId) {
  const payload = Buffer.from(JSON.stringify({
    email: 'zz-accounts-dir-test@example.invalid',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: `e30.${payload}.sig`, access_token: 'zz-synthetic-access', refresh_token: 'zz-synthetic-refresh', account_id: accountId },
  });
}

async function rootUnder(t) {
  const iso = await setupCodexIsolation(t);
  return { iso, accountsDir: join(iso.home, '.codex-accounts') };
}

function assertReason(reason, folderCreated = false) {
  return error => {
    assert.ok(error instanceof AccountsDirError);
    assert.equal(error.reason, reason);
    assert.equal(error.folderCreated, folderCreated);
    return true;
  };
}

test('a new account folder name is a lowercase version 4 UUID and never looks like a label', () => {
  const names = new Set();
  for (let i = 0; i < 50; i++) {
    const name = newAccountDirName();
    assert.match(name, ACCOUNT_DIR_NAME_PATTERN);
    assert.equal(name.length, 36);
    assert.ok(!CODEX_ACCOUNT_LABEL.test(name), 'a folder name must not have the label form');
    names.add(name);
  }
  assert.equal(names.size, 50);
});

test('the folder name does not come from the label or any account data', () => {
  let calls = 0;
  const name = newAccountDirName({ randomUUID: () => { calls++; return FIXED_NAME; } });
  assert.equal(name, FIXED_NAME);
  assert.equal(calls, 1);
});

test('a generated name that is not a local identifier is refused', () => {
  for (const bad of ['', 'zz-legacy', '../escape', FIXED_NAME.toUpperCase(), `${FIXED_NAME}/x`, '0f1e2d3c-4b5a-1968-8776-655443322110']) {
    assert.throws(() => newAccountDirName({ randomUUID: () => bad }), assertReason(ACCOUNTS_DIR_REASON.badName));
  }
});

test('isAccountDirName accepts only the naming form', () => {
  assert.equal(isAccountDirName(FIXED_NAME), true);
  for (const bad of [undefined, null, 1, '', 'zz-legacy', 'second', FIXED_NAME.toUpperCase(), ` ${FIXED_NAME}`, `${FIXED_NAME}\n`]) {
    assert.equal(isAccountDirName(bad), false, JSON.stringify(bad));
  }
});

test('accountDirPath joins the root and the name and refuses other names', () => {
  assert.equal(accountDirPath('/zz/accounts', FIXED_NAME), `/zz/accounts/${FIXED_NAME}`);
  assert.throws(() => accountDirPath('/zz/accounts', '../x'), assertReason(ACCOUNTS_DIR_REASON.badName));
});

test('createAccountDir makes the root and the folder 0700 and writes only the three guard settings', async t => {
  const { accountsDir } = await rootUnder(t);
  const path = await createAccountDir({ accountsDir, name: FIXED_NAME });
  assert.equal(path, join(accountsDir, FIXED_NAME));
  assert.equal((await stat(accountsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path), [ACCOUNT_CONFIG_FILE_NAME]);
  const configPath = join(path, ACCOUNT_CONFIG_FILE_NAME);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  const text = await readFile(configPath, 'utf8');
  assert.equal(text, ACCOUNT_CONFIG_TOML);

  // 設定は3つだけで、承認とサンドボックスの行を持たない。
  const settingLines = text.split('\n').filter(line => line.trim() !== '' && !line.trim().startsWith('['));
  assert.deepEqual(settingLines, [...SECOND_LAYER_ROOT_LINES, ...SECOND_LAYER_FEATURES_LINES]);
  assert.doesNotMatch(text, /approval_policy|sandbox_mode/);
  // 保存先の行は最初の表より前、機能の2行は [features] の表の中。
  const lines = text.split('\n');
  const firstTable = lines.findIndex(line => line.trim().startsWith('['));
  assert.equal(lines[firstTable], SECOND_LAYER_FEATURES_TABLE);
  assert.ok(lines.indexOf('cli_auth_credentials_store = "file"') < firstTable);
  assert.deepEqual(lines.slice(firstTable + 1, firstTable + 3), [...SECOND_LAYER_FEATURES_LINES]);
});

test('the credentials reader judges the written config.toml as the file store', async t => {
  const { accountsDir } = await rootUnder(t);
  const path = await createAccountDir({ accountsDir, name: FIXED_NAME });
  await writeFile(join(path, 'auth.json'), syntheticAuthJson('zz-synthetic-account-a'), { mode: 0o600 });
  const identity = await readCodexCredentials(join(path, 'auth.json'));
  assert.equal(identity.credentialsMode, 'file');
  assert.equal(identity.identityCheck, 'verified');
});

test('an existing root that is private is used as it is', async t => {
  const { accountsDir } = await rootUnder(t);
  await mkdir(accountsDir, { mode: 0o700 });
  await writeFile(join(accountsDir, 'keep.txt'), 'kept', { mode: 0o600 });
  await createAccountDir({ accountsDir, name: FIXED_NAME });
  assert.equal(await readFile(join(accountsDir, 'keep.txt'), 'utf8'), 'kept');
});

for (const [what, prepare] of [
  ['an empty folder', async path => { await mkdir(path, { mode: 0o700 }); }],
  ['a folder with content', async path => {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, 'existing.txt'), 'existing', { mode: 0o600 });
  }],
  ['a symbolic link to a folder', async (path, root) => {
    const target = join(root, 'elsewhere');
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, 'existing.txt'), 'existing', { mode: 0o600 });
    await symlink(target, path);
  }],
  ['a file', async path => { await writeFile(path, 'a file', { mode: 0o600 }); }],
]) {
  test(`createAccountDir refuses a name that is already ${what} and changes nothing there`, async t => {
    const { iso, accountsDir } = await rootUnder(t);
    await mkdir(accountsDir, { mode: 0o700 });
    const path = join(accountsDir, FIXED_NAME);
    await prepare(path, iso.root);
    const before = await lstat(path);
    const beforeList = before.isDirectory() && !before.isSymbolicLink() ? await readdir(path) : null;
    await assert.rejects(createAccountDir({ accountsDir, name: FIXED_NAME }), assertReason(ACCOUNTS_DIR_REASON.exists));
    const after = await lstat(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    if (beforeList) assert.deepEqual(await readdir(path), beforeList);
    if (before.isSymbolicLink()) assert.deepEqual(await readdir(join(iso.root, 'elsewhere')), ['existing.txt']);
  });
}

test('a root that is too open or a symbolic link is refused before any folder is made', async t => {
  const { iso, accountsDir } = await rootUnder(t);
  await mkdir(accountsDir, { mode: 0o700 });
  await chmod(accountsDir, 0o755);
  await assert.rejects(createAccountDir({ accountsDir, name: FIXED_NAME }), assertReason(ACCOUNTS_DIR_REASON.rootUnusable));
  assert.deepEqual(await readdir(accountsDir), []);

  const real = join(iso.root, 'real-root');
  await mkdir(real, { mode: 0o700 });
  const linked = join(iso.root, 'linked-root');
  await symlink(real, linked);
  await assert.rejects(createAccountDir({ accountsDir: linked, name: FIXED_NAME }), assertReason(ACCOUNTS_DIR_REASON.rootUnusable));
  assert.deepEqual(await readdir(real), []);
});

test('a failure to make the folder reports that no folder was made', async t => {
  const { accountsDir } = await rootUnder(t);
  await mkdir(accountsDir, { mode: 0o700 });
  const fileOps = {
    mkdir: async (path, options) => {
      if (path === join(accountsDir, FIXED_NAME)) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      return mkdir(path, options);
    },
  };
  await assert.rejects(createAccountDir({ accountsDir, name: FIXED_NAME, fileOps }), assertReason(ACCOUNTS_DIR_REASON.createFailed));
  assert.deepEqual(await readdir(accountsDir), []);
});

test('a failure to write config.toml leaves the folder and says so', async t => {
  const { accountsDir } = await rootUnder(t);
  const fileOps = {
    open: async (path, ...rest) => {
      if (path.endsWith(`/${ACCOUNT_CONFIG_FILE_NAME}`)) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      return open(path, ...rest);
    },
  };
  await assert.rejects(
    createAccountDir({ accountsDir, name: FIXED_NAME, fileOps }),
    assertReason(ACCOUNTS_DIR_REASON.configWriteFailed, true),
  );
  assert.deepEqual(await readdir(join(accountsDir, FIXED_NAME)), []);
});

test('error messages name no path', async t => {
  const { accountsDir } = await rootUnder(t);
  await mkdir(join(accountsDir, FIXED_NAME), { recursive: true, mode: 0o700 });
  await assert.rejects(createAccountDir({ accountsDir, name: FIXED_NAME }), error => {
    assert.ok(!error.message.includes(accountsDir));
    assert.ok(!error.message.includes(FIXED_NAME));
    return true;
  });
});
