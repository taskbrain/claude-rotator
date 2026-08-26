# Claude Code Auth-Login Credential Refresh Design

## Problem

Claude Rotator currently refreshes a saved Claude.ai credential by seeding an
expired credential into isolated Claude Code storage and launching a normal
`claude -p` inference command. The inference command is not a documented token
refresh interface. On 2026-08-14, the installed Claude Code 2.1.231 process
repeatedly remained alive for the adapter's full 30-second deadline without
opening a network connection. Every saved credential eventually became
unusable, while the proxy process and loopback listener remained healthy.

The same refresh implementation is present in Claude Code 2.1.229 and 2.1.231,
so the evidence does not support a version-specific regression. The fragile
part is the adapter contract: a general inference startup performs unrelated
initialization before refresh, and Claude Rotator relies on refresh as an
undocumented side effect.

Claude Code documents a dedicated automation contract instead:

- `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` supplies a Claude.ai refresh token.
- `CLAUDE_CODE_OAUTH_SCOPES` supplies its space-separated scopes.
- `claude auth login --claudeai` exchanges the token without opening a browser.

The design must follow new Claude Code releases without pinning the user to an
old version, avoid exposing credentials in arguments or logs, and never consume
the same rotating refresh token twice after an ambiguous result.

## Decision

Use the documented `claude auth login --claudeai` flow as the only automatic
refresh driver on macOS and Linux.

Do not fall back automatically to the old inference side effect, a direct HTTP
OAuth implementation, `CLAUDE_CODE_OAUTH_TOKEN`, plaintext macOS credential
storage, Keychain deletion, or Keychain unlocking after a real refresh token
has been handed to Claude Code. A failed or timed-out exchange may already have
rotated the provider credential. Reusing the old token through another driver
can invalidate the credential family.

This is a fail-closed boundary, not a version pin. Each refresh resolves the
current configured Claude executable and pins that invocation to its real
target. It does not infer runtime capability from help text, a version allowlist,
or static binary strings. Immediately before the only token-bearing spawn it
durably records the refresh intent. A newer executable is used immediately; if
an incompatible executable rejects the command after handoff, the outcome is
unknown and the account is parked rather than reusing the rotating token.

## Alternatives considered

### Keep `claude -p` and adapt arguments by version

Rejected. The observed stall happens before inference traffic, both inspected
versions have equivalent refresh code, and the refresh behavior is not part of
the `-p` contract. Version branches would encode guesses about private startup
behavior and require continuous reverse engineering.

### Refresh directly with Claude Rotator's HTTP client

Rejected as an automatic fallback. It gives structured HTTP errors but makes
Claude Rotator responsible for private client identifiers, endpoints, headers,
scope evolution, and token response changes. It also cannot be attempted safely
after an ambiguous Claude Code exchange. The existing direct implementation is
retained only for platforms that do not use the native adapter; it is not a
fallback for macOS or Linux.

### Fall back to the last-known-good Claude binary

Rejected for the initial implementation. Retaining old binaries adds lifecycle
and supply-chain responsibilities, and an automatic retry is unsafe once the
new binary receives a real refresh token. Runtime probes cannot prove that the
exchange contract will succeed. The supported recovery is to install a
compatible Claude Code release and explicitly relink the account rather than
silently execute an older binary.

## Refresh driver

For every refresh attempt, the adapter:

1. Validates the existing credential, refresh-token lifetime, client identity,
   and scopes. Custom OAuth clients fail before execution because the documented
   environment contract does not accept a custom client identifier.
2. Resolves the configured Claude executable and, when possible, resolves its
   symlink to a concrete executable for the whole attempt.
3. Creates private isolated config, XDG, work, and temporary directories.
4. Uses an isolated credentials file on Linux or a config-derived isolated
   Keychain service on macOS. The normal Claude Code credential is never read,
   overwritten, or deleted.
5. Confirms the shared deadline can still fence a child, then durably records
   the refresh intent immediately before token handoff.
6. Runs exactly one `claude auth login --claudeai` with the refresh token and
   scopes in the child-only environment. Tokens are never command-line arguments.
7. Waits for the child process to close. On timeout, it sends `SIGTERM`, allows
   a short grace period, then sends `SIGKILL` to the child process group and
   still waits for close before reading or deleting storage.
8. Reads and validates the isolated credential as the postcondition. Stdout and
   stderr wording are not an API and are never parsed.
9. Accepts a valid rotated credential even when the child exits non-zero or
   times out, because persistence proves that the exchange completed.
