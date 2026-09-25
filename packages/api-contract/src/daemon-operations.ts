import type { ServerEventKind, SystemEvent } from './system-events.js';
import type {
  AgentGrantEscalation,
  AgentGrantKind,
  AgentGrantStatus,
  CommandGrantScript,
} from './agent-grants.js';
import type { CornerLifecycleView, MessageReactionEmoji } from './phone-types.js';
import type { ChoiceOptionInput } from './room-choices.js';
import type { RoomScheduleCadence } from './phone-operations.js';
import type { CornerAppDefinition } from './corner-apps.js';
import type {
  ClaimInstitutionalMemoryJobResult,
  CompleteInstitutionalMemoryJobInput,
  FailInstitutionalMemoryJobInput,
} from './institutional-memory.js';
import type {
  WalletPayInput,
  WalletSendOutcome,
  WalletSwapInput,
  WalletSwapResult,
  WalletToolBalanceInput,
  WalletToolBalanceResult,
  WalletToolChainsInput,
  WalletToolChainsResult,
  WalletToolHistoryInput,
  WalletToolHistoryResult,
  WalletToolQuoteInput,
  WalletToolQuoteResult,
  WalletToolState,
  WalletToolStateInput,
} from './wallet.js';

/** Maximum number of consecutive agent-authored turns in one Room exchange. */
export const AGENT_TO_AGENT_HOP_CAP = 3;

export type CreateAgentScheduleInput = AgentRoomInput & {
  /** Delivered as a creator-authored Room mention to this agent on every run. */
  readonly prompt: string;
  readonly cadence: RoomScheduleCadence;
  /** Stop (and delete) the schedule after this many runs. */
  readonly maxRuns?: number;
};
export type AgentScheduleResult = {
  readonly scheduleId: string;
  readonly nextRunAt: number;
};
export type AgentScheduleEntry = {
  readonly scheduleId: string;
  readonly prompt: string;
  readonly cadence: RoomScheduleCadence;
  readonly maxRuns?: number;
  readonly runCount: number;
  readonly nextRunAt: number;
};
export type AgentScheduleListResult = { readonly schedules: readonly AgentScheduleEntry[] };
export type DeleteAgentScheduleInput = AgentRoomInput & { readonly scheduleId: string };

/**
 * What this agent reacts to in ONE Room, written by the agent itself.
 *
 * The subscription lives on the agent's own Room membership, so the operation
 * carries no identity: the daemon token names the agent and `roomId` names the
 * Room, and the server refuses anything else. `kinds` REPLACES the list, so an
 * agent asked to stop reacting sends the remaining kinds (or none).
 */
export type SetEventSubscriptionsInput = RoomInput & {
  readonly kinds: readonly string[];
};
export type EventSubscriptionsResult = { readonly kinds: readonly ServerEventKind[] };

/**
 * One event this agent emits into the Room it is answering in.
 *
 * `kind` must be an `agent:<slug>` kind; a server kind is the server's own word
 * and is refused here. The cause is NOT carried: the server reads the agent's
 * active turn receipt and derives cause, root and depth from it, because a
 * guard the guarded party sets is not a guard.
 */
export type PostRoomEventInput = TurnOutputAuthority &
  RoomInput & {
    readonly kind: string;
    readonly consequence: string;
    /** Agent members of this Room to wake, at most `MAX_MENTIONS_PER_EVENT`. */
    readonly mentionAgentIds?: readonly string[];
  };

