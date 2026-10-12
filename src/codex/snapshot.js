// 状態の射影（snapshot）。口座プール・使用量の取得処理・出来事の記録などの状態を、1つの JSON の値
// （src/shared/codex-status-schema.js の形）にまとめる。status・monitor・JSON は、すべてこの1つから描く。
//
// あわせて、プールを作る関数をここに1つだけ置く（createCodexPool）。プールの既定の観測方式は受動の
// 方式のままで、設定はこの方式のキーを受け付けない。常駐・常駐が無いときの直接読取・1回読みのどれも
// この関数だけでプールを作り、作るときと configure() のたびの両方で使用量の GET の方式（http）を渡す
// （configure() は既定値から作り直すので、渡し忘れると受動の方式へ戻る）。
//
// 射影の約束:
//   - 読むだけ。プールの snapshot()・inspect()・health()・select()・lastResort() と、取得処理の
//     accountHealth()・observation() は、どれも状態を変えない。
//   - 値は許可したキーだけを組み立てて作る。プールや取得処理の写しを広げて渡さない（余分なキーが
//     混じっても JSON に出ない）。口座はラベルだけで指し、内部のキー・パス・口座 ID・資格情報・
//     User-Agent の値は出さない。
//   - 窓は、プールが窓の鍵ごとに持つ写し（windows・windowCaps）から、申告された長さで振り分ける。
//     位置で見た写し（observation・capped）は使わない。停止していない窓のうち、口座の最後の完全な観測
//     （usageGetAt）より前に観測したものは、上流がもう申告していない窓として出さない（プールはその窓を
//     消さないため）。外すのは、取得処理が「前回の読み直しの後に成功が1回以上あり、最後の読取は失敗して
//     いない」と示すときだけ。停止中の窓は外さない（判定の表は stillDeclared の直前）。
//   - 状態語は、以前の版の `claude-rotator status` の Codex の節と同じ規則（選択を止める理由と口座の状態から12語を導く）で決める。
import { createCodexAccountPool, USAGE_AUTH_REJECTION_REASONS } from './account-pool.js';
import {
  CODEX_ACCOUNT_REASONS, CODEX_AGGREGATE_UNIT, CODEX_CLEAN_READS_NEEDED, CODEX_EVENTS_LIMIT, CODEX_EVENT_TYPES,
  CODEX_OBSERVATION_METHOD, CODEX_POOL_STATES, CODEX_PROVIDER, CODEX_STARTUP_CHECKS, CODEX_STATE_OF_WORD,
  CODEX_STATUS_SCHEMA_VERSION, CODEX_STATUS_SOURCES, CODEX_USER_AGENT_SOURCES, CODEX_WINDOW_CLASSES,
  codexIsoTime, isCodexIsoTime, isCodexLabel,
} from '../shared/codex-status-schema.js';

// 使用量の観測方式。codex-rotator は使用量の GET だけで読む。
export const CODEX_USAGE_OBSERVATION_MODE = 'http';

const withHttpObservation = options => ({ ...(options ?? {}), usageObservationMode: CODEX_USAGE_OBSERVATION_MODE });

/**
 * 口座プールを作る（Codex 側でプールを作る唯一の入口）。作るときと configure() のたびの両方で、
 * 観測方式を使用量の GET（http）にする。渡された options に別の方式があっても上書きする。
 * @param {Array<{ key: string, label?: string, models?: string[]|null, previousKey?: string }>} [initialAccounts]
 * @param {object} [options] プールの設定（検証済みの codex-rotator の設定をそのまま渡してよい）
 */
export function createCodexPool(initialAccounts = [], options = {}) {
  const pool = createCodexAccountPool(initialAccounts, withHttpObservation(options));
  return Object.freeze({
    ...pool,
    configure: (next = {}, nowMs) => pool.configure(withHttpObservation(next), nowMs),
  });
}

