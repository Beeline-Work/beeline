import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native-unistyles', () => {
  const buzz = {
    textPrimary: '#fff',
    textMuted: '#888',
    ledgerQuiet: '#777',
    border: '#333',
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    type: {
      hero: { fontFamily: 'SpaceGrotesk-Medium', fontSize: 22, lineHeight: 32, letterSpacing: -0.3 },
      bodyStrong: { fontFamily: 'SpaceGrotesk-SemiBold', fontSize: 16, lineHeight: 23, letterSpacing: 0 },
      meta: { fontFamily: 'SpaceGrotesk-Regular', fontSize: 13, lineHeight: 19, letterSpacing: 0 },
    },
  };
  return {
    StyleSheet: {
      // Evaluated per access so each test sees the Platform.OS it set.
      create: (styles: (theme: { buzz: typeof buzz }) => unknown) =>
        new Proxy({}, { get: (_target, key) => (styles({ buzz }) as Record<string | symbol, unknown>)[key] }),
      hairlineWidth: 1,
    },
  };
});

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
  return {
    Platform: platform,
    Text: host('Text'),
    TouchableOpacity: host('TouchableOpacity'),
    View: host('View'),
  };
});

vi.mock('./ChevronGlyph', () => ({ CHEVRON_BACK_SIZE: 20, ChevronGlyph: () => null }));

import { PageHeader } from './PageHeader';

function heroTitleStyle() {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<PageHeader prominent title="Settings" titleTestID="title" />);
  });
  const title = tree.root.findByProps({ testID: 'title' });
  return Object.assign({}, ...[title.props.style].flat(Infinity).filter(Boolean));
}

describe('PageHeader prominent title', () => {
  beforeEach(() => {
    platform.OS = 'ios';
  });

  it('on iOS, keeps trailing room for the negative letter spacing so the last glyph is not clipped', () => {
    const style = heroTitleStyle();
    expect(style.letterSpacing).toBe(-0.3);
    expect(style.paddingRight).toBe(0.3);
  });

  it('on Android and web, draws the title exactly as the hero role', () => {
    for (const os of ['android', 'web']) {
      platform.OS = os;
      const style = heroTitleStyle();
      expect(style.paddingRight).toBeUndefined();
      expect(style.fontSize).toBe(22);
      expect(style.letterSpacing).toBe(-0.3);
    }
  });
});
