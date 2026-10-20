#!/usr/bin/env bash
# Build, seed, install, and execute the stable on-device Maestro smoke flow.
# The seed identity is intentionally ephemeral and is only passed to Maestro's
# process environment; it is never written into the repository.
set -euo pipefail

readonly DEVICE="${MAESTRO_DEVICE:-emulator-5554}"
readonly APP_ID="app.usebeeline"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly MOBILE_DIR
REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd -P)"
readonly REPO_DIR
readonly APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
readonly FLOW="${MAESTRO_FLOW:-$MOBILE_DIR/e2e/smoke.yaml}"
readonly EXPECTED_UPDATE_ID="${EXPECTED_ANDROID_UPDATE_ID:-}"
readonly EXPECTED_UPDATE_CHANNEL="${EXPECTED_UPDATE_CHANNEL:-beta}"
readonly UPDATE_IDENTITY_TIMEOUT="${MAESTRO_UPDATE_IDENTITY_TIMEOUT_SECONDS:-10}"

disabled_deep_link_packages=()
cleanup() {
  local status=$?
  local package
  for package in "${disabled_deep_link_packages[@]}"; do
    adb -s "$DEVICE" shell pm enable --user 0 "$package" </dev/null >/dev/null 2>&1 || true
  done
  if [[ "${MAESTRO_VERIFY_UPDATE_ONLY:-0}" != "1" ]]; then
    local teardown_args=("$MOBILE_DIR/android")
    if [[ "${MAESTRO_KEEP_DEVICE:-0}" == "1" ]]; then
      teardown_args+=(--keep-emulator)
    fi
    "$MOBILE_DIR/scripts/android-teardown.sh" "${teardown_args[@]}" || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# shellcheck disable=SC1091 # The dynamic sibling path is covered by shellcheck's full-script run.
source "$MOBILE_DIR/scripts/android-device-ready.sh"
if ! wait_for_android_device_ready; then
  echo "Maestro requires the existing Android emulator $DEVICE." >&2
  exit 1
fi

if [[ -z "$EXPECTED_UPDATE_ID" ]]; then
  echo "Maestro environment error: EXPECTED_ANDROID_UPDATE_ID is required; refusing to run any flow without identifying the JS update on $DEVICE." >&2
  exit 2
fi
if [[ "$EXPECTED_UPDATE_CHANNEL" != "beta" && "$EXPECTED_UPDATE_CHANNEL" != "production" ]]; then
  echo "Maestro environment error: EXPECTED_UPDATE_CHANNEL must be beta or production (got $EXPECTED_UPDATE_CHANNEL)." >&2
  exit 2
fi
if ! [[ "$UPDATE_IDENTITY_TIMEOUT" =~ ^[0-9]+$ ]] ||
  (( UPDATE_IDENTITY_TIMEOUT < 1 || UPDATE_IDENTITY_TIMEOUT > 60 )); then
  echo "Maestro environment error: MAESTRO_UPDATE_IDENTITY_TIMEOUT_SECONDS must be between 1 and 60 (got $UPDATE_IDENTITY_TIMEOUT)." >&2
  exit 2
fi

if [[ "${MAESTRO_SKIP_BUILD:-0}" != "1" ]]; then
  (cd "$MOBILE_DIR" && npm run e2e:build)
fi

if [[ "${MAESTRO_REUSE_INSTALLED_APP:-0}" != "1" && ! -f "$APK" ]]; then
  echo "E2E APK not found at $APK. Re-run without MAESTRO_SKIP_BUILD=1." >&2
  exit 1
fi

# This intentionally clears only the named app on the named disposable
# emulator, ensuring the identity creation/import flow is exercised each run.
if [[ "${MAESTRO_REUSE_INSTALLED_APP:-0}" != "1" ]]; then
  adb -s "$DEVICE" uninstall "$APP_ID" >/dev/null 2>&1 || true
  adb -s "$DEVICE" install "$APK" >/dev/null
fi
# Push registration runs as part of identity import. Grant the manifest-declared
# permission before launch so an OS-owned modal cannot obscure a product flow.
adb -s "$DEVICE" shell pm grant "$APP_ID" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb -s "$DEVICE" shell monkey -p "$APP_ID" 1 >/dev/null

verify_running_update_identity() {
  local hierarchy=""
  local observed_update="unavailable"
  local observed_channel="unavailable"
  local deadline=$((SECONDS + UPDATE_IDENTITY_TIMEOUT))
  local device_hierarchy="/sdcard/beeline-maestro-update-identity.xml"

  while (( SECONDS <= deadline )); do
    # Target MainActivity explicitly. A plain openLink can raise Android's
    # chooser when multiple Beeline intent handlers are present, which would
    # make a routing prompt look like a stale-bundle product failure. Reissue
    # the intent while polling: Expo Router can lose the first cold-start
    # intent while its root providers initialize, but the warm intent is
    # deterministic and reaches Settings.
    if ! adb -s "$DEVICE" shell am start -W \
      -a android.intent.action.VIEW \
      -d 'beeline://beeline/settings' \
      "$APP_ID/.MainActivity" >/dev/null; then
      echo "Maestro environment error: could not open the app-owned OTA identity surface on $DEVICE." >&2
      return 2
    fi
    if adb -s "$DEVICE" shell uiautomator dump "$device_hierarchy" >/dev/null 2>&1; then
      hierarchy="$(adb -s "$DEVICE" shell cat "$device_hierarchy" 2>/dev/null || true)"
      observed_update="$(
        printf '%s' "$hierarchy" |
          sed -n 's/.*text="Running update: \([^"]*\)".*/\1/p' |
          head -n 1
      )"
      observed_channel="$(
        printf '%s' "$hierarchy" |
          sed -n 's/.*text="Channel: \([^"]*\)".*/\1/p' |
          head -n 1
      )"
      observed_update="${observed_update:-unavailable}"
      observed_channel="${observed_channel:-unavailable}"
      if [[ "$observed_update" == "$EXPECTED_UPDATE_ID" && "$observed_channel" == "$EXPECTED_UPDATE_CHANNEL" ]]; then
        echo "Maestro update identity verified: $EXPECTED_UPDATE_ID (channel $EXPECTED_UPDATE_CHANNEL)."
        return 0
      fi
    fi
    sleep 1
  done

  echo "Maestro environment error: refusing to run $FLOW because $APP_ID on $DEVICE reported update '$observed_update' on channel '$observed_channel'; expected '$EXPECTED_UPDATE_ID' on channel '$EXPECTED_UPDATE_CHANNEL'." >&2
  return 2
}

