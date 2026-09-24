import { describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));
import { filterConversations, roomListCounts } from './room-list-preferences';

const rooms = [
  { room: { id: 'unread', name: 'Product' }, unread: true },
  { room: { id: 'waiting', name: 'Build' }, unread: false, agentState: 'needs-you' },
  { room: { id: 'quiet', name: 'Archive' }, unread: false },
  {
    room: { id: 'dm', name: 'stored opaque name' },
    unread: true,
    directMessage: { peer: { name: 'Johnny', handle: 'johnny' } },
  },
  { room: { id: 'closed', name: 'Closed' }, unread: true, closed: true },
] as ChatListItem[];
const ids = (items: ChatListItem[]) => items.map((item) => item.room.id);
describe('conversation filters', () => {
  it('keeps corner attention separate from unread messages', () => {
    expect(ids(filterConversations(rooms, '', 'unread', []))).toEqual(['unread', 'dm']);
  });
  it('keeps quiet Rooms reachable and closed conversations hidden', () => {
    expect(ids(filterConversations(rooms, '', 'all', []))).toEqual([
      'unread',
      'waiting',
      'quiet',
      'dm',
    ]);
  });
  it('searches a DM by its displayed peer identity', () => {
    expect(ids(filterConversations(rooms, 'JOHNNY', 'all', []))).toEqual(['dm']);
  });
  it('intersects search with pins and supports a separate Messages view', () => {
    expect(ids(filterConversations(rooms, 'arch', 'pinned', ['quiet', 'dm']))).toEqual(['quiet']);
    expect(ids(filterConversations(rooms, '', 'messages', []))).toEqual(['dm']);
  });
  it('counts only visible conversations and pins that still belong to them', () => {
    const pins = ['closed', 'missing', 'quiet', 'dm'];
    expect(roomListCounts(rooms, pins)).toEqual({ all: 4, unread: 2, pinned: 2 });
    expect(ids(filterConversations(rooms, '', 'pinned', pins))).toEqual(['quiet', 'dm']);
    expect(roomListCounts(rooms, ['closed', 'missing'])).toEqual({
      all: 4,
      unread: 2,
      pinned: 0,
    });
    expect(filterConversations(rooms, '', 'pinned', ['closed', 'missing'])).toEqual([]);
  });
});
