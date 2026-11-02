#!/usr/bin/env bash
# Optional host-only setup; never install alongside the agent capture schedule.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
mkdir -p "${1:?usage: nightly-host.sh <state-dir>}"
export LATENCY_RIG_STATE
LATENCY_RIG_STATE="$(cd "$1" && pwd -P)"
chmod 700 "$LATENCY_RIG_STATE"
state="$LATENCY_RIG_STATE"
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
head_sha="" error="" phase="lane check" owned_device="" emulator_pid="" nightly_pid=""
host_locked=false

# shellcheck disable=SC2317 # Invoked indirectly by the EXIT trap.
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  # The nightly session includes timeout's separate process groups and its servers.
  if [[ -n "$nightly_pid" ]]; then
    pkill -TERM -s "$nightly_pid" 2>/dev/null
    sleep 1
    pkill -KILL -s "$nightly_pid" 2>/dev/null
    wait "$nightly_pid" 2>/dev/null
  fi
  if [[ -n "$owned_device" ]]; then timeout 15s adb -s "$owned_device" emu kill; fi
  if [[ -n "$emulator_pid" ]]; then
    kill -TERM -- "-$emulator_pid" 2>/dev/null
    sleep 1
    kill -KILL -- "-$emulator_pid" 2>/dev/null
    wait "$emulator_pid" 2>/dev/null
  fi
  if [[ "$status" != 0 && -z "$error" ]]; then error="$phase failed (exit $status)"; fi
  node --input-type=module - "$state" "$started_at" "$head_sha" "$status" "$error" "$host_locked" <<'JS'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
const [state, startedAt, head, code, error, locked] = process.argv.slice(2);
let nightlyJson = null;
if (locked === 'true') {
  try { nightlyJson = readFileSync(`${state}/host-nightly.log`, 'utf8').match(/^Nightly result: (.+)$/m)?.[1] ?? null; } catch {}
}
const temporary = `${state}/host-run.${process.pid}.json`;
writeFileSync(temporary, JSON.stringify({ startedAt, head: head || null, exitCode: Number(code), nightlyJson, error: error || null }, null, 2) + '\n');
renameSync(temporary, `${state}/host-run.json`);
JS
  if [[ "$host_locked" == true ]]; then rmdir "$state/host.lock"; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
blocked() { error="Blocked: $*"; echo "$error" >&2; exit 2; }
# Match lockState's mkdir convention: a stale directory needs an operator check.
mkdir "$state/host.lock" 2>/dev/null || blocked 'host lane held; verify no writer before removing a stale host.lock'
host_locked=true
: >"$state/host-nightly.log"
[[ ! -e "$state/nightly.lock" ]] || blocked 'verdict lane held (nightly.lock)'
exec 9>"$state/capture.lock"
flock -n 9 || blocked 'capture lane held (capture.lock)'
device_list() { timeout 15s adb devices | awk 'NR > 1 && $1 ~ /^emulator-[0-9]+$/ {print $1}' | sort -u; }
check_lane() {
  local devices
  devices="$(device_list)"
  [[ -z "$devices" ]] || blocked 'emulator lane held'
  ss -ltn >"$state/host-listeners.txt"
  # Include emulators still booting, before adb has registered their transport.
  if awk '{n=split($4,a,":"); p=a[n]; if (p >= 5554 && p <= 5584 && p % 2 == 0) found=1} END {exit !found}' "$state/host-listeners.txt"; then
    blocked 'emulator console lane held'
  fi
}
check_lane

phase="checkout preparation"
checkout="$state/checkout"
if [[ ! -e "$checkout/.git" ]]; then
  git clone --no-checkout --reference "$repo_dir" "$(git -C "$repo_dir" remote get-url origin)" "$checkout"
fi
cd "$checkout"
git fetch origin main
git checkout --detach FETCH_HEAD
head_sha="$(git rev-parse HEAD)"
phase="dependency installation"
lock_hashes="$(sha256sum package-lock.json apps/mobile/package-lock.json)"
previous_hashes="$(cat "$state/dependencies-head" 2>/dev/null || true)"
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
if [[ "$lock_hashes" != "$previous_hashes" ]]; then
  npm ci
  (cd apps/mobile && npm ci)
  printf '%s\n' "$lock_hashes" >"$state/dependencies-head"
fi

phase="emulator lease"
check_lane
before="$(device_list)"
setsid beeline emulator -avd se_api35 -no-window -gpu swiftshader_indirect \
  -no-snapshot -memory 2560 -cores 4 >"$state/host-emulator.log" 2>&1 9>&- &
emulator_pid=$!
for _ in {1..180}; do
  # Kept-corner CLI output is documented in requestKeptCornerEmulator. The
  # host's one-shot launcher stays alive instead, so use the adb diff there.
  if grep -q ' already running' "$state/host-emulator.log"; then blocked 'emulator launcher reused an existing lane'; fi
  owned_device="$(sed -nE 's/^emulator (emulator-[0-9]+) started$/\1/p' "$state/host-emulator.log" | head -1)"
  if [[ -z "$owned_device" ]]; then
    after="$(device_list)"
    added="$(comm -13 <(printf '%s\n' "$before" | sed '/^$/d') <(printf '%s\n' "$after" | sed '/^$/d'))"
    if [[ -n "$added" && "$added" != *$'\n'* ]]; then owned_device="$added"; fi
  fi
  if [[ -n "$owned_device" ]]; then break; fi
  kill -0 "$emulator_pid" 2>/dev/null || { error='Emulator launcher exited without a leased serial'; exit 1; }
  sleep 1
done
[[ -n "$owned_device" ]] || { error='Timed out identifying the leased emulator'; exit 1; }
export LATENCY_RIG_DEVICE="$owned_device"
timeout 180s adb -s "$owned_device" wait-for-device

phase="port selection"
ss -ltn >"$state/host-listeners.txt"
ports="$(node --input-type=module - "$state/host-listeners.txt" <<'JS'
import net from 'node:net';
import { readFileSync } from 'node:fs';
const used = new Set(readFileSync(process.argv[2], 'utf8').split('\n').map((line) => Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1])));
const servers = [], ports = [];
try {
  for (const start of [process.env.LATENCY_RIG_SERVER_PORT ?? 18880, process.env.LATENCY_RIG_PORT ?? 18881]) {
    let selected = false;
    for (let port = Math.max(1024, Number(start)); port <= 65535; port++) {
      if (used.has(port)) continue;
      const server = net.createServer();
      try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
        servers.push(server); ports.push(port); used.add(port); selected = true; break;
      } catch (error) {
        if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
        used.add(port);
      }
    }
    if (!selected) throw new Error('No unused unprivileged port available');
  }
  console.log(ports.join(' '));
} finally { for (const server of servers) await new Promise((resolve) => server.close(resolve)); }
JS
)"
read -r LATENCY_RIG_SERVER_PORT LATENCY_RIG_PORT <<<"$ports"
export LATENCY_RIG_SERVER_PORT LATENCY_RIG_PORT
# local-attempt.sh takes capture.lock itself; do not pass our descriptor down.
flock -u 9
exec 9>&-
phase="nightly-run.sh"
setsid bash "${LATENCY_HOST_NIGHTLY_RUN:-$checkout/scripts/latency-rig/nightly-run.sh}" >"$state/host-nightly.log" 2>&1 &
nightly_pid=$!
printf '%s\n' "$nightly_pid" >"$state/host-nightly.pid"
verdict=0
wait "$nightly_pid" || verdict=$?
printf '%s\n' "$verdict" >"$state/host-nightly.exit"
cat "$state/host-nightly.log"
exit "$verdict"
