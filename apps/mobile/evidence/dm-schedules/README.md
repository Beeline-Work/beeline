# DM schedules and subscriptions — Reproduction 1

The original DM menu offers only Mute notifications; `/schedule` is filtered out.
The phone API also rejects DM schedule/subscription reads and token operations.

## Reproduced

Ran the new regression against the unchanged HEAD versions of `_chat-surface.tsx`,
`phone-service.ts` and `subscription-webhooks.ts`, then restored the fix:

- Render the production DM menu for a human member without Workspace admin:
  `dm-schedules-action` is missing (render test fails).
- Evaluate the production command permission and query `schedule`: false (test fails).
- Create a webhook in the isolated database, turn its Room into a human/agent DM,
  then call `PhoneService.execute('readScheduledWork')`: rejects with
  `direct-message membership is immutable` (server regression fails).

The leased Android emulator had neither an installed Beeline app nor a signed-in
human session. The closest stand-in is the native Expo Go fixture below: it
extracts the actual DM menu JSX, renders the actual list and subscription pages,
and replaces navigation, authentication/cache boundaries and server DTOs.
The command path is exercised by the production-expression render regression.
No production account, subscription or token was accessed or changed.

## Demonstrated

On Android API 36 through Expo Go SDK 55:

1. Open the production DM menu fragment as a human member without admin.
   Schedules and subscriptions appears (`android-menu.png`).
2. Tap it, then tap Grok Bot results in the production list.
3. The production detail page shows Copy link, masked Token / Show, Rotate token,
   Recent calls and Stop (`android-subscription-masked.png`).

The title matches the reported subscription; the ID, link, suffix and payload are
explicitly synthetic. These are native component screenshots, not proof from the
live Ruby DM. The fixture deliberately refuses token reveal. The database tests
prove reveal, rotate, list and delete through the phone operations, exclude tokens
from cached projections, deny agents and outsiders (including a Workspace owner),
deny removed members, and allow human members of group DMs.

The existing Room list/detail controls are reused unchanged. Rooms currently offer
Stop; this change adds no new pause/edit controls.

## Validation

- `npm run corner:prepare`: passed.
- `npm run typecheck`: passed (workspaces, mobile and scripts).
- `npm run lint:ui-components`: passed.
- Server: subscription-webhooks and workflow-schedules suites (27 tests passed).
- Mobile: DM render/command, Room actions, Room schedules, slash verbs (53 tests passed).
- Baseline: DM render/command regressions fail (2 failures); DM server regression fails.

## Repeat native proof

From the repository root:

```sh
node apps/mobile/dm-schedules-proof/prepare.cjs
npm install --prefix apps/mobile/dm-schedules-proof --legacy-peer-deps
```

Install Expo Go SDK 55 on a Beeline-leased emulator. From
`apps/mobile/dm-schedules-proof`, start:

```sh
CI=1 ../node_modules/.bin/expo start --go --port 8209 --max-workers 2
```

Reverse that port with the leased device's explicit adb selector and open
`exp://127.0.0.1:8209`. Dismiss Expo's initial developer menu. Tap the schedule
entry, then Grok Bot results. The standalone proof never ships as the app entry.
