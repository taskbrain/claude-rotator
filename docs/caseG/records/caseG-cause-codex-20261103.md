**1. 結論**

- **10/30 12:31の「Not logged in」：原因は未確定です。** 最有力候補は、切替後の保持プロセスが認証を再取得できず、期限経過後のrefreshでも回復できなかったことです。**確度：中、推測。** 切替とrefreshが実際に衝突した証拠はありません。[経過・留保：報告15〜25行]($HOME/grokbot-send/caseG-notloggedin-report.md:15)
- **新規起動時のAPI Usage Billing／loggedIn false：USERによるKeychain検索先の違いが最有力候補です。確度：中、推測。** 試験2ではUSERだけを変えて結果が反転していますが、試験1の該当起動・確認コマンドが資料にないため、同じ原因とは断定できません。[試験2の比較：3〜7行]($HOME/grokbot-send/caseG-test2-day3.md:3)

**2. 仮説の評価**

| 仮説 | 根拠（ファイル：行） | 確度・事実／推測 |
|---|---|---|
| **(a) 切替とrefreshの衝突** | driverの排他は内部だけで、Claude Codeを停止しません。[driver:134〜149]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-driver.js:134)。nativeの比較→更新も他プロセスに対して非原子的です。[Swift:81〜89]($HOME/develop/project/claude-rotator/caseG-proto-20261027/native/LabKeychainCore.swift:81) | **競合し得る構造は高・事実。今回衝突した説は低・推測。** 更新日時は20:01のままで、refresh拒否の直接記録もありません。[報告:36、54〜59]($HOME/grokbot-send/caseG-notloggedin-report.md:36) |
| **(a) refresh tokenが一回きりで、古いコピーを再利用** | 同じ系列の複製・rotation・invalid_grantはいずれも未確認。[報告:95〜96]($HOME/grokbot-send/caseG-notloggedin-report.md:95)。テストの「refresh」は擬似値の手動置換です。[テスト:156〜168]($HOME/develop/project/claude-rotator/caseG-proto-20261027/test/credential-switch-helper.test.js:156) | **低・推測。記録から使い捨て仕様とは言えません。** |
| **(b) USER／acctの不一致** | 試験2ではUSERなしでtrue、通常シェルとUSER追加でfalse、項目のacctはunknown。[day3:3〜7]($HOME/grokbot-send/caseG-test2-day3.md:3) | **試験2の観測は高・記録上の事実。試験1の新規起動への適用は中・推測。** 同じ環境で保持された画面が時間経過後に失敗した理由としては弱いです。 |
| **(c) コピー本体と通常本体の差** | 試験1の起動指定は`cc-g-tools/claude-2.1.310`。[lab-env:25〜31]($HOME/grokbot-send/lab-env.zsh:25)。試験2の/statusはv2.1.314。[day3:9]($HOME/grokbot-send/caseG-test2-day3.md:9) | **起動指定の違いは高・事実。原因説は低・推測。** 環境と版を揃えた比較がありません。 |
| **(d) helperとClaude Codeの検索条件・書込方法の差** | helperはサービス名で検索し、acctを指定しません。更新対象もデータだけです。[Swift:109〜142]($HOME/develop/project/claude-rotator/caseG-proto-20261027/native/LabKeychainCore.swift:109) | **高・実装上の事実。** helperが読めても、USERの異なるClaude Codeが読める証明にはなりません。明示的なacct・ACL書換えはありません。 |
| **(d) CONFIG_DIR・ハッシュ・認証環境変数・ファイルfallback** | サービス名はCONFIG_DIR文字列のSHA-256先頭8桁から生成。[実装:5〜11]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/claude-keychain.js:5)。起動関数はenv -iでANTHROPIC_*を継承しません。[lab-env:29〜31]($HOME/grokbot-send/lab-env.zsh:29)。報告時の.credentials.jsonは不存在。[報告:41]($HOME/grokbot-send/caseG-notloggedin-report.md:41) | **構造・記録は高・事実。今回の原因説は低・推測。** 該当する新規起動の実環境は不明です。 |

試験1のUSERについて、**15初回・14初回・再起動を`lab_start_trial`経由で行えば、すべてUSERなし**です。現行関数にもバックアップにもUSER指定はありません。ただし、各回に実際に使ったコマンドの記録はなく、新規起動と`auth status`の実際のUSER有無は確定できません。[現行:16〜31]($HOME/grokbot-send/lab-env.zsh:16)、[バックアップ:14〜26]($HOME/grokbot-send/lab-env.zsh.bak-20261029:14)

なお、今回の`ls -l ~/.local/bin/claude`では通常本体のリンク先は**2.1.316**でした。11/2のv2.1.314という記録とは時点が異なります。実行による版確認はしていません。

**3. 補助プログラムの切替手順**

`register`は、liveの14とalternateの15から、Keychain内の`claudeAiOauth`と各設定ファイルの`oauthAccount`を読み、メモリへ登録します。

`switch`は、活動中のliveの最新状態をメモリへ退避し、切替先のメモリ上の認証を**liveの既存Keychain項目**へ書き、その後live設定の`oauthAccount`を更新・照合します。alternateへの書戻しやhelper自身によるrefreshはありません。[helper:129〜160]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch-helper.js:129)、[切替:77〜96]($HOME/develop/project/claude-rotator/caseG-proto-20261027/src/credential-switch.js:77)

**4. 再発を避ける切替方の候補**

- **アカウントごとに別CONFIG_DIRで正規ログインを維持し、使用するプロセスを選ぶ方式。** 認証コピーの上書きをなくし、helper書込とrefreshの競合を避けます。同じ保持セッションの無再起動切替という要件は変わります。[設計:53〜57、128〜139]($HOME/develop/project/claude-rotator/caseG-proto-20261027/docs/specs/caseG-credential-switch-設計-20261027.md:53)
- **同じCONFIG_DIRを使い直すなら、そのdirの全クライアントを通常終了してから正規ログインし、起動する方式。** 古い認証コピーの復元を避けます。[設計:115〜124、202]($HOME/develop/project/claude-rotator/caseG-proto-20261027/docs/specs/caseG-credential-switch-設計-20261027.md:115)

どちらもログイン・起動・`auth status`で、**USERの有無、HOME、CONFIG_DIRの文字列を統一**する必要があります。現行の手動idle確認だけでは、無再起動切替とrefreshの無競合は保証できません。

**5. 記録だけでは決められないこと**

実際の期限、refresh試行・拒否・rotation、同じ認証系列の重複使用、試験1の新規起動環境、保持プロセスのキャッシュ・読取許可、当時の実行版は未確定です。また、20:01の復帰直後に推論が成功した記録がないため、故障時刻を12:31と確定できません。

読み取りのみ実施しました。既存observeログは600行すべて差分なし・identity一致・fallbackなしでしたが、認証の有効性は証明しません。再現・テスト実行は0件です。

=== 調査おわり ===
<oai-mem-citation>
<citation_entries>
MEMORY.md:496-507|note=[prior investigation scope and observation limits, rechecked against current files]
</citation_entries>
<rollout_ids>
01a17cfe-9754-79b2-bc8d-8c40dca2ad70
</rollout_ids>
</oai-mem-citation>
