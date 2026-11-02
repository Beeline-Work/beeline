# Corner access reader and writer audit

Corners have no stored memberships. `room_access` is a read-only surface-access projection: its corner branch joins `rooms.parent_id` directly to the current physical Room membership and overlays sparse preferences. Implementer/reviewer roles remain in `corner_facts` and parent reviewer configuration. It excludes archived corners; explicit history reads use the parent key directly.

`CornerAccessDatabase` resolves generic membership reads through this projection; explicit parent-key and locking queries stay on physical Room memberships. The old `effective_memberships` view is only a read-only alias for the preceding image during deployment. No current reader uses that legacy name.

The inventory below includes every production query call site referencing physical membership or the access projection, including Workspace/DM-only readers. Function names identify the paths; named source and tests own query details. Schema SQL and constants are summarized separately below.

| Source | Read paths | Physical write paths |
| --- | --- | --- |
| [agent-class-retirement.ts](../apps/server/src/agent-class-retirement.ts) | `roomAgentsWithClass` | — |
| [agent-command.ts](../apps/server/src/agent-command.ts) | `createAgentCommand`, `reconcileConfiguredCornerReviewers`, `repairReviewerCornerMembership`, `routeHumanMessage`, `routeTaggedLifecycleCommand` | `reconcileConfiguredCornerReviewers` |
| [agent-health.ts](../apps/server/src/agent-health.ts) | `isConfiguredReviewer`, `isCornerReviewer`, `roomAgentHealth` | — |
| [agent-retirement.ts](../apps/server/src/agent-retirement.ts) | — | `retireAgentFromWorkspace` |
| [agent-schedules.ts](../apps/server/src/agent-schedules.ts) | `runOnce` | — |
| [agent-sign-in.ts](../apps/server/src/agent-sign-in.ts) | `completeAgentSignInCard` | — |
| [agent-subscriptions.ts](../apps/server/src/agent-subscriptions.ts) | `createAgentSubscriptionInDb`, `deleteAgentSubscription`, `fireRepositorySubscriptions`, `fireServiceSubscriptions`, `legacySubscriptions`, `listAgentSubscriptions`, `listRoomSubscriptions`, `listServiceSubscriptionEvents` | `deleteRoomSubscription` |
| [agent-voice.ts](../apps/server/src/agent-voice.ts) | `catalog`, `context`, `save` | — |
| [auth.ts](../apps/server/src/auth.ts) | `exchangeDaemonToken`, `migrateLegacyDaemon`, `retiredDaemonAgent` | — |
| [background.ts](../apps/server/src/background.ts) | `runUnthrottled` | — |
| [commander-wakes.ts](../apps/server/src/commander-wakes.ts) | `flushDueCommanderWakes`, `refreshOnce` | — |
| [commander.ts](../apps/server/src/commander.ts) | `commandAddress`, `reportToCommander`, `sendOrder`, `stopCommandedTurn` | — |
| [computer-session.ts](../apps/server/src/computer-session.ts) | `mayViewComputer` | — |
| [connection-presence.ts](../apps/server/src/connection-presence.ts) | `broadcastAgentPresence`, `failDelivery`, `observeOnce`, `recordAgentEvidence`, `writeAgentAnnouncement` | — |
| [corner-brief.ts](../apps/server/src/corner-brief.ts) | `humanRoomMember`, `laterBriefApproval`, `resolveCornerBriefApproval` | — |
| [corner-follow.ts](../apps/server/src/corner-follow.ts) | `backfillCornerFollows` | — |
| [corner-holds.ts](../apps/server/src/corner-holds.ts) | `setCornerHold` | — |
| [corner-lifecycle.ts](../apps/server/src/corner-lifecycle.ts) | `cornerMergeGate`, `loadCorner` | — |
| [corner-merge-approval.ts](../apps/server/src/corner-merge-approval.ts) | `isZeroCheckCommander`, `recordPersonMergeYes` | — |
| [corner-person-state.ts](../apps/server/src/corner-person-state.ts) | `migrateCornerPersonState` | `setRoomEventSubscriptions` |
| [corner-reviewer.ts](../apps/server/src/corner-reviewer.ts) | `setCornerReviewer` | — |
| [daemon-service.ts](../apps/server/src/daemon-service.ts) | `access`, `agentAvatar`, `authorizeScopedGrant`, `bootstrap`, `connectedAppForTool`, `connectorInstall`, `connectorVaultReport`, `corners`, `createCorner`, `deleteAgentSchedule`, `ensureMembership`, `execute`, `linkSpendApproval`, `listAgentSchedules`, `listEventSubscriptions`, `modelCatalog`, `postAddressAccess`, `postRoomEvent`, `reach`, `releaseReadiness`, `report`, `requestAgentGrant`, `reviewSourceAccess`, `reviseCornerBrief`, `roomAuthority`, `roomMembers`, `roomMessage`, `scheduleIndex`, `squireApproval`, `targetAuthority`, `updateAgentSchedule`, `watchCorner`, `workspaceRoster` | `agentAvatar`, `ensureMembership` |
| [database.ts](../apps/server/src/database.ts) | `backfillAgentHandles` | — |
| [deadline-expiry.ts](../apps/server/src/deadline-expiry.ts) | `runOnce` | — |
| [feedback.ts](../apps/server/src/feedback.ts) | `reportMessageIssue`, `sendFixedMessage` | — |
| [first-room.ts](../apps/server/src/first-room.ts) | `firstAccessibleRoomId` | — |
| [free-agent-model-proxy.ts](../apps/server/src/free-agent-model-proxy.ts) | `completeStarterBanter` | — |
| [free-agent-warning.ts](../apps/server/src/free-agent-warning.ts) | `warnFreeAgentOwner` | — |
| [free-agents.ts](../apps/server/src/free-agents.ts) | `addFreeAgentToWorkspace`, `createFreeAgentInWorkspace`, `wakeFreeAgentsForLeaves` | `createFreeAgentInWorkspace`, `createInWorkspace` |
| [github-operations.ts](../apps/server/src/github-operations.ts) | `processCornerEvent`, `processRepositoryEvent`, `readPrChecksStatus` | — |
| [github-star-prompt.ts](../apps/server/src/github-star-prompt.ts) | `readStarPrompt` | — |
| [invite-preview.ts](../apps/server/src/invite-preview.ts) | `resolve` | — |
| [luna-backfill.ts](../apps/server/src/luna-backfill.ts) | — | `backfillLuna` |
| [membership-join.ts](../apps/server/src/membership-join.ts) | `joinRooms`, `subscriberRooms` | `joinRooms`, `joinWorkspaceMembersToPublicRoom`, `syncTopLevelSharedRoomRoles` |
| [message-mentions.ts](../apps/server/src/message-mentions.ts) | `resolveChannelMentionMembers`, `resolveCurrentMemberMentions` | — |
| [migrations/corner-memberships.ts](../apps/server/src/migrations/corner-memberships.ts) | — | `removeCornerMemberships` |
| [next-day-checkin.ts](../apps/server/src/next-day-checkin.ts) | `runOnce`, `target` | — |
| [operator-dashboard.ts](../apps/server/src/operator-dashboard.ts) | `dashboardUsage` | — |
| [operator-system-dm.ts](../apps/server/src/operator-system-dm.ts) | `sendOperatorSystemDm` | — |
| [phone-service.ts](../apps/server/src/phone-service.ts) | `acceptConnectorOffer`, `addRoomMember`, `addWorkspaceMember`, `answerChoice`, `authorize`, `availableAgentHandle`, `canReadRooms`, `cancelAgentTurn`, `claimAgentConnectPairing`, `claimAgentPairing`, `clearNeedsYou`, `closeChat`, `cornerRoomEnrichment`, `createHumanCorner`, `createWorkspace`, `decidePermission`, `deleteAccount`, `deleteRoomMessage`, `deleteWorkspace`, `execute`, `flushPendingMentionNotices`, `hasRoomAccess`, `leaveRoom`, `leaveWorkspace`, `listMessageBookmarks`, `liveNeedsYou`, `livePersonChange`, `liveWorkspaceChange`, `loadCorners`, `lockPairingIssuer`, `markRead`, `markUnread`, `members`, `noteUnansweredMentions`, `reactToMessage`, `readAgent`, `readChats`, `readHistory`, `readHistoryAfter`, `readHistoryAround`, `readHistoryOutline`, `readInvite`, `readLiveBookmark`, `readLiveDeltas`, `readScheduledWork`, `readWorkbench`, `readWorkspaceMembers`, `readWorkspaces`, `redeemInvite`, `refreshAgentModelCatalog`, `removeRoomMember`, `removeWorkspaceMember`, `renameCorner`, `requireGrantAuthority`, `requireHumanRoomWorkspaceManager`, `requireRoomWorkspaceManager`, `requireTopLevelChatMember`, `requireWorkspaceAgent`, `requireWorkspaceAgentRemover`, `requireWorkspaceManager`, `requireWorkspaceMember`, `requireWorkspaceOwner`, `resolveDirectMessage`, `resolveMessageLink`, `resolveViewerHelper`, `roomRows`, `searchMessages`, `sendMessage`, `setMessageBookmark`, `unansweredMentionTargets`, `updateAgentAccessPolicy`, `updateAgentModel`, `updateAgentYolo`, `updateRoom`, `viewerWorkbenchWorkspace`, `workspaceRoster`, `wornSeededIdentity` | `addWorkspaceMember`, `claimAgentConnectPairing`, `claimAgentPairing`, `createRoom`, `createWorkspace`, `deleteAccount`, `finishAgentConnectPairing`, `leaveRoom`, `leaveWorkspace`, `redeemInvite`, `removeRoomMember`, `removeWorkspaceMember`, `resolveDirectMessage`, `rollbackUnrealizedAgent`, `updateRoom`, `updateRoomPushState` |
| [phone-viewing.ts](../apps/server/src/phone-viewing.ts) | `setView` | — |
| [postgres-live.ts](../apps/server/src/postgres-live.ts) | `notifyAgentConfigChange`, `rebroadcast` | — |
| [production-release-dispatch.ts](../apps/server/src/production-release-dispatch.ts) | `productionReleaseDispatch` | — |
| [provider-webhooks.ts](../apps/server/src/provider-webhooks.ts) | `connectedProviderApp`, `ingestProviderWebhook` | — |
| [repository-onboarding.ts](../apps/server/src/repository-onboarding.ts) | `postRepositoryOnboarding` | — |
| [review-proof-fixture.ts](../apps/server/src/review-proof-fixture.ts) | — | `ensureReviewProofFixture`, `ensureReviewWorkspace` |
| [room-choice.ts](../apps/server/src/room-choice.ts) | `answerRoomChoice`, `loadHumanElectorate`, `loadMentionIds`, `skipRoomChoice` | — |
| [rooms-mcp-agent.ts](../apps/server/src/rooms-mcp-agent.ts) | `pendingMcpWakes`, `place`, `read` | — |
| [rooms-mcp-events.ts](../apps/server/src/rooms-mcp-events.ts) | `deliverMcpEvents` | — |
| [rooms-mcp-members.ts](../apps/server/src/rooms-mcp-members.ts) | `backfillMcpMemberRoomsAndAvatars`, `deliverMcpMemberWebhooks`, `ensureMcpMember`, `setMcpMemberProfile` | `ensureMcpMember`, `retireMcpMember` |
| [rooms-mcp-oauth.ts](../apps/server/src/rooms-mcp-oauth.ts) | `handle` | — |
| [server.ts](../apps/server/src/server.ts) | `processMessage` | — |
| [signin-funnel.ts](../apps/server/src/signin-funnel.ts) | `observeOnboardingMessage`, `recordSigninFunnelEvent` | — |
| [squire-machine.ts](../apps/server/src/squire-machine.ts) | `queueOwnerSquireWork` | — |
| [starter-invite.ts](../apps/server/src/starter-invite.ts) | `createStarterInvite`, `postStarterInviteOffer` | — |
| [starter-onboarding-run.ts](../apps/server/src/starter-onboarding-run.ts) | `queueRerun` | — |
| [starter-onboarding.ts](../apps/server/src/starter-onboarding.ts) | `buildStarterGame` | — |
| [startup-wake-backoff.ts](../apps/server/src/startup-wake-backoff.ts) | `recordStartupWakeOutcome` | — |
| [subscription-webhooks.ts](../apps/server/src/subscription-webhooks.ts) | `ingestSubscriptionWebhook`, `requireScheduledWorkManager` | — |
| [system-line.ts](../apps/server/src/system-line.ts) | `sendSystemDirectMessage`, `subscribers`, `systemLine`, `write` | `ensureSystemDirectMessageRoomResult` |
| [vault-save-http.ts](../apps/server/src/vault-save-http.ts) | `vaultSaveHttp` | — |
| [voice-service.ts](../apps/server/src/voice-service.ts) | `access`, `agents`, `memberNames`, `recordAnswer` | — |
| [wallet-webhooks.ts](../apps/server/src/wallet-webhooks.ts) | `ingestWalletWebhook` | — |
| [wallet.ts](../apps/server/src/wallet.ts) | `walletAgentContext` | — |
| [welcome-retirement.ts](../apps/server/src/welcome-retirement.ts) | `retireWelcomeWorkspace`, `welcomeRetirementPreflight` | — |
| [welcome-video-workflow.ts](../apps/server/src/welcome-video-workflow.ts) | `backfillWelcomeVideoWorkflow` | — |
| [workbench.ts](../apps/server/src/workbench.ts) | `grantSquireToOwnerMachineAgents`, `postUsageReceiptCard` | — |
| [workflow-admin.ts](../apps/server/src/workflow-admin.ts) | `activeWorkflowRunIds`, `humanRoomAdmin`, `humanRoomMember` | — |
| [workflow-runs.ts](../apps/server/src/workflow-runs.ts) | `assignWorkflowRole`, `roomMemberIdForHandle`, `runNoticeRecipients`, `saveWorkflow`, `startWorkflow` | — |
| [workspace-handles.ts](../apps/server/src/workspace-handles.ts) | `lockIdentityHandleWorkspaces`, `reassignCollidingAgentHandles` | — |

Physical writers create Workspace, DM or top-level Room memberships only. `joinRooms`, public-Room projection, Room creation/member addition, pairing, MCP members, free agents, System DMs and review fixtures all remain scoped to those surfaces. Corner creation, reviewer assignment and `ensureAgentMembership` inherit parent access without writing a roster. `sendMessage`, `deleteRoomMessage` and `VoiceService.recordAnswer` now use parent membership predicates and lock that physical membership in the message statement; the lazy compatibility writer is deleted.

`migrations/corner-memberships.ts` is the sole historical corner-roster writer: it deletes all legacy corner rows in batches of 250 after sparse preference copying. Its database trigger rejects every new corner INSERT or room-id reassignment. `corner-person-state.ts` removes both preference synchronization triggers; explicit corner preferences write only `corner_person_state`. No archival path needs membership cleanup because there are no corner membership rows to end.

Schema-owned readers (`corner-follow`, `corner-owed`, `push-outbox`, `postgres-live`) use `room_access`; `CornerAccessStatement` resolves the reusable mention projection the same way. Workspace membership bans, retirement and account deletion operate on stored Workspace/Room memberships. The static legacy push SQL fixture deliberately retains its historical query for before/after comparison.
