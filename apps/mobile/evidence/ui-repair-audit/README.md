# UI audit and repairs

Reproduction **UI-AUDIT-1**. The commander's brief covers the UI changes in
PRs #3016, #3014, #3006, #3019 and #3030. `manifest.json` inventories every
changed UI surface and maps each finding to its parent, main and fixed capture.
The self-contained HTML artifact posted in the corner includes the owner's
original screenshots and all three columns. Generate the repository-evidence
version with:

```sh
python apps/mobile/scripts/ui-repair-audit/build-artifact.py /tmp/ui-audit.html
```

## Reproduced

At phone width, the real browser header's link and close centres differ by
12.5 px. This offset already exists in the parent; the sweep lengthens the link.
The Google Calendar continuation action moves below its footer note and grows
the card from 245 to 267 px. The bookmark footer's drawn arrow increases its row
from 15 to 18 px. The actual HTTP browser proxy, pinched out, puts its page below
a 229 px top gap and adds an emoji paste button.

## Demonstrated

The same production-control and HTTP-proxy paths now show:

- Browser link and close share the same vertical centre; the row remains 44 px.
- The short `Continue sign-in` action stays right-aligned. The owner-requested
  removal of the connecting-for line restores the original single-row footer.
  The card is 244 px at both widths: removing the old 45 px wrapped note leaves
  the unchanged 44 px button as the footer height. Reconnect and outcome lines remain.
- The bookmark footer returns to 15 px with a drawn chevron.
- Pinch-out leaves the page at top 0, retaining horizontal centering.
- There is no paste button; desktop clipboard shortcut tests still pass.
- Structured navigation to the remote `vnc.html` sign-in window hides the host
  keyboard; ordinary browser navigation restores it.
- Explicit ended sessions show the existing Beeline notice and no browser link.

The production-control fixtures use real fonts and a 390 px root in Chrome;
device APIs, network reads and modal transport are stubbed. Private component
exports are generated only in scratch copies. The inspector header and tray
footer are isolated caller compositions, not full navigation sessions. The
HTTP proxy uses a local Squire viewer fixture and an isolated PGlite database.
Owner-device replay was unavailable; these are the closest stand-ins.

## Fresh Android evidence

The APK was built locally from main `f25b955b6` native configuration, with an
isolated fixture mounting the unchanged production CommunityRail and RepoPicker.
The same fixture mounts those components from the label sweep's true parent for
before captures. It uses Android 15 (API 35), three-button navigation, screen
1080 × 2400 and density 420. These are fresh captures, not the old PR screenshots:

- `android-armed-parent.png` and `android-armed-bone.png`: actual long press arms
  the exit control; both marks retain the original seat.
- `android-search-parent.png` and `android-search-bone.png`: type
  `Beeline-Work/layout-review`; compare missing-repository explanation, connect
  row and account action. The paired XML records the native bounds and labels.
- `android-navbar-bone.png` and `android-navbar-obsidian.png`: release-mode APK,
  after the actual app theme change path. Body and bar pixels match exactly:
  Bone `(243,238,228)`; Obsidian `(20,9,26)`. With matching system/app themes,
  home-button pixels are `(68,70,79)` and `(197,198,208)` respectively.

The installed Expo SDK documents that Android 15 emulators can ignore
`NavigationBar.setStyle` when switching independently of system appearance
(`node_modules/expo-navigation-bar/src/NavigationBar.ts`). Both theme captures
therefore pair system appearance with the app appearance. This audit does not
claim a physical-device or independent-theme button-color proof. Historical
`navbar-before.png` is the original merged PR's native baseline; the fresh main
captures replace its old after screenshots. No iOS proof was requested.

## Repeating the web comparisons

From the repository root, prepare separate scratch trees:

```sh
node apps/mobile/scripts/ui-repair-audit/prepare.mjs /tmp/ui-parent '503010cd9^'
node apps/mobile/scripts/ui-repair-audit/prepare.mjs /tmp/ui-main f25b955b6
node apps/mobile/scripts/ui-repair-audit/prepare.mjs /tmp/ui-fixed working
```

