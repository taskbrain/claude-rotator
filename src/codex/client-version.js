// 使用量の読取に付ける User-Agent と originator の値を、実行時に組み立てる。
//
// 形は `<製品名の定数>/<codex --version で読んだ版> (<括弧の中の定数>)`。originator の値は製品名の定数。
// 版の固定値はコードに書かない（実行時に読む）。製品名の部分と括弧の中の部分は、下の2つの定数だけに書き、
// 2つの定数と版をつなぐのは1行だけにする。設定の usageUserAgent と usageOriginator が組であれば、
// その2つをそのまま使い、版は読まない。
//
// 版の読取:
//   - 本物の codex の絶対パス（real-codex.js）を spawn(<絶対パス>, ['--version'], { shell: false,
//     stdio: ['ignore', 'pipe', 'ignore'] }) で起動する。PATH の解決を spawn に任せず、shim も起動しない。
//   - 期限は CODEX_VERSION_READ_TIMEOUT_MS（過ぎたら子を止める）。標準出力は
//     CODEX_VERSION_MAX_STDOUT_BYTES まで読み、超えたら子を止めて読めなかったものとする。標準エラーは
//     読まずに捨てる。
//   - 版は、標準出力の1行目で最初に現れる 数字.数字.数字。直後の付記は、次の空白（か行末）までが
//     -[0-9A-Za-z.]+ の形のときだけ含める。1行目のそれ以外の部分と、2行目以降は使わない。
//   - 起動の失敗・0以外の終了・シグナル・期限切れ・読み過ぎ・版の形が無い・組み立てた値が設定と同じ
//     検査（config.js の usageUserAgent・usageOriginator の検査）を通らない、はどれも理由の語
//     codex-version-unreadable にだけ変える。エラーのメッセージと出力の中身は、戻り値・例外・ログの
//     どこにも渡さない。実行ファイルが見つからなければ codex-cli-missing。
// キャッシュ（プロセスのメモリだけに置き、ファイルへは書かない）:
//   - 読めた値は、読んだ実行ファイルの実パス・更新時刻・大きさの組と一緒に持つ。呼ばれるたびに stat で
//     比べ、同じならその値を使う（起動しない）。変わっていれば、絶対パスの決め方（shim の除外を含む）
//     からやり直してから読み直す（Codex CLI の更新に追従し、置き換わった shim は起動しない）。
//     起動に進むときは、いつも絶対パスの決め方からやり直す。
//   - 読めなかったら、その試みの始まりから取得の間隔（usagePollIntervalMs）が過ぎるまで読み直さない
//     （次の取得の周期で1回だけ読み直す。読み直しの間隔は取得の周期より短くしない）。
//   - 同時に呼ばれたら、進行中の1回を共有する（口座が何件あっても、起動は1回）。
//   - reload(config) で、絶対パスの決め方からやり直す。
// 秘密とログ:
//   - 組み立てた値と設定の値は、外へ返す前に、渡された registerSecret（ロガーの「秘密として登録した
//     値」）へ必ず渡す。
//   - ログに出すのは、値の出どころ（user_agent_source: codex-version／config）と理由の語だけで、
//     結果が変わったときにだけ1行出す。
import { spawn as spawnChild } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isValidUsageOriginator, isValidUsageUserAgent } from './config.js';
import { CODEX_CLI_MISSING, findRealCodex } from './real-codex.js';

// 製品名の部分と括弧の中の部分を書く2つの定数。書き方は `export const <名前> = '<値>';` の1行ずつ。
export const CODEX_UA_PRODUCT = 'codex_cli_rs';
export const CODEX_UA_COMMENT = 'codex-rotator';

export const CODEX_VERSION_READ_TIMEOUT_MS = 1000;
export const CODEX_VERSION_MAX_STDOUT_BYTES = 4 * 1024;
// User-Agent を作れなかった理由の語（取得処理 usage-poller.js が受け付ける2語）。
export const CLIENT_IDENTITY_REASON = Object.freeze({
  cliMissing: CODEX_CLI_MISSING,
  versionUnreadable: 'codex-version-unreadable',
});
// 値の出どころ（ログの user_agent_source と、戻り値の source）。
export const USER_AGENT_SOURCE = Object.freeze({ codexVersion: 'codex-version', config: 'config' });
export const CLIENT_IDENTITY_LOG_EVENT = 'codex_client_identity';

// 取得の間隔の既定（config.js の usagePollIntervalMs の既定と同じ）。読めなかったときの読み直しの間隔。
const DEFAULT_RETRY_INTERVAL_MS = 60000;
const VERSION_CORE = /[0-9]+\.[0-9]+\.[0-9]+/;
const VERSION_SUFFIX = /^-[0-9A-Za-z.]+$/;
const VERSION_SHAPE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?$/;
const KILL_SIGNAL = 'SIGKILL';

