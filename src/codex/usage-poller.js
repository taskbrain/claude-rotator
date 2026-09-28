// 使用量の定期取得（常駐の中核）。上流へは使用量の GET だけを送り、生成は送らない。
//
// 使用量の取得処理
// （createUsagePoller と補助関数）の決まりは次のとおり。
//   - 観測方式は http に固定する（設定に方式を選ぶキーが無い）。configure() で必ず取得を始め、
//     受動の方式・その報告・全口座が読めないときにプール全体を受動の方式へ切り替える知らせを
//     持たない（読めない口座があっても、プールの設定は切り替えない）。
//   - 縮退（検証の失敗、または5回続けての失敗）は、その口座の使用量が読めないという記録
//     （accountHealth の observationDegraded）とログのためだけに使う。プールへは伝えないので、
//     口座の選択の規則は変わらない（使用量が不明な口座は選ばれないまま。停止中の口座への
//     試し打ちも無い）。
//   - 口座の認証状態は auth-tracker.js の規則で動かす。送信の経路が無いので、使用量の GET の
//     401・403 と、資格情報の期限切れ・読めなさが唯一の根拠になる。それ以外の使用量の GET の
//     失敗（タイムアウト・5xx・429 など）では認証状態を変えない。ログイン切れの間は GET を送らない。
//   - User-Agent と originator の値は、依存として受け取る resolveClientIdentity() の戻り値を使う。
//     値が作れなければ GET を送らない（既定値を補わない）。
//   - ログは codex-rotator のロガー（logger.js）の許可リストに載るフィールドだけを出す。
//   - 資格情報ファイルの更新時刻は既定で自分で見る（credentialEpoch を渡せば差し替えられる）。
//   - 完全な観測かどうかは使用量の正規化（usage.js）の判定だけで決める。primary 窓があることは
//     条件に足さない（足すと、primary 窓の無い応答を完全な観測として扱えない）。
//   - プールが上流から消えた窓の停止だけを外したとき（出来事 window-cap-dropped）を info に出す。
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { WINDOW_CAP_DROPPED } from './account-pool.js';
import { CREDENTIALS_OUTCOME, createAuthTracker } from './auth-tracker.js';
import { readCodexSendSnapshot } from './credentials.js';
import { readCodexUsage } from './usage.js';

// 設定キーにしない固定の規則: 同時の読取は2口座まで／同じ口座の読取は1本だけ／同じ口座の次の
// 読取は前回の開始から30秒以内に始めない／失敗したら 60→120→300 秒の間隔を空ける／5回続けて
// 失敗（または起動時の検証の失敗）したら、その口座を縮退と記録する。
const USAGE_MAX_CONCURRENT_READS = 2;
const USAGE_MIN_READ_INTERVAL_MS = 30000;
const USAGE_BACKOFF_MS = [60000, 120000, 300000];
const USAGE_DEGRADE_AFTER_FAILURES = 5;
const USAGE_WINDOWS = ['primary', 'secondary'];
// 同じ失敗を info へ続けて出さない間隔。debug の codex_usage_read は読取ごとに出す。
const USAGE_INFO_REPEAT_MS = 60000;
const DEFAULT_POLL_INTERVAL_MS = 60000;
const DEFAULT_READ_TIMEOUT_MS = 5000;
// User-Agent を作れなかった理由の語。これ以外の値や例外は codex-version-unreadable に寄せる。
const CLIENT_IDENTITY_REASONS = new Set(['codex-cli-missing', 'codex-version-unreadable']);
const CLIENT_IDENTITY_UNREADABLE = 'codex-version-unreadable';
// 資格情報の読取の外で起きた予期しない例外（プログラムの誤り）の理由の語。資格情報が読めないとは
// 数えず、認証状態も動かさない。例外のメッセージは出さない（中身に秘密やパスが入りうるため）。
const INTERNAL_ERROR = 'internal-error';

