import type { AgentActivityItem, SessionEvent } from './rig-transport';
import {
  parseAttachmentTags,
  type AttachmentReference,
  type AgentPresence,
  type MergeTarget,
  type SessionEvent as BuzzSessionEvent,
} from '@beeline/buzz-client';
import { agentDraftFromSessionEvent } from '@/buzz/agent-draft';
import { agentPresenceFromSessionEvent } from '@/buzz/agent-presence';
import { cornerStatusPrecedence, mapRawCornerStatusTag, type CornerStatus } from '@/buzz/corners';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

/** Read ACP text/content blocks without ever exposing the JSON wire envelope. */
function readTextContent(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => readTextContent(part, depth + 1))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  const record = asRecord(value);
  if (!record) return undefined;
  if (typeof record.text === 'string' && record.text) return record.text;
  if ('content' in record) return readTextContent(record.content, depth + 1);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function compactFiles(value: unknown): NonNullable<AgentActivityItem['files']> | undefined {
  if (!Array.isArray(value)) return undefined;
  const files = value.flatMap((item) => {
    const record = asRecord(item);
    const path = stringValue(record?.path);
    return path
      ? [
          {
            path,
            ...(stringValue(record?.status) ? { status: stringValue(record?.status) } : {}),
            ...(stringValue(record?.diff) ? { diff: stringValue(record?.diff) } : {}),
          },
        ]
      : [];
  });
  return files.length ? files : undefined;
}

function compactPlan(value: unknown): AgentActivityItem['plan'] | undefined {
  const plan = asRecord(value);
  if (!plan || !Array.isArray(plan.items)) return undefined;
  const items = plan.items.flatMap((item) => {
    const record = asRecord(item);
    const step = stringValue(record?.step);
    const status = record?.status;
    if (!step || (status !== 'pending' && status !== 'in_progress' && status !== 'completed')) {
      return [];
    }
    return [{ step, status }] satisfies NonNullable<AgentActivityItem['plan']>['items'];
  });
  const objective = stringValue(plan.objective);
  return items.length || objective ? { ...(objective ? { objective } : {}), items } : undefined;
}

/**
 * Body activity is a JSON-encoded ACP `session/update` envelope. Project the
 * user-facing content, not that transport envelope. Plain-text activity from
 * older bodies remains valid.
 */
export function agentActivityDetails(content: string): AgentActivityItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content.trim() ? [{ kind: 'output', title: 'Output', text: content }] : [];
  }

  if (typeof parsed === 'string') {
    return parsed.trim() ? [{ kind: 'output', title: 'Output', text: parsed }] : [];
  }
  const envelope = asRecord(parsed);
  if (!envelope) return [];
  const update = asRecord(envelope.update);
  if (!update) {
    const text = readTextContent(envelope.content);
    return text ? [{ kind: 'output', title: 'Output', text }] : [];
  }

  if (update.sessionUpdate === 'activity_batch' && Array.isArray(update.updates)) {
    return update.updates.flatMap((item) => agentActivityDetails(JSON.stringify({ update: item })));
  }

  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  if (sessionUpdate === 'tool_activity') {
    const title = stringValue(update.title) ?? 'Tool';
    const command = stringValue(update.command);
    const input = stringValue(update.input);
    const output = stringValue(update.output);
    const files = compactFiles(update.files);
    const plan = compactPlan(update.plan);
    return [
      {
        kind: 'tool',
        title,
        ...(stringValue(update.toolCallId) ? { id: stringValue(update.toolCallId) } : {}),
        ...(stringValue(update.kind) ? { toolKind: stringValue(update.kind) } : {}),
        ...(stringValue(update.status) ? { status: stringValue(update.status) } : {}),
        ...(command ? { command } : {}),
        ...(input ? { input } : {}),
        ...(output ? { output, text: output } : {}),
        ...(files ? { files } : {}),
        ...(plan ? { plan } : {}),
      },
    ];
  }
  if (sessionUpdate === 'progress_update') {
    const text = stringValue(update.text);
    return text ? [{ kind: 'output', title: 'Update', text }] : [];
  }
  const text =
    readTextContent(update.content) ??
    readTextContent(update.message) ??
    readTextContent(update.output);
  const toolCall = asRecord(update.toolCall);
  const title =
    typeof update.title === 'string'
      ? update.title
      : typeof toolCall?.title === 'string'
        ? toolCall.title
        : undefined;
  const status =
    typeof update.status === 'string'
      ? update.status
      : typeof toolCall?.status === 'string'
        ? toolCall.status
        : undefined;

  if (
    sessionUpdate.includes('thought') ||
    sessionUpdate.includes('thinking') ||
    sessionUpdate === 'agent_message_chunk'
  ) {
    return text ? [{ kind: 'thinking', title: 'Thinking', text }] : [];
  }
  if (
    sessionUpdate === 'tool_call' ||
    sessionUpdate === 'tool_call_update' ||
    sessionUpdate === 'tool_result'
  ) {
    return [
      {
        kind: 'tool',
        title: title ?? (sessionUpdate === 'tool_result' ? 'Result' : 'Tool'),
        ...(text ? { text } : {}),
        ...(status ? { status } : {}),
      },
    ];
  }
  // Only explicit tool updates are tool output. Other ACP prose is agent
  // narration and belongs directly in the readable activity feed.
  if (text) return [{ kind: 'thinking', title: 'Thinking', text }];

  // Metadata-only session updates should not become empty JSON chat bubbles.
  return [];
}

