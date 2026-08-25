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
  TAG_AGENT_ACTIVITY,
  TAG_COMMUNITY,
  TAG_CORNER_STATE,
  TAG_PARENT,
  createIdentity,
  reduceWorkspaceEvents,
  selectCorners,
  selectMembers,
  selectReplyTarget,
  selectTranscript,
  type KnownMessageReference,
} from '@beeline/buzz-client';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { BuzzRigTransport } from './buzz-rig-transport';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CORNER = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const WORKSPACE = 'workspace';
const human = createIdentity('Captain');
const agent = createIdentity('Buzzy');
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

function clientFixture(input: { messages?: NostrEvent[]; corners?: boolean } = {}) {
  const createEvents = input.corners ? [roomCreate(), cornerCreate()] : [roomCreate()];
  const projections = input.corners
    ? [memberProjection(ROOM), memberProjection(CORNER)]
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
    query: vi.fn(async (filters: Array<{ kinds?: number[]; '#h'?: string[] }>) => {
      const kinds = new Set(filters.flatMap((filter) => filter.kinds ?? []));
      const results: NostrEvent[] = [];
      if (kinds.has(KIND_CORNER_STATE) && input.corners) results.push(cornerState());
      if (kinds.has(KIND_CHANNEL_MEMBERS)) results.push(...projections);
      if (kinds.has(KIND_CREATE_GROUP)) {
        const channels = new Set(filters.flatMap((filter) => filter['#h'] ?? []));
        results.push(
          ...createEvents.filter((event) =>
            event.tags.some((tag) => tag[0] === 'h' && channels.has(tag[1]!)),
          ),
        );
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

    expect(fixture.client.buildReplyMessage).toHaveBeenCalledWith(
      'Deeper reply',
      selected.reference,
      {},
    );
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
    expect(fixture.client.query.mock.calls.length).toBeLessThanOrEqual(2);
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
