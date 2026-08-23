/**
 * Community operations built from the same NIP-29 primitives as channels.
 *
 * A community is a kind:9007 stream group whose `community` tag self-references
 * its `h` UUID; kind:9000 mutations project its members through 39002. Channels
 * point back to that UUID with the same tag on their kind:9007 create event.
 *
 * Invites are signed parameterized-replaceable lookup records. Only the SHA-256
 * token hash is published. Redemption verifies the marker and expiry, then
 * self-adds through kind:9000. Repeated redemption is effect-idempotent.
 */
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';
import { getDirectMessage } from './direct-message.js';
import { query } from './query.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_METADATA,
  KIND_CHANNEL_MEMBERS,
  KIND_COMMUNITY_INVITE,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
} from './kinds.js';
import { parseMembersEvent, tagValue, tagValues } from './parse.js';
import {
  getChannelCommunityId,
  getChannelMetadata,
  getChannelRole,
  isMember,
  setMemberRole,
  waitForRelayProjection,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import type {
  Community,
  CommunityInvite,
  CommunityInviteRecord,
  CommunityMember,
  CommunityRole,
  CreateInviteOptions,
  RedeemInviteResult,
} from './types.js';

export const DEFAULT_INVITE_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;
const COMMUNITY_AVATAR_PURPOSE_PREFIX = 'buzz-workspace-avatar:';
let lastCommunityMutationTimestamp = 0;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function nextCommunityTimestamp(): number {
  const current = now();
  lastCommunityMutationTimestamp = Math.max(current, lastCommunityMutationTimestamp + 1);
  return lastCommunityMutationTimestamp;
}

function newUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `bzi_${bytesToHex(bytes)}`;
}

function sign(
  ctx: ChannelOpsContext,
  kind: number,
  tags: string[][],
  content = '',
  createdAt = now(),
): NostrEvent {
  return signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: createdAt,
      kind,
      tags,
      content,
    },
    ctx.identity.secretKey,
  );
}

function isCommunityCreate(event: NostrEvent): boolean {
  const groupId = tagValue(event, 'h');
  return (
    event.kind === KIND_CREATE_GROUP &&
    Boolean(groupId) &&
    tagValue(event, TAG_COMMUNITY) === groupId
  );
}

function metadataAvatar(event: NostrEvent | undefined): string | undefined {
  if (!event) return undefined;
  const direct = tagValue(event, 'avatar') ?? tagValue(event, 'picture');
  if (direct) return direct;
  const purpose = tagValue(event, 'purpose');
  if (!purpose?.startsWith(COMMUNITY_AVATAR_PURPOSE_PREFIX)) return undefined;
  const avatar = purpose.slice(COMMUNITY_AVATAR_PURPOSE_PREFIX.length);
  return avatar || undefined;
}

function metadataClearsAvatar(event: NostrEvent | undefined): boolean {
  if (!event) return false;
  return event.tags.some(
    (tag) =>
      ((tag[0] === 'avatar' || tag[0] === 'picture') && tag[1] === '') ||
      (tag[0] === 'purpose' && tag[1] === COMMUNITY_AVATAR_PURPOSE_PREFIX),
  );
}

function metadataVisibility(event: NostrEvent | undefined): Community['visibility'] | undefined {
  if (event?.tags.some((tag) => tag[0] === 'private')) return 'invite-only';
  const value = event ? tagValue(event, 'visibility') : undefined;
  if (value === 'private' || value === 'invite-only') return 'invite-only';
  if (value === 'open' || value === 'public') return 'public';
  return undefined;
}

function wireVisibility(visibility: Community['visibility']): 'open' | 'private' {
  return visibility === 'invite-only' ? 'private' : 'open';
}

function latestEvent(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
}

function toCommunity(events: NostrEvent[], metadata?: NostrEvent): Community | null {
  const created = events
    .filter(isCommunityCreate)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  if (!created) return null;
  const communityId = tagValue(created, 'h');
  const name = tagValue(metadata ?? created, 'name') ?? tagValue(created, 'name');
  if (!communityId || !name) return null;
  const avatar = metadataClearsAvatar(metadata)
    ? undefined
    : (metadataAvatar(metadata) ?? metadataAvatar(created));
  return {
    communityId,
    name,
    ...(avatar ? { avatar } : {}),
    visibility: metadataVisibility(metadata) ?? metadataVisibility(created) ?? 'public',
    createdBy: created.pubkey,
    ownerPubkey: created.pubkey,
    createdAt: created.created_at,
    raw: created,
  };
}

