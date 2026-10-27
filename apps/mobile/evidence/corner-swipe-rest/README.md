# Corner swipe panel stays off message text at rest (Reproduction R1)

Report: in an Android Room (landscape, 2340 × 1080) a tan strip with the corner
glyph and `CORNER` sat over the first ~80 dp of every message, under the text.
That strip is the swipe-right "forward to a new corner" panel of each message
row (`SwipeToReply` in `RoomMessageVariants.tsx`, 78 dp wide).

Cause: gesture-handler's `Swipeable` hides its action panels at rest only by
translating them 10000 dp off-screen through a native-driven interpolation.
When Android loses that translation, the panel paints at its laid-out place,
behind the transparent message row, so the text draws over it.

Fix: the panels keep their width (Swipeable measures it for the open
distance) but paint only from the start of a swipe until it closes. A closing
spring that never reports its end still hides them 700 ms after it starts.
The reply panel is unchanged: it was not exposed in the report or in the
stand-in below. Desktop rows have no Swipeable and are unchanged.

## Proof

No Android device was reachable from this machine (KVM is not available to
the corner user, so the leased emulator exits before boot). The stand-in renders
the real `OrdinaryLedgerMessage` rows on react-native-web at 2.75 device pixels
per point, landscape (851 × 393 pt = 2340 × 1080 px) and portrait
(393 × 851 pt), drops the panels' hiding translation the way Android did, and
checks whether a painted panel overlaps the message.

| R1 | Before (main) | After |
| --- | --- | --- |
| Landscape | corner panel over text ([before-landscape.png](before-landscape.png)) | clear ([after-landscape.png](after-landscape.png)) |
| Portrait | corner panel over text ([before-portrait.png](before-portrait.png)) | clear ([after-portrait.png](after-portrait.png)) |

A real mouse swipe on the after build still reveals the panel while dragging
([after-landscape-swiping.png](after-landscape-swiping.png)) and hides it after release.

```sh
PROOF_PHASE=before node --import tsx apps/mobile/scripts/render-corner-swipe-rest-proof.mjs
PROOF_PHASE=after node --import tsx apps/mobile/scripts/render-corner-swipe-rest-proof.mjs
(cd .verification/corner-swipe-rest && python3 -m http.server 18492 --bind 127.0.0.1) &
CORNER_SWIPE_PLAYWRIGHT=<playwright-core>/index.mjs node apps/mobile/scripts/capture-corner-swipe-rest-web.mjs
```

Regression: `paints the swipe panels only while a swipe is under way
(Reproduction R1)` in `RoomMessageVariants.test.tsx` fails on main and passes
with the fix.
