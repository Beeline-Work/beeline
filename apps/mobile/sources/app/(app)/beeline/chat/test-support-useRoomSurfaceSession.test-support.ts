import * as React from 'react';
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));

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
  outboxListeners: new Set<() => void>(),
  outboxStates: new Map<string, { kind: 'sending' | 'offline' | 'refused'; text: string }>(),
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
export { controls };


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
    subscribe: (listener: () => void) => {
      controls.outboxListeners.add(listener);
      return () => controls.outboxListeners.delete(listener);
    },
    state: (id: string) => controls.outboxStates.get(id),
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


const originalConsoleError = console.error;


export function roomView(id: string, filters: RoomView['watchFilters'] = [{ '#h': [id] }]): RoomView {
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


export function Harness({
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


export function stubFrameScheduler(): {
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


export async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}


export async function flushEffects() {
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
  controls.outboxListeners.clear();
  controls.outboxStates.clear();
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
type Surface = {
    session: UseRoomSurfaceSessionResult;
    history: ReturnType<typeof useRoomMessageStore>;
    historyRows: readonly RoomViewMessage[];
    tailRows: readonly RoomViewMessage[];
  };
export function fixtureScope1() {

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
return {
chatList,
openRoom,
};
}
export function fixtureScope3() {

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
return {
row,
tail,
old,
HistoryHarness,
openWithHistory,
emitUnrelatedDelta,
byId,
};
}
