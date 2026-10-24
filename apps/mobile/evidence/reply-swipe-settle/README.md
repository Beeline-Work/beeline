# Reply swipe settles fully (Reproduction swipe-1)

Device: Beeline-leased Android emulator (API 36, 1080 × 2400, 420 dpi), debug
build of app.usebeeline loading `scripts/transcript-dividers-native-proof.tsx`
from Metro. Reply screen: a long agent row that rerenders every 200 ms, with
the keyboard opening on reply. This is a native component replay, not a
signed-in production Room.

Replay: `python3 -I scripts/reply-swipe-android-proof.py --device <serial> --out <dir> --label <label>`.
Each attempt swipes, waits 2.5 s, reads the message body bounds with
UIAutomator (bounds include transforms) and takes a screenshot. At rest the
body sits 4 dp (10.5 px) inside the Swipeable clip box.

| Attempt | Before (main) | After |
| --- | --- | --- |
| Fast flick left (80 ms) | body offset −10.5 px, stuck | at rest |
| Medium swipe left (300 ms) | body offset −10.5 px, stuck | at rest |
| Slow drag left (900 ms) | body offset −10.5 px, stuck | at rest |
| Swipe right to corner (300 ms) | not run | at rest |

Raw numbers: [before.json](before.json), [after.json](after.json).

Cause: after a committed swipe the row called `close()` and, 240 ms later,
`reset()`. `reset()` sets the native animated values directly, which stops the
closing spring on Android's new architecture without repainting. The row froze
at the spring's last painted frame. On the emulator that frame was 4 dp left
of rest, with the panel hidden. The owner's screenshot shows the same
interrupted return with the panel's view frozen exposed; the panel and the row
are separate native views, so each can freeze at a different frame. The fix closes again instead: a second
`close()` runs a native spring that paints its rest frame. The fallback is
skipped once the first spring reports it finished.
