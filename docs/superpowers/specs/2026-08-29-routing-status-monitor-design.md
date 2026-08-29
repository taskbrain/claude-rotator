# Model-aware Routing Status and Monitor Design

## 目的

複数の Claude Code ターミナルやサブエージェントが Fable、Sonnet、
Opus、Haiku を同時に利用しているとき、Claude Rotator がリクエストごとに
適切なアカウントを選ぶ既存動作を回帰テストで固定する。同時に、全アカウントが
利用不能な場合でも、どのモデル系列がどのアカウントで何時に復帰し、その後どの
順番で復帰するかを `status` と `monitor` から一目で確認できるようにする。

## 対象内

- Fable と Other（Sonnet / Opus / Haiku / 識別不能モデル）の2系列別復帰順。
- 各アカウントに同時適用される制限をすべて考慮した復帰予定時刻。
- 現在利用可能なアカウント、時刻付きで復帰するアカウント、復帰時刻不明の
  アカウントの安定した並び順。
- 横幅が十分な端末での、復帰順とアカウント詳細の2列表示。
- 既知の Fable 枯渇状態で同時に到着した Fable と Sonnet リクエストが別々の
  適切なアカウントへ流れる回帰テスト。
- `status` と `monitor` の同一レンダラー利用。

## 対象外

- ターミナルまたは会話セッション単位のアカウント固定。
- 同一系列の並列リクエストを複数アカウントへ均等配分するロードバランサー。
- 新しいモデル系列や設定項目の追加。
- 既存のアカウント選択スコア、クォータ取得、OAuth 更新処理の変更。
- ANSI カラー、対話操作、全画面 TUI フレームワークの導入。

## 現行動作

`src/proxy-server.js` は各 `POST /v1/messages` の JSON body から `model` を
読み、`claude-fable-<数字>` で始まるモデルを Fable、それ以外を Other として
`AccountManager.getActiveAccount(modelFamily)` へ渡す。この判定はターミナルや
親子エージェントではなく、個々の HTTP リクエストごとに実施される。

`AccountManager` は Fable 限定週次枠だけが枯渇している場合、Fable リクエスト
だけを別アカウントへ送り、`currentIndex` を変更しない。そのため後続または同時の
Sonnet / Opus / Haiku リクエストは元のアカウントを利用できる。共通5時間枠、
共通7日枠、token/request 枠、認証エラー、一時停止は全系列を停止する。

既存テストは逐次リクエストと、429 後の並行 Usage 確認をカバーする。一方、
既知の Fable 枯渇状態から開始して Fable と Other を同時に送る、最も直接的な
並列ルーティング契約はまだ固定されていない。

## 設計判断

### 1. 復帰順は AccountManager が生成する

`AccountManager.getStatus()` に次の加算的な内部ステータス契約を追加する。

```js
routingAvailability: {
  fable: [
    {
      account: 'acct_2',
      accountName: 'ax@example.com',
      state: 'waiting',
      availableAt: '2026-08-29T09:09:00.000Z',
    },
  ],
  other: [
    {
      account: 'acct_1',
      accountName: 'cirkit@example.com',
      state: 'available',
      availableAt: null,
    },
  ],
}
```

`state` は次の3値とする。

- `available`: 現在の系列で直ちに選択可能。
- `waiting`: 適用中の全ブロッカーに未来の解除時刻があり、復帰時刻を計算可能。
- `unknown`: 永続的な認証エラー、解除時刻のない枯渇、または選択に必要な
  クォータ情報がない。

描画側はこの契約を表示するだけとし、アカウント選択規則を再実装しない。
既存 `/internal/status` のフィールドは変更・削除せず、新フィールドのみ追加する。

### 2. 復帰予定は「適用される最後の解除時刻」

アカウントがある系列で利用可能になるには、その系列に適用されるすべての
ブロッカーが解除される必要がある。`waiting.availableAt` は適用ブロッカーの
解除時刻の最大値とする。

Fable に適用するブロッカー:

- 共通5時間枠。
- 共通7日枠。
- token 枠。
- request 枠。
- Fable と識別された `weeklyScoped` 枠。
- `rateLimitedUntil` で表される一時停止または credential refresh cooldown。

Other に適用するブロッカー:

- 共通5時間枠。
- 共通7日枠。
- token 枠。
- request 枠。
- `rateLimitedUntil` で表される一時停止または credential refresh cooldown。

Fable 限定 `weeklyScoped` 枠は Other へ適用しない。未知の scoped 枠も既存の
ルーティング規則どおり、どちらの系列も停止しない。

適用中のブロッカーが1つでも解除時刻を持たない、解除時刻がすでに過ぎているのに
枯渇値が残っている、または `status === 'error'` の場合は `unknown` とする。
根拠のない復帰予定を表示しない。

### 3. 並び順

系列ごとに次の順序で表示する。

1. `available`。現在アカウントがその系列で利用可能なら最初に置く。
2. その他の `available`。既存 `switchTargetScore` と同じ比較順を使う。
3. `waiting`。`availableAt` の昇順。
4. `unknown`。設定上のアカウント順。

