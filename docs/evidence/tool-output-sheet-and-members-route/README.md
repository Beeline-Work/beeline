# Tool-output sheet, decorative marks, members route, bookmarks empty copy

Captured in headless Chrome at 1440×900 (and 390×900 for the phone case) against
the real components, built the way Metro builds the web bundle: `.web.*`
resolves first and react-native-svg's web build turns a mark's props into DOM
attributes. Harness: `apps/mobile/sources/test/browserProof.ts`.

## Reproduced

### TOOLSHEET-1 — the sheet, its size line, and the marks around it

Open a 40-line `ts` fence in a transcript and press **open**. On `main`, the
same probe run against both trees reports:

```
main    {"sheetWidth":460,"sizeLines":["ts · 40 lines · 2.5 KB","ts · 40 lines · 2.5 KB","2.5 KB"],"domPropErrors":1}
branch  {"sheetWidth":668,"sizeLines":["ts · 40 lines · 2.5 KB","ts · 40 lines · 2.5 KB"],"domPropErrors":0}
```

- **Width.** The sheet opened at 460px on a 1440px window — the centred confirm
  dialog's cap, narrower than the 600px the same sheet gets as a bottom sheet on
  a phone, so the widest screen wrapped machine lines soonest.
- **Size line.** The byte size read three times for one fence: the inscribed
  line DESIGN.md specifies, the sheet's subtitle, and again as the Copy row's
  trailing metadata.
- **DOM accessibility warning.** Every painted mark logged
  `React does not recognize the accessibilityElementsHidden prop on a DOM
  element` — the warning `docs/evidence/desktop-workspace-nav/README.md`
  recorded as pre-existing.

### ROUTE-1 — `/beeline/MembersScreen` is a second URL for the members screen

Asking Expo Router for the route table it generates from `sources/app`:

```
main    /beeline/MembersScreen
        /beeline/members
branch  /beeline/members
```

`MembersScreen.tsx` sat inside the router tree beside the two-line `members.tsx`
that re-exported it, so both files became routes. Nothing in the app linked to
`/beeline/MembersScreen`; it was reachable and unlinked.

### COPY-1 — the bookmarks empty state names the wrong gesture

With no bookmarks saved, both surfaces read:

```
No bookmarks yetLong press a message, or use its desktop action strip.
```

A desktop reader is told to long press, which on desktop copies the message
instead; a phone reader is told about a strip no touch surface shows.

## Demonstrated

`npx vitest run sources/components/buzz/tool-output-sheet.browser.test.ts
sources/app/\(app\)/beeline/bookmarks-empty.browser.test.ts
sources/app/\(app\)/beeline/members.route.test.ts` — 5 passed.

- **TOOLSHEET-1.** The sheet opens at its own 668px cap (80 columns of the
  machine role plus the sheet inset), the size reads twice, and no mark logs a
  DOM prop error. Reverting each fix in turn fails the same proof with
  `sheet opened at 460, not its 668 cap`,
  `byte size reads 3 times: … | … | 2.5 KB`, and
  `DOM prop errors: React does not recognize the accessibilityElementsHidden
  prop on a DOM element`. In the passing DOM each glyph now carries
  `aria-hidden="true"`, so the marks are hidden rather than merely quiet.
- **ROUTE-1.** `members.route.test.ts` regenerates the route table and finds
  `/beeline/members` and no `MembersScreen`. Putting the colocated screen back
  fails it on `expected … not to contain 'MembersScreen'`.
- **COPY-1.** The empty block reads
  `Hover a message and press its bookmark mark.` at 1440 and
  `Long press a message and pick Bookmark.` at 390. Restoring the old string
  fails both cases.
