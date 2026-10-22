# Anchored corner grouping and thinking-only paint

Reproduction `corner-grouping-1`: opening several corners from one resident message leaves separate anchored rows. The baseline is commit `b82f0f7fb`, and the reported live screenshot is the triage reference. The signed-in live Room at `web.usebeeline.app/beeline/chat/bb91a1c7-7cad-4fde-aafc-94fccb651ac8` was inspected through Trusty Squire. It also contains ordinary mixed repository runs, which remain unchanged.

Reproduction `turn-idle-paint-1`: scroll old transcript text beneath the status area, then finish a turn. With no agent thinking, the settled line still owns an opaque canvas and clips transcript text. `android-before-settled-bone.png` is native Android before the paint fix; `android-before-settled-layout.xml` and `android-before-layout.txt` record its element tree and rendered layout/style receipt. `android-web-before-settled-bone.png` and `android-web-before-layout.json` independently reproduce it in Android Chrome. The canvas is the `hanging-turn-chrome` box: the background comes from `hangingTurnChrome`, and the settled child enables coverage padding. A completely empty slot measured zero height; the reproduced non-thinking clipping case is the settled state, rather than evidence of a nonzero permanently empty band.

## Demonstrated

Native Android API 36, 1080×2400, task-owned leased `emulator-5554`. Debug native build, Hermes, native Unistyles, fonts, SVG, and the production composer. The existing `scripts/status-band-native-proof.tsx` fixture now also mounts `CornerOpenedMarkers`, the same adapter used by chat and the desktop inspector. Local fixture controls supply one or three anchored events, working/settled/idle status, and theme; they do not create production corners or start real turns. `android-three-collapsed-*`, `android-three-expanded-*`, and `android-single-*` capture both themes. Full-row presses logged `CORNER_PROOF_OPEN corner-0`. `android-thinking-*`, `android-settled-*`, and `android-idle-*` show scrolled transcript coverage. `android-after-layout.txt` records zero idle slot height, transparent base style, thinking-only coverage, and the unchanged composer bounds (y 777.5238dp, height 84.9524dp), matching the baseline.

The web proof bundles the shipped disclosure, anchored adapter, status slot and layout styles with React Native Web. Its shim replaces the native theme runtime and animation infrastructure; fonts and navigation controls are the real components. The glyph animation is stubbed in the web fixture, so native captures establish its appearance. The message and composer shell are fixtures. This proves the affected visible path without claiming that this unmerged branch is deployed to production. A fresh reviewer-bypass browser sign-in was not completed; the existing signed-in live browser was reused for inspection. Production-account end-to-end proof of the new code remains unavailable until it is served there.

Run:

```sh
npm run corner-grouping:proof --prefix apps/mobile
python apps/mobile/scripts/check-corner-grouping-status-proof.py
```

The browser check exercises phone and desktop viewports in both themes: single rows, three collapsed/expanded rows, whole-row destination, four rows truncated to two plus “2 more,” and all three status states. `web-layouts.json` verifies transparent idle/settled paint, opaque thinking coverage, and identical transcript/composer bounds across status transitions. `web-*` screenshots record those states.

## Validation

Root `npm run typecheck` and shared-components policy pass. Focused mobile suites pass (97 tests): grouping, lifecycle rows, inspector navigation, status paint, scroll following, Room-open geometry, and both design lints. The Impeccable detector found no issues. Restoring only the original slot/style implementation makes the paint regressions fail; the fixed implementation passes. The overlapping indent fix remains in open PR #2791; this change leaves the turn line's contents, mark, indent and positioning untouched.
