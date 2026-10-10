#!/usr/bin/env bash
# Stop only the worktree's dedicated emulator.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
local_dir="$repo_dir/scripts/latency-rig/.local"
port="${LATENCY_RIG_EMULATOR_PORT:-5580}"
serial="emulator-$port"
if [[ ! -f "$local_dir/emulator.pid" ]]; then
  echo 'No worktree-owned emulator PID recorded' >&2
  exit 2
fi
pid="$(cat "$local_dir/emulator.pid")"
if ! [[ "$pid" =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null ||
   ! tr '\0' ' ' <"/proc/$pid/cmdline" | grep -Fq -- '-avd beeline-latency-pixel5'; then
  echo 'Recorded emulator process is not the worktree AVD; refusing to stop a shared device' >&2
  exit 2
fi
if adb devices | awk 'NR > 1 {print $1}' | grep -Fxq "$serial"; then
  adb -s "$serial" emu kill
fi
echo "Stopped $serial"
