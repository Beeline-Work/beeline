import { beforeEach, describe, expect, it } from 'vitest';
import type { CornerListItem, CornerListView } from '@beeline/api-contract/phone';
import {
  acceptCornerStatusFrame,
  applyArchivedCorners,
  applyChatListCorners,
  applyCornerListRead,
  applyOpenCornerPage,
  cornerReadMark,
  cornerStoreClock,
  getRoomCorners,
  hydrateRoomCorners,
  noteCornerLaneReleased,
  noteCornerLaneSubscribed,
  noteCornerSocketDropped,
  noteRoomCornersChanged,
  resetRoomCornerStore,
  roomCornerListView,
  roomOpenCornerRows,
} from './room-corner-store';

const ROOM = 'room-a';

function row(id: string, state = 'working'): CornerListItem {
  return {
    corner: { id, name: id },
    lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
    state,
  } as unknown as CornerListItem;
}

function view(rows: readonly CornerListItem[], nextOpen?: string): CornerListView {
  return {
    room: { id: ROOM, name: 'general' },
    corners: rows,
    viewer: { identity: { pubkey: 'viewer' } },
    watchFilters: [],
    ...(nextOpen ? { nextOpen } : {}),
  } as unknown as CornerListView;
}

function frame(sequence: number | undefined, rows?: readonly CornerListItem[], nextOpen?: string) {
  return {
    roomId: ROOM,
    ...(sequence !== undefined ? { sequence } : {}),
    cornerCount: rows?.length ?? 0,
    waitingCornerCount: 0,
    openCorners: (rows ?? []).map((item) => ({ id: item.corner.id, name: item.corner.name,
      state: item.state as 'working', mine: true as const })),
    ...(rows ? { corners: rows } : {}),
    ...(nextOpen ? { nextOpen } : {}),
  };
}

const ids = () => roomOpenCornerRows(getRoomCorners(ROOM)).map((item) => item.corner.id);

beforeEach(() => resetRoomCornerStore());

describe('room corner store', () => {
  it('keeps frame rows current only while the lane holds them', () => {
    noteCornerLaneSubscribed(ROOM, false);
    expect(acceptCornerStatusFrame(frame(1, [row('a')]))).toBe(true);
    expect(getRoomCorners(ROOM).current).toBe(true);
    // A resumed lane on a new socket carried every change.
    noteCornerSocketDropped();
    noteCornerLaneSubscribed(ROOM, true);
    expect(getRoomCorners(ROOM).current).toBe(true);
    // A fresh lane did not.
    noteCornerLaneSubscribed(ROOM, false);
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
    acceptCornerStatusFrame(frame(1, [row('a')]));
    noteCornerLaneReleased(ROOM);
    expect(getRoomCorners(ROOM).current).toBe(false);
  });

  it('drops a frame whose sequence the lane already applied, until a fresh lane restarts it', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(5, [row('a', 'review')]));
    expect(acceptCornerStatusFrame(frame(4, [row('a', 'working')]))).toBe(false);
    expect(acceptCornerStatusFrame(frame(5, [row('a', 'working')]))).toBe(false);
    expect(getRoomCorners(ROOM).rows?.[0]?.state).toBe('review');
    noteCornerLaneSubscribed(ROOM, false);
    expect(acceptCornerStatusFrame(frame(1, [row('a', 'working')]))).toBe(true);
    expect(getRoomCorners(ROOM).rows?.[0]?.state).toBe('working');
  });

  it('keeps a frame that landed during a read and takes only the header from the read', () => {
    noteCornerLaneSubscribed(ROOM, false);
    const mark = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(1, [row('new'), row('a')]));
    applyCornerListRead(ROOM, view([row('a')]), mark);
    expect(ids()).toEqual(['new', 'a']);
    expect(roomCornerListView(getRoomCorners(ROOM))?.room.name).toBe('general');
    expect(getRoomCorners(ROOM).current).toBe(true);
  });

  it('applies a read with no frame since it started, current only when the lane held across it', () => {
    noteCornerLaneSubscribed(ROOM, false);
    applyCornerListRead(ROOM, view([row('a')]), cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM).current).toBe(true);
    const mark = cornerReadMark(ROOM);
    noteCornerLaneReleased(ROOM);
    applyCornerListRead(ROOM, view([row('b')]), mark);
    expect(ids()).toEqual(['b']);
    expect(getRoomCorners(ROOM).current).toBe(false);
  });

  it('never trusts a saved copy, and a frame replaces its rows', () => {
    hydrateRoomCorners(ROOM, view([row('old')]));
    expect(getRoomCorners(ROOM).current).toBe(false);
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('new')]));
    expect(ids()).toEqual(['new']);
    expect(getRoomCorners(ROOM)).toMatchObject({ current: true, wantsRead: false });
    // The header still paints from the saved copy.
    expect(roomCornerListView(getRoomCorners(ROOM))?.room.name).toBe('general');
  });

  it('merges later open pages without repeating a row, and marks them for a re-read on a frame', () => {
    noteCornerLaneSubscribed(ROOM, false);
    applyCornerListRead(ROOM, view([row('a')], 'cursor-1'), cornerReadMark(ROOM));
    applyOpenCornerPage(ROOM, [row('a'), row('b'), row('c')], undefined);
    expect(ids()).toEqual(['a', 'b', 'c']);
    acceptCornerStatusFrame(frame(1, [row('b'), row('a')], 'cursor-2'));
    expect(ids()).toEqual(['b', 'a', 'c']);
    expect(getRoomCorners(ROOM).openMoreStale).toBe(true);
    applyOpenCornerPage(ROOM, [row('c', 'review')], undefined, true);
    expect(getRoomCorners(ROOM)).toMatchObject({ openMoreStale: false });
    expect(roomOpenCornerRows(getRoomCorners(ROOM)).at(-1)?.state).toBe('review');
  });

  it('marks loaded archived rows stale when a corner leaves the open list', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a'), row('b')]));
    // Nothing loaded the archived rows yet, so nothing is stale.
    acceptCornerStatusFrame(frame(2, [row('a'), row('b'), row('c')]));
    expect(getRoomCorners(ROOM).archivedStale).toBe(false);
    applyArchivedCorners(ROOM, [], undefined, false);
    acceptCornerStatusFrame(frame(3, [row('a'), row('c')]));
    expect(getRoomCorners(ROOM).archivedStale).toBe(true);
    applyArchivedCorners(ROOM, [row('b', 'archived')], undefined, false);
    expect(getRoomCorners(ROOM)).toMatchObject({ archivedStale: false });
  });

  it('applies a Room list summary only where no frame came since the read started', () => {
    noteCornerLaneSubscribed(ROOM, false);
    const started = cornerStoreClock();
    acceptCornerStatusFrame(frame(1, [row('framed')]));
    const summary = (id: string) => [{ room: { id: ROOM }, openCorners: [{ id, name: id,
      state: 'working' as const }], cornerCount: 1, waitingCornerCount: 0 }] as never;
    applyChatListCorners(summary('read'), started);
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['framed']);
    applyChatListCorners(summary('read'), cornerStoreClock());
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['read']);
  });

  it('asks for a read when the server names a change without rows', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a')]));
    noteRoomCornersChanged(ROOM);
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
    acceptCornerStatusFrame(frame(2));
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
  });
});
