// 自分だけが読み書きできる場所の検査（src/codex/fsguard.js）のテスト。
//
// 権限は一時フォルダを実際に chmod して確かめる。所有者の違いは、テストから chown できない
// ので、期待する uid を差し替えて確かめる。ファイルの種類のうち、テストで作れないもの
// （ソケット・名前付きパイプ）は lstat の差し替えで確かめる。一時フォルダは isolation の補助の中。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PRIVATE_FILE_MAX_BYTES,
  FSGUARD_REASON,
  FsGuardError,
  assertPrivateDirectory,
  assertPrivateDirectorySync,
  assertPrivateFile,
  readPrivateFile,
} from '../../src/codex/fsguard.js';
import { setupCodexIsolation } from './helpers/isolation.js';

// パスの中に目印を入れ、例外のメッセージにパスが出ないことを確かめる。
const PATH_MARKER = 'ZZ-PATH-MARKER';

async function setup(t) {
  const isolation = await setupCodexIsolation(t);
  const base = join(isolation.root, PATH_MARKER);
  await mkdir(base, { mode: 0o700 });
  const makeDir = async (name, mode = 0o700) => {
    const path = join(base, name);
    await mkdir(path);
    await chmod(path, mode);
    return path;
  };
  const makeFile = async (name, mode = 0o600, body = 'zz-body') => {
    const path = join(base, name);
    await writeFile(path, body);
    await chmod(path, mode);
    return path;
  };
  return { base, makeDir, makeFile };
}

const refusedWith = reason => error => {
  assert.ok(error instanceof FsGuardError, `expected FsGuardError, got ${error?.name}`);
  assert.equal(error.reason, reason);
  assert.ok(!error.message.includes(PATH_MARKER), `the message must not contain the path: ${error.message}`);
  return true;
};

const fakeStats = ({ kind = 'file', uid = process.getuid(), mode = 0o600, size = 1 } = {}) => ({
  isSymbolicLink: () => kind === 'symlink',
  isDirectory: () => kind === 'directory',
  isFile: () => kind === 'file',
  uid,
  mode,
  size,
});

test('fsguard: a 0700 directory owned by the current user passes', async t => {
  const { makeDir } = await setup(t);
  await assertPrivateDirectory(await makeDir('private'), { what: 'accountsDir' });
});

test('fsguard: a directory with any group or other permission bit is refused', async t => {
  const { makeDir } = await setup(t);
  for (const mode of [0o750, 0o755, 0o705, 0o770, 0o777, 0o701, 0o710, 0o720]) {
    const path = await makeDir(`open-${mode.toString(8)}`, mode);
    await assert.rejects(assertPrivateDirectory(path, { what: 'accountsDir' }), refusedWith(FSGUARD_REASON.modeTooOpen));
  }
});

test('fsguard: a symbolic link to a private directory is refused without following it', async t => {
  const { base, makeDir } = await setup(t);
  const target = await makeDir('target');
  const link = join(base, 'link');
  await symlink(target, link);
  await assert.rejects(assertPrivateDirectory(link, { what: 'accountsDir' }), refusedWith(FSGUARD_REASON.symlink));
});

test('fsguard: a file in place of a directory, and a missing directory, are refused', async t => {
  const { base, makeFile } = await setup(t);
  await assert.rejects(assertPrivateDirectory(await makeFile('plain'), { what: 'accountsDir' }), refusedWith(FSGUARD_REASON.notDirectory));
  await assert.rejects(assertPrivateDirectory(join(base, 'absent'), { what: 'accountsDir' }), refusedWith(FSGUARD_REASON.missing));
});

test('fsguard: a directory owned by another user is refused', async t => {
  const { makeDir } = await setup(t);
  const path = await makeDir('private');
  await assert.rejects(assertPrivateDirectory(path, { uid: process.getuid() + 1 }), refusedWith(FSGUARD_REASON.wrongOwner));
});

test('fsguard: a 0600 or 0400 file owned by the current user passes', async t => {
  const { makeFile } = await setup(t);
  await assertPrivateFile(await makeFile('token-0600', 0o600), { what: 'control token' });
  await assertPrivateFile(await makeFile('token-0400', 0o400), { what: 'control token' });
});

test('fsguard: a file with any group or other permission bit is refused', async t => {
  const { makeFile } = await setup(t);
  for (const mode of [0o640, 0o644, 0o604, 0o660, 0o666, 0o610, 0o620, 0o602]) {
    const path = await makeFile(`open-${mode.toString(8)}`, mode);
    await assert.rejects(assertPrivateFile(path, { what: 'control token' }), refusedWith(FSGUARD_REASON.modeTooOpen));
  }
});

