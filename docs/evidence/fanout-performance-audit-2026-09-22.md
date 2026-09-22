# Fanout and client performance audit — the viewport read cursor

Date: 2026-09-22
Author: Niglet
Extends: [`fanout-performance-audit-2026-09-20.md`](./fanout-performance-audit-2026-09-20.md)
Scope: the surface #1609 changed — scroll on the chat transcript — measured
against the same two product targets, plus a re-rank.

Measured against `369b43ba` ("Advance the read cursor from the viewport",
#1609) with this branch rebased onto it.

Scroll used to be a pure-render interaction on the chat surface. #1609 made it
able to originate a server write, so it moved into this audit's scope. Four
things were named for measurement; all four are answered below, plus the
re-baseline the merge asks for.

## What actually merged

The rebase was not a no-op and nearly went wrong. `origin/main` in this
worktree had **no fetch refspec configured** (`git config --get-all
remote.origin.fetch` returned nothing), so `git fetch origin main` moved
`FETCH_HEAD` and left `refs/remotes/origin/main` pinned at `1b3f8e67`. Read
against that stale ref, `useRoomSurfaceSession.ts:897` still held the single
open-time `markRead(channelId, latest.id)` and none of the viewport code
existed — the merge looked like it had not landed. It had: GitHub's `main` was
already `369b43ba`. Fetching with an explicit refspec fixed it. Anyone else
measuring in a corner worktree should check this before concluding a merge is
missing.

Shape of the merged code, for the record:

- `apps/mobile/sources/buzz/read-cursor-advance.ts` — `ReadCursorAdvancer`,
  trailing-edge debounce at `READ_CURSOR_DEBOUNCE_MS = 400`, forward-only.
- `_chat-surface.tsx:2227` — `advanceReadCursor(chronologicalMessagesRef.current,
  visibleTranscriptMessagesRef.current)` inside `observeVisibleTranscriptMessages`,
  which is the `onViewableItemsChanged` prop at `_chat-surface.tsx:5137` and is
  also driven by the desktop `IntersectionObserver` at `_chat-surface.tsx:2288`.
- `useRoomSurfaceSession.ts:279` — the advancer in a `useRef`, publishing via
  `void roomClientRef.current?.markRead(...).catch(() => undefined)`.
- `useRoomSurfaceSession.ts:958-970` — the open-time `markRead` is gone.

## How this was measured

Two suites, both against the real modules, no reimplementation:

- `apps/mobile/sources/buzz/read-cursor-cost.test.ts` — the real
  `ReadCursorAdvancer` against a 5,000-message corpus shaped like a real
  transcript (roughly every sixth row carrying `foldedIds`, every eleventh
  carrying `relayReports`, which is what makes `messageBoundaryIds` allocate).
- `apps/mobile/sources/buzz/read-cursor-rerender.test.tsx` — render counts under
  `react-test-renderer`, driving the real advancer and the real
  `useNewMessageControl`.
- `apps/server/src/read-cursor-cost.test.ts` — the released HTTP routes against
  PGlite with a 5,000-message Room, every row authored by the other member so
  every row counts as unread for the reader.

**Engine caveat, stated up front.** The client numbers are node/V8 on x86, not
Hermes on a phone. Hermes is slower than V8 on array-heavy code; the multiplier
is not measured here, so treat the client costs as a floor, not a ceiling.
Getting a Hermes number was attempted and failed — see "What could not be
measured".

## 1. Cost per visibility callback

The question was what the cursor logic added to a callback that runs inside the
scroll frame budget. Frame budget at 60 Hz is 16.67 ms.

| Transcript | Scrolling reader p50 / p95 | Reader sitting at the tail p50 / p95 |
|---|---|---|
| 200 rows | 0.039 / 0.064 ms | 0.025 / 0.045 ms |
| 1,000 rows | 0.066 / 0.114 ms | 0.070 / 0.082 ms |
| 5,000 rows | 0.155 / 0.350 ms | 0.343 / 0.419 ms |

Worst measured p95 across every run is 0.676 ms — **4% of one frame**, on V8, on
the deepest transcript this product has.

Run-to-run variance is real and not hidden: across five runs the 5,000-row
tail-seated p95 came back at 0.383, 0.419, 0.469, 0.608 and 0.676 ms, with p50
steady at 0.34–0.37 ms every time. Call it **0.4–0.7 ms p95**. These are five
runs on a shared box, not a baseline — the same caveat the 2026-09-20 PGlite
numbers carry. The table above is one recorded run.

Two things worth naming anyway.

It is **linear in transcript length, not in viewport size**.
`newestVisibleMessageId` runs `chronological.findIndex(row => row.id ===
message.id)` once per visible row, so the candidate selection alone is
O(visible × transcript). `#advances` then runs up to two more full-transcript
`findIndex` passes, each calling `messageBoundaryIds(row)` on every row it
visits — and that function allocates two or three arrays per row and dedupes
them with `ids.indexOf(id) === index`, which is quadratic in the ids per row.

And the **worst case is the common case**. A reader sitting at the tail costs
more than a reader scrolling (0.343 ms p50 vs 0.155 ms) because the `findIndex`
for the already-published boundary has to walk the entire array to reach the
tail. A Room opens at its tail.

Neither is urgent at today's numbers. Both are cheap to remove: RN's `ViewToken`
already carries `index`, so ranking could read it instead of re-finding every
row. Ranked as **G6**.

## 2. Debounce behaviour under a fast flick

Trailing edge, forward-only. Every report clears the pending timer and restarts
it, and the publish happens only when the viewport holds still for 400 ms.

| Drive | Result |
|---|---|
| 3,000 ms sustained scroll, 75 viewability reports, no rest | **0 writes during the flick, 1 write at rest** |
| Three 600 ms legs with a rest after each | **3 writes**, one per rest |
| 195 reports scrolling back UP after one forward write | **0 further writes** |

One write at rest, not a trickle. Not leading-edge, not per-batch. The upward
case costs nothing because `#advances` rejects a candidate behind the published
boundary before the timer is ever armed.

The standing rule for this Room — the server stores readership, it does not do
work for it — holds. #1609's own second commit removed the cross-device live
publish, the `room_read_marks` notify trigger and its listener branch, and the
corner-wake exemption. A read mark is one write and nothing else: no live frame,
no invalidation, no refetch, no agent woken.

## 3. Whether the write is off the interaction path

It is. `useRoomSurfaceSession.ts:280` publishes with `void
roomClientRef.current?.markRead(...).catch(() => undefined)` — no await, result
discarded. `RoomViewClient.markRead` is `.then(() => undefined)`: the response
body is never read, never guarded, never fed to a cache.

Driven with a publish whose promise never settles, the next viewability callback
still completes in 0.000 ms with that write outstanding. Nothing in the advancer
holds a promise.

## 4. Re-render fanout from cursor state

None from the cursor.

| Drive | Renders |
|---|---|
| 50 forward viewport reports moving the cursor | **0** |
| One write published and settled | **0** |
| `useNewMessageControl` in the same callback, 50 reports away from the tail | 1 |
| `useNewMessageControl`, reaching the tail | 1 |

The advancer lives in a `useRef` and keeps `#pending`/`#published` in private
class fields, so an advancing cursor is invisible to React by construction. The
one render away from the tail is `hasObservedVisibility` flipping false→true on
the first report ever; after that React bails out of the identical `setState`.
Reaching the tail costs one more. Both belong to #1606's disc and divider, not
to the cursor.

The one place cursor work does reach React state is `markUnreadFrom` →
`setFirstUnreadMessageId`, which feeds `dividerMessageId` to every row. That is
mark-unread — a deliberate, reader-initiated repaint, once.

## Server cost of the new write

| Path | p50 | p95 | Budget |
|---|---:|---:|---:|
| `POST /v1/phone/rooms/:id/read`, 5,000-message Room | 4.85 ms | 6.86 ms | 500 ms |
| `GET /v1/phone/rooms/:id`, mark at the tail | 21.76 ms | 27.74 ms | 500 ms |
| `GET /v1/phone/rooms/:id`, no mark at all (the count scan runs to the 99 cap) | 21.10 ms | 25.38 ms | 500 ms |

Thirty sequential read marks — thirty rests, a long reading session — total
137.7 ms of server time.

The `unreadCount` subquery #1609 added to `VIEWER_READ_CURSOR_SQL` did not move
the Room read: 27.74 ms p95 here against the 29.4 ms p95 this audit already had
for a 5,000-message Room. The `LIMIT 99` cap does its job.

`markRead` spends **3 statements** where one would do: an existence probe, an
access probe, then an upsert whose `SELECT` re-finds the same row the existence
probe just found. Ranked as **G7**.

## The sweep suite had gone blind, and what that cost

`live-fanout-sweep.test.ts` — this audit's own evidence for G2 and G3 — hung for
its full 300 s timeout after the rebase. It is worth writing down what it turned
out to be, because the failure mode is one any live-path test here can hit.

Isolation, in order:

- It hangs at `369b43ba` (current main) and at `126439d2` (its parent), so it is
  **not** #1609.
- It passes at `4bde9a49`, this branch's original base from 2026-09-20. So
  something on main in between changed live delivery.
- Instrumenting the socket showed the readers receiving **no frame at all** —
  not a wrong one, none.

The cause is #1584, "Fix delayed open Room delivery". For a write with no
committed row — every phone-originated human message — the socket now sends an
id-only invalidation **immediately**, ahead of row resolution, and then
`if (!result.delta && invalidationSent) return;` suppresses the follow-up. So the
reader gets exactly one early frame and nothing after it.

The suite attached its listener *after* `await send(...)` resolved and waited for
a `message-delta`. Both halves were wrong under #1584: the only frame had already
gone out, and it was not a delta. The suite now records deliveries from the
moment each socket subscribes and counts either shape as the reader being told.

**This is a test defect, not a product defect** — the product behaviour #1584
ships is intentional and is what makes the reader's row arrive sooner. But it
means G2 and G3 were, until this run, being asserted by a suite that could no
longer observe the thing it measures.

Re-measured against `369b43ba` with the suite fixed, both hold **unchanged**:

| Finding | 2026-09-20 | 2026-09-22 |
|---|---|---|
| G2 — statements per tagged agent | 8 → 35, 6.75 per mention | 8 → 35, 6.75 per mention |
| G3 — statements, 1 reader vs 8 | 9 vs 16, 1 per reader | 9 vs 16, 1 per reader |

G3's elapsed also grew with attachment as before: 14.8 ms at one reader, 42.7 ms
at eight.

## Re-baseline

The open-time `markRead` is gone from the fetch-apply path
(`useRoomSurfaceSession.ts:958-970`), so a Room open issues one fewer request.

It should not be credited against the 450 ms page-load gap, and the reason
matters: that call was already `void`-ed and fire-and-forget, so it never
entered the reader's wait for paint. Removing it takes one concurrent request
off the wire at open — which matters on a congested link and does not matter to
a paint trace. Cold-open traces taken before #1609 remain usable for the
page-load target. The 737 ms cold first open (G5) stands as measured.

## What this does NOT explain

The trigger placed this merge "squarely in the unproven 150 ms interaction gap."
It is in the gap, and it is small: **0.4–0.7 ms at the worst measured p95** against
a miss of 517 ms on the open Room and 583 ms on the deck. The read cursor is not
why the 150 ms target is missed, and fixing G6 and G7 would not move it.

G1 remains unisolated. The open Room already does row deltas and still burns
half a second between delta and pixel, and nothing measured here accounts for it.

## What could not be measured

**No Hermes number, and no scroll on the glass.** A release APK was built from
this rebased branch (`fc94cdc2`, gradle `assembleRelease`, non-debuggable,
Hermes bytecode) and installed on the x86 emulator. It launches and reports its
own build sha. It is **signed out**, and signing in needs a GitHub OAuth round
trip with credentials not available here, so there is no account and no Room with
a deep transcript to scroll. Without that, `dumpsys gfxinfo framestats` has
nothing to record.

So item 1 is answered on V8 and unproven on Hermes. That gap is real and I am not
going to paper over it with a made-up multiplier — the last audit round was
correctly failed for labelling a transport number as paint.

Two smaller notes on the state of the tooling here, both hit during this run:

- `packages/api-contract/dist` was stale. Every server suite that imports
  `@beeline/api-contract/phone` failed with `readCornerAppManifest is not a
  function` — a 503 on `GET /v1/phone/rooms/:id`, not a product bug. Rebuilding
  the package fixed it. The existing `live-interaction-latency.test.ts` failed
  the same way until then.
- `apps/mobile/android/local.properties` pointed at `/tmp/asdk`, which no longer
  exists. `/srv/tools/android-sdk` is present but not writable, so expo-updates'
  NDK install fails against it; `/home/alan/android-sdk` works.

## Ranking

Existing findings carried forward, the two new ones inserted by severity.

| # | ID | Sev | Finding | Status |
|---|---|---|---|---|
| 1 | G1 | P1 | 150 ms missed on the glass — deck 583 ms p50, open Room 517 ms p50. Cause unisolated. | unchanged |
| 2 | G5 | P2 | Cold first Room open 737 ms against 450 ms; warm is 330–377 ms. | unchanged, re-baseline does not affect it |
| 3 | G2 | P2 | `routeHumanMention` runs serially inside the send transaction. | unchanged |
| 4 | G3 | P2 | One extra Room read per attached reader, per human message. | unchanged |
| 5 | G4 | P3 | `readAgent` scans the unbounded roster. | unchanged |
| 6 | **G6** | **P3** | `ReadCursorAdvancer.observe` is O(visible × transcript) plus up to two allocating full-transcript scans, on the scroll path. 0.4–0.7 ms p95 at 5,000 rows on V8, worst for a reader at the tail, unmeasured on Hermes. Fix: rank by `ViewToken.index` instead of re-finding each row. | new |
| 7 | **G7** | **P3** | `PhoneService.markRead` costs 3 statements per write where 1 would do. Scroll now originates these. | new |

G1 and G5 remain the two worth their own corners. G6 and G7 are small enough to
ride along with other work on their files.
