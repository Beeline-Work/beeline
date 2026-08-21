#!/usr/bin/env bash
# Build the signed Android APK with caches that survive throwaway worktrees.
set -euo pipefail

readonly MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_DIR="$(cd "$MOBILE_DIR/../.." && pwd -P)"
readonly ANDROID_HOME="${ANDROID_HOME:-/home/lunchbox/android-sdk}"
readonly CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}"

# React Native's CMake setup automatically invokes ccache when it is on PATH.
# These settings make its keys portable between equivalent worktrees while the
# compiler, ABI, flags, and source contents remain part of each ccache key.
export CCACHE_DIR="${BEELINE_ANDROID_CCACHE_DIR:-$CACHE_ROOT/beeline-android-ccache}"
export CCACHE_BASEDIR="$REPO_DIR"
export CCACHE_NOHASHDIR=true

cleanup() {
  local status=$?
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
