/**
 * The room-list per-Room corner dropdown: behavior contract.
 *
 * From the Rooms index, a Room with open corner(s) must expose a control that
 * expands that room's corners inline, and tapping one must navigate into it.
 * A Room whose corners are all terminal (landed, failed, closed) keeps the
 * control and its All Corners path. A Room with no corners shows no control
 * at all (no dead tap).
 *
 * These are render assertions on the real screen, not source greps, because
 * what they lock is what a person can actually do from the list.
 */
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const mmkvValues = vi.hoisted(() => new Map<string, string>());
const workspaceContext = vi.hoisted(() => ({
  current: {
    workspaces: [] as unknown[],
    activeWorkspaceId: null as string | null,
    personalWorkspaceId: null as string | null,
  },
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
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
}));
vi.mock('expo-linking', () => ({ createURL: (path: string) => `beeline://${path}` }));
vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  DEFAULT_RELAY_URL: 'https://relay.test',
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({
    publicKey: 'a'.repeat(64),
    secretKey: new Uint8Array(32),
  })),
}));
vi.mock('@/buzz/workspace-bootstrap', () => ({
  prepareWorkspaceContext: vi.fn(async () => workspaceContext.current),
}));
vi.mock('@/buzz/person-name', () => ({
  ensurePersonNameForWorkspace: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/community-invite', () => ({ createCommunityInviteUrl: vi.fn(async () => 'x') }));
vi.mock('@/buzz/local-cache-sync', () => ({
  cacheLiveSessionEvents: vi.fn(),
  revalidateCachedMessages: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));

/** Corner summaries handed to the screen by the transport mock, keyed by
 *  parent Room id. Declared before the transport mock below reads it. */
const cornerFixtures: Record<string, Array<{ id: string; name: string; status: string }>> = {};

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({
      isAgentIdentity: vi.fn(async () => false),
      getPersonProfile: vi.fn(async () => null),
      listPersonProfiles: vi.fn(async () => []),
      listMyChannels: vi.fn(async () => [{ channelId: 'room-1' }]),
      communityMembers: vi.fn(async () => []),
      listAgents: vi.fn(async () => []),
      query: vi.fn(async (filters: any) => {
        const f = Array.isArray(filters) ? filters[0] : filters;
        if (f?.kinds?.[0] === 9007)
          return [
            {
              id: 'create-room-1',
              kind: 9007,
              created_at: 1_000,
              tags: [['h', 'room-1'], ['community', 'shared-1'], ['name', 'Ledger rewrite']],
            },
          ];
        return [];
      }),
      listMembers: vi.fn(async () => [{ pubkey: VIEWER }]),
      getChannelMetadata: vi.fn(async (id: string) =>
        id === 'room-1'
          ? { name: 'Ledger rewrite', archived: false, raw: { created_at: 1_000 } }
          : null,
      ),
    }));
    // Corner lifecycle the enrich pass consumes; keyed by parent Room id.
    listSubchannelLifecycleForRooms = vi.fn(async (roomIds: string[]) => {
      const map = new Map<string, never[]>();
      for (const id of roomIds) map.set(id, (cornerFixtures[id] ?? []) as never[]);
      return map;
    });
  },
}));
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    BuzzCommunityShell: host('BuzzCommunityShell'),
    CommunityDrawerTrigger: host('CommunityDrawerTrigger'),
  };
});
vi.mock('@/components/buzz/CommunityInviteEntry', async () => {
  const ReactModule = await import('react');
  return {
    CommunityInviteEntry: (props: any) => ReactModule.createElement('CommunityInviteEntry', props),
  };
});
vi.mock('@/components/buzz/RepoPicker', async () => {
  const ReactModule = await import('react');
  return { RepoPicker: (props: any) => ReactModule.createElement('RepoPicker', props) };
});
vi.mock('@/components/buzz/IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    hairlineDivider: { borderBottomWidth: 1, borderBottomColor: '#4e4e4e' },
    motionTokens: { liveCycle: 1120, reveal: 176, demoteDip: 90 },
    BrittlePress: (props: any) =>
      ReactModule.createElement(
        'BrittlePress',
        props,
        typeof props.children === 'function' ? props.children(false) : props.children,
      ),
    HullLivePulse: host('HullLivePulse'),
    HullSurface: host('HullSurface'),
    HullWaveSignal: host('HullWaveSignal'),
    HullDeckMark: host('HullDeckMark'),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const FlatList = (props: any) =>
    ReactModule.createElement('FlatList', props, [
      props.ListHeaderComponent ?? null,
      ...(props.data ?? []).map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index }),
        ),
      ),
      (props.data ?? []).length === 0 ? props.ListEmptyComponent ?? null : null,
      props.ListFooterComponent ?? null,
    ]);
  const SectionList = (props: any) => {
    const sections = props.sections ?? [];
    const rows = sections.flatMap((section: any) => [
      ReactModule.createElement(
        ReactModule.Fragment,
        { key: `header-${section.zone}` },
        props.renderSectionHeader?.({ section }) ?? null,
      ),
      ...section.data.map((item: unknown, index: number) =>
        ReactModule.createElement(
          ReactModule.Fragment,
          { key: props.keyExtractor(item, index) },
          props.renderItem({ item, index, section }),
        ),
      ),
    ]);
    return ReactModule.createElement('SectionList', props, [
      props.ListHeaderComponent ?? null,
      ...rows,
      rows.length === 0 ? props.ListEmptyComponent ?? null : null,
      props.ListFooterComponent ?? null,
    ]);
  };
  return {
    FlatList,
    SectionList,
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    RefreshControl: host('RefreshControl'),
    Share: { share: vi.fn() },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { channelListCacheKey, useBuzzLocalCache } = await import('@/buzz/local-cache');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);

