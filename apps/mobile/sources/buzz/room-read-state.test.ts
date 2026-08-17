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

import { isRoomUnread, roomReadAt, useRoomReadState } from './room-read-state';

const viewer = 'viewer-pubkey';

describe('Room read marks', () => {
  beforeEach(() => {
    mmkvValues.clear();
    useRoomReadState.setState({ readAt: {} });
  });

  it('scopes a mark to one viewer and one Room', () => {
    useRoomReadState.getState().markRoomRead(viewer, 'room-a', 100);
    const { readAt } = useRoomReadState.getState();
    expect(roomReadAt(readAt, viewer, 'room-a')).toBe(100);
    expect(roomReadAt(readAt, viewer, 'room-b')).toBeUndefined();
    expect(roomReadAt(readAt, 'other-viewer', 'room-a')).toBeUndefined();
    expect(roomReadAt(readAt, undefined, 'room-a')).toBeUndefined();
  });

  it('only ever moves a mark forward', () => {
    const { markRoomRead } = useRoomReadState.getState();
    markRoomRead(viewer, 'room-a', 100);
    markRoomRead(viewer, 'room-a', 50);
    expect(roomReadAt(useRoomReadState.getState().readAt, viewer, 'room-a')).toBe(100);
    markRoomRead(viewer, 'room-a', 150);
    expect(roomReadAt(useRoomReadState.getState().readAt, viewer, 'room-a')).toBe(150);
  });

  it('persists marks so unread state survives a relaunch', () => {
    useRoomReadState.getState().markRoomRead(viewer, 'room-a', 100);
    expect(JSON.parse(mmkvValues.get('buzz-room-reads-v1')!)).toEqual({
      [`${viewer}/room-a`]: 100,
    });
  });

  it('bounds the record so it cannot grow forever, keeping the most recent Rooms', () => {
    const { markRoomRead } = useRoomReadState.getState();
    for (let index = 0; index < 210; index += 1) markRoomRead(viewer, `room-${index}`, index + 1);
    const { readAt } = useRoomReadState.getState();
    expect(Object.keys(readAt)).toHaveLength(200);
    expect(roomReadAt(readAt, viewer, 'room-209')).toBe(210);
    expect(roomReadAt(readAt, viewer, 'room-0')).toBeUndefined();
  });

  describe('isRoomUnread', () => {
    it('marks a Room unread only for a message newer than the read mark', () => {
      expect(isRoomUnread(100, 101)).toBe(true);
      expect(isRoomUnread(100, 100)).toBe(false);
      expect(isRoomUnread(100, 99)).toBe(false);
    });

    it('stays quiet for a Room that has never been opened', () => {
      // Otherwise a freshly joined Workspace lights up every row at once, which
      // teaches the reader to ignore the signal.
      expect(isRoomUnread(undefined, 999)).toBe(false);
    });

    it('stays quiet for a Room with nothing said in it', () => {
      expect(isRoomUnread(100, undefined)).toBe(false);
      expect(isRoomUnread(undefined, undefined)).toBe(false);
    });
  });
});
