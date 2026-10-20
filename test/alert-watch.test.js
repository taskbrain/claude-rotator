import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager } from '../src/account-manager.js';
import {
  ALERT_MAX_NOTICE_KEYS,
  ALERT_MAX_QUEUED_MESSAGES,
  createAlertWatch,
  normalizeAlertSettings,
} from '../src/alert-watch.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.UTC(2026, 0, 5, 12, 0, 0);
// Never read by the watch: the fake sender below is the only thing that sees it.
const URL_FILE = '/nonexistent/example/MARKER-PATH/hook-url';
const ENABLED = { macNotification: true, webhookUrlFile: URL_FILE };
const LOG_LINE_FORMS = [
  /^\S+ alert-send channel=mac result=[a-z0-9-]+$/,
  /^\S+ alert-send channel=webhook result=rejected-[a-z0-9-]+ reason=[a-z_]+$/,
  /^\S+ alert-send channel=webhook result=(?!rejected-)[a-z0-9-]+$/,
  /^\S+ alert-config warning=[a-z-]+$/,
];

// A clock with timers that only move when the test says so.
function createClock(start = START) {
  let t = start;
  let seq = 0;
  const tasks = new Map();
  const add = (fn, ms, repeat) => {
    const id = ++seq;
    tasks.set(id, { fn, at: t + ms, ms, repeat });
    return { id, unref() {} };
  };
  const remove = handle => {
    if (handle) tasks.delete(handle.id);
  };
  return {
    now: () => t,
    size: () => tasks.size,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, false),
      clearTimeout: remove,
      setInterval: (fn, ms) => add(fn, ms, true),
      clearInterval: remove,
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, task] of tasks) {
          if (task.at > end) continue;
          if (!next || task.at < next.task.at || (task.at === next.task.at && id < next.id)) next = { id, task };
        }
        if (!next) break;
        t = next.task.at;
        if (next.task.repeat) next.task.at += next.task.ms;
        else tasks.delete(next.id);
        next.task.fn();
      }
      t = end;
    },
  };
}

// Matches the sender interface exactly: notifyMac({title, body}),
// postWebhook({urlFile, text}), checkWebhookFile(urlFile), stop().
function createFakeSender({
  mac = () => ({ result: 'exited-0' }),
  webhook = () => ({ result: 'ok', reason: null }),
  check = () => ({ usable: true, problem: null }),
} = {}) {
  const calls = { notifyMac: [], postWebhook: [], checkWebhookFile: [], stop: 0 };
  return {
    calls,
    sender: {
      notifyMac(args) {
        calls.notifyMac.push(args);
        return mac(args);
      },
      postWebhook(args) {
        calls.postWebhook.push(args);
        return webhook(args);
      },
      checkWebhookFile(urlFile) {
        calls.checkWebhookFile.push(urlFile);
        return check(urlFile);
      },
      stop() {
        calls.stop += 1;
      },
    },
  };
}

// `skew` ({ ms }) moves the watch's clock away from the fake timers (a clock
// that jumps), and the two expiry-state functions stand in for alert-expiry.json.
function setup({
  settings = ENABLED,
  accounts = [{ id: 'alpha-example', name: 'alpha MARKER-NAME' }],
  sender = {},
  loadSettings = null,
  readExpiryState = null,
  writeExpiryState = null,
  skew = null,
} = {}) {
  const clock = createClock();
  const manager = new AccountManager({ accounts, now: clock.now });
  const fake = createFakeSender(sender);
  const lines = [];
  const watch = createAlertWatch({
    accountManager: manager,
    sender: fake.sender,
    settings,
    loadSettings,
    logger: line => lines.push(line),
    now: skew ? () => clock.now() + skew.ms : clock.now,
    timers: clock.timers,
    readExpiryState,
    writeExpiryState,
  });
  const row = id => manager.accounts.find(account => account.id === id);
  return { clock, manager, fake, lines, watch, row };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function texts(fake) {
  return fake.calls.postWebhook.map(call => call.text);
}

let unhandled;
const onUnhandled = reason => unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, []);
});

describe('normalizeAlertSettings', () => {
  it('is on only when a channel is set', () => {
    const off = { enabled: false, macNotification: false, webhookUrlFile: null };
    assert.deepEqual(normalizeAlertSettings(undefined), off);
    assert.deepEqual(normalizeAlertSettings(null), off);
    assert.deepEqual(normalizeAlertSettings([]), off);
    assert.deepEqual(normalizeAlertSettings({}), off);
    assert.deepEqual(normalizeAlertSettings({ macNotification: 'yes', webhookUrlFile: '  ' }), off);
    assert.deepEqual(normalizeAlertSettings({ macNotification: true }),
      { enabled: true, macNotification: true, webhookUrlFile: null });
    assert.deepEqual(normalizeAlertSettings({ webhookUrlFile: 'relative/hook-url' }),
      { enabled: true, macNotification: false, webhookUrlFile: 'relative/hook-url' });
    const normalized = normalizeAlertSettings(ENABLED);
    assert.deepEqual(normalizeAlertSettings(normalized), normalized);
  });

  it('keeps a relative webhook path enabled but unusable, and warns once per change', async () => {
    let raw = { webhookUrlFile: 'relative/MARKER-PATH/hook-url' };
    const { watch, lines, fake } = setup({ settings: raw, loadSettings: () => raw });
    watch.start();
    await settle();
    assert.equal(watch.statusSection().webhook, 'unusable');
    assert.equal(watch.statusSection().webhookProblem, 'not-absolute');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+ alert-config warning=not-absolute$/);
    assert.equal(fake.calls.checkWebhookFile.length, 0);

    watch.reload();
    await settle();
    assert.equal(lines.length, 1, 'the same problem on a reload is not logged again');

    raw = { webhookUrlFile: URL_FILE };
    watch.reload();
    await settle();
    assert.deepEqual(fake.calls.checkWebhookFile, [URL_FILE]);
    assert.equal(watch.statusSection().webhook, 'usable');
    assert.equal(watch.statusSection().webhookProblem, null);
    assert.equal(lines.length, 1);
    watch.stop();
  });

  it('reports a file problem from the sender check as a class only', async () => {
    const { watch, lines } = setup({ sender: { check: () => ({ usable: false, problem: 'mode' }) } });
    watch.start();
    await settle();
    assert.equal(watch.statusSection().webhook, 'unusable');
    assert.equal(watch.statusSection().webhookProblem, 'mode');
    assert.deepEqual(lines.map(line => line.replace(/^\S+ /, '')), ['alert-config warning=mode']);
    watch.stop();
  });
});

describe('status section', () => {
  it('has exactly the documented keys and no account, path or URL', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(MINUTE);
    await settle();
    const section = watch.statusSection();
    assert.deepEqual(Object.keys(section),
      ['macNotification', 'webhook', 'webhookProblem', 'active', 'lastDelivery', 'queued', 'dropped']);
    assert.deepEqual(section.active, { needsLogin: 1, failing: 0, expiringSoon: 0, dispersion: false });
    assert.deepEqual(section.lastDelivery, {
      mac: { at: new Date(START + MINUTE).toISOString(), result: 'exited-0' },
      webhook: { at: new Date(START + MINUTE).toISOString(), result: 'ok', reason: null },
    });
    assert.equal(section.queued, 0);
    assert.equal(section.dropped, 0);
    const json = JSON.stringify(section);
    for (const marker of ['alpha', 'MARKER', 'example', 'hook-url']) assert.ok(!json.includes(marker), marker);
    assert.equal(fake.calls.postWebhook.length, 1);
    watch.stop();
  });
});

