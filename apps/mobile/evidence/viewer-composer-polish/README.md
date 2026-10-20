# Viewer composer polish — VCP-1

## Reproduced

Reproduction VCP-1: Android 36, 1080 × 2400, 420 dpi (2.625 px/dp) → open the artifact viewer conversation toggle → double borders on the toggle, a lighter divider, the ring glyph and an attachment +. The provenance line uses the same ring. See before-closed.png and before-open.png, captured from baseline 6fabba433.

The clean task-owned emulator has no signed-in session for the original private artifact or shared browser. The closest stand-in, scripts/viewer-composer-polish-native.tsx, mounts the production ViewerConversationDock, ConversationComposer and TranscriptReference with native SVG, real fonts, SafeAreaProvider and KeyboardProvider. It uses a static viewer background and local delivery/capture callbacks. The provenance example mounts the production provenance component directly; it does not claim a live Room send, private artifact access, or browser transport proof.

## Demonstrated

Repeat VCP-1 on the fixed APK: after-closed.png is one 44 dp square; after-open.png shows one outer border, a full-height matching divider, the accent speech bubble and no +. The same bubble is visible at 14 dp in the provenance line. after-computer-closed.png and after-computer-open.png repeat the path for kind="computer". after-obsidian-closed.png and after-obsidian-open.png cover the dark theme.

The four *-zoom.png files are 4× nearest-neighbour crops of the original screenshots. Coordinates in the 1080 × 2400 originals: closed (920,2170)–(1060,2320); open (20,2170)–(250,2320).

Pixel check in Bone: at x=90 in the open toggle, baseline borderStrong (#C9BBA0) occupies y=2185–2186 and 2188–2189 at the top, then y=2302 and 2304–2305 at the bottom. Afterward it occupies only y=2185–2186 and 2304–2305, exactly the same runs as the rest of the pill at x=300. Antialiasing fills the fractional pixels: the requested one logical pixel is 2.625 device pixels at this density. The closed fixed border bounds are x=933–1048 and y=2190–2305, a 116 × 116 device-pixel square (44 dp rounded).

APK SHA-256:

- Before: ea806cecc4c49eea16ace973b16363784effdf07ea0b077e2e030b919211c7c8
- After: 4ca535e8af1e6cef4ee52d8bb08b76ffa83d30dd27969671b765a099fd1fb583

## Repeat

Run npm run corner:prepare. Generate the ignored Android project with npx expo prebuild --platform android --no-install from apps/mobile. In android/app/build.gradle replace the generated react.entryFile expression with file("../../scripts/viewer-composer-polish-native.tsx"). Disable expo.modules.updates.ENABLED in the generated manifest. Build from android with:

```sh
./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'
```

Launch a task-owned emulator with beeline emulator -avd viewer_composer_api36 -no-window -gpu swiftshader_indirect. Select its serial explicitly for adb install and screenshots. Open app.usebeeline/.MainActivity. Capture the closed dock, tap its bubble, capture open, then use Switch theme and Switch viewer to repeat. Each capture includes the production provenance example.

For the baseline comparison, use a separate checkout at 6fabba433 with this same fixture copied in. This run instead bundled exact snapshots of the baseline dock, composer, glyph and provenance modules under a temporary source directory; their internal references pointed to each other. Temporary snapshots were removed after the baseline bundle was written. Both APKs used the same generated native project and fixture.

Validation: 215 tests across the dock, composer, provenance, Room message variants, viewer conversation, palette guard and both design lint suites; root npm run typecheck; npm run lint:ui-components. The dock suite was rerun after the final full-height divider adjustment. The Room attachment-control regression confirms its + still invokes onAttach.