function groupMetadataEvents(events: NostrEvent[]): Map<string, NostrEvent> {
  const grouped = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (event.kind !== KIND_CHANNEL_METADATA) continue;
    const communityId = tagValue(event, 'd') ?? tagValue(event, 'h');
    if (!communityId) continue;
    const records = grouped.get(communityId) ?? [];
    records.push(event);
    grouped.set(communityId, records);
  }
  return new Map(
    [...grouped].flatMap(([communityId, records]) => {
      const current = latestEvent(records);
      return current ? [[communityId, current] as const] : [];
    }),
  );
}

async function getCommunityMetadata(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<NostrEvent | undefined> {
  const events = await query(ctx, [
    { kinds: [KIND_CHANNEL_METADATA], '#d': [communityId], limit: 5 },
  ]);
  if (events.length > 0) return latestEvent(events);
  const fallback = await query(ctx, [
    { kinds: [KIND_CHANNEL_METADATA], '#h': [communityId], limit: 5 },
  ]);
  return latestEvent(fallback);
}

async function getCommunityCreateEvents(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<NostrEvent[]> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [communityId], limit: 20 }]);
  return events.filter((event) => tagValue(event, 'h') === communityId);
}

async function getImmutableCommunity(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<Community | null> {
  return toCommunity(await getCommunityCreateEvents(ctx, communityId));
}

function groupCommunityEvents(events: NostrEvent[]): Map<string, NostrEvent[]> {
  const grouped = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (!isCommunityCreate(event)) continue;
    const communityId = tagValue(event, 'h');
    if (!communityId) continue;
    const records = grouped.get(communityId) ?? [];
    records.push(event);
    grouped.set(communityId, records);
  }
  return grouped;
}

async function queryGroupState(
  ctx: ChannelOpsContext,
  kind: number,
  communityId: string,
): Promise<NostrEvent[]> {
  const events = await query(ctx, [{ kinds: [kind], '#d': [communityId], limit: 5 }]);
  if (events.length > 0) return events;
  return query(ctx, [{ kinds: [kind], '#h': [communityId], limit: 5 }]);
}

/** Hex SHA-256 used as the relay-safe lookup handle for an opaque invite token. */
export function inviteTokenHash(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

/** Create an open, self-linked NIP-29 group owned by the current identity. */
export async function createCommunity(
  ctx: ChannelOpsContext,
  name: string,
  opts?: { communityId?: string },
): Promise<string> {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('community name must not be empty');
  const communityId = opts?.communityId ?? newUuid();
  const event = sign(ctx, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', trimmedName],
    ['channel_type', 'stream'],
    ['visibility', 'open'],
    [TAG_COMMUNITY, communityId],
  ]);
  await publishEvent(ctx.http, event);
  return communityId;
}

