import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { CHROME, runBrowserProof, webProofShims } from '@/test/browserProof';
import * as React from 'react';
import { AccessibilityInfo } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.
const trayProtocol = vi.hoisted(() => ({
  mode: 'legacy' as 'legacy' | 'router' | 'pending',
  value: null as any,
  continuation: vi.fn(),
  admit: vi.fn(),
  paint: vi.fn(),
  prepare: vi.fn(),
  deliver: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
}));
vi.mock('@/buzz/router-family', () => ({
  useRouterFamily: () => trayProtocol.mode,
  holdRouterConnection: () => () => {},
}));
vi.mock('@/buzz/router-chat-list', () => ({
  acquireRoutedChatList: (_key: unknown, _consumer: unknown, legacy: () => unknown) => legacy(),
}));
vi.mock('@/buzz/command-owner', () => ({
  activeCommandOwner: () => ({
    canPrepare: () => true,
    prepare: trayProtocol.prepare,
    deliver: trayProtocol.deliver,
    cancel: trayProtocol.cancel,
  }),
}));
vi.mock('@/buzz/router-owner', () => ({
  routerFamilyMode: () => trayProtocol.mode,
  acquireRouterSavedContinuation: (...args: unknown[]) => {
    trayProtocol.continuation(...args);
    const view = { state: 'OPENING', value: null, cut: null, error: null };
    return { current: () => view, release: () => {} };
  },
  acquireRouterLane: () => {
    const view = {
      state: trayProtocol.value ? 'LIVE' : 'ABSENT',
      value: trayProtocol.value,
      cut: null,
      error: null,
    };
    return {
      current: () => view,
      release: () => {},
      subscribe: () => () => {},
      refreshVisibility: () => {},
    };
  },
  routerLaneSnapshot: () => ({ state: 'ABSENT', value: null, cut: null, error: null }),
  retryRouterLane: trayProtocol.retry,
  routerOwnerListPanel: () => {},
  admitRouterTrayCommand: trayProtocol.admit,
  admitRouterTrayPaint: trayProtocol.paint,
}));

const layout = vi.hoisted(() => ({ os: 'web', width: 1200 }));
const appState = vi.hoisted(() => ({
  current: 'active',
  listeners: new Set<(state: string) => void>(),
}));
const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const route = vi.hoisted(() => ({
  params: { communityId: 'ws', workspaceName: 'Clover Workspace' } as {
    communityId?: string;
    workspaceName?: string;
  },
}));
const workspaceSet = vi.hoisted(() => ({
  active: null as string | null,
  workspaces: [] as { id: string }[],
}));
const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
const phoneOperation = vi.hoisted(() => vi.fn());
const liveRegistrations = vi.hoisted(() => new Set<(event: unknown) => void>());
const roomRead = vi.hoisted(() => vi.fn());
const prefetchRoom = vi.hoisted(() => vi.fn());
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
    AppState: {
      get currentState() {
        return appState.current;
      },
      addEventListener: (_type: string, listener: (state: string) => void) => {
        appState.listeners.add(listener);
        return { remove: () => appState.listeners.delete(listener) };
      },
    },
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
    // Choice options reuse the transcript card's plate, which sizes from these metrics.
    transcriptCard: new Proxy({}, { get: () => 0 }),
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
  useLocalSearchParams: () => route.params,
  useRouter: () => navigation,
}));
const safeArea = vi.hoisted(() => ({ bottom: 0 }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: safeArea.bottom, left: 0 }),
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('@/auth/buzz-identity-storage', () => auth);
vi.mock('@/buzz/surface-storage', () => ({
  surfaceAddress: (_relay: string, _viewer: string, endpoint: string) => endpoint,
  mobileSurfaceCache: {
    read: vi.fn(async () => null),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}));
vi.mock('@/utils/open-external-url', () => ({ openExternalUrl: openExternal }));
vi.mock('@/components/buzz/MonoHull', async () => {
  const ReactModule = await import('react');
  return { PixelLoader: (props: any) => ReactModule.createElement('PixelLoader', props) };
});
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation }));
vi.mock('@/sync/transport/live-connection', () => ({
  sharedLiveConnection: () => ({
    register: async (_filters: unknown, listener: (event: unknown) => void) => {
      liveRegistrations.add(listener);
      return () => liveRegistrations.delete(listener);
    },
  }),
}));
vi.mock('@/push/push-room-prefetch', () => ({ prefetchPushRoom: prefetchRoom }));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    room = roomRead;
    workspace = vi.fn(async () => ({ workspace: { id: 'ws', name: 'Clover Workspace' } }));
    workspaces = vi.fn(async () => ({ workspaces: workspaceSet.workspaces }));
  },
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => workspaceSet.active),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    void Promise.resolve(workspaceSet.active).then(listener);
    return () => undefined;
  }),
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
import { ButtonRow } from '@/components/buzz/ButtonRow';
import { resetClientState } from '@/sync/client-reset';
import { mobileSurfaceCache } from '@/buzz/surface-storage';

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
    roomKind: 'room' as const,
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
    if (name === 'readTray') return { needs: { items: needs }, saved: { bookmarks } };
    if (name === 'readNeedsYou') return { items: needs };
    if (name === 'listMessageBookmarks') return { bookmarks };
    if (name === 'clearNeedsYouSection') {
      needs = [];
      return undefined;
    }
    if (name === 'clearMessageBookmarks') {
      bookmarks = [];
      return undefined;
    }
    return undefined;
  });
}

