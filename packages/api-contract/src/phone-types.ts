import type { SquireApprovalDetails } from './approval-copy.js';
import type { RepositoryOnboardingCard } from './repository-onboarding.js';
import type { AgentUsage } from './agent-usage.js';
import type { SystemEvent } from './system-events.js';
import type { AgentGrantKind, AgentGrantStatus, CommandGrantScript } from './agent-grants.js';
import type { ChoiceMode, ChoiceOptionView, ChoiceStatus } from './room-choices.js';
import type { ConnectorOfferCardView } from './connector-offers.js';
import type { AgentSignInCardView } from './agent-sign-in.js';
export { type RoomLiveDelta, type RoomView, type RoomHistoryView, MESSAGE_SEARCH_QUERY_MAX_BYTES, type MessageSearchView, type MessageSearchResult, type MessageSearchSnippetPart, type RoomHistoryOutline, type RoomHistoryOutlineDay, type ChatListCorner, type RoomCornerSummary, type ChatListItem, type ChatListWorkspace, type ChatListView, type ChatListUnavailable, type WorkspaceListView, type WorkspaceManagedRoomView, type WorkspaceView, type WorkspaceMemberListView, type WorkspaceMemberListQuery, type AgentComposerCommand, type AgentDetailView, type AgentAccessView, type AgentYoloView, type InviteView, type InviteInviterView, type AgentPairingClaimView, type AgentPairingClaimWireView, type AgentPairingAbandonView, type CornerListItem, type CornerListView, type RoomRepositoryView, type RoomRepositoryResolution } from './phone-types-room-live-delta.js';



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
  options: Array<{ id: string; name?: string; description?: string }>;
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
  readonly mergeQueue?: { readonly headSha: string; readonly combinedSha?: string };
  readonly lifecycle: 'working' | 'in-review' | 'unknown' | 'done';
  readonly branch?: string;
  readonly checks: 'pending' | 'passing' | 'failing' | 'unknown';
  readonly pr?: {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly targetBranch: string;
    readonly headSha: string;
    readonly mergeability?: 'clean' | 'dirty' | 'draft' | 'unknown' | 'other';
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
      readonly status: 'pending' | 'passed' | 'failed' | 'cancelled';
      readonly conclusion?: string;
      readonly url?: string;
    }[];
    readonly updatedAt: number;
    /** Set by every completed GitHub check fetch. A push's reset summary has none. */
    readonly fetchStartedAt?: number;
  };
  readonly outcome?: 'landed' | 'abandoned';
  readonly reason?: string;
};


/** The server-owned corner state vocabulary. Clients render this field; they
 * never derive a second state from lifecycle, PR, check, or turn facts. */
export type CornerState = 'working' | 'waiting' | 'idle' | 'review' | 'archived';

export type CornerBlocker = {
  readonly kind: 'message' | 'merge-hold' | 'report' | 'ci';
  readonly url?: string;
  readonly personId?: string;
  readonly personName?: string;
};


export type CornerStateReason = 'approve' | 'connect' | 'question';


export const ROOM_VIEW_MESSAGE_LIMIT = 30;

/** Kept separate from the conversation window for settled corner tool activity.
 * Phones before this limit was raised keep only the last 60 rows they receive,
 * so the server sends these rows oldest first. */
export const ROOM_VIEW_TOOL_ROW_LIMIT = 200;

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
  readonly role: 'owner' | 'admin' | 'member' | 'spectator';
  readonly presence?: {
    readonly status: 'online' | 'offline';
    readonly observedAt: number;
    /** A live helper connection holds this presence; it does not age out. */
    readonly held?: true;
    readonly roomId?: string;
  };
};


/** Paint-ready agent metadata for the Workspace Members row. */
export type WorkspaceAgentView = RoomViewMember & {
  /** Owner-only plan, allowance or key spend; absent for other viewers. */
  readonly usage?: AgentUsage;
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
  /** Absent when this bundle could not read it. Only `true` paints a Room as
   *  archived. */
  readonly archived?: boolean;
  readonly createdAt?: number;
  /** Absent when this bundle could not read it; a surface omits the age rather
   *  than dating the Room from the epoch. */
  readonly updatedAt?: number;
};


