# Computer session UI proof

These frames render the actual `ComputerSessionCard` and `ComputerSessionViewer` React Native components through the app's web renderer. The surrounding Room chrome and checkout page are local fixtures. The fixture uses the Beeline `obsidian` and `bone` theme tokens and loads Space Grotesk and IBM Plex Mono from `apps/mobile/sources/assets/fonts`.

| Frame | Viewport | What it shows |
| --- | --- | --- |
| `phone-card-live.png` | 390 × 844 | Live stream card in the Room transcript |
| `phone-viewer-live.png` | 390 × 844 | Full screen browser viewer |
| `phone-viewer-control.png` | 390 × 844 | Same viewer after human input changed the browser page |
| `phone-card-ended.png` | 390 × 844 | Ended card with the saved last frame |
| `phone-viewer-ended.png` | 390 × 844 | Saved last frame opened full screen |
| `phone-card-light.png` | 390 × 844 | Live card in the light theme |
| `desktop-live.png` | 1440 × 900 | Live card and browser in the normal 400 px work pane |
| `desktop-ended.png` | 1440 × 900 | Ended card and saved last frame in the work pane |

Rebuild the fixture with `node apps/mobile/scripts/render-computer-session-frame.mjs`, serve `evidence/computer-session/`, and capture each `?frame=` URL using `CHROME_DEVTOOLS_AXI_SESSION=beeline-computer-use-plan chrome-devtools-axi`. Browser inspection reported `SpaceGrotesk-SemiBold` for the phone card title and the loaded families `SpaceGrotesk-Regular`, `SpaceGrotesk-Medium`, `SpaceGrotesk-SemiBold`, and `IBMPlexMono-Regular`; the desktop card resolved to `SpaceGrotesk-Regular` for the sampled node. No Times fallback appeared.
