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

Fix, still at the list layout layer: the desktop transcript passes its loaded
message count as both `initialNumToRender` and `maxToRenderPerBatch` (native
keeps the defaults — both props are desktop-gated). The loaded transcript
stays in one render region, so an append mounts its row in the same list update
instead of requiring a machine-speed-sensitive sequence of fixed-size commits.
Both drivers now FAIL
(exit 1) when the verdict is false — newest row off screen or overlapping
rects — and `run.mjs` takes a reps argument; `run-throttled.mjs` runs the
same protocol under Chrome CPU throttling:

```text
count=500  appends=1 FIX   reps=10      -> tailGap 33 visible true  PASS (unthrottled)
count=30   appends=1 FIX               -> tailGap 0  visible true  PASS
count=60   appends=3 FIX               -> tailGap 0  visible true  PASS
count=500  rate=6x  reps=6 -> 6/6 PASS -> tailGap 33 visible true
count=500  rate=12x reps=6 -> 6/6 PASS -> tailGap 33 visible true
count=60   appends=1 NOFIX             -> tailGap 3115 visible false FAIL, exit 1
escape 30/60/500 x early/late          -> reader stays at scrollTop 0, follow drained
```

The remaining 33px is container padding below a fully visible newest row, not
an unrendered tail window. The reader-escape guard still holds at 500 rows: an
escape without wheel/touch leaves the reader at scrollTop 0 with the follow
drained (`run-escape.mjs 500 early`). The loaded render region also passes the
same protocol at 12x CPU throttling, where the fixed batch failed intermittently.

Sibling note: `feature/corner-dda5e1cca0e8` (cold-open landing, 6d726691)
uses the same measured-landing technique for cold open and touches the same
lines — whichever PR merges second rebases over the other. (Merged into
`main` at `f20cfb55` before the superseding work below started; no rebase
was needed.)

## Superseded (2026-09-22): the whole heuristic replaced with real measured DOM

