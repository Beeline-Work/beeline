# Trusty Squire connect flow (Android)

Before: the owner's own phone screenshots, 2026-10-29 10:06–10:07 EDT, on the production app.
After: Android emulator (API 36, 1080x2400), release APK built from this branch with
`scripts/trusty-squire-native-proof.tsx` as the entry and `scripts/proof-shims/metro.cjs` for
the router, live socket and sign-in. The fixture mounts the production screens and feeds them
the exact step labels and sign-in shape squire wrote to production. It does not sign in to a
live workspace (the emulator has no owner session).

| Screen | Before | After |
| --- | --- | --- |
| Workbench → Trusty Squire | before-service.jpg | after-service.png |
| Pairing, waiting for sign-in | before-pairing.jpg | after-pair-signin.png |
| Pairing, in progress | (no spinner, no count) | after-pair-start.png, after-pair-installing.png |
| Pairing, failed | — | after-pair-failed.png |
| Sign-in page, fails to load | before-signin.jpg | after-signin-error.png |
| Sign-in page, fresh tunnel | before-signin.jpg | after-signin-loaded.png |

`flow.mp4` steps through pairing → sign-in → the loaded page → the Workbench row.

## Repeat

1. In `metro.config.js`, end with `module.exports = require('./scripts/proof-shims/metro.cjs')(config, __dirname);`.
2. In `android/app/build.gradle`, set `entryFile = file("../../scripts/trusty-squire-native-proof.tsx")`.
3. `./gradlew assembleRelease -PreactNativeArchitectures=x86_64`, install, then
   `adb shell am start -a android.intent.action.VIEW -d 'beeline://proof?screen=<name>&url=<page>'`
   with `service-waiting`, `pair-start`, `pair-installing`, `pair-signin`, `pair-failed` or `signin`.
4. For the fresh-tunnel cases, start `cloudflared tunnel --url http://127.0.0.1:<port>` and pass its URL.
