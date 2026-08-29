# Claude Auth-Login Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the undocumented `claude -p` refresh side effect with the documented noninteractive `claude auth login --claudeai` contract, serialize rotating-token use across processes, and publish the verified fix to `taskbrain/claude-rotator`.

**Architecture:** The native adapter owns isolated Claude storage and one bounded auth-login child lifecycle. Secret stores expose one lock-scoped conditional-update transaction so credential re-read, exchange, and commit share the same account lock. The proxy distinguishes provider 429 cooldowns from local driver failures and parks ambiguous post-exchange outcomes without trying another refresh driver.

**Tech Stack:** Node.js ESM, `node:test`, macOS Keychain `security`, Linux private JSON credential files, launchd, Docker Node.js 20/22, GitHub CLI.

## Global Constraints

- The only automatic native refresh command is exactly `claude auth login --claudeai`.
- Set `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and space-separated `CLAUDE_CODE_OAUTH_SCOPES` only in the child environment; never place a token in argv, stdout, stderr, logs, or committed fixtures.
- Resolve the current stable Claude installer path for every attempt and pin a concrete executable before the single durable token handoff.
- Never retry through another driver after a real refresh token is provided to Claude Code.
- Wait for child close before reading or cleaning isolated credential storage.
- Hold the account's cross-process secret-store lock from credential re-read through validated credential commit.
- Preserve directory mode 0700 and credential mode 0600, reject symlinked or malformed credential output, and sanitize all errors.
- Do not use `launchctl bootout` or `unload`; deployment restarts the registered service with `launchctl kickstart -k`.
- Do not stage or modify the pre-existing untracked `ops/` or `test/macos-watchdog.test.js` files.
- Run repository lint and tests in Docker; do not use `npm run dev`.
- Do not add commit signing or Claude Code attribution.

---

### Task 1: Official Claude auth-login driver and bounded lifecycle

**Files:**
- Modify: `src/native-claude-refresher.js`
- Modify: `test/native-claude-refresher.test.js`

**Interfaces:**
- Produces: `DEFAULT_NATIVE_CLAUDE_REFRESH_ARGS = ['auth', 'login', '--claudeai']`.
- Produces: `executeNativeClaudeCommand(command, args, options) -> Promise<{stdout, stderr}>`, resolving or rejecting only after the child closes.
- Preserves: `createNativeClaudeRefresher(options)` and `refreshWithNativeClaudeCode(refreshToken, context, options)` call signatures.

- [ ] **Step 1: Write failing contract tests for the official command and environment**

Replace the inference-side-effect expectation with a literal auth-login contract. The primary test must prove the production change “putting the token back in argv or inheriting the global gateway credential” fails:

```js
assert.deepEqual(args, ['auth', 'login', '--claudeai']);
assert.equal(options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN, OLD_REFRESH_TOKEN);
assert.equal(
  options.env.CLAUDE_CODE_OAUTH_SCOPES,
  'user:profile user:inference',
);
assert.equal(options.env.ANTHROPIC_BASE_URL, undefined);
assert.equal(options.env.ANTHROPIC_AUTH_TOKEN, undefined);
assert.equal(args.includes(OLD_REFRESH_TOKEN), false);
```

The fake command writes a complete refreshed credential directly to the isolated storage; it must observe no pre-seeded `.credentials.json` on Linux and no pre-seeded isolated Keychain item on macOS.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm node --test test/native-claude-refresher.test.js
```

Expected: FAIL because the production adapter still invokes `claude -p`, seeds old credentials, omits the two official OAuth variables, and sets the loopback inference endpoint.

- [ ] **Step 3: Implement the minimal official auth-login path**

In `validatePreviousCredential`, reject an explicit non-first-party `clientId` before command execution with `NATIVE_REFRESH_UNSUPPORTED_CLIENT`. Continue backfilling `CLAUDE_AI_OAUTH_SCOPES` only for a first-party credential.

Create the isolated storage without calling `seed()`. Build the login environment from the existing allowlist plus:

```js
CLAUDE_CODE_OAUTH_REFRESH_TOKEN: previous.refreshToken,
CLAUDE_CODE_OAUTH_SCOPES: previous.scopes.join(' '),
```

Remove the inference prompt arguments and `ANTHROPIC_BASE_URL=127.0.0.1:9`. After the durable `beforeHandoff` fence, run the official login command exactly once without a separate runtime capability probe. Treat the isolated credential as the only success postcondition and preserve metadata omitted by Claude Code.

