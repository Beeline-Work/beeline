#!/usr/bin/env bash
# Run from the prepared detached main checkout on an explicitly owned emulator.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_dir"
rig_state="${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy"
mkdir -p "$rig_state"
chmod 700 "$rig_state"
run_dir="$(mktemp -d "$rig_state/night-$(date -u +%Y-%m-%d)-XXXXXX")"
head_sha="$(git rev-parse HEAD)"
night="$(TZ=America/New_York date +%Y-%m-%d)"
run_id="$(basename "$run_dir")"
node scripts/latency-rig/commit-range.mjs "$PWD" "$head_sha" "$run_dir/commits.json"
# Setup/capture failures are compared as missing reports, then retried once.
timeout --signal=TERM --kill-after=60s 90m bash scripts/latency-rig/local-attempt.sh "$run_dir/attempt-1" || true
verdict=0
node scripts/latency-rig/nightly-local.mjs \
  --night "$night" --run-id "$run_id" \
  --current "$run_dir/attempt-1/report.json" --baseline "$rig_state/last-pass.json" \
  --commits "$run_dir/commits.json" --head "$head_sha" \
  --load "$run_dir/attempt-1/capture/host-load.json" --out "$run_dir/nightly.json" || verdict=$?
if [[ "$verdict" == 2 ]]; then
  timeout --signal=TERM --kill-after=60s 90m bash scripts/latency-rig/local-attempt.sh "$run_dir/attempt-2" || true
  verdict=0
  node scripts/latency-rig/nightly-local.mjs \
    --night "$night" --run-id "$run_id" \
    --current "$run_dir/attempt-1/report.json" --rerun "$run_dir/attempt-2/report.json" \
    --baseline "$rig_state/last-pass.json" --commits "$run_dir/commits.json" --head "$head_sha" \
    --load "$run_dir/attempt-2/capture/host-load.json" --out "$run_dir/nightly.json" || verdict=$?
fi
echo "Nightly result: $run_dir/nightly.json"
# The parent-Room agent posts the verdict; this script has no messaging token.
exit "$verdict"
