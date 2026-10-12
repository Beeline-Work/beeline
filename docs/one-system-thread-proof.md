# Quiet helper updates and one System thread

Helper update restarts close the machine socket with the invisible `HELPER_UPDATE_CLOSE_CODE` / `HELPER_UPDATE_CLOSE_REASON` signal before agent teardown. The server releases presence silently for that exact signal. An ordinary close, network loss, or crash still writes one owner-only offline notice. `release-notify.ts` retains helper release delivery and reconnect reconciliation while producing no announcement messages. The obsolete device-registration release replay path and its queued data are removed. The existing idle gate and five-minute update deadline are unchanged.

Connector notices now use `ensureSystemDirectMessageRoom` and `SYSTEM_IDENTITY_ID`. The one-time `migrations/one-system-thread.ts` migration deletes other internal bots' DM rooms and their contents, removes connector identities, and attributes their retained shared-Room records to System. It preserves ordinary conversations and deleted-account history. There is no legacy bot-DM compatibility path.

The tray exposes the existing grant and permission decisions, question options and Skip. Each action keeps the viewer in the tray and refreshes its projection after completion. It shows complete bound script contents and option consequences. A source tap still opens the exact message. Squire approvals open Squire's own ceremony directly from the tray; Squire retains its mandate, passkey and sign-in authority. No native Beeline approval endpoint was added for Squire.

## Native evidence

Captured on 2026-10-12 using a task-owned Android emulator launched with `-read-only -port 5580`. Every adb command targeted `emulator-5580`. The shipped `NeedsYouCell` and `Button` rendered inside an Expo Go fixture against the changed server's real `PhoneService`, with an isolated local Workspace named **Beeline Review** and PGlite database. The swipe wrapper and busy loader were stubbed because Expo Go's Worklets version differs from the app's; no swipe, busy animation, full-app routing or production Squire ceremony claim is made. The upper-right Tools control belongs to Expo Go.

- Obsidian: [pending approvals](../evidence/one-system-thread/tray-before.png), [approved once](../evidence/one-system-thread/tray-approved.png), [denied](../evidence/one-system-thread/tray-denied.png).
- Bone: [pending approvals](../evidence/one-system-thread/tray-bone-before.png), [approved once](../evidence/one-system-thread/tray-bone-approved.png), [denied](../evidence/one-system-thread/tray-bone-denied.png).
- [Decision trace](../evidence/one-system-thread/decisions.json): `npm test` became `once`; `git status` became `denied`; both disappeared from Needs you without opening a thread.

Reproduce from the repository root with `node --import tsx scripts/prove-tray-inline.ts` (local fixture port 39197), then run Expo from `apps/mobile/tray-proof` with `../node_modules/.bin/expo start --localhost --port 39198`. Reverse port 39198 on a dedicated emulator and open `exp://127.0.0.1:39198`. Select the theme in `tray-proof/proof-theme.ts`; restart Metro with `--clear` if running with `CI=1`. The fixture is disposable and contains no production data or credentials. No live helper was stopped, restarted or updated.

## Regression coverage

- `machine-helper.test.ts`, `live-link.test.ts`, `daemon-live.test.ts`, `machine-offline.test.ts`: real update shutdown close signal, unexpected loss, reconnect, owner-only deduplication and expired-server recovery.
- `release-notify.test.ts`: helper pushes and reconnect reconciliation, no messages or bot DMs, no device-registration replay, no idle polling.
- `one-system-thread.test.ts`, connector/wallet integration tests: migration deletes every bot ledger, preserves System and conversations, new notices share System's identity and read-only DM.
- `needs-you.test.ts`, `tray.test.tsx`: grant and permission actions, choice/Skip, Squire ceremony opening without navigation or dismissal, server authorization refusals, visible mutation errors.
- Root typecheck, shared api-contract tests, mobile design/calm lints and the existing dead-code baseline.
