import type { SystemEvent } from './system-events.js';
import type { AgentGrantKind, AgentGrantStatus } from './agent-grants.js';

export interface AttachmentReference {
  url: string;
  previewUrl?: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

export interface AgentModelConfigOption {
  id: string;
  category: string;
  currentValue?: string;
  options: Array<{ id: string; name?: string }>;
}

export interface AgentModelSelection {
  model?: string;
  effort?: string;
}

export type KnownMessageReference = {
  readonly channelId: string;
  readonly eventId: string;
  readonly rootId: string;
};

export type CornerLifecycleView = {
  readonly lifecycle: 'working' | 'in-review' | 'unknown' | 'done';
  readonly branch?: string;
  readonly checks: 'pending' | 'passing' | 'failing' | 'unknown';
  readonly pr?: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly targetBranch: string;
    readonly headSha: string;
    readonly mergeability?: 'clean' | 'dirty' | 'unknown';
    readonly baseSha?: string;
    readonly mergedAt?: string;
    readonly mergedBy?: string;
  };
  /** GitHub-webhook-owned check state for the PR head. */
  readonly checksSummary?: {
    readonly status: 'pending' | 'passing' | 'failing' | 'unknown';
    readonly total: number;
    readonly failing: readonly string[];
    readonly checks: readonly {
      readonly name: string;
      readonly status: 'pending' | 'passed' | 'failed';
      readonly conclusion?: string;
      readonly url?: string;
    }[];
    readonly updatedAt: number;
  };
  readonly outcome?: 'landed' | 'abandoned';
  readonly reason?: string;
};

export const ROOM_VIEW_MESSAGE_LIMIT = 30;
/** Kept separate from the conversation window for settled corner tool activity. */
export const ROOM_VIEW_TOOL_ROW_LIMIT = 60;
export const ROOM_VIEW_BRIEFING_LIMIT = 10;
export const ROOM_VIEW_WORKSPACE_LIMIT = 50;
export const ROOM_VIEW_CHAT_LIMIT = 200;
export const ROOM_VIEW_MEMBER_LIMIT = 200;
export const ROOM_VIEW_AGENT_LIMIT = 200;
export const ROOM_VIEW_REQUEST_TIMEOUT_MS = 8_000;

/** Opaque relay filters supplied by the authoritative surface query. */
export type SurfaceWatchFilter = {
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly '#h'?: readonly string[];
  readonly '#d'?: readonly string[];
  readonly '#p'?: readonly string[];
  readonly '#t'?: readonly string[];
};

export type RoomViewIdentity = {
  readonly pubkey: string;
  readonly kind: 'human' | 'agent';
  readonly name: string;
  readonly handle?: string;
  readonly avatar?: string;
  /** The chosen face (one of `FACE_IDS`); absent until the person picks one. */
  readonly face?: string;
};

export type RoomViewMember = {
  readonly identity: RoomViewIdentity;
  readonly role: 'owner' | 'admin' | 'member';
  readonly presence?: {
    readonly status: 'online' | 'offline';
    readonly observedAt: number;
    readonly roomId?: string;
  };
};

export type RoomViewHeader = {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly about?: string;
  readonly avatar?: string;
  readonly visibility?: 'public' | 'invite-only';
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type RoomViewActivity = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
  readonly operation?: string;
  readonly status?: string;
  /** Bounded, redacted tool argument summaries for the corner ledger. */
  readonly command?: string;
  readonly input?: string;
  /** Bounded first/last-line excerpt of a completed tool result. */
  readonly output?: string;
  readonly thoughtMs?: number;
  /** The identity whose message triggered the turn this row belongs to ("at Alex's request"). */
  readonly requestedBy?: { readonly pubkey: string; readonly name?: string };
  readonly rollup?: Readonly<Record<string, number>>;
  readonly observed?: readonly {
    readonly verb: string;
    readonly target?: string;
    readonly result?: string;
  }[];
  readonly files?: readonly { readonly path: string; readonly status?: string }[];
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};

