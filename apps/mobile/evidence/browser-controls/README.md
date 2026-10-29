# Browser controls — BROWSER-CONTROLS-1

User-directed visual refinement; not a defect report. The baseline is `5a4e195d69743ce4d5c94a8618ac78f8fd915133`.

## Reproduced

Open a live browser share card, then its viewer. The baseline card has one “Open live browser” action instead of the artefact footer’s two destinations. The conversation dock uses the house radius (3px) while the keyboard control uses 14px.

The captures mount the production card, viewer, dock, composer, glyphs and theme tokens. The preview/remote page is a local fixture: these captures do not claim a production browser session, remote steering, clipboard or authentication proof. The native proof uses a task-owned Android emulator without a signed-in production session; a local WebView input is the closest stand-in for opening the remote keyboard. Its keyboard control CSS is copied from `apps/server/src/computer-session.ts`.

## Demonstrated

The after card has the same shared Button variants, labels, destination marks, text styles, spacing and left/right arrangement as ArtifactCard. Browser opening obtains fresh access; Open retains the in-app viewer path. Component tests cover refused access and ended cards. The computer dock’s outer radius is 14px collapsed and expanded; artefact docks retain 3px.

Web screenshots cover Bone and Obsidian at a real 390px touch viewport and a 1200px fine-pointer viewport, before/after, collapsed/expanded. The touch keyboard fixture focuses an input; only the Android evidence proves an OS keyboard. The keyboard control is hidden for fine pointers, matching the server stylesheet. Browser assertions check viewport width, expanded dock bounds, radius, footer destinations, fresh access and input focus.

## Re-run web captures

From repository root, install an optional screenshot driver outside the worktree:

```sh
npm install --prefix /tmp/browser-controls-tools puppeteer-core@25.16.0
cd apps/mobile
BROWSER_CONTROLS_CHROME_DRIVER=/tmp/browser-controls-tools/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js BROWSER_CONTROLS_BASELINE=5a4e195d69743ce4d5c94a8618ac78f8fd915133 npx vitest run sources/components/buzz/BrowserControls.browser.test.ts
```

The historical baseline must exist locally. Without the baseline variable only the current version is captured. Without the driver variable the optional screenshot suite skips. No new runtime or package dependency is introduced.

## Android fixture

`native-fixture.tsx.txt` is the source used for the proof APK. Copy it to `apps/mobile/scripts/browser-controls-native.tsx`; generate `browser-controls-before-ComputerSession.tsx` and `browser-controls-before-ViewerConversationDock.tsx` beside it with `git show <baseline>:apps/mobile/sources/components/buzz/<name>.tsx`, replacing relative `from './` component imports with `from '@/components/buzz/`. These temporary files are not app entry points in the shipped repository.

Run `npx expo prebuild --platform android --no-install` from `apps/mobile`, set the generated Gradle `react.entryFile` to `file("../../scripts/browser-controls-native.tsx")`, disable Expo Updates, and allow cleartext only in the generated proof manifest for the local fixture. Build `:app:assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2 -Dorg.gradle.jvmargs='-Xmx4g -XX:MaxMetaspaceSize=1g'`. The generated Android project is ignored and is not part of this change.

Serve `remote-input.html` as `/` on host port 8768 (copy it to a temporary directory as `index.html` and run `python3 -m http.server 8768 --directory <directory>`). It uses the server’s exact `#focus` and `#focus::before` CSS and a button that focuses the input. Start the task-owned emulator using `beeline emulator`, install the proof APK, launch it in its default Before/Obsidian/Card state, and run:

```sh
BROWSER_CONTROLS_ANDROID_SERIAL=emulator-<port> python3 apps/mobile/evidence/browser-controls/capture-android.py
```

The fixture switches between actual baseline/current components and both themes. It covers the footer, collapsed dock, expanded composer and WebView keyboard opening. The local page and sending operation are fixtures; authentication and a real remote browser are not claimed.

## Capture index

| Surface | Footer | Collapsed controls | Expanded conversation | Keyboard |
| --- | --- | --- | --- | --- |
| Bone touch web | [Before](before-bone-390-card.png) / [After](after-bone-390-card.png) | [Before](before-bone-390-collapsed.png) / [After](after-bone-390-collapsed.png) | [Before](before-bone-390-expanded.png) / [After](after-bone-390-expanded.png) | [Before](before-bone-390-keyboard.png) / [After](after-bone-390-keyboard.png) |
| Obsidian touch web | [Before](before-obsidian-390-card.png) / [After](after-obsidian-390-card.png) | [Before](before-obsidian-390-collapsed.png) / [After](after-obsidian-390-collapsed.png) | [Before](before-obsidian-390-expanded.png) / [After](after-obsidian-390-expanded.png) | [Before](before-obsidian-390-keyboard.png) / [After](after-obsidian-390-keyboard.png) |
| Bone Android | [Before](android-before-bone-card.png) / [After](android-after-bone-card.png) | [Before](android-before-bone-collapsed.png) / [After](android-after-bone-collapsed.png) | [Before](android-before-bone-expanded.png) / [After](android-after-bone-expanded.png) | [Before](android-before-bone-keyboard.png) / [After](android-after-bone-keyboard.png) |
| Obsidian Android | [Before](android-before-obsidian-card.png) / [After](android-after-obsidian-card.png) | [Before](android-before-obsidian-collapsed.png) / [After](android-after-obsidian-collapsed.png) | [Before](android-before-obsidian-expanded.png) / [After](android-after-obsidian-expanded.png) | [Before](android-before-obsidian-keyboard.png) / [After](android-after-obsidian-keyboard.png) |

Desktop fine-pointer captures use `1200` in place of `390`; the keyboard button is intentionally hidden there.

## Validation

- Root `npm run typecheck` passed.
- `npm run lint:ui-components` and `npm run lint:workflow-paths` passed.
- ComputerSession, ViewerConversationDock and existing viewer-dock browser suites passed (50 tests).
- Optional before/after browser-controls capture suite passed for both themes.
- Android proof APK built successfully; its SHA-256 is in `apk-sha256.txt`. The generated proof-only native configuration and APK are not shipped.
- Android captures completed in both themes before/after; all four keyboard dumps record `mInputShown=true`. Native screenshots retain actual glyphs and stacked placement; only the conversation outline changes.
- Limitation: no iOS hardware capture or production remote-browser transport exercise; the narrow local WebView fixture is documented above.
