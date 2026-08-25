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
  SessionUpdate,
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
  readonly authorPubkey: Pubkey;
  readonly requestId: string;
  readonly timestamp: number;
  readonly steps: readonly Activity[];
  readonly thought?: string;
  readonly messageDraft?: string;
  readonly live: true;
};

export type TranscriptDurableFactItem = {
  readonly kind: 'durable-fact';
  readonly id: EventId;
  readonly channelId: ChannelId;
  readonly authorPubkey: Pubkey;
  readonly timestamp: number;
  readonly factKind: NonNullable<Activity['durableFact']>;
  readonly activity: Activity;
};

export type TranscriptSystemItem = {
  readonly kind: 'system-line' | 'card';
  readonly id: EventId;
  readonly channelId: ChannelId;
  readonly timestamp: number;
  readonly payload: Control['payload'];
};

export type TranscriptItem =
  | TranscriptConversationItem
  | TranscriptActivityItem
  | TranscriptDurableFactItem
  | TranscriptSystemItem;

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
  const events = orderedEvents(roomSnapshot);
  const latestTurns = new Map<
    Pubkey,
    Extract<SessionUpdate, { readonly type: 'session-update' }>
  >();
  for (const event of events) {
    if (event.type === 'session-update' && event.update.kind === 'turn') {
      latestTurns.set(event.update.agentPubkey, event);
    }
  }

  const pushDurableFact = (event: Activity) => {
    const item: TranscriptDurableFactItem = {
      kind: 'durable-fact',
      id: event.eventId,
      channelId: event.channelId,
      authorPubkey: event.authorPubkey,
      timestamp: event.createdAt,
      factKind: event.durableFact!,
      activity: event,
    };
    // A machine run earns at most one settled line. Prefer failure over every
    // other fact; otherwise the newest consequential outcome is authoritative.
    let previousIndex = -1;
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const candidate = output[index]!;
      if (
        candidate.kind === 'durable-fact' ||
        candidate.kind === 'human-message' ||
        candidate.kind === 'agent-message'
      ) {
        previousIndex = index;
        break;
      }
    }
    const previous = previousIndex >= 0 ? output[previousIndex] : undefined;
    if (previous?.kind !== 'durable-fact') {
      output.push(item);
      return;
    }
    if (previous.factKind !== 'failure' || item.factKind === 'failure') {
      output[previousIndex] = item;
    }
  };

  for (const event of events) {
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
    if (event.type === 'activity' && event.durableFact) {
      const latestTurn = latestTurns.get(event.authorPubkey);
      const active = latestTurn?.update.kind === 'turn' && latestTurn.update.status === 'working';
      if (!active) pushDurableFact(event);
    }
  }

  // Ephemeral machine lanes exist only while the daemon's latest signed turn
  // marker says WORKING. They are synthesized after the durable transcript so
  // no closed draft, thought, or routine tool event can survive warm start.
  for (const [agentPubkey, turn] of latestTurns) {
    if (turn.update.kind !== 'turn' || turn.update.status !== 'working') continue;
    const activity = events.filter(
      (event): event is Activity =>
        event.type === 'activity' &&
        event.authorPubkey === agentPubkey &&
        event.sessionId === turn.sessionId &&
        event.createdAt >= turn.createdAt,
    );
    const latestLane = (kind: 'draft' | 'thought') =>
      events
        .filter(
          (event): event is SessionUpdate =>
            event.type === 'session-update' &&
            event.update.kind === kind &&
            event.update.agentPubkey === agentPubkey &&
            event.createdAt >= turn.createdAt,
        )
        .at(-1);
    const draft = latestLane('draft');
    const thought = latestLane('thought');
    const messageDraft =
      draft?.update.kind === 'draft' &&
      draft.update.requestId === turn.update.requestId &&
      !draft.update.closed
        ? draft.update.text
        : undefined;
    const thoughtText =
      thought?.update.kind === 'thought' && !thought.update.closed
        ? thought.update.text
        : undefined;
    if (!activity.length && !messageDraft && !thoughtText) continue;
    const timestamp = Math.max(
      turn.createdAt,
      ...activity.map((event) => event.createdAt),
      draft?.createdAt ?? 0,
      thought?.createdAt ?? 0,
    );
    if (input?.before !== undefined && timestamp >= input.before) continue;
    output.push({
      kind: 'activity',
      id: `live-turn:${turn.update.requestId}` as EventId,
      channelId: turn.channelId,
      sessionId: turn.sessionId,
      authorPubkey: agentPubkey,
      requestId: turn.update.requestId,
      timestamp,
      steps: activity,
      ...(thoughtText ? { thought: thoughtText } : {}),
      ...(messageDraft ? { messageDraft } : {}),
      live: true,
    });
  }
  output.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
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
