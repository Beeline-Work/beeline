import type { AgentGrantDecision, AgentGrantStatus } from './agent-grants.js';
import type { ChoiceStatus, ChoiceOptionInput } from './room-choices.js';
import type { AgentAccessPolicy } from './agent-access.js';
import type { PushLevel } from './push-level.js';
import type { WorkflowContract, WorkflowTerminalState } from './workflow-contracts.js';
import type { GrantWalletDelegationInput, GrantWalletDelegationResult } from './wallet.js';
import type {
  AgentModelSelection,
  AgentPairingClaimView,
  AttachmentReference,
  InviteView,
  MessageBookmarkView,
  MessageReactionEmoji,
  NeedsYouItemView,
} from './phone-types.js';
import type {
  CreateWalletInput,
  ReadWalletHistoryInput,
  ReadWalletInput,
  SendFromWalletInput,
  WalletHistoryResult,
  WalletSendOutcome,
  WalletView,
} from './wallet.js';
import type {
  ConnectionDetailView,
  CancelGoogleSignInInput,
  ConnectWorkbenchAppInput,
  ConnectWorkbenchAppResult,
  CompleteAppSignInInput,
  CompleteAppSignInResult,
  BeginAppSignInInput,
  BeginAppSignInResult,
  DisconnectWorkbenchAppInput,
  PairConnectorInput,
  PairConnectorResult,
  ReadConnectionDetailInput,
  ReadWorkbenchInput,
  RevokeConnectionGrantsInput,
  RevokeConnectionGrantsResult,
  UnpairConnectorInput,
  WorkbenchView,
} from './workbench.js';

export type {
  WorkflowContract,
  WorkflowLoop,
  WorkflowState,
  WorkflowTerminalState,
} from './workflow-contracts.js';

export const HUMAN_CORNER_TITLE_MAX_LENGTH = 120;

