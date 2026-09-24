# Rotator Cache Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本番 rotator が、応答 usage のキャッシュ4分類・要求ごとのモデルとセッション指紋・5時間枠/週次枠の使用率を1要求1行で記録し、`runtime-state.json` の usage 集計が実際に増えるようにする。切替の観測は sticky R-S1 が既に実装済みなので作り直さない。

> **受入判定（`fable-judge`）の差戻し条件を反映済み（2026-09-18）。** 変更点は5つ。
> ①**Task 3 を削除した**（R-S1 `c76ff12` が `trigger` 付きの `account_switch` を既に3経路へ付与しており、
> 起点 `60da9aa` には `selectBestExhaustedFallback({ trigger: 'request' })` も prepare-resume も入っている。
> 残すと sticky 所有行の二重変更になる）。
> ②`sid` 抑止の述語を `affinityLog === null` から **`!affinityLog?.sid`** へ直した。
> ③**起点を `60da9aa` に固定**（段 P の配備対象＝`6baf211` ＋ sticky R-S1・R-S2）。
> ④**Task 1 に Step 0（`accept-encoding` の実測）を追加**した。
> ⑤母艦の即決を反映（U-1 段 P と同便・U-2 `sid` は 12 hex・U-3 既定 on・U-4 `logMaxBytes` 32 MiB）。

**Architecture:** 本文の**書き換えは一切しない**（無改変転送は rotator の最大の強み）。応答本文は既に `Buffer.concat` で全量が手元にあるので、そこから**読むだけ**の純関数 `src/usage-observation.js` を新設し、①`accountManager.updateUsage()` の入力 ②既存 `proxy` ログ行の末尾追記、の2つの消費者へ同じ結果を渡す。セッション鍵の抽出は sticky から純関数だけを切り出した `src/session-key.js` に置き、sticky が後から同じ実装を持ち込まないようにする。設定は `config.sessionAffinity` と同じ型（自前モジュールの `normalize*` ＋ cli の `reload*` 注入）で `config.observability` を足し、`src/config.js` は触らない。

**Tech Stack:** Node.js 18.18+ ESM、`node:test`、`node:zlib`、`node:crypto`。

**Spec:** `docs/sessions/20260918_cache-loss-rca/RCA_口座切替時のキャッシュ喪失_20260918.md` の §7-8（観測の整備）と §8 の gaps 1・2・3・6・9

---

## Global Constraints

- 上流へ送る**要求のバイト列を1バイトも変えない**。応答本文もクライアントへは無改変で流し続ける。読むのは `Buffer.concat` 済みの写しだけとする。
- **要求ヘッダの唯一の例外は `accept-encoding` である**（Task 1 Step 0 の実測を受けた差戻し条件4）。本機の Node が解けない符号化（`zstd`）だけを一覧から落として上流へ渡す。それ以外のヘッダは現行どおり素通しする。この書き換えは `observability.upstream.dropUndecodableAcceptEncoding`（既定 `true`）で切れ、`false` にすれば要求ヘッダは現行とバイト同一へ戻る。
- **`observability.requestLog.enabled` を `false` と明示したとき**、`server.log` の1行が現行とバイト単位で同一になることをテストで固定する（`test/invariance.test.js`）。
  **「未指定なら同一」ではない。** U-3 の即決で既定を `true` にしたので、未指定の構成では行が伸びる。未指定（既定 on）については「行の**前半が `enabled:false` の行とバイト単位で同一**で、観測は末尾に足されているだけ」を固定する。
- 口座切替のログ行（`account_switch`）を**この計画では実装しない**。sticky R-S1（`c76ff12`、段 P の配備対象 `60da9aa` に含まれる）が既に持っている。同じ関数を二重に変えない。**`trigger` の穴を塞ぐ作業（旧 Task 3）も行わない** — 起点 `60da9aa` の `proxy-server.js` には `selectBestExhaustedFallback({ trigger: 'request' })` と prepare-resume の `trigger` が既に入っており、`trigger=unknown` は出ない。
- 生のセッション id・`metadata.user_id` の原文・会話本文・プロンプト断片・トークン・資格情報を、ログ・`runtime-state.json`・テスト fixture・本計画書のいずれにも書かない。出してよいのは sha256 の先頭 12 桁だけとする。
- 口座の表記は既存 `proxy` 行の `account=` と同じ `account.id`（スラッグ）に揃える。新しい口座由来フィールドを増やさない。**本計画書の中の口座は別名（先頭3文字＋`…`）で書く。**
- 秘密を argv・fixture・log・error・文書へ出さない。未追跡の `package-lock.json` を変更・stage しない。
- テストは実 API・実サービス・稼働中 rotator へ到達させない。偽上流は必ず `listen(0, '127.0.0.1')`、サービス系は `fixtures/service-command-guard.js` を `--import` で武装させる。
- 稼働中 rotator（pid は `~/.local/lib/claude-rotator/6baf211-no-stop-20260917` の実体）へ、実装中は再起動・reload・シグナル・HTTP 要求のいずれも送らない。配備は Task 6 でオーナーの承認を得てから行う。
- `src/config.js` を変更しない。`createDefaultConfig()` へキーを足すと既存 `config.json` との浅いマージ事故を起こすため、`sessionAffinity` と同じく自前モジュールで正規化する。

---

## File Map

- Create: `src/usage-observation.js` … 応答本文から usage を読む純関数群と `observability` 設定の正規化。
- Create: `src/session-key.js` … セッション鍵の抽出・正規化・`sidHash`。sticky の `session-affinity.js:76-160` から純関数だけを切り出したもの。
- Create: `test/usage-observation.test.js`
- Create: `test/session-key.test.js`
**行番号はすべて起点 `60da9aa` のもの**（差戻し条件3で起点を固定したので、依頼文や `6baf211` 基準の番号からずれる）。

- Modify: `src/proxy-server.js:47-57`（`HOP_HEADERS` は変えない。判定の根拠として参照する）、`:2980-2994`（`recordProxyRequest` へ観測を渡す）、`:3022-3024`（`extractUsage` の差し替え）、`:3105-3121`（`buildUpstreamHeaders` の `accept-encoding` 書き換え）、`:3343-3373`（`recordProxyRequest`）、`:3389-3403`（`writeProxyLog`）、`:3573-3606`（`extractUsage`）、`createProxyServer` の設定解決と reload（`:248-254`・`:423-443`）
- Modify: `src/account-manager.js:163-169`（`updateUsage`）、`:898-905`（`emptyAccountUsage`）、`:1308-1315`（`restoreUsage`）
- Modify: `src/cli.js:361`（`createServerLogWriter` の `maxBytes`）、`:393`（`reloadObservability` の注入）
- Modify: `src/log-rotation.js:3`（`LOG_MAX_BYTES` は引数化済みなので**変更しない**。呼び出し側 `src/cli.js:361` で上書きする）
- Modify: `test/proxy-server.test.js`、`test/account-manager.test.js`、`test/invariance.test.js`、`README.md`
- Read only: `src/quota.js:17-34`（`parseRateLimitHeaders`）、`src/degrade-state.js:49-57`（理由語彙）

---

## 根本原因: usage 集計が 0 のままである理由

**特定できた。** 原因は `extractUsage()`（`src/proxy-server.js:3553-3586`）が**上流応答の `content-encoding` を考慮せず、圧縮されたままのバイト列を UTF-8 テキストとして解釈している**ことである。以下の4点を順に確定させた。

**確定1: `updateUsage()` は一度も呼ばれていない。**
`~/.config/claude-rotator/runtime-state.json`（`savedAt` 2026-09-18T00:20:09Z）を `jq` で読むと、15口座すべてが `totalRequests=0` / `totalInputTokens=0` / `totalOutputTokens=0` / `lastUsed=null` である。一方で同じファイルの `quota.unified5h` / `unified7d` は更新されている（例 `ara…` が `unified5h=1`、`web…` が `0.71`）。`exportState()`（`src/account-manager.js:374-390`）は `usage: { ...account.usage }` とメモリ上の値をそのまま写すので、永続化が壊れているのではなく**メモリ上の値が 0 のまま**である。永続化経路そのものは `persistState()`（`src/proxy-server.js:181-189`）が `exportState()` を呼んで生きている。

