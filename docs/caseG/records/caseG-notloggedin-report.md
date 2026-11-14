**案G「Not logged in」調査報告 — 2026-10-30（JST）**

調査対象：claude-rotator/caseG-proto-20261027。読み取り調査のみ。証拠採取は2026-10-30 15:25〜15:42頃。

**結論：原因は未特定。優先して分けるべきなのは「長時間待機後の認証有効性・自動更新」と「保持プロセス側の資格情報解決・キャッシュ・読取権限」である。**
保存値が存在してobserveで不変でも、Claude Code自身が有効な認証として使えることは保証されない。
使い切りrefresh tokenの再利用、helperによるACL改変、更新、feedbackとの混線のいずれも、今回の資料だけでは原因と断定できない。

以下では「提供事実」「今回確認した事実」「推測」を分ける。確度の高・中・低は根拠の強さであり、統計的な確率ではない。

**提供事実：坂根さん／Grok Botの報告。今回こちらから画面・端末へ入力して再現してはいない。**

| 時刻 | 提供された経過 |
| --- | --- |
| 10/29 19:56 | registerを実施 |
| 19:57 | 15へswitch |
| 20:01 | 14へswitch。その後、保持中Claude Codeは無入力 |
| 20:05〜10/30 06:07 | 60秒ごと600回のobserveでcredentialChanged=false、identityMatches=true、fallbackなし |
| 10/30 12:31 | 短い質問で「Not logged in · Please run /login」 |
| 12:31〜12:41 | 10秒ごとのobserveでも変化なし |
| 現在 | 更新済み・再起動待ちの表示。serveは継続。本番Rotatorの同じアカウントはroutes now表示 |

重要な留保：提供情報だけでは、20:01の切替直後に通常の推論要求が成功したかは確認できない。
したがって「12:31に初めて壊れた」と「20:01以降に潜伏していた問題が12:31の最初の入力で顕在化した」は区別できない。
20:01〜12:31は約16時間30分だが、実際のtokenの発行時刻・期限は読んでいない。
本番のroutes nowは提供された表示情報としてのみ扱い、本番認証値や実リクエストは調べていない。

**今回確認した事実：値を取得しないメタデータと、許可されたログのエラー分類。**

試験rootは、候補dirのパス文字列からliveのサービス名を計算し、指定されたハッシュに一致するもの1件を特定した。
対象root：`/private/tmp/credential-switch-20261029-53B3435C-FABD-4B7B-ACBF-04DA6CFEEAAB`。
他の試験rootの内容は開いていない。

| 対象 | 今回取得した結果（JST） | 分かること／分からないこと |
| --- | --- | --- |
| live項目 `Claude Code-credentials-<redacted>` | 作成10/29 18:43:14、更新10/29 20:01:34、属性照合成功 | 20:01以後の保存更新は、この更新日時には現れていない。tokenの期限や有効性は分からない |
| alternate項目 `Claude Code-credentials-<redacted>` | 作成・更新とも10/29 18:38:08、属性照合成功 | 取込元15側の保存更新は確認できない。live上で活動した15の過去状態までは分からない |
| `live/.claude.json` | 73,971 bytes、0600、UID 501、更新10/30 12:31:33 | 失敗した質問と同時刻に設定ファイル更新がある。認証更新成功を意味しない |
| `alternate/.claude.json` | 68,259 bytes、0600、UID 501、更新10/29 18:41:32 | liveとは別の設定ファイルである |
| 両方のmetadata | oauthAccount、accountUuid等の既知キー名を検出 | キー名だけ。値・UUID・メールの抽出や照合はしていない |
| 両方の`.credentials.json` | 不存在 | 現時点でファイルfallbackは見つからない。過去の一時的な生成まで否定するものではない |
| `.driver-lock`／`control.sock` | 作成・更新10/29 19:55:27、dir 0700／socket 0600 | serve保持時の通常の成果物。削除やsocket接続はしていない |
| scope.json／preflight.json | 504／85 bytes、0600。既知キー名を確認 | 値の出力や変更なし |

Keychain確認は、上の完全一致名に対する `security find-generic-password -s <試験項目名>` だけ。
`-w`、`-g`、dump-keychain、既定のClaude Code項目は使っていない。出力はサービス名一致・作成日時・更新日時に限定した。
Keychainの項目作成日時はtoken発行日時ではない。またJSONファイルのbirthtimeは置換保存でも変わるため、プロファイル作成時刻と同一視しない。

試験dir内にdebug/logsディレクトリは見つからなかった。projects配下のsession JSONLは14側1本73レコード、15側1本10レコードを分類した。
長いレコードも分割して走査し、本文・ヘッダー・値は表示・保存せず、固定のエラー種別と時刻だけを取得した。

| エラー分類 | 結果 |
| --- | --- |
| not_logged_in | 14側で1回、10/30 12:31:33.596 |
| authentication_failed | 14側で1回、同じ時刻。上の分類と別々の失敗とは数えない |
| invalid_grant／refresh_error／keychain_error／HTTP 401・403／feedback_error／update_error | 分類対象のエラーレコードからは検出できなかった |
| 15側の該当エラー | 検出できなかった |