export type PhoneOperationMap = {
  readWelcomeCards: { input: Record<string, never>; output: WelcomeCardsView };
  completeWelcomeCards: { input: Record<string, never>; output: WelcomeCardsView };
  /** The viewer's GitHub star card, when a reply milestone and a later win make it due. */
  readStarPrompt: { input: Record<string, never>; output: StarPromptView };
  /** Star (or fall back to the repository link), wait for the next milestone, or stop asking. */
  answerStarPrompt: { input: AnswerStarPromptInput; output: AnswerStarPromptResult };
  sendRoomMessage: { input: SendRoomMessageInput; output: AgentMessageWriteResult };
  sendRoomReply: { input: SendRoomReplyInput; output: AgentMessageWriteResult };
  reactToMessage: { input: ReactToMessageInput; output: void };
  deleteRoomMessage: { input: DeleteRoomMessageInput; output: void };
  setMessageBookmark: { input: SetMessageBookmarkInput; output: SetMessageBookmarkResult };
  /** Report issue: files this message with the Beeline feedback loop. One report per message. */
  reportMessageIssue: { input: ReportMessageIssueInput; output: ReportMessageIssueResult };
  listMessageBookmarks: { input: WorkspaceInput; output: MessageBookmarkListResult };
  /** The viewer's Needs-you cells, newest first. Reading starts each cell's 24-hour clock. */
  readNeedsYou: { input: WorkspaceInput; output: NeedsYouListResult };
  /** The tray badge count. Unlike `readNeedsYou`, it starts no clock. */
  countNeedsYou: { input: WorkspaceInput; output: NeedsYouCountResult };
  /** Tapped or dismissed: the cell leaves the viewer's tray on every device. */
  clearNeedsYou: { input: ClearNeedsYouInput; output: void };
  createRoomSchedule: { input: CreateRoomScheduleInput; output: RoomScheduleView };
  listRoomSchedules: { input: RoomInput; output: RoomScheduleListResult };
  deleteRoomSchedule: { input: DeleteRoomScheduleInput; output: void };
  /** The newest run of each agent workflow in a Room and its corners, live runs first. */
  listRoomWorkflowRuns: { input: RoomInput; output: WorkflowRunListResult };
  /** One run with its pinned contract and ordered handoff history, for the run page's graph. */
  readWorkflowRun: { input: ReadWorkflowRunInput; output: WorkflowRunDetailView };
  cancelAgentTurn: { input: CancelAgentTurnInput; output: void };
  createHumanCorner: { input: CreateHumanCornerInput; output: IdResult };
  requestCornerClose: { input: RoomInput; output: void };
  decideWritePermission: { input: DecideWritePermissionInput; output: MessageWriteResult };
  decideAgentGrant: { input: DecideAgentGrantInput; output: AgentGrantDecisionResult };
  revokeAgentGrant: { input: RevokeAgentGrantInput; output: AgentGrantDecisionResult };
  /** Starts the offered connector's full sign-in ceremony on the offering agent's machine. */
  acceptConnectorOffer: { input: AcceptConnectorOfferInput; output: AcceptConnectorOfferResult };
  createRoomPoll: { input: CreateRoomPollInput; output: CreateRoomPollResult };
  answerChoice: { input: AnswerChoiceInput; output: ChoiceDecisionResult };
  skipChoice: { input: SkipChoiceInput; output: ChoiceDecisionResult };
  createWorkspace: { input: NamedWorkspaceInput; output: CreateWorkspaceResult };
  updateWorkspace: { input: UpdateWorkspaceInput; output: void };
  leaveWorkspace: { input: WorkspaceInput; output: void };
  /** Owner-only: a real cascade delete of the workspace and everything in it.
   *  Idempotent: a second call on an already-deleted workspace resolves
   *  without effect. */
  deleteWorkspace: { input: WorkspaceInput; output: void };
  addWorkspaceMember: { input: WorkspaceMemberInput; output: MembershipResult };
  banWorkspaceMember: { input: RemoveWorkspaceMemberInput; output: void };
  unbanWorkspaceMember: { input: RemoveWorkspaceMemberInput; output: void };
  listWorkspaceBans: {
    input: WorkspaceInput & { readonly offset?: number };
    output: {
      readonly members: readonly {
        readonly pubkey: string;
        readonly name: string;
        readonly kind: 'human' | 'agent';
        readonly canLift: boolean;
      }[];
      readonly hasMore: boolean;
    };
  };
  removeWorkspaceMember: { input: RemoveWorkspaceMemberInput; output: void };
  createRoom: { input: CreateRoomInput; output: IdResult };
  updateRoom: { input: UpdateRoomInput; output: void };
  deleteRoom: { input: RoomInput; output: void };
  leaveRoom: { input: RoomInput & { readonly confirmDelete?: true }; output: void };
  closeChat: { input: RoomInput; output: void };
  reopenChat: { input: RoomInput; output: void };
  addRoomMember: { input: RoomMemberInput; output: MembershipResult };
  removeRoomMember: { input: RoomMemberInput; output: void };
  resolveDirectMessage: { input: ResolveDirectMessageInput; output: DirectMessageResult };
  createInvite: { input: WorkspaceInput; output: InviteTokenResult };
  resolveInvite: { input: InviteTokenInput; output: InviteView };
  redeemInvite: { input: InviteTokenInput; output: InviteMembershipResult };
  createAgentPairingCode: { input: WorkspaceInput; output: PairingCodeResult };
  claimAgentPairing: { input: PairingCodeInput; output: AgentPairingClaimView };
  updateAgentSoul: { input: UpdateAgentSoulInput; output: void };
  updateAgentModelSelection: { input: UpdateAgentModelInput; output: void };
  refreshAgentModelCatalog: { input: WorkspaceAgentInput; output: void };
  updateAgentYolo: { input: UpdateAgentYoloInput; output: void };
  updateAgentAccessPolicy: { input: UpdateAgentAccessPolicyInput; output: void };
  removeAgent: { input: WorkspaceAgentInput; output: void };
  updatePersonProfile: { input: UpdatePersonProfileInput; output: PersonProfileResult };
  updateIdentityFace: { input: UpdateIdentityFaceInput; output: void };
  updateIdentityPushLevel: { input: UpdateIdentityPushLevelInput; output: ManagedIdentityResult };
  setRoomRepository: { input: SetRoomRepositoryInput; output: RoomRepositoryResult };
  setRoomTargetBranch: { input: SetRoomTargetBranchInput; output: RoomRepositoryResult };
  setRoomGitHubEvents: { input: SetRoomGitHubEventsInput; output: RoomRepositoryResult };
  /** Sever the Room→repository binding; the Room becomes chat-only. Idempotent. */
  removeRoomRepository: { input: RoomInput; output: void };
  listRoomWorkflows: { input: RoomInput; output: RoomWorkflowListResult };
  dispatchRoomWorkflow: { input: DispatchRoomWorkflowInput; output: void };
  approveCornerMerge: { input: ApproveCornerMergeInput; output: ApproveCornerMergeResult };
  getAuthCapabilities: { input: EmptyInput; output: AuthCapabilitiesResult };
  beginGitHubIdentityBind: { input: BeginBrowserAuthInput; output: BrowserAuthStartResult };
  completeGitHubIdentityBind: { input: CompleteBrowserAuthInput; output: IdentityBindResult };
  recoverGitHubIdentity: { input: CompleteBrowserAuthInput; output: IdentityBindResult };
  getIdentityRecovery: { input: EmptyInput; output: IdentityRecoveryResult };
  getManagedIdentity: { input: EmptyInput; output: ManagedIdentityResult };
  adoptGitHubHandle: { input: EmptyInput; output: ManagedIdentityResult };
  claimManagedHandle: { input: ClaimManagedHandleInput; output: ManagedIdentityResult };
  listGitHubRepositories: { input: RefreshInput; output: GitHubRepositoryListResult };
  beginGitHubInstallation: { input: BeginGitHubInstallationInput; output: BrowserAuthStartResult };
  createGitHubRepository: { input: CreateGitHubRepositoryInput; output: GitHubRepositoryResult };
  getGitHubRepositoryAccess: {
    input: GitHubRepositoryAccessInput;
    output: GitHubRepositoryAccessResult;
  };
  uploadMedia: { input: UploadMediaInput; output: AttachmentReference };
  registerPushDevice: { input: PushDeviceInput; output: PushRegistrationResult };
  unregisterPushDevice: { input: PushDeviceInput; output: void };
  readWebPushKey: { input: EmptyInput; output: { publicKey: string | null } };
  sendPushTest: { input: EmptyInput; output: void };
  /** Erases the signed-in account and its personal data. Idempotent: a second
   *  call resolves without effect once the identity row is gone. */
  deleteAccount: { input: EmptyInput; output: void };
  reportRunningUpdate: { input: RunningUpdateInput; output: void };
  readWorkbench: { input: ReadWorkbenchInput; output: WorkbenchView };
  pairConnector: { input: PairConnectorInput; output: PairConnectorResult };
  cancelGoogleSignIn: { input: CancelGoogleSignInInput; output: { cancelled: boolean } };
  beginGoogleSignIn: { input: { connectorType: 'google-gmail' | 'google-calendar' | 'google-drive' | 'google-youtube' };
    output: { authorizationUrl: string } };
  readGoogleSignIn: { input: EmptyInput; output: {
    connected: boolean; connectedTypes?: string[]; authorizationUrl?: string;
  } };
  disconnectGoogleSignIn: { input: EmptyInput; output: void };
  beginLinkSignIn: { input: EmptyInput; output: { authorizationUrl: string } };
  cancelLinkSignIn: { input: { state?: string }; output: void };
  disconnectLinkSignIn: { input: EmptyInput; output: void };
  unpairConnector: { input: UnpairConnectorInput; output: void };
  /** The one front door for connecting an app from the Workbench. */
  connectWorkbenchApp: { input: ConnectWorkbenchAppInput; output: ConnectWorkbenchAppResult };
  beginAppSignIn: { input: BeginAppSignInInput; output: BeginAppSignInResult };
  completeAppSignIn: { input: CompleteAppSignInInput; output: CompleteAppSignInResult };
  /** Stop every route of one app and revoke its standing approvals. */
  disconnectWorkbenchApp: { input: DisconnectWorkbenchAppInput; output: void };
  readConnectionDetail: { input: ReadConnectionDetailInput; output: ConnectionDetailView };
  revokeConnectionGrants: {
    input: RevokeConnectionGrantsInput;
    output: RevokeConnectionGrantsResult;
  };
  /** One tap creates the wallet bound to the viewer's identity. */
  createWallet: { input: CreateWalletInput; output: WalletView };
  readWallet: { input: ReadWalletInput; output: WalletView };
  sendFromWallet: { input: SendFromWalletInput; output: WalletSendOutcome };
  grantWalletDelegation: { input: GrantWalletDelegationInput; output: GrantWalletDelegationResult };
  /** The viewer's own wallet transaction history (oldest first, as stored). */
  readWalletHistory: { input: ReadWalletHistoryInput; output: WalletHistoryResult };
};

