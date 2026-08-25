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
  TAG_CORNER_STATE,
  TAG_PARENT,
  createIdentity,
  selectCorners,
  selectMembers,
  selectReplyTarget,
  selectTranscript,
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
      if (kinds.has(KIND_CORNER_STATE)) return input.corners ? [cornerState()] : [];
      if (kinds.has(KIND_CHANNEL_MEMBERS)) return projections;
      if (kinds.has(KIND_CREATE_GROUP)) {
        const channels = new Set(filters.flatMap((filter) => filter['#h'] ?? []));
        return createEvents.filter((event) =>
          event.tags.some((tag) => tag[0] === 'h' && channels.has(tag[1]!)),
        );
      }
      return [];
    }),
    sessionEventsSubscribe: vi.fn(async (_id: string, handler: (event: NostrEvent) => void) => {
      liveHandler = handler;
      return vi.fn();
    }),
    getChannelMetadata: vi.fn(async () => ({ archived: false })),
    buildMessage,
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

  it('installs live delivery before yielding and emits only typed events', async () => {
    const fixture = clientFixture();
    const transport = transportWith(fixture.client);
    const delivered: unknown[] = [];
    const stop = await transport.sessionEventsSubscribeReady(ROOM, (event) =>
      delivered.push(event),
    );

    fixture.deliver(message(human, 'Live human message', 10));
    expect(delivered).toEqual([
      expect.objectContaining({
        type: 'read-model',
        event: expect.objectContaining({ type: 'human-message', body: 'Live human message' }),
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
    expect(fixture.client.buildMessage).toHaveBeenCalledWith(ROOM, 'Typed reply', {
      extraTags: [['e', parent.id, '', 'reply']],
    });
    expect(fixture.client.publish).toHaveBeenCalledTimes(1);
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

  it('uses metadata as the sole archive authority instead of scanning chat tags', async () => {
    const fixture = clientFixture();
    fixture.client.getChannelMetadata.mockResolvedValue({ archived: true });
    await expect(transportWith(fixture.client).isChannelArchived(ROOM)).resolves.toBe(true);
  });
});