describe('W1 relogin alert', () => {
  it('fires on the first refresh failure, survives markAuthenticated and recovers on a refresh success', async () => {
    const { watch, clock, fake, manager, row } = setup();
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    // Requests still go out on the old access token, so the usage fetch succeeds.
    manager.markAuthenticated('alpha-example');
    watch.onAccountState(row('alpha-example'));
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake), [
      'claude-rotator: 1 account(s) need a new login: alp…. Run "claude-rotator status" on the Mac.',
    ]);

    manager.markAuthenticated('alpha-example');
    watch.onAccountState(row('alpha-example'));
    clock.advance(10 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'markAuthenticated is not a recovery');
    assert.equal(watch.statusSection().active.needsLogin, 1);

    watch.noteRefreshSucceeded('alpha-example');
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake).slice(1), ['claude-rotator: working again: alp….']);
    assert.equal(watch.statusSection().active.needsLogin, 0);
    watch.stop();
  });

  it('recovers when the credential changes (a new login)', async () => {
    const { watch, clock, fake, manager, row } = setup();
    manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'invalid_grant' });
    watch.start();
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'a restart finds the state that was already there');
    assert.match(texts(fake)[0], /need a new login: alp…/);

    watch.onAccountState(row('alpha-example'), { credentialChanged: true });
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake).slice(1), ['claude-rotator: working again: alp….']);
    watch.stop();
  });

  it('does not raise again from the error left over from before the recovery', async () => {
    const { watch, clock, fake, manager, row } = setup();
    manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'NATIVE_REFRESH_REAUTH_REQUIRED' });
    watch.start();
    clock.advance(MINUTE);
    watch.noteRefreshSucceeded('alpha-example');
    watch.onAccountState(row('alpha-example'));
    clock.advance(10 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 2);
    assert.match(texts(fake)[1], /working again/);

    manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'NATIVE_REFRESH_REAUTH_REQUIRED' });
    watch.onAccountState(row('alpha-example'));
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 3, 'a new failure after the recovery raises again');
    watch.stop();
  });

  it('sends nothing when the account recovers before the batch goes out', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'invalid_grant');
    clock.advance(20_000);
    watch.noteRefreshSucceeded('alpha-example');
    clock.advance(10 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    assert.equal(fake.calls.notifyMac.length, 0);
    watch.stop();
  });

  it('forgets an account that left the ledger without a recovery message', async () => {
    const { watch, clock, fake, manager } = setup({
      accounts: [{ id: 'alpha-example', name: 'alpha' }, { id: 'bravo-example', name: 'bravo' }],
    });
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);

    manager.replaceAccounts([{ id: 'bravo-example', name: 'bravo' }]);
    clock.advance(7 * HOUR);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'no recovery and no reminder');
    assert.equal(watch.statusSection().active.needsLogin, 0);
    watch.stop();
  });

  it('ignores a refresh failure for an account that is not in the ledger', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed('ghost-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    watch.stop();
  });
});

describe('W2 failing alert', () => {
  it('stays quiet at 29 minutes and fires at 30 minutes', async () => {
    const { watch, clock, fake, manager } = setup();
    manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'http-500' });
    watch.start();
    clock.advance(29 * MINUTE);
    await settle();
    assert.equal(watch.statusSection().active.failing, 0);
    assert.equal(fake.calls.postWebhook.length, 0);

    clock.advance(MINUTE);
    assert.equal(watch.statusSection().active.failing, 1);
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake), [
      'claude-rotator: credential refresh has been failing for 31 min: alp… (http-500).',
    ]);
    watch.stop();
  });

  it('counts from the first refresh failure even while the account looks ready', async () => {
    const { watch, clock, fake, manager, row } = setup();
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_OUTCOME_UNKNOWN');
    clock.advance(15 * MINUTE);
    manager.markAuthenticated('alpha-example');
    watch.onAccountState(row('alpha-example'));
    clock.advance(14 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);
    assert.match(texts(fake)[0], /failing for 31 min: alp… \(NATIVE_REFRESH_OUTCOME_UNKNOWN\)\.$/);
    watch.stop();
  });

  it('does not fire for an account with a relogin alert', async () => {
    const { watch, clock, fake, manager } = setup();
    manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'NATIVE_REFRESH_REAUTH_REQUIRED' });
    watch.start();
    clock.advance(45 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);
    assert.match(texts(fake)[0], /need a new login/);
    assert.equal(watch.statusSection().active.failing, 0);
    watch.stop();
  });

  it('sends a recovery once the state is normal again', async () => {
    const { watch, clock, fake, manager, row } = setup();
    manager.markError('alpha-example', 'authentication_error');
    watch.start();
    clock.advance(31 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);
    manager.markAuthenticated('alpha-example');
    watch.onAccountState(row('alpha-example'));
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake).slice(1), ['claude-rotator: working again: alp….']);
    watch.stop();
  });

  it('treats a refresh cooldown as failing', async () => {
    const { watch, clock, fake, manager } = setup();
    manager.markCredentialRefreshRateLimited('alpha-example', 3 * 3600);
    watch.start();
    clock.advance(31 * MINUTE);
    await settle();
    assert.match(texts(fake)[0], /failing for 31 min: alp… \(oauth_refresh_rate_limit\)\.$/);
    watch.stop();
  });
});

describe('W3 batching and reminders', () => {
  it('sends three accounts within 60 seconds as one message and reminds once after 6 hours', async () => {
    const { watch, clock, fake } = setup({
      accounts: [
        { id: 'alpha-example', name: 'alpha' },
        { id: 'bravo-example', name: 'bravo' },
        { id: 'charlie-example', name: 'charlie' },
      ],
    });
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(20_000);
    watch.noteRefreshFailed('bravo-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(20_000);
    watch.noteRefreshFailed('charlie-example', 'invalid_grant');
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(20_000);
    await settle();
    assert.deepEqual(texts(fake), [
      'claude-rotator: 3 account(s) need a new login: alp…, bra…, cha…. Run "claude-rotator status" on the Mac.',
    ]);
    assert.equal(fake.calls.notifyMac.length, 1);

    clock.advance(6 * HOUR - MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'no reminder before 6 hours');
    clock.advance(2 * MINUTE);
    await settle();
    assert.deepEqual(texts(fake).slice(1), [
      'Still unresolved: claude-rotator: 3 account(s) need a new login: alp…, bra…, cha…. Run "claude-rotator status" on the Mac.',
    ]);
    clock.advance(5 * HOUR);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 2);
    watch.stop();
  });
});

// ---- login expiry stages: 7 days, 3 days, 1 day before, and expired ----
//
// Times are written as START + t. The expected texts are written out in full;
// nothing below computes them with the code under test.

