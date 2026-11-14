# 案G 原因まとめ v3 — 2026-11-03（JST）
- 調べ方：記録を読んだだけ。加えて、Keychainの属性（acct、cdat、mdat）を1回だけ見た（11/03 02:50 JST）。値は読んでいない。
- Codexの調査全文：~/grokbot-send/caseG-cause-codex-20261103.md（/tmp から移した）
- 二重レビュー第1回・第2回の指摘を反映した。第2回のあとの修正は、レビューを受けていない（往復は2回まで）。

## 症状2-1 新しく起動すると loggedIn false になる
- 結論
  - 試験2：起動時の USER の違いで、Keychainを探す先がずれた。確度は高（事実の再現あり）。
  - 試験1：同じ仕組みが当てはまるという仮説。確度は中。試験1では USER のほかに HOME とバイナリも違い得る。
- 事実（試験2、11/02）
  - 項目の acct は "unknown"。
  - USERなしの env -i なら true。通常のシェル、または USER=<user> を足すと false。
- 事実（試験1）
  - 11/03 02:50 の時点で、live 項目（60d31dfa）と alternate 項目（f18120e7）は、どちらも acct="unknown" が1件ずつ。acct="<user>" の項目は確認されない。
  - lab_start_trial は USER を渡さない。HOME には credential-switch-user-home.js の出力を渡す（実際のホームと同じかは記録に無い）。バイナリは cc-g-tools/claude-2.1.310。
  - 新規起動したときの実際のコマンドは記録に無い。
- 公開情報（issue・PRの報告で、公式文書ではない）
  - $USER を Keychain の account に使う（anthropics/claude-code #88434）。
  - USER が無いと "unknown" になる（ccstatusline #521、hermes-agent PR #75146）。

## 症状2-2 API Usage Billing と表示される
- 結論：未確定。候補は次の2つだが、網羅ではない。USER の違いだけで、この表示まで説明できたとは確かめていない。
  - ログインが見つからなかった（USER・HOME の違い）。
  - Rotator の ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN が付いた環境で起動した。
- 公式：ANTHROPIC_AUTH_TOKEN は /login のログインより優先される（https://code.claude.com/docs/en/authentication#authentication-precedence）。

## 症状1 10/30 12:31、切替後の画面が Not logged in
- 結論（推論・確度は中）：補助プログラムがログイン情報をコピーして同じ項目へ書き戻したことで、保持中のプロセスが、更新できる有効なログインを持ち続けられなかった。直接の証拠（invalid_grant など）は無い。
- 事実
  - live 項目の mdat は、観測した 11/03 02:50 の時点で 10/29 20:01:34 のまま。
  - acct="<user>" の項目は、観測時点で確認されない。一時的に作られて消えた可能性は、この観測では除外できない。
  - 試験2（正規ログイン・コピーなし）の項目は、放置中も mdat が進んだ（cdat 10/31 14:10:45 → 観測時 11/01 02:10:56 → 11/02 14:11:01）。
  - 補助プログラムはサービス名だけで項目を探す。acct を指定せず、データだけを上書きする。Claude Code の refresh との排他も無い（driver:134-149、Swift:81-89、109-142）。
- 未確定のこと：更新の主体、試みたか、成否、保存先。
- 推論（候補）
  - 候補1：コピーと Claude Code の更新が衝突し、古い世代のログインが残った（中）。
  - 候補2：更新を試みなかった（低〜中）。
  - 候補3：補助プログラムが項目を上書きしたため、項目のアクセス制御（ACL）が補助プログラム側になった、またはコピーしたバイナリの署名が違った。refresh には成功しても保存の段で拒否され、mdat が進まなかった（低〜中）。
  - 試験2の mdat の進みは、Claude Code が自分で保存したと考えるのが自然だが、主体は確定していない。周期も決められない。
- 公開情報（issueの報告で、公式文書ではない）
  - refresh token は更新のたびに新しくなり、古いものは使えない（#24317、#43392、#78020）。
  - 古い世代を再び使うと、系列ごと無効になり得る（#78020）。
  - メモリに残った古いtokenでも Not logged in になる（#37996、#37203）。

## 仮説 (c) 試験用にコピーしたバイナリ（2.1.310）と通常のバイナリの違い
- 未検証・評価保留（版をそろえた比較が無い）。候補3（署名）とつながる可能性はある。
- 事実
  - 起動したバイナリは違う。
  - 通常のバイナリのリンク先は、11/03 時点で 2.1.316。11/02 の試験2の画面では 2.1.314 と表示されていた。

## 再発を減らす候補（試験3で確かめる）
- アカウントごとに専用の CLAUDE_CONFIG_DIR を用意し、本人が /login する。ログイン情報はコピーしない。
- USER、HOME、CLAUDE_CONFIG_DIR、バイナリは、いつも同じ文字列にそろえる。
- 公式の複数アカウントの手順（https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts）に沿う。
