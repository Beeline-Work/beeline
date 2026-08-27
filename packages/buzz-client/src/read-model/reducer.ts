import { canTransitionCornerState, type CornerMachineState } from '../corner-state.js';
import { KIND_CHANNEL_ADMINS, KIND_CHANNEL_MEMBERS } from '../kinds.js';
import type {
  ActiveCorner,
  ChannelId,
  CornerSnapshot,
  EventId,
  HaltedCorner,
  HumanMember,
  IdentityRecord,
  KnownMembership,
  Lifecycle,
  MemberRole,
  Membership,
  MembershipState,
  NonEmptyReadonlyArray,
  Pubkey,
  ReadEvent,
  ReadModelDiagnostic,
  RoomSnapshot,
  SnapshotInput,
  TerminalCorner,
  Unknown,
  WorkspaceSnapshot,
} from './types.js';

const UNKNOWN_MEMBERSHIP: MembershipState = { status: 'unknown', reason: 'not-loaded' };

function compareClock(
  left: Pick<Exclude<ReadEvent, Unknown>, 'createdAt' | 'eventId'>,
  right: Pick<Exclude<ReadEvent, Unknown>, 'createdAt' | 'eventId'>,
): number {
  return left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId);
}

function emptyRoom(channelId: ChannelId): RoomSnapshot {
  return {
    channelId,
    metadata: { archived: false, deleted: false },
    eventJournal: {},
    membershipEvents: [],
    lifecycleEvents: [],
    membership: UNKNOWN_MEMBERSHIP,
    corners: {},
    coverage: { initialBackfillComplete: false, epoch: 0 },
  };
}

export function createWorkspaceSnapshot(input: SnapshotInput): WorkspaceSnapshot {
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    revision: 0,
    identities: Object.fromEntries((input.identities ?? []).map((item) => [item.pubkey, item])),
    rooms: {},
    diagnostics: [],
  };
}

function membershipFromEvents(room: RoomSnapshot): MembershipState {
  const events = room.membershipEvents
    .map((id) => room.eventJournal[id])
    .filter((event): event is Membership => event?.type === 'membership')
    .sort(compareClock);
  const seedEvents = room.lifecycleEvents
    .map((id) => room.eventJournal[id])
    .filter(
      (event): event is Lifecycle =>
        event?.type === 'lifecycle' &&
        event.lifecycle.entity === 'room' &&
        Boolean(event.lifecycle.initialMembers),
    )
    .sort(compareClock);
  if (events.length === 0 && seedEvents.length === 0) return room.membership;

  const latestMemberSnapshot = [...events]
    .reverse()
    .find(
      (event) => event.membership.mode === 'snapshot' && event.sourceKind === KIND_CHANNEL_MEMBERS,
    );
  const latestAdminSnapshot = [...events]
    .reverse()
    .find(
      (event) => event.membership.mode === 'snapshot' && event.sourceKind === KIND_CHANNEL_ADMINS,
    );
  const latestSnapshot = [latestMemberSnapshot, latestAdminSnapshot]
    .filter((event): event is Membership => event !== undefined)
    .sort(compareClock)
    .at(-1);
  const latestSeed = seedEvents.at(-1);
  const seedWins =
    latestSeed && (!latestSnapshot || compareClock(latestSeed, latestSnapshot) > 0)
      ? latestSeed
      : undefined;
  const members: Record<string, { pubkey: Pubkey; role: MemberRole }> = {};
  if (seedWins?.lifecycle.entity === 'room') {
    for (const member of seedWins.lifecycle.initialMembers ?? []) members[member.pubkey] = member;
  } else {
    if (latestMemberSnapshot?.membership.mode === 'snapshot') {
      for (const member of latestMemberSnapshot.membership.members) members[member.pubkey] = member;
    }
    if (latestAdminSnapshot?.membership.mode === 'snapshot') {
      for (const member of latestAdminSnapshot.membership.members) {
        members[member.pubkey] = { ...member, role: member.role === 'owner' ? 'owner' : 'admin' };
      }
    }
  }
  const floor = seedWins ?? latestSnapshot;
  for (const event of events) {
    if (floor && compareClock(event, floor) <= 0) continue;
    if (event.membership.mode !== 'mutation') continue;
    const mutation = event.membership;
    if (mutation.action === 'leave') {
      delete members[mutation.memberPubkey];
      continue;
    }
    const current = members[mutation.memberPubkey];
    members[mutation.memberPubkey] = {
      pubkey: mutation.memberPubkey,
      role: mutation.role ?? current?.role ?? 'member',
    };
  }
  const source = [...events, ...seedEvents].sort(compareClock).at(-1)!;
  return {
    status: 'known',
    members,
    sourceEventId: source.eventId,
    observedAt: source.createdAt,
  } satisfies KnownMembership;
}