**確定2: `extractUsage()` は呼ばれている。**
`:3002-3004` の到達条件は「口座が台帳にある」「本文長 > 0」の2つだけである。`requestUpstream()` は `shouldStream` の真偽にかかわらず `chunks.push(chunk)` を実行し（`:3221-3231`）、`upstreamRes.on('end')` で `body: Buffer.concat(chunks)` を返す（`:3232-3237`）。つまりストリーミング応答でも本文は全量が手元にある。`:3002` より手前の early return は `quota-retry`（`:2977`）・`bufferedPassthrough`（`:2988`）・`auth-refresh-retry`（`:2998`）だけで、`outcome=ok` の 200 応答はすべて `:3002` に到達する。実測でも `server.log` の `outcome=ok status=200` は 09-17〜09-18 の1日で 44,749 行ある。

**確定3: 平文の SSE を渡された `extractUsage()` が黙って何もして終わることはあり得ない。**
非ストリームは `JSON.parse` が通れば `json.usage` から更新する。SSE は `text.split('\n\n')` で分割し `data: ` 行を `JSON.parse` して `message_start` / `message_delta` から更新する。Anthropic の SSE には必ず `message_start.message.usage` が含まれるので、本文がテキストとして読める限りどちらかが必ず当たる。区切りが `\r\n\r\n` でも、`JSON.parse` は末尾の `\r` を空白として許容するため、少なくとも `message_start` 1件は通る。`updateUsage()` が例外を投げても両経路とも `try`/`catch` が握り潰すが、`:3002` で口座の存在を確認済みなので `find()` が投げる余地はなく、`account.usage` が `undefined` なら永続化結果は `null` になるはずで、実測の `0` と矛盾する。

**確定4: 残る機構は `content-encoding` だけである。**
`buildUpstreamHeaders()`（`:3085-3092`）はクライアントのヘッダを `HOP_HEADERS`（`:41-52`）と認証系だけ除いて素通しする。`HOP_HEADERS` に `accept-encoding` は**入っていない**。Claude Code が送る `accept-encoding`（Bun の fetch は既定で `gzip, deflate, br` 系を付ける）がそのまま `api.anthropic.com` へ渡り、圧縮された応答が返ると、`body.toString('utf8')` は文字化けしたバイト列になる。`JSON.parse` は例外、`split('\n\n')` は `data: ` で始まる行を1本も見つけられず、**例外も警告も出さずに 0 件で終わる**。これは「ヘッダ由来の quota は更新されるのに、本文由来の usage だけが更新されない」という観測された非対称と完全に一致する。rotator 自身が発行する要求（`oauth.js` の `fetchUsage` など）は Node の `http.request` が `accept-encoding` を自動付与しないため非圧縮で返り、そちらの JSON 解析は正常に動いている。既存テスト（`test/proxy-server.test.js:83-132`）は**非圧縮**の応答しか使っていないので、この欠陥を検出できていない。

**残っている唯一の未確認点**は、本番応答に実際に `content-encoding` が付いているかを直接観測していないことである。外部 API を直接叩くことも、稼働中 rotator へ要求を送ることも禁止されているため、本計画では次の2段で確定させる。

- Task 1 Step 1 で、gzip で固めた SSE 本文を偽上流に返させる RED テストを書く。現行 `extractUsage()` が 0 件で終わることを**機構として**固定する。
- Task 2 で `proxy` 行へ `enc=` フィールドを足す。配備後の最初の数行で `enc=gzip` / `enc=br` / `enc=-` のどれが出るかが本番の実測値になる。**`enc=-`（無圧縮）ばかりで、かつ usage も増えないなら原因は別であり、その時点で計画を止めて再調査する**（Task 6 の判断点）。

### 修正案

1. **解凍してから解析する。** 応答ヘッダの `content-encoding` を見て `gzip` / `deflate` / `br` を解く。解けないもの（`zstd` は Node 22.15 未満に API が無い）は解析せず `usageParse=unsupported-encoding` として**観測可能に失敗させる**。黙って 0 件にしない。解凍は解析用の写しに対してのみ行い、クライアントへ流すバイト列には触れない。
2. **非同期で解いて `res.end()` の前に待つ。** `zlib.gunzip` 等のコールバック版を `await` する。本文は `onChunk` で既に全部クライアントへ流れ切っており、遅れるのは終端だけなのでユーザ体験への影響は無い。同期版（`gunzipSync`）はイベントループを塞ぐので採らない。
3. **本文サイズの上限を置く。** 既定 16 MB を超える本文は解析せず `usageParse=too-large` を記録する。
4. **`totalRequests` の意味を直す。** 現行はストリームで `message_start` と `message_delta` の2回 `updateUsage()` を呼ぶため、1要求で `totalRequests` が 2 増える設計になっている（非ストリームでは 1）。1応答につき1回だけ `updateUsage()` を呼ぶ形に変え、キャッシュ4分類を同じ1回で渡す。
5. **キャッシュ4分類を集計へ足す。** `emptyAccountUsage()`（`:846-853`）と `restoreUsage()`（`:1209-1216`）へ `totalCacheReadTokens` / `totalCacheCreation1hTokens` / `totalCacheCreation5mTokens` を追加する。`restoreUsage()` は既存の `restoreNumber()` を使うので、旧い `runtime-state.json` を読んでも 0 で始まるだけで壊れない。

---

## 変更点の一覧（最小差分・6baf211 基準）

行番号はすべて `<repo>/no-stop-1076abc`（= `6baf211` = 本番実体 `~/.local/lib/claude-rotator/6baf211-no-stop-20260917`）のもの。`main` worktree（`371d1e5`）では `extractUsage` が `:3464` へずれるので、**必ず `6baf211` を起点にした worktree で作業する**。

### (a) `extractUsage` の拡張

- `src/proxy-server.js:3553-3586` を、新モジュール `src/usage-observation.js` の純関数 `parseUsageObservation(body, { contentEncoding, maxBytes })` への薄い委譲に置き換える。純関数の戻り値は次の形とする。

```js
// 1応答ぶんの観測。数えられなかったときは parse に理由が入り、トークンは null になる。
{
  parse: 'ok' | 'unsupported-encoding' | 'too-large' | 'unparsable' | 'no-usage',
  model: string | null,          // message_start.message.model / 非ストリームの json.model
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,       // cache_read_input_tokens
  cacheCreationTokens: number,   // cache_creation_input_tokens（内訳の合計とは別に上流の値を持つ）
  cacheCreation1hTokens: number, // cache_creation.ephemeral_1h_input_tokens
  cacheCreation5mTokens: number, // cache_creation.ephemeral_5m_input_tokens
}
```

- 読む場所は2系統。**非ストリーム**は本文全体の `usage`。**SSE** は `message_start.message.usage`（`input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`）と `message_delta.usage`（`output_tokens`。`cache_*` が載ることもあるので、載っていたら `message_start` の値を上書きせず**大きい方**を採る）。
- `model` は**応答**から採る。要求本文を新たに `JSON.parse` しない（`routingModelFamily()` が `:1966` で既に1回やっており、そこは sticky の最大の衝突領域なので触らない）。
- 解凍は `node:zlib` の `gunzip` / `inflate` / `brotliDecompress` のコールバック版。`content-encoding` が無い・`identity` のときは解凍しない。

### (b) リクエスト単位のログ 1 行

