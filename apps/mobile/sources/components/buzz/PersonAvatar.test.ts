import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return {
    Image: host('Image'),
    StyleSheet: { create: (styles: unknown) => styles },
    View: host('View'),
  };
});

vi.mock('react-native-svg', async () => {
  const ReactModule = await import('react');
  const host = (name: string) => (props: any) =>
    ReactModule.createElement(name, props, props.children);
  return { default: host('Svg'), G: host('G'), Polygon: host('Polygon') };
});

import { PersonAvatar } from './PersonAvatar';

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

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('Person avatar', () => {
  const pubkey = '3333333333333333333333333333333333333333333333333333333333333333';

  it('renders the faceted mark, not the image, when a kind:0 picture is assigned', () => {
    const renderer = render(
      React.createElement(PersonAvatar, {
        pubkey,
        avatarUrl: 'https://example.test/person.png',
        name: 'Person',
      }),
    );

    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
  });

  it('renders a faceted mark with no Circle/Ellipse elements when no picture is assigned', () => {
    const renderer = render(React.createElement(PersonAvatar, { pubkey, name: 'Person' }));
    expect(renderer.root.findAllByType('Image' as any)).toHaveLength(0);
    expect(renderer.root.findAllByType('Polygon' as any).length).toBeGreaterThan(0);
  });

  /**
   * Regression guard for the enter-room/live-update freeze: PersonAvatar
   * renders once per transcript row inside FlatList's renderItem, which the
   * chat screen recreates on every presence tick. Without memoization every
   * visible row's SVG mark was rebuilt on updates unrelated to that row's
   * own identity. A `React.memo`-wrapped component exposes the wrapped
   * function as `.type`; replacing it with a spy directly counts actual
   * invocations (unlike `React.Profiler.onRender`, which fires on every
   * commit that reaches this position regardless of a memo bailout).
   */
  it('does not re-render when its own props are unchanged', () => {
    const original = (PersonAvatar as unknown as { type: typeof PersonAvatar }).type;
    const spy = vi.fn(original);
    (PersonAvatar as unknown as { type: typeof PersonAvatar }).type = spy as any;
    try {
      function Parent({ tick }: { tick: number }) {
        void tick;
        return React.createElement(PersonAvatar, { pubkey, name: 'Person' });
      }

      let renderer!: ReactTestRenderer;
      act(() => {
        renderer = create(React.createElement(Parent, { tick: 0 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);

      act(() => {
        renderer.update(React.createElement(Parent, { tick: 1 }));
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      (PersonAvatar as unknown as { type: typeof PersonAvatar }).type = original;
    }
  });
});
