# 試験用の限定プロキシ

Node 22以上の標準モジュールだけで動く、既定無効の試作。既存のプロキシや設定・状態を共有しない。
この実装を作る作業では、実サービスへの接続・Keychainの読取・CLIの実起動を行わない。

設定はリポジトリの外に置くJSONとし、秘密の値を入れない。

```json
{
  "logPath": "<外部のログファイルの絶対パス>",
  "swapAccount": {
    "configDir": "<更新を担当するClaude Codeのフォルダの絶対パス>",
    "service": "Claude Code-credentials-<フォルダ名から算出した8桁の小文字hex>",
    "acct": "<起動時のUSERと同じ値>",
    "keychainPath": "<読むKeychainファイル1つの絶対パス>",
    "keychainAllowlist": ["<許可するKeychainファイルの絶対パス>"]
  },
  "expiryMarginMs": 300000,
  "timeoutMs": 30000
}
```

`service` は `src/claude-keychain.js` の `claudeKeychainServiceName(configDir)` と一致させる。
フォルダ名の表記も名前の計算に使われる。`swapAccount` はpassthroughでは省略できる。
ログの親フォルダは先に用意する。設定・ログ・口座フォルダは本番の保存先から離す。
ログを口座フォルダ内に置く指定も拒否する。
差し替え口座には `keychainPath` と明示の `keychainAllowlist` が必要で、選択先が許可リストに
含まれなければ拒否する。旧設定はこの2項目を追加するまで起動できない。ログを許可したKeychainへ置く指定も拒否する。

禁止先は、resolve・normalize後に、OSの実ホーム（`os.userInfo().homedir`）と
環境変数HOMEの両方に対して字句判定する。ここで拒否した指定にはfsを呼ばない。
通ったパスだけをrealpathで再確認する。内容を開く際も、macOSでは全階層のsymlinkを
一度に拒否する `O_NOFOLLOW_ANY`、Linuxではrootから固定したディレクトリfdを使い、
検証後に親がsymlinkへ交換されても別のファイルを読んだりログを書いたりしない。
必要なOS機能が使えない場合は停止し、通常のopenへfallbackしない。

後日の実機試験で使う形式（ここでは実行しない）:

```sh
# EXPERIMENT_CONFIG は外部設定ファイルの絶対パス。
# 設定検証だけ。ログ作成・認証読取・待受けはしない。
CASEG_PROTO_ENABLE=1 node experiments/caseG-t3/passthrough-proxy.js \
  --config "$EXPERIMENT_CONFIG" --mode passthrough

# 段1: 元のAuthorizationを維持。
CASEG_PROTO_ENABLE=1 node experiments/caseG-t3/passthrough-proxy.js \
  --config "$EXPERIMENT_CONFIG" --mode passthrough --apply

# 段1を終了してから段2を別に起動する。
CASEG_PROTO_ENABLE=1 node experiments/caseG-t3/passthrough-proxy.js \
  --config "$EXPERIMENT_CONFIG" --mode swap-messages --apply
```

CLIは `127.0.0.1:37991` だけで待ち受け、上流は `https://api.anthropic.com:443` だけ。
`--port` は37991のみ受け付け、上流・ホストを変更するオプションはない。
Claude Codeは正規ログインを保ち、起動時に `ANTHROPIC_BASE_URL=http://127.0.0.1:37991` だけを追加する。
認証用環境変数は追加しない。停止はこの試作プロセスへのSIGINT/SIGTERMで行う。

差し替えはPOSTかつWHATWG URLで正規化したpathnameが `/v1/messages` のときだけ。
対象要求は、受信Authorizationが空でない `Bearer ` 形式、Hostが `127.0.0.1:37991` または
`localhost:37991`、Originヘッダーなしの場合だけ受け付ける。テストでは注入した待受ポートを使う。
満たさなければ認証の読取や上流送信を行わず、固定本文の403で拒否する。
クエリは転送するが判定・記録から除外する。末尾スラッシュや重複スラッシュは維持し、
dot segmentは正規化する。絶対URL形式・バックスラッシュ・fragment付きの要求は拒否する。
他のパス・メソッドは元の認証で転送し、redirectは追わない。
Connectionで指定されたヘッダーを含むhop-by-hopヘッダーは両方向で除外する。

