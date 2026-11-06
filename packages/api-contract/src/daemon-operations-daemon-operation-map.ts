import type { CommandActivationInput, CommandActivationSnapshot } from './helper-activation.js';
import type { OwnedModelCredential } from './helper-model.js';
import type { UsageAccountPublicationResult, UsageAccountReference, UsageWriteSource } from './helper-usage.js';
import type { RepositoryOnboardingCard } from './repository-onboarding.js';
import type { AgentUsage, UsageRefreshOutcome } from './agent-usage.js';
import type { RoomSubscriptionListResult, RoomSubscriptionView, SubscriptionSource, SubscriptionEventCatalog } from './subscriptions.js';
import type { AppTransport } from './app-connections.js';
import type { CornerHoldInput, CornerMergeHold } from './phone-operations.js';
import type { SystemEvent } from './system-events.js';
import type { ReportAgentSignInInput } from './agent-sign-in.js';
import type { WorkflowRoleBinding, WorkflowReceiptInput, WorkflowRunReadResult } from './workflow-contracts.js';
import type { DeleteInstitutionalMemoryInput, InstitutionalContextSnapshot, InstitutionalMemoryTurnStats, InstitutionalMemoryWriteResult, LoadWorkspaceSkillInput, LoadWorkspaceSkillResult, ReportInstitutionalMemoryUsedInput, ReportInstitutionalMemoryUsedResult, SaveInstitutionalMemoryInput, SearchInstitutionalHistoryInput, SearchInstitutionalHistoryResult, SearchInstitutionalMemoryInput, SearchInstitutionalMemoryResult, UpdateInstitutionalMemoryInput } from './institutional-memory.js';
import type { NotifyFeedbackFixedInput, NotifyFeedbackFixedResult, ReportFeedbackInput, ReportFeedbackResult } from './feedback.js';
import type { WalletPayInput, WalletContractCallInput, WalletSendOutcome, WalletSwapInput, WalletSwapResult, WalletToolBalanceInput, WalletToolBalanceResult, WalletToolChainsInput, WalletToolChainsResult, WalletToolHistoryInput, WalletToolHistoryResult, WalletToolQuoteInput, WalletToolQuoteResult, WalletToolState, WalletToolStateInput, WalletSignTypedDataInput, WalletSignTypedDataResult } from './wallet.js';
import { TurnOutputAuthority, AgentCommand, CommandClaimInput, StopAgentTurnResult, AgentReportStatus, CreateAgentScheduleInput, AgentScheduleResult, SetEventSubscriptionsInput, EventSubscriptionsResult, PostRoomEventInput, AgentScheduleListResult, DeleteAgentScheduleInput, UpdateAgentScheduleInput } from './daemon-operations.js';
import { WriteResult, DaemonBootstrapInput, DaemonBootstrapResult, WorkspaceRosterInput, WorkspaceRosterResult, RoomInboxResult, RoomConversationInput, RoomConversationResult, DaemonAttachment, RoomPrincipalInput, RoomAuthorityResult, PermissionAuthorityInput, AuthorityDecisionResult, MissionAuthorityInput, CornerWatchKind, CornerWatchResult, WorkScheduleAuthorityInput, AgentToolMandateResult, TargetAgentAuthorityInput, CornerListResult, CornerRestoreResult, CornerBrief, CornerCursorInput, RoomRepositoryStateResult, RoomGitHubTokenResult, RoomTargetBranchResult, IdentitySuccessionResult, AgentConfigurationResult, AgentPresenceResult, RequestCompletionResult, PostRoomMessageInput, PostRoomMessageResult, ReactToRoomMessageInput, PostAgentAttachmentInput, PostLiveOutputInput, RetractLiveOutputInput, PostTurnReceiptInput, PostAgentActivityInput, PostPermissionRequestInput, PostPermissionExecutionInput, PostAgentToolMandateInput, PostAgentCommandsInput, PostAgentModelCatalogInput, PostCornerRemoteStateInput, PostCornerPlanInput, CornerBriefDraft, PostTargetBranchProposalInput, SearchMcpRegistryInput, SearchMcpRegistryResult, ConnectMcpServerInput, ConnectMcpServerResult, ConnectAppInput, ConnectAppResult, ConnectInput, ConnectResult, ConnectorSearchMatch, CreateCornerInput } from './daemon-operations-room-conversation-window.js';
import { ReviseCornerBriefInput, PostSquireApprovalInput, PostSquireLoginWallInput, PostSquireLoginWallResult, PostSquireApprovalDecisionInput, RequestAgentGrantInput, RequestAgentGrantResult, AskRoomChoiceResult, AskRoomChoiceInput, OpenRoomPollInput, AgentGrantListResult, AgentGrantRequestListResult, ConsumeAgentGrantInput, AuthorizeSquireCallInput, AuthorizeSquireCallResult, AgentWorkbenchView, OfferConnectorInput, OfferConnectorResult, InstallConnectorInput, PostConnectorStatusInput, PostConnectorVaultInput, GetConnectorStatusInput, ConnectorStatus, ConnectorVaultListResult, ConnectionRefInput, ConnectionDetail, ConnectionGrantRevokeResult, PostConnectionUsageInput, ConnectorAssignmentsResult, CornerResult } from './daemon-operations-revise-corner-brief-input.js';



