import type { SystemEvent } from './system-events.js';
import type { AgentGrantKind, AgentGrantStatus, CommandGrantScript } from './agent-grants.js';
import type { ChoiceMode, ChoiceOptionView, ChoiceStatus } from './room-choices.js';
import type { AgentAccessPolicy } from './agent-access.js';
import type { ConnectorOfferCardView } from './connector-offers.js';
import type {
  CornerAppBindingView,
  CornerAppInstallationView,
  CornerAppView,
} from './corner-apps.js';

export interface AttachmentReference {
  url: string;
  /** Server fact: the bytes are past the media TTL and gone. Name, type and
   *  size survive on the message, so a client renders "expired", not a spinner. */
  expired?: boolean;
  previewUrl?: string;
  name: string;
  mimeType: string;
  size: number;
  sha256?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  /** Object-storage artifact facts, stamped by the server projection
   *  (packages/api-contract/src/artifacts.ts). */
  kind?: 'artifact';
  title?: string;
  author?: string;
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
    readonly mergeability?: 'clean' | 'dirty' | 'unknown' | 'other';
    readonly baseSha?: string;
    readonly mergedAt?: string;
    readonly mergedBy?: string;
    readonly mergeCommitSha?: string;
  };
  /** GitHub's authoritative check rollup for the PR head, refreshed after webhooks. */
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

/** The server-owned corner state vocabulary. Clients render this field; they
 * never derive a second state from lifecycle, PR, check, or turn facts. */
export type CornerState = 'working' | 'waiting' | 'review' | 'archived';
export type CornerStateReason = 'failed' | 'checks-failed' | 'question';

export const ROOM_VIEW_MESSAGE_LIMIT = 30;
/** Kept separate from the conversation window for settled corner tool activity. */
export const ROOM_VIEW_TOOL_ROW_LIMIT = 60;
export const ROOM_VIEW_BRIEFING_LIMIT = 10;
export const ROOM_VIEW_WORKSPACE_LIMIT = 50;
export const ROOM_VIEW_CHAT_LIMIT = 200;
export const ROOM_VIEW_MEMBER_LIMIT = 200;
export const ROOM_VIEW_AGENT_LIMIT = 200;
/**
 * One page of the Workspace Members roster. MemberRosterRow is `hull.layout.row`
 * (64pt). After the Members header, search field, and two section heads, a
 * typical phone viewport paints about eight rows; 20 is roughly two-and-a-half
 * screens, so the first paint stays cheap on #welcome without copying the
 * 200-Room settings bound. Load-more is explicit. RoomView.members still uses
 * ROOM_VIEW_MEMBER_LIMIT.
 */
export const WORKSPACE_MEMBER_PAGE_SIZE = 20;
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

/** Paint-ready agent metadata for the Workspace Members row. */
export type WorkspaceAgentView = RoomViewMember & {
  /** Selected model label, resolved from the latest catalog when available. */
  readonly model?: string;
  /** The person who connected and owns this agent's configuration. */
  readonly owner?: RoomViewIdentity;
};

export type RoomViewHeader = {
  readonly id: string;
  /** Absent when this bundle could not read it; callers fall back to their own workspace context. */
  readonly workspaceId?: string;
  readonly parentId?: string;
  readonly name: string;
  readonly about?: string;
  readonly avatar?: string;
  readonly visibility?: 'public' | 'invite-only';
  /** Agent configured to review repository corners opened from this Room. */
  readonly reviewerAgentId?: string;
  /** Absent when this bundle could not read it: a Room whose live/closed state
   *  is unknown is never painted as live. */
  readonly archived?: boolean;
  readonly createdAt?: number;
  /** Absent when this bundle could not read it; a surface omits the age rather
   *  than dating the Room from the epoch. */
  readonly updatedAt?: number;
};

