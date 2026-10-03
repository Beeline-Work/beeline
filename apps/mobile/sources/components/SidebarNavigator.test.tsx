import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let windowWidth = 1280;
const layout = vi.hoisted(() => ({ tablet: true, desktop: true }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    useWindowDimensions: () => ({ width: windowWidth, height: 840 }),
    View: host('View'),
    Pressable: host('Pressable'),
    Platform: { OS: 'web' },
    // The real PanResponder wires these callbacks into native gesture
    // recognition. Exposing the config object directly as panHandlers lets
    // the test drive the exact same grant/move/release logic a live mouse
    // drag would invoke, without needing a native gesture responder system.
    PanResponder: { create: (config: any) => ({ panHandlers: config }) },
  };
});

vi.mock('expo-router/drawer', async () => {
  const ReactModule = await import('react');
  return { Drawer: (props: any) => ReactModule.createElement('Drawer', props) };
});
vi.mock('expo-router', () => ({
  usePathname: () => '/beeline/chat/room-1',
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('expo-image', async () => {
  const ReactModule = await import('react');
  return { Image: (props: any) => ReactModule.createElement('Image', props) };
});
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: { colors: { header: { tint: '#fff' }, textLink: '#b08a4a' } } }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/isTauri', () => ({ isTauri: () => false }));
vi.mock('@/utils/platform', () => ({ isDesktopPlatform: () => true }));
vi.mock('@/utils/responsive', () => ({
  useIsDesktop: () => layout.desktop,
  useIsTablet: () => layout.tablet,
  useHeaderHeight: () => 0,
}));
vi.mock('@/navigation/browserNavigation', () => ({
  canRouteForward: () => false,
  canUseRouteBack: () => false,
  getNavigatorCanGoBack: () => false,
}));
vi.mock('@/navigation/browserNavigationStore', () => {
  const state = { routeHistory: null };
  const useBrowserNavigationStore = (selector: (s: typeof state) => unknown) => selector(state);
  (useBrowserNavigationStore as any).getState = () => state;
  return { useBrowserNavigationStore };
});
vi.mock('@/auth/buzz-identity-storage', () => ({ loadBuzzIdentity: vi.fn(async () => null) }));
vi.mock('@/auth/monolith-session', () => ({
  monolithSession: {
    identityId: vi.fn(async () => null),
    subscribeIdentityChange: vi.fn(() => () => {}),
  },
}));
vi.mock('@/sync/storage', () => ({
  useLocalSetting: () => false,
  useLocalSettingMutable: () => [false, vi.fn()],
}));
vi.mock('./SidebarView', async () => {
  const ReactModule = await import('react');
  return { SidebarView: () => ReactModule.createElement('SidebarView') };
});

const loadDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => 280));
const saveDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/buzz/desktop-workbench-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/desktop-workbench-state')>()),
  loadDesktopPaneWidth: loadDesktopPaneWidthMock,
  saveDesktopPaneWidth: saveDesktopPaneWidthMock,
}));

import { SidebarNavigator } from './SidebarNavigator';

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
  windowWidth = 1280;
  layout.tablet = true;
  layout.desktop = true;
  loadDesktopPaneWidthMock.mockClear();
  saveDesktopPaneWidthMock.mockClear();
});

function drawerWidth(tree: ReactTestRenderer): number {
  return tree.root.findByType('Drawer' as any).props.screenOptions.drawerStyle.width;
}

function resizer(tree: ReactTestRenderer) {
  return tree.root.findByProps({ testID: 'desktop-navigation-resizer' });
}

async function renderNavigator(width: number): Promise<ReactTestRenderer> {
  windowWidth = width;
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<SidebarNavigator />);
  });
  return tree;
}

describe('SidebarNavigator web width class', () => {
  it('hides the permanent drawer on compact web so the Room deck owns the viewport', async () => {
    layout.tablet = false;
    layout.desktop = false;
    const tree = await renderNavigator(390);
    const options = tree.root.findByType('Drawer' as any).props.screenOptions;
    expect(options.drawerType).toBe('front');
    expect(options.drawerStyle.width).toBe(0);
    expect(options.drawerStyle.display).toBe('none');
    expect(tree.root.findAllByProps({ testID: 'desktop-navigation-resizer' })).toHaveLength(0);
  });

  it('keeps the permanent two-pane frame once the window is regular', async () => {
    const tree = await renderNavigator(1440);
    const options = tree.root.findByType('Drawer' as any).props.screenOptions;
    expect(options.drawerType).toBe('permanent');
    expect(options.drawerStyle.width).toBe(356);
    expect(resizer(tree).props.testID).toBe('desktop-navigation-resizer');
  });
});

describe('SidebarNavigator resize handle', () => {
  it('drags the nav pane wider on an ordinary desktop window', async () => {
    const tree = await renderNavigator(1280);
    const before = drawerWidth(tree);
    expect(before).toBe(280);

    const handlers = resizer(tree).props;
    act(() => {
      handlers.onPanResponderGrant();
      handlers.onPanResponderMove(null, { dx: 50 });
    });

    expect(drawerWidth(tree)).toBe(before + 50);
  });

  it('still resizes the nav pane when the window is narrower than the content reservation', async () => {
    // Below 680px, `windowWidth - 440` (the content-pane reservation) drops
    // below the nav pane's own 240px minimum. Before the fix this silently
    // pinned the rendered width to 240 on every render, so the handle moved
    // the stored value internally but the visible pane never budged.
    const tree = await renderNavigator(600);
    const before = drawerWidth(tree);
    expect(before).toBe(280); // not stuck at the 240px floor

    const handlers = resizer(tree).props;
    act(() => {
      handlers.onPanResponderGrant();
      handlers.onPanResponderMove(null, { dx: 50 });
    });

    // The handle actually moves the pane instead of staying frozen.
    expect(drawerWidth(tree)).toBe(before + 50);
  });

  it('still reserves content space once the window is wide enough for both panes', async () => {
    // At 700px, reserving 440px for content leaves only 260px for the nav
    // pane, so the rendered width is still capped, not unclamped. The
    // persisted preference (420, the pane's own max) is unaffected by this
    // transient window-width cap, same as before the fix.
    const tree = await renderNavigator(700);
    const handlers = resizer(tree).props;
    await act(async () => {
      handlers.onPanResponderGrant();
      handlers.onPanResponderMove(null, { dx: 200 });
      handlers.onPanResponderRelease(null, { dx: 200 });
    });

    expect(drawerWidth(tree)).toBe(260);
    expect(saveDesktopPaneWidthMock).toHaveBeenCalledWith('navigation', 420);
  });

  it('persists the released width and clamps to the pane maximum', async () => {
    const tree = await renderNavigator(1280);
    const handlers = resizer(tree).props;
    await act(async () => {
      handlers.onPanResponderGrant();
      handlers.onPanResponderMove(null, { dx: 1000 });
      handlers.onPanResponderRelease(null, { dx: 1000 });
    });

    expect(drawerWidth(tree)).toBe(420);
    expect(saveDesktopPaneWidthMock).toHaveBeenCalledWith('navigation', 420);
  });
});
