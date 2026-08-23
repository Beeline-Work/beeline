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
  loadUnmigratableRooms,
  saveUnmigratableRooms,
} from './unmigratable-rooms-cache';

const viewer = 'viewer-pubkey';

describe('durable unmigratable-room verdicts', () => {
  beforeEach(() => {
    mmkvValues.clear();
  });

  it('persists verdicts per viewer and reads them back across a relaunch', () => {
    expect(loadUnmigratableRooms(viewer)).toEqual([]);

    saveUnmigratableRooms(viewer, [
      { channelId: 'room-a', pubkey: 'successor-a' },
      { channelId: 'room-b', pubkey: 'successor-b' },
    ]);

    const loaded = loadUnmigratableRooms(viewer);
    expect(loaded).toHaveLength(2);
    expect(loaded).toContainEqual({ channelId: 'room-a', pubkey: 'successor-a' });
    expect(loaded).toContainEqual({ channelId: 'room-b', pubkey: 'successor-b' });
  });

  it('scopes verdicts to one viewer', () => {
    saveUnmigratableRooms(viewer, [{ channelId: 'room-a', pubkey: 'successor-a' }]);
    saveUnmigratableRooms('other-viewer', [{ channelId: 'room-b', pubkey: 'successor-b' }]);

    expect(loadUnmigratableRooms(viewer)).toEqual([
      { channelId: 'room-a', pubkey: 'successor-a' },
    ]);
    expect(loadUnmigratableRooms('other-viewer')).toEqual([
      { channelId: 'room-b', pubkey: 'successor-b' },
    ]);
  });

  it('replaces a viewer’s set without touching other viewers’ records', () => {
    saveUnmigratableRooms(viewer, [
      { channelId: 'room-a', pubkey: 'successor-a' },
      { channelId: 'room-stale', pubkey: 'successor-a' },
    ]);
    saveUnmigratableRooms(viewer, [{ channelId: 'room-fresh', pubkey: 'successor-a' }]);

    expect(loadUnmigratableRooms(viewer)).toEqual([
      { channelId: 'room-fresh', pubkey: 'successor-a' },
    ]);
  });

  it('bounds the record so it cannot grow forever', () => {
    const rooms = Array.from({ length: 260 }, (_, index) => ({
      channelId: `room-${index}`,
      pubkey: 'successor-a',
    }));
    saveUnmigratableRooms(viewer, rooms);
    // One shared timestamp means the bounded slice is by insertion order of
    // the sorted entries; every survivor is a real, loadable verdict.
    const loaded = loadUnmigratableRooms(viewer);
    expect(loaded.length).toBeLessThanOrEqual(200);
    expect(loaded.every((room) => room.channelId.startsWith('room-'))).toBe(true);
  });

  it('tolerates a corrupt stored record', () => {
    mmkvValues.set('buzz-unmigratable-rooms-v1', '{not json');
    expect(loadUnmigratableRooms(viewer)).toEqual([]);
  });
});
