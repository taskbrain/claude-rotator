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
//   - expiry     a known login expiry (the refresh credential's): once each at
//                7 days, 3 days and 1 day before it, and once when it has passed.
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
//   6 hours while it lasts ("Still unresolved"; for dispersion only in a sweep
//   that could judge it), and when it ends (only for alerts that were actually
//   sent, not when every message about one was dropped from a full queue).
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
// - **Each expiry stage is sent once.** Per account the watch keeps the nearest
//   stage sent and the expiry value it was sent for. A stage already passed
//   when an expiry is first seen is not sent; values within 60 minutes of each
//   other are the same expiry, and a value more than a day later is a new one
//   that is counted again from the start. No stage is sent while the account
//   needs a new login. A stage waits for its batch, and is checked again just
//   before the batch goes out: one that no longer applies is dropped, and is
//   sent later if the expiry reaches it again. The stages that went out are
//   remembered through `readExpiryState` / `writeExpiryState`
//   (alert-expiry.json), so a restart does not send them again; a missing,
//   unreadable or malformed file only means a stage may be sent once more.
//   Reading or writing it logs nothing.
// - **Nothing happens without the `alerts` section.** With neither channel
//   enabled there is no timer, no log line, no status section and no send, and
//   the remembered stages are neither read nor written.
import { isAbsolute } from 'node:path';
import { isCredentialRefreshCooldown, isLoginExpiryValue, requiresRelogin } from './account-manager.js';

/** How often the state is swept (the 30-minute stage, reminders, expiry, dispersion). */
export const ALERT_SWEEP_INTERVAL_MS = 60_000;
/** Everything that becomes due within this window goes out as one message. */
export const ALERT_BATCH_WINDOW_MS = 60_000;
/** A non-relogin failure has to last this long before it is reported. */
export const ALERT_FAILING_AFTER_MS = 30 * 60_000;
/** While an alert lasts, it is repeated once per this interval. */
export const ALERT_REMINDER_INTERVAL_MS = 6 * 60 * 60_000;
/** A known login expiry within this time counts as `expiringSoon` in the status section. */
export const ALERT_EXPIRY_WITHIN_MS = 24 * 60 * 60_000;
/** Two expiry values at most this far apart are the same expiry. */
export const ALERT_EXPIRY_SAME_WITHIN_MS = 60 * 60_000;
/** Reading the remembered stages gives up after this long, and starts with none. */
export const ALERT_EXPIRY_STATE_READ_TIMEOUT_MS = 10_000;
/** At most this many rows are taken from the remembered stages (the first ones, in key order). */
export const ALERT_MAX_EXPIRY_ENTRIES = 512;
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
const DAY_MS = 24 * 60 * 60_000;
// Expiry stages by rank: 0 none, 1 seven days, 2 three days, 3 one day, 4 expired.
// STAGE_NAMES are the words kept in alert-expiry.json, STAGE_WORDS the ones in a message.
const STAGE_NAMES = [null, '7d', '3d', '1d', 'expired'];
const STAGE_WORDS = [null, '7 days', '3 days', '1 day', null];
const EXPIRY_STATE_FORMAT = 1;
const MAX_EXPIRY_ID_LENGTH = 200;

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
 * @param {(() => Promise<object|null>)|null} options.readExpiryState Reads the
 *   remembered expiry stages (null when there are none). Called once, when the
 *   watch first runs with the `alerts` section on. Without it the watch starts
 *   with nothing remembered.
 * @param {((state: object) => Promise<void>)|null} options.writeExpiryState
 *   Writes them, after a message that carried a stage was handed to the sender.
 */