これはdebugの通信・認証トレースではない。検出なしは、refresh試行・サーバー拒否・Keychain拒否が実際になかった証明にはならない。
観察出力600回の全文やOrca端末の生出力は取得せず、回数と結果は提供事実として扱った。

**ソースから確定する観測の限界。**

- [helper.js:47]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-helper.js:47)は残存時間を計算するが、[observe:211]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-helper.js:211)はそのusableを成功条件にしていない。
  時間が過ぎて期限切れになっても、保存された値が同じならcredentialChanged=falseになり得る。これはコード上の事実で、実tokenの期限を読んだ結論ではない。
- observeは現在値と直前に覚えたprofileを比較し、そのprofileを更新する。初回登録時の固定値との照合でも、サーバーへの認証確認でもない。
  identityMatchesもローカルmetadataと控えの一致であり、実認証先・課金先の証明ではない。
- 現driverのmetadata上限は[1 MiB]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-driver.js:14)で、今回の73,971／68,259 bytesは範囲内。
  前回の64 KiB上限によるmetadata読取失敗と、今回のClaude Code側Not logged inを同じ障害とは扱わない。
- [switcher.js:77]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch.js:77)は切替直前の活動中資格情報を読み、退避してから対象を書き、再読取で検証する。
  切替がこのソースでswitchedを返した場合、対象はその時点のhelper時計で30秒以上残るものに限定される。その後の更新成功は保証しない。
- [helper.js:139]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-helper.js:139)の非アクティブ控えはメモリ上の保存値である。
  別の更新主体が同じtoken系列を更新しても、非アクティブ控えへの自動追随はない。系列が同じかは値非取得の条件では確認していない。
- [driver.js:129]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-driver.js:129)の排他はdriver内のもの。
  手動idle確認はClaude Codeや本番Rotatorのrefreshを排他するロックではない。
- [LabKeychainCore.swift:141]($HOME/develop/project/claude-rotator/caseG-proto-20261027/native/LabKeychainCore.swift:141)の更新指定はkSecValueDataだけ。
  switchにACL書換え・削除再追加・所有アプリ変更を明示する処理はない。削除は別のcleanup操作で、今回は実行していない。

これらは現在のworktree上のコードを読んだ結果。serveのメモリや資格情報の控えは調べていない。
主要6ソースのSHA-256は調査中の比較で一致し、こちらからコードを変更していない。

**複数PCで同じアカウントを使える点について。**

