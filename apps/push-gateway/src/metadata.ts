import {
  KIND_AGENT_SOUL,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_PERSON_PROFILE,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
  TAG_PERSON_PROFILE,
  parseAgent,
  parseAgentSoul,
  resolveAgentName,
} from '@beeline/buzz-client';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { NotificationContext } from './mapping.js';

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 512;

export interface RelayEventReader {
  query(filters: Record<string, unknown>[]): Promise<NostrEvent[]>;
  disconnect(): void;
}

interface RoomMetadata {
  roomName: string;
  communityId?: string;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function tagValues(event: NostrEvent, name: string): string[] {
  return event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1]!);
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized ? [...normalized].slice(0, 80).join('') : undefined;
}

function latest(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort(
    (left, right) => right.created_at - left.created_at || right.id.localeCompare(left.id),
  )[0];
}

function jsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function currentCommunityMembers(events: NostrEvent[], communityId: string): Set<string> {
  const members = new Set<string>();
  for (const kind of [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS]) {
    const projection = latest(
      events.filter(
        (event) =>
          event.kind === kind &&
          (tagValue(event, 'd') === communityId || tagValue(event, 'h') === communityId),
      ),
    );
    for (const tag of projection?.tags ?? []) {
      if (tag[0] === 'p' && tag[1]) members.add(tag[1]);
    }
  }
  return members;
}

function personName(
  events: NostrEvent[],
  pubkey: string,
  communityId?: string,
): string | undefined {
  const communityProfile = latest(
    events.filter(
      (event) =>
        event.kind === KIND_PERSON_PROFILE &&
        event.pubkey === pubkey &&
        verifyEvent(event) &&
        tagValues(event, 't').includes(TAG_PERSON_PROFILE) &&
        (!communityId || tagValue(event, TAG_COMMUNITY) === communityId),
    ),
  );
  const communityContent = communityProfile ? jsonObject(communityProfile.content) : undefined;
  const communityName = cleanName(communityContent?.displayName ?? communityContent?.name);
  if (communityName) return communityName;

  const nipProfile = latest(
    events.filter((event) => event.kind === 0 && event.pubkey === pubkey && verifyEvent(event)),
  );
  const nipContent = nipProfile ? jsonObject(nipProfile.content) : undefined;
  return cleanName(nipContent?.display_name ?? nipContent?.name);
}

/** Cached, recipient-authorized relay metadata used only for notification presentation. */
export class NotificationMetadataResolver {
  private readonly rooms = new Map<string, CacheEntry<RoomMetadata>>();
  private readonly senders = new Map<string, CacheEntry<string | undefined>>();

  constructor(
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** A verified soul update makes any cached sender presentation stale immediately. */
  invalidate(event: NostrEvent): void {
    const soul = parseAgentSoul(event);
    if (!soul) return;
    this.senders.delete(`${soul.communityId}:${soul.agentPubkey}`);
  }

  async resolve(event: NostrEvent, reader: RelayEventReader): Promise<NotificationContext> {
    const channelId = tagValue(event, 'h');
    if (!channelId) return { roomName: 'Room' };
    const room = await this.cached(this.rooms, channelId, () => this.loadRoom(channelId, reader));
    const senderKey = `${room.communityId ?? ''}:${event.pubkey}`;
    const senderName = await this.cached(this.senders, senderKey, () =>
      this.loadSender(event.pubkey, room.communityId, reader),
    );
    return { roomName: room.roomName, ...(senderName ? { senderName } : {}) };
  }

  private async loadRoom(channelId: string, reader: RelayEventReader): Promise<RoomMetadata> {
    const events = await reader.query([
      { kinds: [KIND_CHANNEL_METADATA], '#d': [channelId], limit: 5 },
      { kinds: [KIND_CHANNEL_METADATA], '#h': [channelId], limit: 5 },
      { kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 },
    ]);
    const metadata = latest(events.filter((event) => event.kind === KIND_CHANNEL_METADATA));
    const creation = latest(events.filter((event) => event.kind === KIND_CREATE_GROUP));
    const roomName =
      cleanName(metadata ? tagValue(metadata, 'name') : undefined) ??
      cleanName(creation ? tagValue(creation, 'name') : undefined) ??
      'Room';
    const communityId =
      (metadata ? tagValue(metadata, TAG_COMMUNITY) : undefined) ??
      (creation ? tagValue(creation, TAG_COMMUNITY) : undefined);
    return { roomName, ...(communityId ? { communityId } : {}) };
  }

  private async loadSender(
    pubkey: string,
    communityId: string | undefined,
    reader: RelayEventReader,
  ): Promise<string | undefined> {
    const filters: Record<string, unknown>[] = [
      { kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 },
      { kinds: [0], authors: [pubkey], limit: 5 },
    ];
    if (communityId) {
      filters.push(
        { kinds: [KIND_AGENT_SOUL], '#d': [`${communityId}:${pubkey}`], limit: 20 },
        {
          kinds: [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS],
          '#d': [communityId],
          limit: 10,
        },
        {
          kinds: [KIND_STREAM_MESSAGE],
          '#h': [communityId],
          '#t': [TAG_AGENT],
          limit: 200,
        },
      );
    }
    const events = await reader.query(filters);
    const agentRecords = events
      .map((event) => parseAgent(event))
      .filter((agent): agent is NonNullable<typeof agent> => agent?.pubkey === pubkey)
      .sort((left, right) => right.createdAt - left.createdAt);
    const agent = agentRecords[0];
    if (agent) {
      const communityMembers = communityId
        ? currentCommunityMembers(events, communityId)
        : new Set<string>();
      const agentAuthors = new Set(
        events
          .map((event) => parseAgent(event))
          .filter((record): record is NonNullable<typeof record> => record !== null)
          .map((record) => record.pubkey),
      );
      const soul = latest(
        events.filter((event) => {
          const profile = parseAgentSoul(event);
          return Boolean(
            profile &&
            profile.agentPubkey === pubkey &&
            (!communityId ||
              (profile.communityId === communityId &&
                communityMembers.has(profile.authoredBy) &&
                !agentAuthors.has(profile.authoredBy))),
          );
        }),
      );
      const soulProfile = soul ? parseAgentSoul(soul) : null;
      return resolveAgentName(soulProfile?.name ?? agent.displayName, pubkey);
    }
    return personName(events, pubkey, communityId);
  }

  private cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const existing = cache.get(key);
    if (existing && existing.expiresAt > this.now()) return existing.value;
    if (existing) cache.delete(key);

    let value: Promise<T>;
    value = load().catch((error) => {
      if (cache.get(key)?.value === value) cache.delete(key);
      throw error;
    });
    cache.set(key, { expiresAt: this.now() + this.cacheTtlMs, value });
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey) cache.delete(oldestKey);
    }
    return value;
  }
}
