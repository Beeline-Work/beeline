/**
 * Community operations built from the same NIP-29 primitives as channels.
 *
 * A community is a kind:9007 stream group whose `community` tag self-references
 * its `h` UUID; kind:9000 mutations project its members through 39002. Channels
 * point back to that UUID with the same tag on their kind:9007 create event.
 *
 * Invites are signed kind:9 events inside the open community group. Only the
 * SHA-256 token hash is published. Redemption verifies the marker and expiry,
 * then self-adds through kind:9000. Repeated redemption is effect-idempotent.
 */
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { signEvent, verifyEvent, type NostrEvent } from '@buzzy/nostr';
import { publishEvent, queryEvents } from './http.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
} from './kinds.js';
import { parseMembersEvent, tagValue, tagValues } from './parse.js';
import { setMemberRole, waitUntilMember, type ChannelOpsContext } from './channel.js';
import type {
  Community,
  CommunityInvite,
  CommunityInviteRecord,
  CommunityMember,
  CommunityRole,
  CreateInviteOptions,
  RedeemInviteResult,
} from './types.js';

const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

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
  const memberEvents = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CHANNEL_MEMBERS], '#p': [pubkey], limit }],
    ctx.identity.publicKey,
  );
  const ids = [
    ...new Set(
      memberEvents
        .map((event) => tagValue(event, 'd') ?? tagValue(event, 'h'))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return [];

  // Query each projected group independently. Some relay HTTP bridges interpret
  // multiple values in a tag filter as an intersection instead of NIP-01 OR,
  // which otherwise makes every community disappear once a member also owns a
  // community-linked channel.
  const communities = await Promise.all(ids.map((id) => getCommunity(ctx, id)));
  return communities
    .filter((community): community is Community => community !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** List channels whose kind:9007 create event points at `communityId`. */
export async function communityChannels(
  ctx: ChannelOpsContext,
  communityId: string,
  limit = 500,
): Promise<string[]> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_CREATE_GROUP], limit }],
    ctx.identity.publicKey,
  );
  const ids = new Set<string>();
  for (const event of events) {
    if (tagValue(event, TAG_COMMUNITY) !== communityId) continue;
    if (isCommunityCreate(event)) continue;
    const channelId = tagValue(event, 'h') ?? tagValue(event, 'd');
    if (channelId && channelId !== communityId) ids.add(channelId);
  }
  return [...ids];
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
  if (event.kind !== KIND_STREAM_MESSAGE || !verifyEvent(event)) return null;
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
    KIND_STREAM_MESSAGE,
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
  const events = await queryEvents(
    ctx.http,
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        '#d': [tokenHash],
        '#t': [TAG_COMMUNITY_INVITE],
        limit: 20,
      },
    ],
    ctx.identity.publicKey,
  );
  const invite = events
    .map(parseCommunityInvite)
    .find((record): record is CommunityInviteRecord => record?.tokenHash === tokenHash);
  if (!invite) throw new Error('invalid invite token');

  const members = await communityMembers(ctx, invite.communityId);
  if (!members.some((member) => member.pubkey === invite.mintedBy)) {
    throw new Error('invite minter is not a community member');
  }
  if (members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    return {
      communityId: invite.communityId,
      mintedBy: invite.mintedBy,
      expiresAt: invite.expiresAt,
      joined: false,
      alreadyMember: true,
    };
  }
  if (invite.expiresAt <= now()) throw new Error('invite has expired');

  await setMemberRole(ctx, invite.communityId, ctx.identity.publicKey, 'member', {
    extraTags: [
      ['invite', tokenHash],
      [TAG_COMMUNITY, invite.communityId],
    ],
  });
  await waitUntilMember(ctx, invite.communityId, ctx.identity.publicKey);
  return {
    communityId: invite.communityId,
    mintedBy: invite.mintedBy,
    expiresAt: invite.expiresAt,
    joined: true,
    alreadyMember: false,
  };
}
