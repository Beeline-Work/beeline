/**
 * Closing a corner removes it from the owner's local view durably
 * (owner-reported 2026-08-23; parallel to #402's Room tombstones).
 *
 * The close button publishes `#t=buzz-corner-close` and the daemon archives
 * the channel on its NEXT maintenance tick — up to a minute later. Until that
 * lands, relay state still says "open", so the deck's corner count and
 * dropdown kept showing dismissed work as enterable live work. The durable
 * per-viewer tombstone in `closed-corners.ts` plus the immediate cache purge
 * must keep a CLOSED corner out of the deck across navigation, refresh, and
 * app restart — including when the relay never catches up (daemon offline) or
 * answers a no-op archive (#396 semantics).
 *
 * Render assertions on the real screen, not source greps.
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
    workspaces: [{ communityId: 'shared-1', name: 'Night Shift' }],
    activeWorkspaceId: 'shared-1' as string | null,
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
vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: { View: host('AnimatedView') },
    Easing: { bezier: vi.fn(), out: vi.fn(), poly: vi.fn() },
    ReduceMotion: { System: 'system' },
    runOnJS: (fn: (...args: any[]) => unknown) => fn,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(true);
      return { __withTiming: true };
    },
  };
});
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
  cacheLiveSessionEvent: vi.fn(),
  loadOlderMessages: vi.fn(),
  refreshRoomCornerCache: vi.fn(
    async (transport: any, _viewerPubkey: string, roomIds: string[]) =>
      transport.listSubchannelLifecycleForRooms(roomIds),
  ),
  revalidateCachedMessages: vi.fn(async () => ({ entry: {} })),
}));
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));

const clientMocks = vi.hoisted(() => ({
  query: vi.fn(async () => []),
  listMyChannels: vi.fn(async () => [] as { channelId: string }[]),
  getChannelMetadata: vi.fn(async (_id: string) => null as { archived?: boolean } | null),
  communityMembers: vi.fn(async () => []),
  listAgents: vi.fn(async () => []),
  listMembers: vi.fn(async () => []),
  getPersonProfile: vi.fn(async () => null),
  listPersonProfiles: vi.fn(async () => []),
  listDirectMessages: vi.fn(async () => []),
  isAgentIdentity: vi.fn(async () => false),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => clientMocks);
    // The RELAY still reports BOTH corners as open work — this is exactly the
    // window between the close publish and the daemon's next maintenance tick
    // (or forever, if the daemon is down). Local dismissal must win.
    listSubchannelLifecycleForRooms = vi.fn(
      async () =>
        new Map([
          [
            'room-with-corners',
            [
              {
                id: 'corner-closed',
                name: 'Closed Work',
                openerPubkey: 'b'.repeat(64),
                status: 'live',
                machineState: 'working',
                stateAt: Math.floor(Date.now() / 1_000),
              },
              {
                id: 'corner-open',
                name: 'Open Work',
                openerPubkey: 'b'.repeat(64),
                status: 'live',
                machineState: 'working',
                stateAt: Math.floor(Date.now() / 1_000),
              },
            ],
          ],
        ]),
    );
    roomRepositoryState = vi.fn(async () => undefined);
  },
}));
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
vi.mock('@/components/buzz/RoomDeckComposeMenu', async () => {
  const ReactModule = await import('react');
  return {
    RoomDeckComposeMenu: (props: any) => ReactModule.createElement('RoomDeckComposeMenu', props),
  };
});
vi.mock('@/components/buzz/DirectMessagePickerSheet', async () => {
  const ReactModule = await import('react');
  return {
    DirectMessagePickerSheet: (props: any) =>
      ReactModule.createElement('DirectMessagePickerSheet', props),
  };
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
    CornerGlyph: host('CornerGlyph'),
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
      (props.data ?? []).length === 0 ? (props.ListEmptyComponent ?? null) : null,
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
      rows.length === 0 ? (props.ListEmptyComponent ?? null) : null,
      props.ListFooterComponent ?? null,
    ]);
  };
  return {
    Alert: { alert: vi.fn() },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    FlatList,
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
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

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { useBuzzLocalCache } = await import('@/buzz/local-cache');
const { useClosedCorners } = await import('@/buzz/closed-corners');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);
const ROOM = 'room-with-corners';

/** The relay still knows the Room and lists both its corners as open work —
 * exactly the pre-daemon-tick window (or daemon-offline forever). */
