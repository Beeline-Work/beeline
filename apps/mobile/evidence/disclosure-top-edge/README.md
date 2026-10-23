# Disclosure top edge

Visual refinement requested by the owner, not a defect report.

Steps, check-event disclosures and grouped GitHub headers lose their top edge.
Their labels, chevrons, colours and minimum 44 px tap height stay the same.
Standalone repository-record rules and rules inside expanded steps remain.

## Demonstrated

`DISCLOSURE-EDGE` renders the production `TurnStepsLine` and
`NotificationLifecycleCard`, including the two real Room events from
`scripts/transcript-event-room-snapshot.json`. The single completed tool call
and check receipt are fixtures. The next message is separated by the existing
24 px speaker-change spacing.

This is a standalone component replay, not a signed-in production Room. It
exercises the affected paths without copying a person's sign-in material or
writing production messages. Browser proofs shim native-only output-sheet and
unused live-turn presentation dependencies; the rows, folding, state, glyphs,
fonts, tokens and React Native Web layout remain real. Android uses native
production components, fonts and Unistyles.

Before screenshots use the original component source at the branch base;
after screenshots use this change. The browser proof checks the row and its
wrapper for a top edge, enforces the minimum height, expands from the top-right
edge, collapses from the bottom-left edge and checks next-message spacing.
Native receipts record row bounds and the same edge-tap interaction in both
themes. Native bounds may round down by less than one physical pixel from
44 dp; the native assertion uses that rounded minimum. Unit regressions fail
on the original source for all three paths.

| Surface | Before | After |
| --- | --- | --- |
| Android · Bone | [before](before/android-bone.png) | [after](after/android-bone.png) |
| Android · Obsidian | [before](before/android-obsidian.png) | [after](after/android-obsidian.png) |
| Phone web · Bone | [before](before/web-390-bone.png) | [after](after/web-390-bone.png) |
| Phone web · Obsidian | [before](before/web-390-obsidian.png) | [after](after/web-390-obsidian.png) |
| Desktop web · Bone | [before](before/web-1280-bone.png) | [after](after/web-1280-bone.png) |
| Desktop web · Obsidian | [before](before/web-1280-obsidian.png) | [after](after/web-1280-obsidian.png) |

## Repeat

From `apps/mobile`, run:

```sh
DISCLOSURE_SCREENSHOT_DIR=evidence/disclosure-top-edge/after npx vitest run sources/components/buzz/disclosure-rows.browser.test.ts --maxWorkers=1
```

For the baseline, restore the two component sources from the branch base and
set `DISCLOSURE_BEFORE=1`, with the screenshot directory ending in `before`.
Restore the changed sources afterward.

For native proof, generate ignored Android files with Expo prebuild and build
the debug app for `x86_64` with two Gradle workers and a 4 GiB heap. Point the
generated `MainApplication`'s `jsMainModulePath` and the temporary package
`main` at `scripts/disclosure-rows-native-proof`. Run Metro on a task-owned
port listening on IPv4, bridge it with `adb reverse`, and open that server through the development client
on an emulator leased by `beeline emulator`. From the loaded Bone screen:

```sh
python3 scripts/prove-disclosure-rows.py --serial emulator-<leased-port> --phase after
```

Repeat with the base component sources for `--phase before`; restart Metro
and the proof app between phases. Restore package `main` and the changed
component sources before committing. Native generated files stay ignored.

## Policy fixtures

`LedgerDisclosure` is now registered as the shared control owner it already
implements; its two legacy UI-policy fingerprints are removed. The owning
component registration remains. No System-message lock fixture or message
grammar changes are required. The separate repository header loses only the
wrapper rule above grouped disclosures; singleton records retain that rule.
`knip.jsonc` declares the browser and native proof entry files selected by the
bundler and temporary Metro main; the shared proof stays reachable through imports.
