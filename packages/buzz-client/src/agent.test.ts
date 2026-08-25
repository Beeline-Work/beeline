import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  abandonAgentPairing,
  attachAgentToChannel,
  createAgent,
  hasAgentIdentityMarker,
  isAgentIdentityEvent,
  listAgents,
  parseAgent,
  removeAgent,
} from './agent.js';
import { createAgentIdentity, createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_REMOVE_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_COMMUNITY,
} from './kinds.js';
import { DEFAULT_AGENT_IDENTITY_NAME, fallbackAgentName } from './display-name.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('owner');
const agentIdentity = createAgentIdentity('Buzzy Agent');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = agentIdentity): ChannelOpsContext {
  return { http: { ...http, identity }, identity };
}

function signed(identity: typeof owner, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: 1_700_000_000, kind, tags, content },
    identity.secretKey,
  );
}

function communityCreate(): NostrEvent {
  return signed(owner, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', 'Builders'],
    ['channel_type', 'stream'],
    ['visibility', 'open'],
    [TAG_COMMUNITY, communityId],
  ]);
}

function memberState(includeAgent = true): NostrEvent {
  return signed(owner, KIND_CHANNEL_MEMBERS, [
    ['d', communityId],
    ['p', owner.publicKey],
    ...(includeAgent ? [['p', agentIdentity.publicKey]] : []),
  ]);
}

