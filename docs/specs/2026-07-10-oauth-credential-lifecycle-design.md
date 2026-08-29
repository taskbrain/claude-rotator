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

A fourth failure mode exists before a request reaches the proxy. Claude Code CLI
normally treats its saved `/login` credential as the client credential when
only `ANTHROPIC_BASE_URL` is configured. If that login expires and cannot be
refreshed, Claude Code stops locally with `Login expired` even when the rotator
has a healthy selected-account credential.

## Client gateway authentication

- Installation configures both the loopback `ANTHROPIC_BASE_URL` and a fixed,
  non-secret `ANTHROPIC_AUTH_TOKEN` placeholder, following Claude Code's
  documented bearer-token gateway configuration.
- The placeholder is only a client-to-loopback compatibility credential. The
  proxy discards incoming `authorization` and `x-api-key` headers and injects
  the selected account credential, so the placeholder never reaches Anthropic.
- The fixed placeholder is not network client authentication. Startup defaults
  a missing host to `127.0.0.1` and rejects every non-loopback bind target.
- Provider-selection variables for Bedrock, Vertex, Foundry, Anthropic AWS,
  Anthropic Google Cloud, or Mantle select a non-Anthropic protocol.
  Installation and server startup reject those user/environment overrides
  instead of accepting incompatible traffic.
- Claude Code does not add the subscription OAuth capability when a gateway
  credential takes precedence over `/login`. For a selected OAuth account, the
  proxy preserves the client's open-list `anthropic-beta` header and adds
  `oauth-2025-04-20` exactly once. It does not add that capability for API-key
  accounts.
- The installer records and restores both prior settings. Reinstalling the same
  installation with a changed URL or placeholder preserves each setting's
  original restore provenance independently. An unrelated user-managed value
  is never overwritten or restored without `--force`.
- Native stored-account refresh runs with a strict environment allowlist and
  isolated Claude settings, so the gateway placeholder does not mask or alter
  the upstream OAuth refresh flow. Each attempt resolves the current installer
  path (without a version allowlist), pins its `realpath`, durably records the
  refresh intent immediately before token handoff, and invokes exactly one
  `claude auth login --claudeai` process without a separate runtime probe.
- Gateway authentication leaves the saved `/login` credential unused, so it
  cannot safely back the live `current` account mode. Installation and
  `use-current` fail closed when that combination is requested; installed
  operation uses stored accounts imported with `claude-rotator login`. The
  compatibility command detects shell and user-setting overrides; operators
  must additionally verify project, local, and managed effective settings with
  Claude Code `/status` before using manual mode.
- When any configured credential outranks `/login`, stored accounts do not read
  or mirror the normal Claude Code credential. This keeps the last imported
  account rotator-owned and prevents a stale `/login` from rolling back a
  successfully refreshed stored credential.
- This settings-file integration targets Claude Code CLI. VS Code uses its own
  `claudeCode.environmentVariables` configuration path.

## Ownership model

- Outside installed gateway mode, the current Claude Code credential is owned
  and refreshed by Claude Code. The rotator must not refresh it independently.
