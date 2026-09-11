import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NostrEvent, RoomView } from '@beeline/buzz-client';
import { visibleLiveOverlays } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

type TestSurfaceEvent = NostrEvent | MonolithSurfaceEvent;

const controls = vi.hoisted(() => ({
  cached: null as RoomView | null,
  schedulers: [] as Array<{
    fetch(): Promise<RoomView>;
    apply(view: RoomView): void;
    error(error: unknown): void;
    disposed: boolean;
    expectations: Array<(view: RoomView) => boolean>;
    forceCalls: number;
    signalCalls: number;
  }>,
  subscriptions: [] as Array<{
    filters: unknown;
    stop: ReturnType<typeof vi.fn>;
    emit(event: TestSurfaceEvent): void;
  }>,
  replayEvents: [] as NostrEvent[],
  transportCount: 0,
  reopenChat: vi.fn(async (_roomId: string) => undefined),
  identityPromise: null as Promise<{ publicKey: string; secretKey: Uint8Array } | null> | null,
  outboxFail: vi.fn(async (_eventId: string) => undefined),
  outboxGet: vi.fn((_eventId: string) => ({ status: 'pending' as const })),
  traceSetItem: vi.fn(async (_key: string, _value: string) => undefined),
  roomResponse: null as RoomView | null,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: controls.traceSetItem },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
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

vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }));

vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(
    () =>
      controls.identityPromise ??
      Promise.resolve({ publicKey: 'viewer', secretKey: new Uint8Array(32) }),
  ),
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
}));

vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
}));

vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: {
    read: vi.fn(async () => controls.cached),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  surfaceAddress: vi.fn((_relay: string, _viewer: string, path: string) => path),
  createRoomOutbox: vi.fn(() => ({
    restore: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    reconcile: vi.fn(async () => undefined),
    fail: controls.outboxFail,
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    get: controls.outboxGet,
  })),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    constructor() {
      controls.transportCount += 1;
    }
    async ensureClient() {
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
    RoomViewClient: class {
      async room() {
        if (controls.roomResponse) return controls.roomResponse;
        return new Promise<RoomView>(() => undefined);
      }
      async markRead() {}
    },
  };
});

vi.mock('@beeline/buzz-client', async () => {
  const actual =
    await vi.importActual<typeof import('@beeline/buzz-client')>('@beeline/buzz-client');
  return {
    ...actual,
    SurfaceRefreshScheduler: class {
      private readonly options: {
        fetch(): Promise<RoomView>;
        apply(view: RoomView): void;
        onError(error: unknown): void;
      };
      private readonly control: (typeof controls.schedulers)[number];
      constructor(options: {
        fetch(): Promise<RoomView>;
        apply(view: RoomView): void;
        onError(error: unknown): void;
      }) {
        this.options = options;
        this.control = {
          fetch: () => this.options.fetch(),
          apply: (view) => this.options.apply(view),
          error: (error) => this.options.onError(error),
          disposed: false,
          expectations: [],
          forceCalls: 0,
          signalCalls: 0,
        };
        controls.schedulers.push(this.control);
      }
      async startAfter(watch: Promise<void>) {
        await watch;
      }
      signal() {
        this.control.signalCalls += 1;
      }
      signalUntil(expectation: (view: RoomView) => boolean) {
        this.control.expectations.push(expectation);
      }
      force() {
        this.control.forceCalls += 1;
      }
      dispose() {
        this.control.disposed = true;
      }
    },
  };
});

import { RoomViewHttpError } from '@beeline/buzz-client';
import { cornerSummaries } from '@/buzz/room-view-presentation';
import { selectPinnedCorner, isPinnedCornerLive } from '@/buzz/room-indicators';
import { CornerLiveBar } from '@/components/buzz/CornerLiveBar';
import {
  LIVE_TRACE_STORAGE_KEY,
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
  type UseRoomSurfaceSessionResult,
} from './useRoomSurfaceSession';

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
    corners: [],
    watchFilters: filters,
  };
}

function Harness({
  channelId,
  notificationResponseId,
  capture,
}: {
  channelId: string;
  notificationResponseId?: string;
  capture(result: UseRoomSurfaceSessionResult): void;
}) {
  const bindingsRef = React.useRef<RoomSurfaceSessionBindings>({
    resetTranscript: vi.fn(),
    restoreOutboxMessages: vi.fn(),
    dismissOptimisticMessage: vi.fn(),
    observeRoomSurface: vi.fn(),
  });
  const result = useRoomSurfaceSession({
    channelId,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });
  capture(result);
  return React.createElement('room-surface', {
    roomId: result.roomSurface?.room.id,
    error: result.hydrationError,
  });
}

