import { type NostrEvent } from '@beeline/nostr';
import { KIND_CHANNEL_ADMINS, KIND_CHANNEL_MEMBERS, KIND_CREATE_GROUP } from './kinds.js';
import { type AuthenticatedHttpBridgeOptions } from './http.js';
import { parseMembersEvent, tagValue } from './parse.js';
import { query } from './query.js';
import type { ChannelMember, Identity, RepositoryBinding } from './types.js';

export interface ChannelOpsContext {
  http: AuthenticatedHttpBridgeOptions;
  identity: Identity;
}

export type ChannelRole = 'owner' | 'admin' | 'member' | 'spectator';

async function latestRoleProjection(
  ctx: ChannelOpsContext,
  channelId: string,
  kind: number,
): Promise<NostrEvent | undefined> {
  let events = await query(ctx, [{ kinds: [kind], '#d': [channelId], limit: 5 }]);
  if (events.length === 0) {
    events = await query(ctx, [{ kinds: [kind], '#h': [channelId], limit: 5 }]);
  }
  return [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
}

/** Query current 39001/39002 projections; owners/admins are also members. */
export async function listMembers(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<ChannelMember[]> {
  const [memberProjection, adminProjection] = await Promise.all([
    latestRoleProjection(ctx, channelId, KIND_CHANNEL_MEMBERS),
    latestRoleProjection(ctx, channelId, KIND_CHANNEL_ADMINS),
  ]);
  const current = new Map<string, ChannelMember>();
  for (const member of memberProjection ? parseMembersEvent(memberProjection) : []) {
    current.set(member.pubkey, member);
  }
  for (const tag of adminProjection?.tags ?? []) {
    if (tag[0] !== 'p' || !tag[1]) continue;
    const role = tag[3] === 'owner' || tag[2] === 'owner' ? 'owner' : 'admin';
    current.set(tag[1], { pubkey: tag[1], role });
  }
  return [...current.values()];
}

/** True if pubkey appears in current member, owner, or admin projections. */
export async function isMember(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<boolean> {
  const members = await listMembers(ctx, channelId);
  return members.some((m) => m.pubkey === pubkey);
}

/** Resolve one identity's current role from the relay's authoritative projections. */
export async function getChannelRole(
  ctx: ChannelOpsContext,
  channelId: string,
  pubkey: string,
): Promise<ChannelRole | null> {
  const member = (await listMembers(ctx, channelId)).find((item) => item.pubkey === pubkey);
  if (!member) return null;
  return member.role === 'owner' || member.role === 'admin' ? member.role : 'member';
}

/**
 * Pubkey that signed a channel's immutable kind:9007 create event.
 *
 * This is the identity the relay authorizes a channel's lifecycle commands
 * against (kind:9002 archive in particular). A corner is created and signed by
 * exactly ONE agent, while `listSubchannels` lists every child of a Room
 * regardless of who opened it — so a daemon that discovers a corner must read
 * this before taking any lifecycle action on it.
 *
 * `null` means the create event is not readable, which is deliberately a
 * different answer from "someone else created it": a caller must not treat an
 * unreadable create event as proof of foreign ownership.
 */
export async function getChannelCreator(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<string | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 5 }]);
  const create = events
    .filter((event) => tagValue(event, 'h') === channelId)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))[0];
  return create?.pubkey ?? null;
}

/** Resolve the immutable repository binding carried by a Room's create event. */
export async function getChannelRepositoryBinding(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<RepositoryBinding | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 20 }]);
  for (const event of events.sort((a, b) => a.created_at - b.created_at)) {
    const key = tagValue(event, 'repo-key');
    const name = tagValue(event, 'repo-name');
    const scope = tagValue(event, 'repo-scope');
    if (!key || !name || (scope !== 'local' && scope !== 'remote')) continue;
    const remote = tagValue(event, 'repo-remote');
    const installation = tagValue(event, 'repo-github-installation');
    const githubInstallationId =
      installation && /^\d+$/.test(installation) ? Number(installation) : undefined;
    if (scope === 'remote' && !remote) continue;
    return {
      key,
      name,
      localOnly: scope === 'local',
      ...(remote ? { remote } : {}),
      ...(githubInstallationId && Number.isSafeInteger(githubInstallationId)
        ? { githubInstallationId }
        : {}),
    };
  }
  return null;
}
