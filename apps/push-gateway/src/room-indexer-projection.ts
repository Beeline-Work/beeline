import {
  ROOM_VIEW_MESSAGE_LIMIT,
  TAG_AGENT,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_DRAFT,
  TAG_AGENT_PRESENCE,
  TAG_AGENT_THOUGHT,
  isRetiredAgentNotice,
  normalizeRoomRepositoryContent,
  parseAttachmentTags,
  parseChangeReviewArtifactDescriptor,
  deriveCornerLifecycle,
  parseCornerGitProjectionCompat,
  type ChatListWorkspace,
  type CornerListItem,
  type CornerLifecycleView,
  type CornerVerdictView,
  type RoomRepositoryView,
  type RoomReviewView,
  type RoomViewAgentTurn,
  type RoomViewActivity,
  type RoomViewHeader,
  type RoomViewIdentity,
  type RoomViewMember,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import { HISTORY_EVENT_LIMIT } from './room-indexer-sql.js';

export type IndexRow = { readonly section: string; readonly data: unknown };
export type Json = Record<string, unknown>;

export function json(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function integer(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function tags(value: unknown): string[][] {
  return Array.isArray(value)
    ? value.flatMap((candidate) =>
        Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')
          ? [candidate as string[]]
          : [],
      )
    : [];
}

function tag(values: readonly string[][], name: string): string | undefined {
  return values.find((candidate) => candidate[0] === name)?.[1];
}

function markerSet(values: readonly string[][]): Set<string> {
  return new Set(
    values.flatMap((candidate) => (candidate[0] === 't' && candidate[1] ? [candidate[1]] : [])),
  );
}

function githubEventCard(
  values: readonly string[][],
): NonNullable<RoomViewMessage['githubEvent']> | undefined {
  const type = tag(values, 'github-event-type');
  const action = tag(values, 'github-event-action');
  const actor = text(tag(values, 'github-event-actor'));
  const title = text(tag(values, 'github-event-title'));
  const url = text(tag(values, 'github-event-url'));
  if (
    tag(values, 'service') !== 'beeline-events' ||
    !text(tag(values, 'github-event-id')) ||
    (type !== 'pull-request' && type !== 'issue') ||
    (action !== 'opened' && action !== 'closed' && action !== 'merged') ||
    (type === 'issue' && action === 'merged') ||
    !actor ||
    !title ||
    !url ||
    !/^https:\/\/github\.com\/[^\s]+$/i.test(url)
  )
    return undefined;
  return { type, action, actor, title, url };
}

export function identity(data: Json): RoomViewIdentity {
  const pubkey = String(data.pubkey ?? '');
  const fallback = pubkey
    ? `${data.agent === true ? 'Agent' : 'Person'} ${pubkey.slice(0, 8)}`
    : 'Unknown';
  return {
    pubkey,
    kind: data.agent === true ? 'agent' : 'human',
    name: text(data.name) ?? text(data.handle)?.split('@')[0] ?? fallback,
    ...(text(data.handle) ? { handle: text(data.handle) } : {}),
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
  };
}

export function header(data: Json): RoomViewHeader {
  return {
    id: String(data.id ?? ''),
    workspaceId: String(data.workspaceId ?? data.id ?? ''),
    ...(text(data.parentId) ? { parentId: text(data.parentId) } : {}),
    name: text(data.name) ?? 'ROOM',
    ...(text(data.about) ? { about: text(data.about) } : {}),
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
    ...(text(data.visibility)
      ? {
          visibility:
            data.visibility === 'open' || data.visibility === 'public'
              ? ('public' as const)
              : ('invite-only' as const),
        }
      : {}),
    archived: data.archived === true,
    createdAt: integer(data.createdAt),
    updatedAt: integer(data.updatedAt),
  };
}

export function workspaceItem(data: Json): ChatListWorkspace {
  return {
    id: String(data.id ?? ''),
    name: text(data.name) ?? 'WORKSPACE',
    ...(text(data.avatar) ? { avatar: text(data.avatar) } : {}),
    visibility:
      data.visibility === 'private' || data.visibility === 'invite-only' ? 'invite-only' : 'public',
    role: data.role === 'owner' || data.role === 'admin' ? data.role : 'member',
    updatedAt: integer(data.updatedAt),
  };
}

export function safeJson(content: string): Json | undefined {
  try {
    return json(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function activityDetail(value: unknown): RoomViewActivity | undefined {
  const update = json(value);
  const updateType = text(update.sessionUpdate) ?? text(update.type) ?? '';
  const kind: RoomViewActivity['kind'] = updateType.includes('thought')
    ? 'thinking'
    : updateType.includes('tool')
      ? 'tool'
      : updateType.includes('summary')
        ? 'summary'
        : 'output';
  const rollup = json(update.rollup);
  const observed = Array.isArray(update.observed)
    ? update.observed.flatMap((item) => {
        const entry = json(item);
        const verb = text(entry.verb);
        return verb
          ? [
              {
                verb,
                ...(text(entry.target) ? { target: text(entry.target) } : {}),
                ...(text(entry.result) ? { result: text(entry.result) } : {}),
              },
            ]
          : [];
      })
    : [];
  const files = Array.isArray(update.files)
    ? update.files.flatMap((item) => {
        const file = json(item);
        const path = text(file.path);
        return path ? [{ path, ...(text(file.status) ? { status: text(file.status) } : {}) }] : [];
      })
    : [];
  const rawPlan = json(update.plan);
  const planItems = Array.isArray(rawPlan.items)
    ? rawPlan.items.flatMap((item) => {
        const planItem = json(item);
        const step = text(planItem.step);
        const status = text(planItem.status);
        return step && (status === 'pending' || status === 'in_progress' || status === 'completed')
          ? [{ step, status: status as 'pending' | 'in_progress' | 'completed' }]
          : [];
      })
    : [];
  return {
    kind,
    title:
      text(update.title) ??
      (kind === 'tool' ? 'Tool' : kind === 'thinking' ? 'Thinking' : 'Update'),
    ...(updateType ? { operation: updateType } : {}),
    ...(text(update.status) ? { status: text(update.status) } : {}),
    ...(typeof update.thoughtMs === 'number' && update.thoughtMs > 0
      ? { thoughtMs: update.thoughtMs }
      : {}),
    ...(Object.keys(rollup).length
      ? {
          rollup: Object.fromEntries(
            Object.entries(rollup).filter(
              ([, count]) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
            ),
          ) as Record<string, number>,
        }
      : {}),
    ...(observed.length ? { observed } : {}),
    ...(files.length ? { files } : {}),
    ...(planItems.length
      ? {
          plan: {
            ...(text(rawPlan.objective) ? { objective: text(rawPlan.objective) } : {}),
            items: planItems,
          },
        }
      : {}),
  };
}

const HIDDEN_MARKERS = new Set([
  TAG_AGENT,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_AGENT_PRESENCE,
  'body-control',
  'agent-turn',
  'corner-session',
  'buzz-merge-approval',
  'buzz-write-permission-response',
  'buzz-permission-decision',
  'buzz-permission-revocation',
  'buzz-permission-execution',
  'beeline-agent-tool-result',
  'buzz-work-schedule-paused',
  'agent-activity',
  'buzz-agent-model-unavailable',
]);

/** Durable machine-authored Room lines that the client renders as status text. */
const SYSTEM_MARKERS = new Set([
  'github-event-health',
  'steer-queued',
  'slash-command-notice',
]);

/**
 * Typed kind:9 events are machine records unless they opt into one of the
 * product's durable conversation shapes. This fail-closed boundary keeps new
 * control records visible as system lines without silently spending a model
 * transcript slot.
 */
const CONVERSATION_MARKERS = new Set([
  'agent-message',
  'buzz-agent-exchange',
  'buzz-agent-delegation',
  'buzz-agent-request',
  'buzz-attachment',
]);

export function projectEvent(data: Json, channelId: string): RoomViewMessage | undefined {
  const eventTags = tags(data.tags);
  const markers = markerSet(eventTags);
  const eventIdentity = identity(data);
  const content = String(data.content ?? '');
  // Legacy daemon machine records occasionally used kind:9 with a serialized
  // payload. They are typed records, never chat, even before their writers are
  // migrated to replaceable non-rendered kinds.
  if (integer(data.kind) === 9 && eventIdentity.kind === 'agent' && safeJson(content)) {
    return undefined;
  }
  const permissionMarker =
    markers.has('buzz-write-permission-request') || markers.has('buzz-permission-request');
  // Permission requests are control records on the wire but durable approval
  // cards in the Room. All other hidden control shapes still fail closed.
  if (!permissionMarker && [...markers].some((candidate) => HIDDEN_MARKERS.has(candidate)))
    return undefined;
  const base = {
    id: String(data.id ?? ''),
    text: content,
    createdAt: integer(data.createdAt),
    author: eventIdentity,
  };

  // Old daemon health/stall prose has no distinguishing wire tag. The shared
  // tombstone is therefore the only safe discriminator; suppress it before it
  // can become a transcript row, Room-list preview, or corner preview.
  if (isRetiredAgentNotice(base.text)) return undefined;

  if (
    markers.has(TAG_AGENT_ACTIVITY) ||
    (eventIdentity.kind === 'agent' && safeJson(base.text)?.sessionId)
  ) {
    const parsed = safeJson(base.text);
    const update = json(parsed?.update);
    const candidates =
      update.sessionUpdate === 'activity_batch' && Array.isArray(update.updates)
        ? update.updates
        : [update];
    const activity = candidates.flatMap((candidate) => {
      const detail = activityDetail(candidate);
      return detail ? [detail] : [];
    });
    if (!activity.length) return undefined;
    const failed =
      activity.some((item) => item.status === 'failed') || tag(eventTags, 'status') === 'failed';
    const merge = tag(eventTags, 'delivery-stage') === 'landed' || markers.has('landed');
    const action = [...markers].some((candidate) =>
      ['corner-open', 'room-target-branch-realign', 'branch-switch'].includes(candidate),
    );
    return {
      ...base,
      text: '',
      presentation: 'activity',
      activity,
      ...(failed
        ? { durableFact: 'failure' as const }
        : merge
          ? { durableFact: 'merge' as const }
          : action
            ? { durableFact: 'action' as const }
            : {}),
    };
  }

  if (markers.has('github-event')) {
    // A service health notice is status text, not a person-authored turn.
    if (markers.has('github-event-health')) return { ...base, presentation: 'system' };
    // Old batch prose never gets a compatibility renderer: cards need the
    // complete typed envelope or remain invisible.
    const githubEvent = githubEventCard(eventTags);
    return githubEvent ? { ...base, text: '', presentation: 'card', githubEvent } : undefined;
  }

  if (markers.has('land-summary')) {
    const cornerId = tag(eventTags, 'subchannel');
    const objective = tag(eventTags, 'objective');
    const delivered = tag(eventTags, 'delivered');
    const omitted = tag(eventTags, 'omitted');
    const branch = tag(eventTags, 'branch');
    const tip = tag(eventTags, 'tip');
    const url = tag(eventTags, 'url');
    const approverPubkey = tag(eventTags, 'approver');
    const approverName = tag(eventTags, 'approver-name');
    const approverHandle = tag(eventTags, 'approver-handle');
    // Old recap events lacked the typed envelope. Keep their text visible as
    // a system line; only a complete new-generation digest gets the card.
    if (
      !cornerId ||
      !objective ||
      !delivered ||
      !omitted ||
      !branch ||
      !/^[0-9a-f]{40}$/i.test(tip ?? '')
    ) {
      return { ...base, presentation: 'system' };
    }
    return {
      ...base,
      presentation: 'card',
      landSummary: {
        cornerId,
        objective,
        delivered,
        omitted,
        branch,
        tip: tip!,
        ...(url?.startsWith('https://') ? { url } : {}),
        ...(approverPubkey &&
        /^[0-9a-f]{64}$/.test(approverPubkey) &&
        approverName &&
        approverHandle
          ? {
              approvedBy: {
                pubkey: approverPubkey,
                name: approverName,
                handle: approverHandle,
              },
            }
          : {}),
      },
    };
  }

  if (permissionMarker) {
    const status = tag(eventTags, 'status');
    const agentPubkey = tag(eventTags, 'agent') ?? eventIdentity.pubkey;
    const requesterPubkey = tag(eventTags, 'requester') ?? '';
    const deciderPubkey = tag(eventTags, 'decider');
    if (!/^[0-9a-f]{64}$/.test(requesterPubkey)) return undefined;
    return {
      ...base,
      presentation: 'card',
      permission: {
        permissionId: tag(eventTags, 'permission') ?? base.id,
        requestId: tag(eventTags, 'request') ?? base.id,
        agent:
          agentPubkey === eventIdentity.pubkey
            ? eventIdentity
            : { pubkey: agentPubkey, kind: 'agent', name: `Agent ${agentPubkey.slice(0, 8)}` },
        requester: {
          pubkey: requesterPubkey,
          kind: 'human',
          name: `Person ${requesterPubkey.slice(0, 8)}`,
        },
        ...(deciderPubkey && /^[0-9a-f]{64}$/.test(deciderPubkey)
          ? {
              decider: {
                pubkey: deciderPubkey,
                kind: 'human' as const,
                name: `Person ${deciderPubkey.slice(0, 8)}`,
              },
            }
          : {}),
        tool: tag(eventTags, 'tool') ?? 'edit files',
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
        ...(tag(eventTags, 'purpose') === 'squire-spending'
          ? { purpose: 'squire-spending' as const }
          : {}),
        status:
          status === 'allowed' || status === 'denied' || status === 'expired' || status === 'failed'
            ? status
            : 'pending',
        ...(tag(eventTags, 'subchannel') ? { cornerId: tag(eventTags, 'subchannel') } : {}),
      },
    };
  }

  if (markers.has('buzz-target-branch-proposal')) {
    const from = tag(eventTags, 'from');
    const to = tag(eventTags, 'to');
    if (!from || !to) return undefined;
    return {
      ...base,
      presentation: 'card',
      targetBranch: {
        proposalId: base.id,
        from,
        to,
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
      },
    };
  }

  const mergeAction = markers.has('merge-ready')
    ? 'ready'
    : markers.has('buzz-merge-approval-ack')
      ? 'approval-ack'
      : tag(eventTags, 'status') === 'failed' && !tag(eventTags, 'subchannel')
        ? 'failed'
        : markers.has('landed') || tag(eventTags, 'delivery') === 'landed'
          ? 'landed'
          : undefined;
  if (mergeAction) {
    const retry = tag(eventTags, 'retry');
    const decision = tag(eventTags, 'decision');
    const state = tag(eventTags, 'state');
    return {
      ...base,
      presentation: mergeAction === 'ready' ? 'card' : 'system',
      merge: {
        action: mergeAction,
        ...(tag(eventTags, 'repo') ? { repository: tag(eventTags, 'repo') } : {}),
        ...(tag(eventTags, 'branch') ? { branch: tag(eventTags, 'branch') } : {}),
        ...(tag(eventTags, 'tip') ? { tip: tag(eventTags, 'tip') } : {}),
        ...(tag(eventTags, 'patch-id') ? { patchId: tag(eventTags, 'patch-id') } : {}),
        ...(tag(eventTags, 'preview')?.startsWith('https://')
          ? { previewUrl: tag(eventTags, 'preview') }
          : {}),
        ...(retry === 'auto' || retry === 'realigning' || retry === 'blocked' ? { retry } : {}),
        ...(tag(eventTags, 'approval') ? { approvalId: tag(eventTags, 'approval') } : {}),
        ...(decision === 'accepted' || decision === 'rejected' ? { decision } : {}),
        ...(state === 'landing' ||
        state === 'realigning' ||
        state === 'realigned' ||
        state === 'content-changed' ||
        state === 'tip-moved'
          ? { state }
          : {}),
        ...(tag(eventTags, 'rejected-tip') ? { rejectedTip: tag(eventTags, 'rejected-tip') } : {}),
      },
    };
  }

  const cornerId = tag(eventTags, 'subchannel');
  if (cornerId) {
    const status = tag(eventTags, 'status');
    if (
      status !== 'open' &&
      status !== 'working' &&
      status !== 'waiting' &&
      status !== 'idle' &&
      status !== 'concluded' &&
      status !== 'closed'
    )
      return undefined;
    return { ...base, presentation: 'card', corner: { id: cornerId, status } };
  }

  if ([...markers].some((candidate) => SYSTEM_MARKERS.has(candidate))) {
    return { ...base, presentation: 'system' };
  }
  if (markers.size > 0 && [...markers].some((candidate) => !CONVERSATION_MARKERS.has(candidate))) {
    if ([...markers].some((candidate) => candidate.startsWith('buzz-'))) return undefined;
    return { ...base, presentation: 'system' };
  }
  if (!base.text.trim() && !markers.has('buzz-attachment')) return undefined;

  const replyMarker = eventTags.find(
    (candidate) => candidate[0] === 'e' && candidate[3] === 'reply',
  );
  const replyId = replyMarker?.[1];
  const validatedRoot = text(data.rootId);
  const rootId = validatedRoot && /^[0-9a-f]{64}$/.test(validatedRoot) ? validatedRoot : undefined;
  const requestId = tag(eventTags, 'request');
  return {
    ...base,
    presentation: 'message',
    ...(requestId ? { requestId, liveTurnId: `live-turn:${requestId}` } : {}),
    ...(parseAttachmentTags(eventTags).length
      ? { attachments: parseAttachmentTags(eventTags) }
      : {}),
    ...(eventTags.some((candidate) => candidate[0] === 'p')
      ? {
          mentionPubkeys: [
            ...new Set(
              eventTags.flatMap((candidate) =>
                candidate[0] === 'p' && /^[0-9a-f]{64}$/.test(candidate[1] ?? '')
                  ? [candidate[1]!]
                  : [],
              ),
            ),
          ],
        }
      : {}),
    ...(replyId && /^[0-9a-f]{64}$/.test(replyId) && rootId
      ? { reply: { channelId, eventId: replyId, rootId } }
      : {}),
    ...((!replyMarker || (replyId && /^[0-9a-f]{64}$/.test(replyId))) && rootId
      ? { reference: { channelId, eventId: base.id, rootId } }
      : {}),
  } as RoomViewMessage;
}

export function projectedMessages(
  rows: readonly IndexRow[],
  section: string,
  channelId: string,
  limit: number,
) {
  return allProjectedMessages(rows, section, channelId).slice(-limit);
}

function allProjectedMessages(rows: readonly IndexRow[], section: string, channelId: string) {
  const projected = rows
    .filter((row) => row.section === section)
    .flatMap((row) => {
      const message = projectEvent(json(row.data), channelId);
      return message ? [message] : [];
    })
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  return collapsePermissionCards(projected);
}

/**
 * Preserve the durable transcript independently from ephemeral live activity.
 * Settled telemetry is not a transcript row and therefore cannot spend one of
 * the Room's bounded message slots. Activity for a currently working turn is
 * still returned for the live client projection, in its own bounded lane.
 */
export function projectedRoomMessages(
  rows: readonly IndexRow[],
  channelId: string,
  latestAgentTurns: readonly RoomViewAgentTurn[],
): RoomViewMessage[] {
  const projected = allProjectedMessages(rows, 'event', channelId);
  const workingByAgent = new Map(
    latestAgentTurns
      .filter((turn) => turn.status === 'working')
      .map((turn) => [turn.agentPubkey, turn.createdAt]),
  );
  const transcript = projected
    .filter((message) => message.presentation !== 'activity' || message.durableFact)
    .slice(-ROOM_VIEW_MESSAGE_LIMIT);
  const liveActivity = projected
    .filter(
      (message) =>
        message.presentation === 'activity' &&
        !message.durableFact &&
        message.createdAt >=
          (workingByAgent.get(message.author.pubkey) ?? Number.POSITIVE_INFINITY),
    )
    .slice(-ROOM_VIEW_MESSAGE_LIMIT);
  const byId = new Map([...transcript, ...liveActivity].map((message) => [message.id, message]));
  return [...byId.values()].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
}

/**
 * The plan is a durable corner fixture even after activity rows leave the
 * live lane. Derive it before the bounded transcript slice so a long finished
 * corner cannot lose its checklist merely because newer prose fills the tail.
 */
export function latestCornerPlan(
  rows: readonly IndexRow[],
  channelId: string,
): RoomViewActivity['plan'] | undefined {
  let plan: RoomViewActivity['plan'];
  for (const message of allProjectedMessages(rows, 'event', channelId)) {
    for (const activity of message.activity ?? []) {
      if (activity.plan) plan = activity.plan;
    }
  }
  return plan;
}

/** Fold signed permission history into the single paint-ready card it models. */
export function collapsePermissionCards(projected: readonly RoomViewMessage[]): RoomViewMessage[] {
  const latestPermission = new Map<string, RoomViewMessage>();
  for (const message of projected) {
    if (!message.permission) continue;
    const existing = latestPermission.get(message.permission.permissionId);
    if (!existing?.permission || existing.permission.status === 'pending') {
      latestPermission.set(message.permission.permissionId, message);
    } else if (message.permission.status !== 'pending') {
      latestPermission.set(message.permission.permissionId, message);
    }
  }
  return projected.filter(
    (message) =>
      !message.permission || latestPermission.get(message.permission.permissionId) === message,
  );
}

export function projectedHistoryPage(
  rows: readonly IndexRow[],
  channelId: string,
): { messages: RoomViewMessage[]; nextBefore?: { createdAt: number; id: string } } {
  const raw = rows.filter((row) => row.section === 'event');
  const messages: RoomViewMessage[] = [];
  let examined = 0;
  let cursor: Json | undefined;
  for (const row of raw) {
    cursor = json(row.data);
    examined += 1;
    const message = projectEvent(cursor, channelId);
    if (message) messages.push(message);
    if (messages.length === ROOM_VIEW_MESSAGE_LIMIT) break;
  }
  messages.sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  const hasMoreRawRows = examined < raw.length || raw.length === HISTORY_EVENT_LIMIT;
  return {
    messages: collapsePermissionCards(messages),
    ...(hasMoreRawRows && cursor
      ? { nextBefore: { createdAt: integer(cursor.createdAt), id: String(cursor.id ?? '') } }
      : {}),
  };
}

export function viewer(room: Json, members: readonly RoomViewMember[]) {
  const pubkey = String(room.viewerPubkey ?? '');
  const member = members.find((candidate) => candidate.identity.pubkey === pubkey);
  return {
    identity: member?.identity ?? identity({ pubkey }),
    role: (room.viewerRole === 'owner' || room.viewerRole === 'admin'
      ? room.viewerRole
      : 'member') as 'owner' | 'admin' | 'member',
    permissions: {
      send: room.archived !== true,
      manage: room.viewerRole === 'owner' || room.viewerRole === 'admin',
    },
  };
}

export function rowData(rows: readonly IndexRow[], section: string): Json | undefined {
  const row = rows.find((candidate) => candidate.section === section);
  return row ? json(row.data) : undefined;
}

export function repositoryFromRows(rows: readonly IndexRow[]): RoomRepositoryView | undefined {
  const repositoryData = rowData(rows, 'repository');
  if (!repositoryData || !text(repositoryData.content)) return undefined;
  const normalized = normalizeRoomRepositoryContent(safeJson(text(repositoryData.content)!) ?? {});
  if (!normalized) return undefined;
  return {
    key: normalized.key,
    name: normalized.name,
    remote: normalized.remote,
    targetBranch: normalized.targetBranch ?? 'main',
    updatedAt: integer(repositoryData.updatedAt),
    ...(normalized.githubInstallationId
      ? { githubInstallationId: normalized.githubInstallationId }
      : {}),
    githubEventsEnabled: normalized.githubEventsEnabled !== false,
  };
}

export function repositoryResolutionFromRows(
  rows: readonly IndexRow[],
  repository: RoomRepositoryView | undefined,
): 'repository' | 'none' | 'unverified' {
  if (repository) return 'repository';
  // Keep an authorization failure separate from absence. This row is any
  // relay-indexed repository event, while `repository` above is limited to
  // one whose author still projects as the Room owner/admin.
  return rowData(rows, 'repository-candidate') ? 'unverified' : 'none';
}

export function reviewFromRows(rows: readonly IndexRow[]): RoomReviewView {
  const reviewData = rowData(rows, 'review');
  const descriptor =
    reviewData && text(reviewData.content)
      ? (parseCornerGitProjectionCompat(text(reviewData.content))?.artifact ??
        parseChangeReviewArtifactDescriptor(text(reviewData.content)!))
      : null;
  const notReady = text(rowData(rows, 'not-ready')?.reason);
  const approvedBy = rows
    .filter((row) => row.section === 'approval')
    .map((row) => identity(json(row.data)))
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.pubkey === candidate.pubkey) === index,
    );
  return descriptor
    ? { status: 'ready', artifact: descriptor, files: descriptor.files, approvedBy }
    : notReady
      ? { status: 'not-ready', reason: notReady, files: [], approvedBy }
      : { status: 'none', files: [], approvedBy };
}

export function cornerLifecycle(data: Json): CornerLifecycleView {
  const git = parseCornerGitProjectionCompat(text(data.gitProjectionContent));
  const rawVerdict = text(data.verdict);
  const eventId = text(data.verdictEventId);
  const signerPubkey = text(data.verdictPubkey);
  const repository = text(data.verdictRepository);
  const targetBranch = text(data.verdictTargetBranch);
  const candidate: CornerVerdictView | undefined =
    (rawVerdict === 'approve' || rawVerdict === 'reject') &&
    eventId &&
    /^[0-9a-f]{64}$/.test(eventId) &&
    signerPubkey &&
    /^[0-9a-f]{64}$/.test(signerPubkey) &&
    repository &&
    targetBranch &&
    (!git ||
      git.repository === 'legacy-unverified' ||
      (git.repository === repository && git.targetBranch === targetBranch))
      ? {
          verdict: rawVerdict,
          eventId,
          signerPubkey,
          repository,
          targetBranch,
          createdAt: integer(data.verdictCreatedAt),
        }
      : undefined;
  return deriveCornerLifecycle({
    created: true,
    archived: data.archived === true,
    ...(git ? { git } : {}),
    ...(candidate ? { verdict: candidate } : {}),
  });
}

export function cornerItem(data: Json, latest?: RoomViewMessage): CornerListItem {
  const lifecycle = cornerLifecycle(data);
  const stateTags = tags(data.statusTags);
  const rawStatus = tag(stateTags, 'state');
  const status = rawStatus === 'waiting-on-human' ? 'waiting' : rawStatus;
  const latestTurnStatus = text(data.latestTurnStatus);
  const agentData = {
    pubkey: data.agentPubkey,
    name: data.agentName,
    handle: data.agentHandle,
    avatar: data.agentAvatar,
    agent: data.agent,
  };
  return {
    corner: header(data),
    lifecycle,
    status:
      lifecycle.lifecycle === 'ARCHIVED'
        ? 'closed'
        : lifecycle.lifecycle === 'REVIEW'
          ? 'waiting'
          : lifecycle.lifecycle === 'APPROVED' || lifecycle.lifecycle === 'REJECTED'
            ? 'working'
            : lifecycle.lifecycle === 'WORKING' && latestTurnStatus === 'working'
              ? 'working'
              : status === 'working' ||
                status === 'waiting' ||
                status === 'idle' ||
                status === 'concluded' ||
                status === 'closed'
                ? status
                : 'open',
    ...(lifecycle.lifecycle === 'REVIEW'
      ? { reason: 'review' as const }
      : ['review', 'question', 'failure'].includes(tag(stateTags, 'reason') ?? '')
        ? { reason: tag(stateTags, 'reason') as 'review' | 'question' | 'failure' }
        : {}),
    ...(text(data.agentPubkey) ? { agent: identity(agentData) } : {}),
    ...(latest
      ? {
          latestMessage: {
            id: latest.id,
            text: latest.text,
            createdAt: latest.createdAt,
            author: latest.author,
          },
        }
      : {}),
  };
}
