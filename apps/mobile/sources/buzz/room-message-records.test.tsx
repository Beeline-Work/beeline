import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import { resetClientState } from '@/sync/client-reset';
import { recordPerson } from './identity-records';
import { currentSurfaceStamp, nextSurfaceStamp } from './surface-clock';
import {
  applyRoomBookmark,
  applyRoomMessage,
  applyRoomTailRead,
  holdRoomMessages,
  roomDeltaMessage,
  roomMessageRecord,
  roomReadStamp,
  roomRecordScope,
  stampRoomRead,
  useRoomMessages,
  useRoomTail,
  writeRoomMessages,
} from './room-message-records';

const originalConsoleError = console.error;
beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

const scope = roomRecordScope('https://relay.test/path', 'viewer');

const row = (id: string, text: string, version?: number, at = 1): RoomViewMessage =>
  ({
    id,
    text,
    createdAt: at,
    author: { pubkey: 'person-a', kind: 'human', name: 'Ada' },
    presentation: 'message',
    ...(version === undefined ? {} : { version }),
  }) as RoomViewMessage;

/** The `message-delta` frame exactly as the server sends it: the row's
 *  version on the frame, beside the message. */
const frame = (roomId: string, message: RoomViewMessage, version: number) => ({
  type: 'message-delta' as const,
  roomId,
  message,
  version,
});

/** What the live connection does with every `message-delta` it hears. */
const deliver = (delta: ReturnType<typeof frame>, into = scope) =>
  act(() => applyRoomMessage(into, delta.roomId, roomDeltaMessage(delta)));

/** Rows a Room read returned, marked as the read client marks them. */
const readRows = (stamp: number, ...rows: RoomViewMessage[]) =>
  stampRoomRead({ messages: rows }, stamp).messages;

/** One window: rows a read returned, held as ids and read back from the records. */
function Window({
  roomId,
  holder,
  rows,
  capture,
}: {
  roomId: string;
  holder: string;
  rows: readonly RoomViewMessage[];
  capture(rows: readonly RoomViewMessage[]): void;
}) {
  const ids = React.useMemo(() => rows.map((message) => message.id), [rows]);
  React.useLayoutEffect(() => {
    writeRoomMessages(scope, roomId, rows);
    holdRoomMessages(scope, roomId, holder, ids);
  }, [holder, ids, roomId, rows]);
  React.useEffect(() => () => holdRoomMessages(scope, roomId, holder, null), [holder, roomId]);
  capture(useRoomMessages(scope, roomId, ids));
  return null;
}

/** One tail: a full read's ids, which new messages also join. */
function Tail({
  roomId,
  holder,
  read,
  capture,
}: {
  roomId: string;
  holder: string;
  read: readonly RoomViewMessage[];
  capture(rows: readonly RoomViewMessage[]): void;
}) {
  React.useLayoutEffect(() => {
    applyRoomTailRead(scope, roomId, holder, { messages: read }, false);
  }, [holder, read, roomId]);
  React.useEffect(() => () => holdRoomMessages(scope, roomId, holder, null), [holder, roomId]);
  const tail = useRoomTail(scope, roomId, holder);
  capture(useRoomMessages(scope, roomId, tail?.ids ?? []));
  return null;
}

function mount(
  roomId: string,
  holder: string,
  rows: readonly RoomViewMessage[],
  kind: 'window' | 'tail' = 'window',
) {
  let current: readonly RoomViewMessage[] = [];
  let renderer!: { update(element: React.ReactElement): void; unmount(): void };
  const capture = (selected: readonly RoomViewMessage[]) => (current = selected);
  const element = (next: readonly RoomViewMessage[]) =>
    kind === 'tail'
      ? React.createElement(Tail, { roomId, holder, read: next, capture })
      : React.createElement(Window, { roomId, holder, rows: next, capture });
  act(() => {
    renderer = create(element(rows));
  });
  return {
    texts: () => current.map((message) => message.text),
    rows: () => current,
    update: (next: readonly RoomViewMessage[]) => act(() => renderer.update(element(next))),
    unmount: () => act(() => renderer.unmount()),
  };
}

