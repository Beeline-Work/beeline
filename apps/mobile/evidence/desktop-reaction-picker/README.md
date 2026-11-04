# Desktop reaction picker pointer proof

2026-11-03, Linux/Xvfb 1280×840, native Tauri/WebKit windows.

## Inputs and isolation

- Before: published `v0.1.141` `Beeline-x86_64.AppImage`, SHA-256 `90341a89ce72550d653cfae30c1ac429ed52fa2d8df118ce834e0023c2547e57` (the same desktop payload as v0.1.138).
- After: [Desktop CI run 41701556074](https://github.com/Beeline-Work/beeline/actions/runs/41701556074), `beeline-desktop-preview-linux-x86_64`, source `95668a2a6b345ab8cec2e5ef4e3e1060501d66ee`, `Beeline Preview_0.2.20_amd64.AppImage`, SHA-256 `0469660d7b1d9b411178409b23f953a2759ed3eeec5a1b210535ad5865612056`. The subsequent source commit preserves whitespace for the legacy control fingerprint; it does not change runtime behavior.
- Both ran their embedded client in their actual native shell, using a private X display, D-Bus session, HOME and XDG directories. No production Workspace was opened.
- A task-local `LD_PRELOAD` adapter changed the embedded API origin to a loopback server and redirected only secure-storage IPC calls to disposable in-memory credentials; updater checks were disabled. Message rendering, picker code, layout, native HTTP IPC, and WebKit pointer handling were retained. This is a transcript interaction proof using a local backend and credential adapter.
- Backend: current server with an isolated in-memory PGlite database, synthetic identities, Workspace `Local Reaction Proof`, Room `picker-proof`. The original message is id `0000000000000000000000000000000000000000000000000000000000000001`; the following message ends in `2`.

## Pointer results

| Frame | Result |
| --- | --- |
| [Before: React clicked](before-picker.png) | Original message's picker is open. |
| [Before: pointer moved onto the thumb](before-hover.png) | Next message's toolbar paints over the emoji choices. No emoji click was sent. |
| [After: React clicked](after-picker.png) | Original message's picker is open in the portal. |
| [After: pointer moved onto the thumb](after-hover.png) | Picker stays visible above the following message. |
| [After: thumb clicked](after-reaction.png) | Original message displays 👍1; the following message has no reaction. |
| [After: bottom message picker](after-bottom-edge.png) | Entire picker remains visible at the transcript's bottom edge. |
| [After: Obsidian hover](after-obsidian-hover.png) | Same native hover proof in the dark theme, with the original reaction retained. |

The before pointer path was React `(979,198)` → thumb `(931,244)`, without clicking the thumb. The after path was React `(979,145)` → thumb `(931,193)` → click. The released and current clients position the beginning of the ledger differently; both paths target the first message's own controls.

[Canonical before](canonical-before.json) and [canonical after](canonical-after.json) are fresh authenticated reads of the local server's history route. Only the original message gains a single 👍, attributed to the synthetic Local Reviewer.

## Automated coverage

`sources/test/desktop-reaction-picker.browser.test.ts` extracts the production row wrapper and styles, renders real RN Web rows and clipping ancestors, and sends real Chromium mouse input through React → every emoji → thumb → click. It covers adjacent rows, the transcript edge, viewport-bottom flipping, outside click, Escape, scroll dismissal, and compact web's long-press actions. Against the original source it fails with `copy-button-next` as the hit target instead of `reaction-choice-original-👍`.

```sh
cd apps/mobile
npx vitest run sources/test/desktop-reaction-picker.browser.test.ts --maxWorkers=2
```
