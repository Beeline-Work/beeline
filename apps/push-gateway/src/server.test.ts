import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip98AuthHeader } from '@beeline/nostr';
import { createIdentity, type RoomView } from '@beeline/buzz-client';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer, type RegistrationServerHooks } from './server.js';

const PUBLIC_ORIGIN = 'https://usebeeline.app';
const ROOM = '7d111868-52eb-43ab-98ae-8a6c49b92da8';
const WORKSPACE = 'ec08be9d-9d9d-413e-b546-959d4abe39df';
const CORNER = '80a5a6f1-fb5a-493b-93eb-f3db33f696e6';

function roomView(pubkey: string): RoomView {
  const identity = { pubkey, kind: 'human' as const, name: 'Ada' };
  return {
    room: {
      id: ROOM,
      workspaceId: WORKSPACE,
      name: 'Fast Room',
      archived: false,
      createdAt: 100,
      updatedAt: 102,
    },
    messages: [
      {
        id: '1'.repeat(64),
        text: 'Paint me directly',
        createdAt: 101,
        author: identity,
        presentation: 'message',
        reference: {
          channelId: ROOM,
          eventId: '1'.repeat(64),
          rootId: '1'.repeat(64),
        },
      },
    ],
    members: [{ identity, role: 'owner' }],
    latestAgentTurns: [],
    viewer: { identity, role: 'owner', permissions: { send: true, manage: true } },
    briefing: [],
    review: { status: 'none', files: [], approvedBy: [] },
    corners: [],
    watchFilters: [{ kinds: [9], '#h': [ROOM] }],
  };
}

function indexer(
  overrides: Partial<NonNullable<RegistrationServerHooks['indexer']>> = {},
): NonNullable<RegistrationServerHooks['indexer']> {
  const fallbackIdentity = { pubkey: 'f'.repeat(64), kind: 'human' as const, name: 'Viewer' };
  return {
    publicOrigin: PUBLIC_ORIGIN,
    readWorkspaces: async () => ({
      workspaces: [],
      viewer: fallbackIdentity,
      truncated: false,
      watchFilters: [],
    }),
    readWorkspace: async () => null,
    readChats: async () => null,
    readAgent: async () => null,
    readRoom: async () => null,
    readCorners: async () => null,
    readHistory: async () => null,
    readInvite: async () => null,
    ...overrides,
  };
}