function adminState(): NostrEvent {
  return signed(owner, KIND_CHANNEL_ADMINS, [
    ['d', communityId],
    ['p', owner.publicKey, 'owner'],
  ]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filterFrom(init?: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
  return body[0] ?? {};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent entity model', () => {
  it('publishes a self-signed community agent and carries optional metadata', async () => {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    const agent = await createAgent(ctx(), communityId, {
      agentId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Patch',
      soul: 'curious builder',
      personality: 'direct',
      avatar: 'https://example.test/patch.png',
    });
    const event = published[0]!;

    expect(event.pubkey).toBe(agentIdentity.publicKey);
    expect(event.tags).toContainEqual(['t', TAG_AGENT]);
    expect(event.tags).toContainEqual([TAG_COMMUNITY, communityId]);
    expect(isAgentIdentityEvent(event)).toBe(true);
    expect(agent).toMatchObject({
      communityId,
      displayName: 'Patch',
      pubkey: agentIdentity.publicKey,
      soul: 'curious builder',
      personality: 'direct',
      avatar: 'https://example.test/patch.png',
    });
    expect(parseAgent({ ...event, content: `${event.content}tampered` })).toBeNull();
  });

  it('resolves the daemon default marker to a distinct pubkey seed name per agent', async () => {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ['p', daemonIdentity.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    // The daemon mints its identities with the generic `beeline-agent` marker;
    // that placeholder resolves to this agent's OWN stable seed name.
    const daemonIdentity = createAgentIdentity('beeline-agent');
    const agent = await createAgent(ctx(daemonIdentity), communityId);

    // Distinct per agent, never a shared label ("buzzy-agent"/"Buzzy" is gone)
    // and never a random-looking mask: same pubkey, same name, every time.
    expect(agent.displayName).toBe(fallbackAgentName(daemonIdentity.publicKey));
    expect(agent.displayName).not.toBe('buzzy-agent');
    expect(published[0]!.tags).toContainEqual(['name', agent.displayName]);
  });

  it('never registers two default-named agents under one shared display name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ['p', first.publicKey],
              ['p', second.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    const first = createAgentIdentity(DEFAULT_AGENT_IDENTITY_NAME);
    const second = createAgentIdentity(DEFAULT_AGENT_IDENTITY_NAME);
    expect(first.publicKey).not.toBe(second.publicKey);
    const firstAgent = await createAgent(ctx(first), communityId);
    const secondAgent = await createAgent(ctx(second), communityId);
    expect(firstAgent.displayName).toBe(fallbackAgentName(first.publicKey));
    expect(secondAgent.displayName).toBe(fallbackAgentName(second.publicKey));
    // The whole point of the seed-name derivation: no two freshly paired
    // soul-less agents share one identity label.
    expect(firstAgent.displayName).not.toBe(secondAgent.displayName);
  });

  it('preserves an authored multi-word display name end to end', async () => {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    const agent = await createAgent(ctx(), communityId, {
      displayName: 'Quiet Keeper',
    });

    expect(agent.displayName).toBe('Quiet Keeper');
    expect(published[0]!.tags).toContainEqual(['name', 'Quiet Keeper']);
    expect(published[0]!.content).toContain('"displayName":"Quiet Keeper"');
  });

  it('keeps the agent security marker latched even when record metadata is malformed', () => {
    const marker = signed(agentIdentity, KIND_STREAM_MESSAGE, [['t', TAG_AGENT]], '{}');
    expect(hasAgentIdentityMarker(marker)).toBe(true);
    expect(isAgentIdentityEvent(marker)).toBe(false);
    expect(parseAgent(marker)).toBeNull();
  });

  it('lists only verified agent records and keeps the latest declaration per id', async () => {
    const baseTags = [
      ['h', communityId],
      ['t', TAG_AGENT],
      ['d', '22222222-2222-4222-8222-222222222222'],
      ['p', agentIdentity.publicKey],
      ['name', 'Patch'],
      [TAG_COMMUNITY, communityId],
    ];
    const older = signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_STREAM_MESSAGE,
        tags: baseTags,
        content: JSON.stringify({ displayName: 'Patch' }),
      },
      agentIdentity.secretKey,
    );
    const newer = signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: 1_700_000_001,
        kind: KIND_STREAM_MESSAGE,
        tags: baseTags,
        content: JSON.stringify({ displayName: 'Patch 2' }),
      },
      agentIdentity.secretKey,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([older, newer]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    await expect(listAgents(ctx(owner), communityId)).resolves.toMatchObject([
      { displayName: 'Patch 2', pubkey: agentIdentity.publicKey },
    ]);
  });

  it('hides a durable agent declaration after Workspace membership is removed', async () => {
    const record = signed(
      agentIdentity,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_AGENT],
        ['d', '22222222-2222-4222-8222-222222222222'],
        ['p', agentIdentity.publicKey],
        ['name', 'Patch'],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ displayName: 'Patch' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([record]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    await expect(listAgents(ctx(owner), communityId)).resolves.toEqual([]);
  });

  it('removes an agent from every Room before removing its Workspace lease', async () => {
    const roomId = '33333333-3333-4333-8333-333333333333';
    const record = signed(
      agentIdentity,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_AGENT],
        ['d', '22222222-2222-4222-8222-222222222222'],
        ['p', agentIdentity.publicKey],
        ['name', 'Patch'],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ displayName: 'Patch' }),
    );
    const roomCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', roomId],
      ['name', 'Repo'],
      [TAG_COMMUNITY, communityId],
    ]);
    const removed = new Set<string>();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          removed.add(event.tags.find((tag) => tag[0] === 'h')?.[1] ?? '');
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) {
          return jsonResponse((filter.authors as string[] | undefined) ? [] : [record]);
        }
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate(), roomCreate]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          const id = String(
            (filter['#d'] as string[] | undefined)?.[0] ??
              (filter['#h'] as string[] | undefined)?.[0] ??
              '',
          );
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', id],
              ['p', owner.publicKey],
              ...(!removed.has(id) ? [['p', agentIdentity.publicKey]] : []),
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    await removeAgent(ctx(owner), communityId, agentIdentity.publicKey);

    expect(published.map((event) => event.kind)).toEqual([KIND_REMOVE_USER, KIND_REMOVE_USER]);
    expect(published.map((event) => event.tags.find((tag) => tag[0] === 'h')?.[1])).toEqual([
      roomId,
      communityId,
    ]);
    expect(published.every((event) => event.pubkey === owner.publicKey)).toBe(true);
  });

  it('completes the Workspace-level removal even when one Room membership never confirms (an offline agent stuck in an orphaned corner)', async () => {
    const roomId = '55555555-5555-4555-8555-555555555555';
    const record = signed(
      agentIdentity,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_AGENT],
        ['d', '22222222-2222-4222-8222-222222222222'],
        ['p', agentIdentity.publicKey],
        ['name', 'Patch'],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ displayName: 'Patch' }),
    );
    const roomCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', roomId],
      ['name', 'Orphaned Corner'],
      [TAG_COMMUNITY, communityId],
    ]);
    const removedCommunity = new Set<string>();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.tags.find((tag) => tag[0] === 'h')?.[1] === communityId) {
            removedCommunity.add(communityId);
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) {
          return jsonResponse((filter.authors as string[] | undefined) ? [] : [record]);
        }
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate(), roomCreate]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          const id = String(
            (filter['#d'] as string[] | undefined)?.[0] ??
              (filter['#h'] as string[] | undefined)?.[0] ??
              '',
          );
          // The Room's own projection never drops the agent — standing in for
          // a dormant daemon's un-archived corner, which never converges no
          // matter how many times this is polled.
          const stillMember = id === roomId || !removedCommunity.has(id);
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', id],
              ['p', owner.publicKey],
              ...(stillMember ? [['p', agentIdentity.publicKey]] : []),
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    vi.useFakeTimers();
    try {
      const removal = removeAgent(ctx(owner), communityId, agentIdentity.publicKey);
      // Drain the Room's doomed 15s wait; the community-level wait resolves
      // on its own first check once that removal is published.
      await vi.advanceTimersByTimeAsync(16_000);
      await removal;
    } finally {
      vi.useRealTimers();
    }

    expect(
      published.some(
        (event) =>
          event.kind === KIND_REMOVE_USER &&
          event.tags.find((tag) => tag[0] === 'h')?.[1] === communityId,
      ),
    ).toBe(true);
    expect(removedCommunity.has(communityId)).toBe(true);
  }, 30_000);

  it('refuses registration before the agent key is a community member', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    await expect(createAgent(ctx(), communityId)).rejects.toThrow(
      'agent identity must be a community member',
    );
  });

  it('invites one already-linked agent to one Room without minting another identity', async () => {
    const roomId = '33333333-3333-4333-8333-333333333333';
    const agentRecord = signed(
      agentIdentity,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_AGENT],
        ['d', '22222222-2222-4222-8222-222222222222'],
        ['p', agentIdentity.publicKey],
        ['name', 'Patch'],
        [TAG_COMMUNITY, communityId],
      ],
      JSON.stringify({ displayName: 'Patch' }),
    );
    const roomCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', roomId],
      ['name', 'Repo'],
      [TAG_COMMUNITY, communityId],
      ['repo-key', 'a'.repeat(64)],
      ['repo-name', 'repo'],
      ['repo-scope', 'remote'],
      ['repo-remote', 'git://example.test/team/repo'],
    ]);
    let joined = false;
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          joined = true;
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([roomCreate]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', roomId],
              ['p', owner.publicKey],
              ...(joined ? [['p', agentIdentity.publicKey]] : []),
            ]),
          ]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const authors = filter.authors as string[] | undefined;
          return jsonResponse(authors?.includes(owner.publicKey) ? [] : [agentRecord]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      attachAgentToChannel(ctx(owner), roomId, agentIdentity.publicKey, communityId),
    ).resolves.toMatchObject({ joined: true });
    expect(published).toHaveLength(1);
    expect(published[0]!.tags).toContainEqual(['p', agentIdentity.publicKey]);
    expect(published[0]!.tags).toContainEqual(['role', 'member']);
    expect(published[0]!.pubkey).toBe(owner.publicKey);
  });
});

