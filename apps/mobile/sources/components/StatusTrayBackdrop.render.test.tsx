import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { boneTheme, obsidianTheme } from '@/theme';
import { StatusTrayBackdrop } from './StatusTrayBackdrop';

const themeRef: { current: typeof boneTheme | null } = { current: null };

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: themeRef.current }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: (props: any) => ReactModule.createElement('View', props, props.children),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
  };
});

function renderBackdrop(themeName: 'bone' | 'obsidian') {
  themeRef.current = themeName === 'bone' ? boneTheme : obsidianTheme;
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<StatusTrayBackdrop />);
  });
  return tree;
}

describe('StatusTrayBackdrop', () => {
  it('fills the tray inset with bgRaised in light mode', () => {
    const backdrop = renderBackdrop('bone').root.findByProps({ testID: 'status-tray-backdrop' });
    // Rendered props, not source text: the strip the system tray sits on.
    expect(backdrop.props.style.height).toBe(47);
    expect(backdrop.props.style.backgroundColor).toBe(boneTheme.buzz.bgRaised);
    // The bar only paints; taps pass through to the screen beneath.
    expect(backdrop.props.pointerEvents).toBe('none');
  });

  it('leaves the dark mode tray unfilled', () => {
    const backdrop = renderBackdrop('obsidian').root.findByProps({ testID: 'status-tray-backdrop' });
    expect(backdrop.props.style.backgroundColor).toBe('transparent');
  });
});
