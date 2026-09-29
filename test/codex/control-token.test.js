// 制御トークン（src/codex/control-token.js）のテスト。
//
// 主な確かめ:
//   - 生成: 既定は64文字の16進。差し替えた生成関数の戻り値は、文字列・ヘッダに載せてよい文字だけ・
//     32〜256文字でなければ拒否する。
//   - 書込: 親フォルダが自分だけのフォルダ（0700 まで・シンボリックリンクでない）であることを確かめて
//     から、中身が `{ "token": "<値>" }` だけのファイルを 0600 で書く。
//   - 削除: 覚えた場所だけを、自分の書いた値を持つときだけ消す（env を後から書き換えても別の場所を
//     消さない。別の値に置き換わったファイルは消さない。書込が名前の置き換えの後で失敗しても消せる）。
//     失敗しても投げない。
//   - CLI 側の読取: シンボリックリンク・0644・所有者が違う・大きすぎる・JSON でない・token の形が違う
//     ファイルを拒否し、例外にファイルの中身とパスを出さない。
//   - 照合: 同じ値だけが一致する。文字列でない値は一致しない。
//
// 絶対条件: 実のホーム・実の設定へ届かない。env は隔離の補助（helpers/isolation.js）の一時フォルダのもの。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  CONTROL_TOKEN_FILE_MAX_BYTES, CONTROL_TOKEN_HEADER, CONTROL_TOKEN_MAX_LENGTH, CONTROL_TOKEN_MIN_LENGTH,
  CONTROL_TOKEN_REASON, ControlTokenError, controlTokenMatches, createControlTokenFile, generateControlToken,
  isWellFormedControlToken, readControlToken,
} from '../../src/codex/control-token.js';
import { CODEX_ROTATOR_APP_NAME, codexRotatorConfigDir, controlTokenPath } from '../../src/codex/paths.js';
import { setupCodexIsolation } from './helpers/isolation.js';

// 合成の目印（トークンの形を満たす）。ファイルの中身・例外に出ないことを確かめる。
const MARKER = 'ZZTOKENMARKER'.repeat(3);
const OTHER_MARKER = 'ZZOTHERMARKER'.repeat(3);

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// 隔離の一時フォルダの中に、トークンの親フォルダ（0700）を作る。
async function fixture(t) {
  const isolation = await setupCodexIsolation(t);
  const folder = codexRotatorConfigDir(isolation.env);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  return { isolation, env: isolation.env, folder, path: controlTokenPath(isolation.env) };
}

// 例外の中身（メッセージ・文字列化・inspect）に、どの目印も入っていないこと。
function assertErrorHidesAll(error, values, what) {
  const texts = [error.message, String(error), inspect(error, { depth: 5, showHidden: true })];
  for (const value of values) {
    for (const text of texts) assert.equal(text.includes(value), false, `${what}: the error does not carry the value`);
  }
}

// --- 生成 ----------------------------------------------------------------------------------------

test('control token: the default generator returns 64 hex characters, different each time', () => {
  const a = generateControlToken();
  const b = generateControlToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.equal(a === b, false, 'two tokens differ');
  assert.equal(isWellFormedControlToken(a), true);
  assert.equal(CONTROL_TOKEN_HEADER, 'x-codex-rotator-token');
});

test('control token: the shape check accepts 32 to 256 header-safe characters only', () => {
  assert.equal(isWellFormedControlToken('a'.repeat(CONTROL_TOKEN_MIN_LENGTH)), true);
  assert.equal(isWellFormedControlToken('a'.repeat(CONTROL_TOKEN_MAX_LENGTH)), true);
  assert.equal(isWellFormedControlToken(`${'A'.repeat(30)}_-`), true);
  for (const bad of [undefined, null, 42, ['a'.repeat(40)], Buffer.from('a'.repeat(40)), '',
    'a'.repeat(CONTROL_TOKEN_MIN_LENGTH - 1), 'a'.repeat(CONTROL_TOKEN_MAX_LENGTH + 1),
    `${'a'.repeat(40)},`, `${'a'.repeat(40)} `, `${'a'.repeat(40)}=`, `${'a'.repeat(40)}\n`, `${'a'.repeat(40)}é`]) {
    assert.equal(isWellFormedControlToken(bad), false);
  }
});

