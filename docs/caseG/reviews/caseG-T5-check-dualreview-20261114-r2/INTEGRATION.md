# デュアルレビュー統合 t118-T5check-r2-20261114（第2周・再確認）

- 承認: 坂根さん 2026-11-14 14:08 JST「確認用スクリプトの3点を直して、第2周のレビューを回してください」。
- 対象: `expiry-helper-20261112`（枝 `test/caseG-expiry-helper-20261112`、HEAD `32f3858`）の作業ツリー（未 commit）と、docs-caseG の `test-T5-plan.md` 作業ツリー（未 commit）。commit・push なし。
- 実施: 14:17 JST 開始、Mac `/tmp/dual-review/t118-T5check-r2-20261114/`。packet md5 `10e0b7cdda3058a5cf3e3325fe65489a`（両者同一）。Codex 159秒 exit 0（read-only、xhigh、スキーマ適合）。Claude 125秒 exit 0（JSON 適合）。
- 改変なし: 3 worktree の状態と src コピーの md5 が前後一致。コピーは作業ツリーと diff -r 一致。

## 直したもの（承認の3点＋テスト）
| ファイル | 内容 |
|---|---|
| `experiments/caseG-expiry/caseG-check-lib.sh` | `caseg_claude_pids`（`ps -axo pid=,comm=` で名前が claude、または `…/claude/versions/<版>` 起動を拾う）、`caseg_lstart_jst`、`caseg_claude_inventory`（全件の PID・開始時刻・作業フォルダ・起動パス・件数）、`caseg_folder_newest`（最終更新の時刻と相対パスと項目数。中身は読まない。find の失敗・stderr は未確認）。作業フォルダ欄を `pgrep -x claude` から `caseg_claude_pids` に置き換え |
| `experiments/caseG-expiry/caseG-T5-check.sh` | 上の一覧と k・j フォルダの最終更新を出力に追加 |
| `experiments/caseG-expiry/test/check-scripts.test.js` | テスト4件追加（versions 起動の一覧と作業フォルダ欄、ps 一覧の失敗＝未確認、本物の lsof 該当なし・pgrep 0件＝0件で exit 0、最終更新が中身を出さない）。pgrep 失敗テストの期待を更新 |
| `experiments/caseG-expiry/README.md` | 追加した出力と限界を1段落 |
| `docs/caseG/test-T5-plan.md` | §5 (b-1) の確かめ方を更新、限界と代わりの証拠 (1)全プロセス一覧の前後比較 (2)j フォルダの最終更新 (3)j の Keychain mdat を追記。0-9・7-2 の合格の目安を出力の中身で記述。§2 の6・§11 を更新 |

## テスト
- caseG-expiry 46件合格（check-scripts 19件）。`npm test` 3091件中 3087合格・4 skip・0失敗。`npm run lint` exit 0。

## 読み取り実行（14:13:58–14:14:53 JST、k=cfgK-aragosta、j=cfg14、記録なし。出力は Mac /tmp/dual-review/t118-T5check-r2-20261114/real-run.txt）
- 事前にスクリプトの書き込み・シグナル・値の読み取りが無いことを grep で確認（rm は自分の一時ファイルだけ、security は -g/-w なし）。
- 終了コード 3。未確認は「k の Keychain 項目 件数=0」だけ（k は未ログイン）。j は件数=1、acct=<user>、mdat 11/13 16:10:02 JST。
- k・j のフォルダを開くプロセス 0件。全プロセス 110件、13945（起動 …/versions/2.1.316、cwd caseG-test3-run1/work、開始 11/03 03:11:32）と 33261（起動 ~/.local/bin/claude、cwd /private/tmp/caseG-test2-20261031/work、開始 10/31 13:41:00）が出た。
- j フォルダの最終更新 11/13 16:10:43 JST（項目 1147）、k は 11/14 13:20:19（フォルダ自身のみ）。73215・37891・config sha256 `0096a28b…` は従来どおり。

## 第2周の結果
| | verdict | P0 | P1 | P2 |
|---|---|---|---|---|
| Codex | block | 0 | 1 | 0 |
| Claude | approve | 0 | 0 | 3 |
- B（versions 起動が `pgrep -x claude` に出ない）: **両者とも解消を確認**。
- A: **割れた**。
  - Codex P1（risk）: 代わりの証拠は「新しい PID が増えない」「j フォルダ・j の Keychain 項目が変わらない」だけ。区間の前から生きているセッションが、cfg14 以外のフォルダで fde@ にログインしていれば、PID も増えず cfg14 も項目 7b5bcb04 も変わらずに j を消費でき、合格を誤って出せる。手順書 121行は「その口座でログインしている他のフォルダ」も対象にしており、33261 の口座は未確認（実施記録 39行）。
  - 裏取り: 手順書 121行・実施記録 39行の記述は原文で確認。論理は正しい（実際に起きているかは未確認）。**確認済み（手順上の穴）・P1 のまま**。環境変数を読まない制約から来る限界で、スクリプトの直しでは埋まらない。
  - Claude: A は解消（approve）。残りは P2。
- 上限（2周）に達したので、これ以上は回さない。

## 残った P2（直していない）
- 第2周 Claude F1: 一覧で `ps -o lstart=` が失敗すると生死を確かめずに「照会の間に終了」として飛ばす（作業フォルダ側は確かめ直す）。
- 第2周 Claude F2: comm の末尾が claude か `/claude/versions/<版>` のものだけを拾う。相対パス起動や `node …/cli.js` 起動は出ない。
- 第2周 Claude F3: 「既知の PID 以外が増えていない」で、増えた PID の扱いが決まっていない。110件あり、短命の `claude -p` などで区間中に新しい PID が出るのは普通なので、T5 がほぼ毎回未確認になるおそれ（誤合格の方向ではない）。
- 第1周から: ps -p 失敗の扱い、launchctl は名前だけ、プロキシ記録の JSON 構文、終了コード 0 の意味（手順書側は 0-9・7-2 で対応）、モックの不足（一部追加済み）。

## T5 に使えるか
- スクリプトとしては、第1周の P1 B は解消、A のうちスクリプトで直せる部分（全プロセス一覧・最終更新）は入った。
- 判定に残る穴は手順側の1点: 「cfg14 以外のフォルダで fde@ にログインした既存セッション」を除けない。埋め方の案（坂根さんの判断）:
  1. 各口座フォルダの `.claude.json` の口座メール（秘密値ではない。トークンは読まない）を読み、fde@ でログインしているフォルダが cfg14 だけであることを区間の前後で確かめる手順を足す（未承認。読む対象の承認が要る）。
  2. この残りの可能性を明記したうえで、坂根さんの申告（(b-4) と同じ扱い）で受け入れる。
  3. 増えた PID の扱い（P2 F3）を先に決める。決めないと区間中の新しい `claude -p` でほぼ毎回未確認になる。
