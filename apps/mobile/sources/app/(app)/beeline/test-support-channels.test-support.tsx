
import * as React from 'react';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoomViewHttpError, type ChatListItem, type ChatListView, type WorkspaceListView, } from '@beeline/buzz-client';

import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';


import BuzzChannels from './channels';

import { router } from 'expo-router';

import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';

import { loadPendingInvite } from '@/buzz/pending-invite';

import { resetInitialLandingForTests, markInitialLandingResolved, suppressInitialLandingNavigation } from '@/navigation/initial-landing';

import Index from '../index';

import { resetClientState } from '@/sync/client-reset';

import { saveActiveCommunityId } from '@/buzz/community-storage';

import { mobileSurfaceCache } from '@/buzz/surface-storage';

import { ConversationRow } from '@/components/buzz/ConversationRow';

import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';

import { CornerOpenToast } from '@/components/buzz/CornerOpenToast';

import { cornerOpenEnded } from '@/buzz/corner-open-status';

import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';

import { resetChatListStoresForTest } from '@/buzz/chat-list-store';

import {
  applyChatListCorners,
  getRoomCornerSummary,
  resetRoomCornerStore,
} from '@/buzz/room-corner-store';
const transitions = vi.hoisted(() => ({ held: false, pending: [] as Array<() => void> }));
export { transitions };

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, startTransition: (work: () => void) => {
    if (transitions.held) transitions.pending.push(work);
    else actual.startTransition(work);
  } };
});

vi.mock('@expo/vector-icons', async () => {
  const R = await import('react');
  return { Ionicons: (props: any) => R.createElement('Ionicons', props) };
});

vi.mock('react-native-keyboard-controller', async () => {
  const R = await import('react');
  return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) };
});


// These fixtures exercise the negotiated legacy compatibility path. The actual
// router owner/negotiation path has independent integration coverage.



const deck = vi.hoisted(() => ({
  appState: 'active' as string,
  pathname: '/beeline/channels',
  initialUrl: null as string | null | Promise<string | null>,
  naming: false,
  holdLayouts: false,
  routerMode: 'legacy' as 'legacy' | 'router' | 'pending',
  withholdWorkspaceSnapshot: false,
  appStateListeners: [] as Array<(state: string) => void>,
  bottomInset: 0,
  renderRows: false,
  chatsReads: 0,
  workspacesResponse: null as WorkspaceListView | Promise<WorkspaceListView> | null,
  workspaceFailures: [] as Error[],
  workspaceReads: 0,
  useRealWorkspaceRead: false,
  socketRequest: vi.fn(),
  selectedWorkspace: 'workspace' as string | null,
  deferWorkspaceSelection: false,
  workspaceSelectionListener: null as null | ((id: string | null) => void),
  chatsWorkspaces: [] as string[],
  chatsResponse: null as unknown,
  connectionState: 'connected' as 'connected' | 'connecting' | 'disconnected',
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
  createCorner: vi.fn(async (_roomId: string, _title: string, _cornerId?: string) => 'corner-new'),
  subscriptions: [] as Array<{
    filters: readonly { readonly '#h'?: readonly string[] }[];
    emit(event: MonolithSurfaceEvent): void;
  }>,
  focusEffect: null as null | (() => void | (() => void)),
  focusEffects: new Set<() => void | (() => void)>(),
  blur: null as null | (() => void),
  storedInvite: null as string | null | Promise<string | null>,
}));
export { deck };

const hotSurfaces = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  saved: new Map<string, unknown>(),
  listeners: new Map<string, Set<() => void>>(),
}));
export { hotSurfaces };


vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => {
    ReactModule.useEffect(() => { if (!deck.holdLayouts) props.onLayout?.(); }, [props.onLayout]);
    return ReactModule.createElement(name, props, props.children);
  };
  return {
    StyleSheet: {
      flatten: (style: any): any =>
        Array.isArray(style)
          ? Object.assign(
              {},
              ...style.map((part: any) =>
                Array.isArray(part) ? Object.assign({}, ...part) : part,
              ),
            )
          : style,
    },
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
    names.map((name) => [name, (props: any) => {
      React.useEffect(() => { if (name === 'RoomDeckLoadingView' && !deck.holdLayouts) props.onLayout?.(); }, [props.onLayout]);
      return React.createElement(name, props, props?.children);
    }]),
  );
}