/**
 * 標準出力の文字列から版を取り出す。無ければ null。
 * @param {string} text
 * @returns {string|null}
 */
export function parseCodexVersion(text) {
  if (typeof text !== 'string') return null;
  const firstLine = text.split('\n', 1)[0];
  const core = VERSION_CORE.exec(firstLine);
  if (!core) return null;
  const rest = firstLine.slice(core.index + core[0].length);
  const suffix = /^\S*/.exec(rest)[0];
  return VERSION_SUFFIX.test(suffix) ? core[0] + suffix : core[0];
}

/**
 * 版から User-Agent と originator の値を組み立てる。版の形が違うか、組み立てた値が設定と同じ検査を
 * 通らなければ null（理由は返さない。呼び出し側は codex-version-unreadable にする）。
 * @param {string} version
 * @returns {{ userAgent: string, originator: string }|null}
 */
export function composeClientIdentity(version) {
  if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) return null;
  const userAgent = `${CODEX_UA_PRODUCT}/${version} (${CODEX_UA_COMMENT})`;
  const originator = CODEX_UA_PRODUCT;
  if (!isValidUsageUserAgent(userAgent) || !isValidUsageOriginator(originator)) return null;
  return { userAgent, originator };
}

/**
 * 実行ファイルを `--version` で1回起動し、版を返す。読めなければ null。例外を投げない。
 * @param {string} path 本物の codex の絶対パス
 * @param {{ spawn?: Function, scheduler?: { setTimeout: Function, clearTimeout: Function },
 *   timeoutMs?: number, maxBytes?: number }} [options]
 * @returns {Promise<string|null>}
 */
export function readCodexVersion(path, { spawn = spawnChild, scheduler = globalThis,
  timeoutMs = CODEX_VERSION_READ_TIMEOUT_MS, maxBytes = CODEX_VERSION_MAX_STDOUT_BYTES } = {}) {
  return new Promise(resolveVersion => {
    let child = null;
    let timer;
    let settled = false;
    let size = 0;
    const chunks = [];
    const finish = version => {
      if (settled) return;
      settled = true;
      try { scheduler.clearTimeout(timer); } catch { /* 期限の片付けの失敗で結果を変えない */ }
      resolveVersion(version);
    };
    const stop = () => {
      try { child?.kill?.(KILL_SIGNAL); } catch { /* 止められなくても、結果は読めなかったもの */ }
    };
    const fail = () => { stop(); finish(null); };
    try {
      child = spawn(path, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      if (typeof child?.on !== 'function' || typeof child.stdout?.on !== 'function') {
        fail();
        return;
      }
      // 起動の失敗は error の出来事で届く。中身（メッセージ）は読まない。
      child.on('error', fail);
      child.stdout.on('error', fail);
      child.stdout.on('data', chunk => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > maxBytes) {
          fail();
          return;
        }
        chunks.push(bytes);
      });
      child.on('close', (code, signal) => {
        if (code !== 0 || signal) {
          finish(null);
          return;
        }
        finish(parseCodexVersion(Buffer.concat(chunks).toString('utf8')));
      });
      timer = scheduler.setTimeout(fail, timeoutMs);
      timer?.unref?.();
    } catch {
      fail();
    }
  });
}

// 実行ファイルの実パス・更新時刻・大きさの組。変わったかどうかを比べるためだけに使い、外へ出さない。
function executableKey(path) {
  try {
    const real = realpathSync.native(path);
    const stats = statSync(real);
    if (!stats.isFile()) return null;
    return JSON.stringify([real, stats.mtimeMs, stats.size]);
  } catch {
    return null;
  }
}

// 設定の上書き（usageUserAgent と usageOriginator の組）。無ければ null、組になっていないか検査を
// 通らなければ false（版は読まず、送らない）。
function overrideOf(config) {
  const userAgent = config?.usageUserAgent ?? null;
  const originator = config?.usageOriginator ?? null;
  if (userAgent === null && originator === null) return null;
  if (!isValidUsageUserAgent(userAgent) || !isValidUsageOriginator(originator)) return false;
  return { userAgent, originator };
}

const unavailable = reason => ({ userAgent: null, originator: null, source: null, reason });

