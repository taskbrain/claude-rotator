// 口座のフォルダで Codex CLI を起動するときの守り（src/codex/account-config.js）のテスト。
//
// 第1層の指定・第2層の config.toml・起動の型1〜3の照合を確かめる。照合は純粋な関数なので、
// 子プロセスは起動しない（隔離の記録で0回を確かめる）。
//
// 回帰の見本: Codex CLI のジョブを非対話の `codex exec … -` の形で起動するほかのツールの起動の形を、
// そのジョブの組み立て方どおりに写して、全部の組合せが型1に当たることを固定する。そのツールの
// 起動の形が変わったときは、その形を読み直してこの見本を合わせる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACCOUNT_CONFIG_TOML, ALLOWED_CONFIG_OVERRIDES, ALLOWED_SANDBOX_VALUES, ARGUMENT_REJECTED_REASON,
  FIRST_LAYER_ARGS, FORM_REJECTION, LAUNCH_CALLER, LAUNCH_FORM, MODEL_NAME_PATTERN,
  SECOND_LAYER_FEATURES_LINES, SECOND_LAYER_FEATURES_TABLE, SECOND_LAYER_ROOT_LINES,
  formatArgumentRejected, matchLaunchForm,
} from '../../src/codex/account-config.js';
import { readCodexCredentials } from '../../src/codex/credentials.js';
import { setupCodexIsolation } from './helpers/isolation.js';
import { EventEmitter } from 'node:events';
import { chmod, realpath, symlink } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  ARGUMENT_REJECTED_KIND, CODEX_GUARD_CHECK_MAX_STDOUT_BYTES, CODEX_GUARD_CHECK_TIMEOUT_MS,
  GUARD_CHECK_FEATURES_ARGS, GUARD_CHECK_MCP_ARGS, GUARD_UNVERIFIED, GUARD_UNVERIFIED_KIND, NO_DAEMON_ARG,
  buildGuardCheckArgs, buildLaunchArgs, formatGuardUnverified, judgeFeaturesList, judgeMcpList,
  prepareGuardedLaunch, resolveLaunchWorkingDirectory, runGuardCheck,
} from '../../src/codex/account-config.js';
import { findRealCodex } from '../../src/codex/real-codex.js';

const R = FORM_REJECTION;
const IMAGE_REF = 'zz-ref.png';
const MODEL = 'zz-model-1.0';

// そのツールのジョブの組み立て方の写し（ジョブを起動する台本が並べる引数）。
//   exec の種類: exec -s <sandbox> --skip-git-repo-check -c model_reasoning_effort=<r> --json [-m <model>]
//   画像の種類:  同じ並び [-m <model>] [-c features.image_generation=true] [--image <ref>]... --
//   どちらも最後に標準入力の印 `-` を付ける。
function jobRunnerArgs({ kind, sandbox, reasoning, model = '', imageFeature = false, imageRefs = [] }) {
  const args = ['exec', '-s', sandbox, '--skip-git-repo-check', '-c', `model_reasoning_effort=${reasoning}`, '--json'];
  if (model) args.push('-m', model);
  if (kind === 'image') {
    if (imageFeature) args.push('-c', 'features.image_generation=true');
    for (const ref of imageRefs) args.push('--image', ref);
    args.push('--');
  }
  args.push('-');
  return args;
}
// 同じツールの導入の台本が行う疎通の形。
const JOB_RUNNER_SMOKE_ARGS = Object.freeze(['exec', '--skip-git-repo-check', '--json', '-']);

const REVIEW_ARGS = Object.freeze(jobRunnerArgs({ kind: 'exec', sandbox: 'read-only', reasoning: 'high' }));
const IMAGE_ARGS = Object.freeze(jobRunnerArgs({
  kind: 'image', sandbox: 'workspace-write', reasoning: 'medium', imageFeature: true, imageRefs: [IMAGE_REF],
}));

// 通す形の review の並びの、最後の `-` の直前に words を差し込む。
const intoReview = words => [...REVIEW_ARGS.slice(0, -1), ...words, '-'];

function assertAccepted(args, { form = LAUNCH_FORM.exec, configOverrides, caller } = {}) {
  const before = [...args];
  const result = matchLaunchForm(args, caller ? { caller } : undefined);
  assert.equal(result.ok, true, `expected acceptance of ${JSON.stringify(args)}, got ${JSON.stringify(result)}`);
  assert.equal(result.form, form);
  if (configOverrides) assert.deepEqual([...result.configOverrides], configOverrides);
  assert.deepEqual(args, before, 'the arguments are passed through unchanged');
  return result;
}

function assertRejected(args, detail, { caller } = {}) {
  const result = matchLaunchForm(args, caller ? { caller } : undefined);
  assert.equal(result.ok, false, `expected rejection of ${JSON.stringify(args)}`);
  assert.equal(result.reason, ARGUMENT_REJECTED_REASON);
  assert.equal(result.detail, detail, `rejection detail for ${JSON.stringify(args)}`);
  assert.equal(formatArgumentRejected(result.reason), 'argument rejected (form)');
  return result;
}

// --- 第1層・第2層 ----------------------------------------------------------------------------

test('first layer: the three overrides are fixed in this order', () => {
  assert.deepEqual([...FIRST_LAYER_ARGS], [
    '-c', 'cli_auth_credentials_store="file"',
    '-c', 'features.apps=false',
    '-c', 'features.plugins=false',
  ]);
  assert.ok(Object.isFrozen(FIRST_LAYER_ARGS));
});

test('second layer: config.toml has only the credentials store before any table and apps/plugins off', () => {
  const lines = ACCOUNT_CONFIG_TOML.split('\n');
  const settings = lines.filter(line => line.trim() !== '' && !line.startsWith('['));
  assert.deepEqual(settings, ['cli_auth_credentials_store = "file"', 'apps = false', 'plugins = false']);
  assert.deepEqual([...SECOND_LAYER_ROOT_LINES], ['cli_auth_credentials_store = "file"']);
  assert.equal(SECOND_LAYER_FEATURES_TABLE, '[features]');
  assert.deepEqual([...SECOND_LAYER_FEATURES_LINES], ['apps = false', 'plugins = false']);
  const tables = lines.filter(line => line.startsWith('['));
  assert.deepEqual(tables, ['[features]']);
  const firstTable = lines.indexOf('[features]');
  assert.ok(lines.indexOf('cli_auth_credentials_store = "file"') < firstTable, 'store line is before the first table');
  assert.ok(lines.indexOf('apps = false') > firstTable);
  assert.ok(lines.indexOf('plugins = false') > firstTable);
  assert.doesNotMatch(ACCOUNT_CONFIG_TOML, /approval_policy|sandbox_mode/);
  assert.ok(ACCOUNT_CONFIG_TOML.endsWith('\n'));
});

