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
    Platform: {
      get OS() {
        return layout.os;
      },
    },
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
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
    brassWash: 'rgba(176,138,74,0.18)',
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
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
    workspace = vi.fn(async () => ({ workspace: { id: 'ws', name: 'Clover Workspace' } }));
  },
}));
vi.mock('@/components/DesktopRoomInspector', async () => {
  const ReactModule = await import('react');
  return {
    DesktopRoomInspector: (props: any) => ReactModule.createElement('DesktopRoomInspector', props),
  };
});
vi.mock('react-native-gesture-handler', async () => {
  const ReactModule = await import('react');
  return {
    Swipeable: (props: any) => ReactModule.createElement('Swipeable', props, props.children),
  };
});
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

import TrayScreen from './tray';

const person = {
  pubkey: 'person-1',
  kind: 'human' as const,
  name: 'Avery',
  handle: 'avery',
};
const parentRoom = {
  room: {
    id: 'room-1',
    workspaceId: 'ws',
    name: 'Clover',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  parent: undefined,
  members: [],
  messages: [],
  latestAgentTurns: [],
  viewer: { identity: person, role: 'owner', permissions: { send: true, manage: true } },
  repositoryResolution: 'none',
  watchFilters: [],
};
const parentCorner = {
  corner: {
    id: 'corner-1',
    workspaceId: 'ws',
    name: 'Fix fixture',
    about: 'Repair it.',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  state: 'working',
  stateAt: 2,
};
const cornerRoom = {
  ...parentRoom,
  room: parentCorner.corner,
  parent: parentRoom.room,
  messages: [
    {
      id: 'msg-1',
      text: 'The bookmarked line.',
      createdAt: 5,
      author: person,
      presentation: 'message',
    },
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

function need(overrides: Record<string, unknown> = {}) {
  return {
    messageId: 'ask-1',
    workspaceId: 'ws',
    roomId: 'room-1',
    roomName: 'Launch room',
    roomKind: 'room',
    text: 'can you confirm the review note?',
    createdAt: 1_700_000_000,
    expiresAt: 1_700_080_000,
    author: person,
    ...overrides,
  };
}

/** The phone operations the tray reads, answered by name. */
function serve({
  needs = [] as unknown[],
  bookmarks = [] as unknown[],
}: { needs?: unknown[]; bookmarks?: unknown[] } = {}) {
  phoneOperation.mockImplementation(async (name: string) => {
    if (name === 'readNeedsYou') return { items: needs };
    if (name === 'listMessageBookmarks') return { bookmarks };
    return undefined;
  });
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
  serve({ bookmarks: [bookmark()] });
  roomRead.mockImplementation(async (id: string) => (id === 'room-1' ? parentRoom : cornerRoom));
});

async function renderTray(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TrayScreen />);
  });
  await act(async () => undefined);
  return tree;
}

describe.each([
  { surface: 'desktop', os: 'web', width: 1200, action: 'REMOVE' },
  { surface: 'mobile', os: 'ios', width: 390, action: 'OPEN →' },
])('Bookmarks $surface rows', ({ os, width, action }) => {
  it('shows each save age once at the right and no footer time', async () => {
    layout.os = os;
    layout.width = width;
    const now = 1_700_010_000_000;
    const nowSeconds = now / 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    serve({
      bookmarks: [
        bookmark({ messageCreatedAt: nowSeconds - 7200, bookmarkedAt: nowSeconds - 120 }),
        bookmark({
          messageId: 'gone',
          messageCreatedAt: nowSeconds - 86400,
          bookmarkedAt: nowSeconds - 3600,
          available: false,
          text: undefined,
          author: undefined,
        }),
      ],
    });
    try {
      const tree = await renderTray();
      for (const [id, age] of [
        ['msg-1', '2m'],
        ['gone', '1h'],
      ]) {
        const row = tree.root.findByProps({ testID: `bookmark-${id}` });
        const line = row.findByProps({ testID: `bookmark-save-line-${id}` });
        const texts = (node: any) =>
          node
            .findAllByType('Text' as any)
            .map((textNode: any) => [textNode.props.children].flat(Infinity).join(''));
        expect(texts(line)).toEqual(['Fix fixture', `SAVED ${age}`]);
        const words = texts(row);
        expect(words.filter((word: string) => word === `SAVED ${age}`)).toHaveLength(1);
        expect(words).not.toContain(id === 'gone' ? '1d' : '2h');
        expect(words).toContain(action);
      }
    } finally {
      clock.mockRestore();
    }
  });
});

