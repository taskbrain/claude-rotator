// `codex-rotator status`（src/codex/direct-read.js の runStatus と、入口の振り分け）のテスト。3つの形の出力、
// 無効のとき、常駐が無いときの既定の番号への問い合わせ、秘密とパスの目印が出ないこと、ログイン切れの口座の
// 出方、口座の並び順（order）、README の節との突き合わせを確かめる。
//
// 絶対条件: 実のホーム・実の設定・実の口座・~/.codex には触れない。env は隔離の補助の一時フォルダのもので、
// 設定・口座のフォルダ・偽の資格情報はすべてその中に作る。本物の codex は起動しない（版の読取は隔離の補助の
// spawn に登録した偽物だけが答える）。使用量の読取は偽の fetch だけを使い、常駐への要求は隔離の補助の
// 要求関数を通す（登録していない番号は開く手前で拒否される）。偽の資格情報と上流の応答の中身は合成の値。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/codex/cli.js';
import { DEFAULT_DAEMON_PORT } from '../../src/codex/config.js';
import { STATUS_LINE, STATUS_USAGE, runStatus } from '../../src/codex/direct-read.js';
import { aggregateCodexAccounts, codexAccountHeadroom } from '../../src/codex/snapshot.js';
import { codexRotatorConfigDir, codexRotatorConfigPath } from '../../src/codex/paths.js';
import {
  CODEX_SECTION_DEADLINE_MS, CODEX_CHILD_TIMEOUT_MS, codexStatusProblem,
} from '../../src/shared/codex-status-schema.js';
import { CODEX_DISABLED_TEXT, renderCodexSection } from '../../src/shared/codex-view.js';
import { terminalPadEnd } from '../../src/shared/terminal-text.js';
import { DEFAULT_PORT as CLAUDE_DEFAULT_PORT } from '../../src/config.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const FIXED_NOW_MS = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const HEADING = terminalPadEnd('Codex Rotator', 39);
// パスに含める合成の目印（どの出力にも出てはならない）。
const PATH_MARKER = 'ZZ-PATH-MARKER';
// 偽の資格情報と上流の応答に入れる合成の値（どの出力にも出てはならない）。
const TOKEN_MARKER = 'ZZTOKENMARKER'.repeat(3);
const FAKE_EMAIL = 'zz-fake-user@example.invalid';
const FAKE_REFRESH_TOKEN = `rt_zz_fake_${'9'.repeat(32)}`;
const FAKE_USER_ID = 'zz-user-id-marker';
const FAKE_VERSION = [9, 8, 7].join('.');
const DUMMY_BEARER = 'Bearer zz-fake-bearer-token';
const MAIL_LIKE = /[^\s"]+@[^\s"]+/g;
const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]*/g;

const policy = (overrides = {}) => ({ stopUsedPercent: 75, resumeUsedPercent: 60, ...overrides });
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = claims => `${base64url({ alg: 'none' })}.${base64url(claims)}.${'Z'.repeat(24)}`;
const accountIdOf = label => `zz-account-id-${label}-marker`;

function authJson(label, { expired = false } = {}) {
  const expSeconds = Math.floor((expired ? FIXED_NOW_MS - 3600000 : FIXED_NOW_MS + 3600000) / 1000);
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: fakeJwt({ email: FAKE_EMAIL, 'https://api.openai.com/auth': { chatgpt_account_id: accountIdOf(label) } }),
      access_token: fakeJwt({ exp: expSeconds, zz: TOKEN_MARKER }),
      refresh_token: FAKE_REFRESH_TOKEN,
      account_id: accountIdOf(label),
    },
  });
}

function captureStream() {
  const chunks = [];
  return { chunks, write(chunk) { chunks.push(String(chunk)); return true; }, text() { return chunks.join(''); } };
}

function usageBody({ primary = 10, secondary = 10, allowed = true } = {}) {
  return {
    email: FAKE_EMAIL,
    user_id: FAKE_USER_ID,
    note: DUMMY_BEARER,
    rate_limit: {
      allowed,
      primary_window: { used_percent: primary, limit_window_seconds: 18000, reset_after_seconds: 600 },
      secondary_window: { used_percent: secondary, limit_window_seconds: 604800, reset_after_seconds: 6000 },
    },
  };
}
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// 口座のラベルごとに応答を返す偽の fetch（呼出しは calls に残す。ヘッダの値は残さない）。
function fakeFetch(respondFor = () => jsonResponse(usageBody())) {
  const calls = [];
  const impl = async (url, init) => {
    const label = init.headers['ChatGPT-Account-ID'].replace(/^zz-account-id-/, '').replace(/-marker$/, '');
    calls.push(label);
    return respondFor(label);
  };
  return { impl, calls };
}