/** Read a community create event by UUID. */
export async function getCommunity(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<Community | null> {
  const [events, metadata] = await Promise.all([
    getCommunityCreateEvents(ctx, communityId),
    getCommunityMetadata(ctx, communityId),
  ]);
  return toCommunity(events, metadata);
}

/** Publish admin-gated metadata and assert the replaceable projection carries the avatar. */
export async function setCommunityAvatar(
  ctx: ChannelOpsContext,
  communityId: string,
  avatarUrl: string,
): Promise<Community> {
  const avatar = avatarUrl.trim();
  if (avatar && (avatar.length > 2048 || !/^https?:\/\//i.test(avatar))) {
    throw new Error('Workspace picture must be an http(s) URL');
  }
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  const actor = members.find((member) => member.pubkey === ctx.identity.publicKey);
  if (actor?.role !== 'owner' && actor?.role !== 'admin') {
    throw new Error('only a Workspace owner or admin can change its picture');
  }

  const tags: string[][] = [
    ['h', communityId],
    // Name is privileged NIP-29 metadata. Repeating its current value makes
    // the relay enforce owner/admin authority for this cosmetic projection.
    ['name', community.name],
    ['visibility', wireVisibility(community.visibility)],
    [TAG_COMMUNITY, communityId],
  ];
  if (avatar) {
    tags.push(['avatar', avatar]);
    tags.push(['picture', avatar]);
    tags.push(['purpose', `${COMMUNITY_AVATAR_PURPOSE_PREFIX}${avatar}`]);
  } else {
    // An explicit empty value prevents an immutable legacy create-event image
    // from reappearing when a current admin removes the Workspace picture.
    tags.push(['avatar', '']);
    tags.push(['picture', '']);
    tags.push(['purpose', COMMUNITY_AVATAR_PURPOSE_PREFIX]);
  }
  const event = sign(ctx, KIND_EDIT_METADATA, tags);
  await publishEvent(ctx.http, event);
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    const projected = await getCommunity(ctx, communityId);
    if (projected && (projected.avatar ?? '') === avatar) return projected;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`Workspace picture was not projected after 15000ms`);
}

/** Rename a Workspace through the existing owner/admin metadata projection. */
export async function renameCommunity(
  ctx: ChannelOpsContext,
  communityId: string,
  nextName: string,
): Promise<Community> {
  const name = nextName.trim();
  if (!name) throw new Error('Workspace name cannot be empty');
  if (name.length > 80) throw new Error('Workspace name must be 80 characters or fewer');
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  const actor = members.find((member) => member.pubkey === ctx.identity.publicKey);
  if (actor?.role !== 'owner' && actor?.role !== 'admin') {
    throw new Error('only a Workspace owner or admin can rename it');
  }
  const tags: string[][] = [
    ['h', communityId],
    ['name', name],
    ['visibility', wireVisibility(community.visibility)],
    [TAG_COMMUNITY, communityId],
  ];
  if (community.avatar) {
    tags.push(['avatar', community.avatar]);
    tags.push(['picture', community.avatar]);
    tags.push(['purpose', `${COMMUNITY_AVATAR_PURPOSE_PREFIX}${community.avatar}`]);
  }
  await publishEvent(ctx.http, sign(ctx, KIND_EDIT_METADATA, tags));
  const timeoutAt = Date.now() + 15_000;
  while (Date.now() < timeoutAt) {
    const projected = await getCommunity(ctx, communityId);
    if (projected?.name === name) return projected;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error('Workspace name was not projected after 15000ms');
}

/** Change whether a Workspace is publicly discoverable or requires an invite. */
export async function setCommunityVisibility(
  ctx: ChannelOpsContext,
  communityId: string,
  visibility: Community['visibility'],
): Promise<Community> {
  if (visibility !== 'public' && visibility !== 'invite-only') {
    throw new Error('invalid Workspace visibility');
  }
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  const actor = members.find((member) => member.pubkey === ctx.identity.publicKey);
  if (actor?.role !== 'owner' && actor?.role !== 'admin') {
    throw new Error('only a Workspace owner or admin can change visibility');
  }
  const tags: string[][] = [
    ['h', communityId],
    ['name', community.name],
    ['visibility', wireVisibility(visibility)],
    [TAG_COMMUNITY, communityId],
  ];
  if (community.avatar) {
    tags.push(['avatar', community.avatar]);
    tags.push(['picture', community.avatar]);
    tags.push(['purpose', `${COMMUNITY_AVATAR_PURPOSE_PREFIX}${community.avatar}`]);
  }
  await publishEvent(ctx.http, sign(ctx, KIND_EDIT_METADATA, tags));
  let projected: Community | null = null;
  const ok = await waitForRelayProjection(
    ctx,
    communityId,
    [KIND_CHANNEL_METADATA],
    async () => {
      projected = await getCommunity(ctx, communityId);
      return projected?.visibility === visibility;
    },
    { timeoutMs: 15_000, intervalMs: 300 },
  );
  if (ok && projected) return projected;
  throw new Error('Workspace visibility was not projected after 15000ms');
}

function projectedCommunityRole(
  events: NostrEvent[],
  communityId: string,
  pubkey: string,
): CommunityRole | undefined {
  const forCommunity = (event: NostrEvent) =>
    (tagValue(event, 'd') ?? tagValue(event, 'h')) === communityId;
  const admins = latestEvent(
    events.filter((event) => event.kind === KIND_CHANNEL_ADMINS && forCommunity(event)),
  );
  const admin = admins?.tags.find((tag) => tag[0] === 'p' && tag[1] === pubkey);
  if (admin) return admin[3] === 'owner' || admin[2] === 'owner' ? 'owner' : 'admin';
  const members = latestEvent(
    events.filter((event) => event.kind === KIND_CHANNEL_MEMBERS && forCommunity(event)),
  );
  return members?.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey) ? 'member' : undefined;
}

/** List self-linked communities whose current role projections contain `pubkey`. */
export async function listCommunities(
  ctx: ChannelOpsContext,
  pubkey: string,
  limit = 50,
  /**
   * Predecessor keys of `pubkey`'s identity (key succession). Membership
   * projections naming any of these keys also count as discovery hits, so a
   * replaced device key still finds the Workspaces its predecessor held.
   */
  predecessors: readonly string[] = [],
): Promise<Community[]> {
  const discoveryKeys = [pubkey, ...predecessors.filter((key) => key !== pubkey)];
  const memberEvents = await query(ctx, [
    { kinds: [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS], '#p': discoveryKeys, limit },
  ]);
  const ids = [
    ...new Set(
      memberEvents
        .map((event) => tagValue(event, 'd') ?? tagValue(event, 'h'))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return [];

  // Candidate ids are already known from memberEvents above, so scope the
  // create/metadata read to exactly those instead of scanning every kind:9007
  // create and kind:39000 metadata event on the relay. Create events carry
  // `h`; metadata is read by its primary `#d` tag (same convention as
  // getCommunityMetadata's fallback below), so any metadata event that only
  // ever carried the older `#h` convention falls through to the existing
  // per-id `getCommunity` recovery path further down, same as before.
  const communityEvents = await query(ctx, [
    { kinds: [KIND_CREATE_GROUP], '#h': ids, limit: Math.max(500, ids.length * 20) },
    { kinds: [KIND_CHANNEL_METADATA], '#d': ids, limit: Math.max(500, ids.length * 5) },
  ]);
  const createEvents = communityEvents.filter((event) => event.kind === KIND_CREATE_GROUP);
  const metadataEvents = communityEvents.filter((event) => event.kind === KIND_CHANNEL_METADATA);

  const wanted = new Set(ids);
  const byId = new Map<string, Community>();
  const groupedCreateEvents = groupCommunityEvents(createEvents);
  const metadataById = groupMetadataEvents(metadataEvents);
  for (const [communityId, events] of groupedCreateEvents) {
    if (!wanted.has(communityId)) continue;
    const community = toCommunity(events, metadataById.get(communityId));
    if (community) {
      const viewerRole =
        community.ownerPubkey === pubkey
          ? 'owner'
          : projectedCommunityRole(memberEvents, communityId, pubkey);
      byId.set(communityId, { ...community, ...(viewerRole ? { viewerRole } : {}) });
    }
  }

  // The scoped create/metadata read above still relies on a `#d`-tagged
  // metadata event; fall back to exact per-id reads (which also try the
  // older `#h`-only metadata convention) for anything it missed.
  const exactIds = ids.filter((id) => !byId.has(id));
  const recovered = await Promise.all(exactIds.map((id) => getCommunity(ctx, id)));
  for (const community of recovered) {
    if (community) {
      const viewerRole =
        community.ownerPubkey === pubkey
          ? 'owner'
          : projectedCommunityRole(memberEvents, community.communityId, pubkey);
      byId.set(community.communityId, {
        ...community,
        ...(viewerRole ? { viewerRole } : {}),
      });
    }
  }

  return [...byId.values()]
    .filter((community): community is Community => community !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** List channels whose kind:9007 create event points at `communityId`. */
export async function communityChannels(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 500,
): Promise<string[]> {
  const events = await communityChannelCreates(ctx, communityId, limit);
  const ids = new Set<string>();
  for (const event of events) {
    const channelId = tagValue(event, 'h') ?? tagValue(event, 'd');
    if (channelId) ids.add(channelId);
  }
  return [...ids];
}

async function communityChannelCreates(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 500,
): Promise<NostrEvent[]> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], limit }]);
  return events.filter(
    (event) =>
      tagValue(event, TAG_COMMUNITY) === communityId &&
      !isCommunityCreate(event) &&
      (tagValue(event, 'h') ?? tagValue(event, 'd')) !== communityId,
  );
}

