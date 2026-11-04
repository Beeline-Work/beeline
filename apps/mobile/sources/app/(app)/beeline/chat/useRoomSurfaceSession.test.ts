import * as React from 'react';
import { readFileSync } from 'node:fs';
import { SurfaceRegistry } from '@/buzz/surface-registry';
import { roomTransitionWork } from '@/buzz/room-transition-work';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListView, NostrEvent, RoomView } from '@beeline/buzz-client';
import { SurfaceResponseCache, visibleLiveOverlays } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';
import { mobileSurfaceCache, createRoomOutbox } from '@/buzz/surface-storage';
import { loadBuzzIdentity, loadBuzzViewerPubkey } from '@/auth/buzz-identity-storage';

import { resetClientState } from '@/sync/client-reset';

const mountedTrees = new Set<ReactTestRenderer>();
function create(...args: Parameters<typeof createRenderer>): ReactTestRenderer {
  const tree = createRenderer(...args); mountedTrees.add(tree); return tree;
}
afterEach(async () => {
  await act(async () => { for (const tree of mountedTrees) tree.unmount(); });
  mountedTrees.clear();
});

type TestSurfaceEvent = NostrEvent | MonolithSurfaceEvent;

// Canonical lane fixtures exercise the Room UI. Wire sequencing and persistence
// are covered by the router owner integration suites.
vi.mock('@/sync/transport/live-connection', () => ({ reconnectNow: () => { controls.explicitReconnects += 1; } }));
vi.mock('@/buzz/router-family', () => ({ useRouterFamily: () => controls.routerMode, holdRouterConnection: () => () => {} }));
vi.mock('@/buzz/router-chat-list', () => ({ acquireRoutedChatList: (_key: unknown, _consumer: unknown, legacy: () => unknown) => legacy() }));
vi.mock('@/buzz/router-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/buzz/router-owner')>();
  return { ...actual,
  routerFamilyMode: () => controls.routerMode,
  acquireRouterLane: (_input: Parameters<typeof actual.acquireRouterLane>[0], _visible: () => boolean, changed: () => void) => {
    if (controls.realRouter) return actual.acquireRouterLane(_input, _visible, changed);
    const lane = {
      fetch: async () => { controls.roomReads++; return controls.roomResponse!; },
      apply: (view: RoomView) => { controls.routerValue = view; changed(); },
      error: (error: unknown) => { controls.routerError = String(error); changed(); },
      disposed: false, expectations: [], forceCalls: 0, followUpCalls: 0,
      refreshNowCalls: 0, signalCalls: 0, started: true,
    };
    controls.lanes.push(lane);
    return { current: () => ({ state: controls.routerError ? 'PARKED' : (controls.routerValue ?? controls.initialView) ? 'LIVE' : 'ABSENT',
      value: controls.routerValue ?? controls.initialView, cut: null, error: controls.routerError }), release: () => { lane.disposed = true; },
      subscribe: () => () => {}, refreshVisibility: () => {} };
  },
  routerLaneSnapshot: () => ({ state: 'ABSENT', value: null, cut: null, error: null }),
  retryRouterLane: () => { controls.retryCalls++; }, routerOwnerListPanel: () => {},
}; });

