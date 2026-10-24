# Section label surfaces — Reproduction R1

R1: Settings → Connectors → Search → SUGGESTED paints the screen color over the raised sheet. The Android stand-in reproduced the lighter band in Bone and darker band in Obsidian. The same header also mismatched appCanvas on the Connectors index, deep-link Search page and connector detail page in Bone, and bgHighlight in the repository prompt in both themes.

The fix makes ordinary section labels transparent by default. Existing sheet spacing stays intact. Explicit screen fills remain available. RepoPicker's entire sticky owner row now paints the containing repository prompt's bgHighlight, including its count, so rows cannot show through it.

## Evidence

Every view below has before and after captures on an isolated Android emulator and a desktop browser, in both themes. Names are `<phone|desktop>-<bone|obsidian>-<surface>.png` under [before](before/) and [after](after/).

| Surface | Production view exercised |
| --- | --- |
| sheet | ConnectorsSearchSheet, including SearchContent, HullActionSheetModal, SettingsRow and RoomListSectionHeader |
| page | ConnectAppScreen (the deep-link Search page) |
| workbench | WorkbenchScreen (Settings → Connectors index) |
| service | ConnectorServiceScreen (Trusty Squire → Your computers) |
| repos | RepoPicker in the production caller's highlighted prompt surface |

[Audit with all header call sites](AUDIT.md).

The user's Android device is unavailable to this agent. These are local native/browser stand-ins: connector data, navigation, service logos and network actions are fixtures; UI components, fonts, tokens and surface styles come from production source. The repository prompt's outer View uses the caller's padding, border and bgHighlight; RepoPicker itself is production code. Expo Go adapters replace Unistyles theme selection, unused keyboard services, device classification, and motion with static/reduced-motion equivalents. They do not replace the measured header, sheet or rows. The blue Tools bubble is Expo Go chrome. This proves rendered fills, not production authentication or connector network behavior.

Before captures used the original RoomListSectionHeader and RepoPicker from d73db4511; after captures used this change. No screenshot colors were edited.

## Repeat

From `apps/mobile/surface-proof`:

```sh
npm install --no-save --package-lock=false --ignore-scripts --legacy-peer-deps react-native-svg@15.15.3
EXPO_OFFLINE=1 NODE_OPTIONS=--dns-result-order=ipv4first ../node_modules/.bin/expo start --go --localhost --port 8100
```

Use `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect` for an isolated leased emulator. Set `ANDROID_SERIAL` to its adb id, reverse port 8100, then run `python3 apps/mobile/surface-proof/capture.py after` from the repository root. This clears only Expo Go data on the selected emulator, dismisses its first-run developer menu and captures the five views in both themes. It does not use a signed-in production app.

From `apps/mobile`:

```sh
SURFACE_SCREENSHOT_DIR=docs/evidence/section-surfaces/after npx vitest run sources/components/buzz/section-surface.browser.test.ts --maxWorkers=1
npx vitest run sources/components/buzz/section-surface.design.test.tsx sources/components/buzz/RepoPicker.test.tsx sources/components/buzz/settings-row.design.test.ts --maxWorkers=2
```

The browser test asserts real rendered headers have no contradictory fill. For an intentional baseline capture only, `SURFACE_BASELINE=1` records the old opaque headers without expecting the corrected fill. The design test checks both themes, sheet/page/highlight/screen containers, explicit opaque headers and the sticky repository row's matching fill.

## Release

JavaScript-only styling; no native module, palette, layout or copy change. Eligible for the normal compatible OTA/web update; no store binary is required by this fix.

## Capture index

| View | Theme | Phone before | Phone after | Desktop before | Desktop after |
| --- | --- | --- | --- | --- | --- |
| sheet | bone | [before](./before/phone-bone-sheet.png) | [after](./after/phone-bone-sheet.png) | [before](./before/desktop-bone-sheet.png) | [after](./after/desktop-bone-sheet.png) |
| sheet | obsidian | [before](./before/phone-obsidian-sheet.png) | [after](./after/phone-obsidian-sheet.png) | [before](./before/desktop-obsidian-sheet.png) | [after](./after/desktop-obsidian-sheet.png) |
| page | bone | [before](./before/phone-bone-page.png) | [after](./after/phone-bone-page.png) | [before](./before/desktop-bone-page.png) | [after](./after/desktop-bone-page.png) |
| page | obsidian | [before](./before/phone-obsidian-page.png) | [after](./after/phone-obsidian-page.png) | [before](./before/desktop-obsidian-page.png) | [after](./after/desktop-obsidian-page.png) |
| repos | bone | [before](./before/phone-bone-repos.png) | [after](./after/phone-bone-repos.png) | [before](./before/desktop-bone-repos.png) | [after](./after/desktop-bone-repos.png) |
| repos | obsidian | [before](./before/phone-obsidian-repos.png) | [after](./after/phone-obsidian-repos.png) | [before](./before/desktop-obsidian-repos.png) | [after](./after/desktop-obsidian-repos.png) |
| workbench | bone | [before](./before/phone-bone-workbench.png) | [after](./after/phone-bone-workbench.png) | [before](./before/desktop-bone-workbench.png) | [after](./after/desktop-bone-workbench.png) |
| workbench | obsidian | [before](./before/phone-obsidian-workbench.png) | [after](./after/phone-obsidian-workbench.png) | [before](./before/desktop-obsidian-workbench.png) | [after](./after/desktop-obsidian-workbench.png) |
| service | bone | [before](./before/phone-bone-service.png) | [after](./after/phone-bone-service.png) | [before](./before/desktop-bone-service.png) | [after](./after/desktop-bone-service.png) |
| service | obsidian | [before](./before/phone-obsidian-service.png) | [after](./after/phone-obsidian-service.png) | [before](./before/desktop-obsidian-service.png) | [after](./after/desktop-obsidian-service.png) |
