import { isRetiredAgentNotice } from '@beeline/buzz-client';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function keepMessage(value: unknown): boolean {
  return !isRecord(value) || typeof value.text !== 'string' || !isRetiredAgentNotice(value.text);
}

function withoutRetiredMessages(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.filter(keepMessage);
  return kept.length === value.length ? value : kept;
}

function withoutRetiredPreview(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.latestMessage) || keepMessage(value.latestMessage)) {
    return value;
  }
  const { latestMessage: _retired, ...kept } = value;
  return kept;
}

/**
 * Removes retired daemon prose from an already-persisted server response.
 * Fresh responses are filtered by the server indexer; this cache floor keeps
 * an OTA from painting old rows before that first revalidation completes.
 */
export function stripRetiredAgentNotices<T>(surface: T): T {
  if (!isRecord(surface)) return surface;
  let next: Record<string, unknown> | undefined;
  const replace = (key: string, value: unknown) => {
    if (value === surface[key]) return;
    next ??= { ...surface };
    next[key] = value;
  };

  replace('messages', withoutRetiredMessages(surface.messages));
  replace('briefing', withoutRetiredMessages(surface.briefing));

  const storedChats = surface.chats;
  if (Array.isArray(storedChats)) {
    const chats = storedChats.map(withoutRetiredPreview);
    if (chats.some((chat, index) => chat !== storedChats[index])) replace('chats', chats);
  }
  const storedCorners = surface.corners;
  if (Array.isArray(storedCorners)) {
    const corners = storedCorners.map(withoutRetiredPreview);
    if (corners.some((corner, index) => corner !== storedCorners[index])) {
      replace('corners', corners);
    }
  }
  return (next ?? surface) as T;
}
