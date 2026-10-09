# Server test coverage audit — 2026-10-09

This inventory covers every current `apps/server/src/**/*.test.ts` file after the server-suite split and the five-minute schedule proof removal. I reviewed the test declarations and compared same-file and cross-file test bodies and titles for duplicate behavior. The monolith integration file currently expands to 238 Vitest cases (214 source declarations); all were reviewed by title. The file rows below point to the live behavior they protect.

## File coverage map

| File | Live behavior covered | Decision |
| --- | --- | --- |
| `account-deletion.test.ts` | deleteAccount | retained |
| `agent-access.test.ts` | who may address an agent | retained |
| `agent-avatar.test.ts` | generated avatar rendering | retained |
| `agent-class-retirement.test.ts` | retireAgentClasses | retained |
| `agent-command.integration.test.ts` | server command authority, sibling corner steering, reviewer wake recovery, and Room/corner relays | retained |
| `agent-command.scaling.test.ts` | claim latency budget; runs alone on a dedicated runner | retained |
| `agent-grant-inspect.test.ts` | listAgentGrantRequests | retained |
| `agent-health.test.ts` | roomAgentHealth; isConfiguredReviewer; firstHealthyAgent; related cases | consolidated assertions; retained coverage |
| `agent-lifecycle-command.test.ts` | tagged agent lifecycle commands | retained |
| `agent-removal.test.ts` | PhoneService agent removal | retained |
| `agent-schedules.test.ts` | agent schedule background posting; manager schedule phone operations; agent tool schedule daemon operations; related cases | retained |
| `agent-sign-in.test.ts` | owner-only login flow, helper link/code handling, offline and failed cards across harnesses | consolidated assertions; retained coverage |
| `apns-push.test.ts` | APNs provider token and request; APNs HTTP/2 provider; uses the same activity slot for APNs collapse and grouping, separate from attention | retained |
| `app-connections.integration.test.ts` | connector setup, callback recovery, app tool execution, and route ordering | retained |
| `auth.test.ts` | opaque token ceremony | retained |
| `background.test.ts` | background advisory locks, turn routing, push delivery, and media sweep | retained |
| `can-read-rooms.test.ts` | PhoneService.canReadRooms batch authorization | retained |
| `cdp-client.chains.test.ts` | swaps; sends; balances on every chain; related cases | retained |
| `cdp-client.keyparse.test.ts` | cdp Ed25519 key parsing | retained |
| `cdp-client.test.ts` | cdp request construction | retained |
| `channel-mention.test.ts` | @channel mention expansion; @channel push delivery | retained |
| `chat-corner-counts.test.ts` | chat corner counts | retained |
| `choice-expiry.test.ts` | ChoiceExpiryLoop | retained |
| `compact-room-view.test.ts` | compact Room reads | retained |
| `composio-apps.test.ts` | managed app provider boundary | retained |
| `connection-presence.test.ts` | delivery-driven presence | retained |
| `corner-follow.test.ts` | Mine corners use the push Followed rule | retained |
| `corner-lifecycle.test.ts` | corner transition authority, merge gate, handbacks, review wakes, holds, recovery, and reach | retained |
| `corner-open-from-corner.test.ts` | opens a sibling corner in the parent Room from a corner turn; attaches a file shared in the calling corner to the sibling corner brief | retained |
| `corner-open-implementer.test.ts` | Reproduction O1-1: naming Beta assigns the work to Beta and keeps Alpha as author; refuses implementer %s without any opening writes; refuses a removed parent member without any opening writes; related cases | retained |
| `corner-open-watch.test.ts` | open_corner watches for merged by default and the merge wakes the opener once; watchMerge false opens without a watch and the merge wakes nobody; a late watch_corner on a merged corner returns the merge and wakes once; related cases | retained |
| `corner-owed.test.ts` | corner_owed | retained |
| `corner-review-dispatch.test.ts` | reviewer dispatch, worker attribution, and no-check PR handling | retained |
| `corner-reviewer-list.test.ts` | a failed review turn; approve_merge with a reviewer list; updateRoom reviewer list; related cases | retained |
| `corner-state.test.ts` | deriveCornerState from the workflow run; deriveCornerState with the owed fact | retained |
| `corner-wake.test.ts` | corner wake (waitForCornerWake); corner wake ignores the corner's own turn narration; the wake is reachable over the daemon route | retained |
| `corner-watch.test.ts` | Reproduction O-2: a watcher receives a named sibling merge in A; refuses %s and writes nothing; returns all merged PR snapshot fields from corner facts; related cases | retained |
| `daemon-live.test.ts` | held presence for a live connection; one machine socket for every agent on a helper machine; protocol heartbeat on helper sockets | retained |
| `daemon-service.access.test.ts` | daemon room access | retained |
| `daemon-service.completion-latency.test.ts` | agent reply completion latency | retained |
| `database-budget.test.ts` | database connection budget | retained |
| `database.test.ts` | migration, pool recovery, schema indexes, query budgets, and durable SQL invariants | retained |
| `dm-attachment.test.ts` | DM attachments | retained |
| `durable-avatar.test.ts` | durable workspace avatars through the installed phone contract; avatar byte policy | retained |
| `event-cascade.test.ts` | an event cascade | retained |
| `feedback-triage-workflow.test.ts` | feedback-triage workflow | retained |
| `feedback.test.ts` | notify_feedback_fixed (close the loop); @system and Report issue (human path); report_feedback (agent path); related cases | retained |
| `firebase-push.test.ts` | Firebase push credentials; Firebase push routing payload; Firebase push inline actions; related cases | retained |
| `github-operations.test.ts` | GitHub installation and repository operations, PR status, merge, webhook, and credential recovery | retained |
| `github-star-prompt.test.ts` | shows the card on the first win after the 3rd reply and stars with the person token; waits for a later win when the milestone reply itself carries the artifact; opens the repository instead when GitHub refuses the star; related cases | retained |
| `grant-policy-upgrade.test.ts` | withdrawSupersededGrantAsks | retained |
| `health-query-age.test.ts` | health query age | retained |
| `held-review-wake.integration.test.ts` | Reproduction S-07 end to end: a held review wake reaches the reviewer helper | retained |
| `helper-version-gate.test.ts` | helper minimum version | retained |
| `institutional-context-hybrid.test.ts` | getInstitutionalContext hybrid vector snapshot | retained |
| `institutional-corner-authority.test.ts` | corner turn institutional authority | retained |
| `institutional-curator.test.ts` | expires agent saves after 90 unused days, blanking text and retaining rows, and never expires explicit saves; never expires skills or workflows, however long they go unused; restores items the old curator only aged out, and blanks what was replaced; related cases | retained |
| `institutional-history.test.ts` | authorized institutional history search | retained |
| `institutional-memory-corner-requester.integration.test.ts` | save_memory requester authority on corner wakes | retained |
| `institutional-memory-embeddings.test.ts` | OpenRouter embedding request/response, backfill, retries, and failure handling | retained |
| `institutional-memory-evaluation.test.ts` | institutional memory shadow evaluation | retained |
| `institutional-memory-lifecycle.test.ts` | agent memory tools at the server boundary; memory expiry by kind and by real use; Reproduction R1: no hidden memory review | retained |
| `institutional-memory-search-recall.test.ts` | search_memory recall (institutional memory); search_memory hybrid vector recall (no shared words) | consolidated assertions; retained coverage |
| `institutional-memory-shadow.test.ts` | institutional memory shadow capture, serving, and turn authority | retained |
| `institutional-memory-turn-stats.test.ts` | getInstitutionalMemoryTurnStats | retained |
| `institutional-objectives.test.ts` | institutional objective dashboard: real token budget and cohorts | retained |
| `institutional-rollout.test.ts` | institutional memory rollout gates | retained |
| `institutional-skill-anchors.test.ts` | Workspace procedure code anchors | retained |
| `institutional-skills.test.ts` | save_skill; delete_skill; merge-derived restricted Workspace procedures; related cases | retained |
| `integration.test.ts` | authenticated monolith HTTP flows for Workspace/Room membership, messages, corners, GitHub, grants, connectors, events, and choices | retained |
| `json-response.test.ts` | JSON response encoding | retained |
| `link-agent-wallet.test.ts` | posts the Link approval URL only to the owner’s private Link card; registers exact hosted OAuth redirect with state and S256 PKCE, then consumes state once; shows Link ineligibility for a non-US/Canada consumer and refuses a spend request; related cases | retained |
| `live.presence-dedupe.test.ts` | LiveHub presence version dedupe | retained |
| `mcp-registry.test.ts` | McpRegistryClient | retained |
| `media-object-routes.test.ts` | media object routes | retained |
| `message-mentions.test.ts` | typedMentionHandles; isChannelMentionToken; hasChannelMention | retained |
| `migration-retry.test.ts` | retryOnDeadlock; retryMigrationStep | retained |
| `migrations/corner-names.test.ts` | hyphenates spaced corner names once, with deterministic suffixes per Room | retained |
| `model-catalog-notice.test.ts` | postAgentModelCatalog: automatic fallback notice | retained |
| `monolith-auth.test.ts` | mounted monolith auth | retained |
| `monolith-paint-budgets.test.ts` | monolith hot-path PhoneService read budgets (deck + transcript) | retained |
| `needs-you.test.ts` | PhoneService Needs-you tray; the Needs-you ask rule; the ask rule in SQL | retained |
| `object-projection.test.ts` | artifact attachment projection | retained |
| `object-service.test.ts` | ObjectService | retained |
| `object-storage.test.ts` | object-storage golden signatures (fixed clock) | retained |
| `object-sweep.test.ts` | object sweep | retained |
| `operator-dashboard.test.ts` | private operator dashboard | retained |
| `phone-operation-names.test.ts` | PHONE_OPERATION_NAMES | retained |
| `phone-read-limit.test.ts` | phone history and outline reads; identity rate limit; history outline cache | retained |
| `phone-service.agent-connect.test.ts` | pairing claims, seeded agent identity, machine grouping, and Workbench read projection | retained |
| `phone-service.agent-profile.test.ts` | agent profile recent work; removing a human from the Workspace; enforces strict role authority and spectator writes and lists Workspace-owned agents; related cases | retained |
| `phone-service.archived-corners.test.ts` | readCorners | retained |
| `phone-service.message-search.test.ts` | searchMessages | retained |
| `phone-service.model-change-wake.test.ts` | a model/effort selection change wakes the agent daemon | retained |
| `phone-service.read-room-latency.test.ts` | PhoneService.readRoom latency | retained |
| `phone-viewing.test.ts` | phone viewing over the live socket | retained |
| `postgres-live.test.ts` | Postgres live fanout | retained |
| `pr-checks-status.test.ts` | live PR check rollup, mergeability, no-check heads, and reviewer wake decisions | retained |
| `production-corpus-hot-reads.test.ts` | production-scale query plans and hot read limits; runs in its own gate | retained |
| `production-corpus-width.test.ts` | PRODUCTION-CORPUS width-shaped room-list | retained |
| `production-latency.test.ts` | production database-pool latency boundary | retained |
| `push-follow.test.ts` | Followed level follows corners; Room mute | retained |
| `push-sensitivity.test.ts` | sensitivity boundaries and replacement slots; push sensitivity service path; selects finished agent turns at %s and never tool or system chatter; related cases | retained |
| `query-profile.test.ts` | query profiler; rolling query window | retained |
| `read-cursor.test.ts` | the read cursor over the live phone surface | retained |
| `recent-identity-times.test.ts` | RecentIdentityTimes | retained |
| `registry-mcp-oauth.test.ts` | lets only the paired helper claim one short-lived callback code; reports an authorization attempt nobody started as expired; pushes a connector wake when the human cancels a registry sign-in | retained |
| `registry-mcp.integration.test.ts` | Registry MCP connection orchestration | retained |
| `release-notify.test.ts` | notifyReleaseDelivered; composeReleaseNotice | retained |
| `release-push-catchup.test.ts` | release push catch-up at device registration | retained |
| `review-access.test.ts` | the review identity; the Google Play review secret | retained |
| `reviewer-approval-surface.test.ts` | the turn a reconciled reviewer is woken into | retained |
| `room-webhooks.integration.test.ts` | demonstrates request → admin card → private one-time URL → quoted subscriber wake and all endpoint controls; denied and expired requests mint no tokens; direct creation and explicitly shared secret work; requires human admin authority, accepts a Room admin without a Workspace role, and refuses agent-forged webhook events; related cases | retained |
| `server-cors.regression-1.test.ts` | web app CORS | retained |
| `server.test.ts` | HTTP readiness, auth, live command push, and phone committed-row delivery | retained |
| `speech-transcription.test.ts` | POST /v1/phone/transcriptions; SpeechTranscriber | retained |
| `startup.test.ts` | server startup containment | retained |
| `system-line.contract.test.ts` | the one system-line producer | retained |
| `system-line.producers.test.ts` | system-line producers | retained |
| `system-line.test.ts` | who an event line mentions; composeSystemLine; a caused line sorts after its cause; related cases | retained |
| `turn-silence-notice.test.ts` | first-silence notice; 90-second first silence from presence; silence detector ownership; related cases | retained |
| `wallet-venues.test.ts` | venue rules | retained |
| `wallet.integration.test.ts` | wallet over the fake CDP seam | retained |
| `wallet.live.test.ts` | opt-in live Arbitrum balance read against provider; skipped without credential | retained |
| `web-push.test.ts` | web push transport | retained |
| `welcome-retirement.test.ts` | Welcome Workspace retirement | retained |
| `workbench.integration.test.ts` | Workbench connector state, sign-in, status, and recovery over HTTP | retained |
| `workflow-admin.test.ts` | activeWorkflowRunIds | retained |
| `workflow-permissions.integration.test.ts` | workflow control through authenticated daemon HTTP operations; Reproduction run-id-prefix: authenticated run lookup and control | retained |
| `workflow-run-views.test.ts` | readWorkflowRun; visit output through daemon completion and phone GET; listRoomWorkflowRuns; related cases | retained |
| `workflow-runs.test.ts` | saved workflow validation, start/handoff/gate/timeout/run recovery, roles, and concurrency | consolidated assertions; retained coverage |
| `workflow-schedules.test.ts` | Reproduction workflow-timer-mutations-1; workflow prompt resolution; Reproduction schedules-11: keeps maxRuns:1 through skips and later starts exactly one run; related cases | retained |

