import { beforeEach, expect, it, vi } from 'vitest';
import { textDraftKey } from './text-draft-store';
import { removeRoomSearchDrafts } from './room-search-drafts';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...storage.keys()],
  multiRemove: async (keys: string[]) => { keys.forEach((key) => storage.delete(key)); },
} }));
beforeEach(() => storage.clear());

it('removes old phone and sidebar searches across identities, preserving other drafts', async () => {
  const obsolete = [textDraftKey('alice', 'room-search:workspace-a'),
    textDraftKey('bob', 'sidebar-room-search:workspace-b')];
  const retained = [textDraftKey('alice', 'new-room:workspace-a'),
    textDraftKey('bob', 'message:room-a'), textDraftKey('alice', 'room-search-settings:workspace-a'),
    'unrelated:room-search%3Aworkspace-a'];
  [...obsolete, ...retained].forEach((key) => storage.set(key, 'saved text'));
  await removeRoomSearchDrafts();
  expect([...storage.keys()]).toEqual(retained);
  await removeRoomSearchDrafts();
  expect([...storage.values()]).toEqual(retained.map(() => 'saved text'));
});
