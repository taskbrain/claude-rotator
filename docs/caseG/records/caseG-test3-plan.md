# 案G 試験3 手順書 v3.1（準備済み・坂根さんの入力待ち） — 2026-11-03（JST）

- 二重レビュー第1回・第2回（Claude・Codex）の指摘を反映した。第2回のあとの修正は、レビューを受けていない（往復は2回まで）。
- 実行には坂根さんの承認が必要。

## 0. 結論
- 試す方式は候補A。アカウントごとに専用の設定フォルダを用意し、本人が /login する。ログイン情報はコピーしない。
  - これは公式の方法（https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts）。
  - 「切替」は、終了して別のフォルダで起動し直すことを指す。
  - 動いているセッションへ、ログイン情報を書き込むことはしない。
  - 各フォルダのログインの更新は、そのフォルダを使う Claude Code 1つだけが行う。
- 合格・不合格の決め方は §5 にまとめた。

## 1. 切替方法の比較
| 候補 | 方法 | 自動更新との衝突 | 規約 | 判断 |
|---|---|---|---|---|
| A | アカウントごとに専用フォルダ。本人が/login。終了して起動し直す | コピーによる世代の衝突は起こらない構造。同じフォルダを2つのプロセスで使う衝突だけが残る（手順で避ける） | 公式手順に沿う。運用全体は要確認（§2） | 試験3で試す |
| B | Aに加えて、会話の記録を移して --resume する | ログイン情報は移さない | 要確認（記録を移すことの扱い） | Aが合格したら、別の試験にする |
| C | 動いている画面で /login し直す | 前のログインは上書きされる | 公式手順 | 毎回ブラウザでのログインが要る。参考にとどめる |
| D | 補助プログラムでログイン情報をコピーして書き戻す（今の案G） | 起こり得る（症状1の最有力候補） | 要確認（collect / store / intermediate） | 使わない |

## 2. 規約（2026-11-03 に原文を確認。実行する日にもう一度開いて照らす）
- 出典1：Claude Code の法務ページ（https://code.claude.com/docs/en/legal-and-compliance）「Usage policy」の節
  - 「Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK.」
  - 「OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications.」
  - 「developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.」
  - 「Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription」
- 出典2：Consumer Terms（https://www.anthropic.com/legal/consumer-terms）
  - 「You may not share your Account login information, Anthropic API key, or Account credentials with anyone else. You also may not make your Account available to anyone else.」
  - 禁止事項の一覧にある1項目：「Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise.」
- 実行前に確認が必要なこと（必須）
  - #14 fde@ と #15 develop@ が、それぞれ坂根さん本人の正規の契約か。会社のアカウントなら、Commercial Terms が適用されるかも確認する。
- 要確認（ここで許可されたとは扱わない）
  - ① Rotator がアカウントを使い分ける運用全体が「ordinary, individual usage」に当たるか。
  - ② Grok Bot が試験のタブに入力すること、または Claude Code の CLI（起動、`auth status` など、サーバーとやり取りし得るもの）を実行することが「automated or non-human means」に当たるか。決まるまで、これらはすべて坂根さんが行う。Grok Bot は画面を読むことと、Keychain の属性（手元だけで完結）を読むことだけをする。
  - ③ 候補Bで、会話の記録を移すことの扱い。
  - ④ 候補Dが、ログイン情報を collect / store / intermediate することに当たるか。
- 試験3では、なりすまし、使用量上限の回避、認証の迂回は行わない。

## 3. 固定する条件（実行する日に一度だけ決め、手順書へ文字どおり書き込む）
- 試験ルート
  - `$HOME/caseG-test3-run1`（/tmp は使わない。macOS の掃除で消えることがあるため）
  - 作り方：`mkdir -m 700` で新しく作る。すでにあるか、シンボリックリンクなら中止する。
  - 中身：`cfg14`、`cfg15`、`work`、`tmp` をそれぞれ 700 で作る。
- バイナリ
  - 実行する日に `readlink ~/.local/bin/claude` で実体（例：`$HOME/.local/share/claude/versions/2.1.316`）を確かめる。
  - その絶対パスを B として書き込む。リンクは使わない。コピーもしない。
  - 版は、Grok Bot が B を起動せずに記録する（パス・サイズ・ハッシュ）。あわせて、坂根さんが /status の Version を確かめる（v3.1：Grok Bot は claude を起動しないため）。
  - v3.1：新しいフォルダで初めて起動すると、テーマ・ログイン方法・フォルダの信頼の確認が出る。ログイン方法は「Claude account with subscription」を選ぶ。
