import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CornerListItem, CornerListView } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

const list = vi.hoisted(() => ({
  reads: 0,
  state: 'waiting' as string,
  cached: null as unknown,
  createCalls: [] as unknown[][],
  createGate: null as Promise<void> | null,
  createFailure: null as Error | null,
  /** When set, the screen's watch goes through this shared socket instead. */
  live: null as null | import('@/sync/transport/live-connection').LiveConnection,
  subscriptions: [] as Array<{
    filters: readonly { readonly '#h'?: readonly string[] }[];
    emit(event: MonolithSurfaceEvent): void;
  }>,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: {
      OS: 'ios',
      select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
    },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

function hostModule(...names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, (props: any) => React.createElement(name, props, props?.children)]),
  );
}
vi.mock('@/components/buzz/Button', () => hostModule('Button'));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => hostModule('SurfaceGlyphLoader'));
vi.mock('@/components/buzz/RoomCornersHeader', () => hostModule('RoomCornersHeader'));
vi.mock('@/components/buzz/RoomCornersList', () => hostModule('RoomCornersList'));
vi.mock('@/components/buzz/CommunityRail', () => hostModule('BuzzCommunityShell'));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/buzz/use-room-workflow-run', () => ({
  liveRoomRuns: () => [],
  useRoomWorkflowRuns: () => [],
}));
vi.mock('@/buzz/workflow-run-copy', () => ({ workflowRunHref: () => '/workflow' }));
vi.mock('@/components/buzz/corner-brief-viewer', () => ({ openCornerBriefViewer: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ roomId: 'room-a' }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: {
    read: vi.fn(async () => list.cached),
    write: vi.fn(async () => undefined),
  },
  surfaceAddress: vi.fn(() => 'surface-address'),
}));
vi.mock('@/sync/transport/monolith-operation', () => ({
  phoneOperationFailureReason: (reason: unknown) => String(reason),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async createHumanCorner(...args: unknown[]) {
      list.createCalls.push(args);
      await list.createGate;
      if (list.createFailure) throw list.createFailure;
      return 'corner-created';
    }
    async ensureClient() {
      return {
        surfaceSubscribe: async (
          filters: readonly { readonly '#h'?: readonly string[] }[],
          listener: (event: MonolithSurfaceEvent) => void,
        ) => {
          if (list.live) return list.live.register(filters, listener as (event: unknown) => void);
          list.subscriptions.push({ filters, emit: listener });
          return () => undefined;
        },
      };
    }
  },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    async corners(): Promise<CornerListView> {
      list.reads += 1;
      return cornerList(list.state);
    }
  },
}));

import BuzzCorners from './[roomId]';
import { CornerOpenToast } from '@/components/buzz/CornerOpenToast';
import { cornerOpenEnded } from '@/buzz/corner-open-status';
import { router } from 'expo-router';

const viewer = { pubkey: 'viewer', kind: 'human' as const, name: 'Captain' };

function cornerList(state: string): CornerListView {
  return {
    room: {
      id: 'room-a',
      workspaceId: 'workspace',
      name: 'general',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    },
    corners: [
      {
        corner: {
          id: 'corner-1',
          workspaceId: 'workspace',
          parentId: 'room-a',
          name: 'fix login',
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        },
        lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
        state,
        stateAt: 1,
      } as unknown as CornerListItem,
    ],
    viewer: {
      identity: viewer,
      role: 'member',
      permissions: { send: true, manage: false },
    },
    // What the server sends for this surface today.
    watchFilters: [],
  } as unknown as CornerListView;
}

function paintedStates(renderer: ReactTestRenderer): string[] {
  const rows = renderer.root.find((node: { type: unknown }) => node.type === 'RoomCornersList');
  return (rows.props.corners as CornerListItem[]).map((item) => item.state);
}

function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child as { children: unknown[] })))
    .join('');
}

function parentWatch() {
  const watch = list.subscriptions.find((entry) =>
    entry.filters.some((filter) => filter['#h']?.includes('room-a')),
  );
  if (!watch) throw new Error('the corner list is not watching its parent Room');
  return watch;
}

/** Longer than the scheduler's 500 ms floor and 1 s dirty ceiling. */
const quiet = () => act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));