function metadataFromEvents(room: RoomSnapshot): RoomSnapshot['metadata'] {
  const metadata: RoomSnapshot['metadata'] = { archived: false, deleted: false };
  const lifecycle = room.lifecycleEvents
    .map((id) => room.eventJournal[id])
    .filter(
      (event): event is Lifecycle =>
        event?.type === 'lifecycle' && event.lifecycle.entity === 'room',
    )
    .sort(compareClock);
  let name: string | undefined;
  let about: string | undefined;
  let avatar: string | undefined;
  let archived = false;
  let deleted = false;
  for (const event of lifecycle) {
    if (event.lifecycle.entity !== 'room') continue;
    name = event.lifecycle.name ?? name;
    about = event.lifecycle.about ?? about;
    avatar = event.lifecycle.avatar ?? avatar;
    archived =
      archived || event.lifecycle.state === 'archived' || event.lifecycle.state === 'deleted';
    deleted = deleted || event.lifecycle.state === 'deleted';
  }
  return {
    ...(name ? { name } : {}),
    ...(about ? { about } : {}),
    ...(avatar ? { avatar } : {}),
    archived,
    deleted,
  };
}

function humanMembers(
  membership: MembershipState,
  identities: WorkspaceSnapshot['identities'],
): HumanMember[] {
  if (membership.status !== 'known') return [];
  return Object.values(membership.members).flatMap((member) => {
    const memberIdentity = identities[member.pubkey];
    return memberIdentity?.kind === 'human'
      ? [{ pubkey: member.pubkey, role: member.role, identity: memberIdentity }]
      : [];
  });
}

function cornerLifecycleEvents(
  snapshot: WorkspaceSnapshot,
  parent: RoomSnapshot,
  cornerId: string,
): Lifecycle[] {
  return parent.lifecycleEvents
    .map((id) => parent.eventJournal[id])
    .filter(
      (event): event is Lifecycle =>
        event?.type === 'lifecycle' &&
        event.lifecycle.entity === 'corner' &&
        event.lifecycle.cornerId === cornerId,
    )
    .sort(compareClock);
}

function haltCorner(
  id: ChannelId,
  parentRoomId: ChannelId,
  reason: HaltedCorner['reason'],
  facts: {
    readonly name?: string;
    readonly task?: string;
    readonly creatorPubkey?: Pubkey;
    readonly createdAt?: number;
    readonly stateAt: number;
  },
): HaltedCorner {
  return {
    kind: 'integrity-halt',
    id,
    parentRoomId,
    reason,
    ...facts,
    operatorMessage:
      reason === 'corner-without-human'
        ? `Corner ${id} has no verified human member. Reconcile membership before resuming.`
        : `Corner ${id} has an invalid lifecycle transition. Repair its canonical state record.`,
  };
}

