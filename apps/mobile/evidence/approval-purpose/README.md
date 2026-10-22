# Purpose-first approval cards

Owner-approved enhancement, not a defect report. The reference is Ruby's approved waiting/opened/decided mock from the corner brief.

The Android proof mounts the shipped `GrantRequestCard`, `TranscriptCard`, identity mark, fact rows, disclosure control and decision buttons in Expo Go on an API 35 emulator. It uses the real Beeline themes and fonts. The fixture does not run its example cleanup script or create a production grant. Its decision callback changes the fixture status; the HTTP integration proof separately verifies request storage, Room projection and a persisted approval decision.

Expo Go adapters replace Unistyles with the same theme values, disable animation, and stand in for the unused keyboard controller. The proof pins the Expo SDK 55 SVG version; these adapters are confined to `approval-proof` and do not enter the shipped app. This is a native component proof, not an installed production app or a production sign-in proof.

| State | Bone | Obsidian |
| --- | --- | --- |
| Waiting; script folded | [Screenshot](bone-waiting.png) | [Screenshot](obsidian-waiting.png) |
| Script opened | [Screenshot](bone-opened.png) | [Screenshot](obsidian-opened.png) |
| Allowed; buttons replaced | [Screenshot](bone-decided.png) | [Screenshot](obsidian-decided.png) |

The existing No/Once/Always labels and decisions are preserved, as the brief requires. No is secondary and Always remains primary. The approved visual example's Deny/Allow once labels do not replace the existing decision contract.

To reproduce, from the repository root:

```sh
npm run corner:prepare
npm install --prefix apps/mobile/approval-proof --legacy-peer-deps
```

Set `proofTheme` in `apps/mobile/approval-proof/settings.ts` to `bone` or `obsidian`, then start Expo from `apps/mobile/approval-proof`:

```sh
EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 EXPO_NO_DEPENDENCY_VALIDATION=1 npx expo start --port 8093 --host lan
```

Open `exp://10.0.2.2:8093` in Expo Go using the emulator’s direct host route. Capture the initial card, tap Show script and capture the full script, tap Hide script, then Once and capture the settled card. Repeat with the other theme. Stop Metro before any package build that removes `dist/`.

The service path is covered by `apps/server/src/integration.test.ts`, test `stores the purpose and declared facts with the approval request`: request a pending shared-cache grant through the daemon HTTP route, read its purpose/facts/machine through the phone Room route, approve it through the phone operation, and reread the settled request. Invalid missing, blank and oversized purposes are rejected through the same daemon HTTP route.
