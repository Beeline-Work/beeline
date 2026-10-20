# R1: Room opening with newly arrived messages

Measured on squire on 2026-10-20. Main application: `6d908054c0dd404885ec2daa08115c9ef5ed10c2`.
Tested application: `9729c3ac2480ba6a8634be7ecde2e97d176b4bad`. Later evidence commits do not change application code.

## Reproduced and demonstrated

R1: warm the fixture Room, return with native Back to its Room list, insert one
or five unique messages, then tap the Room row or invoke the Android FCM-extras
notification Activity. Stop at native frame commitment with the expected newest
message's full text line visible above the composer in the same navigation Screen.
A list preview cannot stop the timer. All cases retain 20 samples per revision.

| Case | n per revision | Main p50 / p95 ms | Fix p50 / p95 ms | Fix prepaint HTTP |
|---|---:|---:|---:|---:|
| Room list / 1 | 20 | 1120 / 5000 (capped; 5 timeouts) | 257 / 281 | 0 |
| Room list / 5 | 20 | 1123 / 1423 | 268 / 313 | 0 |
| Push / 1 | 20 | 716 / 856 | 255 / 288 | 0 |
| Push / 5 | 20 | 810 / 850 | 263 / 275 | 0 |

All final arrival cases pass timing and request contracts. No final sample timed
out. Main list / 1 has five failed targets at the five-second cap; 5000 is a
censoring value, not an observed paint time. No samples or outliers were dropped.
Both main push cases displayed their newest target in all 40 samples.

## Environment and measurement

Android 35 x86_64, owned Beeline-leased se_api35 emulator, 2560 MiB RAM, four
cores. Local disposable PostgreSQL fixture: 200 Rooms, 300 corners, 10k older
activities and a 30-row window. HTTP proxy: 100 ms RTT, zero jitter, 10 Mbps.
Main has only the measurement harness and native probe applied; its mobile
application sources are unchanged. Capture occurs after builds and warmup.

The same corrected WebSocket shaping is used on both revisions: propagation
latency overlaps between messages; only byte serialization queues. Earlier
captures serially charged half an RTT per message and are not comparable.
The real-proxy burst regression passes on the correction and fails on the old
implementation with its 1.5-second deadline.

Device/host calibration is verified, with final maximum uncertainty
10.5 ms. Native durations use one device clock. Host one-minute
load ranges: main 1.14–9.42; fix
0.93–10.15, on 20 logical CPUs.

This is a warm-session synthetic FCM-extras tap from the Room list, through the
real Activity/Expo response path. It excludes FCM delivery and notification-shade
latency. Native frame submission is measured, rather than physical scanout.
First-open observations are informational and do not gate this matrix. This is
an emulator result, not a physical-phone calibration.

## Cause and fix

The old 763 ms list sample applied its cached target at +271 ms, reached list
layout at +624 ms, and committed the target frame at +763 ms. Its Room network
read began at +802 ms. The delay was in app session/cache setup and layout,
rather than a Room-read wait. That older capture has no host-load record, so it
cannot establish a host-load cause. Later Hermes profiling shows React/native
view reconciliation dominating the sampled slow intervals rather than GC.

Received committed rows now update the scoped off-screen Room cache and enter
the Room's first React state. Missing rows start their read at the tap. Opening
responses publish before asynchronous session setup; account/server generation
checks still guard them. Live Room-list updates yield to navigation. Warm FCM
responses use the existing listener without restarting MainActivity. Existing
Room landing positions are preserved.

The optional star-prompt read and the sampled page-load observation now run
behind native paint. Earlier successful timing candidates still had occasional
ancillary requests before pixel commitment; the final matrix has none.

## Validation and nightly handoff

Root typecheck, dead-code baseline and workflow-path checks pass. There are 36
latency-rig tests, including real-proxy burst delivery, coverage, censoring,
clock calibration, strict budget/regression thresholds, skipped captures and
complete first-parent PR ranges. Focused Room/push/list tests pass; the final
trace/prompt group has 18 passing tests, including browser functionality and
no-request-before-frame assertions.

No latency-rig GitHub Actions workflow, dedicated runner, hosted watchdog,
OIDC alert endpoint or new token remains. Nightly execution uses the local rig
and `nightly-local.mjs`, with a single full rerun before an alert and baseline
advancement only on pass. The fixed nightly subset is the four arrivals plus
warm Room opening and send-text, 20 samples each.

The prior complete six-case capture (81c44746ab9b3574224c0467c99fd5d89805b079) reported send-text p95
232 ms against 150 ms and failed its request contract. That existing interaction
failure remains visible to monitoring; no passing global nightly baseline is
claimed by this arrival-only acceptance run.

Ruby's recorded handoff is to order Speedy in the parent Room after merge and
install the 03:00 America/New_York schedule from reviewed main. No installed
schedule is claimed before that handoff. A deliberately skipped capture/rerun
already produced exactly one labeled dry-run alert in the parent Room, verified
by reading message `315af9b7fc6895ea11a3325079cf8eaaa55eb406ccd2c07e6059d586d5c04326`.
