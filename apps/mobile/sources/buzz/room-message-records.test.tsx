import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  offerRoomTurns,
  roomMessageRecord,
  roomTurns,
  stampRoomMessageRows,
  useRoomMessageRecords,
  writeRoomMessage,
  writeRoomBookmark,
  writeRoomTurn,
} from './room-message-records';
import { recordPerson } from './identity-records';
import { currentSurfaceStamp, nextSurfaceStamp } from './surface-clock';
import { resetClientState } from '@/sync/client-reset';

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

const row = (id: string, text: string, version?: number): RoomViewMessage =>
  ({
    id,
    text,
    createdAt: 1,
    author: { pubkey: 'person-a', kind: 'human', name: 'Ada' },
    presentation: 'message',
    ...(version === undefined ? {} : { version }),
  }) as RoomViewMessage;

type Groups = readonly (readonly RoomViewMessage[])[];
const SCOPE = 'test-scope';

function View({
  roomId,
  groups,
  capture,
}: {
  roomId: string;
  groups: Groups;
  capture(groups: Groups): void;
}) {
  capture(useRoomMessageRecords(SCOPE, roomId, groups));
  return null;
}

function mountGroups(roomId: string, groups: Groups) {
  let current: Groups = [];
  let renderer!: { update(element: React.ReactElement): void; unmount(): void };
  const capture = (selected: Groups) => (current = selected);
  act(() => {
    renderer = create(React.createElement(View, { roomId, groups, capture }));
  });
  return {
    groupTexts: () => current.map((rows) => rows.map((message) => message.text)),
    texts: () => (current[0] ?? []).map((message) => message.text),
    authors: () => (current[0] ?? []).map((message) => message.author.name),
    updateGroups: (next: Groups) =>
      act(() => renderer.update(React.createElement(View, { roomId, groups: next, capture }))),
    unmount: () => act(() => renderer.unmount()),
  };
}

function mount(roomId: string, rows: readonly RoomViewMessage[]) {
  const view = mountGroups(roomId, [rows]);
  return { ...view, update: (next: readonly RoomViewMessage[]) => view.updateGroups([next]) };
}

