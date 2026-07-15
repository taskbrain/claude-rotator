# claude-rotator

Claude Code の複数アカウントをローカル proxy 経由で切り替えるためのローカル用ツールです。macOS と Linux で動作することを想定しています。

`claude-rotator` は `127.0.0.1` で Anthropic 互換 proxy を起動し、Claude Code の `~/.claude/settings.json` に `ANTHROPIC_BASE_URL` を設定します。インストール後も、Claude Code は通常どおり `claude` コマンドで起動できます。

## できること

- 通常の `claude` コマンドを変えずに、裏側で `claude-rotator` proxy を使う
- 5時間枠 / 7日枠の使用率を見て、100% 到達時に最も空いている既知のアカウントへ切り替える
- 全アカウントが利用上限に達した場合、最短 reset のアカウントを再開候補として選び直す
- `claude-rotator monitor` で各アカウントの使用率を一覧表示する
- macOS では Keychain、Linux では private permission のファイルに認証情報を保存する
- `claude-rotator uninstall` で `~/.claude/settings.json` を元に戻す

## 利用上の注意

このプロジェクトは Anthropic / Claude Code の非公式ツールです。利用しているサービス、契約、組織ポリシーの範囲内で使ってください。認証情報は各 PC のローカルにのみ保存され、リポジトリに保存・送信しない設計ですが、共有 PC や暗号化されていないディスクでは保存先の保護に注意してください。

## 動作環境

- Node.js 18.10 以上
- Claude Code がインストール済み
- macOS: LaunchAgent を使用
- Ubuntu: systemd user service を使用

認証情報は PC ごとのローカル保存です。別の Mac / Ubuntu PC で使う場合、その PC でも各アカウントの `claude auth login` と `claude-rotator login` を実行してください。

## macOS用セットアップ

このリポジトリ内で実行します。

```bash
npm install -g .
claude-rotator install
claude-rotator doctor
```

`install` は `~/.claude/settings.json` の `env.ANTHROPIC_BASE_URL` だけを更新し、変更前の状態を `~/.config/claude-rotator/install-state.json` に保存します。

macOS では次の LaunchAgent が作られます。

```text
~/Library/LaunchAgents/io.github.claude-rotator.plist
```

インストール時にClaude Codeの実行可能ファイルを絶対パスで解決し、LaunchAgentの `CLAUDE_ROTATOR_CLAUDE_BIN` と安全な `PATH` に固定します。Homebrewやnpm管理の `claude` が対話shellでだけ見つかり、常駐サービスでは見つからない状態を防ぎます。実行場所を明示する場合は、インストール前に `CLAUDE_ROTATOR_CLAUDE_BIN=/absolute/path/to/claude` を設定してください。

サービス操作:

```bash
launchctl print gui/$(id -u)/io.github.claude-rotator
launchctl kickstart -k gui/$(id -u)/io.github.claude-rotator
```

ログ:

```bash
tail -f ~/.config/claude-rotator/server.log
tail -f ~/.config/claude-rotator/server.err
```

## Ubuntu用セットアップ

Ubuntu PC 上でこのリポジトリを clone し、そのディレクトリ内で実行します。

```bash
node --version
npm install -g .
claude-rotator install
claude-rotator doctor
```

`node --version` は `v18.10` 以上が必要です。Ubuntu では次の systemd user service が作られます。

```text
~/.config/systemd/user/claude-rotator.service
```

サービス操作:

```bash
systemctl --user status claude-rotator.service
systemctl --user restart claude-rotator.service
journalctl --user -u claude-rotator.service -f
```

`claude-rotator install` が `systemctl --user` の起動に失敗した場合は、表示されたコマンドを実行してください。headless / SSH セッションで user systemd bus がない場合は、次が必要になることがあります。

```bash
loginctl enable-linger $USER
systemctl --user daemon-reload
systemctl --user enable --now claude-rotator.service
```

Ubuntu でも file log は次に出ます。

```bash
tail -f ~/.config/claude-rotator/server.log
tail -f ~/.config/claude-rotator/server.err
```

## アカウント追加

通常は Claude Code にログインしてから `claude-rotator login` を実行するのが一番簡単です。`login` は現在の Claude Code ログインを読み取り、可能であれば email を自動取得して登録します。

