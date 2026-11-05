import * as React from 'react';
import { SurfaceRegistry } from '@/buzz/surface-registry';
import { roomTransitionWork } from '@/buzz/room-transition-work';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListView, NostrEvent, RoomView } from '@beeline/buzz-client';
import { SurfaceResponseCache, visibleLiveOverlays } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { prefetchPushRoom } from '@/push/push-room-prefetch';
import { mobileSurfaceCache } from '@/buzz/surface-storage';
import { loadBuzzIdentity, loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';

type TestSurfaceEvent = NostrEvent | MonolithSurfaceEvent;

// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.
vi.mock('@/sync/transport/live-connection', () => ({
  reconnectNow: () => {
    controls.explicitReconnects += 1;
  },
}));

vi.mock('@/buzz/router-chat-list', () => ({
  acquireRoutedChatList: (_key: unknown, _consumer: unknown, legacy: () => unknown) => legacy(),
}));


const controls = vi.hoisted(() => ({
  routeChannelId: 'room-a',
  scopeProbe: null as null | ((session: any, overlay: any, history: any) => void),
  focused: true,
  routerMode: 'legacy' as 'legacy' | 'pending' | 'router',
  routerValue: null as RoomView | null,
  navigationListeners: new Map<string, Set<() => void>>(),
  interactionTasks: new Set<() => void>(),
  focusListeners: new Set<() => void>(),
  surfaceRenders: 0,
  cached: null as RoomView | null,
  hotViewer: false,
  cacheListeners: new Set<() => void>(),
  viewerRead: null as Promise<string | null> | null,
  responses: [] as Array<{fetch():Promise<RoomView>;apply(view:RoomView):void;error(error:unknown):void}>,
  readLatest: undefined as (()=>void)|undefined,
  subscriptions: [] as Array<{
    filters: unknown;
    stop: ReturnType<typeof vi.fn>;
    emit(event: TestSurfaceEvent): void;
  }>,
  replayEvents: [] as NostrEvent[],
  readMarks: [] as string[],
  transportCount: 0,
  reconnects: 0,
  explicitReconnects: 0,
  appState: 'active' as string,
  appStateListeners: new Set<(state: string) => void>(),
  reopenChat: vi.fn(async (_roomId: string) => undefined),
  identityPromise: null as Promise<{ publicKey: string; secretKey: Uint8Array } | null> | null,
  ensureClientPromise: null as Promise<void> | null,
  outboxRestore: null as Promise<void> | null,
  viewerPubkey: 'viewer' as string | null,
  outboxFail: vi.fn(async (_eventId: string) => undefined),
  outboxGet: vi.fn((_eventId: string) => ({ status: 'pending' as const })),
  traceSetItem: vi.fn(async (_key: string, _value: string) => undefined),
  roomResponse: null as RoomView | null,
  roomReads: 0,
  roomError: null as unknown,
  liveList: null as ChatListView | null,
  liveListKeys: [] as unknown[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: controls.traceSetItem },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      controls.appStateListeners.add(listener);
      return { remove: () => controls.appStateListeners.delete(listener) };
    }),
    get currentState() {
      return controls.appState;
    },
  },
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
  Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('Pressable', props, props.children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('Text', props, props.children),
  View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement('View', props, props.children),
}));

vi.mock('expo-haptics', () => ({
  impactAsync: () => undefined,
  notificationAsync: () => undefined,
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success' },
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: (props: Record<string, unknown>) => React.createElement('AnimatedView', props) },
  Easing: { linear: 'linear', out: (fn: unknown) => fn, poly: (n: number) => n },
  ReduceMotion: { System: 'system' },
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useReducedMotion: () => false,
  useSharedValue: (value: number) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: number) => value,
  withSequence: (value: unknown) => value,
  FadeInDown: { duration: () => ({}) },
}));

vi.mock('expo-router', () => ({
  router: { replace: vi.fn() },
  useLocalSearchParams: () => ({ channelId: controls.routeChannelId }),
}));
const navigation = {
  isFocused: () => controls.focused,
  addListener: (name: string, listener: () => void) => {
    const listeners = controls.navigationListeners.get(name) ?? new Set<() => void>();
    listeners.add(listener);
    controls.navigationListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
    };
  },
};
vi.mock('@/buzz/room-transition-work', async () => {
  const { TransitionWork } = await import('@/buzz/transition-work');
  return {
    roomTransitionWork: new TransitionWork((work) => {
      controls.interactionTasks.add(work);
      return () => {
        controls.interactionTasks.delete(work);
      };
    }),
  };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navigation,
  useIsFocused: () =>
    React.useSyncExternalStore(
      (listener) => {
        controls.focusListeners.add(listener);
        return () => {
          controls.focusListeners.delete(listener);
        };
      },
      () => controls.focused,
    ),
}));
vi.mock('@/components/buzz/RoomOpenTraceOverlay', () => ({ RoomOpenTraceOverlay: () => null }));
vi.mock('./_chat-surface', async () => {
  const { useRoomSendFrame } = await import('@/buzz/room-send-frame');
  const { useRoomMessageStore } = await import('@/buzz/room-message-store');
  function ScopeProbe({ session, bindingsRef }: any) {
    const overlay = useRoomSendFrame([], new Set());
    const history = useRoomMessageStore({
      roomId: controls.routeChannelId,
      tailMessages: session.roomSurface?.messages,
      roomClient: session.roomClient,
      enabled: true,
      initialVisibleCount: 30,
    });
    bindingsRef.current = {
      resetTranscript: () => {
        overlay.clear();
        history.reset();
      },
      restoreOutboxMessages: overlay.append,
      dismissOptimisticMessage: overlay.remove,
      observeRoomSurface: () => {},
    };
    controls.scopeProbe?.(session, overlay, history);
    const rows = [
      ...(session.roomSurface?.messages ?? []),
      ...history.rows,
      ...overlay.frame.optimistic,
    ];
    return React.createElement(
      'room-root',
      null,
      ...rows.map((row, index) => React.createElement('probe-row', { key: index }, row.text)),
    );
  }
  return {
    BuzzChatSurface: (props: any) => {
      controls.surfaceRenders++;
      return controls.scopeProbe
        ? React.createElement(ScopeProbe, props)
        : React.createElement('room-root');
    },
  };
});

vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(
    () =>
      controls.identityPromise ??
      Promise.resolve({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
  ),
  loadBuzzViewerPubkey: vi.fn(async () => controls.viewerRead ?? controls.viewerPubkey),
  peekBuzzViewerContext: () =>
    controls.hotViewer
      ? { relayUrl: 'https://relay.test', viewerPubkey: controls.viewerPubkey! }
      : null,
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
}));

vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
}));

vi.mock('@/buzz/surface-storage', () => ({
  restoreStoredSurface: (path: string) => path.startsWith('/room/') ? controls.cached : null,
  mobileSurfaceCache: {
    peek: vi.fn((path: string) => (path.startsWith('/room/') ? controls.cached : null)),
    read: vi.fn(async () => controls.cached),
    write: vi.fn(async () => undefined),
    publish: vi.fn((_address: unknown, view: RoomView) => {
      controls.cached = view;
      return view;
    }),
    subscribe: vi.fn((_address: unknown, listener: () => void) => {
      controls.cacheListeners.add(listener);
      return () => {
        controls.cacheListeners.delete(listener);
      };
    }),
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  surfaceAddress: vi.fn((_relay: string, _viewer: string, path: string) => path),
  createRoomOutbox: vi.fn(() => ({
    restore: vi.fn(async () => {
      await controls.outboxRestore;
    }),
    list: vi.fn(() => []),
    subscribe: () => () => undefined,
    state: () => undefined,
    acknowledgeFailures: async () => undefined,
    reconcile: vi.fn(async () => undefined),
    fail: controls.outboxFail,
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    get: controls.outboxGet,
  })),
}));

vi.mock('@/buzz/chat-list-store', () => ({
  liveChatList: (key: unknown) => {
    controls.liveListKeys.push(key);
    return controls.liveList;
  },
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    constructor() {
      controls.transportCount += 1;
    }
    async ensureClient() {
      await controls.ensureClientPromise;
      return {
        surfaceSubscribe: async (filters: unknown, emit: (event: TestSurfaceEvent) => void) => {
          const stop = vi.fn();
          controls.subscriptions.push({ filters, stop, emit });
          for (const event of controls.replayEvents) emit(event);
          return stop;
        },
      };
    }
    async publishPreparedMessage() {}
    reconnectLive() {
      controls.reconnects += 1;
    }
    async reopenChat(roomId: string) {
      return controls.reopenChat(roomId);
    }
  },
}));

vi.mock('@/sync/transport/room-view-client', async () => {
  const { RoomViewHttpError } =
    await vi.importActual<typeof import('@beeline/buzz-client')>('@beeline/buzz-client');
  return {
    RoomViewHttpError,
    readPushedMonolithRoom: async (_roomId: string) => {
      controls.roomReads += 1;
      if (controls.roomError) return Promise.reject(controls.roomError);
      if (controls.roomResponse) return controls.roomResponse;
      return new Promise<RoomView>(() => undefined);
    },
    isRoomViewTimeoutError: (error: unknown) =>
      error instanceof RoomViewHttpError &&
      (error.code === 'timeout' || error.code === 'surface_request_timed_out'),
    RoomViewClient: class {
      private pending: Array<{resolve(view:RoomView):void;reject(error:unknown):void}> = [];
      constructor() {
        controls.responses.push({
          fetch: async () => {
            if (controls.roomError) throw controls.roomError;
            const response = controls.roomResponse;
            if (!this.pending.length) {
              controls.roomResponse = null;
              controls.readLatest?.();
              controls.roomResponse = response;
            }
            return response!;
          },
          apply: view => {
            const pending = this.pending.pop();
            if (pending) pending.resolve(view);
            else { controls.roomResponse=view; controls.readLatest?.(); controls.roomResponse=null; }
          },
          error: error => {
            const pending=this.pending.pop();
            if (pending) pending.reject(error);
            else { controls.roomError=error; controls.readLatest?.(); controls.roomError=null; }
          },
        });
      }
      async room() {
        controls.roomReads += 1;
        if (controls.roomError) throw controls.roomError;
        if (controls.roomResponse) return controls.roomResponse;
        return new Promise<RoomView>((resolve,reject)=>this.pending.push({resolve,reject}));
      }
      async markRead(roomId: string, messageId: string) {
        controls.readMarks.push(messageId);
      }
      async markUnread() {}
    },
  };
});


import { RoomViewHttpError } from '@beeline/buzz-client';
import { READ_CURSOR_DEBOUNCE_MS } from '@/buzz/read-cursor-advance';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import {
  roomMessageRecord,
  useRoomMessageRecords,
  writeRoomBookmark,
} from '@/buzz/room-message-records';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import {
  LIVE_TRACE_STORAGE_KEY,
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
  type UseRoomSurfaceSessionResult,
} from './useRoomSurfaceSession';

import BuzzChat from './[channelId]';

const originalConsoleError = console.error;

function roomView(id: string, filters: RoomView['watchFilters'] = [{ '#h': [id] }]): RoomView {
  return {
    room: {
      id,
      workspaceId: 'workspace',
      name: `Room ${id}`,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    },
    messages: [],
    members: [],
    latestAgentTurns: [],
    viewer: {
      identity: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      role: 'owner',
      permissions: { send: true, manage: true },
    },
    repositoryResolution: { status: 'absent' },
    watchFilters: filters,
  };
}

function Harness({
  channelId,
  notificationResponseId,
  isFocused = true,
  capture,
  onResetTranscript,
}: {
  channelId: string;
  notificationResponseId?: string;
  isFocused?: boolean;
  capture(result: UseRoomSurfaceSessionResult): void;
  onResetTranscript?: () => void;
}) {
  const bindingsRef = React.useRef<RoomSurfaceSessionBindings>({
    resetTranscript: onResetTranscript ?? vi.fn(),
    restoreOutboxMessages: vi.fn(),
    dismissOptimisticMessage: vi.fn(),
    observeRoomSurface: vi.fn(),
  });
  const result = useRoomSurfaceSession({
    channelId,
    isFocused,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });
  controls.readLatest = result.readRoom;
  capture(result);
  return React.createElement(
    'room-surface',
    {
      roomId: result.roomSurface?.room.id,
      error: result.hydrationError,
    },
    ...(result.roomSurface?.messages ?? []).map((message) =>
      React.createElement('message-row', { key: message.id }, message.text),
    ),
  );
}

