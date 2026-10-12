# Composer polish release evidence

Android 36, 1080×2400 at 420dpi, Bone theme. Dedicated `viewer_composer_api36` instance launched with `-read-only -port 5574`; every device command targeted `emulator-5574`. Both APKs run Hermes release JavaScript, use the generated debug signing key, and disable OTA loading in the generated, uncommitted native manifest. The baseline source was `13f983429`; the final source includes `639e7b5a8` and this change. Both builds completed `assembleRelease -PreactNativeArchitectures=x86_64`.

Sign-in used `beeline://review/<local secret>` against a disposable PostgreSQL server and its Beeline Review Workspace. Native viewer frames use a locally served HTML artifact. Sends use the real Room API; fixture agent messages arrive through the real Room WebSocket. No model/helper was run. Browser screen capture and successful send are covered separately by the shared dock component test.

## Before and after

| Scenario | Before | After |
| --- | --- | --- |
| Room placeholder | [Frame](before-room-placeholder.png) | [Frame](after-room-placeholder.png) |
| Room single line | [Frame](before-room-single.png) | [Frame](after-room-single.png) |
| Room leading tag | [Frame](before-room-tag.png) | [Frame](after-room-tag.png) |
| Viewer three lines, attachment and send position | [Frame](before-viewer-three-lines.png) | [Frame](after-viewer-three-lines.png) |
| After sending | [Pill collapsed; no sent transcript](before-viewer-sent.png) | [Pill expanded; sent transcript visible](after-viewer-sent.png) |

Further final release frames: [empty expanded viewer](after-viewer-empty.png), [reply while expanded](after-viewer-reply.png), [manual collapse](after-viewer-collapsed.png), [fresh reply in collapsed ticker](after-viewer-ticker.png).

## Measurements

The placeholder and untagged text's visible glyph centers were about 6–6.5 physical pixels below the row center on this emulator before the fix. They finish within 1–1.5 physical pixels of it after trimming Android font padding and adding the 4dp bottom inset. This is a pixel measurement of these strings, not a guarantee about every font glyph. [Glyph measurements](glyph-centering.json) use dark neutral pixels in x=150…354, excluding the cursor and controls.

The clean single-line tagged field stays at `[145,1405][927,1474]`, and its row stays at `[45,1384][1035,1494]`, through six consecutive `Agjypq` keystrokes. The actual text and bounds are recorded in [native validation](native-validation.json). Android's input and tag line heights remain unset.

Before, the three-line viewer input touched its row bounds: input y=1189…1357, row y=1189…1357. After, row y=1145…1358 surrounds input y=1166…1337, leaving 21 physical pixels (8dp) above and below. Both buttons finish at y=1336, leaving the same bottom inset. The pill grows from 174 to 218 physical pixels for these three lines. The component test checks the existing 120dp input cap.

The baseline viewer send closed the pill. The final send clears only the draft, attachments and input height; the sent message and subsequent reply remain visible. Tapping the gold circle collapses it, and a later fixture reply appears in the ticker while the composer stays collapsed. An empty expanded viewer has no transcript.

## Validation

- Root `npm run typecheck`: passed after updating to `origin/main`.
- Composer, speech, viewer, computer viewer, layout and design tests: 12 files, 126 tests passed.
- New dock regressions failed on the baseline for hidden draft, send collapse and reopening after ticker expiry; all six now pass.
- Pre-landing and design checklist review: no outstanding findings.

APK SHA-256: baseline `b373d650b5bd6e509a05af03a1ad1bf477deadb58ed4481a420578599d24dcc0`; final `36585456aa747df3cf58264b6019cfb15bc9c48aef08296eff29a75e86944c7d`. APKs, credentials and raw test logs are ignored locally.
