import type { HelperTurnOwnershipSource } from '@beeline/api-contract/helper-turn-ownership';
import { OwnedModelCredentials } from './owned-model-credential.js';
import type { CommandActivationInput } from '@beeline/api-contract/helper-activation';
import type { StarterOnboardingService } from './starter-onboarding-run.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { type CommandRow } from './agent-command.js';
import type { DaemonAttachment, DaemonOperationMap } from '@beeline/api-contract/daemon';
import { type SqlDatabase } from './database.js';
import type { GitHubOperations, LandCornerOutcome } from './github-operations.js';
import { LiveHub } from './live.js';
import { postRoomChoice } from './room-choice.js';
import { McpRegistryClient, DEFAULT_MCP_REGISTRY_CLIENT } from './mcp-registry.js';
import type { RegistryMcpOAuth } from './registry-mcp-oauth.js';
import type { ComposioApps } from './composio-apps.js';
import type { ObjectService } from './object-service.js';
import { type InstitutionalMemoryShadowConfig } from './institutional-memory-shadow.js';
import { feedbackConfigFromEnv, type FeedbackLoop } from './feedback.js';
import type { AfterCommit, EmbedFn } from './institutional-memory-embeddings.js';
import { OwnedModelConfiguration, OwnedModelNegotiation, OwnedModelClaimCapability, DEFAULT_MEDIA_MAXIMUM_BYTES, Input, Output, id } from './daemon/values.js';
import { daemonSetOwnedModel, daemonOwnedModelReady, daemonNegotiateOwnedModel, daemonModelClaimCredentials, daemonSetStarterOnboarding, daemonLockOwnedTurnAccess, daemonFenceOwnedTurnReply, daemonReadCommandActivation } from './daemon/owned-model.js';
import { daemonExecute } from './daemon/execute.js';
import { daemonReconcileZeroCheckWorkerCompletion } from './daemon/corner-completion.js';
import { daemonConnectorAssignments, daemonConnectorInstall, daemonConnectorStatusReport, daemonResumeRegistrySignIn, daemonNotifyTailscaleSignIn, daemonConnectorVaultReport, daemonConnectorStatusView, daemonConnectorVaultList, daemonConnectionDetail, daemonConnectionGrantRevoke, daemonConnectionUsage } from './daemon/connectors.js';
import { daemonBootstrap, daemonWorkspaceRoster, daemonInbox } from './daemon/inbox-roster.js';
import { daemonRoomMessage, daemonRoomAttachment, daemonWithStoredDigests, daemonExpiredMediaIds } from './daemon/message-reads.js';
import { daemonRoomAuthority, daemonPermissionAuthority, daemonMissionAuthority, daemonScheduleAuthority, daemonMandate, daemonTargetAuthority } from './daemon/authority.js';
import { daemonCorners, daemonCornerRestore, daemonListCornerBriefRevisions, daemonMergeCorner, daemonCloseCornerPullRequest, daemonCheckReviewerAuthors, daemonApproveCornerMerge, daemonRepository, daemonTargetBranch } from './daemon/corner-reads.js';
import { daemonIdentitySuccession, daemonConfiguration, daemonPresence, daemonReleaseReadiness } from './daemon/configuration.js';
import { daemonCompletion, daemonPostRoomMessage, daemonPostAgentAttachment, daemonLiveOutput, daemonRetract, daemonPersistTurnTrace } from './daemon/messages.js';
import { daemonTurnReceipt, daemonActivity } from './daemon/turn-receipts.js';
import { daemonApprovalSource, daemonLinkSpendApproval, daemonSquireApproval, daemonSquireApprovalDecision, daemonSquireLoginWall, daemonPermissionRequest, daemonPermissionExecution } from './daemon/approvals.js';
import { daemonCreateAgentSchedule, daemonRecordScheduleAuthorization, daemonSetEventSubscriptions, daemonListEventSubscriptions, daemonPostRoomEvent, daemonListAgentSchedules, daemonRequireScheduleAdmin, daemonDeleteAgentSchedule, daemonUpdateAgentSchedule } from './daemon/schedules-events.js';
import { daemonPostMandate, daemonAgentAvatar, daemonCommands, daemonModelCatalog, daemonMachineReport } from './daemon/models.js';
import { daemonReport, daemonWatchCorner, daemonCornerRemote, daemonCornerPlan, daemonBriefAttachmentRooms, daemonRenameCorner, daemonTargetProposal } from './daemon/corner-reports.js';
import { daemonRequestAgentGrant, daemonAskRoomChoice, daemonOpenRoomPoll, daemonWriteRoomChoice, daemonListAgentGrants, daemonConsumeAgentGrant, daemonListAgentGrantRequests, daemonRepositoryOnboardingRequester, daemonGrantRequester, daemonFindGrantRequester, daemonAuthorizeSquireCall, daemonAuthorizeScopedGrant } from './daemon/grants.js';
import { daemonAppCardMark, daemonOfferContext, daemonAgentWorkbench, daemonSearchMcpRegistry, daemonWarmConnectorIndex } from './daemon/workbench.js';
import { daemonConnectService, daemonConnectAppFrontDoor, daemonConnectedAppForTool, daemonListAppTools, daemonExecuteAppTool } from './daemon/apps.js';
import { daemonAuthorizeResource, daemonConnectMcpServer, daemonOfferConnector } from './daemon/connector-offers.js';
import { daemonCreateCorner, daemonReviseCornerBrief, daemonArchiveCorner, daemonEnsureMembership } from './daemon/corner-writes.js';
import { daemonIdentity, daemonReviewSourceAccess, daemonAccess, daemonRoomMembers } from './daemon/access.js';
import { daemonPostCornerMessage, daemonPostAddressAccess, daemonReach, daemonReactToRoomMessage, daemonWriteResult } from './daemon/corner-messages.js';

