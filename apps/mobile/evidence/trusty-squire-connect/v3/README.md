# Locked mock v3: built Android evidence

The comparison board places each built screen beside its matching approved mock tab.
The screenshots and video come from a release APK on the corner's Android API 36 emulator,
using `scripts/trusty-squire-native-proof.tsx` and its existing Metro adapters.

This is a **fixture state replay**, not a live sign-in or enrollment. Deep links select
helper states between screens. Chrome opens only an invalid example address. The final
connected row uses a separate fixture state; the recording does not prove a real account
became connected. The screen regression test separately verifies that returning from
Chrome refreshes the install and routes automatically when the server reports connected.
Owner-phone proof on the owner's enrolled helper remains deferred until after release.

| Approved tab/state | Android screenshot |
| --- | --- |
| Trusty Squire | service.png |
| Reaching squire | reaching.png |
| Reaching squire after one minute | timeout.png |
| Pairing | pairing.png |
| Ready to sign in | ready.png |
| Google sign-in loading | loading.png |
| Google sign-in failure | error.png |
| After Chrome | finishing.png |
| Connected row | connected.png |

`mock-v3-comparison.html` is self-contained. `flow-with-timeout.mp4` includes the entire
real minute of reaching, with no clock changes or time compression, before the stopped
state appears. The remaining screen states follow in the same recording.

## Reproduction pairing-progress / squire-spinner

Before: the owner's production screenshots in the parent evidence directory show an
unordered checklist with no total, a raw tunnel address and a disabled Reconnecting row.
After: the release fixture shows four fixed steps, the running step, a disabled sign-in
button until ready, the readable error and two full-width recovery actions. Holding the
helper state at reach for a real minute produces the red first segment, stopped mark,
complete timeout message and Try again button.

## Repeat the Android proof

Use the parent runbook's temporary Metro adapter and native entry settings. Build with:

```sh
./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --max-workers=2 -Dorg.gradle.jvmargs=-Xmx4g
```

Install on the selected corner emulator. Force-stop between fixture states, then launch
`beeline://proof?screen=<state>`. Wait for the native splash to finish before capturing.
States are `service`, `pair-start`, `pair-pairing`, `pair-signin`, `signin` and
`service-signed-in`. On `pair-start`, wait at least sixty real seconds. On `signin`,
capture loading, wait for the fifteen-second load error, tap Open in browser, then return
to capture Finishing sign-in. Never enter credentials. The native build and Metro entry
changes are temporary and are restored before delivery.

## Validation

- Root `npm run typecheck`: passed.
- Affected screen/workbench and design suites: all passed (108 tests).
- Shared UI registry policy against the PR base: passed.
- Android release fixture build: passed.
- No iOS verification or real Google sign-in.

## Reproduction squire-browser-fallback

The reviewer found a second timeout path on head `b6565aea`: let the completion
deadline expire, choose Open in browser, and return with `connected=false`.
The error cleared but the completion timer did not restart, leaving Finishing
sign-in visible indefinitely.

Recreated against the production screen in headless Chrome because the reviewer's
temporary proof files were absent here. The checked-in browser proof uses a pending
install response and compresses the two-minute completion timer to 1.2 seconds;
it does not perform a real Google sign-in. Before the fix its output showed
`initialTimeout=true`, `firstFinishing=true`, `firstRecovered=false`.
After the fix both `firstRecovered` and `secondRecovered` are true, with Try again
and Open in browser visible after each deadline. A third fallback receives a
connected install event and navigates automatically to the Trusty Squire page.
The renderer tests exercise the same sequence with the unchanged production
deadline and an AppState return.

Run from `apps/mobile`:

```sh
npx vitest run 'sources/app/(app)/beeline/settings/workbench/connect-signin.test.tsx' sources/test/squire-browser-fallback.browser.test.ts
```

Spinner audit: helper reach stops after one minute; subsequent active pairing
steps stop after two minutes; streamed page loading stops after fifteen seconds;
service loading is bounded by the shared Workbench read. Helper discovery had a
second gap: its loader stayed visible alongside the failed-read message. It now
stops when that bounded read fails, covered in `connect.test.tsx`.
No mock layout or copy changes accompany these corrections.
