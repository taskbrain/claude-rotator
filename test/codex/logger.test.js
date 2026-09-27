// codex-rotator のログ（src/codex/logger.js）のテスト。
//
// 許可リストと型の検査・伏せ字・書込の失敗・レベル・出力先の件と、
// 値で伏せる経路（秘密として登録した値を形式に関係なく消す）の件を確かめる。
// 送信経路の項目（本文の指紋・上流の遅延・レート制限ヘッダ）は、このロガーに無いので扱わない。
// 文字列はすべて合成の値。ファイル出力は isolation の補助の一時フォルダの中だけ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CODEX_LOG_FIELDS, LOG_RECORD_UNAVAILABLE, createCodexLogger } from '../../src/codex/logger.js';
import { setupCodexIsolation } from './helpers/isolation.js';

const FIXED_NOW = () => new Date('2026-09-27T00:00:00.000Z');

function capture(options = {}) {
  const lines = [];
  const logger = createCodexLogger({ write: line => lines.push(line), now: FIXED_NOW, ...options });
  const records = () => lines.map(line => JSON.parse(line));
  return { logger, lines, records };
}

// ダミーのトークン形式の文字列（実在の値ではない）。
const DUMMY_TOKENS = Object.freeze([
  'sk-zz-fake-0123456789abcdef',
  `eyJ${'Z'.repeat(30)}.eyJ${'Y'.repeat(30)}.zz`,
  'Bearer zz-fake-bearer-token-value',
  'Authorization: Bearer zz-fake-authorization-value',
]);

