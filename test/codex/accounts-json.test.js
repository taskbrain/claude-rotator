// `codex-rotator accounts`（src/codex/accounts-json.js）のテスト。
//
// 絶対条件: 実のホーム・実の設定ファイル・実の口座のフォルダには触れない。env は隔離の補助の一時
// フォルダのもので、設定ファイル・口座のフォルダ・偽の資格情報はすべてその中に作る。子プロセスは
// 起動しない。偽の資格情報の中身（トークンの形・メールアドレスの形・目印）は合成の値である。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises, { chmod, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNTS_JSON_ACCOUNT_KEYS,
  ACCOUNTS_JSON_KEYS,
  ACCOUNTS_JSON_KIND,
  ACCOUNTS_JSON_SCHEMA_VERSION,
  ACCOUNTS_USAGE,
  NO_CONFIG_LINE,
  REGISTRATION,
  buildAccountsJson,
  formatAccountsText,
  formatGeneratedAt,
  runAccounts,
} from '../../src/codex/accounts-json.js';
import { main } from '../../src/codex/cli.js';
import { CODEX_ACCOUNT_LABEL, loadCodexConfig } from '../../src/codex/config.js';
import { readCodexCredentials } from '../../src/codex/credentials.js';
import { codexRotatorConfigDir, codexRotatorConfigPath, controlTokenPath } from '../../src/codex/paths.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'codex', 'accounts-json.js');

// 固定のスキーマ（キーの一覧と順）。モジュールの定数がこれと同じであることを1本目のテストで固定する。
const PINNED_TOP_KEYS = ['schemaVersion', 'kind', 'generatedAt', 'enabled', 'accountsDir', 'accounts'];
const PINNED_ACCOUNT_KEYS = ['label', 'codexHome', 'registration'];

// パスに含める合成の目印（パスが出てよいのは `--json` の標準出力だけ）。
const PATH_MARKER = 'ZZ-PATH-MARKER';
// 偽の資格情報に入れる合成の値。
const TOKEN_MARKER = 'ZZTOKENMARKER'.repeat(3);
const FAKE_ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.eyJ6eiI6InRva2VuIn0.${'Z'.repeat(24)}`;
const FAKE_REFRESH_TOKEN = `rt_zz_fake_${'9'.repeat(32)}`;
const FAKE_EMAIL = 'zz-fake-user@example.invalid';
const SECRET_VALUES = Object.freeze([TOKEN_MARKER, FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, FAKE_EMAIL]);

// 固定の時計（2026-01-02T03:04:05.678Z）。
const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const FIXED_GENERATED_AT = '2026-01-02T03:04:05Z';

const policy = () => ({ stopUsedPercent: 75, resumeUsedPercent: 70 });

// 固定のスキーマの検査関数。通らなければ assert が落ちる。
function assertAccountsJsonSchema(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'the output is an object');
  assert.deepEqual(Object.keys(value), PINNED_TOP_KEYS, 'the top-level keys and their order are fixed');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, 'codex-rotator-accounts');
  assert.match(value.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(new Date(value.generatedAt).toISOString().replace('.000Z', 'Z'), value.generatedAt, 'generatedAt is a real UTC time');
  assert.equal(typeof value.enabled, 'boolean');
  if (value.accountsDir !== null) {
    assert.equal(typeof value.accountsDir, 'string');
    assert.ok(isAbsolute(value.accountsDir) && !value.accountsDir.endsWith('/'), 'accountsDir is absolute without a trailing /');
  }
  assert.ok(Array.isArray(value.accounts));
  for (const account of value.accounts) {
    assert.deepEqual(Object.keys(account), PINNED_ACCOUNT_KEYS, 'the account keys and their order are fixed');
    assert.equal(typeof account.label, 'string');
    assert.match(account.label, CODEX_ACCOUNT_LABEL);
    assert.equal(typeof account.codexHome, 'string');
    assert.ok(isAbsolute(account.codexHome) && !account.codexHome.endsWith('/'), 'codexHome is absolute without a trailing /');
    assert.ok(['active', 'stopped'].includes(account.registration));
  }
}

function captureStream() {
  const chunks = [];
  return { chunks, write(chunk) { chunks.push(String(chunk)); return true; }, text() { return chunks.join(''); } };
}

// 隔離の一時フォルダに設定と口座のフォルダを作る部品と、runAccounts を呼ぶ部品を返す。
async function fixture(t, { accountsDirName = 'zz-accounts' } = {}) {
  const isolation = await setupCodexIsolation(t);
  const { env, home } = isolation;
  const accountsDir = join(home, accountsDirName);
  const configPath = codexRotatorConfigPath(env);

  const writeConfig = async raw => {
    const folder = codexRotatorConfigDir(env);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700);
    await writeFile(configPath, typeof raw === 'string' ? raw : JSON.stringify(raw), { mode: 0o600 });
    await chmod(configPath, 0o600);
  };
  const account = (label, overrides = {}) => ({ label, codexHome: join(accountsDir, label), usagePolicy: policy(), ...overrides });

  const run = async (argv, deps = {}) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runAccounts(argv, { stdout, stderr, env }, { now: () => FIXED_NOW_MS, ...deps });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  const runJson = async (deps = {}) => {
    const result = await run(['--json'], deps);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '', 'nothing on stderr on success');
    return { ...result, json: JSON.parse(result.stdout) };
  };
  return { isolation, env, home, accountsDir, configPath, writeConfig, account, run, runJson };
}

// 口座のフォルダ（0700）と、その中の偽の資格情報のファイルを作る。
async function placeFakeCredentials(accountsDir, label) {
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  await chmod(accountsDir, 0o700);
  const folder = join(accountsDir, label);
  await mkdir(folder, { mode: 0o700 });
  const auth = {
    zz_note: TOKEN_MARKER,
    tokens: { access_token: FAKE_ACCESS_TOKEN, refresh_token: FAKE_REFRESH_TOKEN, id_token: FAKE_ACCESS_TOKEN, account_id: TOKEN_MARKER },
    email: FAKE_EMAIL,
  };
  await writeFile(join(folder, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
  await writeFile(join(folder, 'config.toml'), `cli_auth_credentials_store = "file"\n# ${TOKEN_MARKER}\n`, { mode: 0o600 });
}

