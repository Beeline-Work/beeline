# Icon and splash proportion proof

All “before” captures use exact parent `17ffcc3a82236bd154ad1bc4e69611a76a3e94b7`.
All “after” captures use the working tree represented by this change. Native captures are
Release builds; no OTA update was published.

## Capture matrix

| Files | Device / surface | OS | Theme | Build | Runtime |
| --- | --- | --- | --- | --- | --- |
| `before/android/light/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | light | Release APK | Android 24 |
| `before/android/dark/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | dark | Release APK | Android 24 |
| `after/android/light/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | light | Release APK | Android 26 |
| `after/android/dark/*` | `buzzy_api36` Android emulator (`sdk_gphone64_x86_64`) | Android 16 / API 36 | dark | Release APK | Android 26 |
| `before/ios/light/*` | iPhone 17 Pro simulator on the residential Intel Mac | iOS 26.4 | light | Release simulator app, x86_64 | iOS 25 |
| `before/ios/dark/*` | iPhone 17 Pro simulator on the residential Intel Mac | iOS 26.4 | dark | Release simulator app, x86_64 | iOS 25 |
| `after/ios/light/*` | iPhone 17 Pro simulator on the residential Intel Mac | iOS 26.4 | light | Release simulator app, x86_64 | iOS 27 |
| `after/ios/dark/*` | iPhone 17 Pro simulator on the residential Intel Mac | iOS 26.4 | dark | Release simulator app, x86_64 | iOS 27 |
| `desktop-before-after-chromium144-linux.png` | Chromium render board | Chromium 144 / Linux | dark board, light icon examples | static production assets | Android 24 / iOS 25 before; Android 26 / iOS 27 after |
| `before/desktop/*` | browser favicon and Tauri launcher sources | Chromium 144 / Linux | dark and light context on render board | exact-parent production assets | Android 24 / iOS 25 source tree |
| `after/desktop/*` | browser favicon and Tauri launcher sources | Chromium 144 / Linux | dark and light context on render board | fixed production assets | Android 26 / iOS 27 source tree |

The `home-context` and `app-drawer` images show neighboring apps at the same OS-rendered
size. The `launch-contact-sheet` images are sampled from the adjacent full launch videos.
The iOS `app-after-launch` images show the distinction between the parent’s React
`BootPaint` glyph and the fixed build’s first real application screen. The unsigned iOS
simulator Release build cannot read the production keychain entitlement, so the real app
screen is the expected secure-storage error rather than an authenticated Room deck.

## Findings

- Parent unmasked icon rasters contain an approximately 40% mark. The fixed unmasked
  rasters restore approximately 49% geometry; Android adaptive foreground and monochrome
  retain their approximately 40% safe-zone geometry.
- Splash rasters receive the same full-bleed source geometry while `imageWidth` drops from
  150 to 125 (`150 × 0.83260274`), preserving the intended visible splash size.
- The parent source labels the post-theme native trees Android 24 / iOS 25 even though
  Android 25 / iOS 26 store binaries already exist. The fixed builds use the next unused
  native runtimes, Android 26 / iOS 27, and preserve 24 / 25 as OTA compatibility targets.
- The fixed native splash follows system appearance. The launch then hands directly to the
  real tree; the glyph loader remains only at Room and Corner loading boundaries.

## Build and regression proof

- iOS parent: repository-owned `npm run eas-build-post-install --prefix apps/mobile`, Expo
  prebuild, CocoaPods, and `xcodebuild` Release for the iPhone 17 Pro simulator; bundled
  runtime 25; x86_64 executable; `BUILD SUCCEEDED`.
- iOS fixed: the same bootstrap and simulator, regenerated from fixed `app.config.js`;
  bundled runtime 27; x86_64 executable; `BUILD SUCCEEDED`.
- Android fixed: Release APK installed on Android 16 / API 36; bundled runtime 26.
- `regressions/exact-parent-red.txt`: the exact parent fails 23 of the new/updated 115
  regression assertions.
- `regressions/fixed-branch-green.txt`: all 115 assertions pass on the fixed tree.

## Historical review

- [PR 1088](https://github.com/Beeline-Work/beeline/pull/1088) explicitly separated
  full-bleed unmasked surfaces from adaptive safe-zone assets.
- [PR 1105](https://github.com/Beeline-Work/beeline/pull/1105) reverted it the same day but
  records no explanation in its body, comments, or reviews. The reason is therefore not
  recoverable from GitHub history.
- This implementation differs by coupling each surface change to executable bounds tests,
  pairing splash source growth with the inverse `imageWidth` correction, retaining both
  adaptive foregrounds unchanged, repairing runtime/fingerprint/OTA compatibility together,
  and including installed Release-build before/after captures.
