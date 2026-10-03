import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const safeArea = vi.hoisted(() => ({ bottom: 0 }));

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: Record<string, unknown>) =>
    ReactModule.createElement(name, props, props.children as React.ReactNode);
  return {
    Pressable: host('Pressable'),
    ScrollView: host('ScrollView'),
    Text: host('Text'),
    View: host('View'),
  };
});
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: safeArea.bottom, left: 0 }),
}));

import { CornerAppScreen } from './CornerAppScreen';

describe('CornerAppScreen', () => {
  it('lets its last block scroll clear of the system navigation bar', () => {
    safeArea.bottom = 48;
    try {
      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(<CornerAppScreen onBack={() => undefined} />);
      });
      const scroll = renderer.root.findByProps({ testID: 'corner-app-scroll' });
      const contentStyle = Object.assign({}, ...[scroll.props.contentContainerStyle].flat(Infinity as 1));
      expect(contentStyle.paddingBottom).toBe(48 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });
});
