# Android Room update-depth loop

Reproduction **UPDATE-DEPTH-1**: open a Room with a cached message whose author
has a newer identity rename. Message notifications refresh the Room's turn
selection, so `useRoomSurfaceSession` selects identities again. That selection
creates an equal message object; `useRoomMessageRecords` accepted it as a change
and notified subscribers from its layout effect indefinitely.

The fix retains the existing record when the incoming value, after bookmark and
feedback reconciliation, is deeply equal. Changed server values still replace it.
Rows already offered are still skipped by the existing `seenRows` weak set.

## Symbolication

Sentry issue: [BEELINE-MOBILE-A](https://beeline-bt.sentry.io/issues/7803536337/),
event `d28b5cf4177f4e15b6e5874caa89c920`, release
`6e51856d5c76b1ba1c0df948c0aaf10e2f0ba6fb`.

The release was checked out separately and its shared packages compiled. Export:

```sh
cd apps/mobile
node node_modules/expo/bin/cli export --platform android --source-maps --max-workers 2 --output-dir /tmp/jellybean-depth-export
```

This uses the same production Expo/Hermes export underlying `eas update` in the
OTA pipeline; it does not publish anything. Rebuilt offsets differ from the
release, so applying the original columns directly to that map is incorrect.

Retrieved the shipped bundle through the manifest for Android update
`01a15076-73a4-781b-93ca-084f9a24ce55` (runtime 39), whose Expo metadata records the
exact release SHA. Shipped SHA-256:
`da7e5b4ab081a416d1c5fe3614a8a8a70fbcb0b4c06f68069997ff08dd6137a3`.
Rebuilt SHA-256:
`e9b401d9a3fd11820c98a5649a421890390e0443f44dd7ed66cd6962343dd03c`.
Neither bundle nor its temporary asset authorization headers are committed.

Both bundles are Hermes bytecode version 96. Disassembled each with
`hermesc -b -dump-bytecode`. The shipped target functions have **identical
disassembly** to the corresponding rebuilt functions. Their sizes and the
frame's offset within each function agree:

| Frame | Shipped function / start / size | Rebuilt function / start / size | Frame offset | Rebuilt column | Source (zero-based column) |
| --- | --- | --- | --- | --- | --- |
| `notify`, col 2764394 | 21432 / 2764337 / 71 | 21609 / 2784370 / 71 | 57 | 2784427 | `sources/buzz/room-message-records.ts:30:54` |
| layout callback, col 2768163 | 21462 / 2768132 / 39 | 21639 / 2788165 / 39 | 31 | 2788196 | `sources/buzz/room-message-records.ts:200:53` |

Starts are Hermes virtual bytecode offsets: the cumulative function bytecode
sizes, matching `x_hermes_function_offsets` in the rebuilt source map. Preserve
the per-function frame offset when translating, then resolve with
`@jridgewell/trace-mapping.originalPositionFor`. No global offset assumption is
needed. The same check identifies the React frames as `getRootForUpdatedFiber`,
`enqueueConcurrentRenderForLane`, `forceStoreRerender`, its subscription callback,
and `commitHookEffectListMount`.

Screen: `sources/app/(app)/beeline/chat/_chat-surface.tsx`, which consumes
`useRoomSurfaceSession` and `useRoomMessageRecords`. The desktop Room inspector
also shares this message store.

## Reproduced

The rendered-hook regression in `room-message-records.test.tsx` runs the
production turn/message hooks and `IdentitySelection` with the Room session's
memo dependencies. Before the fix it throws **Maximum update depth exceeded**
at `notify` line 30 and the layout callback line 200, matching the production
stack. The other 14 existing message-record tests pass before the fix.

## Demonstrated

With the fix, the regression settles in fewer than ten renders, displays the
renamed author, accepts a real version-2 message edit, and displays a second
rename while preserving that edit. All 81 tests across the Room surface session,
message records, frame budget, and final-message paint pass. Root
`npm run typecheck` passes.

The full signed Beeline app was not available locally; the public
`https://usebeeline.app/dl/beeline-android.apk` returned HTTP 404. Native proof
therefore uses `update-depth-proof` in Expo Go on the leased Android API 36
emulator. This is a Room harness exercising the production stores and identity
selection, not the full authenticated chat screen or its transport.

To run the same before/after native path:

```sh
cd apps/mobile/update-depth-proof
git show 6e51856d5c76:apps/mobile/sources/buzz/room-message-records.ts > .before-store.ts
UPDATE_DEPTH_BEFORE=1 CI=1 node ../node_modules/expo/bin/cli start --go --port 8093 --max-workers 2
# Open exp://127.0.0.1:8093 in Expo Go after adb reverse tcp:8093 tcp:8093.
# Tap Open Room. Stop Metro, then run the fixed store:
CI=1 node ../node_modules/expo/bin/cli start --go --port 8094 --max-workers 2
# Reverse 8094, open its URL, tap Open Room, then Edit message.
```

The before-store file is generated locally and ignored by git. The native
harness uses the same identity/turn dependency cycle as the regression; its
boundary leaves the original update-depth error visible.

Native before: the same Room open reaches 52 renders and shows the update-depth
error at `notify`, line 30. Native after: the Room opens in two renders and the
message edit paints in the third render. Captures:
[before](before.png), [after opening](after-open.png), [after editing](after-edit.png).
