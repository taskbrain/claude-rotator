// codex-rotator の状態の JSON（`status --json`・`status --json --section`・常駐の `/internal/status`）の
// 形の検査と、その語彙・時間の定数。
//
// 共用部品なので、import してよいのは src/shared/ と node: の標準部品だけ（境界検査）。Codex 側の
// 定数（ラベルの形・理由の語）と同じ値をここにも持ち、揃っていることはテストで確かめる。
//
// 検査の方針:
//   - どの階層でも、決めたキーをすべて持ち、それ以外のキーを持たないこと（余分なキーは拒否する）。
//     不明は null で表し、キーを省かない。配列が空なら [] で、null にしない。
//   - 語彙の外の値・型違い・範囲外の数を拒否する。状態語（12語）と4つの状態の対応も確かめる。
//   - 問題の場所はキーの並び（例 `accounts[0].reason`）でだけ返す。値そのものと、知らないキーの
//     名前は返さない（検査の結果はログや画面へ出うるため）。

export const CODEX_STATUS_SCHEMA_VERSION = 1;
export const CODEX_PROVIDER = 'codex';
export const CODEX_OBSERVATION_METHOD = 'usage-get';
export const CODEX_AGGREGATE_UNIT = 'percent-points-of-one-account';

// 時間の約束（常駐が無くても status が出ることの保証）。子（codex-rotator の --section）と、その子を
// 起動して待つ親が、同じ値を import する。
//   - 子が起動されてから JSON を書き終えるまでの全体の期限（常駐への問い合わせと直接読取を含む）。
export const CODEX_SECTION_DEADLINE_MS = 6000;
//   - 常駐が無いときの直接読取の同時数。
export const CODEX_DIRECT_READ_CONCURRENCY = 4;
//   - 親が子を待つ期限。子の全体の期限に、Node の起動と JSON の受け渡しの余裕を足した値。
const CHILD_STARTUP_MARGIN_MS = 2000;
export const CODEX_CHILD_TIMEOUT_MS = CODEX_SECTION_DEADLINE_MS + CHILD_STARTUP_MARGIN_MS;

// 口座のラベル。JSON で口座を指すのはこのラベルだけ（Codex 側の設定の検査と同じ形）。
export const CODEX_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// 状態語（12語）から4つの状態への対応。
export const CODEX_STATE_OF_WORD = Object.freeze({
  ready: 'available',
  held: 'exhausted',
  capped: 'exhausted',
  exhausted: 'exhausted',
  stopped: 'exhausted',
  blocked: 'exhausted',
  'needs login': 'login_required',
  'no creds': 'login_required',
  'no models': 'unknown',
  reserved: 'unknown',
  unread: 'unknown',
  starting: 'unknown',
});
export const CODEX_STATE_WORDS = Object.freeze(Object.keys(CODEX_STATE_OF_WORD));
export const CODEX_ACCOUNT_STATES = Object.freeze(['available', 'exhausted', 'login_required', 'unknown']);
export const CODEX_POOL_STATES = Object.freeze(['ok', 'degraded', 'exhausted', 'mixed', 'needs-login',
  'credentials-unavailable', 'no-account', 'unknown']);
export const CODEX_STATUS_SOURCES = Object.freeze(['daemon', 'direct']);
// User-Agent の出どころ（値そのものは JSON に出さない）。作れなかったときは null。
export const CODEX_USER_AGENT_SOURCES = Object.freeze(['codex-version', 'config']);
export const CODEX_STARTUP_CHECKS = Object.freeze(['passed', 'failed', 'pending']);

// 口座の reason の語。
//   - 選択を止める理由: usage-capped・upstream-blocked・usage-unknown-reserved・usage-unknown・
//     model-unassigned・exhausted・credentials-unavailable
//   - ログイン切れの理由: upstream-unauthorized・upstream-forbidden・access-token-expired
//   - 使用量が読めなかった原因として出す語: codex-cli-missing・codex-version-unreadable（User-Agent が
//     作れず読取を送らなかった）・read-deadline（常駐が無いときの直接読取が全体の期限に間に合わなかった）
// 選べる口座は null。
export const CODEX_ACCOUNT_REASONS = Object.freeze(['usage-capped', 'upstream-blocked', 'usage-unknown-reserved',
  'usage-unknown', 'model-unassigned', 'exhausted', 'credentials-unavailable',
  'upstream-unauthorized', 'upstream-forbidden', 'access-token-expired',
  'codex-cli-missing', 'codex-version-unreadable', 'read-deadline']);
