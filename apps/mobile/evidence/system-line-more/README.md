# System lines: inline more/less

Not a defect report: a design change approved by lunchboxfortwo with the
"more button" mock. Reproduction **SYSTEM-LINE-MORE** compares the same replay
before (main `146008a3f`) and after.

Main puts a chevron in front of a System line that runs past two lines, which
pushes its text 22px right of a short line. The change drops the chevron. A
closed long line ends in `… more` on its second line, an open one ends in
`less`, both in the accent colour at weight 500. A non-breaking space binds the
word to the text, so it never sits alone on a new line. The whole line stays
the 44px tap target with the same accessibility labels and expanded state.

Text clamping cannot append after its ellipsis, so a hidden probe finds the
longest cut whose `… more` still fits two lines: a binary search over word
ends, then characters when one word fills the line. Native reads the probe's
line count from `onTextLayout`; web reads its height.

## Browser proof

From `apps/mobile`:

```sh
DISCLOSURE_SCREENSHOT_DIR=evidence/system-line-more/after npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1 -t 'system=true'
SYSTEM_OPENED=1 DISCLOSURE_SCREENSHOT_DIR=evidence/system-line-more/after-open npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1 -t 'system=true'
```

The system rows assert no chevron, the long line's text starting at the short
line's left edge, `… more` on line two beside the glyph before it, `less`
beside the last word when open, the 44px target, the labels, and name/link
taps that do not toggle. Main fails the first assertion (`long-proof:
chevron`). `system-lines.browser.test.ts` adds 81 container widths per run so
the last word meets the right edge at every width, at normal and large type.

For main captures, restore `Ledger.tsx` and `LedgerDisclosure.tsx` from the
commit above and add `SYSTEM_BASELINE=1` with the `before`/`before-open`
directories.

| Surface | Main closed | New closed | Main open | New open |
| --- | --- | --- | --- | --- |
| Phone web · bone | [before](before/web-390-bone-system.png) | [after](after/web-390-bone-system.png) | [before](before-open/web-390-bone-system.png) | [after](after-open/web-390-bone-system.png) |
| Phone web · obsidian | [before](before/web-390-obsidian-system.png) | [after](after/web-390-obsidian-system.png) | [before](before-open/web-390-obsidian-system.png) | [after](after-open/web-390-obsidian-system.png) |
| Desktop web · bone | [before](before/web-1280-bone-system.png) | [after](after/web-1280-bone-system.png) | [before](before-open/web-1280-bone-system.png) | [after](after-open/web-1280-bone-system.png) |
| Desktop web · obsidian | [before](before/web-1280-obsidian-system.png) | [after](after/web-1280-obsidian-system.png) | [before](before-open/web-1280-obsidian-system.png) | [after](after-open/web-1280-obsidian-system.png) |

## Native

`Ledger.test.ts` drives the native path: the probe's `onTextLayout` line
counts settle the cut, then the line reads `… more`, opens to `less`, and
keeps nested name taps. No Android screenshot yet: the emulator on this
helper cannot start because the corner's user has no access to `/dev/kvm`.
