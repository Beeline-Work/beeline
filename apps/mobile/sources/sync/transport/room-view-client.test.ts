import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ enabled: false, legacyCalls: 0, monolithCalls: 0 }));
const fixture = {
  workspaces: [],
  viewer: { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' },
  truncated: false,
  watchFilters: [],
};

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
    monolithEnabled: controls.enabled,
    monolithUrl: 'https://server.example',
  }),
}));
vi.mock('@/auth/monolith-session', () => {
  class MonolithRequestTimeoutError extends Error {
    constructor() {
      super('The server did not respond in time.');
      this.name = 'MonolithRequestTimeoutError';
    }
  }
  return {
    MONOLITH_REQUEST_TIMEOUT_MS: 15_000,
    MonolithRequestTimeoutError,
    monolithSession: {
      fetch: vi.fn(async () => {
        controls.monolithCalls += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }),
    },
  };
});
vi.mock('@beeline/buzz-client', async (original) => {
  const actual = await original<typeof import('@beeline/buzz-client')>();
  return {
    ...actual,
    RoomViewClient: class {
      workspaces() {
        controls.legacyCalls += 1;
        return Promise.resolve(fixture);
      }
      workspace() {
        throw new Error('unused');
      }
      agent() {
        throw new Error('unused');
      }
      chats() {
        throw new Error('unused');
      }
      room() {
        throw new Error('unused');
      }
      corners() {
        throw new Error('unused');
      }
      history() {
        throw new Error('unused');
      }
      invite() {
        throw new Error('unused');
      }
      claimAgentPairing() {
        throw new Error('unused');
      }
      abandonAgentPairing() {
        throw new Error('unused');
      }
    },
  };
});

import { RoomViewClient } from './room-view-client';

describe('mobile transport cutover switch', () => {
  beforeEach(() => {
    controls.enabled = false;
    controls.legacyCalls = 0;
    controls.monolithCalls = 0;
  });

  it.each([false, true])(
    'returns the identical guarded screen DTO when monolith=%s',
    async (enabled) => {
      controls.enabled = enabled;
      const client = new RoomViewClient({
        baseUrl: 'https://relay.example',
        identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
      });
      await expect(client.workspaces()).resolves.toEqual(fixture);
      expect(controls.monolithCalls).toBe(enabled ? 1 : 0);
      expect(controls.legacyCalls).toBe(enabled ? 0 : 1);
    },
  );

  it('maps a timed-out phone read to a distinct timeout error, never a silent retry', async () => {
    controls.enabled = true;
    const { monolithSession, MonolithRequestTimeoutError } = await import(
      '@/auth/monolith-session'
    );
    vi.mocked(monolithSession.fetch).mockRejectedValueOnce(new MonolithRequestTimeoutError());
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
    });
    await expect(client.room('room-a')).rejects.toMatchObject({ status: 0, code: 'timeout' });
    expect(vi.mocked(monolithSession.fetch)).toHaveBeenCalledWith(
      'https://server.example/v1/phone/rooms/room-a',
      expect.objectContaining({ method: 'GET' }),
      { timeoutMs: 15_000 },
    );
  });

  it('requests older agent work with the server cursor instead of repeating the first page', async () => {
    controls.enabled = true;
    const workspaceId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const agentId = 'b'.repeat(64);
    const cursor = JSON.stringify(['2026-09-24T00:00:00Z', 'https://github.com/acme/repo/pull/6']);
    const firstWork = { title: 'Newest work', url: 'https://github.com/acme/repo/pull/6' };
    const olderWork = { title: 'Older work', url: 'https://github.com/acme/repo/pull/5' };
    const { monolithSession } = await import('@/auth/monolith-session');
    vi.mocked(monolithSession.fetch).mockImplementation(async (input) => {
      const older = new URL(String(input)).searchParams.get('workCursor') === cursor;
      return Response.json({
        workspaceId,
        agent: { identity: { pubkey: agentId, kind: 'agent', name: 'Agent' }, role: 'member' },
        recentWork: [older ? olderWork : firstWork],
        ...(older ? {} : { recentWorkCursor: cursor }),
        catalog: [],
        watchFilters: [],
      });
    });
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity: { publicKey: fixture.viewer.pubkey, secretKey: new Uint8Array(32) },
    });
    const first = await client.agent(workspaceId, agentId);
    expect(first.recentWork).toEqual([firstWork]);
    expect(first.recentWorkCursor).toBe(cursor);
    const older = await client.agent(workspaceId, agentId, first.recentWorkCursor);
    expect(vi.mocked(monolithSession.fetch)).toHaveBeenLastCalledWith(
      `https://server.example/v1/phone/workspaces/${workspaceId}/agents/${agentId}?workCursor=${encodeURIComponent(cursor)}`,
      expect.objectContaining({ method: 'GET' }),
      { timeoutMs: 15_000 },
    );
    expect(older.recentWork).toEqual([olderWork]);
    expect(older.recentWorkCursor).toBeUndefined();
  });

  it('puts the archived-corners opt-in on the monolith request', async () => {
    controls.enabled = true;
    const roomId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const { monolithSession } = await import('@/auth/monolith-session');
    vi.mocked(monolithSession.fetch).mockImplementation(async () =>
      Response.json({
        room: {
          id: roomId,
          name: 'Alpha',
          archived: false,
          createdAt: 1,
          updatedAt: 2,
        },
        corners: [],
        viewer: {
          identity: fixture.viewer,
          role: 'owner',
          permissions: { send: true, manage: true },
        },
        watchFilters: [],
      }),
    );
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
    });

    await client.corners(roomId, { archived: true });

    expect(vi.mocked(monolithSession.fetch)).toHaveBeenCalledWith(
      `https://server.example/v1/phone/rooms/${roomId}/corners?archived=1`,
      expect.objectContaining({ method: 'GET' }),
      { timeoutMs: 15_000 },
    );

    await client.corners(roomId, { archived: true, before: `1790000000000001,${roomId}` });

    expect(vi.mocked(monolithSession.fetch)).toHaveBeenCalledWith(
      `https://server.example/v1/phone/rooms/${roomId}/corners?archived=1&before=1790000000000001%2C${roomId}`,
      expect.objectContaining({ method: 'GET' }),
      { timeoutMs: 15_000 },
    );
  });
});
