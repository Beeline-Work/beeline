# November 1 nightly failures: scratch scope, socket accounting and fixture readiness

The latest scheduled run, `night-2026-11-01-Flk7ip`, produced no latency
measurements. The scheduled agent manually terminated both attempts because
it applied the corner's 5 GiB scratch allowance to the entire private rig state.
This was a setup failure, not evidence of an application latency regression.

## Original evidence

- Standing corner: `acca09be-d0fb-443d-a32f-31d1a9737023`, beneath Room
  `bb91a1c7-7cad-4fde-aafc-94fccb651ac8`.
- Jellybean's installed schedule: `390f36c4-454d-475a-a789-0d3561bcdc92`, cron
  `0 3 * * *`, `America/New_York`. The October 30 wake-list receipt and saved
  schedule prompt agree on the corner, owner and cadence. Speedy's prior
  schedule was deleted. The repository runbook still described that older
  Room-owned schedule and silent passes; it now matches the installed contract.
- Final corner message: `c1b55a361f490aef9b4da3eaa31510eaa4795e63bf6fba93b0b61690122072f2`,
  posted at `2026-11-01T08:04:55Z` (03:04:55 Eastern).
- Measured checkout: `019254b5bc87f443f86bf6a065b43c25b09346d9`.
- The delivered prompt at `08:00:15.320Z` said
  **`Scratch 13826 / 5120 MiB`**, charging the whole agent home. The agent then
  applied that allowance to its smaller private rig directory instead of the
  assigned worktree. This directly connects the bad helper accounting to its
  later setup decision.
- The original run's `attempt-{1,2}/setup-error.txt` both say the private state
  used **4,937 MiB of 5,120 MiB** before the Android build. Its supervisor log
  records `Terminated`, followed by a missing-capture comparison and one retry.
- The original Codex session records `os.kill(990, signal.SIGTERM)` at
  `08:03:21.773Z` and `os.kill(1461, signal.SIGTERM)` at `08:03:46.236Z`, each
  immediately after writing that setup error. This was an agent decision,
  not a rig timeout or a captured performance failure.