既存の `proxy` 行の**末尾へ追記**する。新しい行種別は作らない。理由は3つ。①1要求1行という現行の性質を保てる ②`requestId` は 200 応答にしか付かないので別行にすると突合できない ③`degradeLogFields()` が確立した「値が無ければ空文字列＝現行とバイト同一」という規律をそのまま使える。

- `src/proxy-server.js:3369-3384` `writeProxyLog(logger, event, degradeLog = null)` に第4引数 `observationLog = null` を足し、連結を `${degradeLogFields(degradeLog)}${observationLogFields(observationLog)}` にする。
- `src/proxy-server.js:3323-3353` `recordProxyRequest({...})` に `observationLog = null` を足して素通しする。
- `src/proxy-server.js:2959-2974` の呼び出しに `observationLog` を渡す。**`extractUsage` の呼び出しを `:3002` から `:2959` の直前へ移す**必要がある（現行はログを書いた後に usage を読むので、同じ行に載せられない）。ただし `accountManager.updateUsage()` を呼ぶ条件は現行のまま（口座が台帳にあり本文長 > 0）に据え置き、解析結果だけを先に得る形にする。
- 追記フィールドは次の順・この語彙で固定する。

```text
 model=<応答の model id> sid=<12hex|-> in=<n> out=<n> cr=<n> cc=<n> c1h=<n> c5m=<n> u5h=<0..1|-> u5hReset=<epoch秒|-> u7d=<0..1|-> u7dReset=<epoch秒|-> enc=<gzip|br|deflate|-> usageParse=<ok 以外のときだけ>
```

- `sid` は `src/session-key.js` の `sidHash(sessionKeyFrom(req, body))`。**sha256 の hex 先頭 12 桁**とする。依頼文は8桁だったが、sticky R-S7 が `sid=<12hex>` を同じ `proxy` 行へ出す実装を既に持ち（`session-affinity.js:90-94`、`SID_HASH_PATTERN = /^[0-9a-f]{12}$/`）、8桁と12桁が混在すると2つのログを突合できなくなる。**この1点は依頼文からの意図的な逸脱なので、Task 6 の前に承認を取る**（未決事項 U-2）。
- 第1段では**ヘッダ `x-claude-code-session-id` だけ**を読む。本文 `metadata.user_id` の `session_id` へのフォールバックは `observability.requestLog.sessionFromBody`（既定 `false`）で切り替える。理由は、要求本文が数百 KB〜数 MB あり、`JSON.parse` の追加1回が要求ごとの実コストになるためで、まずヘッダ付与率（RCA gap 3）を測ってから決める。
- 使用率は `parseRateLimitHeaders(upstreamResponse.headers)`（`src/quota.js:17-34`）の戻り値をそのまま使う。`updateQuota()` が `onResponse` で既に同じ解析をしているが、そちらは口座台帳を更新する副作用つきなので、ログ用にはもう一度純粋に呼ぶ（この関数は副作用が無い）。
- `sid` の衝突回避規約: **`observationLog` 側は `!affinityLog?.sid` のときだけ `sid=` を出す。** sticky の `affinityLogFields()` は `affinityLog.sid` が真のときにだけ `sid=` を出すので、「`affinityLog` が `null` のときだけ出す」にすると、**鍵なし要求（`affinityLog` は非 null だが `sid` が無い）で `sid=-` が消えてしまい、セッション付与率（RCA gap 3）が測れなくなる**。述語は `affinityLog` の有無ではなく `sid` の有無で取る。
- **`writeProxyLog` の第4引数は `affinityLog` を予約する**（差戻し条件3）。起点 `60da9aa` には sticky R-S7 がまだ無いので実引数は常に `null` だが、引数順を `(logger, event, degradeLog, affinityLog, observationLog)` で先に確定させておき、sticky 合流時に引数の番号を振り直さずに済ませる。連結順は `degradeLogFields` → `affinityLogFields`（未実装のうちは空文字列） → `observationLogFields` の固定とする。

### (c) 口座切替の永続ログ — **実装しない**

sticky R-S1（`c76ff12`）が `src/account-manager.js` に `logAccountSwitch()` を新設し、`AccountManager` のコンストラクタが受け取った `logger` へ次の1行を書く。

```text
<ISO8601> account_switch from=<id|none> to=<id|none> reason=<語彙> trigger=<語彙>
```

- 呼ばれるのは `switchToCandidate()`（依頼文の `:540-557`）・`switchToExhaustedFallbackCandidate()`（`:574-589`）・`switchTo()`（手動・`:86-101`）・`replaceAccounts()`（reload）の4箇所。依頼文が挙げた週次優先（`rebalanceActiveAccount()` `:502-525`）は `switchToCandidate(selected, 'weekly-reset-priority')` を通るので同じ1本に載る。
- `reason` の実測語彙は `manual` / `accounts-replaced` / `shortest-quota-reset` / `resume-ready` / `weekly-reset-priority` と、`autoSwitchReason()`（`:794-802`）が返す `quota-threshold` / `account-unavailable` / `<reason.type>`。**依頼文が指定した「既存 `autoSwitchReason` の語彙を使う」はこれで満たされている。**
- `trigger` は `ACCOUNT_SWITCH_TRIGGERS`＝`usage-refresh` / `429` / `reload` / `manual` / `request` / `prepare-resume` の6値、語彙外は `unknown`。
- `from === to` のときは出さない。

**この計画で足すのは、R-S1 が `trigger` を渡し忘れている経路を塞ぐことだけ**とする（Task 3）。R-S1 の diff は `proxy-server.js` を2箇所（`:2005` と `:2180`）しか直しておらず、`sendCurrentQuotaUnavailableResponse()` の `selectBestExhaustedFallback()`（6baf211 の `:3417`）と `prepareResumeTarget()`（`:472`）は sticky の後続コミットで直っている。段 P（R-S1・R-S2）だけを配備すると、その2経路が `trigger=unknown` で記録される。

### (d) 集計側

- `src/account-manager.js:147-153` `updateUsage(accountId, {...})` を、キャッシュ4分類を受け取り `totalRequests` を**引数 `countRequest` が真のときだけ** 1 増やす形にする（既定は `false`）。
- **`countRequest` は `parse === 'ok'` のときだけ真にする**（差戻し条件3）。「usage が読めた要求だけ数える」という意味を保つためで、`unsupported-encoding` / `too-large` / `unparsable` / `no-usage` では `totalRequests` を増やさない。読めなかった要求の件数は `server.log` の `usageParse=` の分布から数える。
- **`durationMs` は解凍を `await` する前に確定させる**（差戻し条件3）。`forwardOnce` は現在 `recordProxyRequest` の引数の中で `Date.now() - startedAt` を評価しているが、観測の解凍を手前へ移すと解凍時間が `durationMs` に混入し、配備前後の遅延比較（リスク R-5）が成り立たなくなる。`await` の手前で `const durationMs = Date.now() - startedAt;` を取る。
- `src/account-manager.js:846-853` `emptyAccountUsage()` と `:1209-1216` `restoreUsage()` へ3キーを追加する。
- `src/monitor.js:123` の `requests:` 表示はキー名が変わらないのでそのまま動く。

---

## 設定

`src/config.js` は触らない。`src/usage-observation.js` に `DEFAULT_OBSERVABILITY` と `normalizeObservability(raw)` を置く（`session-affinity.js:31-51` / `openai-bridge.js:158` と同型、戻り値は `Object.freeze`）。

```text
config.observability = {
  requestLog: {
    enabled: true,               // proxy 行への追記（U-3 で既定 on に決定）
    sessionFromBody: false,      // metadata.user_id へのフォールバック
    maxBodyBytes: 16777216,      // 解析する応答本文の上限
  },
  upstream: {
    dropUndecodableAcceptEncoding: true,  // 解けない符号化（zstd）を上流向けに落とす
  },
  logMaxBytes: 33554432,         // server.log のローテーション閾値（U-4 で 32 MiB に決定）
}
```

