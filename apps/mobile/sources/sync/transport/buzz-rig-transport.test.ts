import { describe, expect, it, vi } from 'vitest';

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
  }),
}));
import {
  KIND_CHANNEL_MEMBERS,
  KIND_CORNER_STATE,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_AGENT_ACTIVITY,
  TAG_AGENT_PRESENCE,
  TAG_COMMUNITY,
  TAG_CORNER_STATE,
  TAG_PARENT,
  createWorkspaceSnapshot,
  createIdentity,
  reduceWorkspaceEvents,
  selectCorners,
  selectMembers,
  selectReplyTarget,
  selectTranscript,
  type IdentityRecord,
  type KnownMessageReference,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { BuzzRigTransport, __backdateRecentSnapshotForTests } from './buzz-rig-transport';
import { transcriptMessages } from './buzz-event-projection';
import type { SessionEvent } from './rig-transport';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ROOM = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const CORNER = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace';
const human = createIdentity('Captain');
const agent = createIdentity('Buzzy');
const peerAgent = createIdentity('Ox');
const unattachedAgent = createIdentity('Unattached');
const rotatingUnattachedAgent = createIdentity('Rotating unattached');
const relay = createIdentity('Relay');

function signed(
  source: typeof human,
  input: { created_at: number; kind: number; tags: string[][]; content: string },
): NostrEvent {
  return signEvent({ ...input, pubkey: source.publicKey }, source.secretKey);
}

function message(
  source: typeof human,
  body: string,
  at: number,
  tags: string[][] = [],
): NostrEvent {
  return signed(source, { created_at: at, kind: 9, tags: [['h', ROOM], ...tags], content: body });
}

function roomCreate(): NostrEvent {
  return signed(human, {
    created_at: 1,
    kind: KIND_CREATE_GROUP,
    tags: [
      ['h', ROOM],
      [TAG_COMMUNITY, WORKSPACE],
      ['name', 'Core Room'],
      ['p', human.publicKey, 'owner'],
      ['p', agent.publicKey, 'member'],
    ],
    content: '',
  });
}

function cornerCreate(): NostrEvent {
  return signed(agent, {
    created_at: 2,
    kind: KIND_CREATE_GROUP,
    tags: [
      ['h', CORNER],
      [TAG_PARENT, ROOM],
      ['name', 'Typed corner'],
      ['p', human.publicKey, 'member'],
      ['p', agent.publicKey, 'member'],
    ],
    content: '',
  });
}

function memberProjection(channelId: string): NostrEvent {
  return signed(relay, {
    created_at: 3,
    kind: KIND_CHANNEL_MEMBERS,
    tags: [
      ['d', channelId],
      ['p', human.publicKey, 'owner'],
      ['p', agent.publicKey, 'member'],
    ],
    content: '',
  });
}

function cornerState(): NostrEvent {
  return signed(agent, {
    created_at: 4,
    kind: KIND_CORNER_STATE,
    tags: [
      ['d', `${TAG_CORNER_STATE}:${CORNER}`],
      ['h', ROOM],
      ['t', TAG_CORNER_STATE],
      ['state', 'working'],
      ['at', '4'],
    ],
    content: '',
  });
}

const CORNER_2 = 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function cornerCreate2(): NostrEvent {
  return signed(agent, {
    created_at: 3,
    kind: KIND_CREATE_GROUP,
    tags: [
      ['h', CORNER_2],
      [TAG_PARENT, ROOM],
      ['name', 'Second corner'],
      ['p', human.publicKey, 'member'],
      ['p', agent.publicKey, 'member'],
    ],
    content: '',
  });
}

function memberProjection2(): NostrEvent {
  return signed(relay, {
    created_at: 4,
    kind: KIND_CHANNEL_MEMBERS,
    tags: [
      ['d', CORNER_2],
      ['p', human.publicKey, 'owner'],
      ['p', agent.publicKey, 'member'],
    ],
    content: '',
  });
}

function cornerState2(): NostrEvent {
  return signed(agent, {
    created_at: 5,
    kind: KIND_CORNER_STATE,
    tags: [
      ['d', `${TAG_CORNER_STATE}:${CORNER_2}`],
      ['h', ROOM],
      ['t', TAG_CORNER_STATE],
      ['state', 'working'],
      ['at', '5'],
    ],
    content: '',
  });
}

function clientFixture(
  input: {
    messages?: NostrEvent[];
    exactMessages?: NostrEvent[];
    corners?: boolean;
    secondCorner?: boolean;
  } = {},
) {
  const createEvents = input.corners
    ? [roomCreate(), cornerCreate(), ...(input.secondCorner ? [cornerCreate2()] : [])]
    : [roomCreate()];
  const projections = input.corners
    ? [
        memberProjection(ROOM),
        memberProjection(CORNER),
        ...(input.secondCorner ? [memberProjection2()] : []),
      ]
    : [memberProjection(ROOM)];
  let liveHandler: ((event: NostrEvent) => void) | undefined;
  const buildMessage = vi.fn(
    (
      channelId: string,
      body: string,
      options?: {
        mentionAgent?: string;
        mentionPubkeys?: string[];
        extraTags?: string[][];
      },
    ) =>
      signed(human, {
        created_at: 20,
        kind: 9,
        tags: [['h', channelId], ...(options?.extraTags ?? [])],
        content: body,
      }),
  );
  const buildReplyMessage = vi.fn(
    (
      body: string,
      parent: KnownMessageReference,
      options?: {
        mentionAgent?: string;
        mentionPubkeys?: string[];
        contentTags?: string[][];
      },
    ) =>
      signed(human, {
        created_at: 20,
        kind: 9,
        tags: [
          ['h', parent.channelId],
          ...(parent.rootId !== parent.eventId ? [['e', parent.rootId, '', 'root']] : []),
          ['e', parent.eventId, '', 'reply'],
          ...(options?.contentTags ?? []),
        ],
        content: body,
      }),
  );
  const client = {
    sessionEventsBackfill: vi.fn(async () => input.messages ?? []),
    getParentChannelId: vi.fn(async () => null),
    communityChannels: vi.fn(async () => [ROOM, OTHER_ROOM]),
    cornerStateBackfill: vi.fn(async (cornerIds: string[]) =>
      input.corners && cornerIds.includes(CORNER) ? [cornerState()] : [],
    ),
    listSubchannels: vi.fn(async () => (input.corners ? [CORNER] : [])),
    listMembers: vi.fn(async () => [
      { pubkey: human.publicKey, role: 'owner' },
      { pubkey: agent.publicKey, role: 'member' },
    ]),
    getChannelCommunityId: vi.fn(async () => WORKSPACE),
    listAgents: vi.fn(async () => [
      {
        pubkey: agent.publicKey,
        displayName: 'Buzzy',
        raw: { id: 'agent-identity' },
      },
    ]),
    listPersonProfiles: vi.fn(async () => [
      {
        pubkey: human.publicKey,
        name: 'Captain',
        handle: 'captain',
        raw: { id: 'human-identity' },
      },
    ]),
    query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
      const results: NostrEvent[] = [];
      for (const filter of filters) {
        const kinds = new Set((filter.kinds as number[] | undefined) ?? []);
        // Production indexing truth: parameterized-replaceable kind:30078 is
        // indexed by `#d` ONLY. An exact-`#d` key returns the record's
        // current value, a bare `#t` marker enumerates records, and a `#h`
        // filter matches NOTHING — even though every record carries an `h`
        // tag. A stub that answers kind:30078 by any tag shape cannot catch
        // an unanswerable discovery read (the live #488-class failure).
        if (kinds.has(KIND_CORNER_STATE)) {
          const dKeys = (filter['#d'] as string[] | undefined) ?? undefined;
          const tKeys = (filter['#t'] as string[] | undefined) ?? undefined;
          if (!input.corners) continue;
          if (dKeys && dKeys.length > 0) {
            // Production evidence distinguishes this from `#h`: multi-value
            // `#d` has proper OR semantics, so answer every requested key.
            if (dKeys.includes(`${TAG_CORNER_STATE}:${CORNER}`)) results.push(cornerState());
            if (dKeys.includes(`${TAG_CORNER_STATE}:${CORNER_2}`)) results.push(cornerState2());
          } else if (!dKeys && !filter['#h'] && tKeys?.includes(TAG_CORNER_STATE)) {
            results.push(cornerState());
            if (input.secondCorner) results.push(cornerState2());
          }
          continue;
        }
        if (kinds.has(KIND_CHANNEL_MEMBERS)) {
          const dKeys = (filter['#d'] as string[] | undefined) ?? undefined;
          if (dKeys && dKeys.length > 0) {
            results.push(
              ...projections.filter((event) =>
                event.tags.some((tag) => tag[0] === 'd' && dKeys.includes(tag[1]!)),
              ),
            );
          } else {
            results.push(...projections);
          }
        }
        if (kinds.has(KIND_CREATE_GROUP)) {
          // Production indexing truth (measured live, round-2 corner-discovery
          // failure): a filter naming MULTIPLE `#h` values is answered with an
          // unreliable subset of the matches — a whole corner family's create
          // events can collapse to one row. Only per-channel single-value `#h`
          // filters are answerable, so the faithful stub answers a multi-value
          // page with at most one event.
          const hKeys = (filter['#h'] as string[] | undefined) ?? undefined;
          const matches = createEvents.filter((event) =>
            event.tags.some((tag) => tag[0] === 'h' && (hKeys ?? []).includes(tag[1]!)),
          );
          results.push(
            ...(hKeys !== undefined && hKeys.length > 1 ? matches.slice(0, 1) : matches),
          );
        }
        if (kinds.has(KIND_STREAM_MESSAGE)) {
          const ids = (filter.ids as string[] | undefined) ?? [];
          const hKeys = (filter['#h'] as string[] | undefined) ?? [];
          results.push(
            ...(input.exactMessages ?? []).filter(
              (event) =>
                ids.includes(event.id) &&
                event.tags.some((tag) => tag[0] === 'h' && hKeys.includes(tag[1]!)),
            ),
          );
        }
      }
      return [...new Map(results.map((event) => [event.id, event])).values()];
    }),
    sessionEventsSubscribe: vi.fn(async (_id: string, handler: (event: NostrEvent) => void) => {
      liveHandler = handler;
      return vi.fn();
    }),
    getChannelMetadata: vi.fn(async () => ({ archived: false })),
    buildMessage,
    buildReplyMessage,
    publish: vi.fn(async () => undefined),
  };
  return { client, deliver: (event: NostrEvent) => liveHandler?.(event) };
}

