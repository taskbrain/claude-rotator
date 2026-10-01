// codex-rotator の設定ファイル（$XDG_CONFIG_HOME/codex-rotator/config.json）の読込と検証。
//
// 方針:
//   - 知らないキーは、最上位・daemon・口座・usagePolicy のどの階層でも拒否する（書き損じた
//     設定が黙って既定値で動くのを防ぐ）。ほかのモジュールでだけ使うキーもここで全部定義する。
//   - 使用量は常に usage GET（http）で読む。観測方式を選ぶキー usageObservationMode は無い。
//   - 既定値を補うのはこのファイルだけ。とくに daemon.port の既定値 37892 は、ここで1回だけ
//     補う。接続先の URL を作る側は既定値を持たず、0・未定義を受け取ったら拒否する。
//   - 例外のメッセージには、設定の値（パス・User-Agent・originator・ラベルの候補）を入れない。
//     どのキーが悪いかだけを言う（例外はログや標準エラーへ出うるため）。
//   - パスの重なりは、存在する祖先まで実パスに直して比べる（シンボリックリンクの別名で
//     ~/.codex や他の口座を指す形を見逃さないため）。macOS（darwin）のディスクは大文字小文字と
//     Unicode の正規化形を区別しないので、比べる前にそろえる。validateCodexConfig が読むのは
//     パスの情報だけで、中身は開かない。
//   - loadCodexConfig は、設定ファイルとその親フォルダが自分だけのものであること、既にある
//     accountsDir が自分だけのフォルダであることも確かめる（fsguard.js）。
//   - loadCodexConfigSnapshot は、1回の読込みで得た文字列から、解析の結果とその sha256 を一緒に
//     返す（設定の世代を照らす側が、別の読込みで求めた値を混ぜないため）。
//   - 設定を書き換えるのは appendCodexAccount（口座の追記と、ファイルが無いときの初回の作成）と
//     removeCodexAccount（登録を外す）だけ。どちらも同じフォルダの一時ファイルに書いてから名前を
//     付け替えるので、途中で失敗しても元のファイルの中身と更新時刻は変わらない。
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ensureDirectoryDurable } from '../json-file.js';
import { FSGUARD_REASON, FsGuardError, assertPrivateDirectory, readPrivateFile } from './fsguard.js';
import {
  CodexPathsError, DEFAULT_ACCOUNTS_DIR, codexRotatorConfigPath, defaultCodexHome, expandHomePath, shimDir,
} from './paths.js';

// 常駐の待受ポートの既定値。Claude 側の待受とも、OpenAI ブリッジ（設定 openaiBridge）の既定とも違う番号にする。
export const DEFAULT_DAEMON_PORT = 37892;
// 口座のラベル。表示・JSON・ログで口座を指すのはこのラベルだけである。
export const CODEX_ACCOUNT_LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const USAGE_USER_AGENT_MAX_LENGTH = 256;
export const USAGE_ORIGINATOR_MAX_LENGTH = 64;
// 設定ファイルの大きさの上限（口座が多くても十分に収まる）。
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

// 時間の既定値。有効期限の既定値 125000 は、下の下限（取得の間隔2回分＋読取の期限1回分）を
// 既定値どうしで満たす最小の値である。
export const CODEX_CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  acknowledgedMultiAccountRisk: false,
  accountsDir: DEFAULT_ACCOUNTS_DIR,
  daemonPort: DEFAULT_DAEMON_PORT,
  usagePollIntervalMs: 60000,
  usageReadTimeoutMs: 5000,
  rotationObservationTtlMs: 125000,
  rotationUsageCapNoResetProbeMs: 3600000,
});

const TIMING_RANGES = Object.freeze({
  usagePollIntervalMs: [30000, 3600000],
  usageReadTimeoutMs: [1000, 15000],
  rotationObservationTtlMs: [1000, 86400000],
});
// 0 は「リセット時刻の記録が無い窓の停止を、時間の条件では外さない」。それ以外は範囲内。
const NO_RESET_PROBE_RANGE = Object.freeze([60000, 604800000]);