describe('room message records', () => {
  it('shows a live change in every window that holds the message', () => {
    const transcript = mount('room-a', 'tail', [row('m1', 'before', 1), row('m2', 'other', 1)]);
    const inspector = mount('room-a', 'inspector', [row('m1', 'before', 1)]);
    deliver(frame('room-a', row('m1', 'after'), 2));
    expect(transcript.texts()).toEqual(['after', 'other']);
    expect(inspector.texts()).toEqual(['after']);
    transcript.unmount();
    inspector.unmount();
  });

  it('a fresh read in one window updates the other window', () => {
    const transcript = mount('room-b', 'tail', [row('m1', 'before', 1)]);
    const inspector = mount('room-b', 'inspector', [row('m1', 'before', 1)]);
    inspector.update([row('m1', 'reread', 2)]);
    expect(transcript.texts()).toEqual(['reread']);
    transcript.unmount();
    inspector.unmount();
  });

  it('takes the version from the frame the server sends', () => {
    const transcript = mount('room-d', 'tail', [row('m1', 'v2', 2)]);
    deliver(frame('room-d', row('m1', 'v1'), 1));
    expect(transcript.texts()).toEqual(['v2']);
    transcript.update([row('m1', 'v1 read', 1)]);
    expect(transcript.texts()).toEqual(['v2']);
    deliver(frame('room-d', row('m1', 'v3'), 3));
    expect(transcript.texts()).toEqual(['v3']);
    expect(roomMessageRecord(scope, 'room-d', 'm1')?.version).toBe(3);
    transcript.unmount();
  });

  it('a copy without a version never replaces one with a version', () => {
    const transcript = mount('room-i', 'tail', [row('m1', 'versioned', 4)]);
    transcript.update([row('m1', 'old disk copy')]);
    expect(transcript.texts()).toEqual(['versioned']);
    transcript.unmount();
  });

  // Reproduction J09 / new split 1: the inspector re-read the whole corner
  // while a delta landed, and its older response replaced the record in every
  // view.
  it('a stale full read started before a delta keeps the delta in every view', () => {
    const a = row('m1', 'A', 1);
    const transcript = mount('room-r', 'tail', [a], 'tail');
    const inspector = mount('room-r', 'inspector', [a], 'tail');
    // The inspector's read starts here and is answered with version 1 …
    const staleRead = [row('m1', 'A', 1)];
    // … while delta B edits the message.
    deliver(frame('room-r', row('m1', 'B'), 2));
    inspector.update(staleRead);
    expect(transcript.texts()).toEqual(['B']);
    expect(inspector.texts()).toEqual(['B']);
    transcript.unmount();
    inspector.unmount();
  });

  it('a new message joins every tail; an unheld edit is not kept', () => {
    const transcript = mount('room-n', 'tail', [row('m1', 'one', 1, 1)], 'tail');
    const inspector = mount('room-n', 'inspector', [row('m1', 'one', 1, 1)], 'tail');
    deliver(frame('room-n', row('m2', 'two', undefined, 2), 0));
    expect(transcript.texts()).toEqual(['one', 'two']);
    expect(inspector.texts()).toEqual(['one', 'two']);
    transcript.unmount();
    inspector.unmount();
    const history = mount('room-u', 'history', [row('m0', 'zero', 1, 0)]);
    deliver(frame('room-u', row('m9', 'not loaded', undefined, 0), 1));
    expect(history.texts()).toEqual(['zero']);
    expect(roomMessageRecord(scope, 'room-u', 'm9')).toBeUndefined();
    history.unmount();
  });

  it('a full read keeps a delta it had not caught yet', () => {
    const transcript = mount('room-k', 'tail', [row('m1', 'one', 1, 1)], 'tail');
    deliver(frame('room-k', row('m2', 'two', undefined, 2), 0));
    transcript.update([row('m1', 'one', 1, 1)]);
    expect(transcript.texts()).toEqual(['one', 'two']);
    transcript.unmount();
  });

  it('a row moving from one window to another keeps its record', () => {
    const tail = mount('room-m', 'tail', [row('m1', 'edited', 3), row('m2', 'two', 1)]);
    tail.update([row('m2', 'two', 1)]);
    const history = mount('room-m', 'history', [row('m1', 'stale page copy', 1)]);
    expect(history.texts()).toEqual(['edited']);
    history.unmount();
    tail.unmount();
  });

  it('keeps rows identical in content as the same objects', () => {
    const transcript = mount('room-s', 'tail', [row('m1', 'same', 1)]);
    const first = transcript.rows();
    transcript.update([row('m1', 'same', 1)]);
    expect(transcript.rows()).toBe(first);
    transcript.unmount();
  });

  // Review R1: the bookmark is viewer state no version covers, so a delayed
  // read with the same version undid a settled bookmark in every view.
  it('a read started before a bookmark settled keeps the bookmark in every view', () => {
    const transcript = mount('room-b1', 'tail', readRows(roomReadStamp(), row('m1', 'A', 1)), 'tail');
    const inspector = mount('room-b1', 'inspector', readRows(roomReadStamp(), row('m1', 'A', 1)), 'tail');
    const startedBeforeBookmark = roomReadStamp();
    act(() => applyRoomBookmark(scope, 'room-b1', 'm1', true));
    inspector.update(readRows(startedBeforeBookmark, row('m1', 'A', 1)));
    expect(transcript.rows()[0]?.bookmarked).toBe(true);
    expect(inspector.rows()[0]?.bookmarked).toBe(true);
    // A delta carries no viewer state: an edit keeps the bookmark.
    deliver(frame('room-b1', row('m1', 'B'), 2));
    expect(transcript.rows()[0]).toMatchObject({ text: 'B', bookmarked: true });
    // A read started after the bookmark settled is current, so its value wins.
    transcript.update(readRows(roomReadStamp(), row('m1', 'B', 2)));
    expect(transcript.rows()[0]?.bookmarked).toBeUndefined();
    expect(inspector.rows()[0]?.bookmarked).toBeUndefined();
    transcript.unmount();
    inspector.unmount();
  });

  // Review R2: a live row for one relay and viewer changed every scope that
  // held a Room with the same id.
  it('a live row changes only the relay and viewer it came from', () => {
    const other = roomRecordScope('https://other.test', 'viewer');
    const transcript = mount('room-x', 'tail', [row('m1', 'mine', 1)], 'tail');
    act(() => applyRoomTailRead(other, 'room-x', 'other-tail', { messages: [row('m1', 'theirs', 1)] }, false));
    deliver(frame('room-x', row('m1', 'edited for other'), 2), other);
    deliver(frame('room-x', row('m2', 'new for other', undefined, 2), 1), other);
    expect(transcript.texts()).toEqual(['mine']);
    expect(roomMessageRecord(other, 'room-x', 'm1')?.text).toBe('edited for other');
    act(() => holdRoomMessages(other, 'room-x', 'other-tail', null));
    transcript.unmount();
  });

  // Review R3: the inspector's read returned a new message before its delta
  // arrived, and the delta then never joined the transcript's tail.
  it('a new message the inspector already holds still joins the tail', () => {
    const transcript = mount('room-h', 'tail', [row('m1', 'one', 1, 1)], 'tail');
    const inspector = mount('room-h', 'inspector', [row('m1', 'one', 1, 1), row('m2', 'two', 1, 2)]);
    deliver(frame('room-h', row('m2', 'two', undefined, 2), 1));
    expect(transcript.texts()).toEqual(['one', 'two']);
    expect(inspector.texts()).toEqual(['one', 'two']);
    transcript.unmount();
    inspector.unmount();
  });

  // Review R4: a corner tail's read replaced its tool ids, so a tool row
  // that arrived as a delta after the read started was dropped.
  it('a stale read keeps a tool row it had not caught yet', () => {
    const tool = (id: string, at: number, version: number) =>
      ({
        ...row(id, '', version, at),
        presentation: 'activity',
        activity: [{ kind: 'tool', title: 'Read' }],
      }) as RoomViewMessage;
    const read = { messages: [row('m1', 'one', 1, 1)], toolRows: [tool('t1', 1, 1)] };
    act(() => {
      applyRoomTailRead(scope, 'room-t', 'corner', read, true);
    });
    deliver(frame('room-t', tool('t2', 3, 1), 1));
    let tail = applyRoomTailRead(scope, 'room-t', 'corner', read, true);
    expect(tail.toolIds).toEqual(['t1', 't2']);
    tail = applyRoomTailRead(scope, 'room-t', 'corner', read, true);
    expect(tail.toolIds).toEqual(['t1', 't2']);
    act(() => holdRoomMessages(scope, 'room-t', 'corner', null));
  });

  it('keys records by relay and viewer and clears them on a client reset', () => {
    const transcript = mount('room-z', 'tail', [row('m1', 'mine', 1)]);
    const other = roomRecordScope('https://other.test', 'viewer');
    expect(roomMessageRecord(other, 'room-z', 'm1')).toBeUndefined();
    act(() => resetClientState());
    expect(roomMessageRecord(scope, 'room-z', 'm1')).toBeUndefined();
    expect(transcript.texts()).toEqual([]);
    transcript.unmount();
  });

  it('a live rename reaches rows read before it, not rows read after it', () => {
    const before = currentSurfaceStamp();
    const early = stampRoomRead({ messages: [row('m1', 'early', 1)] }, roomReadStamp(), before).messages;
    const transcript = mount('room-rename', 'tail', early);
    act(() => recordPerson(scope, { pubkey: 'person-a', kind: 'human', name: 'Ada Renamed' }, nextSurfaceStamp()));
    expect(transcript.rows().map((message) => message.author.name)).toEqual(['Ada Renamed']);
    const after = currentSurfaceStamp();
    const served = { ...row('m2', 'late', 1, 2), author: { pubkey: 'person-a', kind: 'human', name: 'Ada Server' } } as RoomViewMessage;
    const late = stampRoomRead({ messages: [served] }, roomReadStamp(), after).messages;
    const second = mount('room-rename-later', 'tail', late);
    // A read started after the rename already carries the server's identity.
    expect(second.rows().map((message) => message.author.name)).toEqual(['Ada Server']);
    transcript.unmount();
    second.unmount();
  });
});
