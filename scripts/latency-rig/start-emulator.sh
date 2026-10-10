#!/usr/bin/env bash
# Start a worktree-owned emulator, leaving other lanes' devices alone.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
local_dir="$repo_dir/scripts/latency-rig/.local"
export ANDROID_HOME="${ANDROID_HOME:-/home/lunchbox/android-sdk}"
export ANDROID_AVD_HOME="$local_dir/avd"
avd_name=beeline-latency-pixel5
port="${LATENCY_RIG_EMULATOR_PORT:-5580}"
if ! [[ "$port" =~ ^[0-9]+$ ]] || (( port < 5554 || port > 5680 || port % 2 != 0 )); then
  echo 'LATENCY_RIG_EMULATOR_PORT must be an even Android emulator port from 5554 to 5680' >&2
  exit 2
fi
mkdir -p "$ANDROID_AVD_HOME"
if [[ ! -f "$ANDROID_AVD_HOME/$avd_name.ini" ]]; then
  printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
    --name "$avd_name" --package 'system-images;android-35;google_apis;x86_64' \
    --device pixel_5 --path "$ANDROID_AVD_HOME/$avd_name.avd"
fi
serial="emulator-$port"
if adb devices | awk 'NR > 1 {print $1}' | grep -Fxq "$serial"; then
  observed="$(adb -s "$serial" emu avd name | head -1 | tr -d '\r')"
  if [[ "$observed" != "$avd_name" ]]; then
    echo "$serial belongs to AVD $observed, not this worktree's $avd_name" >&2
    exit 2
  fi
  echo "$serial is already running"
  exit 0
fi
echo $$ >"$local_dir/emulator.pid"
echo "Starting $serial (worktree AVD $ANDROID_AVD_HOME/$avd_name.avd)"
# Keep this process in the caller's session. For CI, run the script in the
# background of the same job shell and wait on `adb -s "$serial" wait-for-device`.
exec "$ANDROID_HOME/emulator/emulator" -avd "$avd_name" -port "$port" \
  -no-window -no-snapshot -no-audio -gpu swiftshader_indirect \
  >"$local_dir/emulator.log" 2>&1
