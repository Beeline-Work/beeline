# Viewer dock keyboard proof — R1

This PR currently implements only scope item 1: keyboard offset and transcript height clamp. The toggle glyph, icons, colors, and typography match baseline 6b0d5b889. Design work and R2 remain deferred until the commander supplies the approved design.

## Reproduced

Android 36 → open the production viewer dock → tap Message → type “Explain these states”. The baseline input ends at y=2139 behind the IME beginning at y=1517; the composer disappears while typing. See before-keyboard.png.

The clean task-owned emulator has no signed-in shared-browser card. The closest stand-in mounts the production ViewerConversationDock and ConversationComposer under the real KeyboardProvider, over a static viewer background. Sending and the capture payload are local fixture boundaries; no browser transport or real screen capture is claimed.

## Demonstrated

Repeat the same typing path on the rebuilt keyboard-only version. See after-keyboard.png and after-transcript-keyboard.png. The latter includes a long local reply and the draft “Visible above keyboard”; both transcript and composer remain above the keyboard. Bone captures also exercise a multiline draft.

Before images were captured from the baseline modules in the earlier comparison APK. After images are refreshed from the keyboard-only APK, with a fresh process and local conversation. Measurements, APK hashes, raw UIAutomator trees, and IME frames are retained alongside the screenshots. Closed-keyboard images document the existing styling; they do not claim R2 is fixed.

## Rebuild

From apps/mobile generate the ignored native project with `npx expo prebuild --platform android --no-install`. Set generated app/build.gradle react.entryFile to file("../../scripts/viewer-dock-keyboard-native.tsx"), and disable Expo Updates in the generated manifest.

Build with `./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'`. Install only on a task-owned emulator launched with `beeline emulator`. Open the dock, focus Message, type, dismiss the keyboard, send, then focus and type again after the local reply arrives.

## Validation

176 tests across ViewerConversationDock component/browser, RoomMessageVariants, viewer-conversation, and both design lint suites; root npm run typecheck. Component coverage checks Android/iOS offsets, dismissal while focused, no movement for an unfocused browser keyboard, no web movement, and the transcript height clamp. iOS hardware was not exercised.
