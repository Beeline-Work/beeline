# Approved desktop UI fixes

Brief revision 2 implements the approved HTML mock (Room attachment
`c5bb76f7-4399-4b23-a393-944b47d7e7c4`) following the human go-ahead.
The implementation preserves mobile rendering and all existing message actions.

## Reproduction and limits

The production desktop session was not available. Chrome rendered the real
components with fixture data and native-service shims. The original grey color,
clipped label, and reported question-mark symbol were not reproduced exactly.
No new meaning was assigned to a question mark: the existing report callback
continues to use a flag and is now named by a tooltip.

Pre-change component observations at base `7fabe5962`:

- Reproduction desktop-ui-1: render the desktop Workspace trigger with attention
  set → a small lower-right overlay is present. The desktop strip itself had
  no overlay. Only desktop hides the trigger overlay; mobile retains it.
- Reproduction desktop-ui-2: render the persistent desktop strip and focus its
  account control → no Settings caption or account label is present. This is
  related component evidence, not reproduction of the reported clipping.
- Reproduction desktop-ui-3: render short and wrapped desktop corner cells →
  the objective's rail covers only the lower part of the cell, with asymmetric
  padding (8 px above, 4 px below). It does not span the cell as the mock does.
- Reproduction desktop-ui-4: inspection of the shared desktop message toolbar
  found Unicode copy/reply/react/forward glyphs at the meta text scale and
  bookmark/report font icons at 14 px, with no visible action names.

## Corrected paths

`desktop-ui-fixes.browser.test.ts` renders the shipped strip, Workspace trigger,
corner list, and action buttons through React Native Web in headless Chrome.
It measures Settings caption visibility and focus-label bounds, absence of the
Workspace overlay, 8/8 px rail insets for short and wrapped cells, 18×18 px SVGs
inside 44×44 px targets, keyboard tooltips, and all six action callbacks.
The full message variant suite separately verifies the real callback wiring,
report availability, reaction selection, and unchanged mobile behavior.

The Obsidian and Bone PNGs are component proof screenshots using the shipped
fonts and theme tokens, not screenshots of a signed-in production session.
The fixture's final keyboard focus is Forward, so its tooltip is shown.

Re-run screenshots from `apps/mobile`:

```sh
DESKTOP_UI_PROOF_OUT=../../docs/evidence/desktop-ui-fixes npx vitest run sources/components/buzz/desktop-ui-fixes.browser.test.ts
```

Verification: focused component and browser suites, the design and typography
lints, and root `npm run typecheck`. The before fixture was captured before
publication using the base component sources; it is not part of the recurring
regression suite.
