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
budget evaluator. Nightly timing uses the squire emulator and parent-Room
schedule documented below. The legacy GitHub device job remains on demand;
there is no registered runner established for it, and nightly runs do not use
it. A full launch report still requires all route and interaction marks; the
nightly subset does not establish that broader budget. Missing required subset
cases fail closed.

## Room opens with newly arrived messages

`room-arrival-cases.json` fixes the four warm-session entry/count combinations:
Room list or Android push tap, with one or five new messages. Each has a strict
450 ms p95 budget and requires at least 20 samples. `check-routes.mjs` validates
that matrix. The native probe matches a unique suffix of the expected newest message in
an on-screen text row above the composer. A Room-list preview or clipped byline
cannot finish a case. Missing visible targets fail instead of disappearing
from the statistics.

`capture-arrivals.mjs` drives a leased disposable emulator and inserts messages
only into an explicitly supplied loopback `latency_rig` database. After signing
into the local fixture, select the **Latency Rig 200** Workspace. Set
`LATENCY_RIG_DEVICE` to the leased device and `LATENCY_RIG_DATABASE_URL` to that
fixture database, then run (JDK, Android 35 platform and build-tools 36.0.0 are required):

```sh
node scripts/latency-rig/capture-arrivals.mjs latency-rig-output/arrivals
node scripts/latency-rig/join.mjs \
  --moments latency-rig-output/arrivals/moments.ndjson \
  --proxy scripts/latency-rig/local-proxy.ndjson \
  --sql scripts/latency-rig/local-sql.ndjson \
  --out latency-rig-output/arrivals/samples.ndjson
node scripts/latency-rig/analyze.mjs \
  --input latency-rig-output/arrivals/samples.ndjson \
  --room-cases scripts/latency-rig/room-arrival-cases.json \
  --out latency-rig-output/arrivals/report.md --check
```

For a diagnostic capture of only one entry path, set `LATENCY_RIG_ENTRY=push`
or `room-list`. A subset still fails full-matrix coverage; it is not a passing
nightly run. The driver dismisses a Workspace overlay before arming list taps.

The driver records the first open separately in `first-open.json` without a
cold-start verdict, then warms navigation and allows installation work to settle
for 30 seconds before collecting the warm-session matrix.

Room-list entries use an on-device `input tap` on the visible fixture row;
push entries use Android FCM tap extras on `PushNotificationActivity`, through
the same Expo response listener as a notification tap. This excludes delivery
by FCM and System UI notification-shade latency. Each fixture message is a short
single line with a unique id suffix, so five messages fit the unchanged landing.