- 本番の自動更新で、夜のうちに B が片付けられることがある（推測）。段5の①で、B がまだあることと `readlink ~/.local/bin/claude` を記録する。B が無ければ判定保留。
- 起動コマンド（14 の場合。15 は cfg14 を cfg15 に替える）
  ```
  cd $HOME/caseG-test3-run1/work && env -i HOME=$HOME USER=<user> LOGNAME=<user> \
    LANG=ja_JP.UTF-8 TERM=xterm-256color PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    TMPDIR=$HOME/caseG-test3-run1/tmp/ DISABLE_AUTOUPDATER=1 \
    CLAUDE_CONFIG_DIR=$HOME/caseG-test3-run1/cfg14 B
  ```
  - DISABLE_AUTOUPDATER=1 は必ず付ける。本番と共有のリンクや版を、試験が書き換えないようにするため。
  - ANTHROPIC_* は付けない。
- 確認用のコマンド
  - 起動コマンドの末尾の `B` を `B auth status` に替えたもの。
  - 起動と同じ cd・env を使う。

## 4. 手順
### 段0 承認と前提（実行の前）
- 坂根さん
  - §2 の必須確認に答える。
  - 試験2を先に終えるか、試験3の開始後の試験2の結果を参考扱いにするかを決める（#14 は試験2と同じ fde@ のため）。
  - 期待するメールを完全な文字列で固定する（#14：account-a@example.com。#15：v3.1 で変更。/login のときに坂根さんが画面で確かめ、記録してから質問する）。
  - 「同じアカウントにログインを1つ増やすと、本番や試験2のログインがサーバー側で影響を受けるかは分からない。それを承知で進める」を承認する。
  - 「本番の `~/.claude.json` に触れないことは、公式の記述と試験1の記録からの推定で、実行前に証明はできない」を承認する。承認しないなら、実行を保留する。
- Grok Bot
  - 本番 Rotator が #14・#15 を使っているかを記録する（画面の表示だけ）。
  - 坂根さんに、キーチェーンアクセスで「Claude Code-credentials」を検索してもらい、項目名の一覧だけを記録する（値は開かない）。

### 段1 事前確認（Grok Bot が読むだけ）
- (1) サービス名の計算を、既知の項目で確かめる。
  - 試験2のパス `/private/tmp/caseG-test2-20261031/config` から `92ec3e37` が出ることを確かめる。
  - そのあと、cfg14 と cfg15 の完全なパス文字列（末尾の / なし）から名前を予測する。
- (2) 予測した名前が、本番の `Claude Code-credentials`、試験1、試験2の名前と重ならないことを確かめる。
  - その名前の項目がまだ無いことを、`security find-generic-password -s 名前`（`-a` を付けない。acct が違う項目も見つけるため）で確かめる。属性だけを見る。
  - 試験2のパスの出典は試験2の手順書と記録（caseG-test2-day2.md など）。実行の日に確かめて書き添える。計算で `92ec3e37` が出なければ中止する。
- 成功：重ならず、項目も無い。それ以外なら中止する。

### 段2 #14 のログイン（夜）
- 坂根さん
  - Orca のタブ「試験3-14」で、起動コマンドを実行する。
  - /login で既定のブラウザが開いたら、そこでは承認せずに閉じる。画面に出た URL をコピーして、プライベートウィンドウに貼り、account-a@example.com としてログインする。
  - Keychain の確認画面が出たら「許可」を押す（「常に許可」は押さない）。
  - /status を開く。メールの完全一致と、API Usage Billing が無いことを確かめてから、短い質問を1回する。一致しない、または API Usage Billing が出たら、質問せずに止める。
- Grok Bot
  - 画面を読み、属性（acct、cdat、mdat、格納しているKeychain）と版を記録する。
  - Keychain の確認画面が出たかと、その時刻を記録する（症状1の候補3を見分けるため）。
  - 本番 Rotator と試験2のタブの表示を見て、異変が無いことを記録する（見るだけ）。確かめられなければ次の段へ進まない。
- 成功の条件
  - /status：Login method がサブスクリプションのアカウント、Email が account-a@example.com と完全に一致、API Usage Billing の表示が無い。
  - 予測した名前の項目ができていて、acct=<user>。
  - 短い質問に答える。

### 段3 切替 14→15（夜）
- 坂根さん
  - 14 のタブで /exit する。
  - Grok Bot が終了を確かめたら、坂根さんが 14 のフォルダにだけ `auth status` を1回実行する。Grok Bot はその前後で mdat を記録する。
  - タブ「試験3-15」で cfg15 として起動し、develop@ としてログインする。やり方と確かめ方は段2と同じ（メールの確認のあとで、短い質問を1回）。
- Grok Bot：段2と同じ記録をする。本番 Rotator と試験2のタブの表示も、もう一度見る。
- 15 は、そのまま開いておく（条件X：開いたままのセッション）。
- 14 は閉じたままにする（条件Y：閉じたフォルダ）。

### 段4 放置
- 最後に使ってから 14 時間以上置く。
- その間は、どちらのフォルダにも `auth status` を実行しない（ほかのプロセスが refresh するのを防ぐ）。
- Mac は再起動しない。

