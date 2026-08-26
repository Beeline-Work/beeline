import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { normalizeAttachmentReference, type AttachmentReference } from '../attachment.js';
import {
  parseChangeReviewGenerationComplete,
  parseChangeReviewManifest,
} from '../change-review.js';
import { snapshotForPersistence } from './cache.js';
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
  readonly canonicalPubkeys?: Readonly<Record<string, string>>;
  readonly maxBytes?: number;
};

/** Build and byte-cap the canonical shared payload, reducing transcript rows first. */
export function buildStoredChannelSnapshotV1(
  input: BuildStoredChannelSnapshotInput,
): StoredChannelSnapshotV1 {
  const maxBytes = input.maxBytes ?? CHANNEL_SNAPSHOT_MAX_BYTES;
  const selectedReview = selectReviewSummary(input.snapshot, input.channelId);
  const review: ReviewSummary = {
    ...selectedReview,
    approvedBy: [
      ...new Set(
        selectedReview.approvedBy.map(
          (pubkey) => (input.canonicalPubkeys?.[pubkey] ?? pubkey) as Pubkey,
        ),
      ),
    ].sort(),
  };
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
      review,
    };
    const largestView: ChannelSnapshotViewV1 = {
      ...payload,
      lagMs: Number.MAX_SAFE_INTEGER,
      viewer: {
        pubkey: 'f'.repeat(64),
        membership: 'active',
        role: 'unknown',
        kind: 'infrastructure',
        approval: 'not-applicable',
      },
      integrity: {
        algorithm: 'sha256',
        scope: 'stored-channel-snapshot-v1',
        digest: 'f'.repeat(64),
      },
    };
    if (utf8ToBytes(`${JSON.stringify(largestView)}\n`).length <= maxBytes) return payload;
  }
  throw new Error(`channel snapshot structural state exceeds ${maxBytes} response bytes`);
}

export function channelSnapshotDigest(payload: StoredChannelSnapshotV1): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(payload))));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const HEX_ID = /^[0-9a-f]{64}$/;
const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'string';
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === 'boolean';
}

function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalNonnegativeInteger(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || nonnegativeInteger(value[key]);
}

function stringArray(value: unknown, pattern?: RegExp): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && (!pattern || pattern.test(item)))
  );
}

function validIdentity(value: unknown): boolean {
  const identity = record(value);
  if (
    !identity ||
    !exactKeys(identity, ['kind', 'pubkey', 'displayName', 'handle', 'avatar', 'revision']) ||
    !['human', 'agent', 'infrastructure'].includes(String(identity.kind)) ||
    typeof identity.pubkey !== 'string' ||
    !HEX_ID.test(identity.pubkey) ||
    typeof identity.revision !== 'string' ||
    !optionalString(identity, 'displayName') ||
    !optionalString(identity, 'handle') ||
    !optionalString(identity, 'avatar')
  ) {
    return false;
  }
  return (
    identity.kind !== 'infrastructure' ||
    (identity.displayName === undefined &&
      identity.handle === undefined &&
      identity.avatar === undefined)
  );
}

function validAttachment(value: unknown): boolean {
  const attachment = record(value);
  if (
    !attachment ||
    !exactKeys(attachment, [
      'url',
      'previewUrl',
      'name',
      'mimeType',
      'size',
      'sha256',
      'thumbnailUrl',
      'width',
      'height',
    ]) ||
    typeof attachment.url !== 'string' ||
    typeof attachment.name !== 'string' ||
    typeof attachment.mimeType !== 'string' ||
    !nonnegativeInteger(attachment.size) ||
    !optionalString(attachment, 'previewUrl') ||
    !optionalString(attachment, 'thumbnailUrl') ||
    !optionalNonnegativeInteger(attachment, 'width') ||
    !optionalNonnegativeInteger(attachment, 'height')
  ) {
    return false;
  }
  if (
    attachment.sha256 !== undefined &&
    (typeof attachment.sha256 !== 'string' || !HEX_ID.test(attachment.sha256))
  ) {
    return false;
  }
  const normalized = normalizeAttachmentReference(attachment as unknown as AttachmentReference);
  if (!normalized) return false;
  const normalizedRecord = normalized as unknown as Record<string, unknown>;
  return (
    Object.keys(normalizedRecord).length === Object.keys(attachment).length &&
    Object.entries(attachment).every(([key, value]) => normalizedRecord[key] === value)
  );
}