`build-local.sh` enables a native frame-commit probe only for the disposable
emulator host URL. The Expo plugin is absent from ordinary builds and rejects
production URLs. Its receiver requires Android's shell-only DUMP permission.
The timer starts at native touch-up or push Activity entry. An existing draw
must contain a full line of the unique target text above the composer in the
same native navigation Screen, excluding the previous Room-list preview; the
[Android frame-commit callback](https://developer.android.com/reference/android/view/ViewTreeObserver#registerFrameCommitCallback(java.lang.Runnable)) ends the sample. No accessibility polling
or JavaScript callback ends this timer. Unsupported hardware rendering fails
closed. Frame submission is measured, rather than physical display scanout.

The earlier `ROOM_OPEN` frame extractor remains available for diagnostic
comparison. Two JS animation callbacks after applying a response are not proof
that its newest text is visible; those timings must not be presented as the
native arrival-case verdict.

`nightly-compare.mjs` compares each case with its last passing p95, rejecting
strictly greater than 20% regression, over-budget samples, missing coverage,
and skipped captures. `mergedPrs` requires a complete first-parent commit range
from the measured head through the passing baseline, excluding that baseline.
The `--nightly` analyzer subset requires the four arrival cases, the existing
warm Room-open route, and send-text. Cold opens remain outside this nightly
gate. Every case requires 20 samples in the nightly comparison.

The nightly run is a **Speedy-owned Beeline schedule in the parent Room**
`bb91a1c7-7cad-4fde-aafc-94fccb651ac8`, at 03:00 America/New_York on squire.
It does not use the legacy GitHub on-demand device job, a webhook, or a new
token. Create it from that Room: the wake tool only schedules its current place,
and schedules belonging to archived corners do not run. Schedule installation
and its returned id must be recorded after creating it; a documented prompt
alone is not an installed schedule.

### Nightly setup and execution

Use persistent private state `${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy`
(mode 0700), outside repository scans. Keep a detached `checkout` there, backed
by the existing Beeline repository. Fetch `origin/main` and check out its exact
SHA before every night. Never run the benchmark from an old feature checkout,
never change a main branch, and never discard unrelated changes. Install root
and mobile dependencies when the measured head changes. Read the current rig
scripts before running them. Use the repository's `build-local.sh` signing;
production signing is unnecessary.

Launch an owned private emulator with `beeline emulator -avd se_api35 -no-window
-gpu swiftshader_indirect -no-snapshot -memory 2560 -cores 4`. Identify its leased
serial through its own launcher/child process, then select it explicitly with
`LATENCY_RIG_DEVICE`; never select another lane's device merely because it is
online. Preserve these device settings and the fixed local network shape night
over night. Do not build during capture. The local attempt caps Node and Gradle
heaps at 4 GiB, Gradle and Metro workers at two, and compiles Kotlin in-process.
Its fixture-only Gradle init script omits Android release dependency lint;
ordinary CI and release builds use their existing checks. A private Gradle home
keeps teardown from stopping another lane's daemon. These settings bound the
fixture build within the session's 31.41 GiB memory cap.

If public Maven is unavailable, prepare an isolated snapshot of already downloaded
dependencies before starting the attempt. [Gradle's read-only cache](https://docs.gradle.org/current/userguide/dependency_caching.html#sub:shared-readonly-cache)
can then reuse them while preserving the private writable Gradle home. On squire:

```sh
mkdir -p "$rig_state/dependency-snapshot"
rsync -a --exclude='*.lock' --exclude=gc.properties --chmod=Du=rwx,Dgo=,Fu=r,Fgo= \
  /home/lunchbox/.gradle/caches/modules-2 "$rig_state/dependency-snapshot/"
export GRADLE_RO_DEP_CACHE="$rig_state/dependency-snapshot"
```

Keep that snapshot unchanged while builds read it; never point the read-only cache
at a live Gradle installation's writable cache.

`local-attempt.sh` builds a local release/Hermes APK, starts `run-local.sh` on
loopback ports 18880/18881 by default, seeds the disposable PostgreSQL fixture, signs in
through the local review link after backend readiness, captures the six fixed
cases, joins HTTP/SQL spans, and writes report JSON/Markdown. It owns and stops
its fixture server and a uniquely named disposable PostgreSQL database, removed
on exit. Each attempt clears the fixture app on the explicitly owned emulator,
so prior send leases and phone caches cannot change the next attempt's workload.
An occupied port or missing sign-in fails instead of using another service.
The caller owns emulator cleanup. Set `LATENCY_RIG_SERVER_PORT` and
`LATENCY_RIG_PORT` to another unused unprivileged pair when the defaults are
occupied; the APK is built for that proxy port. Readiness checks require `lsof`
and verify that each listener is the child started by this attempt. The nightly subset is:

- Room list and push, with one and five unseen messages (four cases).
- Existing warm Room open with no unseen messages.
- Existing send-text interaction, ending at its optimistic row's native frame.

Each case has 20 samples. Cold opening is recorded separately and never gates
this subset. Host load and free memory are sampled every ten seconds into
`capture/host-load.json`, including failed captures. Typical nightly work is a
release build plus 120 samples; it does not run every application route.

From the detached main checkout, with `rig_state` set to the private state path:

```sh
head_sha="$(git rev-parse HEAD)"
node scripts/latency-rig/commit-range.mjs "$PWD" "$head_sha" "$rig_state/commits.json"
# A capture failure is an input to comparison, not a reason to abandon the wake.
bash scripts/latency-rig/local-attempt.sh "$rig_state/attempt-1"
node scripts/latency-rig/nightly-local.mjs \
  --current "$rig_state/attempt-1/report.json" --baseline "$rig_state/last-pass.json" \
  --commits "$rig_state/commits.json" --head "$head_sha" \
  --load "$rig_state/attempt-1/capture/host-load.json" --out "$rig_state/nightly.json"
```

The agent inspects `nightly.json` even when a command exits nonzero. Exit 2 and
`needsRerun` mean run `local-attempt.sh` **once more**, into `attempt-2`, then call
the comparison with the original arguments plus `--rerun attempt-2/report.json`
and that attempt's host-load path. Do not mix samples between attempts or drop
outliers. A passing rerun resolves load noise; a failed/missing rerun sets
`shouldAlert`. A passing report atomically replaces `last-pass.json`; failures
and skips preserve it. Malformed data, stale commits and an incomplete PR range
fail closed. The comparator takes report, baseline and commit-range files; it
needs no GitHub API.

When `shouldAlert` is true, Speedy posts **one** message containing `text` to the
parent Room, attaching the report and host-load evidence. It names all PRs in
the complete first-parent range since the last passing run, excluding that run.
With no passing baseline, say that the range is unavailable rather than invent
PRs. Persist `{night, messageId}` to `last-alert.json` only after the post receipt;
check that record before any retry so one failed night produces one alert. Passes
are silent. A skipped setup also gets one rerun and then one failure alert.
Stop only the emulator and fixture processes owned by this wake.

### Schedule prompt

Install the following with `wake(action:create, trigger:schedule,
cadence:{kind:cron, expression:"0 3 * * *", timeZone:"America/New_York"})` in the
parent Room, owned by Speedy:

> Run the nightly squire emulator latency rig under scripts/latency-rig/README.md
> Nightly setup and execution. Fetch origin/main into the private detached
> latency-rig-speedy checkout; read the current scripts, install dependencies
> if needed, and use an owned Beeline-leased se_api35 emulator (2560 MiB, 4 cores).
> Choose an unused local port pair if needed. Run local-attempt.sh, then
> nightly-local.mjs with last-pass.json, new report,
> full commit range and recorded host load. On any failure/skip rerun exactly
> once before deciding. Advance the baseline only on pass. If shouldAlert is
> true and last-alert.json does not name this UTC night, post its text and
> evidence once to Room bb91a1c7-7cad-4fde-aafc-94fccb651ac8, naming PRs since the
> last pass; save the post receipt. Report skipped setup too. Never use a GitHub
> runner, webhook or new token. Preserve all samples and clean up only this
> wake's emulator/server. On pass, remain silent.
