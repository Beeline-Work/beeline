# CHEV disc-chevron and catch-up-sheet proof

These frames are supporting evidence. The executable regressions are
`sources/buzz/room-new-message-boundary.test.ts` (CHEV-01/02/03),
`sources/buzz/room-catch-up-report.test.ts` (CHEV-04/05/06),
`sources/components/buzz/RoomCatchUp.design.test.ts` (CHEV-07…11), and
`sources/buzz/use-new-message-control.test.tsx`, which mounts the production
hook through the same transitions; start there.

Captured on Android API 30 (`emulator-5554`) against this branch's JavaScript,
loaded into the installed `app.usebeeline` development client over Metro
(`beeline://expo-development-client/?url=http://localhost:8081`). The Room
transcript itself needs a signed-in account, which this environment does not
have, so the frames come from a temporary proof entry at
`sources/app/(app)/chev-proof.tsx`, opened with `beeline://chev-proof` and
removed after capture — the same method as `evidence/udiv`.

The proof entry is not a re-implementation. It mounts the production hook
(`buzz/use-new-message-control.ts`), the production controls and sheet
(`components/buzz/RoomCatchUpControls.tsx`, `RoomCatchUpSheet.tsx`), the
production report seam (`buzz/room-catch-up-report.ts`), and the production
inverted `FlatList` settings. Only the row bodies and the RECEIVE button are
stand-ins; the three arrivals carry a real open poll, a real pending
repository-edit permission, and a real mention of the viewer, so Needs you is
populated the way a Room populates it, and two of the three speakers are
distinct identities sharing one display name. The readout line prints the
hook's outputs verbatim.

| | pill (before) | disc + sheet (this branch) |
| --- | --- | --- |
| shows when | unread mail is off screen | the newest row is off screen |
| press lands at | the first unread message | the newest message |
| count clears | on a press | at the newest row; the disc stays |
| what you missed | `9+ new` | a strip, and the sheet behind it |

## Frames

`01-history-disc-no-badge.png` — the reader scrolls up into history with
nothing new waiting. `disc: shown · badge: none`, and the 44pt disc is on
screen beside `Seed message 14`. The pill showed nothing here at all.

`02-badge-and-strip-in-history.png` — three messages arrive below the fold
while the reader stays in history. The badge reads `3` on the disc's corner and
the strip under the Room header reads `3 new messages from Sol (@sol), Sol
(@sol-two) and 1 …`, ellipsized because the strip is one line by design. Two
of those three speakers are DIFFERENT people who share the display name `Sol`:
the roll counts them by identity and tells them apart by handle. Deduplicating
display names — what the strip did before — would have counted them as one and
undercounted how many the reader is behind on.

`03-badge-cleared-by-visibility.png` — the reader scrolls back to the tail
under their own finger, no press on anything. The three arrivals are on screen
and the readout reads `badge: none`.

`04-sheet-from-strip.png` — the strip is the visible door. One tap opens the
bottom-anchored sheet: head `Catch up` / `3 msgs · 07:44–09:02`, then SUMMARY
(`3 messages from Sol (@sol), Sol (@sol-two) and 1 other. 1 poll opened, you
were mentioned once.` — the same roll the strip used, from the same module),
then NEEDS YOU as ONE list — `Ship Friday?` / `Niglet · 07:44`, `Repository
edit waiting on you: beeline` / `Sol · 08:00`, `can you take the disc offset
one?` / `Nerd · 09:02`. Two blocks, no third, no control but dismissal.

`05-disc-tap-lands-at-newest.png` — a SHORT press on the disc still lands on
the tail and opens nothing: the newest row is the last on screen and the sheet
stays closed.

`06-sheet-closed-before-long-press.png` / `07-sheet-from-badge-long-press.png`
— the long-press door, shown against a verified-closed sheet first
(`sheet: closed`, badge still `3`), then a 900ms press on the badge alone
reopening the same sheet. The screen-reader equivalent is the registered
`catchUp` accessibility action on the same control, which a screenshot cannot
show; it is pinned in `RoomCatchUp.design.test.ts` (CHEV-09).

`08-catch-up-verb-closed.png` / `09-sheet-from-catch-up-verb.png` — the third
door. The row carries the production palette entry verbatim (`/catch-up — See
what you missed`, from `buzz/slash-verbs.ts`); pressing it runs the same
`openCatchUpSheet` the surface's `case 'catch-up'` now runs, and the readout
reads `door: /catch-up verb` over the same `3 msgs · 07:44–09:02` report. The
verb scrolled to the first unread row before this.

Frame `09` also carries the attribution fix: the repository-edit row reads
`lunchboxfortwo · 08:00`, the person who ASKED for the edit. That card is
authored by the agent `Sol (@sol-two)` and names its requester by pubkey, so
attributing it to its author — what the sheet did before — put the agent's
name against a decision a person had asked for.
