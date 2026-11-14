# 案G：実機評価手順（承認用・2026-10-27）

## 0. 実行の境界

実行担当はGrok Bot、ログインと許可判断は坂根さん。Codexは実Keychain接続・実機実行・ログイン・書込・削除・送信を行わない。
20:53に内部メモリでの資格情報取扱い、少量の使用量消費、試験アカウントのトークン無効化に伴う再ログインは許容済み。
22:14の追加依頼でSecurity.frameworkバックエンドとdriverのソースを実装した。この手順を坂根さんが承認した後にだけ実行する。
**食い違いゼロは保証できない。** Keychainの読取→比較→更新は他プロセスに対する原子的CASではなく、JSON・キャッシュ・refreshとの競合も残る。
Claude Code内部ロックの互換実装はない。driverの排他はdriver自身だけを対象とする。
`--idle --source-inactive --allow-uncoordinated` は人が条件を確認した印で、クライアントを自動停止・検証する機能ではない。

## 1. 対象と禁止事項

新しい `/private/tmp/credential-switch-...` root内の `live`（開始時14）と `alternate`（15）に対応するハッシュ付き2項目だけを扱う。
本人がプール14/15の対応を管理情報と正規ログイン画面で確認する。Rotatorのプール保存ファイルを読まない。
既定項目、`~/.claude`、`~/.claude.json`、稼働Rotator、37891、`~/.config/claude-rotator` は除外する。
認証要求の自作、ヘッダー・UA・本文の改変、制限迂回、ACL変更、本番変更、既存プロセス停止、push・デプロイをしない。
録画、xtrace、tee、script、debug/verbose、Node inspector、heap/core dump、HTTP本文収集を使わない。
`security ... -w`、`-g`、dump-keychain、パスワード表示を使わない。既存lab-funcs.zshは変更・sourceしない。

## 2. driverの操作

| コマンド | 実処理 |
| --- | --- |
| prepare | 新しい0700 rootと試験dir、非機密scope.jsonを作る |
| check | 2項目の存在を確認。両方不存在なら非機密preflight.jsonを保存 |
| serve | 専用Swift子プロセスと0600 Unix socketを開始。vaultはメモリだけ |
| register | liveの14と不稼働の取込元15を登録 |
| switch | liveの認証とoauthAccountを切替。共有フィールドを保持 |
| observe | 値変化とidentity一致の真偽だけを返す |
| close | メモリを解放。専用子プロセス終了後にsocketと排他を解除 |
| cleanup | 指定した完全一致サービス名1つを削除 |

既定はdry-run。`--dry-run`は計画表示だけでファイル作成・socket接続・native process起動・Keychain参照を行わない。
手順の起動用関数は、その前に実HOMEの所有者・実パスをメタデータで照合する。
実処理には毎回 `--execute --approve caseg-<rootのbasename>-approved` が必要。
これは手順確認用の公開合言葉であり、秘密情報や他ユーザーに対する認証ではない。環境変数で有効化しない。
資格情報はSwift/Node間の専用fd3/fd4だけを通り、通常のstdout/stderr、argv、env、ファイル、制御socketには出さない。

## 3. 変数定義（以下すべて未実行）

承認範囲は短い通常操作を各方向1回程度、自然なrefresh、最小feedback1件、試験2項目の削除。100セッションや自動使用量切替は含めない。
初回ターミナルで次を定義する。rootはまだ作成しない。別ターミナルでは生成した同じroot文字列を設定し、uuidgenをやり直さない。

```zsh
set +x
umask 077
ulimit -c 0
LAB_REPO='$HOME/develop/project/claude-rotator/caseG-proto-20261027'
LAB_ROOT="/private/tmp/credential-switch-20261027-$(/usr/bin/uuidgen)"
LAB_NODE="$(command -v node)"
LAB_APPROVAL="caseg-$(basename "$LAB_ROOT")-approved"
lab_driver() {
  local trial_home
  trial_home="$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$LAB_NODE" "$LAB_REPO/bin/credential-switch-user-home.js")" || return 1
  /usr/bin/env -i HOME="$trial_home" TMPDIR=/private/tmp/ \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$LAB_NODE" "$LAB_REPO/bin/credential-switch-lab.js" "$@" --root "$LAB_ROOT"
}
```

