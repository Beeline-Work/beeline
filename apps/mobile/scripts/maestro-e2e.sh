#!/usr/bin/env bash
# Build, seed, install, and execute the stable on-device Maestro smoke flow.
# The seed identity is intentionally ephemeral and is only passed to Maestro's
# process environment; it is never written into the repository.
set -euo pipefail

readonly DEVICE="${MAESTRO_DEVICE:-emulator-5554}"
readonly APP_ID="app.usebeeline.mobile"
readonly MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd -P)"
readonly APK="$MOBILE_DIR/android/app/build/outputs/apk/release/app-release.apk"
readonly FLOW="${MAESTRO_FLOW:-$MOBILE_DIR/e2e/smoke.yaml}"
readonly EXPECTED_UPDATE_ID="${EXPECTED_ANDROID_UPDATE_ID:-}"
readonly UPDATE_IDENTITY_TIMEOUT="${MAESTRO_UPDATE_IDENTITY_TIMEOUT_SECONDS:-10}"

reply_fixture_pid=""
disabled_deep_link_packages=()
cleanup() {
  local status=$?
  if [[ -n "$reply_fixture_pid" ]]; then
    kill "$reply_fixture_pid" 2>/dev/null || true
  fi
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

if ! adb devices | awk 'NR > 1 { print $1 }' | grep -Fxq "$DEVICE"; then
  echo "Maestro requires the existing Android emulator $DEVICE." >&2
  exit 1
fi

if [[ -z "$EXPECTED_UPDATE_ID" ]]; then
  echo "Maestro environment error: EXPECTED_ANDROID_UPDATE_ID is required; refusing to run any flow without identifying the JS update on $DEVICE." >&2
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
      -d 'beeline://buzz/settings' \
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
      if [[ "$observed_update" == "$EXPECTED_UPDATE_ID" && "$observed_channel" == "beta" ]]; then
        echo "Maestro update identity verified: $EXPECTED_UPDATE_ID (channel beta)."
        return 0
      fi
    fi
    sleep 1
  done

  echo "Maestro environment error: refusing to run $FLOW because $APP_ID on $DEVICE reported update '$observed_update' on channel '$observed_channel'; expected '$EXPECTED_UPDATE_ID' on channel 'beta'." >&2
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
    -d 'beeline://buzz/channels'
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

# scripts/provision-smoke.ts and publish-smoke-replies.ts live at the repo
# root but import the workspace SDKs; Node resolves upward from each script's
# real path and never reaches apps/mobile/node_modules. One explicit bridge
# gives them the SDK links plus their hoisted runtime dependencies (@noble/*,
# nostr-tools) — proven as the release-runner user against a checkout with no
# root node_modules.
export NODE_PATH="$MOBILE_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"

seed_output="$(cd "$REPO_DIR" && npx tsx scripts/provision-smoke.ts)"
printf '%s\n' "$seed_output"

read_seed_value() {
  local key="$1"
  local value
  value="$(printf '%s\n' "$seed_output" | sed -n "s/^${key}=//p" | tail -n 1)"
  if [[ -z "$value" ]]; then
    echo "Provisioning did not emit $key." >&2
    exit 1
  fi
  printf '%s' "$value"
}

readonly SMOKE_NSEC="$(read_seed_value MAESTRO_SMOKE_NSEC)"
readonly SMOKE_HANDLE="$(read_seed_value MAESTRO_SMOKE_HANDLE)"
readonly SMOKE_WORKSPACE_ID="$(read_seed_value MAESTRO_SMOKE_WORKSPACE_ID)"
readonly SMOKE_SWITCH_WORKSPACE_ID="$(read_seed_value MAESTRO_SMOKE_SWITCH_WORKSPACE_ID)"
readonly SMOKE_SWITCH_ROOM_ID="$(read_seed_value MAESTRO_SMOKE_SWITCH_ROOM_ID)"
readonly SMOKE_ROOM_ID="$(read_seed_value MAESTRO_SMOKE_ROOM_ID)"
readonly SMOKE_AGENT_NSEC="$(read_seed_value MAESTRO_SMOKE_AGENT_NSEC)"
readonly SMOKE_CORNER_ID="$(read_seed_value MAESTRO_SMOKE_CORNER_ID)"
readonly SMOKE_LATEST_MESSAGE_ID="$(read_seed_value MAESTRO_SMOKE_LATEST_MESSAGE_ID)"

# A separate registered agent waits for the device's actual Room and corner
# messages, then responds. This verifies live relay delivery without requiring
# a local Body daemon in the emulator fixture.
(cd "$REPO_DIR" && npx tsx scripts/publish-smoke-replies.ts "$SMOKE_AGENT_NSEC" "$SMOKE_ROOM_ID" "$SMOKE_CORNER_ID") &
reply_fixture_pid=$!

maestro test --device "$DEVICE" \
  --env "SMOKE_NSEC=$SMOKE_NSEC" \
  --env "SMOKE_HANDLE=$SMOKE_HANDLE" \
  --env "SMOKE_WORKSPACE_ID=$SMOKE_WORKSPACE_ID" \
  --env "SMOKE_SWITCH_WORKSPACE_ID=$SMOKE_SWITCH_WORKSPACE_ID" \
  --env "SMOKE_SWITCH_ROOM_ID=$SMOKE_SWITCH_ROOM_ID" \
  --env "SMOKE_ROOM_ID=$SMOKE_ROOM_ID" \
  --env "SMOKE_CORNER_ID=$SMOKE_CORNER_ID" \
  --env "SMOKE_LATEST_MESSAGE_ID=$SMOKE_LATEST_MESSAGE_ID" \
  --env "EXPECTED_ANDROID_UPDATE_ID=${EXPECTED_ANDROID_UPDATE_ID:-}" \
  --env "EXPECTED_UPDATE_GROUP_ID=${EXPECTED_UPDATE_GROUP_ID:-}" \
  "$FLOW"

# The fixture queries relay history after the actual device mention arrives.
# Waiting makes duplicate-event detection part of this on-device check.
wait "$reply_fixture_pid"

echo "Maestro smoke passed on $DEVICE."
