// 不変性テスト（OSS 独立性 / 設計書 §14・§14.4・§11.1 R5-2）。
//
// 方針: ClaudeRotator は OSS として単体でも使われるため、codex-rotator が無くても
// 動作すること（codex-rotator との連携は明示的に有効化したときだけ働く）。
//
// このファイルが固定するのは次の8点である。1〜5 は「codex-rotator が無い環境でも
// ClaudeRotator が壊れない」という受入条件の実体（設計書 §14.4 の一覧）であり、
// 6〜8 は sticky affinity（セッション単位の口座固定）の不変性3件
// （sticky 設計書 v1.5 §10「不変性」／実装計画 v1.2 R-S13）である。
//
//   1. never-reads-codex-credentials-in-claude-process
//   2. health-does-not-wait-for-codex-or-refresh
//   3. unset-config-is-byte-identical
//   4. codex-rotator-absent-is-harmless
//   5. no-identifier-in-degrade-logs
//   6. session-affinity-unset-is-byte-identical
//   7. does-not-touch-gpt-path
//   8. no-raw-session-id-in-logs
//
// 実装方針:
//   - すべて実 TCP（port 0 で listen する）ので、他のテストファイルと並行実行しても
//     ポートが衝突しない。固定ポートは1つも使わない。
//   - 時刻依存の判定を持ち込まない（AccountManager の now は固定値）。唯一の時間比較は
//     テスト2の「health が期限より十分早く返る」だが、判定の決め手は時間ではなく
//     「codexStatusUrl へ接続すらしない」「点検側は実際に止まったまま」という観測であり、
//     経過時間は補助的な上限にすぎない。閾値は絶対値ではなく設定値との相対で取り、
//     CI の遅い環境で誤って落ちないようにしてある（HEALTH_ELAPSED_CEILING_MS）。
//   - fixture には実在の資格情報・実ラベル・実メールアドレスを一切書かない。
//     `.codex/auth.json` の中身は本ファイルで生成する合成の目印文字列である。

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AccountManager } from '../src/account-manager.js';
import { createGptPoolState, parseBridgeContract } from '../src/degrade-state.js';
import { runCli } from '../src/cli.js';
import { LOCAL_GATEWAY_AUTH_TOKEN } from '../src/config.js';
import { writeJsonFileDurable } from '../src/json-file.js';
import { renderStatus } from '../src/monitor.js';
import { createProxyServer } from '../src/proxy-server.js';
import { MemorySecretStore } from '../src/secret-store.js';
import { normalizeSessionAffinity, sidHash } from '../src/session-affinity.js';
import { startFakeBridge } from './helpers/fake-bridge.js';

const cleanupCallbacks = [];

afterEach(async () => {
  const callbacks = cleanupCallbacks.splice(0).reverse();
  for (const callback of callbacks) {
    try {
      await callback();
    } catch {
      // 後片付けの失敗でテスト結果を塗り替えない。
    }
  }
});

function cleanupAfterTest(callback) {
  cleanupCallbacks.push(callback);
}

// ---------------------------------------------------------------------------
// 1. never-reads-codex-credentials-in-claude-process
//
// 設計書 §5.1「ClaudeRotator が持たないもの」: Codex（ChatGPT）の資格情報。
// rotator が codex-rotator の認証ファイルへ触れないことを、静的（src/ の走査）と
// 動的（一時 HOME に置いた目印ファイルが読まれない）の両面で固定する。
// ---------------------------------------------------------------------------

// 走査対象は「npm へ同梱され利用者の環境で実行されるコード」＝package.json の files が
// 挙げる src/ と bin/ の両方。bin/claude-rotator.js は src/cli.js を呼ぶだけのシムだが、
// 同梱される以上ここも不変条件の対象に含める。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOTS = Object.freeze([join(REPO_ROOT, 'src'), join(REPO_ROOT, 'bin')]);

