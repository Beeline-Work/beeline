/**
 * The deck's EXACTLY TWO piles: behavior contract.
 *
 * Owner spec 2026-08-23 (two-pile refinement): NEEDS YOU — a corner ask/gate,
 * a live review target, or an unread ROOM/DM message; and DOESN'T NEED YOU —
 * everything else, working AND finished Rooms included. There is no collapsed
 * FINISHED entry (finished Rooms render inline like any other quiet Room) and
 * no DIRECT pile (DMs obey the same unread rule).
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

async function press(node: any) {
  await act(async () => {
    node.props.onPress?.();
  });
}

describe("the deck's exactly two piles", () => {
  beforeEach(() => {
    mmkvValues.clear();
    navigation.push.mockClear();
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    useRoomReadState.setState({ readAt: {} });
  });

  it("zones actionable rooms into NEEDS YOU and everything else into DOESN'T NEED YOU", async () => {
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

    const labels = ['NEEDS YOU · 1', "DOESN'T NEED YOU · 2"];
    const joined = visibleTextOf(tree);
    for (const label of labels) {
      expect(joined, `missing tier header ${label}`).toContain(label);
    }
  });

  it("keeps an asked-but-stalled corner in NEEDS YOU and a merely idle one in DOESN'T NEED YOU", async () => {
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
    expect(joined).toContain('NEEDS YOU · 1');
    expect(joined).toContain("DOESN'T NEED YOU · 1");
  });

  it("moves an unread Room message into NEEDS YOU, then back after the viewer reads it", async () => {
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

    expect(visibleTextOf(tree)).toContain('NEEDS YOU · 1');
    expect(visibleTextOf(tree)).not.toContain("DOESN'T NEED YOU ·");
    expect(findByAclPrefix(tree, 'Open Room message')[0].props.accessibilityLabel).toContain(
      'needs your attention',
    );

    // Exercise the real read-state action the screen uses on return from the
    // Room. The same row must immediately fall into the quiet pile when no
    // corner gate or review target remains.
    await act(async () => {
      useRoomReadState.getState().markRoomRead(VIEWER, 'room-message', 9_000);
    });

    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(visibleTextOf(tree)).toContain("DOESN'T NEED YOU · 1");
    expect(findByAclPrefix(tree, 'Open Room message')[0].props.accessibilityLabel).not.toContain(
      'needs your attention',
    );
  });

  it("renders finished Rooms INLINE as ordinary members of DOESN'T NEED YOU", async () => {
    seedRooms([
      {
        id: 'landed-room',
        title: 'Landed room',
        corners: [corner('corner-e', 'landed work', 'merged'), corner('corner-f', 'gone', 'archived')],
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
    expect(visibleTextOf(tree)).toContain("DOESN'T NEED YOU · 3");
    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');

    // Tapping one navigates into the Room itself.
    await press(findByAclPrefix(tree, 'Open Landed room')[0]);
    expect(navigation.push).toHaveBeenCalledTimes(1);
    expect(String(navigation.push.mock.calls[0][0])).toContain('landed-room');
  });

  it("puts an unread DM in NEEDS YOU and a read one in DOESN'T NEED YOU — no DIRECT pile", async () => {
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
    // No DIRECT header exists; both DMs live in the same two piles as Rooms.
    expect(joined).not.toContain('DIRECT ·');
    expect(joined).toContain('NEEDS YOU · 1');
    expect(joined).toContain("DOESN'T NEED YOU · 1");
    // The unread DM is the pile's occupant; the read DM sits below.
    expect(findByAclPrefix(tree, 'Open direct message with New Peer')).toHaveLength(1);
    expect(findByAclPrefix(tree, 'Open direct message with Read Peer')).toHaveLength(1);
    expect(findByAclPrefix(tree, 'Open direct message with New Peer')[0].props.accessibilityLabel).toContain(
      'needs your attention',
    );
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
