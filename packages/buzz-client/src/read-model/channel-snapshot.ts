import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { guardReadModelBoot, snapshotForPersistence } from './cache.js';
import {
  selectRepositorySummary,
  selectReviewSummary,
  selectTranscript,
  type RepositorySummary,
  type ReviewSummary,
} from './selectors.js';
import type {
  Control,
  IdentityRecord,
  Pubkey,
  ReadEvent,
  RoomSnapshot,
  WorkspaceSnapshot,
} from './types.js';

export const CHANNEL_SNAPSHOT_CAPABILITY = 'channel-snapshot-v1' as const;
export const CHANNEL_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CHANNEL_SNAPSHOT_PROJECTION_VERSION = 1 as const;
export const CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS = 30;
export const CHANNEL_SNAPSHOT_MAX_BYTES = 256 * 1024;

export type ChannelSnapshotCursorV1 = {
  /** Inclusive Nostr second used by the existing relay WebSocket subscription. */
  readonly createdAt: number;
  /** Every included event ID at `createdAt`, for inclusive replay de-duplication. */
  readonly eventIds: readonly string[];
};

/** Canonical, viewer-independent JSON stored once per relay tenant + channel. */
export type StoredChannelSnapshotV1 = {
  readonly capability: typeof CHANNEL_SNAPSHOT_CAPABILITY;
  readonly schemaVersion: typeof CHANNEL_SNAPSHOT_SCHEMA_VERSION;
  readonly projectionVersion: typeof CHANNEL_SNAPSHOT_PROJECTION_VERSION;
  readonly channelId: string;
  readonly revision: number;
  readonly projectedAt: number;
  readonly cursor: ChannelSnapshotCursorV1;
  readonly identitiesStale: boolean;
  /** Existing persisted read-model types; there is no parallel transcript-row schema. */
  readonly snapshot: WorkspaceSnapshot;
  readonly repository?: RepositorySummary;
  readonly review: ReviewSummary;
};

export type ChannelSnapshotViewerV1 = {
  readonly pubkey: string;
  readonly membership: 'active';
  readonly role: 'owner' | 'admin' | 'member' | 'unknown';
  readonly kind: IdentityRecord['kind'] | 'unresolved';
  readonly approval: 'approved' | 'not-approved' | 'not-applicable';
};

/** One paint-ready response: canonical snapshot plus a tiny live viewer overlay. */
export type ChannelSnapshotViewV1 = StoredChannelSnapshotV1 & {
  readonly lagMs: number;
  readonly viewer: ChannelSnapshotViewerV1;
  readonly integrity: {
    readonly algorithm: 'sha256';
    readonly scope: 'stored-channel-snapshot-v1';
    readonly digest: string;
  };
};