describe('Bookmarks desktop second pane', () => {
  it('shows the workspace above Tray and both section counts at the right', async () => {
    const tree = await renderTray();
    const header = tree.root.findByProps({ testID: 'tray-header' });
    const words = header.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(words).toEqual(['Clover Workspace', 'Tray', '0 NEED YOU · 1 SAVED']);
  });
  it('opens a clicked corner bookmark in DesktopRoomInspector at that message', async () => {
    serve({
      bookmarks: [
        bookmark(),
        bookmark({
          messageId: 'msg-2',
          roomId: 'corner-1',
          text: 'A later save.',
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-msg-2' }).props.onPress();
    });
    await act(async () => undefined);

    const pane = tree.root.findByType('DesktopRoomInspector' as any);
    expect(pane.props.selectedCornerId).toBe('corner-1');
    expect(pane.props.focusMessageId).toBe('msg-2');
    expect(pane.props.room.room.id).toBe('room-1');
    expect(textOf(tree)).not.toContain('OPEN IN');
    expect(tree.root.findAllByProps({ testID: 'tray-pane' })).toHaveLength(0);
  });

  it('does not restate an unavailable bookmark in the second pane', async () => {
    serve({
      bookmarks: [
        bookmark({
          messageId: 'gone',
          available: false,
          text: undefined,
          author: undefined,
        }),
      ],
    });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmark-gone' }).props.onPress?.();
    });
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
    const pane = tree.root.findByProps({ testID: 'tray-pane' });
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
    serve({ bookmarks: [] });
    const empty = textOf(await renderTray());
    expect(empty).toContain('No bookmarks yet');
    expect(empty).toContain('Hover a message and press its bookmark mark.');
    expect(empty).not.toContain('Long press');
  });

  it('tells a touch reader to long press, and nothing about a desktop strip', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ bookmarks: [] });
    const empty = textOf(await renderTray());
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
    const tree = await renderTray();
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

describe('Tray Needs you', () => {
  function cleared() {
    return phoneOperation.mock.calls.filter(([name]) => name === 'clearNeedsYou');
  }

  it('shows exactly two sections, Needs you then Saved, each cell only its sentence and source', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_300_000);
    serve({
      needs: [need(), need({ messageId: 'ask-2', roomKind: 'corner', roomName: 'signing' })],
      bookmarks: [bookmark()],
    });
    try {
      const tree = await renderTray();
      const order = tree.root
        .findAll((node: any) =>
          /^(tray-section-|needs-you-ask|bookmark-msg)/.test(String(node.props.testID ?? '')),
        )
        .map((node: any) => node.props.testID)
        .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)
        .filter((id: string) => !id.startsWith('needs-you-text'));
      expect(order).toEqual([
        'tray-section-needs',
        'needs-you-ask-1',
        'needs-you-ask-2',
        'tray-section-saved',
        'bookmark-msg-1',
      ]);
      const cell = tree.root.findByProps({ testID: 'needs-you-text-ask-1' });
      expect(cell.props.children).toBe('can you confirm the review note?');
      expect(textOf(tree)).not.toContain('@');
      expect(textOf(tree)).toContain('Launch room · 5m');
      const header = tree.root.findByProps({ testID: 'tray-header' });
      expect(header.findAllByType('Text' as any).map((node: any) => node.props.children)).toContain(
        '2 NEED YOU · 1 SAVED',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('shows the countdown only in a cell’s last six hours', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    serve({
      needs: [
        need({ expiresAt: now / 1000 + 5.5 * 3600 }),
        need({ messageId: 'ask-2', expiresAt: now / 1000 + 20 * 3600 }),
      ],
    });
    try {
      const text = textOf(await renderTray());
      expect(text).toContain('expires in 6h');
      expect(text.match(/expires in/g)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('opening a cell on the phone clears it and lands on that exact message', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-ask-1' }).props.onPress();
    });
    expect(cleared()).toEqual([['clearNeedsYou', { workspaceId: 'ws', messageId: 'ask-1' }]]);
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'room-1',
        communityId: 'ws',
        notificationResponseId: 'needs-you:ask-1',
        notificationMessageId: 'ask-1',
      },
    });
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'needs-you-empty' })).toBeDefined();
  });

  it('a phone swipe right dismisses the cell without opening it', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-swipe-ask-1' }).props.onSwipeableOpen('left');
    });
    expect(cleared()).toHaveLength(1);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
  });

  it('a desktop click clears the cell and keeps its message open in the pane', async () => {
    serve({ needs: [need()] });
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-ask-1' }).props.onPress();
    });
    await act(async () => undefined);
    expect(cleared()).toHaveLength(1);
    const pane = tree.root.findByType('DesktopRoomInspector' as any);
    expect(pane.props.focusMessageId).toBe('ask-1');
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('a desktop hover reveals DISMISS in place of the chevron', async () => {
    serve({ needs: [need()] });
    const tree = await renderTray();
    const cell = () => tree.root.findByProps({ testID: 'needs-you-ask-1' });
    expect(tree.root.findAllByProps({ testID: 'needs-you-dismiss-ask-1' })).toHaveLength(0);
    await act(async () => cell().props.onHoverIn());
    await act(async () => {
      tree.root
        .findByProps({ testID: 'needs-you-dismiss-ask-1' })
        .props.onPress({ stopPropagation: () => undefined });
    });
    expect(cleared()).toHaveLength(1);
    expect(tree.root.findAllByType('DesktopRoomInspector' as any)).toHaveLength(0);
  });

  it('puts a cell back when the server refuses to clear it', async () => {
    layout.os = 'ios';
    layout.width = 390;
    serve({ needs: [need()] });
    const tree = await renderTray();
    phoneOperation.mockImplementation(async (name: string) => {
      if (name === 'clearNeedsYou') throw new Error('message is not available');
      return undefined;
    });
    await act(async () => {
      tree.root.findByProps({ testID: 'needs-you-swipe-ask-1' }).props.onSwipeableOpen('left');
    });
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' }).length).toBeGreaterThan(0);
    expect(textOf(tree)).toContain('message is not available');
  });
});
