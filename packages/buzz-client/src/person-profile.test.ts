import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { parsePersonProfile, setPersonProfile } from './person-profile.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PERSON_PROFILE,
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY,
  TAG_PERSON_PROFILE,
} from './kinds.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const person = createIdentity('person');
const outsider = createIdentity('outsider');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };
const ctx: ChannelOpsContext = { http: { ...http, identity: person }, identity: person };

function signed(identity: typeof person, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: 1_700_000_000, kind, tags, content },
    identity.secretKey,
  );
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filter(init?: RequestInit): Record<string, unknown> {
  return (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
}

afterEach(() => vi.unstubAllGlobals());

describe('human cosmetic profiles', () => {
  it('publishes a self-authored Workspace profile without authority tags', async () => {
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published = JSON.parse(String(init?.body)) as NostrEvent;
          return response({ accepted: true });
        }
        const kind = (filter(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP)
          return response([
            signed(person, KIND_CREATE_GROUP, [
              ['h', communityId],
              ['name', 'Hull'],
              ['channel_type', 'stream'],
              ['visibility', 'open'],
              [TAG_COMMUNITY, communityId],
            ]),
          ]);
        if (kind === KIND_CHANNEL_MEMBERS)
          return response([
            signed(person, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', person.publicKey],
            ]),
          ]);
        if (kind === KIND_CHANNEL_ADMINS) return response([]);
        if (kind === KIND_STREAM_MESSAGE) return response([]);
        return response([]);
      }),
    );

    const profile = await setPersonProfile(ctx, communityId, {
      name: 'Ada Lovelace',
      avatar: 'https://relay.test/media/person.jpg',
    });
    expect(profile.name).toBe('Ada Lovelace');
    expect(profile.avatar).toBe('https://relay.test/media/person.jpg');
    expect(published?.pubkey).toBe(person.publicKey);
    expect(published?.tags).toContainEqual(['t', TAG_PERSON_PROFILE]);
    expect(published?.tags).not.toContainEqual(['role', 'admin']);
    expect(JSON.parse(published?.content ?? '{}')).toEqual({
      name: 'Ada Lovelace',
      avatar: 'https://relay.test/media/person.jpg',
    });
  });

  it('reads legacy displayName profile content', () => {
    const event = signed(
      person,
      KIND_PERSON_PROFILE,
      [
        ['d', `${communityId}:${person.publicKey}`],
        ['h', communityId],
        ['p', person.publicKey],
        ['t', TAG_PERSON_PROFILE],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ displayName: 'Grace Hopper', avatar: '' }),
    );
    expect(parsePersonProfile(event)?.name).toBe('Grace Hopper');
  });

  it('rejects a profile that points at a pubkey other than its signer', () => {
    const forged = signed(
      outsider,
      KIND_PERSON_PROFILE,
      [
        ['d', `${communityId}:${person.publicKey}`],
        ['h', communityId],
        ['p', person.publicKey],
        ['t', TAG_PERSON_PROFILE],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ avatar: 'https://relay.test/media/forged.jpg' }),
    );
    expect(parsePersonProfile(forged)).toBeNull();
  });
});