describe('room message records', () => {
  it('shows a live change in every view that holds the message', () => {
    const transcript = mount('room-a', [row('m1', 'before'), row('m2', 'other')]);
    const inspector = mount('room-a', [row('m1', 'before')]);
    act(() => writeRoomMessage(SCOPE, 'room-a', row('m1', 'after')));
    expect(transcript.texts()).toEqual(['after', 'other']);
    expect(inspector.texts()).toEqual(['after']);
    transcript.unmount();
    inspector.unmount();
  });

  it('a fresh read in one view updates the other view', () => {
    const transcript = mount('room-b', [row('m1', 'before')]);
    const inspector = mount('room-b', [row('m1', 'before')]);
    inspector.update([row('m1', 'reread')]);
    expect(transcript.texts()).toEqual(['reread']);
    transcript.unmount();
    inspector.unmount();
  });

  it('a view re-rendering its old copy does not undo a newer record', () => {
    const rows = [row('m1', 'before')];
    const history = mount('room-c', rows);
    act(() => writeRoomMessage(SCOPE, 'room-c', row('m1', 'after')));
    history.update(rows);
    expect(history.texts()).toEqual(['after']);
    history.unmount();
  });

  it('an older version never replaces a newer one', () => {
    const transcript = mount('room-d', [row('m1', 'v2', 2)]);
    act(() => writeRoomMessage(SCOPE, 'room-d', row('m1', 'v1', 1)));
    expect(transcript.texts()).toEqual(['v2']);
    transcript.update([row('m1', 'v1 read', 1)]);
    expect(transcript.texts()).toEqual(['v2']);
    act(() => writeRoomMessage(SCOPE, 'room-d', row('m1', 'v3', 3)));
    expect(transcript.texts()).toEqual(['v3']);
    transcript.unmount();
  });

  it('holds only messages a mounted view holds', () => {
    const transcript = mount('room-e', [row('m1', 'one'), row('m2', 'two')]);
    act(() => writeRoomMessage(SCOPE, 'room-e', row('m9', 'not loaded')));
    expect(roomMessageRecord(SCOPE, 'room-e', 'm9')).toBeUndefined();
    transcript.update([row('m2', 'two')]);
    expect(roomMessageRecord(SCOPE, 'room-e', 'm1')).toBeUndefined();
    transcript.unmount();
    expect(roomMessageRecord(SCOPE, 'room-e', 'm2')).toBeUndefined();
  });

  // One view holding the same id in two windows (tail and history, or the
  // inspector's history, tail and tool rows) keeps a separate row object in
  // each. Re-rendering those unchanged copies must not undo a newer record.
  it('a view re-rendering overlapping old copies does not undo a live edit', () => {
    const tail = [row('m1', 'before'), row('m2', 'other')];
    const history = [row('m0', 'oldest'), row('m1', 'before')];
    const view = mountGroups('room-f', [tail, history]);
    act(() => writeRoomMessage(SCOPE, 'room-f', row('m1', 'after')));
    expect(view.groupTexts()).toEqual([
      ['after', 'other'],
      ['oldest', 'after'],
    ]);
    view.updateGroups([tail, history]);
    expect(view.groupTexts()).toEqual([
      ['after', 'other'],
      ['oldest', 'after'],
    ]);
    view.unmount();
  });

  it('a view re-rendering overlapping old copies does not undo a deletion', () => {
    const tail = [row('m1', 'secret')];
    const history = [row('m1', 'secret')];
    const tools = [row('m1', 'secret')];
    const view = mountGroups('room-g', [history, tail, tools]);
    act(() => writeRoomMessage(SCOPE, 'room-g', { ...row('m1', ''), deleted: true }));
    view.updateGroups([history, tail, tools]);
    view.updateGroups([history, tail, tools]);
    expect(view.groupTexts()).toEqual([[''], [''], ['']]);
    expect(roomMessageRecord(SCOPE, 'room-g', 'm1')?.deleted).toBe(true);
    view.unmount();
  });

  it('a fresh copy in one overlapping window still replaces the record', () => {
    const tail = [row('m1', 'before')];
    const history = [row('m1', 'before')];
    const view = mountGroups('room-h', [tail, history]);
    view.updateGroups([[row('m1', 'reread')], history]);
    expect(view.groupTexts()).toEqual([['reread'], ['reread']]);
    view.unmount();
  });

  it('keeps a reported message reported through a shared delta and stale read', () => {
    const before = row('reported', 'before', 2);
    const view = mount('room-reports', [before]);
    act(() => writeRoomMessage(SCOPE, 'room-reports', { ...before, feedbackReported: true }));
    act(() => writeRoomMessage(SCOPE, 'room-reports', row('reported', 'edited', 3)));
    view.update([row('reported', 'stale read', 2)]);
    expect(roomMessageRecord(SCOPE, 'room-reports', 'reported')).toMatchObject({
      text: 'edited', feedbackReported: true,
    });
    view.unmount();
  });

  it('keeps a bookmark through a stale read and a shared edit', () => {
    const original = row('bookmark', 'before', 1);
    stampRoomMessageRows([original], currentSurfaceStamp());
    const view = mount('room-bookmark', [original]);
    act(() => writeRoomBookmark(SCOPE, 'room-bookmark', 'bookmark', true));
    const stale = row('bookmark', 'before', 1);
    stampRoomMessageRows([stale], currentSurfaceStamp() - 1);
    view.update([stale]);
    act(() => writeRoomMessage(SCOPE, 'room-bookmark', row('bookmark', 'edited', 2)));
    expect(roomMessageRecord(SCOPE, 'room-bookmark', 'bookmark')).toMatchObject({
      text: 'edited', bookmarked: true,
    });
    const fresh = row('bookmark', 'edited', 2);
    stampRoomMessageRows([fresh], currentSurfaceStamp());
    view.update([fresh]);
    expect(roomMessageRecord(SCOPE, 'room-bookmark', 'bookmark')?.bookmarked).toBeUndefined();
    view.unmount();
  });

  it('separates the same Room id across viewer scopes', () => {
    const first = mount('room-shared-id', [row('m1', 'first')]);
    const otherRows = [row('m1', 'other')];
    let other: readonly RoomViewMessage[] = [];
    let renderer!: ReturnType<typeof create>;
    function OtherView() {
      [other] = useRoomMessageRecords('other-viewer', 'room-shared-id', [otherRows]);
      return null;
    }
    act(() => { renderer = create(<OtherView />); });
    act(() => writeRoomMessage(SCOPE, 'room-shared-id', row('m1', 'changed')));
    expect(first.texts()).toEqual(['changed']);
    expect(other[0]?.text).toBe('other');
    first.unmount();
    act(() => renderer.unmount());
  });

  it('clears a mounted viewer on client reset until fresh rows arrive', () => {
    const view = mount('room-reset', [row('m1', 'old account')]);
    act(() => resetClientState());
    expect(view.texts()).toEqual([]);
    expect(roomMessageRecord(SCOPE, 'room-reset', 'm1')).toBeUndefined();
    view.update([row('m2', 'new account')]);
    expect(view.texts()).toEqual(['new account']);
    view.unmount();
  });

  it('folds turn reads and deltas once by the surface clock', () => {
    const working = { agentPubkey: 'agent', requestId: 'request', status: 'working' as const, createdAt: 10 };
    const complete = { ...working, status: 'complete' as const };
    const readStart = currentSurfaceStamp();
    offerRoomTurns(SCOPE, 'room-turns', [working], readStart);
    writeRoomTurn(SCOPE, 'room-turns', complete);
    offerRoomTurns(SCOPE, 'room-turns', [working], readStart);
    expect(roomTurns(SCOPE, 'room-turns')).toEqual([complete]);
    const nextStart = currentSurfaceStamp();
    const retry = { ...working, requestId: 'retry' };
    offerRoomTurns(SCOPE, 'room-turns', [retry], nextStart);
    expect(roomTurns(SCOPE, 'room-turns')).toEqual([retry]);
    offerRoomTurns(SCOPE, 'room-turns', [], currentSurfaceStamp());
    expect(roomTurns(SCOPE, 'room-turns')).toEqual([]);
  });

  it('selects live identity over a history reply read before the rename', () => {
    const old = row('history-identity', 'reply');
    const readStamp = currentSurfaceStamp();
    stampRoomMessageRows([old], readStamp);
    recordPerson(SCOPE, { ...old.author, name: 'Renamed' }, nextSurfaceStamp());
    const view = mount('room-identity-history', [old]);
    expect(view.authors()).toEqual(['Renamed']);
    view.unmount();
  });
});
