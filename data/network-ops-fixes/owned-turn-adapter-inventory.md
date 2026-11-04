# Owned-turn adapter inventory

Recorded from `DAEMON_OPERATION_NAMES` in `apps/server/src/daemon-service.ts` and `usesOwnedTurnAdapter` in `apps/server/src/turn-ownership.ts`. The one-off inventory tool is omitted from the shipped tree.

**177 operations: 19 completed owned adapters, 157 retained compatibility handlers, one existing activation-only socket operation.**

Instruction 065 preserves existing functionality. Compatibility handlers remain available to an owned turn through their existing transport and provider leaf. They retain existing permissions, command generation, cancellation and commit fences; there is no “unsupported owned adapter” rejection. GitHub preflight for these handlers follows the existing path. This does not claim a new durable UNKNOWN adapter for every provider effect.

The activation-only operation had no legacy HTTP implementation and keeps its negotiated socket contract. Usage/account operations retain their existing negotiated usage adapter. Authentication, authorization and retired-feature refusals remain in their existing handlers.

This is a complete routing inventory, not a claim that every external provider was contacted or every operation executed in validation. The connected-app parity test exercises both legacy and owned command bindings through the same sign-in, discovery, execution and accounting assertions; it also verifies no second provider dispatch after owner loss. Other validation is recorded in [activation CI fixes](activation-ci-fixes.md).