- [ ] **Step 4: Add failing tests for executable pinning and unsupported CLI failure**

Add tests that mutate a configured symlink during `beforeHandoff` and verify the sole login receives the previously pinned real target. Add an unsupported-CLI fake that rejects the token-bearing login after handoff; assert the command ran once and the error is:

```js
error.code === 'NATIVE_REFRESH_OUTCOME_UNKNOWN'
error.retryAfterMs === null
error.retryAfterSource === null
```

- [ ] **Step 5: Run the focused test and verify RED**

Run the same Docker command. Expected: FAIL because production performs a separate help invocation and does not preserve the single-spawn contract.

- [ ] **Step 6: Implement executable pinning and the single durable handoff**

Resolve an absolute configured command with `realpath` after executability checks. Confirm the shared deadline still reserves the complete child-termination grace, await the durable `beforeHandoff` fence, recalculate the remaining deadline, and then use that pinned path for the only `['auth', 'login', '--claudeai']` invocation. Do not infer capability from help text, version output, static strings, or an additional child process.

- [ ] **Step 7: Write failing child-lifecycle tests**

Use `process.execPath` fixtures to prove:

- timeout sends termination, waits for `close`, and only then permits cleanup;
- a child ignoring `SIGTERM` is killed after a 2-second maximum grace;
- output beyond 64 KiB is rejected and bounded;
- a valid isolated credential written before a non-zero exit or timeout is accepted;
- no valid new credential after token handoff becomes `NATIVE_REFRESH_OUTCOME_UNKNOWN` with no retry metadata.

The cleanup-order assertion must observe a real event sequence such as:

```js
assert.deepEqual(events, ['child-close', 'credential-read', 'credential-cleanup']);
```

- [ ] **Step 8: Run the focused test and verify RED**

Expected: FAIL because the current `Promise.race` can reject before the injected executor closes and does not terminate a process group.

- [ ] **Step 9: Implement the bounded spawn lifecycle**

Implement `executeNativeClaudeCommand` with `spawn(..., { shell: false, detached: process.platform !== 'win32' })`, bounded stdout/stderr, a wall timer, `SIGTERM`, a maximum 2-second grace, then `SIGKILL` to the process group on POSIX. Settle only from `error`/`close`, and sanitize higher-level errors. Remove the independent `Promise.race` from `executeNativeRefresh`.

- [ ] **Step 10: Run focused tests and commit**

Run:

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:20-bookworm node --test test/native-claude-refresher.test.js
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm node --test test/native-claude-refresher.test.js
```

Expected: all native refresher tests pass on both versions.

Commit only the two task files:

```bash
git add src/native-claude-refresher.js test/native-claude-refresher.test.js
git -c commit.gpgsign=false commit -m "fix(auth): 公式ログインでOAuth資格情報を更新"
```

---

### Task 2: Cross-process refresh transaction

**Files:**
- Modify: `src/secret-store.js`
- Modify: `src/proxy-server.js`
- Modify: `src/cli.js`
- Modify: `test/secret-store.test.js`
- Modify: `test/proxy-server.test.js`
- Modify: `test/cli.test.js`

**Interfaces:**
- Produces on every secret store: `updateIfUnchanged(accountId, expectedSecret, updater) -> Promise<{updated: boolean, secret: object|null}>`.
- `updater(currentSecret)` returns the complete next secret and runs while the account lock is held.
- Consumers return `{ updated: false, secret: currentSecret }` without calling `updater` when the expected snapshot is stale.

- [ ] **Step 1: Write failing Linux two-instance transaction tests**

Create two `LinuxFileSecretStore` instances over one directory, initialize one expired credential, and concurrently call `updateIfUnchanged` with the same expected value. Block the first updater long enough for the second call to contend. Assert a literal outcome:

```js
assert.equal(exchangeCalls, 1);
assert.deepEqual(results.map(result => result.secret.accessToken), [
  'rotated-access',
  'rotated-access',
]);
assert.deepEqual(await first.get('acct_1'), rotatedSecret);
```

Also assert an updater exception leaves the original secret unchanged and releases the lock.

- [ ] **Step 2: Run the secret-store test and verify RED**

Run:

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm node --test test/secret-store.test.js
```

Expected: FAIL because `updateIfUnchanged` does not exist.

- [ ] **Step 3: Implement conditional updates under the existing account lock**

