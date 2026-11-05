# Phone command admission

The public phone operation facade delegates every contract write to `MobileCommandOwner`.
Only `PhoneReadOperation` can use `LiveConnection.request`; the command transport method
is private and its installed bridge belongs to the persisted intent owner. The server's
single dispatcher admits every write through `RouterCommandLedger`, including requests
from installed apps without command metadata. There is no caller-supplied executor.

## Audited doors and decisions

The baseline inventory is snapshot `e1fff40b56a68158cda3aa7580e75273fe64e1ff`
(2026-11-04). Line references in the caller table identify that snapshot, before edits.
The code and tests named here own the current implementation.

| Door / exception at baseline | Decision and evidence |
| --- | --- |
| `apps/mobile/sources/sync/transport/monolith-operation.ts:104-130` | Remove its raw write capability. Preserve the public facade and deadlines; its read/write discriminator now narrows the raw request branch to `PhoneReadOperation`, and its write branch uses the existing command owner. All callers below migrate together without feature-specific policy. |
| `apps/mobile/sources/sync/transport/room-view-client.ts:135-149` | Route read marks, voice selection/preview and pairing through the same command facade. History and other reads keep their existing adapter, DTO checks, cursors and cancellation. |
| `apps/mobile/sources/buzz/voice-request.ts:14-19` | Route all voice controls through the facade. The existing LiveKit audio boundary is independent of these control operations. |
| `apps/mobile/sources/buzz/room-page-observation.ts:10`, `client-error-report.ts:53` | Route telemetry writes through the owner too; retain bounded deadlines and failure isolation from navigation. |
| `apps/mobile/sources/buzz/command-owner.ts:46-50`, `command-message-gesture.ts:17`, `router-owner.ts:230-245`, `surface-storage.ts:118` | Remove the web command bypass. Browser writers now commit changed intents under a shared Web Lock to localStorage. Concurrent tabs cannot overwrite each other; a new tab adopts uncertain identities after the original closes. Denied storage or missing lock authority fails before transport. Native keeps MMKV. |
| `apps/server/src/phone-operations.ts:258-310` | Remove the identity-optional direct write branch and the injectable executor. Only reads execute without admission. Reviewed atomic/Tray/scheduled adapters retain their transaction and authority rules. Other effects use conservative at-most-once external admission. |
| `apps/server/src/server.ts:2816-2817` | Delete the second callback into `PhoneService.execute`; operation HTTP uses the sole dispatcher. |
| `apps/server/src/phone-service.ts:5685-5706` | Preserve installed read-and-mark-seen behavior through command admission. Only explicit `markSeen:false` forms of `readNeedsYou`/`readTray` have the raw read capability; current preview callers already use that form. |
| `packages/net/src/routes.ts:367-393` | Retain the declarative route compatibility metadata: it describes wire/codec migration, not permission to execute a write. Runtime capability enforcement belongs to the command owner and the existing router boundary guard. |

## Kept requirements

- **Installed old app wire formats:** `PhoneRequestFrame.command` remains optional.
  `phone-operations.ts` adapts an unkeyed request to server admission, retaining its
  original result and service semantics. This is required by independently compatible
  server/mobile delivery (`release-pipeline.md`, “independently backward-compatible”)
  and the real HTTP/socket upgrade/rollback proof `P10` in `phone-socket.integration.test.ts`.
  It cannot provide a stable client intent that an old binary never sent; old prepared
  message IDs retain their existing replay key. Unkeyed old actions get a fresh
  server identity. **There is no direct-effect compatibility branch.**
- **Secrets and short-lived control payloads:** the exhaustive operation policy in
  `packages/net/src/private/command-intents.ts` decides durable versus transient input.
  Sign-in codes, credential-bearing wake inputs, push/invite/pairing capabilities and
  binary media must not enter durable phone storage. Voice/presence and diagnostic
  payloads also must not restart stale sessions after a crash. Their immutable ID and
  digest persist, while payloads stay in memory; a restarted owner cannot replay them.
  Same-session delivery still uses the same command identity and server ledger.
