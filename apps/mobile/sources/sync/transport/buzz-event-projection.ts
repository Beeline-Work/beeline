import type { AgentActivityItem, SessionEvent } from './rig-transport';
import {
  parseAttachmentTags,
  type AttachmentReference,
  type AgentPresence,
  type MergeTarget,
  type SessionEvent as BuzzSessionEvent,
} from '@beeline/buzz-client';
import { agentPresenceFromSessionEvent } from '@/buzz/agent-presence';

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

  if (sessionUpdate.includes('thought') || sessionUpdate.includes('thinking')) {
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
  if (text) return [{ kind: 'output', title: 'Output', text }];

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

export type CornerCardStatus = 'starting' | 'working' | 'needs-attention' | 'ready' | 'failed';
export type AgentTurnStatus = 'working' | 'complete' | 'failed';

export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  isAgentActivity?: boolean;
  activity?: AgentActivityItem[];
  attachments?: AttachmentReference[];
  isNew?: boolean;
  corner?: {
    subchannelId: string;
    agentPubkey?: string;
    status: CornerCardStatus;
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
    status: 'pending' | 'allowed' | 'denied' | 'expired' | 'failed';
    subchannelId?: string;
  };
};

export type ChatEventProjection = {
  message?: ChatDisplayMessage;
  mergeTarget?: MergeTarget;
  archiveChannel?: boolean;
  agentPresence?: AgentPresence;
};

function eventPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' ? asRecord(event.payload) : undefined;
}

function eventTags(event: SessionEvent): string[][] {
  const tags = eventPayload(event)?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string[] =>
          Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
      )
    : [];
}

function eventTagValue(event: SessionEvent, name: string): string | undefined {
  return eventTags(event).find((tag) => tag[0] === name)?.[1];
}

function eventHasTag(event: SessionEvent, name: string, value?: string): boolean {
  return eventTags(event).some(
    (tag) => tag[0] === name && (value === undefined || tag[1] === value),
  );
}

function eventText(event: SessionEvent): string {
  if (event.type === 'assistant_delta') return event.text;
  const content = eventPayload(event)?.content;
  return typeof content === 'string' ? content : '';
}

function eventPubkey(event: SessionEvent): string | undefined {
  if (event.type === 'assistant_delta') return event.pubkey;
  const pubkey = eventPayload(event)?.pubkey;
  return typeof pubkey === 'string' ? pubkey : undefined;
}

function eventActivity(event: SessionEvent): AgentActivityItem[] | undefined {
  return event.type === 'assistant_delta' ? event.activity : undefined;
}

function eventTimestamp(event: SessionEvent): number {
  if (event.type === 'assistant_delta' && event.seq) return event.seq;
  const createdAt = eventPayload(event)?.createdAt;
  return typeof createdAt === 'number' ? createdAt : Date.now();
}

function eventId(event: SessionEvent): string {
  if (event.type === 'assistant_delta' && event.id) return event.id;
  const id = eventPayload(event)?.id;
  if (typeof id === 'string') return id;
  return `${event.type}-${eventTimestamp(event)}-${eventText(event).slice(0, 32)}`;
}

function cornerStatus(event: SessionEvent): CornerCardStatus | undefined {
  const status = eventTagValue(event, 'display-status') ?? eventTagValue(event, 'status');
  if (status === 'starting') return 'starting';
  if (status === 'working' || status === 'open' || status === 'live') return 'working';
  if (status === 'needs-attention') return 'needs-attention';
  if (status === 'ready') return 'ready';
  if (status === 'failed') return 'failed';
  return undefined;
}

/** One display projection for both initial backfill and live subscription events. */
export function projectChatEvent(
  event: SessionEvent,
  viewerPubkey: string,
  isNew = false,
): ChatEventProjection {
  const agentPresence = agentPresenceFromSessionEvent(event);
  if (agentPresence) return { agentPresence };
  const text = eventText(event);
  const pubkey = eventPubkey(event);
  const subchannelId = eventTagValue(event, 'subchannel');
  const bodyControl = eventHasTag(event, 't', 'body-control') || Boolean(subchannelId);
  const status = cornerStatus(event);
  const isMergeSummary = eventHasTag(event, 't', 'merge-summary');
  const isArchived = eventHasTag(event, 'status', 'archived');
  const repo = eventTagValue(event, 'repo');
  const branch = eventTagValue(event, 'branch');
  const tip = eventTagValue(event, 'tip');
  const mergeTarget =
    eventHasTag(event, 't', 'merge-ready') && repo && branch && tip
      ? { repo, branch, tip }
      : undefined;
  const permissionId = eventTagValue(event, 'permission');
  const permissionRequestId = eventTagValue(event, 'request');
  const permissionAgent = eventTagValue(event, 'agent') ?? eventTagValue(event, 'p');
  const isPermissionRequest = eventHasTag(event, 't', 'buzz-write-permission-request');
  const isPermissionResponse = eventHasTag(event, 't', 'buzz-write-permission-response');
  const isAgentTurn = eventHasTag(event, 't', 'agent-turn');
  const attachments = parseAttachmentTags(eventTags(event));

  if (isAgentTurn) {
    const requestId = eventTagValue(event, 'request');
    const agentPubkey = eventTagValue(event, 'agent') ?? pubkey;
    const turnStatus = eventTagValue(event, 'status');
    const generationId = eventTagValue(event, 'generation');
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
    const wireStatus = eventTagValue(event, 'status');
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
          tool: eventTagValue(event, 'tool') ?? 'edit files',
          status,
          ...(subchannelId ? { subchannelId } : {}),
        },
        ...(isNew ? { isNew: true } : {}),
      },
    };
  }
  if (
    eventHasTag(event, 't', 'change-review-manifest') ||
    eventHasTag(event, 't', 'change-review-file')
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
    if (subchannelId && status) {
      return {
        ...(mergeTarget ? { mergeTarget } : {}),
        message: {
          id: `corner-${subchannelId}`,
          text,
          isUser: false,
          timestamp: eventTimestamp(event),
          ...(pubkey ? { pubkey } : {}),
          corner: {
            subchannelId,
            agentPubkey: eventTagValue(event, 'agent') ?? pubkey,
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
    return {
      ...(mergeTarget ? { mergeTarget } : {}),
      ...(isArchived && !subchannelId ? { archiveChannel: true } : {}),
    };
  }

  return {
    ...(mergeTarget ? { mergeTarget } : {}),
    message: {
      id: eventId(event),
      text,
      isUser: pubkey === viewerPubkey,
      timestamp: eventTimestamp(event),
      ...(pubkey ? { pubkey } : {}),
      ...(event.type === 'assistant_delta' ? { isAgentActivity: true } : {}),
      ...(eventActivity(event)?.length ? { activity: eventActivity(event) } : {}),
      ...(attachments.length ? { attachments } : {}),
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

const CORNER_STATUS_ORDER: Record<CornerCardStatus, number> = {
  starting: 0,
  working: 1,
  'needs-attention': 2,
  ready: 3,
  failed: 4,
};

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
    if (
      existing?.corner &&
      message.corner &&
      CORNER_STATUS_ORDER[message.corner.status] < CORNER_STATUS_ORDER[existing.corner.status]
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