test('second layer: the credentials reader treats the written config.toml as the file store', async t => {
  const isolation = await setupCodexIsolation(t);
  const home = join(isolation.root, 'zz-account');
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(home, 'config.toml'), ACCOUNT_CONFIG_TOML, { mode: 0o600, flag: 'wx' });
  const accountId = 'synthetic-config-account';
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }))
    .toString('base64url');
  const authPath = join(home, 'auth.json');
  await writeFile(authPath, JSON.stringify({ tokens: { id_token: `e30.${claims}.sig`, account_id: accountId } }),
    { mode: 0o600, flag: 'wx' });
  const value = await readCodexCredentials(authPath);
  assert.equal(value.credentialsMode, 'file');
  assert.equal(isolation.spawnCalls.length, 0);
  assert.equal(isolation.refusedChildProcesses.length, 0);
});

// --- 通す形 ----------------------------------------------------------------------------------

test('accepts the stdin prompt form used by the review job', () => {
  assertAccepted(REVIEW_ARGS, { configOverrides: ['model_reasoning_effort=high'] });
  assert.deepEqual([...REVIEW_ARGS],
    ['exec', '-s', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '--json', '-']);
});

test('accepts the review job form with a model name', () => {
  const args = jobRunnerArgs({ kind: 'exec', sandbox: 'read-only', reasoning: 'high', model: MODEL });
  assert.deepEqual(args,
    ['exec', '-s', 'read-only', '--skip-git-repo-check', '-c', 'model_reasoning_effort=high', '--json', '-m', MODEL, '-']);
  assertAccepted(args, { configOverrides: ['model_reasoning_effort=high'] });
});

test('accepts the image job form with a separator before the stdin marker', () => {
  assert.deepEqual([...IMAGE_ARGS], ['exec', '-s', 'workspace-write', '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=medium', '--json', '-c', 'features.image_generation=true',
    '--image', IMAGE_REF, '--', '-']);
  assertAccepted(IMAGE_ARGS, { configOverrides: ['model_reasoning_effort=medium', 'features.image_generation=true'] });
});

test('accepts the image job form without a reference image', () => {
  const args = jobRunnerArgs({ kind: 'image', sandbox: 'workspace-write', reasoning: 'medium', imageFeature: true });
  assert.deepEqual(args, ['exec', '-s', 'workspace-write', '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=medium', '--json', '-c', 'features.image_generation=true', '--', '-']);
  assertAccepted(args);
});

test('accepts the image job form without the image feature override', () => {
  const args = jobRunnerArgs({ kind: 'image', sandbox: 'workspace-write', reasoning: 'medium' });
  assert.deepEqual(args, ['exec', '-s', 'workspace-write', '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=medium', '--json', '--', '-']);
  assertAccepted(args, { configOverrides: ['model_reasoning_effort=medium'] });
});

test('accepts the image job form with a model name', () => {
  const args = jobRunnerArgs({
    kind: 'image', sandbox: 'workspace-write', reasoning: 'medium', model: MODEL, imageFeature: true, imageRefs: [IMAGE_REF],
  });
  assert.deepEqual(args, ['exec', '-s', 'workspace-write', '--skip-git-repo-check',
    '-c', 'model_reasoning_effort=medium', '--json', '-m', MODEL, '-c', 'features.image_generation=true',
    '--image', IMAGE_REF, '--', '-']);
  assertAccepted(args);
});

test('accepts the connectivity check form of the install script of a tool that launches Codex CLI jobs', () => {
  assertAccepted(JOB_RUNNER_SMOKE_ARGS, { configOverrides: [] });
});

