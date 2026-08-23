import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { TAG_AGENT } from '@beeline/buzz-client';
import { newIdentity, type Identity } from './identity.js';
import { createChannel, createCommunity, KIND_CREATE_GROUP } from './buzz.js';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** The durable self-signed first-class agent record (`#t=buzz-agent`, kind:9). */
function agentRecord(agent: Identity): NostrEvent {
  return signEvent(
    {
      pubkey: agent.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 9,
      tags: [['t', TAG_AGENT]],
      content: '',
    },
    agent.secretKey,
  );
}

describe('agent-keyed room creation is refused', () => {
  it('refuses a registered agent identity as the creator of a top-level Room', async () => {
    const agent = newIdentity('registered-agent');
    const published: NostrEvent[] = [];
    let queried = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        queried += 1;
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
        const authors = (filter.authors as string[]) ?? [];
        return jsonResponse(authors.includes(agent.publicKey) ? [agentRecord(agent)] : []);
      }),
    );

    await expect(createChannel(agent, 'firstmate')).rejects.toThrow('human action');
    expect(published).toEqual([]);
    expect(queried).toBe(1);
  });

  it('refuses a registered agent identity as the creator of a Workspace', async () => {
    const agent = newIdentity('registered-agent');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) return jsonResponse({ accepted: true });
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
        const authors = (filter.authors as string[]) ?? [];
        return jsonResponse(authors.includes(agent.publicKey) ? [agentRecord(agent)] : []);
      }),
    );

    await expect(createCommunity(agent, 'workspace')).rejects.toThrow('human action');
  });

  it('still creates a top-level Room when the creator is human', async () => {
    const human = newIdentity('human-owner');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        return jsonResponse([]);
      }),
    );

    const channelId = await createCommunity(human, 'workspace');
    expect(channelId).toBeTruthy();
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(KIND_CREATE_GROUP);
    expect(published[0]!.pubkey).toBe(human.publicKey);
    expect(verifyEvent(published[0]!)).toBe(true);
  });

  it('still lets a registered agent open a corner (child channel with a parent)', async () => {
    const agent = newIdentity('registered-agent');
    const published: NostrEvent[] = [];
    let queried = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        queried += 1;
        return jsonResponse([]);
      }),
    );

    const channelId = await createChannel(agent, 'fix-the-thing', {
      parentChannelId: 'parent-room',
    });
    expect(channelId).toBeTruthy();
    // Corners are work items inside a human-governed Room — no registry
    // lookup, no refusal.
    expect(queried).toBe(0);
    expect(published).toHaveLength(1);
    expect(published[0]!.tags).toContainEqual(['parent', 'parent-room']);
  });
});
