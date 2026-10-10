import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CornerListItem, CornerListView } from '@beeline/buzz-client';

const list = vi.hoisted(() => ({
  reads: [] as Array<{ options: unknown; settle?: () => void }>,
  /** The rows each read answers with, by state. */
  state: 'waiting' as string,
  /** Extra open corners the first page carries. */
  extra: [] as string[],
  /** When set, a read waits on this gate before it answers. */
  readGate: null as Promise<void> | null,
  archived: [] as string[],
  cached: null as unknown,
  createCalls: [] as unknown[][],
  createGate: null as Promise<void> | null,
  createFailure: null as Error | null,
  live: null as null | import('@/sync/transport/live-connection').LiveConnection,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
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
vi.mock('@/sync/transport/live-connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/transport/live-connection')>()),
  sharedLiveConnection: () => list.live,
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async createHumanCorner(...args: unknown[]) {
      list.createCalls.push(args);
      await list.createGate;
      if (list.createFailure) throw list.createFailure;
      return 'corner-created';
    }
  },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    async corners(_id: string, options?: { archived?: boolean }): Promise<CornerListView> {
      const read: { options: unknown; settle?: () => void } = { options };
      list.reads.push(read);
      const state = list.state;
      const extra = [...list.extra];
      const archived = [...list.archived];
      await list.readGate;
      if (options?.archived) {
        return { ...cornerList(state), corners: archived.map((id) => corner(id, 'archived')) };
      }
      return cornerList(state, extra);
    }
  },
}));

import BuzzCorners from './[roomId]';
import { CornerOpenToast } from '@/components/buzz/CornerOpenToast';
import { cornerOpenEnded } from '@/buzz/corner-open-status';
import { resetRoomCornerStore } from '@/buzz/room-corner-store';
import { LiveConnection } from '@/sync/transport/live-connection';
import { router } from 'expo-router';

const viewer = { pubkey: 'viewer', kind: 'human' as const, name: 'Captain' };

function corner(id: string, state: string): CornerListItem {
  return {
    corner: {
      id,
      workspaceId: 'workspace',
      parentId: 'room-a',
      name: id,
      archived: state === 'archived',
      createdAt: 1,
      updatedAt: 1,
    },
    lifecycle: { lifecycle: 'unknown', checks: 'unknown' },
    state,
    stateAt: 1,
  } as unknown as CornerListItem;
}

function cornerList(state: string, extra: readonly string[] = []): CornerListView {
  return {
    room: {
      id: 'room-a',
      workspaceId: 'workspace',
      name: 'general',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    },
    corners: [...extra.map((id) => corner(id, 'working')), corner('corner-1', state)],
    viewer: {
      identity: viewer,
      role: 'member',
      permissions: { send: true, manage: false },
    },
    // What the server sends for this surface today.
    watchFilters: [],
  } as unknown as CornerListView;
}

type TestSocket = {
  readyState: number;
  sent: string[];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
};

/** The phone server's side of the one live socket. */
const server = {
  sockets: [] as TestSocket[],
  socket(): TestSocket {
    const socket = server.sockets.at(-1);
    if (!socket) throw new Error('no live socket');
    return socket;
  },
  open() {
    const socket = server.socket();
    socket.readyState = 1;
    socket.onopen?.();
  },
  emit(frame: unknown) {
    server.socket().onmessage?.({ data: JSON.stringify(frame) });
  },
  subscribed(resumed = false, epoch = 'epoch') {
    server.emit({ type: 'subscribed', roomId: 'room-a', epoch, cursor: 0, resumed });
  },
  status(sequence: number, rows: readonly CornerListItem[], nextOpen?: string) {
    server.emit({
      type: 'corner-status', roomId: 'room-a', sequence, cornerCount: rows.length,
      waitingCornerCount: 0, openCorners: [], agentState: null, corners: rows,
      ...(nextOpen ? { nextOpen } : {}),
    });
  },
};

function painted(renderer: ReactTestRenderer): string[] {
  const rows = renderer.root.find((node: { type: unknown }) => node.type === 'RoomCornersList');
  return (rows.props.corners as CornerListItem[]).map((item) => `${item.corner.id}:${item.state}`);
}

function openReads(): number {
  return list.reads.filter((read) => !(read.options as { archived?: boolean } | undefined)?.archived
    && !(read.options as { openBefore?: string } | undefined)?.openBefore).length;
}

function textOf(node: { children: unknown[] }): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textOf(child as { children: unknown[] })))
    .join('');
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

/** Another screen, such as the Room list, holds the parent Room lane. */
async function holdLaneElsewhere(): Promise<() => void> {
  const stop = await list.live!.register([{ '#h': ['room-a'] }], () => undefined);
  await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  server.open();
  server.subscribed();
  return stop;
}

async function openCorners(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    // The app layout mounts the toast over every screen.
    renderer = create(
      React.createElement(React.Fragment, null,
        React.createElement(BuzzCorners),
        React.createElement(CornerOpenToast)),
    );
  });
  await settle();
  return renderer;
}

/** Open Corners with nothing else holding the lane; the first read paints it. */
async function mountList(): Promise<ReactTestRenderer> {
  const renderer = await openCorners();
  await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
  server.open();
  server.subscribed();
  await settle();
  await vi.waitFor(() => expect(painted(renderer)).toEqual(['corner-1:waiting']));
  return renderer;
}

