# Transcript speed harness

Measurement fixtures and drivers for the real Beeline Room UI. No product speed
fixes. iOS skipped by owner decision; Android is the reference.

## Local fixture

Run `npm run corner:prepare`, then follow `../latency-rig/README.md` to start the
local monolith and proxy with a fresh `beeline_latency_rig_transcript_*` database.
Set `LATENCY_RIG_DATABASE_URL` to that database, proxy port `19881`, backend port
`19880`, and local review secret `transcript-fixture-local-only-36bbb7b4`.
Allow `http://127.0.0.1:19882`, `http://tauri.localhost` and `tauri://localhost` in
`BEELINE_WEB_APP_ORIGINS`. Never point these scripts at user data.

```sh
node scripts/transcript-speed/seed.mjs
node scripts/transcript-speed/reset.mjs
node --test scripts/transcript-speed/measurement.test.mjs
```

Two Rooms and their streaming corner have deterministic mixed transcripts
(1,000 messages each). `reset.mjs` removes only scenario traffic from these
fixture Rooms. Text, markdown, code, replies, reactions and agent answers are
seeded; the corner appears through real corner facts. The image fixture is a
small placeholder with a delayed response (250 ms), not a photo-decoding stress
test. Streaming writes local `agent_turns`/`live_outputs` records so the normal
Postgres live bridge and application subscription handle both agents.

## Repeat a complete platform suite

After preparing the fixture and the matching build below, run one command:

```sh
node scripts/transcript-speed/capture-suite.mjs web scripts/latency-rig/.local/transcript-run/web
node scripts/transcript-speed/capture-suite.mjs android scripts/latency-rig/.local/transcript-run/android
node scripts/transcript-speed/capture-suite.mjs desktop scripts/latency-rig/.local/transcript-run/desktop
```

Run these serially, with builds stopped. Set `LATENCY_RIG_DATABASE_URL` for all
three, `LATENCY_RIG_DEVICE` for Android, and `TRANSCRIPT_WEBDRIVER_SESSION` for
Tauri. `TRANSCRIPT_DESKTOP_BINARY` selects an extracted packaged binary when it
is not at the default path below. Keep output and Gradle caches in persistent
storage: the agent's temporary directory and processes can disappear on a wake.
The suite resets only generated traffic in the fixture Rooms, then runs repeated
interactions, Room opens, and browser sampling-overhead pairs. It fails when an
older page, both streams, or a settled send cannot be demonstrated.

Generate tables and the measured scenario ranking with:

```sh
node scripts/transcript-speed/report.mjs \
  scripts/latency-rig/.local/transcript-run/android \
  scripts/latency-rig/.local/transcript-run/web \
  scripts/latency-rig/.local/transcript-run/desktop \
  scripts/transcript-speed/BASELINE.md
```

## Builds and captures

Instrumentation is opt-in with `BEELINE_TRANSCRIPT_MEASURE=1`. It adds commit
probes to the actual Room surface and memoized cells. Ordinary builds neither
load the Babel measurement plugin nor import its runtime. Always clear Metro
when changing this flag. Embedded metadata records the actual Metro compiler
option, engine, checkout SHA and tracked source diff digest.

For web, export from `apps/mobile` with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:19881` and
`npx expo export --platform web --output-dir transcript-instrumented --max-workers 2 --clear`.
Serve it and run:

```sh
node scripts/transcript-speed/serve.mjs apps/mobile/transcript-instrumented
node scripts/transcript-speed/capture-web.mjs /tmp/transcript-web
node scripts/transcript-speed/capture-browser-opens.mjs /tmp/transcript-web-opens
```

Set `PLAYWRIGHT_CORE_PATH` and `CHROMIUM_PATH` when using another machine.

For Android, use the leased disposable emulator and the existing
`../latency-rig/build-local.sh` with the emulator proxy URL
`http://10.0.2.2:19881`, `BEELINE_ANDROID_NATIVE_LATENCY_PROBE=1`, and
`EXPO_PUBLIC_TRANSCRIPT_CONTROL=http://10.0.2.2:19886`. Install its release APK,
sign in through the local review link, set `LATENCY_RIG_DEVICE` to the leased
serial, and reverse image traffic with `adb -s <serial> reverse tcp:19882 tcp:19882`.

```sh
node scripts/transcript-speed/capture-android.mjs /tmp/transcript-android
node scripts/transcript-speed/capture-opens.mjs /tmp/transcript-android-opens
TRANSCRIPT_CAPTURE_JS=1 node scripts/transcript-speed/capture-keypaint.mjs /tmp/transcript-keypaint
```

The opens driver clears **the fixture app's data** for cache-miss trials and
pregrants notification permission on that emulator. It waits for the real Room
list after signing in. The capture channel binds loopback; the app polls only
outside sampling windows. Keypaint arms the native probe for the final character
of a unique composer string, then observes the hardware frame commit.

