# Quote-jump scroll wobble — before/after

Reproduced on a real Android emulator (API 36) against a local monolith
server, signed in through the Play-review link (`beeline://review/<secret>`,
`BEELINE_REVIEW_SECRET`) into the fixed `Beeline Review` Workspace's
`#general` Room (`review-proof-fixture.ts`), never a newly minted Workspace.
Frame timestamps throughout come from analyzing each `adb shell screenrecord`
capture frame-by-frame (cross-correlating each frame's vertical brightness
profile against the first frame to measure the transcript's pixel offset, or
sampling a target row's background pixel directly to detect the brass flash).

This evidence has two rounds. The first (below) used a 26-message Room and
caught the reported wobble, but every row in that Room was already rendered
by FlatList — it could not show whether the fix holds for a target FlatList
has not yet measured. Hand review of the first fix caught exactly that gap
(a fixed two-animation-frame delay can still fire before a distant target's
`onScrollToIndexFailed` retries land it) and a second, deeper bug the review
prompted finding empirically: gating the settle on the shared
`dragEndSequenceRef` mistakes `onScrollToIndexFailed`'s own corrective
`scrollToOffset` calls (which provoke native momentum events just like a
real gesture) for the reader abandoning the jump, so a distant target would
never settle at all. The second round (further below) re-tests against a
227-message Room built specifically to force both `onScrollToIndexFailed`
and, at greater distance, real history pagination.

## Round 1 — 26-message Room, nearby target

25 seeded messages of mixed height (short one-liners and multi-line
paragraphs) were sent as the Play Review identity, then message 26 was sent
as a swipe-to-reply quote of message 02 near the top of the transcript —
the exact captain's-path reproduction: tapping that quote reference jumps
back across the whole seeded history.

Both recordings tap the identical reply-reference row on message 26 in the
identical seeded Room; only the app code differs (pre-fix commit `0fd095df5`
vs. the first fix on this branch).

### Before (`before-wobble.gif`, current `main`)

Measured scroll offset over time after the tap:

| t (s) | offset (px) |
| --- | --- |
| 0.00 – 2.00 | 0 (pre-tap) |
| 2.03 – 3.23 | **−194** (initial jump) |
| 3.27 – end | **+81** (a second, unrequested correction) |

The transcript jumps once, holds for ~1.2s, then jumps again to a
*different* — and less accurate — position, with no highlight on the
target row (`message 02`). This is the wobble: two humanly-visible
positions after one tap, exactly matching the two fixed delays
(`400ms`, `1200ms`) the old retry ladder scheduled unconditionally in
`_chat-surface.tsx`'s `notificationResponseId` landing effect.

Stills: `before-initial-jump-t2.1s.png`, `before-second-correction-t3.6s.png`
(same transcript, visibly different scroll position, no flash).

### After (`after-single-settle.gif`, this branch's first fix)

| t (s) | offset (px) |
| --- | --- |
| 0.00 – 2.07 | 0 (pre-tap) |
| 2.10 – end (4.33) | **−194**, unchanged for the rest of the capture |

One jump, held for the entire remainder of the recording — no second
correction. The settled target row (`message 02`) also flashes brass once:
sampling that row's background pixel across frames shows it shift from
`(240,236,226)` (the plain background) to `(210,198,174)` (the brass wash)
at t≈2.4s, hold, then fade back to `(240,236,226)` by t≈4.0s — the same
`arrivalFlashTiming` hold(1100ms)+fade(550ms) contract the existing arrival
pointer uses, just the `brassWash`/`brassWashStrong` token instead of
`bgHighlight`.

Stills: `after-initial-landing-t2.3s.png` (pre-flash, same position as the
`before` initial jump — confirming the fix doesn't change *where* it lands,
only that it stops moving after), `after-brass-flash-t3.0s.png` (message 02
visibly highlighted), `after-settled-same-position-t4.3s.png` (flash faded,
scroll position identical to the landing frame).

**This round's fix (the fixed two-animation-frame delay) is superseded by
round 2's viewability-driven settle** — see below for why, and for the
current mechanism's own evidence.

## Round 2 — 227-message Room, a genuinely distant target

A `#general` Room was seeded with 226 messages (the original 26 plus 200
`History filler NNN` lines), then message 227 was sent as a swipe-to-reply
quote of "History filler 027" — ~200 rows above the composer, and outside
both the client's initially-loaded message window and FlatList's
virtualization window. Tapping that reference exercises the full path a
26-message Room cannot: several rounds of `loadOlderTranscriptMessages`
network pagination to make the target resident, *then* several
`onScrollToIndexFailed` retries to bring its row into FlatList's rendered
window, and only then the message-source landing's own settle.

Traced with temporary `console.error` instrumentation (removed before this
PR; not part of the shipped diff) reading back through the Metro dev-server
log, one run showed the exact failure mode hand review anticipated:

```
DBG-jump-visibleIndex {"visibleIndex":200,"transcriptLen":210}
DBG-scrollToIndexFailed {"averageItemLength":37.9,"index":200}
DBG-scrollToIndexFailed {"averageItemLength":37.8,"index":200}   (×6 total)
DBG-observe {"hasTarget":false, landingDragSeq:1, currentDragSeq:3, ...}
DBG-observe {"hasTarget":true,  landingDragSeq:1, currentDragSeq:3, ...}   ← never settles
```

`onScrollToIndexFailed`'s own `scrollToOffset` calls provoke native
`onMomentumScrollBegin`/`End` on the underlying scroll view exactly like a
real gesture, advancing the shared `dragEndSequenceRef` from 1 to 3 with no
touch involved. The landing had captured `dragSequence: 1` at start, so
`canSettleMessageSourceLanding`'s sequence check refused forever, even once
`hasTarget` finally went `true` — the settle (and the flash) would never
have fired for this exact distant-target case. Fixed by dropping the shared
counter from the gate entirely and adding a dedicated
`messageSourceLandingAbandonedRef`, set only by `onScrollBeginDrag` (a real
touch never fires from a programmatic `scrollToIndex`/`scrollToOffset`) —
see `buzz/message-source-landing.ts` and its
`shouldSettleMessageSourceLanding` regression test.

### After the abandonment fix (`distant-target-settle.gif`)

Consecutive-frame diffing over a 20.9s capture:

| t (s) | activity |
| --- | --- |
| 0.0 – 10.9 | none visible (`loadOlderTranscriptMessages` pagination running in the background) |
| 10.9 – 13.5 | several `onScrollToIndexFailed` corrective scrolls bringing the row into range |
| 13.5 | settle: target lands, fully visible, well-centered |
| 13.5 – 15.5 | brass flash (background `(240,236,226)` → `(210,198,172)` → back), sampled directly on the target row's pixels |
| 15.5 – 20.9 | **zero further change** — position and color both static |

Stills: `distant-target-brass-flash.png` (target row highlighted, fully
visible, not clipped — the exact case round 1 couldn't test), 
`distant-target-settled-t20s.png` (17s later: identical scroll position,
flash faded, confirming no later correction).

## Push-notification-landing check (no #1765 regression)

The reviewer's ask: prove the shared `notificationMessageId` landing effect
still serves an actual push-notification-style landing correctly, not only
a quote tap. Rather than routing a real FCM payload through
`expo-notifications` (unnecessary to exercise this code — see
`sources/utils/notificationRouting.ts`, `navigateToBuzzTargetFromNotification`),
this drives the identical route/params a tapped push resolves to:

```
adb shell am start -a android.intent.action.VIEW \
  -d "beeline:///beeline/chat/<roomId>?notificationMessageId=<id>&notificationResponseId=push-test&notificationTarget=message" \
  app.usebeeline
```

targeting "History filler 150" (~77 rows back — distant enough to require
`onScrollToIndexFailed`, closer than message 227 so no pagination needed).
Same result as the quote-tap case (`push-notification-landing.gif`,
28.5s capture):

| t (s) | activity |
| --- | --- |
| 0.0 – 6.2 | initial jump + `onScrollToIndexFailed` retries |
| 7.1 – 8.7 | brass flash, sampled on the target row |
| 8.7 – 28.5 | **zero further change** for the remaining ~20s |

Stills: `push-notification-brass-flash.png`, `push-notification-settled-t26s.png`.
This is the exact `_chat-surface.tsx` code path #1765 fixed
(`pendingNotificationLandingRef`, `onScrollToIndexFailed`'s retry loop) —
unchanged by this PR — with the new settle/flash layered on top; no
regression.

## Can a notification landing show both the arrival pointer and the brass flash?

No. `RoomMessageCell` mounts at most one flash fill per row
(`ArrivalFlashGround`), and `_chat-surface.tsx` combines the two booleans as
`flashing={arrivalFlashing || sourceLandingFlashing}` with
`tint={sourceLandingFlashing ? 'brass' : 'pointer'}` — brass wins if both
were ever true for the same row. In practice they target different
concepts and rarely coincide: `arrivalFlashing` (`bgHighlight`) is armed
only by `completePendingNewMessageLanding`, gated on
`pendingNewMessageLandingRef` (the unread-queue boundary landing), while
`sourceLandingFlashing` (brass) is armed only by a `notificationMessageId`
jump (`messageSourceLandingRef`) — independent state driven by different
route params.
