# Beeline design consistency — Android verification

Captured at 1080 × 2400 on the shared `buzzy_api36` Android emulator.

| Surface            | Before                          | After                                                                   |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Compose menu       | `before-compose-menu.png`       | `after-compose-menu.png`                                                |
| Workspace settings | `before-workspace-settings.png` | `after-workspace-settings.png` and `after-workspace-settings-lower.png` |
| Empty Room         | `before-empty-room.png`         | `after-empty-room.png`                                                  |
| Empty Corner       | `before-empty-corner.png`       | `after-empty-corner.png`                                                |

The before captures reproduce the critique baseline. The after captures use the signed release APK built from this branch; the branch bundle was loaded without the shared emulator's cached production OTA overriding it.

## Typed read-model proof — mobile viewport

The committed `read-model-proof.html` fixture renders only selector-shaped data at a
430 × 932 mobile viewport. It covers the three required surfaces from the immutable
snapshot contract:

| Surface    | Capture          | Evidence                                                                                      |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------- |
| Transcript | `transcript.png` | Human and agent messages remain chronological while retry telemetry is collapsed as activity. |
| Roster     | `roster.png`     | Current human and agent identities are resolved from member pubkeys.                          |
| Corner     | `corner.png`     | A live corner has a human member and renders its selector-owned status.                       |

The HTML fixture is kept beside the captures so the exact visual input is reviewable
and reproducible without a relay or mutable presentation cache.

## Emoji top-clip — reaction strip and chips

The reaction strip and the reaction chips sized their emoji-only `Text` with an
explicit `lineHeight` (22 / 19). RN's `CustomLineHeightSpan` (web-like inline
height) sizes that box from the first font's metrics alone, so Android clipped
the emoji glyph's top; the fix derives emoji text from the type role with the
`lineHeight` removed (`apps/mobile/sources/buzz/emoji-text.ts`), and
`emoji-text.test.ts` pins its absence.

Web render proof (react-native-web, the Tauri desktop shell's renderer and expo
web share this stack) — the real `MessageReactionStrip` plus before/after chip
and strip cells:

    npm run emoji-clip:proof -w apps/mobile
    google-chrome --headless=new --no-sandbox --screenshot=.verification/emoji-top-clip-web.png \
      --window-size=430,620 --force-device-scale-factor=3 http://127.0.0.1:4177

The corner sandbox seccomp-traps Chrome, so the capture is produced on the rig
with the command above; the built bundle was verified to carry `lineHeight`
only in the labeled before variants.

## Emoji top-clip — Android native capture

The same proof runs on the Android emulator through Expo Go 55.0.7 (the RN
0.83-era Go runtime, matched to the app's expo ~55 SDK via the per-SDK URL in
`https://api.expo.dev/v2/versions`). `apps/mobile/proofapp/` is a minimal Expo
project whose entry renders the REAL `MessageReactionStrip` and proof-local
chip/strip cells carrying the shipped before/after styles; unistyles' native
runtime (absent from Expo Go) is stood in by `unistyles-proof-shim.tsx`, which
resolves `StyleSheet.create` against the real groknight theme — the component
code and style values are the shipped ones.

    cd apps/mobile/proofapp
    CI=1 ../node_modules/.bin/expo start --port 8091 --offline &
    adb reverse tcp:8091 tcp:8091
    adb shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8091" host.exp.exponent
    adb exec-out screencap -p > .verification/emoji-top-clip-android.png

Capture (`emoji-top-clip-android.png`): real strip + before/after strip cells
and chips all render complete glyphs at head 06d540928a59. Note the emulator's
AOSP emoji font does not reproduce the observed device clip even in the before
rows — the clip depends on the device emoji font's metrics; the fix removes the
mechanism itself (no explicit lineHeight, so no `CustomLineHeightSpan`), which
holds for any font by construction.
