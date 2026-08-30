import { describe, expect, it, vi } from 'vitest';
import { surfaceAddress } from './surface-storage';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() { return undefined; }
    set() {}
    delete() {}
    getAllKeys() { return []; }
  },
}));

describe('Buzz server-indexed cache addressing', () => {
  it('partitions the Room list by relay, viewer, and Workspace', () => {
    expect(
      surfaceAddress('https://relay.test', 'viewer-a', '/workspace/:id/chats', {
        workspaceId: 'workspace-1',
      }),
    ).toEqual({
      relayOrigin: 'https://relay.test',
      viewerPubkey: 'viewer-a',
      endpoint: '/workspace/:id/chats',
      params: { workspaceId: 'workspace-1' },
    });
  });

  it('partitions one Room transcript from every other Room', () => {
    const roomA = surfaceAddress('https://relay.test', 'viewer-a', '/room/:id', {
      roomId: 'room-a',
    });
    const roomB = surfaceAddress('https://relay.test', 'viewer-a', '/room/:id', {
      roomId: 'room-b',
    });
    expect(roomA).not.toEqual(roomB);
  });

  it('partitions cached responses by viewer identity', () => {
    const viewerA = surfaceAddress('https://relay.test', 'viewer-a', '/workspaces');
    const viewerB = surfaceAddress('https://relay.test', 'viewer-b', '/workspaces');
    expect(viewerA).not.toEqual(viewerB);
  });
});
