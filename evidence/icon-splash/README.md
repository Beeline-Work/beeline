# Icon and splash proportion proof

The task-start “before” captures use exact parent
`17ffcc3a82236bd154ad1bc4e69611a76a3e94b7`. The rebased PR parent is
`c43c0198c8b2f9cc9a7d0f3a125c8352843803da`; its affected assets and config are
unchanged from the task-start parent. “After” captures use this branch. Native
captures are Release builds; no OTA update was published.

## Capture matrix

| Files | Device / surface | OS | Theme | Build | Runtime |
| --- | --- | --- | --- | --- | --- |
| `before/android/light/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | light | Release APK | Android 24 |
| `before/android/dark/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | dark | Release APK | Android 24 |
| `after/android/light/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | light | Release APK | Android 26 |
| `after/android/dark/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | dark | Release APK | Android 26 |
| `before/ios/light/*fresh-id*` | iPhone 17 Pro simulator on residential Intel Mac `macbook-pro-7` | iOS 26.4 | light | Release simulator app, x86_64, fresh proof bundle id | iOS 25 |
| `before/ios/dark/*fresh-id*` | iPhone 17 Pro simulator on residential Intel Mac `macbook-pro-7` | iOS 26.4 | dark | Release simulator app, x86_64, fresh proof bundle id | iOS 25 |
| `after/ios/light/*fresh-id*` | iPhone 17 Pro simulator on residential Intel Mac `macbook-pro-7` | iOS 26.4 | light | Release simulator app, x86_64, fresh proof bundle id | iOS 27 |
| `after/ios/dark/*fresh-id*` | iPhone 17 Pro simulator on residential Intel Mac `macbook-pro-7` | iOS 26.4 | dark | Release simulator app, x86_64, fresh proof bundle id | iOS 27 |
| `desktop-before-after-chromium144-linux.png` | Chromium render board | Chromium 144 / Linux | dark board, light icon examples | static production assets | Android 24 / iOS 25 before; Android 26 / iOS 27 after |
| `before/desktop/dark/*` | exported web login and launcher sources | Chromium 144 / Linux | dark | exact-parent export/assets | Android 24 / iOS 25 source tree |
| `after/desktop/dark/*` | exported web login and launcher sources | Chromium 144 / Linux | dark | fixed export/assets | Android 26 / iOS 27 source tree |

The app-drawer images are the authoritative Android same-grid comparison against
neighboring apps. The removed `before/android/dark/home-context` capture was an app
drawer mislabeled as a home screen. The after home-screen captures remain as extra
launcher context. iOS home captures use fresh proof bundle identifiers so SpringBoard
cannot reuse an icon rendered for an older asset catalog; `diagnostics/` demonstrates
that cache failure mode. Launch contact sheets are sampled from the adjacent complete
videos.

The unsigned iOS simulator Release build cannot read the production keychain
entitlement, so the post-launch frame is the expected secure-storage error rather than
an authenticated Room deck. It still proves that native splash hands directly to the
real React tree instead of mounting the removed global `BootPaint` repaint.

## Measured surface policy

Bounds are measured on the 1024px source canvases. Full-color bounds use an 8-point
background trim; transparent adaptive bounds use alpha trim.

| Surface | Parent | Fixed | Policy |
| --- | ---: | ---: | --- |
| Android adaptive foreground | 39.6% × 49.5% | 39.6% × 49.5% | Preserve the hand-tuned mask safe zone. |
| Android legacy/unmasked icon | 39.6% × 49.1% | 47.6% × 59.5% | Restore the natural unmasked proportion. |
| iOS icon source | 39.6% × 49.1% | 47.6% × 59.5% | Use one full-color source for every OS appearance so tinted-mode persistence cannot substitute a pale glyph. |
| Native splash raster | 39.6% × 49.1% | 47.6% × 59.5% | Pair source growth with `imageWidth` 150 → 125; visible mark remains approximately 59.5px. |
| Browser favicon | 39.6% × 49.1% | 71.4% × 89.1% | Dedicated tiny-tab optical scale, without changing other surfaces. |
| Tauri desktop launcher | 51.2% × 63.0% mark on an 80.5% plate | 47.5% × 58.9% mark on a 100% plate | Remove the baked-in plate safe zone and retain the natural unmasked mark. |

The exported desktop login before/after captures are pixel-identical by design: this
change does not redesign the in-app sign-in mark. The desktop evidence board separately
shows the favicon and launcher sources that did change.

## Native delivery contract

Commit `427c5f5c` added the light/dark native splash configuration and moved Android
runtime 24 → 25. PR 1382 restored only the runtime label to 24 and re-recorded the
fingerprint; it did not restore the runtime-24 native tree. Consequently runtime 24
claimed a theme-aware native tree that installed runtime-24 binaries predated. A store
build regenerates native projects from current `app.config.js`, so it would physically
carry the theme-aware splash while advertising the reused compatibility label.

This branch assigns the next unused store runtimes (Android 26 and iOS 27), records the
clean-install native fingerprints under those labels, and retains Android 24 / iOS 25
only as explicit OTA compatibility targets. Public Expo config reports the same runtime,
icon, adaptive-icon, and light/dark splash contract.

## Build and regression proof

- iOS parent: repository bootstrap, Expo prebuild, CocoaPods, and `xcodebuild` Release
  for the iPhone 17 Pro simulator; bundled runtime 25; x86_64; `BUILD SUCCEEDED`.
- iOS fixed: the same residential Mac and simulator, regenerated from fixed
  `app.config.js`; bundled runtime 27; x86_64; `BUILD SUCCEEDED`.
- Android fixed: Release APK installed on Android 16 / API 36; bundled runtime 26.
- `regressions/exact-parent-red.txt`: the task-start parent fails 23 of the original
  new/updated 115 regression assertions.
- `regressions/followup-exact-parent-red.txt`: the exact rebased PR parent fails all four
  follow-up iOS/desktop proportion and configuration assertions.
- `regressions/fixed-branch-green.txt`: all 116 focused assertions pass on the fixed tree.
- Full mobile suite: 291 files passed, 2 skipped; 2,351 tests passed, 2 skipped.
- TypeScript, Tauri icon determinism, clean native fingerprint, and all-platform Expo
  export checks pass. The export emitted web, Android Hermes, and iOS Hermes bundles.

The global app-launch `BootPaint` is removed. Room and Corner loading gates still own the
post-handoff glyph behavior covered here. Existing inline loaders on other authenticated
surfaces predate this change and are deliberately outside this launch-handoff fix.

## Historical review

- [PR 1088](https://github.com/Beeline-Work/beeline/pull/1088) explicitly separated
  full-bleed unmasked surfaces from adaptive safe-zone assets.
- [PR 1105](https://github.com/Beeline-Work/beeline/pull/1105) reverted it the same day but
  records no explanation in its body, comments, or reviews. The reason is therefore not
  recoverable from GitHub history.
- This implementation differs by coupling each surface change to executable bounds tests,
  pairing splash source growth with the inverse `imageWidth` correction, retaining both
  adaptive foregrounds unchanged, repairing runtime/fingerprint/OTA compatibility together,
  using one stable full-color iOS appearance source, and including installed Release-build
  before/after captures.
