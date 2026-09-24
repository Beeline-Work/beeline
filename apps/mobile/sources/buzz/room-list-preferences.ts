import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowName } from './room-list-row';

export type RoomListFilter = 'all' | 'unread' | 'messages' | 'pinned';
export function useRoomListFilter(
  workspace: string | null,
  ready: boolean,
  hasPinnedRoom: boolean,
) {
  const [selection, setSelection] = useState<{
    workspace: string | null;
    filter: RoomListFilter;
    chosen: boolean;
  }>({ workspace, filter: 'all', chosen: false });
  const filter = selection.workspace === workspace ? selection.filter : 'all';
  useEffect(() => {
    if (!workspace) return;
    setSelection((current) => {
      if (current.workspace === workspace && current.chosen) return current;
      if (!ready) {
        return current.workspace === workspace
          ? current
          : { workspace, filter: 'all', chosen: false };
      }
      return { workspace, filter: hasPinnedRoom ? 'pinned' : 'all', chosen: true };
    });
  }, [workspace, ready, hasPinnedRoom]);
  const chooseFilter = useCallback(
    (next: RoomListFilter) => setSelection({ workspace, filter: next, chosen: true }),
    [workspace],
  );
  return [filter, chooseFilter] as const;
}
const writes = new Map<string, Promise<void>>();
const decodePins = (raw: string | null): string[] => {
  const value: unknown = raw ? JSON.parse(raw) : [];
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};
const listeners = new Map<string, Set<(ids: readonly string[]) => void>>();

export function filterConversations(
  chats: readonly ChatListItem[],
  query: string,
  filter: RoomListFilter,
  pinned: readonly string[],
): ChatListItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return chats.filter(
    (item) =>
      !item.closed &&
      (filter !== 'unread' || item.unread) &&
      (filter !== 'messages' || Boolean(item.directMessage)) &&
      (filter !== 'pinned' || pinned.includes(item.room.id)) &&
      (!needle ||
        `${roomRowName(item).name} ${item.latestMessage?.text ?? ''}`
          .toLocaleLowerCase()
          .includes(needle)),
  );
}

/** Device-local navigation preferences, scoped to the signed-in viewer and Workspace. */
export function useRoomPins(
  viewer: string | null | undefined,
  workspace: string | null | undefined,
) {
  const key = viewer && workspace ? `@beeline/room-pins/${viewer}/${workspace}` : null;
  const [state, setState] = useState<{
    key: string | null;
    ids: readonly string[];
    loaded: boolean;
  }>({
    key: null,
    ids: [],
    loaded: false,
  });
  const currentKey = useRef(key);
  currentKey.current = key;
  const [error, setError] = useState<string | null>(null);
  const ids = state.key === key ? state.ids : [];
  useEffect(() => {
    setError(null);
    if (!key) return;
    let changed = false;
    const receive = (next: readonly string[]) => {
      changed = true;
      setState({ key, ids: next, loaded: true });
    };
    const bucket = listeners.get(key) ?? new Set();
    bucket.add(receive);
    listeners.set(key, bucket);
    void AsyncStorage.getItem(key)
      .then((raw) => {
        if (changed) return;
        setState({ key, ids: decodePins(raw), loaded: true });
      })
      .catch(() => {
        if (!changed) setError('Could not load pinned conversations.');
      });
    return () => {
      changed = true;
      bucket.delete(receive);
      if (!bucket.size) listeners.delete(key);
    };
  }, [key]);
  const toggle = useCallback(
    async (id: string) => {
      if (!key) return;
      // Serialize read/modify/write across both mounted navigation surfaces.
      // Read storage first so a quick tap during hydration cannot erase older pins.
      const write = (writes.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const saved = decodePins(await AsyncStorage.getItem(key));
          const next = saved.includes(id) ? saved.filter((value) => value !== id) : [...saved, id];
          await AsyncStorage.setItem(key, JSON.stringify(next));
          listeners.get(key)?.forEach((receive) => receive(next));
        });
      writes.set(key, write);
      try {
        await write;
        if (currentKey.current === key) setError(null);
      } catch {
        if (currentKey.current === key) setError('Could not save pinned conversations. Try again.');
      } finally {
        if (writes.get(key) === write) writes.delete(key);
      }
    },
    [key],
  );
  return {
    pinned: ids,
    pinsLoaded: state.key === key && state.loaded,
    togglePin: toggle,
    pinError: error,
  };
}