vi.mock('@/components/buzz/TrayGlyph', () => hostModule('TrayGlyph'));

vi.mock('@/components/buzz/ChevronGlyph', () => ({
  CHEVRON_ROW_SIZE: 16,
  ChevronGlyph: () => null,
}));

vi.mock('@/components/buzz/CommunityRail', () =>
  hostModule('BuzzCommunityShell', 'CommunityDrawerTrigger', 'CommunitySwitcherTrigger'),
);

vi.mock('@/components/buzz/CornerGlyph', () => ({ CORNER_META_SIZE: 12, CornerGlyph: () => null }));

vi.mock('@/components/buzz/CornerWorkingPulse', () => hostModule('CornerWorkingPulse'));

vi.mock('@/components/buzz/DirectMessagePickerSheet', () => hostModule('DirectMessagePickerSheet'));

vi.mock('@/components/buzz/ExitGlyph', () => hostModule('ExitGlyph'));

vi.mock('@/components/buzz/MemberRosterRow', () => hostModule('MemberRosterRow'));

vi.mock('@/components/buzz/MemberPickerSheet', () => hostModule('MemberPickerSheet'));

vi.mock('@/components/buzz/Button', () => hostModule('Button'));

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
  usePathname: () => deck.pathname,
  router: { push: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () =>
    !deck.deferWorkspaceSelection && deck.selectedWorkspace
      ? { communityId: deck.selectedWorkspace }
      : {},
}));

vi.mock('react-native-gesture-handler', () => hostModule('Swipeable'));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: deck.bottomInset, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
  // One focused visit per mount; the test blurs and refocuses by hand.
  useFocusEffect: (effect: () => void | (() => void)) => {
    React.useEffect(() => {
      deck.focusEffects.add(effect);
      deck.focusEffect = () => {
        const cleanups = [...deck.focusEffects].map((visit) => visit());
        return () => cleanups.forEach((cleanup) => cleanup?.());
      };
      const cleanup = effect();
      const previousBlur = deck.blur;
      deck.blur = () => {
        previousBlur?.();
        cleanup?.();
      };
      return () => {
        deck.focusEffects.delete(effect);
        cleanup?.();
      };
    }, [effect]);
  },
}));

vi.mock('@/auth/desktop-auth-session', () => ({ initialAuthUrl: vi.fn(async () => deck.initialUrl) }));

vi.mock('@/buzz/pending-invite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/buzz/pending-invite')>();
  return { ...actual, loadPendingInvite: vi.fn(async () => deck.storedInvite instanceof Promise ? deck.storedInvite : actual.loadPendingInvite()) };
});

vi.mock('@/buzz/person-name', () => ({ isPersonNameOnboardingPending: vi.fn(async () => deck.naming) }));

vi.mock('@/auth/github-auth-session', () => ({ githubInstallationRedirectUri: () => '' }));

vi.mock('@/auth/github-installation-host', () => ({
  useGitHubInstallationSession: () => ({ start: vi.fn() }),
}));

vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'https://relay.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer', secretKey: new Uint8Array(32) })),
}));

vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => deck.selectedWorkspace),
  saveActiveCommunityId: vi.fn(async () => undefined),
  watchActiveCommunityId: vi.fn((_pubkey: string, listener: (id: string | null) => void) => {
    deck.workspaceSelectionListener = listener;
    if (!deck.deferWorkspaceSelection) void Promise.resolve(deck.selectedWorkspace).then(listener);
    return () => undefined;
  }),
}));

