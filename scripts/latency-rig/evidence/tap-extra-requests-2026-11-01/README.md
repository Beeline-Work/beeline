# Tap request contracts: Reaction, Send and Corner

The corrected socket accounting exposed application requests that were previously
invisible. This change keeps the rig's contracts, budgets, twenty samples per
case, ten cases and single automatic retry unchanged.

## Root causes and changes

- **Reaction:** the phone's star-card win key changed on every thumbs-up and
  started `readStarPrompt` after four animation frames. Eligibility now comes
  with the reaction receipt and relevant viewer-specific message deltas. The
  phone performs its one opening eligibility read, then accepts server
  projections. An answer fences older opening replies and answered milestones;
  failure of optional eligibility cannot turn a committed reaction into a
  failed write.
- **Send:** an isolated real PostgreSQL/socket trace showed `message-delta`,
  `postgres:room_read_marks`, `postgres:agent_commands`, then `turn-delta` for
  one send. The two invalidations made the chat list and Room refetch. The
  server now projects the canonical read cursor and current queued commands
  through the same socket. Projections retain reader/membership authority,
  sequence ordering and covering-read fallback on projection failure. A
  subscription capability preserves the legacy invalidations for older phones. The
  phone replays projections over reads already in flight. Optimistic outbox
  rows cannot publish `markRead`; the committed message/receipt acknowledges
  the server's own send cursor.
- **Corner:** workflow status and eager history fill bypassed the socket's
  optional-read draw gate. They now share it. Direct navigation from the
  corners list also lacked the fresh-response requirement used by tap
  prefetch: stale cached content could release optional Workspace, star-card
  and diagnostic requests before the newly inserted target painted. A direct
  opening now holds the gate until its own fresh response reaches the viewport.
  Prefetched warm Rooms keep their existing response owner and avoid a
  read-versus-draw deadlock. Retained focus does not require a nonexistent new
  response.

No polling, expiring cache, UI control, network channel or rig rule was added.

## Failing-first regressions

The initial Reaction/Corner run failed both added count assertions: Reaction
made one unwanted `readStarPrompt`; Corner sent `readRoom`,
`listRoomWorkflowRuns` and `readHistory` where only `readRoom` was allowed.
The Send tests then failed on a covering chat read and Room refresh instead
of accepting the server projections. A separate Send reproduction emitted
`markRead('uncommitted')` after the optimistic row's debounce.

The direct-navigation regression subsequently reproduced the second Corner
cause: the optional-request spy ran after stale-cache paint, before applying
the fresh response. Its fixed test holds the request through that frame and
releases it after the fresh row is visible. Additional regressions cover an
answered star milestone arriving late and optional prompt enrichment failing
after the reaction committed.

Regression sources:

- `apps/mobile/sources/components/buzz/StarPromptCard.test.tsx`
- `apps/mobile/sources/sync/transport/live-connection.test.ts`
- `apps/mobile/sources/buzz/chat-list-store.test.ts`
- `apps/mobile/sources/buzz/read-cursor-advance.test.ts`
- `apps/mobile/sources/app/(app)/beeline/chat/useRoomSurfaceSession.test.ts`
- `apps/server/src/read-cursor.test.ts`
- `apps/server/src/github-star-prompt.test.ts`

## Local proof

The proof uses the unchanged `bash scripts/latency-rig/nightly-run.sh` entry
point from this disposable worktree on squire. The owned private AVD,
`tap_extra_api35` on `emulator-5586`, copies `se_api35`'s Android 35 x86_64
configuration and runs with 2,560 MiB RAM, four cores, SwiftShader and no
snapshots. Its adb server uses port 21882; the fixture server/proxy use
22880/22881 and the unchanged 100 ms RTT / zero jitter / 10 Mbps profile.

All state, Gradle writes and the immutable dependency snapshot are under
`scripts/latency-rig/.local/tap-extra/` in this worktree. The fixture database
is newly created by each attempt and removed by its cleanup. No production or
captain Workspace writes, shared adb operations, helper lifecycle operations,
Insights publication or Room messages are involved.

The first build, at `d7c052fa5687ad279d6789a516f89cbb8b13f63e`, was retired
before APK completion or any samples after the direct-navigation regression
established the remaining Corner defect. Only that wrapper's owned process
tree was stopped. It supplies no measurements. The next run at
`c68f3337d6ade29a6f3cee54bc4779e60ea2724b` built successfully, then was
superseded during its partial capture when final review identified the older-
client compatibility gap. That partial capture is not used as proof. The final
capability-negotiated revision has a new run identity and retains the wrapper's
existing automatic retry.

