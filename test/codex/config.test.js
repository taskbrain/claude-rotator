// codex-rotator の設定（src/codex/config.js）のテスト。
//
// しきい値の方針・観測の時間・下限検査・範囲と、既定値どうしの整合の件を確かめる。
// 送信の時間予算・再試行の設定は無い（送信経路を持たないため）。
// 絶対条件: 実のホーム・実の設定ファイル・実の ~/.codex には触れない。env は isolation の補助の一時
// フォルダのもの。User-Agent と originator の値は合成の値（製品名の部分を zz-fake- で始める）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  CODEX_CONFIG_DEFAULTS,
  CONFIG_SHA256_PATTERN,
  CodexConfigError,
  DEFAULT_DAEMON_PORT,
  USAGE_ORIGINATOR_MAX_LENGTH,
  USAGE_USER_AGENT_MAX_LENGTH,
  appendCodexAccount,
  canonicalPath,
  comparisonKey,
  configSecretValues,
  isCodexRotatorActivated,
  isValidUsageOriginator,
  isValidUsageUserAgent,
  loadCodexConfig,
  loadCodexConfigSnapshot,
  minimumObservationTtlMs,
  removeCodexAccount,
  validateCodexConfig,
} from '../../src/codex/config.js';
import { codexRotatorConfigPath, shimDir } from '../../src/codex/paths.js';
import { DEFAULT_USAGE_READ_TIMEOUT_MS } from '../../src/codex/usage.js';
import { createCodexLogger } from '../../src/codex/logger.js';
import { DEFAULT_PORT as CLAUDE_DEFAULT_PORT } from '../../src/config.js';
import { setupCodexIsolation } from './helpers/isolation.js';

// OpenAI ブリッジ（設定 openaiBridge）の待受の既定値。常駐の既定値と重ならないことを確かめる。
const BRIDGE_DEFAULT_PORT = 18765;

const policy = (stopUsedPercent = 75, resumeUsedPercent = 70, extra = {}) => ({ stopUsedPercent, resumeUsedPercent, ...extra });

async function setup(t) {
  const isolation = await setupCodexIsolation(t);
  const { env, home } = isolation;
  const accountsDir = join(home, '.codex-accounts');
  const account = (label, overrides = {}) => ({ label, codexHome: join(accountsDir, label), usagePolicy: policy(), ...overrides });
  const validate = raw => validateCodexConfig(raw, { env });
  const refuses = (raw, pattern) => assert.throws(() => validate(raw),
    error => error instanceof CodexConfigError && (pattern === undefined || pattern.test(error.message)),
    `expected a refusal for ${JSON.stringify(raw)}`);
  return { isolation, env, home, accountsDir, account, validate, refuses };
}

// ---------------------------------------------------------------------------
// 既定値と観測の時間
// ---------------------------------------------------------------------------

test('config: an empty config validates and every default is filled in once, here', async t => {
  const { validate, env, home } = await setup(t);
  const config = validate({});
  assert.deepEqual(config, {
    enabled: false,
    acknowledgedMultiAccountRisk: false,
    accountsDir: join(home, '.codex-accounts'),
    daemon: { port: DEFAULT_DAEMON_PORT },
    usagePollIntervalMs: 60000,
    usageReadTimeoutMs: 5000,
    rotationObservationTtlMs: 125000,
    rotationUsageCapNoResetProbeMs: 3600000,
    codexPath: null,
    usageUserAgent: null,
    usageOriginator: null,
    accounts: [],
  });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.daemon) && Object.isFrozen(config.accounts));
  assert.equal(codexRotatorConfigPath(env), join(env.XDG_CONFIG_HOME, 'codex-rotator', 'config.json'));
});

test('config: the minimal config without time keys validates because the defaults satisfy the lower bound', async t => {
  const { validate, account } = await setup(t);
  assert.equal(minimumObservationTtlMs(CODEX_CONFIG_DEFAULTS), CODEX_CONFIG_DEFAULTS.rotationObservationTtlMs);
  assert.equal(CODEX_CONFIG_DEFAULTS.usageReadTimeoutMs, DEFAULT_USAGE_READ_TIMEOUT_MS);
  const config = validate({ enabled: true, acknowledgedMultiAccountRisk: true, accounts: [account('zz-one')] });
  assert.equal(config.rotationObservationTtlMs, 125000);
});

test('config: the observation TTL lower bound (2 x poll interval + read deadline) always applies', async t => {
  const { validate, refuses, account } = await setup(t);
  const accounts = [account('zz-one')];
  refuses({ accounts, rotationObservationTtlMs: 124999 }, /rotationObservationTtlMs must be at least 125000/);
  assert.equal(validate({ accounts, rotationObservationTtlMs: 125000 }).rotationObservationTtlMs, 125000);
  // 下限は取得の間隔と読取の期限から決まる。
  assert.equal(validate({ usagePollIntervalMs: 30000, usageReadTimeoutMs: 1000, rotationObservationTtlMs: 61000 })
    .rotationObservationTtlMs, 61000);
  refuses({ usagePollIntervalMs: 30000, usageReadTimeoutMs: 1000, rotationObservationTtlMs: 60999 }, /at least 61000/);
  // 間隔だけを延ばして有効期限を既定のままにすると、既定の有効期限が下限を割るので拒否する。
  refuses({ usagePollIntervalMs: 120000 }, /at least 245000/);
  refuses({ usageReadTimeoutMs: 6000 }, /at least 126000/);
});

const BAD_INTEGERS = Object.freeze([1.5, '60000', null, true, false, NaN, Infinity, {}, []]);

test('config: the poll interval and the read deadline accept their range only', async t => {
  const { validate, refuses } = await setup(t);
  const roomyTtl = { rotationObservationTtlMs: 86400000 };
  for (const [key, min, max] of [['usagePollIntervalMs', 30000, 3600000], ['usageReadTimeoutMs', 1000, 15000]]) {
    for (const value of [min, max]) assert.equal(validate({ ...roomyTtl, [key]: value })[key], value);
    for (const value of [min - 1, max + 1, ...BAD_INTEGERS]) refuses({ ...roomyTtl, [key]: value }, new RegExp(key));
  }
});

test('config: the observation TTL accepts up to one day and nothing that is not an integer', async t => {
  const { validate, refuses } = await setup(t);
  assert.equal(validate({ rotationObservationTtlMs: 86400000 }).rotationObservationTtlMs, 86400000);
  for (const value of [86400001, 1000, ...BAD_INTEGERS]) refuses({ rotationObservationTtlMs: value }, /rotationObservationTtlMs/);
});

test('config: the no-reset probe is 0 (off) or bounded', async t => {
  const { validate, refuses } = await setup(t);
  for (const value of [0, 60000, 604800000]) {
    assert.equal(validate({ rotationUsageCapNoResetProbeMs: value }).rotationUsageCapNoResetProbeMs, value);
  }
  for (const value of [1, 59999, 604800001, -1, 1.5, '0', null, false]) {
    refuses({ rotationUsageCapNoResetProbeMs: value }, /rotationUsageCapNoResetProbeMs/);
  }
});

