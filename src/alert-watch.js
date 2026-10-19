// Alert watch: decides when to tell a human that an account needs attention.
//
// It watches four things and hands short fixed-wording messages to a sender
// (Mac notification and a Slack-compatible incoming webhook):
//   - relogin    an account whose refresh credential can no longer be used
//                (the same causes as `requiresRelogin`). Raised on the first
//                refresh failure that says so, even while requests still go out
//                on the old access token.
//   - failing    any other refresh failure, error status or refresh cooldown that
//                has lasted 30 minutes without the account coming back.
//   - expiry     a known refresh-credential expiry within 24 hours.
//   - dispersion the share of follow-up requests of a session that went to a
//                different account than the previous request (last 60 minutes).
//
// Design lines:
// - **The caller is never held up.** The hooks (`onAccountState`,
//   `noteRefreshFailed`, `noteRefreshSucceeded`) only record state; sending runs
//   later, in the background, one message at a time. Nothing here throws to the
//   caller, and a sender that throws, rejects or hangs only affects delivery.
// - **State, not edges.** Whether an alert is active is decided from the current
//   state, so repeated `markError` calls and a restart are harmless. A repeat of
//   the same state sends nothing; a message is sent when an alert starts, every
//   6 hours while it lasts ("Still unresolved"), and when it ends (only for
//   alerts that were actually sent).
// - **`markAuthenticated` is not a recovery.** While a refresh keeps failing,
//   usage fetches on the old access token still succeed and clear the error
//   reason; treating that as "working again" would flap. Recovery is a
//   successful refresh, a changed credential, or the account leaving the ledger
//   (which is silent).
// - **What leaves the machine is minimal.** The webhook text carries only the
//   first three characters of an account id. Account names (often mail
//   addresses), full ids, session keys, paths and URLs never go there. The Mac
//   notification stays on this machine and carries the full id with the login
//   command. The webhook URL is never read here: only the sender reads the file,
//   and only short classifications come back.
// - **Nothing happens without the `alerts` section.** With neither channel
//   enabled there is no timer, no log line, no status section and no send.
import { isAbsolute } from 'node:path';
import { isCredentialRefreshCooldown, requiresRelogin } from './account-manager.js';

/** How often the state is swept (the 30-minute stage, reminders, expiry, dispersion). */
export const ALERT_SWEEP_INTERVAL_MS = 60_000;
/** Everything that becomes due within this window goes out as one message. */
export const ALERT_BATCH_WINDOW_MS = 60_000;
/** A non-relogin failure has to last this long before it is reported. */
export const ALERT_FAILING_AFTER_MS = 30 * 60_000;
/** While an alert lasts, it is repeated once per this interval. */
export const ALERT_REMINDER_INTERVAL_MS = 6 * 60 * 60_000;
/** A known refresh-credential expiry within this time is reported once. */
export const ALERT_EXPIRY_WITHIN_MS = 24 * 60 * 60_000;
/** Accounts expiring within this time are listed alongside an expiry alert. */
export const ALERT_EXPIRY_LIST_WITHIN_MS = 72 * 60 * 60_000;
/** Dispersion is raised at or above this rate... */
export const ALERT_DISPERSION_RAISE_RATE = 0.02;
/** ...and cleared below this one. */
export const ALERT_DISPERSION_CLEAR_RATE = 0.01;
/** Windows with fewer follow-up requests than this are not judged at all. */
export const ALERT_DISPERSION_MIN_PAIRS = 300;
/** Messages waiting for the sender. Overflow drops the oldest and is counted. */
export const ALERT_MAX_QUEUED_MESSAGES = 20;
/** `notice()` keys remembered for de-duplication. Past this, the oldest is forgotten. */
export const ALERT_MAX_NOTICE_KEYS = 512;