export function createAlertWatch({
  accountManager = null,
  sender = null,
  settings = null,
  loadSettings = null,
  logger = null,
  now = () => Date.now(),
  timers = defaultTimers(),
  readExpiryState = null,
  writeExpiryState = null,
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
  // Whether the last sweep could judge dispersion. A reminder is only sent then,
  // so it never repeats numbers from an earlier window.
  let dispersionJudged = false;
  const queue = [];
  let delivering = false;
  let dropped = 0;
  const lastDelivery = { mac: null, webhook: null };
  // The remembered stages: account id -> { expiresAt, stage }. Until the read has
  // finished (or given up), no stage is judged.
  const expiryMemory = new Map();
  let expiryReadStarted = typeof readExpiryState !== 'function';
  let expiryLoaded = expiryReadStarted;
  let expiryReadTimer = null;
  // Rows forgotten (new credential, account gone) while the read was still running.
  const expiryForgottenWhileReading = new Set();
  let expiryWriting = false;
  let expiryWriteAgain = false;

  applySettings(current);

  return {
    onAccountState(account, { credentialChanged = false } = {}) {
      guard(() => {
        if (!active() || typeof account?.id !== 'string') return;
        const st = stateFor(account.id);
        if (credentialChanged) {
          // A new login: the old expiry and the stages sent for it no longer
          // apply, and whatever was wrong with the old credential is over.
          st.expiresAt = null;
          st.expiryAnchor = null;
          st.expiryStage = 0;
          forgetExpiry(account.id);
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
        readExpiryMemory();
        ensureSweepTimer();
        sweep();
        checkWebhook();
      });
    },
    stop() {
      guard(() => {
        stopped = true;
        clearTimers();
        if (expiryReadTimer) timers.clearTimeout(expiryReadTimer);
        expiryReadTimer = null;
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
    readExpiryMemory();
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
        // The known login expiry, the expiry value the sent stage belongs to,
        // and the rank of the nearest stage sent for it.
        expiresAt: null,
        expiryAnchor: null,
        expiryStage: 0,
      };
      accounts.set(id, st);
    }
    return st;
  }

  // A value that is not a usable expiry (missing included) keeps the known one.
  function noteExpiry(st, value) {
    if (isLoginExpiryValue(value)) st.expiresAt = value;
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
    forgetExpiry(id);
  }

  // ---- alerts, batching and reminders ----

  function raiseAlert(owner, kind) {
    if (owner[kind]) return;
    // `delivered`: a message about it reached the sender. `lost`: every message
    // about it so far was dropped from a full queue before that.
    owner[kind] = { phase: 'pending', lastNotifiedAt: null, delivered: false, lost: false };
    pending.push({ type: 'new', kind, owner });
    scheduleFlush();
  }

  function clearAlert(owner, kind, { silent = false } = {}) {
    const alert = owner[kind];
    if (!alert) return;
    owner[kind] = null;
    pending = pending.filter(item => !(item.owner === owner && item.kind === kind && item.type !== 'recovery'));
    if (alert.phase !== 'sent' || alert.lost || silent) return;
    // The alert goes with it: its first message may still be waiting in the queue.
    pending.push({ type: 'recovery', kind, owner, alert });
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

  // Once the remembered stages are read: follow each known expiry, and queue the
  // stage it has reached when that is nearer than the one already sent. Not
  // while the account needs a new login. `before` is the rank before the raise,
  // put back if the stage is dropped before it goes out.
  function evaluateExpiry(t) {
    if (!expiryLoaded) return;
    for (const st of accounts.values()) {
      if (st.expiresAt == null) continue;
      followExpiry(st, t);
      if (st.relogin) continue;
      const stage = expiryStageOf(st.expiresAt - t);
      if (stage <= st.expiryStage) continue;
      pending.push({ type: 'stage', kind: 'expiry', owner: st, stage, before: st.expiryStage });
      st.expiryStage = stage;
      scheduleFlush();
    }
  }

  // Compares the known expiry with the one the sent stage belongs to (the
  // anchor). The first time, the anchor comes from the remembered stages, or is
  // the known expiry itself with nothing sent.
  function followExpiry(st, t) {
    const value = st.expiresAt;
    if (st.expiryAnchor == null) {
      const remembered = expiryMemory.get(st.id);
      if (!remembered) {
        st.expiryAnchor = value;
        st.expiryStage = 0;
        return;
      }
      st.expiryAnchor = remembered.expiresAt;
      st.expiryStage = remembered.stage;
    }
    const anchor = st.expiryAnchor;
    // Within 60 minutes: the same expiry, nothing moves.
    if (Math.abs(value - anchor) <= ALERT_EXPIRY_SAME_WITHIN_MS) return;
    st.expiryAnchor = value;
    // Earlier: the stage sent still holds. Later by up to a day: lowered to the
    // stage of the new value now, so a stage it falls back into is sent again.
    // Later by more than a day: a new expiry, counted from the start.
    if (value < anchor) return;
    st.expiryStage = value <= anchor + DAY_MS ? Math.min(st.expiryStage, expiryStageOf(value - t)) : 0;
  }

  function evaluateDispersion() {
    dispersionJudged = false;
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
    dispersionJudged = true;
    Object.assign(dispersionOwner, { rate, changes, pairs });
    if (!dispersionOwner.dispersion && rate >= ALERT_DISPERSION_RAISE_RATE) raiseAlert(dispersionOwner, 'dispersion');
    else if (dispersionOwner.dispersion && rate < ALERT_DISPERSION_CLEAR_RATE) clearAlert(dispersionOwner, 'dispersion');
  }

  function evaluateReminders(t) {
    const owners = [...accounts.values(), dispersionOwner];
    for (const owner of owners) {
      if (owner === dispersionOwner && !dispersionJudged) continue;
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
    const live = keepDueStages(
      items.filter(item => item.owner.id === null || accounts.get(item.owner.id) === item.owner),
      t,
    );
    if (live.length === 0 && noticeTexts.length === 0) return;
    for (const item of live) {
      const alert = item.type === 'new' ? item.owner[item.kind] : null;
      if (alert?.phase === 'pending') {
        alert.phase = 'sent';
        alert.lastNotifiedAt = t;
      }
    }
    // The alerts this message tells about, so a drop or a delivery can be noted on them.
    const alerts = live
      .filter(item => item.type === 'new' || item.type === 'reminder')
      .map(item => item.owner[item.kind])
      .filter(Boolean);
    enqueueMessage({ ...composeMessage(live, t, noticeTexts), alerts });
  }

  // A stage waited up to a minute for its batch; check it again against the
  // account as it is now. It stays only if the account is still in the ledger,
  // does not need a new login, and its known expiry has reached at least that
  // stage; of two left for one account, the nearer one stays. An account left
  // with none gets its rank put back to the lowest it had before the dropped
  // raises (never above the rank it has now), so the stage can be sent later.
  function keepDueStages(items, t) {
    const kept = new Map();
    const droppedBefore = new Map();
    for (const item of items) {
      if (item.type !== 'stage') continue;
      const st = item.owner;
      const due = findAccount(st.id) && !st.relogin && st.expiresAt != null
        && expiryStageOf(st.expiresAt - t) >= item.stage;
      if (!due) droppedBefore.set(st, Math.min(droppedBefore.get(st) ?? Infinity, item.before));
      else if (!kept.has(st) || kept.get(st).stage < item.stage) kept.set(st, item);
    }
    for (const [st, before] of droppedBefore) {
      if (!kept.has(st)) st.expiryStage = Math.min(st.expiryStage, before);
    }
    return items.filter(item => item.type !== 'stage' || kept.get(item.owner) === item);
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
    // One line per stage, nearest first. The anchor is kept with each account so
    // the stage can be remembered once the message has been handed over.
    const stages = [];
    for (const stage of [4, 3, 2, 1]) {
      const owners = items.filter(item => item.type === 'stage' && item.stage === stage).map(item => item.owner);
      if (owners.length === 0) continue;
      const list = owners.map(owner => owner.id);
      const what = stage === 4 ? 'login expired' : `login expires within ${STAGE_WORDS[stage]}`;
      slack.push(`claude-rotator: ${what} for ${list.length} account(s): ${shortLabels(list)}. Run "claude-rotator status" on the Mac.`);
      mac.push(`claude-rotator: ${what}: ${fullLabels(list)}.`);
      for (const id of list) mac.push(`Run: claude-rotator login --id ${id}`);
      for (const owner of owners) stages.push({ owner, anchor: owner.expiryAnchor, stage });
    }
    if (ids('new', 'dispersion').length > 0) addDispersion('');
    addRelogin(ids('reminder', 'relogin'), 'Still unresolved: ');
    addFailing(ids('reminder', 'failing'), 'Still unresolved: ');
    if (ids('reminder', 'dispersion').length > 0) addDispersion('Still unresolved: ');
    // The recovery lines are put together when the message goes out (messageText).
    const recoveries = kind => items.filter(item => item.type === 'recovery' && item.kind === kind);
    const recovered = [...recoveries('relogin'), ...recoveries('failing')]
      .map(item => ({ id: item.owner.id, alert: item.alert }));
    const routingAlerts = recoveries('dispersion').map(item => item.alert);
    const routing = routingAlerts.length > 0
      ? { alerts: routingAlerts, line: `claude-rotator: routing is back to normal (${percent(dispersionOwner.rate)}%).` }
      : null;
    return { slack, mac, recovered, routing, notices: noticeTexts, stages };
  }

  // The text of a queued message, as it goes out. By then every earlier message
  // about an alert has been delivered or dropped from a full queue, so a recovery
  // line is kept only for an alert a message reached the sender about. Null when
  // no line is left.
  function messageText(message) {
    const slack = [...message.slack];
    const mac = [...message.mac];
    const recovered = unique(message.recovered.filter(entry => entry.alert.delivered).map(entry => entry.id));
    if (recovered.length > 0) {
      slack.push(`claude-rotator: working again: ${shortLabels(recovered)}.`);
      mac.push(`claude-rotator: working again: ${fullLabels(recovered)}.`);
    }
    if (message.routing && message.routing.alerts.some(alert => alert.delivered)) {
      slack.push(message.routing.line);
      mac.push(message.routing.line);
    }
    for (const line of message.notices) {
      slack.push(line);
      mac.push(line);
    }
    if (slack.length === 0 && mac.length === 0) return null;
    return { slack: capText(slack.join('\n')), mac: capText(mac.join('\n')) };
  }

  // ---- delivery ----

  function enqueueMessage(message) {
    queue.push(message);
    while (queue.length > ALERT_MAX_QUEUED_MESSAGES) {
      const lost = queue.shift();
      dropped += 1;
      // An alert nobody was told about gets no recovery line either.
      for (const alert of lost.alerts) {
        if (!alert.delivered) alert.lost = true;
      }
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
    for (const alert of message.alerts) {
      alert.delivered = true;
      alert.lost = false;
    }
    // Only recovery lines whose alert nobody was told about: nothing to send.
    const text = messageText(message);
    if (!text) return;
    const tasks = [];
    if (current.macNotification) {
      tasks.push(callSender('notifyMac', { title: MAC_TITLE, body: text.mac })
        .then(out => guard(() => recordDelivery('mac', out))));
    }
    if (webhookTarget()) {
      tasks.push(callSender('postWebhook', { urlFile: current.webhookUrlFile, text: text.slack })
        .then(out => guard(() => recordDelivery('webhook', out))));
    }
    await Promise.all(tasks);
    // Whatever the result, a stage that has been handed over is not sent again.
    if (message.stages.length > 0) guard(() => rememberStages(message.stages));
  }

  // ---- the remembered stages (alert-expiry.json) ----

  // Kept per account: the expiry the stage was sent for (the anchor when the
  // message was put together) and the stage. Not for an account whose state
  // went away or whose credential changed meanwhile.
  function rememberStages(stages) {
    for (const { owner, anchor, stage } of stages) {
      if (anchor != null && accounts.get(owner.id) === owner && owner.expiryAnchor != null) {
        expiryMemory.set(owner.id, { expiresAt: anchor, stage });
      }
    }
    writeExpiryMemory();
  }

  function forgetExpiry(id) {
    expiryMemory.delete(id);
    if (!expiryLoaded) expiryForgottenWhileReading.add(id);
  }

  // Read once, when the watch first runs with the section on. Missing,
  // unreadable, malformed or not finished within 10 seconds all count as
  // nothing remembered; a result that comes later is not used.
  function readExpiryMemory() {
    if (expiryReadStarted) return;
    expiryReadStarted = true;
    let done = false;
    const finish = raw => {
      if (done) return;
      done = true;
      if (expiryReadTimer) timers.clearTimeout(expiryReadTimer);
      expiryReadTimer = null;
      try {
        for (const [id, row] of parseExpiryState(raw)) {
          if (!expiryForgottenWhileReading.has(id)) expiryMemory.set(id, row);
        }
      } finally {
        // Judging the stages starts even if the content could not be used.
        expiryForgottenWhileReading.clear();
        expiryLoaded = true;
      }
    };
    expiryReadTimer = timers.setTimeout(() => guard(() => finish(null)), ALERT_EXPIRY_STATE_READ_TIMEOUT_MS);
    expiryReadTimer?.unref?.();
    let reading;
    try {
      reading = Promise.resolve(readExpiryState());
    } catch {
      reading = Promise.resolve(null);
    }
    reading.then(raw => guard(() => finish(raw)), () => guard(() => finish(null)));
  }

  // One write at a time. A write asked for meanwhile is done once afterwards,
  // with the content as it is then. A failure is dropped (the next sent stage
  // writes again); nothing is written once stopped or while the section is off.
  function writeExpiryMemory() {
    if (typeof writeExpiryState !== 'function') return;
    if (expiryWriting) {
      expiryWriteAgain = true;
      return;
    }
    expiryWriting = true;
    (async () => {
      try {
        do {
          expiryWriteAgain = false;
          if (!active()) break;
          try {
            await writeExpiryState(expiryStateSnapshot());
          } catch {
            // Dropped on purpose, without a log line.
          }
        } while (expiryWriteAgain);
      } finally {
        expiryWriting = false;
      }
    })();
  }

  // Only the accounts in the ledger; only ids, expiry times and stage words.
  function expiryStateSnapshot() {
    const rows = [];
    for (const [id, row] of expiryMemory) {
      if (findAccount(id)) rows.push([id, { expiresAt: row.expiresAt, stage: STAGE_NAMES[row.stage] }]);
    }
    return { format: EXPIRY_STATE_FORMAT, accounts: Object.fromEntries(rows) };
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

// The rank of the stage for the time left (ms). Each stage includes its boundary:
// exactly 7 days left is the 7-day stage, exactly 0 is expired.
function expiryStageOf(left) {
  if (left <= 0) return 4;
  if (left <= DAY_MS) return 3;
  if (left <= 3 * DAY_MS) return 2;
  if (left <= 7 * DAY_MS) return 1;
  return 0;
}

// The remembered stages as read: `{"format":1,"accounts":{"<id>":{"expiresAt":<ms>,"stage":"7d"}}}`.
// Another format or shape counts as nothing remembered; a row that does not fit
// is dropped alone.
function parseExpiryState(raw) {
  const rows = new Map();
  if (!isPlainObject(raw) || raw.format !== EXPIRY_STATE_FORMAT || !isPlainObject(raw.accounts)) return rows;
  for (const [id, row] of Object.entries(raw.accounts).slice(0, ALERT_MAX_EXPIRY_ENTRIES)) {
    if (id.length > MAX_EXPIRY_ID_LENGTH || !isPlainObject(row) || !isLoginExpiryValue(row.expiresAt)) continue;
    const stage = STAGE_NAMES.indexOf(row.stage);
    if (stage > 0) rows.set(id, { expiresAt: row.expiresAt, stage });
  }
  return rows;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
