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

function View({
  roomId,
  rows,
  capture,
}: {
  roomId: string;
  rows: readonly RoomViewMessage[];
  capture(rows: readonly RoomViewMessage[]): void;
}) {
  const [selected] = useRoomMessageRecords(roomId, [rows]);
  capture(selected);
  return null;
}

function mount(roomId: string, rows: readonly RoomViewMessage[]) {
  let current: readonly RoomViewMessage[] = [];
  let renderer!: { update(element: React.ReactElement): void; unmount(): void };
  const capture = (selected: readonly RoomViewMessage[]) => (current = selected);
  act(() => {
    renderer = create(React.createElement(View, { roomId, rows, capture }));
  });
  return {
    texts: () => current.map((message) => message.text),
    update: (next: readonly RoomViewMessage[]) =>
      act(() => renderer.update(React.createElement(View, { roomId, rows: next, capture }))),
    unmount: () => act(() => renderer.unmount()),
  };
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
});