Everything above — `desktopTailLanding`, `tailFollowStalled`, the 24-landing
cap, the 1s settle window, the held-offset reader-escape guard,
`desktopOpenLandingOnContentSizeChange` and the cold-open settle timer — is
released in main (`75cef3e2` #1333 and the six commits after it) and still
worked, but it is a ninth scroll-timing heuristic stacked on RN Web's
`onContentSizeChange`/`scrollToOffset`, exactly what the review history
above already spent three rounds hardening. Room direction (`@lunchboxfortwo`
via Niglet) was explicit: delete the machinery rather than add a tenth guard.

The desktop transcript no longer renders through `<FlatList>` at all. It is a
plain scrollable `View` over real DOM (`initialNumToRender`/
`maxToRenderPerBatch` are gone with it — nothing left to window). Four jobs,
four browser primitives, all in `shouldFollowDesktopTail` (pure) and its
wiring in `_chat-surface.tsx` (`buzz/room-scroll-follow.ts`):

- **Pinned?** `scrollHeight - scrollTop - clientHeight <= TAIL_PIN_THRESHOLD`,
  read from `isPinnedToTailRef` (updated only by a real `scroll` event, never
  recomputed elsewhere — see the bug below).
- **Follow an append:** one `ResizeObserver` on the content node. If pinned,
  `scrollTop = scrollHeight`. No retry, no budget, no convergence loop — with
  windowing gone the browser's height is final the instant the observer
  fires, whether that is a new row committing or a late image/font resizing
  one already on screen.
- **Prepend history:** record `scrollHeight` before the paginated commit,
  `scrollTop += scrollHeight_after - scrollHeight_before` in a layout effect
  keyed on the oldest row id changing. Desktop had no prepend anchoring at
  all before this (`maintainVisibleContentPosition` was `undefined` there);
  this is new, not a port.
- **Jump to a message** (notification anchor, unread boundary, artifact
  origin): `rowNode.scrollIntoView({ block: 'center' })` from a row-id → DOM
  node map, filled by a stable per-row ref callback. No index math, no
  `onScrollToIndexFailed` retry — that stays native-only, where FlatList
  still needs it.
- Viewability (`onViewableItemsChanged`, needed for the new-message control
  and notification landing) is an `IntersectionObserver` over the same row
  nodes, `root` the scroll container.

### Bug the harness caught before it shipped

First pass computed the pinned check *inside* the `ResizeObserver` callback,
fresh from the DOM, instead of reading `isPinnedToTailRef`. On a cold open
`scrollTop` is still `0` against the full (taller-than-viewport) content the
instant the observer's first callback fires — a fresh read says "not
pinned" and the transcript never lands:

```text
count=30 appends=1 FIX -> tailGap 1492 newestRowVisible false overlaps 0 FAIL
```

`isPinnedToTailRef` starts `true` and is corrected only by a real `scroll`
event, exactly the invariant the native list already relies on
(`isPinnedToTailRef = useRef(true)`); reading it instead of recomputing it
fixed the cold open without touching anything else. `desktop-tail-landing
.test.ts` now asserts the callback reads the ref and does not contain a
fresh recomputation, so this exact regression fails loudly if it returns.

### Full protocol, re-run against the rewrite

```text
count=30  appends=1 FIX -> tailGap 0 newestRowVisible true overlaps 0 PASS
count=60  appends=1 FIX -> tailGap 0 newestRowVisible true overlaps 0 PASS
count=30  appends=3 FIX -> tailGap 0 newestRowVisible true overlaps 0 PASS
count=60  appends=3 FIX -> tailGap 0 newestRowVisible true overlaps 0 PASS
count=30  appends=1 NOFIX -> tailGap 1492 newestRowVisible false overlaps 0 FAIL (expected)
count=60  appends=1 NOFIX -> tailGap 3346 newestRowVisible false overlaps 0 FAIL (expected)
count=500 appends=1 FIX reps=5 -> 5/5 tailGap 0 newestRowVisible true overlaps 0 PASS
count=500 rate=6x  reps=6 -> 6/6 PASS, tailGap 0 (was 33px — the fixed
  fill-batch remainder; gone with the fill batch)
count=500 rate=12x reps=3 -> 3/3 PASS, tailGap 0
escape 30/60/500 early+late -> follow never re-arms toward the tail
  (tailGap stays in the thousands); scrollTop moves by exactly the height of
  the 12 prepended rows (~747px for the 16-height row cycle here), which is
  the NEW prepend-anchor holding the reader's read position steady across
  the older page load — not the old code's silent no-op, and not a pull
  toward the tail.
```

`app.tsx` mirrors the production wiring 1:1 (imports `shouldFollowDesktopTail`
from the real module, same `ResizeObserver`/prepend-layout-effect/pin-check
shape) rather than re-deriving it, so a regression in either place is a
regression in both.

## Windows post-send check (2026-09-23)

The installed production Beeline on Chad's Windows guest is version 0.2.41.
Its old session reported `SESSION EXPIRED · TICKET_EXPIRED`. The original
September 9 Preview version 0.2.20 reported an invalid Room response. After
the owner authorized a reinstall, replacement Preview builds from PR #1650
and #1610 crashed at launch even with a clean profile (`0xc0000409`, fault
offset `0x356ea5`); the old profile was preserved separately. These were
testing blockers, not evidence about the transcript bug. A later authenticated
production web session on Chad reproduced the bug, as recorded below.

The first version of `run-send.mjs` exercised five fixed-height optimistic
appends in the measured-DOM fixture, starting with the reader scrolled into
history. It measured no adjacent-row overlap and a zero tail gap in Linux
Chromium and Windows Chrome 153 on Chad. It did not exercise pictures.

### Picture-send geometry follow-up

`run-send.mjs` sends photo attachment, text, image artifact, photo attachment,
then text. The build extracts the production `AttachmentCard` function and its
styles from `RoomMessageVariants.tsx`, failing if its source markers change.
The artifact mounts production `ArtifactCard` and `ArtifactImage` directly.
Both use the actual Obsidian theme tokens; stand-ins replace session, storage,
viewer, PDF, and navigation services. A 300ms source switch takes the photo
from file glyph to image; the artifact image source resolves after 300ms.
At 100ms and 550ms after each send the proof measures the painted image,
card, enclosing message row, adjacent rows and scroll tail. The later sample
requires every image to have loaded. React Native Web paints an image in an
inner background-image child, not the outer `Image` View.

