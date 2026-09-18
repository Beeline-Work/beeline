import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPush = vi.hoisted(() => vi.fn());
const saveActiveCommunityId = vi.hoisted(() => vi.fn(async () => undefined));
const loadLastViewedChannel = vi.hoisted(() => vi.fn(async () => null));
const route = vi.hoisted(() => ({
  communityId: undefined as string | undefined,
  parent: undefined as string | undefined,
}));
const chats = vi.hoisted(() =>
  vi.fn(async (workspaceId: string) => ({
    workspace: { id: workspaceId, name: workspaceId, role: 'owner' },
    chats:
      workspaceId === 'workspace-a' ? [{ room: { id: 'room-a', workspaceId, name: 'Alpha' } }] : [],
  })),
);
const windowListeners = new Map<string, (event: any) => void>();

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'web' },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
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
    type: { bodyStrong: {}, machine: {}, meta: {}, sectionHead: {} },
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
  usePathname: () => '/beeline/channels',
  useRouter: () => ({ push: routerPush }),
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
    }));
    chats = chats;
    corners = vi.fn(async () => ({ corners: [] }));
  },
}));
vi.mock('@/buzz/room-list-row', () => ({
  displayGroupedCornerTitle: vi.fn(() => ''),
  NO_ACTIVITY_PREVIEW: 'No activity',
  roomListSections: vi.fn((items) => (items.length ? [{ kind: 'rooms', data: items }] : [])),
  roomRowName: vi.fn((item) => ({ name: item.room.name, sigil: '#' })),
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
    RoomListSectionHeader: (props: any) =>
      ReactModule.createElement('RoomListSectionHeader', props),
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

import { SidebarView } from './SidebarView';

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
  let tree: ReactTestRenderer;

  beforeEach(async () => {
    vi.clearAllMocks();
    windowListeners.clear();
    route.communityId = undefined;
    route.parent = undefined;
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
        .some((node: { props: { children?: unknown } }) => node.props.children === 'No rooms yet.'),
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
    expect(tree.root.findByProps({ testID: 'desktop-room-search' })).toBeDefined();

    act(() => tree.root.findByType('CommunitySwitcherTrigger').props.onPress());
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(true);
    expect(tree.root.findByProps({ testID: 'desktop-room-search' })).toBeDefined();

    act(() => tree.root.findByType('DesktopWorkspaceRail').props.onClose());
    expect(tree.root.findByType('DesktopWorkspaceRail').props.open).toBe(false);
  });

  it('keeps profile settings reachable from the persistent desktop navigation', () => {
    const profileSettings = tree.root.findByProps({ testID: 'profile-settings-navigation' });

    expect(profileSettings.props.accessibilityLabel).toBe('Open profile settings');
    expect(
      profileSettings
        .findAllByType('Text')
        .some(
          (node: { props: { children?: unknown } }) => node.props.children === 'PROFILE & SETTINGS',
        ),
    ).toBe(true);

    act(() => profileSettings.props.onPress());

    expect(routerPush).toHaveBeenCalledWith('/beeline/settings');
  });

  it('routes the persistent New Room, Workbench, and Bookmarks actions', () => {
    act(() => tree.root.findByProps({ testID: 'desktop-new-room' }).props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/channels',
      params: { communityId: 'workspace-a', newRoom: expect.any(String) },
    });

    act(() => tree.root.findByProps({ testID: 'desktop-workbench' }).props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/settings/workbench',
      params: { workspaceId: 'workspace-a', viewerId: 'viewer' },
    });

    act(() => tree.root.findByProps({ testID: 'desktop-bookmarks' }).props.onPress());
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/beeline/bookmarks',
      params: { communityId: 'workspace-a' },
    });
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
        .some((node: { props: { children?: unknown } }) => node.props.children === 'No rooms yet.'),
    ).toBe(true);
    expect(saveActiveCommunityId).toHaveBeenCalledWith('viewer', 'workspace-empty');
  });
});