beforeEach(() => {
  list.reads.length = 0;
  list.state = 'waiting';
  list.extra = [];
  list.readGate = null;
  list.archived = [];
  list.cached = null;
  list.createCalls.length = 0;
  list.createGate = null;
  list.createFailure = null;
  cornerOpenEnded();
  vi.mocked(router.push).mockClear();
  server.sockets.length = 0;
  vi.stubGlobal('WebSocket', class {
    readyState = 0;
    sent: string[] = [];
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor() { server.sockets.push(this as unknown as TestSocket); }
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; }
  });
  resetRoomCornerStore();
  list.live = new LiveConnection({
    authorization: async () => 'phone-session',
    liveUrl: () => 'wss://server.example/v1/phone/live',
    subscribeIdentityChange: () => () => undefined,
    subscribeForeground: () => () => undefined,
  });
});

afterEach(() => {
  list.live?.dispose();
  list.live = null;
  vi.unstubAllGlobals();
});

describe('Corner list live path', () => {
  it('shows corners the Room lane heard while Corners was closed, with no read', async () => {
    // The Room list holds the parent lane. While Corners is closed, two
    // corners open and the server sends their rows.
    await holdLaneElsewhere();
    server.status(1, [corner('corner-new', 'working'), corner('corner-1', 'waiting')]);
    server.status(2, [corner('corner-newer', 'working'), corner('corner-new', 'working'),
      corner('corner-1', 'waiting')]);
    // Corners saved an older list the last time it was open.
    list.cached = cornerList('waiting');
    const renderer = await openCorners();
    await vi.waitFor(() => expect(painted(renderer)).toEqual(
      ['corner-newer:working', 'corner-new:working', 'corner-1:waiting']));
    expect(openReads()).toBe(0);
  });

  it('Reproduction G3-3.1: reads once when the Room list holds the lane but nothing proved the saved list', async () => {
    // The Room list holds the parent lane after app start; no corner changed
    // since, so no frame came. The late join still reports the lane resumed.
    await holdLaneElsewhere();
    list.cached = cornerList('waiting');
    list.state = 'working';
    const renderer = await openCorners();
    // The saved copy paints at once; the read replaces it.
    await vi.waitFor(() => expect(painted(renderer)).toEqual(['corner-1:working']));
    expect(openReads()).toBe(1);
  });

  it('keeps a frame that lands while the first read is in flight', async () => {
    let release!: () => void;
    list.readGate = new Promise((resolve) => (release = resolve));
    const renderer = await openCorners();
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1));
    server.open();
    server.subscribed();
    await vi.waitFor(() => expect(openReads()).toBe(1));
    server.status(1, [corner('corner-new', 'working'), corner('corner-1', 'working')]);
    await act(async () => release());
    await settle();
    expect(painted(renderer)).toEqual(['corner-new:working', 'corner-1:working']);
  });

  it('drops a frame older than one the lane already applied', async () => {
    const renderer = await mountList();
    server.status(5, [corner('corner-1', 'review')]);
    server.status(4, [corner('corner-1', 'working')]);
    await settle();
    expect(painted(renderer)).toEqual(['corner-1:review']);
  });

  it('never repeats a corner a frame moved from a later page to the first', async () => {
    const renderer = await mountList();
    server.status(1, [corner('corner-1', 'waiting')], 'older');
    await settle();
    // The next page holds corner-old, and repeats corner-1 from the first.
    list.extra = ['corner-old'];
    await act(async () => renderer.root.findByType('RoomCornersList').props.onMoreOpen());
    await settle();
    expect(painted(renderer)).toEqual(['corner-1:waiting', 'corner-old:working']);
    server.status(2, [corner('corner-old', 'review'), corner('corner-1', 'waiting')]);
    await settle();
    expect(painted(renderer)).toEqual(['corner-old:review', 'corner-1:waiting']);
  });

  it('re-reads the archived list when a corner leaves the open list', async () => {
    const renderer = await mountList();
    server.status(1, [corner('corner-2', 'working'), corner('corner-1', 'waiting')]);
    await settle();
    await act(async () => renderer.root.findByType('RoomCornersList').props.onShowArchived());
    await settle();
    expect(renderer.root.findByType('RoomCornersList').props.archived.corners).toEqual([]);
    list.archived = ['corner-2'];
    server.status(2, [corner('corner-1', 'waiting')]);
    await settle();
    await vi.waitFor(() => expect(
      renderer.root.findByType('RoomCornersList').props.archived.corners
        .map((item: CornerListItem) => item.corner.id),
    ).toEqual(['corner-2']));
    expect(painted(renderer)).toEqual(['corner-1:waiting']);
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

  it('reads when the parent Room names a corner change without its rows', async () => {
    const renderer = await mountList();
    expect(openReads()).toBe(1);
    list.state = 'working';
    server.emit({ type: 'invalidate', roomId: 'room-a', reason: 'corner-status' });
    await settle();
    expect(openReads()).toBe(2);
    expect(painted(renderer)).toEqual(['corner-1:working']);
  });

  it('does not re-read for parent chat traffic, only for a fresh lane', async () => {
    const renderer = await mountList();
    server.emit({ type: 'invalidate', roomId: 'room-a', reason: 'postgres:messages', messageId: 'm1' });
    await settle();
    expect(openReads()).toBe(1);

    list.state = 'working';
    server.subscribed(false, 'epoch-2');
    await settle();
    expect(openReads()).toBe(2);
    expect(painted(renderer)).toEqual(['corner-1:working']);
  });
});
