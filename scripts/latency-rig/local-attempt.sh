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
mkdir -p "$output/capture"
# Setup failures still carry this night's load instead of a stale capture.
node --input-type=module - "$output/capture/host-load.json" <<'JS'
import os from 'node:os';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify([{ atMs: Date.now(), load: os.loadavg(),
  freeMemory: os.freemem(), totalMemory: os.totalmem(), cpus: os.availableParallelism() }], null, 2));
JS
device="${LATENCY_RIG_DEVICE:?select the owned Beeline-leased emulator explicitly}"
if [[ ! "$device" =~ ^emulator-[0-9]+$ ]]; then echo 'Disposable emulator required' >&2; exit 2; fi
cd "$repo_dir"
lock_dir="${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy"
mkdir -p "$lock_dir"
exec 9>"$lock_dir/capture.lock"
export GRADLE_USER_HOME="$lock_dir/gradle"
flock -n 9 || { echo 'Another Speedy rig attempt is running' >&2; exit 2; }
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:-} -Dorg.gradle.workers.max=2"
fixture_database="beeline_latency_rig_speedy_$(date +%s)_$$"
export LATENCY_RIG_DATABASE_URL="postgresql://localhost/$fixture_database?host=%2Fvar%2Frun%2Fpostgresql"
export LATENCY_RIG_REVIEW_SECRET
LATENCY_RIG_REVIEW_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("hex"))')"
export LATENCY_RIG_SERVER_PORT="${LATENCY_RIG_SERVER_PORT:-18880}" LATENCY_RIG_PORT="${LATENCY_RIG_PORT:-18881}"
export LATENCY_RIG_PROXY_LOG="$output/proxy.ndjson" LATENCY_RIG_SQL_LOG="$output/sql.ndjson"
export EXPO_PUBLIC_BUZZY_MONOLITH_URL="http://10.0.2.2:$LATENCY_RIG_PORT"
export BEELINE_ANDROID_NATIVE_LATENCY_PROBE=1
export LATENCY_RIG_RTT_MS=100 LATENCY_RIG_JITTER_MS=0 LATENCY_RIG_MBPS=10
export LATENCY_RIG_REQUEST_FAILURE_RATE=0 LATENCY_RIG_ROOM_SAMPLES=20
unset LATENCY_RIG_ENTRY LATENCY_RIG_TLS_CERT LATENCY_RIG_TLS_KEY
# Fail rather than attaching to another lane's service.
node --input-type=module <<'JS'
import net from 'node:net';
const ports = [process.env.LATENCY_RIG_SERVER_PORT, process.env.LATENCY_RIG_PORT].map(Number);
if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || ports[0] === ports[1])
  throw new Error('Choose two distinct unprivileged loopback ports');
for (const port of ports) await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => server.close(resolve));
});
JS
rm -f "$output/report.json" "$output/report.md" "$output/samples.ndjson"
# Stop the previous fixture app before starting a new backend on these ports.
adb -s "$device" shell am force-stop app.usebeeline
# Each attempt starts with the same fixture, including no prior send leases.
createdb --host=/var/run/postgresql "$fixture_database"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  dropdb --host=/var/run/postgresql --if-exists "$fixture_database" || echo "Fixture cleanup failed: $fixture_database" >&2
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash scripts/latency-rig/run-local.sh >"$output/server.log" 2>&1 &
server_pid=$!
for _ in {1..180}; do
  kill -0 "$server_pid" 2>/dev/null || { echo 'Local server exited before readiness' >&2; exit 1; }
  if curl -fsS "http://127.0.0.1:$LATENCY_RIG_PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$LATENCY_RIG_PORT/healthz" >/dev/null
# Build all mobile SDK entry points before Metro on a fresh checkout.
npx turbo run build --filter=@beeline/buzz-client... --filter=@beeline/nostr... --filter=@beeline/api-contract... >"$output/sdk-build.log" 2>&1
mkdir -p "$GRADLE_USER_HOME/init.d"
cat > "$GRADLE_USER_HOME/gradle.properties" <<'PROPERTIES'
org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g
org.gradle.workers.max=2
reactNativeArchitectures=x86_64
kotlin.compiler.execution.strategy=in-process
PROPERTIES
cp scripts/latency-rig/android-build.init.gradle "$GRADLE_USER_HOME/init.d/latency-rig.gradle"
bash scripts/latency-rig/build-local.sh >"$output/build.log" 2>&1
adb -s "$device" install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
# This explicitly owned disposable app must not restore another attempt's cache.
adb -s "$device" shell pm clear app.usebeeline >/dev/null
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
