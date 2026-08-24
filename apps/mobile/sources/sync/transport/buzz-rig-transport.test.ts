import { describe, expect, it, vi } from 'vitest';

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    relayUrl: 'https://relay.test',
    pushGatewayUrl: 'https://push.test',
  }),
}));

import type { SessionEvent as BuzzSessionEvent } from '@beeline/buzz-client';
import { toRigEvent } from './buzz-event-projection';
import { BuzzRigTransport } from './buzz-rig-transport';
import { roomRowPresentation } from '@/buzz/room-list-row';
import {
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_EVENT_KIND,
  CHANGE_REVIEW_MANIFEST_TAG,
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  TAG_PARENT,
  TAG_DIRECT_MESSAGE,
  type Identity,
  type RoomRepository,
} from '@beeline/buzz-client';

describe('Buzz branch-loop event projection', () => {
  it('preserves request and lifecycle tags for the mobile UI', () => {
    const event = {
      id: 'event-id',
      pubkey: 'a'.repeat(64),
      created_at: 42,
      kind: 9,
      tags: [
        ['h', 'channel'],
        ['t', 'buzz-agent-request'],
        ['p', 'b'.repeat(64)],
      ],
      content: 'Build it',
      sig: 'c'.repeat(128),
    };
    const projected = toRigEvent({
      kind: 'message',
      event,
      channelId: 'channel',
      content: event.content,
      pubkey: event.pubkey,
      createdAt: event.created_at,
      id: event.id,
    } as BuzzSessionEvent);

    expect(projected.type).toBe('raw');
    expect((projected as { payload: { tags: string[][] } }).payload.tags).toEqual(event.tags);
  });

  it('projects readable ACP message content instead of the raw JSON envelope', () => {
    const content = JSON.stringify({
      sessionId: 'ses_123',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'The work is complete.' },
      },
      projected: true,
    });
    const projected = toRigEvent({
      kind: 'agent-activity',
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content,
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'activity-one',
    });

    expect(projected).toMatchObject({
      type: 'assistant_delta',
      id: 'activity-one',
      text: 'The work is complete.',
      pubkey: 'a'.repeat(64),
    });
  });

  it('projects an ordered activity batch without exposing its wire envelope', () => {
    const projected = toRigEvent({
      kind: 'agent-activity',
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content: JSON.stringify({
        sessionId: 'ses_123',
        update: {
          sessionUpdate: 'activity_batch',
          updates: [
            { sessionUpdate: 'agent_message_chunk', content: { text: 'First' } },
            { sessionUpdate: 'tool_call_update', title: 'Edit file', status: 'completed' },
          ],
        },
        projected: true,
      }),
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'activity-batch',
    });

    expect(projected).toMatchObject({
      type: 'assistant_delta',
      text: 'First\nEdit file · completed',
      activity: [
        { kind: 'thinking', title: 'Thinking', text: 'First' },
        { kind: 'tool', title: 'Edit file', status: 'completed' },
      ],
    });
  });

  it('preserves compact turn details for file and tool drill-downs', () => {
    const projected = toRigEvent({
      kind: 'agent-activity',
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content: JSON.stringify({
        sessionId: 'ses_123',
        update: {
          sessionUpdate: 'activity_batch',
          updates: [
            {
              sessionUpdate: 'tool_activity',
              toolCallId: 'call-1',
              title: 'Apply patch',
              kind: 'edit',
              status: 'completed',
              command: 'git diff -- chat.tsx',
              output: 'Patch applied',
              files: [{ path: 'chat.tsx', diff: '+render summary' }],
              plan: { items: [{ step: 'Render summary', status: 'completed' }] },
            },
          ],
        },
      }),
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'activity-detail',
    });

    expect(projected).toMatchObject({
      type: 'assistant_delta',
      activity: [
        {
          kind: 'tool',
          id: 'call-1',
          toolKind: 'edit',
          command: 'git diff -- chat.tsx',
          output: 'Patch applied',
          files: [{ path: 'chat.tsx', diff: '+render summary' }],
          plan: { items: [{ step: 'Render summary', status: 'completed' }] },
        },
      ],
    });
  });

  it('extracts nested ACP tool output and keeps same-second events uniquely keyed', () => {
    const content = JSON.stringify({
      sessionId: 'ses_123',
      update: {
        sessionUpdate: 'tool_call_update',
        content: [{ type: 'content', content: { type: 'text', text: 'LOOP_PROOF.md created' } }],
      },
      projected: true,
    });
    const base = {
      kind: 'agent-activity' as const,
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      content,
      pubkey: 'a'.repeat(64),
      createdAt: 42,
    };
    const first = toRigEvent({ ...base, id: 'activity-one' });
    const second = toRigEvent({ ...base, id: 'activity-two' });

    expect(first).toMatchObject({ text: 'LOOP_PROOF.md created', id: 'activity-one', seq: 42 });
    expect(second).toMatchObject({ id: 'activity-two', seq: 42 });
    expect((first as { id?: string }).id).not.toBe((second as { id?: string }).id);
  });

  it('suppresses metadata-only ACP envelopes and preserves legacy plain text', () => {
    const base = {
      kind: 'agent-activity' as const,
      event: {} as BuzzSessionEvent['event'],
      channelId: 'channel',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
    };
    const metadata = toRigEvent({
      ...base,
      id: 'metadata',
      content: JSON.stringify({
        sessionId: 'ses_123',
        update: { sessionUpdate: 'session_info_update', _meta: { activeRunId: 'run_1' } },
        projected: true,
      }),
    });
    const legacy = toRigEvent({ ...base, id: 'legacy', content: 'agent is thinking' });

    expect(metadata).toMatchObject({ text: '' });
    expect(legacy).toMatchObject({ text: 'agent is thinking' });
  });
});

