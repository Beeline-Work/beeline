/**
 * Deleted/left Rooms stay deleted locally (owner-reported 2026-08-23).
 *
 * Deleting a Room succeeds on the relay, but an archived Room is deliberately
 * DOESN'T NEED YOU deck state and — in the already-archived case (#396) — the leave
 * publish is refused outright, so the membership projection can keep naming us
 * and every refresh re-materialized the row forever: delete → navigated out →
 * row persists → tap → navigated out → … The durable per-viewer tombstone in
 * `removed-rooms.ts` plus the immediate cache purge must keep the row out of
 * the deck across navigation, refresh, and app restart.
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
    Easing: { bezier: vi.fn(), out: (value: unknown) => value, poly: vi.fn() },
    ReduceMotion: { System: 'system' },
    runOnJS: (fn: (...args: any[]) => unknown) => fn,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(true);
      return value;
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
  isAgentIdentity: vi.fn(async () => false),
}));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => clientMocks);
    listSubchannelLifecycleForRooms = vi.fn(async () => new Map());
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
vi.mock('@/components/buzz/HullDialog', async () => {
  const ReactModule = await import('react');
  return {
    HullDialog: (props: any) =>
      props.visible ? ReactModule.createElement('HullDialog', props, props.children) : null,
    HullDialogInput: (props: any) => ReactModule.createElement('HullDialogInput', props),
  };
});
vi.mock('@/modal', () => ({
  Modal: { alert: vi.fn(), confirm: vi.fn(async () => false) },
}));
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

const { channelListCacheKey, useBuzzLocalCache } = await import('@/buzz/local-cache');
const { useRemovedRooms } = await import('@/buzz/removed-rooms');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);
const KEPT = 'kept-room-id';
const DELETED = 'deleted-room-id';

/** The relay still knows both Rooms — including the deleted one, whose leave
 * publish the relay refused (#396 already-archived case), so its membership
 * projection still names this viewer. */
function mockRelayStillReturnsBothRooms() {
  clientMocks.query.mockImplementation(
    async () =>
      [
        {
          id: 'e1',
          kind: 9007,
          pubkey: VIEWER,
          created_at: 100,
          tags: [
            ['h', KEPT],
            ['community', 'shared-1'],
          ],
        },
        {
          id: 'e2',
          kind: 9007,
          pubkey: VIEWER,
          created_at: 101,
          tags: [
            ['h', DELETED],
            ['community', 'shared-1'],
          ],
        },
      ] as never,
  );
  clientMocks.listMyChannels.mockResolvedValue([{ channelId: KEPT }, { channelId: DELETED }]);
  clientMocks.getChannelMetadata.mockImplementation(async (id: string) =>
    id === DELETED ? { archived: true } : { archived: false },
  );
}

function seedLocalCache() {
  const now = Date.now();
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: [
      { id: KEPT, active: true, title: 'Kept Room', updatedAt: now },
      { id: DELETED, active: false, archived: true, title: 'Deleted Room', updatedAt: now },
    ],
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
  // Let the mount refresh run to completion: basics read both Rooms off the
  // relay and write them back into the cached list.
  await vi.waitFor(() => expect(clientMocks.getChannelMetadata).toHaveBeenCalledWith(DELETED));
  await act(async () => {});
  return tree;
}

describe('deleted Rooms stay deleted locally', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.replace.mockClear();
    Object.values(clientMocks).forEach((mock) => mock.mockReset());
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    useRemovedRooms.setState({ removedAt: {} });
  });

  it('a tombstoned Room has no tappable row even after a refresh re-materializes it', async () => {
    seedLocalCache();
    // The delete path recorded the durable tombstone before navigating back.
    useRemovedRooms.getState().markRoomRemoved(VIEWER, DELETED);
    // The relay still knows BOTH Rooms — the already-archived delete (#396)
    // refused the leave publish, so the membership projection names us still.
    mockRelayStillReturnsBothRooms();

    const tree = await renderAndWaitForRefresh();

    // No tappable row for the removed Room; the other Room is untouched.
    expect(findAllByTestId(tree, `room-${DELETED}`)).toHaveLength(0);
    expect(findAllByTestId(tree, `room-${KEPT}`)).toHaveLength(1);
    // And the retired FINISHED-pile control cannot leak it either.
    expect(findAllByTestId(tree, 'finished-rooms-toggle')).toHaveLength(0);
  });

  it("without a tombstone the same archived Room stays inline in DOESN'T NEED YOU", async () => {
    seedLocalCache();
    mockRelayStillReturnsBothRooms();

    const tree = await renderAndWaitForRefresh();

    // Archived-but-not-removed Rooms remain directly visible in the uniform
    // unified Room feed — this fix hides only explicit local removals.
    expect(findAllByTestId(tree, 'finished-rooms-toggle')).toHaveLength(0);
    expect(findAllByTestId(tree, `room-${DELETED}`).length).toBeGreaterThan(0);
  });
});
