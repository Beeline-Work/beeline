#!/usr/bin/env bash
# Build the signed Android APK with caches that survive throwaway worktrees.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly MOBILE_DIR
REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd -P)"
readonly REPO_DIR
readonly ANDROID_HOME="${ANDROID_HOME:-/home/lunchbox/android-sdk}"
readonly CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"

# The sideload signing key lives only in the ANDROID_SIDELOAD_* repository
# secrets (see apps/mobile/android-signing/README.md); it is never checked
# into the tree. Materialize it to a temporary path for this build only.
for var in ANDROID_SIDELOAD_KEYSTORE_B64 ANDROID_SIDELOAD_KEY_ALIAS ANDROID_SIDELOAD_STORE_PASSWORD ANDROID_SIDELOAD_KEY_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "Error: $var is not set. A sideload release build signs with the key held in the" \
      "ANDROID_SIDELOAD_KEYSTORE_B64, ANDROID_SIDELOAD_KEY_ALIAS, ANDROID_SIDELOAD_STORE_PASSWORD," \
      "and ANDROID_SIDELOAD_KEY_PASSWORD repository secrets. Export all four locally before running" \
      "this script (see apps/mobile/android-signing/README.md)." >&2
    exit 1
  fi
done
export ANDROID_SIDELOAD_KEY_ALIAS ANDROID_SIDELOAD_STORE_PASSWORD ANDROID_SIDELOAD_KEY_PASSWORD

ANDROID_SIDELOAD_KEYSTORE_PATH="$(mktemp -t beeline-sideload-keystore.XXXXXX.jks)"
readonly ANDROID_SIDELOAD_KEYSTORE_PATH
export ANDROID_SIDELOAD_KEYSTORE_PATH
base64 -d <<<"$ANDROID_SIDELOAD_KEYSTORE_B64" > "$ANDROID_SIDELOAD_KEYSTORE_PATH"

# The host-side smoke fixture may use loopback while an Android device reaches
# that same relay through 10.0.2.2. Expo reads this configuration again during
# Gradle, so derive the device-facing runtime origin here as well as in the
# E2E runner.
if [[ -n "${RELAY_PUBLIC_ORIGIN:-}" ]]; then
  export EXPO_PUBLIC_BUZZY_RELAY_URL="${EXPO_PUBLIC_BUZZY_RELAY_URL:-$RELAY_PUBLIC_ORIGIN}"
  export EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL="${EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL:-${RELAY_PUBLIC_ORIGIN%/}/push}"
elif [[ -n "${RELAY_URL:-}" ]]; then
  export EXPO_PUBLIC_BUZZY_RELAY_URL="${EXPO_PUBLIC_BUZZY_RELAY_URL:-$RELAY_URL}"
  export EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL="${EXPO_PUBLIC_BUZZY_PUSH_GATEWAY_URL:-${RELAY_URL%/}/push}"
fi

# React Native's CMake setup automatically invokes ccache when it is on PATH.
# These settings make its keys portable between equivalent worktrees while the
# compiler, ABI, flags, and source contents remain part of each ccache key.
export CCACHE_DIR="${BEELINE_ANDROID_CCACHE_DIR:-$CACHE_ROOT/beeline-android-ccache}"
export CCACHE_BASEDIR="$REPO_DIR"
export CCACHE_NOHASHDIR=true

cleanup() {
  local status=$?
  rm -f "$ANDROID_SIDELOAD_KEYSTORE_PATH"
  local teardown_args=("$MOBILE_DIR/android")
  if [[ "${BEELINE_ANDROID_KEEP_DEVICE:-0}" == "1" ]]; then
    teardown_args+=(--keep-emulator)
  fi
  "$MOBILE_DIR/scripts/android-teardown.sh" "${teardown_args[@]}" || true
  exit "$status"
}
trap cleanup EXIT INT TERM

if ! command -v ccache >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ccache is not installed; this build will work, but native CMake compilation cannot
be reused across worktrees. Install ccache to enable the shared native cache.
EOF
else
  mkdir -p "$CCACHE_DIR"
  echo "Native compiler cache: $CCACHE_DIR"
fi

cd "$MOBILE_DIR"
env ANDROID_HOME="$ANDROID_HOME" npx expo prebuild --platform android --clean
bash scripts/patch-android-signing.sh
(
  cd android
  env ANDROID_HOME="$ANDROID_HOME" ./gradlew assembleRelease
)

echo '=== APK built ==='
ls -lh android/app/build/outputs/apk/release/app-release.apk