test('accepts every combination a tool that launches Codex CLI jobs builds (regression sample)', () => {
  let count = 0;
  for (const kind of ['exec', 'image']) {
    for (const sandbox of ALLOWED_SANDBOX_VALUES) {
      for (const reasoning of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
        for (const model of ['', MODEL, 'gpt-zz/5:mini_x']) {
          for (const imageFeature of kind === 'image' ? [false, true] : [false]) {
            for (const imageRefs of kind === 'image' ? [[], [IMAGE_REF], [IMAGE_REF, 'zz dir/second.webp']] : [[]]) {
              const args = jobRunnerArgs({ kind, sandbox, reasoning, model, imageFeature, imageRefs });
              const expected = [`model_reasoning_effort=${reasoning}`];
              if (imageFeature) expected.push('features.image_generation=true');
              assertAccepted(args, { configOverrides: expected });
              count += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(count, 2 * 5 * 3 * (1 + 2 * 3));
});

test('accepts no arguments as the interactive form', () => {
  assertAccepted([], { form: LAUNCH_FORM.interactive, configOverrides: [] });
});

test('accepts --version alone as the version form for exec', () => {
  assertAccepted(['--version'], { form: LAUNCH_FORM.version, configOverrides: [] });
});

test('accepts the allowed words in any order', () => {
  assertAccepted(['exec', '--json', '-c', 'model_reasoning_effort=low', '--skip-git-repo-check', '-m', MODEL,
    '-s', 'workspace-write', '-'], { configOverrides: ['model_reasoning_effort=low'] });
  assertAccepted(['exec', '-c', 'features.image_generation=true', '--image', IMAGE_REF, '-c',
    'model_reasoning_effort=high', '--image', 'zz-two.png', '--image', 'zz-three.png', '--', '-'],
  { configOverrides: ['features.image_generation=true', 'model_reasoning_effort=high'] });
  assertAccepted(['exec', '-']);
  assertAccepted(['exec', '--', '-']);
});

test('does not change the given arguments and returns frozen results', () => {
  const args = Object.freeze([...IMAGE_ARGS]);
  const result = matchLaunchForm(args);
  assert.equal(result.ok, true);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.configOverrides));
  assert.ok(Object.isFrozen(matchLaunchForm(['zzunknown'])));
});

test('shim selects an account only for the non-interactive exec form and the interactive form', () => {
  assertAccepted(REVIEW_ARGS, { caller: LAUNCH_CALLER.shim });
  assertAccepted(IMAGE_ARGS, { caller: LAUNCH_CALLER.shim });
  assertAccepted([], { caller: LAUNCH_CALLER.shim, form: LAUNCH_FORM.interactive });
  assertRejected(['--version'], R.callerNotAllowed, { caller: LAUNCH_CALLER.shim });
  assertRejected(['resume', '--last'], R.notExec, { caller: LAUNCH_CALLER.shim });
  assert.throws(() => matchLaunchForm([], { caller: 'zz' }), TypeError);
});

// --- 拒否する形: 標準入力の印・区切り・重複 ----------------------------------------------------

test('rejects a job form whose stdin marker is missing, repeated, or not last', () => {
  assertRejected(['exec', '-s', 'read-only', '--json'], R.stdinMarker);
  assertRejected(['exec', '-', '-'], R.stdinMarker);
  assertRejected(['exec', '-', 'zz'], R.stdinMarker);
  assertRejected(['exec'], R.stdinMarker);
  assertRejected(['exec', '-m', '-', '-'], R.stdinMarker);
});

test('rejects a reference image without the separator before the stdin marker', () => {
  assertRejected(['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-c', 'model_reasoning_effort=medium',
    '--json', '-c', 'features.image_generation=true', '--image', IMAGE_REF, '-'], R.missingSeparator);
});

test('rejects a separator that is not directly before the stdin marker', () => {
  assertRejected(['exec', '--', '--json', '-'], R.separatorPosition);
  assertRejected(['exec', '--', '--', '-'], R.separatorPosition);
});

test('rejects the same option given twice', () => {
  assertRejected(intoReview(['-m', MODEL, '-m', MODEL]), R.duplicate);
  assertRejected(intoReview(['-c', 'model_reasoning_effort=low']), R.duplicate);
  assertRejected(['exec', '-c', 'features.image_generation=true', '-c', 'features.image_generation=true', '--', '-'],
    R.duplicate);
  assertRejected(intoReview(['--json']), R.duplicate);
  assertRejected(intoReview(['--skip-git-repo-check']), R.duplicate);
  assertRejected(intoReview(['-s', 'read-only']), R.duplicate);
});

test('rejects an option at the end without its value', () => {
  assertRejected(['exec', '--json', '-m', '-'], R.missingValue);
  assertRejected(['exec', '-s', '-'], R.missingValue);
  assertRejected(['exec', '-c', '-'], R.missingValue);
  assertRejected(['exec', '--image', '-'], R.missingValue);
});

// --- 拒否する形: 文章・副コマンド・未知の語 --------------------------------------------------

test('rejects a prompt given as an argument', () => {
  assertRejected(['exec', 'summarize the diff'], R.stdinMarker);
  assertRejected(['exec', 'summarize'], R.stdinMarker);
  assertRejected(['exec', 'summarize the diff', '-'], R.unknownWord);
});

test('rejects an initial prompt for the interactive session', () => {
  assertRejected(['fix the failing test please'], R.notExec);
  assertRejected(['hello'], R.notExec);
});

test('rejects an unknown word', () => {
  assertRejected(['zzunknown'], R.notExec);
  assertRejected(intoReview(['zzunknown']), R.unknownWord);
});

test('rejects resuming a session', () => {
  assertRejected(['resume', '--last'], R.notExec);
  assertRejected(['exec', 'resume', '--last', '-'], R.unknownWord);
});

test('rejects forking a session', () => {
  assertRejected(['fork', '--last'], R.notExec);
  assertRejected(['exec', 'fork', '--last', '-'], R.unknownWord);
});

test('rejects the review subcommand', () => {
  assertRejected(['review'], R.notExec);
  assertRejected(['exec', 'review', '-'], R.unknownWord);
});

for (const args of [
  ['features', 'list'], ['mcp', 'list', '--json'], ['app-server'], ['remote-control'], ['login'], ['logout'],
  ['plugin', 'list'], ['debug'], ['exec-server'], ['agents'], ['cloud'],
]) {
  test(`rejects the subcommand ${args[0]}`, () => {
    assertRejected(args, R.notExec);
  });
}

test('rejects --version combined with other words', () => {
  assertRejected(['--version', '--json'], R.notExec);
  assertRejected(['exec', '--version', '-'], R.unknownWord);
});

// --- 拒否する形: 作業フォルダ・設定の層・承認・サンドボックスを変える指定 ----------------------

// [名前, 語の並び, 型1の中に置いたときの細目]
const REJECTED_OPTIONS = [
  ['a dangerous sandbox', ['-s', 'danger-full-access'], R.valueShape],
  ['the long sandbox option', ['--sandbox', 'read-only'], R.unknownWord],
  ['the long model option', ['--model', 'zz'], R.unknownWord],
  ['the short image option', ['-i', IMAGE_REF], R.unknownWord],
  ['an option joined with =', ['--config=model_reasoning_effort=high'], R.unknownWord],
  ['a working directory override', ['-C', 'zz-dir'], R.unknownWord],
  ['the long working directory override', ['--cd', 'zz-dir'], R.unknownWord],
  ['a worktree', ['--worktree'], R.unknownWord],
  ['an extra writable directory', ['--add-dir', 'zz-dir'], R.unknownWord],
  ['a profile', ['-p', 'zz'], R.unknownWord],
  ['the long profile option', ['--profile', 'zz'], R.unknownWord],
  ['a remote', ['--remote', 'zz'], R.unknownWord],
  ['a remote auth token variable', ['--remote-auth-token-env', 'ZZ_TOKEN_VAR'], R.unknownWord],
  ['an approval policy', ['-a', 'never'], R.unknownWord],
  ['approving on behalf of the user', ['--approve-for-me'], R.unknownWord],
  ['bypassing approvals and the sandbox', ['--dangerously-bypass-approvals-and-sandbox'], R.unknownWord],
  ['bypassing hook trust', ['--dangerously-bypass-hook-trust'], R.unknownWord],
  ['ignoring the user config', ['--ignore-user-config'], R.unknownWord],
  ['ignoring rules', ['--ignore-rules'], R.unknownWord],
  ['enabling a feature', ['--enable', 'apps'], R.unknownWord],
  ['disabling a feature', ['--disable', 'apps'], R.unknownWord],
  ['a user supplied --no-daemon', ['--no-daemon'], R.unknownWord],
];

for (const [name, words, embeddedDetail] of REJECTED_OPTIONS) {
  test(`rejects ${name}`, () => {
    assertRejected(words, R.notExec);
    assertRejected(intoReview(words), embeddedDetail);
    assertRejected(['exec', ...words, '-'], embeddedDetail);
  });
}

// --- 拒否する形: 表に無い -c ------------------------------------------------------------------

// [名前, -c の値, 細目]
const REJECTED_CONFIG_OVERRIDES = [
  ['enabling apps', 'features.apps=true', R.configKey],
  ['enabling connectors', 'features.connectors=true', R.configKey],
  ['overriding the credentials store', 'cli_auth_credentials_store=keyring', R.configKey],
  ['trusting a project', 'projects."/zz".trust_level="trusted"', R.configKey],
  ['adding an MCP server', 'mcp_servers.zz.command=true', R.configKey],
  ['an approval policy override', 'approval_policy=never', R.configKey],
  ['a model override', 'model=zz', R.configKey],
  ['a reasoning effort value with a space', 'model_reasoning_effort= high', R.valueShape],
  ['disabling image generation', 'features.image_generation=false', R.valueShape],
];

for (const [name, value, detail] of REJECTED_CONFIG_OVERRIDES) {
  test(`rejects ${name} through -c`, () => {
    assertRejected(['-c', value], R.notExec);
    assertRejected(['exec', '-c', value, '-'], detail);
    assertRejected(intoReview(['-c', value]), detail);
  });
}

test('rejects -c values that only resemble an allowed key', () => {
  assertRejected(['exec', '-c', 'model_reasoning_effort_extra=high', '-'], R.configKey);
  assertRejected(['exec', '-c', 'model_reasoning_effort=HIGH', '-'], R.valueShape);
  assertRejected(['exec', '-c', 'model_reasoning_effort=', '-'], R.valueShape);
  assertRejected(['exec', '-c', 'model_reasoning_effort="high"', '-'], R.valueShape);
  assertRejected(['exec', '-c', 'features.image_generation=True', '-'], R.valueShape);
  assertRejected(['exec', '-c', ' model_reasoning_effort=high', '-'], R.configKey);
});

// --- 拒否する形: 語の完全一致 ----------------------------------------------------------------

test('matches each word exactly, including whitespace, quotes, and case', () => {
  assertRejected(['exec', '--json', ' -'], R.stdinMarker);
  assertRejected(['exec', '--JSON', '-'], R.unknownWord);
  assertRejected(['exec', ' --json', '-'], R.unknownWord);
  assertRejected(['exec', '-s', "'read-only'", '-'], R.valueShape);
  assertRejected(['exec', '-s', 'Read-Only', '-'], R.valueShape);
  assertRejected(['EXEC', '-'], R.notExec);
  assertRejected([' exec', '-'], R.notExec);
  assertRejected(['--Version'], R.notExec);
  assertRejected(['"--version"'], R.notExec);
  assertRejected(['exec', '"-"'], R.stdinMarker);
  assertRejected(['exec', ''], R.stdinMarker);
  assertRejected(['exec', '', '-'], R.unknownWord);
  assertRejected([''], R.notExec);
});

test('rejects model names and image paths outside the allowed shapes', () => {
  assert.ok(MODEL_NAME_PATTERN.test(MODEL));
  assertRejected(intoReview(['-m', '-zz']), R.valueShape);
  assertRejected(intoReview(['-m', 'zz model']), R.valueShape);
  assertRejected(intoReview(['-m', '']), R.valueShape);
  assertRejected(intoReview(['-m', '.zz']), R.valueShape);
  assertRejected(['exec', '--image', '--json', '--', '-'], R.valueShape);
  assertRejected(['exec', '--image', '', '--', '-'], R.valueShape);
  assertRejected(['exec', '--image', '--', '-'], R.valueShape);
});

test('rejects input that is not a list of words', () => {
  assertRejected('exec -', R.notWords);
  assertRejected(null, R.notWords);
  assertRejected(undefined, R.notWords);
  assertRejected(['exec', 1, '-'], R.notWords);
});

// --- 表と拒否の行 ----------------------------------------------------------------------------

test('the pass-through key table has exactly the two keys a tool that launches Codex CLI jobs passes', () => {
  assert.deepEqual(ALLOWED_CONFIG_OVERRIDES.map(entry => entry.key), ['model_reasoning_effort', 'features.image_generation']);
  assert.deepEqual([...ALLOWED_SANDBOX_VALUES], ['read-only', 'workspace-write']);
});

test('the rejection line carries only the kind word and never the rejected values', () => {
  assert.equal(formatArgumentRejected(), 'argument rejected (form)');
  const secretish = 'zz-secret-marker-ZZ-PATH-MARKER';
  for (const args of [['-C', secretish], ['exec', '-c', `mcp_servers.${secretish}.command=true`, '-'], [secretish]]) {
    const result = matchLaunchForm(args);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(secretish), 'the result has no argument value');
    assert.ok(!formatArgumentRejected(result.reason).includes(secretish));
    assert.ok(Object.values(FORM_REJECTION).includes(result.detail));
  }
});

test('matching never starts a child process', async t => {
  const isolation = await setupCodexIsolation(t);
  matchLaunchForm(REVIEW_ARGS);
  matchLaunchForm(IMAGE_ARGS);
  matchLaunchForm([]);
  matchLaunchForm(['--version']);
  matchLaunchForm(['resume', '--last']);
  assert.equal(isolation.spawnCalls.length, 0);
  assert.equal(isolation.refusedChildProcesses.length, 0);
});

// === 起動の引数の組立・--no-daemon・起動ごとの点検 ================================================
//
// 点検は本物の codex を起動しない。起動の関数を差し替え、偽の子プロセスの出力で判定を確かめる。
// MCP サーバが0件の偽の出力は、Codex CLI の版 0.157.1 が空のときに出すのと同じバイト列（`[]` と改行）。
// 1件の偽の出力と features list の偽の出力は合成のもので、実機の形との突き合わせは実機で行う。

const MCP_EMPTY_STDOUT = '[]\n';
const MCP_ONE_STDOUT = `${JSON.stringify([{ name: 'zz-server', enabled: true, transport: { type: 'stdio', command: 'zz-cmd' } }])}\n`;
const featuresStdout = ({ apps = 'false', plugins = 'false' } = {}) =>
  `zz_other_feature   stable   true\napps   stable   ${apps}\nplugins   stable   ${plugins}\n`;
const FEATURES_OK_STDOUT = featuresStdout();
const OUTPUT_MARKER = 'ZZ-OUTPUT-MARKER';
const FAKE_CODEX_BODY = '#!/bin/sh\n# zz-fake codex for tests (never executed)\n';

/**
 * 偽の子プロセス。標準出力の data → close(code, signal) の順に出来事を起こす。error なら error だけ。
 * hang なら close を起こさない。kill は記録し、止まった子として close を起こす。
 */
function fakeCheckChild({ stdout = [], code = 0, signal = null, error = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kills = [];
  child.kill = sig => {
    child.kills.push(sig);
    setImmediate(() => child.emit('close', null, sig));
    return true;
  };
  setImmediate(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    for (const text of stdout) child.stdout.emit('data', Buffer.from(text));
    if (!hang) child.emit('close', code, signal);
  });
  return child;
}

/** 期限の記録。fireAtOnce なら、片付けられていない期限をすぐ（次の setImmediate で）起こす。 */
function checkScheduler({ fireAtOnce = false } = {}) {
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      const handle = { cleared: false, unref() {} };
      if (fireAtOnce) setImmediate(() => { if (!handle.cleared) fn(); });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cleared = true;
    },
  };
}

const isFeaturesCheck = args => args.at(-2) === 'features' && args.at(-1) === 'list';

/**
 * 隔離・PATH に置いた偽の codex（起動はしない）・本物の codex の絶対パスの決め方で得たパス・
 * 作業フォルダとそのシンボリックリンク・起動の差し替え。
 */
async function guardHarness(t, { features = () => fakeCheckChild({ stdout: [FEATURES_OK_STDOUT] }),
  mcp = () => fakeCheckChild({ stdout: [MCP_EMPTY_STDOUT] }), scheduler = checkScheduler() } = {}) {
  const isolation = await setupCodexIsolation(t);
  const binDir = join(isolation.root, 'zz-bin');
  await mkdir(binDir, { mode: 0o700 });
  await writeFile(join(binDir, 'codex'), FAKE_CODEX_BODY, { flag: 'wx' });
  await chmod(join(binDir, 'codex'), 0o755);
  const found = findRealCodex({ env: { ...isolation.env, PATH: binDir } });
  assert.equal(found.reason, null);
  const codexPath = found.path;
  const codexHome = join(isolation.root, 'zz-accounts', 'zz-one');
  const workDir = join(isolation.root, 'zz-work');
  await mkdir(workDir, { mode: 0o700 });
  const realWorkDir = await realpath(workDir);
  const linkDir = join(isolation.root, 'zz-work-link');
  await symlink(workDir, linkDir);
  const env = Object.freeze({ ...isolation.env, ZZ_ENV_MARK: 'zz-env' });
  const children = [];
  isolation.registerSpawn(codexPath, (args, options) => {
    const child = (isFeaturesCheck(args) ? features : mcp)(args, options);
    children.push(child);
    return child;
  });
  const run = (args, extra = {}) => prepareGuardedLaunch({
    args, codexPath, codexHome, env, spawn: isolation.spawn, scheduler, processCwd: () => linkDir, ...extra,
  });
  return { isolation, codexPath, codexHome, env, realWorkDir, linkDir, children, scheduler, run };
}

function assertUnverified(result, reason) {
  assert.equal(result.ok, false, `expected the guard check to stop with ${reason}`);
  assert.equal(result.kind, GUARD_UNVERIFIED_KIND);
  assert.equal(result.reason, reason);
  assert.equal(result.launch, undefined, 'nothing to launch');
  assert.equal(formatGuardUnverified(result.reason), `guard unverified (${reason})`);
  assert.ok(Object.isFrozen(result));
}

// --- 起動の引数の組立と --no-daemon ------------------------------------------------------------

test('adds --no-daemon once, right after the first layer, only for the interactive form', () => {
  assert.equal(NO_DAEMON_ARG, '--no-daemon');
  for (const caller of [LAUNCH_CALLER.exec, LAUNCH_CALLER.shim]) {
    const built = buildLaunchArgs([], { caller });
    assert.equal(built.ok, true);
    assert.equal(built.form, LAUNCH_FORM.interactive);
    assert.deepEqual([...built.launchArgs], [...FIRST_LAYER_ARGS, '--no-daemon']);
    assert.equal(built.launchArgs.indexOf('--no-daemon'), FIRST_LAYER_ARGS.length);
    assert.equal(built.launchArgs.filter(word => word === '--no-daemon').length, 1);
    assert.ok(Object.isFrozen(built) && Object.isFrozen(built.launchArgs));
  }
});

test('does not add --no-daemon to the non-interactive exec form or the version form', () => {
  const cases = [
    [REVIEW_ARGS, LAUNCH_FORM.exec],
    [IMAGE_ARGS, LAUNCH_FORM.exec],
    [JOB_RUNNER_SMOKE_ARGS, LAUNCH_FORM.exec],
    [jobRunnerArgs({ kind: 'exec', sandbox: 'read-only', reasoning: 'high', model: MODEL }), LAUNCH_FORM.exec],
    [['--version'], LAUNCH_FORM.version],
  ];
  for (const [args, form] of cases) {
    const before = [...args];
    const built = buildLaunchArgs(args);
    assert.equal(built.ok, true);
    assert.equal(built.form, form);
    assert.deepEqual([...built.launchArgs], [...FIRST_LAYER_ARGS, ...args], 'first layer, then the arguments unchanged');
    assert.ok(!built.launchArgs.includes('--no-daemon'));
    assert.deepEqual([...args], before);
  }
});

test('building launch arguments returns the rejection unchanged for arguments outside the forms', () => {
  const rejected = buildLaunchArgs(['--no-daemon']);
  assert.deepEqual(rejected, matchLaunchForm(['--no-daemon']));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.launchArgs, undefined);
  assert.equal(buildLaunchArgs(['--version'], { caller: LAUNCH_CALLER.shim }).detail, R.callerNotAllowed);
  assert.equal(buildLaunchArgs(['resume', '--last']).detail, R.notExec);
});

