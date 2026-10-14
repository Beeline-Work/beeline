# Catch up unread window and summary

Reproduction catch-up-1: two Ruby replies at 2026-10-14T19:26Z and
19:45Z, represented as Unix seconds, show 15:26 and 15:45 in the transcript
on an Eastern device. Before the fix, the sheet showed
“Since 12:46 · newest 12:46” and “From Ruby.” even though the replies described
a merged fix and failed release. The pre-edit run is recorded in the corner's
Step 0 message.

The cause was seconds interpreted as milliseconds, not a server time zone.
The sheet now shares `ledgerStamp` with the transcript. Its range and summary
use original unread messages, preserving the first timestamp and content when
transcript cards fold together. The local extractive summary selects up to
three source sentences, prioritizing decisions and outcomes. Missing content
or an unresolved range shows “Summary unavailable” with a retry that rereads
the Room and retries older history.

## Android demonstration

- [Sheet](android-catch-up.png): production `RoomCatchUpSheet`, with three
  unread Ruby replies in an isolated DM fixture; first 15:26, newest 15:45;
  summary includes the merged fix, decision to retry, and failed release.
- [Unavailable state](android-unavailable.png): explicit state and retry.
- [Native observations](android-results.json): the UI driver asserts displayed
  timestamps and content, then taps retry and observes the summary recover.

Android 36, emulator-5558, America/New_York, Hermes/Fabric, 1080 × 2400.
The emulator was leased through `beeline emulator`, ran from approximately
15:55 to 15:59 Eastern (under ten minutes), then was stopped. No production
session was used. The background messages and forced unavailable state are
fixture data; the sheet, formatter, and report builder are production code.

## Repeat

1. In `apps/mobile`, prebuild Android with
   `npx expo prebuild --platform android --no-install`.
2. In generated `android/app/build.gradle`, set `react.entryFile` to
   `file("../../scripts/catch-up-native-proof.tsx")` and
   `debuggableVariants = []`. Disable Expo Updates in the generated manifest.
3. In `android`, build with `./gradlew assembleDebug
   -PreactNativeArchitectures=x86_64 --max-workers=2 --no-daemon`.
4. Lease an emulator with `beeline emulator -avd buzzy_api36 -no-window
   -gpu swiftshader_indirect`. Disable automatic time-zone detection and run
   `adb -s <device> shell cmd alarm set-timezone America/New_York`.
5. Install the generated debug APK. Temporarily set the mobile package's
   `main` to `scripts/catch-up-native-proof.tsx`, start Expo with
   `npx expo start --dev-client --port 8099 --max-workers 2`, and open
   `beeline://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8099`.
   Dismiss the Expo developer menu. Restore `package.json` after the proof.
6. From the repository root, run `python3 apps/mobile/scripts/catch-up-android-proof.py
   --device <device> --out apps/mobile/evidence/catch-up`, then stop the emulator
   and Expo server.

## Regression checks

Report tests cover seconds, a non-UTC device zone, first/last unread bounds,
folded-card input preservation, decisions/results/merges/failures, links,
source identity, and unavailable content. Sheet tests exercise the rendered
unavailable state and retry callback. Existing unread and sheet-layout tests,
full root typecheck, design/typography baselines, and UI component policy pass.