export type AgentCommandAction = 'input' | 'resume' | 'stop' | 'restart';
export type AgentCommand = {
  readonly id: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly sourceMessageId: string;
  readonly turnRequestId: string;
  readonly action: AgentCommandAction;
  readonly reason: string;
  readonly rootCommandId: string;
  readonly parentCommandId?: string;
  readonly rootSourceMessageId: string;
  readonly agentDepth: number;
  readonly source: RoomInboxResult['items'][number];
};
export type CommandClaimInput = RoomInput & {
  readonly commandId: string;
  readonly generationId: string;
};
export type TurnOutputAuthority = { readonly generationId?: string; readonly requestId?: string };
export type DaemonOperationMap = {
  /** Phase-0 only: claims shadow extraction work and never returns live memory. */
  claimInstitutionalMemoryJob: Operation<AgentInput, ClaimInstitutionalMemoryJobResult>;
  heartbeatInstitutionalMemoryJob: Operation<
    AgentInput & { readonly jobId: string; readonly leaseToken: string },
    WriteResult
  >;
  completeInstitutionalMemoryJob: Operation<CompleteInstitutionalMemoryJobInput, WriteResult>;
  failInstitutionalMemoryJob: Operation<FailInstitutionalMemoryJobInput, WriteResult>;
  getAgentCommands: Operation<
    RoomInput,
    { readonly commandProtocol: 1; readonly commands: readonly AgentCommand[] }
  >;
  claimAgentCommand: Operation<CommandClaimInput, WriteResult>;
  acknowledgeAgentCommand: Operation<CommandClaimInput, WriteResult>;
  getDaemonBootstrap: Operation<DaemonBootstrapInput, DaemonBootstrapResult>;
  getWorkspaceRoster: Operation<WorkspaceRosterInput, WorkspaceRosterResult>;
  getRoomInbox: Operation<RoomCursorInput, RoomInboxResult>;
  getRoomConversation: Operation<RoomConversationInput, RoomConversationResult>;
  getCornerAsk: Operation<
    RoomInput & { readonly askId: string },
    {
      readonly askId: string;
      readonly cornerId: string;
      readonly question: string;
      readonly status: 'pending' | 'answered' | 'unanswered';
      readonly answer?: string;
    }
  >;
  getRoomAuthority: Operation<RoomPrincipalInput, RoomAuthorityResult>;
  getPermissionAuthority: Operation<PermissionAuthorityInput, AuthorityDecisionResult>;
  getMissionAuthority: Operation<MissionAuthorityInput, AuthorityDecisionResult>;
  listWorkSchedules: Operation<AgentInput, WorkScheduleListResult>;
  createAgentSchedule: Operation<CreateAgentScheduleInput, AgentScheduleResult>;
  setEventSubscriptions: Operation<SetEventSubscriptionsInput, EventSubscriptionsResult>;
  listEventSubscriptions: Operation<RoomInput, EventSubscriptionsResult>;
  postRoomEvent: Operation<PostRoomEventInput, WriteResult>;
  listAgentSchedules: Operation<AgentRoomInput, AgentScheduleListResult>;
  deleteAgentSchedule: Operation<DeleteAgentScheduleInput, WriteResult>;
  getWorkScheduleAuthority: Operation<WorkScheduleAuthorityInput, AuthorityDecisionResult>;
  listAgentToolSchedules: Operation<AgentRoomInput, WorkScheduleListResult>;
  getAgentToolMandate: Operation<AgentRoomInput, AgentToolMandateResult>;
  getTargetAgentAuthority: Operation<TargetAgentAuthorityInput, AuthorityDecisionResult>;
  listRoomCorners: Operation<RoomInput, CornerListResult>;
  getCornerRestoreState: Operation<CornerInput, CornerRestoreResult>;
  getPrChecksStatus: Operation<
    CornerInput & { pullRequest?: number | string },
    {
      checks: 'passed' | 'failed' | 'pending';
      /** Number of check-run and commit-status contexts GitHub reports for the current head. */
      checkCount: number;
      pullRequest: string;
      headSha: string;
      /** True when the configured reviewer's exact-head outcome has not passed. */
      approvalPending: boolean;
      /** The parent Room's currently-configured reviewer, as `@handle`, or null when none is configured. */
      reviewer: string | null;
      /** True when the parent Room has a configured reviewer, even if that identity has no handle. */
      reviewerExists: boolean;
      /** True when `reviewer` is also this corner's opener/author — self-review is not required. */
      reviewerIsAuthor: boolean;
      /**
       * Whether the configured reviewer was or can be woken for this corner's
       * current check state. Distinguishes "no reviewer" from "configured but
       * not a current parent-Room member", and pending checks from a dispatch.
       */
      reviewerWake: {
        status: 'unconfigured' | 'unreachable' | 'waiting' | 'dispatched';
        detail: string;
      };
      /** States which actor's approve_merge clears the gate, and the human fallback path. */
      rule: string;
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
  getCornerCloseRequests: Operation<CornerCursorInput, RoomInboxResult>;
  /** Long-poll: resolves as soon as the corner has something new, or on a bounded timeout. */
  waitForCornerWake: Operation<CornerInput, CornerWakeResult>;
  listUntrackedCorners: Operation<RoomInput, CornerListResult>;
  getRoomRepositoryState: Operation<RoomInput, RoomRepositoryStateResult>;
  getRoomGitHubToken: Operation<RoomInput, RoomGitHubTokenResult>;
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
  postAgentTurnReceipt: Operation<PostTurnReceiptInput, WriteResult>;
  postAgentActivity: Operation<PostAgentActivityInput, WriteResult>;
  postPermissionRequest: Operation<PostPermissionRequestInput, WriteResult>;
  postPermissionExecution: Operation<PostPermissionExecutionInput, WriteResult>;
  postWorkSchedule: Operation<PostWorkScheduleInput, WriteResult>;
  postWorkScheduleReceipt: Operation<PostWorkScheduleReceiptInput, WriteResult>;
  postAgentToolScheduleIndex: Operation<PostScheduleIndexInput, WriteResult>;
  postAgentToolMandate: Operation<PostAgentToolMandateInput, WriteResult>;
  getAgentAvatar: Operation<RoomInput, { readonly drawing: unknown; readonly soul: unknown }>;
  postAgentAvatar: Operation<RoomInput & { readonly drawing: unknown }, WriteResult>;
  postAgentCommands: Operation<PostAgentCommandsInput, WriteResult>;
  postAgentModelCatalog: Operation<PostAgentModelCatalogInput, WriteResult>;
  postAgentMachineReport: Operation<
    { readonly machineId: string; readonly machineName: string },
    WriteResult
  >;
  postCornerLifecycle: Operation<PostCornerLifecycleInput, WriteResult>;
  postCornerRemoteState: Operation<PostCornerRemoteStateInput, WriteResult>;
  postCornerPlan: Operation<PostCornerPlanInput, WriteResult>;
  putCornerApp: Operation<PutCornerAppInput, CornerAppWriteResult>;
  requestCornerAppOpen: Operation<RequestCornerAppOpenInput, CornerAppWriteResult>;
  postTargetBranchProposal: Operation<PostTargetBranchProposalInput, WriteResult>;
  requestAgentGrant: Operation<RequestAgentGrantInput, RequestAgentGrantResult>;
  askRoomChoice: Operation<AskRoomChoiceInput, AskRoomChoiceResult>;
  openRoomPoll: Operation<OpenRoomPollInput, AskRoomChoiceResult>;
  listAgentGrants: Operation<AgentInput & { readonly roomId?: string }, AgentGrantListResult>;
  consumeAgentGrant: Operation<ConsumeAgentGrantInput, WriteResult>;
  /**
   * Per-call Squire gate: owner turns bypass only under yolo; otherwise a requester needs a
   * live mcp/squire grant keyed to them. A miss posts the existing Once/Always/No
   * card in the owner's Trusty Squire DM and returns pending.
   */
  authorizeSquireCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  authorizeResourceCall: Operation<
    AuthorizeSquireCallInput & { readonly target: string },
    AuthorizeSquireCallResult
  >;
  authorizeRepositoryCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  authorizeHostCall: Operation<AuthorizeSquireCallInput, AuthorizeSquireCallResult>;
  listTurnAgentGrants: Operation<AuthorizeSquireCallInput, AgentGrantListResult>;
  /** R5: what the Workbench can add, and what the person this turn answers already has. */
  readAgentWorkbench: Operation<RoomInput, AgentWorkbenchView>;
  /** R5: the agent offers to add one connector; a card goes to the Room and the turn pauses on it. */
  offerConnector: Operation<OfferConnectorInput, OfferConnectorResult>;
  installConnector: Operation<InstallConnectorInput, WriteResult>;
  postConnectorStatus: Operation<PostConnectorStatusInput, WriteResult>;
  postConnectorVault: Operation<PostConnectorVaultInput, WriteResult>;
  getConnectorStatus: Operation<GetConnectorStatusInput, ConnectorStatus>;
  getConnectorVaultList: Operation<AgentInput, ConnectorVaultListResult>;
  getConnectionDetail: Operation<AgentInput & ConnectionRefInput, ConnectionDetail>;
  revokeConnectionGrants: Operation<AgentInput & ConnectionRefInput, ConnectionGrantRevokeResult>;
  postConnectionUsage: Operation<PostConnectionUsageInput, WriteResult>;
  getConnectorAssignments: Operation<AgentInput, ConnectorAssignmentsResult>;
  getComposioLink: Operation<
    AgentInput & { readonly connectorId: string; readonly pairingGeneration?: number },
    { readonly status: 'connected' } | { readonly status: 'pending'; readonly toolkit: string; readonly url: string }
  >;
  getComposioTools: Operation<RoomInput & { readonly requestId: string; readonly generationId: string }, {
    readonly connectorId: string;
    readonly toolkits: readonly string[];
    readonly tools: Readonly<Record<string, readonly string[]>>;
  }>;
  executeComposioTool: Operation<RoomInput & {
    readonly requestId: string;
    readonly generationId: string;
    readonly toolkit: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }, { readonly data: unknown; readonly logId?: string }>;
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
  createCorner: Operation<CreateCornerInput, CornerResult>;
  archiveCorner: Operation<CornerInput, WriteResult>;
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
  walletSwap: Operation<
    WalletSwapInput & TurnOutputAuthority & RoomInput,
    WalletSwapResult | { readonly status: 'permission-required'; readonly grantId?: string }
  >;
};
export type Operation<Input, Output> = { readonly input: Input; readonly output: Output };
export type RoomInput = { readonly roomId: string };
export type AgentInput = { readonly agentId: string };
export type AgentRoomInput = AgentInput & RoomInput;
export type AgentConfigurationInput = AgentInput & { readonly roomId?: string };
export type CornerInput = { readonly cornerId: string };
export type IdentityInput = { readonly identityId: string };
export type RequestInput = RoomInput & { readonly requestId: string };
export type RoomCursorInput = RoomInput & {
  readonly after?: string;
  readonly limit?: number;
  /** Re-read the five seconds before `after`; callers must de-duplicate by item id. */
  readonly rewind?: boolean;
  /** Establish a high-water mark without replaying pre-activation history. */
  readonly startAtLatest?: boolean;
};
/**
 * A conversation read and an inbox read are two different needs on one server
 * code path. `recent` (the default) is the NEWEST page — what a turn must be
 * prompted with, since the oldest page of a long Room is old news. `earliest`
 * is the forward walk from the very first message, which is how corner startup
 * recovers the objective. `continuity` is the newest message-only window used
 * to rebuild conversational response ownership. Never flip the shared sort to
 * serve one of them; ask for the window you need. A read that carries `after`
 * keeps the inbox's ascending cursor semantics and ignores this field.
 */
export type RoomConversationWindow = 'recent' | 'earliest' | 'continuity';
export type RoomConversationInput = RoomCursorInput & {
  readonly window?: RoomConversationWindow;
  /** Include narration already saved for this turn, so a retry can avoid repeating it. */
  readonly narrationRequestId?: string;
};
export type RoomPrincipalInput = RoomInput & { readonly principalId: string };
export type CornerCursorInput = CornerInput & {
  readonly after?: string;
  /** Re-read the five seconds before `after`; callers must de-duplicate by item id. */
  readonly rewind?: boolean;
};
/** `woken` is false only when the timeout elapsed with nothing new. */
export type CornerWakeResult = { readonly woken: boolean };
export type PermissionAuthorityInput = RoomPrincipalInput & {
  readonly permissionId: string;
  readonly actionId?: string;
};
export type MissionAuthorityInput = RoomPrincipalInput & {
  readonly missionId: string;
  readonly exercise: string;
};
export type WorkScheduleAuthorityInput = AgentRoomInput & {
  readonly scheduleId: string;
  readonly revision: number;
};
export type TargetAgentAuthorityInput = AgentRoomInput & {
  readonly targetAgentId: string;
  readonly controllerAgentId: string;
};
export type DaemonBootstrapInput = AgentInput;
export type WorkspaceRosterInput = AgentInput & { readonly workspaceId: string };
export type DaemonBootstrapResult = {
  readonly workspaceIds: readonly string[];
  readonly rooms: readonly { readonly roomId: string; readonly archived: boolean }[];
};
export type WorkspaceRosterResult = {
  readonly members: readonly {
    readonly identityId: string;
    readonly kind: 'human' | 'agent';
    readonly name: string;
    readonly handle?: string;
    readonly role: 'owner' | 'admin' | 'member';
    readonly soul?: {
      readonly name: string;
      readonly instructions: string;
      readonly avatarSeed: string;
      readonly avatar?: string;
      readonly authoredBy: string;
      readonly updatedAt: number;
    };
  }[];
};
export type RoomInboxResult = {
  /** Present only when ordinary message rows are server-selected commands. */
  readonly dispatchVersion?: 1;
  readonly items: readonly {
    readonly id: string;
    /** Opaque server ordering key for merging live and polled deliveries. */
    readonly cursor?: string;
    readonly authorId: string;
    readonly createdAt: number;
    readonly type: string;
    readonly body: string;
    /** Present on a corner answer or unanswered-close report. */
    readonly cornerAskId?: string;
    readonly agentAuthor?: boolean;
    readonly replyToMessageId?: string;
    /** Current author of the reply parent, projected by the server. */
    readonly replyToAuthorId?: string;
    readonly rootMessageId?: string;
    readonly requestId?: string;
    /** Author of the message this agent reply answered, even outside this page. */
    readonly requestAuthorId?: string;
    /** Server-owned agent-to-agent chain depth. */
    readonly agentHopCount?: number;
    readonly attachments: readonly DaemonAttachment[];
    /** Present on a server-phrased system line; the daemon reads the structured event, never the text. */
    readonly systemEvent?: SystemEvent;
  }[];
  readonly cursor?: string;
  /** IDs in the replay window at activation; absent on servers without rewind support. */
  readonly rewindIds?: readonly string[];
  /** Present on getCornerCloseRequests so helpers can reap an archived worktree. */
  readonly closeRequested?: boolean;
};
export type DaemonAttachment = {
  readonly url: string;
  /** The bytes are past the media TTL; the download will answer 410 Gone. */
  readonly expired?: boolean;
  readonly name?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly thumbnailUrl?: string;
};
export type RoomConversationResult = RoomInboxResult & {
  /** Durable corner output text for narrationRequestId, scoped to the reading agent. */
  readonly savedNarration?: readonly string[];
};
export type RoomAuthorityResult = {
  readonly workspaceId: string;
  readonly role?: 'owner' | 'admin' | 'member';
  readonly member: boolean;
  readonly principalKind?: 'human' | 'agent';
  readonly archived: boolean;
  /**
   * Whether this principal may address the ASKING agent under the agent's
   * server-side access policy (`agent-access.ts`). The server decides it, so an
   * owner's change in the app reaches a helper that is already running on its
   * next poll — no reconnect, no restart. Absent only from a server older than
   * the policy move, where a helper falls back to its runtime record.
   */
  readonly mayAddressAgent?: boolean;
};
export type AuthorityDecisionResult = {
  readonly status: 'authorized' | 'denied' | 'unavailable';
  readonly reason?: string;
  readonly generation?: number;
};
export type WorkScheduleListResult = {
  readonly schedules: readonly {
    readonly scheduleId: string;
    readonly revision: number;
    readonly status: string;
    readonly nextRunAt?: number;
  }[];
};
export type AgentToolMandateResult = {
  readonly status: 'valid' | 'invalid' | 'unavailable';
  readonly generation?: number;
};
export type CornerListResult = {
  readonly corners: readonly {
    readonly cornerId: string;
    readonly parentRoomId: string;
    readonly name?: string;
    readonly objective?: string;
    readonly createdBy: string;
    readonly archived: boolean;
    readonly closedAt?: number;
    readonly pullRequestNumber?: number;
    readonly mergeCommitSha?: string;
  }[];
};
export type CornerRestoreResult = {
  readonly cornerId: string;
  /** Immutable objective from the authoritative corner fact. */
  readonly objective: string;
  /** Human-created corners are title-only; their title supplies runtime context after a tag. */
  readonly title?: string;
  readonly kind?: 'agent' | 'human';
  readonly featureBranch?: string;
  readonly requestId?: string;
  readonly closeRequested: boolean;
  /** The lane this corner was opened in. A restarted helper must not cut a worktree for `no_code`. */
  readonly lane: CornerLane;
  /** The human who commissioned the corner, as a bare handle. Who a no-code corner reports delivery to. */
  readonly requesterHandle?: string;
  /** Server-indexed GitHub facts retained across a helper restart. */
  readonly lifecycle?: CornerLifecycleView;
  /** The latest manager merge request, bound to the exact PR revision it approved. */
  readonly mergeApproval?: {
    readonly pullRequestNumber: number;
    readonly headSha: string;
  };
};
export type RoomRepositoryStateResult = {
  readonly key?: string;
  readonly remote?: string;
  readonly targetBranch?: string;
  readonly resolution: 'repository' | 'none' | 'unverified';
  /** Present only on a direct-message Room: the two sorted participant pubkeys. */
  readonly directParticipants?: readonly string[];
};
export type RoomGitHubTokenResult = {
  readonly token: string;
  readonly expiresAt: number;
};
export type RoomTargetBranchResult = { readonly targetBranch: string; readonly updatedAt: number };
export type IdentitySuccessionResult = {
  readonly currentIdentityId: string;
  readonly predecessors: readonly string[];
};
export type AgentConfigurationResult = {
  readonly soul?: { readonly name: string; readonly instructions: string };
  readonly model?: string;
  readonly effort?: string;
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
  /** The agent "yolo" switch: grant requests are approved without asking. */
  readonly yoloMode: boolean;
  /** Live reviewer configured on a corner's parent Room; absent for self-review. */
  readonly reviewerHandle?: string;
};
export type AgentPresenceResult = {
  readonly status: 'online' | 'offline' | 'dormant';
  readonly observedAt?: number;
  readonly releaseVersion?: string;
  readonly sourceSha?: string;
};
export type RequestCompletionResult = {
  readonly openedCornerId?: string;
  readonly completed: boolean;
};
export type WriteResult = {
  readonly id: string;
  readonly createdAt: number;
  /** Set on a failed hiccup receipt the helper should exit so systemd restarts it. */
  readonly hiccupRestart?: boolean;
  readonly hiccupAttempt?: number;
};
export type PostRoomMessageResult = WriteResult;
export type ReactToRoomMessageInput = RoomInput & {
  readonly messageId: string;
  readonly emoji: MessageReactionEmoji;
};
export type PostRoomMessageInput = TurnOutputAuthority &
  RoomInput & {
    readonly requestId?: string;
    readonly text: string;
    /** The daemon never phrases a system line; the server does (`system-line.ts`). */
    readonly presentation?: 'message' | 'card';
    readonly tags?: Readonly<Record<string, string>>;
    readonly replyToMessageId?: string;
    /** Inbox message that started this turn; independent of optional reply threading. */
    readonly triggerMessageId?: string;
    /** Source room is the active command room; destination is authorized separately. */
    readonly relay?: {
      readonly fromRoomId: string;
      readonly toRoomId: string;
      readonly direction: 'down' | 'up';
      /** A question receives one muted, linked report in the parent Room. */
      readonly reply?: 'once';
    };
  };
export type PostAgentAttachmentInput = TurnOutputAuthority &
  RoomInput & {
    /** A daemon media upload result; the server verifies the media row is owned by the agent. */
    readonly attachment: DaemonAttachment;
  };
export type PostLiveOutputInput = TurnOutputAuthority &
  AgentRoomInput & {
    readonly turnId: string;
    readonly text: string;
  };
export type RetractLiveOutputInput = TurnOutputAuthority &
  AgentRoomInput & {
    readonly turnId: string;
    readonly kind: 'draft' | 'thought';
  };
export type PostTurnReceiptInput = AgentRoomInput & {
  readonly requestId: string;
  /**
   * `cancelled` is TERMINAL and wins: once the requester has stopped a turn,
   * no later receipt for that request may reopen or re-settle it, whichever
   * party writes it.
   */
  readonly status: 'working' | 'complete' | 'failed' | 'cancelled';
  /**
   * A successful turn that intentionally produced no Room message. The server
   * records that outcome so it cannot be mistaken for a vanished or failed
   * answer. Omitted for ordinary replies and card-backed handoffs.
   */
  readonly completionKind?: 'no-reply';
  readonly generationId?: string;
  /** Refreshes an existing working receipt; never starts or resurrects a turn. */
  readonly heartbeat?: boolean;
  /** One distilled line (≤200 chars, no stack, secrets scrubbed) sent only with `failed`. */
  readonly reason?: string;
  /** Typed Room-safe classification; detail stays in the daemon log. */
  readonly reasonKind?:
    | 'hiccup'
    | 'wrong-model'
    | 'allowance-spent'
    | 'not-signed-in'
    | 'workspace-failure'
    | 'helper-out-of-date'
    | 'offline'
    | 'model-selection-unavailable';
};
export type PostAgentActivityInput = TurnOutputAuthority &
  AgentRoomInput & {
    readonly requestId: string;
    readonly cornerActivityKey?: string;
    /** Model pinned to the producing session; null when the helper has no model selection. */
    readonly agentModel?: string | null;
    readonly activity: readonly DaemonActivityItem[];
  };
export type PostPermissionRequestInput = RoomPrincipalInput & {
  readonly permissionId: string;
  readonly requestId: string;
  readonly scope: DaemonPermissionScope;
};
export type PostPermissionExecutionInput = PermissionAuthorityInput & {
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly result?: string;
};
export type PostWorkScheduleInput = AgentRoomInput & { readonly schedule: DaemonWorkSchedule };
export type PostWorkScheduleReceiptInput = AgentRoomInput & {
  readonly scheduleId: string;
  readonly occurrenceId: string;
  readonly status: string;
};
export type PostScheduleIndexInput = AgentInput & {
  readonly workspaceId: string;
  readonly scheduleIds: readonly string[];
};
export type PostAgentToolMandateInput = AgentRoomInput & {
  readonly generation: number;
  readonly mandate: DaemonAgentToolMandate;
};
export type PostAgentCommandsInput = AgentInput & {
  readonly workspaceId: string;
  readonly commands: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputHint?: string;
  }[];
};
export type PostAgentModelCatalogInput = AgentInput & {
  readonly workspaceId: string;
  readonly options: readonly DaemonModelConfigOption[];
  readonly selection?: { readonly model?: string; readonly effort?: string };
  /** Startup validation verdict for the persisted selection. */
  readonly unavailable?: 'model' | 'effort' | 'selection';
};
export type PostCornerLifecycleInput = CornerInput & {
  readonly status: string;
  readonly objective: string;
  readonly outcome?: 'landed' | 'abandoned';
};
export type PostCornerRemoteStateInput = CornerInput & {
  readonly branch: string;
  readonly state: 'working' | 'in-review' | 'gone' | 'unknown';
  readonly checks: 'passing' | 'failing' | 'pending' | 'unknown';
  readonly pullRequest?: DaemonPullRequestFact;
};
export type PostCornerPlanInput = CornerInput & {
  readonly objective?: string;
  readonly items: readonly {
    readonly step: string;
    readonly status: 'pending' | 'in_progress' | 'completed';
  }[];
};
export type PutCornerAppInput = TurnOutputAuthority &
  CornerInput & {
    readonly definition: CornerAppDefinition;
  };
