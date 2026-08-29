# Attach sheet flicker over a focused composer

Captured on `emulator-5554` with a release APK built from this branch (once
before the fix, once after), signed in with an isolated throwaway identity
against the production relay, in an otherwise-empty Room. Reproduces the
captain's report: the Attach sheet (Photo / Document / Cancel) flickers when
shown over a Room.

Repro path: focus the composer, type text so the keyboard is up, then tap the
attach button — the composer's real-world state when this sheet gets opened.

## Before the fix (`HullDialog.tsx`'s Modal on RN's own `KeyboardAvoidingView` + `'height'`)

- `before-keyboard-up-composer-focused.png` — composer focused, keyboard up,
  about to tap Attach.
- `before-sheet-floats-mid-screen.png` — the instant after the tap: the sheet
  renders floating mid-screen, at the vacated keyboard's height, instead of
  the true bottom.
- `before-sheet-snaps-to-bottom-1s-later.png` — about a second later, the
  sheet snaps down to the real bottom position. The floating-then-snapping is
  the flicker.

## After the fix (`react-native-keyboard-controller`'s `KeyboardAvoidingView` + `'translate-with-padding'`, matching `[channelId].tsx`'s existing Android keyboard handling)

- `after-sheet-settled-immediately.png` — the instant after the tap: the
  sheet is already in its final bottom position.
- `after-sheet-stable-1s-later.png` — pixel-identical a second later. No
  snap.

## Root cause

`HullDialog.tsx`'s shared `StableHullModal` — the single Modal boundary every
Hull surface routes through — used React Native's own `KeyboardAvoidingView`
with Android `behavior: 'height'`. `[channelId].tsx` had already migrated off
exactly that combination to `react-native-keyboard-controller`'s
`KeyboardAvoidingView` with `'translate-with-padding'`, specifically to fix
Android keyboard bugs (guarded by `keyboardAvoidance.test.ts`). The app hands
keyboard tracking to that library's `KeyboardProvider` app-wide
(`app/_layout.tsx`), so RN's own `KeyboardAvoidingView` inside the modal was a
second, un-migrated keyboard boundary: it never learns an already-open
keyboard's height at mount, only reacting to later show/hide events, so it
renders once at the wrong height and corrects itself a beat later. Since
every Hull dialog/action-sheet shares this one file, the fix closes the class,
not just this one sheet.