The full local root typecheck includes four inherited, untracked snapshots
under `apps/mobile/evidence/composer-hint-center/local/selectall`, whose missing
imports are already documented in the earlier nightly evidence. Workspace and
scripts typechecks are checked separately; the mobile source check uses a
private extending config that excludes only those inherited snapshots. The
tracked project compiler configuration and unrelated snapshot files are
unchanged.

## First complete report

The measured application revision is `42661b436f1fb8ab1775125460f9754e7c648a35`.
Run `night-2026-11-01-3Vzf9X`, attempt 1, completed all **200 samples** with
calibrated clocks (maximum uncertainty **19 ms**), zero unfinished required
requests and zero failed required replies. All **ten request contracts pass**.
The [complete report](attempt-1-report.json) retains each existing gate.

| Case | Samples | Request contract | p50 / p95 ms |
| --- | ---: | --- | ---: |
| Push, one unseen | 20 | pass | 267 / 322 |
| Push, five unseen | 20 | pass | 256 / 271 |
| Room list, one unseen | 20 | pass | 245 / 285 |
| Room list, five unseen | 20 | pass | 252 / 292 |
| Warm Room | 20 | pass | 270 / 314 |
| Composer | 20 | pass | 57 / 64 |
| Corner | 20 | pass | 567 / 732 |
| Reaction | 20 | pass | 83 / 111 |
| Send | 20 | pass | 153 / 173 |
| Tabs | 20 | pass | 158 / 185 |

Reaction and Send each record exactly one write and zero follow-up reads.
Corner records at most one prepaint request, at depth one, and zero optional
prepaint calls. The other seven contracts remain passing.

The 178 capture-time host observations have mean one-minute load **5.24**,
ranging **1.27–14.31** on **20 CPUs**. Corner, Send and Tabs still fail timing.
These are timing observations under the recorded load, not claimed timing
improvements. The unchanged wrapper starts its existing one automatic retry;
its final verdict and second report are retained separately below.

Validation: **277 focused mobile tests**, **7 browser proof cases**, **32 server integration tests**, **139 server
projection/fanout/Room tests**, **693 shared-package tests** and **73 rig tests**
pass. Workspace, mobile source (with only the inherited snapshots excluded) and
scripts typechecks pass. Phone-network, shared-UI and workflow-path checks pass.

## Automatic retry and final verdict

The unchanged automatic retry also completed **200 samples**, with all **ten
request contracts passing**, calibrated clocks (maximum uncertainty **9.5 ms**),
zero unfinished required requests and zero failed required replies. Its
[complete report](attempt-2-report.json) remains separate from attempt 1.

| Case | Samples | Request contract | p50 / p95 ms |
| --- | ---: | --- | ---: |
| Push, one unseen | 20 | pass | 262 / 306 |
| Push, five unseen | 20 | pass | 282 / 349 |
| Room list, one unseen | 20 | pass | 259 / 287 |
| Room list, five unseen | 20 | pass | 252 / 305 |
| Warm Room | 20 | pass | 306 / 366 |
| Composer | 20 | pass | 59 / 90 |
| Corner | 20 | pass | 542 / 645 |
| Reaction | 20 | pass | 80 / 92 |
| Send | 20 | pass | 168 / 224 |
| Tabs | 20 | pass | 161 / 178 |

The second capture's 179 host observations have mean one-minute load **5.58**,
ranging **2.24–16.23** on **20 CPUs**. Both attempts show exactly one write and
zero follow-up reads for Reaction and Send, and at most one prepaint covering
read at depth one with zero optional prepaint calls for Corner. All other seven
request contracts pass in both attempts: **400 measured samples total**.

The [final nightly verdict](nightly.json) is attempt 2, `final:true`, `pass:false`,
`shouldAlert:true`: Corner, Send and Tabs still fail their unchanged timing
budgets. No passing latency baseline was advanced and no timing win is claimed.
[Execution metadata](execution.json) records the profile and each capture's
load separately. The owned emulator, private adb server, fixture servers and
databases were cleaned up; no shared emulator, adb server or helper was stopped.

The application sources match the measured commit. Subsequent changes refresh
the browser proof fixture, comments and documentation/evidence only.

The initial full mobile CI run passed 5,609 tests and failed only two stale
subscription-frame assertions in `monolith-rig-transport.test.ts`. Those exact
expectations now include the negotiated `roomStateProjections` flag. All 25
transport-adapter tests and 72 shared-connection tests pass locally. This
follow-up changes test expectations only; the measured application is unchanged.
