import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { verifyEvent } from '@beeline/nostr';
import {
  createChannel,
  isMember,
  setMemberRole,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import { queryEvents } from './http.js';
import { KIND_CREATE_GROUP, KIND_PUT_USER, TAG_COMMUNITY } from './kinds.js';
import { tagValue } from './parse.js';
import type { RepositoryBinding } from './types.js';

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
  role: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    // The 39002 member projection may omit elevated role labels. The signed
    // kind-9000 history is the authority used by git policy and the merge gate.
    const events = await queryEvents(
      ctx.http,
      [{ kinds: [KIND_PUT_USER], '#h': [channelId], '#p': [pubkey], limit: 20 }],
      ctx.identity.publicKey,
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (latest && (tagValue(latest, 'role') ?? 'member') === role) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`role ${role} not visible for ${pubkey.slice(0, 12)}… in ${channelId}`);
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
    if (raced) return joinRepositoryRoom(agentCtx, raced);
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
