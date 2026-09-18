import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Platform: { OS: 'web' },
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
  };
});

const theme = vi.hoisted(() => ({
  buzz: {
    accent: '#b08a4a',
    bgHighlight: '#1e1326',
    bgRaised: '#190e21',
    borderStrong: '#3b3048',
    textMuted: '#83838d',
    textPrimary: '#f0f0f3',
    // The rail reads its descriptor offset from the one spacing scale
    // (`buzz/groknight.ts`'s `space`); mirror the real steps here so a
    // regression test can name the gap instead of a magic number.
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    type: { hero: {}, meta: {} },
  },
}));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', inset: 0 },
    hairlineWidth: 1,
    create: (factory: any) => factory(theme),
  },
}));
vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: { View: host('AnimatedView') },
    Easing: { bezier: vi.fn() },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
  };
});
vi.mock('./IdentityMark', async () => {
  const ReactModule = await import('react');
  return { IdentityMark: (props: any) => ReactModule.createElement('IdentityMark', props) };
});
vi.mock('./DesktopWorkspacePortal', async () => {
  const ReactModule = await import('react');
  return {
    DesktopWorkspacePortal: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import { DesktopWorkspaceRail } from './DesktopWorkspaceRail';

const listeners = new Map<string, (event: any) => void>();
const originalConsoleError = console.error;

beforeAll(() => {
  (globalThis as any).window = {
    addEventListener: (name: string, listener: (event: any) => void) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  (globalThis as any).requestAnimationFrame = (callback: () => void) => {
    callback();
    return 1;
  };
  (globalThis as any).cancelAnimationFrame = vi.fn();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
  delete (globalThis as any).requestAnimationFrame;
  delete (globalThis as any).cancelAnimationFrame;
});

const workspaces = [
  { id: 'alpha', name: 'Alpha', roomCount: 4, needsAttention: false },
  { id: 'bravo', name: 'Bravo', roomCount: 1, needsAttention: true },
  { id: 'charlie', name: 'Charlie', roomCount: 0, needsAttention: false },
];

function renderRail(onSelect = vi.fn(), onClose = vi.fn(), onAdd = vi.fn()) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <DesktopWorkspaceRail
        activeWorkspaceId="alpha"
        onAdd={onAdd}
        onClose={onClose}
        onSelect={onSelect}
        open
        workspaces={workspaces}
      />,
    );
  });
  return tree;
}

beforeEach(() => listeners.clear());

describe('desktop Workspace rail', () => {
  it('shows the current and needs-you pills with accessible Workspace tiles', () => {
    const tree = renderRail();

    expect(tree.root.findByProps({ testID: 'desktop-workspace-current-alpha' })).toBeDefined();
    expect(tree.root.findByProps({ testID: 'desktop-workspace-needs-you-bravo' })).toBeDefined();
    expect(tree.root.findByProps({ testID: 'desktop-workspace-tile-alpha' }).props).toMatchObject({
      accessibilityLabel: 'Alpha, 4 Rooms, you are here',
      accessibilityRole: 'menuitem',
      accessibilityState: { selected: true },
    });
    expect(
      tree.root.findByProps({ testID: 'desktop-workspace-tile-bravo' }).props.accessibilityLabel,
    ).toBe('Bravo, 1 Rooms, needs you');
  });

  it('reveals the name and Room count on hover or focus', () => {
    const tree = renderRail();
    act(() => tree.root.findByProps({ testID: 'desktop-workspace-tile-bravo' }).props.onHoverIn());

    const label = tree.root.findByProps({ testID: 'desktop-workspace-label' });
    expect(label.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      'Bravo',
      ['1 Rooms', ''],
    ]);
  });

  it('steps the descriptor card off the rail edge instead of gluing it', () => {
    const tree = renderRail();
    act(() => tree.root.findByProps({ testID: 'desktop-workspace-tile-bravo' }).props.onHoverIn());

    // The rail centres a TILE_SIZE tile in RAIL_WIDTH, so the label's slot
    // origin is that much in from the rail's left edge. A label whose `left`
    // reaches the rail edge exactly (the old `left: 62`) leaves a zero gap.
    const railWidth = 76;
    const tileSize = 48;
    const slotLeft = (railWidth - tileSize) / 2;
    const label = tree.root.findByProps({ testID: 'desktop-workspace-label' });
    const gap = slotLeft + (label.props.style as { left: number }).left - railWidth;

    expect(gap).toBe(theme.buzz.space.sm);
    expect(gap).toBeGreaterThan(0);
  });

  it('closes from the scrim or current tile and picks another Workspace', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const tree = renderRail(onSelect, onClose);

    act(() => tree.root.findByProps({ testID: 'desktop-workspace-rail-scrim' }).props.onPress());
    act(() => tree.root.findByProps({ testID: 'desktop-workspace-tile-alpha' }).props.onPress());
    act(() => tree.root.findByProps({ testID: 'desktop-workspace-tile-bravo' }).props.onPress());

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('bravo');
  });

  it('moves with arrows, picks with Enter, and closes with Escape', () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderRail(onSelect, onClose);
    const preventDefault = vi.fn();

    act(() => listeners.get('keydown')?.({ key: 'ArrowDown', preventDefault }));
    act(() => listeners.get('keydown')?.({ key: 'Enter', preventDefault }));
    act(() => listeners.get('keydown')?.({ key: 'Escape', preventDefault }));

    expect(onSelect).toHaveBeenCalledWith('bravo');
    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('opens the existing create or join flow without an old caption', () => {
    const onAdd = vi.fn();
    const tree = renderRail(vi.fn(), vi.fn(), onAdd);
    act(() => tree.root.findByProps({ testID: 'desktop-workspace-add' }).props.onPress());

    expect(onAdd).toHaveBeenCalledOnce();
    expect(
      tree.root
        .findAllByType('Text' as any)
        .some((node: any) => node.props.children === 'ADD WORKSPACE'),
    ).toBe(false);
  });

  it('includes the add tile in arrow-key focus order', () => {
    const onAdd = vi.fn();
    renderRail(vi.fn(), vi.fn(), onAdd);
    const preventDefault = vi.fn();

    act(() => listeners.get('keydown')?.({ key: 'ArrowUp', preventDefault }));
    act(() => listeners.get('keydown')?.({ key: 'Enter', preventDefault }));

    expect(onAdd).toHaveBeenCalledOnce();
  });
});
