/**
 * The deck's one headerless activity feed: behavior contract.
 * Needs-you Rooms pin first, then recency; unread changes title weight only.
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
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
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
vi.mock('@/buzz/community-storage', () => ({
  saveLastViewedChannel: vi.fn(async () => undefined),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    // Deliberately minimal: the mount refresh may fail against this stub —
    // these tests render from the seeded local cache, like a cold open.
    ensureClient = vi.fn(async () => ({}));
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
    CornerGlyph: (props: any) => host('CornerGlyph')(props),
    MonoButton: host('MonoButton'),
    PixelGateReveal: host('PixelGateReveal'),
    PixelLoader: host('PixelLoader'),
  };
});
vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  const FlatList = (props: any) => {
    const rows = (props.data ?? []).map((item: unknown, index: number) =>
      ReactModule.createElement(
        ReactModule.Fragment,
        { key: props.keyExtractor(item, index) },
        props.renderItem({ item, index }),
      ),
    );
    return ReactModule.createElement('FlatList', props, [
      props.ListHeaderComponent ?? null,
      ...rows,
      rows.length === 0 ? (props.ListEmptyComponent ?? null) : null,
      props.ListFooterComponent ?? null,
    ]);
  };
  return {
    FlatList,
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
const { useRoomReadState } = await import('@/buzz/room-read-state');
const { default: BuzzChannels } = await import('./channels');

const VIEWER = 'a'.repeat(64);

function corner(id: string, name: string, status: string) {
  return { id: id.padEnd(64, '0'), name, status };
}

type SeedRoom = Record<string, unknown> & { id: string; title: string };

function seedRooms(rooms: SeedRoom[]) {
  const now = Date.now();
  workspaceContext.current = {
    workspaces: [{ communityId: 'shared-1', name: 'Night Shift', viewerRole: 'owner' }],
    activeWorkspaceId: 'shared-1',
    personalWorkspaceId: 'personal-1',
  };
  useBuzzLocalCache.getState().setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'shared-1',
    channels: rooms.map((room) => ({
      channelId: room.id,
      active: true,
      createdAt: 1_000,
      updatedAt: 2_000,
      latestMessage: 'you: noted',
      latestMessageAt: 2_000,
      corners: [],
      ...room,
    })),
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

function titleStyleCounts(tree: ReactTestRenderer, title: string): number[] {
  const nodes = tree.root.findAll(
    (candidate: any) =>
      candidate.type === 'Text' &&
      candidate.children.length === 1 &&
      candidate.children[0] === title,
    { deep: true },
  );
  if (nodes.length === 0) throw new Error(`title not found: ${title}`);
  return nodes.map((node) => [node.props.style].flat().filter(Boolean).length);
}

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe("the deck's one ordered feed", () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    useRoomReadState.setState({ readAt: {} });
  });

  it('pins actionable Rooms first and renders no section headers', async () => {
    seedRooms([
      {
        id: 'review-room',
        title: 'Review room',
        corners: [corner('corner-a', 'ready change', 'open')],
      },
      {
        id: 'working-room',
        title: 'Working room',
        corners: [corner('corner-b', 'live work', 'live')],
      },
      { id: 'quiet-room', title: 'Quiet room' },
    ]);
    const tree = await render();

    const joined = visibleTextOf(tree);
    expect(joined).not.toContain('NEEDS YOU ·');
    expect(joined).not.toContain("DOESN'T NEED YOU ·");
    expect(joined.indexOf('Review room')).toBeLessThan(joined.indexOf('Working room'));
    expect(joined.indexOf('Working room')).toBeLessThan(joined.indexOf('Quiet room'));
  });

  it('pins an asked corner ahead of a merely idle one', async () => {
    seedRooms([
      {
        id: 'asked-room',
        title: 'Asked room',
        corners: [{ ...corner('corner-c', 'which base?', null), awaitingReply: true }],
      },
      {
        id: 'stalled-room',
        title: 'Stalled room',
        corners: [corner('corner-d', 'stalled work', null)],
      },
    ]);
    const tree = await render();
    const joined = visibleTextOf(tree);
    expect(joined.indexOf('Asked room')).toBeLessThan(joined.indexOf('Stalled room'));
    expect(joined).not.toContain('NEEDS YOU ·');
  });

  it('keeps unread out of attention state before and after reading', async () => {
    seedRooms([
      {
        id: 'room-message',
        title: 'Room message',
        latestMessage: 'fresh room-level message',
        latestMessageAt: 9_000,
      },
    ]);
    useRoomReadState.setState({
      readAt: { [`${VIEWER}/room-message`]: 1_000 },
    });
    const tree = await render();

    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(findByAclPrefix(tree, 'Open Room message')[0].props.accessibilityLabel).not.toContain(
      'needs your attention',
    );
    expect(titleStyleCounts(tree, 'Room message')).toContain(2);

    // Reading clears bold activity without touching the idle circle/state.
    await act(async () => {
      useRoomReadState.getState().markRoomRead(VIEWER, 'room-message', 9_000);
    });

    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(findByAclPrefix(tree, 'Open Room message')[0].props.accessibilityLabel).not.toContain(
      'needs your attention',
    );
    expect(titleStyleCounts(tree, 'Room message')).not.toContain(2);
  });

  it('renders finished Rooms inline in the same headerless feed', async () => {
    seedRooms([
      {
        id: 'landed-room',
        title: 'Landed room',
        corners: [
          corner('corner-e', 'landed work', 'merged'),
          corner('corner-f', 'gone', 'archived'),
        ],
      },
      { id: 'closed-room', title: 'Closed room', archived: true },
      { id: 'active-room', title: 'Active room' },
    ]);
    const tree = await render();

    // No collapsed FINISHED pile exists at all: no toggle, no header word.
    expect(findAllByTestId(tree, 'finished-rooms-toggle')).toHaveLength(0);
    expect(visibleTextOf(tree)).not.toContain('FINISHED');
    // Finished rows render inline through the same renderer as every other
    // Room — reachable directly, no expansion step.
    expect(findByAclPrefix(tree, 'Open Landed room')).toHaveLength(1);
    expect(findByAclPrefix(tree, 'Open Closed room')).toHaveLength(1);
    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(visibleTextOf(tree)).not.toContain("DOESN'T NEED YOU ·");

    // Tapping one navigates into the Room itself.
    await press(findByAclPrefix(tree, 'Open Landed room')[0]);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(String(navigation.push.mock.calls[0][0])).toContain('landed-room');
  });

  it('orders DMs by activity while unread remains typography only', async () => {
    seedRooms([]);
    const existing = useBuzzLocalCache.getState().channelLists;
    const key = Object.keys(existing)[0];
    const entry = existing[key!];
    useBuzzLocalCache.setState({
      channelLists: {
        ...existing,
        [key!]: {
          ...entry!,
          directMessages: [
            {
              id: 'dm-read-id',
              peerPubkey: 'b'.repeat(64),
              peerName: 'Read Peer',
              peerKind: 'person' as const,
              latestMessage: 'earlier hello',
              latestMessageAt: 2_000,
              updatedAt: 2_000,
            },
            {
              id: 'dm-unread-id',
              peerPubkey: 'c'.repeat(64),
              peerName: 'New Peer',
              peerKind: 'person' as const,
              latestMessage: 'fresh ping',
              latestMessageAt: 9_000,
              updatedAt: 9_000,
            },
          ],
        },
      },
    });
    // Seed the read marks directly into the store: the unread DM has an older
    // mark than its newest message; the read DM's mark is past its newest.
    useRoomReadState.setState({
      readAt: {
        [`${VIEWER}/dm-read-id`]: 5_000,
        [`${VIEWER}/dm-unread-id`]: 1_000,
      },
    });
    const tree = await render();

    const joined = visibleTextOf(tree);
    // No section header exists; both DMs live in the one recency feed.
    expect(joined).not.toContain('DIRECT ·');
    expect(joined).not.toContain('NEEDS YOU ·');
    expect(joined).not.toContain("DOESN'T NEED YOU ·");
    expect(joined.indexOf('New Peer')).toBeLessThan(joined.indexOf('Read Peer'));
    expect(findByAclPrefix(tree, 'Open direct message with New Peer')).toHaveLength(1);
    expect(findByAclPrefix(tree, 'Open direct message with Read Peer')).toHaveLength(1);
    expect(
      findByAclPrefix(tree, 'Open direct message with New Peer')[0].props.accessibilityLabel,
    ).not.toContain('needs your attention');
    expect(
      findByAclPrefix(tree, 'Open direct message with Read Peer')[0].props.accessibilityLabel,
    ).not.toContain('needs your attention');
  });
});

/** Every string this tree puts in front of a person, including spoken labels. */
function visibleTextOf(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const collect = (instance: any) => {
    for (const key of ['accessibilityLabel', 'placeholder']) {
      const value = instance.props?.[key];
      if (typeof value === 'string') out.push(value);
    }
    for (const child of instance.children ?? []) {
      if (typeof child === 'string') out.push(child);
      else collect(child);
    }
  };
  collect(tree.root);
  return out.join('');
}
