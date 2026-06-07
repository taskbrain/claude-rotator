# claude-rotator

Claude Code の複数アカウントをローカル proxy 経由で切り替えるための個人用ツールです。macOS と Linux で動作することを想定しています。

`claude-rotator` は `127.0.0.1` で Anthropic 互換 proxy を起動し、Claude Code の `~/.claude/settings.json` に `ANTHROPIC_BASE_URL` を設定します。インストール後も、Claude Code は通常どおり `claude` コマンドで起動できます。

## できること

- 通常の `claude` コマンドを変えずに、裏側で `claude-rotator` proxy を使う
- 5時間枠 / 7日枠の使用率を見て、閾値到達時に次アカウントへ切り替える
- `claude-rotator monitor` で各アカウントの使用率を一覧表示する
- macOS では Keychain、Linux では private permission のファイルに認証情報を保存する
- `claude-rotator uninstall` で `~/.claude/settings.json` を元に戻す

## インストール

このリポジトリ内で実行します。

```bash
npm install -g .
claude-rotator install
```

`install` は `~/.claude/settings.json` の `env.ANTHROPIC_BASE_URL` だけを更新し、変更前の状態を `~/.config/claude-rotator/install-state.json` に保存します。

常駐サービスは以下に作られます。

- macOS: `~/Library/LaunchAgents/com.cirkit.claude-rotator.plist`
- Linux: `~/.config/systemd/user/claude-rotator.service`

サービス起動に失敗する場合は、手動で server を起動できます。

```bash
claude-rotator server
```

## アカウント追加

通常は Claude Code にログインしてから `claude-rotator login` を実行するのが一番簡単です。`login` は現在の Claude Code ログインを読み取り、可能であれば email を自動取得して登録します。

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

既存の current import コマンドも残しています。

```bash
claude-rotator import-current --id account1 --name your-email-1@example.com
```

`login` / `import-current` は保存後に常駐 server へ reload を通知します。server が起動していない場合だけ、手動で再起動してください。

macOS:

```bash
launchctl kickstart -k gui/$(id -u)/com.cirkit.claude-rotator
```

Linux:

```bash
systemctl --user restart claude-rotator.service
```

登録確認:

```bash
claude-rotator accounts
claude-rotator status
```

`claude-rotator login --json ...` は、token JSON を直接渡す上級者向けコマンドです。通常運用では `claude-rotator login` を使ってください。

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

未使用のアカウントは、proxy が rate-limit header や usage data を取得するまで `unknown` と表示されます。

## ログと切り替え診断

`status` / `monitor` の Events には、直近の proxy request が表示されます。

```text
2026-06-07T03:43:23.000Z request dev-taskbrain-co-jp POST /v1/messages -> 500 1203ms outcome=upstream-retry req=req_xxx
2026-06-07T03:43:23.000Z switched dev-taskbrain-co-jp -> current reason=temporary_upstream_error
```

macOS の常駐 server ログは次で確認できます。

```bash
tail -f ~/.config/claude-rotator/server.log
tail -f ~/.config/claude-rotator/server.err
```

ログに出るのは `account`、`method`、`path`、`status`、`durationMs`、`outcome`、`requestId`、timeout/network error 時の `errorType` だけです。token / Authorization header / API key / request body / response body は出しません。

retryable な上流 5xx / 529 / `x-should-retry` 付きレスポンス、または上流アイドルタイムアウトが起きた場合、まだ Claude Code へレスポンスを書き始めていなければ次のアカウントへ自動で再送します。代替アカウントがない場合は、上流の error body を可能な限りそのまま返します。

必要に応じて `~/.config/claude-rotator/config.json` で調整できます。

```json
{
  "proxy": {
    "upstreamIdleTimeoutMs": 180000,
    "retryableUpstreamHoldSeconds": 30
  }
}
```

## 主なコマンド

```bash
claude-rotator install
claude-rotator uninstall
claude-rotator login
claude-rotator import-current --id account1 --name your-email@example.com
claude-rotator accounts
claude-rotator status
claude-rotator monitor
claude-rotator switch <account>
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

Personal Claude Code account rotator for macOS and Linux.

`claude-rotator` runs a localhost Anthropic-compatible proxy and configures Claude Code to use it through `~/.claude/settings.json`. After installation, you continue launching Claude Code with the normal `claude` command.

### Install

```bash
npm install -g .
claude-rotator install
```

`install` updates only `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`, records the previous value in `~/.config/claude-rotator/install-state.json`, and writes a service definition:

- macOS: `~/Library/LaunchAgents/com.cirkit.claude-rotator.plist`
- Linux: `~/.config/systemd/user/claude-rotator.service`

### Add Accounts

The easiest workflow is to reuse the currently logged-in Claude Code account:

```bash
claude auth login
claude-rotator login
```

You can still provide an explicit id/name:

```bash
claude-rotator login --id account1 --name your-email@example.com
```

### Monitor

```bash
claude-rotator monitor
```

### Diagnostics

Recent proxy requests are shown in `claude-rotator status` / `claude-rotator monitor`, and the service writes metadata-only request logs to `~/.config/claude-rotator/server.log`. Retryable upstream 5xx / 529 / `x-should-retry` responses and upstream idle timeouts rotate to the next account before a response is sent to Claude Code.

### Restore

```bash
claude-rotator uninstall
```

To also remove saved account credentials:

```bash
claude-rotator uninstall --purge-secrets
```