function materializeCorner(
  snapshot: WorkspaceSnapshot,
  parent: RoomSnapshot,
  cornerId: ChannelId,
): CornerSnapshot | undefined {
  const lifecycle = cornerLifecycleEvents(snapshot, parent, cornerId);
  if (lifecycle.length === 0) return undefined;
  let state: CornerMachineState | undefined;
  let valid = true;
  let exists = false;
  let leaseUntil: number | undefined;
  let name: string | undefined;
  let task: string | undefined;
  let creatorPubkey: Pubkey | undefined;
  let createdAt: number | undefined;
  let reason: ActiveCorner['reason'];
  for (const event of lifecycle) {
    if (event.lifecycle.entity !== 'corner') continue;
    exists = event.lifecycle.exists;
    if (!canTransitionCornerState(state, event.lifecycle.state)) valid = false;
    if (valid) state = event.lifecycle.state;
    leaseUntil = event.lifecycle.leaseUntil;
    name = event.lifecycle.name ?? name;
    task = event.lifecycle.task ?? task;
    creatorPubkey = event.lifecycle.creatorPubkey ?? creatorPubkey;
    createdAt = event.lifecycle.createdAt ?? createdAt;
    reason = event.lifecycle.reason;
  }
  const latest = lifecycle.at(-1)!;
  if (latest.lifecycle.entity !== 'corner' || !state) return undefined;
  const facts = {
    ...(name ? { name } : {}),
    ...(task ? { task } : {}),
    ...(creatorPubkey ? { creatorPubkey } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    stateAt: latest.lifecycle.stateAt ?? latest.createdAt,
  };
  // A child Room tombstone is relay truth about the corner's existence. It
  // must beat an older daemon state record just as a canonical CLOSED record
  // does; otherwise a channel archived while its daemon was absent can remain
  // projected as WAITING/READY forever. Keep this verdict at the existing
  // corner materialization door so every selector sees the same terminal row.
  const child = snapshot.rooms[cornerId];
  if (child?.metadata.archived || child?.metadata.deleted) {
    return {
      kind: 'terminal',
      id: cornerId,
      parentRoomId: parent.channelId,
      state: 'closed',
      ...facts,
    } satisfies TerminalCorner;
  }
  if (!valid) {
    return haltCorner(cornerId, parent.channelId, 'invalid-corner-transition', facts);
  }
  if (state === 'concluded' || state === 'closed') {
    return {
      kind: 'terminal',
      id: cornerId,
      parentRoomId: parent.channelId,
      state,
      ...facts,
    } satisfies TerminalCorner;
  }
  if (!exists) return undefined;
  const create = lifecycle.find(
    (event) => event.lifecycle.entity === 'corner' && event.lifecycle.initialMembers,
  );
  const seededMembership: MembershipState =
    create?.lifecycle.entity === 'corner' && create.lifecycle.initialMembers
      ? {
          status: 'known',
          members: Object.fromEntries(
            create.lifecycle.initialMembers.map((member) => [member.pubkey, member]),
          ),
          sourceEventId: create.eventId,
          observedAt: create.createdAt,
        }
      : UNKNOWN_MEMBERSHIP;
  const members = humanMembers(
    snapshot.rooms[cornerId]?.membership.status === 'known'
      ? snapshot.rooms[cornerId]!.membership
      : seededMembership,
    snapshot.identities,
  );
  if (members.length === 0) {
    return haltCorner(cornerId, parent.channelId, 'corner-without-human', facts);
  }
  return {
    kind: 'active',
    id: cornerId,
    parentRoomId: parent.channelId,
    state,
    ...facts,
    ...(reason ? { reason } : {}),
    humanMembers: members as unknown as NonEmptyReadonlyArray<HumanMember>,
    ...(leaseUntil !== undefined ? { leaseUntil } : {}),
  } satisfies ActiveCorner;
}

function materializeAllCorners(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const rooms: Record<string, RoomSnapshot> = { ...snapshot.rooms };
  const diagnostics = snapshot.diagnostics.filter(
    (diagnostic) =>
      diagnostic.code !== 'corner-without-human' && diagnostic.code !== 'invalid-corner-transition',
  );
  for (const room of Object.values(snapshot.rooms)) {
    const cornerIds = new Set(
      room.lifecycleEvents.flatMap((id) => {
        const event = room.eventJournal[id];
        return event?.type === 'lifecycle' && event.lifecycle.entity === 'corner'
          ? [event.lifecycle.cornerId]
          : [];
      }),
    );
    const corners: Record<string, CornerSnapshot> = {};
    for (const cornerId of cornerIds) {
      const corner = materializeCorner(snapshot, room, cornerId);
      if (!corner) continue;
      corners[cornerId] = corner;
      if (corner.kind === 'integrity-halt') {
        diagnostics.push({
          code: corner.reason,
          channelId: room.channelId,
          entityId: corner.id,
        });
      }
    }
    rooms[room.channelId] = { ...room, corners };
  }
  return { ...snapshot, rooms, diagnostics };
}

function addDiagnostic(snapshot: WorkspaceSnapshot, event: Unknown): WorkspaceSnapshot {
  const diagnostic: ReadModelDiagnostic = {
    code: event.reason,
    ...(event.eventId ? { eventId: event.eventId } : {}),
  };
  if (
    snapshot.diagnostics.some(
      (candidate) => candidate.code === diagnostic.code && candidate.eventId === diagnostic.eventId,
    )
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    diagnostics: [...snapshot.diagnostics, diagnostic].sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        String(left.eventId ?? '').localeCompare(String(right.eventId ?? '')) ||
        String(left.channelId ?? '').localeCompare(String(right.channelId ?? '')) ||
        String(left.entityId ?? '').localeCompare(String(right.entityId ?? '')),
    ),
  };
}

