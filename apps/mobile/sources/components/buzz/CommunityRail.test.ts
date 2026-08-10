import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  class AnimatedValue {
    value: number;

    constructor(value: number) {
      this.value = value;
    }

    setValue(value: number) {
      this.value = value;
    }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: host('AnimatedView'),
      timing: (value: AnimatedValue, config: { toValue: number }) => ({
        start: (callback?: (result: { finished: boolean }) => void) => {
          value.setValue(config.toValue);
          callback?.({ finished: true });
        },
      }),
    },
    Platform: { select: (choices: Record<string, unknown>) => choices.default },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles },
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: { View: host('AnimatedView') },
    Easing: { bezier: vi.fn(), out: (value: unknown) => value, poly: vi.fn() },
    ReduceMotion: { System: 'system' },
    runOnJS: (fn: (...args: any[]) => unknown) => fn,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useReducedMotion: () => false,
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(true);
      return value;
    },
  };
});

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
  };
});

vi.mock('./WorkspaceAvatar', async () => {
  const ReactModule = await import('react');
  return {
    WorkspaceAvatar: (props: any) => ReactModule.createElement('WorkspaceAvatar', props),
  };
});

import { BuzzCommunityShell, CommunityDrawerTrigger } from './CommunityRail';

const originalConsoleError = console.error;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated'))
      return;
    originalConsoleError(message, ...args);
  });
});

afterAll(() => vi.restoreAllMocks());

function renderShell(onSelect = vi.fn(), onAdd = vi.fn()): ReactTestRenderer {
  const community = {
    communityId: 'community-1',
    name: 'Night Shift',
    avatar: 'https://example.test/night-shift.png',
  } as any;
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        BuzzCommunityShell,
        {
          communities: [community],
          activeCommunityId: 'community-1',
          onSelect,
          onAdd,
        },
        React.createElement(CommunityDrawerTrigger, { community }),
      ),
    );
  });
  return renderer;
}

describe('Workspace drawer', () => {
  it('is hidden by default and toggles from the active Workspace avatar', () => {
    const renderer = renderShell();
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'workspace-avatar-header' }).props.community,
    ).toMatchObject({ communityId: 'community-1', avatar: 'https://example.test/night-shift.png' });

    const trigger = renderer.root.findByProps({ testID: 'community-drawer-trigger' });
    expect(trigger.props.accessibilityState).toEqual({ expanded: false });
    act(() => trigger.props.onPress());

    expect(renderer.root.findByProps({ testID: 'community-drawer-overlay' })).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'workspace-avatar-community-1' }).props.community,
    ).toMatchObject({ communityId: 'community-1', avatar: 'https://example.test/night-shift.png' });
    expect(
      renderer.root.findByProps({ testID: 'community-drawer-trigger' }).props.accessibilityState,
    ).toEqual({ expanded: true });

    act(() => renderer.root.findByProps({ testID: 'community-drawer-scrim' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
  });

  it('closes after selecting or adding a Workspace', () => {
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    const renderer = renderShell(onSelect, onAdd);
    const open = () =>
      act(() => renderer.root.findByProps({ testID: 'community-drawer-trigger' }).props.onPress());

    open();
    act(() => renderer.root.findByProps({ testID: 'community-rail-community-1' }).props.onPress());
    expect(onSelect).toHaveBeenCalledWith('community-1');
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);

    open();
    act(() => renderer.root.findByProps({ testID: 'community-rail-add' }).props.onPress());
    expect(onAdd).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
  });
});
