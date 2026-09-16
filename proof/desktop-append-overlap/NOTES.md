# Desktop transcript row overlap — worklog (Goosy, corner 01c97d18)

Objective: reproduce + fix the desktop transcript row overlap when a message appends, at the list layout layer.

## Findings so far

- Desktop = Tauri window over `expo export --platform web` (react-native-web 0.21 vendored RN lists).
  `apps/mobile/src-tauri/tauri.conf.json`.
- Desktop transcript path in `apps/mobile/sources/app/(app)/beeline/chat/[channelId].tsx`:
  - `desktopTranscript = isDesktop` (line ~1710)
  - `inverted={false}` on desktop (RN Web's `inverted` = scaleY(-1) transforms, known to overlap changed rows — see keyboardAvoidance.test.ts).
  - `maintainVisibleContentPosition={undefined}` on desktop.
  - `contentContainerStyle` adds `messageListContentDesktop = { flexGrow: 1, justifyContent: 'flex-end' }` so short transcripts pin to the bottom.
  - Append path: `useScrollFollowOnArrival` → `scrollToEnd({animated:false})` in a layout effect (0979df07).
- RN Web vendored VirtualizedList: cells are plain-flow Views (no absolute positioning; only debug overlay is absolute).
  CellRenderer cellStyle is null when not inverted. Spacers are flow Views with explicit height.
- Every RN Web View: flex column, flexShrink 0, position relative — so pure flow rows cannot overlap unless something else intervenes.

## In flight

- Browser reproduction harness in `proof/desktop-append-overlap/` (app.tsx + build.mjs + index.html + bundle.js).
  Mirrors the app's exact list props; measures pairwise row-rect overlap before/after an append + scrollToEnd.
- Headless Chrome SIGTRAPs inside the corner bwrap sandbox, so a host command grant was requested:
  grant 05c48e65-14fc-4914-993a-e8f6a264f167, `google-chrome --headless=new ... --dump-dom file://$PWD/proof/desktop-append-overlap/index.html`.

## Resume plan

1. Run the granted command; read `#log` verdict (JSON lines with overlaps count/details) from the DOM dump.
2. If overlaps reproduce: bisect which prop combination causes them (flexGrow+flex-end? scrollToEnd timing? spacer estimate?).
3. Fix at list layout layer in [channelId].tsx; keep desktop bottom-pinned behavior; adjust `keyboardAvoidance.test.ts`-style source assertions + `room-scroll-follow.behavior.test.ts` if needed.
4. Rebuild harness with the fix to prove no overlap; screenshot artifact; evidence dir.
5. Commit (plain voice), push, `gh pr create`, print URL.

## Measured verdict (playwright headless shell, in-sandbox)

- Google Chrome was never granted; playwright-core + the host's cached
  chromium_headless_shell-1243 run inside the sandbox. Driver:
  `run.mjs`/`run2.mjs` (`node proof/desktop-append-overlap/run2.mjs`).
- Harness fix: RN Web forwards `data-*` only through the `dataSet` prop
  (arbitrary `data-row` attrs are dropped — first run measured 0 rows).
- Cold open: only the oldest window renders (scrollHeight 666, 10 rows).
- Append + arrival `scrollToEnd`: lands at scrollTop 230 while the real
  bottom is 3345 — the viewport is stranded mid-list, newest row entirely
  below the fold (`tailGap: 1381px`, `bottomRowVisible: false` after 3
  rapid appends). That mid-list seam cutting through a row is what reads
  as "row overlap" in the app.
- Pairwise row-rect overlap: **0 overlaps in 63 rendered rows** — flow rows
  cannot overlap; the defect is the landing, not the row layout.

## Fix (this branch)

`desktopTailLanding` (pure, in `room-scroll-follow.ts`): the desktop
arrival follow arms a 3-change measured-landing budget; `onContentSizeChange`
re-lands `scrollToOffset({offset: height})` (clamps to the exact bottom)
while the budget lasts, refusing only a reader mid-drag. The pinned verdict
cannot be consulted — the arrival scroll itself moved the offset before the
tail window measured. Tests: `sources/buzz/desktop-tail-landing.test.ts`
(6 pass). Typecheck: 388 pre-existing SDK-dist errors before and after the
change (no new errors from this branch).

Sibling note: `feature/corner-dda5e1cca0e8` (cold-open landing, 6d726691)
uses the same measured-landing technique for cold open and touches the same
lines — whichever PR merges second rebases over the other.
