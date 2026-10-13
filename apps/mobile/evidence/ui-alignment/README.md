# Approved UI alignment proof

The approved [alignment board](https://doing-wishing-throwing-chance.trycloudflare.com/) supplies the visual acceptance criteria. These 390×844 captures render production routes and sheets using synthetic local data. They use the real Button, HullDialogActions, HullDialogInput, HullActionSheetCancel, MemberRosterRow, RoomListSectionHeader, ServiceMark/AppMark, typography and theme tokens. No production account or server was used; commands are inert or rejected by the proof transport.

| Role | Production screen | Obsidian | Bone |
| --- | --- | --- | --- |
| Confirm/cancel | NewCornerDialog | [capture](confirm-obsidian.png) | [capture](confirm-bone.png) |
| Destructive confirm | Connection detail, local Revoke confirmation opened | [capture](destructive-obsidian.png) | [capture](destructive-bone.png) |
| Retry | Workflow read failure | [capture](retry-obsidian.png) | [capture](retry-bone.png) |
| Sheet form footer | CreatePollSheet | [capture](dismissal-obsidian.png) | [capture](dismissal-bone.png) |
| Immediate dismissal | FacePickerSheet | [capture](face-obsidian.png) | [capture](face-bone.png) |
| Text field | Create Workspace | [capture](field-obsidian.png) | [capture](field-bone.png) |
| Member row | DirectMessagePickerSheet | [capture](member-obsidian.png) | [capture](member-bone.png) |
| Section header/count | DirectMessagePickerSheet | [capture](header-obsidian.png) | [capture](header-bone.png) |
| Service mark | Service key detail | [capture](service-obsidian.png) | [capture](service-bone.png) |
| Odd sizes | NewRoomDialog | [capture](sizes-obsidian.png) | [capture](sizes-bone.png) |

The measured viewport and document width are 390px in both themes. Command Buttons and single-line fields measure 44px. Counts sit separately from section labels. Confirmation callbacks, permission checks and native input props remain owned by their production callers.

Reproduce with `node apps/mobile/scripts/ui-alignment-proof/build.mjs`, then use `CHROME_DEVTOOLS_AXI_SESSION=beeline-ui-alignment-proof chrome-devtools-axi` to open `http://127.0.0.1:19244/?role=confirm&theme=obsidian` and `resize 390 844`. Role values are confirm, destructive, retry, dismissal, field, member, header, service and sizes. Face dismissal uses `role=dismissal&screen=face`. For destructive confirmation, click `connection-revoke-grants` and scroll `connection-revoke-confirm` into view before capturing. Native framework adapters, loading animations and the unrendered successful-workflow subtree are shimmed; screen JSX and shared controls are unchanged. These captures establish appearance and geometry, not live command execution or device keyboard behavior.

Final validation after rebasing onto main: the full mobile unit suite excluding separately hosted browser suites passed 4,307 tests across 478 suites, with three existing skips. Root typecheck, both design lints, all 27 UI policy tests and the required component scanner passed. The [Android release-build proof](android-release.txt) records the real `index.ts` bundle (3,242 modules), successful `assembleRelease`, source commit and APK SHA-256. This local build uses a debug certificate; no store signing credentials or device installation were used. Native dependency pins, runtime versions and fingerprints are unchanged.
