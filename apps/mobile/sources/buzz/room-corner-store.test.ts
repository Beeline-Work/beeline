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

/** A row the server's Mine rule holds for. */
function mineRow(id: string, state = 'working'): CornerListItem {
  return { ...row(id, state), mine: true } as CornerListItem;
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
    applyArchivedCorners(ROOM, [], undefined, false, cornerStoreClock());
    acceptCornerStatusFrame(frame(3, [row('a'), row('c')]));
    expect(getRoomCorners(ROOM).archivedStale).toBe(true);
    applyArchivedCorners(ROOM, [row('b', 'archived')], undefined, false, cornerStoreClock());
    expect(getRoomCorners(ROOM)).toMatchObject({ archivedStale: false });
  });

  it('keeps an archived read stale when a corner closed while it ran', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a'), row('b')]));
    const started = cornerStoreClock();
    acceptCornerStatusFrame(frame(2, [row('a')]));
    applyArchivedCorners(ROOM, [], undefined, false, started);
    expect(getRoomCorners(ROOM)).toMatchObject({ archived: { corners: [] }, archivedStale: true });
    applyArchivedCorners(ROOM, [row('b', 'archived')], undefined, false, cornerStoreClock());
    expect(getRoomCorners(ROOM).archivedStale).toBe(false);
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
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['framed']);
  });

  it('never lets a Room list preview replace a full summary while the lane is held', () => {
    const preview = (id: string) => [{ room: { id: ROOM }, openCorners: [{ id, name: id,
      state: 'working' as const }], cornerCount: 12, waitingCornerCount: 3 }] as never;
    applyChatListCorners(preview('seed'), cornerStoreClock());
    expect(getRoomCorners(ROOM)).toMatchObject({ summary: 'preview', cornerCount: 12,
      waitingCornerCount: 3 });
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame({ ...frame(1, [row('framed')]), cornerCount: 9, waitingCornerCount: 2 });
    expect(getRoomCorners(ROOM)).toMatchObject({ summary: 'full', cornerCount: 9,
      waitingCornerCount: 2 });
    applyChatListCorners(preview('later'), cornerStoreClock());
    expect(getRoomCorners(ROOM)).toMatchObject({ summary: 'full', cornerCount: 9 });
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['framed']);
    // A resumed lane carried every change, so the full summary holds.
    noteCornerSocketDropped();
    noteCornerLaneSubscribed(ROOM, true);
    applyChatListCorners(preview('later'), cornerStoreClock());
    expect(getRoomCorners(ROOM).summary).toBe('full');
    // Once the lane is lost, the full summary is no longer tracked.
    noteCornerLaneReleased(ROOM);
    applyChatListCorners(preview('after-release'), cornerStoreClock());
    expect(getRoomCorners(ROOM)).toMatchObject({ summary: 'preview', cornerCount: 12 });
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['after-release']);
  });

  it('lets a preview replace a full summary from a lane that restarted', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('framed')]));
    noteCornerLaneSubscribed(ROOM, false);
    applyChatListCorners([{ room: { id: ROOM }, openCorners: [{ id: 'read', name: 'read',
      state: 'working' as const }], cornerCount: 1, waitingCornerCount: 0 }] as never,
      cornerStoreClock());
    expect(getRoomCorners(ROOM).summary).toBe('preview');
  });

  it('asks for a read when the server names a change without rows', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a')]));
    noteRoomCornersChanged(ROOM);
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
    acceptCornerStatusFrame(frame(2));
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
  });

  it('Reproduction G3-R2: a corners read brings the summary up to its rows, keeping counts', () => {
    const started = cornerStoreClock();
    applyChatListCorners([{
      room: { id: ROOM } as never,
      cornerCount: 9,
      waitingCornerCount: 1,
      openCorners: [
        { id: 'corner-1', name: 'old-name', state: 'waiting', mine: true, waitingSince: 5, attention: true },
        { id: 'corner-2', name: 'corner-2', state: 'working', mine: true },
      ],
    }], started);
    // A first page with more after it: corner-2 may be on a later page.
    applyCornerListRead(ROOM, view([mineRow('corner-1', 'idle')], 'cursor'), cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM)).toMatchObject({
      summary: 'preview',
      cornerCount: 9,
      waitingCornerCount: 1,
      openCorners: [
        { id: 'corner-1', name: 'corner-1', state: 'idle', mine: true },
        { id: 'corner-2', name: 'corner-2', state: 'working', mine: true },
      ],
    });
    expect(getRoomCorners(ROOM).openCorners?.[0]).not.toHaveProperty('attention');
    expect(getRoomCorners(ROOM).openCorners?.[0]).not.toHaveProperty('waitingSince');
    // A Room list read that started before the corners read does not undo it.
    applyChatListCorners([{
      room: { id: ROOM } as never,
      openCorners: [{ id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true }],
    }], started);
    expect(getRoomCorners(ROOM).openCorners?.[0]?.state).toBe('idle');
  });

  it('Reproduction G3-R2: a complete corners read drops a closed corner from the summary', () => {
    applyChatListCorners([{
      room: { id: ROOM } as never,
      cornerCount: 2,
      waitingCornerCount: 2,
      openCorners: [
        { id: 'corner-closed', name: 'corner-closed', state: 'waiting', mine: true },
        { id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true },
      ],
    }], cornerStoreClock());
    applyCornerListRead(ROOM, view([mineRow('corner-1', 'idle')]), cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM)).toMatchObject({
      summary: 'preview',
      cornerCount: 2,
      waitingCornerCount: 2,
    });
    expect(getRoomCorners(ROOM).openCorners).toEqual([
      { id: 'corner-1', name: 'corner-1', state: 'idle', mine: true },
    ]);
  });

  it('Reproduction G3-R2: a corners read adds a Mine corner the summary lacks, keeping counts', () => {
    applyChatListCorners([{
      room: { id: ROOM } as never,
      cornerCount: 1,
      waitingCornerCount: 1,
      openCorners: [{ id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true }],
    }], cornerStoreClock());
    applyCornerListRead(ROOM, view([mineRow('corner-new'), row('other'), mineRow('corner-1', 'waiting')]),
      cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM)).toMatchObject({ cornerCount: 1, waitingCornerCount: 1 });
    expect(getRoomCorners(ROOM).openCorners).toEqual([
      { id: 'corner-new', name: 'corner-new', state: 'working', mine: true },
      { id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true },
    ]);
    // A partial read adds its Mine rows too, and drops nothing it does not hold.
    applyCornerListRead(ROOM, view([mineRow('corner-later')], 'next'), cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id))
      .toEqual(['corner-later', 'corner-new', 'corner-1']);
  });

  it('Reproduction G3-R2: a corners read takes each summary row\'s server Mine flag', () => {
    applyChatListCorners([{
      room: { id: ROOM } as never,
      cornerCount: 2,
      openCorners: [
        { id: 'followed', name: 'followed', state: 'waiting' },
        { id: 'unfollowed', name: 'unfollowed', state: 'waiting', mine: true, waitingSince: 5 },
      ],
    }], cornerStoreClock());
    applyCornerListRead(ROOM, view([mineRow('followed', 'waiting'), row('unfollowed', 'waiting')]),
      cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM).cornerCount).toBe(2);
    expect(getRoomCorners(ROOM).openCorners).toEqual([
      { id: 'followed', name: 'followed', state: 'waiting', mine: true },
      { id: 'unfollowed', name: 'unfollowed', state: 'waiting' },
    ]);
  });

  it('adds no Mine row from a corners read older than the Room list summary', () => {
    const mark = cornerReadMark(ROOM);
    applyChatListCorners([{
      room: { id: ROOM } as never,
      openCorners: [{ id: 'corner-1', name: 'corner-1', state: 'working', mine: true }],
    }], cornerStoreClock());
    applyCornerListRead(ROOM, view([mineRow('closed-since'), mineRow('corner-1')]), mark);
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['corner-1']);
  });

  it('keeps a summary corner a Room list read named after the corners read started', () => {
    const mark = cornerReadMark(ROOM);
    applyChatListCorners([{
      room: { id: ROOM } as never,
      openCorners: [{ id: 'opened-later', name: 'opened-later', state: 'working', mine: true }],
    }], cornerStoreClock());
    applyCornerListRead(ROOM, view([row('corner-1', 'idle')]), mark);
    expect(getRoomCorners(ROOM).openCorners?.map((item) => item.id)).toEqual(['opened-later']);
  });

  it('keeps a frame summary newer than a corners read', () => {
    const mark = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(1, [row('corner-1', 'review')]));
    applyCornerListRead(ROOM, view([row('corner-1', 'idle')]), mark);
    expect(getRoomCorners(ROOM).openCorners?.[0]?.state).toBe('review');
  });
});