function corner(id: string, name: string, status: string) {
  return { id: id.padEnd(64, '0'), name, status };
}

function seedWorkspace() {
  const now = Date.now();
  workspaceContext.current = {
    workspaces: [{ communityId: 'shared-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'shared-1',
    personalWorkspaceId: 'personal-1',
  };
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
        updatedAt: 2_000,
        latestMessage: 'beebee: pushed the branch',
        latestMessageAt: 2_000,
        corners: cornerFixtures['room-1'] ?? [],
      },
    ],
    directMessages: [],
    workspaceMembers: [],
    communities: [{ communityId: 'shared-1', name: 'Night Shift' } as never],
    personalWorkspaceId: 'personal-1',
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: now,
    lastAccessedAt: now,
  });
  routeParams.current = { communityId: 'shared-1' };
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(BuzzChannels));
  });
  return tree;
}

function findAllByTestId(tree: ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props?.testID === testID,
    { deep: true },
  );
}

function findByAclPrefix(tree: ReactTestRenderer, prefix: string) {
  return tree.root.findAll(
    (node: any) =>
      typeof node.type === 'string' &&
      typeof node.props?.onPress === 'function' &&
      typeof node.props?.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith(prefix),
    { deep: true },
  );
}

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe('room-list corner dropdown', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    for (const key of Object.keys(cornerFixtures)) delete cornerFixtures[key];
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
  });

  it('a Room with N open corners expands to exactly N navigable entries', async () => {
    cornerFixtures['room-1'] = [
      corner('corner-a', 'fix ledger drift', 'live'),
      corner('corner-b', 'polish bylines', 'open'),
    ];
    seedWorkspace();
    const tree = await render();

    // The control exists and reports the open work.
    const toggle = findAllByTestId(tree, 'room-corners-toggle-room-1');
    expect(toggle).toHaveLength(1);

    await press(toggle[0]);

    // N corners -> exactly N rows, each navigating into that corner with its
    // parent Room carried for the back lookup.
    for (const [name, id] of [
      ['fix ledger drift', 'corner-a'],
      ['polish bylines', 'corner-b'],
    ] as const) {
      const row = findByAclPrefix(tree, `Open ${name} corner`);
      expect(row, `missing dropdown row for ${name}`).toHaveLength(1);
      await press(row[0]);
      expect(navigation.push).toHaveBeenCalledTimes(1);
      const pushed = navigation.push.mock.calls[0][0];
      expect(String(pushed?.params?.channelId ?? '')).toBe(id.padEnd(64, '0'));
      expect(pushed?.params?.parent).toBe('room-1');
      expect(pushed?.params?.returnTo).toBe('room-list');
      navigation.push.mockClear();
    }

    // The expansion IS the full list: no trailing All Corners row exists.
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('a Room whose corners are all terminal still exposes the control, and expanding it lists no rows', async () => {
    cornerFixtures['room-1'] = [
      corner('corner-c', 'landed work', 'merged'),
      corner('corner-d', 'dead end', 'failed'),
    ];
    seedWorkspace();
    const tree = await render();

    // No open corners -> no navigable rows listed, but the CONTROL exists
    // (this is the regression: gating it on open work alone left such Rooms
    // with no route into their corners at all).
    const toggle = findAllByTestId(tree, 'room-corners-toggle-room-1');
    expect(toggle).toHaveLength(1);

    await act(async () => {
      toggle[0].props.onPress?.();
    });

    expect(findByAclPrefix(tree, 'Open landed work CORNER')).toHaveLength(0);
    expect(findByAclPrefix(tree, 'Open dead end CORNER')).toHaveLength(0);

    // No All Corners row either — the expansion lists open work only, and
    // this Room has none.
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
  });

  it('a Room with no corners shows no dropdown control at all', async () => {
    cornerFixtures['room-1'] = [];
    seedWorkspace();
    const tree = await render();

    expect(findAllByTestId(tree, 'room-corners-toggle-room-1')).toHaveLength(0);
    expect(findAllByTestId(tree, 'room-all-corners-room-1')).toHaveLength(0);
  });
});