// 次に選ばれる口座（next）の reason の語。disabled はここでだけ使う（口座の reason には使わない）。
export const CODEX_NEXT_REASONS = Object.freeze(['selectable', 'last-resort', 'none', 'disabled']);

// 出来事の種類: 停止・解除・窓の停止だけの解除・ログイン切れ・復帰・読み直し・選択。
export const CODEX_EVENT_TYPES = Object.freeze(['stopped', 'released', 'window-cap-dropped', 'needs-login',
  'recovered', 'reloaded', 'selected']);
// 出来事の記録はメモリだけで、この件数まで持つ。
export const CODEX_EVENTS_LIMIT = 50;

// 停止中の窓の区分と、窓の長さの出どころ。
export const CODEX_WINDOW_CLASSES = Object.freeze(['fiveHour', 'weekly', 'other']);
export const CODEX_LENGTH_SOURCES = Object.freeze(['reported', 'position']);
// 停止を解くのに要る、復帰の条件を満たした完全な観測の回数。
export const CODEX_CLEAN_READS_NEEDED = 2;

// 日時は UTC の `YYYY-MM-DDTHH:MM:SSZ`（ミリ秒を持たない）。
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// RFC3339 で表現できる上限（9999-12-31T23:59:59.999Z）。
const MAX_TIMESTAMP_MS = 253402300799999;
// 配列の添字の形（先頭に 0 を置かない10進の整数）。
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

/**
 * ミリ秒の時刻を、この JSON の日時の形にする。表せない値（有限でない・負・上限超え）は null。
 * ミリ秒は切り捨てる。
 * @param {unknown} ms
 * @returns {string|null}
 */
export function codexIsoTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_TIMESTAMP_MS) return null;
  return `${new Date(Math.floor(ms)).toISOString().slice(0, 19)}Z`;
}

/** この JSON の日時の形か（形だけでなく、実在する日時であることも確かめる）。 */
export function isCodexIsoTime(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return false;
  return codexIsoTime(Date.parse(value)) === value;
}

/** 口座のラベルの形か。 */
export function isCodexLabel(value) {
  return typeof value === 'string' && CODEX_LABEL_PATTERN.test(value);
}

// 検査の中で問題を見つけたときに投げる（外へは出さず、場所の文字列に替えて返す）。
class SchemaProblem extends Error {}

const fail = (where, what) => { throw new SchemaProblem(`${where} ${what}`); };

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// 決めたキーをすべて持ち、それ以外を持たないオブジェクトか。知らないキーの名前は返さない。
function exactObject(value, keys, where) {
  if (!isPlainObject(value)) fail(where, 'must be an object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail(where, 'has an unknown key');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${where}.${key}`, 'is missing');
  }
  return value;
}

function oneOf(value, allowed, where) {
  if (!allowed.includes(value)) fail(where, 'is not an allowed value');
}

function boolean(value, where) {
  if (typeof value !== 'boolean') fail(where, 'must be true or false');
}

function number(value, where, { min = -Infinity, max = Infinity, minExclusive = false, maxExclusive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'must be a finite number');
  if (minExclusive ? value <= min : value < min) fail(where, 'is below its range');
  if (maxExclusive ? value >= max : value > max) fail(where, 'is above its range');
}

function integer(value, where, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(where, 'must be an integer in its range');
}

function isoTime(value, where) {
  if (!isCodexIsoTime(value)) fail(where, 'must be a UTC time of the form YYYY-MM-DDTHH:MM:SSZ');
}

function label(value, where) {
  if (!isCodexLabel(value)) fail(where, 'must match the account label pattern');
}

// null か、check が通る値か。
function nullable(value, where, check) {
  if (value !== null) check(value, where);
}

// 配列か。欠けた要素（穴）と、添字と length の外のキーを拒否する（JSON にすると穴は null に替わり、
// 余分なキーは消えるので、送る前の値と受けた後の JSON の検査を同じにするため）。
function array(value, where) {
  if (!Array.isArray(value)) fail(where, 'must be an array');
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(`${where}[${index}]`, 'is missing');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !ARRAY_INDEX.test(key) || Number(key) >= value.length) fail(where, 'has an unknown key');
  }
  return value;
}

const PERCENT = { min: 0, max: 100 };

