import type { SessionEvent } from './rig-transport';
import type { MergeTarget, SessionEvent as BuzzSessionEvent } from '@beeline/buzz-client';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
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
export function agentActivityText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content;
  }

  if (typeof parsed === 'string') return parsed;
  const envelope = asRecord(parsed);
  if (!envelope) return '';
  const update = asRecord(envelope.update);
  if (!update) return readTextContent(envelope.content) ?? '';

  if (update.sessionUpdate === 'activity_batch' && Array.isArray(update.updates)) {
    return update.updates
      .map((item) => agentActivityText(JSON.stringify({ update: item })))
      .filter(Boolean)
      .join('\n');
  }

  const text = readTextContent(update.content)
    ?? readTextContent(update.message)
    ?? readTextContent(update.output);
  if (text) return text;

  // Keep tool progress legible when ACP sends no content block.
  const toolCall = asRecord(update.toolCall);
  const title = typeof update.title === 'string'
    ? update.title
    : typeof toolCall?.title === 'string' ? toolCall.title : undefined;
  const status = typeof update.status === 'string'
    ? update.status
    : typeof toolCall?.status === 'string' ? toolCall.status : undefined;
  if (title || status) return [title ?? 'tool', status].filter(Boolean).join(' · ');

  // Metadata-only session updates should not become empty JSON chat bubbles.
  return '';
}

/** Preserve raw Nostr tags because the branch-loop UI projects lifecycle from them. */
export function toRigEvent(ev: BuzzSessionEvent): SessionEvent {
  if (ev.kind === 'agent-activity') {
    return {
      type: 'assistant_delta',
      sessionId: ev.channelId,
      id: ev.id,
      text: agentActivityText(ev.content),
      seq: ev.createdAt,
      pubkey: ev.pubkey,
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

export type CornerCardStatus =
  | 'starting'
  | 'working'
  | 'needs-attention'
  | 'ready'
  | 'failed';

export type ChatDisplayMessage = {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: number;
  pubkey?: string;
  isMergeSummary?: boolean;
  isArchivedNotice?: boolean;
  isAgentActivity?: boolean;
  isNew?: boolean;
  corner?: {
    subchannelId: string;
    agentPubkey?: string;
    status: CornerCardStatus;
  };
};

export type ChatEventProjection = {
  message?: ChatDisplayMessage;
  mergeTarget?: MergeTarget;
  archiveChannel?: boolean;
};

function eventPayload(event: SessionEvent): UnknownRecord | undefined {
  return event.type === 'raw' ? asRecord(event.payload) : undefined;
}

function eventTags(event: SessionEvent): string[][] {
  const tags = eventPayload(event)?.tags;
  return Array.isArray(tags)
    ? tags.filter(
        (tag): tag is string[] => Array.isArray(tag) && tag.every((value) => typeof value === 'string'),
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
  const status = eventTagValue(event, 'status');
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
  const mergeTarget = eventHasTag(event, 't', 'merge-ready') && repo && branch && tip
    ? { repo, branch, tip }
    : undefined;

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
      ...(isNew ? { isNew: true } : {}),
    },
  };
}

const CORNER_STATUS_ORDER: Record<CornerCardStatus, number> = {
  starting: 0,
  working: 1,
  'needs-attention': 2,
  ready: 3,
  failed: 4,
};

/** Stable-id upsert keeps lifecycle cards monotonic across replay order. */
export function upsertChatMessages(
  current: ChatDisplayMessage[],
  incoming: ChatDisplayMessage[],
): ChatDisplayMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (
      existing?.corner &&
      message.corner &&
      CORNER_STATUS_ORDER[message.corner.status] < CORNER_STATUS_ORDER[existing.corner.status]
    ) {
      continue;
    }
    byId.set(message.id, message);
  }
  return [...byId.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );
}