async function communityRoomIds(ctx: ChannelOpsContext, communityId: string): Promise<string[]> {
  const creates = await communityChannelCreates(ctx, communityId);
  const ids = new Set<string>();
  for (const event of creates) {
    // Workspace joins propagate only to shared, top-level Rooms. Corners keep
    // the exact membership they inherited when opened, and DMs are immutable
    // two-person Rooms that can never accept an ambient Workspace member.
    if (tagValue(event, TAG_PARENT)) continue;
    if (tagValues(event, 't').includes(TAG_DIRECT_MESSAGE)) continue;
    const channelId = tagValue(event, 'h') ?? tagValue(event, 'd');
    if (channelId) ids.add(channelId);
  }
  return [...ids];
}

function isArchivedChannelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /channel is archived/i.test(message);
}

function archivedWorkspaceError(): Error {
  return new Error(
    'This Workspace is archived. Ask a Workspace admin to restore it before joining.',
  );
}

async function assertCommunityMemberInChannels(
  ctx: ChannelOpsContext,
  communityId: string,
  pubkey: string,
): Promise<string[]> {
  const channelIds = await communityRoomIds(ctx, communityId);
  const repaired: string[] = [];
  for (const channelId of channelIds) {
    // An archived historical Room is not a valid join target. Skip it and
    // continue into the Workspace's live Rooms instead of surfacing the
    // relay's low-level kind:9000 rejection in the app.
    if ((await getChannelMetadata(ctx, channelId))?.archived) continue;
    if (await isMember(ctx, channelId, pubkey)) continue;
    try {
      await setMemberRole(ctx, channelId, pubkey, 'member', {
        extraTags: [[TAG_COMMUNITY, communityId]],
      });
    } catch (error) {
      // Metadata may race the relay's archive mutation. Treat the relay's
      // authoritative rejection exactly like the preflight result.
      if (isArchivedChannelError(error)) continue;
      throw error;
    }
    await waitUntilMember(ctx, channelId, pubkey);
    repaired.push(channelId);
  }
  return repaired;
}