const controls = vi.hoisted(() => ({
  focused: true,
  realRouter: false,
  routerMode: 'router' as 'pending' | 'router',
  routerValue: null as RoomView | null,
  routerError: null as string | null,
  navigationListeners: new Map<string, Set<() => void>>(),
  interactionTasks: new Set<() => void>(),
  focusListeners: new Set<() => void>(),
  surfaceRenders: 0,
  initialView: null as RoomView | null,
  hotViewer: false,
  cacheListeners: new Set<() => void>(),
  viewerRead: null as Promise<string | null> | null,
  lanes: [] as Array<{
    fetch(): Promise<RoomView>;
    apply(view: RoomView): void;
    error(error: unknown): void;
    disposed: boolean;
    expectations: Array<(view: RoomView) => boolean>;
    forceCalls: number;
    followUpCalls: number;
    refreshNowCalls: number;
    signalCalls: number;
    started: boolean;
  }>,
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
  retryCalls: 0,
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
  useLocalSearchParams: () => ({ channelId: '11111111-1111-4111-8111-111111111111' }),
}));
const navigation = {
  isFocused: () => controls.focused,
  addListener: (name: string, listener: () => void) => {
    const listeners = controls.navigationListeners.get(name) ?? new Set<() => void>();
    listeners.add(listener);
    controls.navigationListeners.set(name, listeners);
    return () => { listeners.delete(listener); };
  },
};
vi.mock('@/buzz/room-transition-work', async () => {
  const { TransitionWork } = await import('@/buzz/transition-work');
  return { roomTransitionWork: new TransitionWork((work) => {
    controls.interactionTasks.add(work);
    return () => { controls.interactionTasks.delete(work); };
  }) };
});
vi.mock('@react-navigation/native', () => ({
  useNavigation: () => navigation,
  useIsFocused: () => React.useSyncExternalStore(
    (listener) => { controls.focusListeners.add(listener); return () => { controls.focusListeners.delete(listener); }; },
    () => controls.focused,
  ),
}));
vi.mock('@/components/buzz/RoomOpenTraceOverlay', () => ({ RoomOpenTraceOverlay: () => null }));
vi.mock('./_chat-surface', () => ({
  BuzzChatSurface: () => {
    controls.surfaceRenders++;
    return React.createElement('room-root');
  },
}));

vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(
    () =>
      controls.identityPromise ??
      Promise.resolve({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
  ),
  loadBuzzViewerPubkey: vi.fn(async () => controls.viewerRead ?? controls.viewerPubkey),
  peekBuzzViewerContext: () => controls.hotViewer ? { relayUrl: 'https://relay.test', viewerPubkey: controls.viewerPubkey! } : null,
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
}));

vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
}));