vi.mock('@/buzz/surface-storage', () => {
  const notify = (address: string) => {
    for (const listener of hotSurfaces.listeners.get(address) ?? []) listener();
  };
  const cache = {
    peek: vi.fn((address: string) =>
      deck.withholdWorkspaceSnapshot && address.includes('/workspaces')
        ? null
        : (hotSurfaces.values.get(address) ?? null),
    ),
    read: vi.fn(async () => null),
    write: vi.fn(async (address: string, value: unknown, _guard: unknown) => {
      cache.publish(address, value);
    }),
    persist: vi.fn(async () => undefined),
    remove: vi.fn(async (address: string) => {
      hotSurfaces.values.delete(address);
      notify(address);
    }),
    clear: vi.fn(() => {
      hotSurfaces.values.clear();
    }),
    publish: vi.fn((address: string, value: unknown) => {
      hotSurfaces.values.set(address, value);
      notify(address);
      return value;
    }),
    subscribe: vi.fn((address: string, listener: () => void) => {
      const listeners = hotSurfaces.listeners.get(address) ?? new Set<() => void>();
      listeners.add(listener);
      hotSurfaces.listeners.set(address, listeners);
      return () => {
        listeners.delete(listener);
      };
    }),
    fetch: vi.fn(async (address: string, guard: unknown, request: () => Promise<unknown>) => {
      const value = await request();
      await cache.write(address, value, guard);
      return value;
    }),
  };
  return {
    mobileSurfaceCache: cache,
    restoreStoredSurface: vi.fn((address: string, guard: (value: unknown) => boolean) => {
      const value = cache.peek(address) ?? hotSurfaces.saved.get(address);
      if (!guard(value)) return null;
      cache.publish(address, value);
      return value;
    }),
    surfaceAddress: vi.fn((relay, viewer, endpoint, params) =>
      JSON.stringify([relay, viewer, endpoint, params]),
    ),
  };
});

vi.mock('@/buzz/room-open-prefetch', () => ({ dispatchRoomOpenTap: vi.fn() }));

vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));

vi.mock('@/sync/transport/monolith-operation', () => ({ monolithPhoneOperation: vi.fn(), readServerSurface: vi.fn() }));

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
    createHumanCorner(roomId: string, title: string, ...rest: unknown[]) {
      return deck.createCorner(roomId, title, rest[2] as string | undefined);
    }
  },
}));

// The app-level Room list store watches through the shared live connection.
vi.mock('@/sync/transport/live-connection', () => ({
  useConnectionState: () => deck.connectionState,
  reconnectNow: () => {
    deck.reconnects += 1;
  },
  sharedLiveConnection: () => ({
    connectionStatus: () => deck.connectionState,
    subscribeConnectionStatus: () => () => undefined,
    reconnectNow: () => {
      deck.reconnects += 1;
    },
    request: deck.socketRequest,
    register: async (
      filters: readonly { readonly '#h'?: readonly string[] }[],
      listener: (event: MonolithSurfaceEvent) => void,
    ) => {
      deck.subscriptions.push({ filters, emit: listener });
      return () => undefined;
    },
    whenSubscribed: async () => undefined,
    isViewing: () => false,
    reconnect: () => {
      deck.reconnects += 1;
    },
  }),
}));

vi.mock('@/sync/transport/room-view-client', async () => ({
  isRoomViewTimeoutError: (
    await vi.importActual<typeof import('@/sync/transport/room-view-client')>(
      '@/sync/transport/room-view-client',
    )
  ).isRoomViewTimeoutError,
  RoomViewClient: class {
    async workspaces(): Promise<WorkspaceListView> {
      deck.workspaceReads += 1;
      if (deck.useRealWorkspaceRead) {
        const { RoomViewClient } = await vi.importActual<
          typeof import('@/sync/transport/room-view-client')
        >('@/sync/transport/room-view-client');
        return new RoomViewClient({
          baseUrl: 'https://relay.test',
          identity: { publicKey: 'a'.repeat(64), secretKey: new Uint8Array(32) },
        }).workspaces();
      }
      const failure = deck.workspaceFailures.shift();
      if (failure) throw failure;
      if (deck.workspacesResponse) return deck.workspacesResponse;
      return {
        workspaces: [{ id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 }],
        viewer,
        truncated: false,
        watchFilters: [],
      };
    }
    async chats(workspaceId: string): Promise<ChatListView> {
      deck.chatsWorkspaces.push(workspaceId);
      deck.chatsReads += 1;
      return deck.chatsResponse as ChatListView;
    }
  },
}));