For Linux and macOS, enter `accountLock.run`, re-read with `getUnlocked`, compare using `isDeepStrictEqual`, await the updater only on an exact match, write with `setUnlocked`, and return the stored value. Pass the macOS lease into `setUnlocked` so Keychain child PID fencing remains active. For `MemorySecretStore`, add a per-account promise queue so asynchronous updater calls are serialized in tests and injected deployments.

- [ ] **Step 4: Add failing proxy and doctor integration tests**

Change the “atomic compare-and-set unavailable” fixtures to require `updateIfUnchanged`. Add one proxy test and one doctor test where the store changes before the lock-scoped re-read. Assert the refresher is not called and the newer credential is used. Add a proxy test in which the updater throws after starting and assert no competing invocation starts before the first lock releases.

- [ ] **Step 5: Run focused tests and verify RED**

Run:

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm node --test \
  test/secret-store.test.js test/proxy-server.test.js test/cli.test.js
```

Expected: FAIL because proxy and doctor still refresh before entering the store lock.

- [ ] **Step 6: Route every stored-account refresh through the transaction**

Replace the refresh-then-`compareAndSet` sequence in `refreshAndStoreSecret` and `refreshDoctorSecret` with `updateIfUnchanged`. The updater merges the driver result into the locked current credential. If the snapshot changed, return the latest credential and log `result=discarded reason=credential-changed` without invoking the driver. Fail closed when the store lacks the new interface.

- [ ] **Step 7: Run focused tests and commit**

Run the focused command on Node 20 and 22. Expected: all selected tests pass.

Commit only task files:

```bash
git add src/secret-store.js src/proxy-server.js src/cli.js \
  test/secret-store.test.js test/proxy-server.test.js test/cli.test.js
git -c commit.gpgsign=false commit -m "fix(auth): OAuth更新をアカウントロック内で直列化"
```

---

### Task 3: Separate provider throttling from local refresh failures

**Files:**
- Modify: `src/oauth.js`
- Modify: `src/account-manager.js`
- Modify: `src/proxy-server.js`
- Modify: `test/oauth.test.js`
- Modify: `test/account-manager.test.js`
- Modify: `test/proxy-server.test.js`

**Interfaces:**
- `isOAuthTokenRefreshRateLimit(error)` returns true only for a provider HTTP 429.
- Produces: `AccountManager.markCredentialRefreshDeferred(accountId, retryAfterSeconds, metadata)` with unavailable reason type `oauth_refresh_retry`.
- Preserves provider reason type `oauth_refresh_rate_limit` for actual 429 responses.

- [ ] **Step 1: Write failing classification tests**

Add literal cases proving:

```js
assert.equal(isOAuthTokenRefreshRateLimit(nativeFixedError), false);
assert.equal(isOAuthTokenRefreshRateLimit(provider429Error), true);
```

Add AccountManager and proxy tests proving a safe pre-handoff native command failure with fixed retry metadata produces `oauth_refresh_retry`, while provider 429 still produces `oauth_refresh_rate_limit`. Add an outcome-unknown error without retry metadata and assert it becomes persistent `oauth_refresh_failed`, not a cooldown.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm node --test \
  test/oauth.test.js test/account-manager.test.js test/proxy-server.test.js
```

Expected: FAIL because fixed local retries are currently classified as OAuth rate limits.

- [ ] **Step 3: Implement distinct cooldown handling**

Restrict `isOAuthTokenRefreshRateLimit` to `OAuthTokenRefreshError`/status 429. Add a shared credential-cooldown predicate covering `oauth_refresh_rate_limit` and `oauth_refresh_retry` in AccountManager selection, authenticated-state clearing, credential-revision reset, restore bounds, and proxy availability checks. In proxy error handling, map provider 429 first, then other positive `retryAfterMs` to `markCredentialRefreshDeferred`, and leave errors without retry metadata as `oauth_refresh_failed`.

- [ ] **Step 4: Run focused tests and commit**

Run focused tests on Node 20 and 22. Expected: all selected tests pass.

```bash
git add src/oauth.js src/account-manager.js src/proxy-server.js \
  test/oauth.test.js test/account-manager.test.js test/proxy-server.test.js
git -c commit.gpgsign=false commit -m "fix(auth): ローカル更新失敗を429から分離"
```

---

### Task 4: Operator documentation and compatibility evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/specs/2026-07-10-oauth-credential-lifecycle-design.md`
- Test: `test/native-claude-refresher.test.js`

**Interfaces:**
- Documents the official two-variable plus auth-login contract.
- Documents automatic use of newly installed Claude versions and the single durable handoff.
- Documents outcome-unknown parking and recovery with `claude-rotator login`.

