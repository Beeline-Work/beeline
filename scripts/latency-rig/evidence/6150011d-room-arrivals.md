# R1: warm Room open with newly arrived rows

Measured locally on 2026-10-19. This evidence does not establish acceptance on
the dedicated `beeline-android-rig` runner.

## Environment

Main source: e2665c7dfc62ed9ac1de9ef4b18838dd76f9c6de. Fix source: e31187ac4
plus the local-only native frame probe. Android 35 x86_64 leased disposable
emulator on squire; no physical-device CPU calibration. Disposable PostgreSQL
fixture: 200 Rooms, 300 corners, 10k older activities, 30-row window. Host proxy:
100 ms RTT, zero configured jitter, 10 Mbps, local HTTP. Never production data.

R1: open the fixture Room, return to its Room list, insert one or five unique
messages, then tap its row or invoke the Android push-tap Activity with FCM tap
extras. The push case excludes FCM delivery and notification-shade latency.
Warm navigation and installation work settle before capture. Each gate requires
20 samples per case and p95 strictly below 450 ms.

## Initial diagnostic baseline before application changes

These are **JavaScript callback times**, not verified native paint results:

| Entry / unseen | Samples | p50 ms | p95 ms |
| --- | ---: | ---: | ---: |
| Room list / 1 | 20 | 979 | 1191 |
| Room list / 5 | 20 | 1239 | 1346 |
| Push / 1 | 20 | 1262 | 1851 |
| Push / 5 | 20 | 1306 | 1742 |

The original marker matched the newest message id, but subsequent native
inspection found that its text could remain clipped above the composer. A JS
callback after response application cannot establish visible paint. An
accessibility observer also perturbed the timings; its pilot percentiles are
not acceptance evidence. Neither experiment is used to claim a passing fix.

## Native measurement

The rig-only Expo plugin is absent in ordinary builds and rejects non-emulator
host URLs. A shell-permission receiver arms one expected unique message. Timing
starts at native touch-up or push Activity entry. An existing draw must contain
a full TextView line above the composer, then the hardware frame-commit callback
records completion. This observes rendered frame submission, not physical
scanout. No polling of the UI or JavaScript callback ends the measurement.

Native results pending; see the current PR for the latest verification state.

## Independent blockers

The owner's personal GitHub connection returned HTTP 403 for workflow dispatch
and runner inventory. Repository/workflow/run reads succeeded. Historical
Oct 13 workflow records have skipped device jobs; workflow success alone is
not evidence that the device ran. The runner's capture executable and online
state remain unverified. The scheduled workflow fails closed on missing capture
and the hosted watchdog reports a skipped night, but real Room delivery needs
the normal server release containing the restricted OIDC alert endpoint.