(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;


export const viewer = { pubkey: 'viewer', kind: 'human' as const, name: 'Captain' };

export const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' };


export function chatList(latest: { id: string; text: string; createdAt: number }): ChatListView {
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


export function room(id: string, latestAt: number, extra: Partial<ChatListItem> = {}): ChatListItem {
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


export function listOf(chats: ChatListItem[], extra: Partial<ChatListView> = {}): ChatListView {
  return {
    workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
    chats,
    viewer,
    truncated: false,
    watchFilters: [{ '#h': chats.map((item) => item.room.id) }],
    ...extra,
  };
}


export function paintedRows(renderer: ReactTestRenderer): ChatListItem[] {
  const list = renderer.root.find(
    (node: { type: unknown; props: { testID?: string } }) =>
      node.type === 'SectionList' && node.props.testID === 'room-list',
  );
  return (list.props.sections as { data: ChatListItem[] }[]).flatMap((section) => section.data);
}


export function roomWatch() {
  const watch = deck.subscriptions.find((entry) =>
    entry.filters.some((filter) => filter['#h']?.includes('room-a')),
  );
  if (!watch) throw new Error('the deck is not watching room-a');
  return watch;
}


/** Longer than the scheduler's 500 ms floor and 1 s dirty ceiling. */
export const quiet = () => act(() => new Promise((resolve) => setTimeout(resolve, 1_100)));


export async function mountDeck(): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(React.createElement(BuzzChannels));
  });
  await vi.waitFor(() => expect(() => roomWatch()).not.toThrow());
  await quiet();
  return renderer;
}


beforeEach(() => {
  resetInitialLandingForTests();
  deck.pathname = '/beeline/channels';
  deck.initialUrl = null;
  deck.naming = false;
  deck.holdLayouts = false;
  hotSurfaces.saved.clear();
  hotSurfaces.values.clear();
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  vi.mocked(loadBuzzIdentity).mockReset().mockResolvedValue({ publicKey: 'viewer', secretKey: new Uint8Array(32) });
  vi.mocked(loadPendingInvite).mockClear();
  transitions.held = false;
  transitions.pending = [];
  // A case that never unmounts its deck must not hand its live list to the next.
  resetChatListStoresForTest();
  vi.mocked(mobileSurfaceCache.read).mockReset().mockResolvedValue(null);
  resetRoomCornerStore();
  deck.appState = 'active';
  deck.routerMode = 'legacy';
  deck.appStateListeners = [];
  deck.bottomInset = 0;
  deck.renderRows = false;
  vi.mocked(saveActiveCommunityId).mockClear();
  deck.chatsReads = 0;
  deck.chatsWorkspaces = [];
  deck.deferWorkspaceSelection = false;
  deck.workspaceSelectionListener = null;
  deck.workspacesResponse = null;
  deck.workspaceFailures = [];
  deck.workspaceReads = 0;
  deck.useRealWorkspaceRead = false;
  deck.socketRequest.mockReset();
  deck.selectedWorkspace = 'workspace';
  deck.reconnects = 0;
  deck.connectionState = 'connected';
  deck.storedInvite = null;
  vi.mocked(router.replace).mockClear();
  vi.mocked(router.push).mockClear();
  vi.mocked(dispatchRoomOpenTap).mockClear();
  deck.createRepository.mockClear();
  deck.createCorner.mockClear();
  cornerOpenEnded();
  deck.subscriptions.length = 0;
  deck.chatsResponse = chatList({ id: 'm1', text: 'earlier', createdAt: 10 });
});


