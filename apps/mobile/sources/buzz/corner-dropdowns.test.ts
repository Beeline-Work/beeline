import { describe, expect, it } from 'vitest';
import type { ChatListCorner } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { mineWaitingRooms, nextExpandedRooms } from './corner-dropdowns';
import type { RoomCornerSummary } from './room-corner-store';

/** A Room row and the corner store's summary for it. */
type Room = { readonly item: ChatListItem; readonly summary: RoomCornerSummary };

const room = (id: string, corners: readonly ChatListCorner[] = []): Room => ({
  item: { room: { id, name: id, workspaceId: 'w' }, unread: false } as ChatListItem,
  summary: { cornerCount: corners.length, openCorners: corners },
});
const waitingRooms = (rooms: Room[]) => mineWaitingRooms(
  rooms.map((entry) => entry.item),
  new Map(rooms.map((entry) => [entry.item.room.id, entry.summary])),
);
const step = (expanded: Set<string>, before: Room[], after: Room[]) =>
  nextExpandedRooms(expanded, waitingRooms(before), waitingRooms(after),
    after.map((entry) => entry.item));

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
