// `codex-rotator login`（src/codex/login.js）のテスト。
//
// - 対話ログインの子は、すべて差し替えた spawn で置き換える。偽の子は、渡された CODEX_HOME に
//   合成の資格情報を書いて終わる。本物の codex は起動しない。
// - 本物の codex の探索（real-codex.js）には、一時フォルダの中の偽の実行ファイルを見つけさせる。
//   この偽物は実行されない（起動は差し替えた spawn が受ける）。
// - 設定・口座のフォルダ・HOME は、どれも setupCodexIsolation の一時フォルダの中に作る。
// - 最後のテストだけは隔離の外で、差し替えない spawn を使い、テスト隔離の仕掛けが login の起動の
//   経路で絶対パスの codex を拒否することを確かめる（隔離の中では child_process が丸ごと差し替わり、
//   その仕掛けまで届かないため）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import fsPromises, {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { REAL_SERVICE_PORTS, setupCodexIsolation } from './helpers/isolation.js';
import {
  CODEX_LOGOUT_TIMEOUT_MS, CONFIG_CREATED_LINE, CONFIG_UNCHANGED_LINE, CREDENTIALS_STORE_ARGS, FOLDER_LEFT_LINE,
  LOGIN_CHILD_ARGS, LOGIN_EXIT, LOGIN_FAILURE, LOGIN_USAGE, LOGOUT_CHILD_ARGS, OTHER_CREDENTIALS_HINT_LINE,
  REGISTERED_LINE, RELOAD_HINT_LINE, RELOGIN_MARK, RELOGIN_OK_LINE, RELOGIN_REMOVED_LINE, RELOGIN_REMOVE_FAILED_LINE, RELOGIN_SIGNALS,
  RELOGIN_UNVERIFIED_BEFORE_LINE, RELOGIN_WORD, UNREADABLE_ACCOUNTS_LINE_START, parseLoginArgs, resolveLoginDeps, runLogin,
} from '../../src/codex/login.js';
import { ACCOUNT_DIR_NAME_PATTERN } from '../../src/codex/accounts-dir.js';
import { ACCOUNT_CONFIG_TOML, FIRST_LAYER_ARGS } from '../../src/codex/account-config.js';
import { loadCodexConfigSnapshot } from '../../src/codex/config.js';
import { accountIdHash, readCodexCredentials } from '../../src/codex/credentials.js';
import { CODEX_SELECT_OUTCOME } from '../../src/codex/daemon.js';
import { EXEC_LINE, formatConfigStaleGuidance, runExec } from '../../src/codex/exec.js';
import { controlTokenPath } from '../../src/codex/paths.js';

const SERVICE_COMMAND_LOG_ENV = 'CLAUDE_ROTATOR_SERVICE_COMMAND_LOG';
const DUMMY_EMAIL = 'zz-login-test@example.invalid';
const DUMMY_ACCESS = 'zz-synthetic-access-token';
const DUMMY_REFRESH = 'zz-synthetic-refresh-token';
const ACCOUNT_A = 'zz-synthetic-account-a';
const ACCOUNT_B = 'zz-synthetic-account-b';
const FIXED_NAME = '0f1e2d3c-4b5a-4968-8776-655443322110';
const HARMLESS_SCRIPT = '#!/bin/sh\n: > "$(dirname "$0")/ran"\nexit 1\n';

function syntheticIdToken(accountId) {
  const payload = Buffer.from(JSON.stringify({
    email: DUMMY_EMAIL, 'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `e30.${payload}.sig`;
}

function syntheticAuthJson(accountId) {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: syntheticIdToken(accountId), access_token: DUMMY_ACCESS, refresh_token: DUMMY_REFRESH, account_id: accountId },
  });
}