- Outside gateway mode, when its profile UUID matches a configured rotator
  account, the live Claude Code credential is mirrored into that account's
  secure store. Gateway mode never performs this mirroring.
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
- The macOS and Linux native Claude Code adapter delegates refresh through the
  official `claude auth login --claudeai` contract, passing the saved refresh
  token only as `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and the saved scopes only as
  `CLAUDE_CODE_OAUTH_SCOPES` in the isolated child environment. Neither value
  is an argument, configuration value, or log field. Same-user local processes
  can potentially observe a child environment, so this short-lived handoff is
  within the same-user trust boundary only.
- The macOS and Linux native Claude Code adapter uses a fixed five-minute
  `oauth_refresh_retry` cooldown for transient local failures; repeated
  failures do not amplify that delay. Provider token-endpoint 429 responses use
  the distinct `oauth_refresh_rate_limit` state.
- On macOS, the native adapter keeps the real user `HOME` so the `security`
  process resolves the login Keychain. The Claude config, secure-storage
  service, XDG directories, working directory, and temporary directory remain
  isolated, so refreshing a saved account cannot replace the normal Claude
  Code login.
- Older first-party saved credentials may lack the OAuth metadata now emitted
  by Claude Code. When no custom OAuth client is present, pass the current five
  Claude Code scopes through `CLAUDE_CODE_OAUTH_SCOPES`. Do not invent a
  refresh-token expiry or apply first-party scopes to a custom client.
- The service retains a service-safe PATH and installer command path in both
  the macOS LaunchAgent and Linux systemd user unit. Each refresh resolves that
  path again, so it follows installer updates, pins one real executable per
  attempt, and does not depend on an interactive shell's PATH.
- The macOS LaunchAgent uses `ProcessType=Interactive` because the request path
  synchronously waits for the official Claude Code auth-login process. The
  default launchd daemon limits can otherwise stretch a newly upgraded CLI's
  cold start past the bounded refresh deadline.
- If a proactive refresh fails while the access token still has at least one
  minute remaining, keep using that access token until a later refresh can
  succeed. Do not make a working account unavailable merely because the token
  endpoint is throttled.
- When an expired credential cannot be refreshed, switch to a known healthy
  account. If no healthy account exists, return a local retryable 503 instead
  of sending the expired credential upstream and leaking a misleading 401 to
  Claude Code.
- After the refresh token is handed to native Claude Code, do not fall back to
  another refresh driver. If the command exits or fails and the isolated
  credential result cannot be read, its outcome is unknown: park the account
  as `oauth_refresh_failed`. Recover only by re-authenticating that account
  with `claude auth login --claudeai` and importing it again through
  `claude-rotator login`.
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
- Outside gateway mode, a live Claude Code credential is mirrored into the
  matching stored account.
- In gateway mode, a matching live credential is ignored: an expired stored
  account refreshes through its own refresh token, and a fresh stored account
  is never rolled back to stale live credentials.
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
- Native refresh pins one resolved executable before durable handoff and invokes
  that executable exactly once. An unsupported CLI failure after handoff is
  outcome-unknown and cannot make the rotating refresh token eligible for reuse.
- An outcome-unknown native refresh is parked as `oauth_refresh_failed` and is
  recovered only by the documented re-authentication and `claude-rotator login`
  flow, without a post-handoff fallback driver.
- An expired saved credential is never forwarded after its refresh fails.
- A late upstream TLS `EPIPE` is handled without terminating the proxy process.
- An expired or missing normal Claude Code `/login` does not block a client
  request from reaching the loopback proxy, and the local gateway placeholder
  is never forwarded upstream.
- OAuth upstream requests retain every client beta and include the required
  OAuth capability; API-key requests do not gain the OAuth capability.
- A missing proxy host defaults to IPv4 loopback, and a non-loopback host is
  rejected before settings are installed or the server starts.
- URL and placeholder changes across reinstall preserve the original settings
  that uninstall must restore, including migration from a pre-placeholder
  install state.
- macOS and Linux persistence tests continue to enforce secure storage.

### Live expiry acceptance

Before release, observe at least one natural saved-account expiry cycle without
forcing refresh:

1. Record each account ID and access-token expiry without recording any token
   value or hash, plus the daemon PID, run count, and log offsets.
2. From the 30-minute refresh window through the latest original expiry,
   require one `credential-refresh ... result=success` per account and zero new
   `failed`, `deferred`, HTTP 429, OAuth 401, or shared-cooldown events.
3. Confirm every stored expiry advanced, access and refresh credentials remain
   present, the daemon did not restart, and `doctor` reports both checks as OK.
4. After the latest original expiry, run one API-key-free Claude Code CLI prompt
   through the installed gateway and require a proxy `POST /v1/messages` 200.
5. If any condition fails, do not commit or publish the change. Preserve the
   evidence and investigate without relinking or forcing a refresh that would
   hide the failure.

## Alternatives considered

Claude Code can generate a one-year token with `claude setup-token`, but the
official documentation describes that credential as inference-only. It is not
the default here because account discovery and proactive quota rotation also
depend on profile and usage endpoints. Normal `/login` credentials therefore
remain the source for multi-account rotation.

## References

- [OAuth 2.0 RFC 6749, section 6](https://datatracker.ietf.org/doc/html/rfc6749#section-6)
- [OAuth 2.0 Security BCP RFC 9700, section 4.14](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)
- [Claude Code authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence)
- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- [Claude Code gateway protocol and request headers](https://code.claude.com/docs/en/llm-gateway-protocol#request-headers)
