import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Modal: host('Modal'),
    Platform: { OS: 'ios', select: (choices: Record<string, unknown>) => choices.ios ?? choices.default },
    Pressable: host('Pressable'),
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('react-native-reanimated', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: { View: host('AnimatedView') },
    Easing: { cubic: 'cubic', out: (value: unknown) => value },
    ReduceMotion: { System: 'system' },
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withTiming: (value: unknown) => value,
  };
});

import { RoomDeckComposeMenu } from './RoomDeckComposeMenu';

const source = readFileSync(new URL('./RoomDeckComposeMenu.tsx', import.meta.url), 'utf8');
const actionSheetSource = readFileSync(new URL('./HullActionSheet.tsx', import.meta.url), 'utf8');

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

function renderMenu(onSelect = vi.fn()): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(RoomDeckComposeMenu, { onSelect }));
  });
  return renderer;
}

const actions = ['message', 'room', 'invite', 'agent', 'join'] as const;
const labels = ['Message', 'Room', 'Invite', 'Agent', 'Join'] as const;

function open(renderer: ReactTestRenderer) {
  act(() => renderer.root.findByProps({ testID: 'room-deck-compose-fab' }).props.onPress());
}

describe('Room deck compose menu', () => {
  it('morphs the FAB and opens two named groups with five accessible rows in order', () => {
    const renderer = renderMenu();
    const fab = renderer.root.findByProps({ testID: 'room-deck-compose-fab' });
    expect(fab.props.accessibilityState).toEqual({ expanded: false });
    expect(fab.props.accessibilityValue).toEqual({ text: '+' });

    open(renderer);

    expect(renderer.root.findByProps({ testID: 'room-deck-compose-fab' }).props).toMatchObject({
      accessibilityLabel: 'Close compose menu',
      accessibilityState: { expanded: true },
      accessibilityValue: { text: '×' },
    });
    const rows = actions.map((action) =>
      renderer.root.findByProps({ testID: `room-deck-compose-${action}` }),
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.props.accessibilityRole)).toEqual(Array(5).fill('button'));
    expect(rows.map((row) => row.props.accessibilityLabel.split('.')[0])).toEqual(labels);
    expect(rows.map((row) => row.findAllByType('Text' as any)[1].props.children)).toEqual(labels);
    expect(renderer.root.findByProps({ testID: 'room-deck-compose-group-start' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'room-deck-compose-group-workspace' })).toBeDefined();
  });

  it('uses one opaque tokenized hull surface with no BlurView or local radius', () => {
    expect(source).toContain('<HullActionSheet');
    expect(source).not.toContain('BlurView');
    expect(source).not.toContain('expo-blur');
    expect(source).not.toMatch(/borderRadius:\s*\d/);
    expect(source).toContain('borderRadius: groknight.radius');

    expect(actionSheetSource).toContain('backgroundColor: theme.buzz.bgRaised');
    expect(actionSheetSource).toContain('borderRadius: theme.buzz.radius');
    expect(actionSheetSource).toContain('borderWidth: StyleSheet.hairlineWidth');
    expect(actionSheetSource).not.toMatch(/rgba?\(/);
  });

  it('dismisses from the scrim and the × FAB', () => {
    const renderer = renderMenu();

    open(renderer);
    act(() => renderer.root.findByProps({ testID: 'room-deck-compose-scrim' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'room-deck-compose-menu' })).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'room-deck-compose-fab' }).props.accessibilityValue,
    ).toEqual({ text: '+' });

    open(renderer);
    act(() => renderer.root.findByProps({ testID: 'room-deck-compose-close' }).props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'room-deck-compose-menu' })).toHaveLength(0);
  });

  it('dismisses every row before dispatching its real-flow action', () => {
    const onSelect = vi.fn();
    const renderer = renderMenu(onSelect);

    actions.forEach((action, index) => {
      open(renderer);
      act(() =>
        renderer.root.findByProps({ testID: `room-deck-compose-${action}` }).props.onPress(),
      );
      expect(onSelect).toHaveBeenNthCalledWith(index + 1, action);
      expect(renderer.root.findAllByProps({ testID: 'room-deck-compose-menu' })).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'room-deck-compose-fab' }).props.accessibilityState,
      ).toEqual({ expanded: false });
    });
  });
});
