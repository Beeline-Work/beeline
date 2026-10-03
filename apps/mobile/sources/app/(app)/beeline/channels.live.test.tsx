import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem, ChatListView, WorkspaceListView } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

const deck = vi.hoisted(() => ({
  appState: 'active' as string,
  appStateListeners: [] as Array<(state: string) => void>,
  bottomInset: 0,
  renderRows: false,
  chatsReads: 0,
  chatsResponse: null as unknown,
  reconnects: 0,
  createRepository: vi.fn(
    async (_input: { installationId: number; name: string; private?: boolean }) => ({
      key: 'github:42',
      name: 'owner/new-repo',
      remote: 'git://github.com/owner/new-repo',
      githubInstallationId: 78,
      defaultBranch: 'main',
    }),
  ),
  createCorner: vi.fn(async (_roomId: string, _title: string) => 'corner-new'),
  subscriptions: [] as Array<{
    filters: readonly { readonly '#h'?: readonly string[] }[];
    emit(event: MonolithSurfaceEvent): void;
  }>,
  focusEffect: null as null | (() => void | (() => void)),
  blur: null as null | (() => void),
  storedInvite: null as string | null,
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: {
      addEventListener: (_type: string, listener: (state: string) => void) => {
        deck.appStateListeners.push(listener);
        return {
          remove: () => {
            deck.appStateListeners = deck.appStateListeners.filter((entry) => entry !== listener);
          },
        };
      },
      get currentState() {
        return deck.appState;
      },
    },
    Keyboard: { dismiss: () => undefined },
    Platform: {
      OS: 'ios',
      select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
    },
    Pressable: host('Pressable'),
    SectionList: (props: any) =>
      ReactModule.createElement(
        'SectionList',
        props,
        deck.renderRows
          ? props.sections.flatMap((section: any) =>
              section.data.map((item: any, index: number) =>
                ReactModule.createElement(
                  ReactModule.Fragment,
                  { key: item.room.id },
                  props.renderItem({ item, index, section }),
                ),
              ),
            )
          : props.children,
      ),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

function hostModule(...names: string[]) {
  return Object.fromEntries(
    names.map((name) => [name, (props: any) => React.createElement(name, props, props?.children)]),
  );
}
vi.mock('@/components/buzz/TrayGlyph', () => hostModule('TrayGlyph'));
vi.mock('@/components/buzz/ChevronGlyph', () => ({
  CHEVRON_ROW_SIZE: 16,
  ChevronGlyph: () => null,
}));
vi.mock('@/components/buzz/CommunityRail', () =>
  hostModule('BuzzCommunityShell', 'CommunityDrawerTrigger'),
);
vi.mock('@/components/buzz/CornerGlyph', () => ({ CORNER_META_SIZE: 12, CornerGlyph: () => null }));
vi.mock('@/components/buzz/CornerWorkingPulse', () => hostModule('CornerWorkingPulse'));
vi.mock('@/components/buzz/DirectMessagePickerSheet', () => hostModule('DirectMessagePickerSheet'));
vi.mock('@/components/buzz/ExitGlyph', () => hostModule('ExitGlyph'));
vi.mock('@/components/buzz/MemberPickerSheet', () => hostModule('MemberPickerSheet'));
vi.mock('@/components/buzz/MembersGlyph', () => hostModule('MembersGlyph'));
vi.mock('@/components/buzz/Button', () => hostModule('Button'));
vi.mock('@/components/buzz/NewRoomDialog', () => hostModule('NewRoomDialog'));
vi.mock('@/components/buzz/RoomDeckComposeMenu', () => hostModule('RoomDeckComposeMenu'));
vi.mock('@/components/buzz/RoomDeckLoadingView', () => hostModule('RoomDeckLoadingView'));
vi.mock('@/components/buzz/WelcomeCards', () => hostModule('WelcomeCards'));
vi.mock('@/buzz/welcome-cards', () => ({ readWelcomeCards: vi.fn(async () => ({ due: false })) }));
vi.mock('@/components/buzz/RoomListSectionHeader', () => hostModule('RoomListSectionHeader'));
vi.mock('@/components/buzz/SurfaceGlyphLoader', () => hostModule('SurfaceGlyphLoader'));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn() } }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({ communityId: 'workspace' }),
}));
vi.mock('react-native-gesture-handler', () => hostModule('Swipeable'));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: deck.bottomInset, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
  // One focused visit per mount; the test blurs and refocuses by hand.
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => {
      deck.focusEffect = effect;
      const cleanup = effect();
      deck.blur = () => cleanup?.();
      return () => cleanup?.();
    }, [effect]);
  },
}));
vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => '' }));
vi.mock('@/auth/github-installation-host', () => ({
  useGitHubInstallationSession: () => ({ start: vi.fn() }),
}));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => 'workspace'),
  saveActiveCommunityId: vi.fn(async () => undefined),
}));
vi.mock('@/buzz/surface-storage', () => ({
  mobileSurfaceCache: { read: vi.fn(async () => null), write: vi.fn(async () => undefined) },
  surfaceAddress: vi.fn(() => 'surface-address'),
}));
vi.mock('@/buzz/room-open-prefetch', () => ({ dispatchRoomOpenTap: vi.fn() }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn() }));
vi.mock('@/sync/transport', () => ({
  BuzzRigTransport: class {
    async ensureClient() {
      return {
        surfaceSubscribe: async (
          filters: readonly { readonly '#h'?: readonly string[] }[],
          listener: (event: MonolithSurfaceEvent) => void,
        ) => {
          deck.subscriptions.push({ filters, emit: listener });
          return () => undefined;
        },
      };
    }
    reconnectLive() {
      deck.reconnects += 1;
    }
    githubRepositoryCreate(input: { installationId: number; name: string; private?: boolean }) {
      return deck.createRepository(input);
    }
    createHumanCorner(roomId: string, title: string) {
      return deck.createCorner(roomId, title);
    }
  },
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    async workspaces(): Promise<WorkspaceListView> {
      return {
        workspaces: [{ id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 }],
        viewer,
        truncated: false,
        watchFilters: [],
      };
    }
    async chats(): Promise<ChatListView> {
      deck.chatsReads += 1;
      return deck.chatsResponse as ChatListView;
    }
  },
}));

