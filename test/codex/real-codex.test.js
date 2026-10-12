// 本物の codex の絶対パスの決め方（src/codex/real-codex.js）のテスト。
//
// 一時フォルダ（テストの隔離 helpers/isolation.js の root）の中に偽のフォルダ構成を作って確かめる。
// 置くファイルは起動しない（中身は起動されない合成の台本）。どのテストでも子プロセスの起動が0回で
// あること（隔離の記録）を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { shimDir } from '../../src/codex/paths.js';
import {
  CODEX_CLI_MISSING, CODEX_PATH_POINTS_TO_SHIM, CODEX_SHIM_MARKER, CODEX_SHIM_MARKER_SCAN_BYTES, findRealCodex,
} from '../../src/codex/real-codex.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const REAL_BODY = '#!/bin/sh\n# zz-fake codex for tests (never executed)\n';
const SHIM_BODY = `#!/bin/sh\n${CODEX_SHIM_MARKER} v1\n# zz-fake shim for tests (never executed)\n`;
const PLAIN_SHIM_BODY = '#!/bin/sh\n# zz-fake shim without the marker line (never executed)\n';
const MISSING = { path: null, reason: CODEX_CLI_MISSING, detail: null };
const POINTS_TO_SHIM = { path: null, reason: CODEX_CLI_MISSING, detail: CODEX_PATH_POINTS_TO_SHIM };

async function layout(t, { shimBody = SHIM_BODY } = {}) {
  const isolation = await setupCodexIsolation(t);
  const root = isolation.root;
  // dir/<name> に実行できるファイルを置く。
  async function place(dir, { body = REAL_BODY, mode = 0o755, name = 'codex' } = {}) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    await writeFile(path, body);
    await chmod(path, mode);
    return path;
  }
  const shim = await place(shimDir(isolation.env), { body: shimBody });
  const dir = name => join(root, name);
  return {
    isolation, root, shim, place, dir,
    find: ({ codexPath = null, path, env = isolation.env } = {}) =>
      findRealCodex({ codexPath, env: path === undefined ? env : { ...env, PATH: path.join(':') } }),
    noProcess() {
      assert.equal(isolation.spawnCalls.length, 0, 'deps.spawn is never called');
      assert.equal(isolation.refusedChildProcesses.length, 0, 'no child_process function is called');
    },
  };
}

// --- codexPath ---

test('real codex: codexPath is used first, ahead of every PATH entry', async t => {
  const l = await layout(t);
  const onPath = await l.place(l.dir('bin-path'));
  const configured = await l.place(l.dir('bin-configured'));
  assert.deepEqual(l.find({ codexPath: configured, path: [l.dir('bin-path')] }),
    { path: configured, reason: null, detail: null });
  assert.deepEqual(l.find({ path: [l.dir('bin-path')] }), { path: onPath, reason: null, detail: null });
  assert.ok(isAbsolute(configured));
  l.noProcess();
});

test('real codex: a broken codexPath gives codex-cli-missing and never falls back to PATH', async t => {
  const l = await layout(t);
  await l.place(l.dir('bin-path'));
  const notExecutable = await l.place(l.dir('bin-noexec'), { mode: 0o644 });
  await mkdir(join(l.dir('bin-dir'), 'codex'), { recursive: true });
  await mkdir(l.dir('bin-dangling'), { recursive: true });
  await symlink(join(l.root, 'absent', 'codex'), join(l.dir('bin-dangling'), 'codex'));
  const cases = [
    ['a file that does not exist', join(l.root, 'absent', 'codex')],
    ['a directory', join(l.dir('bin-dir'), 'codex')],
    ['a file that is not executable', notExecutable],
    ['a link to nothing', join(l.dir('bin-dangling'), 'codex')],
    ['a relative path', join('relative', 'codex')],
  ];
  for (const [name, codexPath] of cases) {
    assert.deepEqual(l.find({ codexPath, path: [l.dir('bin-path')] }), MISSING, name);
  }
  l.noProcess();
});

