# Reproduction viewer-dock-overflow

The production dock is mounted over a fixture titled “Call states and endings (1–9)”. Send “Explain these states”, then deliver a 5,000+ character reply containing bold text and a 45-item markdown list. Delivery is local; no model or production account is used.

## Reproduced

Browser baseline: `c8add974774c08c9ab55d118d28dc8c5daa826e4`. With the real fonts loaded, the expanded panel measured 3,189px in a 761px window. It had no scroll container and showed raw `**FIRST LINE**`. See `baseline.png`.

## Demonstrated

The fixed production dock measures 304.4px in a 761px browser window and 184.4px in a 461px window (40%, with subpixel rounding). Its ScrollView opens at the newest message, can reach the first line, and renders bold and list items through the Room's `MonoMarkdown`. The composer sits below the panel; the viewer control above remains tappable. See `top.png` and `newest.png`.

The browser proof replaces the native composer, attachment picker, and navigation boundaries. The dock's send/arrival handling, layout, scrolling, markdown parser and renderer are real. It loads the production fonts before measuring.

Run from `apps/mobile`:

```sh
npx vitest run sources/components/buzz/ViewerConversationDock.browser.test.ts --maxWorkers=1
VIEWER_DOCK_BASELINE_REF=c8add974774c08c9ab55d118d28dc8c5daa826e4 npx vitest run sources/components/buzz/ViewerConversationDock.browser.test.ts --maxWorkers=1
```

The optional baseline reference must exist locally; CI only runs the fixed proof. Component coverage also checks rotation updates the cap and collapsed previews still use two lines.

## Android fixture

`scripts/viewer-dock-overflow-native.tsx` mounts the production dock and composer with the same local reply and real fonts. This is a stand-in for the original private DM artifact; a clean task-owned emulator has no signed-in DM session. It does not establish access to, or reproduce the content of, that private artifact.

Generate an ignored Android project with `npx expo prebuild --platform android --no-install`. Set its `react.entryFile` to `file("../../scripts/viewer-dock-overflow-native.tsx")`, disable Expo Updates in the generated manifest, and build `assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2`. Install only on the task-owned emulator launched with `beeline emulator`.

Android 36 / 420dpi / 1080×2400: `android-newest.png` opens on **NEWEST LINE**; `android-top.png` follows twelve downward touch swipes to **FIRST LINE**. UIAutomator measures the panel at `[42,1201][1038,2161]`: 960px, exactly 40% of the screen. The native ScrollView reports scrollable, and collapsing/reopening the dock returns to the newest line. The composer toggle remains tappable. See `android-measurements.json` for bounds and the fixture APK hash.

Native verification caught an initial-layout race: scrolling synchronously from the content-size callback left Android at the top. Native now waits one animation frame for layout to commit; web uses its already-committed layout. The component regression covers that timing.

Validation: root `npm run typecheck`; 32 tests across dock component/browser, viewer conversation, and design suites; `npm run dead-code` (91 existing findings, zero introduced); Android release fixture build and manual touch scrolling. No release or production session was used.