const MAX_TEXT_LENGTH = 3000;
const NOTICE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const NOTICE_KEY_PATTERN = /^[A-Za-z0-9._:@|+-]{1,160}$/;
const NOTICE_TEXT_PATTERN = /^[\x20-\x7e]{1,300}$/;
const BUILT_IN_KINDS = new Set(['relogin', 'failing', 'expiry', 'dispersion']);
// Slack reads <, > and & as markup (links, mentions, escapes). A notice text can
// carry values taken from requests, so these characters are removed rather than
// escaped: an escape such as &amp; would show up as is in the Mac notification.
const MARKUP_CHARACTERS = /[<>&]/g;
const MAC_TITLE = 'claude-rotator';
const WEBHOOK_FILE_PROBLEMS = new Set([
  'missing', 'not-absolute', 'type', 'mode', 'owner', 'size', 'format', 'scheme', 'read',
]);
const RESULT_PATTERN = /^[a-z0-9-]{1,40}$/;
const REASON_PATTERN = /^[a-z_]{1,40}$/;
const CAUSE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
// Marks "nothing acknowledged yet", so a null error reason can be acknowledged too.
const NOTHING_ACKNOWLEDGED = Symbol('nothing-acknowledged');

/**
 * Reads the `alerts` section of config.json.
 *
 * Only two keys exist: `macNotification` (must be exactly `true`) and
 * `webhookUrlFile` (a non-empty string; whether it is absolute is judged by the
 * watch, which reports a relative path as `not-absolute` instead of dropping
 * it). Anything else - a missing section, a non-object, other keys - means off.
 * Applying it to its own output returns the same settings.
 *
 * @returns {{enabled: boolean, macNotification: boolean, webhookUrlFile: string|null}}
 */
export function normalizeAlertSettings(raw) {
  const section = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const macNotification = section.macNotification === true;
  const webhookUrlFile = typeof section.webhookUrlFile === 'string' && section.webhookUrlFile.trim() !== ''
    ? section.webhookUrlFile
    : null;
  return {
    enabled: macNotification || webhookUrlFile !== null,
    macNotification,
    webhookUrlFile,
  };
}

/**
 * @param {object} options
 * @param {{accounts?: object[]}|null} options.accountManager Read only: the
 *   ledger rows (`id`, `status`, `errorReason`, `temporaryUnavailableReason`).
 * @param {object|null} options.sender `notifyMac`, `postWebhook`,
 *   `checkWebhookFile` and `stop`, as created by `createAlertSender`.
 * @param {object|null} options.settings The `alerts` section, raw or normalized.
 * @param {(() => object|Promise<object>)|null} options.loadSettings Returns the
 *   current `alerts` section (raw or normalized) for `reload()`.
 * @param {((line: string) => void)|null} options.logger
 * @param {() => number} options.now
 * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} options.timers
 */
