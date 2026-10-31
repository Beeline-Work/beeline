# Android locked connect button

Reproduction CONNECT-RING-1: open the Trusty Squire connect screen with helper reach pending. The locked Sign in to Google button has a dark border ring over its faded fill. After a failed reach, Try again has a single opaque fill.

The corner emulator has no production session. `scripts/connect-ring-proof` mounts the production connect screen, shared Button, fonts and theme with only local pairing data and router/transport hooks substituted. These are native Android captures, not browser approximations; no live pairing or Google sign-in is claimed. The fixture control below the screen switches between pending and failed reach. Its long press opens the shared Button audit.

## Result

- `android-before-locked.png`: dark ring reproduced before the fix.
- `android-after-locked.png`: one even faded fill with the original corners and dimensions.
- `android-after-retry.png`: Try again retains the same corners and dimensions.
- `android-shared-disabled.png`: shared primary disabled is even. Shared provider disabled has a subtle lighter rim; onboarding's Continue with Google uses that path. Reported separately, unchanged.

The fix requests offscreen alpha compositing only while locked. Android composites the opaque fill, border and label first, then applies the existing 0.32 wrapper opacity once. This preserves the approved colors in both themes without calculating new palette values.

At the horizontal center of the locked button (x=540), the before capture has RGB (128,122,116) at y=1938 versus interior (175,169,161) at y=1940. Afterward, the top edge at y=1937 and interior at y=1940 are both (175,169,161). Try again starts at the same y=1937 with (28,23,18). Screenshots are unmodified 1080×2400 captures. This edge/interior comparison is the visual regression check; removing the compositing prop restores the before result.

## Repeat

1. Run `npm run corner:prepare`. In mobile run `npx expo prebuild --platform android --no-install`; in mobile/android run `./gradlew :app:assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2 -Dorg.gradle.parallel=false -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'`.
2. Temporarily replace mobile/index.ts with `import './scripts/connect-ring-proof';` and append `module.exports = require('./scripts/connect-ring-proof/metro.cjs')(module.exports);` to mobile/metro.config.js. Restore both files afterward; neither override ships.
3. Start the corner emulator with `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect`. Install the debug APK on the leased device. From mobile serve `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1 npx expo start --dev-client --port 18889 --lan`. Start Metro after the native build so its watcher does not race temporary CMake directories.
4. Reverse port 18889 with adb and open `beeline://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A18889`. Dismiss the development menu. Capture pending reach before the screen's minute timeout; tap the fixture control to capture failed reach. Long press it for the shared audit.
5. Capture with `adb -s <serial> exec-out screencap -p`. To reproduce the defect, temporarily remove `needsOffscreenAlphaCompositing` from the locked wrapper, restart the fixture, and capture again.

Validation: Android debug build; connect screen suite (25 tests); root `npm run typecheck`; `node scripts/check-mobile-ui-components.mjs`.