function validReply(value: unknown): boolean {
  const reply = record(value);
  return Boolean(
    reply &&
    exactKeys(reply, ['channelId', 'eventId', 'rootId']) &&
    typeof reply.channelId === 'string' &&
    CHANNEL_ID.test(reply.channelId) &&
    typeof reply.eventId === 'string' &&
    HEX_ID.test(reply.eventId) &&
    typeof reply.rootId === 'string' &&
    HEX_ID.test(reply.rootId),
  );
}

function validChangeReviewFile(value: unknown): boolean {
  const file = record(value);
  return Boolean(
    file &&
    exactKeys(file, [
      'path',
      'previousPath',
      'status',
      'linesAdded',
      'linesRemoved',
      'isBinary',
      'patchBytes',
      'renderUnavailableReason',
    ]) &&
    typeof file.path === 'string' &&
    optionalString(file, 'previousPath') &&
    ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'unmerged'].includes(
      String(file.status),
    ) &&
    optionalNonnegativeInteger(file, 'linesAdded') &&
    optionalNonnegativeInteger(file, 'linesRemoved') &&
    optionalBoolean(file, 'isBinary') &&
    optionalNonnegativeInteger(file, 'patchBytes') &&
    (file.renderUnavailableReason === undefined || file.renderUnavailableReason === 'too-large'),
  );
}

