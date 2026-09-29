# Quote-jump scroll wobble — before/after

Reproduced on a real Android emulator (API 36) against a local monolith
server, signed in through the Play-review link (`beeline://review/<secret>`,
`BEELINE_REVIEW_SECRET`) into the fixed `Beeline Review` Workspace's
`#general` Room (`review-proof-fixture.ts`), never a newly minted Workspace.
25 seeded messages of mixed height (short one-liners and multi-line
paragraphs) were sent as the Play Review identity, then message 26 was sent
as a swipe-to-reply quote of message 02 near the top of the transcript —
the exact captain's-path reproduction: tapping that quote reference jumps
back across the whole seeded history.

Both recordings tap the identical reply-reference row on message 26 in the
identical seeded Room; only the app code differs (pre-fix commit `0fd095df5`
vs. this branch). Frame timestamps below come from analyzing each
`adb shell screenrecord` capture frame-by-frame (cross-correlating each
frame's vertical brightness profile against the first frame to measure the
transcript's pixel offset).

## Before (`before-wobble.gif`, current `main`)

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

## After (`after-single-settle.gif`, this branch)

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
