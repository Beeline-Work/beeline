import type {
  Activity,
  AgentMessage,
  ChannelId,
  Control,
  CornerSnapshot,
  EventId,
  HumanMessage,
  IdentityRecord,
  KnownMessageReference,
  MemberRole,
  Pubkey,
  RoomSnapshot,
  WorkspaceSnapshot,
} from './types.js';

export type TranscriptConversationItem = {
  readonly kind: 'human-message' | 'agent-message';
  readonly id: EventId;
  readonly channelId: ChannelId;
  readonly authorPubkey: Pubkey;
  readonly body: string;
  readonly attachments: HumanMessage['attachments'];
  readonly mentionPubkeys: readonly Pubkey[];
  readonly reply?: KnownMessageReference;
  readonly timestamp: number;
};

export type TranscriptActivityItem = {
  readonly kind: 'activity';
  readonly id: EventId;
  readonly channelId: ChannelId;
  readonly sessionId: string;
  readonly timestamp: number;
  readonly steps: readonly Activity[];
};

export type TranscriptSystemItem = {
  readonly kind: 'system-line' | 'card';
  readonly id: EventId;
  readonly channelId: ChannelId;
  readonly timestamp: number;
  readonly payload: Control['payload'];
};

export type TranscriptItem =
  TranscriptConversationItem | TranscriptActivityItem | TranscriptSystemItem;

function room(snapshot: WorkspaceSnapshot, channelId: string): RoomSnapshot | undefined {
  return snapshot.rooms[channelId];
}

function orderedEvents(roomSnapshot: RoomSnapshot) {
  return Object.values(roomSnapshot.eventJournal).sort(
    (left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId),
  );
}

/** Human/agent prose, declared control presentation, and folded activity only. */
export function selectTranscript(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  input?: { readonly before?: number; readonly limit?: number },
): readonly TranscriptItem[] {
  const roomSnapshot = room(snapshot, channelId);
  if (!roomSnapshot) return [];
  const output: TranscriptItem[] = [];
  for (const event of orderedEvents(roomSnapshot)) {
    if (input?.before !== undefined && event.createdAt >= input.before) continue;
    if (event.type === 'human-message' || event.type === 'agent-message') {
      output.push({
        kind: event.type,
        id: event.eventId,
        channelId: event.channelId,
        authorPubkey: event.authorPubkey,
        body: event.body,
        attachments: event.attachments,
        mentionPubkeys: event.mentionPubkeys,
        ...(event.reply ? { reply: event.reply } : {}),
        timestamp: event.createdAt,
      });
      continue;
    }
    if (event.type === 'control' && event.visibility !== 'hidden') {
      output.push({
        kind: event.visibility,
        id: event.eventId,
        channelId: event.scope === 'channel' ? event.channelId : (channelId as ChannelId),
        timestamp: event.createdAt,
        payload: event.payload,
      });
      continue;
    }
    if (event.type !== 'activity') continue;
    const previous = output.at(-1);
    if (previous?.kind === 'activity' && previous.sessionId === event.sessionId) {
      output[output.length - 1] = { ...previous, steps: [...previous.steps, event] };
    } else {
      output.push({
        kind: 'activity',
        id: event.eventId,
        channelId: event.channelId,
        sessionId: event.sessionId,
        timestamp: event.createdAt,
        steps: [event],
      });
    }
  }
  const limit = input?.limit;
  return limit === undefined ? output : output.slice(-Math.max(0, limit));
}

export type SelectedMember = {
  readonly pubkey: Pubkey;
  readonly role: MemberRole;
  readonly identity?: IdentityRecord;
  readonly kind: IdentityRecord['kind'] | 'unresolved';
};

/** Membership is authoritative; identity can enrich a row but never remove it. */
export function selectMembers(
  snapshot: WorkspaceSnapshot,
  channelId: string,
): readonly SelectedMember[] {
  const membership = room(snapshot, channelId)?.membership;
  if (!membership || membership.status !== 'known') return [];
  return Object.values(membership.members)
    .map((member) => {
      const memberIdentity = snapshot.identities[member.pubkey];
      return {
        pubkey: member.pubkey,
        role: member.role,
        ...(memberIdentity ? { identity: memberIdentity } : {}),
        kind: memberIdentity?.kind ?? 'unresolved',
      } satisfies SelectedMember;
    })
    .sort((left, right) => left.pubkey.localeCompare(right.pubkey));
}

