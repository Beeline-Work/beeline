import type { ServerEventKind, SystemEvent } from './system-events.js';
import type {
  AgentGrantEscalation,
  AgentGrantKind,
  AgentGrantStatus,
  CommandGrantScript,
} from './agent-grants.js';
import type { CornerLifecycleView } from './phone-types.js';
import type { RoomScheduleCadence } from './phone-operations.js';

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
export type PostRoomEventInput = RoomInput & {
  readonly kind: string;
  readonly consequence: string;
  /** Agent members of this Room to wake, at most `MAX_MENTIONS_PER_EVENT`. */
  readonly mentionAgentIds?: readonly string[];
};

export type DaemonOperationMap = {
  getDaemonBootstrap: Operation<DaemonBootstrapInput, DaemonBootstrapResult>;
  getWorkspaceRoster: Operation<WorkspaceRosterInput, WorkspaceRosterResult>;
  getRoomInbox: Operation<RoomCursorInput, RoomInboxResult>;
  getRoomConversation: Operation<RoomConversationInput, RoomConversationResult>;
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
  getCornerCloseRequests: Operation<CornerCursorInput, RoomInboxResult>;
  /** Long-poll: resolves as soon as the corner has something new, or on a bounded timeout. */
  waitForCornerWake: Operation<CornerInput, CornerWakeResult>;
  listUntrackedCorners: Operation<RoomInput, CornerListResult>;
  getRoomRepositoryState: Operation<RoomInput, RoomRepositoryStateResult>;
  getRoomGitHubToken: Operation<RoomInput, RoomGitHubTokenResult>;
  getRoomTargetBranch: Operation<RoomInput, RoomTargetBranchResult>;
  getIdentitySuccession: Operation<IdentityInput, IdentitySuccessionResult>;
  getAgentConfiguration: Operation<AgentRoomInput, AgentConfigurationResult>;
  getAgentPresence: Operation<AgentRoomInput, AgentPresenceResult>;
  getRequestCompletion: Operation<RequestInput, RequestCompletionResult>;
  postRoomMessage: Operation<PostRoomMessageInput, WriteResult>;
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
  postAgentCommands: Operation<PostAgentCommandsInput, WriteResult>;
  postAgentPresence: Operation<PostAgentPresenceInput, WriteResult>;
  postAgentModelCatalog: Operation<PostAgentModelCatalogInput, WriteResult>;
  postCornerLifecycle: Operation<PostCornerLifecycleInput, WriteResult>;
  postCornerRemoteState: Operation<PostCornerRemoteStateInput, WriteResult>;
  postCornerPlan: Operation<PostCornerPlanInput, WriteResult>;
  postTargetBranchProposal: Operation<PostTargetBranchProposalInput, WriteResult>;
  requestAgentGrant: Operation<RequestAgentGrantInput, RequestAgentGrantResult>;
  listAgentGrants: Operation<AgentInput, AgentGrantListResult>;
  consumeAgentGrant: Operation<ConsumeAgentGrantInput, WriteResult>;
  createCorner: Operation<CreateCornerInput, CornerResult>;
  archiveCorner: Operation<CornerInput, WriteResult>;
  ensureAgentMembership: Operation<AgentRoomInput, WriteResult>;
};

export type Operation<Input, Output> = { readonly input: Input; readonly output: Output };
export type RoomInput = { readonly roomId: string };
export type AgentInput = { readonly agentId: string };
export type AgentRoomInput = AgentInput & RoomInput;
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
 * recovers the objective. Never flip the shared sort to serve one of them; ask
 * for the window you need. A read that carries `after` keeps the inbox's
 * ascending cursor semantics and ignores this field.
 */
export type RoomConversationWindow = 'recent' | 'earliest';
export type RoomConversationInput = RoomCursorInput & {
  readonly window?: RoomConversationWindow;
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
  readonly items: readonly {
    readonly id: string;
    readonly authorId: string;
    readonly createdAt: number;
    readonly type: string;
    readonly body: string;
    /** Server-validated addressing and reply metadata needed by Room intake. */
    readonly mentionIds: readonly string[];
    readonly replyToMessageId?: string;
    readonly rootMessageId?: string;
    readonly requestId?: string;
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
export type RoomConversationResult = RoomInboxResult;
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
    readonly createdBy: string;
    readonly archived: boolean;
  }[];
};
export type CornerRestoreResult = {
  readonly cornerId: string;
  readonly featureBranch?: string;
  readonly requestId?: string;
  readonly closeRequested: boolean;
  /** Server-indexed GitHub facts retained across a helper restart. */
  readonly lifecycle?: CornerLifecycleView;
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
export type WriteResult = { readonly id: string; readonly createdAt: number };
export type PostRoomMessageInput = RoomInput & {
  readonly requestId?: string;
  readonly text: string;
  /** The daemon never phrases a system line; the server does (`system-line.ts`). */
  readonly presentation?: 'message' | 'card';
  readonly tags?: Readonly<Record<string, string>>;
  /** Validated peer addressing for monolith agent-to-agent turns. */
  readonly mentionIds?: readonly string[];
  readonly replyToMessageId?: string;
  /** Inbox message that started this turn; independent of optional reply threading. */
  readonly triggerMessageId?: string;
};
export type PostAgentAttachmentInput = RoomInput & {
  /** A daemon media upload result; the server verifies the media row is owned by the agent. */
  readonly attachment: DaemonAttachment;
};
export type PostLiveOutputInput = AgentRoomInput & {
  readonly turnId: string;
  readonly text: string;
};
export type RetractLiveOutputInput = AgentRoomInput & {
  readonly turnId: string;
  readonly kind: 'draft' | 'thought';
};
export type PostTurnReceiptInput = AgentRoomInput & {
  readonly requestId: string;
  readonly status: 'working' | 'complete' | 'failed';
  readonly generationId?: string;
  /** Refreshes an existing working receipt; never starts or resurrects a turn. */
  readonly heartbeat?: boolean;
  /** One distilled line (≤200 chars, no stack, secrets scrubbed) sent only with `failed`. */
  readonly reason?: string;
};
export type PostAgentActivityInput = AgentRoomInput & {
  readonly requestId: string;
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
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
};
export type PostAgentPresenceInput = AgentRoomInput & {
  readonly status: 'online' | 'offline';
  readonly releaseVersion?: string;
  readonly sourceSha?: string;
};
export type PostAgentModelCatalogInput = AgentInput & {
  readonly workspaceId: string;
  readonly options: readonly DaemonModelConfigOption[];
  readonly selection?: { readonly model?: string; readonly effort?: string };
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
export type PostTargetBranchProposalInput = RoomInput & {
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  readonly repository: string;
};
export type CreateCornerInput = RoomInput & {
  readonly requestId: string;
  /** The corner's title on every surface, limited to 3 whitespace-delimited words. */
  readonly name: string;
  /** Immutable one-paragraph objective, limited to 24 whitespace-delimited words. */
  readonly objective: string;
  readonly repository?: string;
  readonly targetBranch?: string;
};
export type CornerResult = { readonly cornerId: string };

/** request_grant: the agent raises its hand for one kind of reach in one Room. */
export type RequestAgentGrantInput = RoomInput & {
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

export type DaemonActivityItem = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
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
  readonly mergeability?: 'clean' | 'dirty' | 'unknown';
};
