# Codex への設計相談の依頼文（2026-11-03 20:04 JST）

あなたは claude-rotator の設計レビュー担当です。読み取り専用で作業し、ファイルは書かないでください。答えはこの画面に日本語で出してください。

## 読むもの（このworktree内）
- docs/caseG/verification-summary.md（これまでの全試験のまとめ。最初に読む）
- docs/caseG/records/ の記録（特に caseG-credential-switch-設計-20261027.md、caseG-notloggedin-report.md、caseG-cause-20261103.md、caseG-test2-day3.md、caseG-test3-run.md）
- src/proxy-server.js、src/session-affinity.js、src/account-manager.js、src/secret-store.js、src/native-claude-refresher.js、src/claude-keychain.js、src/claude-credentials.js、README.md の「しくみ」「OAuth認証情報の自動更新」「セッション単位のアカウント固定」
- 禁止: ~/.claude.json、~/.claude 配下の設定値、Keychain、~/Library 配下の claude-rotator の設定値は読まない。トークン・鍵・パスワードの値を出さない。security コマンドを使わない。

## 決まっている方針（坂根さんの指示）
1. --resume での引き継ぎはしない。起動中のセッションを再起動せず、いまのRotatorのように裏で口座を切り替える。プロンプトキャッシュの作り直しだけは許容。
2. 画面は本来のサブスクリプション表示（API Usage Billing を出さない）。/feedback が送れること。
3. 規約: 同じPCの中で自分の口座のログインし直しを簡易にしているだけなので問題ない、というのが坂根さんの解釈（https://www.anthropic.com/legal/consumer-terms）。これを前提にし、規約の是非は論じない。
4. 規模: 口座16個、同時セッション約100。本番Rotator（127.0.0.1:37891 のプロキシ方式）を止めずに移行する。

## 分かっている事実（要約。詳細は verification-summary.md）
- 同じ CLAUDE_CONFIG_DIR に別プロセスで正規 /login → 起動中セッションの /status /usage が数秒で追従（10/27）。
- 同じフォルダの Keychain 項目（Claude Code-credentials-<sha256(dir)先頭8桁>）と oauthAccount をヘルパーで直接書き換え → 再起動なしで追従、普通の操作OK、戻しも0秒（10/29）。ただし約16.5時間後に Not logged in。その間 Keychain 項目の更新時刻は進まず。コピーした2.1.310実行ファイルでは後日 Keychain 確認画面が毎回出た。
- 正規ログインのフォルダは Claude Code 自身が更新して数日もつ（試験2・3）。USER が無い起動だと acct=unknown になりログアウト扱い。
- 1フォルダ=1認証情報なので、同じフォルダのセッションは全部一緒に切り替わる。フォルダは起動時に決まる。
- いまの API Usage Billing 表示は settings.json の ANTHROPIC_AUTH_TOKEN（ダミー）が /login より優先されるため。

## お願い
次の要件で、設計案を複数比べてください。
要件: (R1)再起動なし (R2)裏で自動切り替え (R3)本来のサブスク表示 (R4)/feedback が使える (R5)16口座 (R6)約100セッション同時 (R7)本番を止めない移行 (R8)リフレッシュトークンの世代衝突で口座を壊さない (R9)Claude Code の自動更新に強い。

少なくとも次の案を含め、ほかに良い案があれば足してください。
- 案A: 共有 CLAUDE_CONFIG_DIR（「レーン」。1つまたは数個）を作り、Rotator がそのレーンの Keychain 項目と oauthAccount を書き換えて口座を切り替える。口座の認証情報は「写す」のではなく「移す」（1つの世代の持ち主は常に1か所、更新は Claude Code だけ、切り替え前に最新を取り込み直す）。
- 案B: 口座ごとのフォルダで正規ログインを保ち、そこから最新の認証情報をレーンへ渡す（持ち主が2か所になる問題をどう扱うか）。
- 案C: プロキシは残し、ANTHROPIC_AUTH_TOKEN を外して ANTHROPIC_BASE_URL だけにする。Claude Code は正規ログインのまま（表示はサブスク）、プロキシが送り先の口座の Authorization を差し替える。/status の表示口座と実際の口座がずれる点、/feedback の通り道、いまのセッション単位の振り分け（sessionAffinity）を活かせる点を評価。
- 案D: 組み合わせ（例: 移行期は C、その後 A）。

各案について:
1. 要件 R1〜R9 ごとの ○/△/× と理由
2. 主な危険と壊れ方（世代衝突、Keychain の ACL と確認画面、USER/acct、.claude.json の oauthAccount の書き込み競合、Claude Code 更新での仕様変化、100セッション一斉追従、動作中のサブエージェント）
3. 100セッション/16口座の割り当て方（レーン数、1レーンに何セッション、使用量97〜98%での切り替え、レーン間で口座が重ならない仕組み）
4. 必要なコード変更の場所（既存 src のどこを流用・削除するか）
5. 未検証項目を埋める試験手順（短い・長い試験、合否の基準）
6. 実装の段階（PRの単位と順番、各段の止め方・戻し方）
最後に、おすすめの案と理由、坂根さんに決めてもらう必要がある点を挙げてください。

出力は見出し付きで、全体で250行以内にまとめ、最後の行に「=== CODEX DESIGN END ===」と書いてください。
