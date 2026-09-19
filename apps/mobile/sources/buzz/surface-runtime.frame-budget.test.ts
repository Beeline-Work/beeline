import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SurfaceRefreshScheduler,
  buildReplyCommand,
  createIdentity,
  type RoomView,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';
import { createRoomMessageProjector, reconcileRoomView } from './room-view-presentation';
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
  it('keeps untouched rows and their reply proof stable through a live refetch', async () => {
    vi.useFakeTimers();
    const rootId = '1'.repeat(64);
    const parentId = '2'.repeat(64);
    const firstMessage: RoomViewMessage = {
      id: parentId,
      text: 'Agent reply',
      createdAt: 2,
      author: { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Codex' },
      presentation: 'message',
      reply: { channelId: 'room', eventId: rootId, rootId },
      reference: { channelId: 'room', eventId: parentId, rootId },
    };
    const view = (messages: readonly RoomViewMessage[]): RoomView => ({
      room: {
        id: 'room',
        workspaceId: 'workspace',
        name: 'Room',
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      },
      messages,
      members: [],
      viewer: {
        identity: { pubkey: 'b'.repeat(64), kind: 'human', name: 'Captain' },
        role: 'owner',
        permissions: { send: true, manage: true },
      },
      corners: [],
      watchFilters: [{ kinds: [9], '#h': ['room'] }],
    });
    const first = view([firstMessage]);
    const second = view([
      {
        ...firstMessage,
        id: '3'.repeat(64),
        text: 'Live arrival',
        createdAt: 3,
        reference: {
          channelId: 'room',
          eventId: '3'.repeat(64),
          rootId: '3'.repeat(64),
        },
        reply: undefined,
      },
      structuredClone(firstMessage),
    ]);
    const fetch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const projector = createRoomMessageProjector();
    const frames: ChatDisplayMessage[][] = [];
    let current: RoomView | null = null;
    const scheduler = new SurfaceRefreshScheduler({
      fetch,
      apply: (fresh) => {
        current = reconcileRoomView(current, fresh);
        frames.push(projector.project(current.messages, current.viewer.identity.pubkey));
      },
    });

    await scheduler.startAfter(Promise.resolve());
    await vi.runOnlyPendingTimersAsync();
    const heldProof = frames[0]![0]!.reference;
    scheduler.signal();
    await vi.advanceTimersByTimeAsync(500);

    expect(frames).toHaveLength(2);
    const refetchedParent = frames[1]!.find((message) => message.id === parentId);
    expect(refetchedParent).toBe(frames[0]![0]);
    expect(refetchedParent!.reference).toBe(heldProof);
    expect(
      buildReplyCommand(createIdentity('refetch-reply'), 'Nested reply', heldProof!).tags,
    ).toEqual([
      ['h', 'room'],
      ['e', rootId, '', 'root'],
      ['e', parentId, '', 'reply'],
    ]);

    const changed = reconcileRoomView(
      current,
      view([{ ...structuredClone(firstMessage), text: 'Agent reply edited' }]),
    );
    const changedProjection = projector.project(
      changed.messages,
      changed.viewer.identity.pubkey,
    )[0]!;
    expect(changedProjection).not.toBe(refetchedParent);
    expect(changedProjection.text).toBe('Agent reply edited');

    const otherViewerProjection = projector.project(changed.messages, 'c'.repeat(64))[0]!;
    expect(otherViewerProjection).not.toBe(changedProjection);
    projector.reset();
    expect(projector.project(changed.messages, 'c'.repeat(64))[0]).not.toBe(otherViewerProjection);
  });

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