function withIdentity(
  snapshot: WorkspaceSnapshot,
  identity: IdentityRecord,
  materializeCorners = true,
): WorkspaceSnapshot {
  const current = snapshot.identities[identity.pubkey];
  if (current && current.revision >= identity.revision) return snapshot;
  const next = {
    ...snapshot,
    revision: snapshot.revision + 1,
    identities: { ...snapshot.identities, [identity.pubkey]: identity },
  };
  return materializeCorners ? materializeAllCorners(next) : next;
}

function reduceWorkspaceSnapshotInternal(
  snapshot: WorkspaceSnapshot,
  event: ReadEvent,
  materializeCorners: boolean,
): WorkspaceSnapshot {
  if (event.type === 'unknown') return addDiagnostic(snapshot, event);
  if (event.type === 'control' && event.payload.kind === 'identity') {
    return withIdentity(snapshot, event.payload.identity, materializeCorners);
  }
  if (event.scope !== 'channel') return snapshot;
  const currentRoom = snapshot.rooms[event.channelId] ?? emptyRoom(event.channelId);
  if (currentRoom.eventJournal[event.eventId]) return snapshot;
  const eventJournal = { ...currentRoom.eventJournal, [event.eventId]: event };
  let room: RoomSnapshot = {
    ...currentRoom,
    eventJournal,
    membershipEvents:
      event.type === 'membership'
        ? [...currentRoom.membershipEvents, event.eventId].sort((left, right) => {
            const a = eventJournal[left]!;
            const b = eventJournal[right]!;
            return compareClock(a, b);
          })
        : currentRoom.membershipEvents,
    lifecycleEvents:
      event.type === 'lifecycle'
        ? [...currentRoom.lifecycleEvents, event.eventId].sort((left, right) => {
            const a = eventJournal[left]!;
            const b = eventJournal[right]!;
            return compareClock(a, b);
          })
        : currentRoom.lifecycleEvents,
    coverage: {
      ...currentRoom.coverage,
      oldest: Math.min(currentRoom.coverage.oldest ?? event.createdAt, event.createdAt),
      newest: Math.max(currentRoom.coverage.newest ?? event.createdAt, event.createdAt),
    },
  };
  if (event.type === 'membership') room = { ...room, membership: membershipFromEvents(room) };
  if (event.type === 'lifecycle') {
    room = {
      ...room,
      membership: membershipFromEvents(room),
      metadata: metadataFromEvents(room),
    };
  }
  const next = {
    ...snapshot,
    revision: snapshot.revision + 1,
    rooms: { ...snapshot.rooms, [event.channelId]: room },
  };
  return materializeCorners ? materializeAllCorners(next) : next;
}

/** Pure, immutable, idempotent fold of one already-validated fact. */
export function reduceWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
  event: ReadEvent,
): WorkspaceSnapshot {
  return reduceWorkspaceSnapshotInternal(snapshot, event, true);
}

export function reduceWorkspaceEvents(
  snapshot: WorkspaceSnapshot,
  events: readonly ReadEvent[],
): WorkspaceSnapshot {
  // Materializing every corner after every fact turns a live burst into
  // repeated whole-Workspace work. Fold the validated journal facts first,
  // then derive corners once for the completed batch. The exported singular
  // reducer keeps its immediate-materialization contract for callers that
  // genuinely apply only one fact.
  const reduced = events.reduce(
    (current, event) => reduceWorkspaceSnapshotInternal(current, event, false),
    snapshot,
  );
  return reduced === snapshot ? snapshot : materializeAllCorners(reduced);
}

