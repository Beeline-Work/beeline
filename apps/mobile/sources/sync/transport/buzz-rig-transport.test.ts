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
import {
  CHANGE_REVIEW_FILE_TAG,
  CHANGE_REVIEW_EVENT_KIND,
  CHANGE_REVIEW_MANIFEST_TAG,
  type Identity,
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
        { kind: 'output', title: 'Output', text: 'First' },
        { kind: 'tool', title: 'Edit file', status: 'completed' },
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
});

describe('Room-scoped Workspace membership', () => {
  it('sends @-mentioned Room messages with an address and no private request marker', async () => {
    const identity = {
      publicKey: 'a'.repeat(64),
      secretKey: new Uint8Array(32).fill(1),
      name: 'operator',
    } as Identity;
    const client = {
      messageSubmit: vi.fn(async () => ({ id: 'event-1' })),
    };
    const transport = new BuzzRigTransport(identity, 'https://relay.test');
    (transport as unknown as { client: typeof client }).client = client;

    await expect(
      transport.messageSubmitMentioningAgent(
        'room-1',
        '@Brisk Pilot fix the build',
        'agent-pubkey',
      ),
    ).resolves.toBe('event-1');
    expect(client.messageSubmit).toHaveBeenCalledWith('room-1', '@Brisk Pilot fix the build', {
      mentionAgent: 'agent-pubkey',
    });
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
      ),
    ).resolves.toBe('permission-event');
    expect(client.respondToWritePermission).toHaveBeenCalledWith(
      'room-1',
      'permission-1',
      'request-1',
      'agent-pubkey',
      'allow',
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
      return events.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === marker),
      );
    });
    const client = {
      sessionEventsBackfill: vi.fn(async () => [
        {
          kind: 'message',
          event: rawEvent(
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
        },
      ]),
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
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]?.[0]).toMatchObject({
      kinds: [CHANGE_REVIEW_EVENT_KIND],
      authors: ['d'.repeat(64)],
      '#t': [CHANGE_REVIEW_MANIFEST_TAG],
      '#r': [tip],
    });
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
    expect(query.mock.calls[0]?.[0]?.[0]).toMatchObject({
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

  function event(channel: string, tags: string[][], content = '') {
    const raw = {
      id: `${channel}-${tags.flat().join('-')}`,
      pubkey: 'd'.repeat(64),
      created_at: 42,
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
    const ids = ['live', 'open', 'merged', 'archived'];
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
      getChannelMetadata: vi.fn(async (id: string) => ({ archived: id === 'archived' })),
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
    ]);
    expect(client.query).toHaveBeenCalledWith([
      expect.objectContaining({ '#h': ['room'], '#t': ['merge-summary'], limit: 500 }),
    ]);
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