export type RoomViewMessage = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  readonly author: RoomViewIdentity;
  readonly presentation: 'message' | 'system' | 'activity' | 'card';
  /** The structured event behind a server-phrased system line or card header;
   *  absent on rows written before the one system-line grammar. */
  readonly systemEvent?: SystemEvent;
  /** Proof that this exact message belongs to this Room, for reply signing. */
  readonly reference?: KnownMessageReference;
  readonly liveTurnId?: string;
  readonly requestId?: string;
  readonly attachments?: readonly AttachmentReference[];
  readonly mentionPubkeys?: readonly string[];
  /** Same-Room proof returned by the indexer and passed unchanged to reply signing. */
  readonly reply?: {
    readonly channelId: string;
    readonly eventId: string;
    readonly rootId: string;
  };
  readonly activity?: readonly RoomViewActivity[];
  readonly durableFact?: 'failure' | 'merge' | 'action';
  readonly corner?: {
    readonly id: string;
    readonly status: 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
  };
  readonly permission?: {
    readonly permissionId: string;
    readonly requestId: string;
    readonly agent: RoomViewIdentity;
    readonly requester: RoomViewIdentity;
    readonly decider?: RoomViewIdentity;
    readonly tool: string;
    readonly repository?: string;
    readonly purpose?: 'squire-spending';
    readonly status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    readonly cornerId?: string;
  };
  /** One grant card: the agent asks its owner; several asks in one turn share a card. */
  readonly grantRequest?: GrantRequestCardView;
  readonly targetBranch?: {
    readonly proposalId: string;
    readonly from: string;
    readonly to: string;
    readonly repository?: string;
    readonly agent?: RoomViewIdentity;
    readonly requester?: RoomViewIdentity;
  };
  /** A validated, service-published repository activity card. Never a speaker. */
  readonly githubEvent?: {
    readonly type: 'pull-request' | 'issue';
    readonly action: 'opened' | 'closed' | 'merged';
    readonly actor: string;
    readonly title: string;
    readonly url: string;
    readonly branch?: string;
    readonly targetBranch?: string;
  };
  /** A daemon-authored repository lifecycle fact, rendered as an actionable card. */
  readonly daemonFact?: {
    readonly type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    readonly cornerId: string;
    readonly objective: string;
    readonly outcome?: 'landed' | 'abandoned';
    readonly pullRequest?: {
      readonly number?: number;
      readonly title?: string;
      readonly url: string;
      readonly targetBranch?: string;
    };
    readonly subgoals?: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};

/** One line of a grant card and one row of the agent profile's grant list. */
export type AgentGrantView = {
  readonly grantId: string;
  readonly kind: AgentGrantKind;
  readonly target: string;
  readonly reason: string;
  readonly status: AgentGrantStatus;
  readonly requestedBy: RoomViewIdentity;
  readonly decidedBy?: RoomViewIdentity;
  readonly roomId: string;
  /** Absolute Unix timestamps in seconds. */
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly expiresAt?: number;
  /** True when approved under yolo without a card. */
  readonly auto: boolean;
};

export type GrantRequestCardView = {
  readonly agent: RoomViewIdentity;
  readonly owner: RoomViewIdentity;
  readonly requester: RoomViewIdentity;
  readonly grants: readonly AgentGrantView[];
};

export type RoomViewer = {
  readonly identity: RoomViewIdentity;
  readonly role: 'owner' | 'admin' | 'member';
  readonly permissions: {
    readonly send: boolean;
    readonly manage: boolean;
  };
};

export type RoomDirectMessageView = {
  readonly participants: readonly [string, string];
};

/** Latest durable turn lifecycle fact for one Room agent. */
export type RoomViewAgentTurn = {
  readonly requestId: string;
  readonly agentPubkey: string;
  readonly status: 'working' | 'complete' | 'failed';
  /** Relay event time in Unix seconds. */
  readonly createdAt: number;
  readonly generationId?: string;
};

export type RoomView = {
  readonly room: RoomViewHeader;
  readonly messages: readonly RoomViewMessage[];
  /** Settled corner tool activity, outside the bounded conversation window. */
  readonly toolRows?: readonly RoomViewMessage[];
  readonly members: readonly RoomViewMember[];
  readonly latestAgentTurns: readonly RoomViewAgentTurn[];
  readonly viewer: RoomViewer;
  readonly directMessage?: RoomDirectMessageView;
  readonly parent?: RoomViewHeader;
  readonly briefing?: readonly RoomViewMessage[];
  /** Latest corner plan, retained after its live activity rows settle. */
  readonly cornerPlan?: RoomViewActivity['plan'];
  readonly repository?: RoomRepositoryView;
  readonly repositoryResolution: RoomRepositoryResolution;
  /** GitHub-derived lifecycle for this Room when it is a repository corner. */
  readonly cornerLifecycle?: CornerLifecycleView;
  readonly corners: readonly CornerListItem[];
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type RoomHistoryView = {
  readonly roomId: string;
  readonly messages: readonly RoomViewMessage[];
  readonly nextBefore?: { readonly createdAt: number; readonly id: string };
};

/** Prompt-ready conversation rows supplied directly by the Room endpoint. */
export type AgentHistoryEntry = {
  readonly eventId: string;
  readonly channelId: string;
  readonly type: 'human-message' | 'agent-message';
  readonly author: {
    readonly pubkey: string;
    readonly kind: 'human' | 'agent';
    readonly label: string;
  };
  readonly body: string;
  readonly attachments: readonly AttachmentReference[];
  readonly createdAt: number;
  readonly provenance: 'relay-verified' | 'monolith-verified';
};

export type ChatListItem = {
  readonly room: RoomViewHeader;
  readonly latestMessage?: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
    readonly author: RoomViewIdentity;
  };
  readonly memberCount: number;
  readonly cornerCount: number;
  /** Server-owned, cross-device read state. Every accepted list response carries it. */
  readonly unread: boolean;
  readonly repositoryName?: string;
  /**
   * Max-severity rollup of this Room's own conversational turn and every one
   * of its corners' current lifecycle state: `needs-you` when any corner is
   * waiting on a human, else `working` when the Room's own turn or any
   * corner is actively working, else absent (idle). Message `unread` is a
   * separate, independent needs-you signal — the deck combines both.
   */
  readonly agentState?: 'needs-you' | 'working';
  /**
   * Present only for a direct Room: the one participant who is not the
   * viewer. The index names a DM row by this identity (`@peer`), never by
   * the stored Room name.
   */
  readonly directMessage?: { readonly peer: RoomViewIdentity };
};

