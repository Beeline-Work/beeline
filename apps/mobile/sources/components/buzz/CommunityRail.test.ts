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

vi.mock('./PersonAvatar', async () => {
  const ReactModule = await import('react');
  return {
    PersonAvatar: (props: any) => ReactModule.createElement('PersonAvatar', props),
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

function renderShell(
  onSelect = vi.fn(),
  onAdd = vi.fn(),
  onSettings = vi.fn(),
  viewer?: { pubkey: string; avatarUrl?: string },
  workspaceSettings?: { canManage: boolean; onOpen: (communityId: string) => void },
): ReactTestRenderer {
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
          onSettings,
          canManageActiveCommunity: workspaceSettings?.canManage,
          onWorkspaceSettings: workspaceSettings?.onOpen,
          viewerPubkey: viewer?.pubkey,
          viewerAvatarUrl: viewer?.avatarUrl,
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
    expect(renderer.root.findAllByProps({ testID: 'workspace-avatar-edit' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'workspace-avatar-header' }).props.community,
    ).toMatchObject({ communityId: 'community-1', avatar: 'https://example.test/night-shift.png' });

    const trigger = renderer.root.findByProps({ testID: 'workspace-avatar-trigger' });
    expect(trigger.props.accessibilityState).toEqual({ expanded: false });
    act(() => trigger.props.onPress());

    expect(renderer.root.findByProps({ testID: 'community-drawer-overlay' })).toBeDefined();
    expect(
      renderer.root.findByProps({ testID: 'workspace-avatar-community-1' }).props.community,
    ).toMatchObject({ communityId: 'community-1', avatar: 'https://example.test/night-shift.png' });
    expect(
      renderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.accessibilityState,
    ).toEqual({ expanded: true });

    act(() => renderer.root.findByProps({ testID: 'community-drawer-scrim' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
  });

  it('shows a scoped settings gear only to Workspace admins', () => {
    const onOpen = vi.fn();
    const renderer = renderShell(vi.fn(), vi.fn(), vi.fn(), undefined, {
      canManage: true,
      onOpen,
    });

    act(() => renderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.onPress());
    expect(renderer.root.findByProps({ testID: 'community-drawer-overlay' })).toBeDefined();
    const gear = renderer.root.findByProps({ testID: 'workspace-settings-community-1' });
    expect(gear.props.accessibilityLabel).toBe('Night Shift Workspace settings');
    act(() => gear.props.onPress());
    expect(onOpen).toHaveBeenCalledWith('community-1');
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);

    const memberRenderer = renderShell(vi.fn(), vi.fn(), vi.fn(), undefined, {
      canManage: false,
      onOpen,
    });
    act(() =>
      memberRenderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.onPress(),
    );
    expect(
      memberRenderer.root.findAllByProps({ testID: 'workspace-settings-community-1' }),
    ).toHaveLength(0);
  });

  it('closes after selecting or adding a Workspace', () => {
    const onSelect = vi.fn();
    const onAdd = vi.fn();
    const renderer = renderShell(onSelect, onAdd);
    const open = () =>
      act(() => renderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.onPress());

    open();
    act(() => renderer.root.findByProps({ testID: 'community-rail-community-1' }).props.onPress());
    expect(onSelect).toHaveBeenCalledWith('community-1');
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);

    open();
    act(() => renderer.root.findByProps({ testID: 'community-rail-add' }).props.onPress());
    expect(onAdd).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
  });

  it('keeps global Settings at the bottom of the switcher and closes before opening it', () => {
    const onSettings = vi.fn();
    const renderer = renderShell(vi.fn(), vi.fn(), onSettings);

    act(() => renderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.onPress());
    const mySettings = renderer.root
      .findAllByType('TouchableOpacity' as any)
      .find((node) => node.props.testID === 'community-rail-settings');
    expect(mySettings?.props.accessibilityLabel).toBe('Your settings');
    act(() => renderer.root.findByProps({ testID: 'community-rail-settings' }).props.onPress());

    expect(onSettings).toHaveBeenCalledOnce();
    expect(renderer.root.findAllByProps({ testID: 'community-drawer-overlay' })).toHaveLength(0);
  });

  it('uses the person avatar as the global Settings identity affordance', () => {
    const renderer = renderShell(vi.fn(), vi.fn(), vi.fn(), {
      pubkey: 'person-pubkey',
      avatarUrl: 'https://example.test/person.png',
    });

    act(() => renderer.root.findByProps({ testID: 'workspace-avatar-trigger' }).props.onPress());
    expect(renderer.root.findByType('PersonAvatar').props).toMatchObject({
      pubkey: 'person-pubkey',
      avatarUrl: 'https://example.test/person.png',
      name: 'You',
    });
  });
});
