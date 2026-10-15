# Android rail Add clipping

Reproduction rail-add-android-1: open the 72dp Workspace rail with four Workspace tiles, then inspect the plus above ADD. The original hero text has a 32dp line height inside an explicit 22dp height; Android cuts off the bottom of the plus. Removing the height lets the text and its command grow to their measured content.

## Native proof

Android 36 emulator, leased through `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect`. Phone: 1080×2340, 420dpi (411dp wide). Tablet: 1600×2560, 320dpi (800dp wide). Both Bone and Obsidian were captured. Phone font scale 1.3 also preserves the full plus and ADD; restored to 1.0 afterwards.

The owner's signed-in Room screen was unavailable in this isolated emulator. The stand-in at `apps/mobile/rail-proof` mounts the production `CommunityRail` in its actual 72dp drawer container with the real fonts, theme tokens, native Text, TouchableOpacity and ScrollView. Unistyles resolves its factory against the real theme; animations and device classification are adapted for Expo Go. Workspace identity pictures use same-size plain seats because Expo Go's SVG native version differs. The rail's production text, sizing, spacing, safe-area hook and handlers are unchanged. Tapping ADD displays a local callback receipt, not a real Workspace creation flow. No proof code is imported by the shipped app.

| Native measurement | Before phone | After phone | After tablet |
| --- | --- | --- | --- |
| Plus text box | 58px / 22dp | 84px / 32dp | 64px / 32dp |
| ADD button | 189×129px | 189×155px | 144×118px |
| ADD label | fully present | fully present | fully present |
| Tap callback | — | PASS | PASS |

The before screenshot visibly cuts the plus's lower stem; the after screenshots show both full stems and ADD. The button now grows to about 59dp, matching the 58dp tile slot rhythm while retaining at least a 48dp touch target. Native hierarchy dumps accompany the captures, including callback receipts in `phone-tap.xml` and `tablet-tap.xml`.

SETTINGS uses a separate label style, not the fixed glyph height. At the default scale its label fits inside the 72dp rail. At 1.3 font scale it wraps; that independent width behavior is outside this fix under the brief's same-cause condition.

## Repeat

From `apps/mobile/rail-proof`, run `../node_modules/.bin/expo start --go --port 8091 --android --max-workers 2`. Set `proof-theme.ts` to Bone or Obsidian before capturing. Select the leased emulator explicitly:

```sh
adb -s emulator-5554 reverse tcp:8091 tcp:8091
adb -s emulator-5554 shell wm size 1080x2340
adb -s emulator-5554 shell wm density 420
adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8091 host.exp.exponent
adb -s emulator-5554 exec-out screencap -p > phone.png
```

For tablet use size `1600x2560`, density `320`. Wait for the rail to render before capture. Tap its accessible `Create or join a Workspace` button and confirm `PASS: ADD opened`. To recreate the before result, temporarily restore `height: 22` under `railCommandGlyph`, then remove it again.

## Regression

The new component cases fail on the original height in both rail and column presentations (`regression-before.txt`) and pass after its removal. The targeted suite includes CommunityRail, Workspace navigation contracts, Calm lint and Design lint: 34 tests pass (`regression-after.txt`). Root `npm run typecheck`, mobile UI policy and the design detector also pass. iOS was excluded as requested.
