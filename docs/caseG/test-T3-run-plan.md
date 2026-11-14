# 試験T3 実機の手順書: 案C（質問の通信だけ別口座の認証に差し替えるプロキシ）

作成: 2026-11-03 23:30 JST（Grok Bot）。状態: **手順書だけ。まだ実行しない。** 坂根さんが在席している日に行う。
対象の試作: worktree `claude-rotator-wt/caseG-T3-proto`、ブランチ `test/caseG-T3-proxy-proto`、**fcb2883**（push なし）。待ち受けは `127.0.0.1:37991` だけ。
関連: `test-T3-plan.md`（§11 の修正を含む）、`records/caseG-T3-proto-review-20261103.md`（二重レビューと坂根さんの受け入れ判断）。

## 0. 結論（先に）

- 2段で行う。**段1 passthrough**: 何も替えずに通し、正規ログインの Claude Code が `http://` の `ANTHROPIC_BASE_URL` を受け付けるか、サブスク表示が保たれるかを見る。**段2 swap**: 質問（`POST /v1/messages`）を**1回だけ** 15番の認証に差し替え、どちらの口座に使用量が付くかを見る。
- 受け入れ済みの危険（坂根さん 2026-11-03 23:09 JST、カード t77s604。前提: 本人が立ち会う、この Mac の利用者は坂根さんだけ）: 同じ Mac のほかのプロセスでも差し替えた口座で推論できる（token は漏れない）。許可外の Keychain にも項目の有無を問い合わせる（値は読まない）。そのため**プロキシは試験の間だけ動かし、坂根さんが見ている間に止める**。
- 順序: **T1-1 → T1-2 → T3**。T1-2 の段10（タブL を `/exit`）が終わってから。
- 坂根さんの作業: 起動と画面の確認、Keychain 画面の「許可」1回の見込み、`/feedback` の承認1回。約40分。

## 1. 使う口座・フォルダ・項目（本番と分ける）

| 役 | 口座 | フォルダ・項目 |
|---|---|---|
| 表示・ログイン側（タブ） | 14番 fde@ | 試験3の `$HOME/caseG-test3-run1/cfg14`（項目 `…-7b5bcb04`。設定ファイルは変えない） |
| 差し替え先（推論側） | 15番 develop@ | 試験3の `cfg15` の項目 `Claude Code-credentials-<redacted>` を**読むだけ**。更新の持ち主は開いたままのタブ PID <pid> だけ（**13945 には触れない・入力しない**） |
| プロキシの設定・記録 | — | `$HOME/caseG-T3-run1/config.json`、`$HOME/caseG-T3-run1/log/requests.jsonl`（新規、0700。値は入らない） |

- 設定の `swapAccount`: `configDir`=`…/cfg15`、`service`=`Claude Code-credentials-<redacted>`、`acct`=`<user>`、`keychainPath`=`$HOME/Library/Keychains/login.keychain-db`、`keychainAllowlist`=同じ1件。段1では `swapAccount` を省く。
- 本番と分ける点: ポート 37991（本番は 37891）、別プロセス、`src/` は変えない、本番の項目・`~/.claude.json`・`~/.claude/settings.json` に触れない。
- **同じ口座を同時に更新・使用しない**: e694e038 を更新するのは 13945 だけ（本番 Rotator はこの項目を持たない）。試験の間、本番 Rotator が 14番・15番を使っていないことを坂根さんが Rotator の画面で確かめる（私たちは 37891 に触れない）。T1-2 のレーンは閉じておく。
- 起動行（タブ。T1-1 の形に `ANTHROPIC_BASE_URL` だけ足す。ほかの `ANTHROPIC_*` は付けない）:
```
cd $HOME/caseG-test3-run1/work && env -i HOME=$HOME USER=<user> LOGNAME=<user> LANG=ja_JP.UTF-8 TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=$HOME/caseG-test3-run1/tmp/ DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=$HOME/caseG-test3-run1/cfg14 ANTHROPIC_BASE_URL=http://127.0.0.1:37991 $HOME/.local/share/claude/versions/2.1.317
```

## 2. 事前の確認（私たち、読むだけ）

1. T1-2 が終わっている（タブL を `/exit`、`caseG-T1-2-check.sh` で確認済み）。
2. `records/caseG-T3-check.sh` を1回流す: 3プロセスが生きている、37891 は本番のまま、**37991 は空き**、`7b5bcb04`・`e694e038` は acct=<user> の1件ずつ（mdat を記録）、cfg14 を使っている claude プロセスが無い、`security list-keychains` の一覧（パスだけ）。
3. 試作が fcb2883 のままで、作業ツリーに変更が無い。
4. 設定の検証だけを流す（`--mode passthrough`、`--apply` なし。待ち受け・Keychain 読み取り・ログ作成はしない）。

## 3. 坂根さんに事前にお願いすること