/**
 * A successful coverage commit advances only metadata. A stale epoch is a
 * no-op, making an older async read structurally unable to replace the journal.
 */
export function commitRoomCoverage(
  snapshot: WorkspaceSnapshot,
  channelId: string,
  input: {
    readonly epoch: number;
    readonly initialBackfillComplete: boolean;
    readonly oldest?: number;
    readonly newest?: number;
  },
): WorkspaceSnapshot {
  const room = snapshot.rooms[channelId];
  if (!room || input.epoch < room.coverage.epoch) return snapshot;
  const coverage = {
    epoch: input.epoch,
    initialBackfillComplete: input.initialBackfillComplete,
    oldest:
      input.oldest === undefined
        ? room.coverage.oldest
        : Math.min(room.coverage.oldest ?? input.oldest, input.oldest),
    newest:
      input.newest === undefined
        ? room.coverage.newest
        : Math.max(room.coverage.newest ?? input.newest, input.newest),
  };
  if (
    coverage.epoch === room.coverage.epoch &&
    coverage.initialBackfillComplete === room.coverage.initialBackfillComplete &&
    coverage.oldest === room.coverage.oldest &&
    coverage.newest === room.coverage.newest
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    rooms: { ...snapshot.rooms, [channelId]: { ...room, coverage } },
  };
}

export function replaceIdentitySnapshot(
  snapshot: WorkspaceSnapshot,
  identities: readonly IdentityRecord[],
): WorkspaceSnapshot {
  const byPubkey = Object.fromEntries(identities.map((item) => [item.pubkey, item]));
  return materializeAllCorners({
    ...snapshot,
    revision: snapshot.revision + 1,
    identities: byPubkey,
  });
}

/**
 * Canonicalize the materialized roster through server-verified succession and
 * the live relational member set. This changes presentation only: signed event
 * authors and the immutable journal remain untouched.
 */
export function canonicalizeWorkspaceMembership(
  snapshot: WorkspaceSnapshot,
  currentMembers: Readonly<Record<string, readonly string[]>>,
  succession: Readonly<Record<string, string>>,
): WorkspaceSnapshot {
  let changed = false;
  const seededMembership = (channelId: string): KnownMembership | undefined => {
    const existing = snapshot.rooms[channelId]?.membership;
    if (existing?.status === 'known') return existing;
    const source = Object.values(snapshot.rooms)
      .flatMap((room) => room.lifecycleEvents.map((eventId) => room.eventJournal[eventId]))
      .filter(
        (event): event is Lifecycle =>
          event?.type === 'lifecycle' &&
          (event.lifecycle.entity === 'room'
            ? event.lifecycle.roomId === channelId && event.lifecycle.state === 'created'
            : event.lifecycle.cornerId === channelId && event.lifecycle.createdAt !== undefined),
      )
      .sort(compareClock)
      .at(-1);
    if (!source) return undefined;
    const initialMembers = source.lifecycle.initialMembers?.length
      ? source.lifecycle.initialMembers
      : [{ pubkey: source.authorPubkey, role: 'owner' as const }];
    return {
      status: 'known',
      members: Object.fromEntries(initialMembers.map((member) => [member.pubkey, member])),
      sourceEventId: source.eventId,
      observedAt: source.createdAt,
    };
  };
  const rooms: Record<string, RoomSnapshot> = {};
  const channelIds = new Set([...Object.keys(snapshot.rooms), ...Object.keys(currentMembers)]);
  for (const channelId of channelIds) {
    const existingRoom = snapshot.rooms[channelId];
    const membership = seededMembership(channelId);
    if (!existingRoom && !membership) continue;
    const room = existingRoom ?? emptyRoom(channelId as ChannelId);
    const allowed = currentMembers[channelId];
    if (!allowed || !membership) {
      rooms[channelId] = room;
      continue;
    }
    const allowedSet = new Set(allowed);
    const members: Record<string, { pubkey: Pubkey; role: MemberRole }> = {};
    for (const member of Object.values(membership.members)) {
      const current = succession[member.pubkey] ?? member.pubkey;
      if (!allowedSet.has(current)) continue;
      const existing = members[current];
      const role =
        existing?.role === 'owner' || member.role === 'owner'
          ? 'owner'
          : existing?.role === 'admin' || member.role === 'admin'
            ? 'admin'
            : member.role;
      members[current] = { pubkey: current as Pubkey, role };
    }
    for (const pubkey of allowed) {
      members[pubkey] ??= { pubkey: pubkey as Pubkey, role: 'unknown' };
    }
    if (
      existingRoom &&
      room.membership.status === 'known' &&
      Object.keys(members).length === Object.keys(membership.members).length &&
      Object.entries(members).every(
        ([pubkey, member]) => membership.members[pubkey]?.role === member.role,
      )
    ) {
      rooms[channelId] = room;
      continue;
    }
    changed = true;
    rooms[channelId] = {
      ...room,
      membership: { ...membership, members },
    } satisfies RoomSnapshot;
  }
  return changed
    ? materializeAllCorners({ ...snapshot, revision: snapshot.revision + 1, rooms })
    : snapshot;
}