export type WelcomeCardsView = { readonly due: boolean };

export type StarPrompt = {
  /** The completed-reply milestone (3, 30 or 300) this card answers. */
  readonly milestone: number;
  /** `owner/repo` on GitHub. */
  readonly repository: string;
  readonly url: string;
};
export type StarPromptView = { readonly prompt: StarPrompt | null };
export type StarPromptAction = 'star' | 'later' | 'dismiss';
export type AnswerStarPromptInput = { action: StarPromptAction; milestone: number };
/**
 * `starred`: GitHub starred the repository with the viewer's token.
 * `open`: the token cannot star (no Starring permission yet), so the app opens `url`.
 */
export type AnswerStarPromptResult = {
  readonly outcome: 'starred' | 'open' | 'later' | 'dismissed';
  readonly url?: string;
};

export type {
  CreateWalletInput,
  ReadWalletHistoryInput,
  ReadWalletInput,
  SendFromWalletInput,
  WalletHistoryResult,
  WalletSendOutcome,
  WalletView,
} from './wallet.js';

export type EmptyInput = Record<string, never>;
export type WorkspaceInput = { readonly workspaceId: string };
export type RoomInput = { readonly roomId: string };
export type RoomWorkflowView = {
  readonly name: string;
  /** Absolute Unix timestamp in seconds. Omitted when this workflow has never run. */
  readonly lastRunAt?: number;
  readonly conclusion?: string;
};
export type RoomWorkflowListResult = {
  readonly defaultBranch: string;
  readonly workflows: readonly RoomWorkflowView[];
};
export type DispatchRoomWorkflowInput = RoomInput & { readonly workflowName: string };
export type WorkspaceAgentInput = WorkspaceInput & { readonly agentId: string };
export type RoomMemberInput = RoomInput & { readonly memberId: string };
export type WorkspaceMemberInput = WorkspaceInput & {
  readonly memberId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'spectator';
};
/** A manager removes a person from the Workspace and every live Room in it; agents use removeAgent. */
export type RemoveWorkspaceMemberInput = WorkspaceInput & { readonly memberId: string };
export type NamedWorkspaceInput = { readonly name: string; readonly workspaceId?: string };
export type IdResult = { readonly id: string };
/** A new Workspace and the public `#general` Room created with it. */
export type CreateWorkspaceResult = IdResult & { readonly roomId?: string };
export type MembershipResult = { readonly joined: boolean };
export type InviteMembershipResult = MembershipResult & {
  readonly workspaceId: string;
  /** The first live top-level Room the viewer can open after joining. */
  readonly roomId?: string;
};
export type MessageWriteResult = { readonly messageId: string };
/** Active turns that received a server-created command with this human message. */
export type AgentMessageWriteResult = MessageWriteResult & {
  /** Optional so a newer phone remains compatible during a rolling server deploy. */
  readonly activeSteerAgentIds?: readonly string[];
};
export type RoomScheduleCadence =
  | { readonly kind: 'cron'; readonly expression: string; readonly timeZone?: string }
  | { readonly kind: 'interval'; readonly everyMinutes: number; readonly startsAt?: number };