function validControlPayload(value: unknown): boolean {
  const payload = record(value);
  if (!payload || typeof payload.kind !== 'string') return false;
  switch (payload.kind) {
    case 'system':
      return (
        exactKeys(payload, ['kind', 'text', 'status']) &&
        typeof payload.text === 'string' &&
        optionalString(payload, 'status')
      );
    case 'corner-link':
      return (
        exactKeys(payload, ['kind', 'cornerId', 'status', 'text']) &&
        typeof payload.cornerId === 'string' &&
        CHANNEL_ID.test(payload.cornerId) &&
        optionalString(payload, 'status') &&
        optionalString(payload, 'text')
      );
    case 'merge':
      return (
        exactKeys(payload, [
          'kind',
          'action',
          'repository',
          'branch',
          'tip',
          'patchId',
          'previewUrl',
          'retry',
          'approvalId',
          'decision',
          'state',
          'rejectedTip',
          'text',
        ]) &&
        ['ready', 'not-ready', 'landed', 'failed', 'approval-ack'].includes(
          String(payload.action),
        ) &&
        [
          'repository',
          'branch',
          'tip',
          'patchId',
          'previewUrl',
          'approvalId',
          'rejectedTip',
          'text',
        ].every((key) => optionalString(payload, key)) &&
        (payload.retry === undefined ||
          ['auto', 'realigning', 'blocked'].includes(String(payload.retry))) &&
        (payload.decision === undefined ||
          ['accepted', 'rejected'].includes(String(payload.decision))) &&
        (payload.state === undefined ||
          ['landing', 'realigning', 'realigned', 'content-changed', 'tip-moved'].includes(
            String(payload.state),
          ))
      );
    case 'permission':
      return (
        exactKeys(payload, [
          'kind',
          'permissionId',
          'requestId',
          'agentPubkey',
          'status',
          'tool',
          'repository',
          'purpose',
          'subchannelId',
        ]) &&
        typeof payload.permissionId === 'string' &&
        typeof payload.requestId === 'string' &&
        typeof payload.agentPubkey === 'string' &&
        HEX_ID.test(payload.agentPubkey) &&
        ['pending', 'allowed', 'denied', 'expired', 'failed'].includes(String(payload.status)) &&
        optionalString(payload, 'tool') &&
        optionalString(payload, 'repository') &&
        (payload.purpose === undefined || payload.purpose === 'squire-spending') &&
        (payload.subchannelId === undefined ||
          (typeof payload.subchannelId === 'string' && CHANNEL_ID.test(payload.subchannelId)))
      );
    case 'target-branch-proposal':
      return (
        exactKeys(payload, [
          'kind',
          'proposalId',
          'from',
          'to',
          'repository',
          'agentPubkey',
          'requesterPubkey',
        ]) &&
        typeof payload.proposalId === 'string' &&
        typeof payload.from === 'string' &&
        typeof payload.to === 'string' &&
        optionalString(payload, 'repository') &&
        (payload.agentPubkey === undefined ||
          (typeof payload.agentPubkey === 'string' && HEX_ID.test(payload.agentPubkey))) &&
        (payload.requesterPubkey === undefined ||
          (typeof payload.requesterPubkey === 'string' && HEX_ID.test(payload.requesterPubkey)))
      );
    case 'room-metadata':
      return (
        exactKeys(payload, ['kind', 'name', 'about', 'archived']) &&
        optionalString(payload, 'name') &&
        optionalString(payload, 'about') &&
        optionalBoolean(payload, 'archived')
      );
    case 'merge-approval':
      return (
        exactKeys(payload, ['kind', 'repository', 'branch', 'tip', 'patchId']) &&
        typeof payload.repository === 'string' &&
        typeof payload.branch === 'string' &&
        optionalString(payload, 'tip') &&
        optionalString(payload, 'patchId')
      );
    case 'review-manifest':
      return (
        exactKeys(payload, ['kind', 'base', 'tip', 'files', 'chunk', 'chunks', 'transactional']) &&
        typeof payload.base === 'string' &&
        typeof payload.tip === 'string' &&
        Array.isArray(payload.files) &&
        payload.files.every(validChangeReviewFile) &&
        nonnegativeInteger(payload.chunk) &&
        nonnegativeInteger(payload.chunks) &&
        typeof payload.transactional === 'boolean'
      );
    case 'review-complete':
      return (
        exactKeys(payload, [
          'kind',
          'base',
          'tip',
          'patchId',
          'summary',
          'manifestChunks',
          'fileCount',
        ]) &&
        ['base', 'tip', 'patchId', 'summary'].every((key) => typeof payload[key] === 'string') &&
        nonnegativeInteger(payload.manifestChunks) &&
        nonnegativeInteger(payload.fileCount)
      );
    case 'repository':
      return validRepository(payload, true);
    case 'identity':
      return exactKeys(payload, ['kind', 'identity']) && validIdentity(payload.identity);
    case 'record':
      return (
        exactKeys(payload, ['kind', 'recordType', 'recordId']) &&
        typeof payload.recordType === 'string' &&
        optionalString(payload, 'recordId')
      );
    default:
      return false;
  }
}

