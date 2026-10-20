import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({
  viewer: 'viewer-a' as string | null,
  monolithUrl: 'https://server.test',
  reads: [] as string[],
  cached: null as RoomView | null,
  response: null as Promise<RoomView> | null,
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzViewerPubkey: async () => fixture.viewer,
  peekBuzzViewerContext: () => fixture.viewer ? { relayUrl: fixture.monolithUrl, viewerPubkey: fixture.viewer } : null,
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: {
    read: async (address: { endpoint: string }) => address.endpoint.startsWith('/room/') ? fixture.cached : null,
    peek: (address: { endpoint: string }) => address.endpoint.startsWith('/room/') ? fixture.cached : null,
    publish: (_address: unknown, view: RoomView) => { fixture.cached = view; return view; },
    persist: async () => undefined,
  },
  surfaceAddress: (_origin: string, _viewer: string, endpoint: string) => ({ endpoint }),
}));
vi.mock('@/buzz/runtime-config', () => ({
  getBuzzRuntimeConfig: () => ({ monolithEnabled: true, monolithUrl: fixture.monolithUrl }),
}));
vi.mock('@/buzz/room-open-trace', () => ({ markRoomOpen: () => undefined }));
vi.mock('@/sync/transport/room-view-client', () => ({
  readPushedMonolithRoom: async (roomId: string) => {
    fixture.reads.push(roomId);
    if (fixture.response) return fixture.response;
    return { room: { id: roomId }, messages: [], members: [] } as unknown as RoomView;
  },
}));

import { resetClientState } from '@/sync/client-reset';
import { prefetchPushRoom, takePrefetchedPushRoom } from './push-room-prefetch';

beforeEach(() => {
  fixture.viewer = 'viewer-a';
  fixture.monolithUrl = 'https://server.test';
  fixture.reads = [];
  fixture.cached = null;
  fixture.response = null;
});

describe('push Room prefetch', () => {
  it('hands the read to the Room it was started for', async () => {
    prefetchPushRoom('response-1', 'room-a');
    const view = takePrefetchedPushRoom('response-1', 'room-a');
    await expect(view).resolves.toMatchObject({ room: { id: 'room-a' } });
  });

  it('drops a pending read when the identity changes before the Room takes it', async () => {
    prefetchPushRoom('response-2', 'room-a');
    fixture.viewer = 'viewer-b';
    resetClientState();
    expect(takePrefetchedPushRoom('response-2', 'room-a')).toBeNull();
  });

  it('refuses a read for an account that changed without a reset', async () => {
    prefetchPushRoom('response-3', 'room-a');
    fixture.viewer = 'viewer-b';
    await expect(takePrefetchedPushRoom('response-3', 'room-a')).rejects.toThrow('another account');
  });

  it('refuses a taken read when the identity changes before it lands', async () => {
    prefetchPushRoom('response-5', 'room-a');
    const view = takePrefetchedPushRoom('response-5', 'room-a');
    resetClientState();
    await expect(view).rejects.toThrow('another account');
  });

  it('refuses a read sent to another server', () => {
    prefetchPushRoom('response-4', 'room-a');
    fixture.monolithUrl = 'https://other.test';
    expect(takePrefetchedPushRoom('response-4', 'room-a')).toBeNull();
  });
});

describe('received versus missing pushed rows', () => {
  it('starts no network read while a received target waits to paint', async () => {
    fixture.cached = { room: { id: 'room-a' }, members: [], messages: [{ id: 'target' }] } as unknown as RoomView;
    prefetchPushRoom('received', 'room-a', 'target');
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.reads).toEqual([]);
    // The session consumes this only after its cached frame has committed.
    await takePrefetchedPushRoom('received', 'room-a');
    expect(fixture.reads).toEqual(['room-a']);
  });
  it('starts a missing-target read at the tap without waiting for the session', async () => {
    fixture.cached = { room: { id: 'room-a' }, members: [], messages: [{ id: 'old' }] } as unknown as RoomView;
    prefetchPushRoom('missing', 'room-a', 'target');
    expect(fixture.reads).toEqual(['room-a']);
    await takePrefetchedPushRoom('missing', 'room-a');
  });
});

it('publishes a missing row as soon as its opening response arrives, before the Room consumes it', async () => {
  const view = { room: { id: 'room-a' }, members: [], messages: [{ id: 'new-target' }] } as unknown as RoomView;
  fixture.response = Promise.resolve(view);
  prefetchPushRoom('early', 'room-a', 'new-target');
  await vi.waitFor(() => expect(fixture.cached).toBe(view));
  expect(await takePrefetchedPushRoom('early', 'room-a')).toBe(view);
});

it('cannot publish an opening response after its account has changed', async () => {
  let reply!: (view: RoomView) => void;
  fixture.response = new Promise((resolve) => { reply = resolve; });
  prefetchPushRoom('old-account', 'room-a', 'target');
  await vi.waitFor(() => expect(fixture.reads).toEqual(['room-a']));
  fixture.viewer = 'viewer-b';
  reply({ room: { id: 'room-a' } } as unknown as RoomView);
  await expect(takePrefetchedPushRoom('old-account', 'room-a')).rejects.toThrow('another account');
  expect(fixture.cached).toBeNull();
});

it('starts a new pushed-target read without joining an older tap and preserves newer committed rows', async () => {
  const view = (id: string, createdAt: number) => ({ room: { id: 'room-a' }, members: [], messages: [
    { id, text: id, createdAt, author: { pubkey: 'author', kind: 'human', name: 'Author' }, presentation: 'message' },
  ] }) as unknown as RoomView;
  let finishFirst!: (value: RoomView) => void;
  fixture.response = new Promise((resolve) => { finishFirst = resolve; });
  prefetchPushRoom('first-tap', 'room-a', 'first-target');
  await vi.waitFor(() => expect(fixture.reads).toHaveLength(1));
  fixture.response = Promise.resolve(view('second-target', 20));
  prefetchPushRoom('second-tap', 'room-a', 'second-target');
  await vi.waitFor(() => expect(fixture.cached?.messages.at(-1)?.id).toBe('second-target'));
  expect(fixture.reads).toHaveLength(2);
  finishFirst(view('first-target', 10));
  await vi.waitFor(() => expect(fixture.cached?.messages.some((row) => row.id === 'first-target')).toBe(true));
  expect(fixture.cached?.messages.at(-1)?.id).toBe('second-target');
  expect((await takePrefetchedPushRoom('second-tap', 'room-a'))?.messages.at(-1)?.id).toBe('second-target');
});
