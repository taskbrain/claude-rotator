import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AccountManager } from '../src/account-manager.js';
import {
  createNativeClaudeRefresher,
  NativeClaudeRefreshError,
  nativeRefreshObservation,
  refreshWithNativeClaudeCode,
} from '../src/native-claude-refresher.js';
import { createProxyServer } from '../src/proxy-server.js';
import { createRefreshLogFields } from '../src/refresh-log-fields.js';
import { MemorySecretStore } from '../src/secret-store.js';

// Every secret value carries this mark, so a leak into any log line is visible.
const SECRET_MARK = 'SECRETMARK';
// Every fake binary path carries this mark, so a leaked path is visible.
const PATH_MARK = 'PATHMARK';

const OLD_ACCESS_TOKEN = `${SECRET_MARK}-access-old`;
const OLD_REFRESH_TOKEN = `${SECRET_MARK}-refresh-old`;
const NEW_ACCESS_TOKEN = `${SECRET_MARK}-access-new`;
const NEW_REFRESH_TOKEN = `${SECRET_MARK}-refresh-new`;

// Fixed clock for the refresher (2023-11-14T22:13:20.000Z). Access expiries
// below are in the past of the wall clock, so the proxy always decides to refresh.
const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const OLD_EXPIRES_AT = NOW - 1000;
const NEW_EXPIRES_AT = NOW + 8 * HOUR_MS;
const PREVIOUS_LOGIN_EXPIRES_AT = NOW + 30 * DAY_MS;
const CHILD_LOGIN_EXPIRES_AT = NOW + 60 * DAY_MS;
const OTHER_LOGIN_EXPIRES_AT = NOW + 45 * DAY_MS;
// 2000-01-01T00:00:00.000Z, in seconds and in milliseconds.
const Y2K_SECONDS = 946_684_800;
const Y2K_MS = 946_684_800_000;
const Y2K_ISO = '2000-01-01T00:00:00.000Z';

const FAKE_COMMAND = `/opt/${PATH_MARK}-tool/bin/claude`;
const FAKE_VERSIONED_PATH = `/opt/${PATH_MARK}-tool/versions/9.8.7`;
const REAUTH_MESSAGE = 'The stored OAuth refresh credential has expired and must be linked again';
const OUTCOME_UNKNOWN_MESSAGE = 'Native Claude OAuth credential refresh outcome is unknown';