重要: `claude auth login` や `claude-rotator login` は、Claude Code 側の現在ログインを変更したり、そのログインを rotator の候補一覧へ取り込んだりする操作です。実際に API リクエストで使われるアカウントは `claude-rotator status` の `active` で決まります。別アカウントでログインして `claude-rotator login` しても、それだけでは active は切り替わりません。

この PC で現在ログイン中の Claude Code アカウントだけを使う場合は、保存済み token snapshot ではなく Claude Code の最新認証情報を毎回読む `current` アカウントとして登録できます。Claude Code 側で token が更新されても proxy が追従するため、Ubuntu の常用 PC ではこの方法が安全です。

```bash
claude auth login
claude-rotator use-current --only
```

`current` は Claude Code 側の現在ログインを毎回読む live account です。Claude Code で別アカウントへログインし直すと、`current` が指す実アカウントも変わります。そのため、複数アカウントを固定候補としてローテーションする構成では `current` を混ぜず、下の `claude-rotator login` で各アカウントを token snapshot として登録してください。`--only` は既存の rotator アカウント一覧を `current` だけに置き換えます。

複数アカウントを個別に保存して切り替える場合は、各アカウントで Claude Code にログインしてから `claude-rotator login` を実行します。

```bash
claude auth login
claude-rotator login

claude auth login
claude-rotator login
```

表示名や id を明示したい場合は、次のように指定できます。

```bash
claude-rotator login --id account1 --name your-email-1@example.com
```

登録確認:

```bash
claude-rotator accounts
claude-rotator status
claude-rotator doctor
```

`claude-rotator login --json ...` は、token JSON を直接渡す上級者向けコマンドです。通常運用では `claude-rotator login` を使ってください。

重複防止:

- `current` は live account 専用 ID です。`login --id current` や `import-current --id current` では使えません。
- `claude-rotator login` は profile から `accountUuid` を取得し、同じ Claude アカウントが既に登録済みなら既存 account を更新します。
- `claude-rotator login` は、現在の Claude Code 認証に refresh token がない場合や profile API で検証できない場合、`account1` のような仮 ID で登録せずにエラーで停止します。`claude auth status` が logged in を返しても API 用 OAuth token が失効している場合があるため、その場合は `claude auth login` をやり直してから再実行してください。
- 明示した `--id` が既存の `accountUuid` と衝突する場合は、重複登録せずにエラーを出します。既存 ID を使うか、先に `claude-rotator remove <account>` で整理してください。

認証情報の保存先:

- macOS: Keychain
- Ubuntu/Linux: `~/.local/share/claude-rotator/accounts/*.json`、ディレクトリ `0700`、ファイル `0600`

`login` は保存後に常駐 server へ reload を通知します。server が起動していない場合だけ、OS 別のサービス再起動コマンドを実行してください。

アカウントを追加した直後は、Usage API の状態も確認してください。

```bash
claude-rotator refresh-usage
claude-rotator status
```

追加したアカウントの 5時間枠または 7日枠が 100% の場合、そのアカウントは `exhausted` と表示され、自動切り替え先にはなりません。

不要になったアカウントや、`doctor` で壊れていると表示された保存済みアカウントは削除できます。デフォルトでは保存済み認証情報も削除します。

```bash
claude-rotator remove old-account-id
```

設定だけ削除し、保存済み認証情報を残す場合:

```bash
claude-rotator remove old-account-id --keep-secret
```

## モニター

別ターミナルで起動します。

```bash
claude-rotator monitor
```

表示例:

```text
account1@example.com        active
5h ███████░░░  76%  reset in 42m -> 06/04 18:00 JST
7d ███████░░░  76%  reset in 1d9h -> 06/06 19:00 JST
7d Fable █████░░░░░  50%  reset in 2d -> 07/07 09:00 JST
```

`status` / `monitor` の reset 時刻と Events 時刻は、日本時間（JST）で表示します。未使用のアカウントでも、server 起動時・アカウント reload 時・初回 status 表示時・定期 polling で OAuth Usage API から 5時間枠 / 7日枠の状態を取得します。Usage API が `limits[]` で Fable / Sonnet / Opus などのモデル別週次枠を返す場合は、`7d Fable` のような追加行として使用率と reset も表示します。100% 到達済みの枠に reset 時刻がある場合は、その reset 時刻の直後にも自動で再取得します。Usage API が取得できない場合だけ `unknown` と表示されます。`unknown` のアカウントは空いている確認が取れていないため、自動切り替え先には使いません。