/** A socket gap asks the held tray for one covering read. */
async function returnToForeground() {
  await act(async () => {
    for (const listener of [...liveRegistrations])
      listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
  });
  await act(async () => undefined);
}

function textOf(tree: ReactTestRenderer): string {
  return tree.root
    .findAllByType('Text' as any)
    .flatMap((node: any) => node.props.children)
    .join(' ')
    .replace(/\s+/g, ' ');
}

beforeAll(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
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
  trayProtocol.mode = 'router';
  trayProtocol.value = null;
  trayProtocol.admit.mockReset().mockReturnValue({ wire: { operation: 'clearNeedsYouSection' } });
  trayProtocol.paint.mockReset().mockReturnValue([]);
  trayProtocol.prepare.mockReset().mockResolvedValue({ id: 'prepared-tray' });
  trayProtocol.deliver.mockReset().mockResolvedValue(undefined);
  trayProtocol.cancel.mockReset().mockResolvedValue(undefined);
  vi.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  trayProtocol.retry.mockReset();
  liveRegistrations.clear();
  resetClientState();
  auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'viewer' }));
  layout.os = 'web';
  layout.width = 1200;
  navigation.back.mockReset();
  navigation.push.mockReset();
  navigation.replace.mockReset();
  route.params = { communityId: 'ws', workspaceName: 'Clover Workspace' };
  workspaceSet.active = null;
  workspaceSet.workspaces = [];
  phoneOperation.mockReset();
  openExternal.mockClear();
  roomRead.mockReset();
  prefetchRoom.mockReset();
  serve({ bookmarks: [bookmark()] });
  roomRead.mockImplementation(async (id: string) => (id === 'room-1' ? parentRoom : cornerRoom));
});

/** Trees still mounted at a test's end; a left-over tray would hold its list in the store. */
const mountedTrees: ReactTestRenderer[] = [];
afterEach(async () => {
  for (const tree of mountedTrees.splice(0)) await act(async () => tree.unmount());
});

async function renderTray(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TrayScreen />);
  });
  mountedTrees.push(tree);
  await act(async () => undefined);
  return tree;
}

