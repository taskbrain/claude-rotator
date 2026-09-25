#!/usr/bin/env bash
# cache-report.sh -- summarize prompt-cache usage from claude-rotator's server.log.
#
# Reads the key=value fields that src/usage-observation.js (observationLogFields)
# appends to each `proxy` line: model, sid, in, out, cr, cc, c1h, c5m, usageParse.
# Only lines that carry `model=` (i.e. the observation fields) are counted.
#
#   hit rate = cr / (in + cr + cc)
#
# Log timestamps are ISO 8601 in UTC (e.g. 2026-09-25T00:13:14.805Z), so the
# --since cutoff is computed and printed in UTC as well.
#
# Usage:
#   scripts/cache-report.sh [--since <N>{m|h|d}] [--by model|sid|account|none]
#                           [--json] [--log <path>]...
#
#   --since  time window counted back from now (default 1h)
#   --by     grouping key (default model). `account` is the account ID that the
#            proxy line already carries (the email address with symbols replaced).
#   --json   machine-readable output
#   --log    read this file instead of server.log.1 + server.log; repeatable
#
# Read-only: it never touches config.json, the service, or the network.
# Portable to macOS /usr/bin/awk and bash 3.2 (no gawk extensions).

set -euo pipefail

usage() {
  sed -n '13,21p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

since="1h"
by="model"
json=0
logs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --since) [ $# -ge 2 ] || usage; since="$2"; shift 2 ;;
    --by) [ $# -ge 2 ] || usage; by="$2"; shift 2 ;;
    --json) json=1; shift ;;
    --log) [ $# -ge 2 ] || usage; logs+=("$2"); shift 2 ;;
    -h|--help) usage ;;
    *) echo "cache-report: unknown option: $1" >&2; usage ;;
  esac
done

case "$by" in
  model|sid|account|none) ;;
  *) echo "cache-report: --by must be model, sid, account or none" >&2; exit 2 ;;
esac

if ! printf '%s' "$since" | grep -Eq '^[0-9]{1,6}[mhd]$'; then
  echo "cache-report: --since must be 1-6 digits followed by m, h or d (e.g. 30m, 1h, 7d): $since" >&2
  exit 2
fi
# 10# forces base 10, so a leading zero (08h) is not read as octal.
amount=$((10#${since%?}))
if [ "$amount" -eq 0 ]; then
  echo "cache-report: --since must be greater than zero: $since" >&2
  exit 2
fi
case "$since" in
  *m) window=$((amount * 60)) ;;
  *h) window=$((amount * 3600)) ;;
  *d) window=$((amount * 86400)) ;;
esac

cutoff_epoch=$(( $(date -u +%s) - window ))
# BSD date (macOS) takes -r <epoch>; GNU date takes -d @<epoch>.
cutoff=$(date -u -r "$cutoff_epoch" +%Y-%m-%dT%H:%M:%S 2>/dev/null \
  || date -u -d "@$cutoff_epoch" +%Y-%m-%dT%H:%M:%S)