function assertNoOutsideContact(isolation) {
  assert.deepEqual(isolation.fetchCalls, [], 'no upstream fetch');
  assert.deepEqual(isolation.refusedRequests, [], 'no request to the daemon');
  assert.deepEqual(isolation.connections, [], 'no socket connection');
  assert.deepEqual(isolation.refusedConnections, [], 'no socket connection attempt');
  assert.deepEqual(isolation.spawnCalls, [], 'no child process through the injected spawn');
  assert.deepEqual(isolation.refusedChildProcesses, [], 'no child_process call');
}

// ---------------------------------------------------------------------------
// 固定のスキーマ
// ---------------------------------------------------------------------------

test('accounts: the schema constants pin the key list, the key order, schemaVersion 1 and the kind', () => {
  assert.deepEqual([...ACCOUNTS_JSON_KEYS], PINNED_TOP_KEYS);
  assert.deepEqual([...ACCOUNTS_JSON_ACCOUNT_KEYS], PINNED_ACCOUNT_KEYS);
  assert.ok(Object.isFrozen(ACCOUNTS_JSON_KEYS) && Object.isFrozen(ACCOUNTS_JSON_ACCOUNT_KEYS));
  assert.equal(ACCOUNTS_JSON_SCHEMA_VERSION, 1);
  assert.equal(ACCOUNTS_JSON_KIND, 'codex-rotator-accounts');
  assert.deepEqual({ ...REGISTRATION }, { active: 'active', stopped: 'stopped' });
});

test('accounts: generatedAt is UTC YYYY-MM-DDTHH:MM:SSZ without milliseconds', () => {
  assert.equal(formatGeneratedAt(FIXED_NOW_MS), FIXED_GENERATED_AT);
  assert.equal(formatGeneratedAt(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '2026-12-31T23:59:59Z');
  assert.equal(formatGeneratedAt(Date.UTC(2026, 0, 1, 0, 0, 0, 0)), '2026-01-01T00:00:00Z');
});

test('accounts --json: without a config file it prints enabled false, accountsDir null and no accounts, and exits 0', async t => {
  const f = await fixture(t);
  const { json, stdout } = await f.runJson();
  assertAccountsJsonSchema(json);
  assert.deepEqual(json, {
    schemaVersion: 1, kind: 'codex-rotator-accounts', generatedAt: FIXED_GENERATED_AT,
    enabled: false, accountsDir: null, accounts: [],
  });
  assert.equal(stdout, `${JSON.stringify(json)}\n`, 'stdout is exactly one JSON line');
  assertNoOutsideContact(f.isolation);
});

test('accounts --json: zero accounts with the default accountsDir expanded from ~', async t => {
  const f = await fixture(t);
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true });
  const { json } = await f.runJson();
  assertAccountsJsonSchema(json);
  assert.deepEqual(json, {
    schemaVersion: 1, kind: 'codex-rotator-accounts', generatedAt: FIXED_GENERATED_AT,
    enabled: true, accountsDir: join(f.home, '.codex-accounts'), accounts: [],
  });
});

