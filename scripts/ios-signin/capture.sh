#!/usr/bin/env bash
# Capture on an already booted runner Simulator; leave its lifecycle to the host.
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
record_pid=''
log_pid=''
# shellcheck disable=SC2317,SC2329 # Called by the EXIT trap, including after failed build commands.
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$record_pid" ]]; then kill -INT "$record_pid" 2>/dev/null || true; wait "$record_pid" || true; fi
  if [[ -n "$log_pid" ]]; then kill "$log_pid" 2>/dev/null || true; wait "$log_pid" || true; fi
  mkdir -p "$EVIDENCE/crash-reports"
  find "$RUNNER_ACCOUNT_HOME/Library/Logs/DiagnosticReports" -type f -iname '*Beeline*' -newer "$EVIDENCE/run-start" -exec cp {} "$EVIDENCE/crash-reports/" \; 2>/dev/null || true
  if [[ -n "$device" ]]; then
    xcrun simctl spawn "$device" log show --last 5m --style compact --predicate 'process == "SpringBoard" OR process == "runningboardd"' > "$EVIDENCE/launch-system.log" 2>&1 || true
    xcrun simctl io "$device" screenshot "$EVIDENCE/final.png" || true

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
device=$(xcrun simctl list devices booted -j | node -e '
let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{
 const device=Object.values(JSON.parse(input).devices).flat().find(d=>d.state==="Booted" && d.isAvailable);
 if(!device) {console.error("No already running iOS Simulator is available on this runner");process.exit(1);}
 process.stdout.write(device.udid);
});')
printf '%s\n' "$device" > "$EVIDENCE/device-id.txt"
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
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Info.plist")
# Simulator entitlements live in the Mach-O section, outside the code signature.
if ! node --input-type=module - "$app/$executable" "$EVIDENCE" <<'ENTITLEMENTS'
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [binary, evidence] = process.argv.slice(2);
const result = spawnSync('xcrun', ['otool', '-l', binary], { encoding: 'utf8' });
writeFileSync(`${evidence}/binary-load-commands.txt`, result.stdout || result.stderr || '');
const section = result.stdout?.match(/sectname __entitlements\s+segname __TEXT[\s\S]*?size (0x[0-9a-f]+)\s+offset (\d+)/i);
if (result.status !== 0 || !section) throw new Error('Embedded Simulator entitlement section unavailable');
const offset = Number(section[2]);
const size = Number.parseInt(section[1], 16);
writeFileSync(`${evidence}/embedded-entitlements.plist`, readFileSync(binary).subarray(offset, offset + size));
ENTITLEMENTS
then
  echo 'Warning: could not extract embedded Simulator entitlements; continuing to app launch' >&2
fi
if ! /usr/libexec/PlistBuddy -c 'Print :keychain-access-groups:0' "$EVIDENCE/embedded-entitlements.plist" > "$EVIDENCE/keychain-group.txt" 2> "$EVIDENCE/entitlements-check.log"; then
  echo 'Warning: embedded Keychain group unavailable; continuing to app launch' >&2
fi
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