vi.mock('@/buzz/surface-storage', () => ({
  routerAuthorityStorageReady: () => true,
  routerCommandStorageReady: () => true,
  routerLaneStorage: () => ({ write: async () => {}, fence: async () => {}, floor: async () => {},
    remove: async () => {}, subscribeFences: () => () => {}, subscribeFloors: () => () => {} }),
  mobileSurfaceCache: {
    peek: vi.fn((path: string) => path.startsWith('/room/') ? controls.initialView : null),
    read: vi.fn(async () => controls.initialView),
    write: vi.fn(async () => undefined),
    publish: vi.fn((_address: unknown, view: RoomView) => { controls.initialView = view; return view; }),
    subscribe: vi.fn((_address: unknown, listener: () => void) => {
      controls.cacheListeners.add(listener);
      return () => { controls.cacheListeners.delete(listener); };
    }),
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  surfaceAddress: vi.fn((_relay: string, _viewer: string, path: string) => path),
  createRoomOutbox: vi.fn(() => ({
    restore: vi.fn(async () => { await controls.outboxRestore; }),
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
      async room() {
        controls.roomReads += 1;
        if (controls.roomError) return Promise.reject(controls.roomError);
        if (controls.roomResponse) return controls.roomResponse;
        return new Promise<RoomView>(() => undefined);
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
import { abandonRoomDraw, beginRoomDraw, finishRoomDraw, observeVisibleRoomRows, waitForRoomDraw, roomDrawGeneration } from '@/buzz/room-draw-barrier';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { useRoomMessageStore } from '@/buzz/room-message-store';
import { roomMessageRecord, useRoomMessageRecords, writeRoomBookmark } from '@/buzz/room-message-records';
import type { RoomHistoryView, RoomViewMessage } from '@beeline/buzz-client';
import {
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
  capture(result);
  return React.createElement('room-surface', {
    roomId: result.roomSurface?.room.id,
    error: result.hydrationError,
  }, ...(result.roomSurface?.messages ?? []).map((message) => React.createElement('message-row', { key: message.id }, message.text)));
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
  controls.realRouter = false;
  resetClientState();
  controls.routerMode = 'router';
  controls.routerValue = null; controls.routerError = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  abandonRoomDraw(roomDrawGeneration());
  roomTransitionWork.flush();
  controls.focused = true;
  controls.focusListeners.clear();
  controls.navigationListeners.clear();
  controls.interactionTasks.clear();
  controls.surfaceRenders = 0;
  controls.initialView = null;
  controls.hotViewer = false;
  controls.cacheListeners.clear();
  controls.viewerRead = null;
  controls.lanes.length = 0;
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
  controls.roomReads = 0; controls.retryCalls = 0;
  controls.roomError = null;
  controls.liveList = null;
  controls.liveListKeys.length = 0;
  controls.outboxFail.mockClear();
  controls.outboxGet.mockClear();
  vi.clearAllMocks();
});

it('uses the existing pending Room Retry for one transport attempt without manufacturing a read or focus', async () => {
  controls.routerMode = 'pending';
  let current!: UseRoomSurfaceSessionResult;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(React.createElement(Harness, {
    channelId: '11111111-1111-4111-8111-111111111111', capture: (value: UseRoomSurfaceSessionResult) => { current = value; },
  })); });
  await act(async () => current.retryHydration());
  expect(controls.explicitReconnects).toBe(1);
  expect(controls.roomReads).toBe(0);
  expect(controls.lanes).toHaveLength(0);
  await act(async () => renderer.unmount());
});

it('hides retained negotiated Room data synchronously when connection capability returns to pending', async () => {
  const roomId = '11111111-1111-4111-8111-111111111111';
  controls.routerMode = 'router';
  controls.routerValue = roomView(roomId);
  let current!: UseRoomSurfaceSessionResult;
  const paints: Array<RoomView | null> = [];
  let renderer: ReactTestRenderer | undefined;
  const props = { channelId: roomId, capture: (value: UseRoomSurfaceSessionResult) => { current = value; paints.push(value.roomSurface); } };
  try {
    await act(async () => { renderer = create(React.createElement(Harness, props)); });
    await flushEffects();
    expect(current.roomSurface?.room.id).toBe(roomId);
    paints.length = 0;
    controls.routerMode = 'pending';
    await act(async () => renderer!.update(React.createElement(Harness, props)));
    expect(paints.length).toBeGreaterThan(0);
    expect(paints.every(value => value === null)).toBe(true);
    expect(current.liveOverlays).toEqual([]);
    expect(current.heartbeatPresences).toEqual({});
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
  }
});

describe('reopening a dismissed Room', () => {
  function chatList(closed: boolean): ChatListView {
    return {
      workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
      chats: [{ room: roomView('11111111-1111-4111-8111-111111111111').room, unread: false, ...(closed ? { closed: true } : {}) }],
      viewer: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      truncated: false,
      watchFilters: [{ '#h': ['11111111-1111-4111-8111-111111111111'] }],
    };
  }

  async function openRoom(): Promise<void> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Harness, { channelId: '11111111-1111-4111-8111-111111111111', capture: () => undefined }));
    });
    await flushEffects();
    await act(async () => controls.lanes[0]!.apply(roomView('11111111-1111-4111-8111-111111111111')));
    await flushEffects();
    await act(async () => renderer.unmount());
  }

  it('reopens a Room the live Room list shows dismissed', async () => {
    controls.liveList = chatList(true);
    await openRoom();
    expect(controls.liveListKeys).toEqual([
      { relayUrl: 'https://relay.test', viewerPubkey: 'viewer', workspaceId: 'workspace' },
    ]);
    expect(controls.reopenChat).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  it('lets the server decide when no live Room list is held', async () => {
    controls.liveList = null;
    await openRoom();
    expect(controls.reopenChat).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  });

  it('skips the reopen call for a Room the live list shows open', async () => {
    controls.liveList = chatList(false);
    await openRoom();
    expect(controls.reopenChat).not.toHaveBeenCalled();
  });
});

describe('useRoomSurfaceSession', () => {
  it('keeps the heavy Room surface free of its own render-triggering focus subscription', () => {
    const source = readFileSync(new URL('./_chat-surface.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\buseIsFocused\s*\(/);
  });

  it('releases Room conversion and saves only after the actual route transition ends', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(BuzzChat)); });
    await flushEffects();
    const normalize = vi.fn((value: unknown) => value);
    const set = vi.fn(async () => {});
    const guard = vi.fn((value: unknown): value is { count: number } =>
      typeof value === 'object' && value !== null && 'count' in value);
    const registry = new SurfaceRegistry(new SurfaceResponseCache({
      get: async () => null, set, remove: async () => {},
    }), normalize, undefined, (key, work) => roomTransitionWork.enqueue(key, work));
    const emit = (name: string) => controls.navigationListeners.get(name)?.forEach(listener => listener());
    emit('transitionStart');
    const saved = registry.write({ relayOrigin: 'https://relay.test', viewerPubkey: 'viewer', endpoint: '/room/busy' }, { count: 1 }, guard);
    controls.interactionTasks.forEach(work => work());
    expect(normalize).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    emit('transitionEnd');
    expect(set).not.toHaveBeenCalled();
    const work = [...controls.interactionTasks];
    controls.interactionTasks.clear();
    work.forEach(run => run());
    await saved;
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });

  it('does not render the Room surface boundary when pushing and popping a corner', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(BuzzChat)); });
    await flushEffects();
    const before = controls.surfaceRenders;
    await act(async () => {
      controls.focused = false;
      controls.focusListeners.forEach(listener => listener());
    });
    await act(async () => {
      controls.focused = true;
      controls.focusListeners.forEach(listener => listener());
    });
    await flushEffects();
    expect(controls.surfaceRenders - before).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('reuses the Room state and transcript when a corner is pushed and popped', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    const reset = vi.fn();
    const render = (isFocused: boolean) => React.createElement(Harness, {
      channelId: '11111111-1111-4111-8111-111111111111', isFocused, onResetTranscript: reset,
      capture: (result: UseRoomSurfaceSessionResult) => { current = result; },
    });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(render(true)); });
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

  it('does not save the Room during a corner push or pop', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    const render = (isFocused: boolean) => React.createElement(Harness, {
      channelId: '11111111-1111-4111-8111-111111111111', isFocused, capture: () => undefined,
    });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(render(true)); });
    await flushEffects();
    vi.mocked(mobileSurfaceCache.write).mockClear();
    // A canonical message arrival queues a Room save; navigation must not flush it.
    const subscription = controls.subscriptions.at(-1)!;
    await act(async () => subscription.emit({ monolithLive: {
      type: 'message-delta', roomId: '11111111-1111-4111-8111-111111111111', message: {
        id: 'during-transition', roomId: '11111111-1111-4111-8111-111111111111', text: 'new arrival',
        createdAt: 100, author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
        tags: [], attachments: [], reactions: [],
      },
    } } as MonolithSurfaceEvent));
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
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    const render = (isFocused: boolean) =>
      React.createElement(Harness, {
        channelId: '11111111-1111-4111-8111-111111111111',
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
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const opening = roomView('11111111-1111-4111-8111-111111111111');
    await act(async () => {
      controls.lanes[0]!.apply({
        ...opening,
        viewer: {
          ...opening.viewer,
          readCursor: { messageId: 'read', firstUnreadMessageId: 'first-new' },
        },
      });
    });
    expect(current.firstUnreadMessageId).toBe('first-new');

    await act(async () => {
      controls.lanes[0]!.apply({
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
      ...roomView('22222222-2222-4222-8222-222222222222'),
      room: { ...roomView('22222222-2222-4222-8222-222222222222').room, parentId: '11111111-1111-4111-8111-111111111111' },
      viewer: {
        ...roomView('22222222-2222-4222-8222-222222222222').viewer,
        readCursor: {
          messageId: 'read',
          firstUnreadMessageId: 'first-new',
          unreadCount: 15,
        },
      },
    };
    controls.initialView = corner;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '22222222-2222-4222-8222-222222222222',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    await act(async () => controls.lanes[0]!.apply(corner));
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
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
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
            roomId: '11111111-1111-4111-8111-111111111111',
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
    controls.initialView = {
      ...roomView('11111111-1111-4111-8111-111111111111'),
      members: [
        {
          identity: { pubkey: 'agent-a', kind: 'agent', name: 'Monarch' },
          role: 'member',
          presence: { status: 'offline', observedAt: observedAt - 10 },
        },
      ],
    };
    controls.routerValue = controls.initialView;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    expect(current.heartbeatPresences['agent-a']?.status).toBe('offline');
    expect(current.presenceResolved).toBe(true);

    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' } });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' } });
    });

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'presence',
          roomId: '11111111-1111-4111-8111-111111111111',
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
      controls.lanes[0]!.apply({
        ...controls.initialView!,
        members: [
          {
            ...controls.initialView!.members[0]!,
            presence: { status: 'online', observedAt },
          },
        ],
      }),
    );
    expect(current.presenceResolved).toBe(true);
    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: {
        type: 'presence', roomId: '11111111-1111-4111-8111-111111111111', agentId: 'agent-a',
        status: 'offline', observedAt: observedAt + 1,
      } });
    });
    expect(current.heartbeatPresences['agent-a']?.status).toBe('offline');
    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: {
        type: 'presence', roomId: '11111111-1111-4111-8111-111111111111', agentId: 'agent-a',
        status: 'online', observedAt: observedAt + 2,
      } });
    });
    expect(current.heartbeatPresences['agent-a']?.status).toBe('online');
    await act(async () => renderer.unmount());
  });

  it('paints a canonical send receipt without a timer or follow-up Room read', async () => {
    vi.useFakeTimers();
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    controls.routerValue = controls.initialView;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();
    const scheduler = controls.lanes[0]!;

    // Its delta lands first: nothing is read.
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'message-delta',
          roomId: '11111111-1111-4111-8111-111111111111',
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
    expect(scheduler.signalCalls).toBe(0);
    expect(scheduler.expectations).toEqual([]);

    // The write receipt itself settles a send whose live delta was missed.
    await act(async () => current.applyRoomMessageResult({
      id: 'accepted-message',
      text: 'accepted',
      createdAt: 2,
      author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      presentation: 'message',
    }));
    expect(current.roomSurface?.messages.some((message) => message.id === 'accepted-message')).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(scheduler.signalCalls).toBe(0);
    expect(controls.outboxFail).not.toHaveBeenCalled();
    expect(current.outbox.failedIds).not.toContain('accepted-message');
    await act(async () => renderer.unmount());
    vi.useRealTimers();
  });

  it('schedules no Room read from the socket while the app is backgrounded', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: '11111111-1111-4111-8111-111111111111', capture: () => undefined }),
      );
    });
    await flushEffects();

    controls.appState = 'background';
    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: { type: 'invalidate', roomId: '11111111-1111-4111-8111-111111111111', reason: 'activity' },
      });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' } });
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' } });
    });
    expect(controls.lanes[0]!.signalCalls).toBe(0);
    expect(controls.lanes[0]!.forceCalls).toBe(0);

    controls.appState = 'active';
    await act(async () => {
      controls.subscriptions[0]!.emit({ monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' } });
    });
    expect(controls.roomReads).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('Corner: a direct open keeps optional requests behind the canonical response and its paint', async () => {
    beginRoomDraw('11111111-1111-4111-8111-111111111111');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, {
      channelId: '11111111-1111-4111-8111-111111111111', capture: () => undefined,
    })); });
    await flushEffects();
    const sent = vi.fn();
    const waiting = waitForRoomDraw()?.then(sent);
    observeVisibleRoomRows('11111111-1111-4111-8111-111111111111', ['old-row']);
    finishRoomDraw('old-row', '11111111-1111-4111-8111-111111111111');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(sent).not.toHaveBeenCalled();
    const fresh = { ...roomView('11111111-1111-4111-8111-111111111111'), messages: [{ id: 'fresh-row', createdAt: 2, text: 'new corner contents', presentation: 'message',
      author: { pubkey: 'viewer', kind: 'human' as const, name: 'Viewer' } }] };
    await act(async () => controls.lanes[0]!.apply(fresh));
    observeVisibleRoomRows('11111111-1111-4111-8111-111111111111', ['fresh-row']);
    finishRoomDraw('fresh-row', '11111111-1111-4111-8111-111111111111');
    await waiting;
    expect(sent).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it('closes a watch still waiting on its subscribe when the reader leaves', async () => {
    vi.useFakeTimers();
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, { channelId: '11111111-1111-4111-8111-111111111111', capture: () => undefined }),
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

  it('keeps a child corner’s monolith draft and thought lanes out of its parent Room', async () => {
    const parent = roomView('11111111-1111-4111-8111-111111111111', [{ '#h': ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] }]);
    controls.initialView = {
      ...parent,
      members: [{ identity: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' }, role: 'member' }],
    };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    await act(async () => {
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'draft',
          roomId: '22222222-2222-4222-8222-222222222222',
          agentId: 'agent-a',
          turnId: 'corner-turn',
          text: 'This narration belongs only in the corner.',
        },
      });
      controls.subscriptions[0]!.emit({
        monolithLive: {
          type: 'thought',
          roomId: '22222222-2222-4222-8222-222222222222',
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
      { kinds: [9], '#h': ['workspace', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'] },
      { kinds: [30078], '#d': ['agent-draft:22222222-2222-4222-8222-222222222222', 'agent-thought:22222222-2222-4222-8222-222222222222'] },
    ];
    controls.initialView = { ...roomView('22222222-2222-4222-8222-222222222222', cornerFilters), parent: roomView('11111111-1111-4111-8111-111111111111').room };
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '22222222-2222-4222-8222-222222222222',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    // The corner's own id has to reach the live subscription, or nothing the
    // turn writes can ever be delivered to the reader sitting in it. Family
    // ids in watchFilters must not become extra subscriptions.
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['22222222-2222-4222-8222-222222222222'] }]);

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: '22222222-2222-4222-8222-222222222222', ...live } });
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
      controls.lanes[0]!.apply({
        ...roomView('22222222-2222-4222-8222-222222222222', cornerFilters),
        parent: roomView('11111111-1111-4111-8111-111111111111').room,
        messages: [reply],
      });
    });
    expect(visibleLiveOverlays(current.liveOverlays, [reply])).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('keeps cumulative draft arrivals out of Room React state after opening the live row', async () => {
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    let roomRenders = 0;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
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
          roomId: '11111111-1111-4111-8111-111111111111',
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
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: '11111111-1111-4111-8111-111111111111', ...live } });
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
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111');
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    const emit = (live: Record<string, unknown>) =>
      controls.subscriptions[0]!.emit({ monolithLive: { roomId: '11111111-1111-4111-8111-111111111111', ...live } });
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
      controls.lanes[0]!.apply({ ...roomView('11111111-1111-4111-8111-111111111111'), messages: [finalMessage] });
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
          '11111111-1111-4111-8111-111111111111',
          ...Array.from({ length: 58 }, (_, index) => `corner-${index}`),
        ],
      },
      {
        kinds: [30078],
        '#d': ['agent-draft:11111111-1111-4111-8111-111111111111', 'agent-thought:11111111-1111-4111-8111-111111111111', 'agent-presence:11111111-1111-4111-8111-111111111111'],
      },
    ];
    controls.initialView = roomView('11111111-1111-4111-8111-111111111111', familyFilters);
    controls.routerValue = controls.initialView;
    let current!: UseRoomSurfaceSessionResult;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          capture: (result: UseRoomSurfaceSessionResult) => (current = result),
        }),
      );
    });
    await flushEffects();

    expect(current.roomSurface).toBe(controls.initialView);
    expect(controls.subscriptions).toHaveLength(1);
    expect(controls.subscriptions[0]!.filters).toEqual([{ '#h': ['11111111-1111-4111-8111-111111111111'] }]);
    const firstStop = controls.subscriptions[0]!.stop;

    await act(async () => {
      controls.lanes[0]!.apply(roomView('11111111-1111-4111-8111-111111111111', [{ '#d': ['agent-a'] }]));
      await Promise.resolve();
    });
    expect(controls.subscriptions).toHaveLength(1);
    expect(firstStop).not.toHaveBeenCalled();
    expect(current.roomSurface?.watchFilters).toEqual([{ '#d': ['agent-a'] }]);
    await act(async () => renderer.unmount());
  });

  it('cancels stale identity work and replaces the whole watch on notification hydration', async () => {
    let resolveIdentity!: (identity: { publicKey: string; secretKey: Uint8Array }) => void;
    controls.identityPromise = new Promise((resolve) => (resolveIdentity = resolve));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
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
          channelId: '11111111-1111-4111-8111-111111111111',
          notificationResponseId: 'notice-1',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    const firstScheduler = controls.lanes[0]!;
    await act(async () => {
      renderer.update(
        React.createElement(Harness, {
          channelId: '11111111-1111-4111-8111-111111111111',
          notificationResponseId: 'notice-2',
          capture: () => undefined,
        }),
      );
    });
    await flushEffects();
    expect(firstScheduler.disposed).toBe(true);
    expect(controls.lanes).toHaveLength(2);
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
    const session = useRoomSurfaceSession({ channelId: '11111111-1111-4111-8111-111111111111', bindingsRef });
    const history = useRoomMessageStore({
      roomId: '11111111-1111-4111-8111-111111111111',
      tailMessages: session.roomSurface?.messages,
      roomClient: {
        history: async (): Promise<RoomHistoryView> => ({ roomId: '11111111-1111-4111-8111-111111111111', messages: [old] }),
      },
      enabled: true,
      initialVisibleCount: 30,
    });
    // The same groups the chat screen passes: the tail and the history rows.
    const [tailRows, historyRows] = useRoomMessageRecords(session.messageRecordScope, '11111111-1111-4111-8111-111111111111', [
      session.roomSurface?.messages ?? [],
      history.rows,
    ]);
    capture({ session, history, historyRows, tailRows });
    return React.createElement('room-surface');
  }

  async function openWithHistory() {
    controls.initialView = { ...roomView('11111111-1111-4111-8111-111111111111'), messages: tail };
    controls.routerValue = controls.initialView;
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

  it('keeps a delete on an older row once the server answers', async () => {
    const { current, renderer } = await openWithHistory();
    await act(async () =>
      current().session.applyRoomMessageResult({ ...old, text: '', deleted: true }),
    );
    expect(current().historyRows.find((message) => message.id === 'old-row')?.deleted).toBe(true);
    await act(async () => renderer.unmount());
  });

  // A later canonical head re-renders the windows with their retained history rows.
  async function emitUnrelatedDelta(id: string) {
    await act(async () => controls.lanes[0]!.apply({
      ...controls.routerValue!, messages: [...tail, row(id, 300)],
    }));
  }
  const byId = (rows: readonly RoomViewMessage[], id: string) =>
    rows.find((message) => message.id === id);

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
      writeRoomBookmark(current().session.messageRecordScope, '11111111-1111-4111-8111-111111111111', 'old-row', true);
      current().session.applyRoomMessageResult({
        ...roomMessageRecord(current().session.messageRecordScope, '11111111-1111-4111-8111-111111111111', 'old-row')!,
        bookmarked: true,
      });
    });
    await emitUnrelatedDelta('later-1');
    await emitUnrelatedDelta('later-2');
    expect(byId(current().historyRows, 'old-row')?.bookmarked).toBe(true);
    await act(async () => renderer.unmount());
  });
});

