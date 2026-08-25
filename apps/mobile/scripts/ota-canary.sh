#!/usr/bin/env bash
# Install the latest beta-channel APK on the existing AVD, let it fetch the
# candidate, then run the real Room open/send/reply Maestro smoke. The outer
# timeout is part of the contract: a wedged emulator can never hold promotion
# for more than ten minutes.
set -euo pipefail

readonly MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly DEVICE="${MAESTRO_DEVICE:-emulator-5554}"
readonly APP_ID="app.usebeeline.mobile"
readonly MAX_SECONDS="${OTA_CANARY_MAX_SECONDS:-540}"

if [[ "${OTA_CANARY_DEADLINE_ACTIVE:-0}" != "1" ]]; then
  if (( MAX_SECONDS < 1 || MAX_SECONDS > 600 )); then
    echo "OTA_CANARY_MAX_SECONDS must be between 1 and 600." >&2
    exit 1
  fi
  exec timeout --foreground --signal=TERM "${MAX_SECONDS}s" \
    env OTA_CANARY_DEADLINE_ACTIVE=1 "$0" "$@"
fi

ledger=""
while (($#)); do
  case "$1" in
    --ledger)
      ledger="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: ota-canary.sh --ledger <mobile-ota-ledger.json>" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$ledger" ]]; then
  echo "Canary ledger not found: $ledger" >&2
  exit 1
fi
if ! adb devices | awk 'NR > 1 { print $1 }' | grep -Fxq "$DEVICE"; then
  echo "Canary requires the existing Android emulator $DEVICE." >&2
  exit 1
fi

candidate_group="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.candidateGroupId || "")' "$ledger")"
android_update="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.androidUpdateId || "")' "$ledger")"
android_runtime="$(node -e 'const x=require(process.argv[1]); const update=x.candidateUpdates?.find((item) => item.platform === "android"); process.stdout.write(update?.runtimeVersion || "")' "$ledger")"
if [[ -z "$candidate_group" || -z "$android_update" ]]; then
  echo "Canary ledger is missing candidateGroupId or androidUpdateId." >&2
  exit 1
fi

temporary="$(mktemp -d)"
cleanup() {
  local status=$?
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT INT TERM

apk="${BEELINE_BETA_APK:-}"
if [[ -z "$apk" ]]; then
  build_json="$temporary/beta-build.json"
  build_args=(
    build:list
    --platform android
    --build-profile beta-apk
    --status finished
    --limit 1
    --json
    --non-interactive
  )
  if [[ -n "$android_runtime" ]]; then
    build_args+=(--runtime-version "$android_runtime")
  fi
  npx --yes eas-cli@22.2.0 "${build_args[@]}" > "$build_json"
  build_url="$(node -e '
    const builds = require(process.argv[1]);
    const build = Array.isArray(builds) ? builds[0] : builds?.data?.[0];
    const url = build?.artifacts?.buildUrl ?? build?.artifacts?.applicationArchiveUrl;
    if (typeof url !== "string" || !url) process.exit(1);
    process.stdout.write(url);
  ' "$build_json")"
  apk="$temporary/beeline-beta.apk"
  curl --fail --location --silent --show-error "$build_url" --output "$apk"
fi

if [[ ! -f "$apk" ]]; then
  echo "Beta APK not found: $apk" >&2
  exit 1
fi

# -r preserves the dedicated beta binary registration while replacing any
# older beta build. pm clear then gives the smoke its normal cold-device state.
adb -s "$DEVICE" install -r "$apk" >/dev/null
adb -s "$DEVICE" shell pm clear "$APP_ID" >/dev/null
adb -s "$DEVICE" shell monkey -p "$APP_ID" 1 >/dev/null

# Give expo-updates one bounded cold fetch, then relaunch so Maestro starts on
# the candidate even when reload scheduling was delayed by initial app setup.
sleep "${OTA_CANARY_WARMUP_SECONDS:-20}"
adb -s "$DEVICE" shell am force-stop "$APP_ID" >/dev/null
adb -s "$DEVICE" shell monkey -p "$APP_ID" 1 >/dev/null

MAESTRO_REUSE_INSTALLED_APP=1 \
MAESTRO_SKIP_BUILD=1 \
MAESTRO_KEEP_DEVICE=1 \
MAESTRO_FLOW="$MOBILE_DIR/e2e/ota-canary.yaml" \
EXPECTED_ANDROID_UPDATE_ID="$android_update" \
EXPECTED_UPDATE_GROUP_ID="$candidate_group" \
  "$MOBILE_DIR/scripts/maestro-e2e.sh"

echo "OTA canary passed for beta group $candidate_group (Android update $android_update)."