- [ ] **Step 1: Update English and Japanese operator documentation**

Replace every description of “seeding an expired credential and triggering native preflight refresh” with the official auth-login flow. State explicitly that:

- current Claude installer-path updates are followed without a version allowlist;
- each attempt pins one real executable, records durable intent, and runs one token-bearing login;
- no driver fallback occurs after token handoff;
- local driver cooldowns are distinct from provider 429;
- a parked credential is recovered by re-authenticating that account and running `claude-rotator login`.

Keep the refresh-token environment visibility caveat scoped to same-user local processes and do not include any real account identifier or credential.

- [ ] **Step 2: Run the secret-free installed-version compatibility matrix**

Run the installed binaries with isolated temporary config and dummy tokens, a bounded timeout, a dead proxy, and no normal Keychain item. Verify 2.1.229, 2.1.231, and 2.1.232 all:

- require `CLAUDE_CODE_OAUTH_SCOPES` when only a dummy refresh token is supplied;
- take the noninteractive direct-exchange path when both dummy values are supplied;
- do not create a valid credential and do not open a browser.

Do not modify the user's real Claude credential. Record only exit status, elapsed time, and redacted error class in the PR verification notes; do not commit generated logs.

- [ ] **Step 3: Run documentation checks and commit**

Run `git diff --check` and the native refresher test in Docker Node 22. Expected: exit 0.

```bash
git add README.md docs/specs/2026-07-10-oauth-credential-lifecycle-design.md
git -c commit.gpgsign=false commit -m "docs(auth): 公式OAuth更新と復旧手順を記載"
```

---

### Task 5: Full verification, safe Mac deployment, and GitHub publication

**Files:**
- Verify all tracked files changed by Tasks 1-4 and the committed design/plan.
- Deploy only the tested runtime files under `src/` to the installed package.
- Do not add the pre-existing untracked watchdog files.

**Interfaces:**
- Installed package root: resolve from the active LaunchAgent command and verify it matches the tested source baseline before replacement.
- Service target: `gui/$(id -u)/io.github.claude-rotator`.
- Health endpoint: `http://127.0.0.1:37891/internal/health`.
- GitHub target: `taskbrain/claude-rotator`, base `main`, assignee `Earthfreedom`.

- [ ] **Step 1: Run the complete Docker matrix**

```bash
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:20-bookworm npm run check
docker run --rm --network none -v "$PWD:/workspace:ro" -w /workspace \
  node:22-bookworm npm run check
```

Expected: lint exit 0 and every test passes, with only platform-declared skips.

- [ ] **Step 2: Review the complete branch diff**

Run `git diff --check`, confirm every intended path, confirm `ops/` and `test/macos-watchdog.test.js` remain untracked and unstaged, and obtain a whole-branch code review. Fix all Critical and Important findings with covering tests and re-run the full matrix.

- [ ] **Step 3: Deploy with backup and rollback**

Resolve the installed package from `launchctl print`, verify the deployed files match the expected pre-change commit, and create a timestamped private backup directory. Copy the changed runtime files to same-directory temporary files with preserved mode, rename atomically, then run:

```bash
/bin/launchctl kickstart -k "gui/$(id -u)/io.github.claude-rotator"
```

Never use `bootout` or `unload`. Poll health for at most 30 seconds. On any copy, start, health, or smoke failure, restore only the backed-up files atomically, `kickstart -k` again, and verify health before reporting the failure.

- [ ] **Step 4: Verify the real refresh and API path**

Verify the official driver with the current installed Claude Code binary and an account whose stored access credential needs refresh. Confirm a rotated validated credential is saved, `credential-refresh ... result=success` appears without secrets, `/internal/health` is 200, and a bounded `claude -p --no-session-persistence 'Reply exactly OK'` through the Rotator returns `OK`. If no testable valid refresh credential remains, relink one account through the documented operator login flow before the smoke; never print or copy its token into a command line.

- [ ] **Step 5: Commit any verification fixes and publish**

Ensure the final tree is verified and all intended changes are committed with Conventional Commits. Push the branch without force:

```bash
git push -u origin codex/fix-auth-login-refresh-20260814
```

Create a draft Pull Request against `main`, assign `Earthfreedom`, and write the title/body in Japanese. Include root cause, change, impact, Docker Node 20/22 results, macOS installed-version compatibility evidence, deployment result, and remaining limitations. Report the branch, commit hashes, PR URL, deployed service status, and any residual risk.