function sortedObject<T>(entries: readonly (readonly [string, T])[]): Readonly<Record<string, T>> {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function retainedControl(event: ReadEvent): event is Control {
  if (event.type !== 'control') return false;
  return (
    event.payload.kind === 'merge' ||
    event.payload.kind === 'merge-approval' ||
    event.payload.kind === 'repository'
  );
}

function boundedRoom(
  snapshot: WorkspaceSnapshot,
  roomSnapshot: RoomSnapshot,
  transcriptRoom: boolean,
  transcriptLimit: number,
): RoomSnapshot {
  if (!transcriptRoom) {
    return { ...roomSnapshot, eventJournal: {}, membershipEvents: [], lifecycleEvents: [] };
  }
  const keep = new Set<string>(
    selectTranscript(snapshot, roomSnapshot.channelId, { limit: transcriptLimit }).map(
      (item) => item.id,
    ),
  );
  for (const event of Object.values(roomSnapshot.eventJournal)) {
    if (retainedControl(event)) keep.add(event.eventId);
  }
  for (const eventId of [...keep]) {
    const event = roomSnapshot.eventJournal[eventId];
    if (
      (event?.type === 'human-message' || event?.type === 'agent-message') &&
      event.reply?.eventId
    ) {
      keep.add(event.reply.eventId);
    }
  }
  return {
    ...roomSnapshot,
    eventJournal: sortedObject(
      Object.entries(roomSnapshot.eventJournal).filter(([eventId]) => keep.has(eventId)),
    ),
    membershipEvents: roomSnapshot.membershipEvents.filter((eventId) => keep.has(eventId)),
    lifecycleEvents: roomSnapshot.lifecycleEvents.filter((eventId) => keep.has(eventId)),
  };
}

/**
 * Keep the requested Room/corner, its parent summary when applicable, and the
 * identities required by visible rows/rosters. Event journals remain the
 * existing persisted read-model type and are capped by projected row count.
 */
export function boundChannelWorkspaceSnapshot(
  input: WorkspaceSnapshot,
  channelId: string,
  transcriptLimit = CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS,
): WorkspaceSnapshot {
  const snapshot = snapshotForPersistence(input);
  const parent = Object.values(snapshot.rooms).find((candidate) => candidate.corners[channelId]);
  const roomIds = new Set([channelId, ...(parent ? [parent.channelId] : [])]);
  const rooms = sortedObject(
    Object.entries(snapshot.rooms)
      .filter(([roomId]) => roomIds.has(roomId))
      .map(
        ([roomId, roomSnapshot]) =>
          [
            roomId,
            boundedRoom(snapshot, roomSnapshot, roomId === channelId, transcriptLimit),
          ] as const,
      ),
  );
  const identityPubkeys = new Set<string>();
  for (const roomSnapshot of Object.values(rooms)) {
    if (roomSnapshot.membership.status === 'known') {
      for (const pubkey of Object.keys(roomSnapshot.membership.members))
        identityPubkeys.add(pubkey);
    }
    for (const event of Object.values(roomSnapshot.eventJournal)) {
      identityPubkeys.add(event.authorPubkey);
      if (event.type === 'human-message' || event.type === 'agent-message') {
        for (const pubkey of event.mentionPubkeys) identityPubkeys.add(pubkey);
      }
    }
    for (const corner of Object.values(roomSnapshot.corners)) {
      if (corner.creatorPubkey) identityPubkeys.add(corner.creatorPubkey);
      if (corner.kind === 'active') {
        for (const member of corner.humanMembers) identityPubkeys.add(member.pubkey);
      }
    }
  }
  return {
    ...snapshot,
    identities: sortedObject(
      Object.entries(snapshot.identities).filter(([pubkey]) => identityPubkeys.has(pubkey)),
    ),
    rooms,
    diagnostics: snapshot.diagnostics.filter(
      (diagnostic) => !diagnostic.channelId || roomIds.has(diagnostic.channelId),
    ),
  };
}

export type BuildStoredChannelSnapshotInput = {
  readonly snapshot: WorkspaceSnapshot;
  readonly channelId: string;
  readonly revision: number;
  readonly projectedAt: number;
  readonly cursor: ChannelSnapshotCursorV1;
  readonly identitiesStale: boolean;
  readonly maxBytes?: number;
};

/** Build and byte-cap the canonical shared payload, reducing transcript rows first. */
export function buildStoredChannelSnapshotV1(
  input: BuildStoredChannelSnapshotInput,
): StoredChannelSnapshotV1 {
  const maxBytes = input.maxBytes ?? CHANNEL_SNAPSHOT_MAX_BYTES;
  for (let limit = CHANNEL_SNAPSHOT_TRANSCRIPT_ROWS; limit >= 0; limit -= 1) {
    const bounded = boundChannelWorkspaceSnapshot(input.snapshot, input.channelId, limit);
    const payload: StoredChannelSnapshotV1 = {
      capability: CHANNEL_SNAPSHOT_CAPABILITY,
      schemaVersion: CHANNEL_SNAPSHOT_SCHEMA_VERSION,
      projectionVersion: CHANNEL_SNAPSHOT_PROJECTION_VERSION,
      channelId: input.channelId,
      revision: input.revision,
      projectedAt: input.projectedAt,
      cursor: input.cursor,
      identitiesStale: input.identitiesStale,
      snapshot: bounded,
      ...(selectRepositorySummary(input.snapshot, input.channelId)
        ? { repository: selectRepositorySummary(input.snapshot, input.channelId) }
        : {}),
      review: selectReviewSummary(input.snapshot, input.channelId),
    };
    if (utf8ToBytes(JSON.stringify(payload)).length <= maxBytes) return payload;
  }
  throw new Error(`channel snapshot structural state exceeds ${maxBytes} bytes`);
}

export function channelSnapshotDigest(payload: StoredChannelSnapshotV1): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(payload))));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type ChannelSnapshotGuardResult =
  | { readonly status: 'ready'; readonly view: ChannelSnapshotViewV1 }
  | { readonly status: 'integrity-halt'; readonly diagnostic: string };

