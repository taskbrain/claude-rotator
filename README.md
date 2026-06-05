# claude-rotator

Personal Claude Code account rotator for macOS and Linux.

`claude-rotator` runs a localhost Anthropic-compatible proxy and configures
Claude Code to use it through `~/.claude/settings.json`. After installation, you
continue launching Claude Code with the normal `claude` command.

## Install From This Repository

```bash
npm install -g .
claude-rotator install
```

`install` updates only `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json`,
records the previous value in `~/.config/claude-rotator/install-state.json`, and
writes a service definition:

- macOS: `~/Library/LaunchAgents/com.cirkit.claude-rotator.plist`
- Linux: `~/.config/systemd/user/claude-rotator.service`

If service startup fails, run the server manually:

```bash
claude-rotator server
```

## Add Accounts

The easiest workflow is to reuse the currently logged-in Claude Code account.
Repeat this for each account:

```bash
claude auth login
claude-rotator import-current --id account1 --name your-email@example.com
```

Use a different `--id` for each account, for example `account1` through
`account4`. On macOS, imported credentials are stored in Keychain. On Linux,
they are stored under `~/.local/share/claude-rotator/accounts/` with private
permissions.

You can also add credentials from explicit JSON:

```bash
claude-rotator login --id account1 --name your-email@example.com --json '{"accessToken":"...","refreshToken":"...","expiresAt":1780582800000}'
```

## Commands

```bash
claude-rotator install
claude-rotator uninstall
claude-rotator login
claude-rotator import-current
claude-rotator accounts
claude-rotator status
claude-rotator monitor
claude-rotator switch <account>
claude-rotator doctor
```

## Safety Defaults

- The proxy binds to `127.0.0.1` only.
- Tokens are not written to logs.
- Request and response bodies are not logged by default.
- `install` records a restore manifest so `uninstall` can revert the Claude Code
  settings it changed.

## Monitor

Run this in a separate terminal:

```bash
claude-rotator monitor
```

The dashboard shows one block per account:

```text
account1@example.com        active
5h ███████░░░  76%  reset in 42m -> 06/04 18:00
7d ███████░░░  76%  reset in 1d9h -> 06/06 19:00
```

Accounts start as `unknown` until the proxy sees rate-limit headers or usage
data for them.

## Restore

To disable the proxy and put Claude Code back the way it was:

```bash
claude-rotator uninstall
```

If `ANTHROPIC_BASE_URL` was changed by something else after install, uninstall
will stop and report a conflict instead of overwriting that value. Use `--force`
only when you intentionally want to restore the install-time value.

To also remove saved account credentials:

```bash
claude-rotator uninstall --purge-secrets
```

## Development

```bash
npm test
npm run lint
```