// ---------------------------------------------------------------------------
// キーの形
// ---------------------------------------------------------------------------

test('config: unknown keys are refused at the top level, in daemon, in an account and in usagePolicy', async t => {
  const { refuses, account } = await setup(t);
  refuses({ zzUnknown: 1 }, /config has an unknown key: zzUnknown/);
  refuses({ daemon: { port: 1, host: '127.0.0.1' } }, /daemon has an unknown key: host/);
  refuses({ accounts: [account('zz-one', { models: ['zz-model'] })] }, /accounts\[0\] has an unknown key: models/);
  refuses({ accounts: [account('zz-one', { usagePolicy: policy(75, 70, { zzExtra: true }) })] },
    /accounts\[0\]\.usagePolicy has an unknown key: zzExtra/);
  refuses(JSON.parse('{"__proto__": {"enabled": true}}'), /unknown key: __proto__/);
  // Codex 側の設定に無い、送信の時間予算・再試行・ログインのフォルダのキーも、知らないキーとして拒否する。
  for (const key of ['rotationTotalBudgetMs', 'rotationMaxAccountAttemptsPerRequest', 'loginHomeBaseDir']) {
    refuses({ [key]: 1 }, new RegExp(`unknown key: ${key}`));
  }
});

test('config: an unknown key that is not an identifier is not echoed in the message', async t => {
  const { validate } = await setup(t);
  const key = 'zz-dummy@example.invalid';
  assert.throws(() => validate({ [key]: 1 }), error => /\(unprintable\)/.test(error.message) && !error.message.includes(key));
});

test('config: usageObservationMode is refused whatever its value (usage is always read over http)', async t => {
  const { refuses } = await setup(t);
  for (const value of ['http', 'passive', null, '']) refuses({ usageObservationMode: value }, /usageObservationMode is not a setting/);
});

test('config: the config, daemon, an account and usagePolicy must be objects', async t => {
  const { refuses, account } = await setup(t);
  for (const raw of [null, [], 'config', 42]) refuses(raw, /config must be an object/);
  for (const daemon of [null, [], DEFAULT_DAEMON_PORT, 'x']) refuses({ daemon }, /daemon must be an object/);
  for (const entry of [null, [], 'zz-one']) refuses({ accounts: [entry] }, /accounts\[0\] must be an object/);
  for (const accounts of [{}, 'zz-one', null]) refuses({ accounts }, /accounts must be an array/);
  for (const usagePolicy of [null, [], 'policy', 1]) refuses({ accounts: [account('zz-one', { usagePolicy })] }, /usagePolicy must be an object/);
});

// ---------------------------------------------------------------------------
// 有効化の二重ゲートと口座の方針
// ---------------------------------------------------------------------------

test('config: activation needs both enabled and the multi-account acknowledgement to be true', async t => {
  const { validate, account } = await setup(t);
  const accounts = [account('zz-one'), account('zz-two')];
  for (const enabled of [true, false]) {
    for (const acknowledgedMultiAccountRisk of [true, false]) {
      const config = validate({ enabled, acknowledgedMultiAccountRisk, accounts });
      assert.equal(config.enabled, enabled);
      assert.equal(config.acknowledgedMultiAccountRisk, acknowledgedMultiAccountRisk);
      assert.equal(isCodexRotatorActivated(config), enabled && acknowledgedMultiAccountRisk);
    }
  }
  assert.equal(isCodexRotatorActivated(validate({})), false);
});

test('config: the two gate keys accept only true or false', async t => {
  const { refuses } = await setup(t);
  for (const key of ['enabled', 'acknowledgedMultiAccountRisk']) {
    for (const value of ['true', 1, 0, null, {}, []]) refuses({ [key]: value }, new RegExp(`${key} must be true or false`));
  }
});

test('config: usagePolicy is required on every account', async t => {
  const { validate, refuses, account } = await setup(t);
  const withoutPolicy = { label: 'zz-two', codexHome: account('zz-two').codexHome };
  refuses({ accounts: [account('zz-one'), withoutPolicy] }, /accounts\[1\]\.usagePolicy is required/);
  refuses({ accounts: [withoutPolicy] }, /accounts\[0\]\.usagePolicy is required/);
  assert.equal(validate({ accounts: [account('zz-one'), account('zz-two')] }).accounts.length, 2);
});

test('config: a policy needs a positive stop and a strictly lower resume', async t => {
  const { validate, refuses, account } = await setup(t);
  for (const [stop, resume] of [[75, 70], [100, 99], [0.5, 0], [100, 0]]) {
    const [normalized] = validate({ accounts: [account('zz-one', { usagePolicy: policy(stop, resume) })] }).accounts;
    assert.deepEqual(normalized.usagePolicy, { stopUsedPercent: stop, resumeUsedPercent: resume, blockWhenUnknown: false });
  }
  for (const [stop, resume] of [[0, 0], [101, 70], [75, 75], [75, 76], [75, -1], ['75', 70], [75, '70'], [NaN, 70],
    [75, null], [Infinity, 70], [undefined, 70], [75, undefined]]) {
    // policy() の既定値に頼らず、キーごと書く（undefined が既定値に置き換わらないように）。
    const usagePolicy = { stopUsedPercent: stop, resumeUsedPercent: resume };
    refuses({ accounts: [account('zz-one', { usagePolicy })] }, /usagePolicy\.(stop|resume)UsedPercent/);
  }
});

test('config: blockWhenUnknown is an optional boolean that becomes false when omitted', async t => {
  const { validate, refuses, account } = await setup(t);
  for (const value of [true, false]) {
    const [normalized] = validate({ accounts: [account('zz-one', { usagePolicy: policy(75, 70, { blockWhenUnknown: value }) })] }).accounts;
    assert.equal(normalized.usagePolicy.blockWhenUnknown, value);
  }
  for (const value of [0, 1, 'true', 'false', null, {}, [], NaN]) {
    refuses({ accounts: [account('zz-one', { usagePolicy: policy(75, 70, { blockWhenUnknown: value }) })] }, /blockWhenUnknown must be true or false/);
  }
});

test('config: labels have one shape, are unique and are never echoed', async t => {
  const { validate, refuses, account } = await setup(t);
  for (const label of ['a', '0', 'zz_one-2', 'z'.repeat(32)]) assert.equal(validate({ accounts: [account(label)] }).accounts[0].label, label);
  const badLabels = ['', 'ZZ-one', '-zz', '_zz', 'z'.repeat(33), 'zz one', 'zz-dummy@example.invalid', 42, null];
  for (const label of badLabels) {
    assert.throws(() => validate({ accounts: [{ ...account('zz-one'), label }] }),
      error => error instanceof CodexConfigError && /accounts\[0\]\.label/.test(error.message)
        && (typeof label !== 'string' || label.length < 3 || !error.message.includes(label)));
  }
  refuses({ accounts: [account('zz-one'), { ...account('zz-two'), label: 'zz-one' }] }, /accounts\[1\]\.label is used by another account/);
});