- **`switchLog` キーは置かない**（差戻し条件1）。起点 `60da9aa` に R-S1 が入っているので、互換キーの出番が無い。
- `upstream.dropUndecodableAcceptEncoding` と `requestLog.enabled` は**独立に切れる**。前者は要求ヘッダを、後者は `server.log` の行を、それぞれ現行へ戻すための別々のつまみである。usage 集計の修正そのもの（Task 1）はどちらのつまみにも従属させない。

- **既定を `on` にする理由**: 本件の観測は「すべての対策の効果測定の前提」（RCA §7-8）であり、既定 off だと本番で誰も有効化しないまま次の設計判断へ進むことになる。無効化は 1 キーの変更と `POST /internal/reload` で即座にでき、無効時は行がバイト単位で現行に戻ることをテストで固定するので、切戻しの敷居は十分低い。**U-3 は母艦が「既定 on」で即決済み。配備通知に「`proxy` 行の長さが約 1.9 倍になる／`POST /internal/reload` で現行へ戻る」と明記する。**
- **reload**: `POST /internal/reload`（`src/proxy-server.js:382-439`）は現状 `reloadAccounts` と `reloadOpenAiBridge` しか呼ばない。`src/cli.js:386` の隣へ `reloadObservability: () => loadConfig().then(next => next?.observability)` を足し、`createProxyServer` 内で `observabilitySettings = normalizeObservability(await reloadObservability())` を再評価する。**毎回 `normalizeObservability()` を通し直す**こと（起動時の1回きりの正規化を使い回すと reload 値にクランプが効かない。sticky が `proxy-server.js:599-625` で同じ罠を明示的に避けている）。
- `logMaxBytes` だけは reload では効かない。`createServerLogWriter()` は起動時に fd を開くため、変更は再起動が必要である。この非対称を README に書く。

---

## ログ量の見積りとローテーション

実測（`~/.config/claude-rotator/server.log`、読み取りのみ）:

```text
proxy 行 45,312 行（09-16）／44,749 行（09-17）  ≒ 45,000 行/日
proxy 行の平均長 181.9 バイト
server.log      9.15 MB（09-16T23:30Z 〜 09-18T00:24Z ＝ 約25時間）
server.log.1   10.49 MB（09-15T10:55Z 〜 09-16T23:30Z ＝ 約36時間）
現在の保全期間  2 世代あわせて約 2.4 日
```

追記フィールドの見積り（1行あたり）:

```text
 model=claude-opus-5-1        22 B
 sid=ab12cd34ef56             17 B
 in=1234 out=567              16 B
 cr=1234567 cc=1234567        24 B
 c1h=1234567 c5m=0            18 B
 u5h=0.71 u7d=0.33            19 B
 u5hReset=1789012345 u7dReset=1789098765   39 B
 enc=gzip                      9 B
合計                          約 164 B（現行 182 B → 約 346 B・1.9 倍）
```

- 1日あたり **約 15.6 MB**（45,000 × 346 B）。`LOG_MAX_BYTES = 10 MiB`（`src/log-rotation.js:3`）と copytruncate 1世代のままだと、**保全期間が 2.4 日から約 1.3 日へ縮む**。RCA の再現手順は「3日分」を前提にしているので、これは実害になる。
- 対策は `logMaxBytes` を 32 MiB へ上げること。2世代で 64 MiB ＝ **約 4.1 日**となり、現行より広くなる。`maybeRotateLog()` は `maxBytes` を引数で受けるので（`src/log-rotation.js:30`）、`src/cli.js:372` の `createServerLogWriter({ logPath })` へ `maxBytes` を渡すだけで足りる。ディスク消費は 20 MiB → 64 MiB の増加。
- `copyFileSync` によるローテーションは 32 MiB のコピー1回になる。10 MiB のときと同じ頻度（約2日に1回）まで下がるので、I/O の山はむしろ減る。

---

## テスト

固定するもの（`test/usage-observation.test.js` と `test/session-key.test.js` は HTTP を使わない純関数テスト、`test/proxy-server.test.js` は偽上流つき）。

- 純関数 `parseUsageObservation()`:
  - 非ストリーム JSON から `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` / `cache_creation.ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens` を読む。
  - SSE（`event: message_start\ndata: …\n\n` 形式と `\r\n` 区切りの両方）から同じ値を読む。`message_delta` の `output_tokens` を足す。
  - **gzip で固めた同じ SSE を渡すと `parse:'ok'` で同じ値が返る**（これが本件の核心。`content-encoding` を渡さなければ `parse:'unparsable'`）。
  - `br` / `deflate` も同様。`zstd` は `parse:'unsupported-encoding'`。
  - `maxBytes` 超過で `parse:'too-large'`、トークンは 0。
  - `usage` の無い 429 / 401 の本文で `parse:'no-usage'`。
  - `model` を `message_start.message.model` から取る。
- 純関数 `sessionKeyFrom` / `sidHash`（sticky の `test/session-affinity.test.js` の該当ケースと**同じ入力・同じ期待値**にする。将来の統合で差が出ないようにするため）:
  - ヘッダ1本なら採用、同名2本なら `null`、128 桁超は `null`、`/^[A-Za-z0-9._:-]+$/` 外は `null`。
  - `sidHash` は 12 hex。**生値がどこにも出ないことを、出力文字列に生 id が含まれないという走査で固定する**（positive control つきの走査。**`test/invariance.test.js:816` という参照は誤りで、起点 `60da9aa` の同ファイルは 786 行しかない**。その型のテンプレートは sticky R-S13 側にあるので、本計画では `test/invariance.test.js` の既存テスト5「no-identifier-in-degrade-logs」の型に倣って新規に書く）。
- 結線（`test/proxy-server.test.js`）:
  - 偽上流が `content-encoding: gzip` の SSE を返したとき、`accountManager.getStatus().accounts[0].usage` が `totalRequests=1` かつ `totalCacheReadTokens` が期待値になる（現行コードでは 0 のまま＝RED）。
  - 1要求で `totalRequests` が **1 だけ**増える（現行のストリーム経路は 2 増える＝RED）。
  - `proxy` 行が `model=` `sid=` `cr=` `u5h=` `enc=gzip` を**この順で末尾に**持つ。
  - `x-claude-code-session-id` が無い要求では `sid=-`。
  - `observability.requestLog.enabled=false` のとき、行が現行と**バイト単位で同一**（`test/invariance.test.js` に既存構成との文字列比較で追加）。
  - `POST /internal/reload` で `observability` セクションを消すと既定へ戻る。
- 到達防止の担保（`~/.claude/rules/02-verification.md` §3）:
  - 偽上流は `listen(0, '127.0.0.1')` のみ（`test/proxy-server.test.js:9117-9122` の `listen()` ヘルパーを使う）。実ホスト名は1つも書かない。
  - `npm test` が `--import ./fixtures/service-command-guard.js` で `systemctl` / `launchctl` を PATH と `child_process` の二重で遮断する。個別ファイルを走らせるときも `node --import ./fixtures/service-command-guard.js --test <file>` を使う。
  - 秘密ストアは `MemorySecretStore`。実 Keychain は `CLAUDE_ROTATOR_REAL_KEYCHAIN=1` の opt-in なので既定で触らない。
  - ファイル出力は `mkdtemp(join(tmpdir(), 'claude-rotator-observability-'))` 配下のみ。`~/.config/claude-rotator` を読み書きするテストを書かない。
  - `process.env` を書き換えない。`src/paths.js` のヘルパーは `(env, home)` を引数に取るので、env オブジェクトを渡す形で閉じる。
  - 稼働中 rotator のポート（37891）をテストで一切使わない。`listen(0, ...)` なので構造的に衝突しない。

---

## 配備