test('accounts --json: one account, with ~ expanded in accountsDir and the trailing / removed from both paths', async t => {
  const f = await fixture(t);
  await f.writeConfig({
    enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: '~/zz-accounts/',
    accounts: [{ label: 'zz-one', codexHome: `${join(f.home, 'zz-accounts', 'zz-one')}/`, usagePolicy: policy() }],
  });
  const { json } = await f.runJson();
  assertAccountsJsonSchema(json);
  assert.equal(json.accountsDir, join(f.home, 'zz-accounts'));
  assert.deepEqual(json.accounts, [{ label: 'zz-one', codexHome: join(f.home, 'zz-accounts', 'zz-one'), registration: 'active' }]);
});

test('accounts --json: three accounts keep the config order, and extra config and account keys do not appear', async t => {
  const f = await fixture(t);
  await f.writeConfig({
    enabled: true,
    acknowledgedMultiAccountRisk: true,
    accountsDir: f.accountsDir,
    daemon: { port: 0 },
    usagePollIntervalMs: 60000,
    accounts: [
      f.account('zz-c', { usagePolicy: { stopUsedPercent: 90, resumeUsedPercent: 10, blockWhenUnknown: true } }),
      f.account('zz-a'),
      f.account('zz-b'),
    ],
  });
  const { json, stdout } = await f.runJson();
  assertAccountsJsonSchema(json);
  assert.deepEqual(json.accounts.map(({ label }) => label), ['zz-c', 'zz-a', 'zz-b']);
  assert.deepEqual(json.accounts.map(({ codexHome }) => codexHome), ['zz-c', 'zz-a', 'zz-b'].map(label => join(f.accountsDir, label)));
  assert.ok(json.accounts.every(({ registration }) => registration === 'active'));
  for (const word of ['usagePolicy', 'stopUsedPercent', 'resumeUsedPercent', 'blockWhenUnknown', 'daemon', 'usagePollIntervalMs', 'acknowledgedMultiAccountRisk']) {
    assert.equal(stdout.includes(word), false, `the output has no ${word}`);
  }
});

test('accounts --json: registration is active only when both enabled and the multi-account risk acknowledgement are true', async t => {
  const f = await fixture(t);
  const cases = [
    [true, true, 'active'],
    [true, false, 'stopped'],
    [false, true, 'stopped'],
    [false, false, 'stopped'],
  ];
  for (const [enabled, acknowledgedMultiAccountRisk, expected] of cases) {
    await f.writeConfig({ enabled, acknowledgedMultiAccountRisk, accountsDir: f.accountsDir, accounts: [f.account('zz-one'), f.account('zz-two')] });
    const { json } = await f.runJson();
    assertAccountsJsonSchema(json);
    assert.equal(json.enabled, enabled, 'enabled mirrors the config');
    assert.deepEqual(json.accounts.map(({ registration }) => registration), [expected, expected],
      `enabled=${enabled} acknowledged=${acknowledgedMultiAccountRisk}`);
  }
});

test('accounts --json: omitted gates are read as false (enabled false and every account stopped)', async t => {
  const f = await fixture(t);
  await f.writeConfig({ accountsDir: f.accountsDir, accounts: [f.account('zz-one')] });
  const { json } = await f.runJson();
  assertAccountsJsonSchema(json);
  assert.equal(json.enabled, false);
  assert.deepEqual(json.accounts, [{ label: 'zz-one', codexHome: join(f.accountsDir, 'zz-one'), registration: 'stopped' }]);
});