function stubFrameScheduler(): {
  queued: FrameRequestCallback[];
  receivers: unknown[];
} {
  const queued: FrameRequestCallback[] = [];
  const receivers: unknown[] = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    function requestAnimationFrame(this: unknown, callback: FrameRequestCallback) {
      receivers.push(this);
      queued.push(callback);
      return receivers.length;
    },
  );
  return { queued, receivers };
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushEffects() {
  await flushMicrotasks();
  await act(async () => {
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
  await flushMicrotasks();
}

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

beforeEach(() => {
  controls.routeChannelId = 'room-a';
  controls.scopeProbe = null;
  controls.routerMode = 'legacy';
  controls.routerValue = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  roomTransitionWork.flush();
  controls.focused = true;
  controls.focusListeners.clear();
  controls.navigationListeners.clear();
  controls.interactionTasks.clear();
  controls.surfaceRenders = 0;
  controls.cached = null;
  controls.hotViewer = false;
  controls.cacheListeners.clear();
  controls.viewerRead = null;
  controls.responses.length = 0;
  controls.subscriptions.length = 0;
  controls.transportCount = 0;
  controls.reconnects = 0;
  controls.explicitReconnects = 0;
  controls.appState = 'active';
  controls.reopenChat.mockClear();
  controls.replayEvents.length = 0;
  controls.readMarks.length = 0;
  controls.identityPromise = null;
  controls.ensureClientPromise = null;
  controls.outboxRestore = null;
  controls.viewerPubkey = 'viewer';
  controls.roomResponse = null;
  controls.roomReads = 0;
  controls.roomError = null;
  controls.liveList = null;
  controls.liveListKeys.length = 0;
  controls.outboxFail.mockClear();
  controls.outboxGet.mockClear();
  vi.clearAllMocks();
});

describe('reopening a dismissed Room', () => {
  function chatList(closed: boolean): ChatListView {
    return {
      workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
      chats: [
        { room: roomView('room-a').room, unread: false, ...(closed ? { closed: true } : {}) },
      ],
      viewer: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      truncated: false,
      watchFilters: [{ '#h': ['room-a'] }],
    };
  }

  async function openRoom(): Promise<void> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();
    await act(async () => controls.responses[0]!.apply(roomView('room-a')));
    await flushEffects();
    await act(async () => renderer.unmount());
  }

  it('reopens a Room the live Room list shows dismissed', async () => {
    controls.liveList = chatList(true);
    await openRoom();
    expect(controls.liveListKeys).toEqual([
      { relayUrl: 'https://relay.test', viewerPubkey: 'viewer', workspaceId: 'workspace' },
    ]);
    expect(controls.reopenChat).toHaveBeenCalledWith('room-a');
  });

  it('lets the server decide when no live Room list is held', async () => {
    controls.liveList = null;
    await openRoom();
    expect(controls.reopenChat).toHaveBeenCalledWith('room-a');
  });

  it('skips the reopen call for a Room the live list shows open', async () => {
    controls.liveList = chatList(false);
    await openRoom();
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

  it('renders the hot target before the asynchronous session has even read its identity', async () => {
    controls.hotViewer = true;
    controls.viewerRead = new Promise(() => undefined);
    controls.cached = {
      ...roomView('room-a'),
      messages: [
        {
          id: 'target',
          text: 'Newest received row',
          createdAt: 10,
          author: { pubkey: 'author', kind: 'human', name: 'Author' },
          presentation: 'message',
        },
      ],
    };
    const { queued } = stubFrameScheduler();
    const reset = vi.fn();
    const props = { channelId: 'room-a', capture: () => undefined, onResetTranscript: reset };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Harness, props));
    });
    expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
      'Newest received row',
    );
    expect(reset).not.toHaveBeenCalled();
    expect(loadBuzzViewerPubkey).not.toHaveBeenCalled();
    await act(async () => {
      queued.splice(0).forEach((frame) => frame(0));
    });
    expect(controls.transportCount).toBe(0);
    expect(controls.roomReads).toBe(0);
    await act(async () =>
      renderer.update(React.createElement(Harness, { ...props, isFocused: false })),
    );
    await act(async () => renderer.update(React.createElement(Harness, props)));
    expect(reset).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it('paints an opening reply while cached-frame callbacks and identity setup are still pending', async () => {
    controls.hotViewer = true;
    controls.viewerRead = new Promise(() => undefined);
    controls.cached = roomView('room-a');
    stubFrameScheduler();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => {
      controls.cached = {
        ...roomView('room-a'),
        messages: [
          {
            id: 'arrived',
            text: 'Arrived during opening',
            createdAt: 10,
            author: { pubkey: 'author', kind: 'human', name: 'Author' },
            presentation: 'message',
          },
        ],
      };
      controls.cacheListeners.forEach((listener) => listener());
    });
    expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
      'Arrived during opening',
    );
    expect(loadBuzzViewerPubkey).not.toHaveBeenCalled();
    expect(controls.roomReads).toBe(0);
    await act(async () => renderer.unmount());
    expect(controls.cacheListeners.size).toBe(0);
  });

  it('paints a missing-row publish after disk read while identity and then outbox remain pending', async () => {
    controls.hotViewer = true;
    controls.cached = roomView('room-a');
    let resolveIdentity!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => {
      resolveIdentity = resolve;
    });
    controls.outboxRestore = new Promise(() => undefined);
    const { queued } = stubFrameScheduler();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'late-opening-reply',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => {
      queued.splice(0).forEach((frame) => frame(0));
      queued.splice(0).forEach((frame) => frame(0));
    });
    await flushMicrotasks();
    expect(mobileSurfaceCache.read).toHaveBeenCalled();
    expect(loadBuzzIdentity).toHaveBeenCalled();
    const publish = async (text: string) => {
      await act(async () => {
        controls.cached = {
          ...roomView('room-a'),
          messages: [
            {
              id: text,
              text,
              createdAt: 10,
              author: { pubkey: 'author', kind: 'human', name: 'Author' },
              presentation: 'message',
            },
          ],
        };
        controls.cacheListeners.forEach((listener) => listener());
      });
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(text);
    };
    try {
      await publish('Reply after disk read, identity pending');
      expect(controls.transportCount).toBe(0);
      await act(async () =>
        resolveIdentity({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
      );
      await flushMicrotasks();
      expect(controls.transportCount).toBe(1);
      await publish('Reply while outbox restore is pending');
      expect(controls.roomReads).toBe(0);
    } finally {
      await act(async () => renderer.unmount());
    }
    expect(controls.cacheListeners.size).toBe(0);
  });

  it.each([1, 5])(
    'paints %i received messages on the first frame before any network read',
    async (count) => {
      controls.hotViewer = true;
      const { queued } = stubFrameScheduler();
      controls.cached = {
        ...roomView('room-a'),
        messages: Array.from({ length: count }, (_, n) => ({
          id: `received-${n}`,
          text: `received ${n}`,
          createdAt: 10 + n,
          author: { pubkey: 'author', kind: 'human' as const, name: 'Author' },
          presentation: 'message' as const,
        })),
      };
      let current!: UseRoomSurfaceSessionResult;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(
          React.createElement(Harness, {
            channelId: 'room-a',
            capture: (result: UseRoomSurfaceSessionResult) => {
              current = result;
            },
          }),
        );
      });
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
        `received ${count - 1}`,
      );
      expect(controls.roomReads).toBe(0);
      await flushMicrotasks();
      await act(async () => {
        queued.splice(0).forEach((frame) => frame(0));
      });
      expect(current.roomSurface?.messages.at(-1)?.id).toBe(`received-${count - 1}`);
      expect(renderer.root.findAllByType('message-row').at(-1)?.props.children).toBe(
        `received ${count - 1}`,
      );
      expect(controls.transportCount).toBe(0);
      expect(controls.roomReads).toBe(0);
      expect(controls.subscriptions).toHaveLength(0);
      await act(async () => renderer.unmount());
    },
  );

  it('paints cached newest row before authorization occupies the session', async () => {
    const { queued, receivers } = stubFrameScheduler();
    let resolveAuth!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => {
      resolveAuth = resolve;
    });
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
    await flushMicrotasks();
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(controls.transportCount).toBe(0);

    await act(async () => {
      queued.splice(0).forEach((callback) => callback(0));
      queued.splice(0).forEach((callback) => callback(0));
    });
    await flushMicrotasks();
    expect(controls.transportCount).toBe(0);

    await act(async () => {
      resolveAuth({ publicKey: 'viewer', secretKey: new Uint8Array(32) });
    });
    await flushMicrotasks();
    expect(controls.transportCount).toBe(1);
    expect(receivers.length).toBeGreaterThan(0);
    expect(receivers.every((receiver) => receiver === globalThis)).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('acknowledges every burst delta after its committed render without a follow-up read', async () => {
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
    const acknowledgements: string[] = [];
    const first = {
      id: 'reply-one',
      text: 'one',
      createdAt: 1,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };
    const second = { ...first, id: 'reply-two', text: 'two', createdAt: 2 };

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: first,
          trace: { id: 'trace-one', startedAt: 10, databaseAt: 11, emittedAt: 12 },
        },
        acknowledgePaint: () => acknowledgements.push('one'),
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: second,
          trace: { id: 'trace-two', startedAt: 20, databaseAt: 21, emittedAt: 22 },
        },
        acknowledgePaint: () => acknowledgements.push('two'),
      });
      expect(acknowledgements).toEqual([]);
    });

    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual([
      'reply-one',
      'reply-two',
    ]);
    expect(acknowledgements).toEqual(['one', 'two']);

    const full = { ...roomView('room-a'), messages: [first, second] };
    await act(async () => controls.responses[0]!.apply(full));
    expect(current.roomSurface).toEqual(full);
    await act(async () => renderer.unmount());
  });

  it('acknowledges an idempotent delta immediately because its row is already painted', async () => {
    const reply = {
      id: 'reply-existing',
      text: 'done',
      createdAt: 1,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Greeter' },
      presentation: 'message' as const,
    };
    controls.cached = { ...roomView('room-a'), messages: [reply] };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();
    const acknowledgePaint = vi.fn();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: reply,
          trace: { id: 'trace-existing', startedAt: 10, databaseAt: 11, emittedAt: 12 },
        },
        acknowledgePaint,
      });
    });

    expect(acknowledgePaint).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it('records the same-server pre-write-to-paint upper bound returned by the server', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'trace-painted',
          id: 'trace-bound',
          startedAt: 1_000,
          databaseAt: 1_025,
          serverReceivedAt: 1_240,
          upperBoundMs: 240,
        },
      });
    });
    await vi.waitFor(() =>
      expect(controls.traceSetItem).toHaveBeenCalledWith(
        LIVE_TRACE_STORAGE_KEY,
        expect.stringContaining('"upperBoundMs":240'),
      ),
    );
    const stored = String(controls.traceSetItem.mock.calls.at(-1)?.[1]);
    expect(stored).toContain('"startedAt":1000');
    expect(stored).toContain('"databaseAt":1025');
    expect(stored).toContain('"serverReceivedAt":1240');
    await act(async () => renderer.unmount());
  });

  it('opens a cached corner and applies its fresh response without a draw handshake', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, {
      channelId: 'room-a', capture: value => { current = value; },
    })); });
    await flushEffects();
    const fresh = { ...roomView('room-a'), messages: [{ id: 'fresh-row', createdAt: 2,
      text: 'new corner contents', presentation: 'message' as const,
      author: { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' } }] };
    await act(async () => controls.responses[0]!.apply(fresh));
    expect(current.roomSurface).toEqual(fresh);
    await act(async () => renderer.unmount());
  });

  it('Send: pushed queued commands paint without a follow-up Room read', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result) => {
            current = result;
          },
        }),
      );
    });
    await flushEffects();
    const commands = [{ requestId: 'sent', agentPubkey: 'agent-a', createdAt: 1 }];
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'room-commands',
          roomId: 'room-a',
          commands,
        },
      } as unknown as MonolithSurfaceEvent),
    );
    expect(current.roomSurface?.pendingAgentCommands).toEqual(commands);
    await act(async () => renderer.unmount());
  });

  it('signals a targetless phone-write so an open Room can paint without remounting', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'phone-write' },
      });
    });

    await act(async () => renderer.unmount());
  });

  it('still waits for the committed-row delta when a phone-write names its message', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'phone-write',
          messageId: 'posted-message',
        },
      });
    });

    await act(async () => renderer.unmount());
  });

  it.each([
    [
      'SYNC-01',
      {
        type: 'invalidate' as const,
        roomId: 'room-a',
        reason: 'postgres:messages',
        messageId: 'message-stalled',
        deliveryId: 'delivery-sync',
      },
    ],
    [
      'STOP-01',
      {
        type: 'invalidate' as const,
        roomId: 'room-a',
        reason: 'postgres:agent_turns',
        agentId: 'agent-a',
        requestId: 'request-a',
        deliveryId: 'delivery-stop',
      },
    ],
  ])('reads nothing for the %s hint whose delta follows', async (_id, event) => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: event });
    });

    await act(async () => renderer.unmount());
  });

  it('STOP-01 clears the working turn from its turn delta, with no Room read', async () => {
    controls.cached = {
      ...roomView('room-a'),
      latestAgentTurns: [
        {
          requestId: 'request-a',
          agentPubkey: 'agent-a',
          status: 'working',
          createdAt: 1,
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

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:agent_turns',
          agentId: 'agent-a',
          requestId: 'request-a',
          deliveryId: 'delivery-stop',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'turn-delta',
          roomId: 'room-a',
          reconcilesDelivery: 'delivery-stop',
          turn: {
            requestId: 'request-a',
            agentPubkey: 'agent-a',
            status: 'cancelled',
            createdAt: 1,
          },
        },
      });
    });

    expect(current.roomSurface?.latestAgentTurns).toEqual([
      expect.objectContaining({ requestId: 'request-a', status: 'cancelled' }),
    ]);
    await act(async () => renderer.unmount());
  });

  it('paints a paired delta and reads no Room for it', async () => {
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

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:messages',
          messageId: 'message-a',
          deliveryId: 'delivery-a',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          reconcilesDelivery: 'delivery-a',
          message: {
            id: 'message-a',
            text: 'Done',
            createdAt: 2,
            author: { pubkey: 'agent-a', kind: 'agent', name: 'Greeter' },
            presentation: 'message',
          },
        },
      });
    });

    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual(['message-a']);
    await act(async () => renderer.unmount());
  });

  it('reconciles immediately when a committed delta cannot be delivered', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'delta-fallback:postgres:messages',
        },
      });
    });

    await act(async () => renderer.unmount());
  });

  it('reads the Room once for the fallback of a delivery the server could not read', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:messages',
          messageId: 'message-deleted',
          deliveryId: 'delivery-deleted',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'delta-fallback:postgres:messages',
          messageId: 'message-deleted',
          reconcilesDelivery: 'delivery-deleted',
        },
      });
    });

    await act(async () => renderer.unmount());
  });

  it('starts the single opening Room read after its subscribe', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    // No subscribed frame yet: the cache paints while the read waits for coverage.
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      }),
    );
    await act(async () => renderer.unmount());
  });

  it('reads once on its first handshake and never starts reads from resubscribe', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      });
    });

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      });
    });
    await act(async () => renderer.unmount());
  });





  it('uses the push read already started before route mount without a subscription reread', async () => {
    controls.roomResponse = roomView('room-a');
    prefetchPushRoom('response-prefetched', 'room-a');
    await flushMicrotasks();
    expect(controls.roomReads).toBe(1);
    let session!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'response-prefetched',
          capture: (value) => {
            session = value;
          },
        }),
      );
    });
    await flushEffects();
    expect(session.roomSurface?.room.id).toBe('room-a');
    expect(controls.roomReads).toBe(1);
    await flushEffects();
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'subscribed', roomId: 'room-a' },
      }),
    );
    expect(controls.roomReads).toBe(1);
    expect(controls.subscriptions).toHaveLength(1);
    await act(async () => renderer.unmount());
  });

  it('closes a watch still waiting on its subscribe when the reader leaves', async () => {
    vi.useFakeTimers();
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: 'room-a', capture: () => undefined }),
      );
    });
    await flushEffects();

    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.subscriptions[0]!.stop).not.toHaveBeenCalled();

    await act(async () => renderer.unmount());
    await flushEffects();
    expect(controls.subscriptions[0]!.stop).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('records a bounded correlation trace when the phone socket receives an invalidation', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:agent_turns',
          trace: { id: 'trace-turn', databaseAt: 100, emittedAt: 125 },
        },
      });
    });

    expect(info).not.toHaveBeenCalled();
    expect(controls.traceSetItem).not.toHaveBeenCalled();
    controls.roomResponse = {
      ...roomView('room-a'),
      latestAgentTurns: [
        {
          requestId: 'request-a',
          agentPubkey: 'agent-a',
          status: 'working',
          createdAt: Math.floor(Date.now() / 1_000),
        },
      ],
    };
    await act(async () => {
      controls.responses[0]!.apply(await controls.responses[0]!.fetch());
    });
    await vi.waitFor(() => expect(controls.traceSetItem).toHaveBeenCalled());
    const [key, stored] = controls.traceSetItem.mock.calls.at(-1)!;
    expect(key).toBe('@beeline/live-event-trace-v1');
    expect(stored).toContain('"phase":"socket-receipt"');
    expect(stored).toContain('"id":"trace-turn"');
    expect(stored).not.toContain('room-a');
    info.mockRestore();
    await act(async () => renderer.unmount());
  });

  it('keeps a child corner’s monolith draft and thought lanes out of its parent Room', async () => {
    const parent = roomView('room-a', [{ '#h': ['room-a', 'corner-a'] }]);
    controls.cached = {
      ...parent,
      members: [{ identity: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' }, role: 'member' }],
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

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'draft',
          roomId: 'corner-a',
          agentId: 'agent-a',
          turnId: 'corner-turn',
          text: 'This narration belongs only in the corner.',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'thought',
          roomId: 'corner-a',
          agentId: 'agent-a',
          turnId: 'corner-turn',
          text: 'The parent must not render this thought.',
        },
      });
    });

    expect(current.liveOverlays).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('streams a corner’s own draft into the corner, and settles it on the durable reply', async () => {
    // A corner is the same route as a Room, so the whole streaming
    // presentation is shared. What was never covered is the corner viewed as
    // ITSELF: the server builds a corner's watch filters around the corner id
    // and its parent, and the corner's live lane is the only place its prose
    // exists before the answer lands.
    const cornerFilters: RoomView['watchFilters'] = [
      { kinds: [9], '#h': ['workspace', 'corner-a', 'room-a'] },
      { kinds: [30078], '#d': ['agent-draft:corner-a', 'agent-thought:corner-a'] },
    ];
    controls.cached = { ...roomView('corner-a', cornerFilters), parent: roomView('room-a').room };
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

    // The corner's own id has to reach the live subscription, or nothing the
    // turn writes can ever be delivered to the reader sitting in it. Family
    // ids in watchFilters must not become extra subscriptions.
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['corner-a'] }]);

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'corner-a', ...live } });
    await act(async () => {
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-c',
        text: "I'll trace the producer",
      });
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-c',
        text: "I'll trace the producer, then make the smallest correction",
      });
    });

    expect(current.liveOverlays).toHaveLength(1);
    expect(current.liveOverlays[0]).toMatchObject({
      kind: 'draft',
      // The author is half a draft row's identity (C107).
      stableId: 'live-turn:agent-a:turn-c',
      agentPubkey: 'agent-a',
      requestId: 'turn-c',
      closed: false,
    });
    expect(current.liveDraftStore.getReceived('agent-a:turn-c')).toBe(
      "I'll trace the producer, then make the smallest correction",
    );

    // Exactly as a Room settles: the durable reply carries the turn's request
    // id, and the provisional row stops being visible the moment it lands.
    const reply = {
      id: 'e'.repeat(64),
      text: "I'll trace the producer, then make the smallest correction. Done.",
      createdAt: 20,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const,
      requestId: 'turn-c',
    };
    await act(async () => {
      emit({ type: 'retract', kind: 'draft', agentId: 'agent-a', turnId: 'turn-c' });
      controls.responses[0]!.apply({
        ...roomView('corner-a', cornerFilters),
        parent: roomView('room-a').room,
        messages: [reply],
      });
    });
    expect(visibleLiveOverlays(current.liveOverlays, [reply])).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('keeps cumulative draft arrivals out of Room React state after opening the live row', async () => {
    controls.cached = roomView('room-a');
    let current!: UseRoomSurfaceSessionResult;
    let roomRenders = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: (result: UseRoomSurfaceSessionResult) => {
            current = result;
            roomRenders += 1;
          },
        }),
      );
    });
    await flushEffects();

    const emitDraft = (text: string) =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'draft',
          roomId: 'room-a',
          agentId: 'agent-a',
          turnId: 'turn-a',
          text,
        },
      });

    await act(async () => emitDraft('0'));
    const structuralRows = current.liveOverlays;
    const rendersAfterOpeningRow = roomRenders;

    // Separate React turns are intentional. Batching a burst would hide the
    // one Room render currently paid for by every network arrival.
    for (let chunk = 1; chunk < 40; chunk += 1) {
      await act(async () => emitDraft(String(chunk).padStart(chunk + 1, 'x')));
    }

    expect(current.liveOverlays).toBe(structuralRows);
    expect(roomRenders).toBe(rendersAfterOpeningRow);
    await act(async () => renderer.unmount());
  });

  it('anchors a joining reader’s two snapshot drafts into two rows that stay put', async () => {
    // The join of #920 and C107: `PhoneService.liveDraftSnapshot` hands a
    // socket the drafts its turns are already writing — one row per agent —
    // and each has to land as its OWN transcript entry that later deltas edit
    // in place. Both agents were addressed by one message, so both turns
    // carry that message's id: the request alone cannot tell the rows apart.
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

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'room-a', ...live } });
    await act(async () => {
      // The subscribe-time burst, in the order the snapshot serves it.
      emit({ type: 'draft', agentId: 'goosy', turnId: 'turn-x', text: 'goosy so far' });
      emit({ type: 'draft', agentId: 'terra', turnId: 'turn-x', text: 'terra so far' });
    });

    expect(
      current.liveOverlays.map((overlay) => [
        overlay.kind === 'draft' ? overlay.stableId : '',
        overlay.agentPubkey,
      ]),
    ).toEqual([
      ['live-turn:goosy:turn-x', 'goosy'],
      ['live-turn:terra:turn-x', 'terra'],
    ]);
    const anchors = current.liveOverlays.map((overlay) => overlay.createdAt);

    await act(async () => {
      emit({ type: 'draft', agentId: 'terra', turnId: 'turn-x', text: 'terra so far, and more' });
      emit({ type: 'draft', agentId: 'goosy', turnId: 'turn-x', text: 'goosy so far, and more' });
    });

    // Two rows still, in the same order, each carrying its own newer text:
    // neither agent took the other's row and neither stamp moved.
    expect(
      current.liveOverlays.map((overlay) => [
        overlay.agentPubkey,
        overlay.kind === 'draft'
          ? current.liveDraftStore.getReceived(`${overlay.agentPubkey}:${overlay.requestId}`)
          : '',
        overlay.createdAt,
      ]),
    ).toEqual([
      ['goosy', 'goosy so far, and more', anchors[0]],
      ['terra', 'terra so far, and more', anchors[1]],
    ]);
    await act(async () => renderer.unmount());
  });

  it('settles a retracted corner draft in place instead of blanking streamed chunks', async () => {
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

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: 'room-a', ...live } });
    await act(async () => {
      emit({ type: 'draft', agentId: 'agent-a', turnId: 'turn-1', text: 'I' });
      emit({ type: 'draft', agentId: 'agent-a', turnId: 'turn-1', text: 'I will update only X,' });
      emit({
        type: 'draft',
        agentId: 'agent-a',
        turnId: 'turn-1',
        text: 'I will update only X, then commit.',
      });
      // The final is about to land: the helper retracts the live lane first.
      emit({ type: 'retract', kind: 'draft', agentId: 'agent-a', turnId: 'turn-1' });
    });

    // The retract must NOT blank the streamed text — the settled draft row
    // stays visible while the server read catches up.
    expect(current.liveOverlays).toHaveLength(1);
    expect(current.liveOverlays[0]).toMatchObject({
      kind: 'draft',
      requestId: 'turn-1',
      closed: true,
    });
    expect(current.liveDraftStore.getReceived('agent-a:turn-1')).toBe(
      'I will update only X, then commit.',
    );

    // The durable final lands with the same request id and takes over the
    // row's slot: no gap, no duplicate bubble.
    const finalMessage = {
      id: 'b'.repeat(64),
      text: 'I will update only X, then commit. Done.',
      createdAt: 11,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Agent' },
      presentation: 'message' as const,
      requestId: 'turn-1',
    };
    await act(async () => {
      controls.responses[0]!.apply({ ...roomView('room-a'), messages: [finalMessage] });
      await Promise.resolve();
    });
    expect(visibleLiveOverlays(current.liveOverlays, current.roomSurface!.messages)).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('subscribes once to the opened Room even when watchFilters name a family', async () => {
    const familyFilters: RoomView['watchFilters'] = [
      {
        kinds: [9],
        '#h': [
          'workspace',
          'room-a',
          ...Array.from({ length: 58 }, (_, index) => `corner-${index}`),
        ],
      },
      {
        kinds: [30078],
        '#d': ['agent-draft:room-a', 'agent-thought:room-a', 'agent-presence:room-a'],
      },
    ];
    controls.cached = roomView('room-a', familyFilters);
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

    expect(current.roomSurface).toMatchObject({
      room: controls.cached.room,
      messages: controls.cached.messages,
    });
    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['room-a'] }]);
    const firstStop = controls.subscriptions[0]!.stop;

    await act(async () => {
      controls.responses[0]!.apply(roomView('room-a', [{ '#d': ['agent-a'] }]));
      await Promise.resolve();
    });
    expect(controls.subscriptions).toHaveLength(1);
    expect(firstStop).not.toHaveBeenCalled();
    expect(current.roomSurface?.watchFilters).toEqual([{ '#d': ['agent-a'] }]);
    await act(async () => renderer.unmount());
  });

  it('requests one reconciliation for a legacy live message', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    const event: NostrEvent = {
      id: 'f'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 10,
      kind: 9,
      tags: [
        ['h', 'room-a'],
        ['t', 'agent-message'],
      ],
      content: 'Delivered after the index catches up',
      sig: '0'.repeat(128),
    };
    await act(async () => controls.subscriptions[0]!.emit(event));

    await act(async () => renderer.unmount());
  });

  it('requests one reconciliation per legacy turn or lifecycle event', async () => {
    controls.cached = roomView('room-a');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    const turn = {
      id: '1'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: 10,
      kind: 9,
      tags: [
        ['h', 'room-a'],
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', '2'.repeat(64)],
        ['status', 'working'],
      ],
      content: '',
      sig: '0'.repeat(128),
    } satisfies NostrEvent;
    await act(async () => controls.subscriptions[0]!.emit(turn));

    const landed = {
      ...turn,
      id: '3'.repeat(64),
      tags: [
        ['h', 'room-a'],
        ['t', 'daemon-fact'],
        ['t', 'corner-branch-ended'],
        ['subchannel', 'corner-a'],
        ['outcome', 'landed'],
      ],
      content: 'Landed “Smoke lifecycle PR” into main.',
    } satisfies NostrEvent;
    await act(async () => controls.subscriptions[0]!.emit(landed));
    await act(async () => renderer.unmount());
  });

  it('covers a fresh replayed working receipt with the opening Corner GET', async () => {
    controls.replayEvents.push({
      id: '4'.repeat(64),
      pubkey: 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1_000),
      kind: 9,
      tags: [
        ['h', 'corner-a'],
        ['t', 'body-control'],
        ['t', 'agent-turn'],
        ['request', '5'.repeat(64)],
        ['status', 'working'],
      ],
      content: '',
      sig: '0'.repeat(128),
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'corner-a',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();

    // The replay marks the not-yet-started scheduler dirty. startAfter folds
    // that signal into its single opening read.
    await act(async () => renderer.unmount());
  });

  it('cancels stale identity work and replaces the whole watch on notification hydration', async () => {
    let resolveIdentity!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => (resolveIdentity = resolve));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-1',
          capture: () => undefined,
        }),
      );
    });
    await act(async () => renderer.unmount());
    resolveIdentity({ publicKey: 'viewer', secretKey: new Uint8Array(32) });
    await flushEffects();
    expect(controls.transportCount).toBe(0);

    controls.identityPromise = null;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-1',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    const firstResponse = controls.responses[0]!;
    await act(async () => {
      renderer.update(
        React.createElement(Harness, {
          channelId: 'room-a',
          notificationResponseId: 'notice-2',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    expect(controls.responses).toHaveLength(2);
    await act(async () => renderer.unmount());
  });

  it('fails a first-load timeout into the retry screen, and RETRY repaints', async () => {
    // The 18:47Z captain report: a hung connection left the Room on LOADING
    // forever. The bounded request now rejects, and an unpainted Room shows
    // the retryable error screen instead of an endless loader.
    controls.roomError = new RoomViewHttpError(0, 'timeout');
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

    await act(async () => controls.responses[0]!.error(controls.roomError));
    expect(current.roomSurface).toBeNull();
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toBe(
      'Couldn’t reach Beeline',
    );

    // RETRY re-runs the read; a responding server paints the Room normally.
    controls.roomError = null;
    controls.roomResponse = roomView('room-a');
    await act(async () => current.retryHydration());
    await flushEffects();
    expect(controls.responses).toHaveLength(2);
    await act(async () => {
      controls.responses[1]!.apply(await controls.responses[1]!.fetch());
    });
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(current.hydrationFailed).toBe(false);
    await act(async () => renderer.unmount());
  });

  it('keeps the cached page with the shared Retry error and clears private data on access loss', async () => {
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

    await act(async () => controls.responses[0]!.error(new TypeError('Network request failed')));
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toBe('Couldn’t reach Beeline');

    await act(async () => controls.responses[0]!.error(new RoomViewHttpError(403, 'forbidden')));
    expect(current.roomSurface).toBeNull();
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toBe('Couldn’t reach Beeline');
    await act(async () => renderer.unmount());
  });
});

describe('Room history follows live row changes', () => {
  const row = (id: string, createdAt: number, text = `row ${id}`): RoomViewMessage => ({
    id,
    text,
    createdAt,
    author: { pubkey: 'person-a', kind: 'human', name: 'Ada' },
    presentation: 'message',
  });
  // A full tail: the session's newest 30 rows.
  const tail = Array.from({ length: 30 }, (_, index) => row(`tail-${index}`, 100 + index));
  const old = row('old-row', 10, 'before');

  type Surface = {
    session: UseRoomSurfaceSessionResult;
    history: ReturnType<typeof useRoomMessageStore>;
    historyRows: readonly RoomViewMessage[];
    tailRows: readonly RoomViewMessage[];
  };

  // The chat screen's wiring: history rows read through the Room's message records.
  function HistoryHarness({ capture }: { capture(surface: Surface): void }) {
    const bindingsRef = React.useRef<RoomSurfaceSessionBindings>({
      resetTranscript: vi.fn(),
      restoreOutboxMessages: vi.fn(),
      dismissOptimisticMessage: vi.fn(),
      observeRoomSurface: vi.fn(),
    });
    const session = useRoomSurfaceSession({ channelId: 'room-a', bindingsRef });
    const history = useRoomMessageStore({
      roomId: 'room-a',
      tailMessages: session.roomSurface?.messages,
      roomClient: {
        history: async (): Promise<RoomHistoryView> => ({ roomId: 'room-a', messages: [old] }),
      },
      enabled: true,
      initialVisibleCount: 30,
    });
    // The same groups the chat screen passes: the tail and the history rows.
    const [tailRows, historyRows] = useRoomMessageRecords(session.messageRecordScope, 'room-a', [
      session.roomSurface?.messages ?? [],
      history.rows,
    ]);
    capture({ session, history, historyRows, tailRows });
    return React.createElement('room-surface');
  }

  async function openWithHistory() {
    controls.cached = { ...roomView('room-a'), messages: tail };
    let current!: Surface;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(HistoryHarness, { capture: (surface: Surface) => (current = surface) }),
      );
    });
    await flushEffects();
    await act(async () => current.history.loadOlder(30));
    await flushEffects();
    expect(current.historyRows.find((message) => message.id === 'old-row')?.text).toBe('before');
    return { current: () => current, renderer };
  }

  it('shows an edit to a row older than the newest 30', async () => {
    const { current, renderer } = await openWithHistory();
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: { ...old, text: 'after' },
        },
      }),
    );
    expect(current().historyRows.find((message) => message.id === 'old-row')?.text).toBe('after');
    expect(current().session.roomSurface?.messages.map((message) => message.id)).toEqual(
      tail.map((message) => message.id),
    );
    await act(async () => renderer.unmount());
  });

  it('keeps a delete on an older row once the server answers', async () => {
    const { current, renderer } = await openWithHistory();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...old, text: '', deleted: true }),
    );
    expect(current().historyRows.find((message) => message.id === 'old-row')?.deleted).toBe(true);
    await act(async () => renderer.unmount());
  });

  // A later unrelated delta re-renders every window with its old row objects.
  async function emitUnrelatedDelta(id: string) {
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'message-delta', roomId: 'room-a', message: row(id, 300) },
      }),
    );
  }
  const byId = (rows: readonly RoomViewMessage[], id: string) =>
    rows.find((message) => message.id === id);

  it('keeps a live edit on a tail row after the windows re-render', async () => {
    const { current, renderer } = await openWithHistory();
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: { ...tail[29]!, text: 'edited' },
        },
      }),
    );
    await emitUnrelatedDelta('later-1');
    await emitUnrelatedDelta('later-2');
    expect(byId(current().tailRows, 'tail-29')?.text).toBe('edited');
    await act(async () => renderer.unmount());
  });

  it('keeps a delete on an older row after the windows re-render', async () => {
    const { current, renderer } = await openWithHistory();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...old, text: '', deleted: true }),
    );
    await emitUnrelatedDelta('later-1');
    await emitUnrelatedDelta('later-2');
    expect(byId(current().historyRows, 'old-row')?.deleted).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('keeps the server bookmark on an older row after the windows re-render', async () => {
    const { current, renderer } = await openWithHistory();
    // The chat screen's bookmark settlement: the server value onto the record.
    await act(async () => {
      writeRoomBookmark(current().session.messageRecordScope, 'room-a', 'old-row', true);
      current().session.applyRoomMessageResult({
        ...roomMessageRecord(current().session.messageRecordScope, 'room-a', 'old-row')!,
        bookmarked: true,
      });
    });
    await emitUnrelatedDelta('later-1');
    await emitUnrelatedDelta('later-2');
    expect(byId(current().historyRows, 'old-row')?.bookmarked).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('writes a live delta to the Room disk cache', async () => {
    const { mobileSurfaceCache } = await import('@/buzz/surface-storage');
    vi.useFakeTimers();
    const { renderer } = await openWithHistory();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    const fresh = row('fresh-row', 200, 'new');
    await act(async () =>
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'message-delta', roomId: 'room-a', message: fresh },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const written = vi.mocked(mobileSurfaceCache.write).mock.calls.at(-1)?.[1] as RoomView;
    expect(written.messages.at(-1)?.id).toBe('fresh-row');
    await act(async () => renderer.unmount());
  });

  it('writes a mutation result to the Room disk cache', async () => {
    const { mobileSurfaceCache } = await import('@/buzz/surface-storage');
    vi.useFakeTimers();
    const { current, renderer } = await openWithHistory();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...tail[29]!, text: 'edited', version: 2 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const written = vi.mocked(mobileSurfaceCache.write).mock.calls.at(-1)?.[1] as RoomView;
    expect(written.messages.at(-1)?.text).toBe('edited');
    await act(async () => renderer.unmount());
  });

  it('ignores a delta frame older than the row it already shows', async () => {
    const { current, renderer } = await openWithHistory();
    const emit = (text: string, version: number) =>
      act(async () =>
        controls.subscriptions[0]!.emit({
          monolithLive: {
            type: 'message-delta',
            roomId: 'room-a',
            message: { ...tail[29]!, text },
            version,
          },
        }),
      );
    await emit('second edit', 3);
    await emit('first edit', 2);
    expect(byId(current().tailRows, 'tail-29')?.text).toBe('second edit');
    await act(async () => renderer.unmount());
  });
});

