import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { RoomViewClient, RoomViewHttpError, type RoomView } from './room-view.js';
import { isAgentDetailView, isRoomView } from './surface-guards.js';

const room: RoomView = {
  room: {
    id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    workspaceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    name: 'Launch',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  messages: [],
  members: [],
  latestAgentTurns: [],
  corners: [],
  repositoryResolution: 'none',
  viewer: {
    identity: { pubkey: 'a'.repeat(64), kind: 'human', name: 'Captain' },
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  watchFilters: [],
};

describe('RoomViewClient', () => {
  it('opens a cold Room with one physical authenticated request', async () => {
    const physicalFetch = vi.fn(async () => Response.json(room));
    const identity = createIdentity('room-view-client');
    const value = await new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch: physicalFetch,
    }).room('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');

    expect(value).toEqual(room);
    expect(physicalFetch).toHaveBeenCalledOnce();
    const [url, init] = physicalFetch.mock.calls[0]!;
    expect(url).toBe('https://relay.example/room/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toMatch(/^Nostr /);
  });

  it('rejects an invalid successful response at the HTTP boundary', async () => {
    const identity = createIdentity('room-view-invalid');
    const request = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch: async () => Response.json({ room: { id: 'not-enough' } }),
    }).room('room-1');
    await expect(request).rejects.toEqual(
      expect.objectContaining<Partial<RoomViewHttpError>>({
        status: 502,
        code: 'invalid_surface_response',
      }),
    );
  });

  it('classifies malformed JSON as terminal but preserves body transport failures', async () => {
    const identity = createIdentity('room-view-body-errors');
    const malformed = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch: async () => new Response('{"room":', { status: 200 }),
    }).room('room-1');
    await expect(malformed).rejects.toEqual(
      expect.objectContaining<Partial<RoomViewHttpError>>({
        status: 502,
        code: 'invalid_surface_response',
      }),
    );

    const reset = new Error('body stream reset');
    const bodyFailure = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch: async () =>
        ({
          ok: true,
          json: async () => {
            throw reset;
          },
        }) as Response,
    }).room('room-1');
    await expect(bodyFailure).rejects.toBe(reset);
  });

  it('rejects malformed nested render state before it reaches cache or paint', () => {
    const badMessage = {
      id: 'b'.repeat(64),
      text: 'hello',
      createdAt: 3,
      author: room.viewer.identity,
      presentation: 'message',
      attachments: [{}],
    };
    expect(isRoomView({ ...room, messages: [badMessage] })).toBe(false);
    expect(
      isRoomView({
        ...room,
        latestAgentTurns: [
          {
            requestId: 'c'.repeat(64),
            agentPubkey: 'b'.repeat(64),
            status: 'working',
            createdAt: 3,
          },
        ],
      }),
    ).toBe(true);
    expect(isRoomView({ ...room, latestAgentTurns: [{ status: 'working' }] })).toBe(false);
    expect(isRoomView({ ...room, repositoryResolution: 'unknown' })).toBe(false);
    expect(
      isRoomView({
        ...room,
        review: { status: 'ready', files: [], approvedBy: [] },
      }),
    ).toBe(false);
  });

  it('validates indexed agent souls before a rename form can preserve them', () => {
    const detail = {
      workspaceId: room.room.workspaceId,
      agent: {
        identity: { pubkey: 'b'.repeat(64), kind: 'agent', name: 'Clara' },
        role: 'member',
      },
      soul: {
        name: 'Clara',
        instructions: 'Keep the tests green.',
        avatarSeed: 'b'.repeat(64),
      },
      catalog: [],
      watchFilters: [],
    };

    expect(isAgentDetailView(detail)).toBe(true);
    expect(isAgentDetailView({ ...detail, soul: { ...detail.soul, instructions: '' } })).toBe(
      false,
    );
    expect(
      isAgentDetailView({
        ...detail,
        soul: { ...detail.soul, avatar: 'javascript:alert(1)' },
      }),
    ).toBe(false);
  });
});
