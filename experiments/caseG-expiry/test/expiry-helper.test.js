// Mock-only tests. No real Keychain, account folder, rotator process or ~/.config/claude-rotator is touched:
// every Keychain call goes to the in-memory fake below, and HOME points at a temp directory.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  MARGIN_MS, createSecurityBackend, projectExpiry, runCli, serviceNameFor, summarize,
} from '../expiry-helper.js';

const ACCESS = 'FAKE-ACCESS-VALUE-for-tests-0123456789';
const REFRESH = 'FAKE-REFRESH-VALUE-for-tests-9876543210';
const CONFIG_DIR = '/fake/accounts/cfgA';
const SERVICE = serviceNameFor(CONFIG_DIR);
const LOGIN = '/fake/home/Library/Keychains/login.keychain-db';
const SYSTEM = '/Library/Keychains/System.keychain';
const NOW = Date.UTC(2026, 10, 12, 3, 0, 0);

let root;
let home;
let runDir;
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'caseg-expiry-test-'));
  home = join(root, 'home');
  runDir = join(root, 'run');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home);
  await mkdir(runDir);
});
after(async () => { await rm(root, { recursive: true, force: true }); });

function credential(expiresAt) {
  return JSON.stringify({ claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt,
    scopes: ['user:inference'], subscriptionType: 'max' } });
}

function attributes({ path, service = SERVICE, acct = 'cirkit', mdat = '20261112020000' }) {
  return [`keychain: "${path}"`, 'version: 512', 'class: "genp"', 'attributes:',
    `    "acct"<blob>="${acct}"`, `    "mdat"<timedate>=0x00  "${mdat}Z\\000"`, `    "svce"<blob>="${service}"`, ''].join('\n');
}

// Fake Keychain: items keyed by keychain path. `onRead` may mutate state between the scans.
function fakeKeychain({ list = [LOGIN, SYSTEM], items = { [LOGIN]: {} }, expiresAt = NOW + 3 * 3600_000,
  onRead = null, readError = null } = {}) {
  const calls = [];
  const state = { items, expiresAt };
  return {
    calls,
    state,
    async run(args) {
      calls.push([...args]);
      if (args[0] === 'list-keychains') return { stdout: list.map(p => `    "${p}"`).join('\n') + '\n', stderr: '' };
      if (args[0] !== 'find-generic-password') throw new Error(`unexpected command ${args.join(' ')}`);
      const path = args[args.length - 1];
      const item = state.items[path];
      if (args.includes('-w')) {
        if (readError) throw new Error(`security failed ${ACCESS}`);
        const out = { stdout: typeof state.expiresAt === 'string' ? state.expiresAt : `${credential(state.expiresAt)}\n`, stderr: '' };
        onRead?.(state);
        return out;
      }
      if (!item) return { found: false };
      return { stdout: attributes({ path, ...item }), stderr: '' };
    },
  };
}

function argv(extra = {}) {
  const o = { '--config-dir': CONFIG_DIR, '--service': SERVICE, '--acct': 'cirkit', '--keychain': LOGIN,
    '--run-dir': runDir, '--state': join(runDir, 't4-expiry.state'), ...extra };
  return Object.entries(o).flat();
}

async function invoke(backend, { args = argv(), now = NOW, env = {} } = {}) {
  let out = '';
  let err = '';
  const code = await runCli(args, { env: { CASEG_EXPIRY_ENABLE: '1', HOME: home, ...env }, backend, now: () => now,
    stdout: t => { out += t; }, stderr: t => { err += t; } });
  return { code, out, err };
}

function assertNoSecrets(text, expiresAt) {
  for (const needle of [ACCESS, REFRESH, 'accessToken', 'refreshToken', 'claudeAiOauth', String(expiresAt),
    new Date(expiresAt).toISOString().slice(0, 16)]) {
    assert.ok(!text.includes(needle), 'output must not contain secrets or the expiry time');
  }
}

async function resetState() { await rm(join(runDir, 't4-expiry.state'), { force: true }); }

