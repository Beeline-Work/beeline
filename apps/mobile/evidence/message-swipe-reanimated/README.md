# Android message swipe return

Reproduction SWIPE-ANDROID-2: short left drag released below the reply threshold;
then a diagonal drag that yields to vertical transcript scrolling. The owner
reported a translated message with REPLY exposed and no composer quote.

The freeze did **not** reproduce in the before attempts. Both legacy attempts
returned to rest without a quote. The second case visibly scrolled the list
330 pixels. These captures do not establish the hypothesized native-driver
failure as the cause of the owner's screenshot.

Before and after used Android API 36, new architecture, 1080×2400 at 420 dpi,
a local debug APK, and the shipped OrdinaryLedgerMessage component in a scrolling
native fixture. This is a component replay, not a signed-in production Room;
there was no production session on the fresh emulator. Before used the existing
transcript-dividers-native-proof reply screen plus a scroll continuation.
After uses `scripts/message-swipe-native-proof.tsx`, which also paints the alive
ring. The video artifacts are attached to the corner report.

| Gesture | Before | After |
| --- | --- | --- |
| Short left drag, held before release | Rest; no quote | Rest; no quote |
| Diagonal drag yielding to vertical scroll | Rest; list scrolled; no quote | Rest; list scrolled; no quote |
| Normal left reply | Not captured | Quote installed; row at rest |
| Normal right corner | Not captured | Corner callback fired; row at rest |

Raw results: [before.json](before.json), [after.json](after.json). Screenshots in
this directory show both canceled cases and both committed after cases. The
corner panel is hidden at rest, and the alive ring remains fully visible.
The Room-list and Needs You legacy swipeables are unchanged: the same freeze
was not established there. No separate reproduction was attempted on those
surfaces; the brief permits their migration only after reproducing that freeze.
No iOS verification was performed.

## Repeat the native regression

Build a new-architecture Android debug app from `apps/mobile`, loading
`scripts/message-swipe-native-proof.tsx` instead of the normal entry (with the
random-values polyfill first). Use the normal app Metro configuration and a
1080×2400/420dpi emulator. If dependencies are mounted read-only, use a writable
copy for the Android build; Gradle writes inside native dependency packages.
Exclude Android `.cxx` and `build` directories from that proof server's watcher.

Open the fixture fresh with the keyboard dismissed and the list at the top:

```sh
python3 scripts/message-swipe-android-test.py after /tmp/message-swipe-proof
```

The regression asserts zero horizontal displacement after a below-threshold
release and the scrolling interruption, no quote for either cancellation,
actual vertical scrolling, and the expected reply/corner receipts with the
row back at rest. It writes screenshots, UIAutomator XML, and JSON results.
It requires the leased `emulator-5554`; no network or production writes occur.