function captureStream() {
  const chunks = [];
  return { write(chunk) { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

function fakeChild({ code = 0, signal = null, error = false } = {}) {
  const child = new EventEmitter();
  setImmediate(() => {
    if (error) child.emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
    else child.emit('exit', code, signal);
  });
  return child;
}

async function fileState(path) {
  try {
    const bytes = await readFile(path);
    const info = await stat(path, { bigint: true });
    return { sha256: createHash('sha256').update(bytes).digest('hex'), mtimeNs: info.mtimeNs, ino: info.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function listOrNull(path) {
  try {
    return (await readdir(path)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 1つのテストの環境。login の子の振る舞いは behave(args, options) で決める（既定は、口座 A の
// 資格情報を書いて 0 で終わる）。
async function setup(t, { behave } = {}) {
  const iso = await setupCodexIsolation(t);
  const fakeBin = join(iso.root, 'fake-bin');
  await mkdir(fakeBin, { mode: 0o700 });
  const codexPath = join(fakeBin, 'codex');
  await writeFile(codexPath, HARMLESS_SCRIPT, { mode: 0o755 });
  const env = { ...iso.env, PATH: fakeBin };
  const ctx = {
    iso,
    env,
    codexPath,
    accountsDir: join(iso.home, '.codex-accounts'),
    configPath: join(env.XDG_CONFIG_HOME, 'codex-rotator', 'config.json'),
    nextAccountId: ACCOUNT_A,
    behave: behave ?? null,
    childCalls: [],
  };
  ctx.writeCredentials = (options, accountId = ctx.nextAccountId, mode = 0o600) => {
    writeFileSync(join(options.env.CODEX_HOME, 'auth.json'), syntheticAuthJson(accountId), { mode });
  };
  iso.registerSpawn(codexPath, (args, options) => {
    ctx.childCalls.push({ args, options, configTomlAtStart: readFileSync(join(options.env.CODEX_HOME, 'config.toml'), 'utf8') });
    if (ctx.behave) return ctx.behave(args, options);
    ctx.writeCredentials(options);
    return fakeChild();
  });
  // シグナルの受け口は、既定で偽物を渡す（テストの実行器のプロセスに受け口を付けない）。
  ctx.run = async (argv, deps = {}, env = ctx.env) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runLogin(argv, { stdout, stderr, env }, { spawn: iso.spawn, signals: fakeSignals(), ...deps });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  ctx.login = (label, accountId, extra = []) => {
    ctx.nextAccountId = accountId;
    return ctx.run(['--label', label, '--stop', '90', '--resume', '50', ...extra]);
  };
  ctx.readRaw = async () => JSON.parse(await readFile(ctx.configPath, 'utf8'));
  return ctx;
}

const ARGS_A = ['--label', 'alpha', '--stop', '90', '--resume', '50'];

function stderrLines(result) {
  return result.stderr.split('\n').filter(Boolean);
}

function assertFailedUnchanged(result, { folderLeft }) {
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.equal(result.stdout, '');
  const lines = stderrLines(result);
  assert.ok(lines.includes(CONFIG_UNCHANGED_LINE), result.stderr);
  assert.equal(lines.includes(FOLDER_LEFT_LINE), folderLeft, result.stderr);
  assert.ok(!lines.includes(REGISTERED_LINE));
  assert.ok(!lines.includes(RELOAD_HINT_LINE));
}

// 登録済みの口座を1つ持つ設定を作り、その状態（中身と更新時刻）を返す。
async function withOneAccount(ctx) {
  const first = await ctx.login('first', ACCOUNT_A);
  assert.equal(first.code, LOGIN_EXIT.ok, first.stderr);
  ctx.childCalls.length = 0;
  ctx.iso.spawnCalls.length = 0;
  return { config: await fileState(ctx.configPath), folders: await listOrNull(ctx.accountsDir) };
}

// ---------------------------------------------------------------------------------------------
// 成功
// ---------------------------------------------------------------------------------------------

test('the first login creates the folder and the config with both gates false and one account with its usage policy', async t => {
  const ctx = await setup(t);
  const envBefore = { ...ctx.env };
  const result = await ctx.run(ARGS_A);
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(stderrLines(result), [REGISTERED_LINE, CONFIG_CREATED_LINE, RELOAD_HINT_LINE]);

  const raw = await ctx.readRaw();
  assert.deepEqual(Object.keys(raw).sort(), ['accounts', 'acknowledgedMultiAccountRisk', 'enabled']);
  assert.equal(raw.enabled, false);
  assert.equal(raw.acknowledgedMultiAccountRisk, false);
  assert.equal(raw.accounts.length, 1);
  const [account] = raw.accounts;
  assert.equal(account.label, 'alpha');
  assert.deepEqual(account.usagePolicy, { stopUsedPercent: 90, resumeUsedPercent: 50, blockWhenUnknown: false });
  // フォルダは accountsDir の直下に、名付け方の形の名前で作る。
  const folders = await readdir(ctx.accountsDir);
  assert.equal(folders.length, 1);
  assert.match(folders[0], ACCOUNT_DIR_NAME_PATTERN);
  assert.equal(account.codexHome, join(ctx.accountsDir, folders[0]));
  assert.equal((await stat(ctx.accountsDir)).mode & 0o777, 0o700);
  assert.equal((await stat(account.codexHome)).mode & 0o777, 0o700);
  assert.equal((await stat(join(ctx.env.XDG_CONFIG_HOME, 'codex-rotator'))).mode & 0o777, 0o700);
  assert.equal((await stat(ctx.configPath)).mode & 0o777, 0o600);

  const loaded = await loadCodexConfigSnapshot({ env: ctx.env });
  assert.equal(loaded.config.enabled, false);
  assert.equal(loaded.config.acknowledgedMultiAccountRisk, false);
  assert.equal(loaded.config.accounts.length, 1);
  assert.deepEqual(ctx.env, envBefore, 'the passed env is not changed');
});

test('the login child is the real codex by absolute path with the file store, shell off, the terminal and CODEX_HOME set to the new folder', async t => {
  const ctx = await setup(t);
  const result = await ctx.run(ARGS_A);
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.equal(ctx.iso.spawnCalls.length, 1);
  const [call] = ctx.iso.spawnCalls;
  assert.equal(call.command, ctx.codexPath);
  assert.deepEqual(call.args, [...LOGIN_CHILD_ARGS]);
  assert.deepEqual(call.args, ['-c', 'cli_auth_credentials_store="file"', 'login']);
  assert.deepEqual(CREDENTIALS_STORE_ARGS, FIRST_LAYER_ARGS.slice(0, 2));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio, 'inherit');
  const [account] = (await ctx.readRaw()).accounts;
  assert.equal(call.options.env.CODEX_HOME, account.codexHome);
  assert.equal(call.options.env.HOME, ctx.env.HOME);
  assert.equal(call.options.env.PATH, ctx.env.PATH);
  assert.equal(ctx.iso.refusedChildProcesses.length, 0);
  assert.equal(ctx.iso.refusedSpawns.length, 0);
});

test('the account folder config.toml holds only the three guard settings before the login child starts, and is read as the file store', async t => {
  const ctx = await setup(t);
  const result = await ctx.run(ARGS_A);
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.equal(ctx.childCalls[0].configTomlAtStart, ACCOUNT_CONFIG_TOML);
  const [account] = (await ctx.readRaw()).accounts;
  const text = await readFile(join(account.codexHome, 'config.toml'), 'utf8');
  assert.equal(text, ACCOUNT_CONFIG_TOML);
  assert.doesNotMatch(text, /approval_policy|sandbox_mode/);
  const beforeFirstTable = text.split(/^\s*\[/m)[0];
  assert.match(beforeFirstTable, /^cli_auth_credentials_store = "file"$/m);
  assert.match(text, /^\[features\]\napps = false\nplugins = false$/m);
  const identity = await readCodexCredentials(join(account.codexHome, 'auth.json'));
  assert.equal(identity.credentialsMode, 'file');
});

test('a second login appends one account with its policy, keeps the first, and prints the reload hint without the created line', async t => {
  const ctx = await setup(t);
  await withOneAccount(ctx);
  const result = await ctx.login('second', ACCOUNT_B, ['--block-when-unknown']);
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.deepEqual(stderrLines(result), [REGISTERED_LINE, RELOAD_HINT_LINE]);
  const raw = await ctx.readRaw();
  assert.deepEqual(raw.accounts.map(account => account.label), ['first', 'second']);
  assert.deepEqual(raw.accounts[1].usagePolicy, { stopUsedPercent: 90, resumeUsedPercent: 50, blockWhenUnknown: true });
  assert.notEqual(raw.accounts[0].codexHome, raw.accounts[1].codexHome);
  const loaded = await loadCodexConfigSnapshot({ env: ctx.env });
  assert.equal(loaded.config.accounts.length, 2);
  assert.equal((await readdir(ctx.accountsDir)).length, 2);
});

test('the account folder name comes from the injected identifier, not from the label', async t => {
  const ctx = await setup(t);
  const result = await ctx.run(ARGS_A, { randomUUID: () => FIXED_NAME });
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.equal((await ctx.readRaw()).accounts[0].codexHome, join(ctx.accountsDir, FIXED_NAME));
});

test('an empty CODEX_HOME and an unset CODEX_HOME are not checked', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.run(ARGS_A, {}, { ...ctx.env, CODEX_HOME: '' })).code, LOGIN_EXIT.ok);
  const unset = { ...ctx.env };
  delete unset.CODEX_HOME;
  ctx.nextAccountId = ACCOUNT_B;
  assert.equal((await ctx.run(['--label', 'beta', '--stop', '80', '--resume', '0'], {}, unset)).code, LOGIN_EXIT.ok);
});

// ---------------------------------------------------------------------------------------------
// 引数と方針（フォルダを作らず、対話ログインも起動しない）
// ---------------------------------------------------------------------------------------------

const BAD_ARGUMENTS = [
  ['no arguments', []],
  ['no --stop', ['--label', 'alpha', '--resume', '50']],
  ['no --resume', ['--label', 'alpha', '--stop', '90']],
  ['no --label', ['--stop', '90', '--resume', '50']],
  ['stop 0', ['--label', 'alpha', '--stop', '0', '--resume', '0']],
  ['stop above 100', ['--label', 'alpha', '--stop', '101', '--resume', '50']],
  ['resume equal to stop', ['--label', 'alpha', '--stop', '90', '--resume', '90']],
  ['resume above stop', ['--label', 'alpha', '--stop', '50', '--resume', '90']],
  ['negative resume', ['--label', 'alpha', '--stop', '90', '--resume', '-1']],
  ['stop not a number', ['--label', 'alpha', '--stop', 'high', '--resume', '50']],
  ['stop in exponent form', ['--label', 'alpha', '--stop', '1e2', '--resume', '50']],
  ['stop with a sign', ['--label', 'alpha', '--stop', '+90', '--resume', '50']],
  ['stop with spaces', ['--label', 'alpha', '--stop', ' 90', '--resume', '50']],
  ['missing value at the end', ['--label', 'alpha', '--stop', '90', '--resume']],
  ['label with capitals', ['--label', 'Alpha', '--stop', '90', '--resume', '50']],
  ['label too long', ['--label', 'a'.repeat(33), '--stop', '90', '--resume', '50']],
  ['label as a path', ['--label', '../alpha', '--stop', '90', '--resume', '50']],
  ['label given twice', ['--label', 'alpha', '--label', 'beta', '--stop', '90', '--resume', '50']],
  ['flag given twice', [...ARGS_A, '--block-when-unknown', '--block-when-unknown']],
  ['unknown option', [...ARGS_A, '--zz-unknown']],
  ['option with an equals sign', ['--label=alpha', '--stop', '90', '--resume', '50']],
  ['positional word', [...ARGS_A, 'extra']],
];

for (const [what, argv] of BAD_ARGUMENTS) {
  test(`login refuses bad arguments (${what}) before making a folder or starting login`, async t => {
    const ctx = await setup(t);
    const result = await ctx.run(argv);
    assert.equal(result.code, LOGIN_EXIT.usage, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(stderrLines(result).at(-1), LOGIN_USAGE);
    assert.equal(ctx.iso.spawnCalls.length, 0);
    assert.equal(await listOrNull(ctx.accountsDir), null);
    assert.equal(await fileState(ctx.configPath), null);
  });
}

test('parseLoginArgs keeps fractional percentages and the flag', () => {
  const parsed = parseLoginArgs(['--resume', '12.5', '--block-when-unknown', '--stop', '99.75', '--label', 'x_1-a']);
  assert.deepEqual(parsed, {
    ok: true,
    options: { label: 'x_1-a', usagePolicy: { stopUsedPercent: 99.75, resumeUsedPercent: 12.5, blockWhenUnknown: true } },
  });
});

// ---------------------------------------------------------------------------------------------
// 各段の失敗（設定は変えていない。フォルダを作った後なら、残したことを出す）
// ---------------------------------------------------------------------------------------------

test('a config that cannot be read stops before the folder and the login', async t => {
  const ctx = await setup(t);
  await mkdir(join(ctx.env.XDG_CONFIG_HOME, 'codex-rotator'), { mode: 0o700 });
  await writeFile(ctx.configPath, '{ not json', { mode: 0o600 });
  const before = await fileState(ctx.configPath);
  const result = await ctx.run(ARGS_A);
  assertFailedUnchanged(result, { folderLeft: false });
  assert.deepEqual(await fileState(ctx.configPath), before);
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(await listOrNull(ctx.accountsDir), null);
});

test('a label that is already registered stops before the folder and the login', async t => {
  const ctx = await setup(t);
  const before = await withOneAccount(ctx);
  const result = await ctx.login('first', ACCOUNT_B);
  assertFailedUnchanged(result, { folderLeft: false });
  assert.ok(result.stderr.includes(LOGIN_FAILURE.labelRegistered));
  assert.deepEqual(await fileState(ctx.configPath), before.config);
  assert.deepEqual(await listOrNull(ctx.accountsDir), before.folders);
  assert.equal(ctx.iso.spawnCalls.length, 0);
});

test('a missing Codex CLI stops before the folder and the login', async t => {
  const ctx = await setup(t);
  const emptyBin = join(ctx.iso.root, 'no-codex-bin');
  await mkdir(emptyBin, { mode: 0o700 });
  const signals = fakeSignals();
  const result = await ctx.run(ARGS_A, { signals }, { ...ctx.env, PATH: emptyBin });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.ok(result.stderr.includes(LOGIN_FAILURE.codexMissing));
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(signals.added.length, 0, 'no signal receiver is added before the checks pass');
  assert.equal(await listOrNull(ctx.accountsDir), null);
  assert.equal(await fileState(ctx.configPath), null);
});

const CHILD_FAILURES = [
  ['exits non-zero', () => fakeChild({ code: 1 }), LOGIN_FAILURE.childFailed],
  ['ends by a signal', () => fakeChild({ code: null, signal: 'SIGTERM' }), LOGIN_FAILURE.childSignaled],
  ['emits a start error', () => fakeChild({ error: true }), LOGIN_FAILURE.childNotStarted],
  ['throws from spawn', () => { throw Object.assign(new Error('refused'), { code: 'EACCES' }); }, LOGIN_FAILURE.childNotStarted],
];

for (const [what, behave, reason] of CHILD_FAILURES) {
  test(`a login child that ${what} leaves the config unchanged and says the folder was left`, async t => {
    const ctx = await setup(t);
    const before = await withOneAccount(ctx);
    ctx.behave = (args, options) => {
      ctx.writeCredentials(options, ACCOUNT_B);
      return behave();
    };
    const result = await ctx.login('second', ACCOUNT_B);
    assertFailedUnchanged(result, { folderLeft: true });
    assert.ok(result.stderr.includes(reason), result.stderr);
    assert.deepEqual(await fileState(ctx.configPath), before.config);
    assert.equal((await readdir(ctx.accountsDir)).length, before.folders.length + 1);
  });
}

test('the first login that fails in the child creates no config', async t => {
  const ctx = await setup(t, { behave: () => fakeChild({ code: 1 }) });
  const result = await ctx.run(ARGS_A);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.equal(await fileState(ctx.configPath), null);
});

for (const [what, write] of [
  ['did not write', () => {}],
  ['wrote without an identity', options => writeFileSync(join(options.env.CODEX_HOME, 'auth.json'), '{"tokens":{}}', { mode: 0o600 })],
  ['wrote readable by others', options => {
    writeFileSync(join(options.env.CODEX_HOME, 'auth.json'), syntheticAuthJson(ACCOUNT_B), { mode: 0o600 });
    fs.chmodSync(join(options.env.CODEX_HOME, 'auth.json'), 0o644);
  }],
]) {
  test(`credentials that login ${what} are not registered`, async t => {
    const ctx = await setup(t, {
      behave: (args, options) => { write(options); return fakeChild(); },
    });
    const result = await ctx.run(ARGS_A);
    assertFailedUnchanged(result, { folderLeft: true });
    assert.ok(result.stderr.includes(LOGIN_FAILURE.credentialsUnreadable), result.stderr);
    assert.equal(await fileState(ctx.configPath), null);
  });
}

test('the same account as a registered one is refused before the config is written', async t => {
  const ctx = await setup(t);
  const before = await withOneAccount(ctx);
  let configWrites = 0;
  const counting = { open: async (...args) => { configWrites++; return fsPromises.open(...args); } };
  ctx.nextAccountId = ACCOUNT_A;
  const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'], { configFileOps: counting });
  assertFailedUnchanged(result, { folderLeft: true });
  assert.ok(result.stderr.includes(LOGIN_FAILURE.duplicateAccount));
  assert.equal(configWrites, 0, 'no temporary config file is written');
  assert.deepEqual(await fileState(ctx.configPath), before.config);
});

const ACCOUNT_X = 'zz-synthetic-account-x';
const ACCOUNT_Y = 'zz-synthetic-account-y';
const ARGS_FOURTH = ['--label', 'fourth', '--stop', '90', '--resume', '50'];

// 登録済みの口座を3つ（first・second・third の順）持つ設定を作り、その状態と各口座のフォルダを返す。
async function withThreeAccounts(ctx) {
  for (const [label, accountId] of [['first', ACCOUNT_A], ['second', ACCOUNT_B], ['third', ACCOUNT_X]]) {
    const result = await ctx.login(label, accountId);
    assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  }
  ctx.childCalls.length = 0;
  ctx.iso.spawnCalls.length = 0;
  const homes = Object.fromEntries((await ctx.readRaw()).accounts.map(account => [account.label, account.codexHome]));
  return { config: await fileState(ctx.configPath), folders: await listOrNull(ctx.accountsDir), homes };
}

// 読めない口座を並べる行と案内の行に、読めた口座のラベル（既定は second）・パスの形・識別子とハッシュが
// 出ていない。
function assertUnreadableOutputClean(result, homes, { readable = ['second'] } = {}) {
  const forbidden = [
    ...readable, ...Object.values(homes), ACCOUNT_A, ACCOUNT_B, ACCOUNT_X, ACCOUNT_Y,
    accountIdHash(ACCOUNT_A), accountIdHash(ACCOUNT_B), accountIdHash(ACCOUNT_X), accountIdHash(ACCOUNT_Y),
  ];
  assert.deepEqual(forbidden.filter(value => result.stderr.includes(value)), []);
  assert.doesNotMatch(result.stderr, /[/\\]|\.codex-accounts|auth\.json/);
}

test('registered accounts whose credentials cannot be read stop before the folder and the login, named in config order with the remove hint', async t => {
  const ctx = await setup(t);
  const before = await withThreeAccounts(ctx);
  await unlink(join(before.homes.third, 'auth.json'));
  await unlink(join(before.homes.first, 'auth.json'));
  const signals = fakeSignals();
  ctx.nextAccountId = ACCOUNT_Y;
  const result = await ctx.run(ARGS_FOURTH, { signals });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.deepEqual(stderrLines(result), [
    `codex-rotator login: ${LOGIN_FAILURE.otherCredentialsUnreadable}.`, CONFIG_UNCHANGED_LINE,
    'codex-rotator login: registered accounts whose credentials cannot be read: first, third',
    OTHER_CREDENTIALS_HINT_LINE,
  ]);
  assertUnreadableOutputClean(result, before.homes);
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(signals.added.length, 0, 'no signal receiver is added before the checks pass');
  assert.deepEqual(await listOrNull(ctx.accountsDir), before.folders);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
});

test('registered accounts whose credentials become unreadable during the login are still refused after the login, named with the remove hint', async t => {
  const ctx = await setup(t);
  const before = await withThreeAccounts(ctx);
  ctx.behave = (args, options) => {
    ctx.writeCredentials(options, ACCOUNT_Y);
    unlinkSync(join(before.homes.first, 'auth.json'));
    unlinkSync(join(before.homes.third, 'auth.json'));
    return fakeChild();
  };
  const result = await ctx.run(ARGS_FOURTH);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.deepEqual(stderrLines(result), [
    `codex-rotator login: ${LOGIN_FAILURE.otherCredentialsUnreadable}.`, CONFIG_UNCHANGED_LINE, FOLDER_LEFT_LINE,
    'codex-rotator login: registered accounts whose credentials cannot be read: first, third',
    OTHER_CREDENTIALS_HINT_LINE,
  ]);
  assertUnreadableOutputClean(result, before.homes);
  assert.equal(ctx.iso.spawnCalls.length, 1);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
});

// ログインの後の比べ方は設定の並びの順で、先に当たったもので止める。読めない口座が2番目以降でも、
// そこから後ろの読めない口座だけを並べる（前の読めた口座は並べない）。
test('after the login, unreadable accounts that come after a readable one are named from the first unreadable one on', async t => {
  const ctx = await setup(t);
  const before = await withThreeAccounts(ctx);
  ctx.behave = (args, options) => {
    ctx.writeCredentials(options, ACCOUNT_Y);
    unlinkSync(join(before.homes.second, 'auth.json'));
    unlinkSync(join(before.homes.third, 'auth.json'));
    return fakeChild();
  };
  const result = await ctx.run(ARGS_FOURTH);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.deepEqual(stderrLines(result), [
    `codex-rotator login: ${LOGIN_FAILURE.otherCredentialsUnreadable}.`, CONFIG_UNCHANGED_LINE, FOLDER_LEFT_LINE,
    'codex-rotator login: registered accounts whose credentials cannot be read: second, third',
    OTHER_CREDENTIALS_HINT_LINE,
  ]);
  assertUnreadableOutputClean(result, before.homes, { readable: [] });
  assert.equal(ctx.iso.spawnCalls.length, 1);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
});

// 同じ口座が読めない口座より先に並ぶときは、重複で止め、読めない口座の行と案内は出さない。
test('after the login, a duplicate that comes before an unreadable account stops as a duplicate without the unreadable lines', async t => {
  const ctx = await setup(t);
  const before = await withThreeAccounts(ctx);
  ctx.behave = (args, options) => {
    ctx.writeCredentials(options, ACCOUNT_A);
    unlinkSync(join(before.homes.third, 'auth.json'));
    return fakeChild();
  };
  const result = await ctx.run(ARGS_FOURTH);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.deepEqual(stderrLines(result), [
    `codex-rotator login: ${LOGIN_FAILURE.duplicateAccount}.`, CONFIG_UNCHANGED_LINE, FOLDER_LEFT_LINE,
  ]);
  assert.equal(result.stderr.includes(UNREADABLE_ACCOUNTS_LINE_START), false);
  assert.equal(result.stderr.includes(OTHER_CREDENTIALS_HINT_LINE), false);
  assert.equal(ctx.iso.spawnCalls.length, 1);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
});

test('a config changed by someone else during the login is not overwritten', async t => {
  const ctx = await setup(t);
  await withOneAccount(ctx);
  ctx.behave = (args, options) => {
    ctx.writeCredentials(options, ACCOUNT_B);
    writeFileSync(ctx.configPath, `${readFileSync(ctx.configPath, 'utf8')} `, { mode: 0o600 });
    return fakeChild();
  };
  const result = await ctx.login('second', ACCOUNT_B);
  const changed = await fileState(ctx.configPath);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.deepEqual(await fileState(ctx.configPath), changed);
  assert.deepEqual((await ctx.readRaw()).accounts.map(account => account.label), ['first']);
});

test('a failed rename leaves the config bytes and modification time unchanged and no temporary file', async t => {
  const ctx = await setup(t);
  const before = await withOneAccount(ctx);
  let renames = 0;
  const failingRename = { rename: async () => { renames++; throw Object.assign(new Error(DUMMY_ACCESS), { code: 'EIO' }); } };
  ctx.nextAccountId = ACCOUNT_B;
  const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'], { configFileOps: failingRename });
  assertFailedUnchanged(result, { folderLeft: true });
  assert.equal(renames, 1);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
  const leftovers = (await readdir(join(ctx.env.XDG_CONFIG_HOME, 'codex-rotator'))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.ok(!result.stderr.includes(DUMMY_ACCESS));
});

test('a failed first creation of the config leaves no config', async t => {
  const ctx = await setup(t);
  const failingLink = { link: async () => { throw Object.assign(new Error('link failed'), { code: 'EIO' }); } };
  const result = await ctx.run(ARGS_A, { configFileOps: failingLink });
  assertFailedUnchanged(result, { folderLeft: true });
  assert.equal(await fileState(ctx.configPath), null);
  const leftovers = (await readdir(join(ctx.env.XDG_CONFIG_HOME, 'codex-rotator'))).filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------------------------
// 使わないフォルダ（中身のあるフォルダ・リンク・~/.codex）
// ---------------------------------------------------------------------------------------------

for (const [what, prepare] of [
  ['an empty folder', async path => { await mkdir(path, { mode: 0o700 }); }],
  ['a folder with content', async path => {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, 'existing.txt'), 'existing', { mode: 0o600 });
  }],
  ['a symbolic link to a folder', async (path, root) => {
    const target = join(root, 'link-target');
    await mkdir(target, { mode: 0o700 });
    await writeFile(join(target, 'existing.txt'), 'existing', { mode: 0o600 });
    await symlink(target, path);
  }],
]) {
  test(`login does not use ${what} as the new account folder`, async t => {
    const ctx = await setup(t);
    await mkdir(ctx.accountsDir, { mode: 0o700 });
    const path = join(ctx.accountsDir, FIXED_NAME);
    await prepare(path, ctx.iso.root);
    const before = await lstat(path);
    const result = await ctx.run(ARGS_A, { randomUUID: () => FIXED_NAME });
    assertFailedUnchanged(result, { folderLeft: false });
    assert.equal(ctx.iso.spawnCalls.length, 0);
    const after = await lstat(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    if (before.isSymbolicLink()) assert.deepEqual(await readdir(join(ctx.iso.root, 'link-target')), ['existing.txt']);
    else assert.equal((await readdir(path)).includes('config.toml'), false);
    assert.equal(await fileState(ctx.configPath), null);
  });
}

async function writeRawConfig(ctx, raw) {
  await mkdir(join(ctx.env.XDG_CONFIG_HOME, 'codex-rotator'), { mode: 0o700 });
  await writeFile(ctx.configPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
}

const DEFAULT_CODEX_HOME_CASES = [
  ['the default accountsDir is a link to ~/.codex', async ctx => {
    await symlink(join(ctx.iso.home, '.codex'), ctx.accountsDir);
  }],
  ['accountsDir contains ~/.codex', async ctx => writeRawConfig(ctx, { accountsDir: '~' })],
  ['accountsDir is inside ~/.codex', async ctx => writeRawConfig(ctx, { accountsDir: '~/.codex/accounts' })],
  ['accountsDir is ~/.codex', async ctx => writeRawConfig(ctx, { accountsDir: '~/.codex' })],
  ['~/.codex is a link to the would-be account folder', async ctx => {
    await rm(join(ctx.iso.home, '.codex'), { recursive: true, force: true });
    await symlink(join(ctx.accountsDir, FIXED_NAME), join(ctx.iso.home, '.codex'));
  }],
];

for (const [what, prepare] of DEFAULT_CODEX_HOME_CASES) {
  test(`login does not make an account folder at, inside or around ~/.codex (${what})`, async t => {
    const ctx = await setup(t);
    const codexDir = join(ctx.iso.home, '.codex');
    await mkdir(codexDir, { mode: 0o700 });
    await writeFile(join(codexDir, 'marker.txt'), 'primary', { mode: 0o600 });
    await prepare(ctx);
    const configBefore = await fileState(ctx.configPath);
    const codexListBefore = await listOrNull(codexDir);
    const result = await ctx.run(ARGS_A, { randomUUID: () => FIXED_NAME });
    assertFailedUnchanged(result, { folderLeft: false });
    assert.equal(ctx.iso.spawnCalls.length, 0);
    assert.deepEqual(await fileState(ctx.configPath), configBefore);
    assert.deepEqual(await listOrNull(codexDir), codexListBefore);
    assert.ok(!result.stderr.includes(ctx.iso.home));
  });
}

// ---------------------------------------------------------------------------------------------
// CODEX_HOME の重なり
// ---------------------------------------------------------------------------------------------

const CODEX_HOME_OVERLAPS = [
  ['is the not-yet-created new account folder', ctx => join(ctx.accountsDir, FIXED_NAME)],
  ['is a not-yet-created path inside the new account folder', ctx => join(ctx.accountsDir, FIXED_NAME, 'deeper')],
  ['is a not-yet-created path inside accountsDir', ctx => join(ctx.accountsDir, 'not-yet', 'there')],
  ['is accountsDir', ctx => ctx.accountsDir],
  ['contains accountsDir', ctx => ctx.iso.home],
  ['is a registered account folder', (ctx, first) => first.codexHome],
  ['is inside a registered account folder', (ctx, first) => join(first.codexHome, 'sessions')],
  ['is the root folder', () => sep],
];

for (const [what, pick] of CODEX_HOME_OVERLAPS) {
  test(`login refuses when CODEX_HOME ${what}, before making a folder, starting login or writing the config`, async t => {
    const ctx = await setup(t);
    const before = await withOneAccount(ctx);
    const [first] = (await ctx.readRaw()).accounts;
    const codexHome = pick(ctx, first);
    ctx.nextAccountId = ACCOUNT_B;
    const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'],
      { randomUUID: () => FIXED_NAME }, { ...ctx.env, CODEX_HOME: codexHome });
    assertFailedUnchanged(result, { folderLeft: false });
    assert.ok(result.stderr.includes(LOGIN_FAILURE.codexHomeOverlaps), result.stderr);
    assert.ok(!result.stderr.includes(codexHome === sep ? '\0' : codexHome));
    assert.equal(ctx.iso.spawnCalls.length, 0);
    assert.deepEqual(await listOrNull(ctx.accountsDir), before.folders);
    assert.deepEqual(await fileState(ctx.configPath), before.config);
  });
}

test('login refuses a CODEX_HOME that points at the new folder through a link to accountsDir', async t => {
  const ctx = await setup(t);
  const before = await withOneAccount(ctx);
  const alias = join(ctx.iso.root, 'alias-of-accounts');
  await symlink(ctx.accountsDir, alias);
  const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'],
    { randomUUID: () => FIXED_NAME }, { ...ctx.env, CODEX_HOME: join(alias, FIXED_NAME) });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.ok(result.stderr.includes(LOGIN_FAILURE.codexHomeOverlaps));
  assert.deepEqual(await listOrNull(ctx.accountsDir), before.folders);
});

test('login refuses a relative CODEX_HOME without printing its value', async t => {
  const ctx = await setup(t);
  const value = 'zz-relative-marker/codex-home';
  const result = await ctx.run(ARGS_A, {}, { ...ctx.env, CODEX_HOME: value });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.ok(result.stderr.includes(LOGIN_FAILURE.codexHomeRelative));
  assert.ok(!result.stderr.includes('zz-relative-marker'));
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(await listOrNull(ctx.accountsDir), null);
  assert.equal(await fileState(ctx.configPath), null);
});

test('login refuses a CODEX_HOME that is a link with no target', async t => {
  const ctx = await setup(t);
  const dangling = join(ctx.iso.root, 'dangling-codex-home');
  await symlink(join(ctx.iso.root, 'no-such-target'), dangling);
  const result = await ctx.run(ARGS_A, {}, { ...ctx.env, CODEX_HOME: dangling });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(await listOrNull(ctx.accountsDir), null);
  assert.ok(!result.stderr.includes(dangling));
});

test('a CODEX_HOME apart from every account place is accepted', async t => {
  const ctx = await setup(t);
  await withOneAccount(ctx);
  const apart = join(ctx.iso.root, 'somewhere-else', 'codex-home');
  ctx.nextAccountId = ACCOUNT_B;
  const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'], {}, { ...ctx.env, CODEX_HOME: apart });
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
});

// ---------------------------------------------------------------------------------------------
// 開かないファイルと出さない値
// ---------------------------------------------------------------------------------------------

// fs の読込み・開く関数を記録する差し替え（ESM の名前付き import にも反映する）。
function recordFileOpens(t) {
  const targets = [
    [fsPromises, ['open', 'readFile', 'opendir', 'readdir']],
    [fs, ['open', 'openSync', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'opendir', 'opendirSync', 'createReadStream']],
  ];
  const calls = [];
  const originals = [];
  for (const [target, names] of targets) {
    for (const name of names) {
      const original = target[name];
      originals.push([target, name, original]);
      target[name] = function recorded(...args) {
        calls.push({ name, path: String(args[0]) });
        return original.apply(this, args);
      };
    }
  }
  syncBuiltinESMExports();
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [target, name, original] of originals) target[name] = original;
    syncBuiltinESMExports();
  };
  t.after(restore);
  return { calls, restore };
}

test('login does not open the ~/.codex config.toml or AGENTS.md', async t => {
  const ctx = await setup(t);
  const codexDir = join(ctx.iso.home, '.codex');
  await mkdir(codexDir, { mode: 0o700 });
  const marker = 'ZZ-PRIMARY-CODEX-MARKER';
  await writeFile(join(codexDir, 'config.toml'), `# ${marker}\nmodel = "zz"\n`, { mode: 0o600 });
  await writeFile(join(codexDir, 'AGENTS.md'), `${marker}\n`, { mode: 0o600 });
  await withOneAccount(ctx);
  const recorder = recordFileOpens(t);
  const result = await ctx.login('second', ACCOUNT_B);
  recorder.restore();
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  const inside = recorder.calls.filter(call => call.path.startsWith(`${codexDir}${sep}`));
  assert.deepEqual(inside, []);
  // 陽性対照: 記録は届いている（口座のフォルダの資格情報と設定ファイルを開いた記録がある）。
  const [, second] = (await ctx.readRaw()).accounts;
  assert.ok(recorder.calls.some(call => call.path === join(second.codexHome, 'auth.json')), 'the recorder sees credential opens');
  assert.ok(recorder.calls.some(call => call.path === ctx.configPath), 'the recorder sees config opens');
  assert.ok(!result.stderr.includes(marker));
});

test('no account identifier, hash, token, e-mail address or path reaches the output', async t => {
  const ctx = await setup(t);
  const outputs = [];
  outputs.push(await ctx.login('first', ACCOUNT_A));
  outputs.push(await ctx.login('second', ACCOUNT_B));
  outputs.push(await ctx.login('third', ACCOUNT_A)); // 重複
  const raw = await ctx.readRaw();
  const forbidden = [
    DUMMY_EMAIL, DUMMY_ACCESS, DUMMY_REFRESH, ACCOUNT_A, ACCOUNT_B, accountIdHash(ACCOUNT_A), accountIdHash(ACCOUNT_B),
    syntheticIdToken(ACCOUNT_A), ctx.iso.root, ctx.accountsDir, ctx.configPath, ...raw.accounts.map(account => account.codexHome),
  ];
  const text = outputs.map(result => result.stdout + result.stderr).join('\n');
  assert.deepEqual(forbidden.filter(value => text.includes(value)), []);
  assert.equal(outputs[2].code, LOGIN_EXIT.failed);
  assert.equal(outputs.map(result => result.stdout).join(''), '');
});

// ---------------------------------------------------------------------------------------------
// login し直し（--relogin）
//
// - シグナルの受け口と終了の関数は、どのテストでも偽物を渡す（テストの実行器のプロセスに受け口を
//   付けず、終了コードも入れない）。
// - login と logout の子は、差し替えた spawn が受ける偽物だけ。
// ---------------------------------------------------------------------------------------------

const ACCOUNT_C = 'zz-synthetic-account-c';
const LINE_PREFIX = 'codex-rotator login: ';
const wordLine = (word, marks = '') => `${LINE_PREFIX}${word}${marks}`;
const reasonLine = reason => `${LINE_PREFIX}${reason}.`;
const SIGNAL_COUNTS = count => Object.fromEntries(RELOGIN_SIGNALS.map(name => [name, count]));

// 偽のシグナルの受け口。付けた・外した受け口と、自分へのシグナルの送信（kill）を記録する。
function fakeSignals() {
  const listeners = new Map();
  const signals = {
    pid: 424242,
    added: [],
    removed: [],
    kills: [],
    on(name, handler) {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
      signals.added.push(name);
      return signals;
    },
    removeListener(name, handler) {
      listeners.set(name, (listeners.get(name) ?? []).filter(entry => entry !== handler));
      signals.removed.push(name);
      return signals;
    },
    kill(pid, name) {
      signals.kills.push({ pid, name });
      return true;
    },
    counts: () => Object.fromEntries(RELOGIN_SIGNALS.map(name => [name, (listeners.get(name) ?? []).length])),
    send(name) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(name);
    },
  };
  return signals;
}

// 終わるまで動き続ける偽の子。kill の記録を持ち、endOnKill なら送られたシグナルで終わる。
function controllableChild({ endOnKill = false } = {}) {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    if (endOnKill) setImmediate(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
}

const LOGOUT_BEHAVIOURS = Object.freeze({
  ok: (options, rig) => {
    unlinkSync(rig.authPath);
    return fakeChild();
  },
  exit: () => fakeChild({ code: 1 }),
  signal: () => fakeChild({ code: null, signal: 'SIGTERM' }),
  stays: () => fakeChild(),
  hang: (options, rig) => {
    rig.logoutChildRef = controllableChild();
    return rig.logoutChildRef;
  },
  startError: () => fakeChild({ error: true }),
  spawnThrows: () => { throw Object.assign(new Error('refused'), { code: 'EACCES' }); },
  // 動いている間に親へ SIGINT を送り、転送された SIGINT で終わる。
  endsOnForwardedSigint: (options, rig) => {
    rig.logoutChildRef = controllableChild({ endOnKill: true });
    setImmediate(() => {
      rig.seen.exitsAtLogoutSignal = rig.exits.length;
      rig.signals.send('SIGINT');
    });
    return rig.logoutChildRef;
  },
});

// 登録済みの口座 first（口座 A。withSecond なら second〈口座 B〉も）を持つ環境と、login し直しを
// 走らせる道具を作る。login の子は rig.loginWrites の口座の資格情報を書き（'unreadable' なら口座の
// 識別子の無いものを書き、null なら書かない）、rig.loginChild() の子を返す。
async function setupRelogin(t, { withSecond = false } = {}) {
  const ctx = await setup(t);
  assert.equal((await ctx.login('first', ACCOUNT_A)).code, LOGIN_EXIT.ok);
  if (withSecond) assert.equal((await ctx.login('second', ACCOUNT_B)).code, LOGIN_EXIT.ok);
  const first = (await ctx.readRaw()).accounts.find(account => account.label === 'first');
  const rig = {
    ctx,
    home: first.codexHome,
    authPath: join(first.codexHome, 'auth.json'),
    events: [],
    exits: [],
    seen: {},
    signals: fakeSignals(),
    loginWrites: ACCOUNT_A,
    loginChild: () => fakeChild(),
    logout: 'ok',
    loginCalls: [],
    logoutCalls: [],
    listenersAtLoginSpawn: null,
  };
  ctx.behave = (args, options) => {
    const verb = args.at(-1);
    if (verb === 'login') {
      rig.events.push('spawn login');
      rig.loginCalls.push({ args, options });
      rig.listenersAtLoginSpawn = rig.signals.counts();
      if (rig.loginWrites === 'unreadable') writeFileSync(rig.authPath, '{"tokens":{}}', { mode: 0o600 });
      else if (rig.loginWrites !== null) ctx.writeCredentials(options, rig.loginWrites);
      return rig.loginChild();
    }
    if (verb === 'logout') {
      rig.events.push('spawn logout');
      rig.logoutCalls.push({ args, options });
      return LOGOUT_BEHAVIOURS[rig.logout](options, rig);
    }
    throw new Error('unexpected codex call in the test');
  };
  rig.recordingOps = {
    rename: async (from, to) => {
      rig.events.push('config rename');
      return fsPromises.rename(from, to);
    },
  };
  rig.failingOps = {
    rename: async () => {
      rig.events.push('config rename failed');
      throw Object.assign(new Error(DUMMY_ACCESS), { code: 'EIO' });
    },
  };
  ctx.childCalls.length = 0;
  ctx.iso.spawnCalls.length = 0;
  rig.configBefore = await fileState(ctx.configPath);
  rig.foldersBefore = await listOrNull(ctx.accountsDir);
  rig.run = (deps = {}, argv = ['--label', 'first', '--relogin'], env = ctx.env) => ctx.run(argv, {
    signals: rig.signals, exit: code => rig.exits.push(code), configFileOps: rig.recordingOps, logoutTimeoutMs: 5000, ...deps,
  }, env);
  return rig;
}

// そのラベルが設定から外れ、設定が検証を通り、フォルダは残っている。
async function assertLabelRemoved(rig, remaining = []) {
  const loaded = await loadCodexConfigSnapshot({ env: rig.ctx.env });
  assert.deepEqual(loaded.config.accounts.map(account => account.label), remaining);
  assert.ok((await lstat(rig.home)).isDirectory());
  assert.deepEqual(await listOrNull(rig.ctx.accountsDir), rig.foldersBefore);
}

// 同じラベルへの login し直しは、未登録のラベルとしてログインを始めない。
async function assertReloginRefusedAfterwards(rig) {
  rig.ctx.iso.spawnCalls.length = 0;
  const again = await rig.run();
  assert.equal(again.code, LOGIN_EXIT.failed, again.stderr);
  assert.ok(stderrLines(again).includes(reasonLine(LOGIN_FAILURE.labelNotRegistered)), again.stderr);
  assert.equal(rig.ctx.iso.spawnCalls.length, 0);
}

// 口座の識別子・そのハッシュ・トークン・メールアドレス・パスが出力に無い。
async function assertNoSecrets(rig, result) {
  const raw = await registeredAccounts(rig);
  const forbidden = [
    DUMMY_EMAIL, DUMMY_ACCESS, DUMMY_REFRESH, ACCOUNT_A, ACCOUNT_B, ACCOUNT_C,
    accountIdHash(ACCOUNT_A), accountIdHash(ACCOUNT_B), accountIdHash(ACCOUNT_C),
    syntheticIdToken(ACCOUNT_A), syntheticIdToken(ACCOUNT_C), rig.ctx.iso.root, rig.ctx.accountsDir, rig.ctx.configPath,
    rig.home, ...raw.map(account => account.codexHome),
  ];
  const text = result.stdout + result.stderr;
  assert.deepEqual(forbidden.filter(value => text.includes(value)), []);
  assert.equal(result.stdout, '');
}

async function registeredAccounts(rig) {
  return (await fileState(rig.ctx.configPath)) === null ? [] : (await rig.ctx.readRaw()).accounts;
}

test('relogin to a registered label starts one login child in that folder and leaves the config, its time and the folders unchanged', async t => {
  const rig = await setupRelogin(t);
  const processListeners = RELOGIN_SIGNALS.map(name => process.listenerCount(name));
  const result = await rig.run();
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.deepEqual(stderrLines(result), [RELOGIN_OK_LINE]);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.ok]);
  assert.equal(rig.ctx.iso.spawnCalls.length, 1);
  const [call] = rig.ctx.iso.spawnCalls;
  assert.equal(call.command, rig.ctx.codexPath);
  assert.deepEqual(call.args, [...LOGIN_CHILD_ARGS]);
  assert.equal(call.options.env.CODEX_HOME, rig.home);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.stdio, 'inherit');
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
  assert.deepEqual(await listOrNull(rig.ctx.accountsDir), rig.foldersBefore);
  // 受け口は子の起動より先に1つずつ付き、終わった後は残らない。自分へのシグナルの送信は無い。
  assert.deepEqual(rig.listenersAtLoginSpawn, SIGNAL_COUNTS(1));
  assert.deepEqual(rig.signals.counts(), SIGNAL_COUNTS(0));
  assert.equal(rig.signals.kills.length, 0);
  // テストの実行器のプロセスには受け口を付けていない。
  assert.deepEqual(RELOGIN_SIGNALS.map(name => process.listenerCount(name)), processListeners);
  assert.equal(rig.ctx.iso.refusedChildProcesses.length, 0);
  await assertNoSecrets(rig, result);
});

test('the default signal receiver is process, the logout deadline is 10 seconds and the logout child uses the file store', () => {
  const parts = resolveLoginDeps();
  assert.equal(parts.signals, process);
  assert.equal(typeof parts.exit, 'function');
  assert.equal(parts.logoutTimeoutMs, CODEX_LOGOUT_TIMEOUT_MS);
  assert.equal(CODEX_LOGOUT_TIMEOUT_MS, 10000);
  assert.deepEqual(RELOGIN_SIGNALS, ['SIGINT', 'SIGQUIT', 'SIGHUP', 'SIGTERM']);
  assert.deepEqual(LOGOUT_CHILD_ARGS, ['-c', 'cli_auth_credentials_store="file"', 'logout']);
});

test('relogin to a label that is not registered starts no child and leaves the config unchanged', async t => {
  const rig = await setupRelogin(t);
  const result = await rig.run({}, ['--label', 'nobody', '--relogin']);
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [reasonLine(LOGIN_FAILURE.labelNotRegistered), CONFIG_UNCHANGED_LINE]);
  assert.equal(rig.ctx.iso.spawnCalls.length, 0);
  assert.equal(rig.signals.added.length, 0);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
});

for (const [what, argv] of [
  ['--stop', ['--label', 'first', '--relogin', '--stop', '90']],
  ['--resume', ['--label', 'first', '--relogin', '--resume', '50']],
  ['--block-when-unknown', ['--label', 'first', '--relogin', '--block-when-unknown']],
  ['the whole policy', ['--label', 'first', '--stop', '90', '--resume', '50', '--relogin']],
  ['no --label', ['--relogin']],
  ['--relogin twice', ['--label', 'first', '--relogin', '--relogin']],
  ['a bad label', ['--label', 'First', '--relogin']],
]) {
  test(`relogin refuses bad arguments (${what}) without starting a child`, async t => {
    const rig = await setupRelogin(t);
    const result = await rig.run({}, argv);
    assert.equal(result.code, LOGIN_EXIT.usage, result.stderr);
    assert.equal(stderrLines(result).at(-1), LOGIN_USAGE);
    assert.equal(rig.ctx.iso.spawnCalls.length, 0);
    assert.equal(rig.signals.added.length, 0);
    assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
  });
}

for (const [what, prepare] of [
  ['missing', rig => unlink(rig.authPath)],
  ['without an account identifier', rig => writeFile(rig.authPath, '{"tokens":{}}', { mode: 0o600 })],
  ['readable by others', rig => chmod(rig.authPath, 0o644)],
]) {
  test(`relogin with the current credentials ${what} starts no child and says account unverified`, async t => {
    const rig = await setupRelogin(t);
    await prepare(rig);
    const result = await rig.run();
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.unverified), RELOGIN_UNVERIFIED_BEFORE_LINE]);
    assert.equal(rig.ctx.iso.spawnCalls.length, 0);
    assert.equal(rig.signals.added.length, 0);
    assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
    assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
    await assertNoSecrets(rig, result);
  });
}