async function isRegisteredAgentIdentity(ctx: ChannelOpsContext, pubkey: string): Promise<boolean> {
  const events = await query(ctx, [
    { kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 },
  ]);
  return events.some(
    (event) =>
      event.pubkey === pubkey && verifyEvent(event) && tagValues(event, 't').includes(TAG_AGENT),
  );
}

/** Repair missing direct Room projections for the current human Workspace member. */
export async function repairCommunityRoomMemberships(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<string[]> {
  const pubkey = ctx.identity.publicKey;
  if (await isRegisteredAgentIdentity(ctx, pubkey)) return [];
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === pubkey)) {
    throw new Error('Room membership repair requires current Workspace membership');
  }
  return assertCommunityMemberInChannels(ctx, communityId, pubkey);
}

const ROLE_RANK: Record<'member' | 'admin' | 'owner', number> = { member: 0, admin: 1, owner: 2 };

/**
 * Key-succession membership migration: make THIS key (the successor) a member
 * of every Workspace and top-level Room its identity's predecessor keys
 * belonged to, at the highest role any of them held there. Zero re-inviting:
 * the successor self-joins under its own signature, so no other key's
 * authority and no other member's record is touched — agents' memberships
 * are never written.
 *
 * Corners keep the exact membership they inherited when opened, and DMs are
 * immutable two-person Rooms — both are skipped, like Workspace joins do.
 */
