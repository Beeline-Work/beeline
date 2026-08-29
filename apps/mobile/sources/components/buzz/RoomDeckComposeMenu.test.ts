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
    KeyboardAvoidingView: host('KeyboardAvoidingView'),
    Modal: host('Modal'),
    Platform: {
      OS: 'ios',
      select: (choices: Record<string, unknown>) => choices.ios ?? choices.default,
    },
    Pressable: host('Pressable'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('react-native-keyboard-controller', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { KeyboardAvoidingView: host('KeyboardAvoidingView') };
});

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('./MonoHull', async () => {
  const ReactModule = await import('react');
  return {
    HullSurface: (props: any) => ReactModule.createElement('HullSurface', props, props.children),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    default: host('Svg'),
    Circle: host('Circle'),
    Path: host('Path'),
    Polygon: host('Polygon'),
    Rect: host('Rect'),
  };
});

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
const roomGlyphSource = readFileSync(new URL('./RoomGlyph.tsx', import.meta.url), 'utf8');
const actionSheetSource = readFileSync(new URL('./HullActionSheet.tsx', import.meta.url), 'utf8');
const dialogSource = readFileSync(new URL('./HullDialog.tsx', import.meta.url), 'utf8');

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
  it('morphs the FAB and opens one continuous list with five accessible rows in order', () => {
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
      renderer.root
        .findAllByProps({ testID: `room-deck-compose-${action}` })
        .find((node) => node.type === 'Pressable')!,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.props.accessibilityRole)).toEqual(Array(5).fill('button'));
    expect(rows.map((row) => row.props.accessibilityLabel.split('.')[0])).toEqual(labels);
    expect(rows.map((row) => row.findAllByType('Text' as any)[0].props.children)).toEqual(labels);
    expect(renderer.root.findByProps({ testID: 'room-deck-compose-options' })).toBeDefined();
    expect(source).not.toContain("label: 'START'");
    expect(source).not.toContain("label: 'WORKSPACE'");
    expect(source).not.toContain('groupLabel');
  });

  it('draws a distinct thin-stroke inline SVG for every action', () => {
    const renderer = renderMenu();
    open(renderer);

    const glyphs = actions.map((action) =>
      renderer.root.findByProps({ testID: `room-deck-compose-glyph-${action}` }),
    );
    expect(glyphs).toHaveLength(5);
    expect(glyphs.map((glyph) => glyph.props.width ?? glyph.props.size)).toEqual(Array(5).fill(24));
    expect(source).toContain('GLYPH_STROKE_WIDTH = 1.25');
    expect(source).toContain('<Rect {...common} x="3.5" y="5.5" width="17" height="13"');
    expect(source).toContain('<RoomGlyph');
    expect(source).toContain('testID="room-deck-compose-glyph-room"');
    expect(roomGlyphSource).toContain('ROOM_GLYPH_STROKE_WIDTH = 1.25');
    expect(roomGlyphSource).toContain('<Rect');
    expect(roomGlyphSource).toContain('x="4.5"');
    expect(roomGlyphSource).toContain('y="4.5"');
    expect(source).toContain('<Polygon {...common} points="12 4.5 20 19.5 4 19.5" />');
    expect(source).toContain('<Path {...common} d="M5 20V4h13v16" />');
    expect(source).not.toContain('ACTION_GLYPHS');
  });

  it('uses one opaque tokenized hull surface with no BlurView or local radius', () => {
    expect(source).toContain('<HullActionSheet');
    expect(source).not.toContain('BlurView');
    expect(source).not.toContain('expo-blur');
    expect(source).not.toMatch(/borderRadius:\s*\d/);
    expect(source).toContain('borderRadius: groknight.radius');

    expect(actionSheetSource).toContain('<HullFloatingSurface');
    expect(dialogSource).toContain('backgroundColor: hull.bgRaised');
    expect(dialogSource).toContain('borderRadius: hull.radius');
    expect(dialogSource).toContain('borderWidth: StyleSheet.hairlineWidth');
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

  it('never truncates a row description with a mystery ellipsis (screenshot 1cfe27eb)', () => {
    // The shared sheet row's default layout squeezes `metadata` onto one line
    // beside the label — fine for a short chip, but every description here is
    // a full sentence. `metadataWrap` lets it wrap instead of ellipsizing.
    const renderer = renderMenu();
    open(renderer);

    const descriptions = [
      'Direct message a person',
      'New room in this workspace',
      'Bring a person into the workspace',
      'Seat an agent here',
      'Paste a Workspace invite',
    ];
    actions.forEach((action, index) => {
      const row = renderer.root
        .findAllByProps({ testID: `room-deck-compose-${action}` })
        .find((node) => node.type === 'Pressable')!;
      const descriptionText = row
        .findAllByType('Text' as any)
        .find((node) => node.props.children === descriptions[index])!;
      expect(descriptionText).toBeDefined();
      // No line cap: a wrapped description is never truncated regardless of
      // device width.
      expect(descriptionText.props.numberOfLines).toBeUndefined();
    });
    expect(source).toContain('metadataWrap');
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
