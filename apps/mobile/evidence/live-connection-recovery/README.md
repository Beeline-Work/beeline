# Native foreground and brief-drop recovery

Reproduction IDs: `NATIVE-142-AUTH`, `NATIVE-142-BACKGROUND`, and the
`native brief-drop recovery` cases in
`apps/mobile/sources/sync/transport/live-connection.test.ts`.

The reported 02:08–02:09Z episode coincided with a production cleanup transaction
blocking 51 clients until rollback, according to firstmate's incident evidence.
This proof demonstrates independent client weaknesses; it does not attribute
that episode or Ruby's missing replies to the client alone.

## Device and method

Firstmate granted `emulator-5626`, the original Play versionCode144/runtime44
installation, with the dedicated Play Review identity in **Beeline Review**,
Room **#proof**. The captain's Workspace was never used. The native shell is
unchanged. Android is API35/x86_64 on this host, not a calibrated physical A15.
`emulator-5628` (runtime40) was not used for faults or bundle substitutions;
its final health check confirms the production v142 update and Beeline Review
Workspace without a recovery banner.

Traffic was shaped on the granted emulator with `tc netem`: **200 ms egress
delay and 1 Mbit/s** on both wlan0 and eth0. This is a configured egress profile,
not a measured production RTT. Frida 16.7.19 records native ACTION_UP, socket
lifecycle, phone operation IDs and reply IDs. It logs no credentials, message
bodies or complete live frames. Native fault injection is confined to this
proof account and emulator. Production code gains no instrumentation, channel,
heartbeat, UI, or recurring network timer.

The shipped v142 bundle was pulled and saved before any changes. Its first
reproduction and timing samples execute that exact bundle. CDN access to the
v141 launch asset returned HTTP403, so the comparison uses the allowed
pre-fix source baseline: v141 commit
`d1672c746553a23bd6f4f7c4c224fcc5a4c9af04`, rebuilt with this lane's installed
dependencies. The baseline and fixed source builds are substituted into the
same native44 cached launch path with the existing assets and proof account.
These two are source-built fixture OTAs, not untouched shipped v141/v142 APKs.
No update is published. The original v142 bytes are restored after capture.

## Reproduced and fixed

**Healthy return.** v142 always calls `reconnectNow()` on active AppState,
discarding the socket and rejecting dispatched operations. Native traces show
a new handshake on each quick return. The fix retains an existing socket,
including an opening handshake. Connectivity notifications also retain it.
An absent socket can still recover on those events; close/error, missed
requests, missing live delivery, explicit Retry and identity changes retain
their existing recovery authority.

**Transient authorization failure.** The native fixture fails one upgrade,
then fails one renewal request with a transient network error. v142 does not
attempt authorization again. Its next text stays queued until another app
return, **117,263 ms** after the send touch in this capture. The fixed app starts
its one authorization retry **108 ms** after the failed renewal and reopens
**2,712 ms** after it, without an app switch or Retry. Authorization exhaustion
still stops; this is a bounded immediate retry, not a polling loop. Existing
rejected-token renewal keeps its own one-attempt bound.

**Brief drop while sending.** The fixture closes the native socket just before
one text's first write would reach the network. The persisted outbox keeps the
same message ID and delivers it after reopening: **3,064 ms** from injected drop
to acknowledgement, one actual network write and one visible message. The
transport separately preserves requests that were queued but never dispatched
when a close callback arrives. Their original deadlines remain in force. A
request already dispatched on the old socket is never replayed by transport;
the app-wide outbox owns keyed message retries.

**Slow handshake.** A native fixture delays the next connect by 16 seconds,
on top of the same traffic shaping. That socket opens after **17,913 ms** and
the queued text is acknowledged. The 15-second timer bounds credential
acquisition, not an already-created native socket's handshake. It was not the
cause in this slow-handshake case, so its stuck-credential protection is
retained, including fencing late credentials and allowing one bounded retry.
A real request's deadline remains evidence to replace an unresponsive socket.