ターミナル間で上の4変数と関数を揃える。秘密値は設定しない。
HOMEはos.userInfo().homedirから取得し、/Users/直下・realpath一致・実行ユーザーとの所有者一致を検証した実HOMEを使う。
環境変数HOMEの値を信用して決めない。実HOMEの設定ファイルをコピー・編集せず、CLAUDE_CONFIG_DIRによる試験dir分離は維持する。

## 4. 準備・ビルド・初回不存在確認

```zsh
lab_driver prepare --dry-run
lab_driver prepare --execute --approve "$LAB_APPROVAL"
```

dry-runの合言葉と項目名が承認対象と一致し、実処理がpreparedになったことを確認する。既存rootを上書きしない。
承認後のGrok Botが次を実行する。コンパイル自体はKeychainへ接続しない。ビルド失敗なら後続へ進まない。

```zsh
/usr/bin/swiftc -parse-as-library \
  "$LAB_REPO/native/LabKeychainCore.swift" "$LAB_REPO/native/LabKeychainMain.swift" \
  -module-cache-path "$LAB_ROOT/tmp/swift-cache" -o "$LAB_ROOT/tools/keychain-helper"
chmod 700 "$LAB_ROOT/tools/keychain-helper"
lab_driver check --dry-run
lab_driver check --execute --approve "$LAB_APPROVAL"
```

最初のログイン前にreadyかつ両方present:falseを確認する。既存項目、複数候補、許可拒否なら中止し、既存項目を再利用しない。
initは既定Keychainを取得でき、ロックされていないことを値なしで確認する。取得不能・状態取得失敗・ロック中はunavailableで拒否する。
ロック解除・作成・既定Keychain変更は行わない。旧版の空HOMEで得たpresent:falseは有効な不存在確認として扱わず、新しい試験rootでやり直す。
初回不存在確認なしではserve/register/switch/cleanupを行えない。dry-runのcheckは実際の不存在確認ではない。

## 5. 正規ログインと保持セッション

次で15を起動し、坂根さんが正規/loginを行う。Grok Botはパスワード・認証コード・トークンを読まない。
本人が/status・/usageで15と確認後、15の試験セッションだけを本人が通常終了する。
background sessionが残るなら不稼働と再開されないことを確認できるまで進めない。pkill、killall、/logoutを使わない。

```zsh
lab_start_trial() {
  local trial_config trial_home trial_binary
  case "$1" in
    14) trial_config="$LAB_ROOT/live" ;;
    15) trial_config="$LAB_ROOT/alternate" ;;
    *) return 1 ;;
  esac
  trial_home="$(/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin \
    "$LAB_NODE" "$LAB_REPO/bin/credential-switch-user-home.js")" || return 1
  trial_binary="$trial_home/cc-g-tools/claude-2.1.310"
  test -x "$trial_binary" && test -d "$trial_config" || return 1
  (
    cd "$LAB_ROOT/work" || exit 1
    /usr/bin/env -i HOME="$trial_home" TMPDIR="$LAB_ROOT/tmp/" \
      PATH=/usr/bin:/bin:/usr/sbin:/sbin TERM=xterm-256color \
      CLAUDE_CONFIG_DIR="$trial_config" "$trial_binary"
  )
}
lab_start_trial 15
```

15の不稼働を確認後、同じ関数でlab_start_trial 14。本人が14へ正規ログインし、セッションを保持する。
BASE_URL、AUTH_TOKEN、API_KEY、OAuth token、ASSUME_FIRST_PARTY、シェルや本番settingsは継承しない。
管理設定が別の認証先を強制すれば中止し、設定を変更して通さない。
fallback .credentials.jsonができれば内容を開かず中止。metadataは各dir内の.claude.jsonに限定し、違う保存先なら既定ファイルを探さず止める。