export type RoomToolReference = { readonly roomId: string; readonly anchor: string };

export type RoomToolPage = { readonly roomId: string; readonly messages: readonly RoomViewMessage[];
  readonly next?: string };

export type RoomViewActivity = {
  readonly toolGroup?: RoomToolReference & { readonly count: number };
  readonly toolOutput?: RoomToolReference & { readonly messageId: string };
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary' | 'note';
  readonly title: string;
  /**
   * Durable corner narration when `kind='output'`; an earlier assistant text
   * run shown inside the steps line when `kind='note'`. Never private thought
   * text.
   */
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
  /**
   * On a `note`: this text carries on the previous note. One text run longer
   * than a note may be is split across consecutive notes, never cut.
   */
  readonly continues?: boolean;
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
};


export type RoomViewMessage = {
  readonly awayWarning?: boolean;
  readonly sourceClient?: { readonly id: string; readonly name: string };
  readonly voiceCall?: import('./voice.js').VoiceCall;
  readonly id: string;
  readonly text: string;
  readonly createdAt: number;
  /** Millisecond creation stamp used only for stable transcript ordering. */
  readonly createdAtMs?: number;
  /**
   * The row's write counter, on full reads, pages and deltas alike. It grows
   * with every committed change to this message, so a copy with a lower one
   * is older than one already held.
   */
  readonly version?: number;
  readonly author: RoomViewIdentity;
  readonly presentation: 'message' | 'system' | 'activity' | 'card';
  /** The original text and attachments were removed; this row remains as a transcript record. */
  readonly deleted?: boolean;
  /** Private viewer state. Omitted unless this viewer saved the message. */
  readonly bookmarked?: boolean;
  /** Someone reported this message to the Beeline feedback loop (@system or
   *  Report issue). Visible to every Room member. */
  readonly feedbackReported?: boolean;
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
  readonly permission?: {
    readonly permissionId: string;
    readonly requestId: string;
    readonly agent: RoomViewIdentity;
    readonly requester: RoomViewIdentity;
    readonly decider?: RoomViewIdentity;
    readonly tool: string;
    readonly repository?: string;
    readonly purpose?: 'squire-spending';
    readonly reason?: string;
    readonly decidedAt?: number;
    /** Squire spending only: the spending agent's owner, the one person who decides. */
    readonly ownerId?: string;
    readonly status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    readonly cornerId?: string;
  };
  /** One grant card: the agent asks its owner; several asks in one turn share a card. */
  readonly grantRequest?: GrantRequestCardView;
  /** One Squire-owned approval page relayed into the owner's @System DM.
   * Beeline presents the link but never decides the request. */
  readonly squireApproval?: SquireApprovalCardView;
  /** A Beeline-hosted interactive view of an existing Squire operate browser. */
  readonly computerSession?: {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    readonly status: 'live' | 'ended';
  };
  /** One connector offer: the agent reaches for a Workbench tool it needs (R5). */
  readonly connectorOffer?: ConnectorOfferCardView;
  readonly vaultSave?: import('./vault-save.js').VaultSaveCard;
  /** A connected app is needed to finish the Room request. Route details stay server-side. */
  readonly appSignIn?: {
    readonly appId: string;
    readonly appKey: string;
    readonly name: string;
    readonly logo?: string;
    readonly domain?: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly status: 'pending' | 'connected' | 'failed';
    readonly errorMessage?: string;
    readonly continuation?: string;
  };
  /** `@agent /login`: Claude's sign-in at the call site. Holds the link, never a code. */
  readonly agentSignIn?: AgentSignInCardView;
  /** One preference card: a lettered question or a Room poll. Never authority. */
  readonly onboarding?: RepositoryOnboardingCard;
  readonly choice?: ChoiceCardView;
  readonly targetBranch?: {
    readonly proposalId: string;
    readonly purpose?: string;
    readonly status?: 'allowed' | 'denied';
    readonly decidedBy?: RoomViewIdentity;
    readonly decidedAt?: number;
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
    readonly cornerId?: string;
    readonly type: string;
    readonly action: string;
    readonly actor: string;
    readonly title: string;
    readonly url: string;
    readonly branch?: string;
    readonly targetBranch?: string;
  };
  /** A daemon-authored repository lifecycle fact, rendered as an actionable card. */
  /** An agent's order into, or report from, a corner. The author is the sender. */
  readonly agentCommand?: {
    readonly kind: 'order' | 'report';
    readonly recipient: { readonly id: string; readonly name: string; readonly handle?: string };
    readonly status?: 'done' | 'blocked' | 'needs-decision' | 'failed';
    readonly text: string;
  };
  /** The @System ledger line: every transaction, in and out. */
  readonly walletTx?: {
    readonly direction: 'in' | 'out';
    readonly amountText: string;
    readonly counterparty: string;
    readonly chain: string;
    readonly balanceAfterUsd: string;
    readonly txUrl?: string;
    readonly agentName?: string | null;
  };
  /** The one non-transaction @System message: a refused payment. */
  readonly walletInsufficient?: {
    readonly agentName?: string | null;
    readonly needed: string;
    readonly available?: string | null;
    readonly asset: string;
    readonly chain: string;
    readonly reason?: string;
  };
  /** The delegation grant/renewal fact in the @System thread. */
  readonly walletDelegation?:
    | { readonly standing: true }
    | {
        readonly expiresAt: number;
        readonly ttlHours: number;
      };
  readonly daemonFact?: {
    readonly type: 'corner-complete' | 'checks-failing' | 'worktree-cleaned' | 'corner-open';
    readonly cornerId: string;
    /** The corner's short title (at most three words). Absent only on legacy cards. */
    readonly name?: string;
    /** Empty on a person-opened corner, which has no objective; its `name` titles it. */
    readonly objective: string;
    /**
     * The parent-Room message a person opened this corner from. The phone
     * anchors the card beneath that message as the "corner opened" marker.
     */
    readonly sourceMessageId?: string;
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
  /** Server-authored preview; the existing Room/message target opens the source. */
  readonly textTruncated?: true;
};


/**
 * One cell in the viewer's "Needs you" tray. A message qualifies when it tags
 * the viewer AND asks (ends with `?`, or says please/approve/feedback); a
 * pending agent-grant card the viewer can decide qualifies as it is. The
 * server owns the whole projection — which items, their text, and when they
 * leave — so every device shows the same tray.
 */
export type NeedsYouItemView = {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly roomId: string;
  /** Room or corner name; for a DM, the other participant's name. */
  readonly roomName: string;
  readonly roomKind: 'room' | 'corner' | 'direct';
  /** For a corner, its parent Room's name. */
  readonly parentRoomName?: string;
  /**
   * The plain asking sentence, capped at 140 characters by the server.
   */
  readonly text: string;
  /** When the source message was written (Unix seconds). */
  readonly createdAt: number;
  /**
   * When the cell leaves the tray on its own (Unix seconds): 24 hours after
   * the viewer first saw it on any device. For an approval, when the request
   * expires or closes; absent when it never does.
   */
  readonly expiresAt?: number;
  readonly author?: RoomViewIdentity;
  /** Present when the cell is a pending approval card the viewer can decide. */
  readonly approval?: NeedsYouApprovalView;
};


export type NeedsYouApprovalKind =
  | 'grant'
  | 'write-access'
  | 'squire'
  | 'choice'
  | 'connector'
  | 'sign-in';


/** An existing decision operation, projected only after its server authority check. */
export type NeedsYouActionView = { readonly label: string; readonly detail?: string } & (
  | { readonly kind: 'grant'; readonly grantId: string; readonly decision: 'once' | 'always' | 'deny' }
  | { readonly kind: 'write-access'; readonly permissionId: string; readonly requestId: string;
      readonly agentId: string; readonly repository: string; readonly decision: 'allow' | 'deny' }
  | { readonly kind: 'choice'; readonly choiceId: string; readonly optionId: string }
  | { readonly kind: 'skip-choice'; readonly choiceId: string }
  | { readonly kind: 'external'; readonly url: string }
);


/**
 * An approval card as text: `<actor> <ask>` over the whole `subject`, then the
 * request's own `detail`. The ask's verb names the kind, so the row needs no
 * type label. The tray uses the same decision operations as the transcript card.
 */
export type NeedsYouApprovalView = {
  readonly kind: NeedsYouApprovalKind;
  /** Who asks, usually the agent's name. */
  readonly actor: string;
  /** The verb phrase after the actor, e.g. `asks to run`. */
  readonly ask: string;
  /** The exact thing asked for, never shortened. */
  readonly subject: string;
  /** True when `subject` is a command, repository, secret or similar literal. */
  readonly literal: boolean;
  /** The request's reason, or a choice's options joined by ` · `. */
  readonly detail?: string;
  /** The person the request is for, when that is not the viewer. */
  readonly forName?: string;
  readonly actions?: readonly NeedsYouActionView[];
  /** Shared grant details, shown before its folded script disclosure. */
  readonly purpose?: string;
  readonly facts?: readonly { readonly label: string; readonly value: string }[];
  /** Full script bytes bound to the first grant, available on request. */
  readonly script?: { readonly path: string; readonly contents: string };
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
  /** Product name for a connection-install permission; never an authority target. */
  readonly appName?: string;
  readonly purpose?: string;
  readonly touches?: string;
  readonly capabilities?: string;
  readonly machine?: string;
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


/** A settled grant attributed to one agent owned by a Workspace member. */
export type WorkspaceMemberGrantView = AgentGrantView & {
  readonly roomName?: string;
  readonly agent: RoomViewIdentity;
};


export type GrantRequestCardView = {
  readonly agent: RoomViewIdentity;
  readonly owner: RoomViewIdentity;
  readonly requester: RoomViewIdentity;
  readonly grants: readonly AgentGrantView[];
  /** The message that caused a Squire route ask, when this card is in the owner's @System DM. */
  readonly sourceRoomId?: string;
  readonly sourceMessageId?: string;
};


export type SquireApprovalCardView = SquireApprovalDetails & {
  readonly owner?: RoomViewIdentity;
  readonly status?: 'approved' | 'denied' | 'expired';
  readonly decidedBy?: RoomViewIdentity;
  readonly decidedAt?: number;
  readonly agent: RoomViewIdentity;
  readonly tool: string;
  readonly title: string;
  readonly detail: string;
  readonly approvalUrl: string;
  readonly approvalId?: string;
  readonly linkKind: 'approval' | 'passkey' | 'vouch';
  readonly sourceRoomId?: string;
  readonly sourceMessageId?: string;
};


/** One lettered question or Room poll. Options are plates, never ledger rows. */
export type ChoiceCardView = {
  readonly videoPreview?: { readonly videoObjectId: string; readonly frameUrl: string; readonly title: string; readonly description: string; readonly visibility: 'public' | 'unlisted' | 'private' };
  readonly starterOnboarding?: 'welcome' | 'next';
  readonly onboardingManual?: boolean;
  readonly ask?: string;
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
  /** Present when the card is a workflow gate. */
  readonly runId?: string;
  /** The note the answerer typed with their pick on a workflow gate. */
  readonly note?: string;
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
  };
  readonly identity: RoomViewIdentity;
  readonly role: 'owner' | 'admin' | 'member' | 'spectator';
  readonly permissions: {
    readonly send: boolean;
    readonly manage: boolean;
  };
  /** The viewer silenced this Room's pushes; absent when not, and on older servers. */
  readonly pushMuted?: true;
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


/** A human-addressed command accepted by the server and not yet claimed. */
export type RoomViewPendingAgentCommand = {
  readonly requestId: string;
  readonly agentPubkey: string;
  readonly createdAt: number;
};
