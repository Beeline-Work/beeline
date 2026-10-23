#!/usr/bin/env bash
# Capture one build: serve it on 8792 (the server's allowed web origin), capture, stop.
set -euo pipefail
kit="$(cd "$(dirname "$0")" && pwd)"
# Needs the local server env (DATABASE_URL, LATENCY_RIG_DATABASE_URL, review secret) from README.md.
node "$kit/serve.mjs" "/tmp/rlm88/web-$1" 8792 & srv=$!
trap 'kill $srv' EXIT
sleep 1
node "$kit/capture.mjs" "$1" 8792 >/tmp/rlm88/capture-$1.log 2>&1 || { tail -20 /tmp/rlm88/capture-$1.log; exit 1; }