export type DaemonOperationMap = {
  postVaultSaveCard: Operation<RoomInput & TurnOutputAuthority & import('./vault-save.js').VaultSaveRequest, WriteResult>;
  getInstitutionalContext: Operation<RoomInput & TurnOutputAuthority, InstitutionalContextSnapshot>;
  saveInstitutionalMemory: Operation<SaveInstitutionalMemoryInput, InstitutionalMemoryWriteResult>;
  updateInstitutionalMemory: Operation<
    UpdateInstitutionalMemoryInput,
    InstitutionalMemoryWriteResult
  >;
  deleteInstitutionalMemory: Operation<
    DeleteInstitutionalMemoryInput,
    InstitutionalMemoryWriteResult
  >;
  reportInstitutionalMemoryUsed: Operation<
    ReportInstitutionalMemoryUsedInput,
    ReportInstitutionalMemoryUsedResult
  >;
  searchInstitutionalMemory: Operation<
    SearchInstitutionalMemoryInput,
    SearchInstitutionalMemoryResult
  >;
  /** Full-text history search constrained to the complete output audience. */
  searchInstitutionalHistory: Operation<
    SearchInstitutionalHistoryInput,
    SearchInstitutionalHistoryResult
  >;
  /** Best-effort read of this turn's search_memory call/miss counters, for
   *  the daemon's own turn trace; absent counters read as zero. */
  getInstitutionalMemoryTurnStats: Operation<
    RoomInput & AgentInput & TurnOutputAuthority,
    InstitutionalMemoryTurnStats
  >;
  /** Load one merge-derived restricted procedure after rechecking its source audience. */
  loadWorkspaceSkill: Operation<LoadWorkspaceSkillInput, LoadWorkspaceSkillResult>;
  /** Save a procedure directly from conversation: no corner, no merge review. */
  saveSkill: Operation<
    RoomInput &
      TurnOutputAuthority & {
        readonly slug: string;
        readonly description: string;
        readonly markdown: string;
      },
    { readonly slug: string; readonly version: number;
      readonly similarSkills: readonly { readonly slug: string; readonly description: string }[] }
  >;
  /** Soft-delete one procedure or workflow by slug at its current version. */
  deleteSkill: Operation<
    RoomInput &
      TurnOutputAuthority & {
        readonly slug: string;
        readonly version: number;
        readonly sourceMessageIds: readonly string[];
      },
    {
      readonly slug: string;
      readonly kind: 'procedure' | 'workflow';
      readonly version: number;
      readonly deleted: true;
    }
  >;
  /** Validate and save a workflow contract as a `workspace_skills` row of `kind='workflow'`. */
  saveWorkflow: Operation<
    RoomInput & TurnOutputAuthority & { readonly contract: unknown },
    { readonly slug: string; readonly version: number }
  >;
  /** Bind current Room members to a saved workflow's roles and start a run. */
  startWorkflow: Operation<
    RoomInput &
      TurnOutputAuthority & {
        readonly name: string;
        readonly roleBindings: Readonly<Record<string, WorkflowRoleBinding>>;
      },
    { readonly runId: string; readonly state: string }
  >;
  /** Read a saved run in this Room and its exact pinned contract. */
  getWorkflowRun: Operation<RoomInput & { readonly runId: string }, WorkflowRunReadResult>;
  /** Cancel on behalf of the active command's requester, after checking run authority. */
  cancelWorkflowRun: Operation<
    RoomInput & TurnOutputAuthority & { readonly runId: string; readonly reason: string },
    { readonly runId: string; readonly state: string; readonly status: 'abandoned'; readonly reason: string }
  >;
  /** Advance a run's current state; validated against its pinned contract. */
  handoff: Operation<
    RoomInput &
      TurnOutputAuthority & {
        readonly runId: string;
        readonly outcome: string;
        readonly contents: unknown;
        readonly receipt?: WorkflowReceiptInput;
        /** The attempt the caller's wake named; omitted, it is read from the command's own wake. */
        readonly attempt?: number;
      },
    | {
        readonly runId: string;
        readonly state: string;
        /** The attempt now current; the step's holder passes it to its own next handoff. */
        readonly attempt: number;
        readonly status?: 'done' | 'failed';
      }
    | {
        /** The step moved before this call; nothing changed. */
        readonly alreadyAdvanced: true;
        readonly runId: string;
        readonly state: string;
        readonly seq: number;
        readonly status?: 'done' | 'failed' | 'abandoned';
      }
  >;
  /** Retire a workflow; in-flight runs keep their pinned version. */
  archiveWorkflow: Operation<
    RoomInput & TurnOutputAuthority & { readonly name: string },
    { readonly slug: string; readonly archived: boolean }
  >;
  /**
   * A human's explicit override for a list-bound role this run is currently
   * on: binds any agent in the Room (no health filter), the "ask a human"
   * recovery when no agent on the role's list is healthy.
   */
  assignWorkflowRole: Operation<
    RoomInput &
      TurnOutputAuthority & {
        readonly runId: string;
        readonly role: string;
        /** The agent being bound to the role — distinct from the calling (asking) agent. */
        readonly targetAgentId: string;
      },
    { readonly runId: string; readonly state: string }
  >;
  getAgentCommands: Operation<
    RoomInput,
    { readonly commandProtocol: 1; readonly commands: readonly AgentCommand[] }
  >;
  claimAgentCommand: Operation<CommandClaimInput, WriteResult & { readonly modelCredential?: OwnedModelCredential; readonly recoveryContext?: string; readonly activitySource?: { readonly body: string; readonly systemEvent: SystemEvent } }>;
  claimAgentTurn: Operation<CommandClaimInput, WriteResult & { readonly commands: readonly AgentCommand[]; readonly modelCredential?: OwnedModelCredential; readonly recoveryContext?: string; readonly activitySource?: { readonly body: string; readonly systemEvent: SystemEvent } }>;
  acknowledgeAgentCommand: Operation<CommandClaimInput, WriteResult>;
  releaseAgentTurn: Operation<RoomInput & { readonly generationId: string }, WriteResult & { readonly commands: readonly AgentCommand[] }>;
  getDaemonBootstrap: Operation<DaemonBootstrapInput, DaemonBootstrapResult>;
  getWorkspaceRoster: Operation<WorkspaceRosterInput, WorkspaceRosterResult>;
  getOwedMentions: Operation<Record<string, never>, { readonly owedMentions: readonly { readonly roomId: string; readonly messageId: string; readonly memberId: string; readonly replyRule: string; readonly idempotencyKey: string }[] }>;
  getRoomInbox: Operation<RoomCursorInput, RoomInboxResult>;
  getRoomConversation: Operation<RoomConversationInput, RoomConversationResult>;
  /** One bounded page of an exact message in this Room or a source authorized for the active turn. */
  getRoomMessage: Operation<
    RoomInput & {
      readonly messageId: string;
      /** Resolve a visible file by object id; messageId may be empty for this lookup. */
      readonly attachmentId?: string;
      readonly offset?: number;
      readonly requestId?: string;
      readonly generationId?: string;
    },
    {
      readonly messageId: string;
      readonly body: string;
      readonly nextOffset?: number;
      readonly attachments: readonly DaemonAttachment[];
    }
  >;
  order: Operation<RoomInput & TurnOutputAuthority & { readonly address: string; readonly text: string; readonly agent?: string }, WriteResult>;
  stopAgentTurn: Operation<RoomInput & TurnOutputAuthority & { readonly address: string; readonly agent?: string }, StopAgentTurnResult>;
  report: Operation<RoomInput & TurnOutputAuthority & { readonly status: AgentReportStatus; readonly text: string; readonly ask?: string; readonly to?: string }, WriteResult>;
  read: Operation<RoomInput & { readonly address: string; readonly limit?: number }, RoomConversationResult>;
  getRoomAuthority: Operation<RoomPrincipalInput, RoomAuthorityResult>;
  getPermissionAuthority: Operation<PermissionAuthorityInput, AuthorityDecisionResult>;
  getMissionAuthority: Operation<MissionAuthorityInput, AuthorityDecisionResult>;
  createAgentSchedule: Operation<CreateAgentScheduleInput, AgentScheduleResult>;
  setEventSubscriptions: Operation<SetEventSubscriptionsInput, EventSubscriptionsResult>;
  createAgentSubscription: Operation<RoomInput & { source: SubscriptionSource; event: string; repository?: string;
    channelId?: string; channelName?: string; title?: string; when?: string; prompt: string; workflowName?: string }, RoomSubscriptionView>;
  listServiceSubscriptionEvents: Operation<RoomInput, SubscriptionEventCatalog>;
  listAgentSubscriptions: Operation<RoomInput, RoomSubscriptionListResult>;
  setAgentWakePaused: Operation<RoomInput & { scheduleId?: string; subscriptionId?: string; paused: boolean }, WriteResult>;
  deleteAgentSubscription: Operation<RoomInput & { subscriptionId: string }, WriteResult>;
  watchCorner: Operation<
    TurnOutputAuthority & RoomInput & { readonly cornerId: string; readonly kinds: readonly CornerWatchKind[] },
    CornerWatchResult
  >;
  listEventSubscriptions: Operation<RoomInput, EventSubscriptionsResult>;
  postRoomEvent: Operation<PostRoomEventInput, WriteResult>;
  listAgentSchedules: Operation<AgentRoomInput & { readonly selfOnly?: boolean }, AgentScheduleListResult>;
  listAgentWatches: Operation<RoomInput, { readonly watches: readonly { readonly address: string; readonly kinds: readonly CornerWatchKind[] }[] }>;
  deleteAgentSchedule: Operation<DeleteAgentScheduleInput, WriteResult>;
  updateAgentSchedule: Operation<UpdateAgentScheduleInput, AgentScheduleResult>;
  getWorkScheduleAuthority: Operation<WorkScheduleAuthorityInput, AuthorityDecisionResult>;
  getAgentToolMandate: Operation<AgentRoomInput, AgentToolMandateResult>;
  getTargetAgentAuthority: Operation<TargetAgentAuthorityInput, AuthorityDecisionResult>;
  listRoomCorners: Operation<RoomInput & { activeOnly?: boolean }, CornerListResult>;
  getCornerRestoreState: Operation<CornerInput, CornerRestoreResult>;
  listCornerBriefRevisions: Operation<
    CornerInput & {
      readonly beforeRevision?: number;
      /** Return only revisions newer than the prompt's current assignment. */
      readonly afterRevision?: number;
      readonly limit?: number;
    },
    {
      readonly revisions: readonly CornerBrief[];
      readonly nextBeforeRevision?: number;
    }
  >;
  reviseCornerBrief: Operation<
    ReviseCornerBriefInput,
    CornerBrief & { readonly warnings?: readonly string[]; readonly wake: { readonly queued: boolean; readonly agentId?: string; readonly reason?: string } }
  >;
  getPrChecksStatus: Operation<
    CornerInput & { pullRequest?: number | string },
    {
      /** Where the corner stands, from live facts: building -> checking -> waiting for a yes -> merged (or closed). */
      stage: 'building' | 'checking' | 'waiting_for_yes' | 'merged' | 'closed';
      checks: 'passed' | 'failed' | 'pending';
      /** Number of check-run and commit-status contexts GitHub reports for the current head. */
      checkCount: number;
      /**
       * Per-state counts and names from the same rollup that decides `checks`.
       * `unlisted` counts contexts beyond the rollup's first page; names list at
       * most 10 entries each, so a longer list is cut short.
       */
      checkStates: {
        passed: number;
        pending: number;
        failed: number;
        unlisted: number;
        pendingNames: string[];
        failedNames: string[];
      };
      pullRequest: string;
      headSha: string;
      /** A yes said on this exact head: a configured reviewer agent's PASS, or a Workspace owner or admin. */
      approved: boolean;
      /** The parent Room's currently-configured reviewer, as `@handle`, or null when none is configured. */
      reviewer: string | null;
      /** True when the parent Room has a configured reviewer, even if that identity has no handle. */
      reviewerExists: boolean;
      /**
       * Whether the configured reviewer was or can be woken for this corner's
       * current check state. Distinguishes "no reviewer" from "configured but
       * not a current parent-Room member", and pending checks from a dispatch.
       */
      reviewerWake: {
        status: 'unconfigured' | 'unreachable' | 'waiting' | 'dispatched';
        detail: string;
      };
      /** True when a person in the corner asked to hold the merge. The only veto. */
      held: boolean;
      holds: CornerMergeHold[];
      /** The merge gate: checks passed, `approved`, and not `held`. */
      mergeAllowed: boolean;
      blockedReason?: string;
    }
  >;
  approveCornerMerge: Operation<
    CornerInput & { readonly headSha: string },
    {
      readonly status: 'approved';
      readonly pullRequestNumber: number;
      readonly headSha: string;
    }
  >;
  /**
   * The corner implementer starts the squash-merge of its own pull request's
   * current head. The server merges only when `getPrChecksStatus` reports
   * `mergeAllowed`; otherwise nothing is attempted and `blocker` names why.
   */
  mergeCorner: Operation<
    CornerInput,
    | { readonly status: 'merge-started' | 'queued'; readonly headSha: string }
    | { readonly status: 'blocked'; readonly blocker: string; readonly holds?: CornerMergeHold[] }
  >;
  /**
   * Any corner member closes the corner's own pull request without merging.
   * The branch stays on GitHub and the corner stays open with no PR.
   */
  closeCornerPullRequest: Operation<
    CornerInput,
    | { readonly status: 'closed'; readonly pullRequestNumber: number; readonly url: string }
    | { readonly status: 'blocked'; readonly blocker: string }
  >;
  /** Current member address discovery across Rooms, corners and DMs. */
  listRooms: Operation<RoomInput, { readonly rooms: readonly { readonly roomId: string; readonly name: string; readonly parentRoomId?: string; readonly directMessage: boolean }[] }>;
  /** Every corner, open and closed, under a member Room; across member Rooms from a DM. */
  listReachableCorners: Operation<RoomInput & { activeOnly?: boolean }, CornerListResult>;
  /** Current members of a Room the caller is in, or of a corner it reaches. */
  listRoomMembers: Operation<RoomInput, RoomMemberListResult>;
  /** A reachable corner's pull request: changed files, reviews and comments. */
  readCornerPullRequest: Operation<CornerInput, CornerPullRequestResult>;
  /** A plain message into a reachable corner, from the caller's active turn. */
  postCornerMessage: Operation<
    CornerInput & RoomInput & TurnOutputAuthority & { readonly text: string; readonly replyTo?: string },
    {
      readonly id: string;
      readonly createdAt: number;
      readonly stored: true;
      readonly visible: true;
      readonly receipt: string;
      readonly effect: 'conversation';
      readonly address: string;
      readonly visibility: 'public';
      readonly reportsAssignment: false;
      readonly woken: readonly string[];
      readonly notWoken: readonly { readonly handle: string; readonly reason: string }[];
    }
  >;
  getCornerCloseRequests: Operation<CornerCursorInput, RoomInboxResult>;
  listUntrackedCorners: Operation<RoomInput, CornerListResult>;
  getRoomRepositoryState: Operation<RoomInput, RoomRepositoryStateResult>;
  noteEmptyRoomRepository: Operation<RoomInput, WriteResult>;
  getRoomGitHubToken: Operation<RoomInput, RoomGitHubTokenResult>;
  dispatchRoomWorkflow: Operation<RoomInput & TurnOutputAuthority & {
    readonly requestId: string;
    readonly inputs?: Readonly<Record<string, string>>;
  }, { readonly auditMessageId: string }>;
  getRoomTargetBranch: Operation<RoomInput, RoomTargetBranchResult>;
  getIdentitySuccession: Operation<IdentityInput, IdentitySuccessionResult>;
  getAgentConfiguration: Operation<AgentConfigurationInput, AgentConfigurationResult>;
  getAgentPresence: Operation<AgentRoomInput, AgentPresenceResult>;
  getRequestCompletion: Operation<RequestInput, RequestCompletionResult>;
  postRoomMessage: Operation<PostRoomMessageInput, PostRoomMessageResult>;
  reactToRoomMessage: Operation<ReactToRoomMessageInput, WriteResult>;
  postAgentAttachment: Operation<PostAgentAttachmentInput, WriteResult>;
  postAgentDraft: Operation<PostLiveOutputInput, WriteResult>;
  postAgentThought: Operation<PostLiveOutputInput, WriteResult>;
  retractAgentLiveOutput: Operation<RetractLiveOutputInput, WriteResult>;
  markAgentTurnSilent: Operation<RoomInput & TurnOutputAuthority & { readonly messageId?: string }, WriteResult>;
  postAgentTurnReceipt: Operation<PostTurnReceiptInput, WriteResult>;
  postAgentActivity: Operation<PostAgentActivityInput, WriteResult>;
  /** Push a continuation when a tool from this command finishes after its prompt ended. */
  postBackgroundToolCompletion: Operation<TurnOutputAuthority & RoomInput & {
    readonly toolCallId: string;
    readonly title: string;
    readonly status: 'completed' | 'failed';
  }, WriteResult>;
  /** Relay a Squire-owned approval page into the agent owner's private
   * Trusty Squire DM. Beeline never settles the approval itself. */
  postSquireApproval: Operation<PostSquireApprovalInput, WriteResult>;
  /** Publish or end an existing Squire operate browser in this Room. */
  postComputerSession: Operation<TurnOutputAuthority & RoomInput & {
    readonly sessionId: string;
    readonly upstreamUrl: string;
    readonly title?: string;
    /** Epoch milliseconds when the upstream share link stops working. */
    readonly expiresAt?: number;
  }, { readonly id: string; readonly url: string; readonly messageId: string; readonly beelineUrl: string }>;
  endComputerSession: Operation<RoomInput & {
    readonly sessionId: string;
  }, WriteResult>;
  /** Keep an owned live share's upstream lease current between model turns. */
  refreshComputerSession: Operation<RoomInput & {
    readonly sessionId: string;
    readonly upstreamUrl: string;
    readonly expiresAt: number;
  }, { readonly live: boolean }>;
  /** A Squire in-task result named a stale/logged-out provider session
   * (`needs_user.wall === 'google_session'`); a reconnect card goes to the
   * SAME Room carrying Squire's own hosted sign-in page, and the paused
   * turn resumes once the helper reports the reconnect ceremony connected. */
  postSquireLoginWall: Operation<PostSquireLoginWallInput, PostSquireLoginWallResult>;
  /** Relay Squire's own decision on a pending approval; resumes the turn
   * that asked, the same way grant-decided resumes a grant. */
  postSquireApprovalDecision: Operation<PostSquireApprovalDecisionInput, WriteResult>;
  postPermissionRequest: Operation<PostPermissionRequestInput, WriteResult>;
  postPermissionExecution: Operation<PostPermissionExecutionInput, WriteResult>;
  postAgentToolMandate: Operation<PostAgentToolMandateInput, WriteResult>;
  getAgentAvatar: Operation<RoomInput, { readonly drawing: unknown; readonly soul: unknown }>;
  postAgentAvatar: Operation<RoomInput & { readonly drawing: unknown }, WriteResult>;
  postAgentUsage: Operation<AgentInput & { readonly usage: AgentUsage; readonly usageSource?:UsageWriteSource }, WriteResult>;
  readCommandActivation: Operation<CommandActivationInput, CommandActivationSnapshot>;
  publishAgentUsageAccount: Operation<AgentInput & { readonly usage: AgentUsage; readonly revision: string; readonly ownerId: string; readonly source: { readonly connectionId: string; readonly epoch: number } }, WriteResult & UsageAccountPublicationResult>;
  attachAgentUsageAccount: Operation<AgentInput & UsageAccountReference & { readonly source: { readonly connectionId: string; readonly epoch: number } }, WriteResult>;
  getAgentUsage: Operation<AgentInput, AgentUsage | null>;
  /** The helper's answer to one owner-requested usage refresh. */
  answerUsageRefresh: Operation<
    AgentInput & { readonly requestId: string; readonly outcome: UsageRefreshOutcome },
    void
  >;
  postAgentCommands: Operation<PostAgentCommandsInput, WriteResult>;
  postAgentModelCatalog: Operation<PostAgentModelCatalogInput, WriteResult>;
  postAgentMachineReport: Operation<
    { readonly machineId: string; readonly machineName: string },
    WriteResult
  >;
  postCornerRemoteState: Operation<PostCornerRemoteStateInput, WriteResult>;
  postCornerPlan: Operation<PostCornerPlanInput, WriteResult>;
  /** Retitles a corner and optionally updates its goal. A human-opened corner may receive its first brief in the same write. */
  renameCorner: Operation<
    TurnOutputAuthority & CornerInput & {
      readonly roomId?: string;
      readonly name?: string;
      readonly reviewer?: string;
      readonly objective?: string;
      readonly brief?: CornerBriefDraft;
    },
    { readonly cornerId: string; readonly name: string }
  >;
  postTargetBranchProposal: Operation<PostTargetBranchProposalInput, WriteResult>;
  requestAgentGrant: Operation<RequestAgentGrantInput, RequestAgentGrantResult>;
  postStarterVideoPreview: Operation<RoomInput & { readonly videoObjectId: string; readonly frameObjectId: string; readonly title: string; readonly description: string; readonly visibility: 'public' | 'unlisted' | 'private' }, AskRoomChoiceResult>;
  postStarterWelcome: Operation<RoomInput, { readonly status: 'started' }>;
  postRoomInvite: Operation<RoomInput, { readonly url: string; readonly message: string; readonly messageId: string }>;
  postRepositoryOnboarding: Operation<RoomInput & { readonly kind: 'repository' | 'starters' }, RepositoryOnboardingCard>;
  askRoomChoice: Operation<AskRoomChoiceInput, AskRoomChoiceResult>;
  openRoomPoll: Operation<OpenRoomPollInput, AskRoomChoiceResult>;
  listAgentGrants: Operation<AgentInput & { readonly roomId?: string }, AgentGrantListResult>;
  /**
   * The inspect surface behind the agent's `list_grants` tool: every grant this
   * agent raised — pending, approved, and once — with reason and age, plus the
   * implementer's grants when called by that corner's reviewer. The run
   * gate (`listTurnAgentGrants`) keeps its approved-only view; this operation
   * never authorizes anything.
   */
  listAgentGrantRequests: Operation<
    AgentInput & { readonly roomId?: string },
    AgentGrantRequestListResult
  >;
  consumeAgentGrant: Operation<ConsumeAgentGrantInput, WriteResult>;
  /**
   * Per-call Squire gate: an agent may use its owner's connected Squire
   * regardless of the root requester or yolo setting.
   */
  authorizeSquireCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  /**
   * Per-call personal-resource gate. A Registry route that belongs to a
   * connected app is authorized as `app:<key>` and recorded in that app's
   * usage ledger.
   */
  authorizeResourceCall: Operation<
    AuthorizeSquireCallInput & {
      readonly target: string;
      readonly consume?: boolean;
      /** The MCP tool (or method) being called, for the usage ledger. */
      readonly operation?: string;
    },
    AuthorizeSquireCallResult
  >;
  /** Older helpers call these before each corner turn; both are allow-only compatibility routes. */
  authorizeRepositoryCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  authorizeHostCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  listTurnAgentGrants: Operation<AuthorizeSquireCallInput, AgentGrantListResult>;
  /** R5: what the Workbench can add, and what the person this turn answers already has. */
  readAgentWorkbench: Operation<RoomInput, AgentWorkbenchView>;
  /** Search the official MCP Registry. This changes no state. */
  searchMcpRegistry: Operation<SearchMcpRegistryInput, SearchMcpRegistryResult>;
  /** Connect an exact, freshly fetched Registry server on this helper. */
  connectMcpServer: Operation<ConnectMcpServerInput, ConnectMcpServerResult>;
  /** The one front door: connect an app by the route the server resolves. */
  connectApp: Operation<ConnectAppInput, ConnectAppResult>;
  connect: Operation<ConnectInput, ConnectResult>;
  findConnectors: Operation<RoomInput & { readonly query: string }, {
    readonly matches: readonly ConnectorSearchMatch[]; readonly unavailableSources: readonly string[];
  }>;
  /** Discover tools or route guidance for a connected app; only credential metadata is returned. */
  listAppTools: Operation<TurnOutputAuthority & AgentInput & RoomInput & { readonly appId: string;
    readonly query?: string }, { readonly tools: readonly {
      readonly slug: string; readonly name: string; readonly description: string;
      readonly inputParameters?: unknown;
    }[];
    readonly transport?: AppTransport;
    readonly next?: string;
    readonly service?: string;
    readonly credentials?: readonly {
      readonly reference: string; readonly allowedHosts: readonly string[];
    }[];
  }>;
  /** Execute against the exact person's account after a fresh per-call permission decision. */
  executeAppTool: Operation<TurnOutputAuthority & AgentInput & RoomInput & { readonly appId: string;
    readonly tool: string; readonly arguments: Record<string, unknown> },
    | { readonly status: 'executed'; readonly data: unknown }
    | { readonly status: 'needs_permission'; readonly grantId: string }
    | { readonly status: 'needs_connection' }>;
  /** R5: the agent offers to add one connector; a card goes to the Room and the turn pauses on it. */
  offerConnector: Operation<OfferConnectorInput, OfferConnectorResult>;
  installConnector: Operation<InstallConnectorInput, WriteResult>;
  postConnectorStatus: Operation<PostConnectorStatusInput, WriteResult>;
  postConnectorVault: Operation<PostConnectorVaultInput, WriteResult>;
  /**
   * A Squire page showed sign-in controls: drop the agent's recorded sign-in
   * for its site and for the site the session was sent to (`siteUrl`).
   */
  forgetSquireSignIn: Operation<{ readonly url: string; readonly siteUrl?: string }, WriteResult>;
  getConnectorStatus: Operation<GetConnectorStatusInput, ConnectorStatus>;
  getConnectorVaultList: Operation<AgentInput, ConnectorVaultListResult>;
  getConnectionDetail: Operation<AgentInput & ConnectionRefInput, ConnectionDetail>;
  revokeConnectionGrants: Operation<AgentInput & ConnectionRefInput, ConnectionGrantRevokeResult>;
  postConnectionUsage: Operation<PostConnectionUsageInput, WriteResult>;
  getConnectorAssignments: Operation<AgentInput, ConnectorAssignmentsResult>;
  completeProviderWebhookAssignment: Operation<AgentInput & {
    readonly id: string;
    readonly operation: 'register' | 'remove';
    readonly providerId?: string;
    readonly signingSecret?: string;
    readonly accountContext?: string;
    readonly livemode?: boolean;
    readonly error?: string;
  }, WriteResult>;
  /** The helper's answer to one Sign in to Claude step: the authorize link or the verdict. */
  reportAgentSignIn: Operation<ReportAgentSignInInput, void>;
  getGoogleOAuthGrant: Operation<
    AgentInput & { readonly connectorId: string },
    {
      readonly status: 'pending' | 'ready';
      readonly credentials?: {
        readonly accessToken: string;
        readonly expiresAt: number;
        readonly accountEmail?: string;
        readonly scopes: readonly string[];
      };
    }
  >;
  createLinkSpendRequest: Operation<AgentRoomInput & {
    merchant: string; merchantUrl?: string; amount: number; description: string;
    test?: boolean; idempotencyKey: string;
    credentialType?: 'card' | 'shared_payment_token'; networkId?: string;
  }, { id: string; status: string; approvalUrl?: string }>;
  retrieveLinkSpendRequest: Operation<AgentRoomInput & { id: string }, {
    id: string; status: string; approvalUrl?: string;
    nextAction?: { resolution?: string; displayMessage?: string; actionUrl?: string };
    card?: { number: string; cvc?: string; expMonth: number; expYear: number;
      billingAddress?: { name?: string; postalCode?: string; line1?: string; city?: string;
        state?: string; country?: string }; validUntil?: string };
    sharedPaymentToken?: { id: string; validUntil?: string };
  }>;
  /** A connected Google grant for this agent's current Room, renewed server-side. */
  getRoomGoogleGrant: Operation<RoomInput, {
    readonly status: 'pending' | 'ready';
    readonly connectedTypes?: readonly string[];
    /** A legacy helper connection and the owner's direct connection can coexist. */
    readonly credentialsByType?: Readonly<Record<string, {
      readonly accessToken: string;
      readonly expiresAt: number;
      readonly scopes: readonly string[];
    }>>;
    readonly credentials?: {
      readonly accessToken: string;
      readonly expiresAt: number;
      readonly scopes: readonly string[];
    };
  }>;
  beginRegistryMcpOAuth: Operation<
    AgentInput & { readonly connectorId: string },
    { readonly state: string; readonly redirectUri: string; readonly expiresAt: number }
  >;
  claimRegistryMcpOAuthCode: Operation<
    AgentInput & { readonly connectorId: string; readonly state: string },
    | { readonly status: 'pending'; readonly expiresAt: number }
    | { readonly status: 'expired' }
    | { readonly status: 'ready'; readonly code: string }
  >;
  createCorner: Operation<CreateCornerInput, CornerResult>;
  setCornerHold: Operation<
    CornerHoldInput & TurnOutputAuthority & RoomInput & { requestId: string },
    { holdId: string; roomId: string }
  >;
  /**
   * This turn's original human requester's yes on the current head. Only a
   * current Workspace owner or admin's yes is recorded; it is the same yes as
   * a reviewer's PASS, and the server merges at once when checks are green
   * and no hold stands.
   */
  sendOperatorSystemDm: Operation<
    AgentRoomInput & TurnOutputAuthority & { requestId: string; recipients: string | readonly string[]; text: string },
    { sendId: string; recipients: number; delivered: number; failed: number; pending: number }
  >;
  readOperatorSystemDm: Operation<
    AgentRoomInput & TurnOutputAuthority & { requestId: string; sendId: string },
    { sendId: string; recipients: number; delivered: number; failed: number; pending: number }
  >;
  orderCornerMerge: Operation<
    CornerInput & TurnOutputAuthority & RoomInput & { requestId: string },
    { roomId: string; headSha: string }
  >;
  archiveCorner: Operation<CornerInput & Partial<RoomInput & TurnOutputAuthority>, WriteResult>;
  ensureAgentMembership: Operation<AgentRoomInput, WriteResult>;
  getWalletToolState: Operation<
    WalletToolStateInput & TurnOutputAuthority & RoomInput,
    WalletToolState | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  getWalletToolBalance: Operation<
    WalletToolBalanceInput & TurnOutputAuthority & RoomInput,
    WalletToolBalanceResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  getWalletToolChains: Operation<
    WalletToolChainsInput & TurnOutputAuthority & RoomInput,
    WalletToolChainsResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  getWalletToolHistory: Operation<
    WalletToolHistoryInput & TurnOutputAuthority & RoomInput,
    WalletToolHistoryResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  getWalletToolQuote: Operation<
    WalletToolQuoteInput & TurnOutputAuthority & RoomInput,
    WalletToolQuoteResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  walletPay: Operation<
    WalletPayInput & TurnOutputAuthority & RoomInput,
    WalletSendOutcome | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  walletContractCall: Operation<
    WalletContractCallInput & TurnOutputAuthority & RoomInput,
    WalletSendOutcome | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  walletSignTypedData: Operation<
    WalletSignTypedDataInput & TurnOutputAuthority & RoomInput,
    WalletSignTypedDataResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  walletSwap: Operation<
    WalletSwapInput & TurnOutputAuthority & RoomInput,
    WalletSwapResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
  /** One friction report from the agent's active turn (`report_feedback`). */
  reportFeedback: Operation<ReportFeedbackInput & TurnOutputAuthority, ReportFeedbackResult>;
  /** A merged fix resolved these items; System DMs their human reporters (`notify_feedback_fixed`). */
  notifyFeedbackFixed: Operation<
    NotifyFeedbackFixedInput & TurnOutputAuthority,
    NotifyFeedbackFixedResult
  >;
};