function LiveCornerHarness({ channelId }: { channelId: string }) {
  // Match the OTA smoke: this Room has already been open longer than the
  // canonical working-lease horizon before its new corner starts working.
  const [cornerNow, setCornerNow] = React.useState(() => Date.now() - 180_000);
  const bindingsRef = React.useRef<RoomSurfaceSessionBindings>({
    resetTranscript: vi.fn(),
    restoreOutboxMessages: vi.fn(),
    dismissOptimisticMessage: vi.fn(),
    observeRoomSurface: () => setCornerNow(Date.now()),
  });
  const { roomSurface } = useRoomSurfaceSession({ channelId, bindingsRef });
  const pinned = roomSurface
    ? selectPinnedCorner({ lifecycle: cornerSummaries(roomSurface), now: cornerNow })
    : null;
  return pinned
    ? React.createElement(CornerLiveBar, {
        label: `agent active: ${pinned.cornerId}`,
        live: isPinnedCornerLive(pinned.status),
      })
    : null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
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
  controls.cached = null;
  controls.schedulers.length = 0;
  controls.subscriptions.length = 0;
  controls.transportCount = 0;
  controls.reopenChat.mockClear();
  controls.replayEvents.length = 0;
  controls.identityPromise = null;
  controls.roomResponse = null;
  controls.outboxFail.mockClear();
  controls.outboxGet.mockClear();
  vi.clearAllMocks();
});

