import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem, ChatListView, WorkspaceListView } from '@beeline/buzz-client';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

const deck = vi.hoisted(() => ({
  appState: 'active' as string,
  bottomInset: 0,
  chatsReads: 0,
  chatsResponse: null as unknown,
  reconnects: 0,
  subscriptions: [] as Array<{
    filters: readonly { readonly '#h'?: readonly string[] }[];
    emit(event: MonolithSurfaceEvent): void;
  }>,
  focusEffect: null as null | (() => void | (() => void)),
  blur: null as null | (() => void),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AppState: {
      addEventListener: () => ({ remove: () => undefined }),
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
    SectionList: host('SectionList'),
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
vi.mock('@/components/buzz/BookmarksGlyph', () => hostModule('BookmarksGlyph'));
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
vi.mock('@/components/buzz/MonoHull', () => hostModule('MonoButton'));
vi.mock('@/components/buzz/NewRoomDialog', () => hostModule('NewRoomDialog'));
vi.mock('@/components/buzz/RoomDeckComposeMenu', () => hostModule('RoomDeckComposeMenu'));
vi.mock('@/components/buzz/RoomDeckLoadingView', () => hostModule('RoomDeckLoadingView'));
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
  deck.bottomInset = 0;
  deck.chatsReads = 0;
  deck.reconnects = 0;
  deck.subscriptions.length = 0;
  deck.chatsResponse = chatList({ id: 'm1', text: 'earlier', createdAt: 10 });
});

afterEach(() => {
  deck.focusEffect = null;
  deck.blur = null;
});

describe('Room deck live path', () => {
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

  it('opens the existing Corners page on mobile without a selected conversation state', async () => {
    const renderer = await mountDeck();
    const list = renderer.root.find((node: any) => node.type === 'SectionList');
    let row: ReactTestRenderer;
    await act(async () => {
      row = create(
        list.props.renderItem({
          item: { ...paintedRows(renderer)[0], cornerCount: 3, waitingCornerCount: 2 },
          index: 0,
          section: { data: [paintedRows(renderer)[0]] },
        }),
      );
    });
    expect(row!.root.findByType(ConversationRow).props.selected).toBeUndefined();
    const conversation = row!.root.findByType(ConversationRow);
    expect(conversation.props.onToggleCorners).toBeTypeOf('function');
    act(() => conversation.props.onToggleCorners());
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/beeline/corners/[roomId]',
      params: { roomId: 'room-a' },
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

vi.mock('@/components/buzz/ConversationRow', () => hostModule('ConversationRow'));
vi.mock('@/components/buzz/WorkspaceActionsMenu', () => hostModule('WorkspaceActionsMenu'));
vi.mock('@/components/buzz/RoomListToolbar', () => hostModule('RoomListToolbar'));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