export type { OwnedModelClaimCapability } from './daemon/values.js';
export type { OwnedModelNegotiation } from './daemon/values.js';
export { DAEMON_OPERATION_NAMES } from './daemon/operation-names.js';

export class DaemonService {

   ownedModel?: OwnedModelConfiguration;

   readonly modelClaims = new WeakMap<object, { agentId: string; source: HelperTurnOwnershipSource; configuration: OwnedModelConfiguration }>();
  setOwnedModel(configuration: OwnedModelConfiguration | undefined): void { return daemonSetOwnedModel(this, configuration); }
  ownedModelReady(): boolean { return daemonOwnedModelReady(this); }
  async negotiateOwnedModel(agentId: string, source: HelperTurnOwnershipSource, installed: boolean): Promise<OwnedModelNegotiation> { return daemonNegotiateOwnedModel(this, agentId, source, installed); }
  modelClaimCredentials(capability: OwnedModelClaimCapability | undefined, agentId: string, source: HelperTurnOwnershipSource): OwnedModelCredentials { return daemonModelClaimCredentials(this, capability, agentId, source); }

   starterOnboarding?: StarterOnboardingService;
  setStarterOnboarding(service: StarterOnboardingService): void { return daemonSetStarterOnboarding(this, service); }
  async lockOwnedTurnAccess(database: SqlDatabase, roomId: string, agentId: string, controlId?: string): Promise<void> { return daemonLockOwnedTurnAccess(this, database, roomId, agentId, controlId); }
  async fenceOwnedTurnReply(agentId: string, source: HelperTurnOwnershipSource, input: {
    roomId: string;
    generationId?: string;
    commandId?: string;
    requestId?: string;
}, enqueue: () => void, requireClaimed = false): Promise<void> { return daemonFenceOwnedTurnReply(this, agentId, source, input, enqueue, requireClaimed); }
  async readCommandActivation(input: CommandActivationInput, authenticatedAgentId: string) { return daemonReadCommandActivation(this, input, authenticatedAgentId); }


