// `codex-rotator accounts`：登録した口座の一覧を出す副コマンド。
//
// - `--json` は機械向けの形（下の固定のスキーマ）。同じマシンのほかのプロセスが、口座のフォルダ
//   （CODEX_HOME）から口座のラベルを引くために使う。口座のフォルダと accountsDir の絶対パスを
//   出すのは、この形の標準出力だけである（状態の表示・人向けの表示・ログには出さない）。
// - `--json` の無い形は人向けの一覧で、パスは出さない。
// - 読むのは設定ファイルだけ。資格情報・制御トークンは読まず、常駐にも上流にも問い合わせない。
// - 設定が検証を通らないときは、標準出力へ何も出さずに 1 で終わり、理由を標準エラーへ出す。
//   理由に使うのは設定の読込みが作る文（値とパスを含まない）だけで、それ以外の例外の文は出さない
//   （ファイルシステムの例外の文はパスを含みうるため）。
import { CodexConfigError, isCodexRotatorActivated, loadCodexConfig } from './config.js';

export const ACCOUNTS_JSON_SCHEMA_VERSION = 1;
export const ACCOUNTS_JSON_KIND = 'codex-rotator-accounts';
// `--json` の出力のキー（この順で出す。未知のキーは持たない）。README との突き合わせもこれを使う。
export const ACCOUNTS_JSON_KEYS = Object.freeze(['schemaVersion', 'kind', 'generatedAt', 'enabled', 'accountsDir', 'accounts']);
export const ACCOUNTS_JSON_ACCOUNT_KEYS = Object.freeze(['label', 'codexHome', 'registration']);
// 登録の状態。active は有効化の二重ゲート（enabled と多口座のリスク承認）を両方満たすとき。
// 使用量による停止とは別物で、ここには出さない。
export const REGISTRATION = Object.freeze({ active: 'active', stopped: 'stopped' });

export const ACCOUNTS_USAGE = 'usage: codex-rotator accounts [--json]';
export const NO_CONFIG_LINE = 'no codex-rotator config file: no accounts are registered';
const USAGE_EXIT_CODE = 2;
const CONFIG_EXIT_CODE = 1;
const UNREADABLE_CONFIG = 'the codex-rotator config file could not be read';

/** 時刻（ミリ秒）を、UTC の `YYYY-MM-DDTHH:MM:SSZ`（ミリ秒を落とした形）にする。 */
export function formatGeneratedAt(nowMs) {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function registrationOf(config) {
  return isCodexRotatorActivated(config) ? REGISTRATION.active : REGISTRATION.stopped;
}

/**
 * `--json` の出力を作る（純粋関数）。config は loadCodexConfig の結果で、設定ファイルが無ければ null。
 * 口座から写すのはラベルとフォルダだけで、方針などほかのキーは出さない。
 * @param {object|null} config
 * @param {number} nowMs
 */
export function buildAccountsJson(config, nowMs) {
  const registration = registrationOf(config);
  return {
    schemaVersion: ACCOUNTS_JSON_SCHEMA_VERSION,
    kind: ACCOUNTS_JSON_KIND,
    generatedAt: formatGeneratedAt(nowMs),
    enabled: config?.enabled === true,
    accountsDir: config ? config.accountsDir : null,
    accounts: (config?.accounts ?? []).map(({ label, codexHome }) => ({ label, codexHome, registration })),
  };
}

/**
 * 人向けの一覧（パスは出さない）。1行目に口座の数と2つのゲート、続けて口座ごとにラベルと登録の状態。
 * @param {object|null} config
 */
export function formatAccountsText(config) {
  if (!config) return `${NO_CONFIG_LINE}\n`;
  const registration = registrationOf(config);
  const width = Math.max(0, ...config.accounts.map(({ label }) => label.length));
  const lines = [`accounts: ${config.accounts.length} (enabled: ${config.enabled}, `
    + `multi-account risk acknowledged: ${config.acknowledgedMultiAccountRisk})`];
  for (const { label } of config.accounts) lines.push(`  ${label.padEnd(width)}  ${registration}`);
  return `${lines.join('\n')}\n`;
}

// 引数は無しか `--json` の1つだけ。それ以外は null（使い方の誤り）。
function wantsJson(argv) {
  if (argv.length === 0) return false;
  if (argv.length === 1 && argv[0] === '--json') return true;
  return null;
}

/**
 * @param {string[]} argv 副コマンドの語の後ろの引数
 * @param {{ stdout: object, stderr: object, env: object }} io
 * @param {{ loadConfig?: Function, now?: () => number }} [deps] 設定の読込み（既定は loadCodexConfig。
 *   `{ env }` を受け、設定か null を返す）と時計。テストが差し替える。
 * @returns {Promise<number>} 終了コード
 */
export async function runAccounts(argv, io, { loadConfig = loadCodexConfig, now = Date.now } = {}) {
  const { stdout, stderr, env } = io;
  const json = Array.isArray(argv) ? wantsJson(argv) : null;
  if (json === null) {
    stderr.write(`${ACCOUNTS_USAGE}\n`);
    return USAGE_EXIT_CODE;
  }
  let config;
  try {
    config = await loadConfig({ env });
  } catch (error) {
    const reason = error instanceof CodexConfigError ? error.message : UNREADABLE_CONFIG;
    stderr.write(`codex-rotator accounts: ${reason}\n`);
    return CONFIG_EXIT_CODE;
  }
  stdout.write(json ? `${JSON.stringify(buildAccountsJson(config, now()))}\n` : formatAccountsText(config));
  return 0;
}
