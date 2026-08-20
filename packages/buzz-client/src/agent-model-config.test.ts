import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  getAgentModelCatalog,
  getAgentModelConfig,
  parseAgentModelCatalog,
  publishAgentModelCatalog,
  setAgentModelConfig,
} from './agent-model-config.js';
import { createAgentIdentity, createIdentity } from './identity.js';
import {
  KIND_AGENT_MODEL_CATALOG,
  KIND_AGENT_MODEL_CONFIG,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_MODEL_CONFIG,
  TAG_COMMUNITY,
} from './kinds.js';
import type { AgentModelConfigOption } from './types.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('owner');
const outsider = createIdentity('outsider');
const agentIdentity = createAgentIdentity('Hull runner');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = owner): ChannelOpsContext {
  return { http: { ...http, identity }, identity };
}

function signed(identity: typeof owner, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: Math.floor(Date.now() / 1000), kind, tags, content },
    identity.secretKey,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filterFrom(init?: RequestInit): Record<string, unknown> {
  return (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
}

function communityCreate(): NostrEvent {
  return signed(owner, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', 'Builders'],
    [TAG_COMMUNITY, communityId],
  ]);
}

function agentRecord(): NostrEvent {
  return signEvent(
    {
      pubkey: agentIdentity.publicKey,
      created_at: 1_700_000_000,
      kind: KIND_STREAM_MESSAGE,
      tags: [
        ['h', communityId],
        ['d', 'agent-id'],
        ['p', agentIdentity.publicKey],
        ['name', 'Agent'],
        ['t', TAG_AGENT],
        [TAG_COMMUNITY, communityId],
      ],
      content: JSON.stringify({ displayName: 'Agent' }),
    },
    agentIdentity.secretKey,
  );
}

function stubRelay(published: NostrEvent[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/events')) {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return jsonResponse({ accepted: true });
      }
      const filter = filterFrom(init);
      const kind = (filter.kinds as number[])[0];
      if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
      if (kind === KIND_CHANNEL_MEMBERS) {
        return jsonResponse([
          signed(owner, KIND_CHANNEL_MEMBERS, [
            ['d', communityId],
            ['p', owner.publicKey],
            ['p', agentIdentity.publicKey],
          ]),
        ]);
      }
      if (kind === KIND_CHANNEL_ADMINS) {
        return jsonResponse([signed(owner, KIND_CHANNEL_ADMINS, [['d', communityId]])]);
      }
      if (kind === KIND_STREAM_MESSAGE) {
        const authors = filter.authors as string[] | undefined;
        if (!authors) return jsonResponse([agentRecord()]);
        return jsonResponse(authors.includes(agentIdentity.publicKey) ? [agentRecord()] : []);
      }
      if (kind === KIND_AGENT_MODEL_CONFIG || kind === KIND_AGENT_MODEL_CATALOG) {
        return jsonResponse(published.filter((event) => event.kind === kind));
      }
      return jsonResponse([]);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('agent model/effort selection', () => {
  it('round-trips a human-authored selection and rejects an agent-authored one', async () => {
    const published: NostrEvent[] = [];
    stubRelay(published);

    const config = await setAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey, {
      model: 'sonnet',
      effort: 'high',
    });
    expect(config.raw.pubkey).toBe(owner.publicKey);
    expect(config.raw.kind).toBe(KIND_AGENT_MODEL_CONFIG);
    expect(config.raw.tags).toContainEqual(['t', TAG_AGENT_MODEL_CONFIG]);
    expect(config.model).toBe('sonnet');
    expect(config.effort).toBe('high');

    await expect(
      getAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey),
    ).resolves.toMatchObject({ model: 'sonnet', effort: 'high', authoredBy: owner.publicKey });

    await expect(
      setAgentModelConfig(ctx(agentIdentity), communityId, agentIdentity.publicKey, { model: 'opus' }),
    ).rejects.toThrow('must be authored by a human community member');
  });

  it('keeps the newest selection and ignores one from a non-member author', async () => {
    const published: NostrEvent[] = [];
    stubRelay(published);

    const first = await setAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey, {
      model: 'sonnet',
    });
    published.push(
      signEvent(
        {
          pubkey: outsider.publicKey,
          created_at: first.updatedAt + 10,
          kind: KIND_AGENT_MODEL_CONFIG,
          tags: [
            ['d', `${communityId}:${agentIdentity.publicKey}`],
            ['h', communityId],
            ['p', agentIdentity.publicKey],
            ['t', TAG_AGENT_MODEL_CONFIG],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({ model: 'opus' }),
        },
        outsider.secretKey,
      ),
    );

    await expect(
      getAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey),
    ).resolves.toMatchObject({ model: 'sonnet', authoredBy: owner.publicKey });
  });

  it('preserves the selected model when a later effort picker write updates only effort', async () => {
    const published: NostrEvent[] = [];
    stubRelay(published);

    await setAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey, { model: 'sonnet' });
    await setAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey, { effort: 'high' });

    await expect(
      getAgentModelConfig(ctx(owner), communityId, agentIdentity.publicKey),
    ).resolves.toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(JSON.parse(published.at(-1)?.content ?? '{}')).toEqual({ model: 'sonnet', effort: 'high' });
  });

  it('publishes and reads back the agent-self-authored catalog, dropping any non-allow-listed axis', async () => {
    const published: NostrEvent[] = [];
    stubRelay(published);

    const options: AgentModelConfigOption[] = [
      { id: 'model', category: 'model', currentValue: 'sonnet', options: [{ id: 'sonnet' }, { id: 'opus' }] },
      { id: 'effort', category: 'effort', currentValue: 'high', options: [{ id: 'low' }, { id: 'high' }] },
    ];
    const published_catalog = await publishAgentModelCatalog(ctx(agentIdentity), communityId, options);
    expect(published_catalog.raw.pubkey).toBe(agentIdentity.publicKey);

    await expect(
      getAgentModelCatalog(ctx(owner), communityId, agentIdentity.publicKey),
    ).resolves.toMatchObject({ options });

    // A hand-crafted catalog event smuggling a `mode` axis is filtered on read.
    const withMode = signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: published_catalog.updatedAt + 5,
        kind: KIND_AGENT_MODEL_CATALOG,
        tags: [
          ['d', `${communityId}:${agentIdentity.publicKey}`],
          ['h', communityId],
          ['p', agentIdentity.publicKey],
          ['t', 'buzz-agent-model-catalog'],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({
          options: [
            ...options,
            { id: 'mode', category: 'mode', currentValue: 'agent', options: [{ id: 'bypassPermissions' }] },
          ],
        }),
      },
      agentIdentity.secretKey,
    );
    const parsed = parseAgentModelCatalog(withMode)!;
    expect(parsed.options.map((option) => option.category)).not.toContain('mode');
    expect(parsed.options).toEqual(options);
  });
});