async function mountList(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    // The app layout mounts the toast over every screen.
    renderer = create(
      React.createElement(React.Fragment, null,
        React.createElement(BuzzCorners),
        React.createElement(CornerOpenToast)),
    );
  });
  await vi.waitFor(() => expect(() => parentWatch()).not.toThrow());
  await quiet();
  parentWatch().emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
  await quiet();
  return renderer;
}

beforeEach(() => {
  list.reads = 0;
  list.state = 'waiting';
  list.cached = null;
  list.createCalls.length = 0;
  list.createGate = null;
  list.createFailure = null;
  list.live = null;
  cornerOpenEnded();
  vi.mocked(router.push).mockClear();
  list.subscriptions.length = 0;
});

describe('Corner list live path', () => {
  it('paints a held list and applies an ordered frame without a GET on a resumed lane', async () => {
    list.cached = cornerList('working');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<BuzzCorners />); });
    await vi.waitFor(() => expect(() => parentWatch()).not.toThrow());
    parentWatch().emit({ monolithLive: { type: 'subscribed', roomId: 'room-a',
      epoch: 'epoch', cursor: 1, resumed: true } });
    await quiet();
    expect(list.reads).toBe(0);
    expect(paintedStates(renderer)).toEqual(['working']);
    parentWatch().emit({ monolithLive: { type: 'corner-status', roomId: 'room-a',
      cornerCount: 1, waitingCornerCount: 1, openCorners: [], agentState: null,
      corners: cornerList('waiting').corners, nextOpen: 'older-corners' } });
    await quiet();
    expect(paintedStates(renderer)).toEqual(['waiting']);
    expect(renderer.root.findByType('RoomCornersList').props.moreOpen).toBe(true);
    expect(list.reads).toBe(0);
  });
  it('paints the status the parent Room lane already heard when Corners opens from it', async () => {
    const { LiveConnection } = await import('@/sync/transport/live-connection');
    const sockets: Array<{ onopen?: () => void; onmessage?: (event: { data: string }) => void;
      readyState: number }> = [];
    vi.stubGlobal('WebSocket', class {
      readyState = 0;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      constructor() { sockets.push(this); }
      send() {}
      close() { this.readyState = 3; }
    });
    const connection = new LiveConnection({
      authorization: async () => 'phone-session',
      liveUrl: () => 'wss://server.example/v1/phone/live',
      subscribeIdentityChange: () => () => undefined,
      subscribeForeground: () => () => undefined,
    });
    const emit = (frame: unknown) => sockets[0]!.onmessage?.({ data: JSON.stringify(frame) });
    try {
      // The Room screen holds the lane and hears a corner start working.
      await connection.register([{ '#h': ['room-a'] }], () => undefined);
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]!.readyState = 1;
      sockets[0]!.onopen?.();
      emit({ type: 'subscribed', roomId: 'room-a', epoch: 'epoch', cursor: 1, resumed: false });
      emit({ type: 'corner-status', roomId: 'room-a', cornerCount: 1, waitingCornerCount: 0,
        openCorners: [], agentState: 'working', corners: cornerList('working').corners });
      // Corners opens from it with an older saved list.
      list.cached = cornerList('waiting');
      list.live = connection;
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(<BuzzCorners />); });
      await quiet();
      expect(paintedStates(renderer)).toEqual(['working']);
      expect(list.reads).toBe(0);
    } finally {
      connection.dispose();
      vi.unstubAllGlobals();
    }
  });
  it('creates and opens a randomly named corner from the plus button', async () => {
    const renderer = await mountList();
    const header = renderer.root.findByType('RoomCornersHeader');
    await act(async () => header.props.onAdd());
    expect(list.createCalls).toHaveLength(1);
    const [roomId, title] = list.createCalls[0] as [string, string];
    expect(roomId).toBe('room-a');
    expect(title).toMatch(/^\w+-\w+-corner$/);
    expect(router.push).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/beeline/chat/[channelId]',
        params: expect.objectContaining({ channelId: 'corner-created', title }),
      }),
    );
  });

  it('shows the plus as busy while the create is in flight and ignores a second tap', async () => {
    const renderer = await mountList();
    let release!: () => void;
    list.createGate = new Promise((resolve) => (release = resolve));
    const header = () => renderer.root.findByType('RoomCornersHeader');
    expect(header().props.busy).toBe(false);
    await act(async () => {
      void header().props.onAdd();
    });
    expect(header().props.busy).toBe(true);
    await act(async () => {
      void header().props.onAdd();
    });
    expect(list.createCalls).toHaveLength(1);
    // The phone names the corner, so a retry can ask for the same one.
    expect(list.createCalls[0]![5]).toMatch(/^[0-9a-f-]{36}$/);
    await act(async () => release());
    await vi.waitFor(() => expect(header().props.busy).toBe(false));
    expect(router.push).toHaveBeenCalledOnce();
  });

  it('shows a placeholder row while the create waits, with no toast over its own list', async () => {
    const renderer = await mountList();
    let release!: () => void;
    list.createGate = new Promise((resolve) => (release = resolve));
    await act(async () => {
      void renderer.root.findByType('RoomCornersHeader').props.onAdd();
    });
    const row = renderer.root.findByProps({ testID: 'corner-open-row-pending' });
    expect(textOf(row)).toBe('Opening corner…Waiting for server · 0s');
    expect(renderer.root.findAllByProps({ testID: 'corner-open-pending' })).toHaveLength(0);
    await act(async () => release());
    await vi.waitFor(() =>
      expect(renderer.root.findAllByProps({ testID: 'corner-open-row-pending' })).toHaveLength(0),
    );
  });

  it.each([
    ['loses the network', new TypeError('Network request failed'), 'No connection to the server'],
    [
      'times out',
      Object.assign(new Error('timed out'), { name: 'MonolithRequestTimeoutError' }),
      'No response from server after 15s',
    ],
  ])('says so with Retry when the create %s, and Retry asks for the same corner', async (_, failure, why) => {
    const renderer = await mountList();
    list.createFailure = failure;
    await act(async () => renderer.root.findByType('RoomCornersHeader').props.onAdd());
    expect(router.push).not.toHaveBeenCalled();
    expect(textOf(renderer.root.findByProps({ testID: 'corner-open-row-failed' }))).toBe(
      `Corner not opened${why}`,
    );
    const toast = renderer.root.findByProps({ testID: 'corner-open-failed' });
    expect(textOf(toast)).toBe("Couldn't reach BeelineCheck your connection, then retry.Retry");

    list.createFailure = null;
    await act(async () => renderer.root.findByProps({ testID: 'corner-open-retry' }).props.onPress());
    expect(list.createCalls).toHaveLength(2);
    expect(list.createCalls[1]![1]).toBe(list.createCalls[0]![1]);
    expect(list.createCalls[1]![5]).toBe(list.createCalls[0]![5]);
    expect(router.push).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ testID: 'corner-open-failed' })).toHaveLength(0);
  });

  it('repaints a corner status from the parent Room nudge, without re-entering', async () => {
    const renderer = await mountList();
    expect(paintedStates(renderer)).toEqual(['waiting']);
    expect(list.reads).toBe(1);

    list.state = 'working';
    await act(async () => {
      parentWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'corner-status' },
      });
    });
    await quiet();

    expect(list.reads).toBe(2);
    expect(paintedStates(renderer)).toEqual(['working']);
  });

  it('still watches the parent Room when the cached list carries no watch filters', async () => {
    list.cached = cornerList('waiting');
    await mountList();
    expect(parentWatch().filters).toEqual([{ '#h': ['room-a'] }]);
  });

  it('does not re-read for parent chat traffic, only for a reconnect', async () => {
    const renderer = await mountList();
    await act(async () => {
      parentWatch().emit({
        monolithLive: {
          type: 'invalidate',
          roomId: 'room-a',
          reason: 'postgres:messages',
          messageId: 'm1',
        },
      });
    });
    await quiet();
    expect(list.reads).toBe(1);

    list.state = 'working';
    await act(async () => {
      parentWatch().emit({ monolithLive: { type: 'subscribed', roomId: 'room-a' } });
    });
    await quiet();
    expect(list.reads).toBe(2);
    expect(paintedStates(renderer)).toEqual(['working']);
  });
});
