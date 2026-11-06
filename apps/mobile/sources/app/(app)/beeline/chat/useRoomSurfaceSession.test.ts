import { controls, roomView, Harness, stubFrameScheduler, flushMicrotasks, flushEffects, fixtureScope1 } from './test-support-useRoomSurfaceSession.test-support.js';
import * as React from 'react';
import { SurfaceRegistry } from '@/buzz/surface-registry';
import { roomTransitionWork } from '@/buzz/room-transition-work';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { SurfaceResponseCache } from '@beeline/buzz-client';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { READ_CURSOR_DEBOUNCE_MS } from '@/buzz/read-cursor-advance';
import BuzzChat from './[channelId]';
import { type RoomView } from '@beeline/buzz-client';
import { type MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';

describe('reopening a dismissed Room', () => {
const scope1 = fixtureScope1();


  it('reopens a Room the live Room list shows dismissed', async () => {
    controls.liveList = scope1.chatList(true);
    await scope1.openRoom();
    expect(controls.liveListKeys).toEqual([
      { relayUrl: 'https://relay.test', viewerPubkey: 'viewer', workspaceId: 'workspace' },
    ]);
    expect(controls.reopenChat).toHaveBeenCalledWith('room-a');
  });


  it('lets the server decide when no live Room list is held', async () => {
    controls.liveList = null;
    await scope1.openRoom();
    expect(controls.reopenChat).toHaveBeenCalledWith('room-a');
  });


  it('skips the reopen call for a Room the live list shows open', async () => {
    controls.liveList = scope1.chatList(false);
    await scope1.openRoom();
    expect(controls.reopenChat).not.toHaveBeenCalled();
  });
});
describe('useRoomSurfaceSession', () => {
  it('paints a tap-owned cached Room and completes setup without a visible-row handshake', async () => {
    controls.hotViewer = true;
    controls.cached = { ...roomView('room-a'), messages: [{ id: 'target', text: 'Already received', createdAt: 10,
      presentation: 'message', author: { pubkey: 'viewer', kind: 'human', name: 'Viewer' } }] };
    prefetchPushRoom('cached-tap', 'room-a', 'target');
    await flushEffects();
    let session!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, {
      channelId: 'room-a', notificationResponseId: 'cached-tap', capture: (value) => { session = value; },
    })); });
    await flushEffects();
    expect(session.roomSurface?.messages[0]?.id).toBe('target');
    expect(controls.transportCount).toBe(1);
    await act(async () => renderer.unmount());
  });

  it('releases Room conversion and saves only after the actual route transition ends', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChat));
    });
    await flushEffects();
    const normalize = vi.fn((value: unknown) => value);
    const set = vi.fn(async () => {});
    const guard = vi.fn(
      (value: unknown): value is { count: number } =>
        typeof value === 'object' && value !== null && 'count' in value,
    );
    const registry = new SurfaceRegistry(
      new SurfaceResponseCache({
        get: async () => null,
        set,
        remove: async () => {},
      }),
      normalize,
      undefined,
      (key, work) => roomTransitionWork.enqueue(key, work),
    );
    const emit = (name: string) =>
      controls.navigationListeners.get(name)?.forEach((listener) => listener());
    emit('transitionStart');
    const saved = registry.write(
      { relayOrigin: 'https://relay.test', viewerPubkey: 'viewer', endpoint: '/room/busy' },
      { count: 1 },
      guard,
    );
    controls.interactionTasks.forEach((work) => work());
    expect(normalize).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    emit('transitionEnd');
    expect(set).not.toHaveBeenCalled();
    const work = [...controls.interactionTasks];
    controls.interactionTasks.clear();
    work.forEach((run) => run());
    await saved;
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });


  it('does not render the Room surface boundary when pushing and popping a corner', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChat));
    });
    await flushEffects();
    const before = controls.surfaceRenders;
    await act(async () => {
      controls.focused = false;
      controls.focusListeners.forEach((listener) => listener());
    });
    await act(async () => {
      controls.focused = true;
      controls.focusListeners.forEach((listener) => listener());
    });
    await flushEffects();
    expect(controls.surfaceRenders - before).toBe(0);
    await act(async () => renderer.unmount());
  });


  it('reuses the Room state and transcript when a corner is pushed and popped', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    const reset = vi.fn();
    const render = (isFocused: boolean) =>
      React.createElement(Harness, {
        channelId: 'room-a',
        isFocused,
        onResetTranscript: reset,
        capture: (result: UseRoomSurfaceSessionResult) => {
          current = result;
        },
      });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(render(true));
    });
    await flushEffects();
    const before = current.roomSurface;
    const resets = reset.mock.calls.length;
    const transports = controls.transportCount;
    await act(async () => renderer.update(render(false)));
    await act(async () => renderer.update(render(true)));
    await flushEffects();
    expect(current.roomSurface).toBe(before);
    expect(reset).toHaveBeenCalledTimes(resets);
    expect(controls.transportCount).toBe(transports);
    await act(async () => renderer.unmount());
  });


  it.each(['background', 'inactive'])(
    'flushes a pending delta save on %s during a corner transition without advancing timers',
    async (state) => {
      vi.useFakeTimers();
      controls.cached = roomView('room-a');
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(BuzzChat));
      });
      await flushEffects();
      vi.mocked(mobileSurfaceCache.write).mockClear();
      await act(async () =>
        controls.subscriptions.at(-1)!.emit({
          monolithLive: {
            type: 'message-delta',
            roomId: 'room-a',
            message: {
              id: 'before-background',
              roomId: 'room-a',
              text: 'latest committed arrival',
              createdAt: 100,
              author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
              tags: [],
              attachments: [],
              reactions: [],
            },
          },
        } as MonolithSurfaceEvent),
      );
      await act(async () => {
        controls.navigationListeners.get('transitionStart')?.forEach((listener) => listener());
        controls.focused = false;
        controls.focusListeners.forEach((listener) => listener());
      });
      expect(mobileSurfaceCache.write).not.toHaveBeenCalled();
      await act(async () => {
        controls.appState = state;
        controls.appStateListeners.forEach((listener) => listener(state));
      });
      expect(mobileSurfaceCache.write).toHaveBeenCalledTimes(1);
      const saved = vi.mocked(mobileSurfaceCache.write).mock.calls[0]![1] as RoomView;
      expect(saved.messages.at(-1)?.id).toBe('before-background');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(mobileSurfaceCache.write).toHaveBeenCalledTimes(1);
      await act(async () => renderer.unmount());
      expect(controls.appStateListeners.size).toBe(0);
    },
  );


  it('does not save the Room during a corner push or pop', async () => {
    controls.cached = roomView('room-a');
    const render = (isFocused: boolean) =>
      React.createElement(Harness, {
        channelId: 'room-a',
        isFocused,
        capture: () => undefined,
      });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(render(true));
    });
    await flushEffects();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    // A canonical message arrival queues a Room save; navigation must not flush it.
    const subscription = controls.subscriptions.at(-1)!;
    await act(async () =>
      subscription.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: {
            id: 'during-transition',
            roomId: 'room-a',
            text: 'new arrival',
            createdAt: 100,
            author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
            tags: [],
            attachments: [],
            reactions: [],
          },
        },
      } as MonolithSurfaceEvent),
    );
    await act(async () => renderer.update(render(false)));
    expect(mobileSurfaceCache.write).not.toHaveBeenCalled();
    await act(async () => renderer.update(render(true)));
    expect(mobileSurfaceCache.write).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });


  it('re-arms viewport advancement on a fresh visit to the same Room', async () => {
    // mark-unread suspends the advancer so the viewport cannot immediately
    // read back what the reader just declared unread. Re-arming keyed on
    // `channelId` alone made that suspension permanent for a reader who
    // reopened the SAME Room — the id never changed, so nothing resumed and
    // their read mark stopped moving for good (review 2026-09-22).
    const rows = ['m1', 'm2', 'm3'].map(
      (id) => ({ id, text: id, isUser: false, timestamp: 0 }) as ChatDisplayMessage,
    );
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    const render = (isFocused: boolean) =>
      React.createElement(Harness, {
        channelId: 'room-a',
        isFocused,
        capture: (result: UseRoomSurfaceSessionResult) => (current = result),
      });
    await act(async () => {
      renderer = create(render(true));
    });
    await flushEffects();

    // The viewport reaches m1 and settles.
    await act(async () => {
      current.advanceReadCursor(rows, [rows[0]!]);
      await new Promise((resolve) => setTimeout(resolve, READ_CURSOR_DEBOUNCE_MS + 20));
    });
    expect(controls.readMarks).toEqual(['m1']);

    // The reader marks m2 unread. The viewport must not read it straight back.
    await act(async () => {
      await current.markUnreadFrom('m2');
    });
    await act(async () => {
      current.advanceReadCursor(rows, [rows[2]!]);
      await new Promise((resolve) => setTimeout(resolve, READ_CURSOR_DEBOUNCE_MS + 20));
    });
    expect(controls.readMarks).toEqual(['m1']);

    // They leave and come back to the same Room. Same channelId throughout.
    await act(async () => {
      renderer.update(render(false));
    });
    await flushEffects();
    await act(async () => {
      renderer.update(render(true));
    });
    await flushEffects();

    // A fresh visit reads again.
    await act(async () => {
      current.advanceReadCursor(rows, [rows[2]!]);
      await new Promise((resolve) => setTimeout(resolve, READ_CURSOR_DEBOUNCE_MS + 20));
    });
    expect(controls.readMarks).toEqual(['m1', 'm3']);
    await act(async () => renderer.unmount());
  });


  it('keeps the first unread boundary from the opening read for the whole visit', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const opening = roomView('room-a');
    await act(async () => {
      controls.responses[0]!.apply({
        ...opening,
        viewer: {
          ...opening.viewer,
          readCursor: { messageId: 'read', firstUnreadMessageId: 'first-new' },
        },
      });
    });
    expect(current.firstUnreadMessageId).toBe('first-new');

    await act(async () => {
      controls.responses[0]!.apply({
        ...opening,
        viewer: {
          ...opening.viewer,
          readCursor: { messageId: 'latest', firstUnreadMessageId: null },
        },
      });
    });
    expect(current.firstUnreadMessageId).toBe('first-new');

    await act(async () => renderer.unmount());
  });


  it('does not capture or advance unread state for a corner', async () => {
    const corner = {
      ...roomView('corner-a'),
      room: { ...roomView('corner-a').room, parentId: 'room-a' },
      viewer: {
        ...roomView('corner-a').viewer,
        readCursor: {
          messageId: 'read',
          firstUnreadMessageId: 'first-new',
          unreadCount: 15,
        },
      },
    };
    controls.cached = corner;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'corner-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    await act(async () => controls.responses[0]!.apply(corner));
    expect(current.firstUnreadMessageId).toBeNull();
    const rows: ChatDisplayMessage[] = [
      { id: 'first-new', text: 'new', isUser: false, timestamp: 1 },
    ];
    await act(async () => {
      current.advanceReadCursor(rows, rows);
      await new Promise((resolve) => setTimeout(resolve, READ_CURSOR_DEBOUNCE_MS + 20));
    });
    expect(controls.readMarks).toEqual([]);
    await act(async () => renderer.unmount());
  });


  it('routes presence snapshots outside transcript overlays', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const transcriptOverlays = current.liveOverlays;
    await act(async () => {
      for (let index = 0; index < 200; index += 1) {
        controls.subscriptions[0]!.emit({
          monolithLive: {
            type: 'presence',
            roomId: 'room-a',
            agentId: 'agent-a',
            status: 'online',
            observedAt: 1_000 + index,
          },
        });
      }
    });

    expect(current.liveOverlays).toBe(transcriptOverlays);
    expect(current.liveOverlays).toEqual([]);
    expect(current.heartbeatPresences['agent-a']).toEqual({
      agentPubkey: 'agent-a',
      status: 'online',
      observedAt: 1_199,
    });
    await act(async () => renderer.unmount());
  });


  it('lets a fresh pushed fact replace an older Room presence in seconds', async () => {
    const observedAt = Math.floor(Date.now() / 1_000);
    controls.cached = {
      ...roomView('room-a'),
      members: [
        {
          identity: { pubkey: 'agent-a', kind: 'agent', name: 'Monarch' },
          role: 'member',
          presence: { status: 'offline', observedAt: observedAt - 10 },
        },
      ],
    };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    expect(current.heartbeatPresences['agent-a']?.status).toBe('offline');
    expect(current.presenceResolved).toBe(false);

    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
    });

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'presence',
          roomId: 'room-a',
          agentId: 'agent-a',
          status: 'online',
          observedAt,
        },
      });
    });
    expect(current.heartbeatPresences['agent-a']).toMatchObject({
      status: 'online',
      observedAt,
    });
    await act(async () =>
      controls.responses[0]!.apply({
        ...controls.cached!,
        members: [
          {
            ...controls.cached!.members[0]!,
            presence: { status: 'online', observedAt },
          },
        ],
      }),
    );
    expect(current.presenceResolved).toBe(true);
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'presence',
          roomId: 'room-a',
          agentId: 'agent-a',
          status: 'offline',
          observedAt: observedAt + 1,
        },
      });
    });
    expect(current.heartbeatPresences['agent-a']?.status).toBe('offline');
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'presence',
          roomId: 'room-a',
          agentId: 'agent-a',
          status: 'online',
          observedAt: observedAt + 2,
        },
      });
    });
    expect(current.heartbeatPresences['agent-a']?.status).toBe('online');
    await act(async () => renderer.unmount());
  });


  it('paints a canonical send receipt without a timer or follow-up Room read', async () => {
    vi.useFakeTimers();
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    const scheduler = controls.responses[0]!;

    // Its delta lands first: nothing is read.
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: {
            id: 'delivered-message',
            text: 'hello',
            createdAt: 1,
            author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
            presentation: 'message',
          },
        },
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    // The write receipt itself settles a send whose live delta was missed.
    await act(async () =>
      current.applyRoomMessageResult({
        id: 'accepted-message',
        text: 'accepted',
        createdAt: 2,
        author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
        presentation: 'message',
      }),
    );
    expect(current.roomSurface?.messages.some((message) => message.id === 'accepted-message')).toBe(
      true,
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(controls.outboxFail).not.toHaveBeenCalled();
    expect(current.outbox.failedIds).not.toContain('accepted-message');
    await act(async () => renderer.unmount());
    vi.useRealTimers();
  });


  it('paints a committed turn delta without a follow-up Room read', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const claimedAt = Math.floor(Date.now() / 1_000);
    const startedAt = performance.now();
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'turn-delta',
          roomId: 'room-a',
          turn: {
            requestId: 'request-a',
            agentPubkey: 'agent-a',
            status: 'working',
            createdAt: claimedAt,
          },
        },
      });
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(current.roomSurface?.latestAgentTurns).toEqual([
      expect.objectContaining({ requestId: 'request-a', status: 'working' }),
    ]);
    await act(async () => renderer.unmount());
  });


  it('keeps a retry turn delta that lands while a same-second Room read is in flight', async () => {
    const at = Math.floor(Date.now() / 1_000);
    const finished = {
      requestId: 'request-a',
      agentPubkey: 'agent-a',
      status: 'complete' as const,
      createdAt: at,
    };
    const retry = { ...finished, requestId: 'request-b', status: 'working' as const };
    controls.cached = { ...roomView('room-a'), latestAgentTurns: [finished] };
    controls.roomResponse = { ...roomView('room-a'), latestAgentTurns: [finished] };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      const read = controls.responses[0]!.fetch();
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'turn-delta', roomId: 'room-a', turn: retry },
      });
      controls.responses[0]!.apply(await read);
    });

    expect(current.roomSurface?.latestAgentTurns).toEqual([retry]);
    await act(async () => renderer.unmount());
  });


  it('paints one committed reply exactly once without a follow-up Room read', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    const reply = {
      id: 'reply-message',
      text: 'Done',
      createdAt: 3,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };
    const emitReply = () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'message-delta', roomId: 'room-a', message: reply },
      });

    await act(async () => emitReply());
    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual(['reply-message']);

    await act(async () => emitReply());
    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual(['reply-message']);

    const full = { ...roomView('room-a'), messages: [reply] };
    await act(async () => controls.responses[0]!.apply(full));
    expect(current.roomSurface).toEqual(full);
    expect(current.roomSurface?.messages).toHaveLength(1);
    await act(async () => renderer.unmount());
  });


  it('schedules no Room read from the socket while the app is backgrounded', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    controls.appState = 'background';
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
    });

    controls.appState = 'active';
    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
    });
    await act(async () => renderer.unmount());
  });


  it('paints a covering read with a previously missed message while retaining the socket', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    let current!: UseRoomSurfaceSessionResult;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: (result: UseRoomSurfaceSessionResult) => (current = result) }),
      );
    });
    await flushEffects();
    const missed = {
      id: 'missed-message',
      text: 'you missed me',
      createdAt: 5,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };

    await act(async () => controls.responses[0]!.apply(roomView('room-a')));
    expect(controls.reconnects).toBe(0);
    await act(async () =>
      controls.responses[0]!.apply({ ...roomView('room-a'), messages: [missed] }),
    );
    expect(controls.reconnects).toBe(0);
    expect(current.roomSurface?.messages).toContainEqual(missed);
    await act(async () => renderer.unmount());
  });


  it('keeps the socket when it delivered frames since the previous read', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => controls.responses[0]!.apply(roomView('room-a')));
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      });
    });
    await act(async () =>
      controls.responses[0]!.apply({
        ...roomView('room-a'),
        messages: [
          {
            id: 'signalled-message',
            text: 'announced',
            createdAt: 5,
            author: { pubkey: 'agent-a', kind: 'agent', name: 'Greeter' },
            presentation: 'message',
          },
        ],
      }),
    );
    expect(controls.reconnects).toBe(0);
    await act(async () => renderer.unmount());
  });


  it('yields a paint turn after cache apply before installing the live watch', async () => {
    const { queued, receivers } = stubFrameScheduler();
    controls.cached = roomView('room-a');
    controls.roomResponse = null;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushMicrotasks();
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(controls.subscriptions).toHaveLength(0);
    expect(controls.transportCount).toBe(0);

    await act(async () => {
      const first = queued.splice(0);
      first.forEach((callback) => callback(0));
      const second = queued.splice(0);
      second.forEach((callback) => callback(0));
    });
    await flushMicrotasks();
    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.transportCount).toBe(1);
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
    await act(async () => renderer.unmount());
  });
});