  constructor(
     readonly database: SqlDatabase,
     readonly live: LiveHub,
     readonly roomGitHubToken?: (
      roomId: string,
    ) => Promise<{ token: string; expiresAt: number }>,
     readonly mediaMaximumBytes: number = DEFAULT_MEDIA_MAXIMUM_BYTES,
     readonly commandTransaction = false,
     readonly authorizedCommand?: CommandRow,
     readonly livePaintDiagnostics = false,
     readonly liveDiagnosticServerInstance?: string,
     readonly prChecksStatus?: (
      input: Input<'getPrChecksStatus'>,
      confirmZeroChecks?: boolean,
    ) => Promise<Output<'getPrChecksStatus'> & { zeroChecksConfirmed?: boolean }>,
    _legacyProviderSlot?: unknown,
     readonly institutionalMemoryShadow: InstitutionalMemoryShadowConfig = {
      enabled: false,
    },
     readonly mcpRegistry: McpRegistryClient = DEFAULT_MCP_REGISTRY_CLIENT,
     readonly registryMcpOAuth?: RegistryMcpOAuth,
     readonly composio?: ComposioApps,
     readonly feedback: FeedbackLoop = { config: feedbackConfigFromEnv() },
     readonly objects?: ObjectService,
     readonly linkWallet?: import('./link-agent-wallet.js').LinkAgentWallet,
     readonly refreshMergeability?: (cornerId: string) => Promise<void>,
    /** The merge attempt behind `merge_corner` and `order_corner_merge`. */
     readonly landCorner?: (cornerId: string, onBlocked?: (reason: string) => void) => Promise<LandCornerOutcome>,
    /** The GitHub close behind `close_pull_request`. */
     readonly closePullRequest?: (
      cornerId: string,
    ) => Promise<
      | { status: 'closed'; number: number; url: string; title: string }
      | { status: 'blocked'; blocker: string }
    >,
    /** The GitHub read behind `read_pull_request`. */
     readonly readPullRequest?: (
      cornerId: string,
    ) => Promise<Output<'readCornerPullRequest'>>,
     readonly subscriptionReceiverUrl?: string,
     readonly github?: GitHubOperations,
  ) {
    this.database = new CornerAccessDatabase(database);}


  /** A turn's memory query, embedded before its command transaction opened. */
   memoryEmbed: EmbedFn | undefined;

