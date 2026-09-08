#!/usr/bin/env node
// 偽 bridge（codex-rotator のスタブ）。
//
// 目的:
//   契約 v1.4（docs/sessions/20260908_codex-rotation/02_P2_契約案_v1.4.md）の
//   §C3（ヘッダ仕様）・§C4（開始マーカー）・§D2（Part 2a の状態表）が定める
//   「状態ごとの status ／ error.type ／ x-ombr-* の組」を、実 TCP で1つずつ再現する。
//   R4-1 の統合テストからモジュールとして使い、設計書 §11.4 の受入検証 (1)〜(5)
//   （docs/sessions/20260908_codex-rotation/10_設計書_codexローテーションとフォールバック写像.md）
//   では単体のプロセスとして使う。
//
// 単体起動:
//   node test/helpers/fake-bridge.js --port 18799 --mode exhausted
//   node test/helpers/fake-bridge.js --port 18799 --mode ok --account acct-b
//   node test/helpers/fake-bridge.js --port 18799 --mode mixed --reset-at 2026-09-08T13:00:00Z
//   SIGINT / SIGTERM で終了する。起動時に標準出力へ1行だけ出す。
//
//   --mode unreachable は「listen しない」モードであり、--port を占有しない。
//   受入検証 (1)（bridge 不達 → 403 ＋ outcome=bridge-unreachable）を再現するときは、
//   このモードで起動する（プロセスは1行出力してすぐ終了する）か、そもそも何も起動しない。
//   どちらでも rotator から見た結果は同じ（接続拒否）である。
//
// モジュールとしての利用:
//   import { startFakeBridge } from './helpers/fake-bridge.js';
//   const bridge = await startFakeBridge({ port: 0, mode: 'exhausted' });
//   // bridge.port には実際に listen したポートが入る（port: 0 を渡すと空きポート）
//   await bridge.close();
//
// 本ファイルは test/ 配下にあるため `node --test` から「テストファイル」として
// 実行される（Node 20 は test ディレクトリ配下の .js をすべて対象にする）。
// import しただけでは何も起きないよう、CLI の起動は下部の1か所に閉じてある。

import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** 契約の版（応答ヘッダ x-ombr-contract と /healthz の contract に載る）。 */
export const CONTRACT_VERSION = 1;

/** --account の既定値。契約 §C3.1 の表示名パターンに適合する。 */
export const DEFAULT_ACCOUNT_LABEL = 'acct-a';

/** --reset-at の既定値（現在時刻 + 60 秒）。 */
export const DEFAULT_RESET_AT_OFFSET_MS = 60_000;

/** 契約 §C3.1: 表示名はこのパターンに限る（メールアドレス・氏名は禁止）。 */
const ACCOUNT_LABEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 契約 §C3.2: x-ombr-reset-at は RFC3339 の UTC 表記。 */
const RESET_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// 契約 §C4.4: 開始マーカーは「上流ステータス確定の直後に何らかのバイト列が届くこと」
// だけを要求しており、形は bridge 側が決めてよい。ここでは既存テスト
// （test/openai-bridge.test.js の SSE 最小応答）と同じ message_start / message_stop を使う。
const SSE_START_MARKER = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const SSE_STOP_EVENT = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/** stream-error モードで、開始マーカーを流し終えてからソケットを切るまでの待ち時間。 */
const STREAM_RESET_DELAY_MS = 20;

/**
 * モード表。契約 §D2（Part 2a の状態表）・§C3.4（degrade-reason の列挙）・
 * §C10.5（403 書換の4条件）と、設計書 §13.2（CR-L〜CR-S）に対応する。
 *
 * kind:
 *   'json'      … ステータスと JSON 本文を返して終わる
 *   'sse'       … 200 ＋ 開始マーカー ＋ 終端イベント
 *   'sse-idle'  … 200 ＋ 開始マーカーの後、無音のまま保持する（アイドルタイムアウトの再現）
 *   'sse-reset' … 200 ＋ 開始マーカーの後、ソケットを切る（ストリーム障害の再現）
 *   'none'      … listen しない（不達の再現）
 *
 * ombr が null のモードは x-ombr-* を1つも付けない（契約前 bridge ＝ §C3.7-1 の再現）。
 */