test('first run prints margin and no delta, stores only the number with mode 0600', async () => {
  await resetState();
  const kc = fakeKeychain();
  const r = await invoke(kc);
  assert.equal(r.code, 0);
  assert.equal(r.out, 'withinMargin=false\ndeltaMin=none\n');
  assert.equal(r.err, '');
  assertNoSecrets(r.out + r.err, kc.state.expiresAt);
  const file = join(runDir, 't4-expiry.state');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const body = await readFile(file, 'utf8');
  const record = JSON.parse(body);
  assert.deepEqual(Object.keys(record).sort(), ['acct', 'expiresAt', 'keychain', 'service', 'v']);
  assert.equal(record.service, SERVICE);
  assert.equal(record.acct, 'cirkit');
  assert.equal(record.keychain, LOGIN);
  assert.ok(Number.isSafeInteger(record.expiresAt));
  assert.ok(!body.includes('accessToken') && !body.includes('refreshToken'));
  assert.ok(!body.includes(ACCESS) && !body.includes(REFRESH));
});

test('a forward move prints the delta and the rounded remaining time', async () => {
  await resetState();
  await invoke(fakeKeychain({ expiresAt: NOW - 60_000 }));
  const newExpiry = NOW + 8 * 3600_000 - 4 * 60_000; // 7h56m left -> rounds to 480
  const kc = fakeKeychain({ expiresAt: newExpiry });
  const r = await invoke(kc);
  assert.equal(r.code, 0);
  assert.equal(r.out, `withinMargin=false\ndeltaMin=+${Math.round((newExpiry - (NOW - 60_000)) / 60000)}\nremainingMin10=480\n`);
  assertNoSecrets(r.out, newExpiry);
});

test('no move prints +0 and hides the remaining time', async () => {
  await resetState();
  const expiry = NOW + 2 * 60_000;
  await invoke(fakeKeychain({ expiresAt: expiry }));
  const r = await invoke(fakeKeychain({ expiresAt: expiry }));
  assert.equal(r.out, 'withinMargin=true\ndeltaMin=+0\n');
});

test('summarize: margin boundary and backward move', () => {
  assert.deepEqual(summarize({ expiresAt: NOW + MARGIN_MS, previous: null, now: NOW }), ['withinMargin=true', 'deltaMin=none']);
  assert.deepEqual(summarize({ expiresAt: NOW + MARGIN_MS + 1, previous: null, now: NOW }), ['withinMargin=false', 'deltaMin=none']);
  assert.deepEqual(summarize({ expiresAt: NOW, previous: NOW + 600_000, now: NOW }), ['withinMargin=true', 'deltaMin=-10']);
});

test('projectExpiry keeps only the number and never echoes the input on failure', () => {
  assert.equal(projectExpiry(credential(123456)), 123456);
  assert.equal(projectExpiry(JSON.stringify({ accessToken: ACCESS, expiresAt: 42 })), 42);
  for (const bad of ['not json ' + ACCESS, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS } }),
    JSON.stringify({ claudeAiOauth: { expiresAt: '1700000000000' } }), JSON.stringify({ claudeAiOauth: { expiresAt: -1 } })]) {
    assert.throws(() => projectExpiry(bad), error => {
      assert.ok(!String(error.message).includes(ACCESS));
      assert.equal(error.reason, 'shape');
      return true;
    });
  }
});

const stopCases = [
  ['two matching items in the search list', () => fakeKeychain({ items: { [LOGIN]: {}, [SYSTEM]: {} } }), 'not-unique'],
  ['no matching item', () => fakeKeychain({ items: {} }), 'not-unique'],
  ['item only in another keychain', () => fakeKeychain({ items: { [SYSTEM]: {} } }), 'not-unique'],
  ['scoped keychain missing from the search list', () => fakeKeychain({ list: [SYSTEM], items: { [SYSTEM]: {} } }), 'search-list'],
  ['attributes name another service', () => fakeKeychain({ items: { [LOGIN]: { service: `${SERVICE}x` } } }), 'not-unique'],
  ['attributes name another acct', () => fakeKeychain({ items: { [LOGIN]: { acct: 'other' } } }), 'not-unique'],
  ['item changed between scans', () => fakeKeychain({ onRead: s => { s.items[LOGIN] = { mdat: '20261112030000' }; } }), 'changed'],
  ['credential is not JSON', () => fakeKeychain({ expiresAt: `garbage ${ACCESS}` }), 'shape'],
  ['backend error carries a secret', () => fakeKeychain({ readError: true }), 'read'],
];
for (const [name, make, reason] of stopCases) {
  test(`stops without values: ${name}`, async () => {
    await resetState();
    const kc = make();
    const r = await invoke(kc);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.equal(r.err, `expiry-helper: stopped reason=${reason}\n`);
    await assert.rejects(stat(join(runDir, 't4-expiry.state')), { code: 'ENOENT' });
  });
}