export type RoomScheduleView = {
  readonly id: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly creatorId: string;
  readonly cadence: RoomScheduleCadence;
  readonly message: string;
  readonly nextRunAt: number;
  readonly createdAt: number;
  /** Present when the schedule runs in a child corner of the Room being listed. */
  readonly corner?: { readonly id: string; readonly name: string };
};
export type CreateRoomScheduleInput = RoomInput & {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly cadence: RoomScheduleCadence;
  readonly message: string;
};
export type RoomScheduleListResult = { readonly schedules: readonly RoomScheduleView[] };
export type DeleteRoomScheduleInput = RoomInput & { readonly scheduleId: string };
/** Who holds a workflow role, or who wrote a handoff card. */
export type WorkflowActorView = {
  readonly id: string;
  readonly name: string;
  readonly kind: 'human' | 'agent';
};
/** `live` until the run reaches a terminal state, then that terminal's status. */
export type WorkflowRunStatus = 'live' | WorkflowTerminalState['status'];
export type WorkflowRunSummaryView = {
  /** The `start_workflow` message id (a corner's own lifecycle run uses the corner id). */
  readonly runId: string;
  readonly workflowSlug: string;
  readonly description: string;
  /** The Room or corner the run's cards are written in. */
  readonly roomId: string;
  readonly roomName: string;
  /** Set when the run lives in a corner: that corner's parent Room. */
  readonly parentRoomId?: string;
  /** The run's current state (its terminal state once it has ended). */
  readonly state: string;
  readonly status: WorkflowRunStatus;
  /**
   * Whoever holds the current state's role. An ended run names the role that
   * handed it to the terminal, or that card's author when the state it left
   * has no role. Absent for a live server or waiting state.
   */
  readonly holder?: WorkflowActorView;
  /** True when the current state waits on the viewer: their role, or a gate a person answers. */
  readonly viewerHolds: boolean;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** Runs of the same workflow in the same Room and its corners that started before this one. */
  readonly earlierRunCount: number;
};
export type WorkflowRunListResult = { readonly workflows: readonly WorkflowRunSummaryView[] };
export type ReadWorkflowRunInput = RoomInput & { readonly runId: string };
/** One `workflow-handoff` card. The first has only `toState` (the run's start). */
export type WorkflowRunStepView = {
  readonly fromState?: string;
  readonly outcome?: string;
  readonly toState: string;
  readonly status?: WorkflowTerminalState['status'];
  readonly actor?: WorkflowActorView;
  readonly at: number;
};
export type WorkflowRunDetailView = {
  readonly run: WorkflowRunSummaryView;
  /** The contract version the run is pinned to. */
  readonly contract: WorkflowContract;
  readonly history: readonly WorkflowRunStepView[];
  /** The run's role holders as of its newest card, by role name. */
  readonly roleHolders: Readonly<Record<string, WorkflowActorView>>;
};
export type SendRoomMessageInput = RoomInput & {
  /** Client-generated retry/optimistic identity. Random 32-byte hex. */
  readonly messageId?: string;
  readonly text: string;
  readonly mentions?: readonly string[];
  readonly attachments?: readonly AttachmentReference[];
};
export type SendRoomReplyInput = SendRoomMessageInput & { readonly parentMessageId: string };
export type ReactToMessageInput = RoomInput & {
  readonly messageId: string;
  readonly emoji: MessageReactionEmoji;
};
export type DeleteRoomMessageInput = RoomInput & { readonly messageId: string };
export type SetMessageBookmarkInput = RoomInput & {
  readonly messageId: string;
  readonly bookmarked: boolean;
};
export type SetMessageBookmarkResult = { readonly bookmarked: boolean };
export type ReportMessageIssueInput = RoomInput & {
  readonly messageId: string;
  /** Optional words from the reporter; secret-shaped values are refused. */
  readonly note?: string;
};
/** `duplicate` is true when this message was already reported. */
export type ReportMessageIssueResult = { readonly itemId: string; readonly duplicate: boolean };
export type MessageBookmarkListResult = { readonly bookmarks: readonly MessageBookmarkView[] };
export type NeedsYouListResult = { readonly items: readonly NeedsYouItemView[] };
export type NeedsYouCountResult = { readonly count: number };
export type ClearNeedsYouInput = WorkspaceInput & { readonly messageId: string };
/**
 * Stop one turn in progress.
 *
 * Named by the turn's own coordinates — the Room, the request the turn answers,
 * and the agent running it — never by "whatever is running here", so a stop
 * pressed as one turn ends can never land on the next one. Only the person who
 * asked may send it: withdrawing a question is the asker's to do, and a Room
 * where anyone can silence anyone else's agent is a different feature.
 */