describe('Buzz transport bootstrap', () => {
  it('resolves an agent command record through the Room workspace root', async () => {
    const identity = {
      publicKey: 'd'.repeat(64),
      secretKey: new Uint8Array(32).fill(4),
      name: 'operator',
    } as Identity;
    const commandList = {
      communityId: 'workspace-root',
      agentPubkey: 'agent-pubkey',
      commands: [{ name: 'review', description: 'Review the diff' }],
      updatedAt: 42,
      raw: {
        tags: [['d', 'workspace-root:agent-pubkey']],
      },
    };
    const client = {
      getChannelCommunityId: vi.fn(async () => 'workspace-root'),
      getAgentCommands: vi.fn(async () => commandList),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentCommandsRead('room-id', 'agent-pubkey')).resolves.toBe(commandList);
    expect(client.getChannelCommunityId).toHaveBeenCalledWith('room-id');
    expect(client.getAgentCommands).toHaveBeenCalledWith('workspace-root', 'agent-pubkey');
  });

  it('does not turn a failed Workspace-scope read into a missing command record', async () => {
    const identity = {
      publicKey: 'd'.repeat(64),
      secretKey: new Uint8Array(32).fill(4),
      name: 'operator',
    } as Identity;
    const error = new Error('relay unavailable');
    const client = {
      getChannelCommunityId: vi.fn(async () => Promise.reject(error)),
      getAgentCommands: vi.fn(),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentCommandsRead('room-id', 'agent-pubkey')).rejects.toBe(error);
    expect(client.getAgentCommands).not.toHaveBeenCalled();
  });

  it('publishes replies with NIP-10 linkage and an explicit Agent address', async () => {
    const identity = {
      publicKey: 'd'.repeat(64),
      secretKey: new Uint8Array(32).fill(4),
      name: 'operator',
    } as Identity;
    const client = {
      query: vi.fn().mockResolvedValue([
        {
          id: 'original-message',
          tags: [['h', 'room']],
        },
      ]),
      messageSubmit: vi.fn().mockResolvedValue({ id: 'reply-event' }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(
      transport.messageSubmitReply(
        'room',
        '@Brisk Pilot Can you expand?',
        'original-message',
        'agent-pubkey',
      ),
    ).resolves.toBe('reply-event');
    expect(client.messageSubmit).toHaveBeenCalledWith('room', '@Brisk Pilot Can you expand?', {
      mentionAgent: 'agent-pubkey',
      extraTags: [['e', 'original-message', '', 'reply']],
    });
  });

  it('preserves the thread root when replying to an existing reply', async () => {
    const identity = {
      publicKey: 'd'.repeat(64),
      secretKey: new Uint8Array(32).fill(4),
      name: 'operator',
    } as Identity;
    const client = {
      query: vi.fn().mockResolvedValue([
        {
          id: 'agent-reply',
          tags: [['e', 'root-message', '', 'reply']],
        },
      ]),
      messageSubmit: vi.fn().mockResolvedValue({ id: 'nested-reply' }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.messageSubmitReply('room', 'Following up', 'agent-reply')).resolves.toBe(
      'nested-reply',
    );
    expect(client.query).toHaveBeenCalledWith([{ ids: ['agent-reply'], limit: 1 }]);
    expect(client.messageSubmit).toHaveBeenCalledWith('room', 'Following up', {
      extraTags: [
        ['e', 'root-message', '', 'root'],
        ['e', 'agent-reply', '', 'reply'],
      ],
    });
  });

  it('does not open a WebSocket for HTTP-only screen reads', async () => {
    const identity = {
      publicKey: 'f'.repeat(64),
      secretKey: new Uint8Array(32).fill(7),
      name: 'operator',
    } as Identity;

    const client = await new BuzzRigTransport(identity, 'https://relay.test').ensureClient();

    expect(client.socket).toBeNull();
  });

  it('reuses one socket owner across screens and disconnects it when relay scope changes', async () => {
    const identity = {
      publicKey: 'e'.repeat(64),
      secretKey: new Uint8Array(32).fill(6),
      name: 'operator',
    } as Identity;

    const firstScreen = new BuzzRigTransport(identity, 'https://pooled-relay.test/');
    const nextScreen = new BuzzRigTransport(identity, 'https://pooled-relay.test');

    const shared = await firstScreen.ensureClient();
    const disconnect = vi.spyOn(shared, 'disconnect');
    expect(await nextScreen.ensureClient()).toBe(shared);

    await new BuzzRigTransport(identity, 'https://other-relay.test').ensureClient();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('can await a live Room subscription before taking a backfill snapshot', async () => {
    const identity = {
      publicKey: 'c'.repeat(64),
      secretKey: new Uint8Array(32).fill(5),
      name: 'operator',
    } as Identity;
    const relayUnsubscribe = vi.fn();
    let relayHandler: ((event: BuzzSessionEvent) => void) | undefined;
    let installSubscription: ((unsubscribe: () => void) => void) | undefined;
    const client = {
      sessionEventsSubscribe: vi.fn((_room: string, handler: (event: BuzzSessionEvent) => void) => {
        relayHandler = handler;
        return new Promise<() => void>((resolve) => {
          installSubscription = resolve;
        });
      }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;
    const handler = vi.fn();

    const ready = transport.sessionEventsSubscribeReady('room', handler);
    await vi.waitFor(() => expect(client.sessionEventsSubscribe).toHaveBeenCalled());
    let settled = false;
    void ready.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    installSubscription?.(relayUnsubscribe);
    const stop = await ready;
    relayHandler?.({
      kind: 'message',
      event: {
        id: 'live',
        pubkey: 'a'.repeat(64),
        created_at: 42,
        kind: 9,
        tags: [['h', 'room']],
        content: 'arrived live',
        sig: 'b'.repeat(128),
      },
      channelId: 'room',
      content: 'arrived live',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'live',
    });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'raw' }));
    stop();
    expect(relayUnsubscribe).toHaveBeenCalledOnce();
  });
});

describe('Room-scoped agent presence transport', () => {
  const identity = {
    publicKey: 'd'.repeat(64),
    secretKey: new Uint8Array(32).fill(4),
    name: 'operator',
  } as Identity;

  it('backfills only the replaceable presence kind', async () => {
    const event = {
      kind: 'other' as const,
      event: {
        id: 'presence',
        pubkey: 'a'.repeat(64),
        created_at: 42,
        kind: 30078,
        tags: [['h', 'room']],
        content: 'online',
        sig: 'b'.repeat(128),
      },
      channelId: 'room',
      content: 'online',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'presence',
    } satisfies BuzzSessionEvent;
    const client = { agentPresenceBackfill: vi.fn(async () => [event]) };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentPresenceBackfill('room')).resolves.toHaveLength(1);
    expect(client.agentPresenceBackfill).toHaveBeenCalledWith('room');
  });

  it('fans a Workspace presence read across every Room the Workspace has, since presence is Room-scoped', async () => {
    const rawEvent = {
      id: 'presence',
      pubkey: 'a'.repeat(64),
      created_at: 42,
      kind: 30078,
      tags: [
        ['d', 'agent-presence:room-2'],
        ['h', 'room-2'],
        ['t', 'agent-presence'],
        ['agent', 'a'.repeat(64)],
        ['status', 'online'],
      ],
      content: 'online',
      sig: 'b'.repeat(128),
    };
    const client = {
      communityChannels: vi.fn(async () => ['room-1', 'room-2']),
      query: vi.fn(async () => [rawEvent]),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const events = await transport.agentPresenceBackfillForWorkspace('workspace-1');

    expect(client.communityChannels).toHaveBeenCalledWith('workspace-1');
    // By `#d`, not `#h`. This assertion used to pin the `#h` form — it
    // faithfully described what the code did and said nothing about whether
    // the relay would answer it, which it never does for a
    // parameterized-replaceable kind. A stub that returns events for any
    // filter cannot tell the difference; the live relay can, and did.
    expect(client.query).toHaveBeenCalledWith([
      {
        kinds: [30078],
        '#d': ['agent-presence:room-1', 'agent-presence:room-2'],
        limit: 200,
      },
    ]);
    expect(events).toEqual([expect.objectContaining({ type: 'raw', sessionId: 'room-2' })]);
  });

  it('never writes an `#h` filter on the Workspace presence read', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('./buzz-rig-transport.ts', import.meta.url)), 'utf8');
    const start = source.indexOf('async agentPresenceBackfillForWorkspace');
    const end = source.indexOf('async agentPresenceSubscribeReady');
    const fn = source.slice(start, end);
    expect(fn).toContain("'#d'");
    expect(fn).not.toContain("'#h'");
  });

  it('reads no presence for a Workspace with no Rooms, without querying the relay', async () => {
    const client = {
      communityChannels: vi.fn(async () => []),
      query: vi.fn(async () => []),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentPresenceBackfillForWorkspace('workspace-1')).resolves.toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('subscribes only to presence and releases the live subscription', async () => {
    const relayUnsubscribe = vi.fn();
    let relayHandler: ((event: BuzzSessionEvent) => void) | undefined;
    const client = {
      agentPresenceSubscribe: vi.fn(
        async (_room: string, handler: (event: BuzzSessionEvent) => void) => {
          relayHandler = handler;
          return relayUnsubscribe;
        },
      ),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;
    const handler = vi.fn();

    const stop = transport.agentPresenceSubscribe('room', handler);
    await vi.waitFor(() => expect(client.agentPresenceSubscribe).toHaveBeenCalled());
    expect(client.agentPresenceSubscribe).toHaveBeenCalledWith('room', expect.any(Function));
    relayHandler?.({
      kind: 'other',
      event: {
        id: 'presence',
        pubkey: 'a'.repeat(64),
        created_at: 42,
        kind: 30078,
        tags: [['h', 'room']],
        content: 'online',
        sig: 'b'.repeat(128),
      },
      channelId: 'room',
      content: 'online',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'presence',
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'raw', sessionId: 'room' }),
    );
    stop();
    expect(relayUnsubscribe).toHaveBeenCalledOnce();
  });
});

describe('Room-scoped live agent draft transport', () => {
  const identity = {
    publicKey: 'd'.repeat(64),
    secretKey: new Uint8Array(32).fill(4),
    name: 'operator',
  } as Identity;

  it('backfills only the replaceable draft kind', async () => {
    const event = {
      kind: 'other' as const,
      event: {
        id: 'draft',
        pubkey: 'a'.repeat(64),
        created_at: 42,
        kind: 30078,
        tags: [['h', 'room']],
        content: 'Hello wor',
        sig: 'b'.repeat(128),
      },
      channelId: 'room',
      content: 'Hello wor',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'draft',
    } satisfies BuzzSessionEvent;
    const client = { agentDraftBackfill: vi.fn(async () => [event]) };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentDraftBackfill('room')).resolves.toHaveLength(1);
    expect(client.agentDraftBackfill).toHaveBeenCalledWith('room');
  });

  it('subscribes only to the draft record and releases the live subscription', async () => {
    const relayUnsubscribe = vi.fn();
    let relayHandler: ((event: BuzzSessionEvent) => void) | undefined;
    const client = {
      agentDraftSubscribe: vi.fn(
        async (_room: string, handler: (event: BuzzSessionEvent) => void) => {
          relayHandler = handler;
          return relayUnsubscribe;
        },
      ),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;
    const handler = vi.fn();

    const stop = transport.agentDraftSubscribe('room', handler);
    await vi.waitFor(() => expect(client.agentDraftSubscribe).toHaveBeenCalled());
    expect(client.agentDraftSubscribe).toHaveBeenCalledWith('room', expect.any(Function));
    relayHandler?.({
      kind: 'other',
      event: {
        id: 'draft',
        pubkey: 'a'.repeat(64),
        created_at: 42,
        kind: 30078,
        tags: [['h', 'room']],
        content: 'Hello wor',
        sig: 'b'.repeat(128),
      },
      channelId: 'room',
      content: 'Hello wor',
      pubkey: 'a'.repeat(64),
      createdAt: 42,
      id: 'draft',
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'raw', sessionId: 'room' }),
    );
    stop();
    expect(relayUnsubscribe).toHaveBeenCalledOnce();
  });
});

describe('Corner close', () => {
  it('publishes a buzz-corner-close tagged message to the corner channel, distinct from runAbort', async () => {
    const identity = {
      publicKey: 'd'.repeat(64),
      secretKey: new Uint8Array(32).fill(4),
      name: 'operator',
    } as Identity;
    const messageSubmit = vi.fn(async () => ({}));
    const client = { messageSubmit };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await transport.closeCorner('corner-1');

    expect(messageSubmit).toHaveBeenCalledWith(
      'corner-1',
      expect.any(String),
      expect.objectContaining({ extraTags: [['t', 'buzz-corner-close']] }),
    );
    expect(messageSubmit.mock.calls[0]?.[2]?.extraTags).not.toContainEqual([
      't',
      'buzz-agent-cancel',
    ]);
  });
});

describe('Room-scoped Workspace membership', () => {
  it('composes an @-mentioned Room message once and coalesces duplicate publishes by event id', async () => {
    const identity = {
      publicKey: 'a'.repeat(64),
      secretKey: new Uint8Array(32).fill(1),
      name: 'operator',
    } as Identity;
    const event = { id: 'event-1' };
    let releasePublish: (() => void) | undefined;
    const client = {
      buildMessage: vi.fn(() => event),
      publish: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePublish = resolve;
          }),
      ),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const prepared = await transport.composeMessage(
      { sessionId: 'room-1', text: '@Brisk Pilot fix the build' },
      { mentionAgent: 'agent-pubkey' },
    );
    expect(client.buildMessage).toHaveBeenCalledWith('room-1', '@Brisk Pilot fix the build', {
      mentionAgent: 'agent-pubkey',
    });

    const first = transport.publishPreparedMessage(prepared as never);
    const duplicate = transport.publishPreparedMessage(prepared as never);
    await vi.waitFor(() => expect(client.publish).toHaveBeenCalledOnce());
    releasePublish?.();
    await expect(Promise.all([first, duplicate])).resolves.toEqual(['event-1', 'event-1']);
  });

  it('binds a write-permission response to the agent and original request', async () => {
    const identity = {
      publicKey: 'a'.repeat(64),
      secretKey: new Uint8Array(32).fill(1),
      name: 'operator',
    } as Identity;
    const client = {
      respondToWritePermission: vi.fn(async () => ({ id: 'permission-event' })),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(
      transport.respondToWritePermission(
        'room-1',
        'permission-1',
        'request-1',
        'agent-pubkey',
        'allow',
        'lunchboxfortwo/buzzy',
      ),
    ).resolves.toBe('permission-event');
    expect(client.respondToWritePermission).toHaveBeenCalledWith(
      'room-1',
      'permission-1',
      'request-1',
      'agent-pubkey',
      'allow',
      'lunchboxfortwo/buzzy',
    );
  });

  it('routes existing people through the member-only SDK attachment', async () => {
    const identity = {
      publicKey: 'a'.repeat(64),
      secretKey: new Uint8Array(32).fill(1),
      name: 'operator',
    } as Identity;
    const client = {
      attachCommunityMemberToChannel: vi.fn(async () => ({
        joined: true,
        membershipSince: 42,
      })),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(
      transport.inviteWorkspaceMemberToChannel('room-1', 'person-1', 'workspace-1'),
    ).resolves.toBe(true);
    expect(client.attachCommunityMemberToChannel).toHaveBeenCalledWith(
      'room-1',
      'person-1',
      'workspace-1',
    );
  });

  it('returns the deterministic DM channel and whether it was newly created', async () => {
    const identity = {
      publicKey: 'a'.repeat(64),
      secretKey: new Uint8Array(32).fill(1),
      name: 'operator',
    } as Identity;
    const client = {
      resolveDirectMessage: vi.fn(async () => ({
        directMessage: { channelId: 'dm-1' },
        created: false,
      })),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.resolveDirectMessage('workspace-1', 'person-1')).resolves.toEqual({
      channelId: 'dm-1',
      created: false,
    });
    expect(client.resolveDirectMessage).toHaveBeenCalledWith('workspace-1', 'person-1');
  });
});

describe('Room→repo transport', () => {
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'operator',
  } as Identity;

  it('reads the resolved room repository straight from the client', async () => {
    const repo = {
      channelId: 'room-1',
      binding: { key: 'k', name: 'widget', remote: 'git://example.com/widget', localOnly: false },
      source: 'config',
    } as RoomRepository;
    const client = { resolveRoomRepository: vi.fn(async () => repo) };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.roomRepositoryRead('room-1')).resolves.toBe(repo);
    expect(client.resolveRoomRepository).toHaveBeenCalledWith('room-1');
  });

  it('binds a repo through the client, forwarding the exact input', async () => {
    const repo = {
      channelId: 'room-1',
      binding: { key: 'k', name: 'widget', remote: 'git://example.com/widget', localOnly: false },
      source: 'config',
    } as RoomRepository;
    const client = { setRoomRepository: vi.fn(async () => repo) };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const input = {
      key: 'k',
      name: 'widget',
      remote: 'git://example.com/widget',
      communityId: 'workspace-1',
    };
    await expect(transport.roomRepositorySet('room-1', input)).resolves.toBe(repo);
    expect(client.setRoomRepository).toHaveBeenCalledWith('room-1', input);
  });

  it('lists exactly the repositories granted to the GitHub App installation', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/auth/capabilities')
        ? new Response(JSON.stringify({ github: true, oidc: true }), { status: 200 })
        : new Response(
          JSON.stringify({
            installed: true,
            installations: [
              {
                installationId: 7,
                accountId: '1',
                accountLogin: 'acme',
                accountType: 'Organization',
                repositorySelection: 'selected',
                status: 'active',
                repositoryCount: 1,
                manageUrl: 'https://github.com/settings/installations/7',
              },
            ],
            repositories: [
              {
                id: 42,
                installationId: 7,
                name: 'widget',
                fullName: 'acme/widget',
                remote: 'https://github.com/acme/widget.git',
                defaultBranch: 'trunk',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const transport = new BuzzRigTransport(identity, 'https://relay.test');

    await expect(transport.workspaceRoomRepositoryCandidates('workspace-1')).resolves.toEqual([
      {
        key: 'github:42',
        name: 'acme/widget',
        remote: 'git://github.com/acme/widget',
        githubInstallationId: 7,
        defaultBranch: 'trunk',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('returns no candidates before the GitHub App is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith('/auth/capabilities')
          ? new Response(JSON.stringify({ github: true, oidc: true }), { status: 200 })
          : new Response(JSON.stringify({ installed: false, installations: [], repositories: [] }), {
              status: 200,
            }),
      ),
    );
    const transport = new BuzzRigTransport(identity, 'https://relay.test');

    await expect(transport.workspaceRoomRepositoryCandidates('workspace-1')).resolves.toEqual([]);
    vi.unstubAllGlobals();
  });

  it('keeps connected-Room repository discovery when GitHub is dark', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ github: false, oidc: true }), { status: 200 }),
      ),
    );
    const create = {
      id: 'create-room-a',
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: KIND_CREATE_GROUP,
      tags: [['h', 'room-a'], [TAG_COMMUNITY, 'workspace-1']],
      content: '',
      sig: 'c'.repeat(128),
    };
    const client = {
      query: vi.fn(async () => [create]),
      resolveRoomRepository: vi.fn(async () => ({
        channelId: 'room-a',
        binding: {
          key: 'legacy',
          name: 'legacy/widget',
          remote: 'git://example.com/legacy/widget',
          localOnly: false,
        },
        source: 'config',
      }) as RoomRepository),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.workspaceRoomRepositoryCandidates('workspace-1')).resolves.toEqual([
      {
        key: 'legacy',
        name: 'legacy/widget',
        remote: 'git://example.com/legacy/widget',
      },
    ]);
    vi.unstubAllGlobals();
  });
});

