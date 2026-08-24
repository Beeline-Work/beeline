import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));

import {
  isRoomRemoved,
  markRoomRemovedAndPurge,
  roomRemovalKey,
  useRemovedRooms,
} from './removed-rooms';
import { channelCacheKey, useBuzzLocalCache } from './local-cache';

const viewer = 'viewer-pubkey';

describe('Room removal tombstones', () => {
  beforeEach(() => {
    mmkvValues.clear();
    useRemovedRooms.setState({ removedAt: {} });
  });

  it('scopes a tombstone to one viewer and one Room', () => {
    useRemovedRooms.getState().markRoomRemoved(viewer, 'room-a');
    const { removedAt } = useRemovedRooms.getState();
    expect(isRoomRemoved(removedAt, viewer, 'room-a')).toBe(true);
    expect(isRoomRemoved(removedAt, viewer, 'room-b')).toBe(false);
    // Removal is per-viewer intent: another identity on the same device keeps
    // its own membership and its own list.
    expect(isRoomRemoved(removedAt, 'other-viewer', 'room-a')).toBe(false);
    expect(isRoomRemoved(removedAt, undefined, 'room-a')).toBe(false);
    expect(isRoomRemoved(removedAt, null, 'room-a')).toBe(false);
  });

  it('persists the tombstone synchronously so removal survives a relaunch', () => {
    useRemovedRooms.getState().markRoomRemoved(viewer, 'room-a');
    const stored = JSON.parse(mmkvValues.get('buzz-room-removals-v1')!);
    expect(stored[roomRemovalKey(viewer, 'room-a')]).toBeTypeOf('number');

    // Simulate an app restart: a fresh module instance hydrates from MMKV.
    vi.resetModules();
    return import('./removed-rooms').then((fresh) => {
      expect(fresh.isRoomRemoved(fresh.useRemovedRooms.getState().removedAt, viewer, 'room-a')).toBe(
        true,
      );
    });
  });

  it('is idempotent — re-marking only refreshes recency', () => {
    const { markRoomRemoved } = useRemovedRooms.getState();
    markRoomRemoved(viewer, 'room-a');
    const first = useRemovedRooms.getState().removedAt[roomRemovalKey(viewer, 'room-a')];
    markRoomRemoved(viewer, 'room-a');
    const second = useRemovedRooms.getState().removedAt[roomRemovalKey(viewer, 'room-a')];
    expect(second).toBeGreaterThanOrEqual(first);
    expect(Object.keys(useRemovedRooms.getState().removedAt)).toHaveLength(1);
  });

  it('bounds the record so it cannot grow forever, keeping the most recent removals', () => {
    const { markRoomRemoved } = useRemovedRooms.getState();
    for (let index = 0; index < 210; index += 1) markRoomRemoved(viewer, `room-${index}`);
    const { removedAt } = useRemovedRooms.getState();
    expect(Object.keys(removedAt)).toHaveLength(200);
    expect(isRoomRemoved(removedAt, viewer, 'room-209')).toBe(true);
    expect(isRoomRemoved(removedAt, viewer, 'room-0')).toBe(false);
  });

  describe('markRoomRemovedAndPurge (the leave/legacy-delete success path)', () => {
    beforeEach(() => {
      useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    });

    it('removes the row from the deck AND records the tombstone in one step', () => {
      const now = Date.now();
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey: viewer,
        communityId: 'workspace',
        channels: [
          { id: 'room-a', active: true, title: 'Kept', updatedAt: now },
          { id: 'room-b', active: false, archived: true, title: 'Deleted', updatedAt: now },
        ],
        directMessages: [],
        workspaceMembers: [],
        communities: [],
        personalWorkspaceId: null,
        viewerIsAgent: false,
        canEditWorkspaceAvatar: false,
        updatedAt: now,
        lastAccessedAt: now,
      });

      markRoomRemovedAndPurge(viewer, 'room-b');

      // Immediate removal from the deck…
      expect(
        useBuzzLocalCache
          .getState()
          .channelLists[`${viewer}:workspace`]?.channels.map(({ id }) => id),
      ).toEqual(['room-a']);
      // …and the durable tombstone that keeps refreshes from resurrecting it.
      expect(isRoomRemoved(useRemovedRooms.getState().removedAt, viewer, 'room-b')).toBe(true);
      expect(useBuzzLocalCache.getState().channels[channelCacheKey(viewer, 'room-b')]).toBeUndefined();
    });

    it('is exactly what makes an already-archived delete stick (#396): the archive publish being a no-op changes nothing here', () => {
      // The relay refused the archive (already archived) so nothing changed
      // server-side; the local teardown must still run to completion.
      useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
      markRoomRemovedAndPurge(viewer, 'room-c');
      expect(isRoomRemoved(useRemovedRooms.getState().removedAt, viewer, 'room-c')).toBe(true);
    });
  });
});