export type RoomViewActivity = {
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
  readonly relay?: {
    readonly fromRoomId: string;
    readonly toRoomId: string;
    readonly direction: 'down' | 'up';
    readonly fromName: string;
    readonly cornerId: string;
    readonly anchorMessageId?: string;
    readonly received: boolean;
    readonly reply?: 'once';
    readonly askId?: string;
    readonly answerMessageId?: string;
    readonly unanswered?: boolean;
  };
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  /** Millisecond creation stamp used only for stable transcript ordering. */
  readonly createdAtMs?: number;
  readonly author: RoomViewIdentity;
  readonly presentation: 'message' | 'system' | 'activity' | 'card';
  /** The original text and attachments were removed; this row remains as a transcript record. */
  readonly deleted?: boolean;
  /** Private viewer state. Omitted unless this viewer saved the message. */
  readonly bookmarked?: boolean;
  /** The structured event behind a server-phrased system line or card header;
   *  absent on rows written before the one system-line grammar. */
  readonly systemEvent?: SystemEvent;
  /** Proof that this exact message belongs to this Room, for reply signing. */
  readonly reference?: KnownMessageReference;
  readonly liveTurnId?: string;
  readonly requestId?: string;
  readonly attachments?: readonly AttachmentReference[];
  readonly mentionPubkeys?: readonly string[];
  /** The model that produced this agent reply, stamped at generation time on
   *  the server. Absent on rows before the stamp existed and on non-agent
   *  rows; the byline falls back to no model, never a roster lookup. */
  readonly agentModel?: string;
  /** Fixed-vocabulary reactions with the canonical identities of each reactor. */
  readonly reactions?: readonly MessageReactionView[];
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
    readonly state: CornerState;
  };
  /** An agent request to open one persisted app in this corner. */
  readonly cornerApp?: {
    readonly slug: string;
    readonly title: string;
    readonly revision: number;
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
  /** One connector offer: the agent reaches for a Workbench tool it needs (R5). */
  readonly connectorOffer?: ConnectorOfferCardView;
  /** One preference card: a lettered question or a Room poll. Never authority. */
  readonly choice?: ChoiceCardView;
  readonly targetBranch?: {
    readonly proposalId: string;
    readonly from: string;
    readonly to: string;
    readonly repository?: string;
    readonly agent?: RoomViewIdentity;
    readonly requester?: RoomViewIdentity;
  };
  /** A validated, service-published repository activity card. Never a speaker.
   *  Issues and pull requests only. `type` and `action` are plain strings on
   *  purpose: a client must tolerate a card kind a newer server posts and
   *  simply not draw it, rather than rejecting the whole Room. */
  readonly githubEvent?: {
    readonly type: string;
    readonly action: string;
    readonly actor: string;
    readonly title: string;
    readonly url: string;
    readonly branch?: string;
    readonly targetBranch?: string;
  };
  /** A daemon-authored repository lifecycle fact, rendered as an actionable card. */
  /** The @wallet ledger line: every transaction, in and out. */
  readonly walletTx?: {
    readonly direction: 'in' | 'out';
    readonly amountText: string;
    readonly counterparty: string;
    readonly chain: string;
    readonly balanceAfterUsd: string;
    readonly txUrl?: string;
    readonly agentName?: string | null;
  };
  /** The one non-transaction @wallet message: a refused payment. */
  readonly walletInsufficient?: {
    readonly agentName?: string | null;
    readonly needed: string;
    readonly available?: string | null;
    readonly asset: string;
    readonly chain: string;
    readonly reason?: string;
  };
  /** The delegation grant/renewal fact in the @wallet thread. */
  readonly walletDelegation?: {
    readonly expiresAt: number;
    readonly ttlHours: number;
  };
  readonly daemonFact?: {
    readonly type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    readonly cornerId: string;
    /** The corner's short title (at most three words). Absent only on legacy cards. */
    readonly name?: string;
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

/** One private, Workspace-scoped pointer back to a durable message. */
export type MessageBookmarkView = {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly roomKind: 'room' | 'corner';
  readonly messageCreatedAt: number;
  readonly bookmarkedAt: number;
  /** False after deletion or when the viewer no longer has source access. */
  readonly available: boolean;
  readonly author?: RoomViewIdentity;
  readonly text?: string;
};

export const MESSAGE_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;
export type MessageReactionEmoji = (typeof MESSAGE_REACTION_EMOJIS)[number];
export type MessageReactionView = {
  readonly emoji: MessageReactionEmoji;
  readonly count: number;
  readonly reacted: boolean;
  /** Canonical identities in reaction order; omitted by older servers. */
  readonly members?: readonly RoomViewIdentity[];
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
  /**
   * For an interpreter command, the script the approval is bound to: the card
   * shows these bytes and the runner refuses if the file no longer hashes to
   * them (C94).
   */
  readonly script?: CommandGrantScript;
};

/** One @wallet ledger card (the mobile twin of the server card payload). */
export type WalletTxCardView = NonNullable<RoomViewMessage['walletTx']>;
export type WalletInsufficientCardView = NonNullable<RoomViewMessage['walletInsufficient']>;
export type WalletDelegationCardView = NonNullable<RoomViewMessage['walletDelegation']>;

export type GrantRequestCardView = {
  readonly agent: RoomViewIdentity;
  readonly owner: RoomViewIdentity;
  readonly requester: RoomViewIdentity;
  readonly grants: readonly AgentGrantView[];
  /** The message that caused a Squire route ask, when this card is in the owner's connector DM. */
  readonly sourceRoomId?: string;
  readonly sourceMessageId?: string;
};

/** One lettered question or Room poll. Options are plates, never ledger rows. */
export type ChoiceCardView = {
  readonly choiceId: string;
  readonly mode: ChoiceMode;
  readonly status: ChoiceStatus;
  readonly agent: RoomViewIdentity;
  readonly requester?: RoomViewIdentity;
  readonly prompt: string;
  readonly constraint?: string;
  readonly options: readonly ChoiceOptionView[];
  readonly electorate: readonly string[];
  readonly mentionIds?: readonly string[];
  readonly closesAt?: number;
  readonly votedCount: number;
  readonly electorateCount: number;
  readonly responses: readonly { readonly identityId: string; readonly optionId: string }[];
  readonly answeredBy?: RoomViewIdentity;
  readonly selectedOptionId?: string;
  readonly outcome?: 'winner' | 'tie' | 'no-votes';
  readonly footer?: string;
};

export type RoomViewer = {
  /** Server-owned boundary; absent on older servers, null ids when no mark/unread exists. */
  readonly readCursor?: {
    readonly messageId: string | null;
    readonly firstUnreadMessageId: string | null;
    /**
     * How many messages sit past the mark, counted by the server over the one
     * definition of unread it keeps (`apps/server/src/read-cursor.ts`) and
     * capped at 99. Absent on a server old enough not to send it — which is
     * not the same as zero, and must not be read as "caught up".
     */
    readonly unreadCount?: number;
    /** Agent turns completed since the mark, capped at six. */
    readonly unreadAgentTurnCount?: number;
  };
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
  readonly status: 'working' | 'complete' | 'failed' | 'cancelled';
  /** Immutable turn start time in Unix seconds. */
  readonly startedAt?: number;
  /** Relay event time in Unix seconds. */
  readonly createdAt: number;
  readonly generationId?: string;
  /**
   * The identity that asked for this turn — the author of the message the
   * request id names. Present only when that message is still readable and its
   * author is a person, which is exactly when a stop control may be offered:
   * the one who asked the question is the one who may withdraw it, and the
   * phone must never infer that from a transcript window the request may have
   * already scrolled out of.
   */
  readonly requestedBy?: string;
};

/** A committed Room row small enough to paint directly from the live channel. */
export type RoomLiveDelta =
  | {
      readonly type: 'message-delta';
      readonly roomId: string;
      readonly message: RoomViewMessage;
    }
  | {
      readonly type: 'turn-delta';
      readonly roomId: string;
      readonly turn: RoomViewAgentTurn;
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
  /** Native, code-free apps persisted on this corner and shared with its members. */
  readonly cornerApps?: readonly CornerAppView[];
  /** Optional installed app whose human surface owns this corner. */
  readonly boundApp?: CornerAppBindingView;
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

export type ChatListCorner = {
  readonly id: string;
  readonly name: string;
  readonly state: Exclude<CornerState, 'archived'>;
  /** Present when the viewer commissioned this corner or it awaits them, the
   * same rule as the corners page's "Mine" filter. */
  readonly mine?: true;
};

export type ChatListItem = {
  readonly room: RoomViewHeader;
  /** Every current Room agent has a resolved presence fact and none is online.
   *  Carried by the deck so first-paint footer geometry matches the Room GET. */
  readonly agentsOffline?: boolean;
  /** Hidden from the deck for this viewer until explicit reopen or newer incoming activity. */
  readonly closed?: boolean;
  readonly latestMessage?: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: number;
    readonly author: RoomViewIdentity;
    /** Present so attachment-only latest messages remain visible in compact previews. */
    readonly attachments?: readonly AttachmentReference[];
  };
  /** Absent when the server omitted it: the count is unknown, never zero. */
  readonly memberCount?: number;
  /**
   * Unarchived corners on this Room. Absent when the server omitted it: the
   * deck row then shows neither the count nor its expansion toggle, and the
   * Room header's brass mark stays the way into the corners list.
   */
  readonly cornerCount?: number;
  /** Non-archived corners whose canonical state is waiting. */
  readonly waitingCornerCount?: number;
  /**
   * The viewer's unarchived corners on this Room, so the desktop deck lists
   * them from the chat list alone, with no per-Room corners read.
   */
  readonly openCorners?: readonly ChatListCorner[];
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
  readonly directMessage?: {
    readonly peer: RoomViewIdentity;
    /** Counterparty availability, or their newest observable activity when offline. */
    readonly presence?: {
      readonly status: 'online' | 'offline';
      readonly observedAt: number;
    };
  };
};

export type ChatListWorkspace = {
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  /** Absent when the server omitted it or named a value this bundle does not know. */
  readonly visibility?: 'public' | 'invite-only';
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
  /**
   * Workspaces this viewer was a member of that its owner deleted since the
   * last read. Server-consumed on delivery: each notice is returned once.
   */
  readonly deletedNotices?: readonly {
    readonly workspaceId: string;
    readonly workspaceName: string;
  }[];
};

export type WorkspaceManagedRoomView = {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'public' | 'invite-only';
  readonly createdAt: number;
};

export type WorkspaceView = {
  readonly workspace: ChatListWorkspace & {
    readonly about?: string;
    readonly createdAt: number;
  };
  readonly managerSettings?: {
    readonly visibility: 'public' | 'invite-only';
    /**
     * Up to 200 visibility-bearing top-level Rooms, including private Rooms
     * the manager has not joined. `roomsTruncated` records when eligible Rooms
     * exceed that bound. Older indexers omit this field; clients may fall back
     * to their membership-scoped chat list until they upgrade.
     */
    readonly rooms?: readonly WorkspaceManagedRoomView[];
    /** True when the server omitted Rooms beyond its 200-Room settings bound. */
    readonly roomsTruncated?: boolean;
  };
  readonly members: readonly RoomViewMember[];
  readonly agents: readonly WorkspaceAgentView[];
  /**
   * True human membership count, independent of the page in `members`.
   * Absent on older servers means unknown — never treat as zero.
   */
  readonly peopleTotal?: number;
  /**
   * True agent membership count, independent of the page in `agents`.
   * Absent on older servers means unknown — never treat as zero.
   */
  readonly agentTotal?: number;
  readonly membersTruncated: boolean;
  readonly agentsTruncated: boolean;
  readonly viewer: RoomViewer;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

/** One page of the Workspace Members roster, including search and load-more. */
export type WorkspaceMemberListView = {
  readonly members: readonly RoomViewMember[];
  readonly agents: readonly WorkspaceAgentView[];
  /** Absent on older servers means unknown — never treat as zero. */
  readonly peopleTotal?: number;
  /** Absent on older servers means unknown — never treat as zero. */
  readonly agentTotal?: number;
  readonly membersTruncated: boolean;
  readonly agentsTruncated: boolean;
};

export type WorkspaceMemberListQuery = {
  readonly q?: string;
  readonly kind?: 'human' | 'agent';
  readonly offset?: number;
};

/** One slash command the agent's live ACP harness advertises to composers. */
export type AgentComposerCommand = {
  readonly name: string;
  readonly description?: string;
  readonly inputHint?: string;
};

export type AgentDetailView = {
  /** Merged PRs opened by this agent in corners the viewer may read. */
  readonly recentWork?: readonly { readonly title: string; readonly url: string }[];
  readonly workspaceId: string;
  readonly agent: RoomViewMember;
  /** The person who connected and owns this agent's configuration. */
  readonly owner?: RoomViewIdentity;
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
  /**
   * The soul this agent's animal carries. An edited soul restores to this
   * text; it is derived from the face the agent wears, so name, avatar and
   * soul always name the same animal. Absent on stacks that do not index it.
   */
  readonly seededSoul?: string;
  readonly catalog: readonly AgentModelConfigOption[];
  /** Full latest ACP command snapshot. Empty means the harness advertises none. */
  readonly commands?: readonly AgentComposerCommand[];
  readonly runtimeSelection?: AgentModelSelection;
  readonly selected?: AgentModelSelection;
  /** Which persisted selection axis failed the daemon's live startup validation. */
  readonly modelUnavailable?: 'model' | 'effort' | 'selection';
  /**
   * The agent "yolo" switch: grant requests are approved without asking.
   * `canChange` is the server's verdict for this viewer (agent owner or a
   * workspace admin); the phone mirrors it, never decides it.
   */
  readonly yolo?: AgentYoloView;
  /**
   * Who may address this agent. The server is the authority — this is the value a
   * running helper obeys, not a copy of what its runtime record was paired with.
   */
  readonly access?: AgentAccessView;
  /** The grant store: every non-pending grant, newest first. */
  readonly grants?: readonly AgentGrantView[];
  /** Server verdict: this viewer may decide and revoke this agent's grants. */
  readonly canManageGrants?: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};

/**
 * The agent's access policy as the profile shows it. `owner` names who to ask when
 * the answer is "only the owner"; `canChange` is the server's verdict for this
 * viewer (agent owner or a workspace admin), mirrored by the phone, never decided
 * by it.
 */
export type AgentAccessView = {
  readonly policy: AgentAccessPolicy;
  /** `handle` is how a screen names them — an @handle, never the display name. */
  readonly owner?: {
    readonly id: string;
    readonly name: string;
    readonly handle?: string;
  };
  readonly canChange: boolean;
};

export type AgentYoloView = {
  readonly enabled: boolean;
  /** The stored preference is overridden while this Workspace is public. */
  readonly forcedOff?: boolean;
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
  /** Present when the authenticated viewer has already accepted this invite. */
  readonly joinedWorkspaceId?: string;
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
  readonly state: CornerState;
  /** Timestamp of the fact that produced `state`. A working state uses the
   * latest child turn receipt rather than the corner metadata timestamp. */
  readonly stateAt?: number;
  readonly reason?: CornerStateReason;
  /** Unix seconds the corner was closed. Present only on archived corners, and
   * the key the archived list is ordered by: closure recency, not creation. */
  readonly closedAt?: number;
  /** Human whose request caused the agent to open this corner. */
  readonly initiator?: RoomViewIdentity;
  readonly agent?: RoomViewIdentity;
  readonly app?: CornerAppBindingView;
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
  /** Apps connected to this Workspace and available for a new corner. */
  readonly apps?: readonly CornerAppInstallationView[];
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