describe('Buzz change review metadata', () => {
  const base = 'b'.repeat(40);
  const tip = 'c'.repeat(40);
  const channel = 'change-channel';
  const path = 'src/example.ts';
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'reviewer',
  } as Identity;

  function rawEvent(tags: string[][], content: string, id: string, kind = 9) {
    return {
      id,
      pubkey: 'd'.repeat(64),
      created_at: 42,
      kind,
      tags: [['h', channel], ...tags],
      content,
      sig: 'e'.repeat(128),
    };
  }

  function transportWith(events: ReturnType<typeof rawEvent>[]) {
    const query = vi.fn(async (filters: Record<string, unknown>[]) => {
      const marker = (filters[0]?.['#t'] as string[] | undefined)?.[0];
      if (marker === 'body-control') {
        return [
          rawEvent(
            [
              ['t', 'body-control'],
              ['t', 'merge-ready'],
              ['repo', `${identity.publicKey}/demo`],
              ['branch', 'refs/heads/main'],
              ['tip', tip],
            ],
            'ready',
            'merge-ready',
          ),
        ];
      }
      return events.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === marker),
      );
    });
    const client = {
      query,
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;
    return { transport, query };
  }

  it('reads the exact-tip file manifest without downloading file patches', async () => {
    const manifest = rawEvent(
      [
        ['t', CHANGE_REVIEW_MANIFEST_TAG],
        ['base', base],
        ['tip', tip],
        ['chunk', '0'],
      ],
      JSON.stringify({
        version: 1,
        base,
        tip,
        files: [{ path, status: 'modified', linesAdded: 3, linesRemoved: 1 }],
      }),
      'manifest',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const patch = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '0'],
        ['chunks', '1'],
      ],
      '+not fetched yet',
      'patch',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const { transport, query } = transportWith([manifest, patch]);

    await expect(transport.workspaceFilesRead(channel)).resolves.toEqual([
      { path, status: 'modified', linesAdded: 3, linesRemoved: 1 },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]?.[0]).toMatchObject({
      kinds: [CHANGE_REVIEW_EVENT_KIND],
      authors: ['d'.repeat(64)],
      '#t': [CHANGE_REVIEW_MANIFEST_TAG],
      '#r': [tip],
    });
  });

  it('queries body controls directly so activity bursts cannot hide merge-ready', async () => {
    const { transport, query } = transportWith([]);

    await transport.getSubchannelMergeTarget(channel);

    expect(query).toHaveBeenCalledWith([
      { kinds: [9], '#h': [channel], '#t': ['body-control'], limit: 100 },
    ]);
  });

  it('does not expose a stale approval target after Body withdraws it for uncommitted work', async () => {
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: { query: ReturnType<typeof vi.fn> } }).client = {
      query: vi.fn(async () => [
        rawEvent(
          [
            ['t', 'body-control'],
            ['t', 'merge-ready'],
            ['repo', `${identity.publicKey}/demo`],
            ['branch', 'refs/heads/main'],
            ['tip', tip],
          ],
          'ready',
          'a-ready',
        ),
        rawEvent(
          [
            ['t', 'body-control'],
            ['t', 'merge-not-ready'],
            ['status', 'needs-attention'],
          ],
          'nothing ready',
          'z-not-ready',
        ),
      ]),
    };

    // Withdrawn, not silent: the human still learns why via `reason`, since
    // this lifecycle event never reaches the transcript on its own.
    await expect(transport.getSubchannelMergeTarget(channel)).resolves.toEqual({
      reason: 'nothing ready',
    });
  });

  it('does not submit a second approval for the same committed corner target', async () => {
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    const submitMergeApproval = vi.fn();
    (
      transport as unknown as {
        client: {
          query: ReturnType<typeof vi.fn>;
          submitMergeApproval: typeof submitMergeApproval;
        };
      }
    ).client = {
      query: vi.fn(async () => [
        rawEvent(
          [
            ['t', 'buzz-merge-approval'],
            ['repo', `${identity.publicKey}/demo`],
            ['branch', 'refs/heads/main'],
            ['tip', tip],
          ],
          'already approved',
          'approval',
        ),
      ]),
      submitMergeApproval,
    };

    await expect(
      transport.submitMergeApproval(channel, {
        repo: `${identity.publicKey}/demo`,
        branch: 'refs/heads/main',
        tip,
      }),
    ).resolves.toMatchObject({ success: true, message: 'Approval already sent for this change' });
    expect(submitMergeApproval).not.toHaveBeenCalled();
  });

  it('fetches and reassembles only the selected file patch', async () => {
    const first = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '0'],
        ['chunks', '2'],
      ],
      'diff --git a/src/example.ts b/src/example.ts\n',
      'first',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const second = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '1'],
        ['chunks', '2'],
      ],
      '-old\n+new\n',
      'second',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const { transport, query } = transportWith([second, first]);

    await expect(transport.changedFileRead(channel, path)).resolves.toEqual({
      content: 'diff --git a/src/example.ts b/src/example.ts\n-old\n+new\n',
    });
    expect(query.mock.calls[1]?.[0]?.[0]).toMatchObject({
      kinds: [CHANGE_REVIEW_EVENT_KIND],
      '#t': [CHANGE_REVIEW_FILE_TAG],
      '#r': [tip],
      '#f': [path],
    });
  });

  it('deduplicates retried chunks and ignores metadata from another channel member', async () => {
    const duplicate = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '0'],
        ['chunks', '2'],
      ],
      'stale',
      'duplicate',
      CHANGE_REVIEW_EVENT_KIND,
    );
    duplicate.created_at = 41;
    const first = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '0'],
        ['chunks', '2'],
      ],
      'new-',
      'first',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const second = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '1'],
        ['chunks', '2'],
      ],
      'patch',
      'second',
      CHANGE_REVIEW_EVENT_KIND,
    );
    const forged = rawEvent(
      [
        ['t', CHANGE_REVIEW_FILE_TAG],
        ['f', path],
        ['tip', tip],
        ['chunk', '1'],
        ['chunks', '2'],
      ],
      'forged',
      'forged',
      CHANGE_REVIEW_EVENT_KIND,
    );
    forged.pubkey = 'f'.repeat(64);
    const { transport } = transportWith([second, forged, duplicate, first]);

    await expect(transport.changedFileRead(channel, path)).resolves.toEqual({
      content: 'new-patch',
    });
  });
});

