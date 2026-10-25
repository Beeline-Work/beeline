# Validation of page-local desktop widths

- `npm run corner:prepare`: passed.
- Root `npm run typecheck`: passed, including mobile and scripts.
- `npm run lint:ui-components`: passed.
- `npm run dead-code`: passed after explicitly registering the esbuild browser proof entry in Knip (4 existing findings, 0 introduced; no baseline change).
- Full mobile suite rerun after the fixture corrections: passed (614 files passed, 5 skipped; 5413 tests passed, 6 skipped).
- New desktop page width browser regressions: passed at 500, 1280, 1440 and 1920 px (12 tests), including populated schedule list/detail paths. Real page components, fonts and synthetic service responses; screenshots and JSON under `pages/`.
- Desktop sheet browser reproduction: baseline and changed components passed the expected before/after assertions at 500, 1280, 1440 and 1920 px (8 cases). Permanent current-component regression coverage passed in the full suite. Screenshots and JSON under `sheets/`.
- `node apps/server/scripts/run-ci-shard.mjs 1/4`: passed (53 files, 781 tests passed, 1 skipped).
- `git diff --check`: passed.

The original fixture failures are resolved; the full mobile rerun completed successfully.

Production-before proof accepted by revision 2 is complete for members, a profile, tray, Appearance and Interface size sheets, and a cancelled member-removal confirmation, at native 1279 and emulated 1920 CSS layout widths. See the measurement table and viewport caveats in inventory.md. Shared token integration is complete after Ruby’s ordered rebase onto main at 3f3f4a905. All temporary page-local 640/720 caps now reference the shared detail/list tokens.

Fresh pre-push reruns for this evidence delivery also passed: full mobile suite (614 files; 5413 tests passed, 6 skipped) and server shard 1/4 (53 files; 781 tests passed, 1 skipped).

After shared-token integration: root typecheck and UI policy passed; full mobile suite passed (615 files passed, 5 skipped; 5426 tests passed, 6 skipped). This includes desktop sheet placement/scrolling and real schedule page browser proofs.

Final server shard 1/4 passed after integration (53 files; 781 tests passed, 1 skipped). The confirmation opener was verified by screenshot before clicking; the open dialog was measured at both widths and closed with Cancel.

## Wallet review follow-up (DESKTOP-WALLET-1)

The shared Wallet shell now owns the desktop detail cap across populated, loading and error states. The built-page browser matrix passed all 12 cases, as did the pre-fix baseline matrix. It displays a fixture address, balance and asset row rather than merely checking an inner style. Before/after phone PNGs at 500 px are byte-identical; desktop after widths are centred at 640 px. Typecheck and UI component policy passed. Full mobile suite passed (616 files passed, 5 skipped; 5438 tests passed, 6 skipped).

Wallet pre-push server shard 1/4 passed (53 files; 781 tests passed, 1 skipped). Diff check passed.

## Current-main conflict resolution

Main f32794966 is integrated. Conflicting imports were combined so the desktop caps coexist with main’s InlineActionRow/ErrorBanner changes. The Wallet shell cap remains shared across populated/loading/error states. Root typecheck and UI component policy passed. The refreshed browser matrix passed (28 tests: schedule pages, Wallet states and sheet placement at 500/1280/1440/1920); after widths are unchanged.

Full mobile validation after current-main integration passed (617 files passed, 5 skipped; 5450 tests passed, 6 skipped).

Server shard 1/4 after current-main integration passed (53 files; 781 tests passed, 1 skipped). Diff check passed.