**Background.** The two-minute app-owned close timer is removed. Android owns
process cleanup, and real socket close/error callbacks retain recovery. Identity
change and explicit disposal still close sockets and reject all outstanding
requests. In a **139,753 ms** native background cycle, Android aborted the socket after
**5,682 ms** with `Software caused connection abort`; its replacement failed
DNS while backgrounded. No app close request was emitted. On return, the
existing failure evidence recovered the socket and delivered the next text
in **663 ms** from its touch to acknowledgement. The retained Room cursor
resumed without a new Room read. The original trace also resumed without
a Room read; this capture does not claim a read-count improvement. Android
already ended the unusable connection, so a second app-owned teardown is
unnecessary. The regression additionally protects cursor retention beyond
two minutes, where the deleted timer could previously clear it. The original v142
comparison lasted **150,852 ms** in the background. Android again aborted its
socket after about 5.7 seconds. On the first return its queued text did not
even reach a socket. A second manual app switch recovered it; the eventual
acknowledgement was **49,930 ms** after the original text touch, including the
deliberate wait before that manual recovery. This is not a 50-second server
processing measurement. This reproduces the
failed-authorization gap naturally under Android background networking as
well as with the controlled fault. `background-results.json` records the
fixed automatic recovery and v142 result after manual recovery.

## Text acknowledgement time

`send-results.json` and the bounded traces retain the timestamps. This measures
**native touch-up to the server's successful send acknowledgement**, the receipt
that retires local sending state. It includes preparation/persistence before
wire dispatch. It does not measure the final display scanout or another phone's
paint. There are two samples per cell; these are scenario observations, not a
statistical latency guarantee.

| Build in native44 shell | Warm send, ms | Send just after app return, ms |
| --- | --- | --- |
| Original shipped v142 | 755, 574 | 2034, 1357 |
| Pre-fix v141 source baseline | 627, 546 | 1419, 1975 |
| Fixed source | 619, 547 | 827, 550 |

The fixed quick returns produce **zero** new sockets, reconnect requests or
Connecting transitions. Sends do not wait for a foreground check or a covering
GET. The warm range matches the previous source baseline; returning sends
remove the handshake cost. No additional fixed send-path wait was found.

## Repeat and validation

Use only a granted proof-account emulator. `probe.py` expects Frida 16.7.19 and a
server forwarded to localhost:28126, and takes a trace filename. It attaches to
the running `app.usebeeline` PID. Commands on its stdin are `fault`, `drop`,
`dropwrite`, `slow`, and `quit`. Faults affect only the next specified native
operation; normal traffic resumes automatically. `capture-sends.py <label>`
uses native UI taps and writes action timestamps. `analyze.py <scratch-dir>`
correlates the native trace/action filenames with server replies.

For traffic shaping and restoration:

```sh
adb -s emulator-5626 shell tc qdisc add dev wlan0 root netem delay 200ms rate 1mbit
adb -s emulator-5626 shell tc qdisc add dev eth0 root netem delay 200ms rate 1mbit
# Capture, then restore both original qdiscs:
adb -s emulator-5626 shell tc qdisc del dev wlan0 root
adb -s emulator-5626 shell tc qdisc del dev eth0 root
```

For each bundle, open the proof Room before `capture-sends.py`. Source baseline
and candidate exports use `expo export --platform android --max-workers 2`,
with bytecode 96 matching the historical native shell. Stop the app before
replacing its saved launch file. Preserve and finally restore the original
bundle bytes and ownership. Never substitute or reset credentials.

Five focused story regressions fail against the original v142 transport and
pass with the fix. The slow-handshake case also passes. Validation completed:
157 tests across seven mobile suites (`--maxWorkers=2`), root `npm run typecheck`,
phone network channel guard (74 sites/74 entries), architecture guard (20 rules),
workflow paths, and `git diff --check`. No network inventory entry was added.

