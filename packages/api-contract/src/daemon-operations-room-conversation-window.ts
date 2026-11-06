import type { TurnReplay } from './turn-replay.js';
import type { AppRoute, AppTransport, ConnectAppStatus } from './app-connections.js';
import type { CornerMergeHold } from './phone-operations.js';
import type { SystemEvent } from './system-events.js';
import type { CornerLifecycleView, MessageReactionEmoji } from './phone-types.js';
import { RoomCursorInput, RoomInput, CornerInput, AgentRoomInput, AgentInput, AgentMemberMetadata } from './daemon-operations-daemon-operation-map.js';
import { TurnOutputAuthority } from './daemon-operations.js';
import { DaemonActivityItem, DaemonPermissionScope, DaemonAgentToolMandate, DaemonModelConfigOption, DaemonPullRequestFact } from './daemon-operations-revise-corner-brief-input.js';


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
  /** With the `recent` window: the newest page strictly older than this cursor. */
  readonly before?: string;
  /** Include narration already saved for this turn, so a retry can avoid repeating it. */
  readonly narrationRequestId?: string;
};

export type RoomPrincipalInput = RoomInput & { readonly principalId: string };

export type CornerCursorInput = CornerInput & {
  readonly after?: string;
};

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
  /** Explicit member Room/corner lifecycle facts for private storage reclamation.
   * Absent on older servers: no immediate archive cleanup; disposable files
   * may still expire under the seven-day unused-file rule. */
  readonly storageRooms?: readonly {
    readonly workspaceId?: string;
    readonly roomId: string;
    readonly archived: boolean;
    /** Exact PR head accepted by a confirmed merge, including squash merges. */
    readonly landedHeadSha?: string;
  }[];
  readonly workspaceIds: readonly string[];
  /** Command-bearing surfaces to bind before background Room discovery. */
  readonly pendingRooms?: readonly {
    readonly roomId: string;
    readonly parentRoomId?: string;
    readonly openedBy?: string;
  }[];
  readonly rooms: readonly {
    readonly roomId: string;
    readonly archived: boolean;
    /** Changes when the repository binding or its GitHub installation changes. */
    readonly repositoryRevision?: string;
  }[];
};

export type WorkspaceRosterResult = {
  readonly members: readonly (AgentMemberMetadata & {
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
  })[];
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
    readonly agentAuthor?: boolean;
    readonly replyToMessageId?: string;
    /** Current author of the reply parent, projected by the server. */
    readonly replyToAuthorId?: string;
    /** Current display name of the reply parent author. */
    readonly replyToAuthorName?: string;
    /** Quoted by the body as untrusted text; at most 300 characters. */
    readonly replyToExcerpt?: string;
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
  /** Hex sha256 of the stored bytes; set by getRoomMessage while the object is ready. */
  readonly sha256?: string;
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
  /** Current server assignment, used to hand legacy local work to its writer. */
  readonly implementerAgentId?: string;
  readonly cornerId: string;
  /** Explicit opening corner; absent on existing and Room/DM-opened corners. */
  readonly openedFromCornerId?: string;
  /** Present on servers that expose archived corners to active-only discovery helpers. */
  readonly archived?: boolean;
  /** Parent Room retained after archival so a helper can locate its local worktree. */
  readonly parentRoomId?: string;
  /** Current objective from the authoritative corner fact. */
  readonly objective: string;
  /** Current immutable assignment, absent on corners opened before briefs. */
  readonly brief?: CornerBrief;
  /** Human-created corners are title-only; their title supplies runtime context after a tag. */
  readonly title?: string;
  /** True while `title` is still the generated one the corner was opened under. */
  readonly titleGenerated?: boolean;
  readonly kind?: 'agent' | 'human';
  readonly featureBranch?: string;
  readonly requestId?: string;
  readonly closeRequested: boolean;
  /** True while a human hold stands on this corner; a held corner publishes nothing. */
  readonly held?: boolean;
  readonly holds?: CornerMergeHold[];
  /** Server-indexed GitHub facts retained across a helper restart. */
  readonly lifecycle?: CornerLifecycleView;
  /** The latest manager merge request, bound to the exact PR revision it approved. */
  readonly mergeApproval?: {
    readonly pullRequestNumber: number;
    readonly headSha: string;
  };
  readonly state?: import('./phone-types.js').CornerState;
  /** Worker or reviewer running/queued, or checks running; otherwise idle. */
  readonly activity?: 'running' | 'idle';
  /** The newest visible message (activity rows excluded); excerpt is at most 280 characters. */
  readonly lastMessage?: {
    readonly authorId: string;
    readonly createdAt: string;
    readonly type: 'message' | 'system' | 'card';
    readonly excerpt: string;
  };
  /** `reply` when the corner is idle, has no PR, and its newest message is from an agent. */
  readonly awaiting?: 'reply';
};