// ---------------------------------------------------------------------------
// パス: accountsDir・口座のフォルダ・~/.codex
// ---------------------------------------------------------------------------

test('config: accountsDir is absolute or starts with ~/, and paths come back expanded without a trailing slash', async t => {
  const { validate, refuses, home, account } = await setup(t);
  const config = validate({ accountsDir: '~/zz-accounts/', accounts: [account('zz-one', { codexHome: `${join(home, 'zz-accounts', 'one')}/` })] });
  assert.equal(config.accountsDir, join(home, 'zz-accounts'));
  assert.equal(config.accounts[0].codexHome, join(home, 'zz-accounts', 'one'));
  for (const accountsDir of ['zz-accounts', './zz-accounts', '~', '~other/zz', '', 42, null]) {
    refuses({ accountsDir }, /accountsDir must be an absolute path or start with ~\//);
  }
  for (const codexHome of ['zz-one', './zz-one', '~', null]) {
    refuses({ accounts: [account('zz-one', { codexHome })] }, /accounts\[0\]\.codexHome must be an absolute path/);
  }
});

// ~ は設定を読むプロセスの HOME で展開されるので、口座のフォルダと codexPath は `~/` の形を受けない
// （HOME の違うプロセスが、同じ設定から別の場所を求めないように）。accountsDir の `~/` は受ける。
test('config: codexHome and codexPath must be absolute paths, and a path starting with ~/ is refused', async t => {
  const { validate, refuses, home, account } = await setup(t);
  for (const codexHome of ['~/zz-accounts/one', '~/zz-accounts/one/', '~/.codex-accounts/zz-one', 'zz-accounts/one', './zz-one', '../zz-one']) {
    refuses({ accounts: [account('zz-one', { codexHome })] },
      /^accounts\[0\]\.codexHome must be an absolute path \(a path starting with ~\/ is not accepted\)$/);
  }
  // 2件目の口座でも同じ（どの口座の値かだけを言う）。
  refuses({ accounts: [account('zz-one'), account('zz-two', { codexHome: '~/zz-two' })] }, /^accounts\[1\]\.codexHome must be an absolute path/);
  for (const codexPath of ['~/zz-tools/bin/codex', '~/codex', 'zz-tools/bin/codex', './codex']) {
    refuses({ codexPath }, /^codexPath must be an absolute path \(a path starting with ~\/ is not accepted\)$/);
  }
  // 拒否の文に値を入れない。
  assert.throws(() => validate({ accounts: [account('zz-one', { codexHome: '~/zz-marker-one' })] }),
    error => error instanceof CodexConfigError && !error.message.includes('zz-marker-one'));
  // 絶対パスなら通り、そのままの形で返る。accountsDir の `~/` は今までどおり展開して受ける。
  const one = join(home, 'zz-accounts', 'one');
  const codexPath = join(home, 'zz-tools', 'bin', 'codex');
  const config = validate({ accountsDir: '~/zz-accounts', accounts: [account('zz-one', { codexHome: one })], codexPath });
  assert.equal(config.accountsDir, join(home, 'zz-accounts'));
  assert.equal(config.accounts[0].codexHome, one);
  assert.equal(config.codexPath, codexPath);
});

test('config: accountsDir is refused when it is, is inside or contains ~/.codex', async t => {
  const { validate, refuses, home } = await setup(t);
  await mkdir(join(home, '.codex'), { mode: 0o700 });
  await symlink(join(home, '.codex'), join(home, 'zz-alias'));
  for (const accountsDir of ['~/.codex', '~/.codex/accounts', join(home, '.codex', 'deep', 'er'), home, '/', '~/zz-alias', '~/zz-alias/accounts']) {
    refuses({ accountsDir }, /accountsDir must be separate from ~\/\.codex/);
  }
  assert.equal(validate({ accountsDir: '~/.codex-accounts' }).accountsDir, join(home, '.codex-accounts'));
  assert.equal(validate({ accountsDir: '~/.codex2' }).accountsDir, join(home, '.codex2'));
});

test('config: an account folder is refused when it is, is inside or contains ~/.codex (from the HOME of the env)', async t => {
  const { refuses, home, account } = await setup(t);
  await mkdir(join(home, '.codex'), { mode: 0o700 });
  await symlink(join(home, '.codex'), join(home, 'zz-alias'));
  for (const codexHome of [join(home, '.codex'), join(home, '.codex', 'sessions'), home, join(home, 'zz-alias'), join(home, 'zz-alias', 'inner')]) {
    refuses({ accounts: [account('zz-one', { codexHome })] }, /accounts\[0\]\.codexHome must be separate from ~\/\.codex/);
  }
});

test('config: a dangling symbolic link cannot stand in for a path', async t => {
  const { refuses, home } = await setup(t);
  await symlink(join(home, '.codex', 'not-yet'), join(home, 'zz-dangling'));
  refuses({ accountsDir: '~/zz-dangling' }, /accountsDir cannot be resolved/);
});

test('config: account folders may not overlap one another, and accountsDir may not sit in an account folder', async t => {
  const { validate, refuses, accountsDir, account, home } = await setup(t);
  const one = account('zz-one');
  refuses({ accounts: [one, account('zz-two', { codexHome: one.codexHome })] }, /accounts\[1\]\.codexHome overlaps/);
  refuses({ accounts: [one, account('zz-two', { codexHome: join(one.codexHome, 'nested') })] }, /accounts\[1\]\.codexHome overlaps/);
  refuses({ accounts: [account('zz-two', { codexHome: join(one.codexHome, 'nested') }), one] }, /accounts\[1\]\.codexHome overlaps/);
  refuses({ accounts: [account('zz-one', { codexHome: accountsDir })] }, /accountsDir must not be the same as or inside accounts\[0\]\.codexHome/);
  refuses({ accounts: [account('zz-one', { codexHome: home })] }, /separate from ~\/\.codex|accountsDir must not be/);
  refuses({ accountsDir: join(home, 'zz-shared', 'accounts'), accounts: [account('zz-one', { codexHome: join(home, 'zz-shared') })] },
    /accountsDir must not be the same as or inside accounts\[0\]\.codexHome/);
  // 口座のフォルダは accountsDir の中にも外にも置ける。
  const config = validate({ accounts: [one, account('zz-two'), account('zz-three', { codexHome: join(home, 'zz-elsewhere', 'three') })] });
  assert.deepEqual(config.accounts.map(entry => entry.codexHome),
    [join(accountsDir, 'zz-one'), join(accountsDir, 'zz-two'), join(home, 'zz-elsewhere', 'three')]);
});

// ---------------------------------------------------------------------------
// codexPath
// ---------------------------------------------------------------------------

test('config: codexPath is optional, absolute, and never inside accountsDir or the shim directory', async t => {
  const { validate, refuses, env, home, accountsDir } = await setup(t);
  assert.equal(validate({}).codexPath, null);
  const external = join(home, 'zz-tools', 'bin', 'codex');
  assert.equal(validate({ codexPath: external }).codexPath, external);
  for (const codexPath of ['codex', 'bin/codex', './codex', '../codex', '', null, 42]) {
    refuses({ codexPath }, /codexPath must be an absolute path/);
  }
  refuses({ codexPath: join(accountsDir, 'zz-one', 'codex') }, /codexPath must not point inside accountsDir/);
  refuses({ codexPath: accountsDir }, /codexPath must not point inside accountsDir/);
  refuses({ codexPath: join(shimDir(env), 'codex') }, /codexPath must not point inside the codex-rotator shim directory/);
  refuses({ accountsDir: '~/zz-custom-accounts', codexPath: join(home, 'zz-custom-accounts', 'codex') }, /inside accountsDir/);
});

test('config: codexPath is compared by its real path, so a link into the shim directory is refused', async t => {
  const { refuses, env, home } = await setup(t);
  await mkdir(shimDir(env), { recursive: true, mode: 0o700 });
  await writeFile(join(shimDir(env), 'codex'), '#!/bin/sh\n', { mode: 0o700 });
  await mkdir(join(home, 'zz-tools'), { mode: 0o700 });
  await symlink(join(shimDir(env), 'codex'), join(home, 'zz-tools', 'codex'));
  await symlink(shimDir(env), join(home, 'zz-shim-alias'));
  refuses({ codexPath: join(home, 'zz-tools', 'codex') }, /shim directory/);
  refuses({ codexPath: join(home, 'zz-shim-alias', 'codex') }, /shim directory/);
});

test('config: codexPath may not point inside an account folder kept outside accountsDir', async t => {
  const { validate, refuses, home, account } = await setup(t);
  const outside = join(home, 'zz-elsewhere', 'three');
  const accounts = [account('zz-three', { codexHome: outside })];
  refuses({ accounts, codexPath: join(outside, 'bin', 'codex') }, /codexPath must not point inside an account folder/);
  refuses({ accounts, codexPath: outside }, /codexPath must not point inside an account folder/);
  assert.equal(validate({ accounts, codexPath: join(home, 'zz-elsewhere', 'codex') }).codexPath, join(home, 'zz-elsewhere', 'codex'));
});

// ---------------------------------------------------------------------------
// 大文字小文字を区別しないディスク（darwin）
// ---------------------------------------------------------------------------

test('config: on darwin, paths that differ only in letter case (or Unicode form) are one place, even before they exist', async t => {
  const { env, home, account } = await setup(t);
  const cases = [
    [{ accountsDir: '~/.CODEX/accounts' }, /accountsDir must be separate from ~\/\.codex/],
    [{ accounts: [account('zz-one', { codexHome: join(home, '.Codex') })] }, /accounts\[0\]\.codexHome must be separate from ~\/\.codex/],
    [{ accounts: [account('zz-one', { codexHome: join(home, 'zz-accts', 'One') }),
      account('zz-two', { codexHome: join(home, 'zz-accts', 'one') })] }, /accounts\[1\]\.codexHome overlaps/],
    [{ accounts: [account('zz-one', { codexHome: join(home, 'zz-caf\u00e9') }),
      account('zz-two', { codexHome: join(home, 'zz-cafe\u0301') })] }, /accounts\[1\]\.codexHome overlaps/],
    [{ accountsDir: '~/zz-Accounts', codexPath: join(home, 'ZZ-ACCOUNTS', 'codex') }, /codexPath must not point inside accountsDir/],
    [{ codexPath: join(env.XDG_DATA_HOME, 'Codex-Rotator', 'BIN', 'codex') }, /shim directory/],
  ];
  for (const [raw, pattern] of cases) {
    assert.throws(() => validateCodexConfig(raw, { env, platform: 'darwin' }),
      error => error instanceof CodexConfigError && pattern.test(error.message), JSON.stringify(raw));
    // 大文字小文字を区別するディスク（linux）では、別の場所として通る。
    assert.doesNotThrow(() => validateCodexConfig(raw, { env, platform: 'linux' }), JSON.stringify(raw));
  }
});

// ---------------------------------------------------------------------------
// usageUserAgent と usageOriginator
// ---------------------------------------------------------------------------

const fakeUserAgent = 'zz-fake-usage-reader (zz-fake-os; zz-fake-arch) zz-fake-terminal';
const fakeOriginator = 'zz-fake-originator';

function badHeaderValues(maxLength) {
  return [
    ['empty', ''],
    ['too long', `zz-fake-${'a'.repeat(maxLength - 7)}`],
    ['a line break', 'zz-fake-value\nmore'],
    ['a carriage return', 'zz-fake-value\rmore'],
    ['a tab', 'zz-fake-value\tmore'],
    ['a control character', 'zz-fake-value\u0001'],
    ['DEL', 'zz-fake-value\u007f'],
    ['non-ASCII text', 'zz-fake-valué'],
    ['only spaces', '   '],
    ['a leading space', ' zz-fake-value'],
    ['a trailing space', 'zz-fake-value '],
    ['a number', 42],
    ['null', null],
  ];
}

test('config: usageUserAgent accepts 1 to 256 printable ASCII characters without surrounding spaces', async t => {
  const { validate, refuses } = await setup(t);
  for (const usageUserAgent of ['z', fakeUserAgent, `zz-fake-${'a'.repeat(USAGE_USER_AGENT_MAX_LENGTH - 8)}`, 'zz-fake inner  spaces !~']) {
    assert.equal(validate({ usageUserAgent, usageOriginator: fakeOriginator }).usageUserAgent, usageUserAgent);
    assert.equal(isValidUsageUserAgent(usageUserAgent), true);
  }
  for (const [name, usageUserAgent] of badHeaderValues(USAGE_USER_AGENT_MAX_LENGTH)) {
    refuses({ usageUserAgent, usageOriginator: fakeOriginator }, /^usageUserAgent /);
    assert.equal(isValidUsageUserAgent(usageUserAgent), false, name);
  }
});

test('config: usageOriginator follows the same rules with a 64-character limit', async t => {
  const { validate, refuses } = await setup(t);
  for (const usageOriginator of ['z', fakeOriginator, `zz-fake-${'o'.repeat(USAGE_ORIGINATOR_MAX_LENGTH - 8)}`]) {
    assert.equal(validate({ usageUserAgent: fakeUserAgent, usageOriginator }).usageOriginator, usageOriginator);
    assert.equal(isValidUsageOriginator(usageOriginator), true);
  }
  for (const [name, usageOriginator] of badHeaderValues(USAGE_ORIGINATOR_MAX_LENGTH)) {
    refuses({ usageUserAgent: fakeUserAgent, usageOriginator }, /^usageOriginator /);
    assert.equal(isValidUsageOriginator(usageOriginator), false, name);
  }
});

test('config: usageUserAgent and usageOriginator are set together or both omitted', async t => {
  const { validate, refuses } = await setup(t);
  refuses({ usageUserAgent: fakeUserAgent }, /must be set together/);
  refuses({ usageOriginator: fakeOriginator }, /must be set together/);
  const omitted = validate({});
  assert.deepEqual([omitted.usageUserAgent, omitted.usageOriginator], [null, null]);
  const both = validate({ usageUserAgent: fakeUserAgent, usageOriginator: fakeOriginator });
  assert.deepEqual([both.usageUserAgent, both.usageOriginator], [fakeUserAgent, fakeOriginator]);
});

test('config: refusal messages never contain the User-Agent or originator value', async t => {
  const { validate } = await setup(t);
  const marker = `zz-fake-marker-${randomBytes(6).toString('hex')}`;
  const cases = [
    { usageUserAgent: `${marker}\n`, usageOriginator: fakeOriginator },
    { usageUserAgent: ` ${marker}`, usageOriginator: fakeOriginator },
    { usageUserAgent: fakeUserAgent, usageOriginator: `${marker} ` },
    { usageUserAgent: fakeUserAgent, usageOriginator: `${marker}${'o'.repeat(64)}` },
    { usageUserAgent: marker },
    { usageOriginator: marker },
  ];
  for (const raw of cases) {
    assert.throws(() => validate(raw), error => error instanceof CodexConfigError && !error.message.includes(marker));
  }
});

test('config: the User-Agent and originator values stay out of the log (registered as secret values)', async t => {
  const { validate } = await setup(t);
  const nonce = randomBytes(6).toString('hex');
  const usageUserAgent = `zz-fake-ua-marker-${nonce} (zz-fake-os)`;
  const usageOriginator = `zz-fake-originator-marker-${nonce}`;
  const config = validate({ usageUserAgent, usageOriginator });
  assert.deepEqual(configSecretValues(config), [usageUserAgent, usageOriginator]);
  assert.deepEqual(configSecretValues(validate({})), []);

  const logEverything = logger => {
    logger.info('usage_read', { message: `sending ${usageUserAgent} with ${usageOriginator}`, reason: usageOriginator });
    logger.warn('usage_read', { error: new Error(`rejected ${usageUserAgent} / ${usageOriginator}`) });
    logger.error('usage_read', { error: Object.assign(new Error('boom'), { name: usageOriginator }) });
  };
  const fromOptions = [];
  logEverything(createCodexLogger({ write: line => fromOptions.push(line), secrets: configSecretValues(config) }));
  const fromRegistration = [];
  const registered = createCodexLogger({ write: line => fromRegistration.push(line) });
  for (const value of configSecretValues(config)) registered.registerSecret(value);
  logEverything(registered);
  for (const lines of [fromOptions, fromRegistration]) {
    assert.equal(lines.length, 3);
    const text = lines.join('\n');
    assert.ok(!text.includes(usageUserAgent) && !text.includes(usageOriginator) && !text.includes(nonce), text);
    assert.match(text, /\[REDACTED\]/);
  }
  // 陽性対照: 登録しなければ値がそのまま出る（上の確かめ方が空振りしていないこと）。
  const unregistered = [];
  logEverything(createCodexLogger({ write: line => unregistered.push(line) }));
  assert.ok(unregistered.join('\n').includes(usageOriginator));
});

// ---------------------------------------------------------------------------
// daemon.port
// ---------------------------------------------------------------------------

test('config: the daemon port defaults to its own number, different from the Claude listener and the OpenAI bridge', async t => {
  const { validate } = await setup(t);
  assert.equal(DEFAULT_DAEMON_PORT, CODEX_CONFIG_DEFAULTS.daemonPort);
  assert.notEqual(DEFAULT_DAEMON_PORT, CLAUDE_DEFAULT_PORT);
  assert.notEqual(DEFAULT_DAEMON_PORT, BRIDGE_DEFAULT_PORT);
  assert.equal(validate({}).daemon.port, DEFAULT_DAEMON_PORT);
  assert.equal(validate({ daemon: {} }).daemon.port, DEFAULT_DAEMON_PORT);
});

test('config: daemon.port accepts 0 to 65535 (0 lets the OS choose, for tests) and nothing else', async t => {
  const { validate, refuses } = await setup(t);
  for (const port of [0, 1, 40000, 65535]) assert.equal(validate({ daemon: { port } }).daemon.port, port);
  for (const port of [-1, 65536, 1.5, `${DEFAULT_DAEMON_PORT}`, null, true, NaN]) refuses({ daemon: { port } }, /daemon\.port/);
});

// ---------------------------------------------------------------------------
// 読込
// ---------------------------------------------------------------------------

test('config: loading returns null when the file is missing and never creates it', async t => {
  const { env } = await setup(t);
  assert.equal(await loadCodexConfig({ env }), null);
  assert.equal(await loadCodexConfig({ env }), null);
});

test('config: loading reads only the file under the XDG config home of the env', async t => {
  const { env, isolation, account } = await setup(t);
  // 別の場所を指す変数を足しても、読むのは env の XDG_CONFIG_HOME の下だけ。
  const decoy = join(isolation.root, 'decoy.json');
  await writeFile(decoy, JSON.stringify({ zzDecoy: true }), { mode: 0o600 });
  const withDecoys = { ...env, CODEX_ROTATOR_CONFIG: decoy, CLAUDE_ROTATOR_CONFIG: decoy };
  assert.equal(await loadCodexConfig({ env: withDecoys }), null);

  const path = codexRotatorConfigPath(env);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ enabled: true, acknowledgedMultiAccountRisk: true, accounts: [account('zz-one')] }), { mode: 0o600 });
  const config = await loadCodexConfig({ env: withDecoys });
  assert.equal(isCodexRotatorActivated(config), true);
  assert.deepEqual(config.accounts.map(entry => entry.label), ['zz-one']);
});