function validActivityDetail(value: unknown): boolean {
  const detail = record(value);
  if (
    !detail ||
    !exactKeys(detail, [
      'kind',
      'title',
      'text',
      'status',
      'operation',
      'toolCallId',
      'rollup',
      'thoughtMs',
      'command',
      'input',
      'output',
      'files',
      'plan',
      'observed',
    ]) ||
    !['thinking', 'tool', 'output', 'summary'].includes(String(detail.kind)) ||
    typeof detail.title !== 'string' ||
    !['text', 'status', 'operation', 'toolCallId', 'command', 'input', 'output'].every((key) =>
      optionalString(detail, key),
    ) ||
    !optionalNonnegativeInteger(detail, 'thoughtMs')
  ) {
    return false;
  }
  const rollup = detail.rollup === undefined ? undefined : record(detail.rollup);
  if (
    detail.rollup !== undefined &&
    (!rollup || Object.values(rollup).some((item) => !Number.isFinite(item)))
  ) {
    return false;
  }
  if (
    detail.files !== undefined &&
    (!Array.isArray(detail.files) ||
      detail.files.some((item) => {
        const file = record(item);
        return (
          !file ||
          !exactKeys(file, ['path', 'status', 'diff']) ||
          typeof file.path !== 'string' ||
          !optionalString(file, 'status') ||
          !optionalString(file, 'diff')
        );
      }))
  ) {
    return false;
  }
  const plan = detail.plan === undefined ? undefined : record(detail.plan);
  if (
    detail.plan !== undefined &&
    (!plan ||
      !exactKeys(plan, ['objective', 'items']) ||
      !optionalString(plan, 'objective') ||
      !Array.isArray(plan.items) ||
      plan.items.some((item) => {
        const entry = record(item);
        return (
          !entry ||
          !exactKeys(entry, ['step', 'status']) ||
          typeof entry.step !== 'string' ||
          !['pending', 'in_progress', 'completed'].includes(String(entry.status))
        );
      }))
  ) {
    return false;
  }
  return (
    detail.observed === undefined ||
    (Array.isArray(detail.observed) &&
      detail.observed.every((item) => {
        const observed = record(item);
        return Boolean(
          observed &&
          exactKeys(observed, ['verb', 'target', 'result']) &&
          typeof observed.verb === 'string' &&
          optionalString(observed, 'target') &&
          optionalString(observed, 'result'),
        );
      }))
  );
}

function validReadEvent(
  value: unknown,
  expectedEventId: string,
  expectedChannelId: string,
): boolean {
  const event = record(value);
  if (
    !event ||
    event.eventId !== expectedEventId ||
    !HEX_ID.test(expectedEventId) ||
    typeof event.authorPubkey !== 'string' ||
    !HEX_ID.test(event.authorPubkey) ||
    !nonnegativeInteger(event.createdAt) ||
    !nonnegativeInteger(event.sourceKind) ||
    event.signature !== 'verified' ||
    event.scope !== 'channel' ||
    event.channelId !== expectedChannelId ||
    !optionalString(event, 'workspaceId')
  ) {
    return false;
  }
  const envelopeKeys = [
    'eventId',
    'authorPubkey',
    'createdAt',
    'sourceKind',
    'signature',
    'scope',
    'channelId',
    'workspaceId',
    'type',
  ];
  if (event.type === 'human-message' || event.type === 'agent-message') {
    return (
      exactKeys(event, [
        ...envelopeKeys,
        'body',
        'attachments',
        'mentionPubkeys',
        'reply',
        'clientNonce',
        ...(event.type === 'agent-message' ? ['requestId'] : []),
      ]) &&
      typeof event.body === 'string' &&
      Array.isArray(event.attachments) &&
      event.attachments.every(validAttachment) &&
      stringArray(event.mentionPubkeys, HEX_ID) &&
      (event.reply === undefined || validReply(event.reply)) &&
      optionalString(event, 'clientNonce') &&
      (event.type !== 'agent-message' || optionalString(event, 'requestId'))
    );
  }
  if (event.type === 'control') {
    return (
      exactKeys(event, [...envelopeKeys, 'visibility', 'payload']) &&
      ['hidden', 'system-line', 'card'].includes(String(event.visibility)) &&
      validControlPayload(event.payload)
    );
  }
  if (event.type === 'activity') {
    return (
      exactKeys(event, [
        ...envelopeKeys,
        'sessionId',
        'stepId',
        'status',
        'details',
        'detail',
        'durableFact',
      ]) &&
      typeof event.sessionId === 'string' &&
      typeof event.stepId === 'string' &&
      ['started', 'updated', 'completed', 'failed'].includes(String(event.status)) &&
      Array.isArray(event.details) &&
      event.details.every(validActivityDetail) &&
      validActivityDetail(event.detail) &&
      ['failure', 'merge', 'action'].includes(String(event.durableFact))
    );
  }
  return false;
}