For packaged Tauri, build a Debian bundle with a temporary Tauri config pointing
`frontendDist` at the instrumented export, an isolated app identifier, and no
`beforeBuildCommand`. Extract it to `/tmp/transcript-desktop-package`, run
`tauri-driver` with WebKitWebDriver on port `19885` and display `:91`, create a
session for the extracted binary, and set `TRANSCRIPT_WEBDRIVER_SESSION`.

```sh
node scripts/transcript-speed/capture-desktop.mjs /tmp/transcript-desktop
node scripts/transcript-speed/capture-browser-opens.mjs /tmp/transcript-desktop-opens
```

Use isolated XDG directories. The desktop driver targets the **packaged binary**,
uses real keyboard/pointer input, and sums process PSS after Room switches.

## Comparability and interpretation

Run platforms serially with builds and other capture drivers stopped. Reset
scenario traffic between platforms. Keep raw capture files and artifact hashes.
Android UI statistics are HWUI estimates; JS statistics are rAF intervals, not
compositor dropped frames. The retained framestats ring is bounded, so full-run
UI percentiles use HWUI's aggregate histogram. Browser rAF intervals combine
main-thread scheduling/rendering effects and do not separately prove scanout.

Browser open timing is an external upper bound: observed content followed by two
rAF callbacks; settling requires unchanged text/image state across five polls.
Android opens use the existing newest-frame marker and a quiet HWUI draw-count
window. Keypaint measures native key dispatch to frame commit, excluding adb
transport and physical panel scanout. Chrome Event Timing is quantized, and
unreported fast key events are censored below its minimum threshold.

Do not turn missing evidence into zero. Blank-area measurement, unsupported
browser metrics, and overhead outside the paired typing experiment must remain
explicit limitations. The local native fingerprint check also fails on a clean main checkout; keep
the diagnostic logs with the run. This harness does not bump runtime versions
or change the release pipeline.

Browser cold opens restart the browser/application process with retained local
storage; they do not flush OS disk caches. Web history uses the visible scrubber
because wheel events alone do not establish native drag intent in the narrow
layout. Desktop fling is a decaying native wheel burst. Android streams are
visually checked with an accessibility snapshot outside the frame sample.
Browser key-to-render bounds end at the second animation callback, not scanout.
Paired browser overhead measures active sampling versus inactive sampling with
the measurement hooks installed in both arms; total hook/build overhead remains
unquantified. Short memory growth is evidence for investigation, not proof of a
leak.

## Retained baseline

[Platform tables and measured ranking](results/2026-10-24/BASELINE.md) and [run notes, limitations and native blockers](results/2026-10-24/RUN-NOTES.md). The report command accepts `-` for an explicitly missing platform; this produces an incomplete row, never inferred measurements.

Android stream visibility uses `tesseract` on retained emulator screenshots outside the timing window; accessibility dumps cannot reliably obtain idle state during streaming. The OCR check requires both stream labels (allowing O for zero), and the images remain available for inspection.

### Isolated redraw comparisons

Only one app may poll a capture channel. An older instrumented emulator can
otherwise consume commands intended for the measured device. `TRANSCRIPT_CONTROL_PORT`
selects a private loopback listener for the driver. For an already-built fixture
APK using port 19886, the leased userdebug emulator can route that endpoint to
its own ADB reverse (run these only against the explicitly owned emulator):

```sh
adb -s <owned-serial> root
# Root can reconnect this emulator under its loopback TCP serial. Select that
# exact owned serial; capture-android also verifies ro.kernel.qemu=1.
adb -s <owned-serial> reverse tcp:19886 tcp:19896
adb -s <owned-serial> shell iptables -t nat -A OUTPUT -p tcp -d 10.0.2.2 \
  --dport 19886 -j DNAT --to-destination 127.0.0.1:19886
TRANSCRIPT_CONTROL_PORT=19896 TRANSCRIPT_SKIP_HISTORY=1 \
  node scripts/transcript-speed/capture-android.mjs <output>
```

Reset fixture traffic, clear only the leased fixture app's data and sign in
again before **each** build's capture. This prevents deleted scenario traffic
in a retained phone cache from changing the next build's starting workload.
`TRANSCRIPT_SKIP_HISTORY=1` omits the separate long history-prepend experiment;
it retains typing, scroll/fling, incoming, Room switches, concurrent streams and
send trials. Both arms must use the same option, recorded in capture metadata.
The Android driver rejects incoming/stream/send samples with no row commits:
visibility after sampling alone cannot establish that the action was measured.

For separate row-cost diagnosis, set `TRANSCRIPT_PROFILE_ROWS=1` when running
`capture-android.mjs`. It saves Hermes sampling profiles around history prepend,
fast scroll, concurrent streams and optimistic send. The capture records this
flag; profiled runs must never be used as acceptance timing. Leave the flag off
for every before/after timing arm. Symbolicate against the exact build with
`TRANSCRIPT_APK=<matching-apk> node scripts/transcript-speed/symbolicate-row-profiles.mjs <capture-directory>`.
The symbolicator verifies APK and local bytecode hashes before using the composed
source map. `TRANSCRIPT_MAP_DIRECTORY` can select a retained generated-build
directory containing `assets/` and `sourcemaps/`. Rankings count sampled stacks,
not invocations or additive CPU time.