- **Fresh service results:** generic provider ceremonies may return credentials or
  DTOs without a projection authority certificate. Persist outcome-only receipts and
  release their original result only for that execution, through an owner-held weak
  identity. Replayed/serialized receipts cannot mint that release. Existing certified
  atomic/prepared results retain their authority fences. Tray transaction outcomes
  remain durable and null; only the original response may carry the service DTO.
- **Separate byte/secret transport boundaries:** the audit's generic-operation scope
  does not replace HTTP media/transcription bodies or the vault relay with JSON socket
  frames. Existing media/audio bodies exceed the socket's 64 KiB bound; vault values
  require Fly replay to the helper and must never enter durable commands/PostgreSQL.
  The unchanged inventory is `apps/mobile/network-channels.json`; byte/relay owners
  are `monolith-rig-transport.ts:344`, `speech-transcription.ts`, and `vault-save-http.ts`.
- **Rooms MCP human consent:** `PhoneService.execute` is also a domain service for the
  separately authenticated, bounded Rooms MCP surface (`rooms-mcp.ts:373-374`). That
  trust boundary retains its own consent/idempotency contract; it is not a phone RPC
  executor. The phone adapter's effect handle is closure-private inside the dispatcher.

## Enforcement and regression evidence

The existing `scripts/router-boundaries.mjs` check scans the current
`apps/mobile/sources/app/(app)` tree and rejects raw request calls, extracted or
aliased request capabilities, command bridge access, owner replacement and server
capability forwarding outside exact owners. No count allowance or warning-only path
was added. `phone-command-boundary.typecheck.ts` proves a raw write and direct command
transport access do not typecheck. In-memory backdoor tests exercise the same scanner.
The existing network and architecture guards retain their budgets.

Selected list/Tray reads retain their `ReadAuthority` capability after integration
with the read owner. The owned preview form remains a raw read, while the legacy
mark-seen form enters command admission; `monolith-operation.test.ts` covers both.

Behavioral coverage: `command-intents.test.ts` (digest-only storage),
`command-owner.test.ts` (persist-before-send, duplicate joining, uncertain
identity, cold-start cancellation and storage failure), `command-owner.web.test.ts` (concurrent tab writers,
closed-tab adoption and denied storage), `router-command-dispatch.integration.test.ts` (wallet
admission/replacement/uncertainty, secret results and old wire),
`tray-decision-command.integration.test.ts`, `scheduled-work-command.integration.test.ts`,
and `phone-socket.integration.test.ts` (real HTTP/socket compatibility).

## Baseline state-changing facade callers

All listed calls now delegate through the same command owner. There is no per-caller
write exception. Reads, which are outside this finding, are omitted.