const MODE_TABLE = Object.freeze({
  ok: {
    kind: 'sse',
    status: 200,
    // 成功応答では upstream-status / upstream-sent は任意だが、
    // 「上流へ実際に送って 200 が返った」ことを明示できるので付ける。
    ombr: { poolState: 'ok', upstreamStatus: '200', upstreamSent: 'yes' },
    withAccount: true,
    withResetAt: false,
    summary: '200 SSE (contract=1, pool-state=ok)',
  },
  exhausted: {
    // §D2 S5b / CR-L: 全口座が枠切れ。rotator は (pool) を unusable にする。
    kind: 'json',
    status: 529,
    errorType: 'overloaded_error',
    message: 'codex pool exhausted; no Codex account can accept this request (fake-bridge --mode exhausted).',
    ombr: {
      reason: 'codex_pool_exhausted',
      scope: 'pool',
      poolState: 'exhausted',
      upstreamStatus: '429',
      upstreamSent: 'yes',
    },
    withAccount: true,
    withResetAt: true,
    summary: '529 overloaded_error / codex_pool_exhausted / scope=pool / pool-state=exhausted',
  },
  mixed: {
    // §D2 S8 / §C10.7 規則1 / CR-O: 失効と枠切れの混在。生成側は 529 のままとする。
    kind: 'json',
    status: 529,
    errorType: 'overloaded_error',
    message: 'codex pool mixed; some accounts are logged out and the rest are rate limited (fake-bridge --mode mixed).',
    ombr: {
      reason: 'codex_pool_mixed',
      scope: 'pool',
      poolState: 'mixed',
      upstreamStatus: '429',
      upstreamSent: 'yes',
    },
    withAccount: true,
    withResetAt: true,
    summary: '529 overloaded_error / codex_pool_mixed / scope=pool / pool-state=mixed',
  },
  'attempt-limit': {
    // §D2 S6 / CR-M: 未試行の口座が残っている。rotator は学習してはいけない。
    // pool-state=degraded は §C10.5 の「403 の根拠にならないもの」に明示されている。
    // reset-at は付けない（回復見込み時刻という概念が当たらない）。
    kind: 'json',
    status: 529,
    errorType: 'overloaded_error',
    message: 'codex attempt limit reached before any account answered (fake-bridge --mode attempt-limit).',
    ombr: {
      reason: 'codex_attempt_limit',
      scope: 'pool',
      poolState: 'degraded',
      upstreamStatus: '429',
      upstreamSent: 'yes',
    },
    withAccount: true,
    withResetAt: false,
    summary: '529 overloaded_error / codex_attempt_limit / pool-state=degraded / reset-at なし',
  },
  'needs-login': {
    // §D2 S7b / CR-N: 全口座が失効。坂根氏決定 S-10 により 403 で止める。
    // ローカルの認証情報が無い状態を再現するので上流へは送っていない（none / no）。
    kind: 'json',
    status: 403,
    errorType: 'permission_error',
    message: 'codex login required; every Codex account is logged out (fake-bridge --mode needs-login).',
    ombr: {
      reason: 'codex_needs_login',
      scope: 'pool',
      poolState: 'needs-login',
      upstreamStatus: 'none',
      upstreamSent: 'no',
    },
    withAccount: false,
    withResetAt: false,
    summary: '403 permission_error / codex_needs_login / pool-state=needs-login',
  },
  'no-account': {
    // §D2 S9 / CR-P: そのモデルに割り当てられた口座がゼロ。scope=model なので
    // rotator は (pool) を汚さない（403 書換の根拠にもならない）。
    kind: 'json',
    status: 403,
    errorType: 'permission_error',
    message: 'no Codex account is assigned to the requested model (fake-bridge --mode no-account).',
    ombr: {
      reason: 'codex_no_account_for_model',
      scope: 'model',
      poolState: 'no-account-for-model',
      upstreamStatus: 'none',
      upstreamSent: 'no',
    },
    withAccount: false,
    withResetAt: false,
    summary: '403 permission_error / codex_no_account_for_model / scope=model',
  },
  idle: {
    // 設計書 §11.4 (4): 開始マーカーを送った後は無音。rotator 側は
    // outcome=bridge-idle-timeout になり、403 は合成されない（ヘッダ送出済みのため）。
    kind: 'sse-idle',
    status: 200,
    ombr: { poolState: 'ok', upstreamStatus: '200', upstreamSent: 'yes' },
    withAccount: true,
    withResetAt: false,
    summary: '200 SSE、開始マーカーの後は無音のまま保持',
  },
  'stream-error': {
    // 設計書 §11.4 (4b): 開始マーカーの後にソケットを切る。
    // rotator 側は outcome=bridge-stream-error になる。
    kind: 'sse-reset',
    status: 200,
    ombr: { poolState: 'ok', upstreamStatus: '200', upstreamSent: 'yes' },
    withAccount: true,
    withResetAt: false,
    summary: '200 SSE、開始マーカーの後にソケットを破壊',
  },
  unreachable: {
    // 設計書 §11.4 (1): 不達。listen しないので --port は占有されない。
    kind: 'none',
    summary: 'listen しない（接続拒否）',
  },
  legacy: {
    // 契約 §C3.7-1: x-ombr-* が1つも無い応答は現行とまったく同じ意味に解釈する。
    // 契約前 bridge が返していた 429 rate_limit_error を再現する。
    kind: 'json',
    status: 429,
    errorType: 'rate_limit_error',
    message: 'Rate limit reached for the Codex pool (fake-bridge --mode legacy; contract headers intentionally absent).',
    ombr: null,
    withAccount: false,
    withResetAt: false,
    summary: '429 rate_limit_error、x-ombr-* を1つも付けない',
  },
});