test('only read commands reach the backend; -w is used once and only on the scoped keychain', async () => {
  await resetState();
  const kc = fakeKeychain();
  await invoke(kc);
  for (const call of kc.calls) {
    assert.ok(['list-keychains', 'find-generic-password'].includes(call[0]));
    assert.ok(!call.includes('-g'));
  }
  const reads = kc.calls.filter(c => c.includes('-w'));
  assert.deepEqual(reads, [['find-generic-password', '-a', 'cirkit', '-s', SERVICE, '-w', LOGIN]]);
});

test('scope checks: service must match the config dir, paths must be absolute', async () => {
  for (const extra of [{ '--service': 'Claude Code-credentials-00000000' }, { '--config-dir': 'relative/dir' },
    { '--keychain': '/fake/not-a-keychain' }, { '--acct': 'bad acct' }]) {
    const kc = fakeKeychain();
    const r = await invoke(kc, { args: argv(extra) });
    assert.equal(r.code, 2);
    assert.equal(kc.calls.length, 0, 'scope errors stop before any Keychain call');
  }
});

test('state location: must sit directly in the run dir, away from rotator config and account folders', async () => {
  const cases = [
    { '--state': join(root, 'outside.state') },
    { '--state': join(runDir, 'sub', 'x.state') },
    { '--run-dir': join(home, '.config', 'claude-rotator'), '--state': join(home, '.config', 'claude-rotator', 's') },
    { '--run-dir': home, '--state': join(home, 's') }, // contains ~/.claude
    { '--run-dir': join(root, 'missing'), '--state': join(root, 'missing', 's') },
  ];
  for (const extra of cases) {
    const kc = fakeKeychain();
    const r = await invoke(kc, { args: argv(extra) });
    assert.equal(r.code, 2);
    assert.match(r.err, /^expiry-helper: stopped reason=(state|args)\n$/);
    assert.equal(kc.calls.length, 0);
  }
});

test('state file with loose permissions or extra content stops the helper', async () => {
  const file = join(runDir, 't4-expiry.state');
  await writeFile(file, '1700000000000\n', { mode: 0o644 });
  await chmod(file, 0o644);
  let r = await invoke(fakeKeychain());
  assert.equal(r.err, 'expiry-helper: stopped reason=state\n');
  await chmod(file, 0o600);
  await writeFile(file, `1700000000000 ${ACCESS}\n`);
  r = await invoke(fakeKeychain());
  assert.equal(r.err, 'expiry-helper: stopped reason=state\n');
  await resetState();
});

test('--clear-state removes the state file and nothing else', async () => {
  await resetState();
  await invoke(fakeKeychain());
  const r = await invoke(null, { args: ['--clear-state', '--run-dir', runDir, '--state', join(runDir, 't4-expiry.state')] });
  assert.equal(r.code, 0);
  assert.equal(r.out, 'stateCleared=true\n');
  await assert.rejects(stat(join(runDir, 't4-expiry.state')), { code: 'ENOENT' });
});

test('the CLI refuses to run without the enable switch', async () => {
  const kc = fakeKeychain();
  let err = '';
  const code = await runCli(argv(), { env: { HOME: home }, backend: kc, stdout: () => {}, stderr: t => { err += t; } });
  assert.equal(code, 2);
  assert.equal(err, 'expiry-helper: stopped reason=environment\n');
  assert.equal(kc.calls.length, 0);
});