Then, from `apps/mobile`, run the opt-in capture test:

```sh
UI_AUDIT_BEFORE_MOBILE=/tmp/ui-parent/apps/mobile \
UI_AUDIT_MOBILE=/tmp/ui-main/apps/mobile UI_AUDIT_DIR=/tmp/ui-captures \
npx vitest run sources/test/ui-repair-audit.browser.test.ts --maxWorkers=1 --minWorkers=1
UI_AUDIT_FIXED=1 UI_AUDIT_MOBILE=/tmp/ui-fixed/apps/mobile \
UI_AUDIT_DIR=/tmp/ui-captures npx vitest run \
sources/test/ui-repair-audit.browser.test.ts --maxWorkers=1 --minWorkers=1
```

`scene.tsx.template` preserves the exact fixture; `prepare.mjs` installs it in
scratch alongside temporary private-component exports. Existing usage-section
source is identical at the chosen parent and the parent of #3030.

For native reproduction, copy `native.tsx.template` to a temporary mobile script,
extract parent CommunityRail/RepoPicker as its two `.audit-before` imports, and
point a backed-up `index.ts` at the fixture. Run Expo Android prebuild, build a
release-mode x86_64 APK (debug signing is sufficient for this local proof), and
install on this corner's leased emulator. The fixture exposes Rail, Search,
Before and Theme. Use a real long press and actual keyboard search entry, waiting
for native layout after each step. Restore the entry and remove generated copies
afterward; they are not product changes. The source templates are inert and are
never part of the app entry.

`viewer.mts.template` preserves the isolated HTTP proxy proof, originally run from
`.local/ui-audit/viewer-proof.mts` with a local playwright-core installation and
the #3014 parent source temporarily extracted as
`apps/server/src/computer-session.audit-before.ts`. `AUDIT_FIXED=1` selects the
working implementation. It verifies remote/ordinary keyboard modes and writes
page/pinch captures. The regular `computer-session.test.ts` also exercises these
paths in Chrome, including clipboard isolation and touch gestures.

## Squire side

Squire must send a host-ended signal when its login window closes. Beeline then
uses its existing ended state. The owner's screenshot instead shows a closed
remote login page inside a share that is still live. Per commander direction,
this PR neither infers closure from pixels nor opens or edits Squire work.
Typing inside the remote login window is also outside this PR.


## Owner follow-up: continuation footer

Reproduction **UI-AUDIT-FOOTER-1**: the first short-action version squeezed
CONNECTING FOR SOMEONE into three lines. A separate note row made the card
267 px tall. The owner's subsequent decision removes that connecting line
entirely, including the switching-for variant, and removes the new row option.
Automatic Reconnecting… and settled outcome lines are unchanged.

`connectorLong-fixed-{390,360}-{bone,obsidian}.png` and JSON prove there is no
connecting note, the action remains Continue sign-in with a 17 px right inset,
and card height is 244 px at both widths. This is one pixel below the earlier
245 px because the removed three-line note was 45 px tall; the button is 44 px.
No compensating spacing or type changes were added.

`connectorLong-android-{390,360}-{bone,obsidian}.png` are fresh release-mode
Android captures of this production card while sign-in is in progress. Each
viewport is exact: emulator density 480, width 1170 or 1080 physical pixels.
The native card is 242 dp tall at both widths (Android font metrics differ from the browser); its action keeps a 17 dp right inset. The matching XML records native accessibility bounds. The dedicated fixture
is `footer-native.tsx.template`; it changes no production navigation.

Repeat rendered assertions with a prepared working scratch tree:

```sh
UI_AUDIT_FOOTER=1 UI_AUDIT_MOBILE=/tmp/ui-fixed/apps/mobile \
UI_AUDIT_DIR=/tmp/ui-captures npx vitest run \
sources/test/ui-repair-audit.browser.test.ts --maxWorkers=1 --minWorkers=1
```