for (const [what, withSecond, writes, word, remaining] of [
  ['a different account', false, ACCOUNT_C, RELOGIN_WORD.changed, []],
  ['the account of another label', true, ACCOUNT_B, RELOGIN_WORD.duplicate, ['second']],
]) {
  test(`relogin that ends in ${what} removes the label before one logout in the same folder and keeps the folder`, async t => {
    const rig = await setupRelogin(t, { withSecond });
    rig.loginWrites = writes;
    const result = await rig.run();
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [wordLine(word), RELOGIN_REMOVED_LINE]);
    assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
    assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
    assert.equal(rig.logoutCalls.length, 1);
    const [logout] = rig.logoutCalls;
    assert.deepEqual(logout.args, [...LOGOUT_CHILD_ARGS]);
    assert.equal(logout.options.env.CODEX_HOME, rig.home);
    assert.equal(logout.options.shell, false);
    assert.equal(rig.ctx.iso.spawnCalls[1].command, rig.ctx.codexPath);
    await assertLabelRemoved(rig, remaining);
    assert.equal(rig.signals.kills.length, 0);
    assert.deepEqual(rig.signals.counts(), SIGNAL_COUNTS(0));
    await assertNoSecrets(rig, result);
    await assertReloginRefusedAfterwards(rig);
  });
}

