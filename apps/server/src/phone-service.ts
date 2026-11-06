import { directMessageRoomId } from './system-line.js';
import { CommandScopedDatabase } from './command-scoped-database.js';
import type { TrayDecisionOperation } from './tray-decision-command.js';
import { createWorkspace } from './workspace-creation.js';
import { ConnectorDiscoveryCache } from './connector-discovery-cache.js';
import { StarterOnboardingService } from './starter-onboarding-run.js';
import { CornerAccessDatabase } from './corner-access-database.js';
import { type ComposioApps } from './composio-apps.js';
import type { LinkAgentWallet } from './link-agent-wallet.js';
import type { AgentGrantView, AgentDetailView, AgentPairingClaimView, ChatListView, ChatListItem, ChatListCorner, CornerListView, InviteView, MessageSearchView, MessageBookmarkView, NeedsYouItemView, RoomLiveDelta, RoomHistoryOutline, RoomHistoryView, RoomView, RoomViewIdentity, RoomViewMember, RoomViewMessage, WorkspaceListView, WorkspaceAgentView, WorkspaceMemberGrantView, WorkspaceMemberListQuery, WorkspaceMemberListView, WorkspaceView } from '@beeline/api-contract/phone';
import { type PhoneOperationMap, type WelcomeCardsView, type PushLevel } from '@beeline/api-contract/phone';
import { type ConnectorOfferStatus } from '@beeline/api-contract/connector-offers';
import { type SqlDatabase } from './database.js';
import type { CommittedMessageLiveRow, LiveEvent, LiveHub } from './live.js';
import { HistoryOutlineCache } from './history-outline-cache.js';
import type { GitHubOperations } from './github-operations.js';
import type { FreeAgentService } from './free-agents.js';
import { McpRegistryClient } from './mcp-registry.js';
import type { ObjectService } from './object-service.js';
import { listRoomWorkflowRuns, readWorkflowRun } from './workflow-run-views.js';
import { phoneSetStarterOnboarding, phoneSetFreeAgents, phoneWithCommandTransaction, phoneApplyTrayDecisionCommand, phoneStopScheduledWorkCommand } from './phone/command-context.js';
import { phoneOptionalEnrichment } from './phone/optional-enrichment.js';
import { phoneCanReadRoom, phoneCanReadRooms, phoneRequireGrantAuthority, phoneRequireGitHub, phoneRequireIdentity, phoneRequireWorkspaceAgent, phoneRequireWorkspaceAgentRemover, phoneRequireWorkspaceMember, phoneHasRoomAccess, phoneAssertRoomIsWritable, phoneRequireRoomWorkspaceManager, phoneRequireHumanRoomWorkspaceManager, phoneRequireTopLevelChatMember, phoneRequireTopLevelRoom, phoneRequireWorkspaceManager, phoneRequireWorkspaceOwner } from './phone/access.js';
import { phoneProjectCommittedLiveDelta, phoneReadLiveDelta, phoneReadLiveDeltas, phoneReadLiveBookmark, phoneLiveWorkspaceChange, phoneLivePersonChange, phoneLiveNeedsYou, phoneLiveDraftSnapshot, phoneReadWelcomeCards, phoneCompleteWelcomeCards, phoneLiveChatCornerStatus, phoneLiveReadState, phoneLiveRoomCommands, phoneLiveWorkflowRuns, phoneLiveStarPrompt } from './phone/live-reads.js';
import { AttachmentFacts, DeckCornerFacts, RoomReadRow, MemberRow, RoomReadEnrichment, CornerRow, AgentGrantRow, Input, Output, RosterAgentRow, MessageRow, AgentTurnRow } from './phone/types.js';
import { messageId, ArchivedCornerCursor, MemberGrantRow } from './phone/values.js';
import { phoneReadWorkspaces, phoneReadWorkspace, phoneReadWorkspaceMembers } from './phone/workspaces.js';
import { phoneReadChats, phoneDirectMessagePresence } from './phone/chat-list.js';
import { phoneReadRoom, phoneResolveMessageLink } from './phone/room-read.js';
import { phoneSearchMessages, phoneReadHistoryAround, phoneReadHistoryAfter, phoneReadHistory, phoneReadHistoryOutline, phoneCountHistoryOutline } from './phone/history-search.js';
import { phoneReadCorners, phoneLoadCorners, phoneRoomRows, phoneCornerRoomEnrichment, phoneProjectRoomEnrichment, phoneCornerRowsSql, phoneProjectCorners } from './phone/corner-reads.js';
import { phoneReadAgent, phoneProjectAgentGrants, phoneProjectMemberGrantRows } from './phone/agent-reads.js';
import { phoneReadInvite, phoneLockPairingIssuer, phoneClaimAgentPairing, phoneWornSeededIdentity, phoneClaimAgentConnectPairing, phoneRenameConnectedAgent, phoneFinishAgentConnectPairing } from './phone/pairing.js';
import { phoneExecute } from './phone/execute.js';
import { phoneExecuteOperation } from './phone/operations.js';
import { phoneMarkRead, phoneMarkUnread, phoneUploadMedia, phoneObserveSentMessage, phoneSendMessage, phoneSendReply, phoneReactToMessage, phoneDeleteRoomMessage, phoneSetMessageBookmark, phoneClearMessageBookmarks } from './phone/messages.js';
import { phoneListRoomSchedules, phoneReadScheduledWork, phoneListRoomWorkflowRuns, phoneReadWorkflowRun, phoneDeleteRoomSchedule } from './phone/schedules.js';
import { phoneReadNeedsYou, phoneReadTray, phoneCountNeedsYou, phoneClearNeedsYou, phoneClearNeedsYouSection, phoneListMessageBookmarks } from './phone/tray.js';
import { phoneReceiptMessage, phonePendingAgentCommandsForMessage, phoneNoteUnansweredMentions, phoneWriteMentionNotice, phoneUnansweredMentionPhrase, phoneUnansweredMentionTargets } from './phone/mention-notices.js';
import { phoneCancelAgentTurn, phoneRequestCornerClose, phoneDecideApprovalCard, phoneDecidePermission } from './phone/approvals.js';
import { phoneCreateWorkspace, phoneUpdateWorkspace, phoneLeaveWorkspace, phoneDeleteWorkspace } from './phone/workspace-writes.js';
import { phoneCreateRoom, phoneCreateHumanCorner, phoneRenameCorner, phoneUpdateRoom, phoneDeleteRoom, phoneDeleteRoomRows, phoneLeaveRoom, phoneCloseChat, phoneReopenChat, phoneAddRoomMember, phoneRemoveRoomMember } from './phone/room-writes.js';
import { phoneAddWorkspaceMember, phoneRemoveWorkspaceMember, phoneResolveDirectMessage, phoneCreateInvite, phoneRedeemInvite } from './phone/members-invites.js';
import { phoneCreatePairing, phoneUpdateAgentSoul, phoneUpdateAgentModel, phoneBeginAgentSignIn, phoneCompleteAgentSignIn, phoneRefreshAgentModelCatalog, phoneDecideAgentGrant, phoneRevokeAgentGrant } from './phone/agent-configuration.js';
import { phoneCreateRoomPoll, phoneActOnRepositoryCard, phoneAnswerChoice, phoneSkipChoice } from './phone/room-actions.js';
import { phoneAcceptConnectorOffer, phoneAcceptWalletOffer, phoneMarkConnectorOfferConnecting } from './phone/connector-offers.js';
import { phoneUpdateAgentYolo, phoneUpdateAgentAccessPolicy, phoneRollbackUnrealizedAgent, phoneRemoveAgent } from './phone/agent-removal.js';
import { phoneDeleteAccount, phoneUpdateProfile, phoneUpdateFace, phoneUpdateRoomPushState, phoneUpdatePushLevel } from './phone/account-profile.js';
import { phoneSetRepository, phoneRemoveRepositoryBinding, phoneRoomRepository, phoneSetTargetBranch, phoneManagedIdentity, phoneClaimManagedHandle, phoneAdoptGitHubHandle, phoneIdentityRecovery, phoneListRepositories, phoneRepositoryAccess } from './phone/repositories.js';
import { phoneRegisterPush, phoneReportUpdate } from './phone/push-updates.js';
import { phoneAssertWorkbenchViewer, phoneViewerWorkbenchWorkspace, phoneReadAppCatalog, phoneSearchWorkbenchApps } from './phone/workbench-catalog.js';
import { phoneDecorateVoiceCallReasons, phoneDecorateApprovalSources, phoneDecorateCornerOpenCards, phoneDecorateMessageCards, phoneDecorateApprovalIdentities, phoneDecorateAppSignInCards } from './phone/message-decoration.js';
import { phoneReadConnectorInstall, phoneReadWorkbench, phoneResolveViewerHelper } from './phone/workbench-reads.js';
import { phoneConnectWorkbenchApp, phoneCompleteAppSignIn, phoneDisconnectWorkbenchApp, phonePairConnector, phoneArmConnectorPairing, phoneAssertOwnedConnector, phoneUnpairConnector } from './phone/connections.js';
import { phoneReadConnectionDetail, phoneRevokeConnectionGrants } from './phone/connection-reads.js';
import { phoneRosterSearchNeedle, phoneWorkspaceRoster, phoneProjectWorkspaceAgents, phoneMembers, phoneProjectMembers } from './phone/roster.js';
import { phoneAttachmentFacts, phoneEnrichHistoryRows, phoneEnrichMessageTags, phoneProjectAgentTurns, phoneProjectPendingAgentCommands, phoneEnrichMessageBookmarks, phoneProjectRoomMessages } from './phone/message-enrichment.js';

