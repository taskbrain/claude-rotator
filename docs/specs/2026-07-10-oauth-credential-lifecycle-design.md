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

## Refresh policy

- Start refreshing 30 minutes before access-token expiry. With the default
  15-minute usage polling interval this provides more than one opportunity to
  refresh before expiry without increasing the normal refresh frequency.
- Preserve a newly returned refresh token and never intentionally retry the old
  token after a successful rotation.
- Treat token-endpoint 429 responses as temporary throttles. Retain the
  `Retry-After` deadline, serialize token-endpoint calls across accounts, and
  suppress every account's refresh during the shared cooldown. Repeated 429s
  use exponential backoff capped at six hours.
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

- macOS credentials remain in Keychain.
- Linux credentials are written through a temporary `0600` file and atomic
  rename.
- Logs may include account ID, refresh outcome, and expiry timestamp, but never
  access tokens, refresh tokens, authorization headers, or token hashes.

## Verification

- Concurrent expired-token requests perform one refresh and both use the
  rotated credential.
- A late caller holding the old refresh token reuses the successful result.
- A live Claude Code credential is mirrored into the matching stored account.
- A live credential rejected with 401 is re-read on the next request rather
  than independently refreshed or marked permanently invalid.
- Concurrent refreshes for different accounts result in one token-endpoint
  request when the first request establishes a shared cooldown.
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