| Operation | Outcome with an owned turn |
| --- | --- |
| `acknowledgeAgentCommand` | Owned adapter |
| `answerUsageRefresh` | Existing compatibility handler |
| `approveCornerMerge` | Existing compatibility handler |
| `archiveCorner` | Existing compatibility handler |
| `archiveWorkflow` | Existing compatibility handler |
| `askRoomChoice` | Existing compatibility handler |
| `assignWorkflowRole` | Existing compatibility handler |
| `attachAgentUsageAccount` | Existing compatibility handler |
| `authorizeHostCall` | Existing compatibility handler |
| `authorizeRepositoryCall` | Existing compatibility handler |
| `authorizeResourceCall` | Existing compatibility handler |
| `authorizeSquireCall` | Existing compatibility handler |
| `beginRegistryMcpOAuth` | Existing compatibility handler |
| `cancelWorkflowRun` | Existing compatibility handler |
| `claimAgentCommand` | Owned adapter |
| `claimRegistryMcpOAuthCode` | Existing compatibility handler |
| `closeCornerPullRequest` | Existing compatibility handler |
| `completeProviderWebhookAssignment` | Existing compatibility handler |
| `connect` | Existing compatibility handler |
| `connectApp` | Existing compatibility handler |
| `connectMcpServer` | Existing compatibility handler |
| `consumeAgentGrant` | Existing compatibility handler |
| `createAgentSchedule` | Existing compatibility handler |
| `createAgentSubscription` | Existing compatibility handler |
| `createCorner` | Existing compatibility handler |
| `createLinkSpendRequest` | Existing compatibility handler |
| `deleteAgentSchedule` | Existing compatibility handler |
| `deleteAgentSubscription` | Existing compatibility handler |
| `deleteInstitutionalMemory` | Existing compatibility handler |
| `deleteSkill` | Existing compatibility handler |
| `dispatchRoomWorkflow` | Existing compatibility handler |
| `endComputerSession` | Existing compatibility handler |
| `ensureAgentMembership` | Existing compatibility handler |
| `executeAppTool` | Existing compatibility handler |
| `findConnectors` | Existing compatibility handler |
| `forgetSquireSignIn` | Existing compatibility handler |
| `getAgentAvatar` | Existing compatibility handler |
| `getAgentCommands` | Owned adapter |
| `getAgentConfiguration` | Existing compatibility handler |
| `getAgentPresence` | Existing compatibility handler |
| `getAgentToolMandate` | Existing compatibility handler |
| `getAgentUsage` | Existing compatibility handler |
| `getConnectionDetail` | Existing compatibility handler |
| `getConnectorAssignments` | Existing compatibility handler |
| `getConnectorStatus` | Existing compatibility handler |
| `getConnectorVaultList` | Existing compatibility handler |
| `getCornerCloseRequests` | Existing compatibility handler |
| `getCornerRestoreState` | Existing compatibility handler |
| `getDaemonBootstrap` | Existing compatibility handler |
| `getGoogleOAuthGrant` | Existing compatibility handler |
| `getIdentitySuccession` | Existing compatibility handler |
| `getInstitutionalContext` | Owned adapter |
| `getInstitutionalMemoryTurnStats` | Owned adapter |
| `getMissionAuthority` | Existing compatibility handler |
| `getOwedMentions` | Existing compatibility handler |
| `getPermissionAuthority` | Existing compatibility handler |
| `getPrChecksStatus` | Existing compatibility handler |
| `getRequestCompletion` | Existing compatibility handler |
| `getRoomAuthority` | Owned adapter |
| `getRoomConversation` | Owned adapter |
| `getRoomGitHubToken` | Existing compatibility handler |
| `getRoomGoogleGrant` | Existing compatibility handler |
| `getRoomInbox` | Existing compatibility handler |
| `getRoomMessage` | Owned adapter |
| `getRoomRepositoryState` | Existing compatibility handler |
| `getRoomTargetBranch` | Existing compatibility handler |
| `getTargetAgentAuthority` | Existing compatibility handler |
| `getWakeDelivery` | Existing compatibility handler |
| `getWalletToolBalance` | Existing compatibility handler |
| `getWalletToolChains` | Existing compatibility handler |
| `getWalletToolHistory` | Existing compatibility handler |
| `getWalletToolQuote` | Existing compatibility handler |
| `getWalletToolState` | Existing compatibility handler |
| `getWorkScheduleAuthority` | Existing compatibility handler |
| `getWorkflowRun` | Existing compatibility handler |
| `getWorkspaceRoster` | Existing compatibility handler |
| `handoff` | Existing compatibility handler |
| `installConnector` | Existing compatibility handler |
| `listAgentGrantRequests` | Existing compatibility handler |
| `listAgentGrants` | Existing compatibility handler |
| `listAgentSchedules` | Existing compatibility handler |
| `listAgentSubscriptions` | Existing compatibility handler |
| `listAgentToolSchedules` | Existing compatibility handler |
| `listAgentWatches` | Existing compatibility handler |
| `listAppTools` | Existing compatibility handler |
| `listCornerBriefRevisions` | Existing compatibility handler |
| `listEventSubscriptions` | Existing compatibility handler |
| `listReachableCorners` | Existing compatibility handler |
| `listRoomCorners` | Owned adapter |
| `listRoomMembers` | Existing compatibility handler |
| `listRooms` | Existing compatibility handler |
| `listServiceSubscriptionEvents` | Existing compatibility handler |
| `listTurnAgentGrants` | Existing compatibility handler |
| `listUntrackedCorners` | Existing compatibility handler |
| `listWorkSchedules` | Existing compatibility handler |
| `loadWorkspaceSkill` | Existing compatibility handler |
| `markAgentTurnSilent` | Owned adapter |
| `mergeCorner` | Existing compatibility handler |
| `noteEmptyRoomRepository` | Existing compatibility handler |
| `notifyFeedbackFixed` | Existing compatibility handler |
| `offerConnector` | Existing compatibility handler |
| `openRoomPoll` | Existing compatibility handler |
| `order` | Existing compatibility handler |
| `orderCornerMerge` | Existing compatibility handler |
| `postAgentActivity` | Owned adapter |
| `postAgentAttachment` | Existing compatibility handler |
| `postAgentAvatar` | Existing compatibility handler |
| `postAgentCommands` | Existing compatibility handler |
| `postAgentDraft` | Owned adapter |
| `postAgentMachineReport` | Existing compatibility handler |
| `postAgentModelCatalog` | Existing compatibility handler |
| `postAgentThought` | Owned adapter |
| `postAgentToolMandate` | Existing compatibility handler |
| `postAgentToolScheduleIndex` | Existing compatibility handler |
| `postAgentTurnReceipt` | Owned adapter |
| `postAgentUsage` | Existing usage adapter; binds legacy collector arguments to the negotiated actor source |
| `postBackgroundToolCompletion` | Owned adapter |
| `postComputerSession` | Existing compatibility handler |
| `postConnectionUsage` | Existing compatibility handler |
| `postConnectorStatus` | Existing compatibility handler |
| `postConnectorVault` | Existing compatibility handler |
| `postCornerMessage` | Owned adapter |
| `postCornerPlan` | Existing compatibility handler |
| `postCornerRemoteState` | Existing compatibility handler |
| `postPermissionExecution` | Existing compatibility handler |
| `postPermissionRequest` | Existing compatibility handler |
| `postRepositoryOnboarding` | Existing compatibility handler |
| `postRoomEvent` | Owned adapter |
| `postRoomInvite` | Existing compatibility handler |
| `postRoomMessage` | Owned adapter |
| `postSquireApproval` | Existing compatibility handler |
| `postSquireApprovalDecision` | Existing compatibility handler |
| `postSquireLoginWall` | Existing compatibility handler |
| `postStarterVideoPreview` | Existing compatibility handler |
| `postStarterWelcome` | Existing compatibility handler |
| `postTargetBranchProposal` | Existing compatibility handler |
| `postVaultSaveCard` | Existing compatibility handler |
| `postWorkSchedule` | Existing compatibility handler |
| `postWorkScheduleReceipt` | Existing compatibility handler |
| `publishAgentUsageAccount` | Existing compatibility handler |
| `reactToRoomMessage` | Existing compatibility handler |
| `read` | Existing compatibility handler |
| `readAgentWorkbench` | Existing compatibility handler |
| `readCommandActivation` | Activation socket (unchanged) |
| `readCornerPullRequest` | Existing compatibility handler |
| `readOperatorSystemDm` | Existing compatibility handler |
| `refreshComputerSession` | Existing compatibility handler |
| `renameCorner` | Existing compatibility handler |
| `report` | Existing compatibility handler |
| `reportAgentSignIn` | Existing compatibility handler |
| `reportFeedback` | Existing compatibility handler |
| `reportInstitutionalMemoryUsed` | Existing compatibility handler |
| `requestAgentGrant` | Existing compatibility handler |
| `retractAgentLiveOutput` | Owned adapter |
| `retrieveLinkSpendRequest` | Existing compatibility handler |
| `reviseCornerBrief` | Existing compatibility handler |
| `revokeConnectionGrants` | Existing compatibility handler |
| `saveInstitutionalMemory` | Existing compatibility handler |
| `saveSkill` | Existing compatibility handler |
| `saveWorkflow` | Existing compatibility handler |
| `searchInstitutionalHistory` | Existing compatibility handler |
| `searchInstitutionalMemory` | Existing compatibility handler |
| `searchMcpRegistry` | Existing compatibility handler |
| `sendOperatorSystemDm` | Existing compatibility handler |
| `setCornerHold` | Existing compatibility handler |
| `setEventSubscriptions` | Existing compatibility handler |
| `setWakeDelivery` | Existing compatibility handler |
| `startWorkflow` | Existing compatibility handler |
| `stopAgentTurn` | Existing compatibility handler |
| `updateAgentSchedule` | Existing compatibility handler |
| `updateInstitutionalMemory` | Existing compatibility handler |
| `waitForCornerWake` | Existing compatibility handler |
| `walletContractCall` | Existing compatibility handler |
| `walletPay` | Existing compatibility handler |
| `walletSignTypedData` | Existing compatibility handler |
| `walletSwap` | Existing compatibility handler |
| `watchCorner` | Existing compatibility handler |
