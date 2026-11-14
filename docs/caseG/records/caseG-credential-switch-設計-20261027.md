# 案G：認証保存先切替の設計メモ（2026-10-27）

状態：隔離評価とhelper内部のメモリ取扱いは2026-10-27 20:53に条件付き承認済み。
22:14の追加依頼でSecurity.frameworkバックエンドとdriverのソースを実装した。
実Keychain接続・実機実行・ログイン・実項目の書込/削除・移行は未実施。
作業場所は指定 worktree、ブランチは `Earthfreedom/caseG-proto-20261027` のみ。
この文書はローカル用であり、既存の ignore 対象。コミット・公開しない。

## 1. 目的、範囲、成立条件

Claude Code 自身の正規ログインを使い、認証値・HTTP ヘッダー・User-Agent・本文を
Rotator が置換しない方式を評価する。既存サーバー、既存プロキシ、既存リフレッシュ処理への接続はしない。
試作は既定オフ、依存性注入した保存先だけを扱い、ネットワーク通信を持たせない。
本番の設定、認証保存先、Rotator の保存データ、稼働プロセス、ポート37891を調べない・変更しない。
実機実行担当はGrok Bot。手順書を坂根さんへ提示して承認後にだけ実施し、ログインと許可判断は本人が行う。

**結論は条件付き。** 個々の保存先の更新と失敗回復は実装できるが、互いに独立した
Keychain と JSON と、既に動作中の各クライアントのメモリを一つのトランザクションにはできない。
現在の公開資料だけでは「無再起動・100セッション・一時的不一致もゼロ」を保証できない。
その保証が必須なら、保存先の直接切替を採用する根拠は足りない。
この制約を隠して、書込順やテスト成功をもって保証が成立したとはしない。

## 2. 事実と未確認事項

### 依頼者が2026-10-27に観測した事実（本作業で再現していない）

- 別 `CLAUDE_CONFIG_DIR` の同一dirへ別プロセスで正規 `/login` すると、保持セッションの
  `/status` と `/usage` はログイン完了後数秒で追従。再起動不要だった。
- Mac の既定項目名は `Claude Code-credentials`。別dirは絶対パスの SHA-256 先頭8桁を付けた項目。
  その試験では `.credentials.json` は作られなかった。
- Linux/Docker、2.1.310では認証ファイルと `oauthAccount` の両方なら約3秒、後者のみなら約41秒。
  トークンのみの変更は速かったが、表示と認証の不一致が生じた。

### 今回、公開資料・ソースから確認したこと

- 公式文書は macOS Keychain、Linux の `.credentials.json`、dirごとの分離、Macでのファイル退避を説明する。[S1]
- BASE_URL のみなら保存済みサブスクリプション認証が継続する構成は公式に説明されている。
  これは保存先を外部から変更することの承認や、`/feedback` の成功を意味しない。[S2]
- OSS `claude-swap` は資格情報用の複数ロックと設定用ロックを扱う。
  ロックの根拠として記載されているのは2.1.218であり、2.1.310の契約ではない。[S3]
- このcheckoutの `src/secret-store.js` は、独自の排他・期待値比較・リフレッシュ意図記録を用いる。
  Claude Codeのロックと同じものではなく、そのまま外部ライターとの排他にはならない。

### 未確認

直接Keychain更新時の追従、内部キャッシュの無効化条件、実認証先・課金先の追従、
2.1.310のロック名・順序・保持時間、Keychain許可、100セッション、リフレッシュ衝突、
再起動なしで全セッションが同じ世代を使い始めたことを確認する公式API、`/feedback` の経路。
表示が変わっただけでは実認証先や課金先を証明しない。

## 3. 比較した方式