An initial instrumented candidate launch produced a native SIGSEGV before JS;
a normal relaunch succeeded, with no repeated fatal. That launch is excluded
from latency capture. These numbers do not establish physical-device behavior
or eliminate unrelated native failures.

The focused mobile validation command, from `apps/mobile`, is:

```sh
./node_modules/.bin/vitest run \
  sources/sync/transport/live-connection.test.ts \
  sources/buzz/message-outbox.test.ts \
  sources/buzz/message-outbox-runtime.test.ts \
  sources/sync/transport/monolith-operation.test.ts \
  sources/auth/monolith-session.test.ts \
  sources/sync/transport/room-view-client.test.ts \
  'sources/app/(app)/beeline/chat/useRoomSurfaceSession.silent-socket.test.ts' \
  --maxWorkers=2
```

## Pipeline review fix: retained Room catch-up

The native captures above predate the R1 pipeline review fix. Their background
socket was aborted by Android; they do not prove delivery of a large reply
while a healthy socket survives backgrounding.

The pipeline fix retains incomplete deliveries at `useRoomSurfaceSession`,
where background invalidations previously discarded their read request and
sidebar previews supplied no full transcript row. Activation consumes this
pending work through one existing Room read, without replacing a healthy
socket, polling, changing the keyed outbox, or adding a network channel.

Behavioral regression cases use the real refresh scheduler and server sidebar
projection with mocked network edges. A reply over 2 KiB becomes a bounded
preview while backgrounded. Preview-only, invalidation-only, and combined
cases assert no background reads over three minutes, exactly one covering
read on activation exposing the complete reply, no reconnect, and no further
read on a repeated activation or idle wait. These are deterministic pipeline
checks, not additional native captures or latency measurements. Complete
background deltas also have coverage confirming no covering read is needed.

Focused review verification, from `apps/mobile`:

```sh
./node_modules/.bin/vitest run \
  'sources/app/(app)/beeline/chat/useRoomSurfaceSession.silent-socket.test.ts' \
  'sources/app/(app)/beeline/chat/useRoomSurfaceSession.test.ts' \
  --maxWorkers=2
```

Review verification result: **80 tests passed across both focused files**
(11 real-scheduler cases and 69 Room-session cases), with `--maxWorkers=2`.
No native capture was repeated for this pipeline fix.

## Pipeline review fixes: authorization bound and deck activation

R2 keeps deadline recovery from replenishing the authorization retry budget.
A refresh timeout has no socket to replace; the current authorization attempt
owns its bounded recovery. Deadlines for an existing socket still replace it,
without resetting that budget. A successful open or a new explicit Retry,
foreground, or connectivity recovery starts a new budget.

R3 invokes the visible deck's existing `refreshMissed()` and list `catchUp()`
paths on AppState activation. It reads only skipped work, retaining the healthy
socket and server-indexed DTO authority. The activation listener checks the
client identity generation and is removed with its deck session.

The R2 behavioral case uses the real `MonolithSession`, expired stored access,
a stalled refresh endpoint, its 10-second timeout, the installed request-deadline
handler, and a waiting socket request's separate deadline. It advances ten
minutes to check that only two refresh attempts occur, then proves a new
foreground event permits just two further attempts. R3 cases exercise the
rendered deck and real list/scheduler: background Workspace rename and list
invalidation, one activation catch-up, no reads without missed work, deferral
under a Room until navigation focus, and no old-identity reads after reset.

These pipeline regressions use fake time and mocked network edges. They do not
extend or repeat the earlier native captures, traffic shaping, or send timings.
Focused verification, from `apps/mobile`:

```sh
./node_modules/.bin/vitest run \
  sources/sync/transport/live-connection.test.ts \
  'sources/app/(app)/beeline/channels.live.test.tsx' \
  --maxWorkers=2
```

R2/R3 focused review result: **125 tests passed across both files**
(83 transport tests and 42 deck tests), with `--maxWorkers=2`.
No native captures were repeated for these pipeline fixes.