test('the real security backend refuses to run under the test runner', async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'these tests must run under node --test');
  const fromProcessEnv = createSecurityBackend({ env: {}, platform: 'darwin' });
  await assert.rejects(fromProcessEnv.run(['list-keychains']), { reason: 'environment' });
  const backend = createSecurityBackend({ env: { NODE_TEST_CONTEXT: 'child' }, platform: 'darwin' });
  await assert.rejects(backend.run(['list-keychains']), { reason: 'environment' });
  const offMac = createSecurityBackend({ env: {}, platform: 'linux' });
  await assert.rejects(offMac.run(['list-keychains']), { reason: 'environment' });
});

const OTHER_DIR = '/fake/accounts/cfgB';
const OTHER_SERVICE = serviceNameFor(OTHER_DIR);
const OTHER_KEYCHAIN = '/fake/home/Library/Keychains/other.keychain-db';

for (const [name, extra, kcOptions] of [
  ['another account folder (service)', { '--config-dir': OTHER_DIR, '--service': OTHER_SERVICE },
    { items: { [LOGIN]: { service: OTHER_SERVICE } } }],
  ['another acct', { '--acct': 'someone' }, { items: { [LOGIN]: { acct: 'someone' } } }],
  ['another keychain path', { '--keychain': OTHER_KEYCHAIN },
    { list: [OTHER_KEYCHAIN, SYSTEM], items: { [OTHER_KEYCHAIN]: {} } }],
]) {
  test(`state written for a different item is not compared: ${name}`, async () => {
    await resetState();
    const first = await invoke(fakeKeychain({ expiresAt: NOW - 60_000 }));
    assert.equal(first.code, 0);
    const file = join(runDir, 't4-expiry.state');
    const before = await readFile(file, 'utf8');
    const kc = fakeKeychain({ ...kcOptions, expiresAt: NOW + 8 * 3600_000 });
    const r = await invoke(kc, { args: argv(extra) });
    assert.equal(r.code, 2);
    assert.equal(r.out, '', 'no delta may be printed against another item');
    assert.equal(r.err, 'expiry-helper: stopped reason=state-mismatch\n');
    assert.equal(kc.calls.length, 0, 'the mismatch stops before any Keychain call');
    assert.equal(await readFile(file, 'utf8'), before, 'the state of the other item is kept as it was');
    await resetState();
  });
}

test('the same item still compares after the binding change', async () => {
  await resetState();
  await invoke(fakeKeychain({ expiresAt: NOW - 60_000 }));
  const r = await invoke(fakeKeychain({ expiresAt: NOW + 59_000 }));
  assert.equal(r.code, 0);
  assert.equal(r.out, 'withinMargin=true\ndeltaMin=+2\nremainingMin10=0\n');
});

test('an old bare-number state file is refused, not compared', async () => {
  const file = join(runDir, 't4-expiry.state');
  await writeFile(file, '1700000000000\n', { mode: 0o600 });
  await chmod(file, 0o600);
  const kc = fakeKeychain();
  const r = await invoke(kc);
  assert.equal(r.err, 'expiry-helper: stopped reason=state\n');
  assert.equal(kc.calls.length, 0);
  await resetState();
});

test('a temp file left by an interrupted run is removed on write and on clear', async () => {
  await resetState();
  const temp = join(runDir, 't4-expiry.state.tmp');
  await writeFile(temp, 'partial', { mode: 0o600 });
  const r = await invoke(fakeKeychain());
  assert.equal(r.code, 0);
  await assert.rejects(stat(temp), { code: 'ENOENT' });
  await writeFile(temp, 'partial', { mode: 0o600 });
  const c = await invoke(null, { args: ['--clear-state', '--run-dir', runDir, '--state', join(runDir, 't4-expiry.state')] });
  assert.equal(c.code, 0);
  await assert.rejects(stat(temp), { code: 'ENOENT' });
  await assert.rejects(stat(join(runDir, 't4-expiry.state')), { code: 'ENOENT' });
});
