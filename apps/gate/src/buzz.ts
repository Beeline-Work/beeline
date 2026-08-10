/**
 * Buzz control-plane operations expressed as signed Nostr events over the HTTP
 * bridge: create a channel (NIP-29 kind:9007), set a member's role
 * (kind:9000), and announce a git repo bound to that channel with branch
 * protection (NIP-34 kind:30617 + Buzz `buzz-channel` / `buzz-protect` tags).
 *
 * Tag formats verified against buzz-relay `handlers/side_effects.rs` and
 * `core/git_perms.rs`:
 *   - kind:9007 — creator becomes channel owner; `h` = channel UUID.
 *   - kind:9000 — `h` = channel UUID, `p` = target pubkey, `role` = role tag
 *     ("owner"/"admin"/"member"). On an OPEN channel any authenticated member
 *     may add members.
 *   - kind:30617 — `d` = repo id (== `{repo}` in the git URL), `buzz-channel`
 *     = channel UUID (the git ACL binding), `buzz-protect` = protection rule.
 *     The 30617 signer is the repo OWNER and always resolves to MemberRole::Owner.
 */
import { randomUUID } from 'node:crypto';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { publishEvent } from './relay.js';
import type { Identity } from './identity.js';

export const KIND_PUT_USER = 9000;
export const KIND_CREATE_GROUP = 9007;
export const KIND_STREAM_MESSAGE = 9;
export const TAG_COMMUNITY = 'community';

/** NIP-29: edit group metadata (name, about, archived, visibility, etc.). */
export const KIND_EDIT_METADATA = 9002;
export const KIND_REPO_ANNOUNCEMENT = 30617;

function sign(identity: Identity, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content,
    },
    identity.secretKey,
  );
}

async function createGroup(
  owner: Identity,
  name: string,
  opts?: { parentChannelId?: string; communityId?: string; communitySelfLink?: boolean },
): Promise<string> {
  const channelId = randomUUID();
  const tags: string[][] = [
    ['h', channelId],
    ['name', name],
    ['channel_type', 'stream'],
    ['visibility', 'open'],
  ];
  if (opts?.parentChannelId) {
    tags.push(['parent', opts.parentChannelId]);
  }
  if (opts?.communityId) {
    tags.push([TAG_COMMUNITY, opts.communityId]);
  }
  if (opts?.communitySelfLink) {
    tags.push([TAG_COMMUNITY, channelId]);
  }
  const event = sign(owner, KIND_CREATE_GROUP, tags);
  await publishEvent(event);
  return channelId;
}

/** Create an open channel owned by `owner`. Returns the channel UUID. */
export function createChannel(
  owner: Identity,
  name: string,
  opts?: { parentChannelId?: string; communityId?: string },
): Promise<string> {
  return createGroup(owner, name, opts);
}

/** Create a self-linked community group; membership still uses kind:9000 → 39002. */
export function createCommunity(owner: Identity, name: string): Promise<string> {
  return createGroup(owner, name, { communitySelfLink: true });
}

/** Set `target`'s role in `channelId`, signed by an authorized actor. */
export async function setMemberRole(
  actor: Identity,
  channelId: string,
  targetPubkey: string,
  role: 'owner' | 'admin' | 'member',
  opts?: { extraTags?: string[][] },
): Promise<void> {
  const tags: string[][] = [
    ['h', channelId],
    ['p', targetPubkey],
    ['role', role],
  ];
  if (opts?.extraTags) tags.push(...opts.extraTags);
  const event = sign(actor, KIND_PUT_USER, tags);
  await publishEvent(event);
}

/**
 * Archive a channel by publishing a kind:9002 edit-metadata event.
 * The relay will set `archived=true` in the DB and re-emit kind:39000
 * with `archived=true` tag so clients see the channel as read-only.
 *
 * The caller MUST be an owner/admin of the channel, or the relay will
 * reject the mutation.
 */
export async function archiveChannel(actor: Identity, channelId: string): Promise<void> {
  const event = sign(actor, KIND_EDIT_METADATA, [
    ['h', channelId],
    ['archived', 'true'],
  ]);
  await publishEvent(event);
}

/**
 * Announce a repo owned by `owner`, bound to `channelId`, protecting
 * `refs/heads/main` so it requires Admin role and forbids force-push. `owner`
 * (the 30617 signer) is the repo Owner and can push main; a channel Member
 * cannot.
 */
export async function announceRepo(
  owner: Identity,
  repo: string,
  channelId: string,
): Promise<void> {
  const event = sign(owner, KIND_REPO_ANNOUNCEMENT, [
    ['d', repo],
    ['name', repo],
    ['buzz-channel', channelId],
    ['buzz-protect', 'refs/heads/main', 'push:admin', 'no-force-push'],
  ]);
  await publishEvent(event);
}
