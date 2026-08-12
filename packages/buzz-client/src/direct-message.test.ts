import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { BuzzClient } from './client.js';
import {
  directMessageChannelId,
  listDirectMessages,
  parseDirectMessage,
  resolveDirectMessage,
} from './direct-message.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
} from './kinds.js';
import { tagValue } from './parse.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('dm-owner');
const peer = createIdentity('dm-peer');
const outsider = createIdentity('dm-outsider');
const ctx: ChannelOpsContext = {
  identity: owner,
  http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: owner },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function projection(kind: number, id: string, pubkeys: string[]): NostrEvent {
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: 1_700_000_000,
      kind,
      tags: [['d', id], ...pubkeys.map((pubkey) => ['p', pubkey])],
      content: '',
    },
    owner.secretKey,
  );
}

function validCreate(extraTags: string[][] = []): NostrEvent {
  const channelId = directMessageChannelId(communityId, owner.publicKey, peer.publicKey);
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: 1_700_000_000,
      kind: KIND_CREATE_GROUP,
      tags: [
        ['h', channelId],
        ['name', 'Direct message'],
        ['channel_type', 'stream'],
        ['visibility', 'private'],
        [TAG_COMMUNITY, communityId],
        ['t', TAG_DIRECT_MESSAGE],
        ['p', owner.publicKey],
        ['p', peer.publicKey],
        ...extraTags,
      ],
      content: '',
    },
    owner.secretKey,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('direct-message Room model', () => {
  it('derives one order-independent channel ID and rejects malformed create events', () => {
    expect(directMessageChannelId(communityId, owner.publicKey, peer.publicKey)).toBe(
      directMessageChannelId(communityId, peer.publicKey, owner.publicKey),
    );
    expect(parseDirectMessage(validCreate())).toMatchObject({
      communityId,
      participants: [owner.publicKey, peer.publicKey].sort(),
    });
    expect(parseDirectMessage(validCreate([['p', outsider.publicKey]]))).toBeNull();
    expect(() => directMessageChannelId(communityId, owner.publicKey, owner.publicKey)).toThrow(
      'two different members',
    );
  });

  it('creates once, reopens without duplication, and refuses a third member', async () => {
    const channelId = directMessageChannelId(communityId, owner.publicKey, peer.publicKey);
    const workspaceMembers = [owner.publicKey, peer.publicKey, outsider.publicKey];
    const dmMembers = new Set<string>();
    const creates: NostrEvent[] = [];
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_CREATE_GROUP) {
            creates.push(event);
            dmMembers.add(event.pubkey);
          }
          if (event.kind === KIND_PUT_USER && tagValue(event, 'h') === channelId) {
            dmMembers.add(tagValue(event, 'p')!);
          }
          return json({ accepted: true });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kinds = filter.kinds as number[];
        const requestedId = ((filter['#d'] ?? filter['#h']) as string[] | undefined)?.[0];
        if (kinds.includes(KIND_CREATE_GROUP)) {
          return json(
            creates.filter((event) => !requestedId || tagValue(event, 'h') === requestedId),
          );
        }
        if (kinds.includes(KIND_CHANNEL_MEMBERS)) {
          if (requestedId === communityId) {
            return json([projection(KIND_CHANNEL_MEMBERS, communityId, workspaceMembers)]);
          }
          if (requestedId === channelId && dmMembers.size > 0) {
            return json([projection(KIND_CHANNEL_MEMBERS, channelId, [...dmMembers])]);
          }
          // listChannelsForPubkey discovery has #p but no channel id.
          if (filter['#p'] && dmMembers.has(owner.publicKey)) {
            return json([projection(KIND_CHANNEL_MEMBERS, channelId, [...dmMembers])]);
          }
        }
        if (kinds.includes(KIND_CHANNEL_ADMINS) && requestedId === channelId) {
          return json([projection(KIND_CHANNEL_ADMINS, channelId, [owner.publicKey])]);
        }
        return json([]);
      }),
    );

    await expect(resolveDirectMessage(ctx, communityId, peer.publicKey)).resolves.toMatchObject({
      created: true,
      directMessage: { channelId },
    });
    await expect(resolveDirectMessage(ctx, communityId, peer.publicKey)).resolves.toMatchObject({
      created: false,
      directMessage: { channelId },
    });
    expect(published.filter((event) => event.kind === KIND_CREATE_GROUP)).toHaveLength(1);
    expect([...dmMembers].sort()).toEqual([owner.publicKey, peer.publicKey].sort());
    await expect(listDirectMessages(ctx, communityId)).resolves.toHaveLength(1);

    const client = new BuzzClient({ baseUrl: 'http://relay.test', identity: owner });
    await expect(client.addMember(channelId, outsider.publicKey)).rejects.toThrow(
      'cannot add a third member',
    );
    expect([...dmMembers].sort()).toEqual([owner.publicKey, peer.publicKey].sort());
  });
});
