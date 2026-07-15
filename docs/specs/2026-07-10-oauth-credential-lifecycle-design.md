# OAuth credential lifecycle hardening

## Problem

Claude Code owns the credential for the account currently logged in through
`/login`. claude-rotator keeps a separate credential snapshot for each account
so it can switch accounts without changing the Claude Code login.

Two lifecycle gaps can invalidate those snapshots:

1. When Claude Code rotates the current account's refresh token,
   claude-rotator uses the live credential but does not copy it back to the
   matching account snapshot. After `/login` moves to another account, the
   rotator can fall back to the now-invalid old refresh token.
2. Concurrent proxy requests can observe the same expiring access token and
   submit the same refresh token more than once. Refresh token rotation may
   invalidate the old token after the first successful request.

Linux credential writes also replace the account file in place, so an
interrupted write can leave invalid JSON.

A third failure mode occurs when an expired saved account remains selected
after Claude Code logs into another account. Passing the saved account's 401
back to Claude Code makes Claude Code rotate its valid live credential, while
the proxy continues to inject the expired saved credential. Repeating that
cycle can rate-limit the token endpoint for every account.

## Ownership model

- The current Claude Code credential is owned and refreshed by Claude Code.
  The rotator must not refresh it independently.
- When its profile UUID matches a configured rotator account, the live Claude
  Code credential is mirrored into that account's secure store. This keeps the
  snapshot usable after the user logs Claude Code into another account.
- Credentials for non-current accounts are owned by claude-rotator. A refresh
  response is stored before its access token is used.
- A refresh token has at most one in-flight refresh request in the proxy
  process. Successful results remain available briefly to late callers that
  still hold the old token.
- Account metadata may include an explicit, non-secret `credentialRevision`.
  Reloading accounts clears an OAuth cooldown or credential error only when
  both the previous and incoming revisions are present and differ. An unchanged
  or missing revision is not evidence that credentials changed, and a revision
  change for one account must not reset another account's state.
- On first start after upgrade, accounts without a revision receive a random
  non-secret baseline revision. Runtime state also records this revision, so a
  later credential change cannot restore an older cooldown after a restart.

## Refresh policy

- Start refreshing 30 minutes before access-token expiry. With the default
  15-minute usage polling interval this provides more than one opportunity to
  refresh before expiry without increasing the normal refresh frequency.
- Preserve a newly returned refresh token and never intentionally retry the old
  token after a successful rotation.
- Treat token-endpoint 429 responses as temporary throttles. Retain the
  provider's explicit `Retry-After` deadline without amplifying it, subject to a
  24-hour safety ceiling. When the provider omits that deadline, use
  per-refresh-token exponential backoff capped at 15 minutes. Token-endpoint
  calls remain serialized across accounts, but one account's cooldown must not
  suppress or starve another account.
- The macOS and Linux native Claude Code adapter uses a fixed five-minute retry
  for transient failures; repeated failures do not amplify that delay.
- Installation pins the resolved Claude Code executable and a service-safe PATH
  in both the macOS LaunchAgent and Linux systemd user unit, so native refresh
  does not depend on an interactive shell's PATH.
- If a proactive refresh fails while the access token still has at least one
  minute remaining, keep using that access token until a later refresh can
  succeed. Do not make a working account unavailable merely because the token
  endpoint is throttled.
- When an expired credential cannot be refreshed, switch to a known healthy
  account. If no healthy account exists, return a local retryable 503 instead
  of sending the expired credential upstream and leaking a misleading 401 to
  Claude Code.
- A successful authenticated usage request clears stale authentication state
  for that account, including state persisted before a fresh Claude Code login.
- Invalidate the short-lived live-credential cache after a 401. Claude Code
  receives the 401 and remains responsible for refreshing its own credential;
  the next request reloads the Keychain or credentials file immediately.
- Token lifetime and server-side revocation remain controlled by the OAuth
  provider. The rotator can preserve and rotate credentials correctly, but it
  cannot extend a revoked refresh token.

## Persistence and diagnostics

- macOS credentials remain in Keychain. Mutating `security` commands receive
  credential input through stdin, and their child PID is protected by the
  account lock until the process closes so a crashed parent cannot permit a
  late Keychain write to overwrite a concurrent relink.
- Linux credentials are written through a temporary `0600` file and atomic
  rename. Purge removes abandoned credential temporary files under the same
  per-account lock without destroying a live writer's lock.
- Persist whether a refresh cooldown came from an explicit provider deadline,
  the local fallback policy, or a fixed retry policy. On restore, retain a
  provider deadline for at most 24 hours, a fixed retry for at most 60 minutes,
  and a fallback or source-less legacy retry for at most 15 minutes. Discard a
  restored cooldown that exceeds the limit for its source instead of carrying
  an excessive delay into the restarted process.
- Logs may include account ID, refresh outcome, and expiry timestamp, but never
  access tokens, refresh tokens, authorization headers, or token hashes.

## Verification

- Concurrent expired-token requests perform one refresh and both use the
  rotated credential.
- A late caller holding the old refresh token reuses the successful result.
- A live Claude Code credential is mirrored into the matching stored account.
- A live credential rejected with 401 is re-read on the next request rather
  than independently refreshed or marked permanently invalid.
- Concurrent refreshes for different accounts are serialized, and each account
  receives its own token-endpoint attempt and cooldown state.
- Reloading an account with a changed `credentialRevision` clears only that
  account's OAuth cooldown or error; unchanged and missing revisions preserve
  the existing state.
- Restored provider, fixed, fallback, and source-less cooldowns enforce their
  source-specific maximum durations.
- A proactive refresh 429 does not interrupt a request authenticated by an
  access token that is still valid.
- An expired saved credential is never forwarded after its refresh fails.
- A late upstream TLS `EPIPE` is handled without terminating the proxy process.
- macOS and Linux persistence tests continue to enforce secure storage.

## Alternatives considered

Claude Code can generate a one-year token with `claude setup-token`, but the
official documentation describes that credential as inference-only. It is not
the default here because account discovery and proactive quota rotation also
depend on profile and usage endpoints. Normal `/login` credentials therefore
remain the source for multi-account rotation.

## References

- [OAuth 2.0 RFC 6749, section 6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
- [OAuth 2.0 Security BCP RFC 9700, section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)
- [Claude Code authentication and credential management](https://code.claude.com/docs/en/team#credential-management)