export function agentActivityText(content: string): string {
  return agentActivityDetails(content)
    .map((item) => item.text ?? [item.title, item.status].filter(Boolean).join(' · '))
    .filter(Boolean)
    .join('\n');
}

/** Preserve raw Nostr tags because the branch-loop UI projects lifecycle from them. */
export function toRigEvent(ev: BuzzSessionEvent): SessionEvent {
  if (ev.kind === 'agent-activity') {
    const activity = agentActivityDetails(ev.content);
    return {
      type: 'assistant_delta',
      sessionId: ev.channelId,
      id: ev.id,
      text: agentActivityText(ev.content),
      seq: ev.createdAt,
      pubkey: ev.pubkey,
      activity,
    };
  }
  if (ev.kind === 'message') {
    return {
      type: 'raw',
      sessionId: ev.channelId,
      payload: {
        id: ev.id,
        content: ev.content,
        pubkey: ev.pubkey,
        createdAt: ev.createdAt,
        tags: ev.event.tags,
      },
    };
  }
  return {
    type: 'raw',
    sessionId: ev.channelId,
    payload: ev.event,
  };
}

export type AgentTurnStatus = 'working' | 'complete' | 'failed';

export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  /** True when the relay message is explicitly projected as an Agent answer. */
  isAgentAuthor?: boolean;
  isAgentActivity?: boolean;
  /**
   * True only while this bubble holds an in-flight `#t=agent-draft` stream,
   * not yet reconciled with the turn's final `agent-message`. Cleared the
   * moment the final reply lands (same `id`, see `agent-draft-${requestId}`).
   */
  isAgentDraft?: boolean;
  /**
   * The real relay event id, when it differs from `id`. A reconciled draft
   * bubble keeps a stable `agent-draft-${requestId}` display id across the
   * provisional → final transition, so reply-threading (which must target a
   * real signed event) reads this instead of `id`.
   */
  relayId?: string;
  activity?: AgentActivityItem[];
  attachments?: AttachmentReference[];
  /** NIP-10 event id of the message this conversational message replies to. */
  replyToId?: string;
  isNew?: boolean;
  corner?: {
    subchannelId: string;
    agentPubkey?: string;
    status: CornerStatus;
  };
  agentTurn?: {
    requestId: string;
    agentPubkey: string;
    status: AgentTurnStatus;
    generationId?: string;
  };
  writePermission?: {
    permissionId: string;
    requestId: string;
    agentPubkey: string;
    tool: string;
    repository?: string;
    status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    subchannelId?: string;
  };
};

export type ChatEventProjection = {
  message?: ChatDisplayMessage;
  mergeTarget?: MergeTarget;
  clearMergeTarget?: boolean;
  archiveChannel?: boolean;
  /** A durable relay publish for this corner's own approved-merge delivery
   *  (push, land, or merge-gate attempt) failed or could not be confirmed.
   *  Lets the approve button stop showing a stale "sent" state while nothing
   *  is actually landing — see `apps/body/src/body.ts`'s corner-scoped
   *  `status=failed` body-control messages (no `subchannel` tag, since those
   *  are posted directly on this corner's own channel, not a parent Room
   *  status card). */
  deliveryFailed?: boolean;
  agentPresence?: AgentPresence;
};

export function sessionEventPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' ? asRecord(event.payload) : undefined;
}