OAuth Usage API は 429 を返しやすいため、usage 取得はデフォルトで 15 分間隔、1アカウントずつ、各リクエストの開始間隔 1.5 秒で実行します。必要な場合だけ `~/.config/claude-rotator/config.json` の `usagePolling.intervalMs`、`usagePolling.concurrency`、`usagePolling.requestSpacingMs` を変更してください。短すぎる間隔や高い concurrency は `claude-rotator refresh-usage` でも 429 の原因になります。

OAuth access token は期限の30分前から自動更新対象になります。保存時に Claude Code の OAuth scope と refresh token の期限を保持します。macOS / Ubuntu の保存アカウントは、通常のClaude Codeログインを変更しない隔離領域でClaude Code本体へ更新を委譲するため、access token が数時間で切れてもrefresh tokenが有効な間は対話ログイン不要です。同じ refresh token に対する同時更新は1回へ集約し、異なるアカウントの更新も直列化します。新しい refresh token は、競合する再ログインを上書きしない原子的比較更新で、使用前に Keychain またはLinuxのcredential fileへ保存します。macOS / Ubuntu のnative更新が一時失敗した場合の再試行は5分固定で、失敗回数に応じて15分や60分へ増幅しません。providerが明示した `Retry-After` は増幅せず、異常値による永久停止を避ける24時間の安全上限内で尊重します。native更新を使わない環境のdirect token更新だけは、明示値が無い一時失敗をrefresh token単位で1/2/4/8/15分までbackoffし、その後は指数を増やさず固定60分の疎通確認へ移ります。1アカウントの待機は他アカウントの更新を停止せず、実際にcredentialが変わった再リンクだけがそのアカウントの古い待機状態を解除します。現在のClaude Codeログインと `accountUuid` が一致する保存アカウントには、Claude Codeが更新した最新credentialとOAuth metadataをミラーします。provider側で明示的にrevocationされたtokenの期限自体をrotatorから延長することはできません。

## ログと切り替え診断

`status` / `monitor` の Events には、直近の proxy request が表示されます。

```text
06/07 12:43 JST request account-one POST /v1/messages -> 429 1203ms outcome=quota-retry req=req_xxx
06/07 12:43 JST switched account-one -> account-two reason=quota-threshold
```

常駐 server の file log は macOS / Ubuntu ともに次で確認できます。

```bash
tail -f ~/.config/claude-rotator/server.log
tail -f ~/.config/claude-rotator/server.err
```

proxy request ログに出るのは `account`、`method`、`path`、`status`、`durationMs`、`outcome`、`requestId`、timeout/network error 時の `errorType` だけです。内部 proxy error は `proxy-error method=... path=... error=...` として短い原因を出します。token / Authorization header / API key / request body / response body は出しません。

自動切り替えは、現在のアカウントの 5時間枠、7日枠、または Fable などのモデル別週次枠が 100% に達した場合に行います。利用可能な候補がある場合は、通常は 5時間枠 / 7日枠の既知使用率から `max(5h, 7d)` が最も低いアカウントを選びます。ただし、7日枠の reset が近いアカウントがある場合は、reset 前に週次枠を使い切れるように、そのアカウントを優先します。この週次 reset 優先は、現在の active がまだ 100% ではない場合でも、Usage API の再取得後に proactive に active を更新できます。現在のアカウント自身が quota exhausted で、すべての候補も 100% の場合は、reset 時刻が最も近い exhausted アカウントを選び、Claude Code に最短で再開できる limit message を返します。OAuth refresh failure、authentication error、一時的な throttle では exhausted アカウントへ切り替えません。

週次 reset 優先の対象期間は、デフォルトで reset まで 36 時間以内です。必要に応じて `~/.config/claude-rotator/config.json` の `rotationPolicy.weeklyResetPriorityWindowMs` で変更できます。

切り替え可能なアカウントがなくローカルで 429 を返す場合も、Claude Code が 5時間枠は `session limit`、7日枠は `weekly limit` として扱える unified rate-limit ヘッダーを返します。rotator 独自の補足情報は JSON の `details.rotator_message` に入ります。

