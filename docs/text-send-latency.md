# Text send latency — November 4, 2026

The 150 ms interaction budget is **not met**. These targeted fixes improve the
send path, but this is an incomplete performance checkpoint, not a release pass.

## Changes

- The sender's ordinary message skips the 140 ms `NewMessageMaterialize`
  entrance, including provisional-to-signed replacement. The existing text,
  byline, ordering, outbox, and incoming-arrival motion remain authoritative.
- After message/reply commit, `PhoneService.observeSentMessage` schedules
  onboarding observation on the physical database's tracked background work.
  The response queues before observation requests a database connection.
  Shutdown drains observation; an observation failure cannot fail the receipt.
  Previously every ordinary send awaited two onboarding lookups even when it
  had no onboarding context. Real onboarding can perform more work.

`SEND-PAINT-1` fails with the original entrance policy. `SEND-ACK-1` fails for
both messages and replies on the original implementation: blocking onboarding
also blocks the acknowledgement. With the fix the receipt succeeds while
observation remains blocked, and database close still owns its lifetime.
`SEND-ACK-2` covers failed observation after a successful committed write.

## Measured results

All production writes used the dedicated Play-review identity and its own
**Beeline Review** Workspace, never the captain's Workspace. The final native
comparison used its private `send-latency-20261104` Room
`ba6e778a-69ff-4ea2-8b8d-68f94039add3`, with no agent members or model invocation.

| Measurement | Samples | p50 | p95 | Meaning |
| --- | ---: | ---: | ---: | --- |
| Original v142 Android tap → readable transcript text | 25 | 256 ms | 508 ms | FAIL, <150 ms |
| Candidate Android tap → readable transcript text | 21 | 239 ms | 372 ms | FAIL, <150 ms |
| Production host live-socket send → receipt | 25 | 129 ms | 172 ms | Existing v142 server |
| Same host/socket application ping → pong | 25 | 67 ms | 71 ms | Network/edge/event-loop baseline |
| Host receipt minus adjacent ping | 25 | 58 ms | 105 ms | Residual, not an exact server span |
| Production server-machine loopback send → receipt | 25 | 266 ms | 483 ms | Server/DB plus local socket/event-loop cost |
| Same machine loopback ping → pong | 25 | 1 ms | 4 ms | Negligible external network leg |
| Isolated server handling, original code, 25 ms per-query scenario | 25 | 189 ms | 227 ms | `PhoneService.execute` stopwatch |
| Same isolated scenario, changed code | 25 | 85 ms | 109 ms | Controlled proof; not production after deployment |

The host and production-loopback runs occurred at different times and can hit
different serving machines. Their variance must not be presented as a paired
production before/after comparison. The server patch has **not been deployed**;
production after-deployment handling remains unmeasured.

One original-v142 process-cold deep-link Room open took **1,867 ms** to a
meaningful Room frame, retaining its DTO cache. This includes Android/JS process
startup. It misses 450 ms, but one observation is not a p50/p95 distribution or
a cold-cache page-read benchmark. This send-path change does not resolve it.

## Capture and limits

The phone retained the original Play-derived native runtime44/code144 binary.
The before run used actual production OTA142, source
`98c2a49a4f3df909e8fd3fc32ae39129f6f8367b`. The candidate was a local Hermes
launch-asset fixture from base `5547a106b` plus the outgoing-entrance change,
against the unchanged production server. It was never published as an OTA.

`adb input tap` was bracketed by on-device `date +%s%N`. A 540×1200 screen
recording supplies each frame's device-clock timestamp. Android's
[screenrecord metadata implementation](https://android.googlesource.com/platform/frameworks/av/+/b675cea85b508d7f60f1344e5a24c3db7a5b8d0f/cmds/screenrecord/screenrecord.cpp)
records elapsed-clock frame timestamps and a realtime offset. The analyzer
matches the unique message suffix in the transcript at normalized correlation
≥0.97, excluding the composer. It retains the preceding and first matching
frames and rejects an already-matching pre-tap frame. Faint entrance fragments
can precede the readable match; these are conservative readable-text bounds,
not physical display scanout times. The on-device input command itself took
roughly 20–75 ms in most candidate samples and is included in the table.

An initial after-capture in shared #proof was contaminated by concurrent
connection-proof messages and excluded. Dedicated runs replaced it. The final
candidate harness terminated after 21 sends; all 21 completed samples were
retained, without dropping slow samples. A bounded canonical read found 20 exact expected candidate strings; all 21
messages committing was not established. No delivery-complete assertion is
implied by the 21 optimistic visibility samples. Native timings include screenrecord
and shared-host overhead. This emulator is not a calibrated physical A15.

The 20-CPU host repeatedly had load averages around 31–39. A later direct
snapshot showed 27–34 runnable tasks, 16% idle CPU, and CPU pressure of 26.65%
over the preceding minute. This prevents certifying performance on a quiet
physical phone. It does not turn the measured budget failures into passes.

Content-free diagnostic JS probes, excluded from the uninstrumented comparison,
showed 76–184 ms from optimistic append to React layout-effect commit across
five samples. A second five-sample probe showed another **92–238 ms** between
that commit and the existing two-frame yield finishing. The yield finished
*after* commit in these samples, so an assumed yield-before-commit race was not
confirmed and no speculative commit barrier was added. Preparation after the
yield took only 2–11 ms in the latter probe. Further investigation belongs in
the React/native frame path and its contention, not just server SQL.

The first diagnostic's native tap → JS acknowledgement ranged 575–833 ms,
consistent with the reported problem. Its wire → JS-ack durations include
network, server work and JS handling delay. Neither that probe nor the host
client separates native wire arrival from JS processing, and native
acknowledgement → visible canonical UI remains **unmeasured**. ICMP on the
emulator varied 37–432 ms; it is not a calibrated application RTT. The stable
host socket ping and nontrivial production-loopback receipt time show that
physical network RTT alone does not explain this send latency.

## Evidence and next step

Content-free per-sample JSON is committed under
[`scripts/latency-rig/evidence/text-send-2026-11-04`](../scripts/latency-rig/evidence/text-send-2026-11-04/).
The manifest identifies native/OTA/candidate scope, restoration and raw-video
SHA256 values. Raw videos, frame pairs and scripts remain only in the task's ignored
`.beeline-proof/send-latency/` directory. The temporary proof-session file was
removed; credentials are never part of committed evidence. Their local presence is not
a claim that the videos are available from a GitHub checkout.

The phone's original v142 launch bytes and exact Expo manifest/hash metadata
were restored and verified. Launch bundle SHA256 is
`0814b713dcfa6ed20048aae18d4ce2a3b22af36d1a888b564c5b1af0cc0d6f0c`.
Temporary diagnostic code is absent from the product diff.

Next: obtain a quiet/controlled emulator capture and profile the native frame
wait. If it persists there, isolate the local send render from the full Room
render while preserving chronology, outbox persistence and committed DTO
reconciliation. Repeat 20+ native samples before declaring <150 ms. Measure
actual production server handling again after an authorized release; retain
separate native wire-arrival and UI-update measurements.
