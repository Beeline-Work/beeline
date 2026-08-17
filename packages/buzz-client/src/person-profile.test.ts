import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import {
  KIND_NOSTR_PROFILE,
  parseGlobalPersonProfile,
  parsePersonProfile,
  setGlobalPersonProfile,
  setPersonProfile,
} from './person-profile.js';
import {
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
  it('publishes a self-authored global kind:0 profile without authority tags', async () => {
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published = JSON.parse(String(init?.body)) as NostrEvent;
          return response({ accepted: true });
        }
        const kind = (filter(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return response([]);
        return response([]);
      }),
    );

    const profile = await setPersonProfile(ctx, communityId, {
      name: 'Ada Lovelace',
      handle: 'ada',
      avatar: 'https://relay.test/media/person.jpg',
    });
    expect(profile.name).toBe('Ada Lovelace');
    expect(profile.handle).toBe('ada');
    expect(profile.avatar).toBe('https://relay.test/media/person.jpg');
    expect(published?.pubkey).toBe(person.publicKey);
    expect(published?.kind).toBe(KIND_NOSTR_PROFILE);
    expect(published?.tags).toEqual([]);
    expect(published?.tags).not.toContainEqual(['role', 'admin']);
    expect(JSON.parse(published?.content ?? '{}')).toEqual({
      name: 'ada',
      display_name: 'Ada Lovelace',
      picture: 'https://relay.test/media/person.jpg',
      nip05: '',
    });
    expect(published && parseGlobalPersonProfile(published)).toMatchObject({
      name: 'Ada Lovelace',
      handle: 'ada',
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

  it('publishes and normalizes a NIP-05 identifier', async () => {
    let published: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published = JSON.parse(String(init?.body)) as NostrEvent;
          return response({ accepted: true });
        }
        return response([]);
      }),
    );

    const profile = await setGlobalPersonProfile(ctx, { nip05: ' Ada@Example.COM ' });
    expect(profile.nip05).toBe('Ada@example.com');
    expect(JSON.parse(published?.content ?? '{}')).toMatchObject({ nip05: 'Ada@example.com' });
    expect(published && parseGlobalPersonProfile(published)?.nip05).toBe('Ada@example.com');
  });

  it('rejects a malformed NIP-05 identifier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response([])));
    await expect(setGlobalPersonProfile(ctx, { nip05: 'not-an-identifier' })).rejects.toThrow(
      /nip05/,
    );
  });

  it('drops an invalid nip05 value found in raw profile content', () => {
    const event = signed(
      person,
      KIND_NOSTR_PROFILE,
      [],
      JSON.stringify({ name: 'ada', nip05: 'not-an-identifier' }),
    );
    expect(parseGlobalPersonProfile(event)?.nip05).toBeUndefined();
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