export type RequestCornerAppOpenInput = TurnOutputAuthority &
  CornerInput & {
    readonly slug: string;
    readonly requestId: string;
  };
export type CornerAppWriteResult = WriteResult & {
  readonly slug: string;
  readonly revision: number;
};
export type PostTargetBranchProposalInput = RoomInput & {
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  readonly repository: string;
};
export type CreateCornerInput = TurnOutputAuthority &
  RoomInput & {
    readonly requestId: string;
    /** Stable for one tool call, distinct between separate calls in the same turn. */
    readonly idempotencyKey?: string;
    /** The corner's title on every surface, limited to 3 whitespace-delimited words. */
    readonly name: string;
    /** Immutable one-paragraph objective, limited to 24 whitespace-delimited words. */
    readonly objective: string;
    readonly repository?: string;
    readonly targetBranch?: string;
    /**
     * Which lane the corner runs in, chosen once at open and durable after.
     * `no_code` skips the worktree, the commit, the pull request and the merge:
     * the work comes back as artifacts and a reply tagging the requester. A
     * corner with no repository is `no_code` whatever this says.
     * `research` keeps a writable worktree under a durable delivery and merge hold.
     */
    readonly lane?: CornerLane;
  };
export type CornerResult = { readonly cornerId: string };
export type CornerLane = 'code' | 'no_code' | 'research';

