import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({ os: 'web', width: 1200 }));
const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn() }));
const phoneOperation = vi.hoisted(() => vi.fn());
const roomRead = vi.hoisted(() => vi.fn());
const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    FlatList: (props: any) =>
      ReactModule.createElement(
        'FlatList',
        props,
        props.ListEmptyComponent,
        ...(props.data ?? []).map((item: any, index: number) =>
          ReactModule.createElement(
            ReactModule.Fragment,
            { key: props.keyExtractor(item, index) },
            props.renderItem({ item, index }),
          ),
        ),
      ),
    Platform: { get OS() { return layout.os; } },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    useWindowDimensions: () => ({ width: layout.width, height: 900 }),
  };
});

const theme = vi.hoisted(() => ({
  buzz: {
    bgBase: '#14091a',
    bgHighlight: '#1e1326',
    bgTerminal: '#0d0712',
    border: '#333',
    borderStrong: '#555',
    accent: '#b08a4a',
    radius: 3,
    textPrimary: '#f0f0f3',
    textSecondary: '#c9c9d1',
    ledgerQuiet: '#90909b',
    ledgerGhost: '#6c6c76',
    type: { body: {}, bodyStrong: {}, meta: {}, sectionHead: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
  },
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  useLocalSearchParams: () => ({ communityId: 'ws' }),
  useRouter: () => navigation,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('@/auth/buzz-identity-storage', () => auth);
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    room = roomRead;
  },
}));
vi.mock('@/buzz/bookmark-events', () => ({ publishBookmarkChange: vi.fn() }));
vi.mock('@/components/DesktopRoomInspector', async () => {
  const ReactModule = await import('react');
  return {
    DesktopRoomInspector: (props: any) =>
      ReactModule.createElement('DesktopRoomInspector', props),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

import BookmarksScreen from './bookmarks';

const person = {
  pubkey: 'person-1',
  kind: 'human' as const,
  name: 'Avery',
  handle: 'avery',
};
const parentRoom = {
  room: { id: 'room-1', workspaceId: 'ws', name: 'Clover', archived: false, createdAt: 1, updatedAt: 2 },
  parent: undefined,
  members: [],
  messages: [],
  latestAgentTurns: [],
  viewer: { identity: person, role: 'owner', permissions: { send: true, manage: true } },
  repositoryResolution: 'none',
  watchFilters: [],
};
const parentCorner = {
  corner: { id: 'corner-1', workspaceId: 'ws', name: 'Fix fixture', about: 'Repair it.', archived: false, createdAt: 1, updatedAt: 2 },
  state: 'working',
  stateAt: 2,
};
const cornerRoom = {
  ...parentRoom,
  room: parentCorner.corner,
  parent: parentRoom.room,
  messages: [
    { id: 'msg-1', text: 'The bookmarked line.', createdAt: 5, author: person, presentation: 'message' },
  ],
};

function bookmark(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'msg-1',
    workspaceId: 'ws',
    roomId: 'corner-1',
    roomName: 'Fix fixture',
    roomKind: 'corner',
    messageCreatedAt: 1_700_000_000,
    bookmarkedAt: 1_700_000_100,
    available: true,
    author: person,
    text: 'The bookmarked line.',
    ...overrides,
  };
}

function textOf(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .flatMap((node: any) => node.props.children)
    .join(' ')
    .replace(/\s+/g, ' ');
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  layout.os = 'web';
  layout.width = 1200;
  navigation.back.mockReset();
  navigation.push.mockReset();
  phoneOperation.mockReset();
  roomRead.mockReset();
  phoneOperation.mockResolvedValue({ bookmarks: [bookmark()] });
  roomRead.mockImplementation(async (id: string) => (id === 'room-1' ? parentRoom : cornerRoom));
});

async function renderBookmarks(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<BookmarksScreen />);
  });
  await act(async () => undefined);
  return tree;
}

describe('Bookmarks desktop second pane', () => {
  it('opens a clicked corner bookmark in DesktopRoomInspector at that message', async () => {
    phoneOperation.mockResolvedValue({
      bookmarks: [
        bookmark(),
        bookmark({
          messageId: 'msg-2',
          roomId: 'corner-1',
          text: 'A later save.',
        }),
      ],
    });
    const tree = await renderBookmarks();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-msg-2' }).props.onPress();
    });
    await act(async () => undefined);

    const pane = tree.root.findByType('DesktopRoomInspector' as any);
    expect(pane.props.selectedCornerId).toBe('corner-1');
    expect(pane.props.focusMessageId).toBe('msg-2');
    expect(pane.props.room.room.id).toBe('room-1');
    expect(textOf(tree)).not.toContain('OPEN IN');
    expect(tree.root.findAllByProps({ testID: 'bookmark-pane' })).toHaveLength(0);
  });

  it('does not restate an unavailable bookmark in the second pane', async () => {
    phoneOperation.mockResolvedValue({
      bookmarks: [
        bookmark({
          messageId: 'gone',
          available: false,
          text: undefined,
          author: undefined,
        }),
      ],
    });
    const tree = await renderBookmarks();
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
    const pane = tree.root.findByProps({ testID: 'bookmark-pane' });
    const paneText = pane
      .findAllByType('Text' as any)
      .flatMap((node: any) => node.props.children)
      .join(' ');
    expect(paneText).toContain('Source unavailable');
    expect(paneText).toContain('This bookmark no longer exposes message content.');
    expect(paneText).toContain('REMOVE');
    expect(paneText).not.toContain('The bookmarked line.');
    expect(paneText).not.toContain('Avery');
    expect(roomRead).not.toHaveBeenCalled();
  });
});

describe('Bookmarks empty state', () => {
  it('tells a desktop reader about the strip its pointer reaches, and nothing about long press', async () => {
    phoneOperation.mockResolvedValue({ bookmarks: [] });
    const empty = textOf(await renderBookmarks());
    expect(empty).toContain('No bookmarks yet');
    expect(empty).toContain('Hover a message and press its bookmark mark.');
    expect(empty).not.toContain('Long press');
  });

  it('tells a touch reader to long press, and nothing about a desktop strip', async () => {
    layout.os = 'ios';
    layout.width = 390;
    phoneOperation.mockResolvedValue({ bookmarks: [] });
    const empty = textOf(await renderBookmarks());
    expect(empty).toContain('No bookmarks yet');
    expect(empty).toContain('Long press a message and pick Bookmark.');
    expect(empty).not.toContain('desktop');
    expect(empty).not.toContain('Hover');
  });
});

describe('Bookmarks mobile open', () => {
  it('opens the original message in its room from a compact tap', async () => {
    layout.os = 'ios';
    layout.width = 390;
    const tree = await renderBookmarks();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-msg-1' }).props.onPress();
    });
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'corner-1',
        communityId: 'ws',
        notificationResponseId: 'bookmark:msg-1',
        notificationMessageId: 'msg-1',
      },
    });
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
  });
});