function validCorner(value: unknown, expectedId: string): boolean {
  const corner = record(value);
  if (
    !corner ||
    corner.id !== expectedId ||
    !CHANNEL_ID.test(expectedId) ||
    typeof corner.parentRoomId !== 'string' ||
    !CHANNEL_ID.test(corner.parentRoomId) ||
    !optionalString(corner, 'name') ||
    !optionalString(corner, 'task') ||
    (corner.creatorPubkey !== undefined &&
      (typeof corner.creatorPubkey !== 'string' || !HEX_ID.test(corner.creatorPubkey))) ||
    !optionalNonnegativeInteger(corner, 'createdAt') ||
    !nonnegativeInteger(corner.stateAt)
  ) {
    return false;
  }
  const common = [
    'kind',
    'id',
    'parentRoomId',
    'state',
    'name',
    'task',
    'creatorPubkey',
    'createdAt',
    'stateAt',
  ];
  if (corner.kind === 'active') {
    return (
      exactKeys(corner, [...common, 'reason', 'humanMembers', 'leaseUntil']) &&
      ['open', 'working', 'waiting', 'idle'].includes(String(corner.state)) &&
      (corner.reason === undefined ||
        ['review', 'question', 'failure'].includes(String(corner.reason))) &&
      optionalNonnegativeInteger(corner, 'leaseUntil') &&
      Array.isArray(corner.humanMembers) &&
      corner.humanMembers.length > 0 &&
      corner.humanMembers.every((value) => {
        const member = record(value);
        return Boolean(
          member &&
          exactKeys(member, ['pubkey', 'role', 'identity']) &&
          typeof member.pubkey === 'string' &&
          HEX_ID.test(member.pubkey) &&
          ['owner', 'admin', 'member', 'unknown'].includes(String(member.role)) &&
          validIdentity(member.identity) &&
          record(member.identity)?.kind === 'human' &&
          record(member.identity)?.pubkey === member.pubkey,
        );
      })
    );
  }
  if (corner.kind === 'terminal') {
    return exactKeys(corner, common) && ['concluded', 'closed'].includes(String(corner.state));
  }
  return (
    corner.kind === 'integrity-halt' &&
    exactKeys(corner, [...common, 'reason', 'operatorMessage']) &&
    ['corner-without-human', 'invalid-corner-transition'].includes(String(corner.reason)) &&
    typeof corner.operatorMessage === 'string'
  );
}

function validRoom(value: unknown, expectedChannelId: string): boolean {
  const room = record(value);
  const metadata = record(room?.metadata);
  const membership = record(room?.membership);
  const coverage = record(room?.coverage);
  const journal = record(room?.eventJournal);
  const corners = record(room?.corners);
  if (
    !room ||
    !exactKeys(room, [
      'channelId',
      'metadata',
      'eventJournal',
      'membershipEvents',
      'lifecycleEvents',
      'membership',
      'corners',
      'coverage',
    ]) ||
    room.channelId !== expectedChannelId ||
    !CHANNEL_ID.test(expectedChannelId) ||
    !metadata ||
    !exactKeys(metadata, ['name', 'about', 'avatar', 'archived', 'deleted']) ||
    !optionalString(metadata, 'name') ||
    !optionalString(metadata, 'about') ||
    !optionalString(metadata, 'avatar') ||
    typeof metadata.archived !== 'boolean' ||
    typeof metadata.deleted !== 'boolean' ||
    !journal ||
    !Object.entries(journal).every(([eventId, event]) =>
      validReadEvent(event, eventId, expectedChannelId),
    ) ||
    !stringArray(room.membershipEvents, HEX_ID) ||
    !stringArray(room.lifecycleEvents, HEX_ID) ||
    !membership ||
    !corners ||
    !Object.entries(corners).every(([cornerId, corner]) => validCorner(corner, cornerId)) ||
    !coverage ||
    !exactKeys(coverage, ['oldest', 'newest', 'initialBackfillComplete', 'epoch']) ||
    !optionalNonnegativeInteger(coverage, 'oldest') ||
    !optionalNonnegativeInteger(coverage, 'newest') ||
    typeof coverage.initialBackfillComplete !== 'boolean' ||
    !nonnegativeInteger(coverage.epoch)
  ) {
    return false;
  }
  if (membership.status === 'unknown') {
    return (
      exactKeys(membership, ['status', 'reason']) &&
      ['not-loaded', 'unavailable', 'unverified'].includes(String(membership.reason))
    );
  }
  const members = record(membership.members);
  return Boolean(
    membership.status === 'known' &&
    exactKeys(membership, ['status', 'members', 'sourceEventId', 'observedAt']) &&
    members &&
    Object.entries(members).every(([pubkey, value]) => {
      const member = record(value);
      return Boolean(
        HEX_ID.test(pubkey) &&
        member &&
        exactKeys(member, ['pubkey', 'role']) &&
        member.pubkey === pubkey &&
        ['owner', 'admin', 'member', 'unknown'].includes(String(member.role)),
      );
    }) &&
    typeof membership.sourceEventId === 'string' &&
    HEX_ID.test(membership.sourceEventId) &&
    nonnegativeInteger(membership.observedAt),
  );
}

function validWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  const snapshot = record(value);
  const identities = record(snapshot?.identities);
  const rooms = record(snapshot?.rooms);
  return Boolean(
    snapshot &&
    exactKeys(snapshot, [
      'schemaVersion',
      'workspaceId',
      'revision',
      'identities',
      'rooms',
      'diagnostics',
    ]) &&
    snapshot.schemaVersion === 1 &&
    typeof snapshot.workspaceId === 'string' &&
    nonnegativeInteger(snapshot.revision) &&
    identities &&
    Object.entries(identities).every(
      ([pubkey, identity]) =>
        HEX_ID.test(pubkey) && validIdentity(identity) && record(identity)?.pubkey === pubkey,
    ) &&
    rooms &&
    Object.entries(rooms).every(([channelId, room]) => validRoom(room, channelId)) &&
    Array.isArray(snapshot.diagnostics) &&
    snapshot.diagnostics.every((value) => {
      const diagnostic = record(value);
      return Boolean(
        diagnostic &&
        exactKeys(diagnostic, ['code', 'eventId', 'channelId', 'entityId']) &&
        [
          'invalid-signature',
          'invalid-envelope',
          'foreign-channel',
          'unresolved-identity',
          'unauthorized',
          'unknown-schema',
          'malformed-schema',
          'orphan-reply',
          'cross-channel-reply',
          'invalid-corner-transition',
          'corner-without-human',
        ].includes(String(diagnostic.code)) &&
        (diagnostic.eventId === undefined ||
          (typeof diagnostic.eventId === 'string' && HEX_ID.test(diagnostic.eventId))) &&
        (diagnostic.channelId === undefined ||
          (typeof diagnostic.channelId === 'string' && CHANNEL_ID.test(diagnostic.channelId))) &&
        optionalString(diagnostic, 'entityId'),
      );
    }),
  );
}

function validRepository(value: unknown, controlPayload = false): boolean {
  const repository = record(value);
  return Boolean(
    repository &&
    exactKeys(repository, [
      ...(controlPayload ? ['kind'] : []),
      'key',
      'name',
      'remote',
      'targetBranch',
      'githubInstallationId',
      'githubEventsEnabled',
    ]) &&
    (!controlPayload || repository.kind === 'repository') &&
    typeof repository.key === 'string' &&
    typeof repository.name === 'string' &&
    typeof repository.remote === 'string' &&
    optionalString(repository, 'targetBranch') &&
    optionalNonnegativeInteger(repository, 'githubInstallationId') &&
    optionalBoolean(repository, 'githubEventsEnabled'),
  );
}

