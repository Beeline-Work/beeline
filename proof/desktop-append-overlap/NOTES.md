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
A 24-landing cap is only the non-progress backstop. Three reader guards
disarm it immediately so no stale follow can ever move someone who left the
tail: fresh wheel or touch activity on the web scroll node (React Native Web
never fires the drag callbacks), a gap-closed settle window, and — added for
the review round — a held measured offset: growth below the tail never
lowers scrollTop, so a drop below the offset the follow last held the reader
at is the reader leaving for history (scrollbar drag, PageUp — any modality
without wheel/touch events) and disarms the follow before it can yank them
back. The harness imports the production decision and offers `nofix` for the
before case and `noguard` for the pre-guard shape. One-append results
(`node proof/desktop-append-overlap/run.mjs <count> <appends> [flags]`,
run from the repo root):

```text
count=30 appends=1 FIX   -> tailGap 0    newestRowVisible true  overlaps 0 budgetLeft 0
count=60 appends=1 FIX   -> tailGap 0    newestRowVisible true  overlaps 0 budgetLeft 0
count=30 appends=3 FIX   -> tailGap 29   newestRowVisible true  overlaps 0 budgetLeft 0
count=60 appends=3 FIX   -> tailGap 0    newestRowVisible true  overlaps 0 budgetLeft 0
count=30 appends=1 NOFIX -> tailGap 1261 newestRowVisible false overlaps 0 budgetLeft 0
count=60 appends=1 NOFIX -> tailGap 3115 newestRowVisible false overlaps 0 budgetLeft 0
```

## Reader-escape scenario (`run-escape.mjs`)

One append arms the follow, the reader jumps to the top with no wheel/touch
event (the scrollbar-drag / PageUp shape), an older page prepends, and we
report where the reader ended up:

```text
count=30 phase=early noguard -> scrollTop 2238 tailGap 0    budgetLeft 18   # yanked back to the bottom
count=60 phase=early noguard -> scrollTop 4092 tailGap 0    budgetLeft 15   # yanked back to the bottom
count=30 phase=early fix     -> scrollTop 0    tailGap 2238 budgetLeft 0    # reader stays in history
count=60 phase=early fix     -> scrollTop 0    tailGap 4092 budgetLeft 0    # reader stays in history
count=30 phase=late  fix     -> scrollTop 0    tailGap 2238 budgetLeft 0
count=60 phase=late  fix     -> scrollTop 0    tailGap 4092 budgetLeft 0
count=30 phase=late  noguard -> scrollTop 0    tailGap 2238 budgetLeft 0    # settle window only covers late escapes
```

The `noguard` early rows are the residual hole the settle window left: an
escape inside the first second (no wheel/touch to veto) re-opened the gap
and the budget re-landed the reader at the bottom. The held-offset guard
closes it for every modality.

## Long-transcript convergence (`count=200` / `count=500`)

The review round measured the 500-row transcript still stranded five seconds
after one append: tail gap 4,782px with an exhausted landing budget. The
instrumented gap sequence explained why: on a long transcript every landing
**reaches the bottom it was shown**, and RN Web then measures rows above the
viewport, so the measured gap grows after every successful landing
(`618 → 613 → 1246 → 1870 → 2471 → 3094 → 3712 → 4357 → 4762 → 4855`). A
gap-based budget charges exactly the landings that are working, so the fixed
cap became transcript-length-dependent.

The budget now charges a landing only when the previous one left the follow
in the **same place** — extent and scroll position unchanged while the gap
stays open (`tailFollowStalled` in `room-scroll-follow.ts`) — which is the
honest stalled fact and the case the cap exists for. A landing that reached
the bottom is refunded. The cap is once again a non-progress backstop, never
a transcript-length limit.

## Second review round: the residual 600px flake was the fill walk

The stall-charging budget fixed the exhaustion but not the timing: the
reviewer still reproduced 2–3 of ~10 five-second 500-row runs stranded with a
601–633px gap, budget intact. Instrumented under Chrome CPU throttling
(6x — the loaded-machine shape the reviewer hit), the runs failed 6/6 with a
stable 645px gap and `budgetLeft 24`: the follow was ARMED, landing on every
content change, and the extent was still growing ~620px per event five
seconds in. DOM dump explains it: mounted rows `m0–m9` (sticky initial
window) + leading spacer + `m46–m139` — **RN Web's windowed fill walks
toward the newest row `maxToRenderPerBatch` (default 10) new cells per render
commit**, and every landing scroll puts the viewport past the mounted end,
re-triggering a high-priority fill. Revealing the appended row is an
O(rows/10)-commit walk whose duration scales with transcript length AND
machine speed; the ~620px residual gap is one fill batch short of done, and
the appended row is not even mounted mid-walk. (Flow layout reserves no
trailing extent — `scrollHeight` is the mounted rows only.)

Fix, still at the list layout layer: the desktop transcript passes
`maxToRenderPerBatch = 100` (`DESKTOP_MAX_TO_RENDER_PER_BATCH` in
`[channelId].tsx`; native keeps the default — the prop is desktop-gated).
The walk is now a handful of commits instead of ~50. Both drivers now FAIL
(exit 1) when the verdict is false — newest row off screen or overlapping
rects — and `run.mjs` takes a reps argument; `run-throttled.mjs` runs the
same protocol under Chrome CPU throttling:

```text
count=500  appends=1 FIX   reps=2       -> tailGap 0  visible true  PASS (unthrottled)
count=30   appends=1 FIX               -> tailGap 0  visible true  PASS
count=60   appends=3 FIX               -> tailGap 0  visible true  PASS
count=500  rate=6x  reps=6 -> 6/6 PASS -> tailGap 0  visible true   (was 6/6 FAIL, gap 645, budget 24)
count=500  rate=10x reps=4 -> 4/4 PASS -> tailGap 0  visible true
count=500  rate=12x reps=3 -> FAIL, exit 1 (12x is an absurd box; the failure path is the point)
count=60   appends=1 NOFIX             -> tailGap 3115 visible false FAIL, exit 1
escape 30/60/500 x early/late          -> reader stays at scrollTop 0, follow drained
```

The residual 0px gap replaces the old 47–49px band: with the fill no longer
starved, the measured bottom is the real bottom. The reader-escape guard
still holds at 500 rows: an escape without wheel/touch leaves the reader at
scrollTop 0 with the follow drained (`run-escape.mjs 500 early` → scrollTop
0). The walk now finishes inside the settle window on any realistic machine;
the 12x-throttled failure is a machine several times slower than the loaded
box that reproduced the original bug, and it fails loudly instead of
printing a false verdict.

Sibling note: `feature/corner-dda5e1cca0e8` (cold-open landing, 6d726691)
uses the same measured-landing technique for cold open and touches the same
lines — whichever PR merges second rebases over the other.
