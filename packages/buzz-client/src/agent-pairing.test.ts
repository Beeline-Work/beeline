import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  createAgentPairingCode,
  listAgents,
  redeemAgentPairingCode,
  setAgentSoul,
} from './agent.js';
import { createAgentIdentity, createIdentity } from './identity.js';
import {
  KIND_AGENT_SOUL,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('owner');
const agentIdentity = createAgentIdentity('Hull runner');
const outsider = createIdentity('outsider');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = owner): ChannelOpsContext {
  return { http, identity };
}

function signed(identity: typeof owner, kind: number, tags: string[][]): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: '',
    },
    identity.secretKey,
  );
}

function communityCreate(): NostrEvent {
  return signed(owner, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', 'Builders'],
    [TAG_COMMUNITY, communityId],
  ]);
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

afterEach(() => vi.unstubAllGlobals());

describe('agent pairing and soul overlays', () => {
  it('redeems a short-lived code under the agent identity and is idempotent for that key', async () => {
    const published: NostrEvent[] = [];
    let agentIsMember = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER && tagValue(event, 'p') === agentIdentity.publicKey) {
            agentIsMember = true;
          }
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
              ...(agentIsMember ? [['p', agentIdentity.publicKey]] : []),
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_ADMINS, [
              ['d', communityId],
              ['p', owner.publicKey, 'owner'],
            ]),
          ]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const requiredTags = (filter['#t'] as string[] | undefined) ?? [];
          const pairingHashes = (filter['#pairing'] as string[] | undefined) ?? [];
          return jsonResponse(
            published.filter(
              (event) =>
                event.kind === KIND_STREAM_MESSAGE &&
                requiredTags.every((tag) => tagValues(event, 't').includes(tag)) &&
                pairingHashes.every((hash) => tagValue(event, 'pairing') === hash),
            ),
          );
        }
        return jsonResponse([]);
      }),
    );

    const pairing = await createAgentPairingCode(ctx(), communityId, 600);
    expect(pairing.code).toMatch(/^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(JSON.stringify(pairing.event)).not.toContain(pairing.code);
    expect(pairing.event.tags).toContainEqual(['t', TAG_AGENT_PAIRING]);

    const first = await redeemAgentPairingCode(ctx(agentIdentity), pairing.code.toLowerCase());
    expect(first).toMatchObject({ communityId, joined: true });
    expect(first.agent.pubkey).toBe(agentIdentity.publicKey);
    expect(first.agent.raw.tags).toContainEqual(['t', TAG_AGENT]);
    expect(first.agent.raw.pubkey).toBe(agentIdentity.publicKey);

    const second = await redeemAgentPairingCode(ctx(agentIdentity), pairing.code);
    expect(second).toMatchObject({ communityId, joined: false });
    expect(published.filter((event) => tagValues(event, 't').includes(TAG_AGENT))).toHaveLength(1);
  });

  it('joins a member-authored replaceable soul overlay without changing identity authority', async () => {
    const published: NostrEvent[] = [];
    const agentRecord = signEvent(
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
              ['p', agentIdentity.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([signed(owner, KIND_CHANNEL_ADMINS, [['d', communityId]])]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const authors = filterFrom(init).authors as string[] | undefined;
          return jsonResponse(
            !authors || authors.includes(agentRecord.pubkey) ? [agentRecord] : [],
          );
        }
        if (kind === KIND_AGENT_SOUL) return jsonResponse(published.filter((e) => e.kind === kind));
        return jsonResponse([]);
      }),
    );

    const profile = await setAgentSoul(ctx(), communityId, agentIdentity.publicKey, {
      name: 'Ada',
      personality: 'Keeps the suite green and refactors mercilessly.',
      intent: 'Keep the test suite green and refactor mercilessly.',
      avatarSeed: agentIdentity.publicKey,
      avatar: 'https://relay.test/media/ada.jpg',
    });
    expect(profile.raw.pubkey).toBe(owner.publicKey);
    expect(profile.raw.kind).toBe(KIND_AGENT_SOUL);
    expect(profile.raw.tags).toContainEqual(['t', TAG_AGENT_SOUL]);

    published.push(
      signEvent(
        {
          pubkey: outsider.publicKey,
          created_at: profile.updatedAt + 10,
          kind: KIND_AGENT_SOUL,
          tags: [
            ['d', `${communityId}:${agentIdentity.publicKey}`],
            ['h', communityId],
            ['p', agentIdentity.publicKey],
            ['t', TAG_AGENT_SOUL],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            name: 'Authority Impostor',
            personality: 'Claims permissions it does not have.',
            avatarSeed: 'malicious',
          }),
        },
        outsider.secretKey,
      ),
    );
    published.push(
      signEvent(
        {
          pubkey: agentIdentity.publicKey,
          created_at: profile.updatedAt + 20,
          kind: KIND_AGENT_SOUL,
          tags: [
            ['d', `${communityId}:${agentIdentity.publicKey}`],
            ['h', communityId],
            ['p', agentIdentity.publicKey],
            ['t', TAG_AGENT_SOUL],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            name: 'Self Authored',
            personality: 'An agent cannot replace its human-authored profile.',
            avatarSeed: agentIdentity.publicKey,
          }),
        },
        agentIdentity.secretKey,
      ),
    );

    await expect(listAgents(ctx(), communityId)).resolves.toMatchObject([
      {
        pubkey: agentIdentity.publicKey,
        displayName: 'Ada',
        avatar: 'https://relay.test/media/ada.jpg',
        personality: 'Keeps the suite green and refactors mercilessly.',
        soulProfile: {
          authoredBy: owner.publicKey,
          intent: 'Keep the test suite green and refactor mercilessly.',
        },
      },
    ]);
  });
});
