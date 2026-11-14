# Credential lane helper (experimental)

Node 22 以上の標準モジュールだけを使う、macOS の試験用ヘルパーです。既存の Rotator からは呼ばれません。通信・トークン更新・ポート待受は行いません。

## ファイル

- `cli.js`: `status` / `import --account` / `switch --to` と、固定形式の出力。
- `helper.js`: 移動、論理的な所有権、世代、監視、隔離。
- `safety.js`: 明示的な有効化、外部設定、パス検査、安全な例外、atomic write。
- `adapters.js`: 保管場所のインターフェース、macOS アダプタ、故障を注入できるメモリアダプタ。
- `test/helper.test.js`: 実 Keychain を使わない自動テスト。

## 外部設定

設定 JSON はリポジトリの外に置きます。以下は形を示す例であり、山括弧の値は実際の試験用パス・計算結果・OS ユーザー名に置き換える必要があります。設定ファイルや実際の口座情報をこのリポジトリに追加しません。

```json
{
  "lane": {
    "dir": "<absolute-lane-directory>",
    "service": "Claude Code-credentials-<eight-lowercase-hex-digits>"
  },
  "initialAccount": "alpha",
  "accounts": {
    "alpha": {
      "sourceDir": "<same-lane-directory>",
      "sourceService": "<same-lane-service>",
      "vaultService": "caseG-T1-vault-alpha"
    },
    "beta": {
      "sourceDir": "<absolute-source-directory>",
      "sourceService": "Claude Code-credentials-<computed-source-suffix>",
      "vaultService": "caseG-T1-vault-beta"
    }
  },
  "acct": "<OS-user-name-matching-USER>",
  "trialDir": "<absolute-trial-state-directory>",
  "ledgerPath": "<trial-state-directory>/ledger.json",
  "logPath": "<trial-state-directory>/events.jsonl",
  "marginMs": 1800000,
  "watchMs": 120000,
  "pollMs": 1000
}
```

`service` / `sourceService` は `src/claude-keychain.js` の計算結果と照合します。絶対パスの NFC 正規化後の SHA-256 先頭8桁です。レーンと取り込み元には既存の `.claude.json` が必要です。各フォルダは実在する本人所有のフォルダとし、祖先を含むシンボリックリンクは拒否します。macOS の一時フォルダを指定する場合も canonical path を使います。

パスを resolve / normalize した字句で、OS が返す本人のホームと環境変数 `HOME` の両方の `.claude` 配下・`.claude.json`・`.config/claude-rotator` 配下を先に拒否します。ここで拒否したパスには lstat / realpath / open を呼びません。設定から導く `.claude.json` のパスも、フォルダを検査する前に同じ検査を通します。通ったパスだけをファイルシステムで検査し、realpath の結果も再確認します。各 fs 関数は注入可能で、禁止パスに対する呼び出し0回を偽関数で検証します。

`initialAccount` を最初に import します。通常は、その口座の取り込み元を既存レーン自身にします。別フォルダを指定する場合は、その認証情報と `oauthAccount` がレーンと完全一致する必要があります。別ログインで得た異なる世代を同じラベルとして自動的に結び付けません。他の取り込み元は、それぞれ異なるフォルダでなければなりません。

`ledgerPath` と `logPath` は `trialDir` 直下の異なるファイルです。ジャーナルは同じ場所の `journal.json`、ロックはレーン内の `.caseg-t1.lock` に固定します。既存の台帳・ログ・ジャーナルは本人所有の通常ファイル、リンク数1、0600を要求します。新規ファイルも0600で作り、同じフォルダの一時ファイルを fsync して rename し、親フォルダも fsync します。

時間はすべて正整数のミリ秒です。省略時は余裕30分・監視120秒・間隔1秒です。外部設定では `marginMs >= 1800000`、`watchMs >= 60000`、`pollMs >= 1000` を強制し、`pollMs <= watchMs < marginMs` も必要です。下限未満は乾いた実行でも拒否します。短い値はライブラリの `testTiming` と注入した `MemoryStore` の組み合わせに限り、CLI のフラグ・設定では選べません。これらの値は自動調整しません。

## 操作の形

以下は将来の承認済み実機試験で使う構文です。この実装作業では実行していません。`TRIAL_CONFIG` は外部設定の絶対パスを持つ変数です。

```sh
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js status --config "$TRIAL_CONFIG"
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js import --account alpha --config "$TRIAL_CONFIG"
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js import --account alpha --config "$TRIAL_CONFIG" --apply
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js import --account beta --config "$TRIAL_CONFIG" --apply
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js switch --to beta --config "$TRIAL_CONFIG" --apply
CASEG_PROTO_ENABLE=1 node experiments/caseG-t1/cli.js switch --to alpha --config "$TRIAL_CONFIG" --apply
```

環境変数と外部設定の両方がなければ拒否します。`USER` がない・設定の `acct` と異なる場合も拒否します。`--apply` のない import / switch は計画だけを返し、Keychain の生成・値の読取・ファイル書込を行いません。`status` は値を読まず、検査済み台帳と項目の存在・更新時刻、台帳との差を表す真偽値 `laneTimestampMismatch` を返します。台帳がまだなければ比較せず false です。

`status` は属性を集める前後にロックを検査し、応答直前にもジャーナルと台帳を再確認します。同時操作が始まった場合や台帳の世代が変わった場合は、混在した結果を返さず拒否します。status のためのファイル書込は行いません。

実機試験では、監視終了後も出ていった口座の認証情報の期限をまたいで `status` を実行します。`laneTimestampMismatch` が true なら予定外の書き戻しの手掛かりです。同じ更新時刻のままの変化は status では検出できないため、false だけで異常なしとは判断しません。

