import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView, RoomViewMessage } from '@beeline/buzz-client';

// The real SurfaceRefreshScheduler drives the reads here; only the network
// edges are faked. The socket subscribes and then stalls until the explicit frame test.
const controls = vi.hoisted(() => ({
  serverMessages: [] as RoomViewMessage[],
  roomReads: 0,
  appState: 'active' as string,
  reconnects: 0,
  working: false,
  failures: 0,
  emit: (_event: unknown) => {},
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: vi.fn(async () => undefined) },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    get currentState() {
      return controls.appState;
    },
  },
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
}));

vi.mock('@/buzz/sentry', () => ({ captureMobileError: vi.fn() }));

vi.mock('expo-router', () => ({ router: { replace: vi.fn() } }));

vi.mock('@/auth/buzz-identity-storage', () => ({
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
  peekBuzzViewerContext: () => null,
  loadBuzzViewerPubkey: vi.fn(async () => 'viewer'),
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
}));

vi.mock('@/buzz/community-storage', () => ({
  saveActiveCommunityId: vi.fn(async () => undefined),
  saveLastViewedChannel: vi.fn(async () => undefined),
}));

vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
  surfaceAddress: vi.fn((_relay: string, _viewer: string, path: string) => path),
  createRoomOutbox: vi.fn(() => ({
    restore: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    subscribe: () => () => undefined,
    state: () => undefined,
    acknowledgeFailures: async () => undefined,
    reconcile: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    get: vi.fn(() => undefined),
  })),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async ensureClient() {
      return {
        surfaceSubscribe: async (_filters: unknown, emit: (event: unknown) => void) => {
          controls.emit = emit;
          emit({ monolithLive: { type: 'subscribed', roomId: 'experiments' } });
          return vi.fn();
        },
      };
    }
    async publishPreparedMessage() {}
    liveDiagnostics() { return { state: 1, connecting: false }; }
    reconnectLive() {
      controls.reconnects += 1;
    }
    async reopenChat() {}
  },
}));

vi.mock('@/sync/transport/room-view-client', async () => {
  const { RoomViewHttpError } =
    await vi.importActual<typeof import('@beeline/buzz-client')>('@beeline/buzz-client');
  return {
    RoomViewHttpError,
    readPushedMonolithRoom: vi.fn(),
    isRoomViewTimeoutError: () => false,
    RoomViewClient: class {
      async room(): Promise<RoomView> {
        controls.roomReads += 1;
        if (controls.failures-- > 0) throw new Error('temporary network failure');
        return roomView([...controls.serverMessages]);
      }
      async markRead() {}
      async markUnread() {}
    },
  };
});