retryable な上流 5xx / 529 / `x-should-retry` 付きレスポンス、または上流アイドルタイムアウトが起きた場合も、アカウント切り替えは行いません。上流の error body または proxy の timeout error を可能な限りそのまま返します。

Usage API の再取得は、デフォルトでは 15 分ごとの定期 polling と、100% 到達済みの枠がリセットされる時刻の直後に実行されます。間隔は `~/.config/claude-rotator/config.json` の `usagePolling.intervalMs` で変更できます。Claude Code 側の早期リセットや一時的な状態変化を確認したい場合は、次の手動コマンドで全登録アカウントを即時再確認します。

```bash
claude-rotator refresh-usage
claude-rotator status
```

`refresh-usage` 後は `claude-rotator status` で active を確認してください。Usage API の再取得で現在の active が 100% と判明した場合、または 7日枠の reset が近く週次枠を優先消化したい利用可能アカウントがある場合は、active が更新されることがあります。意図的に active を変更する場合は `claude-rotator switch <account>` を使います。

OAuth usage refresh は Node.js fetch の 10 秒 connect timeout に依存しないよう native HTTP client を使い、デフォルトでは登録アカウントを1件ずつ直列に取得します。各リクエストの idle timeout は 60 秒です。HTTPS 接続が確立する前の timeout / unreachable は、proxy と同じ `proxy.upstreamConnectTimeoutMs`、`proxy.upstreamConnectRetries`、`proxy.upstreamConnectRetryDelayMs` で短く retry します。

`usagePolling.concurrency` のデフォルトは `1` です。同一ネットワークから Anthropic 宛ての TCP 接続が安定しており、意図的に複数アカウントを同時取得したい場合だけ、この値を増やしてください。

直近の quota / usage / active account は `~/.config/claude-rotator/runtime-state.json` に保存されます。これにより、service 再起動直後に Usage API へ到達できない場合でも、最後に取得できた status を復元して切り替え判断に使えます。reset 時刻を過ぎた quota は、復元後の status 計算時に stale として消去されます。

`refresh-usage` が全アカウントで `fetch failed`、`OAuth connection timeout`、`OAuth request timeout` になる場合は、認証情報ではなく Usage API への HTTPS 接続確立で失敗している可能性があります。`warning` に `UND_ERR_CONNECT_TIMEOUT` や `ETIMEDOUT` などの cause が出ている場合は、次のように同じホストへ到達できるかを確認してください。`curl` も timeout する場合、rotator の設定ではなくローカルネットワーク、VPN、ファイアウォール、または ISP 側の経路を確認する必要があります。

```bash
curl -I --connect-timeout 10 --max-time 20 https://api.anthropic.com/api/oauth/usage
```

`cc-auto-resume` などの外部再注入ツールからは、再注入前に次のコマンドを呼ぶと、rotator が最短で再開できるアカウントへ切り替え、再注入すべき時刻を返します。利用可能なアカウントがあれば `action=ready`、全候補が枯渇していれば最短 reset の `action=wait` になります。

```bash
claude-rotator prepare-resume --json
```

必要なときだけ Usage API を先に再取得する場合:

```bash
claude-rotator prepare-resume --refresh --json
```

`claude-rotator doctor` は server の疎通に加えて、次の問題を secret を出さずに警告します。保存済み access token が期限切れの場合は refresh token で更新してから profile を確認します。

- 同じ Claude account UUID が複数登録されている
- `current` の表示名や UUID が現在の Claude Code ログインとずれている
- 保存済み OAuth 認証情報がない、または profile 取得で 401 などになる

必要に応じて `~/.config/claude-rotator/config.json` で調整できます。

```json
{
  "proxy": {
    "upstreamIdleTimeoutMs": 180000,
    "upstreamConnectTimeoutMs": 10000,
    "upstreamConnectRetries": 3,
    "upstreamConnectRetryDelayMs": 250
  }
}
```

### 接続タイムアウトの切り分け

`server.log` に次のような `ETIMEDOUT` が連続し、Claude Code 側に `Retrying in ...` や `inference gateway (127.0.0.1:37891)` が出る場合、Claude Code から rotator への接続ではなく、rotator から upstream API への接続が詰まっています。

```text
proxy account=... method=POST path=/v1/messages status=- durationMs=75000 outcome=upstream-error errorType=ETIMEDOUT
```

