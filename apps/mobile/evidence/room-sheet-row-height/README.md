# Room sheet row height

Reproduction room-sheet-row-height: open #experiments, open Room actions, and compare Repository, Reviewer, Members and Schedules and subscriptions. The schedules row has an empty 24pt strip below its label before Delete Room. The supplied Android screenshot and the signed-in production web sheet both show this strip. The web observation used an existing owner session at desktop width in light appearance.

The cause is a separate `roomLifecycleGap` View after the schedules row, not a subtitle or padding inside HullActionSheetRow. Removing the View and its unused style restores the same 52pt visible footprint as the standard rows. The corner actions sheet has no corresponding spacer. Notification mute retains its description and larger height.

The source-derived browser regression renders the actual schedules JSX and its following siblings with the real sheet row component, at 390pt width. Against the original chat source it fails in both themes: the schedules footprint is 76pt rather than 52pt. Against the fixed source it passes in both themes: all navigation rows and the corner close row are 52pt; the gap after schedules is zero; notification mute is 82pt; the chevron remains.

`fixed-dark.png` is a **local source-derived render**, not a production screenshot. Generate it with:

```sh
cd apps/mobile
ROOM_SHEET_SCREENSHOT="$PWD/evidence/room-sheet-row-height/fixed-dark.png" PRINT_PROOF=1 npx vitest run 'sources/app/(app)/beeline/chat/room-sheet-height.browser.test.ts' --maxWorkers=1
```

Validation: 52 targeted tests, root typecheck and workspace build passed.

Production reviewer-bypass proof at phone width in dark mode: **not obtained; waived for review by Ruby in corner brief revision 2**. The local phone-width dark-mode screenshot and failing-then-passing browser regression satisfy the revised pre-merge verification requirement. Production runs main and cannot show this PR branch before merge. Ruby will check the production sheet after deployment; that check has not yet been performed.
