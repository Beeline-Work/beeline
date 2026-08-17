/** Private two-member conversations built on the existing NIP-29 Room primitive. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import {
  createChannel,
  listChannelsForPubkey,
  listMembers,
  setMemberRole,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import { KIND_CREATE_GROUP, TAG_COMMUNITY, TAG_DIRECT_MESSAGE, TAG_PARENT } from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import { query } from './query.js';
import type { DirectMessage } from './types.js';

const PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

function normalizedParticipants(memberA: string, memberB: string): [string, string] {
  const participants = [memberA.toLowerCase(), memberB.toLowerCase()].sort();
  if (!participants.every((pubkey) => PUBKEY_PATTERN.test(pubkey))) {
    throw new Error('direct-message participants must be 32-byte hex public keys');
  }
  if (participants[0] === participants[1]) {
    throw new Error('a direct message requires two different members');
  }
  return [participants[0]!, participants[1]!];
}

/** Stable UUID-shaped Room ID; both participants converge without a lookup race. */
export function directMessageChannelId(
  communityId: string,
  memberA: string,
  memberB: string,
): string {
  if (!communityId.trim()) throw new Error('direct messages require a Workspace');
  const participants = normalizedParticipants(memberA, memberB);
  const bytes = sha256(utf8ToBytes(`buzz-dm:v1:${communityId}:${participants.join(':')}`)).slice(
    0,
    16,
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse only self-consistent, signed DM create events. */
export function parseDirectMessage(event: NostrEvent): DirectMessage | null {
  if (event.kind !== KIND_CREATE_GROUP || !verifyEvent(event)) return null;
  if (!tagValues(event, 't').includes(TAG_DIRECT_MESSAGE)) return null;
  if (tagValue(event, 'visibility') !== 'private' || tagValue(event, TAG_PARENT)) return null;
  const channelId = tagValue(event, 'h');
  const communityId = tagValue(event, TAG_COMMUNITY);
  const participantTags = tagValues(event, 'p');
  if (!channelId || !communityId || participantTags.length !== 2) return null;
  let participants: [string, string];
  try {
    participants = normalizedParticipants(participantTags[0]!, participantTags[1]!);
  } catch {
    return null;
  }
  if (!participants.includes(event.pubkey)) return null;
  if (directMessageChannelId(communityId, participants[0], participants[1]) !== channelId) {
    return null;
  }
  return {
    channelId,
    communityId,
    participants,
    createdBy: event.pubkey,
    createdAt: event.created_at,
    raw: event,
  };
}

/** Resolve a channel's immutable DM binding, if it is a valid DM. */
export async function getDirectMessage(
  ctx: ChannelOpsContext,
  channelId: string,
): Promise<DirectMessage | null> {
  const events = await query(ctx, [{ kinds: [KIND_CREATE_GROUP], '#h': [channelId], limit: 20 }]);
  return (
    events
      .map(parseDirectMessage)
      .filter((dm): dm is DirectMessage => dm?.channelId === channelId)
      .sort((a, b) => a.createdAt - b.createdAt || a.raw.id.localeCompare(b.raw.id))[0] ?? null
  );
}

function exactParticipantSet(members: readonly { pubkey: string }[], dm: DirectMessage): boolean {
  const actual = new Set(members.map((member) => member.pubkey));
  return actual.size === 2 && dm.participants.every((pubkey) => actual.has(pubkey));
}

/** List valid DMs where the current identity is one of exactly two current members. */
export async function listDirectMessages(
  ctx: ChannelOpsContext,
  communityId: string,
): Promise<DirectMessage[]> {
  const memberships = await listChannelsForPubkey(ctx, ctx.identity.publicKey, 500);
  const resolved = await Promise.all(
    memberships.map(async ({ channelId }) => {
      const dm = await getDirectMessage(ctx, channelId);
      if (
        !dm ||
        dm.communityId !== communityId ||
        !dm.participants.includes(ctx.identity.publicKey)
      ) {
        return null;
      }
      return exactParticipantSet(await listMembers(ctx, channelId), dm) ? dm : null;
    }),
  );
  return resolved
    .filter((dm): dm is DirectMessage => dm !== null)
    .sort((a, b) => b.createdAt - a.createdAt || a.channelId.localeCompare(b.channelId));
}

/** Create or reopen the one private Room bound to this Workspace member pair. */
export async function resolveDirectMessage(
  ctx: ChannelOpsContext,
  communityId: string,
  otherPubkey: string,
): Promise<{ directMessage: DirectMessage; created: boolean }> {
  const participants = normalizedParticipants(ctx.identity.publicKey, otherPubkey);
  const workspaceMembers = new Set(
    (await listMembers(ctx, communityId)).map((member) => member.pubkey),
  );
  if (!participants.every((pubkey) => workspaceMembers.has(pubkey))) {
    throw new Error('direct messages are limited to members of this Workspace');
  }

  const channelId = directMessageChannelId(communityId, participants[0], participants[1]);
  let dm = await getDirectMessage(ctx, channelId);
  let created = false;
  if (!dm) {
    await createChannel(ctx, 'Direct message', {
      channelId,
      communityId,
      visibility: 'private',
      mirrorCommunityMembers: false,
      extraTags: [
        ['t', TAG_DIRECT_MESSAGE],
        ['p', participants[0]],
        ['p', participants[1]],
      ],
    });
    dm = await getDirectMessage(ctx, channelId);
    if (!dm) throw new Error('direct-message create event did not become visible');
    created = true;
  }

  if (
    dm.communityId !== communityId ||
    dm.participants[0] !== participants[0] ||
    dm.participants[1] !== participants[1]
  ) {
    throw new Error('direct-message channel binding mismatch');
  }

  let members = await listMembers(ctx, channelId);
  const unexpected = members.filter((member) => !participants.includes(member.pubkey));
  if (unexpected.length > 0) {
    throw new Error('direct-message channel contains an unexpected third member');
  }
  for (const participant of participants) {
    if (members.some((member) => member.pubkey === participant)) continue;
    if (dm.createdBy !== ctx.identity.publicKey) {
      throw new Error('direct-message membership is not fully provisioned yet');
    }
    await setMemberRole(ctx, channelId, participant, 'member', {
      extraTags: [
        [TAG_COMMUNITY, communityId],
        ['t', TAG_DIRECT_MESSAGE],
      ],
    });
    await waitUntilMember(ctx, channelId, participant);
    members = await listMembers(ctx, channelId);
  }
  if (!exactParticipantSet(members, dm)) {
    throw new Error('direct-message membership must contain exactly two participants');
  }
  return { directMessage: dm, created };
}
