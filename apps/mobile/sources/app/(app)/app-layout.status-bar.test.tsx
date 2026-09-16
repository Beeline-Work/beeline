import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { boneTheme, obsidianTheme } from '@/theme';
import { statusBarStyleForTheme } from '@/components/StatusBarProvider';

const themeRef: { current: typeof boneTheme | null } = { current: null };
const stackRef: {
  current: { props: { screenOptions?: Record<string, unknown> } } | null;
} = { current: null };
const screenPropsRef: { current: Array<{ options?: Record<string, unknown> }> } = {
  current: [],
};

vi.mock('react-native-unistyles', () => ({
  useUnistyles: () => ({ theme: themeRef.current }),
}));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  return {
    View: (props: any) => ReactModule.createElement('View', props, props.children),
    Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
  };
});

vi.mock('expo-router', async () => {
  const ReactModule = await import('react');
  return {
    Stack: Object.assign(
      (props: any) => {
        stackRef.current = { props };
        return ReactModule.createElement('Stack', props, props.children);
      },
      {
        Screen: (props: any) => {
          screenPropsRef.current.push(props);
          return ReactModule.createElement('Stack.Screen', props);
        },
      },
    ),
  };
});

vi.mock('@/components/navigation/Header', () => ({ createHeader: () => null }));
vi.mock('@/utils/platform', () => ({ isRunningOnMac: () => false }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import RootLayout from './_layout';

function renderLayout(themeName: 'bone' | 'obsidian'): void {
  themeRef.current = themeName === 'bone' ? boneTheme : obsidianTheme;
  stackRef.current = null;
  screenPropsRef.current = [];
  act(() => {
    create(<RootLayout />);
  });
}

describe('(app) RootLayout status bar glyphs', () => {
  it('asks for dark icons in light mode', () => {
    renderLayout('bone');
    // Rendered props, not source text: what the native stack will apply.
    expect(stackRef.current?.props.screenOptions?.statusBarStyle).toBe('dark');
  });

  it('asks for light icons in dark mode', () => {
    renderLayout('obsidian');
    expect(stackRef.current?.props.screenOptions?.statusBarStyle).toBe('light');
  });

  it('lets the theme be the one author: no screen pins a glyph color', () => {
    renderLayout('bone');
    // A per-screen statusBarStyle reintroduces white glyphs over Bone.
    expect(screenPropsRef.current.length).toBeGreaterThan(0);
    for (const screen of screenPropsRef.current) {
      expect(screen.options?.statusBarStyle).toBeUndefined();
    }
  });
});

describe('statusBarStyleForTheme', () => {
  it('maps the theme flag to the expo-status-bar style', () => {
    expect(statusBarStyleForTheme({ dark: false })).toBe('dark');
    expect(statusBarStyleForTheme({ dark: true })).toBe('light');
  });
});
