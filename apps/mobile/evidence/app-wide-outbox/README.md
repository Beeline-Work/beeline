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
