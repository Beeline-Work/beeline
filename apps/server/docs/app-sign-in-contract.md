# Connect an app: phone contract

The authoritative types are in `packages/api-contract/src/workbench.ts`,
`packages/api-contract/src/phone-operations.ts`, and
`packages/api-contract/src/phone-types.ts`. The server fixture is
`apps/server/src/app-connections.integration.test.ts` (Room sign-in and
continuation tests).

A `RoomViewMessage` can contain one route-neutral `appSignIn` card:

```json
{
  "appId": "11111111-1111-4111-8111-111111111111",
  "appKey": "gmail",
  "name": "Gmail",
  "ownerId": "<Beeline person identity id>",
  "agentId": "<Beeline agent identity id>",
  "status": "pending"
}
```

Only the card's `ownerId` can start or complete sign-in. A Room viewer whose
identity differs from `ownerId` should see the need but no sign-in action.
Tap calls `beginAppSignIn({appId})`; the returned `authorizationUrl` is opened
in the system browser and is never written into Room history. The hosted
provider returns through `GET /v1/apps/oauth/verify?session_uri=…`, which
redirects to `beeline://beeline/settings/workbench/connect-signin` with
`appSignInSession`. The signed-in phone then calls
`completeAppSignIn({sessionUri: appSignInSession})`. The server verifies that
phone identity with the provider, confirms the exact pending account and
product, settles the Room card to `connected`, and queues an `app_connected`
command carrying the original request's provenance. A second completion of
the single-use session is refused.

From Workbench, `connectWorkbenchApp` returns the same `appId` and may also
return `authorizationUrl` for an immediate sign-in. A later reconnect can use
`beginAppSignIn({appId})`. `readWorkbench` derives the row's connection status
from the provider. `disconnectWorkbenchApp` revokes the provider account before
marking the row disconnected and revokes the app's standing approvals.

Tool discovery and execution remain daemon-only operations (`listAppTools`,
`executeAppTool`). The phone never receives provider credentials. One app row
and one `app:<key>` permission target represent the connection. The connected
person's own agents can execute; another person's agent gets a grant request
addressed to the connected person and cannot execute until that person
approves.

## Rollout

The server-only API key enables managed sign-in once the provider's callback
verifier targets `${PUBLIC_ORIGIN}/v1/apps/oauth/verify`. Deploy the server,
Body companion, and phone UI changes together. The schema migration disconnects
first-party Google connector rows and revokes their grants, so those people
must reconnect each Google product. The new server does not use the old Google
token tables; they remain for older server images until a later release can
remove them.
