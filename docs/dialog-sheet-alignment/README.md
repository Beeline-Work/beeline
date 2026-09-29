# Dialog and sheet alignment frames

All frames use Beeline's Bone (light) appearance. `before/` comes from the catalog's mounted React Native Web component captures at `9fd32993`; `git diff 9fd32993 43ab1f02` confirms all seven affected source files were unchanged at this branch's current-main base. `after/` was captured at 393 × 852 from the same mounted app components in a temporary Expo route; that route was removed after capture. The seven matching filenames show the seven changed surfaces.

Fixture data is synthetic where a live Workspace or Room would normally supply it: Workspace name `Hull`, roster members Ana and Ox, and member-picker candidates Ana and Ox. The text-selection image uses the real route's missing-text branch. The old Workspace-delete catalog frame shows only its shared sheet shell, without the typed-name input, so its before/after comparison is limited. The after frame mounts the actual `WorkspaceDeleteConfirmDialog` used by Workspace settings.

The updated Create poll after frame shows the empty form with its disabled primary button. `after/create-poll-enabled.png` shows the same mounted component with sample question `Ship?` and options `Yes` and `No`, confirming the ink primary state after valid input.

`after/android-delete.png`, `android-delete-keyboard-disabled.png`, and `android-delete-keyboard-enabled.png` are native Android development-build captures of that same component. With the keyboard open, the dialog and both actions remain above it; Delete stays disabled for a wrong or empty name and enables for exact `Hull`. One Cancel appears. No deletion was sent by the fixture.

Mobile `npm run typecheck` was also run on an archive of exact starting `origin/main` (`43ab1f02af26cad7afdddc03f5b274254d990eeb`) with the same installed dependencies. Both baseline and this branch report the same six diagnostics: `RoomMessageVariants.test.tsx:2707,2711` (TS2353), `RoomMessageVariants.tsx:473` (TS2339), and `push/notification-action-runtime.ts:109,111,131` (TS2307, TS2307, TS7031). No diagnostic points to the changed surfaces.