## 6. 常駐driverと登録

別ターミナルBで同じ変数と関数を定義して、次をforegroundで実行する。秘密値を保存しないため、このプロセスを保持する。

```zsh
lab_driver serve --dry-run
lab_driver serve --execute --approve "$LAB_APPROVAL"
```

serving後、ターミナルCで次を実行する。毎回、保持側ターン終了・15の取込元不稼働を人が確認する。

```zsh
lab_driver register --dry-run
lab_driver register --execute --approve "$LAB_APPROVAL" \
  --idle --source-inactive --accounts-confirmed --allow-uncoordinated
```

registeredでなければ中止。重複identityも拒否するが、token所有者の暗号学的な証明ではないため本人確認を省略しない。
取込元15は以後再起動しない。Keychain許可は、対象のハッシュ付き項目とhelperを確認できる場合だけ本人が単発許可する。
不明・既定項目・別プログラムなら拒否。「常に許可」、ACL変更、全アプリ許可、sudo回避を使わない。
記録は項目名・有無・回数・単発許可/拒否だけ。[Appleの説明](https://support.apple.com/guide/keychain-access/kyca1243/mac)

## 7. 切替・観測・自然なrefresh

```zsh
lab_driver switch --slot 15 --dry-run
lab_driver switch --slot 15 --execute --approve "$LAB_APPROVAL" \
  --idle --source-inactive --allow-uncoordinated
```

switched後、同じ保持セッションを再起動せず/status・/usageを開き直す。0・3・10・30・60秒で、それぞれ14/15/不明と経過秒を記録。
60秒で揃わなければ中止し、再ログインで結果を上書きしない。両方15なら、承認した短い通常操作を1回だけ行う。
例：「検証です。OKの1語だけ返してください。」

```zsh
lab_driver observe --execute --approve "$LAB_APPROVAL" \
  --idle --source-inactive --allow-uncoordinated
lab_driver switch --slot 14 --execute --approve "$LAB_APPROVAL" \
  --idle --source-inactive --allow-uncoordinated
```

復帰後も同じ指標を確認する。observeはcredentialChangedとidentityMatchesの真偽だけを返し、値・UUID・token hashを返さない。
表示や通常操作成功だけでは実際の課金先を断定しない。切替直前の最新値はメモリへ取り込み、古い取込元から上書きしない。
自然なrefreshは承認した時間内、1分間隔程度のobserveで評価。helperはrefresh endpointを呼ばず、期限改ざんやログイン強制をしない。
値変化後の認証失敗・再ログイン要求を分類だけ記録する。変化がなければ未検証で、衝突ゼロや100セッションへ一般化しない。

## 8. /feedbackの直接送信

坂根さんが送信内容と添付範囲を承認後、Grok Botが標準UIで実施する。driverとCodexは送信しない。
正規claude.aiログイン、BASE_URLなしの直結構成を確認して/feedbackを開く。
文面：「隔離試験環境からのフィードバック送信確認です。本番データは含めていません。」
添付は無害な試験会話の必要最小限。資格情報、設定ダンプ、ログ全文、実アカウント名、メモリを添付しない。
安全な添付を選べなければ未実施とする。ローカルbundleと送信成功は区別し、ローカル保存なら止める。
公式文書は同意・会話等の添付を説明し、取得時はfeedback transcriptを5年保持としている。2.1.310とUIが違えば推測で送信しない。
[コマンド](https://code.claude.com/docs/en/commands)、[データ利用](https://code.claude.com/docs/en/data-usage)
記録は直結構成とUIの送信成功/失敗/ローカル保存/未実施だけ。通信本文を収集しないため経路の独立した証明ではない。

## 9. 停止・復帰・片付け

対象外、fallback、symlink、複数候補、不明な許可、名義/usageの不一致、再ログイン要求で即中止。
rejected/blocked/failed/recovery_required/unavailableも中止。busy/deferredなら追加要求を止め、無制限に再試行しない。
値が出た/出そうなら記録を止め、分類だけ報告し、値やraw errorを貼らない。
正常時は7章のswitch14で戻す。古いtokenの復元ではない。回復必須・クラッシュ・再ログイン要求なら自動復元せず、本人が試験dirで正規ログインする。
本番は無変更なので本番への復元コマンドは不要。古い取込元から再取込しない。試験Claude Codeを本人が通常終了した後、closeする。

```zsh
lab_driver close --execute --approve "$LAB_APPROVAL"
```

ターミナルBのserveが自然終了するまで待つ。専用子プロセスが許可待ちなら追加操作せず、本人がダイアログを取り消す。
異常終了で.driver-lockやsocketが残れば自動削除・奪取しない。cleanupは拒否するため状態を報告して止める。
JS/Swift文字列やOSのメモリ管理の確実なゼロ消去は保証しない。ダンプを作らない。
削除名は準備時の完全名と照合する。次の算出値がその2つと一致することを確認する。秘密値ではない。

```zsh
LAB_SERVICE_14="$(python3 -I - "$LAB_ROOT/live" <<'PY'
import hashlib, sys
print('Claude Code-credentials-' + hashlib.sha256(sys.argv[1].encode()).hexdigest()[:8])
PY
)"
LAB_SERVICE_15="$(python3 -I - "$LAB_ROOT/alternate" <<'PY'
import hashlib, sys
print('Claude Code-credentials-' + hashlib.sha256(sys.argv[1].encode()).hexdigest()[:8])
PY
)"
printf '%s\n%s\n' "$LAB_SERVICE_14" "$LAB_SERVICE_15"
lab_driver cleanup --slot 14 --service "$LAB_SERVICE_14" --dry-run
lab_driver cleanup --slot 14 --service "$LAB_SERVICE_14" --execute --approve "$LAB_APPROVAL" --sessions-exited && \
lab_driver cleanup --slot 15 --service "$LAB_SERVICE_15" --execute --approve "$LAB_APPROVAL" --sessions-exited
```

各結果がdeleted/absentでなければ次へ進まない。prefix/wildcard削除はなく、未登録名や曖昧な複数項目は拒否する。
一意なサービスを確認後、Security.frameworkのpersistent referenceで対象を特定して削除する。試験rootのファイルは自動削除せず残す。

## 10. 記録・検証と限界

記録は版・承認日時・14/15/不明・経過秒・成功/失敗/未実施・差分の真偽・許可ダイアログの有無/回数/対象名だけ。
メール、UUID、認証値、token hash、JSON、画面コピー、HTTP内容を記録しない。保存成功・表示・usage・実操作・課金先の確証を分ける。
規約未確認事項は設計メモ参照。今回の承認は規約適合性や本番利用の承認ではない。
Swift coreはscope/所有者/権限/symlink/fallback/サービス名/項目一意性を検証し、値のデータだけを更新する。
実機では許可ダイアログ、API照合、直接書換え後の追従、refresh競合、子プロセス終了待ちを初めて確かめる。
通常ビルドの実Keychain可用性チェックは未実行。テストはfake Security store、fakeパイプ/Keychain、一時dirだけ。
コンパイル済みinit往復では、ビルド時に可用性検査だけをInitOnlyItemsへ差し替え、全ての項目操作を拒否する専用test buildを使う。
対話I/O・scope検証・5秒以内応答は実行するが、実Keychainを取得したり状態を照会したりしない。
通常ビルドにこの差し替えはなく、argv・env・要求フレームから検査をスキップできない。
SecKeychainCopyDefault/GetStatusはmacOS SDKでdeprecated警告が出る公開API。既定Keychainの値なし確認に限定し、通常ビルドはコンパイルのみで確認する。
[既定Keychain取得](https://developer.apple.com/documentation/security/seckeychaincopydefault(_:))、[状態取得](https://developer.apple.com/documentation/security/seckeychaingetstatus(_:_:))
全体チェックとCIはDocker接続不可が未解決のため未実行。個別検証の実数は設計メモと報告に記載する。

## 11. 22:14追加依頼に伴う変更点

- Security.framework core/main、専用fdのNode bridge、操作driver/CLIを追加し、仮のAPI操作案を具体的なコマンドへ置き換えた。
- 試験ごとの公開合言葉、明示execute、既定dry-run、初回不存在確認を追加した。資格情報を保存するファイルは作らない。
- 未確認の共有ロックを前提にする記述を撤回し、単一保持セッション・手動idle・取込元不稼働・未協調実験の明示確認にした。
- 標準CLIでの削除案をdriverの完全一致指定とpersistent referenceによる削除へ置き換えた。
- 実機実行は引き続き手順承認後にGrok Botが行い、Codexは行わない。
- 10/29 19:50承認：driverのmetadata読取上限を1 MiB（1,048,576 bytes）へ変更し、scope.json/preflight.json等の制御ファイルは64 KiBを維持。境界テストを追加。
- 10/30承認：observeにusable（残存30秒超）とexpiryState（expired／5分未満under_5m／5分以上ok／判定不能unknown）を追加。値・期限時刻は非公開、既存の差分・identity判定とobserve-loop停止条件は変更しない。

## 12. 10/29 17:16承認の不具合修正2

- 空の試験HOMEを渡す指定を撤回し、検証済みの実HOMEをlab_driver、lab_start_trial、native子プロセスへ渡す。
- HOME検証は共通のNode関数と小さなCLIを使い、/Users/直下・realpath・所有者の不一致を起動前に拒否する。
- initで既定Keychainの取得とunlocked状態を確認する。項目照合前、および不存在応答前も可用性を確認し、利用不能を不存在にしない。
- 存在照合のサービス名/参照方式は変更せず、解除・作成・既定変更・項目値の確認を追加しない。
- 古い空HOMEでの不存在確認は破棄し、新しいrootで正常なcheckから再評価する。Codexは実Keychainの操作を行わない。

## 13. register失敗時の段階診断（10/29 18:45依頼）

registerは14、次に15の順で認証情報とmetadataを読み、メモリへ登録する。Keychain/JSONへの保存やCASは行わない。
failed時は、固定された段階名だけをstageへ追加する。例は `{"status":"failed","stage":"capture_15_metadata_read"}`。
14/15は固定のプールslot表示で、UUID・メール・項目値・raw error・パス・Keychain OSStatusは含めない。

段階の意味：keychain_read＝native読取/応答、credential_bytes/json/fields＝取得形式と必須字段、
metadata_read＝試験metadataの読取・ファイル検証・JSON/禁止キー検査、identity_validate＝identity形式、
coordination/authorization/turn_boundary＝排他・試験scope/手動確認・ターン境界、profile_store＝メモリ登録。
registration_state＝switchでcontroller作成後など、再登録を受け付けない状態。従来failedに丸められていた別経路も区別する。
いずれも `capture_14_...` または `capture_15_...` の固定allowlistのみを出力する。
重複identityや期限切れは従来どおりunavailableであり、failedの段階診断とは区別する。
新規serve・初回register・switch未実施であればregistration_stateは該当しないが、一般のfailedから一律に除外はしない。

約24秒という時間だけでタイムアウトとは判定しない。実装上のnative要求タイムアウトは60秒、socket往復は65秒。
単発許可後でも、もう一方の項目の許可状態や、取得後のJSON/metadata検証の成否までは証明しない。
serve生存中の.driver-lockとcontrol.sockは通常残る。削除したり他のプロセスを停止したりしない。

既に稼働しているserveは変更前のモジュールを保持しており、ファイル更新だけでは診断が反映されない。
次回、Grok Botが手順を確認してから試験serveへの変更反映とregisterの1回の実行を判断する。
返却されたstatusとstageだけを共有し、.claude.jsonの中身やraw errorを読む・貼る必要はない。今回Codexは再試行・起動・停止・試験root変更をしない。
