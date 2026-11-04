import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomView, RoomViewMessage } from '@beeline/buzz-client';
import {
  offscreenMessageFits,
  projectSidebarPreview,
} from '../../../../../../../packages/api-contract/src/sidebar-preview';

// Canonical snapshots model a completed connection catch-up. The Room itself
// must never open a fallback reader or poll a silent connection.
vi.mock('@/buzz/router-family', () => ({
  useRouterFamily: () => 'router',
  holdRouterConnection: () => () => {},
}));
vi.mock('@/buzz/router-owner', async () =>
  (await import('@/test/canonical-router-fixture')).canonicalRouterFixture(async () => {
    controls.snapshotReads++;
    if (controls.failures-- > 0) throw new Error('Couldn’t reach Beeline');
    return roomView([...controls.serverMessages]);
  }),
);

const controls = vi.hoisted(() => ({
  serverMessages: [] as RoomViewMessage[],
  roomReads: 0,
  snapshotReads: 0,
  appState: 'active' as string,
  reconnects: 0,
  working: false,
  failures: 0,
  appStateListeners: [] as Array<(state: string) => void>,
  emit: (_event: unknown) => {},
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { setItem: vi.fn(async () => undefined) },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      controls.appStateListeners.push(listener);
      return {
        remove: () => {
          const index = controls.appStateListeners.indexOf(listener);
          if (index >= 0) controls.appStateListeners.splice(index, 1);
        },
      };
    },
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
          emit({
            monolithLive: { type: 'subscribed', roomId: '11111111-1111-4111-8111-111111111111' },
          });
          return vi.fn();
        },
      };
    }
    async publishPreparedMessage() {}
    liveDiagnostics() {
      return { state: 1, connecting: false };
    }
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

import type {
  RoomSurfaceSessionBindings,
  UseRoomSurfaceSessionResult,
} from './useRoomSurfaceSession';
import { useRoomSurfaceSession } from './useRoomSurfaceSession';

