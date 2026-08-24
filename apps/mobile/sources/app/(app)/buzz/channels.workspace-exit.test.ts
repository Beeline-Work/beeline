/**
 * Workspace exit gesture (nav-bar tiles): behavior contract.
 *
 * Long-pressing a Workspace tile in the switcher rail arms an exit affordance
 * (an × on that tile's top-right corner ONLY). Pressing it opens a confirm
 * dialog; confirming publishes the self-authored leave through the transport
 * and removes the Workspace locally; cancelling — or tapping anywhere else —
 * dismisses the affordance without leaving.
 *
 * Render assertions on the real screen and the real rail, not source greps.
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
  revalidateCachedMessages: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));

const leaveWorkspace = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => ({
      isAgentIdentity: vi.fn(async () => false),
      getPersonProfile: vi.fn(async () => null),
      listMyChannels: vi.fn(async () => []),
      communityMembers: vi.fn(async () => []),
      listAgents: vi.fn(async () => []),
      listMembers: vi.fn(async () => []),
    }));
    leaveWorkspace = leaveWorkspace;
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
const { Alert } = await import('react-native');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);

function seedWorkspace() {
  const now = Date.now();
  workspaceContext.current = {
    workspaces: [
      { communityId: 'shared-1', name: 'Night Shift' },
      { communityId: 'other-2', name: 'Day Shift' },
    ],
    activeWorkspaceId: 'shared-1',
    personalWorkspaceId: 'personal-1',
  };
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: [],
    directMessages: [],
    workspaceMembers: [],
    communities: [
      { communityId: 'shared-1', name: 'Night Shift' },
      { communityId: 'other-2', name: 'Day Shift' },
    ] as never[],
    personalWorkspaceId: 'personal-1',
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

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

async function longPress(node: any) {
  await act(async () => {
    node.props.onLongPress?.();
  });
}

/** Open the drawer, long-press one tile, press its × and hand back the dialog. */
async function openConfirmDialog(tree: ReactTestRenderer, communityId: string) {
  await press(findAllByTestId(tree, 'workspace-avatar-trigger')[0]);
  expect(findAllByTestId(tree, 'community-drawer-overlay')).toHaveLength(1);
  await longPress(findAllByTestId(tree, `community-rail-${communityId}`)[0]);
  expect(findAllByTestId(tree, `workspace-exit-${communityId}`)).toHaveLength(1);
  await press(findAllByTestId(tree, `workspace-exit-${communityId}`)[0]);
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = vi.mocked(Alert.alert).mock.calls[0];
  return { title: String(title), message: String(message), buttons: buttons as any[] };
}

describe('workspace exit gesture', () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.replace.mockClear();
    vi.mocked(Alert.alert).mockClear();
    leaveWorkspace.mockClear();
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
  });

  it('long-press exposes the exit × on that tile only; tapping elsewhere dismisses it', async () => {
    seedWorkspace();
    const tree = await render();

    // No × anywhere before the gesture.
    expect(findAllByTestId(tree, 'workspace-exit-shared-1')).toHaveLength(0);
    expect(findAllByTestId(tree, 'workspace-exit-other-2')).toHaveLength(0);

    await press(findAllByTestId(tree, 'workspace-avatar-trigger')[0]);
    await longPress(findAllByTestId(tree, 'community-rail-shared-1')[0]);

    // The armed tile shows its ×; the sibling does not.
    expect(findAllByTestId(tree, 'workspace-exit-shared-1')).toHaveLength(1);
    expect(findAllByTestId(tree, 'workspace-exit-other-2')).toHaveLength(0);

    // Tapping elsewhere (another tile) dismisses without selecting.
    await press(findAllByTestId(tree, 'community-rail-other-2')[0]);
    expect(findAllByTestId(tree, 'workspace-exit-shared-1')).toHaveLength(0);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('the confirm dialog names the workspace and what leaving means', async () => {
    seedWorkspace();
    const tree = await render();
    const { title, message, buttons } = await openConfirmDialog(tree, 'shared-1');

    expect(title).toBe('Exit Night Shift?');
    expect(message).toMatch(/removes this Workspace from your list/i);
    expect(message).toMatch(/re-invited later/i);

    const cancel = buttons.find((button) => button.text === 'Cancel');
    const exit = buttons.find((button) => button.text === 'Exit');
    expect(cancel?.style).toBe('cancel');
    expect(exit?.style).toBe('destructive');
  });

  it('cancel dismisses the dialog and leaves nothing', async () => {
    seedWorkspace();
    const tree = await render();
    const { buttons } = await openConfirmDialog(tree, 'shared-1');

    await act(async () => {
      buttons.find((button) => button.text === 'Cancel')?.onPress?.();
    });

    expect(leaveWorkspace).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('confirm publishes the leave and removes the workspace locally', async () => {
    seedWorkspace();
    const tree = await render();
    const { buttons } = await openConfirmDialog(tree, 'shared-1');

    await act(async () => {
      buttons.find((button) => button.text === 'Exit')?.onPress?.();
    });

    expect(leaveWorkspace).toHaveBeenCalledWith('shared-1');

    // The left workspace is gone from the nav; the other remains.
    const shell = tree.root.findByProps({ testID: 'workspace-avatar-trigger' });
    void shell;
    const railTiles = [
      findAllByTestId(tree, 'community-rail-shared-1'),
      findAllByTestId(tree, 'community-rail-other-2'),
    ];
    expect(railTiles[0].length > 0 || railTiles[1].length > 0).toBe(true);

    // Locally removed: after the drawer reopens, only the remaining tile exists.
    if (findAllByTestId(tree, 'community-drawer-overlay').length === 0) {
      await press(findAllByTestId(tree, 'workspace-avatar-trigger')[0]);
    }
    expect(findAllByTestId(tree, 'community-rail-shared-1')).toHaveLength(0);
    expect(findAllByTestId(tree, 'community-rail-other-2').length).toBeGreaterThan(0);

    // Leaving the ACTIVE workspace switches to a remaining one.
    expect(navigation.replace).toHaveBeenCalled();
  });

  it('a failed leave surfaces honestly instead of removing anything', async () => {
    seedWorkspace();
    leaveWorkspace.mockRejectedValueOnce(
      new Error(
        'You are the only owner of this Workspace. Promote another member to owner before leaving.',
      ),
    );
    const tree = await render();
    const { buttons } = await openConfirmDialog(tree, 'shared-1');

    await act(async () => {
      buttons.find((button) => button.text === 'Exit')?.onPress?.();
    });

    expect(leaveWorkspace).toHaveBeenCalledWith('shared-1');
    // Second alert: the honest failure, quoting the rule.
    expect(vi.mocked(Alert.alert).mock.calls.length).toBeGreaterThanOrEqual(2);
    const failure = vi.mocked(Alert.alert).mock.calls.at(-1)!;
    expect(String(failure[0])).toMatch(/Could not exit/);
    expect(String(failure[1])).toMatch(/only owner/);

    // Nothing was removed locally.
    await press(findAllByTestId(tree, 'workspace-avatar-trigger')[0]);
    if (findAllByTestId(tree, 'community-drawer-overlay').length === 0) {
      await press(findAllByTestId(tree, 'workspace-avatar-trigger')[0]);
    }
    expect(findAllByTestId(tree, 'community-rail-shared-1').length).toBeGreaterThan(0);
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