/**
 * 取得処理（usage-poller.js）の resolveClientIdentity の既定の実装。
 * @param {{
 *   env: object, config?: object|null, registerSecret: (value: string) => void, spawn?: Function,
 *   now?: () => number, scheduler?: object, platform?: string,
 *   log?: (level: string, event: string, fields: object) => void,
 * }} options env は PATH と shim の置き場所を読む元（process.env を既定値にしない）。config は検証済みの
 *   設定（codexPath・usageUserAgent・usageOriginator・usagePollIntervalMs を読む）。
 * @returns {{
 *   resolveClientIdentity: () => Promise<{ userAgent: string|null, originator: string|null,
 *     source: 'codex-version'|'config'|null, reason?: string }>,
 *   reload: (config: object|null) => void,
 * }}
 */
export function createClientIdentityResolver({ env, config = null, registerSecret, spawn = spawnChild,
  now = Date.now, scheduler = globalThis, platform = process.platform, log = () => {} } = {}) {
  if (typeof registerSecret !== 'function') throw new TypeError('registerSecret required');
  let settings;
  let generation = 0;
  let cached = null;
  let failure = null;
  let pending = null;
  let lastNote = null;

  const register = identity => {
    registerSecret(identity.userAgent);
    registerSecret(identity.originator);
  };
  // 結果が変わったときだけ1行出す。出すのは出どころと理由の語だけ。
  const note = (level, fields) => {
    const key = JSON.stringify(fields);
    if (key === lastNote) return;
    lastNote = key;
    try {
      log(level, CLIENT_IDENTITY_LOG_EVENT, fields);
    } catch {
      // ログの失敗で結果を変えない。
    }
  };
  const fail = (gen, startedAt, reason, detail = null) => {
    if (gen === generation) {
      failure = { reason, retryAt: startedAt + settings.retryMs };
      note('warn', detail === null ? { reason } : { reason, message: detail });
    }
    return unavailable(reason);
  };

  function apply(next) {
    const override = overrideOf(next);
    if (override) register(override);
    const interval = next?.usagePollIntervalMs;
    settings = { codexPath: next?.codexPath ?? null, override,
      retryMs: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_RETRY_INTERVAL_MS };
    generation++;
    cached = null;
    failure = null;
    pending = null;
    lastNote = null;
  }

  async function fromVersion(gen) {
    const startedAt = now();
    try {
      if (failure && startedAt < failure.retryAt) return unavailable(failure.reason);
      // 読めた値は、読んだ実行ファイルの実パス・更新時刻・大きさが変わっていない間だけ使う（起動しない）。
      if (cached !== null && executableKey(cached.path) === cached.key) {
        return { ...cached.identity, source: USER_AGENT_SOURCE.codexVersion };
      }
      // 起動に進むときは毎回、絶対パスの決め方（shim の除外を含む）からやり直す。読んだ後にファイルが
      // shim の中身に置き換わった・リンクの行き先が shim に変わった、というときも判定を経ずに起動しない。
      cached = null;
      const found = findRealCodex({ codexPath: settings.codexPath, env, platform });
      if (found.path === null) return fail(gen, startedAt, found.reason, found.detail);
      const key = executableKey(found.path);
      if (key === null) return fail(gen, startedAt, CODEX_CLI_MISSING);
      const version = await readCodexVersion(found.path, { spawn, scheduler });
      const identity = version === null ? null : composeClientIdentity(version);
      if (identity === null) return fail(gen, startedAt, CLIENT_IDENTITY_REASON.versionUnreadable);
      register(identity);
      if (gen === generation) {
        cached = { path: found.path, key, identity };
        failure = null;
        note('info', { user_agent_source: USER_AGENT_SOURCE.codexVersion });
      }
      return { ...identity, source: USER_AGENT_SOURCE.codexVersion };
    } catch {
      return fail(gen, startedAt, CLIENT_IDENTITY_REASON.versionUnreadable);
    }
  }

  function resolveClientIdentity() {
    const { override } = settings;
    if (override === false) {
      // 検証済みの設定では起きない（片方だけの指定は設定の読込で拒否する）。送らない側に倒す。
      note('warn', { reason: CLIENT_IDENTITY_REASON.versionUnreadable });
      return Promise.resolve(unavailable(CLIENT_IDENTITY_REASON.versionUnreadable));
    }
    if (override) {
      note('info', { user_agent_source: USER_AGENT_SOURCE.config });
      return Promise.resolve({ ...override, source: USER_AGENT_SOURCE.config });
    }
    if (pending === null) {
      const run = fromVersion(generation);
      pending = run;
      run.then(() => { if (pending === run) pending = null; });
    }
    return pending.then(result => ({ ...result }));
  }

  apply(config);
  return {
    resolveClientIdentity,
    // 設定を入れ替え、キャッシュを捨てて、絶対パスの決め方からやり直す。
    reload: next => apply(next),
  };
}