// 窓の長さ（分）。5時間窓と週次窓。それ以外の長さは otherWindows。
const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10080;
// 長さの申告が無い窓は、報告された位置で振り分ける。
const CLASS_OF_POSITION = Object.freeze({ primary: 'fiveHour', secondary: 'weekly' });
// 使用量が読めなかった原因として reason に出す語（それ以外の原因は usage-unknown に寄せる）。
const CAUSE_REASONS = new Set(['codex-cli-missing', 'codex-version-unreadable', 'read-deadline']);
const AUTH_REASONS = new Set(USAGE_AUTH_REJECTION_REASONS);
const ACCOUNT_REASONS = new Set(CODEX_ACCOUNT_REASONS);
const EVENT_TYPES = new Set(CODEX_EVENT_TYPES);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const percentOrNull = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
  ? value : null);
const classOfMinutes = minutes => (minutes === FIVE_HOUR_MINUTES ? 'fiveHour'
  : minutes === WEEK_MINUTES ? 'weekly' : 'other');

// 窓の鍵（len:<分> か pos:<位置>）だけから区分を決める。保存した窓が無い停止の鍵にだけ使う。
function classOfWindowKey(key) {
  if (key.startsWith('len:')) return classOfMinutes(Number(key.slice(4)));
  if (key.startsWith('pos:')) return CLASS_OF_POSITION[key.slice(4)] ?? 'other';
  return 'other';
}

// プールの鮮度の規則と同じ: 観測から鮮度の長さが過ぎておらず、リセット時刻の前。
function isFreshWindow(window, freshnessMs, nowMs) {
  return Number.isFinite(window.observedAt) && Number.isFinite(freshnessMs) && nowMs - window.observedAt < freshnessMs
    && (window.resetAt === undefined || nowMs < window.resetAt);
}

function projectWindow(window, freshnessMs, nowMs, lengthSource) {
  const minutes = window.windowDurationMins;
  return {
    usedPercent: percentOrNull(window.usedPercent),
    resetAt: codexIsoTime(window.resetAt),
    windowMinutes: Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    fresh: isFreshWindow(window, freshnessMs, nowMs),
    observedAt: codexIsoTime(window.observedAt),
    lengthSource,
  };
}