const SECOND = 1000;
const DAY = 24 * HOUR;
const ALPHA = 'alpha-example';
const BRAVO = 'bravo-example';
const CHARLIE = 'charlie-example';
const THREE_ACCOUNTS = [
  { id: ALPHA, name: 'alpha MARKER-NAME' },
  { id: BRAVO, name: 'bravo MARKER-NAME' },
  { id: CHARLIE, name: 'charlie MARKER-NAME' },
];
const D7 = 'claude-rotator: login expires within 7 days for 1 account(s): alp…. Run "claude-rotator status" on the Mac.';
const D3 = 'claude-rotator: login expires within 3 days for 1 account(s): alp…. Run "claude-rotator status" on the Mac.';
const D1 = 'claude-rotator: login expires within 1 day for 1 account(s): alp…. Run "claude-rotator status" on the Mac.';
const EX = 'claude-rotator: login expired for 1 account(s): alp…. Run "claude-rotator status" on the Mac.';
const RL = 'claude-rotator: 1 account(s) need a new login: alp…. Run "claude-rotator status" on the Mac.';
const WA = 'claude-rotator: working again: alp….';

// Moves the fake clock to START + t and lets the sends finish.
async function until(clock, t) {
  clock.advance(START + t - clock.now());
  await settle();
}

function succeed(watch, id, value) {
  watch.noteRefreshSucceeded(id, { refreshCredentialExpiresAt: value });
}

function messageLines(fake) {
  return texts(fake).flatMap(text => text.split('\n'));
}

// A stand-in for alert-expiry.json. `read` returns what a read gives back (a
// function, so a test can hold or reject it); every write is copied.
function fakeExpiryStore({ read = () => Promise.resolve(null), write = () => undefined } = {}) {
  const calls = { read: 0, writes: [] };
  return {
    calls,
    readExpiryState: () => {
      calls.read += 1;
      return read();
    },
    writeExpiryState: state => {
      calls.writes.push(structuredClone(state));
      return write(state);
    },
  };
}

function storeOptions(store) {
  return { readExpiryState: store.readExpiryState, writeExpiryState: store.writeExpiryState };
}

function remembered(stage, expiresAt = START + 6 * DAY, id = ALPHA) {
  return { format: 1, accounts: { [id]: { expiresAt, stage } } };
}

describe('expiry stages: boundaries and progression', () => {
  it('sends 7 days, 3 days, 1 day and expired once each, each just after its boundary', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 8 * DAY);
    watch.start();
    await until(clock, DAY - 2 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    await until(clock, DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    await until(clock, 5 * DAY - 2 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 1);
    await until(clock, 5 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    await until(clock, 7 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3, D1]);
    await until(clock, 8 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3, D1, EX]);
    await until(clock, 9 * DAY);
    assert.equal(fake.calls.postWebhook.length, 4);
    assert.equal(fake.calls.notifyMac[0].body,
      'claude-rotator: login expires within 7 days: alpha-example.\nRun: claude-rotator login --id alpha-example');
    assert.equal(fake.calls.notifyMac[3].body,
      'claude-rotator: login expired: alpha-example.\nRun: claude-rotator login --id alpha-example');
    watch.stop();
  });

  it('exactly 7 days left at a sweep is inside the 7-day stage', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 7 * DAY + 5 * MINUTE);
    watch.start();
    await until(clock, 5 * MINUTE + 30 * SECOND);
    assert.equal(fake.calls.postWebhook.length, 0);
    await until(clock, 6 * MINUTE + 30 * SECOND);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });

  it('one millisecond more than 7 days waits for the next sweep', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 7 * DAY + 5 * MINUTE + 1);
    watch.start();
    await until(clock, 6 * MINUTE + 30 * SECOND);
    assert.equal(fake.calls.postWebhook.length, 0);
    await until(clock, 7 * MINUTE + 30 * SECOND);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });

  it('an expiry 3 minutes away sends 1 day, then expired', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 3 * MINUTE);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D1]);
    await until(clock, 4 * MINUTE + 30 * SECOND);
    assert.deepEqual(texts(fake), [D1, EX]);
    watch.stop();
  });

  it('5 days left sends 7 days at once and 3 days two days later', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 5 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    await until(clock, 2 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    watch.stop();
  });

  it('a stage already passed when the expiry is first seen is not sent', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 2 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    await until(clock, DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D3, D1]);
    watch.stop();
  });

  it('12 hours left sends 1 day only, then expired', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 12 * HOUR);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D1]);
    await until(clock, 12 * HOUR + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D1, EX]);
    watch.stop();
  });

  it('an expiry that has already passed is sent once as expired', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed(ALPHA, 'http-500', { refreshCredentialExpiresAt: START - MINUTE });
    await until(clock, DAY);
    const expired = messageLines(fake).filter(line => line.startsWith('claude-rotator: login expired '));
    assert.equal(expired.length, 1);
    watch.stop();
  });

  it('a clock that goes back sends no stage twice', async () => {
    const skew = { ms: 0 };
    const { watch, clock, fake } = setup({ skew });
    succeed(watch, ALPHA, START + 4 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    await until(clock, DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    await until(clock, DAY + 5 * MINUTE);
    skew.ms = -2 * DAY;
    await until(clock, 3 * DAY + 5 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    await until(clock, 5 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3, D1]);
    watch.stop();
  });

  it('a clock that jumps ahead skips the stages it jumped over', async () => {
    const skew = { ms: 0 };
    const { watch, clock, fake } = setup({ skew });
    succeed(watch, ALPHA, START + 4 * DAY);
    watch.start();
    await until(clock, 10 * MINUTE);
    skew.ms = 3.5 * DAY;
    await until(clock, 13 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D1]);
    watch.stop();
  });
});

describe('expiry stages: the relogin alert comes first', () => {
  it('sends no stage while the account needs a new login', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed(ALPHA, 'invalid_grant', { refreshCredentialExpiresAt: START + 2 * DAY });
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [RL]);
    await until(clock, 1.5 * DAY + 2 * MINUTE);
    assert.deepEqual(messageLines(fake).filter(line => line.startsWith('claude-rotator: login exp')), []);
    watch.stop();
  });

  async function reloginWhileStageWaits() {
    const context = setup();
    const { watch, clock, fake } = context;
    succeed(watch, ALPHA, START + 20 * HOUR);
    watch.start();
    await until(clock, 30 * SECOND);
    watch.noteRefreshFailed(ALPHA, 'invalid_grant', { refreshCredentialExpiresAt: START + 20 * HOUR });
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [RL]);
    return context;
  }

  it('drops a waiting stage when the relogin alert comes in the same batch', async () => {
    const { watch } = await reloginWhileStageWaits();
    watch.stop();
  });

  it('an expired stage already sent may be followed by the relogin alert', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 3 * MINUTE);
    watch.start();
    await until(clock, 10 * MINUTE);
    watch.noteRefreshFailed(ALPHA, 'NATIVE_REFRESH_REAUTH_REQUIRED', { refreshCredentialExpiresAt: START + 3 * MINUTE });
    await until(clock, 12 * MINUTE);
    assert.deepEqual(texts(fake), [D1, EX, RL]);
    watch.stop();
  });

  it('sends the dropped stage after the relogin alert ends, before the recovery line', async () => {
    const { watch, clock, fake } = await reloginWhileStageWaits();
    await until(clock, 5 * MINUTE + 30 * SECOND);
    succeed(watch, ALPHA, START + 20 * HOUR);
    await until(clock, 7 * MINUTE);
    assert.deepEqual(texts(fake), [RL, `${D1}\n${WA}`]);
    await until(clock, 20 * HOUR + 2 * MINUTE);
    assert.deepEqual(texts(fake), [RL, `${D1}\n${WA}`, EX]);
    watch.stop();
  });

  it('a new login after the relogin alert counts the new expiry from the start', async () => {
    const { watch, clock, fake, row } = setup();
    watch.start();
    watch.noteRefreshFailed(ALPHA, 'invalid_grant', { refreshCredentialExpiresAt: START + 2 * DAY });
    await until(clock, 5 * MINUTE);
    watch.onAccountState(row(ALPHA), { credentialChanged: true });
    succeed(watch, ALPHA, START + 5 * MINUTE + 28 * DAY);
    await until(clock, 7 * MINUTE);
    assert.deepEqual(texts(fake), [RL, WA]);
    await until(clock, 21 * DAY + 7 * MINUTE);
    assert.deepEqual(texts(fake), [RL, WA, D7]);
    watch.stop();
  });
});