function roomView(messages: RoomViewMessage[]): RoomView {
  return {
    room: {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'workspace',
      name: '11111111-1111-4111-8111-111111111111',
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    },
    messages,
    members: [],
    latestAgentTurns: [
      {
        agentPubkey: 'bbc',
        requestId: 'turn-a',
        status: controls.working ? 'working' : 'complete',
        createdAt: 1,
      },
    ],
    viewer: {
      identity: { pubkey: 'viewer', kind: 'human', name: 'Captain' },
      role: 'owner',
      permissions: { send: true, manage: true },
    },
    repositoryResolution: { status: 'absent' },
    watchFilters: [{ '#h': ['11111111-1111-4111-8111-111111111111'] }],
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
  capture(
    useRoomSurfaceSession({ channelId: '11111111-1111-4111-8111-111111111111', bindingsRef }),
  );
  return null;
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  ((await import('@/buzz/router-owner')) as any).resetFixture();
  vi.useFakeTimers();
  controls.serverMessages = [message('m-2042', 1_791_246_920, 'Yes. I left the timers here…')];
  controls.roomReads = 0;
  controls.snapshotReads = 0;
  controls.appState = 'active';
  controls.reconnects = 0;
  controls.working = false;
  controls.failures = 0;
  controls.appStateListeners.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const request = { family: 'room-head', roomId: '11111111-1111-4111-8111-111111111111' };
const owner = async () => (await import('@/buzz/router-owner')) as any;
async function open() {
  let latest!: UseRoomSurfaceSessionResult, renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      React.createElement(Harness, {
        capture: (value: UseRoomSurfaceSessionResult) => {
          latest = value;
        },
      }),
    );
  });
  await advance(100);
  return { current: () => latest, renderer };
}
describe('Reproduction R1: a silent Room uses only its canonical lane', () => {
  for (const failures of [0, 1])
    it(`paints a catch-up reply after ${failures} interrupted snapshots without a fallback reader`, async () => {
      controls.working = true;
      const { current, renderer } = await open();
      expect(current().roomSurface?.latestAgentTurns[0]?.status).toBe('working');
      controls.serverMessages.push(
        message('hidden-reply', 1791247547, 'A long reply. '.repeat(200)),
      );
      controls.working = false;
      await advance(30000);
      expect(current().roomSurface?.messages.at(-1)?.id).toBe('m-2042');
      expect(controls.snapshotReads).toBe(1);
      if (failures) {
        controls.failures = 1;
        await act(async () => {
          await (await owner()).pushServer(request).catch(() => undefined);
        });
        expect(current().roomSurface?.messages.at(-1)?.id).toBe('m-2042');
        await advance(60000);
        expect(controls.snapshotReads).toBe(2);
      }
      await act(async () => {
        await (await owner()).pushServer(request);
      });
      expect(current().roomSurface?.messages.at(-1)?.id).toBe('hidden-reply');
      expect(current().roomSurface?.latestAgentTurns[0]?.status).toBe('complete');
      const snapshots = controls.snapshotReads;
      await advance(10 * 60000);
      expect(controls.snapshotReads).toBe(snapshots);
      expect(controls.roomReads).toBe(0);
      await act(async () => renderer.unmount());
    });
  it('never polls a working Room, including after live presence frames', async () => {
    controls.working = true;
    const { renderer } = await open();
    await advance(120000);
    await act(async () =>
      controls.emit({
        monolithLive: {
          type: 'presence',
          roomId: request.roomId,
          agentId: 'bbc',
          status: 'online',
          observedAt: 1,
        },
      }),
    );
    await advance(60000);
    controls.appState = 'background';
    await advance(60000);
    expect(controls.snapshotReads).toBe(1);
    expect(controls.roomReads).toBe(0);
    await act(async () => renderer.unmount());
  });
  it('clears a failed opening Retry when the canonical catch-up arrives', async () => {
    controls.failures = 1;
    const { current, renderer } = await open();
    await advance(60000);
    expect(current().hydrationFailed).toBe(true);
    expect(current().roomSurface).toBeNull();
    expect(controls.snapshotReads).toBe(1);
    await act(async () => {
      await (await owner()).pushServer(request);
    });
    expect(current().roomSurface?.messages.at(-1)?.id).toBe('m-2042');
    expect(current().hydrationFailed).toBe(false);
    expect(controls.roomReads).toBe(0);
    await act(async () => renderer.unmount());
  });
  it('does not manufacture a refresh on a timer or a foreground event', async () => {
    controls.failures = 1;
    const { current, renderer } = await open();
    await advance(60000);
    await act(async () => {
      for (const listener of controls.appStateListeners) listener('active');
    });
    await advance(60000);
    expect(controls.snapshotReads).toBe(1);
    expect(controls.roomReads).toBe(0);
    await act(async () => {
      await (await owner()).pushServer(request);
    });
    expect(current().hydrationFailed).toBe(false);
    await act(async () => renderer.unmount());
  });
  it('paints the canonical send receipt while a missed reply stays pending, without an idle read', async () => {
    const { current, renderer } = await open();
    controls.serverMessages.push(message('hidden', 1791247547, 'Missed reply'));
    await advance(10 * 60000);
    await act(async () =>
      current().applyRoomMessageResult(message('5e7d', 1791248000, 'Thanks — looks good')),
    );
    await advance(5000);
    expect(current().roomSurface?.messages.map((row) => row.id)).toEqual(['m-2042', '5e7d']);
    expect(controls.roomReads).toBe(0);
    expect(controls.snapshotReads).toBe(1);
    expect(controls.reconnects).toBe(0);
    await act(async () => renderer.unmount());
  });
  it('reads nothing while the app is in the background', async () => {
    const { renderer } = await open();
    controls.appState = 'background';
    await advance(10 * 60000);
    expect(controls.roomReads).toBe(0);
    expect(controls.snapshotReads).toBe(1);
    await act(async () => renderer.unmount());
  });
});