Linux Chromium and Windows Chrome 153 on Chad each passed all ten samples:
zero adjacent-row overlaps, zero painted-image/card bounds outside their row,
zero tail gap, and the newest row visible. The Windows run used Chrome CDP in
the guest and the `CDP_HTTP_URL`/`PROOF_URL` options of `run-send.mjs`.

### Rapid photo-send tail landing

The driver also appends five photos with zero-delay task breaks, then measures
before and after their images load. On Linux Chromium, `NO_SEND_COMMIT=1`
(the prior send wiring) reproducibly left the newest row immediately below
the transcript viewport: 104px tail gap, previous row ending at y=470 and
newest row spanning y=470–574, while the viewport ended at y=470. A scroll
event had changed the pin ref to false before the final row committed, so the
`ResizeObserver` held position. The original proof's visibility check compared
against `window.innerHeight` (700), incorrectly calling that row visible; it
now uses the transcript viewport bounds.

`_chat-surface.tsx` now records the own-send message id before appending and
lands on the tail in a layout effect only when that exact row is in the DOM.
The same Linux burst then has 0px tail gap and a visible newest row before and
after image load; all adjacent row and painted-image bounds stay separate.
On Windows Chrome 153 in Chad, the fixed mixed sends and burst also pass with
0px tail gap and no geometric overlap. The Windows comparison run without
the committed-row landing also passed; this timing race was reproduced in the
Linux fixture, not on Windows.

These earlier fixture results did not reproduce the painted-row overlap; the
proof at that point did not mount the animated message wrapper. The following
live reproduction and updated proof supersede that conclusion.

### Reproduction WEB-ROW-1: settled web rows collapse

In an authenticated production web session on Chad's Windows guest Chrome,
send a 1600×900 PNG with a caption and then text in a Room, waiting about four
seconds after each send. The later text paints across an earlier message.
In a fresh empty Room, send three text-only messages with three-second waits;
these also paint over one another. Picture attachments are therefore not
required to trigger this bug. The production Windows screenshots are
`/tmp/speedy-windows-after-text.png` and
`/tmp/speedy-windows-text-only.png` on the Room host.

Live DOM measurement traced the painted overlap to the
`NewMessageMaterialize` `Animated.View`: a new row starts at 37px high but
becomes 0px after about 2.2 seconds. The child remains visible with inline
`position:absolute; top:-37px; height:37px`. Forcing that child back into
normal flow immediately restored its parent's height from 0px to 37px; the
measured six row heights were then `[119, 37, 346, 37, 37, 37]`. Adjacent
row rectangles do not overlap because the later rectangles themselves have
zero height; painted descendants escape those collapsed bounds.

The fix keeps `NewMessageMaterialize` in a normal `View` on web. Native
platforms retain their entrance animation. The browser proof now mounts the
production `NewMessageMaterialize` component around each sent row, along with
the production photo and artifact components. `PROOF_OLD_WEB_ENTRANCE=1`
removes only the new web guard at build time, giving an executable prior-code
comparison. After mixed photo/text sends and a 2.3-second settle, it measures
every row rectangle, any absolute wrapper, and painted image containment;
it repeats in an empty Room with three text-only sends. A collapsed row or
escaped image fails the run. This proof models sending and settlement around
real production rendering components; it is separate from the live upload
and outbox send on Windows.

On Chad's Windows Chrome 153, the prior-code build failed as expected:
after settling, the mixed run had 10 zero-height rows, 10 absolutely
positioned wrappers, and eight painted images outside their rows; the three
text-only rows were all 0px high. The fixed build passed the same run: all 70
mixed rows and all three text-only rows had positive height (minimum 43px),
with zero absolute wrappers, zero painted-image escapes, and zero adjacent
row overlaps. Linux Chromium gave the same red/green result. Both platforms
measured the latest row after delayed image loading and 2.3 seconds of
settlement. The production site remains on the previous bundle until this
change is released; the fixed verification used the source-backed proof on
the Windows guest, not a released WebView2 binary.
