import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { normalizeAttachmentReference, type AttachmentReference } from '../attachment.js';
import type { CornerMachineState } from '../corner-state.js';
import {
  DELEGATION_RECEIPT_MARKER,
  DELEGATION_TURN_MARKER,
  parseDelegationReceipt,
  parseDelegationTurn,
} from '../delegation-turn.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CORNER_STATE,
  KIND_CREATE_GROUP,
  KIND_DELETE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_AGENT_PRESENCE,
  TAG_CORNER_STATE,
  TAG_PARENT,
} from '../kinds.js';
import {
  PERMISSION_DECISION_MARKER,
  PERMISSION_EXECUTION_MARKER,
  PERMISSION_REQUEST_MARKER,
  PERMISSION_REVOCATION_MARKER,
  parsePermissionDecision,
  parsePermissionExecution,
  parsePermissionRequest,
  parsePermissionRevocation,
} from '../permission-request.js';
import type {
  Activity,
  ActivityDetail,
  AgentMessage,
  ChannelId,
  ChannelEnvelope,
  ChannelScope,
  Control,
  ControlPayload,
  Command,
  EventId,
  HumanMessage,
  IdentityRecord,
  KnownMessageReference,
  Lifecycle,
  MemberRole,
  Membership,
  ParseAuthority,
  Pubkey,
  ReadEvent,
  Receipt,
  SessionUpdate,
  SessionUpdatePayload,
  Unknown,
  VerifiedEnvelope,
  WorkspaceScope,
  WorkspaceEnvelope,
} from './types.js';

type JsonRecord = Record<string, unknown>;

const CONTROL_MARKERS = new Set([
  'body-control',
  'steer-queued',
  'slash-command-notice',
  'buzz-merge-approval',
  'buzz-merge-approval-ack',
  'merge-ready',
  'merge-not-ready',
  'merge-summary',
  'land-summary',
  'landed',
  'buzz-target-branch-proposal',
  'buzz-write-permission-request',
  'buzz-write-permission-response',
  'buzz-agent-cancel',
  'buzz-corner-close',
  'change-review-manifest',
  'change-review-file',
  // Harness retry/backoff narration is machine state, never an agent's
  // conversational answer. The explicit wire marker is the schema boundary;
  // content wording is deliberately not inspected.
  'agent-activity/narration',
]);

const FACTORY_MARKERS = new Set([
  PERMISSION_REQUEST_MARKER,
  PERMISSION_DECISION_MARKER,
  PERMISSION_REVOCATION_MARKER,
  PERMISSION_EXECUTION_MARKER,
  DELEGATION_TURN_MARKER,
  DELEGATION_RECEIPT_MARKER,
]);