test('config: a file that is not JSON or not valid is refused without echoing its content or path', async t => {
  const { env } = await setup(t);
  const path = codexRotatorConfigPath(env);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const marker = `ZZ-MARKER-${randomBytes(6).toString('hex')}`;
  await writeFile(path, `{"enabled": true, "note": "${marker}"`, { mode: 0o600 });
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /not valid JSON/.test(error.message) && !error.message.includes(marker) && !error.message.includes(path));
  await writeFile(path, JSON.stringify({ accountsDir: marker }), { mode: 0o600 });
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /accountsDir/.test(error.message) && !error.message.includes(marker));
  const openImpl = async () => { throw Object.assign(new Error(`EACCES ${path}`), { code: 'EACCES' }); };
  await assert.rejects(loadCodexConfig({ env, openImpl }), error => error instanceof CodexConfigError
    && /the codex-rotator config file cannot be inspected/.test(error.message) && !error.message.includes(path));
});

async function writeConfig(env, raw, mode = 0o600) {
  const path = codexRotatorConfigPath(env);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(raw));
  await chmod(path, mode);
  return path;
}

test('config: loading refuses a config file that is not private (0644, 0666, executable, a symbolic link)', async t => {
  const { env, isolation } = await setup(t);
  const path = await writeConfig(env, { enabled: false });
  for (const mode of [0o644, 0o666, 0o640, 0o604, 0o700]) {
    await chmod(path, mode);
    await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
      && /^the codex-rotator config file must be private/.test(error.message), mode.toString(8));
  }
  await chmod(path, 0o600);
  assert.equal((await loadCodexConfig({ env })).enabled, false);
  // 自分だけの 0600 のファイルを指すリンクでも拒否する（リンクを辿らない）。
  const real = join(isolation.root, 'zz-real-config.json');
  await writeFile(real, JSON.stringify({ enabled: true }), { mode: 0o600 });
  await rm(path);
  await symlink(real, path);
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /^the codex-rotator config file must not be a symbolic link/.test(error.message));
});