export { directMessageRoomId } from './system-line.js';
export type { ArchivedCornerCursor } from './phone/values.js';
export { parseArchivedCornerCursor } from './phone/values.js';
export { MessageSearchTooBroadError } from './phone/read-projection.js';
export { YOLO_AUTHORITY_MESSAGE } from './phone/values.js';
export { CONNECTOR_OFFER_AUTHORITY_MESSAGE } from './phone/values.js';
export { CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE } from './phone/values.js';
export { WORKSPACE_ADMIN_AUTHORITY_MESSAGE } from './phone/values.js';
export { AGENT_OWNER_AUTHORITY_MESSAGE } from './phone/values.js';
export { SPENDING_OWNER_AUTHORITY_MESSAGE } from './phone/values.js';
export { ACCESS_POLICY_AUTHORITY_MESSAGE } from './phone/values.js';
export { REVIEW_IDENTITY_MESSAGE } from './phone/values.js';
export { REVIEW_LOCKED_OPERATIONS } from './phone/operation-names.js';
export { PHONE_OPERATION_NAMES } from './phone/operation-names.js';

export class PhoneService {

   readonly lastEnrichmentLogAt = new Map<string, number>();

  /** Only with a live hub: the cache is unsound without its message invalidations. */
   readonly outlineCache?: HistoryOutlineCache;


   starterOnboarding?: StarterOnboardingService;
  setStarterOnboarding(service: StarterOnboardingService): void { return phoneSetStarterOnboarding(this, service); }


   freeAgents?: Pick<FreeAgentService, 'createInWorkspace' | 'kick' | 'remove' | 'cleanupRemoved'>;
  setFreeAgents(freeAgents: Pick<FreeAgentService, 'createInWorkspace' | 'kick' | 'remove' | 'cleanupRemoved'>): void { return phoneSetFreeAgents(this, freeAgents); }


  constructor(
     readonly database: SqlDatabase,
     readonly publicOrigin: string,
     readonly github?: GitHubOperations,
     readonly sendPushTest?: (identityId: string) => Promise<void>,
     readonly live?: LiveHub,
     readonly routingTransaction = false,
     readonly enrichmentDatabase: SqlDatabase = database,
     readonly objects?: ObjectService,
    _legacyProviderSlot?: unknown,
     readonly mcpRegistry: McpRegistryClient = new McpRegistryClient(),
     readonly composio?: ComposioApps,
     readonly linkWallet?: LinkAgentWallet,
  ) {
    this.starterOnboarding = new StarterOnboardingService(database);
    this.connectorDiscovery = new ConnectorDiscoveryCache(database, mcpRegistry);
    this.database = new CommandScopedDatabase(new CornerAccessDatabase(database));
    this.enrichmentDatabase = new CornerAccessDatabase(enrichmentDatabase);
    if (live) this.outlineCache = new HistoryOutlineCache(live);
  }