export function sessionEventTags(event: SessionEvent): string[][] {
  const tags = sessionEventPayload(event)?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
      )
    : [];
}

export function sessionEventTagValue(event: SessionEvent, name: string): string | undefined {
  return sessionEventTags(event).find((tag) => tag[0] === name)?.[1];
}

export function sessionEventHasTag(event: SessionEvent, name: string, value?: string): boolean {
  return sessionEventTags(event).some(
    (tag) => tag[0] === name && (value === undefined || tag[1] === value),
  );
}

function eventText(event: SessionEvent): string {
  if (event.type === 'assistant_delta') return event.text;
  const content = sessionEventPayload(event)?.content;
  return typeof content === 'string' ? content : '';
}

function eventPubkey(event: SessionEvent): string | undefined {
  if (event.type === 'assistant_delta') return event.pubkey;
  const pubkey = sessionEventPayload(event)?.pubkey;
  return typeof pubkey === 'string' ? pubkey : undefined;
}

function eventActivity(event: SessionEvent): AgentActivityItem[] | undefined {
  return event.type === 'assistant_delta' ? event.activity : undefined;
}

function eventTimestamp(event: SessionEvent): number {
  if (event.type === 'assistant_delta' && event.seq) return event.seq;
  const createdAt = sessionEventPayload(event)?.createdAt;
  return typeof createdAt === 'number' ? createdAt : Date.now();
}

function eventId(event: SessionEvent): string {
  if (event.type === 'assistant_delta' && event.id) return event.id;
  const id = sessionEventPayload(event)?.id;
  if (typeof id === 'string') return id;
  return `${event.type}-${eventTimestamp(event)}-${eventText(event).slice(0, 32)}`;
}

function cornerStatus(event: SessionEvent): CornerStatus | undefined {
  return mapRawCornerStatusTag(sessionEventTagValue(event, 'display-status') ?? sessionEventTagValue(event, 'status'));
}

