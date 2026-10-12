# Composer cap-body centering proof

The centering target is the visible **cap-height-to-baseline body**, excluding descenders. Negative offsets are above the field center; positive offsets are below it. Coordinates and offsets are physical pixels. The reported baseline bound is the bottom occupied pixel of the non-descending body, not a separately reported font baseline.

## Supplied phone frame

The 1080×2340 screenshot has a field border at y=1260…1381, center 1320.5. The capital M body spans y=1300…1331, center 1315.5: **5 px high**. The cursor spans y=1288…1344, center 1316: **4.5 px high**. Including g's descender instead yields y=1300…1340, center 1320, which obscures the reported problem. [Original-frame measurements](captain-measurements.json).

## Change

`ConversationComposer` measures its real native line with `onTextLayout`, then moves the drawing by `lineHeight / 2 - ascender + capHeight / 2`. Android keeps `includeFontPadding: false`, zero fixed vertical padding, and unset input/tag line heights. The drawing transform does not contribute to content-size measurement. The composer also reserves at least the measured natural line height: the viewer's parent deliberately keeps an empty draft at 26dp, which is smaller than some scaled fonts. On iOS, only a short single line receives the extra space from that 26dp minimum; an intrinsically grown paragraph does not.

Web uses the loaded face's Canvas cap/ascent/descent metrics and the input's computed line box. It re-measures after font loading, theme/height changes and resize. The browser tag overlay moves with the input. The viewer's borderless row fills its existing 44dp container, rather than leaving a 42dp row at its top. A single scaled line is identified by its measured height, so it does not become falsely bottom-aligned as a multiline paragraph.

## Android

Android 36, 1080×2400, Bone theme; real Space Grotesk and IBM Plex Mono; real native TextInput and inline tag spans; Hermes release build signed with the generated debug key; OTA disabled in the generated local manifest. Dedicated `viewer_composer_api36` instance launched with `-read-only -port 5586`; every device operation targets `emulator-5586`. No backend, account, helper or model is required. Speech is disabled in the fixture; the trailing send control occupies the same 26dp slot as the mic.

The standalone fixture renders the production component in Room and viewer modes. It mirrors the viewer's empty-height clamp. A symmetric 1dp measurement border surrounds the borderless viewer component. The native tag-only field has no Message placeholder; tagged-body frames measure the typed word Message immediately after the pill, and separate tag-only/typing frames guard that transition.

Each pair below is **keyboard closed / open**. Every configuration covers the empty hint, plain typed Message and `@ruby Message` on both surfaces: **144 frames**, all within **1 px**. [Raw coordinates and frame filenames](native/measurements.json).

| dpi | Font scale | Room hint | Room typed | Room tagged text | Viewer hint | Viewer typed | Viewer tagged text |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 420 | 0.85 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 420 | 1 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 420 | 1.15 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 420 | 1.3 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 450 | 0.85 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 450 | 1 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 450 | 1.15 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 450 | 1.3 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 |
| 560 | 0.85 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 560 | 1 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 560 | 1.15 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +1.0 / +1.0 | +1.0 / +1.0 | +1.0 / +1.0 |
| 560 | 1.3 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 |

Representative frames: [Room hint, 450dpi / 1.0 / keyboard open](native/450-1-room-empty-open.png), [Room tagged text, 560dpi / 1.3 / keyboard open](native/560-1.3-room-tagged-open.png), [viewer hint, 560dpi / 1.3 / keyboard open](native/560-1.3-viewer-empty-open.png).

## Tag typing stability

At 560dpi / font scale 1.3, six real native keystrokes (`Agjypq`) after `@ruby ` keep the input and row bounds identical on both surfaces. [Measured text and bounds](tag-typing.json), [Room result](tag-typing-room.png), [viewer result](tag-typing-viewer.png). Tag-only fields are also captured [closed](tag-only-room-closed.png) and [open](tag-only-room-open.png); the viewer has corresponding [closed](tag-only-viewer-closed.png) and [open](tag-only-viewer-open.png) frames.

## Web

Chromium at 390×400, actual bundled font faces, production react-native-web composer. Font sizes are scaled to 0.85 / 1.0 / 1.15 / 1.3; each pair is **blurred / focused**. All **48 frames** are within **0.5 px**. [Raw coordinates, DOM rectangles, ink histograms and filenames](web/measurements.json).

The scan uses luminance across the input row, excludes the DOM-measured pill rectangle and tall caret strokes, and identifies the shared body baseline from the populated text rows, excluding g's sparse descender rows. A previous neutral-color/M-at-offset sampler missed Chrome's colored LCD antialiasing and falsely reported the tagged word high; the direct scan and visual inspection agree that it is centered.

| Font scale | Room hint | Room typed | Room tagged text | Viewer hint | Viewer typed | Viewer tagged text |
| --- | --- | --- | --- | --- | --- | --- |
| 0.85 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 | +0.0 / +0.0 |
| 1 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 1.15 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 | -0.5 / -0.5 |
| 1.3 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 | +0.5 / +0.5 |

Representative frames: [Room tagged text, scale 0.85](web/0.85-room-tagged-blurred.png), [viewer hint, scale 1.3, focused](web/1.3-viewer-empty-focused.png).

## Reproduce

Start only a dedicated read-only emulator; never use emulator-5554:

```sh
/home/lunchbox/android-sdk/emulator/emulator -avd viewer_composer_api36 \
  -read-only -port 5586 -no-window -no-audio -no-snapshot-save -gpu swiftshader_indirect
```

In the generated, ignored Android project, set `react.entryFile` to `file("../../scripts/composer-hint-center-native.tsx")`, use the existing generated `debug.keystore`/`androiddebugkey` for release signing, and set `expo.modules.updates.ENABLED` to false in the generated manifest. Build and install:

```sh
ANDROID_HOME=/home/lunchbox/android-sdk apps/mobile/android/gradlew \
  -p apps/mobile/android assembleRelease -PreactNativeArchitectures=x86_64 --console=plain
adb -s emulator-5586 install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
python3 apps/mobile/scripts/composer-hint-center-proof.py \
  --device emulator-5586 --out apps/mobile/evidence/composer-hint-center/native
python3 apps/mobile/scripts/composer-hint-center-jitter-proof.py --device emulator-5586
```

Build and serve the web fixture, then drive it through the task's isolated chrome-devtools-axi session:

```sh
cd apps/mobile
npx tsx scripts/build-composer-hint-center-web.ts
python3 -m http.server 8796 --bind 127.0.0.1 --directory evidence/composer-hint-center/local/web
```

In another shell:

```sh
CHROME_DEVTOOLS_AXI_SESSION=beeline-hint-center CHROME_DEVTOOLS_AXI_PORT=9238 \
  chrome-devtools-axi open http://127.0.0.1:8796
CHROME_DEVTOOLS_AXI_SESSION=beeline-hint-center CHROME_DEVTOOLS_AXI_PORT=9238 \
  chrome-devtools-axi resize 390 400
python3 apps/mobile/scripts/composer-hint-center-web-proof.py
```

The new native-metric regression fails on the baseline. Root typecheck, focused composer/speech/layout/design tests and dead-code checks are required before delivery. Native iOS is not pixel-tested in this Linux environment; the minimum-height/multiline behavior has a component regression test.

Validated release-fixture APK SHA-256: `9af379005fde48a203d5330ff98fe4923a3a36e86524b9c6b16edcf80aa1ede2`. APK, generated signing configuration and local logs are ignored.