- **ブランチ**: `feat/cache-observability`
- **worktree**: `<repo>/cache-observability-20260918`
- **起点**: **`60da9aa` に固定**（差戻し条件3。段 P の配備対象＝`6baf211` ＋ sticky R-S1 `c76ff12` ＋ R-S2）。U-1 の即決は「**段 P と同便で配備する**」。`6baf211` 起点は採らない。
- **本計画の行番号は `60da9aa` の worktree `cache-observability-20260918` のもの**である。`main`（`371d1e5`）や `6baf211` とはずれる。
- **rebase 順序と衝突しそうな箇所**（sticky 13728e6 との突合で確認済み）:
  - `src/proxy-server.js` の `extractUsage`（sticky は**無改変**。関数本体の sha256 が 6baf211 と一致）と `buildUpstreamHeaders`（同じく無改変）— **衝突しない**。
  - `writeProxyLog` / `recordProxyRequest` / `forwardOnce` — sticky は引数1本の素通しを各3行足すだけ。本計画も同じ形で1本足すので、**同じ行の隣接衝突が3箇所**出る。解決規約は「連結順は `degradeLogFields` → `affinityLogFields` → `observationLogFields` の固定。引数順は `(logger, event, degradeLog, affinityLog, observationLog)`」。
  - `src/cli.js` — R-S1 が `logPath` / `logWriter` / `logger` を `AccountManager` の**前**へ移す。本計画は同じブロックへ `reloadObservability` を1行足すので衝突する。段 P を先に入れれば発生しない。
  - `src/account-manager.js` — sticky が触るのは switch 系（`:86` `:294` `:540` `:574`）、本計画が触るのは usage 系（`:147` `:846` `:1209`）。**重ならない**。
  - `createProxyServer` と `forwardWithRotation` — sticky の改変が最も大きい2関数。**実装の結果、当初の「`forwardWithRotation` には一切触らない」は成り立たなかった。** 設定を `forwardOnce` まで届ける必要があるため、`forwardWithRotation` と `forwardCurrentUnavailableAccount` の引数に `observability = DEFAULT_OBSERVABILITY` を1本足し、呼び出し5箇所へ素通しした。`forwardWithRotation` の**本体のロジックには触っていない**（`model` を応答から採り、要求本文を解析しない設計は維持したので、sticky の最大の衝突領域である `routingModelFamily()` の解析には手が入っていない）。
  - **sticky 先端 `13728e6` との突合（実測）**: `git merge-tree $(git merge-base HEAD feat/session-affinity) HEAD feat/session-affinity` の**衝突マーカーは 0 件**。`src/proxy-server.js` の差分は 13 hunk で、いずれも「同じ位置に引数を1本足す」型であり意味的な重なりは無い。
  - `src/config.js` — 双方とも触らない。
- **切戻し**（no-stop 配備手順書 v2 と同型の2段）:
  - 段1: `config.json` の `observability.requestLog.enabled` を `false` にして `POST /internal/reload`。`server.log` の行が現行とバイト同一へ戻る。`account_switch` は段 P の実装なので残る。
  - 段2: 旧実体（`~/.local/lib/claude-rotator/6baf211-no-stop-20260917`）へ戻して再起動。`logMaxBytes` の変更も再起動で戻る。
- **配備後の確認コマンド**（実行は配備後。いま実行しない）:

```bash
# 1. 新フィールドが出ているか（口座 ID を出さないよう grep -o で絞る）
tail -n 500 ~/.config/claude-rotator/server.log | grep ' proxy ' | grep -c ' cr='

# 2. 本番応答の content-encoding の実測（根本原因の最終確認）
tail -n 2000 ~/.config/claude-rotator/server.log | grep -o ' enc=[a-z-]*' | sort | uniq -c

# 3. 解析に失敗している要求が無いか
tail -n 2000 ~/.config/claude-rotator/server.log | grep -o ' usageParse=[a-z-]*' | sort | uniq -c

# 4. usage 集計が増えているか（口座は先頭3文字だけ）
jq '[.accounts[] | {id:(.id[0:3]+"…"), tr:.usage.totalRequests, cr:.usage.totalCacheReadTokens, lu:.usage.lastUsed}]' \
  ~/.config/claude-rotator/runtime-state.json

# 5. セッション付与率（RCA gap 3）
tail -n 2000 ~/.config/claude-rotator/server.log | grep ' proxy ' \
  | awk '{for(i=1;i<=NF;i++) if($i ~ /^sid=/) print ($i=="sid=-" ? "none" : "keyed")}' | sort | uniq -c

# 6. 切替行（段 P 由来。本計画の成果ではない）
grep -c ' account_switch ' ~/.config/claude-rotator/server.log
```

確認 2 で `enc=-` が支配的、かつ確認 4 の `totalRequests` が 0 のままなら、根本原因の推定が外れている。その場合は**そこで止めて再調査する**（リスク R-1）。

---

### Task 1: usage 集計が 0 のままである欠陥の修正

**Files:**
- Create: `src/usage-observation.js`
- Create: `test/usage-observation.test.js`
- Modify: `src/proxy-server.js:3553-3586`, `:3002-3004`
- Modify: `src/account-manager.js:147-153`, `:846-853`, `:1209-1216`
- Test: `test/proxy-server.test.js`, `test/account-manager.test.js`

**Interfaces:**
- Produces: `parseUsageObservation(body, { contentEncoding, maxBytes }) -> Promise<UsageObservation>`。
- Produces: `UsageObservation = { parse, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cacheCreation1hTokens, cacheCreation5mTokens }`。
- Changes: `AccountManager.updateUsage(accountId, { inputTokens, outputTokens, cacheReadTokens, cacheCreation1hTokens, cacheCreation5mTokens, countRequest })`。
- Consumes: `node:zlib` の `gunzip` / `inflate` / `brotliDecompress`。

- [x] **Step 0: Claude Code が実際に送る `accept-encoding` を実測する**（差戻し条件4・実施済み 2026-09-18）

`127.0.0.1` の空きポートに偽上流を立て、受信ヘッダのうち `accept-encoding` / `content-type` / `anthropic-beta` **だけ**を記録する（`authorization` / `x-api-key` / `cookie` は読み出しも記録もしない。本文も読み捨てる）。`ANTHROPIC_BASE_URL` を偽上流へ向けた `claude -p "ping" --settings '{"disableAllHooks":true}'` を1回だけ実行する。

**注意（実施時に判明）**: `~/.claude/settings.json` の `env.ANTHROPIC_BASE_URL` は**プロセス環境変数より優先する**。process env だけを上書きしても稼働中 rotator（`127.0.0.1:37891`）へ抜けてしまうので、**`HOME` を一時ディレクトリへ向けて settings.json 自体を読ませない**構成にすること。

**実測結果（確定）**

```text
HEAD /api/hello            :: accept-encoding=gzip, deflate, br, zstd
POST /v1/messages?beta=true :: accept-encoding=gzip, deflate, br, zstd
POST /v1/messages?beta=true :: accept-encoding=gzip, deflate, br, zstd
```

- **`zstd` を含む。** 実体 `~/.local/share/claude/versions/2.1.275` は Bun/1.4.3 ビルドで、バイナリ内の HTTP 定数表にも同じ既定値 `gzip, deflate, br, zstd` がある（オフラインの裏付け）。
- **Node のバージョンは実行環境ごとに違う。** 開発シェルの既定 `node` は v20.19.0 で `zlib.zstdDecompress` が `undefined` だが、**本番の rotator プロセスは Node v22.22.2 で動いており `zstdDecompress` を持つ**（`ps -p <pid> -o args` で確認した実体は `/opt/homebrew/Cellar/node@22/22.22.2_2/bin/node`）。したがって**本番では zstd を解凍できる**。

**この実測が計画に与える帰結（3点）**