  /** Collects network work that must wait for the command transaction to commit. */
   afterCommit: AfterCommit | undefined;
  async execute<Name extends keyof DaemonOperationMap>(name: Name, input: Input<Name>, authenticatedAgentId: string, turnOwner?: HelperTurnOwnershipSource, modelClaim?: OwnedModelClaimCapability): Promise<Output<Name>> { return daemonExecute<Name>(this, name, input, authenticatedAgentId, turnOwner, modelClaim); }
  async reconcileZeroCheckWorkerCompletion(cornerId: string, workerAgentId: string): Promise<void> { return daemonReconcileZeroCheckWorkerCompletion(this, cornerId, workerAgentId); }
  async connectorAssignments(agentId: string): Promise<Output<'getConnectorAssignments'>> { return daemonConnectorAssignments(this, agentId); }
  async connectorInstall(input: Input<'installConnector'>, agentId: string): Promise<Output<'installConnector'>> { return daemonConnectorInstall(this, input, agentId); }
  async connectorStatusReport(input: Input<'postConnectorStatus'>, agentId: string): Promise<Output<'postConnectorStatus'>> { return daemonConnectorStatusReport(this, input, agentId); }
  async resumeRegistrySignIn(row: {
    id: string;
    registry_server_name: string | null;
}, signIn: NonNullable<Input<'postConnectorStatus'>['signIn']>): Promise<void> { return daemonResumeRegistrySignIn(this, row, signIn); }
  async notifyTailscaleSignIn(connectorId: string, url: string, agentId: string): Promise<void> { return daemonNotifyTailscaleSignIn(this, connectorId, url, agentId); }
  async connectorVaultReport(input: Input<'postConnectorVault'>, agentId: string): Promise<Output<'postConnectorVault'>> { return daemonConnectorVaultReport(this, input, agentId); }
  async connectorStatusView(agentId: string, connectorId?: string): Promise<Output<'getConnectorStatus'>> { return daemonConnectorStatusView(this, agentId, connectorId); }
  async connectorVaultList(agentId: string): Promise<Output<'getConnectorVaultList'>> { return daemonConnectorVaultList(this, agentId); }
  async connectionDetail(input: Input<'getConnectionDetail'>, agentId: string): Promise<Output<'getConnectionDetail'>> { return daemonConnectionDetail(this, input, agentId); }
  async connectionGrantRevoke(input: Input<'revokeConnectionGrants'>, agentId: string): Promise<Output<'revokeConnectionGrants'>> { return daemonConnectionGrantRevoke(this, input, agentId); }
  async connectionUsage(input: Input<'postConnectionUsage'>, agentId: string): Promise<Output<'postConnectionUsage'>> { return daemonConnectionUsage(this, input, agentId); }
  async bootstrap(agentId: string) { return daemonBootstrap(this, agentId); }
  async workspaceRoster(input: Input<'getWorkspaceRoster'>, agentId: string) { return daemonWorkspaceRoster(this, input, agentId); }
  async inbox(name: string, input: Input<'getRoomConversation'>, agentId: string) { return daemonInbox(this, name, input, agentId); }
  async roomMessage(input: Input<'getRoomMessage'>, agentId: string): Promise<{
    messageId: string;
    body: string;
    attachments: DaemonAttachment[];
    nextOffset?: number;
}> { return daemonRoomMessage(this, input, agentId); }
  async roomAttachment(input: Input<'getRoomMessage'>, agentId: string): Promise<{
    messageId: string;
    body: string;
    attachments: DaemonAttachment[];
}> { return daemonRoomAttachment(this, input, agentId); }
  async withStoredDigests(attachments: readonly DaemonAttachment[]): Promise<DaemonAttachment[]> { return daemonWithStoredDigests(this, attachments); }
  async expiredMediaIds(attachments: readonly DaemonAttachment[]): Promise<ReadonlySet<string>> { return daemonExpiredMediaIds(this, attachments); }
  async roomAuthority(input: Input<'getRoomAuthority'>, agentId: string) { return daemonRoomAuthority(this, input, agentId); }
  async permissionAuthority(input: Input<'getPermissionAuthority'>) { return daemonPermissionAuthority(this, input); }
  async missionAuthority() { return daemonMissionAuthority(this); }
  async scheduleAuthority(input: Input<'getWorkScheduleAuthority'>, agentId: string) { return daemonScheduleAuthority(this, input, agentId); }
  async mandate(input: Input<'getAgentToolMandate'>, agentId: string) { return daemonMandate(this, input, agentId); }
  async targetAuthority(input: Input<'getTargetAgentAuthority'>, agentId: string) { return daemonTargetAuthority(this, input, agentId); }
  async corners(roomId: string, agentId: string, activeOnly = false, reachable = false) { return daemonCorners(this, roomId, agentId, activeOnly, reachable); }
  async cornerRestore(cornerId: string, agentId: string) { return daemonCornerRestore(this, cornerId, agentId); }
  async listCornerBriefRevisions(input: Input<'listCornerBriefRevisions'>, agentId: string) { return daemonListCornerBriefRevisions(this, input, agentId); }
  async mergeCorner(input: Input<'mergeCorner'>, agentId: string): Promise<Output<'mergeCorner'>> { return daemonMergeCorner(this, input, agentId); }
  async closeCornerPullRequest(input: Input<'closeCornerPullRequest'>, agentId: string): Promise<Output<'closeCornerPullRequest'>> { return daemonCloseCornerPullRequest(this, input, agentId); }
  async checkReviewerAuthors(db: SqlDatabase, cornerId: string, agentId: string) { return daemonCheckReviewerAuthors(this, db, cornerId, agentId); }
  async approveCornerMerge(input: Input<'approveCornerMerge'>, agentId: string) { return daemonApproveCornerMerge(this, input, agentId); }
  async repository(roomId: string, agentId: string) { return daemonRepository(this, roomId, agentId); }
  async targetBranch(roomId: string, agentId: string) { return daemonTargetBranch(this, roomId, agentId); }
  async identitySuccession(identityId: string) { return daemonIdentitySuccession(this, identityId); }
  async configuration(agentId: string, roomId?: string, context?: Record<string, unknown>) { return daemonConfiguration(this, agentId, roomId, context); }
  async presence(input: Input<'getAgentPresence'>, agentId: string) { return daemonPresence(this, input, agentId); }
  async releaseReadiness() { return daemonReleaseReadiness(this); }
  async completion(input: Input<'getRequestCompletion'>, agentId: string) { return daemonCompletion(this, input, agentId); }
  async postRoomMessage(input: Input<'postRoomMessage'>, agentId: string, atomicCommandWrite = false) { return daemonPostRoomMessage(this, input, agentId, atomicCommandWrite); }
  async postAgentAttachment(input: Input<'postAgentAttachment'>, agentId: string) { return daemonPostAgentAttachment(this, input, agentId); }
  async liveOutput(kind: 'draft' | 'thought', input: Input<'postAgentDraft'>, agentId: string) { return daemonLiveOutput(this, kind, input, agentId); }
  async retract(input: Input<'retractAgentLiveOutput'>, agentId: string) { return daemonRetract(this, input, agentId); }
  async persistTurnTrace(database: SqlDatabase, input: Input<'postAgentTurnReceipt'>, agentId: string): Promise<void> { return daemonPersistTurnTrace(this, database, input, agentId); }
  async turnReceipt(input: Input<'postAgentTurnReceipt'>, agentId: string) { return daemonTurnReceipt(this, input, agentId); }
  async activity(input: Input<'postAgentActivity'>, agentId: string) { return daemonActivity(this, input, agentId); }
  async approvalSource(cardKind: 'grant-request' | 'squire-approval', database = this.database): Promise<{
    sourceRoomId?: string;
    sourceMessageId?: string;
}> { return daemonApprovalSource(this, cardKind, database); }
  async linkSpendApproval(input: Input<'createLinkSpendRequest'>, agentId: string, ownerId: string, requestId: string, approvalUrl: string): Promise<void> { return daemonLinkSpendApproval(this, input, agentId, ownerId, requestId, approvalUrl); }
  async squireApproval(input: Input<'postSquireApproval'>, agentId: string, database = this.database) { return daemonSquireApproval(this, input, agentId, database); }
  async squireApprovalDecision(input: Input<'postSquireApprovalDecision'>, agentId: string): Promise<Output<'postSquireApprovalDecision'>> { return daemonSquireApprovalDecision(this, input, agentId); }
  async squireLoginWall(input: Input<'postSquireLoginWall'>, agentId: string): Promise<Output<'postSquireLoginWall'>> { return daemonSquireLoginWall(this, input, agentId); }
  async permissionRequest(input: Input<'postPermissionRequest'>, agentId: string) { return daemonPermissionRequest(this, input, agentId); }
  async permissionExecution(input: Input<'postPermissionExecution'>, agentId: string) { return daemonPermissionExecution(this, input, agentId); }
  async createAgentSchedule(input: Input<'createAgentSchedule'>, agentId: string, transaction?: SqlDatabase): Promise<Output<'createAgentSchedule'>> { return daemonCreateAgentSchedule(this, input, agentId, transaction); }
  async recordScheduleAuthorization(db: SqlDatabase, scheduleId: string, roomId: string, agentId: string, requestId: unknown, generationId: unknown): Promise<void> { return daemonRecordScheduleAuthorization(this, db, scheduleId, roomId, agentId, requestId, generationId); }
  async setEventSubscriptions(input: Input<'setEventSubscriptions'>, agentId: string) { return daemonSetEventSubscriptions(this, input, agentId); }
  async listEventSubscriptions(input: Input<'listEventSubscriptions'>, agentId: string) { return daemonListEventSubscriptions(this, input, agentId); }
  async postRoomEvent(input: Input<'postRoomEvent'>, agentId: string) { return daemonPostRoomEvent(this, input, agentId); }
  async listAgentSchedules(input: Input<'listAgentSchedules'>, agentId: string) { return daemonListAgentSchedules(this, input, agentId); }
  async requireScheduleAdmin(db: SqlDatabase, scheduleRoomId: string, input: {
    roomId: string;
    requestId?: unknown;
    generationId?: unknown;
}, agentId: string) { return daemonRequireScheduleAdmin(this, db, scheduleRoomId, input, agentId); }
  async deleteAgentSchedule(input: Input<'deleteAgentSchedule'>, agentId: string) { return daemonDeleteAgentSchedule(this, input, agentId); }
  async updateAgentSchedule(input: Input<'updateAgentSchedule'>, agentId: string, transaction?: SqlDatabase): Promise<Output<'updateAgentSchedule'>> { return daemonUpdateAgentSchedule(this, input, agentId, transaction); }
  async postMandate(input: Input<'postAgentToolMandate'>, agentId: string) { return daemonPostMandate(this, input, agentId); }
  async agentAvatar(input: Input<'postAgentAvatar'>, agentId: string) { return daemonAgentAvatar(this, input, agentId); }
  async commands(input: Input<'postAgentCommands'>, agentId: string) { return daemonCommands(this, input, agentId); }
  async modelCatalog(input: Input<'postAgentModelCatalog'>, agentId: string) { return daemonModelCatalog(this, input, agentId); }
  async machineReport(input: Input<'postAgentMachineReport'>, agentId: string) { return daemonMachineReport(this, input, agentId); }
  async report(text: string, agentId: string, command = this.authorizedCommand!, database = this.database, automatic = false, status?: unknown, ask?: string, to?: unknown) { return daemonReport(this, text, agentId, command, database, automatic, status, ask, to); }
  async watchCorner(input: Input<'watchCorner'>, agentId: string): Promise<Output<'watchCorner'>> { return daemonWatchCorner(this, input, agentId); }
  async cornerRemote(input: Input<'postCornerRemoteState'>, agentId: string) { return daemonCornerRemote(this, input, agentId); }
  async cornerPlan(input: Input<'postCornerPlan'>, agentId: string) { return daemonCornerPlan(this, input, agentId); }
  async briefAttachmentRooms(db: SqlDatabase, sourceRoomIds: readonly string[], cornerId: string, agentId: string, command: CommandRow): Promise<string[]> { return daemonBriefAttachmentRooms(this, db, sourceRoomIds, cornerId, agentId, command); }
  async renameCorner(input: Input<'renameCorner'>, agentId: string) { return daemonRenameCorner(this, input, agentId); }
  async targetProposal(input: Input<'postTargetBranchProposal'>, agentId: string) { return daemonTargetProposal(this, input, agentId); }
  async requestAgentGrant(input: Input<'requestAgentGrant'>, agentId: string, requireOwnerApproval = false) { return daemonRequestAgentGrant(this, input, agentId, requireOwnerApproval); }
  async askRoomChoice(input: Input<'askRoomChoice'>, agentId: string) { return daemonAskRoomChoice(this, input, agentId); }
  async openRoomPoll(input: Input<'openRoomPoll'>, agentId: string) { return daemonOpenRoomPoll(this, input, agentId); }
  async writeRoomChoice(input: Parameters<typeof postRoomChoice>[1]): Promise<Awaited<ReturnType<typeof postRoomChoice>>> { return daemonWriteRoomChoice(this, input); }
  async listAgentGrants(agentId: string, roomId?: string) { return daemonListAgentGrants(this, agentId, roomId); }
  async consumeAgentGrant(input: Input<'consumeAgentGrant'>, agentId: string) { return daemonConsumeAgentGrant(this, input, agentId); }
  async listAgentGrantRequests(agentId: string, roomId?: string) { return daemonListAgentGrantRequests(this, agentId, roomId); }
  async repositoryOnboardingRequester(agentId: string, roomId?: string, context?: Record<string, unknown>) { return daemonRepositoryOnboardingRequester(this, agentId, roomId, context); }
  async grantRequester(command = this.authorizedCommand) { return daemonGrantRequester(this, command); }
  async findGrantRequester(command = this.authorizedCommand) { return daemonFindGrantRequester(this, command); }
  async authorizeSquireCall(input: Input<'authorizeSquireCall'>, agentId: string) { return daemonAuthorizeSquireCall(this, input, agentId); }
  async authorizeScopedGrant(input: Input<'authorizeSquireCall'> & {
    readonly consume?: boolean;
}, agentId: string, kind: 'mcp', target: string) { return daemonAuthorizeScopedGrant(this, input, agentId, kind, target); }
  async appCardMark(appKey: string, domain?: string): Promise<{
    logo?: string;
    domain?: string;
}> { return daemonAppCardMark(this, appKey, domain); }
  async offerContext(roomId: string, agentId: string) { return daemonOfferContext(this, roomId, agentId); }
  async agentWorkbench(input: Input<'readAgentWorkbench'>, agentId: string): Promise<Output<'readAgentWorkbench'>> { return daemonAgentWorkbench(this, input, agentId); }
  async searchMcpRegistry(input: Input<'searchMcpRegistry'>): Promise<Output<'searchMcpRegistry'>> { return daemonSearchMcpRegistry(this, input); }
  warmConnectorIndex(): Promise<void> { return daemonWarmConnectorIndex(this); }
  async connectService(input: Input<'connect'>, agentId: string): Promise<Output<'connect'>> { return daemonConnectService(this, input, agentId); }
  async connectAppFrontDoor(input: Input<'connectApp'>, agentId: string): Promise<Output<'connectApp'>> { return daemonConnectAppFrontDoor(this, input, agentId); }
  async connectedAppForTool(appId: string, roomId: string, agentId: string, discovery = false) { return daemonConnectedAppForTool(this, appId, roomId, agentId, discovery); }
  async listAppTools(input: Input<'listAppTools'>, agentId: string) { return daemonListAppTools(this, input, agentId); }