test('real codex: a codexPath that is another name for the shim is refused without falling back to PATH', async t => {
  const l = await layout(t);
  await l.place(l.dir('bin-path'));
  const path = [l.dir('bin-path')];
  await mkdir(l.dir('alias'), { recursive: true });
  await symlink(l.shim, join(l.dir('alias'), 'codex-symlink'));
  await link(l.shim, join(l.dir('alias'), 'codex-hardlink'));
  await mkdir(l.dir('copy'), { recursive: true });
  await copyFile(l.shim, join(l.dir('copy'), 'codex'));
  const cases = [
    ['a symbolic link to the shim', join(l.dir('alias'), 'codex-symlink')],
    ['a hard link to the shim', join(l.dir('alias'), 'codex-hardlink')],
    ['a copy of the shim outside its folder', join(l.dir('copy'), 'codex')],
    ['the shim itself', l.shim],
  ];
  for (const [name, codexPath] of cases) {
    assert.deepEqual(l.find({ codexPath, path }), POINTS_TO_SHIM, name);
  }
  l.noProcess();
});

test('real codex: the shim is recognised by its folder (as written or as real path) and its file identity even without the marker', async t => {
  // 目印の行を持たない shim でも、置き場所（シンボリックリンクは実パスで）と実体で見分ける（規則ごとに確かめる）。
  const l = await layout(t, { shimBody: PLAIN_SHIM_BODY });
  await l.place(l.dir('bin-path'));
  const path = [l.dir('bin-path')];
  await mkdir(l.dir('alias'), { recursive: true });
  await symlink(l.shim, join(l.dir('alias'), 'codex-symlink'));
  await link(l.shim, join(l.dir('alias'), 'codex-hardlink'));
  const inShimFolder = await l.place(shimDir(l.isolation.env), { name: 'codex-other', body: REAL_BODY });
  assert.deepEqual(l.find({ codexPath: join(l.dir('alias'), 'codex-symlink'), path }), POINTS_TO_SHIM, 'real path inside the shim folder');
  assert.deepEqual(l.find({ codexPath: join(l.dir('alias'), 'codex-hardlink'), path }), POINTS_TO_SHIM, 'file identity');
  assert.deepEqual(l.find({ codexPath: inShimFolder, path }), POINTS_TO_SHIM, 'the shim folder');
  // shim の置き場所の中の別のファイルへのリンク（実体も目印も違う。実パスの置き場所だけで見分ける）。
  await symlink(inShimFolder, join(l.dir('alias'), 'codex-to-folder'));
  assert.deepEqual(l.find({ codexPath: join(l.dir('alias'), 'codex-to-folder'), path }), POINTS_TO_SHIM,
    'a link whose real path is in the shim folder');
  l.noProcess();
});

// --- PATH ---

test('real codex: the PATH search skips the shim folder, links to the shim and marked copies', async t => {
  const l = await layout(t);
  await mkdir(l.dir('link-to-shim'), { recursive: true });
  await symlink(l.shim, join(l.dir('link-to-shim'), 'codex'));
  await mkdir(l.dir('link-to-shim-folder-parent'), { recursive: true });
  await symlink(shimDir(l.isolation.env), join(l.dir('link-to-shim-folder-parent'), 'bin'));
  await mkdir(l.dir('marked-copy'), { recursive: true });
  await copyFile(l.shim, join(l.dir('marked-copy'), 'codex'));
  const real = await l.place(l.dir('bin-real'));
  const path = [shimDir(l.isolation.env), l.dir('link-to-shim'), join(l.dir('link-to-shim-folder-parent'), 'bin'),
    l.dir('marked-copy'), l.dir('bin-real')];
  assert.deepEqual(l.find({ path }), { path: real, reason: null, detail: null });
  // どれか1つの除外だけでは足りないことを、先頭を1つずつ外して確かめる（どの位置から始めても本物に届く）。
  for (let start = 0; start < path.length; start++) {
    assert.deepEqual(l.find({ path: path.slice(start) }).path, real, `PATH from entry ${start}`);
  }
  l.noProcess();
});

test('real codex: the PATH search skips a shim without the marker by its folder, real path and identity', async t => {
  const l = await layout(t, { shimBody: PLAIN_SHIM_BODY });
  await mkdir(l.dir('symlink'), { recursive: true });
  await symlink(l.shim, join(l.dir('symlink'), 'codex'));
  await mkdir(l.dir('hardlink'), { recursive: true });
  await link(l.shim, join(l.dir('hardlink'), 'codex'));
  const real = await l.place(l.dir('bin-real'));
  for (const skipped of [shimDir(l.isolation.env), l.dir('symlink'), l.dir('hardlink')]) {
    assert.deepEqual(l.find({ path: [skipped, l.dir('bin-real')] }).path, real, skipped.slice(l.root.length));
    assert.deepEqual(l.find({ path: [skipped] }), MISSING, skipped.slice(l.root.length));
  }
  l.noProcess();
});

