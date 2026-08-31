import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
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
    claimAgentPairing: async () => null,
    abandonAgentPairing: async () => false,
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

  it('reports the aligned server release and daemon READY records in health', async () => {
    const base = await listen({
      releaseStatus: async () => ({
        version: 'v0.0.1',
        sourceSha: '1'.repeat(40),
        daemons: [
          {
            agentPubkey: 'a'.repeat(64),
            state: 'ready',
            releaseVersion: 'v0.0.1',
            sourceSha: '1'.repeat(40),
            pid: 42,
            readyAt: '2026-08-31T12:00:00.000Z',
          },
        ],
      }),
    });

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      release: { version: 'v0.0.1', sourceSha: '1'.repeat(40) },
      daemons: [
        {
          state: 'ready',
          releaseVersion: 'v0.0.1',
          sourceSha: '1'.repeat(40),
        },
      ],
    });
  });

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

  it('returns the same private authorization refusal for every indexer route family', async () => {
    const identity = createIdentity('untrusted-proxy');
    const base = await listen({ indexer: indexer() });
    const requests = [
      {
        path: `/room/${ROOM}`,
        init: { headers: { authorization: authorization(identity, `/room/${ROOM}`) } },
      },
      {
        path: '/invite/resolve',
        init: {
          method: 'POST',
          headers: {
            authorization: authorization(identity, '/invite/resolve', 'POST'),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ token: `bzi_${'a'.repeat(64)}` }),
        },
      },
      {
        path: '/agent-pairing/claim',
        init: {
          method: 'POST',
          headers: {
            authorization: authorization(identity, '/agent-pairing/claim', 'POST'),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ code: 'BUZZ-4S4P-ZPJP' }),
        },
      },
    ];

    for (const { path, init } of requests) {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, 'x-forwarded-proto': 'https' },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      await expect(response.json()).resolves.toEqual({
        error: 'valid_identity_authorization_required',
      });
    }
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

  it('keeps a legacy pairing claim Workspace-only when it does not advertise Room rollback', async () => {
    const identity = createIdentity('pairing-agent');
    const code = 'BUZZ-4S4P-ZPJP';
    const claimAgentPairing = vi.fn(async () => ({
      workspaceId: WORKSPACE,
      pairedBy: 'd'.repeat(64),
      joined: true,
      attachedRoomIds: [ROOM],
    }));
    const base = await listen({ indexer: indexer({ claimAgentPairing }) });
    const path = '/agent-pairing/claim';
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: code.toLowerCase() }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: WORKSPACE,
      pairedBy: 'd'.repeat(64),
      joined: true,
      attachedRoomIds: [ROOM],
    });
    expect(claimAgentPairing).toHaveBeenCalledWith(
      createHash('sha256').update(code).digest('hex'),
      identity.publicKey,
      { inheritInviterRooms: false },
    );
  });

  it('permits inherited Rooms only when a pairing client advertises Room rollback', async () => {
    const identity = createIdentity('rollback-aware-pairing-agent');
    const code = 'BUZZ-4S4P-ZPJP';
    const claimAgentPairing = vi.fn(async () => ({
      workspaceId: WORKSPACE,
      pairedBy: 'd'.repeat(64),
      joined: true,
      attachedRoomIds: [ROOM],
    }));
    const base = await listen({ indexer: indexer({ claimAgentPairing }) });
    const path = '/agent-pairing/claim';
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code, capabilities: ['pairing-room-rollback'] }),
    });

    expect(response.status).toBe(200);
    expect(claimAgentPairing).toHaveBeenCalledWith(
      createHash('sha256').update(code).digest('hex'),
      identity.publicKey,
      { inheritInviterRooms: true },
    );
  });

  it('abandons only the authenticated agent’s exact pairing claim', async () => {
    const identity = createIdentity('pairing-abandon-agent');
    const code = 'BUZZ-4S4P-ZPJP';
    const abandonAgentPairing = vi.fn(async () => true);
    const base = await listen({ indexer: indexer({ abandonAgentPairing }) });
    const path = '/agent-pairing/abandon';
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: code.toLowerCase() }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ abandoned: true });
    expect(abandonAgentPairing).toHaveBeenCalledWith(
      createHash('sha256').update(code).digest('hex'),
      identity.publicKey,
    );
  });

  it('does not reveal an unclaimed pairing rollback', async () => {
    const identity = createIdentity('pairing-abandon-miss');
    const abandonAgentPairing = vi.fn(async () => false);
    const base = await listen({ indexer: indexer({ abandonAgentPairing }) });
    const path = '/agent-pairing/abandon';
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ code: 'BUZZ-4S4P-ZPJP' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
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

  it('stores a signed device update receipt and exposes it only to receipt authorization', async () => {
    const identity = createIdentity('owner-device');
    const base = await listen({ otaReceiptAdminToken: 'operator-receipt-secret' });
    const path = '/update-receipts';
    const body = {
      pubkey: identity.publicKey,
      deviceId: '11111111-2222-3333-4444-555555555555',
      updateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      channel: 'production',
      group: '99999999-8888-7777-6666-555555555555',
      runtimeVersion: '21',
      releaseVersion: 'v0.0.1',
      sourceSha: '1'.repeat(40),
      environment: 'physical',
    };

    const unauthorizedPost = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const posted = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: authorization(identity, path, 'POST'),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const queryPath = `/update-receipts/${identity.publicKey}`;
    const anonymous = await fetch(`${base}${queryPath}`);
    const operator = await fetch(`${base}${queryPath}`, {
      headers: { authorization: 'Bearer operator-receipt-secret' },
    });

    expect(unauthorizedPost.status).toBe(401);
    expect(posted.status).toBe(201);
    expect(anonymous.status).toBe(401);
    expect(operator.status).toBe(200);
    expect(operator.headers.get('cache-control')).toBe('private, no-store');
    await expect(operator.json()).resolves.toEqual({
      pubkey: identity.publicKey,
      devices: [expect.objectContaining(body)],
    });
  });
});