   readonly connectorDiscovery: ConnectorDiscoveryCache;
  async optionalEnrichment<T>(name: string, work: Promise<T>): Promise<T | undefined> { return phoneOptionalEnrichment<T>(this, name, work); }
  withCommandTransaction<T>(database: SqlDatabase, work: () => Promise<T>): Promise<T> { return phoneWithCommandTransaction<T>(this, database, work); }
  async applyTrayDecisionCommand(operation: TrayDecisionOperation, input: PhoneOperationMap[TrayDecisionOperation]['input'], viewerId: string, defer: (notification: () => void) => void): Promise<void> { return phoneApplyTrayDecisionCommand(this, operation, input, viewerId, defer); }
  async stopScheduledWorkCommand(operation: 'deleteRoomSchedule' | 'deleteRoomSubscription', input: {
    roomId: string;
    scheduleId?: string;
    subscriptionId?: string;
}, viewer: string): Promise<void> { return phoneStopScheduledWorkCommand(this, operation, input, viewer); }
  canReadRoom(roomId: string, identityId: string): Promise<boolean> { return phoneCanReadRoom(this, roomId, identityId); }
  async canReadRooms(roomIds: readonly string[], identityId: string): Promise<ReadonlySet<string>> { return phoneCanReadRooms(this, roomIds, identityId); }
  async projectCommittedLiveDelta(roomId: string, committed: {
    type: 'message';
    row: CommittedMessageLiveRow;
}, viewerId?: string): Promise<RoomLiveDelta | null> { return phoneProjectCommittedLiveDelta(this, roomId, committed, viewerId); }