afterEach(() => {
  vi.unstubAllGlobals();
  deck.focusEffect = null;
  deck.focusEffects.clear();
  deck.blur = null;
});


vi.mock('@/components/buzz/WorkspaceActionsMenu', () => hostModule('WorkspaceActionsMenu'));

vi.mock('@/components/buzz/RoomListToolbar', () =>
  hostModule('RoomListToolbar', 'RoomListTrayAction'),
);

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
export function fixtureScope1() {

  const savedViewer = 'a'.repeat(64);

  const savedWorkspace = '11111111-1111-4111-8111-111111111111';

  function saveDeck() {
    deck.selectedWorkspace = savedWorkspace;
    vi.mocked(loadBuzzIdentity).mockResolvedValue({ publicKey: savedViewer, secretKey: new Uint8Array(32) });
    const workspaces = { workspaces: [{ id: savedWorkspace, name: 'Work', role: 'member' as const, updatedAt: 1 }], viewer: { ...viewer, pubkey: savedViewer }, truncated: false, watchFilters: [] };
    hotSurfaces.saved.set(JSON.stringify(['https://relay.test', savedViewer, '/workspaces', undefined]), workspaces);
    const base = chatList({ id: 'c'.repeat(64), text: 'saved before effects', createdAt: 1 });
    const saved: ChatListView = {
      ...base,
      workspace: { ...base.workspace, id: savedWorkspace },
      viewer: { ...viewer, pubkey: savedViewer },
      chats: base.chats.map(item => ({
        ...item,
        room: { ...item.room, id: '22222222-2222-4222-8222-222222222222', workspaceId: savedWorkspace },
        latestMessage: { ...item.latestMessage!, author: { ...agent, pubkey: 'b'.repeat(64) } },
      })),
      watchFilters: [],
    };
    hotSurfaces.saved.set(JSON.stringify(['https://relay.test', savedViewer, '/workspace/:id/chats', { workspaceId: savedWorkspace }]), saved);
  }
return {
savedViewer,
savedWorkspace,
saveDeck,
};
}
export function fixtureScope3() {

  beforeEach(() => {
    hotSurfaces.values.clear();
  });
return {

};
}
export function fixtureScope5() {

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
return {
listIn,
touchIn,
pressIn,
swipeIn,
};
}
export function fixtureScope7() {

  beforeEach(() => {
    vi.useFakeTimers();
    hotSurfaces.values.clear();
  });

  afterEach(() => vi.useRealTimers());


  async function advance(ms = 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }


  async function openDeck() {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(React.createElement(BuzzChannels));
    });
    await advance();
    expect(deck.workspaceReads).toBe(1);
    expect(deck.chatsReads).toBe(1);
    return renderer;
  }


  async function activate(state: string) {
    await act(async () => {
      deck.appState = state;
      for (const listener of deck.appStateListeners) listener(state);
    });
  }


  async function missChanges() {
    await activate('background');
    deck.workspacesResponse = {
      workspaces: [{ id: 'workspace', name: 'Renamed Workspace', role: 'member', updatedAt: 2 }],
      viewer,
      truncated: false,
      watchFilters: [],
    };
    deck.chatsResponse = chatList({ id: 'm2', text: 'background reply', createdAt: 20 });
    const workspaceWatch = deck.subscriptions.find((entry) =>
      entry.filters.some((filter) => !filter['#h']),
    );
    expect(workspaceWatch).toBeDefined();
    await act(async () => {
      workspaceWatch!.emit({
        monolithLive: {
          type: 'workspace-changed',
          roomId: '',
          workspace: { id: 'workspace', name: 'Renamed Workspace' },
        },
      });
      roomWatch().emit({
        monolithLive: { type: 'invalidate', roomId: 'room-a', reason: 'phone-write' },
      });
    });
    await advance(180_000);
    expect(deck.workspaceReads).toBe(1);
    expect(deck.chatsReads).toBe(1);
  }
return {
advance,
openDeck,
activate,
missChanges,
};
}