- `nightly.json` and `history.jsonl` retain both attempts, ending at attempt 2,
  `final:true`, `pass:false`, `shouldAlert:true`, recorded at `08:03:51.603Z`.
  All ten cases have no report; no passing baseline or regression range exists.
  The [Insights receipt](https://github.com/Beeline-Work/beeline-insights/commit/b4432203e4caafc7d3a5c831c2b2289f161b607f)
  published this missing-capture result without inventing chart points.

[failed-setup.json](failed-setup.json) preserves the relevant original verdict,
both exact setup errors, host observations, schedule receipt and loaded helper
identity. Original logs remain in the scheduled corner's private
`state/beeline/latency-rig-speedy/night-2026-11-01-Flk7ip` directory.

## Why overload and helper restarts do not explain this run

The two setup observations show load averages **8.38 / 3.49 / 2.17** and
**6.26 / 3.59 / 2.26**, on 20 available CPUs, with about 95 GiB free RAM.
These are not the earlier load near 60. They cannot prove the app meets its
latency budgets, but no app measurement was made here at all.

Squire's helper PID `1526088`, observed during the investigation, started at `2026-11-01T03:40:01Z`
(October 31, 23:40:01 EDT), more than four hours before this run. The earlier
helper restarts did not terminate either attempt: the session's two explicit
SIGTERM calls explain both stops. Journal evidence also records the owned
`emulator-5554` exiting cleanly during final cleanup.

## Existing fix and operational requirement

[The scratch-accounting fix](https://github.com/Beeline-Work/beeline/pull/3209)
is already merged at `74f154af5c922f9bcc5059e8fb1d60a1cda689fa`. In
`MonolithCornerTurnLoop`, both the prompt and the growth check now measure
`worktreePath`, rather than `agentHomeRoot` for read-only repositories. The
incorrect scope was introduced by `73678f627f` on October 31; it is not a
change in the rig's four tap actions or accessibility retry logic. The existing
R1 tests preserve the real budget for scratch-only corners.

At `2026-11-01T13:13:29.672Z`, squire's helper still reported **v0.1.130**,
loaded release `790602ab2156674e0121c5e8cec86b97cf685e20`, which does not contain
that fix. Updating the measured checkout alone cannot change the running
helper's accounting. A later read-only check at `2026-11-01T16:32:58.679Z` showed **v0.1.133**,
loaded commit `2e6951beb1c06174a9adf4c6af6dbfd27d3f94c6`. Git ancestry
confirms that release includes the scratch fix. The shared helper changed
externally during this proof; this investigation did not restart, update or
otherwise change it.

The runbook now states the correct scratch scope and forbids inventing a
separate 5 GiB limit from the private state's `du` total. No budget, sampling,
clock-calibration or baseline rule was relaxed.

## Second defect exposed by the complete local capture

The prepared pre-fix run completed **200 samples**, 20 in each of ten cases,
with `complete:true`, `clockCalibrated:true` and maximum clock uncertainty
**9 ms**. All five page cases and composer-open passed. Reaction measured
p50 **94 ms**, p95 **119 ms**, with `timingPass:true`, yet the rig reported
`maxWrites:0`, `requestPass:false` and misleadingly called it over budget.
Send-text likewise reported no writes. Socket messages were present; SQL
counts were zero.

This was a rig accounting bug after phone operations moved to the existing
live socket. `summarizeSample` counted only HTTP writes/reads, the proxy logged
only raw WebSocket byte spans, and the SQL preload lost the upgrade's async
scope when a socket message arrived. Consequently optimistic socket writes
failed their one-write contract, while socket reads could evade request limits.
These failures were independent of host load and the earlier scratch abort.

The fix, committed as `765275d54edeb79d46c6040a375d4069667ef461`:

- Records socket request start/reply spans without logging arguments, results,
  auth or raw IDs; matches replies by a connection-scoped hashed request ID.
- Classifies reads with the canonical phone contract and applies the existing
  request, optional-read, round-trip and follow-up-read rules across both
  transports. Raw HTTP/WS byte counts remain separate and are not doubled.
- Preserves unfinished requests and restores SQL scope per message through
  the server's manual `handleUpgrade` path.
- Reports request-contract failures separately from actual timing failures.

The original timing failures remain timing failures: pre-fix corner-open was
**646/751 ms** p50/p95, send-text **180/200 ms**, and tab-switch **172/194 ms**.
No passing baseline exists, so these are observed budget violations, not an
attributed regression range. The old run's owned retry was stopped after the
accounting defect was established; its complete first report is preserved.
A new run identity measures the committed fix from the start.

## Local proof

The proof runs entirely in the disposable task worktree on squire, against a
new local PostgreSQL fixture and an owned Android 35 x86_64 emulator. Its fresh
private AVD uses the nightly `se_api35` device configuration, 2,560 MiB RAM,
four guest cores, SwiftShader and no snapshots. It uses ports 20880/20881 and
the unchanged 100 ms RTT / zero jitter / 10 Mbps profile. No captain Workspace
or production write is involved. Its state and baseline are isolated from the
scheduled lane.

Two initial proof attempts failed during dependency preparation: the inherited
mobile tree lacked `@sentry/react-native/metro`, then refreshing it with
`--ignore-scripts` omitted Skia's native binaries. Completing the dependency
install scripts restored those inputs. These local preparation errors are
distinct from the scheduled scratch abort and produced no latency samples.
Both were retained as a final missing-capture result in the proof's private
history. The prepared run, `night-2026-11-01-bg8PWk`, then used the exact
`bash scripts/latency-rig/nightly-run.sh` entry point and built its release APK
successfully in 5 minutes 56 seconds.

Validation already completed:

- `vitest run src/monolith-corner-turn.test.ts` in `apps/body`: **87 passed**,
  including both R1 scratch-accounting cases.
- `node --test scripts/latency-rig/*.test.mjs`: **73 passed**. Four socket regressions
  fail on the old code and pass with the fix, covering socket write/read
  budgets, accurate diagnostics, and a real proxy/manual-upgrade/SQL/join flow
  with out-of-order replies, a response over 64 KiB, privacy checks and an
  unfinished request.
- `node scripts/latency-rig/prove-nightly-drift.mjs`: **passed**; the synthetic
  drift proof stayed local and was not published as measured data.

Root typecheck passed all workspaces, then failed on four pre-existing,
untracked mobile proof snapshots under
`apps/mobile/evidence/composer-hint-center/local/selectall`. No tracked source
exists there. Mobile typecheck passes with only those snapshots omitted from
the configured inputs; the root scripts typecheck passes. Those unrelated
files and the project compiler configuration were not changed.

The first transport-fixed run was `night-2026-11-01-pHs09R`, measured at the
code commit above.

Its first fixed attempt completed 200 calibrated samples with maximum clock
uncertainty **6 ms**, zero censored timeouts, zero unfinished required requests
and zero failed required replies. The 180 host observations show mean one-minute
load **5.45**, ranging **1.77–14.68** on 20 CPUs. Its retained
[socket-fixed report](socket-fixed-report.json) records one reaction write and
up to eight SQL statements for that case. Reaction's p50/p95 **78/111 ms**
passes timing, but its **20 follow-up `readStarPrompt` calls** fail the existing
zero-follow-up-read contract. This is now accurately reported as a request
failure, rather than a fictitious timing failure or missing write.

The same attempt observed **20 `readChats` and 20 `readRoom` follow-up calls**
after send-text; one send window also included `markRead`. Corner-open's
prepaint windows contained `listRoomWorkflowRuns` (21 calls), `readRoom` (20),
`readHistory` (12), `readWorkspace` (17), `readStarPrompt` (18) and
`reportPageLoad` (2). Its maximum was six prepaint requests at depth four,
including three optional calls. These operations were invisible to the old
HTTP-only budget gate. Genuine timing/request violations stay failures.

## Third defect: reaction fixture visibility

The transport-fixed run's retry stopped before reaction sample 17/20 with
`Reaction setup requires one existing reaction`. It retained 136 completed
samples, but produced no complete retry report and did not advance a baseline.
The saved `/sdcard/latency-rig.xml` showed the preceding sample's message
`0e939cb60a1e39c2…` and its **two-reaction** chip; the newly inserted target
was absent. The fixture message and seeded reaction are already one atomic
INSERT, so this was not a split message/reaction transaction.

The capture assumed the next fixture was visible after a single 1.5-second
sleep and one successful hierarchy dump. A successful dump proves that XML is
readable, not that the newly inserted message is in it. Commit
`017489a1644382d395fbd5b049ad94b12761820d` waits for that exact target's
one-reaction chip across at most three fresh hierarchies. A ready chip adds no
delay; a wrong, invisible or already completed chip still fails with the action,
sample and target. This remains outside the native measurement interval.

Three regression tests reproduce the stale preceding chip, immediate readiness,
and bounded failures for wrong/completed/invisible targets. The old single-read
behavior fails the stale-hierarchy test; all 73 rig tests now pass.

The final proof run is `night-2026-11-01-a2Irbb`, measured at this second code
commit. Its first attempt completed **all 200 samples**, including all 20
reactions past the previously failing setup. The [complete report](report.json)
records calibrated clocks (maximum uncertainty **25 ms**, within the existing
limit), zero censored timeouts and zero unfinished required requests. One
send-text window had a failed required reply; the report retains that failure.

| Case | p50 / p95 ms | Request contract |
| --- | ---: | --- |
| Push, one unseen | 521 / 960 | pass |
| Push, five unseen | 463 / 674 | pass |
| Room list, one unseen | 322 / 444 | pass |
| Room list, five unseen | 570 / 980 | pass |
| Warm Room | 476 / 525 | pass |
| Composer | 101 / 204 | pass |
| Corner | 712 / 1647 | fail |
| Reaction | 135 / 515 | fail |
| Send | 318 / 997 | fail |
| Tabs | 216 / 273 | pass |

Host contention returned during this capture: 196 observations have mean
one-minute load **23.16**, ranging **8.51–45.61** on 20 CPUs.
[Execution metadata](execution.json) retains the profile and load summary. The earlier
lower-load transport-fixed report is retained separately rather than mixing
samples. These runs prove that capture and transport accounting execute; they
do **not** establish a passing performance result or attribute a regression.
Request-contract violations observed in the lower-load run remain actionable.

The unchanged nightly wrapper performed its one automatic retry. The APK built
successfully in 3 minutes 32 seconds, and the informational first-open marker
was written. At `2026-11-01T16:20:55Z`, the owned QEMU process `3454521`
aborted (exit **134 / SIGABRT**); adb subsequently reported
`device 'emulator-5582' not found`. No crash cause is established by the available
log. Capture was waiting in `adb -s emulator-5582 logcat -c`; after confirming
the emulator had exited, the worker terminated only that orphaned adb child so
the existing cleanup and comparison could finish. No timed samples were made
in this retry. There was no third attempt.

The retained [final nightly verdict](nightly.json) is attempt 2, `final:true`,
`pass:false`, `shouldAlert:true`, with the first attempt's budget failures and
the retry's missing-capture failure. No passing baseline was advanced. The owned
local servers and private adb server were cleaned up; other devices, shared
adb and production state were left alone. This proof was not published to
Insights or posted into the scheduled Room.
