# Remove the page offline notice

Reproduction page-offline-1: open a cached Room, then fail its refresh with
`TypeError: Network request failed`. Before, the page says “Offline — showing
the last saved response” above its transcript. After, the transcript remains
visible without that band. The failure alone never established connectivity.

No open PR covered the notice (all open PRs, including branch names, checked
before editing; candidate file lists inspected). Mobile and web share
`_chat-surface.tsx`; both lose the same component. There is no dedicated device
connectivity signal or listener behind this notice. It came from the Room
refresh error callback. Shared socket, cache, retry and outbox logic stay intact.

## Android evidence

`android-before.png` and `android-after.png` are native Android 36 captures on
the isolated, Beeline-leased emulator-5558. The matching XML dumps show the
notice and Retry before, and the same header and transcript without them after.
Only Android was exercised; iOS was excluded.

The signed-in production Room was unavailable in this fresh isolated emulator.
The closest visual stand-in is `apps/mobile/offline-proof`: a small Expo Go
scene with native header/transcript text and the **actual production
RoomSavedCopyNotice** before deletion. After deletion the same scene omits the
removed component. This scene proves the native visual change, not a live
server or full-app navigation flow. Unistyles and animation adapters reuse the
existing rail proof; these adapters are not shipped. The displayed conversation
is fixture text, not a report of a release action.

The production-session regression supplies the functional proof: its cached
Room refresh receives the same network failure and retains the Room with
`hydrationError === null`. This assertion failed on the original implementation
with the full offline message, then passed after the fix. The same case applies
a 403 and verifies the Room is cleared and its load error remains. The separate
first-load timeout case verifies the error and Retry recovery. The source
contract checks that the painted page has no notice component and the failed
load screen still has its error and Retry.

## Repeat

From `apps/mobile/offline-proof`, start:

```
../node_modules/.bin/expo start --go --port 8197 --max-workers 2
```

On a separately leased Android emulator with Expo Go SDK 55 installed:

```
adb -s emulator-5558 reverse tcp:8197 tcp:8197
adb -s emulator-5558 shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8197 host.exp.exponent
adb -s emulator-5558 exec-out screencap -p > android-after.png
```

To repeat before, use the pre-change `RoomSavedCopyNotice.tsx` from commit
`9a9877062`, import it in the proof and mount it between the header and
transcript with the network-error message shown in the before XML. No before
component is retained in shipped sources.

Run the functional cases from `apps/mobile`:

```
./node_modules/.bin/vitest run 'sources/app/(app)/beeline/chat/useRoomSurfaceSession.test.ts' 'sources/app/(app)/beeline/chat/room-open.design.test.ts' --maxWorkers 1
```