verify_running_update_identity

if [[ "${MAESTRO_VERIFY_UPDATE_ONLY:-0}" == "1" ]]; then
  exit 0
fi

# This AVD is shared with local development lanes that install differently
# named Beeline variants. Those packages can still claim the production
# `beeline://` scheme, making Android's resolver cover the app or route a
# canary deep link into the wrong package. Keep the product flow bound to the
# candidate package without uninstalling another lane's app: disable only the
# competing scheme handlers for this process lifetime and restore them in the
# cleanup trap above.
deep_link_handlers="$(
  adb -s "$DEVICE" shell cmd package query-activities --brief \
    -a android.intent.action.VIEW \
    -c android.intent.category.BROWSABLE \
    -d 'beeline://beeline/channels'
)" || {
  echo "Maestro environment error: could not enumerate beeline:// handlers on $DEVICE." >&2
  exit 2
}
target_handler_seen=0
while IFS= read -r component; do
  package="${component%%/*}"
  if [[ "$package" == "$APP_ID" ]]; then
    target_handler_seen=1
    continue
  fi
  if ! adb -s "$DEVICE" shell pm disable-user --user 0 "$package" </dev/null >/dev/null; then
    echo "Maestro environment error: could not temporarily disable competing beeline:// handler $package on $DEVICE." >&2
    exit 2
  fi
  disabled_deep_link_packages+=("$package")
done < <(
  printf '%s\n' "$deep_link_handlers" |
    sed -n 's/^[[:space:]]*\([[:alnum:]_.]*\/[[:alnum:]_.$]*\)$/\1/p'
)
if (( target_handler_seen != 1 )); then
  echo "Maestro environment error: $APP_ID is not registered for beeline:// on $DEVICE." >&2
  exit 2
fi

# ota-canary.yaml repeats the identity assertions as defense in depth, so
# leave that flow on Settings. Every other requested flow gets the screen it
# had before this mandatory preflight.
if [[ "$FLOW" != "$MOBILE_DIR/e2e/ota-canary.yaml" ]]; then
  adb -s "$DEVICE" shell input keyevent BACK >/dev/null
fi

# Read an existing review Room; this harness creates no fixture identities or Rooms.
if [[ -z "${BEELINE_REVIEW_SECRET:-}" ]]; then
  echo "Maestro environment error: BEELINE_REVIEW_SECRET is required for monolith review sign-in." >&2
  exit 2
fi
SMOKE_ROOM_ID="$(cd "$REPO_DIR" && node scripts/maestro-room.mjs)"
readonly SMOKE_ROOM_ID

maestro test --device "$DEVICE" \
  --env "BEELINE_REVIEW_SECRET=$BEELINE_REVIEW_SECRET" \
  --env "SMOKE_ROOM_ID=$SMOKE_ROOM_ID" \
  --env "EXPECTED_ANDROID_UPDATE_ID=${EXPECTED_ANDROID_UPDATE_ID:-}" \
  --env "EXPECTED_UPDATE_GROUP_ID=${EXPECTED_UPDATE_GROUP_ID:-}" \
  "$FLOW"

echo "Maestro smoke passed on $DEVICE."
