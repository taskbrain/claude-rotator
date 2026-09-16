#!/usr/bin/env node
// sticky affinity の未解決点 U8 ／ U16 の実測（設計書 v1.5 §13・§8・§3 ／ 実装計画 v1.2 R-S15）。
//
// 目的:
//   U8  1万セッションを載せた `SessionAffinity` の**常駐ヒープ増**を測る。設計の2案が
//       Opus 案 240B/件 ≒ 2.4MB、Astra 案 1〜2KiB/件 ≒ 10〜20MiB と10倍開いたまま
//       `maxSessions` の既定値（10,000）が決まっている（§3・§13 U8）。
//   U16 `persistState()` 1回の所要を「口座台帳のみ（`mode:"off"`）」と「1万件の表込み
//       （`mode:"on"` ＋ `persist:true`）」の両方で測る。`writeJsonFileDurable` への
//       差し替え（D-56-5）で `fsync` が2回増えており、5秒デバウンス（§8）の上限に
//       収まるかが未確認である（§13 U16）。
//
// 実行方法（Node の eval からは起動しない。必ずファイルパスを渡す）:
//   node --expose-gc scripts/bench-session-affinity.mjs
//   （`--expose-gc` が無いと U8 は測定せず、その旨を出して終了コード 2 で止まる）
//
// 合否線:
//   U8  1万件で常駐ヒープ増が **24 MiB 以内**（Astra 案見積の上限 20MiB ＋2割）。
//   U16 **p90 で 5,000 ms 未満**（§8 の「5秒に1回を上限」に収まること）。
//   **どちらも超過しても自動で不合格にしない。** 実測値・環境・採った表現を添えて母艦へ上げる。
//
// 触らないもの:
//   実 Keychain（`MemorySecretStore` を使う）／launchd・systemd（サービス経路を1本も呼ばない）／
//   `~/.config/claude-rotator/`（入出力はすべて `mkdtemp` の一時ディレクトリ）／
//   本番 rotator（127.0.0.1:37891。ここは port 0 で listen し、上流へは1件も送らない）。
//   口座メール・トークン値・生のセッション UUID を出力しない（合成値だけを使う）。
//
// 出力: 1行の JSON（machine-readable）と、そのあとに人間向けの要約。
import { mkdtemp, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { AccountManager } from '../src/account-manager.js';
import { writeJsonFileDurable } from '../src/json-file.js';
import { createProxyServer } from '../src/proxy-server.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { DEFAULT_IDLE_TTL_MS, SessionAffinity, sidHash } from '../src/session-affinity.js';

const SESSIONS = 10_000;
// 5件に1件へ系統別副バインドを付ける（§3 の `families`）。全件に付けるのは実運用より
// 重く、0件では `families` の実費用が見えない。
const FAMILY_BIND_EVERY = 5;
const U8_REPEATS = 5;
const U16_ITERATIONS = 25;
const U8_LIMIT_BYTES = 24 * 1024 * 1024;
const U16_LIMIT_MS = 5_000;
// 合成の口座ラベル（実在の口座ではない）。メールアドレスも合成の `*@example.com` だけ。
const ACCOUNTS = Object.freeze(['acct_a', 'acct_b']);

function syntheticSessionId(index) {
  // 形だけ UUID を真似た合成値（実在のセッション id ではない）。§2.2 の文字集合に収まる。
  const hex = index.toString(16).padStart(12, '0');
  return `b1d5f0c2-8a44-4e19-9f7c-${hex}`;
}

function collectGarbage() {
  // `--expose-gc` 付きでのみ呼ばれる。3回回して世代を跨いだ回収まで済ませる。
  for (let i = 0; i < 3; i += 1) global.gc();
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const mib = bytes => round(bytes / 1024 / 1024, 3);

// --- U8: 1万件の常駐ヒープ -------------------------------------------------

function buildTable(count, clockMs) {
  const table = new SessionAffinity({
    mode: 'on',
    maxSessions: count,
    idleTtlMs: DEFAULT_IDLE_TTL_MS,
    now: () => clockMs,
    // logger も onChange も渡さない（測るのは表そのものの常駐分である）。
  });
  for (let index = 0; index < count; index += 1) {
    const key = syntheticSessionId(index);
    const home = ACCOUNTS[index % ACCOUNTS.length];
    table.note(key, { account: home });
    if (index % FAMILY_BIND_EVERY === 0) {
      const other = ACCOUNTS[(index + 1) % ACCOUNTS.length];
      table.note(key, { account: other, modelFamily: 'fable', reason: 'family_exhausted' });
    }
  }
  return table;
}

function measureHeapOnce(clockMs) {
  collectGarbage();
  const before = process.memoryUsage();
  let table = buildTable(SESSIONS, clockMs);
  collectGarbage();
  const after = process.memoryUsage();
  const sessions = table.size;
  const withFamilies = [...table.entries.values()]
    .filter(entry => Object.keys(entry.families).length > 0).length;
  const exportedBytes = JSON.stringify(table.export({ now: clockMs })).length;
  table = null;
  collectGarbage();
  return {
    heapUsedDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
    sessions,
    withFamilies,
    exportedBytes,
  };
}

function measureU8() {
  const clockMs = Date.now();
  const runs = [];
  for (let repeat = 0; repeat < U8_REPEATS; repeat += 1) runs.push(measureHeapOnce(clockMs));

  const heapDeltas = runs.map(run => run.heapUsedDeltaBytes);
  const rssDeltas = runs.map(run => run.rssDeltaBytes);
  const heapMedian = median(heapDeltas);
  return {
    sessions: SESSIONS,
    repeats: U8_REPEATS,
    entriesWithFamilyBind: runs[0].withFamilies,
    exportedSnapshotBytes: runs[0].exportedBytes,
    heapUsedDeltaBytes: heapDeltas,
    rssDeltaBytes: rssDeltas,
    heapUsedMedianBytes: heapMedian,
    heapUsedMedianMiB: mib(heapMedian),
    heapUsedMinMiB: mib(Math.min(...heapDeltas)),
    heapUsedMaxMiB: mib(Math.max(...heapDeltas)),
    rssMedianMiB: mib(median(rssDeltas)),
    bytesPerSession: round(heapMedian / SESSIONS, 1),
    limitMiB: mib(U8_LIMIT_BYTES),
    withinLimit: heapMedian <= U8_LIMIT_BYTES,
    // 2案の見積との比（§3・§13 U8）。
    opusEstimateBytes: 240 * SESSIONS,
    ratioToOpusEstimate: round(heapMedian / (240 * SESSIONS), 2),
    astraEstimateLowBytes: 10 * 1024 * 1024,
    astraEstimateHighBytes: 20 * 1024 * 1024,
    ratioToAstraEstimateLow: round(heapMedian / (10 * 1024 * 1024), 3),
  };
}

// --- U16: persistState 1回の所要 -------------------------------------------

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function postJson(port, path, body = '{}') {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        bodyText: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

function benchAccounts() {
  // `type:'apikey'` にして資格情報の読み出し経路（= macOS では Keychain）へ入れない。
  return ACCOUNTS.map(id => ({
    id,
    name: `${id}@example.com`,
    type: 'apikey',
    credentialRevision: `rev-${id}`,
  }));
}

function savedStateWithTable(entryCount, nowMs) {
  const savedAt = new Date(nowMs - 60_000).toISOString();
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const record = {
      k: sidHash(syntheticSessionId(index)),
      a: ACCOUNTS[index % ACCOUNTS.length],
      t: nowMs - 60_000,
      s: index % 3,
    };
    if (index % FAMILY_BIND_EVERY === 0) {
      record.f = { fable: ACCOUNTS[(index + 1) % ACCOUNTS.length] };
    }
    entries.push(record);
  }
  return {
    version: 1,
    savedAt,
    currentAccount: ACCOUNTS[0],
    accounts: benchAccounts().map(account => ({
      id: account.id,
      accountUuid: null,
      credentialRevision: account.credentialRevision,
      status: 'ready',
      quota: {},
      usage: {},
      rateLimitedUntil: null,
      temporaryUnavailableReason: null,
      errorReason: null,
    })),
    sessionAffinity: { version: 1, savedAt, entries },
  };
}

/**
 * `persistState()` 1回の所要を、**proxy-server の persistState 経路そのもの**で測る。
 * `createProxyServer` に `stateWriter` を渡し、`POST /internal/prepare-resume`
 * （末尾で `await persistState()` する経路）を叩いて、その応答までの時間を取る。
 * `writeJsonFileDurable` 単体の時間は `stateWriter` の内側で別に計る。
 */
async function measurePersist({ label, sessionAffinity, withTable }) {
  const nowMs = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'rotator-bench-u16-'));
  const statePath = join(dir, 'runtime-state.json');
  const writeMs = [];
  const stateWriter = async state => {
    const startedAt = performance.now();
    await writeJsonFileDurable(statePath, state);
    writeMs.push(performance.now() - startedAt);
  };

  const savedState = withTable ? savedStateWithTable(SESSIONS, nowMs) : null;
  const accountManager = new AccountManager({
    accounts: benchAccounts(),
    switchThreshold: 1,
    logger: null,
    // src/cli.js の runServer と同じ決め方（§5.2(b)）。復元より前に決めないと効かない。
    eventHistory: Boolean(sessionAffinity) && sessionAffinity.mode !== 'off',
  });
  const credentialChangedAccountIds = savedState ? accountManager.restoreState(savedState) : null;
  const server = createProxyServer({
    accountManager,
    secretStore: new MemorySecretStore(),
    logger: null,
    savedState,
    credentialChangedAccountIds,
    stateWriter,
    config: {
      // 上流へは1件も送らない（叩くのは /internal/* だけである）。
      upstream: 'http://127.0.0.1:1',
      usagePolling: { enabled: false },
      ...(sessionAffinity ? { sessionAffinity } : {}),
    },
  });
  const port = await listen(server);

  const status = JSON.parse((await getJson(port, '/internal/status')).bodyText);
  const restoredSessions = status.sessionAffinity ? status.sessionAffinity.sessions : 0;

  const totalMs = [];
  for (let iteration = 0; iteration < U16_ITERATIONS; iteration += 1) {
    const startedAt = performance.now();
    const response = await postJson(port, '/internal/prepare-resume', '{}');
    totalMs.push(performance.now() - startedAt);
    if (response.status !== 200) throw new Error(`prepare-resume failed: ${response.status}`);
  }

  const stateBytes = (await stat(statePath)).size;
  await close(server);
  await rm(dir, { recursive: true, force: true });

  return {
    label,
    path: 'proxy-server の persistState 経路（createProxyServer に stateWriter を渡し POST /internal/prepare-resume で起動）',
    mode: sessionAffinity ? sessionAffinity.mode : '（未記載＝off）',
    iterations: U16_ITERATIONS,
    restoredSessions,
    stateFileBytes: stateBytes,
    writeCount: writeMs.length,
    persistStateMs: {
      median: round(median(totalMs), 3),
      p90: round(percentile(totalMs, 0.9), 3),
      max: round(Math.max(...totalMs), 3),
      min: round(Math.min(...totalMs), 3),
    },
    durableWriteOnlyMs: {
      median: round(median(writeMs), 3),
      p90: round(percentile(writeMs, 0.9), 3),
      max: round(Math.max(...writeMs), 3),
    },
    limitMs: U16_LIMIT_MS,
    withinLimit: percentile(totalMs, 0.9) < U16_LIMIT_MS,
  };
}