/** ask_choice / open_poll: a lettered preference, never a grant. */
export type ChoiceOptionArg = ChoiceOptionInput;
export type AskRoomChoiceInput = TurnOutputAuthority &
  RoomInput & {
    readonly prompt: string;
    readonly constraint?: string;
    readonly options: readonly ChoiceOptionArg[];
    readonly ttlSeconds?: number;
  };
export type OpenRoomPollInput = TurnOutputAuthority &
  RoomInput & {
    readonly prompt: string;
    readonly constraint?: string;
    readonly options: readonly ChoiceOptionArg[];
    readonly ttlSeconds: number;
  };
export type AskRoomChoiceResult = {
  readonly choiceId: string;
  readonly messageId: string;
  readonly mode: 'question' | 'poll';
  readonly electorateCount: number;
  readonly closesAt?: number;
};

/** request_grant: the agent raises its hand for one kind of reach in one Room. */
export type RequestAgentGrantInput = TurnOutputAuthority &
  RoomInput & {
    readonly kind: AgentGrantKind;
    readonly target: string;
    readonly reason: string;
    /** Optional lifetime in seconds; the grant expires this long after the request. */
    readonly ttlSeconds?: number;
    /**
     * For an interpreter command, the script the daemon read out of the agent's
     * checkout or scratch. The card shows it and the approval is bound to its
     * hash (C94); the server never reads the operator's filesystem itself.
     */
    readonly script?: CommandGrantScript;
  };