// `--version` に答える偽の子（ok なら版を出して 0、そうでなければ 1 で閉じる）。
function versionChild(ok) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => true;
  setImmediate(() => {
    if (ok) child.stdout.emit('data', Buffer.from(`codex-cli ${FAKE_VERSION}\n`));
    child.emit('close', ok ? 0 : 1, null);
  });
  return child;
}

/**
 * 隔離の一時フォルダに、設定・口座のフォルダ・偽の資格情報・偽の codex を作る。
 * @param {{
 *   accounts?: Array<{ label: string, usagePolicy?: object, creds?: 'ok'|'expired'|'missing' }>,
 *   enabled?: boolean, acknowledged?: boolean, config?: boolean, codex?: 'version-ok'|'version-fail'|'missing',
 *   identity?: boolean, daemonPort?: number, respondFor?: Function,
 * }} [options] identity が真なら設定に User-Agent の上書きの組を書く。codex が missing なら codexPath を書かず、
 *   PATH にも codex を置かない。
 */
async function fixture(t, {
  accounts = [{ label: 'zz-a' }], enabled = true, acknowledged = true, config = true, codex = 'version-ok',
  identity = false, daemonPort, respondFor,
} = {}) {
  const isolation = await setupCodexIsolation(t);
  const { env, home, root } = isolation;
  const accountsDir = join(home, `zz-accounts-${PATH_MARKER}`);
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  await chmod(accountsDir, 0o700);
  const homes = {};
  for (const account of accounts) {
    const codexHome = join(accountsDir, `${PATH_MARKER}-${account.label}`);
    homes[account.label] = codexHome;
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const creds = account.creds ?? 'ok';
    if (creds !== 'missing') {
      await writeFile(join(codexHome, 'auth.json'), authJson(account.label, { expired: creds === 'expired' }), { mode: 0o600 });
    }
  }
  const codexPath = join(root, `zz-bin-${PATH_MARKER}`, 'codex');
  const spawnCalls = [];
  if (codex !== 'missing') {
    await mkdir(join(root, `zz-bin-${PATH_MARKER}`), { recursive: true, mode: 0o700 });
    // 実行できるファイルを置くだけで、実行はしない（版の読取は下の登録した偽物が答える）。
    await writeFile(codexPath, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    isolation.registerSpawn(codexPath, args => {
      spawnCalls.push(args);
      return versionChild(codex === 'version-ok');
    });
  }
  const writeConfig = async raw => {
    const folder = codexRotatorConfigDir(env);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700);
    await writeFile(codexRotatorConfigPath(env), JSON.stringify(raw), { mode: 0o600 });
  };
  const rawOf = list => ({
    enabled,
    acknowledgedMultiAccountRisk: acknowledged,
    accountsDir,
    ...(codex !== 'missing' ? { codexPath } : {}),
    ...(identity ? { usageUserAgent: 'zz-fake-ua', usageOriginator: 'zz-fake-originator' } : {}),
    ...(daemonPort === undefined ? {} : { daemon: { port: daemonPort } }),
    accounts: list.map(account => ({ label: account.label, codexHome: homes[account.label],
      usagePolicy: account.usagePolicy ?? policy() })),
  });
  if (config) await writeConfig(rawOf(accounts));
  const fetch = fakeFetch(respondFor);
  const run = async (argv, extraDeps = {}) => {
    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runStatus(argv, { stdout, stderr, env }, {
      now: () => FIXED_NOW_MS, request: isolation.request, spawn: isolation.spawn, fetchImpl: fetch.impl, ...extraDeps });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };
  return { isolation, env, root, accountsDir, homes, spawnCalls, fetch, run, writeConfig, rawOf };
}

const parse = text => {
  assert.ok(text.endsWith('\n'));
  assert.equal(text.split('\n').filter(Boolean).length, 1, 'one JSON object on one line');
  const json = JSON.parse(text);
  assert.equal(codexStatusProblem(json), null, 'the output passes the schema check');
  return json;
};
const byLabel = json => Object.fromEntries(json.accounts.map(account => [account.label, account]));

// --- 3つの形 -------------------------------------------------------------------------------------