- 14番・15番の今の使用量を、プライベートウィンドウの claude.ai（設定の使用量の画面）で見て控える（15番を 13945 で `/usage` しない）。
- Keychain の画面が出たら、時刻・項目名・アプリ名を貼る。**「許可」だけ**。本番の項目名（番号なし）や e694e038 以外なら「拒否」して中止。
- プロキシが動いている間は席を離れない。離れるときは止める。

## 4. 手順

### 段1 passthrough（何も替えない）

| 段 | 誰が | すること | 記録・合格の目安 |
|---|---|---|---|
| 1 | 私たち | 新しいタブ「T3-proxy」でプロキシを `--mode passthrough --apply` で前景起動（承認後） | `started requests=0`。37991 が LISTEN |
| 2 | 坂根さん | 新しいタブ「T3-段1」で上の起動行。`/login` を求められたら**中止して相談** | — |
| 3 | 坂根さん | `/status`: Email が fde@、API Usage Billing なし（Base URL の表示が出れば文言を貼る）。`/usage`。短い質問1回 | ログに `POST /v1/messages` の 2xx、`inboundAuthPresent: true`、`upstreamAuthEqualsInbound: true` |
| 4 | 坂根さん | `/feedback` を1回（文面は `test-T3-plan.md` §6。送る前に承認。記録は添付しない） | 受付 ID。送信時刻とログの全要求を突き合わせる（通らなければ「プロキシ通過は観測されず」と書く） |
| 5 | 坂根さん→私たち | タブを `/exit`。プロキシを Ctrl-C で止める | `stopped requests=N`。37991 が空いた |

- 段1の合格: http の BASE_URL が受け付けられ、サブスク表示のまま質問が通る。不合格（拒否・API Usage Billing・`/login` 要求）なら**段2はしない**。

### 段2 swap（1回だけ差し替える）

| 段 | 誰が | すること | 記録・合格の目安 |
|---|---|---|---|
| 6 | 私たち | 坂根さんに「本番 Rotator が 14番・15番を使っていない」ことを確かめてもらう。プロキシを `--mode swap-messages --apply` で前景起動 | `started requests=0` |
| 7 | 坂根さん | 「T3-段2」のタブで同じ起動行。`/status`（fde@ のまま）。質問を**1回だけ**（少し長めの答えになるもの。例「日本の都道府県を北から順に10個」）。差し替え時に Keychain 画面（e694e038、アプリは security）が出たら「許可」 | ログ: `swapped: true`、`upstreamAuthIsSwapAccount: true`、2xx。画面の回数 |
| 8 | 坂根さん→私たち | すぐ `/exit`。プロキシを Ctrl-C で止める（2回目の質問はしない） | `stopped requests=N` |
| 9 | 坂根さん | 5分ほど後に、claude.ai で 14番・15番の使用量を見る | 15番だけが増えたか（1回では丸めで動かないこともある。その場合は「未確認」） |
| 10 | 私たち | `caseG-T3-check.sh` を流す | 3プロセス、37991 空き、e694e038 の mdat は 13945 の更新以外で動いていない、予定外の項目なし |

- 段2の合格: ログで「その要求は15番の認証で送られた」（`upstreamAuthIsSwapAccount: true`）かつ 2xx。タブの表示は 14番のまま。使用量の画面は補強（動かなければ未確認扱い）。
- T3 は再起動なしの切り替えを確かめない（段1と段2は別起動）。

## 5. 中止の条件（どれかで止める）

- プロキシが 503・403・502/504 を返す、`stopReason` が出る（`r8_suspected` を含む）→ その場で止める。再起動して再試行しない。
- `/login` を求められる。Not logged in・Login expired・API Usage Billing が出る。
- Keychain 画面に本番の項目名・e694e038 以外 → 「拒否」して止める。予定外の項目ができる。
- 37991 以外への待ち受けや、api.anthropic.com 以外への接続が見える。37891 に変化が出る。
- PID <pid>・33261・13945 のどれかが消える。本番 Rotator で 14番・15番がエラーになる。
- 坂根さんが席を離れる、止めたいとき。

## 6. 戻し方

- タブを `/exit`、プロキシを Ctrl-C。本番の設定・項目は変えていない。cfg14 の設定ファイルも変えていない（環境変数だけ）。
- 差し替えで 15番が拒否・期限切れになっても、プロキシは refresh も書き込みもしない（読むだけ）。13945 が自分で更新する。
- 後片付け（承認を得てから）: `caseG-T3-run1` の設定とログ。cfg14・cfg15 と試作の worktree は消さない。予定外の項目は消さず報告。`/logout` は使わない。

## 7. 前後の確認コマンド（値を出さない）

- `records/caseG-T3-check.sh`（属性、ps、lsof、プロキシのログの行。ログには値が入らない設計）。
- 実行する Mac コマンドは毎回、先頭に `export PATH="/usr/local/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH";` を付け、承認をもらってから流す。
