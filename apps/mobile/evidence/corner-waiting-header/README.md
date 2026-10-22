# R1: waiting header names the blocker

Android API 35, 412 dp display width, system font scale 1.3.

The emulator is a fresh isolated device without a signed-in Beeline session. This is a native stand-in using the shipped `CornerHeaderAgentText` and transcript scroll controller, fed the original and fixed blocker shapes. It is not a production corner screenshot. The server-backed `corner-server-push.test.ts` separately inserts a real hold, reads PhoneService's corner and chat projections, validates them through the API guards and renders that header.

- `android-before-font-1.3.png`: legacy hold UUID offered as an approval message target. Tapping approve attempts the jump but reaches no message.
- `android-after-font-1.3.png`: same held corner, fixed projection. Own hold, another person's hold and a messageless report are plain text; the own-hold line remains fully readable on one line. Tapping it invokes no jump.
- `android-message-jump-font-1.3.png`: an actual approval message still invokes the message jump.

The companion XML captures assert that hold and report text has no actionable child. Native capture checks run in `hold-proof/capture.py`.

Re-run with an isolated emulator (replace the serial in capture.py if needed):

```sh
adb -s emulator-5558 shell settings put system font_scale 1.3
adb -s emulator-5558 reverse tcp:8198 tcp:8198
cd apps/mobile/hold-proof
../node_modules/.bin/expo start --port 8198 --android
# In another terminal, from the repository root:
python3 apps/mobile/hold-proof/capture.py
```