// --- login し直しで登録を外した後の exec ---------------------------------------------------------

// OpenAI ブリッジ（設定 openaiBridge）の待受の既定値（偽の常駐がこの番号に当たったら待ち受け直す）。
const BRIDGE_DEFAULT_PORT = 18765;
const EXEC_CONTROL_TOKEN = 'ZZEXECCONTROLTOKEN'.repeat(2);

// ポート0で待ち受ける偽の常駐。受けた要求の数を数え、answer() の本文で 200 を返す。
async function startSelectDaemon(t, iso, answer) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const requests = [];
    const server = createHttpServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(answer()));
      });
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const close = () => new Promise(resolveClose => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    });
    const { port } = server.address();
    if ([...REAL_SERVICE_PORTS, BRIDGE_DEFAULT_PORT].includes(port)) {
      await close();
      continue;
    }
    t.after(close);
    iso.allowRequest(port);
    return { port, requests };
  }
  throw new Error('the system kept assigning a port that must not be used');
}

// 登録が1つ（first）の設定を、切替を有効にした形にする（daemonPort を渡すと daemon.port も書く）。
async function enableSwitching(rig, daemonPort) {
  const raw = await rig.ctx.readRaw();
  const next = { ...raw, enabled: true, acknowledgedMultiAccountRisk: true, ...(daemonPort ? { daemon: { port: daemonPort } } : {}) };
  writeFileSync(rig.ctx.configPath, JSON.stringify(next), { mode: 0o600 });
}

