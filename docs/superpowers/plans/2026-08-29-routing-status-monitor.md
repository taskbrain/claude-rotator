# Model-aware Routing Status and Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fable と Other のリクエスト単位ルーティングを並列回帰テストで固定し、`status` / `monitor` に系列別の現在候補・復帰順・レスポンシブ2列表示を追加する。

**Architecture:** `AccountManager` が既存の選択規則と同じ情報から系列別 `routingAvailability` を生成し、`monitor.js` はその内部 status 契約を描画する。復帰時刻は適用中の全ブロッカーの最大解除時刻とし、描画は内容が端末幅へ収まる場合だけ2列化する。proxy の既存ルーティング本体は変更せず、実 HTTP 並列テストで契約を固定する。

**Tech Stack:** Node.js ESM、`node:test`、ローカル HTTP test server、既存のテキスト renderer。

**Spec:** `docs/superpowers/specs/2026-08-29-routing-status-monitor-design.md`

## Global Constraints

- Fable と Other の判定は既存 `scopeMatchesModelFamily` / request model 規則を正本とする。
- Fable 限定枠は Other を停止しない。共通枠、token/request 枠、credential cooldown は両系列を停止する。
- 復帰予定は適用中の全ブロッカーの最大解除時刻とし、解除時刻が1つでも不明なら `unknown` とする。
- 既存 status JSON フィールドを変更・削除せず、`routingAvailability` のみ加算する。
- 端末出力を切り捨てず、2列が収まらない場合は1列へ戻す。
- 実 OAuth token、認証 JSON、authorization code を argv、fixture、log、error、文書へ入れない。
- `npm run dev` は実行しない。
- 既存の未追跡 `package-lock.json` を変更・stageしない。

---

### Task 1: 系列別 availability schedule

**Files:**
- Modify: `src/account-manager.js`
- Test: `test/account-manager.test.js`

**Interfaces:**
- Produces: `AccountManager.getRoutingAvailability(modelFamily = null) -> Array<RoutingAvailabilityEntry>`。
- Produces: `getStatus().routingAvailability.{fable,other}`。
- `RoutingAvailabilityEntry = { account, accountName, state: 'available'|'waiting'|'unknown', availableAt: string|null }`。
- Consumes: 既存 `switchTargetScore`、`compareSwitchTargetScores`、`scopeMatchesModelFamily`、account quota と `rateLimitedUntil`。

- [x] **Step 1: 適用ブロッカーの最大時刻を要求する失敗テストを書く**

固定時刻を `2026-08-29T05:00:00.000Z` とし、以下の3アカウントを作る。

```js
acct_1: common quota は利用可能、Fable は +4h で復帰
acct_2: common 5h は +1h、Fable は +3h で復帰
acct_3: common 7d は +2h で復帰
```

期待値をリテラルで検証する。

```js
assert.deepEqual(status.routingAvailability.other, [
  { account: 'acct_1', accountName: 'a@example.com', state: 'available', availableAt: null },
  { account: 'acct_2', accountName: 'b@example.com', state: 'waiting', availableAt: '2026-08-29T06:00:00.000Z' },
  { account: 'acct_3', accountName: 'c@example.com', state: 'waiting', availableAt: '2026-08-29T07:00:00.000Z' },
]);
assert.deepEqual(status.routingAvailability.fable, [
  { account: 'acct_3', accountName: 'c@example.com', state: 'waiting', availableAt: '2026-08-29T07:00:00.000Z' },
  { account: 'acct_2', accountName: 'b@example.com', state: 'waiting', availableAt: '2026-08-29T08:00:00.000Z' },
  { account: 'acct_1', accountName: 'a@example.com', state: 'waiting', availableAt: '2026-08-29T09:00:00.000Z' },
]);
```

このテストを壊す本番変更は「Fable scope を Other に適用する」「最初の reset だけを
使う」「waiting を時刻順に並べない」である。

- [x] **Step 2: RED を確認する**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: `routingAvailability` が未定義のため FAIL。

- [x] **Step 3: 最小の schedule 実装を追加する**

`getRoutingAvailability` は各 account を refresh し、現在 account または
`switchTargetScore` を持つ候補を `available` とする。利用不能候補は次の形の
内部 helper で評価する。

```js
function futureAvailability(account, threshold, modelFamily, now) {
  // error => unknown
  // common exhausted windows, matching scoped windows, rateLimitedUntil を列挙
  // blocker なし、または reset 不明/期限経過 => unknown
  // それ以外 => waiting at Math.max(...resetTimes)
}
```

available は現在 account を先頭にし、その他を `compareSwitchTargetScores` で並べる。
waiting は `availableAt`、unknown は account priority/index で並べる。返却時に内部
score/index を除去する。`getStatus()` へ次を加える。

```js
routingAvailability: {
  fable: this.getRoutingAvailability('fable'),
  other: this.getRoutingAvailability(null),
},
```

- [x] **Step 4: GREEN と既存 account-manager 回帰を確認する**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: 全件 PASS、warning/error なし。

---

### Task 2: status / monitor の系列別順序と2列表示

**Files:**
- Modify: `src/monitor.js`
- Test: `test/monitor.test.js`

**Interfaces:**
- Consumes: `status.routingAvailability.fable` と `.other`。
- Preserves: `renderStatus(status, options = {}) -> string`。
- Adds internal pure render helpers for schedule blocks, account cards, and fitting two blocks into terminal columns。

- [x] **Step 1: 新しい表示契約の失敗テストを書く**

fixture に Fable / Other schedule を追加し、以下を確認する。