test('accounts --json: stdout carries only the JSON, and the default clock gives the current UTC second', async t => {
  const f = await fixture(t);
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: f.accountsDir, accounts: [f.account('zz-one')] });
  const stdout = captureStream();
  const stderr = captureStream();
  const before = Math.floor(Date.now() / 1000) * 1000;
  const code = await runAccounts(['--json'], { stdout, stderr, env: f.env });
  const after = Date.now();
  assert.equal(code, 0);
  assert.equal(stderr.text(), '');
  assert.equal(stdout.chunks.length, 1, 'one write');
  assert.ok(stdout.text().endsWith('}\n') && stdout.text().split('\n').length === 2, 'one line and one newline');
  const json = JSON.parse(stdout.text());
  assertAccountsJsonSchema(json);
  const at = Date.parse(json.generatedAt);
  assert.ok(at >= before && at <= after, 'generatedAt is the time of the call');
});

// ---------------------------------------------------------------------------
// 設定が検証を通らないとき
// ---------------------------------------------------------------------------

test('accounts: an invalid config prints no JSON, exits non-zero and gives the reason on stderr without values', async t => {
  const f = await fixture(t, { accountsDirName: `zz-accounts-${PATH_MARKER}` });
  const cases = [
    ['an unknown key', { enabled: true, zzUnknown: PATH_MARKER }, /unknown key: zzUnknown/],
    ['an account without usagePolicy', { accountsDir: f.accountsDir, accounts: [{ label: 'zz-one', codexHome: join(f.accountsDir, 'zz-one') }] }, /usagePolicy is required/],
    ['a relative codexHome', { accounts: [{ label: 'zz-one', codexHome: `zz/${PATH_MARKER}`, usagePolicy: policy() }] }, /codexHome must be an absolute path/],
    ['a duplicated label', { accountsDir: f.accountsDir, accounts: [f.account('zz-one'), f.account('zz-one', { codexHome: join(f.accountsDir, 'zz-two') })] }, /label is used by another account/],
    ['not JSON', `{"accountsDir": "${PATH_MARKER}"`, /not valid JSON/],
  ];
  for (const [what, raw, reason] of cases) {
    await f.writeConfig(raw);
    for (const argv of [['--json'], []]) {
      const result = await f.run(argv);
      assert.equal(result.code, 1, `${what}: exits 1`);
      assert.equal(result.stdout, '', `${what}: nothing on stdout`);
      assert.match(result.stderr, /^codex-rotator accounts: .+\n$/, `${what}: one reason line`);
      assert.match(result.stderr, reason, what);
      assert.equal(result.stderr.includes(PATH_MARKER), false, `${what}: the reason has no value or path`);
    }
  }
});

test('accounts: a config file readable by others is refused like any invalid config', async t => {
  const f = await fixture(t);
  await f.writeConfig({ enabled: false });
  await chmod(f.configPath, 0o644);
  const result = await f.run(['--json']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^codex-rotator accounts: .+\n$/);
  assert.equal(result.stderr.includes(f.configPath), false, 'the reason has no path');
});

test('accounts: an unexpected error from the loader is reported with a fixed sentence, not its message', async t => {
  const f = await fixture(t);
  const loadConfig = async () => { throw Object.assign(new Error(`EACCES: ${PATH_MARKER}`), { code: 'EACCES' }); };
  for (const argv of [['--json'], []]) {
    const result = await f.run(argv, { loadConfig });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'codex-rotator accounts: the codex-rotator config file could not be read\n');
  }
});

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

