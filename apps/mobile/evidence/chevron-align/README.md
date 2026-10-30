# Test status chevron alignment

Reproduction CHEVRON-ALIGN: render the corner's `PR #2859 · tests running`
link. Its text centre was above the trailing chevron by 4.5 CSS px on web
and 12 physical px on Android. The status text started at the navigation
row's 8 dp top padding; the chevron was centred in its 44 dp target.

`CornerStatusLine` now uses the same vertical margin calculation as the
existing meta-size repository rows. Text and chevron centres match, without
changing text, glyphs, colours, row height or navigation. `LedgerDisclosure`
was measured before editing and already centres correctly; it is unchanged.

## Reproduced

Production was inspected on web.usebeeline.app in the existing Play Review
reviewer-bypass session. Review and Community corners inspected there had no
check-event transcript. No production messages were created. A production
before/after deployment is therefore not claimed.

The stand-in is the existing `disclosure-rows` replay: production
`CornerStatusLine`, `NotificationLifecycleCard`, `TurnStepsLine`,
`LedgerDisclosure`, system lines, fonts, tokens and actual layouts.
Web shims only native/external services as described in
[disclosure-top-edge](../disclosure-top-edge/README.md).
Android runs the native components with Unistyles on the corner's emulator.

The new browser geometry assertion fails on the original source with
`FAIL: corner-status-line: chevron offset 4.5px`.

## Demonstrated

Positive offset means the chevron centre is below the text line-box centre.
Web receipts measure actual SVG and text DOM rectangles. Native receipts
use UIAutomator text/row bounds and the chevron's centred 44 dp target;
physical-pixel rounding is included. The emulator density is 420 dpi.

| Surface | Before | After | Row height before / after |
| --- | ---: | ---: | ---: |
| Web, 390 and 1280, Bone and Obsidian | 4.5 CSS px | 0 CSS px | 44 / 44 CSS px |
| Android, Bone and Obsidian | 12 physical px | 1 physical px | 116 / 116 physical px |

[Native bounds and offsets](android-metrics.json) preserve the measured
rectangles. Web receipts beside each screenshot preserve every measured row.

| Surface | Before | After |
| --- | --- | --- |
| Phone web, Bone | [before](before/web-390-bone.png) | [after](after/web-390-bone.png) |
| Phone web, Obsidian | [before](before/web-390-obsidian.png) | [after](after/web-390-obsidian.png) |
| Desktop web, Bone | [before](before/web-1280-bone.png) | [after](after/web-1280-bone.png) |
| Desktop web, Obsidian | [before](before/web-1280-obsidian.png) | [after](after/web-1280-obsidian.png) |
| Android, Bone | [before](before/android-bone.png) | [after](after/android-bone.png) |
| Android, Obsidian | [before](before/android-obsidian.png) | [after](after/android-obsidian.png) |

A two-line summary stays centred on the whole row: it describes the complete
summary, so the chevron belongs to both lines. The browser proof asserts two
lines, equal centres and unchanged 44 px target height. Android also shows
the same wrapped fixture. The PR status link remains one line as before.
Steps, check summaries, repository groups, payment/notice groups, output,
script and N-more controls retain their existing geometry and interactions.
System disclosures retain their inline more/less presentation without a glyph.

## Repeat

From `apps/mobile`:

```sh
DISCLOSURE_SCREENSHOT_DIR=evidence/chevron-align/after npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1
```

To capture before, temporarily restore only `CornerStatusLine.tsx` from the
parent commit and use `CHEVRON_BASELINE=1` and a `before` screenshot directory.
Without `CHEVRON_BASELINE`, that source fails the new assertion.
Restore the fixed source afterwards.

Native build procedure matches the disclosure-top-edge evidence, using a
separate Metro FileStore at `/tmp/chevron-align-metro-cache`, port 8093,
and `scripts/disclosure-rows-native-proof.tsx` as temporary package main.
For these collapsed screenshots, temporarily omit `SystemRowsProof` from
that entry so the status link fits on the screen. Close the development
menu, capture the screen and UIAutomator XML in Bone and Obsidian, then repeat
with the fixed source. Restore package main, Metro configuration and native
proof entry afterwards; none of those temporary changes belong to the fix.

## Validation

Root typecheck, UI component policy, all design tests, the browser/status
regressions, and native disclosure interactions in both themes pass.
[Native interaction receipts](android-interactions.json) include every row's
expand/collapse checks; the script also asserts target height and N-more.

The broad mobile run passed all but three tests initially. After restoring
the temporary proof setup, the Metro test and release-planning timeout pass
on rerun. One native-fingerprint baseline failure remains. Reverting every
changed source to the untouched parent in place produces the same failing
hashes with these installed dependencies; sources were restored afterwards.
[Untouched-source gate output](native-fingerprint-baseline.txt) records that
limitation. This visual-only fix changes no native input or runtime pin.
