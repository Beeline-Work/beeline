# Squire approval cleanup

Reproductions: `R-SQUIRE-CARD` and `R-SQUIRE-ROOM`.

The reported production approval requires a new vault/passkey ceremony. This proof uses an Android native build with the real card and an isolated local service running production `DaemonService` and `PhoneService` against PGlite. The incoming Squire decision is simulated; no live vault approval, production server deployment, or real credential access occurred.

| Path | Before | After |
| --- | --- | --- |
| System approval card | [Android before](android-before.png) | [Android after](android-after.png) |
| Local approval relay | [Before relay](android-relay-before.png) | [After relay](android-relay-after.png) |

`R-SQUIRE-CARD`: the same fetch_credential card originally showed the requester’s face and a wrapped “approval stays with Trusty Squire” footer. It now shows the existing connector SVG and only Review and View request in the footer. Requester attribution remains in the subline. Both native actions retain their touch height.

`R-SQUIRE-ROOM`: the HTTP integration regressions reproduced visible approval decision rows before the fix. The new regressions exercise approved, denied and expired decisions in Rooms and corners, including legacy card rows. Member Room reads, history, history-around, unread boundaries and Room previews exclude them, while the agent conversation still includes the original request ID and decision. A resume command is created for that same request.

The Android relay proof additionally claims those resume commands and posts a continuation using their original turn request IDs. The Room and corner show the request and continuation, with no approval sentence. [Service output](relay-result.json) records the retained agent-only decisions and completed resume commands. The System DM card remains present.

To repeat the local service proof from the repository root:

```sh
node --import tsx scripts/prove-squire-approval-cleanup.mjs
```

For Android, temporarily select `apps/mobile/scripts/squire-approval-native-proof.tsx` as the app entry, start Metro on port 18739, reverse ports 18739 and 18740 on the leased emulator, and open the dev-client URL. Tap “Approve test request” to simulate the Squire relay decision. Restore the normal app entry before running the mobile suite. The proof service listens only on loopback and uses disposable identities and an in-memory database.

The card captures used the same native fetch_credential fixture before and after the source change. The relay captures used server-indexed DTOs. Only Android was used for manual UI verification; browser tests remain part of the required full mobile suite.
