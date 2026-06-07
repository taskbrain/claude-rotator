# claude-rotator

Claude Code の複数アカウントをローカル proxy 経由で切り替えるためのローカル用ツールです。macOS と Linux で動作することを想定しています。

`claude-rotator` は `127.0.0.1` で Anthropic 互換 proxy を起動し、Claude Code の `~/.claude/settings.json` に `ANTHROPIC_BASE_URL` を設定します。インストール後も、Claude Code は通常どおり `claude` コマンドで起動できます。

## できること

- 通常の `claude` コマンドを変えずに、裏側で `claude-rotator` proxy を使う
- 5時間枠 / 7日枠の使用率を見て、100% 到達時に最も空いている既知のアカウントへ切り替える
- `claude-rotator monitor` で各アカウントの使用率を一覧表示する
- macOS では Keychain、Linux では private permission のファイルに認証情報を保存する
- `claude-rotator uninstall` で `~/.claude/settings.json` を元に戻す

## 利用上の注意

このプロジェクトは Anthropic / Claude Code の非公式ツールです。利用しているサービス、契約、組織ポリシーの範囲内で使ってください。認証情報は各 PC のローカルにのみ保存され、リポジトリに保存・送信しない設計ですが、共有 PC や暗号化されていないディスクでは保存先の保護に注意してください。

## 動作環境

- Node.js 18 以上
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

`node --version` は `v18` 以上が必要です。Ubuntu では次の systemd user service が作られます。

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
5h ███████░░░  76%  reset in 42m -> 06/04 18:00
7d ███████░░░  76%  reset in 1d9h -> 06/06 19:00
```

未使用のアカウントでも、server 起動時・アカウント reload 時・初回 status 表示時に OAuth Usage API から 5時間枠 / 7日枠の状態を取得します。100% 到達済みの枠に reset 時刻がある場合は、その reset 時刻の直後に自動で再取得します。Usage API が取得できない場合だけ `unknown` と表示されます。`unknown` のアカウントは空いている確認が取れていないため、自動切り替え先には使いません。

## ログと切り替え診断

`status` / `monitor` の Events には、直近の proxy request が表示されます。

```text
2026-06-07T03:43:23.000Z request account-one POST /v1/messages -> 429 1203ms outcome=quota-retry req=req_xxx
2026-06-07T03:43:23.000Z switched account-one -> account-two reason=quota-threshold
```

常駐 server の file log は macOS / Ubuntu ともに次で確認できます。

```bash
tail -f ~/.config/claude-rotator/server.log
tail -f ~/.config/claude-rotator/server.err
```

ログに出るのは `account`、`method`、`path`、`status`、`durationMs`、`outcome`、`requestId`、timeout/network error 時の `errorType` だけです。token / Authorization header / API key / request body / response body は出しません。

自動切り替えは、現在のアカウントの 5時間枠または 7日枠が 100% に達した場合だけ行います。利用可能な候補がある場合は、5時間枠 / 7日枠の既知使用率から `max(5h, 7d)` が最も低いアカウントを選びます。現在のアカウント自身が quota exhausted で、すべての候補も 100% の場合だけ、reset 時刻が最も近い exhausted アカウントを選び、Claude Code に上流の limit message をそのまま返せるようにします。OAuth refresh failure、authentication error、一時的な throttle では exhausted アカウントへ切り替えません。

retryable な上流 5xx / 529 / `x-should-retry` 付きレスポンス、または上流アイドルタイムアウトが起きた場合も、アカウント切り替えは行いません。上流の error body または proxy の timeout error を可能な限りそのまま返します。

Usage API の再取得は、固定間隔では実行しません。通常は取得済み Usage API に含まれる reset 時刻を使い、100% 到達済みの枠がリセットされる時刻の直後に自動で再取得します。Claude Code 側の早期リセットや一時的な状態変化を確認したい場合は、次の手動コマンドで全登録アカウントを即時再確認します。

```bash
claude-rotator refresh-usage
claude-rotator status
```

`refresh-usage` 後は `claude-rotator status` で active を確認してください。Usage API の再取得で現在の active が 100% と判明し、別の利用可能アカウントまたは reset が近い exhausted アカウントがある場合は、active が更新されることがあります。意図的に active を変更する場合は `claude-rotator switch <account>` を使います。

`claude-rotator doctor` は server の疎通に加えて、次の問題を secret を出さずに警告します。

- 同じ Claude account UUID が複数登録されている
- `current` の表示名や UUID が現在の Claude Code ログインとずれている
- 保存済み OAuth 認証情報がない、または profile 取得で 401 などになる

必要に応じて `~/.config/claude-rotator/config.json` で調整できます。

```json
{
  "proxy": {
    "upstreamIdleTimeoutMs": 180000
  }
}
```

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

Recent proxy requests are shown in `claude-rotator status` / `claude-rotator monitor`, and the service writes metadata-only request logs to `~/.config/claude-rotator/server.log`. Automatic rotation only happens when the current account reaches 100% usage in the 5h or 7d window. If an available account exists, the proxy chooses the lowest known usage; if the current account itself is quota-exhausted and every candidate is exhausted, it chooses the account with the shortest reset time and passes through the upstream limit message. OAuth refresh failures, authentication errors, and temporary throttles do not rotate to exhausted accounts. OAuth usage is refreshed at startup, reload, first status read, and at reported reset times for exhausted accounts. Use `claude-rotator refresh-usage` to force an immediate recheck of all registered accounts.

### Restore

```bash
claude-rotator uninstall
```

To also remove saved account credentials:

```bash
claude-rotator uninstall --purge-secrets
```
