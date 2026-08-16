import type { SessionEvent } from '@/sync/transport';

const CONTROL_TEXT = /^Agent opened(?: #| a work branch for:)/;

function rawPayload(event: SessionEvent): Record<string, unknown> | undefined {
  if (event.type !== 'raw' || !event.payload || typeof event.payload !== 'object') return undefined;
  return event.payload as Record<string, unknown>;
}

function hasTag(payload: Record<string, unknown>, name: string, value?: string): boolean {
  if (!Array.isArray(payload.tags)) return false;
  return payload.tags.some((candidate) => {
    if (!Array.isArray(candidate) || candidate[0] !== name) return false;
    return value === undefined || candidate[1] === value;
  });
}

export type RoomMessageSummary = {
  id: string;
  text: string;
  timestamp: number;
};

function roomMessage(event: SessionEvent): RoomMessageSummary | null {
  const payload = rawPayload(event);
  if (!payload || typeof payload.content !== 'string') return null;
  if (hasTag(payload, 't', 'body-control') || hasTag(payload, 'subchannel')) return null;

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
