import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SurfaceRefreshScheduler } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';
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
  const hook = useRoomSendFrame(transcript, committedIds, false);
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
  it('paints a send without walking or sorting the loaded server transcript', () => {
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

  it('collapses a 1,000-signal relay burst into one scheduled refresh without event work', async () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new SurfaceRefreshScheduler({
      fetch: vi.fn(async () => 1),
      apply: vi.fn(),
      now: () => 0,
      setTimer: (callback) => {
        scheduled.push(callback);
        return scheduled.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
    });

    await scheduler.startAfter(Promise.resolve());
    for (let index = 0; index < 1_000; index += 1) scheduler.signal();

    // Signals carry no payload and do no parsing, reducing, cache writes, or
    // transcript iteration. The whole burst only preserves one dirty timer.
    expect(scheduled).toHaveLength(1);
  });
});