test('logger: one JSON line with ts, level and event plus the allowed fields of the right type', () => {
  const { logger, lines, records } = capture();
  logger.info('usage_read', {
    account_label: 'zz-one', usage_read_status: 200, usage_read_duration_ms: 431, used_percent: 76,
    stop_used_percent: 75, resume_used_percent: 70, pool_state: 'degraded', reason: 'codex-version-unreadable',
    user_agent_source: 'codex-version', window: 'fiveHour', ordinary_usage_allowed: false, path: '/internal/reload',
    message: 'plain words',
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(records()[0], {
    ts: '2026-09-27T00:00:00.000Z', level: 'info', event: 'usage_read', account_label: 'zz-one',
    usage_read_status: 200, usage_read_duration_ms: 431, used_percent: 76, stop_used_percent: 75,
    resume_used_percent: 70, pool_state: 'degraded', reason: 'codex-version-unreadable',
    user_agent_source: 'codex-version', window: 'fiveHour', ordinary_usage_allowed: false, path: '/internal/reload',
    message: 'plain words',
  });
});

test('logger: keys outside the allow list are dropped instead of logged', () => {
  const { logger, lines, records } = capture();
  logger.info('usage_read', {
    status: 200, body: { huge: 'zz-body' }, authorization: 'zz-fake-auth', headers: { 'x-zz': 'zz-header' },
    account_id: 'zz-account-id', access_token: 'zz-access', codexHome: '/zz/home', accountsDir: '/zz/accounts',
    user_agent: 'zz-fake-agent', originator: 'zz-fake-originator', email: 'zz-dummy@example.invalid', token: 'zz-token',
  });
  assert.deepEqual(Object.keys(records()[0]), ['ts', 'level', 'event', 'status']);
  assert.doesNotMatch(lines[0], /zz-body|zz-fake|zz-header|zz-account-id|zz-access|\/zz\/|zz-dummy|zz-token/);
});

test('logger: the allow list has no field for bodies, identifiers, paths, credentials or header values', () => {
  for (const field of ['account_id', 'user_id', 'access_token', 'refresh_token', 'id_token', 'authorization', 'body',
    'upstream_body', 'headers', 'codex_home', 'codexHome', 'accounts_dir', 'accountsDir', 'user_agent', 'originator',
    'email', 'token', 'control_token', 'stdout', 'stderr']) {
    assert.equal(Object.hasOwn(CODEX_LOG_FIELDS, field), false, `${field} must stay out of the allow list`);
  }
  assert.deepEqual(Object.entries(CODEX_LOG_FIELDS).filter(([, type]) => type === 'text').map(([name]) => name), ['message']);
});

test('logger: values of the wrong type are dropped field by field', () => {
  const { logger, records } = capture();
  logger.info('usage_read', {
    used_percent: '76', usage_read_status: { value: 200 }, accounts_total: NaN, duration_ms: Infinity,
    ordinary_usage_allowed: 'true', reachable: 1,
    reason: 'upstream said: <html>Attention Required</html>', pool_state: 529, phase: 'x'.repeat(65), state: 'なぜか',
    account_label: 'zz-dummy@example.invalid', next_label: 'ZZ One', message: { text: 'object' }, source: undefined,
    path: '/internal/status?token=zz-query', method: '/internal/status',
  });
  assert.deepEqual(Object.keys(records()[0]), ['ts', 'level', 'event']);
  for (const label of ['Zz-one', 'zz one', 'z'.repeat(33), '-zz', 42]) {
    const { logger: one, records: got } = capture();
    one.info('usage_read', { account_label: label });
    assert.equal('account_label' in got()[0], false, `${label} must be dropped`);
  }
});

test('logger: a file path (an account folder, accountsDir) cannot pass as a request path or a code', () => {
  const { logger, lines, records } = capture();
  const folder = '/zz/home/.codex-accounts/zz-one';
  logger.info('usage_read', { path: folder, reason: 'zz/home/.codex-accounts/zz-one', state: 'C:zz', source: folder });
  logger.info('usage_read', { path: '/internal/refresh-usage' });
  assert.deepEqual(Object.keys(records()[0]), ['ts', 'level', 'event']);
  assert.doesNotMatch(lines[0], /codex-accounts/);
  assert.equal(records()[1].path, '/internal/refresh-usage');
});

test('logger: an event name that is not a code becomes invalid-event', () => {
  const { logger, records } = capture();
  logger.info('free text event with spaces');
  logger.info({ event: 'object' });
  logger.info('ok_event');
  assert.deepEqual(records().map(record => record.event), ['invalid-event', 'invalid-event', 'ok_event']);
});

test('logger: dummy token forms never reach the log, whatever field carries them', () => {
  const { logger, lines } = capture();
  for (const token of DUMMY_TOKENS) {
    logger.warn('usage_read', { message: `upstream said ${token}`, error: new Error(`failed with ${token}`) });
    logger.warn(token.startsWith('sk-') ? token : 'usage_read', { reason: token, path: token, phase: token });
  }
  const text = lines.join('\n');
  for (const token of DUMMY_TOKENS) {
    const core = token.replace(/^(Authorization: )?Bearer /, '');
    assert.ok(!text.includes(core), `${core} leaked: ${text}`);
  }
  assert.match(text, /\[REDACTED\]/);
});

test('logger: a registered secret value is removed from every field, by value and regardless of its form', () => {
  const marker = `ZZ-MARKER-${randomBytes(8).toString('hex')}`;
  const lowerMarker = `zz-marker-${randomBytes(6).toString('hex')}`;
  const { logger, lines } = capture({ secrets: [marker, lowerMarker] });
  logger.info('control_token', {
    message: `token is ${marker}`, error: Object.assign(new Error(`bad ${marker}`), { name: marker }),
    reason: marker, path: `/internal/${marker}`, account_label: lowerMarker, next_label: lowerMarker,
  });
  logger.info(marker, {});
  const text = lines.join('\n');
  assert.ok(!text.includes(marker) && !text.includes(lowerMarker), text);
  assert.match(text, /\[REDACTED\]/);
});

test('logger: a secret registered after creation is removed from later lines (the control token path)', () => {
  const token = randomBytes(32).toString('hex');
  const { logger, lines } = capture();
  logger.info('daemon_start', { message: `before registration ${token}` });
  assert.ok(lines[0].includes(token), 'positive control: an unregistered value is not redacted');
  logger.registerSecret(token);
  logger.registerSecret('');
  logger.registerSecret(undefined);
  logger.info('daemon_start', { message: `after registration ${token}`, error: new Error(token) });
  assert.ok(!lines[1].includes(token), lines[1]);
});

test('logger: a failed write never throws and reports only a redacted line to stderr', () => {
  const marker = `ZZ-MARKER-${randomBytes(8).toString('hex')}`;
  const stderrLines = [];
  const logger = createCodexLogger({
    write: () => { throw new Error(`EACCES writing ${marker} sk-zz-fake-write-failure`); },
    stderrWriteImpl: line => stderrLines.push(line),
    secrets: [marker],
    now: FIXED_NOW,
  });
  assert.doesNotThrow(() => logger.error('usage_read', { message: 'x' }));
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /^codex-rotator log write failed: Error: EACCES writing/);
  assert.ok(!stderrLines[0].includes(marker) && !stderrLines[0].includes('sk-zz-fake-write-failure'));
  const silent = createCodexLogger({ write: () => { throw new Error('x'); }, stderrWriteImpl: () => { throw new Error('y'); } });
  assert.doesNotThrow(() => silent.info('usage_read'));
});

// ENOENT の形の例外（fs が投げる形）。メッセージにパスとメールアドレスが入っている。
function enoentShapedError() {
  const path = '/zz/home/.codex-accounts/ZZ-PATH-MARKER/zz@example.invalid/auth.json';
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${path}' (owner zz@example.invalid)`),
    { code: 'ENOENT', path, syscall: 'open' });
}

