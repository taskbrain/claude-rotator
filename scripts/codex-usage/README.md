# Codex usage samples and forecast

Run `node scripts/codex-usage/collect.js` once an hour. It calls
`$HOME/.local/bin/codex-rotator status --json` exactly once, records each account's
windows, then publishes the first daily forecast during **08:00–20:59 JST**.
It uses only Node's standard library, with no AI calls or automatic retries.
The report is **display only**; do not use it to make routing decisions.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOME` | Process home | Base for the default executable and output directory |
| `CODEX_USAGE_ROTATOR` | `$HOME/.local/bin/codex-rotator` | Executable path (use a fake for tests) |
| `CODEX_USAGE_DIR` | `$HOME/.claude/work/routing` | Output directory |

Outputs in that directory:

- `codex-usage-samples.jsonl`: one row per account/window/observation. Fields are
  `label`, `window` (`fiveHour`, `weekly`, or `other`), `usedPercent`, `resetAt`,
  `windowMinutes`, `observedAt`, `fresh`, and account `state`. Repeated observations
  in the same window are not appended again.
- `codex-usage-forecast-YYYY-MM-DD.json`: authoritative daily report (JST date).
- `codex-usage-forecast-YYYY-MM-DD.md` and `latest.json`: derived from that day's
  JSON, including when a later run needs to recreate a missing derived file.

The forecast uses least squares with at least three distinct observation times,
matching `label`, window kind, `resetAt`, and `windowMinutes`. Only points that
were `fresh` when collected count; historical points are not aged out using the
rotator's short freshness timeout. The current value must also be `fresh` and
the reset must still be in the future. A changed reset or unknown window identity
does not borrow points from another window.

Window results are `reaches-90` (90% before reset, with `reachesAt`),
`not-reaching` (nonpositive pace or arrival at/after reset), or `unknown`
(stale, insufficient points, or missing data), with an explicit `reason`.
Rates are percentage points per hour. An account with no windows has an empty
`windows` array and is shown as indeterminate in Markdown. All JSON times are UTC;
the report date and publishing hours use JST. The first report may be indeterminate
and remains unchanged that day, even if later samples are sufficient.

Daily publication uses a date-specific `mkdir` lock and renames a temporary JSON
into place. The daily JSON itself means completion. A normal failure releases the
lock; if the process is forcibly killed, remove its `.lock` directory manually
after confirming the collector is no longer running. An hourly launchd job runs
one collector at a time; do not overlap manual collection with it. No backfill is
performed for sleep or missed hours. Sample history is append-only and is not
automatically pruned. A failed rotator call exits nonzero with a short stderr
message and makes no output changes.

Focused tests (temporary HOME and fake executable):

```sh
node --import ./fixtures/service-command-guard.js --test test/codex-usage.test.js
```
