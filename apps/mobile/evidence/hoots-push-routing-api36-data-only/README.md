# Data-only Android push tap proof after inline actions integration

2026-09-26 · API 36 Google APIs emulator `buzzy_api36` (`emulator-5556`) · release APK with temporary local probe · local Beeline server on PostgreSQL.

Hoots authored eight final fresh durable messages in Moonscanner’s `#live_betting_model` Room and `DB query test` corner. The phone was signed in as `@captain`; **Selected Workspace** was selected before each push. The target Room and corner belong to **Moonscanner**, the other Workspace. Channel and personal tags use the same destination fields; only the message text differs. Case 6 has a JSON-shaped message. Fresh message IDs kept this final replay independent of earlier consumed responses. The final APK also re-centers an older notification target after its native row frame is measured; an earlier JSON target reached the corner but its text was clipped at the viewport edge.

The APK was built after `npm ci`: Gradle autolinked `expo-task-manager` 55.0.20 and the JS bundle included `beeline-notification-action`. The local fixture delivered the **data-only** Android FCM field map through Expo’s real `FirebaseMessagingDelegate.onMessageReceived(RemoteMessage)`. Expo drew the notification and Android dispatched its real shade `PendingIntent` on tap. The data included `title`, `message`, and `tag=messageId`, plus `workspaceId`, `roomId`, `channelId`, `messageId`, and `cornerId` for corners; reply action category fields were present. Firebase network transport was not exercised in this fixture; the [inline-actions proof](../push-inline-actions/README.md) covers that transport separately. The temporary receiver, local HTTP setting, and diagnostics lived only in the ignored generated Android project and were removed for the clean build.

Cold means HOME then killing the app process before data delivery; background means HOME with the process alive. The XML hierarchy recorded the selected Workspace before each push and the exact, uniquely worded message after tap. Every target text occupied at least 100 vertical pixels inside the transcript viewport; the trace records its bounds. Screenshots below are the resulting on-device screens.

| Case | Target | Tag | State | Tap path | Response to navigation | Result |
|---:|---|---|---|---|---:|---|
| 1 | Room | channel | cold | trampoline | 1.12s | [exact message](./case1-room-channel-cold-result.png) |
| 2 | Room | personal | cold | trampoline | 1.05s | [exact message](./case2-room-personal-cold-result.png) |
| 3 | Room | channel | background | live response | 1.24s | [exact message](./case3-room-channel-background-result.png) |
| 4 | Room | personal | background | live response | 1.20s | [exact message](./case4-room-personal-background-result.png) |
| 5 | corner | channel | cold | trampoline | 1.10s | [exact message](./case5-corner-channel-cold-result.png) |
| 6 | corner | personal | cold | trampoline | 0.80s | [exact message](./case6-corner-personal-cold-result.png) |
| 7 | corner | channel | background | live response | 1.07s | [exact message](./case7-corner-channel-background-result.png) |
| 8 | corner | personal | background | live response | 1.24s | [exact message](./case8-corner-personal-background-result.png) |

[Native and JS timing trace](./matrix-trace.txt) records every unique response id. All four cold taps arrived as `notificationResponse` with no `google.message_id` and reached the trampoline with `live=false`; the corrected guard cleared the retained task. Background responses reached the live activity directly. The native guard regression test covers both intent formats; response, initial-landing, and exact-message scrolling tests passed. The measured-row re-centering fixed the earlier clipped JSON landing without moving a transcript after a reader starts dragging. [Case 6’s notification](./case6-corner-personal-cold-notification.png) shows the JSON-shaped body before its exact corner message opened.
