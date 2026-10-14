# Unified corner PR rows

## Reproduced

Reproduction corner-pr-cards-1: render a landed corner notification alone, then
render two adjacent landed corner notifications through `foldPrLifecycleRuns`.
The single card said `PR 1 merged`, put its author in the header and used a regular
row title. The grouped card used a bold row title, put the author below the meta
line, displayed a plain Corner link and omitted View. Both themes reproduced it.

Before source: `886497ac8` (the starting checkout). Android 36, x86_64,
1080 × 2400, 420 dpi, isolated emulator leased with `beeline emulator`.
The standalone Hermes release fixture renders production `DaemonFactCard` and
`NotificationLifecycleCard`, with production fonts, themes and folding. It uses
the two corner names and PR numbers from the supplied screenshot; two items
suffice to exercise the grouped path. No live account or server is needed.

| Theme | Before | After |
| --- | --- | --- |
| Bone | [single and grouped](android-before-bone.png) | [single and grouped](android-after-bone.png) |
| Obsidian | [single and grouped](android-before-obsidian.png) | [single and grouped](android-after-obsidian.png) |

## Demonstrated

Reproduction corner-pr-cards-1 now passes: both cards use `CornerPrRow`, the same
bold title, state column, `corner · PR #N` line and author placement. Headers use
`PR · N merged`. Each presented corner PR row has the shared filled primary
Corner button and quiet secondary View button. The existing PR URL survives
folding and subsequent cleanup; grouping, identity matching and collapse rules
are unchanged.

The Android driver captures both themes, taps both actions on the single and
grouped cards, expands the accordion, selects its contracted row, taps that row's
View action and collapses it again. The fixture prints callback destinations on
screen; the driver asserts those exact destinations. This verifies production
controls and callback wiring, without opening a live corner or external browser.
See [before observations](android-before-results.json),
[after action results](android-after-results.json), and adjacent Android UI XML.

Component coverage runs both Android and web paths, asserts the shared component
and primary/quiet action variants, checks destinations, and compares a
one-identity folded group with the single row. Existing closed-without-PR,
stacking, identity/deduplication, checks and design regressions remain covered.

Validation: 161 tests across `RoomMessageVariants.test.tsx`,
`pr-accordion.test.ts`, `github-lifecycle-fold.test.ts`, `ci-accordion.test.ts`,
`calm-lint.design.test.ts`, and `design-lint.design.test.ts`; root
`npm run typecheck`; `node scripts/check-mobile-ui-components.mjs`.

## Repeat Android proof

From `apps/mobile`, generate Android with
`npx expo prebuild --platform android --no-install`. In the generated
`android/app/build.gradle`, set `react.entryFile` to
`file("../../scripts/corner-pr-cards-native-proof.tsx")`. Disable
`expo.modules.updates.ENABLED` in its generated manifest. Build with
`./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64 --max-workers=2`
from `android`, install that fixture APK on the leased emulator, then run from
repository root:

```sh
python3 apps/mobile/scripts/corner-pr-cards-android-proof.py \
  --device emulator-5554 --phase after --out apps/mobile/evidence/corner-pr-cards
```

For the before captures, run the same fixture and driver (`--phase before`)
against the starting source. Generated native files and APKs are not committed.
