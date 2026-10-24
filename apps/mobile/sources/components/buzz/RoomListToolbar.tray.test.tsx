vi.mock('expo-haptics', () => ({ ImpactFeedbackStyle: { Light: 'Light' }, impactAsync: async () => undefined }));
vi.mock('react-native-keyboard-controller', async () => { const R = await import('react'); return { KeyboardAvoidingView: (props: any) => R.createElement('View', props, props.children) }; });
import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default }, StyleSheet: { flatten: (style: any): any => Array.isArray(style) ? Object.assign({}, ...style.map((part: any) => Array.isArray(part) ? Object.assign({}, ...part) : part)) : style },
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});
// Styles resolve against whichever real theme is current, so one render per theme.
const activeTheme = vi.hoisted(() => ({ buzz: {} as any }));
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      new Proxy({}, { get: (_target, key) => factory(activeTheme)[key] }),
  },
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('react-native-svg', async () => { const R = await import('react'); const h = (p: any) => R.createElement('Svg', p, p.children); return { default: h, Path: h, Circle: h, Defs: h, Mask: h, Rect: h }; });
vi.mock('./Button', async () => { const R = await import('react'); return { Button: (p: any) => R.createElement('Button', p, p.icon) }; });
vi.mock('./IndexRow', async () => { const R = await import('react'); return { InlineRow: (p: any) => R.createElement('View', p, p.children) }; });
vi.mock('@/components/buzz/HullDialog', async () => { const R = await import('react'); return { HullDialogInput: (p: any) => R.createElement('TextInput', p) }; });
import { beelineThemes } from '@/buzz/groknight';
import { RoomListToolbar } from './RoomListToolbar';
import { TrayGlyph } from './TrayGlyph';
import { MembersAgentsGlyph } from './MembersAgentsGlyph';
import { RoomListSectionHeader } from './RoomListSectionHeader';

activeTheme.buzz = beelineThemes.obsidian;
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

function render({ desktop = false, onTray = () => undefined, ...props }: { desktop?: boolean; onTray?: () => void; needsYouCount?: number } = {}) {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<TrayGlyph size={22} onPress={onTray} testID={desktop ? 'desktop-tray' : 'workspace-tray'} {...props} />); });
  return tree;
}

function badge(tree: ReactTestRenderer): string | null {
  const found = tree.root.findAllByProps({ testID: 'tray-needs-you-count' });
  if (!found.length) return null;
  return found[0]!.findByType('Text' as never).props.children;
}

describe('TrayGlyph primary-row action', () => {
  it('carries no badge while nothing needs the viewer', () => {
    const tree = render({ needsYouCount: 0 });
    expect(badge(tree)).toBeNull();
    expect(tree.root.findByType('Button' as never).props.accessibilityLabel).toBe(
      'Tray',
    );
  });

  it('counts what needs the viewer, compacting past nine', () => {
    expect(badge(render({ needsYouCount: 5 }))).toBe('5');
    const busy = render({ needsYouCount: 12 });
    expect(badge(busy)).toBe('9+');
    expect(busy.root.findByType('Button' as never).props.accessibilityLabel).toBe(
      'Tray, 12 need you',
    );
  });

  it('opens the tray on press, under its desktop id on a desktop', () => {
    const onTray = vi.fn();
    const tree = render({ desktop: true, onTray });
    act(() => tree.root.findByProps({ testID: 'desktop-tray' }).props.onPress());
    expect(onTray).toHaveBeenCalledTimes(1);
  });
});

const NEEDS_COUNT_SIZE = 17;

describe.each(['obsidian', 'bone'] as const)('Room list header colour in %s', (name) => {
  const hull = beelineThemes[name];
  beforeAll(() => { activeTheme.buzz = hull; });
  afterAll(() => { activeTheme.buzz = beelineThemes.obsidian; });

  // The Room list header passes its one quiet icon colour to every glyph.
  function header(needsYouCount: number) {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(
        <>
          <MembersAgentsGlyph size={22} color={hull.ledgerQuiet} />
          <TrayGlyph size={22} color={hull.ledgerQuiet} cutColor={hull.bgBase} onPress={() => undefined}
            testID="workspace-tray" needsYouCount={needsYouCount} />
          <RoomListToolbar filter="all" onFilter={() => undefined} query="" onQuery={() => undefined} />
          <RoomListSectionHeader title="Rooms" inset="roomList" actionTestID="new-room"
            actionAccessibilityLabel="Create a new Room" onAction={() => undefined} />
        </>,
      );
    });
    return tree;
  }
  const addGlyph = (tree: ReactTestRenderer) =>
    tree.root.findByProps({ testID: 'new-room' }).findByType('Svg' as never);
  // Every ink colour the header glyphs draw; black, white and none only shape the mask.
  const strokes = (tree: ReactTestRenderer) =>
    tree.root.findAllByType('Svg' as never)
      .filter((node: any) => node !== addGlyph(tree))
      .flatMap((node: any) => [node.props.stroke, node.props.fill])
      .filter((ink: any) => ink && !['none', 'black', 'white'].includes(ink));

  it('draws the agents, tray and search icons in the same quiet grey with an empty tray', () => {
    const tree = header(0);
    const search = tree.root.findByType('Ionicons' as never);
    expect(search.props.color).toBe(hull.ledgerQuiet);
    expect(new Set(strokes(tree))).toEqual(new Set([hull.ledgerQuiet]));
    expect(tree.root.findAllByProps({ testID: 'tray-needs-you-count' })).toHaveLength(0);
  });

  it('draws the section + in brass beside the grey header icons', () => {
    const tree = header(0);
    expect(addGlyph(tree).props.stroke).toBe(hull.accent);
    expect(hull.accent).not.toBe(hull.ledgerQuiet);
  });

  it('keeps the tray grey and puts brass only on its count when items wait', () => {
    const tree = header(1);
    expect(new Set(strokes(tree))).toEqual(new Set([hull.ledgerQuiet]));
    const circle = Object.assign({}, ...[tree.root.findByProps({ testID: 'tray-needs-you-count' }).props.style].flat());
    expect(circle.backgroundColor).toBe(hull.accent);
    expect(circle.height).toBe(NEEDS_COUNT_SIZE);
  });

  // The Android screenshot showed this style centres the digit within 1 px.
  // A line box equal to the circle with font padding off moved it about 1 dp low.
  it('keeps the count text style that centres the digit on device', () => {
    const tree = header(1);
    const count = tree.root.findByProps({ testID: 'tray-needs-you-count' });
    const circle = Object.assign({}, ...[count.props.style].flat());
    expect(circle).toMatchObject({ alignItems: 'center', justifyContent: 'center' });
    const text = Object.assign({}, ...[count.findByType('Text' as never).props.style].flat());
    expect(text).toEqual({
      ...hull.type.sectionHead,
      letterSpacing: 0,
      color: hull.textInverted,
      fontVariant: ['tabular-nums'],
    });
    expect(text).not.toHaveProperty('includeFontPadding');
    expect(text).not.toHaveProperty('textAlignVertical');
  });
});