import は認証 JSON と `oauthAccount` を保管項目内の包みに保存し、台帳に `sourceConsumed: true` と `sourceOwner: "source-consumed"` を記録します。その後に元から認証値や表示情報を読み直しません。**元の項目は削除しない論理的な移動です。** 元の Claude Code を閉じ、取り込み後はそのフォルダで再起動しないことが運用の前提です。ヘルパーが他の Claude Code の起動を禁止することはできません。

## 切り替えと停止

試験の前提として、出ていく側の Claude Code が入力待ちで、通信していない状態で切り替えます。この区切りの確認だけで背景 refresh を排他できるわけではありません。

1. レーン単位の O_EXCL ロックを取得します。PID・開始時刻を記録し、古いロックも自動解除しません。
2. レーンの現在値を、台帳で現在 `lane` を持つ口座の保管項目の `credential` と比較します。これは前回の switch で入ってきた口座の控えであり、前回出ていった口座の控えではありません。不一致は更新時刻が同じでも R8 の疑いとして隔離・停止します。更新時刻と表示情報の一致も確認し、両口座の `expiresAt` が現在時刻＋余裕より後であることを要求します。
3. レーンの現在値と表示情報を、出る口座の保管項目へ控えます。レーンの値・更新時刻、入る口座の保管値・更新時刻を再比較し、書く直前にもレーンを比較します。
4. アダプタ内でも書込直前の属性を比較し、変化が見えていれば上書きせず隔離へ進みます。書込前後の更新時刻を返し、直後の読取時刻との余分な変化も照合します。入る口座の認証 JSON を書いた結果は、値を読み返して真偽だけで確認します。次にレーンの `.claude.json` の `oauthAccount` だけを差し替えます。内容が最初の読取時点から変わっていれば停止します。他のキーは保持します。表示と認証の差し替えの間は、値を含まない開始・終了イベントを記録します。
5. 監視のポーリングは属性だけを読み、認証値（`-w`）を読みません。属性の変化・削除が見えたときと最後の確認で値を読みます。最後の確認では同じ時刻のまま値が変わった場合も検出します。R8 の疑いで停止するときは、検出に使った読取値をメモリから `caseG-T1-vault-quarantine-<16桁時刻>` へ先に保存します。次の再読取値が違えば別の隔離項目へ保存し、削除されていても先に検出した値を失いません。関係するラベルを要確認にし、自動的には戻しません。次の switch でも現在の口座の控えとの値・更新時刻の比較を行います。
6. 成功時に所有権と管理用世代番号を確定します。世代番号はサーバーの refresh token 世代を意味しません。レーン口座の保管項目は復旧用の控えとして残りますが、台帳が `lane` を持ち主にしている間は切り替え元として利用できません。

各段の前に、値なしのジャーナルを書きます。途中停止・隔離失敗・比較失敗でも自動復旧せず、未完了ジャーナルがある次の起動は status を含めて拒否します。壊れた台帳も拒否します。人がレーン・保管・隔離項目の持ち主を確認するまで、ロックやジャーナルを消して再試行しないでください。自動解除・復旧コマンドはありません。

秘密の値・値のハッシュ・`oauthAccount` は出力や記録に使いません。認証値はメモリと保管アダプタ内だけに置きます。例外は固定コードに置き換え、元の例外・子プロセスの出力・JSON パーサーの詳細を転送しません。

## アダプタと検証

インターフェースは `attributes(service) -> { exists, updatedAt }`、`read(service) -> string`、`write(service, string, { expectedUpdatedAt }?) -> { written, beforeUpdatedAt, updatedAt }` です。メモリアダプタは値をファイルに保存せず、`before(operation, service)` で故障や外部更新を注入できます。`fixedUpdatedAt` は秒単位の同じ時刻を模し、`beforeCommit(service)` はアダプタ内の最後の比較と書込の間へ更新を入れます。呼び出し履歴にも値は記録しません。

故障注入後は、取り込み済みの各口座の最新値がレーン・保管・隔離のいずれかに完全一致で残ることを共通の確認で検査します。次の「残る限界」で示す、観測できない更新が失われることを固定したテストだけは例外として明示しています。

実アダプタは `/usr/bin/security` を `execFile` で直接呼びます。書く値は `security -i` の標準入力に16進化して渡し、argv に載せません。標準出力・標準エラーは外へ転送しません。テスト実行中は生成時・各操作の前に例外にします。

```sh
node --import ./fixtures/service-command-guard.js --test experiments/caseG-t1/test/helper.test.js
npm run check
```

実 Keychain、Anthropic API、Claude Code への追従や計上先の実機確認は行っていません。**ACL と確認画面なしで Claude Code が読めるかは要確認です。** 属性の解析は模擬出力で検証したもので、実機の出力形式も要確認です。

## 残る限界

外部の Claude Code はこのロックを共有しません。アダプタ内の最後の比較直後から実際の書込までに更新が入ると、その値を一度も読めないまま上書きし、出ていく口座の最新世代を失いうる状態が残ります。偽アダプタでこの窓へ更新を注入し、切り替えが成功を返しても最新世代が残らないことを、限界を示す名前のテストで固定しています。書込前後の時刻がそれぞれ一度ずつしか観測できない場合、その間の余分な更新を数えることもできません。

JSON の最後の比較から rename までの競合窓、同じ秒のうちに値が変わって元へ戻る動き、最後の確認後から台帳の確定までの更新も完全には検出できません。隔離では検出値と一度の再読取値を保存しますが、その後に続く未観測の更新や、隔離先自体が書けない故障まで保存を保証するものではありません。ロック・比較・監視・控えはリスクを減らし、検出したら停止するための仕組みであり、R8 の完全排除や本番利用の根拠ではありません。