坂根さんの指摘を踏まえ、「同じアカウントを二重利用したから必ず失敗する」という説明は採用しない。
アカウントが同じことと、複製した同じrefresh token系列・世代を複数の更新主体が使うことは別問題である。
今回、本番Rotatorと試験ログインが同じ系列か、別PCの正規ログインが独立した系列かは確認していない。
本番のroutes nowだけで、試験用の控えも有効だとは言えない。
公式資料は同一マシンの並行セッションが保存ログインを共有し、更新を調整すること、2.1.211以前には同じtokenの更新競合問題があったことを説明する。
この旧不具合が2.1.310でそのまま再発した証拠ではなく、外部helperが同じ調整に参加できている証拠でもない。[公式トラブルシュート](https://code.claude.com/docs/en/troubleshoot-install#not-logged-in-or-token-expired)

**以下は原因候補の評価であり、確定事項ではない。**

| 候補 | 確認方法と今回の結果 | 確度・残る確認 |
| --- | --- | --- |
| (a) 期限経過後のrefresh回復失敗 | ソース、observeの意味、項目更新日時、エラー分類を確認。長時間待機と保存更新なしは整合するが、期限・refresh要求・拒否を直接確認できていない | 中：優先して切り分ける。単に期限を過ぎただけで正規clientが必ず失敗するとは言えない |
| (aの内訳) 使い切りrefresh token再利用／古い控え | 同一系列でrefresh credentialが回転するなら、非アクティブ控えの自動同期と外部更新者との共有排他がないため古い世代へ戻す可能性がある。しかし今回の回転・同一系列・invalid_grantはいずれも未確認 | 低〜未確認：具体的原因として断定不可。値比較や本番認証情報の調査は行わない |
| (b) helper書込でACL・所有アプリが変わった | 更新コードはデータだけ。項目作成日時も残っており、helperによる明示的な再作成を示す材料はない。find属性からACL内容までは調べられない | 低：helperがACLを変えたという説の裏付けなし。一方、Claude Code側だけが読めない可能性は未排除 |
| (c) Claude Code更新 | 画面表示は提供事実。実プロセスの版・実行ファイルの署名/変更時刻は未調査。公式説明では更新は次回起動時に反映される | 低〜未確認：バナーだけで稼働コードが更新済みとは言えない。版を固定した比較が必要 |
| (d) feedback／15側更新との混線 | helper自体にfeedback・login・refresh通信はない。切替時に活動側の最新値を退避する。15の取込元項目には更新がないが、19:57〜20:01のlive上の15の過去状態は再構成できない | 低：今回のエラー分類に裏付けなし。feedback実施時刻・その際のrefresh有無は未確認 |
| (e) 保持プロセスのキャッシュ／読取権限／認証供給元の差 | 保存値は残り、helperは読めたとの観測がある一方、保持セッションは利用可能な資格情報なしとして失敗。両者は別の実行主体であり矛盾しない | 中：同じdir・同じ版の新規clientとの比較を優先。通常/login後の追随を外部書込へそのまま外挿しない |
| (eの別候補) アカウント失効・組織拒否・ネットワーク | 401/403やネットワークの直接的なエラーは得られず、本番側は利用可との報告。試験側と同じ認証系列とは未確認 | 低〜未確認：一般的なauthentication_failedだけでサーバー側失効と決めない |

現行公式のエラー説明ではNot logged inは、そのセッションに有効な資格情報がない状態である。
OAuth tokenのサーバー拒否やrefresh後のLogin expiredとは説明が分けられている。今回の文言だけではinvalid_grantを証明しない。
また、同じdirの別窓で正規ログインした場合の自動追随は説明されているが、外部helperの直接書換えに同じ保証があるとは書かれていない。
これは現行Web資料の整理であり、2.1.310の内部実装を直接解析した証明ではない。[公式エラー資料](https://code.claude.com/docs/en/errors#not-logged-in)

更新については、公式説明は「バックグラウンドにインストールし、次回起動時に反映」。今回、再起動して確認することはしていない。[公式更新説明](https://code.claude.com/docs/en/setup#auto-updates)
公開CHANGELOGの2.1.310〜2.1.312に今回の条件へ直結するclaude.ai認証修正は確認できなかった。
2.1.314にはAnthropic profile共有時の更新改善があるが、今回のサブスクリプション保存形式と同じ経路とは確認できず、更新が原因/解決策とは断定しない。
2.1.281のKeychain保存修正等は2.1.310より前で、MCP向け修正を今回へ取り違えない。[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)、[2.1.310リリース](https://github.com/anthropics/claude-code/releases/tag/v2.1.310)

**今回実行していないこと。**

トークン・refresh token・パスワード・鍵・控えの値、期限の値、ACL内容、プロセスメモリ、実行中の環境変数は取得していない。
本番Rotator、既定項目、~/.claude、~/.claude.json、~/.config/claude-rotatorには触れていない。
試験画面への入力、/login、driver操作、observeの追加実行、停止・再起動・削除、コード変更、テスト実行、コミットもしていない。
書き込む成果物はこの報告だけ。試験dirのログは自動分類し、元の行・ヘッダー・会話本文を報告へ転記していない。

**次に確かめるべき最小の試験（以下は提案だけ。どちらも坂根さんの個別承認後にGrok Botが行う）。**

1. **保持プロセスと新規プロセスの比較を1回。** 既存セッション・serveはそのまま保持し、同じlive dirを使う未更新の2.1.310を別プロセスで起動して、/loginやswitchをせず無害な短問を1回だけ行う。
   事前に版の確認と更新条件の固定を承認範囲に含め、実HOME・CLAUDE_CONFIG_DIR・環境の条件を揃える。観測は結果分類、許可ダイアログ有無、項目更新時刻、エラー種別だけ。
   新規側が成功すれば、保持プロセスの既知の失敗との比較から回復経路の差を疑う。ただし新規側が自動refreshで保存状態を修復した可能性もあり、成功前後の項目更新日時で分ける。旧側がその時点でも失敗するかは、別の入力を承認しなければ確認できない。
   保存更新があった場合は、保持プロセス固有状態とrefresh回復を未分離と報告する。更新がなくてもキャッシュ原因が確定したとはしない。
   新規側も失敗しても失効とACLを直ちに同一視せず、エラー種別で分ける。未更新の2.1.310を確認できない場合は、無断でダウンロード・置換せず止める。
   通常操作で自動refreshが起これば保存値と既存セッションへ影響し得るため、その可能性・少量の利用量・新規試験プロセスの通常終了も含めた承認が必要。元のセッションを再起動して証拠を失わない。

2. **案1で切り分けきれない場合、helperで書き換えない正規ログイン対照を1つ。** 別の新規試験dirへ14を正規/loginし、switchもfeedbackも行わず、同程度の待機後に短問を1回だけ行う。
   1台・同じ版・同じアカウントで、helperによる復元の有無を分ける。正規対照だけ自然に更新/復帰できれば、単純な同時利用禁止より外部書換え経路の疑いが上がる。
   新規/login、待機、通常操作に伴う自動更新は現在の承認外として扱い、本番/既存試験の同アカウントへサーバー側影響があり得ることも含めて事前承認を得る。値やtoken hashは比較しない。
