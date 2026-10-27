# Reproduction member-sheets-android

Open Room Members with six members (two people and four agents, including Ruby
with `Default (recommended)`), then open Add people or agents with eight candidates.

Before: the Members sheet shows an orphan count and add icon below its heading,
Ruby shows a truncated placeholder, and candidate avatars/checkboxes crowd the
picker edges. `before-roster.png` and `before-picker.png` capture this on Android.
The browser regression also failed before the fix with `Orphan count head must be absent`.

After: Add sits beside Close, there is no count head, Ruby has no model label,
and real models remain. Picker rows, invite/connect actions, title and footer
use the sheet inset. The shared row default remains unchanged.

## Proof setup

The Android captures use the production sheet components in an isolated Expo Go
fixture, not the owner's authenticated production session (not installed on this
corner's emulator). The fixture has the owner's data shape; avatar colors and
some faces differ because these are synthetic identities. Device: Android API 36,
1080 × 2400, default font scale. Light and dark themes use production theme tokens.
Only Unistyles runtime, animation, unused keyboard/device services, and SVG's
Expo Go-compatible native bridge are adapted. Rows, sheets, model formatting,
buttons, and native layout are production code.

From `apps/mobile/member-sheets-proof`, install the fixture SVG dependency with
`npm install --legacy-peer-deps --ignore-scripts`, then run
`../node_modules/.bin/expo start --go --port 8090`.
Use `adb reverse tcp:8090 tcp:8090`, open `exp://127.0.0.1:8090` in Expo Go,
and use Open Members → Add. Change `settings.js` between `bone` and `obsidian`
and reload for both themes. The fixture also offers manager/viewer and empty/populated toggles.

Browser regression: from `apps/mobile`, run
`npx vitest run sources/components/buzz/member-sheets.browser.test.ts`.
It exercises populated roster/picker, model labels, same-heading Add/Close,
manager permissions, empty-Room access, row/action insets and candidate submission.

## Results

- Before and after captures inspected at full size; both themes preserve all six roster rows.
- Android: Add opens the picker; selecting chloropine and pressing Add produces
  `Added candidate-0` in the fixture callback output.
- Browser: populated sheets, viewer permission, empty Room access, model labels,
  sheet insets and submission all pass.
- Affected roster/picker/model tests pass (59 tests across eight files).
- Mobile typecheck, UI component policy, design lint and calm lint pass.

The earlier tree test expected page-row height; it now asserts the sheet height
and inset. Invite/connect rows already use `HullActionSheetRow`, which supplies
the sheet preset; regression coverage protects their alignment without changing them.
