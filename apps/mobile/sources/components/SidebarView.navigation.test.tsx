import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPush = vi.hoisted(() => vi.fn());
const routerNavigate = vi.hoisted(() => vi.fn());
const saveActiveCommunityId = vi.hoisted(() => vi.fn(async () => undefined));
const loadLastViewedChannel = vi.hoisted(() => vi.fn(async () => null));
const route = vi.hoisted(() => ({
  communityId: undefined as string | undefined,
  parent: undefined as string | undefined,
  pathname: '/beeline/channels',
}));
const viewer = vi.hoisted(() => ({ kind: 'human' as 'human' | 'agent' }));
const workspaceRole = vi.hoisted(() => ({ current: 'owner' as 'owner' | 'admin' | 'member' }));
const roomCornersExpanded = vi.hoisted(() => new Map<string, boolean>());
const saveDesktopRoomCornersExpanded = vi.hoisted(() =>
  vi.fn(async (roomId: string, expanded: boolean) => {
    roomCornersExpanded.set(roomId, expanded);
  }),
);
const chats = vi.hoisted(() =>
  vi.fn(async (workspaceId: string) => ({
    workspace: { id: workspaceId, name: workspaceId, role: workspaceRole.current },
    viewer: { kind: viewer.kind },
    chats:
      workspaceId === 'workspace-a'
        ? [
            { room: { id: 'room-a', workspaceId, name: 'Alpha' }, cornerCount: 1 },
            {
              room: { id: 'dm-a', workspaceId, name: 'Direct' },
              directMessage: { peer: { name: 'Mina' } },
            },
          ]
        : [],
  })),
);
const windowListeners = new Map<string, (event: any) => void>();
const viewport = vi.hoisted(() => ({ width: 1280 }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'web' },
    Pressable: host('Pressable'),
    TouchableOpacity: host('TouchableOpacity'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
    useWindowDimensions: () => ({ width: viewport.width, height: 900 }),
  };
});

