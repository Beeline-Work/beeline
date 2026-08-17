import type { SessionEvent } from '@/sync/transport';
import { sessionEventHasTag, sessionEventPayload } from '@/sync/transport/buzz-event-projection';

const CONTROL_TEXT = /^Agent opened(?: #| a work branch for:)/;

export type RoomMessageSummary = {
  id: string;
  text: string;
  timestamp: number;
};

function roomMessage(event: SessionEvent): RoomMessageSummary | null {
  const payload = sessionEventPayload(event);
  if (!payload || typeof payload.content !== 'string') return null;
  if (sessionEventHasTag(event, 't', 'body-control') || sessionEventHasTag(event, 'subchannel')) {
    return null;
  }

  const text = payload.content.trim();
  if (!text || CONTROL_TEXT.test(text)) return null;
  return {
    id: typeof payload.id === 'string' ? payload.id : '',
    text,
    timestamp: typeof payload.createdAt === 'number' ? payload.createdAt : 0,
  };
}

/** Latest person-facing Room message, excluding Corner control and activity events. */
export function latestRoomMessageSummary(events: SessionEvent[]): RoomMessageSummary | null {
  const messages = events
    .map(roomMessage)
    .filter((message): message is RoomMessageSummary => Boolean(message))
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
  return messages[0] ?? null;
}

export function latestRoomMessage(events: SessionEvent[]): string | null {
  return latestRoomMessageSummary(events)?.text ?? null;
}
