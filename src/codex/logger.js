// codex-rotator のログ（1行1件の JSON）。
//
// 出してよいフィールドは許可リストで決め、フィールドごとに型を決める（数値・語彙コード・
// 口座ラベル・要求のパス・真偽・自由文・例外）。許可リストに無いキーと、型に合わない値は
// 黙って落とす。自由文を受けるのは message（文字列）と error（Error の名前とメッセージ）だけで、
// この2つは redact.js の形式による伏せ字（API キー・Bearer・Authorization・JWT・メールアドレス・
// 絶対パス）と値による伏せ字の両方を通る。形式に当たらない秘密（乱数のトークン、User-Agent と
// originator の値など）は、呼び出し側が「秘密として登録した値」として渡さない限り消えない。
// 登録は作成時の secrets か、作成後の registerSecret で行う。
// 書込に失敗したときに標準エラーへ出す1行も、同じ伏せ字を通す。ロガーは例外を投げない。
//
// path を渡したときのファイルへの書込: 親フォルダは初回に 0700 で作って自分だけの場所か確かめ、
// ファイルは O_APPEND|O_CREAT|O_NOFOLLOW と 0600 で開き、開いた実体の種類と所有者を確かめてから
// 権限を 0600 に直して（setuid・setgid・sticky のビットも落とす）追記する（シンボリックリンクを
// 辿って別の場所へ書かない）。
import {
  closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { assertPrivateDirectorySync } from './fsguard.js';
import { createSecretRegistry, formatError, redactRegisteredValues, redactSecrets } from './redact.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

// 語彙コードの字形（自由文・空白・改行・@・/・長文を通さない）。通った値も伏せ字を通す。
const CODE_VALUE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// 口座ラベルは設定が受け付ける形と同じ（config.js の CODEX_ACCOUNT_LABEL）。
const ACCOUNT_LABEL_VALUE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// 常駐への要求のパス（/internal/reload など）だけ。ファイルのパス（口座のフォルダなど）と
// 問い合わせ文字列（? 以降）は通さない。
const REQUEST_PATH_VALUE = /^\/internal\/[a-z][a-z-]{0,31}$/;
// 1件の組立か JSON 化に失敗したときに、代わりに書く固定の出来事の名前。
export const LOG_RECORD_UNAVAILABLE = 'log-record-unavailable';

const FIELD_TYPE = Object.freeze({
  number: 'number',
  code: 'code',
  label: 'label',
  path: 'path',
  boolean: 'boolean',
  text: 'text',
  error: 'error',
});

const fieldsOf = (type, names) => names.map(name => [name, type]);

/**
 * 許可リスト（フィールド名 → 型）。ts・level・event は構造上のキーとして常に付ける。
 * 足すときは、値が自由文にならない型を選ぶ（自由文は message だけ）。
 */
export const CODEX_LOG_FIELDS = Object.freeze(Object.fromEntries([
  ...fieldsOf(FIELD_TYPE.number, [
    'status', 'duration_ms', 'accounts_total', 'accounts_available', 'accounts_selectable', 'accounts_unknown',
    'observation_age_ms', 'usage_read_duration_ms', 'usage_read_status', 'used_percent', 'stop_used_percent',
    'resume_used_percent', 'window_minutes', 'clean_reads_done', 'consecutive_failures', 'config_generation',
    'port', 'exit_code',
  ]),
  ...fieldsOf(FIELD_TYPE.code, [
    'pool_state', 'state', 'reason', 'source', 'window', 'event_type', 'observation_source', 'observation_result',
    'usage_state', 'selection_block_reason', 'account_switch_reason', 'user_agent_source', 'phase', 'signal',
    'command', 'method',
  ]),
  ...fieldsOf(FIELD_TYPE.label, ['account_label', 'next_label']),
  ...fieldsOf(FIELD_TYPE.path, ['path']),
  ...fieldsOf(FIELD_TYPE.boolean, ['ordinary_usage_allowed', 'reachable']),
  ...fieldsOf(FIELD_TYPE.text, ['message']),
  ...fieldsOf(FIELD_TYPE.error, ['error']),
]));
const LOG_FIELD_NAMES = Object.freeze(Object.keys(CODEX_LOG_FIELDS));

// 1つの値を型に合わせて整える。落とすときは undefined。
function sanitizeField(type, value, secrets) {
  switch (type) {
    case FIELD_TYPE.number:
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    case FIELD_TYPE.boolean:
      return typeof value === 'boolean' ? value : undefined;
    case FIELD_TYPE.code:
      return typeof value === 'string' && CODE_VALUE.test(value) ? redactSecrets(value, secrets) : undefined;
    case FIELD_TYPE.label:
      return typeof value === 'string' && ACCOUNT_LABEL_VALUE.test(value) ? redactSecrets(value, secrets) : undefined;
    case FIELD_TYPE.path:
      // 形が /internal/<名前> に限られるので、形式の規則（絶対パス）ではなく値だけで伏せる。
      return typeof value === 'string' && REQUEST_PATH_VALUE.test(value) ? redactRegisteredValues(value, secrets) : undefined;
    case FIELD_TYPE.text:
      return typeof value === 'string' ? redactSecrets(value, secrets) : undefined;
    case FIELD_TYPE.error:
      return formatError(value, secrets);
    default:
      return undefined;
  }
}

// 許可リストのキーだけを、呼び出し側のオブジェクト自身が持つときに取り出す（継承したキーと
// 許可リストの外のキーには触れない）。値の getter が例外を投げたら、呼び出し側の emit が拾う。
function buildRecord(level, event, fields, now, secrets) {
  const eventName = typeof event === 'string' && CODE_VALUE.test(event) ? redactSecrets(event, secrets) : 'invalid-event';
  const record = { ts: now().toISOString(), level, event: eventName };
  if (!fields || typeof fields !== 'object') return record;
  for (const key of LOG_FIELD_NAMES) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (value === undefined) continue;
    const sanitized = sanitizeField(CODEX_LOG_FIELDS[key], value, secrets);
    if (sanitized !== undefined) record[key] = sanitized;
  }
  return record;
}