if [ ${#logs[@]} -eq 0 ]; then
  if [ -n "${CLAUDE_ROTATOR_CONFIG:-}" ]; then
    dir=$(dirname "$CLAUDE_ROTATOR_CONFIG")
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    dir="$XDG_CONFIG_HOME/claude-rotator"
  else
    dir="$HOME/.config/claude-rotator"
  fi
  # Oldest generation first so the lines stay in time order.
  for f in "$dir/server.log.1" "$dir/server.log"; do
    [ -f "$f" ] && logs+=("$f")
  done
  if [ ${#logs[@]} -eq 0 ]; then
    echo "cache-report: no server.log found in $dir" >&2
    exit 1
  fi
fi

inputs=()
for f in "${logs[@]}"; do
  if [ ! -r "$f" ]; then
    echo "cache-report: cannot read $f" >&2
    exit 1
  fi
  # Skip a whole file whose newest line is already older than the window.
  last=$(tail -n 1 "$f" | cut -c1-19)
  case "$last" in
    [0-9][0-9][0-9][0-9]-*) [ "$last" \< "$cutoff" ] && continue ;;
  esac
  inputs+=("$f")
done

files_list=$(printf '%s\n' "${logs[@]}")
export CR_FILES="$files_list"

TAB=$(printf '\t')

aggregate() {
  if [ ${#inputs[@]} -eq 0 ]; then
    return 0
  fi
  LC_ALL=C awk -v cutoff="$cutoff" -v by="$by" '
    $1 < cutoff { next }
    $2 != "proxy" { next }
    {
      model = ""; sid = "-"; account = "-"; parse = ""
      tin = 0; tcr = 0; tcc = 0; t1h = 0; t5m = 0
      for (i = 3; i <= NF; i++) {
        p = index($i, "=")
        if (p == 0) continue
        k = substr($i, 1, p - 1); v = substr($i, p + 1)
        if (k == "model") model = v
        else if (k == "sid") sid = v
        else if (k == "account") account = v
        else if (k == "in") tin = v + 0
        else if (k == "cr") tcr = v + 0
        else if (k == "cc") tcc = v + 0
        else if (k == "c1h") t1h = v + 0
        else if (k == "c5m") t5m = v + 0
        else if (k == "usageParse") parse = v
      }
      if (model == "") next
      if (by == "model") key = model
      else if (by == "sid") key = sid
      else if (by == "account") key = account
      else key = "all"
      n[key]++; aIn[key] += tin; aCr[key] += tcr; aCc[key] += tcc
      a1h[key] += t1h; a5m[key] += t5m
      if (parse == "no-usage") aNo[key]++
    }
    END {
      for (key in n)
        printf "%s\t%d\t%.0f\t%.0f\t%.0f\t%.0f\t%.0f\t%d\n", key, n[key], aIn[key], aCr[key], aCc[key], a1h[key], a5m[key], aNo[key]
    }
  ' "${inputs[@]}"
}

aggregate | LC_ALL=C sort -t "$TAB" -k2,2nr -k1,1 | LC_ALL=C awk -F '\t' \
  -v json="$json" -v cutoff="$cutoff" -v since="$since" -v by="$by" '
  function rate(cr, total) { return total > 0 ? cr / total : -1 }
  function jstr(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return "\"" s "\"" }
  function jrow(key, n, tin, cr, cc, c1h, c5m, nou,   r, out) {
    r = rate(cr, tin + cr + cc)
    out = "{"
    if (key != "") out = out "\"key\":" jstr(key) ","
    out = out "\"requests\":" n ",\"hitRate\":" (r < 0 ? "null" : sprintf("%.4f", r))
    out = out ",\"in\":" sprintf("%.0f", tin) ",\"cr\":" sprintf("%.0f", cr) ",\"cc\":" sprintf("%.0f", cc)
    out = out ",\"c1h\":" sprintf("%.0f", c1h) ",\"c5m\":" sprintf("%.0f", c5m) ",\"noUsage\":" nou "}"
    return out
  }
  function trow(key, n, tin, cr, cc, c1h, c5m, nou,   r) {
    r = rate(cr, tin + cr + cc)
    printf fmt, key, n, (r < 0 ? "-" : sprintf("%.1f%%", r * 100)), tin, cr, cc, c1h, c5m, nou
  }
  {
    rows++
    k[rows] = $1; n[rows] = $2; tin[rows] = $3; cr[rows] = $4; cc[rows] = $5
    c1h[rows] = $6; c5m[rows] = $7; nou[rows] = $8
    T[2] += $2; T[3] += $3; T[4] += $4; T[5] += $5; T[6] += $6; T[7] += $7; T[8] += $8
    if (length($1) > width) width = length($1)
  }
  END {
    nf = split(ENVIRON["CR_FILES"], files, "\n")
    if (json == 1) {
      printf "{\"since\":%s,\"window\":%s,\"by\":%s,\"files\":[", jstr(cutoff "Z"), jstr(since), jstr(by)
      for (i = 1; i <= nf; i++) printf "%s%s", (i > 1 ? "," : ""), jstr(files[i])
      printf "],\"groups\":["
      for (i = 1; i <= rows; i++)
        printf "%s%s", (i > 1 ? "," : ""), jrow(k[i], n[i], tin[i], cr[i], cc[i], c1h[i], c5m[i], nou[i])
      printf "],\"total\":%s}\n", jrow("", T[2] + 0, T[3], T[4], T[5], T[6], T[7], T[8] + 0)
      exit
    }
    printf "cache report: since %sZ (UTC, last %s), by %s\n", cutoff, since, by
    for (i = 1; i <= nf; i++) printf "  log: %s\n", files[i]
    if (rows == 0) { print "no proxy lines with cache fields in this window"; exit }
    if (width < 5) width = 5
    fmt = "%-" width "s %7s %6s %12s %13s %12s %12s %12s %8s\n"
    printf fmt, by, "reqs", "hit", "in", "cr", "cc", "c1h", "c5m", "noUsage"
    fmt = "%-" width "s %7d %6s %12.0f %13.0f %12.0f %12.0f %12.0f %8d\n"
    for (i = 1; i <= rows; i++) trow(k[i], n[i], tin[i], cr[i], cc[i], c1h[i], c5m[i], nou[i])
    trow("TOTAL", T[2], T[3], T[4], T[5], T[6], T[7], T[8])
    print "hit = cr / (in + cr + cc)"
  }
'
