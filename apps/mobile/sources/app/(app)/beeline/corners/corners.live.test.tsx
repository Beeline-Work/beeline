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
vi.mock('@/components/buzz/MonoHull', () => hostModule('MonoButton'));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => hostModule('SurfaceGlyphLoader'));
vi.mock('@/components/buzz/RoomCornersHeader', () => hostModule('RoomCornersHeader'));
vi.mock('@/components/buzz/RoomCornersList', () => hostModule('RoomCornersList'));
vi.mock('@/components/buzz/CommunityRail', () => hostModule('BuzzCommunityShell'));
vi.mock('@/components/buzz/NewCornerDialog', () => hostModule('NewCornerDialog'));
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
    async ensureClient() {
      return {
        surfaceSubscribe: async (
          filters: readonly { readonly '#h'?: readonly string[] }[],
          listener: (event: MonolithSurfaceEvent) => void,
        ) => {
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
    renderer = create(React.createElement(BuzzCorners));
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
  list.subscriptions.length = 0;
});

describe('Corner list live path', () => {
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