// exec を差し替えの部品（隔離の spawn・数える要求関数・偽のシグナルの受け口）で走らせる。
async function runExecAfter(rig, argv) {
  const stdout = captureStream();
  const stderr = captureStream();
  const requests = [];
  const request = (...args) => {
    requests.push(args[0]);
    return rig.ctx.iso.request(...args);
  };
  const code = await runExec(argv, { stdout, stderr, env: rig.ctx.env }, {
    spawn: rig.ctx.iso.spawn, request, processCwd: () => rig.ctx.iso.root,
    signals: { on: () => {}, off: () => {} }, raiseSignal: () => {},
  });
  return { code, stdout: stdout.text(), lines: stderr.text().split('\n').filter(Boolean), requests };
}

// --account に外したラベルを渡すと、自分の設定に無いラベルとして常駐に問い合わせずに止まる。--account が
// 無いときは、外す前の設定のままの常駐がそのラベルを返しても、設定の sha256 が違うので config stale で
// 止まる（常駐が無ければ、自分の設定に口座が無いので選ばない）。どれも codex は起動しない。
for (const withDaemon of [true, false]) {
  for (const accountFlag of [true, false]) {
    const daemonText = withDaemon ? 'with a daemon that still has the old config' : 'without a daemon';
    const flagText = accountFlag ? 'exec --account with the removed label' : 'exec without --account';
    test(`after relogin removes the label, ${flagText} ${daemonText} launches nothing`, async t => {
      const rig = await setupRelogin(t);
      let oldSha256 = null;
      const daemon = withDaemon
        ? await startSelectDaemon(t, rig.ctx.iso, () => ({
          outcome: CODEX_SELECT_OUTCOME.selected, label: 'first', lastResort: false, usageKnown: true, refusal: null,
          stateWord: 'ready', reason: null, configSha256: oldSha256,
        }))
        : null;
      await enableSwitching(rig, daemon?.port);
      if (withDaemon) writeFileSync(controlTokenPath(rig.ctx.env), JSON.stringify({ token: EXEC_CONTROL_TOKEN }), { mode: 0o600 });
      oldSha256 = (await loadCodexConfigSnapshot({ env: rig.ctx.env })).sha256;
      rig.loginWrites = ACCOUNT_C;
      const relogin = await rig.run();
      assert.equal(relogin.code, LOGIN_EXIT.failed, relogin.stderr);
      assert.deepEqual(stderrLines(relogin), [wordLine(RELOGIN_WORD.changed), RELOGIN_REMOVED_LINE]);
      await assertLabelRemoved(rig);
      const current = await loadCodexConfigSnapshot({ env: rig.ctx.env });
      assert.notEqual(current.sha256, oldSha256, 'the daemon answers with the config from before the removal');
      assert.equal(current.config.enabled && current.config.acknowledgedMultiAccountRisk, true);

      rig.ctx.iso.spawnCalls.length = 0;
      const result = await runExecAfter(rig, [...(accountFlag ? ['--account', 'first'] : []), '--', 'exec', '--json', '-']);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, '');
      if (accountFlag) {
        assert.deepEqual(result.lines, [EXEC_LINE.accountNotRegistered]);
        assert.equal(result.requests.length, 0, 'no request to the daemon');
      } else if (withDaemon) {
        assert.deepEqual(result.lines, [EXEC_LINE.configStale, formatConfigStaleGuidance()]);
        assert.equal(result.requests.length, 1, 'one select to the daemon');
      } else {
        assert.deepEqual(result.lines, [EXEC_LINE.noAccountAvailable]);
        assert.equal(result.requests.length, 0, 'no control token: no request');
      }
      if (daemon) assert.equal(daemon.requests.length, accountFlag ? 0 : 1);
      assert.equal(rig.ctx.iso.spawnCalls.length, 0, 'codex is not started');
      assert.equal(result.lines.some(line => line.includes('first')), false, 'the removed label is not chosen');
      assert.equal(rig.ctx.iso.refusedChildProcesses.length, 0);
    });
  }
}

