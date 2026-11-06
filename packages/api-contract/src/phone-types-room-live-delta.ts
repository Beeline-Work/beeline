import type { AgentUsage } from './agent-usage.js';
import type { AgentAccessPolicy } from './agent-access.js';
import { RoomViewMessage, RoomViewAgentTurn, RoomViewHeader, RoomViewMember, RoomViewPendingAgentCommand, RoomViewer, RoomDirectMessageView, RoomViewActivity, CornerLifecycleView, SurfaceWatchFilter, CornerState, CornerStateReason, CornerBlocker, RoomViewIdentity, AttachmentReference, WorkspaceAgentView, WorkspaceMemberGrantView, AgentModelConfigOption, AgentModelSelection, AgentGrantView } from './phone-types.js';



/** A committed Room row small enough to paint directly from the live channel. */
export type RoomLiveDelta =
  | {
      readonly type: 'message-delta';
      readonly roomId: string;
      readonly message: RoomViewMessage;
      /**
       * The row's write counter. It grows with every committed change to
       * this message; a delta with a lower one is older than one already seen.
       */
      readonly version?: number;
      /** Present on deletion: the deck's next visible preview, or null. */
      readonly deckPreview?: ChatListItem['latestMessage'] | null;
    }
  | {
      readonly type: 'turn-delta';
      readonly roomId: string;
      readonly turn: RoomViewAgentTurn;
      /** Current top-level Room rollup, when the committed row was read from the database. */
      readonly agentState?: 'needs-you' | 'working' | null;
      /** Present with a `needs-you` rollup: why, as the Room list read names it. */
      readonly attentionReason?: ChatListItem['attentionReason'];
    };


export type RoomView = {
  readonly room: RoomViewHeader;
  /** Leaving as the last Workspace manager in this Room deletes it for everyone. */
  readonly leaveDeletesRoom?: boolean;
  readonly messages: readonly RoomViewMessage[];
  /** Settled corner tool activity, outside the bounded conversation window. */
  readonly toolRows?: readonly RoomViewMessage[];
  readonly members: readonly RoomViewMember[];
  readonly latestAgentTurns: readonly RoomViewAgentTurn[];
  /** Server-owned pre-claim commands, one oldest pending command per agent. */
  readonly pendingAgentCommands?: readonly RoomViewPendingAgentCommand[];
  readonly viewer: RoomViewer;
  readonly directMessage?: RoomDirectMessageView;
  readonly parent?: RoomViewHeader;
  /** The agent that opened this corner, independent of later reviewers and helpers. */
  readonly cornerOpenerAgentId?: string;
  readonly briefing?: readonly RoomViewMessage[];
  /** Latest corner plan, retained after its live activity rows settle. */
  readonly cornerPlan?: RoomViewActivity['plan'];
  /** The latest durable assignment; older revisions remain server-owned. */
  readonly cornerBrief?: {
    readonly authorHandle?: string;
    readonly revision: number;
    /** Markdown; older typed revisions are folded into it by the server. */
    readonly spec: string;
    readonly approval?: {
      readonly sourceMessageId: string;
      readonly text: string;
      readonly approverName: string;
    };
    readonly attachments: readonly {
      readonly title: string;
      readonly purpose: string;
      readonly required: boolean;
      readonly url: string;
    }[];
  };
  readonly repository?: RoomRepositoryView;
  readonly repositoryResolution: RoomRepositoryResolution;
  /** GitHub-derived lifecycle for this Room when it is a repository corner. */
  readonly cornerLifecycle?: CornerLifecycleView;
  /** On a corner: whether something in it is still owed to a person, which
   * keeps an otherwise quiet corner `waiting` instead of `idle`. */
  readonly cornerOwed?: boolean;
  /** People control whether agents may archive this corner. */
  readonly cornerLocked?: boolean;
  readonly watchFilters: readonly SurfaceWatchFilter[];
};


export type RoomHistoryView = {
  readonly roomId: string;
  readonly messages: readonly RoomViewMessage[];
  readonly nextBefore?: { readonly createdAt: number; readonly id: string };
};


/** Longest Room list message search query the server accepts, in UTF-8 bytes. */
export const MESSAGE_SEARCH_QUERY_MAX_BYTES = 200;


/**
 * One page of the Room list's message search: messages in the viewer's Rooms
 * and direct messages in one Workspace (never corners), newest first.
 */
