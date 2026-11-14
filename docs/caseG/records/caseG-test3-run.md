# 案G 試験3 記録（実行中） — 作成 2026-11-03 03:02 JST

## 承認（t68s541、11/03 02:57 JST）
- ① 推定にとどまる点も承知のうえで試験3を実行する（段0の「サーバー側への影響は不明」「~/.claude.json に触れないことは推定」を承認）。
- ② #14・#15 はどちらも坂根さん個人の正規契約（§2 の必須確認）。
- ③ 作業がきれいに再開できるなら、起動し直す方式も検討してよい（候補B は A の合格後に別試験。要確認③は残る）。
- #15 のメールはドメインまで未固定。/login のときに坂根さんが画面で確かめ、ここに記録する。
- 試験2を先に終えるかは未決定。試験3の開始後の試験2（#14 と同じ fde@）の結果は参考扱いとする。

## 準備（Grok Bot、11/03 02:58〜03:01 JST）
- 試験ルートを新規作成：$HOME/caseG-test3-run1（作成前は存在せず、シンボリックリンクでもない）。700。中身は cfg14・cfg15・work・tmp（各700、空）。
- バイナリ B：$HOME/.local/share/claude/versions/2.1.316（readlink ~/.local/bin/claude の実体。310114176 bytes、10/31 15:31、sha256 先頭 64c327e92b2c5e0f）。版は B を起動せず、パス名と /status の表示で記録する。
- サービス名の計算：sha256(文字列) の先頭8桁。試験2の /private/tmp/caseG-test2-20261031/config（出典：~/grokbot-send/test2-root.txt）から 92ec3e37 が出て、既知の名前と一致した。
  - cfg14 → Claude Code-credentials-<redacted>
  - cfg15 → Claude Code-credentials-<redacted>
  - 本番（番号なし）、試験1（60d31dfa、f18120e7）、試験2（92ec3e37）と重ならない。
- 実行前の Keychain 属性（-a なし、値は読まない。本番の項目は引いていない）
  - 7b5bcb04：項目なし
  - e694e038：項目なし
  - 92ec3e37（試験2）：acct=unknown、cdat 10/31 14:10:45、mdat 11/02 22:18:01 JST、login.keychain-db
  - 60d31dfa（試験1）：acct=unknown、cdat 10/29 18:43:14、mdat 10/29 20:01:34 JST
  - f18120e7（試験1）：acct=unknown、cdat = mdat 10/29 18:38:08 JST
- プロセス（ps だけ）：本番 Rotator PID <pid> 稼働、試験2のタブ PID <pid> 稼働。試験1の 78352・77977（cc-g-tools/claude-2.1.310）と lab serve 56026 も残っている（触らない）。
- 参考：~/.claude.json は 02:59:53 → 03:00:16 JST と、試験と関係なく書き換わっていた（mtime 比較が判定に使えないことの裏付け）。
- 本番 Rotator が #14・#15 を使っているかは、画面を見られないので未記録。Rotator の設定ファイルは秘密を含むおそれがあるので読んでいない。
- 確認スクリプト：~/grokbot-send/caseG-test3-check.sh（属性・ファイル名とサイズ・ps だけ）。初回の試行で、時刻を JST に直す部分の誤りを見つけて直した。
- 坂根さん用の手順：~/grokbot-send/caseG-test3-sakane-tonight.md

## 準備中に見つけた手順書 v3 との食い違い（直して v3.1 にした）
1. 「起動のたびに B --version を記録」は、Grok Bot が claude を起動しないという制約と矛盾する。→ 版は /status の表示（坂根さん）と、バイナリのパス・サイズ・ハッシュ（Grok Bot）で記録する。
2. 「#15 の期待メールを段0で固定」は、承認時点では未固定。→ /login のときに坂根さんが画面で確かめ、記録してから質問する。
3. 新しいフォルダで初めて起動すると、テーマ・ログイン方法・フォルダの信頼の確認が出る。この点が手順に無かった。→ 「Claude account with subscription」を選ぶ、と書き足した。
4. 段0の「本番が #14・#15 を使っているか」は画面の確認が必要。→ 坂根さんが見る点とし、今回は未記録とした。
5. 段0のキーチェーンアクセスでの名前の一覧は、坂根さんの操作。→ 坂根さん用の手順の 0 に入れた（任意）。

## 実行の記録
（ここから下に、坂根さんの各段の結果と確認スクリプトの出力を追記する）

## 段5 相当：最後の使用から約16時間後の確認（Grok Bot が Orca CLI で代行入力。坂根さんの明示依頼 t74u 11/03 19:25 JST、本人不在）
- 注：手順書 §2 要確認② により本来は坂根さんが入力する段。今回は本人の明示依頼で Grok Bot が入力した（要確認②は未解決のまま）。
- 15番タブの実体：Orca の term_914ec826-c187-49bf-9df3-b4066591439a（タブ名は「試験3-15」ではなく「Claude Code」、tab 5da22185、worktree caseG-proto-20261027）。画面の起動行に cfg15、PID <pid>（PPID 93540 zsh ← Orca Terminal Host）。
- 事前（19:25:41 JST）：7b5bcb04 mdat 03:06:43（未更新）／e694e038 mdat 15:12:41（開いたまま、入力なしで 03:12:31 の約12時間後に更新済み）／92ec3e37 08:11:03／60d31dfa・f18120e7 不変。本番 73215・試験2 33261 稼働。
- 参考：~/.local/bin/claude は 11/03 10:23 の本番自動更新で 2.1.317 を指すようになった。B=2.1.316 は残存（310114176 bytes）。試験は絶対パスの 2.1.316 で実行。
- ① 15番（条件X）：19:26:46 に「1+1は？」→「2です。」（done 19:26）。19:27:19 /status：Version 2.1.316、Login method: Claude Ultra account、Email account-b@example.com、Org account-b@example.com's Organization。API Usage Billing 表示なし。ログイン要求・Keychain 確認待ちなし。Esc で閉じ、タブは開いたまま。
- 確認（19:27:39）：e694e038 mdat 15:12:41 のまま（質問で更新なし）、acct=<user>。他の鍵・PID 不変。
- ② 14番（条件Y、閉じたまま約16h20m）：19:27:48 新タブ「試験3-14再起動」（term_73184674-3b1e-43b6-9d7b-1c272250446e、シェル PID <pid>、claude PID <pid>）で cfg14 起動。ログイン要求なし、Keychain 確認待ちなし。起動画面に「You've used 99% of your weekly limit · resets 9pm (Asia/Tokyo)」。19:28:16「1+1は？」→「1+1は2です。」（done 19:28）。19:28:49 /status：Version 2.1.316、Login method: Claude Ultra account、Email account-a@example.com、Org account-a@example.com's Organization。API Usage Billing 表示なし。
- 確認（19:28:57）：7b5bcb04 mdat 03:06:43 → 19:27:50（起動直後に更新）、acct=<user>、cdat 不変。e694e038 不変。
- 19:29:06 /exit（PID <pid> 終了確認、タブは残す）。19:29:21 同じ env で cfg14 に auth status：loggedIn true、authMethod claude.ai、apiProvider firstParty、email account-a@example.com、subscriptionType max（トークン類の出力なし）。
- 最終確認（19:29:29）：7b5bcb04 19:27:50／e694e038 15:12:41／92ec3e37 08:11:03／試験1の2件 不変。本番 73215・試験2 33261・15番 13945 稼働。新しい名前の項目は check.sh の範囲では無し（Keychain 全体の名前一覧は未確認）。
- /feedback・/login・後片付けは未実施。