describe('Buzz corner lifecycle projection', () => {
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'reviewer',
  } as Identity;

  // Near-now timestamp: the oracle's liveness window is wall-clock, so
  // lifecycle fixtures must be fresh to read as working.
  const NOW_S = Math.floor(Date.now() / 1000);
  function event(channel: string, tags: string[][], content = '', createdAt = NOW_S) {
    const raw = {
      id: `${channel}-${tags.flat().join('-')}`,
      pubkey: 'd'.repeat(64),
      created_at: createdAt,
      kind: 9,
      tags: [['h', channel], ...tags],
      content,
      sig: 'e'.repeat(128),
    };
    return {
      kind: 'message' as const,
      event: raw,
      channelId: channel,
      content,
      pubkey: raw.pubkey,
      createdAt: raw.created_at,
      id: raw.id,
    };
  }

  it('distinguishes live, review-open, merged, and archived corners', async () => {
    const ids = ['live', 'open', 'merged', 'archived', 'invite-only'];
    const client = {
      listSubchannels: vi.fn(async () => ids),
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        const id = (filters[0]?.['#h'] as string[])[0]!;
        if ((filters[0]?.kinds as number[])[0] === 9) {
          return [
            event('room', [
              ['t', 'merge-summary'],
              ['subchannel', 'merged'],
            ]).event,
          ];
        }
        return [
          {
            id: `create-${id}`,
            pubkey: `${id[0]}`.repeat(64),
            created_at: ids.indexOf(id) + 1,
            kind: 9007,
            tags: [
              ['h', id],
              ['name', id === 'live' ? 'sub-legacy' : `${id}-corner`],
            ],
            content: '',
            sig: 'e'.repeat(128),
          },
        ];
      }),
      getChannelMetadata: vi.fn(async (id: string) =>
        id === 'invite-only'
          ? // Relay projections use `closed` for NIP-29 invite-only access;
            // it must not become the corner's lifecycle archived flag.
            ({ archived: 'closed' } as unknown as { archived?: boolean })
          : { archived: id === 'archived' },
      ),
      sessionEventsBackfill: vi.fn(async (id: string) => {
        if (id === 'open')
          return [
            event(id, [
              ['t', 'merge-ready'],
              ['status', 'ready'],
            ]),
          ];
        if (id === 'archived') return [event(id, [['status', 'archived']])];
        return [event(id, [['status', 'live']])];
      }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.listSubchannelLifecycle('room')).resolves.toMatchObject([
      { id: 'live', name: 'corner-live', status: 'live' },
      { id: 'open', name: 'open-corner', status: 'open' },
      { id: 'merged', name: 'merged-corner', status: 'merged' },
      { id: 'archived', name: 'archived-corner', status: 'archived' },
      { id: 'invite-only', name: 'invite-only-corner', status: 'live' },
    ]);
    expect(client.query).toHaveBeenCalledWith([
      expect.objectContaining({ '#h': ['room'], '#t': ['merge-summary'], limit: 500 }),
    ]);
  });

  it('lets a newer status outrank a merge-ready the corner has moved past', async () => {
    // Read off the captain's live Room: three corners published a review, then
    // failed on a later restart, and all three still reported `open` — which is
    // not terminal, so they kept their place in the Room's pinned corner strip
    // permanently. A merge-ready is an announcement about one moment, not a
    // standing state; it may only speak while nothing newer has.
    const ids = ['stale-review', 'still-ready'];
    const client = {
      listSubchannels: vi.fn(async () => ids),
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        if ((filters[0]?.kinds as number[])[0] === 9) return [];
        const id = (filters[0]?.['#h'] as string[])[0]!;
        return [
          {
            id: `create-${id}`,
            pubkey: 'f'.repeat(64),
            created_at: 1,
            kind: 9007,
            tags: [
              ['h', id],
              ['name', `${id}-corner`],
            ],
            content: '',
            sig: 'e'.repeat(128),
          },
        ];
      }),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      sessionEventsBackfill: vi.fn(async (id: string) => {
        const ready = {
          ...event(id, [
            ['t', 'merge-ready'],
            ['status', 'ready'],
          ]),
          createdAt: 100,
        };
        if (id === 'still-ready') return [ready];
        // The review, and then a later word that the corner is not usable.
        return [ready, { ...event(id, [['status', 'failed']]), createdAt: 200 }];
      }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.listSubchannelLifecycle('stale-room')).resolves.toMatchObject([
      { id: 'stale-review', status: 'failed' },
      { id: 'still-ready', status: 'open' },
    ]);
  });

  it('resolves an old needs-decision once the corner has worked since, and keeps a live one gold', async () => {
    // The owner's 2026-08-23 screenshots: two rooms painted `working` from the
    // cached snapshot, then flipped to hours-old gate-outage attention facts
    // (~3s after open) when warm revalidation re-derived the corners. A
    // needs-you card is an announcement about one moment — agent work after it
    // means the moment passed.
    const ids = ['resolved-decision', 'pending-decision'];
    const client = {
      listSubchannels: vi.fn(async () => ids),
      query: vi.fn(async () => []),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      sessionEventsBackfill: vi.fn(async (id: string) => {
        const card = {
          ...event(id, [['display-status', 'needs-attention']]),
          createdAt: NOW_S - 7200,
        };
        if (id === 'pending-decision') return [card];
        // Work resumed after the decision card: narration segments and a
        // turn lifecycle, exactly what a working corner publishes — recent
        // enough to be inside the liveness window.
        return [
          card,
          { ...event(id, [['t', 'agent-turn'], ['status', 'working']]), createdAt: NOW_S - 30 },
          { ...event(id, [['t', 'agent-message']]), createdAt: NOW_S - 20 },
          { ...event(id, [['t', 'agent-activity']]), createdAt: NOW_S - 10 },
        ];
      }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.listSubchannelLifecycle('outage-room')).resolves.toMatchObject([
      { id: 'resolved-decision', status: 'live' },
      { id: 'pending-decision', status: 'needs-attention' },
    ]);
  });

  it('classifies identically on cold cache and warm refetch over unchanged history', async () => {
    // ONE oracle: the cached snapshot and the warm revalidation are both
    // derivations of the same relay history, so the row presentation they feed
    // must agree — no visible working→needs-you flip seconds after open.
    const backfill = [
      { ...event('c1', [['display-status', 'needs-attention']]), createdAt: NOW_S - 7200 },
      { ...event('c1', [['t', 'agent-message']]), createdAt: NOW_S - 10 },
      // A review announced and then consumed by resumed work — not pending.
      { ...event('c2', [['t', 'merge-ready'], ['status', 'ready']]), createdAt: NOW_S - 7200 },
      { ...event('c2', [['t', 'agent-turn']]), createdAt: NOW_S - 10 },
    ];
    const client = {
      listSubchannels: vi.fn(async () => ['c1', 'c2']),
      query: vi.fn(async () => []),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      sessionEventsBackfill: vi.fn(async () => backfill),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const cold = await transport.listSubchannelLifecycle('parity-room');
    const warm = await transport.listSubchannelLifecycle('parity-room');
    expect(warm).toEqual(cold);

    const coldRow = roomRowPresentation({ id: 'room', corners: cold }, new Map());
    const warmRow = roomRowPresentation({ id: 'room', corners: warm }, new Map());
    expect(warmRow.zone).toBe(coldRow.zone);
    expect(warmRow.attention).toBe(coldRow.attention);
    expect(warmRow.fact).toBe(coldRow.fact);
    // And the resolved history reads as working, not as the stale relic.
    expect(coldRow.zone).toBe('working');
    expect(coldRow.attention).toBe(false);
  });

  it('reads Room presence so a dead-agent stale ask reads STALLED, not needs-you', async () => {
    // The owner's real shape: a corner holding an ask card, its daemon dead.
    // The transport feeds the oracle a SOFT presence input (one multi-`#d`
    // read per fetch); only when every record is provably past its lease does
    // the summary carry `agentOffline` — and then the ask is STALLED, never
    // "waiting on you".
    const presenceEvent = (status: 'online' | 'offline', createdAt = NOW_S) => ({
      id: `presence-${status}`,
      pubkey: 'd'.repeat(64),
      created_at: createdAt,
      kind: 30078,
      tags: [
        ['d', 'agent-presence:dead-room'],
        ['agent', 'd'.repeat(64)],
        ['status', status],
      ],
      content: '',
      sig: 'e'.repeat(128),
    });
    const makeClient = (presence: object[]) => ({
      listSubchannels: vi.fn(async () => ['ask-corner']),
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        const kinds = filters[0]?.kinds as number[] | undefined;
        if (kinds?.[0] === 30078) return presence;
        if (kinds?.[0] === 9) return [];
        return [
          {
            id: 'create-ask-corner',
            pubkey: 'f'.repeat(64),
            created_at: 1,
            kind: 9007,
            tags: [['h', 'ask-corner'], ['name', 'stale-ask']],
            content: '',
            sig: 'e'.repeat(128),
          },
        ];
      }),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      sessionEventsBackfill: vi.fn(async () => [
        { ...event('ask-corner', [['display-status', 'needs-attention']]), createdAt: NOW_S - 7200 },
        {
          ...event('ask-corner', [
            ['t', 'agent-message'],
          ]),
          createdAt: NOW_S - 3600,
          content: 'Main moved on — which base should I rebase onto?',
        },
      ]),
    });

    // Dead agent: the last heartbeat is 10 minutes old, far past the 120s
    // lease. Same facts that golded before now read stalled.
    const deadTransport = new BuzzRigTransport(identity, 'https://relay.test');
    (
      deadTransport as unknown as { client: ReturnType<typeof makeClient> }
    ).client = makeClient([presenceEvent('online', NOW_S - 600)]);
    await expect(deadTransport.listSubchannelLifecycle('dead-room')).resolves.toMatchObject([
      { id: 'ask-corner', status: null, agentOffline: true },
    ]);

    // Live agent: same history, fresh heartbeat — today's behaviour, the
    // worded card keeps its gold needs-you reading.
    const liveTransport = new BuzzRigTransport(identity, 'https://relay.test');
    (
      liveTransport as unknown as { client: ReturnType<typeof makeClient> }
    ).client = makeClient([presenceEvent('online', NOW_S - 10)]);
    await expect(liveTransport.listSubchannelLifecycle('live-room')).resolves.toMatchObject([
      { id: 'ask-corner', status: 'needs-attention' },
    ]);
    const liveSummary = await liveTransport.listSubchannelLifecycle('live-room');
    expect(liveSummary[0]?.agentOffline).toBeUndefined();

    // No presence record at all is UNKNOWN, never offline: the verdict must
    // not flip on a missing signal.
    const unknownTransport = new BuzzRigTransport(identity, 'https://relay.test');
    (
      unknownTransport as unknown as { client: ReturnType<typeof makeClient> }
    ).client = makeClient([]);
    await expect(unknownTransport.listSubchannelLifecycle('unknown-room')).resolves.toMatchObject([
      { id: 'ask-corner', status: 'needs-attention' },
    ]);
    const summary = await unknownTransport.listSubchannelLifecycle('unknown-room');
    expect(summary[0]?.agentOffline).toBeUndefined();
  });
});