export type ChatListWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  readonly visibility: 'public' | 'invite-only';
  readonly role: 'owner' | 'admin' | 'member';
  readonly updatedAt: number;
};

export type ChatListView = {
  readonly workspace: ChatListWorkspace;
  readonly chats: readonly ChatListItem[];
  readonly viewer: RoomViewIdentity;
  readonly truncated: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type WorkspaceListView = {
  readonly workspaces: readonly ChatListWorkspace[];
  readonly viewer: RoomViewIdentity;
  readonly truncated: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type WorkspaceView = {
  readonly workspace: ChatListWorkspace & {
    readonly about?: string;
    readonly createdAt: number;
  };
  readonly managerSettings?: {
    readonly visibility: 'public' | 'invite-only';
  };
  readonly members: readonly RoomViewMember[];
  readonly agents: readonly RoomViewMember[];
  readonly membersTruncated: boolean;
  readonly agentsTruncated: boolean;
  readonly viewer: RoomViewer;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type AgentDetailView = {
  readonly workspaceId: string;
  readonly agent: RoomViewMember;
  /**
   * Latest valid human-authored soul overlay. The indexed read exposes this so
   * a name-only edit can preserve the agent's existing instructions exactly.
   */
  readonly soul?: {
    readonly name: string;
    readonly instructions: string;
    readonly avatarSeed: string;
    readonly avatar?: string;
  };
  readonly catalog: readonly AgentModelConfigOption[];
  readonly runtimeSelection?: AgentModelSelection;
  readonly selected?: AgentModelSelection;
  /**
   * The agent "yolo" switch: grant requests are approved without asking.
   * `canChange` is the server's verdict for this viewer (agent owner or a
   * workspace admin); the phone mirrors it, never decides it.
   */
  readonly yolo?: AgentYoloView;
  /** The grant store: every non-pending grant, newest first. */
  readonly grants?: readonly AgentGrantView[];
  /** Server verdict: this viewer may decide and revoke this agent's grants. */
  readonly canManageGrants?: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type AgentYoloView = {
  readonly enabled: boolean;
  readonly setBy?: { readonly name: string };
  /** Absolute Unix timestamp in seconds. */
  readonly setAt?: number;
  readonly canChange: boolean;
};

export type InviteView = {
  readonly name: string;
  readonly avatar?: string;
  /** Absolute Unix timestamp in seconds. */
  readonly expiresAt: number;
};

/** Result of the server-authorized Workspace pairing bootstrap. */
export type AgentPairingClaimView = {
  readonly workspaceId: string;
  readonly pairedBy: string;
  /** False only when the same agent repeats its already-reserved claim. */
  readonly joined: boolean;
  /** Top-level Rooms the agent inherited from the pairing-code minter. */
  readonly attachedRoomIds: readonly string[];
};

export type AgentPairingClaimWireView = Omit<AgentPairingClaimView, 'attachedRoomIds'> & {
  readonly attachedRoomIds?: readonly string[];
};

export type AgentPairingAbandonView = {
  /** True only when this code is claimed by the authenticated agent. */
  readonly abandoned: boolean;
};

export type CornerListItem = {
  readonly corner: RoomViewHeader;
  readonly lifecycle: CornerLifecycleView;
  readonly status: 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
  /** Timestamp of the fact that produced `status`. A working status uses the
   * latest child turn receipt rather than the corner metadata timestamp. */
  readonly statusAt?: number;
  readonly reason?: 'review' | 'question' | 'failure';
  readonly agent?: RoomViewIdentity;
  readonly latestMessage?: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
    readonly author: RoomViewIdentity;
  };
};

export type CornerListView = {
  readonly room: RoomViewHeader;
  readonly corners: readonly CornerListItem[];
  readonly viewer: RoomViewer;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

export type RoomRepositoryView = {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch: string;
  /** Relay event time used to distinguish stale projection from a newer conflicting write. */
  readonly updatedAt: number;
  readonly githubInstallationId?: number;
  readonly githubEventsEnabled: boolean;
};

/**
 * What the server-indexed Room read can establish about its repository.
 *
 * A repository event whose author no longer projects as a current Room admin
 * is not evidence that the Room has no repository. It is deliberately
 * exposed as `unverified` so callers never turn an authorization-read gap
 * into a repo-picker prompt.
 */
export type RoomRepositoryResolution = 'repository' | 'none' | 'unverified';