export type RequestAgentGrantResult = {
  readonly grantId: string;
  readonly status: AgentGrantStatus;
  /** True when yolo approved it on the spot (no card was posted). */
  readonly auto: boolean;
  /** The card message when one was posted or joined. */
  readonly messageId?: string;
  /** Why yolo did not cover this ask, when it did not (C94). */
  readonly escalations?: readonly AgentGrantEscalation[];
};
/** Every live (approved or once, unexpired) grant of this agent, for the rule runner. */
export type AgentGrantListResult = {
  readonly grants: readonly {
    readonly grantId: string;
    readonly workspaceId: string;
    readonly roomId: string;
    readonly kind: AgentGrantKind;
    readonly target: string;
    readonly status: AgentGrantStatus;
    readonly requestedBy: string;
    readonly requestedByName?: string;
    readonly expiresAt?: number;
    /** The script bytes this approval was bound to, for the runner's re-check. */
    readonly script?: CommandGrantScript;
  }[];
};
/** A 'once' grant is spent by its first run. */
export type ConsumeAgentGrantInput = { readonly grantId: string };
export type AuthorizeSquireCallInput = TurnOutputAuthority & RoomInput;
export type AuthorizeSquireCallResult = {
  readonly allowed: boolean;
  readonly grantId?: string;
  readonly status?: AgentGrantStatus;
  readonly messageId?: string;
};

