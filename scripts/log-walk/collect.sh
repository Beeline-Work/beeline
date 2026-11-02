#!/usr/bin/env bash
# Stream one Fly app's logs into <raw>/<app>/<UTC date>.log, forever.
# Fly keeps only ~100 lines of history, so the walk needs this running.
# Usage: collect.sh <fly-app> <raw-dir>   (systemd: beeline-log-collector@<app>.service)
set -u
app="$1"
dir="$2/$app"
mkdir -p "$dir"
export NO_COLOR=1
flyctl="${LOG_COLLECT_FLYCTL:-flyctl}"
window="${LOG_COLLECT_WINDOW_SECONDS:-600}"
grace="${LOG_COLLECT_KILL_AFTER_SECONDS:-30}"
pause="${LOG_COLLECT_PAUSE_SECONDS:-5}"
# mawk buffers piped input unless told otherwise; gawk has no such flag.
awk_flags=()
awk -W version 2>&1 | grep -q mawk && awk_flags=(-W interactive)
while true; do
  # Last timestamp already written, so a reconnect's replayed buffer is skipped
  # (lines in that same second too, or each reconnect would duplicate them).
  days=("$dir"/20*.log)  # Day files sort by name, so the last is the newest.
  last="$(tail -qn1 "${days[-1]}" 2>/dev/null | cut -d' ' -f1)"
  # Reconnect every window in case the stream hangs silently. flyctl can catch
  # SIGTERM and never exit (2026-10-31: wedged for two days), so -k kills it.
  timeout -k "$grace" "$window" "$flyctl" logs -a "$app" 2>>"$dir/collector.err" \
    | sed -u 's/\x1b\[[0-9;]*m//g' \
    | awk "${awk_flags[@]}" -v dir="$dir" -v last="$last" '
        $1 ~ /^20[0-9][0-9]-/ { if ($1 <= last) next; f = dir "/" substr($1, 1, 10) ".log" }
        f == "" { next }
        # Lines without a timestamp (proxy error details) go to the current day file.
        { print >> f; fflush(f) }'
  # Keep 8 days.
  find "$dir" -name '*.log' -mtime +8 -delete
  sleep "$pause"
done
