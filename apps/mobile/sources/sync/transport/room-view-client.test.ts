import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ monolithCalls: 0 }));
const fixture = {
  workspaces: [],
  viewer: { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' },
  truncated: false,
  watchFilters: [],
};

vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({
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
    monolithResponseTiming: () => null,
    monolithSession: {
      noteStalled: vi.fn(),
      fetch: vi.fn(async () => {
        controls.monolithCalls += 1;
        return new Response(JSON.stringify(fixture), { status: 200 });
      }),
    },
  };
});
import { RoomViewClient } from './room-view-client';

describe('mobile transport cutover switch', () => {
  beforeEach(() => {
    controls.monolithCalls = 0;
  });

  it('returns the guarded screen DTO from the monolith', async () => {
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
    });
    await expect(client.workspaces()).resolves.toEqual(fixture);
    expect(controls.monolithCalls).toBe(1);
  });

  it('maps a timed-out phone read to a distinct timeout error, never a silent retry', async () => {
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
      { timeoutMs: 15_000, idempotent: true },
    );
  });

  it('passes the message search signal to the request so a changed query cancels it', async () => {
    const workspaceId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const { monolithSession } = await import('@/auth/monolith-session');
    let sent: AbortSignal | undefined;
    vi.mocked(monolithSession.fetch).mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          sent = init?.signal ?? undefined;
          sent?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const client = new RoomViewClient({
      baseUrl: 'https://relay.example',
      identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
    });
    const controller = new AbortController();
    const search = client.searchMessages(workspaceId, 'gradle cache', undefined, controller.signal);
    expect(vi.mocked(monolithSession.fetch)).toHaveBeenLastCalledWith(
      `https://server.example/v1/phone/workspaces/${workspaceId}/search?q=gradle+cache`,
      expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }),
      { timeoutMs: 15_000, idempotent: true },
    );
    expect(sent?.aborted).toBe(false);
    controller.abort();
    expect(sent?.aborted).toBe(true);
    await expect(search).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('fails a read whose body stalls after the headers at the request deadline', async () => {
    vi.useFakeTimers();
    try {
      const { monolithSession } = await import('@/auth/monolith-session');
      const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
      vi.mocked(monolithSession.fetch).mockResolvedValueOnce(stalled);
      const client = new RoomViewClient({
        baseUrl: 'https://relay.example',
        identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
      });
      const read = client.historyAround('room', 'b'.repeat(64));
      const settled = expect(read).rejects.toMatchObject({ status: 0, code: 'timeout' });
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests older agent work with the server cursor instead of repeating the first page', async () => {
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
      { timeoutMs: 15_000, idempotent: true },
    );
    expect(older.recentWork).toEqual([olderWork]);
    expect(older.recentWorkCursor).toBeUndefined();
  });

  it('puts the archived-corners opt-in on the monolith request', async () => {
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
      { timeoutMs: 15_000, idempotent: true },
    );

    await client.corners(roomId, { archived: true, before: `1790000000000001,${roomId}` });

    expect(vi.mocked(monolithSession.fetch)).toHaveBeenCalledWith(
      `https://server.example/v1/phone/rooms/${roomId}/corners?archived=1&before=1790000000000001%2C${roomId}`,
      expect.objectContaining({ method: 'GET' }),
      { timeoutMs: 15_000, idempotent: true },
    );
  });
});
