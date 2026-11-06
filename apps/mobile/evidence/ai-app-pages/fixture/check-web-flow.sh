#!/bin/bash
# usage: check-web-flow.sh [screenshot-dir] ; needs web-after served on 127.0.0.1:18764 and google-chrome
set -u
mkdir -p "${1:-/tmp/ai-app-proof-shots}"
fail=0
for t in bone obsidian; do
  google-chrome --headless=new --no-sandbox --remote-debugging-port=18765 --user-data-dir="$(mktemp -d)" about:blank >/dev/null 2>&1 & CP=$!
  sleep 3
  timeout 60 node "$(dirname "$0")/check-web-flow.mjs" 18765 http://127.0.0.1:18764 "$t" "${1:-/tmp/ai-app-proof-shots}" 2>&1 | tail -6
  [ "${PIPESTATUS[0]}" -eq 0 ] || fail=1
  kill "$CP"; sleep 1
done
exit "$fail"