// 拾いたいのは「Codex の資格情報へ触れるコード」だけなので、パターンは文脈まで見る。
//   - `.codex` は引用符かスラッシュに続くとき（＝パスの一部）だけ拾い、`options.codex` /
//     `raw.codexStatusUrl` のようなプロパティ名は拾わない。
//   - `auth.json` も同じくパス文脈のときだけ拾う（散文での言及は違反ではない）。
//   - `CODEX_HOME` は環境変数として読むとき（`process.env.CODEX_HOME` / `env['CODEX_HOME']`）
//     だけ拾う。
// パターンが実際に違反を捕まえられることは、下の「positive control」で毎回確かめる。
const CODEX_CREDENTIAL_PATTERNS = Object.freeze([
  { label: '.codex path segment', pattern: /['"`/]\.codex(?![A-Za-z0-9_$])/ },
  { label: 'auth.json path', pattern: /['"`/]auth\.json/ },
  { label: 'CODEX_HOME env read', pattern: /(?:\.|\[\s*['"`]|['"`])CODEX_HOME/ },
]);

// スキャナが「何にも一致しないから緑」になっていないことを示す見本（違反の再現）。
const CODEX_CREDENTIAL_VIOLATIONS = Object.freeze([
  "const codexAuth = join(homedir(), '.codex', 'auth.json');",
  'const codexAuth = `${home}/.codex/auth.json`;',
  "const codexHome = process.env.CODEX_HOME || join(home, '.codex');",
  "await readFile(env['CODEX_HOME'] + '/auth.json', 'utf8');",
  // bin/ のシム相当（起動前に資格情報を覗く形）も同じパターンで捕まること。
  "const { runCli } = await import('../src/cli.js'); await import(join(home, '.codex', 'auth.json'));",
]);

// 逆に、拾ってはいけない現行コードの見本（プロパティ名・設定キー名）。
const CODEX_CREDENTIAL_NON_VIOLATIONS = Object.freeze([
  'lines.push(...renderCodexSection(options.codex, now));',
  'const codexStatusUrl = normalizeCodexStatusUrl(raw.codexStatusUrl);',
  "  'degradeMapping.codexStatusUrl must be loopback; codex status section disabled';",
]);

function findCodexCredentialHits(text, label) {
  const hits = [];
  text.split('\n').forEach((line, index) => {
    for (const pattern of CODEX_CREDENTIAL_PATTERNS) {
      if (pattern.pattern.test(line)) hits.push(`${label}:${index + 1} [${pattern.label}]`);
    }
  });
  return hits;
}

async function collectJsFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectJsFiles(path, out);
    else if (entry.isFile() && path.endsWith('.js')) out.push(path);
  }
  return out;
}

describe('never-reads-codex-credentials-in-claude-process (設計書 §5.1・§14.4)', () => {
  it('uses a scanner that actually catches a Codex credential access (positive control)', () => {
    // このテストが無いと、パターンを壊しても「一致0件」で緑になってしまう。
    for (const violation of CODEX_CREDENTIAL_VIOLATIONS) {
      assert.notDeepEqual(
        findCodexCredentialHits(violation, 'sample'),
        [],
        `違反の見本を検出できていない: ${violation}`,
      );
    }
    for (const allowed of CODEX_CREDENTIAL_NON_VIOLATIONS) {
      assert.deepEqual(
        findCodexCredentialHits(allowed, 'sample'),
        [],
        `現行コードを誤検出している: ${allowed}`,
      );
    }
  });

  it('has no reference to a Codex credential path anywhere under src/ or bin/', async () => {
    // test/helpers/fake-bridge.js は codex-rotator のスタブなので対象外。
    // 見るのは配布物に載る src/ と bin/ の配下だけである。
    const files = [];
    for (const root of SCAN_ROOTS) {
      const found = await collectJsFiles(root);
      assert.ok(found.length > 0, `${root} に .js が1つも無いなら走査条件が壊れている`);
      files.push(...found);
    }

    const hits = [];
    for (const file of files) {
      hits.push(...findCodexCredentialHits(await readFile(file, 'utf8'), file));
    }

    assert.deepEqual(
      hits,
      [],
      'ClaudeRotator のプロセス（src/ と、同梱される bin/ のシム）は Codex の資格情報'
      + '（~/.codex/auth.json・CODEX_HOME）を一切参照しない。連携は codex-rotator の'
      + 'HTTP 応答からだけ学習する（設計書 §5.1）',
    );
  });

  it('touches no ~/.codex file while degradeMapping is enabled and a gpt-* request is served', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rotator-invariance-home-'));
    cleanupAfterTest(async () => rm(home, { recursive: true, force: true }));

    // 目印は本ファイルで生成した合成文字列であり、実在の資格情報ではない。
    const sentinel = `codex-credential-sentinel-${Math.random().toString(36).slice(2)}`;
    const codexDir = join(home, '.codex');
    const authPath = join(codexDir, 'auth.json');
    const controlPath = join(codexDir, 'atime-control.json');
    await mkdir(codexDir, { recursive: true });
    await writeFile(authPath, JSON.stringify({ tokens: { access_token: sentinel } }));
    await writeFile(controlPath, JSON.stringify({ marker: 'control' }));

    // このファイルシステムが atime を更新するかを実測してから使う。更新しない環境
    // （noatime マウント等）では atime 比較を主張しない＝偽陰性で落ちない。
    const controlBefore = await stat(controlPath);
    await new Promise(done => { setTimeout(done, 20); });
    await readFile(controlPath, 'utf8');
    const controlAfter = await stat(controlPath);
    const atimeIsTracked = controlAfter.atimeMs > controlBefore.atimeMs;
    const authBefore = await stat(authPath);

    const originalHome = process.env.HOME;
    const originalCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CODEX_HOME = codexDir;

    let response;
    const logLines = [];
    try {
      const bridge = await startFakeBridge({ port: 0, mode: 'exhausted' });
      cleanupAfterTest(async () => bridge.close());
      const proxy = await startProxy({
        logLines,
        openaiBridge: bridgeConfig(bridge.url, { degradeMapping: { enabled: true } }),
      });
      response = await askAstra(proxy);
    } finally {
      restoreEnv('HOME', originalHome);
      restoreEnv('CODEX_HOME', originalCodexHome);
    }

    // 経路が実際に通ったこと（＝観測が空振りでないこと）を先に確かめる。
    assert.equal(response.status, 529, 'Claude 側が使えるうちは 529 のまま素通しする');

    const authAfter = await stat(authPath);
    if (atimeIsTracked) {
      assert.equal(
        authAfter.atimeMs,
        authBefore.atimeMs,
        '~/.codex/auth.json の atime が動いた＝rotator が Codex の資格情報を読んでいる',
      );
    }
    assert.deepEqual(
      (await readdir(home)).sort(),
      ['.codex'],
      'rotator は HOME 配下に何も作らない（.codex はテストが置いたもの）',
    );
    assert.deepEqual(
      (await readdir(codexDir)).sort(),
      ['atime-control.json', 'auth.json'],
      'rotator は ~/.codex 配下に何も作らない・消さない',
    );

    const leaked = [response.bodyText, JSON.stringify(response.headers), ...logLines]
      .filter(text => text.includes(sentinel));
    assert.deepEqual(leaked, [], '目印文字列が応答にもログにも現れない（読んでいないので当然）');
  });
});

// ---------------------------------------------------------------------------
// 2. health-does-not-wait-for-codex-or-refresh
//
// 設計書 §9.6 の理由①②: /internal/health は「安価な生存確認」であり、
// codex-rotator への取得も資格情報の点検も待たない。codex-rotator の統合表示は
// CLI 側だけの機能であり、proxy-server には1行も入っていない（それをここで固定する）。
// ---------------------------------------------------------------------------

// 経過時間は判定の決め手ではなく「待っていたら絶対に超える」ことを示す補助的な上限。
// 遅い CI でも誤失敗しないよう、設定値との相対（timeout の半分）とこの絶対上限の
// 小さいほうを使う。
const HEALTH_ELAPSED_CEILING_MS = 2000;

describe('health-does-not-wait-for-codex-or-refresh (設計書 §9.6・§14.4)', () => {
  it('answers well before the codex status timeout while that socket never replies', async () => {
    // 接続は受けるが1バイトも返さないサーバ（fake-bridge の idle 相当を TCP だけで作る）。
    const silent = await startSilentServer();
    cleanupAfterTest(async () => silent.close());
    const bridge = await startFakeBridge({ port: 0, mode: 'ok' });
    cleanupAfterTest(async () => bridge.close());

    const codexStatusTimeoutMs = 30_000;
    const proxy = await startProxy({
      openaiBridge: bridgeConfig(bridge.url, {
        degradeMapping: {
          enabled: true,
          codexStatusUrl: `${silent.url}/healthz`,
          codexStatusTimeoutMs,
        },
      }),
    });

    const startedAt = Date.now();
    const health = await requestJson(`${proxy.url}/internal/health`);
    const elapsed = Date.now() - startedAt;

    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.bodyText).ok, true);
    // 決め手は下の connectionCount()===0（＝そもそも接続しない）。経過時間は
    // 「待っていたら codexStatusTimeoutMs まで掛かる」ことに対する相対的な上限で見る。
    const elapsedBudgetMs = Math.min(codexStatusTimeoutMs / 2, HEALTH_ELAPSED_CEILING_MS);
    assert.ok(
      elapsed < elapsedBudgetMs,
      `/internal/health は codex-rotator を待たない（codexStatusTimeoutMs=${codexStatusTimeoutMs}ms `
      + `に対し実測 ${elapsed}ms。${elapsedBudgetMs}ms 未満であること）`,
    );
    assert.equal(silent.connectionCount(), 0, 'proxy-server は codexStatusUrl へ接続すらしない');
  });

  it('answers while the initial credential check is still blocked', async () => {
    // 資格情報の点検（operationalStateCheck）が固まっている状態を作る。
    // /internal/health はこの await より手前で応答する（src/proxy-server.js のコメント）。
    const unblock = { release: null };
    const blocked = new Promise(resolveBlocked => { unblock.release = resolveBlocked; });
    cleanupAfterTest(async () => unblock.release?.());

    const secretStore = new MemorySecretStore();
    await secretStore.set('acct_1', { accessToken: 'access-token-1' });
    secretStore.get = async () => { await blocked; return null; };

    const proxy = await startProxy({ secretStore });

    const startedAt = Date.now();
    const health = await requestJson(`${proxy.url}/internal/health`);
    const elapsed = Date.now() - startedAt;

    assert.equal(health.status, 200, '資格情報の点検が終わっていなくても health は 200 を返す');
    // 決め手は下の「/internal/status は保留のまま」（＝点検が実際に止まっている）。
    // 経過時間はそれに対する補助的な上限であり、遅い CI でも誤失敗しない値を使う。
    assert.ok(
      elapsed < HEALTH_ELAPSED_CEILING_MS,
      `health は資格情報の点検を待たない（実測 ${elapsed}ms。${HEALTH_ELAPSED_CEILING_MS}ms 未満であること）`,
    );

    // 空振り防止: 同じ状態で /internal/status は実際に止まっていること。これが無いと
    // 「点検が一瞬で終わっただけ」でも通ってしまい、health の早さを何も証明しない。
    const pending = requestJson(`${proxy.url}/internal/status`);
    pending.catch(() => {});
    const raced = await Promise.race([
      pending.then(() => 'settled'),
      new Promise(done => { setTimeout(() => done('pending'), 400); }),
    ]);
    assert.equal(raced, 'pending', '/internal/status は点検を待つ（＝点検が実際に止まっている）');
  });
});

// ---------------------------------------------------------------------------
// 3. unset-config-is-byte-identical
//
// 設計書 §14.1: 判定式は settings.degradeMapping.enabled === true の1つだけであり、
// セクションが無い構成は「enabled: false を明示した構成」と完全に同じ意味になる。
// 比較対象は /internal/health・/internal/status・gpt-* 要求・claude-* 要求の
// status / ヘッダ / 本文と、出力されたログ行（時刻と所要時間だけ正規化）である。
// ※ 比較元コミットの取り寄せ（git worktree 等）は行わない。ここで固定するのは
//   「未指定＝明示的な無効」という等価性であって、過去の版との突合ではない。
// ---------------------------------------------------------------------------

describe('unset-config-is-byte-identical (設計書 §14.1・§7.3-3)', () => {
  it('produces the same responses and log lines with and without an explicit degradeMapping', async () => {
    const bridge = await startFakeBridge({ port: 0, mode: 'legacy' });
    cleanupAfterTest(async () => bridge.close());
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    // 2つの構成で「同じ偽 bridge・同じ偽 Anthropic 上流」に対し同じ順序で叩く。
    const unset = await exerciseProxy({ bridge, upstream, degradeMapping: undefined });
    const explicitlyDisabled = await exerciseProxy({
      bridge,
      upstream,
      degradeMapping: { enabled: false },
    });

    assert.deepEqual(
      unset.observations,
      explicitlyDisabled.observations,
      'degradeMapping 未指定と enabled:false は、status・ヘッダ集合・本文まで完全に一致する',
    );
    assert.deepEqual(
      unset.logLines,
      explicitlyDisabled.logLines,
      'ログ行も一致する（追記フィールドが1つも出ない）',
    );
    assert.equal(
      unset.logLines.filter(line => /degradeMapping|gptPoolState|claudePoolState|mapReason/.test(line)).length,
      0,
      '無効な構成では degradeMapping 由来の行・フィールドが1つも出ない',
    );

    // 空振り防止: 4種類の観測とログがすべて成立していることを確かめる
    // （空配列どうしの一致で緑になっていないこと）。
    assert.deepEqual(
      unset.observations.map(observation => `${observation.name}:${observation.status}`),
      ['health:200', 'status:200', 'gpt:429', 'claude:200'],
    );
    assert.ok(unset.logLines.length > 0, '比較対象のログ行が1行も無いなら比較が空振りしている');
    assert.ok(
      unset.observations.every(observation => observation.headers.length > 0 && observation.bodyText !== ''),
      '各観測にヘッダと本文があること（比較が空振りしていないこと）',
    );
  });

  it('recoveryWait off keeps T2b/T6b/cache-exclusion inactive (層1 もフラグ配下)', async () => {
    // 統合設計 v2.1 §2.1 案A: 層1（T2b・T6b・キャッシュ非学習）は 403 書換の条件③
    // （gptPoolState !== 'unusable'）を通じて応答バイトを変えうるので、層2 と同じ
    // フラグの配下に置く。ここでは「off なら1バイトも変わらない」を2段で固定する。
    const bridge = await startFakeBridge({ port: 0, mode: 'exhausted' });
    cleanupAfterTest(async () => bridge.close());
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    // (a) 応答とログ行: 未指定・false・非真偽値（'true'）の3構成が完全に一致する。
    const enabledOnly = await exerciseProxy({ bridge, upstream, degradeMapping: { enabled: true } });
    const explicitFalse = await exerciseProxy({
      bridge, upstream, degradeMapping: { enabled: true, recoveryWaitEnabled: false },
    });
    const notABoolean = await exerciseProxy({
      bridge, upstream, degradeMapping: { enabled: true, recoveryWaitEnabled: 'true' },
    });
    assert.deepEqual(enabledOnly.observations, explicitFalse.observations);
    assert.deepEqual(enabledOnly.logLines, explicitFalse.logLines);
    assert.deepEqual(enabledOnly.observations, notABoolean.observations, '真偽値でない値は false へ倒れる');
    assert.deepEqual(enabledOnly.logLines, notABoolean.logLines);
    assert.equal(
      enabledOnly.logLines.filter(line => /retryAfter=| cached=|Retry-After/.test(line)).length,
      0,
      'off では待機・キャッシュ由来の追記フィールドが1つも出ない',
    );
    // 空振り防止: gpt-* 要求が実際に 529（枯渇の素通し。Claude 側に空きがあるので
    // 403 へは昇格しない）で返り、その過程で (pool)=unusable の学習が走っていること。
    assert.deepEqual(
      enabledOnly.observations.map(observation => `${observation.name}:${observation.status}`),
      ['health:200', 'status:200', 'gpt:529', 'claude:200'],
    );
    assert.ok(
      enabledOnly.logLines.some(line => /gptPoolState=unusable/.test(line)),
      '層1 の学習が実際に走っている（比較が空振りしていない）',
    );

    // (b) 層1 の3点が off で発火しないこと（純関数の側で直接固定する）。
    const learned = Date.parse('2026-09-14T00:00:00Z');
    let nowMs = learned;
    const off = createGptPoolState({ now: () => nowMs, recoveryWaitEnabled: false });
    const denial = {
      'x-ombr-contract': '1',
      'x-ombr-degrade-reason': 'codex_pool_exhausted',
      'x-ombr-degrade-scope': 'pool',
      'x-ombr-pool-state': 'exhausted',
      'x-ombr-upstream-status': '429',
      'x-ombr-reset-at': '2099-01-01T00:00:00Z',
      'x-ombr-cached': 'yes',
    };
    assert.equal(
      off.observe(parseBridgeContract(denial), 529, 'gpt-6-astra').transition,
      'T3',
      'キャッシュ非学習は off では効かない（現行どおり学習する）',
    );
    nowMs = learned + 24 * 3_600_000;
    assert.equal(off.read().pool.state, 'unusable', 'T6b は off では効かない（resetAt まで固着する）');
    assert.equal(
      off.observe(parseBridgeContract({
        'x-ombr-contract': '1',
        'x-ombr-upstream-status': '200',
        'x-ombr-upstream-sent': 'yes',
      }), 200, 'gpt-6-astra').transition,
      null,
      'T2b は off では発火しない',
    );
    assert.equal(off.read().pool.state, 'unusable');
  });

  async function exerciseProxy({ bridge, upstream, degradeMapping }) {
    const logLines = [];
    const proxy = await startProxy({
      logLines,
      upstream: upstream.url,
      openaiBridge: bridgeConfig(bridge.url, degradeMapping ? { degradeMapping } : {}),
    });

    const observations = [];
    observations.push(summarize('health', await requestJson(`${proxy.url}/internal/health`)));
    observations.push(summarize('status', await requestJson(`${proxy.url}/internal/status`)));
    observations.push(summarize('gpt', await askAstra(proxy)));
    observations.push(summarize('claude', await askClaude(proxy)));

    return { observations, logLines: normalizeLogLines(logLines) };
  }
});

// ---------------------------------------------------------------------------
// 4. codex-rotator-absent-is-harmless
//
// 設計書 §14.2: degradeMapping.enabled が真でも codex-rotator が動いていない構成で、
// claude-* 要求も /internal/health も `claude-rotator status` も現行どおり働く。
// ---------------------------------------------------------------------------

describe('codex-rotator-absent-is-harmless (設計書 §14.2)', () => {
  const claudeStatus = {
    currentAccount: 'acct_1',
    currentAccountName: 'user-a@example.com',
    accounts: [{
      id: 'acct_1',
      name: 'user-a@example.com',
      status: 'active',
      quota: { unified5h: 0.76, unified7d: 0.4 },
      usage: { totalRequests: 1 },
    }],
    events: [],
  };

  it('keeps claude-* traffic, /internal/health and the status screen working with codex-rotator down', async () => {
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());
    // 誰も listen していないループバックポート＝codex-rotator 不在の再現。
    const deadPort = await unusedLoopbackPort();
    const codexStatusUrl = `http://127.0.0.1:${deadPort}/healthz`;
    const config = {
      openaiBridge: {
        enabled: true,
        url: 'http://127.0.0.1:18765',
        degradeMapping: { enabled: true, codexStatusUrl, codexStatusTimeoutMs: 400 },
      },
    };

    const proxy = await startProxy({
      upstream: upstream.url,
      openaiBridge: config.openaiBridge,
    });

    const claude = await askClaude(proxy);
    assert.equal(claude.status, 200, 'codex-rotator が居なくても claude-* は現行どおり通る');
    assert.equal(JSON.parse(claude.bodyText).ok, true);
    assert.equal((await requestJson(`${proxy.url}/internal/health`)).status, 200);

    // CLI 側（src/cli.js の readCodexStatus）は1行だけ落として Claude 側を描き切る。
    const io = createIo();
    const startedAt = Date.now();
    const code = await runCli(['status'], {
      ...io,
      readStatus: async () => claudeStatus,
      loadConfig: async () => config,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(code, 0);
    assert.match(io.output(), /Codex Rotator\s+codex: unreachable \(/, 'Codex 節は1行の未到達表示になる');
    assert.match(io.output(), /user-a@example\.com\s+active/, 'Claude 側の表示は壊れない');
    assert.match(io.output(), /5h ███████░░░  76%/);
    assert.ok(elapsed < 5000, `status は codex-rotator 不在でハングしない（実測 ${elapsed}ms）`);
  });
});

// ---------------------------------------------------------------------------
// 5. no-identifier-in-degrade-logs
//
// 設計書 §13.1 CR-I: 画面出力以外の経路（ログ行・ヘッダ）に個人を特定できる識別子を
// 出さない。ラベル（acct-a）は可、メールアドレス・ホームパス・資格情報は不可。
// ---------------------------------------------------------------------------

const FORBIDDEN_LOG_SUBSTRINGS = Object.freeze(['@', '/Users/', 'Bearer', 'sk-']);

describe('no-identifier-in-degrade-logs (設計書 §13.1 CR-I)', () => {
  it('writes only labels while rewriting an exhausted response to 403', async () => {
    const bridge = await startFakeBridge({ port: 0, mode: 'exhausted', account: 'acct-a' });
    cleanupAfterTest(async () => bridge.close());

    const logLines = [];
    // 口座名にダミーのメールアドレスを入れておき、それがログへ漏れないことを見る。
    const accountManager = new AccountManager({
      accounts: [{ id: 'acct_1', name: 'user-a@example.com', type: 'oauth' }],
      now: () => 1000,
    });
    const proxy = await startProxy({
      accountManager,
      logLines,
      openaiBridge: bridgeConfig(bridge.url, { degradeMapping: { enabled: true } }),
    });

    // Claude 側も全枯渇にして 403 書換（両プール利用不可）まで走らせる。
    accountManager.markRateLimited('acct_1', 60);
    const response = await askAstra(proxy);

    assert.equal(response.status, 403, '両プール利用不可なので明示停止する＝書換経路を通った');
    const degradeLines = logLines.filter(line => / openai-bridge /.test(line));
    assert.ok(degradeLines.length > 0, '縮退のログ行が出ていること（空振り防止）');
    assert.ok(
      degradeLines.some(line => line.includes('accountLabel=acct-a')),
      'codex-rotator が返したラベルは記録してよい',
    );

    const offenders = [];
    for (const line of logLines) {
      for (const needle of FORBIDDEN_LOG_SUBSTRINGS) {
        if (line.includes(needle)) offenders.push(`[${needle}] ${line}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'ログにメールアドレス・ホームパス・認可ヘッダ・API キーらしき文字列を出さない',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. session-affinity-unset-is-byte-identical
//    （設計書 §10「不変性」1件目・§14.1・§7.3・§8・D-56-6 ／ 実装計画 v1.2 R-S13）
//
// 固定するのは「`sessionAffinity` を1文字も書いていない構成は、`mode:"off"` を明示した
// 構成とまったく同じ意味である」こと。比較は4点で、いずれも**実物**を突き合わせる。
//
//   (a) proxy のログ行     … 追記フィールド `sid=` / `aff=` / `fam=` が1つも生えない
//   (b) /internal/status   … JSON に `sessionAffinity` キーが出ない
//   (c) `claude-rotator status` … monitor.renderStatus の結果に Session Affinity 節が無い
//   (d) runtime-state.json … **実ファイルのバイト列**。`sessionAffinity` も `events` も
//                            書かれない（D-56-6 の要点。v1.0 にあった「保存ファイルの
//                            差分は許容する」という緩和は §7.3 で撤回済み）
//
// さらに**再起動をまたぐ経路**を検査する——保存されたファイルだけを入力に、新しい
// プロセス相当（新しい AccountManager ＋ restoreState ＋ 新しい createProxyServer）を
// 立ち上げ直し、復元直後の (b)(c) と、要求を通したあとの (a)〜(d) をもう一度突き合わせる。
// §7.3 が要求する「復元直後も Events 節が空のまま」はここで押さえる（`mode:"off"` では
// events を保存も復元もしないため）。
//
// ■ 比較の対象外（明示除外。R-S13 の通過条件）
//
//   1. **R-S2 由来の既知例外2点**（設計書 §14.1・坂根氏の判断⑤(c)＝案A で承認済み）:
//        ① サブキャップ由来の 429 で `currentIndex` が動かなくなる
//        ② `switchToCandidate` を呼ばなくなるぶん `status='active'` の付け替えが消え、
//           `/internal/status` と `claude-rotator status` の `active` の付き方が変わる
//      この2点は **`sessionAffinity` の mode に連動しない常時適用の是正**であり、未記載
//      構成でも `mode:"off"` 構成でも同じように起きる。したがって本テストが比べている
//      2つの構成の**あいだには差が出ない**。「是正を入れる前との差」は本テストの対象では
//      なく、段 P の本番実地確認（実装計画 v1.2 §3 段 P ③）が受け持つ。
//
//   2. **R-S1 の `account_switch` 行**: これは**新設の行**であって、既存 proxy 行の形の
//      変更ではない（設計書 §7.2・実装計画 v1.2 §5「R7 の破れ」）。(a) が固定するのは
//      「既存の proxy 行に追記フィールドが生えないこと」なので、新設行は (a) の対象外で
//      ある。こちらも mode に連動しないため、2構成の比較には現れない。
// ---------------------------------------------------------------------------

describe('session-affinity-unset-is-byte-identical (設計書 §10・§14.1・§7.3・§8)', () => {
  it('produces the same log lines, status JSON, status screen and runtime-state.json with and without an explicit sessionAffinity', async () => {
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    // 同じ偽上流に対し、同じ順序で同じ4要求を通す（片方は節そのものが無い構成）。
    // R-S2 の既知例外2点（currentIndex を動かさない／`active` の付け替えが消える）は
    // mode に連動しない常時適用の是正なので、この2つの構成の**どちらにも同じように**
    // 効いている。R-S1 の `account_switch` は新設行で既存 proxy 行の形を変えない。
    // よってどちらも「未記載 ⇔ 明示 off」の差にはならず、本比較の対象外である。
    const unset = await exerciseAffinity({ upstream, sessionAffinity: undefined });
    const explicitlyOff = await exerciseAffinity({ upstream, sessionAffinity: { mode: 'off' } });

    for (const [phase, left, right] of [
      ['初回起動', unset.first, explicitlyOff.first],
      ['再起動後', unset.restarted, explicitlyOff.restarted],
    ]) {
      assert.deepEqual(left.logLines, right.logLines, `${phase}: (a) proxy のログ行が一致する`);
      assert.equal(left.statusJson, right.statusJson, `${phase}: (b) /internal/status の JSON が一致する`);
      assert.equal(left.screen, right.screen, `${phase}: (c) status 画面が一致する`);
      assert.equal(left.stateFile, right.stateFile, `${phase}: (d) runtime-state.json のバイト列が一致する`);
      assert.equal(left.restoredStatusJson, right.restoredStatusJson, `${phase}: 起動直後の status JSON が一致する`);
      assert.equal(left.restoredScreen, right.restoredScreen, `${phase}: 起動直後の status 画面が一致する`);
      assert.equal(left.writeCount, right.writeCount, `${phase}: 保存の回数まで一致する`);
    }

    assertNoAffinityArtifacts(unset.first, '未記載構成・初回起動');
    assertNoAffinityArtifacts(unset.restarted, '未記載構成・再起動後');
    assertNoAffinityArtifacts(explicitlyOff.first, 'mode:"off" 構成・初回起動');
    assertNoAffinityArtifacts(explicitlyOff.restarted, 'mode:"off" 構成・再起動後');

    // 再起動をまたぐ経路の本題（§7.3）: 復元した直後の Events 節が空のままであること。
    // `events` を保存しないので、復元しても描くものが無い＝現行と同じ画面になる。
    for (const [label, observation] of [
      ['未記載構成', unset.restarted],
      ['mode:"off" 構成', explicitlyOff.restarted],
    ]) {
      assert.deepEqual(
        JSON.parse(observation.restoredStatusJson).events,
        [],
        `${label}: 復元直後の events が空（保存も復元もしていない・D-56-6）`,
      );
      assert.ok(
        observation.restoredScreen.endsWith('Events\n'),
        `${label}: 復元直後の Events 節に1行も描かれない`,
      );
    }

    // 空振り防止: 4点の観測がすべて成立していること（空どうしの一致で緑になっていない）。
    assert.equal(
      unset.first.logLines.filter(line => / proxy account=/.test(line)).length,
      STICKY_REQUESTS.length,
      '比較対象の proxy 行が要求の数だけ出ていること',
    );
    assert.match(unset.first.statusJson, /"accounts":/);
    assert.match(unset.first.screen, /Claude Rotator/);
    assert.match(unset.first.stateFile, /"version": 1/);
    assert.ok(unset.first.writeCount > 0, 'runtime-state.json が実際に書かれていること');
  });

  it('detects a difference in all four places once the mode is actually on (positive control)', async () => {
    // このテストが無いと、4つの比較子を壊しても「差が無い」で緑になってしまう。
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    const unset = await exerciseAffinity({ upstream, sessionAffinity: undefined });
    const on = await exerciseAffinity({ upstream, sessionAffinity: { mode: 'on' } });

    assert.notDeepEqual(unset.first.logLines, on.first.logLines, '(a) の比較子が差を検出できる');
    assert.notEqual(unset.first.statusJson, on.first.statusJson, '(b) の比較子が差を検出できる');
    assert.notEqual(unset.first.screen, on.first.screen, '(c) の比較子が差を検出できる');
    assert.notEqual(unset.first.stateFile, on.first.stateFile, '(d) の比較子が差を検出できる');
    assert.notEqual(
      unset.restarted.restoredScreen,
      on.restarted.restoredScreen,
      '再起動経路の比較子が差を検出できる（mode:"on" では events が復元される）',
    );

    // 差が「affinity のせい」であることまで押さえる（別の揺らぎで差が出ていない）。
    assert.ok(
      on.first.logLines.some(line => / sid=[0-9a-f]{12} aff=(bound|new|switch|none) fam=(fable|other)$/.test(line)),
      'mode:"on" の proxy 行には sid=/aff=/fam= が付く（§7.1）',
    );
    assert.ok(JSON.parse(on.first.statusJson).sessionAffinity, 'mode:"on" の status JSON には節が出る（§7.3）');
    assert.match(on.first.screen, /Session Affinity/, 'mode:"on" の status 画面には節が出る（D-185）');
    assert.match(on.first.stateFile, /"sessionAffinity":/, 'mode:"on" の保存ファイルには表が載る（§8）');
    assert.match(on.restarted.stateFile, /"events":/, 'mode:"on" の保存ファイルには events が載る（D-56-6）');
  });
});

// ---------------------------------------------------------------------------
// 7. does-not-touch-gpt-path
//    （設計書 §10「不変性」2件目・§1・§7.1 末尾・R9・D-63 C6 ／ 計画 v1.2 R-S13・I-4）
//
// gpt-* 宛の要求は sticky のコード経路へ**入らない**（設計書 §1）。`mode:"on"` にしても
//   ① bridge へ送るヘッダ・パス・本文
//   ② `openai-bridge` のログ行
//   ③ ルーティング判定（bridge へ分岐すること）
// が `mode:"off"` と不変であり、さらに gpt-* の要求は sid 付与率の**分母**
// （status の `requests.proxied`）にも**セッション表**にも入らないことを固定する。
// ---------------------------------------------------------------------------

describe('does-not-touch-gpt-path (設計書 §10・§1・R9)', () => {
  it('keeps the bridge-bound headers, the openai-bridge log lines and the routing decision unchanged while the mode is on', async () => {
    const bridge = await startRecordingBridge();
    cleanupAfterTest(async () => bridge.close());
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    // 同じ偽 bridge・同じ偽 Anthropic 上流に対し、同じ順序で同じ要求を通す。off 側は
    // 明示の `{ mode:'off' }` である（FU-108）——設計書 §10 が固定するのは「`mode:"on"`
    // にしても `mode:"off"` と不変であること」であり、未記載構成との同値は不変性①が
    // 別に固定しているので、ここは条文どおり明示の off と比べる。
    const off = await exerciseGptPath({ bridge, upstream, sessionAffinity: { mode: 'off' } });
    const on = await exerciseGptPath({ bridge, upstream, sessionAffinity: { mode: 'on' } });

    assert.deepEqual(on.bridgeRequests, off.bridgeRequests, '① bridge が受け取るヘッダ・パス・本文が不変');
    assert.deepEqual(on.bridgeLogLines, off.bridgeLogLines, '② openai-bridge のログ行が不変');
    assert.deepEqual(on.gptObservations, off.gptObservations, 'gpt-* の応答（status・ヘッダ・本文）が不変');
    assert.equal(on.bridgeRequests.length, off.bridgeRequests.length, '③ bridge へ分岐した件数が不変');

    // 空振り防止＋positive control: `mode:"on"` が本当に効いている状態での比較であること。
    assert.equal(on.bridgeRequests.length, 2, 'gpt-* が2件とも bridge へ分岐している');
    assert.ok(on.bridgeLogLines.length > 0, '比較対象の openai-bridge 行が1行も無いなら空振り');
    assert.equal(
      on.affinityProxyLines.length,
      1,
      'claude-* の proxy 行にだけ sid=/aff=/fam= が付く＝mode:"on" が効いている',
    );
    assert.equal(off.affinityProxyLines.length, 0, 'mode:"off" では1行も付かない');
    // FU-108: 上の assert メッセージが実際の構成と食い違わないこと。off 側は
    // 未記載（`sessionAffinity: undefined`）ではなく明示の `{ mode:'off' }` で走らせる
    // （未記載 ⇔ 明示 off の同値は不変性①が別に固定している）。
    assert.deepEqual(
      off.sessionAffinity,
      { mode: 'off' },
      'off 側は明示の mode:"off" 構成で走っている（FU-108）',
    );
    assert.deepEqual(
      on.bridgeRequests.map(request => request.headers['x-claude-code-session-id']),
      [STICKY_SESSION_ID, STICKY_SESSION_ID],
      'セッションヘッダは rotator が触らずそのまま bridge へ届く（素通し）',
    );
    assert.deepEqual(
      on.bridgeLogLines.filter(line => /\s(?:sid|aff|fam)=/.test(line)),
      [],
      'openai-bridge の行に affinity の追記フィールドが混ざらない（§7.1 末尾）',
    );
  });

  it('counts no gpt-* request in the sid coverage denominator and binds no session for it', async () => {
    const bridge = await startRecordingBridge();
    cleanupAfterTest(async () => bridge.close());
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    const { proxy } = await startStickyProxy({
      upstream,
      sessionAffinity: { mode: 'on' },
      openaiBridge: bridgeConfig(bridge.url),
    });

    // gpt-* だけを2件（いずれもセッションヘッダ付き）。
    for (let i = 0; i < 2; i += 1) {
      const response = await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'gpt-6-astra' });
      assert.equal(response.status, 200, 'gpt-* は bridge が 200 を返す');
    }
    const beforeClaude = await affinityStatusSection(proxy);
    assert.deepEqual(beforeClaude.requests, { proxied: 0, keyed: 0 }, 'gpt-* は sid 付与率の分母に入らない');
    assert.equal(beforeClaude.sidRate, null, '分母が0なので付与率は null（§7.3）');
    assert.equal(beforeClaude.sessions, 0, 'gpt-* ではセッション表に1件も入らない');
    assert.deepEqual(beforeClaude.sessionsByAccount, {}, '口座別の集計にも入らない');

    // 同じセッション鍵の claude-* を1件だけ通す（positive control）。
    assert.equal((await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'claude-sonnet-4' })).status, 200);
    const afterClaude = await affinityStatusSection(proxy);
    assert.deepEqual(afterClaude.requests, { proxied: 1, keyed: 1 }, '数えるのは claude-* の要求だけ');
    assert.equal(afterClaude.sidRate, 1, '1/1 なので付与率は 1');
    assert.equal(afterClaude.sessions, 1, 'claude-* で初めて表に載る');
  });
});

// ---------------------------------------------------------------------------
// 8. no-raw-session-id-in-logs
//    （設計書 §10「不変性」3件目・§2.3・§7.1・§8・§9.1・R7・D-54-1 ／ FU-98）
//
// ログへ出てよいのは12桁ハッシュだけである。既知の合成セッション UUID と、受信した
// `x-api-key` / `authorization` の値が全ログ行に1回も現れないことを固定する。
// **FU-98**: 同じ検査を `runtime-state.json` の**実ファイルのバイト列**へも行う
// （表を持った `mode:"on"` で保存し、UUID・トークン・メールアドレス・`gen` が無いこと）。
// ---------------------------------------------------------------------------

describe('no-raw-session-id-in-logs (設計書 §10・§9.1・R7・FU-98)', () => {
  it('uses a scanner that actually catches a leaked raw value (positive control)', () => {
    // FU-109: 走査集合が**全口座ぶん**を覆っていること。1口座ぶんしか入っていないと、
    // もう片方の口座の token / refresh / メールアドレスだけが漏れる欠陥を検出できない
    // （口座は STICKY_ACCOUNT_IDS の2つに分散して使われている）。
    for (const id of STICKY_ACCOUNT_IDS) {
      for (const value of [`token-${id}`, `refresh-${id}`, `${id}@example.com`]) {
        assert.ok(
          STICKY_RAW_VALUES.some(([, raw]) => raw === value),
          `走査集合に入っていない口座の生値がある: ${value}（FU-109）`,
        );
      }
    }

    // このテストが無いと、走査の対象や比較を壊しても「一致0件」で緑になってしまう。
    for (const [label, value] of STICKY_RAW_VALUES) {
      assert.notDeepEqual(
        findRawValueHits([`<ts> affinity_bind sid=${value} account=acct_a reason=new_session sessions=1`], label),
        [],
        `生値の見本を検出できていない: ${label}`,
      );
    }
  });

  it('writes only the 12-digit hash into the logs while the mode is on', async () => {
    const bridge = await startRecordingBridge();
    cleanupAfterTest(async () => bridge.close());
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    const { proxy, logLines } = await startStickyProxy({
      upstream,
      // 上限1件にして、2つ目のセッションで退避（affinity_evict）まで出す。
      sessionAffinity: { mode: 'on', maxSessions: 1 },
      openaiBridge: bridgeConfig(bridge.url),
    });

    const clientHeaders = {
      'x-api-key': STICKY_CLIENT_API_KEY,
      authorization: STICKY_CLIENT_AUTHORIZATION,
    };
    assert.equal((await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'claude-sonnet-4', headers: clientHeaders })).status, 200);
    assert.equal((await askSession(proxy, { sid: STICKY_OTHER_SESSION_ID, model: 'claude-sonnet-4', headers: clientHeaders })).status, 200);
    assert.equal((await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'gpt-6-astra', headers: clientHeaders })).status, 200);
    await requestJson(`${proxy.url}/internal/status`);

    // 空振り防止: 生値を含みうる行が実際に出ていること。
    assert.ok(logLines.some(line => /\saffinity_bind\s/.test(line)), 'affinity_bind が出ていること');
    assert.ok(logLines.some(line => /\saffinity_evict\s/.test(line)), 'affinity_evict が出ていること（上限1件）');
    assert.ok(logLines.some(line => / openai-bridge /.test(line)), 'openai-bridge の行が出ていること');
    assert.ok(
      logLines.some(line => line.includes(` sid=${sidHash(STICKY_SESSION_ID)}`)),
      'そのセッションの12桁ハッシュが実際にログへ出ていること（出るのはこれだけ）',
    );

    for (const [label] of STICKY_RAW_VALUES) {
      assert.deepEqual(
        findRawValueHits(logLines, label),
        [],
        `ログに生値が出ている: ${label}`,
      );
    }
  });

  it('keeps the raw session id, the credentials, the mail addresses and gen out of runtime-state.json (FU-98)', async () => {
    const upstream = await startAnthropicUpstream();
    cleanupAfterTest(async () => upstream.close());

    const dir = await mkdtemp(join(tmpdir(), 'rotator-affinity-state-'));
    cleanupAfterTest(async () => rm(dir, { recursive: true, force: true }));
    const statePath = join(dir, 'runtime-state.json');

    const { proxy, writes } = await startStickyProxy({
      upstream,
      sessionAffinity: { mode: 'on' },
      statePath,
    });
    assert.equal((await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'claude-sonnet-4' })).status, 200);
    assert.equal((await askSession(proxy, { sid: STICKY_OTHER_SESSION_ID, model: 'claude-sonnet-4' })).status, 200);
    assert.ok(await waitForCount(writes, 2), `保存が2回に達しない（実測 ${writes.length} 回）`);

    const stateFile = await readFile(statePath, 'utf8');
    const saved = JSON.parse(stateFile);

    // 空振り防止: 表が実際に保存されていること（空のファイルを走査して緑にならない）。
    assert.equal(saved.sessionAffinity.version, 1);
    assert.equal(saved.sessionAffinity.entries.length, 2, '2セッションぶんの行が保存されていること');
    for (const entry of saved.sessionAffinity.entries) {
      assert.match(entry.k, /^[0-9a-f]{12}$/, '鍵は12桁ハッシュだけ（§8）');
    }
    assert.ok(
      stateFile.includes(sidHash(STICKY_SESSION_ID)),
      'そのセッションの12桁ハッシュが実ファイルに入っていること',
    );

    for (const [label] of STICKY_RAW_VALUES) {
      assert.deepEqual(
        findRawValueHits([stateFile], label),
        [],
        `runtime-state.json に生値が入っている: ${label}`,
      );
    }
    assert.equal(
      /"gen"\s*:/.test(stateFile),
      false,
      '世代番号は保存しない（D-60-1・§8）',
    );
  });
});

// ---------------------------------------------------------------------------
// 共通ヘルパ（すべて port 0 で listen する）
// ---------------------------------------------------------------------------

function bridgeConfig(url, extra = {}) {
  return {
    enabled: true,
    url,
    modelPattern: '^gpt-',
    connectTimeoutMs: 1000,
    idleTimeoutMs: 1000,
    connectRetries: 0,
    ...extra,
  };
}

async function startProxy({
  accountManager = null,
  secretStore = null,
  logLines = null,
  upstream = 'http://127.0.0.1:1',
  openaiBridge = undefined,
} = {}) {
  const store = secretStore || new MemorySecretStore();
  if (!secretStore) await store.set('acct_1', { accessToken: 'access-token-1' });
  const proxy = await listen(createProxyServer({
    accountManager: accountManager || new AccountManager({
      accounts: [{ id: 'acct_1', name: 'user-a@example.com', type: 'oauth' }],
      now: () => 1000,
    }),
    secretStore: store,
    config: {
      upstream,
      usagePolling: { enabled: false },
      ...(openaiBridge ? { openaiBridge } : {}),
    },
    logger: logLines ? line => logLines.push(line) : null,
  }));
  cleanupAfterTest(async () => close(proxy.server));
  return proxy;
}

async function startAnthropicUpstream() {
  const upstream = await listen(http.createServer((req, res) => {
    req.resume();
    const body = JSON.stringify({ ok: true, usage: { input_tokens: 10, output_tokens: 20 } });
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }));
  return { url: upstream.url, close: async () => close(upstream.server) };
}

async function startSilentServer() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer(socket => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  server.unref?.();
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    connectionCount: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done));
    },
  };
}

// 誰も listen していないループバックポートを返す。bind→close だけだと、返した直後に
// 別プロセスがそのポートを掴む余地（TOCTOU）が残るので、実際に接続を試みて
// 「接続拒否される＝誰も listen していない」ことを確かめてから返す。掴まれていた場合だけ
// 1回だけ別ポートで取り直す（決定性を上げるための最小の追加）。
async function unusedLoopbackPort(retriesLeft = 1) {
  const server = net.createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  await new Promise(done => server.close(done));

  if (await connectionIsRefused(port)) return port;
  if (retriesLeft > 0) return unusedLoopbackPort(retriesLeft - 1);
  throw new Error(`未 listen のループバックポートを確保できなかった（最後に試した port=${port}）`);
}

// 接続が ECONNREFUSED で弾かれたときだけ true。接続できた・時間切れになった場合は
// 「誰かが掴んでいるかもしれない」として false を返す（安全側に倒す）。
function connectionIsRefused(port) {
  return new Promise(done => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = refused => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      done(refused);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
  });
}

function askAstra(proxy) {
  return requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-6-astra' }),
    headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`, 'content-type': 'application/json' },
  });
}

function askClaude(proxy) {
  return requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4' }),
    headers: { authorization: `Bearer ${LOCAL_GATEWAY_AUTH_TOKEN}`, 'content-type': 'application/json' },
  });
}

// 応答の比較用に、揺らぐ値（date・接続系）だけを落とす。ヘッダは名前も値も比べる。
const VOLATILE_HEADERS = new Set(['date', 'connection', 'keep-alive']);

function summarize(name, response) {
  const headers = Object.entries(response.headers)
    .filter(([key]) => !VOLATILE_HEADERS.has(key.toLowerCase()))
    .map(([key, value]) => `${key.toLowerCase()}: ${value}`)
    .sort();
  return { name, status: response.status, headers, bodyText: response.bodyText };
}

function normalizeLogLines(lines) {
  return lines.map(line => line
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z/, '<ts>')
    .replace(/durationMs=\d+/g, 'durationMs=<n>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>'));
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function createIo() {
  let text = '';
  return {
    write: chunk => { text += chunk; },
    error: chunk => { text += chunk; },
    output: () => text,
  };
}

async function listen(server) {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  server.unref?.();
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise(done => server.close(done));
}

async function requestJson(url, options = {}) {
  const target = new URL(url);
  return new Promise((done, fail) => {
    let settled = false;
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        settled = true;
        done({ status: res.statusCode, headers: res.headers, bodyText: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', error => {
        if (settled) return;
        settled = true;
        fail(error);
      });
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      fail(error);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 共通ヘルパ（sticky affinity・R-S13）。ここでも固定ポートは1つも使わない。
// ---------------------------------------------------------------------------

// 台帳の時計は固定する。runtime-state.json の `savedAt` も status に出る各時刻もこの値
// から決まるので、**実ファイルのバイト列**をそのまま比較できる（正規化を挟まない）。
const STICKY_CLOCK_MS = 1_757_000_000_000;
const STICKY_ACCOUNT_IDS = Object.freeze(['acct_a', 'acct_b']);
// 合成の UUID。実在のセッション id ではなく、本ファイルで生成した目印である。
const STICKY_SESSION_ID = 'b1d5f0c2-8a44-4e19-9f7c-2a6d3e5b01f8';
const STICKY_OTHER_SESSION_ID = '7c9e2a10-4b3d-42f6-8e05-1d9a7f2c6b34';
// 合成の受信資格情報（形だけを真似た目印文字列で、実在の鍵ではない）。
const STICKY_CLIENT_API_KEY = 'synthetic-client-api-key-4d1f0a';
const STICKY_CLIENT_BEARER = 'synthetic-client-bearer-7b2e93';
const STICKY_CLIENT_AUTHORIZATION = `Bearer ${STICKY_CLIENT_BEARER}`;

// ログと runtime-state.json のどちらにも1回も現れてはいけない生値（R7・§9.1・FU-98）。
const STICKY_RAW_VALUES = Object.freeze([
  ['セッションの生 UUID', STICKY_SESSION_ID],
  ['別セッションの生 UUID', STICKY_OTHER_SESSION_ID],
  ['受信した x-api-key', STICKY_CLIENT_API_KEY],
  ['受信した authorization', STICKY_CLIENT_AUTHORIZATION],
  ['受信した authorization のトークン部', STICKY_CLIENT_BEARER],
  // 口座の資格情報は**全口座ぶん**を並べる（FU-109）。1口座ぶんだけだと、バインドが
  // 2口座に分散しているぶん、もう片方の口座の値だけが漏れる欠陥を検出できない。
  ...STICKY_ACCOUNT_IDS.flatMap(id => [
    [`口座 ${id} のアクセストークン`, `token-${id}`],
    [`口座 ${id} のリフレッシュトークン`, `refresh-${id}`],
    [`口座 ${id} のメールアドレス`, `${id}@example.com`],
  ]),
]);

// (a)〜(d) を作るための固定の要求列。鍵つき2件（同一セッション・別系統）＋別セッション
// 1件（Fable 系統＝`fam=fable` の経路）＋鍵なし1件。
const STICKY_REQUESTS = Object.freeze([
  [STICKY_SESSION_ID, 'claude-sonnet-4'],
  [STICKY_SESSION_ID, 'claude-3-5-haiku-20241022'],
  [STICKY_OTHER_SESSION_ID, 'claude-fable-5-1'],
  [null, 'claude-sonnet-4'],
]);

// proxy 行の追記フィールドと affinity_* 行。`mode:"off"` ではこの正規表現に当たる行が
// 1本も出ない（§7.1・§7.2）。
const AFFINITY_LOG_MARKERS = /\s(?:sid|aff|fam)=|\saffinity_/;

const SSE_MESSAGE_START = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const SSE_MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

/** 指定した生値を含む行を、行番号つきで返す（走査が働いていることを示せる形）。 */
function findRawValueHits(lines, label) {
  const found = STICKY_RAW_VALUES.find(([name]) => name === label);
  if (!found) throw new Error(`unknown raw value label: ${label}`);
  const [, value] = found;
  const hits = [];
  lines.forEach((line, index) => {
    if (line.includes(value)) hits.push(`${index + 1} [${label}]`);
  });
  return hits;
}

function askSession(proxy, { sid = null, model = 'claude-sonnet-4', headers = {} } = {}) {
  return requestJson(`${proxy.url}/v1/messages`, {
    method: 'POST',
    body: JSON.stringify({ model }),
    headers: {
      'content-type': 'application/json',
      ...(sid ? { 'x-claude-code-session-id': sid } : {}),
      ...headers,
    },
  });
}

// 保存は応答の送出より後に走る（`persistState()` は要求ハンドラの末尾で await される）。
// 実ファイルを読む前に、期待する回数ぶん書き終わったことを待つ。
async function waitForCount(list, target, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (list.length < target && Date.now() - startedAt < timeoutMs) {
    await new Promise(done => setTimeout(done, 5));
  }
  return list.length >= target;
}

async function startStickyProxy({
  upstream,
  sessionAffinity = undefined,
  openaiBridge = undefined,
  statePath = null,
  savedState = null,
  clockMs = STICKY_CLOCK_MS,
} = {}) {
  const logLines = [];
  const writes = [];
  const logger = line => logLines.push(line);
  const secretStore = new MemorySecretStore();
  for (const id of STICKY_ACCOUNT_IDS) {
    await secretStore.set(id, {
      accessToken: `token-${id}`,
      refreshToken: `refresh-${id}`,
      // 期限だけは実時刻で置く（更新経路へ入れないため）。保存 JSON には載らない値である。
      expiresAt: Date.now() + 3_600_000,
    });
  }
  const accountManager = new AccountManager({
    accounts: STICKY_ACCOUNT_IDS.map(id => ({ id, name: `${id}@example.com`, type: 'oauth' })),
    now: () => clockMs,
    logger,
    // src/cli.js の runServer と同じ決め方（§5.2(b)・D-56-6）。復元より前に決めないと効かない。
    eventHistory: normalizeSessionAffinity(sessionAffinity).mode !== 'off',
  });
  // 台帳を先に復元し、その戻り値を createProxyServer へ渡す並び（§8.1）をそのまま再現する。
  const credentialChangedAccountIds = savedState ? accountManager.restoreState(savedState) : null;
  const proxy = await listen(createProxyServer({
    accountManager,
    secretStore,
    logger,
    savedState,
    credentialChangedAccountIds,
    ...(statePath
      ? {
        stateWriter: async state => {
          await writeJsonFileDurable(statePath, state);
          writes.push(state);
        },
      }
      : {}),
    config: {
      upstream: upstream.url,
      usagePolling: { enabled: false },
      // 未記載構成では `sessionAffinity` というキー自体を置かない。
      ...(sessionAffinity === undefined ? {} : { sessionAffinity }),
      ...(openaiBridge ? { openaiBridge } : {}),
    },
  }));
  cleanupAfterTest(async () => close(proxy.server));
  return { proxy, accountManager, secretStore, logLines, writes };
}

// status の JSON と画面には、要求ごとの実測値 `durationMs` が `proxy-request` の
// events として載る。これは本質的に揺らぐ値なので、proxy ログ行の `durationMs=<n>`
// （normalizeLogLines）と同じように伏せてから比較する——既存のテスト3 が `date` ヘッダを
// 落としているのと同じ扱いである。置き換え後も JSON として読めるよう文字列にしておく。
function normalizeStatusText(text) {
  return text
    .replace(/"durationMs":\s*\d+/g, '"durationMs":"<n>"')
    .replace(/ \d+ms outcome=/g, ' <n>ms outcome=');
}

async function observeStatus(proxy) {
  const response = await requestJson(`${proxy.url}/internal/status`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.bodyText);
  return {
    json: normalizeStatusText(response.bodyText),
    // `claude-rotator status` が描く画面（src/monitor.js の renderStatus）。端末幅と時計
    // を固定して、比較が実行環境に依存しないようにする。
    screen: normalizeStatusText(renderStatus(body, { now: STICKY_CLOCK_MS, columns: 100 })),
  };
}

// 1プロセスぶんの観測。起動 →（復元直後の status）→ events を1件作る → 固定の要求列 →
// 保存の完了待ち →（要求のあとの status）→ 実ファイルの読み出し。
async function runAffinityProcess({ upstream, sessionAffinity, statePath, savedState }) {
  const { proxy, accountManager, logLines, writes } = await startStickyProxy({
    upstream,
    sessionAffinity,
    statePath,
    savedState,
  });

  const restored = await observeStatus(proxy);

  // 保存され得る `events` を1件作る。`mode:"off"` では保存も復元もしないので、再起動後の
  // Events 節は空のままになる（§7.3・D-56-6）。
  accountManager.markRateLimited(STICKY_ACCOUNT_IDS[1], 60);

  for (const [sid, model] of STICKY_REQUESTS) {
    const response = await askSession(proxy, { sid, model });
    assert.equal(response.status, 200, `${model} の要求が偽上流まで通ること`);
  }
  assert.ok(
    await waitForCount(writes, STICKY_REQUESTS.length),
    `runtime-state.json の書き込みが ${STICKY_REQUESTS.length} 回に達しない（実測 ${writes.length} 回）`,
  );

  const final = await observeStatus(proxy);
  return {
    restoredStatusJson: restored.json,
    restoredScreen: restored.screen,
    statusJson: final.json,
    screen: final.screen,
    logLines: normalizeLogLines(logLines),
    stateFile: await readFile(statePath, 'utf8'),
    writeCount: writes.length,
  };
}

// 1構成ぶん＝「初回起動」と「保存ファイルだけを引き継いだ新しいプロセス相当」の2本。
async function exerciseAffinity({ upstream, sessionAffinity }) {
  const dir = await mkdtemp(join(tmpdir(), 'rotator-affinity-invariance-'));
  cleanupAfterTest(async () => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'runtime-state.json');

  const first = await runAffinityProcess({ upstream, sessionAffinity, statePath, savedState: null });
  // 新しいプロセス相当: 保存されたファイルだけを入力に、台帳も表も作り直す（§8.1）。
  const savedState = JSON.parse(await readFile(statePath, 'utf8'));
  const restarted = await runAffinityProcess({ upstream, sessionAffinity, statePath, savedState });
  return { first, restarted };
}

function assertNoAffinityArtifacts(observation, label) {
  assert.deepEqual(
    observation.logLines.filter(line => AFFINITY_LOG_MARKERS.test(line)),
    [],
    `${label}: (a) proxy 行の sid=/aff=/fam= も affinity_* 行も1つも出ない`,
  );
  for (const [phase, json] of [
    ['起動直後', observation.restoredStatusJson],
    ['要求のあと', observation.statusJson],
  ]) {
    assert.equal(
      'sessionAffinity' in JSON.parse(json),
      false,
      `${label}/${phase}: (b) status の JSON に sessionAffinity キーが無い`,
    );
  }
  for (const [phase, screen] of [
    ['起動直後', observation.restoredScreen],
    ['要求のあと', observation.screen],
  ]) {
    assert.equal(
      screen.includes('Session Affinity'),
      false,
      `${label}/${phase}: (c) status 画面に Session Affinity 節が無い（D-185）`,
    );
  }
  const saved = JSON.parse(observation.stateFile);
  assert.equal(
    'sessionAffinity' in saved,
    false,
    `${label}: (d) runtime-state.json に sessionAffinity キーが無い`,
  );
  assert.equal(
    'events' in saved,
    false,
    `${label}: (d) runtime-state.json に events キーが無い（D-56-6）`,
  );
}

// 受け取った要求をそのまま記録する偽 bridge。契約ヘッダの検査までは行わない——ここで
// 見たいのは「rotator が bridge へ渡すものが mode で変わらないこと」だけである。
async function startRecordingBridge() {
  const received = [];
  const bridge = await listen(http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        bodyText: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(SSE_MESSAGE_START);
      res.end(SSE_MESSAGE_STOP);
    });
  }));
  return {
    url: bridge.url,
    // 直前に記録したぶんだけを取り出す（2つの構成を同じ bridge で走らせるため）。
    take: () => received.splice(0),
    close: async () => close(bridge.server),
  };
}

async function exerciseGptPath({ bridge, upstream, sessionAffinity }) {
  bridge.take();
  const { proxy, logLines } = await startStickyProxy({
    upstream,
    sessionAffinity,
    openaiBridge: bridgeConfig(bridge.url),
  });

  const gptObservations = [];
  for (let index = 0; index < 2; index += 1) {
    gptObservations.push(summarize(
      `gpt-${index}`,
      await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'gpt-6-astra' }),
    ));
  }
  // 同じ鍵の claude-* も1件通す（`mode:"on"` が実際に効いていることの positive control）。
  assert.equal((await askSession(proxy, { sid: STICKY_SESSION_ID, model: 'claude-sonnet-4' })).status, 200);

  const normalized = normalizeLogLines(logLines);
  return {
    // どの構成で走らせたか（FU-108: assert メッセージと構成の食い違いを防ぐ）。
    sessionAffinity,
    bridgeRequests: bridge.take(),
    bridgeLogLines: normalized.filter(line => / openai-bridge /.test(line)),
    gptObservations,
    affinityProxyLines: normalized.filter(
      line => / proxy account=/.test(line) && /\s(?:sid|aff|fam)=/.test(line),
    ),
  };
}

async function affinityStatusSection(proxy) {
  const response = await requestJson(`${proxy.url}/internal/status`);
  assert.equal(response.status, 200);
  const section = JSON.parse(response.bodyText).sessionAffinity;
  assert.ok(section, 'status の JSON に sessionAffinity 節があること');
  return section;
}