export type Operation<Input, Output> = { readonly input: Input; readonly output: Output };

export type RoomInput = { readonly roomId: string };

export type AgentInput = { readonly agentId: string };

export type AgentRoomInput = AgentInput & RoomInput;

export type AgentConfigurationInput = AgentInput & { readonly roomId?: string };

export type CornerInput = { readonly cornerId: string };

export type AgentMemberMetadata = {
  readonly model?: string | null;
  /** Absent when the provider has not reported its billing or quota. */
  readonly billing?: 'subscription' | 'pay-per-use';
  readonly remainingAllowance?: {
    readonly updatedAt: number;
    /** Remaining fraction (0–1) per provider window; timestamps are Unix seconds. */
    readonly windows: readonly { readonly rateLimitType: string; readonly remaining: number; readonly resetsAt?: number }[];
    readonly usd?: number;
    readonly credits?: number;
    readonly tokens?: { readonly remaining: number; readonly resetsAt: number };
  };
  readonly reviewer?: 'primary';
  readonly owner?: { readonly id: string; readonly handle: string | null; readonly name: string };
  readonly machine?: string | null;
  readonly online?: boolean;
};

export type RoomMemberListResult = {
  readonly members: readonly (AgentMemberMetadata & {
    readonly id: string;
    readonly kind: 'human' | 'agent';
    readonly name: string;
    readonly handle: string | null;
    readonly role: string;
  })[];
};

export type CornerPullRequestResult =
  | {
      readonly status: 'ok';
      readonly number: number;
      readonly url: string;
      readonly title?: string;
      readonly headSha: string;
      readonly merged: boolean;
      readonly files: readonly {
        readonly filename: string;
        readonly status: string;
        readonly additions: number;
        readonly deletions: number;
      }[];
      readonly reviews: readonly {
        readonly author: string;
        readonly state: string;
        readonly body: string;
        readonly submittedAt?: string;
      }[];
      readonly reviewComments: readonly {
        readonly author: string;
        readonly path: string;
        readonly line?: number;
        readonly body: string;
        readonly createdAt?: string;
      }[];
      readonly comments: readonly {
        readonly author: string;
        readonly body: string;
        readonly createdAt?: string;
      }[];
    }
  | { readonly status: 'blocked'; readonly blocker: string };

export type IdentityInput = { readonly identityId: string };

export type RequestInput = RoomInput & { readonly requestId: string };

export type RoomCursorInput = RoomInput & {
  readonly after?: string;
  readonly limit?: number;
};