1. `parseUsageObservation()` は `zlib.zstdDecompress` を **feature-detect** する（`typeof zlib.zstdDecompress === 'function'`）。あれば使い、無ければ `parse:'unsupported-encoding'` で観測可能に失敗させる。Node 22.15 以降へ上げれば実装を変えずに解けるようになる。
2. **`zstd` を解けない実行環境でだけ、上流向けの `accept-encoding` から `zstd` を落として `gzip, deflate, br` を送る。** これが Global Constraints の「要求ヘッダを変えない」に対する唯一の例外で、`observability.upstream.dropUndecodableAcceptEncoding`（既定 `true`）で切れる。落とすのは解けないトークンだけで、残りは受け取った順のまま維持する。全部落ちる構成では `identity` を送る。
   **本番（Node 22.22.2）ではこの書き換えは発動せず、要求ヘッダは現行とバイト同一のまま**である。発動するのは Node 22.15 未満で動かした場合だけで、実質的には「古い Node へ載せ替えたときの安全網」として入れる。
3. 根本原因（usage 集計が 0）の推定は、これで「圧縮応答が来ている可能性がある」から「**クライアントが圧縮を要求していることは確定、上流が実際に何で返すかだけが未確認**」へ狭まった。残りは配備後の `enc=` の分布で決まる。

- [ ] **Step 1: gzip の SSE で現行が 0 件になることを示す失敗テストを書く**

`test/usage-observation.test.js` を新設し、`message_start` に `input_tokens:10` / `cache_read_input_tokens:99000` / `cache_creation_input_tokens:1500` / `cache_creation.ephemeral_1h_input_tokens:1500` / `ephemeral_5m_input_tokens:0`、`message_delta` に `output_tokens:20` を持つ SSE 文字列を作り、`zlib.gzipSync` で固めたバッファを `parseUsageObservation(buf, { contentEncoding: 'gzip' })` へ渡す。期待は `parse:'ok'` と上の6値。`contentEncoding` 未指定なら `parse:'unparsable'` かつ全トークン 0 とする。

このテストを壊す本番変更は「`content-encoding` を見ない」「解凍を同期にしてタイムアウトさせる」「`ephemeral_1h` と `ephemeral_5m` を取り違える」である。

- [ ] **Step 2: RED を確認する**

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/usage-observation.test.js
```

Expected: `src/usage-observation.js` が存在せず import で FAIL。

- [ ] **Step 3: 純関数を実装して GREEN にする**

`src/usage-observation.js` に `parseUsageObservation()` を書く。`content-encoding` を小文字化して `gzip` / `x-gzip` / `deflate` / `br` を解く。未知の値は `parse:'unsupported-encoding'` で即返す。`body.length > maxBytes` なら `parse:'too-large'`。解いた後は現行 `extractUsage` と同じ2系統（JSON → SSE）で読む。SSE の区切りは `\n\n` と `\r\n\r\n` の両方を受ける。`message_delta` に `cache_*` が載っていたら `Math.max` で採る。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/usage-observation.test.js
```

Expected: 0 fail。

- [ ] **Step 4: `updateUsage` の引数とアカウント側の集計キーを増やす失敗テストを書く**

`test/account-manager.test.js` へ、`updateUsage('acct_1', { inputTokens: 1, cacheReadTokens: 2, countRequest: true })` を2回呼ぶと `totalRequests` が 2、`countRequest` を落とした呼び出しでは増えないことを固定するテストを足す。`emptyAccountUsage()` の3キー追加と、旧形式（3キーが無い）`runtime-state.json` を `restoreState()` へ渡しても 0 で復元されることも固定する。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/account-manager.test.js
```

Expected: `totalCacheReadTokens` が `undefined` で FAIL。

- [ ] **Step 5: `account-manager.js` を直して GREEN にする**

`:147-153` を新しい引数へ、`:846-853` と `:1209-1216` へ3キーを足す。`restoreUsage()` は既存 `restoreNumber()` をそのまま使う。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/account-manager.test.js
```

Expected: 0 fail。

- [ ] **Step 6: proxy 側を結線する失敗テストを書き、結線して GREEN にする**

`test/proxy-server.test.js` へ、`content-encoding: gzip` の SSE を返す偽上流を立てるテストを足す（`listen(http.createServer(...))` の既存の型。`res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' })` → `res.end(zlib.gzipSync(sse))`）。期待は `getStatus().accounts[0].usage.totalRequests === 1` と `totalCacheReadTokens === 99000`。RED を確認してから `src/proxy-server.js:3553-3586` を `parseUsageObservation()` への委譲へ置き換え、`:3002-3004` で `await` して `updateUsage()` を1回だけ呼ぶ。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/proxy-server.test.js
```

Expected: 0 fail。

- [ ] **Step 7: commitする**

```bash
git add src/usage-observation.js test/usage-observation.test.js src/proxy-server.js src/account-manager.js test/proxy-server.test.js test/account-manager.test.js
git commit -m "fix(usage): 圧縮された応答本文を解いてキャッシュ4分類まで集計する（totalRequests が 0 のままだった欠陥）"
```

---

### Task 2: proxy 行への観測フィールド追記と `observability` 設定

**Files:**
- Create: `src/session-key.js`
- Create: `test/session-key.test.js`
- Modify: `src/usage-observation.js`（`DEFAULT_OBSERVABILITY` / `normalizeObservability`）
- Modify: `src/proxy-server.js:2959-2974`, `:3323-3353`, `:3369-3384`, `createProxyServer` の設定解決と `:382-439`
- Modify: `src/cli.js:373-393`
- Test: `test/proxy-server.test.js`

**Interfaces:**
- Produces: `sessionKeyFrom(req, body) -> string|null`、`sidHash(key) -> string|null`（12 hex）。
- Produces: `normalizeObservability(raw) -> frozen { requestLog: { enabled, sessionFromBody, maxBodyBytes }, upstream: { dropUndecodableAcceptEncoding }, logMaxBytes }`。
- Produces: `observationLogFields(observationLog) -> string`（先頭に空白を持つ追記文字列。`null` なら空文字列）。
- Changes: `writeProxyLog(logger, event, degradeLog, affinityLog, observationLog)`。

- [ ] **Step 1: セッション鍵の純関数を sticky と同一挙動で切り出す**

`src/session-key.js` に `normalizeSessionKey` / `sidHash` / `sessionHeaderValue` / `sessionIdFromBody` / `sessionKeyFrom` を、`session-affinity-20260914/src/session-affinity.js:52-160` から**意味を変えずに**写す。`test/session-key.test.js` は sticky の `test/session-affinity.test.js` の該当ケースと同じ入力・同じ期待値にする。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/session-key.test.js
```

Expected: 0 fail。12 hex 以外を返す入力が無いこと、生 id が戻り値に含まれないこと。

- [ ] **Step 2: 設定の正規化を書き、値域を固定する**

`normalizeObservability()` を `src/usage-observation.js` へ足す。不正値は安全側（`enabled` は真偽以外すべて既定、`maxBodyBytes` は 1 MiB〜64 MiB へクランプ、`logMaxBytes` は 1 MiB〜256 MiB へクランプ）。テストは `test/usage-observation.test.js` へ `['true', 1, 'yes', {}, [], null, undefined, 0, false]` を回す既存の型で書く。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/usage-observation.test.js
```

Expected: 0 fail。戻り値が `Object.isFrozen`。

- [ ] **Step 3: 追記フィールドを要求する失敗テストを書く**

`test/proxy-server.test.js` へ、`x-claude-code-session-id: 'sess-abc'` を付けた要求が、`anthropic-ratelimit-unified-5h-utilization: '0.76'` 等を返す偽上流を通ったあと、`logLines` の `proxy` 行が次を満たすことを固定する。

```js
assert.match(
  logLines.find(line => line.includes(' proxy ')),
  / model=claude-opus-5-1 sid=[0-9a-f]{12} in=10 out=20 cr=99000 cc=1500 c1h=1500 c5m=0 u5h=0\.76 u5hReset=\d+ u7d=[\d.]+ u7dReset=\d+ enc=gzip$/,
);
```

`x-claude-code-session-id` を付けない要求では `sid=-` になることも別 `it` で固定する。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/proxy-server.test.js
```