describe('canonical Room updates', () => {
  const roomId = '11111111-1111-4111-8111-111111111111';
  async function open(initial: RoomView | null = roomView(roomId)) {
    controls.routerValue = initial;
    let current!: UseRoomSurfaceSessionResult;
    await act(async () => { create(React.createElement(Harness, { channelId: roomId,
      capture: value => { current = value; } })); });
    await flushEffects();
    return () => current;
  }

  it('paints committed turns, queued commands and replies from the same canonical head', async () => {
    const current = await open();
    const message = { id: 'reply', text: 'Done', createdAt: 2,
      author: { pubkey: 'agent-a', kind: 'agent' as const, name: 'Agent' }, presentation: 'message' as const };
    const view = { ...roomView(roomId), messages: [message],
      latestAgentTurns: [{ agentPubkey: 'agent-a', requestId: 'request-a', status: 'complete' as const, createdAt: 2 }],
      pendingAgentCommands: [{ requestId: 'next', agentPubkey: 'agent-a', createdAt: 3 }] };
    await act(async () => controls.lanes[0]!.apply(view));
    expect(current().roomSurface?.messages).toEqual([message]);
    expect(current().roomSurface?.latestAgentTurns).toEqual(view.latestAgentTurns);
    expect(current().roomSurface?.pendingAgentCommands).toEqual(view.pendingAgentCommands);
    await act(async () => controls.lanes[0]!.apply(view));
    expect(current().roomSurface?.messages).toHaveLength(1);
    expect(controls.roomReads).toBe(0);
    expect(mobileSurfaceCache.read).not.toHaveBeenCalled();
    expect(mobileSurfaceCache.write).not.toHaveBeenCalled();
  });

  it('ignores legacy durable hints while retaining the canonical view', async () => {
    const current = await open(), before = current().roomSurface;
    await act(async () => {
      for (const reason of ['phone-write', 'postgres:messages', 'postgres:agent_turns'])
        controls.subscriptions[0]!.emit({ monolithLive: { type: 'invalidate', roomId, reason } });
    });
    expect(current().roomSurface).toBe(before);
    expect(controls.roomReads).toBe(0);
  });

  it('shows the parked error and retries through the existing lane', async () => {
    const current = await open(null);
    await act(async () => controls.lanes[0]!.error('The server did not respond. Check your connection and retry.'));
    expect(current().roomSurface).toBeNull();
    expect(current().hydrationFailed).toBe(true);
    expect(current().hydrationError).toBe('The server did not respond. Check your connection and retry.');
    await act(async () => current().retryHydration());
    expect(controls.retryCalls).toBe(1);
    expect(controls.lanes).toHaveLength(1);
    await act(async () => { controls.routerError = null; controls.lanes[0]!.apply(roomView(roomId)); });
    expect(current().roomSurface?.room.id).toBe(roomId);
    expect(current().hydrationFailed).toBe(false);
    expect(controls.roomReads).toBe(0);
  });
});