export type RoomRepositoryStateResult = {
  readonly repositoryOnboarding?: boolean;
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
  readonly fastMode?: boolean;
  readonly commands: readonly { readonly name: string; readonly description?: string }[];
  /** The agent "yolo" switch: grant requests are approved without asking. */
  readonly yoloMode: boolean;
  /** Whether this agent holds the parent Room's reviewer post for this corner, by the exact predicate `approve_merge` enforces. */
  readonly isReviewer: boolean;
  /** Live reviewer configured on a corner's parent Room; absent for self-review. */
  readonly reviewerHandle?: string;
  /** Connected Registry remotes mounted through the Body-owned credential broker. */
  readonly registryMcpRoutes?: readonly RegistryMcpRoute[];
};

export type RegistryMcpRemote = {
  readonly type: 'streamable-http' | 'sse';
  readonly url: string;
};

export type RegistryMcpPackage = {
  readonly registryType?: string;
  readonly identifier?: string;
  readonly version?: string;
  readonly transport?: string;
};

export type RegistryMcpManifest = {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly description?: string;
  readonly websiteUrl?: string;
  readonly repository?: { readonly url?: string; readonly source?: string };
  readonly remotes: readonly RegistryMcpRemote[];
  readonly packages: readonly RegistryMcpPackage[];
  /** Declared secret input names only. Values never cross this contract. */
  readonly secretInputNames: readonly string[];
};

export type RegistryMcpRoute = {
  readonly connectorId: string;
  readonly serverName: string;
  readonly displayName: string;
  readonly routeName: string;
  readonly target: string;
};

export type SearchMcpRegistryInput = RoomInput & {
  readonly query: string;
  readonly limit?: number;
};

export type SearchMcpRegistryResult = { readonly servers: readonly RegistryMcpManifest[] };

export type ConnectMcpServerInput = TurnOutputAuthority &
  RoomInput & {
    readonly serverName: string;
    readonly version: string;
    readonly reason: string;
    readonly handoffToOwner?: boolean;
  };

export type ConnectMcpServerResult =
  | { readonly status: 'connected' | 'connecting'; readonly connectorId: string }
  | {
      readonly status: 'needs_sign_in';
      readonly connectorId: string;
      readonly authorizationUrl: string;
    }
  | { readonly status: 'unsupported'; readonly reason: string };

export type ConnectAppInput = TurnOutputAuthority &
  RoomInput & {
    /** The app's name or website, e.g. `Linear` or `linear.app`. */
    readonly app: string;
    readonly reason: string;
    /** Display-only promise on a managed sign-in card, never a command. */
    readonly continuation?: string;
    /** Re-resolve the route from the top, for an app in error. */
    readonly reconnect?: boolean;
    /** Squire found no API for this app: move its API route to the browser. */
    readonly noApi?: boolean;
  };

export type ConnectAppResult = {
  readonly status: ConnectAppStatus;
  readonly appId?: string;
  readonly app: string;
  readonly appKey?: string;
  /** The route this call chose, when it chose one; absent when it kept one. */
  readonly route?: AppRoute;
  /** What serves the app now. */
  readonly transport?: AppTransport;
  readonly connectorId?: string;
  /** Exact selected vault reference for a Squire route; metadata only. */
  readonly connectionReference?: string;
  /** The provider sign-in page Squire should open (never pasted into chat). */
  readonly authorizationUrl?: string;
  /** Server-owned next step, in one or two sentences. */
  readonly next: string;
};

export type ConnectInput = Omit<ConnectAppInput, 'app'> & {
  readonly service: string;
  readonly switchGoogleAccount?: boolean;
  /** Set by the agent MCP from this session's granted Squire relay. */
  readonly squireAvailable?: boolean;
  /** A page only a signed-in user can open; the agent MCP checks it in the agent's own Squire session. */
  readonly signedInUrl?: string;
  /** Set by the agent MCP after that check found `signedInUrl` signed in. */
  readonly squireSignedIn?: boolean;
};