10. If no valid new credential exists after a post-exchange failure, reports an
    outcome-unknown error and does not automatically reuse that refresh token.

Command output is bounded and sanitized. Temporary directories are mode 0700,
temporary files are mode 0600, and cleanup starts only after child close.
On macOS, the real user home remains necessary for login Keychain resolution;
all Claude-specific state remains isolated by config-derived storage identity.

The documented contract requires the refresh token in an environment variable.
On macOS, processes running as the same user may inspect another process's
environment. The child is therefore short-lived and uses a minimal allowlist,
but the local user account remains the security boundary.

## Refresh coordination and persistence

An account's durable secret-store lock covers this complete transaction:

1. acquire the account lock;
2. re-read the stored credential;
3. skip exchange and return the newer credential if it differs from the caller's
   expected snapshot;
4. invoke the auth-login driver once;
5. write the validated rotated credential atomically;
6. release the account lock.

This closes the cross-process gap left by an in-process single-flight wrapper
and a separately locked compare-and-set. The server, usage refresher, request
401 recovery, and `doctor` command use the same transaction. A failed write
after exchange marks the account unavailable; it never triggers another driver
with the previous token.

Known provider 429 responses retain provider rate-limit semantics. Local failures
before token handoff retain bounded retry semantics and must not be presented as
provider OAuth rate limiting. Any failure after durable handoff without a valid
new credential parks the account. A credential whose access token is still valid
may continue until its safe-use threshold; an expired credential is removed from
selection and another healthy account is chosen.

## Version-update behavior

The installed service continues to reference the stable Claude installer path,
such as `~/.local/bin/claude`, so normal Claude Code updates are discovered.
The adapter resolves that path for each refresh and pins one real executable
before durable handoff, preventing a symlink update from redirecting the sole
token-bearing invocation.

There is no runtime help, version, static-string, or dummy-token capability
probe. The documented auth-login command itself is the only behavioral check.
Actual credential shape is validated after exchange, so an unsupported command
or storage schema drift fails closed without leaking credentials, committing
malformed output, or making the handed-off token eligible for reuse.

## Error model

- Executable missing or inaccessible: report
  `NATIVE_REFRESH_COMMAND_UNAVAILABLE` before token consumption.
- Shared deadline exhausted before durable handoff: report
  `NATIVE_REFRESH_COMMAND_FAILED` with a bounded retry delay.
- Unsupported auth-login command after handoff: report
  `NATIVE_REFRESH_OUTCOME_UNKNOWN` and park the credential.
- Auth-login exits without a valid new credential: report
  `NATIVE_REFRESH_OUTCOME_UNKNOWN` and park the credential until it changes or
  an operator explicitly relinks it.
- Timeout without a valid new credential: the same outcome-unknown behavior.
- Valid new credential after non-zero exit or timeout: accept and commit it.
- Invalid, regressed, expired, scope-dropping, malformed, or symlinked output:
  reject it and never log credential contents.

## Documentation and operations

README documentation will describe the official auth-login driver, the lack of
post-exchange fallback, the single durable handoff, and recovery through
`claude-rotator login` after a parked credential.

Deployment on this Mac must use an explicit file allowlist, back up the deployed
files, replace files atomically, use `launchctl kickstart -k` without
`bootout`, verify `/internal/health`, exercise the refresh path, and roll back
the exact files on failure. The service watchdog remains outside this change and
its untracked worktree files must not enter this pull request.

## Verification

- Unit tests prove the exact auth-login arguments and token-only environment,
  while global credentials and settings remain unchanged.
- A secret-free compatibility fixture runs against Claude Code 2.1.229, 2.1.231,
  and 2.1.232 and proves the dummy-token path reaches a dead proxy without a
  browser or valid credential.
- Timeout tests prove cleanup cannot start before child close and that a valid
  post-timeout credential is recovered.
- Invalid or unchanged output, custom-client credentials, missing scopes,
  malformed files, symlinks, output overflow, and cleanup failure are covered.
- Two store instances refreshing the same account prove that only one exchange
  runs and both callers receive the committed credential.
- Native-driver failures are not classified as provider 429 rate limits.
- The complete lint and test suite passes in Docker on Node.js 20 and 22.
- macOS validation covers the real isolated Keychain adapter, the installed
  current Claude Code release, service health, and a minimal Rotator API smoke.

## References

- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [OAuth 2.0 Security Best Current Practice, refresh-token replay](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14.2)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Claude Code macOS Keychain refresh race report](https://github.com/anthropics/claude-code/issues/76905)
