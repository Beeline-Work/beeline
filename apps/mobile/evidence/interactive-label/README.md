# Interactive viewer label

[Android capture](android-header.png) shows the production `ArtifactViewerScreen` and `RunnableArtifact` rendering **Interactive · After midnight** and **Stopped. Close and reopen it to try again.**

The screenshot uses the branch JavaScript in a locally built Beeline debug APK on a Beeline-leased Android API 36 emulator (`emulator-5554`). `scripts/interactive-label-native-proof.tsx` supplies the existing runnable MIME and title, and deliberately rejects the local session fetch to exercise the permitted pre-release error state. No account, production file fetch, or production mutation is used. The floating gear belongs to Expo's development client.

To repeat: build the workspaces and mobile dependencies, generate ignored Android files with Expo prebuild, then run `./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2 -Dorg.gradle.parallel=false` under `apps/mobile/android`. Temporarily point mobile `index.ts` at `./scripts/interactive-label-native-proof`, serve Metro on port 18887, install the debug APK on a leased emulator, reverse that port, and open the development-client URL. Dismiss the developer-menu introduction and capture with `adb -s <leased-device> exec-out screencap -p`. Restore `index.ts` after capture. The checked-in entry and Metro configuration remain unchanged.

Verification: mobile artifact/card/viewer/link suites pass (130 tests); runnable server/proxy suites pass (4 tests); full typecheck and the UI component policy against `origin/main` pass. The original server/startup/voice compatibility checks and dual-stack listener proof are recorded in the pull request. Production edge reach and playback still require Ruby's post-release verification.