test('status --json: one JSON object of the schema on stdout, nothing on stderr, read directly without a daemon', async t => {
  const f = await fixture(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }] });
  const result = await f.run(['--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const json = parse(result.stdout);
  assert.equal(json.source, 'direct');
  assert.equal(json.latchKnown, false);
  assert.equal(json.enabled, true);
  assert.deepEqual(json.accounts.map(account => [account.label, account.stateWord]), [['zz-a', 'ready'], ['zz-b', 'ready']]);
  assert.equal(json.observation.userAgentSource, 'codex-version');
  assert.deepEqual(f.spawnCalls, [['--version']], 'the version is read once, through the injected spawn');
  assert.deepEqual(f.fetch.calls.sort(), ['zz-a', 'zz-b']);
  assert.deepEqual(f.isolation.fetchCalls, [], 'the global fetch is never used');
  assert.deepEqual(f.isolation.refusedChildProcesses, []);
});

test('status --json --section: the same schema and the same check as --json; an example output is reported', async t => {
  const f = await fixture(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }, { label: 'zz-c', creds: 'expired' }],
    respondFor: label => jsonResponse(usageBody(label === 'zz-b' ? { primary: 80 } : {})) });
  const json = await f.run(['--json']);
  const section = await f.run(['--json', '--section']);
  assert.equal(section.code, 0);
  assert.equal(section.stderr, '');
  assert.deepEqual(parse(section.stdout), parse(json.stdout), 'the two forms print the same JSON');
  const line = section.stdout.trim();
  assert.equal(line.match(MAIL_LIKE), null, 'no mail-address-like string in the example');
  assert.equal(line.match(TOKEN_LIKE), null, 'no token-like string in the example');
  assert.deepEqual(Object.values(byLabel(parse(section.stdout))).map(account => account.stateWord), ['ready', 'held', 'needs login']);
  // この形が出す1行の例を、テストの診断の出力に載せる（偽の値の設定と偽の上流で出したもの）。
  t.diagnostic(`section-example ${line}`);
});

test('status without arguments draws the JSON with the shared view, and says the latch is unknown without a daemon', async t => {
  const f = await fixture(t);
  const json = parse((await f.run(['--json'])).stdout);
  const text = await f.run([]);
  assert.equal(text.code, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout, renderCodexSection(json, { now: FIXED_NOW_MS }).join('\n'));
  assert.ok(text.stdout.startsWith(`${HEADING}sendable 1/1`));
  assert.ok(text.stdout.includes('\n  latch    unknown (no daemon)\n'));
  assert.ok(text.stdout.includes('\n  reading  usage GET, direct   pool state: '));
});

test('status: arguments other than the three forms print the usage line and exit 2', async t => {
  const f = await fixture(t);
  for (const argv of [['--section'], ['--json', '--json'], ['--section', '--json'], ['--frob'], ['--json', '--section', 'x']]) {
    const result = await f.run(argv);
    assert.equal(result.code, 2, argv.join(' '));
    assert.equal(result.stderr, `${STATUS_USAGE}\n`);
    assert.equal(result.stdout, '');
  }
  assert.equal(f.fetch.calls.length, 0);
});

// --- 無効・設定が読めない ------------------------------------------------------------------------

test('status: not activated or no config file prints the disabled form without reading credentials or sending a read', async t => {
  const cases = [{ enabled: false }, { acknowledged: false }, { config: false }];
  for (const options of cases) {
    const f = await fixture(t, options);
    let credentialReads = 0;
    const readCredentials = async () => { credentialReads++; throw new Error('zz-must-not-read'); };
    const json = parse((await f.run(['--json'], { readCredentials })).stdout);
    assert.equal(json.enabled, false);
    assert.deepEqual(json.accounts, []);
    assert.equal(json.source, 'direct');
    assert.equal(json.latchKnown, false);
    assert.deepEqual(json.next, { label: null, reason: 'disabled' });
    const section = parse((await f.run(['--json', '--section'], { readCredentials })).stdout);
    assert.deepEqual(section, json);
    const text = await f.run([], { readCredentials });
    assert.equal(text.code, 0);
    assert.equal(text.stdout, `${HEADING}${CODEX_DISABLED_TEXT}\n`);
    // どちらか1つだけが欠けた設定でも、1行は2つの設定をどちらも名指す。
    for (const name of ['enabled', 'acknowledgedMultiAccountRisk']) {
      assert.match(text.stdout, new RegExp(`\\b${name}\\b`), `${JSON.stringify(options)}: ${name}`);
    }
    assert.equal(credentialReads, 0, JSON.stringify(options));
    assert.equal(f.fetch.calls.length, 0, JSON.stringify(options));
    assert.deepEqual(f.spawnCalls, [], 'no version read either');
    assert.deepEqual(f.isolation.refusedRequests, [], 'the daemon is not asked');
    await f.isolation.cleanup();
  }
});