const TOP_LEVEL_KEYS = new Set(['enabled', 'acknowledgedMultiAccountRisk', 'accountsDir', 'daemon',
  'usagePollIntervalMs', 'usageReadTimeoutMs', 'rotationObservationTtlMs', 'rotationUsageCapNoResetProbeMs',
  'codexPath', 'usageUserAgent', 'usageOriginator', 'accounts']);
const DAEMON_KEYS = new Set(['port']);
const ACCOUNT_KEYS = new Set(['label', 'codexHome', 'usagePolicy']);
const USAGE_POLICY_KEYS = new Set(['stopUsedPercent', 'resumeUsedPercent', 'blockWhenUnknown']);

export class CodexConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexConfigError';
  }
}

// 知らないキーの名前は、識別子の形のときだけ例外のメッセージに入れる。
const PRINTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(value, allowed, where) {
  if (!isPlainObject(value)) throw new CodexConfigError(`${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CodexConfigError(`${where} has an unknown key: ${PRINTABLE_KEY.test(key) ? key : '(unprintable)'}`);
    }
  }
}

function optionalBoolean(value, fallback, where) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new CodexConfigError(`${where} must be true or false`);
  return value;
}

function integerInRange(value, [min, max], where) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CodexConfigError(`${where} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** 観測の有効期限の下限。取得が1回失敗しても、次の取得と読取の期限まで観測が古くならない長さ。 */
export function minimumObservationTtlMs({ usagePollIntervalMs, usageReadTimeoutMs }) {
  return 2 * usagePollIntervalMs + usageReadTimeoutMs;
}

function validateTiming(raw) {
  const timing = {};
  for (const [key, range] of Object.entries(TIMING_RANGES)) {
    timing[key] = raw[key] === undefined ? CODEX_CONFIG_DEFAULTS[key] : integerInRange(raw[key], range, key);
  }
  const probe = raw.rotationUsageCapNoResetProbeMs === undefined
    ? CODEX_CONFIG_DEFAULTS.rotationUsageCapNoResetProbeMs
    : raw.rotationUsageCapNoResetProbeMs;
  const [probeMin, probeMax] = NO_RESET_PROBE_RANGE;
  if (probe !== 0 && (!Number.isInteger(probe) || probe < probeMin || probe > probeMax)) {
    throw new CodexConfigError(`rotationUsageCapNoResetProbeMs must be 0 or an integer between ${probeMin} and ${probeMax}`);
  }
  timing.rotationUsageCapNoResetProbeMs = probe;
  // 観測方式は http に固定なので、この下限の検査は常に掛かり、外す設定も引数も無い。
  const minimum = minimumObservationTtlMs(timing);
  if (timing.rotationObservationTtlMs < minimum) {
    throw new CodexConfigError(`rotationObservationTtlMs must be at least ${minimum} (2 x usagePollIntervalMs + usageReadTimeoutMs)`);
  }
  return timing;
}

function validateDaemon(rawDaemon) {
  if (rawDaemon === undefined) return { port: DEFAULT_DAEMON_PORT };
  assertKnownKeys(rawDaemon, DAEMON_KEYS, 'daemon');
  // 0 は「空いている番号を OS に選ばせる」（テストの待受）。接続先の URL は 0 から作れない。
  const port = rawDaemon.port === undefined ? DEFAULT_DAEMON_PORT : integerInRange(rawDaemon.port, [0, 65535], 'daemon.port');
  return { port };
}

/**
 * User-Agent・originator の値として使えない理由を返す。使えるなら null。値そのものは返さない。
 * 条件: 文字列・1〜maxLength 文字・表示可能な ASCII（0x20〜0x7E）だけ・前後に空白が無い
 * （空白だけの値もここで落ちる）。Codex CLI の版から組み立てた値（client-version.js）にも
 * 同じ検査を当てる。
 */
export function usageHeaderValueProblem(value, maxLength) {
  if (typeof value !== 'string') return 'must be a string';
  if (value.length < 1 || value.length > maxLength) return `must be 1 to ${maxLength} characters long`;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return 'must contain only printable ASCII characters';
  }
  if (value.trim() !== value) return 'must not start or end with a space';
  return null;
}

export const isValidUsageUserAgent = value => usageHeaderValueProblem(value, USAGE_USER_AGENT_MAX_LENGTH) === null;
export const isValidUsageOriginator = value => usageHeaderValueProblem(value, USAGE_ORIGINATOR_MAX_LENGTH) === null;

function validateUsageIdentity(raw) {
  const hasUserAgent = raw.usageUserAgent !== undefined;
  const hasOriginator = raw.usageOriginator !== undefined;
  if (hasUserAgent !== hasOriginator) {
    throw new CodexConfigError('usageUserAgent and usageOriginator must be set together or both omitted');
  }
  if (!hasUserAgent) return { usageUserAgent: null, usageOriginator: null };
  const userAgentProblem = usageHeaderValueProblem(raw.usageUserAgent, USAGE_USER_AGENT_MAX_LENGTH);
  if (userAgentProblem) throw new CodexConfigError(`usageUserAgent ${userAgentProblem}`);
  const originatorProblem = usageHeaderValueProblem(raw.usageOriginator, USAGE_ORIGINATOR_MAX_LENGTH);
  if (originatorProblem) throw new CodexConfigError(`usageOriginator ${originatorProblem}`);
  return { usageUserAgent: raw.usageUserAgent, usageOriginator: raw.usageOriginator };
}

function isInside(child, parent) {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

/** child が parent と同じか、parent の中にあるか。 */
export function isSameOrInside(child, parent) {
  return child === parent || isInside(child, parent);
}

/** 2つのパスが同じ・どちらかがもう一方を含む・どちらかがファイルシステムの根、のどれか。 */
export function pathsOverlap(a, b) {
  return isSameOrInside(a, b) || isSameOrInside(b, a) || a === parse(a).root || b === parse(b).root;
}

/**
 * 比べるための形。darwin のディスクは大文字小文字と正規化形を区別しないので、そろえる。
 * まだ存在しない部分は実パスに直せず、書いたとおりの大文字小文字が残るため、ここでそろえる。
 * @param {string} path canonicalPath が返した実パス
 * @param {string} [platform]
 */
export function comparisonKey(path, platform = process.platform) {
  return platform === 'darwin' ? path.normalize('NFC').toLowerCase() : path;
}

// 存在する祖先まで実パスに直す。まだ無い部分はそのままつなぐ。行き先の無いシンボリック
// リンクは、どこを指すか確かめられないので拒否する。
function resolveCanonical(absolutePath, where, fsImpl) {
  try {
    return fsImpl.realpath(absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new CodexConfigError(`${where} cannot be resolved`);
    if (isDanglingLink(absolutePath, fsImpl)) throw new CodexConfigError(`${where} cannot be resolved`);
    const parent = dirname(absolutePath);
    if (parent === absolutePath) throw new CodexConfigError(`${where} cannot be resolved`);
    return join(resolveCanonical(parent, where, fsImpl), basename(absolutePath));
  }
}

/**
 * 絶対パスを、存在しない部分があっても実パスに直す（重なりの検査が使うのと同じ求め方）。
 * 存在する祖先までを実パスに直し、まだ無い部分はそのままつなぐ。行き先の無いシンボリック
 * リンク・相対パスは CodexConfigError（メッセージにはパスを入れず、where だけを入れる）。
 * 比べるときは、返した値を comparisonKey でそろえる。
 * @param {string} absolutePath
 * @param {{ where?: string, realpathImpl?: Function, lstatImpl?: Function }} [options]
 * @returns {string}
 */
export function canonicalPath(absolutePath, {
  where = 'the path', realpathImpl = realpathSync.native, lstatImpl = lstatSync,
} = {}) {
  if (typeof absolutePath !== 'string' || absolutePath.includes('\0') || !isAbsolute(absolutePath)) {
    throw new CodexConfigError(`${where} must be an absolute path`);
  }
  return resolveCanonical(resolve(absolutePath), where, { realpath: realpathImpl, lstat: lstatImpl });
}

function isDanglingLink(path, fsImpl) {
  try {
    return fsImpl.lstat(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// 絶対パスか `~/` で始まるパスだけを受ける（allowHome が偽なら絶対パスだけ）。返す path は ~ を
// 展開して正規化した絶対パス（末尾の / なし）、canonical は重なりの比較に使う形（実パスを
// comparisonKey でそろえたもの）。
function pathSetting(value, where, context, { allowHome = true } = {}) {
  const shapeOk = typeof value === 'string' && !value.includes('\0')
    && (isAbsolute(value) || (allowHome && value.startsWith('~/')));
  if (!shapeOk) {
    throw new CodexConfigError(allowHome
      ? `${where} must be an absolute path or start with ~/`
      : `${where} must be an absolute path (a path starting with ~/ is not accepted)`);
  }
  const path = resolve(expandHomePath(value, context.env));
  return { path, canonical: comparisonKey(resolveCanonical(path, where, context.fsImpl), context.platform) };
}

function validateAccountsDir(rawValue, context) {
  const dir = pathSetting(rawValue === undefined ? DEFAULT_ACCOUNTS_DIR : rawValue, 'accountsDir', context);
  if (pathsOverlap(dir.canonical, context.defaultCodexHome)) {
    throw new CodexConfigError('accountsDir must be separate from ~/.codex (neither inside it nor containing it)');
  }
  return dir;
}

function validateUsagePolicy(policy, where) {
  // 口座の選択は方針で決めるので、方針の無い口座は置けない。
  if (policy === undefined) throw new CodexConfigError(`${where} is required for every account`);
  assertKnownKeys(policy, USAGE_POLICY_KEYS, where);
  const { stopUsedPercent: stop, resumeUsedPercent: resume } = policy;
  if (typeof stop !== 'number' || !Number.isFinite(stop) || stop <= 0 || stop > 100) {
    throw new CodexConfigError(`${where}.stopUsedPercent must be a number greater than 0 and at most 100`);
  }
  if (typeof resume !== 'number' || !Number.isFinite(resume) || resume < 0 || resume >= stop) {
    throw new CodexConfigError(`${where}.resumeUsedPercent must be a number from 0 up to, but not including, stopUsedPercent`);
  }
  // 省略は false。文字列や数値を真偽として読まない（書き損じで口座が送れる側に倒れないように）。
  const blockWhenUnknown = optionalBoolean(policy.blockWhenUnknown, false, `${where}.blockWhenUnknown`);
  return { stopUsedPercent: stop, resumeUsedPercent: resume, blockWhenUnknown };
}

// 返すのは、正規化した口座の並びと、各口座のフォルダの比較用の形（codexPath の検査に使う）。
function validateAccounts(rawAccounts, accountsDir, context) {
  if (rawAccounts === undefined) return { accounts: [], homes: [] };
  if (!Array.isArray(rawAccounts)) throw new CodexConfigError('accounts must be an array');
  const labels = new Set();
  const homes = [];
  const accounts = rawAccounts.map((account, index) => {
    const where = `accounts[${index}]`;
    assertKnownKeys(account, ACCOUNT_KEYS, where);
    if (typeof account.label !== 'string' || !CODEX_ACCOUNT_LABEL.test(account.label)) {
      throw new CodexConfigError(`${where}.label must be 1 to 32 characters of a-z, 0-9, _ and -, starting with a-z or 0-9`);
    }
    if (labels.has(account.label)) throw new CodexConfigError(`${where}.label is used by another account`);
    labels.add(account.label);
    // 口座のフォルダは絶対パスだけ。~ はこの設定を読むプロセスの HOME で展開されるので、`~/` の形だと
    // HOME の違うプロセス（常駐とシェルなど）が、同じ設定から別のフォルダを求めうる。
    const home = pathSetting(account.codexHome, `${where}.codexHome`, context, { allowHome: false });
    // ~/.codex は口座の外。その中・それを含む場所も口座にしない。
    if (pathsOverlap(home.canonical, context.defaultCodexHome)) {
      throw new CodexConfigError(`${where}.codexHome must be separate from ~/.codex (neither inside it nor containing it)`);
    }
    if (homes.some(other => pathsOverlap(other, home.canonical))) {
      throw new CodexConfigError(`${where}.codexHome overlaps the codexHome of another account`);
    }
    homes.push(home.canonical);
    // 口座のフォルダは accountsDir の中に置けるが、accountsDir を口座のフォルダの中には置けない。
    if (isSameOrInside(accountsDir.canonical, home.canonical)) {
      throw new CodexConfigError(`accountsDir must not be the same as or inside ${where}.codexHome`);
    }
    const usagePolicy = validateUsagePolicy(account.usagePolicy, `${where}.usagePolicy`);
    return { label: account.label, codexHome: home.path, usagePolicy };
  });
  return { accounts, homes };
}

function validateCodexPath(rawValue, accountsDir, accountHomes, context) {
  if (rawValue === undefined) return null;
  // 口座のフォルダと同じ理由で、絶対パスだけ（読むプロセスによって別の実行ファイルを指さないように）。
  const codexPath = pathSetting(rawValue, 'codexPath', context, { allowHome: false });
  if (isSameOrInside(codexPath.canonical, accountsDir.canonical)) {
    throw new CodexConfigError('codexPath must not point inside accountsDir');
  }
  // accountsDir の外に置いた口座のフォルダも、実行するファイルの置き場所にしない。
  if (accountHomes.some(home => isSameOrInside(codexPath.canonical, home))) {
    throw new CodexConfigError('codexPath must not point inside an account folder');
  }
  if (isSameOrInside(codexPath.canonical, context.shimDir)) {
    throw new CodexConfigError('codexPath must not point inside the codex-rotator shim directory');
  }
  return codexPath.path;
}

function fromEnv(read) {
  try {
    return read();
  } catch (error) {
    if (error instanceof CodexPathsError) throw new CodexConfigError(error.message);
    throw error;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * 生の設定を検証し、既定値を補った設定を返す（凍結済み）。不正なら CodexConfigError。
 * パスの情報だけを見る同期の検査で、フォルダの権限は見ない（それは loadCodexConfig）。
 * @param {unknown} raw JSON.parse した設定
 * @param {{ env: object, platform?: string, realpathImpl?: Function, lstatImpl?: Function }} options
 *   env は HOME と XDG_* を読む元（~ の展開・~/.codex・shim の置き場所）。platform は比べ方を
 *   決める（darwin なら大文字小文字をそろえる）。
 */
export function validateCodexConfig(raw, {
  env, platform = process.platform, realpathImpl = realpathSync.native, lstatImpl = lstatSync,
} = {}) {
  if (isPlainObject(raw) && Object.hasOwn(raw, 'usageObservationMode')) {
    throw new CodexConfigError('usageObservationMode is not a setting: usage is always read over http');
  }
  assertKnownKeys(raw, TOP_LEVEL_KEYS, 'config');
  const enabled = optionalBoolean(raw.enabled, false, 'enabled');
  const acknowledgedMultiAccountRisk = optionalBoolean(raw.acknowledgedMultiAccountRisk, false, 'acknowledgedMultiAccountRisk');
  const daemon = validateDaemon(raw.daemon);
  const timing = validateTiming(raw);
  const usageIdentity = validateUsageIdentity(raw);
  const fsImpl = { realpath: realpathImpl, lstat: lstatImpl };
  const context = fromEnv(() => ({
    env,
    fsImpl,
    platform,
    defaultCodexHome: comparisonKey(resolveCanonical(defaultCodexHome(env), '~/.codex', fsImpl), platform),
    shimDir: comparisonKey(resolveCanonical(shimDir(env), 'the shim directory', fsImpl), platform),
  }));
  const accountsDir = fromEnv(() => validateAccountsDir(raw.accountsDir, context));
  const { accounts, homes } = fromEnv(() => validateAccounts(raw.accounts, accountsDir, context));
  const codexPath = fromEnv(() => validateCodexPath(raw.codexPath, accountsDir, homes, context));
  return deepFreeze({
    enabled,
    acknowledgedMultiAccountRisk,
    accountsDir: accountsDir.path,
    daemon,
    ...timing,
    codexPath,
    ...usageIdentity,
    accounts,
  });
}

// fsguard の拒否を設定の拒否に替える（メッセージはパスを含まない fsguard のものをそのまま使う）。
async function guarded(check) {
  try {
    return await check();
  } catch (error) {
    if (error instanceof FsGuardError) throw new CodexConfigError(error.message);
    throw error;
  }
}

/**
 * env の置き場所から設定ファイルを読み、検証して返す。ファイルが無いときだけ null を返す
 * （ファイルは作らない）。次のときは CodexConfigError（中身とパスはメッセージに入れない）:
 *   - 設定ファイルが自分だけのものでない（シンボリックリンク・通常のファイルでない・所有者が
 *     違う・0600 より広い）、または親フォルダが自分だけのフォルダでない（0700 より広いなど）
 *   - 読めない・JSON でない・validateCodexConfig を通らない
 *   - accountsDir が既にあり、自分だけのフォルダでない（リンクも拒否する）。無ければ通す
 * @param {{ env: object, openImpl?: Function, platform?: string, realpathImpl?: Function, lstatImpl?: Function }} options
 */
export async function loadCodexConfig(options = {}) {
  return (await readConfigSnapshot(options))?.config ?? null;
}

/** 設定の sha256 の形（64桁の小文字の16進）。 */
export const CONFIG_SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CONFIG_FILE_WHAT = 'the codex-rotator config file';
const CONFIG_FOLDER_WHAT = 'the codex-rotator config folder';
const CONFIG_CHANGED = 'the codex-rotator config file changed since it was read; nothing was written';
const CONFIG_EXISTS = 'the codex-rotator config file already exists; nothing was written';
const CONFIG_NOT_WRITTEN = 'the codex-rotator config file could not be written; the original is unchanged';

// 読んだ文字列を utf8 で符号化したバイト列の sha256。正しい utf8 のファイルなら、ファイルの
// バイト列の sha256 と同じ値になる。
function textSha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// 設定ファイルを1回読む。無ければ null。
async function readConfigText(path, openImpl) {
  try {
    return await readPrivateFile(path, { what: CONFIG_FILE_WHAT, maxBytes: CONFIG_FILE_MAX_BYTES, openImpl });
  } catch (error) {
    if (error instanceof FsGuardError && error.reason === FSGUARD_REASON.missing) return null;
    if (error instanceof FsGuardError) throw new CodexConfigError(error.message);
    throw error;
  }
}

// 1回の読込みで、sha256・生の値・検証した設定を同じ文字列から作る。ファイルが無ければ null。
async function readConfigSnapshot({ env, openImpl, ...validateOptions } = {}) {
  const path = fromEnv(() => codexRotatorConfigPath(env));
  const text = await readConfigText(path, openImpl);
  if (text === null) return null;
  await guarded(() => assertPrivateDirectory(dirname(path), { what: CONFIG_FOLDER_WHAT }));
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CodexConfigError('the codex-rotator config file is not valid JSON');
  }
  const config = validateCodexConfig(raw, { env, ...validateOptions });
  await guarded(async () => {
    try {
      await assertPrivateDirectory(config.accountsDir, { what: 'accountsDir' });
    } catch (error) {
      if (!(error instanceof FsGuardError && error.reason === FSGUARD_REASON.missing)) throw error;
    }
  });
  return { path, raw, config, sha256: textSha256(text) };
}

/**
 * loadCodexConfig と同じ検査で設定を読み、解析の結果と、その解析に使ったのと同じ1回の読込みの
 * 中身の sha256 を一緒に返す。ファイルが無いときだけ null。拒否の条件は loadCodexConfig と同じ。
 * @param {{ env: object, openImpl?: Function, platform?: string, realpathImpl?: Function, lstatImpl?: Function }} options
 * @returns {Promise<{ config: object, sha256: string }|null>} sha256 は64桁の小文字の16進
 */
export async function loadCodexConfigSnapshot(options = {}) {
  const snapshot = await readConfigSnapshot(options);
  return snapshot && Object.freeze({ config: snapshot.config, sha256: snapshot.sha256 });
}

function serializeConfig(raw) {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

// 同じフォルダに 0600 の一時ファイルを新しく作って書き、ディスクへ書き出してから閉じる。
async function writeTempFile(path, text, fileOps) {
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await (fileOps.open ?? open)(tempPath, 'wx', 0o600);
    await handle.writeFile(text);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    return tempPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await (fileOps.unlink ?? unlink)(tempPath).catch(() => {});
    throw error;
  }
}

// 名前を付けた後のフォルダの書き出し。名前の付け替えは済んで見える中身は変わっているので、
// ここでの失敗（フォルダの書き出しを扱えないファイルシステムなど）で「書けなかった」とは言わない。
async function syncFolderAfterCommit(folder, fileOps) {
  let handle;
  try {
    handle = await (fileOps.open ?? open)(folder, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // 書込みの結果は変えない。
  } finally {
    await handle?.close().catch(() => {});
  }
}

// 読んだ時点の中身（snapshot）を nextRaw で置き換える。検証を通らない中身は書かない。置き換える
// 直前にもう一度読み、読んだ時点から中身が変わっていたら書かない（別の書き手の変更を消さない）。
async function replaceConfigFile(snapshot, nextRaw, { env, openImpl, fileOps, validateOptions }) {
  const config = validateCodexConfig(nextRaw, { env, ...validateOptions });
  const text = serializeConfig(nextRaw);
  let tempPath = null;
  try {
    tempPath = await writeTempFile(snapshot.path, text, fileOps);
    const current = await readConfigText(snapshot.path, openImpl);
    if (current === null || textSha256(current) !== snapshot.sha256) throw new CodexConfigError(CONFIG_CHANGED);
    await (fileOps.rename ?? rename)(tempPath, snapshot.path);
    tempPath = null;
  } catch (error) {
    if (error instanceof CodexConfigError) throw error;
    throw new CodexConfigError(CONFIG_NOT_WRITTEN);
  } finally {
    if (tempPath !== null) await (fileOps.unlink ?? unlink)(tempPath).catch(() => {});
  }
  await syncFolderAfterCommit(dirname(snapshot.path), fileOps);
  return Object.freeze({ config, sha256: textSha256(text) });
}

// 設定ファイルが無いときの初回の作成。2つのゲートは偽で作る（真にするのは利用者が手で行う）。
// フォルダは 0700 で作り、既にあれば自分だけのフォルダであることを確かめる（広げも狭めもしない）。
// 名前は link で付ける（既にファイルがあれば失敗する。rename は黙って置き換えるので使わない）。
async function createConfigFile(account, { env, fileOps, validateOptions }) {
  const path = fromEnv(() => codexRotatorConfigPath(env));
  const raw = { enabled: false, acknowledgedMultiAccountRisk: false, accounts: [account] };
  const config = validateCodexConfig(raw, { env, ...validateOptions });
  const text = serializeConfig(raw);
  const folder = dirname(path);
  try {
    await ensureDirectoryDurable(folder, 0o700, fileOps);
  } catch {
    throw new CodexConfigError('the codex-rotator config folder could not be created; nothing was written');
  }
  await guarded(() => assertPrivateDirectory(folder, { what: CONFIG_FOLDER_WHAT }));
  let tempPath = null;
  try {
    tempPath = await writeTempFile(path, text, fileOps);
    try {
      await (fileOps.link ?? link)(tempPath, path);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new CodexConfigError(CONFIG_EXISTS);
      throw error;
    }
  } catch (error) {
    if (error instanceof CodexConfigError) throw error;
    throw new CodexConfigError('the codex-rotator config file could not be written; nothing was created');
  } finally {
    // link の後は同じ中身への2つ目の名前なので、消せなくても設定は作れている。
    if (tempPath !== null) await (fileOps.unlink ?? unlink)(tempPath).catch(() => {});
  }
  await syncFolderAfterCommit(folder, fileOps);
  return Object.freeze({ config, sha256: textSha256(text) });
}

function assertExpectedSha256(value) {
  if (value !== null && !(typeof value === 'string' && CONFIG_SHA256_PATTERN.test(value))) {
    throw new CodexConfigError('expectedSha256 must be null or 64 lowercase hexadecimal digits');
  }
}

/**
 * 口座を1件、設定の末尾に追記する。expectedSha256 は、呼び出し側が先に loadCodexConfigSnapshot で
 * 読んだときの sha256（そのときファイルが無かったなら null）。今のファイルがそれと違えば
 * （null のときはファイルがあれば）何も書かずに CodexConfigError。
 *   - ファイルがあるとき: 追記した設定が検証を通るときだけ（usagePolicy が無い・ラベルやフォルダが
 *     ほかの口座と重なる口座は、書く前に拒否する）、同じフォルダの 0600 の一時ファイルに書いて
 *     rename で置き換える。rename までに失敗しても、元のファイルの中身と更新時刻は変わらない。
 *   - ファイルが無いとき: enabled と acknowledgedMultiAccountRisk を偽、口座をこの1件にした設定を、
 *     フォルダ 0700・ファイル 0600 で作る。
 * 書き直したファイルは JSON を2字下げで並べ直したものになる（キーと値は変えない）。
 * @param {{ env: object, account: object, expectedSha256: string|null, openImpl?: Function,
 *   fileOps?: { open?: Function, rename?: Function, link?: Function, unlink?: Function, mkdir?: Function },
 *   platform?: string, realpathImpl?: Function, lstatImpl?: Function }} options
 * @returns {Promise<{ config: object, sha256: string }>} 書いた後の設定と、書いた中身の sha256
 */
export async function appendCodexAccount({ env, account, expectedSha256, openImpl, fileOps = {}, ...validateOptions } = {}) {
  assertExpectedSha256(expectedSha256);
  if (expectedSha256 === null) {
    const path = fromEnv(() => codexRotatorConfigPath(env));
    if (await readConfigText(path, openImpl) !== null) throw new CodexConfigError(CONFIG_EXISTS);
    return createConfigFile(account, { env, fileOps, validateOptions });
  }
  const snapshot = await readConfigSnapshot({ env, openImpl, ...validateOptions });
  if (snapshot === null || snapshot.sha256 !== expectedSha256) throw new CodexConfigError(CONFIG_CHANGED);
  const nextRaw = { ...snapshot.raw, accounts: [...(snapshot.raw.accounts ?? []), account] };
  return replaceConfigFile(snapshot, nextRaw, { env, openImpl, fileOps, validateOptions });
}

/**
 * そのラベルの口座を設定から外す（口座のフォルダは消さない）。書き方は appendCodexAccount の
 * 置き換えと同じで、読んでから置き換えるまでに中身が変わったとき・rename までに失敗したときは、
 * 元のファイルを変えずに CodexConfigError。
 * @param {{ env: object, label: string, openImpl?: Function,
 *   fileOps?: { open?: Function, rename?: Function, unlink?: Function },
 *   platform?: string, realpathImpl?: Function, lstatImpl?: Function }} options
 * @returns {Promise<{ removed: boolean, config: object|null, sha256: string|null }>}
 *   removed はそのラベルを外して書いたとき true。ファイルが無い・ラベルが無いときは何も書かずに
 *   false（config と sha256 は今のファイルのもの。ファイルが無ければ null）。
 */
export async function removeCodexAccount({ env, label, openImpl, fileOps = {}, ...validateOptions } = {}) {
  if (typeof label !== 'string' || !CODEX_ACCOUNT_LABEL.test(label)) {
    throw new CodexConfigError('label must be 1 to 32 characters of a-z, 0-9, _ and -, starting with a-z or 0-9');
  }
  const snapshot = await readConfigSnapshot({ env, openImpl, ...validateOptions });
  if (snapshot === null) return Object.freeze({ removed: false, config: null, sha256: null });
  const accounts = snapshot.raw.accounts ?? [];
  const kept = accounts.filter(account => account.label !== label);
  if (kept.length === accounts.length) {
    return Object.freeze({ removed: false, config: snapshot.config, sha256: snapshot.sha256 });
  }
  const result = await replaceConfigFile(snapshot, { ...snapshot.raw, accounts: kept }, { env, openImpl, fileOps, validateOptions });
  return Object.freeze({ removed: true, ...result });
}

/** 有効化の二重ゲート: enabled と多口座のリスク承認の両方が true のときだけ動かす。 */
export function isCodexRotatorActivated(config) {
  return config?.enabled === true && config?.acknowledgedMultiAccountRisk === true;
}

/** ロガーへ「秘密として登録する値」として渡す設定の値（User-Agent と originator の上書き）。 */
export function configSecretValues(config) {
  return [config?.usageUserAgent, config?.usageOriginator].filter(value => typeof value === 'string' && value.length > 0);
}
