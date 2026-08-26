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

reply_fixture_pid=""
cleanup() {
  local status=$?
  if [[ -n "$reply_fixture_pid" ]]; then
    kill "$reply_fixture_pid" 2>/dev/null || true
  fi
  local teardown_args=("$MOBILE_DIR/android")
  if [[ "${MAESTRO_KEEP_DEVICE:-0}" == "1" ]]; then
    teardown_args+=(--keep-emulator)
  fi
  "$MOBILE_DIR/scripts/android-teardown.sh" "${teardown_args[@]}" || true
  exit "$status"
}
trap cleanup EXIT INT TERM

if ! adb devices | awk 'NR > 1 { print $1 }' | grep -Fxq "$DEVICE"; then
  echo "Maestro requires the existing Android emulator $DEVICE." >&2
  exit 1
fi

if [[ "${MAESTRO_SKIP_BUILD:-0}" != "1" ]]; then
  (cd "$MOBILE_DIR" && npm run e2e:build)
fi

# scripts/provision-smoke.ts and publish-smoke-replies.ts live at the repo
# root but import the workspace SDKs; Node resolves upward from each script's
# real path and never reaches apps/mobile/node_modules. One explicit bridge
# gives them the SDK links plus their hoisted runtime dependencies (@noble/*,
# nostr-tools) — proven as the release-runner user against a checkout with no
# root node_modules.
export NODE_PATH="$MOBILE_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"

if [[ "${MAESTRO_REUSE_INSTALLED_APP:-0}" != "1" && ! -f "$APK" ]]; then
  echo "E2E APK not found at $APK. Re-run without MAESTRO_SKIP_BUILD=1." >&2
  exit 1
fi

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
readonly SMOKE_WORKSPACE_ID="$(read_seed_value MAESTRO_SMOKE_WORKSPACE_ID)"
readonly SMOKE_ROOM_ID="$(read_seed_value MAESTRO_SMOKE_ROOM_ID)"
readonly SMOKE_AGENT_NSEC="$(read_seed_value MAESTRO_SMOKE_AGENT_NSEC)"
readonly SMOKE_CORNER_ID="$(read_seed_value MAESTRO_SMOKE_CORNER_ID)"
readonly SMOKE_LATEST_MESSAGE_ID="$(read_seed_value MAESTRO_SMOKE_LATEST_MESSAGE_ID)"

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

# A separate registered agent waits for the device's actual Room and corner
# messages, then responds. This verifies live relay delivery without requiring
# a local Body daemon in the emulator fixture.
(cd "$REPO_DIR" && npx tsx scripts/publish-smoke-replies.ts "$SMOKE_AGENT_NSEC" "$SMOKE_ROOM_ID" "$SMOKE_CORNER_ID") &
reply_fixture_pid=$!

maestro test --device "$DEVICE" \
  --env "SMOKE_NSEC=$SMOKE_NSEC" \
  --env "SMOKE_WORKSPACE_ID=$SMOKE_WORKSPACE_ID" \
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