test('fsguard: a symbolic link to a private file, a directory and a missing file are refused', async t => {
  const { base, makeDir, makeFile } = await setup(t);
  const link = join(base, 'token-link');
  await symlink(await makeFile('token'), link);
  await assert.rejects(assertPrivateFile(link), refusedWith(FSGUARD_REASON.symlink));
  await assert.rejects(assertPrivateFile(await makeDir('a-directory')), refusedWith(FSGUARD_REASON.notRegularFile));
  await assert.rejects(assertPrivateFile(join(base, 'absent')), refusedWith(FSGUARD_REASON.missing));
});

test('fsguard: an executable regular file is refused (0700 and any owner execute bit)', async t => {
  const { makeFile } = await setup(t);
  for (const mode of [0o700, 0o500, 0o100, 0o300]) {
    const path = await makeFile(`exec-${mode.toString(8)}`, mode);
    await assert.rejects(assertPrivateFile(path), refusedWith(FSGUARD_REASON.modeTooOpen), mode.toString(8));
    // 所有者が読めないもの（0100・0300）は、開く段階で unreadable になるので読込の確かめからは外す。
    if (mode & 0o400) await assert.rejects(readPrivateFile(path), refusedWith(FSGUARD_REASON.modeTooOpen), mode.toString(8));
  }
});

// ファイルの種類のビット（S_IFREG・S_IFDIR）と権限を合わせた mode。特殊なビットは、利用者の
// 権限と OS によって chmod で立てられない（macOS はファイルに sticky を立てられない）ので、
// stat の差し替えで確かめる。
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const SPECIAL_BITS = Object.freeze([['setuid', 0o4000], ['setgid', 0o2000], ['sticky', 0o1000]]);

test('fsguard: a file with the setuid, setgid or sticky bit is refused', async t => {
  const { base } = await setup(t);
  const path = join(base, 'special-file');
  for (const [name, bit] of SPECIAL_BITS) {
    const stats = fakeStats({ kind: 'file', mode: S_IFREG | bit | 0o600 });
    await assert.rejects(assertPrivateFile(path, { lstatImpl: async () => stats }), refusedWith(FSGUARD_REASON.modeTooOpen), name);
    const openImpl = async () => ({ stat: async () => stats, read: async () => ({ bytesRead: 0 }), close: async () => {} });
    await assert.rejects(readPrivateFile(path, { openImpl }), refusedWith(FSGUARD_REASON.modeTooOpen), name);
  }
  // 陽性対照: 同じ差し替えで 0600 と 0400 は通る。
  for (const mode of [0o600, 0o400]) {
    await assertPrivateFile(path, { lstatImpl: async () => fakeStats({ kind: 'file', mode: S_IFREG | mode }) });
  }
});

test('fsguard: a directory keeps passing with setgid, sticky or setuid while group and others have no bits', async t => {
  const { base } = await setup(t);
  const path = join(base, 'special-dir');
  for (const [name, bit] of SPECIAL_BITS) {
    const stats = fakeStats({ kind: 'directory', mode: S_IFDIR | bit | 0o700 });
    await assertPrivateDirectory(path, { lstatImpl: async () => stats });
    assertPrivateDirectorySync(path, { lstatSyncImpl: () => stats });
    const open = fakeStats({ kind: 'directory', mode: S_IFDIR | bit | 0o750 });
    await assert.rejects(assertPrivateDirectory(path, { lstatImpl: async () => open }), refusedWith(FSGUARD_REASON.modeTooOpen), name);
  }
});

test('fsguard: the synchronous directory check refuses the same things as the asynchronous one', async t => {
  const { base, makeDir, makeFile } = await setup(t);
  assertPrivateDirectorySync(await makeDir('private'), { what: 'the log folder' });
  const open = await makeDir('open', 0o755);
  assert.throws(() => assertPrivateDirectorySync(open), refusedWith(FSGUARD_REASON.modeTooOpen));
  const link = join(base, 'dir-link');
  await symlink(await makeDir('target'), link);
  assert.throws(() => assertPrivateDirectorySync(link), refusedWith(FSGUARD_REASON.symlink));
  const plain = await makeFile('plain');
  assert.throws(() => assertPrivateDirectorySync(plain), refusedWith(FSGUARD_REASON.notDirectory));
  assert.throws(() => assertPrivateDirectorySync(join(base, 'absent')), refusedWith(FSGUARD_REASON.missing));
  const mine = await makeDir('mine');
  assert.throws(() => assertPrivateDirectorySync(mine, { uid: process.getuid() + 1 }), refusedWith(FSGUARD_REASON.wrongOwner));
});

