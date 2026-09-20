import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity.js';
import { RoomViewClient, RoomViewHttpError, type RoomView } from './room-view.js';
import {
  isAgentDetailView,
  isRoomView,
  isRoomViewMessage,
  readAgentDetailView,
  readRoomView,
  readRoomViewMessage,
} from './surface-guards.js';

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

  it('keeps a complete Room readable when a legacy named role is nested in the projection', async () => {
    const asker = { pubkey: 'c'.repeat(64), kind: 'human' as const, name: 'Play Review' };
    const agent = { pubkey: 'd'.repeat(64), kind: 'agent' as const, name: 'Echo' };
    const requestId = 'e'.repeat(64);
    const response = {
      ...room,
      messages: [
        {
          id: requestId,
          text: 'Hey @echo, can you sign me up for Groq and get me an API key?',
          createdAt: 3,
          author: asker,
          presentation: 'message',
          reference: { channelId: room.room.id, eventId: requestId, rootId: requestId },
          mentionPubkeys: [agent.pubkey],
        },
        {
          id: 'f'.repeat(64),
          text: 'Ready.',
          createdAt: 4,
          author: agent,
          presentation: 'message',
          requestId,
          liveTurnId: `live-turn:${requestId}`,
          reference: {
            channelId: room.room.id,
            eventId: 'f'.repeat(64),
            rootId: 'f'.repeat(64),
          },
        },
      ],
      members: [
        { identity: asker, role: 'master' },
        { identity: agent, role: 'member' },
      ],
      latestAgentTurns: [
        {
          requestId,
          agentPubkey: agent.pubkey,
          status: 'complete',
          startedAt: 3,
          createdAt: 4,
          requestedBy: asker.pubkey,
        },
      ],
      viewer: { ...room.viewer, identity: asker, role: 'master' },
    };
    const identity = createIdentity('room-view-legacy-role');
    const fetch = vi.fn(async () => Response.json(response));
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch,
    });
    const value = await client.room(room.room.id);
    const reopened = await client.room(room.room.id);

    expect(value.messages.map((message) => message.text)).toEqual([
      'Hey @echo, can you sign me up for Groq and get me an API key?',
      'Ready.',
    ]);
    expect(reopened.messages).toEqual(value.messages);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((value.viewer as { role: string }).role).toBe('master');
    expect(readRoomView({ ...response, viewer: { ...response.viewer, role: 7 } })?.viewer.role).toBe(
      'member',
    );
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

  it('renders a Room when the server adds an unknown field and drops one unreadable message', async () => {
    const identity = createIdentity('room-view-tolerance');
    const value = await new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity,
      fetch: async () =>
        Response.json({
          ...room,
          corners: [],
          futureTopLevel: 'server-only',
          messages: [
            {
              id: 'b'.repeat(64),
              text: 'kept',
              createdAt: 3,
              author: room.viewer.identity,
              presentation: 'notice',
            },
            { id: 'not-enough' },
          ],
        }),
    }).room(room.room.id);

    expect(value.room.id).toBe(room.room.id);
    expect(value.messages).toEqual([
      {
        id: 'b'.repeat(64),
        text: 'kept',
        createdAt: 3,
        author: room.viewer.identity,
        presentation: 'message',
      },
    ]);
    expect('futureTopLevel' in value).toBe(false);
    expect('corners' in value).toBe(false);
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
    expect(readRoomView({ ...room, messages: [badMessage] })?.messages[0]?.attachments).toEqual([]);
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
    expect(readRoomView({ ...room, latestAgentTurns: [{ status: 'working' }] })?.latestAgentTurns).toEqual(
      [],
    );
    expect(readRoomView({ ...room, repositoryResolution: 'unknown' })?.repositoryResolution).toBe('none');
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
    ).toBe(true);
    expect(
      readRoomView({
        ...room,
        repositoryResolution: 'repository',
        repository: { ...repository, updatedAt: undefined },
      })?.repository,
    ).toBeUndefined();
    expect(
      isRoomView({
        ...room,
        cornerLifecycle: { lifecycle: 'APPROVED', checks: 'unknown' },
      }),
    ).toBe(true);
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
    ).toBe(true);
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
    ).toBe(true);
    expect(
      isRoomViewMessage({
        ...message,
        githubEvent: { ...message.githubEvent, type: 'issue', action: 'merged' },
      }),
    ).toBe(true);
    expect(
      readRoomViewMessage({
        ...message,
        githubEvent: { ...message.githubEvent, url: 'javascript:alert(1)' },
      })?.githubEvent,
    ).toBeUndefined();
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
      readRoomViewMessage({
        ...message,
        daemonFact: { ...message.daemonFact, cornerId: 'not-a-corner' },
      })?.daemonFact,
    ).toBeUndefined();
    expect(
      readRoomViewMessage({
        ...message,
        daemonFact: { ...message.daemonFact, outcome: undefined },
      })?.daemonFact,
    ).toBeUndefined();
  });

  it('accepts a corner-open daemon fact with its objective as the sole summary', () => {
    const message = {
      id: 'b'.repeat(64),
      text: '',
      createdAt: 3,
      author: room.viewer.identity,
      presentation: 'card' as const,
      daemonFact: {
        type: 'corner-open' as const,
        cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
        objective: 'Fix the flaky auth test',
      },
    };
    expect(isRoomViewMessage(message)).toBe(true);
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
      readRoomView({ ...room, briefing: Array.from({ length: 11 }, () => briefingMessage) })
        ?.briefing,
    ).toHaveLength(10);
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
    ).toBe(true);
    expect(
      readRoomView({
        ...room,
        cornerPlan: { ...cornerPlan, items: [{ step: 'Bad state', status: 'not-real' }] },
      })?.cornerPlan?.items,
    ).toEqual([]);
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
    expect(readAgentDetailView({ ...detail, soul: { ...detail.soul, instructions: '' } })?.soul).toBeUndefined();
    expect(
      readAgentDetailView({
        ...detail,
        soul: { ...detail.soul, avatar: 'javascript:alert(1)' },
      })?.soul?.avatar,
    ).toBeUndefined();
  });
});
