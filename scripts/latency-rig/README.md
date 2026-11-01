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
  whole-request failure is **not** a packet-loss simulation. WebSocket propagation delays overlap across messages; only their byte
  serialization is queued. Earlier captures charged half an RTT per queued
  message and must not be compared with this corrected shaping. The proxy does not
  report header bytes, physical WebSocket frame counts, compressed wire bytes,
  retransmits, or TLS handshake cost.
- Phone operations on the live socket also produce separate `phone-request`
  start/reply spans. Read/write classification uses the shared
  `PHONE_READ_OPERATIONS` contract; the span's GET/POST value is a budget
  category, not an extra HTTP request. Request IDs become connection-scoped
  hashes; arguments, results, authentication frames and raw IDs are never
  logged by this instrumentation. Byte totals still come from the raw WS
  records once, without counting the logical spans again.
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
The phone uses the winning request's native resource entry for request start,
response-header arrival and response completion, and separately records when
JavaScript handles the response. Older binaries without resource timing omit
the wire measurement; a delayed JavaScript callback is never a substitute for
native arrival. After the Room paints, the **existing** page-load
observation carries those two durations; it adds no network call. The server
stores `request-to-first-byte minus server processing` as
`operator_function_events.network_rtt_residual_ms`. This captures network,
Fly edge and connection setup in one upper-bound residual, without trying to
synchronize phone and server clocks. It does not capture radio packet RTT.
`js_response_delay_ms` stores JavaScript handling minus native body completion,
separating bridge/JS queue delay from both the network and body transfer. It is
an arrival-to-handling delay, not a CPU-utilization measurement. Both values
ride the same sampled page observation. Rows without a JS response delay can
come from legacy clients that measured header handling in JavaScript; exclude
those rows when deriving native wire timing.
Once that release has real traffic, export at least 20 content-free values
read-only and run `derive-rtt.mjs` on one JSON object per line:

