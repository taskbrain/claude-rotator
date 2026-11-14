# caseG expiry helper and check scripts (test-only)

Test-only tools for the caseG T4/T5 runbooks. They are not part of the shipped package: `src/` is unchanged,
and `package.json` publishes only `bin`, `src`, `README.md` and `LICENSE`.

## expiry-helper.js

Compares the access-token expiry of one Claude Code Keychain item before and after, without printing it.

- Reads: one generic-password item, scoped by service name (`Claude Code-credentials-<first 8 hex of
  sha256(config dir)>`, checked against `--config-dir`), `--acct` and `--keychain`. Before the read it lists
  the search list and requires exactly one matching item, in the given keychain, with matching `svce`/`acct`.
  It scans again after the read and stops if the item changed in between.
- Prints at most: `withinMargin=<true|false>` (expires within 5 minutes), `deltaMin=<none|+N|-N>` (minutes the
  expiry moved since the previous run), and `remainingMin10=<N>` (minutes left, rounded to 10) only when the
  expiry moved forward.
- Never prints, logs, stores or throws the token, the credential JSON or the expiry time. Failures print only
  `expiry-helper: stopped reason=<code>` and exit 2.
- Never writes to the Keychain (only `list-keychains` and `find-generic-password` are allowed; `-g` is refused;
  `-w` is used once, on the scoped keychain). Never refreshes anything.
- Writes only the state file: one JSON line binding the previous expiry number to the service name, acct and
  keychain path it came from (no token, no credential), mode 0600, directly inside `--run-dir`. A state file
  written for a different item is not compared: the helper stops with `reason=state-mismatch`. A temp file
  left by an interrupted run is removed on the next write and by `--clear-state`.
  The run dir may not be or contain `~/.claude`, `~/.config/claude-rotator`, `~/Library/Keychains` or the
  account folder. `--clear-state` deletes it at the end of a run.
- Refuses to run unless `CASEG_EXPIRY_ENABLE=1`, under the Node test runner, or off macOS.

```
CASEG_EXPIRY_ENABLE=1 node experiments/caseG-expiry/expiry-helper.js \
  --config-dir <account folder> --service "Claude Code-credentials-<8 hex>" --acct <acct> \
  --keychain <path to login.keychain-db> --run-dir <run dir> --state <run dir>/expiry.state
CASEG_EXPIRY_ENABLE=1 node experiments/caseG-expiry/expiry-helper.js --clear-state \
  --run-dir <run dir> --state <run dir>/expiry.state
```

Reading the item with `-w` can show the macOS Keychain prompt. Answer "Allow" only; never "Always Allow".
The raw credential string is held in memory until the read returns; the parser keeps only `expiresAt`.

## caseG-T4-check.sh / caseG-T5-check.sh

Read-only checks: Keychain attributes (no `-g`/`-w`), processes that open the account folder(s) (`lsof`,
`pgrep`, process names only; no environment), protected PIDs, 3789x/3799x listeners, the sha256 of the
rotator config (content not printed), and counts from the prototype proxy log (lines not printed). The T5
script also lists launchd job names containing "claude" and counts crontab lines (lines not printed), lists
every Claude Code process (named `claude`, or launched as `.../claude/versions/<version>`, whose process name is
the version) with PID, start time, cwd and launch path, and prints the newest mtime under the k and j folders
(time and relative path only). A session that selects its account only through `CLAUDE_CONFIG_DIR` in its
environment cannot be tied to a folder by these checks. The process list is a record only: new PIDs during
the run are not a pass/fail criterion (decision 2026-11-14). The T5 verdict for j instead uses its Keychain
item `mdat` and the newest mtime under the j folder, which must be the same before and after; the script prints
both, with the email fingerprint, in a final `## j の判定材料` block.

The T5 script also reads, from every `.claude.json` it finds, only `oauthAccount.emailAddress` (with
`jq -r '(.oauthAccount.emailAddress // empty) | select(type == "string")'`; no other key or value is read or
printed, and a value that does not look like an email is withheld). It checks the j and k folders and every
`.claude.json` within 4 levels of `$HOME`, `/private/tmp` and `$TMPDIR` (the production rotator's refresh
sandboxes live there; its `config.json` has no per-account folder), skipping `Library`, `.Trash`,
`node_modules`, caches and `.git`. A "Permission denied" folder owned by another user (for example under
`/private/tmp`) is listed as not searched; any other search error makes the run unverified. It prints folder, email and file mtime, and a fingerprint (first 16 hex of
sha256 over the sorted folder/email pairs, times excluded) to compare the run before and after. If j's email is
also logged in in any other folder, the script prints `!! NG: ...` and exits 4.

A failed lookup is never read as "none" or "0": a Keychain search that fails with anything other than
"not found" (exit 44), a failed `lsof`/`pgrep`/`launchctl`/`crontab`, an `lsof` that reports paths it
could not see (its warnings are kept, never silenced with `-w`; any stderr output makes the search
incomplete), a Keychain count other than one, a missing protected PID, a missing or unreadable rotator config,
a `.claude.json` that cannot be parsed, an incomplete `.claude.json` search, a j folder without an email,
or a proxy log line whose fields cannot be read prints `!! 未確認: ...` and the script exits 3 after printing
the rest. NG (exit 4) takes precedence over unverified (exit 3). Exit 0 means every lookup succeeded. The script's own process, its subshells and its ancestors
(the calling shell and terminal) are not counted as processes holding a folder; their PIDs are printed.

```
experiments/caseG-expiry/caseG-T4-check.sh <account folder> [requests.jsonl] [acct]
experiments/caseG-expiry/caseG-T5-check.sh <k folder> <j folder> [requests.jsonl] [acct]
```

`CASEG_CHECK_BIN`, `CASEG_ROTATOR_CONFIG`, `CASEG_PROTECT_PIDS` and `CASEG_EMAIL_ROOTS` exist for the mock tests; leave them unset
in a real run.

## Tests

Mock-only (fake Keychain backend, fake commands on PATH, temp HOME):

```
node --import ./fixtures/service-command-guard.js --test experiments/caseG-expiry/test/*.test.js
```
