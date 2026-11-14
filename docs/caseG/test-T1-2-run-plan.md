# 試験T1-2 実機の手順書: 案A（ヘルパーで認証を移す）

作成: 2026-11-03 23:30 JST（Grok Bot）。状態: **手順書だけ。まだ実行しない。** 坂根さんが在席している日に行う。
対象の試作: worktree `claude-rotator-wt/caseG-T1-helper`、ブランチ `test/caseG-T1-helper`、**8d7a4d5**（push なし）。
関連: `test-T1-plan.md` §10・§11、`records/caseG-T1-2-proto-review-20261103.md`（二重レビューと坂根さんの受け入れ判断）、`records/caseG-T1-1-tonight.md`。

## 0. 結論（先に）

- やること: T1-1 のレーン（`caseG-T1-run1/lane`、14番 fde@）で動いている Claude Code を**閉じずに**、ヘルパーで認証だけを 15番 develop@ に移し、再起動なしに追従するかを見る。戻すのも同じ方法。
- 受け入れ済みの危険（坂根さん 2026-11-03 23:09 JST、カード t77s604）: 照合から書き込みまでの数十ミリ秒に元の口座が refresh すると、その新しい認証を失う（ブラウザで再ログインすれば戻る）。そのため**入力待ちのときに切り替える**、**事前に再ログインで戻せることを確かめる**。
- 順序: **T1-1 が終わってから**（T1-1 の段6で両タブを `/exit` した後）。T3 は T1-2 の後。同じ口座（14番・15番）を同時に試験しない。
- 坂根さんの作業: ブラウザでのログイン1〜2回、Keychain 画面の「許可」（回数を数える）、画面の確認。約45分＋翌朝の確認5分。

## 1. 使う口座・フォルダ・項目（本番と分ける）

| 役 | 口座 | フォルダ | Keychain 項目 |
|---|---|---|---|
| レーン（alpha。T1-1 の最後で 14番に戻した状態） | 14番 account-a@example.com | `$HOME/caseG-T1-run1/lane` | `Claude Code-credentials-<redacted>` |
| 取り込み元（beta） | 15番 develop@ | `$HOME/caseG-T1-run1/src15`（新規） | `Claude Code-credentials-<redacted>`（新規。sha256 の先頭8桁を計算済み） |
| 保管（ヘルパーが作る） | — | — | `caseG-T1-vault-alpha`、`caseG-T1-vault-beta`（Claude Code は読まない名前） |
| 試験の記録 | — | `$HOME/caseG-T1-run1/trial`（新規、0700） | 台帳 `ledger.json`、ログ `events.jsonl`、`journal.json`（値は入らない） |

- 外部設定: `$HOME/caseG-T1-run1/trial-config.json`（リポジトリの外。値は入れない）。`acct` は `<user>`。余裕30分・見張り60〜120秒・間隔1秒（下限より短くできない）。
- 使わないもの: 本番の `Claude Code-credentials`（番号なし）、`~/.claude.json`、`~/.claude/settings.json`、試験3の `cfg14`・`cfg15`（T3 で使う）、PID <pid>・33261・13945、ポート 37891。
- 実行ファイル: T1-1 と同じ `$HOME/.local/share/claude/versions/2.1.317`（`DISABLE_AUTOUPDATER=1`）。起動行は T1-1 と同じ形で、`CLAUDE_CONFIG_DIR` だけを替える。
- 注意: ヘルパー自身は動作の中で Keychain の値をメモリに読み、`security -i` で書く（試作の設計どおり。値は出力・記録しない）。私たち（Grok Bot）は `security -w`・`-g`・`dump-keychain` を使わない。

## 2. 事前の確認（私たち、読むだけ）

1. T1-1 の結果が合格で、段6まで終わっている（タブA・Bとも `/exit`）。T1-1 が不合格なら T1-2 はしない。
2. `records/caseG-T1-2-check.sh` を1回流す: 3プロセス（73215・33261・13945）が生きている、37891 が本番のまま、`88a534ad` は acct=<user> の1件、`5dba3199`・`caseG-T1-vault-*` はまだ無い、`src15`・`trial` はまだ無い。
3. 試作が 8d7a4d5 のままで、作業ツリーに変更が無い（`git -C … status -s` が空、`git log -1`）。
4. 本番 Rotator が 14番・15番を今使っていないことを、坂根さんが Rotator の画面で確かめる（私たちは 37891 に触れない）。

## 3. 坂根さんに事前にお願いすること

- **戻し方の確認**: 14番 fde@ と 15番 develop@ の両方に、プライベートウィンドウで claude.ai へサインインできること（パスワード・2段階認証が手元にある）を確かめる。T1-1 の段1・段5で、レーンで `/login` すれば戻ることは確かめ済みになる。
- **Keychain の画面**: 出たら毎回、時刻・項目名・求めているアプリ名をチャットに貼る。押すのは**「許可」だけ**（「常に許可」は押さない）。本番の `Claude Code-credentials`（番号なし）や表の外の名前なら**「拒否」して中止**。
- **切り替えるとき**: レーンのタブ（以下タブL）は、返答が終わって**入力待ち**の状態にしておく。切り替えの間は何も入力しない。
- **タブL は次の切り替えが済むまで閉じない**（`/exit` しない）。

## 4. 手順