// 読取器は窓のオブジェクトを返し、プールは平らな `<窓>_*` のキーを受け取る。
function toPoolObservation(observation) {
  const payload = {};
  for (const name of USAGE_WINDOWS) {
    const window = observation[name];
    if (!window) continue;
    if (Number.isFinite(window.usedPercent)) payload[`${name}_used_percent`] = window.usedPercent;
    if (Number.isFinite(window.windowResetAt)) payload[`${name}_reset_at`] = window.windowResetAt;
    if (Number.isFinite(window.limitWindowSeconds)) payload[`${name}_window_minutes`] = window.limitWindowSeconds / 60;
  }
  return payload;
}

// 読取ごとの debug 行に載せる観測の要約（ロガーの許可リストにある平らなフィールドだけ）。
function readingFields(observation) {
  const percents = USAGE_WINDOWS.map(name => observation[name]?.usedPercent).filter(Number.isFinite);
  return {
    ...(percents.length ? { used_percent: Math.max(...percents) } : {}),
    ...(typeof observation.ordinaryUsageAllowed === 'boolean' ? { ordinary_usage_allowed: observation.ordinaryUsageAllowed } : {}),
  };
}

// 完全な観測にならなかった理由。決まった語だけで、上流の文字列は載せない。
function incompleteCode(observation) {
  if (typeof observation.ordinaryUsageAllowed !== 'boolean') return 'allowed-unusable';
  if (!USAGE_WINDOWS.some(name => observation[name])) return 'window-absent';
  return USAGE_WINDOWS.map(name => observation[name]?.incompleteReason).find(Boolean) ?? 'incomplete';
}

// 停止と解除の遷移を記録する。プールの更新の前後を比べ、状態が変わる呼び出しそのものを囲む。
// update() が返すプールの出来事（上流から消えた窓の停止だけを外した）は、遷移より先に出す。
function withUsageStopLogging(pool, nowMs, log, update) {
  // 窓の停止を全部外した後も、復帰の規則を待つ間は停止のまま（resumePending）。
  const stopped = entry => Object.keys(entry.windowCaps ?? {}).length > 0 || entry.upstreamBlocked === true
    || entry.resumePending === true;
  const before = new Map(pool.snapshot().map(entry => [entry.key, stopped(entry)]));
  const events = update() ?? [];
  for (const event of events) {
    if (event?.type !== WINDOW_CAP_DROPPED) continue;
    log('info', 'codex_usage_window_cap_dropped', { account_label: event.label, event_type: event.type,
      window: event.position, window_minutes: event.windowMinutes });
  }
  for (const entry of pool.snapshot()) {
    const latched = stopped(entry);
    if (!before.has(entry.key) || before.get(entry.key) === latched) continue;
    const view = pool.inspect(nowMs).find(account => account.key === entry.key);
    const percents = USAGE_WINDOWS.map(name => entry.observation?.[name]?.usedPercent).filter(Number.isFinite);
    log('info', latched ? 'codex_usage_capped' : 'codex_usage_recovered',
      { account_label: entry.label, used_percent: percents.length ? Math.max(...percents) : undefined,
        ...(latched ? { stop_used_percent: view?.stopUsedPercent } : { resume_used_percent: view?.resumeUsedPercent }) });
  }
}

// 資格情報ファイルの更新時刻。読めなければ null（中身は開かない）。
function credentialsMtime(account) {
  try {
    const mtime = statSync(join(account.home, 'auth.json')).mtimeMs;
    return Number.isFinite(mtime) ? mtime : null;
  } catch {
    return null;
  }
}

// resolveClientIdentity() の戻り値を、送れる組か、送れない理由のどちらかにそろえる。値は検査するだけで
// ここでは記録しない。
function clientIdentityOf(identity) {
  const usable = value => typeof value === 'string' && value.trim() !== '';
  if (usable(identity?.userAgent) && usable(identity?.originator)) {
    return { userAgent: identity.userAgent, originator: identity.originator, reason: null };
  }
  return { userAgent: null, originator: null,
    reason: CLIENT_IDENTITY_REASONS.has(identity?.reason) ? identity.reason : CLIENT_IDENTITY_UNREADABLE };
}

