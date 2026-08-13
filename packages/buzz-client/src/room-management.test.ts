import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createBuzzClient } from './client.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_REMOVE_USER,
  TAG_ROOM_LIFECYCLE,
} from './kinds.js';

const roomId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('room-owner');
const member = createIdentity('room-member');

function installRelay(options: { parent?: string; communityId?: string } = {}) {
  const members = new Set([member.publicKey]);
  const admins = new Map([[owner.publicKey, 'owner']]);
  let archived = false;
  const published: NostrEvent[] = [];
  const create = signEvent(
    {
      pubkey: owner.publicKey,
      created_at: 1_700_000_000,
      kind: KIND_CREATE_GROUP,
      tags: [
        ['h', roomId],
        ['name', 'Room management'],
        ...(options.parent ? [['parent', options.parent]] : []),
        ...(options.communityId ? [['community', options.communityId]] : []),
      ],
      content: '',
    },
    owner.secretKey,
  );

  const projection = (kind: number, tags: string[][]) =>
    signEvent(
      { pubkey: owner.publicKey, created_at: 1_700_000_001, kind, tags, content: '' },
      owner.secretKey,
    );

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/events')) {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        published.push(event);
        if (event.kind === KIND_REMOVE_USER) {
          const target = event.tags.find((tag) => tag[0] === 'p')?.[1];
          if (target) {
            members.delete(target);
            admins.delete(target);
          }
        }
        if (event.kind === KIND_EDIT_METADATA) {
          archived = event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true');
        }
        return new Response('{"accepted":true}', { status: 200 });
      }

      const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
      const kinds = filter.kinds as number[];
      if (kinds.includes(KIND_CREATE_GROUP)) return new Response(JSON.stringify([create]));
      if (kinds.includes(KIND_CHANNEL_MEMBERS)) {
        return new Response(
          JSON.stringify(
            members.size
              ? [
                  projection(KIND_CHANNEL_MEMBERS, [
                    ['d', roomId],
                    ...[...members].map((pubkey) => ['p', pubkey]),
                  ]),
                ]
              : [],
          ),
        );
      }
      if (kinds.includes(KIND_CHANNEL_ADMINS)) {
        return new Response(
          JSON.stringify([
            projection(KIND_CHANNEL_ADMINS, [
              ['d', roomId],
              ...[...admins].map(([pubkey, role]) => ['p', pubkey, role]),
            ]),
          ]),
        );
      }
      if (kinds.includes(KIND_CHANNEL_METADATA)) {
        return new Response(
          JSON.stringify([
            projection(KIND_CHANNEL_METADATA, [
              ['d', roomId],
              ['name', 'Room management'],
              ['archived', String(archived)],
            ]),
          ]),
        );
      }
      return new Response('[]');
    }),
  );
  return { members, published };
}

function client(identity: typeof owner) {
  return createBuzzClient({ baseUrl: 'https://relay.test', host: 'relay.test', identity });
}

afterEach(() => vi.unstubAllGlobals());

describe('role-aware Room membership management', () => {
  it('lets an owner remove a member and verifies the projection', async () => {
    const relay = installRelay();

    await client(owner).removeRoomMember(roomId, member.publicKey);

    expect(relay.members.has(member.publicKey)).toBe(false);
    expect(relay.published).toHaveLength(1);
    expect(relay.published[0]).toMatchObject({ kind: KIND_REMOVE_USER });
    expect(relay.published[0]?.tags).toEqual(
      expect.arrayContaining([
        ['p', member.publicKey],
        ['t', TAG_ROOM_LIFECYCLE],
        ['action', 'admin-remove'],
      ]),
    );
  });

  it('lets a normal member leave only their own Room membership', async () => {
    const relay = installRelay();
    const memberClient = client(member);

    await expect(memberClient.removeRoomMember(roomId, owner.publicKey)).rejects.toThrow(
      'only a Room owner or admin',
    );
    await memberClient.leaveRoom(roomId);

    expect(relay.members.has(member.publicKey)).toBe(false);
    expect(relay.published).toHaveLength(1);
    expect(relay.published[0]?.tags).toContainEqual(['action', 'member-leave']);
    await expect(client(owner).leaveRoom(roomId)).rejects.toThrow('Room admins cannot leave');
  });

  it('archives a top-level Room through a marked admin event', async () => {
    const relay = installRelay();
    const ownerClient = client(owner);

    await ownerClient.archiveRoom(roomId);
    await expect(ownerClient.getChannelMetadata(roomId)).resolves.toMatchObject({ archived: true });
    expect(relay.published.map((event) => event.kind)).toEqual([KIND_EDIT_METADATA]);
    expect(relay.published[0]?.tags).toContainEqual(['action', 'admin-delete']);
    expect(
      relay.published.every((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === TAG_ROOM_LIFECYCLE),
      ),
    ).toBe(true);
  });

  it('keeps the lifecycle path off corners and Workspaces', async () => {
    installRelay({ parent: 'parent-room' });
    await expect(client(owner).archiveRoom(roomId)).rejects.toThrow('cannot target a corner');

    vi.unstubAllGlobals();
    installRelay({ communityId: roomId });
    await expect(client(owner).archiveRoom(roomId)).rejects.toThrow('cannot target a Workspace');
  });
});