export type ConnectorSearchMatch = {
  readonly key: string; readonly service: string; readonly name: string; readonly website?: string;
  readonly source: 'machine' | 'first-party' | 'registry' | 'composio' | 'squire';
  readonly status: 'connected' | 'not-connected' | 'broken';
};

export type ConnectResult = Omit<ConnectAppResult, 'status'> & {
  readonly status: 'ready' | 'needs_sign_in' | 'needs_approval' | 'needs_squire' | 'error' | 'unavailable';
  /** Instructions for the calling agent's own Squire tools, never a helper job. */
  readonly squire?: { readonly url: string; readonly goal: string };
  readonly approvalUrl?: string;
  readonly grantId?: string;
};

export type AgentPresenceResult = {
  readonly status: 'online' | 'offline' | 'dormant';
  readonly observedAt?: number;
  readonly releaseVersion?: string;
  readonly sourceSha?: string;
};

export type RequestCompletionResult = {
  readonly openedCornerId?: string;
  /** Terminal execution, including failure; inspect outcome before claiming success. */
  readonly completed: boolean;
  readonly outcome?: 'complete' | 'failed';
  readonly failureReason?: string;
};

export type WriteResult = {
  readonly id: string;
  readonly createdAt: number;
  /** Whether the terminal failure reached its recorded commander; false preserves the failed turn. */
  readonly failureReportDelivered?: boolean;
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
    /**
     * The turn's steps, in order: its tool calls and every text run before
     * the final one (`kind='note'`). They ride on the reply, so text written
     * before a tool call is kept without leading the answer.
     */
    readonly steps?: readonly DaemonActivityItem[];
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
    /** Current narration run, coalesced across token deltas; not the whole turn. */
    readonly latestChunk?: string;
  };

export type RetractLiveOutputInput = TurnOutputAuthority &
  AgentRoomInput & {
    readonly turnId: string;
    readonly kind: 'draft' | 'thought';
  };

export type PostTurnReceiptInput = AgentRoomInput & {
  /** Invocation diagnostics and usage only; an unanswered command stays claimed. */
  readonly diagnosticsOnly?: boolean;
  /** Current owner ends model-dependent work without claiming provider failure
   * or delivery. An unreadable private journal ends only owner authority, not provider outcome. */
  readonly modelOwnerEnd?: Readonly<{ requestId: string } | { journalUnavailable: true }>;
  readonly trace?: TurnReplay;
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
  /**
   * The turn's REAL prompt token cost as the harness itself reported it (pi's
   * session record: uncached input + cache reads + cache writes), and the exact
   * byte length of the prompt that produced it. Optional because most harnesses
   * expose no usage at all; absent is "unknown", never zero, and the rollout
   * budget gate falls back to its byte estimate rather than inventing a number.
   */
  readonly inputTokens?: number;
  readonly promptBytes?: number;
  /** Sum of recorded prompt usage across every model call and attempt in this turn. */
  readonly totalInputTokens?: number;
  /**
   * Output tokens the harness reported for this turn. Optional, so an older
   * daemon that omits it leaves the turn unmeasured instead of zero.
   */
  readonly outputTokens?: number;
  /** Calls included in the total, and calls whose usage was unavailable. */
  readonly modelCalls?: number;
  readonly modelCallsWithoutUsage?: number;
  /** Distinct tool calls this turn made, counted from the harness's own stream. */
  readonly toolCalls?: number;
  /** Typed Room-safe classification; detail stays in the daemon log. */
  readonly reasonKind?:
    | 'hiccup'
    | 'wrong-model'
    | 'allowance-spent'
    | 'not-signed-in'
    | 'workspace-failure'
    | 'helper-out-of-date'
    | 'update-interrupted'
    | 'process-exited'
    | 'offline'
    | 'context-overflow'
    | 'resource-limit'
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
  readonly purpose?: string;
  readonly permissionId: string;
  readonly requestId: string;
  readonly scope: DaemonPermissionScope;
};

export type PostPermissionExecutionInput = PermissionAuthorityInput & {
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly result?: string;
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
  /** The harness kind (`AGENT_KINDS` in `apps/body/src/agent-command.ts`); the automatic "harness" tag. */
  readonly harness?: string;
};