const theme = vi.hoisted(() => ({
  colors: {
    divider: '#333',
    groupped: { background: '#14091a' },
    success: '#0a0',
    surface: '#190e21',
    surfaceSelected: '#24132f',
    text: '#fff',
    textLink: '#b08a4a',
    textSecondary: '#aaa',
  },
  buzz: {
    accent: '#b08a4a',
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    type: { body: {}, bodyStrong: {}, machine: {}, meta: {}, sectionHead: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) => (typeof factory === 'function' ? factory(theme) : factory),
  },
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('expo-router', () => ({
  useGlobalSearchParams: () => route,
  usePathname: () => route.pathname,
  useRouter: () => ({ push: routerPush, navigate: routerNavigate }),
}));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0, useIsDesktop: () => true }));
vi.mock('@/utils/platform', () => ({ isDesktopPlatform: () => true }));
vi.mock('@/auth/buzz-identity-storage', () => ({
  getEffectiveRelayUrl: vi.fn(async () => 'http://server.test'),
  loadBuzzIdentity: vi.fn(async () => ({ publicKey: 'viewer' })),
}));
vi.mock('@/buzz/community-storage', () => ({
  loadActiveCommunityId: vi.fn(async () => 'workspace-a'),
  loadLastViewedChannel,
  saveActiveCommunityId,
  subscribeActiveCommunityId: vi.fn(() => () => undefined),
}));
vi.mock('@/sync/transport/room-view-client', () => ({
  RoomViewClient: class {
    workspaces = vi.fn(async () => ({
      workspaces: [
        { id: 'workspace-a', name: 'Alpha Workspace' },
        { id: 'workspace-empty', name: 'Empty Workspace' },
      ],
      viewer: { pubkey: 'viewer', kind: 'human', name: 'Ada Lovelace' },
    }));
    chats = chats;
    corners = vi.fn(async () => ({
      corners: [
        {
          corner: { id: 'corner-a', name: 'Fix fixture' },
          state: 'working',
          lifecycle: { lifecycle: 'open', checks: 'unknown' },
        },
      ],
    }));
  },
}));
vi.mock('@/buzz/desktop-workbench-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/desktop-workbench-state')>()),
  loadDesktopRoomCornersExpanded: vi.fn(
    async (roomId: string, fallback = true) => roomCornersExpanded.get(roomId) ?? fallback,
  ),
  saveDesktopRoomCornersExpanded,
}));
vi.mock('@/buzz/room-list-row', () => ({
  displayGroupedCornerTitle: vi.fn(() => ''),
  NO_ACTIVITY_PREVIEW: 'No activity',
  roomListSections: vi.fn((items) => {
    const rooms = items.filter((item: any) => !item.directMessage);
    const directMessages = items.filter((item: any) => item.directMessage);
    return [
      ...(rooms.length ? [{ kind: 'rooms', data: rooms }] : []),
      ...(directMessages.length ? [{ kind: 'messages', data: directMessages }] : []),
    ];
  }),
  roomRowName: vi.fn((item) => ({
    name: item.directMessage?.peer.name ?? item.room.name,
    sigil: item.directMessage ? '@' : '#',
  })),
  roomRowNeedsAttention: vi.fn(() => false),
  roomRowPreview: vi.fn(() => ({ text: 'No activity' })),
}));
vi.mock('@/buzz/room-view-presentation', () => ({
  workspaceRailItem: (workspace: { id: string; name: string }) => ({
    communityId: workspace.id,
    name: workspace.name,
  }),
}));
vi.mock('@/buzz/desktop-work-pane', () => ({
  selectDesktopWorkCorner: vi.fn(),
  writeDesktopCornerDrag: vi.fn(),
}));
vi.mock('@/components/buzz/RoomListSectionHeader', async () => {
  const ReactModule = await import('react');
  return {
    // Render the header type with its action as a real Pressable so tests can
    // reach the section-head creation controls by testID.
    RoomListSectionHeader: (props: any) =>
      ReactModule.createElement(
        'RoomListSectionHeader',
        props,
        props.onAction
          ? ReactModule.createElement('Pressable', {
              testID: props.actionTestID,
              accessibilityLabel: props.actionAccessibilityLabel,
              accessibilityRole: 'button',
              onPress: props.onAction,
            })
          : null,
      ),
  };
});
vi.mock('@/components/buzz/CommunityRail', async () => {
  const ReactModule = await import('react');
  return {
    CommunitySwitcherTrigger: (props: any) =>
      ReactModule.createElement('CommunitySwitcherTrigger', props),
  };
});
vi.mock('@/components/buzz/DesktopWorkspaceRail', async () => {
  const ReactModule = await import('react');
  return {
    DesktopWorkspaceRail: (props: any) => ReactModule.createElement('DesktopWorkspaceRail', props),
  };
});
vi.mock('@/components/buzz/IdentityMark', () => ({
  IdentityMark: (props: any) => React.createElement('IdentityMark', props),
}));
vi.mock('@/components/buzz/MembersGlyph', () => ({
  MEMBERS_GLYPH_STROKE_WIDTH: 1.25,
  chromeStrokeWidth: () => 1.25,
  MembersGlyph: (props: any) => React.createElement('MembersGlyph', props),
}));
vi.mock('@/components/buzz/SurfaceGlyphLoader', async () => {
  const ReactModule = await import('react');
  return {
    SurfaceGlyphLoader: (props: any) => ReactModule.createElement('SurfaceGlyphLoader', props),
  };
});

vi.mock('@/components/buzz/HullActionSheet', () => ({
  HullActionSheetModal: ({ visible, children }: any) => (visible ? children : null),
  HullActionSheetRow: (props: any) => React.createElement('Pressable', props),
  HullActionSheetCancel: (props: any) => React.createElement('Pressable', props),
}));