// ── Connector offers (R5) ─────────────────────────────────────────

/**
 * What an agent may learn about the Workbench from a Room: the catalog (every
 * connector kind, its name, one-line purpose, and whether it can be offered),
 * plus what the ADDRESSEE — the person whose message woke this turn — already
 * has paired and which keys they hold (names only; a vault value never crosses
 * this wire). Another member's rows are never visible.
 */
export type AgentWorkbenchView = {
  readonly addressee: {
    readonly identityId: string;
    readonly name: string;
    readonly handle?: string;
  };
  readonly catalog: readonly {
    readonly connectorType: string;
    readonly name: string;
    readonly purpose: string;
    /** The Workbench can pair it today. */
    readonly available: boolean;
    /** You may offer it from this Room with offer_connector. */
    readonly offerable: boolean;
    /** The addressee's own row for this kind, when they have one on any machine. */
    readonly paired?: {
      readonly status: 'installing' | 'connected' | 'error' | 'disconnected';
      readonly helperName: string;
      /** The pairing runs on THIS agent's machine. */
      readonly onThisMachine: boolean;
    };
  }[];
  /** The addressee's provisioned keys, by name only. */
  readonly connections: readonly {
    readonly connectorType: string;
    readonly service: string | null;
    readonly label: string;
    readonly state: 'active' | 'error';
  }[];
  /** This agent's own machine, where an accepted offer would install. */
  readonly machine: { readonly machineId: string; readonly name: string };
};

/** offer_connector: the agent offers ONE connector in ONE Room, with its reason. */
export type OfferConnectorInput = TurnOutputAuthority &
  RoomInput & {
    readonly connectorType: string;
    readonly reason: string;
  };
export type OfferConnectorResult = {
  readonly offerId: string;
  readonly status: 'pending' | 'accepted';
  /** The card message. */
  readonly messageId: string;
  /** True when this call joined an offer this agent already had open in the Room. */
  readonly joined: boolean;
};

// ── Connector / Squire types ───────────────────────────────────────

