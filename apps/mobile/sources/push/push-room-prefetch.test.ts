import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/api-contract/phone';

const fixture = vi.hoisted(() => ({
  viewer: 'viewer-a' as string | null,
  monolithUrl: 'https://server.test',
  reads: [] as string[],
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzViewerPubkey: async () => fixture.viewer,
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