const SESSION_MARKERS = new Set([
  TAG_AGENT_PRESENCE,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  'agent-turn',
  'corner-session',
]);

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function integer(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function tags(event: NostrEvent, name: string): readonly string[][] {
  return event.tags.filter((tag) => tag[0] === name && typeof tag[1] === 'string');
}

function tag(event: NostrEvent, name: string): string | undefined {
  return tags(event, name)[0]?.[1];
}

function markers(event: NostrEvent): readonly string[] {
  return tags(event, 't').flatMap((candidate) => (candidate[1] ? [candidate[1]] : []));
}

function unknown(event: unknown, reason: Unknown['reason']): Unknown {
  const candidate = record(event);
  return {
    type: 'unknown',
    reason,
    ...(typeof candidate?.id === 'string' ? { eventId: candidate.id as EventId } : {}),
    ...(typeof candidate?.pubkey === 'string' ? { authorPubkey: candidate.pubkey as Pubkey } : {}),
    ...(typeof candidate?.created_at === 'number' ? { createdAt: candidate.created_at } : {}),
    ...(typeof candidate?.kind === 'number' ? { sourceKind: candidate.kind } : {}),
  };
}

function isUnknown(value: unknown): value is Unknown {
  return record(value)?.type === 'unknown';
}

function channelScope(
  event: NostrEvent,
  authority: ParseAuthority,
  allowD = false,
): ChannelScope | Unknown {
  const associations = tags(event, 'h').map((candidate) => candidate[1]!);
  const d = allowD ? tag(event, 'd') : undefined;
  const channelId = associations.length === 1 ? associations[0] : undefined;
  if (!channelId && !d) return unknown(event, 'invalid-envelope');
  const resolved = channelId ?? d;
  if (!resolved) return unknown(event, 'invalid-envelope');
  if (authority.expectedChannelId && resolved !== authority.expectedChannelId) {
    return unknown(event, 'foreign-channel');
  }
  if (authority.allowedChannelIds && !authority.allowedChannelIds.includes(resolved)) {
    return unknown(event, 'foreign-channel');
  }
  return {
    scope: 'channel',
    channelId: resolved as ChannelId,
    workspaceId: authority.workspaceId,
  };
}

function workspaceScope(workspaceId: string | undefined): WorkspaceScope | undefined {
  return workspaceId ? { scope: 'workspace', workspaceId } : undefined;
}

function envelope(event: NostrEvent, scope: ChannelScope): ChannelEnvelope;
function envelope(event: NostrEvent, scope: WorkspaceScope): WorkspaceEnvelope;
function envelope(event: NostrEvent, scope: ChannelScope | WorkspaceScope): VerifiedEnvelope {
  return {
    eventId: event.id as EventId,
    authorPubkey: event.pubkey as Pubkey,
    createdAt: event.created_at,
    sourceKind: event.kind,
    signature: 'verified',
    ...scope,
  };
}

function identity(authority: ParseAuthority, pubkey: string): IdentityRecord | undefined {
  return authority.identities[pubkey];
}

function isAdmin(authority: ParseAuthority, channelId: string, pubkey: string): boolean {
  return authority.channelAdmins?.[channelId]?.includes(pubkey) ?? false;
}

function isProjectionAuthority(authority: ParseAuthority, pubkey: string): boolean {
  return authority.trustedProjectionPubkeys?.includes(pubkey) ?? false;
}

function role(value: string | undefined): MemberRole {
  return value === 'owner' || value === 'admin' || value === 'member' ? value : 'unknown';
}

export type RelayAuthorityFacts = {
  readonly workspaceIdsByChannel: Readonly<Record<string, string>>;
  readonly channelCreators: Readonly<Record<string, string>>;
  readonly channelAdmins: Readonly<Record<string, readonly string[]>>;
  readonly memberPubkeys: readonly string[];
  readonly trustedProjectionPubkeys: readonly string[];
  readonly cornerIdsByParent: Readonly<Record<string, readonly string[]>>;
};

/**
 * Derive the parser's authority inputs from a relay page already fetched for
 * the snapshot. This is intentionally part of the sole wire-interpretation
 * boundary: callers can batch structural/projection reads without reaching
 * back into raw tags (or repeating one authority query per channel).
 */
export function deriveRelayAuthorityFacts(events: readonly NostrEvent[]): RelayAuthorityFacts {
  const workspaceIdsByChannel: Record<string, string> = {};
  const channelCreators: Record<string, string> = {};
  const channelCreatorAt: Record<string, number> = {};
  const channelAdmins = new Map<string, Set<string>>();
  const memberPubkeys = new Set<string>();
  const trustedProjectionPubkeys = new Set<string>();
  const cornerIdsByParent = new Map<string, Set<string>>();

  const rememberMember = (channelId: string, pubkey: string, memberRole: MemberRole) => {
    memberPubkeys.add(pubkey);
    if (memberRole === 'owner' || memberRole === 'admin') {
      const admins = channelAdmins.get(channelId) ?? new Set<string>();
      admins.add(pubkey);
      channelAdmins.set(channelId, admins);
    }
  };
  const rememberCorner = (parentId: string, cornerId: string) => {
    if (parentId === cornerId) return;
    const corners = cornerIdsByParent.get(parentId) ?? new Set<string>();
    corners.add(cornerId);
    cornerIdsByParent.set(parentId, corners);
  };

  for (const event of events) {
    try {
      if (!verifyEvent(event) || !Array.isArray(event.tags)) continue;
      const h = tag(event, 'h');
      const d = tag(event, 'd');
      if (event.kind === KIND_CREATE_GROUP) {
        const channelId = h ?? d;
        if (!channelId) continue;
        const priorAt = channelCreatorAt[channelId];
        if (
          priorAt === undefined ||
          event.created_at < priorAt ||
          (event.created_at === priorAt && event.pubkey < (channelCreators[channelId] ?? ''))
        ) {
          channelCreators[channelId] = event.pubkey;
          channelCreatorAt[channelId] = event.created_at;
        }
        const admins = channelAdmins.get(channelId) ?? new Set<string>();
        admins.add(event.pubkey);
        channelAdmins.set(channelId, admins);
        const communityId = tag(event, 'community');
        if (communityId) workspaceIdsByChannel[channelId] = communityId;
        const parentId = tag(event, TAG_PARENT);
        if (parentId) rememberCorner(parentId, channelId);
        for (const candidate of tags(event, 'p')) {
          const pubkey = candidate[1];
          if (pubkey) rememberMember(channelId, pubkey, role(candidate[2]));
        }
        continue;
      }
      if (event.kind === KIND_CHANNEL_MEMBERS || event.kind === KIND_CHANNEL_ADMINS) {
        const channelId = d ?? h;
        if (!channelId) continue;
        trustedProjectionPubkeys.add(event.pubkey);
        const defaultRole: MemberRole = event.kind === KIND_CHANNEL_ADMINS ? 'admin' : 'member';
        for (const candidate of tags(event, 'p')) {
          const pubkey = candidate[1];
          if (!pubkey) continue;
          const parsedRole = role(candidate[2]);
          rememberMember(channelId, pubkey, parsedRole === 'unknown' ? defaultRole : parsedRole);
        }
        continue;
      }
      if (event.kind === KIND_CORNER_STATE) {
        const cornerKey = d;
        const cornerId = cornerKey?.startsWith(`${TAG_CORNER_STATE}:`)
          ? cornerKey.slice(TAG_CORNER_STATE.length + 1)
          : undefined;
        if (h && cornerId) rememberCorner(h, cornerId);
        continue;
      }
      if (event.kind === KIND_STREAM_MESSAGE) {
        const cornerId = tag(event, 'subchannel');
        if (h && cornerId) rememberCorner(h, cornerId);
      }
    } catch {
      // One malformed envelope contributes no authority. The normal parser
      // will quarantine it without discarding the valid page around it.
    }
  }

  return {
    workspaceIdsByChannel,
    channelCreators,
    channelAdmins: Object.fromEntries(
      [...channelAdmins].map(([channelId, pubkeys]) => [channelId, [...pubkeys]]),
    ),
    memberPubkeys: [...memberPubkeys],
    trustedProjectionPubkeys: [...trustedProjectionPubkeys],
    cornerIdsByParent: Object.fromEntries(
      [...cornerIdsByParent].map(([parentId, cornerIds]) => [parentId, [...cornerIds]]),
    ),
  };
}

function attachments(event: NostrEvent): readonly AttachmentReference[] {
  if (!markers(event).includes('buzz-attachment')) return [];
  const names = new Map(
    tags(event, 'attachment').flatMap((candidate) =>
      candidate[1] && candidate[2] ? [[candidate[1], candidate[2]] as const] : [],
    ),
  );
  return tags(event, 'imeta').flatMap((candidate) => {
    const fields = new Map<string, string>();
    for (const item of candidate.slice(1)) {
      const split = item.indexOf(' ');
      if (split > 0) fields.set(item.slice(0, split), item.slice(split + 1));
    }
    const url = fields.get('url') ?? '';
    const dim = fields.get('dim')?.match(/^(\d+)x(\d+)$/);
    const normalized = normalizeAttachmentReference({
      url,
      name: names.get(url) ?? '',
      mimeType: fields.get('m') ?? '',
      size: Number(fields.get('size')),
      ...(fields.get('preview') ? { previewUrl: fields.get('preview') } : {}),
      ...(fields.get('x') ? { sha256: fields.get('x') } : {}),
      ...(fields.get('thumb') ? { thumbnailUrl: fields.get('thumb') } : {}),
      ...(dim ? { width: Number(dim[1]), height: Number(dim[2]) } : {}),
    });
    return normalized ? [normalized] : [];
  });
}

function mentionPubkeys(event: NostrEvent): readonly Pubkey[] {
  return [
    ...new Set(tags(event, 'p').flatMap((candidate) => (candidate[1] ? [candidate[1]] : []))),
  ].map((value) => value as Pubkey);
}

function replyReference(
  event: NostrEvent,
  channelId: ChannelId,
  authority: ParseAuthority,
): KnownMessageReference | Unknown | undefined {
  const replyId = event.tags.find(
    (candidate) => candidate[0] === 'e' && candidate[1] && candidate[3] === 'reply',
  )?.[1];
  if (!replyId) return undefined;
  const parent = authority.knownMessages?.[replyId];
  if (!parent) return unknown(event, 'orphan-reply');
  if (parent.channelId !== channelId) return unknown(event, 'cross-channel-reply');
  return {
    channelId,
    eventId: replyId as EventId,
    rootId: (parent.rootId ?? replyId) as EventId,
  } as KnownMessageReference;
}

function parseJson(content: string): JsonRecord | undefined {
  try {
    return record(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function activityDetail(update: JsonRecord): ActivityDetail | undefined {
  const updateType = text(update.sessionUpdate);
  if (!updateType) return undefined;
  const content = record(update.content);
  const message = record(update.message);
  const rollupRecord = record(update.rollup);
  const rollup = rollupRecord
    ? Object.fromEntries(
        Object.entries(rollupRecord).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
        ),
      )
    : undefined;
  const files = Array.isArray(update.files)
    ? update.files.flatMap((item) => {
        const candidate = record(item);
        const path = text(candidate?.path);
        return path
          ? [
              {
                path,
                ...(text(candidate?.status) ? { status: text(candidate?.status) } : {}),
                ...(text(candidate?.diff) ? { diff: text(candidate?.diff) } : {}),
              },
            ]
          : [];
      })
    : undefined;
  const planRecord = record(update.plan);
  const planItems = Array.isArray(planRecord?.items)
    ? planRecord.items.flatMap((item) => {
        const candidate = record(item);
        const step = text(candidate?.step);
        const status = candidate?.status;
        return step && (status === 'pending' || status === 'in_progress' || status === 'completed')
          ? [
              {
                step,
                status: status as 'pending' | 'in_progress' | 'completed',
              },
            ]
          : [];
      })
    : [];
  const plan =
    planRecord && (text(planRecord.objective) || planItems.length)
      ? {
          ...(text(planRecord.objective) ? { objective: text(planRecord.objective) } : {}),
          items: planItems,
        }
      : undefined;
  const observed = Array.isArray(update.observed)
    ? update.observed.flatMap((item) => {
        const candidate = record(item);
        const verb = text(candidate?.verb);
        return verb
          ? [
              {
                verb,
                ...(text(candidate?.target) ? { target: text(candidate?.target) } : {}),
                ...(text(candidate?.result) ? { result: text(candidate?.result) } : {}),
              },
            ]
          : [];
      })
    : undefined;
  const detailKind: ActivityDetail['kind'] = updateType.includes('thought')
    ? 'thinking'
    : updateType.includes('tool')
      ? 'tool'
      : updateType.includes('summary')
        ? 'summary'
        : 'output';
  return {
    kind: detailKind,
    title:
      text(update.title) ??
      (updateType.includes('tool')
        ? 'Tool'
        : updateType.includes('thought')
          ? 'Thinking'
          : 'Update'),
    ...((text(update.text) ?? text(content?.text) ?? text(message?.text))
      ? { text: text(update.text) ?? text(content?.text) ?? text(message?.text) }
      : {}),
    ...(text(update.status) ? { status: text(update.status) } : {}),
    operation: updateType,
    ...(text(update.toolCallId) ? { toolCallId: text(update.toolCallId) } : {}),
    ...(rollup && Object.keys(rollup).length ? { rollup } : {}),
    ...(typeof update.thoughtMs === 'number' && update.thoughtMs > 0
      ? { thoughtMs: update.thoughtMs }
      : {}),
    ...(text(update.command) ? { command: text(update.command) } : {}),
    ...(text(update.input) ? { input: text(update.input) } : {}),
    ...(text(update.output) ? { output: text(update.output) } : {}),
    ...(files?.length ? { files } : {}),
    ...(plan ? { plan } : {}),
    ...(observed?.length ? { observed } : {}),
  };
}

function parseActivity(
  event: NostrEvent,
  scope: ChannelScope,
  parsed: JsonRecord,
): Activity | SessionUpdate | Unknown {
  const sessionId = text(parsed.sessionId);
  const update = record(parsed.update);
  if (!sessionId || !update) return unknown(event, 'malformed-schema');
  const batchUpdates =
    text(update.sessionUpdate) === 'activity_batch' && Array.isArray(update.updates)
      ? update.updates.flatMap((candidate) => {
          const parsedUpdate = record(candidate);
          return parsedUpdate ? [parsedUpdate] : [];
        })
      : [update];
  const details = batchUpdates.flatMap((candidate) => {
    const detail = activityDetail(candidate);
    return detail ? [detail] : [];
  });
  const detail = details[0];
  if (!detail) {
    return {
      ...envelope(event, scope),
      type: 'session-update',
      sessionId,
      update: { kind: 'opaque', updateType: text(update.sessionUpdate) ?? 'metadata' },
    };
  }
  const rawStatuses = batchUpdates.map((candidate) => text(candidate.status)).filter(Boolean);
  const rawStatus = rawStatuses.includes('failed')
    ? 'failed'
    : rawStatuses.length > 0 &&
        rawStatuses.every((candidate) => candidate === 'completed' || candidate === 'complete')
      ? 'completed'
      : text(update.status);
  const status =
    rawStatus === 'failed'
      ? 'failed'
      : rawStatus === 'completed' || rawStatus === 'complete'
        ? 'completed'
        : rawStatus === 'started'
          ? 'started'
          : 'updated';
  return {
    ...envelope(event, scope),
    type: 'activity',
    sessionId,
    stepId: detail.toolCallId ?? `${event.id}:${detail.operation ?? 'update'}`,
    status,
    details,
    detail,
    ...(status === 'failed' || tag(event, 'status') === 'failed'
      ? { durableFact: 'failure' as const }
      : tag(event, 'delivery-stage') === 'landed' || markers(event).includes('landed')
        ? { durableFact: 'merge' as const }
        : markers(event).some((marker) =>
              ['corner-open', 'room-target-branch-realign', 'branch-switch'].includes(marker),
            )
          ? { durableFact: 'action' as const }
          : {}),
  };
}

function parseSessionMarker(
  event: NostrEvent,
  scope: ChannelScope,
  marker: string,
): SessionUpdate | Unknown {
  const agentPubkey = (tag(event, 'agent') ?? event.pubkey) as Pubkey;
  if (agentPubkey !== event.pubkey) return unknown(event, 'unauthorized');
  if (marker === TAG_AGENT_PRESENCE) {
    const status = tag(event, 'status');
    if (status !== 'online' && status !== 'offline') return unknown(event, 'malformed-schema');
    return {
      ...envelope(event, scope),
      type: 'session-update',
      sessionId: tag(event, 'session') ?? scope.channelId,
      update: {
        kind: 'presence',
        agentPubkey,
        status,
        ...(tag(event, 'generation') ? { generationId: tag(event, 'generation') } : {}),
      },
    };
  }
  if (marker === TAG_AGENT_DRAFT) {
    const requestId = tag(event, 'request');
    if (!requestId) return unknown(event, 'malformed-schema');
    return {
      ...envelope(event, scope),
      type: 'session-update',
      sessionId: tag(event, 'session') ?? scope.channelId,
      update: {
        kind: 'draft',
        agentPubkey,
        requestId,
        ...(event.content.trim() ? { text: event.content } : {}),
        closed: tag(event, 'status') === 'closed',
      },
    };
  }
  if (marker === TAG_AGENT_THOUGHT) {
    return {
      ...envelope(event, scope),
      type: 'session-update',
      sessionId: tag(event, 'session') ?? scope.channelId,
      update: {
        kind: 'thought',
        agentPubkey,
        ...(event.content.trim() ? { text: event.content } : {}),
        closed: tag(event, 'status') === 'closed',
      },
    };
  }
  if (marker === 'agent-turn') {
    const requestId = tag(event, 'request');
    const status = tag(event, 'status');
    if (!requestId || (status !== 'working' && status !== 'complete' && status !== 'failed')) {
      return unknown(event, 'malformed-schema');
    }
    return {
      ...envelope(event, scope),
      type: 'session-update',
      sessionId: tag(event, 'session') ?? scope.channelId,
      update: {
        kind: 'turn',
        agentPubkey,
        requestId,
        status,
        ...(tag(event, 'generation') ? { generationId: tag(event, 'generation') } : {}),
      },
    };
  }
  const sessionId = tag(event, 'session');
  const state = tag(event, 'status');
  const sequence = integer(tag(event, 'sequence'));
  if (
    !sessionId ||
    (state !== 'live' && state !== 'suspended' && state !== 'waiting-for-slot') ||
    sequence === undefined
  ) {
    return unknown(event, 'malformed-schema');
  }
  return {
    ...envelope(event, scope),
    type: 'session-update',
    sessionId,
    update: { kind: 'corner-session', agentPubkey, sessionId, state, sequence },
  };
}

function controlPayload(
  event: NostrEvent,
  markerSet: ReadonlySet<string>,
): {
  visibility: Control['visibility'];
  payload: ControlPayload;
} {
  if (markerSet.has('buzz-write-permission-request')) {
    const status = tag(event, 'status');
    return {
      visibility: 'card',
      payload: {
        kind: 'permission',
        permissionId: tag(event, 'permission') ?? event.id,
        requestId: tag(event, 'request') ?? event.id,
        agentPubkey: (tag(event, 'agent') ?? event.pubkey) as Pubkey,
        status:
          status === 'allowed' || status === 'denied' || status === 'expired' || status === 'failed'
            ? status
            : 'pending',
        ...(tag(event, 'tool') ? { tool: tag(event, 'tool') } : {}),
        ...(tag(event, 'repo') ? { repository: tag(event, 'repo') } : {}),
        ...(tag(event, 'purpose') === 'squire-spending'
          ? { purpose: 'squire-spending' as const }
          : {}),
        ...(tag(event, 'subchannel')
          ? { subchannelId: tag(event, 'subchannel') as ChannelId }
          : {}),
      },
    };
  }
  if (markerSet.has('buzz-target-branch-proposal')) {
    return {
      visibility: tag(event, 'from') && tag(event, 'to') ? 'card' : 'hidden',
      payload: {
        kind: 'target-branch-proposal',
        proposalId: event.id,
        from: tag(event, 'from') ?? '',
        to: tag(event, 'to') ?? '',
        ...(tag(event, 'repo') ? { repository: tag(event, 'repo') } : {}),
        ...(tag(event, 'agent') ? { agentPubkey: tag(event, 'agent') as Pubkey } : {}),
        ...(tag(event, 'requester') ? { requesterPubkey: tag(event, 'requester') as Pubkey } : {}),
      },
    };
  }
  if (
    markerSet.has('merge-ready') ||
    markerSet.has('merge-not-ready') ||
    markerSet.has('landed') ||
    markerSet.has('buzz-merge-approval-ack') ||
    tag(event, 'delivery') === 'landed' ||
    (tag(event, 'status') === 'failed' && !tag(event, 'subchannel'))
  ) {
    const action = markerSet.has('merge-ready')
      ? 'ready'
      : markerSet.has('merge-not-ready')
        ? 'not-ready'
        : markerSet.has('buzz-merge-approval-ack')
          ? 'approval-ack'
          : tag(event, 'status') === 'failed'
            ? 'failed'
            : 'landed';
    return {
      visibility: action === 'ready' || action === 'not-ready' ? 'card' : 'system-line',
      payload: {
        kind: 'merge',
        action,
        ...(tag(event, 'repo') ? { repository: tag(event, 'repo') } : {}),
        ...(tag(event, 'branch') ? { branch: tag(event, 'branch') } : {}),
        ...(tag(event, 'tip') ? { tip: tag(event, 'tip') } : {}),
        ...(tag(event, 'patch-id') ? { patchId: tag(event, 'patch-id') } : {}),
        ...(tag(event, 'preview') && /^https:\/\/[^\s]+$/i.test(tag(event, 'preview')!)
          ? { previewUrl: tag(event, 'preview') }
          : {}),
        ...(['auto', 'realigning', 'blocked'].includes(tag(event, 'retry') ?? '')
          ? { retry: tag(event, 'retry') as 'auto' | 'realigning' | 'blocked' }
          : {}),
        ...(tag(event, 'approval') ? { approvalId: tag(event, 'approval') } : {}),
        ...(['accepted', 'rejected'].includes(tag(event, 'decision') ?? '')
          ? { decision: tag(event, 'decision') as 'accepted' | 'rejected' }
          : {}),
        ...(['landing', 'realigning', 'realigned', 'content-changed', 'tip-moved'].includes(
          tag(event, 'state') ?? '',
        )
          ? {
              state: tag(event, 'state') as
                'landing' | 'realigning' | 'realigned' | 'content-changed' | 'tip-moved',
            }
          : {}),
        ...(tag(event, 'rejected-tip') ? { rejectedTip: tag(event, 'rejected-tip') } : {}),
        ...(event.content.trim() ? { text: event.content } : {}),
      },
    };
  }
  const cornerId = tag(event, 'subchannel');
  if (cornerId) {
    return {
      visibility: 'card',
      payload: {
        kind: 'corner-link',
        cornerId: cornerId as ChannelId,
        ...(tag(event, 'status') ? { status: tag(event, 'status') } : {}),
        ...(event.content.trim() ? { text: event.content } : {}),
      },
    };
  }
  if (markerSet.has('steer-queued') || markerSet.has('slash-command-notice')) {
    return {
      visibility: 'system-line',
      payload: {
        kind: 'system',
        text: event.content,
        ...(tag(event, 'status') ? { status: tag(event, 'status') } : {}),
      },
    };
  }
  return {
    visibility: 'hidden',
    payload: { kind: 'record', recordType: [...markerSet].sort()[0] ?? 'body-control' },
  };
}

function knownPermissionRequest(
  authority: ParseAuthority,
  permissionId: string | undefined,
  requestEventId?: string,
) {
  if (requestEventId) return authority.knownPermissionRequests?.[requestEventId];
  if (!permissionId) return undefined;
  return Object.values(authority.knownPermissionRequests ?? {}).find(
    (request) => request.value.permissionId === permissionId,
  );
}

function parseFactoryMessage(
  event: NostrEvent,
  scope: ChannelScope,
  author: IdentityRecord | undefined,
  markerSet: ReadonlySet<string>,
  authority: ParseAuthority,
): Command | Receipt | Unknown | undefined {
  const factoryMarkers = [...markerSet].filter((candidate) => FACTORY_MARKERS.has(candidate));
  if (factoryMarkers.length === 0) return undefined;
  if (factoryMarkers.length !== 1 || !author) return unknown(event, 'malformed-schema');
  const factoryMarker = factoryMarkers[0];
  if (factoryMarker === PERMISSION_REQUEST_MARKER) {
    const request = parsePermissionRequest(event);
    if (!request) return unknown(event, 'malformed-schema');
    if (author.kind !== 'agent') return unknown(event, 'unauthorized');
    return {
      ...envelope(event, scope),
      type: 'command',
      command: { kind: 'permission.request', request: request.value },
    };
  }
  if (factoryMarker === PERMISSION_DECISION_MARKER) {
    const replyTags = tags(event, 'e');
    const requestEventId =
      replyTags.length === 1 && replyTags[0]?.[3] === 'reply' ? replyTags[0]?.[1] : undefined;
    const request = knownPermissionRequest(authority, tag(event, 'permission'), requestEventId);
    const decision = request ? parsePermissionDecision(event, request) : undefined;
    if (!decision) return unknown(event, 'malformed-schema');
    if (author.kind !== 'human' || !isAdmin(authority, scope.channelId, event.pubkey)) {
      return unknown(event, 'unauthorized');
    }
    return {
      ...envelope(event, scope),
      type: 'command',
      command: { kind: 'permission.decision', decision: decision.value },
    };
  }
  if (factoryMarker === PERMISSION_REVOCATION_MARKER) {
    const request = knownPermissionRequest(authority, tag(event, 'permission'));
    const revocation = request ? parsePermissionRevocation(event, request) : undefined;
    if (!revocation) return unknown(event, 'malformed-schema');
    if (author.kind !== 'human' || !isAdmin(authority, scope.channelId, event.pubkey)) {
      return unknown(event, 'unauthorized');
    }
    return {
      ...envelope(event, scope),
      type: 'command',
      command: { kind: 'permission.revocation', revocation: revocation.value },
    };
  }
  if (factoryMarker === PERMISSION_EXECUTION_MARKER) {
    const request = knownPermissionRequest(authority, tag(event, 'permission'));
    const execution = request ? parsePermissionExecution(event, request) : undefined;
    if (!execution) return unknown(event, 'malformed-schema');
    return {
      ...envelope(event, scope),
      type: 'receipt',
      receipt: { kind: 'permission.execution', execution: execution.value },
    };
  }
  if (factoryMarker === DELEGATION_TURN_MARKER) {
    const turn = parseDelegationTurn(event);
    if (!turn) return unknown(event, 'malformed-schema');
    if (author.kind !== 'agent') return unknown(event, 'unauthorized');
    return {
      ...envelope(event, scope),
      type: 'command',
      command: { kind: 'delegation.turn', turn: turn.value },
    };
  }
  const receipt = parseDelegationReceipt(event);
  const parentTurn = receipt
    ? authority.knownDelegationTurns?.[receipt.value.turnEventId]
    : undefined;
  if (
    !receipt ||
    !parentTurn ||
    parentTurn.value.roomId !== scope.channelId ||
    parentTurn.value.delegationId !== receipt.value.delegationId ||
    parentTurn.value.workItemId !== receipt.value.workItemId ||
    (receipt.value.status === 'queued'
      ? event.pubkey !== parentTurn.value.fromAgentPubkey
      : event.pubkey !== parentTurn.value.toAgentPubkey)
  ) {
    return unknown(event, 'malformed-schema');
  }
  if (author.kind !== 'agent') return unknown(event, 'unauthorized');
  return {
    ...envelope(event, scope),
    type: 'receipt',
    receipt: { kind: 'delegation.receipt', delegation: receipt.value },
  };
}

function parseMessage(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  const scope = channelScope(event, authority);
  if (isUnknown(scope)) return scope;
  const author = identity(authority, event.pubkey);
  const markerSet = new Set(markers(event));
  const factory = parseFactoryMessage(event, scope, author, markerSet, authority);
  if (factory) return factory;
  if (!author || author.kind === 'infrastructure') return unknown(event, 'unresolved-identity');
  const agentAuthor = author.kind === 'agent';

  if (agentAuthor && markerSet.has(TAG_AGENT_ACTIVITY)) {
    const parsed = parseJson(event.content);
    return parsed ? parseActivity(event, scope, parsed) : unknown(event, 'malformed-schema');
  }
  if (agentAuthor) {
    const parsed = parseJson(event.content);
    if (parsed && text(parsed.sessionId) && record(parsed.update)) {
      return parseActivity(event, scope, parsed);
    }
  }

  const sessionMarker = [...markerSet].find((candidate) => SESSION_MARKERS.has(candidate));
  if (agentAuthor && sessionMarker) return parseSessionMarker(event, scope, sessionMarker);

  const controlMarker = [...markerSet].find((candidate) => CONTROL_MARKERS.has(candidate));
  const isExplicitBodyControl = markerSet.has('body-control') || Boolean(tag(event, 'subchannel'));
  if ((controlMarker || isExplicitBodyControl) && agentAuthor) {
    const projected = controlPayload(event, markerSet);
    return {
      ...envelope(event, scope),
      type: 'control',
      visibility: projected.visibility,
      payload: projected.payload,
    };
  }
  if (controlMarker === 'buzz-write-permission-response' && author.kind === 'human') {
    if (!isAdmin(authority, scope.channelId, event.pubkey)) {
      // An unauthorized reserved tag is prose, not authority and not a reason
      // to drop a human's words.
    } else {
      return {
        ...envelope(event, scope),
        type: 'control',
        visibility: 'hidden',
        payload: { kind: 'record', recordType: controlMarker },
      };
    }
  }

  if (!event.content.trim() && attachments(event).length === 0) {
    return unknown(event, 'malformed-schema');
  }
  const reply = replyReference(event, scope.channelId, authority);
  const conversation = {
    body: event.content,
    attachments: attachments(event),
    mentionPubkeys: mentionPubkeys(event),
    ...(reply && !isUnknown(reply) ? { reply } : {}),
    ...(tag(event, 'client-nonce') ? { clientNonce: tag(event, 'client-nonce') } : {}),
  };
  if (agentAuthor) {
    return {
      ...envelope(event, scope),
      type: 'agent-message',
      ...conversation,
      ...(tag(event, 'request') ? { requestId: tag(event, 'request') } : {}),
    } satisfies AgentMessage;
  }
  return {
    ...envelope(event, scope),
    type: 'human-message',
    ...conversation,
  } satisfies HumanMessage;
}

function parseMembership(event: NostrEvent, authority: ParseAuthority): Membership | Unknown {
  const scope = channelScope(event, authority, event.kind >= 39_000);
  if (isUnknown(scope)) return scope;
  const authorized =
    isAdmin(authority, scope.channelId, event.pubkey) ||
    isProjectionAuthority(authority, event.pubkey) ||
    authority.channelCreators?.[scope.channelId] === event.pubkey;
  if (!authorized) return unknown(event, 'unauthorized');

  if (event.kind === KIND_CHANNEL_MEMBERS || event.kind === KIND_CHANNEL_ADMINS) {
    const defaultRole: MemberRole = event.kind === KIND_CHANNEL_ADMINS ? 'admin' : 'member';
    return {
      ...envelope(event, scope),
      type: 'membership',
      membership: {
        mode: 'snapshot',
        members: tags(event, 'p')
          .flatMap((candidate) =>
            candidate[1]
              ? [{ pubkey: candidate[1] as Pubkey, role: role(candidate[2]) || defaultRole }]
              : [],
          )
          .map((member) => ({
            ...member,
            role: member.role === 'unknown' ? defaultRole : member.role,
          })),
      },
    };
  }
  const memberPubkey = tag(event, 'p');
  if (!memberPubkey) return unknown(event, 'malformed-schema');
  return {
    ...envelope(event, scope),
    type: 'membership',
    membership: {
      mode: 'mutation',
      action: event.kind === KIND_REMOVE_USER ? 'leave' : tag(event, 'role') ? 'role' : 'join',
      memberPubkey: memberPubkey as Pubkey,
      ...(event.kind === KIND_PUT_USER ? { role: role(tag(event, 'role')) } : {}),
    },
  };
}

function parseLifecycle(event: NostrEvent, authority: ParseAuthority): Lifecycle | Unknown {
  if (event.kind === KIND_CORNER_STATE) {
    const scope = channelScope(event, authority);
    if (isUnknown(scope)) return scope;
    const d = tag(event, 'd');
    const cornerId = d?.startsWith(`${TAG_CORNER_STATE}:`)
      ? d.slice(TAG_CORNER_STATE.length + 1)
      : undefined;
    const state = tag(event, 'state') === 'waiting-on-human' ? 'waiting' : tag(event, 'state');
    if (
      !cornerId ||
      !['open', 'working', 'waiting', 'idle', 'concluded', 'closed'].includes(state ?? '')
    ) {
      return unknown(event, 'malformed-schema');
    }
    if (authority.allowedChannelIds && !authority.allowedChannelIds.includes(cornerId)) {
      return unknown(event, 'foreign-channel');
    }
    if (authority.channelCreators?.[cornerId] !== event.pubkey)
      return unknown(event, 'unauthorized');
    const reason = tag(event, 'reason');
    if (reason && !['review', 'question', 'failure'].includes(reason)) {
      return unknown(event, 'malformed-schema');
    }
    return {
      ...envelope(event, scope),
      type: 'lifecycle',
      lifecycle: {
        entity: 'corner',
        cornerId: cornerId as ChannelId,
        parentRoomId: scope.channelId,
        state: state as CornerMachineState,
        ...(tag(event, 'name') ? { name: tag(event, 'name') } : {}),
        ...(authority.channelCreators?.[cornerId]
          ? { creatorPubkey: authority.channelCreators[cornerId] as Pubkey }
          : {}),
        stateAt: integer(tag(event, 'at')) ?? event.created_at,
        ...(reason ? { reason: reason as 'review' | 'question' | 'failure' } : {}),
        exists: state !== 'closed',
        ...(state === 'working' ? { leaseUntil: event.created_at + 90 } : {}),
      },
    } as Lifecycle;
  }
  const scope = channelScope(event, authority);
  if (isUnknown(scope)) return scope;
  if (event.kind === KIND_CREATE_GROUP) {
    const parentRoomId = tag(event, TAG_PARENT);
    const initialMembers = tags(event, 'p').flatMap((candidate) =>
      candidate[1] ? [{ pubkey: candidate[1] as Pubkey, role: role(candidate[2]) }] : [],
    );
    if (parentRoomId) {
      return {
        ...envelope(event, { ...scope, channelId: parentRoomId as ChannelId }),
        type: 'lifecycle',
        lifecycle: {
          entity: 'corner',
          cornerId: scope.channelId,
          parentRoomId: parentRoomId as ChannelId,
          state: 'open',
          ...(tag(event, 'name') ? { name: tag(event, 'name') } : {}),
          ...(tag(event, 'task') ? { task: tag(event, 'task') } : {}),
          creatorPubkey: event.pubkey as Pubkey,
          createdAt: event.created_at,
          ...(initialMembers.length ? { initialMembers } : {}),
          exists: true,
        },
      };
    }
    return {
      ...envelope(event, scope),
      type: 'lifecycle',
      lifecycle: {
        entity: 'room',
        roomId: scope.channelId,
        state: 'created',
        ...(tag(event, 'name') ? { name: tag(event, 'name') } : {}),
        ...(tag(event, 'about') ? { about: tag(event, 'about') } : {}),
        ...(initialMembers.length ? { initialMembers } : {}),
      },
    };
  }
  if (
    !isAdmin(authority, scope.channelId, event.pubkey) &&
    authority.channelCreators?.[scope.channelId] !== event.pubkey
  ) {
    return unknown(event, 'unauthorized');
  }
  const deleted = event.kind === KIND_DELETE_GROUP || tag(event, 'deleted') === 'true';
  const archived = tag(event, 'archived') === 'true';
  return {
    ...envelope(event, scope),
    type: 'lifecycle',
    lifecycle: {
      entity: 'room',
      roomId: scope.channelId,
      state: deleted ? 'deleted' : archived ? 'archived' : 'updated',
      ...(tag(event, 'name') ? { name: tag(event, 'name') } : {}),
      ...(tag(event, 'about') ? { about: tag(event, 'about') } : {}),
    },
  };
}

function parseParameterizedControl(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  const markerSet = new Set(markers(event));
  const d = tag(event, 'd');
  const h = tag(event, 'h');
  if (d?.startsWith(`${TAG_CORNER_STATE}:`) && markerSet.has(TAG_CORNER_STATE)) {
    return parseLifecycle(event, authority);
  }
  const workspaceId = tag(event, 'community') ?? authority.workspaceId;
  const scope = h
    ? channelScope(event, authority)
    : (workspaceScope(workspaceId) ?? unknown(event, 'invalid-envelope'));
  if (isUnknown(scope)) return scope;
  const author = identity(authority, event.pubkey);
  if (!author || author.kind !== 'agent') return unknown(event, 'unauthorized');
  const sessionMarker = [...markerSet].find((candidate) => SESSION_MARKERS.has(candidate));
  if (sessionMarker && scope.scope === 'channel')
    return parseSessionMarker(event, scope, sessionMarker);
  const verified = scope.scope === 'channel' ? envelope(event, scope) : envelope(event, scope);
  return {
    ...verified,
    type: 'control',
    visibility: 'hidden',
    payload: {
      kind: 'record',
      recordType: [...markerSet].sort()[0] ?? 'parameterized',
      recordId: d,
    },
  };
}

function parseIdentityControl(event: NostrEvent, authority: ParseAuthority): Control | Unknown {
  const workspaceId = tag(event, 'community') ?? authority.workspaceId;
  const scope = workspaceScope(workspaceId);
  if (!scope || (event.pubkey !== tag(event, 'agent') && tag(event, 'agent'))) {
    return unknown(event, 'unauthorized');
  }
  const body = parseJson(event.content);
  const current = authority.identities[event.pubkey];
  const identityRecord: IdentityRecord = {
    kind: 'agent',
    pubkey: event.pubkey as Pubkey,
    ...(text(body?.displayName) ? { displayName: text(body?.displayName) } : {}),
    ...(text(body?.handle) ? { handle: text(body?.handle) } : {}),
    revision: event.id,
    ...(current?.kind === 'agent' && !text(body?.displayName) && current.displayName
      ? { displayName: current.displayName }
      : {}),
  };
  return {
    ...envelope(event, scope),
    type: 'control',
    visibility: 'hidden',
    payload: { kind: 'identity', identity: identityRecord },
  };
}

/**
 * The sole wire interpretation boundary. Every input returns one closed union
 * member; malformed, foreign, unresolved, or unauthorized inputs return
 * Unknown, which deliberately carries no renderable content.
 */
function parseVerifiedRelayEventUnchecked(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  if (
    !Number.isSafeInteger(event.created_at) ||
    event.created_at < 0 ||
    !Array.isArray(event.tags)
  ) {
    return unknown(event, 'invalid-envelope');
  }
  if (event.kind === KIND_STREAM_MESSAGE && markers(event).includes(TAG_AGENT)) {
    return parseIdentityControl(event, authority);
  }
  if (event.kind === KIND_STREAM_MESSAGE) return parseMessage(event, authority);
  if (
    event.kind === KIND_PUT_USER ||
    event.kind === KIND_REMOVE_USER ||
    event.kind === KIND_CHANNEL_MEMBERS ||
    event.kind === KIND_CHANNEL_ADMINS
  ) {
    return parseMembership(event, authority);
  }
  if (
    event.kind === KIND_CREATE_GROUP ||
    event.kind === KIND_EDIT_METADATA ||
    event.kind === KIND_DELETE_GROUP
  ) {
    return parseLifecycle(event, authority);
  }
  if (event.kind === KIND_CORNER_STATE) return parseParameterizedControl(event, authority);
  return unknown(event, 'unknown-schema');
}

function parseRelayEventUnchecked(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  if (!verifyEvent(event)) return unknown(event, 'invalid-signature');
  return parseVerifiedRelayEventUnchecked(event, authority);
}

function parseVerifiedRelayEvent(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  try {
    return parseVerifiedRelayEventUnchecked(event, authority);
  } catch {
    return unknown(event, 'malformed-schema');
  }
}

/**
 * Parse one untrusted relay value without allowing a malformed envelope to
 * abort the page around it. Runtime bridge data is not entitled to the
 * compile-time `NostrEvent` shape: permission/delegation readers and signature
 * serialization may otherwise throw before they can return Unknown.
 */
export function parseRelayEvent(event: NostrEvent, authority: ParseAuthority): ReadEvent {
  try {
    return parseRelayEventUnchecked(event, authority);
  } catch {
    return unknown(event, 'malformed-schema');
  }
}

/**
 * Parse one delivery page without making reply validity depend on page order.
 * The first pass admits only fully verified conversation messages as possible
 * parents; the second pass is the only place reply tags become opaque typed
 * references. Existing snapshot parents may be supplied in `knownMessages`.
 */
export function parseRelayEvents(
  events: readonly NostrEvent[],
  authority: ParseAuthority,
): readonly ReadEvent[] {
  // Reply discovery needs two schema passes, but signature verification is a
  // page admission decision and is intentionally paid only once per event.
  // On a 200-message mobile backfill secp256k1 verification dominated Room
  // open time when both passes independently called verifyEvent.
  const admitted: Array<
    | { readonly accepted: true; readonly event: NostrEvent }
    | { readonly accepted: false; readonly event: NostrEvent; readonly rejected: ReadEvent }
  > = events.map((event) => {
    try {
      return verifyEvent(event)
        ? ({ accepted: true, event } as const)
        : ({ accepted: false, event, rejected: unknown(event, 'invalid-signature') } as const);
    } catch {
      return {
        accepted: false,
        event,
        rejected: unknown(event, 'malformed-schema'),
      } as const;
    }
  });
  const knownMessages: Record<string, { channelId: string; rootId?: string }> = {
    ...authority.knownMessages,
  };
  const knownPermissionRequests = { ...authority.knownPermissionRequests };
  const knownDelegationTurns = { ...authority.knownDelegationTurns };
  for (const candidate of admitted) {
    if (!candidate.accepted) continue;
    const { event } = candidate;
    try {
      const request = parsePermissionRequest(event);
      if (request) knownPermissionRequests[event.id] = request;
      const turn = parseDelegationTurn(event);
      if (turn) knownDelegationTurns[event.id] = turn;
    } catch {
      // The event itself becomes Unknown in the normal parse passes below.
      // Its failure must not discard valid permission/delegation context from
      // any other event in this delivery page.
    }
  }
  const candidateAuthority = {
    ...authority,
    knownMessages: {},
    knownPermissionRequests,
    knownDelegationTurns,
  };
  for (const candidate of admitted) {
    if (!candidate.accepted) continue;
    const parsed = parseVerifiedRelayEvent(candidate.event, candidateAuthority);
    if (parsed.type !== 'human-message' && parsed.type !== 'agent-message') continue;
    knownMessages[parsed.eventId] = { channelId: parsed.channelId };
  }
  const replyById = new Map(
    admitted.flatMap((candidate) => {
      if (!candidate.accepted) return [];
      const { event } = candidate;
      try {
        if (!Array.isArray(event.tags)) return [];
        const replyId = event.tags.find(
          (candidate) =>
            Array.isArray(candidate) &&
            candidate[0] === 'e' &&
            candidate[1] &&
            candidate[3] === 'reply',
        )?.[1];
        return replyId ? [[event.id, replyId] as const] : [];
      } catch {
        return [];
      }
    }),
  );
  const rootFor = (eventId: string): string => {
    const seen = new Set<string>();
    let cursor = eventId;
    while (replyById.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = replyById.get(cursor)!;
      if (!knownMessages[parent]) break;
      cursor = knownMessages[parent]?.rootId ?? parent;
    }
    return cursor;
  };
  for (const eventId of Object.keys(knownMessages)) {
    knownMessages[eventId] = {
      ...knownMessages[eventId]!,
      rootId: rootFor(eventId),
    };
  }
  const finalAuthority = {
    ...authority,
    knownMessages,
    knownPermissionRequests,
    knownDelegationTurns,
  };
  return admitted.map((candidate) =>
    candidate.accepted
      ? parseVerifiedRelayEvent(candidate.event, finalAuthority)
      : candidate.rejected,
  );
}