test('control token: a generator that returns a value of the wrong shape, or throws, is refused without the value', async t => {
  const { env } = await fixture(t);
  const cases = [
    () => 42,
    () => 'Z'.repeat(CONTROL_TOKEN_MIN_LENGTH - 1),
    () => 'Z'.repeat(CONTROL_TOKEN_MAX_LENGTH + 1),
    () => `${MARKER},${MARKER}`,
    () => `${MARKER} `,
    () => { throw new Error(MARKER); },
  ];
  for (const generateToken of cases) {
    const file = createControlTokenFile({ env, generateToken });
    assert.throws(() => file.generate(), error => {
      assert.ok(error instanceof ControlTokenError);
      assert.equal(error.reason, CONTROL_TOKEN_REASON.invalidToken);
      assertErrorHidesAll(error, [MARKER], 'generate');
      return true;
    });
  }
  const file = createControlTokenFile({ env, generateToken: () => MARKER });
  assert.equal(file.generate(), MARKER, 'a well-formed replacement is returned as it is');
});

test('control token: env is required and is never replaced by the process environment', async t => {
  const { isolation } = await fixture(t);
  assert.throws(() => createControlTokenFile({}), TypeError);
  assert.throws(() => createControlTokenFile(), TypeError);
  await assert.rejects(() => readControlToken({}), TypeError);
  // HOME が絶対パスでない env は、置き場所を求められない（実のホームを推測しない）。
  const relative = { HOME: 'zz-relative-home' };
  assert.throws(() => createControlTokenFile({ env: relative }),
    error => error instanceof ControlTokenError && error.reason === CONTROL_TOKEN_REASON.path);
  await assert.rejects(() => readControlToken({ env: relative }),
    error => error instanceof ControlTokenError && error.reason === CONTROL_TOKEN_REASON.path);
  assert.ok(controlTokenPath(isolation.env).startsWith(`${isolation.root}/`));
});

// --- 書込 ---------------------------------------------------------------------------------------

test('control token: the file is 0600 inside a 0700 folder and holds only the token', async t => {
  const { isolation, env, folder, path } = await fixture(t);
  const file = createControlTokenFile({ env, generateToken: () => MARKER });
  await file.assertFolder();
  const token = file.generate();
  await file.write(token);
  assert.ok(path.startsWith(`${isolation.root}/`), 'the file is inside the isolation folder');
  const stats = await lstat(path);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal((await lstat(folder)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: MARKER });
  assert.equal(await readControlToken({ env }), MARKER, 'the CLI side reads the same value');
  await file.remove();
  assert.equal(await exists(path), false);
});

test('control token: the folder check refuses a symbolic link, a wide folder and a missing folder', async t => {
  const { isolation, env, folder } = await fixture(t);
  const refused = async () => {
    const file = createControlTokenFile({ env, generateToken: () => MARKER });
    await assert.rejects(() => file.assertFolder(), error => {
      assert.ok(error instanceof ControlTokenError);
      assert.equal(error.reason, CONTROL_TOKEN_REASON.folder);
      assertErrorHidesAll(error, [folder, isolation.root], 'assertFolder');
      return true;
    });
  };
  await chmod(folder, 0o755);
  await refused();
  // 書込も、書く直前に同じ検査をする（呼び出し側が検査を省いても書かない）。
  const direct = createControlTokenFile({ env, generateToken: () => MARKER });
  await assert.rejects(() => direct.write(MARKER),
    error => error instanceof ControlTokenError && error.reason === CONTROL_TOKEN_REASON.folder);
  assert.equal(await exists(controlTokenPath(env)), false, 'nothing was written into the wide folder');
  await rm(folder, { recursive: true, force: true });
  await refused();
  const target = join(isolation.root, 'zz-link-target');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, folder);
  await refused();
});