function transportWith(client: ReturnType<typeof clientFixture>['client']): BuzzRigTransport {
  const transport = new BuzzRigTransport(human, 'https://relay.test');
  (transport as unknown as { client: unknown }).client = client;
  return transport;
}

describe('BuzzRigTransport typed read-model boundary', () => {
  it('parses relay history once and returns a normalized snapshot plus closed-union events', async () => {
    const activity = message(
      agent,
      JSON.stringify({
        sessionId: 's',
        update: { sessionUpdate: 'tool_call_update', title: 'Edit file', status: 'completed' },
      }),
      6,
      [['t', TAG_AGENT_ACTIVITY]],
    );
    const fixture = clientFixture({
      messages: [message(human, 'Human words survive', 5), activity],
    });
    const result = await transportWith(fixture.client).readModelBackfill(ROOM);

    expect(result.events.map((event) => event.type)).toEqual([
      'read-model',
      'read-model',
      'read-model',
      'read-model',
    ]);
    expect(
      selectTranscript(result.snapshot, ROOM).filter((item) => item.kind === 'human-message'),
    ).toHaveLength(1);
    // A settled routine tool update remains typed in the snapshot but is
    // spent transcript work: only live turns or consequential facts render.
    expect(selectTranscript(result.snapshot, ROOM).some((item) => item.kind === 'activity')).toBe(
      false,
    );
    expect(selectMembers(result.snapshot, ROOM).map((member) => member.pubkey)).toEqual(
      expect.arrayContaining([human.publicKey, agent.publicKey]),
    );
  });

  it('quarantines one malformed relay envelope without losing valid transcript history', async () => {
    const valid = message(human, 'Valid history survives', 5);
    const malformed = {
      ...message(human, 'Malformed transport value', 6),
      id: 'malformed-envelope',
      tags: null,
    } as unknown as NostrEvent;
    const fixture = clientFixture({ messages: [valid, malformed] });

    const result = await transportWith(fixture.client).readModelBackfill(ROOM);

    expect(
      selectTranscript(result.snapshot, ROOM).map((item) =>
        item.kind === 'human-message' || item.kind === 'agent-message' ? item.body : undefined,
      ),
    ).toContain('Valid history survives');
    expect(result.snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ eventId: 'malformed-envelope' }),
    );
  });

  it('starts live delivery at a bounded cursor and frame-coalesces a burst', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: unknown[] = [];
    const stop = await transport.sessionEventsSubscribeReady(
      ROOM,
      (event) => delivered.push(event),
      { since: 9 },
    );

    fixture.deliver(message(human, 'Live human message', 10));
    fixture.deliver(message(human, 'Live agent message', 11));
    expect(fixture.client.sessionEventsSubscribe).toHaveBeenCalledWith(ROOM, expect.any(Function), {
      since: 9,
    });
    expect(delivered).toEqual([]);
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(delivered).toEqual([
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({ type: 'human-message', body: 'Live human message' }),
      }),
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({ type: 'human-message', body: 'Live agent message' }),
      }),
    ]);
    stop();
  });

  it('re-resolves Room authority before projecting an exchange from a newly attached peer agent', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: SessionEvent[] = [];
    const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) => delivered.push(event));

    // The human opened the Room before Ox was attached, so the live
    // subscription holds the older, otherwise-valid authority snapshot.
    fixture.client.listMembers.mockResolvedValue([
      { pubkey: human.publicKey, role: 'owner' },
      { pubkey: agent.publicKey, role: 'member' },
      { pubkey: peerAgent.publicKey, role: 'member' },
    ]);
    fixture.client.listAgents.mockResolvedValue([
      { pubkey: agent.publicKey, displayName: 'Buzzy', raw: { id: 'agent-identity' } },
      { pubkey: peerAgent.publicKey, displayName: 'Ox', raw: { id: 'peer-agent-identity' } },
      {
        pubkey: unattachedAgent.publicKey,
        displayName: 'Unattached',
        raw: { id: 'unattached-agent-identity' },
      },
    ]);

    fixture.deliver(message(agent, 'A proven human-to-agent reply.', 11));
    fixture.deliver(
      message(peerAgent, 'A human in this Room should see this exchange turn.', 12, [
        ['t', 'agent-message'],
        ['t', 'buzz-agent-exchange'],
        ['exchange', 'human-authorization'],
        ['authorizer', human.publicKey],
        ['initiator', agent.publicKey],
        ['peer', peerAgent.publicKey],
        ['turn', '2'],
        ['p', agent.publicKey],
      ]),
    );
    fixture.deliver(
      signed(peerAgent, {
        created_at: 13,
        kind: 9,
        tags: [
          ['h', 'private-room-not-opened-by-this-human'],
          ['t', 'agent-message'],
          ['t', 'buzz-agent-exchange'],
        ],
        content: 'Private out-of-Room traffic.',
      }),
    );
    fixture.deliver(
      message(unattachedAgent, 'Same h, but the signer is not a Room member.', 14, [
        ['t', 'agent-message'],
        ['t', 'buzz-agent-exchange'],
      ]),
    );

    await vi.waitFor(() =>
      expect(delivered).toContainEqual(
        expect.objectContaining({
          type: 'read-model',
          event: expect.objectContaining({
            type: 'agent-message',
            authorPubkey: peerAgent.publicKey,
          }),
        }),
      ),
    );
    expect(fixture.client.listMembers).toHaveBeenCalledTimes(2);
    expect(fixture.client.listAgents).toHaveBeenLastCalledWith(WORKSPACE, {
      forceRefresh: true,
    });

    const readEvents = delivered.flatMap((event) =>
      event.type === 'read-model' && event.event.type !== 'unknown' ? [event.event] : [],
    );
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({
        workspaceId: WORKSPACE,
        identities: [
          {
            kind: 'human',
            pubkey: human.publicKey,
            displayName: 'Captain',
            revision: 'human-identity',
          },
          {
            kind: 'agent',
            pubkey: agent.publicKey,
            displayName: 'Buzzy',
            revision: 'agent-identity',
          },
          {
            kind: 'agent',
            pubkey: peerAgent.publicKey,
            displayName: 'Ox',
            revision: 'peer-agent-identity',
          },
        ] as IdentityRecord[],
      }),
      readEvents,
    );
    expect(
      transcriptMessages(snapshot, ROOM, human.publicKey).map((item) => ({
        text: item.text,
        agent: item.isAgentAuthor,
      })),
    ).toEqual([
      { text: 'A proven human-to-agent reply.', agent: true },
      { text: 'A human in this Room should see this exchange turn.', agent: true },
    ]);
    expect(delivered).toContainEqual(
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({ type: 'unknown', reason: 'foreign-channel' }),
      }),
    );
    expect(delivered).toContainEqual(
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({
          type: 'unknown',
          reason: 'unresolved-identity',
          authorPubkey: unattachedAgent.publicKey,
        }),
      }),
    );
    for (const event of [
      ...delivered.flatMap((item) => (item.type === 'read-model' ? [item.event] : [])),
    ]) {
      expect(
        delivered.filter(
          (item) => item.type === 'read-model' && item.event.eventId === event.eventId,
        ),
      ).toHaveLength(1);
    }
    stop();
  });

  it('retains unresolved diagnostics and agent lanes when the forced directory refresh fails', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: SessionEvent[] = [];
    const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) => delivered.push(event));
    fixture.client.listMembers.mockResolvedValue([
      { pubkey: human.publicKey, role: 'owner' },
      { pubkey: agent.publicKey, role: 'member' },
      { pubkey: peerAgent.publicKey, role: 'member' },
    ]);
    fixture.client.listAgents.mockRejectedValueOnce(new Error('agent directory unavailable'));

    const first = message(peerAgent, 'First unresolved turn.', 20);
    const second = message(peerAgent, 'Second unresolved turn.', 21);
    fixture.deliver(first);
    fixture.deliver(
      message(
        agent,
        JSON.stringify({
          sessionId: ROOM,
          update: { sessionUpdate: 'tool_call_update', title: 'Read file', status: 'completed' },
        }),
        20,
        [['t', TAG_AGENT_ACTIVITY]],
      ),
    );
    await vi.waitFor(() =>
      expect(delivered).toContainEqual(
        expect.objectContaining({
          type: 'read-model',
          event: expect.objectContaining({ eventId: first.id, reason: 'unresolved-identity' }),
        }),
      ),
    );
    fixture.deliver(second);
    await vi.waitFor(() =>
      expect(delivered).toContainEqual(
        expect.objectContaining({
          type: 'read-model',
          event: expect.objectContaining({ eventId: second.id, reason: 'unresolved-identity' }),
        }),
      ),
    );

    expect(fixture.client.listMembers).toHaveBeenCalledTimes(2);
    expect(fixture.client.listAgents).toHaveBeenCalledTimes(2);
    expect(delivered).toContainEqual(
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({ type: 'activity', authorPubkey: agent.publicKey }),
      }),
    );
    expect(
      delivered.filter(
        (item) =>
          item.type === 'read-model' && (item.event.eventId === first.id || item.event.eventId === second.id),
      ),
    ).toHaveLength(2);
    stop();
  });

  it('never reuses a superset Room identity cache to authorize another Room', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    fixture.client.listMembers.mockImplementation(async (channelId: string) =>
      channelId === ROOM
        ? [
            { pubkey: human.publicKey, role: 'owner' },
            { pubkey: agent.publicKey, role: 'member' },
            { pubkey: peerAgent.publicKey, role: 'member' },
          ]
        : [
            { pubkey: human.publicKey, role: 'owner' },
            { pubkey: agent.publicKey, role: 'member' },
          ],
    );
    fixture.client.listAgents.mockResolvedValue([
      { pubkey: agent.publicKey, displayName: 'Buzzy', raw: { id: 'agent-identity' } },
      { pubkey: peerAgent.publicKey, displayName: 'Ox', raw: { id: 'peer-agent-identity' } },
    ]);

    const stopFirst = await transport.sessionEventsSubscribeReady(ROOM, vi.fn());
    stopFirst();
    const delivered: SessionEvent[] = [];
    const stopSecond = await transport.sessionEventsSubscribeReady(OTHER_ROOM, (event) =>
      delivered.push(event),
    );
    const wrongRoomAuthor = signed(peerAgent, {
      created_at: 25,
      kind: 9,
      tags: [['h', OTHER_ROOM]],
      content: 'Room A membership cannot authorize Room B.',
    });
    fixture.deliver(wrongRoomAuthor);

    await vi.waitFor(() =>
      expect(delivered).toContainEqual(
        expect.objectContaining({
          type: 'read-model',
          event: expect.objectContaining({
            eventId: wrongRoomAuthor.id,
            type: 'unknown',
            reason: 'unresolved-identity',
          }),
        }),
      ),
    );
    expect(fixture.client.listAgents).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it('queues live events that arrive during authority recovery and delivers each once in order', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: SessionEvent[] = [];
    const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) => delivered.push(event));
    let resolveMembers!: (members: Array<{ pubkey: string; role: string }>) => void;
    const membersReady = new Promise<Array<{ pubkey: string; role: string }>>((resolve) => {
      resolveMembers = resolve;
    });
    fixture.client.listMembers.mockImplementationOnce(() => membersReady);
    fixture.client.listAgents.mockResolvedValue([
      { pubkey: agent.publicKey, displayName: 'Buzzy', raw: { id: 'agent-identity' } },
      { pubkey: peerAgent.publicKey, displayName: 'Ox', raw: { id: 'peer-agent-identity' } },
    ]);

    const exchange = message(peerAgent, 'Exchange waits for fresh authority.', 30);
    const known = message(agent, 'Already-known author waits behind it.', 31);
    fixture.deliver(exchange);
    await vi.waitFor(() => expect(fixture.client.listMembers).toHaveBeenCalledTimes(2));
    fixture.deliver(known);
    resolveMembers([
      { pubkey: human.publicKey, role: 'owner' },
      { pubkey: agent.publicKey, role: 'member' },
      { pubkey: peerAgent.publicKey, role: 'member' },
    ]);

    await vi.waitFor(() => expect(delivered).toHaveLength(2));
    expect(
      delivered.map((item) => (item.type === 'read-model' ? item.event.eventId : undefined)),
    ).toEqual([exchange.id, known.id]);
    stop();
  });

  it('bounds unresolved-author recovery so unattached traffic cannot stall known live events', async () => {
    vi.useFakeTimers();
    try {
      const fixture = clientFixture();
      const transport = transportWith(fixture.client);
      const delivered: SessionEvent[] = [];
      const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) =>
        delivered.push(event),
      );
      fixture.client.listMembers.mockImplementationOnce(
        () => new Promise<Array<{ pubkey: string; role: string }>>(() => undefined),
      );

      const unattached = message(unattachedAgent, 'Unattached traffic cannot hold the queue.', 35);
      const known = message(agent, 'Known live traffic must keep moving.', 36);
      fixture.deliver(unattached);
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.client.listMembers).toHaveBeenCalledTimes(2);
      fixture.deliver(known);

      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(
        delivered.map((item) => {
          if (item.type !== 'read-model') return undefined;
          return {
            eventId: item.event.eventId,
            type: item.event.type,
            reason: item.event.type === 'unknown' ? item.event.reason : undefined,
          };
        }),
      ).toEqual([
        { eventId: unattached.id, type: 'unknown', reason: 'unresolved-identity' },
        { eventId: known.id, type: 'agent-message', reason: undefined },
      ]);

      const rotating = message(
        rotatingUnattachedAgent,
        'A different unattached key cannot buy another queue stall.',
        37,
      );
      const laterKnown = message(agent, 'Known traffic still drains immediately.', 38);
      fixture.deliver(rotating);
      fixture.deliver(laterKnown);
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.client.listMembers).toHaveBeenCalledTimes(2);
      expect(
        delivered.slice(2).map((item) => {
          if (item.type !== 'read-model') return undefined;
          return {
            eventId: item.event.eventId,
            type: item.event.type,
            reason: item.event.type === 'unknown' ? item.event.reason : undefined,
          };
        }),
      ).toEqual([
        { eventId: rotating.id, type: 'unknown', reason: 'unresolved-identity' },
        { eventId: laterKnown.id, type: 'agent-message', reason: undefined },
      ]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses a recovered batch after the live subscription stops', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: SessionEvent[] = [];
    const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) => delivered.push(event));
    let resolveMembers!: (members: Array<{ pubkey: string; role: string }>) => void;
    const membersReady = new Promise<Array<{ pubkey: string; role: string }>>((resolve) => {
      resolveMembers = resolve;
    });
    fixture.client.listMembers.mockImplementationOnce(() => membersReady);

    fixture.deliver(message(peerAgent, 'Do not deliver after stop.', 40));
    await vi.waitFor(() => expect(fixture.client.listMembers).toHaveBeenCalledTimes(2));
    stop();
    resolveMembers([
      { pubkey: human.publicKey, role: 'owner' },
      { pubkey: agent.publicKey, role: 'member' },
      { pubkey: peerAgent.publicKey, role: 'member' },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toEqual([]);
  });

  it('publishes replies only from the snapshot-owned same-Room reference', async () => {
    const parent = message(human, 'Known parent', 5);
    const fixture = clientFixture({ messages: [parent] });
    const transport = transportWith(fixture.client);
    const result = await transport.readModelBackfill(ROOM);
    const selected = selectReplyTarget(result.snapshot, ROOM, parent.id);
    if (selected.status !== 'available') throw new Error('fixture parent was not selected');

    fixture.client.query.mockClear();
    await transport.messageSubmitReply('Typed reply', selected.reference);

    expect(fixture.client.query).not.toHaveBeenCalled();
    expect(fixture.client.buildReplyMessage).toHaveBeenCalledWith(
      'Typed reply',
      selected.reference,
      {},
    );
    expect(fixture.client.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes the existing thread root when replying to an incremental threaded message', async () => {
    const root = message(human, 'Thread root', 5);
    const parent = message(agent, 'First reply', 6, [
      ['e', root.id, '', 'root'],
      ['e', root.id, '', 'reply'],
    ]);
    const threadedParent = message(human, 'Reply to the first reply', 7, [
      ['e', root.id, '', 'root'],
      ['e', parent.id, '', 'reply'],
    ]);
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);

    const initial = await transport.readModelSnapshot(ROOM, [root, parent]);
    const incremental = await transport.readModelSnapshot(ROOM, [threadedParent]);
    const snapshot = reduceWorkspaceEvents(
      initial,
      Object.values(incremental.rooms[ROOM]!.eventJournal),
    );
    const selected = selectReplyTarget(snapshot, ROOM, threadedParent.id);
    if (selected.status !== 'available') throw new Error('threaded parent was not selected');

    await transport.messageSubmitReply('Deeper reply', selected.reference);

    // The incremental parse of the threaded parent records a mid-thread
    // rootId, so the transport must hand the builder a proof corrected to the
    // observed thread root — signing root=R / reply=threadedParent.
    expect(fixture.client.buildReplyMessage).toHaveBeenCalledWith(
      'Deeper reply',
      { ...selected.reference, rootId: root.id },
      {},
    );
  });

  it('climbs observed reply ancestry before signing when remembered roots are stale', async () => {
    // Thread R -> A -> B -> C where every remembered rootId is stale
    // (mid-thread) but the raw-tag parent links are intact — the shape a
    // truncated or incremental history leaves behind. Signing must derive
    // the root by climbing parents, not by trusting any stored rootId.
    const root = message(human, 'Thread root', 5);
    const first = message(agent, 'First reply', 6, [
      ['e', root.id, '', 'root'],
      ['e', root.id, '', 'reply'],
    ]);
    const second = message(human, 'Second reply', 7, [
      ['e', root.id, '', 'root'],
      ['e', first.id, '', 'reply'],
    ]);
    const third = message(agent, 'Third reply', 8, [
      ['e', root.id, '', 'root'],
      ['e', second.id, '', 'reply'],
    ]);
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const fresh = await transport.readModelSnapshot(ROOM, [root, first, second, third]);

    // Stale both everywhere: the session memory and the selected-from
    // snapshot each record every reply's root as its immediate parent.
    const staleParents = new Map([
      [first.id, root.id],
      [second.id, first.id],
      [third.id, second.id],
    ]);
    const memory = transport as unknown as {
      knownMessages: Map<string, { channelId: string; rootId: string; parentId?: string }>;
    };
    for (const [eventId, wrongRoot] of staleParents) {
      const entry = memory.knownMessages.get(eventId);
      if (!entry) throw new Error('threaded message was not remembered');
      memory.knownMessages.set(eventId, { ...entry, rootId: wrongRoot });
    }
    const room = fresh.rooms[ROOM]!;
    const staleJournal = Object.fromEntries(
      Object.entries(room.eventJournal).map(([eventId, event]) => {
        const wrongRoot = staleParents.get(eventId);
        if (!wrongRoot || (event.type !== 'human-message' && event.type !== 'agent-message')) {
          return [eventId, event];
        }
        return [eventId, { ...event, reply: { ...event.reply!, rootId: wrongRoot } }];
      }),
    );
    const stale = { ...fresh, rooms: { ...fresh.rooms, [ROOM]: { ...room, eventJournal: staleJournal } } };

    const selected = selectReplyTarget(stale, ROOM, third.id);
    if (selected.status !== 'available') throw new Error('deep reply was not selected');

    await transport.messageSubmitReply('Deepest reply', selected.reference);

    // The builder receives the proof with the re-derived true root and signs
    // root=R / reply=C from it.
    expect(fixture.client.buildReplyMessage).toHaveBeenCalledWith(
      'Deepest reply',
      { ...selected.reference, rootId: root.id },
      {},
    );
    expect(fixture.client.publish).toHaveBeenCalledTimes(1);
  });

  it('exact-fetches absent cold-cache ancestry before signing a nested reply', async () => {
    const root = message(human, 'Thread root', 5);
    const first = message(agent, 'First reply', 6, [
      ['e', root.id, '', 'root'],
      ['e', root.id, '', 'reply'],
    ]);
    const nested = message(agent, 'Nested reply', 7, [
      ['e', root.id, '', 'root'],
      ['e', first.id, '', 'reply'],
    ]);

    // Build the projection through the production parser, then model a cold,
    // truncated persisted Room: the visible nested message survives, its
    // parent/root rows do not, and its stored root is the mid-thread guess.
    const warmFixture = clientFixture();
    const warmTransport = transportWith(warmFixture.client);
    const firstPage = await warmTransport.readModelSnapshot(ROOM, [root, first]);
    const nestedPage = await warmTransport.readModelSnapshot(ROOM, [nested]);
    const complete = reduceWorkspaceEvents(
      firstPage,
      Object.values(nestedPage.rooms[ROOM]!.eventJournal),
    );
    const completeRoom = complete.rooms[ROOM]!;
    const nestedEvent = completeRoom.eventJournal[nested.id];
    if (
      !nestedEvent ||
      (nestedEvent.type !== 'human-message' && nestedEvent.type !== 'agent-message')
    ) {
      throw new Error('nested fixture message was not parsed');
    }
    const cold = {
      ...complete,
      rooms: {
        ...complete.rooms,
        [ROOM]: {
          ...completeRoom,
          eventJournal: {
            [nested.id]: {
              ...nestedEvent,
              reply: { ...nestedEvent.reply!, rootId: first.id },
            },
          },
        },
      },
    };
    const selected = selectReplyTarget(cold, ROOM, nested.id);
    if (selected.status !== 'available') throw new Error('cold cached reply was not selected');
    expect(selected.reference.rootId).toBe(first.id);

    // A fresh transport has no in-memory ancestry, but the exact parent and
    // true root remain fetchable from the relay before construction.
    const coldFixture = clientFixture({ exactMessages: [nested, first, root] });
    const coldTransport = transportWith(coldFixture.client);
    expect(
      (coldTransport as unknown as { knownMessages: Map<string, unknown> }).knownMessages.size,
    ).toBe(0);

    await coldTransport.messageSubmitReply('Captain reply', selected.reference);

    expect(coldFixture.client.query).toHaveBeenCalledWith([
      { ids: [nested.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(coldFixture.client.query).toHaveBeenCalledWith([
      { ids: [first.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(coldFixture.client.query).toHaveBeenCalledWith([
      { ids: [root.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(coldFixture.client.buildReplyMessage).toHaveBeenCalledWith(
      'Captain reply',
      { ...selected.reference, rootId: root.id },
      {},
    );
    expect(coldFixture.client.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps exact-fetch failure typed and retryable without signing or publishing', async () => {
    const root = message(human, 'Unavailable root', 5);
    const first = message(agent, 'Unavailable first reply', 6, [['e', root.id, '', 'reply']]);
    const nested = message(agent, 'Nested reply with missing root', 7, [
      ['e', root.id, '', 'root'],
      ['e', first.id, '', 'reply'],
    ]);
    const fixture = clientFixture({ exactMessages: [nested, first] });
    const transport = transportWith(fixture.client);
    const coldReference = {
      channelId: ROOM,
      eventId: nested.id,
      rootId: first.id,
    } as KnownMessageReference;

    await expect(transport.messageSubmitReply('Do not sign', coldReference)).rejects.toMatchObject({
      name: 'RelayPublishError',
      kind: 'TRANSIENT',
      retryable: true,
    });

    expect(fixture.client.query).toHaveBeenCalledWith([
      { ids: [nested.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(fixture.client.query).toHaveBeenCalledWith([
      { ids: [first.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(fixture.client.query).toHaveBeenCalledWith([
      { ids: [root.id], kinds: [KIND_STREAM_MESSAGE], '#h': [ROOM], limit: 1 },
    ]);
    expect(fixture.client.buildReplyMessage).not.toHaveBeenCalled();
    expect(fixture.client.publish).not.toHaveBeenCalled();
  });

  it('derives canonical corners from creator-authored lifecycle and verified membership', async () => {
    const fixture = clientFixture({ corners: true });
    const result = await transportWith(fixture.client).readModelBackfill(ROOM);
    expect(selectCorners(result.snapshot, ROOM)).toEqual([
      expect.objectContaining({
        kind: 'active',
        id: CORNER,
        state: 'working',
        humanMembers: [expect.objectContaining({ pubkey: human.publicKey })],
      }),
    ]);
  });

  it('never discovers corners through an unanswerable #h-shaped kind:30078 filter', async () => {
    // Production indexes parameterized-replaceable kind:30078 by `#d` ONLY:
    // a `#h` filter over it matches nothing even though every record carries
    // an `h` tag (the same relay truth as the presence and change-review
    // read-backs). A discovery read built on that shape made every Room read
    // as cornerless while the records sat on the relay. The stub above is
    // filter-faithful — it refuses exactly that shape — so this passes only
    // when discovery uses answerable filters end to end.
    const fixture = clientFixture({ corners: true });
    const result = await transportWith(fixture.client).readModelBackfill(ROOM);
    expect(selectCorners(result.snapshot, ROOM)).toHaveLength(1);
    const kindCornerStateFilters = fixture.client.query.mock.calls
      .flatMap((call) => call[0] as Array<Record<string, unknown>>)
      .filter((filter) =>
        ((filter.kinds as number[] | undefined) ?? []).includes(KIND_CORNER_STATE),
      );
    expect(kindCornerStateFilters.length).toBeGreaterThan(0);
    for (const filter of kindCornerStateFilters) {
      expect(filter['#h']).toBeUndefined();
    }
    // The exact-`#d` state read-back rides the same batched call shape. Its
    // cardinality is intentionally not constrained by this `#h` regression.
    const exactKeyStateFilters = kindCornerStateFilters.filter((filter) => filter['#d']);
    expect(exactKeyStateFilters.length).toBeGreaterThan(0);
    // Discovery rides the marker page and exact-`#d` read-back, never the
    // relay-wide kind:9007 child scan.
    expect(fixture.client.listSubchannels).not.toHaveBeenCalled();
  });

  it('recovers a multi-corner family through one batch of single-#h structural filters', async () => {
    // Production relay truth (round-2 corner-discovery failure): one filter
    // naming MULTIPLE `#h` values is answered with an unreliable subset —
    // measured live, eight corners' create events collapsed to one row. With
    // its creator fact missing, every corner-state record failed the parser's
    // signer check and the Room rendered cornerless while `listSubchannels`
    // stayed healthy. The stub above now reproduces that lossy shape
    // faithfully, so this passes only when the structural read expands into
    // per-channel single-value filters (inside ONE query call).
    const fixture = clientFixture({ corners: true, secondCorner: true });
    const result = await transportWith(fixture.client).readModelBackfill(ROOM);
    expect(selectCorners(result.snapshot, ROOM).map((corner) => corner.id)).toEqual(
      expect.arrayContaining([CORNER, CORNER_2]),
    );

    const queryCalls = fixture.client.query.mock.calls.map(
      (call) => call[0] as Array<Record<string, unknown>>,
    );
    const allFilters = queryCalls.flat();
    for (const filter of allFilters) {
      const hKeys = filter['#h'] as string[] | undefined;
      if (hKeys) expect(hKeys).toHaveLength(1);
    }
    const structuralBatches = queryCalls.filter((filters) =>
      filters.some(
        (filter) =>
          ((filter.kinds as number[] | undefined) ?? []).includes(KIND_CREATE_GROUP) &&
          filter['#h'] !== undefined,
      ),
    );
    expect(structuralBatches).toHaveLength(1);
    expect(
      structuralBatches[0]!
        .flatMap((filter) => (filter['#h'] as string[] | undefined) ?? [])
        .sort(),
    ).toEqual([CORNER, CORNER_2, ROOM, CORNER, CORNER_2, ROOM].sort());
    // Marker discovery + one structural/projection batch + exact-state read:
    // bounded calls and one structural network round trip for the whole family.
    expect(fixture.client.query.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('keeps presence and cross-Room lifecycle fan-outs free of multi-value #h filters', async () => {
    const fixture = clientFixture({ corners: true });
    const transport = transportWith(fixture.client);

    await transport.agentPresenceBackfillForWorkspace(WORKSPACE);
    const presenceCalls = fixture.client.query.mock.calls
      .map((call) => call[0] as Array<Record<string, unknown>>)
      .filter((filters) =>
        filters.some((filter) =>
          ((filter['#d'] as string[] | undefined) ?? []).some((value) =>
            value.startsWith(`${TAG_AGENT_PRESENCE}:`),
          ),
        ),
      );
    expect(presenceCalls).toHaveLength(1);
    const presenceCall = presenceCalls[0]!;
    expect(presenceCall).toHaveLength(2);
    expect(presenceCall.every((filter) => filter['#h'] === undefined)).toBe(true);
    expect(presenceCall.every((filter) => filter['#d'] !== undefined)).toBe(true);

    const lifecycle = await transport.listSubchannelLifecycleForRooms([ROOM, OTHER_ROOM]);

    expect(lifecycle.has(ROOM)).toBe(true);
    expect(lifecycle.has(OTHER_ROOM)).toBe(true);
    const filters = fixture.client.query.mock.calls.flatMap(
      (call) => call[0] as Array<Record<string, unknown>>,
    );
    for (const filter of filters) {
      const hKeys = filter['#h'] as string[] | undefined;
      if (hKeys) expect(hKeys).toHaveLength(1);
    }
  });

  it('never commits an empty corner family over a proven non-empty one', async () => {
    // Close-one-corner wipe root: a partial/failed re-read answered EMPTY and
    // that answer was committed as authoritative over a family the previous
    // read proved non-empty. The completeness guard re-reads once before
    // believing an empty answer; the confirming read recovers the survivors.
    const fixture = clientFixture({ corners: true });
    const transport = transportWith(fixture.client);
    await transport.readModelBackfill(ROOM); // warm: prior family is non-empty
    __backdateRecentSnapshotForTests(fixture.client, ROOM);

    let calls = 0;
    const original = transport.readModelBackfill.bind(transport);
    vi.spyOn(transport as unknown as {
      readModelBackfill: typeof transport.readModelBackfill;
    }, 'readModelBackfill').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) {
        // One transiently empty (partial) re-read...
        return Promise.resolve({
          snapshot: createWorkspaceSnapshot(ROOM as unknown as Parameters<typeof createWorkspaceSnapshot>[0]),
        } as Awaited<ReturnType<typeof transport.readModelBackfill>>);
      }
      return original(...(args as Parameters<typeof transport.readModelBackfill>));
    });

    const corners = await transport.listSubchannelLifecycle(ROOM);
    expect(corners.map((corner) => corner.id)).toContain(CORNER);
    expect(calls).toBe(2);
  });

  it('hydrates 200+ messages plus a corner without per-channel authority fan-out', async () => {
    const messages = Array.from({ length: 240 }, (_, index) =>
      message(human, `History ${index + 1}`, 10 + index),
    );
    const fixture = clientFixture({ messages, corners: true });

    const result = await transportWith(fixture.client).readModelBackfill(ROOM, { limit: 240 });

    expect(selectTranscript(result.snapshot, ROOM)).toHaveLength(240);
    expect(selectCorners(result.snapshot, ROOM)).toHaveLength(1);
    expect(fixture.client.listSubchannels).not.toHaveBeenCalled();
    expect(fixture.client.listMembers).not.toHaveBeenCalled();
    expect(fixture.client.getChannelCommunityId).not.toHaveBeenCalled();
    expect(fixture.client.listAgents).toHaveBeenCalledTimes(1);
    expect(fixture.client.listPersonProfiles).toHaveBeenCalledTimes(1);
    // Marker-page discovery + one structural/projection batch + the exact-#d
    // corner-state read-back: still bounded, still no per-channel fan-out.
    expect(fixture.client.query.mock.calls.length).toBeLessThanOrEqual(3);
  }, 20_000);

  it('coalesces the transcript and corner-status snapshot reads for one Room open', async () => {
    const messages = Array.from({ length: 240 }, (_, index) =>
      message(human, `Concurrent history ${index + 1}`, 10 + index),
    );
    const fixture = clientFixture({ messages, corners: true });
    const transport = transportWith(fixture.client);

    const [result, corners] = await Promise.all([
      transport.readModelBackfill(ROOM, { limit: 240 }),
      transport.listSubchannelLifecycle(ROOM),
    ]);

    expect(selectTranscript(result.snapshot, ROOM)).toHaveLength(240);
    expect(corners).toHaveLength(1);
    expect(fixture.client.sessionEventsBackfill).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('uses metadata as the sole archive authority instead of scanning chat tags', async () => {
    const fixture = clientFixture();
    fixture.client.getChannelMetadata.mockResolvedValue({ archived: true });
    await expect(transportWith(fixture.client).isChannelArchived(ROOM)).resolves.toBe(true);
  });
});

describe('readModelTail cold-open fast path', () => {
  const cornerMessage = (source: typeof human | typeof agent, body: string, at: number): NostrEvent =>
    signed(source, { created_at: at, kind: 9, tags: [['h', CORNER]], content: body });

  function agentRegistryEvent(): NostrEvent {
    return signed(agent, {
      created_at: 4,
      kind: 9,
      tags: [
        ['t', 'buzz-agent'],
        ['agent', agent.publicKey],
        ['community', WORKSPACE],
      ],
      content: JSON.stringify({ displayName: 'Buzzy' }),
    });
  }

  it('paints the corner transcript from exactly ONE channel-scoped batched relay read', async () => {
    const messages = [
      cornerMessage(human, 'first', 5),
      cornerMessage(agent, 'second', 6),
      cornerMessage(human, 'third', 7),
      cornerMessage(agent, 'fourth', 8),
    ];
    let queryCalls = 0;
    const client = {
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        queryCalls += 1;
        // Exactly three filters: the bounded message tail, this channel's
        // immutable create event, and the agent registry page. Membership,
        // admin projections, and general structural history are DEFERRED —
        // they must not ride the first-paint read.
        expect(filters).toHaveLength(3);
        expect(filters.some((filter) => (filter.kinds as number[]).includes(KIND_CHANNEL_MEMBERS))).toBe(false);
        const results: NostrEvent[] = [];
        for (const filter of filters) {
          const kinds = filter.kinds as number[];
          if (filter['#h'] ?? filter['#d']) {
            // Per-key single-value filters only, all scoped to THIS channel:
            // never a multi-value array this relay answers lossily. The
            // registry page is the one relay-side-tag-matched exception.
            const values = ((filter['#h'] ?? filter['#d']) as string[] | undefined) ?? [];
            expect(values).toHaveLength(1);
            expect(values[0]).toBe(CORNER);
          } else {
            expect(filter['#t']).toEqual(['buzz-agent']);
          }
          if (kinds.includes(9)) {
            if (filter['#h']) results.push(...messages);
            else results.push(agentRegistryEvent());
          }
          if (kinds.includes(KIND_CREATE_GROUP)) results.push(cornerCreate());
        }
        return results;
      }),
    };
    const transport = transportWith(client as never);

    const result = await transport.readModelTail(CORNER, { limit: 200 });

    // The whole fast path is ONE relay round trip — no sibling discovery, no
    // family authority, no workspace directory on the critical path.
    expect(queryCalls).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    const transcript = selectTranscript(result.snapshot, CORNER);
    expect(transcript.map((item) => item.id)).toEqual(
      expect.arrayContaining(messages.map((event) => event.id)),
    );
    expect(transcript).toHaveLength(4);
    // The parser bootstrapped the registry page into an agent IdentityRecord,
    // so the agent's own rows classify as agent conversation, not prose.
    expect(result.snapshot.identities[agent.publicKey]?.kind).toBe('agent');
    const agentRows = result.events.filter(
      (event) =>
        event.type === 'read-model' &&
        event.event.type === 'agent-message' &&
        event.event.authorPubkey === agent.publicKey,
    );
    expect(agentRows.map((row) => (row.event as { body?: string }).body)).toEqual([
      'second',
      'fourth',
    ]);
    // Coverage marks the tail as the initial backfill so later revalidations
    // delta instead of re-running cold machinery.
    expect(result.snapshot.rooms[CORNER]?.coverage.initialBackfillComplete).toBe(true);
  }, 20_000);

  it('classifies a registered agent control marker as control, never as prose', async () => {
    const controlCard = signed(agent, {
      created_at: 9,
      kind: 9,
      tags: [
        ['h', CORNER],
        ['t', 'body-control'],
        ['subchannel', CORNER],
        ['status', 'working'],
      ],
      content: 'corner status working',
    });
    const client = {
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        const results: NostrEvent[] = [];
        for (const filter of filters) {
          const kinds = filter.kinds as number[];
          if (kinds.includes(9)) {
            if (filter['#h']) results.push(controlCard);
            else results.push(agentRegistryEvent());
          }
          if (kinds.includes(KIND_CREATE_GROUP)) results.push(cornerCreate());
        }
        return results;
      }),
    };
    const result = await transportWith(client as never).readModelTail(CORNER, { limit: 200 });

    const parsed = result.events.find(
      (event) => event.type === 'read-model' && event.event.eventId === controlCard.id,
    );
    expect(parsed && parsed.type === 'read-model' ? parsed.event.type : undefined).toBe('control');
    // And its text never became agent/human conversation prose — at most a
    // typed card projection, which is the correct rendering of a status card.
    const rows = selectTranscript(result.snapshot, CORNER);
    expect(rows.every((row) => !('body' in row && row.body === 'corner status working'))).toBe(
      true,
    );
    expect(rows.every((row) => row.kind === 'card')).toBe(true);
  }, 20_000);

  it('still classifies every fetched message even when its signer is missing from a lagging membership projection', async () => {
    const lateSignerMessage = cornerMessage(agent, 'posted before projection caught up', 9);
    const client = {
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        const results: NostrEvent[] = [];
        for (const filter of filters) {
          const kinds = filter.kinds as number[];
          if (kinds.includes(9)) results.push(lateSignerMessage);
          if (kinds.includes(KIND_CREATE_GROUP)) results.push(cornerCreate());
          // Membership projection deliberately omits the message signer.
          if (kinds.includes(KIND_CHANNEL_MEMBERS)) continue;
        }
        return results;
      }),
    };
    const transport = transportWith(client as never);

    const result = await transport.readModelTail(CORNER, { limit: 200 });

    // A lagging projection must not quarantine the row first paint came for.
    const unknown = result.events.filter(
      (event) => event.type === 'read-model' && event.event.type === 'unknown',
    );
    expect(unknown).toHaveLength(0);
    expect(selectTranscript(result.snapshot, CORNER)).toHaveLength(1);
  }, 20_000);
});
