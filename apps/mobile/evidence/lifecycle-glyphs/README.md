# Lifecycle glyphs

## Reproduced

Reproduction R1: open #beeline on web.usebeeline.app and expand
“1 PR opened · 2 PRs merged”. On the existing signed-in owner session,
Opened #2939, Merged #2939 and Merged #2914 each showed the gold drop-down
glyph. This was visually confirmed in the production browser before the fix.
The reviewer bypass was available but was not used because the browser was
already signed in. Post-deploy verification remains for the release owner;
this corner does not deploy production.

The repeatable local stand-in uses the same opened/merged PR numbers and
corner links, plus a corner opening marker, through the production
`CornerOpenedMarker`, `NotificationLifecycleCard` and
`RepositoryLifecycleRow`. It substitutes surrounding Room content and
navigation callbacks so it never writes production messages. Web substitutes
device APIs and Unistyles with the real theme tokens; Android uses the native
runtime. The fixture is not a full authenticated Room screen.

Before the fix, the web receipts record a leading polygon on every PR row.
The new R1 component regressions fail on the original renderer.

## Demonstrated

R1 now renders a shared `CornerGlyph` on the corner opening row and no
leading glyph on any PR row. The disclosure summary, trailing chevrons and
corner navigation are preserved. Web receipts verify all three rows,
the exact corner polygon, the tapped PR's corner destination, no overflow
and no browser warnings in Bone and Obsidian.

Repeat web captures with:

```sh
node --import tsx apps/mobile/scripts/capture-lifecycle-glyph-web.mjs
```

For Android, generate the local native tree with Expo prebuild, set the
ignored app build.gradle entryFile to
`../../scripts/lifecycle-glyph-native-proof.tsx`, disable Expo Updates in
the generated manifest, and build assembleRelease for x86_64 with two workers
and a Gradle heap of 4 GiB. Install on this corner's emulator and run:

```sh
python3 apps/mobile/scripts/capture-lifecycle-glyph-android.py \
  --serial emulator-5554 --phase after --out .beeline-proof/lifecycle-glyphs
```

Screenshots and receipts beside this file show before/after in both themes
on web and native Android. The baseline Android bundle was captured before
editing the renderer and packaged without rerunning its bundle task. The
ignored Gradle build used `tasks.configureEach` with an `onlyIf { false }`
condition for `createBundleReleaseJsAndAssets` while packaging that baseline;
remove the condition before building the fixed app. Excluding the task with
`-x` does not work because Android resource mapping reads its output provider.