| Baseline site | Operation | Decision |
| --- | --- | --- |
| `apps/mobile/sources/app/(app)/beeline/chat/RepositoryOnboardingCard.tsx:44` | `actOnRepositoryCard` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/RepositoryOnboardingCard.tsx:58` | `actOnRepositoryCard` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/RepositoryOnboardingCard.tsx:64` | `actOnRepositoryCard` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:825` | `updateRoomPushState` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3520` | `cancelAgentTurn` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3730` | `reactToMessage` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3776` | `setMessageBookmark` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3804` | `reportMessageIssue` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3841` | `deleteRoomMessage` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:3914` | `sendRoomMessage` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4516` | `decideAgentGrant` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4536` | `answerChoice` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4560` | `skipChoice` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4577` | `createRoomPoll` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4611` | `acceptConnectorOffer` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:4631` | `acceptConnectorOffer` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:5809` | `beginAppSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:5839` | `completeAgentSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:5865` | `decideApprovalCard` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:5915` | `decideApprovalCard` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:7358` | `updateRoom` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/community.tsx:75` | `createWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/community.tsx:76` | `updateWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/create-workspace.tsx:73` | `createWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/create-workspace.tsx:78` | `updateWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:220` | `removeWorkspaceMember` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:269` | `resolveDirectMessage` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:296` | `addWorkspaceMember` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:429` | `revokeAgentGrant` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:971` | `updateAgentYolo` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:999` | `updateAgentAccessPolicy` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:1110` | `refreshAgentUsage` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:1137` | `updateAgentWake` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/onboarding.tsx:550` | `claimManagedHandle` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:189` | `beginGitHubInstallation` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:377` | `updateIdentityPushLevel` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:586` | `updateIdentitySpeakingSpeed` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:741` | `updateIdentityFace` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/subscription.tsx:60` | `rotate ? 'rotateWebhookToken' : 'revealWebhookToken'` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect-signin.tsx:130` | `acceptConnectorOffer` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect.tsx:241` | `acceptConnectorOffer` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/settings/workflows.tsx:91` | `dispatchRoomWorkflow` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:442` | `clearNeedsYou` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:484` | `decideAgentGrant` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:487` | `decideWritePermission` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:492` | `answerChoice` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:495` | `skipChoice` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:533` | `clearNeedsYouSection` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:543` | `clearMessageBookmarks` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:659` | `setMessageBookmark` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/beeline/tray.tsx:691` | `setMessageBookmark` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/join/[token].tsx:97` | `redeemInvite` | Canonical owner via the facade |
| `apps/mobile/sources/app/(app)/join/[token].tsx:129` | `redeemInvite` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/needs-you-store.ts:400` | `markNeedsYouSeen` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/scheduled-work.ts:263` | `deleteRoomSchedule` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/scheduled-work.ts:278` | `deleteRoomSubscription` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/wallet-source.ts:43` | `refreshWallet` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/wallet-source.ts:45` | `createWallet` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/wallet-source.ts:59` | `sendFromWallet` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/wallet-source.ts:63` | `grantWalletDelegation` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/wallet-source.ts:69` | `revokeWalletDelegation` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:138` | `beginLinkSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:142` | `cancelLinkSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:146` | `disconnectLinkSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:179` | `pairConnector` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:188` | `cancelGoogleSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:193` | `beginGoogleSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:265` | `revokeConnectionGrants` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:277` | `unpairConnector` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:284` | `disconnectGoogleSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:293` | `unpairConnector` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:308` | `connectWorkbenchApp` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:321` | `beginAppSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:325` | `completeAppSignIn` | Canonical owner via the facade |
| `apps/mobile/sources/buzz/workbench-source.ts:329` | `disconnectWorkbenchApp` | Canonical owner via the facade |
| `apps/mobile/sources/components/DesktopRoomInspector.tsx:380` | `cancelAgentTurn` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/AiClientsSection.tsx:26` | `disconnectAiClient` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/StarPromptCard.tsx:75` | `answerStarPrompt` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:179` | `createInvite` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:386` | `updateRoom` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:406` | `addRoomMember` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:437` | `deleteWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:581` | `updateWorkspace` | Canonical owner via the facade |
| `apps/mobile/sources/push/buzz-push-registration.ts:298` | `registerPushDevice` | Canonical owner via the facade |
| `apps/mobile/sources/push/buzz-push-registration.ts:337` | `sendPushTest` | Canonical owner via the facade |
| `apps/mobile/sources/push/buzz-push-registration.ts:406` | `unregisterPushDevice` | Canonical owner via the facade |
| `apps/mobile/sources/push/notification-action-runtime.ts:66` | `decideAgentGrant` | Canonical owner via the facade |
| `apps/mobile/sources/push/notification-action-runtime.ts:68` | `sendRoomReply` | Canonical owner via the facade |
| `apps/mobile/sources/push/update-receipt.ts:81` | `reportRunningUpdate` | Canonical owner via the facade |
| `apps/mobile/sources/push/web-push-registration.ts:58` | `unregisterPushDevice` | Canonical owner via the facade |
| `apps/mobile/sources/push/web-push-registration.ts:112` | `registerPushDevice` | Canonical owner via the facade |
| `apps/mobile/sources/sync/transport/monolith-rig-transport.ts:279` | `name as keyof import('@beeline/api-contract/phone').PhoneOperationMap` | Canonical owner via the facade |
