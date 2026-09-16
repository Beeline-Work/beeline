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

## Measured verdict (playwright headless shell, in-sandbox)

- Google Chrome was never granted; playwright-core + the host's cached
  chromium_headless_shell-1243 run inside the sandbox. Driver: `run.mjs`.
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

`desktopTailLanding` (pure, in `room-scroll-follow.ts`) converges on the
real DOM tail gap rather than a fixed landing count or RN Web's provisional
event metrics. The list polls through the settling render window, re-lands on
renewed growth, and disarms after the real gap stays closed for one second.
Wheel, touch, or pointer activity disarms immediately so no stale follow
survives into history paging. A 24-landing cap is only the non-progress
backstop. The harness imports the production decision and offers `nofix` for
the before case. One-append results:

```text
count=30 FIX   -> tailGap 0 newestRowVisible true  overlaps 0 budgetLeft 0
count=60 FIX   -> tailGap 0 newestRowVisible true  overlaps 0 budgetLeft 0
count=30 NOFIX -> tailGap 1261 newestRowVisible false overlaps 0 budgetLeft 0
count=60 NOFIX -> tailGap 3115 newestRowVisible false overlaps 0 budgetLeft 0
```

Sibling note: `feature/corner-dda5e1cca0e8` (cold-open landing, 6d726691)
uses the same measured-landing technique for cold open and touches the same
lines — whichever PR merges second rebases over the other.
