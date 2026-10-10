#!/usr/bin/env bash
# Capture only Room first-frame marks. A full launch report needs other routes.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
device="${LATENCY_RIG_DEVICE:-emulator-5580}"
room_id="${LATENCY_RIG_ROOM_ID:-f13fbac4-e500-4f81-8c20-78bc02c3aac8}"
count="${LATENCY_RIG_ROOM_SAMPLES:-20}"
output_dir="${1:-$repo_dir/scripts/latency-rig/.local/capture}"
if ! [[ "$count" =~ ^[0-9]+$ ]] || (( count < 20 )); then
  echo 'LATENCY_RIG_ROOM_SAMPLES must be at least 20' >&2
  exit 2
fi
if [[ ! "$room_id" =~ ^[0-9a-f-]{36}$ ]]; then
  echo 'Invalid local fixture Room id' >&2
  exit 2
fi
mkdir -p "$output_dir"
adb -s "$device" logcat -c
for (( sample=1; sample<=count; sample++ )); do
  adb -s "$device" shell am start -W -a android.intent.action.VIEW \
    -d 'beeline://beeline/channels' app.usebeeline/.MainActivity >/dev/null
  sleep 1
  adb -s "$device" shell am start -W -a android.intent.action.VIEW \
    -d "beeline://beeline/chat/$room_id" app.usebeeline/.MainActivity >/dev/null
  sleep 2
done
adb -s "$device" logcat -d -v epoch >"$output_dir/logcat.txt"
node "$repo_dir/scripts/latency-rig/room-marks.mjs" \
  "$output_dir/logcat.txt" "$output_dir/moments.ndjson" warm
actual="$(wc -l <"$output_dir/moments.ndjson")"
if (( actual < count )); then
  echo "Only $actual of $count requested Room marks were captured" >&2
  exit 1
fi
node "$repo_dir/scripts/latency-rig/join.mjs" \
  --moments "$output_dir/moments.ndjson" \
  --proxy "${LATENCY_RIG_PROXY_LOG:-$repo_dir/scripts/latency-rig/local-proxy.ndjson}" \
  --sql "${LATENCY_RIG_SQL_LOG:-$repo_dir/scripts/latency-rig/local-sql.ndjson}" \
  --out "$output_dir/samples.ndjson"
node "$repo_dir/scripts/latency-rig/analyze.mjs" \
  --input "$output_dir/samples.ndjson" --commit "$(git rev-parse HEAD)" \
  --device "$device" --network "${LATENCY_RIG_NETWORK_DESCRIPTION:-local shaped proxy}" \
  --note 'Room-only smoke. This x86 emulator has no A15 CPU calibration; local HTTP excludes TLS and production RTT. It cannot establish the launch budget.' \
  --out "$output_dir/room-report.md"
echo "Room-only report: $output_dir/room-report.md"