// --- 点検の引数 ------------------------------------------------------------------------------

test('guard check arguments: first layer, then the job -c values in the same order, then the subcommand', () => {
  assert.deepEqual([...GUARD_CHECK_FEATURES_ARGS], ['features', 'list']);
  assert.deepEqual([...GUARD_CHECK_MCP_ARGS], ['mcp', 'list', '--json']);
  const overrides = ['model_reasoning_effort=medium', 'features.image_generation=true'];
  const built = buildGuardCheckArgs(overrides);
  const head = [...FIRST_LAYER_ARGS, '-c', 'model_reasoning_effort=medium', '-c', 'features.image_generation=true'];
  assert.deepEqual([...built.featuresList], [...head, 'features', 'list']);
  assert.deepEqual([...built.mcpList], [...head, 'mcp', 'list', '--json']);
  const reversed = buildGuardCheckArgs([...overrides].reverse());
  assert.deepEqual([...reversed.featuresList.slice(FIRST_LAYER_ARGS.length, -2)],
    ['-c', 'features.image_generation=true', '-c', 'model_reasoning_effort=medium']);
  assert.deepEqual([...buildGuardCheckArgs().featuresList], [...FIRST_LAYER_ARGS, 'features', 'list']);
  assert.ok(Object.isFrozen(built) && Object.isFrozen(built.featuresList) && Object.isFrozen(built.mcpList));
});