test('status: a config that cannot be read prints nothing on stdout and config unreadable on stderr', async t => {
  const f = await fixture(t);
  await chmod(codexRotatorConfigPath(f.env), 0o644);
  for (const argv of [['--json'], ['--json', '--section'], []]) {
    const result = await f.run(argv);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${STATUS_LINE.configUnreadable}\n`);
  }
});

test('status: an unexpected failure while reading prints nothing on stdout, status unavailable on stderr, and exits 1', async t => {
  const f = await fixture(t);
  const findCodex = () => { throw new Error(`zz-unexpected ${PATH_MARKER}`); };
  assert.equal(STATUS_LINE.failed, 'status unavailable');
  for (const argv of [['--json'], ['--json', '--section'], []]) {
    const result = await f.run(argv, { findCodex });
    assert.equal(result.code, 1, argv.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${STATUS_LINE.failed}\n`, 'only the fixed words, not the message of the error');
  }
  assert.equal(f.fetch.calls.length, 0);
});

// --- 常駐が無いときの問い合わせ（陽性対照） ------------------------------------------------------

test('status --json: without daemon.port the daemon is asked at the default port, refused by the isolation, and read directly', async t => {
  const f = await fixture(t);
  const json = parse((await f.run(['--json'])).stdout);
  assert.equal(json.source, 'direct');
  assert.deepEqual(f.isolation.refusedRequests.map(request => request.port), [DEFAULT_DAEMON_PORT]);
  assert.equal(f.isolation.refusedRequests[0].reason, 'real-service-port');
  const reached = f.isolation.connections.filter(connection => [CLAUDE_DEFAULT_PORT, DEFAULT_DAEMON_PORT].includes(connection.port));
  assert.deepEqual(reached, [], 'no real connection to the Claude port or the daemon port');
  assert.deepEqual(f.isolation.connections, []);
});

// --- 秘密とパスの目印 ---------------------------------------------------------------------------

test('status: no mail address, token, account id, version or path marker reaches any of the three outputs', async t => {
  const f = await fixture(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b', creds: 'expired' }, { label: 'zz-c', creds: 'missing' },
    { label: 'zz-d' }], respondFor: label => (label === 'zz-d' ? jsonResponse({ error: DUMMY_BEARER, email: FAKE_EMAIL }, 401)
    : jsonResponse(usageBody())) });
  const outputs = [await f.run(['--json']), await f.run(['--json', '--section']), await f.run([])];
  const secrets = [PATH_MARKER, f.root, f.accountsDir, TOKEN_MARKER, FAKE_EMAIL, FAKE_REFRESH_TOKEN, FAKE_USER_ID,
    FAKE_VERSION, DUMMY_BEARER, 'zz-fake-ua', ...['zz-a', 'zz-b', 'zz-c', 'zz-d'].map(accountIdOf)];
  for (const { code, stdout, stderr } of outputs) {
    assert.equal(code, 0);
    assert.equal(stderr, '');
    for (const value of secrets) assert.equal(stdout.includes(value), false, value);
    assert.equal(stdout.match(MAIL_LIKE), null);
    assert.equal(stdout.match(TOKEN_LIKE), null);
    assert.equal(stdout.includes('auth.json'), false);
  }
});

// --- ログインが切れた口座 -------------------------------------------------------------------------