test('control token: removing deletes the remembered file only, even after env is changed', async t => {
  const { isolation, path } = await fixture(t);
  const env = { ...isolation.env };
  const file = createControlTokenFile({ env, generateToken: () => MARKER });
  // 書き換えた env が指す別の場所に、同じ名前のファイルを置いておく（消されてはいけない）。
  const otherConfigHome = join(isolation.root, 'zz-other-config');
  const otherFolder = join(otherConfigHome, CODEX_ROTATOR_APP_NAME);
  await mkdir(otherFolder, { recursive: true, mode: 0o700 });
  const otherPath = join(otherFolder, 'control-token.json');
  await writeFile(otherPath, JSON.stringify({ token: OTHER_MARKER }), { mode: 0o600 });
  env.XDG_CONFIG_HOME = otherConfigHome;
  assert.equal(controlTokenPath(env), otherPath, 'the changed env points at the other file');

  await file.assertFolder();
  await file.write(file.generate());
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: MARKER }, 'written to the remembered place');
  await file.remove();
  assert.equal(await exists(path), false);
  assert.deepEqual(JSON.parse(await readFile(otherPath, 'utf8')), { token: OTHER_MARKER }, 'the other file is untouched');
  // 2回目と、既に消えている場合も投げない。
  await file.remove();
  await file.write(MARKER);
  await rm(path);
  await file.remove();
});

test('control token: removing before writing does nothing, and a write of a malformed value is refused', async t => {
  const { env, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ token: OTHER_MARKER }), { mode: 0o600 });
  const file = createControlTokenFile({ env });
  await file.remove();
  assert.equal(await exists(path), true, 'a file this instance did not write is left alone');
  await assert.rejects(() => file.write(`${MARKER},`),
    error => error instanceof ControlTokenError && error.reason === CONTROL_TOKEN_REASON.invalidToken);
});

test('control token: a failed write reports a fixed message without the value or the path', async t => {
  const { isolation, env, folder } = await fixture(t);
  const file = createControlTokenFile({ env, generateToken: () => MARKER });
  // 置き場所に同じ名前のフォルダがあると、名前の置き換えが失敗する。
  await mkdir(join(folder, 'control-token.json'), { mode: 0o700 });
  await assert.rejects(() => file.write(MARKER), error => {
    assert.ok(error instanceof ControlTokenError);
    assert.equal(error.reason, CONTROL_TOKEN_REASON.write);
    assertErrorHidesAll(error, [MARKER, folder, isolation.root], 'write');
    return true;
  });
});

test('control token: a file replaced with another value is not removed, and nothing about it leaks', async t => {
  const { isolation, env, path } = await fixture(t);
  const file = createControlTokenFile({ env, generateToken: () => MARKER });
  await file.assertFolder();
  await file.write(file.generate());
  // 書いた後に、別の値（形は正しい）に置き換わった。
  await writeFile(path, JSON.stringify({ token: OTHER_MARKER }), { mode: 0o600 });
  await file.remove();
  assert.equal(await exists(path), true, 'a file holding another value is left alone');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { token: OTHER_MARKER });
  // 読めない形・広い権限・シンボリックリンクに置き換わった場合も消さず、投げない。
  const second = createControlTokenFile({ env, generateToken: () => MARKER });
  for (const replace of [
    async () => writeFile(path, `${OTHER_MARKER} is not json`, { mode: 0o600 }),
    async () => { await writeFile(path, JSON.stringify({ token: MARKER }), { mode: 0o600 }); await chmod(path, 0o644); },
    async () => {
      const target = join(isolation.root, 'zz-replaced-target.json');
      await writeFile(target, JSON.stringify({ token: MARKER }), { mode: 0o600 });
      await rm(path, { force: true });
      await symlink(target, path);
    },
  ]) {
    await second.write(MARKER);
    await rm(path, { force: true });
    await replace();
    await second.remove();
    assert.equal(await exists(path), true, 'an unreadable or unsafe replacement is left alone');
  }
});

test('control token: a write that fails after the rename is still removed by its own value', async t => {
  const { env, path } = await fixture(t);
  // 名前の置き換えまでは済み、その後の同期が失敗する書込。
  const writeJson = async (target, value, mode) => {
    await writeFile(target, JSON.stringify(value), { mode });
    await chmod(target, mode);
    throw new Error(`zz-sync-failed ${MARKER} ${target}`);
  };
  const file = createControlTokenFile({ env, generateToken: () => MARKER, writeJson });
  await file.assertFolder();
  await assert.rejects(() => file.write(file.generate()), error => {
    assert.ok(error instanceof ControlTokenError);
    assert.equal(error.reason, CONTROL_TOKEN_REASON.write);
    assertErrorHidesAll(error, [MARKER, path], 'a failed write');
    return true;
  });
  assert.equal(await exists(path), true, 'the value reached the file');
  await file.remove();
  assert.equal(await exists(path), false, 'the own value is removed');
  assert.throws(() => createControlTokenFile({ env, writeJson: 'zz-not-a-function' }), TypeError);
});

