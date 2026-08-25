import type { AttachmentReference } from '../attachment.js';
import type { CornerMachineReason, CornerMachineState } from '../corner-state.js';

declare const channelIdBrand: unique symbol;
declare const eventIdBrand: unique symbol;
declare const pubkeyBrand: unique symbol;
declare const messageReferenceBrand: unique symbol;

export type ChannelId = string & { readonly [channelIdBrand]: 'ChannelId' };
export type EventId = string & { readonly [eventIdBrand]: 'EventId' };
export type Pubkey = string & { readonly [pubkeyBrand]: 'Pubkey' };

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type IdentityRecord =
  | {
      readonly kind: 'human';
      readonly pubkey: Pubkey;
      readonly displayName?: string;
      readonly handle?: string;
      readonly revision: string;
    }
  | {
      readonly kind: 'agent';
      readonly pubkey: Pubkey;
      readonly displayName?: string;
      readonly handle?: string;
      readonly revision: string;
    }
  | {
      readonly kind: 'infrastructure';
      readonly pubkey: Pubkey;
      readonly revision: string;
    };

export type ChannelScope = {
  readonly scope: 'channel';
  readonly channelId: ChannelId;
  readonly workspaceId?: string;
};

export type WorkspaceScope = {
  readonly scope: 'workspace';
  readonly workspaceId: string;
};

export type BaseVerifiedEnvelope = {
  readonly eventId: EventId;
  readonly authorPubkey: Pubkey;
  readonly createdAt: number;
  readonly sourceKind: number;
  readonly signature: 'verified';
};

export type ChannelEnvelope = BaseVerifiedEnvelope & ChannelScope;
export type WorkspaceEnvelope = BaseVerifiedEnvelope & WorkspaceScope;
export type VerifiedEnvelope = ChannelEnvelope | WorkspaceEnvelope;

/**
 * Opaque proof returned only after the parser or a snapshot selector has found
 * the referenced event in the same channel. There is intentionally no public
 * constructor accepting ids.
 */
export type KnownMessageReference = {
  readonly channelId: ChannelId;
  readonly eventId: EventId;
  readonly rootId: EventId;
  readonly [messageReferenceBrand]: true;
};

export type ConversationMessage = {
  readonly body: string;
  readonly attachments: readonly AttachmentReference[];
  readonly mentionPubkeys: readonly Pubkey[];
  readonly reply?: KnownMessageReference;
  readonly clientNonce?: string;
};

export type HumanMessage = ChannelEnvelope &
  ConversationMessage & {
    readonly type: 'human-message';
  };

export type AgentMessage = ChannelEnvelope &
  ConversationMessage & {
    readonly type: 'agent-message';
    readonly requestId?: string;
  };

export type ControlVisibility = 'hidden' | 'system-line' | 'card';

export type ControlPayload =
  | { readonly kind: 'system'; readonly text: string; readonly status?: string }
  | {
      readonly kind: 'corner-link';
      readonly cornerId: ChannelId;
      readonly status?: string;
      readonly text?: string;
    }
  | {
      readonly kind: 'merge';
      readonly action: 'ready' | 'not-ready' | 'landed' | 'failed' | 'approval-ack';
      readonly repository?: string;
      readonly branch?: string;
      readonly tip?: string;
      readonly patchId?: string;
      readonly previewUrl?: string;
      readonly retry?: 'auto' | 'realigning' | 'blocked';
      readonly approvalId?: string;
      readonly decision?: 'accepted' | 'rejected';
      readonly state?: 'landing' | 'realigning' | 'realigned' | 'content-changed' | 'tip-moved';
      readonly rejectedTip?: string;
      readonly text?: string;
    }
  | {
      readonly kind: 'permission';
      readonly permissionId: string;
      readonly requestId: string;
      readonly agentPubkey: Pubkey;
      readonly status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
      readonly tool?: string;
      readonly repository?: string;
      readonly purpose?: 'squire-spending';
      readonly subchannelId?: ChannelId;
    }
  | {
      readonly kind: 'target-branch-proposal';
      readonly proposalId: string;
      readonly from: string;
      readonly to: string;
      readonly repository?: string;
      readonly agentPubkey?: Pubkey;
      readonly requesterPubkey?: Pubkey;
    }
  | {
      readonly kind: 'room-metadata';
      readonly name?: string;
      readonly about?: string;
      readonly archived?: boolean;
    }
  | { readonly kind: 'identity'; readonly identity: IdentityRecord }
  | { readonly kind: 'record'; readonly recordType: string; readonly recordId?: string };

