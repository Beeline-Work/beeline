import * as React from 'react';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';


import TrayScreen from "../../app/(app)/beeline/tray";

import { ButtonRow } from '@/components/buzz/ButtonRow';

import { NeedsYouCell } from '@/components/buzz/NeedsYouCell';

import * as needFormatting from '@/buzz/needs-you';

import {
  useNeedsYouCount,
  useTrayList,
  holdNeedsYou,
  acknowledgePaintedNeedsYou,
} from '@/buzz/needs-you-store';

import { resetClientState } from '@/sync/client-reset';

import { mobileSurfaceCache } from '@/buzz/surface-storage';


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
export { trayProtocol };


vi.mock('@/buzz/router-chat-list', () => ({
  acquireRoutedChatList: (_key: unknown, _consumer: unknown, legacy: () => unknown) => legacy(),
}));


const layout = vi.hoisted(() => ({ os: 'web', width: 1200 }));
export { layout };

const appState = vi.hoisted(() => ({
  current: 'active',
  listeners: new Set<(state: string) => void>(),
}));
export { appState };

const navigation = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
export { navigation };

const route = vi.hoisted(() => ({
  params: { communityId: 'ws', workspaceName: 'Clover Workspace' } as {
    communityId?: string;
    workspaceName?: string;
  },
}));
export { route };

const workspaceSet = vi.hoisted(() => ({
  active: null as string | null,
  workspaces: [] as { id: string }[],
}));
export { workspaceSet };

const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
export { openExternal };

const phoneOperation = vi.hoisted(() => vi.fn());
export { phoneOperation };

const liveRegistrations = vi.hoisted(() => new Set<(event: unknown) => void>());
export { liveRegistrations };

const roomRead = vi.hoisted(() => vi.fn());
export { roomRead };

const prefetchRoom = vi.hoisted(() => vi.fn());
export { prefetchRoom };

const auth = vi.hoisted(() => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));
export { auth };


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
export { theme };

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
export { safeArea };

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

vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: phoneOperation, readServerSurface: (_authority: unknown, ...args: unknown[]) => phoneOperation(...args) }));

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


export function applyNeedsYouLiveDelta(delta: unknown) {
  for (const listener of liveRegistrations) listener({ monolithLive: { ...(delta as object), type: 'needs-you-delta' } });
}