export type MessageSearchView = {
  readonly workspaceId: string;
  readonly results: readonly MessageSearchResult[];
  /** The last result's message id; pass it back as `before` for the next older page. */
  readonly nextBefore?: string;
};


export type MessageSearchResult = {
  readonly messageId: string;
  readonly roomId: string;
  /** The Room's name, or the other person's handle in a direct message. */
  readonly roomName: string;
  readonly directMessage: boolean;
  readonly authorName: string;
  readonly createdAt: number;
  /** The message around the match, in order; `match` parts are the matched words. */
  readonly snippet: readonly MessageSearchSnippetPart[];
};


export type MessageSearchSnippetPart = {
  readonly text: string;
  readonly match: boolean;
};


/**
 * The whole Room history, one entry per local calendar day in the reader's
 * time zone, so the transcript scrubber can place its handle and a marker for
 * every day against every message, not only the pages loaded so far. Counts
 * use the same rows `RoomHistoryView` pages through.
 */
export type RoomHistoryOutline = {
  readonly roomId: string;
  /** The IANA time zone the days were cut in, as the reader asked. */
  readonly timeZone: string;
  readonly total: number;
  /** The newest message counted, so later arrivals can extend `total`. */
  readonly newest?: { readonly id: string; readonly createdAt: number };
  /** Every day with a message, oldest first. */
  readonly days: readonly RoomHistoryOutlineDay[];
};


export type RoomHistoryOutlineDay = {
  /** `YYYY-MM-DD` in `timeZone`. */
  readonly day: string;
  readonly count: number;
  /** The day's oldest message. */
  readonly first: {
    readonly id: string;
    readonly createdAt: number;
    readonly authorName: string;
    readonly authorHandle?: string;
  };
};


export type ChatListCorner = {
  readonly id: string;
  readonly name: string;
  readonly state: Exclude<CornerState, 'archived'>;
  readonly reason?: CornerStateReason;
  readonly blocker?: CornerBlocker;
  readonly itemId?: string;
  /** The server's Mine rule, the same on every surface: the viewer follows
   * this corner (opened, requested, posted, steered or was tagged in it), it
   * owes them something, or they commissioned it. */
  readonly mine?: true;
  /** On the viewer's waiting corners: when the corner last spoke (unix
   * seconds), the moment it handed back. It counts as Room activity. */
  readonly waitingSince?: number;
  /** The corner owes the viewer something they have not opened it to see
   * since. Only these open the Room's corner dropdown on their own. */
  readonly attention?: true;
};


/** A Room's open-corner summary: exact counts and the capped list of open corners. */
export type RoomCornerSummary = {
  readonly cornerCount: number;
  readonly waitingCornerCount: number;
  readonly mineCornerCount: number;
  readonly openCorners: readonly ChatListCorner[];
};


export type ChatListItem = {
  readonly voiceCall?: import('./voice.js').VoiceCall;
  readonly room: RoomViewHeader;
  /** Leaving as the last Workspace manager in this Room deletes it for everyone. */
  readonly leaveDeletesRoom?: boolean;
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
    /** The server resolved the viewer as an exact tag on this message. */
    readonly mentionsViewer?: true;
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
  /** Non-archived corners that are Mine, exact even when `openCorners` is capped. */
  readonly mineCornerCount?: number;
  /**
   * The viewer's unarchived corners on this Room, so the desktop deck lists
   * them from the chat list alone, with no per-Room corners read. Every Mine
   * corner is listed; the newest others fill the list to eight.
   *
   * A preview, not the full list: it is complete only when its length equals
   * `cornerCount`. Read counts from `cornerCount` and `mineCornerCount`, never
   * from this list; the Corners read holds every row.
   */
  readonly openCorners?: readonly ChatListCorner[];
  /**
   * Server-owned, cross-device read state. Absent when the server could not
   * read it for this row: the value is unknown, not false.
   */
  readonly unread?: boolean;
  readonly repositoryName?: string;
  /**
   * Max-severity rollup of this Room's own conversational turn and every one
   * of its corners' current lifecycle state: `needs-you` when any corner is
   * waiting on a human, else `working` when the Room's own turn or any
   * corner is actively working, else absent (idle). Message `unread` is a
   * separate, independent needs-you signal — the deck combines both.
   */
  readonly agentState?: 'needs-you' | 'working';
  /** Why the Room currently needs the viewer, when the server can name it. */
  readonly attentionReason?: {
    readonly kind: 'approval';
    readonly actor?: string;
  };
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
      /** A live helper connection holds this presence; it does not age out. */
      readonly held?: true;
    };
  };
};


