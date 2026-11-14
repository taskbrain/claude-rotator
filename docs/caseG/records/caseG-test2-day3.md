# 案G 試験2 3日目確認 (2026-11-02 22:17-22:19 JST)
## 1. auth status の食い違い → 原因はUSER環境変数(鍵のacct)と判明
- タブ(PID <pid>)の起動形: /usr/bin/env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color CLAUDE_CONFIG_DIR=$R/config $HOME/.local/bin/claude (cwd $R/work)。USERなし
- 22:17:26 同じ形(env -i)で auth status: loggedIn true / claude.ai / account-a@example.com / subscriptionType max
- 22:17:26 通常シェル(同CONFIG): loggedIn false / none
- 22:17:51 env -i + USER=<user>: loggedIn false / none
- 鍵の acct 属性は "unknown"。USERなしで保存されたため、USERがある環境からは見つからないとみられる(高)
## 2. タブで /status (22:17:51送信、Escで閉じた)
- Login method: Claude Ultra account / Email account-a@example.com / Org account-a@example.com's Organization / v2.1.314
- API Usage Billing 表示なし。診断: ~/.local/bin がPATHにない警告のみ
## 3. /feedback: 送っていない。10/29承認文面の記録は見つからず
## 4. 鍵 "Claude Code-credentials-<redacted>" 属性
- cdat 10/31 14:10:45 JST / mdat 22:17時点 11/02 14:11:01 JST → 22:18確認時 11/02 22:18:01 JST
- /status 実行直後に更新(更新の契機が/statusかは未確定)。前回 11/01 02:10:56。約12時間ごとの自動更新+今回

## 坂根さん回答 (t65s462, 22:19 JST)
- 22:17〜22:18 の Keychain 確認画面: 出なかった
## /feedback 直接送信 (t65s462承認、1回のみ)
- 22:20:05 /feedback → Write new feedback → 承認文面をそのまま入力 → 履歴「This session only」(最小)を選択
- 送信内容表示: 文面 / Environment info (darwin, xterm-256color, v2.1.314) / Session transcript: this session only / Recent error messages (最大100件)
- 22:21:01 送信 → 「Thank you for your report!」「Feedback ID: 0a7a7cea-1410-4b2f-9ae8-ba7a30a8d466」= 送信成功(zip保存のみではない)
- GitHub issue は開かず Esc で閉じた。再送なし
- 比較: Rotator経由(API Usage Billing)では zip保存のみ。通常ログインの試験2では送信できた

> 注記（11/03 訂正）：上の「約12時間ごとの自動更新」は根拠が足りない。観測した mdat の間隔は一定ではなく（11/01 02:10 → 11/02 14:11 は約36時間）、周期は未確定。