export async function migrateSuccessorMemberships(
  ctx: ChannelOpsContext,
  predecessors: readonly string[],
): Promise<string[]> {
  const pubkey = ctx.identity.publicKey;
  if (await isRegisteredAgentIdentity(ctx, pubkey)) return [];
  const chain = [...new Set(predecessors)].filter(
    (key) => /^[0-9a-f]{64}$/.test(key) && key !== pubkey,
  );
  if (chain.length === 0) return [];

  // Candidate channels: anything whose membership/admin projection names a
  // predecessor. One multi-key read; classification happens below.
  const projections = await query(ctx, [
    { kinds: [KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS], '#p': chain, limit: 500 },
  ]);
  const candidateIds = [
    ...new Set(
      projections
        .map((event) => tagValue(event, 'd') ?? tagValue(event, 'h'))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (candidateIds.length === 0) return [];

  // Classify candidates off their kind:9007 create events in one batched read.
  const creates = await query(ctx, [
    { kinds: [KIND_CREATE_GROUP], '#h': candidateIds, limit: Math.max(500, candidateIds.length * 5) },
  ]);
  const createByChannel = new Map<string, NostrEvent>();
  for (const event of creates) {
    const channelId = tagValue(event, 'h') ?? tagValue(event, 'd');
    if (!channelId || createByChannel.has(channelId)) continue;
    if (tagValues(event, 't').includes(TAG_DIRECT_MESSAGE)) continue; // DMs immutable
    if (tagValue(event, TAG_PARENT)) continue; // corners inherit, never migrate
    if (isCommunityCreate(event)) {
      createByChannel.set(channelId, event); // Workspace itself
      continue;
    }
    if (tagValue(event, TAG_COMMUNITY)) createByChannel.set(channelId, event); // top-level Room
  }

  const migrated: string[] = [];
  for (const [channelId] of createByChannel) {
    if ((await getChannelMetadata(ctx, channelId))?.archived) continue;
    if (await isMember(ctx, channelId, pubkey)) continue;
    let role: 'member' | 'admin' | 'owner' = 'member';
    for (const predecessor of chain) {
      const predecessorRole = await getChannelRole(ctx, channelId, predecessor).catch(() => null);
      if (predecessorRole && ROLE_RANK[predecessorRole] > ROLE_RANK[role]) role = predecessorRole;
    }
    try {
      await setMemberRole(ctx, channelId, pubkey, role);
      await waitUntilMember(ctx, channelId, pubkey);
      migrated.push(channelId);
    } catch (error) {
      if (isArchivedChannelError(error)) continue;
      throw error;
    }
  }
  return migrated;
}

/** Read community membership and overlay owner/admin roles from kind:39001. */
export async function communityMembers(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<CommunityMember[]> {
  const [memberEvents, adminEvents, community] = await Promise.all([
    queryGroupState(ctx, KIND_CHANNEL_MEMBERS, communityId),
    queryGroupState(ctx, KIND_CHANNEL_ADMINS, communityId),
    getImmutableCommunity(ctx, communityId),
  ]);
  if (!community) return [];

  const roles = new Map<string, CommunityRole>();
  const latestMembers = [...memberEvents].sort((a, b) => b.created_at - a.created_at)[0];
  if (latestMembers) {
    for (const member of parseMembersEvent(latestMembers)) roles.set(member.pubkey, 'member');
  }
  const latestAdmins = [...adminEvents].sort((a, b) => b.created_at - a.created_at)[0];
  if (latestAdmins) {
    for (const tag of latestAdmins.tags) {
      if (tag[0] !== 'p' || !tag[1]) continue;
      const role = tag[2] === 'owner' ? 'owner' : 'admin';
      roles.set(tag[1], role);
    }
  }
  roles.set(community.ownerPubkey, 'owner');
  return [...roles.entries()].map(([pubkey, role]) => ({ pubkey, role }));
}

/** Place one existing Workspace member into one Room, always with member authority. */
export async function attachCommunityMemberToChannel(
  ctx: ChannelOpsContext,
  channelId: string,
  memberPubkey: string,
  communityId: string,
): Promise<{ joined: boolean; membershipSince: number }> {
  if (await getDirectMessage(ctx, channelId)) {
    throw new Error('direct messages cannot add a third member');
  }
  const roomCommunityId = await getChannelCommunityId(ctx, channelId);
  if (roomCommunityId !== communityId) {
    throw new Error('member placement requires a Room in this Workspace');
  }
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === memberPubkey)) {
    throw new Error('person is not a member of this Workspace');
  }
  if (await isMember(ctx, channelId, memberPubkey)) {
    return { joined: false, membershipSince: now() };
  }

  const membershipSince = now();
  await setMemberRole(ctx, channelId, memberPubkey, 'member', {
    extraTags: [
      [TAG_COMMUNITY, communityId],
      ['member-invite', memberPubkey],
    ],
  });
  await waitUntilMember(ctx, channelId, memberPubkey);
  return { joined: true, membershipSince };
}

function inviteExpiry(options: CreateInviteOptions | undefined, createdAt: number): number {
  if (options?.expiresAt !== undefined && options.expiresInSeconds !== undefined) {
    throw new Error('set either expiresAt or expiresInSeconds, not both');
  }
  const expiresAt =
    options?.expiresAt ?? createdAt + (options?.expiresInSeconds ?? DEFAULT_INVITE_TTL_SECONDS);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) {
    throw new Error('invite expiry must be a future Unix timestamp');
  }
  return expiresAt;
}

