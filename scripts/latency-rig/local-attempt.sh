#!/usr/bin/env bash
# One bounded nightly attempt on an explicitly owned disposable emulator.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
output="${1:?absolute output directory required}"
if [[ "$output" != /* ]]; then echo 'Output directory must be absolute' >&2; exit 2; fi
mkdir -p "$output"
chmod 700 "$output"
# Clear previous verdicts before even validating setup or acquiring the lock.
rm -f "$output/report.json" "$output/report.md" "$output/samples.ndjson"
device="${LATENCY_RIG_DEVICE:?select the owned Beeline-leased emulator explicitly}"
if [[ ! "$device" =~ ^emulator-[0-9]+$ ]]; then echo 'Disposable emulator required' >&2; exit 2; fi
cd "$repo_dir"
lock_dir="${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy"
mkdir -p "$lock_dir"
exec 9>"$lock_dir/capture.lock"
export GRADLE_USER_HOME="$lock_dir/gradle"
flock -n 9 || { echo 'Another Speedy rig attempt is running' >&2; exit 2; }
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Dorg.gradle.workers.max=2}"
export LATENCY_RIG_DATABASE_URL='postgresql://localhost/beeline_latency_rig_speedy_nightly?host=%2Fvar%2Frun%2Fpostgresql'
if ! psql "$LATENCY_RIG_DATABASE_URL" -Atqc 'SELECT 1' >/dev/null 2>&1; then createdb beeline_latency_rig_speedy_nightly; fi
export LATENCY_RIG_REVIEW_SECRET
LATENCY_RIG_REVIEW_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export LATENCY_RIG_SERVER_PORT=18880 LATENCY_RIG_PORT=18881
export LATENCY_RIG_PROXY_LOG="$output/proxy.ndjson" LATENCY_RIG_SQL_LOG="$output/sql.ndjson"
export EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18881
# Fail rather than attaching to another lane's service.
node --input-type=module <<'JS'
import net from 'node:net';
for (const port of [18880, 18881]) await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
JS
rm -f "$output/report.json" "$output/report.md" "$output/samples.ndjson"
bash scripts/latency-rig/run-local.sh >"$output/server.log" 2>&1 &
server_pid=$!
cleanup() { kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for _ in {1..180}; do
  kill -0 "$server_pid" 2>/dev/null || { echo 'Local server exited before readiness' >&2; exit 1; }
  if curl -fsS http://127.0.0.1:18881/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:18881/healthz >/dev/null
# Build all mobile SDK entry points before Metro on a fresh checkout.
npx turbo run build --filter=@beeline/buzz-client... --filter=@beeline/nostr... --filter=@beeline/api-contract... >"$output/sdk-build.log" 2>&1
bash scripts/latency-rig/build-local.sh >"$output/build.log" 2>&1
adb -s "$device" install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
adb -s "$device" shell pm grant app.usebeeline android.permission.POST_NOTIFICATIONS
adb -s "$device" shell am start -a android.intent.action.VIEW \
  -d "beeline://review/$LATENCY_RIG_REVIEW_SECRET" app.usebeeline/.MainActivity >/dev/null
signed_in=false
for _ in {1..30}; do
  adb -s "$device" shell uiautomator dump /sdcard/latency-rig-ready.xml >/dev/null
  ready_xml="$(adb -s "$device" shell cat /sdcard/latency-rig-ready.xml)"
  if [[ "$ready_xml" == *'content-desc="all conversations"'* ]]; then signed_in=true; break; fi
  sleep 1
done
if [[ "$signed_in" != true ]]; then echo 'Fixture sign-in did not reach the Room list' >&2; exit 1; fi
# Builds and migrations have ended before timers start.
LATENCY_RIG_NIGHTLY=1 node scripts/latency-rig/capture-arrivals.mjs "$output/capture" >"$output/capture.log" 2>&1
node scripts/latency-rig/join.mjs --moments "$output/capture/moments.ndjson" \
  --proxy "$LATENCY_RIG_PROXY_LOG" --sql "$LATENCY_RIG_SQL_LOG" --out "$output/samples.ndjson"
node scripts/latency-rig/analyze.mjs --input "$output/samples.ndjson" \
  --routes scripts/latency-rig/routes.json --interactions scripts/latency-rig/interactions.json \
  --room-cases scripts/latency-rig/room-arrival-cases.json --nightly \
  --commit "$(git rev-parse HEAD)" --device 'squire; se_api35; x86_64; 2560 MiB; 4 cores' \
  --network 'local HTTP; 100 ms RTT; 0 jitter; 10 Mbps' \
  --out "$output/report.md" --json-out "$output/report.json" --check
