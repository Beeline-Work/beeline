# Sign-in failure line

Reproduction sign-in-notice-1: on a ~390px phone, the Claude auth-failure line
hid `@ruby /login` behind More. The new copy leads with the command.

## Chrome

`sources/test/sign-in-notice.browser.test.ts` renders the production
`LedgerSystemLine` at 390px with bundled fonts, in Obsidian and Bone:
[obsidian](sign-in-notice-obsidian-390.png), [bone](sign-in-notice-bone-390.png).

## Android

Standalone Hermes release fixture (`scripts/sign-in-notice-native-proof.tsx`)
on Android 36, 1080x2400 at 420 dpi, emulator leased through `beeline emulator`.
It renders the production `LedgerSystemLine` in a 390dp column, with the old
line verbatim and the new line from `phraseTurnSilence`. A hidden copy at the
row's text width reports, through `onTextLayout`, the line the command ends on.
[obsidian](android-obsidian-390.png), [bone](android-bone-390.png),
[driver results](android-results.json).

## Run

From apps/mobile:

```sh
npx vitest run sources/test/sign-in-notice.browser.test.ts
```

Native fixture: run `npx expo prebuild --platform android --no-install`. Set
`react.entryFile` in `android/app/build.gradle` to
`../../scripts/sign-in-notice-native-proof.tsx`. Set
`expo.modules.updates.ENABLED` to false in the generated manifest. Then run
`./gradlew assembleRelease -PreactNativeArchitectures=x86_64 --max-workers=2`.
Install the APK on the leased emulator, launch it, and from the repo root run:

```sh
python3 apps/mobile/scripts/sign-in-notice-android-proof.py \
  --device emulator-5554 --out apps/mobile/evidence/sign-in-notice
```
