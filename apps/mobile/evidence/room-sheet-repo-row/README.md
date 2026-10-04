# Repository row: flat, like its siblings

Component screenshots (React Native Web, through the real component tree) of
the Room header sheet's Repository row and New Room's own Repository field,
before and after this change. Fixes the captain's report: the Repository row
rendered in a bordered box while Reviewer, Repo notifications, Members,
Workflows and Scheduled work render as flat rows parted by one hairline
(`HullActionSheet.tsx`'s own doc comment: "a row never wears a box"). New
Room's own Repository field had the same box against its own form siblings
(Name's hairline rule, Public's row), and Public itself hand-rolled a
label+switch row instead of matching that rhythm.

## Room header sheet

- `room-sheet-before.png` — Repository boxed above the flat Reviewer / Repo
  notifications / Members / Workflows / Scheduled work rows.
- `room-sheet-after.png` — Repository is now the same `HullActionSheetRow` as
  its siblings: same padding, same label weight, parted by a hairline, no
  box.

Regenerate both `*-after.png` images from the repository root, after
installing the mobile dependencies and building `@beeline/nostr`,
`@beeline/api-contract` and `@beeline/buzz-client`:

```sh
node apps/mobile/scripts/render-room-sheet-repo-row-proof.mjs
TMPDIR=/var/tmp google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=3000 --window-size=390,844 --screenshot=apps/mobile/evidence/room-sheet-repo-row/room-sheet-after.png "file://$PWD/.verification/room-sheet-repo-row/room-sheet.html"
TMPDIR=/var/tmp google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars --allow-file-access-from-files --virtual-time-budget=3000 --window-size=390,844 --screenshot=apps/mobile/evidence/room-sheet-repo-row/new-room-after.png "file://$PWD/.verification/room-sheet-repo-row/new-room.html?stop=N1"
```

`NewRoomDialog.repo-row.browser.test.ts` and `RoomRepositoryChoice.browser.test.ts`
run each proof script's full walk (reveal, Link, Create mode, owner menu)
headlessly in CI, asserting on the rendered text at every step.

`room-sheet-before.png` and `new-room-before.png` are not regenerable from
this branch — they were captured from the revision before this fix, for
audit purposes.

## New Room

- `new-room-before.png` — Name (hairline rule) → Repository (box, further
  indented, dimmer label) → Public (flat, no divider at all).
- `new-room-after.png` — Name, Repository and Public now read as one even
  list, each parted by a single hairline, same label weight throughout.

## What changed

`RoomRepositoryChoice.tsx` and `NewRoomDialog.tsx` each now render their own
flat, unboxed collapsed Repository row (`HullActionSheetRow` in the Room
sheet; a local row in New Room, so it doesn't double New Room's own 24px form
inset) instead of delegating to `RepositoryChoice`'s old boxed collapsed
state. `RepositoryChoice` itself now only ever renders its revealed
None/Link/Create switch — the collapsed branch, and the `revealed` /
`onReveal` / `collapsedValue` props it alone used, were removed as dead code.
That switch (and New Room's Create-mode owner chip) stays legitimately boxed:
DESIGN.md's Shape rule boxes a control the user is actively editing, not a
resting display row. New Room's Public row was restyled to the same
`body`/`textPrimary` label and hairline-row contract as Repository, instead
of its own `meta`/`textSecondary` label with no divider.
