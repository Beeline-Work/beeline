import type { NostrEvent } from '@beeline/nostr';

/**
 * Gate for the room outbox's one unsigned-event allowance: kind:9 monolith room
 * messages are authored locally with a precomputed id and delivered through the
 * server-indexed surface, so they may bypass client signing.
 */
export function isUnsignedMonolithMessage(event: NostrEvent): boolean {
  if (event.kind !== 9 || event.sig !== '' || !/^[0-9a-f]{64}$/.test(event.id)) return false;
  const tagNames = new Set(event.tags.map((tag) => tag[0]));
  return (
    event.tags.some((tag) => tag[0] === 'h' && Boolean(tag[1])) &&
    tagNames.has('monolith-attachments') &&
    tagNames.has('monolith-mentions')
  );
}
