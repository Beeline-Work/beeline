# Card and tray button consistency

Approved brief revision 3. This fixes Reproduction R1 (mixed decision buttons and a stranded source link) and R2 (a tray grant exposing a full command and script before its reason).

The card and server tray projection now use `grantPresentation` for purpose and Runs/Touches/Can facts. The tray retains its plain row and exposes the bound script through the same `LedgerDisclosure` as the card. Alternatives are boxed, the recommended choice is filled, and links sit at the footer start outside the decision row. Busy decisions retain their labels.

## Reproduced

Baseline `9ea5827af`, production React Native components rendered through React Native Web:

- R1: open the pending System DM grant and its tray row. No/Once/Always use mixed styles; the tray fills both Once and Always. View request follows the choices. The settled grant prints scope separately.
- R2: open the tray for the grant with a bound script (101 lines). The absolute command precedes the reason and the full script is expanded.

`before-{bone,obsidian}-{360,411,960}.png` captures every listed card in a gallery: grant pending/settled, tray, repository onboarding, star prompt, Squire, settled permission, connector, artifact, browser card/controls and call Join.

## Demonstrated

The corresponding `after-*.png` galleries use the changed production components with identical fixtures. At the narrower phone width the source link sits above the trailing decision row, aligned left; at the wider phone width it shares the line. Scope and decision form one settled status line.

`card-buttons.browser.test.ts` opens the tray disclosure, confirms the script appears without opening the source, checks matching card/tray purpose and Runs text, verifies the filled/boxed decisions and link geometry, and checks busy labels. It runs at both phone widths and desktop in Bone and Obsidian. `ButtonRow.test.tsx` rejects a second primary or any link inside the decision row. The existing choice-plate browser proof confirms those plates remain unchanged.

Native proof uses a locally built `app.usebeeline` debug APK (`:app:assembleDebug`, x86_64), the real Unistyles/gesture runtime and the production `GrantRequestCard` and `NeedsYouCell`. `android-results.json` records the phone densities, button bounds, initially folded scripts and successful disclosure taps. Native captures cover pending grant, settled grant/tray, and opened tray script in both themes and phone widths.

The Android proof is a fixture entry in the real native build, not a live authenticated System DM: it avoids generating or deciding a real host grant. Script bytes and source callbacks are inert fixtures. Web captures also replace network/device services and artifact previews; the affected card components, Button, ButtonRow, fact rows and disclosure remain real. The Room's repository-prompt Dismiss call site is checked by typecheck and UI policy; the gallery exercises the same shared quiet control rather than an authenticated Room shell.

## Reproduce the proof

Build workspace packages first (`npm run corner:prepare`). Do not run a workspace rebuild while a renderer consumes `dist/`.

```sh
node --import tsx apps/mobile/scripts/render-card-buttons.mjs before
node --import tsx apps/mobile/scripts/render-card-buttons.mjs after
npm run test --prefix apps/mobile -- --run sources/test/card-buttons.browser.test.ts sources/test/tray-choice-plates.browser.test.ts sources/components/buzz/ButtonRow.test.tsx --maxWorkers=1
```

The renderer reads baseline component sources from git, inlines the actual fonts and writes disposable output under `.beeline-proof/cards`. Native entry: `apps/mobile/scripts/card-buttons-native-proof.tsx`. Use it as the local Metro entry of a debug build, then:

```sh
python3 apps/mobile/scripts/capture-card-buttons-android.py --device emulator-PORT --out .beeline-proof/native
```

The native capture expects the corner's Metro fixture on port 8086 and a leased emulator with a physical width of 1080 pixels. It sets density to 480/420 for 360/~411 dp and leaves the emulator and installed app available to the corner.

## Validation

- Root typecheck after integrating `origin/main`.
- Mobile UI component policy and workflow path lint.
- Targeted mobile regression/design suites: 24 tests.
- API contract suite: 524 tests; client suite: 150 tests; protocol suite: 8 tests.
- Server Needs-you suite: 36 tests, including grant visibility, source identity, exact decisions, standing-only grants and the new shared facts.
- Impeccable mechanical scan: no findings.