test('config: loading refuses a config folder that is not private, and returns null only when the file is missing', async t => {
  const { env } = await setup(t);
  assert.equal(await loadCodexConfig({ env }), null, 'no folder, no file');
  const path = await writeConfig(env, { enabled: false });
  const folder = join(path, '..');
  await chmod(folder, 0o755);
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /^the codex-rotator config folder must be private/.test(error.message));
  await rm(path);
  assert.equal(await loadCodexConfig({ env }), null, 'the file is missing');
});

test('config: loading checks an accountsDir that already exists on disk, and lets a missing one pass', async t => {
  const { env, home, isolation } = await setup(t);
  const accountsDir = join(home, 'zz-accounts');
  await writeConfig(env, { accountsDir });
  assert.equal((await loadCodexConfig({ env })).accountsDir, accountsDir, 'missing accountsDir passes');
  await mkdir(accountsDir, { mode: 0o700 });
  assert.equal((await loadCodexConfig({ env })).accountsDir, accountsDir, 'private accountsDir passes');
  await chmod(accountsDir, 0o755);
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /^accountsDir must be private/.test(error.message));
  // 同期の検証はパスだけを見るので、同じ設定を通す。
  assert.equal(validateCodexConfig({ accountsDir }, { env }).accountsDir, accountsDir);

  const target = join(isolation.root, 'zz-real-accounts');
  await mkdir(target, { mode: 0o700 });
  const linked = join(home, 'zz-linked-accounts');
  await symlink(target, linked);
  await writeConfig(env, { accountsDir: linked });
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /^accountsDir must not be a symbolic link/.test(error.message));

  const plain = join(home, 'zz-plain-file');
  await writeFile(plain, '');
  await writeConfig(env, { accountsDir: plain });
  await assert.rejects(loadCodexConfig({ env }), error => error instanceof CodexConfigError
    && /^accountsDir must be a directory/.test(error.message));
});