import BuzzChannels from './channels';
import { router } from 'expo-router';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const viewer = { pubkey: 'viewer', kind: 'human' as const, name: 'Captain' };
const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' };

function chatList(latest: { id: string; text: string; createdAt: number }): ChatListView {
  return {
    workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
    chats: [
      {
        room: {
          id: 'room-a',
          workspaceId: 'workspace',
          name: 'general',
          archived: false,
          createdAt: 1,
          updatedAt: 1,
        },
        latestMessage: { ...latest, author: agent },
        unread: false,
      },
    ],
    viewer,
    truncated: false,
    watchFilters: [{ '#h': ['room-a'] }],
  };
}

function room(id: string, latestAt: number, extra: Partial<ChatListItem> = {}): ChatListItem {
  return {
    room: {
      id,
      workspaceId: 'workspace',
      name: id,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    },
    latestMessage: { id: `${id}-latest`, text: 'hello', createdAt: latestAt, author: agent },
    unread: false,
    ...extra,
  };
}

function listOf(chats: ChatListItem[], extra: Partial<ChatListView> = {}): ChatListView {
  return {
    workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
    chats,
    viewer,
    truncated: false,
    watchFilters: [{ '#h': chats.map((item) => item.room.id) }],
    ...extra,
  };
}

function paintedRows(renderer: ReactTestRenderer): ChatListItem[] {
  const list = renderer.root.find(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'SectionList' && node.props.testID === 'room-list',
  );
  return (list.props.sections as { data: ChatListItem[] }[]).flatMap((section) => section.data);
}

function roomWatch() {
  const watch = deck.subscriptions.find((entry) =>
    entry.filters.some((filter) => filter['#h']?.includes('room-a')),
  );
  if (!watch) throw new Error('the deck is not watching room-a');
  return watch;
}

/** Longer than the scheduler's 500 ms floor and 1 s dirty ceiling. */
const quiet = () => act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));

async function mountDeck(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzChannels));
  });
  await vi.waitFor(() => expect(() => roomWatch()).not.toThrow());
  await quiet();
  return renderer;
}

