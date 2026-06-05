# claude-rotator

Personal Claude Code account rotator for macOS and Linux.

`claude-rotator` runs a localhost Anthropic-compatible proxy and configures
Claude Code to use it through `~/.claude/settings.json`. After installation, you
continue launching Claude Code with the normal `claude` command.

## Commands

```bash
claude-rotator install
claude-rotator uninstall
claude-rotator login
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

## Development

```bash
npm test
npm run lint
```
