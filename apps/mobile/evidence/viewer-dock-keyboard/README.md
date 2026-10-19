# Viewer dock keyboard and design proof

Reproductions R1 and R2 use the production viewer dock and ConversationComposer on a task-owned Android 36 emulator. The fixture substitutes a local conversation and a static viewer background for a signed-in shared browser session. The clean emulator has no account or private browser card; stream transport and capture are outside this proof.

The before version is copied from commit 6b0d5b889 into temporary sibling modules. The after version imports the changed production components. Both run in one APK under the same SafeAreaProvider and KeyboardProvider, with a fresh app process for each version to reset the local conversation. Temporary baseline modules are removed after capture.

## R1

Open the dock, tap Message, and type “Explain these states”. Compare before-keyboard.png and after-keyboard.png. Send the message, receive the local long reply, focus Message again, and type “Visible above keyboard”. Compare before-transcript-keyboard.png and after-transcript-keyboard.png.

The IME begins at y=1517 on the 1080×2400 device. The before input ends at y=2139 (covered); the after input ends at y=1461 (visible). With the long reply and keyboard open, the transcript is [42,381][1038,1341], the pill is [32,1365][1049,1486], and both clear the keyboard. Raw UIAutomator trees, IME frames, and the APK hash are retained alongside measurements.json.

## R2

After sending with the keyboard dismissed, compare before-transcript.png and after-transcript.png. The replacement uses the existing Ionicons chatbubble-outline glyph in both the toggle and viewing reference; a quiet Button removes the inner outlined square. Headings and references use meta text, speakers use bodyStrong, and the card has an opaque raised surface.

## Rebuild

From apps/mobile, generate an ignored Android project with:
`npx expo prebuild --platform android --no-install`.

In its generated app/build.gradle set react.entryFile to file("../../scripts/viewer-dock-keyboard-native.tsx"), and disable Expo Updates in the generated manifest. Build with:
`./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'`.

Install only on a task-owned emulator launched with `beeline emulator`. The committed fixture mounts the after version. It loads the real fonts, sends locally, and delivers a long markdown reply to exercise the capped transcript.

## Regression checks

The dock component tests cover keyboard height on Android and iOS, dismissal while focus remains, no movement for an unfocused browser keyboard, no web movement, and transcript space above the composer. Existing viewer conversation, RoomMessageVariants, browser overflow, and design lint suites also run. The browser overflow screenshots retain their original test scope: the composer is a fixture boundary.

Validation: 176 tests across six targeted suites; root npm run typecheck; npm run dead-code (91 existing findings, zero introduced); native Android release fixture build. Bone theme captures also show the long transcript and a multiline draft above the keyboard. iOS keyboard offsets have component coverage; an iOS device was not exercised.