import { SidebarView } from './SidebarView';
import { selectDesktopWorkCorner } from '@/buzz/desktop-work-pane';
let tree: ReactTestRenderer;
function control(id: string) {
  const nodes = tree.root.findAll(
    (node: any) => typeof node.type === 'string' && node.props.testID === id,
  );
  if (!nodes.length) throw new Error(`Missing control ${id}`);
  return nodes[0];
}
function openMenu() {
  act(() => control('workspace-menu').props.onPress());
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeAll(() => {
  (globalThis as any).window = {
    addEventListener: (name: string, listener: (event: any) => void) =>
      windowListeners.set(name, listener),
    removeEventListener: (name: string) => windowListeners.delete(name),
  };
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('desktop Workspace navigation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    windowListeners.clear();
    route.communityId = undefined;
    route.parent = undefined;
    route.pathname = '/beeline/channels';
    viewport.width = 1280;
    viewer.kind = 'human';
    workspaceRole.current = 'owner';
    roomCornersExpanded.clear();
    await act(async () => {
      tree = create(<SidebarView />);
    });
    await settle();
  });

  it('opens from Command-or-Control Shift S', () => {
    const preventDefault = vi.fn();
    act(() =>
      windowListeners.get('keydown')?.({
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        key: 's',
        target: null,
        preventDefault,
      }),
    );

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(true);
  });

  it('shows the permanent Workspace strip on narrow desktop without removing its actions', async () => {
    viewport.width = 1024;
    await act(async () => tree.update(<SidebarView key="narrow-desktop" />));
    await settle();
    expect(control('desktop-workspace-strip')).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'profile-settings-navigation' })).toHaveLength(0);
    act(() => control('desktop-strip-add-workspace').props.onPress());
    expect(routerPush).toHaveBeenCalledWith('/beeline/community');
    act(() => control('desktop-strip-account').props.onPress());
    expect(routerPush).toHaveBeenCalledWith('/beeline/settings');
    await act(async () => control('desktop-strip-workspace-workspace-empty').props.onPress());
    expect(tree.root.findByType('CommunitySwitcherTrigger').props.community.name).toBe(
      'Empty Workspace',
    );
  });

  it('switches header, list, URL, and closes the switcher for an empty Workspace', async () => {
    expect(tree.root.findByType('CommunitySwitcherTrigger').props.community.name).toBe(
      'Alpha Workspace',
    );

    act(() => tree.root.findByType('CommunitySwitcherTrigger').props.onPress());
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(true);

    await act(async () => {
      tree.root.findByType('DesktopWorkspaceRail').props.onSelect('workspace-empty');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(tree.root.findByType('CommunitySwitcherTrigger').props.community.name).toBe(
      'Empty Workspace',
    );
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(false);
    expect(
      tree.root
        .findAllByType('Text')
        .some(
          (node: { props: { children?: unknown } }) =>
            node.props.children === 'No rooms or direct messages yet.',
        ),
    ).toBe(true);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-empty' },
    });
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
  });

  it('opens and closes the overlay rail without replacing the Room list', () => {
    const rail = tree.root.findByType('DesktopWorkspaceRail');
    expect(rail.props.open).toBe(false);
    expect(control('desktop-room-search')).toBeDefined();

    act(() => tree.root.findByType('CommunitySwitcherTrigger').props.onPress());
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(true);
    expect(control('desktop-room-search')).toBeDefined();

    act(() => tree.root.findByType('DesktopWorkspaceRail').props.onClose());
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(false);
  });

  it("keeps profile settings reachable from the persistent desktop navigation as the viewer's own face", () => {
    const profileSettings = control('desktop-strip-account');

    expect(profileSettings.props.accessibilityLabel).toBe('Ada Lovelace — Settings');
    expect(profileSettings.findByType('IdentityMark').props).toMatchObject({
      seed: 'viewer',
      kind: 'human',
    });
    act(() => profileSettings.props.onPress());

    expect(routerPush).toHaveBeenCalledWith('/beeline/settings');
  });

  it('gives search a visible focus state', () => {
    const search = control('desktop-room-search');
    expect(search.props.accessibilityLabel).toBe('Search Rooms and direct messages');
    act(() => search.props.onFocus());
    expect(control('desktop-room-search').props.style).toContainEqual({
      borderBottomColor: '#b08a4a',
    });
  });

  it('routes the heading glyphs to Members and Bookmarks, with no Workbench sidebar entry', () => {
    expect(tree.root.findAllByProps({ testID: 'desktop-workbench' })).toHaveLength(0);

    openMenu();
    const members = control('workspace-menu-members');
    act(() => members.props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/members',
      params: { communityId: 'workspace-a' },
    });

    act(() => control('desktop-bookmarks').props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/bookmarks',
      params: { communityId: 'workspace-a' },
    });
  });

  it('offers Workspace settings to a privileged member and routes with the Workspace id', () => {
    // ChatListView.workspace.role is the manage axis: owner/admin ⇒
    // viewer.permissions.manage, member ⇒ not. Same signal as workspace.tsx.
    openMenu();
    const settings = control('workspace-menu-settings');

    act(() => settings.props.onPress());

    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/settings/workspace',
      params: { communityId: 'workspace-a' },
    });
  });

  it('offers Workspace settings to a Workspace admin', async () => {
    workspaceRole.current = 'admin';
    await act(async () => {
      tree.update(<SidebarView key="admin-viewer" />);
    });
    await settle();

    openMenu();
    expect(control('workspace-menu-settings')).toBeDefined();
  });

  it('does not offer Workspace settings to an ordinary member', async () => {
    workspaceRole.current = 'member';
    await act(async () => {
      tree.update(<SidebarView key="member-viewer" />);
    });
    await settle();

    openMenu();
    expect(tree.root.findAllByProps({ testID: 'workspace-menu-settings' })).toHaveLength(0);
    expect(control('desktop-bookmarks')).toBeDefined();
  });

  it('keeps Workspace settings and profile settings from appearing selected together', async () => {
    route.pathname = '/beeline/settings/workspace';
    await act(async () => {
      tree.update(<SidebarView key="workspace-settings-route" />);
    });
    await settle();

    expect(control('desktop-strip-account').props.accessibilityState).toEqual({
      selected: false,
    });
    openMenu();
    expect(control('workspace-menu-settings')).toBeDefined();
  });

  it('carries the section creation controls in the section heads', () => {
    expect(
      tree.root
        .findAllByType('RoomListSectionHeader')
        .map((header: { props: { title: string } }) => header.props.title),
    ).toEqual(['Rooms', 'Messages']);
    expect(
      tree.root
        .findAllByProps({ testID: 'desktop-new-room' })
        .map((row: { props: { accessibilityLabel: string } }) => row.props.accessibilityLabel),
    ).toEqual(['Create a new Room']);
    expect(control('desktop-new-direct-message').props.accessibilityLabel).toBe(
      'Start a direct message',
    );
    expect(
      tree.root
        .findAllByType('Text')
        .some((node: { props: { children?: unknown } }) => node.props.children === 'New section'),
    ).toBe(false);
  });

  it('routes the section-head pluses to the existing Room dialog and direct-message picker', () => {
    const push = (testID: string) => {
      routerPush.mockClear();
      act(() => tree.root.findByProps({ testID }).props.onPress());
      return routerPush.mock.calls[0][0];
    };

    expect(push('desktop-new-room')).toEqual({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-a', newRoom: expect.any(String) },
    });
    expect(push('desktop-new-direct-message')).toEqual({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-a', newDirectMessage: expect.any(String) },
    });
  });

  it('hides the Rooms plus and the settings glyph from an ordinary member and takes nothing else away', async () => {
    workspaceRole.current = 'member';
    await act(async () => {
      tree.update(<SidebarView key="member-viewer" />);
    });
    await settle();

    expect(tree.root.findAllByProps({ testID: 'desktop-new-room' })).toHaveLength(0);
    openMenu();
    expect(tree.root.findAllByProps({ testID: 'workspace-menu-settings' })).toHaveLength(0);
    expect(control('desktop-new-direct-message')).toBeDefined();
    expect(control('desktop-bookmarks')).toBeDefined();
    expect(control('workspace-menu-members')).toBeDefined();
    expect(control('desktop-strip-account')).toBeDefined();
  });

  it('does not offer New Room to an agent even with an elevated Workspace role', async () => {
    viewer.kind = 'agent';
    await act(async () => {
      tree.update(<SidebarView key="agent-viewer" />);
    });
    await settle();

    expect(tree.root.findAllByProps({ testID: 'desktop-new-room' })).toHaveLength(0);
    openMenu();
    expect(control('workspace-menu-settings')).toBeDefined();
  });

  it('keeps Bookmarks and profile settings from appearing selected together', async () => {
    route.pathname = '/beeline/bookmarks';
    await act(async () => {
      tree.update(<SidebarView key="bookmarks-route" />);
    });
    await settle();

    expect(control('desktop-bookmarks').props.accessibilityState).toEqual({ selected: true });
    expect(control('desktop-strip-account').props.accessibilityState).toEqual({
      selected: false,
    });
  });

  it('keeps Bookmarks unselected on the Members route', async () => {
    route.pathname = '/beeline/members';
    await act(async () => {
      tree.update(<SidebarView key="members-route" />);
    });
    await settle();
    expect(control('desktop-bookmarks').props.accessibilityState).toEqual({ selected: false });
  });

  it('exposes the active conversation to assistive technology', async () => {
    route.pathname = '/beeline/chat/room-a';
    await act(async () => {
      tree.update(<SidebarView key="active-room-route" />);
    });
    await settle();

    expect(control('desktop-room-room-a').props.accessibilityState).toEqual({ selected: true });
  });

  it('collapses and restores the active Room corner list with an accessible disclosure', async () => {
    route.pathname = '/beeline/chat/room-a';
    await act(async () => {
      tree.update(<SidebarView key="room-corners-toggle" />);
    });
    await settle();

    const toggle = control('desktop-room-corners-toggle-room-a');
    expect(toggle.props.accessibilityLabel).toBe('Hide 1 corner');
    expect(toggle.props.accessibilityState).toEqual({ expanded: true });
    expect(control('desktop-corner-corner-a')).toBeDefined();

    act(() => toggle.props.onPress());
    expect(tree.root.findAllByProps({ testID: 'desktop-corner-corner-a' })).toHaveLength(0);
    const restore = control('desktop-room-corners-toggle-room-a');
    expect(restore.props.accessibilityLabel).toBe('Show 1 corner');
    expect(restore.props.accessibilityState).toEqual({ expanded: false });
    expect(saveDesktopRoomCornersExpanded).toHaveBeenLastCalledWith('room-a', false);

    act(() => restore.props.onPress());
    expect(control('desktop-corner-corner-a')).toBeDefined();
    expect(saveDesktopRoomCornersExpanded).toHaveBeenLastCalledWith('room-a', true);
  });

  it('opens a Room before showing its corner from the empty deck', async () => {
    act(() => control('desktop-room-corners-toggle-room-a').props.onPress());
    await settle();
    act(() => control('desktop-corner-corner-a').props.onPress());

    expect(selectDesktopWorkCorner).toHaveBeenCalledWith({
      roomId: 'room-a',
      cornerId: 'corner-a',
    });
    expect(routerNavigate).toHaveBeenCalledWith(
      { pathname: '/beeline/chat/[channelId]', params: { channelId: 'room-a' } },
      { dangerouslySingular: true },
    );
  });

  it('restores a saved collapsed Room corner list', async () => {
    roomCornersExpanded.set('room-a', false);
    route.pathname = '/beeline/chat/room-a';
    await act(async () => {
      tree.update(<SidebarView key="room-corners-collapsed" />);
    });
    await settle();

    expect(control('desktop-room-corners-toggle-room-a').props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(tree.root.findAllByProps({ testID: 'desktop-corner-corner-a' })).toHaveLength(0);
  });

  it('closes without routing when the current Workspace is picked', () => {
    act(() => tree.root.findByType('CommunitySwitcherTrigger').props.onPress());
    act(() => tree.root.findByType('DesktopWorkspaceRail').props.onSelect('workspace-a'));

    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(false);
    expect(routerPush).not.toHaveBeenCalled();
    expect(saveActiveCommunityId).not.toHaveBeenCalled();
  });

  it('uses a deep-linked Workspace URL as the persistent desktop sidebar authority', async () => {
    route.communityId = 'workspace-empty';
    await act(async () => {
      tree.update(<SidebarView key="deep-linked-workspace" />);
    });
    await settle();

    expect(tree.root.findByType('CommunitySwitcherTrigger').props.community.name).toBe(
      'Empty Workspace',
    );
    expect(
      tree.root
        .findAllByType('Text')
        .some(
          (node: { props: { children?: unknown } }) =>
            node.props.children === 'No rooms or direct messages yet.',
        ),
    ).toBe(true);
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
  });
});

vi.mock('@/components/buzz/HullActionSheet', () => ({
  HullActionSheetModal: (props: any) =>
    props.visible ? React.createElement('Sheet', props, props.children) : null,
  HullActionSheetRow: (props: any) => React.createElement('SheetRow', props),
  HullActionSheetCancel: (props: any) => React.createElement('SheetCancel', props),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined },
}));
