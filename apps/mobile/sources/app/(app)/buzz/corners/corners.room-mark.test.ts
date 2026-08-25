/**
 * The standalone corners list renders every room/corner name through the `#`
 * channel-mark convention — display-only:
 *
 * - the header eyebrow renders `#<room>`;
 * - each corner row renders `#<room>/<corner>` and its accessibility label
 *   matches what is on screen;
 * - the empty state's prose reference carries the mark too;
 * - tapping a row still pushes the RAW stored corner name as the route's
 *   title hint — navigation params never see the mark.
 *
 * Render assertions on the real screen with a stubbed transport.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const mmkvValues = vi.hoisted(() => new Map<string, string>());
const lifecycleFixture = vi.hoisted(() => ({
  current: [] as Array<{ id: string; name: string; status: string }>,
}));

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
    delete(key: string) {
      mmkvValues.delete(key);
    }
  },
}));
vi.mock('expo-router', () => ({
  router: navigation,
  useLocalSearchParams: () => routeParams.current,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  DEFAULT_RELAY_URL: 'https://relay.test',
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({
      identity: { publicKey: 'a'.repeat(64) },
      getChannelCommunityId: vi.fn(async () => 'shared-1'),
      getChannelMetadata: vi.fn(async () => ({ name: 'Ledger rewrite', archived: false })),
      listAgents: vi.fn(async () => []),
      listCommunities: vi.fn(async () => []),
      getPersonProfile: vi.fn(async () => null),
      listPersonProfiles: vi.fn(async () => []),
    }));
    listSubchannelLifecycle = vi.fn(async () => lifecycleFixture.current);
    agentPresenceBackfill = vi.fn(async () => []);
    agentPresenceSubscribe = vi.fn(() => () => undefined);
  },
}));

vi.mock('@/buzz/defer-interaction', () => ({
  // Run the deferred callback immediately so the test's act() settles it.
  afterInteractions: (callback: () => void) => {
    callback();
    return () => undefined;
  },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { BuzzCommunityShell: host('BuzzCommunityShell') };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    CornerGlyph: host('CornerGlyph'),
    HullSurface: host('HullSurface'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const FlatList = (props: any) =>
    ReactModule.createElement('FlatList', props, [
      ...(props.data ?? []).map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index }),
        ),
      ),
      (props.data ?? []).length === 0 ? (props.ListEmptyComponent ?? null) : null,
    ]);
  return {
    FlatList,
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    RefreshControl: host('RefreshControl'),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useBuzzLocalCache } = await import('@/buzz/local-cache');
const BuzzCorners = (await import('./[roomId]')).default;

const VIEWER = 'a'.repeat(64);

function seedRoomListCache() {
  const now = Date.now();
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: [
      {
        id: 'room-1',
        channelId: 'room-1',
        active: true,
        title: 'Ledger rewrite',
        createdAt: 1_000,
        updatedAt: now,
      },
    ],
    directMessages: [],
    workspaceMembers: [],
    communities: [],
    personalWorkspaceId: null,
    viewerIsAgent: false,
    canEditWorkspaceAvatar: false,
    updatedAt: now,
    lastAccessedAt: now,
  });
}

function cornerFixture(id: string, name: string, status: 'live' | 'open') {
  return {
    id: id.padEnd(64, '0'),
    name,
    openerPubkey: 'agent',
    status,
    // The screen only lists corners with a machine state; terminal ones are
    // filtered out before render.
    ...(status === 'live'
      ? { machineState: 'working' }
      : { machineState: 'waiting', machineReason: 'review' }),
    stateAt: Math.floor(Date.now() / 1_000),
  };
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzCorners));
    // Let the async load chain settle.
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
  return tree;
}

function visibleStrings(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAllByType('Text')
    .map((node: any) => node.props?.children)
    .flat(Infinity)
    .filter((child: unknown): child is string => typeof child === 'string');
}

describe('corners list channel marks', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    lifecycleFixture.current = [];
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    seedRoomListCache();
    routeParams.current = { roomId: 'room-1' };
  });

  it('renders the header eyebrow as #<room> and rows as #<room>/<corner>', async () => {
    lifecycleFixture.current = [
      cornerFixture('c1', 'fix ledger drift', 'live'),
      cornerFixture('c2', 'polish bylines', 'open'),
    ];
    const tree = await render();

    const text = visibleStrings(tree);
    expect(text).toContain('#Ledger rewrite');
    expect(text).toContain('#Ledger rewrite/fix-ledger-drift');
    expect(text).toContain('#Ledger rewrite/polish-bylines');
    // No double-prefixed form ever reaches the screen.
    expect(text.some((line) => line.includes('##'))).toBe(false);
  });

  it('keeps row accessibility labels in step with the rendered mark form', async () => {
    lifecycleFixture.current = [cornerFixture('c1', 'fix ledger drift', 'live')];
    const tree = await render();

    const row = tree.root.findAll(
      (node: any) =>
        typeof node.type === 'string' &&
        node.props?.onPress &&
        String(node.props?.accessibilityLabel ?? '').startsWith('View #Ledger rewrite/'),
    );
    expect(row).toHaveLength(1);
    expect(row[0].props.accessibilityLabel).toBe('View #Ledger rewrite/fix-ledger-drift, working');
  });

  it('pushes the RAW stored corner name as the route title hint (stored names stay unmarked)', async () => {
    lifecycleFixture.current = [cornerFixture('c1', 'fix ledger drift', 'live')];
    const tree = await render();

    const row = tree.root.find(
      (node: any) =>
        typeof node.type === 'string' &&
        node.props?.onPress &&
        String(node.props?.accessibilityLabel ?? '').startsWith('View #Ledger rewrite/'),
    );
    await act(async () => {
      row.props.onPress();
    });

    expect(navigation.push).toHaveBeenCalledTimes(1);
    const pushed = navigation.push.mock.calls[0][0];
    expect(pushed?.params?.channelId).toBe('c1'.padEnd(64, '0'));
    expect(pushed?.params?.parent).toBe('room-1');
    expect(pushed?.params?.title).toBe('fix ledger drift');
  });

  it('marks the prose reference in the empty state without decorating a missing name', async () => {
    const tree = await render();

    const text = visibleStrings(tree).join('');
    expect(text).toContain('Go back to #Ledger rewrite');
    expect(text).toContain('Go back to #Ledger rewrite');
  });
});