test('status: accounts whose login expired or whose credentials cannot be read show the label, the word and the fix', async t => {
  const f = await fixture(t, {
    accounts: [{ label: 'zz-ok' }, { label: 'zz-expired', creds: 'expired' }, { label: 'zz-unauth' }, { label: 'zz-forbid' },
      { label: 'zz-nocreds', creds: 'missing' }],
    respondFor: label => ({ 'zz-unauth': jsonResponse({}, 401), 'zz-forbid': jsonResponse({}, 403) })[label]
      ?? jsonResponse(usageBody()),
  });
  const accounts = byLabel(parse((await f.run(['--json'])).stdout));
  const row = label => [accounts[label].stateWord, accounts[label].reason];
  assert.deepEqual(row('zz-expired'), ['needs login', 'access-token-expired']);
  assert.deepEqual(row('zz-unauth'), ['needs login', 'upstream-unauthorized']);
  assert.deepEqual(row('zz-forbid'), ['needs login', 'upstream-forbidden']);
  assert.deepEqual(row('zz-nocreds'), ['no creds', 'credentials-unavailable']);
  const lines = (await f.run([])).stdout.split('\n');
  for (const label of ['zz-expired', 'zz-unauth', 'zz-forbid']) {
    const at = lines.findIndex(line => line.startsWith(`  ${label} `));
    assert.ok(lines[at].includes(' needs login '), label);
    assert.ok(lines.slice(at + 1).find(line => line.startsWith('    clears'))
      .endsWith(`run codex-rotator login --label ${label} --relogin`), label);
  }
  const at = lines.findIndex(line => line.startsWith('  zz-nocreds '));
  assert.ok(lines[at].includes(' no creds '));
  assert.ok(lines.slice(at + 1).find(line => line.startsWith('    clears'))
    .endsWith('run codex-rotator remove --label zz-nocreds, then log in again with codex-rotator login'));
});

// --- User-Agent ---------------------------------------------------------------------------------

test('status: the User-Agent source is config, codex-version, or null with the accounts unread and the reading line saying why', async t => {
  const fromConfig = await fixture(t, { identity: true });
  const configured = parse((await fromConfig.run(['--json'])).stdout);
  assert.equal(configured.observation.userAgentSource, 'config');
  assert.deepEqual(fromConfig.spawnCalls, [], 'no version read with an override');
  await fromConfig.isolation.cleanup();

  const missing = await fixture(t, { codex: 'missing', accounts: [{ label: 'zz-a' },
    { label: 'zz-b', usagePolicy: policy({ blockWhenUnknown: true }) }] });
  const json = parse((await missing.run(['--json'])).stdout);
  assert.equal(json.observation.userAgentSource, null);
  assert.deepEqual(json.accounts.map(account => [account.stateWord, account.reason]),
    [['unread', 'codex-cli-missing'], ['reserved', 'codex-cli-missing']]);
  assert.equal(missing.fetch.calls.length, 0);
  const text = (await missing.run([])).stdout.split('\n');
  // reading の行は100桁を超えるので、読取を飛ばした理由は字下げした続きの行に出る。
  assert.ok(text[1].startsWith('  reading  usage GET, direct   pool state: '));
  assert.equal(text[2], `${' '.repeat(11)}usage read skipped: codex-cli-missing`);
  assert.equal(text.filter(line => line === `    ${terminalPadEnd('clears', 9)}needs a readable codex CLI (codex CLI not found)`).length, 2);
  await missing.isolation.cleanup();

  const unreadable = await fixture(t, { codex: 'version-fail' });
  const failed = parse((await unreadable.run(['--json'])).stdout);
  assert.deepEqual([failed.accounts[0].stateWord, failed.accounts[0].reason], ['unread', 'codex-version-unreadable']);
  assert.equal(failed.observation.userAgentSource, null);
});

// --- 並び順 ----------------------------------------------------------------------------------

test('status --json: order follows the configured list and swaps with it', async t => {
  const f = await fixture(t, { accounts: [{ label: 'zz-a' }, { label: 'zz-b' }, { label: 'zz-c' }] });
  const first = parse((await f.run(['--json'])).stdout);
  assert.deepEqual(first.accounts.map(account => [account.label, account.order]), [['zz-a', 1], ['zz-b', 2], ['zz-c', 3]]);
  await f.writeConfig(f.rawOf([{ label: 'zz-c' }, { label: 'zz-a' }, { label: 'zz-b' }]));
  const swapped = parse((await f.run(['--json'])).stdout);
  assert.deepEqual(swapped.accounts.map(account => [account.label, account.order]), [['zz-c', 1], ['zz-a', 2], ['zz-b', 3]]);
});

// --- 入口からの振り分け ----------------------------------------------------------------------------

test('codex-rotator status goes through the entry point to the status body', async t => {
  const f = await fixture(t, { enabled: false });
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(['status', '--json'], { stdout, stderr, env: f.env });
  assert.equal(code, 0);
  assert.equal(stderr.text(), '');
  assert.equal(parse(stdout.text()).enabled, false);
});

// --- README の節 ---------------------------------------------------------------------------------

// 見出しの行の次から、同じかより上の階層の次の見出しの前までを返す（コードの囲みの中の `#` は見出しに数えない）。
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

