# App-wide outbox — Reproduction R2

The phone keeps prepared messages in one persisted owner per server and account. Room handles only select its rows. Leaving a Room never disposes delivery. The app restores all Room keys before it flushes on the shared socket's connected event; successful receipts remove records. Replays preserve the client message ID.

## Reproduced

No device is attached to this session, and opening `/dev/kvm` returns `EACCES`. The approved stand-in renders the actual `OrdinaryLedgerMessage` and `ConversationRow` components with the real queue, with native providers replaced by test hosts.

Running the R2 component assertions against the original `RoomMessageVariants.tsx` fails: there is no Sending line, and a refusal renders `Delivery failed` instead of the server's reason. The full earlier send callback also marked every publication error failed and opened the leave-Room modal.

## Demonstrated

The same R2 assertions now render Sending, then `Not sent yet · no connection` at the one-off offline cutoff, then remove the status after reconnect. Refusals render the exact server reason and Dismiss, without Retry or a popup. The Room-row test renders `Not sent: Start with the server PR` after leaving, then clears that preview when the Room is opened while retaining the transcript refusal. [Actual render output](render-output.txt) includes Obsidian and Bone runs.

Queue and runtime tests cover disconnected sends, all-Room reconnect replay, process restart, duplicate IDs and concurrent flushes, reconnect before an old request settles, refusal persistence, unlimited connection-triggered attempts, and migration without a second sender. The runtime test uses the real `MonolithRigTransport` and `monolithPhoneOperation`; only its network boundary is stubbed. No transport or connection-state logic changes here.

The existing server HTTP integration test `treats concurrent retries of the same message write as one successful send` also passes: identical requests both return a success receipt and the database contains one message. A changed payload under that ID remains refused.

## Validation

From `apps/mobile`, run the focused tests for `message-outbox`, `message-outbox-runtime`, `surface-storage.relay-scope`, `surface-storage.upgrade`, `room-message-cell`, `ConversationRow.preview`, `ErrorBanner`, `Ledger`, `Ledger.provisional`, `useRoomSurfaceSession`, `chat.corner-intent-send`, `RoomMessageVariants`, and `monolith-rig-transport` with `npx vitest run ... --maxWorkers=1`.

For the light theme, run:

```sh
BEELINE_OUTBOX_TEST_THEME=bone npx vitest run 'sources/app/(app)/beeline/chat/RoomMessageVariants.test.tsx' -t 'Reproduction R2 rendered outbox path' --maxWorkers=1
```

From the root, run `npm run typecheck` and `npm run lint:ui-components`. The design, calm, and inline-action lint suites pass. The Impeccable detector reports no findings on the changed UI.

This proof validates delivery and rendered text/controls with test hosts. Physical device layout, gestures, and real radio reconnection remain unproved in this session. The connection-state PR is still open, so this implementation uses the existing shared socket's `subscribeConnected` event through the named `onOutboxConnected` hook, as the brief permits.

## CI integration coverage

### R2 observed disconnect regression

The reviewer reproduced a transient send failure while socket diagnostics still reported open, followed by socket loss with no further sends. The runtime regression reproduced the wrong result: `Sending` remained after 120,001 ms. The runtime now subscribes to a notification from the socket's existing transport-loss handler; recovery and connection-state decisions are unchanged. The same regression passes: `Sending` at 119,999 ms, `Not sent yet · no connection` at 120,001 ms, and one successful replay of the same client message ID on reconnect. A further connected event sends nothing. The socket regression also verifies loss notifications and unsubscribe cleanup. The approved R2 component stand-in remains the proof target because no real device is available here.

The Room and layout import paths keep native send transports lazy. Mutation storage lives in `message-outbox-storage.ts`, apart from response caching; the app layout starts its runtime, and Room sessions only select/observe their records. The existing offline, silent-socket, notification-landing, read-mark, and composer-status fixtures follow that interface. Shared-control and error-surface inventories retain the same exceptions with fingerprints for the approved refusal presentation.

After integration with main, all failing CI files pass locally: the targeted unit/render/guard run passes (124 tests), and the real-route notification browser suite passes (18 tests). Mobile typecheck, UI component policy, and the phone network-channel guard also pass; the network allowlist is unchanged.

Repair validation: full mobile suite completed (650 files passed, one file failed, nine skipped; 5,674 tests passed, three failed, 105 skipped). The three failures are unchanged `mobileOtaRelease.test.ts` fixtures for missing EAS builds, EAS listing failure, and APK download failure: the host has `/usr/bin/adb`, which the canary resolves before the fixtures' fake SDK, so they stop at emulator-not-attached instead. The test and canary script match main; no release files were changed. Focused runtime/socket regressions pass (50 tests), Bone R2 rendering passes, mobile typecheck and the network guard pass.

Socket integration: merged main after #3157 moved the operation client to request/reply. Kept both its pending-request fields and the disconnect observers. The runtime regression now stubs the shared socket request boundary, asserting `sendRoomMessage`, the stable client ID and the refusal reason through the real operation client. The affected queue, runtime, socket, operation, transport and R2 render tests pass (251 tests), as do mobile typecheck and the shrunken network guard from main.
