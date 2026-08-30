import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView } from '@beeline/buzz-client';

const controls = vi.hoisted(() => ({
  cached: null as RoomView | null,
  schedulers: [] as Array<{
    apply(view: RoomView): void;
    error(error: unknown): void;
    disposed: boolean;
  }>,
  subscriptions: [] as Array<{ filters: unknown; stop: ReturnType<typeof vi.fn> }>,
  transportCount: 0,
  identityPromise: null as Promise<{ publicKey: string; secretKey: Uint8Array } | null> | null,
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }));

vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(() =>
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
    fail: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    get: vi.fn(),
  })),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    constructor() {
      controls.transportCount += 1;
    }
    async ensureClient() {
      return {
        surfaceSubscribe: async (filters: unknown) => {
          const stop = vi.fn();
          controls.subscriptions.push({ filters, stop });
          return stop;
        },
      };
    }
    async publishPreparedMessage() {}
  },
}));

vi.mock('@beeline/buzz-client', async () => {
  const actual = await vi.importActual<typeof import('@beeline/buzz-client')>(
    '@beeline/buzz-client',
  );
  return {
    ...actual,
    RoomViewClient: class {
      async room() {
        return new Promise<RoomView>(() => undefined);
      }
    },
    SurfaceRefreshScheduler: class {
      private readonly options: {
        apply(view: RoomView): void;
        onError(error: unknown): void;
      };
      private readonly control: (typeof controls.schedulers)[number];
      constructor(options: { apply(view: RoomView): void; onError(error: unknown): void }) {
        this.options = options;
        this.control = {
          apply: (view) => this.options.apply(view),
          error: (error) => this.options.onError(error),
          disposed: false,
        };
        controls.schedulers.push(this.control);
      }
      async startAfter(watch: Promise<void>) {
        await watch;
      }
      signal() {}
      force() {}
      dispose() {
        this.control.disposed = true;
      }
    },
  };
});

import { RoomViewHttpError } from '@beeline/buzz-client';
import {
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

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  controls.cached = null;
  controls.schedulers.length = 0;
  controls.subscriptions.length = 0;
  controls.transportCount = 0;
  controls.identityPromise = null;
  vi.clearAllMocks();
});

describe('useRoomSurfaceSession', () => {
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