export type CancelAgentTurnInput = RoomInput & {
  readonly requestId: string;
  readonly agentId: string;
};
export type CreateHumanCornerInput = RoomInput & {
  readonly title: string;
  /** The phone generated `title`; the corner's agent is asked to rename it from the first steer. */
  readonly titleGenerated?: boolean;
  readonly appInstallationId?: string;
  /**
   * The parent-Room message this corner was opened from (the mobile
   * swipe-right forward). When it names a message in that Room, the server
   * writes one `corner-open` card carrying it, which the phone renders as the
   * marker beneath that message.
   */
  readonly sourceMessageId?: string;
};
export type DecideWritePermissionInput = RoomInput & {
  readonly permissionId: string;
  readonly requestId: string;
  readonly agentId: string;
  readonly decision: 'allow' | 'deny';
  readonly repository: string;
};
export type DecideAgentGrantInput = {
  readonly grantId: string;
  readonly decision: AgentGrantDecision;
};
export type RevokeAgentGrantInput = { readonly grantId: string };
export type AgentGrantDecisionResult = {
  readonly grantId: string;
  readonly status: AgentGrantStatus;
  /** The Room the grant's card lives in, so the server can invalidate it. */
  readonly roomId: string;
};
export type AcceptConnectorOfferInput = { readonly offerId: string };
export type AcceptConnectorOfferResult = {
  readonly offerId: string;
  /** The offer settles only after the helper reports the connector connected. */
  readonly status: 'connecting';
  readonly roomId: string;
  /** The Workbench connector row the acceptance created or re-armed. */
  readonly connectorId: string;
  /** Google consent can open immediately without a helper ceremony. */
  readonly authorizationUrl?: string;
};
export type AnswerChoiceInput = {
  readonly choiceId: string;
  readonly optionId: string;
};
export type CreateRoomPollInput = RoomInput & {
  readonly prompt: string;
  readonly options: readonly ChoiceOptionInput[];
  readonly ttlSeconds: number;
};
export type CreateRoomPollResult = {
  readonly choiceId: string;
  readonly messageId: string;
  readonly roomId: string;
  readonly closesAt: number;
};
export type SkipChoiceInput = { readonly choiceId: string };
export type ChoiceDecisionResult = {
  readonly choiceId: string;
  readonly status: ChoiceStatus;
  readonly roomId: string;
};
export type UpdateWorkspaceInput = WorkspaceInput & {
  readonly name?: string;
  readonly avatar?: string;
  readonly visibility?: 'public' | 'invite-only';
};
export type CreateRoomInput = WorkspaceInput & {
  readonly name: string;
  readonly visibility?: 'public' | 'invite-only';
  /** Optional repository from listGitHubRepositories, bound atomically with Room creation. */
  readonly repositoryId?: number;
};
export type UpdateRoomInput = RoomInput & {
  readonly name?: string;
  readonly visibility?: 'public' | 'invite-only';
  /** Agent member assigned to review every repository corner in this Room; null clears. */
  readonly reviewerAgentId?: string | null;
  /**
   * Agent members tried in order after `reviewerAgentId` when it is unhealthy
   * or its review turn fails; `[]` clears. Cleared whenever `reviewerAgentId`
   * is cleared.
   */
  readonly reviewerFallbackIds?: readonly string[];
};
export type ResolveDirectMessageInput = WorkspaceInput & { readonly participantId: string };
export type DirectMessageResult = IdResult & { readonly created: boolean };
export type InviteTokenInput = { readonly token: string };
export type InviteTokenResult = InviteTokenInput & {
  /** Absolute Unix timestamp in seconds. */
  readonly expiresAt: number;
};
export type PairingCodeInput = { readonly code: string };
export type PairingCodeResult = PairingCodeInput & { readonly expiresAt: number };
export type UpdateAgentSoulInput = WorkspaceAgentInput & {
  readonly name: string;
  readonly instructions: string;
  readonly avatarSeed: string;
  readonly avatar?: string;
};
export type UpdateAgentModelInput = WorkspaceAgentInput &
  Omit<AgentModelSelection, 'effort'> & {
    readonly effort?: string | null;
    readonly fastMode?: boolean;
  };
