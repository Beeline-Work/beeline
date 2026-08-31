#!/usr/bin/env bash
# Stop only the emulator and Gradle daemon used by a Beeline Android run.
set -euo pipefail

readonly ANDROID_DIR="${1:?usage: android-teardown.sh <generated-android-dir> [--keep-emulator]}"
readonly DEVICE="${MAESTRO_DEVICE:-emulator-5554}"
readonly KEEP_EMULATOR="${2:-}"

if command -v adb >/dev/null 2>&1; then
  if [[ "$KEEP_EMULATOR" != "--keep-emulator" ]] && adb devices 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fxq "$DEVICE"; then
    # `emu kill` asks the named emulator to exit; never use a broad pkill because
    # other worktrees can have an unrelated device session.
    adb -s "$DEVICE" emu kill >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      if ! adb devices 2>/dev/null | awk 'NR > 1 { print $1 }' | grep -Fxq "$DEVICE"; then
        break
      fi
      sleep 1
    done
  fi
  # A shared emulator implies a shared adb server. The caller that explicitly
  # keeps the device must leave that server alone for the next verification
  # lane; ordinary isolated runs still clean it up as before.
  if [[ "$KEEP_EMULATOR" != "--keep-emulator" ]]; then
    adb kill-server >/dev/null 2>&1 || true
  fi
fi

if [[ -x "$ANDROID_DIR/gradlew" ]]; then
  (cd "$ANDROID_DIR" && ./gradlew --stop >/dev/null 2>&1) || true
fi