function checkWindow(value, where) {
  exactObject(value, ['usedPercent', 'resetAt', 'windowMinutes', 'fresh', 'observedAt', 'lengthSource'], where);
  nullable(value.usedPercent, `${where}.usedPercent`, (v, w) => number(v, w, PERCENT));
  nullable(value.resetAt, `${where}.resetAt`, isoTime);
  nullable(value.windowMinutes, `${where}.windowMinutes`, (v, w) => integer(v, w, { min: 1 }));
  boolean(value.fresh, `${where}.fresh`);
  nullable(value.observedAt, `${where}.observedAt`, isoTime);
  oneOf(value.lengthSource, CODEX_LENGTH_SOURCES, `${where}.lengthSource`);
}

function checkPolicy(value, where) {
  exactObject(value, ['stopUsedPercent', 'resumeUsedPercent', 'blockWhenUnknown'], where);
  number(value.stopUsedPercent, `${where}.stopUsedPercent`, { min: 0, max: 100, minExclusive: true });
  number(value.resumeUsedPercent, `${where}.resumeUsedPercent`,
    { min: 0, max: value.stopUsedPercent, maxExclusive: true });
  boolean(value.blockWhenUnknown, `${where}.blockWhenUnknown`);
}

function checkLatch(value, where) {
  exactObject(value, ['stopped', 'cappedWindows', 'upstreamBlocked', 'cleanReadsDone', 'cleanReadsNeeded', 'since'], where);
  boolean(value.stopped, `${where}.stopped`);
  const capped = array(value.cappedWindows, `${where}.cappedWindows`);
  capped.forEach((item, index) => oneOf(item, CODEX_WINDOW_CLASSES, `${where}.cappedWindows[${index}]`));
  if (new Set(capped).size !== capped.length) fail(`${where}.cappedWindows`, 'must not repeat a window');
  boolean(value.upstreamBlocked, `${where}.upstreamBlocked`);
  // 停止中に数えられるのは、解除の手前（必要な回数より1つ少ない）まで。
  integer(value.cleanReadsDone, `${where}.cleanReadsDone`, { min: 0, max: CODEX_CLEAN_READS_NEEDED - 1 });
  if (value.cleanReadsNeeded !== CODEX_CLEAN_READS_NEEDED) fail(`${where}.cleanReadsNeeded`, 'is not an allowed value');
  nullable(value.since, `${where}.since`, isoTime);
}

const ACCOUNT_KEYS = ['label', 'state', 'stateWord', 'selectable', 'reason', 'resetAt', 'ordinaryUsageAllowed',
  'nextObservationAt', 'policy', 'latch', 'windows', 'otherWindows', 'observedAt', 'headroomPercent'];

function checkAccount(value, where) {
  exactObject(value, ACCOUNT_KEYS, where);
  label(value.label, `${where}.label`);
  oneOf(value.stateWord, CODEX_STATE_WORDS, `${where}.stateWord`);
  oneOf(value.state, CODEX_ACCOUNT_STATES, `${where}.state`);
  if (CODEX_STATE_OF_WORD[value.stateWord] !== value.state) fail(`${where}.state`, 'does not match stateWord');
  nullable(value.selectable, `${where}.selectable`, boolean);
  nullable(value.reason, `${where}.reason`, (v, w) => oneOf(v, CODEX_ACCOUNT_REASONS, w));
  nullable(value.resetAt, `${where}.resetAt`, isoTime);
  nullable(value.ordinaryUsageAllowed, `${where}.ordinaryUsageAllowed`, boolean);
  nullable(value.nextObservationAt, `${where}.nextObservationAt`, isoTime);
  checkPolicy(value.policy, `${where}.policy`);
  nullable(value.latch, `${where}.latch`, checkLatch);
  exactObject(value.windows, ['fiveHour', 'weekly'], `${where}.windows`);
  nullable(value.windows.fiveHour, `${where}.windows.fiveHour`, checkWindow);
  nullable(value.windows.weekly, `${where}.windows.weekly`, checkWindow);
  array(value.otherWindows, `${where}.otherWindows`)
    .forEach((window, index) => checkWindow(window, `${where}.otherWindows[${index}]`));
  nullable(value.observedAt, `${where}.observedAt`, isoTime);
  nullable(value.headroomPercent, `${where}.headroomPercent`, (v, w) => number(v, w, PERCENT));
}