/** Parse and verify a signed invite marker. */
export function parseCommunityInvite(event: NostrEvent): CommunityInviteRecord | null {
  if (
    (event.kind !== KIND_COMMUNITY_INVITE && event.kind !== KIND_STREAM_MESSAGE) ||
    !verifyEvent(event)
  ) {
    return null;
  }
  if (!tagValues(event, 't').includes(TAG_COMMUNITY_INVITE)) return null;
  const tokenHash = tagValue(event, 'd');
  const communityId = tagValue(event, 'h');
  const communityTag = tagValue(event, TAG_COMMUNITY);
  const expiresRaw = tagValue(event, 'expiration');
  const expiresAt = expiresRaw === undefined ? NaN : Number(expiresRaw);
  const revoked = tagValue(event, 'revoked') === 'true';
  if (!tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (!communityId || communityTag !== communityId) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= event.created_at) return null;
  return {
    tokenHash,
    communityId,
    expiresAt,
    mintedBy: event.pubkey,
    ...(revoked ? { revoked: true } : {}),
    event,
  };
}

function latestInviteRecord(events: NostrEvent[], tokenHash: string): CommunityInviteRecord | null {
  const record = events
    .map(parseCommunityInvite)
    .filter((candidate): candidate is CommunityInviteRecord => candidate?.tokenHash === tokenHash)
    .sort(
      (a, b) => b.event.created_at - a.event.created_at || b.event.id.localeCompare(a.event.id),
    )[0];
  return record && !record.revoked ? record : null;
}

/** Find a current invite by token hash, including legacy group-scoped kind:9 markers. */
export async function findCommunityInvite(
  http: HttpBridgeOptions,
  tokenHash: string,
  readerPubkey: string,
): Promise<CommunityInviteRecord | null> {
  const current = await queryEvents(
    http,
    [
      {
        kinds: [KIND_COMMUNITY_INVITE],
        '#d': [tokenHash],
        '#t': [TAG_COMMUNITY_INVITE],
        limit: 20,
      },
    ],
    readerPubkey,
  );
  const foundCurrent = latestInviteRecord(current, tokenHash);
  if (foundCurrent) return foundCurrent;
  if (current.some((event) => parseCommunityInvite(event)?.revoked)) return null;

  // Buzz requires an h filter to read a channel-scoped kind:9 event, but the
  // token alone cannot reveal that h value. Scan the indexed invite marker tag
  // to keep links minted by older clients resolvable until their expiry.
  const legacy = await queryEvents(
    http,
    [{ kinds: [KIND_STREAM_MESSAGE], '#t': [TAG_COMMUNITY_INVITE], limit: 500 }],
    readerPubkey,
  );
  return latestInviteRecord(legacy, tokenHash);
}