Hover-only captures use the same seeded Room and real pointer input. Export
the web build with `--source-maps external`, then set
`TRANSCRIPT_WEB_DIRECTORY` to that export and `TRANSCRIPT_WEB_ORIGIN` to its
loopback server before running `capture-hover.mjs <output>`. It captures three
unprofiled trials at narrow and desktop widths, followed by separate Chrome
timeline and symbolicated CPU profiles. For the packaged app, start the
isolated Tauri WebDriver and set `TRANSCRIPT_DESKTOP_BINARY` to the extracted
binary, `TRANSCRIPT_DESKTOP_PACKAGE` to its Debian package and optionally
`TRANSCRIPT_WEBDRIVER_PORT` (default 20085), then run
`capture-hover-desktop.mjs <output>`. It creates and closes its own session,
checks that hovered actions become visible and retains a screenshot. WebKit
does not provide a Chrome trace; the packaged timing and shared-code Chromium
diagnosis remain distinct evidence. Stop or suspend builds during captures.

For alternating-order regression checks, `TRANSCRIPT_REPEAT_COUNT=1`
(default: 3; accepted range: 1–3) and `TRANSCRIPT_REGRESSION_ONLY=1`
retain the exact idle, typing, scroll/fling, Room-return and incoming sequence,
then omit the later Room-switch, streaming and send scenarios. Clear the owned
fixture app and reset traffic before each arm. Record the arm order and keep
all captures; compare the median and min/max of per-trial p95 values. These
short arms supplement, rather than replace, the full before/after suite.

After the timing run, `capture-row-updates.mjs <output>` exercises visible
edits, server reactions and a real reaction toggle, verifies zero transcript
commits while typing, checks the keyboard dock, and checks that an incoming
message preserves an older visible reading anchor. It uses the same fixture,
device, APK and control-port environment variables and retains screenshots.

For diagnosis only, build with `BEELINE_TRANSCRIPT_PROP_TRACE=1` alongside the
measurement flag. Row commits then record which props changed, and surface
commits record changes to the renderer dependencies and transcript partitions.
The embedded `propTrace` flag identifies these builds. Rebuild with prop tracing
off for before/after timing; diagnostic captures are not acceptance timings.

## Persistent host execution on squire

Use `systemd-run --user --wait --pipe --quiet bash -c '<host command>'` from
this agent environment to reach the host. A direct `systemd-run` from the
sandbox can fail with `Failed to connect to bus: No data available`.
Start long builds and captures as detached user units inside that host command.
Select Node explicitly: this capture uses `/home/lunchbox/.nvm/versions/node/v20.11.0/bin`
first on the build PATH. The host default Node 18 fails Metro with
`configs.toReversed is not a function`; Node 22.12.0's module detection fails
this checkout's Expo config with `ReferenceError: require is not defined`.
Use a private Gradle home, bounded heaps/workers, and persistent log/output paths.

Keep the fixture server, delayed-image server, and capture on the same host.
Forward the corner's emulator lease variables when launching `beeline emulator`
through the host route; select its returned serial and ADB server port for every
capture command. Do not select another corner's emulator. Wait for build success
before installing the APK and capturing; never measure while compiling.

### Room-switch transition proof

`capture-room-transitions.mjs <output>` uses real Room-list taps and the existing
native fixture paint probe on the supplied APK. Set the same owned device,
fixture database, control port and `TRANSCRIPT_APK` as the matching suite. The
app must already be signed into the local review fixture. The driver selects
that fixture Workspace, warms both Rooms and captures six alternating taps.
It adds the same deterministic marker traffic in both arms so native frame
commit proves the target transcript is visible. Reset traffic between arms.

The transition ends only after the native transcript paint followed by 500 ms
without a JS frame interval above 50 ms. `transition-metrics.mjs` retains timing
bounds for the old sampler's missing first-rAF timestamp. JS busy CPU time uses
the executor thread's scheduler runtime counter inside that window, with raw
counter samples and boundary bounds retained. Scheduler wait is not busy CPU.
Do not substitute the whole-window frame p95 for transition settling time.

`TRANSCRIPT_PROFILE_SWITCH=1` profiles one separate after switch only after all
acceptance trials. `symbolicate-room-profile.mjs <output>` verifies the locally
built bytecode against the supplied after APK, then uses its composed map to
attribute sampled stacks in the 30–160 ms frame windows. Keep profiling disabled
for acceptance. The approved metric definition and latest measurements are in
[the Room-switch proof](results/2026-10-24-redraw/room-switch/README.md).

Every scenario in the generated summary includes its worst JS interval and total missed JS frame opportunities alongside p50/p95. A small number of long gaps can dominate wall time while staying above the p95 cutoff; use all these measures when assessing Room switching.