describe('expiry stages: a new credential and large changes', () => {
  it('a changed credential starts the stages over for the new expiry', async () => {
    const { watch, clock, fake, row } = setup();
    succeed(watch, ALPHA, START + 2 * DAY);
    watch.start();
    await until(clock, 10 * MINUTE);
    watch.onAccountState(row(ALPHA), { credentialChanged: true });
    succeed(watch, ALPHA, START + 10 * MINUTE + 28 * DAY);
    await until(clock, 20 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    await until(clock, 21 * DAY + 12 * MINUTE);
    assert.deepEqual(texts(fake), [D3, D7]);
    watch.stop();
  });

  it('a changed credential drops the stage still waiting for its batch', async () => {
    const { watch, clock, fake, row } = setup();
    succeed(watch, ALPHA, START + 20 * HOUR);
    watch.start();
    await until(clock, 30 * SECOND);
    watch.onAccountState(row(ALPHA), { credentialChanged: true });
    await until(clock, 2 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    succeed(watch, ALPHA, START + 28 * DAY);
    await until(clock, 5 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    watch.stop();
  });

  it('an expiry more than a day later counts as a new one even without a changed credential', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 2 * DAY);
    watch.start();
    await until(clock, 10 * MINUTE);
    succeed(watch, ALPHA, START + 2 * DAY + 21 * DAY);
    await until(clock, 20 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    await until(clock, 16 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D3, D7]);
    watch.stop();
  });
});

describe('expiry stages: the values and small changes', () => {
  it('ignores a value that is not a usable expiry', async () => {
    for (const value of [null, NaN, 0, -5, Infinity, '1767614400000', 9e15]) {
      const { watch, clock, fake } = setup();
      succeed(watch, ALPHA, value);
      watch.start();
      await until(clock, 2 * MINUTE);
      assert.equal(fake.calls.postWebhook.length, 0, String(value));
      assert.equal(watch.statusSection().active.expiringSoon, 0, String(value));
      watch.stop();
    }
  });

  it('a missing value keeps the known expiry', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 6 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    await until(clock, 10 * MINUTE);
    succeed(watch, ALPHA, null);
    await until(clock, 3 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    watch.stop();
  });

  it('a change of 30 minutes around a boundary does not send a stage twice', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 3 * DAY + 2 * MINUTE);
    watch.start();
    await until(clock, 4 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    await until(clock, 5 * MINUTE + 10 * SECOND);
    succeed(watch, ALPHA, START + 3 * DAY + 2 * MINUTE + 30 * MINUTE);
    await until(clock, 40 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 2);
    watch.stop();
  });

  it('61 minutes later in the same stage sends nothing new', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 2 * DAY + 12 * HOUR);
    watch.start();
    await until(clock, 10 * MINUTE);
    succeed(watch, ALPHA, START + 2 * DAY + 12 * HOUR + 61 * MINUTE);
    await until(clock, 20 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    watch.stop();
  });

  it('up to a day later lowers the sent stage to the new one and sends it again at its boundary', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 2 * DAY + 21 * HOUR);
    watch.start();
    await until(clock, 10 * MINUTE);
    succeed(watch, ALPHA, START + 2 * DAY + 21 * HOUR + DAY);
    await until(clock, 20 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    await until(clock, 21 * HOUR + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D3, D3]);
    watch.stop();
  });

  it('an earlier expiry sends the nearer stage it has reached', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 2 * DAY + 12 * HOUR);
    watch.start();
    await until(clock, 10 * MINUTE);
    succeed(watch, ALPHA, START + 12 * HOUR);
    await until(clock, 15 * MINUTE);
    assert.deepEqual(texts(fake), [D3, D1]);
    watch.stop();
  });

  it('the same value ten times sends one message', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    for (let i = 0; i < 10; i += 1) {
      succeed(watch, ALPHA, START + 6 * DAY);
      clock.advance(SECOND);
    }
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });

  it('a stage whose expiry moved later while it waited is dropped and sent at the new boundary', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 7 * DAY + 5 * MINUTE);
    watch.start();
    await until(clock, 5 * MINUTE + 20 * SECOND);
    succeed(watch, ALPHA, START + 7 * DAY + 5 * MINUTE + 10 * MINUTE);
    await until(clock, 6 * MINUTE + 30 * SECOND);
    assert.equal(fake.calls.postWebhook.length, 0);
    await until(clock, 16 * MINUTE + 30 * SECOND);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });
});

