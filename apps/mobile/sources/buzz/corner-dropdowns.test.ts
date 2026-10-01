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
  const waiting = room('a', [
    { id: 'c', name: 'c', state: 'waiting', mine: true, attention: true },
  ]);
  const theirs = room('a', [{ id: 'c', name: 'c', state: 'waiting' }]);
  const quiet = room('a', [{ id: 'c', name: 'c', state: 'idle', mine: true }]);
  const seen = room('a', [{ id: 'c', name: 'c', state: 'waiting', mine: true }]);

  it('opens when a corner starts waiting on the viewer and closes once none is', () => {
    const opened = step(new Set(), [idle], [waiting]);
    expect([...opened]).toEqual(['a']);
    expect([...step(new Set(opened), [waiting], [idle])]).toEqual([]);
  });

  it("ignores someone else's waiting corner", () => {
    expect([...step(new Set(), [idle], [theirs])]).toEqual([]);
  });

  it("stays closed for the viewer's idle corner", () => {
    expect([...step(new Set(), [idle], [quiet])]).toEqual([]);
  });

  it('stops pulling open once the viewer has seen the waiting corner', () => {
    expect([...step(new Set(), [idle], [seen])]).toEqual([]);
    expect([...step(new Set(), [waiting], [seen])]).toEqual([]);
  });

  it('keeps what the viewer toggled while waiting does not change', () => {
    expect([...step(new Set(), [waiting], [waiting])]).toEqual([]);
    expect([...step(new Set(['a']), [idle], [idle])]).toEqual(['a']);
  });
});