describe('Room session with the real canonical owner', () => {
  it('keeps a sent row after unrelated stream progress and its canonical push', async () => {
    const { routerOwnerNavigation, routerOwnerNegotiated, routerOwnerReceive } = await import('@/buzz/router-owner');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const { bytesToHex, utf8ToBytes } = await import('@noble/hashes/utils.js');
    const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
    controls.realRouter = true;
    const roomId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = '22222222-2222-4222-8222-222222222222';
    const initial = { ...roomView(roomId), room: { ...roomView(roomId).room, workspaceId }, repositoryResolution: 'none' as const };
    const scopes = [{ authorityScope: `reader:viewer:workspace:${workspaceId}`, epoch: '1' },
      { authorityScope: `room:${roomId}`, epoch: '1' }];
    const authority = { scopes, digest: hash(scopes) };
    const cut = (through: number) => ({ stream: `workspace:${workspaceId}`, epoch: 'stream', through, protocol: 1 as const });
    const atomicGroup = `room-head:${roomId}:viewer`;
    const execute = vi.fn(async () => ({ kind: 'snapshot' as const, family: 'room-head' as const, scope: roomId,
      value: initial, authority, atomicGroup, cut: cut(51) }));
    routerOwnerNavigation({ routes: [{ key: 'room', name: 'beeline/chat/[channelId]', params: { channelId: roomId, communityId: workspaceId } }] });
    await routerOwnerNegotiated({ generation: 1, families: ['room-head'], authorityFencesV1: true,
      roomHeadContinuityV1: true, execute });
    let current!: UseRoomSurfaceSessionResult;
    let tree!: ReactTestRenderer;
    await act(async () => { tree = create(React.createElement(Harness, { channelId: roomId,
      capture: value => { current = value; } })); });
    await flushEffects();
    expect(current.roomSurface?.messages).toEqual([]);
    const push = async (from: number, to: number, facts: unknown[]) => {
      const frame = { batchId: `batch-${to}`, from: cut(from), to: cut(to), partCount: 1, contentDigest: hash(facts) };
      await act(async () => {
        routerOwnerReceive({ ...frame, kind: 'push-part', partIndex: 0, facts });
        routerOwnerReceive({ ...frame, kind: 'push-commit' });
        for (let i = 0; i < 100; i++) await Promise.resolve();
      });
    };
    await push(51, 52, []);
    const message = { id: '8d041263f5fc6a3e6c94fd8383a3aa62c710af505797a3b6494cf81fcaff2523',
      text: 'router90-send-repro', createdAt: 1793783245, author: initial.viewer.identity, presentation: 'message' as const };
    await act(async () => current.applyRoomMessageResult(message));
    expect(current.roomSurface?.messages.map(row => row.id)).toEqual([message.id]);
    const committed = { ...initial, messages: [message], viewer: { ...initial.viewer,
      readCursor: { messageId: message.id, firstUnreadMessageId: null, unreadCount: 0 } } };
    await push(52, 54, [{ atomicGroup, authority, payload: { kind: 'scope-replace', family: 'room-head', scope: roomId, value: committed } }]);
    expect(current.roomSurface).toEqual(committed);
    expect(tree.root.findAllByType('message-row').map((node: any) => node.props.children)).toEqual([message.text]);
    const outbox = vi.mocked(createRoomOutbox).mock.results.at(-1)!.value;
    expect(outbox.reconcile).toHaveBeenLastCalledWith(new Set([message.id]));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(controls.transportCount).toBe(1);
    expect(controls.explicitReconnects).toBe(0);
    expect(mobileSurfaceCache.read).not.toHaveBeenCalled();
  });
});