test('config: validation needs an absolute HOME in the env instead of guessing one', () => {
  for (const env of [undefined, {}, { HOME: 'relative/home' }]) {
    assert.throws(() => validateCodexConfig({}, { env }), error => error instanceof CodexConfigError && /HOME/.test(error.message));
  }
});

// ---------------------------------------------------------------------------
// 読込みの sha256
// ---------------------------------------------------------------------------

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');

test('config: a snapshot returns the parsed config and the sha256 of the same single read', async t => {
  const { env, accountsDir, account } = await setup(t);
  assert.equal(await loadCodexConfigSnapshot({ env }), null, 'no file, no snapshot');
  // フォルダの名前に ASCII の外の文字を入れ、utf8 で符号化したバイト列で求めた値がファイルと同じことも見る。
  const first = { enabled: true, acknowledgedMultiAccountRisk: true,
    accounts: [account('zz-first', { codexHome: join(accountsDir, 'zz-口座-first') })] };
  const path = await writeConfig(env, first);
  const firstBytes = await readFile(path);
  assert.ok(firstBytes.some(byte => byte > 0x7f), 'the file has bytes outside ASCII');
  const second = { enabled: false, accounts: [account('zz-second')] };

  // 偽の fs: 読み終えて閉じた直後に、別の中身へ書き換える。
  let opens = 0;
  const openImpl = async (target, flags) => {
    opens++;
    const handle = await open(target, flags);
    return {
      stat: () => handle.stat(),
      read: (...args) => handle.read(...args),
      close: async () => {
        await handle.close();
        await writeFile(path, JSON.stringify(second));
      },
    };
  };
  const snapshot = await loadCodexConfigSnapshot({ env, openImpl });
  assert.equal(opens, 1, 'one read');
  assert.ok(Object.isFrozen(snapshot));
  assert.match(snapshot.sha256, CONFIG_SHA256_PATTERN);
  assert.equal(snapshot.sha256, sha256Hex(firstBytes), 'the value is from the bytes that were parsed');
  assert.equal(snapshot.config.enabled, true);
  assert.deepEqual(snapshot.config.accounts.map(entry => entry.label), ['zz-first']);

  // ファイルは書き換わっており、次の読込みは新しい中身とその値を返す。
  const secondBytes = await readFile(path);
  assert.notEqual(sha256Hex(secondBytes), snapshot.sha256);
  const again = await loadCodexConfigSnapshot({ env });
  assert.equal(again.sha256, sha256Hex(secondBytes));
  assert.deepEqual(again.config.accounts.map(entry => entry.label), ['zz-second']);
  // loadCodexConfig の戻り値の形（設定そのもの）は変わらない。
  assert.deepEqual(await loadCodexConfig({ env }), again.config);
});

test('config: a snapshot is refused on the same conditions as loading', async t => {
  const { env } = await setup(t);
  const path = await writeConfig(env, { enabled: false });
  await chmod(path, 0o644);
  await assert.rejects(loadCodexConfigSnapshot({ env }), error => error instanceof CodexConfigError
    && /^the codex-rotator config file must be private/.test(error.message));
  await chmod(path, 0o600);
  await writeFile(path, '{"enabled": ');
  await assert.rejects(loadCodexConfigSnapshot({ env }), error => error instanceof CodexConfigError
    && /not valid JSON/.test(error.message));
});

// ---------------------------------------------------------------------------
// 追記・初回の作成・登録を外す書込み
// ---------------------------------------------------------------------------

// 更新時刻を過去の固定の時刻にしてから、中身・更新時刻・フォルダの中身が変わらないことを確かめる関数を返す。
async function pinConfigFile(path) {
  const past = new Date('2001-02-03T04:05:06Z');
  await utimes(path, past, past);
  const bytes = await readFile(path);
  const { mtimeMs } = await stat(path);
  return async message => {
    assert.deepEqual(await readFile(path), bytes, `${message}: content`);
    assert.equal((await stat(path)).mtimeMs, mtimeMs, `${message}: modification time`);
    assert.deepEqual(await readdir(dirname(path)), ['config.json'], `${message}: no temporary file is left`);
  };
}