// どの階層のキーも埋めた見本（スキーマ検査を通るので、ここに現れるキーがスキーマのキーのすべて）。
function fullSample() {
  const window = { usedPercent: 40, resetAt: '2026-01-01T02:00:00Z', windowMinutes: 300, fresh: true,
    observedAt: '2026-01-01T00:00:00Z', lengthSource: 'reported' };
  return {
    schemaVersion: 1, provider: 'codex', enabled: true, generatedAt: '2026-01-01T00:00:00Z', source: 'daemon', latchKnown: true,
    daemon: { reachable: true, startedAt: '2025-12-31T23:00:00Z' }, pool: { state: 'ok', resetAt: null },
    observation: { method: 'usage-get', startupCheck: 'passed', accountUsageIncludesExternalClients: true,
      cliConsumptionVisible: false, userAgentSource: 'config' },
    next: { label: null, reason: 'none' },
    accounts: [{ label: 'work', order: 1, state: 'exhausted', stateWord: 'held', selectable: false, reason: 'usage-capped',
      resetAt: null, ordinaryUsageAllowed: true, nextObservationAt: null,
      policy: { stopUsedPercent: 75, resumeUsedPercent: 60, blockWhenUnknown: false },
      latch: { stopped: true, cappedWindows: ['fiveHour'], upstreamBlocked: false, cleanReadsDone: 0, cleanReadsNeeded: 2,
        since: null },
      windows: { fiveHour: window, weekly: { ...window, windowMinutes: 10080 } }, otherWindows: [{ ...window, windowMinutes: 120 }],
      observedAt: '2026-01-01T00:00:00Z', headroomPercent: 0 }],
    aggregate: { effectiveRemainingPercent: 0, lowerBoundPercent: 0, fiveHourRemainingPercent: 0, weeklyRemainingPercent: 0,
      accountsTotal: 1, accountsAvailable: 0, accountsSelectable: 0, accountsUnknown: 0, unit: 'percent-points-of-one-account' },
    events: [{ at: '2026-01-01T00:00:00Z', type: 'stopped', label: 'work' }],
  };
}

function keysOf(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysOf(child, found);
    }
  }
  return found;
}

const README_STATUS_SECTIONS = Object.freeze([
  Object.freeze({ heading: '### 状態の JSON（codex-rotator status）', watcher: '#### 見張りから使う（status --json --section）' }),
  Object.freeze({ heading: '#### Status JSON (codex-rotator status)',
    watcher: '##### Using It from a Watcher (status --json --section)' }),
]);

test('README: the status sections in Japanese and English carry every key of the schema and a valid example', async () => {
  const sample = fullSample();
  assert.equal(codexStatusProblem(sample), null, 'the sample has exactly the keys of the schema at every level');
  const keys = [...keysOf(sample)];
  // README はリポジトリの根のものを、このファイルの場所から読む（テストの作業フォルダに依らない）。
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
  for (const { heading, watcher } of README_STATUS_SECTIONS) {
    const section = readmeSection(readme, heading);
    for (const key of keys) assert.ok(section.includes(`\`${key}\``), `${heading}: ${key}`);
    assert.ok(fencedBlocks(section, 'text').includes(`${STATUS_USAGE}\n`), `${heading}: the usage line`);
    assert.ok(section.includes(`\`${CODEX_DISABLED_TEXT}\``), `${heading}: the disabled line`);
    const examples = fencedBlocks(section, 'json');
    assert.equal(examples.length, 1, `${heading}: one example`);
    const example = JSON.parse(examples[0]);
    assert.equal(codexStatusProblem(example), null, `${heading}: the example passes the schema check`);
    for (const account of example.accounts) {
      assert.equal(account.headroomPercent, codexAccountHeadroom(account, { source: example.source }), `${heading}: headroom`);
    }
    assert.deepEqual(example.aggregate, aggregateCodexAccounts(example.accounts, { enabled: example.enabled,
      source: example.source }), `${heading}: the aggregate of the example`);
    // 見張りから使う節: 約束する口・全体の期限・待つ目安・断る条件。
    const watch = readmeSection(readme, watcher);
    assert.ok(fencedBlocks(watch, 'text').includes('codex-rotator status --json --section\n'), `${watcher}: the entry point`);
    for (const text of [`${CODEX_SECTION_DEADLINE_MS} ms`, `${CODEX_CHILD_TIMEOUT_MS} ms`, '`next.label`', '`null`', '`source`',
      '`daemon`']) {
      assert.ok(watch.includes(text), `${watcher}: ${text}`);
    }
  }
});
