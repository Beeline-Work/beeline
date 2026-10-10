#!/usr/bin/env bash
# Dedicated device runners supply a capture command; analysis is repository-owned.
set -euo pipefail

if [[ -z "${LATENCY_RIG_CAPTURE_COMMAND:-}" ]]; then
  echo 'LATENCY_RIG_CAPTURE_COMMAND must name the dedicated runner capture executable' >&2
  exit 2
fi
if [[ ! -x "$LATENCY_RIG_CAPTURE_COMMAND" ]]; then
  echo 'LATENCY_RIG_CAPTURE_COMMAND is not executable' >&2
  exit 2
fi
mkdir -p latency-rig-output
export LATENCY_RIG_SAMPLES="$PWD/latency-rig-output/samples.ndjson"
"$LATENCY_RIG_CAPTURE_COMMAND" "$LATENCY_RIG_SAMPLES"
test -s "$LATENCY_RIG_SAMPLES"
node scripts/latency-rig/analyze.mjs \
  --input "$LATENCY_RIG_SAMPLES" \
  --routes scripts/latency-rig/routes.json \
  --interactions scripts/latency-rig/interactions.json \
  --commit "$(git rev-parse HEAD)" \
  --device "${LATENCY_RIG_DEVICE_DESCRIPTION:?set device and CPU calibration}" \
  --network "${LATENCY_RIG_NETWORK_DESCRIPTION:?set measured RTT and shape}" \
  --out latency-rig-output/report.md --check