beforeEach(() => {
  deck.appState = 'active';
  deck.appStateListeners = [];
  deck.bottomInset = 0;
  deck.renderRows = false;
  deck.chatsReads = 0;
  deck.reconnects = 0;
  deck.storedInvite = null;
  vi.mocked(router.replace).mockClear();
  vi.mocked(router.push).mockClear();
  vi.mocked(dispatchRoomOpenTap).mockClear();
  deck.createRepository.mockClear();
  deck.createCorner.mockClear();
  deck.subscriptions.length = 0;
  deck.chatsResponse = chatList({ id: 'm1', text: 'earlier', createdAt: 10 });
});

afterEach(() => {
  deck.focusEffect = null;
  deck.blur = null;
});

describe('Room list gestures', () => {
  const listIn = (renderer: ReactTestRenderer) => renderer.root.findByType('SectionList');
  const touchIn = (renderer: ReactTestRenderer) =>
    renderer.root.find(
      (node: any) => node.type === 'View' && node.props.testID === 'room-list-gestures',
    );
  const pressIn = (renderer: ReactTestRenderer) =>
    renderer.root.find(
      (node: any) => node.type === 'Pressable' && node.props.testID === 'room-room-a',
    );
  const swipeIn = (renderer: ReactTestRenderer) => renderer.root.findByType('Swipeable');

  it('blocks vertical drags and their late release, then accepts a resting tap without delay', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = listIn(renderer);
    expect(swipeIn(renderer).props).toMatchObject({
      enabled: true,
      activeOffsetX: [-15, 15],
      failOffsetY: [-10, 10],
    });
    act(() => {
      expect(touchIn(renderer).props.onStartShouldSetResponderCapture()).toBe(false);
      list.props.onScrollBeginDrag();
      pressIn(renderer).props.onPress();
    });
    expect(swipeIn(renderer).props.enabled).toBe(false);
    expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
    act(() => {
      list.props.onScrollEndDrag({
        nativeEvent: { velocity: { y: 0 }, contentOffset: { y: 100 } },
      });
      touchIn(renderer).props.onTouchEnd();
      pressIn(renderer).props.onPress();
    });
    expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
    expect(swipeIn(renderer).props.enabled).toBe(true);
    act(() => {
      touchIn(renderer).props.onStartShouldSetResponderCapture();
      pressIn(renderer).props.onPress();
    });
    expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
    console.log(
      'Vertical drag and late release: no Room opened; next resting tap opens immediately',
    );
    act(() => renderer.unmount());
  });

  it('keeps swipes disabled between fling release and momentum-begin, and until a stop touch ends', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = listIn(renderer);
    act(() => {
      touchIn(renderer).props.onStartShouldSetResponderCapture();
      list.props.onScrollBeginDrag();
      list.props.onScrollEndDrag({
        nativeEvent: { velocity: { y: -2 }, contentOffset: { y: 100 } },
      });
      touchIn(renderer).props.onTouchEnd();
    });
    expect(swipeIn(renderer).props.enabled).toBe(false);
    act(() => {
      list.props.onMomentumScrollBegin();
      touchIn(renderer).props.onStartShouldSetResponderCapture();
      list.props.onMomentumScrollEnd();
    });
    expect(swipeIn(renderer).props.enabled).toBe(false);
    act(() => touchIn(renderer).props.onTouchEnd());
    expect(swipeIn(renderer).props.enabled).toBe(true);
    console.log('Fling and coast-stop touch: swipes disabled; release at rest: swipes enabled');
    act(() => renderer.unmount());
  });

  it('handles drag receipts without velocity and cancels settlement when momentum begins', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = listIn(renderer);
    vi.useFakeTimers();
    try {
      act(() => {
        touchIn(renderer).props.onStartShouldSetResponderCapture();
        list.props.onScrollBeginDrag();
        list.props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 100 } } });
        touchIn(renderer).props.onTouchEnd();
      });
      expect(swipeIn(renderer).props.enabled).toBe(false);
      act(() => vi.advanceTimersByTime(16));
      expect(swipeIn(renderer).props.enabled).toBe(true);
      act(() => {
        list.props.onScrollBeginDrag();
        list.props.onScrollEndDrag({ nativeEvent: { contentOffset: { y: 100 } } });
        list.props.onMomentumScrollBegin();
        vi.advanceTimersByTime(16);
      });
      expect(swipeIn(renderer).props.enabled).toBe(false);
      act(() => list.props.onMomentumScrollEnd());
      expect(swipeIn(renderer).props.enabled).toBe(true);
    } finally {
      act(() => renderer.unmount());
      vi.useRealTimers();
    }
  });

  it('blocks a corner long press and toggle during scrolling', async () => {
    deck.renderRows = true;
    deck.chatsResponse = listOf([
      room('room-a', 10, {
        cornerCount: 1,
        openCorners: [{ id: 'corner-1', name: 'fix', state: 'working', mine: true }],
      }),
    ]);
    const renderer = await mountDeck();
    const list = listIn(renderer);
    const glyph = () =>
      renderer.root.find(
        (node: any) => node.type === 'Pressable' && node.props.testID === 'room-room-a-corners',
      );
    await act(async () => {
      list.props.onScrollBeginDrag();
      glyph().props.onPress();
      await glyph().props.onLongPress();
    });
    expect(deck.createCorner).not.toHaveBeenCalled();
    expect(glyph().props.accessibilityState.expanded).toBe(false);
    act(() => renderer.unmount());
  });

  it('blocks the iOS bounce-stop touch when momentum-end arrives before touch-start', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = listIn(renderer);
    vi.useFakeTimers();
    try {
      act(() => {
        list.props.onMomentumScrollBegin();
        list.props.onMomentumScrollEnd();
        touchIn(renderer).props.onStartShouldSetResponderCapture();
        touchIn(renderer).props.onTouchEnd();
        pressIn(renderer).props.onPress();
      });
      expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(16);
        touchIn(renderer).props.onStartShouldSetResponderCapture();
        pressIn(renderer).props.onPress();
      });
      expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
    } finally {
      act(() => renderer.unmount());
      vi.useRealTimers();
    }
  });

  it('keeps a coast-stopping touch from opening the Room after momentum ends', async () => {
    deck.renderRows = true;
    const renderer = await mountDeck();
    const list = listIn(renderer);
    const rowPress = () => pressIn(renderer);
    act(() => {
      list.props.onScrollBeginDrag?.();
      list.props.onScrollEndDrag?.({
        nativeEvent: { velocity: { y: 2 }, contentOffset: { y: 100 } },
      });
      list.props.onMomentumScrollBegin?.();
      touchIn(renderer).props.onStartShouldSetResponderCapture?.();
      list.props.onMomentumScrollEnd?.();
      touchIn(renderer).props.onTouchEnd?.();
      rowPress().props.onPress();
    });
    expect(dispatchRoomOpenTap).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
    console.log(
      'Reproduction room-list-coast: fling → touch row → momentum ends → release: no Room opened',
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
      touchIn(renderer).props.onStartShouldSetResponderCapture();
      rowPress().props.onPress();
    });
    expect(dispatchRoomOpenTap).toHaveBeenCalledOnce();
    console.log('Resting tap: Room open dispatched immediately');
    act(() => renderer.unmount());
  });
});

