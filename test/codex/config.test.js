// codex-rotator の設定（src/codex/config.js）のテスト。
//
// しきい値の方針・観測の時間・下限検査・範囲と、既定値どうしの整合の件を確かめる。
// 送信の時間予算・再試行の設定は無い（送信経路を持たないため）。
// 絶対条件: 実のホーム・実の設定ファイル・実の ~/.codex には触れない。env は isolation の補助の一時
// フォルダのもの。User-Agent と originator の値は合成の値（製品名の部分を zz-fake- で始める）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  CODEX_CONFIG_DEFAULTS,
  CodexConfigError,
  DEFAULT_DAEMON_PORT,
  USAGE_ORIGINATOR_MAX_LENGTH,
  USAGE_USER_AGENT_MAX_LENGTH,
  configSecretValues,
  isCodexRotatorActivated,
  isValidUsageOriginator,
  isValidUsageUserAgent,
  loadCodexConfig,
  minimumObservationTtlMs,
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

test('config: paths are absolute or start with ~/, and come back expanded without a trailing slash', async t => {
  const { validate, refuses, home, account } = await setup(t);
  const config = validate({ accountsDir: '~/zz-accounts/', accounts: [account('zz-one', { codexHome: '~/zz-accounts/one/' })] });
  assert.equal(config.accountsDir, join(home, 'zz-accounts'));
  assert.equal(config.accounts[0].codexHome, join(home, 'zz-accounts', 'one'));
  for (const accountsDir of ['zz-accounts', './zz-accounts', '~', '~other/zz', '', 42, null]) {
    refuses({ accountsDir }, /accountsDir must be an absolute path or start with ~\//);
  }
  for (const codexHome of ['zz-one', './zz-one', '~', null]) {
    refuses({ accounts: [account('zz-one', { codexHome })] }, /accounts\[0\]\.codexHome must be an absolute path/);
  }
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
  for (const codexHome of ['~/.codex', join(home, '.codex'), '~/.codex/sessions', home, '~/zz-alias', '~/zz-alias/inner']) {
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
  assert.equal(validate({ codexPath: '~/zz-tools/bin/codex' }).codexPath, external);
  for (const codexPath of ['codex', 'bin/codex', './codex', '../codex', '', null, 42]) {
    refuses({ codexPath }, /codexPath must be an absolute path/);
  }
  refuses({ codexPath: join(accountsDir, 'zz-one', 'codex') }, /codexPath must not point inside accountsDir/);
  refuses({ codexPath: accountsDir }, /codexPath must not point inside accountsDir/);
  refuses({ codexPath: join(shimDir(env), 'codex') }, /codexPath must not point inside the codex-rotator shim directory/);
  refuses({ accountsDir: '~/zz-custom-accounts', codexPath: '~/zz-custom-accounts/codex' }, /inside accountsDir/);
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
    [{ accounts: [account('zz-one', { codexHome: '~/.Codex' })] }, /accounts\[0\]\.codexHome must be separate from ~\/\.codex/],
    [{ accounts: [account('zz-one', { codexHome: join(home, 'zz-accts', 'One') }),
      account('zz-two', { codexHome: join(home, 'zz-accts', 'one') })] }, /accounts\[1\]\.codexHome overlaps/],
    [{ accounts: [account('zz-one', { codexHome: join(home, 'zz-caf\u00e9') }),
      account('zz-two', { codexHome: join(home, 'zz-cafe\u0301') })] }, /accounts\[1\]\.codexHome overlaps/],
    [{ accountsDir: '~/zz-Accounts', codexPath: '~/ZZ-ACCOUNTS/codex' }, /codexPath must not point inside accountsDir/],
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