test('real codex: the PATH search skips empty, relative, non-executable and non-file entries and takes the first real one', async t => {
  const l = await layout(t);
  await l.place(l.dir('bin-noexec'), { mode: 0o644 });
  await mkdir(join(l.dir('bin-dir'), 'codex'), { recursive: true });
  const first = await l.place(l.dir('bin-first'));
  await l.place(l.dir('bin-second'));
  const path = ['', join('relative', 'bin'), l.dir('bin-noexec'), l.dir('bin-dir'), l.dir('absent'),
    l.dir('bin-first'), l.dir('bin-second')];
  const found = l.find({ path });
  assert.deepEqual(found, { path: first, reason: null, detail: null });
  assert.ok(isAbsolute(found.path));
  l.noProcess();
});

test('real codex: a relative PATH entry or codexPath is never used, even when it names a real codex', async t => {
  // 今いるフォルダから一時フォルダの本物を指す相対パス（解決すれば使えるファイルになる）。
  const l = await layout(t);
  const real = await l.place(l.dir('bin-relative'));
  const relativeDir = relative(process.cwd(), l.dir('bin-relative'));
  assert.ok(!isAbsolute(relativeDir) && relativeDir !== '');
  const after = await l.place(l.dir('bin-after'));
  assert.deepEqual(l.find({ path: [relativeDir, l.dir('bin-after')] }), { path: after, reason: null, detail: null });
  assert.deepEqual(l.find({ path: [relativeDir] }), MISSING);
  assert.deepEqual(l.find({ codexPath: join(relativeDir, 'codex'), path: [l.dir('bin-after')] }), MISSING);
  assert.deepEqual(l.find({ codexPath: real }).path, real, 'the same file by its absolute path is usable');
  l.noProcess();
});

test('real codex: nothing usable on PATH gives codex-cli-missing without a detail', async t => {
  const l = await layout(t);
  assert.deepEqual(l.find({ path: [shimDir(l.isolation.env)] }), MISSING, 'only the shim');
  assert.deepEqual(l.find(), MISSING, 'the isolation PATH is an empty folder');
  assert.deepEqual(findRealCodex({ env: { ...l.isolation.env, PATH: undefined } }), MISSING, 'no PATH at all');
  l.noProcess();
});

test('real codex: the marker counts only inside the first 256 bytes', async t => {
  const l = await layout(t);
  const markerAt = offset => `#!/bin/sh\n#${' '.repeat(offset - 11)}${CODEX_SHIM_MARKER}\n`;
  const lastInside = CODEX_SHIM_MARKER_SCAN_BYTES - CODEX_SHIM_MARKER.length;
  assert.equal(markerAt(lastInside).indexOf(CODEX_SHIM_MARKER), lastInside);
  const inside = await l.place(l.dir('marker-inside'), { body: markerAt(lastInside) });
  const across = await l.place(l.dir('marker-across'), { body: markerAt(lastInside + 1) });
  assert.deepEqual(l.find({ codexPath: inside }), POINTS_TO_SHIM, 'the marker ends at byte 256');
  assert.deepEqual(l.find({ codexPath: across }), { path: across, reason: null, detail: null },
    'the marker reaches past byte 256');
  assert.deepEqual(l.find({ path: [l.dir('marker-inside'), l.dir('marker-across')] }).path, across);
  l.noProcess();
});

test('real codex: without a nameable shim folder nothing is used', async t => {
  const l = await layout(t);
  const real = await l.place(l.dir('bin-real'));
  // HOME も絶対パスの XDG_DATA_HOME も無ければ、shim の置き場所が決まらず、除外できない。
  assert.deepEqual(findRealCodex({ env: { PATH: l.dir('bin-real') } }), MISSING);
  assert.deepEqual(findRealCodex({ codexPath: real, env: { PATH: l.dir('bin-real') } }), MISSING);
  assert.deepEqual(findRealCodex({ codexPath: real }), MISSING, 'no env at all');
  l.noProcess();
});
