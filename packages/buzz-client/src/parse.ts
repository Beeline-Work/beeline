import type { NostrEvent } from '@beeline/nostr';
import { TAG_COMMUNITY, TAG_PARENT } from './kinds.js';
import type { ChannelMember, ChannelMetadata } from './types.js';

/** First value of tag `name`, if any. */
export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** Channel UUID from the `h` tag (Buzz requires UUID; non-UUIDs are dropped). */
export function channelIdOf(event: NostrEvent): string | undefined {
  return tagValue(event, 'h');
}

/**
 * Parse kind:39002 members list.
 * Tags are typically `["p", <pubkey>]` (and possibly role as separate history).
 */
export function parseMembersEvent(event: NostrEvent): ChannelMember[] {
  const members: ChannelMember[] = [];
  for (const t of event.tags) {
    if (t[0] === 'p' && t[1]) {
      // NIP-29 sometimes puts role in p[2]; Buzz uses separate role tags on 9000.
      // Prefer p[2] if present for display only.
      const role = t[2];
      members.push(role ? { pubkey: t[1], role } : { pubkey: t[1] });
    }
  }
  return members;
}

/** Sort events oldest-first by created_at, then id for stability. */
export function sortEventsChronological(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
