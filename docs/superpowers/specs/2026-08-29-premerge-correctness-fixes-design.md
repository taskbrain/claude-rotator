# PR #33 pre-merge correctness fixes design

## 目的

独立レビューで再現された認証・routing・macOS lifecycle の6件を、既存構造内の
最小変更で修正する。新しいセキュリティ基盤や一般化された耐障害サブシステムは
作らない。

## 対象内

1. 同一 refresh token を複数 account が共有した場合の durable fence 迂回
2. token/request 共通枯渇時に利用可能な別 account へ切り替わらない問題
3. refresh intent と Linux credential commit の電源断耐性
4. reload 時に credential ownership mode が更新されない問題
5. macOS rollback 後に旧 generation の health を確認しない問題
6. `launchctl` 呼び出しを含む停止待機が実時間でboundedでない問題

## 対象外

- リポジトリ全体のセキュリティ監査
- 全JSONファイルへのfsync適用
- 新しい認証方式、DB、暗号化レイヤー、監視基盤
- account間で同一refresh tokenを安全に共有し続ける仕組み
- macOS以外のservice manager再設計

## 設計

### 1. 重複 refresh token を handoff 前に fail-closed にする

native refresh cycleを開始する前に、現在設定されているaccountのcredentialを読み、
refresh tokenのSHA-256 digestをメモリ内だけで比較する。digestやtokenはstatus、log、
errorへ出さない。

同じdigestを持つaccountが2件以上あれば、そのcycleでは該当accountをすべて
`oauth_refresh_failed`としてparkし、providerへtokenを渡さない。accountごとの
single-flightやdurable intentを複数account coordinatorへ拡張しない。設定または
credential revisionが変わって重複が解消された場合は、既存reload/reconcile経路で
再評価する。

これにより、同一rotating tokenを複数accountが同時commitする状態自体を禁止する。

### 2. token/request共通枯渇を通常のswitch対象に含める

`token_rate_limit_exhausted`と`request_rate_limit_exhausted`を、5h/7dと同じ
family-independent exhaustionとして扱う。`getActiveAccount(modelFamily)`は健全な
別accountを選び、見つからない場合だけ`null`を返す。Fable限定枯渇のrequest-local
routingとpersistent current不変は維持する。

proxy fallback判定も同じ分類関数を使い、共通枯渇中のcredentialを既知の健全な
代替先がある状態でupstreamへ送らない。

### 3. refresh境界だけdurable write/removeを使う

refresh intentとLinux credential commit専用に、次の順序を保証する小さなhelperを
追加する。

1. private temporary fileへ書く
2. file handleを`sync()`する
3. destinationへatomic renameする
4. 親directoryを`sync()`する

intent削除後も親directoryを`sync()`する。同期・rename・directory syncのいずれかが
失敗した場合は成功扱いせず、既存のunknown outcome/fail-closedへ送る。通常のconfig、
runtime status、monitor出力には適用しない。macOS Keychainの永続化方式は変更しない。

### 4. reload時のcredential ownershipを原子的に反映する

proxy server内に小さなmutable ownership stateを置き、各request/usage refreshは
固定booleanではなくその時点のstateを読む。reload callbackはaccountsとownership
modeをまとめて返し、validation完了後に同じreload commitで置き換える。

gateway overrideを検出したreloadでは直ちにlive Claude credential参照を禁止する。
gateway modeからmanual modeへの緩和は同一processでは行わず、再起動を要求して
fail-closedを維持する。reload失敗時はaccountsもownershipも部分更新しない。

### 5. rollback後に旧generation healthを確認する

macOS lifecycle変更前に、main jobが登録済みなら現在healthのservice generationを
記録する。rollbackでfileとregistrationを復元した後、旧mainが元々健康だった場合だけ、
同じbounded health checkで旧generationの復帰を確認する。

復旧healthが失敗した場合はrollback errorとして`AggregateError`へ含める。fresh installで
旧jobがない場合、または変更前からhealthを取得できなかった場合は、存在しなかった健康を
保証したとは扱わない。

### 6. `launchctl`操作全体をmonotonic deadlineで制限する

service stop/reconcile/restoreはmonotonic deadlineを1つ作り、各`launchctl`呼び出しへ
残り時間のtimeoutを渡す。poll間隔だけでなくcommand実行時間も上限に含める。

deadline超過、hung command、未解除はいずれも既存のservice errorへ変換する。
既定上限はgraceful shutdown 5秒より余裕のある15秒を維持する。テストではclock、sleep、
execを注入し、実時間sleepなしで境界を検証する。

## エラー処理

- 重複token: 該当accountだけparkし、token/digest/account secretを出力しない
- durable write失敗: provider handoff前ならrefresh中止、handoff後ならunknown outcome
- ownership mode変更失敗: 古いaccounts/stateを維持し、live credentialを許可側へ緩めない
- rollback health失敗: 元エラーと復旧エラーの両方を保持
- launchctl timeout: shared lock解放は既存`finally`に任せ、watchdogを成功扱いで再開しない

## テスト

- 同一tokenを持つ2accountでprovider exchangeが0回、両方park、secret非露出
- 重複解消reload後に通常refreshへ戻る
- token/request枯渇ごとにFable/Otherが健全accountへ切替
- durable write/removeのsync順序と各失敗時のfail-closed
- reloadでmanual→gatewayが即時禁止、gateway→manualは再起動要求
- install/uninstall rollbackで旧generation health成功/失敗
- hung `launchctl print`を含むwall-clock bounded停止
- focused test後に`npm run check`、PR CI 4 matrix、独立critical再レビュー

## 配布

修正commitをPR #33へpushし、CIと独立レビューがともにgreenになった場合だけsquash mergeする。
merge commitから新しいimmutable snapshotを作り、non-force install、generation health、
9 accounts、OAuth failure 0、refresh marker 0を確認後にpublic wrapperを切り替える。