function iso(value) {
  return new Date(value).toISOString();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A refresh log line is "<timestamp> <body>"; the body must match to the end.
function assertRefreshLine(line, body) {
  assert.match(line, new RegExp(`^\\S+ ${escapeRegExp(body)}$`));
}

function refreshLines(logLines) {
  return logLines.filter(line => line.includes(' credential-refresh account='));
}

function assertNoMarks(lines) {
  for (const line of lines) {
    assert.equal(line.includes(SECRET_MARK), false, 'a secret mark reached the log');
    assert.equal(line.includes(PATH_MARK), false, 'a path mark reached the log');
  }
}

function previousContext(overrides = {}) {
  return {
    accessToken: OLD_ACCESS_TOKEN,
    refreshToken: OLD_REFRESH_TOKEN,
    expiresAt: OLD_EXPIRES_AT,
    scopes: ['user:profile', 'user:inference'],
    refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
    ...overrides,
  };
}

async function writeCredential(path, credential) {
  await writeFile(path, JSON.stringify({ claudeAiOauth: credential }), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

// Options for the native refresher that never reach a real binary, keychain or
// network: Linux file storage in a temporary sandbox, a fake child and fake
// path resolution.
function fakeNativeOptions({
  tempRoot,
  clock = { ms: NOW },
  childWrites = () => ({
    accessToken: NEW_ACCESS_TOKEN,
    refreshToken: NEW_REFRESH_TOKEN,
    expiresAt: NEW_EXPIRES_AT,
  }),
  command = FAKE_COMMAND,
  pinnedPath = FAKE_VERSIONED_PATH,
  executed = { count: 0 },
}) {
  return {
    platform: 'linux',
    command,
    env: {},
    tempRoot,
    now: () => clock.ms,
    accessImpl: async () => {},
    realpathImpl: async () => pinnedPath,
    execFileImpl: async (_command, _args, options) => {
      executed.count += 1;
      const credential = childWrites();
      if (credential) {
        await writeCredential(join(options.env.CLAUDE_CONFIG_DIR, '.credentials.json'), credential);
      }
      return { stdout: '', stderr: '' };
    },
  };
}

let tempRoot;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'refresh-expiry-log-test-'));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe('native refresh observation', () => {
  it('N1: a login expiry written by the child is received', async () => {
    const executed = { count: 0 };
    const result = await refreshWithNativeClaudeCode(OLD_REFRESH_TOKEN, previousContext(), fakeNativeOptions({
      tempRoot,
      executed,
      childWrites: () => ({
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresAt: NEW_EXPIRES_AT,
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
      }),
    }));
    assert.equal(executed.count, 1);
    const observation = nativeRefreshObservation(result);
    assert.notEqual(observation, null);
    assert.deepEqual({ ...observation }, {
      refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
      previousRefreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
      accessExpiresAt: NEW_EXPIRES_AT,
      source: 'received',
      claudeVersion: '9.8.7',
    });
    assert.deepEqual(Object.keys(result).sort(), [
      'accessToken', 'expiresAt', 'refreshToken', 'refreshTokenExpiresAt', 'scopes',
    ]);
  });

  it('N2: a login expiry only in the previous credential is carried', async () => {
    const executed = { count: 0 };
    const result = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      fakeNativeOptions({ tempRoot, executed }),
    );
    assert.equal(executed.count, 1);
    const observation = nativeRefreshObservation(result);
    assert.notEqual(observation, null);
    assert.equal(observation.source, 'carried');
    assert.equal(observation.refreshTokenExpiresAt, PREVIOUS_LOGIN_EXPIRES_AT);
    assert.equal(observation.previousRefreshTokenExpiresAt, PREVIOUS_LOGIN_EXPIRES_AT);
  });

  it('N3: no login expiry anywhere is absent', async () => {
    const executed = { count: 0 };
    const context = previousContext();
    delete context.refreshTokenExpiresAt;
    const result = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      context,
      fakeNativeOptions({ tempRoot, executed }),
    );
    assert.equal(executed.count, 1);
    const observation = nativeRefreshObservation(result);
    assert.notEqual(observation, null);
    assert.equal(observation.source, 'absent');
    assert.equal(observation.refreshTokenExpiresAt, null);
    assert.equal(observation.previousRefreshTokenExpiresAt, null);
    assert.equal(Object.hasOwn(result, 'refreshTokenExpiresAt'), false);
    assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'scopes']);
  });

  it('N4: a previous expiry stored in seconds is carried once in milliseconds', async () => {
    const storedSeconds = 1_900_000_000;
    assert.ok(storedSeconds >= 1e9 && storedSeconds < 1e12);
    const executed = { count: 0 };
    const result = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext({ refreshTokenExpiresAt: storedSeconds }),
      fakeNativeOptions({ tempRoot, executed }),
    );
    assert.equal(executed.count, 1);
    const observation = nativeRefreshObservation(result);
    assert.notEqual(observation, null);
    assert.equal(observation.source, 'carried');
    assert.equal(observation.refreshTokenExpiresAt, 1_900_000_000_000);
    assert.equal(observation.previousRefreshTokenExpiresAt, 1_900_000_000_000);
  });

  it('N5: the expired-login gate records only the two numbers and keeps its error', async () => {
    const executed = { count: 0 };
    let caught;
    try {
      await refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext({ refreshTokenExpiresAt: NOW - DAY_MS }),
        fakeNativeOptions({ tempRoot, executed }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NativeClaudeRefreshError);
    assert.equal(executed.count, 0);
    assert.equal(caught.code, 'NATIVE_REFRESH_REAUTH_REQUIRED');
    assert.equal(caught.message, REAUTH_MESSAGE);
    assert.deepEqual(Object.keys(caught).sort(), ['code', 'name', 'retryAfterMs', 'retryAfterSource']);
    assert.equal(Object.getOwnPropertySymbols(caught).length, 0);
    const observation = nativeRefreshObservation(caught);
    assert.notEqual(observation, null);
    assert.deepEqual({ ...observation }, {
      refreshTokenExpiresAt: NOW - DAY_MS,
      accessExpiresAt: OLD_EXPIRES_AT,
    });
  });

  it('N6: the reader returns null for anything it did not record, and a frozen record otherwise', async () => {
    assert.equal(nativeRefreshObservation({}), null);
    assert.equal(nativeRefreshObservation(null), null);
    assert.equal(nativeRefreshObservation('text'), null);
    const result = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      fakeNativeOptions({ tempRoot }),
    );
    const observation = nativeRefreshObservation(result);
    // Checked first: Object.isFrozen(null) is also true.
    assert.notEqual(observation, null);
    assert.equal(typeof observation, 'object');
    assert.equal(Object.isFrozen(observation), true);
  });

  it('N7: the version is the last part of the pinned path, and the path never shows', async () => {
    const result = await refreshWithNativeClaudeCode(
      OLD_REFRESH_TOKEN,
      previousContext(),
      fakeNativeOptions({ tempRoot }),
    );
    const observation = nativeRefreshObservation(result);
    assert.notEqual(observation, null);
    assert.equal(observation.claudeVersion, '9.8.7');
    assert.equal(JSON.stringify(observation).includes(PATH_MARK), false);
    assert.equal(JSON.stringify(result).includes(PATH_MARK), false);
  });

  it('N8: a pinned path that does not end in a version gives unknown', async () => {
    const cases = [
      { command: FAKE_COMMAND, pinnedPath: `/opt/${PATH_MARK}-tool/lib/cli.js` },
      { command: 'claude', pinnedPath: FAKE_VERSIONED_PATH },
      { command: FAKE_COMMAND, pinnedPath: `/opt/${PATH_MARK}-tool/versions/9.8.7 beta` },
      { command: FAKE_COMMAND, pinnedPath: `/opt/${PATH_MARK}-tool/versions/9.8.7;x` },
      { command: FAKE_COMMAND, pinnedPath: `/opt/${PATH_MARK}-tool/versions/9.8.7-${'a'.repeat(70)}` },
    ];
    for (const { command, pinnedPath } of cases) {
      const executed = { count: 0 };
      const result = await refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        fakeNativeOptions({ tempRoot, command, pinnedPath, executed }),
      );
      assert.equal(executed.count, 1, pinnedPath);
      const observation = nativeRefreshObservation(result);
      assert.notEqual(observation, null, pinnedPath);
      assert.equal(observation.claudeVersion, 'unknown', pinnedPath);
      assert.equal(JSON.stringify(observation).includes(PATH_MARK), false, pinnedPath);
    }
  });

  it('N9: a failure after the binary was pinned carries the version and keeps its error', async () => {
    const executed = { count: 0 };
    let caught;
    try {
      await refreshWithNativeClaudeCode(
        OLD_REFRESH_TOKEN,
        previousContext(),
        fakeNativeOptions({ tempRoot, executed, childWrites: () => null }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NativeClaudeRefreshError);
    assert.equal(executed.count, 1);
    assert.equal(caught.code, 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
    assert.equal(caught.message, OUTCOME_UNKNOWN_MESSAGE);
    assert.deepEqual(Object.keys(caught).sort(), ['code', 'name', 'retryAfterMs', 'retryAfterSource']);
    const observation = nativeRefreshObservation(caught);
    assert.notEqual(observation, null);
    assert.deepEqual({ ...observation }, { claudeVersion: '9.8.7' });
  });
});

// Builds the log field maker with a reader backed by a plain map.
function fieldsWith(entries = []) {
  const observations = new Map(entries);
  return createRefreshLogFields({ observe: target => observations.get(target) ?? null });
}

function reauthError() {
  return new NativeClaudeRefreshError(REAUTH_MESSAGE, 'NATIVE_REFRESH_REAUTH_REQUIRED');
}

describe('refresh log fields', () => {
  it('F1: formats the success fields and keeps "no previous value" apart from "unreadable"', () => {
    const received = {};
    const noPrevious = {};
    const unreadablePrevious = {};
    const absent = {};
    const unlisted = {};
    const unobserved = {};
    const fields = fieldsWith([
      [received, {
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
        previousRefreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'received',
        claudeVersion: '9.8.7',
      }],
      [noPrevious, {
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
        previousRefreshTokenExpiresAt: null,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'received',
        claudeVersion: '9.8.7',
      }],
      [unreadablePrevious, {
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
        previousRefreshTokenExpiresAt: 'not-a-number',
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'received',
        claudeVersion: 'unknown',
      }],
      [absent, {
        refreshTokenExpiresAt: null,
        previousRefreshTokenExpiresAt: null,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'absent',
        claudeVersion: '9.8.7',
      }],
      [unlisted, {
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
        previousRefreshTokenExpiresAt: null,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'guessed',
        claudeVersion: '9.8.7',
      }],
    ]);
    const context = { accountId: 'acct_1' };
    assert.equal(
      fields.success({ context, refreshed: received }),
      ` refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received refreshExpiresBefore=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} claudeVersion=9.8.7`,
    );
    assert.equal(
      fields.success({ context, refreshed: noPrevious }),
      ` refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received refreshExpiresBefore=none claudeVersion=9.8.7`,
    );
    assert.equal(
      fields.success({ context, refreshed: unreadablePrevious }),
      ` refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received refreshExpiresBefore=unknown claudeVersion=unknown`,
    );
    assert.equal(
      fields.success({ context, refreshed: absent }),
      ' refreshExpiresAt=none refreshExpirySource=absent refreshExpiresBefore=none claudeVersion=9.8.7',
    );
    assert.equal(fields.success({ context, refreshed: unlisted }), '');
    assert.equal(fields.success({ context, refreshed: unobserved }), '');
  });

  it('F2: never re-normalizes a millisecond value and turns broken values into unknown', () => {
    const y2k = {};
    const fields = fieldsWith([[y2k, {
      refreshTokenExpiresAt: Y2K_MS,
      previousRefreshTokenExpiresAt: Y2K_MS,
      accessExpiresAt: NEW_EXPIRES_AT,
      source: 'carried',
      claudeVersion: '9.8.7',
    }]]);
    assert.equal(
      fields.success({ context: { accountId: 'acct_1' }, refreshed: y2k }),
      ` refreshExpiresAt=${Y2K_ISO} refreshExpirySource=carried refreshExpiresBefore=${Y2K_ISO} claudeVersion=9.8.7`,
    );
    for (const broken of ['946684800000', 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      const refreshed = {};
      const brokenFields = fieldsWith([[refreshed, {
        refreshTokenExpiresAt: broken,
        previousRefreshTokenExpiresAt: broken,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'carried',
        claudeVersion: '9.8.7',
      }]]);
      assert.equal(
        brokenFields.success({ context: { accountId: 'acct_1' }, refreshed }),
        ' refreshExpiresAt=unknown refreshExpirySource=carried refreshExpiresBefore=unknown claudeVersion=9.8.7',
        String(broken),
      );
    }
  });

  it('F3: a rejection repeats the source only when both numbers match the last success', () => {
    const successObservation = source => ({
      refreshTokenExpiresAt: source === 'absent' ? null : PREVIOUS_LOGIN_EXPIRES_AT,
      previousRefreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
      accessExpiresAt: NEW_EXPIRES_AT,
      source,
      claudeVersion: '9.8.7',
    });
    const cases = [
      {
        label: 'both match',
        success: successObservation('carried'),
        rejection: { refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT },
        expected: ` refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=carried`,
      },
      {
        label: 'login expiry differs',
        success: successObservation('carried'),
        rejection: { refreshTokenExpiresAt: OTHER_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT },
        expected: ` refreshExpiresAt=${iso(OTHER_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
      },
      {
        label: 'access expiry differs',
        success: successObservation('received'),
        rejection: { refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT + 1 },
        expected: ` refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
      },
      {
        label: 'no earlier success',
        success: null,
        rejection: { refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT },
        expected: ` refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
      },
      {
        label: 'earlier success was absent',
        success: successObservation('absent'),
        rejection: { refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT },
        expected: ` refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
      },
    ];
    for (const { label, success, rejection, expected } of cases) {
      const refreshed = {};
      const error = reauthError();
      const entries = [[error, rejection]];
      if (success) entries.push([refreshed, success]);
      const fields = fieldsWith(entries);
      const context = { accountId: 'acct_1' };
      if (success) fields.success({ context, refreshed });
      assert.equal(fields.failure({ context, error, deferred: false }), expected, label);
    }
  });

  it('F4: deferred and unobserved failures add nothing, other failures add only the version', () => {
    const deferredError = reauthError();
    const unobservedError = reauthError();
    const otherError = new NativeClaudeRefreshError(OUTCOME_UNKNOWN_MESSAGE, 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
    const fields = fieldsWith([
      [deferredError, { refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT, accessExpiresAt: NEW_EXPIRES_AT }],
      [otherError, { claudeVersion: '9.8.7' }],
    ]);
    const context = { accountId: 'acct_1' };
    assert.equal(fields.failure({ context, error: deferredError, deferred: true }), '');
    assert.equal(fields.failure({ context, error: unobservedError, deferred: false }), '');
    assert.equal(fields.failure({ context, error: otherError, deferred: false }), ' claudeVersion=9.8.7');
  });

  it('F5: a throwing reader never makes either field maker throw', () => {
    let calls = 0;
    const fields = createRefreshLogFields({
      observe: () => {
        calls += 1;
        throw new Error('reader failed');
      },
    });
    const context = { accountId: 'acct_1' };
    assert.equal(fields.success({ context, refreshed: {} }), '');
    assert.equal(fields.failure({ context, error: reauthError(), deferred: false }), '');
    assert.equal(calls, 2);
  });

  it('F6: a version that is not in version form is printed as unknown', () => {
    const refreshed = {};
    const error = new NativeClaudeRefreshError(OUTCOME_UNKNOWN_MESSAGE, 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
    const fields = fieldsWith([
      [refreshed, {
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
        previousRefreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
        accessExpiresAt: NEW_EXPIRES_AT,
        source: 'received',
        claudeVersion: `/opt/${PATH_MARK}/versions/9.8.7`,
      }],
      [error, { claudeVersion: '9.8.7 beta' }],
    ]);
    const context = { accountId: 'acct_1' };
    assert.equal(
      fields.success({ context, refreshed }),
      ` refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received refreshExpiresBefore=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} claudeVersion=unknown`,
    );
    assert.equal(fields.failure({ context, error, deferred: false }), ' claudeVersion=unknown');
  });
});

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref?.();
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

const WATCH_METHODS = [
  'onAccountState', 'noteRefreshFailed', 'noteRefreshSucceeded', 'setDispersionSource',
  'statusSection', 'reload', 'start', 'stop',
];

// Same shape as the alert watch hooks; records the calls only.
function recordingWatch() {
  const calls = [];
  const watch = Object.fromEntries(WATCH_METHODS.map(name => [name, (...args) => {
    calls.push({ name, args });
    return name === 'statusSection' ? null : undefined;
  }]));
  return { calls, watch };
}

function storedSecret(overrides = {}) {
  return {
    accessToken: OLD_ACCESS_TOKEN,
    refreshToken: OLD_REFRESH_TOKEN,
    expiresAt: OLD_EXPIRES_AT,
    scopes: ['user:profile', 'user:inference'],
    refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
    ...overrides,
  };
}

// A proxy on 127.0.0.1 with a fake upstream on 127.0.0.1 and an in-memory store.
async function startProxy({ tokenRefresher, secret, alertWatch = null }) {
  const logLines = [];
  const upstream = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }));
  const secretStore = new MemorySecretStore();
  await secretStore.set('acct_1', secret);
  const accountManager = new AccountManager({
    accounts: [{ id: 'acct_1', name: 'a@example.com', type: 'oauth' }],
  });
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    config: { upstream: upstream.url },
    tokenRefresher,
    logger: line => logLines.push(line),
    alertWatch,
  }));
  return {
    logLines,
    secretStore,
    async send() {
      const response = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sonnet' }),
      });
      await response.text();
      return response.status;
    },
    async stop() {
      await close(proxy.server);
      await close(upstream.server);
    },
  };
}