/** One named step in a connector install or status report. */
export type ConnectorStep = {
  readonly label: string;
  readonly status: 'pending' | 'running' | 'done' | 'failed';
  /** Human-readable failure reason, present only when status === 'failed'. */
  readonly reason?: string;
  /** The CLI command this step runs, when the helper reports one. */
  readonly command?: string;
  /** Bounded tail of the step's captured output (CLI/tool logs), streamed
   *  while the step runs so a hang is visible on the phone. */
  readonly output?: string;
};

/** Status of one connector on this helper. */
export type ConnectorStatus = {
  readonly connectorId: string;
  readonly status: 'disconnected' | 'installing' | 'connected' | 'error';
  /** Ordered installation steps; empty when disconnected or connected. */
  readonly steps: readonly ConnectorStep[];
  /** The Squire account email or handle this helper is signed in as. */
  readonly signedInAs?: string;
  /** Number of agents configured on the same helper.
   * Present when the helper answers presence queries. */
  readonly agentCount?: number;
  /** Helpers are identified by name; present when status is installing or connected. */
  readonly helperName?: string;
  /** The version of the installed trusty-squire package. */
  readonly squireVersion?: string;
  /** How the human signs in, reported by the helper (Q7: Squire tells us).
   * The app opens exactly what it is told: the streamed noVNC page URL or the
   * OAuth authorization URL. */
  readonly signIn?: ConnectorSignIn;
  /** Human-readable error when status === 'error'. */
  readonly errorMessage?: string;
};

/**
 * Where Squire's connect run says the sign-in page actually opened, read
 * verbatim from its machine-readable report — never detected here. `none`
 * means the run opened no browser at all; `unknown` means it could not say.
 */
export type ConnectorBrowserLocation =
  | { readonly kind: 'host_screen' }
  | { readonly kind: 'virtual'; readonly url: string }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown'; readonly reason: string };

/** The sign-in surface a connector reports while it waits for the human. */
export type ConnectorSignIn = {
  readonly method: 'streamed-page' | 'oauth';
  readonly url: string;
  /** Where the page opened, when the connect report said. */
  readonly browserLocation?: ConnectorBrowserLocation;
};

/** Metadata about one vault entry (no secret values). */
export type VaultConnectionMeta = {
  readonly reference: string;
  readonly service: string | null;
  readonly label: string;
  readonly fieldNames: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly createdAt: number;
  readonly stale: boolean;
  readonly state: 'active' | 'error';
};

/** An egress grant bound to a credential. */
export type ConnectionGrant = {
  readonly grantId: string;
  readonly credentialRef: string;
  readonly createdAt: number;
  readonly revokedAt?: number;
  readonly revokingAt?: number;
  readonly rateLimitPerHour?: number;
  readonly spendCapUsd?: number;
};

/** One entry in a connection's audit ledger. */
export type ConnectionLedgerEntry = {
  readonly id: string;
  readonly timestamp: number;
  readonly action: string;
  readonly actor?: string;
  readonly status?: number;
  readonly bytes?: number;
  /** Anomaly flag for failed or rate-limited calls. */
  readonly anomaly?: boolean;
  readonly anomalyReason?: string;
};

/** Full detail for one connection: live metadata plus grants and ledger. */
export type ConnectionDetail = {
  readonly metadata: VaultConnectionMeta;
  /** Live grants on this credential. */
  readonly grants: readonly ConnectionGrant[];
  /** Recent ledger events (shaped ledger view). */
  readonly ledger: readonly ConnectionLedgerEntry[];
};

/**
 * What one usage event means to the human who owns the key (captain ruling
 * 2026-09-15): only approval requests (a payment, a credential read in
 * clear, a host added to a key) and vault changes made on the owner's behalf
 * reach them as a receipt DM. Ordinary use carries no class and stays on the
 * key's own Workbench record.
 */
export type ConnectionUsageEventClass = 'approval' | 'vault-change';

/** Input to postConnectionUsage: one batched usage report per agent turn. */
export type ConnectionUsageRecord = {
  readonly ref: string;
  readonly service: string | null;
  readonly operation: string;
  readonly statusCode: number;
  readonly bytes: number;
  readonly grantId?: string;
  readonly grantLabel?: string;
  /** Absent means ordinary use: recorded, never DM'd to the owner. */
  readonly eventClass?: ConnectionUsageEventClass;
};

/** The overall usage report for one agent turn. */
export type PostConnectionUsageInput = {
  readonly requestId: string;
  readonly agentId: string;
  readonly roomId?: string;
  readonly cornerId?: string;
  readonly usage: readonly ConnectionUsageRecord[];
};

// ── Connector operations ───────────────────────────────────────────

export type InstallConnectorInput = AgentInput & {
  readonly connectorId: string;
  /** Echo of the assignment's pairing generation; a stale report is ignored. */
  readonly pairingGeneration?: number;
  /** Connector-specific configuration; empty for phase 1. */
  readonly config?: Record<string, unknown>;
  /** Final install report (the completion of a `postConnectorStatus` run). */
  readonly squireVersion?: string;
  readonly signedInAs?: string;
  /**
   * The sign-in surface, written authoritatively: a completing run normally
   * omits it, and the row's stored surface is cleared with it, so no dead
   * tunnel outlives the connect that printed it.
   */
  readonly signIn?: ConnectorSignIn;
};

/**
 * Read one connector row. `connectorId` names WHICH one: a helper carries the
 * four Google tool rows beside its Squire row, and without it the answer is
 * whichever row was created first.
 */
export type GetConnectorStatusInput = AgentInput & {
  readonly connectorId?: string;
};

/**
 * Incremental helper install report: the ordered steps as they settle, posted
 * once per step transition while the helper runs an install or after a sync.
 * A `errorMessage` marks the run failed; otherwise the row stays installing
 * until `installConnector` completes it.
 */
