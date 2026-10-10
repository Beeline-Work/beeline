# Beeline latency rig

This tooling measures a locally seeded monolith and an Android release app. It
does not use a production Workspace. The fixture script rejects any database
whose URL is not loopback and whose name does not contain `latency_rig`.
`baseline-coverage.md` lists all 39 routes and 26 interactions, with a warm
Room sample and explicit unmeasured rows for the remaining cases.
`baseline-http-only.md` contains a separate
local server/proxy baseline; its HTTP times are not page or tap times.
`baseline-room-warm.md` records 20 steady-state warm Room opens on an
uncalibrated x86 emulator; those samples had zero prepaint requests.
`baseline-network-sweep.md` records 120 additional warm Room opens across
four configured RTT profiles, with the limits of that comparison.

## Current scope

- `seed-local.mjs` creates three signed-reviewer Workspaces with 1, 10, and 200
  Rooms. The 200-Room fixture has a 300-corner Room, 10,000 older activity rows,
  a 30-message visible window, and a 10,240-byte answer payload. It does not
  simulate a streaming agent turn. IDs are deterministic,
  and seeding is idempotent.
- `run-local.sh` migrates and starts the local monolith, plus `proxy.mjs` on
  loopback. `pg-probe.cjs` is a local-only Node preload that records every SQL
  statement, its operation, pool wait, row count, and serial interval even below
  the product's slow-operation logging threshold. It logs no SQL text or values.
- `proxy.mjs` records HTTP request/response **body** bytes and WebSocket
  **message payload** bytes. It
  supports RTT, jitter, bandwidth, and whole-request failure injection. A
  whole-request failure is **not** a packet-loss simulation. The proxy does not
  report header bytes, physical WebSocket frame counts, compressed wire bytes,
  retransmits, or TLS handshake cost.
- `room-marks.mjs` extracts the existing release Room first-frame marker from
  `adb logcat -v epoch`. `join.mjs` correlates device marks, proxy spans, and SQL
  spans for serial actions. The proxy adds an internal trace header to its
  local backend request; the SQL preload consumes it without echoing it in
  phone responses or live frames. `analyze.mjs` reports p50/p95/p99, prepaint HTTP
  count and serial depth, bytes, WebSocket messages, SQL statements/depth/pool
  wait, and budget verdicts. Missing routes fail a checked report.
- `routes.json` declares the cold request budget for every Expo route;
  `interactions.json` lists the launch interaction matrix. Warm routes have a
  zero-prepaint-request budget. `check-routes.mjs` fails when a new route lacks
  an explicit entry. Tap samples require one write, zero completed round trips
  before feedback, and zero follow-up GETs.

## Local run

Requires Node, PostgreSQL with local peer access, the Android SDK, and a
disposable emulator. Use a review secret generated only for this local server.
The server binds loopback and the proxy binds loopback; `10.0.2.2` reaches the
host from Android Emulator. Keep the server running while collecting samples.

```sh
export LATENCY_RIG_REVIEW_SECRET="$(openssl rand -hex 24)"
export LATENCY_RIG_RTT_MS=100
export LATENCY_RIG_JITTER_MS=12
export LATENCY_RIG_MBPS=10
bash scripts/latency-rig/run-local.sh
```

`start-emulator.sh` creates a worktree-owned Android 35 AVD on `emulator-5580`,
without touching other lanes' devices. `build-local.sh` builds a **Hermes
release** APK against `http://10.0.2.2:8081`, with the existing release Room
trace enabled, an isolated OTA channel, and a throwaway signing key. The
existing sideload build patch permits cleartext LAN traffic in this local APK;
this HTTP build excludes TLS handshake cost and cannot substantiate a
production-wire claim. For TLS measurement, point the build at a trusted
`https://10.0.2.2:<port>` terminator on the disposable emulator. The proxy
accepts `LATENCY_RIG_TLS_CERT` and `LATENCY_RIG_TLS_KEY`, while keeping its
backend on loopback. Never use the production sideload key.

```sh
bash scripts/latency-rig/start-emulator.sh &
adb -s emulator-5580 wait-for-device
bash scripts/latency-rig/build-local.sh
adb -s emulator-5580 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
adb -s emulator-5580 shell am start -a android.intent.action.VIEW \
  -d "beeline://review/$LATENCY_RIG_REVIEW_SECRET" app.usebeeline/.MainActivity
bash scripts/latency-rig/capture-room.sh
```

`capture-room.sh` repeats warm Room opens and writes a **Room-only** report.
It does not claim the 39-route launch baseline. Stop the dedicated AVD with
`scripts/latency-rig/stop-emulator.sh` after capture.
`sweep-room.sh` drives 30 opens each at 50, 100, 200, and 300 ms configured
RTT, then writes `.local/rtt-sweep/summary.md`. Its 1% failure profile drops
whole requests, not individual packets.