for (const [what, behaviour] of [
  ['exits non-zero', 'exit'],
  ['does not finish in time', 'hang'],
  ['leaves the credentials file', 'stays'],
  ['cannot be started (start error)', 'startError'],
  ['cannot be started (spawn throws)', 'spawnThrows'],
  ['ends by a signal', 'signal'],
]) {
  test(`a logout child that ${what} still leaves the label removed and marks logout failed`, async t => {
    const rig = await setupRelogin(t);
    rig.loginWrites = ACCOUNT_C;
    rig.logout = behaviour;
    const result = await rig.run(behaviour === 'hang' ? { logoutTimeoutMs: 50 } : {});
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed, RELOGIN_MARK.logoutFailed), RELOGIN_REMOVED_LINE]);
    assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
    assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
    await assertLabelRemoved(rig);
    if (behaviour === 'hang') assert.deepEqual(rig.logoutChildRef.kills, ['SIGKILL']);
  });
}

test('a failed removal still runs one logout and says remove failed with the steps that stop switching first', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = ACCOUNT_C;
  const result = await rig.run({ configFileOps: rig.failingOps });
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed, RELOGIN_MARK.removeFailed), RELOGIN_REMOVE_FAILED_LINE]);
  assert.deepEqual(rig.events, ['spawn login', 'config rename failed', 'spawn logout']);
  assert.equal(rig.logoutCalls.length, 1);
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
  assert.ok(!result.stderr.includes(DUMMY_ACCESS));
  await assertNoSecrets(rig, result);
});

test('a failed removal and a failed logout carry both marks and the steps that set enabled to false', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = ACCOUNT_C;
  rig.logout = 'exit';
  const result = await rig.run({ configFileOps: rig.failingOps });
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  const lines = stderrLines(result);
  assert.deepEqual(lines, [
    wordLine(RELOGIN_WORD.changed, RELOGIN_MARK.logoutFailed + RELOGIN_MARK.removeFailed), RELOGIN_REMOVE_FAILED_LINE,
  ]);
  assert.match(lines[1], /set "enabled" to false/);
  assert.equal(rig.logoutCalls.length, 1);
});

for (const [what, child] of [
  ['exits 0', () => fakeChild()],
  ['exits non-zero', () => fakeChild({ code: 1 })],
]) {
  test(`credentials that cannot be read after a login child that ${what} remove the label without a logout`, async t => {
    const rig = await setupRelogin(t);
    rig.loginWrites = 'unreadable';
    rig.loginChild = child;
    const result = await rig.run();
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.unverified), RELOGIN_REMOVED_LINE]);
    assert.deepEqual(rig.events, ['spawn login', 'config rename']);
    assert.equal(rig.logoutCalls.length, 0);
    await assertLabelRemoved(rig);
    await assertNoSecrets(rig, result);
  });
}

test('unreadable credentials after the login and a failed removal say account unverified (remove failed)', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = 'unreadable';
  const result = await rig.run({ configFileOps: rig.failingOps });
  assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.unverified, RELOGIN_MARK.removeFailed), RELOGIN_REMOVE_FAILED_LINE]);
  assert.equal(rig.logoutCalls.length, 0);
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
});

test('a login child that exits non-zero after writing a different account is handled like a finished one', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = ACCOUNT_C;
  rig.loginChild = () => fakeChild({ code: 1 });
  const result = await rig.run();
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed), RELOGIN_REMOVED_LINE]);
  assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
  await assertLabelRemoved(rig);
});