// 上流がまだ申告している窓か（false なら、その窓を JSON の windows・otherWindows と実効残量の計算から外す）。
//
// 完全な観測は、その時点で上流が申告した窓を全部載せる（載った窓の観測の時刻はその観測の時刻になる）。
// だから、停止していない窓で、観測の時刻が最後の完全な観測（usageGetAt）より前のものは、その完全な観測に
// 載っていなかった（上流から消えた）窓である。停止中の窓は、停止の説明に要るので外さない。
//
// 外すのは、取得処理が「前回の読み直し（起動を含む）の後に成功が1回以上あり、最後の読取は失敗していない」
// と示すときだけ。取得処理（usage-poller.js）の約束: 読取が成功すると observationErrorCode を null・
// observationGate を passed にする。失敗すると observationErrorCode に語を入れ（gate が pending なら failed
// にし、passed はそのまま残す）、読み直しでは null・pending に戻す。知らない口座には not-required を返す。
// よって「gate が passed かつ observationErrorCode が null」がその条件になる。最後の読取が失敗した（不完全な
// 観測を含む）ときや、読み直しの後にまだ成功していないときは、消えた窓が使用率の読めない形で再び申告されて
// いるかもしれないので、窓を残して欠測として見せる。取得処理が無いとき（poller:null）も外さない。
//
// 判定の表（停止中＝その窓の停止が記録されている、古い＝窓の観測の時刻 < usageGetAt）
//   #   取得処理が示す口座の状態                       停止中  古い    判定
//   1   取得処理なし（poller:null）                    いいえ  いいえ  外さない
//   2   取得処理なし（poller:null）                    いいえ  はい    外さない
//   3   取得処理なし（poller:null）                    はい    いいえ  外さない
//   4   取得処理なし（poller:null）                    はい    はい    外さない
//   5   gate が not-required（その口座を知らない）      いいえ  いいえ  外さない
//   6   gate が not-required（その口座を知らない）      いいえ  はい    外さない
//   7   gate が not-required（その口座を知らない）      はい    いいえ  外さない
//   8   gate が not-required（その口座を知らない）      はい    はい    外さない
//   9   gate が pending（起動直後・読み直し直後）        いいえ  いいえ  外さない
//   10  gate が pending（起動直後・読み直し直後）        いいえ  はい    外さない
//   11  gate が pending（起動直後・読み直し直後）        はい    いいえ  外さない
//   12  gate が pending（起動直後・読み直し直後）        はい    はい    外さない
//   13  gate が failed（読み直しの後に成功が無い）       いいえ  いいえ  外さない
//   14  gate が failed（読み直しの後に成功が無い）       いいえ  はい    外さない
//   15  gate が failed（読み直しの後に成功が無い）       はい    いいえ  外さない
//   16  gate が failed（読み直しの後に成功が無い）       はい    はい    外さない
//   17  gate が passed・observationErrorCode に語あり   いいえ  いいえ  外さない
//   18  gate が passed・observationErrorCode に語あり   いいえ  はい    外さない
//   19  gate が passed・observationErrorCode に語あり   はい    いいえ  外さない
//   20  gate が passed・observationErrorCode に語あり   はい    はい    外さない
//   21  gate が passed・observationErrorCode が null    いいえ  いいえ  外さない
//   22  gate が passed・observationErrorCode が null    いいえ  はい    外す
//   23  gate が passed・observationErrorCode が null    はい    いいえ  外さない
//   24  gate が passed・observationErrorCode が null    はい    はい    外さない
// この表は test/codex/snapshot.test.js の STILL_DECLARED_TABLE と1行ずつ対応し、全行をテストする。
function stillDeclared(entry, window, cappedKeys, health) {
  if (cappedKeys.has(window.key)) return true;
  const lastReadSucceeded = isRecord(health) && health.observationGate === 'passed'
    && health.observationErrorCode === null;
  if (!lastReadSucceeded) return true;
  const lastComplete = entry.usageGetAt;
  return !(Number.isFinite(lastComplete) && Number.isFinite(window.observedAt) && window.observedAt < lastComplete);
}

