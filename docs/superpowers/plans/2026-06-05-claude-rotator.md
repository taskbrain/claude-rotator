# Claude Rotator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone macOS/Linux Claude Code rotator that keeps the `claude` command unchanged by routing Claude Code through a local proxy configured in `~/.claude/settings.json`.

**Architecture:** A Node.js CLI exposes install, uninstall, login, server, status, monitor, switch, and doctor commands. The server is an Anthropic-compatible localhost proxy that selects credentials from a secure storage abstraction and updates per-account quota state from response headers and optional OAuth usage polling.

**Tech Stack:** Node.js 18+ ESM, built-in `http`, `node:test`, macOS Keychain through `security`, Linux file storage with `0600` credentials, LaunchAgent/systemd user service files.

---

### Task 1: Core Utilities And Config

**Files:**
- Create: `src/paths.js`
- Create: `src/json-file.js`
- Create: `src/config.js`
- Test: `test/config.test.js`

- [ ] Write failing tests for XDG paths, atomic JSON writing, default config, and `ANTHROPIC_BASE_URL` install merge behavior.
- [ ] Run `npm test test/config.test.js` and confirm the tests fail because modules do not exist.
- [ ] Implement path helpers, JSON helpers, config load/save, and Claude settings merge/restore helpers.
- [ ] Run `npm test test/config.test.js` and confirm the tests pass.

### Task 2: Secret Storage

**Files:**
- Create: `src/secret-store.js`
- Test: `test/secret-store.test.js`

- [ ] Write tests for Linux file store permissions and a fake in-memory store.
- [ ] Run `npm test test/secret-store.test.js` and confirm failure.
- [ ] Implement storage interface, Linux file store, macOS Keychain shell wrapper, and memory store for tests.
- [ ] Run `npm test test/secret-store.test.js` and confirm pass.

### Task 3: Account Manager And Quota

**Files:**
- Create: `src/quota.js`
- Create: `src/account-manager.js`
- Test: `test/account-manager.test.js`

- [ ] Write tests for quota header parsing, threshold switching, reset expiry, manual switch, and status output without secrets.
- [ ] Run `npm test test/account-manager.test.js` and confirm failure.
- [ ] Implement quota parsing and account selection.
- [ ] Run `npm test test/account-manager.test.js` and confirm pass.

### Task 4: OAuth Helpers

**Files:**
- Create: `src/oauth.js`
- Test: `test/oauth.test.js`

- [ ] Write tests for expiry normalization, expiring-soon detection, token refresh response parsing, and usage response parsing.
- [ ] Run `npm test test/oauth.test.js` and confirm failure.
- [ ] Implement PKCE URL creation, token refresh, profile fetch, and usage fetch helpers.
- [ ] Run `npm test test/oauth.test.js` and confirm pass.

### Task 5: Proxy Server

**Files:**
- Create: `src/proxy-server.js`
- Test: `test/proxy-server.test.js`

- [ ] Write tests with a local upstream server verifying auth rewrite, rate header capture, no secret exposure in status, and health endpoint.
- [ ] Run `npm test test/proxy-server.test.js` and confirm failure.
- [ ] Implement localhost proxy server and internal endpoints.
- [ ] Run `npm test test/proxy-server.test.js` and confirm pass.

### Task 6: Install And Service Management

**Files:**
- Create: `src/install.js`
- Test: `test/install.test.js`

- [ ] Write tests for install manifest, settings backup, uninstall restore, conflict detection, LaunchAgent content, and systemd content.
- [ ] Run `npm test test/install.test.js` and confirm failure.
- [ ] Implement install/uninstall and service file generation. Service start/stop commands are skipped in tests.
- [ ] Run `npm test test/install.test.js` and confirm pass.

### Task 7: CLI And Monitor

**Files:**
- Create: `bin/claude-rotator.js`
- Create: `src/cli.js`
- Create: `src/monitor.js`
- Test: `test/monitor.test.js`
- Test: `test/cli.test.js`

- [ ] Write tests for command dispatch, status rendering, progress bars, and monitor one-shot output.
- [ ] Run `npm test test/monitor.test.js test/cli.test.js` and confirm failure.
- [ ] Implement CLI dispatch and monitor rendering.
- [ ] Run `npm test test/monitor.test.js test/cli.test.js` and confirm pass.

### Task 8: Docs And Verification

**Files:**
- Modify: `README.md`
- Create: `scripts/lint.js`

- [ ] Add setup, install, uninstall, account registration, monitor, and recovery docs.
- [ ] Add a small lint script that checks syntax and forbidden secret logging patterns.
- [ ] Run Docker validation:
  `docker run --rm -v "$PWD":/app -w /app node:22-alpine npm run check`
- [ ] Commit with Conventional Commits.
- [ ] Create a private GitHub repository under the taskbrain organization using `gh repo create taskbrain/claude-rotator --private --source . --remote origin --push`.

---

## Self-Review

- Spec coverage: install/uninstall, proxy, macOS/Linux secret storage, monitor dashboard, logging, and verification are covered by tasks.
- Placeholder scan: no TBD/TODO placeholders are intentionally left in the plan.
- Type consistency: account IDs, quota fields, and status fields are defined before CLI/status rendering tasks.