/** One display projection for both initial backfill and live subscription events. */
export function projectChatEvent(
  event: SessionEvent,
  viewerPubkey: string,
  isNew = false,
): ChatEventProjection {
  const agentPresence = agentPresenceFromSessionEvent(event);
  if (agentPresence) return { agentPresence };
  // The streaming reply draft projects straight into the transcript as a
  // provisional bubble at the turn's stable id, so it fills in place and the
  // eventual final `agent-message` (matched by NIP-10 reply-to below) can
  // reconcile onto that same id instead of appearing as a second bubble.
  const agentDraft = agentDraftFromSessionEvent(event);
  if (agentDraft) {
    if (!agentDraft.text.trim()) return {};
    return {
      message: {
        id: `agent-draft-${agentDraft.requestId}`,
        text: agentDraft.text,
        isUser: false,
        timestamp: Math.floor(agentDraft.observedAt / 1_000),
        pubkey: agentDraft.agentPubkey,
        isAgentAuthor: true,
        isAgentDraft: true,
      },
    };
  }
  const text = eventText(event);
  const pubkey = eventPubkey(event);
  const subchannelId = sessionEventTagValue(event, 'subchannel');
  const bodyControl = sessionEventHasTag(event, 't', 'body-control') || Boolean(subchannelId);
  const status = cornerStatus(event);
  const isMergeSummary = sessionEventHasTag(event, 't', 'merge-summary');
  const isArchived = sessionEventHasTag(event, 'status', 'archived');
  // A corner's own delivery-failure notices (push/land/merge-gate failures)
  // are posted directly on the corner's own channel with no `subchannel`
  // tag — distinct from a `subchannel && status` parent-Room status card
  // (checked first below) and from the archive notice above.
  const isDeliveryFailure = bodyControl && !subchannelId && sessionEventHasTag(event, 'status', 'failed');
  const repo = sessionEventTagValue(event, 'repo');
  const branch = sessionEventTagValue(event, 'branch');
  const tip = sessionEventTagValue(event, 'tip');
  const mergeTarget =
    sessionEventHasTag(event, 't', 'merge-ready') && repo && branch && tip
      ? { repo, branch, tip }
      : undefined;
  const permissionId = sessionEventTagValue(event, 'permission');
  const permissionRequestId = sessionEventTagValue(event, 'request');
  const permissionAgent = sessionEventTagValue(event, 'agent') ?? sessionEventTagValue(event, 'p');
  const isPermissionRequest = sessionEventHasTag(event, 't', 'buzz-write-permission-request');
  const isPermissionResponse = sessionEventHasTag(event, 't', 'buzz-write-permission-response');
  const isAgentTurn = sessionEventHasTag(event, 't', 'agent-turn');
  const attachments = parseAttachmentTags(sessionEventTags(event));
  const replyToId = sessionEventTags(event).find(
    (tag) => tag[0] === 'e' && tag[1] && tag[3] === 'reply',
  )?.[1];

  if (isAgentTurn) {
    const requestId = sessionEventTagValue(event, 'request');
    const agentPubkey = sessionEventTagValue(event, 'agent') ?? pubkey;
    const turnStatus = sessionEventTagValue(event, 'status');
    const generationId = sessionEventTagValue(event, 'generation');
    if (
      requestId &&
      agentPubkey &&
      (turnStatus === 'working' || turnStatus === 'complete' || turnStatus === 'failed')
    ) {
      return {
        message: {
          id: `agent-turn-${requestId}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          pubkey: agentPubkey,
          agentTurn: {
            requestId,
            agentPubkey,
            status: turnStatus,
            ...(generationId ? { generationId } : {}),
          },
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    return {};
  }

  // A response is proposed human intent. Body verifies current membership and
  // human identity, then emits the authoritative request-status projection.
  if (isPermissionResponse) return {};

  if (permissionId && permissionRequestId && permissionAgent && isPermissionRequest) {
    const wireStatus = sessionEventTagValue(event, 'status');
    const status =
      wireStatus === 'allowed'
        ? 'allowed'
        : wireStatus === 'denied'
          ? 'denied'
          : wireStatus === 'expired'
            ? 'expired'
            : wireStatus === 'failed'
              ? 'failed'
              : 'pending';
    return {
      message: {
        id: `write-permission-${permissionId}`,
        text,
        isUser: false,
        timestamp: eventTimestamp(event),
        ...(pubkey ? { pubkey } : {}),
        writePermission: {
          permissionId,
          requestId: permissionRequestId,
          agentPubkey: permissionAgent,
          tool: sessionEventTagValue(event, 'tool') ?? 'edit files',
          ...(repo ? { repository: repo } : {}),
          status,
          ...(subchannelId ? { subchannelId } : {}),
        },
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }
  if (
    sessionEventHasTag(event, 't', 'change-review-manifest') ||
    sessionEventHasTag(event, 't', 'change-review-file')
  ) {
    return {};
  }
  if (event.type === 'assistant_delta' && !text.trim()) return {};

  if (isMergeSummary) {
    return {
      ...(mergeTarget ? { mergeTarget } : {}),
      message: {
        id: eventId(event),
        text,
        isUser: false,
        timestamp: eventTimestamp(event),
        ...(pubkey ? { pubkey } : {}),
        isMergeSummary: true,
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }

  if (bodyControl) {
    const clearMergeTarget = sessionEventHasTag(event, 't', 'merge-not-ready');
    if (subchannelId && status) {
      return {
        ...(mergeTarget ? { mergeTarget } : {}),
        ...(clearMergeTarget ? { clearMergeTarget: true } : {}),
        message: {
          id: `corner-${subchannelId}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          corner: {
            subchannelId,
            agentPubkey: sessionEventTagValue(event, 'agent') ?? pubkey,
            status,
          },
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (isArchived && !subchannelId) {
      return {
        archiveChannel: true,
        message: {
          id: eventId(event),
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          isArchivedNotice: true,
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    if (isDeliveryFailure) {
      // Previously dropped entirely (no `message`) — the relay durably had
      // the failure but the transcript never showed it and the approve
      // button never learned about it either.
      return {
        ...(mergeTarget ? { mergeTarget } : {}),
        deliveryFailed: true,
        message: {
          id: eventId(event),
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          ...(isNew ? { isNew: true } : {}),
        },
      };
    }
    return {
      ...(mergeTarget ? { mergeTarget } : {}),
      ...(clearMergeTarget ? { clearMergeTarget: true } : {}),
      ...(isArchived && !subchannelId ? { archiveChannel: true } : {}),
    };
  }

  // A Room/DM turn's final reply always answers the human's own request
  // event (`replyTo`), the same id Body threads as the draft/turn `request`
  // tag. Reconcile onto the draft's stable bubble id so the final text
  // updates the SAME on-screen bubble in place rather than appending a new
  // one — the raw relay event id survives in `relayId` so reply-threading
  // (which must reference a real signed event) keeps working.
  const isAgentMessage = sessionEventHasTag(event, 't', 'agent-message');
  const relayId = eventId(event);
  const reconciledId = isAgentMessage && replyToId ? `agent-draft-${replyToId}` : undefined;

  return {
    ...(mergeTarget ? { mergeTarget } : {}),
    message: {
      id: reconciledId ?? relayId,
      ...(reconciledId ? { relayId } : {}),
      text,
      isUser: pubkey === viewerPubkey,
      timestamp: eventTimestamp(event),
      ...(pubkey ? { pubkey } : {}),
      ...(isAgentMessage ? { isAgentAuthor: true } : {}),
      ...(event.type === 'assistant_delta' ? { isAgentActivity: true } : {}),
      ...(eventActivity(event)?.length ? { activity: eventActivity(event) } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(replyToId ? { replyToId } : {}),
      ...(isNew ? { isNew: true } : {}),
    },
  };
}

/** Rooms show conversation plus one compact Corner card; telemetry stays in Corners. */
export function transcriptMessages(
  messages: ChatDisplayMessage[],
  isCorner: boolean,
): ChatDisplayMessage[] {
  if (isCorner) {
    const transcript: ChatDisplayMessage[] = [];
    let activityRunOpen = false;
    for (const message of messages) {
      // Lifecycle is presentation state, not a blank conversational message,
      // but it remains a hard turn boundary for the activity on either side.
      if (message.agentTurn) {
        activityRunOpen = false;
        continue;
      }

      if (message.isAgentActivity) {
        if (!message.activity?.length) {
          activityRunOpen = false;
          continue;
        }
        const previous = transcript.at(-1);
        if (activityRunOpen && previous?.isAgentActivity) {
          previous.activity = [...(previous.activity ?? []), ...message.activity];
          // Keep the first event id stable while the live run grows. Never join
          // prose here: final messages and user messages remain hard boundaries.
          continue;
        }
        activityRunOpen = true;
      } else {
        activityRunOpen = false;
      }
      transcript.push({
        ...message,
        ...(message.activity ? { activity: [...message.activity] } : {}),
      });
    }
    return transcript;
  }
  return messages.filter(
    (message) =>
      Boolean(message.corner) ||
      (!message.agentTurn &&
        !message.isAgentActivity &&
        !message.isMergeSummary &&
        !message.isArchivedNotice),
  );
}

const AGENT_TURN_STATUS_ORDER: Record<AgentTurnStatus, number> = {
  working: 0,
  complete: 1,
  failed: 1,
};

const WRITE_PERMISSION_STATUS_ORDER: Record<
  NonNullable<ChatDisplayMessage['writePermission']>['status'],
  number
> = {
  pending: 0,
  allowed: 1,
  denied: 1,
  expired: 1,
  failed: 2,
};

/** Stable-id upsert keeps lifecycle cards monotonic across replay order. */
export function upsertChatMessages(
  current: ChatDisplayMessage[],
  incoming: ChatDisplayMessage[],
): ChatDisplayMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (let message of incoming) {
    const existing = byId.get(message.id);
    // The draft stream and the final `agent-message` arrive over independent
    // relay subscriptions with no ordering guarantee between them. Once a
    // bubble has been finalized, a late-delivered draft flush for the same
    // request must never regress it back to provisional streaming text.
    if (existing && !existing.isAgentDraft && message.isAgentDraft) {
      continue;
    }
    if (
      existing?.corner &&
      message.corner &&
      cornerStatusPrecedence(message.corner.status) < cornerStatusPrecedence(existing.corner.status)
    ) {
      continue;
    }
    if (
      existing?.agentTurn &&
      message.agentTurn &&
      AGENT_TURN_STATUS_ORDER[message.agentTurn.status] <
        AGENT_TURN_STATUS_ORDER[existing.agentTurn.status]
    ) {
      continue;
    }
    if (existing?.writePermission && message.writePermission) {
      if (
        WRITE_PERMISSION_STATUS_ORDER[message.writePermission.status] <
        WRITE_PERMISSION_STATUS_ORDER[existing.writePermission.status]
      ) {
        continue;
      }
      message = {
        ...message,
        writePermission: {
          ...message.writePermission,
          tool:
            message.writePermission.tool === 'edit files'
              ? existing.writePermission.tool
              : message.writePermission.tool,
          subchannelId:
            message.writePermission.subchannelId ?? existing.writePermission.subchannelId,
        },
      };
    }
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}