/**
 * 生成を伴わない使用量 GET のスケジューラ。観測をプールへ適用し、ログイン切れの規則
 * （auth-tracker.js）へ結果を渡す。
 *
 * @param {{
 *   pool: object, resolveClientIdentity: () => ({ userAgent?: string, originator?: string, reason?: string }
 *     | Promise<{ userAgent?: string, originator?: string, reason?: string }>),
 *   now?: () => number, scheduler?: object, readUsage?: Function, readCredentials?: Function,
 *   fetchImpl?: typeof fetch, credentialEpoch?: (account: object) => number|null,
 *   log?: (level: string, event: string, fields: object) => void,
 * }} options
 */
export function createUsagePoller({ pool, resolveClientIdentity, now = Date.now, scheduler = globalThis,
  readUsage = readCodexUsage, readCredentials = readCodexSendSnapshot, fetchImpl = fetch,
  credentialEpoch = credentialsMtime,
  // `log(level, event, fields)`。未指定なら何もしない。観測の適用はログの有無に依存しない。
  log = () => {} } = {}) {
  if (typeof resolveClientIdentity !== 'function') throw new TypeError('resolveClientIdentity required');
  const auth = createAuthTracker({ pool, now, log });
  let descriptors = [], intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_READ_TIMEOUT_MS, stopped = false;
  const states = new Map();
  // 口座のキー → 進行中の読取（中断用）。reload をまたいで持ち越す: 状態のオブジェクトごと
  // 作り直しても、同じ口座の読取は1本に保たれる。
  const inflight = new Map();
  const queue = [];
  // 間隔は経過時間の引き算ではなくタイマーの遅延で表す。周期は読取の完了から数えるので、
  // 上流が遅い分だけ周期は伸びる（速くはならない）。
  function schedule(key, baseDelayMs) {
    const state = states.get(key);
    if (!state || stopped) return;
    scheduler.clearTimeout(state.timer);
    const sinceStart = state.startedAt === undefined ? Infinity : now() - state.startedAt;
    const delay = Math.max(baseDelayMs, USAGE_MIN_READ_INTERVAL_MS - sinceStart, 0);
    state.nextAt = now() + delay;
    state.timer = scheduler.setTimeout(() => { state.timer = undefined; enqueue(key); }, delay);
    state.timer?.unref?.();
  }
  function enqueue(key) {
    const state = states.get(key);
    if (!state || stopped || inflight.has(key) || state.queued) return;
    state.queued = true;
    queue.push(key);
    drain();
  }
  function drain() {
    while (!stopped && inflight.size < USAGE_MAX_CONCURRENT_READS && queue.length) {
      const key = queue.shift();
      const state = states.get(key);
      if (!state) continue;
      state.queued = false;
      void read(key, state);
    }
  }
  // 結果を適用してよいのは、その読取を始めた世界がまだ現役のときだけ。reload は口座の状態の
  // オブジェクトごと作り直すので、置き換わった状態から来た結果は、成功・失敗・検証・縮退・復帰の票・
  // 観測・認証状態のどれにも反映しない。
  const isCurrent = (account, state, context) => states.get(account.key) === state &&
    pool.generation() === context.poolGeneration && credentialEpoch(account) === context.credentialEpoch;
  function setDegraded(state, value) {
    if (state.degraded === value) return;
    state.degraded = value;
  }
  // --- 観測性。ログは起きた事実の写しで、観測の適用・予定・縮退の判断をログの有無で変えない。
  // 出さないもの: 上流の応答の本文・任意のエラーメッセージ・資格情報・口座 ID・内部の口座キー・
  // User-Agent と originator の値。口座は設定のラベルだけで指す。
  const labelOf = key => descriptors.find(account => account.key === key)?.label;
  // 読取ごとの debug。observation_age_ms は直前の成功からの間隔（初回の読取では出さない）。
  function logRead(key, state, code, result) {
    log('debug', 'codex_usage_read', { account_label: labelOf(key), observation_result: code,
      usage_read_duration_ms: result?.durationMs, usage_read_status: result?.status ?? undefined,
      observation_age_ms: Number.isFinite(state.lastSuccessAt)
        ? (result?.receivedAt ?? now()) - state.lastSuccessAt : undefined,
      ...(result?.observation ? readingFields(result.observation) : {}) });
  }
  // 同じ失敗を60秒以内に info へ続けて出さない。種類が変われば、すぐに出す。境界は閉じる（間隔
  // ちょうどは抑える側）。失敗の間隔の1段目が同じ60秒なので、開いた境界だと続いている失敗が
  // 読取のたびに info へ出てしまう。
  function logUnavailable(key, state, code) {
    const at = now();
    if (state.lastUnavailableCode === code && at - state.lastUnavailableAt <= USAGE_INFO_REPEAT_MS) return;
    state.lastUnavailableCode = code;
    state.lastUnavailableAt = at;
    log('info', 'codex_usage_unavailable', { account_label: labelOf(key), observation_result: code });
  }
  function failed(key, state, code, result) {
    state.failures++;
    state.errorCode = code;
    if (state.gate === 'pending') state.gate = 'failed';
    // 観測を得られなかった読取は、復帰に要る「完全な観測の連続」を断つ。低い使用率の
    // 成功→失敗→成功で「2回連続」が成り立ってはならない。
    pool.observationFailed(key);
    if (state.gate === 'failed' || state.failures >= USAGE_DEGRADE_AFTER_FAILURES) setDegraded(state, true);
    logRead(key, state, code, result);
    logUnavailable(key, state, code);
    return USAGE_BACKOFF_MS[Math.min(state.failures, USAGE_BACKOFF_MS.length) - 1];
  }
  function settle(account, state, result, context) {
    if (result.classification !== 'success' || !result.observation) {
      return failed(account.key, state, result.failure ?? result.errorCode ?? result.classification, result);
    }
    const observation = result.observation;
    // 完全かどうかは正規化の判定だけで決める（primary 窓の無い応答も完全な観測になりうる）。
    const complete = observation.complete === true;
    // 不完全な観測でも停止は掛かるので、完全かどうかの判定より前に遷移を見る。
    withUsageStopLogging(pool, result.receivedAt, log, () =>
      (pool.observe(account.key, toPoolObservation(observation), result.receivedAt,
        { source: 'usage-get', complete, ordinaryUsageAllowed: observation.ordinaryUsageAllowed,
          sequence: context.sequence, stopEpoch: context.stopEpoch, generation: context.poolGeneration }) ?? [])
        .map(event => ({ ...event, label: account.label })));
    state.allowed = typeof observation.ordinaryUsageAllowed === 'boolean' ? observation.ordinaryUsageAllowed : null;
    state.reachedType = observation.rateLimitReachedType ?? null;
    // 読み切れなかった応答も停止の判定には使うが、検証は通さない（選択は完全な観測の鮮度だけに乗るため）。
    if (!complete) return failed(account.key, state, incompleteCode(observation), result);
    // 直前の成功との間隔を出すため、lastSuccessAt を更新する前に記録する。
    logRead(account.key, state, 'success', result);
    state.failures = 0;
    state.errorCode = null;
    state.gate = 'passed';
    state.lastSuccessAt = result.receivedAt;
    // 成功1回で縮退の記録を外す（口座ごと）。
    setDegraded(state, false);
    return intervalMs;
  }
  // 予期しない例外を記録する。記録そのものが例外を投げても、読取の予定は止めない。
  function internalError(key, state, current) {
    try {
      if (!current()) return intervalMs;
      log('error', 'codex_usage_internal_error', { account_label: labelOf(key) });
      return failed(key, state, INTERNAL_ERROR);
    } catch {
      return intervalMs;
    }
  }
  async function resolveIdentity() {
    try {
      return clientIdentityOf(await resolveClientIdentity());
    } catch {
      return clientIdentityOf(null);
    }
  }
  async function read(key, state) {
    const account = descriptors.find(a => a.key === key);
    if (!account || stopped || inflight.has(key)) return;
    const epoch = credentialEpoch(account);
    // ログイン切れの間は、再確認の時期が来るまで資格情報も読まず、GET も送らない。
    if (!auth.shouldRead(key, epoch)) {
      schedule(key, intervalMs);
      return;
    }
    // 中断用。読取器は渡された signal を自分の期限の signal と合わせるので、終了・口座の削除で
    // 進行中の GET をその場で終わらせられる。
    const controller = new AbortController();
    inflight.set(key, controller);
    state.startedAt = now();
    state.lastAttemptAt = state.startedAt;
    // この読取が記述している世界: 設定の世代・資格情報の世代・開始時の停止の世代・口座の中の
    // 取得の順番。停止より前に始まった読取は復帰の票にならない。
    const context = { poolGeneration: pool.generation(), credentialEpoch: epoch,
      stopEpoch: pool.snapshot().find(a => a.key === key)?.stopEpoch ?? 0, sequence: ++state.sequence };
    const current = () => !stopped && isCurrent(account, state, context);
    let delayMs = intervalMs;
    try {
      let credentials;
      try {
        credentials = await readCredentials(join(account.home, 'auth.json'), { nowMs: now() });
      } catch (error) {
        // 読めない資格情報では GET を送らない。トークンの更新も書込もしない。期限切れと読めなさは
        // ログイン切れの規則へ渡す（期限切れはその場で needs login、読めなさは2周期で no creds）。
        // ここで扱うのは資格情報の読取の例外だけで、それ以外の例外は外側の catch へ行く。
        if (current()) {
          const expired = error?.message === 'send credentials expired';
          auth.credentialsRead(key, expired ? CREDENTIALS_OUTCOME.expired : CREDENTIALS_OUTCOME.unreadable,
            context.credentialEpoch);
          delayMs = failed(key, state, expired ? 'credentials-expired' : 'credentials-unavailable');
        }
        return;
      }
      // 終了の後は新しい GET を始めない。資格情報の読取を待つ間に終了した場合がここに当たる。
      if (stopped) return;
      const identity = await resolveIdentity();
      if (stopped) return;
      if (identity.userAgent === null) {
        // User-Agent を作れなかった。GET を送らない。ログイン切れの数え方には触れない。
        if (current()) {
          auth.credentialsRead(key, CREDENTIALS_OUTCOME.readable, context.credentialEpoch);
          auth.usageResult(key, null, context.credentialEpoch);
          delayMs = failed(key, state, identity.reason);
        }
        return;
      }
      const result = await readUsage({ credentials, userAgent: identity.userAgent, originator: identity.originator,
        fetchImpl, now, timeoutMs, signal: controller.signal });
      // 終了の後は何も適用しない。世代の一致は、成功・失敗の別を問わず適用の前に確かめる。
      if (current()) {
        auth.credentialsRead(key, CREDENTIALS_OUTCOME.readable, context.credentialEpoch);
        auth.usageResult(key, result, context.credentialEpoch, { startedAt: state.startedAt });
        delayMs = settle(account, state, result, context);
      }
    } catch {
      // プログラムの誤り（読取器・規則・観測の適用などの予期しない例外）。資格情報が読めないとは数えず、
      // 認証状態も動かさない。観測の失敗としてだけ記録して、失敗の間隔を空ける。
      delayMs = internalError(key, state, current);
    } finally {
      inflight.delete(key);
      // reload で状態が差し替わっていたら、新しい状態の周期で予約し直す（この読取の遅延は別の
      // 設定の世代の話）。口座ごと消えていれば何も予約しない。
      const latest = states.get(key);
      if (latest) schedule(key, latest === state ? delayMs : 0);
      drain();
    }
  }
  return {
    // 起動時と reload の後に、検証（口座ごとに GET を1回・生成なし）をやり直す。
    configure(accounts, config = {}) {
      for (const [key, state] of states) {
        if (accounts.some(account => account.key === key)) continue;
        scheduler.clearTimeout(state.timer);
        states.delete(key);
        // 登録から外れた口座の読取は誰も受け取らない。中断して、進行中のまま残さない。
        inflight.get(key)?.abort();
      }
      descriptors = accounts;
      intervalMs = config.usagePollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      timeoutMs = config.usageReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
      auth.configure(accounts, { usagePollIntervalMs: intervalMs });
      queue.length = 0;
      for (const account of accounts) {
        const prior = states.get(account.key);
        scheduler.clearTimeout(prior?.timer);
        // 観測の履歴（最後の観測の時刻・allowed）は状態の表示のために引き継ぎ、検証と失敗の数だけを
        // やり直す。
        states.set(account.key, { sequence: prior?.sequence ?? 0, failures: 0, degraded: false, errorCode: null,
          gate: 'pending', nextAt: null, startedAt: prior?.startedAt,
          lastAttemptAt: prior?.lastAttemptAt ?? null, lastSuccessAt: prior?.lastSuccessAt ?? null,
          allowed: prior?.allowed ?? null, reachedType: prior?.reachedType ?? null,
          // 同じ失敗を続けて出さない記録は reload をまたいで引き継ぐ。設定の読み直しは、続いている
          // 同じ失敗を info へもう一度出してよい理由にならない。
          lastUnavailableCode: prior?.lastUnavailableCode ?? null, lastUnavailableAt: prior?.lastUnavailableAt ?? -Infinity });
      }
      if (stopped) return;
      for (const account of accounts) schedule(account.key, 0);
    },
    // 終了の後は状態を変えない。タイマーを残さない。
    shutdown() {
      stopped = true;
      queue.length = 0;
      for (const state of states.values()) {
        scheduler.clearTimeout(state.timer);
        state.timer = undefined;
        state.nextAt = null;
      }
      // タイマーを止めるだけでは進行中の GET が期限まで残る。読取器は中断を aborted として返す
      // ので、ここで例外は起きず、何も適用されない。
      for (const controller of inflight.values()) controller.abort();
    },
    observation() {
      const gates = descriptors.map(account => states.get(account.key)?.gate);
      return { source: 'usage-get',
        gate: gates.includes('pending') ? 'pending' : gates.includes('failed') ? 'failed' : 'passed',
        // 口座全体（ChatGPT アプリ・Codex CLI などを含む）の観測で、CLI だけの消費量は分からない。
        cliConsumptionVisible: false, accountUsageIncludesExternalClients: true };
    },
    accountHealth(key) {
      const state = states.get(key);
      if (!state) return { lastObservationAttemptAt: null, lastObservationSuccessAt: null, nextObservationAt: null,
        observationErrorCode: null, observationDegraded: false, observationGate: 'not-required',
        ordinaryUsageAllowed: null, rateLimitReachedType: null };
      return { lastObservationAttemptAt: state.lastAttemptAt ?? null, lastObservationSuccessAt: state.lastSuccessAt ?? null,
        nextObservationAt: state.timer === undefined ? null : state.nextAt, observationErrorCode: state.errorCode ?? null,
        observationDegraded: state.degraded === true, observationGate: state.gate,
        ordinaryUsageAllowed: state.allowed ?? null, rateLimitReachedType: state.reachedType ?? null };
    },
  };
}