test('logger: a path and an email address inside an ENOENT-shaped error never reach the log', () => {
  const { logger, lines, records } = capture();
  logger.error('usage_read', { error: enoentShapedError(), message: enoentShapedError().message });
  const text = lines.join('\n');
  assert.ok(!text.includes('ZZ-PATH-MARKER') && !text.includes('zz@example.invalid'), text);
  assert.match(records()[0].error, /^Error: ENOENT: no such file or directory, open '\[REDACTED\]'/);
});

test('logger: the stderr line for a failed write redacts a path and an email address too', () => {
  const stderrLines = [];
  const logger = createCodexLogger({
    write: () => { throw enoentShapedError(); },
    stderrWriteImpl: line => stderrLines.push(line),
    now: FIXED_NOW,
  });
  logger.info('usage_read', { reason: 'zz-reason' });
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /^codex-rotator log write failed: Error: ENOENT/);
  assert.ok(!stderrLines[0].includes('ZZ-PATH-MARKER') && !stderrLines[0].includes('zz@example.invalid'), stderrLines[0]);
});

test('logger: a throwing getter, a throwing error name or a hostile fields object never makes the logger throw', () => {
  const { logger, records } = capture();
  const fields = { reason: 'kept' };
  Object.defineProperty(fields, 'message', { enumerable: true, get() { throw new Error('getter ZZ-MARKER-GETTER'); } });
  assert.doesNotThrow(() => logger.info('usage_read', fields));
  const badName = new Error('boom');
  Object.defineProperty(badName, 'name', { get() { throw new Error('name getter'); } });
  assert.doesNotThrow(() => logger.info('usage_read', { error: badName }));
  const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
  assert.doesNotThrow(() => logger.info('usage_read', hostile));
  const badClock = createCodexLogger({ write: () => {}, now: () => { throw new Error('clock'); } });
  assert.doesNotThrow(() => badClock.info('usage_read'));
  assert.deepEqual(records(), [
    { level: 'info', event: LOG_RECORD_UNAVAILABLE },
    { ts: '2026-09-27T00:00:00.000Z', level: 'info', event: 'usage_read', error: 'Error: boom' },
    { level: 'info', event: LOG_RECORD_UNAVAILABLE },
  ]);
  // 許可リストの外のキーの getter には触れない。
  let touched = false;
  const outside = {};
  Object.defineProperty(outside, 'zz_outside', { enumerable: true, get() { touched = true; return 1; } });
  logger.info('usage_read', outside);
  assert.equal(touched, false);
});

test('logger: the level threshold filters lines and an unknown level falls back to info', () => {
  const warn = capture({ level: 'warn' });
  for (const level of ['debug', 'info', 'warn', 'error']) warn.logger[level]('usage_read', { reason: level });
  assert.deepEqual(warn.records().map(record => record.level), ['warn', 'error']);
  const debug = capture({ level: 'debug' });
  debug.logger.debug('usage_read');
  debug.logger.info('usage_read');
  assert.equal(debug.lines.length, 2);
  const unknown = capture({ level: 'nonsense' });
  unknown.logger.debug('usage_read');
  unknown.logger.info('usage_read');
  assert.equal(unknown.lines.length, 1);
});

test('logger: with a path, a symbolic link at the log path is not followed and nothing is written through it', async t => {
  const isolation = await setupCodexIsolation(t);
  const folder = join(isolation.env.XDG_STATE_HOME, 'codex-rotator');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = join(isolation.root, 'zz-elsewhere.log');
  await writeFile(target, 'untouched\n', { mode: 0o600 });
  const path = join(folder, 'codex-rotator.log');
  await symlink(target, path);
  const stderrLines = [];
  const logger = createCodexLogger({ path, now: FIXED_NOW, stderrWriteImpl: line => stderrLines.push(line) });
  logger.info('usage_read', { reason: 'through-link' });
  assert.equal(await readFile(target, 'utf8'), 'untouched\n');
  assert.equal(stderrLines.length, 1);
  assert.match(stderrLines[0], /^codex-rotator log write failed: /);
  assert.ok(!stderrLines[0].includes(isolation.root), stderrLines[0]);
});

