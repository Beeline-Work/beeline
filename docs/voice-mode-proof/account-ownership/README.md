# CALL-OWNER-1: one account owner with RTC room rotation

The [built main-service reproduction](baseline.json) accepts a second device with
HTTP 200, replaces the first session, and delivers 47 stale audio frames when the
old phone replays its cached publishing token. A cached LiveKit token could also
reconnect after removal and publish to an ordinary listener. The baseline replay received 306 non-silent frames on the pinned
self-hosted LiveKit v1.9.12. Starting tokens without publish rights and granting
on a signed join webhook also failed: LiveKit refreshed a publishing token;
replaying it with a controlled six-second webhook delay delivered 154 frames.
Those experiments used native RTC and synthetic PCM, without production data.

The implemented server commits account ownership before retiring the old RTC
room, explicitly creates the next room, and withholds credentials until old-room
deletion succeeds. LiveKit has `room.auto_create: false`. Room names are generated
only by `voiceRoomName`. Cached tokens cannot recreate a retired room. No listener
filter, LiveKit upgrade, API-key rotation, or production client change is needed.

## Demonstrated

The [built-server proof](server.json) uses actual authenticated HTTP handlers,
compiled server/runtime modules, isolated PostgreSQL with five connections,
LiveKit v1.9.12, native RTC clients and
synthetic microphone PCM. Both original and LiveKit-refreshed cached tokens fail
immediately and after six seconds. Zero stale frames reach the listener. Ordinary
second-device join is refused, replaced reconnect is terminal, reconnect preserves
the ownership epoch after the initial ten-second token expires, and delayed old
leave/Stop requests do not end its successor. Fresh Room calls, DM calls and runtime
microphone reception also pass. Two simultaneous HTTP acquisitions in different
Rooms on PostgreSQL return exactly one success and one ownership conflict. Unit/integration regressions cover deletion retries,
committed ownership after exhausted retries, cross-Room acquisition, repeated logout,
legacy-call migration, and stale runtime callbacks.

The [Android proof](android.json) runs the unmodified production hook/native
transport in a release/Hermes fixture on a Beeline-leased API 36 phone emulator and
API 35 listener emulator. A native Node RTC client represents the new laptop owner.
After explicit takeover, the phone shows [Call replaced on another device](replaced-phone.png),
its old runtime input stops, and the other listener reconnects
and receives decoded provider audio in the new room. The new room never receives
the old phone identity. Native inbound RTP energy rises from 0.00979 before takeover
to 0.01084 afterwards. The observed interval between energetic native statistics
samples was 1,617 ms, including test-driver pauses and a new spoken response; it is
not a physical speaker or isolated transport-gap measurement. The earlier Chrome
feasibility experiment measured a 661 ms takeover gap.

Provider text/PCM and STT are controlled stand-ins. Native capture, WebRTC,
authenticated routes, database ownership, reconnect, cleanup and decoded RTP are
real. These proofs do not measure live provider quality, a physical phone speaker,
or iOS. They do not release anything.

## Normal-path measurements

[Five alternating paired runs](latency.json) compare main `7f127c49c` with the
built ownership service, using the same request, Room membership and PCM workload.
Time starts before HTTP join and ends at first non-silent PCM received by the
other RTC listener. Baseline uses LiveKit's original automatic room creation; the
new service explicitly creates its room with automatic creation disabled. Both
local containers advertise the same host address with external-IP discovery off.

| Pair | Main (ms) | Ownership (ms) | Added (ms) |
| --- | ---: | ---: | ---: |
| 1 | 447.20 | 406.99 | -40.20 |
| 2 | 472.31 | 476.92 | +4.61 |
| 3 | 490.52 | 421.48 | -69.04 |
| 4 | 461.38 | 429.20 | -32.19 |
| 5 | 519.59 | 458.75 | -60.84 |

Median paired difference is -40.20 ms. This small local sample shows no consistent
regression; it does not establish exact zero overhead or a latency improvement.
Room creation occurs once per transport epoch. Authentication captures the device
family in its existing token read. Normal reconnect and turns do not rotate rooms.
Application-issued participant tokens now last ten seconds; LiveKit may refresh
connected tokens to ten minutes. Expiry is not the revocation boundary: room
rotation fences both kinds. The built proof also reconnects successfully after the
initial token expires. Ten seconds is a tested issuance window, not a claimed
universal minimum across arbitrary network delays.

## Repeat

Build the packages and server with `npm run build`. Start isolated LiveKit v1.9.12
on signalling 17980, RTC TCP 17981 and UDP 17982, with development-only `devkey` /
`secret`, a reachable host `rtc.node_ip`, `rtc.use_external_ip: false` and
`room.auto_create: false`. No production credentials are used. Run:

```
node --import tsx scripts/prove-voice-ownership.ts
```

For PostgreSQL concurrency proof, use a disposable loopback database named
`ownerproof` with pgvector available and set `VOICE_OWNER_TEST_POSTGRES_URL`.
The script refuses other hosts/database names. Each run needs an empty database.
It never resets or deletes an existing database.

For the native proof, bundle `apps/mobile/scripts/voice-owner-native-proof.tsx` as
the generated Gradle `entryFile`. Set `EXPO_PUBLIC_BUZZY_MONOLITH_URL` to
`http://10.0.2.2:18097`, allow cleartext and disable Updates in the generated fixture
manifest. Build x86_64 with two Gradle/Metro workers and a 4 GiB Gradle heap. These
are ignored fixture build settings, with no native/runtime or product changes.
Install and grant microphone access on two leased emulators. Then start:

```
VOICE_OWNER_ANDROID=1 node --import tsx scripts/prove-voice-ownership.ts
```

Launch the same APK with `beeline:///proof?role=phone` on the first emulator and
`beeline:///proof?role=listener` on the second. Run:

```
node --import tsx scripts/prove-voice-ownership-android.ts
```

Artifacts are written to ignored `.voice-proof/account-owner`. Fixtures expose
only disposable local sessions. Keep their raw credentials out of committed proof
files. [Build hashes](build.json) identify the tested APK and compiled modules.
