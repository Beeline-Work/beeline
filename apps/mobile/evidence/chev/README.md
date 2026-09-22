# CHEV disc-chevron proof

These frames are supporting evidence. The executable regressions are
`sources/buzz/room-new-message-boundary.test.ts` (CHEV-01/02/03) and
`sources/buzz/use-new-message-control.test.tsx`, which mounts the production
hook and asserts the disc, the badge and the strip through the same
transitions; start there.

Captured on Android API 30 (`emulator-5554`) against this branch's JavaScript,
loaded into the installed `app.usebeeline` development client over Metro
(`beeline://expo-development-client/?url=http://localhost:8081`). The Room
transcript itself needs a signed-in account, which this environment does not
have, so the frames come from a temporary proof entry at
`sources/app/(app)/chev-proof.tsx`, opened with `beeline://chev-proof` and
removed after capture — the same method as `evidence/udiv`.

The proof entry is not a re-implementation. It mounts the production hook
(`buzz/use-new-message-control.ts`), the production control component
(`components/buzz/RoomCatchUpControls.tsx`) that `_chat-surface.tsx` renders,
and the production inverted `FlatList` settings. Only the row bodies and the
RECEIVE button are stand-ins. The readout line at the top prints the hook's
three outputs verbatim.

| | pill (before) | disc (this branch) |
| --- | --- | --- |
| shows when | unread mail is off screen | the newest row is off screen |
| lands at | the first unread message | the newest message |
| count clears | on a tap, or at the newest row | at the newest row; the disc stays |
| what you missed | `9+ new` | a strip naming the count and the authors |

## Frames

`01-history-disc-no-badge.png` — the reader scrolls up into history with
nothing new waiting. `disc: shown · badge: none · strip: hidden`, and the disc
is on screen beside `Seed message 11`. The pill showed nothing here at all.

`02-arrivals-badge-and-strip.png` — three messages arrive below the fold while
the reader stays in history. The badge reads `3` on the disc's corner and the
strip reads `3 new messages from Sol and Nerd` across the top of the
transcript.

`03-badge-cleared-by-visibility.png` — the reader scrolls back to the tail
under their own finger, no tap on anything. `Arrived message 2 from Sol` is on
screen and the readout reads `badge: none · strip: hidden`.

`04-before-disc-tap.png` / `05-after-disc-tap-at-newest.png` — two more arrive
while the reader is back in history (`badge: 2`), and one tap on the disc lands
on the tail itself: `Arrived message 4 from Nerd` is the last row on screen,
badge and strip both retired. The pill landed on the first unread row instead.

`06-strip-tap-lands-at-first-missed.png` — the strip's own landing, which is
the pill's old one: tapped after three further arrivals, it lands at the start
of the run the reader missed. The whole tail of that run fits on screen after
the landing, so the newest row is visible and the disc retires with it.
