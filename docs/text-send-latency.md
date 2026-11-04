# Text send latency — November 4, 2026

The 150 ms interaction budget is still missed in this capture. The native
send path now paints one local row before signing, persistence,
Room-wide projections or network work. Cold Room opening still misses the
450 ms budget. The server improvement is measured in an isolated scenario;
it has not been deployed to production.

Firstmate approved this measured improvement under delegated overnight decision
authority despite the unmet 150 ms send p95 and 450 ms cold-load budgets.
Remaining send p95 work continues in follow-up; the all-surfaces worker owns
cold Room opening. This change does not claim to meet the latency invariant.

## Native comparison

All writes used the Play-review identity in **Beeline Review**, never the
captain's Workspace. The private `send-latency-20261104` Room
(`ba6e778a-69ff-4ea2-8b8d-68f94039add3`) has no agent members or model invocation.
The native binary remained the original Play-derived runtime44/code144.

The final comparison alternates old/new local Hermes bundles in the same
session against production142, six sends per block, four blocks per arm.
The old local bundle already includes the sender-fade fix; the new one adds
the independently subscribed first row. Neither bundle was published as OTA.
These are historical pre-rebase local-bundle measurements, not measurements of
the rebased source.

| Measurement | Samples | p50 | p95 | Budget |
| --- | ---: | ---: | ---: | --- |
| Old local send, tap → readable message | 24 | 208 ms | 448 ms | <150 ms |
| New local send, tap → readable message | 24 | 103 ms | 216 ms | FAIL, <150 ms |
| Original production142, cold Room tap → first screen of messages | 25 | 1,323 ms | 2,251 ms | FAIL, <450 ms |

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
- After durable server commit, onboarding observation runs through the physical
  database's tracked background work. The receipt queues before observation
  requests another DB connection; shutdown drains it. Analytics failure cannot
  reject a committed message or reply.

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

| Row | Mount p50 | Mount p95 | p95 / 16 ms frame |
| --- | ---: | ---: | ---: |
| Plain short text | 6.95 ms | 13.04 ms | 0.82 |
| Rich Markdown, bullets and code | 21.63 ms | 36.63 ms | 2.29 |
| Completed command/tool row | 8.95 ms | 11.45 ms | 0.72 |
| Permission decision card | 14.90 ms | 22.87 ms | 1.43 |

`actualDuration` measures React render work, excluding native layout/draw and
scheduler waiting. These fixtures are not a production complexity distribution.
Rich text and cards demonstrably exceed one frame. Earlier five-send probes
measured 76–184 ms optimistic append → Room layout effect, plus 92–238 ms waiting
for the old two-frame yield. The new first frame does not render that Room root;
its behavior test asserts this separately from wall-clock capture.

## Server and acknowledgement

| Measurement | Samples | p50 | p95 |
| --- | ---: | ---: | ---: |
| Production host live-socket send → receipt | 25 | 129 ms | 172 ms |
| Same host/socket application ping → pong | 25 | 67 ms | 71 ms |
| Receipt minus adjacent ping | 25 | 58 ms | 105 ms |
| Production server-machine loopback send → receipt | 25 | 266 ms | 483 ms |
| Same machine loopback ping → pong | 25 | 1 ms | 4 ms |
| Isolated original `PhoneService.execute`, 25 ms per-query scenario | 25 | 189 ms | 227 ms |
| Same isolated scenario, new server code | 25 | 85 ms | 109 ms |

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
Raw videos, first/preceding frames and capture scripts remain in the task's
ignored `.beeline-proof/send-latency/`; they are not available from a GitHub
checkout. Credentials are excluded from committed evidence.

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
