import {
  KIND_AGENT_SOUL,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_PERSON_PROFILE,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PERSON_PROFILE,
  fallbackPersonName,
  parseAgent,
  parseAgentSoul,
  resolveAgentName,
} from '@beeline/buzz-client';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { NotificationContext } from './mapping.js';

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 512;

export interface RelayEventReader {
  /** Stable authorization scope used to keep metadata caches tenant-local. */
  readonly scopeKey?: string;
  query(filters: Record<string, unknown>[]): Promise<NostrEvent[]>;
  /** Bind follow-up metadata reads to the server-stamped scope of one feed event. */
  forEvent?(event: NostrEvent): RelayEventReader;
  disconnect(): void;
}

interface RoomMetadata {
  roomName?: string;
  isDirectMessage: boolean;
  isChildChannel: boolean;
  parentChannelId?: string;
  communityId?: string;
  workspaceName?: string;
  persistentWorkspaceRoom: boolean;
  fixtureCandidates: string[];
  fixtureMarkers: string[];
}

interface CacheEntry<T> {
  expiresAt: number;
  value: Promise<T>;
}

interface SenderPresentation {
  name: string;
  handle?: string;
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

function earliest(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort(
    (left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id),
  )[0];
}

const FIXTURE_MARKERS = new Set([
  'ui-test',
  'ui-demo',
  'uidemo',
  'test-fixture',
]);

function fixtureFields(events: Array<NostrEvent | undefined>): {
  candidates: string[];
  markers: string[];
} {
  const candidates = new Set<string>();
  const markers = new Set<string>();
  for (const event of events) {
    if (!event) continue;
    for (const name of ['name', 'repo-key', 'repo-name']) {
      const value = tagValue(event, name);
      if (value) candidates.add(value);
    }
    for (const tag of event.tags) {
      if (tag[0] === 'fixture') markers.add(`fixture:${tag[1] ?? ''}`);
      if (tag[0] === 't' && tag[1] && FIXTURE_MARKERS.has(tag[1].toLowerCase())) {
        markers.add(tag[1].toLowerCase());
      }
    }
  }
  return { candidates: [...candidates], markers: [...markers] };
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

function personPresentation(
  events: NostrEvent[],
  pubkey: string,
  communityId?: string,
): SenderPresentation | undefined {
  const nipProfile = latest(
    events.filter((event) => event.kind === 0 && event.pubkey === pubkey && verifyEvent(event)),
  );
  const nipContent = nipProfile ? jsonObject(nipProfile.content) : undefined;
  const globalHandle = cleanName(nipContent?.name) ?? cleanName(nipContent?.handle);
  const globalName = cleanName(nipContent?.display_name) ?? globalHandle;
  if (globalName) return { name: globalName, ...(globalHandle ? { handle: globalHandle } : {}) };

  // Older installs may not have migrated their Workspace-scoped profile yet.
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
  const communityHandle = cleanName(communityContent?.handle);
  const communityName = cleanName(communityContent?.displayName ?? communityContent?.name);
  return communityName
    ? { name: communityName, ...(communityHandle ? { handle: communityHandle } : {}) }
    : undefined;
}

/** Cached, recipient-authorized relay metadata used only for notification presentation. */
export class NotificationMetadataResolver {
  private readonly rooms = new Map<string, CacheEntry<RoomMetadata>>();
  private readonly senders = new Map<string, CacheEntry<SenderPresentation>>();

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
    if (!channelId) return {};
    const roomKey = `${reader.scopeKey ?? ''}:${channelId}`;
    const room = await this.cached(this.rooms, roomKey, () => this.loadRoom(channelId, reader));
    const senderKey = `${room.communityId ?? ''}:${event.pubkey}`;
    const sender = await this.cached(this.senders, senderKey, () =>
      this.loadSender(event.pubkey, room.communityId, reader),
    );

    // Corner presentation names (see mapping.ts's channel-naming convention):
    // resolve the DESTINATION corner's display name and its parent Room's
    // CURRENT display name from relay truth. The destination is either the
    // notifying channel itself (a corner worktree channel) or the `subchannel`
    // target an attention card announced inside its parent Room. Parent lookups
    // reuse the same per-Room cache, and an unresolvable parent simply leaves
    // the field unset — mapping.ts falls back honestly instead of fabricating.
    let cornerName: string | undefined;
    let parentRoomName: string | undefined;
    const attentionTarget = tagValue(event, 'subchannel');
    const cornerChannelId = room.isChildChannel
      ? channelId
      : attentionTarget && attentionTarget !== channelId
        ? attentionTarget
        : undefined;
    if (cornerChannelId) {
      const corner = await this.cached(
        this.rooms,
        `${reader.scopeKey ?? ''}:${cornerChannelId}`,
        () => this.loadRoom(cornerChannelId, reader),
      );
      cornerName = corner.roomName;
      parentRoomName =
        corner.isChildChannel && corner.parentChannelId
          ? await this.roomDisplayName(corner.parentChannelId, reader)
          : // The attention target was announced inside this Room; it is the
            // corner's parent by the gateway's own addressing contract.
            room.roomName;
    }

    return {
      ...(room.roomName ? { roomName: room.roomName } : {}),
      isDirectMessage: room.isDirectMessage,
      ...(room.isChildChannel ? { isChildChannel: true } : {}),
      ...(room.parentChannelId ? { parentChannelId: room.parentChannelId } : {}),
      ...(cornerName ? { cornerName } : {}),
      ...(parentRoomName ? { parentRoomName } : {}),
      persistentWorkspaceRoom: room.persistentWorkspaceRoom,
      ...(room.workspaceName ? { workspaceName: room.workspaceName } : {}),
      fixtureCandidates: room.fixtureCandidates,
      fixtureMarkers: room.fixtureMarkers,
      senderName: sender.name,
      ...(sender.handle ? { senderHandle: sender.handle } : {}),
    };
  }

  /** Resolve a member's display name for presentation (joiner of a Room, etc.). */
  async resolveMemberName(
    roomId: string,
    pubkey: string,
    reader: RelayEventReader,
  ): Promise<string | undefined> {
    const roomKey = `${reader.scopeKey ?? ''}:${roomId}`;
    const room = await this.cached(this.rooms, roomKey, () => this.loadRoom(roomId, reader));
    const sender = await this.cached(this.senders, `${room.communityId ?? ''}:${pubkey}`, () =>
      this.loadSender(pubkey, room.communityId, reader),
    );
    return sender.name;
  }

  /** Cached current display name of one channel, shared with the full room cache. */
  private async roomDisplayName(
    channelId: string,
    reader: RelayEventReader,
  ): Promise<string | undefined> {
    const room = await this.cached(this.rooms, `${reader.scopeKey ?? ''}:${channelId}`, () =>
      this.loadRoom(channelId, reader),
    );
    return room.roomName;
  }

  private async loadRoom(channelId: string, reader: RelayEventReader): Promise<RoomMetadata> {
    const events = await reader.query([
      { kinds: [KIND_CHANNEL_METADATA], '#d': [channelId], limit: 5 },
      { kinds: [KIND_CHANNEL_METADATA], '#h': [channelId], limit: 5 },
      { kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 },
    ]);
    const metadata = latest(
      events.filter(
        (event) =>
          event.kind === KIND_CHANNEL_METADATA &&
          (tagValue(event, 'd') === channelId || tagValue(event, 'h') === channelId),
      ),
    );
    const creation = earliest(
      events.filter(
        (event) => event.kind === KIND_CREATE_GROUP && tagValue(event, 'h') === channelId,
      ),
    );
    const roomName =
      cleanName(metadata ? tagValue(metadata, 'name') : undefined) ??
      cleanName(creation ? tagValue(creation, 'name') : undefined);
    const isDirectMessage = Boolean(
      creation && tagValues(creation, 't').includes(TAG_DIRECT_MESSAGE),
    );
    // A corner worktree channel names its parent Room on the immutable create.
    const parentChannelId = creation ? tagValue(creation, 'parent') : undefined;
    const isChildChannel = Boolean(parentChannelId);
    // Only the immutable create can establish the Workspace binding. Mutable
    // metadata may refine presentation but cannot make a standalone Room FCM-eligible.
    const communityId = creation ? tagValue(creation, TAG_COMMUNITY) : undefined;
    if (!creation || !communityId) {
      const fixture = fixtureFields([creation, metadata]);
      return {
        ...(roomName ? { roomName } : {}),
        isDirectMessage,
        isChildChannel,
        ...(parentChannelId ? { parentChannelId } : {}),
        persistentWorkspaceRoom: false,
        fixtureCandidates: fixture.candidates,
        fixtureMarkers: fixture.markers,
      };
    }
    if (communityId === channelId) {
      // A self-referencing community tag (`community` == the channel's own `h`)
      // is the canonical Buzz Workspace-group shape: one immutable kind:9007
      // create IS both the Workspace record and its chat-eligible top-level
      // channel. Classifying it as standalone suppressed messages posted to
      // real top-level Workspace rooms (live 2026-08-23: "Tubing Crew" and
      // "Personal"). The Workspace name is the channel's own name, so the
      // throwaway-workspace suppression still applies unchanged.
      const fixture = fixtureFields([creation, metadata]);
      return {
        ...(roomName ? { roomName } : {}),
        isDirectMessage,
        isChildChannel,
        ...(parentChannelId ? { parentChannelId } : {}),
        communityId,
        ...(roomName ? { workspaceName: roomName } : {}),
        persistentWorkspaceRoom: Boolean(roomName),
        fixtureCandidates: fixture.candidates,
        fixtureMarkers: fixture.markers,
      };
    }

    const workspaceEvents = await reader.query([
      { kinds: [KIND_CHANNEL_METADATA], '#d': [communityId], limit: 5 },
      { kinds: [KIND_CHANNEL_METADATA], '#h': [communityId], limit: 5 },
      { kinds: [KIND_CREATE_GROUP], '#h': [communityId], limit: 20 },
    ]);
    const workspaceCreation = earliest(
      workspaceEvents.filter(
        (event) =>
          event.kind === KIND_CREATE_GROUP &&
          tagValue(event, 'h') === communityId &&
          tagValue(event, TAG_COMMUNITY) === communityId,
      ),
    );
    const workspaceMetadata = latest(
      workspaceEvents.filter(
        (event) =>
          event.kind === KIND_CHANNEL_METADATA &&
          (tagValue(event, 'd') === communityId || tagValue(event, 'h') === communityId),
      ),
    );
    const workspaceName =
      cleanName(workspaceMetadata ? tagValue(workspaceMetadata, 'name') : undefined) ??
      cleanName(workspaceCreation ? tagValue(workspaceCreation, 'name') : undefined);
    const fixture = fixtureFields([creation, metadata, workspaceCreation, workspaceMetadata]);
    return {
      ...(roomName ? { roomName } : {}),
      isDirectMessage,
      isChildChannel,
      ...(parentChannelId ? { parentChannelId } : {}),
      communityId,
      ...(workspaceName ? { workspaceName } : {}),
      persistentWorkspaceRoom: Boolean(workspaceCreation && workspaceName),
      fixtureCandidates: fixture.candidates,
      fixtureMarkers: fixture.markers,
    };
  }

  private async loadSender(
    pubkey: string,
    communityId: string | undefined,
    reader: RelayEventReader,
  ): Promise<SenderPresentation> {
    const filters: Record<string, unknown>[] = [
      { kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 },
      { kinds: [0], authors: [pubkey], limit: 5 },
    ];
    if (communityId) {
      filters.push(
        { kinds: [KIND_AGENT_SOUL], '#d': [`${communityId}:${pubkey}`], limit: 20 },
        {
          kinds: [KIND_PERSON_PROFILE],
          authors: [pubkey],
          '#d': [`${communityId}:${pubkey}`],
          limit: 5,
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
              (profile.communityId === communityId && !agentAuthors.has(profile.authoredBy))),
          );
        }),
      );
      const soulProfile = soul ? parseAgentSoul(soul) : null;
      // A soul remains the assigned display name after its human author rotates
      // or leaves. The relay accepted it while that signer was a member, and a
      // removed key cannot publish a replacement; requiring CURRENT membership
      // made durable Codex/Ox/Clara assignments fall back to seed names.
      return { name: resolveAgentName(soulProfile?.name ?? agent.displayName, pubkey) };
    }
    return personPresentation(events, pubkey, communityId) ?? { name: fallbackPersonName(pubkey) };
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
