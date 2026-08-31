import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { RoomViewClient, RoomViewHttpError, type RoomView } from './room-view.js';
import { isAgentDetailView, isRoomView, isRoomViewMessage } from './surface-guards.js';

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
  it('normalizes an older successful pairing claim without inherited Room IDs', async () => {
    const identity = createIdentity('room-view-pairing-compat');
    const fetch = vi.fn(async () =>
      Response.json({
        workspaceId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        pairedBy: 'b'.repeat(64),
        joined: true,
      }),
    );
    const claim = await new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch,
    }).claimAgentPairing('BUZZ-ABCD-EFGH');

    expect(claim.attachedRoomIds).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      code: 'BUZZ-ABCD-EFGH',
      capabilities: ['pairing-room-rollback'],
    });
  });

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

  it('signs the public origin when a local proxy canonicalizes the connection', async () => {
    const physicalFetch = vi.fn(async () => Response.json(room));
    const identity = createIdentity('room-view-explicit-host');
    await new RoomViewClient({
      baseUrl: 'http://127.0.0.1:3010',
      publicOrigin: 'http://10.0.2.2:3010',
      identity,
      fetch: physicalFetch,
    }).room(room.room.id);

    const [, init] = physicalFetch.mock.calls[0]!;
    const proof = JSON.parse(
      Buffer.from(init.headers.authorization.slice('Nostr '.length), 'base64').toString('utf8'),
    ) as { tags: string[][] };
    expect(proof.tags).toContainEqual(['u', `http://10.0.2.2:3010/room/${room.room.id}`]);
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
    const repository = {
      key: 'github:1',
      name: 'acme/repo',
      remote: 'git://github.com/acme/repo',
      targetBranch: 'main',
      updatedAt: 10,
      githubEventsEnabled: true,
    };
    expect(isRoomView({ ...room, repositoryResolution: 'repository', repository })).toBe(true);
    expect(
      isRoomView({
        ...room,
        repositoryResolution: 'repository',
        repository: { ...repository, updatedAt: undefined },
      }),
    ).toBe(false);
    expect(
      isRoomView({
        ...room,
        cornerLifecycle: { lifecycle: 'APPROVED', checks: 'unknown' },
      }),
    ).toBe(false);
    expect(
      isRoomView({
        ...room,
        watchFilters: [{ kinds: [30078], authors: ['a'.repeat(64)], '#t': ['agent-presence'] }],
      }),
    ).toBe(true);
    expect(
      isRoomView({
        ...room,
        watchFilters: [{ kinds: [30078], '#t': 'agent-presence' }],
      }),
    ).toBe(false);
  });

  it('accepts only valid GitHub activity cards', () => {
    const message = {
      id: 'b'.repeat(64),
      text: 'Pull request opened',
      createdAt: 3,
      author: room.viewer.identity,
      presentation: 'card' as const,
      githubEvent: {
        type: 'pull-request' as const,
        action: 'opened' as const,
        actor: 'octocat',
        title: 'Ship it',
        url: 'https://github.com/acme/repo/pull/1',
      },
    };

    expect(isRoomViewMessage(message)).toBe(true);
    expect(
      isRoomViewMessage({
        ...message,
        githubEvent: { ...message.githubEvent, type: 'not-real' },
      }),
    ).toBe(false);
    expect(
      isRoomViewMessage({
        ...message,
        githubEvent: { ...message.githubEvent, type: 'issue', action: 'merged' },
      }),
    ).toBe(false);
    expect(
      isRoomViewMessage({
        ...message,
        githubEvent: { ...message.githubEvent, url: 'javascript:alert(1)' },
      }),
    ).toBe(false);
  });

  it('accepts only complete typed daemon fact cards', () => {
    const message = {
      id: 'b'.repeat(64),
      text: '',
      createdAt: 3,
      author: room.viewer.identity,
      presentation: 'card' as const,
      daemonFact: {
        type: 'corner-complete' as const,
        cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
        objective: 'Ship fact cards',
        outcome: 'landed' as const,
        pullRequest: { number: 42, url: 'https://github.com/acme/beeline/pull/42' },
        subgoals: [{ step: 'Project the card', status: 'completed' as const }],
      },
    };
    expect(isRoomViewMessage(message)).toBe(true);
    expect(
      isRoomViewMessage({
        ...message,
        daemonFact: { ...message.daemonFact, cornerId: 'not-a-corner' },
      }),
    ).toBe(false);
    expect(
      isRoomViewMessage({
        ...message,
        daemonFact: { ...message.daemonFact, outcome: undefined },
      }),
    ).toBe(false);
  });

  it('limits briefing messages to the server contract', () => {
    const briefingMessage = {
      id: 'b'.repeat(64),
      text: 'Briefing',
      createdAt: 3,
      author: room.viewer.identity,
      presentation: 'message' as const,
    };
    expect(
      isRoomView({ ...room, briefing: Array.from({ length: 10 }, () => briefingMessage) }),
    ).toBe(true);
    expect(
      isRoomView({ ...room, briefing: Array.from({ length: 11 }, () => briefingMessage) }),
    ).toBe(false);
  });

  it('accepts a retained finished-corner checklist but rejects malformed plan rows', () => {
    const cornerPlan = {
      objective: 'Keep the full objective available after completion.',
      items: [{ step: 'Publish the final response', status: 'completed' as const }],
    };
    expect(isRoomView({ ...room, cornerPlan })).toBe(true);
    expect(
      isRoomView({
        ...room,
        cornerPlan: { ...cornerPlan, items: [{ step: 'Bad state', status: 'not-real' }] },
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