/** Client/server golden contract guard. Incomplete or corrupt state never becomes an empty Room. */
export function guardChannelSnapshotViewV1(value: unknown): ChannelSnapshotGuardResult {
  const candidate = record(value);
  const cursor = record(candidate?.cursor);
  const viewer = record(candidate?.viewer);
  const integrity = record(candidate?.integrity);
  const review = record(candidate?.review);
  const repository = candidate?.repository === undefined ? undefined : record(candidate.repository);
  if (
    candidate?.capability !== CHANNEL_SNAPSHOT_CAPABILITY ||
    candidate.schemaVersion !== CHANNEL_SNAPSHOT_SCHEMA_VERSION ||
    candidate.projectionVersion !== CHANNEL_SNAPSHOT_PROJECTION_VERSION ||
    typeof candidate.channelId !== 'string' ||
    !Number.isSafeInteger(candidate.revision) ||
    (candidate.revision as number) < 1 ||
    !Number.isSafeInteger(candidate.projectedAt) ||
    (candidate.projectedAt as number) < 0 ||
    typeof candidate.identitiesStale !== 'boolean' ||
    !Number.isFinite(candidate.lagMs) ||
    (candidate.lagMs as number) < 0 ||
    !cursor ||
    !Number.isSafeInteger(cursor.createdAt) ||
    (cursor.createdAt as number) < 0 ||
    !Array.isArray(cursor.eventIds) ||
    cursor.eventIds.length === 0 ||
    cursor.eventIds.some((eventId) => typeof eventId !== 'string') ||
    !viewer ||
    typeof viewer.pubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(viewer.pubkey) ||
    viewer.membership !== 'active' ||
    !['owner', 'admin', 'member', 'unknown'].includes(String(viewer.role)) ||
    !['human', 'agent', 'infrastructure', 'unresolved'].includes(String(viewer.kind)) ||
    !['approved', 'not-approved', 'not-applicable'].includes(String(viewer.approval)) ||
    !review ||
    !['none', 'ready', 'landing', 'realigning', 'landed', 'failed'].includes(
      String(review.state),
    ) ||
    !Array.isArray(review.files) ||
    !Number.isSafeInteger(review.fileCount) ||
    !Array.isArray(review.approvedBy) ||
    (candidate.repository !== undefined && !repository) ||
    !integrity ||
    integrity.algorithm !== 'sha256' ||
    integrity.scope !== 'stored-channel-snapshot-v1' ||
    typeof integrity.digest !== 'string'
  ) {
    return { status: 'integrity-halt', diagnostic: 'Invalid channel snapshot envelope.' };
  }
  const boot = guardReadModelBoot(candidate.snapshot);
  if (boot.status !== 'ready' || !boot.snapshot.rooms[candidate.channelId as string]) {
    return {
      status: 'integrity-halt',
      diagnostic:
        boot.status === 'ready'
          ? 'Channel snapshot does not contain its requested Room.'
          : boot.diagnostic,
    };
  }
  const stored = {
    capability: candidate.capability,
    schemaVersion: candidate.schemaVersion,
    projectionVersion: candidate.projectionVersion,
    channelId: candidate.channelId,
    revision: candidate.revision,
    projectedAt: candidate.projectedAt,
    cursor: candidate.cursor,
    identitiesStale: candidate.identitiesStale,
    snapshot: boot.snapshot,
    ...(candidate.repository ? { repository: candidate.repository } : {}),
    review: candidate.review,
  } as StoredChannelSnapshotV1;
  if (
    !/^[0-9a-f]{64}$/.test(integrity.digest as string) ||
    channelSnapshotDigest(stored) !== integrity.digest
  ) {
    return { status: 'integrity-halt', diagnostic: 'Channel snapshot integrity check failed.' };
  }
  return { status: 'ready', view: candidate as ChannelSnapshotViewV1 };
}

export function snapshotViewerOverlay(
  payload: StoredChannelSnapshotV1,
  viewerPubkey: string,
): ChannelSnapshotViewerV1 {
  const member = payload.snapshot.rooms[payload.channelId]?.membership;
  const role =
    member?.status === 'known' ? (member.members[viewerPubkey]?.role ?? 'unknown') : 'unknown';
  const kind = payload.snapshot.identities[viewerPubkey]?.kind ?? 'unresolved';
  const approval = payload.review.target
    ? payload.review.approvedBy.includes(viewerPubkey as Pubkey)
      ? 'approved'
      : 'not-approved'
    : 'not-applicable';
  return { pubkey: viewerPubkey, membership: 'active', role, kind, approval };
}
