# Push notification deep-link verification

## Route contract

Gateway notifications now carry a string-only Expo/FCM data target with the stable source ids. For example, a corner approval notification maps to:

```json
{
  "type": "merge-approval-request",
  "target": "approval",
  "roomId": "room-123",
  "channelId": "corner-456",
  "cornerId": "corner-456",
  "eventId": "approval-event-789",
  "approvalId": "approval-event-789"
}
```

Both Expo response paths (the live response listener and `getLastNotificationResponseAsync` cold-start recovery) pass this target to the same router helper. The resulting route is `/buzz/chat/[channelId]` with the message or approval anchor plus the parent Room fallback. The chat screen reveals that anchor after loading and replaces a missing, archived, or concluded corner with its parent Room.

## Automated tap evidence

A real remote-push tap was not scriptable in this worktree without an enrolled physical Expo push token. The documented route test is the reproducible evidence instead:

- `apps/mobile/sources/utils/notificationRouting.test.ts` exercises both warm and cold Expo notification responses, asserts the exact expo-router corner/message and corner/approval route parameters, and asserts fallback to the parent Room when the target is missing.
- The same test verifies `_layout.tsx` wires both response paths to the exact-target handler.
- `apps/push-gateway/src/mapping.test.ts` verifies mention/DM payloads include Room and message ids and corner attention/merge-ready payloads include parent Room, corner, event, and approval ids.

## Validation

- `npm test --prefix apps/push-gateway -- --run`: 9 files, 85 tests passed.
- `npm run typecheck --prefix apps/push-gateway`: passed.
- `npm test --prefix apps/mobile -- --run --maxWorkers=1 --testTimeout=15000 --reporter=dot`: 214 files, 2,057 tests passed.
- `npm run typecheck --prefix apps/mobile`: passed.

The raised timeout only gives the existing branding tests enough headroom when the complete mobile suite is serialized; the notification route tests pass with their default timeout.
