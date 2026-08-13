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
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_COMMUNITY_INVITE,
  KIND_CREATE_GROUP,
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
  isMember,
  setMemberRole,
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

function now(): number {
  return Math.floor(Date.now() / 1000);
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

function toCommunity(event: NostrEvent): Community | null {
  if (!isCommunityCreate(event)) return null;
  const communityId = tagValue(event, 'h');
  const name = tagValue(event, 'name');
  if (!communityId || !name) return null;
  const avatar = tagValue(event, 'avatar') ?? tagValue(event, 'picture');
  return {
    communityId,
    name,
    ...(avatar ? { avatar } : {}),
    createdBy: event.pubkey,
    ownerPubkey: event.pubkey,
    createdAt: event.created_at,
    raw: event,
  };
}

async function queryGroupState(
  ctx: ChannelOpsContext,
  kind: number,
  communityId: string,
): Promise<NostrEvent[]> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [kind], '#d': [communityId], limit: 5 }],
    ctx.identity.publicKey,
  );
  if (events.length > 0) return events;
  return queryEvents(
    ctx.http,
    [{ kinds: [kind], '#h': [communityId], limit: 5 }],
    ctx.identity.publicKey,
  );
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
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CREATE_GROUP], '#h': [communityId], limit: 5 }],
    ctx.identity.publicKey,
  );
  const communities = events
    .map(toCommunity)
    .filter((value): value is Community => value !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
  return communities[0] ?? null;
}

/** List self-linked communities whose 39002 member projection contains `pubkey`. */
export async function listCommunities(
  ctx: ChannelOpsContext,
  pubkey: string,
  limit = 50,
): Promise<Community[]> {
  const [memberEvents, createEvents] = await Promise.all([
    queryEvents(
      ctx.http,
      [{ kinds: [KIND_CHANNEL_MEMBERS], '#p': [pubkey], limit }],
      ctx.identity.publicKey,
    ),
    queryEvents(ctx.http, [{ kinds: [KIND_CREATE_GROUP], limit: 500 }], ctx.identity.publicKey),
  ]);
  const ids = [
    ...new Set(
      memberEvents
        .map((event) => tagValue(event, 'd') ?? tagValue(event, 'h'))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return [];

  const wanted = new Set(ids);
  const byId = new Map<string, Community>();
  for (const event of createEvents) {
    const community = toCommunity(event);
    if (!community || !wanted.has(community.communityId)) continue;
    const prior = byId.get(community.communityId);
    if (!prior || community.createdAt < prior.createdAt) {
      byId.set(community.communityId, community);
    }
  }

  // The broad create scan is shared with Room discovery. Fall back to exact
  // reads for an older Workspace that fell outside the relay's scan window.
  const missing = ids.filter((id) => !byId.has(id));
  const recovered = await Promise.all(missing.map((id) => getCommunity(ctx, id)));
  for (const community of recovered) {
    if (community) byId.set(community.communityId, community);
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
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CREATE_GROUP], limit }],
    ctx.identity.publicKey,
  );
  return events.filter(
    (event) =>
      tagValue(event, TAG_COMMUNITY) === communityId &&
      !isCommunityCreate(event) &&
      (tagValue(event, 'h') ?? tagValue(event, 'd')) !== communityId,
  );
}

async function communityRoomIds(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<string[]> {
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
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_STREAM_MESSAGE], authors: [pubkey], '#t': [TAG_AGENT], limit: 50 }],
    ctx.identity.publicKey,
  );
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

/** Read community membership and overlay owner/admin roles from kind:39001. */
export async function communityMembers(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<CommunityMember[]> {
  const [memberEvents, adminEvents, community] = await Promise.all([
    queryGroupState(ctx, KIND_CHANNEL_MEMBERS, communityId),
    queryGroupState(ctx, KIND_CHANNEL_ADMINS, communityId),
    getCommunity(ctx, communityId),
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
  if (!tokenHash || !/^[0-9a-f]{64}$/.test(tokenHash)) return null;
  if (!communityId || communityTag !== communityId) return null;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= event.created_at) return null;
  return {
    tokenHash,
    communityId,
    expiresAt,
    mintedBy: event.pubkey,
    event,
  };
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
  const foundCurrent = current
    .map(parseCommunityInvite)
    .find((record): record is CommunityInviteRecord => record?.tokenHash === tokenHash);
  if (foundCurrent) return foundCurrent;

  // Buzz requires an h filter to read a channel-scoped kind:9 event, but the
  // token alone cannot reveal that h value. Scan the indexed invite marker tag
  // to keep links minted by older clients resolvable until their expiry.
  const legacy = await queryEvents(
    http,
    [{ kinds: [KIND_STREAM_MESSAGE], '#t': [TAG_COMMUNITY_INVITE], limit: 500 }],
    readerPubkey,
  );
  return (
    legacy
      .map(parseCommunityInvite)
      .find((record): record is CommunityInviteRecord => record?.tokenHash === tokenHash) ?? null
  );
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