| 段 | 誰が | すること | 記録・合格の目安 |
|---|---|---|---|
| 1 | 坂根さん | 新しいタブ「T1-2-src15」で、起動行の `CLAUDE_CONFIG_DIR` を `$HOME/caseG-T1-run1/src15` にして起動（フォルダは私たちが事前に `mkdir -m 700`）。`/login` で **15番 develop@**。`/status` で Email が develop@、API Usage Billing なし。**質問はしない**。`/exit` | Keychain 画面の回数。私たち: `5dba3199` が acct=<user> の1件 |
| 2 | 坂根さん | 新しいタブ「T1-2-L」（タブL）で、T1-1 と同じ起動行（`lane`）を起動。`/status` で fde@、`/usage`、短い質問1回。入力待ちにする | Email 行、`/usage` の文言 |
| 3 | 私たち | 外部設定を書く（値なし）。`status` → `import --account alpha`（計画だけ）→ `import --account alpha --apply` → `import --account beta --apply` | 各出力（`imported`・`sourceConsumed: true`）。Keychain 画面の回数。**src15 はこの後二度と起動しない** |
| 4 | 私たち | `switch --to beta`（計画だけ）→ 坂根さんに「入力待ちですか」と確かめてから `switch --to beta --apply` | 出力 `switched`・`verified: true`。終了時刻 |
| 5 | 坂根さん | タブLで `/status` を 0・3・10・30・60秒。60秒で `/usage` と短い質問1回 | 各時点の Email。60秒以内に develop@、`/usage` も15番、答える、API Usage Billing なし |
| 6 | 私たち→坂根さん | タブLが入力待ちなのを確かめて `switch --to alpha --apply`。段5と同じ確認 | 60秒以内に fde@ に戻る |
| 7 | 両方 | 段4〜6 が合格で、Keychain 画面が1切り替えあたり1回以下なら、往復を追加（合計で最大5往復）。画面が毎回2回以上出るなら追加しない | 往復ごとの合否と画面の回数 |
| 8 | 私たち | 最後に `switch --to beta --apply`（15番の状態で置く）。タブLは入力待ちのまま**閉じない**。`status` を 1時間後と翌朝（12時間以上後）に流す | `laneTimestampMismatch` が false、`88a534ad` の mdat が切り替え時刻から動いていない。翌朝、タブLの `/status` が develop@ のまま |
| 9 | 私たち→坂根さん | 翌朝 `switch --to alpha --apply` で 14番に戻す。`EXPIRY_UNSAFE`（保管中の認証の期限が近い）で断られたら、タブLで `/login` → 14番 fde@ で戻す（失敗ではない。記録する） | 戻ったか、どちらの方法か |
| 10 | 坂根さん→私たち | タブLで `/exit`。私たちが `caseG-T1-2-check.sh` と `status` を流す | 3プロセスが生きている、予定外の項目が無い |

- `/feedback` は T1-1 で確かめるので、T1-2 では送らない。送るならその都度文面を承認してから。
- ヘルパーのコマンドは README の構文どおり（`CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js … --config $HOME/caseG-T1-run1/trial-config.json`）。Mac で実行する前に毎回承認をもらう。

## 5. 合格の条件（T1-2）

- 切り替えるたびに、再起動なしで 60秒以内に `/status` の Email と `/usage` が新しい口座になり、短い質問に答える。API Usage Billing が出ない。
- ヘルパーが毎回 `switched`・`verified: true` を返し、隔離（`R8_SUSPECTED`・`caseG-T1-vault-quarantine-*`）が起きない。
- 段8で、翌朝まで `laneTimestampMismatch` が false で、タブLが develop@ のまま（元の口座の書き戻しが無い）。false だけでは「無い」と言い切れないので、`/status` の表示と mdat を合わせて判断する。
- Keychain 画面は、ログインのときと、ヘルパーが初めて項目に触るときだけ（回数を記録。合否は変えない）。
- 本番 Rotator（73215）・試験タブ（33261・13945）・37891 に変化が無い。

## 6. 中止の条件（どれかで止める。その場で再試行しない）

- ヘルパーが `refused`（`R8_SUSPECTED`・`EXPIRY_UNSAFE` 以外のコードを含む）や隔離を返す → 止める。**ロック・ジャーナルは消さない**（README のとおり、人が持ち主を確かめるまで再試行しない）。
- タブLに Not logged in・Login expired・API Usage Billing・Email の不一致が出る。
- Keychain 画面に本番の項目名（番号なし）や表の外の名前 → 「拒否」して止める。
- 予定外の Keychain 項目ができる（削除はしない。報告だけ）。
- PID <pid>・33261・13945 のどれかが消える。本番 Rotator で 14番・15番がエラーになる。
- 坂根さんが止めたいとき。

## 7. 戻し方

- 認証を失ったとき（受け入れ済みの窓、または中止）: タブLで `/login` → 14番 fde@（プライベートウィンドウ）。レーンは元どおり使える。15番は src15 を使わず、必要なら新しいフォルダで正規にログインし直す。
- 本番には書かないので、本番の戻しは不要（同じ口座の使用量は少し減る）。
- 後片付け（全プロセス終了後、1件ずつ承認を得てから）: `caseG-T1-vault-alpha`・`caseG-T1-vault-beta`・`Claude Code-credentials-<redacted>`・隔離項目（できた場合）・`trial` と `src15` フォルダ。削除の直前に `-s 名前`（値なし）で1件だけと確かめる。予定外の項目は消さない。`/logout` は使わない。

## 8. 前後の確認コマンド（値を出さない）

- `records/caseG-T1-2-check.sh`（属性 acct・cdat・mdat、ps、lsof、ファイル名とサイズだけ）。
- ヘルパーの `status`（項目の有無・更新時刻・台帳・`laneTimestampMismatch` だけ。値を読まない）。
- 実行する Mac コマンドは毎回、先頭に `export PATH="/usr/local/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH";` を付け、承認をもらってから流す。