On the current i9-10900K runner, the emulator starts in a user systemd CPU
scope at 200% of one host core. We first tried the published Geekbench 6
single-core score of [1744 for i9-10900K](https://browser.geekbench.com/processors/intel-core-i9-10900k)
and [800 for Galaxy A16 Exynos 1330](https://browser.geekbench.com/mobile-benchmarks):
800 / 1744 = 45.9%. A 46% **whole-emulator** quota made System UI
unresponsive, so that ratio is invalid as an emulator setting. Five warm Room
opens at 100% produced 268, 269, 271, 792 and 993 ms samples; at 200% they
produced 94, 121, 156, 229 and 232 ms. The default 200% is an operational
scenario selected to keep Android responsive, **not** an A15 calibration.
`LATENCY_RIG_CPU_QUOTA_PERCENT` overrides it; an unknown host refuses the
default. QEMU, Android scheduling, GPU and memory differ from a phone. Keep
that distinction in every report. A release device verdict needs a physical
A15-class Android cross-check or a comparable same-benchmark emulator result.

Collect logcat with `adb -s <serial> logcat -v epoch` while driving the app.
For Room first-frame samples:

```sh
node scripts/latency-rig/room-marks.mjs logcat.txt moments.ndjson cold
node scripts/latency-rig/join.mjs \
  --moments moments.ndjson \
  --proxy scripts/latency-rig/local-proxy.ndjson \
  --sql scripts/latency-rig/local-sql.ndjson \
  --out samples.ndjson
node scripts/latency-rig/analyze.mjs \
  --input samples.ndjson --routes scripts/latency-rig/routes.json \
  --interactions scripts/latency-rig/interactions.json \
  --commit "$(git rev-parse HEAD)" --device '<device/CPU calibration>' \
  --network '<measured RTT and profile>' --out report.md --check
```

The opt-in APK also logs `[LATENCY_FRAME]` for root touch starts, frame
candidates, route commits, and content-ready route frames. Use
`route-marks.mjs logcat.txt moments.ndjson warm` to extract only explicit
content-ready route marks. It prefers a touch start within 1 s before the
navigation commit. Candidate marks are intentionally excluded: they do not
prove visible content or tap feedback. For a cold deep link, provide an
external launch-start timestamp; a route commit alone misses process start.

For another route or tap, supply one `moments.ndjson` record per sample:

```json
{"kind":"route","name":"/beeline/channels","variant":"cold","startMs":1000,"paintMs":1220,"endMs":1400}
```

`startMs`, `paintMs`, and `endMs` are epoch milliseconds from a device frame
probe; `paintMs` must be the first meaningful content frame. A tap sample uses
`kind:"tap"` and its first visible local feedback frame. The `endMs` window
must include its canonical server settlement if that metric is wanted. Capture
serial samples or provide a common trace ID; timestamp overlap alone cannot
attribute concurrent actions.

## Calibration and limits

The release Room GET now returns its server processing time in `Server-Timing`.
The phone measures the winning request's start and response-header arrival
with its monotonic clock. After the Room paints, the **existing** page-load
observation carries those two durations; it adds no network call. The server
stores `request-to-first-byte minus server processing` as
`operator_function_events.network_rtt_residual_ms`. This captures network,
Fly edge and connection setup in one upper-bound residual, without trying to
synchronize phone and server clocks. It does not capture radio packet RTT.
Once that release has real traffic, export at least 20 content-free values
read-only and run `derive-rtt.mjs` on one JSON object per line:

```sql
SELECT network_rtt_residual_ms
FROM operator_function_events
WHERE function_name='page_load' AND network_rtt_residual_ms IS NOT NULL
  AND created_at >= now()-interval '1 day'
ORDER BY id DESC LIMIT 1000;
```

Until then, 50/100/200/300 ms sweeps are scenarios, **not** measured production
RTT. Do not label an x86 emulator equivalent to an A15 phone based on the CPU
quota alone. Cross-check Hermes startup, JS execution, rendering and scrolling
against a physical A15-class Android before publishing a device verdict.

Room has an in-app release first-frame marker. Some other routes now have
content-ready marks; others have only frame candidates, and tap feedback has
only frame candidates. Each candidate needs a visible-state probe before it
can be called the first meaningful frame. `uiautomator` visibility alone is
an imprecise upper bound. Exact physical bytes, negotiated compression, and
packet loss need an on-device packet capture. The report generator refuses
to fill unmeasured routes with static estimates.

The per-PR contract check validates route coverage and the deterministic
budget evaluator. Real timing checks belong in the on-demand rig workflow,
where a release app and device capture are available; they are not a flaky PR
gate. The on-demand job requires a runner labeled `beeline-android-rig` with
`LATENCY_RIG_CAPTURE_COMMAND` set to an executable that writes fresh,
first-frame `samples.ndjson` for this checkout, plus device and network
descriptions. Until all routes and interactions have frame marks, its checked
report fails closed; a partial Room capture is not a passing launch baseline.