export function createAlertWatch({
  accountManager = null,
  sender = null,
  settings = null,
  loadSettings = null,
  logger = null,
  now = () => Date.now(),
  timers = defaultTimers(),
} = {}) {
  let current = normalizeAlertSettings(settings);
  let webhookState = 'off';
  let webhookProblem = null;
  let webhookPath = null;
  let lastWarning = null;
  let checkGeneration = 0;
  let dispersionSource = null;
  let started = false;
  let stopped = false;
  let sweepTimer = null;
  let flushTimer = null;
  let pending = [];
  let notices = [];
  const noticeKeys = new Set();
  const accounts = new Map();
  const dispersionOwner = { id: null, dispersion: null, rate: null, changes: 0, pairs: 0 };
  const queue = [];
  let delivering = false;
  let dropped = 0;
  const lastDelivery = { mac: null, webhook: null };

  applySettings(current);

  return {
    onAccountState(account, { credentialChanged = false } = {}) {
      guard(() => {
        if (!active() || typeof account?.id !== 'string') return;
        const st = stateFor(account.id);
        if (credentialChanged) {
          // A new login: the old expiry no longer applies, and whatever was
          // wrong with the old credential is over.
          st.expiresAt = null;
          recoverAccount(st, account);
        }
        evaluateAccount(st, account, now());
      });
    },
    noteRefreshFailed(accountId, errorType, { refreshCredentialExpiresAt = null } = {}) {
      guard(() => {
        if (!active() || !findAccount(accountId)) return;
        const st = stateFor(accountId);
        noteExpiry(st, refreshCredentialExpiresAt);
        st.cause = cleanCause(errorType);
        if (st.refreshFailSince == null) st.refreshFailSince = now();
        if (requiresRelogin({ errorReason: { type: 'oauth_refresh_failed', cause: errorType } })) {
          raiseRelogin(st);
        }
      });
    },
    noteRefreshSucceeded(accountId, { refreshCredentialExpiresAt = null } = {}) {
      guard(() => {
        if (!active()) return;
        const account = findAccount(accountId);
        if (!account) return;
        const st = stateFor(accountId);
        noteExpiry(st, refreshCredentialExpiresAt);
        recoverAccount(st, account);
      });
    },
    setDispersionSource(fn) {
      dispersionSource = typeof fn === 'function' ? fn : null;
    },
    /**
     * Queues one short message from another watch. It goes out with the next
     * batch, after the lines of the four alerts above, through the same sender.
     * Returns false (never throws) when the watch is off or stopped, when a
     * field does not fit its form, or when the same kind and key came before.
     *
     * @param {{kind: string, key: string, text: string}} input
     * @returns {boolean}
     */
    notice(input) {
      return guard(() => acceptNotice(input)) === true;
    },
    statusSection() {
      try {
        return buildStatusSection();
      } catch {
        return null;
      }
    },
    reload() {
      try {
        if (stopped) return undefined;
        if (typeof loadSettings !== 'function') {
          if (current.enabled && started) checkWebhook();
          return undefined;
        }
        const raw = loadSettings();
        if (raw && typeof raw.then === 'function') {
          return Promise.resolve(raw).then(next => guard(() => applyReloaded(next)), () => {});
        }
        applyReloaded(raw);
      } catch {}
      return undefined;
    },
    start() {
      guard(() => {
        if (started || stopped) return;
        started = true;
        if (!current.enabled) return;
        ensureSweepTimer();
        sweep();
        checkWebhook();
      });
    },
    stop() {
      guard(() => {
        stopped = true;
        clearTimers();
        pending = [];
        notices = [];
        queue.length = 0;
        sender?.stop?.();
      });
    },
  };

  function active() {
    return current.enabled && !stopped;
  }

  function guard(fn) {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  function log(line) {
    try {
      logger?.(`${new Date(now()).toISOString()} ${line}`);
    } catch {}
  }

  // ---- settings and the webhook file state ----

  function applySettings(next) {
    current = next;
    checkGeneration += 1;
    if (!current.enabled) {
      clearTimers();
      pending = [];
      notices = [];
      noticeKeys.clear();
      queue.length = 0;
      accounts.clear();
      dispersionOwner.dispersion = null;
      webhookState = 'off';
      webhookProblem = null;
      webhookPath = null;
      lastWarning = null;
      return;
    }
    if (current.webhookUrlFile === null) {
      webhookState = 'off';
      webhookProblem = null;
      webhookPath = null;
      lastWarning = null;
      return;
    }
    if (!isAbsolute(current.webhookUrlFile)) {
      webhookPath = current.webhookUrlFile;
      setWebhook('unusable', 'not-absolute');
      return;
    }
    if (webhookPath !== current.webhookUrlFile) {
      // Not checked yet: unusable with no problem class until the sender answers.
      webhookPath = current.webhookUrlFile;
      webhookState = 'unusable';
      webhookProblem = null;
    }
  }

  function applyReloaded(raw) {
    if (stopped) return;
    const wasEnabled = current.enabled;
    applySettings(normalizeAlertSettings(raw));
    if (!current.enabled || !started) return;
    ensureSweepTimer();
    if (!wasEnabled) sweep();
    checkWebhook();
  }

  function webhookTarget() {
    return current.enabled && current.webhookUrlFile !== null && isAbsolute(current.webhookUrlFile);
  }

  function checkWebhook() {
    if (!webhookTarget()) return;
    const generation = checkGeneration;
    callSender('checkWebhookFile', current.webhookUrlFile).then(out => guard(() => {
      if (generation !== checkGeneration || stopped) return;
      if (out?.usable === true) setWebhook('usable', null);
      else setWebhook('unusable', WEBHOOK_FILE_PROBLEMS.has(out?.problem) ? out.problem : 'read');
    }));
  }

  // Only a change into a problem is logged, so a reload that finds the same
  // problem again stays quiet.
  function setWebhook(state, problem) {
    webhookState = state;
    webhookProblem = problem;
    if (problem === lastWarning) return;
    lastWarning = problem;
    if (problem) log(`alert-config warning=${problem}`);
  }

  // ---- per-account state ----

  function ledger() {
    const list = accountManager?.accounts;
    return Array.isArray(list) ? list : [];
  }

  function findAccount(accountId) {
    if (typeof accountId !== 'string' || accountId === '') return null;
    return ledger().find(account => account?.id === accountId) || null;
  }

  function stateFor(id) {
    let st = accounts.get(id);
    if (!st) {
      st = {
        id,
        refreshFailSince: null,
        stateFailSince: null,
        cause: null,
        ackError: NOTHING_ACKNOWLEDGED,
        ackCooldown: NOTHING_ACKNOWLEDGED,
        relogin: null,
        failing: null,
        expiresAt: null,
        expiryNotifiedFor: null,
      };
      accounts.set(id, st);
    }
    return st;
  }

  function noteExpiry(st, value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) st.expiresAt = value;
  }

  // The error reason and cooldown seen at a recovery are acknowledged: they
  // are left over from before the recovery and must not raise the alert again.
  // `markError` always stores a new reason object, so a later failure counts.
  function recoverAccount(st, account) {
    st.refreshFailSince = null;
    st.stateFailSince = null;
    st.ackError = account?.errorReason ?? null;
    st.ackCooldown = account?.temporaryUnavailableReason ?? null;
    clearAlert(st, 'relogin');
    clearAlert(st, 'failing');
  }

  function stateFailing(account, st) {
    if (account.status === 'error' && account.errorReason !== st.ackError) {
      return account.errorReason?.cause || account.errorReason?.type || 'error';
    }
    const cooldown = account.temporaryUnavailableReason;
    if (isCredentialRefreshCooldown(cooldown) && cooldown !== st.ackCooldown) return cooldown.type;
    return null;
  }

  function evaluateAccount(st, account, t) {
    const cause = stateFailing(account, st);
    if (cause) {
      if (st.stateFailSince == null) st.stateFailSince = t;
      st.cause = cleanCause(cause);
    } else {
      st.stateFailSince = null;
    }
    if (requiresRelogin(account) && account.errorReason !== st.ackError) raiseRelogin(st);
    const since = earliest(st.refreshFailSince, st.stateFailSince);
    if (since == null) clearAlert(st, 'failing');
    else if (!st.relogin && t - since >= ALERT_FAILING_AFTER_MS) raiseAlert(st, 'failing');
  }

  function raiseRelogin(st) {
    raiseAlert(st, 'relogin');
    // The relogin message says everything the failing one would.
    clearAlert(st, 'failing', { silent: true });
  }

  function forgetAccount(id) {
    pending = pending.filter(item => item.owner.id !== id);
    accounts.delete(id);
  }

  // ---- alerts, batching and reminders ----

  function raiseAlert(owner, kind) {
    if (owner[kind]) return;
    owner[kind] = { phase: 'pending', lastNotifiedAt: null };
    pending.push({ type: 'new', kind, owner });
    scheduleFlush();
  }

  function clearAlert(owner, kind, { silent = false } = {}) {
    const alert = owner[kind];
    if (!alert) return;
    owner[kind] = null;
    pending = pending.filter(item => !(item.owner === owner && item.kind === kind && item.type !== 'recovery'));
    if (alert.phase !== 'sent' || silent) return;
    pending.push({ type: 'recovery', kind, owner });
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || !active()) return;
    flushTimer = timers.setTimeout(() => {
      flushTimer = null;
      guard(flush);
    }, ALERT_BATCH_WINDOW_MS);
    flushTimer?.unref?.();
  }

  function ensureSweepTimer() {
    if (sweepTimer || !active()) return;
    sweepTimer = timers.setInterval(() => guard(sweep), ALERT_SWEEP_INTERVAL_MS);
    sweepTimer?.unref?.();
  }

  function clearTimers() {
    if (sweepTimer) timers.clearInterval(sweepTimer);
    if (flushTimer) timers.clearTimeout(flushTimer);
    sweepTimer = null;
    flushTimer = null;
  }

  function sweep() {
    if (!active()) return;
    const t = now();
    const present = new Set();
    for (const account of ledger()) {
      if (typeof account?.id !== 'string') continue;
      present.add(account.id);
      evaluateAccount(stateFor(account.id), account, t);
    }
    for (const id of [...accounts.keys()]) {
      if (!present.has(id)) forgetAccount(id);
    }
    evaluateExpiry(t);
    evaluateDispersion();
    evaluateReminders(t);
  }

  function evaluateExpiry(t) {
    for (const st of accounts.values()) {
      if (st.relogin || st.expiresAt == null || st.expiryNotifiedFor === st.expiresAt) continue;
      const left = st.expiresAt - t;
      if (left <= 0 || left > ALERT_EXPIRY_WITHIN_MS) continue;
      st.expiryNotifiedFor = st.expiresAt;
      pending.push({ type: 'new', kind: 'expiry', owner: st });
      scheduleFlush();
    }
  }

  function evaluateDispersion() {
    if (!dispersionSource) return;
    let snapshot;
    try {
      snapshot = dispersionSource();
    } catch {
      return;
    }
    const pairs = Number(snapshot?.pairs);
    const changes = Number(snapshot?.changes);
    const rate = Number(snapshot?.rate);
    if (!Number.isFinite(pairs) || !Number.isFinite(changes) || !Number.isFinite(rate)) return;
    if (pairs < ALERT_DISPERSION_MIN_PAIRS) return;
    Object.assign(dispersionOwner, { rate, changes, pairs });
    if (!dispersionOwner.dispersion && rate >= ALERT_DISPERSION_RAISE_RATE) raiseAlert(dispersionOwner, 'dispersion');
    else if (dispersionOwner.dispersion && rate < ALERT_DISPERSION_CLEAR_RATE) clearAlert(dispersionOwner, 'dispersion');
  }

  function evaluateReminders(t) {
    const owners = [...accounts.values(), dispersionOwner];
    for (const owner of owners) {
      for (const kind of ['relogin', 'failing', 'dispersion']) {
        const alert = owner[kind];
        if (alert?.phase !== 'sent' || t - alert.lastNotifiedAt < ALERT_REMINDER_INTERVAL_MS) continue;
        alert.lastNotifiedAt = t;
        pending.push({ type: 'reminder', kind, owner });
        scheduleFlush();
      }
    }
  }

  function acceptNotice(input) {
    if (!active()) return false;
    const { kind, key, text } = input && typeof input === 'object' ? input : {};
    if (typeof kind !== 'string' || !NOTICE_KIND_PATTERN.test(kind) || BUILT_IN_KINDS.has(kind)) return false;
    if (typeof key !== 'string' || !NOTICE_KEY_PATTERN.test(key)) return false;
    if (typeof text !== 'string') return false;
    const clean = text.replace(MARKUP_CHARACTERS, '');
    if (!NOTICE_TEXT_PATTERN.test(clean)) return false;
    const dedupKey = `${kind}:${key}`;
    if (noticeKeys.has(dedupKey)) return false;
    noticeKeys.add(dedupKey);
    // A Set keeps insertion order, so the first value is the oldest key.
    while (noticeKeys.size > ALERT_MAX_NOTICE_KEYS) noticeKeys.delete(noticeKeys.values().next().value);
    notices.push(clean);
    scheduleFlush();
    return true;
  }

  function flush() {
    const items = pending;
    pending = [];
    const noticeTexts = notices;
    notices = [];
    if (!active()) return;
    const t = now();
    const live = items.filter(item => item.owner.id === null || accounts.get(item.owner.id) === item.owner);
    if (live.length === 0 && noticeTexts.length === 0) return;
    for (const item of live) {
      const alert = item.type === 'new' ? item.owner[item.kind] : null;
      if (alert?.phase === 'pending') {
        alert.phase = 'sent';
        alert.lastNotifiedAt = t;
      }
    }
    enqueueMessage(composeMessage(live, t, noticeTexts));
  }

  // ---- message text ----

  function composeMessage(items, t, noticeTexts = []) {
    const slack = [];
    const mac = [];
    const ids = (type, kind) => unique(items
      .filter(item => item.type === type && item.kind === kind)
      .map(item => item.owner.id));
    const addRelogin = (list, prefix) => {
      if (list.length === 0) return;
      slack.push(`${prefix}claude-rotator: ${list.length} account(s) need a new login: ${shortLabels(list)}. Run "claude-rotator status" on the Mac.`);
      for (const id of list) mac.push(`${prefix}Run: claude-rotator login --id ${id}`);
    };
    const addFailing = (list, prefix) => {
      for (const id of list) {
        const st = accounts.get(id);
        const since = earliest(st?.refreshFailSince, st?.stateFailSince) ?? t;
        const minutes = Math.max(0, Math.floor((t - since) / 60_000));
        const cause = st?.cause || 'other';
        slack.push(`${prefix}claude-rotator: credential refresh has been failing for ${minutes} min: ${shortLabel(id)} (${cause}).`);
        mac.push(`${prefix}claude-rotator: credential refresh has been failing for ${minutes} min: ${id} (${cause}).`);
      }
    };
    const addDispersion = prefix => {
      const line = `${prefix}claude-rotator: ${percent(dispersionOwner.rate)}% of follow-up requests in the last 60 min went to a different account than the previous request of the same session (${dispersionOwner.changes}/${dispersionOwner.pairs}).`;
      slack.push(line);
      mac.push(line);
    };

    addRelogin(ids('new', 'relogin'), '');
    addFailing(ids('new', 'failing'), '');
    const expiring = ids('new', 'expiry');
    if (expiring.length > 0) {
      const hours = Math.max(1, Math.ceil(Math.max(...expiring.map(id => (accounts.get(id)?.expiresAt ?? t) - t)) / 3_600_000));
      const later = [...accounts.values()]
        .filter(st => !expiring.includes(st.id) && !st.relogin && st.expiresAt != null
          && st.expiresAt > t && st.expiresAt - t <= ALERT_EXPIRY_LIST_WITHIN_MS)
        .map(st => st.id);
      const head = list => `claude-rotator: login for ${list(expiring)} expires within ${hours} h.`;
      const tail = list => (later.length > 0 ? ` Also within 3 days: ${list(later)}.` : '');
      slack.push(head(shortLabels) + tail(shortLabels));
      mac.push(head(fullLabels) + tail(fullLabels));
    }
    if (ids('new', 'dispersion').length > 0) addDispersion('');
    addRelogin(ids('reminder', 'relogin'), 'Still unresolved: ');
    addFailing(ids('reminder', 'failing'), 'Still unresolved: ');
    if (ids('reminder', 'dispersion').length > 0) addDispersion('Still unresolved: ');
    const recovered = unique([...ids('recovery', 'relogin'), ...ids('recovery', 'failing')]);
    if (recovered.length > 0) {
      slack.push(`claude-rotator: working again: ${shortLabels(recovered)}.`);
      mac.push(`claude-rotator: working again: ${fullLabels(recovered)}.`);
    }
    if (ids('recovery', 'dispersion').length > 0) {
      const line = `claude-rotator: routing is back to normal (${percent(dispersionOwner.rate)}%).`;
      slack.push(line);
      mac.push(line);
    }
    for (const line of noticeTexts) {
      slack.push(line);
      mac.push(line);
    }
    return { slack: capText(slack.join('\n')), mac: capText(mac.join('\n')) };
  }

  // ---- delivery ----

  function enqueueMessage(message) {
    queue.push(message);
    while (queue.length > ALERT_MAX_QUEUED_MESSAGES) {
      queue.shift();
      dropped += 1;
    }
    if (delivering) return;
    delivering = true;
    Promise.resolve().then(drain).catch(() => {
      delivering = false;
    });
  }

  async function drain() {
    try {
      while (queue.length > 0 && active()) {
        await deliver(queue.shift());
      }
    } finally {
      delivering = false;
    }
  }

  async function deliver(message) {
    const tasks = [];
    if (current.macNotification) {
      tasks.push(callSender('notifyMac', { title: MAC_TITLE, body: message.mac })
        .then(out => guard(() => recordDelivery('mac', out))));
    }
    if (webhookTarget()) {
      tasks.push(callSender('postWebhook', { urlFile: current.webhookUrlFile, text: message.slack })
        .then(out => guard(() => recordDelivery('webhook', out))));
    }
    await Promise.all(tasks);
  }

  // The sender is specified never to throw or reject. If one does anyway, the
  // error object is dropped here, unread, so nothing it carries can reach a log.
  function callSender(name, argument) {
    try {
      const fn = sender?.[name];
      if (typeof fn !== 'function') return Promise.resolve({ result: 'sender-error' });
      return Promise.resolve(fn.call(sender, argument)).then(out => out, () => ({ result: 'sender-error' }));
    } catch {
      return Promise.resolve({ result: 'sender-error' });
    }
  }

  function recordDelivery(channel, out) {
    const at = new Date(now()).toISOString();
    const result = token(out?.result, RESULT_PATTERN);
    if (channel === 'mac') {
      lastDelivery.mac = { at, result };
      log(`alert-send channel=mac result=${result}`);
      return;
    }
    const rejected = result.startsWith('rejected-');
    const reason = rejected ? token(out?.reason, REASON_PATTERN) : null;
    lastDelivery.webhook = { at, result, reason };
    log(`alert-send channel=webhook result=${result}${rejected ? ` reason=${reason}` : ''}`);
    if (result === 'ok') setWebhook('usable', null);
    else if (result.startsWith('unusable-') && WEBHOOK_FILE_PROBLEMS.has(result.slice('unusable-'.length))) {
      setWebhook('unusable', result.slice('unusable-'.length));
    }
  }

  // ---- status ----

  function buildStatusSection() {
    if (!current.enabled) return null;
    const t = now();
    let needsLogin = 0;
    let failing = 0;
    let expiringSoon = 0;
    for (const st of accounts.values()) {
      if (st.relogin) needsLogin += 1;
      if (st.failing) failing += 1;
      if (!st.relogin && st.expiresAt != null && st.expiresAt > t && st.expiresAt - t <= ALERT_EXPIRY_WITHIN_MS) {
        expiringSoon += 1;
      }
    }
    return {
      macNotification: current.macNotification,
      webhook: webhookState,
      webhookProblem,
      active: { needsLogin, failing, expiringSoon, dispersion: Boolean(dispersionOwner.dispersion) },
      lastDelivery: {
        mac: lastDelivery.mac ? { ...lastDelivery.mac } : null,
        webhook: lastDelivery.webhook ? { ...lastDelivery.webhook } : null,
      },
      queued: queue.length,
      dropped,
    };
  }
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: handle => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle),
  };
}

function earliest(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

function unique(values) {
  return [...new Set(values)];
}

function cleanCause(value) {
  return token(value, CAUSE_PATTERN);
}

// Only short fixed-alphabet words reach a log line, the status or a message.
function token(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : 'other';
}

// The webhook text shows only the first three characters of an id.
function shortLabel(id) {
  return `${String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 3) || '?'}…`;
}

function shortLabels(ids) {
  return ids.map(shortLabel).join(', ');
}

function fullLabels(ids) {
  return ids.join(', ');
}

function percent(rate) {
  return (Number(rate) * 100).toFixed(1);
}

function capText(text) {
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}