test('guard check arguments never include a model-using argument', () => {
  const built = buildGuardCheckArgs(['model_reasoning_effort=high', 'features.image_generation=true']);
  for (const args of [built.featuresList, built.mcpList]) {
    for (const word of ['exec', '-', '--', '-m', '-s', '--image', '--json', '--skip-git-repo-check', '--no-daemon']) {
      if (word === '--json' && args === built.mcpList) continue; // mcp list の出力の形の指定
      assert.ok(!args.includes(word), `${word} is not a check argument`);
    }
  }
});

test('guard check arguments without the first layer keep only the job -c values', () => {
  const built = buildGuardCheckArgs(['model_reasoning_effort=low'], { includeFirstLayer: false });
  assert.deepEqual([...built.featuresList], ['-c', 'model_reasoning_effort=low', 'features', 'list']);
  assert.deepEqual([...built.mcpList], ['-c', 'model_reasoning_effort=low', 'mcp', 'list', '--json']);
});

test('guard check arguments refuse -c values outside the pass-through table', () => {
  for (const value of ['features.apps=true', 'model=zz', 'model_reasoning_effort= high', 1]) {
    assert.throws(() => buildGuardCheckArgs([value]), TypeError);
  }
  assert.throws(() => buildGuardCheckArgs('model_reasoning_effort=high'), TypeError);
});

