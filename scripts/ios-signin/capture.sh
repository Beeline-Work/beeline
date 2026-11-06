#!/usr/bin/env bash
# Use a disposable simulator; never erase or shut down another job's device.
set -euo pipefail
: "${SOURCE_DIR:?}" "${HARNESS_DIR:?}" "${EVIDENCE:?}"
derived_data="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ios-signin-dd-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
mkdir -p "$EVIDENCE"
missing=0
for tool in xcodebuild xcrun node npm npx pod java maestro codesign; do
  if tool_path=$(command -v "$tool"); then
    printf '%s: %s\n' "$tool" "$tool_path"
  else
    printf 'Missing required tool: %s\n' "$tool" >&2
    missing=1
  fi
done
if [[ ! -x /usr/libexec/PlistBuddy ]]; then
  echo 'Missing required tool: /usr/libexec/PlistBuddy' >&2
  missing=1
fi
if [[ "$missing" != 0 ]]; then exit 127; fi
touch "$EVIDENCE/run-start"
device=''
launch_pid=''
record_pid=''
log_pid=''
# shellcheck disable=SC2317,SC2329 # Called by the EXIT trap, including after failed build commands.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$record_pid" ]]; then kill -INT "$record_pid" 2>/dev/null || true; wait "$record_pid" || true; fi
  if [[ -n "$log_pid" ]]; then kill "$log_pid" 2>/dev/null || true; wait "$log_pid" || true; fi
  mkdir -p "$EVIDENCE/crash-reports"
  find "$HOME/Library/Logs/DiagnosticReports" -type f -iname '*Beeline*' -newer "$EVIDENCE/run-start" -exec cp {} "$EVIDENCE/crash-reports/" \; 2>/dev/null || true
  if [[ -n "$launch_pid" ]]; then kill "$launch_pid" 2>/dev/null || true; wait "$launch_pid" || true; fi
  if [[ -n "$device" ]]; then
    xcrun simctl spawn "$device" log show --last 5m --style compact --predicate 'process == "SpringBoard" OR process == "runningboardd"' > "$EVIDENCE/launch-system.log" 2>&1 || true
    xcrun simctl io "$device" screenshot "$EVIDENCE/final.png" || true
    xcrun simctl shutdown "$device" || true
    xcrun simctl delete "$device" || true
  fi
  # Only our DerivedData, never the release job's global Xcode cache.
  rm -rf "$derived_data"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd "$SOURCE_DIR/apps/mobile"
# Release configuration embeds the bundle; disable OTA in generated native
# configuration so the chosen ref cannot silently become a production update.
npx expo prebuild --platform ios --no-install > "$EVIDENCE/prebuild.log" 2>&1
(cd ios && pod install) > "$EVIDENCE/pods.log" 2>&1
node --input-type=module - "$EVIDENCE/simulators.json" > "$EVIDENCE/device-selection.txt" <<'JS'
import { readFileSync } from 'node:fs';
const list = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const runtime = list.runtimes.filter(r => r.isAvailable && r.identifier.includes('.iOS-')).at(-1);
const type = runtime?.supportedDeviceTypes?.find(d => d.name.startsWith('iPhone'));
if (!runtime || !type) throw new Error('No installed iOS runtime/iPhone device type');
console.log(type.identifier);
console.log(runtime.identifier);
JS
type_id=$(sed -n '1p' "$EVIDENCE/device-selection.txt")
runtime_id=$(sed -n '2p' "$EVIDENCE/device-selection.txt")
if ! device=$(xcrun simctl create "Beeline sign-in ${GITHUB_RUN_ID:-local}" "$type_id" "$runtime_id"); then
  device=''
  echo "Unable to create compatible Simulator: $type_id / $runtime_id" >&2
  exit 1
