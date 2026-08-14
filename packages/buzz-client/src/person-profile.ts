import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { isAgentIdentity } from './agent.js';
import { publishEvent, queryEvents } from './http.js';
import { KIND_PERSON_PROFILE, TAG_COMMUNITY, TAG_PERSON_PROFILE } from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import { normalizePersonHandle, normalizePersonName } from './display-name.js';
import type { PersonProfile, PersonProfileInput } from './types.js';
import type { ChannelOpsContext } from './channel.js';

export const KIND_NOSTR_PROFILE = 0;

let lastProfileTimestamp = 0;

function legacyProfileKey(communityId: string, pubkey: string): string {
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

function optionalHandle(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return normalizePersonHandle(value) ?? undefined;
}

function jsonRecord(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Parse the canonical, global NIP-01 profile for one person. */
export function parseGlobalPersonProfile(event: NostrEvent): PersonProfile | null {
  if (event.kind !== KIND_NOSTR_PROFILE || !verifyEvent(event)) return null;
  const content = jsonRecord(event.content);
  if (!content) return null;
  const name =
    optionalName(content.display_name) ??
    optionalName(content.displayName) ??
    optionalName(content.name);
  const handle = optionalHandle(content.name ?? content.handle);
  const avatar = optionalAvatar(content.picture ?? content.avatar);
  return {
    pubkey: event.pubkey,
    ...(name ? { name } : {}),
    ...(handle ? { handle } : {}),
    ...(avatar ? { avatar } : {}),
    updatedAt: event.created_at,
    raw: event,
  };
}

/** Parse the pre-global Workspace-scoped profile retained for migration fallback. */
export function parsePersonProfile(event: NostrEvent): PersonProfile | null {
  if (event.kind !== KIND_PERSON_PROFILE || !verifyEvent(event)) return null;
  if (!tagValues(event, 't').includes(TAG_PERSON_PROFILE)) return null;
  const communityId = tagValue(event, 'h');
  const pubkey = tagValue(event, 'p');
  if (
    !communityId ||
    pubkey !== event.pubkey ||
    tagValue(event, TAG_COMMUNITY) !== communityId ||
    tagValue(event, 'd') !== legacyProfileKey(communityId, event.pubkey)
  )
    return null;
  const content = jsonRecord(event.content);
  if (!content) return null;
  const rawName = content.name ?? content.displayName;
  const name = optionalName(rawName);
  if (rawName !== undefined && !name && rawName !== '') return null;
  const avatar = optionalAvatar(content.avatar);
  if (content.avatar !== undefined && !avatar && content.avatar !== '') return null;
  return {
    communityId,
    pubkey: event.pubkey,
    ...(name ? { name } : {}),
    ...(optionalHandle(content.handle) ? { handle: optionalHandle(content.handle) } : {}),
    ...(avatar ? { avatar } : {}),
    updatedAt: event.created_at,
    raw: event,
  };
}

async function latestGlobalProfileEvent(
  ctx: ChannelOpsContext,
  pubkey: string,
): Promise<NostrEvent | undefined> {
  const events = await queryEvents(
    ctx.http,
    [{ kinds: [KIND_NOSTR_PROFILE], authors: [pubkey], limit: 20 }],
    ctx.identity.publicKey,
  );
  return events
    .filter((event) => event.pubkey === pubkey && event.kind === KIND_NOSTR_PROFILE)
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
}

export async function getGlobalPersonProfile(
  ctx: ChannelOpsContext,
  pubkey = ctx.identity.publicKey,
): Promise<PersonProfile | null> {
  const event = await latestGlobalProfileEvent(ctx, pubkey);
  return event ? parseGlobalPersonProfile(event) : null;
}

/**
 * Read the global profile, falling back to the requested legacy Workspace only
 * until that identity next publishes its own kind:0 migration.
 */
export async function getPersonProfile(
  ctx: ChannelOpsContext,
  communityId: string,
  pubkey: string,
): Promise<PersonProfile | null> {
  const events = await queryEvents(
    ctx.http,
    [
      { kinds: [KIND_NOSTR_PROFILE], authors: [pubkey], limit: 20 },
      {
        kinds: [KIND_PERSON_PROFILE],
        '#d': [legacyProfileKey(communityId, pubkey)],
        limit: 20,
      },
    ],
    ctx.identity.publicKey,
  );
  const globalEvent = events
    .filter((event) => event.pubkey === pubkey && event.kind === KIND_NOSTR_PROFILE)
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))[0];
  const global = globalEvent ? parseGlobalPersonProfile(globalEvent) : null;
  if (global) return global;
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

/** Publish the single global kind:0 profile. It carries no role or approval authority. */
export async function setGlobalPersonProfile(
  ctx: ChannelOpsContext,
  input: PersonProfileInput,
): Promise<PersonProfile> {
  if (await isAgentIdentity(ctx, ctx.identity.publicKey)) {
    throw new Error('agent identities cannot author human profiles');
  }
  const currentEvent = await latestGlobalProfileEvent(ctx, ctx.identity.publicKey);
  const current = currentEvent ? parseGlobalPersonProfile(currentEvent) : null;

  const name =
    input.name === undefined
      ? current?.name
      : input.name === ''
        ? undefined
        : normalizePersonName(input.name);
  if (input.name !== undefined && input.name !== '' && !name) {
    throw new Error('profile name must be 1-60 readable characters');
  }
  const handle =
    input.handle === undefined
      ? current?.handle
      : input.handle === ''
        ? undefined
        : normalizePersonHandle(input.handle);
  if (input.handle !== undefined && input.handle !== '' && !handle) {
    throw new Error(
      'profile handle must be 1-30 lowercase letters, numbers, dots, dashes, or underscores',
    );
  }
  const avatar = input.avatar === undefined ? current?.avatar : input.avatar.trim() || undefined;
  if (avatar && (avatar.length > 2048 || !/^https?:\/\//i.test(avatar))) {
    throw new Error('profile avatar must be an http(s) URL');
  }

  const priorContent = currentEvent ? (jsonRecord(currentEvent.content) ?? {}) : {};
  const createdAt = Math.max(nextTimestamp(), (currentEvent?.created_at ?? 0) + 1);
  lastProfileTimestamp = createdAt;
  const event = signEvent(
    {
      pubkey: ctx.identity.publicKey,
      created_at: createdAt,
      kind: KIND_NOSTR_PROFILE,
      tags: [],
      content: JSON.stringify({
        ...priorContent,
        name: handle ?? '',
        display_name: name ?? '',
        picture: avatar ?? '',
      }),
    },
    ctx.identity.secretKey,
  );
  await publishEvent(ctx.http, event);
  return parseGlobalPersonProfile(event)!;
}

/** @deprecated `communityId` is accepted only for source compatibility. */
export async function setPersonProfile(
  ctx: ChannelOpsContext,
  _communityId: string,
  input: PersonProfileInput,
): Promise<PersonProfile> {
  return setGlobalPersonProfile(ctx, input);
}
