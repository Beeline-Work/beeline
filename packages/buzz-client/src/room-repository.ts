/**
 * Room→repository binding: the Room owns the repo, published as Room state.
 *
 * A repository belongs to a Room, not to any one agent. It is published as
 * Room state on the relay so any agent/daemon that joins the Room discovers
 * the same binding, and any member's corner trees off it. The binding has two
 * possible sources, resolved in order by {@link resolveRoomRepository}:
 *
 *   1. `config` — a mutable, admin-authored kind:30078 room-config event
 *      (`d = buzz-room-repository:<channelId>`). This is the writable path:
 *      Stage 2's repo picker / "link a repo" / change-repo all publish here.
 *      Authority is room-scoped and reader-verified, mirroring `setAgentSoul`
 *      / `setAgentModelConfig`: only a *current* Room admin/owner may author
 *      it, and readers re-check the author's current role. The serving
 *      daemon's own host git credentials remain the real access fence — this
 *      only decides which target the Room proposes reviewed changes to.
 *
 *   2. `genesis` — the immutable binding carried on the Room's create event
 *      (`repo-key`/`repo-name`/`repo-scope`/`repo-remote` tags, read via
 *      `getChannelRepositoryBinding`). This is the migration / compatibility
 *      path: every Room paired before room-repo config existed keeps resolving
 *      with no republish required.
 *
 * A Room with neither resolves to `null` — a chat-only Room. Opening a corner
 * there is gated with an actionable refusal by the daemon, never a crash.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { getChannelCommunityId, getChannelRepositoryBinding, getChannelRole } from './channel.js';
import type { ChannelOpsContext } from './channel.js';
import { publishEvent } from './http.js';
import { KIND_ROOM_REPOSITORY, TAG_COMMUNITY, TAG_ROOM_REPOSITORY } from './kinds.js';
import { tagValue } from './parse.js';
import { query } from './query.js';
import type { RoomRepository, RoomRepositoryInput } from './types.js';

let lastRoomRepositoryTimestamp = 0;

function nextRoomRepositoryTimestamp(): number {
  lastRoomRepositoryTimestamp = Math.max(Math.floor(Date.now() / 1000), lastRoomRepositoryTimestamp + 1);
  return lastRoomRepositoryTimestamp;
}

function roomRepositoryKey(channelId: string): string {
  return `${TAG_ROOM_REPOSITORY}:${channelId}`;
}

/**
 * Parse a verified, admin-authored room-repository config event.
 *
 * Structural validation only; authorization (author is a *current* Room
 * admin/owner) is a reader-side check in {@link getRoomRepository}, exactly
 * like `parseAgentModelConfig` defers member-authorship to `getAgentModelConfig`.
 */
export function parseRoomRepository(event: NostrEvent): RoomRepository | null {
  if (event.kind !== KIND_ROOM_REPOSITORY || !verifyEvent(event)) return null;
  if (tagValue(event, 't') !== TAG_ROOM_REPOSITORY) return null;
  const channelId = tagValue(event, 'h');
  if (!channelId || tagValue(event, 'd') !== roomRepositoryKey(channelId)) return null;
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  const key = typeof content.key === 'string' ? content.key.trim() : '';
  const name = typeof content.name === 'string' ? content.name.trim() : '';
  const remote = typeof content.remote === 'string' ? content.remote.trim() : '';
  // A published room-repo binding is remote-first: the remote is the source of
  // truth every daemon can clone. Local-only bindings are non-convergent and
  // stay on the genesis path, so a config event without a remote is invalid.
  if (!key || !name || !remote) return null;
  const targetBranch =
    typeof content.targetBranch === 'string' && content.targetBranch.trim()
      ? content.targetBranch.trim()
      : undefined;
  const communityId = tagValue(event, TAG_COMMUNITY);
  return {
    channelId,
    ...(communityId ? { communityId } : {}),
    binding: { key, name, remote, localOnly: false },
    ...(targetBranch ? { targetBranch } : {}),
    source: 'config',
    authoredBy: event.pubkey,
    updatedAt: event.created_at,
    raw: event,
  };
}

/**
 * Bind (or re-bind) a repository to a Room. Room-scoped authority: only a
 * current Room admin/owner may author this. Rejects a local-only binding — a
 * published Room repository must carry a shareable git remote URL.
 */
export async function setRoomRepository(
  ctx: ChannelOpsContext,
  channelId: string,
  input: RoomRepositoryInput & { communityId?: string },
): Promise<RoomRepository> {
  const role = await getChannelRole(ctx, channelId, ctx.identity.publicKey);
  if (role !== 'owner' && role !== 'admin') {
    throw new Error('only a Room admin can set the Room repository');
  }
  const key = input.key.trim();
  const name = input.name.trim();
  const remote = input.remote.trim();
  if (!key || !name) throw new Error('room repository requires a key and name');
  if (!remote) throw new Error('room repository requires a git remote URL');
  const targetBranch = input.targetBranch?.trim();
  const communityId = input.communityId ?? (await getChannelCommunityId(ctx, channelId)) ?? undefined;
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: nextRoomRepositoryTimestamp(),
      kind: KIND_ROOM_REPOSITORY,
      tags: [
        ['d', roomRepositoryKey(channelId)],
        ['h', channelId],
        ['t', TAG_ROOM_REPOSITORY],
        ...(communityId ? [[TAG_COMMUNITY, communityId]] : []),
      ],
      content: JSON.stringify({
        key,
        name,
        remote,
        localOnly: false,
        ...(targetBranch ? { targetBranch } : {}),
      }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseRoomRepository(event)!;
}

/**
 * Read the current admin-authored room-repository config, if any. Picks the
 * newest event whose author is *currently* a Room admin/owner — a member who
 * has since lost admin can no longer repoint the Room's repository.
 */
export async function getRoomRepository(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<RoomRepository | null> {
  const events = await query(ctx, [
    { kinds: [KIND_ROOM_REPOSITORY], '#d': [roomRepositoryKey(channelId)], limit: 20 },
  ]);
  const candidates = events
    .map(parseRoomRepository)
    .filter((parsed): parsed is RoomRepository => parsed !== null)
    .sort(
      (a, b) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
        (a.raw && b.raw ? b.raw.id.localeCompare(a.raw.id) : 0),
    );
  for (const candidate of candidates) {
    const role = await getChannelRole(ctx, channelId, candidate.authoredBy!);
    if (role === 'owner' || role === 'admin') return candidate;
  }
  return null;
}

/**
 * Resolve the repository a Room owns from published Room state: the mutable
 * admin-authored config first, then the immutable genesis binding on the
 * create event (the migration/compat path). Returns `null` for a chat-only
 * Room with no repository — corner-open is gated on this, never crashes.
 */
export async function resolveRoomRepository(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<RoomRepository | null> {
  const config = await getRoomRepository(ctx, channelId);
  if (config) return config;
  const binding = await getChannelRepositoryBinding(ctx, channelId);
  if (!binding) return null;
  return { channelId, binding, source: 'genesis' };
}
