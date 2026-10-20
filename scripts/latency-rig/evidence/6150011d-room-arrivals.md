# R1: warm Room open with newly arrived rows (brief revision 2)

Measured locally on squire on 2026-10-19. Revision 2 replaces the proposed
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
handoff flag. Its complete matrix remains under measurement.

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