test('accounts: arguments other than none or a single --json print the usage line and exit 2 without reading the config', async t => {
  const f = await fixture(t);
  let loads = 0;
  const loadConfig = async () => { loads++; return null; };
  for (const argv of [['--jsn'], ['-j'], ['json'], ['--json', '--json'], ['--json', 'zz-extra'], ['--json='], ['zz-label']]) {
    const result = await f.run(argv, { loadConfig });
    assert.equal(result.code, 2, JSON.stringify(argv));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${ACCOUNTS_USAGE}\n`);
  }
  assert.equal(loads, 0, 'the config is not read on a usage error');
});

test('accounts: the entry point hands the arguments after the subcommand to runAccounts', async t => {
  const f = await fixture(t);
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: f.accountsDir, accounts: [f.account('zz-one')] });
  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(await main(['accounts', '--json'], { stdout, stderr, env: f.env }), 0);
  assert.equal(stderr.text(), '');
  const json = JSON.parse(stdout.text());
  assertAccountsJsonSchema(json);
  assert.deepEqual(json.accounts, [{ label: 'zz-one', codexHome: join(f.accountsDir, 'zz-one'), registration: 'active' }]);
});

// ---------------------------------------------------------------------------
// 人向けの一覧
// ---------------------------------------------------------------------------

test('accounts (human): lists each label with its registration and the two gates, and no paths', async t => {
  const f = await fixture(t);
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: false, accountsDir: f.accountsDir, accounts: [f.account('zz-one'), f.account('zz-longer-label')] });
  const result = await f.run([]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, [
    'accounts: 2 (enabled: true, multi-account risk acknowledged: false)',
    '  zz-one           stopped',
    '  zz-longer-label  stopped',
    '',
  ].join('\n'));
  assert.equal(result.stdout.includes('/'), false, 'no path separator at all');
});

test('accounts (human): without a config file and with no accounts', async t => {
  const f = await fixture(t);
  const missing = await f.run([]);
  assert.equal(missing.code, 0);
  assert.equal(missing.stdout, `${NO_CONFIG_LINE}\n`);
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true });
  const empty = await f.run([]);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, 'accounts: 0 (enabled: true, multi-account risk acknowledged: true)\n');
});

test('accounts: buildAccountsJson and formatAccountsText read only the label and the folder of each account', () => {
  const config = Object.freeze({
    enabled: true,
    acknowledgedMultiAccountRisk: true,
    accountsDir: '/zz/accounts',
    accounts: [{ label: 'zz-one', codexHome: '/zz/accounts/zz-one', usagePolicy: { stopUsedPercent: 75, resumeUsedPercent: 70 }, zzExtra: PATH_MARKER }],
  });
  const json = buildAccountsJson(config, FIXED_NOW_MS);
  assertAccountsJsonSchema(json);
  assert.equal(JSON.stringify(json).includes(PATH_MARKER), false);
  assert.equal(formatAccountsText(config).includes('/zz/'), false);
});

// ---------------------------------------------------------------------------
// パスが出るのはこの副コマンドの --json だけ
// ---------------------------------------------------------------------------

test('accounts: the path marker appears in --json (positive control) and nowhere in the human list, stderr or a log', async t => {
  const f = await fixture(t, { accountsDirName: `zz-accounts-${PATH_MARKER}` });
  await f.writeConfig({
    enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: f.accountsDir,
    accounts: [f.account('zz-one'), f.account('zz-two'), f.account('zz-three')],
  });
  const json = await f.runJson();
  assert.ok(json.stdout.split(PATH_MARKER).length - 1 >= 4, 'accountsDir and every codexHome carry the marker');
  const human = await f.run([]);
  assert.equal(human.code, 0);
  assert.equal(human.stdout.split(PATH_MARKER).length - 1, 0, 'no marker in the human list');
  assert.equal(`${json.stderr}${human.stderr}`.split(PATH_MARKER).length - 1, 0, 'no marker on stderr');
  assert.deepEqual(await readdir(f.env.XDG_STATE_HOME), [], 'no log file is written');
});

// ---------------------------------------------------------------------------
// 秘密が出ない・資格情報を読まない・外へ出ない
// ---------------------------------------------------------------------------

test('accounts: fake credentials in the account folders never reach the output, and the config loader opens only the config file', async t => {
  const f = await fixture(t);
  await placeFakeCredentials(f.accountsDir, 'zz-one');
  await placeFakeCredentials(f.accountsDir, 'zz-two');
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: f.accountsDir, accounts: [f.account('zz-one'), f.account('zz-two')] });
  await writeFile(controlTokenPath(f.env), JSON.stringify({ token: TOKEN_MARKER }), { mode: 0o600 });

  const opened = [];
  const openImpl = (path, ...rest) => {
    opened.push(String(path));
    return open(path, ...rest);
  };
  let loads = 0;
  const loadConfig = options => {
    loads++;
    return loadCodexConfig({ ...options, openImpl });
  };

  const json = await f.runJson({ loadConfig });
  const human = await f.run([], { loadConfig });
  assert.equal(human.code, 0);
  const everything = [json.stdout, json.stderr, human.stdout, human.stderr].join('\n');
  for (const secret of SECRET_VALUES) {
    assert.equal(everything.split(secret).length - 1, 0, 'no credential value in any output');
  }
  assert.equal(loads, 2, 'one config read per run');
  // 記録するのは設定の読込みに渡した openImpl だけ。資格情報を読まないことは、次のテストの fs の記録で確かめる。
  assert.deepEqual(opened, [f.configPath, f.configPath], 'the config loader opens only the config file');
  assertNoOutsideContact(f.isolation);
});

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

test('accounts and accounts --json open nothing in ~/.codex or in the account folders (fs recorded, with positive controls)', async t => {
  const f = await fixture(t);
  const codexDir = join(f.home, '.codex');
  await mkdir(codexDir, { mode: 0o700 });
  const marker = 'ZZ-PRIMARY-CODEX-MARKER';
  await writeFile(join(codexDir, 'config.toml'), `# ${marker}\nmodel = "zz"\n`, { mode: 0o600 });
  await writeFile(join(codexDir, 'AGENTS.md'), `${marker}\n`, { mode: 0o600 });
  await placeFakeCredentials(f.accountsDir, 'zz-one');
  await placeFakeCredentials(f.accountsDir, 'zz-two');
  await f.writeConfig({ enabled: true, acknowledgedMultiAccountRisk: true, accountsDir: f.accountsDir, accounts: [f.account('zz-one'), f.account('zz-two')] });

  const recorder = recordFileOpens(t);
  const runs = [];
  for (const argv of [['--json'], []]) {
    const start = recorder.calls.length;
    const result = await f.run(argv);
    runs.push({ name: argv.length ? 'accounts --json' : 'accounts', result, calls: recorder.calls.slice(start) });
  }
  // 陽性対照: 同じ記録の中で資格情報の読取の関数を1回呼ぶと、口座のフォルダの中を開いた記録が出る
  // （偽の資格情報は口座の識別子を持たないので、読取は失敗で終わる）。
  const controlStart = recorder.calls.length;
  await readCodexCredentials(join(f.accountsDir, 'zz-one', 'auth.json')).catch(() => null);
  const controlCalls = recorder.calls.slice(controlStart);
  // 陽性対照（一覧）: このテストで作ったフォルダを、同じ記録の中で readdir（名前付きの import）と
  // opendir で一覧すると、どちらも記録に出る。下の「一覧していない」の確かめが空振りでないことを示す。
  const listed = join(f.accountsDir, 'zz-listed-control');
  await mkdir(listed, { mode: 0o700 });
  const listStart = recorder.calls.length;
  await readdir(listed);
  const dir = await fsPromises.opendir(listed);
  await dir.close();
  const listCalls = recorder.calls.slice(listStart);
  recorder.restore();

  // そのフォルダそのもの（一覧する readdir・opendir）と、その中のパスを数える。
  const inside = folder => call => call.path === folder || call.path.startsWith(`${folder}${sep}`);
  for (const { name, result, calls } of runs) {
    assert.equal(result.code, 0, `${name}: ${result.stderr}`);
    assert.deepEqual(calls.filter(inside(codexDir)), [], `${name}: neither ~/.codex nor anything in it is opened, read or listed`);
    assert.deepEqual(calls.filter(inside(f.accountsDir)), [],
      `${name}: neither accountsDir nor the account folders or anything in them are opened, read or listed`);
    assert.ok(calls.some(call => call.path === f.configPath), `${name}: the recorder sees the config file open (positive control)`);
    assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false, `${name}: no marker in the output`);
  }
  const folder = join(f.accountsDir, 'zz-one');
  assert.ok(controlCalls.some(call => call.name === 'open' && call.path === join(folder, 'auth.json')),
    'the recorder sees the credential file open (positive control)');
  assert.ok(controlCalls.some(call => call.name === 'readFile' && call.path === join(folder, 'config.toml')),
    'the recorder sees the account folder config.toml read (positive control)');
  for (const name of ['readdir', 'opendir']) {
    assert.ok(listCalls.some(call => call.name === name && call.path === listed),
      `the recorder sees ${name} list a folder made in this test (positive control)`);
  }
  assert.ok(listCalls.filter(inside(f.accountsDir)).length >= 2, 'the listing control is counted by the same filter as the runs');
  assertNoOutsideContact(f.isolation);
});