it('isolates transcript windows, outbox and late send completion when a route changes Room', async () => {
  let current!: {
    session: UseRoomSurfaceSessionResult;
    overlay: ReturnType<typeof import('@/buzz/room-send-frame').useRoomSendFrame>;
    history: ReturnType<typeof useRoomMessageStore>;
  };
  controls.scopeProbe = (session, overlay, history) => {
    current = { session, overlay, history };
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzChat));
  });
  await flushEffects();
  const source = current;
  const view = roomView('room-a');
  const row = {
    id: 'source-message',
    text: 'source only',
    createdAt: 1,
    author: view.viewer.identity,
    presentation: 'message',
  } as RoomViewMessage;
  await act(async () => controls.responses[0]!.apply({ ...view, messages: [row] }));
  await act(async () =>
    current.overlay.append([{ id: 'pending', text: 'pending source' } as ChatDisplayMessage]),
  );
  const visible = () =>
    renderer.root.findAllByType('probe-row').map((node: any) => node.props.children);
  expect(visible()).toEqual(['source only', 'pending source']);
  const sourceOutbox = current.session.outbox.current();
  controls.routeChannelId = 'room-b';
  controls.cached = null;
  await act(async () => renderer.update(React.createElement(BuzzChat)));
  // Even before the destination responds, it must not draw the source tail.
  expect(visible()).toEqual([]);
  await flushEffects();
  await act(async () => controls.responses.at(-1)!.apply(roomView('room-b')));
  expect(visible()).toEqual([]);
  expect(current.session.outbox.current()).not.toBe(sourceOutbox);
  await act(async () => {
    source.overlay.append([{ id: 'late-preview', text: 'late source' } as ChatDisplayMessage]);
    source.session.applyRoomMessageResult({ ...row, id: 'late-ack', text: 'late acknowledgement' });
  });
  expect(visible()).toEqual([]);
  expect(current.session.roomSurface?.room.id).toBe('room-b');
  expect(current.session.roomSurface?.messages).toEqual([]);
  await act(async () => renderer.unmount());
});
