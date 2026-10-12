import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, chmod, symlink, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readCodexCredentials, accountIdHash } from '../../src/codex/credentials.js';

const identity = 'synthetic-reader-account';
const token = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const auth = () => ({ tokens: { id_token: token({ 'https://api.openai.com/auth': { chatgpt_account_id: identity } }), account_id: identity } });
// 一時ディレクトリに偽の CODEX_HOME 相当を作る。実 CODEX_HOME・実 auth.json は読まない。
// 資格情報は共通のテスト補助を使わずにここで作る。
// このテストが要るのは 1 口座分の auth.json だけだから。
async function fixture(t, value = auth()) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-rotator-codex-credentials-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'pro-a');
  await mkdir(home, { mode: 0o700 });
  const p = join(home, 'auth.json');
  await writeFile(p, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  return p;
}

test('credentials: reads File identity locally and keeps auth bytes and mtime unchanged', async t => {
  const p = await fixture(t);
  const before = await readFile(p);
  const mtime = (await stat(p, { bigint: true })).mtimeNs;
  const value = await readCodexCredentials(p);
  assert.equal(value.accountId, identity);
  assert.equal(value.accountIdHash, createHash('sha256').update(identity).digest('hex').slice(0, 12));
  assert.equal(value.credentialsMode, 'file');
  assert.equal(value.identityCheck, 'verified');
  assert.deepEqual(await readFile(p), before);
  assert.equal((await stat(p, { bigint: true })).mtimeNs, mtime);
  assert.equal(accountIdHash(identity), value.accountIdHash);
});

for (const [name, value] of [
  ['missing id_token', { tokens: { account_id: identity } }],
  ['malformed JWT', { tokens: { id_token: 'invalid' } }],
  ['missing account claim', { tokens: { id_token: token({ sub: identity }) } }],
  ['conflicting account_id', { ...auth(), tokens: { ...auth().tokens, account_id: 'other-synthetic' } }],
  ['API key mode', { ...auth(), auth_mode: 'apikey' }],
]) {
  test(`credentials: rejects ${name} without disclosing input`, async t => {
    const p = await fixture(t, value);
    await assert.rejects(readCodexCredentials(p), error => {
      assert.ok(!error.message.includes(identity));
      assert.ok(!error.message.includes(p));
      return true;
    });
  });
}

test('credentials: rejects world-readable auth.json', async t => {
  const p = await fixture(t);
  await chmod(p, 0o644);
  await assert.rejects(readCodexCredentials(p), /credentials permissions/);
});

test('credentials: refuses symlink auth.json', async t => {
  const p = await fixture(t);
  const link = join(dirname(p), 'link.json');
  await symlink(p, link);
  await assert.rejects(readCodexCredentials(link));
});

for (const mode of ['keyring', 'auto', 'ephemeral']) {
  test(`credentials: rejects ${mode} even when stale auth.json exists`, async t => {
    const p = await fixture(t);
    await writeFile(join(dirname(p), 'config.toml'), `cli_auth_credentials_store = "${mode}"\n`, { mode: 0o600 });
    await assert.rejects(readCodexCredentials(p), /File credentials required/);
  });
}

test('credentials: accepts explicit File mode and never checks token expiry over network', async t => {
  const value = auth();
  value.tokens.id_token = token({ exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: identity } });
  const p = await fixture(t, value);
  await writeFile(join(dirname(p), 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  assert.equal((await readCodexCredentials(p)).accountIdHash, accountIdHash(identity));
});

test('credentials: module has no network, process, write or refresh dependencies', async () => {
  const source = await readFile(new URL('../../src/codex/credentials.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|spawn|execFile|writeFile|rename|refreshToken)\s*\(/);
  assert.doesNotMatch(source, /from\s+['"][^'"]*(?:pool|manager|child_process|https?)['"]/);
});

test('credentials: send snapshot validates identity and token in exactly one descriptor read', async t => {
  const { readCodexSendSnapshot } = await import('../../src/codex/credentials.js');
  assert.equal(typeof readCodexSendSnapshot, 'function');
  const value = auth();
  value.tokens.access_token = token({ exp: 2000 });
  const p = await fixture(t, value);
  let reads = 0;
  const snapshot = await readCodexSendSnapshot(p, { nowMs: 1000, readFileImpl: async handle => {
    reads++;
    const bytes = await handle.readFile('utf8');
    // Simulate a CLI replacement immediately after the one read.
    await writeFile(p, JSON.stringify({ tokens: { access_token: 'different-synthetic-value' } }));
    return bytes;
  } });
  assert.equal(reads, 1);
  assert.deepEqual(snapshot, { accountId: identity, accessToken: value.tokens.access_token });
});

test('credentials: legacy identity projection retains exactly its four fields', async t => {
  const value = auth();
  value.tokens.access_token = token({ exp: 2000 });
  const p = await fixture(t, value);
  assert.deepEqual(await readCodexCredentials(p), { accountId: identity, accountIdHash: accountIdHash(identity),
    credentialsMode: 'file', identityCheck: 'verified' });
});

test('credentials: send snapshot preserves readonly safety gates and checks token locally', async t => {
  const { readCodexSendSnapshot } = await import('../../src/codex/credentials.js');
  const value = auth();
  value.tokens.access_token = token({ exp: 2 });
  const p = await fixture(t, value);
  await assert.rejects(readCodexSendSnapshot(p, { nowMs: 2000 }));
  await chmod(p, 0o644);
  await assert.rejects(readCodexSendSnapshot(p, { nowMs: 1000 }), /credentials permissions/);
  await chmod(p, 0o600);
  await writeFile(join(dirname(p), 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  await assert.rejects(readCodexSendSnapshot(p, { nowMs: 1000 }), /File credentials required/);
});
