# Required store update

Feature proof STORE-UPDATE-1; not a defect report. No production minimum was set.

## Demonstrated on Android

Built the full app with `expo prebuild --platform android --no-install` and
`./gradlew assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2`.
Installed the APK on this corner's Android emulator, running native version
`0.2.22`. Served this branch's JavaScript through Metro with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:8788`.

Start the disposable policy service from the repository root:

```sh
npm run build -w @beeline/server
node --import tsx scripts/serve-mobile-minimum-proof.mjs
```

The service uses the built HTTP server and a disposable PGlite database. It
forwards other HTTP app reads to the live service. It does not write production
policy. The local-only release secret is `local-proof-only`.

```sh
curl -X POST http://127.0.0.1:8789/v1/releases/mobile-minimum \
  -H 'Authorization: Bearer local-proof-only' \
  -H 'Content-Type: application/json' \
  --data '{"platform":"android","minVersion":"0.2.24","reason":"This version can no longer sign in. The update takes about a minute."}'
```

- Above the installed version: the blocking screen appears. Hardware Back
  leaves the same screen visible. `android-bone-native.png` and
  `android-obsidian-native.png` capture both native themes. The gear is the
  development client's tooling overlay, not a product control.
- Tap **Update on Google Play**: Chrome opens
  `play.google.com/store/apps/details?id=app.usebeeline` and displays Beeline's
  listing (`android-play-listing.png`). Chrome's first-run prompts were
  dismissed without signing into an account.
- Set the same local policy to `0.2.22`, then foreground the app: the normal
  signed-out screen appears (`android-equal-minimum.png`).
- Restart the disposable service to obtain an empty database, then cold-start
  the app: the normal signed-out screen appears again
  (`android-unset-minimum.png`).

The theme was changed using the app's existing `setAppDisplay` function through
the development debugger. The screen waits for the existing root font-ready
signal: native testing caught an initially clipped button label before fonts
settled, and the captured result shows the complete label.

## Browser stand-ins and remaining proof

```sh
node --import tsx apps/mobile/scripts/render-store-update-proof.mjs
```

This renders the actual screen and shared button with React Native Web and
the app's fonts/tokens. Files ending in `web-standin.png` are browser captures,
including the iPhone-sized captures; they are **not native iPhone proof**.

Native iPhone screenshots remain required. This Linux host has no
`xcodebuild`; the online Mac runner rejected SSH authentication, and the
connected BrowserStack account returned no uploaded apps. No iOS build was
uploaded or store release requested.

The normal Room list after an actual OTA remains unverified. Unit tests cover
unchanged native versions across differing OTA metadata, and the native
equal/unset checks above reach the normal signed-out screen. They do not claim
to be a signed-in Room-list capture following an OTA.

The existing signed-in browser session at
`https://web.usebeeline.app/beeline/channels` displayed the Room list without
an update gate. This was the existing owner session, **not the requested
reviewer bypass**. The saved reviewer credential's web-only host scope refused
the documented server review exchange (`host_not_allowed`); no raw credential
was fetched. The exact reviewer-bypass web check remains open.

## Automated checks

The server HTTP test covers unauthenticated reads, authenticated writes,
platform isolation, invalid policy and persistence across server instances.
Mobile tests cover below/equal/above, OTA independence, web exclusion, network
errors, invalid data, timeouts, the blocking render, Android Back, store links
and font readiness. Release tests cover no-input/no-write behavior and the
explicit platform input passing through authenticated dispatch.

Already installed builds without this code cannot display this screen. No
minimums are seeded by this change, and routine/nightly releases leave them
unchanged.
