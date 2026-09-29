#!/usr/bin/env bash
set -euo pipefail

bundle="apps/mobile/src-tauri/target/universal-apple-darwin/release/bundle"
app=$(find "$bundle" -type d -name '*.app' -print -quit)
test -n "$app"

# NSUserNotificationCenter (the backend `notify-rust`/`tauri-plugin-notification`
# use on macOS) only attributes a banner to this bundle when Launch Services
# already knows about it. Executing the Mach-O directly below (kept so the env
# var, pid, and stdio redirection stay simple) skips the registration a normal
# Finder/Dock launch performs, so force it explicitly first.
lsregister='/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
"$lsregister" -f "$app" || true

executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")
BEELINE_DESKTOP_NOTIFICATION_PROOF=1 "$app/Contents/MacOS/$executable" \
  > "$RUNNER_TEMP/desktop-native-notification-macos.log" 2>&1 &
app_pid=$!
sleep 2
osascript -e 'tell application "Finder" to activate'

# The fixture fires its notification 5s after launch, and a macOS banner is
# only visible for a few seconds before it auto-dismisses into Notification
# Center. Poll for it instead of gambling on a single capture instant.
found=0
for _ in $(seq 1 8); do
  sleep 1
  if ! kill -0 "$app_pid" 2>/dev/null; then
    cat "$RUNNER_TEMP/desktop-native-notification-macos.log"
    echo 'Beeline Preview exited before the native notification capture' >&2
    exit 1
  fi
  screencapture -x "$RUNNER_TEMP/desktop-native-notification-macos.png"
  test -s "$RUNNER_TEMP/desktop-native-notification-macos.png"
  if swift scripts/desktop-notification-proof-macos.swift "$RUNNER_TEMP/desktop-native-notification-macos.png"; then
    found=1
    break
  fi
done
test "$found" -eq 1
