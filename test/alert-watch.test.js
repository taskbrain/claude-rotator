import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AccountManager } from '../src/account-manager.js';
import {
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

function setup({
  settings = ENABLED,
  accounts = [{ id: 'alpha-example', name: 'alpha MARKER-NAME' }],
  sender = {},
  loadSettings = null,
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
    now: clock.now,
    timers: clock.timers,
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

describe('W4 expiry alert', () => {
  it('fires once 24 hours ahead with the 3-day list, and again for a new expiry', async () => {
    const { watch, clock, fake } = setup({
      accounts: [{ id: 'alpha-example', name: 'alpha' }, { id: 'bravo-example', name: 'bravo' }],
    });
    watch.start();
    watch.noteRefreshSucceeded('alpha-example', { refreshCredentialExpiresAt: START + 30 * HOUR });
    watch.noteRefreshSucceeded('bravo-example', { refreshCredentialExpiresAt: START + 60 * HOUR });
    clock.advance(6 * HOUR - MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    assert.equal(watch.statusSection().active.expiringSoon, 0);

    clock.advance(MINUTE);
    assert.equal(watch.statusSection().active.expiringSoon, 1);
    clock.advance(MINUTE);
    await settle();
    assert.deepEqual(texts(fake), [
      'claude-rotator: login for alp… expires within 24 h. Also within 3 days: bra….',
    ]);
    assert.equal(fake.calls.notifyMac[0].body,
      'claude-rotator: login for alpha-example expires within 24 h. Also within 3 days: bravo-example.');

    clock.advance(12 * HOUR);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 1, 'once per expiry value');

    watch.noteRefreshSucceeded('alpha-example', { refreshCredentialExpiresAt: clock.now() + 20 * HOUR });
    clock.advance(2 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 2);
    assert.match(texts(fake)[1], /^claude-rotator: login for alp… expires within 20 h\./);
    watch.stop();
  });

  it('does not fire for an expiry that has already passed', async () => {
    const { watch, clock, fake } = setup();
    watch.start();
    watch.noteRefreshFailed('alpha-example', 'http-500', { refreshCredentialExpiresAt: START - MINUTE });
    clock.advance(5 * MINUTE);
    await settle();
    assert.equal(fake.calls.postWebhook.length, 0);
    watch.stop();
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