/** List the current identity's active invites so each can be revoked by its signer. */
export async function listCommunityInvites(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<CommunityInviteRecord[]> {
  const events = await query(ctx, [
    {
      kinds: [KIND_COMMUNITY_INVITE],
      authors: [ctx.identity.publicKey],
      '#t': [TAG_COMMUNITY_INVITE],
      limit: 500,
    },
  ]);
  const latestByToken = new Map<string, CommunityInviteRecord>();
  for (const event of events) {
    const record = parseCommunityInvite(event);
    if (!record || record.communityId !== communityId) continue;
    const current = latestByToken.get(record.tokenHash);
    if (
      !current ||
      record.event.created_at > current.event.created_at ||
      (record.event.created_at === current.event.created_at && record.event.id > current.event.id)
    ) {
      latestByToken.set(record.tokenHash, record);
    }
  }
  const currentTime = now();
  return [...latestByToken.values()]
    .filter((record) => !record.revoked && record.expiresAt > currentTime)
    .sort((a, b) => b.event.created_at - a.event.created_at);
}

/** Revoke an invite by replacing the current signer's parameterized record. */
export async function revokeCommunityInvite(
  ctx: ChannelOpsContext,
  communityId: string,
  tokenHash: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error('invalid invite');
  const members = await communityMembers(ctx, communityId);
  const actor = members.find((member) => member.pubkey === ctx.identity.publicKey);
  if (actor?.role !== 'owner' && actor?.role !== 'admin') {
    throw new Error('only a Workspace owner or admin can revoke invites');
  }
  const invite = (await listCommunityInvites(ctx, communityId)).find(
    (record) => record.tokenHash === tokenHash,
  );
  if (!invite) throw new Error('invite is no longer active');
  const createdAt = Math.max(nextCommunityTimestamp(), invite.event.created_at + 1);
  lastCommunityMutationTimestamp = createdAt;
  const event = sign(
    ctx,
    KIND_COMMUNITY_INVITE,
    [
      ['h', communityId],
      ['t', TAG_COMMUNITY_INVITE],
      ['d', tokenHash],
      [TAG_COMMUNITY, communityId],
      ['expiration', String(Math.max(invite.expiresAt, createdAt + 1))],
      ['role', 'member'],
      ['revoked', 'true'],
    ],
    '',
    createdAt,
  );
  await publishEvent(ctx.http, event);
}

/** Mint a signed invite. Only its hash is published; return the plaintext once. */
export async function createInvite(
  ctx: ChannelOpsContext,
  communityId: string,
  options?: CreateInviteOptions,
): Promise<CommunityInvite> {
  const community = await getCommunity(ctx, communityId);
  if (!community) throw new Error(`community not found: ${communityId}`);
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('only a community member can mint an invite');
  }

  const createdAt = now();
  const expiresAt = inviteExpiry(options, createdAt);
  const token = randomToken();
  const tokenHash = inviteTokenHash(token);
  const event = sign(
    ctx,
    KIND_COMMUNITY_INVITE,
    [
      ['h', communityId],
      ['t', TAG_COMMUNITY_INVITE],
      ['d', tokenHash],
      [TAG_COMMUNITY, communityId],
      ['expiration', String(expiresAt)],
      ['role', 'member'],
    ],
    '',
    createdAt,
  );
  await publishEvent(ctx.http, event);
  return {
    token,
    tokenHash,
    communityId,
    expiresAt,
    mintedBy: ctx.identity.publicKey,
    event,
  };
}

/** Validate an invite and add the current identity as a community member. */
export async function redeemInvite(
  ctx: ChannelOpsContext,
  token: string,
): Promise<RedeemInviteResult> {
  if (!token || token.length > 512) throw new Error('invalid invite token');
  const tokenHash = inviteTokenHash(token);
  const invite = await findCommunityInvite(ctx.http, tokenHash, ctx.identity.publicKey);
  if (!invite) throw new Error('invalid invite token');

  const members = await communityMembers(ctx, invite.communityId);
  if (!members.some((member) => member.pubkey === invite.mintedBy)) {
    throw new Error('invite minter is not a community member');
  }
  if ((await getChannelMetadata(ctx, invite.communityId))?.archived) {
    throw archivedWorkspaceError();
  }
  if (members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    // Repeated redemption also repairs Rooms created before membership
    // propagation existed, or any prior partial mirror failure.
    await assertCommunityMemberInChannels(ctx, invite.communityId, ctx.identity.publicKey);
    return {
      communityId: invite.communityId,
      mintedBy: invite.mintedBy,
      expiresAt: invite.expiresAt,
      joined: false,
      alreadyMember: true,
    };
  }
  if (invite.expiresAt <= now()) throw new Error('invite has expired');

  try {
    await setMemberRole(ctx, invite.communityId, ctx.identity.publicKey, 'member', {
      extraTags: [
        ['invite', tokenHash],
        [TAG_COMMUNITY, invite.communityId],
      ],
    });
  } catch (error) {
    if (isArchivedChannelError(error)) throw archivedWorkspaceError();
    throw error;
  }
  await waitUntilMember(ctx, invite.communityId, ctx.identity.publicKey);
  await assertCommunityMemberInChannels(ctx, invite.communityId, ctx.identity.publicKey);
  return {
    communityId: invite.communityId,
    mintedBy: invite.mintedBy,
    expiresAt: invite.expiresAt,
    joined: true,
    alreadyMember: false,
  };
}