describe('abandonAgentPairing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the membership redemption just added, so a failed pair leaves no ghost", async () => {
    // `listAgents` filters on current Workspace membership, so this is the
    // write that actually makes a half-created agent disappear from the app.
    const removed = new Set<string>();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          removed.add(event.tags.find((tag) => tag[0] === 'p')?.[1] ?? '');
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([memberState(!removed.has(agentIdentity.publicKey))]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        return jsonResponse([]);
      }),
    );

    await expect(abandonAgentPairing(ctx(), communityId)).resolves.toBe(true);

    // The agent signs its OWN removal: `removeAgent` is an admin action and
    // explicitly refuses an agent caller, so it can never be the undo here.
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(KIND_REMOVE_USER);
    expect(published[0]!.pubkey).toBe(agentIdentity.publicKey);
    expect(published[0]!.tags).toContainEqual(['p', agentIdentity.publicKey]);
  });

  it('publishes nothing when the redemption never added the membership', async () => {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        return jsonResponse([]);
      }),
    );

    await expect(abandonAgentPairing(ctx(), communityId)).resolves.toBe(true);
    expect(published).toEqual([]);
  });

  it('swallows a relay refusal instead of replacing the real pairing error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('relay unreachable');
      }),
    );

    await expect(abandonAgentPairing(ctx(), communityId)).resolves.toBe(false);
  });
});
