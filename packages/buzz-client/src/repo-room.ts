import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  createChannel,
  isMember,
  setMemberRole,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import { queryEvents } from './http.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue } from './parse.js';
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
  /** True only when this pairing created and elevated the dedicated merge worker. */
  mergeWorkerProvisioned: boolean;
}

async function joinRepositoryRoom(
  agentCtx: ChannelOpsContext,
  channelId: string,
): Promise<RepositoryRoomResult> {
  if (!(await isMember(agentCtx, channelId, agentCtx.identity.publicKey))) {
    // Room creation and self-join are Workspace-member capabilities. They do
    // not confer merge approval or protected-branch push authority.
    await setMemberRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
    await waitUntilRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
  }
  return { channelId, created: false, joined: true, mergeWorkerProvisioned: false };
}

async function waitUntilRole(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
  role: CommunityRole,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const current = await projectedRoomRole(ctx, channelId, pubkey);
    if (current === role) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  const lastEvents: NostrEvent[] = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_PUT_USER], '#h': [channelId], '#p': [pubkey], limit: 20 }],
    ctx.identity.publicKey,
  );
  console.error(
    `[repo-room] role wait timeout: ${JSON.stringify({
      channelId,
      pubkey,
      expectedRole: role,
      events: lastEvents.map((event) => ({
        id: event.id,
        pubkey: event.pubkey,
        created_at: event.created_at,
        tags: event.tags,
      })),
    })}`,
  );
  throw new Error(`role ${role} not visible for ${pubkey.slice(0, 12)}… in ${channelId}`);
}

async function queryRoomProjection(
  ctx: ChannelOpsContext,
  channelId: string,
  kind: number,
): Promise<NostrEvent[]> {
  const byD = await queryEvents(
    ctx.http,
    [{ kinds: [kind], '#d': [channelId], limit: 5 }],
    ctx.identity.publicKey,
  );
  if (byD.length > 0) return byD;
  return queryEvents(
    ctx.http,
    [{ kinds: [kind], '#h': [channelId], limit: 5 }],
    ctx.identity.publicKey,
  );
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

async function ensureExistingAdmin(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<void> {
  const current = await projectedRoomRole(ctx, channelId, pubkey);
  if (current === 'owner' || current === 'admin') return;

  const actorRole = await projectedRoomRole(ctx, channelId, ctx.identity.publicKey);
  if (actorRole !== 'owner' && actorRole !== 'admin') {
    throw new Error(
      `required admin role missing for ${pubkey.slice(0, 12)}… in ${channelId}; ` +
        `current client is ${actorRole ?? 'not a member'} and cannot grant it`,
    );
  }
  await setMemberRole(ctx, channelId, pubkey, 'admin');
  await waitUntilRole(ctx, channelId, pubkey, 'admin');
}

/** Find the single Room whose immutable create event carries this repository key. */
export async function findRepositoryRoom(
  ctx: ChannelOpsContext,
  communityId: string,
  repositoryKey: string,
): Promise<string | null> {
  const events = await queryEvents(
    ctx.http,
    [
      {
        kinds: [KIND_CREATE_GROUP],
        '#community': [communityId],
        '#repo-key': [repositoryKey],
        limit: 50,
      },
    ],
    ctx.identity.publicKey,
  );
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
 * Resolve the origin-backed Room or create it under the agent's key. The
 * pairing-code minter becomes the initial human admin; the creator is projected
 * down to plain member after provisioning the dedicated merge worker.
 */
export async function resolveRepositoryRoom(
  agentCtx: ChannelOpsContext,
  communityId: string,
  binding: RepositoryBinding,
  pairedBy: string,
  mergeWorkerPubkey?: string,
): Promise<RepositoryRoomResult> {
  const existing = await findRepositoryRoom(agentCtx, communityId, binding.key);
  if (existing) {
    await ensureExistingAdmin(agentCtx, existing, pairedBy);
    // Existing Rooms already have their dedicated gate identity. A later agent
    // joins as a member and reuses that gate instead of provisioning a new one.
    return joinRepositoryRoom(agentCtx, existing);
  }

  const channelId = repositoryRoomId(communityId, binding);
  try {
    await createChannel(agentCtx, binding.name, {
      channelId,
      communityId,
      repository: binding,
    });
  } catch (error) {
    // Two clones may pair concurrently after both observe no Room. The
    // deterministic ID lets the loser converge on the winner without a fork.
    const raced = await findRepositoryRoom(agentCtx, communityId, binding.key);
    if (raced) {
      await ensureExistingAdmin(agentCtx, raced, pairedBy);
      return joinRepositoryRoom(agentCtx, raced);
    }
    throw error;
  }
  await waitUntilMember(agentCtx, channelId, agentCtx.identity.publicKey);
  if (pairedBy !== agentCtx.identity.publicKey) {
    await setMemberRole(agentCtx, channelId, pairedBy, 'admin');
    await waitUntilRole(agentCtx, channelId, pairedBy, 'admin');
  }
  // The creating agent still owns the deterministic Room at this point. Give a
  // distinct, machine-held gate key the only non-owner push-capable role before
  // irreversibly projecting the autonomous agent down to plain member.
  if (mergeWorkerPubkey && mergeWorkerPubkey !== agentCtx.identity.publicKey) {
    await setMemberRole(agentCtx, channelId, mergeWorkerPubkey, 'admin');
    await waitUntilRole(agentCtx, channelId, mergeWorkerPubkey, 'admin');
  }
  await setMemberRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
  await waitUntilRole(agentCtx, channelId, agentCtx.identity.publicKey, 'member');
  return {
    channelId,
    created: true,
    joined: true,
    mergeWorkerProvisioned: Boolean(mergeWorkerPubkey),
  };
}
