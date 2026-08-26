import { readFileSync } from 'node:fs';
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
  },
}));

import { createWorkspaceSnapshot, selectTranscript, type HumanMessage } from '@beeline/buzz-client';
import { channelCacheKey, clearBuzzLocalCache, useBuzzLocalCache } from './local-cache';
import {
  cacheLiveSessionEvents,
  drainLiveEventFrame,
  LIVE_EVENT_CHUNK_SIZE,
  LIVE_EVENT_FRAME_MAX_EVENTS,
} from './local-cache-sync';
import { useRoomSendFrame } from './room-send-frame';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';

const VIEWER = 'frame-viewer';
const ROOM = 'charles-scale-room';
const chatSource = readFileSync(
  new URL('../app/(app)/buzz/chat/[channelId].tsx', import.meta.url),
  'utf8',
);
const originalConsoleError = console.error;

type RoomSendHook = ReturnType<typeof useRoomSendFrame>;

function RoomSendHarness({
  transcript,
  committedIds,
  isCorner = false,
  capture,
}: {
  transcript: ChatDisplayMessage[];
  committedIds: ReadonlySet<string>;
  isCorner?: boolean;
  capture: (hook: RoomSendHook) => void;
}) {
  const hook = useRoomSendFrame(transcript, committedIds, isCorner);
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

function humanMessage(index: number): HumanMessage {
  return {
    type: 'human-message',
    eventId: `burst-${index}`,
    channelId: ROOM,
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: VIEWER,
    createdAt: index + 1,
    sourceKind: 9,
    signature: 'verified',
    body: `Captured message ${index}`,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage;
}

beforeEach(() => {
  clearBuzzLocalCache();
  useBuzzLocalCache
    .getState()
    .replaceSnapshot(
      VIEWER,
      ROOM,
      createWorkspaceSnapshot({ workspaceId: 'workspace' }),
      undefined,
    );
});

describe('FRAME-BUDGET gate', () => {
  it('paints a populated Room send without walking the durable transcript', () => {
    // Closest faithful non-device interaction: drive the production hook used
    // by handleSend through a real React state update with the same 1,000-row
    // populated transcript and optimistic row. The harness renders the same
    // optimistic collection consumed by the production FlatList header. A
    // Proxy makes a regression that iterates/sorts durable history fail inside
    // act(), while the wall-clock budget covers append, React state projection,
    // and optimistic-row render.
    const durable = Array.from({ length: 1_000 }, (_, index) => ({
      id: `durable-${index}`,
      text: `Loaded Room message ${index}`,
      isUser: index % 2 === 0,
      timestamp: index,
    })) as ChatDisplayMessage[];
    const guardedDurable = new Proxy(durable, {
      get(target, property, receiver) {
        if (property === Symbol.iterator || property === 'map' || property === 'sort') {
          throw new Error('Room send walked the durable transcript');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    let optimisticIdReads = 0;
    const optimistic = new Proxy(
      {
        id: 'optimistic-room-send',
        text: 'Captain send',
        isUser: true,
        timestamp: 2_000,
      } as ChatDisplayMessage,
      {
        get(target, property, receiver) {
          if (property === 'id') optimisticIdReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const secondOptimistic = {
      id: 'optimistic-room-send-2',
      text: 'Captain send',
      isUser: true,
      timestamp: 2_001,
    } as ChatDisplayMessage;
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
    const startedAt = performance.now();
    act(() => hook.append([optimistic, secondOptimistic]));
    const diagnosticElapsedMs = performance.now() - startedAt;
    const modeledBlockingMs = optimisticIdReads * 0.25;

    expect(hook.frame.transcript).toBe(guardedDurable);
    expect(hook.frame.optimistic.map((message) => message.id)).toEqual([
      'optimistic-room-send',
      'optimistic-room-send-2',
    ]);
    expect(modeledBlockingMs).toBeLessThan(5);
    expect(diagnosticElapsedMs).toBeLessThan(5);
    expect(renderer.root.findAllByType('message-row').map((row) => row.props.messageId)).toEqual([
      'optimistic-room-send',
      'optimistic-room-send-2',
    ]);

    // Publish reconciliation rekeys the temporary row. Once the signed live
    // event joins the durable pump, the committed-id filter removes the overlay
    // so Room history never renders two copies.
    act(() => hook.reconcile('optimistic-room-send', 'signed-room-send'));
    act(() => {
      renderer.update(
        React.createElement(RoomSendHarness, {
          transcript: guardedDurable,
          committedIds: new Set(['signed-room-send']),
          capture: (next: RoomSendHook) => {
            hook = next;
          },
        }),
      );
    });
    expect(hook.frame.transcript).toBe(guardedDurable);
    expect(hook.frame.optimistic.map((message) => message.id)).toEqual(['optimistic-room-send-2']);
    act(() => renderer.unmount());

    expect(chatSource).toContain(
      'useRoomSendFrame(durableMessages, committedMessageIds, isCorner)',
    );
    expect(chatSource).toContain('roomOptimisticHeader ??');
    expect(chatSource).not.toContain('roomSendFrame.optimistic].reverse()');
    expect(chatSource).toContain('invertedMessages.length > 0 || hasVisibleRoomOptimistic');
    const sendStart = chatSource.indexOf('const handleSend = useCallback');
    const sendEnd = chatSource.indexOf('const pickPhoto', sendStart);
    const send = chatSource.slice(sendStart, sendEnd);
    const appendIndex = send.indexOf('addMessages([');
    const frameYieldIndex = send.indexOf('requestAnimationFrame(() => resolve())');
    expect(appendIndex).toBeGreaterThanOrEqual(0);
    expect(frameYieldIndex).toBeGreaterThan(appendIndex);
    expect(send.slice(appendIndex, frameYieldIndex)).not.toMatch(
      /mergeDisplayPages|cachedMessages|olderMessages|roomSendFrame/,
    );
  });

  it('preserves the proven Corner optimistic merge ordering', () => {
    let hook!: RoomSendHook;
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        React.createElement(RoomSendHarness, {
          transcript: [],
          committedIds: new Set<string>(),
          isCorner: true,
          capture: (next: RoomSendHook) => {
            hook = next;
          },
        }),
      );
    });
    act(() =>
      hook.append([
        { id: 'newer', text: 'newer', isUser: true, timestamp: 2 },
        { id: 'older', text: 'older', isUser: true, timestamp: 1 },
      ]),
    );
    expect(hook.frame.optimistic.map((message) => message.id)).toEqual(['older', 'newer']);
    act(() => renderer.unmount());
  });

  it('time-slices a charles-scale burst through the real live cache path', () => {
    const queue = Array.from({ length: 1_000 }, (_, index) => ({
      type: 'read-model' as const,
      sessionId: ROOM,
      event: humanMessage(index),
    }));
    let clock = 0;
    const now = () => clock;
    const writes = vi.spyOn(useBuzzLocalCache.getState(), 'replaceSnapshot');
    const firstFrame = drainLiveEventFrame(
      queue,
      (batch) => {
        cacheLiveSessionEvents(VIEWER, ROOM, batch);
        clock += 2;
      },
      { now, budgetMs: 5 },
    );

    expect(firstFrame.processed).toBeLessThanOrEqual(LIVE_EVENT_FRAME_MAX_EVENTS);
    expect(firstFrame.processed).toBeGreaterThanOrEqual(LIVE_EVENT_CHUNK_SIZE);
    expect(firstFrame.remaining).toBeGreaterThan(0);
    expect(writes).toHaveBeenCalledTimes(Math.ceil(firstFrame.processed / LIVE_EVENT_CHUNK_SIZE));

    let frames = 1;
    while (queue.length > 0) {
      clock = 0;
      drainLiveEventFrame(
        queue,
        (batch) => {
          cacheLiveSessionEvents(VIEWER, ROOM, batch);
          clock += 2;
        },
        { now, budgetMs: 5 },
      );
      frames += 1;
    }
    expect(frames).toBeGreaterThan(1);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM)).toHaveLength(1_000);
  });

  it('keeps corner-state churn inside the same budget as message traffic', () => {
    // A working corner republishes its kind:30078 state lease and activity
    // receipts continuously alongside its streamed reply. Those session-update
    // records ride the SAME drainLiveEventFrame pump, so the gate must hold
    // for a burst that mixes them with ordinary message rows.
    const queue = Array.from({ length: 400 }, (_, index) => {
      const message = index % 2 === 0;
      return {
        type: 'read-model' as const,
        sessionId: ROOM,
        event: message
          ? humanMessage(index)
          : ({
              type: 'session-update',
              eventId: `corner-state-${index}`,
              channelId: ROOM,
              workspaceId: 'workspace',
              scope: 'channel',
              authorPubkey: 'agent-1',
              createdAt: 5_000 + index,
              sourceKind: 30078,
              signature: 'verified',
              sessionId: ROOM,
              update: {
                kind: 'corner-state',
                cornerId: 'corner-1',
                state: 'working',
                sequence: index,
              },
            } as unknown),
      };
    });
    let clock = 0;
    const now = () => clock;
    let writes = 0;
    let frames = 0;
    while (queue.length > 0) {
      clock = 0;
      frames += 1;
      drainLiveEventFrame(
        queue,
        (batch) => {
          cacheLiveSessionEvents(VIEWER, ROOM, batch);
          writes += 1;
          clock += 2;
        },
        { now, budgetMs: 5 },
      );
    }
    // Every frame stayed within the budget (2ms per 16-event chunk against
    // the 5ms cap), so no single frame can hold an interaction hostage.
    expect(writes).toBe(Math.ceil(400 / LIVE_EVENT_CHUNK_SIZE));
    expect(frames).toBeGreaterThan(1);
    const snapshot =
      useBuzzLocalCache.getState().channels[channelCacheKey(VIEWER, ROOM)]!.snapshot!;
    expect(selectTranscript(snapshot, ROOM)).toHaveLength(200);
  });
});