// --- 出力の判定 ------------------------------------------------------------------------------

test('features list passes only when apps and plugins each appear once and end with false', () => {
  assert.equal(judgeFeaturesList(FEATURES_OK_STDOUT), null);
  assert.equal(judgeFeaturesList('apps false\nplugins false'), null);
  assert.equal(judgeFeaturesList('  apps\t\tstable  false  \r\n\r\nplugins  under development  false\r\n'), null);
  assert.equal(judgeFeaturesList('plugins x false\napps y false\nzz_apps z true\n'), null);
});

test('features list reports feature-enabled when apps or plugins is true', () => {
  assert.equal(judgeFeaturesList(featuresStdout({ apps: 'true' })), GUARD_UNVERIFIED.featureEnabled);
  assert.equal(judgeFeaturesList(featuresStdout({ plugins: 'true' })), GUARD_UNVERIFIED.featureEnabled);
  assert.equal(judgeFeaturesList(featuresStdout({ apps: 'true', plugins: 'true' })), GUARD_UNVERIFIED.featureEnabled);
});

test('features list reports output-format for a missing, repeated, or non-boolean row', () => {
  for (const text of [
    '', '\n\n', 'plugins stable false\n', 'apps stable false\n',
    'apps stable false\napps stable false\nplugins stable false\n',
    'apps stable false\nplugins stable false\nplugins stable true\n',
    featuresStdout({ apps: 'False' }), featuresStdout({ plugins: 'yes' }), featuresStdout({ apps: '0' }),
    'apps\nplugins stable false\n', 'apps stable false\nplugins\n', null, undefined, 1,
  ]) {
    assert.equal(judgeFeaturesList(text), GUARD_UNVERIFIED.outputFormat, `format of ${JSON.stringify(text)}`);
  }
  // 形の違いは、有効の検出より先に見る。
  assert.equal(judgeFeaturesList('apps stable true\n'), GUARD_UNVERIFIED.outputFormat);
});

test('mcp list passes only an empty JSON array', () => {
  assert.equal(judgeMcpList(MCP_EMPTY_STDOUT), null);
  assert.equal(judgeMcpList('[]'), null);
  assert.equal(judgeMcpList(' [ ] \n'), null);
});

test('mcp list reports mcp-present for one or more servers', () => {
  assert.equal(judgeMcpList(MCP_ONE_STDOUT), GUARD_UNVERIFIED.mcpPresent);
  assert.equal(judgeMcpList('[{}, {}]'), GUARD_UNVERIFIED.mcpPresent);
  assert.equal(judgeMcpList('[null]'), GUARD_UNVERIFIED.mcpPresent);
});

test('mcp list reports output-format for anything that is not a JSON array', () => {
  for (const text of ['', '{}', 'null', '"[]"', '0', 'no servers', '[] zz', '[', null, undefined]) {
    assert.equal(judgeMcpList(text), GUARD_UNVERIFIED.outputFormat, `format of ${JSON.stringify(text)}`);
  }
});

// --- 点検の起動 ------------------------------------------------------------------------------

test('a clean guard check starts features list then mcp list, then returns the launch', async t => {
  const h = await guardHarness(t);
  const result = await h.run(REVIEW_ARGS);
  assert.equal(result.ok, true);
  assert.equal(result.form, LAUNCH_FORM.exec);
  const calls = h.isolation.spawnCalls;
  assert.equal(calls.length, 2, 'only the two checks are started (the child is left to the caller)');
  const expected = buildGuardCheckArgs(['model_reasoning_effort=high']);
  assert.deepEqual(calls[0].args, [...expected.featuresList]);
  assert.deepEqual(calls[1].args, [...expected.mcpList]);
  for (const call of calls) {
    assert.equal(call.command, h.codexPath);
    assert.ok(isAbsolute(call.command));
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'ignore']);
    assert.equal(call.options.cwd, h.realWorkDir);
    assert.equal(call.options.env.CODEX_HOME, h.codexHome);
    assert.equal(call.options.env.ZZ_ENV_MARK, 'zz-env');
  }
  assert.deepEqual(h.scheduler.delays, [CODEX_GUARD_CHECK_TIMEOUT_MS, CODEX_GUARD_CHECK_TIMEOUT_MS]);
  assert.equal(CODEX_GUARD_CHECK_TIMEOUT_MS, 3000);
  assert.equal(result.launch.command, h.codexPath);
  assert.deepEqual([...result.launch.args], [...FIRST_LAYER_ARGS, ...REVIEW_ARGS]);
  assert.equal(result.launch.options.shell, false);
  assert.equal(result.launch.options.cwd, h.realWorkDir, 'the child gets the same working directory as the checks');
  assert.equal(result.launch.options.env.CODEX_HOME, h.codexHome);
  assert.equal(h.env.CODEX_HOME, h.isolation.env.CODEX_HOME, 'the given environment is not changed');
  assert.ok(h.children.every(child => child.kills.length === 0));
  assert.equal(h.isolation.refusedChildProcesses.length, 0);
  assert.equal(h.isolation.refusedSpawns.length, 0);
});

test('the guard check working directory is the real path of the exec working directory', async t => {
  const h = await guardHarness(t);
  assert.notEqual(h.linkDir, h.realWorkDir);
  assert.equal(resolveLaunchWorkingDirectory({ processCwd: () => h.linkDir }), h.realWorkDir);
  assert.equal(resolveLaunchWorkingDirectory(), realpathSync.native(process.cwd()));
  const result = await h.run(IMAGE_ARGS);
  assert.equal(result.ok, true);
  const cwds = [...h.isolation.spawnCalls.map(call => call.options.cwd), result.launch.options.cwd];
  assert.deepEqual(cwds, [h.realWorkDir, h.realWorkDir, h.realWorkDir]);
});

