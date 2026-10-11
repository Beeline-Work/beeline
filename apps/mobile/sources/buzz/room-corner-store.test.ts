import { beforeEach, describe, expect, it } from 'vitest';
import type { CornerListItem, CornerListView } from '@beeline/api-contract/phone';
import {
  acceptCornerStatusFrame,
  applyArchivedCorners,
  applyChatListCorners,
  applyCornerListRead,
  applyOpenCornerPage,
  cornerReadMark,
  getRoomCornerSummary,
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
    applyOpenCornerPage(ROOM, [row('a'), row('b'), row('c')], undefined, cornerReadMark(ROOM));
    expect(ids()).toEqual(['a', 'b', 'c']);
    acceptCornerStatusFrame(frame(1, [row('b'), row('a')], 'cursor-2'));
    expect(ids()).toEqual(['b', 'a', 'c']);
    expect(getRoomCorners(ROOM).openMoreStale).toBe(true);
    applyOpenCornerPage(ROOM, [row('c', 'review')], undefined, cornerReadMark(ROOM), true);
    expect(getRoomCorners(ROOM)).toMatchObject({ openMoreStale: false });
    expect(roomOpenCornerRows(getRoomCorners(ROOM)).at(-1)?.state).toBe('review');
  });

  it('marks loaded archived rows stale when a corner leaves the open list', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a'), row('b')]));
    // Nothing loaded the archived rows yet, so nothing is stale.
    acceptCornerStatusFrame(frame(2, [row('a'), row('b'), row('c')]));
    expect(getRoomCorners(ROOM).archivedStale).toBe(false);
    applyArchivedCorners(ROOM, [], undefined, false, cornerReadMark(ROOM));
    acceptCornerStatusFrame(frame(3, [row('a'), row('c')]));
    expect(getRoomCorners(ROOM).archivedStale).toBe(true);
    applyArchivedCorners(ROOM, [row('b', 'archived')], undefined, false, cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM)).toMatchObject({ archivedStale: false });
  });

  it('keeps an archived read stale when a corner closed while it ran', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a'), row('b')]));
    const started = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(2, [row('a')]));
    applyArchivedCorners(ROOM, [], undefined, false, started);
    expect(getRoomCorners(ROOM)).toMatchObject({ archived: { corners: [] }, archivedStale: true });
    applyArchivedCorners(ROOM, [row('b', 'archived')], undefined, false, cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM).archivedStale).toBe(false);
  });

  it('asks for a read when the server names a change without rows', () => {
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('a')]));
    noteRoomCornersChanged(ROOM);
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
    acceptCornerStatusFrame(frame(2));
    expect(getRoomCorners(ROOM)).toMatchObject({ current: false, wantsRead: true });
  });

  it('replaces the summary from whichever whole source started last', () => {
    const listItem = (id: string, cornerCount = 1) => [{ room: { id: ROOM }, cornerCount,
      openCorners: [{ id, name: id, state: 'working' as const }] }] as never;
    const started = cornerReadMark(ROOM).clock;
    noteCornerLaneSubscribed(ROOM, false);
    acceptCornerStatusFrame(frame(1, [row('framed')]));
    // A Room list read that started before the frame is older than it.
    applyChatListCorners(listItem('listed'), started);
    expect(getRoomCornerSummary(ROOM)?.openCorners.map((item) => item.id)).toEqual(['framed']);
    // One that started after it is newer, whatever the lane holds.
    applyChatListCorners(listItem('listed', 12), cornerReadMark(ROOM).clock);
    expect(getRoomCornerSummary(ROOM)).toEqual({ cornerCount: 12,
      openCorners: [{ id: 'listed', name: 'listed', state: 'working' }] });
  });

  it('Reproduction G3-R2: a first-page corners read replaces the summary every Room list surface reads', () => {
    applyChatListCorners([{ room: { id: ROOM } as never, cornerCount: 2,
      openCorners: [
        { id: 'corner-closed', name: 'corner-closed', state: 'waiting', mine: true, attention: true },
        { id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true },
      ] }], cornerReadMark(ROOM).clock);
    const summary = { cornerCount: 1, waitingCornerCount: 0, mineCornerCount: 1,
      openCorners: [{ id: 'corner-1', name: 'corner-1', state: 'idle' as const, mine: true as const }] };
    applyCornerListRead(ROOM, { ...view([mineRow('corner-1', 'idle')]), summary }, cornerReadMark(ROOM));
    expect(getRoomCornerSummary(ROOM)).toEqual({ cornerCount: 1, openCorners: summary.openCorners });
    // The summary is not part of the header the Corners page paints.
    expect(getRoomCorners(ROOM).header).not.toHaveProperty('summary');
  });

  it('keeps a summary newer than a corners read', () => {
    const mark = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(1, [row('corner-1', 'review')]));
    const summary = { cornerCount: 1, waitingCornerCount: 0, mineCornerCount: 1,
      openCorners: [{ id: 'corner-1', name: 'corner-1', state: 'idle' as const, mine: true as const }] };
    applyCornerListRead(ROOM, { ...view([row('corner-1', 'idle')]), summary }, mark);
    expect(getRoomCornerSummary(ROOM)?.openCorners[0]?.state).toBe('review');
  });

  it('E1: an older read that lands last never replaces a newer read with the same frames behind it', () => {
    const waiting = { cornerCount: 2, waitingCornerCount: 2, mineCornerCount: 2, openCorners: [
      { id: 'corner-1', name: 'corner-1', state: 'waiting' as const, mine: true as const, attention: true as const },
      { id: 'corner-2', name: 'corner-2', state: 'waiting' as const, mine: true as const },
    ] };
    const idle = { cornerCount: 1, waitingCornerCount: 0, mineCornerCount: 1, openCorners: [
      { id: 'corner-1', name: 'corner-1', state: 'idle' as const, mine: true as const },
    ] };
    // Two reads start with no frame between them; the newer lands first.
    const older = cornerReadMark(ROOM);
    const newer = cornerReadMark(ROOM);
    applyCornerListRead(ROOM, { ...view([mineRow('corner-1', 'idle')]), summary: idle }, newer);
    applyCornerListRead(ROOM, { ...view([mineRow('corner-1', 'waiting'),
      mineRow('corner-2', 'waiting')]), summary: waiting }, older);
    expect(getRoomCornerSummary(ROOM)).toEqual({ cornerCount: 1, openCorners: idle.openCorners });
    expect(ids()).toEqual(['corner-1']);
    expect(getRoomCorners(ROOM).rows?.[0]?.state).toBe('idle');
    expect(newer.clock).toBeGreaterThan(older.clock);
    // The same holds for a Room list read against a corners read.
    const listed = [{ room: { id: ROOM }, cornerCount: 2, openCorners: waiting.openCorners }] as never;
    const listStarted = cornerReadMark(ROOM).clock;
    applyCornerListRead(ROOM, { ...view([mineRow('corner-1', 'idle')]), summary: idle },
      cornerReadMark(ROOM));
    applyChatListCorners(listed, listStarted);
    expect(getRoomCornerSummary(ROOM)?.cornerCount).toBe(1);
  });

  it('E1: a partial read that matches the summary still blocks an older whole read', () => {
    const idle = { cornerCount: 1, openCorners: [
      { id: 'corner-1', name: 'corner-1', state: 'idle' as const, mine: true as const },
    ] };
    applyChatListCorners([{ room: { id: ROOM } as never, ...idle }], cornerReadMark(ROOM).clock);
    const older = cornerReadMark(ROOM);
    // A newer first page with no summary agrees with the held summary.
    applyCornerListRead(ROOM, view([mineRow('corner-1', 'idle')]), cornerReadMark(ROOM));
    applyCornerListRead(ROOM, { ...view([mineRow('corner-1', 'waiting'),
      mineRow('corner-2', 'waiting')]), summary: { cornerCount: 2, waitingCornerCount: 2,
      mineCornerCount: 2, openCorners: [
        { id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true, attention: true },
        { id: 'corner-2', name: 'corner-2', state: 'waiting', mine: true },
      ] } }, older);
    expect(getRoomCornerSummary(ROOM)).toEqual(idle);
    expect(getRoomCorners(ROOM).rows?.map((item) => item.state)).toEqual(['idle']);
  });

  it('PC1: a partial read patches the summary corners it names by id', () => {
    applyChatListCorners([{ room: { id: ROOM } as never, cornerCount: 3, openCorners: [
      { id: 'corner-1', name: 'corner-1', state: 'waiting', mine: true, waitingSince: 50, attention: true },
      { id: 'corner-2', name: 'corner-2', state: 'working' },
      { id: 'corner-3', name: 'corner-3', state: 'working' },
    ] }], cornerReadMark(ROOM).clock);
    // A first page with no summary (an older server, or a child Room) patches.
    applyCornerListRead(ROOM, view([mineRow('corner-1', 'idle')]), cornerReadMark(ROOM));
    expect(getRoomCornerSummary(ROOM)).toEqual({ cornerCount: 3, openCorners: [
      { id: 'corner-1', name: 'corner-1', state: 'idle', mine: true },
      { id: 'corner-2', name: 'corner-2', state: 'working' },
      { id: 'corner-3', name: 'corner-3', state: 'working' },
    ] });
    // A later open page patches the corners it names and leaves the rest.
    const page = { ...mineRow('corner-3', 'waiting'),
      latestMessage: { id: 'm', text: 'done', createdAt: 70, author: { pubkey: 'agent' } } } as CornerListItem;
    applyOpenCornerPage(ROOM, [page, row('corner-9', 'idle')], undefined, cornerReadMark(ROOM));
    expect(getRoomCornerSummary(ROOM)?.openCorners).toEqual([
      { id: 'corner-1', name: 'corner-1', state: 'idle', mine: true },
      { id: 'corner-2', name: 'corner-2', state: 'working' },
      { id: 'corner-3', name: 'corner-3', state: 'waiting', mine: true, waitingSince: 70 },
    ]);
    // A partial read started before the held summary's source patches nothing.
    const stale = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(1, [row('corner-2', 'review')]));
    applyOpenCornerPage(ROOM, [row('corner-2', 'idle')], undefined, stale);
    expect(getRoomCornerSummary(ROOM)?.openCorners[0]?.state).toBe('review');
  });

  it('fills an empty summary from a saved copy, and skips a row without corner facts', () => {
    applyChatListCorners([{ room: { id: ROOM } as never,
      openCorners: [{ id: 'unknown', name: 'unknown', state: 'working' }] }], cornerReadMark(ROOM).clock);
    expect(getRoomCornerSummary(ROOM)).toBeUndefined();
    applyChatListCorners([{ room: { id: ROOM } as never, cornerCount: 1,
      openCorners: [{ id: 'saved', name: 'saved', state: 'working' }] }], -1);
    expect(getRoomCornerSummary(ROOM)?.openCorners.map((item) => item.id)).toEqual(['saved']);
    // A Room whose last corner closed sends a zero count and no list.
    applyChatListCorners([{ room: { id: ROOM } as never, cornerCount: 0 }], cornerReadMark(ROOM).clock);
    expect(getRoomCornerSummary(ROOM)).toEqual({ cornerCount: 0, openCorners: [] });
    applyChatListCorners([{ room: { id: ROOM } as never, cornerCount: 1,
      openCorners: [{ id: 'saved', name: 'saved', state: 'working' }] }], -1);
    expect(getRoomCornerSummary(ROOM)?.cornerCount).toBe(0);
  });

  it('holds a saved header as unread until a corners read sets it (D3)', () => {
    hydrateRoomCorners(ROOM, view([row('old')]));
    expect(getRoomCorners(ROOM).headerRead).toBe(false);
    applyCornerListRead(ROOM, view([row('a')]), cornerReadMark(ROOM));
    expect(getRoomCorners(ROOM).headerRead).toBe(true);
  });

  it('3.3: keeps later open pages stale when a frame landed during their re-read', () => {
    noteCornerLaneSubscribed(ROOM, false);
    applyCornerListRead(ROOM, view([row('a')], 'cursor-1'), cornerReadMark(ROOM));
    applyOpenCornerPage(ROOM, [row('b')], undefined, cornerReadMark(ROOM));
    acceptCornerStatusFrame(frame(1, [row('a', 'review')], 'cursor-1'));
    expect(getRoomCorners(ROOM).openMoreStale).toBe(true);
    const mark = cornerReadMark(ROOM);
    acceptCornerStatusFrame(frame(2, [row('a', 'idle')], 'cursor-1'));
    applyOpenCornerPage(ROOM, [row('b', 'review')], undefined, mark, true);
    expect(getRoomCorners(ROOM).openMoreStale).toBe(true);
    applyOpenCornerPage(ROOM, [row('b', 'review')], undefined, cornerReadMark(ROOM), true);
    expect(getRoomCorners(ROOM).openMoreStale).toBe(false);
  });

  it('drops every read that started before a store reset', () => {
    noteCornerLaneSubscribed(ROOM, false);
    const mark = cornerReadMark(ROOM);
    resetRoomCornerStore();
    applyCornerListRead(ROOM, { ...view([row('old-account')]), summary: { cornerCount: 1,
      waitingCornerCount: 0, mineCornerCount: 0, openCorners: [] } }, mark);
    applyOpenCornerPage(ROOM, [row('old-page')], undefined, mark);
    applyArchivedCorners(ROOM, [row('old-closed', 'archived')], undefined, false, mark);
    expect(getRoomCorners(ROOM)).toMatchObject({ openMore: [], headerRead: false });
    expect(getRoomCorners(ROOM).rows).toBeUndefined();
    expect(getRoomCorners(ROOM).archived).toBeUndefined();
    expect(getRoomCornerSummary(ROOM)).toBeUndefined();
  });
});
