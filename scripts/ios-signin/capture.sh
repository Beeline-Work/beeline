#!/usr/bin/env bash
# Use a disposable simulator; never erase or shut down another job's device.
set -euo pipefail
: "${SOURCE_DIR:?}" "${HARNESS_DIR:?}" "${EVIDENCE:?}"
mkdir -p "$EVIDENCE"
device=''
record_pid=''
log_pid=''
# shellcheck disable=SC2317,SC2329 # Called by the EXIT trap, including after failed build commands.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$record_pid" ]]; then kill -INT "$record_pid" 2>/dev/null || true; wait "$record_pid" || true; fi
  if [[ -n "$log_pid" ]]; then kill "$log_pid" 2>/dev/null || true; wait "$log_pid" || true; fi
  if [[ -n "$device" ]]; then
    xcrun simctl io "$device" screenshot "$EVIDENCE/final.png" || true
    xcrun simctl shutdown "$device" || true
    xcrun simctl delete "$device" || true
  fi
  # Only our DerivedData, never the release job's global Xcode cache.
  rm -rf "$EVIDENCE/DerivedData"
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
const type = list.devicetypes.filter(d => d.name.startsWith('iPhone')).at(-1);
if (!runtime || !type) throw new Error('No installed iOS runtime/iPhone device type');
console.log(type.identifier);
console.log(runtime.identifier);
JS
type_id=$(sed -n '1p' "$EVIDENCE/device-selection.txt")
runtime_id=$(sed -n '2p' "$EVIDENCE/device-selection.txt")
device=$(xcrun simctl create "Beeline sign-in ${GITHUB_RUN_ID:-local}" "$type_id" "$runtime_id")
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
xcodebuild -workspace "$workspace" -scheme "$scheme" -configuration Release \
  -sdk iphonesimulator -destination "id=$device" -derivedDataPath "$EVIDENCE/DerivedData" \
  CODE_SIGNING_ALLOWED=NO -jobs 2 build > "$EVIDENCE/xcode-build.log" 2>&1
app=$(find "$EVIDENCE/DerivedData/Build/Products/Release-iphonesimulator" -maxdepth 1 -name '*.app' -print -quit)
test -n "$app"
cp "$app/Info.plist" "$EVIDENCE/app-info.plist"
xcrun simctl install "$device" "$app"
xcrun simctl spawn "$device" log stream --style compact --level debug \
  --predicate 'process CONTAINS[c] "Beeline" OR process CONTAINS[c] "buzzy" OR process CONTAINS[c] "SafariViewService" OR process CONTAINS[c] "AuthenticationServices" OR subsystem CONTAINS[c] "AuthenticationServices" OR subsystem CONTAINS[c] "SafariServices"' \
  > "$EVIDENCE/device.log" 2>&1 &
log_pid=$!
xcrun simctl io "$device" recordVideo "$EVIDENCE/signin.mp4" > "$EVIDENCE/recording.log" 2>&1 &
record_pid=$!
result=0
for provider in github google; do
  date -u '+%Y-%m-%dT%H:%M:%SZ' > "$EVIDENCE/$provider-started.txt"
  # One provider's failure must not suppress capture of the other.
  maestro --device "$device" test --test-output-dir "$EVIDENCE/$provider" \
    -e "PROVIDER=$provider" "$HARNESS_DIR/scripts/ios-signin/provider.yaml" \
    > "$EVIDENCE/$provider-maestro.log" 2>&1 || result=1
  xcrun simctl io "$device" screenshot "$EVIDENCE/$provider-final.png"
  xcrun simctl terminate "$device" app.usebeeline.mobile || true
done
exit "$result"