export type UpdateAgentYoloInput = WorkspaceAgentInput & { readonly enabled: boolean };
/** The owner's answer to "who may address this agent" (`agent-access.ts`). */
export type UpdateAgentAccessPolicyInput = WorkspaceAgentInput & {
  readonly policy: AgentAccessPolicy;
  /** Required by `allowlist`, ignored otherwise. */
  readonly allow?: readonly string[];
};
export type UpdatePersonProfileInput = {
  readonly name?: string;
  readonly handle?: string;
  readonly avatar?: string;
};
/** One of `FACE_IDS`, or `null` to clear the chosen face. */
export type UpdateIdentityFaceInput = { readonly faceId: string | null };
export type UpdateIdentityPushLevelInput = { readonly pushLevel: PushLevel };
export type PersonProfileResult = {
  readonly personId: string;
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
};
export type SetRoomRepositoryInput = RoomInput & {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch: string;
  readonly githubInstallationId?: number;
};
export type SetRoomTargetBranchInput = RoomInput & { readonly targetBranch: string };
export type SetRoomGitHubEventsInput = RoomInput & { readonly enabled: boolean };
export type ApproveCornerMergeInput = {
  readonly cornerId: string;
  /** Managers may explicitly override a known failing check result. */
  readonly force?: boolean;
};
export type ApproveCornerMergeResult = {
  readonly status: 'merge-requested' | 'already-requested' | 'already-merged';
  readonly pullRequestUrl: string;
};
export type RoomRepositoryResult = {
  readonly channelId: string;
  readonly binding: {
    readonly key: string;
    readonly name: string;
    readonly remote: string;
    readonly localOnly: false;
    readonly githubInstallationId?: number;
  };
  readonly targetBranch: string;
  readonly updatedAt: number;
  readonly githubEventsEnabled: boolean;
  readonly source: 'config';
};
export type AuthCapabilitiesResult = { readonly github: boolean };
export type BeginBrowserAuthInput = { readonly redirectUri: string; readonly state: string };
export type BrowserAuthStartResult = { readonly url: string };
export type CompleteBrowserAuthInput = { readonly challenge: string; readonly proof: string };
export type IdentityBindResult = { readonly personId: string; readonly recovered: boolean };
export type IdentityRecoveryResult = {
  readonly candidates: readonly { readonly personId: string; readonly handle?: string }[];
};
export type ManagedIdentityResult = {
  readonly personId: string;
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
  readonly face?: string;
  readonly pushLevel: PushLevel;
};
export type ClaimManagedHandleInput = { readonly handle: string };
export type RefreshInput = { readonly refresh?: boolean };
export type GitHubRepository = {
  readonly id: number;
  readonly fullName: string;
  readonly installationId: number;
  readonly defaultBranch: string;
};
export type GitHubInstallation = {
  readonly installationId: number;
  readonly accountId: string;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly accountAvatarUrl?: string;
  readonly repositorySelection: 'all' | 'selected';
  readonly status: 'active' | 'revoked' | 'suspended';
  readonly repositoryCount: number;
  readonly manageUrl: string;
};
export type GitHubRepositoryListResult = {
  readonly installed: boolean;
  readonly installations: readonly GitHubInstallation[];
  readonly repositories: readonly GitHubRepository[];
  /** GitHub user token expired and could not be refreshed; stored data is served. */
  readonly githubReconnectNeeded?: boolean;
};
export type BeginGitHubInstallationInput = {
  readonly redirectUri: string;
  readonly installationId?: number;
};
export type CreateGitHubRepositoryInput = {
  readonly installationId: number;
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
};
export type GitHubRepositoryResult = GitHubRepository;
export type GitHubRepositoryAccessInput = { readonly fullName: string };
export type GitHubRepositoryAccessResult = {
  readonly accessible: boolean;
  readonly reason?: string;
};
export type UploadMediaInput = {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name?: string;
};
export type PushDeviceInput = {
  readonly token: string;
  readonly platform: 'android' | 'ios' | 'web';
  readonly environment: 'physical' | 'emulator';
  readonly keys?: { readonly p256dh: string; readonly auth: string };
};
export type PushRegistrationResult = { readonly accepted: boolean };
export type RunningUpdateInput = {
  readonly deviceId: string;
  readonly platform?: 'ios' | 'android' | 'macos' | 'windows' | 'linux';
  readonly updateId?: string;
  readonly channel?: string;
  readonly group?: string;
  readonly runtimeVersion?: string;
  readonly releaseVersion?: string;
  readonly sourceSha?: string;
};
