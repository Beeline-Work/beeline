# CHEV disc-chevron and catch-up-sheet proof

These frames are supporting evidence. The executable regressions are
`sources/buzz/room-new-message-boundary.test.ts` (CHEV-01/02/16),
`sources/buzz/room-catch-up-report.test.ts` (CHEV-03/04/05/06/13/15),
`sources/components/buzz/RoomCatchUp.design.test.ts` (CHEV-07…16), and
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
production report seam (`buzz/room-catch-up-report.ts`), the production
palette entry (`buzz/slash-verbs.ts`), and the production inverted `FlatList`
settings. Only the row bodies and the two buttons are stand-ins. The Room
opens with a server cursor at `seed-20`, and what was missed carries a real
open poll, a real pending repository-edit permission whose requester is NOT
its author, and a real mention of the viewer.

## No count in the strip

There is no unread count in this product to print. The server serves
`unread: boolean` per Room (`phone-service.ts:1147`); the client's
`NewMessageQueue.count` resets on every Room open, so it only ever knows about
arrivals during the current visit; and the session marks a Room read at its
tail on the first fresh view (`useRoomSurfaceSession.ts:891`). So the strip
dates the run — `New since 07:40 · Catch me up` — and the sheet head names the
window by its two ends. `catchUpStripLabel` carries one `unreadCount` seam for
a server-supplied number; nothing feeds it, and nothing may feed it a count
derived from loaded rows.

The badge is unchanged and keeps its count, because that count is honest: it
only ever claims arrivals during this visit, and it caps at `9+`.

## Frames

`01-history-disc-no-badge.png` — the reader is in history with nothing new
since they arrived. The 44pt disc is up with no badge, and the strip sits
under the Room header because the server cursor is set.

`02-strip-dates-the-run.png` — two messages arrive during the visit. The badge
reads `2`; the strip still reads `New since 07:40 · Catch me up`, unchanged,
because arrivals the reader can see are not what it describes.

`03-badge-cleared-by-visibility.png` — the reader scrolls to the tail under
their own finger, no press on anything: `badge: none`. The strip stays, since
only the session's own markRead clears the cursor it stands for.

`04-sheet-from-strip.png` — the strip is the visible door. One tap opens the
bottom-anchored sheet: head `Catch up` / `Since 07:40 · newest 09:02`, then
SUMMARY (`From Milo, Sol (@sol) and 2 others. 1 poll opened, you were
mentioned once.` — who, never how many), then NEEDS YOU as ONE list:
`Ship Friday?` / `Niglet · 07:44`, `Repository edit waiting on you: beeline` /
`lunchboxfortwo · 08:00`, `can you take the disc offset one?` / `Nerd · 09:02`.
Two blocks, no third, no control but dismissal.

`05-disc-tap-lands-at-newest.png` — a SHORT press on the disc lands on the
tail and opens nothing.

`06-sheet-closed-before-long-press.png` / `07-sheet-from-badge-long-press.png`
— the long-press door, shown against a verified-closed sheet first (badge
still `2`), then a 900ms press on the badge alone opening the sheet. The
screen-reader equivalent is the registered `catchUp` accessibility action on
the same control, which a screenshot cannot show; it is pinned in
`RoomCatchUp.design.test.ts` (CHEV-09).

`08-sheet-from-catch-up-verb.png` — the third door. The row carries the
production palette entry verbatim (`/catch-up — See what you missed`) and
opens the same report: `door: /catch-up verb`.

The `lunchboxfortwo · 08:00` line is the attribution fix: that card is authored
by the agent `Sol (@sol-two)` and names its requester by pubkey, so
attributing it to its author put the agent's name against a decision a person
had asked for.

## The arrival flash

Frames `10`–`14` come from a second pass of the same proof entry, mounting the
production row cell (`buzz/room-message-cell.tsx`), the production flash rule
and timing (`buzz/room-arrival-flash.ts`), and the production
landing-completion shape: the flash is raised from the viewability report that
confirms the row is on screen, exactly as `completePendingNewMessageLanding`
raises it. Only the row bodies and the two landing buttons are stand-ins.

`10-arrival-flash-on-landing.png` — a notification landing on `seed-8`
completes and the row it pointed at carries a `bgHighlight` ground fill:
`landed: seed-8 · flashing: seed-8`. Area, no stroke, and the row's own layout
is untouched — the fill is behind its content.

`11-arrival-flash-cleared.png` — one cycle later the fill is gone, with no
repeat.

`12-ordinary-landing-no-flash.png` — an ordinary landing on `seed-16`
completes with no anchor behind it: `landed: seed-16 · flashing: none`. A
highlight on every Room open would be wallpaper, and the NEW MESSAGES divider
already says where the unread run starts.

`13-arrival-flash-reduce-motion-hold.png` /
`14-arrival-flash-reduce-motion-cleared.png` — the same landing with
`animator_duration_scale 0` (what Android reports to
`AccessibilityInfo.isReduceMotionEnabled`). The fill still HOLDS — degrading to
no flash at all would take the pointer from the readers most likely to need it
— and then clears outright instead of fading. The device setting was restored
after capture.