export type CornerWatchKind = 'opened' | 'merged';

export type CornerWatchResult = {
  readonly kinds: readonly CornerWatchKind[];
  /**
   * `merged`: the corner already merged; no watch is stored and `woken` says
   * whether one merge wake was queued now. `closed`: it closed without merging.
   */
  readonly state: 'active' | 'merged' | 'closed';
  readonly woken?: boolean;
  readonly snapshot: {
    readonly id: string;
    readonly name: string;
    readonly workflowState: string | null;
    readonly pullRequestNumber: number | null;
    readonly pullRequestUrl: string | null;
    readonly headSha: string | null;
    readonly checks: string | null;
    readonly mergeCommitSha: string | null;
  };
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
  readonly purpose?: string;
  readonly requestId: string;
  readonly from: string;
  readonly to: string;
  readonly repository: string;
};

export type CreateCornerInput = TurnOutputAuthority &
  RoomInput & {
    /** Exact handle, without @, of an agent member of the parent Room; defaults to the caller. */
    readonly implementer?: string;
    readonly reviewer?: string;
    readonly hold?: boolean;
    readonly sourceMessageId?: string;
    /** Target parent Room; the active command may be in a DM or another Room. */
    readonly targetRoomId?: string;
    readonly requestId: string;
    /** Stable for one tool call, distinct between separate calls in the same turn. */
    readonly idempotencyKey?: string;
    /** The corner's title on every surface, limited to 3 whitespace-delimited words. */
    readonly name: string;
    /** Immutable one-paragraph objective, limited to 24 whitespace-delimited words. */
    readonly objective: string;
    /** Full assignment; the short objective remains a navigation summary. */
    readonly brief?: CornerBriefDraft;
    readonly repository?: string;
    readonly targetBranch?: string;
  };

export type CornerBriefAttachment = {
  readonly objectId: string;
  readonly title: string;
  readonly purpose: string;
  readonly required: boolean;
  readonly mime: string;
  readonly sha256: string;
  readonly size: number;
};

/** Spec length cap shared by `open_corner`, `revise_corner_brief` and the server. */
export const CORNER_BRIEF_SPEC_MAX_LENGTH = 16_000;

export type CornerBriefDraft = {
  /**
   * Agent-written Markdown: the human intent quoted, the user stories it
   * enables, what is not being done, the risks, and references (a mock
   * when requested or useful), as headings inside one doc.
   */
  readonly spec: string;
  /** False when no repository files are assigned or edits/PRs are forbidden; attachments are separate. */
  readonly repositoryWork?: boolean;
  /** Optional for opening and commander-direct revisions; other revisers need a human message or commander order. The server quotes it. */
  readonly approval?: { readonly sourceMessageId: string };
  readonly attachments?: readonly {
    readonly objectId: string;
    readonly purpose: string;
    readonly required: boolean;
  }[];
  readonly change?: string;
};

export type CornerBriefApproval = {
  /** Absent on legacy approvals; evidence only, never merge authority. */
  readonly kind?: 'agent-initiated' | 'initiating-command' | 'explicit-human-answer' | 'commander-order' | 'commander-direct';
  readonly replyToMessageId?: string | null;
  readonly replyToAttachmentIds?: readonly string[];
  readonly replyToCreatedAt?: string | null;
  readonly approvedAt?: string;
  readonly sourceMessageId: string;
  /** The approving message's exact text, resolved by the server. */
  readonly text: string;
  readonly approvedBy: string;
  readonly approverName: string;
};

export type CornerBrief = {
  readonly id: string;
  readonly revision: number;
  /**
   * Markdown. Revisions written before the trimmed brief fold their typed
   * fields into it on read (## Intent, ## Checklist, ## Non-goals,
   * ## References, then the old build spec).
   */
  readonly spec: string;
  /** False when no repository files are assigned or edits/PRs are forbidden; attachments are separate. */
  readonly repositoryWork?: boolean;
  /** Absent only on revisions that predate approvals. */
  readonly approval?: CornerBriefApproval;
  readonly change?: string;
  readonly authorId: string;
  readonly sourceRoomId: string;
  readonly sourceMessageId?: string;
  readonly attachments: readonly CornerBriefAttachment[];
};