test('config: the first append creates the file with both gates off, the folder 0700 and the file 0600', async t => {
  const { env, account } = await setup(t);
  const path = codexRotatorConfigPath(env);
  await assert.rejects(stat(dirname(path)), { code: 'ENOENT' });
  const result = await appendCodexAccount({ env, account: account('zz-first'), expectedSha256: null });

  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(path)), ['config.json']);
  const bytes = await readFile(path);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')),
    { enabled: false, acknowledgedMultiAccountRisk: false, accounts: [account('zz-first')] });
  assert.equal(result.sha256, sha256Hex(bytes));
  const snapshot = await loadCodexConfigSnapshot({ env });
  assert.equal(snapshot.sha256, result.sha256);
  assert.deepEqual(snapshot.config, result.config);
  assert.equal(isCodexRotatorActivated(snapshot.config), false);
  assert.deepEqual(snapshot.config.accounts.map(entry => entry.label), ['zz-first']);
});

test('config: the first append writes nothing when the account is refused or the folder is not private', async t => {
  const { env, account } = await setup(t);
  const path = codexRotatorConfigPath(env);
  // 方針の無い口座は、フォルダを作る前に拒否する。
  await assert.rejects(appendCodexAccount({ env, account: account('zz-first', { usagePolicy: undefined }), expectedSha256: null }),
    error => error instanceof CodexConfigError && /usagePolicy is required/.test(error.message));
  await assert.rejects(stat(dirname(path)), { code: 'ENOENT' });
  // 既にある広いフォルダは広げも狭めもせず、拒否する。
  await mkdir(dirname(path), { mode: 0o700 });
  await chmod(dirname(path), 0o755);
  await assert.rejects(appendCodexAccount({ env, account: account('zz-first'), expectedSha256: null }),
    error => error instanceof CodexConfigError && /^the codex-rotator config folder must be private/.test(error.message)
      && !error.message.includes(path));
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(dirname(path)), []);
});

test('config: the first append never replaces a file that appeared, and leaves no temporary file', async t => {
  const { env, account } = await setup(t);
  const path = codexRotatorConfigPath(env);
  // 名前を付ける時点で先にファイルができていた（link が EEXIST）。
  let links = 0;
  const fileOps = { link: async () => { links++; throw Object.assign(new Error('zz exists'), { code: 'EEXIST' }); } };
  await assert.rejects(appendCodexAccount({ env, account: account('zz-first'), expectedSha256: null, fileOps }),
    error => error instanceof CodexConfigError && /already exists; nothing was written/.test(error.message));
  assert.equal(links, 1);
  assert.deepEqual(await readdir(dirname(path)), []);
  // 読んだときに無かったのに、今はある。
  await writeConfig(env, { enabled: false, accounts: [account('zz-other')] });
  const check = await pinConfigFile(path);
  await assert.rejects(appendCodexAccount({ env, account: account('zz-first'), expectedSha256: null }),
    error => error instanceof CodexConfigError && /already exists; nothing was written/.test(error.message));
  await check('a file that appeared is kept');
});

test('config: appending adds one account with its policy, keeps the other keys, and the result validates', async t => {
  const { env, account } = await setup(t);
  const path = await writeConfig(env, { enabled: true, acknowledgedMultiAccountRisk: true, usagePollIntervalMs: 60000,
    accounts: [account('zz-a')] });
  const before = await loadCodexConfigSnapshot({ env });
  const added = account('zz-b', { usagePolicy: policy(80, 60, { blockWhenUnknown: true }) });
  const result = await appendCodexAccount({ env, account: added, expectedSha256: before.sha256 });

  const bytes = await readFile(path);
  assert.equal(result.sha256, sha256Hex(bytes));
  assert.notEqual(result.sha256, before.sha256);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { enabled: true, acknowledgedMultiAccountRisk: true,
    usagePollIntervalMs: 60000, accounts: [account('zz-a'), added] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(path)), ['config.json']);
  const after = await loadCodexConfigSnapshot({ env });
  assert.equal(after.sha256, result.sha256);
  assert.deepEqual(after.config, result.config);
  assert.equal(isCodexRotatorActivated(after.config), true);
  assert.deepEqual(after.config.accounts.map(entry => [entry.label, entry.usagePolicy]), [
    ['zz-a', { stopUsedPercent: 75, resumeUsedPercent: 70, blockWhenUnknown: false }],
    ['zz-b', { stopUsedPercent: 80, resumeUsedPercent: 60, blockWhenUnknown: true }],
  ]);
});

test('config: appending refuses before writing when the account does not fit or the file changed since it was read', async t => {
  const { env, accountsDir, account } = await setup(t);
  const path = await writeConfig(env, { enabled: false, accounts: [account('zz-a')] });
  const { sha256 } = await loadCodexConfigSnapshot({ env });
  const check = await pinConfigFile(path);
  const refusals = [
    [account('zz-a', { codexHome: join(accountsDir, 'zz-elsewhere') }), sha256, /label is used by another account/],
    [account('zz-b', { codexHome: join(accountsDir, 'zz-a') }), sha256, /overlaps the codexHome of another account/],
    [account('zz-b', { codexHome: join(accountsDir, 'zz-a', 'inner') }), sha256, /overlaps the codexHome of another account/],
    [account('zz-b', { usagePolicy: undefined }), sha256, /usagePolicy is required/],
    [account('zz-b', { usagePolicy: policy(70, 70) }), sha256, /resumeUsedPercent/],
    [account('zz-b'), '0'.repeat(64), /changed since it was read; nothing was written/],
    [account('zz-b'), sha256.toUpperCase(), /expectedSha256 must be/],
    [account('zz-b'), undefined, /expectedSha256 must be/],
  ];
  for (const [added, expectedSha256, pattern] of refusals) {
    await assert.rejects(appendCodexAccount({ env, account: added, expectedSha256 }),
      error => error instanceof CodexConfigError && pattern.test(error.message) && !error.message.includes(path),
      String(pattern));
    await check(String(pattern));
  }
  // 読んだときにあったファイルが今は無いときも、作らない。
  await rm(path);
  await assert.rejects(appendCodexAccount({ env, account: account('zz-b'), expectedSha256: sha256 }),
    error => error instanceof CodexConfigError && /changed since it was read/.test(error.message));
  assert.deepEqual(await readdir(dirname(path)), []);
});

test('config: when rename fails, appending and removing leave the content and the modification time unchanged', async t => {
  const { env, account } = await setup(t);
  const path = await writeConfig(env, { enabled: false, accounts: [account('zz-a'), account('zz-b')] });
  const { sha256 } = await loadCodexConfigSnapshot({ env });
  const check = await pinConfigFile(path);
  let renames = 0;
  const fileOps = { rename: async () => { renames++; throw Object.assign(new Error(`zz rename failed ${path}`), { code: 'EIO' }); } };
  const refused = error => error instanceof CodexConfigError
    && /could not be written; the original is unchanged/.test(error.message) && !error.message.includes(path);

  await assert.rejects(appendCodexAccount({ env, account: account('zz-c'), expectedSha256: sha256, fileOps }), refused);
  assert.equal(renames, 1);
  await check('append');
  await assert.rejects(removeCodexAccount({ env, label: 'zz-b', fileOps }), refused);
  assert.equal(renames, 2);
  await check('remove');
  assert.equal((await loadCodexConfigSnapshot({ env })).sha256, sha256);
});

