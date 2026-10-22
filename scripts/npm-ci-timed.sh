#!/usr/bin/env bash
# `npm ci` that shows where its time went: wall time, registry cache hits and
# misses, and the slowest fetches. Release jobs use it so a slow install names
# its cause in the job log. Arguments pass through to `npm ci`.
set -uo pipefail
log=$(mktemp)
started=$SECONDS
npm ci --no-audit --no-fund --loglevel=http "$@" > "$log" 2>&1
status=$?
elapsed=$((SECONDS - started))
grep -v '^npm http fetch' "$log"
fetches=$(grep -c '^npm http fetch' "$log")
misses=$(grep '^npm http fetch' "$log" | grep -c 'cache miss')
echo "npm ci ${*:-.}: ${elapsed}s, ${fetches} registry fetches, ${misses} cache misses"
if [ "$fetches" -gt 0 ]; then
  echo 'Slowest fetches:'
  grep '^npm http fetch' "$log" | sed -E 's/^.* ([0-9]+)ms(.*)$/\1ms &/' | sort -rn | head -n 10
fi
rm -f "$log"
exit "$status"
