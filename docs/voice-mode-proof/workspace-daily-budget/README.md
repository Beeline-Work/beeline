# One daily call budget per Workspace

Feature verification; not a defect report. This replaces the unreleased
per-person cap documented in the historical [daily-budget proof](../daily-budget/README.md).

## Android method

The normal `apps/mobile/index.ts` Android app runs on an isolated API 36
x86_64 emulator. The release Hermes bundle uses the ordinary review sign-in,
Workspace list, Room, call card and composer. No replacement screen or injected
client state is used. The local fixture creates disposable identities and a
Workspace; HTTP, RTC, microphone publication, server accounting and ledger reads
are real. The production live-event projector receives committed Pglite
notifications through a LISTEN adapter; the phone does not poll. STT and synthesis are deterministic local doubles to avoid paid
provider access. STT emits unnamed confirmed speech every eight seconds to
isolate the existing silence behavior.

The limit is 180 seconds. Android publishes one live mic; a second human joins
through real RTC and publishes a second live mic after Android starts. Their
intervals must consume one call clock. The second human records broadcast
warning packets and transport disconnection.

1. Start a task-owned LiveKit v1.9.12 development container on host TCP 18884,
   TCP 18885 and UDP 18886, mapped to container 7880/7881/7882.
2. Generate local speech PCM with
   `ffmpeg -f lavfi -i "flite=text='Ready'" -ar 24000 -ac 1 -f s16le .beeline-proof/budget/warning.pcm`.
3. Run `node --import tsx scripts/prove-voice-budget.ts` (loopback HTTP 38597).
4. Prebuild the ordinary Android entry. Only in ignored generated native files,
   enable cleartext HTTP and disable updates. Build `:app:assembleRelease` for
   x86_64 with two workers, a 5 GiB heap, and
   `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:38597`.
5. Install on a task-owned emulator, clear app data, grant microphone permission,
   and open `beeline://review/isolated-voice-budget-proof-only`. Complete welcome,
   open Budget proof, and tap Join on the normal call card.
6. At one minute of live microphone time, inspect the existing tip slot. Continue
   through the seconds countdown and whole-call ending, then try starting again.
7. Read loopback `/__result` for durable accounting, peer signals, disconnection
   and the ended transcript line. Stop only this fixture/container/emulator.

APK SHA-256: `68d6dbb2d5df1255ddafb5b14426687af628639da190df520bbfeed00abe788b`.

The owner's timezone is not stored, so this implementation explicitly uses UTC
midnight. The phone formats the resume time in that budget timezone. The call
card's duration includes the second human's setup time before any live mic;
that setup spends no budget.

## Observed result

The final APK run on 2026-10-17 UTC forwarded 359,796 ms of combined
microphone input while spending one 180-second call budget. The second human's
first warning arrived with 119,829 ms left, about one minute after
microphone input began. Both participants received the shared countdown.
At zero, the peer's real RTC transport disconnected, the workspace had no live
call or surviving participant, and Android's Room immediately rendered
`Call ended · 3:47 · Today's 60 minutes are used` from the committed server text.
The restored composer displayed `Calls resume at 12:00 AM`. Starting again was
refused without creating a call, with the same inline message in both themes.

- [Obsidian warning](warning-obsidian-android.png)
- [Seconds countdown](countdown-obsidian-android.png)
- [Whole-call ending and reason](cutoff-obsidian-android.png)
- [Obsidian refused rejoin](rejoin-obsidian-android.png)
- [Bone refused rejoin and ended reason](rejoin-bone-android.png)
- [Durable result and peer signal receipts](result.json)

## Recovery, concurrency and timing

`voice-budget.test.ts` covers union within a call, additive concurrent calls,
independent Workspaces, idempotent retries, UTC midnight, failed checkpoints,
one second of uncommitted time shared by several microphones, snapshot restore
and lease fencing. `voice-service.integration.test.ts` exercises two real service
calls in separate Rooms, workspace exhaustion, both ended cards, authenticated
HTTP join refusal, and retention of charged time after Room deletion.

`VOICE-BOUND-2` drives two independent RTC-reader pumps and stores with a failed
checkpoint lane, demonstrating the one-second bound independently in each call.
Snapshots and a controlled clock stand in for killing a deployed process and
waiting until midnight. The controlled first-audio test publishes audio while
an accounting checkpoint remains unresolved: 12.845 ms before the blocked write,
1.669 ms during it. These are deterministic provider/RTC doubles and establish
no awaited checkpoint dependency; they are not production provider latency.