export function selectCorners(
  snapshot: WorkspaceSnapshot,
  roomId: string,
): readonly Exclude<CornerSnapshot, { readonly kind: 'terminal' }>[] {
  return Object.values(room(snapshot, roomId)?.corners ?? {})
    .filter(
      (corner): corner is Exclude<CornerSnapshot, { readonly kind: 'terminal' }> =>
        corner.kind !== 'terminal',
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export type RoomRowSelection = {
  readonly snapshotRevision: number;
  readonly preview?: TranscriptConversationItem;
  readonly unread: boolean;
  readonly memberCount: number;
  readonly cornerCount: number;
  readonly pinnedCorner?: Extract<CornerSnapshot, { readonly kind: 'active' }>;
  readonly integrityHalt?: Extract<CornerSnapshot, { readonly kind: 'integrity-halt' }>;
};

export function selectRoomRow(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  readMark?: { readonly at: number; readonly eventId?: string },
): RoomRowSelection {
  const conversation = selectTranscript(snapshot, channelId).filter(
    (item): item is TranscriptConversationItem =>
      item.kind === 'human-message' || item.kind === 'agent-message',
  );
  const preview = conversation.at(-1);
  const corners = selectCorners(snapshot, channelId);
  const active = corners.filter(
    (corner): corner is Extract<CornerSnapshot, { readonly kind: 'active' }> =>
      corner.kind === 'active',
  );
  const integrityHalt = corners.find(
    (corner): corner is Extract<CornerSnapshot, { readonly kind: 'integrity-halt' }> =>
      corner.kind === 'integrity-halt',
  );
  const unread = Boolean(
    preview &&
    (!readMark ||
      preview.timestamp > readMark.at ||
      (preview.timestamp === readMark.at && preview.id !== readMark.eventId)),
  );
  return {
    snapshotRevision: snapshot.revision,
    ...(preview ? { preview } : {}),
    unread,
    memberCount: selectMembers(snapshot, channelId).length,
    cornerCount: active.length,
    ...(active[0] ? { pinnedCorner: active[0] } : {}),
    ...(integrityHalt ? { integrityHalt } : {}),
  };
}

export type ReplyTargetSelection =
  | { readonly status: 'available'; readonly reference: KnownMessageReference }
  | {
      readonly status: 'unavailable';
      readonly reason: 'missing-room' | 'missing-message' | 'not-message';
    };

/** The only public constructor path for a composer reply parent. */
export function selectReplyTarget(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  eventId: string,
): ReplyTargetSelection {
  const roomSnapshot = room(snapshot, channelId);
  if (!roomSnapshot) return { status: 'unavailable', reason: 'missing-room' };
  const event = roomSnapshot.eventJournal[eventId];
  if (!event) return { status: 'unavailable', reason: 'missing-message' };
  if (event.type !== 'human-message' && event.type !== 'agent-message') {
    return { status: 'unavailable', reason: 'not-message' };
  }
  return {
    status: 'available',
    reference: {
      channelId: event.channelId,
      eventId: event.eventId,
      rootId: event.reply?.rootId ?? event.eventId,
    } as KnownMessageReference,
  };
}

export type AgentHistoryEntry = {
  readonly eventId: EventId;
  readonly channelId: ChannelId;
  readonly type: 'human-message' | 'agent-message';
  readonly author: {
    readonly pubkey: Pubkey;
    readonly kind: 'human' | 'agent';
    readonly label: string;
  };
  readonly body: string;
  readonly attachments: HumanMessage['attachments'];
  readonly createdAt: number;
  readonly provenance: 'relay-verified';
};

function identityLabel(identity: IdentityRecord): string {
  if (identity.kind === 'infrastructure') return `Infrastructure ${identity.pubkey.slice(0, 8)}`;
  return (
    identity.displayName?.trim() ||
    identity.handle?.trim() ||
    `${identity.kind === 'agent' ? 'Agent' : 'Member'} ${identity.pubkey.slice(0, 8)}`
  );
}

/** Names are resolved now, from current identity state, never from stored prose. */
export function selectAgentHistory(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  input?: { readonly limit?: number; readonly excludeEventId?: string },
): readonly AgentHistoryEntry[] {
  const transcript = selectTranscript(snapshot, channelId).filter(
    (item): item is TranscriptConversationItem =>
      item.kind === 'human-message' || item.kind === 'agent-message',
  );
  const entries = transcript.flatMap((item) => {
    if (item.id === input?.excludeEventId) return [];
    const author = snapshot.identities[item.authorPubkey];
    if (!author || author.kind === 'infrastructure') return [];
    return [
      {
        eventId: item.id,
        channelId: item.channelId,
        type: item.kind,
        author: { pubkey: author.pubkey, kind: author.kind, label: identityLabel(author) },
        body: item.body,
        attachments: item.attachments,
        createdAt: item.timestamp,
        provenance: 'relay-verified',
      } satisfies AgentHistoryEntry,
    ];
  });
  return entries.slice(-(input?.limit ?? 6));
}
