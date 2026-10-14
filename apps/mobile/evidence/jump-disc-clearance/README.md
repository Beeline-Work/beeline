# Jump-to-latest status clearance

Reproduction CHEVRON-STATUS-1: scroll away from the newest message while Ruby's working line is visible. The previous control sits 37px above the transcript bottom while the painted status canvas reaches 42px above it, covering the button's bottom 5px. A taller status line covers more of the button and intercepts its lower touch area.

The canvas grew intentionally in commit 6647f70e3 (#2382): 9px of upper air needed an opaque fill, and an 8px translated overlap seals the composer join. The row itself remained 24px; this change preserves that layout and coverage.

`TurnBandSlot` now reports its native layout height minus the downward paint translation. The control remains inside the transcript's bounds for native hit testing and clears that measured canvas by 4px. The composer's position already defines the transcript's lower edge, so keyboard movement and composer growth need no additional offset.

The [browser fixture](../../scripts/jump-disc-proof.mjs) bundles the shipped status slot, status row, and jump control with React Native Web. It stubs only the animated mark and pulse; layout and callbacks come from production components. It tests 390px and 412px widths, status shown/hidden, an extra 35px of row height, and full/shortened keyboard viewports. It checks the complete button bounds, four hit-test points, and the jump callback. These are browser layout tests, not Android or iOS device captures or a real keyboard session.

Run with Playwright installed (or set `JUMP_PROOF_PLAYWRIGHT` to its `index.mjs`):

```sh
node apps/mobile/scripts/jump-disc-proof.mjs --baseline
node apps/mobile/scripts/jump-disc-proof.mjs
```

The baseline intentionally exits 1. [Before](browser-before.json) has eight failing status-visible cases, with 5px or 40px overlap. [After](browser-after.json) has all sixteen cases passing, with a 4px gap and working hit tests/callbacks.

The existing [native fixture](../../scripts/status-band-native-proof.tsx) now includes this control and displays a jump counter. Native validation remains outstanding: working/settled/idle states, keyboard open/closed, and tapping the lower part of the disc on Android and iOS.

Validation so far: 67 focused component/wiring/scroll tests, 17 design tests, full root typecheck, and workflow path lint pass.