for (const [what, child, writes, reason] of [
  ['exits non-zero', () => fakeChild({ code: 1 }), ACCOUNT_A, LOGIN_FAILURE.childFailed],
  ['ends by a signal', () => fakeChild({ code: null, signal: 'SIGTERM' }), ACCOUNT_A, LOGIN_FAILURE.childSignaled],
  ['cannot be started (start error)', () => fakeChild({ error: true }), null, LOGIN_FAILURE.childNotStarted],
  ['cannot be started (spawn throws)', () => { throw Object.assign(new Error('refused'), { code: 'EACCES' }); }, null, LOGIN_FAILURE.childNotStarted],
]) {
  test(`a login child that ${what} with the same account leaves the config unchanged and shows no success`, async t => {
    const rig = await setupRelogin(t);
    rig.loginWrites = writes;
    rig.loginChild = child;
    const result = await rig.run();
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [reasonLine(reason), CONFIG_UNCHANGED_LINE]);
    assert.ok(!stderrLines(result).includes(RELOGIN_OK_LINE));
    assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
    assert.equal(rig.logoutCalls.length, 0);
    assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
    assert.deepEqual(rig.signals.counts(), SIGNAL_COUNTS(0));
  });
}

test('a login child ended by a signal after writing a different account is compared, and the parent does not signal itself', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = ACCOUNT_C;
  rig.loginChild = () => fakeChild({ code: null, signal: 'SIGTERM' });
  const result = await rig.run();
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed), RELOGIN_REMOVED_LINE]);
  assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
  assert.equal(rig.signals.kills.length, 0);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
  await assertLabelRemoved(rig);
});

test('SIGINT during the login child is forwarded once, signals at the comparison are held, and SIGINT during logout marks it failed', async t => {
  const rig = await setupRelogin(t);
  rig.loginWrites = ACCOUNT_C;
  rig.logout = 'endsOnForwardedSigint';
  rig.loginChild = () => {
    rig.loginChildRef = controllableChild({ endOnKill: true });
    setImmediate(() => {
      rig.seen.exitsAtLoginSignal = rig.exits.length;
      rig.signals.send('SIGINT');
    });
    return rig.loginChildRef;
  };
  let homeReads = 0;
  const readCredentials = async path => {
    // 1回目は login の前、2回目が login の後に比べる時点の読取。
    if (path === rig.authPath && ++homeReads === 2) {
      rig.seen.countsAtCompare = rig.signals.counts();
      const forwardedBefore = rig.loginChildRef.kills.length;
      for (const name of RELOGIN_SIGNALS) rig.signals.send(name);
      rig.seen.exitsAtCompare = rig.exits.length;
      rig.seen.forwardedAtCompare = rig.loginChildRef.kills.length - forwardedBefore;
    }
    return readCodexCredentials(path);
  };
  const result = await rig.run({ readCredentials });
  // 受け口は差し替えた spawn の呼出しより先に1つずつ付いた。
  assert.deepEqual(rig.listenersAtLoginSpawn, SIGNAL_COUNTS(1));
  // login の子の実行中の SIGINT: 親は終わらず、子へ1回だけ送り、子はそれで終わった。
  assert.equal(rig.seen.exitsAtLoginSignal, 0);
  assert.deepEqual(rig.loginChildRef.kills, ['SIGINT']);
  // 比べる時点の4つのシグナル: 受け口は付いたままで、終了の関数も子への転送も呼ばれない。
  assert.equal(homeReads, 2);
  assert.deepEqual(rig.seen.countsAtCompare, SIGNAL_COUNTS(1));
  assert.equal(rig.seen.exitsAtCompare, 0);
  assert.equal(rig.seen.forwardedAtCompare, 0);
  // logout の子の実行中の SIGINT: 親は終わらず、logout の子へ1回送り、logout は失敗になる。
  assert.equal(rig.seen.exitsAtLogoutSignal, 0);
  assert.deepEqual(rig.logoutChildRef.kills, ['SIGINT']);
  assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed, RELOGIN_MARK.logoutFailed), RELOGIN_REMOVED_LINE]);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
  // 自分へシグナルを当て直さず、足した受け口は残らない。
  assert.equal(rig.signals.kills.length, 0);
  assert.deepEqual(rig.signals.counts(), SIGNAL_COUNTS(0));
  assert.equal(rig.signals.added.length, RELOGIN_SIGNALS.length);
  assert.equal(rig.signals.removed.length, RELOGIN_SIGNALS.length);
  await assertLabelRemoved(rig);
});

for (const name of ['SIGQUIT', 'SIGHUP', 'SIGTERM']) {
  test(`${name} during the login child is forwarded once under the same name and the result is still compared`, async t => {
    const rig = await setupRelogin(t);
    rig.loginWrites = ACCOUNT_C;
    rig.loginChild = () => {
      rig.loginChildRef = controllableChild({ endOnKill: true });
      setImmediate(() => {
        rig.seen.exitsAtSignal = rig.exits.length;
        rig.signals.send(name);
      });
      return rig.loginChildRef;
    };
    const result = await rig.run();
    assert.equal(rig.seen.exitsAtSignal, 0);
    assert.deepEqual(rig.loginChildRef.kills, [name]);
    assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
    assert.deepEqual(stderrLines(result), [wordLine(RELOGIN_WORD.changed), RELOGIN_REMOVED_LINE]);
    assert.deepEqual(rig.events, ['spawn login', 'config rename', 'spawn logout']);
    assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
    assert.equal(rig.signals.kills.length, 0);
    assert.deepEqual(rig.signals.counts(), SIGNAL_COUNTS(0));
    await assertLabelRemoved(rig);
  });
}

test('relogin refuses a CODEX_HOME that points at the registered account folder, with no child and no signal receiver', async t => {
  const rig = await setupRelogin(t);
  const result = await rig.run({}, undefined, { ...rig.ctx.env, CODEX_HOME: rig.home });
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [reasonLine(LOGIN_FAILURE.codexHomeOverlaps), CONFIG_UNCHANGED_LINE]);
  assert.equal(rig.ctx.iso.spawnCalls.length, 0);
  assert.equal(rig.signals.added.length, 0);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
  assert.deepEqual(await listOrNull(rig.ctx.accountsDir), rig.foldersBefore);
  assert.ok(!result.stderr.includes(rig.home));
});

test('relogin without a Codex CLI to be found starts no child, adds no signal receiver and leaves the config unchanged', async t => {
  const rig = await setupRelogin(t);
  const emptyBin = join(rig.ctx.iso.root, 'no-codex-bin');
  await mkdir(emptyBin, { mode: 0o700 });
  const result = await rig.run({}, undefined, { ...rig.ctx.env, PATH: emptyBin });
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [reasonLine(LOGIN_FAILURE.codexMissing), CONFIG_UNCHANGED_LINE]);
  assert.equal(rig.ctx.iso.spawnCalls.length, 0);
  assert.equal(rig.signals.added.length, 0);
  assert.deepEqual(rig.exits, [LOGIN_EXIT.failed]);
  assert.deepEqual(await fileState(rig.ctx.configPath), rig.configBefore);
});

// ---------------------------------------------------------------------------------------------
// 新規の login のシグナルの受け口と、起動した後の 'error'
// ---------------------------------------------------------------------------------------------

test('SIGINT during the login child of a new login is forwarded once, and the login ends with the config unchanged and the folder left', async t => {
  const ctx = await setup(t);
  const before = await withOneAccount(ctx);
  const signals = fakeSignals();
  const processListeners = RELOGIN_SIGNALS.map(name => process.listenerCount(name));
  const seen = {};
  ctx.behave = (args, options) => {
    seen.listenersAtSpawn = signals.counts();
    ctx.writeCredentials(options, ACCOUNT_B);
    seen.child = controllableChild({ endOnKill: true });
    setImmediate(() => signals.send('SIGINT'));
    return seen.child;
  };
  const result = await ctx.run(['--label', 'second', '--stop', '90', '--resume', '50'], { signals });
  // 受け口は子の起動より先に1つずつ付き、子の実行中の SIGINT は子へ1回だけ送られた。
  assert.deepEqual(seen.listenersAtSpawn, SIGNAL_COUNTS(1));
  assert.deepEqual(seen.child.kills, ['SIGINT']);
  assert.equal(result.code, LOGIN_EXIT.failed, result.stderr);
  assert.deepEqual(stderrLines(result), [reasonLine(LOGIN_FAILURE.childSignaled), CONFIG_UNCHANGED_LINE, FOLDER_LEFT_LINE]);
  // 自分へシグナルを当て直さず、足した受け口は残らない。テストの実行器にも付けていない。
  assert.equal(signals.kills.length, 0);
  assert.deepEqual(signals.counts(), SIGNAL_COUNTS(0));
  assert.equal(signals.added.length, RELOGIN_SIGNALS.length);
  assert.equal(signals.removed.length, RELOGIN_SIGNALS.length);
  assert.deepEqual(RELOGIN_SIGNALS.map(name => process.listenerCount(name)), processListeners);
  assert.deepEqual(await fileState(ctx.configPath), before.config);
  assert.equal((await readdir(ctx.accountsDir)).length, before.folders.length + 1);
});

test('a new login keeps the signal receivers until the end, and signals after the login child ended are not forwarded', async t => {
  const ctx = await setup(t);
  const signals = fakeSignals();
  const seen = {};
  ctx.behave = (args, options) => {
    seen.listenersAtSpawn = signals.counts();
    ctx.writeCredentials(options);
    seen.child = controllableChild();
    setImmediate(() => seen.child.emit('exit', 0, null));
    return seen.child;
  };
  // login の後に新しいフォルダの資格情報を読む時点で、4つのシグナルを送る。
  const readCredentials = async path => {
    if (seen.child && seen.countsAfterChild === undefined && path.startsWith(`${ctx.accountsDir}${sep}`)) {
      seen.countsAfterChild = signals.counts();
      for (const name of RELOGIN_SIGNALS) signals.send(name);
    }
    return readCodexCredentials(path);
  };
  const result = await ctx.run(ARGS_A, { signals, readCredentials });
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.deepEqual(stderrLines(result), [REGISTERED_LINE, CONFIG_CREATED_LINE, RELOAD_HINT_LINE]);
  assert.deepEqual(seen.listenersAtSpawn, SIGNAL_COUNTS(1));
  assert.deepEqual(seen.countsAfterChild, SIGNAL_COUNTS(1));
  assert.deepEqual(seen.child.kills, []);
  assert.equal(signals.kills.length, 0);
  assert.deepEqual(signals.counts(), SIGNAL_COUNTS(0));
});

