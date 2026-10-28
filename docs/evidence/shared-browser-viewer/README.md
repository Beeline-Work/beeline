# Shared browser: paste, copy, pinch zoom, centering

Bug fix, October 27, 2026.

## Real target and stand-in

The page under test is a live Trusty Squire share (Squire's own viewer page and
stream through a `trycloudflare.com` tunnel). It was served through this
checkout's viewer proxy (`serveComputerSession`) and embedded in a cross-origin
iframe, the way the web app embeds it. Headless Chrome drove it with
`apps/server/scripts/shared-browser-repro.ts`: desktop 900x700 with mouse,
keyboard and ctrl+wheel; phone 390x800 with touch. The remote page was a test
page with a text field. Squire's own DOM read confirmed the field contents.

A reviewer-bypass session on web.usebeeline.app could not open a share on this
branch, because the branch is not deployed. The Android emulator on this
machine exits before boot, so a native WebView run was not possible.

## Reproductions (main, before)

- Reproduction SB-PASTE-1: own clipboard set to `PASTE-4412`, click the remote
  field, Ctrl+V. **Wrong:** the field received the agent machine's own
  clipboard (a secret-shaped value, not reproduced here). The viewer
  forwarded Ctrl+V as a key, so the remote page pasted its own clipboard.
- Reproduction SB-COPY-1: double-click a remote word, Ctrl+C, read own
  clipboard. **Wrong:** own clipboard unchanged (`EMPTY`).
- Reproduction SB-ZOOM-1: desktop ctrl+wheel in and out; phone pinch out, then
  pinch in four times. **Wrong:** desktop width stayed 957 (no zoom). Phone
  pinch out reached 3037 wide, but pinch in stopped at the opening 1094. It
  never reached the whole page in view.
- Reproduction SB-CENTER-1: open, then resize. **Wrong:** desktop opened at
  `left 0`, width 957 in a 900 frame (right edge cut, left edge flush). Phone
  opened at `left 0`, width 1094 in a 390 frame. After resizing to 760 it
  stayed at `left 0`.

## After (same steps, this branch)

- SB-PASTE-1 passes. The field reads `PASTE-4412`. On the phone, tapping the
  field and then the new paste button added `PHONE-PASTE-58`.
- SB-ZOOM-1 passes. Desktop ctrl+wheel zoomed to 3176 wide, then back out to
  900x659, the whole page in a 900x700 frame. No wheel reached the page. Phone
  pinch in went from 3037 back to 390x286 (contain).
- SB-CENTER-1 passes. Desktop opens at `left -28` (957 wide in 900: even
  crop). Phone opens at `left -352` (1094 in 390). Zoomed-out, resized (760)
  and rotated (800x390) layouts are centred.
- SB-COPY-1 still fails on Squire shares. Squire's stream has no message that
  returns the selected text. Agent-owned Chromium shares now copy: the viewer
  asks the agent's tab for its selection and writes it to the clipboard.

## Paste with no text on the viewer's clipboard

Review found that the first version of this fix still sent Ctrl+V to the
remote page when the viewer's clipboard had no text, so the remote page pasted
the agent machine's clipboard.

- Reproduction SB-PASTE-2: on the live Squire share, the agent machine's
  clipboard holds `REMOTE-CLIP-SENTINEL` (copied from a field in the remote
  page). Click the remote text area, Ctrl+V with an empty viewer clipboard,
  then Ctrl+V with only an image on it
  (`SCENARIO=paste-without-text npm run repro:shared-browser`).
  **Wrong (first version):** the text area read
  `REMOTE-CLIP-SENTINELREMOTE-CLIP-SENTINEL` (`before-paste-without-text.png`).
- After: the same steps leave the text area empty
  (`after-paste-without-text.png`). With `PASTE-4412` on the viewer's
  clipboard, Ctrl+V puts exactly `PASTE-4412` there
  (`after-paste-with-text.png`).

Screenshots: `before-*.png` and `after-*.png` in this folder.