const CARRIED_SUCCESS_BODY = `credential-refresh account=acct_1 result=success rotated=true expiresAt=${iso(NEW_EXPIRES_AT)} refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=carried refreshExpiresBefore=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} claudeVersion=9.8.7`;
const STORED_KEYS_WITH_LOGIN = ['accessToken', 'expiresAt', 'refreshToken', 'refreshTokenExpiresAt', 'scopes'];

// One successful native refresh followed by a refresh the expired-login gate
// rejects (the refresher clock is moved past the login expiry).
async function successThenRejection({ childWrites, rejectAt, beforeRejection, alertWatch } = {}) {
  const clock = { ms: NOW };
  const executed = { count: 0 };
  const proxy = await startProxy({
    tokenRefresher: createNativeClaudeRefresher(fakeNativeOptions({ tempRoot, clock, executed, childWrites })),
    secret: storedSecret(),
    alertWatch,
  });
  try {
    await proxy.send();
    assert.equal(executed.count, 1);
    const afterSuccess = await proxy.secretStore.get('acct_1');
    await beforeRejection?.(proxy.secretStore, afterSuccess);
    clock.ms = rejectAt;
    await proxy.send();
    assert.equal(executed.count, 1);
    return { logLines: proxy.logLines, afterSuccess, secretStore: proxy.secretStore };
  } finally {
    await proxy.stop();
  }
}