   deferredAppTool?: (database: SqlDatabase) => Promise<Output<'executeAppTool'>>;
  async executeAppTool(input: Input<'executeAppTool'>, agentId: string) { return daemonExecuteAppTool(this, input, agentId); }
  async authorizeResource(input: Input<'authorizeResourceCall'>, agentId: string) { return daemonAuthorizeResource(this, input, agentId); }
  async connectMcpServer(input: Input<'connectMcpServer'>, agentId: string): Promise<Output<'connectMcpServer'>> { return daemonConnectMcpServer(this, input, agentId); }
  async offerConnector(input: Input<'offerConnector'>, agentId: string, unified = false): Promise<Output<'offerConnector'>> { return daemonOfferConnector(this, input, agentId, unified); }
  async createCorner(input: Input<'createCorner'>, agentId: string) { return daemonCreateCorner(this, input, agentId); }
  async reviseCornerBrief(input: Input<'reviseCornerBrief'>, agentId: string) { return daemonReviseCornerBrief(this, input, agentId); }
  async archiveCorner(input: Input<'archiveCorner'>, agentId: string) { return daemonArchiveCorner(this, input, agentId); }
  async ensureMembership(input: Input<'ensureAgentMembership'>, agentId: string) { return daemonEnsureMembership(this, input, agentId); }
  async identity(agentId: string) { return daemonIdentity(this, agentId); }
  async reviewSourceAccess(roomId: string, agentId: string): Promise<void> { return daemonReviewSourceAccess(this, roomId, agentId); }
  async access(roomId: string, agentId: string, requestId?: unknown): Promise<{
    cornerReviewer: boolean;
    isCorner: boolean;
    privateCommand: boolean;
    voiceAgentName?: string | null;
}> { return daemonAccess(this, roomId, agentId, requestId); }
  async roomMembers(roomId: string) { return daemonRoomMembers(this, roomId); }
  async postCornerMessage(input: Input<'postCornerMessage'>, agentId: string) { return daemonPostCornerMessage(this, input, agentId); }
  async postAddressAccess(address: string, agentId: string) { return daemonPostAddressAccess(this, address, agentId); }
  async reach(cornerId: string, agentId: string, database: SqlDatabase = this.database) { return daemonReach(this, cornerId, agentId, database); }
  async reactToRoomMessage(input: Input<'reactToRoomMessage'>, agentId: string): Promise<Output<'reactToRoomMessage'>> { return daemonReactToRoomMessage(this, input, agentId); }
  writeResult(extra?: {
    failureReportDelivered?: boolean;
}) { return daemonWriteResult(this, extra); }
}
