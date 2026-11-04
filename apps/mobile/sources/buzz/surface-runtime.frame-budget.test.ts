import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildReplyCommand,
  createIdentity,
  type RoomView,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';
import { createRoomMessageProjector, reconcileRoomView } from './room-view-presentation';
import { useRoomMessageRecords } from './room-message-records';
import { useRoomSendFrame } from './room-send-frame';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
    getAllKeys() {
      return [];
    }
  },
}));

const originalConsoleError = console.error;
type RoomSendHook = ReturnType<typeof useRoomSendFrame>;

function RoomSendHarness({
  transcript,
  committedIds,
  capture,
}: {
  transcript: ChatDisplayMessage[];
  committedIds: ReadonlySet<string>;
  capture: (hook: RoomSendHook) => void;
}) {
  const hook = useRoomSendFrame(transcript, committedIds);
  capture(hook);
  return React.createElement(
    'room-send-overlay',
    null,
    hook.frame.optimistic.map((message) =>
      React.createElement('message-row', { key: message.id, messageId: message.id }, message.text),
    ),
  );
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) {
      return;
    }
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

describe('FRAME-BUDGET gate — server-indexed Room surfaces', () => {


  it('keeps an optimistic send in a constant-size partition until the screen merges it by time', () => {
    const durable = Array.from({ length: 1_000 }, (_, index) => ({
      id: `durable-${index}`,
      text: `Loaded Room message ${index}`,
      isUser: index % 2 === 0,
      timestamp: index,
    })) satisfies ChatDisplayMessage[];
    const guardedDurable = new Proxy(durable, {
      get(target, property, receiver) {
        if (property === Symbol.iterator || property === 'map' || property === 'sort') {
          throw new Error('Room send walked the server transcript');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const optimistic = {
      id: 'signed-event-id',
      text: 'Captain send',
      isUser: true,
      timestamp: 2_000,
    } satisfies ChatDisplayMessage;
    let hook!: RoomSendHook;
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomSendHarness, {
          transcript: guardedDurable,
          committedIds: new Set<string>(),
          capture: (next: RoomSendHook) => {
            hook = next;
          },
        }),
      );
    });
    act(() => hook.append([optimistic]));

    expect(hook.frame.transcript).toBe(guardedDurable);
    expect(hook.frame.optimistic.map((message) => message.id)).toEqual(['signed-event-id']);
    expect(renderer.root.findAllByType('message-row')).toHaveLength(1);

    act(() => {
      renderer.update(
        React.createElement(RoomSendHarness, {
          transcript: guardedDurable,
          committedIds: new Set(['signed-event-id']),
          capture: (next: RoomSendHook) => {
            hook = next;
          },
        }),
      );
    });
    expect(hook.frame.transcript).toBe(guardedDurable);
    expect(hook.frame.optimistic).toEqual([]);
    act(() => renderer.unmount());
  });

  it('uses the same append-only optimistic overlay for Rooms and corners', () => {
    const incoming = [
      { id: 'sent-first', text: 'First', isUser: true, timestamp: 20 },
      { id: 'sent-second', text: 'Second', isUser: true, timestamp: 10 },
    ] satisfies ChatDisplayMessage[];
    let hook!: RoomSendHook;
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        React.createElement(RoomSendHarness, {
          transcript: [],
          committedIds: new Set<string>(),
          capture: (next: RoomSendHook) => {
            hook = next;
          },
        }),
      );
    });
    act(() => hook.append(incoming));

    expect(hook.frame.optimistic.map((message) => message.id)).toEqual([
      'sent-first',
      'sent-second',
    ]);
    act(() => renderer.unmount());
  });


});