describe('useRoomSurfaceSession', () => {
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
      observedAt: 1_199_000,
    });
    await act(async () => renderer.unmount());
  });

  it('keeps an acknowledged send pending while authoritative projection catches up', async () => {
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

    current.outbox.scheduleConfirmation('accepted-message');
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(controls.outboxFail).not.toHaveBeenCalled();
    expect(current.outbox.failedIds).not.toContain('accepted-message');
    const expectation = controls.schedulers[0]!.expectations[0]!;
    expect(expectation(roomView('room-a'))).toBe(false);
    expect(
      expectation({
        ...roomView('room-a'),
        messages: [
          {
            id: 'accepted-message',
            text: 'hello',
            createdAt: 1,
            author: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
            presentation: 'message',
          },
        ],
      }),
    ).toBe(true);
    await act(async () => renderer.unmount());
    vi.useRealTimers();
  });

  it('paints a committed turn delta before scheduling full reconciliation', async () => {
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
    expect(controls.schedulers[0]!.signalCalls).toBe(1);
    await act(async () => renderer.unmount());
  });

  it('paints one committed reply exactly once, then converges with the full read', async () => {
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
    expect(controls.schedulers[0]!.signalCalls).toBe(1);

    await act(async () => emitReply());
    expect(current.roomSurface?.messages.map((message) => message.id)).toEqual(['reply-message']);
    expect(controls.schedulers[0]!.signalCalls).toBe(1);

    const full = { ...roomView('room-a'), messages: [reply] };
    await act(async () => controls.schedulers[0]!.apply(full));
    expect(current.roomSurface).toEqual(full);
    expect(current.roomSurface?.messages).toHaveLength(1);
    expect(controls.schedulers[0]!.signalCalls).toBe(1);
    await act(async () => renderer.unmount());
  });

  it('acknowledges every burst delta after its committed render and then reconciles', async () => {
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
    expect(controls.schedulers[0]!.signalCalls).toBe(1);

    const full = { ...roomView('room-a'), messages: [first, second] };
    await act(async () => controls.schedulers[0]!.apply(full));
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
    expect(controls.schedulers[0]!.signalCalls).toBe(0);
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

    expect(controls.schedulers[0]!.signalCalls).toBe(1);
    await act(async () => renderer.unmount());
  });

  it('forces reconciliation when the live socket resubscribes after a painted Room', async () => {
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

    expect(controls.schedulers[0]!.forceCalls).toBe(1);
    await act(async () => renderer.unmount());
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
      controls.schedulers[0]!.apply(await controls.schedulers[0]!.fetch());
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

  it('lights the gold bar from a fresh indexed child-turn receipt', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(LiveCornerHarness, { channelId: 'room-a' }));
    });
    await flushEffects();

    const applied = roomView('room-a');
    const stateAt = Math.floor(Date.now() / 1_000);
    await act(async () => {
      controls.schedulers[0]!.apply({
        ...applied,
        latestAgentTurns: [
          { requestId: 'request-a', agentPubkey: 'agent-a', status: 'working', createdAt: stateAt },
        ],
        corners: [
          {
            corner: {
              ...applied.room,
              id: 'corner-a',
              parentId: 'room-a',
              name: 'smoke-corner',
              createdAt: stateAt,
              updatedAt: stateAt,
            },
            // The review card remains mounted during steering. The fresh
            // receipt must temporarily light the Room bar anyway.
            lifecycle: { lifecycle: 'REVIEW' },
            status: 'working',
            statusAt: stateAt,
            reason: 'review',
            agent: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' },
          },
        ],
      });
      await Promise.resolve();
    });

    expect(
      renderer.root.findAllByProps({ testID: 'corner-status-working' }).length,
    ).toBeGreaterThan(0);
    await act(async () => renderer.unmount());
  });

  it('keeps a child corner’s monolith draft and thought lanes out of its parent Room', async () => {
    const parent = roomView('room-a', [{ '#h': ['room-a', 'corner-a'] }]);
    controls.cached = {
      ...parent,
      members: [{ identity: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' }, role: 'member' }],
      corners: [
        {
          corner: {
            ...parent.room,
            id: 'corner-a',
            parentId: 'room-a',
            name: 'Write corner',
          },
          lifecycle: { lifecycle: 'working' },
          status: 'working',
          statusAt: 10,
          reason: 'working',
          agent: { pubkey: 'agent-a', kind: 'agent', name: 'Agent' },
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
    // turn writes can ever be delivered to the reader sitting in it.
    expect(controls.subscriptions[0]!.filters).toEqual(cornerFilters);

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
      text: "I'll trace the producer, then make the smallest correction",
    });

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
      controls.schedulers[0]!.apply({
        ...roomView('corner-a', cornerFilters),
        parent: roomView('room-a').room,
        messages: [reply],
      });
    });
    expect(visibleLiveOverlays(current.liveOverlays, [reply])).toEqual([]);
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
        overlay.kind === 'draft' ? overlay.text : '',
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
      text: 'I will update only X, then commit.',
    });

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
      controls.schedulers[0]!.apply({ ...roomView('room-a'), messages: [finalMessage] });
      await Promise.resolve();
    });
    expect(visibleLiveOverlays(current.liveOverlays, current.roomSurface!.messages)).toEqual([]);
    await act(async () => renderer.unmount());
  });

  it('paints cache first, then replaces the watch when verified filters change', async () => {
    controls.cached = roomView('room-a', [{ '#h': ['room-a'] }]);
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

    expect(current.roomSurface).toBe(controls.cached);
    expect(controls.subscriptions).toHaveLength(1);
    const firstStop = controls.subscriptions[0]!.stop;

    await act(async () => {
      controls.schedulers[0]!.apply(roomView('room-a', [{ '#d': ['agent-a'] }]));
      await Promise.resolve();
    });
    expect(controls.subscriptions).toHaveLength(2);
    expect(firstStop).toHaveBeenCalledOnce();
    expect(current.roomSurface?.watchFilters).toEqual([{ '#d': ['agent-a'] }]);
    await act(async () => renderer.unmount());
  });

  it('confirms a live message against RoomView instead of trusting one possibly stale refresh', async () => {
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

    const expectation = controls.schedulers[0]!.expectations[0]!;
    expect(expectation(roomView('room-a'))).toBe(false);
    expect(
      expectation({
        ...roomView('room-a'),
        messages: [
          {
            id: event.id,
            text: event.content,
            createdAt: event.created_at,
            author: { pubkey: event.pubkey, kind: 'agent', name: 'Agent' },
            presentation: 'message',
          },
        ],
      }),
    ).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('confirms turn receipts and parent lifecycle summaries against indexed Room state', async () => {
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
    const turnExpectation = controls.schedulers[0]!.expectations[0]!;
    expect(turnExpectation(roomView('room-a'))).toBe(false);
    expect(
      turnExpectation({
        ...roomView('room-a'),
        latestAgentTurns: [
          {
            requestId: '2'.repeat(64),
            agentPubkey: turn.pubkey,
            status: 'working',
            createdAt: turn.created_at,
          },
        ],
      }),
    ).toBe(true);

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
    const landedExpectation = controls.schedulers[0]!.expectations[1]!;
    expect(landedExpectation(roomView('room-a'))).toBe(false);
    expect(
      landedExpectation({
        ...roomView('room-a'),
        messages: [
          {
            id: landed.id,
            text: landed.content,
            createdAt: landed.created_at,
            author: { pubkey: landed.pubkey, kind: 'agent', name: 'Agent' },
            presentation: 'system',
          },
        ],
      }),
    ).toBe(true);
    await act(async () => renderer.unmount());
  });

  it('keeps a fresh replayed working receipt alive until the opening Corner GET indexes it', async () => {
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

    expect(controls.schedulers[0]!.expectations).toHaveLength(1);
    const expectation = controls.schedulers[0]!.expectations[0]!;
    expect(expectation(roomView('corner-a'))).toBe(false);
    expect(
      expectation({
        ...roomView('corner-a'),
        latestAgentTurns: [
          {
            requestId: '5'.repeat(64),
            agentPubkey: 'a'.repeat(64),
            status: 'working',
            createdAt: Math.floor(Date.now() / 1_000),
          },
        ],
      }),
    ).toBe(true);
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
    const firstScheduler = controls.schedulers[0]!;
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
    expect(firstScheduler.disposed).toBe(true);
    expect(controls.schedulers).toHaveLength(2);
    await act(async () => renderer.unmount());
  });

  it('keeps stale cached paint on transient errors but clears it on terminal errors', async () => {
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

    await act(async () => controls.schedulers[0]!.error(new Error('relay unavailable')));
    expect(current.roomSurface?.room.id).toBe('room-a');
    expect(current.hydrationFailed).toBe(false);
    expect(current.hydrationError).toContain('Offline — showing the last saved response');

    await act(async () => controls.schedulers[0]!.error(new RoomViewHttpError(403, 'forbidden')));
    expect(current.roomSurface).toBeNull();
    expect(current.hydrationFailed).toBe(true);
    expect(current.hydrationError).toContain('Could not load this conversation');
    await act(async () => renderer.unmount());
  });
});
