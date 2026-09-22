# UDIV unread-divider proof

These frames are supporting evidence. The executable regression for the same
three failures is `sources/buzz/use-new-message-control.test.tsx`, which mounts
the production hook and the production divider cell and makes each one happen;
start there.

Captured on Android API 30 (`emulator-5554`) against this branch's JavaScript,
loaded into the installed `app.usebeeline` development client over Metro
(`beeline://expo-development-client/?url=http://localhost:8081`). The Room
transcript itself needs a signed-in account, which this environment does not
have, so the frames come from a temporary proof entry at
`sources/app/(app)/udiv-proof.tsx`, opened with `beeline://udiv-proof` and
removed after capture — the same method as `evidence/scroll01`.

The proof entry is not a re-implementation of the fix. It mounts the production
inverted `FlatList` with the production `maintainVisibleContentPosition`
settings, the production divider cell (`buzz/room-message-cell.tsx`, which owns
where the `NEW MESSAGES` line paints), and the production hook
(`buzz/use-new-message-control.ts`) that `_chat-surface.tsx` itself consumes.
Only the row bodies are stand-ins. The `BEFORE` column is a reconstruction of
the replaced state machine — one queue feeding both the divider and the
control, clearable only by a tap:

| | BEFORE | AFTER |
| --- | --- | --- |
| divider | `queue.boundaryId ?? firstUnreadMessageId` | `control.dividerMessageId` |
| control | `queue.count > 0 && queue.boundaryId` | `control.controlVisible` |
| clears when | the control is tapped | the newest row becomes visible |

The Room is seeded fully read, so the server's opening cursor is null and no
divider may legitimately exist for the whole capture.

## Frames

`before-divider-at-newest.png` — UDIV-03. Reader sits 60px off the tail with
the newest row on screen; one agent-activity row arrives; reader returns to the
tail. A `NEW MESSAGES` divider is now painted at the bottom of the transcript
with nothing under it, because the divider was dragged onto the arrival and
that arrival's body is a bare activity strip. The header reads `divider bound
to: arrival-30`. This is the frame the report showed.

`after-no-divider-at-newest.png` — the same sequence on this branch.
`divider bound to: nothing`; the opening cursor still owns the line, and there
is no line to own.

`before-pill-stuck-at-tail.png` — UDIV-01. Reader is at offset 0 with
`Arrived message 30` fully on screen, and the `1 new` control is still shown.
Nothing but a tap on the control could clear the count, so scrolling back to
the tail under your own finger left it sitting over a Room you had caught up
on.

`after-pill-armed-in-history.png` / `after-pill-cleared-at-tail.png` — the same
sequence on this branch. The control still arms while the arrival is off screen
(offset 798px, visible `seed-19 → seed-23`), and the reader's own scroll back to
the tail settles it (visible `seed-27 → arrival-30`, control gone) without a tap.
