// 不変性テスト（OSS 独立性 / 設計書 §14・§14.4・§11.1 R5-2）。
//
// 方針: ClaudeRotator は OSS として単体でも使われるため、codex-rotator が無くても
// 動作すること（codex-rotator との連携は明示的に有効化したときだけ働く）。
//
// このファイルが固定するのは次の5点であり、いずれも「codex-rotator が無い環境でも
// ClaudeRotator が壊れない」という受入条件の実体である（設計書 §14.4 の一覧）。
//
//   1. never-reads-codex-credentials-in-claude-process
//   2. health-does-not-wait-for-codex-or-refresh
//   3. unset-config-is-byte-identical
//   4. codex-rotator-absent-is-harmless
//   5. no-identifier-in-degrade-logs
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
import { runCli } from '../src/cli.js';
import { LOCAL_GATEWAY_AUTH_TOKEN } from '../src/config.js';
import { createProxyServer } from '../src/proxy-server.js';
import { MemorySecretStore } from '../src/secret-store.js';
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
