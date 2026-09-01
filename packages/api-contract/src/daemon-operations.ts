export type DaemonOperationMap = {
  getDaemonBootstrap: Operation<DaemonBootstrapInput, DaemonBootstrapResult>;
  getWorkspaceRoster: Operation<WorkspaceRosterInput, WorkspaceRosterResult>;
  getRoomInbox: Operation<RoomCursorInput, RoomInboxResult>;
  getRoomConversation: Operation<RoomCursorInput, RoomConversationResult>;
  getRoomAuthority: Operation<RoomPrincipalInput, RoomAuthorityResult>;
  getPermissionAuthority: Operation<PermissionAuthorityInput, AuthorityDecisionResult>;
  getMissionAuthority: Operation<MissionAuthorityInput, AuthorityDecisionResult>;
  listWorkSchedules: Operation<AgentInput, WorkScheduleListResult>;
  getWorkScheduleAuthority: Operation<WorkScheduleAuthorityInput, AuthorityDecisionResult>;
  listAgentToolSchedules: Operation<AgentRoomInput, WorkScheduleListResult>;
  getAgentToolMandate: Operation<AgentRoomInput, AgentToolMandateResult>;
  getTargetAgentAuthority: Operation<TargetAgentAuthorityInput, AuthorityDecisionResult>;
  listRoomCorners: Operation<RoomInput, CornerListResult>;
  getCornerRestoreState: Operation<CornerInput, CornerRestoreResult>;
  getCornerCloseRequests: Operation<CornerCursorInput, RoomInboxResult>;
  listUntrackedCorners: Operation<RoomInput, CornerListResult>;
  getRoomRepositoryState: Operation<RoomInput, RoomRepositoryStateResult>;
  getRoomTargetBranch: Operation<RoomInput, RoomTargetBranchResult>;
  getIdentitySuccession: Operation<IdentityInput, IdentitySuccessionResult>;
  getAgentConfiguration: Operation<AgentRoomInput, AgentConfigurationResult>;
  getAgentPresence: Operation<AgentRoomInput, AgentPresenceResult>;
  getRequestCompletion: Operation<RequestInput, RequestCompletionResult>;
  postRoomMessage: Operation<PostRoomMessageInput, WriteResult>;
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
  /** Establish a high-water mark without replaying pre-activation history. */
  readonly startAtLatest?: boolean;
};
export type RoomPrincipalInput = RoomInput & { readonly principalId: string };
export type CornerCursorInput = CornerInput & { readonly after?: string };
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
  }[];
  readonly cursor?: string;
};
export type DaemonAttachment = {
  readonly url: string;
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
};
export type RoomRepositoryStateResult = {
  readonly key?: string;
  readonly remote?: string;
  readonly targetBranch?: string;
  readonly resolution: 'repository' | 'none' | 'unverified';
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
  readonly presentation?: 'message' | 'system' | 'card';
  readonly tags?: Readonly<Record<string, string>>;
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
  readonly name: string;
  readonly task: string;
  readonly repository?: string;
  readonly targetBranch?: string;
};
export type CornerResult = { readonly cornerId: string };

export type DaemonActivityItem = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
  readonly operation?: string;
  readonly status?: string;
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