## Integration case review

The 238 runtime cases in `integration.test.ts` were checked against the unit and focused integration files. They cover distinct authenticated HTTP entry points, authority boundaries, or persistence/fanout outcomes. The closest apparent repeat checks inheritance of Room-level subscriptions through two different corner creation paths: `createHumanCorner` (line 6499) and daemon `createCorner` (line 13471). Both remain because each path could regress independently.

| Source lines | Cases reviewed | Live boundary |
| --- | ---: | --- |
| 1–1799 | 22 declarations | Workspace, invite, membership, and reviewer settings |
| 1800–2999 | 18 declarations | Room messages, membership, push, and authenticated reads |
| 3000–4999 | 42 declarations | live replay, corner reading, transcript paging, and mention routing |
| 5000–6999 | 37 declarations | schedule HTTP, auth, media, human corners, and Corner Apps |
| 7000–9999 | 41 declarations | GitHub, corner merge/close, turn control, and owed state |
| 10000–11999 | 26 declarations | briefs, grants, agent ownership, and tool authority |
| 12000–12999 | 11 declarations | Workbench and Trusty Squire approvals |
| 13000–13999 | 17 declarations | system event subscriptions, wake routing, and Room choices |

## Removal bar and findings

- Deleted assertions are mapped to their surviving test and reason in the PR description. The consolidations keep every distinct assertion while avoiding repeated PGlite migration/setup.
- Tests named `Reproduction` were retained where they protect distinct actor, entry-point, ordering, or stale-state cases. Similar titles alone were not treated as duplicate coverage.
- Retired-feature tests were retained where they guard a live tombstone or migration. For example, `retireAgentClasses` still runs from `database.ts` migration, and the Welcome retirement tests prevent reintroducing deleted behavior.
- The five-minute real schedule wait was removed in the preceding cleanup PR. No remaining ordinary test contains a multi-minute wall-clock wait; timeout behavior generally uses fake clocks where timing is the behavior. `wallet.live.test.ts` is opt-in and skipped in ordinary CI.
