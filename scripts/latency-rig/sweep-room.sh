#!/usr/bin/env bash
# Compare the same signed local Room under four shaped-network scenarios.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
output_dir="${1:-$repo_dir/scripts/latency-rig/.local/rtt-sweep}"
proxy_port="${LATENCY_RIG_PORT:-8081}"
mkdir -p "$output_dir"
for rtt in ${LATENCY_RIG_SWEEP_PROFILES:-50 100 200 300}; do
  case "$rtt" in 50|100|200|300) ;; *) echo "Unsupported RTT profile: $rtt" >&2; exit 2;; esac
  curl --fail --silent --show-error -X POST \
    -H 'content-type: application/json' \
    --data "{\"rttMs\":$rtt,\"jitterMs\":12,\"mbps\":10,\"failureRate\":0.01}" \
    "http://127.0.0.1:$proxy_port/__latency-rig/profile" >/dev/null
  LATENCY_RIG_ROOM_SAMPLES=30 LATENCY_RIG_MIN_SUCCESSFUL_SAMPLES=20 \
    LATENCY_RIG_NETWORK_DESCRIPTION="${rtt} ms RTT, ±12 ms jitter, 10 Mbps, 1% whole-request failure" \
    bash "$repo_dir/scripts/latency-rig/capture-room.sh" "$output_dir/$rtt"
done
node "$repo_dir/scripts/latency-rig/sweep-summary.mjs" "$output_dir" \
  >"$output_dir/summary.md"
echo "Room RTT sweep: $output_dir/summary.md"