test('the image job form passes both -c values to both checks in the same order', async t => {
  const h = await guardHarness(t);
  const result = await h.run(IMAGE_ARGS);
  assert.equal(result.ok, true);
  const head = [...FIRST_LAYER_ARGS, '-c', 'model_reasoning_effort=medium', '-c', 'features.image_generation=true'];
  assert.deepEqual(h.isolation.spawnCalls[0].args, [...head, 'features', 'list']);
  assert.deepEqual(h.isolation.spawnCalls[1].args, [...head, 'mcp', 'list', '--json']);
  assert.deepEqual([...result.launch.args], [...FIRST_LAYER_ARGS, ...IMAGE_ARGS]);
});

test('the interactive form launches with --no-daemon and the version form without it after the checks', async t => {
  const h = await guardHarness(t);
  const interactive = await h.run([]);
  assert.equal(interactive.ok, true);
  assert.deepEqual([...interactive.launch.args], [...FIRST_LAYER_ARGS, '--no-daemon']);
  const version = await h.run(['--version']);
  assert.equal(version.ok, true);
  assert.deepEqual([...version.launch.args], [...FIRST_LAYER_ARGS, '--version']);
  for (const call of h.isolation.spawnCalls) {
    assert.deepEqual(call.args.slice(0, FIRST_LAYER_ARGS.length), [...FIRST_LAYER_ARGS]);
    assert.ok(!call.args.includes('--no-daemon') && !call.args.includes('--version'));
  }
  assert.equal(h.isolation.spawnCalls.length, 4);
});

test('a rejected argument list starts no check', async t => {
  const h = await guardHarness(t);
  for (const [args, caller, detail] of [
    [['resume', '--last'], undefined, R.notExec],
    [['exec', 'summarize the diff', '-'], undefined, R.unknownWord],
    [['--no-daemon'], undefined, R.notExec],
    [['--version'], LAUNCH_CALLER.shim, R.callerNotAllowed],
  ]) {
    const result = await h.run(args, { caller });
    assert.equal(result.ok, false);
    assert.equal(result.kind, ARGUMENT_REJECTED_KIND);
    assert.equal(result.reason, ARGUMENT_REJECTED_REASON);
    assert.equal(result.detail, detail);
    assert.equal(result.launch, undefined);
  }
  assert.equal(h.isolation.spawnCalls.length, 0);
});

test('an unresolvable working directory starts no check and stops with exit', async t => {
  const h = await guardHarness(t);
  const result = await h.run(REVIEW_ARGS, { processCwd: () => { throw new Error(OUTPUT_MARKER); } });
  assertUnverified(result, GUARD_UNVERIFIED.exit);
  const missing = await h.run(REVIEW_ARGS, { processCwd: () => join(h.linkDir, 'zz-absent') });
  assertUnverified(missing, GUARD_UNVERIFIED.exit);
  assert.equal(h.isolation.spawnCalls.length, 0);
  assert.ok(!JSON.stringify(result).includes(OUTPUT_MARKER));
});

// [名前, 点検の振る舞い（fireAtOnce は期限をすぐ起こすか）, 理由, 起動する点検の数, 最後の点検の子を止めるか]
const tooLargeStdout = `${'z'.repeat(CODEX_GUARD_CHECK_MAX_STDOUT_BYTES)}${OUTPUT_MARKER}`;
const GUARD_STOP_CASES = [
  ['apps is true', { features: () => fakeCheckChild({ stdout: [featuresStdout({ apps: 'true' })] }) },
    GUARD_UNVERIFIED.featureEnabled, 1],
  ['plugins is true', { features: () => fakeCheckChild({ stdout: [featuresStdout({ plugins: 'true' })] }) },
    GUARD_UNVERIFIED.featureEnabled, 1],
  ['an MCP server is configured', { mcp: () => fakeCheckChild({ stdout: [MCP_ONE_STDOUT] }) },
    GUARD_UNVERIFIED.mcpPresent, 2],
  ['the features rows are missing', { features: () => fakeCheckChild({ stdout: [`${OUTPUT_MARKER}\n`] }) },
    GUARD_UNVERIFIED.outputFormat, 1],
  ['the same feature appears twice',
    { features: () => fakeCheckChild({ stdout: [`${FEATURES_OK_STDOUT}apps stable false\n`] }) },
    GUARD_UNVERIFIED.outputFormat, 1],
  ['the last field is not a boolean', { features: () => fakeCheckChild({ stdout: [featuresStdout({ apps: OUTPUT_MARKER })] }) },
    GUARD_UNVERIFIED.outputFormat, 1],
  ['mcp list is not a JSON array', { mcp: () => fakeCheckChild({ stdout: ['{}\n'] }) },
    GUARD_UNVERIFIED.outputFormat, 2],
  ['mcp list is not JSON', { mcp: () => fakeCheckChild({ stdout: [`${OUTPUT_MARKER}\n`] }) },
    GUARD_UNVERIFIED.outputFormat, 2],
  ['features list exits non-zero', { features: () => fakeCheckChild({ stdout: [FEATURES_OK_STDOUT], code: 1 }) },
    GUARD_UNVERIFIED.exit, 1],
  ['mcp list exits non-zero', { mcp: () => fakeCheckChild({ stdout: [MCP_EMPTY_STDOUT], code: 2 }) },
    GUARD_UNVERIFIED.exit, 2],
  ['a check ends by a signal', { features: () => fakeCheckChild({ stdout: [FEATURES_OK_STDOUT], code: null, signal: 'SIGTERM' }) },
    GUARD_UNVERIFIED.exit, 1],
  ['a check fails to start', { features: () => fakeCheckChild({ error: new Error(OUTPUT_MARKER) }) },
    GUARD_UNVERIFIED.exit, 1, true],
  ['starting a check throws', { features: () => { throw new Error(OUTPUT_MARKER); } }, GUARD_UNVERIFIED.exit, 1],
  ['features list does not finish in time', { features: () => fakeCheckChild({ hang: true }), fireAtOnce: true },
    GUARD_UNVERIFIED.timeout, 1, true],
  ['mcp list does not finish in time', { mcp: () => fakeCheckChild({ hang: true }), fireAtOnce: true },
    GUARD_UNVERIFIED.timeout, 2, true],
  ['features list prints too much', { features: () => fakeCheckChild({ stdout: [tooLargeStdout] }) },
    GUARD_UNVERIFIED.tooLarge, 1, true],
  ['mcp list prints too much', { mcp: () => fakeCheckChild({ stdout: ['[', tooLargeStdout] }) },
    GUARD_UNVERIFIED.tooLarge, 2, true],
];