```js
assert.match(output, /Claude Rotator\s+current: b@example\.com/);
assert.match(output, /Routing availability/);
assert.match(output, /Fable \(none now\)/);
assert.match(output, /Other \(Sonnet \/ Opus \/ Haiku\)/);
assert.match(output, /a@example\.com\s+in 1h -> 06\/04 19:00 JST/);
assert.match(output, /b@example\.com\s+now/);
assert.match(output, /routes Fable: 1h \| Other: now/);
```

`columns: 160` では最初の2アカウント名が同じ物理行にあり、`columns: 80` では
別行にあることを改行単位で検証する。テストを壊す本番変更は「columns を無視する」
または「情報を切って無理に2列化する」である。

- [x] **Step 2: RED を確認する**

Run:

```bash
node --test test/monitor.test.js
```

Expected: `current:`、schedule、routes 行、2列表示が未実装のため FAIL。

- [x] **Step 3: schedule renderer を最小実装する**

`renderStatus` は `options.columns`、次に呼び出し時の `process.stdout.columns`、最後に
80を使う。`routingAvailability` がない場合は `no data`、accounts が空なら
`no accounts` と表示する。時刻付き行は既存 `formatDuration` と `formatDate` を使う。

```text
available -> now
waiting   -> in <duration> -> <date JST>
unknown   -> unknown
```

- [x] **Step 4: account cards と2列合成を最小実装する**

既存 quota/reason/request 行を card 配列へ移し、schedule を account id で参照して
`routes Fable: ... | Other: ...` を追加する。全 card の最大行長を測り、次を満たす
場合だけ隣接カードを結合する。

```js
leftWidth + 3 + rightWidth <= columns
```

schedule の左右列にも同じ原則を適用する。収まらない場合は上下に並べ、文字列を
切り捨てない。Events の描画は変更しない。

- [x] **Step 5: GREEN を確認する**

Run:

```bash
node --test test/monitor.test.js
```

Expected: 全件 PASS。

---

### Task 3: 複数ターミナル相当の並列モデルルーティング回帰

**Files:**
- Test: `test/proxy-server.test.js`
- Modify only if the regression exposes a defect: `src/proxy-server.js` or `src/account-manager.js`

**Interfaces:**
- Exercises: `POST /v1/messages` -> `routingModelFamily` -> `getActiveAccount(modelFamily)`。
- Preserves: Fable scoped-only switch does not mutate `currentAccount`。

- [x] **Step 1: 既知の Fable 枯渇から始まる並列 characterization test を追加する**

2つの request を応答保留中に重ね、upstream が受けた model/token の組をリテラルで
検証する。

```js
assert.deepEqual(new Map(upstreamSeen), new Map([
  ['claude-fable-5', 'Bearer access-token-2'],
  ['claude-sonnet-5', 'Bearer access-token-1'],
]));
assert.equal(accountManager.getStatus().currentAccount, 'acct_1');
```

このテストを壊す本番変更は「共有 currentIndex を Fable の ad-hoc 選択で移動する」
または「model family をリクエスト単位で渡さない」である。

- [x] **Step 2: characterization test を実行する**

Run:

```bash
node --test test/proxy-server.test.js
```

Expected: 現行設計どおりなら PASS。FAIL の場合だけ、失敗原因に対する最小修正を
別の RED/GREEN サイクルで行う。テストが PASS なら proxy 本体は変更しない。

---

### Task 4: 統合検証、差分レビュー、配布

**Files:**
- Verify: `src/account-manager.js`
- Verify: `src/monitor.js`
- Verify: `test/account-manager.test.js`
- Verify: `test/monitor.test.js`
- Verify: `test/proxy-server.test.js`
- Verify: design and plan documents

**Interfaces:**
- Produces: tested immutable runtime snapshot and healthy installed service。
- Preserves: existing wrapper, LaunchAgent, Keychain credentials, account config, usage state。

- [x] **Step 1: focused integration test を実行する**

Run:

```bash
node --test test/account-manager.test.js test/monitor.test.js test/proxy-server.test.js
```

Expected: 全件 PASS。

- [x] **Step 2: 正本 full check を1回実行する**

Run:

```bash
npm run check
```

Expected: lint と全 test が PASS。

- [x] **Step 3: 設計・要件・差分レビューを実施する**

次を確認する。

- Fable scope が Other の `availableAt` へ混入していない。
- 複数ブロッカーの最大 reset を使っている。
- unknown を available と断定していない。
- 2列化で文字列を切っていない。
- proxy / OAuth / secret store の本番コードを不要に変更していない。
- `package-lock.json` が diff / stage に含まれていない。

Critical / Important 指摘があれば該当箇所を修正し、focused test だけ再実行する。

- [ ] **Step 4: 変更を1コミットへまとめる**

```bash
git add docs/superpowers/specs/2026-08-29-routing-status-monitor-design.md \
  docs/superpowers/plans/2026-08-29-routing-status-monitor.md \
  src/account-manager.js src/monitor.js \
  test/account-manager.test.js test/monitor.test.js test/proxy-server.test.js
git diff --cached --check
git commit -m "feat(monitor): モデル別の復帰順を表示"
```

- [ ] **Step 5: immutable snapshot へ配布し、サービスを安全に再起動する**

現在の wrapper と LaunchAgent の参照先を読み取りで解決し、テスト済み commit から
新しい immutable snapshot を作る。既存 credential/config/state はコピー・削除・
再生成しない。LaunchAgent 定義を新 snapshot へ更新し、既存の macOS ロック付き
install/restart 経路を使う。`launchctl bootout`、Keychain 削除、再ログインは行わない。

- [ ] **Step 6: 配布後 smoke を実行する**

```bash
claude-rotator status
```

加えて `/internal/health` の HTTP 200、snapshot path、service generation、直近ログに
新規 credential refresh / proxy failure がないことを確認する。`monitor` は無限待機
させず、同じ renderer を使う `monitor --once` と、テスト済み wide/narrow render を
根拠にする。