| 方式 | 評価 |
| --- | --- |
| Keychain→JSON、またはJSON→Keychainを続けて書くだけ | 中間状態を読まれる。順番だけでは要求を満たさないため不採用 |
| 協調するセッションをターン境界で待機させ、ロック下で切替・検証・回復 | 条件付き試作の候補。ただし未協調のClaude Codeの読取・キャッシュまでは制御できない |
| アカウント別dir・別の正規ログインを維持 | 公式に説明された分離。無再起動で同じセッションを切り替える目的は満たさない。比較対象のみ |

推奨案は、2番目を**保証の実装ではなく、限界を測る隔離プロトタイプ**として作ること。
2026-10-27 20:53に、食い違いゼロを保証しない隔離評価として進めることが承認された。
今回も協調する偽アダプタだけを接続し、実Keychain用バックエンドは接続しない。

## 4. (a) 保存モデル、切替、原子性、回復

### 保存モデル

現在の隔離試作では、取り込んだ各アカウントの値、回復用の旧世代、ジャーナルをメモリだけに保持する。
以下の永続vaultは将来設計の論点であり、今回の試験で別Keychain項目やファイルへ保存する許可ではない。

- 公開可能なレジストリは、不透明なアカウントID、世代番号、状態、使用率の観測時刻だけを持つ。
- 資格情報は専用の `CredentialVault` アダプタへ置く。MacではOS保護ストア、他OSでは
  明示された専用保存先と0600/0700を想定。実トークンをJSON fixtureや作業文書へ書かない。
- `claudeAiOauth` とその取得時点の `oauthAccount` を同じ世代の組として保存する。
  メールアドレスだけで対応付けない。account UUID・organizationの組と由来を保持する。
- MCP等のアカウント共通データを古いスナップショットから上書きしない。
  資格情報側は `claudeAiOauth`、設定側は `oauthAccount` のみを現在の文書へマージする。
- 一度利用されたスロットの保存値を、無条件に「最新」と扱わない。
  実際に活動中の保存先が正本。停止中のスロットは再取り込みまで利用不可にできる。
- 取得・転送・比較のため、プログラム内部では資格情報のバイト列を扱う必要がある。
  人間・Codex・端末へ値を見せないことと、プログラムも一切読み取らないことは別条件。
  後者なら直接切替は成立しない。20:53の回答により、許可された試験項目の内部メモリ取扱いは承認済み。

### 条件付きの切替プロトコル案

1. 既定オフ。明示された非既定dirとその対応項目だけを許可する。HOME由来の暗黙既定値を持たせない。
   symlink・実パス逸脱・既定サービス名・Macのファイル退避・不明な保存先は拒否する。
2. dir単位の切替要求を集約し、世代付きの受付停止を開始する。進行中ターンを中断しない。
   全登録セッションのターン終了を待つ。未登録・無応答・新規参入がある場合は延期する。
   ターン終了は推論要求の終了と同義ではない。複数API呼出しやツール実行を含める。
3. 切替ロックと、実機の対象バージョンで確認したClaude Codeのリフレッシュ用・設定用ロックを
   一定順序で取得する。タイムアウト時は無変更で延期。古いと推測したロックを削除しない。
4. ロック内で現在の資格情報とidentityを再取得。事前観測世代と違えば更新後の組を再取り込みする。
   由来・identityが不明なら隔離する。ログイン途中や別ライターの不明な変更を推測で補完しない。
5. 新アカウントの組を検証し、現在の正本をvaultへ取り込む。
   回復用資格情報は保護ストアへ、ジャーナルは不透明ID・世代・段階・ハンドルのみを保存する。
   JSONへの平文認証バックアップ、トークンのハッシュのログ出力はしない。
6. 資格情報を先に更新。Macは既存項目のデータ更新を使い、削除→再追加やACL変更を行わない。
   非Macは同一ディレクトリの0600一時ファイルをfsync→rename→親dir fsyncで置換する。
7. 現在の設定JSONへ `oauthAccount` だけをマージし、同じく原子的ファイル置換する。
   無関係な設定やMCP情報を上書きしない。不要なダミーファイルのtouchで通知を捏造しない。
