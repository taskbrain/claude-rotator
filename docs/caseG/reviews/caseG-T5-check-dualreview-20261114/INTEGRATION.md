# デュアルレビュー統合 t117-T5check-r1-20261114（第1周）

- 対象: claude-rotator worktree `expiry-helper-20261112`、枝 `test/caseG-expiry-helper-20261112`、commit `32f38589beb2ec8444d911d61987dd85efdf6ab8`（lsof 修正を含む commit。これより後の commit は無く、作業ツリーは clean。`caseG-T5-check.sh` 本体の最終変更は `24b18e8`、lsof 修正は `caseG-check-lib.sh`）。
- 参照: `test-T5-plan.md`（docs-caseG 作業ツリー、未 commit の更新を含む）、`records/caseG-T5-run-20261114.md`、`test-T4-plan.md`、試作 `fcb2883` の `proxy-core.js`。
- 承認: 坂根さん 2026-11-14 13:25 JST「確認用スクリプトは今二重レビューして結果を見せてください」。
- 実施: 2026-11-14 13:30 JST 開始。Mac `/tmp/dual-review/t117-T5check-r1-20261114/`。packet.md md5 `d6d0b26bcc3b5654d492a2671576cde6`（箱と一致、両者同一）。
  - Codex: `codex exec -s read-only --ephemeral --ignore-user-config -c model_reasoning_effort="xhigh" --output-schema … -o … -`（codex-cli 0.167.0、gpt-6.1-sol、sandbox read-only、reasoning xhigh）。416秒、exit 0、79,825 tokens。スキーマ適合。実行したのはファイル読みと `bash -n` だけ（ログで確認）。
  - Claude Code: `command claude -p --permission-mode dontAsk --tools "Read,Grep,Glob" --no-session-persistence --output-format text`（2.1.325）。221秒、exit 0、stderr 空。**JSON は1か所の未エスケープの引用符で厳密には不正**（evidence 内の awk 文字列）。内容は読めたので採用したが、形式は「軽微な不正」として記録する。
- 改変なし: 3 worktree（expiry-helper・docs-caseG・caseG-T3-proto）の HEAD・status・stash・for-each-ref・未 commit ファイルの md5 が前後一致。src コピーの md5 前後一致、`git archive` 再展開と `diff -r` 一致。

## verdict
| | verdict | P0 | P1 | P2 |
|---|---|---|---|---|
| Codex | block | 0 | 2 | 2 |
| Claude | block | 0 | 2 | 3 |

## P1（裏取り済み）
| # | 出所 | 指摘 | 裏取り | 判定 |
|---|---|---|---|---|
| A | **両方**（Claude F1／Codex F2） | (b-1) の確かめ方（`lsof +D`・`pgrep -f <フォルダ>`・cwd がフォルダの下）は、`CLAUDE_CONFIG_DIR` を環境変数で渡して動く Claude Code を見つけられない。試験タブの cwd は `…/caseG-T5-run1/work` で k の下ではない。j を使う別セッションがあっても「0件・終了コード 0」になりうる | 手順書 77 行に、生存中の cfg15 セッション PID <pid> が同じ確かめ方で見えなかった実機記録あり（原文で確認）。lib 139・149・159-170 行もそのとおり | **確認済み・P1 採用** |
| B | Claude のみ（F2） | `pgrep -x claude` はフルパス `…/claude/versions/2.1.325` で起動した試験タブを拾わない（プロセス名が版番号になる）。0件は成功扱いなので cwd の確認が黙って空になる | 実機で読むだけ確認: PID <pid>（`…/versions/2.1.316` で起動）は `pgrep -x claude` に**出ず**、`pgrep -x 2.1.316` に出た。33261（`~/.local/bin/claude`）は出た | **確認済み・P1 採用** |
| C | Codex のみ（F1） | `ps -o comm= -p` の失敗を「終了済み」として `continue`、`lsof -a -p -d cwd` の終了コード1・stderr 空を成功扱いで n 欄空のまま通す | コード上は事実（lib 152・34-40・162-168）。ただし同じユーザーの生存プロセスで起きるのは、照会の間にプロセスが終わった場合にほぼ限られる | **確認済みだが P2 に下げる**（要件「失敗を0件と読まない」の穴ではあるが、偽合格に直結しにくい） |

## P2 の要約
1. [両方] (b-3) は `launchctl list` のラベル名に claude を含むかだけ。名前に claude を含まないジョブがフォルダで起動しても見えない（手順書の「命令の形」まで見ていない）。
2. [Claude] 終了コード 0 は「取得がすべて成功」の意味で、j の保持者0件・37991 空き等の判定は終了コードに出ない。手順書 0-9 の期待は「終了コード 0」だけなので、出力の中身を読む手順を書き足す必要。
3. [Codex] プロキシ記録の検査は必要な文字列の有無だけで、途中で切れた JSON 行も通る（試作は書き込み不足で停止する経路あり）。
4. [Claude] モックの lsof は該当なしでも見出し行＋終了コード 0。本物の「終了コード1・出力なし」や `pgrep -x claude` 0件の道を通るテストが無い。
5. （上の C を P2 として扱う）

## 秘密値・本番への影響
- 両者とも、秘密値（トークン・認証 JSON・crontab 行・環境変数）を出す経路、Keychain 書き込み・確認画面を出す操作、本番・PID <pid>/<pid> への書き込み・シグナル・接続の指摘は無し。Grok Bot の読みでも、`security find-generic-password` は `-g`/`-w` なし、crontab は件数のみ、`ps -E` なし。

## 未確認（open questions）
- macOS の `lsof +D` が他ユーザーのプロセスや見られない経路を黙って飛ばすか。
- Claude Code 2.1.325 が `CLAUDE_CONFIG_DIR` 配下のファイルを開いたままにするか。
- k の `auth login` 後の Keychain 項目の acct が `<user>` になるか（ならなければ件数0で終了コード3、第4引数で指定が要る）。
- 段7で記録を数えるのはプロキシ停止後であること（動いている間は処理中の要求が未記録）。requests.jsonl を再試行で使い回さないこと（全件を数えるため）。
- 時刻窓: スクリプトは区間を扱わない（その時点のスナップショットとプロキシ記録の全件）。a2 の `server.log`・`usage-events` の区間0件は手順書 7-1 の別コマンドで、スクリプトの範囲外。

## T5 に今のまま使えるか
- **(b-1) の証拠としては使えない**（A・B）。Keychain 属性・ポート・本番 PID・config sha256・プロキシ記録の件数の部分は使える。
- 直すべきこと（方向のみ。実装・承認は坂根さん）:
  1. Claude Code のプロセスの見つけ方を広げる（`claude` に加え、`~/.local/share/claude/versions/<版>` で起動したもの）。見つけた全件を PID・開始時刻・cwd で一覧にし、既知（13945・33261・試験タブ・試作プロキシ）以外が無いかを前後で比べられるようにする。
  2. 環境変数を読まずに補う証拠を足すか、手順書 §5 (b-1) に「この確かめ方は環境変数で口座を指定したセッションを見つけられない」限界と代わりの証拠（例: k・j フォルダ配下の最終更新時刻、j の Keychain 項目 mdat の区間中の変化）を明記する。
  3. 手順書 0-9・7-2 の期待を「終了コード 0」だけでなく出力の中身（j 0件、37991 の状態など）で書く。
- 直したら第2周（解消確認と回帰のみ）を回す。
