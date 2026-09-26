// @vitest-environment jsdom
//
// The unit-level width-formula test in SidebarNavigator.test.tsx stubs
// PanResponder to a bare `{ panHandlers: config }` passthrough, which deletes
// the real gesture-accumulation layer entirely. That hid a second bug: on
// web, react-native-web's PanResponder is rebuilt whenever its useMemo
// dependencies change, and rebuilding it mid-drag makes react-native-web
// re-register the node's responder config, resetting the gesture's touch-move
// accounting so `dx` stops tracking the cursor. This file renders the real
// `react-native-web` PanResponder in jsdom and drives it with real
// mousedown/mousemove/mouseup events, so a dependency-list regression here
// fails the way a live drag would.
import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-dom/client has no declarations in this workspace.
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let windowWidth = 1280;

vi.mock('react-native', async () => {
  // @ts-expect-error react-native-web has no declarations in this workspace.
  const rnw = await import('react-native-web');
  return {
    useWindowDimensions: () => ({ width: windowWidth, height: 840 }),
    View: rnw.View,
    Pressable: rnw.Pressable,
    Platform: rnw.Platform,
    PanResponder: rnw.PanResponder,
  };
});

vi.mock('expo-router/drawer', () => ({ Drawer: () => null }));
vi.mock('expo-router', () => ({
  usePathname: () => '/beeline/chat/room-1',
  useRouter: () => ({ back: vi.fn() }),
}));
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
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
  useIsDesktop: () => true,
  useIsTablet: () => true,
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
vi.mock('./SidebarView', () => ({ SidebarView: () => null }));
vi.mock('./buzz/ForegroundNotificationBanner', () => ({
  ForegroundNotificationBanner: () => null,
}));

const loadDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => 280));
const saveDesktopPaneWidthMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/buzz/desktop-workbench-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/buzz/desktop-workbench-state')>()),
  loadDesktopPaneWidth: loadDesktopPaneWidthMock,
  saveDesktopPaneWidth: saveDesktopPaneWidthMock,
}));

import { SidebarNavigator } from './SidebarNavigator';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  windowWidth = 1280;
  loadDesktopPaneWidthMock.mockClear();
  saveDesktopPaneWidthMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderNavigator(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SidebarNavigator));
    // Let the loadDesktopPaneWidth() effect resolve before dragging.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function resizerNode(): HTMLElement {
  const node = container.querySelector('[data-testid="desktop-navigation-resizer"]');
  if (!node) throw new Error('resize handle not rendered');
  return node as HTMLElement;
}

function drawerLeft(): number {
  // The resizer sits at `left: drawerWidth - 3`, so its position is a direct,
  // observable proxy for the pane width the user actually sees move.
  return parseFloat(resizerNode().style.left);
}

// jsdom stamps events off the wall clock, so two events dispatched in the
// same synchronous act() call can land in the same millisecond.
// PanResponder's touch history drops a move whose timestamp doesn't advance,
// silently losing that frame's delta — so each event gets its own
// strictly-increasing timeStamp instead of relying on the real clock.
let nextTimeStamp = 0;

function fireMouse(type: string, clientX: number, target: EventTarget) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 0 });
  Object.defineProperty(event, 'pageX', { value: clientX });
  Object.defineProperty(event, 'pageY', { value: 0 });
  Object.defineProperty(event, 'timeStamp', { value: (nextTimeStamp += 10) });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Drags the handle from `startX` to `startX + totalDx` in 10px steps. */
function drag(startX: number, totalDx: number): number[] {
  const positions: number[] = [];
  fireMouse('mousedown', startX, resizerNode());
  const step = totalDx > 0 ? 10 : -10;
  for (let dx = step; Math.abs(dx) < Math.abs(totalDx); dx += step) {
    fireMouse('mousemove', startX + dx, document);
    positions.push(drawerLeft() + 3);
  }
  fireMouse('mousemove', startX + totalDx, document);
  positions.push(drawerLeft() + 3);
  fireMouse('mouseup', startX + totalDx, document);
  return positions;
}

describe('SidebarNavigator resize handle (real gesture layer)', () => {
  it('tracks the cursor smoothly for the whole drag, not just the first frame', async () => {
    await renderNavigator();
    const before = drawerLeft() + 3;
    expect(before).toBe(280);

    // Stays within [240, 360] throughout so clamping never masks the assertion.
    const positions = drag(100, 50);

    // Every recorded frame must be monotonically non-decreasing: a widening
    // drag should never make the pane narrower than a prior frame. Rebuilding
    // the PanResponder mid-gesture broke exactly this, snapping the tracked
    // width back down partway through the drag instead of continuing to grow.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
    }
    expect(positions.at(-1)).toBe(before + 50);
  });

  it('persists the width the user actually dragged to, not the pre-drag width', async () => {
    await renderNavigator();
    drag(100, 50);

    expect(saveDesktopPaneWidthMock).toHaveBeenCalledWith('navigation', 330);
  });
});