for (const [name, { features, mcp, fireAtOnce = false }, reason, started, killed = false] of GUARD_STOP_CASES) {
  test(`the guard check stops with ${reason} when ${name}`, async t => {
    const h = await guardHarness(t, { features, mcp, scheduler: checkScheduler({ fireAtOnce }) });
    const result = await h.run(REVIEW_ARGS);
    assertUnverified(result, reason);
    assert.equal(h.isolation.spawnCalls.length, started, 'the later check is not started after a failure');
    const last = h.children.at(-1);
    if (last) assert.deepEqual(last.kills, killed ? ['SIGKILL'] : [], 'a check that ran over is stopped');
    assert.ok(!JSON.stringify(result).includes(OUTPUT_MARKER), 'the result has no output or error text');
    assert.equal(h.isolation.refusedChildProcesses.length, 0);
  });
}

test('every guard check reason word can be produced', () => {
  const produced = new Set(GUARD_STOP_CASES.map(entry => entry[2]));
  assert.deepEqual([...produced].sort(), Object.values(GUARD_UNVERIFIED).sort());
  assert.deepEqual(Object.values(GUARD_UNVERIFIED).sort(),
    ['exit', 'feature-enabled', 'mcp-present', 'output-format', 'timeout', 'too-large']);
});

test('the guard check reads standard output up to exactly the limit', async t => {
  assert.equal(CODEX_GUARD_CHECK_MAX_STDOUT_BYTES, 64 * 1024);
  const padding = ' '.repeat(CODEX_GUARD_CHECK_MAX_STDOUT_BYTES - Buffer.byteLength(FEATURES_OK_STDOUT));
  const exact = `${FEATURES_OK_STDOUT}${padding}`;
  assert.equal(Buffer.byteLength(exact), CODEX_GUARD_CHECK_MAX_STDOUT_BYTES);
  const half = exact.length / 2;
  const h = await guardHarness(t, {
    features: () => fakeCheckChild({ stdout: [exact.slice(0, half), exact.slice(half)] }),
  });
  const result = await h.run(REVIEW_ARGS);
  assert.equal(result.ok, true);
});

test('the guard check without the first layer starts the checks with only the job -c values', async t => {
  const h = await guardHarness(t);
  const result = await runGuardCheck({
    codexPath: h.codexPath, codexHome: h.codexHome, cwd: h.realWorkDir, env: h.env, spawn: h.isolation.spawn,
    scheduler: h.scheduler, configOverrides: ['model_reasoning_effort=high'], includeFirstLayer: false,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.isolation.spawnCalls.map(call => call.args), [
    ['-c', 'model_reasoning_effort=high', 'features', 'list'],
    ['-c', 'model_reasoning_effort=high', 'mcp', 'list', '--json'],
  ]);
  assert.ok(h.isolation.spawnCalls.every(call => call.options.env.CODEX_HOME === h.codexHome));
});

test('the guard check refuses relative paths and a missing environment before starting anything', async t => {
  const h = await guardHarness(t);
  const base = { codexPath: h.codexPath, codexHome: h.codexHome, cwd: h.realWorkDir, env: h.env, spawn: h.isolation.spawn };
  for (const override of [{ codexPath: 'codex' }, { codexHome: 'zz-home' }, { cwd: 'zz-work' }, { env: null }]) {
    await assert.rejects(runGuardCheck({ ...base, ...override }), TypeError);
  }
  for (const override of [{ codexPath: 'codex' }, { codexHome: 'zz-home' }, { env: undefined }]) {
    await assert.rejects(prepareGuardedLaunch({
      args: REVIEW_ARGS, codexPath: h.codexPath, codexHome: h.codexHome, env: h.env, spawn: h.isolation.spawn, ...override,
    }), TypeError);
  }
  assert.equal(h.isolation.spawnCalls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// README の守りの節（日英）と実装の突き合わせ
// ---------------------------------------------------------------------------------------------

// README はリポジトリの根のものを、このファイルの場所から読む（テストの作業フォルダに依らない）。
const readReadme = () => readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

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

const README_GUARD_SECTIONS = Object.freeze([
  Object.freeze({ heading: '### 口座のフォルダで起動したときの守り', reason: '<理由>', seconds: n => `${n} 秒` }),
  Object.freeze({ heading: '#### Guards When Codex Runs in an Account Folder', reason: '<reason>', seconds: n => `${n} seconds` }),
]);

test('the README guard sections in Japanese and English carry the guards that the implementation applies', () => {
  const readme = readReadme();
  for (const { heading, reason, seconds } of README_GUARD_SECTIONS) {
    const section = readmeSection(readme, heading);
    const has = (text, what) => assert.ok(section.includes(text), `${heading}: ${what}: ${text}`);
    // 第1層は1つのコードの囲みに、この順で並ぶ。第2層は login が書く config.toml の全文と同じ。
    assert.ok(fencedBlocks(section, 'text').includes(`${FIRST_LAYER_ARGS.join(' ')}\n`), `${heading}: the first layer`);
    assert.deepEqual(fencedBlocks(section, 'toml'), [ACCOUNT_CONFIG_TOML], `${heading}: the second layer`);
    // 起動の型（型1の -s の値と通すキー、型3の語）と、型に当たらないときの1行。
    for (const value of ALLOWED_SANDBOX_VALUES) has(`\`${value}\``, 'a sandbox value of the first form');
    for (const { key } of ALLOWED_CONFIG_OVERRIDES) has(`-c ${key}=`, 'a pass-through config key of the first form');
    has('`--version`', 'the third form');
    has(formatArgumentRejected(), 'the rejection line');
    has(`\`${NO_DAEMON_ARG}\``, 'the option added to the interactive form');
    // 起動ごとの点検の2つの副コマンド・期限・読む上限と、通らなかったときの1行と理由の語の表。
    has(`codex ${GUARD_CHECK_FEATURES_ARGS.join(' ')}`, 'the features check');
    has(`codex ${GUARD_CHECK_MCP_ARGS.join(' ')}`, 'the MCP check');
    has(seconds(CODEX_GUARD_CHECK_TIMEOUT_MS / 1000), 'the time limit of each check');
    has(`${CODEX_GUARD_CHECK_MAX_STDOUT_BYTES / 1024} KiB`, 'the standard output limit of each check');
    has(formatGuardUnverified(reason), 'the guard unverified line');
    const tableWords = section.split('\n').map(line => /^\s*\| `([a-z-]+)` \|/.exec(line)?.[1]).filter(Boolean);
    assert.deepEqual(tableWords, Object.values(GUARD_UNVERIFIED), `${heading}: one table row per reason, in order`);
  }
});
