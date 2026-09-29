#!/usr/bin/env bash
set -euo pipefail

bundle="apps/mobile/src-tauri/target/universal-apple-darwin/release/bundle"
app=$(find "$bundle" -type d -name '*.app' -print -quit)
test -n "$app"
open --env BEELINE_DESKTOP_NOTIFICATION_PROOF=1 "$app"
sleep 7
screencapture -x "$RUNNER_TEMP/desktop-native-notification-macos.png"
test -s "$RUNNER_TEMP/desktop-native-notification-macos.png"