function checkAggregate(value, where, accountCount) {
  exactObject(value, ['effectiveRemainingPercent', 'lowerBoundPercent', 'fiveHourRemainingPercent',
    'weeklyRemainingPercent', 'accountsTotal', 'accountsAvailable', 'accountsSelectable', 'accountsUnknown', 'unit'], where);
  nullable(value.effectiveRemainingPercent, `${where}.effectiveRemainingPercent`, (v, w) => number(v, w, { min: 0 }));
  number(value.lowerBoundPercent, `${where}.lowerBoundPercent`, { min: 0 });
  nullable(value.fiveHourRemainingPercent, `${where}.fiveHourRemainingPercent`, (v, w) => number(v, w, { min: 0 }));
  nullable(value.weeklyRemainingPercent, `${where}.weeklyRemainingPercent`, (v, w) => number(v, w, { min: 0 }));
  if (value.accountsTotal !== accountCount) fail(`${where}.accountsTotal`, 'does not match the number of accounts');
  for (const key of ['accountsAvailable', 'accountsSelectable', 'accountsUnknown']) {
    integer(value[key], `${where}.${key}`, { min: 0, max: accountCount });
  }
  if (value.unit !== CODEX_AGGREGATE_UNIT) fail(`${where}.unit`, 'is not an allowed value');
}

function checkEvent(value, where) {
  exactObject(value, ['at', 'type', 'label'], where);
  isoTime(value.at, `${where}.at`);
  oneOf(value.type, CODEX_EVENT_TYPES, `${where}.type`);
  nullable(value.label, `${where}.label`, label);
}

const TOP_KEYS = ['schemaVersion', 'provider', 'enabled', 'generatedAt', 'source', 'latchKnown', 'daemon', 'pool',
  'observation', 'next', 'accounts', 'aggregate', 'events'];

function checkStatus(value) {
  exactObject(value, TOP_KEYS, 'status');
  if (value.schemaVersion !== CODEX_STATUS_SCHEMA_VERSION) fail('status.schemaVersion', 'is not an allowed value');
  if (value.provider !== CODEX_PROVIDER) fail('status.provider', 'is not an allowed value');
  boolean(value.enabled, 'status.enabled');
  isoTime(value.generatedAt, 'status.generatedAt');
  oneOf(value.source, CODEX_STATUS_SOURCES, 'status.source');
  boolean(value.latchKnown, 'status.latchKnown');

  exactObject(value.daemon, ['reachable', 'startedAt'], 'status.daemon');
  boolean(value.daemon.reachable, 'status.daemon.reachable');
  nullable(value.daemon.startedAt, 'status.daemon.startedAt', isoTime);

  exactObject(value.pool, ['state', 'resetAt'], 'status.pool');
  oneOf(value.pool.state, CODEX_POOL_STATES, 'status.pool.state');
  nullable(value.pool.resetAt, 'status.pool.resetAt', isoTime);

  const observation = exactObject(value.observation, ['method', 'startupCheck', 'accountUsageIncludesExternalClients',
    'cliConsumptionVisible', 'userAgentSource'], 'status.observation');
  if (observation.method !== CODEX_OBSERVATION_METHOD) fail('status.observation.method', 'is not an allowed value');
  nullable(observation.startupCheck, 'status.observation.startupCheck', (v, w) => oneOf(v, CODEX_STARTUP_CHECKS, w));
  boolean(observation.accountUsageIncludesExternalClients, 'status.observation.accountUsageIncludesExternalClients');
  boolean(observation.cliConsumptionVisible, 'status.observation.cliConsumptionVisible');
  nullable(observation.userAgentSource, 'status.observation.userAgentSource',
    (v, w) => oneOf(v, CODEX_USER_AGENT_SOURCES, w));

  exactObject(value.next, ['label', 'reason'], 'status.next');
  nullable(value.next.label, 'status.next.label', label);
  nullable(value.next.reason, 'status.next.reason', (v, w) => oneOf(v, CODEX_NEXT_REASONS, w));

  const accounts = array(value.accounts, 'status.accounts');
  accounts.forEach((account, index) => checkAccount(account, `status.accounts[${index}]`));
  checkAggregate(value.aggregate, 'status.aggregate', accounts.length);

  const events = array(value.events, 'status.events');
  if (events.length > CODEX_EVENTS_LIMIT) fail('status.events', 'has more entries than the limit');
  events.forEach((event, index) => checkEvent(event, `status.events[${index}]`));
}

/**
 * 状態の JSON の形を検査する。通れば null、通らなければ問題の場所の短い説明（キーの並びと
 * 問題の種類だけ。値と、知らないキーの名前は含めない）。
 * @param {unknown} value JSON.parse した値、または射影の戻り値
 * @returns {string|null}
 */
export function codexStatusProblem(value) {
  try {
    checkStatus(value);
    return null;
  } catch (error) {
    if (error instanceof SchemaProblem) return error.message;
    throw error;
  }
}

/** 状態の JSON の形として正しいか。 */
export function isValidCodexStatus(value) {
  return codexStatusProblem(value) === null;
}
