# 試験3 今夜の手順（坂根さんが入力する分）
- Grok Bot はタブに入力しません。claude も起動しません。
- 本番のタブと試験2のタブ（PID <pid>）には触らないでください。
- 「〇〇済み」と伝えてもらったら、Grok Bot が確認スクリプトを実行します。

## 0. 始める前（任意・1分）
- キーチェーンアクセスを開き、右上の検索で「Claude Code-credentials」と入れる。
- 出た項目の「名前」の一覧だけをスクリーンショットする。項目は開かない（値は見ない）。

## 1. #14 の起動とログイン
1. Orca で新しいタブを開く（名前：試験3-14）。
2. 次の1行を貼って Enter（USER を渡し、Rotator の ANTHROPIC_* は env -i で外れます）。
```
cd $HOME/caseG-test3-run1/work && env -i HOME=$HOME USER=<user> LOGNAME=<user> LANG=ja_JP.UTF-8 TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=$HOME/caseG-test3-run1/tmp/ DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=$HOME/caseG-test3-run1/cfg14 $HOME/.local/share/claude/versions/2.1.316
```
3. 初めての画面が出る。
   - テーマ：どれでもよい。
   - ログイン方法：「Claude account with subscription」（Pro / Max のほう）を選ぶ。「Anthropic Console account」は選ばない。
   - ログインの画面が出ないときは `/login` と入れる。
4. ブラウザ
   - 既定のブラウザが開いたら、そこでは承認せずに閉じる。
   - 画面に出た URL をコピーし、プライベートウィンドウに貼る。
   - **account-a@example.com** でログインして承認する。コードが出たら、タブに貼る。
5. Keychain の確認画面が出たら「**許可**」を押す。「常に許可」は押さない。出た時刻を覚えておく。
6. 「このフォルダを信頼するか」と聞かれたら、信頼する（中身が空の試験用フォルダです）。
7. `/status` と入れて、次を確かめる。
   - Version：2.1.316
   - Login method：サブスクリプションのアカウント（Claude Max / Pro など）
   - Email：**account-a@example.com** と完全に一致する
   - 「API Usage Billing」や API key の表示が**無い**
   - 1つでも違ったら、質問せずに `/exit` して、Grok Bot に伝える。
8. 短い質問を1回する（例：「1+1は？」とだけ）。普通に答えればよい。
9. Grok Bot に「**14済み**」と伝える（Keychain の画面が出たか、その時刻も）。

## 2. #14 を終える
10. 試験3-14 のタブで `/exit` と入れる。シェルのプロンプトに戻ったら、Grok Bot に「**14終了**」と伝える。
11. Grok Bot が「どうぞ」と返したら、同じタブで次の1行を貼る（14 の状態を1回だけ見る）。
```
cd $HOME/caseG-test3-run1/work && env -i HOME=$HOME USER=<user> LOGNAME=<user> LANG=ja_JP.UTF-8 TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=$HOME/caseG-test3-run1/tmp/ DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=$HOME/caseG-test3-run1/cfg14 $HOME/.local/share/claude/versions/2.1.316 auth status
```
   - 見る点：loggedIn が true、メールが account-a@example.com、方式がサブスクリプション（claude.ai）。
12. 結果を Grok Bot に伝える（画面のスクリーンショットでもよい）。

## 3. #15 の起動とログイン
13. Orca で新しいタブを開く（名前：試験3-15）。
14. 次の1行を貼って Enter（cfg15 になっている点だけが違います）。
```
cd $HOME/caseG-test3-run1/work && env -i HOME=$HOME USER=<user> LOGNAME=<user> LANG=ja_JP.UTF-8 TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=$HOME/caseG-test3-run1/tmp/ DISABLE_AUTOUPDATER=1 CLAUDE_CONFIG_DIR=$HOME/caseG-test3-run1/cfg15 $HOME/.local/share/claude/versions/2.1.316
```
15. 手順 3〜8 と同じ。違うのはアカウントだけ。
   - ブラウザでは **develop@** のアカウントでログインする。
   - `/status` の Email が、選んだ develop@ のアカウントと完全に一致するか確かめる。完全なメール（@ のあとまで）を Grok Bot に伝える。
16. Grok Bot に「**15済み**」と伝える。

## 4. 朝まで
- 試験3-15 のタブは**開いたまま**にする（/exit しない）。
- #14 は起動しない。
- どちらのフォルダにも auth status を打たない。
- Mac を再起動しない。
- 翌朝（最後に使ってから14時間以上あと）の手順は、別に用意します。
