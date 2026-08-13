import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { communityMembers } from './community.js';
import { isAgentIdentity } from './agent.js';
import { publishEvent, queryEvents } from './http.js';
import { KIND_PERSON_PROFILE, TAG_COMMUNITY, TAG_PERSON_PROFILE } from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import { normalizePersonName } from './display-name.js';
import type { PersonProfile, PersonProfileInput } from './types.js';
import type { ChannelOpsContext } from './channel.js';

let lastProfileTimestamp = 0;

function profileKey(communityId: string, pubkey: string): string {
  return `${communityId}:${pubkey}`;
}

function nextTimestamp(): number {
  const current = Math.floor(Date.now() / 1000);
  lastProfileTimestamp = Math.max(current, lastProfileTimestamp + 1);
  return lastProfileTimestamp;
}

function optionalAvatar(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const avatar = value.trim();
  if (avatar.length > 2048 || !/^https?:\/\//i.test(avatar)) return undefined;
  return avatar;
}

function optionalName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return normalizePersonName(value) ?? undefined;
}

export function parsePersonProfile(event: NostrEvent): PersonProfile | null {
  if (event.kind !== KIND_PERSON_PROFILE || !verifyEvent(event)) return null;
  if (!tagValues(event, 't').includes(TAG_PERSON_PROFILE)) return null;
  const communityId = tagValue(event, 'h');
  const pubkey = tagValue(event, 'p');
  if (
    !communityId ||
    pubkey !== event.pubkey ||
    tagValue(event, TAG_COMMUNITY) !== communityId ||
    tagValue(event, 'd') !== profileKey(communityId, event.pubkey)
  )
    return null;
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof content !== 'object' || content === null || Array.isArray(content)) return null;
    const rawName = content.name ?? content.displayName;
    const name = optionalName(rawName);
    if (rawName !== undefined && !name && rawName !== '') return null;
    const avatar = optionalAvatar(content.avatar);
    if (content.avatar !== undefined && !avatar && content.avatar !== '') return null;
    return {
      communityId,
      pubkey: event.pubkey,
      ...(name ? { name } : {}),
      ...(avatar ? { avatar } : {}),
      updatedAt: event.created_at,
      raw: event,
    };
  } catch {
    return null;
  }
}

export async function getPersonProfile(
  ctx: ChannelOpsContext,
  communityId: string,
  pubkey: string,
): Promise<PersonProfile | null> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_PERSON_PROFILE], '#d': [profileKey(communityId, pubkey)], limit: 20 }],
    ctx.identity.publicKey,
  );
  return (
    events
      .map(parsePersonProfile)
      .filter((profile): profile is PersonProfile =>
        Boolean(profile && profile.communityId === communityId && profile.pubkey === pubkey),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  );
}

export async function listPersonProfiles(
  ctx: ChannelOpsContext,
  communityId: string,
  pubkeys: string[],
): Promise<PersonProfile[]> {
  const unique = [...new Set(pubkeys)];
  const profiles = await Promise.all(
    unique.map((pubkey) => getPersonProfile(ctx, communityId, pubkey)),
  );
  return profiles.filter((profile): profile is PersonProfile => profile !== null);
}

/** Publish self-authored display metadata. It carries no role or approval authority. */
export async function setPersonProfile(
  ctx: ChannelOpsContext,
  communityId: string,
  input: PersonProfileInput,
): Promise<PersonProfile> {
  const members = await communityMembers(ctx, communityId);
  if (!members.some((member) => member.pubkey === ctx.identity.publicKey)) {
    throw new Error('only a Workspace member can edit their profile');
  }
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agent identities cannot author human profiles');
  }
  const name =
    input.name === undefined || input.name === '' ? undefined : normalizePersonName(input.name);
  if (input.name !== undefined && input.name !== '' && !name) {
    throw new Error('profile name must be 1-60 readable characters');
  }
  const avatar = input.avatar?.trim();
  if (avatar && (avatar.length > 2048 || !/^https?:\/\//i.test(avatar))) {
    throw new Error('profile avatar must be an http(s) URL');
  }
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: nextTimestamp(),
      kind: KIND_PERSON_PROFILE,
      tags: [
        ['d', profileKey(communityId, ctx.identity.publicKey)],
        ['h', communityId],
        ['p', ctx.identity.publicKey],
        ['t', TAG_PERSON_PROFILE],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({ name: name ?? '', avatar: avatar ?? '' }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parsePersonProfile(event)!;
}
