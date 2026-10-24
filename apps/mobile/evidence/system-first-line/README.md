# System row chevron on the first line

Reproduction **SYSTEM-FIRST-LINE**, against main `22d7abec6b91428d78c93b040cdd43dd7f9b31e2`.

Open the reported schedule notice, expand it, then collapse it. Main puts the
chevron in a separate empty row below the message. The new browser alignment
assertion fails against main in Bone and Obsidian at phone and desktop widths.
The fixed component keeps the chevron beside the first line, points it down
while expanded, and returns to a two-line preview when collapsed.

The replay uses production `LedgerSystemLine`, `LedgerDisclosure`, glyphs,
fonts and theme tokens. A signed-in production Room cannot load this unshipped
change, so the stand-in is the same component in Chromium/React Native Web and
an Android debug build on a leased emulator. Native-only navigation and live
presentation dependencies are shimmed in the web harness; measured components
are real. Identity/URL callbacks write visible receipts instead of navigating
to production accounts. Desktop proof covers the shared web renderer, not a
packaged macOS Tauri shell.

The shared disclosure gains a first-line rich-content layout used only by
cut-off system messages. Text starts at the existing steps-label indent
(14px glyph plus 8px gap). The hidden measurement keeps its original full width.
The timestamp and caller-message block retain their existing styles. Short
rows retain their original markup, location, height and text start. The
indent matches option A: expandable text is inset; short text stays flush.

## Browser proof

`disclosure-rows.browser.test.ts` asserts first-line chevron geometry, no
separate chevron-only row, label indent, minimum touch height, expansion from
the row edge, right/down direction, accessible expanded state, preserved text,
full-width stable measurement, and name/link actions without toggling. Short
row geometry is compared to checked-in main receipts, not to the new layout.
The existing disclosure and system-line tests cover unchanged neighboring
rows, independent expansion, caller text, legacy notices and large type.

From `apps/mobile`:

```sh
DISCLOSURE_SCREENSHOT_DIR=evidence/system-first-line/after npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1 -t 'system=true'
SYSTEM_OPENED=1 DISCLOSURE_SCREENSHOT_DIR=evidence/system-first-line/after-open npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1 -t 'system=true'
```

For main captures, temporarily restore `Ledger.tsx` and `LedgerDisclosure.tsx`
from the commit above; use `SYSTEM_BASELINE=1` and the `before`/`before-open`
directories. That mode confirms the old misalignment and writes the short-row
geometry receipts. Without it, the new assertions fail on the old source.
Restore both changed files afterward.

## Android proof

Build the debug app for `x86_64` with two Gradle workers and a 4 GiB heap.
Temporarily set package `main` and generated `MainApplication`'s JS entry to
`scripts/disclosure-rows-native-proof`. Start Metro on a private port, bridge
it with `adb reverse`, and open its development-client URL. Dismiss the Expo
first-run developer menu. Start each phase at the top of the Bone screen.

```sh
python3 scripts/prove-system-first-line.py --serial emulator-<leased-port> --phase before
python3 scripts/prove-system-first-line.py --serial emulator-<leased-port> --phase after
```

Between phases restore the changed components and restart Metro and the app.
Generated Android files and the temporary package entry must not be committed.
The script checks native expand/collapse, minimum target height, the subject
name's callback without toggling, and unchanged short-row bounds/text start.
The before/after screenshots show first-line placement in both themes.

## Screenshots

Each closed image includes the short row and both clipped rows; open images
show expanded content. Difference images compare the same replay and viewport.

| Surface | Main closed | Fixed closed | Main open | Fixed open | Difference |
| --- | --- | --- | --- | --- | --- |
| Phone web · bone | [before](before/web-390-bone-system.png) | [after](after/web-390-bone-system.png) | [before](before-open/web-390-bone-system.png) | [after](after-open/web-390-bone-system.png) | [diff](diff/web-390-bone-system.png) |
| Phone web · obsidian | [before](before/web-390-obsidian-system.png) | [after](after/web-390-obsidian-system.png) | [before](before-open/web-390-obsidian-system.png) | [after](after-open/web-390-obsidian-system.png) | [diff](diff/web-390-obsidian-system.png) |
| Desktop web · bone | [before](before/web-1280-bone-system.png) | [after](after/web-1280-bone-system.png) | [before](before-open/web-1280-bone-system.png) | [after](after-open/web-1280-bone-system.png) | [diff](diff/web-1280-bone-system.png) |
| Desktop web · obsidian | [before](before/web-1280-obsidian-system.png) | [after](after/web-1280-obsidian-system.png) | [before](before-open/web-1280-obsidian-system.png) | [after](after-open/web-1280-obsidian-system.png) | [diff](diff/web-1280-obsidian-system.png) |
| Android · bone | [before](before/android-bone-closed.png) | [after](after/android-bone-closed.png) | [before](before/android-bone-open.png) | [after](after/android-bone-open.png) | [diff](diff/android-bone-closed.png) |
| Android · obsidian | [before](before/android-obsidian-closed.png) | [after](after/android-obsidian-closed.png) | [before](before/android-obsidian-open.png) | [after](after/android-obsidian-open.png) | [diff](diff/android-obsidian-closed.png) |

## Results

- New first-line regression: fails on main for both themes and viewport widths;
  passes on the changed component, including row-edge taps and nested actions.
- Android: both themes pass expand/collapse and subject-tap checks. Short-row
  bounds and text start match main; the short-row screenshot region is also
  pixel-identical in both themes. Browser short-row regions are pixel-identical
  at both widths in both themes.
- Root typecheck and UI component policy pass. Targeted Ledger, disclosure,
  system-line browser, calm-design and design-lint tests pass (75 tests).
- Native debug build succeeds with two workers and a 4 GiB JVM heap.