/** 選べるモード名の一覧。 */
export const MODE_NAMES = Object.freeze(Object.keys(MODE_TABLE));

/**
 * モードの定義（テストと usage が読む）。
 * @param {string} mode
 * @returns {object} 凍結済みの定義。
 */
export function describeMode(mode) {
  const descriptor = MODE_TABLE[mode];
  if (!descriptor) throw new Error(`unknown mode: ${mode} (expected one of ${MODE_NAMES.join(', ')})`);
  return descriptor;
}

/**
 * 既定の reset-at（現在時刻 + 60 秒）を RFC3339 の UTC 表記で返す。
 * @param {number} [now]
 * @returns {string}
 */
export function defaultResetAt(now = Date.now()) {
  return new Date(now + DEFAULT_RESET_AT_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 起動オプションを検証して正規化する。不正値は例外にする（黙って既定へ倒さない）。
 * @param {{ port?: number|string, mode?: string, account?: string, resetAt?: string }} input
 * @returns {{ port: number, mode: string, account: string, resetAt: string }}
 */
export function normalizeOptions({ port, mode = 'ok', account = DEFAULT_ACCOUNT_LABEL, resetAt } = {}) {
  if (!MODE_TABLE[mode]) {
    throw new Error(`unknown mode: ${mode} (expected one of ${MODE_NAMES.join(', ')})`);
  }
  const parsedPort = typeof port === 'string' ? Number(port) : port;
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535, got: ${String(port)}`);
  }
  if (!ACCOUNT_LABEL_PATTERN.test(account)) {
    // 契約 §C3.1（絶対禁止）: メールアドレス・氏名・トークンをヘッダへ載せない。
    // 表示名パターンに合わない値はここで止める。値そのものはメッセージへ出さない。
    throw new Error('--account must match ^[a-z0-9][a-z0-9_-]{0,31}$ (labels only; never an email address)');
  }
  const resolvedResetAt = resetAt === undefined || resetAt === null ? defaultResetAt() : String(resetAt);
  if (!RESET_AT_PATTERN.test(resolvedResetAt)) {
    throw new Error(`--reset-at must be RFC3339 UTC (e.g. 2026-09-08T13:00:00Z), got: ${resolvedResetAt}`);
  }
  return { port: parsedPort, mode, account, resetAt: resolvedResetAt };
}

/**
 * そのモードが返す x-ombr-* ヘッダの組を作る。
 * @param {{ mode: string, account: string, resetAt: string }} options
 * @returns {Record<string, string>} 契約前 bridge の再現（legacy）では空オブジェクト。
 */
export function buildOmbrHeaders({ mode, account, resetAt }) {
  const descriptor = describeMode(mode);
  if (!descriptor.ombr) return {};
  const headers = { 'x-ombr-contract': String(CONTRACT_VERSION) };
  if (descriptor.ombr.reason) headers['x-ombr-degrade-reason'] = descriptor.ombr.reason;
  if (descriptor.ombr.scope) headers['x-ombr-degrade-scope'] = descriptor.ombr.scope;
  headers['x-ombr-pool-state'] = descriptor.ombr.poolState;
  headers['x-ombr-upstream-status'] = descriptor.ombr.upstreamStatus;
  headers['x-ombr-upstream-sent'] = descriptor.ombr.upstreamSent;
  if (descriptor.withResetAt) headers['x-ombr-reset-at'] = resetAt;
  // x-ombr-account は「実際に使ったアカウントの表示名」（§C3.2）なので、
  // 上流へ1度も送っていないモード（needs-login / no-account）では付けない。
  if (descriptor.withAccount) headers['x-ombr-account'] = account;
  return headers;
}

/**
 * エラー応答の本文（Anthropic 形式）を作る。
 * @param {{ mode: string, resetAt: string }} options
 * @returns {string} JSON 文字列。
 */
export function buildErrorBody({ mode, resetAt }) {
  const descriptor = describeMode(mode);
  const message = descriptor.withResetAt
    ? `${descriptor.message} Earliest recovery: ${resetAt}.`
    : descriptor.message;
  return JSON.stringify({ type: 'error', error: { type: descriptor.errorType, message } });
}

/**
 * GET /healthz の本文。ラベルだけを出し、メールアドレスは出さない（§13.3・CR-I）。
 * @param {{ mode: string, account: string }} options
 * @returns {string} JSON 文字列。
 */
export function buildHealthBody({ mode, account }) {
  return JSON.stringify({ ok: true, contract: CONTRACT_VERSION, mode, account });
}

/**
 * 偽 bridge を起動する。
 * @param {{ port?: number|string, mode?: string, account?: string, resetAt?: string, host?: string }} input
 * @returns {Promise<{ mode: string, port: number, url: string, listening: boolean, close: () => Promise<void> }>}
 */
export async function startFakeBridge(input = {}) {
  const host = input.host ?? '127.0.0.1';
  const options = normalizeOptions(input);
  const descriptor = describeMode(options.mode);

  if (descriptor.kind === 'none') {
    // 不達の再現。listen しないので、このポートへの接続は拒否される。
    return {
      mode: options.mode,
      port: options.port,
      url: `http://${host}:${options.port}`,
      listening: false,
      close: async () => {},
    };
  }

  /** @type {Set<{ res: import('node:http').ServerResponse, timer: NodeJS.Timeout|null }>} */
  const held = new Set();

  const server = http.createServer((req, res) => {
    // 本文は使わないが読み捨てる（未読のままだと接続が滞留する）。
    req.resume();

    if (req.method === 'GET' && (req.url === '/healthz' || req.url.startsWith('/healthz?'))) {
      const body = buildHealthBody(options);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const ombr = buildOmbrHeaders(options);

    if (descriptor.kind === 'json') {
      const body = buildErrorBody(options);
      // Content-Length を明示する（chunked にしない）。設計書 §11.4 (3) の
      // 「529 の長い本文を 403 へ書き換えたときに Content-Length が一致すること」
      // を rotator 側で確認できるようにするため。
      res.writeHead(descriptor.status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...ombr,
      });
      res.end(body);
      return;
    }

    // 200 SSE 系。契約 §C4 の義務2により、上流ステータス確定の直後に開始マーカーを送る。
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...ombr });
    res.write(SSE_START_MARKER);

    if (descriptor.kind === 'sse') {
      res.write(SSE_STOP_EVENT);
      res.end();
      return;
    }

    if (descriptor.kind === 'sse-idle') {
      // 無音のまま保持する。close() で破棄されるまで何も送らない。
      const entry = { res, timer: null };
      held.add(entry);
      res.on('close', () => held.delete(entry));
      return;
    }

    // sse-reset: 開始マーカーが流れ切ってからソケットを切る。
    const entry = { res, timer: null };
    held.add(entry);
    res.on('close', () => held.delete(entry));
    entry.timer = setTimeout(() => {
      const socket = res.socket;
      if (!socket) return;
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
      else socket.destroy();
    }, STREAM_RESET_DELAY_MS);
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(options.port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const actualPort = server.address().port;

  return {
    mode: options.mode,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    listening: true,
    close: async () => {
      for (const entry of held) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.res.destroy();
      }
      held.clear();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'Usage: node test/helpers/fake-bridge.js --port <n> [--mode <mode>] [--reset-at <rfc3339>] [--account <label>]',
  '',
  'Modes:',
  ...MODE_NAMES.map(name => `  ${name.padEnd(13)} ${describeMode(name).summary}`),
  '',
  `Defaults: --mode ok  --account ${DEFAULT_ACCOUNT_LABEL}  --reset-at now+60s`,
  'GET /healthz returns {"ok":true,"contract":1,"mode":...,"account":...} (labels only, never an email address).',
].join('\n');

/**
 * argv を解析する（--key value と --key=value の両方を受ける）。
 * @param {string[]} argv
 * @returns {{ port?: string, mode?: string, resetAt?: string, account?: string }}
 */
export function parseArgs(argv) {
  const keys = { '--port': 'port', '--mode': 'mode', '--reset-at': 'resetAt', '--account': 'account' };
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const key = keys[name];
    if (!key) throw new Error(`unknown argument: ${token}`);
    if (eq !== -1) {
      out[key] = token.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
    out[key] = value;
    i += 1;
  }
  return out;
}

async function main(argv) {
  if (argv.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.port === undefined) throw new Error('--port is required');
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  let bridge;
  try {
    bridge = await startFakeBridge(parsed);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (!bridge.listening) {
    process.stdout.write(`fake-bridge not-listening port=${bridge.port} mode=${bridge.mode}\n`);
    return;
  }

  process.stdout.write(`fake-bridge listening port=${bridge.port} mode=${bridge.mode}\n`);

  const shutdown = () => {
    bridge.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// このファイルは test/ 配下にあるため `node --test` が「テストファイル」として実行する
// （Node 20 は test ディレクトリ配下の .js をすべて対象にする）。テストランナー配下では
// NODE_TEST_CONTEXT が設定されるので、そのときは CLI を起動しない。
// 引数なしで直接実行された場合も usage を出すだけで異常終了しない（同じ理由の二重の保険）。
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isMainModule = invokedPath !== null && invokedPath === fileURLToPath(import.meta.url);
if (isMainModule && !process.env.NODE_TEST_CONTEXT) {
  await main(process.argv.slice(2));
}
