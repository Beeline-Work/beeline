import * as React from 'react';
import { readFileSync } from 'node:fs';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * RN Keyboard.addListener is a prototype method that reads `this._emitter`.
 * Extracting it (`const addListener = Keyboard.addListener`) and calling it
 * unbound makes `this` the global object in Hermes sloppy mode, so
 * `this._emitter` is undefined and the throw is exactly the store crash:
 * `Cannot read property addListener of undefined`.
 */
const keyboard = vi.hoisted(() => {
  const emitter = {
    addListener: vi.fn((_event: string, _listener: (...args: unknown[]) => void) => ({
      remove: () => undefined,
    })),
  };
  const Keyboard = {
    _emitter: emitter,
    addListener(event: string, listener: (...args: unknown[]) => void) {
      const target = this == null ? undefined : this._emitter;
      // Deliberately unbound mock: `target` is undefined when `this` is lost,
      // matching the store crash. The assertion is for TYPECHECK only.
      return target!.addListener(event, listener);
    },
  };
  return { emitter, Keyboard };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Keyboard: keyboard.Keyboard,
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Switch: host('Switch'),
    Text: host('Text'),
    View: host('View'),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});

const theme = vi.hoisted(() => ({
  hull: {
    accent: '#b08a4a',
    bgPressed: '#2a1b31',
    bgRaised: '#1d1024',
    border: '#39273f',
    chrome: '#f1edf2',
    dialogDanger: '#c4544d',
    proseRegular: 'GrokRegular',
    proseSemibold: 'GrokSemibold',
    radius: 3,
    space: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48 },
    textDisabled: '#75687a',
    textMuted: '#83838d',
    textPrimary: '#f1edf2',
    textSecondary: '#aaa0ae',
    type: {
      body: { fontFamily: 'GrokRegular', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      bodyStrong: { fontFamily: 'GrokSemibold', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      hero: { fontFamily: 'GrokMedium', fontSize: 22, lineHeight: 32, letterSpacing: -0.3 },
      meta: { fontFamily: 'GrokRegular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
    },
  },
}));

vi.mock('react-native-unistyles', () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === 'function'
        ? (factory as (theme: any) => unknown)({ buzz: theme.hull })
        : factory,
    hairlineWidth: 1,
  },
  useUnistyles: () => ({ theme: { buzz: theme.hull } }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
}));

vi.mock('@/constants/Typography', () => ({
  Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./HullDialog', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { HullFloatingSurface: host('HullFloatingSurface'), HullModal: host('HullModal') };
});

import { HullActionSheet, HullActionSheetRow } from './HullActionSheet';

const source = readFileSync(new URL('./HullActionSheet.tsx', import.meta.url), 'utf8');
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

describe('HullActionSheet keyboard height subscription', () => {
  it('keeps Keyboard.addListener bound so opening a sheet cannot throw addListener of undefined', () => {
    expect(() => {
      act(() => {
        create(
          <HullActionSheet testID="sheet" title="New">
            <HullActionSheetRow label="Message" onPress={() => undefined} />
          </HullActionSheet>,
        );
      });
    }).not.toThrow();
    expect(keyboard.emitter.addListener).toHaveBeenCalledWith('keyboardDidShow', expect.any(Function));
    expect(keyboard.emitter.addListener).toHaveBeenCalledWith('keyboardDidHide', expect.any(Function));
    expect(source).toContain("Keyboard.addListener('keyboardDidShow'");
    expect(source).toContain("Keyboard.addListener('keyboardDidHide'");
    expect(source).not.toMatch(/const addListener = Keyboard\?\.addListener/);
  });
});
