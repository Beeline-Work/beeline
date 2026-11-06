# Corner title alignment

## Reproduced

Reproduction title-alignment-01: the human screenshot and approved mock show
the entire `Opened` title above the center of the existing corner glyph and
chevron. Approval: Room message
`b9b574f07b0cc08f2426ec1f76f12a21a9ad1eaff1e196d8d399835124bbe74a`.

Before editing, render the production `RepositoryLifecycleRow` and
`TranscriptNavigationRow` with both requested names. At phone width (390)
and desktop width (1280), the title line's center is 2.5 logical pixels above
the icons. Baseline screenshots and bounds are recorded beside this file.
The exact historical authenticated Room is replaced with a narrow fixture to
avoid modifying live messages. It uses the production fonts, themes, row,
labels and glyph geometry. Unistyles is replaced with its evaluated theme
styles; SVG primitives use DOM SVG elements; unused controls are stubbed.
These browser captures do not establish native font-padding behavior.

## Demonstrated

The same fixture centers the entire title line by translating its wrapper by
half the unused copy-target height: `(44 - 2 * 8 - 23) / 2 = 2.5`.
Both named rows and a long truncating title pass in Bone and Obsidian.
Measurements preserve the row height (44), icon bounds, content widths and
navigation destinations. The regression asserts the title line and icons
share a center; it fails against the original renderer.

Intentional differences from the approved screenshot mock: logical geometry
uses a 2.5-point correction rather than a literal six-pixel raster shift;
the surrounding conversation is replaced by a repeatable row fixture, and
Obsidian is added. No glyph, chevron, color or typography changes.

## Repeat the browser proof

From the repository root, build workspace packages if needed, then:

```sh
node apps/mobile/evidence/title-alignment/proof-kit/build.cjs
python -m http.server 9186 --directory .beeline-proof/title-alignment
```

In another terminal, start Chrome with a separate temporary profile:

```sh
/opt/google/chrome/chrome --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=9236 --user-data-dir=/tmp/title-alignment-chrome about:blank
node apps/mobile/evidence/title-alignment/proof-kit/capture.cjs after
```

The capture writes screenshots and measurement receipts under
`.beeline-proof/title-alignment`. `before` skips only the corrected-center
assertion, for reproducing the original renderer in an isolated checkout.

## Native Android proof

The native fixture runs the same production rows with real Unistyles and
react-native-svg, on this corner's Android emulator (1080 × 2400, density
420, font scale 1.0). Both native APKs' source maps were checked against the
pre-edit and changed renderer respectively; source, bundle and APK digests
are in the build receipts. The native capture also exercises both corner
links in each theme.

`proof-kit/native.jsx` is the fixture entry. Generate an Android tree with
Expo prebuild without installing packages, point the generated app Gradle
entryFile at that fixture and disable Expo Updates in its generated manifest.
For a mounted read-only dependency tree, use a writable isolated copy of
mobile sources, dependencies, theme/Metro/Babel configuration and tsconfig.
Keep each included Gradle build's default cache directory; sharing a single
`--project-cache-dir` across included builds corrupted plugin outputs in this
environment. Compile x86_64 with two workers and a 4 GiB Gradle heap:

```sh
SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease \
  -PreactNativeArchitectures=x86_64 -Dorg.gradle.jvmargs=-Xmx4g \
  -Pkotlin.incremental=false -Pkotlin.compiler.execution.strategy=in-process \
  -Pandroid.enableMinifyInReleaseBuilds=false \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=false \
  --max-workers=2 --no-daemon --console=plain
```

Install the local proof APK on emulator-5554, then from the repository root:

```sh
python apps/mobile/evidence/title-alignment/proof-kit/capture-native.py before
# Rebuild/install with the changed renderer, then:
python apps/mobile/evidence/title-alignment/proof-kit/capture-native.py after
python apps/mobile/evidence/title-alignment/proof-kit/verify-native.py
```

The native regression compares accessibility text/target bounds and the
actual icon-column pixels in both themes. Its device size and density are
pinned to the captured emulator, rather than being a general screenshot
framework. The surrounding Room and navigation callbacks remain the same
explicit fixture stand-in used for web.

Native result: the title moves seven raster pixels at the captured density,
bringing its line center within one screen pixel of the fixed icon center.
Both icon columns are pixel-identical before/after in each theme. All row
touch bounds and text widths are identical, and the long title still truncates.