// 保存した窓を振り分ける。長さを申告した窓を先に置き、長さの申告が無い窓は位置で空いた枠へ置く
// （枠が埋まっていれば otherWindows）。classOfKey は窓の鍵 → 区分（停止中の窓の区分に使う）。
function projectWindows(entry, health, freshnessMs, nowMs) {
  const cappedKeys = new Set(Object.keys(isRecord(entry.windowCaps) ? entry.windowCaps : {}));
  const stored = Object.values(isRecord(entry.windows) ? entry.windows : {})
    .filter(window => isRecord(window) && typeof window.key === 'string'
      && stillDeclared(entry, window, cappedKeys, health));
  const slots = { fiveHour: null, weekly: null };
  const others = [];
  const classOfKey = new Map();
  let lastObservedAt = -Infinity;
  const place = (window, windowClass, lengthSource) => {
    const projected = projectWindow(window, freshnessMs, nowMs, lengthSource);
    if (Number.isFinite(window.observedAt)) lastObservedAt = Math.max(lastObservedAt, window.observedAt);
    if (windowClass !== 'other' && slots[windowClass] === null) {
      slots[windowClass] = projected;
      classOfKey.set(window.key, windowClass);
      return;
    }
    others.push({ key: window.key, projected });
    classOfKey.set(window.key, 'other');
  };
  const reported = window => Number.isFinite(window.windowDurationMins);
  for (const window of stored.filter(reported)) place(window, classOfMinutes(window.windowDurationMins), 'reported');
  for (const window of stored.filter(window => !reported(window))) {
    place(window, CLASS_OF_POSITION[window.position] ?? 'other', 'position');
  }
  // 並びは長さの短い順（長さが無いものは後ろ）、同じなら鍵の順。
  const order = item => item.projected.windowMinutes ?? Infinity;
  others.sort((a, b) => order(a) - order(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { windows: slots, otherWindows: others.map(item => item.projected), classOfKey, lastObservedAt };
}

// 停止の記録。停止中（窓の停止・上流の拒否・窓の停止を外した後の復帰待ちのどれか）だけ出す。
// 数えた復帰の票は、方針を持つ口座では停止中に0か1（2つそろえば解除される）。上限を越えて見せない。
// 停止した時刻は、窓の停止が始まった時刻（cappedSince）。上流の拒否だけで止まったときは null。プールの
// stoppedAt は停止を記録し直すたび（拒否を読むたび）に進むので、停止の始まりとしては使わない。
function projectLatch(entry, classOfKey) {
  const capKeys = Object.keys(isRecord(entry.windowCaps) ? entry.windowCaps : {});
  if (capKeys.length === 0 && entry.upstreamBlocked !== true && entry.resumePending !== true) return null;
  const classes = new Set(capKeys.map(key => classOfKey.get(key) ?? classOfWindowKey(key)));
  const streak = Number.isInteger(entry.resumeStreak) && entry.resumeStreak > 0 ? entry.resumeStreak : 0;
  return {
    stopped: true,
    cappedWindows: CODEX_WINDOW_CLASSES.filter(windowClass => classes.has(windowClass)),
    upstreamBlocked: entry.upstreamBlocked === true,
    cleanReadsDone: Math.min(streak, CODEX_CLEAN_READS_NEEDED - 1),
    cleanReadsNeeded: CODEX_CLEAN_READS_NEEDED,
    since: codexIsoTime(entry.cappedSince),
  };
}

// 方針は全口座に要る（設定が方針の無い口座を拒否する）。無ければ射影しない。
function projectPolicy(view) {
  const stop = view.stopUsedPercent;
  const resume = view.resumeUsedPercent;
  const stopUsable = typeof stop === 'number' && Number.isFinite(stop) && stop > 0 && stop <= 100;
  if (!stopUsable || typeof resume !== 'number' || !Number.isFinite(resume) || resume < 0 || resume >= stop) {
    throw new TypeError('every account needs a usage policy');
  }
  return { stopUsedPercent: stop, resumeUsedPercent: resume, blockWhenUnknown: view.blockWhenUnknown === true };
}

// 状態語（以前の版の `claude-rotator status` の Codex の節と同じ規則）。停止しきい値は方針の値で、方針は全口座にあるので、
// しきい値の分からない停止（stopped）はここでは生じない。どれにも当たらなければ unread に倒す。
function stateWordOf(entry, view, stopUsedPercent) {
  const reason = view.selectionBlockReason;
  const state = entry.state;
  if (reason === 'needs-login' || state === 'needs-login') return 'needs login';
  if (reason === 'credentials-unavailable') return 'no creds';
  if (reason === 'model-unassigned') return 'no models';
  if (reason === 'exhausted' || state === 'exhausted') return 'exhausted';
  if (reason === 'upstream-blocked') return 'blocked';
  if (reason === 'usage-capped') return stopUsedPercent >= 100 ? 'capped' : 'held';
  if (reason === 'usage-unknown-reserved') return 'reserved';
  if (reason === 'usage-unknown') return 'unread';
  if (view.selectionEligible === true) return 'ready';
  return 'unread';
}

// 常駐の起動の後、その口座の最初の読取を始める前（取得処理が一度も読取を始めておらず、起動時の
// 検証が済んでいない）。
const beforeFirstRead = health => isRecord(health) && health.lastObservationAttemptAt === null
  && health.observationGate === 'pending';

// reason: 選択を止める理由の語を基にし、ログイン切れはその理由の語へ、使用量が読めなかった口座は
// 決めた原因の語だけへ置き換える。選べる口座は null。
function reasonOf(entry, view, health) {
  const base = view.selectionBlockReason;
  if (base === 'needs-login') return AUTH_REASONS.has(entry.authReason) ? entry.authReason : null;
  const cause = isRecord(health) ? health.observationErrorCode : null;
  if ((base === 'usage-unknown' || base === 'usage-unknown-reserved') && CAUSE_REASONS.has(cause)) return cause;
  return ACCOUNT_REASONS.has(base) ? base : null;
}

// order は設定の口座の並び順（1から）。プールは設定の並びのまま口座を持つ（reconcile に渡した順）ので、
// snapshot() の並びの位置から付ける。
function projectAccount(entry, view, health, { source, nowMs, order }) {
  if (!isCodexLabel(entry.label)) throw new TypeError('every account needs a label of the account label form');
  const policy = projectPolicy(view);
  const { windows, otherWindows, classOfKey, lastObservedAt } = projectWindows(entry, health, view.freshnessMs, nowMs);
  let stateWord = stateWordOf(entry, view, policy.stopUsedPercent);
  if (stateWord === 'unread' && beforeFirstRead(health)) stateWord = 'starting';
  const account = {
    label: entry.label,
    order,
    state: CODEX_STATE_OF_WORD[stateWord],
    stateWord,
    // 選べるかは、渡されたプールの選択の規則（inspect()）のとおり。常駐が無いときの直接読取でも同じに
    // 埋める（aggregate.accountsSelectable は null を許さず、この値から数えるため。next もこの規則で選ぶ）。
    selectable: view.selectionEligible === true,
    reason: reasonOf(entry, view, health),
    resetAt: codexIsoTime(entry.resetAt),
    ordinaryUsageAllowed: isRecord(health) && typeof health.ordinaryUsageAllowed === 'boolean'
      ? health.ordinaryUsageAllowed : null,
    nextObservationAt: isRecord(health) ? codexIsoTime(health.nextObservationAt) : null,
    policy,
    latch: projectLatch(entry, classOfKey),
    windows,
    otherWindows,
    observedAt: codexIsoTime(lastObservedAt),
    headroomPercent: null,
  };
  account.headroomPercent = codexAccountHeadroom(account, { source });
  return account;
}

// プール全体の状態。口座0件は no-account。プールが縮退（degraded）と言い、選べる口座が1つも無いときは
// 使える見込みが分からないので unknown。それ以外はプールの値のまま。
function poolStateOf(accountCount, health, eligibleCount) {
  if (accountCount === 0) return 'no-account';
  const raw = isRecord(health) ? health.state : undefined;
  if (raw === 'degraded' && eligibleCount === 0) return 'unknown';
  return CODEX_POOL_STATES.includes(raw) ? raw : 'unknown';
}

// 次に選ばれる口座。選べる口座が無ければ最後の手段、それも無ければ none。無効なら disabled。
function nextOf(pool, { enabled, nowMs, labelOfKey }) {
  if (!enabled) return { label: null, reason: 'disabled' };
  const chosen = labelOfKey.get(pool.select(undefined, nowMs)?.key);
  if (chosen !== undefined) return { label: chosen, reason: 'selectable' };
  const fallback = labelOfKey.get(pool.lastResort(undefined, nowMs)?.key);
  if (fallback !== undefined) return { label: fallback, reason: 'last-resort' };
  return { label: null, reason: 'none' };
}

// 出来事は、形に合うものだけを、決めた3つのキーで写す（新しい方から上限の件数まで）。
function projectEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  return events
    .filter(event => isRecord(event) && isCodexIsoTime(event.at) && EVENT_TYPES.has(event.type)
      && (event.label === null || isCodexLabel(event.label)))
    .map(({ at, type, label }) => ({ at, type, label }))
    .slice(-CODEX_EVENTS_LIMIT);
}

const DECLARED_WINDOWS = Object.freeze({
  all: account => [account.windows.fiveHour, account.windows.weekly, ...account.otherWindows],
  fiveHour: account => [account.windows.fiveHour],
  weekly: account => [account.windows.weekly],
});

/**
 * 1口座の実効残量への寄与（percent points）。規則を上から順に当てはめ、最初に当たったもので決める。
 *   1. 0: 状態が exhausted か login_required、状態語が no models か reserved、または常駐が無い
 *      （source:"direct"）ときに申告された窓のどれかの使用率が停止しきい値以上。
 *   2. null: 状態語が unread か starting、常駐が無い、申告された窓が無い、または、そのどれかが新しく
 *      ないか使用率が無い。
 *   3. 数値: 申告された窓ごとの max(0, 停止しきい値 − 使用率) の最小値。
 * 「申告された窓」は part で絞った窓（all は全窓、fiveHour・weekly はその窓だけ）で、規則1の常駐が
 * 無いときの判定にも規則2・3にも同じ窓を使う（窓ごとの合計は、規則をその窓だけに当てはめる）。
 * @param {object} account 射影した口座（JSON の形）
 * @param {{ source: 'daemon'|'direct', part?: 'all'|'fiveHour'|'weekly' }} options
 * @returns {number|null}
 */
export function codexAccountHeadroom(account, { source, part = 'all' } = {}) {
  if (!Object.hasOwn(DECLARED_WINDOWS, part)) throw new TypeError('unknown window part');
  const pick = DECLARED_WINDOWS[part];
  const stop = account.policy.stopUsedPercent;
  if (account.state === 'exhausted' || account.state === 'login_required'
    || account.stateWord === 'no models' || account.stateWord === 'reserved') return 0;
  const declared = pick(account).filter(Boolean);
  const reachesStop = window => typeof window.usedPercent === 'number' && window.usedPercent >= stop;
  if (source === 'direct' && declared.some(reachesStop)) return 0;
  if (account.stateWord === 'unread' || account.stateWord === 'starting' || source === 'direct'
    || declared.length === 0 || declared.some(window => window.fresh !== true || typeof window.usedPercent !== 'number')) {
    return null;
  }
  if (account.state !== 'available') return null;
  return Math.min(...declared.map(window => Math.max(0, stop - window.usedPercent)));
}

/**
 * 全口座の実効残量と件数（JSON の aggregate）。
 *   4. 全体の値: 無効なら null。口座0件なら 0。寄与に1つでも null があれば null。それ以外は寄与の合計。
 *   5. 下限: null でない寄与の合計（常に数値）。
 *   6. 窓ごとの合計: 同じ規則を、その窓だけを申告された窓として当てはめる。
 * @param {object[]} accounts 射影した口座（JSON の形）
 * @param {{ enabled: boolean, source: 'daemon'|'direct' }} options
 */
export function aggregateCodexAccounts(accounts, { enabled, source }) {
  if (!Array.isArray(accounts)) throw new TypeError('accounts must be an array');
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be true or false');
  if (!CODEX_STATUS_SOURCES.includes(source)) throw new TypeError('source must be daemon or direct');
  const sum = values => values.reduce((total, value) => total + value, 0);
  const contributions = part => accounts.map(account => codexAccountHeadroom(account, { source, part }));
  const overall = part => {
    const values = contributions(part);
    if (!enabled) return null;
    return values.some(value => value === null) ? null : sum(values);
  };
  const count = predicate => accounts.filter(predicate).length;
  return {
    effectiveRemainingPercent: overall('all'),
    lowerBoundPercent: sum(contributions('all').filter(value => value !== null)),
    fiveHourRemainingPercent: overall('fiveHour'),
    weeklyRemainingPercent: overall('weekly'),
    accountsTotal: accounts.length,
    accountsAvailable: count(account => account.state === 'available'),
    accountsSelectable: count(account => account.selectable === true),
    accountsUnknown: count(account => account.state === 'unknown'),
    unit: CODEX_AGGREGATE_UNIT,
  };
}

/**
 * 状態を1つの JSON の値に射影する。プールと取得処理は読むだけで、状態を変えない。
 * @param {{
 *   enabled: boolean,
 *   pool: { snapshot: Function, inspect: Function, health: Function, select: Function, lastResort: Function },
 *   poller?: { accountHealth: Function, observation: Function }|null,
 *   userAgentSource?: 'codex-version'|'config'|null,
 *   events?: Array<{ at: string, type: string, label: string|null }>,
 *   daemon?: { reachable: boolean, startedAt: number|null },
 *   source: 'daemon'|'direct',
 *   nowMs: number,
 * }} input enabled は有効化の二重ゲートの結果。daemon.startedAt は常駐の起動時刻（ミリ秒）。
 */
export function projectCodexStatus({ enabled, pool, poller = null, userAgentSource = null, events = [],
  daemon = { reachable: false, startedAt: null }, source, nowMs } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be true or false');
  if (!pool || ['snapshot', 'inspect', 'health', 'select', 'lastResort'].some(name => typeof pool[name] !== 'function')) {
    throw new TypeError('a codex account pool is required');
  }
  if (poller !== null && (typeof poller?.accountHealth !== 'function' || typeof poller?.observation !== 'function')) {
    throw new TypeError('poller must provide accountHealth() and observation()');
  }
  if (userAgentSource !== null && !CODEX_USER_AGENT_SOURCES.includes(userAgentSource)) {
    throw new TypeError('userAgentSource must be codex-version, config or null');
  }
  if (!isRecord(daemon) || typeof daemon.reachable !== 'boolean'
    || (daemon.startedAt !== null && !Number.isFinite(daemon.startedAt))) {
    throw new TypeError('daemon must be { reachable: boolean, startedAt: number|null }');
  }
  if (!CODEX_STATUS_SOURCES.includes(source)) throw new TypeError('source must be daemon or direct');
  const generatedAt = codexIsoTime(nowMs);
  if (generatedAt === null) throw new TypeError('nowMs must be a representable time');

  const entries = pool.snapshot();
  const views = new Map(pool.inspect(nowMs).filter(isRecord).map(view => [view.key, view]));
  const accounts = entries.map((entry, index) => {
    const view = views.get(entry.key);
    if (!view) throw new TypeError('the pool inspection must describe every account');
    const health = poller === null ? null : poller.accountHealth(entry.key);
    return projectAccount(entry, view, health, { source, nowMs, order: index + 1 });
  });
  const eligibleCount = entries.filter(entry => views.get(entry.key).selectionEligible === true).length;
  const labelOfKey = new Map(entries.map(entry => [entry.key, entry.label]));
  const poolHealth = pool.health(nowMs);
  const gate = poller === null ? null : poller.observation()?.gate;

  return {
    schemaVersion: CODEX_STATUS_SCHEMA_VERSION,
    provider: CODEX_PROVIDER,
    enabled,
    generatedAt,
    source,
    latchKnown: source === 'daemon',
    daemon: { reachable: daemon.reachable, startedAt: codexIsoTime(daemon.startedAt) },
    pool: { state: poolStateOf(accounts.length, poolHealth, eligibleCount),
      resetAt: isRecord(poolHealth) ? codexIsoTime(poolHealth.resetAt) : null },
    observation: {
      method: CODEX_OBSERVATION_METHOD,
      startupCheck: CODEX_STARTUP_CHECKS.includes(gate) ? gate : null,
      // 使用量は口座全体（ChatGPT アプリ・Codex CLI などを含む）の値で、CLI だけの消費量は分からない。
      accountUsageIncludesExternalClients: true,
      cliConsumptionVisible: false,
      userAgentSource,
    },
    next: nextOf(pool, { enabled, nowMs, labelOfKey }),
    accounts,
    aggregate: aggregateCodexAccounts(accounts, { enabled, source }),
    events: projectEvents(events),
  };
}