rotator は upstream への TCP 接続が確立する前の timeout / unreachable について、同じアカウントで短く内部 retry します。接続が確立した後、または upstream response が始まった後の失敗は、重複送信を避けるため自動 retry しません。retry は `proxy.upstreamConnectTimeoutMs`、`proxy.upstreamConnectRetries`、`proxy.upstreamConnectRetryDelayMs` で調整できます。

`curl -I --connect-timeout 10 https://api.anthropic.com/` や Anthropic API への TCP 接続確認も timeout し、Google など他サイトは通る場合は、rotator ではなくローカルネットワーク、VPN、ファイアウォール、または ISP 経路の問題です。`nc` の timeout 指定はOSごとに違うため、Ubuntu では `nc -vz -w 3 160.79.104.10 443`、macOS では `nc -vz -G 3 160.79.104.10 443` を使ってください。特にホームルーターの DoS 防御で `TCP-SYN Flood` や `一台あたりの TCP-SYN 送信上限` が低い場合、Claude Code の並列 request / retry によって Anthropic 宛ての TCP SYN が一時的に drop されることがあります。切り分け時だけ DoS 防御の TCP-SYN 関連項目を無効化するか、上限を引き上げて、上記 `nc` の成功率が改善するか確認してください。恒久的に firewall 全体を無効化する運用は推奨しません。

CLI と macOS / Ubuntu の service 定義では、Node.js が IPv6 を先に選んで blackhole する環境でも動作するように、DNS 解決を IPv4 優先にします。既存インストールで service 側の `NODE_OPTIONS=--dns-result-order=ipv4first` が入っていない場合は、リポジトリを更新してから `claude-rotator install --force` を実行するか、サービス定義を更新して再起動してください。

Ubuntu の installer は systemd サービス用に `~/.config/claude-rotator/runtime/claude-rotator` という Node.js launcher を作成します。これにより、`earlyoom --prefer` が広く `node` を優先終了する構成でも rotator proxy を通常の Node.js workload と区別できます。これはメモリを予約する仕組みではないため、`journalctl -u earlyoom` に終了記録が続く場合は、メモリ使用量と earlyoom の `--avoid` / `--ignore` 設定も確認してください。

## 主なコマンド

```bash
claude-rotator install [--no-start] [--force]
claude-rotator uninstall
claude-rotator login
claude-rotator use-current [--name your-email@example.com] [--only]
claude-rotator remove <account> [--keep-secret]
claude-rotator import-current --id account1 --name your-email@example.com
claude-rotator accounts
claude-rotator status
claude-rotator monitor
claude-rotator switch <account>
claude-rotator refresh-usage
claude-rotator doctor
```

## 元に戻す

proxy を無効化し、Claude Code の設定をインストール前の状態に戻します。

```bash
claude-rotator uninstall
```

保存済みのアカウント認証情報も削除する場合:

```bash
claude-rotator uninstall --purge-secrets
```

`ANTHROPIC_BASE_URL` がインストール後に別の値へ変更されていた場合、`uninstall` は安全のため自動上書きせず conflict を報告します。意図的に戻す場合のみ `--force` を使ってください。

## 安全設計

- proxy は `127.0.0.1` のみに bind します
- token / Authorization header / API key はログに出しません
- request body / response body はデフォルトでログに出しません
- install 時に restore manifest と settings backup を作成します

## 開発

```bash
npm test
npm run lint
```

ローカル Node は `v18.10` 以上で動作します。開発時に macOS / Ubuntu の差分を避けて確認したい場合は、下の Docker コマンドで Node 22 の検証も実行してください。

Docker での検証:

```bash
docker run --rm -v "$PWD":/app -w /app node:22-alpine npm run check
```

---

## English

Local Claude Code account rotator for macOS and Linux.

`claude-rotator` runs a localhost Anthropic-compatible proxy and configures Claude Code to use it through `~/.claude/settings.json`. After installation, you continue launching Claude Code with the normal `claude` command.

### Install

```bash
npm install -g .
claude-rotator install
```

