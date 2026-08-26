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

import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  type SessionUpdate,
} from '@beeline/buzz-client';

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const mmkvValues = vi.hoisted(() => new Map<string, string>());
const transportHarness = vi.hoisted(() => ({ completeBootstrap: false }));
const workspaceContext = vi.hoisted(() => ({
  current: {
    workspaces: [] as unknown[],
    activeWorkspaceId: null as string | null,
    personalWorkspaceId: null as string | null,
    cacheReconciliation: undefined as 'authoritative' | 'preserve' | undefined,
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
vi.mock('@/buzz/local-cache-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/local-cache-sync')>()),
  cacheLiveSessionEvents: vi.fn(),
  revalidateCachedMessages: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/defer-interaction', () => ({ afterInteractions: () => () => undefined }));
vi.mock('@/buzz/community-storage', () => ({
  saveLastViewedChannel: vi.fn(async () => undefined),
}));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    ensureClient = vi.fn(async () => {
      const base = { isAgentIdentity: vi.fn(async () => false) };
      if (!transportHarness.completeBootstrap) return base;
      return {
        ...base,
        query: vi.fn(async () => [
          {
            id: 'tubing-room-create',
            pubkey: 'a'.repeat(64),
            created_at: 1_000,
            kind: 9_007,
            tags: [
              ['h', 'tubing-room'],
              ['community', 'tubing-1'],
              ['name', 'Tubing Room'],
            ],
            content: '',
            sig: 'verified',
          },
        ]),
        listMyChannels: vi.fn(async () => [{ channelId: 'tubing-room' }]),
        getChannelMetadata: vi.fn(async () => ({ name: 'Tubing Room' })),
        communityMembers: vi.fn(async () => []),
        listAgents: vi.fn(async () => []),
        getPersonProfile: vi.fn(async () => null),
        listPersonProfiles: vi.fn(async () => []),
        listDirectMessages: vi.fn(async () => []),
      };
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
    ScrollView: host('ScrollView'),
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
const { prepareWorkspaceContext } = await import('@/buzz/workspace-bootstrap');
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
    cacheReconciliation: undefined,
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

function seedSplitWorkspaceCache() {
  const now = Date.now();
  const tubing = { communityId: 'tubing-1', name: 'Tubing Crew' } as never;
  const personal = { communityId: 'personal-1', name: 'Personal' } as never;
  const cache = useBuzzLocalCache.getState();
  cache.setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'tubing-1',
    channels: [
      {
        id: 'tubing-room',
        title: 'Tubing Room',
        communityId: 'tubing-1',
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ],
    directMessages: [],
    workspaceMembers: [],
    communities: [tubing],
    personalWorkspaceId: null,
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: now,
    lastAccessedAt: now,
  });
  cache.setChannelList({
    viewerPubkey: VIEWER,
    communityId: 'personal-1',
    channels: [],
    directMessages: [],
    workspaceMembers: [],
    communities: [personal],
    personalWorkspaceId: 'personal-1',
    viewerIsAgent: false,
    canEditWorkspaceAvatar: true,
    updatedAt: now,
    lastAccessedAt: now,
  });
  routeParams.current = { communityId: 'personal-1' };
}

function shellWorkspaceIds(tree: ReactTestRenderer): string[] {
  const shell = tree.root.find((node: any) => node.type === 'BuzzCommunityShell');
  return shell.props.communities.map((community: { communityId: string }) => community.communityId);
}

function agentTurn(
  roomId: string,
  status: 'working' | 'complete',
  createdAt: number,
): SessionUpdate {
  const agentPubkey = 'b'.repeat(64);
  return {
    type: 'session-update',
    eventId: `${roomId}-turn-${status}-${createdAt}`,
    authorPubkey: agentPubkey,
    createdAt,
    sourceKind: 9,
    signature: 'verified',
    scope: 'channel',
    channelId: roomId,
    workspaceId: 'shared-1',
    sessionId: `${roomId}-session`,
    update: {
      kind: 'turn',
      agentPubkey,
      requestId: `${roomId}-request`,
      status,
    },
  } as SessionUpdate;
}

function roomDeckState(tree: ReactTestRenderer, roomId: string): string {
  const row = findAllByTestId(tree, `room-${roomId}`)[0];
  if (!row) throw new Error(`room row not found: ${roomId}`);
  const marks = row.findAll((node: any) => node.type === 'HullDeckMark', { deep: true });
  if (marks.length !== 1) throw new Error(`expected one deck mark for ${roomId}`);
  return marks[0]!.props.state;
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
    transportHarness.completeBootstrap = false;
    useBuzzLocalCache.setState({ channelLists: {}, channels: {} } as never);
    useRoomReadState.setState({ readAt: {} });
    vi.mocked(prepareWorkspaceContext).mockImplementation(async () => workspaceContext.current);
  });

  it('turns a never-settling cold-cache relay read into a retryable empty list', async () => {
    vi.useFakeTimers();
    vi.mocked(prepareWorkspaceContext).mockImplementation(() => new Promise(() => undefined));

    try {
      const tree = await render();
      expect(visibleTextOf(tree)).toContain('CONNECTING TO RELAY');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_001);
      });

      const text = visibleTextOf(tree);
      expect(text).not.toContain('CONNECTING TO RELAY');
      expect(text).toContain("Couldn't reach relay");
      expect(findAllByTestId(tree, 'room-list')).toHaveLength(1);

      const retry = tree.root.find(
        (node: any) => node.type === 'MonoButton' && node.props.label === 'RETRY',
      );
      expect(retry).toBeDefined();
      await press(retry);
      expect(prepareWorkspaceContext).toHaveBeenCalledTimes(2);
      tree.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['throws', () => Promise.reject(new Error('relay unavailable'))],
    ['times out', () => new Promise(() => undefined)],
  ])('keeps every locally cached Workspace visible when live discovery %s', async (_, failure) => {
    vi.useFakeTimers();
    seedSplitWorkspaceCache();
    vi.mocked(prepareWorkspaceContext).mockImplementation(failure as never);

    try {
      const tree = await render();
      expect(shellWorkspaceIds(tree)).toEqual(['tubing-1', 'personal-1']);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_001);
      });

      expect(shellWorkspaceIds(tree)).toEqual(['tubing-1', 'personal-1']);
      tree.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not commit a discovery that settles after the cold-open timeout', async () => {
    vi.useFakeTimers();
    seedSplitWorkspaceCache();
    const commitSelection = vi.fn(async () => undefined);
    const tubing = { communityId: 'tubing-1', name: 'Tubing Crew' } as never;
    vi.mocked(prepareWorkspaceContext).mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                workspaces: [tubing],
                activeWorkspaceId: 'tubing-1',
                personalWorkspaceId: null,
                cacheReconciliation: 'authoritative',
                commitSelection,
              }),
            8_100,
          );
        }),
    );

    try {
      const tree = await render();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(8_001);
      });
      expect(shellWorkspaceIds(tree)).toEqual(['tubing-1', 'personal-1']);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(commitSelection).not.toHaveBeenCalled();
      expect(shellWorkspaceIds(tree)).toEqual(['tubing-1', 'personal-1']);
      expect(useBuzzLocalCache.getState().channelLists[`${VIEWER}:personal-1`]).toBeDefined();
      tree.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows only authoritative Workspaces and evicts a stale active deck', async () => {
    seedSplitWorkspaceCache();
    transportHarness.completeBootstrap = true;
    const tubing = { communityId: 'tubing-1', name: 'Tubing Crew' } as never;
    workspaceContext.current = {
      workspaces: [tubing],
      activeWorkspaceId: 'tubing-1',
      personalWorkspaceId: null,
      cacheReconciliation: 'authoritative',
    };

    const tree = await render();

    expect(shellWorkspaceIds(tree)).toEqual(['tubing-1']);
    const shell = tree.root.find((node: any) => node.type === 'BuzzCommunityShell');
    expect(shell.props.activeCommunityId).toBe('tubing-1');
    expect(visibleTextOf(tree)).toContain('Tubing Room');
    const cache = useBuzzLocalCache.getState();
    expect(cache.channelLists[`${VIEWER}:personal-1`]).toBeUndefined();
    expect(cache.activeListKeyByViewer[VIEWER]).toBe(`${VIEWER}:tubing-1`);
    expect(cache.channelLists[`${VIEWER}:tubing-1`]?.personalWorkspaceId).toBeNull();
    tree.unmount();
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

  it('paints a stored Room-own working turn on first paint and settles on completion', async () => {
    const roomId = 'already-working-room';
    seedRooms([{ id: roomId, title: 'Already working' }]);
    const working = reduceWorkspaceEvents(createWorkspaceSnapshot({ workspaceId: 'shared-1' }), [
      agentTurn(roomId, 'working', 3_000),
    ]);
    // Store the lifecycle before mount. `useFocusEffect` is a no-op in this
    // harness, so the row cannot pass by witnessing a live transition.
    useBuzzLocalCache.getState().replaceSnapshot(VIEWER, roomId, working, 3_000);

    const tree = await render();
    expect(roomDeckState(tree, roomId)).toBe('working');
    expect(findByAclPrefix(tree, 'Open #Already working')[0].props.accessibilityLabel).toContain(
      'agent working',
    );

    const complete = reduceWorkspaceEvents(working, [agentTurn(roomId, 'complete', 3_001)]);
    await act(async () => {
      useBuzzLocalCache.getState().replaceSnapshot(VIEWER, roomId, complete, 3_001);
    });
    expect(roomDeckState(tree, roomId)).toBe('idle');
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
    expect(findByAclPrefix(tree, 'Open #Room message')[0].props.accessibilityLabel).not.toContain(
      'needs your attention',
    );
    expect(titleStyleCounts(tree, '#Room message')).toContain(2);

    // Reading clears bold activity without touching the idle circle/state.
    await act(async () => {
      useRoomReadState.getState().markRoomRead(VIEWER, 'room-message', 9_000);
    });

    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(findByAclPrefix(tree, 'Open #Room message')[0].props.accessibilityLabel).not.toContain(
      'needs your attention',
    );
    expect(titleStyleCounts(tree, '#Room message')).not.toContain(2);
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
    expect(findByAclPrefix(tree, 'Open #Landed room')).toHaveLength(1);
    expect(findByAclPrefix(tree, 'Open #Closed room')).toHaveLength(1);
    expect(visibleTextOf(tree)).not.toContain('NEEDS YOU ·');
    expect(visibleTextOf(tree)).not.toContain("DOESN'T NEED YOU ·");

    // Tapping one navigates into the Room itself.
    await press(findByAclPrefix(tree, 'Open #Landed room')[0]);
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