export type ChatListWorkspace = {
  readonly roomCount?: number;
  readonly attention?: boolean;
  readonly id: string;
  readonly name: string;
  readonly avatar?: string;
  /** Absent when the server omitted it or named a value this bundle does not know. */
  readonly visibility?: 'public' | 'invite-only';
  readonly role: 'owner' | 'admin' | 'member' | 'spectator';
  readonly updatedAt: number;
};


export type ChatListView = {
  readonly workspace: ChatListWorkspace;
  readonly chats: readonly ChatListItem[];
  readonly viewer: RoomViewIdentity;
  readonly truncated: boolean;
  /**
   * Per-row facts the server could not read this time (a timed-out
   * enrichment). Each row's value for them is unknown, not empty: `unread`
   * and the corner fields are absent. Keep the last known values.
   */
  readonly unavailable?: readonly ChatListUnavailable[];
  readonly watchFilters: readonly SurfaceWatchFilter[];
};


export type ChatListUnavailable = 'unread' | 'corners';


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
    readonly allowFixSweep?: boolean;
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
  readonly viewer?: RoomViewer;
  readonly members: readonly RoomViewMember[];
  /** On a single-human profile query: the first page of agents that person owns. */
  readonly agents: readonly WorkspaceAgentView[];
  /** Present on a single-human profile query; absent from ordinary roster pages. */
  readonly grants?: readonly WorkspaceMemberGrantView[];
  /** Absent on older servers means unknown — never treat as zero. */
  readonly peopleTotal?: number;
  /** Absent on older servers means unknown — never treat as zero. */
  readonly agentTotal?: number;
  readonly membersTruncated: boolean;
  readonly agentsTruncated: boolean;
};


export type WorkspaceMemberListQuery = {
  readonly memberId?: string;
  readonly ownerId?: string;
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
  /** Owner-only AI-client wake configuration. The bearer key is never returned. */
  readonly wake?: { readonly url: string | null; readonly keySet: boolean };
  readonly usage?: AgentUsage;
  readonly harness?: string;
  /** Agent configuration commit order, for deduping a live echo of a write receipt. */
  readonly configVersion?: string;
  /** Present only after a generated portrait has committed successfully. */
  readonly avatarGenerationId?: string;
  readonly avatarGenerationPending?: boolean;
  /** Merged PRs opened by this agent in corners the viewer may read. */
  readonly recentWork?: readonly { readonly title: string; readonly url: string }[];
  readonly recentWorkCursor?: string;
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
  readonly fastMode?: boolean;
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
  /** Server verdict: this viewer owns the agent and its harness supports Room sign-in. */
  readonly canLogin?: boolean;
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
  /** Absolute Unix timestamp in seconds; zero for a permanent public link. */
  readonly expiresAt: number;
  /** Present when the authenticated viewer has already accepted this invite. */
  readonly joinedWorkspaceId?: string;
  /** The current Workspace member who minted this invite: who is asking. */
  readonly inviter?: InviteInviterView;
  /** Active people / agents in the Workspace, so the preview names its size. */
  readonly memberCount?: number;
  readonly agentCount?: number;
};


export type InviteInviterView = {
  readonly name: string;
  readonly handle?: string;
  readonly face?: string;
  readonly role?: 'owner' | 'admin' | 'member' | 'spectator';
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
  readonly blocker?: CornerBlocker;
  readonly itemId?: string;
  /** Unix seconds the corner was closed. Present only on archived corners, and
   * the key the archived list is ordered by: closure recency, not creation. */
  readonly closedAt?: number;
  /** Human whose request caused the agent to open this corner. */
  readonly initiator?: RoomViewIdentity;
  /** The server's Mine rule; see `ChatListCorner.mine`. */
  readonly mine?: true;
  readonly agent?: RoomViewIdentity;
  /** The corner's latest brief revision. Absent when it has no brief. */
  readonly briefRevision?: number;
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
  /** On an archived page: the cursor that reads the next page. Absent on the last one. */
  readonly nextArchived?: string;
  /** Cursor for the next page of open corners. */
  readonly nextOpen?: string;
  /** On the first open page of a top-level Room: the Room list row's corner
   *  summary, read in the same statement as the rows. */
  readonly summary?: RoomCornerSummary;
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
  /** GitHub's repository-level auto-merge toggle; absent when it is not yet known. */
  readonly allowAutoMerge?: boolean;
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