test('fsguard: a file owned by another user is refused', async t => {
  const { makeFile } = await setup(t);
  await assert.rejects(assertPrivateFile(await makeFile('token'), { uid: process.getuid() + 1 }), refusedWith(FSGUARD_REASON.wrongOwner));
});

test('fsguard: other file types (socket, pipe, device) are refused by kind before owner and mode', async t => {
  const { base } = await setup(t);
  const path = join(base, 'special');
  const lstatImpl = async () => fakeStats({ kind: 'other' });
  await assert.rejects(assertPrivateFile(path, { lstatImpl }), refusedWith(FSGUARD_REASON.notRegularFile));
  await assert.rejects(assertPrivateDirectory(path, { lstatImpl }), refusedWith(FSGUARD_REASON.notDirectory));
  const failing = async () => { throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' }); };
  await assert.rejects(assertPrivateFile(path, { lstatImpl: failing }), refusedWith(FSGUARD_REASON.unreadable));
});

test('fsguard: readPrivateFile returns the content of a private file', async t => {
  const { makeFile } = await setup(t);
  assert.equal(await readPrivateFile(await makeFile('token', 0o600, '{"zz":1}\n')), '{"zz":1}\n');
});

test('fsguard: readPrivateFile checks the opened file itself and refuses the same things', async t => {
  const { base, makeDir, makeFile } = await setup(t);
  await assert.rejects(readPrivateFile(await makeFile('open', 0o644)), refusedWith(FSGUARD_REASON.modeTooOpen));
  const link = join(base, 'token-link');
  await symlink(await makeFile('token'), link);
  await assert.rejects(readPrivateFile(link), refusedWith(FSGUARD_REASON.symlink));
  await assert.rejects(readPrivateFile(await makeDir('a-directory')), refusedWith(FSGUARD_REASON.notRegularFile));
  await assert.rejects(readPrivateFile(join(base, 'absent')), refusedWith(FSGUARD_REASON.missing));
  await assert.rejects(readPrivateFile(await makeFile('token-2'), { uid: process.getuid() + 1 }), refusedWith(FSGUARD_REASON.wrongOwner));
});

test('fsguard: readPrivateFile refuses a file larger than the limit', async t => {
  const { makeFile } = await setup(t);
  const big = await makeFile('big', 0o600, 'z'.repeat(DEFAULT_PRIVATE_FILE_MAX_BYTES + 1));
  await assert.rejects(readPrivateFile(big), refusedWith(FSGUARD_REASON.tooLarge));
  const small = await makeFile('small', 0o600, 'z'.repeat(17));
  await assert.rejects(readPrivateFile(small, { maxBytes: 16 }), refusedWith(FSGUARD_REASON.tooLarge));
  assert.equal(await readPrivateFile(small, { maxBytes: 17 }), 'z'.repeat(17));
});

test('fsguard: readPrivateFile reads at most the limit plus one byte even if the file grows after the check', async t => {
  const { base } = await setup(t);
  let requested = 0;
  let reads = 0;
  const openImpl = async () => ({
    stat: async () => fakeStats({ size: 1 }), // 検査の時点では小さい
    read: async (buffer, offset, length) => { // その後、いくらでも書き足される
      reads++;
      requested += length;
      buffer.fill(0x7a, offset, offset + length);
      return { bytesRead: length, buffer };
    },
    close: async () => {},
  });
  await assert.rejects(readPrivateFile(join(base, 'growing'), { openImpl, maxBytes: 16 }), refusedWith(FSGUARD_REASON.tooLarge));
  assert.equal(requested, 17, 'asks for no more than maxBytes + 1 bytes in total');
  assert.equal(reads, 1);
});

test('fsguard: readPrivateFile never reports the file content or path when something fails midway', async t => {
  const { base } = await setup(t);
  const secret = 'ZZ-CONTENT-MARKER';
  const openImpl = async () => ({
    stat: async () => fakeStats(),
    read: async () => { throw new Error(`read failed near ${secret} in ${base}`); },
    close: async () => {},
  });
  await assert.rejects(readPrivateFile(join(base, 'token'), { openImpl }), error => {
    refusedWith(FSGUARD_REASON.unreadable)(error);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});
