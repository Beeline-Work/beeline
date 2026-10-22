Native stand-in for Reproduction R1: mounts the production TurnProgressLine and
TurnBandSlot with the real theme, fonts and geometry. The surrounding message and
composer are fixtures; this does not connect to a production Room.

Expo Go lacks the app's Unistyles runtime and ships different Worklets/SVG
versions. The preview resolves themes directly, replaces the outer opacity pulse
with View, and selects reduced motion for the production mark. Thus screenshots
prove native placement and static mark rendering, not the animation timeline.
Restored component tests separately cover live ribbon props and reduced motion.

From this folder, install the preview-only compatible SVG (never alter the app's
package.json or lockfile):

    npm install --no-save --package-lock=false --ignore-scripts react-native-svg@15.15.3

Start with `../node_modules/.bin/expo start --go --localhost --port 8099`.
Boot an isolated leased emulator with `beeline emulator -avd buzzy_api36
-no-window -gpu swiftshader_indirect`. Select it with `adb -s emulator-<port>`;
reverse tcp:8099 and open exp://127.0.0.1:8099 in Expo Go. Dismiss its first-run
menu. Set proof-theme.ts to bone or obsidian and reload for each screenshot.

Before capture: omit only the live glyphCell (as #2757 did), reload and observe
that the label begins at 8dp. Restore the cell and reload: the fixed 18dp mark
plus 8dp gap moves the label to 34dp, matching 137fbfa71^ exactly. Capture with
`adb -s emulator-<port> exec-out screencap -p > <image>.png`.