// --- CLI 側の読取 ---------------------------------------------------------------------------------

test('control token: the CLI read refuses unsafe or malformed files and never shows their content or path', async t => {
  const { isolation, env, folder, path } = await fixture(t);
  const place = async (body, mode = 0o600) => {
    await rm(path, { force: true, recursive: true });
    await writeFile(path, body, { mode });
    await chmod(path, mode);
  };
  const refused = async (reason, what, options = {}) => {
    await assert.rejects(() => readControlToken({ env, ...options }), error => {
      assert.ok(error instanceof ControlTokenError, what);
      assert.equal(error.reason, reason, what);
      assertErrorHidesAll(error, [MARKER, path, folder, isolation.root], what);
      return true;
    });
  };

  await refused(CONTROL_TOKEN_REASON.missing, 'missing');
  await place(JSON.stringify({ token: MARKER }), 0o644);
  await refused(CONTROL_TOKEN_REASON.modeTooOpen, '0644');
  await place(JSON.stringify({ token: MARKER }));
  await refused(CONTROL_TOKEN_REASON.wrongOwner, 'another owner', { uid: process.getuid() + 1 });
  await place(JSON.stringify({ token: MARKER, pad: 'z'.repeat(CONTROL_TOKEN_FILE_MAX_BYTES) }));
  await refused(CONTROL_TOKEN_REASON.tooLarge, 'too large');
  await place(`${MARKER} is not json`);
  await refused(CONTROL_TOKEN_REASON.malformed, 'not JSON');
  for (const [body, what] of [
    [JSON.stringify({ token: MARKER.slice(0, CONTROL_TOKEN_MIN_LENGTH - 1) }), 'a short token'],
    [JSON.stringify({ token: `${MARKER},` }), 'a token with a separator'],
    [JSON.stringify({ token: MARKER, extra: MARKER }), 'an extra key'],
    [JSON.stringify({ value: MARKER }), 'no token key'],
    [JSON.stringify([MARKER]), 'an array'],
    [JSON.stringify(MARKER), 'a bare string'],
    ['null', 'null'],
  ]) {
    await place(body);
    await refused(CONTROL_TOKEN_REASON.malformed, what);
  }

  const target = join(isolation.root, 'zz-token-target.json');
  await writeFile(target, JSON.stringify({ token: MARKER }), { mode: 0o600 });
  await rm(path, { force: true });
  await symlink(target, path);
  await refused(CONTROL_TOKEN_REASON.symlink, 'a symbolic link');

  await rm(path, { force: true });
  await mkdir(path, { mode: 0o700 });
  await refused(CONTROL_TOKEN_REASON.notRegularFile, 'a folder');

  await place(JSON.stringify({ token: MARKER }));
  assert.equal(await readControlToken({ env }), MARKER, 'a proper file is read');
  assert.equal(await readControlToken({ env, uid: process.getuid() }), MARKER, 'the own uid passes');
});

// --- 照合 ---------------------------------------------------------------------------------------

test('control token: only the same value matches; other lengths, other values and non-strings do not', () => {
  const token = 'a'.repeat(64);
  assert.equal(controlTokenMatches(token, `${'a'.repeat(64)}`), true);
  assert.equal(controlTokenMatches(token, `${'a'.repeat(63)}b`), false, 'same length, different value');
  assert.equal(controlTokenMatches(token, 'a'.repeat(63)), false, 'shorter');
  assert.equal(controlTokenMatches(token, 'a'.repeat(65)), false, 'longer');
  assert.equal(controlTokenMatches(token, ''), false);
  assert.equal(controlTokenMatches(token, `${token}, ${token}`), false, 'two header values joined');
  for (const presented of [undefined, null, 1, [token], [token, token], Buffer.from(token), { token }]) {
    assert.equal(controlTokenMatches(token, presented), false);
  }
  assert.equal(controlTokenMatches(undefined, token), false, 'no expected token never matches');
  assert.equal(controlTokenMatches(undefined, undefined), false);
});
