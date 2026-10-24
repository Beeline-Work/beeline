# Transcript speed measurement (work in progress)

This is an unfinished measurement harness, not a baseline or a performance fix.
It uses the real production Room route with a disposable local server. Never
point the seed script at a production or staging database containing user data.

Run `npm run corner:prepare`, then follow `../latency-rig/README.md` to start the
local server with a freshly created `beeline_latency_rig_transcript_*` database.
For web, include `http://127.0.0.1:19882` in `BEELINE_WEB_APP_ORIGINS`.

```sh
node scripts/transcript-speed/seed.mjs
node --test scripts/transcript-speed/measurement.test.mjs
```

The seed requires `LATENCY_RIG_DATABASE_URL`. It creates two deterministic
Rooms with 1,000 messages each: plain text, markdown, code, delayed images,
reactions, replies, and agent answers. Corner cards and active turns are still
to be added. `TRANSCRIPT_IMAGE_ORIGIN` defaults to the local web server below;
native runs need their emulator-reachable image origin.

Export from `apps/mobile` with `BEELINE_TRANSCRIPT_MEASURE=1`,
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:19881`, and
`npx expo export --platform web --output-dir transcript-instrumented --max-workers 2 --clear`.
The clear flag is required when changing instrumentation: Metro may reuse
transforms across environment changes. Ordinary builds do not load the Babel
measurement plugin or its runtime. The plugin counts layout-effect commits in
the actual Room surface and memoized message cells; it does not count abandoned
renders. These counters are an equivalent commit probe, not React Profiler CPU
duration measurements.

```sh
node scripts/transcript-speed/serve.mjs apps/mobile/transcript-instrumented
node scripts/transcript-speed/capture-web.mjs /tmp/transcript-capture
```

The current web driver uses the local-only review fixture secret
`transcript-fixture-local-only-36bbb7b4`; configure the disposable server with
that same value. It drives typing and wheel scrolling three times. Override
`PLAYWRIGHT_CORE_PATH` and `CHROMIUM_PATH` for another machine. No capture is
valid while other builds or heavy jobs run. The driver records the current checkout
SHA, dirty tracked diff, browser, CPU, viewport, raw samples and measured rAF
cadence. The loaded build SHA is unknown and recorded as null. A future build
manifest must identify the export and hash the fixture and untracked
instrumentation before these captures can be compared across changes.

## Measurement limits and remaining work

- rAF intervals measure JS scheduling, **not** native UI frame duration or
  compositor dropped frames. Missed JS opportunities are explicitly named as
  estimates. Headless cadence is a virtual display, not a device refresh proof.
- The report explicitly marks missing UI frames, blank area and key-to-paint
  measurements as null. It is labelled partial and cannot establish acceptance.
- Add cold/warm/cache-miss open, switching/memory, incoming, concurrent corner
  streams, history loading and optimistic settlement scenarios and assertions.
  Current Room draft policy suppresses provisional agent prose in top-level
  Rooms; streaming needs a fixture corner through the supported path.
- Add native Android capture and native iOS timing; package and drive Tauri.
- Measure instrumentation overhead against an ordinary export/build, verify
  the generated React Compiler setting, and retain one report table per platform.
- Generated Android properties in this attempt explicitly contain
  `hermesEnabled=true` and `newArchEnabled=true`; a completed APK/runtime check
  is still required. Do not infer React Compiler from missing config.

## Current attempt (2026-10-24)

Base: `735d7a8a5`. Preparation, both web exports, local seed, actual fixture Room
opening, instrumentation loading, and three measurement-unit tests succeeded.
Root typecheck, all shared-package tests, and the selected landing, unread-divider,
scrubber and scroll-follow regression tests passed (59 mobile assertions).
The local native fingerprint check failed for both platforms. Repeating it with
the original Babel configuration produced identical computed hashes, so the
instrumentation switch does not explain the mismatch. Android computed
`f284f748578f860fd9ad9de838209a1f9bc1a04b`; iOS computed
`dd2a82afc91da03eff2220ee359aa09055eeaf98`. This remains unresolved; runtime pins
and the committed fingerprint record are unchanged.
A diagnostic capture completed (24 samples) while native builds were running;
it is deliberately excluded from baseline evidence.

Android and Tauri builds were started with two workers. Tauri initially failed
under Cargo 1.75 (`edition2024` unsupported); retry with the installed Cargo 1.95
succeeded and produced a Debian package. Packaged-app timing remains outstanding.
Private Gradle state is `/tmp/transcript-gradle-36bbb7b4`. Logs are
`/tmp/transcript-android-36bbb7b4.log` and `/tmp/transcript-tauri-36bbb7b4.log`.
The local server log is `/tmp/transcript-rig-36bbb7b4.log`.

iOS execution access is blocked: BrowserStack REST plan and recent-app queries
succeeded, but the Appium endpoint returned `403 host_not_allowed` through the
vault. The existing BrowserStack browser session is signed in. `connect` repair
handed off to Squire; adding the official Appium host requires the vault's
owner-approved metadata edit. EAS project/build queries succeeded, but do not
provide a running iOS timing target. The owner's online Mac's SSH connection
timed out. No production data was seeded and no timing numbers are claimed for
Android, iOS or packaged desktop.
