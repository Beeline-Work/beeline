import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({
  viewer: 'viewer-a' as string | null,
  monolithUrl: 'https://server.test',
  reads: [] as string[],
  cached: null as RoomView | null,
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzViewerPubkey: async () => fixture.viewer,
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: {
    read: async (address: { endpoint: string }) => address.endpoint.startsWith('/room/') ? fixture.cached : null,
    peek: () => null,
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
    return { room: { id: roomId } } as unknown as RoomView;
  },
}));

import { resetClientState } from '@/sync/client-reset';
import { prefetchPushRoom, takePrefetchedPushRoom } from './push-room-prefetch';

beforeEach(() => {
  fixture.viewer = 'viewer-a';
  fixture.monolithUrl = 'https://server.test';
  fixture.reads = [];
  fixture.cached = null;
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
    fixture.cached = { room: { id: 'room-a' }, messages: [{ id: 'target' }] } as unknown as RoomView;
    prefetchPushRoom('received', 'room-a', 'target');
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.reads).toEqual([]);
    // The session consumes this only after its cached frame has committed.
    await takePrefetchedPushRoom('received', 'room-a');
    expect(fixture.reads).toEqual(['room-a']);
  });
  it('starts a missing-target read at the tap without waiting for the session', async () => {
    fixture.cached = { room: { id: 'room-a' }, messages: [{ id: 'old' }] } as unknown as RoomView;
    prefetchPushRoom('missing', 'room-a', 'target');
    await vi.waitFor(() => expect(fixture.reads).toEqual(['room-a']));
    await takePrefetchedPushRoom('missing', 'room-a');
  });
});
