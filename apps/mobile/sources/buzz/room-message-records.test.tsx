import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  roomMessageRecord,
  useRoomMessageRecords,
  writeRoomMessage,
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

function View({
  roomId,
  groups,
  capture,
}: {
  roomId: string;
  groups: Groups;
  capture(groups: Groups): void;
}) {
  capture(useRoomMessageRecords(roomId, groups));
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
    act(() => writeRoomMessage('room-a', row('m1', 'after')));
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
    act(() => writeRoomMessage('room-c', row('m1', 'after')));
    history.update(rows);
    expect(history.texts()).toEqual(['after']);
    history.unmount();
  });

  it('an older version never replaces a newer one', () => {
    const transcript = mount('room-d', [row('m1', 'v2', 2)]);
    act(() => writeRoomMessage('room-d', row('m1', 'v1', 1)));
    expect(transcript.texts()).toEqual(['v2']);
    transcript.update([row('m1', 'v1 read', 1)]);
    expect(transcript.texts()).toEqual(['v2']);
    act(() => writeRoomMessage('room-d', row('m1', 'v3', 3)));
    expect(transcript.texts()).toEqual(['v3']);
    transcript.unmount();
  });

  it('holds only messages a mounted view holds', () => {
    const transcript = mount('room-e', [row('m1', 'one'), row('m2', 'two')]);
    act(() => writeRoomMessage('room-e', row('m9', 'not loaded')));
    expect(roomMessageRecord('room-e', 'm9')).toBeUndefined();
    transcript.update([row('m2', 'two')]);
    expect(roomMessageRecord('room-e', 'm1')).toBeUndefined();
    transcript.unmount();
    expect(roomMessageRecord('room-e', 'm2')).toBeUndefined();
  });

  // One view holding the same id in two windows (tail and history, or the
  // inspector's history, tail and tool rows) keeps a separate row object in
  // each. Re-rendering those unchanged copies must not undo a newer record.
  it('a view re-rendering overlapping old copies does not undo a live edit', () => {
    const tail = [row('m1', 'before'), row('m2', 'other')];
    const history = [row('m0', 'oldest'), row('m1', 'before')];
    const view = mountGroups('room-f', [tail, history]);
    act(() => writeRoomMessage('room-f', row('m1', 'after')));
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
    act(() => writeRoomMessage('room-g', { ...row('m1', ''), deleted: true }));
    view.updateGroups([history, tail, tools]);
    view.updateGroups([history, tail, tools]);
    expect(view.groupTexts()).toEqual([[''], [''], ['']]);
    expect(roomMessageRecord('room-g', 'm1')?.deleted).toBe(true);
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
});