function mockRelayStillReturnsRoom() {
  clientMocks.query.mockImplementation(
    async () =>
      [
        {
          id: 'e1',
          kind: 9007,
          pubkey: VIEWER,
          created_at: 100,
          tags: [
            ['h', ROOM],
            ['community', 'shared-1'],
          ],
        },
      ] as never,
  );
  clientMocks.listMyChannels.mockResolvedValue([{ channelId: ROOM }]);
  clientMocks.getChannelMetadata.mockResolvedValue({ archived: false });
}

function seedLocalCache() {
  const now = Date.now();
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: [{ id: ROOM, active: true, title: 'Work Room', updatedAt: now }],
    directMessages: [],
    workspaceMembers: [],
    communities: [{ communityId: 'shared-1', name: 'Night Shift' } as never],
    personalWorkspaceId: null,
    viewerIsAgent: false,
    canEditWorkspaceAvatar: false,
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

async function renderAndWaitForRefresh(): Promise<ReactTestRenderer> {
  const tree = await render();
  await act(async () => {});
  return tree;
}

describe('closed corners stay closed locally', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.replace.mockClear();
    Object.values(clientMocks).forEach((mock) => mock.mockReset());
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    useClosedCorners.setState({ closedAt: {} });
    seedLocalCache();
    mockRelayStillReturnsRoom();
  });

  it('a closed corner drops out of the count and dropdown immediately, before the daemon ticks', async () => {
    useClosedCorners.getState().markCornerClosed(VIEWER, ROOM, 'corner-closed');

    const tree = await renderAndWaitForRefresh();

    // One open corner left: the gutter count reflects local dismissal even
    // though the relay still lists both corners as open.
    const toggle = findAllByTestId(tree, `room-corners-toggle-${ROOM}`);
    expect(toggle).toHaveLength(1);
    expect(textUnder(toggle[0])).toContain('1');

    await act(async () => {
      toggle[0].props.onPress?.();
    });
    const labels = JSON.stringify(tree.root.props ?? '');
    void labels;
    const rendered = JSON.stringify(renderRowTexts(tree));
    expect(rendered).not.toContain('Closed Work');
    expect(rendered).toContain('Open Work');
  });

  it('without a tombstone the same corner is still listed until the relay agrees', async () => {
    const tree = await renderAndWaitForRefresh();
    const toggle = findAllByTestId(tree, `room-corners-toggle-${ROOM}`);
    expect(toggle).toHaveLength(1);
    // This fix hides only explicit local dismissals.
    expect(textUnder(toggle[0])).toContain('2');
    await act(async () => {
      toggle[0].props.onPress?.();
    });
    const rendered = JSON.stringify(renderRowTexts(tree));
    expect(rendered).toContain('Open Work');
    expect(rendered).toContain('Closed Work');
  });

  it('re-marking an already-tombstoned corner keeps removal stuck (#396 no-op-archive semantics)', async () => {
    useClosedCorners.getState().markCornerClosed(VIEWER, ROOM, 'corner-closed');
    useClosedCorners.getState().markCornerClosed(VIEWER, ROOM, 'corner-closed');

    const tree = await renderAndWaitForRefresh();

    const rendered = JSON.stringify(renderRowTexts(tree));
    expect(rendered).not.toContain('Closed Work');
    expect(useClosedCorners.getState().closedAt[`${VIEWER}/${ROOM}/corner-closed`]).toBeTypeOf(
      'number',
    );
  });
});

/** Every string rendered under one node, concatenated. */
function textUnder(node: any): string {
  let out = '';
  for (const child of (node as { children?: unknown[] }).children ?? []) {
    if (typeof child === 'string' || typeof child === 'number') out += String(child);
    else out += textUnder(child);
  }
  return out;
}

/** Flatten every rendered Text string out of the tree (each counted once). */
function renderRowTexts(tree: ReactTestRenderer): string[] {
  const texts: string[] = [];
  for (const node of tree.root.findAll(() => true, { deep: true })) {
    for (const child of (node as any).children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') texts.push(String(child));
    }
  }
  return texts.filter((text) => text.trim().length > 0);
}