test('accounts: the module imports only the config loader (no credential reader, no network, no child process)', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map(match => match[1]);
  assert.deepEqual(specifiers, ['./config.js']);
  assert.equal(/\bimport\s*\(/.test(source), false, 'no dynamic import');
  assert.equal(/\brequire\s*\(/.test(source), false, 'no require');
});

// ---------------------------------------------------------------------------------------------
// README の accounts の節（日英）と、`--json` のスキーマ・出す行の突き合わせ
// ---------------------------------------------------------------------------------------------

// 見出しの行の次から、同じかより上の階層の次の見出しの前までを返す。コードの囲みの中の `#` の行は
// 見出しに数えない。見出しは README の中にちょうど1つあること。
function readmeSection(readme, heading) {
  const lines = readme.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `the README has the heading: ${heading}`);
  assert.equal(lines.lastIndexOf(heading), start, `the heading appears once: ${heading}`);
  const level = heading.indexOf(' ');
  let fenced = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    const match = fenced ? null : /^(#+) /.exec(lines[i]);
    if (match && match[1].length <= level) return lines.slice(start + 1, i).join('\n');
  }
  return lines.slice(start + 1).join('\n');
}

// 節の中の、言語の名前が lang のコードの囲みの中身（囲みの字下げを外し、最後に改行を付けたもの）。
function fencedBlocks(section, lang) {
  const blocks = [];
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)```(\S*)$/.exec(lines[i]);
    if (!open || open[2] !== lang) continue;
    const indent = open[1].length;
    const body = [];
    for (i += 1; i < lines.length && !/^\s*```$/.test(lines[i]); i += 1) body.push(lines[i].slice(indent));
    blocks.push(`${body.join('\n')}\n`);
  }
  return blocks;
}