describe('Room deck live path', () => {
  it('sends an invite parked before sign-in to its own screen instead of the deck', async () => {
    const token = `bzi_${'a'.repeat(64)}`;
    deck.storedInvite = token;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await vi.waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith({
        pathname: '/join/[token]',
        params: { token },
      }),
    );
    // The deck stops there: no Workspace or chats read, no watches.
    expect(deck.chatsReads).toBe(0);
    expect(deck.subscriptions).toHaveLength(0);
    await act(async () => renderer.unmount());
  });

  it('requests a private repository from the Room creation sheet', async () => {
    const renderer = await mountDeck();
    const sheet = renderer.root.findByType('NewRoomDialog');

    await act(async () => sheet.props.handleCreateRepository(78, 'new-repo'));

    expect(deck.createRepository).toHaveBeenCalledWith({
      installationId: 78,
      name: 'new-repo',
      private: true,
    });
    await act(async () => renderer.unmount());
  });

  it('keeps the final lobby card above the bottom safe area', async () => {
    deck.bottomInset = 34;
    const renderer = await mountDeck();
    const list = renderer.root.find(
      (node: { type: unknown; props: { testID?: string } }) =>
        node.type === 'SectionList' && node.props.testID === 'room-list',
    );
    const contentStyles = [list.props.contentContainerStyle].flat().filter(Boolean);

    expect(contentStyles.at(-1)).toMatchObject({ paddingBottom: 58 });
  });

  it("toggles the Room's corner dropdown on mobile without a selected conversation state", async () => {
    const renderer = await mountDeck();
    const item = {
      ...paintedRows(renderer)[0],
      cornerCount: 1,
      openCorners: [
        { id: 'corner-1', name: 'fix', state: 'working' as const, mine: true as const },
      ],
    };
    const renderRow = () => {
      const list = renderer.root.find((node: any) => node.type === 'SectionList');
      return create(list.props.renderItem({ item, index: 0, section: { data: [item] } }));
    };
    let row: ReactTestRenderer;
    await act(async () => {
      row = renderRow();
    });
    const conversation = row!.root.findByType(ConversationRow);
    expect(conversation.props.selected).toBeUndefined();
    expect(conversation.props.cornersExpanded).toBe(false);
    act(() => conversation.props.onToggleCorners());
    expect(router.push).not.toHaveBeenCalled();
    let opened: ReactTestRenderer;
    await act(async () => {
      opened = renderRow();
    });
    expect(opened!.root.findByType(ConversationRow).props.cornersExpanded).toBe(true);
    expect(
      opened!.root.findAllByProps({ testID: 'desktop-corner-corner-1' }).length,
    ).toBeGreaterThan(0);
    act(() => {
      row!.unmount();
      opened!.unmount();
      renderer.unmount();
    });
  });

  it('opens a new corner from a long press on the row corner glyph and lands in it', async () => {
    const renderer = await mountDeck();
    const list = renderer.root.find((node: any) => node.type === 'SectionList');
    let row: ReactTestRenderer;
    await act(async () => {
      row = create(
        list.props.renderItem({
          item: { ...paintedRows(renderer)[0], cornerCount: 1 },
          index: 0,
          section: { data: [paintedRows(renderer)[0]] },
        }),
      );
    });
    const conversation = row!.root.findByType(ConversationRow);
    vi.mocked(router.push).mockClear();
    await act(async () => {
      await conversation.props.onLongPressCorners();
    });

    expect(deck.createCorner).toHaveBeenCalledOnce();
    const [roomId, title] = deck.createCorner.mock.calls[0]!;
    expect(roomId).toBe('room-a');
    expect(title).toMatch(/ corner$/);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: { channelId: 'corner-new', parent: 'room-a', title, returnTo: 'room-list' },
    });
    act(() => {
      row!.unmount();
      renderer.unmount();
    });
  });

  it('paints a Room delta into the list without a chats read, and ignores drafts', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;
    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('earlier');

    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        roomWatch().emit({
          monolithLive: {
            type: 'draft',
            roomId: 'room-a',
            agentId: 'agent',
            turnId: 'turn',
            text: 'thinking '.repeat(index + 1),
          },
        });
      roomWatch().emit({
        monolithLive: {
          type: 'message-delta',
          roomId: 'room-a',
          message: {
            id: 'm2',
            text: 'the answer',
            createdAt: 20,
            author: agent,
            presentation: 'message',
          },
        },
      });
    });
    await quiet();

    expect(paintedRows(renderer)[0]).toMatchObject({
      unread: true,
      latestMessage: { id: 'm2', text: 'the answer' },
    });
    expect(deck.chatsReads).toBe(readsAtRest);
    await act(async () => renderer.unmount());
  });

  it('reads the list when a corner under a Room changes working or waiting state', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'corner-status' },
      }),
    );
    await quiet();

    expect(deck.chatsReads).toBe(readsAtRest + 1);
    await act(async () => renderer.unmount());
  });

  it('keeps the last known unread dot and corners when the server could not read them', async () => {
    deck.chatsResponse = listOf([
      room('room-a', 10, {
        unread: true,
        cornerCount: 2,
        waitingCornerCount: 1,
        openCorners: [{ id: 'corner-1', name: 'fix', state: 'waiting' }],
      }),
    ]);
    const renderer = await mountDeck();
    expect(paintedRows(renderer)[0]).toMatchObject({ unread: true, cornerCount: 2 });

    deck.chatsResponse = listOf([room('room-a', 10)], { unavailable: ['unread', 'corners'] });
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      }),
    );
    await quiet();

    expect(paintedRows(renderer)[0]).toMatchObject({
      unread: true,
      cornerCount: 2,
      waitingCornerCount: 1,
      openCorners: [{ id: 'corner-1', name: 'fix', state: 'waiting' }],
    });
    await act(async () => renderer.unmount());
  });

  it('mounts a fresh card frame when a reorder changes its rounded edges', async () => {
    deck.chatsResponse = listOf([room('room-a', 30), room('room-b', 20), room('room-c', 10)]);
    const renderer = await mountDeck();
    const list = renderer.root.find(
      (node: { type: unknown; props: { testID?: string } }) =>
        node.type === 'SectionList' && node.props.testID === 'room-list',
    );
    const data = paintedRows(renderer);
    const frameKey = (index: number) => {
      const cell = list.props.renderItem({ item: data[2], index, section: { data } });
      return cell.props.children.props.children.key;
    };

    // room-c moving from last to first or middle must not reuse its clipped frame.
    expect(new Set([frameKey(0), frameKey(1), frameKey(2)]).size).toBe(3);
    expect(frameKey(1)).toBe(frameKey(1));
    await act(async () => renderer.unmount());
  });

  it('keeps its live watch when Rooms only change order', async () => {
    deck.chatsResponse = listOf([room('room-a', 20), room('room-b', 10)]);
    const renderer = await mountDeck();
    const watches = deck.subscriptions.length;

    deck.chatsResponse = listOf([room('room-b', 30), room('room-a', 20)]);
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-b', reason: 'activity' },
      }),
    );
    await quiet();

    expect(paintedRows(renderer).map((item) => item.room.id)).toEqual(['room-b', 'room-a']);
    expect(deck.subscriptions).toHaveLength(watches);
    await act(async () => renderer.unmount());
  });

  it('reads once when the app returns to the foreground, and never on a timer', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () => {
      deck.appState = 'background';
      for (const listener of deck.appStateListeners) listener('background');
    });
    await quiet();
    await act(async () => {
      deck.appState = 'active';
      for (const listener of deck.appStateListeners) listener('active');
    });
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);

    await quiet();
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);
    await act(async () => renderer.unmount());
  }, 10_000);

  it('reads nothing while hidden under a Room, then catches up on focus', async () => {
    const renderer = await mountDeck();
    const readsAtRest = deck.chatsReads;

    await act(async () => deck.blur?.());
    await act(async () =>
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'activity' },
      }),
    );
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest);

    await act(async () => {
      deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
    });
    await quiet();
    expect(deck.chatsReads).toBe(readsAtRest + 1);
    expect(deck.reconnects).toBe(0);
    await act(async () => renderer.unmount());
  });

  it('reconnects the socket when a read finds a message the socket never announced', async () => {
    const renderer = await mountDeck();
    expect(deck.reconnects).toBe(0);

    deck.chatsResponse = chatList({ id: 'm3', text: 'sent while we were deaf', createdAt: 30 });
    await act(async () => deck.blur?.());
    await act(async () => {
      deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
    });
    await quiet();

    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('sent while we were deaf');
    expect(deck.reconnects).toBe(1);
    await act(async () => renderer.unmount());
  });

  it('reconnects the socket when an unannounced message landed in the same second', async () => {
    const renderer = await mountDeck();

    deck.chatsResponse = chatList({
      id: 'm2',
      text: 'same second, never announced',
      createdAt: 10,
    });
    await act(async () => deck.blur?.());
    await act(async () => {
      deck.blur = (deck.focusEffect?.() as (() => void) | undefined) ?? null;
    });
    await quiet();

    expect(paintedRows(renderer)[0]!.latestMessage?.text).toBe('same second, never announced');
    expect(deck.reconnects).toBe(1);
    await act(async () => renderer.unmount());
  });
});

vi.mock('@/components/buzz/WorkspaceActionsMenu', () => hostModule('WorkspaceActionsMenu'));
vi.mock('@/components/buzz/RoomListToolbar', () => hostModule('RoomListToolbar'));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) =>
      key === '@beeline/pending-invite/v1' && deck.storedInvite
        ? JSON.stringify({ token: deck.storedInvite, savedAt: Date.now() })
        : null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