import type { RoomSurfaceSessionBindings, UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';
import { useRoomSurfaceSession } from './useRoomSurfaceSession';

function roomView(messages: RoomViewMessage[]): RoomView {
  return {
    room: {
      id: 'experiments',
      workspaceId: 'workspace',
      name: 'experiments',
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    },
    messages,
    members: [],
    latestAgentTurns: [{ agentPubkey: 'bbc', requestId: 'turn-a', status: controls.working ? 'working' : 'complete', createdAt: 1 }],
    viewer: {
      identity: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      role: 'owner',
      permissions: { send: true, manage: true },
    },
    repositoryResolution: { status: 'absent' },
    watchFilters: [{ '#h': ['experiments'] }],
  };
}

function message(id: string, createdAt: number, text: string): RoomViewMessage {
  return {
    id,
    text,
    createdAt,
    author: { pubkey: 'bbc', kind: 'agent', name: 'BBC' },
    presentation: 'message',
  };
}

function Harness({ capture }: { capture(result: UseRoomSurfaceSessionResult): void }) {
  const bindingsRef = React.useRef<RoomSurfaceSessionBindings>({
    resetTranscript: vi.fn(),
    restoreOutboxMessages: vi.fn(),
    dismissOptimisticMessage: vi.fn(),
    observeRoomSurface: vi.fn(),
  });
  capture(useRoomSurfaceSession({ channelId: 'experiments', bindingsRef }));
  return null;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  controls.serverMessages = [
    message('m-2042', 1_791_246_920, 'Yes. I left the timers here…'),
  ];
  controls.roomReads = 0;
  controls.appState = 'active';
  controls.reconnects = 0;
  controls.working = false;
  controls.failures = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('Reproduction R1: open Room whose live socket goes silent', () => {
  for (const failures of [0, 1]) {
    it(`reply-hidden-until-next-send: reads once on replacement subscription with ${failures} failed catch-up reads`, async () => {
      controls.working = true;
      let latest: UseRoomSurfaceSessionResult | undefined;
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(React.createElement(Harness, { capture: (r) => (latest = r) }));
      });
      await advance(100);
      expect(latest!.roomSurface!.latestAgentTurns![0]!.status).toBe('working');
      controls.serverMessages.push(message('hidden-reply', 1_791_247_547, 'A long reply. '.repeat(200)));
      controls.working = false;
      controls.failures = failures;
      await advance(30_000);
      expect(controls.roomReads).toBe(1);
      expect(latest!.roomSurface!.messages.at(-1)!.id).toBe('m-2042');
      await act(async () => controls.emit({ monolithLive: { type: 'subscribed', roomId: 'experiments' } }));
      await advance(1_100);
      expect(latest!.roomSurface!.messages.at(-1)!.id).toBe('hidden-reply');
      expect(latest!.roomSurface!.latestAgentTurns![0]!.status).toBe('complete');
      const reads = controls.roomReads;
      await advance(10 * 60_000);
      expect(controls.roomReads).toBe(reads);
      await act(async () => renderer.unmount());
    });
  }

  it('never polls a working Room, including after live frames', async () => {
    controls.working = true;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, { capture: () => {} })); });
    await advance(100);
    const opening = controls.roomReads;
    await advance(120_000);
    expect(controls.roomReads).toBe(opening);
    await act(async () => controls.emit({ monolithLive: {
      type: 'presence', roomId: 'experiments', agentId: 'bbc', status: 'online', observedAt: 1,
    } }));
    await advance(60_000);
    expect(controls.roomReads).toBe(opening);
    controls.appState = 'background';
    await advance(60_000);
    expect(controls.roomReads).toBe(opening);
    await act(async () => renderer.unmount());
  });

  it('bounds failed refresh retries to three after the opening read', async () => {
    controls.failures = 100;
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(React.createElement(Harness, { capture: () => {} })); });
    await advance(60_000);
    expect(controls.roomReads).toBe(4);
    await act(async () => renderer.unmount());
  });

  it('reads nothing while idle or after a send whose receipt paints locally', async () => {
    let latest: UseRoomSurfaceSessionResult | undefined;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Harness, { capture: (r) => (latest = r) }));
    });
    await advance(100);
    expect(latest?.roomSurface?.messages.at(-1)?.id).toBe('m-2042');
    const openingReads = controls.roomReads;

    // BBC posts to the Room. The phone's socket never delivers a frame for it.
    controls.serverMessages = [
      ...controls.serverMessages,
      message('adf6a0c9', 1_791_247_547, 'All five operational timers are now in Equities Operations'),
    ];

    // The reader keeps the Room open for ten minutes: nothing is read on a timer.
    await advance(10 * 60_000);
    expect(controls.roomReads).toBe(openingReads);

    // The reader sends. Its own delta never arrives, but the write response
    // carries the canonical row without starting a Room read timer.
    controls.serverMessages = [
      ...controls.serverMessages,
      message('5e7d', 1_791_248_000, 'Thanks — looks good'),
    ];
    await act(async () => latest!.applyRoomMessageResult(
      message('5e7d', 1_791_248_000, 'Thanks — looks good'),
    ));
    await advance(5_000);

    const newest = latest?.roomSurface?.messages.map((item) => item.id).slice(-2);
    console.log(`[R1] room reads=${controls.roomReads} newest painted=${newest}`);
    expect(newest).toEqual(['m-2042', '5e7d']);
    expect(controls.roomReads).toBe(openingReads);
    expect(controls.reconnects).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('reads nothing while the app is in the background', async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(Harness, { capture: () => undefined }));
    });
    await advance(100);
    const reads = controls.roomReads;
    controls.appState = 'background';
    await advance(10 * 60_000);
    expect(controls.roomReads).toBe(reads);
    await act(async () => renderer.unmount());
  });
});