認証はserviceとacctを指定した読取専用の保管場所インターフェース経由。
実アダプタはシェルを使わず `/usr/bin/security find-generic-password -a … -s … -w <keychain>` を使う。
属性・値・再確認のすべてにKeychainファイルを渡す。値を読む前に `security list-keychains` の各検索対象へ
値なしの `find-generic-password -a … -s … <keychain>` を実行し、一致が指定先の1件だけか確認する。
複数一致・指定外の一致・読取エラーでは値を読まず停止する。値の読取後も同じ走査で再確認し、検索対象の変更・
属性が示すKeychainの不一致・更新時刻の変化を拒否する。選択先は保管場所インスタンス内でも固定し、
別の許可先への変更も拒否する。`dump-keychain` は使わない。
JSON全体は一時的にメモリへ入るが、refresh関連フィールドを捨て、保持するのはaccess token・expiresAt・更新時刻だけ。
JavaScriptの文字列を物理的に消去する保証はない。refresh・Keychain書込・保存先ファイルへのfallbackは実装しない。
更新の持ち主は口座フォルダ側のClaude Codeだけであり、このプロキシは持ち主の存在を保証しない。

期限の余裕が不足すると再読取し、期限不足・読取不能・形式不正・更新時刻またはexpiresAtの巻戻りで
差し替えを永久停止する。巻戻りは `r8_suspected` と記録する。差し替えた要求の401/403でも停止し、
その状態コード・ヘッダー・本文を渡さず、固定本文の503を返す。元の口座の認証拒否と誤認させる情報を渡さず、
再送・refresh・元の口座への代替送信もしない。以後の対象要求は503で、非対象の通信はそのまま通す。
上流の切断・無通信タイムアウトでも差し替えを停止する。ヘッダー送信前は502/504、
SSE開始後はステータスを変えられないためストリームを切断し、記録に502/504と理由を残す。
背圧は両方向のpipeで扱い、クライアント切断で上流も破棄する。

ログは0600の追記JSONL。1要求1行でtime・method・pathname・status・durationMs・swapped・
inboundAuthPresent・upstreamAuthEqualsInbound・upstreamAuthIsSwapAccountを記録する。
停止の原因がある要求には値を含まないstopReasonも付く。上流へ送らなかった場合の比較値はfalse。
差し替え口座との比較は、その時点で読み取っている有効な認証とメモリ内で行う。
未読取の非対象要求では口座の一致を証明できずfalseになる。
ヘッダー・本文・認証JSON・token・そのハッシュは記録しない。ログ障害時は試作全体を停止する。
標準出力は起動・停止・件数、およびdry-runの値なし計画のみ。標準エラーのエラーは固定文言。

自動テスト:

```sh
node --import ./fixtures/service-command-guard.js --test experiments/caseG-t3/test/*.test.js
npm run check
```

試作のテストでは、偽の保管場所と、メモリ内の双方向ストリーム上のHTTPサーバーを使う。
Node自身のHTTPパーサー・pipe・背圧・切断を通すが、OSのソケットを開かない。
実アダプタはnode:test環境では常に例外になり、実上流への接続も拒否する。
`createProxy(options)` の上流・保管場所・ポート等の注入はnode:test環境だけで許可し、
偽上流と明示の偽保管場所の両方を要求する。通常プロセスからの注入は設定読取前に拒否する。
実ホーム配下の禁止指定はfsを呼ぶ関数を偽物にして渡し、呼出し0回を検証する。
親ディレクトリの差し替え試験は、一時フォルダと無害なダミーファイルだけで行う。
TCP待受け・TLS接続・Keychain属性の実出力形式・確認画面・Claude Codeの表示・feedbackの経路・
サーバー側の計上先はこの自動テストでは未確認。再起動なしの切替も検証対象に含まない。
Keychainの走査はロックを取らない前後確認であり、並行更新に対する原子的な証明にはならない。