describe('Buzz cross-Room corner lifecycle batching', () => {
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'reviewer',
  } as Identity;

  function createEvent(id: string) {
    return {
      id: `create-${id}`,
      pubkey: 'b'.repeat(64),
      created_at: 1,
      kind: 9007,
      tags: [
        ['h', id],
        ['name', `${id}-corner`],
      ],
      content: '',
      sig: 'e'.repeat(128),
    };
  }

  it('issues one multi-#h create query and one multi-#h merge-summary query across Rooms, and warms the per-Room cache', async () => {
    const cornersByRoom: Record<string, string[]> = {
      'batch-room-a': ['batch-corner-a1', 'batch-corner-a2'],
      'batch-room-b': ['batch-corner-b1'],
    };
    const client = {
      listSubchannels: vi.fn(async (roomId: string) => cornersByRoom[roomId] ?? []),
      query: vi.fn(async (filters: Array<Record<string, unknown>>) => {
        const filter = filters[0]!;
        if ((filter.kinds as number[])[0] === 9007) {
          return (filter['#h'] as string[]).map((id) => createEvent(id));
        }
        return [];
      }),
      getChannelMetadata: vi.fn(async () => ({ archived: false })),
      sessionEventsBackfill: vi.fn(async () => []),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const result = await transport.listSubchannelLifecycleForRooms([
      'batch-room-a',
      'batch-room-b',
    ]);

    expect(result.get('batch-room-a')).toHaveLength(2);
    expect(result.get('batch-room-b')).toHaveLength(1);

    const createCalls = client.query.mock.calls.filter(
      ([filters]) => (filters[0]?.kinds as number[] | undefined)?.[0] === 9007,
    );
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]![0]![0]!['#h']).toEqual(
      expect.arrayContaining(['batch-corner-a1', 'batch-corner-a2', 'batch-corner-b1']),
    );
    const mergeSummaryCalls = client.query.mock.calls.filter(
      ([filters]) => (filters[0]?.kinds as number[] | undefined)?.[0] === 9,
    );
    expect(mergeSummaryCalls).toHaveLength(1);
    expect(mergeSummaryCalls[0]![0]![0]!['#h']).toEqual(['batch-room-a', 'batch-room-b']);

    // The batched fetch also warms the single-Room cache used by
    // `listSubchannelLifecycle` (the 2 other call sites): a follow-up call
    // for a Room already covered above is a cache hit, no further reads.
    client.listSubchannels.mockClear();
    client.query.mockClear();
    await expect(transport.listSubchannelLifecycle('batch-room-a')).resolves.toHaveLength(2);
    expect(client.listSubchannels).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('Buzz channel archive scope', () => {
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'reviewer',
  } as Identity;

  function archivedControl(channelId: string, subchannelId?: string) {
    const tags = [
      ['h', channelId],
      ['t', 'body-control'],
      ['status', 'archived'],
      ...(subchannelId ? [['subchannel', subchannelId]] : []),
    ];
    const raw = {
      id: `${channelId}-${subchannelId ?? 'self'}-archived`,
      pubkey: 'd'.repeat(64),
      created_at: 42,
      kind: 9,
      tags,
      content: 'archived',
      sig: 'e'.repeat(128),
    };
    return {
      kind: 'message' as const,
      event: raw,
      channelId,
      content: raw.content,
      pubkey: raw.pubkey,
      createdAt: raw.created_at,
      id: raw.id,
    };
  }

  function transportWithArchiveState(options: {
    metadataArchived?: boolean;
    parentChannelId?: string | null;
    events?: ReturnType<typeof archivedControl>[];
  }) {
    const client = {
      getChannelMetadata: vi.fn(async () => ({ archived: options.metadataArchived ?? false })),
      getParentChannelId: vi.fn(async () => options.parentChannelId ?? null),
      sessionEventsBackfill: vi.fn(async () => options.events ?? []),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;
    return transport;
  }

  it('does not archive a Room when its merged corner is archived', async () => {
    const transport = transportWithArchiveState({
      events: [archivedControl('room', 'corner')],
    });

    await expect(transport.isChannelArchived('room')).resolves.toBe(false);
  });

  it('still recognizes metadata and self-scoped archive state', async () => {
    const metadataArchived = transportWithArchiveState({ metadataArchived: true });
    const selfScoped = transportWithArchiveState({
      parentChannelId: 'room',
      events: [archivedControl('corner')],
    });

    await expect(metadataArchived.isChannelArchived('room')).resolves.toBe(true);
    await expect(selfScoped.isChannelArchived('corner')).resolves.toBe(true);
  });
});

/**
 * Presence is a parameterized-replaceable kind:30078 record, and the relay
 * indexes those by `d`. A `#h` filter over kind 30078 matches NOTHING — even
 * though the record does carry an `h` tag — so this read, the only presence
 * reader that reached for `#h`, returned zero events for every Workspace,
 * always. The directory therefore reported every agent OFFLINE no matter what
 * its daemon was doing.
 *
 * Confirmed against the live relay before fixing: for an agent whose `online`
 * heartbeat was four seconds old, `#h` returned 0 events and `#d` returned the
 * record.
 */
describe('Workspace-wide agent presence', () => {
  const identity = {
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32).fill(1),
    name: 'viewer',
  } as Identity;

  function presenceEvent(channelId: string, status: 'online' | 'offline') {
    return {
      id: `presence-${channelId}`,
      pubkey: 'b'.repeat(64),
      created_at: 1_787_195_367,
      kind: 30078,
      tags: [
        ['d', `agent-presence:${channelId}`],
        ['h', channelId],
        ['t', 'agent-presence'],
        ['agent', 'b'.repeat(64)],
        ['status', status],
      ],
      content: status,
      sig: 'e'.repeat(128),
    };
  }

  it('asks by `#d`, so a serving agent is not reported offline', async () => {
    const rooms = ['room-a', 'room-b'];
    const filters: Array<Record<string, unknown>> = [];
    const client = {
      communityChannels: vi.fn(async () => rooms),
      // A relay that indexes kind 30078 by `d` only — which is what the real
      // one does. An `#h` filter here returns nothing, exactly as it did live.
      query: vi.fn(async (requested: Array<Record<string, unknown>>) => {
        const filter = requested[0] ?? {};
        filters.push(filter);
        const wanted = (filter['#d'] as string[] | undefined) ?? [];
        return wanted.includes('agent-presence:room-b') ? [presenceEvent('room-b', 'online')] : [];
      }),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    const events = await transport.agentPresenceBackfillForWorkspace('workspace');

    expect(filters[0]!['#d']).toEqual(['agent-presence:room-a', 'agent-presence:room-b']);
    expect(filters[0]).not.toHaveProperty('#h');
    expect(events).toHaveLength(1);
  });

  it('still reads nothing for a Workspace with no Rooms', async () => {
    const client = {
      communityChannels: vi.fn(async () => []),
      query: vi.fn(async () => []),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(transport.agentPresenceBackfillForWorkspace('workspace')).resolves.toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });
});
