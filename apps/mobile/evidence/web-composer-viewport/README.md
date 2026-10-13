# Android Chrome composer viewport proof

Reproduced on 2026-10-13 with Chrome 133 in a task-owned Android 36 emulator, DPR 2.625, real URL bar and gesture navigation. The live v0.1.49 agent DM was inspected only as Play Review in Beeline Review. No captain account or Workspace was used.

Expo's `web.output: "single"` export supplies `#root { height: 100% }`. Android Chrome resolves that percentage against the viewport with its URL bar hidden. With the bar visible, the root is taller than `visualViewport.height`, and the composer mounts below the screen. Resizing a desktop emulation shrinks both viewports together and misses this failure. There was no composer render error.

| Screen (CSS px) | Visible viewport | App root | Composer input |
| --- | --- | --- | --- |
| 412×915, live before | 783.24px | 839.24px | y799–825: off-screen |
| 412×915, fixed export | 783.24px | 783.24px | y743–769: visible |
| 390×844, fixed export | 716.19px | 716.19px | y675.95–701.95: visible |

The fixed images use the production Expo export against a local server fixture with an agent DM, 240 messages and multi-paragraph agent responses. Chrome was controlled through a dedicated `chrome-devtools-axi` session connected to the emulator. Typing and sending a message to the local fixture cleared the draft. Nothing was sent to a live agent.

- [Before, 412×915](before-412.png)
- [Fixed agent DM, 412×915](fixed-dm-412.png)
- [Fixed agent DM, 390×844](fixed-dm-390.png)

`index.ts` installs `sources/polyfills/webViewport.ts` before the app mounts. It sizes the web root from the visual viewport and follows URL-bar/keyboard resize and page restoration; pinch zoom preserves the layout height. Native has no document and takes the no-op path. `+html.tsx` is static-render-only and is not emitted by our single-page export.

Regression: `sources/polyfills/webViewport.browser.test.ts` renders the real web composer over a long transcript, separately varies layout and visual heights, and checks URL-bar visible/hidden, keyboard, standalone-height, zoom, fallback and native behavior. Both browser cases fail on composer visibility when root height adjustment is disabled and pass with it.
