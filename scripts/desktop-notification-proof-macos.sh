#!/usr/bin/env bash
set -euo pipefail

bundle="apps/mobile/src-tauri/target/universal-apple-darwin/release/bundle"
app=$(find "$bundle" -type d -name '*.app' -print -quit)
test -n "$app"

# NSUserNotificationCenter (the backend `notify-rust`/`tauri-plugin-notification`
# use on macOS) only attributes a banner to this bundle when Launch Services
# already knows about it AND the process was started as a real running
# application, not a bare Mach-O exec. `lsregister -f` alone proved
# insufficient in CI; `open` performs the same registration a Finder/Dock
# launch does.
lsregister='/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
"$lsregister" -f "$app" || true

executable=$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")
log="$RUNNER_TEMP/desktop-native-notification-macos.log"
: > "$log"
open -n -a "$app" --env BEELINE_DESKTOP_NOTIFICATION_PROOF=1 --stdout "$log" --stderr "$log"
sleep 2
osascript -e 'tell application "Finder" to activate'
app_pid=$(pgrep -n -x "$executable" || true)
if [ -z "$app_pid" ]; then
  cat "$log"
  echo 'Beeline Preview did not appear to start' >&2
  exit 1
fi

# The fixture fires its notification 5s after launch, and a macOS banner is
# only visible for a few seconds before it auto-dismisses into Notification
# Center. Poll for it instead of gambling on a single capture instant.
found=0
for _ in $(seq 1 8); do
  sleep 1
  if ! kill -0 "$app_pid" 2>/dev/null; then
    cat "$log"
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
