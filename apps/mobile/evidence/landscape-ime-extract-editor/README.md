# Android landscape IME replaces the composer with the OS extract editor

Captured on `emulator-5554` (redroid 11 x86_64, forced to a phone-shaped
1280x720 landscape viewport with `wm size 720x1280` + `wm density 320` +
`user_rotation 1`, so the config reads `sw360dp ... land`). The IME is the
device's AOSP `com.android.inputmethod.latin`.

The real `ConversationComposer` is mounted on the device through Expo Go
55.0.7 against a Metro entry that imports the shipped component — the same
native-proof arrangement `proofapp/` uses for `MessageReactionStrip`, with
only unistyles' native runtime shimmed. The two captures are the same harness,
the same device, and the same keystrokes (`typing in Beeline`); the only thing
that differs is whether `ConversationComposer.tsx` carries the fix.

`adb shell dumpsys input_method` reports the state behind each capture.

## Control

- `control-plain-android-field-goes-fullscreen.png` — the WebView Browser
  Tester's plain `EditText` on the same device and viewport. `mIsFullscreen=true`.
  Establishes that this device and IME do take the screen in landscape, so a
  negative result in the app is the app's doing, not the emulator's.

## Before the fix

- `before-extract-editor-replaces-composer.png` — `mIsFullscreen=true`. Tapping
  Beeline's composer hands the whole screen to the IME's extract editor: a
  plain white field with a grey `DONE` button. The typed text lands there.
  Beeline's dark composer row, its `+` attach control, and its `↑` send control
  are all gone; only a clipped sliver of the send control survives at the edge.

## After the fix

- `after-composer-keeps-the-screen.png` — `mIsFullscreen=false`. The same tap
  and the same keystrokes: the text lands in Beeline's own field, the brass
  focus hairline, the `+` attach control, and the `↑` send control are all on
  screen, and the keyboard is an ordinary keyboard below them.

## Root cause

`InputMethodService.onEvaluateFullscreenMode()` returns true for any landscape
configuration unless the editor sets `IME_FLAG_NO_FULLSCREEN`, and AOSP
LatinIME does not override that away. React Native's `disableFullscreenUI`
prop is the binding for that flag, and the composer never set it.