fi
printf '%s\n' "$device" > "$EVIDENCE/device-id.txt"
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
workspace=$(find ios -maxdepth 1 -name '*.xcworkspace' -print -quit)
test -n "$workspace"
xcodebuild -list -json -workspace "$workspace" > "$EVIDENCE/xcode-project.json"
scheme=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).workspace.schemes.find(s => /beeline|buzzy/i.test(s)) || ""' "$EVIDENCE/xcode-project.json")
test -n "$scheme"
# Prevent Expo Updates from replacing the embedded candidate at launch.
expo_plist=$(find ios -name Expo.plist -print -quit)
test -n "$expo_plist"
/usr/libexec/PlistBuddy -c 'Set :EXUpdatesEnabled false' "$expo_plist"
# Xcode embeds Simulator entitlements in the executable; do not re-sign the bundle.
cat > "$EVIDENCE/simulator-entitlements.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>keychain-access-groups</key><array><string>BEELINESIM.app.usebeeline.mobile</string></array>
</dict></plist>
PLIST
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination "id=$device" -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO DEVELOPMENT_TEAM= \
  CODE_SIGN_ENTITLEMENTS="$EVIDENCE/simulator-entitlements.plist" \
  -jobs 2 build > "$EVIDENCE/xcode-build.log" 2>&1
app=$(find "$derived_data/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' -print -quit)
test -n "$app"
cp "$app/Info.plist" "$EVIDENCE/app-info.plist"
codesign --display --entitlements - "$app" > "$EVIDENCE/signed-entitlements.plist" 2> "$EVIDENCE/codesign.log"
/usr/libexec/PlistBuddy -c 'Print :keychain-access-groups:0' "$EVIDENCE/signed-entitlements.plist" > "$EVIDENCE/keychain-group.txt"
xcrun simctl install "$device" "$app"
xcrun simctl spawn "$device" log stream --style compact --level debug \
  --predicate 'process CONTAINS[c] "Beeline" OR process CONTAINS[c] "buzzy" OR process CONTAINS[c] "SafariViewService" OR process CONTAINS[c] "AuthenticationServices" OR subsystem CONTAINS[c] "AuthenticationServices" OR subsystem CONTAINS[c] "SafariServices"' \
  > "$EVIDENCE/device.log" 2>&1 &
log_pid=$!
xcrun simctl io "$device" recordVideo "$EVIDENCE/signin.mp4" > "$EVIDENCE/recording.log" 2>&1 &
record_pid=$!
# A console launch stays attached. Verify the process exists before Maestro.
xcrun simctl launch --console-pty "$device" app.usebeeline.mobile > "$EVIDENCE/launch-console.log" 2> "$EVIDENCE/launch-stderr.log" &
launch_pid=$!
sleep 10
if ! kill -0 "$launch_pid" 2>/dev/null; then
  wait "$launch_pid"
  echo 'Simulator app exited before sign-in capture' >&2
  exit 1
fi
xcrun simctl spawn "$device" launchctl list > "$EVIDENCE/launch-processes.txt"
if ! grep -F 'app.usebeeline.mobile' "$EVIDENCE/launch-processes.txt"; then
  echo 'Simulator launch did not create the app process' >&2
  exit 1
fi
xcrun simctl terminate "$device" app.usebeeline.mobile
wait "$launch_pid" || true
launch_pid=''
result=0
for provider in github google; do
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$EVIDENCE/$provider-started.txt"
  # Record deliberate system-consent cancellation separately from provider start.
  maestro --device "$device" test --test-output-dir "$EVIDENCE/$provider-cancel" \
    -e "PROVIDER=$provider" "$HARNESS_DIR/scripts/ios-signin/cancel.yaml" \
    > "$EVIDENCE/$provider-cancel-maestro.log" 2>&1 || result=1
  xcrun simctl terminate "$device" app.usebeeline.mobile || true
  # One provider's failure must not suppress capture of the other.
  maestro --device "$device" test --test-output-dir "$EVIDENCE/$provider" \
    -e "PROVIDER=$provider" "$HARNESS_DIR/scripts/ios-signin/provider.yaml" \
    > "$EVIDENCE/$provider-maestro.log" 2>&1 || result=1
  xcrun simctl io "$device" screenshot "$EVIDENCE/$provider-final.png"
  xcrun simctl terminate "$device" app.usebeeline.mobile || true
done
exit "$result"