describe('negotiated Tray consumer', () => {
  it('renders canonical rows and sends no legacy read or gap reload', async () => {
    trayProtocol.mode = 'router';
    trayProtocol.value = {
      needs: { items: [need()] },
      saved: {
        windowId: 'window',
        rows: [
          { bookmarkId: 'incarnation', order: '1,msg-1', before: 'anchor', value: bookmark() },
        ],
      },
    };
    const tree = await renderTray();
    expect(tree.root.findByProps({ testID: 'needs-you-ask-1' })).toBeDefined();
    expect(tree.root.findByProps({ testID: 'bookmark-msg-1' })).toBeDefined();
    await returnToForeground();
    expect(phoneOperation).not.toHaveBeenCalled();
    expect(trayProtocol.retry).not.toHaveBeenCalled();
  });

  it.each([390, 1200])(
    'opens a bookmark source through the Room route at width %s',
    async (width) => {
      layout.width = width;
      trayProtocol.value = {
        needs: { items: [] },
        saved: {
          windowId: 'window',
          rows: [
            { bookmarkId: 'incarnation', order: '1,msg-1', before: 'anchor', value: bookmark() },
          ],
        },
      };
      const tree = await renderTray();
      await act(async () => tree.root.findByProps({ testID: 'bookmark-msg-1' }).props.onPress());
      expect(navigation.push).toHaveBeenCalledWith({
        pathname: '/beeline/chat/[channelId]',
        params: {
          channelId: 'corner-1',
          notificationMessageId: 'msg-1',
          notificationResponseId: 'bookmark:msg-1',
          communityId: 'ws',
        },
      });
      expect(roomRead).not.toHaveBeenCalled();
      expect(phoneOperation).not.toHaveBeenCalled();
    },
  );

  it('opens a desktop Needs-you source through the Room route', async () => {
    trayProtocol.value = { needs: { items: [need()] }, saved: { windowId: 'window', rows: [] } };
    const tree = await renderTray();
    await act(async () => tree.root.findByProps({ testID: 'needs-you-ask-1' }).props.onPress());
    expect(navigation.push).toHaveBeenCalledWith({
      pathname: '/beeline/chat/[channelId]',
      params: {
        channelId: 'room-1',
        notificationMessageId: 'ask-1',
        notificationResponseId: 'needs-you:ask-1',
        communityId: 'ws',
      },
    });
  });

  it('uses the existing Load More Saved button for one owned continuation and no legacy read', async () => {
    trayProtocol.mode = 'router';
    trayProtocol.continuation.mockClear();
    trayProtocol.value = {
      needs: { items: [] },
      saved: { windowId: 'window', rows: [], next: 'saved1.Y3Vyc29y' },
    };
    const tree = await renderTray();
    expect(trayProtocol.continuation).not.toHaveBeenCalled();
    await act(async () => {
      tree.root.findByProps({ testID: 'bookmarks-more' }).props.onPress();
    });
    expect(trayProtocol.continuation).toHaveBeenCalledTimes(1);
    expect(trayProtocol.continuation.mock.calls[0]!.slice(0, 2)).toEqual(['ws', 'saved1.Y3Vyc29y']);
    expect(phoneOperation).not.toHaveBeenCalled();
  });

  it('a section Clear prepares at the tap, keeps canonical rows, and Undo cancels without a send', async () => {
    trayProtocol.mode = 'router';
    trayProtocol.value = { needs: { items: [need()] }, saved: { windowId: 'window', rows: [] } };
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress();
    });
    expect(trayProtocol.admit).toHaveBeenCalledWith('ws', {
      operation: 'clearNeedsYouSection',
      input: { workspaceId: 'ws' },
    });
    expect(trayProtocol.prepare).toHaveBeenCalledTimes(1);
    expect(trayProtocol.deliver).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ testID: 'needs-you-ask-1' })).toBeDefined();
    let finishCancellation!: () => void;
    trayProtocol.cancel.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCancellation = resolve;
        }),
    );
    let undo!: Promise<void>;
    await act(async () => {
      undo = tree.root
        .findByProps({ testID: 'tray-clear-undo' })
        .findByProps({ accessibilityRole: 'button' })
        .props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'tray-clear-undo' })).toBeDefined();
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith('Restored');
    await act(async () => {
      finishCancellation();
      await undo;
    });
    expect(tree.root.findAllByProps({ testID: 'tray-clear-undo' })).toHaveLength(0);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Restored');
    expect(trayProtocol.cancel).toHaveBeenCalledWith('prepared-tray');
    expect(trayProtocol.deliver).not.toHaveBeenCalled();
    expect(phoneOperation).not.toHaveBeenCalled();
  });

  it('retains a pending clear and shows the refusal when another tab has dispatched it', async () => {
    trayProtocol.value = { needs: { items: [need()] }, saved: { windowId: 'window', rows: [] } };
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByProps({ testID: 'tray-clear-needs' }).props.onPress();
    });
    let rejectCancellation!: (cause: Error) => void;
    trayProtocol.cancel.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancellation = reject;
        }),
    );
    let undo!: Promise<void>;
    await act(async () => {
      undo = tree.root
        .findByProps({ testID: 'tray-clear-undo' })
        .findByProps({ accessibilityRole: 'button' })
        .props.onPress();
    });
    expect(tree.root.findByProps({ testID: 'tray-clear-undo' })).toBeDefined();
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith('Restored');
    await act(async () => {
      rejectCancellation(new Error('Command already admitted to transport'));
      await undo;
    });
    expect(trayProtocol.cancel).toHaveBeenCalledWith('prepared-tray');
    expect(tree.root.findByProps({ testID: 'tray-clear-undo' })).toBeDefined();
    expect(textOf(tree)).toContain('Command already admitted to transport');
    expect(AccessibilityInfo.announceForAccessibility).not.toHaveBeenCalledWith('Restored');
    expect(phoneOperation).not.toHaveBeenCalled();
  });

  it('routes a painted viewport through the screen command and never the legacy seen reducer', async () => {
    trayProtocol.mode = 'router';
    const unseen = need({ expiresAt: undefined });
    trayProtocol.value = { needs: { items: [unseen] }, saved: { windowId: 'window', rows: [] } };
    trayProtocol.paint.mockReturnValue([{ wire: { operation: 'markNeedsYouSeen' } }]);
    const tree = await renderTray();
    await act(async () => {
      tree.root.findByType('FlatList' as never).props.onViewableItemsChanged({
        viewableItems: [{ isViewable: true, item: { type: 'needs', item: unseen } }],
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(trayProtocol.paint).toHaveBeenCalledWith('ws', ['ask-1']);
    expect(trayProtocol.deliver).toHaveBeenCalledWith('prepared-tray');
    expect(phoneOperation).not.toHaveBeenCalled();
  });

  it('pending negotiation hides prior canonical rows and keeps every legacy read idle', async () => {
    trayProtocol.mode = 'router';
    trayProtocol.value = {
      needs: { items: [need()] },
      saved: {
        windowId: 'window',
        rows: [
          { bookmarkId: 'incarnation', order: '1,msg-1', before: 'anchor', value: bookmark() },
        ],
      },
    };
    const tree = await renderTray();
    trayProtocol.mode = 'pending';
    await act(async () => tree.update(<TrayScreen />));
    expect(tree.root.findAllByProps({ testID: 'needs-you-ask-1' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'bookmark-msg-1' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'tray-loader' })).toBeDefined();
    expect(phoneOperation).not.toHaveBeenCalled();
  });
});
