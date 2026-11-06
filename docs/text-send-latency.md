# Text send latency — November 4, 2026

The current-head operator capture passes the observed 150 ms send budget:
24 sends have p50/p95 84.259/127.081 ms and maximum 140.341 ms. This is an
observed emulator result, not a universal all-device guarantee. The earlier
load-variable capture below still fails at 216 ms p95. Cold Room opening
still misses the 450 ms budget. The server improvement is measured in an
isolated scenario; it has not been deployed to production.

Firstmate approved this measured improvement under delegated overnight decision
authority (decision006) despite the then-unmet 150 ms send p95 and 450 ms
cold-load budgets. The all-surfaces worker owns cold Room opening in follow-up.
Decision007's conditional native acceptance is now satisfied by the operator
device runs attached below. This change does not claim to meet the full latency
invariant.

## Current-head native acceptance

The credential-free [operator evidence index](../scripts/latency-rig/evidence/text-send-2026-11-04/current-head-native/summary.json)
records tests on exact code head `3a77888f6b99465e9156efc237cfab7d5a5167e4`,
using the original Play runtime44/code144 binary on emulator-5626 against
production142, with the review identity in Beeline Review only. No OTA was
published, native binary replaced or server deployed. The pure-Hermes bundle's
critical Room route, chat surface, preview, row renderer and outbox sources
were matched to the tested code head by the operator. Bundle hashes and source
checks are attached; `tested-code-trees.json` identifies the tested mobile,
server and package trees for comparison with subsequent housekeeping changes.

| Native scenario                            | Result and evidence                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty Room send and canonical handoff      | PASS: one canonical message, at most one native transcript copy, dark readable first frame at 139 ms. `functional.json`, `functional-frames.json`, `empty-first.png` and `empty-previous.png`.                                                                                                                                                                                      |
| Double-tap Send                            | PASS: exactly one canonical message, at most one native transcript copy, dark readable first frame at 133 ms. `functional.json`, `functional-frames.json` and `double-first.png`. These two functional timings are one-off samples, not the performance distribution.                                                                                                               |
| Navigate immediately after Send            | PASS: source delivery completes exactly once; destination canonical read is empty. All three source tokens are absent in all five destination-header frames; manual review of `navigation-empty.png` confirms the empty destination. `target-all-source-tokens.json` and `functional.json`.                                                                                         |
| Durable enqueue failure, retry and restart | PASS: separate controlled-fault bundle rejects the real `deps.save` once; failed event never reaches the server, draft remains, retry delivers once, and disarmed process restart still shows one canonical message. An unrelated queued record survives and delivers exactly once. `enqueue-recovery.json`, `failed-save-draft.png`, `retained-draft.png` and `after-restart.png`. |

