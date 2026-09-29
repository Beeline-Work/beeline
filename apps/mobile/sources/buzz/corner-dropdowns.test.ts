import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '@beeline/buzz-client';
import { mineWaitingRooms, nextExpandedRooms } from './corner-dropdowns';

const room = (id: string, corners: ChatListItem['openCorners'] = []): ChatListItem =>
  ({
    room: { id, name: id, workspaceId: 'w' },
    unread: false,
    openCorners: corners,
  }) as ChatListItem;
const step = (expanded: Set<string>, before: ChatListItem[], after: ChatListItem[]) =>
  nextExpandedRooms(expanded, mineWaitingRooms(before), mineWaitingRooms(after), after);

describe('corner dropdowns', () => {
  const idle = room('a', [{ id: 'c', name: 'c', state: 'working', mine: true }]);
  const waiting = room('a', [{ id: 'c', name: 'c', state: 'waiting', mine: true }]);
  const theirs = room('a', [{ id: 'c', name: 'c', state: 'waiting' }]);

  it("opens when one of the viewer's corners starts waiting and closes once none is", () => {
    const opened = step(new Set(), [idle], [waiting]);
    expect([...opened]).toEqual(['a']);
    expect([...step(new Set(opened), [waiting], [idle])]).toEqual([]);
  });

  it("ignores someone else's waiting corner", () => {
    expect([...step(new Set(), [idle], [theirs])]).toEqual([]);
  });

  it('keeps what the viewer toggled while waiting does not change', () => {
    expect([...step(new Set(), [waiting], [waiting])]).toEqual([]);
    expect([...step(new Set(['a']), [idle], [idle])]).toEqual(['a']);
  });
});
