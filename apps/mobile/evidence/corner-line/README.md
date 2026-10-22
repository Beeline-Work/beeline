# Corner line in the Room row format

The call-site corner line and the Room's corner row now render through one
component, `RepositoryLifecycleRow`. The call-site line passes `glyph`, which
adds the branch mark and drops the row rule. Words, face, size, weight and
colours are the same. A corner row with no GitHub link is one press target.

## Reproduction corner-row-tap-1

Harness: `scripts/lifecycle-rows-a-native-proof.tsx`, Room frame, Android 36
x86_64 emulator. Step: press the words of the Room row
`Opened corner #dm-unread-clear`, 60 px in from its left edge, not the chevron.

- main fbaf18180 components (APK sha256 08b43860…): no destination.
  `capture-lifecycle-rows-a.py --corner-line-only` fails with
  `AssertionError: corner-dm`.
- This branch (APK sha256 a94386e8…): the press opens `corner-dm`. The script
  prints `PASS: corner lines in both themes and their destinations`.
  See android-corner-line-receipts.json.

## Screenshots

- Android Room frame: call-site line above a Room `Opened corner` row and a PR
  row, plus a long name that truncates before the chevron.
  [Bone](android-bone-corner-line-room.png),
  [Obsidian](android-obsidian-corner-line-room.png).
- Android DM frame (replayed service projection):
  [Bone](android-bone-corner-line-dm.png),
  [Obsidian](android-obsidian-corner-line-dm.png).
- Desktop column, production components in Chrome
  (`sources/test/corner-line.browser.test.ts`, `CORNER_LINE_PROOF_OUT=evidence/corner-line`):
  [Bone](desktop-bone.png), [Obsidian](desktop-obsidian.png). The test fails
  if the computed font family, size, line height, weight or colour of the two
  lines differ, if the glyph is on the wrong line, if a long name pushes the
  chevron out, or if any line opens the wrong corner.
