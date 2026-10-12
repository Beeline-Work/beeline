# Shared-browser activity stays quiet

Browser input, scrolling, navigation, opening/closing the keyboard, and handback provide context for the sharing agent's next turn. They do not request a turn. `recordComputerActivity` in `apps/server/src/computer-session.ts` retains the existing activity-only records without naming wake targets. `backfillComputerObservations` cancels pending browser-activity commands from previous releases; commands sourced from sent human messages and already claimed turns remain intact. The event catalog describes the same contract.

The shared viewer dock keeps unsent text inside the composer and ignores incoming Room replies until a message has been sent from that viewer. Replies from the addressed agent retain the existing transcript/ticker behavior, including replies arriving before the send RPC returns. The collapsed pill is 44 × 44 logical pixels around its 42 × 42 control, allowing for its one-pixel border on each side.

## Phone evidence

Captured on 2026-10-12 on the task-owned Android emulator, launched with `-read-only -port 5584`. Every adb operation targeted `emulator-5584`. The Expo Go harness rendered the shipped `ViewerConversationDock`, `ConversationComposer`, and `ViewerConversationRing`, with their actual theme values. Peripheral speech, attachment dialogs, and the inactive spinner were stubbed; the harness used a fixed screenshot capture result for sending. This is native component evidence, rather than a store-release binary test.

- [Centered circle](../evidence/viewer-no-wakes/centered.png): at 1080 × 2400 screen pixels, the outer-border extrema have center `(990.5, 1979.5)` and gold extrema have center `(991.0, 1979.5)`. The measured offset is `(0.5, 0.0)` screen pixels, within raster rounding. [Measurement](../evidence/viewer-no-wakes/centering.json).
- [Keyboard open](../evidence/viewer-no-wakes/keyboard-open.png) and [keyboard closed](../evidence/viewer-no-wakes/keyboard-closed.png): opening the streamed page's keyboard button focuses its `keys` input, not the native composer. Both frames have no transcript. The native keyboard events reported open (288.38 logical pixels) followed by closed. [Events](../evidence/viewer-no-wakes/native-events.jsonl).
- [Sent composer message](../evidence/viewer-no-wakes/sent-message.png): the transcript appears after the native composer sends “Please check this screen”.

## Live session trace

The proof ran against an isolated local Workspace named **Beeline Review**, using the changed server's real `PhoneService`, computer-session HTTP/WebSocket handlers, PGlite database, and an actual dedicated Chromium tab. A local Squire-compatible provider adapter forwarded viewer input to Chromium and relayed its screenshots and main-frame navigation notifications. Browser inspection and keyboard-button activation used task-scoped `chrome-devtools-axi` connections. No production Workspace or shared helper was touched. This proves Beeline's behavior with the provider protocol; it does not claim a production Squire broker test.

The sequence clicked the page input, scrolled 100 pixels, typed “review browser input” into that input, clicked Continue to navigate to `/destination`, then handed control back. Chromium inspection confirmed the entered value, scroll position, and final destination. [The activity trace](../evidence/viewer-no-wakes/activity-without-wakes.json) records pointer, scroll, typing, navigation, and handback with **zero agent commands**. [The subsequent composer trace](../evidence/viewer-no-wakes/composer-send-trace.json) contains exactly **one pending `human_tag` command** after the native composer message. The [keyboard-open](../evidence/viewer-no-wakes/keyboard-open-trace.json) and [keyboard-closed](../evidence/viewer-no-wakes/keyboard-closed-trace.json) traces also contain zero commands.

## Regression checks

The new server and mobile assertions failed against the original behavior before the fix. Final verification passed:

- Root `npm run typecheck`.
- Server computer-session and system-line contract suites: **19 tests**. Real stream input/navigation/handback stays quiet; a normal sent message creates and claims one command; navigation remains available in the next Room read; migration cancels old browser wakes while preserving sent-message commands.
- Mobile ViewerConversationDock, ComputerSession, design lint, and calm lint suites: **43 tests**. Keyboard show/hide leaves the composer collapsed and transcript hidden; unsent edits and unrelated replies do not reveal it; sent messages and fast replies still appear.
- Shared api-contract suite: **465 tests**.

All proof browser processes, the local fixture server, Metro, and emulator-5584 were stopped after capture.