test('logger: with a path, an existing 0644 log file is set back to 0600 before appending', async t => {
  const isolation = await setupCodexIsolation(t);
  const folder = join(isolation.env.XDG_STATE_HOME, 'codex-rotator');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, 'codex-rotator.log');
  await writeFile(path, '');
  await chmod(path, 0o644);
  createCodexLogger({ path, now: FIXED_NOW }).info('usage_read', { reason: 'fixed' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reason, 'fixed');
  // setuid のビットが立っていても、0600 に直してから追記する。
  await chmod(path, 0o4644);
  createCodexLogger({ path, now: FIXED_NOW }).info('usage_read', { reason: 'again' });
  assert.equal((await stat(path)).mode & 0o7777, 0o600);
});

test('logger: with a path, an opened log file of another owner or not a regular file is refused and not written', async t => {
  const isolation = await setupCodexIsolation(t);
  const folder = join(isolation.env.XDG_STATE_HOME, 'codex-rotator');
  const path = join(folder, 'codex-rotator.log');
  const stderrLines = [];
  // 親フォルダの検査は本物の uid で通し、開いたファイルの fstat の結果だけを差し替える。
  const reporting = fstatSyncImpl => createCodexLogger({ path, now: FIXED_NOW, fstatSyncImpl,
    stderrWriteImpl: line => stderrLines.push(line) });
  const otherOwner = fd => {
    const real = fstatSync(fd);
    return { isFile: () => real.isFile(), uid: real.uid + 1, mode: real.mode };
  };
  reporting(otherOwner).info('usage_read', { reason: 'other-owner' });
  assert.match(stderrLines.at(-1), /the log file must be owned by the current user/);
  const notRegular = fd => ({ ...fstatSync(fd), isFile: () => false });
  reporting(notRegular).info('usage_read', { reason: 'not-regular' });
  assert.match(stderrLines.at(-1), /the log file must be a regular file/);
  assert.equal(stderrLines.length, 2);
  assert.equal(await readFile(path, 'utf8'), '', 'nothing is appended to a refused file');
  // 陽性対照: 差し替えなければ同じ場所へ書ける。
  reporting(fstatSync).info('usage_read', { reason: 'written' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).reason, 'written');
});

test('logger: with a path, a parent folder that is not private or not owned by the expected user is refused', async t => {
  const isolation = await setupCodexIsolation(t);
  const openFolder = join(isolation.env.XDG_STATE_HOME, 'zz-open');
  await mkdir(openFolder, { mode: 0o700 });
  await chmod(openFolder, 0o755);
  const stderrLines = [];
  const onOpenFolder = createCodexLogger({ path: join(openFolder, 'codex-rotator.log'), stderrWriteImpl: line => stderrLines.push(line) });
  onOpenFolder.info('usage_read');
  await assert.rejects(stat(join(openFolder, 'codex-rotator.log')), { code: 'ENOENT' });
  assert.match(stderrLines.at(-1), /the log folder must be private/);

  const privateFolder = join(isolation.env.XDG_STATE_HOME, 'zz-private');
  // 期待する所有者を別の uid にすると、フォルダの検査で止まる。
  createCodexLogger({ path: join(privateFolder, 'a.log'), uid: process.getuid() + 1, stderrWriteImpl: line => stderrLines.push(line) })
    .info('usage_read');
  assert.match(stderrLines.at(-1), /the log folder must be owned by the current user/);
  assert.equal(stderrLines.length, 2);
});

test('logger: with a path, appends lines to a 0600 file in a parent folder created as 0700', async t => {
  const isolation = await setupCodexIsolation(t);
  const path = join(isolation.env.XDG_STATE_HOME, 'codex-rotator', 'zz-nested', 'codex-rotator.log');
  const logger = createCodexLogger({ path, now: FIXED_NOW });
  logger.info('usage_read', { reason: 'first' });
  logger.info('usage_read', { reason: 'second' });
  const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.reason), ['first', 'second']);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(path, '..'))).mode & 0o777, 0o700);
});

test('logger: without write or path, lines go to the injected stderr sink', () => {
  const stderrLines = [];
  const logger = createCodexLogger({ stderrWriteImpl: line => stderrLines.push(line), now: FIXED_NOW });
  logger.info('usage_read', { reason: 'zz-reason' });
  assert.equal(stderrLines.length, 1);
  assert.equal(JSON.parse(stderrLines[0]).reason, 'zz-reason');
});