The controlled `fault-injection.patch` wraps the real durable save and holds
only the unrelated record's transport. It bypasses no product enqueue or
handler logic and is absent from the pure latency bundle. The durable enqueue
and Room-visit isolation contracts, including regression coverage, are owned by
[the mobile guide](agent-mobile.md#mobile-client). No phone connection or polling is added.

The fresh paired capture alternates four blocks of six sends per arm in one
session, with fixed screenshot readiness, no UI dumps and frame extraction
only after capture. Baseline `283dd1cfd91e2a74b7f46f909e2684c77cfa649f` already
contains the original sender-fade fix; current head includes the atomic enqueue
and Room-scope fixes.

| Tap → readable message | Samples |        p50 |        p95 |    Maximum | Below 150 ms |
| ---------------------- | ------: | ---------: | ---------: | ---------: | -----------: |
| Baseline               |      24 | 136.595 ms | 202.783 ms | 432.883 ms |        16/24 |
| Current head           |      24 |  84.259 ms | 127.081 ms | 140.341 ms |        24/24 |

Current after-input-command p50/p95 is 63.583/97.081 ms. `paired-results.json`
retains every sample, monotonic tap bracket and recognition trace;
`paired-canonical.json` confirms all 48 exact payloads exist once, deduplicating
overlapping history by message id. No sample was dropped. The original
production142 launch bytes and complete Expo manifest/asset hashes were
restored, and the operator reports a healthy phone process at versionCode144.

Native live test acceptance for `TEST-CURRENT-HEAD-NATIVE` and the five pending
native scenarios in `test-2` is recorded as PASS from these operator runs,
including the paired comparison. This phase inspected the supplied evidence;
it did not repeat device mutations. Earlier live server validation passed
normal sends, blocked/erroring observation and shutdown draining: a real
PostgreSQL onboarding lock held observation while committed-write receipts
arrived. The physical `CornerAccessDatabase.backgroundWork` forwarding fix
ensures tracked work reaches the underlying database and shutdown waits for it.
Production exact handler, native wire-to-JS and ack-to-canonical spans remain
unavailable; the measurements and limits below still apply.

## Historical pre-rebase native comparison

All writes used the Play-review identity in **Beeline Review**, never the
captain's Workspace. The private `send-latency-20261104` Room
(`ba6e778a-69ff-4ea2-8b8d-68f94039add3`) has no agent members or model invocation.
The native binary remained the original Play-derived runtime44/code144.

The earlier load-variable comparison alternates old/new local Hermes bundles in the same
session against production142, six sends per block, four blocks per arm.
The old local bundle already includes the sender-fade fix; the new one adds
the independently subscribed first row. Neither bundle was published as OTA.
These are historical pre-rebase local-bundle measurements, not measurements of
the rebased source.

| Measurement                                                      | Samples |      p50 |      p95 | Budget        |
| ---------------------------------------------------------------- | ------: | -------: | -------: | ------------- |
| Old local send, tap → readable message                           |      24 |   208 ms |   448 ms | <150 ms       |
| New local send, tap → readable message                           |      24 |   103 ms |   216 ms | FAIL, <150 ms |
| Original production142, cold Room tap → first screen of messages |      25 | 1,323 ms | 2,251 ms | FAIL, <450 ms |

Both send percentiles improve by about half, but the new p95 still fails.
The new maximum is 301 ms; even measured from after the input command it is
241 ms. After-command p50/p95 is 83/156 ms, so command overhead alone does not
explain every miss. All 48 exact old/new payloads were verified in canonical
server reads; no final sample was dropped.

Cold Room timing starts at a ready Room list, on tapping the Room. Each trial
restarts the app and clears only its disposable DTO cache before that point;
identity, selected Workspace and durable outbox remain intact. It excludes
process startup from the measured interval. The first native frame containing
at least three readable message lines is the endpoint, distinguishing Room
messages from the list's one-line preview. This is measurement only; the send
change does not fix cold page loading.

## Why the send path changes

- `RoomSendPreview` updates a child of the existing inverted FlatList header.
  The first commit leaves the list's data array and existing message bodies
  intact, avoiding a full Room render and history projection/sort.
- The preview uses the existing row renderer, reply context and appearance.
  Native layout plus the following frame releases signing, outbox persistence,
  status updates, optional repository guidance and transcript bookkeeping.
- A send gives the scroll controller the newest destination immediately.
  During first paint it suppresses native anchor preservation: Android's
  `MaintainVisibleScrollPositionHelper` otherwise offsets the old row and
  invokes `reactSmoothScrollTo`, animating new text into view.
- The signed id retains its provisional key. The existing durable outbox and
  canonical DTO take over; the preview is transient, per Room, and disposed
  on navigation. Failed enqueue removes it while retaining the draft.
- `OrdinaryLedgerMessage` skips its 140 ms entrance for own sends. Incoming
  motion is unchanged. No new UI, connection or polling path is added.
- After durable server commit, phone-transport onboarding observation runs through the physical
  database's tracked background work. The receipt queues before observation
  requests another DB connection; shutdown drains it. Analytics failure cannot
  reject a committed message or reply.
  Direct service execution still completes its onboarding milestones before returning;
  the transport opts into the tracked observation path explicitly.

Behavior coverage: `room-send-list.test.tsx` verifies unchanged parent/history
and existing row bodies, one visible copy, stable handoff key, layout/frame
ordering, empty Room and unmount. `SEND-LIST-2` exercises the real send callback,
including duplicate taps and status/preparation ordering. Its failure case
retains the draft if enqueue fails. `SEND-PAINT-1` fails with the old entrance
policy. `SEND-ACK-1` fails on both original message/reply paths when analytics
blocks; the new receipt succeeds while database shutdown still drains analytics.
`SEND-ACK-2` covers observation failure after commit.

## React row cost

On-device `React.Profiler` used the installed `ReactFabric-profiling` renderer,
four process launches, and 20 mount samples for each representative local row
fixture. These are real existing row renderers; fixtures never entered the
production database and diagnostic instrumentation is absent from the diff.

| Row                             | Mount p50 | Mount p95 | p95 / 16 ms frame |
| ------------------------------- | --------: | --------: | ----------------: |
| Plain short text                |   6.95 ms |  13.04 ms |              0.82 |
| Rich Markdown, bullets and code |  21.63 ms |  36.63 ms |              2.29 |
| Completed command/tool row      |   8.95 ms |  11.45 ms |              0.72 |
| Permission decision card        |  14.90 ms |  22.87 ms |              1.43 |

`actualDuration` measures React render work, excluding native layout/draw and
scheduler waiting. These fixtures are not a production complexity distribution.
Rich text and cards demonstrably exceed one frame. Earlier five-send probes
measured 76–184 ms optimistic append → Room layout effect, plus 92–238 ms waiting
for the old two-frame yield. The new first frame does not render that Room root;
its behavior test asserts this separately from wall-clock capture.

## Server and acknowledgement

| Measurement                                                        | Samples |    p50 |    p95 |
| ------------------------------------------------------------------ | ------: | -----: | -----: |
| Production host live-socket send → receipt                         |      25 | 129 ms | 172 ms |
| Same host/socket application ping → pong                           |      25 |  67 ms |  71 ms |
| Receipt minus adjacent ping                                        |      25 |  58 ms | 105 ms |
| Production server-machine loopback send → receipt                  |      25 | 266 ms | 483 ms |
| Same machine loopback ping → pong                                  |      25 |   1 ms |   4 ms |
| Isolated original `PhoneService.execute`, 25 ms per-query scenario |      25 | 189 ms | 227 ms |
| Same isolated scenario, new server code                            |      25 |  85 ms | 109 ms |

The exact isolated handling stopwatch removes about 104 ms at the median by
moving onboarding work after receipt. Its artificial per-query delay is a
controlled before/after scenario, not a deployed production result. Production
host and loopback runs occurred at different times and can hit different
machines; they are not a paired production comparison. Loopback includes DB,
server dispatch and local socket/event-loop cost. The external 67/71 ms ping
and substantial 266/483 ms loopback acknowledgement show that physical network
RTT alone does not explain the reported delay.

Five earlier native diagnostic sends measured tap → JS acknowledgement at
575–833 ms. Wire → JS acknowledgement includes network, server and client
scheduling delay. Production142 socket replies do not expose an exact handler
span. Native wire arrival → JS handling and acknowledgement → canonical React
commit remain unmeasured. Ordinary text is already visible optimistically;
there is no added delivered indicator to use as a visual acknowledgement.
Production after-deployment handling also remains unmeasured.

## Evidence and capture limits

Per-sample evidence and bundle/video hashes are in
[`scripts/latency-rig/evidence/text-send-2026-11-04`](../scripts/latency-rig/evidence/text-send-2026-11-04/).
Current-head JSON, selected PNGs, capture/analysis harnesses and the controlled
fault patch are attached under `current-head-native/`. The harnesses are
historical operator provenance, not portable replay commands: they reference
operator-local fixtures and private session inputs that are deliberately absent.
`functional.json`'s original `frame-summary.json` is copied as
`functional-frames.json`; `local-artifact-hashes.json` retains the original local
artifact names, including videos that remain local. Earlier failure screenshots,
raw videos and other first/preceding frames remain in the task's ignored
`.beeline-proof/send-latency/`, unavailable from a GitHub checkout. Launch assets,
original manifests, secrets and private sessions are excluded from this copy.

Final sends use fixed screenshot-selected composer/send coordinates, screenshot
OCR readiness, and enabled-arrow verification before each tap. Empty draft
readiness precedes typing the next message, avoiding a prior send's draft clear.
No `uiautomator` dumps are used. Android
[screenrecord metadata](https://android.googlesource.com/platform/frameworks/av/+/b675cea85b508d7f60f1344e5a24c3db7a5b8d0f/cmds/screenrecord/screenrecord.cpp)
provides elapsed-clock frame timestamps. On-device `/proc/uptime` brackets
`input tap` in the same clock domain, with 10 ms clock granularity; wall-clock
`date` brackets are retained too. The reported before-command upper bound
includes input-command overhead. First readable unique suffix and preceding
frames are retained, with a preexisting-text guard. Both arms use identical OCR.

Earlier C/D measurements used ≥0.97 settled-glyph template correlation and
reported 256/508 ms and 239/372 ms. Frame review found that this also counted
fractional scrolling/settling after text was already readable. Those numbers
are retained as conservative settling proxies, not used for the final first
readable-text comparison. Earlier fixed-delay K/L captures did not verify full
draft or enabled send state; their overlapping draft clears and censored final
frames make them unsuitable as a successful-send latency distribution. They
remain local evidence rather than silently discarded slow final-run samples.

The emulator shares a busy 20-CPU host; alternating builds controls session
ordering but does not make this a calibrated physical-phone certification.
All final-run samples are retained. The original production142 launch bytes
and Expo manifest/hash metadata were restored and verified: source
`98c2a49a4f3df909e8fd3fc32ae39129f6f8367b`, launch SHA256
`0814b713dcfa6ed20048aae18d4ce2a3b22af36d1a888b564c5b1af0cc0d6f0c`.

Validation before pipeline: root typecheck; 213 mobile regression tests; 19
phone-socket integration tests; network, UI component and architecture guards.
Vitest used `--maxWorkers=2` (`--minWorkers=1` on server Vitest 2).