Expected: 追記が無く FAIL。

- [ ] **Step 4: 結線して GREEN にする**

`observationLogFields()` を `degradeLogFields()`（`:3361-3367`）の隣へ新設する。`writeProxyLog` / `recordProxyRequest` へ引数を1本足す。`forwardOnce` で `extractUsage` の呼び出しを `recordProxyRequest`（`:2959`）の**手前**へ移し、得た観測を両方へ渡す。`updateUsage()` の呼び出し条件は現行のまま据え置く。`sid` は `affinityLog` が `null` のときだけ出す。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/proxy-server.test.js
```

Expected: 0 fail。

- [ ] **Step 5: reload を結線する**

`src/cli.js:386` の隣へ `reloadObservability` を足し、`createProxyServer` の `/internal/reload`（`:382-439`）で `normalizeObservability()` を通し直す。セクションを消したら既定へ戻ることをテストで固定する（`test/proxy-server.test.js` の `describe('openai-bridge degradeMapping config-notice の配線')` と同じ型）。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/proxy-server.test.js
```

Expected: 0 fail。reload を2回叩いても通知行が増えない。

- [ ] **Step 6: commitする**

```bash
git add src/session-key.js test/session-key.test.js src/usage-observation.js src/proxy-server.js src/cli.js test/proxy-server.test.js test/usage-observation.test.js
git commit -m "feat(observability): proxy 行へ model・sid・キャッシュ内訳・枠使用率を追記し reload で切り替える"
```

---

### sticky rebase（27 番）への注記

段 P と同便で配備するため、本計画のブランチは sticky 先端 `13728e6` と合流する。実測に基づく注意点は次の3つ。

- **衝突は出ない見込み。** `git merge-tree` の衝突マーカーは 0 件（起点 `60da9aa`・sticky 先端 `13728e6` で確認）。`src/proxy-server.js` の 13 hunk はすべて「同じ位置に引数を1本足す」型で、意味的に重なっていない。
- **合流後にやること**は2つだけ。①`writeProxyLog` の第4引数（`affinityLog`）に sticky R-S7 の実引数を実際に渡す ②`affinityLogFields()` を `degradeLogFields` と `observationLogFields` の間へ挟む。引数順 `(logger, event, degradeLog, affinityLog, observationLog)` と連結順は本計画で先に確定させてある。
- **`sid=` の二重出力に注意する。** `observationLogFields` は `!affinityLog?.sid` のときだけ `sid=` を出す。sticky 側が `affinityLog.sid` を持つ行では自動的に譲るが、**鍵なし要求では `observationLog` 側が `sid=-` を出し続ける**のが正しい挙動である（セッション付与率の測定に必要）。ここを「`affinityLog` が `null` のときだけ」に戻さないこと。

---

### Task 3: 切替ログの穴だけを塞ぐ — **削除（実施しない）**

**受入判定（`fable-judge`）の差戻し条件1により、このタスクは計画から削除した。**

理由: sticky R-S1（`c76ff12`）が起点 `60da9aa` に含まれており、`src/proxy-server.js` の
`selectBestExhaustedFallback({ trigger: 'request' })` と prepare-resume の両経路に `trigger` が
既に渡っている。よって段 P の配備で `trigger=unknown` は出ない。ここへ手を入れると
**sticky 所有の行を本計画が二重に変更する**ことになり、リスク R-4（二重実装）を自ら踏む。

`account_switch` 行の検証は sticky 側のテストが持っている。本計画は `account_switch` を
一切変更しない（`src/account-manager.js` で触るのは usage 系の `:147` / `:846` / `:1209` だけ）。

---

### Task 4: ログ量とローテーション

**Files:**
- Modify: `src/cli.js:372`
- Test: `test/log-rotation.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: `maybeRotateLog({ fd, logPath, maxBytes })`（`src/log-rotation.js:30`。引数は既にある）。

- [ ] **Step 1: `logMaxBytes` が `createServerLogWriter` へ渡ることを要求する失敗テストを書く**

`test/log-rotation.test.js` へ、`createServerLogWriter({ logPath, maxBytes: 1024 })` が 1 KiB 超で `.1` を作ることを固定する（既存テストの型を流用）。`test/cli.test.js` へ、`config.observability.logMaxBytes` が writer へ渡ることを固定する。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/log-rotation.test.js test/cli.test.js
```

Expected: `config.observability` が読まれず FAIL。

- [ ] **Step 2: `cli.js` を直して GREEN にし、README へ非対称を書く**

