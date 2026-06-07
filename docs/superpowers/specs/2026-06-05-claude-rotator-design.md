# Claude Rotator Design

## Goal

Create a standalone `claude-rotator` project under `/Users/cirkit/develop/project/claude-rotator` that lets the normal `claude` command route through a local account-rotating proxy on macOS and Linux.

## Operating Model

`claude-rotator server` listens on `127.0.0.1:<port>` and forwards Anthropic API requests upstream. `claude-rotator install` updates the user-level Claude Code settings at `~/.claude/settings.json` by setting `env.ANTHROPIC_BASE_URL` to the local proxy URL. Once installed, the user keeps launching Claude Code with `claude`; all sessions using that user setting route through the proxy.

The proxy owns account selection. Each upstream request is sent with the active account's OAuth bearer token. Response headers such as `anthropic-ratelimit-unified-5h-utilization`, `anthropic-ratelimit-unified-7d-utilization`, and reset headers update per-account quota state. Automatic rotation only happens when the current account's 5h or 7d utilization reaches the configured threshold, default `1.0`. Before switching, the proxy filters for accounts whose quota state is known and still below threshold, then selects the emptiest account by the lowest `max(5h, 7d)` utilization. If no known available target exists, the current account remains selected and the upstream response is passed through.

## Install And Uninstall

`claude-rotator install` performs these steps:

1. Create config at `~/.config/claude-rotator/config.json`.
2. Create install manifest at `~/.config/claude-rotator/install-state.json`.
3. Backup `~/.claude/settings.json` before editing.
4. Set `env.ANTHROPIC_BASE_URL` to the local proxy URL.
5. Install a macOS LaunchAgent or Linux systemd user service.
6. Start the service and run a health check.

`claude-rotator uninstall` reverses the install:

1. Stop the service.
2. Remove the LaunchAgent or systemd user service.
3. Restore or remove `env.ANTHROPIC_BASE_URL` using the install manifest.
4. Leave account secrets by default.
5. Delete secrets only when `--purge-secrets` is passed.

If `ANTHROPIC_BASE_URL` changed after install and no longer matches the proxy value, uninstall does not overwrite it silently. It reports the conflict and leaves the file intact unless `--force` is passed.

## Secrets

macOS stores OAuth credentials in Keychain entries named `claude-rotator:<account-id>`. Linux initially stores credentials as JSON files under `~/.local/share/claude-rotator/accounts/` with directory mode `0700` and file mode `0600`. Storage is behind a small interface so Linux can later add `secret-tool` or `pass` without changing account management.

Config stores account metadata only: id, email, account UUID, priority, and timestamps. Config must not store access tokens, refresh tokens, API keys, request bodies, or response bodies.

## Dashboard

`claude-rotator monitor` is a terminal dashboard that reads the server's local status endpoint and refreshes once per second. The server keeps running when the dashboard exits.

Example display:

```text
Claude Rotator                         active: account-2@example.com

account-1@example.com     ready
5h ██████████ 100%  reset in 42m  -> 06/04 18:00
7d ███████░░░  76%  reset in 1d9h -> 06/06 19:00

account-2@example.com     active
5h ███░░░░░░░  31%  reset in 4h12m -> 06/04 22:20
7d █████░░░░░  54%  reset in 3d2h  -> 06/08 10:00
```

The dashboard shows active account, per-account status, 5h usage, 7d usage, reset countdowns, reset timestamps, total routed requests, and recent rotation events.

## Usage Refresh

Rate-limit headers are the primary source of quota state. Accounts that have not routed traffic yet start as `unknown`. The server also supports low-frequency OAuth usage polling, default 5 minutes, to fill dashboard state for inactive accounts. Manual refresh is available through `claude-rotator refresh-usage` and the `r` key in `monitor`.

## Logging

Default logs include account name, request path, response status, quota headers, and rotation events. Logs never include token values, Authorization headers, request bodies, or response bodies. Full request logging is not included in the first version.

## Verification

The implementation must include unit tests for config restore behavior, account selection, quota parsing, status rendering, and storage path permissions. Docker-based validation should run `npm test` and `npm run lint`.
