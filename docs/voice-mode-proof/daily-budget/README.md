# Per-person daily call budget

Feature verification, not a defect report. Previously there was only the
provider's shared quota, with no per-person daily cap.

## Real-app Android user path

The normal Android app (`apps/mobile/index.ts`, Expo Router) signs in through
its existing review link route to an isolated server and opens the real Budget
proof Room from the Room list. No harness screen, replacement component, or
client state injection is used. The server fixture creates ordinary identities,
memberships and a Room in its disposable database. HTTP, Room reads, RTC,
runtime and ledger are real. The limit is 180 seconds for the demonstration.

STT and synthesis are local doubles to avoid paid provider access. STT receives
actual Android PCM and emits confirmed unnamed speech every eight seconds to
isolate the existing silence behavior. Synthesis returns flite PCM speaking
“Two minutes left today”. A second identity joins through real RTC without
publishing its mic.

1. Start LiveKit v1.9.12 in development mode, mapping 7880 to host 17884,
   7881 to 17885, and UDP 7882 to 17886.
2. Create `.voice-proof/budget`, then generate the warning:
   `ffmpeg -f lavfi -i "flite=text='Two minutes left today'" -ar 24000 -ac 1 -f s16le .voice-proof/budget/warning.pcm`.
3. Run `node --import tsx scripts/prove-voice-budget.ts`. The server listens on
   loopback port 38497. Its review secret is synthetic and valid only there.
4. Prebuild Android with its normal `index.ts` entry. For this local build only,
   disable Expo updates and allow cleartext HTTP in the generated manifest.
   Build `:app:assembleRelease` with x86_64, two workers, a 5 GiB Java heap and
   `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:38497`.
5. Install on Android API 36, grant microphone permission, and open
   `beeline://review/isolated-voice-budget-proof-only`. Finish welcome, open
   Budget proof from the Room list, and tap Join on the real call card.
6. Watch the existing tip slot at one minute of input, the seconds countdown
   below one minute remaining, and the restored composer at zero. Try the
   composer conversation control again and check the same local reset message.
7. Read `http://127.0.0.1:38497/__result` for durable usage and surviving
   participants. Stop only this fixture and its isolated LiveKit container.

The reset boundary is UTC because no user timezone is stored. The message uses
`toLocaleTimeString` on the device to display that boundary in local time.
`endingWarning`, when supplied by the separate call-ending feature, takes
precedence over the budget warning in the same tip slot; tests cover both one
and multiple humans. No separate banner or toast is rendered.

`warning-real-room-android.png` captures the warning in the existing tip slot
of the real Room. The server received one authenticated warning request, and
Sam received no budget signals or voiced audio. The local speech line uses the
already-existing native audio player; no call-wide audio track carries it.

The final run forwarded exactly 180,000 ms, then removed Alex only. Sam remained
connected with all 180,000 ms, no budget signals and no voiced audio frames.
`cutoff-real-room-android.png` shows the restored composer with the reset at
8:00 PM in the emulator's local timezone (the server boundary is UTC midnight).
`rejoin-real-room-android.png` captures the same inline error after tapping the
composer conversation control again. No alert or duplicate call-card error
appeared. `countdown-real-room-android.png` captures the seconds countdown.
`result.json` records the durable final budget and surviving participant.

## Accounting and timing checks

`voice-budget.test.ts` covers interval union across overlapping devices,
no-input gaps, idempotent retries, UTC midnight, checkpoint failure and recovery,
final-checkpoint retry, persisted database restoration, and successor leases.
The restart/handoff and next-day cases use a persisted database snapshot and
controlled clock rather than a production multi-server deployment or waiting
until midnight. The accepted abrupt-death loss window remains at most one second.

The controlled runtime probe returned first audio while a checkpoint was still
unresolved: 2.572 ms before the blocked write and 0.527 ms during it. This proves
no awaited accounting dependency on the response path, not provider latency.
Root typecheck, 69 runtime tests, 51 affected mobile tests, the additional tip
precedence tests, denied-join test, and dead-code check pass. No release.
