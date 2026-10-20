# R1: warm Room open with newly arrived rows (brief revision 2)

Measured locally on squire on 2026-10-19 and 2026-10-20. Revision 2 replaces the proposed
GitHub runner and server alert endpoint with an agent-owned local schedule.
There is no new GitHub nightly workflow, webhook or token.

## Environment and reproduction

Main source: e2665c7dfc62ed9ac1de9ef4b18838dd76f9c6de, with the native rig probe
applied before application changes. Android 35 x86_64, disposable Beeline-leased
se_api35 emulator, 2560 MiB RAM and four cores. Local PostgreSQL fixture:
200 Rooms, 300 corners, 10k older activities and a 30-row window. Proxy:
100 ms RTT, zero configured jitter, 10 Mbps, local HTTP. No production data.

R1: warm the fixture Room, return using native Back to its Room list, insert
one or five unique messages, then tap the Room or invoke its Android push-tap
Activity with FCM tap extras. Push timing excludes delivery and notification
shade latency. The timer starts at native touch-up or Activity entry and ends
at frame commitment with the newest message visible above the composer in the
same native navigation Screen. It never ends at the first cached paint.

The rig-only Expo plugin rejects non-emulator host URLs and is absent from
ordinary builds. A shell-permission receiver arms one expected unique message.
Its draw listener checks a full TextView line above the composer and records a
hardware frame-commit callback. This measures frame submission rather than
physical display scanout. UI inspection occurs before the timed action;
accessibility polling and JavaScript callbacks do not stop the timer.

## Complete main baseline

| Entry / unseen | Samples | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
| Room list / 1 | 20 | 1012 | 1349 |
| Room list / 5 | 20 | 1480 | 1973 |
| Push / 1 | 20 | 678 | 718 |
| Push / 5 | 20 | 746 | 809 |

All four cases fail the strict 450 ms page-load budget. Machine-readable results
are in `6150011d-rev2-baseline.json`. Earlier JavaScript-only, clipped-text,
preview-matching and interrupted harness pilots are excluded.

## First cache-fix attempt

| Entry / unseen | Samples | p50 ms | p95 ms | Verdict |
| --- | ---: | ---: | ---: | --- |
| Room list / 1 | 20 | 291 | 411 | pass |
| Room list / 5 | 20 | 323 | 504 | fail |
| Push / 1 | 20 | 686 | 1791 | fail |
| Push / 5 | 20 | 813 | 1471 | fail |

All outliers remain in these results. Host load is recorded every ten seconds.
The full nightly attempt stopped at warm-open: its probe reused a prior push
mark for the same target. The parser now requires matching entry case and an
arming timestamp, with a regression test. No invalid mark was accepted as a
warm-open sample. Send-text was not reached. There is no complete nightly pass.

Additional push tracing found received target rows in cache within 13 ms, but
the Room route mounted about 300 ms later. Temporarily disabling Android system
animations did not eliminate that hold. Those diagnostic runs are excluded;
original animation settings have been restored. The forwarding activity's NoDisplay pilot also failed and was removed.
The current candidate preserves the initial cached transcript, publishes missing-row
responses before session setup consumes them, and tests a warm-push-only native
handoff flag.

## First complete candidate matrix (262b39de1)

The request verdicts in these historical tables are raw analyzer output, **not
accepted proof**: device and host epochs were not calibrated before joining.
Native paint durations remain valid because their start and end share the same
device monotonic timer. A calibrated capture is required for request contracts.

The actual local-attempt wrapper built, installed and signed in to a fresh
fixture, then captured all 120 samples. Android system animation settings were
unchanged. Every case has 20 samples; none were discarded.

| Entry / unseen | p50 ms | p95 ms | Timing | Request contract |
| --- | ---: | ---: | --- | --- |
| Room list / 1 | 264 | 285 | pass | pass |
| Room list / 5 | 276 | 302 | pass | pass |
| Push / 1 | 596 | 987 | fail | fail |
| Push / 5 | 852 | 1246 | fail | fail |
| Warm Room open | 280 | 317 | pass | fail |
| Send text | 153 | 279 | fail | fail |

The analyzer exits 1: this is a complete failing run, not a nightly pass.
The revised send harness completed all 20 sends. Push traces show delays before
the HTTP request reaches the proxy and after its response. Further diagnostic
marks distinguish authorization, native request dispatch, body decoding and
navigation ancestry. No causal conclusion is claimed from those gaps alone.

## Warm dispatch and native push candidate (daf09db85)

| Entry / unseen | Samples | p50 ms | p95 ms | Timing | Request contract |
| --- | ---: | ---: | ---: | --- | --- |
| Room list / 1 | 20 | 261 | 282 | pass | pass |
| Room list / 5 | 20 | 275 | 300 | pass | pass |
| Push / 1 | 20 | 381 | 1028 | fail | fail |
| Push / 5 | 20 | 829 | 1251 | fail | fail |
| Warm Room open | 20 | 286 | 303 | pass | fail |
| Send text | 20 | 157 | 179 | fail | fail |

All 120 samples completed; the analyzer exits 1. A warm valid token now reaches
the JS fetch call without yielding to navigation. Exact mounted ancestry uses
a normal stack push. A device-only trace shows a body-decoding gap from +427 ms
to +960 ms. A Room-only Expo native fetch candidate is under test; this run does
not contain that change.

An earlier claim about the proxy arrival delay compared uncalibrated clocks.
Android was about 384 ms behind the host when checked. That cross-clock claim
is withdrawn. The device-only phase gaps and native paint durations are not
affected. The next harness records bounded host/device clock anchors before
and after every sample and fails closed when they cannot be joined safely.

## Nightly installation and delivery

The standalone comparison and local attempt scripts are committed with tests.
The fixed nightly subset is the four arrival cases, warm Room open and send-text,
20 samples each. Missing, failed or skipped cases fail closed. The agent reruns
the full subset once before alerting and preserves the last passing baseline.

The README contains the installation procedure and the nightly wake prompt.
A durable schedule must belong to the parent Room because schedules in archived
corners stop. A parent-Room order for Speedy has been requested from Ruby;
installation has no receipt yet. No operational nightly guarantee is claimed.

The personal GitHub connection returned HTTP 403 when patching PR #2636's body.
The draft PR's older description is stale until corrected through an authorized
connection. This does not prevent local emulator work or comparison tests.