8. 両保存先を再取得して組・世代を内部比較し、ジャーナルをcommitする。
   各セッションのキャッシュ追従と実認証の確認は、保存成功とは別段階とする。
   全体の追従が不明なら、新ターンを自動的に再開しない。

**6→7の間には必ず別ストア間の中間状態がある。** ロック非参加の読取や古いキャッシュが
この状態を観測する可能性は消せない。JSONを先に書けば逆向きの不一致になるだけである。
プロキシへの新しいリクエストの入口を止めても、クライアントが既に読んだ資格情報、補助通信、
接続前のリクエスト組立てを取り消せず、厳密な解決にはならない。

### 失敗とクラッシュ

- 最初の書込前の失敗：受付停止を解除し、旧世代で継続可能。
- 資格情報の更新後にJSON更新が失敗：ロックと受付停止を維持。
  両方が自分の想定状態であることを再確認し、保護ストアの旧組へ条件付きで戻す。
- 途中で外部更新、リフレッシュ、ログイン、読取不能を認めたら、古いトークンで上書きしない。
  自動rollbackを中止し `recovery_required` とし、手動の正規ログインによる復旧を案内する。
- 「書込は成功したが応答が失われた」は再読取で判定する。単純な再試行はしない。
- プロセスクラッシュ後は永続ジャーナルを見て保留する。メモリロック・メモリジャーナルの
  単体テストはこの保証を検証できない。試作の永続化範囲と未実装範囲を明記する。
- ロールバック中も別ストア間の原子性はない。旧資格情報がサーバー側で無効なら、
  スナップショットを戻しても認証は回復しない。
- ファイルでの比較→renameは、非協調ライターに対する原子的な比較更新ではない。
  外部更新を保全できる保証は、全ライターが同じ排他に参加するモデルに限る。
  実機で共有ロックが確認できなければ、保存先の直接書込とrollbackを禁止する。

## 5. (b) トークン更新の所有者

**アクティブな資格情報の更新所有者はClaude Codeのみとする案。**
案GではRotatorの既存リフレッシュを接続しない。非アクティブなアカウントも試作から更新しない。
期限切れや不明な状態は正規の手動ログインへ戻す。新しいOAuthクライアントや認証要求は実装しない。

更新後の取り込みは、通知を契機に、共通ロック下で正本を再取得し、vaultの期待世代と比較して行う。
通知を失っても切替直前の再読取で補う。取込直前・保存直後に変更されたら再判定する。
credentialの一部が更新されても、account UUID等の由来が一致する限り、そのアカウントの新世代として扱う。
アカウント変更とトークン更新を単なるmtimeだけで区別しない。

ただし外部アプリが同じロックを守ること、100プロセスが同じ更新規約を守ることは未確認。
**「所有者はClaude Code」と書くだけでは、複数のClaude Code間の衝突は解決しない。**
別dirのセッションで同じrefresh tokenの系列を使い回すことも避ける。
独立したログインでも同じ本番アカウントへのサーバー側影響をゼロとは言えない。

`claude-swap` のロック実装は、refreshと設定書込の協調方法を公開しているが、公式の安定APIではない。[S3]
同OSSのOAuth実装には直接のトークン更新もあり、本案ではその部分を採用しない。[S4]
同OSSのリリース履歴には古いrefresh token、部分的な復元、セッション側で更新された保存値の問題がある。
これらは設計上の注意点の根拠であって、2.1.310で問題が解消した証拠ではない。[S5]
リフレッシュトークンの単回性・回転・猶予期間は、今回公式の契約仕様として確認できていない。

## 6. (c) 97〜98%とターン境界、100セッション

- 使用率は0〜1に正規化し、窓・モデル・観測時刻を保持。97%で切替候補を予約、98%を目安に
  新ターン受付を待機へ進める設計候補とする。欠測・古い観測・期限不明を0%とは扱わない。
