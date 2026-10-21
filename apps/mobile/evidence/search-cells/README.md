# Search cells and Profile choices

Feature request, not a defect report. Baseline: `39b024a81`.

Android API 36 x86_64, Beeline-leased isolated `emulator-5562`, existing runtime-39 development APK, branch JavaScript served by Metro on port 18888. The production Profile route, Connectors route, toolbar, DM picker, Forward picker and RepoPicker are rendered by `scripts/search-cell-proof`. Identities, catalogs and server receipts are disposable fixtures. This is a native rendered-path stand-in, not authenticated production-server or release-APK proof. Navigation and choice actions invoke the mounted React callbacks through Hermes CDP; scrolling uses ADB. The repository specimen wraps the existing inline picker in a proof sheet; its candidate rows are intentionally unchanged.

Profile shots show Edit mode with the choices closed; Cancel/Save remain beneath Soul. The baseline model shot is the former inline expansion. Baseline Profile has its existing raw-space warning; the fixture suppresses that known warning on the final captures. A proof-only nested-list wrapper was removed; the final repository wrapper uses `scrollBody={false}`. Neither suppression nor the proof entry changes the shipped entry.

| Surface | Before | After |
| --- | --- | --- |
| Profile, choices closed | [Before](profile-before.png) | [After](profile-after.png) |
| Model choices | [Before](model-before.png) | [After](model-after.png) |
| Connectors | [Before](connectors-before.png) | [After](connectors-after.png) |
| Room list search | [Before](rooms-before.png) | [After](rooms-after.png) |
| New DM picker | [Before](dm-before.png) | [After](dm-after.png) |
| Forward picker | [Before](forward-before.png) | [After](forward-after.png) |
| Repository picker | [Before](repo-before.png) | [After](repo-after.png) |

Additional proof: [Model in Obsidian](model-obsidian.png), [model choice committed and sheet dismissed](model-applied.png), [Thinking level sheet](thinking-after.png), [Thinking level changed to low and sheet dismissed](thinking-applied.png). The writes use the same Members handlers and fixture receipts; the existing management tests assert the exact write payloads, including Fast mode and name/soul save isolation.

The existing `HullDialogInput` now has `search` and `sheetSearch` variants. This preserves native field props and the dialog variant, without introducing a new component. Sheet height/inset constants are shared with `HullActionSheetRow` through a geometry-only module, avoiding a circular component import. Page searches use `layout.row` (currently 64), `space.sm`, body type and the row hairline; sheet searches use 52 and `HULL_SHEET_INSET`. Resting dividers use `borderStrong`, focused dividers use `accent`.

Validation: root `npm run typecheck`; 130 tests across HullDialog, Members management/design, DM/Forward picker, RepoPicker and the two design lints. The Impeccable detector reported no findings for the changed shared input. No native, fingerprint or release files are changed.

To reproduce the disposable harness, back up `apps/mobile/index.ts` and `metro.config.js`. Copy the normal Metro configuration to `metro.search-base.cjs`, replace the Metro configuration with `module.exports = require('./scripts/search-cell-proof/metro.cjs')`, and replace the entry with `import './scripts/search-cell-proof/entry'`. From `apps/mobile`, run `npx expo start --dev-client --port 18888`, reverse that port, and open the existing development client. Read the proof scripts before running them. `capture.cjs before|after` captures the mounted screens; it expects the leased emulator serial currently recorded in the script. Restore the normal entry/configuration and remove `metro.search-base.cjs` afterward. Never commit these temporary entry/configuration changes.