`src/cli.js:372` を `createServerLogWriter({ logPath, maxBytes: observability.logMaxBytes })` にする。README に「`logMaxBytes` だけは `POST /internal/reload` では効かず再起動が必要」と、保全期間の見積り（32 MiB × 2 世代 ＝ 約 4.1 日）を書く。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/log-rotation.test.js test/cli.test.js
```

Expected: 0 fail。

- [ ] **Step 3: commitする**

```bash
git add src/cli.js test/log-rotation.test.js test/cli.test.js README.md
git commit -m "feat(observability): server.log のローテーション閾値を設定可能にする"
```

---

### Task 5: 不変性の固定と full check

**Files:**
- Modify: `test/invariance.test.js`
- Modify: `README.md`

- [ ] **Step 1: 無効時にバイト同一であることを固定する失敗テストを書く**

`test/invariance.test.js` へ次の3点を固定する。①`enabled:false` の構成の `proxy` 行が `6baf211` の形と完全一致する ②未指定（既定 on）の行は、`enabled:false` の行を前半にそのまま含み、観測は末尾に足されているだけである（`durationMs` だけは実測値なので既存 `normalizeLogLines` と同じ規則で正規化してから突き合わせる） ③生のセッション id が `logLines` と `exportState()` の実バイト列のどこにも現れない（positive control つきの走査）。

Run:

```bash
node --import ./fixtures/service-command-guard.js --test test/invariance.test.js
```

Expected: 0 fail。

- [ ] **Step 2: README を書く**

`observability` の3キーと既定値、追記フィールドの語彙表、`enc=` と `usageParse=` の読み方、切戻しの2段、`sid` が 12 hex で生 id を出さないことを書く。`account_switch` は sticky の機能であることを明記し、重複説明を書かない。

- [ ] **Step 3: 正本 full check を1回実行する**

Run:

```bash
npm run check
```

Expected: lint 0、テスト 0 fail。`scripts/lint.js` の秘密検査（`accessToken|refreshToken|authorization|apiKey|secret` を含む `console.*`）に引っかからない。

- [ ] **Step 4: commitする**

```bash
git add test/invariance.test.js README.md
git commit -m "test(observability): 無効時のバイト同一と生セッション id 非出力を固定する"
```

---

### Task 6: 配備準備とレビュー

- [ ] **Step 1: 差分を通しで読み、行数を実測する**

Run:

```bash
git diff --stat <起点SHA>..HEAD
git diff <起点SHA>..HEAD -- src/
```

Expected: `src/` の変更が `usage-observation.js`（新規）・`session-key.js`（新規）・`proxy-server.js`・`account-manager.js`・`cli.js` の5つに収まり、`src/config.js` に差分が無い。`forwardWithRotation` は**引数を1本足した行だけ**が差分であること（本体のロジックに差分が出ていたら設計が崩れているので止める）。

- [ ] **Step 2: sticky との衝突を先に確認する**

Run:

```bash
git merge-tree $(git merge-base HEAD feat/session-affinity) HEAD feat/session-affinity | grep -c '<<<<<<<'
```

Expected: 衝突は `writeProxyLog` / `recordProxyRequest` / `forwardOnce` の隣接3箇所のみ。`extractUsage` と `buildUpstreamHeaders` に衝突が出たら設計が崩れているので止める。

- [ ] **Step 3: L1 受入レビューへ出す**

差分・実出力・本計画書へのリンクを添えて `reviewer`（Opus・xhigh）へ出す。観点は、①`content-encoding` 対応が本文の**書き換え**になっていないこと ②`sid` から生 id が復元できないこと ③無効時のバイト同一 ④解凍がイベントループを塞がないこと ⑤`totalRequests` の意味変更が `monitor` の表示を壊さないこと ⑥ログ量の見積りが実測に基づくこと。

- [ ] **Step 4: 配備の承認を取る（オーナー）**

未決事項 U-1〜U-4 を4点セット（何を決めるか・なぜ決める必要があるか・選択肢・推奨）で出す。承認前に配備・reload・再起動をしない。

- [ ] **Step 5: 配備し、根本原因の最終確認をする**

「配備」節の確認コマンド 1〜6 を順に実行する。**確認 2 で `enc=-` が支配的、かつ確認 4 の `totalRequests` が 0 のままなら、根本原因の推定が外れている。** その場合は切戻し段1を実行し、`usageParse=` の分布を証拠として再調査へ戻す。

---

## 工数見積り

`coder`（Opus 5・xhigh）1本で実装する前提。レビュー往復と配備立会いを含む。
**受入判定の Follow-up で実勢へ改訂した（Task 3 削除・Task 5 を実測へ引き下げ・Task 1 に Step 0 を追加）。**

- Task 1（Step 0 の実測・根本原因の修正・キャッシュ4分類・集計の意味修正）: 6〜8 人時
- Task 2（proxy 行への追記・セッション鍵・設定と reload）: 5〜7 人時
- Task 3: **削除**（0 人時）
- Task 4（ローテーション）: 2〜3 人時
- Task 5（不変性・README・full check）: 2〜3 人時
- Task 6（差分確認・衝突確認・L1・配備）: 3〜5 人時

**合計 18〜26 人時。** 旧見積り 30〜42 人時からの主な減少要因は、①Task 3 の削除 ②`test/proxy-server.test.js`
が 10,877 行あっても本計画が触るのは `extractUsage` 周辺の数ケースに限られること ③`test/invariance.test.js`
が 786 行と小さく、既存テスト5「no-identifier-in-degrade-logs」の型をそのまま流用できること、の3点である。

## リスク

- **R-1（最大）: 根本原因の推定が外れている場合、Task 1 の修正が効かない。** 本番応答に実際に `content-encoding` が付いているかを直接観測していない（外部 API を直接叩けず、稼働中 rotator へ要求も送れないため）。緩和は二重で置いてある。①Task 1 Step 1 の gzip テストが「圧縮されていれば現行は必ず 0 件になる」ことを機構として証明する ②`enc=` と `usageParse=` を本番へ出すので、配備後の最初の 2,000 行で真偽が決まる。**外れていた場合でも、追加した観測フィールド自体は残り、次の調査の材料になる**（`usageParse=` がどの理由で落ちているかが分かる）。
- **R-2: `sid` の桁数が依頼文（8桁）と違う。** sticky と揃えて 12 桁にしたが、承認前に実装すると手戻りになる。U-2 で先に決める。
- **R-3: ログ保全期間が縮む。** `logMaxBytes` を上げなければ 2.4 日から 1.3 日へ落ち、RCA の3日分解析が再現できなくなる。Task 4 を落とさない。
- **R-4: sticky との二重実装。** `account_switch` を作り直さないこと、`sid` を二重に出さないこと、`sessionKeyFrom` を2箇所に持たないこと、の3点が守られないと、段 P・sticky 本体・本計画のどれかが rebase で壊れる。Task 6 Step 2 の `merge-tree` で機械的に確認する。
- **R-5: 解凍のコスト。** 1応答あたり数 ms のイベントループ占有が積み上がると、同時 100 連鎖のピークで遅延になる。非同期版を使い、`maxBodyBytes` で上限を置くことで緩和するが、配備後に `durationMs` の分布を配備前と比較する必要がある（確認コマンドに入れていないので、Task 6 Step 5 で `awk` による分位点比較を追加する）。
- **R-6: 本文へ触ること自体のリスク。** rotator の強みは「本文を無改変で転送する」ことで、RCA §5 H4 はこれを棄却根拠にしている。本計画は `Buffer.concat` 済みの**写しを読むだけ**でクライアントへ流すバイト列には触れないが、実装で誤ってヘッダの `content-encoding` を落とすと応答が壊れる。Task 5 Step 1 の不変性テストで固定する。
- **R-7: PII。** `metadata.user_id` は `user_<hash>_account_<uuid>_session_<uuid>` の形で口座 UUID を含む。第1段では本文を読まない設定（`sessionFromBody:false`）を既定にし、有効化する場合も `session_id` 部分だけを取り出して即ハッシュする。生値をログにも状態ファイルにも残さない。

---

## 未決事項

**U-1〜U-4 は母艦が即決済み（2026-09-18）。以下は決定内容。U-5・U-6 は配備後の実測で決める。**

- **U-1（決定）: 段 P（sticky R-S1・R-S2）と同便で配備する。** 起点は `60da9aa` に固定した。`6baf211` 起点で先に作って後から rebase する案は採らない。
- **U-2（決定）: `sid` は 12 hex** とする（sticky の語彙に合わせる）。依頼文の 8 hex からは意図的に逸脱している。これで `account_switch` / `affinity_*` / `proxy` の3系統が同じ鍵で突合できる。
- **U-3（決定）: `observability.requestLog.enabled` の既定は `true`。** 配備通知に「`proxy` 行の長さが約 1.9 倍になる（182 B → 約 346 B）」「`POST /internal/reload` で現行の行へ戻せる」の2点を明記する。
- **U-4（決定）: `logMaxBytes` は 32 MiB。** 2世代で 64 MiB ＝ 約 4.1 日となり、現行（約 2.4 日）より広くなる。
- **U-5: `observability.requestLog.sessionFromBody` を第2段でいつ有効化するか。** ヘッダ付与率（配備後の確認コマンド 5）が 9 割を超えていれば本文フォールバックは不要で、要求本文の追加解析コストを払わずに済む。付与率が低ければ有効化する。**配備後 24 時間の実測で決める。**
- **U-6（実質解決）: `zstd` の扱い。** Task 1 Step 0 で **Claude Code が `accept-encoding: gzip, deflate, br, zstd` を送ることが確定**した。**本番の rotator プロセスは Node v22.22.2 で動いており `zlib.zstdDecompress` を持つので、`content-encoding: zstd` が返っても解凍して数えられる。** したがって本番では①上流向けの書き換えは発動せず（要求ヘッダはバイト同一）②`enc=zstd` の行が出ても `usageParse` は `ok` になる。残る論点は「開発機の既定 `node` が v20.19.0 で zstd の分岐をテストできない」ことだけで、`test/usage-observation.test.js` は Node 22 系では実際に zstd を往復させ、20 系では `t.skip()` で**明示的に飛ばした**と記録する（通ったつもりにしない）。`engines` の `>=18.18.0` を引き上げるかは別途。

---

## 受入判定の Follow-up（事実の訂正）

- `test/invariance.test.js:816 以降` という参照は**起点 `60da9aa` には存在しない**（同ファイルは 786 行）。その型のテンプレートは sticky R-S13 側にある。本計画では既存テスト5「no-identifier-in-degrade-logs」の型に倣って新規に書く。
- 口座数は**現在 16**（本文「根本原因」節の「15口座すべて」は `runtime-state.json` の `savedAt` 2026-09-18T00:20:09Z 時点の値であり、その時点の記述としてはそのまま残す）。
- 工数の実勢は **18〜26 人時**（旧 30〜42 人時から改訂）。