- 使用率が非同期である以上、残り2〜3%が100ターンを完走させる保証はない。
  進行中の合計消費の見積りと観測遅延の余裕を加えた受付予算が別途必要。
  今回はネットワークで使用率を取らず、注入された偽の観測だけで判定を試作する。
- 同じdirの100セッションは一つの認証保存先を共有する。各セッションへ別アカウントを割り当てることはできない。
  同時の100件の切替要求を1件へ集約し、1世代だけ進める。セッションごとの独立切替は別dirが必要。
- 対象窓で余裕のある候補だけを一つ予約し、短時間の往復切替を抑える。
  全候補が上限・期限切れ・不明なら待機する。制限応答を別アカウントで再試行して迂回しない。
- 100セッション全てのターンが自然終了するまで待てば、切替が長時間進まない可能性がある。
  タイムアウト時は延期して報告する。プロセス停止、セッション削除、強制中断は行わない。
- Stop通知は参考情報であり、全セッションの排他やキャッシュ世代の証明にはしない。
  session登録と全体barrierを本番へ追加する実装は今回の未接続試作の範囲外。
- 97〜98%でのアカウント切替が契約上許されるかは別の未解決条件。許諾の判断前に運用しない。

## 7. (d) 既定dirとKeychain許可

将来の既定dirでは設定は `~/.claude.json`、資格情報は既定Keychain項目になる想定。
別dirでのJSON位置は暗黙に決めず、その試験環境でClaude Codeが作成した位置を確認する。
本試作の手動試験アダプタは既定dir・既定項目を拒否する。既定への移行は別途承認が必要。

AppleはKeychainへのアクセス時に単発許可・常に許可・拒否の選択肢があると説明する。[S6]
実際に出るかは署名、呼出し元、ACL、ロック状態に依存し、他ツールの許可はRotatorへ引き継がれない。
手動試験は試験項目と実行バイナリを確認できる単発許可だけを想定する。
既定項目、対象不明、ACL変更、全アプリ許可、全Keychainの解除を要求されたら拒否して止める。
繰り返す許可要求を無人処理で回避しない。常時運用には署名済みの固定helperと承認運用の検討が必要。
管理者権限やsudoで解決すると決めつけない。Keychain拒否時はファイルへ勝手に退避しない。

秘密値をargvへ渡す `security add-generic-password ... -w <値>` は使用しない。
実機用helperを作る場合はSecurity.frameworkで内部読取・更新し、値をstdout/stderrへ返さず、
Node側は成功状態と値なしの指標だけを返す設計とする。helper本体はKeychain APIを持たず、
22:14追加分の専用fdアダプタとSecurity.framework実装は13章に記載する。公開操作へ値を入力する機能は設けない。

## 8. (e) 移行と戻し方の案（実施しない）

1. 適用される規約、所有者、許諾、実機試験結果を確認する。現在のプロキシは認証置換を行うため、
   設定だけをBASE_URLのみにしてそのまま接続しない。素通し経路の別設計・検証が必要。
2. 各アカウントの正規ログインと保存先を整理し、活動中資格情報のrefresh所有権をClaude Codeへ一本化。
   既存Rotatorのrefresh停止・変更は本タスクで実行しない。
3. 移行時に、設定の非機密な変更前状態と復元方法をローカルに保全する。
   認証データは平文コピーせず、保護ストアで管理。旧トークンが復元可能とは想定しない。
