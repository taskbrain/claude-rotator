# Security Policy

`claude-rotator` is a local proxy that stores Claude Code OAuth credentials
(access tokens, refresh tokens, account metadata) in the macOS Keychain or in
permission-restricted files on Linux, and forwards requests to Anthropic's
API from `127.0.0.1`. Because it handles credentials, please report
vulnerabilities responsibly.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private reporting flow instead:
[Report a vulnerability](https://github.com/taskbrain/claude-rotator/security/advisories/new)
(repository **Security** tab → **Advisories** → **Report a vulnerability**).
This opens a private advisory visible only to maintainers until a fix is
ready.

When reporting, please include:

- Affected version or commit
- OS (macOS or Linux)
- Steps to reproduce
- Impact you believe the issue has

### Do not include the following in any report, issue, PR, or log attachment

Never paste OAuth access tokens, refresh tokens, API keys, the contents of
`~/.claude/.credentials.json`, or actual Keychain item values. If you attach
logs, redact/mask any token-like strings first.

## Supported Versions

This project currently ships a single `0.1.0` line. Only the latest commit on
`main` is supported; please reproduce against `main` before reporting.

## Response Policy

`claude-rotator` is maintained on a best-effort basis as a personal/small
project. There is no guaranteed SLA for triage or fixes. The software is
provided under the MIT License, "as is", without warranty of any kind.

## Out of Scope

The proxy does not authenticate local clients: it trusts every OS user and
process on the same host that can connect to loopback (`127.0.0.1`). This is
a known, intentional design choice documented in the README, and reports
about it will be closed as out of scope. Run `claude-rotator` only on a
single-user or otherwise fully trusted host.