export type PostConnectorStatusInput = AgentInput & {
  readonly connectorId: string;
  /** Echo of the assignment's pairing generation; a stale report is ignored. */
  readonly pairingGeneration?: number;
  readonly steps: readonly ConnectorStep[];
  readonly squireVersion?: string;
  readonly signedInAs?: string;
  /**
   * The sign-in surface this run printed. ABSENT means "no news" — the
   * steps-only progress reports of one run must not wipe the surface that
   * run already published. Explicit `null` is a run REPORTING that it has no
   * ceremony, which clears whatever tunnel the previous run left behind.
   */
  readonly signIn?: ConnectorSignIn | null;
  readonly errorMessage?: string;
};

/** One helper vault report (metadata only; secrets never leave the helper). */
export type PostConnectorVaultInput = AgentInput & {
  readonly connections: readonly VaultConnectionMeta[];
};

export type ConnectionRefInput = { readonly ref: string };
export type ConnectorVaultListResult = {
  readonly connections: readonly VaultConnectionMeta[];
};
export type ConnectionGrantRevokeResult = {
  readonly revoked: number;
  readonly failed: number;
};

/** Connector types the Workbench can provision. */
export type ConnectorKind =
  | 'trusty-squire'
  | 'wallet'
  | 'tailscale'
  | 'google-gmail'
  | 'google-calendar'
  | 'google-drive'
  | 'google-youtube'
  | 'composio';

/** The helper's work queue (server → helper delivery). */
export type ConnectorAssignment =
  | {
      readonly kind: 'install';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly pairingGeneration?: number;
    }
  | { readonly kind: 'sync'; readonly connectorId: string; readonly connectorType: ConnectorKind }
  | {
      readonly kind: 'refresh-google-grant';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
    }
  | {
      readonly kind: 'revoke-grants';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly reference: string;
    }
  | {
      readonly kind: 'uninstall';
      readonly connectorId: string;
      readonly connectorType: ConnectorKind;
      readonly pairingGeneration?: number;
    };

export type ConnectorAssignmentsResult = {
  readonly assignments: readonly ConnectorAssignment[];
};
export type DaemonActivityItem = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
  /** Durable corner narration when `kind='output'`; never private thought text. */
  readonly text?: string;
  readonly operation?: string;
  readonly status?: string;
  /** Bounded, redacted tool argument summaries for the corner ledger. */
  readonly command?: string;
  readonly input?: string;
  /** Bounded first/last-line excerpt of a completed tool result. */
  readonly output?: string;
  /** The identity whose message triggered the turn this row belongs to. */
  readonly requestedBy?: { readonly pubkey: string; readonly name?: string };
  readonly files?: readonly { readonly path: string; readonly status?: string }[];
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};
export type DaemonPermissionScope =
  | {
      readonly type: 'room.create';
      readonly workspaceId: string;
      readonly roomId: string;
      readonly name: string;
      readonly visibility: 'invite-only' | 'workspace';
      readonly participantIds: readonly string[];
      readonly agentIds: readonly string[];
      readonly repository?: { readonly key: string; readonly targetBranch: string };
    }
  | {
      readonly type: 'money.spend';
      readonly currency: string;
      readonly maxMinorUnits: number;
      readonly merchant: string;
      readonly purpose: string;
      readonly connectorId: string;
    }
  | {
      readonly type: 'message.send' | 'content.publish' | 'operation.execute';
      readonly connectorId: string;
      readonly target: string;
      readonly payloadDigest: string;
    }
  | {
      readonly type: 'schedule.change';
      readonly operation: 'create' | 'update' | 'pause' | 'delete';
      readonly scheduleId: string;
      readonly revisionDigest: string;
    }
  | {
      readonly type: 'mission.control';
      readonly missionId: string;
      readonly workspaceId: string;
      readonly roomId: string;
      readonly controllerAgentId: string;
      readonly repository: { readonly key: string; readonly targetBranch: string };
      readonly cornerOperations: readonly ('open' | 'close')[];
      readonly scheduleOperations: readonly ('create' | 'update' | 'pause' | 'delete' | 'fire')[];
    };
export type DaemonWorkSchedule = {
  readonly scheduleId: string;
  readonly revision: number;
  readonly status: 'active' | 'paused' | 'cancelled';
  readonly expression: string;
  readonly timezone: string;
  readonly mandate: string;
  readonly nextRunAt?: number;
};
export type DaemonAgentToolMandate = {
  readonly beneficiary: string;
  readonly action: string;
  readonly scope: DaemonPermissionScope;
  readonly expiresAt?: number;
};
export type DaemonModelConfigOption = {
  readonly id: string;
  readonly category: 'model' | 'thought_level' | 'effort' | 'reasoning_effort';
  readonly currentValue?: string;
  readonly options: readonly { readonly id: string; readonly name?: string }[];
};
export type DaemonPullRequestFact = {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly targetBranch: string;
  readonly headSha: string;
  readonly mergeability?: 'clean' | 'dirty' | 'unknown' | 'other';
};

/** Shape validation only. Target matching and claiming happen before execution. */
export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (
    ![
      'id',
      'roomId',
      'agentId',
      'sourceMessageId',
      'turnRequestId',
      'rootCommandId',
      'rootSourceMessageId',
      'reason',
    ].every((key) => typeof c[key] === 'string' && (c[key] as string).length > 0)
  )
    return false;
  if (
    !['input', 'resume', 'stop', 'restart'].includes(String(c.action)) ||
    !Number.isInteger(c.agentDepth) ||
    Number(c.agentDepth) < 0 ||
    Number(c.agentDepth) > 3
  )
    return false;
  const source = c.source as Record<string, unknown> | undefined;
  return Boolean(
    source &&
    typeof source.id === 'string' &&
    typeof source.authorId === 'string' &&
    typeof source.body === 'string' &&
    typeof source.createdAt === 'number' &&
    Array.isArray(source.attachments),
  );
}