export const person = {
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


export function bookmark(overrides: Record<string, unknown> = {}) {
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


export function need(overrides: Record<string, unknown> = {}) {
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
export function serve({
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
export async function returnToForeground() {
  await act(async () => {
    for (const listener of [...liveRegistrations])
      listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'reconnect' } });
  });
  await act(async () => undefined);
}


export function textOf(tree: ReactTestRenderer): string {
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
  trayProtocol.mode = 'legacy';
  trayProtocol.value = null;
  trayProtocol.admit.mockReset().mockReturnValue({ wire: { operation: 'clearNeedsYouSection' } });
  trayProtocol.paint.mockReset().mockReturnValue([]);
  trayProtocol.prepare.mockReset().mockResolvedValue({ id: 'prepared-tray' });
  trayProtocol.deliver.mockReset().mockResolvedValue(undefined);
  trayProtocol.cancel.mockReset().mockResolvedValue(undefined);
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
export const mountedTrees: ReactTestRenderer[] = [];

afterEach(async () => {
  for (const tree of mountedTrees.splice(0)) await act(async () => tree.unmount());
});


export async function renderTray(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<TrayScreen />);
  });
  mountedTrees.push(tree);
  await act(async () => undefined);
  return tree;
}
export function fixtureScope1({ os, width, remove }: Pick<{ surface: string; os: string; width: number; remove: boolean; }, "os" | "width" | "remove">) {

  const texts = (node: any): string[] =>
    node.findAllByType('Text' as any).map((textNode: any) =>
      [textNode.props.children]
        .flat(Infinity)
        .filter((part: unknown) => typeof part === 'string')
        .join(''),
    );
return {
texts,
};
}
export function fixtureScope7() {

  /** The badge a Room list or sidebar paints, beside an optionally mounted tray. */
  function BadgeAndTray({ tray }: { tray: boolean }) {
    const count = useNeedsYouCount('ws', 1);
    return (
      <>
        {React.createElement('Text', { testID: 'badge' }, String(count))}
        {tray ? <TrayScreen /> : null}
      </>
    );
  }


  function badge(tree: ReactTestRenderer): number {
    return Number(tree.root.findByProps({ testID: 'badge' }).props.children);
  }


  function rows(tree: ReactTestRenderer): number {
    return tree.root.findAll(
      (node: any) =>
        /^needs-you-ask-\d$/.test(String(node.props.testID ?? '')) && typeof node.type === 'string',
    ).length;
  }


  /** The server: `needs` is what a list read sees; the count is its length. */
  function serveNeeds(state: { needs: unknown[]; failClear?: boolean }) {
    phoneOperation.mockImplementation(async (name: string, input: { messageId?: string }) => {
      if (name === 'readTray') return { needs: { items: state.needs }, saved: { bookmarks: [] } };
      if (name === 'readNeedsYou') return { items: state.needs };
      if (name === 'countNeedsYou') return { count: state.needs.length };
      if (name === 'listMessageBookmarks') return { bookmarks: [] };
      if (name === 'clearNeedsYou') {
        if (state.failClear) throw new Error('clear refused');
        state.needs = state.needs.filter((item: any) => item.messageId !== input.messageId);
      }
      return undefined;
    });
  }


  async function render(tray: boolean): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<BadgeAndTray tray={tray} />);
    });
    mountedTrees.push(tree);
    await act(async () => undefined);
    return tree;
  }


  async function swipe(tree: ReactTestRenderer, id: string) {
    await act(async () => {
      tree.root.findByProps({ testID: `needs-you-swipe-${id}` }).props.onSwipeableOpen('left');
    });
    await act(async () => undefined);
  }


  beforeEach(() => {
    layout.os = 'android';
    layout.width = 390;
  });


  /** Clears and list reads wait until the test answers them; a read sees `server.needs`. */
  function holdClearsAndReads(server: { needs: unknown[] }) {
    const clears: Array<{ ok(): void; fail(): void }> = [];
    const reads: Array<() => void> = [];
    phoneOperation.mockImplementation((name: string) => {
      if (name === 'readNeedsYou') {
        const items = server.needs;
        return new Promise((resolve) => {
          reads.push(() => resolve({ items }));
        });
      }
      if (name === 'clearNeedsYou' || name === 'clearNeedsYouSection')
        return new Promise((resolve, reject) => {
          clears.push({
            ok: () => resolve(undefined),
            fail: () => reject(new Error('clear refused')),
          });
        });
      if (name === 'listMessageBookmarks') return Promise.resolve({ bookmarks: [] });
      return Promise.resolve(undefined);
    });
    return { clears, reads };
  }


  async function gap() {
    await act(async () => {
      for (const listener of [...liveRegistrations])
        listener({ monolithLive: { type: 'invalidate', roomId: '', reason: 'needs-you-gap' } });
    });
    await act(async () => undefined);
  }


  /** A's clears wait on `fail`; after the switch B's server holds one other cell. */
  function serveSwitch() {
    let fail!: () => void;
    const refused = new Promise<never>((_resolve, reject) => {
      fail = () => reject(new Error('clear refused'));
    });
    refused.catch(() => undefined);
    const server = { needs: [need(), need({ messageId: 'ask-2' })] as unknown[] };
    phoneOperation.mockImplementation(async (name: string) => {
      if (name === 'readTray') return { needs: { items: server.needs }, saved: { bookmarks: [] } };
      if (name === 'readNeedsYou') return { items: server.needs };
      if (name === 'countNeedsYou') return { count: server.needs.length };
      if (name === 'listMessageBookmarks') return { bookmarks: [] };
      if (name === 'clearNeedsYou' || name === 'clearNeedsYouSection') return refused;
      return undefined;
    });
    return {
      fail,
      async switchToB(): Promise<ReactTestRenderer> {
        server.needs = [need({ messageId: 'ask-3' })];
        auth.loadBuzzIdentity.mockImplementation(async () => ({ publicKey: 'other-viewer' }));
        await act(async () => resetClientState());
        return render(true);
      },
    };
  }
return {
BadgeAndTray,
badge,
rows,
serveNeeds,
render,
swipe,
holdClearsAndReads,
gap,
serveSwitch,
};
}
export function fixtureScope8() {

  function cleared() {
    return phoneOperation.mock.calls.filter(([name]) => name === 'clearNeedsYou');
  }
return {
cleared,
};
}
export function fixtureScope9() {

  const approval = () =>
    need({
      messageId: 'grant-1',
      approval: { kind: 'grant', actor: 'BBC', ask: 'asks to run', subject: 'git push' },
    });

  const calls = (name: string) => phoneOperation.mock.calls.filter(([called]) => called === name);

  const ids = (tree: ReactTestRenderer, pattern: RegExp) =>
    tree.root
      .findAll((node: any) => pattern.test(String(node.props.testID ?? '')))
      .map((node: any) => node.props.testID)
      .filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);


  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(() => vi.useRealTimers());
return {
approval,
calls,
ids,
};
}
export function fixtureScope10() {

  const approvalItem = (actions: unknown[], extra = {}) =>
    need({
      messageId: 'inline-1',
      roomId: 'system-dm',
      roomKind: 'direct',
      roomName: 'System',
      approval: {
        kind: 'grant',
        actor: 'Hoots',
        ask: 'asks to run',
        subject: 'npm test',
        literal: true,
        actions,
        ...extra,
      },
    });

  const clickAction = async (tree: ReactTestRenderer, index = 0) => {
    await act(async () => {
      await tree.root
        .findByProps({ testID: `needs-you-action-inline-1-${index}` })
        .props.onPress({ stopPropagation() {} });
    });
  };
return {
approvalItem,
clickAction,
};
}