export type Control = VerifiedEnvelope & {
  readonly type: 'control';
  readonly visibility: ControlVisibility;
  readonly payload: ControlPayload;
};

export type SessionUpdatePayload =
  | {
      readonly kind: 'presence';
      readonly agentPubkey: Pubkey;
      readonly status: 'online' | 'offline';
      readonly generationId?: string;
    }
  | {
      readonly kind: 'draft';
      readonly agentPubkey: Pubkey;
      readonly requestId: string;
      readonly text?: string;
      readonly closed: boolean;
    }
  | {
      readonly kind: 'turn';
      readonly agentPubkey: Pubkey;
      readonly requestId: string;
      readonly status: 'working' | 'complete' | 'failed';
      readonly generationId?: string;
    }
  | {
      readonly kind: 'corner-session';
      readonly agentPubkey: Pubkey;
      readonly sessionId: string;
      readonly state: 'live' | 'suspended' | 'waiting-for-slot';
      readonly sequence: number;
    }
  | { readonly kind: 'opaque'; readonly updateType: string };

export type SessionUpdate = ChannelEnvelope & {
  readonly type: 'session-update';
  readonly sessionId: string;
  readonly update: SessionUpdatePayload;
};

export type RoomLifecycleState = 'created' | 'updated' | 'archived' | 'deleted';

export type LifecycleMemberSeed = {
  readonly pubkey: Pubkey;
  readonly role: MemberRole;
};

export type Lifecycle = ChannelEnvelope & {
  readonly type: 'lifecycle';
  readonly lifecycle:
    | {
        readonly entity: 'room';
        readonly roomId: ChannelId;
        readonly state: RoomLifecycleState;
        readonly name?: string;
        readonly about?: string;
        readonly initialMembers?: readonly LifecycleMemberSeed[];
      }
    | {
        readonly entity: 'corner';
        readonly cornerId: ChannelId;
        readonly parentRoomId: ChannelId;
        readonly state: CornerMachineState;
        readonly name?: string;
        readonly task?: string;
        readonly creatorPubkey?: Pubkey;
        readonly createdAt?: number;
        readonly stateAt?: number;
        readonly initialMembers?: readonly LifecycleMemberSeed[];
        readonly reason?: CornerMachineReason;
        readonly exists: boolean;
        readonly leaseUntil?: number;
      };
};

export type MemberRole = 'owner' | 'admin' | 'member' | 'unknown';

export type Membership = ChannelEnvelope & {
  readonly type: 'membership';
  readonly membership:
    | {
        readonly mode: 'snapshot';
        readonly members: readonly { readonly pubkey: Pubkey; readonly role: MemberRole }[];
      }
    | {
        readonly mode: 'mutation';
        readonly action: 'join' | 'leave' | 'role';
        readonly memberPubkey: Pubkey;
        readonly role?: MemberRole;
      };
};

export type ActivityDetail = {
  readonly kind: 'thinking' | 'tool' | 'output' | 'summary';
  readonly title: string;
  readonly text?: string;
  readonly status?: string;
  readonly operation?: string;
  readonly toolCallId?: string;
  readonly rollup?: Readonly<Record<string, number>>;
  readonly thoughtMs?: number;
  readonly command?: string;
  readonly input?: string;
  readonly output?: string;
  readonly files?: readonly {
    readonly path: string;
    readonly status?: string;
    readonly diff?: string;
  }[];
  readonly plan?: {
    readonly objective?: string;
    readonly items: readonly {
      readonly step: string;
      readonly status: 'pending' | 'in_progress' | 'completed';
    }[];
  };
  readonly observed?: readonly {
    readonly verb: string;
    readonly target?: string;
    readonly result?: string;
  }[];
};

export type Activity = ChannelEnvelope & {
  readonly type: 'activity';
  readonly sessionId: string;
  readonly stepId: string;
  readonly status: 'started' | 'updated' | 'completed' | 'failed';
  readonly detail: ActivityDetail;
};

/** Unknown has no body, tags, or payload, so it cannot satisfy a chat selector. */
export type Unknown = {
  readonly type: 'unknown';
  readonly eventId?: EventId;
  readonly authorPubkey?: Pubkey;
  readonly createdAt?: number;
  readonly sourceKind?: number;
  readonly reason:
    | 'invalid-signature'
    | 'invalid-envelope'
    | 'foreign-channel'
    | 'unresolved-identity'
    | 'unauthorized'
    | 'unknown-schema'
    | 'malformed-schema'
    | 'orphan-reply'
    | 'cross-channel-reply';
};

