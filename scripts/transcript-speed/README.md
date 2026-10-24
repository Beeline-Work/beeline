# Transcript speed harness

Measurement fixtures and drivers for the real Beeline Room UI. No product speed
fixes. Native iOS is pending the owner's BrowserStack host-list approval.

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