const README_ACCOUNTS_HEADINGS = Object.freeze([
  '### 口座の一覧（codex-rotator accounts）',
  '#### Listing Accounts (codex-rotator accounts)',
]);

test('accounts: the README sections in Japanese and English match the --json schema keys and the printed lines', async () => {
  // README はリポジトリの根のものを、このファイルの場所から読む（テストの作業フォルダに依らない）。
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  for (const heading of README_ACCOUNTS_HEADINGS) {
    const section = readmeSection(readme, heading);
    // `--json` の例は1つで、キーとその並びがスキーマと同じ。
    const jsonBlocks = fencedBlocks(section, 'json');
    assert.equal(jsonBlocks.length, 1, `${heading}: one --json example`);
    const example = JSON.parse(jsonBlocks[0]);
    assert.deepEqual(Object.keys(example), [...ACCOUNTS_JSON_KEYS], `${heading}: the top-level keys`);
    assert.equal(example.schemaVersion, ACCOUNTS_JSON_SCHEMA_VERSION);
    assert.equal(example.kind, ACCOUNTS_JSON_KIND);
    assert.equal(example.generatedAt, formatGeneratedAt(Date.parse(example.generatedAt)));
    assert.ok(example.accounts.length > 0, `${heading}: the example lists an account`);
    for (const account of example.accounts) {
      assert.deepEqual(Object.keys(account), [...ACCOUNTS_JSON_ACCOUNT_KEYS], `${heading}: the keys of an account`);
      assert.ok(Object.values(REGISTRATION).includes(account.registration), `${heading}: a known registration word`);
    }
    // キーの表は1行に1つの最上位のキーで、スキーマと同じ並び。口座のキーと登録の状態の語も載っている。
    const tableKeys = section.split('\n').map(line => /^\s*\| `([A-Za-z]+)` \|/.exec(line)?.[1]).filter(Boolean);
    assert.deepEqual(tableKeys, [...ACCOUNTS_JSON_KEYS], `${heading}: one table row per top-level key, in order`);
    for (const key of ACCOUNTS_JSON_ACCOUNT_KEYS) assert.ok(section.includes(`\`${key}\``), `${heading}: ${key}`);
    for (const word of Object.values(REGISTRATION)) assert.ok(section.includes(`\`${word}\``), `${heading}: ${word}`);
    // 使い方の1行・設定ファイルが無いときの1行・人向けの一覧の例は、実装が出すものと同じ。
    const textBlocks = fencedBlocks(section, 'text');
    assert.ok(textBlocks.includes(`${ACCOUNTS_USAGE}\n`), `${heading}: the usage line`);
    assert.ok(section.includes(`\`${NO_CONFIG_LINE}\``), `${heading}: the line without a config file`);
    const listing = formatAccountsText({
      enabled: true, acknowledgedMultiAccountRisk: true, accounts: [{ label: 'work' }, { label: 'personal' }],
    });
    assert.ok(textBlocks.includes(listing), `${heading}: the listing example is what the command prints`);
  }
});
