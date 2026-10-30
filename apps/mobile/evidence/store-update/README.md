# Required store update

Feature proof STORE-UPDATE-1; not a defect report. No production minimum was set.

## Demonstrated on Android

Built the full app with `expo prebuild --platform android --no-install` and
`./gradlew assembleDebug -PreactNativeArchitectures=x86_64 --max-workers=2`.
Installed the APK on this corner's Android emulator, running native version
`0.2.22`. Served this branch's JavaScript through Metro with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:8788`.

The completed run used a disposable PGlite policy service forwarding other app
reads to the live service. Its temporary helper was removed after proof. No
production policy was written. The local Android minimum was set to `0.2.24`
with the reason “This version can no longer sign in. The update takes about a
minute.”

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

## Native iPhone

[Bone](ios-bone-native.png) and [Obsidian](ios-obsidian-native.png) show the
blocking screen in the native bundled iPhone simulator app from preserved
[proof run](https://github.com/Beeline-Work/beeline/actions/runs/40978222944).
The temporary workflow was removed after collecting these captures.

With the minimum equal to the installed version, the app passed the update
gate and reached [the secure-storage error](ios-equal-minimum.png): “Secure
storage unavailable: A required entitlement isn't present.” Ruby accepted
this as passage through the gate, which wraps the entire app. The unsigned
simulator build cannot use the iPhone keychain; its subsequent “Continue with
GitHub” assertion failed. The unset-minimum iPhone step did not run because
that assertion stopped the workflow. Android and unit tests cover unset policy.

## Actual Android OTA and signed-in web

The release APK retained Play Review sign-in. A local-only generated Android
manifest directed Expo Updates to an isolated local transport. Exported this
branch's actual Hermes bundle and assets using `expo export --platform android
--dump-assetmap --max-workers 2`, delivered a fresh Expo Updates manifest, and
relaunched. The [native launch record](ota-launch-proof.json) confirms update
`dc6cf655-81f7-4477-ad1b-8ffbb7cf2d7f` READY with three successful launches and
no failures. Native version stayed `0.2.22`, runtime `42`; no minimum changed.
The [signed-in Room list after the OTA](android-after-ota.png) remains normal.
This was local transport proof, with no production/EAS publish or channel
change. The generated Android manifest was restored afterward.

The [signed-in Play Review web Room list](web-reviewer-room-list.jpg) at
`https://web.usebeeline.app/beeline/channels` has no update gate.

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
