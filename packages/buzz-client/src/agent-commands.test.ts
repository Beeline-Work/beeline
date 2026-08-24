import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  MAX_AGENT_COMMANDS,
  agentCommandsKey,
  getAgentCommands,
  parseAgentCommandEntries,
  parseAgentCommands,
  publishAgentCommands,
} from './agent-commands.js';
import { createIdentity } from './identity.js';
import { TAG_AGENT_COMMANDS, TAG_COMMUNITY } from './kinds.js';
import { tagValue } from './parse.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '22222222-2222-4222-8222-222222222222';
const agentIdentity = createIdentity('agent');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function agentCtx(): ChannelOpsContext {
  return { http: { ...http, identity: agentIdentity }, identity: agentIdentity };
}

function signedBy(
  identity: typeof agentIdentity,
  kind: number,
  tags: string[][],
  content = '',
): NostrEvent {
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

function validEvent(content: string, overrides: Partial<NostrEvent> = {}): NostrEvent {
  return signEvent(
    {
      pubkey: agentIdentity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 30078,
      tags: [
        ['d', `${communityId}:${agentIdentity.publicKey}`],
        ['h', communityId],
        ['p', agentIdentity.publicKey],
        ['t', TAG_AGENT_COMMANDS],
        [TAG_COMMUNITY, communityId],
      ],
      content,
      ...overrides,
    },
    agentIdentity.secretKey,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent command list records', () => {
  it('parses a verified self-authored command list', () => {
    const event = validEvent(
      JSON.stringify({
        commands: [
          { name: '/loop', description: 'Run in a loop' },
          { name: 'review', description: 'Review the diff', inputHint: '[pr-number]' },
        ],
      }),
    );
    const parsed = parseAgentCommands(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.communityId).toBe(communityId);
    expect(parsed?.agentPubkey).toBe(agentIdentity.publicKey);
    expect(parsed?.commands).toEqual([
      { name: 'loop', description: 'Run in a loop' },
      { name: 'review', description: 'Review the diff', inputHint: '[pr-number]' },
    ]);
  });

  it('refuses foreign-authored or malformed records', () => {
    const stranger = createIdentity('stranger');
    const foreign = signEvent(
      {
        pubkey: stranger.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 30078,
        tags: [
          ['d', `${communityId}:${agentIdentity.publicKey}`],
          ['h', communityId],
          ['p', agentIdentity.publicKey],
          ['t', TAG_AGENT_COMMANDS],
          [TAG_COMMUNITY, communityId],
        ],
        content: '{"commands":[]}',
      },
      stranger.secretKey,
    );
    expect(parseAgentCommands(foreign)).toBeNull();
    expect(parseAgentCommands(validEvent('not json'))).toBeNull();
    const wrongTag = signedBy(agentIdentity, 30078, [['t', 'other']], '{}');
    expect(parseAgentCommands(wrongTag)).toBeNull();
  });

  it('drops malformed entries and dedupes names when parsing entries', () => {
    const entries = parseAgentCommandEntries([
      { name: '/alpha', description: 'first' },
      { name: '', description: 'no name' },
      { name: 'beta', description: 42 },
      { name: 'alpha', description: 'duplicate' },
      { name: 'gamma', input: { hint: '[file]' } },
      null,
      'junk',
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(entries[2]?.inputHint).toBe('[file]');
  });

  it('caps the published list size', () => {
    const many = Array.from({ length: MAX_AGENT_COMMANDS + 25 }, (_, index) => ({
      name: `cmd-${index}`,
      description: 'x'.repeat(500),
    }));
    const entries = parseAgentCommandEntries(many);
    expect(entries).toHaveLength(MAX_AGENT_COMMANDS);
    expect(entries[0]?.description).toHaveLength(300);
  });

  it('publishes a replaceable record and reads the latest back', async () => {
    const posts: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        posts.push({ url: String(url), init });
        // Echo the signed event back the way publishEvent expects.
        const body = JSON.parse(String(init?.body)) as { content: string };
        void body;
        return jsonResponse({ ok: true }) as unknown;
      }),
    );
    await publishAgentCommands(agentCtx(), communityId, [
      { name: 'loop', description: 'Loop' },
    ]);
    const publishedEvent = JSON.parse(String(posts[0]?.init?.body)) as NostrEvent;
    expect(tagValue(publishedEvent, 'd')).toBe(
      agentCommandsKey(communityId, agentIdentity.publicKey),
    );
    // The read path queries by the #d key with a small limit window.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const filter = filterFrom(init);
        expect(filter.kinds).toEqual([30078]);
        expect(filter['#d']).toEqual([
          agentCommandsKey(communityId, agentIdentity.publicKey),
        ]);
        return jsonResponse([
          validEvent(JSON.stringify({ commands: [{ name: 'old-command' }] })),
          validEvent(
            JSON.stringify({ commands: [{ name: 'new-command' }] }),
            { created_at: Math.floor(Date.now() / 1000) + 10 },
          ),
        ]) as unknown;
      }),
    );
    const latest = await getAgentCommands(agentCtx(), communityId, agentIdentity.publicKey);
    expect(latest?.commands.map((command) => command.name)).toEqual(['new-command']);
  });
});