### 段5 翌朝の確認（この順番で）
- ① Grok Bot：両方の項目の属性を記録する（読むだけ）。B がまだあることと `readlink ~/.local/bin/claude` を記録する。本番 Rotator と試験2のタブの表示を見る。
- ② 坂根さん：15 のタブで /status を見て、メールと方式を確かめてから短い質問をする（条件Xの判定）。
- ③ Grok Bot：属性を記録する。
- ④ 坂根さん：15 で /exit し、14 を起動して、/status を確かめてから短い質問をする（切替 15→14、条件Yの判定）。
  - Keychain の確認画面が出たら「許可」を押す。Grok Bot は出たかと時刻を記録する。
- ⑤ 坂根さん：終了したフォルダ（15）にだけ `auth status` を実行する。Grok Bot はその前後の mdat を記録する。
- ⑥ 坂根さん：14 で /exit する。Grok Bot が終了を確かめたら、坂根さんが 14 のフォルダに `auth status` を実行する。Grok Bot はその前後の mdat を記録する。
- ⑦ /feedback：外部へ送るので、1回ごとに坂根さんの承認を得る。参考として、送信できたかと ID だけを記録する。

## 5. 判定（フォルダごと）
- 合格（すべて満たす）
  - /status が、期待するメールと完全に一致し、サブスクリプションのログインで、API Usage Billing の表示が無い。
  - 短い質問に普通に答える。
  - 終了したフォルダの `auth status`（翌朝の段5⑤・⑥）が loggedIn true で、メールが一致する。
- 合格の意味：手元の動作を確かめただけ。本番の Rotator に入れるのは、§2 の要確認①と②が決まり、坂根さんが承認してから。
- 補助の観測（合否には使わない）
  - mdat
    - 条件X（開いたまま）：夜の間に進んだか。
    - 条件Y（閉じたまま）：翌朝の質問の前と後で進んだか。進めば、refresh が保存された可能性が高い。
  - /feedback を送れたか（承認がなければ行わない。送れなくても不合格にしない）。
- 不合格：Not logged in、Login expired、loggedIn false、メールの不一致、API Usage Billing のどれかが出る。
- 判定保留
  - ネットワークやサービスの障害。
  - 版が変わった。
  - 手順から外れた。

## 6. 後片付けと、異変が起きたとき
- 後片付け（すべてのプロセスが終わってから。削除するたびに坂根さんの承認を得る）
  - Keychain の項目：`security delete-generic-password -s 名前 -a <user> 記録したKeychainのパス`
    - 削除の直前に `-s 名前`（`-a` なし）で属性を出し、当たる項目が1つだけで、Keychain・サービス名・account が記録と一致すると確かめる。曖昧なら削除を保留する。
  - 試験ルート：文字どおりのパスで `ls` してから削除する。
  - /logout は使わない。影響の範囲が分からないため（推測）。
  - 項目を消しても、サーバー側のログインは残るかもしれない。必要なら claude.ai の設定画面で確かめる。
- 中止する条件
  - 本番 Rotator が、#14・#15 で Not logged in やエラーになる。
  - 試験2のタブが落ちる。
  - 予測していない名前の項目ができる（段0と各段のあとに、坂根さんがキーチェーンアクセスで名前の一覧を見て確かめる）。
- 中止したとき
  - 試験のタブを /exit して報告する。そこで止める。
  - 本番の復旧（正規の再ログインなど）は別の作業として扱い、坂根さんの承認を得て行う。試験の手順の中では行わない。

## 7. 影響の範囲
- ローカルで分けられる範囲
  - 設定フォルダが違うので、Keychain の項目名も違う（公式：「a session with a different CLAUDE_CONFIG_DIR reads a different entry」）。
  - 試験1の記録では、`.claude.json` は CLAUDE_CONFIG_DIR の中にできた。
  - ログイン情報はコピーしない。
  - 自動更新は止める。
  - Rotator の環境変数は env -i で外す。
- 推定で、確認が必要なこと
  - 実際のホームを渡すので、`~/.claude.json` に触らないかは推定にとどまる。本番が普段から書き換えるので、mtime やサイズを比べても判定できない。代わりに、cfg14・cfg15 の中に `.claude.json` ができたこと（あるかとサイズだけ）を確かめる。段0の承認がなければ実行しない。
- 分からないこと（実行前の未解決事項）
  - 同じアカウントにログインを1つ増やしたとき、既存のログイン（本番、試験2）がサーバー側で影響を受けるか。
  - 短い質問の分だけ、使用量を使う。

## v3.1 の変更（11/03 03:01 JST、準備中に見つけた食い違い。レビューは受けていない）
- 詳しくは caseG-test3-run.md の「準備中に見つけた手順書 v3 との食い違い」。