describe('expiry stages: the remembered stages', () => {
  const E = START + 6 * DAY;

  async function started(options = {}, store = fakeExpiryStore()) {
    const context = setup({ ...options, ...storeOptions(store) });
    context.watch.start();
    await settle();
    return { ...context, store };
  }

  it('a remembered stage is not sent again, and the next stage is remembered', async () => {
    const { watch, clock, fake, store } = await started({}, fakeExpiryStore({ read: () => Promise.resolve(remembered('7d')) }));
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    assert.equal(store.calls.writes.length, 0);
    await until(clock, 3 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    assert.deepEqual(store.calls.writes.at(-1), remembered('3d'));
    watch.stop();
  });

  it('a value within 60 minutes of the remembered one is the same expiry, and the file is read once', async () => {
    const { watch, clock, fake, store } = await started({}, fakeExpiryStore({ read: () => Promise.resolve(remembered('7d')) }));
    succeed(watch, ALPHA, E + 30 * MINUTE);
    await until(clock, 3 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    assert.equal(store.calls.read, 1);
    await until(clock, 3 * DAY + 32 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    watch.stop();
  });

  it('a value more than a day later than the remembered one starts over', async () => {
    const { watch, clock, fake } = await started({}, fakeExpiryStore({ read: () => Promise.resolve(remembered('3d')) }));
    succeed(watch, ALPHA, E + 20 * DAY);
    await until(clock, 3 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 0);
    await until(clock, 19 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });

  it('an earlier value than the remembered one keeps the remembered stage', async () => {
    const { watch, clock, fake } = await started({}, fakeExpiryStore({ read: () => Promise.resolve(remembered('7d')) }));
    succeed(watch, ALPHA, E - 4 * DAY);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D3]);
    watch.stop();
  });

  async function startsFromNothing(read) {
    const { watch, clock, fake, store, lines } = await started({}, fakeExpiryStore({ read }));
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    assert.deepEqual(store.calls.writes, [remembered('7d')]);
    for (const line of lines) assert.ok(LOG_LINE_FORMS.some(form => form.test(line)), line);
    watch.stop();
    return store;
  }

  it('nothing remembered sends the stage and writes it once', async () => {
    await startsFromNothing(() => Promise.resolve(null));
  });

  it('an unreadable file counts as nothing remembered, with no new log line', async () => {
    await startsFromNothing(() => Promise.reject(new SyntaxError('Unexpected token in JSON')));
  });

  it('a file of another format counts as nothing remembered', async () => {
    await startsFromNothing(() => Promise.resolve({ format: 2, accounts: remembered('7d').accounts }));
  });

  it('drops only the rows that do not fit', async () => {
    const { watch, clock, fake } = await started({ accounts: THREE_ACCOUNTS }, fakeExpiryStore({
      read: () => Promise.resolve({
        format: 1,
        accounts: {
          [ALPHA]: { expiresAt: E, stage: '7d' },
          [BRAVO]: { expiresAt: E, stage: 'x' },
          [CHARLIE]: { expiresAt: 'NaN', stage: '7d' },
        },
      }),
    }));
    for (const id of [ALPHA, BRAVO, CHARLIE]) succeed(watch, id, E);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [
      'claude-rotator: login expires within 7 days for 2 account(s): bra…, cha…. Run "claude-rotator status" on the Mac.',
    ]);
    assert.deepEqual(fake.calls.notifyMac.map(call => call.body), [
      'claude-rotator: login expires within 7 days: bravo-example, charlie-example.\nRun: claude-rotator login --id bravo-example\nRun: claude-rotator login --id charlie-example',
    ]);
    watch.stop();
  });

  it('a read that does not finish counts as nothing remembered, and its late result is not used', async () => {
    let finishRead = null;
    const { watch, clock, fake } = await started({}, fakeExpiryStore({
      read: () => new Promise(resolve => {
        finishRead = resolve;
      }),
    }));
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    await until(clock, 4 * MINUTE);
    finishRead(remembered('7d'));
    await settle();
    await until(clock, 3 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    watch.stop();
  });

  it('writes no row for an account that is not in the ledger', async () => {
    const { watch, clock, fake, store } = await started({}, fakeExpiryStore({
      read: () => Promise.resolve(remembered('7d', E, 'zulu-example')),
    }));
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    assert.ok(store.calls.writes.length > 0);
    assert.equal(JSON.stringify(store.calls.writes).includes('zulu-example'), false);
    watch.stop();
  });

  it('a stage that was not handed over before a stop is sent after the restart, once in all', async () => {
    const store = fakeExpiryStore();
    const first = await started({}, store);
    succeed(first.watch, ALPHA, E);
    await until(first.clock, 90 * SECOND);
    first.watch.stop();
    await settle();
    assert.equal(first.fake.calls.postWebhook.length, 0);
    assert.equal(store.calls.writes.length, 0);

    const second = createAlertWatch({
      accountManager: first.manager,
      sender: first.fake.sender,
      settings: ENABLED,
      logger: line => first.lines.push(line),
      now: first.clock.now,
      timers: first.clock.timers,
      ...storeOptions(store),
    });
    second.start();
    await settle();
    succeed(second, ALPHA, E);
    await until(first.clock, 90 * SECOND + 3 * MINUTE);
    assert.deepEqual(texts(first.fake), [D7]);
    second.stop();
  });

  it('a write that keeps failing changes nothing else and is tried again after the next stage', async () => {
    const { watch, clock, fake, store, lines } = await started({}, fakeExpiryStore({
      write: () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    }));
    assert.doesNotThrow(() => succeed(watch, ALPHA, E));
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    for (const line of lines) assert.ok(LOG_LINE_FORMS.some(form => form.test(line)), line);
    await until(clock, 3 * DAY + 2 * MINUTE);
    assert.deepEqual(texts(fake), [D7, D3]);
    assert.equal(store.calls.writes.length, 2);
    watch.stop();
  });

  it('writes one at a time, and once more with the latest content after a slow write', async () => {
    let release = null;
    const { watch, clock, store } = await started({ accounts: THREE_ACCOUNTS }, fakeExpiryStore({
      write: () => (release ? undefined : new Promise(resolve => {
        release = resolve;
      })),
    }));
    succeed(watch, ALPHA, E);
    succeed(watch, BRAVO, START + 7 * DAY + 3 * MINUTE);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(store.calls.writes, [remembered('7d')]);
    await until(clock, 5 * MINUTE);
    assert.equal(store.calls.writes.length, 1, 'the second write waits for the first');
    release();
    await settle();
    assert.deepEqual(store.calls.writes, [remembered('7d'), {
      format: 1,
      accounts: {
        [ALPHA]: { expiresAt: E, stage: '7d' },
        [BRAVO]: { expiresAt: START + 7 * DAY + 3 * MINUTE, stage: '7d' },
      },
    }]);
    watch.stop();
  });

  it('without the alerts section the file is neither read nor written', async () => {
    const { watch, clock, store } = await started({ settings: {} });
    succeed(watch, ALPHA, E);
    clock.advance(10 * MINUTE);
    await settle();
    assert.equal(store.calls.read, 0);
    assert.equal(store.calls.writes.length, 0);
    assert.equal(clock.size(), 0);
    watch.stop();
  });

  it('a reload that turns the section on reads the file once', async () => {
    const { watch, store } = await started({ settings: {}, loadSettings: () => ENABLED });
    watch.reload();
    await settle();
    watch.reload();
    await settle();
    assert.equal(store.calls.read, 1);
    watch.stop();
  });

  it('turning the section off and on again keeps what was remembered', async () => {
    let raw = ENABLED;
    const { watch, clock, fake, store } = await started({ loadSettings: () => raw });
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    assert.equal(store.calls.writes.length, 1);
    raw = {};
    watch.reload();
    raw = ENABLED;
    watch.reload();
    await settle();
    succeed(watch, ALPHA, E);
    await until(clock, 10 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    assert.equal(store.calls.read, 1);
    watch.stop();
  });

  it('a changed credential takes its row out of the next write', async () => {
    const { watch, clock, store, row } = await started({ accounts: THREE_ACCOUNTS });
    succeed(watch, ALPHA, E);
    succeed(watch, BRAVO, START + 7 * DAY + 3 * MINUTE);
    await until(clock, 150 * SECOND);
    watch.onAccountState(row(ALPHA), { credentialChanged: true });
    await until(clock, 5 * MINUTE);
    assert.deepEqual(store.calls.writes, [
      remembered('7d'),
      remembered('7d', START + 7 * DAY + 3 * MINUTE, BRAVO),
    ]);
    watch.stop();
  });

  it('writes only after the sender has returned', async () => {
    const waiting = [];
    const hold = result => () => new Promise(resolve => waiting.push(() => resolve(result)));
    const { watch, clock, store } = await started({
      sender: { mac: hold({ result: 'exited-0' }), webhook: hold({ result: 'ok', reason: null }) },
    });
    succeed(watch, ALPHA, E);
    await until(clock, 3 * MINUTE);
    assert.equal(store.calls.writes.length, 0);
    for (const go of waiting.splice(0)) go();
    await settle();
    assert.equal(store.calls.writes.length, 1);
    watch.stop();
  });

  it('the written content carries no name, path or URL file', async () => {
    const store = await startsFromNothing(() => Promise.resolve(null));
    assert.equal(store.calls.writes.length, 1);
    const written = JSON.stringify(store.calls.writes[0]);
    for (const marker of ['MARKER-NAME', 'MARKER-PATH', URL_FILE]) assert.equal(written.includes(marker), false, marker);
  });

  it('a remembered row for an expiry more than a day earlier starts over', async () => {
    const { watch, clock, fake } = await started({}, fakeExpiryStore({
      read: () => Promise.resolve(remembered('3d', START + 2 * DAY)),
    }));
    succeed(watch, ALPHA, START + 7 * DAY);
    await until(clock, 3 * MINUTE);
    assert.deepEqual(texts(fake), [D7]);
    watch.stop();
  });
});

describe('expiry stages: batching', () => {
  it('two accounts in the same stage share one line', async () => {
    const { watch, clock, fake } = setup({ accounts: THREE_ACCOUNTS });
    succeed(watch, ALPHA, START + 6 * DAY);
    succeed(watch, BRAVO, START + 6 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [
      'claude-rotator: login expires within 7 days for 2 account(s): alp…, bra…. Run "claude-rotator status" on the Mac.',
    ]);
    assert.deepEqual(fake.calls.notifyMac.map(call => call.body), [
      'claude-rotator: login expires within 7 days: alpha-example, bravo-example.\nRun: claude-rotator login --id alpha-example\nRun: claude-rotator login --id bravo-example',
    ]);
    watch.stop();
  });

  it('different stages in one message go nearest first', async () => {
    const { watch, clock, fake } = setup({ accounts: THREE_ACCOUNTS });
    succeed(watch, ALPHA, START + 12 * HOUR);
    succeed(watch, BRAVO, START + 5 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [[
      'claude-rotator: login expires within 1 day for 1 account(s): alp…. Run "claude-rotator status" on the Mac.',
      'claude-rotator: login expires within 7 days for 1 account(s): bra…. Run "claude-rotator status" on the Mac.',
    ].join('\n')]);
    watch.stop();
  });

  it('stages more than a batch apart go out as two messages', async () => {
    const { watch, clock, fake } = setup({ accounts: THREE_ACCOUNTS });
    succeed(watch, ALPHA, START + 6 * DAY);
    watch.start();
    await until(clock, 3 * MINUTE);
    succeed(watch, BRAVO, START + 6 * DAY);
    await until(clock, 5 * MINUTE);
    assert.equal(fake.calls.postWebhook.length, 2);
    watch.stop();
  });

  it('a relogin line of another account goes before the stage line', async () => {
    const { watch, clock, fake } = setup({ accounts: THREE_ACCOUNTS });
    watch.noteRefreshFailed(BRAVO, 'invalid_grant', { refreshCredentialExpiresAt: START + 20 * DAY });
    succeed(watch, ALPHA, START + 6 * DAY);
    watch.start();
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [[
      'claude-rotator: 1 account(s) need a new login: bra…. Run "claude-rotator status" on the Mac.',
      D7,
    ].join('\n')]);
    watch.stop();
  });

  it('a notice goes after the stage line', async () => {
    const { watch, clock, fake } = setup();
    succeed(watch, ALPHA, START + 6 * DAY);
    watch.start();
    assert.equal(watch.notice({ kind: 'client-version', key: 'k1', text: 'claude-rotator: test notice.' }), true);
    await until(clock, 2 * MINUTE);
    assert.deepEqual(texts(fake), [`${D7}\nclaude-rotator: test notice.`]);
    watch.stop();
  });
});

describe('expiry stages: the status section and time zones', () => {
  it('expiringSoon still counts the accounts within 24 hours that do not need a new login', () => {
    const { watch } = setup({ accounts: THREE_ACCOUNTS });
    succeed(watch, ALPHA, START + 20 * HOUR);
    succeed(watch, BRAVO, START + 30 * HOUR);
    watch.noteRefreshFailed(CHARLIE, 'invalid_grant', { refreshCredentialExpiresAt: START + 10 * HOUR });
    watch.start();
    assert.equal(watch.statusSection().active.expiringSoon, 1);
    watch.stop();
  });

  it('the stages do not depend on the time zone', async () => {
    const run = async () => {
      const sentAt = [];
      let clockOf = null;
      const context = setup({
        sender: {
          webhook: () => {
            sentAt.push(new Date(clockOf.now()).toISOString());
            return { result: 'ok', reason: null };
          },
        },
      });
      clockOf = context.clock;
      const { watch, clock, fake } = context;
      succeed(watch, ALPHA, START + 2 * DAY);
      watch.start();
      await until(clock, 2 * MINUTE);
      assert.deepEqual(texts(fake), [D3]);
      await until(clock, DAY + 2 * MINUTE);
      assert.deepEqual(texts(fake), [D3, D1]);
      watch.stop();
      return { texts: texts(fake), sentAt };
    };
    const saved = process.env.TZ;
    const results = [];
    try {
      for (const zone of ['America/Los_Angeles', 'Asia/Tokyo']) {
        process.env.TZ = zone;
        results.push(await run());
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    assert.deepEqual(results[0], results[1]);
  });
});

describe('W5 dispersion alert', () => {
  it('fires at 0.02 with 300 pairs, clears below 0.01, and ignores small windows', async () => {
    const { watch, clock, fake } = setup();
    let snapshot = { windowMs: HOUR, pairs: 299, changes: 299, rate: 1 };
    watch.setDispersionSource(() => snapshot);
    watch.start();
    clock.advance(2 * MINUTE);
    assert.equal(watch.statusSection().active.dispersion, false, 'under 300 pairs is not judged');

    snapshot = { windowMs: HOUR, pairs: 1000, changes: 19, rate: 0.019 };
    clock.advance(2 * MINUTE);
    assert.equal(watch.statusSection().active.dispersion, false);

    snapshot = { windowMs: HOUR, pairs: 300, changes: 6, rate: 0.02 };
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(watch.statusSection().active.dispersion, true);
    assert.deepEqual(texts(fake), [
      'claude-rotator: 2.0% of follow-up requests in the last 60 min went to a different account than the previous request of the same session (6/300).',
    ]);

    snapshot = { windowMs: HOUR, pairs: 1000, changes: 10, rate: 0.01 };
    clock.advance(2 * MINUTE);
    assert.equal(watch.statusSection().active.dispersion, true, '0.01 is not below 0.01');

    snapshot = { windowMs: HOUR, pairs: 200, changes: 0, rate: 0 };
    clock.advance(2 * MINUTE);
    assert.equal(watch.statusSection().active.dispersion, true, 'a small window does not clear it either');

    watch.setDispersionSource(() => {
      throw new Error('source failed');
    });
    clock.advance(2 * MINUTE);
    assert.equal(watch.statusSection().active.dispersion, true);

    snapshot = { windowMs: HOUR, pairs: 1000, changes: 9, rate: 0.009 };
    watch.setDispersionSource(() => snapshot);
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(watch.statusSection().active.dispersion, false);
    assert.deepEqual(texts(fake).slice(1), ['claude-rotator: routing is back to normal (0.9%).']);
    watch.stop();
  });
});

describe('W6 what leaves the machine', () => {
  it('keeps names, full ids, session keys and paths out of the webhook text, and puts the full id on the Mac', async () => {
    const id = 'zulu-example-account-0001';
    const { watch, clock, fake, manager, lines } = setup({
      accounts: [{ id, name: 'MARKER-NAME someone@example.invalid' }],
      sender: {
        webhook: () => ({ result: 'rejected-404', reason: 'https://example.invalid/MARKER-URL' }),
      },
    });
    manager.markError(id, 'oauth_refresh_failed', 'MARKER-MESSAGE', { cause: 'NATIVE_REFRESH_REAUTH_REQUIRED' });
    watch.setDispersionSource(() => ({ windowMs: HOUR, pairs: 400, changes: 40, rate: 0.1, sid: 'MARKER-SID' }));
    watch.start();
    clock.advance(31 * MINUTE);
    await settle();

    const slack = texts(fake).join('\n');
    assert.match(slack, /zul…/);
    for (const marker of ['MARKER', id, 'someone', 'example.invalid', 'hook-url']) {
      assert.ok(!slack.includes(marker), `webhook text carries ${marker}`);
    }
    const mac = fake.calls.notifyMac.map(call => `${call.title}\n${call.body}`).join('\n');
    assert.ok(mac.includes(`Run: claude-rotator login --id ${id}`));
    assert.ok(!mac.includes('MARKER'));
    assert.deepEqual(fake.calls.postWebhook.map(call => call.urlFile), [URL_FILE]);

    const logged = lines.join('\n');
    const status = JSON.stringify(watch.statusSection());
    for (const marker of ['MARKER', id, 'example.invalid', 'hook-url']) {
      assert.ok(!logged.includes(marker), `log carries ${marker}`);
      assert.ok(!status.includes(marker), `status carries ${marker}`);
    }
    assert.ok(lines.map(line => line.replace(/^\S+ /, '')).includes('alert-send channel=webhook result=rejected-404 reason=other'));
    for (const line of lines) assert.ok(LOG_LINE_FORMS.some(form => form.test(line)), line);
    watch.stop();
  });

  it('drops a sender error unread: a throw or a rejection never reaches the log or the caller', async () => {
    const { watch, clock, lines } = setup({
      sender: {
        mac: () => {
          throw new Error('MARKER-THROW https://example.invalid/MARKER-URL');
        },
        webhook: () => Promise.reject(new Error('MARKER-REJECT https://example.invalid/MARKER-URL')),
        check: () => Promise.reject(new Error('MARKER-CHECK')),
      },
    });
    watch.start();
    assert.doesNotThrow(() => watch.noteRefreshFailed('alpha-example', 'invalid_grant'));
    clock.advance(MINUTE);
    await settle();
    assert.ok(!lines.join('\n').includes('MARKER'));
    assert.deepEqual(lines.map(line => line.replace(/^\S+ /, '')).sort(), [
      'alert-config warning=read',
      'alert-send channel=mac result=sender-error',
      'alert-send channel=webhook result=sender-error',
    ]);
    watch.stop();
  });
});

describe('W7 no alerts section', () => {
  for (const [label, settings] of [
    ['missing', null],
    ['empty', {}],
    ['both off', { macNotification: false, webhookUrlFile: '' }],
  ]) {
    it(`does nothing when the section is ${label}`, async () => {
      const { watch, clock, fake, manager, row, lines } = setup({ settings, loadSettings: () => settings });
      assert.equal(watch.statusSection(), null);
      watch.start();
      assert.equal(clock.size(), 0, 'no timer');
      manager.markError('alpha-example', 'oauth_refresh_failed', null, { cause: 'NATIVE_REFRESH_REAUTH_REQUIRED' });
      watch.onAccountState(row('alpha-example'));
      watch.onAccountState(row('alpha-example'), { credentialChanged: true });
      watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED', { refreshCredentialExpiresAt: START + HOUR });
      watch.noteRefreshSucceeded('alpha-example', { refreshCredentialExpiresAt: START + HOUR });
      watch.setDispersionSource(() => ({ windowMs: HOUR, pairs: 1000, changes: 1000, rate: 1 }));
      assert.equal(clock.size(), 0, 'no timer from the hooks');
      watch.reload();
      clock.advance(48 * HOUR);
      await settle();
      assert.equal(clock.size(), 0);
      assert.equal(watch.statusSection(), null);
      assert.deepEqual(lines, []);
      assert.deepEqual(fake.calls, { notifyMac: [], postWebhook: [], checkWebhookFile: [], stop: 0 });
      watch.stop();
    });
  }

  it('starts and stops its timers when a reload turns the section on and off', async () => {
    let raw = null;
    const { watch, clock, fake } = setup({ settings: raw, loadSettings: () => raw });
    watch.start();
    assert.equal(clock.size(), 0);
    raw = { macNotification: true };
    watch.reload();
    assert.ok(clock.size() > 0);
    assert.equal(watch.statusSection().webhook, 'off');
    raw = {};
    watch.reload();
    assert.equal(clock.size(), 0);
    assert.equal(watch.statusSection(), null);
    await settle();
    assert.equal(fake.calls.checkWebhookFile.length, 0);
    watch.stop();
  });
});

describe('W8 queue limit', () => {
  it('keeps at most 20 messages waiting, counts the dropped ones, and never holds up the caller', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => `acct${String(index).padStart(2, '0')}-example`);
    const { watch, clock, fake } = setup({
      accounts: ids.map(id => ({ id, name: id })),
      // A webhook that never answers.
      sender: { webhook: () => new Promise(() => {}) },
    });
    watch.start();
    for (const id of ids) {
      const before = Date.now();
      watch.noteRefreshFailed(id, 'NATIVE_REFRESH_REAUTH_REQUIRED');
      assert.ok(Date.now() - before < 1000);
      clock.advance(MINUTE + 1000);
      await settle();
    }
    // The first message is in flight; 24 more were queued behind it.
    assert.equal(fake.calls.postWebhook.length, 1);
    const section = watch.statusSection();
    assert.equal(section.queued, ALERT_MAX_QUEUED_MESSAGES);
    assert.equal(section.dropped, 4);
    watch.stop();
    assert.equal(watch.statusSection().queued, 0);
    assert.equal(fake.calls.stop, 1);
  });
});

describe('generic notices', () => {
  const NOTICE = 'claude-rotator: first time seeing model example-model.';
  const notice = (key = 'one', text = NOTICE, kind = 'example-kind') => ({ kind, key, text });
  const lines = text => text.split('\n');

  it('refuses a notice while the alerts section is off, with no timer and no send', async () => {
    const { watch, clock, fake } = setup({ settings: null });
    watch.start();
    assert.equal(watch.notice(notice()), false);
    assert.equal(clock.size(), 0, 'no timer');
    clock.advance(2 * MINUTE);
    await settle();
    assert.deepEqual(fake.calls, { notifyMac: [], postWebhook: [], checkWebhookFile: [], stop: 0 });
    watch.stop();
  });

  it('accepts a notice and sends its text unchanged to the webhook and the Mac after 60 seconds', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    await settle();
    assert.equal(watch.notice(notice()), true);
    clock.advance(MINUTE - 1);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0, 'held for the batch window');
    clock.advance(1);
    await settle();
    assert.deepEqual(texts(fake), [NOTICE]);
    assert.deepEqual(fake.calls.notifyMac.map(call => call.body), [NOTICE]);
    watch.stop();
  });

  it('refuses the same kind and key a second time, and accepts another key or kind', () => {
    const { watch } = setup();
    watch.start();
    assert.equal(watch.notice(notice('one')), true);
    assert.equal(watch.notice(notice('one')), false);
    assert.equal(watch.notice(notice('one', 'claude-rotator: another text.')), false, 'the text is not part of the key');
    assert.equal(watch.notice(notice('two')), true);
    assert.equal(watch.notice(notice('one', NOTICE, 'other-kind')), true);
    watch.stop();
  });

  it('refuses a built-in kind, non-ASCII or multi-line text, text over 300 characters and a key with a space', () => {
    const { watch } = setup();
    watch.start();
    for (const kind of ['relogin', 'failing', 'expiry', 'dispersion']) {
      assert.equal(watch.notice(notice('one', NOTICE, kind)), false, kind);
    }
    assert.equal(watch.notice(notice('one', 'claude-rotator: café.')), false);
    assert.equal(watch.notice(notice('one', 'claude-rotator: first line.\nsecond line.')), false);
    assert.equal(watch.notice(notice('one', 'x'.repeat(301))), false);
    assert.equal(watch.notice(notice('with space')), false);
    for (const bad of [undefined, null, 'text', {}, { kind: 'example-kind', key: 'one' }, { kind: 'Example', key: 'one', text: NOTICE }]) {
      assert.equal(watch.notice(bad), false);
    }
    assert.doesNotThrow(() => watch.notice());
    assert.equal(watch.notice(notice('one', 'x'.repeat(300))), true, 'nothing above was remembered');
    watch.stop();
  });

  it('puts a notice after the relogin lines of the same batch, leaving those lines as they were', async () => {
    const run = async withNotice => {
      const { watch, clock, fake } = setup();
      watch.start();
      await settle();
      watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
      if (withNotice) assert.equal(watch.notice(notice()), true);
      clock.advance(MINUTE);
      await settle();
      const out = { slack: texts(fake), mac: fake.calls.notifyMac.map(call => call.body) };
      watch.stop();
      return out;
    };
    const plain = await run(false);
    const mixed = await run(true);
    assert.equal(mixed.slack.length, 1, 'one message');
    assert.equal(mixed.mac.length, 1, 'one message');
    assert.deepEqual(lines(mixed.slack[0]), [...lines(plain.slack[0]), NOTICE]);
    assert.deepEqual(lines(mixed.mac[0]), [...lines(plain.mac[0]), NOTICE]);
  });

  it('keeps the status section keys the same after a notice is sent', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    await settle();
    const shape = section => ({
      top: Object.keys(section),
      active: Object.keys(section.active),
      lastDelivery: Object.keys(section.lastDelivery),
    });
    const before = shape(watch.statusSection());
    assert.equal(watch.notice(notice()), true);
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);
    const after = watch.statusSection();
    assert.deepEqual(shape(after), before);
    assert.equal(after.lastDelivery.webhook.result, 'ok');
    assert.equal(after.queued, 0);
    assert.equal(after.dropped, 0);
    watch.stop();
  });

  it('sends nothing when stopped before the batch goes out, stops the sender once and refuses later notices', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    await settle();
    assert.equal(watch.notice(notice()), true);
    watch.stop();
    assert.equal(watch.notice(notice('two')), false);
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    assert.equal(fake.calls.notifyMac.length, 0);
    assert.equal(fake.calls.stop, 1);
  });

  it('delivers a relogin message and a notice one at a time through the same queue', async () => {
    const waiting = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { watch, clock, fake } = setup({
      sender: {
        webhook: () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise(resolve => waiting.push(() => {
            inFlight -= 1;
            resolve({ result: 'ok', reason: null });
          }));
        },
      },
    });
    watch.start();
    await settle();
    watch.noteRefreshFailed('alpha-example', 'NATIVE_REFRESH_REAUTH_REQUIRED');
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1);
    assert.equal(watch.notice(notice()), true);
    clock.advance(MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'the second message waits for the first');
    assert.equal(watch.statusSection().queued, 1);
    waiting.shift()();
    await settle();
    assert.equal(fake.calls.postWebhook.length, 2);
    assert.match(texts(fake)[0], /need a new login/);
    assert.equal(texts(fake)[1], NOTICE);
    waiting.shift()();
    await settle();
    assert.equal(maxInFlight, 1);
    assert.equal(watch.statusSection().queued, 0);
    watch.stop();
  });

  it('remembers at most a fixed number of keys, forgetting the oldest first', () => {
    const { watch } = setup();
    watch.start();
    assert.equal(ALERT_MAX_NOTICE_KEYS, 512);
    for (let i = 0; i < ALERT_MAX_NOTICE_KEYS; i += 1) {
      assert.equal(watch.notice(notice(`key-${i}`)), true);
    }
    assert.equal(watch.notice(notice('key-0')), false, 'still remembered at the limit');
    assert.equal(watch.notice(notice(`key-${ALERT_MAX_NOTICE_KEYS}`)), true);
    assert.equal(watch.notice(notice('key-0')), true, 'the oldest key was forgotten');
    assert.equal(watch.notice(notice('key-2')), false, 'newer keys are still remembered');
    watch.stop();
  });

  it('removes the characters Slack reads as markup (<, > and &) instead of escaping them', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    await settle();
    assert.equal(watch.notice(notice('one', 'claude-rotator: model <!channel> & <https://example.invalid/x|link>.')), true);
    assert.equal(watch.notice(notice('two', '<&>')), false, 'nothing is left to send');
    assert.equal(watch.notice({ kind: 'example-kind', key: 'a<b', text: NOTICE }), false);
    assert.equal(watch.notice({ kind: 'a&b', key: 'three', text: NOTICE }), false);
    clock.advance(MINUTE);
    await settle();
    const expected = 'claude-rotator: model !channel  https://example.invalid/x|link.';
    assert.deepEqual(texts(fake), [expected]);
    assert.deepEqual(fake.calls.notifyMac.map(call => call.body), [expected]);
    watch.stop();
  });
});
