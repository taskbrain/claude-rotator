// usage-events-YYYYMMDD.jsonl: 上流へ送った要求1回ごとに、使用量イベントを1行追記する。
//
// 読み手は同じホストで動く別の集計プロセスで、`eventId` で重複を除いてから
// アカウント別のコストを出す。行の形（キー名・`usage` の5項目）は集計側の取込処理が
// 検査するので、ここを変えるときは集計側も合わせて変えること。
//
// 設計上の一線:
// - **許可リスト方式。** 要求・応答の本文、ヘッダ、資格情報は一切書かない。
// - **転送は止めない（fail-open）、失敗は必ずログに残す（fail-loud）。** 追記の失敗は
//   ログへ1行書いて握りつぶし、転送・口座の切り替えへは波及させない。
// - **ファイルは UTC の日付ごとに分ける。** 日付は、直列キューがその行を書く直前の時刻で
//   決める（イベントの `ts` では決めない）。書き手は日付名へ直接書き、旧名
//   `usage-events.jsonl` は最後に書いた日の日付名を指すシンボリックリンクとして残す（旧い版の
//   書き手のため）。旧名が通常ファイルのときは、ハードリンクで日付名へ移す（中身は
//   コピーしない）。名前の日付が保持期限を過ぎた日付名は、1回に最大2本まで消す。
// - 移行・リンクの張り替え・期限切れの削除は、書く日付が変わったとき（起動後の最初の
//   書込を含む）にだけ行う。失敗してもログを1行出すだけで、次にその時機が来たら
//   もう一度試みる。肥大化は `sizeWarnBytes` を超えたときにログで知らせるだけにとどめる。

import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile, chmod, link, lstat, mkdir, open, readdir, readlink, rename, stat, symlink, unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { appConfigDir, expandHome } from './paths.js';

export const USAGE_EVENTS_FILENAME = 'usage-events.jsonl';
export const USAGE_EVENTS_DIR_ENV = 'CLAUDE_ROTATOR_USAGE_EVENTS_DIR';
export const DEFAULT_SIZE_WARN_BYTES = 500 * 1024 * 1024;
export const DEFAULT_SIZE_CHECK_EVERY = 1000;
export const DEFAULT_WARN_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_PENDING = 10000;
export const DEFAULT_RETENTION_DAYS = 14;
export const MIN_RETENTION_DAYS = 8;

// 日付名の型。保持期限の削除も、移行の途中で止まった実体を探すのも、この型に厳密に合う名前だけ。
const DAILY_NAME = /^usage-events-([0-9]{8})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// 同名の日付名が既にあるとき、移行先を前日へさかのぼってよい日数（当日−13日まで）。
const MIGRATE_LOOKBACK_DAYS = 13;
// 時計が一時的に大きく未来へ進んでも消し過ぎないよう、1回の削除は古いほうから2本まで。
const MAX_PRUNE_PER_RUN = 2;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
}

