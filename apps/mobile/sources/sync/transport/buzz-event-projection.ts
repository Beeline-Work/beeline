import type { SessionEvent } from './rig-transport';
import type { SessionEvent as BuzzSessionEvent } from '@beeline/buzz-client';

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