4. 承認した保守時間に新ターンを待機させ、旧経路から切り離す。
   `ANTHROPIC_AUTH_TOKEN` と `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` をsettingsのenvから除く。
   `ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、apiKeyHelper、シェルや管理設定の認証上書きも確認する。
   確認・編集は承認された移行担当者が行い、本作業では読まない。
5. 最初は隔離dirで正規ログイン・直結を基準にし、次にBASE_URLのみの素通し経路で比較する。[S2]
   表示、usage、実際の認証先、課金先、補助通信の結果を分けて検証する。
   `/feedback` は外部送信になるためCodexは送信しない。今回の承認用手順書には最小限の送信評価を含め、
   坂根さんがその内容を承認後、Grok Botが標準UIで実施する。
6. 失敗したら新しい切替を無効化し、新ターンを待機。承認済みの旧設定と旧経路へ戻す。
   クライアントの環境変数は起動時に保持され得るため、設定ファイルを戻すだけで既存セッションが
   旧経路へ戻る保証はない。移行・復旧時には手動で新しい起動が必要になる可能性を明記する。
   保存済みトークンが無効なら正規の手動ログインで復旧する。資格情報の古いコピーを盲目的に戻さない。

## 9. (f) 規約・認証情報の要確認点

以下は法的結論ではなく、原文に基づく未解決事項。OSSの存在は許諾の根拠にしない。

| 論点 | 原文の短い抜粋または出典 | 要確認事項 |
| --- | --- | --- |
| 適用契約 | [S7]はPro/Max等とTeam/Enterprise/APIで適用契約を分ける | 16アカウントそれぞれの契約・本人・組織権限。自己所有の支払済みアカウントというだけで自動切替が許可されるとは確定しない |
| 資格情報の共有 | [S8] “You may not share your Account login information” | 同一所有者内の保管・自動コピー、複数人利用、第三者ツールが資格情報を扱うことの許容範囲 |
| 自動アクセス | [S8] “automated or non-human means” | 正規Claude Codeの使用と、外部ツールの保存先置換・usage取得・refreshの許容範囲は同一と断定できない |
| 制限の迂回 | [S8] “bypassing any of our systems or protective measures” | 上限直前の多アカウント自動切替が制限の迂回に該当しないという根拠が必要。単にサーバーの429を返すだけでは解消したといえない |
| AUPの改定・施行 | [S9] “We will update our policy” | 取得ページは2026-11-12施行と表示され、作業日2026-10-27より後。今日の有効版として扱えない。現行版と予告版の差分・改定通知を確認する |
| 第三者サービス・製品への組込 | [S7] | 本人のローカル運用と、再販・仲介・他人向け提供は区別する。バイナリを改変しないことだけで全条件を満たすわけではない |

[S8]で今回取得できた本文はEEA/スイスの消費者を対象と記載されている。
日本の利用者・業務利用へそのまま適用される条文とは断定できない。
同一URLからの地域別表示・契約当事者・現在の適用版の確認が必要。
取得資料では、第三者による資格情報切替を明示的に許可する公式仕様は確認できなかった。
これは一律に禁止されていると確認した、という意味でもない。

## 10. 20:53時点の偽アダプタ試作の範囲と検証（段階記録）

対象は新規モジュール・新規テスト・ローカル手順のみ。既存起動処理、プロキシ、設定、package scriptsを変更しない。

- `src/credential-switch.js`：既定オフ、世代、単一進行、準備→書込→検証→commit、条件付きrollback、回復要求状態。
- `src/credential-switch-adapters.js`：明示したtemp dir内のJSON用アダプタ。
  実際の一時ディレクトリ配下、`credential-switch-`で始まる0700のdirだけを許可する。
  `.claude.json`のみ扱い、シンボリックリンクやハードリンクを拒否する。Keychain実装は持たない。
- `test/credential-switch.test.js`：秘密ではない生成データだけを使い、無効時無アクセス、100要求の集約、
  進行中ターンの延期、外部更新の取込、前半失敗、後半失敗、rollback失敗、外部更新の保全、値の例外漏洩防止を確認する。
- 手動試験用helperのAPIと安全装置は、20:53の回答と追加条件を反映して実機評価手順に記載した。
  今回は偽Keychain用ライブラリまでで、Security.frameworkバックエンドと実機driverは持たない。
  将来の実機アダプタは既定項目・prod保存先・ファイル退避・symlinkを拒否し、
  2.1.310互換と称して未確認のロックを実装しない。

focused testは `node --test test/credential-switch.test.js`：21 pass / 0 fail / 0 skip（Node 24.22.0）。
秘密ではない世代番号のオブジェクトをメモリ上のKeychainとして使い、保存先JSONには試験identityのみを書く。
失敗経路のテストを先に実行し、失敗を確認してから実装・修正した。Node evalは使っていない。
full checkは `npm run check` をDocker内で実行する予定だったが未実行。
`docker image inspect node:22-bookworm --format '{{.Id}}'` はsocket接続が `operation not permitted` で失敗。
隔離を迂回して既存全テストをホスト実行しない。`npm run lint` は終了コード0。
macOS/Ubuntu×Node22/24のmatrixは既存CIが正本であり、この作業で実行したとは報告しない。
Keychain実機試験やClaude Code起動は自動テストから行わない。

追加した `src/credential-switch-helper.js` は、14/15に固定した2dirのハッシュ付き項目名だけを扱う。
Keychainとmetadataのアダプタは明示注入が必須。既定項目・未知のハッシュ名・パス逸脱・他のslotを拒否する。
capture/activate/observe/close/deleteTrialItemの公開結果には、固定状態・世代・真偽・許可済み項目名だけを含める。
取得した資格情報と回復値はメモリだけ。refresh、login、HTTP、logger、OSコマンド、実Keychainバックエンドを持たない。
liveのclaudeAiOauthだけを置換し、共有フィールドを保つ。切替前に完全なidentityを照合してドリフトを拒否する。
追加テストは `test/credential-switch-helper.test.js`。実アカウント対応、実パス、source不稼働、
項目一意性、共有ロック、fallback不在は、将来の実機authorizeアダプタと本人確認の必須責務。
字句パスとfakeテストだけでこれらを証明したとは扱わない。

### 試作APIと保証の境界

`createCredentialSwitcher({ enabled, activeAccountId, credentials, metadata, vault, journal, lock, barrier })`
が `switchTo(accountId)` を返す。`enabled === true` の場合だけ動作する。
既存サーバー・CLI・プロキシからのimportは追加していない。

| 注入物 | 必須メソッドと責任 |
| --- | --- |
| credentials / metadata | `read()`、`compareAndSet(expected, next)`。前者は不透明な試験材料、後者はoauthAccount。戻り値falseは競合 |
| vault | `read(id)`、`save(id, {credential, identity, usable})`。組の由来とidentity対応は信頼するアダプタの責任 |
| journal | `read()`、`write(nonSecretRecord)`、`clear()`。試作はメモリ実装のみ。実資格情報を入れない |
| lock | `runExclusive(callback)`。全協調ライターで共有する排他。プロセスをまたぐ実装は今回ない |
| barrier | `pause()`で新ターン受付だけを止め、`acquire()`で全協調ターンが終了したlease、またはnull。延期時も受付停止は維持。pause/acquire/leaseの`release({resume})`が失敗する場合も停止状態を維持する契約が必要 |

結果は `status` と `generation` のみ。資格情報、identity、raw例外は返さない。
statusは `disabled / switched / unchanged / busy / deferred / unavailable / failed / rolled_back / recovery_required`。
100同時要求のテストは**1コントローラーへの100 Promise**であり、100 Claude Codeプロセスの試験ではない。
refresh取込テストも、外部からメモリ材料を変えたモデルであり、実際のtoken refreshの試験ではない。
使用率の `assessSwitchPressure(sample, {now,maxAgeMs})` は純粋な判定のみ。アカウント選択や自動切替へ接続しない。

`recovery_required` 後は当該コントローラーで切替を拒否し、可能ならジャーナルへ非機密markerを再記録する。
ジャーナル自体が読書き不能なら、このプロセス内の停止は保てても、再起動後の永続検知は保証できない。
またbarrierが契約に反して「再開を反映してから失敗」を返せば、その再開を本モジュールから取り消す仕組みはない。
実機用の永続ジャーナル、OS間排他、全セッション登録、キャッシュ世代確認は未実装。

## 11. 実機評価の手順書

手順の正本は [実機評価手順](caseG-credential-switch-実機評価手順-20261027.md)。
目的、事前確認、準備、14/15の正規ログイン、保持セッションの直接書換え、自然なrefresh、
feedback送信、停止条件、復帰・完全一致削除、記録する指標とhelperの契約を記載した。
22:14追加分でバックエンドとdriverのソースは実装済み。実機評価は未実行で、手順書承認前に実行しない。
実行は手順書を坂根さんに提示して承認後、Grok Botが行う。Codexは行わない。

## 12. 2026-10-27 20:53の回答と今回の境界

1. 問1への回答は「はい」：食い違いゼロを保証しないと明記した隔離評価として進める。
2. 問2への回答は「許す」：試験用ハッシュ付き項目の値をhelper内部のメモリだけで扱える。
   人間・Codex・画面・ログ・ファイル・テスト出力へ値を出す許可ではない。
3. 対象は新しいCLAUDE_CONFIG_DIRと14/15の2アカウントのみ。本番・既定項目・既定dirは引き続き除外。
4. 試験アカウントでのトークン無効化による再ログインと少量の使用量消費は許容済み。再確認しない。
5. 今回はhelperの実装と偽Keychainの単体テストまで。実Keychain接続、実機実行、送信、削除をしない。
6. 実機評価手順を読んだ後の坂根さんの承認が、Grok Botによる後続実行の前提。
   本番利用の承認、規約適合性の確認済み、2.1.310の共有ロック確認済みという意味ではない。

## 13. 22:14の追加依頼：実機バックエンドとdriver（実行しない）

対象は引き続き別dirの14/15だけ。今回、Security.frameworkの存在確認・読取・比較後更新・完全一致削除の
ソースと操作driverを実装するが、Codexは実Keychainへ接続せず、実機実行・ログイン・書込・削除を行わない。
Swiftのコンパイルと、Security呼出しを差し替えたfakeの単体テストだけを行う。

### 構成と入出力

- Swift core：操作対象をroot内live/alternateから算出した2サービスへ限定する。
  既定名、他のハッシュ、非正規パス、symlink、fallback認証ファイル、所有者/権限不適合を拒否する。
  Security APIは注入可能にし、テスト時は必ずfakeを渡す。項目は一意性を確認してpersistent referenceで特定する。
- Swift main：標準出力/標準エラーへ値を出さない。fd3/fd4の専用パイプ以外では起動を拒否する。
  初期化時に試験rootと承認合言葉を検証し、それまではSecurity APIを呼ばない。
  値は専用パイプ内だけを通り、Nodeアダプタ内のメモリへ返す。argv/env/通常ファイルへ渡さない。
- Node bridge：明示した試験root内のnative binaryだけを専用fd付きで起動する。stdout/stderrは破棄し、
  専用応答のraw例外や値は公開しない。環境変数からの認証や有効化は受け付けない。
- driver：prepare/check/serve/register/switch/observe/close/cleanupを個別コマンドにする。
  serveだけがメモリ上のvaultを保持し、他コマンドは0600の試験用Unix socketへ値なしの要求を送る。
  socketを通るのは状態・slot・合言葉・操作確認だけ。資格情報は通さない。

### 承認と段階

既定はdry-run。dry-runは計画表示だけでファイル・Keychain・socket・native processへ触れない。
実処理には `--execute --approve caseg-<試験rootのbasename>-approved` を毎回指定する。
これは手順承認の確認用の公開合言葉であり、秘密の認証情報や、他ユーザーに対するアクセス制御ではない。
prepareは新しい0700 rootと非機密のmanifestだけを作り、checkは最初のログイン前に2項目の不存在を確認する。
不存在確認が保存されていなければregister/switch/cleanupを行わない。

### 原子性・停止条件

4〜8章にある共有ロック下の将来運用設計とは区別し、今回の実機評価は以下の未協調・手動確認付きの限定実験とする。
Claude Code内部ロックの互換実装はしない。driverの排他はdriver自身の多重起動・同時操作だけを防ぐ。
実機のregister/switch/observeには、手動でターン終了と取込元不稼働を確認したフラグ、および
未協調の実験であることへの明示フラグを要求する。これはクライアントの停止を強制・検証する機構ではない。
Security.frameworkの読取→比較→更新は、他プロセスに対する原子的CASではない。
JSONとの食い違いゼロ、refreshとの無競合、既存リクエストやキャッシュの即時追従は保証しない。
更新後を再読取して比較し、不明な外部更新・不一致・許可拒否は回復必須で停止する。
自動refresh、認証要求の自作、HTTPの書換え、既存プロセス停止、ACL変更は実装しない。

### 実装範囲と検証

native core/main、Node bridge、driver module/CLI、fakeテスト、既存2文書に限定する。
新規のセキュリティ境界をレビュー1回で確認し、指摘修正後は該当箇所だけ再確認する。
テストはfake Security API、fakeパイプ/バックエンド、空の一時dirのみ。実バックエンドの起動試験は行わない。
Docker接続不可のため全体チェックとCIは引き続き未実行として扱う。

検証結果：Node関連4ファイルを指定したテストは52成功/0失敗/0skip。
`npm run lint`は終了コード0。Swift core+mainはコンパイル成功、実機用実行ファイルは起動していない。
Swift fake executableは9成功、実Security API呼出し0。専用fdのNode検証はfake spawnだけで行った。
driverの実socket通信、Keychain許可、Security APIの実照合、実セッションの追従、refresh競合は実機で初めて確認する。
手順のzsh10ブロックとPython2ブロックは構文確認だけを行い、手順自体は実行していない。

Appleの公開APIに基づき、サービス名で属性とpersistent referenceだけを検索して一意性を確認し、
以後の読取・更新・削除はその参照に限定する。データを検索条件として渡さない。
SecItemの参照による照合は公式のAPI仕様であり、Claude Codeの内部ロックや認証挙動との互換性を意味しない。
[SecItemの仕様](https://developer.apple.com/forums/thread/724023)、
[CopyMatching](https://developer.apple.com/documentation/security/secitemcopymatching(_:_:))、
[Update](https://developer.apple.com/documentation/security/secitemupdate(_:_:))、
[Delete](https://developer.apple.com/documentation/security/secitemdelete(_:))

## 出典（2026-10-27取得。現行のWeb本文は2.1.310に固定された仕様ではない）

- [S1] Anthropic, Authentication / Credential management / multiple accounts:
  https://code.claude.com/docs/en/authentication
- [S2] Anthropic, LLM gateway / Subscriptions and gateways:
  https://code.claude.com/docs/en/llm-gateway
- [S3] realiti4/claude-swap, `claude_locks.py`（取得時main。本文は2.1.218の観測を根拠とする）:
  https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/claude_locks.py
- [S4] realiti4/claude-swap, `oauth.py` / `switcher.py`（取得時main。公式保証ではない）:
  https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/oauth.py
  https://github.com/realiti4/claude-swap/blob/main/src/claude_swap/switcher.py
- [S5] realiti4/claude-swap, Releases（v0.24〜v0.27の保存・refresh・rollback修正の説明）:
  https://github.com/realiti4/claude-swap/releases
- [S6] Apple, If you're asked for access to your keychain on Mac:
  https://support.apple.com/guide/keychain-access/kyca1243/mac
- [S7] Anthropic, Legal and compliance:
  https://code.claude.com/docs/en/legal-and-compliance
- [S8] Anthropic, Consumer Terms of Service（取得本文は2025-10-08施行、EEA/スイス向け表示）:
  https://www.anthropic.com/legal/consumer-terms
- [S9] Anthropic, Usage Policy（取得本文は2026-11-12施行と表示。作業日時点の有効版とは未確認）:
  https://www.anthropic.com/legal/aup