/** Merge concurrent cache/backfill snapshots without ever replacing a journal. */
export function mergeWorkspaceSnapshots(
  left: WorkspaceSnapshot,
  right: WorkspaceSnapshot,
): WorkspaceSnapshot {
  if (left.workspaceId !== right.workspaceId) return left;
  const identities = Object.values({ ...left.identities, ...right.identities }).reduce<
    Record<string, IdentityRecord>
  >((current, identity) => {
    const existing = current[identity.pubkey];
    if (!existing || existing.revision < identity.revision) current[identity.pubkey] = identity;
    return current;
  }, {});
  const events = [...Object.values(left.rooms), ...Object.values(right.rooms)]
    .flatMap((room) => Object.values(room.eventJournal))
    .filter(
      (event, index, all) =>
        all.findIndex((candidate) => candidate.eventId === event.eventId) === index,
    );
  let merged = reduceWorkspaceEvents(
    createWorkspaceSnapshot({
      workspaceId: left.workspaceId,
      identities: Object.values(identities),
    }),
    events,
  );
  for (const channelId of new Set([...Object.keys(left.rooms), ...Object.keys(right.rooms)])) {
    const leftCoverage = left.rooms[channelId]?.coverage;
    const rightCoverage = right.rooms[channelId]?.coverage;
    const epoch = Math.max(leftCoverage?.epoch ?? 0, rightCoverage?.epoch ?? 0);
    merged = commitRoomCoverage(merged, channelId, {
      epoch,
      initialBackfillComplete:
        Boolean(leftCoverage?.initialBackfillComplete) ||
        Boolean(rightCoverage?.initialBackfillComplete),
      ...([leftCoverage?.oldest, rightCoverage?.oldest]
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => a - b)[0] !== undefined
        ? {
            oldest: [leftCoverage?.oldest, rightCoverage?.oldest]
              .filter((value): value is number => value !== undefined)
              .sort((a, b) => a - b)[0],
          }
        : {}),
      ...([leftCoverage?.newest, rightCoverage?.newest]
        .filter((value): value is number => value !== undefined)
        .sort((a, b) => b - a)[0] !== undefined
        ? {
            newest: [leftCoverage?.newest, rightCoverage?.newest]
              .filter((value): value is number => value !== undefined)
              .sort((a, b) => b - a)[0],
          }
        : {}),
    });
  }
  return {
    ...merged,
    diagnostics: [...left.diagnostics, ...right.diagnostics]
      .filter(
        (diagnostic, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.code === diagnostic.code &&
              candidate.eventId === diagnostic.eventId &&
              candidate.channelId === diagnostic.channelId &&
              candidate.entityId === diagnostic.entityId,
          ) === index,
      )
      .sort(
        (a, b) =>
          a.code.localeCompare(b.code) ||
          String(a.eventId ?? '').localeCompare(String(b.eventId ?? '')),
      ),
  };
}