function validReview(value: unknown): boolean {
  const review = record(value);
  if (
    !review ||
    !exactKeys(review, [
      'state',
      'target',
      'files',
      'fileCount',
      'previewSummary',
      'approvedBy',
      'daemonAcknowledgement',
      'outcome',
    ]) ||
    !['none', 'ready', 'landing', 'realigning', 'landed', 'failed'].includes(
      String(review.state),
    ) ||
    !stringArray(review.files) ||
    !nonnegativeInteger(review.fileCount) ||
    review.fileCount !== review.files.length ||
    !optionalString(review, 'previewSummary') ||
    !stringArray(review.approvedBy, HEX_ID)
  ) {
    return false;
  }
  const target = review.target === undefined ? undefined : record(review.target);
  if (
    review.target !== undefined &&
    (!target ||
      !exactKeys(target, ['repository', 'branch', 'tip', 'patchId', 'previewUrl']) ||
      typeof target.repository !== 'string' ||
      typeof target.branch !== 'string' ||
      typeof target.tip !== 'string' ||
      !optionalString(target, 'patchId') ||
      !optionalString(target, 'previewUrl'))
  ) {
    return false;
  }
  if (
    target &&
    (!target.repository ||
      !target.branch ||
      !/^[0-9a-f]{40}$/.test(target.tip as string) ||
      (target.patchId !== undefined && !/^[0-9a-f]{40}$/.test(target.patchId as string)))
  ) {
    return false;
  }
  if (
    review.files.length > 0 &&
    (!target ||
      !parseChangeReviewManifest(
        JSON.stringify({
          version: 1,
          base: target.tip,
          tip: target.tip,
          files: review.files.map((path) => ({ path, status: 'modified' })),
        }),
      ))
  ) {
    return false;
  }
  if (
    review.previewSummary !== undefined &&
    (!target?.patchId ||
      !parseChangeReviewGenerationComplete(
        JSON.stringify({
          version: 1,
          base: target.tip,
          tip: target.tip,
          patchId: target.patchId,
          summary: review.previewSummary,
          manifestChunks: 1,
          fileCount: review.fileCount,
        }),
      ))
  ) {
    return false;
  }
  const acknowledgement =
    review.daemonAcknowledgement === undefined ? undefined : record(review.daemonAcknowledgement);
  if (
    review.daemonAcknowledgement !== undefined &&
    (!acknowledgement ||
      !exactKeys(acknowledgement, ['approvalId', 'decision', 'state']) ||
      typeof acknowledgement.approvalId !== 'string' ||
      !['accepted', 'rejected'].includes(String(acknowledgement.decision)) ||
      (acknowledgement.state !== undefined &&
        !['landing', 'realigning', 'realigned', 'content-changed', 'tip-moved'].includes(
          String(acknowledgement.state),
        )))
  ) {
    return false;
  }
  const outcome = review.outcome === undefined ? undefined : record(review.outcome);
  return (
    review.outcome === undefined ||
    Boolean(
      outcome &&
      exactKeys(outcome, ['kind', 'detail']) &&
      ['landed', 'failed'].includes(String(outcome.kind)) &&
      optionalString(outcome, 'detail'),
    )
  );
}

export type ChannelSnapshotGuardResult =
  | { readonly status: 'ready'; readonly view: ChannelSnapshotViewV1 }
  | { readonly status: 'integrity-halt'; readonly diagnostic: string };

export type StoredChannelSnapshotGuardResult =
  | { readonly status: 'ready'; readonly payload: StoredChannelSnapshotV1 }
  | { readonly status: 'integrity-halt'; readonly diagnostic: string };

function invalidStoredSnapshot(): StoredChannelSnapshotGuardResult {
  return { status: 'integrity-halt', diagnostic: 'Invalid stored channel snapshot.' };
}

