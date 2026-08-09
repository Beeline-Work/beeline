import type { NostrEvent } from '@buzzy/nostr';
import { TAG_AGENT_ACTIVITY, TAG_COMMUNITY, TAG_PARENT } from './kinds.js';
import type { ChannelMember, ChannelMetadata, SessionEvent, SessionEventKind } from './types.js';

/** First value of tag `name`, if any. */
export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/** All values for repeated tags of `name`. */
export function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((t) => t[0] === name && t[1]).map((t) => t[1]!);
}

/** Channel UUID from the `h` tag (Buzz requires UUID; non-UUIDs are dropped). */
export function channelIdOf(event: NostrEvent): string | undefined {
  return tagValue(event, 'h');
}

/** True when the event is a body-projected agent-activity frame. */
export function isAgentActivity(event: NostrEvent): boolean {
  return tagValues(event, 't').includes(TAG_AGENT_ACTIVITY);
}

/** Classify a kind:9 (or other) event for the session surface. */
export function classifySessionEvent(event: NostrEvent): SessionEventKind {
  if (isAgentActivity(event)) return 'agent-activity';
  if (event.kind === 9) return 'message';
  return 'other';
}

/** Project a raw Nostr event into a SessionEvent (requires `h` channel tag). */
export function toSessionEvent(event: NostrEvent): SessionEvent | null {
  const channelId = channelIdOf(event);
  if (!channelId) return null;
  return {
    kind: classifySessionEvent(event),
    event,
    channelId,
    content: event.content,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    id: event.id,
  };
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

/** Best-effort metadata parse from kind:39000. */
export function parseMetadataEvent(event: NostrEvent): ChannelMetadata {
  const channelId = tagValue(event, 'd') ?? tagValue(event, 'h') ?? '';
  const name = tagValue(event, 'name');
  const about = tagValue(event, 'about') ?? (event.content || undefined);
  const archivedRaw = tagValue(event, 'archived');
  const archived =
    archivedRaw === 'true' || archivedRaw === '1'
      ? true
      : archivedRaw === 'false' || archivedRaw === '0'
        ? false
        : undefined;
  const parentChannelId = tagValue(event, TAG_PARENT);
  const communityId = tagValue(event, TAG_COMMUNITY);
  return {
    channelId,
    ...(name !== undefined ? { name } : {}),
    ...(about !== undefined ? { about } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(parentChannelId !== undefined ? { parentChannelId } : {}),
    ...(communityId !== undefined ? { communityId } : {}),
    raw: event,
  };
}

/** Sort events oldest-first by created_at, then id for stability. */
export function sortEventsChronological(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