// --- 実行 -------------------------------------------------------------------

async function main() {
  if (typeof global.gc !== 'function') {
    process.stderr.write(
      'このベンチは --expose-gc が要る: node --expose-gc scripts/bench-session-affinity.mjs\n',
    );
    process.exitCode = 2;
    return;
  }

  const environment = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: new Date().toISOString(),
  };

  const u8 = measureU8();
  const u16 = {
    ledgerOnly: await measurePersist({ label: '(a) 口座台帳のみ（mode off）', sessionAffinity: undefined, withTable: false }),
    withTable: await measurePersist({
      label: '(b) 1万件の表込み（mode on・persist true）',
      sessionAffinity: { mode: 'on', persist: true, maxSessions: SESSIONS },
      withTable: true,
    }),
  };

  const report = { bench: 'session-affinity', environment, u8, u16 };
  process.stdout.write(`${JSON.stringify(report)}\n`);

  process.stdout.write('\n--- U8: 1万セッションの常駐ヒープ増（§13 U8）---\n');
  process.stdout.write(`Node ${environment.node} / ${environment.platform} / ${environment.startedAt}\n`);
  process.stdout.write(`セッション ${u8.sessions} 件（うち副バインドあり ${u8.entriesWithFamilyBind} 件）を ${u8.repeats} 回\n`);
  process.stdout.write(`heapUsed 増: 中央値 ${u8.heapUsedMedianMiB} MiB（最小 ${u8.heapUsedMinMiB} / 最大 ${u8.heapUsedMaxMiB}）= ${u8.bytesPerSession} B/件\n`);
  process.stdout.write(`rss 増: 中央値 ${u8.rssMedianMiB} MiB\n`);
  process.stdout.write(`判定: ${u8.withinLimit ? '24 MiB 以内' : '24 MiB 超過（母艦判断へ）'}（実測 ${u8.heapUsedMedianMiB} MiB / 上限 ${u8.limitMiB} MiB）\n`);
  process.stdout.write(`2案との比: Opus 案 2.4MB の ${u8.ratioToOpusEstimate} 倍 ／ Astra 案 10MiB の ${u8.ratioToAstraEstimateLow} 倍\n`);
  process.stdout.write(`保存スナップショット（export()）の JSON: ${u8.exportedSnapshotBytes} バイト\n`);

  process.stdout.write('\n--- U16: persistState 1回の所要（§13 U16・§8 の5秒上限）---\n');
  for (const measurement of [u16.ledgerOnly, u16.withTable]) {
    process.stdout.write(`${measurement.label}: mode=${measurement.mode} 復元 ${measurement.restoredSessions} 件 / 保存ファイル ${measurement.stateFileBytes} バイト\n`);
    process.stdout.write(`  測った経路: ${measurement.path}\n`);
    process.stdout.write(`  persistState: 中央値 ${measurement.persistStateMs.median} ms / p90 ${measurement.persistStateMs.p90} ms / 最大 ${measurement.persistStateMs.max} ms（${measurement.iterations} 回）\n`);
    process.stdout.write(`  うち writeJsonFileDurable 単体: 中央値 ${measurement.durableWriteOnlyMs.median} ms / p90 ${measurement.durableWriteOnlyMs.p90} ms / 最大 ${measurement.durableWriteOnlyMs.max} ms\n`);
    process.stdout.write(`  判定: ${measurement.withinLimit ? '5,000 ms のデバウンス上限内' : '5,000 ms 超過（母艦判断へ）'}\n`);
  }
}

await main();