export function guardStoredChannelSnapshotV1(
  value: unknown,
  expectedChannelId: string,
  expectedDigest: string,
): StoredChannelSnapshotGuardResult {
  try {
    const candidate = record(value);
    const cursor = record(candidate?.cursor);
    const review = record(candidate?.review);
    const repository =
      candidate?.repository === undefined ? undefined : record(candidate.repository);
    if (
      candidate?.capability !== CHANNEL_SNAPSHOT_CAPABILITY ||
      candidate.schemaVersion !== CHANNEL_SNAPSHOT_SCHEMA_VERSION ||
      candidate.projectionVersion !== CHANNEL_SNAPSHOT_PROJECTION_VERSION ||
      candidate.channelId !== expectedChannelId ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.revision as number) < 1 ||
      !Number.isSafeInteger(candidate.projectedAt) ||
      (candidate.projectedAt as number) < 0 ||
      typeof candidate.identitiesStale !== 'boolean' ||
      !cursor ||
      !Number.isSafeInteger(cursor.createdAt) ||
      (cursor.createdAt as number) < 0 ||
      !Array.isArray(cursor.eventIds) ||
      cursor.eventIds.length === 0 ||
      !exactKeys(cursor, ['createdAt', 'eventIds']) ||
      !stringArray(cursor.eventIds, HEX_ID) ||
      new Set(cursor.eventIds).size !== cursor.eventIds.length ||
      !validReview(review) ||
      (candidate.repository !== undefined && (!repository || !validRepository(repository))) ||
      !validWorkspaceSnapshot(candidate.snapshot) ||
      !/^[0-9a-f]{64}$/.test(expectedDigest)
    ) {
      return invalidStoredSnapshot();
    }
    const snapshot = candidate.snapshot as WorkspaceSnapshot;
    const room = record(snapshot.rooms[expectedChannelId]);
    const membership = record(room?.membership);
    if (
      !room ||
      !membership ||
      (membership.status === 'known' && !record(membership.members)) ||
      (membership.status !== 'known' && membership.status !== 'unknown')
    ) {
      return invalidStoredSnapshot();
    }
    const payload = {
      capability: candidate.capability,
      schemaVersion: candidate.schemaVersion,
      projectionVersion: candidate.projectionVersion,
      channelId: candidate.channelId,
      revision: candidate.revision,
      projectedAt: candidate.projectedAt,
      cursor: candidate.cursor,
      identitiesStale: candidate.identitiesStale,
      snapshot,
      ...(candidate.repository !== undefined ? { repository: candidate.repository } : {}),
      review: candidate.review,
    } as StoredChannelSnapshotV1;
    return channelSnapshotDigest(payload) === expectedDigest
      ? { status: 'ready', payload }
      : invalidStoredSnapshot();
  } catch {
    return invalidStoredSnapshot();
  }
}

/** Client/server golden contract guard. Incomplete or corrupt state never becomes an empty Room. */
export function guardChannelSnapshotViewV1(value: unknown): ChannelSnapshotGuardResult {
  const candidate = record(value);
  const viewer = record(candidate?.viewer);
  const integrity = record(candidate?.integrity);
  if (
    typeof candidate?.channelId !== 'string' ||
    !Number.isFinite(candidate.lagMs) ||
    (candidate.lagMs as number) < 0 ||
    !viewer ||
    typeof viewer.pubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(viewer.pubkey) ||
    viewer.membership !== 'active' ||
    !['owner', 'admin', 'member', 'unknown'].includes(String(viewer.role)) ||
    !['human', 'agent', 'infrastructure', 'unresolved'].includes(String(viewer.kind)) ||
    !['approved', 'not-approved', 'not-applicable'].includes(String(viewer.approval)) ||
    !integrity ||
    integrity.algorithm !== 'sha256' ||
    integrity.scope !== 'stored-channel-snapshot-v1' ||
    typeof integrity.digest !== 'string'
  ) {
    return { status: 'integrity-halt', diagnostic: 'Invalid channel snapshot envelope.' };
  }
  const stored = guardStoredChannelSnapshotV1(
    candidate,
    candidate.channelId,
    integrity.digest as string,
  );
  if (stored.status !== 'ready') {
    return { status: 'integrity-halt', diagnostic: 'Channel snapshot integrity check failed.' };
  }
  return {
    status: 'ready',
    view: {
      ...stored.payload,
      lagMs: candidate.lagMs as number,
      viewer: candidate.viewer as ChannelSnapshotViewerV1,
      integrity: candidate.integrity as ChannelSnapshotViewV1['integrity'],
    },
  };
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