const unavailableLine = level => JSON.stringify({ level, event: LOG_RECORD_UNAVAILABLE });

// path へ1行ずつ追記する書き手。失敗は例外で返し、呼び出し側（emit）が拾う。
function createFileWriter(path, uid, fstatSyncImpl) {
  const parent = dirname(path);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let parentChecked = false;
  return line => {
    if (!parentChecked) {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      assertPrivateDirectorySync(parent, { what: 'the log folder', uid });
      parentChecked = true;
    }
    const fd = openSync(path, flags, 0o600);
    try {
      const stats = fstatSyncImpl(fd);
      if (!stats.isFile()) throw new Error('the log file must be a regular file');
      const expectedUid = Number.isInteger(uid) ? uid : process.getuid();
      if (stats.uid !== expectedUid) throw new Error('the log file must be owned by the current user');
      if ((stats.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
      writeSync(fd, `${line}\n`);
    } finally {
      closeSync(fd);
    }
  };
}

/**
 * ロガーを作る。
 * - write を渡すと、1行ずつその関数へ渡す（常駐のログファイルの書き手やテスト用）。
 * - path を渡すと、そのファイルへ追記する（上の「ファイルへの書込」）。
 * - どちらも無ければ標準エラーへ書く。
 * - 書込に失敗しても例外を投げない。失敗したことだけを標準エラーへ1行（伏せ字済み）で出す。
 * @param {object} [options]
 * @param {Iterable<string>} [options.secrets] 作成時に「秘密として登録する値」
 * @param {number} [options.uid] ログのファイルと親フォルダの所有者として期待する uid（既定は自分）
 * @param {typeof fstatSync} [options.fstatSyncImpl] 開いたログのファイルを調べる関数（テスト用）
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, registerSecret: Function }}
 */
export function createCodexLogger({
  path,
  level = 'info',
  now = () => new Date(),
  write,
  secrets = [],
  uid,
  fstatSyncImpl = fstatSync,
  stderrWriteImpl = line => process.stderr.write(`${line}\n`),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const registry = createSecretRegistry(secrets);
  const writeLine = write ?? (path ? createFileWriter(path, uid, fstatSyncImpl) : stderrWriteImpl);

  const emit = (levelName, event, fields) => {
    if (LEVELS[levelName] < threshold) return;
    let line;
    try {
      line = JSON.stringify(buildRecord(levelName, event, fields, now, registry));
    } catch {
      line = unavailableLine(levelName);
    }
    try {
      writeLine(line);
    } catch (error) {
      try {
        stderrWriteImpl(`codex-rotator log write failed: ${formatError(error, registry)}`);
      } catch {
        // 標準エラーにも書けなければ諦める（ロガーが例外の出どころにならない）。
      }
    }
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /** 値そのもので伏せる秘密を足す（空文字と文字列以外は無視）。 */
    registerSecret: value => { registry.add(value); },
  };
}