`install` updates only `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, records the previous value in `~/.config/claude-rotator/install-state.json`, and writes a service definition:

- macOS: `~/Library/LaunchAgents/io.github.claude-rotator.plist`
- Ubuntu/Linux: `~/.config/systemd/user/claude-rotator.service`

On macOS, installation resolves Claude Code to an executable absolute path and records it as `CLAUDE_ROTATOR_CLAUDE_BIN`, together with the required service `PATH`, so Homebrew and npm installs work under launchd's minimal environment.

Ubuntu uses a systemd user service:

```bash
systemctl --user status claude-rotator.service
journalctl --user -u claude-rotator.service -f
```

If `systemctl --user` is unavailable in a headless session, enable linger and log in again:

```bash
loginctl enable-linger $USER
```

### Add Accounts

The easiest workflow is to reuse the currently logged-in Claude Code account:

```bash
claude auth login
claude-rotator login
```

`claude auth login` and `claude-rotator login` do not automatically switch the rotator's active account. They only change or import the Claude Code login. The account actually used for API requests is the `active` account shown by `claude-rotator status`.

Credentials are machine-local. Run `claude auth login` and `claude-rotator login` on each macOS or Ubuntu machine that should use the rotator.

You can still provide an explicit id/name:

```bash
claude-rotator login --id account1 --name your-email@example.com
```

### Monitor

```bash
claude-rotator monitor
```

### Diagnostics

Recent proxy requests are shown in `claude-rotator status` / `claude-rotator monitor`, and the service writes metadata-only request logs to `~/.config/claude-rotator/server.log`. Internal proxy errors are logged as `proxy-error method=... path=... error=...` without tokens or bodies. Automatic rotation happens when the current account reaches the configured 5h, 7d, or model-scoped weekly usage threshold. If the OAuth Usage API reports scoped weekly limits in `limits[]`, they appear as extra status rows such as `7d Fable`, `7d Sonnet`, or `7d Opus`, including reset times. If an available account exists, the proxy usually chooses the lowest known `max(5h, 7d)` usage. When an available account has a 7d reset within the weekly priority window, the proxy prefers that account so expiring weekly quota can be consumed before reset; usage refresh can proactively move the active account even when the current account is not yet exhausted. The weekly priority window defaults to 36 hours and can be adjusted with `rotationPolicy.weeklyResetPriorityWindowMs` in `~/.config/claude-rotator/config.json`. If every candidate is exhausted, the proxy switches to the exhausted account with the earliest known reset and returns a local 429 for that shortest resume target. OAuth refresh failures, authentication errors, and temporary throttles do not rotate to exhausted accounts. OAuth usage is refreshed at startup, reload, first status read, every 15 minutes by default, and at reported reset times for exhausted accounts. Requests run one account at a time with 1.5 seconds between starts to reduce Usage API throttling. Set the `usagePolling` fields in `~/.config/claude-rotator/config.json` to adjust this behavior. Use `claude-rotator refresh-usage` to force an immediate recheck of all registered accounts, or `claude-rotator prepare-resume --json` from external resume tooling to switch to the earliest resume target before reinjection. If `server.log` repeatedly shows `outcome=upstream-error errorType=ETIMEDOUT` around 75 seconds, the proxy is receiving Claude Code requests but cannot complete the upstream request. The CLI and generated macOS LaunchAgent / Ubuntu systemd service prefer IPv4 DNS results to avoid Node.js preferring a broken IPv6 route. On Ubuntu, the installer also runs the service through a launcher named `claude-rotator`, separating the proxy from broad earlyoom rules that prefer terminating every `node` process.

OAuth access tokens become refresh candidates 30 minutes before expiry. On macOS and Ubuntu, saved accounts are refreshed by Claude Code itself inside isolated credential storage, without changing the user's normal Claude Code login. Claude Code OAuth metadata is preserved, refreshes are coalesced and serialized, and a rotated credential is atomically persisted before use without overwriting a concurrent relink. A transient native-refresh failure uses a fixed five-minute retry and does not grow to 15 or 60 minutes. An explicit provider `Retry-After` is honored without amplification, up to a 24-hour safety ceiling. Only the direct token-refresh fallback used on other platforms backs off missing-deadline failures through 1/2/4/8/15 minutes and then moves to a fixed hourly probe. Only a relink that actually changes an account credential clears that account's stale cooldown. Provider-side revocation and maximum token lifetime remain controlled by the OAuth provider.

### Restore

```bash
claude-rotator uninstall
```

To also remove saved account credentials:

```bash
claude-rotator uninstall --purge-secrets
```