// 8桁が実在する UTC の日付なら、その日の 0時（ms）。そうでなければ null。
function utcDayStart(day) {
  const match = /^([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(day);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return utcDay(ms) === day ? ms : null;
}

function shiftDay(day, days) {
  return utcDay(utcDayStart(day) + days * DAY_MS);
}

function dailyFileName(day) {
  return `usage-events-${day}.jsonl`;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * 出力先ディレクトリ。既定は `<appConfigDir>/usage-events`（通常は
 * `~/.config/claude-rotator/usage-events`）で、`CLAUDE_ROTATOR_USAGE_EVENTS_DIR` で上書きできる。
 */
export function usageEventsDir(env = process.env, home = homedir()) {
  const override = env[USAGE_EVENTS_DIR_ENV];
  if (override) return expandHome(override, home);
  return join(appConfigDir(env, home), 'usage-events');
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * `parseUsageObservation()` の結果を、イベントの `usage` へ写す。
 *
 * - 2xx 以外、または解析できなかった応答は `null`（集計側はコスト計算の対象外として扱う）。
 * - キャッシュ作成の 5m/1h 内訳は、内訳が報告されていれば（または作成量が 0 なら）そのまま
 *   使う。集約値だけが正で内訳が無いときは、5m/1h の割り振りを推測せず両方 `null`
 *   （算出不能）にする。集計側はこれを「キャッシュ内訳が不完全」として数える。
 *
 * @param {object|null} observation `parseUsageObservation()` の戻り値。
 * @param {number|null} statusCode 上流の HTTP ステータス。
 * @returns {object|null}
 */
export function usageFromObservation(observation, statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) return null;
  if (!observation || observation.parse !== 'ok') return null;
  const breakdownReported = observation.cacheCreation5mTokens + observation.cacheCreation1hTokens > 0;
  const resolvable = breakdownReported || observation.cacheCreationTokens === 0;
  return {
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    cacheCreation5m: resolvable ? observation.cacheCreation5mTokens : null,
    cacheCreation1h: resolvable ? observation.cacheCreation1hTokens : null,
    cacheRead: observation.cacheReadTokens,
  };
}

/**
 * 1行ぶんのイベントを組み立てる。**ここに挙げたキー以外は決して書かない**（許可リスト）。
 * `eventId` は `requestId/attempt`。`requestId` が取れない失敗（接続エラー等）は UUIDv4。
 */
export function buildUsageEvent({
  ts,
  requestId = null,
  attempt,
  accountId,
  messageId = null,
  model = null,
  outcome,
  statusCode = null,
  errorType = null,
  usage = null,
}) {
  const normalizedRequestId = stringOrNull(requestId);
  return {
    ts,
    eventId: normalizedRequestId ? `${normalizedRequestId}/${attempt}` : randomUUID(),
    requestId: normalizedRequestId,
    messageId: stringOrNull(messageId),
    accountId,
    model: stringOrNull(model),
    attempt,
    outcome,
    statusCode: Number.isInteger(statusCode) ? statusCode : null,
    errorType: stringOrNull(errorType),
    usage: usage
      ? {
        inputTokens: nonNegativeIntegerOrNull(usage.inputTokens),
        outputTokens: nonNegativeIntegerOrNull(usage.outputTokens),
        cacheCreation5m: nonNegativeIntegerOrNull(usage.cacheCreation5m),
        cacheCreation1h: nonNegativeIntegerOrNull(usage.cacheCreation1h),
        cacheRead: nonNegativeIntegerOrNull(usage.cacheRead),
      }
      : null,
  };
}

/**
 * 日付ごとの使用量イベントのファイルへの追記係。
 *
 * - **呼び出し側を待たせない。** `append()` はイベントを直列キューへ積んで即座に戻る
 *   （戻り値の Promise はそのイベントの処理が終わると解決し、決して reject しない）。
 *   転送のホットパスはこれを await しないこと。順序は積んだ順に保たれる。
 *   `append()` にはイベントそのものか、イベントへ解決する Promise を渡せる。Promise が
 *   reject しても、その場で握って（未処理の rejection にせず）ログ1行にとどめる。
 * - `flush()` は、その時点までに積んだイベントがすべて処理されると解決する（試験用）。
 *   プロセス終了時の積み残しは捨ててよい（転送へは影響しない）。
 * - **権限を確保できないときは書かない。** ディレクトリ 0700・ファイル 0600 に直せない
 *   （chmod 失敗、または stat で所有者が自分でない／グループ・他者に権限が残る）ときは
 *   そのイベントを捨ててログ1行（`warnIntervalMs` に1回へ抑制）とし、次のイベントで
 *   また確保を試みる。確保済みの印は確保に成功してから立てる。
 * - 書く日付が前回の書込から変わったとき（起動後の最初の書込を含む）だけ、
 *   ディレクトリの確保 → 旧名の移行 → 当日ファイルの確保 → 1行の追記 → 旧名のリンクの
 *   張り替え → 期限切れの削除、の順に行う。
 * - 返り値の `path` は旧名（最初の1行の後は最後に書いた日の日付名へのシンボリックリンク）、
 *   `currentPath()` は当日（`now()` の UTC の日付）の日付名。
 */
export function createUsageEventWriter({
  dir = usageEventsDir(),
  logger = null,
  sizeWarnBytes = DEFAULT_SIZE_WARN_BYTES,
  sizeCheckEvery = DEFAULT_SIZE_CHECK_EVERY,
  warnIntervalMs = DEFAULT_WARN_INTERVAL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  // 名前の日付が「当日−retentionDays 日」以前の日付名を消す。MIN_RETENTION_DAYS 未満は切り上げる。
  retentionDays = DEFAULT_RETENTION_DAYS,
  // 書く日付も、ログの抑制も、この1つの時計で決める。
  now = Date.now,
  // 試験用の注入口（chmod の失敗・書込の停滞・リンク操作の失敗を再現する）。本番は node:fs/promises のまま。
  fsOps = {},
} = {}) {
  const fs = {
    appendFile, chmod, link, lstat, mkdir, open, readdir, readlink, rename, stat, symlink, unlink, ...fsOps,
  };
  const path = join(dir, USAGE_EVENTS_FILENAME);
  const keepDays = Number.isInteger(retentionDays)
    ? Math.max(MIN_RETENTION_DAYS, retentionDays)
    : DEFAULT_RETENTION_DAYS;
  let dirEnsured = false;
  let fileEnsured = false;
  // 最後に1行を書けた UTC の日付。これと違う日付で書くときが「日付が変わったとき」。
  let writtenDay = null;
  let appended = 0;
  let pending = 0;
  let tail = Promise.resolve();
  const throttled = new Map();

  // ロガー自身が投げても append() の外へ漏らさない（計測は fail-open）。
  function log(line) {
    try {
      logger?.(`${new Date().toISOString()} ${line}`);
    } catch {
      // 計測の失敗で転送を壊さない。
    }
  }

  // 同じ種類の警告は warnIntervalMs に1回だけ出す。抑えた件数は次の1行に載せる。
  function logThrottled(key, line) {
    const entry = throttled.get(key) || { lastAt: null, suppressed: 0 };
    const at = now();
    if (entry.lastAt !== null && at - entry.lastAt < warnIntervalMs) {
      entry.suppressed += 1;
      throttled.set(key, entry);
      return;
    }
    log(entry.suppressed > 0 ? `${line} suppressed=${entry.suppressed}` : line);
    throttled.set(key, { lastAt: at, suppressed: 0 });
  }

  // chmod で mode に直し、stat で本当にそうなったかを確かめる。問題なければ null。
  async function secure(target, mode, kind) {
    try {
      await fs.chmod(target, mode);
    } catch (error) {
      return `reason=chmod errorType=${errorType(error)}`;
    }
    let info;
    try {
      info = await fs.stat(target);
    } catch (error) {
      return `reason=stat errorType=${errorType(error)}`;
    }
    if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) return 'reason=type';
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && info.uid !== uid) return 'reason=owner';
    if ((info.mode & 0o077) !== 0) return 'reason=mode';
    return null;
  }

  // mkdir の mode は作成時にしか効かないので、既存のゆるい権限は chmod で 0700 に直す。
  async function ensureDir() {
    if (dirEnsured) return true;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const problem = await secure(dir, 0o700, 'dir');
    if (problem) {
      logThrottled('dir', `usage-events-chmod result=failed target=dir ${problem} action=skip-event`);
      return false;
    }
    dirEnsured = true;
    return true;
  }

  // appendFile の mode も作成時にしか効かないので、書く前に（無ければ空で作って）0600 に直す。
  // O_APPEND|O_CREAT で開くだけなので、複数のプロセスが同時に作っても中身は消えない。
  async function ensureFile(target) {
    if (fileEnsured) return true;
    await fs.appendFile(target, '', { mode: 0o600 });
    const problem = await secure(target, 0o600, 'file');
    if (problem) {
      logThrottled('file', `usage-events-chmod result=failed target=file ${problem} action=skip-event`);
      return false;
    }
    await closePartialLine(target);
    fileEnsured = true;
    return true;
  }

  // 末尾が改行でなければ（ディスクが一杯になった・書込の最中に落ちた、の書きかけ）改行を1つ
  // 足して閉じ、次の行がそれに連結されないようにする。確かめるのは確保のときだけ
  // （このプロセスがそのファイルへ最初に書く前と、書込に失敗した後）。別のプロセスが同じ
  // ファイルへ書いている間に残した書きかけは閉じられないが、通常は1つのプロセスしか書かない
  // ので、追記のたびに末尾を確かめることはせず、これを受け入れる。
  async function closePartialLine(target) {
    const handle = await fs.open(target, 'r');
    let last = null;
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, size - 1);
        last = byte[0];
      }
    } finally {
      await handle.close();
    }
    if (last === null || last === 0x0a) return;
    await fs.appendFile(target, '\n', { mode: 0o600 });
    log('usage-events-repair result=closed-partial-line');
  }

  async function lstatOrNull(target) {
    try {
      return await fs.lstat(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  // 旧名が通常ファイルなら、日付名へハードリンクしてから旧名を外す。rename は同名を黙って
  // 上書きするので使わない（link は同名があれば EEXIST で失敗する）。同じ inode のままなので、
  // 中身はコピーせず、最後の1バイトまで日付名から読める。旧名が無い・シンボリックリンクなら、
  // 移行は済んでいる。
  async function migrateLegacyFile(day) {
    try {
      const legacy = await lstatOrNull(path);
      if (!legacy || legacy.isSymbolicLink()) return;
      if (!legacy.isFile()) {
        logThrottled('migrate-type', 'usage-events-migrate result=skipped reason=not-a-file');
        return;
      }
      // nlink が2以上なら、前回の移行が link と unlink の間で止まったかもしれない。同じ実体の
      // 日付名が見つかれば、新しい日付名へ link し直さず（日付名どうしを同じ実体にせず）旧名だけを外す。
      if (legacy.nlink >= 2 && (await findDailyTwin(legacy))) {
        await unlinkLegacy();
        return;
      }
      await linkLegacy(day);
    } catch (error) {
      logThrottled('migrate-io', `usage-events-migrate result=failed reason=io errorType=${errorType(error)}`);
    }
  }

  async function findDailyTwin(legacy) {
    for (const name of await fs.readdir(dir)) {
      if (!DAILY_NAME.test(name)) continue;
      const info = await lstatOrNull(join(dir, name));
      if (info?.isFile() && sameFile(info, legacy)) return true;
    }
    return false;
  }

  // 当日の日付名から1日ずつさかのぼり（当日−13日まで）、空いている名前へ移す。どれも空いて
  // いなければ旧名は通常ファイルのまま残す（読み手はそれを通常ファイルとして読み続ける）。
  async function linkLegacy(day) {
    for (let back = 0; back <= MIGRATE_LOOKBACK_DAYS; back += 1) {
      const outcome = await linkLegacyTo(join(dir, dailyFileName(shiftDay(day, -back))));
      if (outcome === 'linked' || outcome === 'same-file') {
        await unlinkLegacy();
        return;
      }
      if (outcome !== 'taken') return;
    }
    logThrottled('migrate-name-taken', 'usage-events-migrate result=failed reason=name-taken');
  }

  async function linkLegacyTo(target) {
    let retried = false;
    for (;;) {
      try {
        await fs.link(path, target);
        return 'linked';
      } catch (error) {
        if (error?.code !== 'EEXIST' || retried) {
          const legacy = await lstatOrNull(path);
          if (!legacy || legacy.isSymbolicLink()) return 'migrated';
          logThrottled('migrate-link', `usage-events-migrate result=failed reason=link errorType=${errorType(error)}`);
          return 'failed';
        }
      }
      // 同名がある。上書きはせず、何がそこにあるかで分ける。リンクはたどらない（旧名を指す
      // シンボリックリンクを「同じ実体」と取り違えて旧名を外すと、中身を指す名前が無くなる）。
      // 通常ファイル以外は、空いていない名前として扱う。
      const legacy = await lstatOrNull(path);
      if (!legacy || legacy.isSymbolicLink()) return 'migrated';
      const existing = await lstatOrNull(target);
      if (existing) return existing.isFile() && sameFile(existing, legacy) ? 'same-file' : 'taken';
      // EEXIST の後に消えた（通常は起きない）。link を1回だけやり直す。
      retried = true;
    }
  }

  async function unlinkLegacy() {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      logThrottled('migrate-unlink', `usage-events-migrate result=failed reason=unlink errorType=${errorType(error)}`);
    }
  }

  // 旧名を当日の日付名へのシンボリックリンク（相対名）にする。通常ファイルは置き換えない。
  // 既にリンクなら、同じフォルダの一時リンクを rename で重ねて原子的に張り替える。リンク先の
  // 日付が当日以上なら張り替えない（複数のプロセスが競っても後戻りさせない）。
  async function pointLegacyLink(day) {
    const want = dailyFileName(day);
    try {
      const legacy = await lstatOrNull(path);
      if (!legacy) {
        try {
          await fs.symlink(want, path);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        return;
      }
      if (!legacy.isSymbolicLink()) return;
      const pointed = DAILY_NAME.exec(await fs.readlink(path));
      if (pointed && pointed[1] >= day) return;
      const temp = join(dir, `.${USAGE_EVENTS_FILENAME}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
      await fs.symlink(want, temp);
      try {
        await fs.rename(temp, path);
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        throw error;
      }
    } catch (error) {
      logThrottled('link', `usage-events-link result=failed errorType=${errorType(error)}`);
    }
  }

  // 名前の日付が「当日−keepDays 日」以前の日付名を、古い順に最大2本消す。mtime は見ない。
  // 型に厳密に合い、実在する日付で、lstat で通常ファイルのものだけが対象（旧名・型に合わない
  // 名前のファイル・一時リンク・シンボリックリンク・ディレクトリには触れない）。他のプロセスが先に
  // 消したもの（ENOENT）も2本に数え、同時に動くプロセスが合わせて消し過ぎないようにする。
  async function pruneExpired(day) {
    const cutoff = shiftDay(day, -keepDays);
    try {
      const expired = (await fs.readdir(dir))
        .map(name => ({ name, day: DAILY_NAME.exec(name)?.[1] }))
        .filter(entry => entry.day && utcDayStart(entry.day) !== null && entry.day <= cutoff)
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      let handled = 0;
      for (const entry of expired) {
        if (handled >= MAX_PRUNE_PER_RUN) break;
        const target = join(dir, entry.name);
        const info = await lstatOrNull(target);
        if (info && !info.isFile()) continue;
        if (info) {
          try {
            await fs.unlink(target);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        handled += 1;
      }
    } catch (error) {
      logThrottled('prune', `usage-events-prune result=failed errorType=${errorType(error)}`);
    }
  }

  async function warnIfOversized(target) {
    try {
      const info = await fs.stat(target);
      if (info.size > sizeWarnBytes) {
        log(`usage-events-size result=over-limit bytes=${info.size} limitBytes=${sizeWarnBytes}`);
      }
    } catch (error) {
      log(`usage-events-size result=failed errorType=${errorType(error)}`);
    }
  }

  async function writeOne(settled) {
    if (settled.error !== undefined) {
      log(`usage-events-append result=failed errorType=${errorType(settled.error)}`);
      return;
    }
    if (!settled.event) return;
    // 書く日付は、この行を書く直前の時刻（UTC）で決める。イベントの ts では決めない。
    const day = utcDay(now());
    const newDay = day !== writtenDay;
    const target = join(dir, dailyFileName(day));
    try {
      if (!(await ensureDir())) return;
      if (newDay) {
        fileEnsured = false;
        // 当日ファイルを作る前に移す（その日の日付名がまだ無いうちに）。
        await migrateLegacyFile(day);
      }
      if (!(await ensureFile(target))) return;
      await fs.appendFile(target, `${JSON.stringify(settled.event)}\n`, { mode: 0o600 });
    } catch (error) {
      dirEnsured = false;
      fileEnsured = false;
      log(`usage-events-append result=failed errorType=${errorType(error)}`);
      return;
    }
    appended += 1;
    if (newDay) {
      writtenDay = day;
      await pointLegacyLink(day);
      await pruneExpired(day);
    }
    if (appended % sizeCheckEvery === 0) await warnIfOversized(target);
  }

  function append(eventOrPromise) {
    // reject をその場で握る。キューの順番待ちの間に reject しても未処理扱いにならない。
    const settled = Promise.resolve(eventOrPromise).then(event => ({ event }), error => ({ error }));
    if (pending >= maxPending) {
      logThrottled('queue', `usage-events-append result=dropped reason=queue-full maxPending=${maxPending}`);
      return Promise.resolve();
    }
    pending += 1;
    const run = tail
      .then(() => settled)
      .then(writeOne)
      .catch(error => log(`usage-events-append result=failed errorType=${errorType(error)}`))
      .finally(() => {
        pending -= 1;
      });
    tail = run;
    return run;
  }

  function flush() {
    return tail;
  }

  function currentPath() {
    return join(dir, dailyFileName(utcDay(now())));
  }

  return { append, flush, path, currentPath };
}

function errorType(error) {
  return error?.code || error?.name || 'unknown';
}