test('a new login has the signal receivers while making the account folder, and removes them all when the folder cannot be made', async t => {
  const ctx = await setup(t);
  const signals = fakeSignals();
  const seen = {};
  const accountDirFileOps = {
    mkdir: async (path, options) => {
      if (path.startsWith(`${ctx.accountsDir}${sep}`)) {
        seen.countsAtMkdir = signals.counts();
        throw Object.assign(new Error('zz-mkdir-refused'), { code: 'EACCES' });
      }
      return fsPromises.mkdir(path, options);
    },
  };
  const result = await ctx.run(ARGS_A, { signals, accountDirFileOps });
  assertFailedUnchanged(result, { folderLeft: false });
  assert.deepEqual(stderrLines(result), [reasonLine('the new account folder could not be created'), CONFIG_UNCHANGED_LINE]);
  assert.deepEqual(seen.countsAtMkdir, SIGNAL_COUNTS(1));
  assert.equal(ctx.iso.spawnCalls.length, 0);
  assert.equal(signals.kills.length, 0);
  assert.deepEqual(signals.counts(), SIGNAL_COUNTS(0));
  assert.equal(signals.added.length, RELOGIN_SIGNALS.length);
  assert.equal(signals.removed.length, RELOGIN_SIGNALS.length);
  assert.equal(await fileState(ctx.configPath), null);
});

// 起動した（pid のある）偽の子。'error' を errors 回出した後で、code で終わる。
function startedChildWithErrors({ errors, code }) {
  const child = new EventEmitter();
  child.pid = 424243;
  child.kill = () => true;
  setImmediate(() => {
    for (let count = 0; count < errors; count++) {
      child.emit('error', Object.assign(new Error('zz-error-after-start'), { code: 'EPERM' }));
    }
    setImmediate(() => child.emit('exit', code, null));
  });
  return child;
}

test('an error after the login child started does not end the wait, and the exit decides the result', async t => {
  const ctx = await setup(t, {
    behave: (args, options) => {
      ctx.writeCredentials(options);
      return startedChildWithErrors({ errors: 1, code: 0 });
    },
  });
  const result = await ctx.run(ARGS_A);
  assert.equal(result.code, LOGIN_EXIT.ok, result.stderr);
  assert.deepEqual(stderrLines(result), [REGISTERED_LINE, CONFIG_CREATED_LINE, RELOAD_HINT_LINE]);
});

test('two errors after the login child started do not bring the parent down, and a non-zero exit is reported as a failed login', async t => {
  const ctx = await setup(t, {
    behave: (args, options) => {
      ctx.writeCredentials(options);
      return startedChildWithErrors({ errors: 2, code: 1 });
    },
  });
  const result = await ctx.run(ARGS_A);
  assertFailedUnchanged(result, { folderLeft: true });
  assert.deepEqual(stderrLines(result), [reasonLine(LOGIN_FAILURE.childFailed), CONFIG_UNCHANGED_LINE, FOLDER_LEFT_LINE]);
  assert.equal(await fileState(ctx.configPath), null);
});

test('the guidance lines name the next commands, including reload, and carry no path or value', () => {
  assert.match(RELOAD_HINT_LINE, /"codex-rotator reload"/);
  assert.match(RELOGIN_REMOVED_LINE, /"codex-rotator login --label <label> --stop <percent> --resume <percent>"/);
  assert.match(RELOGIN_REMOVED_LINE, /"codex-rotator purge"/);
  assert.match(RELOGIN_REMOVED_LINE, /"codex-rotator reload"/);
  assert.match(RELOGIN_REMOVE_FAILED_LINE, /set "enabled" to false/);
  assert.match(RELOGIN_REMOVE_FAILED_LINE, /"codex-rotator remove --label <label>"/);
  assert.match(RELOGIN_REMOVE_FAILED_LINE, /"codex-rotator reload"/);
  assert.match(RELOGIN_UNVERIFIED_BEFORE_LINE, /"codex-rotator remove --label <label>"/);
  // 2つのゲートは、README の多口座のリスクの節を読んでから手で真にする。
  assert.match(CONFIG_CREATED_LINE, /README/);
  assert.match(CONFIG_CREATED_LINE, /risks of using several accounts/);
  assert.match(CONFIG_CREATED_LINE, /by hand/);
  // 資格情報が読めない口座には、login し直しではなく、登録を外してから新しいフォルダで入り直す手順を
  // 案内する（login し直しは前の資格情報が読めないと始めないため）。
  assert.equal(UNREADABLE_ACCOUNTS_LINE_START, 'codex-rotator login: registered accounts whose credentials cannot be read: ');
  // 読めない口座が2つ以上でも通るように、並べた口座をすべて外してから入り直す順を案内する（1つずつ
  // 外して入り直すと、まだ外していない読めない口座で次の login が止まるため）。
  assert.equal(OTHER_CREDENTIALS_HINT_LINE, 'codex-rotator login: first run "codex-rotator remove --label <label>" for every account listed above;'
    + ' only after all of them are removed, log in to each one again with'
    + ' "codex-rotator login --label <label> --stop <percent> --resume <percent>" (a new folder is made).');
  assert.doesNotMatch(OTHER_CREDENTIALS_HINT_LINE, /--relogin/);
  // 2つの案内に共通する部分（外すコマンドと、新しいフォルダで入り直すコマンド）がどちらにもあり、
  // どちらでも外すコマンドが入り直すコマンドより前にある。
  const removeStep = '"codex-rotator remove --label <label>"';
  const loginStep = '"codex-rotator login --label <label> --stop <percent> --resume <percent>" (a new folder is made).';
  for (const line of [OTHER_CREDENTIALS_HINT_LINE, RELOGIN_UNVERIFIED_BEFORE_LINE]) {
    assert.ok(line.includes(removeStep), line);
    assert.ok(line.includes(loginStep), line);
    assert.ok(line.indexOf(removeStep) < line.indexOf(loginStep), `remove comes before the new login: ${line}`);
  }
  for (const line of [
    RELOAD_HINT_LINE, RELOGIN_REMOVED_LINE, RELOGIN_REMOVE_FAILED_LINE, RELOGIN_UNVERIFIED_BEFORE_LINE, RELOGIN_OK_LINE,
    CONFIG_CREATED_LINE, OTHER_CREDENTIALS_HINT_LINE,
  ]) {
    assert.equal(line.includes('\n'), false);
    assert.doesNotMatch(line, /\/(?:Users|home|tmp)\b|\.codex-accounts|auth\.json/);
  }
});

// 初回の作成の案内が指す節の名前は、案内の定数から取る（案内の文を変えたら README の見出しも合わせる）。
// README はリポジトリの根のものを、このファイルの場所から読む（テストの作業フォルダに依らない）。
test('the README has the section that the first login message points to', () => {
  const phrase = /README section on the (.+?), and only then /.exec(CONFIG_CREATED_LINE)?.[1];
  assert.ok(phrase, 'the first login message names a README section');
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const englishStart = readme.indexOf('\n## English\n');
  assert.ok(englishStart > 0, 'the README has the English body');
  const headings = text => text.split('\n').filter(line => /^#{2,6} /.test(line));
  const english = headings(readme.slice(englishStart));
  const japanese = headings(readme.slice(0, englishStart));
  assert.ok(english.some(line => line.includes(phrase)), `an English heading contains "${phrase}"`);
  assert.ok(japanese.includes('### 複数の口座を使うリスク'), 'the Japanese body has the matching heading');
});

// ---------------------------------------------------------------------------------------------
// テスト隔離の仕掛けが、login の起動の経路で絶対パスの codex を拒否する（隔離の補助の外）
// ---------------------------------------------------------------------------------------------

test('the test guard refuses the absolute-path codex that login starts, and the stand-in never runs', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-rotator-login-guard-')));
  const savedLog = process.env[SERVICE_COMMAND_LOG_ENV];
  const logPath = join(root, 'service-command.log');
  process.env[SERVICE_COMMAND_LOG_ENV] = logPath;
  t.after(async () => {
    if (savedLog === undefined) delete process.env[SERVICE_COMMAND_LOG_ENV];
    else process.env[SERVICE_COMMAND_LOG_ENV] = savedLog;
    await rm(root, { recursive: true, force: true });
  });
  const home = join(root, 'home');
  const fakeBin = join(root, 'deep', 'tools', 'bin');
  for (const dir of [home, join(root, 'xdg', 'config'), join(root, 'xdg', 'data'), join(root, 'xdg', 'state'), fakeBin]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const codexPath = join(fakeBin, 'codex');
  await writeFile(codexPath, HARMLESS_SCRIPT, { mode: 0o755 });
  await chmod(codexPath, 0o755);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg', 'config'),
    XDG_DATA_HOME: join(root, 'xdg', 'data'),
    XDG_STATE_HOME: join(root, 'xdg', 'state'),
    PATH: fakeBin,
  };
  const stdout = captureStream();
  const stderr = captureStream();
  // spawn は差し替えない（既定の spawn を使う）。シグナルの受け口だけは偽物を渡す（テストの実行器の
  // プロセスに受け口を付けない）。
  const code = await runLogin(ARGS_A, { stdout, stderr, env }, { signals: fakeSignals() });
  const lines = stderr.text().split('\n').filter(Boolean);
  assert.equal(code, LOGIN_EXIT.failed, stderr.text());
  assert.ok(lines.includes(`codex-rotator login: ${LOGIN_FAILURE.childNotStarted}.`), stderr.text());
  assert.ok(lines.includes(CONFIG_UNCHANGED_LINE));
  // 偽の実行ファイルは実行されていない（実行されれば同じフォルダに印のファイルを作る）。
  assert.equal(await listOrNull(fakeBin).then(list => list.includes('ran')), false);
  // 仕掛けの記録に、拒否した codex の起動が残る。
  const log = await readFile(logPath, 'utf8');
  const refused = log.split('\n').filter(line => line.startsWith(`${codexPath} `) && line.endsWith(' login'));
  assert.equal(refused.length, 1, log);
  assert.equal(await fileState(join(env.XDG_CONFIG_HOME, 'codex-rotator', 'config.json')), null);
});
