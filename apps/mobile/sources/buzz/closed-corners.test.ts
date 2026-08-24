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
  cornerClosureKey,
  isCornerClosed,
  markCornerClosedAndPurge,
  useClosedCorners,
} from './closed-corners';
import { useBuzzLocalCache } from './local-cache';

const viewer = 'viewer-pubkey';
const room = 'room-a';
const corner = 'corner-1';

describe('closed-corner tombstones', () => {
  beforeEach(() => {
    mmkvValues.clear();
    useClosedCorners.setState({ closedAt: {} });
  });

  it('scopes a tombstone to one viewer, one Room, and one corner', () => {
    useClosedCorners.getState().markCornerClosed(viewer, room, corner);
    const { closedAt } = useClosedCorners.getState();
    expect(isCornerClosed(closedAt, viewer, room, corner)).toBe(true);
    expect(isCornerClosed(closedAt, viewer, room, 'corner-2')).toBe(false);
    expect(isCornerClosed(closedAt, viewer, 'room-b', corner)).toBe(false);
    // Dismissal is per-viewer intent: another identity on the same device
    // keeps its own view.
    expect(isCornerClosed(closedAt, 'other-viewer', room, corner)).toBe(false);
    expect(isCornerClosed(closedAt, undefined, room, corner)).toBe(false);
    expect(isCornerClosed(closedAt, null, room, corner)).toBe(false);
  });

  it('persists the tombstone synchronously so the close survives a relaunch', () => {
    useClosedCorners.getState().markCornerClosed(viewer, room, corner);
    const stored = JSON.parse(mmkvValues.get('buzz-corner-closures-v1')!);
    expect(stored[cornerClosureKey(viewer, room, corner)]).toBeTypeOf('number');

    // Simulate an app restart: a fresh module instance hydrates from MMKV.
    vi.resetModules();
    return import('./closed-corners').then((fresh) => {
      expect(
        fresh.isCornerClosed(
          fresh.useClosedCorners.getState().closedAt,
          viewer,
          room,
          corner,
        ),
      ).toBe(true);
    });
  });

  it('is idempotent — re-closing an already-closed corner only refreshes recency', () => {
    const { markCornerClosed } = useClosedCorners.getState();
    markCornerClosed(viewer, room, corner);
    const first = useClosedCorners.getState().closedAt[cornerClosureKey(viewer, room, corner)];
    markCornerClosed(viewer, room, corner);
    const second = useClosedCorners.getState().closedAt[cornerClosureKey(viewer, room, corner)];
    expect(second).toBeGreaterThanOrEqual(first);
    expect(Object.keys(useClosedCorners.getState().closedAt)).toHaveLength(1);
  });

  it('bounds the record so it cannot grow forever, keeping the most recent closures', () => {
    const { markCornerClosed } = useClosedCorners.getState();
    for (let index = 0; index < 410; index += 1) {
      markCornerClosed(viewer, `room-${index}`, `corner-${index}`);
    }
    const { closedAt } = useClosedCorners.getState();
    expect(Object.keys(closedAt)).toHaveLength(400);
    expect(isCornerClosed(closedAt, viewer, 'room-409', 'corner-409')).toBe(true);
    expect(isCornerClosed(closedAt, viewer, 'room-0', 'corner-0')).toBe(false);
  });

  describe('markCornerClosedAndPurge (the close-button success path)', () => {
    beforeEach(() => {
      useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    });

    function seedRoomWithCorners() {
      const now = Date.now();
      useBuzzLocalCache.getState().setChannelList({
        viewerPubkey: viewer,
        communityId: 'workspace',
        channels: [
          {
            id: room,
            active: true,
            title: 'Room',
            updatedAt: now,
            corners: [
              {
                id: corner,
                name: 'closed work',
                openerPubkey: 'agent-pubkey',
                status: 'live',
              },
              {
                id: 'corner-still-open',
                name: 'open work',
                openerPubkey: 'agent-pubkey',
                status: 'live',
              },
            ],
          },
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
    }

    it('removes the closed corner from the cached Room row AND records the tombstone in one step', () => {
      seedRoomWithCorners();

      markCornerClosedAndPurge(viewer, room, corner);

      // Immediate removal from the deck's dropdown/count source…
      const corners = useBuzzLocalCache
        .getState()
        .channelLists[`${viewer}:workspace`]?.channels[0]?.corners;
      expect(corners?.map(({ id }) => id)).toEqual(['corner-still-open']);
      // …and the durable tombstone that keeps lifecycle refreshes from
      // re-listing it before relay state catches up.
      expect(isCornerClosed(useClosedCorners.getState().closedAt, viewer, room, corner)).toBe(
        true,
      );
    });

    it('is exactly what makes closing an already-archived corner stick (#396 semantics): the no-op archive changes nothing here', () => {
      // The daemon's archive was a no-op (already archived) or never landed;
      // the local teardown must still run to completion and stay stuck.
      useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
      markCornerClosedAndPurge(viewer, 'room-x', 'corner-x');
      expect(isCornerClosed(useClosedCorners.getState().closedAt, viewer, 'room-x', 'corner-x')).toBe(
        true,
      );
    });
  });
});