   readonly committedAttachmentFacts =
    new WeakMap<CommittedMessageLiveRow, Promise<AttachmentFacts>>();
  async readLiveDelta(roomId: string, viewerId: string, target: {
    type: 'message';
    messageId: string;
} | {
    type: 'turn';
    agentId: string;
    requestId: string;
}, database: SqlDatabase = this.database): Promise<RoomLiveDelta | null> { return phoneReadLiveDelta(this, roomId, viewerId, target, database); }
  async readLiveDeltas(roomId: string, viewerIds: readonly string[], target: {
    type: 'message';
    messageId: string;
} | {
    type: 'turn';
    agentId: string;
    requestId: string;
}, database: SqlDatabase = this.database): Promise<ReadonlyMap<string, RoomLiveDelta>> { return phoneReadLiveDeltas(this, roomId, viewerIds, target, database); }
  async readLiveBookmark(messageId: string, viewerId: string): Promise<MessageBookmarkView | null> { return phoneReadLiveBookmark(this, messageId, viewerId); }
  async liveWorkspaceChange(workspaceId: string): Promise<{
    workspace: {
        id: string;
        name: string;
        avatar?: string;
    };
    viewers: ReadonlySet<string>;
} | null> { return phoneLiveWorkspaceChange(this, workspaceId); }
  async livePersonChange(personId: string): Promise<{
    person: RoomViewIdentity;
    pushLevel?: PushLevel;
    viewers: ReadonlySet<string>;
} | null> { return phoneLivePersonChange(this, personId); }
  async liveNeedsYou(roomId: string, viewerId: string): Promise<{
    workspaceId: string;
    count: number;
    items: readonly NeedsYouItemView[];
} | null> { return phoneLiveNeedsYou(this, roomId, viewerId); }
  async liveDraftSnapshot(roomId: string): Promise<LiveEvent[]> { return phoneLiveDraftSnapshot(this, roomId); }
  async readWelcomeCards(viewerId: string): Promise<WelcomeCardsView> { return phoneReadWelcomeCards(this, viewerId); }
  async completeWelcomeCards(viewerId: string): Promise<WelcomeCardsView> { return phoneCompleteWelcomeCards(this, viewerId); }
  async readWorkspaces(viewerId: string): Promise<WorkspaceListView> { return phoneReadWorkspaces(this, viewerId); }
  async readWorkspace(workspaceId: string, viewerId: string, query: WorkspaceMemberListQuery = {}): Promise<WorkspaceView | null> { return phoneReadWorkspace(this, workspaceId, viewerId, query); }
  async readWorkspaceMembers(workspaceId: string, viewerId: string, query: WorkspaceMemberListQuery = {}): Promise<WorkspaceMemberListView | null> { return phoneReadWorkspaceMembers(this, workspaceId, viewerId, query); }
  async liveChatCornerStatus(parentRoomId: string, viewerId: string): Promise<{
    cornerCount: number;
    waitingCornerCount: number;
    mineCornerCount: number;
    openCorners: ChatListCorner[];
    agentState: 'needs-you' | 'working' | null;
    attentionReason?: NonNullable<ChatListItem['attentionReason']>;
    corners: CornerListView['corners'];
    nextOpen?: string;
} | null> { return phoneLiveChatCornerStatus(this, parentRoomId, viewerId); }
  async readChats(workspaceId: string, viewerId: string): Promise<ChatListView | null> { return phoneReadChats(this, workspaceId, viewerId); }
  directMessagePresence(row: {
    peer_id: string | null;
    peer_kind: 'human' | 'agent' | null;
    peer_presence_body: Record<string, unknown> | null;
    peer_presence_updated_at: Date | null;
    peer_activity_at: Date | null;
}): {
    status: 'online' | 'offline';
    observedAt: number;
    held?: true;
} | undefined { return phoneDirectMessagePresence(this, row); }
  async readRoom(roomId: string, viewerId: string): Promise<RoomView | null> { return phoneReadRoom(this, roomId, viewerId); }
  async resolveMessageLink(messageId: string, viewerId: string) { return phoneResolveMessageLink(this, messageId, viewerId); }
  async searchMessages(workspaceId: string, viewerId: string, query: string, before?: string): Promise<MessageSearchView | null> { return phoneSearchMessages(this, workspaceId, viewerId, query, before); }
  async readHistoryAround(roomId: string, viewerId: string, targetId: string): Promise<RoomHistoryView | null> { return phoneReadHistoryAround(this, roomId, viewerId, targetId); }
  async readHistoryAfter(roomId: string, viewerId: string, afterId: string): Promise<RoomHistoryView | null> { return phoneReadHistoryAfter(this, roomId, viewerId, afterId); }
  async readHistory(roomId: string, viewerId: string, before?: {
    createdAt: number;
    id: string;
}): Promise<RoomHistoryView | null> { return phoneReadHistory(this, roomId, viewerId, before); }
  async readHistoryOutline(roomId: string, viewerId: string, timeZone: string): Promise<RoomHistoryOutline | null> { return phoneReadHistoryOutline(this, roomId, viewerId, timeZone); }
  async countHistoryOutline(roomId: string, timeZone: string): Promise<RoomHistoryOutline> { return phoneCountHistoryOutline(this, roomId, timeZone); }
  async readCorners(roomId: string, viewerId: string, roomViewFamilyOrder = false, archived = false, archivedBefore?: ArchivedCornerCursor, openBefore?: ArchivedCornerCursor): Promise<CornerListView | null> { return phoneReadCorners(this, roomId, viewerId, roomViewFamilyOrder, archived, archivedBefore, openBefore); }
  async loadCorners(roomId: string, viewerId: string, { roomViewFamilyOrder = false, archived = false, before, deck = false, }: {
    roomViewFamilyOrder?: boolean;
    archived?: boolean;
    before?: ArchivedCornerCursor;
    deck?: boolean;
} = {}): Promise<{
    view: CornerListView;
    deck: DeckCornerFacts | null;
} | null> { return phoneLoadCorners(this, roomId, viewerId, {roomViewFamilyOrder, archived, before, deck}); }
  async roomRows(roomId: string, viewerId: string): Promise<RoomReadRow | undefined> { return phoneRoomRows(this, roomId, viewerId); }
  async cornerRoomEnrichment(room: RoomReadRow['room'], rows: RoomReadRow, messageResult: {
    messages: RoomViewMessage[];
    toolRows: RoomViewMessage[];
}, viewerId: string): Promise<{
    presence: Array<{
        id: string;
        presence_body: MemberRow['presence_body'];
        presence_updated_at: Date | null;
    }>;
    tags: Array<{
        id: string;
        tagged_ids: string[];
    }>;
    bookmarks: Array<{
        message_id: string;
    }>;
    reports: Array<{
        trigger_message_id: string;
    }>;
    attachmentFacts: AttachmentFacts;
    allow_auto_merge: boolean | null;
} | undefined> { return phoneCornerRoomEnrichment(this, room, rows, messageResult, viewerId); }
  projectRoomEnrichment(value: RoomReadEnrichment) { return phoneProjectRoomEnrichment(this, value); }
  cornerRowsSql(roomViewFamilyOrder = false, archived = false, before?: ArchivedCornerCursor): string { return phoneCornerRowsSql(this, roomViewFamilyOrder, archived, before); }
  projectCorners(rows: readonly CornerRow[]): CornerListView['corners'] { return phoneProjectCorners(this, rows); }
  async readAgent(workspaceId: string, agentId: string, viewerId: string, workCursor?: string): Promise<AgentDetailView | null> { return phoneReadAgent(this, workspaceId, agentId, viewerId, workCursor); }
  projectAgentGrants(rows: AgentGrantRow[]): AgentGrantView[] { return phoneProjectAgentGrants(this, rows); }
  projectMemberGrantRows(rows: readonly MemberGrantRow[]): WorkspaceMemberGrantView[] { return phoneProjectMemberGrantRows(this, rows); }
  async readInvite(rawToken: string, viewerId: string): Promise<InviteView | null> { return phoneReadInvite(this, rawToken, viewerId); }
  async lockPairingIssuer(database: SqlDatabase, workspaceId: string, issuerId: string) { return phoneLockPairingIssuer(this, database, workspaceId, issuerId); }
  async claimAgentPairing(code: string, agentId: string): Promise<AgentPairingClaimView | null> { return phoneClaimAgentPairing(this, code, agentId); }
  async wornSeededIdentity(database: SqlDatabase, workspaceId: string, exceptIdentityId: string): Promise<{
    faces: string[];
    names: string[];
}> { return phoneWornSeededIdentity(this, database, workspaceId, exceptIdentityId); }
  async claimAgentConnectPairing(input: {
    code: string;
    agentPubkey: string;
    model: string;
    effort?: string;
    avatarSeed?: string;
    eventSubscriptions?: readonly string[];
    deferJoin?: boolean;
}): Promise<{
    status: 'claimed';
    workspaceId: string;
    workspaceName: string;
    pairedBy: string;
    agentName: string;
    soul: string;
    face: string;
    workspaceJoined: boolean;
} | {
    status: 'not_found' | 'expired' | 'already_claimed';
}>;
  async claimAgentConnectPairing(input: {
    code: string;
    agentPubkey: string;
    model: string;
    effort?: string;
    avatarSeed?: string;
    eventSubscriptions?: readonly string[];
    deferJoin?: boolean;
    machineId?: string;
    machineName?: string;
}, createDaemonExchange: (agentId: string, database: SqlDatabase) => Promise<{
    exchangeToken: string;
}>): Promise<{
    status: 'claimed';
    workspaceId: string;
    workspaceName: string;
    pairedBy: string;
    agentName: string;
    soul: string;
    face: string;
    workspaceJoined: boolean;
    daemonExchangeToken: string;
} | {
    status: 'not_found' | 'expired' | 'already_claimed';
}>;
  async claimAgentConnectPairing(input: {
    code: string;
    agentPubkey: string;
    model: string;
    effort?: string;
    avatarSeed?: string;
    eventSubscriptions?: readonly string[];
    deferJoin?: boolean;
    machineId?: string;
    machineName?: string;
}, createDaemonExchange?: (agentId: string, database: SqlDatabase) => Promise<{
    exchangeToken: string;
}>): Promise<{
    status: 'claimed';
    workspaceId: string;
    workspaceName: string;
    pairedBy: string;
    agentName: string;
    soul: string;
    face: string;
    workspaceJoined: boolean;
    daemonExchangeToken?: string;
} | {
    status: 'not_found' | 'expired' | 'already_claimed';
}> { return phoneClaimAgentConnectPairing(this, input, createDaemonExchange); }
  async renameConnectedAgent(input: {
    code: string;
    name: string;
}): Promise<{
    status: 'renamed';
    agentName: string;
} | {
    status: 'not_found' | 'expired';
}> { return phoneRenameConnectedAgent(this, input); }
  async finishAgentConnectPairing(input: {
    code: string;
    workspaceJoined: boolean;
    eventSubscriptions?: readonly string[];
}): Promise<{
    status: 'finished';
} | {
    status: 'not_found' | 'expired';
}> { return phoneFinishAgentConnectPairing(this, input); }
  async execute<Name extends keyof PhoneOperationMap>(name: Name, input: Input<Name>, viewerId: string, sourceClient?: {
    id: string;
    name: string;
}, familyId?: string, deferPostCommitObservation = false): Promise<Output<Name>> { return phoneExecute<Name>(this, name, input, viewerId, sourceClient, familyId, deferPostCommitObservation); }
  async executeOperation<Name extends keyof PhoneOperationMap>(name: Name, input: Input<Name>, viewerId: string, sourceClient?: {
    id: string;
    name: string;
}, familyId?: string, deferPostCommitObservation = false): Promise<Output<Name>> { return phoneExecuteOperation<Name>(this, name, input, viewerId, sourceClient, familyId, deferPostCommitObservation); }
  async liveReadState(roomId: string, viewerId: string) { return phoneLiveReadState(this, roomId, viewerId); }
  async liveRoomCommands(roomId: string, viewerId: string) { return phoneLiveRoomCommands(this, roomId, viewerId); }
  async markRead(roomId: string, messageIdValue: string, viewerId: string): Promise<void> { return phoneMarkRead(this, roomId, messageIdValue, viewerId); }
  async markUnread(roomId: string, messageIdValue: string, viewerId: string): Promise<void> { return phoneMarkUnread(this, roomId, messageIdValue, viewerId); }
  async uploadMedia(viewerId: string, bytes: Uint8Array, mimeType: string, name: string, maximumBytes: number) { return phoneUploadMedia(this, viewerId, bytes, mimeType, name, maximumBytes); }
  async observeSentMessage(roomId: string, viewerId: string, defer: boolean): Promise<void> { return phoneObserveSentMessage(this, roomId, viewerId, defer); }
  async sendMessage(input: Input<'sendRoomMessage'>, author: string, sourceClient?: {
    id: string;
    name: string;
}, familyId?: string): Promise<Output<'sendRoomMessage'>> { return phoneSendMessage(this, input, author, sourceClient, familyId); }
  async listRoomSchedules(roomId: string, viewerId: string) { return phoneListRoomSchedules(this, roomId, viewerId); }
  async readScheduledWork(roomId: string, viewerId: string): Promise<Output<'readScheduledWork'>> { return phoneReadScheduledWork(this, roomId, viewerId); }
  async listRoomWorkflowRuns(roomId: string, viewerId: string) { return phoneListRoomWorkflowRuns(this, roomId, viewerId); }
  async liveWorkflowRuns(roomId: string, viewerId: string) { return phoneLiveWorkflowRuns(this, roomId, viewerId); }
  async readWorkflowRun(input: Input<'readWorkflowRun'>, viewerId: string) { return phoneReadWorkflowRun(this, input, viewerId); }
  async deleteRoomSchedule(input: Input<'deleteRoomSchedule'>, viewerId: string): Promise<void> { return phoneDeleteRoomSchedule(this, input, viewerId); }
  async sendReply(input: Input<'sendRoomReply'>, author: string, sourceClient?: {
    id: string;
    name: string;
}, familyId?: string): Promise<Output<'sendRoomReply'>> { return phoneSendReply(this, input, author, sourceClient, familyId); }
  async liveStarPrompt(viewerId: string) { return phoneLiveStarPrompt(this, viewerId); }
  async reactToMessage(input: Input<'reactToMessage'>, viewerId: string): Promise<Output<'reactToMessage'>> { return phoneReactToMessage(this, input, viewerId); }
  async deleteRoomMessage(input: Input<'deleteRoomMessage'>, viewerId: string): Promise<RoomViewMessage | null> { return phoneDeleteRoomMessage(this, input, viewerId); }
  async setMessageBookmark(input: Input<'setMessageBookmark'>, viewerId: string): Promise<Output<'setMessageBookmark'>> { return phoneSetMessageBookmark(this, input, viewerId); }
  async clearMessageBookmarks(input: Input<'clearMessageBookmarks'>, viewerId: string): Promise<void> { return phoneClearMessageBookmarks(this, input, viewerId); }
  async readNeedsYou(input: Input<'readNeedsYou'>, viewerId: string): Promise<Output<'readNeedsYou'>> { return phoneReadNeedsYou(this, input, viewerId); }
  async readTray(input: Input<'readTray'>, viewerId: string): Promise<Output<'readTray'>> { return phoneReadTray(this, input, viewerId); }
  async countNeedsYou(input: Input<'countNeedsYou'>, viewerId: string): Promise<Output<'countNeedsYou'>> { return phoneCountNeedsYou(this, input, viewerId); }
  async clearNeedsYou(input: Input<'clearNeedsYou'>, viewerId: string): Promise<void> { return phoneClearNeedsYou(this, input, viewerId); }
  async clearNeedsYouSection(input: Input<'clearNeedsYouSection'>, viewerId: string): Promise<void> { return phoneClearNeedsYouSection(this, input, viewerId); }
  async listMessageBookmarks(input: Input<'listMessageBookmarks'>, viewerId: string): Promise<Output<'listMessageBookmarks'>> { return phoneListMessageBookmarks(this, input, viewerId); }
  async receiptMessage(roomId: string, viewerId: string, messageIdValue: string, database: SqlDatabase) { return phoneReceiptMessage(this, roomId, viewerId, messageIdValue, database); }
  async pendingAgentCommandsForMessage(database: SqlDatabase, roomId: string, messageIdValue: string): Promise<NonNullable<RoomView['pendingAgentCommands']>> { return phonePendingAgentCommandsForMessage(this, database, roomId, messageIdValue); }
  async noteUnansweredMentions(roomId: string, senderId: string, agentIds: readonly string[], afterMessageId?: string): Promise<void> { return phoneNoteUnansweredMentions(this, roomId, senderId, agentIds, afterMessageId); }
  async writeMentionNotice(database: SqlDatabase, input: {
    readonly roomId: string;
    readonly id: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly phrase: {
        readonly reason: string;
        readonly verb: string;
        readonly consequence: string;
        readonly object?: {
            text: string;
            id: string;
        };
    };
    readonly afterMessageId?: string;
}): Promise<void> { return phoneWriteMentionNotice(this, database, input); }
  unansweredMentionPhrase(agent: {
    agent_id: string;
    agent_name: string;
    agent_handle: string | null;
    access_policy: unknown;
    owner_id: string | null;
    owner_handle: string | null;
    member: boolean;
    corner: boolean;
}, sender: {
    kind: 'human' | 'agent';
    handle: string | null;
}, senderId: string): {
    reason: string;
    verb: string;
    consequence: string;
    object?: {
        text: string;
        id: string;
    };
} | undefined { return phoneUnansweredMentionPhrase(this, agent, sender, senderId); }
  async unansweredMentionTargets(roomId: string, author: string, text: string, source?: {
    authorKind: 'human' | 'agent';
    direct: boolean;
    corner: boolean;
}): Promise<readonly string[]> { return phoneUnansweredMentionTargets(this, roomId, author, text, source); }
  async cancelAgentTurn(input: Input<'cancelAgentTurn'>, viewerId: string) { return phoneCancelAgentTurn(this, input, viewerId); }
  async requestCornerClose(roomId: string, viewerId: string, locked?: boolean) { return phoneRequestCornerClose(this, roomId, viewerId, locked); }
  async decideApprovalCard(input: Input<'decideApprovalCard'>, viewerId: string) { return phoneDecideApprovalCard(this, input, viewerId); }
  async decidePermission(input: Input<'decideWritePermission'>, viewerId: string) { return phoneDecidePermission(this, input, viewerId); }
  async createWorkspace(input: Input<'createWorkspace'>, viewerId: string) { return phoneCreateWorkspace(this, input, viewerId); }
  async updateWorkspace(input: Input<'updateWorkspace'>, viewerId: string) { return phoneUpdateWorkspace(this, input, viewerId); }
  async leaveWorkspace(input: Input<'leaveWorkspace'>, viewerId: string) { return phoneLeaveWorkspace(this, input, viewerId); }
  async deleteWorkspace(input: Input<'deleteWorkspace'>, viewerId: string) { return phoneDeleteWorkspace(this, input, viewerId); }
  async createRoom(input: Input<'createRoom'>, viewerId: string) { return phoneCreateRoom(this, input, viewerId); }
  async createHumanCorner(input: Input<'createHumanCorner'>, viewerId: string) { return phoneCreateHumanCorner(this, input, viewerId); }
  async renameCorner(roomId: string, name: string | undefined, viewerId: string) { return phoneRenameCorner(this, roomId, name, viewerId); }
  async updateRoom(input: Input<'updateRoom'>, viewerId: string) { return phoneUpdateRoom(this, input, viewerId); }
  async deleteRoom(roomId: string, viewerId: string) { return phoneDeleteRoom(this, roomId, viewerId); }
  async deleteRoomRows(database: SqlDatabase, roomId: string) { return phoneDeleteRoomRows(this, database, roomId); }
  async leaveRoom(input: Input<'leaveRoom'>, viewerId: string) { return phoneLeaveRoom(this, input, viewerId); }
  async closeChat(roomId: string, viewerId: string) { return phoneCloseChat(this, roomId, viewerId); }
  async reopenChat(roomId: string, viewerId: string) { return phoneReopenChat(this, roomId, viewerId); }
  async addRoomMember(input: Input<'addRoomMember'>, viewerId: string) { return phoneAddRoomMember(this, input, viewerId); }
  async removeRoomMember(input: Input<'removeRoomMember'>, viewerId: string) { return phoneRemoveRoomMember(this, input, viewerId); }
  async addWorkspaceMember(input: Input<'addWorkspaceMember'>, viewerId: string) { return phoneAddWorkspaceMember(this, input, viewerId); }
  async removeWorkspaceMember(input: Input<'removeWorkspaceMember'>, viewerId: string) { return phoneRemoveWorkspaceMember(this, input, viewerId); }
  async resolveDirectMessage(input: Input<'resolveDirectMessage'>, viewerId: string) { return phoneResolveDirectMessage(this, input, viewerId); }
  async createInvite(input: Input<'createInvite'>, viewerId: string) { return phoneCreateInvite(this, input, viewerId); }
  async redeemInvite(input: Input<'redeemInvite'>, viewerId: string) { return phoneRedeemInvite(this, input, viewerId); }
  async createPairing(input: Input<'createAgentPairingCode'>, viewerId: string) { return phoneCreatePairing(this, input, viewerId); }
  async updateAgentSoul(input: Input<'updateAgentSoul'>, viewerId: string) { return phoneUpdateAgentSoul(this, input, viewerId); }
  async updateAgentModel(input: Input<'updateAgentModelSelection'>, viewerId: string) { return phoneUpdateAgentModel(this, input, viewerId); }
  beginAgentSignIn(input: {
    roomId: string;
    text: string;
}, messageId: string) { return phoneBeginAgentSignIn(this, input, messageId); }
  async completeAgentSignIn(input: Input<'completeAgentSignIn'>, viewerId: string) { return phoneCompleteAgentSignIn(this, input, viewerId); }
  async refreshAgentModelCatalog(input: Input<'refreshAgentModelCatalog'>, viewerId: string) { return phoneRefreshAgentModelCatalog(this, input, viewerId); }
  async decideAgentGrant(input: Input<'decideAgentGrant'>, viewerId: string, defer?: (notification: () => void) => void) { return phoneDecideAgentGrant(this, input, viewerId, defer); }
  async revokeAgentGrant(input: Input<'revokeAgentGrant'>, viewerId: string) { return phoneRevokeAgentGrant(this, input, viewerId); }
  async createRoomPoll(input: Input<'createRoomPoll'>, viewerId: string) { return phoneCreateRoomPoll(this, input, viewerId); }
  async actOnRepositoryCard(input: Input<'actOnRepositoryCard'>, viewerId: string): Promise<Output<'actOnRepositoryCard'>> { return phoneActOnRepositoryCard(this, input, viewerId); }
  async answerChoice(input: Input<'answerChoice'>, viewerId: string) { return phoneAnswerChoice(this, input, viewerId); }
  async skipChoice(input: Input<'skipChoice'>, viewerId: string) { return phoneSkipChoice(this, input, viewerId); }
  async requireGrantAuthority(grantId: unknown, viewerId: string) { return phoneRequireGrantAuthority(this, grantId, viewerId); }
  async acceptConnectorOffer(input: Input<'acceptConnectorOffer'>, viewerId: string): Promise<Output<'acceptConnectorOffer'>> { return phoneAcceptConnectorOffer(this, input, viewerId); }
  async acceptWalletOffer(offer: {
    id: string;
    workspace_id: string;
    room_id: string;
    addressee_id: string;
    status: ConnectorOfferStatus;
}, viewerId: string): Promise<Output<'acceptConnectorOffer'>> { return phoneAcceptWalletOffer(this, offer, viewerId); }
  async markConnectorOfferConnecting(database: SqlDatabase, input: {
    roomId: string;
    offerId: string;
    acceptedBy: RoomViewIdentity;
    acceptedAt: Date;
    connectorId?: string;
}) { return phoneMarkConnectorOfferConnecting(this, database, input); }
  async updateAgentYolo(input: Input<'updateAgentYolo'>, viewerId: string) { return phoneUpdateAgentYolo(this, input, viewerId); }
  async updateAgentAccessPolicy(input: Input<'updateAgentAccessPolicy'>, viewerId: string) { return phoneUpdateAgentAccessPolicy(this, input, viewerId); }
  async rollbackUnrealizedAgent(agentId: string) { return phoneRollbackUnrealizedAgent(this, agentId); }
  async removeAgent(input: Input<'removeAgent'>, viewerId: string) { return phoneRemoveAgent(this, input, viewerId); }
  async deleteAccount(viewerId: string) { return phoneDeleteAccount(this, viewerId); }
  async updateProfile(input: Input<'updatePersonProfile'>, viewerId: string) { return phoneUpdateProfile(this, input, viewerId); }
  async updateFace(input: Input<'updateIdentityFace'>, viewerId: string) { return phoneUpdateFace(this, input, viewerId); }
  async updateRoomPushState(input: Input<'updateRoomPushState'>, viewerId: string) { return phoneUpdateRoomPushState(this, input, viewerId); }
  async updatePushLevel(input: Input<'updateIdentityPushLevel'>, viewerId: string) { return phoneUpdatePushLevel(this, input, viewerId); }
  async setRepository(input: Input<'setRoomRepository'>, viewerId: string) { return phoneSetRepository(this, input, viewerId); }
  async removeRepositoryBinding(input: Input<'removeRoomRepository'>, viewerId: string) { return phoneRemoveRepositoryBinding(this, input, viewerId); }
  async roomRepository(roomId: string) { return phoneRoomRepository(this, roomId); }
  async setTargetBranch(input: Input<'setRoomTargetBranch'>, viewerId: string) { return phoneSetTargetBranch(this, input, viewerId); }
  async managedIdentity(viewerId: string) { return phoneManagedIdentity(this, viewerId); }
  async claimManagedHandle(viewerId: string, handle: string) { return phoneClaimManagedHandle(this, viewerId, handle); }
  async adoptGitHubHandle(viewerId: string) { return phoneAdoptGitHubHandle(this, viewerId); }
  async identityRecovery(viewerId: string) { return phoneIdentityRecovery(this, viewerId); }
  async listRepositories(viewerId: string) { return phoneListRepositories(this, viewerId); }
  async repositoryAccess(fullName: string, viewerId: string) { return phoneRepositoryAccess(this, fullName, viewerId); }
  async registerPush(input: Input<'registerPushDevice'>, viewerId: string) { return phoneRegisterPush(this, input, viewerId); }
  async reportUpdate(input: Input<'reportRunningUpdate'>, viewerId: string, familyId?: string) { return phoneReportUpdate(this, input, viewerId, familyId); }
  requireGitHub() { return phoneRequireGitHub(this); }
  async requireIdentity(id: string, database: SqlDatabase = this.database) { return phoneRequireIdentity(this, id, database); }
  async requireWorkspaceAgent(workspaceId: string, agentId: string, viewerId: string) { return phoneRequireWorkspaceAgent(this, workspaceId, agentId, viewerId); }
  async requireWorkspaceAgentRemover(workspaceId: string, agentId: string, viewerId: string) { return phoneRequireWorkspaceAgentRemover(this, workspaceId, agentId, viewerId); }
  async requireWorkspaceMember(workspaceId: string, identityId: string, database = this.database) { return phoneRequireWorkspaceMember(this, workspaceId, identityId, database); }
  async hasRoomAccess(roomId: string, identityId: string) { return phoneHasRoomAccess(this, roomId, identityId); }
  async assertWorkbenchViewer(_workspaceId: string, viewerId: string): Promise<void> { return phoneAssertWorkbenchViewer(this, _workspaceId, viewerId); }
  async viewerWorkbenchWorkspace(viewerId: string): Promise<string> { return phoneViewerWorkbenchWorkspace(this, viewerId); }
  async readAppCatalog(keys: Iterable<string>): Promise<{
    appKey: string;
    description?: string;
    logo?: string;
    domain?: string;
}[]> { return phoneReadAppCatalog(this, keys); }
  async searchWorkbenchApps(input: Input<'searchWorkbenchApps'>, viewerId: string): Promise<Output<'searchWorkbenchApps'>> { return phoneSearchWorkbenchApps(this, input, viewerId); }
  async decorateVoiceCallReasons(roomId: string, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> { return phoneDecorateVoiceCallReasons(this, roomId, messages); }
  async decorateApprovalSources(messages: RoomViewMessage[]): Promise<RoomViewMessage[]> { return phoneDecorateApprovalSources(this, messages); }
  async decorateCornerOpenCards(roomId: string, messages: RoomViewMessage[]): Promise<RoomViewMessage[]> { return phoneDecorateCornerOpenCards(this, roomId, messages); }
  async decorateMessageCards(roomId: string, messages: RoomViewMessage[], viewerId: string): Promise<RoomViewMessage[]> { return phoneDecorateMessageCards(this, roomId, messages, viewerId); }
  async decorateApprovalIdentities(messages: RoomViewMessage[]): Promise<RoomViewMessage[]> { return phoneDecorateApprovalIdentities(this, messages); }
  async decorateAppSignInCards(messages: RoomViewMessage[]): Promise<RoomViewMessage[]> { return phoneDecorateAppSignInCards(this, messages); }
  async readConnectorInstall(input: Input<'readConnectorInstall'>, viewerId: string): Promise<Output<'readConnectorInstall'>> { return phoneReadConnectorInstall(this, input, viewerId); }
  async readWorkbench(input: Input<'readWorkbench'>, viewerId: string): Promise<Output<'readWorkbench'>> { return phoneReadWorkbench(this, input, viewerId); }
  async resolveViewerHelper(helperAgentId: string, viewerId: string) { return phoneResolveViewerHelper(this, helperAgentId, viewerId); }
  async connectWorkbenchApp(input: Input<'connectWorkbenchApp'>, viewerId: string): Promise<Output<'connectWorkbenchApp'>> { return phoneConnectWorkbenchApp(this, input, viewerId); }
  async completeAppSignIn(sessionUri: string, appId: string, viewerId: string) { return phoneCompleteAppSignIn(this, sessionUri, appId, viewerId); }
  async disconnectWorkbenchApp(input: Input<'disconnectWorkbenchApp'>, viewerId: string): Promise<void> { return phoneDisconnectWorkbenchApp(this, input, viewerId); }
  async pairConnector(input: Input<'pairConnector'>, viewerId: string): Promise<Output<'pairConnector'>> { return phonePairConnector(this, input, viewerId); }
  async armConnectorPairing(database: SqlDatabase, input: {
    workspaceId: string;
    ownerIdentityId: string;
    connectorType: Input<'pairConnector'>['connectorType'];
    helperAgentId: string;
    machineId: string;
}): Promise<Output<'pairConnector'>> { return phoneArmConnectorPairing(this, database, input); }
  async assertOwnedConnector(connectorId: string, viewerId: string) { return phoneAssertOwnedConnector(this, connectorId, viewerId); }
  async unpairConnector(input: Input<'unpairConnector'>, viewerId: string): Promise<void> { return phoneUnpairConnector(this, input, viewerId); }
  async readConnectionDetail(input: Input<'readConnectionDetail'>, viewerId: string): Promise<Output<'readConnectionDetail'>> { return phoneReadConnectionDetail(this, input, viewerId); }
  async revokeConnectionGrants(input: Input<'revokeConnectionGrants'>, viewerId: string): Promise<Output<'revokeConnectionGrants'>> { return phoneRevokeConnectionGrants(this, input, viewerId); }
  async assertRoomIsWritable(roomId: string, author: string): Promise<void> { return phoneAssertRoomIsWritable(this, roomId, author); }
  async requireRoomWorkspaceManager(roomId: string, identityId: string, database = this.database) { return phoneRequireRoomWorkspaceManager(this, roomId, identityId, database); }
  async requireHumanRoomWorkspaceManager(roomId: string, identityId: string) { return phoneRequireHumanRoomWorkspaceManager(this, roomId, identityId); }
  async requireTopLevelChatMember(roomId: string, identityId: string, database = this.database) { return phoneRequireTopLevelChatMember(this, roomId, identityId, database); }
  async requireTopLevelRoom(roomId: string) { return phoneRequireTopLevelRoom(this, roomId); }
  async requireWorkspaceManager(workspaceId: string, identityId: string, database = this.database) { return phoneRequireWorkspaceManager(this, workspaceId, identityId, database); }
  async requireWorkspaceOwner(workspaceId: string, identityId: string, database = this.database) { return phoneRequireWorkspaceOwner(this, workspaceId, identityId, database); }
  rosterSearchNeedle(query: string | undefined): string | null { return phoneRosterSearchNeedle(this, query); }
  async workspaceRoster(workspaceId: string, viewerId: string, query: WorkspaceMemberListQuery = {}): Promise<(WorkspaceMemberListView & {
    workspaceRow: {
        id: string;
        name: string;
        avatar: string | null;
        visibility: 'public' | 'invite-only';
        allow_fix_sweep: boolean;
        created_at: Date;
        updated_at: Date;
        role: 'owner' | 'admin' | 'member' | 'spectator';
    };
    viewerIdentity: RoomViewIdentity;
    managedRoomRows: Array<{
        id: string;
        name: string;
        visibility: 'public' | 'invite-only';
        created_at: Date;
    }>;
}) | null> { return phoneWorkspaceRoster(this, workspaceId, viewerId, query); }
  projectWorkspaceAgents(rows: MemberRow[], configs: RosterAgentRow[]): WorkspaceAgentView[] { return phoneProjectWorkspaceAgents(this, rows, configs); }
  async members(workspaceId: string, roomId: string | null, memberId?: string): Promise<RoomViewMember[]> { return phoneMembers(this, workspaceId, roomId, memberId); }
  projectMembers(rows: readonly MemberRow[], roomId: string | null): RoomViewMember[] { return phoneProjectMembers(this, rows, roomId); }
  async attachmentFacts(...groups: readonly (readonly RoomViewMessage[])[]): Promise<AttachmentFacts> { return phoneAttachmentFacts(this, ...groups); }
  async enrichHistoryRows(rows: MessageRow[], viewerId: string): Promise<AttachmentFacts> { return phoneEnrichHistoryRows(this, rows, viewerId); }
  async enrichMessageTags(rows: MessageRow[]): Promise<void> { return phoneEnrichMessageTags(this, rows); }
  projectAgentTurns(turns: readonly AgentTurnRow[]): RoomView['latestAgentTurns'] { return phoneProjectAgentTurns(this, turns); }
  projectPendingAgentCommands(commands: readonly {
    agent_id: string;
    turn_request_id: string;
    created_at: Date | string;
}[]): NonNullable<RoomView['pendingAgentCommands']> { return phoneProjectPendingAgentCommands(this, commands); }
  async enrichMessageBookmarks(rows: readonly MessageRow[], viewerId: string): Promise<void> { return phoneEnrichMessageBookmarks(this, rows, viewerId); }
  projectRoomMessages(transcriptRows: readonly MessageRow[], liveRows: readonly MessageRow[], cornerActivityRows: readonly MessageRow[], resolvedAgentTurns: RoomView['latestAgentTurns'], isCorner: boolean, viewerId?: string): {
    messages: RoomViewMessage[];
    toolRows: RoomViewMessage[];
} { return phoneProjectRoomMessages(this, transcriptRows, liveRows, cornerActivityRows, resolvedAgentTurns, isCorner, viewerId); }
}