```sql
SELECT network_rtt_residual_ms, js_response_delay_ms
FROM operator_function_events
WHERE function_name='page_load' AND network_rtt_residual_ms IS NOT NULL
  AND js_response_delay_ms IS NOT NULL
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

Run `node scripts/latency-rig/check-routes.mjs` and
`node --test scripts/latency-rig/*.test.mjs` to validate route coverage and the
deterministic budget evaluator. Device capture runs on squire.
Nightly timing uses the squire emulator and standing-corner schedule documented
below. A full launch report still requires all route and interaction marks;
the nightly subset does not establish that broader budget. Missing required
subset cases fail closed.

Room request contracts also reject any star-prompt, Workspace, read-mark or
Room-list request starting before the native draw mark, even when the overall
request-count budget would allow it.

Those request budgets count HTTP and socket operations together. The report
retains the HTTP-only counters and adds `maxPrepaintRequestCount` and
`maxPrepaintRequestDepth` for the combined gate. Socket replies are matched by
request identity, including concurrent out-of-order replies. A required request
with no reply stays visible and fails rather than disappearing as zero work.
Postpaint housekeeping remains outside page/prepaint budgets. The local SQL
preload restores a per-message scope after a manual WebSocket upgrade, so
socket operations retain their request trace instead of appearing as unowned
background SQL. Timing failures and request-contract failures are reported
separately; a fast reaction with a bad request contract is not called over budget.

## Room opens with newly arrived messages

`room-arrival-cases.json` fixes the four warm-session entry/count combinations:
Room list or Android push tap, with one or five new messages. Each has a strict
450 ms p95 budget and requires at least 20 samples. `check-routes.mjs` validates
that matrix. The native probe matches a unique suffix of the expected newest message in
an on-screen text row above the composer. A Room-list preview or clipped byline
cannot finish a case. Missing visible targets fail instead of disappearing
from the statistics. Capture caps each attempt at five seconds and retains a
`timedOut` sample when the target does not paint. Its 5000 ms value is a
censored failure bound, not a measured paint; any timeout fails the verdict,
even when p95 would otherwise hide one failure in twenty.

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

The capture brackets every sample with host/device clock anchors. `join.mjs`
converts device epochs to the host clock before attributing HTTP/SQL spans;
uncertain clocks or clock jumps fail closed. Native paint durations use one
device clock and remain independent of this conversion. Uncalibrated reports
cannot pass request contracts or advance the nightly baseline.

For a focused Hermes diagnosis, the same shell-protected fixture receiver
accepts `app.usebeeline.LATENCY_RIG_PROFILE` with `action=start` or `action=stop`.
Stop dumps `latency-profile.json` into the fixture app's external files directory.
These actions exist only in the emulator-only probe APK. Every frame captured
while profiling is marked; the arrival parser rejects it as acceptance evidence.
Run the normal unprofiled matrix again after any resulting fix.

The driver records the first open separately in `first-open.json` without a
cold-start verdict, then warms navigation and allows installation work to settle
for 30 seconds before collecting the warm-session matrix.

Room-list entries use an on-device `input tap` on the visible fixture row;
push entries use Android FCM tap extras on `PushNotificationActivity`, through
the same Expo response listener as a notification tap. Reports measure Activity
entry to the target text native frame commit; the removed native-response phase
is absent. Foreground JS in-app notices are not measured by this push-tap case.
This excludes delivery
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

The nightly run is a **Jellybean-owned Beeline schedule in the standing
latency-rig corner** `acca09be-d0fb-443d-a32f-31d1a9737023`, beneath Room
`bb91a1c7-7cad-4fde-aafc-94fccb651ac8`, at 03:00 America/New_York on squire.
Its installed schedule id is `390f36c4-454d-475a-a789-0d3561bcdc92`.
Room turns lack the corner emulator lease; keep this corner open. Speedy's old
schedule was deleted when Jellybean took over. The schedule uses no GitHub
device job, webhook, or new token. A documented prompt alone does not install
a schedule; retain the creation/update receipt and avoid a second owner/run.

### Nightly setup and execution

Manage the existing schedule from the standing corner. From the prepared,
dependency-installed detached `origin/main` checkout on squire, with
`LATENCY_RIG_DEVICE` selecting this run's owned emulator,
the exact repo-root command is:

```sh
bash scripts/latency-rig/nightly-run.sh
```

Schedule at **03:00 America/New_York**. Reserve a four-hour window including
checkout/dependency/emulator setup; this is an operating allowance, not a measured
build-duration promise. Each of at most two capture/build attempts is capped at
90 minutes, with a further 60-second termination grace each. The script prints
the exact output path: `${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy/night-<UTC-date>-<unique>/nightly.json`.
That directory also contains both attempts and the commit range. Each reported
case prints a summary line with n, p50, p95, target and PASS/FAIL.

Exit zero means complete calibrated coverage, 20 samples per case, valid request
contracts, route p95 strictly below 450 ms and tap p95 strictly below 150 ms,
and no case more than 20% slower than the last passing baseline. A failed/skipped
first attempt gets exactly one retry. Any final failure exits nonzero, preserves
the baseline and sets `shouldAlert` in the verdict when comparison succeeds.
The scheduled agent must also report setup/command errors that prevent a verdict;
it posts one final PASS/FAIL result in the corner every night. The command does
not install a schedule or send messages. Fetch and detach latest `origin/main`
before invoking it, as described below.

Use persistent private state `${XDG_STATE_HOME:-$HOME/.local/state}/beeline/latency-rig-speedy`
(mode 0700), outside repository scans. Keep a detached `checkout` there, backed
by the existing Beeline repository. Fetch `origin/main` and check out its exact
SHA before every night. Never run the benchmark from an old feature checkout,
never change a main branch, and never discard unrelated changes. Install root
and mobile dependencies when the measured head changes. Read the current rig
scripts before running them. Use the repository's `build-local.sh` signing;
production signing is unnecessary.

The corner scratch allowance applies to its assigned worktree, not the combined
size of its private agent home, dependency caches and detached rig checkout.
The helper must include the [scratch-accounting fix](https://github.com/Beeline-Work/beeline/pull/3209);
an older loaded helper can still advertise or enforce the wrong usage even
when the measured checkout contains the fix. Do not invent a separate 5 GiB
limit for `latency-rig-speedy` or terminate a healthy attempt from that directory's
`du` total. Check actual filesystem space and the configured session memory cap.
The [November 1 investigation](evidence/nightly-setup-2026-11-01/README.md)
records the distinction between a setup interruption and measured latency.

Launch an owned private emulator with `beeline emulator -avd se_api35 -no-window
-gpu swiftshader_indirect -no-snapshot -memory 2560 -cores 4`. Identify its leased
serial through its own launcher/child process, then select it explicitly with
`LATENCY_RIG_DEVICE`; never select another lane's device merely because it is
online. Preserve these device settings and the fixed local network shape night
over night. Do not build during capture. The local attempt caps Node and Gradle
heaps at 4 GiB, Gradle and Metro workers at two, and compiles Kotlin in-process.
Its fixture-only Gradle init script selects `:app:assembleRelease` for x86_64
and omits Android release dependency lint;
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
through the local review link after backend readiness, captures the ten fixed
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
- Reaction, corner open, conversation-tab switch and composer open, using the
  native completion contracts below.

Each case has 20 samples. Cold opening is recorded separately and never gates
this subset. Host load and free memory are sampled every ten seconds into
`capture/host-load.json`, including failed captures. Typical nightly work is a
release build plus 200 samples; it does not run every application route.

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

After every final verdict, Jellybean posts **one** result to the standing
corner, attaching the report and host-load evidence. A failure includes `text`
when `shouldAlert` is true. It names all PRs in the complete first-parent range
since the last passing run, excluding that run.
With no passing baseline, say that the range is unavailable rather than invent
PRs. Persist `{night, messageId}` to `last-alert.json` only after the post receipt;
check that record before any retry so one failed night produces one alert.
A skipped setup also gets one rerun and then one failure alert.
Stop only the emulator and fixture processes owned by this wake.

### Schedule prompt

The existing Jellybean schedule uses
`cadence:{kind:cron, expression:"0 3 * * *", timeZone:"America/New_York"}`.
Update it with `wake(action:update, trigger:schedule, scheduleId, prompt)` from
the standing corner rather than creating a duplicate. Its execution contract is:

> Run the nightly squire emulator latency rig under scripts/latency-rig/README.md
> Nightly setup and execution. Fetch origin/main into the private detached
> latency-rig-speedy checkout; read the current scripts, install dependencies
> if needed, and use an owned Beeline-leased se_api35 emulator (2560 MiB, 4 cores).
> Bind-test an unused local port pair. Run nightly-run.sh and monitor it in the
> same turn until exit, retaining its log and exit status. It compares reports,
> full commit range and recorded host load, retries a failure/skip exactly once,
> and advances the baseline only on pass. Publish every final verdict through
> the approved Insights connection as documented below. Post one PASS/FAIL
> result with case n/p50/p95 and evidence here in the standing corner, naming
> PRs since the last pass when available; save the post receipt. Report skipped
> setup too. Never use a GitHub runner, webhook or new token. Preserve all
> samples and clean up only this
> wake's emulator/server. Keep the corner open.

### Durable history and cumulative drift

`nightly-run.sh` assigns a unique directory/run ID and freezes the Eastern night
before capture starts. Each comparison appends its verdict to
`$rig_state/history.jsonl`, including missing captures and the provisional
first-attempt failure. `final: false` means the single rerun is still required;
a pass or the second attempt is final. A repeated `(runId, attempt)` is an
immutable replay: it returns the recorded verdict without adding another entry
or using changed capture inputs. Use a new run ID for a genuinely new run.
Direct CLI callers may supply `--run-id`, `--night YYYY-MM-DD`, or
`--started-at <ISO timestamp>`; the default identity is the absolute output path.
Keep the same identity and Eastern date for both attempts. The CLI retains the
first recorded date for that identity even when a rerun crosses midnight.

The state-directory `nightly.lock` excludes concurrent comparator writers. After
a killed writer, verify no comparison is running before removing a stale lock.
Journal writes are flushed before advancing the baseline. The next invocation
repairs `last-pass.json` from the latest journaled final pass if a process stopped
between those writes. Malformed history fails closed rather than discarding it.

`first-pass.json` never advances. On migration it preserves the existing
`last-pass.json` as the earliest available passing baseline; older passing nights
cannot be reconstructed. With no pass yet, the first actual pass establishes it.
Failures and skips never establish or replace a baseline.

In addition to the unchanged strict budgets and last-pass 20% check, every case
compares p95 with the original passing baseline and the median of up to seven
prior passing Eastern nights. Cases match by kind, name and variant. Current,
future, provisional and failing nights are excluded; multiple passes on one date
count as one recent night (the last passing final verdict for that date). More
than 10% slowdown against either reference fails and follows the existing single
rerun/alert policy. Exactly 10% passes this drift check. Available history is used
from the first prior pass; each verdict prints the count out of seven and says
`unavailable` when a reference does not exist. No missing measurement is zero.

### Publishing measured Loops trends

The dashboard README `/api/loops` contract supports arbitrary named chart series;
no renderer change is needed. `nightly-insights.mjs` adds one chart per measured
case with `case:<kind>/<name>/<variant>:p50` and `:p95` series (ms), keeping the
existing `actions`, `actions_max`, `pages`, `pages_max`, fixes and unrelated loops.
It replaces a point on the same Eastern date instead of duplicating it. Complete,
calibrated, current-head measurements are charted even when timing/request/drift
checks fail. Skipped/incomplete/stale/uncalibrated captures add no points. The
latency note and dated log describe the final result and capture limits.

After **every final verdict**, the scheduled agent publishes through the owner's
approved first-party `github / beeline-insights-loop` connection. Credentials stay
in the connection, never in the rig, repository or capture environment:

1. Read the current GitHub contents response for
   `Beeline-Work/beeline-insights`, `main`, `loops/loops.json` and save its
   `{sha, content}` as `contents.json` outside the repository. Use the Beeline
   App for any linked-repository write; never switch to personal credentials
   following an App denial.
2. Prepare the optimistic update:

   ```sh
   node scripts/latency-rig/nightly-insights.mjs \
     --contents "$run_dir/contents.json" --verdict "$run_dir/nightly.json" \
     --out "$run_dir/insights-put.json"
   ```

3. Send that JSON body with an authenticated PUT to the same contents endpoint
   through the approved first-party connection. Its `sha` is mandatory. On HTTP
   409, read the latest contents, regenerate the body, and retry (at most three
   writes); never resend a stale body or replace unrelated concurrent edits.
   `publishInsights(transport, verdict)` implements this protocol for a sealed
   transport; the CLI only prepares the request and has no network credentials.
4. Save the successful publication receipt with the run; a publication failure
   must be reported and retried from fresh contents, including on a passing night.
   This does not change the measurement verdict or baseline. Publish only final
   nightly output, never its provisional attempt. An exact retry of a run is
   safe; do not replay older independent runs over a newer result for that date.

The schedule must use `nightly-run.sh` (or the equivalent identity/date arguments)
and perform this publication step after its final comparison, including FAIL or
skipped capture. Existing alert deduplication still applies independently.

Deterministic checks (no emulator or production credentials):

```sh
node --test scripts/latency-rig/nightly-*.test.mjs
node scripts/latency-rig/prove-nightly-drift.mjs
```

`fixtures/night-2026-10-30-report.json` is the complete local-only attempt-2 report
from inherited run `night-2026-10-30-EG85he`, main
`e20fb93ade55d09b4a75f6c309e7c3c170b16119`. It proves failed measurements reach
history and publication without establishing a passing baseline. The synthetic
100 → 105 → 110.25 ms fixture proves cumulative drift despite small nightly steps.

## Timed tap actions

The nightly capture also includes `react-message`, `open-corner`, `switch-tabs`,
and `open-composer`. Each reports p50 and p95, with a strict **p50 <150 ms**
target. Existing six cases retain their existing targets and request rules.
The nightly comparator and its existing p95 budget/regression rules remain unchanged;
a p50 tap pass alone does not establish a passing nightly baseline.
All four start at the native Activity's touch-up dispatch, before React handles
that tap, and end at the first frame commit after the first draw containing
the result. The probe requests that frame, so a static result such as an empty
tab still completes; this adds at most one frame to the sample. Highlight, selection, navigation commit and JavaScript callbacks
alone cannot finish these samples.

| Case | Setup and measured tap | Visible completion | Expected requests |
|---|---|---|---|
| `react-message` | Open the fixture Room; insert a unique short message with one 👍 from the fixture agent; tap its existing reaction chip. | Unique message visible above the composer and chip reads `👍, 2 reactions`. The fixture viewer's optimistic reaction has appeared. | One reaction write, no completed prepaint round trip, no follow-up GET. |
| `open-corner` | Open the parent Room's corners list; insert unique text in a visible seeded corner, then tap that corner row. Opening the list is setup. | Unique corner message visible above its composer in the destination native Screen; the corner title/list preview cannot satisfy it. | At most one prepaint covering read; no prepaint housekeeping. Normal postpaint page/read telemetry is outside this request budget. |
| `switch-tabs` | Open the conversation list on All, with no pinned fixture conversations; tap Pinned. | Target tab's `No pinned conversations yet.` content is visible; selected tab styling is insufficient. | No requests. |
| `open-composer` | Open the Room with the keyboard dismissed; tap Message. | The visible Message EditText has focus and native IME insets report the keyboard visible. Focus alone is insufficient. | No requests. |

Reaction fixture messages are removed after capture so prior chips cannot
complete later samples. Corner messages use a fresh unique token per attempt.
The fixture database and emulator remain local and disposable. A missing action
fails setup; an absent completion produces a censored timeout, never a successful
sample. Keyboard animation and navigation rendering are included in the duration.
The native Screen boundary uses a type check so release obfuscation cannot
disable completion. These are frame-submission measurements, not physical scanout timings.

Accessibility setup dumps retry at most three times, clearing the old file and
requiring a successful, complete hierarchy before reading controls. Failed
attempts wait 35 seconds outside measurement. A fixture send can create a
pending WORKING receipt with no helper to finish it: the legitimate thinking
counter changes accessibility content each second until the phone's existing
90-second freshness deadline. The retry window covers that finite lifetime;
a screen that stays busy still fails with its action and sample in the error.
Regression coverage: `node --test scripts/latency-rig/dump-ui.test.mjs`.
After insertion, reaction setup also waits for the exact new message's
one-reaction chip across at most three fresh hierarchies, with 1.5-second gaps
only when it is absent. A valid hierarchy may still show the preceding
sample's two-reaction tail. That old chip, an already completed result, or an
invisible target never qualifies. This wait ends before clock calibration and
timer arming; native completion still requires the new two-reaction frame.
An absent fixture fails with its action, sample and target instead of dropping
a measurement. Coverage: `nightly-reaction.test.mjs`.
Composer setup uses the system `mInputShown` value when present. An IME can
retain `mIsInputViewShown=true` after hiding; that older flag is a fallback only.

For a single smoke sample of each new case, build/install the fixture APK and sign
into its local server, select Latency Rig 200, then run:

```sh
LATENCY_RIG_SMOKE=1 LATENCY_RIG_ENTRY=timed-taps \
  node scripts/latency-rig/capture-arrivals.mjs .beeline-proof/timed-taps
```

Use an individual action name as the entry filter to isolate it. Supply the leased
`LATENCY_RIG_DEVICE` and loopback `LATENCY_RIG_DATABASE_URL` as for arrival
capture. `LATENCY_RIG_SMOKE=1` permits one sample (the ordinary minimum stays
20); it never relaxes nightly analysis coverage and cannot establish a passing
nightly verdict. With no entry filter smoke mode captures the arrival cases too;
use the explicit entry filter for these bounded proofs.
