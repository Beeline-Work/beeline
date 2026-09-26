# Hoots Android push tap proof

2026-09-26 · Android API 36 emulator `buzzy_api36` (`emulator-5556`) · release APK built from this branch · local Beeline server at `10.0.2.2:8080` with PostgreSQL.

Hoots authored eight distinct durable messages in Moonscanner’s `#live_betting_model` Room and its `DB query test` corner. The phone was signed in as `@captain`, and **Selected Workspace** was active before every notification. Personal rows tag `@captain`; channel rows tag the Room or corner. The server’s `background.ts`/`firebase-push.ts` sends the same destination fields for either tag kind.

Each row used an Android notification with a real `PendingIntent` targeting the package launcher and FCM-shaped extras (`google.message_id`, workspace, Room/corner, exact message). A temporary receiver in the generated emulator build posted it; Firebase delivery itself was unavailable in the local fixture. Cold means HOME then `kill -9` of the app process; background means HOME with the process alive. The script tapped the notification shade, asserted the selected Workspace beforehand, and asserted the exact message text in the on-screen UI hierarchy afterward. The results are screenshots, not navigation mocks.

| Case | Target | Tag | App state | MainActivity live | Trampoline → navigate | Visible exact message |
|---:|---|---|---|---|---:|---|
| 1 | Room | channel | cold | no | 2.32s | [message 1](./case1-room-channel-cold-result.png) |
| 2 | Room | personal | cold | no | 2.97s | [message 2](./case2-room-personal-cold-result.png) |
| 3 | Room | channel | background | yes | 1.14s | [message 3](./case3-room-channel-background-result.png) |
| 4 | Room | personal | background | yes | 1.14s | [message 4](./case4-room-personal-background-result.png) |
| 5 | corner | channel | cold | no | 2.48s | [message 5](./case5-corner-channel-cold-result.png) |
| 6 | corner | personal | cold | no | 2.98s | [message 6](./case6-corner-personal-cold-result.png) |
| 7 | corner | channel | background | yes | 1.17s | [message 7](./case7-corner-channel-background-result.png) |
| 8 | corner | personal | background | yes | 2.91s | [message 8](./case8-corner-personal-background-result.png) |

`matrix-trace.txt` records each unique response id and routing timestamp. Every cold case used `MainActivity.onCreate` with `live=false`; every background case used `MainActivity.onNewIntent` with `live=true`. Initial landing settled before the eight-second deadline in all eight cases; the timeout path is covered by `notification-response.test.ts`. The screenshot was captured after an 11-second cold or 5-second background settle window.

Case 6 used a JSON-shaped notification body: `{"note":"Hoots @captain corner cold exact message 6"}`. Before the Expo serializer/mapper patch, its response contained only `note` and logged `No supported route found`; after the patch, `content.data` contained `workspaceId`, `roomId`, `channelId`, `cornerId`, and `messageId`, and [the exact corner message](./case6-corner-personal-cold-result.png) was visible. [The notification](./json-body-notification.png) and [pre-tap selected Workspace](./selected-workspace-before.png) are retained alongside the matrix.

Verification: mobile routing/landing tests 80 passed; mobile runtime/branding/OTA tests 102 passed; server Firebase payload tests 16 passed; mobile TypeScript and native fingerprint checks passed. A clean production `expo prebuild` and `assembleRelease` also passed. The packaged manifest has the trampoline as launcher and no cleartext or probe receiver; its embedded JS bundle has no local-login or probe markers. The temporary login shortcut, local HTTP cleartext setting, probe receiver, and diagnostic native logs were removed from the shipping sources after this proof.

Integration: [the parallel inline-actions change](https://github.com/Beeline-Work/beeline/pull/1764) switches Android FCM to data-only after this test build. Rebase and integrate it before merge, keep one final native runtime pin/fingerprint for the next store binary, and rerun tap delivery proof for its data-only notification shape; this matrix proves the pre-integration payload and launcher path.
