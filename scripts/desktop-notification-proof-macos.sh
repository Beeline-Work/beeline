#!/usr/bin/env bash
set -euo pipefail

bundle="apps/mobile/src-tauri/target/universal-apple-darwin/release/bundle"
app=$(find "$bundle" -type d -name '*.app' -print -quit)
test -n "$app"
executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")
BEELINE_DESKTOP_NOTIFICATION_PROOF=1 "$app/Contents/MacOS/$executable" \
  > "$RUNNER_TEMP/desktop-native-notification-macos.log" 2>&1 &
app_pid=$!
sleep 8
if ! kill -0 "$app_pid" 2>/dev/null; then
  cat "$RUNNER_TEMP/desktop-native-notification-macos.log"
  echo 'Beeline Preview exited before the native notification capture' >&2
  exit 1
fi
screencapture -x "$RUNNER_TEMP/desktop-native-notification-macos.png"
test -s "$RUNNER_TEMP/desktop-native-notification-macos.png"
swift scripts/desktop-notification-proof-macos.swift "$RUNNER_TEMP/desktop-native-notification-macos.png"
