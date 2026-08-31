import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  createChannel,
  isMember,
  setMemberRole,
  waitUntilMemberRole,
  type ChannelOpsContext,
} from './channel.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue } from './parse.js';
import { query } from './query.js';
import type { CommunityRole, RepositoryBinding } from './types.js';

function roomUuid(communityId: string, repositoryKey: string): string {
  const hex = bytesToHex(sha256(utf8ToBytes(`${communityId}:${repositoryKey}`)));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Deterministic for origin-backed repos; local-only binding keys are already random. */
export function repositoryRoomId(communityId: string, binding: RepositoryBinding): string {
  return roomUuid(communityId, binding.key);
}

export interface RepositoryRoomResult {
  channelId: string;
  created: boolean;
  joined: boolean;
}

async function joinRepositoryRoom(
  agentCtx: ChannelOpsContext,
  channelId: string,
): Promise<RepositoryRoomResult> {
  if (!(await isMember(agentCtx, channelId, agentCtx.identity.publicKey))) {
    await setMemberRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
    await waitUntilMemberRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
  }
  return { channelId, created: false, joined: true };
}

async function queryRoomProjection(
  ctx: ChannelOpsContext,
  channelId: string,
  kind: number,
): Promise<NostrEvent[]> {
  const byD = await query(ctx, [{ kinds: [kind], '#d': [channelId], limit: 5 }]);
  if (byD.length > 0) return byD;
  return query(ctx, [{ kinds: [kind], '#h': [channelId], limit: 5 }]);
}

function latestProjection(events: NostrEvent[]): NostrEvent | undefined {
  return [...events].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

async function projectedRoomRole(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<CommunityRole | null> {
  const admins = latestProjection(await queryRoomProjection(ctx, channelId, KIND_CHANNEL_ADMINS));
  const adminTag = admins?.tags.find((tag) => tag[0] === 'p' && tag[1] === pubkey);
  if (adminTag) return adminTag[3] === 'owner' || adminTag[2] === 'owner' ? 'owner' : 'admin';

  const members = latestProjection(await queryRoomProjection(ctx, channelId, KIND_CHANNEL_MEMBERS));
  return members?.tags.some((tag) => tag[0] === 'p' && tag[1] === pubkey) ? 'member' : null;
}

/** Establish and await the human authority required for Room membership writes. */
export async function ensureRepositoryRoomAdmin(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
  forceMutation = false,
): Promise<void> {
  const current = await projectedRoomRole(ctx, channelId, pubkey);
  if (!forceMutation && (current === 'owner' || current === 'admin')) return;

  const actorRole = await projectedRoomRole(ctx, channelId, ctx.identity.publicKey);
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    throw new Error(
      `required admin role missing for ${pubkey.slice(0, 12)}… in ${channelId}; ` +
        `current client is ${actorRole ?? 'not a member'} and cannot grant it — ` +
        'ask a human to attach this agent to the Room with admin rights from the Beeline app, ' +
        'then re-run pairing',
    );
  }
  await setMemberRole(ctx, channelId, pubkey, 'admin');
  await waitUntilMemberRole(ctx, channelId, pubkey, 'admin');
}

/** Find the single Room whose immutable create event carries this repository key. */
export async function findRepositoryRoom(
  ctx: ChannelOpsContext,
  communityId: string,
  repositoryKey: string,
): Promise<string | null> {
  const events = await query(ctx, [
    {
      kinds: [KIND_CREATE_GROUP],
      '#community': [communityId],
      '#repo-key': [repositoryKey],
      limit: 50,
    },
  ]);
  const match = events
    .filter(
      (event) =>
        verifyEvent(event) &&
        tagValue(event, TAG_COMMUNITY) === communityId &&
        tagValue(event, 'repo-key') === repositoryKey &&
        !tagValue(event, 'parent'),
    )
    .sort((a, b) => a.created_at - b.created_at)[0];
  return match ? (tagValue(match, 'h') ?? tagValue(match, 'd') ?? null) : null;
}

/**
 * Resolve the origin-backed Room and join it. Room creation is a HUMAN
 * action: this function NEVER creates a Room under the agent's key — pairing
 * binds an agent to a Room a human made, and a missing Room fails with an
 * actionable message instead of being conjured into existence (the exact
 * side effect that once bound a foreign repository into a Workspace as a
 * `beeline pair` side effect). When the join path can elevate the pairing-code
 * minter, it does; the agent itself ends as plain member.
 */
export async function resolveRepositoryRoom(
  agentCtx: ChannelOpsContext,
  communityId: string,
  binding: RepositoryBinding,
  pairedBy: string,
): Promise<RepositoryRoomResult> {
  const existing = await findRepositoryRoom(agentCtx, communityId, binding.key);
  if (!existing) {
    throw new Error(
      `no Room is bound to repository "${binding.name}" in Workspace ${communityId}. ` +
        'Room creation is a human action: create the Room from the Beeline app (binding this ' +
        'repository to it), then re-run pairing or attach this agent to that Room from the app.',
    );
  }
  const channelId = existing;
  await ensureRepositoryRoomAdmin(agentCtx, channelId, pairedBy);
  const result = await joinRepositoryRoom(agentCtx, channelId);
  return result;
}

/**
 * Resolve/create a repository Room from the human UI and make the creator's
 * admin projection authoritative before any per-Room agent invite is allowed.
 */
export async function resolveRepositoryRoomForHuman(
  humanCtx: ChannelOpsContext,
  communityId: string,
  binding: RepositoryBinding,
): Promise<RepositoryRoomResult> {
  const existing = await findRepositoryRoom(humanCtx, communityId, binding.key);
  if (existing) {
    await ensureRepositoryRoomAdmin(humanCtx, existing, humanCtx.identity.publicKey);
    return { channelId: existing, created: false, joined: true };
  }

  const channelId = repositoryRoomId(communityId, binding);
  try {
    await createChannel(humanCtx, binding.name, {
      channelId,
      communityId,
      repository: binding,
    });
  } catch (error) {
    const raced = await findRepositoryRoom(humanCtx, communityId, binding.key);
    if (!raced) throw error;
    await ensureRepositoryRoomAdmin(humanCtx, raced, humanCtx.identity.publicKey);
    return { channelId: raced, created: false, joined: true };
  }
  await ensureRepositoryRoomAdmin(humanCtx, channelId, humanCtx.identity.publicKey, true);
  return { channelId, created: true, joined: true };
}
