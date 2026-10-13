# Server safety and feature invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Database and reads

- Keep bounded app/enrichment/health pools separate from long migrations (`apps/server/src/database.ts`). Project core Room data before optional enrichment; boot asserts only the migration-final `beeline_schema_state`. Release isolation: [release pipeline](release-pipeline.md).
- **`deleteWorkspace` is owner-only and a real `DELETE`** relying on FK cascades. It checks existence before ownership (idempotent retries), writes `workspace_deletions` + per-member notices, revokes tokens only for agents with no other membership, and leaves media to `media-ttl.ts`. Every FK column into `messages`/`rooms`/`workspaces` must carry a leading-column index — an unindexed one forces Postgres to sequentially scan that whole child table per deleted row during the cascade, which is slow enough on a real table to blow the app pool's `APP_STATEMENT_TIMEOUT_MS` and leave the client's delete request hanging with no answer. Guarded by the `cascade-path foreign keys stay indexed` test in `database.test.ts`; `messages` itself is busy enough that a new index there goes through `createIndexConcurrently` in `migrate()`, not inline schema SQL.

## Grants and retirement

- **Agent Grants have one vocabulary and one authority axis.** `packages/api-contract/src/agent-grants.ts` owns kinds, statuses, the command-rule parser (`parseCommandGrantTarget`; `commandGrantMatches` is an argv prefix) and the decision line; policy follows `docs/approval-matrix.md`; `surface-capabilities.ts` lets a corner dominate a Room. Yolo defaults on (`backfillYoloModeDefault`) and is forced off in public Workspaces; credential-file argv and unread scripts (>4096 B/120 lines) still stop. Human profiles show the grant ledger (`readWorkspaceMembers`, `MemberGrantRow.tsx`, wording in `grantProvenanceLine`); an active `shared_asset` row alone offers revocation there. The agent settings page shows none.
- **Removing an agent retires it; its work survives.** `PhoneService.removeAgent` → `retireAgentFromWorkspace` (`agent-retirement.ts`) ends memberships, revokes all its daemon tokens and grants, hides the identity, clears configuration, and deletes schedules; corners, turns and messages stay. A helper retires only on 403 `agent_removed` (`isAgentRemovedError`), never on transport errors, 5xx, or plain 401.

## Room departure

- **Leaving a Room.** Any human can leave a top-level Room (`PhoneService.leaveRoom`, under the Room row lock); the last Workspace owner/admin in it deletes it for everyone and must pass `confirmDelete: true`. `leaveDeletesRoom` drives `buzz/room-leave.ts`. Swiping a DM writes a per-viewer `chat_dismissals` row hidden only until newer inbound activity.

## Feature contracts

- Wallet settlement and push authority: [wallet tools](wallet-tools.md), `wallet-notices.ts`, `wallet-webhooks.ts`. Balance deltas enrich history; they never replace owner-DM transaction push.
- Feedback closes only through `notify_feedback_fixed` with a merged PR in `BEELINE_FEEDBACK_REPOSITORY`; storage and policy: `apps/server/src/feedback.ts`, [triage workflow](workflows/feedback-triage.json).
- The GitHub star card acts only on the person's own tap and never gates anything (`github-star-prompt.ts`, `StarPromptCard.tsx`).
- Corner Apps are installed data, never downloaded code; permission manifest: `packages/api-contract/src/corner-apps.ts`.
- Agent faces and names are assigned together by the server under the Workspace lock (`assignSeededAgentIdentity`, `PhoneService.claimAgentConnectPairing`); never re-derive a face on the client. Keep face IDs aligned in `packages/api-contract/src/faces.ts` and `apps/mobile/sources/buzz/faces/index.ts`. Human handles win collisions (`workspace-handles.ts`).
- **A non-agent system author is a hidden `kind='human'` identity** with a fixed id (`SYSTEM_IDENTITY_ID`, `REVIEW_IDENTITY_ID`, `SCHEDULE_SCHEDULER_ID`), never a new `identities.kind`. `system-line.ts` sends Workspace facts and connector notices to each member's read-only `@system` DM (`assertRoomIsWritable`); `migrations/one-system-thread.ts` retires every other bot DM and its contents. Tray decisions reuse the transcript's grant/permission/choice operations; Squire retains its own ceremony (`needs-you.ts`, `tray.tsx`).

## External apps and MCP

- **Connected app tools execute only at the server boundary.** `apps/server/src/app-connections.ts` resolves the connection; Body's `list_app_tools`/`execute_app_tool` call `DaemonService` with turn authority and never hold provider tokens.
- **Registry MCP installation is discovery, never authority** (`mcp-registry.ts`; OAuth in `apps/body/src/registry-mcp.ts`).
- **Connection receipts DM only what needs a human** (`ConnectionUsageRecord.eventClass`). A missing tool is offered in-Room via `offer_connector`. `pairConnector` re-arms a conflicting row. A Squire `google_session` wall becomes an in-Room reconnect card (`npm run prove:squire-login-wall`).
- `external-mcp-capabilities.ts` stores only the profiles `squire-credential-use`/`squire-app-access`; Squire spend verbs need an owner-signed one-use envelope.

## Object storage

- `apps/server/src/object-storage.ts` is the one SigV4 client (Fly Tigris); `object-service.ts` owns rows. Byte lifetimes live in `media-ttl.ts`: person uploads `MEDIA_TTL_HOURS` (24), agent artifacts `ARTIFACT_TTL_HOURS` (7 days). An expired object answers 410 `media_expired` from the `object_expirations` tombstone, and the UI says "expired", never "failed". `post_artifact` validates per MIME in `artifact-validation.ts` (≤ `ARTIFACT_MAXIMUM_BYTES`).
