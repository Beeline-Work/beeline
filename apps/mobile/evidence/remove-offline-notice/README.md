# Remove the page offline notice

Reproduction page-offline-1: open a cached Room, then fail its pending refresh
with `TypeError: Network request failed`. Before, the production page renders
“Offline — showing the last saved response” above its transcript. After, the
same transcript remains visible without a notice. A refresh failure never
established that the device was offline.

## Production rendering path

`offline-proof/index.js` mounts the actual Expo Router page
`sources/app/(app)/beeline/chat/[channelId].tsx`. That mounts the real
`useRoomSurfaceSession` and `BuzzChatSurface`. The real refresh scheduler,
message projection and records, header, FlatList, message cell, ordinary Ledger
message, failed-load screen and Retry button all run unchanged.

There is no handwritten conversation UI. The bottom proof-driver controls
only reject the server-boundary promise, start a fresh cold visit, or make the
next server read succeed. The fixture is a valid RoomView with synthetic ids;
no signed-in account or production server is needed.

`boundaries.cjs` is shared by the Vitest rendered-page regression and native
Metro proof. Adapters replace identity, cache persistence, HTTP/live delivery,
notifications, navigation context, voice and unused profile/management screens.
The native proof adapts Unistyles and animation runtime to Expo Go; styles
resolve the real Bone/Obsidian tokens. Its SVG dependency matches Expo Go SDK
55 so actual glyphs and identity marks render. These adapters are not shipped.
Node replaces native hosts with react-test-renderer hosts; it still renders the
same production page and session.

## Regression

`offline-page.render.test.tsx` opens the cached production page, confirms its
transcript text, rejects the real pending refresh request, then reads rendered
Text children and verifies the transcript remains with no notice. Its second
case starts without cached content, verifies the rendered production
`room-hydration-error` screen, makes the server available and presses the
production Retry button, then verifies the transcript and removal of the error
screen.

`regression-before.txt` records the exact new test against the pre-fix page and
session from `9a9877062`: the cached-page case fails on the rendered offline
message while the first-load/Retry case passes. The same test passes on the fix.

No open PR covered the notice when work began. Mobile and web share the
production surface, so both lose the component. There was no dedicated
connectivity listener: this notice came from the Room refresh error callback.
Shared socket/cache logic, outbox, send retries and failed-load handling remain.

## Verified Android results

Android 36, separately leased emulator-5558, 1080×2400. The capture script
passed all three native assertions in both themes. The top-right Expo Go tools
and the bottom proof driver are not shipped app UI.

| Theme | Before | After refresh failure | Failed initial load | After production Retry |
| --- | --- | --- | --- | --- |
| Obsidian | [PNG](obsidian-before.png) | [PNG](obsidian-after.png) | [PNG](obsidian-after-failed-load.png) | [PNG](obsidian-after-retry-recovered.png) |
| Bone | [PNG](bone-before.png) | [PNG](bone-after.png) | [PNG](bone-after-failed-load.png) | [PNG](bone-after-retry-recovered.png) |

Each PNG has a matching XML hierarchy from the same capture. Only Android was
exercised; iOS was excluded. The prior handwritten scene and its screenshots
have been replaced.

Validation: 83 tests pass across rendered page, session, source contract,
shared browser proof, button palette guard, Design lint and Calm lint
(`regression-after.txt`). Root `npm run typecheck`, `npm run lint:ui-components`
and `git diff --check` pass.

## Android repeat

Use a separately Beeline-leased Android emulator and Expo Go SDK 55. From the
repository root install the proof-only compatible SVG package:

```
npm install --prefix apps/mobile/offline-proof --ignore-scripts --legacy-peer-deps
```

Set `offline-proof/settings.js` to `obsidian` or `bone`. From
`apps/mobile/offline-proof` start:

```
../node_modules/.bin/expo start --go --port 8197 --max-workers 2
```

Select the leased emulator explicitly, then launch and capture from the root:

```
adb -s emulator-5558 reverse tcp:8197 tcp:8197
adb -s emulator-5558 shell am start -W -S -a android.intent.action.VIEW -d exp://127.0.0.1:8197 host.exp.exponent
python3 apps/mobile/offline-proof/capture.py emulator-5558 obsidian-after --retry
```

The capture script waits for the production transcript, taps Fail refresh,
asserts the transcript remains with no notice and saves PNG/XML. With `--retry`
it also starts a cold visit, asserts the production load error, captures it,
then makes the server available and taps the production Retry button, asserting
and capturing the recovered transcript. It dismisses only Expo Go's developer
menu if shown. Repeat with Bone and an appropriate output name.

For before, temporarily restore `_chat-surface.tsx`, `useRoomSurfaceSession.ts`
and `RoomSavedCopyNotice.tsx` from `9a9877062`, relaunch, and pass
`--expect-notice` to the same capture script. Restore the fix afterward. Both
before and after use the same route, fixtures, adapters and failure action.

Run the rendered regression from `apps/mobile`:

```
./node_modules/.bin/vitest run 'sources/app/(app)/beeline/chat/offline-page.render.test.tsx' --maxWorkers 1
```
