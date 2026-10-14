# Passive unread controls on Android

The owner requested removal of the unread-summary feature. Its sheet,
summary producer, NEW-divider action, slash palette entry, SDK command,
eligibility state, tests, and dedicated proof fixtures are removed. The feature-only server agent-turn count query and six-turn cap are also
removed, together with their API field/guard and captured client state. The
normal server unreadCount and firstUnreadMessageId remain. No dedicated
endpoint, job, model call, or database state needs migration.
The similarly named chat-list reconnect method and retired release-push table
are unrelated and remain outside this change.

## Android demonstration

[Android DM screenshot](android-dm-unread.png) and
[native observations](android-results.json) show the production
`RoomMessageCell`/`NewMessagesDivider` and `RoomUnreadControls` in an isolated
Ruby DM fixture with three unread agent replies. NEW is visible and passive;
the ordinary unread badge shows 3. A tap and a 900 ms long-press on NEW leave
the screen unchanged, with no sheet or summary action.

Android 36, 1080 × 2400, Hermes/Fabric, emulator-5554, America/New_York.
The leased emulator ran approximately 16:07–16:10 Eastern, under ten minutes,
then was stopped. The messages, header, and badge input are fixture data; the
row/divider and jump/badge controls are production components. Hook regression
tests separately exercise arrivals, badge clearing, boundary retirement, and
jump behavior. No production identity or session was used.

## Repeat

1. Prebuild Android in `apps/mobile` with
   `npx expo prebuild --platform android --no-install`.
2. Set generated `react.entryFile` to
   `file("../../scripts/unread-controls-native-proof.tsx")`,
   `debuggableVariants = []`, and disable Expo Updates in the generated manifest.
3. Build in `android` with `./gradlew assembleDebug
   -PreactNativeArchitectures=x86_64 --max-workers=2 --no-daemon`.
4. Lease an emulator with `beeline emulator -avd buzzy_api36 -no-window
   -gpu swiftshader_indirect`, install the APK, and set its zone to
   America/New_York with
   `adb -s <device> shell cmd alarm set-timezone America/New_York`.
5. Temporarily set mobile `package.json`'s `main` to
   `scripts/unread-controls-native-proof.tsx`. Start Expo with
   `npx expo start --dev-client --port 8099 --max-workers 2` and open
   `beeline://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8099`.
6. From the repository root run
   `python3 apps/mobile/scripts/unread-controls-android-proof.py
   --device <device> --out apps/mobile/evidence/unread-controls`.
   Restore `package.json` and stop Expo and the emulator.

## Regression checks

Full root build and typecheck; unread boundary/control, bottom chrome, slash
palette, SDK slash registry, composer-fill and surface-wiring tests; design
and typography baselines; and UI component policy. A repository search finds
no references to the removed components, producer, or eligibility API.
