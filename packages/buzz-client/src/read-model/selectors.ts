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

export type RepositorySummary = {
  readonly key: string;
  readonly name: string;
  readonly remote: string;
  readonly targetBranch?: string;
  readonly githubInstallationId?: number;
  readonly githubEventsEnabled?: boolean;
};

/** Latest authorized Room repository fact, already parsed into the read model. */
export function selectRepositorySummary(
  snapshot: WorkspaceSnapshot,
  channelId: string,
): RepositorySummary | undefined {
  const roomSnapshot =
    Object.values(snapshot.rooms).find((candidate) => candidate.corners[channelId]) ??
    room(snapshot, channelId);
  if (!roomSnapshot) return undefined;
  const events = orderedEvents(roomSnapshot);
  const repository = events
    .filter(
      (event): event is Control => event.type === 'control' && event.payload.kind === 'repository',
    )
    .at(-1)?.payload;
  if (repository?.kind === 'repository') {
    return {
      key: repository.key,
      name: repository.name,
      remote: repository.remote,
      ...(repository.targetBranch ? { targetBranch: repository.targetBranch } : {}),
      ...(repository.githubInstallationId
        ? { githubInstallationId: repository.githubInstallationId }
        : {}),
      ...(repository.githubEventsEnabled === undefined
        ? {}
        : { githubEventsEnabled: repository.githubEventsEnabled }),
    };
  }
  const genesis = events.find(
    (event) =>
      event.type === 'lifecycle' &&
      event.lifecycle.entity === 'room' &&
      event.lifecycle.state === 'created' &&
      event.lifecycle.repository,
  );
  if (genesis?.type !== 'lifecycle' || genesis.lifecycle.entity !== 'room') return undefined;
  return genesis.lifecycle.repository;
}

export type ReviewSummary = {
  readonly state: 'none' | 'ready' | 'landing' | 'realigning' | 'landed' | 'failed';
  readonly target?: {
    readonly repository: string;
    readonly branch: string;
    readonly tip: string;
    readonly patchId?: string;
    readonly previewUrl?: string;
  };
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly previewSummary?: string;
  readonly approvedBy: readonly Pubkey[];
  readonly daemonAcknowledgement?: {
    readonly approvalId: string;
    readonly decision: 'accepted' | 'rejected';
    readonly state?: 'landing' | 'realigning' | 'realigned' | 'content-changed' | 'tip-moved';
  };
  readonly outcome?: { readonly kind: 'landed' | 'failed'; readonly detail?: string };
};

/**
 * Durable merge/review state selected only from typed read-model facts. Patch
 * bodies stay outside this summary and remain lazy.
 */
export function selectReviewSummary(snapshot: WorkspaceSnapshot, channelId: string): ReviewSummary {
  const roomSnapshot = room(snapshot, channelId);
  if (!roomSnapshot) return { state: 'none', files: [], fileCount: 0, approvedBy: [] };
  let target: ReviewSummary['target'];
  let state: ReviewSummary['state'] = 'none';
  let acknowledgement: ReviewSummary['daemonAcknowledgement'];
  let outcome: ReviewSummary['outcome'];
  let approvedBy = new Set<Pubkey>();
  let pendingApprovalSecond: number | undefined;
  let pendingApprovals: {
    readonly event: Control;
    readonly payload: Extract<Control['payload'], { readonly kind: 'merge-approval' }>;
  }[] = [];
  const manifests = new Map<
    string,
    Map<number, Extract<Control['payload'], { kind: 'review-manifest' }>>
  >();
  const completions = new Map<string, Extract<Control['payload'], { kind: 'review-complete' }>>();

  for (const event of orderedEvents(roomSnapshot)) {
    if (pendingApprovalSecond !== event.createdAt) {
      pendingApprovalSecond = event.createdAt;
      pendingApprovals = [];
    }
    if (event.type !== 'control') continue;
    const payload = event.payload;
    if (payload.kind === 'review-manifest') {
      if (!payload.transactional) continue;
      const chunks = manifests.get(payload.tip) ?? new Map();
      chunks.set(payload.chunk, payload);
      manifests.set(payload.tip, chunks);
      continue;
    }
    if (payload.kind === 'review-complete') {
      completions.set(payload.tip, payload);
      continue;
    }
    if (payload.kind === 'merge-approval') {
      if (target && payload.repository === target.repository && payload.branch === target.branch) {
        approvedBy.add(event.authorPubkey);
      } else {
        pendingApprovals.push({ event, payload });
      }
      continue;
    }
    if (payload.kind !== 'merge') continue;
    if (payload.action === 'ready' && payload.repository && payload.branch && payload.tip) {
      const sameMerge =
        target?.repository === payload.repository && target.branch === payload.branch;
      if (!sameMerge) approvedBy = new Set();
      target = {
        repository: payload.repository,
        branch: payload.branch,
        tip: payload.tip,
        ...(payload.patchId ? { patchId: payload.patchId } : {}),
        ...(payload.previewUrl ? { previewUrl: payload.previewUrl } : {}),
      };
      state = 'ready';
      acknowledgement = undefined;
      outcome = undefined;
      for (const approval of pendingApprovals) {
        if (
          approval.payload.repository === target.repository &&
          approval.payload.branch === target.branch
        ) {
          approvedBy.add(approval.event.authorPubkey);
        }
      }
      continue;
    }
    if (payload.action === 'not-ready') {
      target = undefined;
      state = 'none';
      approvedBy = new Set();
      pendingApprovals = [];
      acknowledgement = undefined;
      outcome = undefined;
      continue;
    }
    if (payload.action === 'approval-ack' && payload.decision) {
      acknowledgement = {
        approvalId: payload.approvalId ?? event.eventId,
        decision: payload.decision,
        ...(payload.state ? { state: payload.state } : {}),
      };
      state =
        payload.decision === 'rejected'
          ? 'failed'
          : payload.state === 'realigning' || payload.state === 'realigned'
            ? 'realigning'
            : 'landing';
      if (payload.decision === 'rejected') {
        outcome = { kind: 'failed', ...(payload.text ? { detail: payload.text } : {}) };
      }
      continue;
    }
    if (payload.action === 'landed') {
      state = 'landed';
      outcome = { kind: 'landed', ...(payload.text ? { detail: payload.text } : {}) };
      continue;
    }
    if (payload.action === 'failed') {
      state = 'failed';
      outcome = { kind: 'failed', ...(payload.text ? { detail: payload.text } : {}) };
    }
  }

  const completion = target ? completions.get(target.tip) : undefined;
  const manifestChunks = target ? manifests.get(target.tip) : undefined;
  const completeManifests =
    completion &&
    manifestChunks?.size === completion.manifestChunks &&
    [...manifestChunks.keys()]
      .sort((left, right) => left - right)
      .every((chunk, index) => chunk === index)
      ? [...manifestChunks.values()].sort((left, right) => left.chunk - right.chunk)
      : [];
  const files = [
    ...new Set(completeManifests.flatMap((manifest) => manifest.files.map((file) => file.path))),
  ];
  const complete = Boolean(completion && files.length === completion.fileCount);
  return {
    state,
    ...(target ? { target } : {}),
    files: complete ? files : [],
    fileCount: complete ? completion!.fileCount : 0,
    ...(complete ? { previewSummary: completion!.summary } : {}),
    approvedBy: [...approvedBy].sort(),
    ...(acknowledgement ? { daemonAcknowledgement: acknowledgement } : {}),
    ...(outcome ? { outcome } : {}),
  };
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