describe('paint-view GET server', () => {
  const servers: ReturnType<typeof createRegistrationServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function listen(hooks: RegistrationServerHooks): Promise<string> {
    const server = createRegistrationServer(await TokenRegistry.load(), hooks);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function authorization(
    identity: ReturnType<typeof createIdentity>,
    path: string,
    method = 'GET',
  ): string {
    return nip98AuthHeader(
      identity.secretKey,
      identity.publicKey,
      `${PUBLIC_ORIGIN}${path}`,
      method,
    );
  }

  it('returns one whole directly renderable Room view and permits read replay', async () => {
    const identity = createIdentity('member');
    const readRoom = vi.fn(async (_roomId: string, pubkey: string) => roomView(pubkey));
    const base = await listen({ indexer: indexer({ readRoom }) });
    const path = `/room/${ROOM}`;
    const headers = { authorization: authorization(identity, path) };

    const first = await fetch(`${base}${path}`, { headers });
    const replay = await fetch(`${base}${path}`, { headers });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    await expect(first.json()).resolves.toEqual(roomView(identity.publicKey));
    expect(readRoom).toHaveBeenCalledTimes(2);
    expect(readRoom).toHaveBeenLastCalledWith(ROOM, identity.publicKey);
  });

  it('makes a non-member and a nonexistent Room indistinguishable', async () => {
    const identity = createIdentity('outsider');
    const base = await listen({ indexer: indexer() });
    const missing = '3f37b271-1a12-4d2a-b002-202b3f3582b9';

    const responses = await Promise.all(
      [ROOM, missing].map((roomId) => {
        const path = `/room/${roomId}`;
        return fetch(`${base}${path}`, {
          headers: { authorization: authorization(identity, path) },
        });
      }),
    );

    for (const response of responses) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'not_found' });
    }
  });

  it('binds signatures to the exact structural route and history tuple', async () => {
    const identity = createIdentity('signed-route');
    const readHistory = vi.fn(async () => ({ roomId: ROOM, messages: [] }));
    const readChats = vi.fn(async () => ({
      workspace: {
        id: WORKSPACE,
        name: 'Workspace',
        visibility: 'public' as const,
        role: 'member' as const,
        updatedAt: 1,
      },
      chats: [],
      viewer: { pubkey: identity.publicKey, kind: 'human' as const, name: 'Viewer' },
      truncated: false,
      watchFilters: [],
    }));
    const base = await listen({ indexer: indexer({ readHistory, readChats }) });
    const historyPath = `/room/${ROOM}/messages?before=100,${'a'.repeat(64)}`;
    const chatsPath = `/workspace/${WORKSPACE}/chats`;

    const history = await fetch(`${base}${historyPath}`, {
      headers: { authorization: authorization(identity, historyPath) },
    });
    const chats = await fetch(`${base}${chatsPath}`, {
      headers: { authorization: authorization(identity, chatsPath) },
    });
    const wrongProof = await fetch(`${base}${chatsPath}`, {
      headers: { authorization: authorization(identity, `/workspace/${WORKSPACE}`) },
    });

    expect(history.status).toBe(200);
    expect(chats.status).toBe(200);
    expect(wrongProof.status).toBe(401);
    expect(readHistory).toHaveBeenCalledWith(ROOM, identity.publicKey, {
      createdAt: 100,
      id: 'a'.repeat(64),
    });
  });

  it('requires signed identity but not membership for a redacted invite preview', async () => {
    const identity = createIdentity('invite-reader');
    const token = `bzi_${'a'.repeat(64)}`;
    const readInvite = vi.fn(async () => ({
      name: 'Join us',
      expiresAt: 2_000_000_000,
    }));
    const log = vi.fn();
    const base = await listen({ indexer: indexer({ readInvite, log }) });
    const path = '/invite/resolve';

    const anonymous = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });

    expect(anonymous.status).toBe(401);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: 'Join us',
      expiresAt: 2_000_000_000,
    });
    expect(readInvite).toHaveBeenCalledWith(
      '57834dc6caa89ae52702530a203648e640345fb0d6c4e8b4a587c7bceaac14f1',
      identity.publicKey,
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain(token);

    const malformed = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ token: 'not-a-token' }),
    });
    expect(malformed.status).toBe(404);
    expect(readInvite).toHaveBeenCalledTimes(1);

    const malformedJson = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: '{"token":',
    });
    expect(malformedJson.status).toBe(404);
    await expect(malformedJson.json()).resolves.toEqual({ error: 'not_found' });
    expect(readInvite).toHaveBeenCalledTimes(1);
  });

  it('uses the eighth slot for lazy selected-agent detail and has no corner-detail alias', async () => {
    const identity = createIdentity('agent-reader');
    const agentPubkey = 'a'.repeat(64);
    const readAgent = vi.fn(async () => ({
      workspaceId: WORKSPACE,
      agent: {
        identity: { pubkey: agentPubkey, kind: 'agent' as const, name: 'Scout' },
        role: 'member' as const,
      },
      catalog: [],
      watchFilters: [],
    }));
    const base = await listen({ indexer: indexer({ readAgent }) });
    const agentPath = `/workspace/${WORKSPACE}/agents/${agentPubkey}`;
    const oldCornerPath = `/room/${ROOM}/corners/${CORNER}`;

    const agent = await fetch(`${base}${agentPath}`, {
      headers: { authorization: authorization(identity, agentPath) },
    });
    const oldAlias = await fetch(`${base}${oldCornerPath}`, {
      headers: { authorization: authorization(identity, oldCornerPath) },
    });

    expect(agent.status).toBe(200);
    expect(oldAlias.status).toBe(404);
    expect(readAgent).toHaveBeenCalledWith(WORKSPACE, agentPubkey, identity.publicKey);
  });

  it('requires lower-case identifiers without revealing whether they exist', async () => {
    const identity = createIdentity('canonical-path');
    const base = await listen({ indexer: indexer() });
    const path = `/room/${ROOM.toUpperCase()}`;
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: authorization(identity, path) },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });
});
