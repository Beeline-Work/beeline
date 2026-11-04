import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const R = await import('react');
  const host = (name: string) => (props: any) => R.createElement(name, props, props.children);
  return {
    Image: host('Image'), Text: host('Text'), View: host('View'),
    Pressable: host('Pressable'), ScrollView: host('ScrollView'),
    Keyboard: { addListener: () => ({ remove: () => undefined }) },
    useWindowDimensions: () => ({ width: 1280, height: 840 }),
  };
});
vi.mock('react-native-unistyles', async () => {
  const { beelineThemes } = await import('@/buzz/groknight');
  return {
    StyleSheet: {
      create: (factory: any) => typeof factory === 'function' ? factory({ buzz: beelineThemes.obsidian }) : factory,
      hairlineWidth: 1,
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useIsDesktop: () => false }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('./Button', async () => {
  const R = await import('react');
  return { Button: (props: any) => R.createElement('Button', props, props.icon, props.label) };
});
vi.mock('./IndexRow', async () => {
  const R = await import('react');
  return { InlineRow: (props: any) => R.createElement('InlineRow', props, props.children) };
});
vi.mock('./HullDialog', async () => {
  const R = await import('react');
  return { HullFloatingSurface: (props: any) => R.createElement('HullFloatingSurface', props, props.children) };
});

import { ExistingAgentJoin } from './ExistingAgentJoin';
import { HullActionSheet } from './HullActionSheet';

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const original = console.error;
  vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
    original(message, ...args);
  });
});
afterAll(() => vi.restoreAllMocks());

// Regression: desktop audit — Add-agent reset Codex to Grok Bot on window resize.
// Found by $qa on 2026-11-04.
// Report: apps/mobile/evidence/desktop-surface-audit/README.md
describe('HullActionSheet child state across desktop layout changes', () => {
  for (const scrollBody of [true, false]) {
    it(`retains the selected provider across both breakpoints (scrollBody=${scrollBody})`, () => {
      const surface = (desktop: boolean) => (
        <HullActionSheet desktop={desktop} scrollBody={scrollBody}>
          <ExistingAgentJoin pairCommand="npx usebeeline connect PROOF" />
        </HullActionSheet>
      );
      let renderer: any;
      act(() => { renderer = create(surface(false)); });
      act(() => renderer.root.findByProps({ testID: 'existing-agent-codex' }).props.onPress());
      const selected = () => renderer.root.findByProps({ testID: 'existing-agent-codex' }).props.accessibilityState.selected;
      expect(selected()).toBe(true);
      for (const desktop of [true, false, true]) {
        act(() => renderer.update(surface(desktop)));
        expect(selected()).toBe(true);
        expect(renderer.root.findAllByProps({ accessibilityLabel: 'Copy Codex join line' }).length).toBeGreaterThan(0);
      }
      act(() => renderer.unmount());
    });
  }
});
