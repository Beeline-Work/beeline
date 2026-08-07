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
import { signEvent, type NostrEvent } from '@buzzy/nostr';
import { publishEvent } from './relay.js';
import type { Identity } from './identity.js';

export const KIND_PUT_USER = 9000;
export const KIND_CREATE_GROUP = 9007;
export const KIND_STREAM_MESSAGE = 9;
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

/** Create an open channel owned by `owner`. Returns the channel UUID. */
export async function createChannel(owner: Identity, name: string): Promise<string> {
  const channelId = randomUUID();
  const event = sign(owner, KIND_CREATE_GROUP, [
    ['h', channelId],
    ['name', name],
    ['channel_type', 'stream'],
    ['visibility', 'open'],
  ]);
  await publishEvent(event);
  return channelId;
}

/** Set `target`'s role in `channelId`, signed by an authorized actor. */
export async function setMemberRole(
  actor: Identity,
  channelId: string,
  targetPubkey: string,
  role: 'owner' | 'admin' | 'member',
): Promise<void> {
  const event = sign(actor, KIND_PUT_USER, [
    ['h', channelId],
    ['p', targetPubkey],
    ['role', role],
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
