import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    TextInput: host('TextInput'),
    View: host('View'),
  };
});
vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: any) =>
      factory({
        buzz: {
          accent: '#b08a4a',
          bgBase: '#14091a',
          border: '#333',
          ledgerQuiet: '#90909b',
          textPrimary: '#f0f0f3',
          textInverted: '#111111',
          space: { sm: 8, md: 16 },
          type: { meta: {}, body: {}, sectionHead: {} },
        },
      }),
  },
}));
vi.mock('@expo/vector-icons', async () => {
  const ReactModule = await import('react');
  return { Ionicons: (props: any) => ReactModule.createElement('Ionicons', props) };
});
vi.mock('./TrayGlyph', async () => {
  const ReactModule = await import('react');
  return { TrayGlyph: (props: any) => ReactModule.createElement('TrayGlyph', props) };
});

import { RoomListToolbar } from './RoomListToolbar';

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

function render(props: Partial<React.ComponentProps<typeof RoomListToolbar>> = {}) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <RoomListToolbar
        filter="all"
        onFilter={() => undefined}
        query=""
        onQuery={() => undefined}
        onTray={() => undefined}
        {...props}
      />,
    );
  });
  return tree;
}

function badge(tree: ReactTestRenderer): string | null {
  const found = tree.root.findAllByProps({ testID: 'tray-needs-you-count' });
  if (!found.length) return null;
  return found[0]!.findByType('Text' as never).props.children;
}

describe('RoomListToolbar tray action', () => {
  it('carries no badge while nothing needs the viewer', () => {
    const tree = render({ needsYouCount: 0 });
    expect(badge(tree)).toBeNull();
    expect(tree.root.findByProps({ testID: 'workspace-tray' }).props.accessibilityLabel).toBe(
      'Tray',
    );
  });

  it('counts what needs the viewer, compacting past nine', () => {
    expect(badge(render({ needsYouCount: 5 }))).toBe('5');
    const busy = render({ needsYouCount: 12 });
    expect(badge(busy)).toBe('9+');
    expect(busy.root.findByProps({ testID: 'workspace-tray' }).props.accessibilityLabel).toBe(
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
