# Shared UI library: before and after

Not a defect report. This is the approved library change (owner messages
200c30ad and 09310f97): the shared components only. Screens move onto them in
the second PR.

Each image is one fixture page: the "before" tree on the left, this branch on
the right. "Before" is `afb5bedb9` (settings-tabs-build head, which this branch
builds on). Both trees render the same fixture,
`scripts/shared-ui-library-proof.tsx`, with production components, fonts and
themes. Parts that did not exist before show "No shared … in this tree".

- Android: release Hermes fixture APK, Android 36, 1080 × 2400, 420 dpi, font
  scale 1.3. Files `cmp-android-<theme>-<page>.png`.
- Desktop: Chrome 1280 × 900, content column capped at 560. Files
  `cmp-web-<theme>-<page>.png`.

| Page | Mock section | What changes |
| --- | --- | --- |
| rows | 1 · Rows with a subtitle | Switch is brass when on. A disabled row fades. The description action no longer adds 44 px to its line. |
| sheet | 2 · One row (Message someone) | One 24 px left edge; the whole row is the tap target with a chevron; title in primary text. |
| headers | 3 · Section headers | CLEAR word action beside the count; every header keeps one height. |
| switch | 4 · One switch | One switch in Settings rows, sheet rows and bare; brass on, disabled-text off, dimmed when disabled. |
| buttons | 5 · Buttons and links | Four styles kept, each 44 px; new shared "Show 6 more" row. |
| states | 6 · Empty and error | New shared empty state; error banner with its own Try again button. |
| chrome | Sheets | Title one line in primary text, subtitle two lines, Cancel one sheet row tall, roster rows on the sheet edge. |
| dialog | Dialogs | Action labels end on the copy's edge. |

## Repeat

Desktop: `node scripts/render-shared-ui-library-proof.mjs <dir>`, then open
`<dir>/index.html?page=<page>&theme=<bone|obsidian>`.

Android: from `apps/mobile`, `npx expo prebuild --platform android --no-install`;
set `react.entryFile` to `file("../../scripts/shared-ui-library-native-entry.tsx")`
in `android/app/build.gradle`; set `expo.modules.updates.ENABLED` to false in the
manifest; `./gradlew :app:assembleRelease -PreactNativeArchitectures=x86_64`.
Install, run `adb shell settings put system font_scale 1.3`, and tap the page
and theme labels at the top of the fixture.