export type ReadEvent =
  | HumanMessage
  | AgentMessage
  | Control
  | SessionUpdate
  | Lifecycle
  | Membership
  | Activity
  | Unknown;

export type ReadModelDiagnostic = {
  readonly code: Unknown['reason'] | 'invalid-corner-transition' | 'corner-without-human';
  readonly eventId?: EventId;
  readonly channelId?: ChannelId;
  readonly entityId?: string;
};

export type KnownMembership = {
  readonly status: 'known';
  readonly members: Readonly<
    Record<string, { readonly pubkey: Pubkey; readonly role: MemberRole }>
  >;
  readonly sourceEventId: EventId;
  readonly observedAt: number;
};

export type UnknownMembership = {
  readonly status: 'unknown';
  readonly reason: 'not-loaded' | 'unavailable' | 'unverified';
};

export type MembershipState = KnownMembership | UnknownMembership;

export type Coverage = {
  readonly oldest?: number;
  readonly newest?: number;
  readonly initialBackfillComplete: boolean;
  readonly epoch: number;
};

export type HumanMember = {
  readonly pubkey: Pubkey;
  readonly role: MemberRole;
  readonly identity: Extract<IdentityRecord, { readonly kind: 'human' }>;
};

export type ActiveCorner = {
  readonly kind: 'active';
  readonly id: ChannelId;
  readonly parentRoomId: ChannelId;
  readonly state: Exclude<CornerMachineState, 'concluded' | 'closed'>;
  readonly name?: string;
  readonly task?: string;
  readonly creatorPubkey?: Pubkey;
  readonly createdAt?: number;
  readonly stateAt: number;
  readonly reason?: CornerMachineReason;
  readonly humanMembers: NonEmptyReadonlyArray<HumanMember>;
  readonly leaseUntil?: number;
};

export type TerminalCorner = {
  readonly kind: 'terminal';
  readonly id: ChannelId;
  readonly parentRoomId: ChannelId;
  readonly state: 'concluded' | 'closed';
  readonly name?: string;
  readonly task?: string;
  readonly creatorPubkey?: Pubkey;
  readonly createdAt?: number;
  readonly stateAt: number;
};

export type HaltedCorner = {
  readonly kind: 'integrity-halt';
  readonly id: ChannelId;
  readonly parentRoomId: ChannelId;
  readonly reason: 'corner-without-human' | 'invalid-corner-transition';
  readonly name?: string;
  readonly task?: string;
  readonly creatorPubkey?: Pubkey;
  readonly createdAt?: number;
  readonly stateAt: number;
  readonly operatorMessage: string;
};

export type CornerSnapshot = ActiveCorner | TerminalCorner | HaltedCorner;

export type RoomSnapshot = {
  readonly channelId: ChannelId;
  readonly metadata: {
    readonly name?: string;
    readonly about?: string;
    readonly archived: boolean;
    readonly deleted: boolean;
  };
  readonly eventJournal: Readonly<Record<string, Exclude<ReadEvent, Unknown>>>;
  readonly membershipEvents: readonly EventId[];
  readonly lifecycleEvents: readonly EventId[];
  readonly membership: MembershipState;
  readonly corners: Readonly<Record<string, CornerSnapshot>>;
  readonly coverage: Coverage;
};

export type WorkspaceSnapshot = {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly revision: number;
  readonly identities: Readonly<Record<string, IdentityRecord>>;
  readonly rooms: Readonly<Record<string, RoomSnapshot>>;
  readonly diagnostics: readonly ReadModelDiagnostic[];
};

export type ParseAuthority = {
  readonly workspaceId: string;
  readonly expectedChannelId?: string;
  readonly allowedChannelIds?: readonly string[];
  readonly identities: Readonly<Record<string, IdentityRecord>>;
  readonly channelCreators?: Readonly<Record<string, string>>;
  readonly channelAdmins?: Readonly<Record<string, readonly string[]>>;
  readonly trustedProjectionPubkeys?: readonly string[];
  readonly knownMessages?: Readonly<
    Record<string, { readonly channelId: string; readonly rootId?: string }>
  >;
};

export type SnapshotInput = {
  readonly workspaceId: string;
  readonly identities?: readonly IdentityRecord[];
};