同時刻の `waiting` は設定上の優先度とアカウント順で安定化する。表示は将来の
ターミナル固定を約束せず、リクエスト到着時点での共有ルーターの候補順を示す。

### 4. status / monitor 表示

先頭の `active:` は、クォータ枯渇中でも `currentIndex` を示していたため、
実際に利用可能という誤解を招く。互換性のない機械可読出力ではないため、表示を
`current:` に変更する。

直後に `Routing availability` を置く。横幅が十分なら Fable と Other を左右に、
狭ければ上下に表示する。

```text
Claude Rotator                         current: cirkit@example.com

Routing availability
Fable (none now)                         Other (Sonnet / Opus / Haiku)
  1. ax@example.com  in 3h22m -> 08/29 18:09 JST
  2. dev@example.com in 4h12m -> 08/29 19:00 JST
                                          1. cirkit@example.com now
                                          2. fde@example.com    now
```

各行は `available` を `now`、`waiting` を
`in <duration> -> <JST timestamp>`、`unknown` を `unknown` と表示する。
全アカウントの順番を省略しない。

アカウント詳細は既存情報を維持したカードにし、各カードへ次を追加する。

```text
routes Fable: 3h22m | Other: now
```

カードの全行を実際に測定し、2カードと3文字の間隔が端末幅へ収まる場合だけ2列に
する。収まらない場合は1列へ戻す。文字列を切り捨てず、パイプ出力でも情報を失わ
ない。ANSI 色は使わない。`renderStatus(status, { columns, now })` の `columns` が
未指定なら、その呼び出し時点の `process.stdout.columns`、取得不能なら80列を使う。
このため `monitor` は再描画ごとに端末リサイズへ追従する。

Events は時系列の読みやすさを優先して従来どおり1列とする。

### 5. 並列モデルルーティングの保証

実 upstream の代わりにテスト HTTP server を使い、以下を同時に開始する。

- `claude-fable-5`。現在アカウントは Fable 枠だけ枯渇済み。
- `claude-sonnet-5`。同じ現在アカウントの共通枠には余裕がある。

upstream は両リクエストが到着するまで応答を保留し、真に重なった状態を作る。
body のモデル名と Authorization の組を記録し、Fable が代替アカウント、Sonnet が
現在アカウントを使うこと、および `currentAccount` が変わらないことを確認する。
認証値はテスト専用のダミー値だけを使い、実 credential は扱わない。

このテストは既存動作の characterization / regression test であり、通過する場合は
proxy の本番コードを変更しない。新しい表示機能は別の失敗するテストから TDD で
実装する。

## エラーと互換性

- `routingAvailability` を持たない古い status payload は、系列欄を `no data` と
  表示し、既存アカウント詳細と Events は引き続き描画する。
- accounts が空なら両系列を `no accounts` と表示する。
- 無効な日時は `unknown` とし、`Invalid Date` や負の待ち時間を出さない。
- 出力は人間向けであり、JSON status の既存フィールドを利用する外部 consumer を
  壊さない。

## 検証

Focused verification:

```bash
node --test test/account-manager.test.js test/monitor.test.js test/proxy-server.test.js
```

変更後の正本 full check:

```bash
npm run check
```

実環境ではテスト済み immutable snapshot へ配布後、以下を確認する。

- `/internal/health` が HTTP 200。
- `claude-rotator status` に2系列の復帰順と `current:` が出る。
- 十分な横幅の `claude-rotator monitor` が2列、狭い端末相当のレンダーが1列。
- 配布後ログに新規 credential refresh failure または proxy failure がない。

## 設計レビュー

### 要件網羅

- 全停止時の「次」と以後の順番: 系列別の全件スケジュールで満たす。
- Fable とそれ以外の分離: `scopeMatchesModelFamily` と同じ識別規則で満たす。
- 複数ターミナル・サブエージェント: リクエスト単位の並列回帰テストで満たす。
- monitor の縦長問題: 実測幅に基づく2列カードで満たす。
- 狭い端末とパイプ: 情報を切り捨てない1列フォールバックで満たす。

### レビューで修正した点

1. 当初は monitor が status payload から復帰順を再計算する案だったが、
   `switchTargetScore` と将来乖離するため却下した。AccountManager を正本とする。
2. 最初の quota reason の reset を使う案は、5h と Fable が同時に枯渇した場合に
   早すぎる予定を示すため却下した。全適用ブロッカーの最大時刻を使う。
3. 固定幅で文字列を切る案は、認証エラーや正確な時刻を失うため却下した。
   内容が収まる場合だけ2列にする。
4. `active:` は枯渇中の current pointer にも使われるため `current:` へ変更した。
5. 独立レビューで、UTF-16文字数では日本語・emoji・結合文字の端末表示幅を
   判定できない問題を検出した。grapheme単位の表示幅計測をpaddingと2列判定で
   共用し、Unicode名が収まらない場合の1列フォールバックを回帰テストで固定した。

### 残存制約

- モデル名が欠落または未知の場合は既存どおり Other として扱う。
- 復帰後の実際の利用率が次の status 更新で変われば、候補順もその時点で再計算
  される。表示は現在観測済みデータに基づく。
- 2列表示の可否は端末幅と実データ長に依存する。情報を失うより1列を優先する。