describe('refresh log wiring', () => {
  it('P1: a carried success is followed by a carried rejection of the same credential', async () => {
    const { logLines, afterSuccess } = await successThenRejection({ rejectAt: PREVIOUS_LOGIN_EXPIRES_AT + 1 });
    const lines = refreshLines(logLines);
    assert.equal(lines.length, 2);
    assertRefreshLine(lines[0], CARRIED_SUCCESS_BODY);
    assertRefreshLine(
      lines[1],
      `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=carried`,
    );
    assertNoMarks(logLines);
    assert.deepEqual(Object.keys(afterSuccess).sort(), STORED_KEYS_WITH_LOGIN);
  });

  it('P2: a received success is followed by a received rejection', async () => {
    const { logLines, afterSuccess } = await successThenRejection({
      childWrites: () => ({
        accessToken: NEW_ACCESS_TOKEN,
        refreshToken: NEW_REFRESH_TOKEN,
        expiresAt: NEW_EXPIRES_AT,
        refreshTokenExpiresAt: CHILD_LOGIN_EXPIRES_AT,
      }),
      rejectAt: CHILD_LOGIN_EXPIRES_AT + 1,
    });
    const lines = refreshLines(logLines);
    assert.equal(lines.length, 2);
    assertRefreshLine(
      lines[0],
      `credential-refresh account=acct_1 result=success rotated=true expiresAt=${iso(NEW_EXPIRES_AT)} refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received refreshExpiresBefore=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} claudeVersion=9.8.7`,
    );
    assertRefreshLine(
      lines[1],
      `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${iso(CHILD_LOGIN_EXPIRES_AT)} refreshExpirySource=received`,
    );
    assertNoMarks(logLines);
    assert.deepEqual(Object.keys(afterSuccess).sort(), STORED_KEYS_WITH_LOGIN);
  });

  it('P3: a success without any login expiry is logged as none and absent', async () => {
    const executed = { count: 0 };
    const secret = storedSecret();
    delete secret.refreshTokenExpiresAt;
    const proxy = await startProxy({
      tokenRefresher: createNativeClaudeRefresher(fakeNativeOptions({ tempRoot, executed })),
      secret,
    });
    try {
      await proxy.send();
      assert.equal(executed.count, 1);
      const lines = refreshLines(proxy.logLines);
      assert.equal(lines.length, 1);
      assertRefreshLine(
        lines[0],
        `credential-refresh account=acct_1 result=success rotated=true expiresAt=${iso(NEW_EXPIRES_AT)} refreshExpiresAt=none refreshExpirySource=absent refreshExpiresBefore=none claudeVersion=9.8.7`,
      );
      assertNoMarks(proxy.logLines);
      const stored = await proxy.secretStore.get('acct_1');
      assert.deepEqual(Object.keys(stored).sort(), ['accessToken', 'expiresAt', 'refreshToken', 'scopes']);
    } finally {
      await proxy.stop();
    }
  });

  it('P4: a rejection with no earlier success in this process is unknown', async () => {
    const executed = { count: 0 };
    const secret = storedSecret();
    const proxy = await startProxy({
      tokenRefresher: createNativeClaudeRefresher(fakeNativeOptions({
        tempRoot,
        executed,
        clock: { ms: PREVIOUS_LOGIN_EXPIRES_AT + 1 },
      })),
      secret,
    });
    try {
      await proxy.send();
      assert.equal(executed.count, 0);
      const lines = refreshLines(proxy.logLines);
      assert.equal(lines.length, 1);
      assertRefreshLine(
        lines[0],
        `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
      );
      assertNoMarks(proxy.logLines);
      assert.deepEqual(await proxy.secretStore.get('acct_1'), secret);
    } finally {
      await proxy.stop();
    }
  });

  it('P5: a stored credential replaced with another login expiry is unknown', async () => {
    const { logLines } = await successThenRejection({
      beforeRejection: (secretStore, current) => secretStore.set('acct_1', {
        ...current,
        refreshTokenExpiresAt: OTHER_LOGIN_EXPIRES_AT,
      }),
      rejectAt: PREVIOUS_LOGIN_EXPIRES_AT + DAY_MS * 30,
    });
    const lines = refreshLines(logLines);
    assert.equal(lines.length, 2);
    assertRefreshLine(lines[0], CARRIED_SUCCESS_BODY);
    assertRefreshLine(
      lines[1],
      `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${iso(OTHER_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
    );
    assertNoMarks(logLines);
  });

  it('P6: a relinked credential with the same login expiry is unknown', async () => {
    const relinkedExpiresAt = NEW_EXPIRES_AT + HOUR_MS;
    const { logLines } = await successThenRejection({
      beforeRejection: (secretStore, current) => secretStore.set('acct_1', {
        ...current,
        accessToken: `${SECRET_MARK}-access-relinked`,
        refreshToken: `${SECRET_MARK}-refresh-relinked`,
        expiresAt: relinkedExpiresAt,
      }),
      rejectAt: PREVIOUS_LOGIN_EXPIRES_AT + 1,
    });
    const lines = refreshLines(logLines);
    assert.equal(lines.length, 2);
    assertRefreshLine(lines[0], CARRIED_SUCCESS_BODY);
    assertRefreshLine(
      lines[1],
      `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${iso(PREVIOUS_LOGIN_EXPIRES_AT)} refreshExpirySource=unknown`,
    );
    assertNoMarks(logLines);
  });

  it('P7: a login expiry stored in seconds is logged once in milliseconds', async () => {
    assert.ok(Y2K_SECONDS < 1e12);
    const executed = { count: 0 };
    const proxy = await startProxy({
      tokenRefresher: createNativeClaudeRefresher(fakeNativeOptions({ tempRoot, executed })),
      secret: storedSecret({ refreshTokenExpiresAt: Y2K_SECONDS }),
    });
    try {
      await proxy.send();
      assert.equal(executed.count, 0);
      const lines = refreshLines(proxy.logLines);
      assert.equal(lines.length, 1);
      assertRefreshLine(
        lines[0],
        `credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED refreshExpiresAt=${Y2K_ISO} refreshExpirySource=unknown`,
      );
      assertNoMarks(proxy.logLines);
    } finally {
      await proxy.stop();
    }
  });

  it('P8: the version is on the success line only, never on the gate rejection', async () => {
    const { logLines } = await successThenRejection({ rejectAt: PREVIOUS_LOGIN_EXPIRES_AT + 1 });
    const lines = refreshLines(logLines);
    assert.equal(lines.length, 2);
    assert.match(lines[0], / claudeVersion=9\.8\.7$/);
    assert.equal(lines[1].includes('claudeVersion='), false);
    assertNoMarks(logLines);
  });

  it('P9: a refresher that is not the native one keeps both lines exactly as before', async () => {
    let calls = 0;
    const proxy = await startProxy({
      tokenRefresher: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            accessToken: NEW_ACCESS_TOKEN,
            refreshToken: NEW_REFRESH_TOKEN,
            expiresAt: NEW_EXPIRES_AT,
            refreshTokenExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT,
          };
        }
        throw reauthError();
      },
      secret: storedSecret(),
    });
    try {
      await proxy.send();
      await proxy.send();
      assert.equal(calls, 2);
      const lines = refreshLines(proxy.logLines);
      assert.equal(lines.length, 2);
      assertRefreshLine(
        lines[0],
        `credential-refresh account=acct_1 result=success rotated=true expiresAt=${iso(NEW_EXPIRES_AT)}`,
      );
      assertRefreshLine(
        lines[1],
        'credential-refresh account=acct_1 result=failed errorType=NATIVE_REFRESH_REAUTH_REQUIRED',
      );
      assertNoMarks(proxy.logLines);
      assert.deepEqual(Object.keys(await proxy.secretStore.get('acct_1')).sort(), STORED_KEYS_WITH_LOGIN);
    } finally {
      await proxy.stop();
    }
  });

  it('P10: the alert watch receives the same arguments when the native refresher is observed', async () => {
    const { calls, watch } = recordingWatch();
    const { logLines } = await successThenRejection({
      rejectAt: PREVIOUS_LOGIN_EXPIRES_AT + 1,
      alertWatch: watch,
    });
    const refreshCalls = calls
      .filter(({ name }) => name === 'noteRefreshSucceeded' || name === 'noteRefreshFailed')
      .map(({ name, args }) => [name, args]);
    assert.deepEqual(refreshCalls, [
      ['noteRefreshSucceeded', ['acct_1', { refreshCredentialExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT }]],
      ['noteRefreshFailed', ['acct_1', 'NATIVE_REFRESH_REAUTH_REQUIRED', { refreshCredentialExpiresAt: PREVIOUS_LOGIN_EXPIRES_AT }]],
    ]);
    assert.equal(refreshLines(logLines).length, 2);
    assertNoMarks(logLines);
  });
});