test('config: a write stops, keeping the other writer, when the file changes between the read and the rename', async t => {
  const { env, account } = await setup(t);
  const path = await writeConfig(env, { enabled: false, accounts: [account('zz-a'), account('zz-b')] });
  const other = `${JSON.stringify({ enabled: false, accounts: [account('zz-other')] })}\n`;
  // 一時ファイルを開いた時点で、別の書き手が設定を書き換える。
  const fileOps = {
    open: async (target, ...rest) => {
      if (target !== path && target.startsWith(`${path}.`)) await writeFile(path, other);
      return open(target, ...rest);
    },
  };
  const { sha256 } = await loadCodexConfigSnapshot({ env });
  await assert.rejects(appendCodexAccount({ env, account: account('zz-c'), expectedSha256: sha256, fileOps }),
    error => error instanceof CodexConfigError && /changed since it was read; nothing was written/.test(error.message));
  assert.equal(await readFile(path, 'utf8'), other);
  assert.deepEqual(await readdir(dirname(path)), ['config.json']);

  await writeConfig(env, { enabled: false, accounts: [account('zz-a'), account('zz-b')] });
  await assert.rejects(removeCodexAccount({ env, label: 'zz-b', fileOps }),
    error => error instanceof CodexConfigError && /changed since it was read; nothing was written/.test(error.message));
  assert.equal(await readFile(path, 'utf8'), other);
  assert.deepEqual(await readdir(dirname(path)), ['config.json']);
});

test('config: removing takes out only that label, keeps its folder, and the result validates', async t => {
  const { env, accountsDir, account } = await setup(t);
  await mkdir(join(accountsDir, 'zz-b'), { recursive: true, mode: 0o700 });
  await chmod(accountsDir, 0o700);
  const path = await writeConfig(env, { enabled: true, acknowledgedMultiAccountRisk: true,
    accounts: [account('zz-a'), account('zz-b'), account('zz-c')] });
  const before = await loadCodexConfigSnapshot({ env });
  const result = await removeCodexAccount({ env, label: 'zz-b' });

  assert.equal(result.removed, true);
  const bytes = await readFile(path);
  assert.equal(result.sha256, sha256Hex(bytes));
  assert.notEqual(result.sha256, before.sha256);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { enabled: true, acknowledgedMultiAccountRisk: true,
    accounts: [account('zz-a'), account('zz-c')] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.ok((await stat(join(accountsDir, 'zz-b'))).isDirectory(), 'the account folder is kept');
  const after = await loadCodexConfigSnapshot({ env });
  assert.equal(after.sha256, result.sha256);
  assert.deepEqual(after.config, result.config);
  assert.deepEqual(after.config.accounts.map(entry => entry.label), ['zz-a', 'zz-c']);

  // もう無いラベルは、何も書かずに removed:false と今の設定を返す。
  const check = await pinConfigFile(path);
  const again = await removeCodexAccount({ env, label: 'zz-b' });
  assert.equal(again.removed, false);
  assert.equal(again.sha256, sha256Hex(await readFile(path)));
  await check('an absent label');
  // ラベルの形でないものは拒否し、値を返さない。
  const marker = `ZZ-MARKER-${randomBytes(4).toString('hex')}`;
  for (const label of [marker, '', undefined, 7]) {
    await assert.rejects(removeCodexAccount({ env, label }),
      error => error instanceof CodexConfigError && /^label must be/.test(error.message) && !error.message.includes(marker));
  }
  await check('an invalid label');
  // 最後の1件も外せ、外した設定も検証を通る。
  await removeCodexAccount({ env, label: 'zz-a' });
  await removeCodexAccount({ env, label: 'zz-c' });
  assert.deepEqual((await loadCodexConfig({ env })).accounts, []);

  // ファイルが無いときは、何も作らずに removed:false。
  await rm(path);
  assert.deepEqual({ ...(await removeCodexAccount({ env, label: 'zz-a' })) }, { removed: false, config: null, sha256: null });
  assert.deepEqual(await readdir(dirname(path)), []);
});

// ---------------------------------------------------------------------------
// 存在しないパスの実パス化
// ---------------------------------------------------------------------------

test('config: canonicalPath and comparisonKey are exported and resolve paths that do not exist yet', async t => {
  const { isolation } = await setup(t);
  const { root } = isolation;
  const real = join(root, 'zz-real');
  await mkdir(real, { mode: 0o700 });
  const linked = join(root, 'zz-linked');
  await symlink(real, linked);

  assert.equal(canonicalPath(linked), real);
  // 存在しない部分は、存在する祖先の実パスにそのままつなぐ。
  assert.equal(canonicalPath(join(linked, 'zz-missing', 'deeper')), join(real, 'zz-missing', 'deeper'));
  assert.equal(canonicalPath(`${join(linked, 'zz-missing')}/`), join(real, 'zz-missing'));
  // 行き先の無いリンクの下と相対パスは、where だけを言って拒否する。
  const dangling = join(root, 'zz-dangling');
  await symlink(join(root, 'zz-nowhere'), dangling);
  for (const value of [join(dangling, 'child'), dangling]) {
    assert.throws(() => canonicalPath(value, { where: 'CODEX_HOME' }),
      error => error instanceof CodexConfigError && error.message === 'CODEX_HOME cannot be resolved');
  }
  for (const value of ['relative/zz', '', undefined, `${root}/zz\0`]) {
    assert.throws(() => canonicalPath(value, { where: 'CODEX_HOME' }),
      error => error instanceof CodexConfigError && error.message === 'CODEX_HOME must be an absolute path');
  }
  // 差し替えた realpath・lstat を使う。
  const calls = [];
  const realpathImpl = path => {
    calls.push(path);
    if (path === '/zz-fake/present') return '/zz-fake/REAL';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  const lstatImpl = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.equal(canonicalPath('/zz-fake/present/a/b', { realpathImpl, lstatImpl }), '/zz-fake/REAL/a/b');
  assert.deepEqual(calls, ['/zz-fake/present/a/b', '/zz-fake/present/a', '/zz-fake/present']);

  // darwin では大文字小文字と正規化形をそろえ、ほかではそのまま。
  assert.equal(comparisonKey('/Zz/Café', 'darwin'), '/zz/café');
  assert.equal(comparisonKey('/Zz/Café', 'linux'), '/Zz/Café');
  assert.equal(comparisonKey('/Zz/Mixed'), comparisonKey('/Zz/Mixed', process.platform));
  // 存在しないパスでも、同じ場所の2つの書き方が darwin では同じ形になる。
  assert.equal(comparisonKey(canonicalPath(join(linked, 'ZZ-New')), 'darwin'),
    comparisonKey(canonicalPath(join(real, 'zz-new')), 'darwin'));
});
